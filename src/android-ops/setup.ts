/**
 * Android Social Ops — real setup plumbing.
 *
 * Everything an operator needs to go from an *empty* store to a working rack:
 * validating a hand-filled phone registration form, importing an account
 * roster, taking a census of what is still missing, and reporting whether the
 * surrounding infrastructure (adapters, tailnet, fly deployment config) is
 * actually configured.
 *
 * It lives outside `service.ts` for one reason: none of it needs a database or
 * a device, so it can be unit-tested directly.
 *
 * Compliance boundary (see `compliance.ts`): this module *validates* operator
 * input. It never fabricates identity material, and {@link assertNoSecretMaterial}
 * refuses any payload that tries to push a password, TOTP seed, session cookie
 * or recovery code into the database — those live in the vault, and only an
 * opaque `vault://` pointer is ever stored or returned.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveBin } from "../agents/coder-backend/bin-detect.js";
import type { PhoneDevice, Platform, SocialAccount } from "./types.js";

// ── Secret material guard ────────────────────────────────────────────────────

/**
 * Field names that carry a credential *value* rather than a reference. Any of
 * these appearing in an inbound payload is a caller bug worth failing loudly
 * over — silently dropping them would teach an operator that the field works.
 */
export const SECRET_FIELD_NAMES = [
  "password",
  "passwd",
  "pass",
  "passphrase",
  "pin",
  "totp",
  "totpSeed",
  "totpSecret",
  "otp",
  "otpSecret",
  "mfaSecret",
  "recoveryCodes",
  "backupCodes",
  "cookie",
  "cookies",
  "session",
  "sessionToken",
  "accessToken",
  "refreshToken",
  "apiKey",
  "secret",
  "credentials",
] as const;

export class SecretMaterialError extends Error {
  readonly fields: string[];
  constructor(fields: string[]) {
    super(
      `Credential values must never be sent to this API — remove ${fields.join(", ")} and pass a vault reference instead. ` +
        `Store the secret in the vault and supply secretRef: "vault://android-ops/<platform>/<handle>".`,
    );
    this.name = "SecretMaterialError";
    this.fields = fields;
  }
}

/** Throw if `payload` carries a credential value under any known name. */
export function assertNoSecretMaterial(payload: unknown): void {
  if (!payload || typeof payload !== "object") return;
  const present = Object.keys(payload as Record<string, unknown>).filter((key) =>
    (SECRET_FIELD_NAMES as readonly string[]).includes(key),
  );
  if (present.length) throw new SecretMaterialError(present);
}

/**
 * A `vault://` pointer, or a derived one. A caller that pastes the actual
 * secret into `secretRef` gets rejected rather than having it persisted.
 */
export function normalizeSecretRef(
  raw: string | undefined | null,
  platform: Platform,
  handle: string,
): string {
  const value = (raw ?? "").trim();
  if (!value) return `vault://android-ops/${platform}/${handle}`;
  if (!value.startsWith("vault://")) {
    throw new SecretMaterialError(["secretRef"]);
  }
  return value;
}

// ── Public (secret-free) account projection ──────────────────────────────────

/**
 * What the API hands back for an account. Identical to {@link SocialAccount}
 * except that the vault pointer is explicitly flagged rather than implied, so
 * a reader can see at a glance that no credential travelled with the row.
 */
export type PublicSocialAccount = SocialAccount & {
  /** True when a vault pointer is recorded. The credential itself is not here. */
  secretRefPresent: boolean;
  /** Scheme of the pointer (always `vault` for a valid record). */
  secretRefScheme: string | null;
};

export function toPublicAccount(account: SocialAccount): PublicSocialAccount {
  const ref = account.secretRef ?? "";
  const scheme = /^([a-z0-9+.-]+):\/\//i.exec(ref)?.[1] ?? null;
  // Defence in depth: strip anything secret-shaped that reached the row.
  const safe = { ...account } as Record<string, unknown>;
  for (const key of SECRET_FIELD_NAMES) {
    if (key === "secret") continue; // `secretRef` is a pointer, not a value.
    delete safe[key];
  }
  return {
    ...(safe as unknown as SocialAccount),
    secretRefPresent: Boolean(ref),
    secretRefScheme: scheme,
  };
}

// ── Device registration ──────────────────────────────────────────────────────

export interface DeviceRegistrationInput {
  /** Optional stable id; generated from the slot when omitted. */
  id?: string;
  label?: string;
  /** Physical rack slot. Auto-assigned to the next free slot when omitted. */
  slot?: number;
  model?: string;
  androidVersion?: string;
  /** ADB serial, or a `host:port` / `100.x.y.z:5555` tailnet endpoint. */
  serial: string;
  /**
   * Stable per-install identity (`Settings.Secure.ANDROID_ID`). When present it
   * is the key registration matches on, so a handset that re-pairs under a new
   * serial updates its existing row instead of spawning a duplicate. May also be
   * carried in {@link notes} as `androidId=<hex>` (the companion-APK path), which
   * {@link normalizeDeviceRegistration} recovers automatically.
   */
  androidId?: string | null;
  tailscaleIp?: string | null;
  isSpare?: boolean;
  notes?: string | null;
  updateChannel?: PhoneDevice["updateChannel"];
  storageTotalMb?: number;
  appVersion?: string | null;
}

/** Serials are argv for adb — keep them to characters that cannot be argv tricks. */
const SERIAL_RE = /^[A-Za-z0-9._:-]{3,64}$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isIpv4(value: string): boolean {
  const m = IPV4_RE.exec(value.trim());
  if (!m) return false;
  return m.slice(1).every((part) => Number(part) >= 0 && Number(part) <= 255);
}

/** Pull an IPv4 out of a `host:port` serial, when there is one. */
export function ipFromSerial(serial: string): string | null {
  const host = serial.includes(":") ? serial.slice(0, serial.lastIndexOf(":")) : serial;
  return isIpv4(host) ? host : null;
}

export function nextFreeSlot(existing: PhoneDevice[]): number {
  const taken = new Set(existing.map((d) => d.slot));
  let slot = 1;
  while (taken.has(slot)) slot++;
  return slot;
}

// ── Stable device identity ────────────────────────────────────────────────────
//
// A wireless-debugging serial is `host:port` with a port that changes on every
// re-pair, so it cannot be the identity two rows are deduplicated on. The stable
// key is the Android `ANDROID_ID`; when that is unknown we fall back to the
// tailnet IP plus the model, which is stable for a rack of fixed handsets.

const ANDROID_ID_RE = /^[0-9a-f]{8,20}$/i;

/** A valid, lower-cased ANDROID_ID, or null. */
export function normalizeAndroidId(raw: string | null | undefined): string | null {
  const value = (raw ?? "").toString().trim().toLowerCase();
  return ANDROID_ID_RE.test(value) ? value : null;
}

/** Recover an `androidId=<hex>` marker the companion-APK path leaves in notes. */
export function androidIdFromNotes(notes: string | null | undefined): string | null {
  const m = /androidid\s*=\s*([0-9a-f]{8,20})/i.exec(notes ?? "");
  return m ? m[1].toLowerCase() : null;
}

/** Normalise a model string so "vivo 1901" and "vivo_1901" compare equal. */
export function normalizeModel(model: string | null | undefined): string | null {
  const flat = model
    ?.trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .trim();
  if (!flat) return null;
  // adb reports "vivo_1901" while the companion APK registers the manufacturer
  // twice as "vivo vivo 1901". Both name one phone, and treating them as two
  // models let a fleet-refresh adoption spawn a duplicate row, so collapse
  // consecutive repeats of the same word before comparing.
  const words: string[] = [];
  for (const word of flat.split(" ")) {
    if (word && words[words.length - 1] !== word) words.push(word);
  }
  return words.join("_") || null;
}

/** The fields any stable-identity comparison needs, from a row or a probe. */
export interface DeviceIdentityInput {
  androidId?: string | null;
  serial?: string | null;
  tailscaleIp?: string | null;
  model?: string | null;
}

/** Tailscale hands out 100.64.0.0/10 (CGNAT), one address per node identity. */
function isTailnetIp(ip: string): boolean {
  const parts = ip.split(".").map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
    return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function identityIp(d: DeviceIdentityInput): string | null {
  const ip = (d.tailscaleIp ?? "").toString().trim();
  if (isIpv4(ip)) return ip;
  return d.serial ? ipFromSerial(d.serial) : null;
}

/**
 * Whether two handsets are the same physical phone.
 *
 * ANDROID_ID agreement proves sameness. Its DISagreement proves nothing: the
 * value is derived per app-signing-key, so re-signing or reinstalling the
 * companion APK mints a fresh id for the same handset. One vivo was recorded
 * twice exactly that way (ffa6d801... and 1d15c8a9...), and the earlier rule —
 * "two different ids are two different phones" — made that duplicate
 * unmergeable, because the matcher never reached the IP fallback.
 *
 * So a mismatch now falls through to IP + model, but ONLY for a tailnet address
 * (100.64.0.0/10). A tailnet IP is bound to a node identity, so a collision
 * really is one device; a LAN address is handed out by DHCP and can be recycled
 * between phones, where merging on it would fuse two unrelated handsets.
 */
/**
 * Do two model strings describe one phone? They come from two sources that do
 * not agree: adb reports the MODEL alone ("S1"), while the companion APK reports
 * MANUFACTURER + MODEL ("true S1"). Exact comparison therefore split one handset
 * into two rows — a fleet refresh adopted the live endpoint as "Phone 03" and
 * left the real row stale. One being a suffix of the other is enough, since this
 * only ever runs after the addresses have already matched.
 */
function modelsCompatible(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(`_${b}`) || b.endsWith(`_${a}`);
}

export function sameStableIdentity(a: DeviceIdentityInput, b: DeviceIdentityInput): boolean {
  const aId = normalizeAndroidId(a.androidId);
  const bId = normalizeAndroidId(b.androidId);
  if (aId && bId && aId === bId) return true;
  const aIp = identityIp(a);
  const bIp = identityIp(b);
  const aModel = normalizeModel(a.model);
  const bModel = normalizeModel(b.model);
  if (!aIp || !bIp || aIp !== bIp) return false;
  if (!modelsCompatible(aModel, bModel)) return false;
  // Same model at the same address. A tailnet address IS a node identity, so it
  // is trustworthy enough to overrule two differing ANDROID_IDs (which rotate
  // when the companion APK is re-signed). A LAN address is DHCP-assigned and
  // recyclable between phones, so there the ids win.
  if (aId && bId) return isTailnetIp(aIp);
  return true;
}

/** The first existing device that is the same physical handset as `input`. */
export function matchDeviceByIdentity(
  input: DeviceIdentityInput,
  existing: PhoneDevice[],
): PhoneDevice | null {
  const withNoteId: DeviceIdentityInput = {
    ...input,
    androidId:
      normalizeAndroidId(input.androidId) ??
      androidIdFromNotes((input as { notes?: string | null }).notes),
  };
  return existing.find((d) => sameStableIdentity(withNoteId, d)) ?? null;
}

/**
 * Turn hand-entered form data into a persistable device row, refusing the two
 * mistakes that quietly corrupt a rack: a duplicate serial (two rows fighting
 * over one handset) and a duplicate slot (ambiguous live-grid ordering).
 */
export function normalizeDeviceRegistration(
  input: DeviceRegistrationInput,
  ctx: { existing: PhoneDevice[]; now?: number },
): PhoneDevice {
  assertNoSecretMaterial(input);
  const now = ctx.now ?? Date.now();
  const serial = (input.serial ?? "").trim();
  if (!serial) throw new Error("A device serial is required — run `adb devices` to find it.");
  if (!SERIAL_RE.test(serial)) {
    throw new Error(
      `"${serial}" is not a usable adb serial. Expected a device serial or a host:port endpoint.`,
    );
  }

  const id = (input.id ?? "").trim() || null;
  const clash = ctx.existing.find((d) => d.serial === serial && d.id !== id);
  if (clash) {
    throw new Error(`Serial ${serial} is already registered as ${clash.label} (${clash.id}).`);
  }

  const slot =
    input.slot ?? ctx.existing.find((d) => d.id === id)?.slot ?? nextFreeSlot(ctx.existing);
  if (!Number.isInteger(slot) || slot < 1) throw new Error("Rack slot must be a positive integer.");
  const slotClash = ctx.existing.find((d) => d.slot === slot && d.id !== id);
  if (slotClash) {
    throw new Error(`Slot ${slot} is already held by ${slotClash.label} (${slotClash.id}).`);
  }

  const previous = id ? (ctx.existing.find((d) => d.id === id) ?? null) : null;
  // ANDROID_ID is the stable identity. Accept it explicitly, recover it from an
  // `androidId=` note (the companion-APK path), and never lose one already on the
  // row — a re-registration under a new serial must keep the phone's identity.
  const androidId =
    normalizeAndroidId(input.androidId) ??
    androidIdFromNotes(input.notes) ??
    previous?.androidId ??
    null;
  const label =
    (input.label ?? "").trim() || previous?.label || `Phone ${String(slot).padStart(2, "0")}`;
  const tailscaleIp = (input.tailscaleIp ?? "").toString().trim() || ipFromSerial(serial);
  if (tailscaleIp && !isIpv4(tailscaleIp)) {
    throw new Error(`"${tailscaleIp}" is not a valid IPv4 address.`);
  }

  return {
    id: id ?? `dev-${String(slot).padStart(2, "0")}`,
    label,
    slot,
    model: (input.model ?? "").trim() || previous?.model || "unknown",
    androidVersion: (input.androidVersion ?? "").trim() || previous?.androidVersion || "unknown",
    serial,
    androidId,
    // Registration records intent; only an adapter probe may claim a handset is
    // online, so a freshly registered device starts unverified.
    // Re-registering the SAME handset at the SAME serial (the companion APK
    // re-enrolls on every launch) must not knock a connected phone offline:
    // keep the last probed state; presence/fleet refresh corrects it anyway.
    status: input.isSpare
      ? "spare"
      : previous && previous.serial === serial && previous.status !== "spare"
        ? previous.status
        : "offline",
    batteryPct: previous?.batteryPct ?? 0,
    charging: previous?.charging ?? false,
    storageFreeMb: previous?.storageFreeMb ?? 0,
    storageTotalMb: input.storageTotalMb ?? previous?.storageTotalMb ?? 0,
    wifiSsid: previous?.wifiSsid ?? null,
    wifiSignalDbm: previous?.wifiSignalDbm ?? null,
    tailscaleIp: tailscaleIp ?? null,
    tailscaleUp: previous?.tailscaleUp ?? false,
    adbState: previous && previous.serial === serial ? previous.adbState : "absent",
    scrcpyState: "unavailable",
    lastHeartbeatAt: previous?.lastHeartbeatAt ?? null,
    isSpare: input.isSpare ?? previous?.isSpare ?? false,
    appVersion: input.appVersion ?? previous?.appVersion ?? null,
    updateChannel: input.updateChannel ?? previous?.updateChannel ?? "stable",
    notes: input.notes ?? previous?.notes ?? null,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

// ── Account import ───────────────────────────────────────────────────────────

const PLATFORMS: Platform[] = ["instagram", "tiktok", "youtube", "facebook", "threads", "x"];
const HANDLE_RE = /^[A-Za-z0-9._-]{1,64}$/;

export interface AccountImportEntry {
  handle: string;
  platform: string;
  displayName?: string;
  /** Device id, or `auto` to let the assignment policy choose. */
  deviceId?: string | null;
  lifecycle?: SocialAccount["lifecycle"];
  sessionHealth?: SocialAccount["sessionHealth"];
  twoFactorEnabled?: boolean;
  twoFactorMethod?: SocialAccount["twoFactorMethod"];
  recoveryEmail?: string;
  recoveryCodesVaulted?: boolean;
  /** Opaque `vault://` pointer. A literal credential here is rejected. */
  secretRef?: string;
  recoveryNotes?: string | null;
}

export interface NormalizedAccountImport {
  account: Omit<SocialAccount, "createdAt" | "updatedAt">;
  /** True when the entry asked for automatic handset assignment. */
  autoAssign: boolean;
}

/**
 * Validate one roster row. The recovery mailbox is mandatory because §5 of the
 * plan makes a *durable, owner-controlled* recovery path the thing that keeps
 * an account recoverable — an import without one produces an account nobody can
 * get back into.
 */
export function normalizeAccountImport(
  entry: AccountImportEntry,
  ctx: { existing?: SocialAccount | null; now?: number } = {},
): NormalizedAccountImport {
  assertNoSecretMaterial(entry);
  const handle = (entry.handle ?? "").trim().replace(/^@/, "");
  if (!handle) throw new Error("Each imported account needs a handle.");
  if (!HANDLE_RE.test(handle)) throw new Error(`"${handle}" is not a valid handle.`);

  const platform = (entry.platform ?? "").trim().toLowerCase() as Platform;
  if (!PLATFORMS.includes(platform)) {
    throw new Error(`Unknown platform "${entry.platform}" for @${handle}.`);
  }

  const recoveryEmail = (entry.recoveryEmail ?? ctx.existing?.recoveryEmail ?? "").trim();
  if (!recoveryEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recoveryEmail)) {
    throw new Error(
      `@${handle} needs a domain-controlled recovery mailbox — an account without one cannot be recovered.`,
    );
  }

  const requestedDevice = (entry.deviceId ?? "").toString().trim();
  const autoAssign = requestedDevice === "auto";
  const now = ctx.now ?? Date.now();

  return {
    autoAssign,
    account: {
      id: ctx.existing?.id ?? `acct-${platform}-${handle}`.toLowerCase(),
      handle,
      platform,
      displayName: (entry.displayName ?? "").trim() || ctx.existing?.displayName || handle,
      deviceId: autoAssign ? null : requestedDevice || (ctx.existing?.deviceId ?? null),
      lifecycle: entry.lifecycle ?? ctx.existing?.lifecycle ?? "provisioning",
      sessionHealth: entry.sessionHealth ?? ctx.existing?.sessionHealth ?? "unknown",
      twoFactorEnabled: entry.twoFactorEnabled ?? ctx.existing?.twoFactorEnabled ?? false,
      twoFactorMethod: entry.twoFactorMethod ?? ctx.existing?.twoFactorMethod ?? "none",
      recoveryEmail,
      recoveryCodesVaulted:
        entry.recoveryCodesVaulted ?? ctx.existing?.recoveryCodesVaulted ?? false,
      secretRef: normalizeSecretRef(entry.secretRef ?? ctx.existing?.secretRef, platform, handle),
      lastPostAt: ctx.existing?.lastPostAt ?? null,
      recoveryNotes: entry.recoveryNotes ?? ctx.existing?.recoveryNotes ?? null,
      provisionedAt: ctx.existing?.provisionedAt ?? now,
      bio: null,
      avatarRef: null,
      signedUpAt: null,
      loggedInAt: null,
    },
  };
}

// ── Census / setup readiness ─────────────────────────────────────────────────

export interface StoreCensus {
  devices: number;
  accounts: number;
  media: number;
  jobs: number;
  provisioning: number;
  inbox: number;
  /** Nothing has been configured at all — a first-run install. */
  empty: boolean;
  needsDevices: boolean;
  needsAccounts: boolean;
  needsMedia: boolean;
  /**
   * Demo rows from `androidops.seed` are present. The dashboard says so out
   * loud, because a seeded rack must never be mistaken for a real one.
   */
  demoSeedPresent: boolean;
}

/** Demo data is deliberately self-identifying — see `seed.ts`. */
export function looksLikeDemoData(input: {
  accounts: Pick<SocialAccount, "handle" | "secretRef">[];
  devices: Pick<PhoneDevice, "notes">[];
}): boolean {
  return input.accounts.some(
    (a) => a.handle.startsWith("demo.") || (a.secretRef ?? "").includes("/demo/"),
  );
}

export interface FlyConfigPresence {
  /** A fly.toml was found *and* names an app. */
  configured: boolean;
  configPath: string | null;
  appName: string | null;
  primaryRegion: string | null;
  /** Whether a deploy token is exported. The value is never read or returned. */
  tokenPresent: boolean;
  cliPath: string | null;
  reason: string | null;
}

/** Minimal TOML probe — only the two keys the dashboard reports. */
function readFlyKey(source: string, key: string): string | null {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, "m").exec(source);
  return m ? m[1] : null;
}

/**
 * Whether this deployment has fly.io configuration on disk. Presence only —
 * no token value is read, logged or returned.
 */
export async function detectFlyConfig(searchDirs: string[]): Promise<FlyConfigPresence> {
  const tokenPresent = Boolean(
    process.env.FLY_API_TOKEN?.trim() || process.env.FLY_ACCESS_TOKEN?.trim(),
  );
  const cliPath = resolveBin("flyctl") ?? resolveBin("fly") ?? null;
  const candidates = [
    ...(process.env.ANDROID_OPS_FLY_CONFIG?.trim()
      ? [process.env.ANDROID_OPS_FLY_CONFIG.trim()]
      : []),
    ...searchDirs.flatMap((dir) => [join(dir, "fly.toml"), join(dir, "android-ops", "fly.toml")]),
  ];

  for (const path of candidates) {
    try {
      const source = await readFile(path, "utf8");
      const appName = readFlyKey(source, "app");
      return {
        configured: Boolean(appName),
        configPath: path,
        appName,
        primaryRegion: readFlyKey(source, "primary_region"),
        tokenPresent,
        cliPath,
        reason: appName ? null : `${path} does not name an app`,
      };
    } catch {
      /* try the next candidate */
    }
  }

  return {
    configured: false,
    configPath: null,
    appName: null,
    primaryRegion: null,
    tokenPresent,
    cliPath,
    reason:
      "no fly.toml found — the dashboard runs locally; add one (or set ANDROID_OPS_FLY_CONFIG) to deploy it",
  };
}

export interface SetupStep {
  key: string;
  title: string;
  detail: string;
  done: boolean;
  /** Blocking steps must be cleared before the pipeline can run for real. */
  blocking: boolean;
}

/**
 * The ordered checklist a standalone dashboard renders on an empty install.
 * Derived rather than stored, so it can never drift from the actual state.
 */
export function buildSetupSteps(input: {
  census: StoreCensus;
  deviceAdapterAvailable: boolean;
  streamAdapterAvailable: boolean;
  storageAvailable: boolean;
  tailscaleAvailable: boolean;
  assignedAccounts: number;
}): SetupStep[] {
  const c = input.census;
  return [
    {
      key: "adb",
      title: "Install ADB (platform-tools)",
      detail: input.deviceAdapterAvailable
        ? "adb is on PATH — handsets can be probed and driven."
        : "adb was not found. Without it the pipeline stays paused instead of failing jobs.",
      done: input.deviceAdapterAvailable,
      blocking: true,
    },
    {
      key: "devices",
      title: "Register the handsets",
      detail: c.devices
        ? `${c.devices} handset(s) registered.`
        : "No handsets yet — register each phone with its adb serial (androidops.device.register).",
      done: c.devices > 0,
      blocking: true,
    },
    {
      key: "accounts",
      title: "Import the account roster",
      detail: c.accounts
        ? `${c.accounts} account(s) on file.`
        : "No accounts yet — import them with a vault reference, never a password (androidops.accounts.import).",
      done: c.accounts > 0,
      blocking: true,
    },
    {
      key: "assignment",
      title: "Give every account a stable handset",
      detail: input.assignedAccounts
        ? `${input.assignedAccounts}/${c.accounts} accounts are assigned.`
        : "Accounts must be pinned to a handset before anything can be scheduled.",
      done: c.accounts > 0 && input.assignedAccounts === c.accounts,
      blocking: true,
    },
    {
      key: "media",
      title: "Add content to the library",
      detail: c.media
        ? `${c.media} asset(s) in the library.`
        : "Register at least one asset to schedule.",
      done: c.media > 0,
      blocking: false,
    },
    {
      key: "scrcpy",
      title: "Install scrcpy for remote control",
      detail: input.streamAdapterAvailable
        ? "scrcpy is available — a human can take over a handset to clear a checkpoint."
        : "scrcpy is missing. Human checkpoints then need physical access to the phone.",
      done: input.streamAdapterAvailable,
      blocking: false,
    },
    {
      key: "tailscale",
      title: "Bring up the management network",
      detail: input.tailscaleAvailable
        ? "Tailnet is up — handsets are reachable off the local network."
        : "Tailscale is not running; handsets must be on the local network instead.",
      done: input.tailscaleAvailable,
      blocking: false,
    },
    {
      key: "storage",
      title: "Configure the media store",
      detail: input.storageAvailable
        ? "Media storage is writable."
        : "Media storage is not writable — uploads will fail.",
      done: input.storageAvailable,
      blocking: false,
    },
    {
      key: "demo",
      title: "Clear the demo rack",
      detail: c.demoSeedPresent
        ? "Demo seed rows are present. Remove them before running against real accounts."
        : "No demo data present.",
      done: !c.demoSeedPresent,
      blocking: false,
    },
  ];
}

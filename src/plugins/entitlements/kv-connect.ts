/**
 * "Connect KinglyVault": link this install to a KinglyVault account with a
 * device code (RFC 8628 style), so owned plugins unlock without pasting a key.
 *
 *   1. start → KinglyVault `device-start` returns a short user code and the
 *      approval page (`/infinibot/connect?code=…`). The UI opens that page in
 *      the member's normal browser (Desktop: shell.openExternal via the
 *      window-open handler) and shows the same code.
 *   2. The gateway polls `device-poll` itself (no UI needed). Once the member
 *      approves, KinglyVault hands over a device link (refresh token) and a
 *      signed entitlement token, which go through importEntitlementToken() —
 *      the same verified path as a pasted token. From then on the normal
 *      refresh loop keeps them in sync.
 *
 * Works the same on Desktop, npm/web and cloud: only the gateway talks to
 * KinglyVault. The device code and tokens never leave this process / the 0600
 * entitlement file, and are never logged. Availability is probed at runtime
 * (`capabilities`), so the button stays off until KinglyVault ships the
 * endpoints.
 */
import { randomBytes } from "node:crypto";
import os from "node:os";
import { isFleetTenantMachine } from "../../saas/fleet-plugins.js";
import {
  entitlementsApiUrl,
  importEntitlementToken,
  kinglyVaultWebUrl,
  readEntitlementFile,
  type EntitlementSummary,
} from "./store.js";

export type KvCapabilities = {
  /** KinglyVault answers and supports the device flow. */
  available: boolean;
  /** Why not (plain words), when unavailable. */
  reason: string | null;
  checkedAt: string;
  webUrl: string;
};

export type KvConnectStatus = "pending" | "approved" | "denied" | "expired" | "error" | "cancelled";

/** What the UI may see (no device code, no tokens). */
export type KvConnectView = {
  id: string;
  status: KvConnectStatus;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: string;
  error: string | null;
  email: string | null;
  changed: string[];
  restart: unknown;
};

type Session = KvConnectView & {
  deviceCode: string;
  intervalMs: number;
  timer: ReturnType<typeof setTimeout> | null;
};

type FetchImpl = typeof fetch;

const AVAILABLE_TTL_MS = 10 * 60_000;
const UNAVAILABLE_TTL_MS = 60_000;
const MAX_SESSIONS = 4;

let capsCache: { at: number; api: string; caps: KvCapabilities } | null = null;
const sessions = new Map<string, Session>();

async function post(
  fetchImpl: FetchImpl,
  url: string,
  body: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed };
}

/** Is the device flow live on the KinglyVault this install talks to? Cached. */
export async function kvCapabilities(
  opts: {
    force?: boolean;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: FetchImpl;
    now?: () => number;
  } = {},
): Promise<KvCapabilities> {
  const env = opts.env ?? process.env;
  const now = (opts.now ?? Date.now)();
  const api = entitlementsApiUrl(readEntitlementFile(env), env);
  if (!opts.force && capsCache && capsCache.api === api) {
    const ttl = capsCache.caps.available ? AVAILABLE_TTL_MS : UNAVAILABLE_TTL_MS;
    if (now - capsCache.at < ttl) return capsCache.caps;
  }
  const base = { checkedAt: new Date(now).toISOString(), webUrl: kinglyVaultWebUrl(env) };
  let caps: KvCapabilities;
  try {
    const res = await post(opts.fetchImpl ?? fetch, api, { action: "capabilities" }, 6_000);
    caps =
      res.status === 200 && res.body.deviceConnect === true
        ? { ...base, available: true, reason: null }
        : {
            ...base,
            available: false,
            reason:
              res.status === 404
                ? "Connecting a KinglyVault account isn't switched on yet."
                : `KinglyVault answered ${res.status}.`,
          };
  } catch {
    caps = { ...base, available: false, reason: "KinglyVault can't be reached right now." };
  }
  capsCache = { at: now, api, caps };
  return caps;
}

/** What KinglyVault shows on the approval page ("InfiniBot on <host>"). */
export function deviceIdentity(
  env: NodeJS.ProcessEnv = process.env,
  versions: NodeJS.ProcessVersions = process.versions,
): { label: string; client: "desktop" | "cloud" | "web"; host: string } {
  const host = (env.INFINIBOT_DEVICE_NAME?.trim() || os.hostname() || "this computer").slice(
    0,
    120,
  );
  const client =
    typeof versions.electron === "string" ? "desktop" : isFleetTenantMachine(env) ? "cloud" : "web";
  const label =
    client === "desktop"
      ? `InfiniBot Desktop on ${host}`
      : client === "cloud"
        ? "InfiniBot Cloud"
        : `InfiniBot on ${host}`;
  return { label, client, host };
}

function view(s: Session): KvConnectView {
  const { deviceCode: _d, intervalMs: _i, timer: _t, ...rest } = s;
  return { ...rest, changed: [...rest.changed] };
}

function stop(s: Session, status: KvConnectStatus, error: string | null = null) {
  if (s.timer) clearTimeout(s.timer);
  s.timer = null;
  s.status = status;
  s.error = error;
}

function prune() {
  if (sessions.size < MAX_SESSIONS) return;
  const done = [...sessions.values()].filter((s) => s.status !== "pending");
  for (const s of done) sessions.delete(s.id);
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()][0];
    if (!oldest) break;
    stop(oldest, "cancelled");
    sessions.delete(oldest.id);
  }
}

export type ConnectHooks = {
  /** Called once with the import result (e.g. restart the gateway if needed). */
  onLinked?: (res: { changed: string[]; summary: EntitlementSummary }) => unknown;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  now?: () => number;
};

/** One poll of a pending session. Exported for tests (no timers). */
export async function pollKvConnectOnce(
  id: string,
  hooks: ConnectHooks = {},
): Promise<KvConnectView | null> {
  const s = sessions.get(id);
  if (!s) return null;
  if (s.status !== "pending") return view(s);
  const env = hooks.env ?? process.env;
  const now = (hooks.now ?? Date.now)();
  if (now >= Date.parse(s.expiresAt)) {
    stop(s, "expired", "The code expired before it was approved. Start again to get a new one.");
    return view(s);
  }
  let res: { status: number; body: Record<string, unknown> };
  try {
    res = await post(hooks.fetchImpl ?? fetch, entitlementsApiUrl(readEntitlementFile(env), env), {
      action: "device-poll",
      deviceCode: s.deviceCode,
    });
  } catch {
    // Network blip: keep waiting until the code expires.
    return view(s);
  }
  if (s.status !== "pending") return view(s); // cancelled meanwhile
  if (res.status === 200 && (res.body.status === "pending" || res.body.status === "slow_down")) {
    if (res.body.status === "slow_down") s.intervalMs = Math.min(s.intervalMs + 2_000, 15_000);
    return view(s);
  }
  if (res.status === 200 && res.body.status === "approved" && typeof res.body.token === "string") {
    const imported = importEntitlementToken(
      { token: res.body.token, refreshToken: res.body.refreshToken, apiUrl: res.body.apiUrl },
      env,
      now,
    );
    if (!imported.ok) {
      stop(
        s,
        "error",
        `KinglyVault approved, but the access it sent could not be used (${imported.error}).`,
      );
      return view(s);
    }
    stop(s, "approved");
    s.email =
      typeof res.body.email === "string"
        ? res.body.email
        : (imported.summary.account?.email ?? null);
    s.changed = imported.changed;
    try {
      s.restart =
        (await hooks.onLinked?.({ changed: imported.changed, summary: imported.summary })) ?? null;
    } catch {
      s.restart = null;
    }
    return view(s);
  }
  if (res.status === 403 || res.body.error === "access_denied") {
    stop(s, "denied", "The request was denied on KinglyVault.");
  } else if (res.status === 410) {
    stop(s, "expired", "The code expired or was already used. Start again to get a new one.");
  } else {
    stop(
      s,
      "error",
      `KinglyVault answered ${res.status}${res.body.error ? ` (${String(res.body.error)})` : ""}.`,
    );
  }
  return view(s);
}

function schedule(id: string, hooks: ConnectHooks) {
  const s = sessions.get(id);
  if (!s || s.status !== "pending") return;
  s.timer = setTimeout(() => {
    void pollKvConnectOnce(id, hooks)
      .catch(() => null)
      .finally(() => schedule(id, hooks));
  }, s.intervalMs);
  s.timer.unref?.();
}

/** Ask KinglyVault for a code and start polling in the background. */
export async function startKvConnect(
  hooks: ConnectHooks & { background?: boolean } = {},
): Promise<{ ok: true; connect: KvConnectView } | { ok: false; error: string }> {
  const env = hooks.env ?? process.env;
  const caps = await kvCapabilities({ env, fetchImpl: hooks.fetchImpl, now: hooks.now });
  if (!caps.available)
    return { ok: false, error: caps.reason ?? "KinglyVault connect is not available." };
  const who = deviceIdentity(env);
  let res: { status: number; body: Record<string, unknown> };
  try {
    res = await post(hooks.fetchImpl ?? fetch, entitlementsApiUrl(readEntitlementFile(env), env), {
      action: "device-start",
      label: who.label,
      client: who.client,
      host: who.host,
    });
  } catch {
    return {
      ok: false,
      error: "KinglyVault can't be reached right now. Check the internet connection and try again.",
    };
  }
  const b = res.body;
  if (
    res.status !== 200 ||
    typeof b.deviceCode !== "string" ||
    typeof b.userCode !== "string" ||
    typeof b.verificationUri !== "string"
  ) {
    return { ok: false, error: `KinglyVault couldn't start the connection (${res.status}).` };
  }
  // Only ever open KinglyVault's own pages.
  const page = safeVerificationUrl(
    typeof b.verificationUriComplete === "string" ? b.verificationUriComplete : b.verificationUri,
  );
  const plain = safeVerificationUrl(b.verificationUri);
  if (!page || !plain)
    return { ok: false, error: "KinglyVault sent an approval link that isn't a web page." };
  prune();
  const now = (hooks.now ?? Date.now)();
  const expiresIn = typeof b.expiresIn === "number" && b.expiresIn > 0 ? b.expiresIn : 600;
  const interval = typeof b.interval === "number" && b.interval > 0 ? b.interval : 5;
  const s: Session = {
    id: randomBytes(9).toString("base64url"),
    status: "pending",
    userCode: b.userCode,
    verificationUri: plain,
    verificationUriComplete: page,
    expiresAt: new Date(now + expiresIn * 1000).toISOString(),
    error: null,
    email: null,
    changed: [],
    restart: null,
    deviceCode: b.deviceCode,
    intervalMs: Math.max(1, interval) * 1000,
    timer: null,
  };
  sessions.set(s.id, s);
  if (hooks.background !== false) schedule(s.id, hooks);
  return { ok: true, connect: view(s) };
}

export function safeVerificationUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function getKvConnect(id: string): KvConnectView | null {
  const s = sessions.get(id);
  return s ? view(s) : null;
}

/** The newest session still waiting for approval (the UI re-attaches to it). */
export function activeKvConnect(): KvConnectView | null {
  const pending = [...sessions.values()].filter((s) => s.status === "pending");
  return pending.length ? view(pending[pending.length - 1]) : null;
}

export function cancelKvConnect(id: string): boolean {
  const s = sessions.get(id);
  if (!s) return false;
  if (s.status === "pending") stop(s, "cancelled");
  return true;
}

/**
 * Tell KinglyVault to forget this install's device link (best effort; the
 * local unlink happens regardless).
 */
export async function revokeKvDeviceLink(
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchImpl; refreshToken?: string | null } = {},
): Promise<boolean> {
  const env = opts.env ?? process.env;
  const file = readEntitlementFile(env);
  const rt = opts.refreshToken ?? file.refreshToken;
  if (!rt) return false;
  try {
    const res = await post(opts.fetchImpl ?? fetch, entitlementsApiUrl(file, env), {
      action: "device-unlink",
      refreshToken: rt,
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Tests only. */
export function resetKvConnectForTests(): void {
  for (const s of sessions.values()) if (s.timer) clearTimeout(s.timer);
  sessions.clear();
  capsCache = null;
}

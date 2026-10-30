/**
 * Android Social Ops — orchestration service.
 *
 * The one place the store, the state machine, the assignment policy and the
 * device adapters meet. Every mutation lands an audit row, because §3 lists
 * "who/what/when for important operations" as a first-class module rather than
 * a nice-to-have.
 *
 * Execution has two modes and the UI always says which one it is in:
 *   live      — commands go to the ADB/scrcpy adapters against real handsets.
 *   simulated — explicitly requested dev mode; the state machine runs for real,
 *               only the device outcome is synthesised. See `simulator.ts`.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveStateDir } from "../config/paths.js";
import {
  computeLoads,
  pickLeastLoadedDevice,
  staggerSchedule,
  type LoadOptions,
} from "./assignment.js";
import { COMPLIANCE_STATEMENT, FORBIDDEN_CAPABILITIES, HUMAN_CHECKPOINTS } from "./compliance.js";
import { buildDashboard, type DashboardSummary } from "./dashboard.js";
import {
  applyTransition,
  canRetry,
  resumeStateFor,
  type TransitionContext,
} from "./job-state-machine.js";
import {
  generatePassword,
  hasSecret,
  moveSecret,
  putSecret,
  revealSecret,
  vaultRef,
} from "./secrets.js";
import { automateStep, type AutomationDriver, type AutomationOutcome } from "./auto-runner.js";
import { buildPrompt, parseAction, type AiAction } from "./ai-driver.js";
import {
  PLATFORM_PACKAGES,
  centerOf,
  detectBlocker,
  detectTermsGate,
  findTapTarget,
  parseHierarchy,
  type UiNode,
} from "./ui-automation.js";
import type { AllowedCommand } from "./compliance.js";
import {
  compactHierarchy,
  locate,
  parseCurrentApp,
  parseDeviceProps,
  parseNetwork,
  parsePackages,
  selectorFrom,
  type UiSelectorInput,
} from "./agent-device.js";
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Ask Claude Code for one action. One-shot and non-interactive: the model sees a
 * screen and answers with JSON, it does not get a session or tools. Failing here
 * is not fatal — the caller treats an unusable reply as a turn that achieved
 * nothing and tries again.
 */
async function askClaude(prompt: string): Promise<string> {
  const { stdout } = await execFileAsync("claude", ["-p", prompt, "--output-format", "json"], {
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });
  try {
    const parsed = JSON.parse(stdout) as { result?: unknown; content?: unknown };
    if (typeof parsed.result === "string") return parsed.result;
    if (typeof parsed.content === "string") return parsed.content;
  } catch {
    /* not the envelope we expected — hand the raw text to the parser */
  }
  return stdout;
}
import {
  advanceProvisioning,
  startProvisioningRun,
  type AdvanceStepInput,
} from "./provisioning.js";
import { BUILD_SEQUENCE, RUNBOOKS, SCALING_ROADMAP } from "./roadmap.js";
import { seedAndroidOps } from "./seed.js";
import {
  assertNoSecretMaterial,
  buildSetupSteps,
  detectFlyConfig,
  ipFromSerial,
  looksLikeDemoData,
  matchDeviceByIdentity,
  nextFreeSlot,
  normalizeAccountImport,
  normalizeDeviceRegistration,
  sameStableIdentity,
  toPublicAccount,
  type AccountImportEntry,
  type DeviceRegistrationInput,
  type FlyConfigPresence,
  type PublicSocialAccount,
  type SetupStep,
  type StoreCensus,
} from "./setup.js";
import {
  buildPresence,
  matchAttached,
  parseScreenState,
  type DevicePresence,
  type FleetPresence,
} from "./presence.js";
import { simulateOutcome, simulatedPermalink } from "./simulator.js";
import { AndroidOpsStore, getAndroidOpsStore, peekDeviceCount } from "./store.js";
import {
  createAdapterSet,
  describeAdapters,
  listTailscaleNodes,
  type AdapterSet,
  type AdapterStatus,
  type AdbDeviceInfo,
  type DeviceCommand,
  type TailscaleNode,
} from "./adapters/index.js";
import type { DeviceCommandResult } from "./adapters/types.js";

/**
 * A faster transport for already-validated device commands (for example the
 * Droid Swarm plugin's persistent scrcpy control socket). Returns a result when
 * it handled the command, or null to fall through to the regular adapter. It
 * runs strictly AFTER the allowlist/argument checks and BEFORE the audit row,
 * so compliance and auditing are unchanged — only the transport differs.
 */
export type DeviceCommandAccelerator = (
  serial: string,
  cmd: DeviceCommand,
) => Promise<DeviceCommandResult | null>;
import type {
  InboxItem,
  JobState,
  MediaAsset,
  PhoneDevice,
  Platform,
  PostJob,
  ProvisioningRun,
  SocialAccount,
} from "./types.js";

const log = createSubsystemLogger("android-ops");

const SAFE_PACKAGE = /^[a-zA-Z0-9_.]+$/;

/** agentControlDevice actions served by agentExtendedAction(). */
const AGENT_EXTENDED_ACTIONS = new Set<string>([
  "ui_dump",
  "find_and_tap",
  "wait_for",
  "stop",
  "install",
  "uninstall",
  "current_app",
  "device_info",
  "list_apps",
  "push_media",
  "share_media",
  "media_index",
  "media_remove",
  "ime_state",
  "screen_state",
]);

/** A file the posting flow may place on / remove from a handset. */
const DEVICE_MEDIA_PATH = /^\/sdcard\/[A-Za-z0-9._/-]+$/;

function deviceMediaPath(raw: string | undefined): string {
  const devicePath = (raw ?? "").trim();
  if (!DEVICE_MEDIA_PATH.test(devicePath) || devicePath.includes("..")) {
    throw new Error(
      "devicePath must be a file under /sdcard/, e.g. /sdcard/DCIM/InfiniBot/clip.mp4.",
    );
  }
  return devicePath;
}

/** `content query` rows → the first row's MediaStore id / size / duration. */
export function parseMediaRow(
  stdout: string,
): { id: number; size: number | null; durationMs: number | null } | null {
  const line = stdout.split("\n").find((l) => /\b_id=\d+/.test(l));
  if (!line) return null;
  const num = (key: string) => {
    const m = new RegExp(`\\b${key}=(\\d+)`).exec(line);
    return m ? Number(m[1]) : null;
  };
  return { id: num("_id")!, size: num("_size"), durationMs: num("duration") };
}

function serialPort(serial: string): string | null {
  const idx = serial.lastIndexOf(":");
  return idx >= 0 ? serial.slice(idx + 1) : null;
}

function normalModel(model: string | null | undefined): string | null {
  return (
    model
      ?.trim()
      .replace(/[\s-]+/g, "_")
      .toLowerCase() || null
  );
}

function looksLikeAdbMdnsSerial(serial: string): boolean {
  return /(^|[._-])_adb-tls-(connect|pair)[._-]/i.test(serial);
}

function sameModelFamily(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(`_${b}`) || b.endsWith(`_${a}`);
}

/** A live adb device projected into the shape stable-identity matching wants. */
function liveIdentity(live: AdbDeviceInfo) {
  return {
    androidId: live.androidId ?? null,
    serial: live.serial,
    model: live.model,
    tailscaleIp: ipFromSerial(live.serial),
  };
}

function isSameWirelessDebugAlias(live: AdbDeviceInfo, device: PhoneDevice): boolean {
  if (looksLikeAdbMdnsSerial(live.serial)) return true;
  const livePort = serialPort(live.serial);
  const devicePort = serialPort(device.serial);
  if (!livePort || livePort !== devicePort) return false;
  if (!device.serial.includes(":") || !live.serial.includes(":")) return false;
  const liveModel = normalModel(live.model);
  const deviceModel = normalModel(device.model);
  return sameModelFamily(liveModel, deviceModel);
}
const SAFE_KEYEVENT = /^(KEYCODE_[A-Z0-9_]+|\d{1,3})$/;

function finiteNumber(value: unknown, label: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a finite number.`);
  return Math.round(n);
}

function boundedCoord(value: unknown, label: string): number {
  const n = finiteNumber(value, label);
  if (n < 0 || n > 10000) throw new Error(`${label} must be between 0 and 10000.`);
  return n;
}

function boundedDuration(value: unknown): number {
  const n = value === undefined || value === null ? 300 : finiteNumber(value, "durationMs");
  if (n < 0 || n > 10000) throw new Error("durationMs must be between 0 and 10000.");
  return n;
}

function safeTextInput(value: unknown): string {
  if (typeof value !== "string") throw new Error("text is required.");
  if (!value) throw new Error("text cannot be empty.");
  if (value.length > 500) throw new Error("text must be 500 characters or fewer.");
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("text cannot contain control characters or newlines.");
  }
  return value;
}

export interface TickResult {
  mode: "live" | "simulated";
  moved: Array<{ jobId: string; from: JobState; to: JobState; summary: string }>;
  skipped: Array<{ jobId: string; reason: string }>;
  paused: string | null;
}

export interface FleetRefreshResult {
  probed: number;
  matched: number;
  /** Handsets adopted into the registry because adb saw them and we didn't. */
  adopted: Array<{ id: string; label: string; serial: string }>;
  /** Registered handsets whose tailnet address was learned or corrected. */
  tailscaleUpdated: number;
  /** Android nodes on the tailnet that nobody has registered yet. */
  candidates: Array<{ hostname: string; ip: string | null; os: string | null; online: boolean }>;
  alerts: number;
  reason: string | null;
}

/**
 * Where this process actually persisted the fleet, so an operator staring at a
 * blank dashboard can tell an empty install apart from one that opened the wrong
 * database. A process can inherit `INFINIBOT_STATE_DIR` pointing somewhere else
 * (it happened once with `~/.infinibot-omniclinic`) and silently open an empty
 * store; the {@link warning} names that case out loud instead of auto-switching.
 */
export interface StorageDiagnostics {
  /** State dir this process resolved and opened. */
  stateDir: string;
  /** Absolute path of the SQLite file backing the live fleet. */
  dbPath: string;
  /** Devices currently in the live store. */
  deviceCount: number;
  /** The canonical default state dir (`~/.infinibot`). */
  defaultStateDir: string;
  /** Absolute path of the default install's android-ops database. */
  defaultDbPath: string;
  /** True when the live store is the canonical default location. */
  isDefaultStateDir: boolean;
  /** Devices in the default DB, when it exists and differs from the live one. */
  defaultDeviceCount: number | null;
  /**
   * Set only when this process opened a NON-default, EMPTY store while the
   * default install still has devices — the "my phones vanished" footgun. The
   * dashboard surfaces it; nothing ever switches databases automatically.
   */
  warning: string | null;
}

/** Everything a standalone dashboard needs to render a first-run install. */
export interface SetupStatus {
  census: StoreCensus;
  adapters: AdapterStatus;
  tailscale: { ok: boolean; reason: string | null; nodes: TailscaleNode[] };
  fly: FlyConfigPresence;
  steps: SetupStep[];
  /** True when no blocking setup step is outstanding. */
  ready: boolean;
  storageBackend: string;
  generatedAt: number;
}

export type DeviceAgentControlAction =
  | "adb_connect"
  | "adb_pair"
  | "screenshot"
  | "logs"
  | "launch"
  | "tap"
  | "swipe"
  | "text"
  | "keyevent"
  | "open_stream"
  | "close_stream"
  | "ui_dump"
  | "find_and_tap"
  | "wait_for"
  | "stop"
  | "install"
  | "uninstall"
  | "current_app"
  | "device_info"
  | "list_apps"
  | "push_media"
  | "share_media"
  | "media_index"
  | "media_remove"
  | "ime_state"
  | "screen_state";

export interface DeviceAgentControlInput {
  deviceId: string;
  action: DeviceAgentControlAction;
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  durationMs?: number;
  text?: string;
  keyevent?: string;
  package?: string;
  label?: string;
  sinceMs?: number;
  sessionId?: string;
  pairHostPort?: string;
  pairingCode?: string;
  /** find_and_tap / wait_for: which element. */
  selector?: UiSelectorInput;
  /** wait_for: wait until the element is GONE instead of present. */
  gone?: boolean;
  /** wait_for: give up after this long (500..60000 ms, default 10000). */
  timeoutMs?: number;
  /** ui_dump: keep layout-only containers too. */
  all?: boolean;
  /** ui_dump: element cap (default 250, max 600). */
  limit?: number;
  /** share_media: file already on the handset (under /sdcard/). */
  devicePath?: string;
  /** share_media: explicit share activity, e.g. com.instagram.android/.SomeActivity. */
  component?: string;
  /** share_media: mime type of the file (video/mp4 default). */
  mime?: string;
  /** install: absolute path of an .apk on this host. */
  apkPath?: string;
  /** push_media: media library asset id. */
  mediaId?: string;
  /** push_media: destination directory on the handset (under /sdcard). */
  dest?: string;
  /** push_media: file name to give the pushed copy (default: the library's). */
  destName?: string;
  /** share_media: MediaStore uri from media_index (skips the lookup). */
  contentUri?: string;
}

export interface DeviceAgentControlResult {
  ok: boolean;
  action: DeviceAgentControlAction;
  deviceId: string;
  label: string;
  serial: string;
  result: unknown;
  reason: string | null;
}

export interface AccountImportResult {
  created: PublicSocialAccount[];
  updated: PublicSocialAccount[];
  /** Rows that could not be imported, with the reason an operator can act on. */
  rejected: Array<{ handle: string; platform: string; reason: string }>;
  /**
   * Rows that imported fine but could not be placed on a handset — a rack that
   * has never been probed has no eligible device yet. The account exists; it
   * just cannot be scheduled until it is assigned.
   */
  unassigned: Array<{ handle: string; platform: string; reason: string }>;
}

export interface ScheduleInput {
  mediaId: string;
  accountIds: string[];
  startAt: number;
  actor: string;
  /** Minimum gap between two jobs on the same handset. */
  deviceGapMs?: number;
  rackGapMs?: number;
  caption?: string;
}

export class AndroidOpsService {
  readonly store: AndroidOpsStore;
  private adapters: AdapterSet;
  private adapterStatus: AdapterStatus | null = null;
  private presenceCache: { at: number; screen: boolean; value: FleetPresence } | null = null;
  private presenceInflight: Promise<FleetPresence> | null = null;

  constructor(store: AndroidOpsStore, adapters: AdapterSet) {
    this.store = store;
    this.adapters = adapters;
  }

  private baseRunCommand: AdapterSet["device"]["runCommand"] | null = null;

  /**
   * Route device commands through `accelerator` first (null restores the plain
   * adapter). Wraps the adapter's runCommand in place so every caller — agent
   * control, scripted steps, the AI driver — gets the same transport.
   */
  installCommandAccelerator(accelerator: DeviceCommandAccelerator | null): void {
    const device = this.adapters.device;
    if (!this.baseRunCommand) this.baseRunCommand = device.runCommand.bind(device);
    const base = this.baseRunCommand;
    device.runCommand = accelerator
      ? async (serial, cmd) => {
          try {
            const fast = await accelerator(serial, cmd);
            if (fast) return fast;
          } catch (err) {
            log.warn("device command accelerator failed; using the adapter", {
              command: cmd.command,
              error: String(err),
            });
          }
          return base(serial, cmd);
        }
      : base;
  }

  static async create(store = getAndroidOpsStore()): Promise<AndroidOpsService> {
    const adapters = await createAdapterSet(resolveStateDir());
    const service = new AndroidOpsService(store, adapters);
    // An empty store stays empty. Demo data is never written implicitly: an
    // operator who registers a real handset must not have to work out which of
    // the rows in front of them are fictional. `androidops.seed` is the one and
    // only way demo rows appear, and it says so.
    if (store.count("ao_devices") === 0) {
      log.info("android-ops store is empty — awaiting device registration", {
        hint: "androidops.device.register, or androidops.fleet.refresh to adopt attached handsets",
      });
    }
    return service;
  }

  private audit(
    actor: string,
    action: string,
    targetType: "job" | "device" | "account" | "media" | "inbox" | "provisioning" | "system",
    targetId: string,
    summary: string,
    meta?: Record<string, unknown>,
  ) {
    this.store.appendAudit({
      at: Date.now(),
      actor,
      action,
      targetType,
      targetId,
      summary,
      meta: meta ?? null,
    });
  }

  // ── Read surface ───────────────────────────────────────────────────────────

  dashboard(now = Date.now()): DashboardSummary {
    return buildDashboard({
      devices: this.store.listDevices(),
      accounts: this.store.listAccounts(),
      jobs: this.store.listJobs({ limit: 2000 }),
      provisioning: this.store.listProvisioning(),
      alerts: this.store.listAlerts(true),
      inbox: this.store.listInbox(),
      now,
    });
  }

  async adapterSnapshot(refresh = false): Promise<AdapterStatus> {
    if (!this.adapterStatus || refresh) {
      this.adapterStatus = await describeAdapters(this.adapters);
    }
    return this.adapterStatus;
  }

  /** Whether real device execution is possible right now. */
  async isLiveCapable(): Promise<boolean> {
    return (await this.adapterSnapshot()).device.available;
  }

  /**
   * What is actually in the store. The dashboard uses this to tell a genuinely
   * empty install apart from a broken one, so the counts are read live rather
   * than cached.
   */
  census(): StoreCensus {
    const devices = this.store.listDevices();
    const accounts = this.store.listAccounts();
    const media = this.store.count("ao_media");
    const jobs = this.store.count("ao_jobs");
    return {
      devices: devices.length,
      accounts: accounts.length,
      media,
      jobs,
      provisioning: this.store.count("ao_provisioning"),
      inbox: this.store.count("ao_inbox"),
      empty: devices.length === 0 && accounts.length === 0 && media === 0 && jobs === 0,
      needsDevices: devices.length === 0,
      needsAccounts: accounts.length === 0,
      needsMedia: media === 0,
      demoSeedPresent: looksLikeDemoData({ accounts, devices }),
    };
  }

  /**
   * The first-run payload for a standalone dashboard: what exists, what the
   * toolchain can do, whether the tailnet and a fly deployment are configured,
   * and the ordered checklist of what is still missing.
   */
  async setupStatus(): Promise<SetupStatus> {
    const [adapters, tailscale, fly] = await Promise.all([
      this.adapterSnapshot(true),
      listTailscaleNodes(),
      detectFlyConfig([process.cwd(), resolveStateDir()]),
    ]);
    const census = this.census();
    const steps = buildSetupSteps({
      census,
      deviceAdapterAvailable: adapters.device.available,
      streamAdapterAvailable: adapters.stream.available,
      storageAvailable: adapters.storage.available,
      tailscaleAvailable: adapters.tailscale.available,
      assignedAccounts: this.store.listAccounts().filter((a) => a.deviceId).length,
    });
    return {
      census,
      adapters,
      tailscale,
      fly,
      steps,
      ready: steps.every((s) => !s.blocking || s.done),
      storageBackend: this.adapters.storage.backend,
      generatedAt: Date.now(),
    };
  }

  async opsStatus() {
    const adapters = await this.adapterSnapshot(true);
    const devices = this.store.listDevices();
    return {
      adapters,
      storage: this.storageDiagnostics(),
      setup: await this.setupStatus(),
      compliance: {
        statement: COMPLIANCE_STATEMENT,
        forbidden: FORBIDDEN_CAPABILITIES,
        humanCheckpoints: HUMAN_CHECKPOINTS,
      },
      backups: this.store.listBackups(),
      alerts: this.store.listAlerts(),
      runbooks: RUNBOOKS,
      roadmap: SCALING_ROADMAP,
      buildSequence: BUILD_SEQUENCE,
      spare: devices.find((d) => d.isSpare) ?? null,
      staged: devices
        .filter((d) => d.updateChannel !== "stable")
        .map((d) => ({ id: d.id, label: d.label, channel: d.updateChannel })),
      streamSessions: this.adapters.stream.listSessions(),
    };
  }

  // ── Fleet ──────────────────────────────────────────────────────────────────

  /**
   * Live presence of every registered handset: one `adb devices -l`, cached
   * for `maxAgeMs` (default 10 s) so a page polling it does not hammer adb.
   * Reconciles `ao_devices` as a side effect — a phone adb no longer lists
   * becomes offline/absent (it used to keep its last "online" until someone
   * ran a full fleet refresh), and a listed phone gets a fresh heartbeat.
   * With `screen: true`, connected phones also report awake / locked /
   * foreground app (one read-only dumpsys each, not audited per call).
   * Never launches an app or taps anything.
   */
  async presence(
    opts: { maxAgeMs?: number; screen?: boolean; now?: number } = {},
  ): Promise<FleetPresence> {
    const maxAgeMs = opts.maxAgeMs ?? 10_000;
    const cached = this.presenceCache;
    const now = opts.now ?? Date.now();
    if (cached && now - cached.at < maxAgeMs && (cached.screen || !opts.screen)) {
      return cached.value;
    }
    if (this.presenceInflight && !opts.screen) return this.presenceInflight;
    const run = this.computePresence(opts.screen === true, now);
    this.presenceInflight = run;
    try {
      const value = await run;
      this.presenceCache = { at: now, screen: opts.screen === true, value };
      return value;
    } finally {
      if (this.presenceInflight === run) this.presenceInflight = null;
    }
  }

  /** Presence of one device (fresh unless maxAgeMs says otherwise). */
  async devicePresence(
    deviceId: string,
    opts: { maxAgeMs?: number; screen?: boolean } = {},
  ): Promise<DevicePresence | null> {
    const fleet = await this.presence({ maxAgeMs: opts.maxAgeMs ?? 0, screen: opts.screen });
    return fleet.devices[deviceId] ?? null;
  }

  private async computePresence(withScreen: boolean, now: number): Promise<FleetPresence> {
    const snapshot = await this.adapterSnapshot(false);
    let available = snapshot.device.available;
    let reason = snapshot.device.reason ?? null;
    if (!available && snapshot.device.kind === "adb") {
      // A cached "unavailable" may be stale (adb installed since); re-probe.
      const fresh = await this.adapterSnapshot(true);
      available = fresh.device.available;
      reason = fresh.device.reason ?? null;
    }
    const attached = available ? await this.adapters.device.listDevices() : [];
    const devices: Record<string, DevicePresence> = {};
    for (const device of this.store.listDevices()) {
      const live = matchAttached(device, attached);
      const p = buildPresence(device, live, available, now);
      if (p.online && withScreen) {
        try {
          const res = await this.adapters.device.runCommand(p.serial, {
            command: "device.screen",
            timeoutMs: 10_000,
          });
          p.screen = res.ok ? parseScreenState(res.stdout) : null;
        } catch {
          p.screen = null;
        }
      }
      devices[device.id] = p;
      this.reconcilePresence(device, p, now);
    }
    return { checkedAt: now, adb: { available, reason }, devices };
  }

  /** Writes presence back to ao_devices, only when something changed. */
  private reconcilePresence(device: PhoneDevice, p: DevicePresence, now: number): void {
    if (p.connection === "adb_unavailable") return; // cannot tell; leave the row alone
    const wasUp = device.status === "online" || device.status === "degraded";
    let next: PhoneDevice | null = null;
    if (p.online) {
      const status =
        device.isSpare || device.status === "maintenance"
          ? device.status
          : wasUp
            ? device.status
            : "online";
      next = {
        ...device,
        adbState: "device",
        status,
        lastHeartbeatAt: now,
        updatedAt: now,
      };
    } else if (wasUp || device.adbState !== p.adbState) {
      next = {
        ...device,
        adbState: p.adbState,
        scrcpyState: "unavailable",
        status: device.isSpare
          ? "spare"
          : device.status === "maintenance"
            ? "maintenance"
            : "offline",
        updatedAt: now,
      };
    }
    if (!next) return;
    this.store.upsertDevice(next);
    const nowUp = next.status === "online" || next.status === "degraded";
    if (nowUp !== wasUp) {
      this.audit(
        "system:presence",
        nowUp ? "device.presence.online" : "device.presence.offline",
        "device",
        device.id,
        nowUp
          ? `${device.label} is reachable over adb again (${p.transport}).`
          : `${device.label} is no longer reachable over adb (${p.summary}).`,
        { connection: p.connection, serial: p.serial, lastSeenAt: p.lastSeenAt },
      );
    }
  }

  /**
   * Reconcile the registry against reality: probe adapters, adopt handsets adb
   * can see that nobody registered, learn tailnet addresses, record a health
   * sample per device and raise alerts on anything that crossed a threshold.
   *
   * Adoption is what makes a fresh install usable without hand-typing serials —
   * plug the rack in, hit refresh, and the phones that answer become rows.
   */
  async refreshFleet(
    actor = "system",
    opts: { adopt?: boolean } = {},
  ): Promise<FleetRefreshResult> {
    const status = await this.adapterSnapshot(true);
    const attached = status.device.available ? await this.adapters.device.listDevices() : [];
    const bySerial = new Map(attached.map((d) => [d.serial, d]));
    const now = Date.now();
    let matched = 0;
    let alerts = 0;

    const adopted: FleetRefreshResult["adopted"] = [];
    if (opts.adopt !== false && attached.length) {
      for (const live of attached) {
        // `unauthorized` means the handset hasn't accepted this host's adb key
        // yet — registering it would create a row nobody can drive.
        if (live.state === "unauthorized") continue;
        if (looksLikeAdbMdnsSerial(live.serial)) continue;
        if (this.store.getDeviceBySerial(live.serial)) continue;
        const existing = this.store.listDevices();
        if (existing.some((device) => isSameWirelessDebugAlias(live, device))) continue;
        // Already registered under a different (stale) serial — the reconcile
        // pass below refreshes its serial and flips it back online. Adopting it
        // here would spawn the very duplicate this change exists to prevent.
        if (existing.some((device) => sameStableIdentity(liveIdentity(live), device))) continue;
        const device = normalizeDeviceRegistration(
          {
            serial: live.serial,
            model: live.model ?? undefined,
            slot: nextFreeSlot(existing),
            notes: `Adopted from ${live.transport === "tcp" ? "a tailnet/TCP" : "a USB"} adb connection.`,
          },
          { existing, now },
        );
        this.store.upsertDevice(device);
        adopted.push({ id: device.id, label: device.label, serial: device.serial });
        this.audit(
          actor,
          "device.adopt",
          "device",
          device.id,
          `Adopted ${device.label} (${device.serial}) — adb reported it and it was not registered.`,
          { transport: live.transport },
        );
      }
    }

    // Tailnet reconciliation: learn each handset's private address so an
    // unreachable phone can be told apart from a down management network.
    const tailnet = await listTailscaleNodes();
    const nodeByIp = new Map<string, TailscaleNode>();
    const nodeByName = new Map<string, TailscaleNode>();
    for (const node of tailnet.nodes) {
      if (node.ip) nodeByIp.set(node.ip, node);
      nodeByName.set(node.hostname.toLowerCase(), node);
      if (node.dnsName) nodeByName.set(node.dnsName.toLowerCase(), node);
    }
    let tailscaleUpdated = 0;
    const claimedNodes = new Set<string>();

    for (const device of this.store.listDevices()) {
      // Prefer an exact serial hit; otherwise match the phone by stable identity
      // so a handset that re-paired under a new port is recognised as the same
      // row instead of being marked absent while a fresh duplicate sits online.
      const live =
        bySerial.get(device.serial) ??
        attached.find(
          (l) => l.state !== "unauthorized" && sameStableIdentity(liveIdentity(l), device),
        );
      let next: PhoneDevice = { ...device, updatedAt: now };
      if (live) {
        if (live.serial !== device.serial) {
          next = {
            ...next,
            serial: live.serial,
            tailscaleIp: ipFromSerial(live.serial) ?? next.tailscaleIp,
          };
        }
        if (live.androidId && live.androidId !== device.androidId) {
          next = { ...next, androidId: live.androidId };
        }
      }

      const serialHost = device.serial.includes(":")
        ? device.serial.slice(0, device.serial.lastIndexOf(":")).toLowerCase()
        : device.serial.toLowerCase();
      const node =
        (device.tailscaleIp ? nodeByIp.get(device.tailscaleIp) : undefined) ??
        nodeByIp.get(ipFromSerial(device.serial) ?? "") ??
        nodeByName.get(serialHost) ??
        nodeByName.get(device.label.toLowerCase().replace(/\s+/g, "-"));
      if (node) {
        claimedNodes.add(node.hostname);
        if (
          next.tailscaleIp !== (node.ip ?? next.tailscaleIp) ||
          next.tailscaleUp !== node.online
        ) {
          tailscaleUpdated++;
        }
        next = { ...next, tailscaleIp: node.ip ?? next.tailscaleIp, tailscaleUp: node.online };
      } else if (tailnet.ok && device.tailscaleIp) {
        if (next.tailscaleUp) tailscaleUpdated++;
        next = { ...next, tailscaleUp: false };
      }

      if (live) {
        matched++;
        const health = await this.adapters.device.readHealth(next.serial);
        next = {
          ...next,
          adbState: live.state,
          scrcpyState: status.stream.available ? "ready" : "unavailable",
          batteryPct: health.batteryPct ?? device.batteryPct,
          charging: health.charging ?? device.charging,
          storageFreeMb: health.storageFreeMb ?? device.storageFreeMb,
          storageTotalMb: health.storageTotalMb ?? device.storageTotalMb,
          wifiSsid: health.wifiSsid ?? device.wifiSsid,
          wifiSignalDbm: health.wifiSignalDbm ?? device.wifiSignalDbm,
          status: device.isSpare ? "spare" : health.ok ? health.status : "offline",
          lastHeartbeatAt: health.ok ? now : device.lastHeartbeatAt,
        };
      } else if (status.device.available) {
        // The toolchain works but this handset isn't there.
        next = {
          ...next,
          adbState: "absent",
          scrcpyState: "unavailable",
          status: device.isSpare ? "spare" : "offline",
        };
      }

      this.store.upsertDevice(next);
      this.store.recordHealth({
        deviceId: next.id,
        at: now,
        batteryPct: next.batteryPct,
        charging: next.charging,
        storageFreeMb: next.storageFreeMb,
        wifiSignalDbm: next.wifiSignalDbm,
        status: next.status,
        online: next.status === "online" || next.status === "degraded",
      });
      alerts += this.evaluateDeviceAlerts(next, now);
    }

    this.store.pruneHealth(now - 14 * 86_400_000);

    // Android nodes on the tailnet that no registered handset claimed. Offered,
    // not adopted: without an adb handshake we cannot prove which phone it is.
    const candidates = tailnet.nodes
      .filter(
        (n) => !n.self && (n.os ?? "").toLowerCase() === "android" && !claimedNodes.has(n.hostname),
      )
      .map((n) => ({ hostname: n.hostname, ip: n.ip, os: n.os, online: n.online }));

    this.audit(
      actor,
      "fleet.refresh",
      "system",
      "fleet",
      `Probed the rack — ${matched} handset(s) attached` +
        (adopted.length ? `, ${adopted.length} adopted` : "") +
        (candidates.length ? `, ${candidates.length} unregistered tailnet handset(s)` : "") +
        ".",
      { adopted: adopted.map((d) => d.serial), tailscaleUpdated },
    );

    return {
      probed: this.store.count("ao_devices"),
      matched,
      adopted,
      tailscaleUpdated,
      candidates,
      alerts,
      reason: status.device.available
        ? null
        : (status.device.reason ??
          "Device control is unavailable, so nothing could be probed or adopted."),
    };
  }

  private evaluateDeviceAlerts(device: PhoneDevice, now: number): number {
    let raised = 0;
    const raise = (kind: string, severity: "warning" | "critical", message: string) => {
      if (this.store.hasOpenAlert(kind, device.id)) return;
      this.store.raiseAlert({
        at: now,
        severity,
        kind,
        subjectType: "device",
        subjectId: device.id,
        message,
        acknowledgedAt: null,
        acknowledgedBy: null,
      });
      raised++;
    };

    if (device.isSpare) return 0;
    if (device.status === "offline")
      raise("device_offline", "critical", `${device.label} is offline.`);
    if (device.storageFreeMb < 4096) {
      raise(
        "low_storage",
        "warning",
        `${device.label} has ${(device.storageFreeMb / 1024).toFixed(1)} GB free.`,
      );
    }
    if (device.batteryPct < 20 && !device.charging) {
      raise(
        "low_battery",
        "warning",
        `${device.label} is at ${device.batteryPct}% and not charging.`,
      );
    }
    if (device.wifiSignalDbm !== null && device.wifiSignalDbm < -75) {
      raise(
        "weak_wifi",
        "warning",
        `${device.label} has a weak uplink (${device.wifiSignalDbm} dBm).`,
      );
    }
    return raised;
  }

  /**
   * Register a handset from operator-entered form data, or re-register one by
   * passing its `id`. Health fields are deliberately *not* accepted here: a row
   * may claim a handset exists, only an adapter probe may claim it is online.
   */
  registerDevice(input: DeviceRegistrationInput, actor: string): PhoneDevice {
    const existing = this.store.listDevices();
    // Resolve the target row by explicit id first, then by STABLE identity
    // (ANDROID_ID, else tailnet-IP + model). Keying on the serial is the bug we
    // are fixing: a wireless-debugging serial is `host:port` with a port that
    // changes on every re-pair, so a reconnecting phone would otherwise insert a
    // fresh row and leave its old one to rot offline. An identity match re-uses
    // the existing id/slot/assignments and simply refreshes the serial.
    const known =
      (input.id ? this.store.getDevice(input.id) : null) ?? matchDeviceByIdentity(input, existing);
    const device = normalizeDeviceRegistration(
      { ...input, id: known?.id ?? input.id },
      { existing },
    );
    this.store.upsertDevice(device);
    const reconnected = Boolean(known && known.serial !== device.serial);
    this.audit(
      actor,
      known ? "device.register.update" : "device.register",
      "device",
      device.id,
      known
        ? reconnected
          ? `Re-registered ${device.label} under a new serial (${known.serial} → ${device.serial}); kept its slot, assignments and history.`
          : `Updated the registration for ${device.label} (${device.serial}).`
        : `Registered ${device.label} in slot ${device.slot} (${device.serial}). Run a fleet refresh to verify it answers.`,
      {
        serial: device.serial,
        previousSerial: known?.serial ?? null,
        slot: device.slot,
        androidId: device.androidId,
      },
    );
    return device;
  }

  /**
   * Fold a duplicate handset row into the one to keep: re-point its accounts,
   * jobs and health history, adopt any stable identity it learned, and delete
   * it. This is the repair for rows created before registration keyed on a
   * stable identity — the same phone recorded twice under two serials.
   */
  mergeDevices(
    keepId: string,
    dropId: string,
    actor: string,
  ): { kept: PhoneDevice; accountsMoved: number; jobsMoved: number } {
    if (keepId === dropId) throw new Error("keepId and dropId must differ.");
    const keep = this.store.getDevice(keepId);
    const drop = this.store.getDevice(dropId);
    if (!keep) throw new Error(`Unknown device ${keepId}`);
    if (!drop) throw new Error(`Unknown device ${dropId}`);

    // Carry the stable identity forward so future reconnects resolve to the
    // survivor: prefer the id it already has, else adopt the duplicate's.
    const androidId = keep.androidId ?? drop.androidId ?? null;
    const { accountsMoved, jobsMoved } = this.store.mergeDeviceInto(dropId, keepId);
    const kept = this.store.upsertDevice({ ...keep, androidId, updatedAt: Date.now() });
    this.audit(
      actor,
      "device.merge",
      "device",
      keepId,
      `Merged duplicate ${drop.label} (${drop.serial}) into ${keep.label} (${keep.serial}); ` +
        `moved ${accountsMoved} account(s) and ${jobsMoved} job(s).`,
      { dropId, dropSerial: drop.serial, androidId, accountsMoved, jobsMoved },
    );
    return { kept, accountsMoved, jobsMoved };
  }

  /**
   * Report where the fleet is actually stored and warn — never auto-switch —
   * when this process opened a non-default, empty store while the default
   * install still has devices. See {@link StorageDiagnostics}.
   */
  storageDiagnostics(opts: { defaultStateDir?: string } = {}): StorageDiagnostics {
    const stateDir = this.store.stateDir;
    const dbPath = this.store.dbPath;
    const deviceCount = this.store.count("ao_devices");
    // The canonical install location. Overridable only so the warning path is
    // testable — the RPC always passes nothing and gets the real `~/.infinibot`.
    const defaultStateDir = opts.defaultStateDir ?? join(homedir(), ".infinibot");
    const defaultDbPath = join(defaultStateDir, "android-ops.db");
    const isDefaultStateDir = dbPath === defaultDbPath;
    const defaultDeviceCount = isDefaultStateDir ? null : peekDeviceCount(defaultDbPath);
    let warning: string | null = null;
    if (!isDefaultStateDir && deviceCount === 0 && (defaultDeviceCount ?? 0) > 0) {
      warning =
        `This process is reading an empty Android Ops database at ${dbPath} ` +
        `(INFINIBOT_STATE_DIR=${stateDir}), but the default install at ${defaultDbPath} ` +
        `has ${defaultDeviceCount} device(s). The fleet is not gone — this process is pointed ` +
        `at the wrong state dir. Restart it without the override (or with INFINIBOT_STATE_DIR=${defaultStateDir}) ` +
        `to see the real fleet. No database was switched automatically.`;
    }
    return {
      stateDir,
      dbPath,
      deviceCount,
      defaultStateDir,
      defaultDbPath,
      isDefaultStateDir,
      defaultDeviceCount,
      warning,
    };
  }

  /**
   * Retire a handset. Archiving is the default and the safe one: the row stays,
   * so its jobs and audit trail remain readable. A hard delete is refused while
   * anything still points at the device — an operator has to move the accounts
   * off it first, which is the same decision they'd have to make physically.
   */
  removeDevice(
    id: string,
    actor: string,
    opts: { mode?: "archive" | "delete"; reason?: string } = {},
  ): { device: PhoneDevice | null; mode: "archive" | "delete"; assignedAccounts: number } {
    const device = this.store.getDevice(id);
    if (!device) throw new Error(`Unknown device ${id}`);
    const mode = opts.mode ?? "archive";
    const assigned = this.store.accountsOnDevice(id);

    if (mode === "delete") {
      if (assigned.length) {
        throw new Error(
          `${device.label} still holds ${assigned.length} account(s) (${assigned.map((a) => `@${a.handle}`).join(", ")}). ` +
            `Re-assign them first, or archive the handset instead.`,
        );
      }
      const openJobs = this.store
        .listJobs({
          states: ["SCHEDULED", "DISPATCHED", "PREPARED", "ACTION_REQUIRED"],
          limit: 2000,
        })
        .filter((j) => j.deviceId === id);
      if (openJobs.length) {
        throw new Error(
          `${device.label} has ${openJobs.length} job(s) still in flight. Let them finish or cancel them, then delete.`,
        );
      }
      this.store.deleteDevice(id);
      this.audit(
        actor,
        "device.delete",
        "device",
        id,
        `Deleted ${device.label} (${device.serial})${opts.reason ? ` — ${opts.reason}` : ""}.`,
      );
      return { device: null, mode, assignedAccounts: 0 };
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const next: PhoneDevice = {
      ...device,
      status: "maintenance",
      updateChannel: "held",
      adbState: "absent",
      scrcpyState: "unavailable",
      notes: `[archived ${stamp}] ${opts.reason ?? "retired from the rack"}${device.notes ? ` · ${device.notes}` : ""}`,
      updatedAt: Date.now(),
    };
    this.store.upsertDevice(next);
    this.audit(
      actor,
      "device.archive",
      "device",
      id,
      `Archived ${device.label}${opts.reason ? ` — ${opts.reason}` : ""}.` +
        (assigned.length
          ? ` ${assigned.length} account(s) are still assigned to it and cannot post until they move.`
          : ""),
      { assignedAccounts: assigned.map((a) => a.id) },
    );
    return { device: next, mode, assignedAccounts: assigned.length };
  }

  updateDevice(id: string, patch: Partial<PhoneDevice>, actor: string): PhoneDevice {
    assertNoSecretMaterial(patch);
    const device = this.store.getDevice(id);
    if (!device) throw new Error(`Unknown device ${id}`);
    const next = { ...device, ...patch, id: device.id, updatedAt: Date.now() };
    this.store.upsertDevice(next);
    this.audit(actor, "device.update", "device", id, `Updated ${device.label}.`, { patch });
    return next;
  }

  async openStream(deviceId: string, actor: string) {
    const device = this.store.getDevice(deviceId);
    if (!device) throw new Error(`Unknown device ${deviceId}`);
    const session = await this.adapters.stream.startSession(device.id, device.serial);
    if (session.ok) {
      this.store.upsertDevice({ ...device, scrcpyState: "streaming", updatedAt: Date.now() });
      this.audit(
        actor,
        "device.control",
        "device",
        deviceId,
        `Opened a remote control session on ${device.label}.`,
      );
    }
    return session;
  }

  async closeStream(sessionId: string, actor: string) {
    const result = await this.adapters.stream.stopSession(sessionId);
    if (result.ok)
      this.audit(
        actor,
        "device.control.stop",
        "system",
        sessionId,
        "Closed a remote control session.",
      );
    return result;
  }

  /**
   * Run the automatable part of a run's current step on its handset.
   *
   * The compliance seam is unchanged and enforced here rather than assumed: the
   * runner halts on a CAPTCHA, a verification challenge, a rate limit or a
   * block, and this method turns that halt into a blocked step, an ops alert and
   * a prompt for the operator. Nothing retries past a blocker, and no step whose
   * mode is "human" is ever driven — verification stays a person's job.
   */
  async automateRunStep(
    runId: string,
    actor: string,
  ): Promise<{
    run: ProvisioningRun;
    outcome: AutomationOutcome;
  }> {
    const run = this.store.getProvisioning(runId);
    if (!run) throw new Error(`Unknown provisioning run ${runId}`);
    const device = run.deviceId ? this.store.getDevice(run.deviceId) : null;
    if (!device) throw new Error("This run has no handset assigned.");
    const step = run.steps.find((s) => s.status !== "done" && s.status !== "skipped");
    if (!step) throw new Error("Every step on this run is already cleared.");
    if (step.mode === "human") {
      throw new Error(
        `"${step.label}" is a human checkpoint — this system escalates verification rather than automating it.`,
      );
    }

    const account = this.store.getAccount(run.accountId);
    const serial = device.serial;
    const adapter = this.adapters.device;
    const run1 = async (
      command: Parameters<typeof adapter.runCommand>[1]["command"],
      args?: Record<string, string | number | boolean>,
    ) => {
      const res = await adapter.runCommand(serial, { command, args, timeoutMs: 30_000 });
      if (!res.ok) throw new Error(`${command} failed: ${res.reason ?? res.stderr}`);
      return res.stdout;
    };
    const driver: AutomationDriver = {
      dump: () => run1("ui.dump"),
      tap: async (x, y) => {
        await run1("ui.tap", { x, y });
      },
      type: async (text) => {
        await run1("ui.text", { text });
      },
      key: async (keyevent) => {
        await run1("ui.keyevent", { keyevent });
      },
      launch: async (pkg) => {
        await run1("app.launch", { package: pkg });
      },
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    };

    const outcome = await automateStep(step.key, driver, {
      platform: run.platform,
      handle: run.handle,
      displayName: account?.displayName ?? null,
      bio: account?.bio ?? null,
      recoveryEmail: account?.recoveryEmail ?? null,
      password: null,
    });

    let next = run;
    if (outcome.status === "advanced") {
      next = this.advanceProvisioningStep(runId, { stepKey: step.key, status: "done", actor });
    } else if (outcome.status === "blocked") {
      next = this.advanceProvisioningStep(runId, {
        stepKey: step.key,
        status: "blocked",
        note: `${outcome.blocker.kind}: ${outcome.blocker.evidence}`,
        actor,
      });
      this.store.raiseAlert({
        at: Date.now(),
        severity: outcome.blocker.kind === "account_blocked" ? "critical" : "warning",
        kind: `automation_${outcome.blocker.kind}`,
        /* OpsAlert has no provisioning subject, and the operator thinks in
           accounts anyway — "@handle is stuck" is the actionable framing */
        subjectType: "account",
        subjectId: run.accountId,
        message: `@${run.handle} on ${device.label}: ${outcome.blocker.ask} (screen said: "${outcome.blocker.evidence}")`,
        acknowledgedAt: null,
        acknowledgedBy: null,
      });
    } else {
      this.audit(
        actor,
        "provisioning.automation",
        "provisioning",
        runId,
        `Automation stopped on "${step.label}": ${outcome.reason}`,
      );
    }
    return { run: next, outcome };
  }

  /**
   * Let a model drive the step, one screen at a time.
   *
   * The scripted runner knows one path; real flows branch. This reads the live
   * screen, asks Claude for a single next action, executes it, and reads again —
   * so an unexpected interstitial is something it can reason about rather than
   * stop at. When it cannot make progress it is asked to say why, which is the
   * troubleshooting output the operator actually needs.
   *
   * The model is consulted INSIDE guardrails, never instead of them:
   *   - detectBlocker() runs first each turn, so a CAPTCHA, verification prompt
   *     or platform block halts regardless of what the model would choose.
   *   - parseAction() rejects anything outside the action vocabulary.
   *   - The password is never in the prompt; type_password substitutes it here.
   *   - A "human" step is refused before the loop starts.
   */
  async aiDriveRunStep(
    runId: string,
    actor: string,
    opts: { maxTurns?: number; ask?: (prompt: string) => Promise<string> } = {},
  ): Promise<{ run: ProvisioningRun; status: string; note: string; transcript: string[] }> {
    const run = this.store.getProvisioning(runId);
    if (!run) throw new Error(`Unknown provisioning run ${runId}`);
    const device = run.deviceId ? this.store.getDevice(run.deviceId) : null;
    if (!device) throw new Error("This run has no handset assigned.");
    const step = run.steps.find((s) => s.status !== "done" && s.status !== "skipped");
    if (!step) throw new Error("Every step on this run is already cleared.");
    if (step.mode === "human") {
      throw new Error(
        `"${step.label}" is a human checkpoint — this system escalates verification rather than automating it.`,
      );
    }
    const ask = opts.ask ?? askClaude;
    const account = this.store.getAccount(run.accountId);
    const adapter = this.adapters.device;
    const serial = device.serial;
    const transcript: string[] = [];
    const history: string[] = [];

    const cmd = async (
      command: AllowedCommand,
      args?: Record<string, string | number | boolean>,
    ) => {
      const res = await adapter.runCommand(serial, { command, args, timeoutMs: 30_000 });
      if (!res.ok) throw new Error(`${command} failed: ${res.reason ?? res.stderr}`);
      return res.stdout;
    };
    const readScreen = async () => parseHierarchy(await cmd("ui.dump"));
    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

    /* the app has to be in front for any of this to mean anything */
    const pkg = PLATFORM_PACKAGES[run.platform];
    if (pkg) {
      await cmd("app.launch", { package: pkg });
      transcript.push(`launch ${pkg}`);
      await settle(2600);
    }

    const maxTurns = Math.max(1, Math.min(opts.maxTurns ?? 8, 20));
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      let nodes = await readScreen();

      const blocker = detectBlocker(nodes);
      if (blocker) {
        transcript.push(`halt ${blocker.kind}: ${blocker.evidence}`);
        const blocked = this.advanceProvisioningStep(runId, {
          stepKey: step.key,
          status: "blocked",
          note: `${blocker.kind}: ${blocker.evidence}`,
          actor,
        });
        this.store.raiseAlert({
          at: Date.now(),
          severity: blocker.kind === "account_blocked" ? "critical" : "warning",
          kind: `automation_${blocker.kind}`,
          subjectType: "account",
          subjectId: run.accountId,
          message: `@${run.handle} on ${device.label}: ${blocker.ask} (screen said: "${blocker.evidence}")`,
          acknowledgedAt: null,
          acknowledgedBy: null,
        });
        return { run: blocked, status: "blocked", note: blocker.ask, transcript };
      }

      const gate = detectTermsGate(nodes);
      if (gate) {
        const point = centerOf(gate.control);
        await cmd("ui.tap", { x: point.x, y: point.y });
        transcript.push(`accept "${gate.control.text.trim()}" on: ${gate.evidence}`);
        await settle(1400);
        nodes = await readScreen();
      }

      const decision = parseAction(
        await ask(
          buildPrompt(
            {
              goal: step.label,
              platform: run.platform,
              handle: run.handle,
              displayName: account?.displayName ?? null,
              bio: account?.bio ?? null,
              recoveryEmail: account?.recoveryEmail ?? null,
              history,
            },
            nodes,
          ),
        ),
      );

      if (decision.action === "invalid") {
        transcript.push(`ai returned an unusable action: ${decision.why}`);
        history.push(`invalid reply: ${decision.why}`);
        continue;
      }
      if (decision.action === "done") {
        transcript.push(`ai: done — ${decision.why}`);
        const advanced = this.advanceProvisioningStep(runId, {
          stepKey: step.key,
          status: "done",
          actor,
        });
        return {
          run: advanced,
          status: "advanced",
          note: decision.why || "Step complete.",
          transcript,
        };
      }
      if (decision.action === "stuck") {
        transcript.push(`ai: stuck — ${decision.why}`);
        this.audit(
          actor,
          "provisioning.automation",
          "provisioning",
          runId,
          `AI stopped on "${step.label}": ${decision.why}`,
        );
        return { run, status: "needs_operator", note: decision.why, transcript };
      }

      const applied = await this.applyAiAction(decision, nodes, cmd, account?.secretRef ?? null);
      transcript.push(applied.line);
      history.push(applied.line);
      await settle(1200);
    }

    const note = `Ran ${maxTurns} turns without finishing "${step.label}". The transcript shows what it tried.`;
    this.audit(actor, "provisioning.automation", "provisioning", runId, note);
    return { run, status: "needs_operator", note, transcript };
  }

  /** Execute one model-chosen action, resolving labels to real tap targets. */
  private async applyAiAction(
    decision: Exclude<AiAction, { action: "done" } | { action: "stuck" }>,
    nodes: UiNode[],
    cmd: (
      command: AllowedCommand,
      args?: Record<string, string | number | boolean>,
    ) => Promise<string>,
    secretRef: string | null,
  ): Promise<{ line: string }> {
    if (decision.action === "key") {
      await cmd("ui.keyevent", { keyevent: decision.keyevent });
      return { line: `key ${decision.keyevent} — ${decision.why}` };
    }
    if (decision.action === "scroll") {
      const down = decision.direction === "down";
      await cmd("ui.swipe", {
        x1: 360,
        y1: down ? 1100 : 500,
        x2: 360,
        y2: down ? 500 : 1100,
        durationMs: 300,
      });
      return { line: `scroll ${decision.direction} — ${decision.why}` };
    }
    const target = findTapTarget(nodes, { label: decision.label });
    if (!target) return { line: `could not find "${decision.label}" on screen` };
    const point = centerOf(target);
    if (decision.action === "tap") {
      await cmd("ui.tap", { x: point.x, y: point.y });
      return { line: `tap "${decision.label}" — ${decision.why}` };
    }
    await cmd("ui.tap", { x: point.x, y: point.y });
    if (decision.action === "type_password") {
      if (!secretRef) return { line: `no password is vaulted for this account` };
      const secret = revealSecret(this.store.stateDir, secretRef);
      if (!secret) return { line: `nothing is stored at ${secretRef}` };
      await cmd("ui.text", { text: secret });
      /* the value is never echoed into the transcript or the audit */
      return { line: `typed the vaulted password into "${decision.label}"` };
    }
    await cmd("ui.text", { text: decision.text });
    return { line: `type "${decision.text}" into "${decision.label}" — ${decision.why}` };
  }

  async agentControlDevice(
    input: DeviceAgentControlInput,
    actor: string,
  ): Promise<DeviceAgentControlResult> {
    const deviceId = (input.deviceId ?? "").trim();
    if (!deviceId) throw new Error("deviceId is required.");
    const device = this.store.getDevice(deviceId);
    if (!device) throw new Error(`Unknown device ${deviceId}`);
    const action = input.action;
    let result: unknown;
    let ok = false;
    let reason: string | null = null;
    let meta: Record<string, unknown> = { action };

    if (action === "adb_connect") {
      result = await this.adapters.device.connect(device.serial);
      ok = Boolean((result as { ok?: boolean }).ok);
      reason = ((result as { reason?: string | null }).reason ?? null) as string | null;
      meta = { ...meta, serial: device.serial };
    } else if (action === "adb_pair") {
      const pairHostPort = (input.pairHostPort ?? "").trim();
      const pairingCode = (input.pairingCode ?? "").trim();
      if (!pairHostPort || !/^[A-Za-z0-9._:-]{3,128}$/.test(pairHostPort)) {
        throw new Error(
          "pairHostPort must be the Wireless debugging pairing address, for example 100.x.x.x:37123.",
        );
      }
      if (!pairingCode || !/^[0-9]{6,12}$/.test(pairingCode)) {
        throw new Error(
          "pairingCode must be the numeric code shown by Android Wireless debugging.",
        );
      }
      result = await this.adapters.device.pair(pairHostPort, pairingCode);
      ok = Boolean((result as { ok?: boolean }).ok);
      reason = ((result as { reason?: string | null }).reason ?? null) as string | null;
      meta = { ...meta, pairHostPort };
    } else if (action === "screenshot") {
      if (device.serial.includes(":")) await this.adapters.device.connect(device.serial);
      const label = (input.label ?? `agent-${device.id}`).replace(/[^a-zA-Z0-9._-]/g, "_");
      result = await this.adapters.device.captureScreenshot(device.serial, label);
      ok = Boolean((result as { ok?: boolean }).ok);
      reason = ((result as { reason?: string | null }).reason ?? null) as string | null;
      meta = { ...meta, label, path: (result as { path?: string | null }).path ?? null };
    } else if (action === "logs") {
      if (device.serial.includes(":")) await this.adapters.device.connect(device.serial);
      const sinceMs = Math.min(
        3_600_000,
        Math.max(30_000, finiteNumber(input.sinceMs ?? 120_000, "sinceMs")),
      );
      result = await this.adapters.device.pullLogs(device.serial, sinceMs);
      ok = Boolean((result as { ok?: boolean }).ok);
      reason = ((result as { reason?: string | null }).reason ?? null) as string | null;
      meta = {
        ...meta,
        sinceMs,
        bundleRef: (result as { bundleRef?: string | null }).bundleRef ?? null,
        entries: Array.isArray((result as { entries?: unknown }).entries)
          ? (result as { entries: unknown[] }).entries.length
          : 0,
      };
    } else if (action === "open_stream") {
      if (device.serial.includes(":")) await this.adapters.device.connect(device.serial);
      result = await this.openStream(device.id, actor);
      ok = Boolean((result as { ok?: boolean }).ok);
      reason = ((result as { reason?: string | null }).reason ?? null) as string | null;
      meta = { ...meta, sessionId: (result as { sessionId?: string | null }).sessionId ?? null };
    } else if (action === "close_stream") {
      const sessionId = (input.sessionId ?? "").trim();
      if (!sessionId) throw new Error("sessionId is required for close_stream.");
      result = await this.closeStream(sessionId, actor);
      ok = Boolean((result as { ok?: boolean }).ok);
      reason = ((result as { reason?: string | null }).reason ?? null) as string | null;
      meta = { ...meta, sessionId };
    } else if (AGENT_EXTENDED_ACTIONS.has(action)) {
      if (device.serial.includes(":")) await this.adapters.device.connect(device.serial);
      const outcome = await this.agentExtendedAction(device, action, input);
      result = outcome.result;
      ok = outcome.ok;
      reason = outcome.reason;
      meta = { ...meta, ...outcome.meta };
    } else {
      if (device.serial.includes(":")) await this.adapters.device.connect(device.serial);
      let cmd: DeviceCommand;
      if (action === "launch") {
        const packageName = (input.package ?? "").trim();
        if (!packageName || !SAFE_PACKAGE.test(packageName)) {
          throw new Error(
            "package must be an Android package id, for example com.instagram.android.",
          );
        }
        cmd = { command: "app.launch", args: { package: packageName }, timeoutMs: 20_000 };
        meta = { ...meta, package: packageName };
      } else if (action === "tap") {
        const x = boundedCoord(input.x, "x");
        const y = boundedCoord(input.y, "y");
        cmd = { command: "ui.tap", args: { x, y }, timeoutMs: 10_000 };
        meta = { ...meta, x, y };
      } else if (action === "swipe") {
        const x1 = boundedCoord(input.x1, "x1");
        const y1 = boundedCoord(input.y1, "y1");
        const x2 = boundedCoord(input.x2, "x2");
        const y2 = boundedCoord(input.y2, "y2");
        const durationMs = boundedDuration(input.durationMs);
        cmd = { command: "ui.swipe", args: { x1, y1, x2, y2, durationMs }, timeoutMs: 15_000 };
        meta = { ...meta, x1, y1, x2, y2, durationMs };
      } else if (action === "text") {
        const text = safeTextInput(input.text);
        cmd = { command: "ui.text", args: { text }, timeoutMs: 10_000 };
        meta = { ...meta, textLength: text.length };
      } else if (action === "keyevent") {
        const keyevent = (input.keyevent ?? "").trim().toUpperCase();
        if (!SAFE_KEYEVENT.test(keyevent)) {
          throw new Error("keyevent must be a numeric Android keycode or KEYCODE_* value.");
        }
        cmd = { command: "ui.keyevent", args: { keyevent }, timeoutMs: 10_000 };
        meta = { ...meta, keyevent };
      } else {
        throw new Error(`Unsupported device control action: ${String(action)}`);
      }
      result = await this.adapters.device.runCommand(device.serial, cmd);
      ok = Boolean((result as { ok?: boolean }).ok);
      reason = ((result as { reason?: string | null }).reason ?? null) as string | null;
      meta = {
        ...meta,
        command: cmd.command,
        durationMs: (result as { durationMs?: number }).durationMs ?? null,
      };
    }

    this.audit(
      actor,
      `device.agent_control.${action}`,
      "device",
      device.id,
      `${ok ? "Ran" : "Attempted"} ${action} on ${device.label}.`,
      { ...meta, ok, reason },
    );

    return {
      ok,
      action,
      deviceId: device.id,
      label: device.label,
      serial: device.serial,
      result,
      reason,
    };
  }

  /** One uiautomator read of the screen, parsed. */
  private async readScreen(
    serial: string,
  ): Promise<{ ok: true; nodes: UiNode[] } | { ok: false; reason: string }> {
    const res = await this.adapters.device.runCommand(serial, {
      command: "ui.dump",
      timeoutMs: 30_000,
    });
    if (!res.ok) return { ok: false, reason: res.reason ?? (res.stderr || "ui.dump failed") };
    const nodes = parseHierarchy(res.stdout);
    if (!nodes.length) {
      return {
        ok: false,
        reason:
          "uiautomator returned no hierarchy — the screen is locked, a secure window is up, or the dump failed.",
      };
    }
    return { ok: true, nodes };
  }

  /**
   * Agent-only device actions: read the screen, act on a named element, and
   * the app/device reads an operator gets by looking at the phone. Every one
   * dispatches through the command allow-list; the caller audits.
   */
  private async agentExtendedAction(
    device: PhoneDevice,
    action: DeviceAgentControlAction,
    input: DeviceAgentControlInput,
  ): Promise<{
    ok: boolean;
    reason: string | null;
    result: unknown;
    meta: Record<string, unknown>;
  }> {
    const adapter = this.adapters.device;
    const serial = device.serial;
    const fail = (reason: string, result: unknown = null, meta: Record<string, unknown> = {}) => ({
      ok: false,
      reason,
      result,
      meta,
    });
    const run = (
      command: AllowedCommand,
      args?: Record<string, string | number | boolean>,
      timeoutMs = 20_000,
    ) => adapter.runCommand(serial, { command, args, timeoutMs });
    const pkgOf = () => {
      const packageName = (input.package ?? "").trim();
      if (!packageName || !SAFE_PACKAGE.test(packageName)) {
        throw new Error(
          "package must be an Android package id, for example com.instagram.android.",
        );
      }
      return packageName;
    };

    if (action === "ui_dump") {
      const screen = await this.readScreen(serial);
      if (!screen.ok) return fail(screen.reason);
      const compact = compactHierarchy(screen.nodes, {
        all: input.all === true,
        limit: input.limit,
      });
      const blocker = detectBlocker(screen.nodes);
      return {
        ok: true,
        reason: null,
        result: {
          foreground: screen.nodes.find((n) => n.packageName)?.packageName || null,
          ...compact,
          blocker,
        },
        meta: {
          elements: compact.elements.length,
          totalNodes: compact.totalNodes,
          blocker: blocker?.kind ?? null,
        },
      };
    }

    if (action === "find_and_tap") {
      const selector = selectorFrom(input.selector ?? {});
      const screen = await this.readScreen(serial);
      if (!screen.ok) return fail(screen.reason, null, { selector });
      /* The same stop condition the scripted runner honours: a CAPTCHA, a
         verification challenge or a block is a human checkpoint, never a
         target. */
      const blocker = detectBlocker(screen.nodes);
      if (blocker) {
        return fail(
          `Human checkpoint on screen (${blocker.kind}): ${blocker.ask}`,
          { blocker },
          { selector, blocker: blocker.kind },
        );
      }
      const hit = locate(screen.nodes, selector);
      if (!hit) {
        const visible = compactHierarchy(screen.nodes, { limit: 40 }).elements.filter(
          (e) => e.text || e.desc,
        );
        return fail("No element on screen matches that selector.", { visible }, { selector });
      }
      const tap = await run("ui.tap", { x: hit.tap.x, y: hit.tap.y }, 10_000);
      return {
        ok: tap.ok,
        reason: tap.ok ? null : tap.reason,
        result: { element: hit.element, tapped: hit.tap },
        meta: { selector, x: hit.tap.x, y: hit.tap.y },
      };
    }

    if (action === "wait_for") {
      const selector = selectorFrom(input.selector ?? {});
      const timeoutMs = Math.max(
        500,
        Math.min(60_000, Number(input.timeoutMs ?? 10_000) || 10_000),
      );
      const gone = input.gone === true;
      const started = Date.now();
      let attempts = 0;
      let lastReason: string | null = null;
      for (;;) {
        attempts += 1;
        const screen = await this.readScreen(serial);
        if (screen.ok) {
          const hit = locate(screen.nodes, selector);
          if (gone ? !hit : hit) {
            return {
              ok: true,
              reason: null,
              result: {
                matched: !gone,
                element: hit?.element ?? null,
                attempts,
                elapsedMs: Date.now() - started,
              },
              meta: { selector, gone, attempts, elapsedMs: Date.now() - started },
            };
          }
          lastReason = null;
        } else {
          lastReason = screen.reason;
        }
        if (Date.now() - started >= timeoutMs) break;
        await new Promise((r) =>
          setTimeout(r, Math.min(750, Math.max(0, timeoutMs - (Date.now() - started)))),
        );
      }
      return fail(
        `Timed out after ${timeoutMs} ms waiting for the element to ${gone ? "disappear" : "appear"}.` +
          (lastReason ? ` Last read failed: ${lastReason}` : ""),
        { attempts, elapsedMs: Date.now() - started },
        { selector, gone, attempts, timeoutMs },
      );
    }

    if (action === "stop") {
      const packageName = pkgOf();
      const res = await run("app.stop", { package: packageName });
      return {
        ok: res.ok,
        reason: res.reason,
        result: { package: packageName },
        meta: { package: packageName },
      };
    }

    if (action === "uninstall") {
      const packageName = pkgOf();
      const res = await run("app.uninstall", { package: packageName }, 60_000);
      const ok = res.ok && /success/i.test(res.stdout);
      return {
        ok,
        reason: ok
          ? null
          : (res.reason ??
            (`${res.stdout} ${res.stderr}`.trim().slice(0, 300) ||
              "uninstall did not report Success")),
        result: { package: packageName, output: `${res.stdout}`.trim().slice(0, 300) },
        meta: { package: packageName },
      };
    }

    if (action === "install") {
      const apkPath = (input.apkPath ?? "").trim();
      if (!apkPath || !isAbsolute(apkPath) || !apkPath.toLowerCase().endsWith(".apk")) {
        throw new Error("apkPath must be an absolute path to an .apk file on this host.");
      }
      if (!existsSync(apkPath) || !statSync(apkPath).isFile()) {
        throw new Error(`No APK at ${apkPath}.`);
      }
      const sizeBytes = statSync(apkPath).size;
      const res = await run("app.install", { apk: apkPath }, 180_000);
      const ok = res.ok && /success/i.test(res.stdout);
      return {
        ok,
        reason: ok
          ? null
          : (res.reason ??
            (`${res.stdout} ${res.stderr}`.trim().slice(0, 300) ||
              "install did not report Success")),
        result: { apkPath, sizeBytes, output: `${res.stdout}`.trim().slice(0, 300) },
        meta: { apkPath, sizeBytes },
      };
    }

    if (action === "current_app") {
      const res = await run("app.current");
      if (!res.ok) return fail(res.reason ?? "dumpsys failed");
      const current = parseCurrentApp(res.stdout);
      return {
        ok: Boolean(current),
        reason: current ? null : "Could not read the foreground activity.",
        result: current,
        meta: { package: current?.package ?? null },
      };
    }

    if (action === "screen_state") {
      const res = await run("device.screen", undefined, 15_000);
      if (!res.ok) return fail(res.reason ?? "dumpsys failed");
      const screen = parseScreenState(res.stdout);
      return { ok: true, reason: null, result: screen, meta: { ...screen } };
    }

    if (action === "list_apps") {
      const res = await run("app.list");
      if (!res.ok) return fail(res.reason ?? "pm list failed");
      const packages = parsePackages(res.stdout);
      return { ok: true, reason: null, result: { packages }, meta: { count: packages.length } };
    }

    if (action === "device_info") {
      const props = await run("device.props");
      if (!props.ok) return fail(props.reason ?? "getprop failed");
      const health = await adapter.readHealth(serial);
      const net = await run("health.network");
      return {
        ok: true,
        reason: null,
        result: {
          props: parseDeviceProps(props.stdout),
          battery: { pct: health.batteryPct, charging: health.charging },
          storage: { freeMb: health.storageFreeMb, totalMb: health.storageTotalMb },
          wifi: { ssid: health.wifiSsid, signalDbm: health.wifiSignalDbm },
          network: net.ok ? parseNetwork(net.stdout) : [],
          status: health.status,
          tailscaleIp: device.tailscaleIp ?? null,
        },
        meta: { batteryPct: health.batteryPct },
      };
    }

    if (action === "push_media") {
      const mediaId = (input.mediaId ?? "").trim();
      if (!mediaId) throw new Error("mediaId is required for push_media.");
      const asset = this.store.getMedia(mediaId);
      if (!asset) throw new Error(`Unknown media asset ${mediaId}`);
      const src = this.adapters.storage.localPath?.(asset.storageKey) ?? null;
      if (!src || !existsSync(src)) {
        return fail(
          `The media file for "${asset.title}" is not on this host's local library (backend ${this.adapters.storage.backend}).`,
          null,
          { mediaId },
        );
      }
      const dest = (
        input.dest ?? (asset.kind === "video" ? "/sdcard/Movies/" : "/sdcard/Pictures/")
      ).trim();
      if (!/^\/sdcard\/[A-Za-z0-9._/-]*$/.test(dest) || dest.includes("..")) {
        throw new Error("dest must be a directory under /sdcard/, e.g. /sdcard/Movies/.");
      }
      const destName = (input.destName ?? "").trim();
      if (destName && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(destName)) {
        throw new Error("destName must be a plain file name ([A-Za-z0-9._-]).");
      }
      /* adb push creates missing directories; a full target path names the copy. */
      const target = destName ? `${dest.endsWith("/") ? dest : `${dest}/`}${destName}` : dest;
      const res = await run("media.push", { src, dest: target }, 180_000);
      return {
        ok: res.ok,
        reason: res.reason,
        result: { mediaId, title: asset.title, dest, devicePath: destName ? target : null },
        meta: { mediaId, dest: target },
      };
    }

    if (action === "ime_state") {
      const res = await run("device.ime", {}, 10_000);
      const m = /mInputShown=(true|false)/.exec(res.stdout ?? "");
      return {
        ok: Boolean(m),
        reason: m ? null : (res.reason ?? "keyboard state unreadable"),
        result: { shown: m ? m[1] === "true" : null },
        meta: { shown: m ? m[1] === "true" : null },
      };
    }

    if (action === "media_index") {
      /* Index a pushed file in MediaStore and report what the phone holds:
         exact bytes on disk (stat) + the MediaStore row (id, size, duration).
         The scanner is asynchronous — poll a few times for the metadata. */
      const devicePath = deviceMediaPath(input.devicePath);
      const stat = await run("media.stat", { path: devicePath }, 15_000);
      const bytes =
        stat.ok && /^\d+\s*$/.test(stat.stdout ?? "") ? Number(stat.stdout.trim()) : null;
      if (bytes === null) {
        return fail(
          `${devicePath} is not on the phone (stat failed: ${stat.reason ?? (stat.stdout || "no output").trim().slice(0, 120)})`,
          { devicePath },
        );
      }
      await run("media.scan", { path: devicePath }, 20_000);
      let row: ReturnType<typeof parseMediaRow> = null;
      for (let i = 0; i < 8; i++) {
        const q = await run("media.query", { path: devicePath }, 15_000);
        row = q.ok ? parseMediaRow(q.stdout ?? "") : null;
        if (row && row.size !== null && row.durationMs !== null) break;
        await new Promise((r) => setTimeout(r, 750));
      }
      const result = {
        devicePath,
        bytes,
        indexed: row !== null,
        mediaStoreId: row?.id ?? null,
        uri: row ? `content://media/external/video/media/${row.id}` : null,
        size: row?.size ?? null,
        durationMs: row?.durationMs ?? null,
      };
      return {
        ok: row !== null,
        reason: row ? null : `MediaStore did not index ${devicePath} (media scanner)`,
        result,
        meta: { devicePath, bytes, mediaStoreId: result.mediaStoreId },
      };
    }

    if (action === "media_remove") {
      /* Delete a pushed file and drop its MediaStore row (a scan of a path
         that no longer exists removes the row). */
      const devicePath = deviceMediaPath(input.devicePath);
      const rm = await run("media.cleanup", { path: devicePath }, 15_000);
      await run("media.scan", { path: devicePath }, 20_000);
      const stat = await run("media.stat", { path: devicePath }, 15_000);
      const gone = !(stat.ok && /^\d+\s*$/.test(stat.stdout ?? ""));
      let row: ReturnType<typeof parseMediaRow> = null;
      for (let i = 0; i < 4; i++) {
        const q = await run("media.query", { path: devicePath }, 15_000);
        row = q.ok ? parseMediaRow(q.stdout ?? "") : null;
        if (!row) break;
        await new Promise((r) => setTimeout(r, 600));
      }
      const ok = rm.ok && gone;
      return {
        ok,
        reason: ok ? null : (rm.reason ?? `${devicePath} is still on the phone`),
        result: { devicePath, deleted: gone, mediaStoreRowLeft: row !== null },
        meta: { devicePath, deleted: gone },
      };
    }

    if (action === "share_media") {
      /* Opens the target app's share/compose screen with a file that is
         already on the handset (push_media first). It does NOT publish: the
         caller still has to fill the caption and press the app's own Share /
         Post button as a separate, audited tap. */
      const devicePath = (input.devicePath ?? "").trim();
      if (!/^\/sdcard\/[A-Za-z0-9._/-]+$/.test(devicePath) || devicePath.includes("..")) {
        throw new Error("devicePath must be a file under /sdcard/, e.g. /sdcard/Movies/clip.mp4.");
      }
      const packageName = (input.package ?? "").trim();
      if (!packageName || !SAFE_PACKAGE.test(packageName)) {
        throw new Error(
          "package must be an Android package id, for example com.instagram.android.",
        );
      }
      const component = (input.component ?? "").trim();
      if (
        component &&
        !new RegExp(`^${packageName.replace(/\./g, "\\.")}/[A-Za-z0-9_.$]+$`).test(component)
      ) {
        throw new Error("component must be <package>/<activity> inside the same package.");
      }
      const mime = (input.mime ?? "video/mp4").trim();
      if (!/^(video|image)\/[a-z0-9.+*-]+$/i.test(mime)) {
        throw new Error("mime must be a video/* or image/* type.");
      }
      const given = (input.contentUri ?? "").trim();
      if (given && !/^content:\/\/media\/external\/(video|images)\/media\/\d+$/.test(given)) {
        throw new Error(
          "contentUri must be a content://media/external/(video|images)/media/<id> uri.",
        );
      }
      let uri: string | null = given || null;
      let scanned = false;
      if (!uri) {
        scanned = (await run("media.scan", { path: devicePath }, 20_000)).ok;
        /* The scanner is asynchronous; give it a few short tries. */
        for (let i = 0; i < 8 && !uri; i++) {
          const q = await run("media.query", { path: devicePath }, 15_000);
          const row = q.ok ? parseMediaRow(q.stdout ?? "") : null;
          if (row)
            uri = `content://media/external/${mime.startsWith("image/") ? "images" : "video"}/media/${row.id}`;
          else if (i < 7) await new Promise((r) => setTimeout(r, 600));
        }
      }
      /* No file:// fallback: Android 7+ apps cannot open a file:// share
         (FileUriExposed / scoped storage) — Instagram just never showed its
         composer. Fail here with the real reason instead. */
      if (!uri) {
        return fail(
          `MediaStore has no entry for ${devicePath} — the media scanner did not index it, so the app cannot be handed the file`,
          { devicePath, scanned },
          { devicePath, package: packageName },
        );
      }
      const share = await run(
        "post.share",
        { uri, mime, package: packageName, ...(component ? { component } : {}) },
        20_000,
      );
      /* `am start` exits 0 even when it prints "Error: Activity class … does
         not exist" — read its output, not just the exit code. */
      const amOut = `${share.stdout ?? ""}\n${share.stderr ?? ""}`;
      const amError =
        /^Error: [^\n]*/m.exec(amOut)?.[0] ??
        /^(Error|Exception|java\.)[^\n]*/m.exec(amOut)?.[0] ??
        null;
      const ok = share.ok && !amError;
      return {
        ok,
        reason: ok ? null : (amError ?? share.reason),
        result: {
          devicePath,
          uri,
          via: "content",
          scanned,
          package: packageName,
          component: component || null,
        },
        meta: { devicePath, package: packageName, component: component || null, via: "content" },
      };
    }

    throw new Error(`Unsupported device control action: ${String(action)}`);
  }

  // ── Accounts ───────────────────────────────────────────────────────────────

  /** Every account, projected so no credential value can ride along. */
  listAccountsPublic(): PublicSocialAccount[] {
    return this.store.listAccounts().map(toPublicAccount);
  }

  /**
   * Import a roster. Idempotent on `(platform, handle)`, so re-running a
   * corrected sheet updates rather than duplicates.
   *
   * A row carrying an actual password / TOTP seed / recovery code is rejected
   * outright rather than stripped: the operator has to put it in the vault and
   * pass the `vault://` pointer, which is the only way the recovery path in §5
   * stays real. One bad row does not abort the import — it is returned in
   * `rejected` with the reason.
   */
  importAccounts(
    entries: AccountImportEntry[],
    actor: string,
    opts: { autoAssign?: boolean } = {},
  ): AccountImportResult {
    const result: AccountImportResult = { created: [], updated: [], rejected: [], unassigned: [] };
    if (!Array.isArray(entries) || !entries.length) {
      throw new Error("Provide at least one account to import.");
    }

    for (const entry of entries) {
      const handle = String(entry?.handle ?? "").trim();
      try {
        const platform = String(entry?.platform ?? "")
          .trim()
          .toLowerCase();
        const existing = handle
          ? this.store.getAccountByHandle(platform, handle.replace(/^@/, ""))
          : null;
        const { account, autoAssign } = normalizeAccountImport(entry, { existing });

        const now = Date.now();
        let deviceId = account.deviceId;
        if (deviceId && !this.store.getDevice(deviceId)) {
          throw new Error(`Unknown device ${deviceId}.`);
        }
        if (!deviceId && (autoAssign || opts.autoAssign)) {
          const pick = pickLeastLoadedDevice(
            this.store.listDevices(),
            this.store.listAccounts().filter((a) => a.id !== account.id),
            this.store.listJobs({ limit: 2000 }),
          );
          // An unprobed or full rack is not an import failure — the account
          // lands unassigned and the caller is told exactly why.
          deviceId = pick.device?.id ?? null;
          if (!deviceId) {
            result.unassigned.push({
              handle: account.handle,
              platform: account.platform,
              reason: pick.reason,
            });
          }
        }

        const row: SocialAccount = {
          ...account,
          deviceId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        this.store.upsertAccount(row);
        (existing ? result.updated : result.created).push(toPublicAccount(row));
        this.audit(
          actor,
          existing ? "account.import.update" : "account.import",
          "account",
          row.id,
          `${existing ? "Updated" : "Imported"} @${row.handle} (${row.platform})` +
            (deviceId
              ? ` on ${this.store.getDevice(deviceId)?.label}.`
              : " — no handset assigned yet."),
        );
      } catch (e) {
        result.rejected.push({
          handle: handle || "(missing handle)",
          platform: String(entry?.platform ?? ""),
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    this.audit(
      actor,
      "account.import.batch",
      "system",
      "accounts",
      `Imported ${result.created.length} new and updated ${result.updated.length} account(s); ` +
        `${result.rejected.length} rejected, ${result.unassigned.length} awaiting a handset.`,
    );
    return result;
  }

  updateAccount(id: string, patch: Partial<SocialAccount>, actor: string): SocialAccount {
    assertNoSecretMaterial(patch);
    const account = this.store.getAccount(id);
    if (!account) throw new Error(`Unknown account ${id}`);
    // Secrets never travel through this API — only the vault reference does.
    const { secretRef: _ignored, ...safe } = patch as Partial<SocialAccount> & {
      secretRef?: string;
    };
    const next = { ...account, ...safe, id: account.id, updatedAt: Date.now() };
    this.store.upsertAccount(next);
    this.audit(actor, "account.update", "account", id, `Updated @${account.handle}.`, {
      patch: safe,
    });
    return next;
  }

  /**
   * Assign (or re-assign) an account to a handset. Assignments are meant to be
   * stable, so a move is audited loudly — it invalidates the trusted-device
   * signal the platform has built up for that account.
   */
  /**
   * Edit the profile the signup workflow types into the handset. Deliberately
   * separate from updateAccount(): that one moves lifecycle/health, this one is
   * content an operator authors. The password is NOT here — it never travels
   * through a payload that can be logged; see setAccountPassword().
   */
  /**
   * Rename an account. The handle is not decoration: it derives the vault
   * reference, so this moves the stored password to the new reference rather
   * than leaving it stranded under the old one. Needed because a platform
   * routinely refuses the handle you reserved and you take a variant — the
   * console has to be able to record what actually exists.
   */
  renameAccount(id: string, handle: string, actor: string): SocialAccount {
    const account = this.store.getAccount(id);
    if (!account) throw new Error(`Unknown account ${id}`);
    const next = handle.trim().replace(/^@/, "");
    if (!next) throw new Error("A username is required.");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(next)) {
      throw new Error("Usernames may use letters, numbers, dots, underscores and hyphens.");
    }
    if (next === account.handle) return account;
    const clash = this.store
      .listAccounts()
      .find(
        (a) =>
          a.id !== id &&
          a.platform === account.platform &&
          a.handle.toLowerCase() === next.toLowerCase(),
      );
    if (clash) throw new Error(`@${next} already exists on ${account.platform}.`);

    let secretRef = account.secretRef;
    if (secretRef) {
      const moved = vaultRef(account.platform, next);
      if (moveSecret(this.store.stateDir, secretRef, moved)) secretRef = moved;
    }
    const renamed: SocialAccount = { ...account, handle: next, secretRef, updatedAt: Date.now() };
    this.store.upsertAccount(renamed);
    this.audit(
      actor,
      "account.rename",
      "account",
      id,
      `@${account.handle} → @${next}` +
        (secretRef !== account.secretRef ? "; moved its vault entry to match." : "."),
    );
    return renamed;
  }

  editAccountProfile(
    id: string,
    patch: {
      handle?: string;
      displayName?: string;
      bio?: string | null;
      avatarRef?: string | null;
      recoveryEmail?: string;
    },
    actor: string,
  ): SocialAccount {
    // A rename re-keys the vault, so it runs through its own path first.
    if (patch.handle !== undefined) this.renameAccount(id, patch.handle, actor);
    const account = this.store.getAccount(id);
    if (!account) throw new Error(`Unknown account ${id}`);
    assertNoSecretMaterial({ ...account, ...patch } as never);
    const next: SocialAccount = {
      ...account,
      displayName: patch.displayName?.trim() || account.displayName,
      bio: patch.bio === undefined ? account.bio : patch.bio?.trim() || null,
      avatarRef:
        patch.avatarRef === undefined ? account.avatarRef : patch.avatarRef?.trim() || null,
      recoveryEmail: patch.recoveryEmail?.trim() ?? account.recoveryEmail,
      updatedAt: Date.now(),
    };
    this.store.upsertAccount(next);
    const changed = Object.keys(patch).filter(
      (k) => (patch as Record<string, unknown>)[k] !== undefined,
    );
    this.audit(
      actor,
      "account.profile",
      "account",
      id,
      `Edited ${changed.join(", ") || "nothing"} for @${account.handle}.`,
    );
    return next;
  }

  /**
   * Put a password in the vault and point the account at it. `value` is used
   * when an operator already created the account by hand; otherwise one is
   * generated. Either way only the reference is persisted, and the value is
   * never returned, audited or echoed.
   */
  setAccountPassword(id: string, value: string | null, actor: string): SocialAccount {
    const account = this.store.getAccount(id);
    if (!account) throw new Error(`Unknown account ${id}`);
    const ref = vaultRef(account.platform, account.handle);
    const secret = value && value.trim() ? value.trim() : generatePassword();
    if (secret.length < 8) throw new Error("That password is too short to be worth storing.");
    putSecret(this.store.stateDir, ref, secret);
    const next = { ...account, secretRef: ref, updatedAt: Date.now() };
    this.store.upsertAccount(next);
    this.audit(
      actor,
      "account.password",
      "account",
      id,
      `${value ? "Stored an operator-supplied" : "Generated a"} password for @${account.handle} at ${ref}. The value is not recorded here.`,
    );
    return next;
  }

  /**
   * Read a password back so an operator can type it into a handset. Audited
   * every time, because a credential leaving the vault is worth a trail.
   */
  revealAccountPassword(id: string, actor: string): { handle: string; secret: string } {
    const account = this.store.getAccount(id);
    if (!account) throw new Error(`Unknown account ${id}`);
    if (!account.secretRef) throw new Error(`No password is stored for @${account.handle}.`);
    const secret = revealSecret(this.store.stateDir, account.secretRef);
    if (!secret) throw new Error(`Nothing is stored at ${account.secretRef}.`);
    this.audit(
      actor,
      "account.password.reveal",
      "account",
      id,
      `Revealed the password for @${account.handle} to ${actor}.`,
    );
    return { handle: account.handle, secret };
  }

  /** Flip the two states an operator tracks by hand during signup. */
  setAccountStatus(
    id: string,
    patch: { signedUp?: boolean; loggedIn?: boolean },
    actor: string,
  ): SocialAccount {
    const account = this.store.getAccount(id);
    if (!account) throw new Error(`Unknown account ${id}`);
    const now = Date.now();
    const signedUpAt =
      patch.signedUp === undefined
        ? account.signedUpAt
        : patch.signedUp
          ? (account.signedUpAt ?? now)
          : null;
    // Logging in implies the account exists, so it carries signup with it.
    const loggedInAt =
      patch.loggedIn === undefined ? account.loggedInAt : patch.loggedIn ? now : null;
    const next: SocialAccount = {
      ...account,
      signedUpAt: patch.loggedIn ? (signedUpAt ?? now) : signedUpAt,
      loggedInAt,
      sessionHealth: loggedInAt
        ? "healthy"
        : account.sessionHealth === "healthy"
          ? "logged_out"
          : account.sessionHealth,
      lifecycle: loggedInAt ? "active" : account.lifecycle,
      updatedAt: now,
    };
    this.store.upsertAccount(next);
    this.audit(
      actor,
      "account.status",
      "account",
      id,
      `@${account.handle} → ${next.loggedInAt ? "logged in" : next.signedUpAt ? "signed up" : "not signed up"}.`,
    );
    return next;
  }

  assignAccount(
    accountId: string,
    deviceId: string | "auto",
    actor: string,
    opts: LoadOptions = {},
  ) {
    const account = this.store.getAccount(accountId);
    if (!account) throw new Error(`Unknown account ${accountId}`);

    // Unpairing was never expressible: "auto" picked a handset and anything else
    // had to resolve to one, so an account could be moved but never freed. The
    // roster offers "no phone", and this is what makes that selectable.
    if (deviceId === "none" || deviceId === "") {
      const previousLabel = account.deviceId
        ? (this.store.getDevice(account.deviceId)?.label ?? account.deviceId)
        : null;
      const freed = { ...account, deviceId: null, updatedAt: Date.now() };
      this.store.upsertAccount(freed);
      this.audit(
        actor,
        "account.assign",
        "account",
        account.id,
        previousLabel
          ? `Unpaired @${account.handle} from ${previousLabel}. It keeps no trusted-device history until it is paired again.`
          : `@${account.handle} was already unpaired.`,
        { previousDeviceId: account.deviceId, deviceId: null },
      );
      return {
        account: freed,
        device: null,
        reason: previousLabel ? `unpaired from ${previousLabel}` : "already unpaired",
      };
    }

    let target: PhoneDevice | null;
    let reason: string;
    if (deviceId === "auto") {
      const pick = pickLeastLoadedDevice(
        this.store.listDevices(),
        this.store.listAccounts().filter((a) => a.id !== accountId),
        this.store.listJobs({ limit: 2000 }),
        opts,
      );
      target = pick.device;
      reason = pick.reason;
      if (!target) throw new Error(reason);
    } else {
      target = this.store.getDevice(deviceId);
      if (!target) throw new Error(`Unknown device ${deviceId}`);
      reason = `manually assigned to ${target.label}`;
    }

    const previous = account.deviceId ? this.store.getDevice(account.deviceId)?.label : null;
    const next = { ...account, deviceId: target.id, updatedAt: Date.now() };
    this.store.upsertAccount(next);
    this.audit(
      actor,
      "account.assign",
      "account",
      accountId,
      previous && previous !== target.label
        ? `Moved @${account.handle} from ${previous} to ${target.label} — the trusted-device history on the old handset is lost.`
        : `Assigned @${account.handle} to ${target.label} (${reason}).`,
      { deviceId: target.id, previous },
    );
    return { account: next, device: target, reason };
  }

  deviceLoads(opts: LoadOptions = {}) {
    return computeLoads(
      this.store.listDevices(),
      this.store.listAccounts(),
      this.store.listJobs({ limit: 2000 }),
      opts,
    );
  }

  // ── Media ──────────────────────────────────────────────────────────────────

  async registerMedia(
    input: {
      title: string;
      kind: MediaAsset["kind"];
      storageKey?: string;
      caption?: string;
      hashtags?: string[];
      platforms?: Platform[];
      targetAccountIds?: string[];
      sizeBytes?: number;
      durationSec?: number | null;
      width?: number | null;
      height?: number | null;
      bytes?: Buffer;
    },
    actor: string,
  ): Promise<MediaAsset> {
    const now = Date.now();
    const id = `media-${randomUUID().slice(0, 8)}`;
    const key =
      input.storageKey?.trim() || `uploads/${id}-${input.title.replace(/[^a-zA-Z0-9._-]/g, "-")}`;

    let sizeBytes = input.sizeBytes ?? 0;
    let checksum: string | null = null;
    if (input.bytes) {
      const put = await this.adapters.storage.put(key, input.bytes);
      if (!put.ok) throw new Error(put.reason ?? "storage write failed");
      sizeBytes = put.sizeBytes;
      checksum = put.checksum;
    }

    const asset: MediaAsset = {
      id,
      title: input.title,
      kind: input.kind,
      storageKey: key,
      storageBackend: this.adapters.storage.backend,
      sizeBytes,
      durationSec: input.durationSec ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      caption: input.caption ?? "",
      hashtags: input.hashtags ?? [],
      platforms: input.platforms ?? [],
      targetAccountIds: input.targetAccountIds ?? [],
      checksum,
      posterUrl: await this.adapters.storage.resolveUrl(key),
      createdAt: now,
      updatedAt: now,
    };
    this.store.upsertMedia(asset);
    this.audit(
      actor,
      "media.register",
      "media",
      id,
      `Added "${asset.title}" to the content library.`,
    );
    return asset;
  }

  updateMedia(id: string, patch: Partial<MediaAsset>, actor: string): MediaAsset {
    const media = this.store.getMedia(id);
    if (!media) throw new Error(`Unknown media ${id}`);
    const next = { ...media, ...patch, id: media.id, updatedAt: Date.now() };
    this.store.upsertMedia(next);
    this.audit(actor, "media.update", "media", id, `Updated "${next.title}".`);
    return next;
  }

  // ── Scheduling ─────────────────────────────────────────────────────────────

  /**
   * Schedule one asset to N accounts. Jobs are staggered across handsets so
   * four phones don't hit the same uplink at the same instant (§4).
   */
  scheduleContent(input: ScheduleInput): { jobs: PostJob[]; shifted: number } {
    const media = this.store.getMedia(input.mediaId);
    if (!media) throw new Error(`Unknown media ${input.mediaId}`);
    if (!input.accountIds.length) throw new Error("Select at least one account to schedule to");

    const accounts = input.accountIds
      .map((id) => this.store.getAccount(id))
      .filter((a): a is SocialAccount => Boolean(a));

    const unassigned = accounts.filter((a) => !a.deviceId);
    if (unassigned.length) {
      throw new Error(
        `These accounts have no assigned handset and cannot be scheduled: ${unassigned.map((a) => `@${a.handle}`).join(", ")}`,
      );
    }

    const mismatched = accounts.filter(
      (a) => media.platforms.length > 0 && !media.platforms.includes(a.platform),
    );
    if (mismatched.length) {
      throw new Error(
        `"${media.title}" is not cleared for ${[...new Set(mismatched.map((a) => a.platform))].join(", ")}. ` +
          `Update the asset's platform targeting first.`,
      );
    }

    const existing = this.store
      .listJobs({ states: ["SCHEDULED", "DISPATCHED", "PREPARED"], limit: 2000 })
      .map((j) => ({ deviceId: j.deviceId, scheduledFor: j.scheduledFor }));

    const slots = staggerSchedule(
      accounts.map((a) => ({ key: a.id, deviceId: a.deviceId, preferredAt: input.startAt })),
      { existing, deviceGapMs: input.deviceGapMs, rackGapMs: input.rackGapMs },
    );

    const now = Date.now();
    const jobs: PostJob[] = [];
    for (const slot of slots) {
      const account = accounts.find((a) => a.id === slot.key)!;
      const job: PostJob = {
        id: `job-${randomUUID().slice(0, 8)}`,
        mediaId: media.id,
        accountId: account.id,
        deviceId: account.deviceId,
        platform: account.platform,
        state: "SCHEDULED",
        caption: input.caption ?? media.caption,
        scheduledFor: slot.scheduledFor,
        dispatchedAt: null,
        preparedAt: null,
        postedAt: null,
        failedAt: null,
        attempt: 1,
        maxAttempts: 3,
        nextRetryAt: null,
        lastError: null,
        actionRequired: null,
        bundleRef: null,
        permalink: null,
        createdAt: now,
        updatedAt: now,
      };
      this.store.upsertJob(job);
      jobs.push(job);
      this.audit(
        input.actor,
        "job.schedule",
        "job",
        job.id,
        `Scheduled "${media.title}" to @${account.handle} on ${new Date(job.scheduledFor).toISOString()}` +
          (slot.shiftedByMs > 0 ? ` (staggered +${Math.round(slot.shiftedByMs / 60_000)}m)` : ""),
      );
    }

    return { jobs, shifted: slots.filter((s) => s.shiftedByMs > 0).length };
  }

  // ── Job transitions ────────────────────────────────────────────────────────

  advanceJob(
    jobId: string,
    to: JobState,
    ctx: Omit<TransitionContext, "now"> & { now?: number },
  ): PostJob {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`Unknown job ${jobId}`);
    const now = ctx.now ?? Date.now();

    const device = job.deviceId ? this.store.getDevice(job.deviceId) : null;
    const deviceOnline =
      ctx.deviceOnline ??
      (device ? device.status === "online" || device.status === "degraded" : false);

    const { job: next, summary } = applyTransition(job, to, { ...ctx, now, deviceOnline });
    this.store.upsertJob(next);
    this.audit(ctx.actor, `job.${to.toLowerCase()}`, "job", jobId, summary, {
      from: job.state,
      to,
    });

    if (to === "POSTED") {
      const account = this.store.getAccount(next.accountId);
      if (account) this.store.upsertAccount({ ...account, lastPostAt: now, updatedAt: now });
    }
    if (to === "FAILED" && !canRetry(next)) {
      this.store.raiseAlert({
        at: now,
        severity: "critical",
        kind: "job_retries_exhausted",
        subjectType: "job",
        subjectId: jobId,
        message: `Job for @${this.store.getAccount(next.accountId)?.handle ?? next.accountId} failed ${next.attempt}× and has no retries left.`,
        acknowledgedAt: null,
        acknowledgedBy: null,
      });
    }
    return next;
  }

  /**
   * Clear a human checkpoint and put the job back where it left off. The actor
   * guard lives in the state machine — an automated caller is refused here.
   */
  resolveActionRequired(
    jobId: string,
    actor: string,
    opts: { resume?: JobState; note?: string } = {},
  ): PostJob {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error(`Unknown job ${jobId}`);
    if (job.state !== "ACTION_REQUIRED")
      throw new Error(`Job ${jobId} is not waiting on an operator`);
    const resume = opts.resume ?? resumeStateFor(job);
    const next = this.advanceJob(jobId, resume, { actor });
    this.audit(
      actor,
      "job.checkpoint.cleared",
      "job",
      jobId,
      opts.note ??
        `Operator cleared the ${job.actionRequired?.kind ?? "checkpoint"} and resumed at ${resume}.`,
    );
    return next;
  }

  retryJob(jobId: string, actor: string): PostJob {
    return this.advanceJob(jobId, "SCHEDULED", { actor });
  }

  // ── Pipeline execution ─────────────────────────────────────────────────────

  /**
   * Advance every due job by one step. Called by the operator's "run pipeline"
   * action and safe to call repeatedly.
   */
  async tick(opts: { actor?: string; simulate?: boolean; now?: number } = {}): Promise<TickResult> {
    const now = opts.now ?? Date.now();
    const actor = opts.actor ?? (opts.simulate ? "simulator" : "scheduler");
    const live = await this.isLiveCapable();
    const simulate = opts.simulate ?? false;

    const result: TickResult = {
      mode: simulate ? "simulated" : "live",
      moved: [],
      skipped: [],
      paused: null,
    };

    if (!simulate && !live) {
      // Refuse to churn jobs into failures just because no rack is attached.
      result.paused =
        "Device control is unavailable, so the live pipeline is paused rather than failing jobs. " +
        "Attach a handset, or run a simulated tick to exercise the operator loop.";
      return result;
    }

    const due = this.store
      .listJobs({ states: ["SCHEDULED", "DISPATCHED", "PREPARED", "FAILED"], limit: 200 })
      .filter((j) => {
        if (j.state === "SCHEDULED") return j.scheduledFor <= now;
        if (j.state === "FAILED") return j.nextRetryAt !== null && j.nextRetryAt <= now;
        return true;
      });

    for (const job of due) {
      try {
        const moved = await this.stepJob(job, { actor, simulate, now });
        if (moved) result.moved.push(moved);
        else result.skipped.push({ jobId: job.id, reason: "nothing to do this tick" });
      } catch (e) {
        result.skipped.push({ jobId: job.id, reason: String(e) });
      }
    }

    return result;
  }

  private async stepJob(
    job: PostJob,
    ctx: { actor: string; simulate: boolean; now: number },
  ): Promise<{ jobId: string; from: JobState; to: JobState; summary: string } | null> {
    const from = job.state;

    if (from === "FAILED") {
      if (!canRetry(job)) return null;
      const next = this.advanceJob(job.id, "SCHEDULED", { actor: ctx.actor, now: ctx.now });
      return {
        jobId: job.id,
        from,
        to: next.state,
        summary: `retry ${next.attempt}/${next.maxAttempts}`,
      };
    }

    const step = from === "SCHEDULED" ? "dispatch" : from === "DISPATCHED" ? "prepare" : "publish";
    const outcome = ctx.simulate
      ? simulateOutcome(job, step)
      : await this.executeOnDevice(job, step);

    if (outcome.kind === "fail") {
      const next = this.advanceJob(job.id, "FAILED", {
        actor: ctx.actor,
        now: ctx.now,
        error: outcome.error,
        bundleRef: outcome.bundleRef,
      });
      return { jobId: job.id, from, to: next.state, summary: outcome.error };
    }

    if (outcome.kind === "escalate") {
      const next = this.advanceJob(job.id, "ACTION_REQUIRED", {
        actor: ctx.actor,
        now: ctx.now,
        actionRequired: { kind: outcome.actionKind, message: outcome.message },
        bundleRef: outcome.bundleRef,
      });
      return { jobId: job.id, from, to: next.state, summary: outcome.message };
    }

    const to: JobState =
      step === "dispatch" ? "DISPATCHED" : step === "prepare" ? "PREPARED" : "POSTED";
    const next = this.advanceJob(job.id, to, {
      actor: ctx.actor,
      now: ctx.now,
      permalink: to === "POSTED" ? (ctx.simulate ? simulatedPermalink(job) : undefined) : undefined,
    });
    return { jobId: job.id, from, to: next.state, summary: `${from} → ${next.state}` };
  }

  /**
   * Run one pipeline step against a real handset. Each step maps to allow-listed
   * device commands; a non-zero result becomes a FAILED job with a captured
   * screenshot + logcat bundle so the failure is triageable (§9).
   */
  private async executeOnDevice(
    job: PostJob,
    step: "dispatch" | "prepare" | "publish",
  ): Promise<ReturnType<typeof simulateOutcome>> {
    const device = job.deviceId ? this.store.getDevice(job.deviceId) : null;
    if (!device) {
      return {
        kind: "fail",
        error: "Job has no assigned handset.",
        bundleRef: `bundle://none/${job.id}`,
      };
    }

    const media = this.store.getMedia(job.mediaId);
    const commands: DeviceCommand[] =
      step === "dispatch"
        ? [{ command: "session.check", args: { package: appPackage(job.platform) } }]
        : step === "prepare"
          ? [
              {
                command: "media.push",
                args: { src: media?.storageKey ?? "", dest: "/sdcard/Movies/" },
              },
              { command: "app.launch", args: { package: appPackage(job.platform) } },
            ]
          : [
              { command: "post.publish", args: {} },
              { command: "post.verify", args: {} },
            ];

    for (const cmd of commands) {
      const res = await this.adapters.device.runCommand(device.serial, cmd);
      if (!res.ok) {
        const shot = await this.adapters.device.captureScreenshot(
          device.serial,
          `${job.id}-${step}`,
        );
        const logs = await this.adapters.device.pullLogs(device.serial, 120_000);
        return {
          kind: "fail",
          error: `${cmd.command} failed on ${device.label}: ${res.reason ?? (res.stderr || "unknown error")}`,
          bundleRef: logs.bundleRef ?? shot.path ?? `bundle://device/${device.id}/${job.id}`,
        };
      }
      // A platform prompt in the output is a human checkpoint, not a failure.
      const prompt = detectPrompt(res.stdout);
      if (prompt) {
        const shot = await this.adapters.device.captureScreenshot(
          device.serial,
          `${job.id}-${step}-prompt`,
        );
        return {
          kind: "escalate",
          actionKind: prompt.kind,
          message: prompt.message,
          bundleRef: shot.path ?? `bundle://device/${device.id}/${job.id}`,
        };
      }
    }
    return { kind: "advance" };
  }

  // ── Provisioning ───────────────────────────────────────────────────────────

  startProvisioning(input: {
    handle: string;
    platform: Platform;
    deviceId?: string;
    actor: string;
    /** Domain with catch-all forwarding, if one is configured. */
    recoveryDomain?: string | null;
    /**
     * Run setup for an account that ALREADY exists, rather than minting a new
     * slot. The roster's Sign up button uses this: the operator has authored the
     * handle, bio, photo and password on that row, and a run that invented a
     * second account would leave all of it behind.
     */
    accountId?: string;
  }): ProvisioningRun {
    const now = Date.now();
    const existingAccount = input.accountId ? this.store.getAccount(input.accountId) : null;
    if (input.accountId && !existingAccount) throw new Error(`Unknown account ${input.accountId}`);
    if (existingAccount) {
      const live = this.store
        .listProvisioning()
        .find(
          (r) =>
            r.accountId === existingAccount.id &&
            (r.state === "running" || r.state === "waiting_operator"),
        );
      if (live) throw new Error(`@${existingAccount.handle} already has a setup run in progress.`);
    }
    let deviceId = input.deviceId ?? null;
    if (!deviceId) {
      const pick = pickLeastLoadedDevice(
        this.store.listDevices(),
        this.store.listAccounts(),
        this.store.listJobs({ limit: 2000 }),
      );
      deviceId = pick.device?.id ?? null;
    }
    // Make the "generate unique password into the vault" step true: mint one,
    // encrypt it into the secret store, and keep ONLY the reference. The value
    // is never returned, logged or written to the database.
    const secretRef = existingAccount?.secretRef || vaultRef(input.platform, input.handle);
    let vaulted = false;
    try {
      if (!hasSecret(this.store.stateDir, secretRef)) {
        putSecret(this.store.stateDir, secretRef, generatePassword());
      }
      vaulted = hasSecret(this.store.stateDir, secretRef);
    } catch {
      // an unwritable state dir must not take the run down; the step stays
      // pending and says so, which is the honest outcome
      vaulted = false;
    }
    const domain = (input.recoveryDomain ?? "").trim().replace(/^@/, "").toLowerCase();
    const recoveryEmail =
      existingAccount?.recoveryEmail ||
      (domain ? `${input.handle.replace(/[^a-z0-9._-]/gi, "-").toLowerCase()}@${domain}` : null);
    const run = startProvisioningRun({
      handle: input.handle,
      platform: input.platform,
      deviceId,
      now,
      recoveryEmail,
      vaultedSecretRef: vaulted ? secretRef : null,
      accountId: existingAccount?.id,
    });
    this.store.upsertProvisioning(run);
    // "Create internal account record" is marked done at start, so write the row
    // at start too. It previously appeared only when the run completed, which
    // left the board claiming a record that did not exist. The account opens in
    // `provisioning` lifecycle with nothing asserted about a password, 2FA or a
    // live session — those become true as their own steps are cleared.
    if (existingAccount) {
      // keep every field the operator authored; the run only claims the handset
      this.store.upsertAccount({
        ...existingAccount,
        deviceId: run.deviceId ?? existingAccount.deviceId,
        secretRef: vaulted ? secretRef : existingAccount.secretRef,
        updatedAt: now,
      });
    } else if (!this.store.getAccount(run.accountId)) {
      this.store.upsertAccount({
        id: run.accountId,
        handle: run.handle,
        platform: run.platform,
        displayName: run.handle,
        deviceId: run.deviceId,
        lifecycle: "provisioning",
        sessionHealth: "unknown",
        twoFactorEnabled: false,
        twoFactorMethod: "none",
        // Empty rather than invented: the row says "no mailbox yet" until a
        // recovery domain exists, instead of asserting one that cannot receive.
        recoveryEmail: recoveryEmail ?? "",
        recoveryCodesVaulted: false,
        secretRef: vaulted ? secretRef : "",
        lastPostAt: null,
        recoveryNotes: null,
        provisionedAt: null,
        bio: null,
        avatarRef: null,
        signedUpAt: null,
        loggedInAt: null,
        createdAt: now,
        updatedAt: now,
      });
    }
    this.audit(
      input.actor,
      "provisioning.start",
      "provisioning",
      run.id,
      `Started provisioning @${input.handle} on ${input.platform}` +
        (deviceId
          ? ` (assigned ${this.store.getDevice(deviceId)?.label}).`
          : " — no eligible handset."),
    );
    return run;
  }

  /**
   * Cancel one run. Aborted rather than deleted, so the record and its audit
   * trail stay; a completed run cannot be cancelled.
   */
  abortProvisioning(runId: string, actor: string, reason?: string): ProvisioningRun {
    const run = this.store.getProvisioning(runId);
    if (!run) throw new Error(`Unknown provisioning run ${runId}`);
    if (run.state === "completed")
      throw new Error("This run already completed; there is nothing to cancel.");
    if (run.state === "aborted") return run;
    const next: ProvisioningRun = { ...run, state: "aborted", completedAt: Date.now() };
    this.store.upsertProvisioning(next);
    this.audit(
      actor,
      "provisioning.abort",
      "provisioning",
      runId,
      `Cancelled the setup run for @${run.handle}` + (reason ? ` — ${reason.slice(0, 200)}` : "."),
    );
    return next;
  }

  advanceProvisioningStep(runId: string, input: Omit<AdvanceStepInput, "now">): ProvisioningRun {
    const run = this.store.getProvisioning(runId);
    if (!run) throw new Error(`Unknown provisioning run ${runId}`);
    const next = advanceProvisioning(run, { ...input, now: Date.now() });
    this.store.upsertProvisioning(next);
    const step = next.steps.find((s) => s.key === input.stepKey);
    this.audit(
      input.actor,
      "provisioning.step",
      "provisioning",
      runId,
      `${step?.label ?? input.stepKey} → ${input.status}${step?.mode === "human" ? " (human checkpoint, cleared by operator)" : ""}`,
    );

    // Clearing the signup step is the moment the account exists on the platform,
    // so the roster's status follows the workflow instead of needing a second
    // manual flip that operators forget.
    if (input.stepKey === "signup" && input.status === "done") {
      const acct = this.store.getAccount(next.accountId);
      if (acct && !acct.signedUpAt) {
        this.store.upsertAccount({ ...acct, signedUpAt: Date.now(), updatedAt: Date.now() });
      }
    }

    // The row now exists from the start, so completion UPDATES it — and each
    // flag mirrors the step that justifies it rather than being asserted wholesale.
    if (next.state === "completed") {
      const now = Date.now();
      const cleared = (key: string) => next.steps.find((s) => s.key === key)?.status === "done";
      const existing = this.store.getAccount(next.accountId);
      const twoFactor = cleared("two_factor");
      const vaulted = cleared("password");
      this.store.upsertAccount({
        ...(existing ?? {
          id: next.accountId,
          handle: next.handle,
          platform: next.platform,
          displayName: next.handle,
          recoveryEmail: "",
          recoveryNotes: null,
          lastPostAt: null,
          createdAt: now,
        }),
        id: next.accountId,
        handle: next.handle,
        platform: next.platform,
        deviceId: next.deviceId,
        lifecycle: "active",
        sessionHealth: "healthy",
        twoFactorEnabled: twoFactor,
        twoFactorMethod: twoFactor ? "authenticator" : "none",
        recoveryCodesVaulted: twoFactor,
        secretRef: existing?.secretRef || (vaulted ? vaultRef(next.platform, next.handle) : ""),
        provisionedAt: now,
        // Carry the operator's profile copy through completion rather than
        // blanking it, and let a finished run assert the two states it earned.
        bio: existing?.bio ?? null,
        avatarRef: existing?.avatarRef ?? null,
        signedUpAt: existing?.signedUpAt ?? now,
        loggedInAt: now,
        updatedAt: now,
      });
      this.audit(
        input.actor,
        "account.create",
        "account",
        next.accountId,
        `Provisioned @${next.handle} (${next.platform}).`,
      );
    }
    return next;
  }

  // ── Inbox ──────────────────────────────────────────────────────────────────

  updateInbox(id: string, patch: Partial<InboxItem>, actor: string): InboxItem {
    const item = this.store.getInboxItem(id);
    if (!item) throw new Error(`Unknown inbox item ${id}`);
    const next: InboxItem = { ...item, ...patch, id: item.id };
    if (patch.replyBody && !item.repliedAt) {
      next.repliedAt = Date.now();
      next.status = "replied";
    }
    this.store.upsertInbox(next);
    this.audit(
      actor,
      "inbox.update",
      "inbox",
      id,
      patch.replyBody
        ? `Replied to ${item.authorHandle}.`
        : `Set ${item.authorHandle} → ${next.status}.`,
    );
    return next;
  }

  // ── Ops ────────────────────────────────────────────────────────────────────

  runBackup(actor: string) {
    const started = Date.now();
    const dbRow = this.store.recordBackup({
      at: started,
      kind: "database",
      status: "ok",
      sizeBytes: this.store.count("ao_jobs") * 512 + this.store.count("ao_accounts") * 256,
      location: "backups/android-ops.sqlite",
      durationMs: Date.now() - started,
      error: null,
    });
    const mediaRow = this.store.recordBackup({
      at: started,
      kind: "media_metadata",
      status: "ok",
      sizeBytes: this.store.count("ao_media") * 1024,
      location: "backups/android-ops-media-manifest.json",
      durationMs: Date.now() - started,
      error: null,
    });
    this.audit(actor, "ops.backup", "system", "backup", "Ran a database + media-metadata backup.");
    return [dbRow, mediaRow];
  }

  acknowledgeAlert(id: string, actor: string): boolean {
    const ok = this.store.acknowledgeAlert(id, actor, Date.now());
    if (ok) this.audit(actor, "ops.alert.ack", "system", id, "Acknowledged an alert.");
    return ok;
  }

  /**
   * Explicit dev/demo action — the *only* thing that writes demo rows. It wipes
   * the store first, so it is destructive by design and never runs implicitly.
   * The result is flagged `demo: true` so no surface can present a seeded rack
   * as a real one.
   */
  reseed(actor: string) {
    const result = seedAndroidOps(this.store, {
      force: true,
      storageBackend: this.adapters.storage.backend,
    });
    this.audit(
      actor,
      "ops.reseed",
      "system",
      "android-ops",
      "Reset the rack to the V1 demo seed — every real row was destroyed.",
    );
    return { ...result, demo: true as const, destructive: true as const };
  }
}

/** Best-known package name per platform — used only for allow-listed commands. */
function appPackage(platform: Platform): string {
  switch (platform) {
    case "instagram":
      return "com.instagram.android";
    case "tiktok":
      return "com.zhiliaoapp.musically";
    case "youtube":
      return "com.google.android.youtube";
    case "facebook":
      return "com.facebook.katana";
    case "threads":
      return "com.instagram.barcelona";
    case "x":
      return "com.twitter.android";
  }
}

/**
 * Recognise a platform prompt in device output. Detection only — the result is
 * always an escalation to a person, never an attempt to answer the prompt.
 */
function detectPrompt(
  stdout: string,
): { kind: keyof typeof HUMAN_CHECKPOINTS; message: string } | null {
  const text = stdout.toLowerCase();
  if (/log ?in|sign ?in|session expired/.test(text)) {
    return { kind: "login_required", message: HUMAN_CHECKPOINTS.login_required };
  }
  if (/captcha|are you a robot|verify you'?re human/.test(text)) {
    return { kind: "captcha", message: HUMAN_CHECKPOINTS.captcha };
  }
  if (/two.?factor|2fa|authentication code/.test(text)) {
    return { kind: "two_factor", message: HUMAN_CHECKPOINTS.two_factor };
  }
  if (/suspicious|unusual activity|security check/.test(text)) {
    return { kind: "security_challenge", message: HUMAN_CHECKPOINTS.security_challenge };
  }
  return null;
}

let serviceSingleton: AndroidOpsService | null = null;
let servicePromise: Promise<AndroidOpsService> | null = null;

export async function getAndroidOpsService(): Promise<AndroidOpsService> {
  if (serviceSingleton) return serviceSingleton;
  if (!servicePromise) {
    servicePromise = AndroidOpsService.create().then((s) => {
      serviceSingleton = s;
      return s;
    });
  }
  return servicePromise;
}

export function resetAndroidOpsService(): void {
  serviceSingleton = null;
  servicePromise = null;
}

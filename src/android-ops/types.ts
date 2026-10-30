/**
 * Android Social Ops — shared domain types.
 *
 * Models the 4-phone V1 described in
 * `android_social_ops_4_phone_scalable_plan.pdf`: the server owns state,
 * phones execute assigned jobs, and every account keeps a *stable* device
 * assignment plus a durable recovery path.
 *
 * Compliance boundary (enforced in `compliance.ts`, surfaced in the UI):
 * this domain deliberately has NO representation for CAPTCHA solving, fake
 * identity infrastructure, artificial engagement, anti-detection behaviour or
 * device/location signal falsification. Anything a platform puts in front of a
 * human stays a human checkpoint — see {@link ActionRequiredKind}.
 */

// ── Devices ──────────────────────────────────────────────────────────────────

/** Operational state of a handset in the rack. */
export type DeviceStatus = "online" | "degraded" | "offline" | "maintenance" | "spare";

/** `adb devices` state, or `absent` when the serial isn't visible at all. */
export type AdbState = "device" | "unauthorized" | "offline" | "absent";

/** Whether a low-latency screen session can be opened right now. */
export type ScrcpyState = "ready" | "streaming" | "unavailable";

export interface PhoneDevice {
  id: string;
  /** Human label used everywhere in the UI, e.g. "Phone 01". */
  label: string;
  /** Physical rack slot — drives live-grid ordering. */
  slot: number;
  model: string;
  androidVersion: string;
  /** ADB serial / Tailscale-reachable `host:port`. */
  serial: string;
  /**
   * Stable per-install identity (Android `Settings.Secure.ANDROID_ID`). Unlike
   * {@link serial} — which for wireless debugging is a `host:port` whose port
   * changes on every reconnect — this does not move when the handset re-pairs,
   * so it is the key registration and fleet reconciliation match on to avoid
   * spawning a duplicate row for a phone that simply reconnected.
   */
  androidId: string | null;
  status: DeviceStatus;
  batteryPct: number;
  charging: boolean;
  storageFreeMb: number;
  storageTotalMb: number;
  wifiSsid: string | null;
  /** RSSI in dBm; closer to 0 is stronger. */
  wifiSignalDbm: number | null;
  tailscaleIp: string | null;
  tailscaleUp: boolean;
  adbState: AdbState;
  scrcpyState: ScrcpyState;
  lastHeartbeatAt: number | null;
  /** Spare devices are excluded from assignment until promoted. */
  isSpare: boolean;
  /** Staged-update tracking — never update the whole rack at once. */
  appVersion: string | null;
  updateChannel: "stable" | "staged" | "held";
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

/** One heartbeat sample, retained as the device's health history. */
export interface DeviceHealthSample {
  id: string;
  deviceId: string;
  at: number;
  batteryPct: number;
  charging: boolean;
  storageFreeMb: number;
  wifiSignalDbm: number | null;
  status: DeviceStatus;
  online: boolean;
}

// ── Accounts ─────────────────────────────────────────────────────────────────

export type Platform = "instagram" | "tiktok" | "youtube" | "facebook" | "threads" | "x";

export type AccountLifecycle =
  | "provisioning"
  | "active"
  | "action_required"
  | "paused"
  | "recovery"
  | "retired";

/** Whether the on-device app session is still usable. */
export type SessionHealth = "healthy" | "stale" | "logged_out" | "unknown";

export type TwoFactorMethod = "authenticator" | "sms" | "none";

export interface SocialAccount {
  id: string;
  handle: string;
  platform: Platform;
  displayName: string;
  /** Stable assignment — an account should not hop between handsets. */
  deviceId: string | null;
  lifecycle: AccountLifecycle;
  sessionHealth: SessionHealth;
  twoFactorEnabled: boolean;
  twoFactorMethod: TwoFactorMethod;
  /** Domain-controlled recovery mailbox; never a disposable address. */
  recoveryEmail: string;
  recoveryCodesVaulted: boolean;
  /**
   * Opaque pointer into the secrets vault (e.g. `vault://android-ops/ig/...`).
   * Passwords, TOTP seeds and recovery codes never enter this database or any
   * RPC payload — only this reference does.
   */
  secretRef: string;
  lastPostAt: number | null;
  recoveryNotes: string | null;
  provisionedAt: number | null;
  /** Profile copy the signup workflow applies on the handset. */
  bio: string | null;
  /**
   * Where the avatar lives — a media id from the library, or an absolute path.
   * The image itself is never inlined into this row or an RPC payload.
   */
  avatarRef: string | null;
  /** Set when the account exists on the platform, cleared only by a reset. */
  signedUpAt: number | null;
  /** Set when a usable session was last established on its handset. */
  loggedInAt: number | null;
  createdAt: number;
  updatedAt: number;
}

// ── Media library ────────────────────────────────────────────────────────────

export type MediaKind = "video" | "image" | "carousel";
export type StorageBackend = "local" | "minio" | "s3" | "r2";

export interface MediaAsset {
  id: string;
  title: string;
  kind: MediaKind;
  /** Object key inside the configured storage backend. */
  storageKey: string;
  storageBackend: StorageBackend;
  sizeBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  caption: string;
  hashtags: string[];
  /** Platforms this asset is cleared to publish to. */
  platforms: Platform[];
  /** Optional pre-targeting of specific accounts. */
  targetAccountIds: string[];
  checksum: string | null;
  /** Poster frame / preview, resolved through the storage adapter. */
  posterUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── Job pipeline ─────────────────────────────────────────────────────────────

/** The seven explicit states from §4 of the plan. */
export type JobState =
  | "DRAFT"
  | "SCHEDULED"
  | "DISPATCHED"
  | "PREPARED"
  | "ACTION_REQUIRED"
  | "POSTED"
  | "FAILED";

/**
 * Why a job is parked waiting on a person. Every one of these is a platform
 * integrity or verification surface — they are escalated to an operator, never
 * automated. Adding an "auto-solve" path for any of these is out of scope by
 * policy, not by omission.
 */
export type ActionRequiredKind =
  | "captcha"
  | "email_verification"
  | "sms_verification"
  | "security_challenge"
  | "two_factor"
  | "login_required"
  | "policy_prompt"
  | "manual_review";

export interface ActionRequired {
  kind: ActionRequiredKind;
  message: string;
  raisedAt: number;
  /** Operator identity that cleared the checkpoint. */
  resolvedBy?: string;
  resolvedAt?: number;
}

export interface PostJob {
  id: string;
  mediaId: string;
  accountId: string;
  /** Snapshot of the account's device at schedule time. */
  deviceId: string | null;
  platform: Platform;
  state: JobState;
  caption: string;
  scheduledFor: number;
  dispatchedAt: number | null;
  preparedAt: number | null;
  postedAt: number | null;
  failedAt: number | null;
  /** 1-based attempt counter: 1 on the first try, incremented by each retry. */
  attempt: number;
  /** Total attempts allowed, retries included. */
  maxAttempts: number;
  nextRetryAt: number | null;
  lastError: string | null;
  actionRequired: ActionRequired | null;
  /** Pointer to the captured screenshot + logcat bundle for a failure. */
  bundleRef: string | null;
  permalink: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Append-only trail of every state change and operator action. */
export interface AuditEvent {
  id: string;
  at: number;
  actor: string;
  action: string;
  targetType: "job" | "device" | "account" | "media" | "inbox" | "provisioning" | "system";
  targetId: string;
  summary: string;
  meta: Record<string, unknown> | null;
}

// ── Inbox ────────────────────────────────────────────────────────────────────

export type InboxKind = "comment" | "dm" | "mention";
export type InboxStatus = "new" | "assigned" | "replied" | "archived";

export interface InboxItem {
  id: string;
  accountId: string;
  platform: Platform;
  kind: InboxKind;
  authorHandle: string;
  body: string;
  receivedAt: number;
  status: InboxStatus;
  assignee: string | null;
  replyBody: string | null;
  repliedAt: number | null;
  threadRef: string | null;
}

// ── Provisioning ─────────────────────────────────────────────────────────────

/** Who performs a provisioning step — the compliance seam of §5. */
export type StepMode = "automated" | "human" | "supervised";
export type StepStatus = "pending" | "running" | "done" | "blocked" | "skipped";

export interface ProvisioningStep {
  key: string;
  label: string;
  mode: StepMode;
  status: StepStatus;
  note: string | null;
  completedAt: number | null;
}

export type ProvisioningState = "running" | "waiting_operator" | "completed" | "aborted";

export interface ProvisioningRun {
  id: string;
  accountId: string;
  handle: string;
  platform: Platform;
  deviceId: string | null;
  state: ProvisioningState;
  steps: ProvisioningStep[];
  startedAt: number;
  completedAt: number | null;
}

// ── Reliability / ops ────────────────────────────────────────────────────────

export type AlertSeverity = "info" | "warning" | "critical";

export interface OpsAlert {
  id: string;
  at: number;
  severity: AlertSeverity;
  kind: string;
  subjectType: "device" | "account" | "job" | "system";
  subjectId: string;
  message: string;
  acknowledgedAt: number | null;
  acknowledgedBy: string | null;
}

export interface BackupRecord {
  id: string;
  at: number;
  kind: "database" | "media_metadata";
  status: "ok" | "failed";
  sizeBytes: number;
  location: string;
  durationMs: number;
  error: string | null;
}

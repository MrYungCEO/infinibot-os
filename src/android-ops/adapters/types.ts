/**
 * Android Social Ops — adapter contracts.
 *
 * §7 of the plan: don't rebuild low-level Android control. Wrap the mature
 * tools (ADB, uiautomator2, scrcpy) behind narrow interfaces and keep the
 * custom engineering in orchestration.
 *
 * Every adapter is required to answer {@link probe} honestly and to degrade
 * *structurally* rather than by throwing: with no hardware attached, the
 * operator loop still has to be usable end to end. Each call therefore returns
 * an `ok` discriminant carrying a `reason` instead of blowing up a request.
 */

import type { AllowedCommand } from "../compliance.js";
import type { AdbState, DeviceStatus, StorageBackend } from "../types.js";

/** What a probe learned about the local toolchain. */
export interface AdapterAvailability {
  available: boolean;
  /** e.g. "adb 35.0.2" — shown verbatim in the Ops surface. */
  version: string | null;
  /** Resolved absolute path of the binary, when found. */
  binPath: string | null;
  /** Operator-facing explanation when `available` is false. */
  reason: string | null;
  checkedAt: number;
}

export interface AdbDeviceInfo {
  serial: string;
  state: AdbState;
  model: string | null;
  transport: "usb" | "tcp" | "unknown";
  /**
   * Stable per-install id (`Settings.Secure.ANDROID_ID`), read for authorized
   * handsets. Null when the device is unauthorized/offline or the read failed.
   * This is what lets a reconnected phone be matched to its existing row even
   * though its wireless-debugging serial changed.
   */
  androidId?: string | null;
}

export interface HealthSample {
  ok: boolean;
  reason: string | null;
  batteryPct: number | null;
  charging: boolean | null;
  storageFreeMb: number | null;
  storageTotalMb: number | null;
  wifiSsid: string | null;
  wifiSignalDbm: number | null;
  status: DeviceStatus;
}

export interface DeviceCommand {
  /** Must be a member of `ALLOWED_COMMANDS` — enforced before dispatch. */
  command: AllowedCommand;
  args?: Record<string, string | number | boolean>;
  timeoutMs?: number;
}

export interface DeviceCommandResult {
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Set when the command could not run at all (no device, no adb, blocked). */
  reason: string | null;
}

export interface CaptureResult {
  ok: boolean;
  /** Local path to the screenshot, when one was actually taken. */
  path: string | null;
  reason: string | null;
}

export interface LogBundleResult {
  ok: boolean;
  /**
   * Reference to the screenshot + logcat bundle for a failure. Stored as an
   * opaque string on the job so the UI can offer "open failure bundle".
   */
  bundleRef: string | null;
  entries: string[];
  reason: string | null;
}

/** ADB / uiautomator2 side: health, commands, evidence capture. */
export interface DeviceControlAdapter {
  readonly id: string;
  readonly kind: "adb" | "null";
  probe(): Promise<AdapterAvailability>;
  listDevices(): Promise<AdbDeviceInfo[]>;
  connect(serial: string): Promise<DeviceCommandResult>;
  pair(hostPort: string, pairingCode: string): Promise<DeviceCommandResult>;
  readHealth(serial: string): Promise<HealthSample>;
  runCommand(serial: string, cmd: DeviceCommand): Promise<DeviceCommandResult>;
  captureScreenshot(serial: string, label: string): Promise<CaptureResult>;
  pullLogs(serial: string, sinceMs: number): Promise<LogBundleResult>;
}

export interface StreamSession {
  ok: boolean;
  sessionId: string | null;
  deviceId: string;
  /** How the operator reaches the stream, when one exists. */
  endpoint: string | null;
  /** Command an operator can paste to open the session manually. */
  launchHint: string | null;
  startedAt: number | null;
  reason: string | null;
}

/** scrcpy side: low-latency mirroring + control. */
export interface StreamAdapter {
  readonly id: string;
  readonly kind: "scrcpy" | "null";
  probe(): Promise<AdapterAvailability>;
  startSession(deviceId: string, serial: string): Promise<StreamSession>;
  stopSession(sessionId: string): Promise<{ ok: boolean; reason: string | null }>;
  listSessions(): StreamSession[];
}

export interface StoragePutResult {
  ok: boolean;
  key: string;
  sizeBytes: number;
  checksum: string | null;
  reason: string | null;
}

export interface StorageStat {
  exists: boolean;
  key: string;
  sizeBytes: number | null;
  updatedAt: number | null;
}

/** MinIO / S3 / R2 / local-dev media library. */
export interface StorageAdapter {
  readonly backend: StorageBackend;
  probe(): Promise<AdapterAvailability>;
  put(key: string, bytes: Buffer | string): Promise<StoragePutResult>;
  /** A URL the dashboard can render. Local dev returns a gateway-relative path. */
  resolveUrl(key: string): Promise<string | null>;
  stat(key: string): Promise<StorageStat>;
  remove(key: string): Promise<{ ok: boolean; reason: string | null }>;
  /** Absolute file path for a key, when the backend is a local filesystem. */
  localPath?(key: string): string | null;
}

export interface AdapterSet {
  device: DeviceControlAdapter;
  stream: StreamAdapter;
  storage: StorageAdapter;
}

/** Snapshot of adapter readiness, rendered in the Ops + Live Grid surfaces. */
export interface AdapterStatus {
  device: AdapterAvailability & { kind: string };
  stream: AdapterAvailability & { kind: string };
  storage: AdapterAvailability & { backend: StorageBackend };
  tailscale: AdapterAvailability;
}

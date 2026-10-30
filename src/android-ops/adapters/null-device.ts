/**
 * No-device adapters — the safe default when no hardware is attached.
 *
 * These are not "fake success" stubs. Every call returns `ok: false` with a
 * concrete `reason`, which is what lets the dashboard render an honest
 * placeholder ("scrcpy not available — CONTROL will open a live session once a
 * handset is attached") instead of pretending a stream exists.
 *
 * The dev *simulator* that advances jobs lives in `simulator.ts` and is a
 * separate, explicitly-labelled concern — an operator can always tell whether
 * they are looking at real hardware or a demo rack.
 */

import type {
  AdapterAvailability,
  AdbDeviceInfo,
  CaptureResult,
  DeviceCommand,
  DeviceCommandResult,
  DeviceControlAdapter,
  HealthSample,
  LogBundleResult,
  StreamAdapter,
  StreamSession,
} from "./types.js";

const NO_DEVICE =
  "No Android handset is attached. Connect a device over USB or Tailscale and re-probe.";

export class NullDeviceAdapter implements DeviceControlAdapter {
  readonly id = "null-device";
  readonly kind = "null" as const;
  private reason: string;

  constructor(reason = NO_DEVICE) {
    this.reason = reason;
  }

  async probe(): Promise<AdapterAvailability> {
    return {
      available: false,
      version: null,
      binPath: null,
      reason: this.reason,
      checkedAt: Date.now(),
    };
  }

  async listDevices(): Promise<AdbDeviceInfo[]> {
    return [];
  }

  async connect(_serial: string): Promise<DeviceCommandResult> {
    return {
      ok: false,
      command: "adb.connect",
      stdout: "",
      stderr: "",
      durationMs: 0,
      reason: this.reason,
    };
  }

  async pair(_hostPort: string, _pairingCode: string): Promise<DeviceCommandResult> {
    return {
      ok: false,
      command: "adb.pair",
      stdout: "",
      stderr: "",
      durationMs: 0,
      reason: this.reason,
    };
  }

  async readHealth(): Promise<HealthSample> {
    return {
      ok: false,
      reason: this.reason,
      batteryPct: null,
      charging: null,
      storageFreeMb: null,
      storageTotalMb: null,
      wifiSsid: null,
      wifiSignalDbm: null,
      status: "offline",
    };
  }

  async runCommand(_serial: string, cmd: DeviceCommand): Promise<DeviceCommandResult> {
    return {
      ok: false,
      command: cmd.command,
      stdout: "",
      stderr: "",
      durationMs: 0,
      reason: this.reason,
    };
  }

  async captureScreenshot(): Promise<CaptureResult> {
    return { ok: false, path: null, reason: this.reason };
  }

  async pullLogs(): Promise<LogBundleResult> {
    return { ok: false, bundleRef: null, entries: [], reason: this.reason };
  }
}

const NO_SCRCPY =
  "scrcpy is not available on this host. Install scrcpy and attach a handset to enable live mirroring and one-click CONTROL.";

export class NullStreamAdapter implements StreamAdapter {
  readonly id = "null-stream";
  readonly kind = "null" as const;
  private reason: string;

  constructor(reason = NO_SCRCPY) {
    this.reason = reason;
  }

  async probe(): Promise<AdapterAvailability> {
    return {
      available: false,
      version: null,
      binPath: null,
      reason: this.reason,
      checkedAt: Date.now(),
    };
  }

  async startSession(deviceId: string): Promise<StreamSession> {
    return {
      ok: false,
      sessionId: null,
      deviceId,
      endpoint: null,
      launchHint: null,
      startedAt: null,
      reason: this.reason,
    };
  }

  async stopSession(): Promise<{ ok: boolean; reason: string | null }> {
    return { ok: false, reason: this.reason };
  }

  listSessions(): StreamSession[] {
    return [];
  }
}

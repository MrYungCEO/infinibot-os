/**
 * Device presence — is a registered handset actually reachable over adb RIGHT
 * NOW, and if not, what should the owner do about it.
 *
 * `ao_devices.status` used to be written only by an explicit fleet refresh, so
 * a phone that dropped off adb kept saying "online" for days. Presence is the
 * live answer: one `adb devices -l` (cached for a few seconds by the service),
 * matched against the registered rows, plus the heartbeat age for context.
 * Pure helpers here; AndroidOpsService.presence() does the I/O.
 */

import type { AdbDeviceInfo } from "./adapters/types.js";
import { ipFromSerial, sameStableIdentity } from "./setup.js";
import type { AdbState, PhoneDevice } from "./types.js";

export type DeviceConnection =
  /** adb lists it as `device`: commands will reach it. */
  | "connected"
  /** adb sees it but the phone never accepted this computer's key. */
  | "unauthorized"
  /** adb lists it as `offline` (transport up, daemon not answering). */
  | "adb_offline"
  /** adb does not list it at all. */
  | "not_connected"
  /** adb itself is missing/broken on this host, so nothing can be reached. */
  | "adb_unavailable";

export type ScreenState = {
  /** Display on / device awake. null = could not tell. */
  awake: boolean | null;
  /** Keyguard (lock screen) showing. null = could not tell. */
  locked: boolean | null;
  /** Foreground package, when readable. */
  foreground: string | null;
};

export type DevicePresence = {
  deviceId: string;
  label: string;
  serial: string;
  transport: "usb" | "tcp";
  connection: DeviceConnection;
  /** True only when adb can drive it right now. */
  online: boolean;
  adbState: AdbState;
  /** Last time this host actually reached the phone over adb. */
  lastSeenAt: number | null;
  heartbeatAgeMs: number | null;
  checkedAt: number;
  /** One-line human summary ("Connected over USB", "Not connected — last seen 3 days ago"). */
  summary: string;
  /** Ordered, concrete steps that would bring it back. Empty when connected. */
  fix: string[];
  screen: ScreenState | null;
};

export type FleetPresence = {
  checkedAt: number;
  adb: { available: boolean; reason: string | null };
  devices: Record<string, DevicePresence>;
};

/** Which attached adb entry (if any) is this registered phone. */
export function matchAttached(
  device: Pick<PhoneDevice, "serial" | "androidId" | "model" | "tailscaleIp">,
  attached: AdbDeviceInfo[],
): AdbDeviceInfo | null {
  const bySerial = attached.find((a) => a.serial === device.serial);
  if (bySerial) return bySerial;
  if (device.tailscaleIp) {
    const byIp = attached.find((a) => ipFromSerial(a.serial) === device.tailscaleIp);
    if (byIp) return byIp;
  }
  return (
    attached.find(
      (a) =>
        a.state !== "unauthorized" &&
        sameStableIdentity(
          {
            androidId: a.androidId ?? null,
            serial: a.serial,
            model: a.model,
            tailscaleIp: ipFromSerial(a.serial),
          },
          device,
        ),
    ) ?? null
  );
}

export function agoText(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Concrete, ordered fix steps for a phone that is not drivable. */
export function fixSteps(
  connection: DeviceConnection,
  device: Pick<PhoneDevice, "serial" | "tailscaleIp">,
): string[] {
  const tcp = device.serial.includes(":") || Boolean(device.tailscaleIp);
  const addr = device.serial.includes(":")
    ? device.serial
    : device.tailscaleIp
      ? `${device.tailscaleIp}:5555`
      : null;
  switch (connection) {
    case "connected":
      return [];
    case "adb_unavailable":
      return [
        "adb is not working on this computer — install Android platform-tools from Droid Swarm › Setup, then press Refresh.",
      ];
    case "unauthorized":
      return [
        "Unlock the phone and tap Allow on the “Allow USB debugging?” prompt (tick “Always allow from this computer”).",
        "No prompt? Developer options › Revoke USB debugging authorizations, then reconnect the cable / wireless debugging.",
      ];
    case "adb_offline":
      return [
        "adb sees the phone but it is not answering: unplug and replug the cable, or toggle Wireless debugging off/on.",
        "Then press Refresh (Droid Swarm reconnects tailnet phones every 30 s).",
      ];
    case "not_connected":
    default:
      return tcp
        ? [
            `Turn the phone on and unlock it; make sure Tailscale is connected on the phone${addr ? ` (this computer dials ${addr})` : ""}.`,
            "After a phone reboot wireless adb is off: plug it in by USB once and run `adb tcpip 5555`, or pair it in Droid Swarm › Setup › Pair (Developer options › Wireless debugging › Pair device with pairing code).",
            "Or plug it in by USB with Developer options › USB debugging on, and accept the prompt on the phone.",
          ]
        : [
            "Plug the phone in by USB (a data cable, not charge-only) and unlock it.",
            "Turn on Developer options › USB debugging, then tap Allow on the “Allow USB debugging?” prompt.",
            "For cable-free posting: enable Wireless debugging and pair it in Droid Swarm › Setup › Pair.",
          ];
  }
}

export function buildPresence(
  device: PhoneDevice,
  live: AdbDeviceInfo | null,
  adbAvailable: boolean,
  now: number,
): DevicePresence {
  const connection: DeviceConnection = !adbAvailable
    ? "adb_unavailable"
    : !live
      ? "not_connected"
      : live.state === "device"
        ? "connected"
        : live.state === "unauthorized"
          ? "unauthorized"
          : live.state === "offline"
            ? "adb_offline"
            : "not_connected";
  const online = connection === "connected";
  const lastSeenAt = online ? now : device.lastHeartbeatAt;
  const transport = (live?.serial ?? device.serial).includes(":") ? "tcp" : "usb";
  const seen = lastSeenAt
    ? `last seen ${agoText(now - lastSeenAt)}`
    : "never reached from this computer";
  const summary =
    connection === "connected"
      ? `Connected over ${transport === "tcp" ? "wireless adb" : "USB"}`
      : connection === "unauthorized"
        ? `Waiting for “Allow USB debugging” on the phone — ${seen}`
        : connection === "adb_offline"
          ? `adb lists it as offline — ${seen}`
          : connection === "adb_unavailable"
            ? `adb unavailable on this computer — ${seen}`
            : `Not connected — ${seen}`;
  return {
    deviceId: device.id,
    label: device.label,
    serial: live?.serial ?? device.serial,
    transport,
    connection,
    online,
    adbState: live ? live.state : "absent",
    lastSeenAt,
    heartbeatAgeMs: lastSeenAt ? Math.max(0, now - lastSeenAt) : null,
    checkedAt: now,
    summary,
    fix: fixSteps(connection, device),
    screen: null,
  };
}

/**
 * Parses the `device.screen` command output (dumpsys power / window /
 * activity greps). Every marker is optional: different Android builds print
 * different subsets, and unknown stays null rather than guessed.
 */
export function parseScreenState(out: string): ScreenState {
  const text = String(out ?? "");
  let awake: boolean | null = null;
  const wake = /mWakefulness=(\w+)/.exec(text)?.[1];
  if (wake) awake = /^awake$/i.test(wake);
  const disp = /Display Power: state=(\w+)/.exec(text)?.[1];
  if (disp) awake = awake === false ? false : /^on$/i.test(disp);
  let locked: boolean | null = null;
  for (const re of [
    /mShowingLockscreen=(true|false)/,
    /isStatusBarKeyguard=(true|false)/,
    /mKeyguardShowing=(true|false)/,
    /mDreamingLockscreen=(true|false)/,
  ]) {
    const m = re.exec(text);
    if (m) locked = (locked ?? false) || m[1] === "true";
  }
  let foreground: string | null = null;
  const focus = /mCurrentFocus=Window\{[^}]*?\s([a-zA-Z0-9_.]+)\/[^\s}]+\}/.exec(text);
  if (focus) foreground = focus[1];
  if (!foreground) {
    const top =
      /(?:topResumedActivity|mResumedActivity)[^\n]*?\s([a-zA-Z0-9_.]+)\/[a-zA-Z0-9_.$]+/.exec(
        text,
      );
    if (top) foreground = top[1];
  }
  if (
    !foreground &&
    /mCurrentFocus=Window\{[^}]*(StatusBar|NotificationShade|Keyguard)/i.test(text)
  ) {
    foreground = "com.android.systemui";
  }
  return { awake, locked, foreground };
}

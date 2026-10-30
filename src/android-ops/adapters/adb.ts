/**
 * ADB-backed device control adapter.
 *
 * Real implementation for when handsets are actually attached. Everything is
 * routed through {@link assertAllowedCommand}, so a caller cannot dispatch a
 * shell string of its own choosing — only the named operations in the
 * compliance allow-list, each mapped to a fixed argv here.
 *
 * The binary is resolved through the shared `bin-detect` helpers because the
 * gateway daemon runs with a stripped PATH (a plain `adb` spawn reports
 * "not installed" on a machine where adb is clearly present).
 */

import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { enrichedPathEnv, resolveBin } from "../../agents/coder-backend/bin-detect.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { assertAllowedCommand } from "../compliance.js";
import type {
  AdapterAvailability,
  AdbDeviceInfo,
  CaptureResult,
  DeviceCommand,
  DeviceCommandResult,
  DeviceControlAdapter,
  HealthSample,
  LogBundleResult,
} from "./types.js";
import type { AdbState } from "../types.js";
import { coerceString } from "../../shared/text/coerce.js";

const execFileAsync = promisify(execFile);
const log = createSubsystemLogger("android-ops");

/** Every path MediaStore may have recorded for a file pushed under /sdcard/. */
export function mediaStorePaths(devicePath: string): string[] {
  const rel = /^\/sdcard\/(.+)$/.exec(devicePath)?.[1];
  if (!rel) return [devicePath];
  return [`/storage/emulated/0/${rel}`, `/sdcard/${rel}`];
}

function adbInputText(value: unknown): string {
  const escaped = coerceString(value).replace(/%/g, "%25").replace(/\s/g, "%s");
  /* `adb shell` joins argv and hands it to the device's sh, so anything beyond
     plain word characters must be single-quoted: an unquoted "#tag" would be
     read as a comment and "&", ";", "$(...)" would be shell syntax. */
  return /^[A-Za-z0-9%._@:,/+=-]*$/.test(escaped) ? escaped : `'${escaped.replace(/'/g, "'\\''")}'`;
}

function packageArg(args: Record<string, unknown>): string {
  return typeof args.package === "string" ? args.package : "";
}

/** Fixed argv per allowed command — no caller-supplied shell strings. */
const COMMAND_ARGV: Record<string, (args: Record<string, unknown>) => string[]> = {
  "health.battery": () => ["shell", "dumpsys", "battery"],
  "health.storage": () => ["shell", "df", "/data"],
  "health.wifi": () => ["shell", "dumpsys", "wifi"],
  "health.uptime": () => ["shell", "uptime"],
  "app.version": (a) => ["shell", "dumpsys", "package", coerceString(a.package)],
  "app.launch": (a) => [
    "shell",
    "monkey",
    "-p",
    coerceString(a.package),
    "-c",
    "android.intent.category.LAUNCHER",
    "1",
  ],
  "app.install": (a) => ["install", "-r", coerceString(a.apk)],
  "app.stop": (a) => ["shell", "am", "force-stop", packageArg(a)],
  "app.uninstall": (a) => ["uninstall", packageArg(a)],
  /* the resumed activity, i.e. what is on screen right now */
  "app.current": () => ["shell", "dumpsys", "activity", "activities"],
  "app.list": () => ["shell", "pm", "list", "packages", "-3"],
  "device.props": () => ["shell", "getprop"],
  "health.network": () => ["shell", "ip", "-o", "addr", "show"],
  "media.push": (a) => ["push", coerceString(a.src), coerceString(a.dest, "/sdcard/Movies/")],
  "media.cleanup": (a) => ["shell", "rm", "-f", coerceString(a.path)],
  /* exact byte size of a pushed file (`stat` prints nothing + exits 1 when absent) */
  "media.stat": (a) => ["shell", "stat", "-c", "%s", coerceString(a.path)],
  "post.prepare": (a) => [
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    coerceString(a.uri),
  ],
  /* Posting queue (content-studio → droid-swarm publisher): index a pushed
     file so apps can see it, look up its MediaStore id, and hand it to the
     target app's share/compose screen. Paths/URIs/packages are validated in
     the service before they reach these argv builders. */
  "media.scan": (a) => [
    "shell",
    "am",
    "broadcast",
    "-a",
    "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
    "-d",
    /* The canonical path: on a real Android 11 phone a scan of the /sdcard
       symlink only inserted a bare row (_size/duration NULL, forever), while
       the same broadcast for /storage/emulated/0/… ran the full scan. A scan
       of a deleted file drops its row, so this also cleans up. */
    `file://${mediaStorePaths(coerceString(a.path))[0]}`,
  ],
  "media.query": (a) => [
    "shell",
    "content",
    "query",
    "--uri",
    "content://media/external/video/media",
    "--projection",
    "_id:_size:duration",
    "--where",
    /* MediaStore records the canonical /storage/emulated/<user>/… path, never
       the /sdcard symlink the file was pushed to: a bare `_data='/sdcard/…'`
       matched nothing on a real Android 11 phone, the share fell back to a
       file:// URI Instagram cannot open, and the composer never appeared.
       Match both spellings. ONE argv element: adb joins args unquoted, so the
       double quotes keep the clause together for the device shell (paths are
       validated to [A-Za-z0-9._/-] in the service, no quote can sneak in). */
    `"${mediaStorePaths(coerceString(a.path))
      .map((p) => `_data='${p}'`)
      .join(" OR ")}"`,
  ],
  "post.share": (a) => [
    "shell",
    "am",
    "start",
    "-a",
    "android.intent.action.SEND",
    "-t",
    coerceString(a.mime, "video/mp4"),
    "--eu",
    "android.intent.extra.STREAM",
    coerceString(a.uri),
    "--grant-read-uri-permission",
    ...(a.component ? ["-n", coerceString(a.component)] : ["-p", coerceString(a.package)]),
  ],
  "post.publish": (a) => ["shell", "input", "keyevent", coerceString(a.keyevent, "KEYCODE_ENTER")],
  "post.verify": (a) => ["shell", "dumpsys", "activity", "activities", coerceString(a.filter)],
  "session.check": (a) => ["shell", "pm", "list", "packages", coerceString(a.package)],
  "screenshot.capture": () => ["exec-out", "screencap", "-p"],
  /* uiautomator writes to a file, so dump and read it in one shot — two round
     trips over a tailnet is a visible pause between every automated action. */
  /* ONE argv element: adb joins its arguments with spaces and does NOT
     re-quote them ("just like ssh"), so the old `sh -c "<script>"` form
     reached the handset as `sh -c uiautomator dump …` — the inner shell ran a
     bare `uiautomator` and the dump read back a stale (or missing) file. The
     stale file is removed first so a failed dump can never pass for the
     current screen. */
  "ui.dump": () => [
    "exec-out",
    "rm -f /sdcard/ao_ui.xml; uiautomator dump /sdcard/ao_ui.xml >/dev/null 2>&1 && cat /sdcard/ao_ui.xml",
  ],
  "device.screen": () => [
    "shell",
    "dumpsys power | grep -E 'mWakefulness=|Display Power: state='; " +
      "dumpsys window | grep -E 'mCurrentFocus=|mShowingLockscreen|mDreamingLockscreen|isStatusBarKeyguard'; " +
      "dumpsys activity activities | grep -E 'mKeyguardShowing=|topResumedActivity|mResumedActivity'",
  ],
  /* is the soft keyboard up? (read-only; never dismissed with BACK, which can pop the screen) */
  "device.ime": () => ["shell", "dumpsys input_method | grep -E 'mInputShown='"],
  "logs.pull": (a) => ["logcat", "-d", "-t", coerceString(a.lines, "400")],
  "ui.tap": (a) => ["shell", "input", "tap", coerceString(a.x), coerceString(a.y)],
  "ui.swipe": (a) => [
    "shell",
    "input",
    "swipe",
    coerceString(a.x1),
    coerceString(a.y1),
    coerceString(a.x2),
    coerceString(a.y2),
    coerceString(a.durationMs, "300"),
  ],
  "ui.text": (a) => ["shell", "input", "text", adbInputText(a.text)],
  "ui.keyevent": (a) => ["shell", "input", "keyevent", coerceString(a.keyevent)],
};

export class AdbDeviceAdapter implements DeviceControlAdapter {
  readonly id = "adb";
  readonly kind = "adb" as const;
  private bundleDir: string;
  private cachedProbe: AdapterAvailability | null = null;

  constructor(bundleDir: string) {
    this.bundleDir = bundleDir;
    mkdirSync(bundleDir, { recursive: true });
  }

  private bin(): string | null {
    return resolveBin("adb") ?? null;
  }

  async probe(): Promise<AdapterAvailability> {
    const now = Date.now();
    const bin = this.bin();
    if (!bin) {
      return {
        available: false,
        version: null,
        binPath: null,
        reason: "adb not found on PATH — install android-platform-tools to enable device control",
        checkedAt: now,
      };
    }
    try {
      const { stdout } = await execFileAsync(bin, ["version"], {
        env: enrichedPathEnv(),
        timeout: 8000,
      });
      const version = stdout.split("\n")[0]?.trim() || "adb";
      this.cachedProbe = { available: true, version, binPath: bin, reason: null, checkedAt: now };
      return this.cachedProbe;
    } catch (e) {
      return { available: false, version: null, binPath: bin, reason: String(e), checkedAt: now };
    }
  }

  async listDevices(): Promise<AdbDeviceInfo[]> {
    const bin = this.bin();
    if (!bin) return [];
    try {
      const { stdout } = await execFileAsync(bin, ["devices", "-l"], {
        env: enrichedPathEnv(),
        timeout: 10_000,
      });
      const devices: AdbDeviceInfo[] = stdout
        .split("\n")
        .slice(1)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [serial, rawState, ...rest] = line.split(/\s+/);
          const meta = rest.join(" ");
          const model = /model:(\S+)/.exec(meta)?.[1] ?? null;
          const state: AdbState =
            rawState === "device" || rawState === "unauthorized" || rawState === "offline"
              ? rawState
              : "absent";
          return {
            serial,
            state,
            model,
            transport: serial.includes(":") ? ("tcp" as const) : ("usb" as const),
            androidId: null as string | null,
          };
        });
      // Learn the stable ANDROID_ID for every handset we're actually authorized
      // to talk to. This is the key registration/reconciliation match on, so a
      // phone that re-paired under a new serial resolves to its existing row.
      for (const d of devices) {
        if (d.state === "device") d.androidId = await this.readAndroidId(d.serial);
      }
      return devices;
    } catch (e) {
      log.warn("adb devices failed", { error: String(e) });
      return [];
    }
  }

  /** `settings get secure android_id` — the stable per-install identity. */
  private async readAndroidId(serial: string): Promise<string | null> {
    const bin = this.bin();
    if (!bin) return null;
    try {
      const { stdout } = await execFileAsync(
        bin,
        ["-s", serial, "shell", "settings", "get", "secure", "android_id"],
        { env: enrichedPathEnv(), timeout: 8000 },
      );
      const value = stdout.trim();
      return /^[0-9a-f]{8,20}$/i.test(value) ? value.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  private async runAdb(
    args: string[],
    command: string,
    timeoutMs = 20_000,
  ): Promise<DeviceCommandResult> {
    const started = Date.now();
    const bin = this.bin();
    const base: DeviceCommandResult = {
      ok: false,
      command,
      stdout: "",
      stderr: "",
      durationMs: 0,
      reason: null,
    };
    if (!bin) return { ...base, reason: "adb unavailable" };
    try {
      const { stdout, stderr } = await execFileAsync(bin, args, {
        env: enrichedPathEnv(),
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
      const text = `${stdout}\n${stderr}`.trim();
      const ok =
        command === "adb.connect"
          ? /connected to|already connected/i.test(text)
          : command === "adb.pair"
            ? /successfully paired|already paired/i.test(text)
            : true;
      return {
        ...base,
        ok,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        reason: ok ? null : text || `${command} did not report success`,
      };
    } catch (e) {
      return { ...base, durationMs: Date.now() - started, reason: String(e) };
    }
  }

  async connect(serial: string): Promise<DeviceCommandResult> {
    return this.runAdb(["connect", serial], "adb.connect", 20_000);
  }

  async pair(hostPort: string, pairingCode: string): Promise<DeviceCommandResult> {
    return this.runAdb(["pair", hostPort, pairingCode], "adb.pair", 30_000);
  }

  async readHealth(serial: string): Promise<HealthSample> {
    const empty: HealthSample = {
      ok: false,
      reason: null,
      batteryPct: null,
      charging: null,
      storageFreeMb: null,
      storageTotalMb: null,
      wifiSsid: null,
      wifiSignalDbm: null,
      status: "offline",
    };
    const battery = await this.runCommand(serial, { command: "health.battery" });
    if (!battery.ok) return { ...empty, reason: battery.reason ?? "device unreachable" };

    const level = Number(/level:\s*(\d+)/.exec(battery.stdout)?.[1] ?? NaN);
    const plugged = Number(/plugged:\s*(\d+)/.exec(battery.stdout)?.[1] ?? 0);

    const storage = await this.runCommand(serial, { command: "health.storage" });
    const dfLine = storage.stdout.split("\n").find((l) => l.includes("/data"));
    const cols = dfLine?.trim().split(/\s+/) ?? [];
    const totalKb = Number(cols[1] ?? NaN);
    const availKb = Number(cols[3] ?? NaN);

    const wifi = await this.runCommand(serial, { command: "health.wifi" });
    const ssid = /SSID:\s*"?([^",\n]+)"?/.exec(wifi.stdout)?.[1]?.trim() ?? null;
    const rssi = Number(/RSSI:\s*(-?\d+)/.exec(wifi.stdout)?.[1] ?? NaN);

    return {
      ok: true,
      reason: null,
      batteryPct: Number.isFinite(level) ? level : null,
      charging: plugged > 0,
      storageFreeMb: Number.isFinite(availKb) ? Math.round(availKb / 1024) : null,
      storageTotalMb: Number.isFinite(totalKb) ? Math.round(totalKb / 1024) : null,
      wifiSsid: ssid,
      wifiSignalDbm: Number.isFinite(rssi) ? rssi : null,
      status: Number.isFinite(level) && level < 20 && plugged === 0 ? "degraded" : "online",
    };
  }

  async runCommand(serial: string, cmd: DeviceCommand): Promise<DeviceCommandResult> {
    assertAllowedCommand(cmd.command);
    const started = Date.now();
    const bin = this.bin();
    const base: DeviceCommandResult = {
      ok: false,
      command: cmd.command,
      stdout: "",
      stderr: "",
      durationMs: 0,
      reason: null,
    };
    if (!bin) return { ...base, reason: "adb unavailable" };

    const build = COMMAND_ARGV[cmd.command];
    if (!build) return { ...base, reason: `no argv mapping for ${cmd.command}` };

    try {
      const { stdout, stderr } = await execFileAsync(
        bin,
        ["-s", serial, ...build(cmd.args ?? {})],
        {
          env: enrichedPathEnv(),
          timeout: cmd.timeoutMs ?? 20_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      return { ...base, ok: true, stdout, stderr, durationMs: Date.now() - started };
    } catch (e) {
      return { ...base, durationMs: Date.now() - started, reason: String(e) };
    }
  }

  async captureScreenshot(serial: string, label: string): Promise<CaptureResult> {
    const bin = this.bin();
    if (!bin) return { ok: false, path: null, reason: "adb unavailable" };
    const safe = label.replace(/[^a-zA-Z0-9._-]/g, "_");
    const dest = join(this.bundleDir, `${safe}-${Date.now()}.png`);
    try {
      const { stdout } = await execFileAsync(bin, ["-s", serial, "exec-out", "screencap", "-p"], {
        env: enrichedPathEnv(),
        timeout: 20_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: "buffer",
      });
      /* execFile not throwing is not the same as a screenshot existing. A
         secure screen — a password field, a payment sheet, a platform's
         verification step — makes screencap return NOTHING, and writing that
         empty buffer out reported a successful capture of a 0-byte file. The
         console then showed "captured 4/4" over a blank frame. */
      const png = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
      if (png.length < 1024 || png[0] !== 0x89 || png[1] !== 0x50) {
        return {
          ok: false,
          path: null,
          reason:
            png.length === 0
              ? "screencap returned nothing — the app marks this screen as secure, or the handset refused the capture"
              : `screencap returned ${png.length} bytes that are not a PNG`,
        };
      }
      const { writeFile } = await import("node:fs/promises");
      await writeFile(dest, png);
      return { ok: true, path: dest, reason: null };
    } catch (e) {
      return { ok: false, path: null, reason: String(e) };
    }
  }

  async pullLogs(serial: string, sinceMs: number): Promise<LogBundleResult> {
    const result = await this.runCommand(serial, {
      command: "logs.pull",
      args: { lines: Math.min(2000, Math.max(100, Math.round(sinceMs / 1000))) },
    });
    if (!result.ok) return { ok: false, bundleRef: null, entries: [], reason: result.reason };
    const entries = result.stdout.split("\n").filter(Boolean).slice(-200);
    return { ok: true, bundleRef: `bundle://adb/${serial}/${Date.now()}`, entries, reason: null };
  }

  /** Files written into the bundle directory — surfaced by the Ops panel. */
  async listBundles(): Promise<string[]> {
    try {
      return (await readdir(this.bundleDir)).sort().reverse().slice(0, 50);
    } catch {
      return [];
    }
  }

  async readBundle(name: string): Promise<Buffer | null> {
    if (name.includes("/") || name.includes("..")) return null;
    try {
      return await readFile(join(this.bundleDir, name));
    } catch {
      return null;
    }
  }
}

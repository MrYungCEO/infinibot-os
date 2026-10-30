/**
 * Desktop control of THIS device: info, screenshot, mouse/keyboard.
 *
 * These run on whichever gateway receives them. The master reaches a
 * satellite's desktop with `federation.node.invoke { nodeId, method:
 * "device.screenshot" | "device.input" | "device.info" }`, which the satellite
 * runs locally (satellite-proxy-listener) — so the same RPCs serve the local
 * UI and remote control.
 *
 * Backends (no native modules; commands run with execFile, never a shell):
 *   screenshot  Windows: PowerShell + System.Drawing CopyFromScreen
 *               macOS:   screencapture -x
 *               Linux:   grim (Wayland) | import | xwd→ffmpeg | ffmpeg x11grab
 *   input       Windows: PowerShell + user32 (SetCursorPos/mouse_event) + SendKeys
 *               Linux:   xdotool (X11)
 *               macOS:   osascript (keystrokes/typing only)
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  collectDeviceCapabilities,
  detectScreenshotBackend,
  onPath,
} from "../../federation/device-capabilities.js";
import type { GatewayRequestHandlers } from "./types.js";

const execFileAsync = promisify(execFile);

function powershellArgs(script: string): string[] {
  // -EncodedCommand takes UTF-16LE base64 — no quoting problems.
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

function tmpFile(ext: string): string {
  return path.join(os.tmpdir(), `infinibot-screen-${process.pid}-${Date.now()}.${ext}`);
}

async function readAndRemove(file: string): Promise<Buffer> {
  const buf = await fs.promises.readFile(file);
  await fs.promises.rm(file, { force: true });
  return buf;
}

/** PNG width/height from the IHDR chunk. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export async function captureScreenPng(
  opts: { maxWidth?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ png: Buffer; backend: string }> {
  const maxWidth = opts.maxWidth && opts.maxWidth > 0 ? Math.floor(opts.maxWidth) : 0;
  const backend = detectScreenshotBackend(env);
  if (!backend) {
    throw new Error(
      process.platform === "linux"
        ? "No screen to capture: this device has no graphical session (DISPLAY/WAYLAND_DISPLAY), or no screenshot tool (grim, ImageMagick import, xwd) is installed."
        : "Screen capture is not available on this device.",
    );
  }
  const out = tmpFile("png");
  if (backend === "powershell") {
    const script = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$max = ${maxWidth}
if ($max -gt 0 -and $bmp.Width -gt $max) {
  $h = [int]($bmp.Height * $max / $bmp.Width)
  $small = New-Object System.Drawing.Bitmap $bmp, $max, $h
  $small.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
} else {
  $bmp.Save('${out.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
}`;
    await execFileAsync("powershell.exe", powershellArgs(script), {
      timeout: 20_000,
      windowsHide: true,
    });
    return { png: await readAndRemove(out), backend };
  }
  if (backend === "screencapture") {
    await execFileAsync("screencapture", ["-x", "-t", "png", out], { timeout: 15_000 });
    return { png: await readAndRemove(out), backend };
  }
  if (backend === "grim") {
    await execFileAsync("grim", [out], { timeout: 15_000, env });
    return { png: await scaleIfNeeded(await readAndRemove(out), maxWidth), backend };
  }
  if (backend === "import") {
    await execFileAsync("import", ["-silent", "-window", "root", out], { timeout: 15_000, env });
    return { png: await scaleIfNeeded(await readAndRemove(out), maxWidth), backend };
  }
  // xwd / ffmpeg fallbacks (X11)
  const vf = maxWidth ? ["-vf", `scale='min(${maxWidth},iw)':-2`] : [];
  if (onPath("ffmpeg", env)) {
    try {
      await execFileAsync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "x11grab",
          "-i",
          env.DISPLAY ?? ":0",
          "-frames:v",
          "1",
          ...vf,
          "-y",
          out,
        ],
        { timeout: 15_000, env },
      );
      return { png: await readAndRemove(out), backend: "ffmpeg-x11grab" };
    } catch {
      /* try xwd */
    }
  }
  if (backend === "xwd" && onPath("ffmpeg", env)) {
    const xwdFile = tmpFile("xwd");
    await execFileAsync("xwd", ["-root", "-silent", "-out", xwdFile], { timeout: 15_000, env });
    try {
      await execFileAsync(
        "ffmpeg",
        ["-hide_banner", "-loglevel", "error", "-f", "xwd_pipe", "-i", xwdFile, ...vf, "-y", out],
        {
          timeout: 15_000,
        },
      );
    } finally {
      await fs.promises.rm(xwdFile, { force: true });
    }
    return { png: await readAndRemove(out), backend: "xwd" };
  }
  throw new Error(`Screen capture failed: ${backend} is present but could not produce an image.`);
}

async function scaleIfNeeded(png: Buffer, maxWidth: number): Promise<Buffer> {
  const size = pngSize(png);
  if (!maxWidth || !size || size.width <= maxWidth || !onPath("ffmpeg")) return png;
  const inFile = tmpFile("png");
  const outFile = tmpFile("png");
  await fs.promises.writeFile(inFile, png);
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inFile,
        "-vf",
        `scale=${maxWidth}:-2`,
        "-y",
        outFile,
      ],
      {
        timeout: 15_000,
      },
    );
    return await readAndRemove(outFile);
  } catch {
    return png;
  } finally {
    await fs.promises.rm(inFile, { force: true });
  }
}

export type DeviceInputAction =
  | { action: "move"; x: number; y: number }
  | {
      action: "click";
      x?: number;
      y?: number;
      button?: "left" | "right" | "middle";
      double?: boolean;
    }
  | { action: "type"; text: string }
  | { action: "key"; key: string };

const SENDKEYS_MAP: Record<string, string> = {
  enter: "{ENTER}",
  return: "{ENTER}",
  tab: "{TAB}",
  escape: "{ESC}",
  esc: "{ESC}",
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  up: "{UP}",
  down: "{DOWN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  home: "{HOME}",
  end: "{END}",
  space: " ",
};

function escapeSendKeys(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`);
}

/** Validate untrusted RPC params into an input action (throws on bad input). */
export function parseInputAction(raw: unknown): DeviceInputAction {
  const p = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, name: string) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000)
      throw new Error(`${name} must be a screen coordinate`);
    return Math.round(v);
  };
  switch (p.action) {
    case "move":
      return { action: "move", x: num(p.x, "x"), y: num(p.y, "y") };
    case "click": {
      const button = p.button === "right" || p.button === "middle" ? p.button : "left";
      const hasPos = p.x !== undefined || p.y !== undefined;
      return {
        action: "click",
        ...(hasPos ? { x: num(p.x, "x"), y: num(p.y, "y") } : {}),
        button,
        double: p.double === true,
      };
    }
    case "type":
      if (typeof p.text !== "string" || !p.text || p.text.length > 4000)
        throw new Error("text must be 1-4000 characters");
      return { action: "type", text: p.text };
    case "key":
      if (typeof p.key !== "string" || !/^[A-Za-z0-9+_-]{1,40}$/.test(p.key))
        throw new Error("key must be a key name like Enter, ctrl+c, F5");
      return { action: "key", key: p.key };
    default:
      throw new Error('action must be one of "move", "click", "type", "key"');
  }
}

export async function performInput(
  act: DeviceInputAction,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (process.platform === "win32") {
    const pre = `Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class IbInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
'@
`;
    let body = "";
    if (act.action === "move") body = `[IbInput]::SetCursorPos(${act.x}, ${act.y}) | Out-Null`;
    else if (act.action === "click") {
      const [down, up] =
        act.button === "right"
          ? [0x08, 0x10]
          : act.button === "middle"
            ? [0x20, 0x40]
            : [0x02, 0x04];
      const pos =
        act.x !== undefined ? `[IbInput]::SetCursorPos(${act.x}, ${act.y}) | Out-Null\n` : "";
      const once = `[IbInput]::mouse_event(${down},0,0,0,[UIntPtr]::Zero); [IbInput]::mouse_event(${up},0,0,0,[UIntPtr]::Zero)`;
      body = pos + once + (act.double ? `\n${once}` : "");
    } else if (act.action === "type") {
      body = `[System.Windows.Forms.SendKeys]::SendWait('${escapeSendKeys(act.text).replace(/'/g, "''")}')`;
    } else {
      body = `[System.Windows.Forms.SendKeys]::SendWait('${windowsKeyChord(act.key).replace(/'/g, "''")}')`;
    }
    await execFileAsync("powershell.exe", powershellArgs(pre + body), {
      timeout: 15_000,
      windowsHide: true,
    });
    return "powershell";
  }
  if (process.platform === "darwin") {
    if (act.action === "type") {
      await execFileAsync("osascript", [
        "-e",
        `tell application "System Events" to keystroke ${JSON.stringify(act.text)}`,
      ]);
      return "osascript";
    }
    throw new Error("Mouse control on macOS is not supported yet; typing works.");
  }
  if (!env.DISPLAY || !onPath("xdotool", env)) {
    throw new Error(
      "Mouse/keyboard control on Linux needs an X11 session and xdotool (sudo apt install xdotool).",
    );
  }
  const args =
    act.action === "move"
      ? ["mousemove", String(act.x), String(act.y)]
      : act.action === "click"
        ? [
            ...(act.x !== undefined ? ["mousemove", String(act.x), String(act.y)] : []),
            "click",
            ...(act.double ? ["--repeat", "2"] : []),
            act.button === "right" ? "3" : act.button === "middle" ? "2" : "1",
          ]
        : act.action === "type"
          ? ["type", "--", act.text]
          : ["key", "--", act.key];
  await execFileAsync("xdotool", args, { timeout: 15_000, env });
  return "xdotool";
}

function windowsKeyChord(key: string): string {
  const parts = key.toLowerCase().split("+");
  const base = parts.pop() ?? "";
  const mods = parts
    .map((m) =>
      m === "ctrl" || m === "control" ? "^" : m === "alt" ? "%" : m === "shift" ? "+" : "",
    )
    .join("");
  const mapped =
    SENDKEYS_MAP[base] ??
    (/^f\d{1,2}$/.test(base)
      ? `{${base.toUpperCase()}}`
      : base.length === 1
        ? base
        : `{${base.toUpperCase()}}`);
  return mods + mapped;
}

export const deviceControlHandlers: GatewayRequestHandlers = {
  /** Hostname, OS, CPU, RAM and the feature flags of THIS device. */
  "device.info": async ({ respond }) => {
    respond(true, collectDeviceCapabilities());
  },

  /** PNG screenshot of THIS device's screen, base64. Params: { maxWidth? } */
  "device.screenshot": async ({ params, respond }) => {
    try {
      const maxWidth = typeof params?.maxWidth === "number" ? params.maxWidth : 1600;
      const { png, backend } = await captureScreenPng({ maxWidth });
      const size = pngSize(png);
      respond(true, {
        mime: "image/png",
        base64: png.toString("base64"),
        bytes: png.length,
        width: size?.width,
        height: size?.height,
        backend,
        hostname: os.hostname(),
        capturedAt: Date.now(),
      });
    } catch (err) {
      respond(false, undefined, {
        code: "SCREENSHOT_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /** Mouse/keyboard on THIS device. Params: { action: move|click|type|key, ... } */
  "device.input": async ({ params, respond }) => {
    let act: DeviceInputAction;
    try {
      act = parseInputAction(params);
    } catch (err) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    try {
      const backend = await performInput(act);
      respond(true, { ok: true, action: act.action, backend });
    } catch (err) {
      respond(false, undefined, {
        code: "INPUT_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

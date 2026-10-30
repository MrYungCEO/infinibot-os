/**
 * What this device can do for the master, sent in the satellite's
 * registration manifest (`capabilities.device`).
 *
 * Detection is cheap and synchronous (file-existence checks on PATH, `os`
 * module); nothing is executed. The master UI uses it to show the device and
 * to decide which actions (terminal, run command, screenshot, files, browser,
 * coder spawn) to offer.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DeviceCapabilities {
  hostname: string;
  os: { platform: NodeJS.Platform; type: string; release: string; arch: string };
  cpu: { model: string; cores: number };
  memoryMB: number;
  gpu?: { name: string; vramMB?: number };
  /** Feature flags the master can act on. */
  features: {
    terminal: boolean;
    exec: boolean;
    screenshot: boolean;
    input: boolean;
    files: boolean;
    browser: boolean;
    voice: boolean;
  };
  /** Coding CLIs found on PATH (claude, codex, gemini, opencode, grok). */
  clis: string[];
  /** How screenshots are taken on this device (for diagnostics). */
  screenshotBackend?: string;
  /** Running inside the desktop (Electron) app. */
  desktopApp: boolean;
  collectedAt: number;
}

const CODER_CLIS = ["claude", "codex", "gemini", "opencode", "grok"];

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  return raw.split(path.delimiter).filter(Boolean);
}

/** True when `name` resolves to a file on PATH (adds Windows extensions). */
export function onPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): boolean {
  const exts =
    platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.PS1").split(";").concat([""]) : [""];
  for (const dir of pathDirs(env)) {
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(dir, name + ext.toLowerCase())).isFile()) return true;
      } catch {
        /* keep looking */
      }
      if (ext) {
        try {
          if (fs.statSync(path.join(dir, name + ext)).isFile()) return true;
        } catch {
          /* keep looking */
        }
      }
    }
  }
  return false;
}

/** Which tool this device would use to capture its screen, or undefined. */
export function detectScreenshotBackend(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): string | undefined {
  if (platform === "win32") return "powershell"; // System.Drawing CopyFromScreen
  if (platform === "darwin") return "screencapture";
  // Linux: needs a display. Wayland compositors usually ship grim; X11 any of these.
  if (env.WAYLAND_DISPLAY && onPath("grim", env, platform)) return "grim";
  if (env.DISPLAY) {
    for (const tool of ["import", "xwd", "scrot", "gnome-screenshot"]) {
      if (onPath(tool, env, platform)) return tool;
    }
  }
  return undefined;
}

function detectInput(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return true; // PowerShell SendKeys / user32 via Add-Type
  if (platform === "darwin") return true; // osascript
  return Boolean(env.DISPLAY) && onPath("xdotool", env, platform);
}

function detectBrowser(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (env.CHROME_PATH && fs.existsSync(env.CHROME_PATH)) return true;
  if (platform === "win32") {
    const roots = [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
      Boolean,
    ) as string[];
    return roots.some(
      (r) =>
        fs.existsSync(path.join(r, "Google", "Chrome", "Application", "chrome.exe")) ||
        fs.existsSync(path.join(r, "Microsoft", "Edge", "Application", "msedge.exe")),
    );
  }
  if (platform === "darwin") {
    return (
      fs.existsSync("/Applications/Google Chrome.app") ||
      fs.existsSync("/Applications/Chromium.app") ||
      fs.existsSync("/Applications/Microsoft Edge.app")
    );
  }
  return [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
  ].some((b) => onPath(b, env, platform));
}

function detectTerminal(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return true; // ConPTY / powershell
  return (
    onPath("tmux", env, platform) || onPath("bash", env, platform) || onPath("sh", env, platform)
  );
}

export function collectDeviceCapabilities(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DeviceCapabilities {
  const cpus = os.cpus() ?? [];
  const screenshotBackend = detectScreenshotBackend(env, platform);
  const gpuName = env.INFINIBOT_GPU_NAME?.trim();
  return {
    hostname: os.hostname(),
    os: { platform, type: os.type(), release: os.release(), arch: os.arch() },
    cpu: { model: cpus[0]?.model?.trim() || "unknown", cores: cpus.length },
    memoryMB: Math.round(os.totalmem() / (1024 * 1024)),
    ...(gpuName ? { gpu: { name: gpuName } } : {}),
    features: {
      terminal: detectTerminal(env, platform),
      exec: true,
      screenshot: Boolean(screenshotBackend),
      input: detectInput(env, platform),
      files: true,
      browser: detectBrowser(env, platform),
      voice: Boolean(env.INFINIBOT_LOCAL_VOICE === "1"),
    },
    clis: CODER_CLIS.filter((c) => onPath(c, env, platform)),
    ...(screenshotBackend ? { screenshotBackend } : {}),
    desktopApp: Boolean(env.INFINIBOT_DESKTOP_APP === "1" || env.ELECTRON_RUN_AS_NODE),
    collectedAt: Date.now(),
  };
}

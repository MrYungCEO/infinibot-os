import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

import { ensurePortAvailable } from "../infra/ports.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CONFIG_DIR } from "../utils.js";
import { getHeadersWithAuth, normalizeCdpWsUrl } from "./cdp.js";
import { appendCdpPath, type CdpSendFn, withCdpSocket } from "./cdp.helpers.js";
import {
  type BrowserExecutable,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
import {
  decorateClawdProfile,
  ensureProfileCleanExit,
  isProfileDecorated,
} from "./chrome.profile-decoration.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";
import { ensureInstalledExtension, resolveBundledExtensionDir } from "./extension-assets.js";
import { DEFAULT_CLAWD_BROWSER_COLOR, DEFAULT_CLAWD_BROWSER_PROFILE_NAME } from "./constants.js";
import { hostedChromeArgs, isHostedBrowser } from "./hosted.js";
import {
  acquireProfileLock,
  releaseProfileLock,
  SECURE_BROWSER_PROFILE,
  userDataDirForManagedProfile,
  wipeSecureProfile,
} from "./agent/profile-store.js";
import {
  backupSessionCookies,
  restoreSessionCookies,
  SESSION_COOKIE_BACKUP_INTERVAL_MS,
} from "./agent/session-cookies.js";

const log = createSubsystemLogger("browser").child("chrome");

export type { BrowserExecutable } from "./chrome.executables.js";
export {
  findChromeExecutableLinux,
  findChromeExecutableMac,
  findChromeExecutableWindows,
  resolveBrowserExecutableForPlatform,
} from "./chrome.executables.js";
export {
  decorateClawdProfile,
  ensureProfileCleanExit,
  isProfileDecorated,
} from "./chrome.profile-decoration.js";

function exists(filePath: string) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

export type RunningChrome = {
  pid: number;
  exe: BrowserExecutable;
  userDataDir: string;
  cdpPort: number;
  startedAt: number;
  proc: ChildProcessWithoutNullStreams;
  /** Managed profile name ("clawd", "work", "secure"…). */
  profileName?: string;
  /** Periodic session-cookie backup (not for the secure profile). */
  cookieTimer?: NodeJS.Timeout;
};

function resolveBrowserExecutable(resolved: ResolvedBrowserConfig): BrowserExecutable | null {
  return resolveBrowserExecutableForPlatform(resolved, process.platform);
}

export function resolveClawdUserDataDir(profileName = DEFAULT_CLAWD_BROWSER_PROFILE_NAME) {
  return userDataDirForManagedProfile(profileName);
}

async function withChromeBrowserSocket<T>(
  cdpPort: number,
  fn: (send: CdpSendFn) => Promise<T>,
): Promise<T | null> {
  const wsUrl = await getChromeWebSocketUrl(cdpUrlForPort(cdpPort), 800);
  if (!wsUrl) return null;
  return await withCdpSocket(wsUrl, fn);
}

async function backupRunningSessionCookies(running: RunningChrome): Promise<void> {
  if (running.profileName === SECURE_BROWSER_PROFILE) return;
  await withChromeBrowserSocket(running.cdpPort, (send) =>
    backupSessionCookies(send, running.userDataDir),
  ).catch(() => {});
}

function cdpUrlForPort(cdpPort: number) {
  return `http://127.0.0.1:${cdpPort}`;
}

export async function isChromeReachable(cdpUrl: string, timeoutMs = 500): Promise<boolean> {
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  return Boolean(version);
}

type ChromeVersion = {
  webSocketDebuggerUrl?: string;
  Browser?: string;
  "User-Agent"?: string;
};

async function fetchChromeVersion(cdpUrl: string, timeoutMs = 500): Promise<ChromeVersion | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const versionUrl = appendCdpPath(cdpUrl, "/json/version");
    const res = await fetch(versionUrl, {
      signal: ctrl.signal,
      headers: getHeadersWithAuth(versionUrl),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as ChromeVersion;
    if (!data || typeof data !== "object") return null;
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function getChromeWebSocketUrl(
  cdpUrl: string,
  timeoutMs = 500,
): Promise<string | null> {
  const version = await fetchChromeVersion(cdpUrl, timeoutMs);
  const wsUrl = String(version?.webSocketDebuggerUrl ?? "").trim();
  if (!wsUrl) return null;
  return normalizeCdpWsUrl(wsUrl, cdpUrl);
}

async function canOpenWebSocket(wsUrl: string, timeoutMs = 800): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const headers = getHeadersWithAuth(wsUrl);
    const ws = new WebSocket(wsUrl, {
      handshakeTimeout: timeoutMs,
      ...(Object.keys(headers).length ? { headers } : {}),
    });
    const timer = setTimeout(
      () => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        resolve(false);
      },
      Math.max(50, timeoutMs + 25),
    );
    ws.once("open", () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolve(true);
    });
    ws.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function isChromeCdpReady(
  cdpUrl: string,
  timeoutMs = 500,
  handshakeTimeoutMs = 800,
): Promise<boolean> {
  const wsUrl = await getChromeWebSocketUrl(cdpUrl, timeoutMs);
  if (!wsUrl) return false;
  return await canOpenWebSocket(wsUrl, handshakeTimeoutMs);
}

export async function launchClawdChrome(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
): Promise<RunningChrome> {
  if (!profile.cdpIsLoopback) {
    throw new Error(`Profile "${profile.name}" is remote; cannot launch local Chrome.`);
  }
  await ensurePortAvailable(profile.cdpPort);

  const exe = resolveBrowserExecutable(resolved);
  if (!exe) {
    throw new Error(
      "No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).",
    );
  }

  const isSecure = profile.name === SECURE_BROWSER_PROFILE;
  // A secure profile never outlives its browser: start from an empty tmpfs dir.
  if (isSecure) wipeSecureProfile();
  const userDataDir = resolveClawdUserDataDir(profile.name);
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  // Throws when another live InfiniBot process owns this profile.
  acquireProfileLock(userDataDir, { cdpPort: profile.cdpPort });

  const needsDecorate = !isProfileDecorated(
    userDataDir,
    profile.name,
    (profile.color ?? DEFAULT_CLAWD_BROWSER_COLOR).toUpperCase(),
  );

  // Hosted fleet Machine only (empty elsewhere): window size + desktop user agent.
  let hostedArgs: string[] = [];
  if (isHostedBrowser()) {
    let version: string | null = null;
    try {
      version = execFileSync(exe.path, ["--version"], { encoding: "utf8", timeout: 5000 });
    } catch {
      // No version → no user-agent override; the browser still starts.
    }
    hostedArgs = hostedChromeArgs(version);
  }

  // First launch to create preference files if missing, then decorate and relaunch.
  const spawnOnce = () => {
    const args: string[] = [
      `--remote-debugging-port=${profile.cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-features=Translate,MediaRouter",
      "--disable-session-crashed-bubble",
      "--hide-crash-restore-bubble",
      "--password-store=basic",
    ];

    if (resolved.headless) {
      // Best-effort; older Chromes may ignore.
      args.push("--headless=new");
      args.push("--disable-gpu");
    }
    if (resolved.noSandbox) {
      args.push("--no-sandbox");
      args.push("--disable-setuid-sandbox");
    }
    if (process.platform === "linux") {
      args.push("--disable-dev-shm-usage");
    }
    args.push(...hostedArgs);

    // Always open a blank tab to ensure a target exists.
    args.push("about:blank");

    return spawn(exe.path, args, {
      stdio: "pipe",
      env: {
        ...process.env,
        // Reduce accidental sharing with the user's env.
        HOME: os.homedir(),
      },
    });
  };

  const startedAt = Date.now();

  const localStatePath = path.join(userDataDir, "Local State");
  const preferencesPath = path.join(userDataDir, "Default", "Preferences");
  const needsBootstrap = !exists(localStatePath) || !exists(preferencesPath);

  // If the profile doesn't exist yet, bootstrap it once so Chrome creates defaults.
  // Then decorate (if needed) before the "real" run.
  if (needsBootstrap) {
    const bootstrap = spawnOnce();
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (exists(localStatePath) && exists(preferencesPath)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      bootstrap.kill("SIGTERM");
    } catch {
      // ignore
    }
    const exitDeadline = Date.now() + 5000;
    while (Date.now() < exitDeadline) {
      if (bootstrap.exitCode != null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  if (needsDecorate) {
    try {
      decorateClawdProfile(userDataDir, {
        name: profile.name,
        color: profile.color,
      });
      log.info(`🦞 clawd browser profile decorated (${profile.color})`);
    } catch (err) {
      log.warn(`clawd browser profile decoration failed: ${String(err)}`);
    }
  }

  try {
    ensureProfileCleanExit(userDataDir);
  } catch (err) {
    log.warn(`clawd browser clean-exit prefs failed: ${String(err)}`);
  }

  const proc = spawnOnce();
  // Wait for CDP to come up.
  const readyDeadline = Date.now() + 15_000;
  while (Date.now() < readyDeadline) {
    if (await isChromeReachable(profile.cdpUrl, 500)) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!(await isChromeReachable(profile.cdpUrl, 500))) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
    releaseProfileLock(userDataDir);
    throw new Error(
      `Failed to start Chrome CDP on port ${profile.cdpPort} for profile "${profile.name}".`,
    );
  }

  const pid = proc.pid ?? -1;
  log.info(
    `🦞 clawd browser started (${exe.kind}) profile "${profile.name}" on 127.0.0.1:${profile.cdpPort} (pid ${pid})`,
  );

  const running: RunningChrome = {
    pid,
    exe,
    userDataDir,
    cdpPort: profile.cdpPort,
    startedAt,
    proc,
    profileName: profile.name,
  };
  if (!isSecure) {
    const restored = await withChromeBrowserSocket(profile.cdpPort, (send) =>
      restoreSessionCookies(send, userDataDir),
    ).catch(() => 0);
    if (restored) log.info(`restored ${restored} session cookie(s) for profile "${profile.name}"`);
    running.cookieTimer = setInterval(() => {
      void backupRunningSessionCookies(running);
    }, SESSION_COOKIE_BACKUP_INTERVAL_MS);
    running.cookieTimer.unref?.();
  }
  proc.once("exit", () => {
    if (running.cookieTimer) clearInterval(running.cookieTimer);
    releaseProfileLock(userDataDir);
    if (isSecure) wipeSecureProfile();
  });
  return running;
}

export function resolveExtensionAssetsDir(): string | null {
  const installed = path.join(CONFIG_DIR, "browser", "chrome-extension");
  // Refresh the stable copy from the bundled one (first run / app update).
  try {
    const ensured = ensureInstalledExtension({ stateDir: CONFIG_DIR });
    if (ensured) return ensured.path;
  } catch {
    /* read-only state dir: fall through */
  }
  if (exists(path.join(installed, "manifest.json"))) return installed;
  return resolveBundledExtensionDir();
}

export async function launchExtensionChrome(
  resolved: ResolvedBrowserConfig,
  profile: ResolvedBrowserProfile,
): Promise<RunningChrome> {
  if (!profile.cdpIsLoopback) {
    throw new Error(`Profile "${profile.name}" is remote; cannot launch local Chrome.`);
  }
  const extDir = resolveExtensionAssetsDir();
  if (!extDir) {
    throw new Error(
      "InfiniBot Browser Relay extension assets not found. Run `infinibot browser extension install`.",
    );
  }
  const exe = resolveBrowserExecutable(resolved);
  if (!exe) {
    throw new Error(
      "No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).",
    );
  }

  const userDataDir = resolveClawdUserDataDir(profile.name);
  fs.mkdirSync(userDataDir, { recursive: true });

  const args: string[] = [
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${extDir}`,
    "--silent-debugger-extension-api",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=Translate,MediaRouter",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--password-store=basic",
  ];
  if (resolved.noSandbox) {
    args.push("--no-sandbox", "--disable-setuid-sandbox");
  }
  if (process.platform === "linux") {
    args.push("--disable-dev-shm-usage");
  }
  args.push("about:blank");

  const proc = spawn(exe.path, args, {
    stdio: "pipe",
    env: { ...process.env, HOME: os.homedir() },
  });

  const pid = proc.pid ?? -1;
  log.info(
    `🦞 launched Chrome + InfiniBot Browser Relay for profile "${profile.name}" (${exe.kind}, pid ${pid})`,
  );

  return {
    pid,
    exe,
    userDataDir,
    cdpPort: profile.cdpPort,
    startedAt: Date.now(),
    proc,
  };
}

export async function stopClawdChrome(running: RunningChrome, timeoutMs = 5000) {
  const proc = running.proc;
  if (running.cookieTimer) clearInterval(running.cookieTimer);
  if (proc.killed) return;
  // Session cookies are memory-only in Chrome: save them before it quits.
  await backupRunningSessionCookies(running);
  const exited = () => proc.exitCode != null || proc.signalCode != null;
  const waitForExit = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (!exited() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    return exited();
  };

  // Ask Chrome to quit over CDP first. Headless Chrome exits on SIGTERM at once
  // WITHOUT writing its cookie store, so anything signed in to during the last
  // ~30 s would be gone after a restart; Browser.close is a clean shutdown that
  // flushes the profile.
  const cdpUrl = cdpUrlForPort(running.cdpPort);
  try {
    const wsUrl = await getChromeWebSocketUrl(cdpUrl, 500);
    if (wsUrl) {
      await withCdpSocket(wsUrl, async (send) => {
        await Promise.race([
          send("Browser.close").catch(() => {}),
          new Promise((r) => setTimeout(r, 1000)),
        ]);
      }).catch(() => {});
      if (await waitForExit(timeoutMs)) return;
    }
  } catch {
    // fall through to signals
  }

  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (exited()) return;
    if (!(await isChromeReachable(cdpUrl, 200))) {
      await waitForExit(Math.min(timeoutMs, 3000));
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  try {
    proc.kill("SIGKILL");
  } catch {
    // ignore
  }
}

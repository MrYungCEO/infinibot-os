/**
 * Safe Chrome launch helpers — separate from chrome.ts (which already
 * owns the legacy clawd-profile path) so the new manager can compose
 * launch + nav-policy + profile-tooling without inheriting that file's
 * coupling.
 *
 * What "safe" buys you:
 *   - Port-pin: pick a free CDP port if the caller didn't choose one
 *   - Atomic userDataDir creation
 *   - Bounded launch wait — fail fast if Chrome doesn't expose CDP within
 *     the deadline instead of hanging the agent
 *   - Crash detection: SIGCHLD handler that bubbles the exit code so the
 *     manager can log it and decide whether to restart
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";

import { buildChromeArgs, type ChromeArgsOptions } from "./chrome-args.js";

export interface SafeLaunchOptions extends Omit<ChromeArgsOptions, "cdpPort"> {
  /** Absolute path to the Chrome executable. */
  executable: string;
  /** Pin a specific CDP port. Omit to auto-allocate a free one. */
  cdpPort?: number;
  /** How long to wait for Chrome's /json/version to respond. Default 10s. */
  launchTimeoutMs?: number;
  /** Called when Chrome exits, with the exit code (null if killed). */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** Capture stderr lines for diagnostics. Default: dropped. */
  onStderr?: (line: string) => void;
}

export interface RunningSafeChrome {
  pid: number;
  cdpPort: number;
  cdpUrl: string;
  userDataDir: string;
  proc: ChildProcess;
  startedAt: number;
  /**
   * Resolves when /json/version returns a 200 response, meaning DevTools
   * is fully serving — agents can connect without races.
   */
  readyPromise: Promise<void>;
}

/**
 * Spawn Chrome with the canonical args and wait for CDP to come up.
 * Returns immediately with a `readyPromise` you can await — handy if the
 * caller wants to start additional setup work in parallel.
 */
export async function safeLaunchChrome(opts: SafeLaunchOptions): Promise<RunningSafeChrome> {
  fs.mkdirSync(opts.userDataDir, { recursive: true });

  const cdpPort = opts.cdpPort ?? (await pickFreePort());

  const args = buildChromeArgs({
    userDataDir: opts.userDataDir,
    cdpPort,
    startUrl: opts.startUrl,
    headless: opts.headless,
    noSandbox: opts.noSandbox,
    userAgent: opts.userAgent,
    extraArgs: opts.extraArgs,
    suppressFirstRun: opts.suppressFirstRun,
  });

  const proc = spawn(opts.executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  const startedAt = Date.now();

  if (!proc.pid) {
    throw new Error("chrome: spawn returned no pid");
  }

  proc.stderr?.setEncoding("utf-8");
  proc.stderr?.on("data", (chunk: string) => {
    if (!opts.onStderr) return;
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) opts.onStderr(trimmed);
    }
  });
  proc.stdout?.resume(); // drain so it doesn't block

  proc.once("exit", (code, signal) => {
    if (opts.onExit) opts.onExit(code, signal);
  });

  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  const launchTimeoutMs = opts.launchTimeoutMs ?? 10_000;

  const readyPromise = waitForCdp(cdpUrl, launchTimeoutMs).catch(async (err) => {
    // Best effort: kill the orphan if CDP never came up.
    try {
      proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    throw err;
  });

  return {
    pid: proc.pid,
    cdpPort,
    cdpUrl,
    userDataDir: opts.userDataDir,
    proc,
    startedAt,
    readyPromise,
  };
}

/**
 * Pick a free TCP port on localhost. Uses :0 binding then immediately
 * closes; races are possible but acceptable for our single-user dev setup.
 */
export async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = (addr as net.AddressInfo).port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not bind to port 0"));
      }
    });
  });
}

/**
 * Poll /json/version until it responds 200 or the deadline expires.
 * Returns when DevTools is ready for clients.
 */
export async function waitForCdp(cdpUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1_000);
      const res = await fetch(`${cdpUrl}/json/version`, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `chrome: CDP at ${cdpUrl} did not become ready within ${timeoutMs}ms (${attempts} attempts)`,
  );
}

/**
 * Probe whether a CDP endpoint is currently accepting connections.
 * Useful for `attachOnly` flows and the manager's "is it already up?"
 * fast-path.
 */
export async function isCdpUp(cdpUrl: string, timeoutMs = 500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${cdpUrl}/json/version`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Expo Runner — manage a single `expo start` process for the user's
 * mobile companion app and surface its QR / connection URL to the
 * dashboard.
 *
 * The runner mirrors the user's existing `start-tunnel.js` /
 * `start-expo.js` scripts in a user-selected mobile workspace, but instead of
 * inheriting stdio it captures it so we can:
 *   • parse the `exp://...` URL out of Metro's startup banner
 *   • surface lifecycle events (starting → ready → exited)
 *   • write a `.env.local` first so the Expo app boots already pointed
 *     at this gateway with the right token
 *
 * Single-instance: there's exactly one Expo process per gateway. Calling
 * `start` while one is running returns the existing state. Calling
 * `stop` terminates it cleanly.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveInfiniBotPackageRootSync } from "../infra/infinibot-root.js";
import { getTailnetHostname } from "../infra/tailscale.js";

// ── Types ─────────────────────────────────────────────────────

export type ExpoStatus = "stopped" | "starting" | "ready" | "exited" | "error";

export type ExpoMode = "tunnel" | "lan" | "localhost" | "tailscale";

export interface ExpoState {
  status: ExpoStatus;
  /** The exp:// URL Metro printed (for QR + manual entry). */
  url: string | null;
  /** The HTTP devtools URL (typically http://lan-ip:8081). */
  devUrl: string | null;
  /** The Metro mode used for this run. */
  mode: ExpoMode;
  /** Process id — handy for the UI's "stop" button. */
  pid: number | null;
  /** The last 200 lines of stdout/stderr — surfaces in the dashboard. */
  log: string[];
  /** Wall-clock when the process was started. */
  startedAt: number | null;
  /** Filled in when the process exits, abnormally or otherwise. */
  exitCode: number | null;
  /** Captured error message, if start() rejected. */
  error: string | null;
  /** Project dir Expo is running from. */
  projectDir: string;
  /** A setup hint for the user (e.g. "log this computer in to Expo"), or null. */
  notice?: string | null;
  /** Whether this run started expo-cli with EXPO_OFFLINE=1. */
  offline?: boolean;
}

export interface StartExpoOptions {
  /** Override the default Expo project dir (env EXPO_PROJECT_DIR / INFINIBOT_MOBILE_DIR). */
  projectDir?: string;
  /** "tunnel" works across networks; "lan" is faster but same-WiFi only. */
  mode?: ExpoMode;
  /** Metro port. Default 8081. */
  port?: number;
  /** The gateway URL the Expo app should auto-connect to. */
  gatewayUrl?: string;
  /** Auth token / password the Expo app should pre-fill. */
  gatewayToken?: string;
  /** Internal: set when the runner is auto-relaunching in LAN mode after a
   * tunnel failure, so we don't loop the fallback. Not for external callers. */
  _lanFallback?: boolean;
  /**
   * EXPO_OFFLINE policy (config `mobile.expoOffline`): "auto" (default) runs
   * online when expo-cli is logged in, true/false force it. Tunnel mode is
   * always online.
   */
  expoOffline?: ExpoOfflineSetting;
}

export type ExpoOfflineSetting = "auto" | boolean;

/** Is expo-cli logged in on this machine? Reads env + ~/.expo/state.json only (no network). */
export function detectExpoAuth(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): { loggedIn: boolean; via: "token" | "session" | null; username?: string } {
  if (env.EXPO_TOKEN?.trim()) return { loggedIn: true, via: "token" };
  const dir =
    env.__UNSAFE_EXPO_HOME_DIRECTORY?.trim() || env.EXPO_HOME?.trim() || join(home, ".expo");
  try {
    const st = JSON.parse(read(join(dir, "state.json"))) as {
      auth?: { sessionSecret?: unknown; username?: unknown } | null;
    };
    const auth = st?.auth;
    if (auth && typeof auth.sessionSecret === "string" && auth.sessionSecret) {
      return {
        loggedIn: true,
        via: "session",
        ...(typeof auth.username === "string" ? { username: auth.username } : {}),
      };
    }
  } catch {
    /* no state file / unreadable → not logged in */
  }
  return { loggedIn: false, via: null };
}

/**
 * The Expo account this project is bound to: app.json `expo.owner` /
 * `expo.extra.eas.projectId`, overlaid by the gitignored owner env file that
 * app.config.js reads (INFINIBOT_MOBILE_ENV_FILE or `<project>/.env.owner`).
 */
export function readExpoProjectIdentity(
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
  read: (path: string) => string = (p) => readFileSync(p, "utf8"),
): { owner?: string; projectId?: string } {
  const out: { owner?: string; projectId?: string } = {};
  try {
    const app = JSON.parse(read(join(projectDir, "app.json"))) as {
      expo?: { owner?: unknown; extra?: { eas?: { projectId?: unknown } } };
    };
    if (typeof app.expo?.owner === "string" && app.expo.owner) out.owner = app.expo.owner;
    const pid = app.expo?.extra?.eas?.projectId;
    if (typeof pid === "string" && pid) out.projectId = pid;
  } catch {
    /* no / bad app.json */
  }
  const fileVals: Record<string, string> = {};
  try {
    const file = env.INFINIBOT_MOBILE_ENV_FILE || join(projectDir, ".env.owner");
    for (const line of read(file).split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith("#")) fileVals[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    /* no owner file */
  }
  const val = (k: string) => env[k]?.trim() || fileVals[k]?.trim() || undefined;
  const owner = val("INFINIBOT_EXPO_OWNER");
  const projectId = val("INFINIBOT_EAS_PROJECT_ID");
  if (owner) out.owner = owner;
  if (projectId) out.projectId = projectId;
  return out;
}

/**
 * Should `expo start` run with EXPO_OFFLINE=1?
 *
 * Offline, the dev server serves an UNSIGNED manifest (scopeKey @anonymous/…).
 * For a project bound to an Expo owner/EAS project, Expo Go (SDK 57) rejects
 * that with "not logged in to <owner>, run npx expo login". Online with a
 * logged-in CLI the manifest is signed (`expo-signature: keyid="expo-go"`) and
 * works. Offline is still right when the CLI has NO auth: online, a
 * non-interactive expo-cli would stall on "use EXPO_TOKEN to authenticate".
 */
export function decideExpoOffline(input: {
  mode: ExpoMode;
  setting?: ExpoOfflineSetting;
  auth: { loggedIn: boolean; username?: string };
  project: { owner?: string; projectId?: string };
}): { offline: boolean; reason: string; notice?: string } {
  // Tunnel (ngrok) is a network service: EXPO_OFFLINE disables it outright.
  if (input.mode === "tunnel") return { offline: false, reason: "tunnel mode needs the network" };
  if (input.setting === true) return { offline: true, reason: "mobile.expoOffline=true" };
  if (input.setting === false) return { offline: false, reason: "mobile.expoOffline=false" };
  if (input.auth.loggedIn) {
    return {
      offline: false,
      reason: `expo-cli is logged in${input.auth.username ? ` as ${input.auth.username}` : ""} (signed manifest for Expo Go)`,
    };
  }
  const bound = input.project.owner || input.project.projectId;
  return {
    offline: true,
    reason: "expo-cli has no login (offline avoids the EXPO_TOKEN prompt)",
    ...(bound
      ? {
          notice:
            `Expo Go will refuse this app until this computer is logged in to Expo account ` +
            `${input.project.owner ?? `for project ${input.project.projectId}`}: run \`npx expo login\` ` +
            `(or set EXPO_TOKEN), then restart the dev server.`,
        }
      : {}),
  };
}

// ── Singleton state ──────────────────────────────────────────

// Guard so legacy-path selection only warns once per distinct path per
// process. Declared before `state` because the initializer below calls
// defaultProjectDir() at module load, which may reach the legacy branch.
const warnedLegacyMobileDirs = new Set<string>();

let state: ExpoState = {
  status: "stopped",
  url: null,
  devUrl: null,
  mode: "tunnel",
  pid: null,
  log: [],
  startedAt: null,
  exitCode: null,
  error: null,
  projectDir: defaultProjectDir(),
};
let proc: ChildProcess | null = null;
const listeners = new Set<(state: ExpoState) => void>();

// Remembered for the tunnel→LAN auto-fallback (see handleClose). When a
// tunnel can't establish, Expo aborts and Metro never serves, so we relaunch
// the same project in LAN mode once so the user still gets a scannable QR.
let lastOpts: StartExpoOptions = {};
let tunnelFailed = false;
let triedLanFallback = false;

/** Pre-resolved Tailscale MagicDNS hostname for the current run. */
let resolvedTailscaleHost: string | null = null;

const MAX_LOG_LINES = 200;

// ── Public API ───────────────────────────────────────────────

export function getExpoState(): ExpoState {
  return { ...state, log: [...state.log] };
}

export function onExpoStateChange(listener: (state: ExpoState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function startExpo(opts: StartExpoOptions = {}): Promise<ExpoState> {
  if (proc && state.status !== "stopped" && state.status !== "exited" && state.status !== "error") {
    return getExpoState();
  }

  // Remember the request so the close handler can relaunch in LAN mode if a
  // tunnel fails. A user-initiated start (not our own auto-fallback) resets
  // the retry guard.
  lastOpts = opts;
  tunnelFailed = false;
  if (!opts._lanFallback) triedLanFallback = false;

  const projectDir = resolve(opts.projectDir ?? defaultProjectDir());
  if (!existsSync(projectDir)) {
    state = {
      ...state,
      status: "error",
      error: `Expo project not found at ${projectDir}`,
      projectDir,
    };
    notify();
    return getExpoState();
  }

  const mode = opts.mode ?? "tunnel";
  const offlineDecision = decideExpoOffline({
    mode,
    setting: opts.expoOffline ?? "auto",
    auth: detectExpoAuth(),
    project: readExpoProjectIdentity(projectDir),
  });
  let port = opts.port ?? 8081;
  // Expo prompts "Use port N+1 instead?" when the requested port is busy;
  // in non-interactive mode it bails. Kill any leftover Metro on the port
  // so we always reclaim the canonical 8081 — there's exactly one Metro
  // at a time anyway, and the dashboard is the source of truth.
  if (!(await isPortFree(port))) {
    const killed = killPortOwners(port);
    if (killed.length > 0) {
      pushLog(`[expo-runner] reclaimed port ${port} from pid ${killed.join(", ")}`);
      await waitForPortFree(port, 3000);
    }
  }
  // Still busy: the owner isn't ours to kill (e.g. `tailscale serve` binding the
  // tailnet IP). Expo would bail on its "use port N+1?" prompt, so pick the next
  // free port ourselves.
  if (!(await isPortFree(port))) {
    const requested = port;
    for (let candidate = requested + 1; candidate <= requested + 20; candidate++) {
      if (await isPortFree(candidate)) {
        port = candidate;
        break;
      }
    }
    pushLog(
      port === requested
        ? `[expo-runner] port ${requested} is busy and no free port found in ${requested + 1}-${requested + 20}`
        : `[expo-runner] port ${requested} is held by another process; using ${port}`,
    );
  }

  // Pre-bake gateway connection into .env.local so the Expo app has it
  // at boot — saves the user typing on a tiny phone keyboard.
  if (opts.gatewayUrl || opts.gatewayToken) {
    try {
      writeEnvLocal(projectDir, {
        EXPO_PUBLIC_GATEWAY_URL: opts.gatewayUrl,
        EXPO_PUBLIC_GATEWAY_TOKEN: opts.gatewayToken,
      });
    } catch (err) {
      pushLog(
        `[expo-runner] warning: could not write .env.local — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (tunnelFallbackTimer) {
    clearTimeout(tunnelFallbackTimer);
    tunnelFallbackTimer = null;
  }

  // Pre-resolve Tailscale MagicDNS hostname for cleaner URLs.
  if (mode === "tailscale") {
    resolvedTailscaleHost = await detectTailscaleHost();
    if (resolvedTailscaleHost) {
      pushLog(`[expo-runner] tailscale host: ${resolvedTailscaleHost}`);
    }
  } else {
    resolvedTailscaleHost = null;
  }

  state = {
    status: "starting",
    url: null,
    devUrl: null,
    mode,
    pid: null,
    log: [],
    startedAt: Date.now(),
    exitCode: null,
    error: null,
    projectDir,
    notice: offlineDecision.notice ?? null,
    offline: offlineDecision.offline,
  };
  pushLog(
    `[expo-runner] ${offlineDecision.offline ? "EXPO_OFFLINE=1" : "online"}: ${offlineDecision.reason}`,
  );
  if (offlineDecision.notice) pushLog(`[expo-runner] ${offlineDecision.notice}`);
  notify();

  // `npx --yes` (below) only fetches the `expo` CLI into a temp cache — it
  // does NOT install this project's own dependencies. A fresh `npm i -g
  // infinibot` (or a git clone) ships `mobile/` without `node_modules`, so
  // `expo start` would immediately die with "Cannot determine the project's
  // Expo SDK version because the module `expo` is not installed". Install the
  // project deps once, up front, when they're missing so the dashboard's
  // "spawn" works out of the box on a clean machine.
  const deps = await ensureDependenciesInstalled(projectDir);
  if (!deps.ok) {
    state = { ...state, status: "error", error: deps.error ?? "dependency install failed" };
    notify();
    return getExpoState();
  }

  // `--yes` tells npx to auto-accept the "Need to install the following
  // packages" prompt. Without it, projects with no local `node_modules`
  // (or any nested `npx <missing-pkg>` Metro fires during bundling) abort
  // with "npx is in non-interactive mode" — Expo Go then surfaces that
  // as a 500 when fetching the bundle. `npm_config_yes` does the same
  // for any nested `npm install` that Metro/expo-cli spawns themselves.
  // tailscale mode uses --lan (Metro binds all interfaces) — we construct
  // the exp:// URL from the Tailscale IP ourselves; there's no native
  // --tailscale flag in the expo CLI.
  const expoModeFlag = mode === "tailscale" ? "lan" : mode;
  const args = ["--yes", "expo", "start", `--${expoModeFlag}`, "--port", String(port)];
  // We previously set --non-interactive + CI=1, but both have the same
  // side effect: Expo suppresses the startup banner that contains the
  // `exp://` URL we parse for the QR. With stdio:ignore on stdin, Metro
  // can't read keystrokes anyway, so we leave interactive mode on and
  // get the banner back.

  proc = spawn(npxBin(), args, {
    cwd: projectDir,
    shell: true,
    // EXPO_OFFLINE=1 stops expo-cli from making account-bound network calls
    // (dev-client lookup, EAS metadata, push token registration). Without
    // it, expo prompts "use EXPO_TOKEN to authenticate" when stdin isn't a
    // TTY and Expo Go surfaces it as a 500 fetching the bundle.
    //
    // EXCEPTION: tunnel mode. The tunnel (ngrok) is a network service, so
    // EXPO_OFFLINE=1 disables it outright — expo silently logs "Tunnel URL
    // not found … falling back to LAN URL" and never prints an exp:// URL,
    // which leaves the dashboard stuck on "Starting Metro…" with no QR. For
    // tunnel mode we stay online; if the tunnel can't establish we fall back
    // to a LAN URL ourselves (see handleOutput) so a QR still renders.
    env: {
      ...process.env,
      CI: undefined,
      npm_config_yes: "true",
      // Online when expo-cli is logged in (Expo Go needs the signed
      // manifest for an owner-bound project) — see decideExpoOffline().
      ...(offlineDecision.offline ? { EXPO_OFFLINE: "1" } : { EXPO_OFFLINE: undefined }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  state.pid = proc.pid ?? null;
  notify();

  proc.stdout?.on("data", (b: Buffer) => handleOutput(b.toString()));
  proc.stderr?.on("data", (b: Buffer) => handleOutput(b.toString()));
  proc.on("error", (err) => {
    pushLog(`[expo-runner] spawn error: ${err.message}`);
    state = { ...state, status: "error", error: err.message };
    proc = null;
    notify();
  });
  proc.on("close", (code) => {
    pushLog(`[expo-runner] exited with code ${code}`);
    proc = null;
    // Tunnel couldn't establish (Expo aborts before Metro serves, so a LAN
    // URL would be a dead link). The bundled ngrok agent is frequently
    // unavailable; relaunch the same project in LAN mode once so the user
    // still gets a working, scannable QR on the same Wi-Fi.
    if (
      state.mode === "tunnel" &&
      !state.url &&
      !triedLanFallback &&
      (tunnelFailed || code !== 0)
    ) {
      triedLanFallback = true;
      pushLog("[expo-runner] tunnel failed — relaunching in LAN mode so a QR can still render");
      state = { ...state, status: "starting", error: null };
      notify();
      void startExpo({ ...lastOpts, mode: "lan", _lanFallback: true });
      return;
    }
    state = {
      ...state,
      status: code === 0 ? "exited" : "error",
      exitCode: code,
      pid: null,
    };
    notify();
  });

  return getExpoState();
}

export async function stopExpo(): Promise<ExpoState> {
  if (tunnelFallbackTimer) {
    clearTimeout(tunnelFallbackTimer);
    tunnelFallbackTimer = null;
  }
  if (!proc) {
    state = { ...state, status: "stopped" };
    notify();
    return getExpoState();
  }
  try {
    if (process.platform === "win32") {
      // npx forks cmd.exe → expo node child. SIGTERM doesn't propagate,
      // so we taskkill the tree.
      const { spawnSync } = await import("node:child_process");
      spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
      // Give Metro a moment to gracefully exit; force after 3s.
      setTimeout(() => proc?.kill("SIGKILL"), 3000).unref();
    }
  } catch (err) {
    pushLog(`[expo-runner] stop error: ${err instanceof Error ? err.message : String(err)}`);
  }
  state = { ...state, status: "stopped" };
  proc = null;
  notify();
  return getExpoState();
}

// ── Output parsing ──────────────────────────────────────────

const URL_PATTERNS = [
  /(exp:\/\/[^\s]+)/, // tunnel + lan banners
  /(exps:\/\/[^\s]+)/, // dev clients
];

function handleOutput(chunk: string): void {
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    pushLog(line);
    // Metro prints a banner like:
    //   › Metro waiting on exp://192.168.1.150:8081
    //   › Tunnel ready. URL: exp://abc-username.tunnel.expo.app
    if (!state.url) {
      for (const re of URL_PATTERNS) {
        const m = line.match(re);
        if (m) {
          state = { ...state, url: m[1], status: "ready" };
          break;
        }
      }
    }
    // Metro also prints "Web is waiting on http://..." and similar dev URLs.
    if (!state.devUrl) {
      const httpM = line.match(/(https?:\/\/[\w.\-:]+:\d+)/);
      if (httpM && /metro|dev|web|expo|waiting/i.test(line)) {
        state = { ...state, devUrl: httpM[1] };
      }
    }
    // Fallback for LAN / localhost / tailscale — Expo SDK 54 with a non-TTY
    // stdin never prints the `exp://` banner (or the QR); it only logs
    // "Waiting on http://localhost:8081". We construct the equivalent exp://
    // URL from the LAN/Tailscale address + port ourselves so the QR renders.
    if (
      !state.url &&
      (state.mode === "lan" || state.mode === "localhost" || state.mode === "tailscale") &&
      /Waiting on http:\/\/localhost:(\d+)/.test(line)
    ) {
      const m = line.match(/localhost:(\d+)/);
      const lanPort = m ? Number(m[1]) : 8081;
      applyLanFallback(lanPort);
    }
    // Tunnel-mode fallback — when "Tunnel ready" lands without a URL on
    // the same line, Expo usually prints the URL on a follow-up line as
    // "› Web is waiting on https://*.tunnel.expo.dev" or similar. The
    // generic pattern above will match it as devUrl; promote that to
    // url when no exp:// has shown up.
    if (
      !state.url &&
      state.mode === "tunnel" &&
      /tunnel\.expo\.dev|tunnel\.expo\.app/i.test(line)
    ) {
      const m = line.match(/(https?:\/\/[\w.\-:]+\.tunnel\.expo\.(?:dev|app)[^\s]*)/i);
      if (m) {
        // Convert https → exp for the QR — Expo Go reads either, but
        // exp:// triggers the deep-link banner directly.
        const expUrl = m[1].replace(/^https?:/, "exp:");
        state = { ...state, url: expUrl, status: "ready" };
      }
    }
    // Tunnel-mode dev-server probe — Expo SDK 54 sometimes prints
    // "Tunnel ready." without ever logging the actual tunnel URL when
    // stdin isn't a TTY. Once Metro is listening, we can ask its dev
    // server for the manifest, which contains the tunnel URL inside
    // `extra.expoGo.developer.host` / `bundleUrl`.
    if (
      !state.url &&
      state.mode === "tunnel" &&
      /Tunnel ready|Waiting on http:\/\/localhost:(\d+)/.test(line)
    ) {
      const portM = line.match(/localhost:(\d+)/);
      const probePort = portM ? Number(portM[1]) : 8081;
      // Defer so Expo's tunnel registration completes first.
      setTimeout(() => void probeTunnelUrl(probePort), 1500);
      // Last-resort LAN fallback: the bundled ngrok agent (v2) is frequently
      // unavailable ("remote gone away") and expo just keeps logging without
      // ever surfacing a tunnel URL. If neither the banner nor the probe has
      // produced a URL after a grace period, render a LAN QR so the user can
      // still pair on the same Wi-Fi rather than staring at a dead spinner.
      scheduleTunnelLanFallback(probePort);
    }
    // Expo says it outright when the tunnel can't be established. In online
    // mode it then aborts before Metro serves, so a LAN URL would be a dead
    // link — flag it and let the close handler relaunch in LAN mode instead.
    if (
      state.mode === "tunnel" &&
      /failed to start tunnel|remote gone away|Tunnel URL not found/i.test(line)
    ) {
      tunnelFailed = true;
    }
  }
  notify();
}

/**
 * Resolve the Tailscale MagicDNS hostname (preferred) or fall back to the raw
 * Tailscale IP (100.x.x.x). The hostname is cleaner for URLs and works
 * without any `tailscale serve` / `tailscale funnel` config — MagicDNS
 * resolves to the Tailscale IP within the tailnet automatically.
 */
export async function detectTailscaleHost(): Promise<string | null> {
  try {
    const hostname = await getTailnetHostname();
    if (hostname) return hostname;
  } catch {
    /* tailscale binary unavailable — fall back to IP detection */
  }
  // Fallback: scan interfaces for Tailscale's CGNAT range 100.64.0.0/10.
  const ifaces = networkInterfaces();
  for (const [, list] of Object.entries(ifaces)) {
    if (!list) continue;
    for (const i of list) {
      if (i.family !== "IPv4" || i.internal) continue;
      if (i.address.startsWith("100.")) return i.address;
    }
  }
  return null;
}

/** Synchronous fallback — only checks the CGNAT IP (no tailscale binary). */
export function detectTailscaleAddress(): string | null {
  const ifaces = networkInterfaces();
  for (const [, list] of Object.entries(ifaces)) {
    if (!list) continue;
    for (const i of list) {
      if (i.family !== "IPv4" || i.internal) continue;
      if (i.address.startsWith("100.")) return i.address;
    }
  }
  return null;
}

/**
 * Build a LAN (or Tailscale) exp:// URL and mark the runner ready.
 * Used as the universal fallback when Expo never prints an exp:// banner
 * (SDK 54, non-TTY) or when a tunnel fails to establish.
 * `degraded` logs a note so the dashboard makes clear the connection is now
 * same-Wi-Fi-only (or same-tailnet-only).
 */
function applyLanFallback(port: number, opts: { degraded?: boolean } = {}): void {
  if (state.url) return;
  let host: string | null;
  if (state.mode === "tailscale") {
    // Prefer the MagicDNS hostname (e.g. myhost.tailnet-name.ts.net) for
    // cleaner URLs — it resolves to the same Tailscale IP within the tailnet.
    host = resolvedTailscaleHost ?? detectTailscaleAddress();
  } else if (state.mode === "localhost") {
    host = "127.0.0.1";
  } else {
    host = detectLanAddress();
  }
  if (!host) {
    const label = state.mode === "tailscale" ? "Tailscale" : "LAN";
    pushLog(`[expo-runner] no ${label} address found — cannot build fallback exp:// URL`);
    return;
  }
  if (opts.degraded) {
    pushLog(
      `[expo-runner] tunnel unavailable — falling back to ${state.mode === "tailscale" ? "Tailscale" : "LAN"} URL exp://${host}:${port}`,
    );
  }
  state = { ...state, url: `exp://${host}:${port}`, status: "ready" };
  notify();
}

let tunnelFallbackTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Arm a one-shot timer that converts a stuck-but-alive tunnel into a LAN QR.
 * Only fires while Metro is still running (proc != null) — if the tunnel
 * attempt has already aborted, the close handler's LAN relaunch owns recovery
 * and a LAN URL here would point at a dead server.
 */
function scheduleTunnelLanFallback(port: number): void {
  if (tunnelFallbackTimer) return;
  tunnelFallbackTimer = setTimeout(() => {
    tunnelFallbackTimer = null;
    if (proc && !state.url && state.mode === "tunnel") {
      applyLanFallback(port, { degraded: true });
    }
  }, 12000);
  tunnelFallbackTimer.unref?.();
}

/**
 * Hits Expo's local dev server to discover the tunnel URL. Tries multiple
 * known endpoints (Expo's path keeps shifting between SDK versions).
 * Updates state.url on success, no-op on failure (the user can fall back
 * to LAN mode or paste the URL manually).
 */
async function probeTunnelUrl(port: number): Promise<void> {
  if (state.url) return; // someone else won the race
  const candidates: Array<{ url: string; headers: Record<string, string> }> = [
    // SDK 50+ classic manifest endpoint
    {
      url: `http://localhost:${port}/`,
      headers: { "Expo-Platform": "ios", Accept: "application/expo+json,application/json" },
    },
    // Newer dev-server JSON endpoint
    { url: `http://localhost:${port}/_expo/api/v2/manifest`, headers: { "Expo-Platform": "ios" } },
    // Some setups expose this
    { url: `http://localhost:${port}/expo/manifest`, headers: { "Expo-Platform": "ios" } },
  ];
  for (const { url, headers } of candidates) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) continue;
      const text = await res.text();
      // Look for any tunnel URL in the response — Expo embeds the host in
      // bundleUrl, packagerOpts.host, developer.host, etc. We don't care
      // which field; we just want the first match.
      const m = text.match(
        /(https?:\/\/[\w.-]+\.tunnel\.expo\.(?:dev|app)(?::\d+)?(?:\/[^\s"'<>)]*)?)/i,
      );
      if (m) {
        const expUrl = m[1].replace(/^https?:/, "exp:");
        state = { ...state, url: expUrl, status: "ready" };
        pushLog(`[expo-runner] discovered tunnel URL via dev-server probe: ${expUrl}`);
        notify();
        return;
      }
    } catch {
      // Endpoint may not exist on this SDK — try the next.
    }
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "0.0.0.0");
  });
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortFree(port)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Kill every process listening on `port` so we can reclaim it. Returns the
 * PIDs we signaled. Cross-platform: lsof on POSIX, netstat+taskkill on
 * Windows. Best-effort — quiet on missing tools.
 */
function killPortOwners(port: number): number[] {
  const pids = new Set<number>();
  if (process.platform === "win32") {
    const out = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf-8" }).stdout ?? "";
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/LISTENING\s+(\d+)\s*$/);
      if (m && /:(\d+)\s/.test(line) && line.includes(`:${port}`)) pids.add(Number(m[1]));
    }
    for (const pid of pids)
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    const out =
      spawnSync("lsof", ["-ti", `:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8" }).stdout ?? "";
    for (const line of out.split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (Number.isFinite(pid) && pid > 0) pids.add(pid);
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    // Escalate to SIGKILL for stragglers after a short grace period.
    setTimeout(() => {
      for (const pid of pids) {
        try {
          process.kill(pid, 0);
          process.kill(pid, "SIGKILL");
        } catch {
          /* exited */
        }
      }
    }, 1500).unref();
  }
  return [...pids];
}

function pushLog(line: string): void {
  if (!line.trim()) return;
  state.log.push(line);
  if (state.log.length > MAX_LOG_LINES) {
    state.log = state.log.slice(-MAX_LOG_LINES);
  }
}

function notify(): void {
  for (const l of listeners) {
    try {
      l(getExpoState());
    } catch {
      /* ignore */
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Resolve the default Expo project dir, in priority order:
 *
 *   1. `EXPO_PROJECT_DIR` / `INFINIBOT_MOBILE_DIR` env override.
 *   2. The `mobile/` directory bundled with the InfiniBot package. This is
 *      the canonical default: it points at the in-repo `mobile/` when running
 *      from a checkout, and at `node_modules/infinibot/mobile` when running
 *      from an installed package — so a fresh clone or install works with no
 *      config or hardcoded user paths.
 *   3. Legacy machine-specific candidates (the bot author's historical
 *      layouts). Deprecated and only kept for back-compat — selecting one
 *      logs a one-time deprecation warning so we can drop them next major.
 *   4. The historical default, so a "project not found" error points
 *      somewhere predictable rather than wherever cwd happens to be.
 *
 * An Expo workspace is identified by an `app.json` with an `expo` key, or an
 * `app.config.js`/`.ts` (see {@link isExpoProject}).
 */
export function resolveDefaultProjectDir(): string {
  const env = process.env.EXPO_PROJECT_DIR ?? process.env.INFINIBOT_MOBILE_DIR;
  if (env) return resolve(env);

  // Canonical: the `mobile/` dir shipped with the package / present in the repo.
  const packageRoot = resolveInfiniBotPackageRootSync({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (packageRoot) {
    const bundled = join(packageRoot, "mobile");
    if (isExpoProject(bundled)) return bundled;
  }

  // Legacy relative layouts under the current user's home directory.
  const home = homedir();
  const legacy = [
    resolve(home, "Desktop", "Development", "infinibot_mobile_expo"),
    resolve(home, "Desktop", "Development", "infinibot-mobile"),
    resolve(home, "Desktop", "Development", "infinibot_mobile"),
    resolve(home, "infinibot_mobile_expo"),
    resolve(home, "infinibot-mobile"),
    resolve(home, "infinibot"),
    // Sibling to the gateway checkout — handy when cloned next to InfiniBot.
    resolve(process.cwd(), "..", "infinibot_mobile_expo"),
    resolve(process.cwd(), "..", "infinibot-mobile"),
  ];
  for (const dir of legacy) {
    if (isExpoProject(dir)) {
      if (!warnedLegacyMobileDirs.has(dir)) {
        warnedLegacyMobileDirs.add(dir);
        // eslint-disable-next-line no-console
        console.warn(
          `[expo-runner] using deprecated mobile project path "${dir}". ` +
            `Bundle the app at <package>/mobile or set INFINIBOT_MOBILE_DIR; ` +
            `legacy candidate paths will be removed in a future major.`,
        );
      }
      return dir;
    }
  }

  // Nothing matched — return the historical default so the error message
  // points somewhere predictable rather than wherever cwd happens to be.
  return resolve(home, "infinibot");
}

function isExpoProject(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    const appJson = join(dir, "app.json");
    if (existsSync(appJson)) {
      const parsed = JSON.parse(readFileSync(appJson, "utf-8")) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && "expo" in parsed) return true;
    }
  } catch {
    /* malformed app.json — fall through */
  }
  return existsSync(join(dir, "app.config.js")) || existsSync(join(dir, "app.config.ts"));
}

function defaultProjectDir(): string {
  return resolveDefaultProjectDir();
}

function npxBin(): string {
  // On Windows shells, `npx` resolves to `npx.cmd`. We let `shell: true`
  // do the right thing rather than hardcoding either.
  return "npx";
}

function npmBin(): string {
  // Same rationale as npxBin — `shell: true` resolves `npm.cmd` on Windows.
  return "npm";
}

/** True once the project's own `expo` package is on disk (deps installed). */
function hasInstalledDeps(projectDir: string): boolean {
  return existsSync(join(projectDir, "node_modules", "expo"));
}

/**
 * Ensure the Expo project's dependencies are installed before `expo start`.
 *
 * `npx --yes expo …` fetches only the `expo` CLI into npx's temp cache; it
 * never installs the project's `node_modules`. A freshly-installed package or
 * a clean clone therefore has the app's `app.json` (so the runner selects the
 * dir) but no `expo` module, and `expo start` dies with "Cannot determine the
 * project's Expo SDK version because the module `expo` is not installed". We
 * run a one-time `npm install` to fix that automatically. No-op when deps are
 * already present, so normal starts pay nothing.
 *
 * Conflict resolution: the mobile app pins React 19 while a dev-only test lib
 * (`@testing-library/react-hooks`) still declares a React 16/17 peer, so a
 * plain `npm install` aborts with ERESOLVE on a clean machine. We detect that
 * peer-dependency conflict and retry once with `--legacy-peer-deps` so the
 * spawn self-heals instead of dead-ending the mobile page on "expo not
 * installed". `typescript` is a declared dependency, so the same install also
 * satisfies Expo's "trying to use TypeScript" check.
 *
 * Output is streamed to the runner log so the dashboard shows install
 * progress (and the conflict retry) instead of an opaque "Starting…" spinner.
 */
async function ensureDependenciesInstalled(
  projectDir: string,
): Promise<{ ok: boolean; error?: string }> {
  if (hasInstalledDeps(projectDir)) return { ok: true };
  if (!existsSync(join(projectDir, "package.json"))) {
    return {
      ok: false,
      error: `No package.json in ${projectDir} — cannot install Expo dependencies.`,
    };
  }
  pushLog(
    `[expo-runner] node_modules missing in ${projectDir} — running npm install (first run, this can take a minute)…`,
  );
  notify();
  // First try a clean install. If npm aborts on an ERESOLVE peer-dependency
  // conflict, retry once with --legacy-peer-deps — the conflicting package is
  // a dev-only test lib, so relaxing peer resolution is safe and lets the
  // mobile spawn succeed out of the box.
  let result = await runNpmInstall(projectDir, false);
  if (!result.ok && result.conflicted) {
    pushLog("[expo-runner] npm hit a peer-dependency conflict — retrying with --legacy-peer-deps");
    notify();
    result = await runNpmInstall(projectDir, true);
  }
  if (result.ok && hasInstalledDeps(projectDir)) {
    pushLog("[expo-runner] dependencies installed");
    notify();
    return { ok: true };
  }
  return {
    ok: false,
    error: result.error ?? `could not install Expo dependencies in ${projectDir}`,
  };
}

/**
 * Run a single `npm install` in `projectDir`, streaming output to the runner
 * log. Reports `conflicted: true` when npm's output mentions an ERESOLVE
 * peer-dependency conflict, so the caller can retry with --legacy-peer-deps.
 */
function runNpmInstall(
  projectDir: string,
  legacyPeerDeps: boolean,
): Promise<{ ok: boolean; conflicted: boolean; error?: string }> {
  const args = ["install", "--no-audit", "--no-fund"];
  if (legacyPeerDeps) args.push("--legacy-peer-deps");
  return new Promise((resolveInstall) => {
    const child = spawn(npmBin(), args, {
      cwd: projectDir,
      shell: true,
      // npm_config_yes keeps any nested prompts non-blocking; CI is cleared so
      // npm doesn't switch to its CI reporter (and to mirror the expo spawn).
      env: { ...process.env, CI: undefined, npm_config_yes: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let conflicted = false;
    const onData = (b: Buffer): void => {
      for (const line of b.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (/ERESOLVE|could not resolve dependency|conflicting peer|peer dep/i.test(line)) {
          conflicted = true;
        }
        pushLog(line);
      }
      notify();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) =>
      resolveInstall({
        ok: false,
        conflicted,
        error: `npm install failed to start: ${err.message}`,
      }),
    );
    child.on("close", (code) => {
      if (code === 0) {
        resolveInstall({ ok: true, conflicted });
      } else {
        resolveInstall({
          ok: false,
          conflicted,
          error: `npm install exited with code ${code} in ${projectDir}`,
        });
      }
    });
  });
}

/**
 * Merge keys into the project's `.env.local`. We never overwrite values
 * the user set themselves — only fill in keys that aren't there yet.
 */
function writeEnvLocal(projectDir: string, vars: Record<string, string | undefined>): void {
  const path = join(projectDir, ".env.local");
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const lines = existing.split(/\r?\n/);
  const present = new Map<string, number>();
  lines.forEach((line, idx) => {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m) present.set(m[1], idx);
  });
  for (const [key, value] of Object.entries(vars)) {
    if (value == null) continue;
    const lineText = `${key}=${value}`;
    if (present.has(key)) {
      lines[present.get(key)!] = lineText;
    } else {
      lines.push(lineText);
    }
  }
  writeFileSync(path, lines.filter((l, i) => l.trim() || i === lines.length - 1).join("\n"));
}

/**
 * Resolve an IPv4 LAN address suitable for the `--lan` mode banner.
 * Returns null when no non-loopback v4 interface is available.
 */
/**
 * Pick the IP a phone on the same Wi-Fi can reach. Naively returning the
 * first non-internal IPv4 picks Hyper-V vEthernet (`172.19.x.x`),
 * Tailscale (`100.x.x.x`), or VMware adapters on Windows — none of which
 * route from a phone on the actual home network.
 *
 * Priority order:
 *   1. 192.168.x.x      — typical home Wi-Fi
 *   2. 10.x.x.x         — corporate / mesh router
 *   3. 172.16-31.x.x    — RFC1918 private (skip 172.17/172.18 which are
 *                          Docker / vEthernet)
 *   4. Anything else (last resort)
 *
 * Within each tier, prefer interface names that don't smell virtual
 * (avoid "vEthernet", "Tailscale", "VMware", "Hyper-V", "Loopback").
 */
export function detectLanAddress(): string | null {
  const ifaces = networkInterfaces();
  const VIRTUAL = /vethernet|tailscale|vmware|hyper-?v|loopback|virtualbox|docker|wsl/i;
  type Cand = { addr: string; tier: number; virtual: boolean; name: string };
  const cands: Cand[] = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list) continue;
    for (const i of list) {
      if (i.family !== "IPv4" || i.internal) continue;
      let tier = 4;
      if (i.address.startsWith("192.168.")) tier = 1;
      else if (i.address.startsWith("10.")) tier = 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(i.address)) tier = 3;
      cands.push({ addr: i.address, tier, virtual: VIRTUAL.test(name), name });
    }
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier; // lower tier wins
    if (a.virtual !== b.virtual) return a.virtual ? 1 : -1; // physical wins
    return 0;
  });
  return cands[0]!.addr;
}

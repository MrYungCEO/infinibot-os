/**
 * `infinibot quickstart` — boot the gateway in onboarding mode and open the
 * stylish web UI in the user's default browser. Replaces the clack-based TUI
 * onboard for users who want a richer setup experience.
 *
 * Behaviour:
 *   - If a gateway is already running on the configured port, just open the
 *     /quickstart URL on it.
 *   - Otherwise, spawn the gateway in the foreground, wait for it to come
 *     up, open the browser, and stay attached so logs flow through. Ctrl+C
 *     stops everything cleanly.
 *
 * The TUI onboard remains available behind `infinibot onboard --tui` for
 * scripted automation.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { DEFAULT_GATEWAY_PORT } from "../config/paths.js";
import { loadConfig } from "../config/io.js";
import { theme } from "../terminal/theme.js";

const STARTUP_TIMEOUT_MS = 60_000; // first cold boot can take 30-45s with all plugins

export interface QuickstartOptions {
  /** Skip the auto-open of the browser; print the URL instead. */
  noOpen?: boolean;
  /** Override the gateway port (defaults to whatever's in config). */
  port?: number;
  /** Bind for the spawned gateway (loopback by default). */
  bind?: "loopback" | "lan" | "tailnet" | "auto";
}

export async function quickstartCommand(opts: QuickstartOptions = {}): Promise<void> {
  const port = resolvePort(opts);
  const bind = opts.bind ?? "loopback";

  // Generate a one-shot token for this quickstart session. The gateway will
  // require it on every WebSocket connect; the web UI picks it up from the
  // URL hash so the user never has to copy it manually. Fresh per launch
  // so a hijacked URL doesn't grant ongoing access.
  const token = randomBytes(24).toString("hex");
  const url = `http://127.0.0.1:${port}/quickstart#token=${token}`;
  const isRunning = await pingGateway(port);

  if (isRunning) {
    console.log(theme.muted(`Gateway already running on port ${port}.`));
    console.log(`Opening ${theme.accent(url)}…`);
    if (!opts.noOpen) await openBrowser(url);
    return;
  }

  console.log(theme.muted(`Starting InfiniBot gateway on port ${port}…`));
  console.log(theme.muted("First boot can take 30-60 seconds while plugins initialize."));

  const child = spawnGateway(port, bind, token);
  attachShutdown(child);

  let childExited = false;
  child.on("exit", (code) => {
    childExited = true;
    if (code !== 0 && code !== null) {
      console.error(theme.error(`Gateway exited with code ${code}.`));
    }
  });

  const ready = await waitForGateway(port, STARTUP_TIMEOUT_MS, () => childExited);
  if (childExited) {
    console.error(theme.error("Gateway exited before binding. See the log lines above."));
    process.exitCode = 1;
    return;
  }
  if (!ready) {
    console.error(
      theme.error(
        `Gateway did not bind to port ${port} within ${STARTUP_TIMEOUT_MS / 1000}s. ` +
          "It may still be initializing — try opening " +
          `${url} manually in a moment, or set INFINIBOT_FORCE_BUILD=0 if a stale build is the issue.`,
      ),
    );
    // Don't kill it — the gateway may still come up; let the user decide.
  } else {
    console.log(theme.success("✓ Gateway is up."));
    console.log(`Opening ${theme.accent(url)}`);
    if (!opts.noOpen) await openBrowser(url);
  }
  console.log(
    theme.muted("\nLeave this terminal open while you finish setup. Press Ctrl+C to stop."),
  );

  // Keep the process alive while the gateway runs.
  await new Promise<void>((res) => {
    child.on("exit", () => res());
  });
}

function resolvePort(opts: QuickstartOptions): number {
  if (opts.port) return opts.port;
  try {
    const cfg = loadConfig();
    const fromCfg = (cfg.gateway as { port?: number } | undefined)?.port;
    if (typeof fromCfg === "number") return fromCfg;
  } catch {
    // ignore — fall through to default
  }
  return DEFAULT_GATEWAY_PORT;
}

async function pingGateway(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/quickstart`, {
      method: "HEAD",
      signal: AbortSignal.timeout(2_000),
    });
    return res.status === 200 || res.status === 405;
  } catch {
    return false;
  }
}

async function waitForGateway(
  port: number,
  timeoutMs: number,
  hasExited: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let nextDot = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (hasExited()) return false;
    if (await pingGateway(port)) return true;
    await delay(500);
    if (Date.now() >= nextDot) {
      process.stdout.write(theme.muted("."));
      nextDot = Date.now() + 5_000;
    }
  }
  process.stdout.write("\n");
  return false;
}

/**
 * Resolve the canonical CLI entry path. Order:
 *   1. `dist/entry.js` next to the cwd — the built artifact `run-node.mjs`
 *      uses, so we match its behaviour and avoid a re-build round trip.
 *   2. The current process entry (`process.argv[1]`) when it points at a
 *      plain JS/ts file.
 *   3. Bare "infinibot" — the global binary, used as a last resort.
 */
function resolveCliEntry(): string {
  const distEntry = resolve(process.cwd(), "dist", "entry.js");
  if (existsSync(distEntry)) return distEntry;
  const argvEntry = process.argv[1];
  if (argvEntry && existsSync(argvEntry)) return argvEntry;
  return "infinibot";
}

function spawnGateway(port: number, bind: string, token: string): ChildProcess {
  // --allow-unconfigured: quickstart is the tool that *creates* the config,
  // so we must boot the gateway without one. The wizard writes the config
  // through the WebSocket RPC layer once the user steps through the flow.
  //
  // Use the bare `gateway` command (not `gateway run`). Both forms exist in
  // src/cli/gateway-cli/register.ts but the parent form keeps option parsing
  // unambiguous for Commander when many flags follow.
  //
  // --force kills any existing listener on the port; it requires `lsof`
  // which isn't available on Windows, so we omit it. If the port is busy,
  // the gateway will fail to bind and we surface a clean error.
  //
  // --auth token + --token <random>: the gateway requires auth credentials
  // when its config defaults to token mode. We mint a one-shot token and
  // pass it both as a CLI flag and via INFINIBOT_GATEWAY_TOKEN env, then
  // hand it to the browser via the URL hash so the wizard auto-authenticates.
  const args = [
    "gateway",
    "--allow-unconfigured",
    "--bind",
    bind,
    "--port",
    String(port),
    "--auth",
    "token",
    "--token",
    token,
  ];
  const entry = resolveCliEntry();
  const isJs = entry.endsWith(".js") || entry.endsWith(".mjs") || entry.endsWith(".cjs");
  const childEnv = {
    ...process.env,
    INFINIBOT_GATEWAY_TOKEN: token,
  };
  if (isJs) {
    return spawn(process.execPath, [entry, ...args], {
      stdio: "inherit",
      env: childEnv,
    });
  }
  // Treat as a binary on PATH (e.g. `infinibot`).
  return spawn(entry, args, {
    stdio: "inherit",
    env: childEnv,
    shell: process.platform === "win32",
  });
}

function attachShutdown(child: ChildProcess): void {
  const stop = () => {
    if (!child.killed) child.kill("SIGINT");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("exit", stop);
}

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const cmd = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args =
    platform === "win32"
      ? ["/c", "start", '""', url] // start needs a "" title arg
      : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    // A missing opener (headless box, container) arrives as an async 'error'
    // event; unhandled, it crashes the CLI.
    child.on("error", () => console.log(theme.muted(`Couldn't auto-open. Visit ${url} manually.`)));
    child.unref();
  } catch {
    console.log(theme.muted(`Couldn't auto-open. Visit ${url} manually.`));
  }
}

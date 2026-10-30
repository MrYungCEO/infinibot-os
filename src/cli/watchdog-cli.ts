/**
 * Watchdog CLI Commands
 * 
 * infinibot watchdog start  - Start the watchdog (monitors and auto-restarts gateway)
 * infinibot watchdog stop   - Stop the watchdog
 * infinibot watchdog status - Show watchdog status
 */

import type { Command } from "commander";
import path from "node:path";
import { defaultRuntime } from "../runtime.js";
import {
  GatewayWatchdog,
  readWatchdogState,
  readWatchdogPid,
  isWatchdogRunning,
  stopWatchdogByPid,
  type WatchdogConfig,
} from "../daemon/watchdog.js";
import { resolveGatewayStateDir } from "../daemon/paths.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { colorize, isRich, theme } from "../terminal/theme.js";

interface WatchdogStartOptions {
  gatewayUrl?: string;
  token?: string;
  password?: string;
  checkInterval?: string;
  probeTimeout?: string;
  gracePeriod?: string;
  maxFailures?: string;
  maxRestarts?: string;
  foreground?: boolean;
  json?: boolean;
}

interface WatchdogStopOptions {
  json?: boolean;
}

interface WatchdogStatusOptions {
  json?: boolean;
}

function parseMs(value: string | undefined, defaultMs: number): number {
  if (!value) return defaultMs;
  const trimmed = value.trim().toLowerCase();
  
  // Support formats: "30s", "5m", "30000"
  if (trimmed.endsWith("s")) {
    return parseInt(trimmed.slice(0, -1), 10) * 1000;
  }
  if (trimmed.endsWith("m")) {
    return parseInt(trimmed.slice(0, -1), 10) * 60 * 1000;
  }
  return parseInt(trimmed, 10);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return "N/A";
  return new Date(ts).toLocaleString();
}

async function runWatchdogStart(opts: WatchdogStartOptions): Promise<void> {
  const json = Boolean(opts.json);
  const foreground = Boolean(opts.foreground);
  const rich = isRich();

  // Check if already running
  const alreadyRunning = await isWatchdogRunning();
  if (alreadyRunning) {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: "Watchdog already running" }));
    } else {
      defaultRuntime.error("Watchdog is already running. Use 'infinibot watchdog stop' first.");
    }
    return;
  }

  // Build config
  const connectionDetails = buildGatewayConnectionDetails({ url: opts.gatewayUrl });
  const gatewayUrl = connectionDetails.url;
  
  // Resolve gateway command (point to self)
  const infinibotPath = process.argv[1]; // Path to infinibot CLI
  const gatewayCommand = ["node", infinibotPath, "gateway", "run"];

  const config: Partial<WatchdogConfig> = {
    gatewayUrl,
    gatewayToken: opts.token,
    gatewayPassword: opts.password,
    healthCheckIntervalMs: parseMs(opts.checkInterval, 30000),
    healthProbeTimeoutMs: parseMs(opts.probeTimeout, 10000),
    restartGracePeriodMs: parseMs(opts.gracePeriod, 15000),
    maxConsecutiveFailures: opts.maxFailures ? parseInt(opts.maxFailures, 10) : 3,
    maxRestartAttempts: opts.maxRestarts ? parseInt(opts.maxRestarts, 10) : 10,
    gatewayCommand,
    workingDirectory: process.cwd(),
    environment: {
      INFINIBOT_WATCHDOG: "1",
    },
  };

  if (!foreground) {
    // Spawn detached watchdog process
    const { spawn } = await import("node:child_process");
    
    const args = [infinibotPath, "watchdog", "start", "--foreground"];
    if (opts.gatewayUrl) args.push("--gateway-url", opts.gatewayUrl);
    if (opts.token) args.push("--token", opts.token);
    if (opts.password) args.push("--password", opts.password);
    if (opts.checkInterval) args.push("--check-interval", opts.checkInterval);
    if (opts.probeTimeout) args.push("--probe-timeout", opts.probeTimeout);
    if (opts.gracePeriod) args.push("--grace-period", opts.gracePeriod);
    if (opts.maxFailures) args.push("--max-failures", opts.maxFailures);
    if (opts.maxRestarts) args.push("--max-restarts", opts.maxRestarts);

    const stateDir = resolveGatewayStateDir(process.env);
    const logPath = path.join(stateDir, "watchdog-out.log");

    const fs = await import("node:fs");
    await import("node:fs/promises").then(fsp => fsp.mkdir(stateDir, { recursive: true }));
    const out = fs.openSync(logPath, "a");
    const err = fs.openSync(logPath, "a");

    const child = spawn("node", args, {
      detached: true,
      stdio: ["ignore", out, err],
      windowsHide: true,
    });

    child.unref();

    if (json) {
      console.log(JSON.stringify({
        ok: true,
        pid: child.pid,
        logPath,
        config: {
          gatewayUrl,
          healthCheckIntervalMs: config.healthCheckIntervalMs,
          maxRestartAttempts: config.maxRestartAttempts,
        },
      }));
    } else {
      console.log(`${colorize(rich, theme.success, "✓")} Watchdog started in background (PID: ${child.pid})`);
      console.log(`  ${colorize(rich, theme.muted, "Gateway URL:")} ${gatewayUrl}`);
      console.log(`  ${colorize(rich, theme.muted, "Health check interval:")} ${formatDuration(config.healthCheckIntervalMs!)}`);
      console.log(`  ${colorize(rich, theme.muted, "Max restart attempts:")} ${config.maxRestartAttempts}`);
      console.log(`  ${colorize(rich, theme.muted, "Log file:")} ${logPath}`);
    }
    return;
  }

  // Foreground mode - run watchdog directly
  if (!json) {
    console.log(`${colorize(rich, theme.success, "Starting watchdog in foreground mode...")}`);
    console.log(`  ${colorize(rich, theme.muted, "Gateway URL:")} ${gatewayUrl}`);
    console.log(`  ${colorize(rich, theme.muted, "Health check interval:")} ${formatDuration(config.healthCheckIntervalMs!)}`);
    console.log("");
  }

  const watchdog = new GatewayWatchdog(config);
  
  if (json) {
    watchdog.on("event", (event) => {
      console.log(JSON.stringify(event));
    });
  }

  await watchdog.start();
  
  // Keep running
  await new Promise(() => {});
}

async function runWatchdogStop(opts: WatchdogStopOptions): Promise<void> {
  const json = Boolean(opts.json);
  const rich = isRich();

  const running = await isWatchdogRunning();
  if (!running) {
    if (json) {
      console.log(JSON.stringify({ ok: true, message: "Watchdog not running" }));
    } else {
      console.log(`${colorize(rich, theme.muted, "Watchdog is not running")}`);
    }
    return;
  }

  const pid = await readWatchdogPid();
  const stopped = await stopWatchdogByPid();

  if (stopped) {
    if (json) {
      console.log(JSON.stringify({ ok: true, pid, message: "Watchdog stopped" }));
    } else {
      console.log(`${colorize(rich, theme.success, "✓")} Watchdog stopped (PID: ${pid})`);
    }
  } else {
    if (json) {
      console.log(JSON.stringify({ ok: false, error: "Failed to stop watchdog" }));
    } else {
      defaultRuntime.error("Failed to stop watchdog");
    }
  }
}

async function runWatchdogStatus(opts: WatchdogStatusOptions): Promise<void> {
  const json = Boolean(opts.json);
  const rich = isRich();

  const running = await isWatchdogRunning();
  const pid = await readWatchdogPid();
  const state = await readWatchdogState();
  const stateDir = resolveGatewayStateDir(process.env);
  const logPath = path.join(stateDir, "watchdog.log");

  if (json) {
    console.log(JSON.stringify({
      running,
      pid,
      state,
      logPath,
    }));
    return;
  }

  console.log("");
  console.log(colorize(rich, theme.accent, "━━━ InfiniBot Watchdog Status ━━━"));
  console.log("");

  if (running) {
    console.log(`  ${colorize(rich, theme.success, "●")} Status: ${colorize(rich, theme.success, "Running")}`);
    console.log(`  ${colorize(rich, theme.muted, "PID:")} ${pid}`);
  } else {
    console.log(`  ${colorize(rich, theme.error, "○")} Status: ${colorize(rich, theme.muted, "Stopped")}`);
  }

  if (state) {
    console.log("");
    console.log(`  ${colorize(rich, theme.muted, "Gateway PID:")} ${state.gatewayPid || "N/A"}`);
    console.log(`  ${colorize(rich, theme.muted, "Total restarts:")} ${state.totalRestarts}`);
    console.log(`  ${colorize(rich, theme.muted, "Last health check:")} ${formatTimestamp(state.lastHealthCheck)}`);
    console.log(`  ${colorize(rich, theme.muted, "Last health status:")} ${state.lastHealthStatus || "N/A"}`);
    console.log(`  ${colorize(rich, theme.muted, "Consecutive failures:")} ${state.consecutiveFailures}`);
    console.log(`  ${colorize(rich, theme.muted, "Last restart:")} ${formatTimestamp(state.lastRestartAt)}`);
    console.log(`  ${colorize(rich, theme.muted, "Watchdog started:")} ${formatTimestamp(state.watchdogStartedAt)}`);
    
    if (state.errorMessage) {
      console.log(`  ${colorize(rich, theme.error, "Error:")} ${state.errorMessage}`);
    }
  }

  console.log("");
  console.log(`  ${colorize(rich, theme.muted, "Log file:")} ${logPath}`);
  console.log("");
}

export function registerWatchdogCli(program: Command): void {
  const watchdog = program
    .command("watchdog")
    .description("Monitor and auto-restart the gateway");

  watchdog
    .command("start")
    .description("Start the watchdog (monitors and auto-restarts gateway)")
    .option("--gateway-url <url>", "Gateway WebSocket URL to monitor")
    .option("--token <token>", "Gateway auth token")
    .option("--password <password>", "Gateway auth password")
    .option("--check-interval <duration>", "Health check interval (e.g., 30s, 1m)", "30s")
    .option("--probe-timeout <duration>", "Health probe timeout (e.g., 10s)", "10s")
    .option("--grace-period <duration>", "Grace period after restart before health checks (e.g., 15s)", "15s")
    .option("--max-failures <n>", "Max consecutive failures before restart", "3")
    .option("--max-restarts <n>", "Max restart attempts (0 = unlimited)", "10")
    .option("--foreground", "Run in foreground (don't daemonize)")
    .option("--json", "Output in JSON format")
    .action(runWatchdogStart);

  watchdog
    .command("stop")
    .description("Stop the watchdog")
    .option("--json", "Output in JSON format")
    .action(runWatchdogStop);

  watchdog
    .command("status")
    .description("Show watchdog status")
    .option("--json", "Output in JSON format")
    .action(runWatchdogStatus);
}

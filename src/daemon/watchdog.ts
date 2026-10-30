/**
 * InfiniBot Gateway Watchdog
 *
 * Monitors the gateway process and automatically restarts it if:
 * - Process crashes/exits unexpectedly
 * - Health check fails (timeout or error)
 * - Gateway becomes unresponsive
 *
 * Features:
 * - Configurable health check interval
 * - Exponential backoff on repeated failures
 * - Max restart attempts before giving up
 * - Logging of all watchdog events
 * - Grace period after restart before next health check
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";

import { probeGateway } from "../gateway/probe.js";
import { resolveGatewayStateDir } from "./paths.js";
import { colorize, isRich, theme } from "../terminal/theme.js";

// ============================================================
// Types
// ============================================================

export interface WatchdogConfig {
  /** Gateway URL to probe (default: ws://127.0.0.1:7823) */
  gatewayUrl: string;
  /** Auth token for gateway (optional) */
  gatewayToken?: string;
  /** Auth password for gateway (optional) */
  gatewayPassword?: string;
  /** Health check interval in milliseconds (default: 30000 = 30s) */
  healthCheckIntervalMs: number;
  /** Health probe timeout in milliseconds (default: 10000 = 10s) */
  healthProbeTimeoutMs: number;
  /** Grace period after restart before first health check (default: 15000 = 15s) */
  restartGracePeriodMs: number;
  /** Max consecutive failures before attempting restart (default: 3) */
  maxConsecutiveFailures: number;
  /** Max restart attempts before giving up (default: 10, 0 = unlimited) */
  maxRestartAttempts: number;
  /** Base backoff delay between restart attempts (default: 5000 = 5s) */
  backoffBaseMs: number;
  /** Max backoff delay (default: 300000 = 5 minutes) */
  backoffMaxMs: number;
  /** Gateway command to run (e.g., ["node", "dist/cli/program.js", "gateway", "run"]) */
  gatewayCommand: string[];
  /** Working directory for gateway (optional) */
  workingDirectory?: string;
  /** Environment variables for gateway (optional) */
  environment?: Record<string, string>;
  /** Log file path (default: state/watchdog.log) */
  logFilePath?: string;
  /** State file path for watchdog state persistence (default: state/watchdog-state.json) */
  stateFilePath?: string;
}

export interface WatchdogState {
  status: "running" | "stopped" | "error";
  gatewayPid: number | null;
  lastHealthCheck: number | null;
  lastHealthStatus: "ok" | "failed" | "timeout" | null;
  consecutiveFailures: number;
  totalRestarts: number;
  lastRestartAt: number | null;
  watchdogStartedAt: number;
  errorMessage: string | null;
}

export interface WatchdogEvent {
  type:
    | "started"
    | "stopped"
    | "health_ok"
    | "health_failed"
    | "restart_attempt"
    | "restart_success"
    | "restart_failed"
    | "max_restarts_reached"
    | "gateway_exited"
    | "error";
  timestamp: number;
  details?: Record<string, unknown>;
}

// ============================================================
// Constants
// ============================================================

const DEFAULT_CONFIG: WatchdogConfig = {
  gatewayUrl: "ws://127.0.0.1:7823",
  healthCheckIntervalMs: 30_000,
  healthProbeTimeoutMs: 10_000,
  restartGracePeriodMs: 15_000,
  maxConsecutiveFailures: 3,
  maxRestartAttempts: 10,
  backoffBaseMs: 5_000,
  backoffMaxMs: 300_000,
  gatewayCommand: [],
};

const WATCHDOG_STATE_FILE = "watchdog-state.json";
const WATCHDOG_LOG_FILE = "watchdog.log";
const WATCHDOG_PID_FILE = "watchdog.pid";

// ============================================================
// Watchdog Class
// ============================================================

export class GatewayWatchdog extends EventEmitter {
  private config: WatchdogConfig;
  private state: WatchdogState;
  private gatewayProcess: ChildProcess | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private logStream: fs.FileHandle | null = null;

  constructor(config: Partial<WatchdogConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.state = this.createInitialState();
  }

  private createInitialState(): WatchdogState {
    return {
      status: "stopped",
      gatewayPid: null,
      lastHealthCheck: null,
      lastHealthStatus: null,
      consecutiveFailures: 0,
      totalRestarts: 0,
      lastRestartAt: null,
      watchdogStartedAt: Date.now(),
      errorMessage: null,
    };
  }

  // ============================================================
  // Logging
  // ============================================================

  private async openLogStream(): Promise<void> {
    try {
      const logPath =
        this.config.logFilePath ||
        path.join(resolveGatewayStateDir(process.env), WATCHDOG_LOG_FILE);
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      this.logStream = await fs.open(logPath, "a");
    } catch (err) {
      console.error("Failed to open watchdog log:", err);
    }
  }

  private async closeLogStream(): Promise<void> {
    if (this.logStream) {
      await this.logStream.close();
      this.logStream = null;
    }
  }

  private async log(
    level: "INFO" | "WARN" | "ERROR",
    message: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const timestamp = new Date().toISOString();
    const detailsStr = details ? ` ${JSON.stringify(details)}` : "";
    const line = `[${timestamp}] [${level}] ${message}${detailsStr}\n`;

    // Console output with colors
    const rich = isRich();
    const levelColor =
      level === "ERROR" ? theme.error : level === "WARN" ? theme.warn : theme.muted;
    const consoleMsg = `${colorize(rich, theme.muted, `[${timestamp}]`)} ${colorize(rich, levelColor, `[${level}]`)} ${message}`;
    if (level === "ERROR") {
      console.error(consoleMsg);
    } else {
      console.log(consoleMsg);
    }

    // File output
    if (this.logStream) {
      try {
        await this.logStream.write(line);
      } catch {
        // Ignore file write errors
      }
    }
  }

  private emitEvent(event: WatchdogEvent): void {
    this.emit("event", event);
    void this.log(
      event.type === "error" ||
        event.type === "restart_failed" ||
        event.type === "max_restarts_reached"
        ? "ERROR"
        : event.type === "health_failed" || event.type === "gateway_exited"
          ? "WARN"
          : "INFO",
      `Watchdog event: ${event.type}`,
      event.details,
    );
  }

  // ============================================================
  // State Persistence
  // ============================================================

  private async saveState(): Promise<void> {
    try {
      const statePath =
        this.config.stateFilePath ||
        path.join(resolveGatewayStateDir(process.env), WATCHDOG_STATE_FILE);
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      await this.log("WARN", "Failed to save watchdog state", { error: String(err) });
    }
  }

  private async savePidFile(): Promise<void> {
    try {
      const pidPath = path.join(resolveGatewayStateDir(process.env), WATCHDOG_PID_FILE);
      await fs.mkdir(path.dirname(pidPath), { recursive: true });
      await fs.writeFile(pidPath, String(process.pid));
    } catch (err) {
      await this.log("WARN", "Failed to save watchdog PID file", { error: String(err) });
    }
  }

  private async removePidFile(): Promise<void> {
    try {
      const pidPath = path.join(resolveGatewayStateDir(process.env), WATCHDOG_PID_FILE);
      await fs.unlink(pidPath);
    } catch {
      // Ignore - file may not exist
    }
  }

  // ============================================================
  // Gateway Process Management
  // ============================================================

  private async startGateway(): Promise<boolean> {
    if (this.config.gatewayCommand.length === 0) {
      await this.log("ERROR", "No gateway command configured");
      return false;
    }

    const [command, ...args] = this.config.gatewayCommand;

    await this.log("INFO", `Starting gateway: ${command} ${args.join(" ")}`);

    try {
      this.gatewayProcess = spawn(command, args, {
        cwd: this.config.workingDirectory,
        env: { ...process.env, ...this.config.environment },
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        windowsHide: true,
      });

      const pid = this.gatewayProcess.pid;
      if (!pid) {
        await this.log("ERROR", "Failed to get gateway PID");
        return false;
      }

      this.state.gatewayPid = pid;
      await this.log("INFO", `Gateway started with PID ${pid}`);

      // Handle gateway stdout/stderr
      this.gatewayProcess.stdout?.on("data", (data) => {
        const lines = data
          .toString()
          .split("\n")
          .filter((l: string) => l.trim());
        for (const line of lines) {
          void this.log("INFO", `[Gateway] ${line}`);
        }
      });

      this.gatewayProcess.stderr?.on("data", (data) => {
        const lines = data
          .toString()
          .split("\n")
          .filter((l: string) => l.trim());
        for (const line of lines) {
          void this.log("WARN", `[Gateway:stderr] ${line}`);
        }
      });

      // Handle gateway exit
      this.gatewayProcess.on("exit", (code, signal) => {
        this.handleGatewayExit(code, signal);
      });

      this.gatewayProcess.on("error", (err) => {
        void this.log("ERROR", `Gateway process error: ${err.message}`);
        this.emitEvent({ type: "error", timestamp: Date.now(), details: { error: err.message } });
      });

      return true;
    } catch (err) {
      await this.log("ERROR", `Failed to start gateway: ${String(err)}`);
      return false;
    }
  }

  private handleGatewayExit(code: number | null, signal: NodeJS.Signals | null): void {
    const exitInfo = signal ? `signal ${signal}` : `code ${code}`;
    void this.log("WARN", `Gateway exited with ${exitInfo}`);

    this.state.gatewayPid = null;
    this.gatewayProcess = null;

    this.emitEvent({
      type: "gateway_exited",
      timestamp: Date.now(),
      details: { code, signal },
    });

    // If not shutting down, attempt restart
    if (!this.isShuttingDown) {
      void this.scheduleRestart();
    }
  }

  private async killGateway(): Promise<void> {
    if (!this.gatewayProcess) return;

    await this.log("INFO", "Stopping gateway process");

    return new Promise((resolve) => {
      const proc = this.gatewayProcess;
      if (!proc) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Process may already be dead
        }
        resolve();
      }, 5000);

      proc.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        proc.kill("SIGTERM");
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  // ============================================================
  // Health Checks
  // ============================================================

  private async performHealthCheck(): Promise<boolean> {
    try {
      const result = await probeGateway({
        url: this.config.gatewayUrl,
        auth: {
          token: this.config.gatewayToken,
          password: this.config.gatewayPassword,
        },
        timeoutMs: this.config.healthProbeTimeoutMs,
      });

      this.state.lastHealthCheck = Date.now();

      if (result.ok) {
        this.state.lastHealthStatus = "ok";
        this.state.consecutiveFailures = 0;
        this.emitEvent({
          type: "health_ok",
          timestamp: Date.now(),
          details: { latencyMs: result.connectLatencyMs },
        });
        return true;
      } else {
        this.state.lastHealthStatus = "failed";
        this.state.consecutiveFailures++;
        this.emitEvent({
          type: "health_failed",
          timestamp: Date.now(),
          details: { error: result.error, consecutiveFailures: this.state.consecutiveFailures },
        });
        return false;
      }
    } catch (err) {
      this.state.lastHealthCheck = Date.now();
      this.state.lastHealthStatus = "timeout";
      this.state.consecutiveFailures++;
      this.emitEvent({
        type: "health_failed",
        timestamp: Date.now(),
        details: { error: String(err), consecutiveFailures: this.state.consecutiveFailures },
      });
      return false;
    }
  }

  private async runHealthCheckLoop(): Promise<void> {
    if (this.isShuttingDown) return;

    const healthy = await this.performHealthCheck();
    await this.saveState();

    if (!healthy && this.state.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      await this.log(
        "WARN",
        `Health check failed ${this.state.consecutiveFailures} times, triggering restart`,
      );
      await this.killGateway();
      void this.scheduleRestart();
      return;
    }

    // Schedule next health check
    this.scheduleHealthCheck();
  }

  private scheduleHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
    }
    this.healthCheckTimer = setTimeout(() => {
      void this.runHealthCheckLoop();
    }, this.config.healthCheckIntervalMs);
  }

  // ============================================================
  // Restart Logic
  // ============================================================

  private calculateBackoff(): number {
    const attempts = this.state.totalRestarts;
    const backoff = Math.min(
      this.config.backoffBaseMs * Math.pow(2, attempts),
      this.config.backoffMaxMs,
    );
    // Add jitter (±20%)
    const jitter = backoff * 0.2 * (Math.random() - 0.5);
    return Math.floor(backoff + jitter);
  }

  private async scheduleRestart(): Promise<void> {
    if (this.isShuttingDown) return;

    // Check max restart attempts
    if (
      this.config.maxRestartAttempts > 0 &&
      this.state.totalRestarts >= this.config.maxRestartAttempts
    ) {
      await this.log(
        "ERROR",
        `Max restart attempts (${this.config.maxRestartAttempts}) reached, giving up`,
      );
      this.state.status = "error";
      this.state.errorMessage = "Max restart attempts reached";
      this.emitEvent({
        type: "max_restarts_reached",
        timestamp: Date.now(),
        details: { totalRestarts: this.state.totalRestarts },
      });
      await this.saveState();
      return;
    }

    const backoffMs = this.calculateBackoff();
    await this.log(
      "INFO",
      `Scheduling restart in ${backoffMs}ms (attempt ${this.state.totalRestarts + 1})`,
    );

    this.emitEvent({
      type: "restart_attempt",
      timestamp: Date.now(),
      details: { attempt: this.state.totalRestarts + 1, backoffMs },
    });

    setTimeout(async () => {
      if (this.isShuttingDown) return;

      this.state.totalRestarts++;
      this.state.lastRestartAt = Date.now();
      this.state.consecutiveFailures = 0;

      const success = await this.startGateway();

      if (success) {
        this.emitEvent({
          type: "restart_success",
          timestamp: Date.now(),
          details: { totalRestarts: this.state.totalRestarts },
        });

        // Wait grace period before starting health checks
        await this.log(
          "INFO",
          `Waiting ${this.config.restartGracePeriodMs}ms grace period before health checks`,
        );
        setTimeout(() => {
          if (!this.isShuttingDown) {
            this.scheduleHealthCheck();
          }
        }, this.config.restartGracePeriodMs);
      } else {
        this.emitEvent({
          type: "restart_failed",
          timestamp: Date.now(),
          details: { totalRestarts: this.state.totalRestarts },
        });
        void this.scheduleRestart();
      }

      await this.saveState();
    }, backoffMs);
  }

  // ============================================================
  // Public API
  // ============================================================

  async start(): Promise<void> {
    if (this.state.status === "running") {
      await this.log("WARN", "Watchdog already running");
      return;
    }

    await this.openLogStream();
    await this.savePidFile();

    await this.log("INFO", "Starting InfiniBot Gateway Watchdog");
    this.emitEvent({ type: "started", timestamp: Date.now(), details: { config: this.config } });

    this.state = this.createInitialState();
    this.state.status = "running";
    this.isShuttingDown = false;

    // Start the gateway
    const started = await this.startGateway();
    if (started) {
      // Wait grace period, then start health checks
      setTimeout(() => {
        if (!this.isShuttingDown) {
          this.scheduleHealthCheck();
        }
      }, this.config.restartGracePeriodMs);
    } else {
      void this.scheduleRestart();
    }

    await this.saveState();

    // Handle process signals
    const handleSignal = async (signal: NodeJS.Signals) => {
      await this.log("INFO", `Received ${signal}, shutting down`);
      await this.stop();
      process.exit(0);
    };

    process.on("SIGTERM", () => handleSignal("SIGTERM"));
    process.on("SIGINT", () => handleSignal("SIGINT"));
  }

  async stop(): Promise<void> {
    if (this.state.status !== "running") {
      return;
    }

    await this.log("INFO", "Stopping watchdog");
    this.isShuttingDown = true;
    this.state.status = "stopped";

    // Stop health check timer
    if (this.healthCheckTimer) {
      clearTimeout(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }

    // Kill gateway process
    await this.killGateway();

    this.emitEvent({ type: "stopped", timestamp: Date.now() });
    await this.saveState();
    await this.removePidFile();
    await this.closeLogStream();
  }

  getState(): WatchdogState {
    return { ...this.state };
  }

  getConfig(): WatchdogConfig {
    return { ...this.config };
  }
}

// ============================================================
// Watchdog State File Utilities
// ============================================================

export async function readWatchdogState(
  env: Record<string, string | undefined> = process.env,
): Promise<WatchdogState | null> {
  try {
    const statePath = path.join(resolveGatewayStateDir(env), WATCHDOG_STATE_FILE);
    const content = await fs.readFile(statePath, "utf8");
    return JSON.parse(content) as WatchdogState;
  } catch {
    return null;
  }
}

export async function readWatchdogPid(
  env: Record<string, string | undefined> = process.env,
): Promise<number | null> {
  try {
    const pidPath = path.join(resolveGatewayStateDir(env), WATCHDOG_PID_FILE);
    const content = await fs.readFile(pidPath, "utf8");
    const pid = parseInt(content.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export async function isWatchdogRunning(
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const pid = await readWatchdogPid(env);
  if (!pid) return false;

  try {
    // Check if process is running (signal 0 doesn't kill, just checks)
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopWatchdogByPid(
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const pid = await readWatchdogPid(env);
  if (!pid) return false;

  try {
    process.kill(pid, "SIGTERM");
    // Wait a bit for graceful shutdown
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// CLI Entry Point
// ============================================================

export async function runWatchdog(config: Partial<WatchdogConfig>): Promise<void> {
  const watchdog = new GatewayWatchdog(config);
  await watchdog.start();

  // Keep the process running
  await new Promise(() => {});
}

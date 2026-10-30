/**
 * Auto-Update Server - Automatic update checking and application
 *
 * Periodically checks for updates and optionally applies them automatically.
 * Integrates with existing update infrastructure (update-runner, update-check).
 */

import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "node:fs/promises";

import type { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveInfiniBotPackageRoot } from "./infinibot-root.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  resolveNpmChannelTag,
  checkGitUpdateStatus,
} from "./update-check.js";
import {
  runGatewayUpdate,
  type UpdateRunResult,
  type UpdateStepProgress,
} from "./update-runner.js";
import { scheduleGatewaySigusr1Restart } from "./restart.js";
import {
  writeRestartSentinel,
  type RestartSentinelPayload,
  formatDoctorNonInteractiveHint,
} from "./restart-sentinel.js";
import {
  normalizeUpdateChannel,
  DEFAULT_PACKAGE_CHANNEL,
  DEFAULT_GIT_CHANNEL,
  type UpdateChannel,
} from "./update-channels.js";
import { VERSION } from "../version.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AutoUpdateConfig = {
  /** Enable automatic update checking. Default: false */
  enabled?: boolean;
  /** Check interval in minutes. Default: 360 (6 hours) */
  intervalMinutes?: number;
  /** Automatically apply updates when found. Default: false */
  autoApply?: boolean;
  /** Quiet hours - don't auto-apply during these times */
  quietHours?: {
    enabled?: boolean;
    /** Start hour (0-23). Default: 2 */
    start?: number;
    /** End hour (0-23). Default: 6 */
    end?: number;
  };
  /** Notification settings */
  notifications?: {
    /** Notify on update available */
    onAvailable?: boolean;
    /** Notify before auto-applying */
    onBeforeApply?: boolean;
    /** Notify after update applied */
    onApplied?: boolean;
    /** Notify on update failure */
    onFailure?: boolean;
    /** Session key to notify (default: last active main session) */
    targetSession?: string;
  };
  /** Delay after update check before applying (seconds). Default: 30 */
  applyDelaySeconds?: number;
  /** Max consecutive failures before backing off. Default: 3 */
  maxConsecutiveFailures?: number;
  /** Backoff multiplier after failures. Default: 2 */
  backoffMultiplier?: number;
  /** Max backoff interval in minutes. Default: 1440 (24 hours) */
  maxBackoffMinutes?: number;
};

export type AutoUpdateState = {
  /** Is auto-update enabled */
  enabled: boolean;
  /** Current check interval (may be backed off) */
  currentIntervalMinutes: number;
  /** Last check timestamp */
  lastCheckAt: string | null;
  /** Last check result */
  lastCheckResult: "up-to-date" | "update-available" | "error" | null;
  /** Last update timestamp */
  lastUpdateAt: string | null;
  /** Last update result */
  lastUpdateResult: "ok" | "error" | "skipped" | null;
  /** Available update version (if any) */
  availableVersion: string | null;
  /** Current version */
  currentVersion: string;
  /** Next scheduled check */
  nextCheckAt: string | null;
  /** Consecutive failure count */
  consecutiveFailures: number;
  /** Is currently checking */
  isChecking: boolean;
  /** Is currently updating */
  isUpdating: boolean;
  /** Update channel */
  channel: UpdateChannel;
  /** Install kind */
  installKind: "git" | "package" | "unknown";
  /** Last error message */
  lastError: string | null;
};

export type AutoUpdateCheckResult = {
  hasUpdate: boolean;
  currentVersion: string;
  availableVersion: string | null;
  channel: UpdateChannel;
  installKind: "git" | "package" | "unknown";
  gitStatus?: {
    behind: number;
    ahead: number;
    branch: string | null;
    upstream: string | null;
    dirty: boolean;
  };
  error?: string;
};

export type AutoUpdateApplyResult = {
  applied: boolean;
  result?: UpdateRunResult;
  error?: string;
  willRestart: boolean;
  restartDelayMs?: number;
};

type AutoUpdatePersistentState = {
  lastCheckAt?: string;
  lastCheckResult?: "up-to-date" | "update-available" | "error";
  lastUpdateAt?: string;
  lastUpdateResult?: "ok" | "error" | "skipped";
  availableVersion?: string | null;
  consecutiveFailures?: number;
  lastError?: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────────

export interface AutoUpdateEvents {
  "check:start": [];
  "check:complete": [result: AutoUpdateCheckResult];
  "check:error": [error: Error];
  "update:available": [version: string, channel: UpdateChannel];
  "update:start": [];
  "update:progress": [step: string, progress: number];
  "update:complete": [result: UpdateRunResult];
  "update:error": [error: Error];
  "update:skipped": [reason: string];
  "state:changed": [state: AutoUpdateState];
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-Update Server
// ─────────────────────────────────────────────────────────────────────────────

const STATE_FILENAME = "auto-update-state.json";
const DEFAULT_INTERVAL_MINUTES = 360; // 6 hours
const MIN_INTERVAL_MINUTES = 15;
const DEFAULT_APPLY_DELAY_SECONDS = 30;
const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_MAX_BACKOFF_MINUTES = 1440; // 24 hours
const DEFAULT_QUIET_START = 2;
const DEFAULT_QUIET_END = 6;

export class AutoUpdateServer extends EventEmitter<AutoUpdateEvents> {
  private config: AutoUpdateConfig;
  private infinibotConfig: ReturnType<typeof loadConfig>;
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private applyTimer: ReturnType<typeof setTimeout> | null = null;
  private isChecking = false;
  private isUpdating = false;
  private persistentState: AutoUpdatePersistentState = {};
  private root: string | null = null;
  private installKind: "git" | "package" | "unknown" = "unknown";
  private channel: UpdateChannel = DEFAULT_PACKAGE_CHANNEL;
  private logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };

  constructor(params: {
    config?: AutoUpdateConfig;
    infinibotConfig: ReturnType<typeof loadConfig>;
    logger?: {
      info: (msg: string, meta?: Record<string, unknown>) => void;
      warn: (msg: string, meta?: Record<string, unknown>) => void;
      error: (msg: string, meta?: Record<string, unknown>) => void;
    };
  }) {
    super();
    this.config = params.config ?? {};
    this.infinibotConfig = params.infinibotConfig;
    this.logger = params.logger ?? {
      info: (msg) => console.log(`[auto-update] ${msg}`),
      warn: (msg) => console.warn(`[auto-update] ${msg}`),
      error: (msg) => console.error(`[auto-update] ${msg}`),
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Load persistent state
    await this.loadState();

    // Detect install kind and root
    this.root = await resolveInfiniBotPackageRoot({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });

    if (this.root) {
      const status = await checkUpdateStatus({
        root: this.root,
        timeoutMs: 5000,
        fetchGit: false,
        includeRegistry: false,
      });
      this.installKind = status.installKind;
    }

    // Resolve channel
    this.channel =
      normalizeUpdateChannel(this.infinibotConfig.update?.channel) ??
      (this.installKind === "git" ? DEFAULT_GIT_CHANNEL : DEFAULT_PACKAGE_CHANNEL);

    if (this.config.enabled !== false && this.config.enabled) {
      this.scheduleNextCheck();
      this.logger.info(
        `auto-update started (interval: ${this.getEffectiveInterval()}min, channel: ${this.channel})`,
      );
    }
  }

  stop(): void {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
    if (this.applyTimer) {
      clearTimeout(this.applyTimer);
      this.applyTimer = null;
    }
    this.logger.info("auto-update stopped");
  }

  async enable(): Promise<void> {
    this.config.enabled = true;
    if (!this.checkTimer) {
      this.scheduleNextCheck();
    }
    this.emitStateChanged();
    this.logger.info("auto-update enabled");
  }

  async disable(): Promise<void> {
    this.config.enabled = false;
    this.stop();
    this.emitStateChanged();
    this.logger.info("auto-update disabled");
  }

  updateConfig(config: Partial<AutoUpdateConfig>): void {
    this.config = { ...this.config, ...config };
    // Reschedule if interval changed
    if (config.intervalMinutes !== undefined && this.config.enabled) {
      this.stop();
      this.scheduleNextCheck();
    }
    this.emitStateChanged();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // State
  // ───────────────────────────────────────────────────────────────────────────

  getState(): AutoUpdateState {
    const effectiveInterval = this.getEffectiveInterval();
    const nextCheckAt =
      this.checkTimer && this.config.enabled
        ? new Date(Date.now() + effectiveInterval * 60 * 1000).toISOString()
        : null;

    return {
      enabled: this.config.enabled ?? false,
      currentIntervalMinutes: effectiveInterval,
      lastCheckAt: this.persistentState.lastCheckAt ?? null,
      lastCheckResult: this.persistentState.lastCheckResult ?? null,
      lastUpdateAt: this.persistentState.lastUpdateAt ?? null,
      lastUpdateResult: this.persistentState.lastUpdateResult ?? null,
      availableVersion: this.persistentState.availableVersion ?? null,
      currentVersion: VERSION,
      nextCheckAt,
      consecutiveFailures: this.persistentState.consecutiveFailures ?? 0,
      isChecking: this.isChecking,
      isUpdating: this.isUpdating,
      channel: this.channel,
      installKind: this.installKind,
      lastError: this.persistentState.lastError ?? null,
    };
  }

  private getEffectiveInterval(): number {
    const baseInterval = Math.max(
      this.config.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
      MIN_INTERVAL_MINUTES,
    );
    const failures = this.persistentState.consecutiveFailures ?? 0;
    if (failures === 0) return baseInterval;

    const maxBackoff = this.config.maxBackoffMinutes ?? DEFAULT_MAX_BACKOFF_MINUTES;
    const multiplier = this.config.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
    const backoff = baseInterval * Math.pow(multiplier, failures);
    return Math.min(backoff, maxBackoff);
  }

  private async loadState(): Promise<void> {
    const statePath = path.join(resolveStateDir(), STATE_FILENAME);
    try {
      const raw = await fs.readFile(statePath, "utf-8");
      const parsed = JSON.parse(raw) as AutoUpdatePersistentState;
      if (parsed && typeof parsed === "object") {
        this.persistentState = parsed;
      }
    } catch {
      // State file doesn't exist or is invalid
      this.persistentState = {};
    }
  }

  private async saveState(): Promise<void> {
    const statePath = path.join(resolveStateDir(), STATE_FILENAME);
    try {
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(statePath, JSON.stringify(this.persistentState, null, 2), "utf-8");
    } catch (err) {
      this.logger.error(`failed to save state: ${err}`);
    }
  }

  private emitStateChanged(): void {
    this.emit("state:changed", this.getState());
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Scheduling
  // ───────────────────────────────────────────────────────────────────────────

  private scheduleNextCheck(): void {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
    }

    const intervalMs = this.getEffectiveInterval() * 60 * 1000;
    this.checkTimer = setTimeout(() => {
      void this.runScheduledCheck();
    }, intervalMs);

    this.emitStateChanged();
  }

  private async runScheduledCheck(): Promise<void> {
    if (!this.config.enabled) return;

    try {
      const result = await this.checkForUpdate();

      if (result.hasUpdate && this.config.autoApply) {
        // Check quiet hours
        if (this.isInQuietHours()) {
          this.logger.info("update available but in quiet hours, skipping auto-apply");
          this.emit("update:skipped", "quiet-hours");
        } else {
          // Schedule apply with delay
          const delayMs = (this.config.applyDelaySeconds ?? DEFAULT_APPLY_DELAY_SECONDS) * 1000;
          this.logger.info(`update available, scheduling apply in ${delayMs / 1000}s`);

          if (this.applyTimer) clearTimeout(this.applyTimer);
          this.applyTimer = setTimeout(() => {
            void this.applyUpdate();
          }, delayMs);
        }
      }
    } catch (err) {
      this.logger.error(`scheduled check failed: ${err}`);
    }

    // Schedule next check
    if (this.config.enabled) {
      this.scheduleNextCheck();
    }
  }

  private isInQuietHours(): boolean {
    if (!this.config.quietHours?.enabled) return false;

    const now = new Date();
    const hour = now.getHours();
    const start = this.config.quietHours.start ?? DEFAULT_QUIET_START;
    const end = this.config.quietHours.end ?? DEFAULT_QUIET_END;

    if (start <= end) {
      return hour >= start && hour < end;
    } else {
      // Crosses midnight (e.g., 22:00 - 06:00)
      return hour >= start || hour < end;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Update Check
  // ───────────────────────────────────────────────────────────────────────────

  async checkForUpdate(): Promise<AutoUpdateCheckResult> {
    if (this.isChecking) {
      return {
        hasUpdate: false,
        currentVersion: VERSION,
        availableVersion: null,
        channel: this.channel,
        installKind: this.installKind,
        error: "check already in progress",
      };
    }

    this.isChecking = true;
    this.emit("check:start");
    this.emitStateChanged();

    try {
      const result = await this.performCheck();

      this.persistentState.lastCheckAt = new Date().toISOString();
      this.persistentState.lastCheckResult = result.hasUpdate ? "update-available" : "up-to-date";
      this.persistentState.availableVersion = result.availableVersion;
      this.persistentState.lastError = result.error ?? null;

      if (!result.error) {
        this.persistentState.consecutiveFailures = 0;
      } else {
        this.persistentState.consecutiveFailures =
          (this.persistentState.consecutiveFailures ?? 0) + 1;
      }

      await this.saveState();
      this.emit("check:complete", result);

      if (result.hasUpdate && result.availableVersion) {
        this.emit("update:available", result.availableVersion, this.channel);
      }

      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.persistentState.lastCheckAt = new Date().toISOString();
      this.persistentState.lastCheckResult = "error";
      this.persistentState.lastError = error.message;
      this.persistentState.consecutiveFailures =
        (this.persistentState.consecutiveFailures ?? 0) + 1;

      await this.saveState();
      this.emit("check:error", error);

      return {
        hasUpdate: false,
        currentVersion: VERSION,
        availableVersion: null,
        channel: this.channel,
        installKind: this.installKind,
        error: error.message,
      };
    } finally {
      this.isChecking = false;
      this.emitStateChanged();
    }
  }

  private async performCheck(): Promise<AutoUpdateCheckResult> {
    if (!this.root) {
      return {
        hasUpdate: false,
        currentVersion: VERSION,
        availableVersion: null,
        channel: this.channel,
        installKind: "unknown",
        error: "infinibot root not found",
      };
    }

    if (this.installKind === "git") {
      // Git install - check for commits behind
      const gitStatus = await checkGitUpdateStatus({
        root: this.root,
        timeoutMs: 10000,
        fetch: true,
      });

      if (gitStatus.error) {
        return {
          hasUpdate: false,
          currentVersion: VERSION,
          availableVersion: null,
          channel: this.channel,
          installKind: "git",
          error: gitStatus.error,
        };
      }

      const hasUpdate = (gitStatus.behind ?? 0) > 0;
      const gitStatusInfo = {
        behind: gitStatus.behind ?? 0,
        ahead: gitStatus.ahead ?? 0,
        branch: gitStatus.branch,
        upstream: gitStatus.upstream,
        dirty: gitStatus.dirty ?? false,
      };

      return {
        hasUpdate,
        currentVersion: VERSION,
        availableVersion: hasUpdate ? `${gitStatus.behind} commits behind` : null,
        channel: this.channel,
        installKind: "git",
        gitStatus: gitStatusInfo,
      };
    }

    // npm package install - check registry
    const resolved = await resolveNpmChannelTag({ channel: this.channel, timeoutMs: 5000 });

    if (!resolved.version) {
      return {
        hasUpdate: false,
        currentVersion: VERSION,
        availableVersion: null,
        channel: this.channel,
        installKind: "package",
        error: "failed to fetch version from registry",
      };
    }

    const cmp = compareSemverStrings(VERSION, resolved.version);
    const hasUpdate = cmp != null && cmp < 0;

    return {
      hasUpdate,
      currentVersion: VERSION,
      availableVersion: hasUpdate ? resolved.version : null,
      channel: this.channel,
      installKind: "package",
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Update Apply
  // ───────────────────────────────────────────────────────────────────────────

  async applyUpdate(params?: {
    sessionKey?: string;
    note?: string;
    restartDelayMs?: number;
  }): Promise<AutoUpdateApplyResult> {
    if (this.isUpdating) {
      return {
        applied: false,
        error: "update already in progress",
        willRestart: false,
      };
    }

    if (!this.root) {
      return {
        applied: false,
        error: "infinibot root not found",
        willRestart: false,
      };
    }

    this.isUpdating = true;
    this.emit("update:start");
    this.emitStateChanged();

    try {
      const progress: UpdateStepProgress = {
        onStepStart: (step) => {
          this.emit("update:progress", step.name, (step.index / step.total) * 100);
        },
        onStepComplete: (step) => {
          this.emit("update:progress", step.name, ((step.index + 1) / step.total) * 100);
        },
      };

      const result = await runGatewayUpdate({
        cwd: this.root,
        argv1: process.argv[1],
        channel: this.channel,
        progress,
      });

      this.persistentState.lastUpdateAt = new Date().toISOString();
      this.persistentState.lastUpdateResult = result.status;

      if (result.status === "ok") {
        this.persistentState.consecutiveFailures = 0;
        this.persistentState.availableVersion = null;
        this.persistentState.lastError = null;
      } else {
        this.persistentState.lastError = result.reason ?? "unknown error";
        this.persistentState.consecutiveFailures =
          (this.persistentState.consecutiveFailures ?? 0) + 1;
      }

      await this.saveState();

      if (result.status === "ok") {
        // Write restart sentinel
        const payload: RestartSentinelPayload = {
          kind: "update",
          status: "ok",
          ts: Date.now(),
          sessionKey: params?.sessionKey,
          message: params?.note ?? "auto-update",
          doctorHint: formatDoctorNonInteractiveHint(),
          stats: {
            mode: result.mode,
            root: result.root,
            before: result.before ?? null,
            after: result.after ?? null,
            steps: result.steps.map((step) => ({
              name: step.name,
              command: step.command,
              cwd: step.cwd,
              durationMs: step.durationMs,
              log: {
                stdoutTail: step.stdoutTail ?? null,
                stderrTail: step.stderrTail ?? null,
                exitCode: step.exitCode ?? null,
              },
            })),
            reason: result.reason ?? null,
            durationMs: result.durationMs,
          },
        };

        await writeRestartSentinel(payload).catch(() => null);

        // Schedule restart
        const restartDelayMs = params?.restartDelayMs ?? 2000;
        scheduleGatewaySigusr1Restart({
          delayMs: restartDelayMs,
          reason: "auto-update",
        });

        this.emit("update:complete", result);

        return {
          applied: true,
          result,
          willRestart: true,
          restartDelayMs,
        };
      }

      if (result.status === "skipped") {
        this.emit("update:skipped", result.reason ?? "unknown");
        return {
          applied: false,
          result,
          error: result.reason,
          willRestart: false,
        };
      }

      // Error
      this.emit("update:error", new Error(result.reason ?? "update failed"));
      return {
        applied: false,
        result,
        error: result.reason,
        willRestart: false,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.persistentState.lastUpdateAt = new Date().toISOString();
      this.persistentState.lastUpdateResult = "error";
      this.persistentState.lastError = error.message;
      this.persistentState.consecutiveFailures =
        (this.persistentState.consecutiveFailures ?? 0) + 1;

      await this.saveState();
      this.emit("update:error", error);

      return {
        applied: false,
        error: error.message,
        willRestart: false,
      };
    } finally {
      this.isUpdating = false;
      this.emitStateChanged();
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Manual Triggers
  // ───────────────────────────────────────────────────────────────────────────

  async triggerCheck(): Promise<AutoUpdateCheckResult> {
    return this.checkForUpdate();
  }

  async triggerUpdate(params?: {
    sessionKey?: string;
    note?: string;
    restartDelayMs?: number;
  }): Promise<AutoUpdateApplyResult> {
    return this.applyUpdate(params);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton instance
// ─────────────────────────────────────────────────────────────────────────────

let autoUpdateServer: AutoUpdateServer | null = null;

export function getAutoUpdateServer(): AutoUpdateServer | null {
  return autoUpdateServer;
}

export function initAutoUpdateServer(params: {
  config?: AutoUpdateConfig;
  infinibotConfig: ReturnType<typeof loadConfig>;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}): AutoUpdateServer {
  if (autoUpdateServer) {
    autoUpdateServer.stop();
  }
  autoUpdateServer = new AutoUpdateServer(params);
  return autoUpdateServer;
}

export function stopAutoUpdateServer(): void {
  if (autoUpdateServer) {
    autoUpdateServer.stop();
    autoUpdateServer = null;
  }
}

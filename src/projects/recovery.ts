/**
 * Deep Memory Architecture — Recovery System
 *
 * Detects stale sessions (no heartbeat) and attempts auto-recovery.
 * Handles device shutdown, crash, and network disconnect scenarios.
 */

import { getProjectStore, type ProjectStore } from "./store.js";
import { getCheckpointManager, type CheckpointManager } from "./checkpoint.js";
import { readTaskFile, writeTaskFile, sessionToTaskDocument } from "./task-parser.js";
import type { ProjectSession } from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// RECOVERY MANAGER
// ═══════════════════════════════════════════════════════════════════

export class RecoveryManager {
  private store: ProjectStore;
  private checkpoints: CheckpointManager;

  constructor(stateDir?: string) {
    this.store = getProjectStore(stateDir);
    this.checkpoints = getCheckpointManager(stateDir);
  }

  /**
   * Scan for stale sessions and attempt recovery.
   * Call this from heartbeat or on gateway startup.
   */
  async detectAndRecoverStaleSessions(): Promise<RecoveryReport> {
    const report: RecoveryReport = {
      scannedAt: Date.now(),
      staleSessions: [],
      recovered: [],
      failed: [],
      abandoned: [],
    };

    // Find sessions that haven't sent a heartbeat within their timeout
    const staleSessions = this.store.findStaleSessions();
    report.staleSessions = staleSessions.map((s) => s.id);

    for (const session of staleSessions) {
      console.log(
        `[recovery] Detected stale session: ${session.projectId} (last heartbeat: ${session.heartbeatAt ? new Date(session.heartbeatAt).toISOString() : "never"})`,
      );

      // Mark as stale
      this.store.markStale(session.id);
      this.store.appendAudit(session.id, "stale_detected", "system", {
        lastHeartbeat: session.heartbeatAt,
        staleTimeoutMs: session.staleTimeoutMs,
      });

      // Check recovery attempts
      if (session.recoveryAttempts >= session.maxRecoveryAttempts) {
        console.log(
          `[recovery] Session ${session.projectId} exceeded max recovery attempts (${session.maxRecoveryAttempts}), marking as failed`,
        );

        this.store.updateSession(session.id, { status: "failed" });
        this.store.appendAudit(session.id, "recovery_failed", "system", {
          attempts: session.recoveryAttempts,
          maxAttempts: session.maxRecoveryAttempts,
        });

        report.abandoned.push({
          sessionId: session.id,
          projectId: session.projectId,
          reason: "Max recovery attempts exceeded",
        });

        continue;
      }

      // Attempt recovery
      const recovered = await this.attemptRecovery(session);

      if (recovered) {
        report.recovered.push({
          sessionId: session.id,
          projectId: session.projectId,
          checkpointId: recovered.checkpointId ?? "none",
        });
      } else {
        report.failed.push({
          sessionId: session.id,
          projectId: session.projectId,
          reason: "Recovery failed",
        });
      }
    }

    return report;
  }

  /**
   * Attempt to recover a single stale session.
   */
  async attemptRecovery(session: ProjectSession): Promise<ProjectSession | null> {
    console.log(
      `[recovery] Attempting recovery for ${session.projectId} (attempt ${session.recoveryAttempts + 1}/${session.maxRecoveryAttempts})`,
    );

    // Increment recovery attempts and mark as recovering
    this.store.incrementRecoveryAttempts(session.id);
    this.store.appendAudit(session.id, "recovery_started", "system", {
      attempt: session.recoveryAttempts + 1,
    });

    // Get latest checkpoint
    const checkpoint = this.checkpoints.getLatestCheckpoint(session.id);

    if (checkpoint) {
      // Restore from checkpoint
      const restored = await this.checkpoints.restoreFromCheckpoint(checkpoint.id);

      if (restored) {
        this.store.appendAudit(session.id, "recovery_succeeded", "system", {
          checkpointId: checkpoint.id,
          checkpointReason: checkpoint.reason,
        });

        console.log(
          `[recovery] Successfully restored ${session.projectId} from checkpoint ${checkpoint.id}`,
        );
        return restored;
      }
    } else {
      // No checkpoint — try to resume from TASK.md state
      console.log(
        `[recovery] No checkpoint found for ${session.projectId}, attempting TASK.md recovery`,
      );

      const projectDir = this.store.getProjectDir(session.projectId);
      const taskDoc = readTaskFile(projectDir);

      if (taskDoc) {
        // Resume with progress from TASK.md
        const updated = this.store.updateSession(session.id, {
          status: "running",
          heartbeatAt: Date.now(),
          progress: {
            ...session.progress,
            percent: taskDoc.percent,
            currentStep: taskDoc.currentStep,
            totalSteps: taskDoc.totalSteps,
          },
        });

        if (updated) {
          this.store.appendAudit(session.id, "recovery_succeeded", "system", {
            source: "TASK.md",
          });

          console.log(`[recovery] Successfully restored ${session.projectId} from TASK.md`);
          return updated;
        }
      }
    }

    // Recovery failed
    console.error(`[recovery] Failed to recover ${session.projectId}`);
    return null;
  }

  /**
   * Manually trigger recovery for a specific session.
   */
  async manualRecover(sessionId: string): Promise<ProjectSession | null> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      console.error(`[recovery] Session ${sessionId} not found`);
      return null;
    }

    // Reset recovery attempts for manual recovery
    this.store.updateSession(sessionId, { recoveryAttempts: 0 });

    return this.attemptRecovery(session);
  }

  /**
   * Mark a session as intentionally paused (no recovery needed).
   */
  pauseSession(sessionId: string): ProjectSession | null {
    const session = this.store.getSession(sessionId);
    if (!session) return null;

    const updated = this.store.updateSession(sessionId, {
      status: "paused",
      pausedAt: Date.now(),
    });

    if (updated) {
      this.store.appendAudit(sessionId, "session_paused", session.agentId);
    }

    return updated;
  }

  /**
   * Resume a paused session.
   */
  resumeSession(sessionId: string): ProjectSession | null {
    const session = this.store.getSession(sessionId);
    if (!session) return null;

    const updated = this.store.updateSession(sessionId, {
      status: "running",
      pausedAt: undefined,
      heartbeatAt: Date.now(),
    });

    if (updated) {
      this.store.appendAudit(sessionId, "session_resumed", session.agentId);
    }

    return updated;
  }

  /**
   * Cancel a session (no further recovery attempts).
   */
  cancelSession(sessionId: string): ProjectSession | null {
    const session = this.store.getSession(sessionId);
    if (!session) return null;

    const updated = this.store.updateSession(sessionId, {
      status: "cancelled",
      completedAt: Date.now(),
    });

    if (updated) {
      this.store.appendAudit(sessionId, "session_cancelled", session.agentId);
    }

    return updated;
  }

  /**
   * Complete a session successfully.
   */
  completeSession(sessionId: string): ProjectSession | null {
    const session = this.store.getSession(sessionId);
    if (!session) return null;

    // Update progress to 100%
    const updatedProgress = {
      ...session.progress,
      percent: 100,
      currentStep: session.progress.totalSteps,
    };

    const updated = this.store.updateSession(sessionId, {
      status: "completed",
      completedAt: Date.now(),
      progress: updatedProgress,
    });

    if (updated) {
      this.store.appendAudit(sessionId, "session_completed", session.agentId);

      // Update TASK.md
      const projectDir = this.store.getProjectDir(session.projectId);
      const taskDoc = sessionToTaskDocument(updated);
      writeTaskFile(projectDir, taskDoc);
    }

    return updated;
  }
}

// ═══════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════

export interface RecoveryReport {
  scannedAt: number;
  staleSessions: string[];
  recovered: Array<{
    sessionId: string;
    projectId: string;
    checkpointId: string;
  }>;
  failed: Array<{
    sessionId: string;
    projectId: string;
    reason: string;
  }>;
  abandoned: Array<{
    sessionId: string;
    projectId: string;
    reason: string;
  }>;
}

// ═══════════════════════════════════════════════════════════════════
// SINGLETON
// ═══════════════════════════════════════════════════════════════════

let _recoveryManager: RecoveryManager | null = null;

export function getRecoveryManager(stateDir?: string): RecoveryManager {
  if (!_recoveryManager) {
    _recoveryManager = new RecoveryManager(stateDir);
  }
  return _recoveryManager;
}

// ═══════════════════════════════════════════════════════════════════
// STARTUP RECOVERY
// ═══════════════════════════════════════════════════════════════════

/**
 * Run recovery scan on gateway startup.
 * Call this from gateway init.
 */
export async function runStartupRecovery(stateDir?: string): Promise<RecoveryReport> {
  console.log("[recovery] Running startup recovery scan...");

  const manager = getRecoveryManager(stateDir);
  const report = await manager.detectAndRecoverStaleSessions();

  if (report.staleSessions.length > 0) {
    console.log(`[recovery] Found ${report.staleSessions.length} stale sessions`);
    console.log(
      `[recovery] Recovered: ${report.recovered.length}, Failed: ${report.failed.length}, Abandoned: ${report.abandoned.length}`,
    );
  } else {
    console.log("[recovery] No stale sessions found");
  }

  return report;
}

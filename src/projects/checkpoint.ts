/**
 * Deep Memory Architecture — Checkpoint System
 *
 * Point-in-time state snapshots for crash recovery.
 * Automatically saves state after tool calls and milestones.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getProjectStore, type ProjectStore } from "./store.js";
import { writeTaskFile, sessionToTaskDocument } from "./task-parser.js";
import type { ProjectSession, Checkpoint, CheckpointReason, ContextSnapshot } from "./types.js";

// ═══════════════════════════════════════════════════════════════════
// CHECKPOINT MANAGER
// ═══════════════════════════════════════════════════════════════════

export class CheckpointManager {
  private store: ProjectStore;

  constructor(stateDir?: string) {
    this.store = getProjectStore(stateDir);
  }

  /**
   * Create a checkpoint for a project session.
   * Saves progress, context, and working state to both DB and disk.
   */
  async createCheckpoint(
    session: ProjectSession,
    opts: {
      reason: CheckpointReason;
      notes?: string;
      contextSnapshot?: ContextSnapshot;
      workingState?: Record<string, unknown>;
    },
  ): Promise<Checkpoint> {
    const projectDir = this.store.ensureProjectDir(session.projectId);
    const checkpointsDir = join(projectDir, "checkpoints");

    if (!existsSync(checkpointsDir)) {
      mkdirSync(checkpointsDir, { recursive: true });
    }

    // Generate checkpoint filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `cp-${timestamp}-${opts.reason}.json`;
    const filePath = join(checkpointsDir, fileName);

    // Create checkpoint in DB
    const checkpoint = this.store.createCheckpoint({
      projectSessionId: session.id,
      progress: session.progress,
      contextSnapshot: opts.contextSnapshot,
      workingState: opts.workingState,
      reason: opts.reason,
      notes: opts.notes,
      filePath,
    });

    // Write full checkpoint to disk
    const fullCheckpoint = {
      ...checkpoint,
      session: {
        id: session.id,
        projectId: session.projectId,
        name: session.name,
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        status: session.status,
      },
    };

    writeFileSync(filePath, JSON.stringify(fullCheckpoint, null, 2), "utf-8");

    // Also update TASK.md with latest progress
    const taskDoc = sessionToTaskDocument(session);
    taskDoc.lastCheckpoint = new Date().toISOString();
    writeTaskFile(projectDir, taskDoc);

    console.log(
      `[checkpoint] Created checkpoint ${checkpoint.id} for ${session.projectId} (${opts.reason})`,
    );

    return checkpoint;
  }

  /**
   * Restore a session from a checkpoint.
   * Returns the session with progress restored.
   */
  async restoreFromCheckpoint(checkpointId: string): Promise<ProjectSession | null> {
    const checkpoint = this.store.getCheckpoint(checkpointId);
    if (!checkpoint) {
      console.error(`[checkpoint] Checkpoint ${checkpointId} not found`);
      return null;
    }

    const session = this.store.getSession(checkpoint.projectSessionId);
    if (!session) {
      console.error(`[checkpoint] Session ${checkpoint.projectSessionId} not found`);
      return null;
    }

    // Restore progress from checkpoint
    const updated = this.store.updateSession(session.id, {
      progress: checkpoint.progress,
      status: "running",
      recoveryAttempts: session.recoveryAttempts + 1,
      heartbeatAt: Date.now(),
    });

    if (updated) {
      this.store.appendAudit(session.id, "checkpoint_restored", session.agentId, {
        checkpointId,
        reason: checkpoint.reason,
      });

      console.log(
        `[checkpoint] Restored session ${session.projectId} from checkpoint ${checkpointId}`,
      );
    }

    return updated;
  }

  /**
   * Get the latest checkpoint for a session.
   */
  getLatestCheckpoint(sessionId: string): Checkpoint | null {
    return this.store.getLatestCheckpoint(sessionId);
  }

  /**
   * Load full checkpoint data from disk.
   */
  loadCheckpointFile(checkpoint: Checkpoint): Record<string, unknown> | null {
    if (!checkpoint.filePath || !existsSync(checkpoint.filePath)) {
      return null;
    }

    try {
      const content = readFileSync(checkpoint.filePath, "utf-8");
      return JSON.parse(content);
    } catch (error) {
      console.error(`[checkpoint] Failed to load checkpoint file ${checkpoint.filePath}:`, error);
      return null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUTO-CHECKPOINT HOOKS
// ═══════════════════════════════════════════════════════════════════

let _checkpointManager: CheckpointManager | null = null;

export function getCheckpointManager(stateDir?: string): CheckpointManager {
  if (!_checkpointManager) {
    _checkpointManager = new CheckpointManager(stateDir);
  }
  return _checkpointManager;
}

/**
 * Hook to call after each tool execution for auto-checkpointing.
 * Only checkpoints if significant work has been done.
 */
export async function maybeAutoCheckpoint(
  session: ProjectSession,
  toolName: string,
  stateDir?: string,
): Promise<Checkpoint | null> {
  // Tools that warrant a checkpoint
  const checkpointTriggers = [
    "write",
    "edit",
    "exec",
    "browser:navigate",
    "kanban:update_task",
    "kanban:create_task",
    "sessions_spawn",
  ];

  if (!checkpointTriggers.some((t) => toolName.includes(t))) {
    return null;
  }

  const manager = getCheckpointManager(stateDir);

  // Don't checkpoint too frequently
  const lastCheckpoint = manager.getLatestCheckpoint(session.id);
  if (lastCheckpoint) {
    const elapsed = Date.now() - lastCheckpoint.createdAt;
    if (elapsed < 60000) {
      // Less than 1 minute since last checkpoint
      return null;
    }
  }

  return manager.createCheckpoint(session, {
    reason: "auto",
    notes: `Auto-checkpoint after ${toolName}`,
  });
}

/**
 * Create a milestone checkpoint (e.g., subtask completed).
 */
export async function createMilestoneCheckpoint(
  session: ProjectSession,
  milestone: string,
  stateDir?: string,
): Promise<Checkpoint> {
  const manager = getCheckpointManager(stateDir);

  return manager.createCheckpoint(session, {
    reason: "milestone",
    notes: milestone,
  });
}

// ═══════════════════════════════════════════════════════════════════
// CONTEXT SNAPSHOT HELPERS
// ═══════════════════════════════════════════════════════════════════

export function buildContextSnapshot(
  sessionKey: string,
  transcriptPath: string,
  tokenCount: number,
): ContextSnapshot {
  return {
    sessionKey,
    transcriptPath,
    messageCount: 0, // Would need to count from transcript
    tokenCount,
    lastMessageAt: Date.now(),
  };
}

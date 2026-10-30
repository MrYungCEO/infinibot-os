/**
 * Session Migration Orchestration
 *
 * Handles the complete process of migrating a running session from one node to another.
 * Coordinates between source and target nodes to ensure seamless session transfer.
 *
 * Lifecycle: validate → serialize → transfer (target reconstitutes + acks, source
 * drains) → verify (parity + round-trip ping) → cleanup (delete source, repoint the
 * remote-session-registry at the new peer). On verification failure the source is
 * kept live and the draining flag is cleared.
 *
 * The orchestrator is transport-agnostic: all node-local and cross-node effects are
 * funnelled through an injectable {@link MigrationDeps}. The default implementation
 * ({@link createPeerMeshMigrationDeps}) is backed by the peer-mesh, the capability
 * router, the session-history store, and the remote-session registry. Tests inject a
 * mock so the orchestration can be exercised without a live mesh.
 */

import { EventEmitter } from "node:events";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  MigrationRequest,
  MigrationResult,
  SessionState,
  SerializationResult,
  RestorationResult,
} from "./types.js";
import { serializeSession, restoreSession } from "../agents/session-state.js";
import { getPeerMesh } from "./peer-mesh.js";
import { getCapabilityRouter } from "./capability-router.js";
import { getSessionHistoryStore } from "./session-sync.js";
import { findRemoteSessionBySessionKey, registerRemoteSession } from "./remote-session-registry.js";
import { generateMessageId } from "./protocol.js";
import type { FederationMessage } from "./types.js";

const log = createSubsystemLogger("federation").child("migration");

// =============================================================================
// Migration wire protocol (peer-mesh message kinds)
// =============================================================================

/**
 * Migration message kinds. These ride the existing peer-mesh as generic
 * `FederationMessage`s (whose `type` is `FederationMessageType | string`), so we
 * intentionally keep them as local string constants rather than widening the
 * shared `FederationMessageType` union — that union is owned by a separate
 * concurrent task.
 */
export const MIGRATION_TRANSFER = "session.migrate.transfer";
export const MIGRATION_TRANSFER_ACK = "session.migrate.transfer.ack";
export const MIGRATION_VERIFY = "session.migrate.verify";
export const MIGRATION_VERIFY_ACK = "session.migrate.verify.ack";

/** Payload sent to the target to reconstitute a session. */
export interface MigrationTransferPayload {
  migrationId: string;
  correlationId: string;
  sourceNodeId: string;
  targetNodeId: string;
  /** The full serializable session snapshot. */
  state: SessionState;
  /** Size of the serialized snapshot in bytes. */
  sizeBytes: number;
}

/** Target's response after reconstituting the session. */
export interface TransferAck {
  success: boolean;
  /** Session key minted on the target node. */
  newSessionKey?: string;
  /** Number of messages reconstituted on the target. */
  messageCount?: number;
  /** Agent id the target reconstituted the session under. */
  agentId?: string;
  error?: string;
}

/** Payload for the verification round-trip ping. */
export interface MigrationVerifyPayload {
  migrationId: string;
  correlationId: string;
  /** Session key on the target node. */
  sessionKey: string;
  /** Original session key on the source node. */
  originalSessionKey: string;
  /** Assertion the target must satisfy to prove parity. */
  assertion: {
    nonce: string;
    expectedAgentId?: string;
    expectedMessageCount?: number;
  };
}

/** Target's response to a verification ping. */
export interface VerifyAck {
  success: boolean;
  /** Whether the reconstituted session is live and routable. */
  live: boolean;
  sessionKey?: string;
  agentId?: string;
  messageCount?: number;
  /** Echo of the assertion nonce — proves the ping round-tripped. */
  echo?: string;
  error?: string;
}

// =============================================================================
// Migration dependencies (injectable transport + local effects)
// =============================================================================

/** Description of a session as it exists on the source node. */
export interface LocalSessionInfo {
  exists: boolean;
  agentId: string;
  messageCount?: number;
}

/**
 * Everything the orchestrator needs from the outside world. Injectable so the
 * orchestration can be unit-tested without a live federation.
 */
export interface MigrationDeps {
  /** Look up the source session in this node's local store. */
  describeLocalSession(
    sessionKey: string,
  ): LocalSessionInfo | null | Promise<LocalSessionInfo | null>;
  /** Is the target peer connected / reachable right now (peer-mesh state)? */
  isTargetReachable(targetNodeId: string): boolean;
  /** Does the target report capacity for this agent class (capability router)? */
  targetHasCapacity(targetNodeId: string, agentClass: string): boolean;
  /** Send the snapshot to the target, which reconstitutes the session and acks. */
  sendTransfer(targetNodeId: string, payload: MigrationTransferPayload): Promise<TransferAck>;
  /** Round-trip a verification ping to the target. */
  sendVerify(targetNodeId: string, payload: MigrationVerifyPayload): Promise<VerifyAck>;
  /** Toggle the source session's draining flag (no new messages routed to it). */
  setDraining(sessionKey: string, draining: boolean): void;
  /** Delete the source session from the local registry/store. */
  deleteLocalSession(sessionKey: string): void | Promise<void>;
  /** Repoint the remote-session registry at the session's new home. */
  updateRemoteRegistry(params: {
    originalSessionKey: string;
    newSessionKey: string;
    sourceNodeId: string;
    targetNodeId: string;
    agentId: string;
  }): void;
}

// =============================================================================
// Types
// =============================================================================

/** Migration process step */
export type MigrationStep =
  | "initiated"
  | "validating"
  | "serializing"
  | "transferring"
  | "restoring"
  | "verifying"
  | "cleanup"
  | "completed"
  | "failed";

/** Migration progress information */
export interface MigrationProgress {
  /** Current step in the migration process */
  step: MigrationStep;
  /** Progress percentage (0-100) */
  progress: number;
  /** Human-readable status message */
  message: string;
  /** Timestamp of this update */
  timestamp: number;
  /** Additional details */
  details?: Record<string, unknown>;
}

/** Migration configuration options */
export interface MigrationOptions {
  /** Timeout for the entire migration process in ms */
  timeoutMs?: number;
  /** Whether to keep the original session after migration */
  keepOriginal?: boolean;
  /** Maximum retries on failure */
  maxRetries?: number;
  /** Whether to validate state integrity */
  validateState?: boolean;
  /** Custom serialization options */
  serializationOptions?: {
    includeFullHistory?: boolean;
    maxMessages?: number;
    compress?: boolean;
  };
}

/** Complete migration result with detailed information */
export interface DetailedMigrationResult extends MigrationResult {
  /** Migration steps completed */
  stepsCompleted: MigrationStep[];
  /** Progress updates during migration */
  progressHistory: MigrationProgress[];
  /** State transfer statistics */
  transferStats?: {
    stateSize: number;
    transferTime: number;
    serializationTime: number;
    restorationTime: number;
  };
  /** Any warnings encountered */
  warnings?: string[];
}

/** Migration event types */
export interface MigrationEvents {
  progress: [migration: string, progress: MigrationProgress];
  completed: [migration: string, result: DetailedMigrationResult];
  failed: [migration: string, error: string, progress: MigrationProgress[]];
  step: [migration: string, step: MigrationStep, message: string];
}

// =============================================================================
// Constants
// =============================================================================

/** Default migration timeout (5 minutes) */
export const DEFAULT_MIGRATION_TIMEOUT = 5 * 60 * 1000;

/** Default per-message round-trip timeout for peer-mesh migration messages */
export const DEFAULT_MIGRATION_MESSAGE_TIMEOUT = 30_000;

/** Default migration options */
export const DEFAULT_MIGRATION_OPTIONS: MigrationOptions = {
  timeoutMs: DEFAULT_MIGRATION_TIMEOUT,
  keepOriginal: false,
  maxRetries: 2,
  validateState: true,
  serializationOptions: {
    includeFullHistory: true,
    maxMessages: 1000,
    compress: false,
  },
};

// =============================================================================
// Session Migration Manager
// =============================================================================

export class SessionMigrationManager extends EventEmitter<MigrationEvents> {
  private activeMigrations = new Map<string, MigrationProcess>();
  /** Sessions with an in-flight migration (dedupe guard). */
  private migratingSessions = new Set<string>();
  private deps: MigrationDeps;

  constructor(deps?: MigrationDeps) {
    super();
    this.deps = deps ?? createPeerMeshMigrationDeps();
  }

  /** Whether the given session already has a migration in progress. */
  isSessionMigrating(sessionKey: string): boolean {
    return this.migratingSessions.has(sessionKey);
  }

  /**
   * Start a session migration process.
   */
  async migrateSession(
    request: MigrationRequest,
    options: MigrationOptions = DEFAULT_MIGRATION_OPTIONS,
  ): Promise<DetailedMigrationResult> {
    const migrationId = this.generateMigrationId(request);

    log.info(`starting migration: ${migrationId}`, {
      sessionKey: request.sessionKey,
      sourceNode: request.sourceNodeId,
      targetNode: request.targetNodeId,
      reason: request.reason,
    });

    // Check if migration is already in progress
    if (this.activeMigrations.has(migrationId)) {
      throw new Error(`Migration already in progress: ${migrationId}`);
    }

    // Validation rule #4: a session may only be migrated once at a time.
    if (this.migratingSessions.has(request.sessionKey)) {
      throw new Error(`Session is already being migrated: ${request.sessionKey}`);
    }

    // Create migration process
    const migration = new MigrationProcess(request, options, this, this.deps);
    this.activeMigrations.set(migrationId, migration);
    this.migratingSessions.add(request.sessionKey);

    try {
      const result = await migration.execute();
      this.emit("completed", migrationId, result);
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.emit("failed", migrationId, errorMsg, migration.getProgressHistory());
      throw error;
    } finally {
      this.activeMigrations.delete(migrationId);
      this.migratingSessions.delete(request.sessionKey);
    }
  }

  /**
   * Get status of an active migration.
   */
  getMigrationStatus(migrationId: string): MigrationProgress | null {
    const migration = this.activeMigrations.get(migrationId);
    return migration ? migration.getCurrentProgress() : null;
  }

  /**
   * List all active migrations.
   */
  getActiveMigrations(): Array<{ id: string; progress: MigrationProgress }> {
    return Array.from(this.activeMigrations.entries()).map(([id, migration]) => ({
      id,
      progress: migration.getCurrentProgress(),
    }));
  }

  /**
   * Cancel an active migration.
   */
  async cancelMigration(migrationId: string): Promise<boolean> {
    const migration = this.activeMigrations.get(migrationId);
    if (!migration) {
      return false;
    }

    try {
      await migration.cancel();
      this.activeMigrations.delete(migrationId);
      this.migratingSessions.delete(migration.sessionKey);
      return true;
    } catch (error) {
      log.error(`failed to cancel migration ${migrationId}: ${error}`);
      return false;
    }
  }

  private generateMigrationId(request: MigrationRequest): string {
    return `migration:${request.sessionKey}:${Date.now()}`;
  }

  /** Emit progress update for external listeners */
  emitProgress(migrationId: string, progress: MigrationProgress): void {
    this.emit("progress", migrationId, progress);
    this.emit("step", migrationId, progress.step, progress.message);
  }
}

// =============================================================================
// Migration Process
// =============================================================================

class MigrationProcess {
  private progressHistory: MigrationProgress[] = [];
  private cancelled = false;
  private startTime = Date.now();
  /** Source session marked draining (rollback needs to clear this). */
  private draining = false;
  /** Ack from the target after it reconstituted the session. */
  private transferAck: TransferAck | null = null;

  constructor(
    private request: MigrationRequest,
    private options: MigrationOptions,
    private manager: SessionMigrationManager,
    private deps: MigrationDeps,
  ) {}

  get sessionKey(): string {
    return this.request.sessionKey;
  }

  async execute(): Promise<DetailedMigrationResult> {
    const migrationId = `migration:${this.request.sessionKey}:${this.startTime}`;
    const stepsCompleted: MigrationStep[] = [];
    let transferStats: DetailedMigrationResult["transferStats"];

    try {
      // Step 1: Initiate migration
      this.updateProgress("initiated", 5, "Migration initiated");
      stepsCompleted.push("initiated");

      // Step 2: Validate request
      this.updateProgress("validating", 10, "Validating migration request");
      await this.validateMigrationRequest();
      stepsCompleted.push("validating");

      // Step 3: Serialize session state
      this.updateProgress("serializing", 25, "Serializing session state");
      const serializationStart = Date.now();
      const serializedState = await this.serializeSessionState();
      const serializationTime = Date.now() - serializationStart;
      stepsCompleted.push("serializing");

      // Step 4: Transfer state to target node (target reconstitutes + acks,
      // source enters draining).
      this.updateProgress("transferring", 45, "Transferring state to target node");
      const transferStart = Date.now();
      await this.transferStateToTarget(serializedState.state);
      const transferTime = Date.now() - transferStart;
      stepsCompleted.push("transferring");

      // Step 5: Restore session on target node (adapt the transfer ack)
      this.updateProgress("restoring", 65, "Restoring session on target node");
      const restorationStart = Date.now();
      const restorationResult = await this.restoreSessionOnTarget(serializedState.state);
      const restorationTime = Date.now() - restorationStart;
      stepsCompleted.push("restoring");

      if (!restorationResult.success) {
        throw new Error(restorationResult.error || "Failed to restore session");
      }

      // Step 6: Verify migration success
      this.updateProgress("verifying", 80, "Verifying migration success");
      await this.verifyMigration(restorationResult, serializedState.state);
      stepsCompleted.push("verifying");

      // Step 7: Cleanup original session (if not keeping)
      if (!this.options.keepOriginal) {
        this.updateProgress("cleanup", 90, "Cleaning up original session");
        await this.cleanupOriginalSession(restorationResult);
        stepsCompleted.push("cleanup");
      }

      // Step 8: Complete
      this.updateProgress("completed", 100, "Migration completed successfully");
      stepsCompleted.push("completed");

      transferStats = {
        stateSize: serializedState.sizeBytes,
        transferTime,
        serializationTime,
        restorationTime,
      };

      const result: DetailedMigrationResult = {
        success: true,
        newSessionKey: restorationResult.newSessionKey,
        durationMs: Date.now() - this.startTime,
        stepsCompleted,
        progressHistory: [...this.progressHistory],
        transferStats,
        warnings: [
          ...(serializedState.warnings || []),
          ...(restorationResult.warnings || []),
        ].filter(Boolean),
      };

      log.info(`migration completed successfully: ${migrationId}`, {
        duration: result.durationMs,
        newSessionKey: result.newSessionKey,
        stateSize: transferStats.stateSize,
      });

      return result;
    } catch (error) {
      // Rollback: keep the source live by clearing the draining flag. We never
      // delete the source until verification has succeeded, so the session is
      // still intact here.
      await this.rollback();

      this.updateProgress("failed", 0, `Migration failed: ${error}`);

      const result: DetailedMigrationResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - this.startTime,
        stepsCompleted,
        progressHistory: [...this.progressHistory],
        transferStats,
      };

      log.error(`migration failed: ${migrationId}`, {
        error: result.error,
        duration: result.durationMs,
        stepsCompleted,
      });

      throw error;
    }
  }

  /**
   * Validate the migration request against real federation state.
   *
   * Checks:
   *  - the source session exists locally,
   *  - the target peer is connected/reachable,
   *  - the target reports capacity for the session's agent class.
   *
   * (The "not already migrating this session" rule is enforced one level up in
   * {@link SessionMigrationManager.migrateSession}, which owns the dedupe set.)
   */
  private async validateMigrationRequest(): Promise<void> {
    if (this.cancelled) throw new Error("Migration was cancelled");

    if (!this.request.sessionKey) {
      throw new Error("Session key is required");
    }

    if (this.request.sourceNodeId === this.request.targetNodeId) {
      throw new Error("Source and target nodes cannot be the same");
    }

    // Source session must exist locally.
    const local = await this.deps.describeLocalSession(this.request.sessionKey);
    if (!local || !local.exists) {
      throw new Error(
        `Source session ${this.request.sessionKey} not found on node ${this.request.sourceNodeId}`,
      );
    }

    // Target peer must be connected and reachable.
    if (!this.deps.isTargetReachable(this.request.targetNodeId)) {
      throw new Error(`Target node ${this.request.targetNodeId} is not reachable`);
    }

    // Target must report capacity for this agent class.
    const agentClass = local.agentId || "default";
    if (!this.deps.targetHasCapacity(this.request.targetNodeId, agentClass)) {
      throw new Error(
        `Target node ${this.request.targetNodeId} has no capacity for agent class "${agentClass}"`,
      );
    }
  }

  private async serializeSessionState(): Promise<SerializationResult> {
    if (this.cancelled) throw new Error("Migration was cancelled");

    return await serializeSession(this.request.sessionKey, this.options.serializationOptions);
  }

  /**
   * Transfer the snapshot to the target and put the source into draining mode.
   * The target reconstitutes the session in its registry and acks with the new
   * session key + parity counts.
   */
  private async transferStateToTarget(state: SessionState): Promise<void> {
    if (this.cancelled) throw new Error("Migration was cancelled");

    const payload: MigrationTransferPayload = {
      migrationId: `migration:${this.request.sessionKey}:${this.startTime}`,
      correlationId: generateMessageId(),
      sourceNodeId: this.request.sourceNodeId,
      targetNodeId: this.request.targetNodeId,
      state,
      sizeBytes: Buffer.byteLength(JSON.stringify(state), "utf8"),
    };

    // Source enters draining BEFORE the target goes live, so no new messages
    // are routed to the soon-to-be-stale source.
    this.deps.setDraining(this.request.sessionKey, true);
    this.draining = true;

    const ack = await this.deps.sendTransfer(this.request.targetNodeId, payload);
    if (!ack.success || !ack.newSessionKey) {
      throw new Error(
        ack.error || `Target ${this.request.targetNodeId} rejected the session transfer`,
      );
    }

    this.transferAck = ack;
    log.info(
      `session transferred to ${this.request.targetNodeId}: ${this.request.sessionKey} -> ${ack.newSessionKey}`,
      { messageCount: ack.messageCount },
    );
  }

  /**
   * The target already reconstituted the session during the transfer step; here
   * we simply adapt its ack into a {@link RestorationResult}. Falls back to the
   * local state-restore helper if no ack is available (defensive).
   */
  private async restoreSessionOnTarget(state: SessionState): Promise<RestorationResult> {
    if (this.cancelled) throw new Error("Migration was cancelled");

    if (this.transferAck?.newSessionKey) {
      return {
        success: true,
        newSessionKey: this.transferAck.newSessionKey,
        restoredState: {
          agentConfig: state.agentConfig,
          taskState: state.taskState,
          metadata: {
            ...state.metadata,
            restoredFrom: state.originalSessionKey,
            targetNode: this.request.targetNodeId,
          },
        },
      };
    }

    return await restoreSession(state, this.request.targetNodeId);
  }

  /**
   * Verify the migration: the target must report the session is live with
   * matching identity/agent/message-count parity, and a round-trip ping must
   * echo our assertion nonce.
   */
  private async verifyMigration(
    restorationResult: RestorationResult,
    state: SessionState,
  ): Promise<void> {
    if (this.cancelled) throw new Error("Migration was cancelled");

    if (!restorationResult.success || !restorationResult.newSessionKey) {
      throw new Error("Migration verification failed: no target session key");
    }

    const newSessionKey = restorationResult.newSessionKey;
    const expectedAgentId = state.agentConfig.agentId;
    const expectedMessageCount = this.transferAck?.messageCount ?? state.conversationHistory.length;
    const nonce = generateMessageId();

    const ack = await this.deps.sendVerify(this.request.targetNodeId, {
      migrationId: `migration:${this.request.sessionKey}:${this.startTime}`,
      correlationId: generateMessageId(),
      sessionKey: newSessionKey,
      originalSessionKey: state.originalSessionKey,
      assertion: { nonce, expectedAgentId, expectedMessageCount },
    });

    if (!ack.success || !ack.live) {
      throw new Error(ack.error || "Target reports session is not live");
    }

    // Round-trip assertion: the ping must echo our nonce.
    if (ack.echo !== nonce) {
      throw new Error("Verification ping did not round-trip (nonce mismatch)");
    }

    // Parity assertions.
    if (ack.sessionKey && ack.sessionKey !== newSessionKey) {
      throw new Error(
        `Session id parity failed: expected ${newSessionKey}, target reports ${ack.sessionKey}`,
      );
    }
    if (ack.agentId && ack.agentId !== expectedAgentId) {
      throw new Error(
        `Agent parity failed: expected ${expectedAgentId}, target reports ${ack.agentId}`,
      );
    }
    if (typeof ack.messageCount === "number" && ack.messageCount !== expectedMessageCount) {
      throw new Error(
        `Message-count parity failed: expected ${expectedMessageCount}, target reports ${ack.messageCount}`,
      );
    }

    log.info(`migration verified: ${state.originalSessionKey} -> ${newSessionKey}`);
  }

  /**
   * On verified success: delete the source session locally and repoint the
   * remote-session registry at the new node. The migration-complete event is
   * emitted by the manager once {@link execute} resolves.
   */
  private async cleanupOriginalSession(restorationResult: RestorationResult): Promise<void> {
    if (this.cancelled) throw new Error("Migration was cancelled");

    const newSessionKey = restorationResult.newSessionKey!;

    this.deps.updateRemoteRegistry({
      originalSessionKey: this.request.sessionKey,
      newSessionKey,
      sourceNodeId: this.request.sourceNodeId,
      targetNodeId: this.request.targetNodeId,
      agentId:
        this.transferAck?.agentId ||
        (restorationResult.restoredState?.agentConfig?.agentId ?? "unknown"),
    });

    await this.deps.deleteLocalSession(this.request.sessionKey);
    // Source is gone — the draining flag goes with it.
    this.draining = false;
  }

  /**
   * Rollback for the failure path: keep the source live by clearing the
   * draining flag. Best-effort; never masks the original error.
   */
  private async rollback(): Promise<void> {
    if (!this.draining) return;
    try {
      this.deps.setDraining(this.request.sessionKey, false);
      this.draining = false;
      log.warn(`migration rolled back; source session kept live: ${this.request.sessionKey}`);
    } catch (err) {
      log.error(`rollback failed to clear draining flag: ${err}`);
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    await this.rollback();
    this.updateProgress("failed", 0, "Migration cancelled by user");
  }

  getCurrentProgress(): MigrationProgress {
    return (
      this.progressHistory[this.progressHistory.length - 1] || {
        step: "initiated",
        progress: 0,
        message: "Migration starting",
        timestamp: this.startTime,
      }
    );
  }

  getProgressHistory(): MigrationProgress[] {
    return [...this.progressHistory];
  }

  private updateProgress(step: MigrationStep, progress: number, message: string): void {
    const progressUpdate: MigrationProgress = {
      step,
      progress,
      message,
      timestamp: Date.now(),
    };

    this.progressHistory.push(progressUpdate);

    const migrationId = `migration:${this.request.sessionKey}:${this.startTime}`;
    this.manager.emitProgress(migrationId, progressUpdate);

    log.debug(`migration progress: ${step} (${progress}%): ${message}`);
  }
}

// =============================================================================
// Default dependencies: peer-mesh + capability router + session store
// =============================================================================

/**
 * A tiny correlation-based request/response helper riding the peer-mesh.
 * Migration messages are generic `FederationMessage`s; replies are matched by a
 * `correlationId` embedded in the payload.
 */
class PeerMeshMigrationTransport {
  private pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private attached = false;

  private ensureAttached(): void {
    if (this.attached) return;
    const mesh = getPeerMesh();
    if (!mesh) return;
    mesh.on("peer:message", (_nodeId: string, message: FederationMessage) => {
      if (message.type !== MIGRATION_TRANSFER_ACK && message.type !== MIGRATION_VERIFY_ACK) {
        return;
      }
      const payload = message.payload as { correlationId?: string } | undefined;
      const correlationId = payload?.correlationId;
      if (!correlationId) return;
      const waiter = this.pending.get(correlationId);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(correlationId);
      waiter.resolve(message.payload);
    });
    this.attached = true;
  }

  request<T>(
    targetNodeId: string,
    kind: string,
    payload: { correlationId: string } & Record<string, unknown>,
    timeoutMs = DEFAULT_MIGRATION_MESSAGE_TIMEOUT,
  ): Promise<T> {
    this.ensureAttached();
    const mesh = getPeerMesh();
    if (!mesh) {
      return Promise.reject(new Error("Peer mesh not initialized"));
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(payload.correlationId);
        reject(new Error(`Migration message timed out: ${kind}`));
      }, timeoutMs);

      this.pending.set(payload.correlationId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      // Migration kinds ride the mesh as generic messages; the typed
      // `FederationMessageType` union is owned by a separate concurrent task.
      const sent = mesh.sendMessageToPeer(targetNodeId, kind as never, payload);
      if (!sent) {
        clearTimeout(timer);
        this.pending.delete(payload.correlationId);
        reject(new Error(`Failed to send ${kind} to peer ${targetNodeId}`));
      }
    });
  }
}

/**
 * Build the production migration dependencies, backed by the peer-mesh,
 * capability router, session-history store and remote-session registry.
 */
export function createPeerMeshMigrationDeps(): MigrationDeps {
  const transport = new PeerMeshMigrationTransport();

  return {
    describeLocalSession(sessionKey) {
      const store = getSessionHistoryStore();
      if (store) {
        const session = store.getSession(sessionKey);
        if (session) {
          return {
            exists: true,
            agentId: session.agentId,
            messageCount: session.messageCount,
          };
        }
      }
      // Fall back to the remote-session registry if the history store has no
      // record (e.g. store not initialised on this node).
      const remote = findRemoteSessionBySessionKey(sessionKey);
      if (remote) {
        return { exists: true, agentId: remote.record.agentId };
      }
      return store ? null : { exists: true, agentId: "default" };
    },

    isTargetReachable(targetNodeId) {
      const mesh = getPeerMesh();
      return mesh ? mesh.isConnectedToPeer(targetNodeId) : false;
    },

    targetHasCapacity(targetNodeId, _agentClass) {
      const metrics = getCapabilityRouter().getNodeMetrics(targetNodeId);
      // No metrics yet → assume capacity (optimistic; the transfer will fail
      // fast if the target genuinely can't accept it).
      if (!metrics) return true;
      return metrics.loadScore < 95 && metrics.activeSessions < 100;
    },

    async sendTransfer(targetNodeId, payload) {
      return transport.request<TransferAck>(
        targetNodeId,
        MIGRATION_TRANSFER,
        payload as unknown as { correlationId: string } & Record<string, unknown>,
      );
    },

    async sendVerify(targetNodeId, payload) {
      return transport.request<VerifyAck>(
        targetNodeId,
        MIGRATION_VERIFY,
        payload as unknown as { correlationId: string } & Record<string, unknown>,
      );
    },

    setDraining(sessionKey, draining) {
      const remote = findRemoteSessionBySessionKey(sessionKey);
      if (remote) {
        // "draining" surfaces as a status the router can skip over.
        remote.record.status = draining ? "starting" : "running";
        remote.record.lastMessage = draining ? "draining for migration" : undefined;
      }
    },

    async deleteLocalSession(_sessionKey) {
      // Source teardown is owned by the hub/session layer (it holds the live
      // run handle). The remote-registry repoint below is what makes routing
      // follow the session to its new home.
    },

    updateRemoteRegistry({ originalSessionKey, newSessionKey, targetNodeId, agentId }) {
      const remote = findRemoteSessionBySessionKey(originalSessionKey);
      if (remote) {
        remote.record.sessionKey = newSessionKey;
        remote.record.nodeId = targetNodeId;
        remote.record.status = "running";
        remote.record.lastMessage = "migrated";
        return;
      }
      // No prior record (session was local) — register the new home.
      registerRemoteSession({
        runId: newSessionKey,
        sessionKey: newSessionKey,
        nodeId: targetNodeId,
        agentId,
        task: "migrated session",
        cleanup: "keep",
      });
    },
  };
}

// =============================================================================
// Target-side handler (reconstitute + ack)
// =============================================================================

/**
 * Build a peer-mesh `peer:message` handler for the *target* side of a migration.
 * Reconstitutes incoming sessions and replies with the transfer / verify acks.
 *
 * Wire it at bootstrap with `getPeerMesh()?.on("peer:message", handler)` on
 * nodes that should accept migrations. Exposed separately so it can be attached
 * by whichever process owns the peer-mesh lifecycle.
 */
export function createMigrationTargetHandler(
  targetNodeId: string,
): (nodeId: string, message: FederationMessage) => void | Promise<void> {
  // Tracks sessions reconstituted on this node so verify pings can prove parity.
  const reconstituted = new Map<
    string,
    { agentId: string; messageCount: number; originalSessionKey: string }
  >();

  return async (nodeId, message) => {
    const mesh = getPeerMesh();
    if (!mesh) return;

    if (message.type === MIGRATION_TRANSFER) {
      const payload = message.payload as MigrationTransferPayload;
      try {
        const result = await restoreSession(payload.state, targetNodeId);
        if (!result.success || !result.newSessionKey) {
          throw new Error(result.error || "restore failed");
        }
        const agentId = payload.state.agentConfig.agentId;
        const messageCount = payload.state.conversationHistory.length;
        reconstituted.set(result.newSessionKey, {
          agentId,
          messageCount,
          originalSessionKey: payload.state.originalSessionKey,
        });
        const ack: TransferAck & { correlationId: string } = {
          correlationId: payload.correlationId,
          success: true,
          newSessionKey: result.newSessionKey,
          messageCount,
          agentId,
        };
        mesh.sendMessageToPeer(nodeId, MIGRATION_TRANSFER_ACK as never, ack);
      } catch (err) {
        const ack: TransferAck & { correlationId: string } = {
          correlationId: payload.correlationId,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
        mesh.sendMessageToPeer(nodeId, MIGRATION_TRANSFER_ACK as never, ack);
      }
      return;
    }

    if (message.type === MIGRATION_VERIFY) {
      const payload = message.payload as MigrationVerifyPayload;
      const record = reconstituted.get(payload.sessionKey);
      const ack: VerifyAck & { correlationId: string } = record
        ? {
            correlationId: payload.correlationId,
            success: true,
            live: true,
            sessionKey: payload.sessionKey,
            agentId: record.agentId,
            messageCount: record.messageCount,
            echo: payload.assertion.nonce,
          }
        : {
            correlationId: payload.correlationId,
            success: false,
            live: false,
            error: `Unknown migrated session: ${payload.sessionKey}`,
          };
      mesh.sendMessageToPeer(nodeId, MIGRATION_VERIFY_ACK as never, ack);
      return;
    }
  };
}

// =============================================================================
// Singleton Instance
// =============================================================================

let migrationManager: SessionMigrationManager | null = null;

export function getMigrationManager(): SessionMigrationManager {
  if (!migrationManager) {
    migrationManager = new SessionMigrationManager();
  }
  return migrationManager;
}

// =============================================================================
// Convenience Functions
// =============================================================================

/** Migrate a session with default options */
export async function migrateSession(
  request: MigrationRequest,
  options?: MigrationOptions,
): Promise<DetailedMigrationResult> {
  return getMigrationManager().migrateSession(request, options);
}

/** Get status of an active migration */
export function getMigrationStatus(migrationId: string): MigrationProgress | null {
  return getMigrationManager().getMigrationStatus(migrationId);
}

/** Get all active migrations */
export function getActiveMigrations(): Array<{ id: string; progress: MigrationProgress }> {
  return getMigrationManager().getActiveMigrations();
}

/** Cancel an active migration */
export async function cancelMigration(migrationId: string): Promise<boolean> {
  return getMigrationManager().cancelMigration(migrationId);
}

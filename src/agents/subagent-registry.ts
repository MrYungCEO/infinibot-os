import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { type DeliveryContext, normalizeDeliveryContext } from "../utils/delivery-context.js";
import { runSubagentAnnounceFlow, type SubagentRunOutcome } from "./subagent-announce.js";
import { archiveSubagentRun } from "./subagent-history.js";
import { broadcastSubagentLifecycle } from "./coder-runtime/subagent-broadcast.js";
import {
  loadSubagentRegistryFromDisk,
  saveSubagentRegistryToDisk,
} from "./subagent-registry.store.js";
import { resolveAgentTimeoutMs } from "./timeout.js";
import type { StreamParser } from "./coder-runtime/stream-parsers.js";
import { hasLiveSessionSync, tmuxSessionName } from "../terminal/tmux-backend.js";
import {
  durableRunDir,
  isDurableRunAlive,
  reattachDurableTmux,
} from "./coder-backend/durable-spawn.js";
import { findOrCreateProject, mcpCreateTask } from "./tools/kanban-tool.js";
import { verifyAndFinalizeKanban } from "./verification-gate.js";
import { appendSpawnEvent, readSpawnLedger, replayLedgerToRunRecords } from "./spawn-ledger.js";
import { initProgressTracking, completeProgress, recordActivity } from "./subagent-progress.js";
import {
  emitSubagentStarted,
  emitSubagentCompleted,
  emitSubagentFailed,
} from "../workload/emitter.js";
// === gamification: phase 1 === XP/quests on terminal sub-agent completion.
import { getGamificationEngine } from "../achievements/gamification.js";
import { getRecord as getCompletionRecord } from "../verification/store.js";
import type { PopupAction } from "../proactive/popup-types.js";

const log = createSubsystemLogger("subagent-registry");

export type SubagentRunRecord = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  archiveAtMs?: number;
  cleanupCompletedAt?: number;
  cleanupHandled?: boolean;
  kanbanTaskId?: string;
  /**
   * Absolute deadline (ms epoch) past which the sweeper auto-marks this
   * run as timed-out. Set at register time from
   * `resolveSubagentWaitTimeoutMs() + STUCK_GRACE_MS`. Persisted so a
   * gateway restart doesn't reset the deadline.
   */
  expectedEndByMs?: number;
  /**
   * OS PID of the spawned claude child process.
   * Stored so that on restart we can check whether the child is still alive
   * via `process.kill(pid, 0)` and attempt `claude --resume` if it's dead.
   */
  childPid?: number;
  /**
   * Claude Code's own internal session ID (from stream-json `session_id` field).
   * Used for `claude --resume <claudeSessionId>` after a gateway restart kills
   * an in-flight run. Populated from the first `system:init` NDJSON event.
   */
  claudeSessionId?: string;
  /**
   * Terminal id of the tmux-backed spawn terminal (`spawn-<runId8>-<ts>`) when
   * this run was launched via the terminal execution path (spawnAgentInTerminal).
   * This is the DURABLE recovery key: it is known at spawn time — before the CLI
   * emits any session id — so a run that died at 0 tokens is still recoverable as
   * long as its tmux session is alive. Recovery reattaches to this terminal
   * rather than re-spawning or `claude --resume`.
   */
  terminalId?: string;
  /**
   * tmux session name derived from {@link terminalId} via
   * `tmuxSessionName(terminalId)`. Persisted for observability / cross-referencing
   * against live tmux sessions; liveness is checked with
   * `hasLiveSessionSync(terminalId)`.
   */
  tmuxSession?: string;
  /**
   * Target agent id for a terminal-path spawn. Stored so the recovery reattach
   * can rebuild the spawn-terminal metadata (label/broadcast) after a restart.
   */
  agentId?: string;
  /**
   * Set when this run's CLI was launched INSIDE a detached tmux session by
   * `spawnCoderProcess` (coder-backend/durable-spawn.ts) rather than as a direct
   * child of the gateway. Durable runs are exempt from the shutdown SIGTERM
   * sweep and are recovered on boot by reattaching to their tmux session and
   * re-tailing their log files — they keep working straight through a restart.
   */
  durableSpawn?: "tmux-coder";
  /**
   * Durable tmux key of the CURRENT attempt. Verified completion resumes a
   * run that exited early under `<runId>-c<N>`; recovery must follow that
   * session, not the original. Absent ⇒ runId.
   */
  durableKey?: string;
  /**
   * Epoch ms when a gateway restart interrupted this run without it completing.
   * Set by `interruptAllSubagentRuns()` during graceful shutdown.
   *
   * NOTE: for a durable (tmux-backed) run this records that the *gateway*
   * restarted, NOT that the work stopped — the child kept running inside tmux.
   */
  interruptedAt?: number;
  /** Working directory the spawned claude process ran in. */
  workdir?: string;
  /** Files the subagent touched, populated from stream-json tool_use events. Capped at 200. */
  filesTouched?: Array<{
    path: string;
    action: "created" | "edited" | "deleted" | "read";
    at: number;
  }>;
  /** Parent goal id when this run was spawned by the goal orchestrator. */
  parentGoalId?: string;
  /** Goal-orchestrator iteration index that spawned this run. */
  parentGoalIterationIndex?: number;
  /** First 80 chars of the parent goal text, for UI lineage display. */
  parentGoalTitle?: string;
  /**
   * Coder backend that produced this run. "claude-code" | "opencode" |
   * "codex". Set at registerSubagentRunForCoder time so survivors of a
   * restart still know which CLI to label/resume with.
   */
  coderBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
  /**
   * Per-attempt launch outcomes, recorded when an automatic backend fallback
   * was in play (default backend failed to start → retried with the fallback).
   * Present only when more than one backend was attempted, so the UI/run record
   * can show the full "tried X, fell back to Y" trail.
   */
  coderBackendAttempts?: Array<{
    backend: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
    ok: boolean;
    error?: string;
    exitCode?: number | null;
  }>;
  /**
   * When this run launched on a fallback backend, the backend that failed to
   * start first. Lets the UI label "fell back from <X>".
   */
  fallbackFromBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
  /**
   * When this run was spawned by `subagents.respawn`, the runId of the
   * prior failed attempt it descends from. The UI shows a "Respawn of …"
   * badge so the chain of retries is visible.
   */
  respawnOfRunId?: string;
  /**
   * Cached Spec-vs-Result oversight analysis (drift report), computed lazily
   * when the modal's "Spec vs Result" tab is first opened. Cached here so
   * re-opens are instant and the expensive LLM pass runs at most once.
   * Typed loosely to avoid a UI ↔ registry import cycle; the canonical shape
   * is `SpecAnalysisResult` in `./spec-analysis.ts`.
   */
  specAnalysis?: Record<string, unknown>;
  /**
   * Absolute path to the JSONL transcript file written by the coder tool.
   * Set once the transcript context resolves at spawn time and persisted so
   * the transcript is findable after a gateway restart without needing the
   * session store lookup chain.
   */
  transcriptPath?: string;
  /**
   * Work-review pipeline output: canvas ID, verdict, and emit timestamp.
   * Populated by `updateSubagentRunWorkReview` after the review is built.
   * Drives the kanban card chip via subagents.list.
   */
  workReview?: {
    canvasId?: string;
    verdict?: string;
    emittedAt: number;
  };
};

const subagentRuns = new Map<string, SubagentRunRecord>();
let sweeper: NodeJS.Timeout | null = null;
let listenerStarted = false;
let listenerStop: (() => void) | null = null;
// Use var to avoid TDZ when init runs across circular imports during bootstrap.
var restoreAttempted = false;

/**
 * Lifecycle events that arrive *before* `registerSubagentRun` has set
 * the run record into `subagentRuns`. Keyed by runId; each entry is a
 * short FIFO (capped) with TTL. Drained in `registerSubagentRun` once
 * the record exists. Without this, a sub-agent that finishes in the
 * narrow window between `agent` RPC return and `subagentRuns.set` would
 * never get its completion announced — the listener `entry` lookup
 * would return undefined and the event would be discarded.
 */
type PendingLifecycle = {
  evt: Parameters<Parameters<typeof onAgentEvent>[0]>[0];
  queuedAt: number;
};
const pendingLifecycleEvents = new Map<string, PendingLifecycle[]>();
const PENDING_TTL_MS = 30_000;
const PENDING_MAX_PER_RUN = 16;

/**
 * Grace period added on top of the configured wait timeout before the
 * sweeper considers a run "stuck" and forces a timeout completion.
 * Larger than the wait window so a slow-but-still-running agent isn't
 * killed prematurely.
 */
const STUCK_GRACE_MS = 2 * 60_000; // 2 minutes
/** Hard ceiling for stuck detection when no wait timeout was supplied. */
const STUCK_DEFAULT_MS = 30 * 60_000; // 30 minutes
/**
 * How long a completed run stays in the registry before the sweeper
 * actually deletes it. Matches the progress-store visibility window so
 * both stores drop the entry at roughly the same time. This replaces the
 * previous "cleanup:delete → immediate delete" behaviour that caused cards
 * to vanish from the UI the moment the announce flow completed.
 */
const COMPLETED_ARCHIVE_DELAY_MS = 10 * 60_000; // 10 minutes

function persistSubagentRuns() {
  try {
    saveSubagentRegistryToDisk(subagentRuns);
  } catch (err) {
    log.warn("failed to persist subagent registry", {
      err: err instanceof Error ? err.message : String(err),
      size: subagentRuns.size,
    });
  }
}

const resumedRuns = new Set<string>();

/** Returns true if the given OS PID is still alive (signal 0 = existence check). */
/** Durable tmux key of the run's current attempt (continuations use `<runId>-cN`). */
function durableKeyOf(entry: SubagentRunRecord): string {
  return entry.durableKey ?? entry.runId;
}

/**
 * True while the verified-completion pipeline owns the run between attempts
 * (reviewing evidence or spawning a continuation). The CLI process is dead in
 * that window by design — the liveness / stuck sweeps must not reap it.
 */
function isUnderVerification(runId: string): boolean {
  const rec = getCompletionRecord(runId);
  return rec?.state === "reviewing" || rec?.state === "continuing";
}

/**
 * Record a verified-completion continuation (a resumed session after a
 * premature exit / unverified review) on the run so liveness, recovery and
 * the stuck sweep follow the new process.
 */
export function updateSubagentRunContinuation(
  runId: string,
  info: { childPid?: number; durableKey?: string; timeoutMinutes?: number },
): void {
  const entry = subagentRuns.get(runId);
  if (!entry) return;
  if (typeof info.childPid === "number" && info.childPid > 0) entry.childPid = info.childPid;
  if (info.durableKey) entry.durableKey = info.durableKey;
  if (info.timeoutMinutes) {
    entry.expectedEndByMs = Math.max(
      entry.expectedEndByMs ?? 0,
      Date.now() + info.timeoutMinutes * 60_000,
    );
  }
  persistSubagentRuns();
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH = no such process; EPERM = exists but owned by another user (still alive)
    return false;
  }
}

/**
 * Attempt to resume a claude-coder run whose child process died during a
 * gateway restart. Spawns `claude --resume <claudeSessionId>` with a short
 * restart preamble. Falls back to force-completing as "interrupted" when no
 * session ID is available or the resume spawn fails.
 *
 * TODO(detach): This is a recovery band-aid. The structural fix is to spawn
 * children with `detached: true` + `setsid` so they survive gateway restarts
 * without needing resume at all. Track that work separately — it requires
 * changes to `spawnClaudeCodeAgentBackground` in
 * src/agents/claude-code/launcher.ts and coordination with the coder backends.
 */
async function resumeInterruptedCoderRun(runId: string, entry: SubagentRunRecord): Promise<void> {
  if (!entry.claudeSessionId) {
    log.warn("resumeInterruptedCoderRun: no claudeSessionId, marking interrupted", {
      runId,
      childPid: entry.childPid,
    });
    entry.endedAt = Date.now();
    entry.outcome = {
      status: "error",
      error: `Interrupted by gateway restart (childPid=${entry.childPid}, no session ID available for resume)`,
    };
    persistSubagentRuns();
    triggerCleanupForEntry(entry);
    return;
  }

  // Resume on the SAME backend that produced the run, not the global default —
  // an interrupted OpenCode/Codex run must resume with `opencode --session` /
  // `codex resume`, never `claude --resume`. Falls back to the configured
  // default only for legacy records with no recorded backend.
  const resumeBackend = entry.coderBackend ?? "claude-code";
  const resumeCliCommand = resumeBackend === "claude-code" ? "claude" : resumeBackend;

  log.info("resumeInterruptedCoderRun: resuming interrupted coder run", {
    runId,
    backend: resumeBackend,
    claudeSessionId: entry.claudeSessionId,
    childPid: entry.childPid,
  });

  try {
    // Dynamic import avoids potential circular-dependency since coder-backend
    // modules don't import from subagent-registry.ts.
    const { createCoderBackend } = await import("../agents/coder-backend/registry.js");
    const timeoutMs = entry.expectedEndByMs
      ? Math.max(5 * 60_000, entry.expectedEndByMs - Date.now())
      : 30 * 60_000;
    const subagentConfig = {
      id: runId,
      name: "claude-coder-resume",
      type: "cli" as const,
      cliCommand: resumeCliCommand,
      autoApprove: true,
      timeoutMinutes: Math.ceil(timeoutMs / 60_000),
      enabledMCPs: [] as string[],
    };
    const restartTs = new Date().toISOString();
    appendSpawnEvent({
      v: 1,
      ts: Date.now(),
      event: "spawn.intent",
      runId,
      kind: "resume",
      backend: resumeBackend,
      task: entry.task?.slice(0, 500) ?? "",
      label: entry.label,
      childSessionKey: entry.childSessionKey,
      respawnOfRunId: runId,
    });
    const bg = createCoderBackend(resumeBackend).spawnBackground(
      subagentConfig,
      `Your previous run was interrupted by a gateway restart at ${restartTs}. Resume where you left off.`,
      process.cwd(),
      { runId, resumeSessionId: entry.claudeSessionId },
    );
    if (bg.pid) {
      entry.childPid = bg.pid;
      appendSpawnEvent({ v: 1, ts: Date.now(), event: "spawn.pid", runId, pid: bg.pid });
      persistSubagentRuns();
    }
    const info = await bg.finalPromise;
    const resumeEndedAt = Date.now();
    entry.endedAt = resumeEndedAt;
    entry.outcome = { status: info.exitCode === 0 ? "ok" : "error" };
    if (info.sessionId && !entry.claudeSessionId) entry.claudeSessionId = info.sessionId;
    appendSpawnEvent({
      v: 1,
      ts: resumeEndedAt,
      event: "run.ended",
      runId,
      outcome: info.exitCode === 0 ? "ok" : "error",
      durationMs: entry.startedAt ? resumeEndedAt - entry.startedAt : undefined,
    });
    persistSubagentRuns();
    triggerCleanupForEntry(entry);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn("resumeInterruptedCoderRun: resume spawn failed, marking interrupted", {
      runId,
      err: errMsg,
    });
    const failedAt = Date.now();
    entry.endedAt = failedAt;
    entry.outcome = {
      status: "error",
      error: `Resume failed after gateway restart: ${errMsg}`,
    };
    appendSpawnEvent({ v: 1, ts: failedAt, event: "spawn.failed", runId, error: errMsg });
    persistSubagentRuns();
    triggerCleanupForEntry(entry);
  }
}

/**
 * Reattach a DURABLE coder run (detach-mode `claude_coder` launched inside a
 * tmux session) after a gateway restart.
 *
 * The CLI never stopped — only the gateway-side file tailer died with the old
 * process. We re-open the run's stdout log, replay it through the backend's
 * stream parser so the Activity page rebuilds the history it lost, and keep
 * streaming live. When the CLI finally exits, the same completion path the
 * spawning tool would have run (kanban verify → mark complete → announce)
 * fires from here instead.
 */
async function reattachDurableCoderRun(runId: string, entry: SubagentRunRecord): Promise<void> {
  const shim = reattachDurableTmux(durableKeyOf(entry));
  if (!shim) {
    log.warn("reattachDurableCoderRun: session vanished between probe and attach", { runId });
    settleFinishedDurableRun(runId, entry);
    return;
  }

  // Recreate the in-memory progress record (it does not survive a restart) so
  // recordActivity/subagents_list have somewhere to write.
  try {
    initProgressTracking({
      runId,
      sessionKey: entry.childSessionKey,
      label: entry.label,
      task: entry.task,
      requesterSessionKey: entry.requesterSessionKey,
      requesterOrigin: entry.requesterOrigin,
    });
  } catch {
    /* non-fatal */
  }

  const backend = entry.coderBackend ?? "claude-code";
  let parseStreamLine: StreamParser | null = null;
  try {
    const mod = await import("./coder-runtime/stream-parsers.js");
    parseStreamLine = mod.getStreamParser(backend);
  } catch (err) {
    log.warn("reattachDurableCoderRun: stream parser unavailable", {
      runId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  let lineBuf = "";
  shim.stdout.on("data", (chunk: string) => {
    void import("./subagent-inbox/service.js")
      .then((m) => m.scanChildOutputForAcks(runId, chunk))
      .catch(() => {});
    if (!parseStreamLine) return;
    lineBuf += chunk;
    let idx: number;
    while ((idx = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (!line) continue;
      let formatted: ReturnType<StreamParser>;
      try {
        formatted = parseStreamLine(line);
      } catch {
        continue;
      }
      if (!formatted) continue;
      if (formatted.activity) {
        recordActivity({
          runId,
          sessionKey: entry.childSessionKey,
          kind: formatted.activity.kind,
          label: formatted.activity.label,
          coderBackend: backend,
        });
      }
      if (formatted.claudeSessionId)
        updateSubagentRunClaudeSessionId(runId, formatted.claudeSessionId);
    }
  });

  shim.on("close", (code: number) => {
    log.info("reattachDurableCoderRun: durable run finished after reattach", { runId, code });
    void finalizeDurableCoderRun(runId, entry, code);
  });
}

/**
 * The tmux session is already gone at boot — the run finished (or was killed)
 * while the gateway was down. Recover the outcome from the exit code the
 * launcher script recorded and settle the run through the normal completion
 * path so kanban/announce are not left dangling.
 */
/**
 * When the launcher recorded the durable run's exit code (`exit.code` mtime),
 * or null when it has not — the CLI is still running or was killed before the
 * launcher could write it.
 */
function durableExitRecordedAt(entry: SubagentRunRecord): number | null {
  try {
    return statSync(join(durableRunDir(durableKeyOf(entry)), "exit.code")).mtimeMs;
  } catch {
    return null;
  }
}

/** Runs the liveness sweep already handed to settleFinishedDurableRun. */
const durableSettling = new Set<string>();

/**
 * How long a durable run that exited on its own is left to its owning
 * completion path (the coder tool's finishKanban / reattach watcher, after the
 * verified-completion review) before the sweep settles it from the exit code.
 */
const DURABLE_SETTLE_GRACE_MS = 10 * 60_000;

function settleFinishedDurableRun(runId: string, entry: SubagentRunRecord): void {
  let code: number | null = null;
  try {
    const raw = readFileSync(join(durableRunDir(durableKeyOf(entry)), "exit.code"), "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    if (raw !== "" && Number.isFinite(parsed)) code = parsed;
  } catch {
    /* no exit file — treat as unknown */
  }
  void finalizeDurableCoderRun(runId, entry, code);
}

/**
 * Shared terminal handling for a durable run, whether it exited while we were
 * attached or while the gateway was down. Mirrors `finishKanban` in
 * claude-coder-tool: gate the kanban task behind the verifier, then mark the
 * registry entry complete (which archives + announces).
 */
async function finalizeDurableCoderRun(
  runId: string,
  entry: SubagentRunRecord,
  code: number | null,
): Promise<void> {
  let succeeded = code === 0;
  let output = "";
  try {
    output = readFileSync(join(durableRunDir(durableKeyOf(entry)), "stdout.log"), "utf8").slice(
      -8000,
    );
  } catch {
    /* best effort */
  }

  // VERIFIED COMPLETION: a durable run that finished while (or after) the
  // gateway restarted goes through the same classify → continue → review
  // pipeline as a live one. A premature exit is resumed on the same session.
  try {
    const verdict = await superviseRecoveredCoderRun(runId, entry, code);
    if (verdict) succeeded = verdict.succeeded;
  } catch (err) {
    log.warn("finalizeDurableCoderRun: verification pipeline failed", {
      runId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  const endedAt = Date.now();

  if (entry.kanbanTaskId) {
    try {
      await verifyAndFinalizeKanban({
        runId,
        taskId: entry.kanbanTaskId,
        succeeded,
        brief: entry.task,
        extraEvidence: output,
        workdir: entry.workdir,
        sessionKey: entry.childSessionKey,
        backend: entry.coderBackend,
      });
    } catch (err) {
      log.warn("finalizeDurableCoderRun: kanban verification failed", {
        runId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    completeProgress(runId, succeeded ? "Task completed" : "Completed with errors");
  } catch {
    /* non-fatal */
  }

  appendSpawnEvent({
    v: 1,
    ts: endedAt,
    event: "run.ended",
    runId,
    outcome: succeeded ? "ok" : "error",
    durationMs: entry.startedAt ? endedAt - entry.startedAt : undefined,
  });

  markSubagentRunComplete(
    runId,
    succeeded
      ? { status: "ok" }
      : {
          status: "error",
          error:
            code === null
              ? "Durable run ended without a recorded exit code"
              : code === 127
                ? "CLI exited with code 127 — no coding agent is set up in this workspace yet. Connect one (Claude Code / OpenCode / Codex) under Settings → Connect your AI to run code tasks."
                : `CLI exited with code ${code}`,
        },
    endedAt,
  );
}

/**
 * Run the verified-completion pipeline for a durable coder run recovered by
 * the registry (no live tool closure). Returns null when verification is off
 * or the run has no completion record (pre-upgrade run).
 */
async function superviseRecoveredCoderRun(
  runId: string,
  entry: SubagentRunRecord,
  code: number | null,
): Promise<{ succeeded: boolean } | null> {
  const { isVerificationEnabled, superviseRunExit } = await import("../verification/pipeline.js");
  if (!isVerificationEnabled()) return null;
  const rec = getCompletionRecord(runId);
  if (!rec || rec.terminalAt)
    return rec ? { succeeded: rec.state === "verified" || rec.state === "accepted" } : null;
  const { buildCoderContinuationSpawner, readDurableStdout } =
    await import("../verification/coder-integration.js");
  const backend = (entry.coderBackend ??
    "claude-code") as import("./coder-backend/types.js").CoderBackendId;
  const spawner = buildCoderContinuationSpawner({
    runId,
    backend,
    workdir: entry.workdir ?? process.cwd(),
    model: rec.model,
    env: {
      INFINIBOT_SUBAGENT_RUN_ID: runId,
      INFINIBOT_SUBAGENT_SESSION_KEY: entry.childSessionKey,
      INFINIBOT_PARENT_SESSION_KEY: entry.requesterSessionKey,
    },
    onStdout: (chunk) => {
      void import("./subagent-inbox/service.js")
        .then((m) => m.scanChildOutputForAcks(runId, chunk))
        .catch(() => {});
    },
    onSpawned: ({ pid, durableKey }) =>
      updateSubagentRunContinuation(runId, { childPid: pid, durableKey, timeoutMinutes: 30 }),
  });
  const final = await superviseRunExit({
    runId,
    outcome: {
      exitCode: code,
      rawOutput: readDurableStdout(durableKeyOf(entry)),
      sessionId: entry.claudeSessionId ?? null,
    },
    spawnContinuation: spawner,
  });
  return { succeeded: final?.state === "verified" || final?.state === "accepted" };
}

/**
 * Reattach to a still-running tmux-backed spawn terminal after a gateway
 * restart. Re-binds the PTY client + spawn exit listener via
 * `terminal.reattachSpawnAgent` (which does NOT re-invoke the CLI — the process
 * is already running inside tmux), then resumes waiting for completion so the
 * announce/kanban flow still fires when the child finally exits.
 *
 * Falls back to the PID/claude-resume path only if the reattach fails (e.g. the
 * terminal manager wasn't ready), so recovery is never worse than before.
 */
async function reattachTmuxSubagentRun(runId: string, entry: SubagentRunRecord): Promise<void> {
  try {
    const res = (await callGateway({
      method: "terminal.reattachSpawnAgent",
      params: {
        runId,
        terminalId: entry.terminalId,
        sessionKey: entry.childSessionKey,
        agentId: entry.agentId ?? entry.childSessionKey.split(":")[1] ?? "agent",
        label: entry.label,
        cwd: entry.workdir,
      },
      timeoutMs: 15_000,
    })) as { success?: boolean; error?: string };
    if (res?.success) {
      log.info("reattachTmuxSubagentRun: reattached, resuming completion wait", {
        runId,
        terminalId: entry.terminalId,
      });
      const cfg = loadConfig();
      const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, undefined);
      void waitForSubagentCompletion(runId, waitTimeoutMs);
      return;
    }
    log.warn("reattachTmuxSubagentRun: reattach reported failure, falling back", {
      runId,
      terminalId: entry.terminalId,
      error: res?.error,
    });
  } catch (err) {
    log.warn("reattachTmuxSubagentRun: reattach threw, falling back", {
      runId,
      terminalId: entry.terminalId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // Fallback: behave as the pre-tmux recovery path would have. If the child PID
  // is dead and we have resume state, try claude --resume; otherwise just wait.
  if (entry.childPid && !isPidAlive(entry.childPid)) {
    void resumeInterruptedCoderRun(runId, entry);
    return;
  }
  const cfg = loadConfig();
  void waitForSubagentCompletion(runId, resolveSubagentWaitTimeoutMs(cfg, undefined));
}

function resumeSubagentRun(runId: string) {
  if (!runId || resumedRuns.has(runId)) return;
  const entry = subagentRuns.get(runId);
  if (!entry) return;
  if (entry.cleanupCompletedAt) return;

  if (typeof entry.endedAt === "number" && entry.endedAt > 0) {
    if (!beginSubagentCleanup(runId)) return;
    const requesterOrigin = normalizeDeliveryContext(entry.requesterOrigin);
    void runSubagentAnnounceFlow({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
      requesterSessionKey: entry.requesterSessionKey,
      requesterOrigin,
      requesterDisplayKey: entry.requesterDisplayKey,
      task: entry.task,
      timeoutMs: 30_000,
      cleanup: entry.cleanup,
      waitForCompletion: false,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      label: entry.label,
      outcome: entry.outcome,
    }).then((didAnnounce) => {
      finalizeSubagentCleanup(runId, entry.cleanup, didAnnounce);
    });
    resumedRuns.add(runId);
    return;
  }

  // DURABLE CODER RECOVERY: a detach-mode claude_coder run launched through
  // `spawnCoderProcess` runs its CLI inside a tmux session that writes to log
  // files. Nothing was killed by the restart — only the file tailer died. Rebind
  // the tailer and the completion handler; the work continues uninterrupted.
  if (entry.durableSpawn === "tmux-coder" && process.platform !== "win32") {
    if (isDurableRunAlive(durableKeyOf(entry))) {
      log.info("resumeSubagentRun: durable tmux run still live, reattaching stream", {
        runId,
        tmuxSession: entry.tmuxSession,
      });
      resumedRuns.add(runId);
      entry.interruptedAt = undefined;
      persistSubagentRuns();
      void reattachDurableCoderRun(runId, entry);
      return;
    }
    // Session gone: the run finished (or died) while we were down. Settle it
    // from the recorded exit code rather than leaving a ghost "running" card.
    log.info("resumeSubagentRun: durable tmux session gone, settling from exit code", { runId });
    resumedRuns.add(runId);
    settleFinishedDurableRun(runId, entry);
    return;
  }

  // TMUX-AWARE RECOVERY: if this run was launched via the tmux-backed terminal
  // path and its tmux session is STILL LIVE, the work never actually stopped —
  // only the node-pty client that streamed it died with the gateway. Reattach to
  // the live session and re-bind the exit listener instead of re-spawning or
  // running `claude --resume`. This closes the "died at 0 tokens" hole: the
  // recovery key is the tmux session name (durable, known at spawn), not the
  // claudeSessionId (only known once the CLI speaks). Non-Windows only, mirroring
  // the tmux backend's own platform guard.
  if (entry.terminalId && process.platform !== "win32" && hasLiveSessionSync(entry.terminalId)) {
    log.info("resumeSubagentRun: tmux session still live, reattaching (no respawn)", {
      runId,
      terminalId: entry.terminalId,
      tmuxSession: entry.tmuxSession,
    });
    resumedRuns.add(runId);
    void reattachTmuxSubagentRun(runId, entry);
    return;
  }

  // FIX B: If this run has a tracked childPid that is no longer alive, the
  // gateway restarted mid-run. Attempt `claude --resume` instead of hanging
  // in agent.wait indefinitely.
  if (entry.childPid && !isPidAlive(entry.childPid)) {
    log.warn("resumeSubagentRun: child PID is dead, attempting resume", {
      runId,
      childPid: entry.childPid,
      hasCloudeSessionId: Boolean(entry.claudeSessionId),
    });
    void resumeInterruptedCoderRun(runId, entry);
    resumedRuns.add(runId);
    return;
  }

  // Wait for completion again after restart.
  const cfg = loadConfig();
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, undefined);
  void waitForSubagentCompletion(runId, waitTimeoutMs);
  resumedRuns.add(runId);
}

/**
 * FIX C — Boot-time cross-reference fallback.
 *
 * If runs.json was empty at restart (e.g. corrupted or never written for
 * claude-coder runs spawned before Fix A was deployed), scan the local kanban
 * store for in-progress tasks that contain the footer comment written by
 * `registerSubagentRunForCoder`. Any match produces a minimal registry entry
 * that the sweeper and PID-check logic can operate on.
 *
 * Non-fatal: any error is logged and the function returns 0.
 */
async function reconcileRegistryFromKanbanTasks(): Promise<number> {
  try {
    const { getKanbanStore } = await import("../tasks/store.js");
    // No explicit dir — let getKanbanStore resolve under the ACTIVE profile so
    // reconciliation reads the current profile's kanban.db, not a frozen default.
    const store = getKanbanStore();
    const allTasks = await store.getTasks();
    const inProgress = allTasks.filter((t) => t.status === "in_progress");
    const FOOTER_RE = /<!--\s*subagent runId:(\S+)\s+childKey:(\S+)\s+requester:(\S+)\s*-->/;
    let restored = 0;
    const now = Date.now();
    for (const task of inProgress) {
      const haystack = `${task.description ?? ""} ${(task as any).notes ?? ""}`;
      const match = haystack.match(FOOTER_RE);
      if (!match) continue;
      const [, runId, childSessionKey, requesterSessionKey] = match;
      if (!runId || !childSessionKey || !requesterSessionKey) continue;
      if (subagentRuns.has(runId)) continue;
      const entry: SubagentRunRecord = {
        runId,
        childSessionKey,
        requesterSessionKey,
        requesterDisplayKey: requesterSessionKey,
        task: task.title || "Recovered task",
        cleanup: "delete",
        createdAt: task.createdAt ?? now,
        kanbanTaskId: task.id,
        cleanupHandled: false,
      };
      subagentRuns.set(runId, entry);
      restored++;
    }
    if (restored > 0) {
      persistSubagentRuns();
      log.warn("reconcileRegistryFromKanbanTasks: recovered runs from kanban", { restored });
    }
    return restored;
  } catch (err) {
    log.warn("reconcileRegistryFromKanbanTasks failed (non-fatal)", {
      err: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Enqueue a `gateway_recovery` report after a crash/restart that left subagent
 * runs interrupted. Fires any operator-registered `gateway_crash` triggers, and
 * always falls back to a default enqueue so recovery reports work out of the box
 * with ui+telegram sinks. Lazy-imported and fully best-effort — the report
 * system must never affect subagent recovery.
 */
function emitGatewayRecoveryReport(interruptedEntries: SubagentRunRecord[]): void {
  const now = Date.now();
  const starts = interruptedEntries
    .map((e) => e.startedAt ?? e.createdAt)
    .filter((n): n is number => typeof n === "number");
  const windowStart = starts.length ? Math.min(...starts) : now - 2 * 60 * 60 * 1000;
  const config = {
    incidentWindow: [windowStart, now] as [number, number],
    trigger: `Gateway restart detected — ${interruptedEntries.length} interrupted subagent run(s) being resurrected.`,
  };

  void import("../reports/trigger.js")
    .then(({ enqueueReport, fireEventTriggers }) => {
      const fired = fireEventTriggers("gateway_crash", config);
      if (fired.length === 0) {
        // No operator-configured trigger — use the built-in default.
        const rec = enqueueReport({
          kind: "gateway_recovery",
          trigger: "event",
          sinks: ["ui", "telegram"],
          config,
        });
        log.info("gateway_recovery report enqueued (default)", { reportId: rec.id });
      } else {
        log.info("gateway_recovery report(s) enqueued via triggers", { count: fired.length });
      }
    })
    .catch((err) => {
      log.warn("emitGatewayRecoveryReport: enqueue failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
}

function restoreSubagentRunsOnce() {
  if (restoreAttempted) return;
  restoreAttempted = true;
  let restored: Map<string, SubagentRunRecord>;
  try {
    restored = loadSubagentRegistryFromDisk();
  } catch (err) {
    log.warn("registry restore failed at disk-load level", {
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // FIX C: If the on-disk registry is empty, attempt to rebuild entries from
  // in-progress kanban tasks that contain the subagent footer comment. This
  // is insurance against registry-loss between a spawn and the first persist.
  // We do it async and then resume — the reconcile result feeds into the same
  // resume loop below via a re-check after the await.
  const doRestoreWithReconcile = async () => {
    let copied = 0;
    let skipped = 0;
    for (const [runId, entry] of restored.entries()) {
      try {
        if (!runId || !entry) {
          skipped++;
          continue;
        }
        if (!subagentRuns.has(runId)) {
          subagentRuns.set(runId, entry);
          copied++;
        }
      } catch (err) {
        skipped++;
        log.warn("registry restore: skipped malformed entry", {
          runId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (skipped > 0) {
      log.warn("registry restore: completed with skipped entries", { copied, skipped });
    }

    if (restored.size === 0) {
      // Ledger rehydration: rebuild from append-only spawn-ledger for runs with
      // no terminal event. This covers hard crashes where runs.json was mid-write.
      try {
        const sinceMs = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
        const ledgerEvents = readSpawnLedger({ sinceMs });
        if (ledgerEvents.length > 0) {
          const ledgerRecords = replayLedgerToRunRecords(ledgerEvents);
          let rehydrated = 0;
          for (const [runId, partial] of ledgerRecords) {
            if (partial.endedAt) continue; // already terminal — skip
            if (subagentRuns.has(runId)) continue;
            const entry = partial as SubagentRunRecord;
            if (!entry.runId || !entry.childSessionKey) continue;
            subagentRuns.set(runId, entry);
            rehydrated++;
          }
          if (rehydrated > 0) {
            log.info("registry restore: rehydrated runs from spawn ledger", { rehydrated });
            persistSubagentRuns();
          }
        }
      } catch (ledgerErr) {
        log.warn("registry restore: ledger rehydration failed", {
          err: ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr),
        });
      }

      if (subagentRuns.size === 0) {
        log.info("registry restore: disk was empty, attempting kanban reconciliation");
        await reconcileRegistryFromKanbanTasks();
      }
    }

    if (subagentRuns.size === 0) return;

    // Report-system hook: a gateway restart that finds interrupted subagent
    // runs is a recovery event. Enqueue a `gateway_recovery` report (rendered
    // out-of-process by the report worker) so the operator gets a post-incident
    // PDF. Best-effort + lazy-imported so the report system can never break
    // subagent recovery.
    try {
      // A durable run whose tmux session is still alive was never actually
      // interrupted — the gateway restarted around it. Reporting it as a
      // recovery incident would be false alarm noise.
      const interruptedEntries = [...subagentRuns.values()].filter(
        (e) =>
          e.interruptedAt &&
          !(e.durableSpawn === "tmux-coder" && isDurableRunAlive(durableKeyOf(e))),
      );
      if (interruptedEntries.length > 0) {
        emitGatewayRecoveryReport(interruptedEntries);
      }
    } catch (err) {
      log.warn("registry restore: gateway_recovery report hook failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      ensureListener();
      if ([...subagentRuns.values()].some((entry) => entry.archiveAtMs || !entry.endedAt)) {
        startSweeper();
      }
      for (const runId of subagentRuns.keys()) {
        try {
          resumeSubagentRun(runId);
        } catch (err) {
          log.warn("registry restore: resume failed for run", {
            runId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      log.warn("registry restore: post-load wiring failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  };

  void doRestoreWithReconcile();
}

/**
 * Force a run into its terminal completed state from the server side.
 * Mirrors what the lifecycle listener would do for a real "end" or
 * "error" event, but synthesised when the actual event is lost (gateway
 * crash, transport drop, etc). Persists the new state, fires the
 * announce flow, and runs the kanban + progress side-effects.
 *
 * Idempotent: calling on an already-completed run is a no-op.
 */
export function forceCompleteRun(
  runId: string,
  opts: { outcome?: "ok" | "error"; error?: string } = {},
): boolean {
  if (!runId) return false;
  const entry = subagentRuns.get(runId);
  if (!entry) {
    log.warn("forceCompleteRun: unknown runId", { runId });
    return false;
  }
  if (entry.endedAt && entry.cleanupHandled) return false;
  const outcome = opts.outcome ?? "error";
  entry.endedAt = entry.endedAt ?? Date.now();
  entry.outcome =
    outcome === "ok"
      ? { status: "ok" }
      : { status: "error", error: opts.error ?? "Forced completion" };
  appendSpawnEvent({
    v: 1,
    ts: entry.endedAt,
    event: "run.ended",
    runId,
    outcome,
    durationMs: entry.startedAt ? entry.endedAt - entry.startedAt : undefined,
    error: outcome !== "ok" ? (opts.error ?? "Forced completion") : undefined,
  });
  persistSubagentRuns();
  triggerCleanupForEntry(entry);
  return true;
}

/**
 * Liveness reconciliation — flip "running" runs whose OS process is actually
 * dead to a terminal state, instead of waiting up to ~32 min for the
 * `expectedEndByMs` stuck-sweep to catch them.
 *
 * Why this exists: a coder child can exit (crash, kill, normal finish) without
 * its lifecycle "end" event ever reaching the in-process listener (gateway
 * crash, transport drop, terminal-mode runs that never emit one). The run then
 * sits in the registry with no `endedAt`, so `subagents.list` reports it as
 * "running" forever and the Activity page shows a ghost agent. The only ground
 * truth we have is the recorded `childPid` — `process.kill(pid, 0)` tells us
 * whether that process still exists.
 *
 * Two passes:
 *   1. Tracked-PID-dead → mark failed immediately (with a small spawn-race
 *      grace so a just-recorded PID isn't killed before the OS shows it).
 *   2. No-PID orphan that is clearly stale (older than the hard stuck ceiling
 *      and past any expected deadline) → mark timed out. This catches legacy /
 *      test entries that never carried a PID or an `expectedEndByMs` and so
 *      were invisible to the existing stuck-sweep.
 *
 * Idempotent and cheap; safe to call from the sweeper and lazily from
 * `subagents.list`. Returns the number of runs it reconciled.
 */
export function reconcileSubagentLiveness(): number {
  const now = Date.now();
  let reconciled = 0;
  // Minimum age before a dead PID counts — guards the narrow window between
  // recording a child PID and the OS making it observable via kill(pid,0).
  const PID_RACE_GRACE_MS = 5_000;
  for (const entry of subagentRuns.values()) {
    if (entry.endedAt) continue;
    if (entry.cleanupHandled) continue;
    const ageMs = now - (entry.startedAt ?? entry.createdAt);

    // A durable run's ground truth is its tmux session, not a PID. The recorded
    // pid is the tmux pane's shell, which the gateway does not own; skip both
    // passes while the session is alive so a restart-surviving run is never
    // reaped as a ghost.
    if (entry.durableSpawn === "tmux-coder" && isDurableRunAlive(durableKeyOf(entry))) continue;
    // Between attempts the verified-completion pipeline owns the run.
    if (isUnderVerification(entry.runId)) continue;

    // A durable run whose launcher recorded an exit code finished on its own:
    // its completion path settles it with the real outcome once the review
    // lands (seconds after the tmux session ends). Stamping it "exited without
    // a completion signal" here raced that path and made verified runs announce
    // as failed. Only if nothing settles it within the grace, settle it from
    // the exit code through the normal path.
    if (entry.durableSpawn === "tmux-coder") {
      const exitedAt = durableExitRecordedAt(entry);
      if (exitedAt !== null) {
        if (now - exitedAt < DURABLE_SETTLE_GRACE_MS) continue;
        if (!durableSettling.has(entry.runId)) {
          durableSettling.add(entry.runId);
          log.info("reconcileSubagentLiveness: durable run exited, settling from exit code", {
            runId: entry.runId,
          });
          settleFinishedDurableRun(entry.runId, entry);
        }
        continue;
      }
    }

    if (typeof entry.childPid === "number" && entry.childPid > 0) {
      if (ageMs < PID_RACE_GRACE_MS) continue;
      if (isPidAlive(entry.childPid)) continue;
      // Process is gone but the run never reported completion.
      const elapsedSec = Math.floor(ageMs / 1000);
      log.warn("reconcileSubagentLiveness: child process dead, marking failed", {
        runId: entry.runId,
        childPid: entry.childPid,
        elapsedSec,
      });
      entry.endedAt = now;
      entry.outcome = {
        status: "error",
        error: `Process exited (pid ${entry.childPid}) after ${elapsedSec}s without a completion signal`,
      };
      appendSpawnEvent({
        v: 1,
        ts: now,
        event: "run.ended",
        runId: entry.runId,
        outcome: "error",
        durationMs: entry.startedAt ? now - entry.startedAt : undefined,
        error: "process exited without completion signal",
      });
      reconciled++;
      triggerCleanupForEntry(entry);
      continue;
    }

    // No PID to probe. The normal stuck-sweep handles entries with a valid
    // `expectedEndByMs`; here we only age out entries that have NO usable
    // deadline yet are unambiguously stale (legacy / test residue).
    const hardStale = ageMs > STUCK_DEFAULT_MS + STUCK_GRACE_MS;
    const deadlinePassed = entry.expectedEndByMs ? entry.expectedEndByMs <= now : true;
    if (hardStale && deadlinePassed) {
      log.warn("reconcileSubagentLiveness: stale no-pid run, marking timeout", {
        runId: entry.runId,
        ageSec: Math.floor(ageMs / 1000),
      });
      entry.endedAt = now;
      entry.outcome = {
        status: "error",
        error: `Run had no trackable process and went stale (${Math.floor(ageMs / 60_000)}m without completion)`,
      };
      reconciled++;
      triggerCleanupForEntry(entry);
    }
  }
  if (reconciled > 0) persistSubagentRuns();
  return reconciled;
}

function resolveArchiveAfterMs(cfg?: ReturnType<typeof loadConfig>) {
  const config = cfg ?? loadConfig();
  const minutes = config.agents?.defaults?.subagents?.archiveAfterMinutes ?? 60;
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  return Math.max(1, Math.floor(minutes)) * 60_000;
}

function resolveSubagentWaitTimeoutMs(
  cfg: ReturnType<typeof loadConfig>,
  runTimeoutSeconds?: number,
) {
  return resolveAgentTimeoutMs({ cfg, overrideSeconds: runTimeoutSeconds });
}

function startSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    void sweepSubagentRuns();
  }, 60_000);
  sweeper.unref?.();
}

function stopSweeper() {
  if (!sweeper) return;
  clearInterval(sweeper);
  sweeper = null;
}

async function sweepSubagentRuns() {
  const now = Date.now();
  let mutated = false;

  // ── Process-liveness reconciliation ───────────────────────
  // Catch runs whose child process has died but whose lifecycle "end" event
  // was lost, well before the slow `expectedEndByMs` stuck deadline. This is
  // the primary defense against ghost "running" agents in subagents.list.
  reconcileSubagentLiveness();

  // ── Stuck-run detection ───────────────────────────────────
  // Runs whose `expectedEndByMs` has passed without an `endedAt`
  // get auto-marked as timed-out. This catches sub-agents that lost
  // their lifecycle "end" event (gateway crash, network blip) so the
  // registry doesn't carry them indefinitely.
  for (const entry of subagentRuns.values()) {
    if (entry.endedAt) continue;
    if (entry.cleanupHandled) continue;
    if (!entry.expectedEndByMs || entry.expectedEndByMs > now) continue;
    if (isUnderVerification(entry.runId)) continue;
    const elapsedSec = Math.floor((now - (entry.startedAt ?? entry.createdAt)) / 1000);
    log.warn("sweeper marking stuck subagent run as timeout", {
      runId: entry.runId,
      childSessionKey: entry.childSessionKey,
      elapsedSec,
    });
    entry.endedAt = now;
    entry.outcome = {
      status: "error",
      error: `Run exceeded expected timeout (${elapsedSec}s without lifecycle end event)`,
    };
    mutated = true;
    // Trigger cleanup/announce just like a real lifecycle "error" event.
    triggerCleanupForEntry(entry);
  }

  // ── Archive sweep ─────────────────────────────────────────
  for (const [runId, entry] of subagentRuns.entries()) {
    if (!entry.archiveAtMs || entry.archiveAtMs > now) continue;
    subagentRuns.delete(runId);
    mutated = true;
    try {
      await callGateway({
        method: "sessions.delete",
        params: { key: entry.childSessionKey, deleteTranscript: true },
        timeoutMs: 10_000,
      });
    } catch (err) {
      log.warn("archive sweep: sessions.delete failed", {
        runId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Pending-lifecycle TTL cleanup ─────────────────────────
  // Drop quarantined events whose runId never showed up.
  for (const [runId, queue] of pendingLifecycleEvents.entries()) {
    const survivors = queue.filter((q) => now - q.queuedAt <= PENDING_TTL_MS);
    if (survivors.length === 0) {
      log.warn("dropped pending lifecycle events for unknown run", {
        runId,
        dropped: queue.length,
      });
      pendingLifecycleEvents.delete(runId);
    } else if (survivors.length !== queue.length) {
      pendingLifecycleEvents.set(runId, survivors);
    }
  }

  if (mutated) persistSubagentRuns();
  if (subagentRuns.size === 0 && pendingLifecycleEvents.size === 0) stopSweeper();
}

/**
 * Shared cleanup trigger for both the stuck-sweep path and
 * `forceCompleteRun`. Runs the announce flow against the requester +
 * finalizes cleanup state. Skips if cleanup already happened.
 */
/**
 * === gamification: phase 1 ===
 * Award XP / advance quests / feed the achievement watcher when a sub-agent run
 * reaches its terminal state. Called immediately after a successful
 * `beginSubagentCleanup` (the global once-guard) so it fires exactly once per
 * run regardless of which cleanup path won. Fully isolated + best-effort.
 */
function awardGamificationForRun(entry: SubagentRunRecord): void {
  try {
    const failed = entry.outcome?.status === "error";
    // childSessionKey looks like "agent:<agentId>:..." — use the agent id as the
    // XP owner so the leaderboard is per-agent; fall back to the label.
    const ownerId = entry.childSessionKey?.split(":")[1] || entry.label || "agent";
    getGamificationEngine().recordTaskCompletion(ownerId, { failed });
  } catch (err) {
    log.warn("gamification hook failed", {
      runId: entry.runId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function triggerCleanupForEntry(entry: SubagentRunRecord): void {
  if (!beginSubagentCleanup(entry.runId)) return;
  awardGamificationForRun(entry);
  // Oversight rule #14: a failed sub-agent fires an on-event report (last error
  // tail + run id) via the report_triggers system. Best-effort + dynamic import
  // so it can never destabilize the cleanup path.
  if (entry.outcome?.status === "error") {
    void import("../reports/trigger.js")
      .then(({ fireEventTriggers }) => {
        const errText = String(entry.outcome?.error ?? "Unknown error");
        const tail = errText.split(/\r?\n/).slice(-30).join("\n");
        fireEventTriggers("subagent_failed", {
          eventType: "subagent_failed",
          title: `Sub-agent failed — ${entry.label || entry.runId}`,
          summary: `Run ${entry.runId}${entry.coderBackend ? ` (${entry.coderBackend})` : ""} failed: ${errText.slice(0, 200)}`,
          stderrTail: tail,
          runId: entry.runId,
          taskId: entry.kanbanTaskId ?? undefined,
          actions: ["Inspect the run's stderr above.", "Respawn with context or stop the run."],
        });
      })
      .catch(() => {
        /* triggers unavailable — non-fatal */
      });
  }
  if (entry.kanbanTaskId) {
    // Stuck-sweep / forced-completion path also routes through the gate so a
    // forced "ok" completion can never bypass verification. Single-flight in
    // the gate makes this a no-op if the lifecycle path already handled it.
    void verifyAndFinalizeKanban({
      runId: entry.runId,
      taskId: entry.kanbanTaskId,
      succeeded: entry.outcome?.status !== "error",
      backend: entry.coderBackend,
    }).catch((err) => {
      log.warn("verification gate failed during stuck-sweep", {
        runId: entry.runId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }
  completeProgress(
    entry.runId,
    entry.outcome?.status === "error"
      ? `Failed: ${entry.outcome.error || "Unknown error"}`
      : "Task completed",
  );
  const requesterOrigin = normalizeDeliveryContext(entry.requesterOrigin);
  void runSubagentAnnounceFlow({
    childSessionKey: entry.childSessionKey,
    childRunId: entry.runId,
    requesterSessionKey: entry.requesterSessionKey,
    requesterOrigin,
    requesterDisplayKey: entry.requesterDisplayKey,
    task: entry.task,
    timeoutMs: 30_000,
    cleanup: entry.cleanup,
    waitForCompletion: false,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    label: entry.label,
    outcome: entry.outcome,
  }).then((didAnnounce) => {
    finalizeSubagentCleanup(entry.runId, entry.cleanup, didAnnounce);
  });
}

function ensureListener() {
  if (listenerStarted) {
    return;
  }
  listenerStarted = true;
  listenerStop = onAgentEvent((evt) => {
    if (!evt || evt.stream !== "lifecycle") return;
    const entry = subagentRuns.get(evt.runId);
    if (!entry) {
      // The run hasn't been registered yet (race between agent RPC
      // returning and registerSubagentRun running). Queue with TTL so
      // registerSubagentRun can replay it. Without this, fast-completing
      // sub-agents lose their lifecycle event entirely.
      enqueuePendingLifecycle(evt.runId, evt);
      return;
    }
    applyLifecycleEvent(entry, evt);
  });
}

/**
 * Every non-subagent run (normal chat/voice turns) lands here too, and the
 * sweeper that expires these only runs while subagent runs exist — so between
 * subagent runs this map grew by one entry per chat run, forever. Expire
 * inline, at most twice per TTL.
 */
let lastPendingPruneAt = 0;
function prunePendingLifecycle(now: number): void {
  if (now - lastPendingPruneAt < PENDING_TTL_MS / 2) return;
  lastPendingPruneAt = now;
  for (const [runId, queue] of pendingLifecycleEvents) {
    const survivors = queue.filter((q) => now - q.queuedAt <= PENDING_TTL_MS);
    if (survivors.length === 0) pendingLifecycleEvents.delete(runId);
    else if (survivors.length !== queue.length) pendingLifecycleEvents.set(runId, survivors);
  }
}

function enqueuePendingLifecycle(
  runId: string,
  evt: Parameters<Parameters<typeof onAgentEvent>[0]>[0],
): void {
  if (!runId) return;
  prunePendingLifecycle(Date.now());
  const queue = pendingLifecycleEvents.get(runId) ?? [];
  queue.push({ evt, queuedAt: Date.now() });
  // Cap per-run so a runaway emitter can't blow memory.
  if (queue.length > PENDING_MAX_PER_RUN) queue.splice(0, queue.length - PENDING_MAX_PER_RUN);
  pendingLifecycleEvents.set(runId, queue);
}

function drainPendingLifecycle(entry: SubagentRunRecord): void {
  const queue = pendingLifecycleEvents.get(entry.runId);
  if (!queue) return;
  pendingLifecycleEvents.delete(entry.runId);
  const now = Date.now();
  for (const item of queue) {
    if (now - item.queuedAt > PENDING_TTL_MS) {
      log.warn("dropped stale pending lifecycle event", {
        runId: entry.runId,
        ageMs: now - item.queuedAt,
      });
      continue;
    }
    applyLifecycleEvent(entry, item.evt);
  }
}

/**
 * Apply a single lifecycle event onto a known entry. Pure on `entry` +
 * external services — both the listener and the orphan-replay path go
 * through this so they stay in lockstep.
 */
function applyLifecycleEvent(
  entry: SubagentRunRecord,
  evt: Parameters<Parameters<typeof onAgentEvent>[0]>[0],
): void {
  const phase = evt.data?.phase ?? evt.data?.status ?? evt.data?.kind;
  if (phase === "start") {
    const startedAt =
      typeof evt.data?.startedAt === "number" ? (evt.data.startedAt as number) : undefined;
    if (startedAt) {
      entry.startedAt = startedAt;
      persistSubagentRuns();
    }
    return;
  }
  if (phase !== "end" && phase !== "error") return;
  const endedAt = typeof evt.data?.endedAt === "number" ? (evt.data.endedAt as number) : Date.now();
  entry.endedAt = endedAt;
  if (phase === "error") {
    const error = typeof evt.data?.error === "string" ? (evt.data.error as string) : undefined;
    entry.outcome = { status: "error", error };
  } else {
    entry.outcome = { status: "ok" };
  }
  // Capture terminal result for terminal-first execution mode
  const terminalResult =
    typeof evt.data?.terminalResult === "string" ? (evt.data.terminalResult as string) : undefined;
  persistSubagentRuns();

  // Non-blocking: emit a work-activity event for this run finishing.
  if (phase === "error") {
    emitSubagentFailed({
      runId: entry.runId,
      label: entry.label,
      task: entry.task,
      startedAt: entry.startedAt,
      endedAt,
      error: typeof entry.outcome?.error === "string" ? entry.outcome.error : undefined,
    });
  } else {
    emitSubagentCompleted({
      runId: entry.runId,
      label: entry.label,
      task: entry.task,
      startedAt: entry.startedAt,
      endedAt,
    });
  }

  // Auto-update kanban task status — through the MANDATORY verification gate.
  // Never flips straight to "done": the gate parks the task in "review" and an
  // independent verifier must PASS before it reaches "done" (fail-closed).
  if (entry.kanbanTaskId) {
    void verifyAndFinalizeKanban({
      runId: entry.runId,
      taskId: entry.kanbanTaskId,
      succeeded: phase !== "error",
      extraEvidence: terminalResult,
      backend: entry.coderBackend,
    }).catch((err) => {
      log.warn("verification gate failed on completion", {
        runId: entry.runId,
        taskId: entry.kanbanTaskId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Mark progress as complete
  completeProgress(
    entry.runId,
    phase === "error" ? `Failed: ${entry.outcome?.error || "Unknown error"}` : "Task completed",
  );

  if (!beginSubagentCleanup(entry.runId)) {
    return;
  }
  awardGamificationForRun(entry); // === gamification: phase 1 ===
  const requesterOrigin = normalizeDeliveryContext(entry.requesterOrigin);
  void runSubagentAnnounceFlow({
    childSessionKey: entry.childSessionKey,
    childRunId: entry.runId,
    requesterSessionKey: entry.requesterSessionKey,
    requesterOrigin,
    requesterDisplayKey: entry.requesterDisplayKey,
    task: entry.task,
    timeoutMs: 30_000,
    cleanup: entry.cleanup,
    waitForCompletion: false,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    label: entry.label,
    outcome: entry.outcome,
    // For terminal-first mode, pass terminal output as the reply
    roundOneReply: terminalResult,
  }).then((didAnnounce) => {
    finalizeSubagentCleanup(entry.runId, entry.cleanup, didAnnounce);
  });
}

/**
 * Build + emit a rich "agent-summary" proactive pop-up for a finished run.
 * Server-side so it surfaces on EVERY route's global overlay (not only when a
 * tab is on the Activity page). Diff stats come from `filesTouched` plus a
 * best-effort `git diff --numstat` in the run's workdir for +/- line counts.
 * Generated media URLs are harvested from any image/video paths the agent
 * touched. Deduped by runId via the popup store's dedupKey window.
 */
/**
 * Forward-action buttons for the completion overlay. "Build into UI" and
 * "Commit & Push" only appear when there is actually work owed (unbuilt /
 * uncommitted); "Open card" and "Reject" are always available. The build /
 * commit actions are non-terminating — clicking them runs the real action via
 * proactive.buildInto / proactive.commitPush and updates the chips in place.
 */
function buildCompletionActions(o: {
  kanbanTaskId?: string;
  workdir?: string;
  paths: string[];
  branch?: string;
  buildStatus?: "built" | "unbuilt";
  commitStatus?: "committed" | "uncommitted";
  pushed?: boolean;
  label: string;
}): PopupAction[] {
  const actions: PopupAction[] = [];
  const ctx = { workdir: o.workdir, paths: o.paths.slice(0, 200), branch: o.branch };
  if (o.buildStatus === "unbuilt") {
    actions.push({ id: "build", kind: "build", label: "Build into UI", payload: { ...ctx } });
  }
  if (o.commitStatus === "uncommitted") {
    actions.push({
      id: "commitpush",
      kind: "commitpush",
      label: "Commit & Push",
      primary: true,
      payload: { ...ctx, message: `chore(agent): ${o.label}`.slice(0, 120) },
    });
  }
  if (o.kanbanTaskId) {
    actions.push({
      id: "open",
      kind: "open",
      label: "Open card",
      payload: { target: `kanban?task=${o.kanbanTaskId}` },
    });
  }
  actions.push({
    id: "reject",
    kind: "dismiss",
    label: "Reject",
    payload: { reason: "rejected from completion overlay" },
  });
  return actions;
}

async function emitAgentSummaryPopup(entry: SubagentRunRecord): Promise<void> {
  const { STATE_DIR } = await import("../config/paths.js");
  const { emitProactiveServerSide } = await import("../proactive/emit.js");

  const ok = entry.outcome?.status !== "error";
  const touched = entry.filesTouched ?? [];
  const changedPaths = touched
    .filter((f) => f.action === "created" || f.action === "edited" || f.action === "deleted")
    .map((f) => f.path);
  const uniqueChanged = Array.from(new Set(changedPaths));

  // Best-effort line counts from git numstat (fast, guarded, never throws).
  let additions = 0;
  let deletions = 0;
  if (entry.workdir && uniqueChanged.length > 0) {
    try {
      const { execFileSync } = await import("child_process");
      const out = execFileSync("git", ["diff", "--numstat", "--no-color"], {
        cwd: entry.workdir,
        encoding: "utf8",
        timeout: 4000,
        maxBuffer: 1024 * 1024,
      });
      for (const line of out.split("\n")) {
        const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
        if (!m) continue;
        if (m[1] !== "-") additions += Number(m[1]);
        if (m[2] !== "-") deletions += Number(m[2]);
      }
    } catch {
      /* not a git repo / git absent — fall back to file-count only */
    }
  }

  // Harvest generated media (images / videos) the agent created or edited.
  const MEDIA_RE = /\.(png|jpe?g|gif|webp|svg|mp4|webm|mov)$/i;
  const thumbnails = touched
    .filter((f) => f.action !== "read" && MEDIA_RE.test(f.path))
    .slice(0, 6)
    .map((f) => ({
      url: f.path,
      type: /\.(mp4|webm|mov)$/i.test(f.path) ? ("video" as const) : ("image" as const),
      alt: f.path.split("/").pop() ?? f.path,
    }));

  // Derive build/commit status for the completion overlay's forward actions.
  // Best-effort, guarded — a missing repo / git degrades to sensible defaults.
  let buildStatus: "built" | "unbuilt" | undefined;
  let commitStatus: "committed" | "uncommitted" | undefined;
  let pushed: boolean | undefined;
  let branch: string | undefined;
  try {
    const { computeChangeStatus } = await import("../proactive/change-status.js");
    const s = computeChangeStatus(entry.workdir, uniqueChanged);
    buildStatus = s.buildStatus;
    commitStatus = s.commitStatus;
    pushed = s.pushed;
    branch = s.branch || undefined;
  } catch {
    /* status detection is optional — overlay still renders without chips */
  }

  const label = entry.label || entry.task?.slice(0, 60) || entry.runId;
  const taskLine = entry.task ? entry.task.slice(0, 280) : "Background sub-agent run completed.";
  const errLine =
    !ok && typeof entry.outcome?.error === "string" ? `\n\n**Error:** ${entry.outcome.error}` : "";
  const fileLines = uniqueChanged
    .slice(0, 8)
    .map((p) => `- \`${p}\``)
    .join("\n");
  const summaryMarkdown =
    `${taskLine}${errLine}` + (fileLines ? `\n\n**Changed files:**\n${fileLines}` : "");

  emitProactiveServerSide(
    {
      tier: ok ? "NOTABLE" : "NOTABLE",
      title: ok ? `Agent finished: ${label}` : `Agent failed: ${label}`,
      body: taskLine,
      attribution: {
        agentId: entry.childSessionKey || entry.runId || "subagent",
        agentName: label,
        cardId: entry.kanbanTaskId,
        goalId: entry.parentGoalId,
      },
      dedupKey: `subagent:complete:${entry.runId}`,
      actions: buildCompletionActions({
        kanbanTaskId: entry.kanbanTaskId,
        workdir: entry.workdir,
        paths: uniqueChanged,
        branch,
        buildStatus,
        commitStatus,
        pushed,
        label,
      }),
      media: {
        kind: "agent-summary",
        payload: {
          agentName: label,
          project: entry.parentGoalTitle,
          cardId: entry.kanbanTaskId,
          summaryMarkdown,
          diff: {
            filesChanged: uniqueChanged.length,
            additions,
            deletions,
          },
          thumbnails: thumbnails.length ? thumbnails : undefined,
          href: entry.kanbanTaskId ? `#/kanban?task=${entry.kanbanTaskId}` : undefined,
          buildStatus,
          commitStatus,
          pushed,
          statusContext: {
            workdir: entry.workdir,
            paths: uniqueChanged.slice(0, 200),
            branch,
          },
        },
      },
    },
    STATE_DIR,
  );
}

function finalizeSubagentCleanup(runId: string, cleanup: "delete" | "keep", didAnnounce: boolean) {
  const entry = subagentRuns.get(runId);
  if (!entry) return;
  archiveSubagentRun(entry);

  // Push the lifecycle transition onto the gateway WS so the Activity
  // page's <subagent-history-feed> (which only refetches on a 30s idle
  // tick or window-focus otherwise) sees the new archive row in real
  // time. The UI already subscribes to subagent.complete/error/timeout.
  const outcomeStatus = entry.outcome?.status;
  const outcomeError = entry.outcome?.error;
  const lifecycleEvent: "subagent.complete" | "subagent.error" | "subagent.timeout" =
    outcomeStatus === "error"
      ? typeof outcomeError === "string" && /timeout/i.test(outcomeError)
        ? "subagent.timeout"
        : "subagent.error"
      : "subagent.complete";
  broadcastSubagentLifecycle(lifecycleEvent, {
    runId: entry.runId,
    sessionKey: entry.childSessionKey,
    label: entry.label,
    task: entry.task,
    requesterSessionKey: entry.requesterSessionKey,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    outcome: entry.outcome
      ? { status: entry.outcome.status, error: entry.outcome.error }
      : undefined,
    coderBackend: entry.coderBackend,
    ts: entry.endedAt ?? Date.now(),
  });

  // Fire-and-forget: surface a rich "agent-summary" proactive pop-up so the
  // global overlay shows a styled completion card (diff stats + media) on every
  // route, not just the Activity page. Deduped by runId. Best-effort, never
  // blocks the lifecycle broadcast.
  void emitAgentSummaryPopup(entry).catch((err) => {
    log.warn("agent-summary popup emit failed", {
      runId,
      err: err instanceof Error ? err.message : String(err),
    });
  });

  // Fire-and-forget: verified-completion review for runs the coder pipeline did
  // not supervise (gateway sub-agents via sessions_spawn, legacy runs). Coder
  // runs already have a terminal record, so this is a no-op for them.
  void (async () => {
    try {
      const { isVerificationEnabled, reviewFinishedRun } =
        await import("../verification/pipeline.js");
      if (!isVerificationEnabled() || getCompletionRecord(runId)) return;
      const { readLatestAssistantReply } = await import("./tools/agent-step.js");
      const finalText =
        (await readLatestAssistantReply({ sessionKey: entry.childSessionKey }).catch(() => "")) ??
        "";
      await reviewFinishedRun({
        runId,
        childSessionKey: entry.childSessionKey,
        requesterSessionKey: entry.requesterSessionKey,
        label: entry.label ?? entry.task.slice(0, 80),
        task: entry.task,
        workdir: entry.workdir ?? null,
        startedAt: entry.startedAt,
        finalText: finalText || "",
        exitOk: entry.outcome?.status !== "error",
        backend: entry.coderBackend ?? null,
      });
    } catch (err) {
      log.warn("verified-completion review failed", {
        runId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  // Fire-and-forget: auto-generate a post-run review so the Oversight feed
  // populates without anyone manually forcing it. Idempotent + deduped by
  // runId, and skipped when the agent already self-reported. Dynamic import
  // keeps the dependency edge one-directional (auto-reviewer imports this
  // module, so a static import here would be circular). Never blocks the
  // lifecycle broadcast above.
  void (async () => {
    try {
      const { autoReview } = await import("./auto-reviewer/index.js");
      await autoReview(runId);
    } catch (err) {
      log.warn("auto-review trigger failed", {
        runId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  // Fire-and-forget: capture the in-depth, durable AgentRunReview (rich record
  // + agent-written markdown summary) served via agents.reviews.*. Idempotent
  // + deduped by runId. Dynamic import keeps this module free of a static edge
  // on run-reviews (which imports back into the registry). Never blocks.
  void (async () => {
    try {
      const { captureRunReview } = await import("./run-reviews/index.js");
      await captureRunReview(runId);
    } catch (err) {
      log.warn("run-review capture failed", {
        runId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  if (cleanup === "delete") {
    // Do NOT delete immediately. Mark the entry for archive after the UI
    // visibility grace window so the completed card stays in subagents.list
    // for ~10 minutes before the sweeper removes it. This replaces the old
    // instant-delete that yanked cards from the feed the moment cleanup ran.
    if (!entry.archiveAtMs) {
      entry.archiveAtMs = Date.now() + COMPLETED_ARCHIVE_DELAY_MS;
    }
    entry.cleanupCompletedAt = Date.now();
    persistSubagentRuns();
    startSweeper(); // Ensure sweeper is running to process the archive timer.
    return;
  }
  if (!didAnnounce) {
    // Allow retry on the next wake if the announce failed.
    entry.cleanupHandled = false;
    persistSubagentRuns();
    return;
  }
  entry.cleanupCompletedAt = Date.now();
  persistSubagentRuns();
}

function beginSubagentCleanup(runId: string) {
  const entry = subagentRuns.get(runId);
  if (!entry) return false;
  if (entry.cleanupCompletedAt) return false;
  if (entry.cleanupHandled) return false;
  entry.cleanupHandled = true;
  persistSubagentRuns();
  return true;
}

export function registerSubagentRun(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey: string;
  task: string;
  cleanup: "delete" | "keep";
  label?: string;
  runTimeoutSeconds?: number;
  /** Existing kanban project to attach the auto-created task to. */
  projectId?: string;
  /** Project name hint — server resolves to existing match (exact / fuzzy) or creates one. */
  projectHint?: string;
  /**
   * Terminal id of the tmux-backed spawn terminal, when this run was launched
   * via the terminal execution path. Persisted so a gateway restart can reattach
   * to the live tmux session instead of abandoning the run. See
   * {@link SubagentRunRecord.terminalId}.
   */
  terminalId?: string;
  /** Target agent id for a terminal-path spawn (used by recovery reattach). */
  agentId?: string;
}) {
  const now = Date.now();
  const cfg = loadConfig();
  const archiveAfterMs = resolveArchiveAfterMs(cfg);
  const archiveAtMs = archiveAfterMs ? now + archiveAfterMs : undefined;
  const waitTimeoutMs = resolveSubagentWaitTimeoutMs(cfg, params.runTimeoutSeconds);
  // Deadline past which the sweeper auto-times the run out. We give the
  // run its full wait window + a grace period so a slow-but-progressing
  // agent isn't killed before it can finish.
  const stuckBaseMs = Math.max(waitTimeoutMs, STUCK_DEFAULT_MS);
  const expectedEndByMs = now + stuckBaseMs + STUCK_GRACE_MS;
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const entry: SubagentRunRecord = {
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterOrigin,
    requesterDisplayKey: params.requesterDisplayKey,
    task: params.task,
    cleanup: params.cleanup,
    label: params.label,
    createdAt: now,
    startedAt: now,
    archiveAtMs,
    cleanupHandled: false,
    expectedEndByMs,
    terminalId: params.terminalId,
    // Derive the tmux session name the SAME way the tmux backend does, so the
    // record's stored name matches what `hasLiveSessionSync` checks. Written now
    // — at register time, independent of any CLI session id — so recovery keys on
    // a durable value even for a run that dies at 0 tokens.
    tmuxSession: params.terminalId ? tmuxSessionName(params.terminalId) : undefined,
    agentId: params.agentId,
  };
  subagentRuns.set(params.runId, entry);
  ensureListener();
  persistSubagentRuns();

  // Non-blocking: emit a work-activity event for this run starting.
  emitSubagentStarted({
    runId: params.runId,
    label: params.label,
    task: params.task,
    projectId: params.projectId,
  });

  // Push the same fact onto the gateway WS so the Activity page's
  // <subagent-activity-panel> refetches immediately instead of waiting
  // for its 3s poll. Without this, freshly spawned runs lag behind
  // kanban/notification surfaces.
  broadcastSubagentLifecycle("subagent.spawned", {
    runId: params.runId,
    sessionKey: params.childSessionKey,
    label: params.label,
    task: params.task,
    requesterSessionKey: params.requesterSessionKey,
    startedAt: now,
    ts: now,
  });

  // Always run the sweeper now that we also use it for stuck-run
  // detection — not just archive cleanup. Idempotent.
  startSweeper();
  // Replay any lifecycle events that landed before this register call
  // resolved. Drains the per-run pending queue.
  drainPendingLifecycle(entry);

  // Initialize progress tracking for real-time status updates
  initProgressTracking({
    runId: params.runId,
    sessionKey: params.childSessionKey,
    label: params.label,
    task: params.task,
    requesterSessionKey: params.requesterSessionKey,
    requesterOrigin,
  });

  // Auto-create kanban task for this subagent run. Resolve project first so
  // related runs condense into one project rather than each spawning their own.
  void (async () => {
    let projectId = params.projectId;
    if (!projectId && params.projectHint) {
      const resolved = await findOrCreateProject(params.projectHint, {
        description: `Auto-created from sub-agent run: ${params.label || params.task}`.slice(
          0,
          1500,
        ),
      });
      if (resolved) projectId = resolved.projectId;
    }
    const result = await mcpCreateTask({
      title: (params.label || params.task).slice(0, 120),
      projectId,
      status: "in_progress",
      assignee: params.childSessionKey.split(":")[1] || "agent",
      priority: "medium",
    });
    if (result?.id) {
      const entry = subagentRuns.get(params.runId);
      if (entry) {
        entry.kanbanTaskId = result.id;
        persistSubagentRuns();
      }
    }
  })().catch((err) => {
    log.warn("kanban auto-task creation failed for subagent run", {
      runId: params.runId,
      err: err instanceof Error ? err.message : String(err),
    });
  });

  // Wait for subagent completion via gateway RPC (cross-process).
  // The in-process lifecycle listener is a fallback for embedded runs.
  void waitForSubagentCompletion(params.runId, waitTimeoutMs);
}

/**
 * FIX A — Lightweight registration for claude-coder-tool spawns.
 *
 * `claude-coder-tool.ts` manages its own kanban tasks, progress tracking, and
 * completion lifecycle. This function persists the run to the registry (so it
 * survives a gateway restart) without duplicating those side-effects.
 *
 * Call immediately after `spawnBackground` succeeds so the PID is available.
 * Follow with `updateSubagentRunClaudeSessionId` once the session_id is known
 * (from stream-json output) and `markSubagentRunComplete` when the run ends.
 *
 * Runtime assertion: if a run is still in-flight 10s after `initProgressTracking`
 * was called without a corresponding registry entry, we emit a warning. This
 * makes accidental bypass visible in logs without crashing.
 */
export function registerSubagentRunForCoder(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  requesterDisplayKey: string;
  task: string;
  label?: string;
  kanbanTaskId?: string;
  childPid?: number;
  timeoutMinutes?: number;
  requesterOrigin?: DeliveryContext;
  workdir?: string;
  coderBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
  /** Per-attempt launch trail when a backend fallback was involved. */
  coderBackendAttempts?: Array<{
    backend: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
    ok: boolean;
    error?: string;
    exitCode?: number | null;
  }>;
  /** Backend that failed to start before this run fell back, if any. */
  fallbackFromBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
  /** When this is a respawn, the runId of the failed run it descends from. */
  respawnOfRunId?: string;
  /**
   * Set when the CLI was launched inside a detached tmux session. Carries the
   * durable recovery key (`terminalId` → `tmuxSession`) so a restart can
   * reattach instead of killing/respawning.
   */
  durableSpawn?: "tmux-coder";
  terminalId?: string;
}): void {
  const now = Date.now();
  const cfg = loadConfig();
  const archiveAfterMs = resolveArchiveAfterMs(cfg);
  const archiveAtMs = archiveAfterMs ? now + archiveAfterMs : undefined;
  const timeoutMs = (params.timeoutMinutes ?? 30) * 60_000;
  const stuckBaseMs = Math.max(timeoutMs, STUCK_DEFAULT_MS);
  const expectedEndByMs = now + stuckBaseMs + STUCK_GRACE_MS;
  const requesterOrigin = normalizeDeliveryContext(params.requesterOrigin);
  const entry: SubagentRunRecord = {
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterOrigin,
    requesterDisplayKey: params.requesterDisplayKey,
    task: params.task,
    label: params.label,
    cleanup: "delete",
    createdAt: now,
    startedAt: now,
    archiveAtMs,
    cleanupHandled: false,
    expectedEndByMs,
    kanbanTaskId: params.kanbanTaskId,
    childPid: params.childPid,
    workdir: params.workdir,
    coderBackend: params.coderBackend,
    coderBackendAttempts: params.coderBackendAttempts,
    fallbackFromBackend: params.fallbackFromBackend,
    respawnOfRunId: params.respawnOfRunId,
    durableSpawn: params.durableSpawn,
    terminalId: params.terminalId,
    tmuxSession: params.terminalId ? tmuxSessionName(params.terminalId) : undefined,
  };
  subagentRuns.set(params.runId, entry);
  ensureListener();
  persistSubagentRuns();
  startSweeper();
  drainPendingLifecycle(entry);
  log.info("registerSubagentRunForCoder: run persisted to registry", {
    runId: params.runId,
    childPid: params.childPid,
    hasKanbanTask: Boolean(params.kanbanTaskId),
    durableSpawn: params.durableSpawn,
    tmuxSession: entry.tmuxSession,
  });
}

/**
 * FIX A — Update the Claude Code session ID for a coder run.
 * Call when the first `system:init` NDJSON event is parsed from stdout.
 */
export function updateSubagentRunClaudeSessionId(runId: string, sessionId: string): void {
  const entry = subagentRuns.get(runId);
  if (!entry || entry.claudeSessionId) return;
  entry.claudeSessionId = sessionId;
  persistSubagentRuns();
}

/**
 * Cache (or update) the Spec-vs-Result oversight analysis on a run record.
 * Returns true when the record existed and was updated. Live runs only —
 * archived runs are recomputed on demand since their full record is gone.
 */
export function updateSubagentRunSpecAnalysis(
  runId: string,
  analysis: Record<string, unknown>,
): boolean {
  const entry = subagentRuns.get(runId);
  if (!entry) return false;
  entry.specAnalysis = analysis;
  persistSubagentRuns();
  return true;
}

/**
 * Persist the resolved transcript file path on the live run record.
 * Called by the coder tool once the transcript context resolves (async, best-effort).
 */
export function updateSubagentRunTranscriptPath(runId: string, transcriptPath: string): void {
  const entry = subagentRuns.get(runId);
  if (!entry) return;
  entry.transcriptPath = transcriptPath;
  persistSubagentRuns();
}

/**
 * Attach the work-review pipeline result to a run record so the kanban card
 * chip can render the verdict and link to the canvas.
 */
export function updateSubagentRunWorkReview(
  runId: string,
  review: { canvasId?: string; verdict?: string; emittedAt: number },
): boolean {
  const entry = subagentRuns.get(runId);
  if (!entry) return false;
  entry.workReview = review;
  persistSubagentRuns();
  return true;
}

/**
 * FIX A — Mark a coder run as completed in the registry.
 * Called by claude-coder-tool's `finishKanban` so the registry reflects the
 * true terminal state and the sweeper doesn't later misidentify it as stuck.
 */
export function markSubagentRunComplete(
  runId: string,
  outcome: { status: "ok" | "error"; error?: string },
  endedAt?: number,
): void {
  const entry = subagentRuns.get(runId);
  if (!entry) return;
  if (entry.endedAt) return; // already completed — idempotent
  entry.endedAt = endedAt ?? Date.now();
  entry.outcome = outcome;
  persistSubagentRuns();
  // Archive the run and broadcast the lifecycle event so the history feed
  // updates in real time. finishKanban already handled kanban + progress;
  // triggerCleanupForEntry is idempotent via beginSubagentCleanup.
  triggerCleanupForEntry(entry);
}

async function waitForSubagentCompletion(runId: string, waitTimeoutMs: number) {
  try {
    const timeoutMs = Math.max(1, Math.floor(waitTimeoutMs));
    const wait = (await callGateway({
      method: "agent.wait",
      params: {
        runId,
        timeoutMs,
      },
      timeoutMs: timeoutMs + 10_000,
    })) as { status?: string; startedAt?: number; endedAt?: number; error?: string };
    if (wait?.status !== "ok" && wait?.status !== "error") return;
    const entry = subagentRuns.get(runId);
    if (!entry) return;
    let mutated = false;
    if (typeof wait.startedAt === "number") {
      entry.startedAt = wait.startedAt;
      mutated = true;
    }
    if (typeof wait.endedAt === "number") {
      entry.endedAt = wait.endedAt;
      mutated = true;
    }
    if (!entry.endedAt) {
      entry.endedAt = Date.now();
      mutated = true;
    }
    entry.outcome =
      wait.status === "error" ? { status: "error", error: wait.error } : { status: "ok" };
    mutated = true;
    if (mutated) persistSubagentRuns();
    if (!beginSubagentCleanup(runId)) return;
    const requesterOrigin = normalizeDeliveryContext(entry.requesterOrigin);
    void runSubagentAnnounceFlow({
      childSessionKey: entry.childSessionKey,
      childRunId: entry.runId,
      requesterSessionKey: entry.requesterSessionKey,
      requesterOrigin,
      requesterDisplayKey: entry.requesterDisplayKey,
      task: entry.task,
      timeoutMs: 30_000,
      cleanup: entry.cleanup,
      waitForCompletion: false,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      label: entry.label,
      outcome: entry.outcome,
    }).then((didAnnounce) => {
      finalizeSubagentCleanup(runId, entry.cleanup, didAnnounce);
    });
  } catch (err) {
    log.warn("waitForSubagentCompletion failed", {
      runId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * FIX D — Graceful shutdown: mark all in-flight runs as interrupted.
 *
 * Called by the gateway close handler before the process exits. For each run
 * without an `endedAt`, sets `interruptedAt` and — for LEGACY direct-child runs
 * only — sends SIGTERM to its child process. Persists to disk so the next boot
 * sees the interrupted state and can attempt recovery via `resumeSubagentRun`.
 *
 * DURABLE RUNS ARE NEVER KILLED. A run whose CLI lives inside a tmux session
 * (`durableSpawn === "tmux-coder"`, or a terminal-path run with a live
 * `terminalId` session) is deliberately left running: the tmux server is owned
 * by init, not by us, so the sub-agent works straight through the restart and
 * `resumeSubagentRun` reattaches to it on the next boot. Killing it here is the
 * exact bug this path exists to avoid — SIGTERM'ing the tmux *pane* pid would
 * destroy the very work tmux was chosen to protect. We only mark state.
 *
 * Intentionally synchronous-safe (persist is sync via saveJsonFile).
 */
export function interruptAllSubagentRuns(): void {
  const now = Date.now();
  let interrupted = 0;
  let preserved = 0;
  for (const entry of subagentRuns.values()) {
    if (entry.endedAt) continue;
    if (entry.cleanupHandled) continue;
    const durable = isDurableSubagentRun(entry);
    entry.interruptedAt = now;
    // Only legacy runs get a `run.ended` ledger event: the ledger replay treats
    // that as terminal, and a durable run has NOT ended — it is still working
    // inside tmux and must replay as in-flight on the next boot.
    if (!durable) {
      appendSpawnEvent({
        v: 1,
        ts: now,
        event: "run.ended",
        runId: entry.runId,
        outcome: "interrupted",
        durationMs: entry.startedAt ? now - entry.startedAt : undefined,
      });
    }
    if (durable) {
      preserved++;
      log.info("interruptAllSubagentRuns: preserving durable run (tmux session left alive)", {
        runId: entry.runId,
        tmuxSession: entry.tmuxSession,
        terminalId: entry.terminalId,
      });
      interrupted++;
      continue;
    }
    if (entry.childPid) {
      try {
        process.kill(entry.childPid, "SIGTERM");
        log.info("interruptAllSubagentRuns: sent SIGTERM to child", {
          runId: entry.runId,
          childPid: entry.childPid,
        });
      } catch {
        // PID already gone — ignore
      }
    }
    interrupted++;
  }
  if (interrupted > 0) {
    persistSubagentRuns();
    log.info("interruptAllSubagentRuns: marked runs as interrupted", { interrupted, preserved });
  }
}

/**
 * True when this run's process tree lives inside a tmux session that outlives
 * the gateway — either a durable coder spawn or a terminal-path spawn whose
 * session is still live. Such runs must never be SIGTERM'd on shutdown.
 *
 * Errs on the side of "durable" for records flagged `durableSpawn` even when
 * the liveness probe fails: a false positive only skips a kill for a process
 * that is already gone, whereas a false negative kills live work.
 */
export function isDurableSubagentRun(entry: SubagentRunRecord): boolean {
  if (process.platform === "win32") return false;
  if (entry.durableSpawn === "tmux-coder") return true;
  return Boolean(entry.terminalId) && hasLiveSessionSync(entry.terminalId as string);
}

export function resetSubagentRegistryForTests() {
  subagentRuns.clear();
  resumedRuns.clear();
  pendingLifecycleEvents.clear();
  lastPendingPruneAt = 0;
  durableSettling.clear();
  stopSweeper();
  restoreAttempted = false;
  if (listenerStop) {
    listenerStop();
    listenerStop = null;
  }
  listenerStarted = false;
  persistSubagentRuns();
}

/** Test-only — peek at the orphan-event queue for assertions. */
export function getPendingLifecycleRunCountForTests(): number {
  return pendingLifecycleEvents.size;
}

export function getPendingLifecycleQueueSizeForTests(runId: string): number {
  return pendingLifecycleEvents.get(runId)?.length ?? 0;
}

/** Test-only — trigger the sweeper once without waiting for the interval. */
export async function runSweepForTests(): Promise<void> {
  await sweepSubagentRuns();
}

/** Test-only — read-only view of a run record. */
export function getRunForTests(runId: string): SubagentRunRecord | undefined {
  return subagentRuns.get(runId);
}

/** Test-only — drive the restart recovery path for a single run. */
export function resumeRunForTests(runId: string) {
  resumeSubagentRun(runId);
}

export function addSubagentRunForTests(entry: SubagentRunRecord) {
  subagentRuns.set(entry.runId, entry);
  persistSubagentRuns();
}

export function releaseSubagentRun(runId: string) {
  const didDelete = subagentRuns.delete(runId);
  if (didDelete) persistSubagentRuns();
  if (subagentRuns.size === 0) stopSweeper();
}

export function listSubagentRunsForRequester(requesterSessionKey: string): SubagentRunRecord[] {
  const key = requesterSessionKey.trim();
  if (!key) return [];
  return [...subagentRuns.values()].filter((entry) => entry.requesterSessionKey === key);
}

/** Every run currently tracked by the registry (live + recently-ended-but-not-archived). */
export function listAllSubagentRuns(): SubagentRunRecord[] {
  return [...subagentRuns.values()];
}

/**
 * True while a run is still in flight: it has started, hasn't ended or been
 * interrupted, and has no terminal outcome yet. Used by the release-publisher
 * daemon to decide whether coder work is still mutating the tree.
 */
export function isSubagentRunActive(entry: SubagentRunRecord): boolean {
  return (
    entry.startedAt != null &&
    entry.endedAt == null &&
    entry.outcome == null &&
    entry.interruptedAt == null
  );
}

/** In-flight runs only (see {@link isSubagentRunActive}). */
export function listActiveSubagentRuns(): SubagentRunRecord[] {
  return [...subagentRuns.values()].filter(isSubagentRunActive);
}

export function getSubagentRun(runId: string): SubagentRunRecord | undefined {
  return subagentRuns.get(runId);
}

export function getSubagentRunBySessionKey(sessionKey: string): SubagentRunRecord | undefined {
  for (const run of subagentRuns.values()) {
    if (run.childSessionKey === sessionKey) return run;
  }
  return undefined;
}

export function setSubagentLineage(
  runId: string,
  lineage: {
    parentGoalId: string;
    parentGoalIterationIndex: number;
    parentGoalTitle: string;
  },
): void {
  const entry = subagentRuns.get(runId);
  if (!entry) return;
  entry.parentGoalId = lineage.parentGoalId;
  entry.parentGoalIterationIndex = lineage.parentGoalIterationIndex;
  entry.parentGoalTitle = lineage.parentGoalTitle;
  persistSubagentRuns();
}

export function listSubagentRunsByGoalId(goalId: string): SubagentRunRecord[] {
  const key = goalId.trim();
  if (!key) return [];
  return [...subagentRuns.values()].filter((entry) => entry.parentGoalId === key);
}

/**
 * Look up the most-recent live registry run linked to a kanban task. Used by
 * the recently-completed feed so clicking a finished task in the grid
 * activity panel opens the same focus modal as clicking a subagent.
 */
export function getSubagentRunByKanbanTaskId(kanbanTaskId: string): SubagentRunRecord | undefined {
  if (!kanbanTaskId) return undefined;
  let best: SubagentRunRecord | undefined;
  for (const entry of subagentRuns.values()) {
    if (entry.kanbanTaskId !== kanbanTaskId) continue;
    if (!best || (entry.endedAt ?? entry.startedAt ?? 0) > (best.endedAt ?? best.startedAt ?? 0)) {
      best = entry;
    }
  }
  return best;
}

const PATH_SKIP_RE =
  /node_modules[\\/]|[\\/]\.git[\\/]|[\\/]dist[\\/]|[\\/]build[\\/]|\/\.cache\/|\/\.ssh\/|\/secrets\//;

export function appendFileTouched(
  runId: string,
  path: string,
  action: "created" | "edited" | "deleted" | "read",
): void {
  if (!path || PATH_SKIP_RE.test(path)) return;
  const entry = subagentRuns.get(runId);
  if (!entry) return;
  if (!entry.filesTouched) entry.filesTouched = [];
  const MAX_FILES = 200;
  if (entry.filesTouched.length >= MAX_FILES) {
    entry.filesTouched.shift();
  }
  entry.filesTouched.push({ path, action, at: Date.now() });
  persistSubagentRuns();
}

export function initSubagentRegistry() {
  restoreSubagentRunsOnce();
}

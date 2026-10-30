/**
 * Sub-Agent Progress Tracking System
 *
 * Enables sub-agents to report progress updates and checkpoints
 * during execution, with real-time notifications to requester.
 */

import { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
import { createApprovalRequest, resolveApprovalRequest } from "../autonomy/approval-registry.js";
import { broadcastSubagentCheckpoint } from "./coder-runtime/subagent-broadcast.js";

const log = createSubsystemLogger("agents/subagent-progress");

export type ProgressStatus = "starting" | "working" | "checkpoint" | "blocked" | "finishing";

export type ProgressUpdate = {
  runId: string;
  sessionKey: string;
  status: ProgressStatus;
  message: string;
  progress?: number; // 0-100 percentage
  checkpoint?: string; // Named checkpoint for tracking
  details?: Record<string, unknown>;
  timestamp: number;
};

/**
 * Lightweight "what is the agent doing right now" signal, separate from the
 * coarse-grained `updates[]` checkpoints. Updated on every parsed tool-call
 * event from the Claude Code stream-json output so the UI can show a live
 * "Reading src/foo.ts · 4s ago" tail without polluting the checkpoint log.
 */
export type LastActivity = {
  /** Tool name (e.g. "Read", "Bash", "Edit") or event kind ("assistant"). */
  kind: string;
  /** Short human-readable summary ("Read src/foo.ts", "Bash: ls -la"). */
  label: string;
  /** When this activity was observed. */
  at: number;
  /**
   * Coder backend that produced this activity, when applicable.
   * "claude-code" | "opencode" | "codex" | "gemini" | "grok".
   */
  coderBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
};

export type SubagentProgressRecord = {
  runId: string;
  sessionKey: string;
  label?: string;
  task: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  status: ProgressStatus;
  progress: number;
  currentCheckpoint?: string;
  checkpoints: string[];
  updates: ProgressUpdate[];
  createdAt: number;
  lastUpdateAt: number;
  /** Last fine-grained activity. Refreshed on each tool call. */
  lastActivity?: LastActivity;
};

// In-memory progress store (complements subagent-registry)
const progressStore = new Map<string, SubagentProgressRecord>();

// Event listeners for real-time updates
type ProgressListener = (update: ProgressUpdate, record: SubagentProgressRecord) => void;
const listeners = new Set<ProgressListener>();

export function onProgressUpdate(listener: ProgressListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners(update: ProgressUpdate, record: SubagentProgressRecord) {
  for (const listener of listeners) {
    try {
      listener(update, record);
    } catch (err) {
      log.warn("Progress listener error", { error: err });
    }
  }
}

/**
 * Initialize progress tracking for a new sub-agent run
 */
export function initProgressTracking(params: {
  runId: string;
  sessionKey: string;
  label?: string;
  task: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
}): SubagentProgressRecord {
  const now = Date.now();
  const record: SubagentProgressRecord = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    label: params.label,
    task: params.task,
    requesterSessionKey: params.requesterSessionKey,
    requesterOrigin: params.requesterOrigin,
    status: "starting",
    progress: 0,
    checkpoints: [],
    updates: [],
    createdAt: now,
    lastUpdateAt: now,
  };
  progressStore.set(params.runId, record);

  const update: ProgressUpdate = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    status: "starting",
    message: `Starting: ${params.label || params.task.slice(0, 50)}`,
    progress: 0,
    timestamp: now,
  };
  record.updates.push(update);
  notifyListeners(update, record);

  return record;
}

/**
 * Find progress record by sessionKey
 */
export function findProgressBySessionKey(sessionKey: string): SubagentProgressRecord | undefined {
  return [...progressStore.values()].find((r) => r.sessionKey === sessionKey);
}

/** Returns true if a run with this ID is currently tracked (used for collision detection). */
export function hasProgressRun(runId: string): boolean {
  return progressStore.has(runId);
}

/**
 * Record a fine-grained activity (tool call, assistant text turn). Does NOT
 * append to updates[] or notify listeners — this fires on every tool event
 * and would otherwise drown the checkpoint log. Polled clients read
 * lastActivity off the record directly.
 */
export function recordActivity(params: {
  runId?: string;
  sessionKey: string;
  kind: string;
  label: string;
  coderBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
}): void {
  const record = params.runId
    ? (progressStore.get(params.runId) ?? findProgressBySessionKey(params.sessionKey))
    : findProgressBySessionKey(params.sessionKey);
  if (!record) return;
  const now = Date.now();
  record.lastActivity = {
    kind: params.kind,
    label: params.label,
    at: now,
    coderBackend: params.coderBackend,
  };
  record.lastUpdateAt = now;
}

/**
 * Report progress update from a sub-agent
 */
export async function reportProgress(params: {
  runId?: string;
  sessionKey: string;
  status: ProgressStatus;
  message: string;
  progress?: number;
  checkpoint?: string;
  details?: Record<string, unknown>;
  notifyRequester?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  // Try runId first if provided
  if (params.runId) {
    const record = progressStore.get(params.runId);
    if (record) {
      return reportProgressInternal(record, params);
    }
  }

  // Fall back to sessionKey lookup
  const bySession = findProgressBySessionKey(params.sessionKey);
  if (bySession) {
    return reportProgressInternal(bySession, params);
  }

  // Auto-initialize progress tracking if this looks like a subagent session
  if (params.sessionKey.includes(":subagent:")) {
    const autoRecord = initProgressTracking({
      runId: params.runId || `auto-${Date.now()}`,
      sessionKey: params.sessionKey,
      task: "In-progress task",
      requesterSessionKey: "unknown",
    });
    return reportProgressInternal(autoRecord, params);
  }

  return { ok: false, error: "No progress tracking found for this session" };
}

async function reportProgressInternal(
  record: SubagentProgressRecord,
  params: {
    status: ProgressStatus;
    message: string;
    progress?: number;
    checkpoint?: string;
    details?: Record<string, unknown>;
    notifyRequester?: boolean;
  },
): Promise<{ ok: boolean; error?: string }> {
  const now = Date.now();
  const update: ProgressUpdate = {
    runId: record.runId,
    sessionKey: record.sessionKey,
    status: params.status,
    message: params.message,
    progress: params.progress,
    checkpoint: params.checkpoint,
    details: params.details,
    timestamp: now,
  };

  // Update record
  record.status = params.status;
  record.lastUpdateAt = now;
  if (typeof params.progress === "number") {
    record.progress = Math.max(0, Math.min(100, params.progress));
  }
  if (params.checkpoint && !record.checkpoints.includes(params.checkpoint)) {
    record.checkpoints.push(params.checkpoint);
    record.currentCheckpoint = params.checkpoint;
  }
  record.updates.push(update);

  // Keep only last 50 updates to prevent memory bloat
  if (record.updates.length > 50) {
    record.updates = record.updates.slice(-50);
  }

  notifyListeners(update, record);

  // Optionally notify the requester session
  if (params.notifyRequester !== false && record.requesterSessionKey) {
    try {
      await notifyRequesterOfProgress(record, update);
    } catch (err) {
      log.warn("Failed to notify requester of progress", {
        runId: record.runId,
        error: err,
      });
    }
  }

  return { ok: true };
}

/**
 * Send progress notification to requester
 */
async function notifyRequesterOfProgress(record: SubagentProgressRecord, update: ProgressUpdate) {
  const statusEmoji =
    {
      starting: "🚀",
      working: "⚙️",
      checkpoint: "✅",
      blocked: "⚠️",
      finishing: "🏁",
    }[update.status] || "📊";

  const progressBar = update.progress !== undefined ? `[${Math.round(update.progress)}%]` : "";

  const message = `${statusEmoji} **${record.label || "Sub-Agent"}** ${progressBar}\n${update.message}`;

  // Use gateway wake to inject a system event
  await callGateway({
    method: "gateway.wake",
    params: {
      sessionKey: record.requesterSessionKey,
      text: message,
      source: "subagent-progress",
      metadata: {
        runId: record.runId,
        sessionKey: record.sessionKey,
        status: update.status,
        progress: update.progress,
        checkpoint: update.checkpoint,
      },
    },
    timeoutMs: 5000,
  });
}

/**
 * Get progress record for a run
 */
export function getProgress(runId: string): SubagentProgressRecord | undefined {
  return progressStore.get(runId);
}

/**
 * How long a "finishing" record stays visible in listActiveProgress() after
 * completeProgress() is called. Must be longer than the poll interval so
 * the UI can show the completed card before it fades. 10 minutes gives a
 * comfortable grace window for the card to transition to "Done" in the UI.
 */
const COMPLETED_VISIBLE_MS = 10 * 60_000;

/**
 * Get all active progress records
 */
export function listActiveProgress(): SubagentProgressRecord[] {
  return [...progressStore.values()].filter(
    (r) => r.status !== "finishing" || Date.now() - r.lastUpdateAt < COMPLETED_VISIBLE_MS,
  );
}

/**
 * Get progress for a specific requester
 */
export function listProgressForRequester(requesterSessionKey: string): SubagentProgressRecord[] {
  return [...progressStore.values()].filter((r) => r.requesterSessionKey === requesterSessionKey);
}

/**
 * Mark a run as complete and clean up
 */
export function completeProgress(runId: string, finalMessage?: string) {
  const record = progressStore.get(runId);
  if (!record) return;

  const now = Date.now();
  record.status = "finishing";
  record.progress = 100;
  record.lastUpdateAt = now;

  const update: ProgressUpdate = {
    runId: record.runId,
    sessionKey: record.sessionKey,
    status: "finishing",
    message: finalMessage || "Task completed",
    progress: 100,
    timestamp: now,
  };
  record.updates.push(update);
  notifyListeners(update, record);

  import("../infra/work-completions.js")
    .then(({ emitWorkCompleted }) => {
      emitWorkCompleted({
        source: "agent",
        sourceId: record.runId,
        title: record.label ?? record.task,
        completedAt: now,
      });
    })
    .catch(() => {}); // silent

  // Clean up after 11 minutes — must exceed COMPLETED_VISIBLE_MS (10 min) so
  // the entry is still in the store during the full UI visibility window.
  setTimeout(() => {
    progressStore.delete(runId);
  }, 11 * 60_000);
}

/**
 * Clean up stale progress records
 */
export function cleanupStaleProgress(maxAgeMs: number = 30 * 60 * 1000) {
  const now = Date.now();
  for (const [runId, record] of progressStore.entries()) {
    if (now - record.lastUpdateAt > maxAgeMs) {
      progressStore.delete(runId);
    }
  }
}

// Periodic cleanup
setInterval(() => cleanupStaleProgress(), 10 * 60 * 1000);

// ════════════════════════════════════════════════════════════════════════════
// Mid-run check-in gates (checkpoints)
//
// ADDITIVE SECTION — coordinated with the other agent-focus-modal work (in-UI
// diff viewer + spec-vs-result). Nothing above this banner is modified.
//
// These structured "check-ins" are DISTINCT from the coarse ProgressStatus
// "checkpoint" above: each carries {summary (what just finished), next (what's
// about to happen), deviations[]} and is emitted on a cadence so long-running
// agents surface progress live instead of drifting silently. They are:
//   • persisted per-run with a timestamp + summary,
//   • broadcast as the `subagent.checkpoint` WS event (a new event KIND,
//     separate from regular progress),
//   • flagged for soft "drift suspected" when a check-in mentions an off-limits
//     file or looks like scope creep,
//   • optionally GATING: when a run is spawned with requireCheckpointApproval,
//     report_checkpoint blocks the agent until the user clicks
//     Approve / Redirect / Stop in the focus modal.
// ════════════════════════════════════════════════════════════════════════════

export type CheckpointDecision = "approve" | "redirect" | "stop";

export interface SubagentCheckpoint {
  /** Unique id within the run (used as the approval-decision key). */
  id: string;
  runId: string;
  sessionKey: string;
  /** What the agent just finished. */
  summary: string;
  /** What the agent is about to do next. */
  next: string;
  /** Deviations from the brief / scope the agent is flagging. */
  deviations: string[];
  ts: number;
  /** Server-computed soft-drift suspicion (off-limits file or scope creep). */
  driftSuspected: boolean;
  driftReasons: string[];
  /** True when this run requires explicit approval (strict drift gate). */
  gated: boolean;
  /** True while the agent is paused waiting for a decision on this check-in. */
  pending: boolean;
  /** Set once the user (or the timeout) resolves a gated check-in. */
  decision?: CheckpointDecision;
  /** User-edited next-step plan supplied with a "redirect" decision. */
  editedNext?: string;
  /** Optional free-text note attached to the decision. */
  note?: string;
  decidedAt?: number;
  /** Unified approval-registry id (gated check-ins → Telegram / UI inbox). */
  approvalId?: string;
}

interface RunCheckpointConfig {
  runId: string;
  sessionKey: string;
  /** Strict gate: report_checkpoint pauses the agent until approval. */
  requireApproval: boolean;
  /** Off-limits path fragments used for soft drift detection (never mutated). */
  offLimits: string[];
  /** Gated check-in expiry (expiry = stop). */
  approvalTimeoutMs?: number;
}

/** runId → ordered list of check-ins. */
const checkpointStore = new Map<string, SubagentCheckpoint[]>();
/** sessionKey → config (the report_checkpoint tool only knows its sessionKey). */
const checkpointConfigBySession = new Map<string, RunCheckpointConfig>();
const checkpointConfigByRun = new Map<string, RunCheckpointConfig>();

type CheckpointResolution = {
  decision: CheckpointDecision;
  editedNext?: string;
  note?: string;
};
type PendingApproval = {
  runId: string;
  resolve: (r: CheckpointResolution) => void;
  timer: ReturnType<typeof setTimeout> | null;
};
/** checkpointId → pending approval resolver (the gate the agent is blocked on). */
const pendingApprovals = new Map<string, PendingApproval>();

/**
 * How long a gated check-in waits for the operator. Bounded so a forgotten run
 * can never hang forever — and, like every approval, expiry NEVER approves: it
 * resolves as "stop" so the agent winds down instead of proceeding unreviewed.
 * Override per run via registerCheckpointConfig({approvalTimeoutMs}) (spawn
 * reads approvals.checkpointTimeoutMinutes).
 */
const CHECKPOINT_APPROVAL_TIMEOUT_MS = 30 * 60_000;
const MAX_CHECKPOINTS_PER_RUN = 100;

type CheckpointListener = (cp: SubagentCheckpoint) => void;
const checkpointListeners = new Set<CheckpointListener>();

export function onCheckpoint(listener: CheckpointListener): () => void {
  checkpointListeners.add(listener);
  return () => checkpointListeners.delete(listener);
}

function notifyCheckpointListeners(cp: SubagentCheckpoint): void {
  for (const listener of checkpointListeners) {
    try {
      listener(cp);
    } catch (err) {
      log.warn("Checkpoint listener error", { error: err });
    }
  }
}

/**
 * Register per-run checkpoint behaviour at spawn time. Called from
 * claude-coder-tool.ts right after initProgressTracking so the report_checkpoint
 * tool (which only knows its own sessionKey) can resolve the run's gate mode and
 * off-limits list.
 */
export function registerCheckpointConfig(params: {
  runId: string;
  sessionKey: string;
  requireApproval?: boolean;
  offLimits?: string[];
  approvalTimeoutMs?: number;
}): void {
  const cfg: RunCheckpointConfig = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    requireApproval: params.requireApproval === true,
    approvalTimeoutMs:
      typeof params.approvalTimeoutMs === "number" && params.approvalTimeoutMs > 0
        ? params.approvalTimeoutMs
        : undefined,
    offLimits: (params.offLimits ?? []).filter((s) => typeof s === "string" && s.trim().length > 0),
  };
  checkpointConfigBySession.set(params.sessionKey, cfg);
  checkpointConfigByRun.set(params.runId, cfg);
}

function resolveCheckpointConfig(opts: {
  runId?: string;
  sessionKey?: string;
}): RunCheckpointConfig | undefined {
  if (opts.sessionKey) {
    const bySession = checkpointConfigBySession.get(opts.sessionKey);
    if (bySession) return bySession;
  }
  if (opts.runId) {
    const byRun = checkpointConfigByRun.get(opts.runId);
    if (byRun) return byRun;
  }
  // Fall back to the progress record so a checkpoint can still be attributed to
  // the right runId even when no explicit config was registered.
  return undefined;
}

const SCOPE_CREEP_RE =
  /\b(rewrit\w+|overhaul\w*|re-?architect\w*|migrat\w+ (the )?(whole|entire|all)|delet\w+ (everything|all|the entire)|replac\w+ (the )?(whole|entire) (system|architecture|codebase)|from scratch|ground.?up|brand.?new (system|architecture))\b/i;

function detectDrift(
  fields: { summary: string; next: string; deviations: string[] },
  offLimits: string[],
): { suspected: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (fields.deviations.length > 0) {
    reasons.push("Agent flagged a deviation from the brief");
  }
  const haystack = `${fields.summary}\n${fields.next}\n${fields.deviations.join("\n")}`;
  const lowerHay = haystack.toLowerCase();
  for (const frag of offLimits) {
    const f = frag.trim().toLowerCase();
    if (f && lowerHay.includes(f)) {
      reasons.push(`Mentions off-limits path: ${frag}`);
    }
  }
  const creep = haystack.match(SCOPE_CREEP_RE);
  if (creep) {
    reasons.push(`Possible scope creep: “${creep[0]}”`);
  }
  return { suspected: reasons.length > 0, reasons };
}

let checkpointSeq = 0;
function nextCheckpointId(runId: string): string {
  checkpointSeq += 1;
  return `cp-${runId.slice(0, 12)}-${Date.now().toString(36)}-${checkpointSeq}`;
}

/**
 * Record a mid-run check-in. Persists it, broadcasts the `subagent.checkpoint`
 * WS event, runs soft-drift detection, and — when the run is gated — returns a
 * `wait` promise that resolves only once the user (or the timeout) issues a
 * decision. The report_checkpoint tool awaits that promise to PAUSE the agent.
 */
export function recordCheckpoint(params: {
  runId?: string;
  sessionKey: string;
  summary: string;
  next: string;
  deviations?: string[];
}): { checkpoint: SubagentCheckpoint; wait?: Promise<CheckpointResolution> } {
  const cfg = resolveCheckpointConfig({ runId: params.runId, sessionKey: params.sessionKey });
  // Resolve the runId: explicit param → config → progress record by session.
  const record = findProgressBySessionKey(params.sessionKey);
  const runId = params.runId || cfg?.runId || record?.runId || params.sessionKey;
  const offLimits = cfg?.offLimits ?? [];
  const gated = cfg?.requireApproval === true;

  const deviations = (params.deviations ?? [])
    .filter((d) => typeof d === "string" && d.trim().length > 0)
    .map((d) => d.trim());
  const drift = detectDrift({ summary: params.summary, next: params.next, deviations }, offLimits);

  const cp: SubagentCheckpoint = {
    id: nextCheckpointId(runId),
    runId,
    sessionKey: params.sessionKey,
    summary: params.summary.trim(),
    next: params.next.trim(),
    deviations,
    ts: Date.now(),
    driftSuspected: drift.suspected,
    driftReasons: drift.reasons,
    gated,
    pending: gated,
  };

  const list = checkpointStore.get(runId) ?? [];
  list.push(cp);
  if (list.length > MAX_CHECKPOINTS_PER_RUN) list.splice(0, list.length - MAX_CHECKPOINTS_PER_RUN);
  checkpointStore.set(runId, list);

  // Mirror a coarse progress update so polled surfaces / the respawn preamble
  // still see the milestone even if they don't read the checkpoint feed.
  if (record) {
    record.lastUpdateAt = cp.ts;
  }

  // Broadcast a distinct event KIND so the focus modal's Check-ins feed and the
  // bell badge update live without waiting for a poll.
  try {
    broadcastSubagentCheckpoint({
      runId,
      sessionKey: params.sessionKey,
      checkpointId: cp.id,
      summary: cp.summary,
      next: cp.next,
      deviations: cp.deviations,
      driftSuspected: cp.driftSuspected,
      driftReasons: cp.driftReasons,
      gated: cp.gated,
      pending: cp.pending,
      ts: cp.ts,
    });
  } catch {
    /* best-effort */
  }
  notifyCheckpointListeners(cp);

  log.info("subagent checkpoint recorded", {
    runId,
    gated,
    driftSuspected: cp.driftSuspected,
    deviations: cp.deviations.length,
  });

  if (!gated) return { checkpoint: cp };

  // Strict gate: hand the tool a promise that only resolves on an operator
  // decision (or expiry → stop). This is what actually pauses the agent. The
  // gate is a unified approval request, so it reaches Telegram + the web
  // approvals inbox as well as the focus modal; whichever surface answers
  // first wins (decideCheckpoint and the registry resolve each other).
  const wait = new Promise<CheckpointResolution>((resolve) => {
    pendingApprovals.set(cp.id, { runId, resolve, timer: null });
  });
  const label = record?.label || record?.task?.slice(0, 80) || runId.slice(0, 12);
  const detailLines = [`NEXT: ${cp.next}`];
  if (cp.deviations.length)
    detailLines.push("", "DEVIATIONS:", ...cp.deviations.map((d) => `- ${d}`));
  if (cp.driftReasons.length)
    detailLines.push("", "DRIFT:", ...cp.driftReasons.map((d) => `- ${d}`));
  const approval = createApprovalRequest({
    source: "subagent-checkpoint",
    title: `Check-in: ${label}`,
    summary: cp.summary,
    details: detailLines.join("\n"),
    risk: cp.driftSuspected ? "high" : "medium",
    options: ["approve", "deny", "redirect"],
    requester: { sessionKey: params.sessionKey, runId, label },
    sourceRef: { runId, checkpointId: cp.id },
    timeoutMs: cfg?.approvalTimeoutMs ?? CHECKPOINT_APPROVAL_TIMEOUT_MS,
    // The blocked tool call dies with the gateway, so don't resume after a restart.
    resumable: false,
    onResolve: (rec) => {
      const decision: CheckpointDecision =
        rec.status === "approved" ? "approve" : rec.status === "redirected" ? "redirect" : "stop";
      const expired = rec.decidedVia === "system";
      decideCheckpoint({
        runId,
        checkpointId: cp.id,
        decision,
        editedNext: decision === "redirect" ? (rec.note ?? undefined) : undefined,
        note: expired
          ? `No operator response before expiry (${rec.reason ?? "expired"}) — stopping for safety`
          : (rec.note ?? undefined),
        fromApproval: true,
      });
    },
  });
  cp.approvalId = approval.id;

  return { checkpoint: cp, wait };
}

/** All check-ins recorded for a run, oldest first. */
export function listCheckpoints(runId: string): SubagentCheckpoint[] {
  return [...(checkpointStore.get(runId) ?? [])];
}

/** True if a gated run currently has a check-in awaiting a decision. */
export function hasPendingCheckpoint(runId: string): boolean {
  return (checkpointStore.get(runId) ?? []).some((c) => c.pending);
}

/**
 * Resolve a gated check-in from the UI. Unblocks the paused agent: "approve"
 * lets it proceed, "redirect" feeds an edited next-step plan back into the tool
 * result, "stop" tells the agent to wind down. Returns false if the checkpoint
 * isn't pending (already decided / unknown / not gated).
 */
export function decideCheckpoint(params: {
  runId: string;
  checkpointId: string;
  decision: CheckpointDecision;
  editedNext?: string;
  note?: string;
  /** Internal: the decision came from the approval registry (don't echo back). */
  fromApproval?: boolean;
  /** Who decided (for the approval audit trail). */
  by?: string;
}): { ok: boolean; error?: string } {
  const list = checkpointStore.get(params.runId);
  const cp = list?.find((c) => c.id === params.checkpointId);
  if (!cp) return { ok: false, error: "Checkpoint not found" };
  if (!cp.pending) return { ok: false, error: "Checkpoint already decided" };
  const pending = pendingApprovals.get(params.checkpointId);

  cp.pending = false;
  cp.decision = params.decision;
  cp.editedNext = params.editedNext?.trim() || undefined;
  cp.note = params.note?.trim() || undefined;
  cp.decidedAt = Date.now();

  if (pending) {
    if (pending.timer) clearTimeout(pending.timer);
    pendingApprovals.delete(params.checkpointId);
    pending.resolve({
      decision: params.decision,
      editedNext: cp.editedNext,
      note: cp.note,
    });
  }

  try {
    broadcastSubagentCheckpoint({
      runId: params.runId,
      sessionKey: cp.sessionKey,
      checkpointId: cp.id,
      summary: cp.summary,
      next: cp.next,
      deviations: cp.deviations,
      driftSuspected: cp.driftSuspected,
      driftReasons: cp.driftReasons,
      gated: cp.gated,
      pending: false,
      decision: cp.decision,
      ts: cp.decidedAt,
    });
  } catch {
    /* best-effort */
  }
  notifyCheckpointListeners(cp);
  // Decided from the focus modal: close the unified approval too so Telegram
  // cards get edited and later taps report "already resolved".
  if (!params.fromApproval && cp.approvalId) {
    resolveApprovalRequest(cp.approvalId, {
      action:
        params.decision === "approve"
          ? "approve"
          : params.decision === "redirect"
            ? "redirect"
            : "deny",
      note: params.decision === "redirect" ? (cp.editedNext ?? cp.note) : cp.note,
      by: params.by ?? "operator",
      via: "ui",
    });
  }
  return { ok: true };
}

/** Test/cleanup helper — drop a run's checkpoint state. */
export function clearCheckpointsForRun(runId: string): void {
  const cfg = checkpointConfigByRun.get(runId);
  checkpointStore.delete(runId);
  checkpointConfigByRun.delete(runId);
  if (cfg) checkpointConfigBySession.delete(cfg.sessionKey);
}

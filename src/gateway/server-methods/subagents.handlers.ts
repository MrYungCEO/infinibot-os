/**
 * Sub-Agent Management Gateway Handlers
 *
 * Provides real-time querying and management of sub-agent runs.
 */

import {
  listAllSubagentRuns,
  listSubagentRunsForRequester,
  getSubagentRun,
  getSubagentRunBySessionKey,
  getSubagentRunByKanbanTaskId,
  updateSubagentRunSpecAnalysis,
  reconcileSubagentLiveness,
  type SubagentRunRecord,
} from "../../agents/subagent-registry.js";
import { analyzeSpecVsResult } from "../../agents/spec-analysis.js";
import {
  getSubagentHistoryEntryByRunId,
  getSubagentHistoryEntryByKanbanTaskId,
  type SubagentHistoryEntry,
} from "../../agents/subagent-history.js";
import { createClaudeCoderTool } from "../../agents/tools/claude-coder-tool.js";
import { getTask, getProject, listTasks } from "../../databases/kanban-store-ops.js";
import { getContentPagesStore } from "../../content/pages-store.js";
import { isContentStudioActive } from "../../content-studio/runtime.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  listActiveProgress,
  listProgressForRequester,
  getProgress,
  reportProgress,
  listCheckpoints,
  decideCheckpoint,
  type SubagentProgressRecord,
  type ProgressStatus,
  type CheckpointDecision,
} from "../../agents/subagent-progress.js";
import {
  listRemoteSessions,
  getRemoteSessionsSpawnedBy,
  type RemoteSessionRecord,
} from "../../federation/remote-session-registry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { summary as creditSummary } from "../../credits/aggregator.js";
import type { GatewayRequestHandlers } from "./types.js";
import { isCoderBackendId } from "../../agents/coder-backend/types.js";

const log = createSubsystemLogger("gateway/subagents");

const TASK_TRUNCATE = 160;
const MESSAGE_TRUNCATE = 140;
const DEFAULT_UPDATE_TAIL = 3;
/**
 * Completed runs stay in subagents.list for this long after endedAt, even
 * without includeCompleted:true.  Matches the progress-store and registry
 * grace windows (both 10 min) so the UI always has something to display
 * until the card naturally ages out.
 */
const COMPLETED_GRACE_MS = 10 * 60_000;

/**
 * Per-originalRunId dedupe for `subagents.respawn`. Without this, a double-tap
 * of the "Respawn Agent" button (or the modal being reopened mid-RPC) spawns
 * two children for the same failed run — we saw this in the wild as parallel
 * `coder-respawn-…-{a,b}` processes. While a respawn is pending we await the
 * same promise; for a short window after success we replay the same response.
 */
type RespawnResponseBody = {
  ok: boolean;
  source?: "live" | "archive" | "none";
  originalRunId?: string;
  newRunId?: string;
  newSessionKey?: string;
  preambleLength?: number;
  receipt?: Record<string, unknown>;
  error?: string;
  /** Set when this body was served from the dedupe cache, not a fresh spawn. */
  deduped?: boolean;
};
type RespawnDedupeEntry =
  | { kind: "pending"; promise: Promise<RespawnResponseBody> }
  | { kind: "succeeded"; body: RespawnResponseBody; expiresAt: number };
const respawnInFlight = new Map<string, RespawnDedupeEntry>();
const RESPAWN_DEDUPE_WINDOW_MS = 60_000;

/**
 * Throttle for the per-list liveness reconcile. The Activity page polls
 * subagents.list every ~3s; reconciling (a few process.kill(pid,0) probes) on
 * every poll is wasteful, so we coalesce to once per window. The registry's
 * 60s sweeper remains the unconditional backstop.
 */
const RECONCILE_THROTTLE_MS = 4_000;
let lastReconcileAt = 0;
function maybeReconcileLiveness(): void {
  const now = Date.now();
  if (now - lastReconcileAt < RECONCILE_THROTTLE_MS) return;
  lastReconcileAt = now;
  try {
    reconcileSubagentLiveness();
  } catch {
    /* never let reconciliation break the list response */
  }
}

function truncate(s: string | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Compose the "prior work" context preamble passed to a respawn. The new
 * spawn's child Claude reads this as its --append-system-prompt so it can
 * pick up where the failed run left off instead of restarting from scratch.
 */
function buildRespawnPreamble(args: {
  originalRunId: string;
  lastError: string;
  endedAt?: number;
  startedAt?: number;
  progress?: SubagentProgressRecord | undefined;
  archived?: SubagentHistoryEntry | undefined;
}): string {
  const endedIso = args.endedAt ? new Date(args.endedAt).toISOString() : "unknown time";
  const startedIso = args.startedAt ? new Date(args.startedAt).toISOString() : null;
  const lines: string[] = [];
  lines.push("# Respawn context");
  lines.push(
    `This run is a RESPAWN of a previous attempt (runId=${args.originalRunId}) that ` +
      `failed at ${endedIso} with: ${args.lastError}`,
  );
  if (startedIso) lines.push(`Original run started at ${startedIso}.`);

  const updates = args.progress?.updates ?? [];
  if (updates.length > 0) {
    lines.push("");
    lines.push("The previous attempt made the following progress before failing:");
    // Cap to last 30 entries to keep the preamble manageable.
    const slice = updates.slice(-30);
    for (const u of slice) {
      const ts = u.timestamp ? new Date(u.timestamp).toISOString() : "?";
      const cp = u.checkpoint ? ` [checkpoint=${u.checkpoint}]` : "";
      const pct = typeof u.progress === "number" ? ` (${Math.round(u.progress)}%)` : "";
      const msg = truncate(u.message, 240);
      lines.push(`- [${ts}] ${u.status}${pct}${cp}: ${msg}`);
    }
  }

  const checkpoints = args.progress?.checkpoints ?? [];
  if (checkpoints.length > 0) {
    lines.push("");
    lines.push(`Checkpoints reached: ${checkpoints.slice(-20).join(" → ")}`);
  }

  const lastActivity = args.progress?.lastActivity;
  if (lastActivity) {
    lines.push("");
    lines.push(
      `Last fine-grained activity: ${lastActivity.kind} — ${truncate(lastActivity.label, 200)}`,
    );
  }

  const filesSample = args.archived?.filesTouchedSample;
  if (filesSample && filesSample.length > 0) {
    lines.push("");
    lines.push(
      `Files the previous run touched (${args.archived?.filesTouchedCount ?? filesSample.length} total, most recent first):`,
    );
    for (const p of filesSample.slice().reverse()) {
      lines.push(`- ${p}`);
    }
  }

  lines.push("");
  lines.push("# Your job");
  lines.push(
    "Resume from where the prior run left off. Do not redo completed work. " +
      "Before continuing, verify the prior work actually landed: read each file the previous " +
      "attempt claims to have edited and confirm the change is present. If a step is incomplete " +
      "or wrong, fix it forward — do not revert the prior attempt's edits unless they are clearly broken. " +
      "Once everything is verified, finish the remaining work to satisfy the original task.",
  );

  // Hard cap so the preamble never crowds out the actual task instructions.
  const composed = lines.join("\n");
  const MAX_PREAMBLE_CHARS = 12_000;
  if (composed.length > MAX_PREAMBLE_CHARS) {
    return `${composed.slice(0, MAX_PREAMBLE_CHARS - 80)}\n…\n[preamble truncated for length]`;
  }
  return composed;
}

function buildUpdates(
  updates: Array<{ status: string; message: string; progress?: number; timestamp: number }>,
  since: number,
  tail: number,
): Array<{ status: string; message: string; progress?: number; timestamp: number }> {
  const filtered = since > 0 ? updates.filter((u) => (u.timestamp || 0) > since) : updates;
  const sliced = filtered.slice(-tail);
  return sliced.map((u) => ({
    status: u.status,
    message: truncate(u.message, MESSAGE_TRUNCATE),
    progress: u.progress,
    timestamp: u.timestamp,
  }));
}

type SubagentStatusResult = {
  runId: string;
  sessionKey: string;
  label?: string;
  task: string;
  status: string;
  progress: number;
  checkpoints: string[];
  currentCheckpoint?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastUpdateAt: number;
  outcome?: { status: string; error?: string };
  recentUpdates: Array<{
    status: string;
    message: string;
    progress?: number;
    timestamp: number;
  }>;
  /** Fine-grained "what is it doing right now" signal, refreshed per tool call. */
  lastActivity?: { kind: string; label: string; at: number };
  /** Count of files the subagent touched (from filesTouched in registry). */
  filesTouchedCount?: number;
  /**
   * CLI backend that produced this run, when known. Lets UI surfaces tag
   * the card with the provider's brand mark (claude / opencode / codex).
   * Mirrors SubagentRunRecord.coderBackend in src/agents/subagent-registry.ts.
   */
  coderBackend?: "claude-code" | "opencode" | "codex" | "gemini" | "grok";
  /** When this run was spawned by `subagents.respawn`, the prior run's id. */
  respawnOfRunId?: string;
  /**
   * Kanban task id auto-created at spawn-time. Surfaced here so the kanban
   * view can render a "sub-agent" badge on the matching task card without
   * needing a separate detail fetch per task.
   */
  kanbanTaskId?: string;
  // Remote session info
  remote?: boolean;
  nodeId?: string;
  nodeName?: string;
};

function mergeRunAndProgress(
  run: SubagentRunRecord,
  progress: SubagentProgressRecord | undefined,
  opts: { since: number; tail: number; compact: boolean },
): SubagentStatusResult {
  return {
    runId: run.runId,
    sessionKey: run.childSessionKey,
    label: progress?.label || run.label,
    task: truncate(progress?.task || run.task, TASK_TRUNCATE),
    status: progress?.status || (run.endedAt ? "completed" : "running"),
    progress: progress?.progress ?? (run.endedAt ? 100 : 0),
    checkpoints: progress?.checkpoints || [],
    currentCheckpoint: progress?.currentCheckpoint,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    lastUpdateAt: progress?.lastUpdateAt || run.createdAt,
    outcome: run.outcome,
    recentUpdates: opts.compact ? [] : buildUpdates(progress?.updates || [], opts.since, opts.tail),
    lastActivity: progress?.lastActivity,
    filesTouchedCount: run.filesTouched?.length ?? 0,
    coderBackend: run.coderBackend ?? progress?.lastActivity?.coderBackend,
    respawnOfRunId: run.respawnOfRunId,
    kanbanTaskId: run.kanbanTaskId,
    remote: false, // Local sessions are not remote
  };
}

function convertRemoteSessionToResult(
  remote: RemoteSessionRecord,
  opts: { since: number; compact: boolean },
): SubagentStatusResult {
  // Map remote status to standard status
  let status: string;
  let progress: number;

  switch (remote.status) {
    case "pending":
      status = "starting";
      progress = 0;
      break;
    case "starting":
      status = "starting";
      progress = 5;
      break;
    case "running":
      status = "working";
      progress = remote.progress ?? 50;
      break;
    case "completed":
      status = "completed";
      progress = 100;
      break;
    case "failed":
      status = "completed";
      progress = 100;
      break;
    case "timeout":
      status = "completed";
      progress = 100;
      break;
    default:
      status = "unknown";
      progress = remote.progress ?? 0;
  }

  const lastTs = remote.endedAt || remote.startedAt || remote.createdAt;
  const includeUpdate = !opts.compact && !!remote.lastMessage && lastTs > opts.since;
  return {
    runId: remote.runId,
    sessionKey: remote.sessionKey,
    label: remote.label,
    task: truncate(remote.task, TASK_TRUNCATE),
    status,
    progress,
    checkpoints: [], // Remote sessions don't track checkpoints in the same way
    createdAt: remote.createdAt,
    startedAt: remote.startedAt,
    endedAt: remote.endedAt,
    lastUpdateAt: lastTs,
    outcome: remote.endedAt
      ? {
          status: remote.status === "completed" ? "ok" : "error",
          error:
            remote.status === "failed" || remote.status === "timeout"
              ? remote.lastMessage
              : undefined,
        }
      : undefined,
    recentUpdates: includeUpdate
      ? [
          {
            status: remote.status,
            message: truncate(remote.lastMessage, MESSAGE_TRUNCATE),
            progress: remote.progress,
            timestamp: lastTs,
          },
        ]
      : [],
    // Remote session specific fields
    remote: true,
    nodeId: remote.nodeId,
    nodeName: remote.nodeName,
  };
}

type DetailEnrichment = {
  project?: { id: string; name: string; href: string };
  task?: { id: string; title: string; status: string; href: string };
  tasks: Array<{
    id: string;
    title: string;
    status: string;
    priority?: string;
    projectId?: string;
    projectName?: string;
    href: string;
  }>;
  contentPages: Array<{
    id: string;
    name: string;
    surface: string;
    status: string;
    updatedAt: number;
    handle?: string;
    url?: string;
    href: string;
  }>;
};

/**
 * Shared kanban + content-pages lookup used by `subagents.detail` for both
 * live and archived records.  Lifted into its own helper so the archive code
 * path doesn't duplicate the live one (the inputs we care about — kanban task
 * id + requester session key — are present on both shapes).
 */
function collectDetailEnrichment(
  kanbanTaskId: string | undefined,
  requesterSessionKey: string | undefined,
): DetailEnrichment {
  const out: DetailEnrichment = { tasks: [], contentPages: [] };

  if (kanbanTaskId) {
    try {
      const taskShape = getTask(kanbanTaskId);
      if (taskShape) {
        out.task = {
          id: taskShape.id,
          title: taskShape.title,
          status: taskShape.status,
          href: "#/projects",
        };
        out.tasks.push({
          id: taskShape.id,
          title: taskShape.title,
          status: taskShape.status,
          priority: (taskShape as { priority?: string }).priority,
          projectId: taskShape.projectId ?? undefined,
          href: "#/projects",
        });
        if (taskShape.projectId) {
          const projectShape = getProject(taskShape.projectId);
          if (projectShape) {
            out.project = {
              id: projectShape.id,
              name: projectShape.name,
              href: "#/projects",
            };
            if (out.tasks[0]) out.tasks[0].projectName = projectShape.name;
            try {
              const siblingTasks = listTasks({ projectId: projectShape.id });
              for (const t of siblingTasks) {
                if (t.id === taskShape.id) continue;
                const s = String(t.status).toLowerCase();
                if (s !== "in_progress" && s !== "review" && s !== "todo") continue;
                out.tasks.push({
                  id: t.id,
                  title: t.title,
                  status: t.status,
                  priority: (t as { priority?: string }).priority,
                  projectId: t.projectId ?? undefined,
                  projectName: projectShape.name,
                  href: "#/projects",
                });
              }
            } catch (err) {
              log.debug("subagents.detail: sibling task lookup failed", {
                projectId: projectShape.id,
                err: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
      }
    } catch (err) {
      log.debug("subagents.detail: kanban lookup failed (non-fatal)", {
        kanbanTaskId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Content pages belong to the content-studio plugin (off → none).
  if (requesterSessionKey && isContentStudioActive()) {
    try {
      const agentId = resolveAgentIdFromSessionKey(requesterSessionKey);
      const store = getContentPagesStore();
      const pages = store.list({});
      for (const p of pages) {
        if (p.ownerAgentId && p.ownerAgentId === agentId) {
          out.contentPages.push({
            id: p.id,
            name: p.name,
            surface: p.surface,
            status: p.status,
            updatedAt: p.updatedAt,
            handle: p.handle ?? undefined,
            url: p.url ?? undefined,
            href: "#/content-pages",
          });
        }
      }
      out.contentPages.sort((a, b) => b.updatedAt - a.updatedAt);
      if (out.contentPages.length > 20) out.contentPages.length = 20;
    } catch (err) {
      log.debug("subagents.detail: content pages lookup failed (non-fatal)", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return out;
}

export const subagentsHandlers: GatewayRequestHandlers = {
  /**
   * List sub-agents with their status and progress
   */
  "subagents.list": ({ params, respond }) => {
    // Reconcile the running set against real OS process state before building
    // the response so dead-but-not-reaped runs don't surface as ghost "running"
    // agents. Throttled to once per RECONCILE_THROTTLE_MS across all callers
    // (the Activity page polls this every 3s) — the 60s sweeper is the steady
    // backstop; this just tightens accuracy for an interactive viewer.
    maybeReconcileLiveness();
    const requesterSessionKey =
      typeof params?.requesterSessionKey === "string" ? params.requesterSessionKey : undefined;
    const includeCompleted = params?.includeCompleted === true;
    const limit =
      typeof params?.limit === "number" && params.limit > 0 ? Math.min(params.limit, 100) : 50;
    // New knobs to keep poll payloads small:
    //   compact → drop recentUpdates entirely (caller only needs status/progress)
    //   since   → epoch-ms filter; only updates newer than this are returned
    //   updatesTail → cap kept updates per agent (default 3, was 10)
    const compact = params?.compact === true;
    const since =
      typeof params?.since === "number" && Number.isFinite(params.since) && params.since > 0
        ? params.since
        : 0;
    const updatesTail =
      typeof params?.updatesTail === "number" && params.updatesTail >= 0
        ? Math.min(params.updatesTail, 10)
        : DEFAULT_UPDATE_TAIL;
    const itemOpts = { since, tail: updatesTail, compact };

    let runs: SubagentRunRecord[] = [];
    let progressRecords: SubagentProgressRecord[];
    let remoteSessions: RemoteSessionRecord[] = [];

    if (requesterSessionKey) {
      runs = listSubagentRunsForRequester(requesterSessionKey);
      progressRecords = listProgressForRequester(requesterSessionKey);
      // Get remote sessions spawned by this requester
      remoteSessions = getRemoteSessionsSpawnedBy(requesterSessionKey);
    } else {
      // The mesh and activity surfaces request the global list. Keep the live
      // registry half of the join here too; progress records intentionally
      // carry only transient status, so dropping registry rows loses the
      // agent label, task, backend, run linkage, and kanban metadata.
      runs = listAllSubagentRuns();
      progressRecords = listActiveProgress();
      // Get all remote sessions if no specific requester
      remoteSessions = listRemoteSessions();
    }

    // Merge data from both sources for local sessions
    const runMap = new Map<string, SubagentRunRecord>();
    for (const run of runs) {
      runMap.set(run.runId, run);
    }

    const results: SubagentStatusResult[] = [];

    // Process progress records (more detailed) for local sessions
    for (const progress of progressRecords) {
      const run = runMap.get(progress.runId);
      if (run) {
        results.push(mergeRunAndProgress(run, progress, itemOpts));
        runMap.delete(progress.runId);
      } else {
        results.push({
          runId: progress.runId,
          sessionKey: progress.sessionKey,
          label: progress.label,
          task: truncate(progress.task, TASK_TRUNCATE),
          status: progress.status,
          progress: progress.progress,
          checkpoints: progress.checkpoints,
          currentCheckpoint: progress.currentCheckpoint,
          createdAt: progress.createdAt,
          lastUpdateAt: progress.lastUpdateAt,
          recentUpdates: compact ? [] : buildUpdates(progress.updates, since, updatesTail),
          lastActivity: progress.lastActivity,
          // Sync coder runs have a progress record but no registry run; the
          // backend rides on their activity, so badge them from it.
          coderBackend: progress.lastActivity?.coderBackend,
          remote: false,
        });
      }
    }

    // Add remaining local registry entries without progress tracking.
    // Always include runs that ended within COMPLETED_GRACE_MS so the UI
    // keeps the card visible during the post-completion window even without
    // an explicit includeCompleted:true from the caller.
    const now = Date.now();
    for (const run of runMap.values()) {
      if (!includeCompleted && run.endedAt && now - run.endedAt > COMPLETED_GRACE_MS) continue;
      results.push(mergeRunAndProgress(run, undefined, itemOpts));
    }

    // Add remote sessions
    for (const remote of remoteSessions) {
      if (!includeCompleted && remote.endedAt && now - remote.endedAt > COMPLETED_GRACE_MS)
        continue;
      results.push(convertRemoteSessionToResult(remote, { since, compact }));
    }

    // Sort by most recent activity
    results.sort((a, b) => (b.lastUpdateAt || 0) - (a.lastUpdateAt || 0));

    const sliced = results.slice(0, limit);
    // serverTime lets clients pass it back as `since` on the next poll for
    // diff-style updates without pulling the whole tail every time.
    respond(
      true,
      {
        ok: true,
        subagents: sliced,
        total: results.length,
        serverTime: Date.now(),
      },
      undefined,
    );
  },

  /**
   * Get detailed status for a specific sub-agent
   */
  "subagents.status": ({ params, respond }) => {
    const runId = typeof params?.runId === "string" ? params.runId : "";
    if (!runId) {
      respond(true, { ok: false, error: "runId is required" }, undefined);
      return;
    }

    const progress = getProgress(runId);
    if (!progress) {
      respond(
        true,
        {
          ok: false,
          error: "Sub-agent not found or progress not tracked",
        },
        undefined,
      );
      return;
    }

    respond(
      true,
      {
        ok: true,
        subagent: {
          runId: progress.runId,
          sessionKey: progress.sessionKey,
          label: progress.label,
          task: progress.task,
          status: progress.status,
          progress: progress.progress,
          checkpoints: progress.checkpoints,
          currentCheckpoint: progress.currentCheckpoint,
          createdAt: progress.createdAt,
          lastUpdateAt: progress.lastUpdateAt,
          updates: progress.updates,
        },
      },
      undefined,
    );
  },

  /**
   * Report progress from a sub-agent
   */
  "subagents.progress": async ({ params, respond }) => {
    const runId = typeof params?.runId === "string" ? params.runId : "";
    const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey : runId;
    const status = params?.status as ProgressStatus;
    const message = typeof params?.message === "string" ? params.message : "";
    const progress = typeof params?.progress === "number" ? params.progress : undefined;
    const checkpoint = typeof params?.checkpoint === "string" ? params.checkpoint : undefined;
    const details =
      params?.details && typeof params.details === "object"
        ? (params.details as Record<string, unknown>)
        : undefined;
    const notify = params?.notify !== false;

    if (!runId) {
      respond(true, { ok: false, error: "runId is required" }, undefined);
      return;
    }
    if (!status) {
      respond(true, { ok: false, error: "status is required" }, undefined);
      return;
    }
    if (!message) {
      respond(true, { ok: false, error: "message is required" }, undefined);
      return;
    }

    const result = await reportProgress({
      runId,
      sessionKey,
      status,
      message,
      progress,
      checkpoint,
      details,
      notifyRequester: notify,
    });

    respond(true, result, undefined);
  },

  /**
   * Return full detail for one subagent run, including resolved kanban project/task.
   * Accepts either runId or sessionKey (childSessionKey).
   *
   * Lookup order: live registry (live runs + ~10 min grace) → history archive
   * (30-day retention).  When the response comes from the archive, it's
   * flagged with `source: "archive"` and surfaces only the leaner fields the
   * archive persists (no childPid / claudeSessionId / per-file detail).
   */
  "subagents.detail": ({ params, respond }) => {
    const runId = typeof params?.runId === "string" ? params.runId : undefined;
    const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey : undefined;
    // `kanbanTaskId` lets the grid activity panel open the focus modal
    // for a completed kanban task without first having to look up the
    // run that produced it — same lookup the modal needs anyway.
    const kanbanTaskId = typeof params?.kanbanTaskId === "string" ? params.kanbanTaskId : undefined;

    let run: SubagentRunRecord | undefined;
    if (runId) {
      run = getSubagentRun(runId);
    }
    if (!run && sessionKey) {
      run = getSubagentRunBySessionKey(sessionKey);
    }
    if (!run && kanbanTaskId) {
      run = getSubagentRunByKanbanTaskId(kanbanTaskId);
    }

    if (run) {
      const enrichment = collectDetailEnrichment(run.kanbanTaskId, run.requesterSessionKey);
      respond(
        true,
        {
          ok: true,
          source: "live",
          run: {
            runId: run.runId,
            task: run.task,
            label: run.label,
            workdir: run.workdir,
            createdAt: run.createdAt,
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            outcome: run.outcome,
            childPid: run.childPid,
            claudeSessionId: run.claudeSessionId,
            childSessionKey: run.childSessionKey,
            requesterSessionKey: run.requesterSessionKey,
            kanbanTaskId: run.kanbanTaskId,
            filesTouched: run.filesTouched,
            coderBackend: run.coderBackend,
            respawnOfRunId: run.respawnOfRunId,
          },
          ...enrichment,
        },
        undefined,
      );
      return;
    }

    // Live registry has swept the run.  Fall back to the persistent archive
    // (30-day retention) — runId is the primary key; kanbanTaskId is a
    // secondary index added so the recently-completed feed can open the
    // focus modal for tasks whose run has already aged out of the registry.
    const archived = runId
      ? getSubagentHistoryEntryByRunId(runId)
      : kanbanTaskId
        ? getSubagentHistoryEntryByKanbanTaskId(kanbanTaskId)
        : undefined;
    if (archived) {
      const enrichment = collectDetailEnrichment(
        archived.kanbanTaskId,
        archived.requesterSessionKey,
      );
      respond(
        true,
        {
          ok: true,
          source: "archive",
          run: {
            runId: archived.runId,
            task: archived.task,
            label: archived.label,
            workdir: archived.workdir,
            // Archive doesn't carry createdAt; reuse startedAt (or endedAt) so
            // duration math in the modal stays sensible.
            createdAt: archived.startedAt ?? archived.endedAt,
            startedAt: archived.startedAt,
            endedAt: archived.endedAt,
            outcome: archived.outcome ?? { status: archived.status, error: archived.error },
            requesterSessionKey: archived.requesterSessionKey,
            kanbanTaskId: archived.kanbanTaskId,
            coderBackend: archived.coderBackend,
            filesTouchedCount: archived.filesTouchedCount,
            filesTouchedSample: archived.filesTouchedSample,
            // Critical: required by spec-analysis tab to fetch the transcript
            // via sessions.transcript even after the live registry has swept the run.
            childSessionKey: archived.childSessionKey,
            transcriptPath: archived.transcriptPath,
          },
          ...enrichment,
        },
        undefined,
      );
      return;
    }

    respond(true, { ok: false, error: "Subagent run not found" }, undefined);
  },

  /**
   * Per-run token / cost usage for the focus modal's Usage block.
   *
   * Credit entries land under two dimensions depending on backend:
   *   • CLI coder backends (claude-code / opencode / codex / gemini) key the
   *     entry by `task_id` == the spawn's runId.
   *   • API/SDK paths key by the child `session_key`.
   * We sum both (de-duping when sessionKey === runId) so the modal gets a
   * single authoritative total regardless of how the run was driven.
   *
   * Accepts { runId?, sessionKey? }. Returns zeros (ok:true) when nothing has
   * been recorded yet so the modal can render 0 rather than an error.
   */
  "subagents.usage": ({ params, respond }) => {
    const runId = typeof params?.runId === "string" ? params.runId.trim() || undefined : undefined;
    const sessionKey =
      typeof params?.sessionKey === "string" ? params.sessionKey.trim() || undefined : undefined;
    if (!runId && !sessionKey) {
      respond(true, { ok: false, error: "runId or sessionKey required" }, undefined);
      return;
    }
    try {
      let tokensIn = 0;
      let tokensOut = 0;
      let costUsd = 0;
      let requests = 0;
      const add = (filters: { taskId?: string; sessionKey?: string }) => {
        const s = creditSummary({ period: "all", filters });
        tokensIn += s.totalTokensIn;
        tokensOut += s.totalTokensOut;
        costUsd += s.totalCostUsd;
        requests += s.totalRequests;
      };
      // CLI coder credit entries are keyed by taskId == runId.
      if (runId) add({ taskId: runId });
      // API/SDK entries are keyed by the child sessionKey. Skip when it is just
      // a mirror of runId (the dashboard opener historically passed runId as
      // both) to avoid double-counting.
      if (sessionKey && sessionKey !== runId) add({ sessionKey });
      respond(true, { ok: true, tokensIn, tokensOut, costUsd, requests }, undefined);
    } catch (err) {
      respond(true, { ok: false, error: String(err) }, undefined);
    }
  },

  /**
   * Respawn a failed sub-agent. Re-invokes the same coder backend with the
   * original task, but injects a context preamble enumerating the prior
   * progress so the new run can resume rather than restart from scratch.
   *
   * Accepts: { runId: string }. Falls back to the history archive when the
   * live registry has already swept the original run.
   */
  "subagents.respawn": async ({ params, respond }) => {
    const runId = typeof params?.runId === "string" ? params.runId : "";
    if (!runId) {
      respond(true, { ok: false, error: "runId is required" }, undefined);
      return;
    }

    const existing = respawnInFlight.get(runId);
    if (existing) {
      if (existing.kind === "pending") {
        try {
          const body = await existing.promise;
          respond(true, { ...body, deduped: true }, undefined);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          respond(true, { ok: false, error: message, deduped: true }, undefined);
        }
        return;
      }
      if (existing.kind === "succeeded" && existing.expiresAt > Date.now()) {
        respond(true, { ...existing.body, deduped: true }, undefined);
        return;
      }
      respawnInFlight.delete(runId);
    }

    const requesterOverride =
      typeof params?.requesterSessionKey === "string" ? params.requesterSessionKey : undefined;
    const projectHintOverride =
      typeof params?.projectHint === "string" ? params.projectHint : undefined;
    const modelOverride = typeof params?.model === "string" ? params.model : undefined;
    const backendOverride = isCoderBackendId(params?.backend) ? params.backend : undefined;
    // Oversight "Re-spawn with revised brief" path: an explicit task override
    // (and/or force) re-runs a SUCCESSFUL run too, not just failed ones.
    const taskOverride =
      typeof params?.task === "string" && params.task.trim() ? params.task.trim() : undefined;
    const forceRespawn = params?.force === true || taskOverride !== undefined;

    const live = getSubagentRun(runId);
    const archived = !live ? getSubagentHistoryEntryByRunId(runId) : undefined;
    const source: "live" | "archive" | "none" = live ? "live" : archived ? "archive" : "none";
    if (!live && !archived) {
      respond(true, { ok: false, error: `Subagent run not found: ${runId}` }, undefined);
      return;
    }

    const failedOutcome = live?.outcome ?? archived?.outcome;
    const isFailed =
      failedOutcome?.status === "error" ||
      (live && live.endedAt && live.outcome?.status !== "ok") ||
      (archived && (archived.status === "error" || archived.status === "timeout"));
    if (!isFailed && !forceRespawn) {
      respond(
        true,
        {
          ok: false,
          error: "Run is not in a failed state — only failed runs can be respawned",
        },
        undefined,
      );
      return;
    }

    const task = taskOverride ?? live?.task ?? archived?.task ?? "";
    const labelInput = live?.label ?? archived?.label;
    const workdir = live?.workdir ?? archived?.workdir;
    const requesterSessionKey =
      requesterOverride ?? live?.requesterSessionKey ?? archived?.requesterSessionKey ?? "";
    const coderBackend = backendOverride ?? live?.coderBackend ?? archived?.coderBackend;
    const endedAt = live?.endedAt ?? archived?.endedAt;
    const startedAt = live?.startedAt ?? archived?.startedAt;
    const lastError =
      failedOutcome?.error ??
      (archived && archived.status === "timeout" ? "Run timed out" : undefined) ??
      "Unknown failure";

    // Build the prior-progress preamble from the in-memory progress store
    // (live updates + lastActivity + checkpoints). When the run has already
    // been swept from the progress store we fall back to the archive's
    // filesTouchedSample so the preamble is at least informative.
    const progress = getProgress(runId);
    const preamble = buildRespawnPreamble({
      originalRunId: runId,
      lastError,
      endedAt,
      startedAt,
      progress,
      archived,
    });

    const requesterAgentId = requesterSessionKey
      ? requesterSessionKey.split(":")[1] || undefined
      : undefined;

    // Mirror the call pattern used in server-voice-stream.ts:
    //   createClaudeCoderTool(...).execute(toolCallId, args).
    const coder = createClaudeCoderTool({
      agentId: requesterAgentId,
      agentSessionKey: requesterSessionKey || undefined,
      workspaceDir: workdir,
    });

    const spawnArgs: Record<string, unknown> = {
      task,
      mode: "detach",
      systemPrompt: preamble,
      respawnOfRunId: runId,
    };
    if (labelInput) spawnArgs.label = `Respawn: ${labelInput}`.slice(0, 120);
    if (workdir) spawnArgs.workdir = workdir;
    if (modelOverride) spawnArgs.model = modelOverride;
    if (coderBackend) spawnArgs.backend = coderBackend;
    if (projectHintOverride) spawnArgs.projectHint = projectHintOverride;

    const work: Promise<RespawnResponseBody> = (async () => {
      const result = (await coder.execute(`respawn-${runId}`, spawnArgs)) as
        | { content?: Array<{ text?: string }> }
        | undefined;

      // claude_coder returns its receipt as a JSON-stringified blob in
      // content[0].text. Surface the parsed shape so callers don't have
      // to unwrap it.
      let receipt: Record<string, unknown> = {};
      const raw = result?.content?.[0]?.text;
      if (typeof raw === "string") {
        try {
          receipt = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          receipt = { raw };
        }
      }

      return {
        ok: true,
        source,
        originalRunId: runId,
        newRunId: typeof receipt.runId === "string" ? receipt.runId : undefined,
        newSessionKey:
          typeof receipt.childSessionKey === "string" ? receipt.childSessionKey : undefined,
        preambleLength: preamble.length,
        receipt,
      };
    })();
    respawnInFlight.set(runId, { kind: "pending", promise: work });

    try {
      const body = await work;
      respawnInFlight.set(runId, {
        kind: "succeeded",
        body,
        expiresAt: Date.now() + RESPAWN_DEDUPE_WINDOW_MS,
      });
      respond(true, body, undefined);
    } catch (err) {
      respawnInFlight.delete(runId);
      const message = err instanceof Error ? err.message : String(err);
      log.warn("subagents.respawn: spawn failed", { runId, err: message });
      respond(true, { ok: false, error: message }, undefined);
    }
  },

  /**
   * Spec-vs-Result oversight analysis — compares a finished run's result
   * against its original brief and surfaces drift (per-criterion verdicts,
   * deferrals, off-limits violations).
   *
   * The LLM verdict pass always runs once a run has finished: the grading
   * model is Haiku-class and the prompt is tiny, so per-criterion grading is
   * effectively free even for terse one-line tasks. (We previously skipped
   * grading on "short" runs to save cost — that produced empty, ungraded
   * specs for exactly the briefs that need inferred criteria the most.) The
   * only skip is a truly-empty run: no brief, no transcript, no files touched,
   * which `analyzeSpecVsResult` handles internally. Cached on the live run
   * record so re-opens are instant; archived runs recompute. `force:true`
   * bypasses the cache for a re-analyze.
   *
   * Params: { runId, sessionKey?, transcriptText?, force? }
   */
  "subagents.specAnalysis": async ({ params, respond }) => {
    const runId = typeof params?.runId === "string" ? params.runId : "";
    if (!runId) {
      respond(true, { ok: false, error: "runId is required" }, undefined);
      return;
    }
    const force = params?.force === true;
    const transcriptText = typeof params?.transcriptText === "string" ? params.transcriptText : "";

    const live = getSubagentRun(runId);
    const archived = !live ? getSubagentHistoryEntryByRunId(runId) : undefined;
    if (!live && !archived) {
      respond(true, { ok: false, error: `Subagent run not found: ${runId}` }, undefined);
      return;
    }

    // Cached on the live record → instant return (unless forcing a recompute).
    if (!force && live?.specAnalysis) {
      respond(true, { ok: true, source: "cache", analysis: live.specAnalysis }, undefined);
      return;
    }

    const brief = live?.task ?? archived?.task ?? "";
    const filesTouched: Array<{ path: string; action?: string }> = live?.filesTouched?.length
      ? live.filesTouched.map((f) => ({ path: f.path, action: f.action }))
      : (archived?.filesTouchedSample ?? []).map((p) => ({ path: p, action: "edited" }));

    // No short-run gate: grading is cheap and terse runs are exactly the ones
    // that need inferred criteria. analyzeSpecVsResult always yields ≥1
    // criterion (explicit or inferred) and grades each individually.
    try {
      const analysis = await analyzeSpecVsResult({
        brief,
        transcriptText,
        filesTouched,
        runId,
        sessionKey: live?.requesterSessionKey ?? archived?.requesterSessionKey,
      });
      // Cache on the live record (archived runs can't be cached — record gone).
      updateSubagentRunSpecAnalysis(runId, analysis as unknown as Record<string, unknown>);
      respond(true, { ok: true, source: "fresh", analysis }, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("subagents.specAnalysis failed", { runId, err: message });
      respond(true, { ok: false, error: message }, undefined);
    }
  },

  /**
   * Operator override — mark a run's spec drift as reviewed + accepted.
   * Persists `accepted` on the cached analysis. Params: { runId, accepted? }
   */
  "subagents.specAccept": ({ params, respond }) => {
    const runId = typeof params?.runId === "string" ? params.runId : "";
    if (!runId) {
      respond(true, { ok: false, error: "runId is required" }, undefined);
      return;
    }
    const accepted = params?.accepted !== false;
    const live = getSubagentRun(runId);
    if (!live) {
      respond(
        true,
        { ok: false, error: "Run not found in live registry (cannot persist)" },
        undefined,
      );
      return;
    }
    const existing = (live.specAnalysis ?? {}) as Record<string, unknown>;
    const updated = { ...existing, accepted };
    updateSubagentRunSpecAnalysis(runId, updated);
    respond(true, { ok: true, analysis: updated }, undefined);
  },

  /**
   * Ping requester with a quick status update
   */
  "subagents.ping": async ({ params, respond }) => {
    const runId = typeof params?.runId === "string" ? params.runId : "";
    const message = typeof params?.message === "string" ? params.message : "Still working...";

    if (!runId) {
      respond(true, { ok: false, error: "runId is required" }, undefined);
      return;
    }

    const result = await reportProgress({
      runId,
      sessionKey: runId,
      status: "working",
      message,
      notifyRequester: true,
    });

    respond(true, result, undefined);
  },

  /**
   * List the mid-run check-ins (checkpoints) recorded for a run. Read-only;
   * drives the focus modal's "Check-ins" feed + the new-check-in bell badge.
   */
  "subagents.checkpoints": ({ params, respond }) => {
    const runId = typeof params?.runId === "string" ? params.runId : "";
    if (!runId) {
      respond(true, { ok: false, error: "runId is required" }, undefined);
      return;
    }
    const checkpoints = listCheckpoints(runId);
    respond(
      true,
      {
        ok: true,
        runId,
        checkpoints,
        pending: checkpoints.some((c) => c.pending),
        serverTime: Date.now(),
      },
      undefined,
    );
  },

  /**
   * Send a message to an IN-FLIGHT coder sub-agent (claude/opencode/codex/
   * gemini). Queues it in the run's durable inbox and returns immediately with
   * a messageId + honest status (queued | delivered | acknowledged |
   * not_running | not_found | unsupported_backend). `waitMs` (≤8000) waits for
   * the agent's next tool boundary. Never routed to a gateway LLM.
   */
  "subagents.message": async ({ params, respond, client }) => {
    const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
    const sessionKey =
      typeof params?.childSessionKey === "string"
        ? params.childSessionKey.trim()
        : typeof params?.sessionKey === "string"
          ? params.sessionKey.trim()
          : "";
    const message = typeof params?.message === "string" ? params.message : "";
    if (!runId && !sessionKey) {
      respond(true, { ok: false, error: "runId or childSessionKey is required" }, undefined);
      return;
    }
    if (!message.trim()) {
      respond(true, { ok: false, error: "message is required" }, undefined);
      return;
    }
    const { sendSubagentMessage } = await import("../../agents/subagent-inbox/service.js");
    const from =
      typeof params?.from === "string" && params.from.trim()
        ? params.from.trim()
        : client?.connect?.client?.id
          ? `ui:${client.connect.client.id}`
          : "operator";
    const result = await sendSubagentMessage({
      runId: runId || undefined,
      sessionKey: sessionKey || undefined,
      message,
      from,
      waitMs: typeof params?.waitMs === "number" ? params.waitMs : 0,
    });
    respond(true, result, undefined);
  },

  /**
   * Operator-message timeline for a run (focus modal Check-ins tab), or the
   * delivery status of one message (`messageId`).
   */
  "subagents.messages": async ({ params, respond }) => {
    const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
    const sessionKey =
      typeof params?.childSessionKey === "string" ? params.childSessionKey.trim() : "";
    const messageId = typeof params?.messageId === "string" ? params.messageId.trim() : "";
    if (!runId && !sessionKey) {
      respond(true, { ok: false, error: "runId or childSessionKey is required" }, undefined);
      return;
    }
    const { getSubagentMessageStatus, listSubagentMessages, resolveSubagentTarget } =
      await import("../../agents/subagent-inbox/service.js");
    if (messageId) {
      respond(
        true,
        getSubagentMessageStatus({
          runId: runId || undefined,
          sessionKey: sessionKey || undefined,
          messageId,
        }),
        undefined,
      );
      return;
    }
    const target = resolveSubagentTarget({
      runId: runId || undefined,
      sessionKey: sessionKey || undefined,
    });
    const effectiveRunId = target.kind === "none" ? runId : target.run.runId;
    respond(
      true,
      {
        ok: Boolean(effectiveRunId),
        runId: effectiveRunId,
        messages: effectiveRunId ? listSubagentMessages(effectiveRunId) : [],
        serverTime: Date.now(),
      },
      undefined,
    );
  },

  /**
   * Resolve a gated check-in from the focus modal: approve / redirect / stop.
   * Unblocks the paused agent. `editedNext` carries the operator's revised
   * next-step plan on a redirect.
   */
  "subagents.checkpointDecision": ({ params, respond, client }) => {
    const runId = typeof params?.runId === "string" ? params.runId : "";
    const checkpointId = typeof params?.checkpointId === "string" ? params.checkpointId : "";
    const decisionRaw = typeof params?.decision === "string" ? params.decision : "";
    const editedNext = typeof params?.editedNext === "string" ? params.editedNext : undefined;
    const note = typeof params?.note === "string" ? params.note : undefined;

    if (!runId || !checkpointId) {
      respond(true, { ok: false, error: "runId and checkpointId are required" }, undefined);
      return;
    }
    if (decisionRaw !== "approve" && decisionRaw !== "redirect" && decisionRaw !== "stop") {
      respond(
        true,
        { ok: false, error: "decision must be 'approve' | 'redirect' | 'stop'" },
        undefined,
      );
      return;
    }

    const result = decideCheckpoint({
      runId,
      checkpointId,
      decision: decisionRaw as CheckpointDecision,
      editedNext,
      note,
      by: client?.connect?.client?.displayName ?? client?.connect?.client?.id ?? "web UI",
    });
    respond(true, result, undefined);
  },

  /**
   * Stop a sub-agent run by runId.
   *
   * `agent.abort` is the equivalent for a session the caller already knows the
   * sessionKey of; the focus modal only has a runId when the run has no live
   * session row, so this resolves runId → childSessionKey and performs the
   * same abort (clear queues, abort the embedded run, kill a stray child pid)
   * before marking the run ended.
   *
   * Idempotent: stopping an already-finished run reports `alreadyStopped`
   * instead of failing.
   */
  "subagents.stop": async ({ params, respond }) => {
    const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
    if (!runId) {
      respond(true, { ok: false, error: "runId is required" }, undefined);
      return;
    }

    const run = getSubagentRun(runId);
    if (!run) {
      respond(true, { ok: false, error: `Sub-agent run not found: ${runId}` }, undefined);
      return;
    }

    if (run.endedAt) {
      respond(true, { ok: true, runId, alreadyStopped: true, aborted: false }, undefined);
      return;
    }

    const { abortEmbeddedPiRun } = await import("../../agents/pi-embedded.js");
    const { clearSessionQueues } = await import("../../auto-reply/reply/queue.js");
    const { loadSessionEntry } = await import("../session-utils.js");
    const { markSubagentRunComplete } = await import("../../agents/subagent-registry.js");

    const childKey = run.childSessionKey?.trim();
    let aborted = false;
    let cleared = { followupCleared: 0, laneCleared: 0 };

    if (childKey) {
      cleared = clearSessionQueues([childKey]);
      const { entry } = loadSessionEntry(childKey);
      const sessionId = entry?.sessionId;
      if (sessionId) aborted = abortEmbeddedPiRun(sessionId);
    }

    // Coder-backed runs are an OS child process rather than an embedded loop.
    // Durable runs live inside a tmux session the gateway does not own, so the
    // tracked pid is the pane's shell — killing the SESSION is what actually
    // stops the work. This is the one path allowed to do that: an explicit
    // operator stop, never gateway shutdown.
    let killedPid = false;
    let killedTmux = false;
    if (run.durableSpawn === "tmux-coder") {
      const { killDurableRun } = await import("../../agents/coder-backend/durable-spawn.js");
      killedTmux = killDurableRun(runId);
    }
    if (run.childPid) {
      try {
        process.kill(run.childPid, "SIGTERM");
        killedPid = true;
      } catch {
        // Already gone — nothing to stop.
      }
    }

    markSubagentRunComplete(runId, { status: "error", error: "Stopped by operator" });

    respond(
      true,
      {
        ok: true,
        runId,
        childSessionKey: childKey,
        aborted,
        killedPid,
        killedTmux,
        clearedFollowups: cleared.followupCleared,
        clearedLane: cleared.laneCleared,
      },
      undefined,
    );
  },
};

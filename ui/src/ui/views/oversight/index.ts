/**
 * Oversight Page — live post-task review list + detail view.
 *
 * Route: /reviews?view=oversight (list) and …#review-<runId> (detail, hash-based).
 * /oversight and /subagents redirect there (Reviews sub-tab).
 *
 * DATA SOURCE
 * ───────────
 * The list spine is the REAL production sub-agent registry, served by the
 * `subagents.list` gateway RPC — the exact same source the Activity /
 * Terminals surfaces use. Every row is an actual spawned sub-agent run
 * (completed, running, blocked, errored or aborted). There are NO mock rows.
 *
 * On top of that spine we overlay the richer auto/self-reported review record
 * (`subagent_reviews_list` → `getReviewByRunId`) when one exists, so a run that
 * has been reviewed shows summary / confidence / files / blockers / next-steps.
 * Most runs have no review record (the auto-reviewer only runs on demand), so
 * the row falls back to the run's own task brief, outcome and update timeline.
 *
 * Live updates: subscribes to the gateway WS lifecycle events
 * (`subagent.spawned` / `subagent.complete` / `subagent.error` /
 * `subagent.timeout` / `session.completed`) so a new completion shows up
 * without a manual refresh, backed by a 15 s safety poll.
 *
 * Consumes backend RPCs (verbatim names):
 *   subagents.list({ includeCompleted, limit, compact })   — the run spine
 *   subagent_reviews_list({ status?, since?, limit })        — review overlay/badges
 *   subagent_review_get({ runId })                           — single review
 *   subagent_review_force({ runId })                         — re-run auto-reviewer
 *
 * Exports (kept stable — consumed by recently-completed-feed + subagent-detail-modal):
 *   renderOversightView(state, client) — main mount point for app-render
 *   getReviewBadgeByLabel(label)       — feed integration: review badge by agent label
 *   getReviewByRunId(runId)            — modal integration: review badge by runId
 *   loadOversightReviews(client, ru)   — trigger initial load from app-render
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../../gateway";
import type { AppViewState } from "../../app-view-state";
import { pathForTab } from "../../navigation";
import { loadOversightState, saveOversightState } from "./persistence";
// Registers the <proactive-oversight-panel> custom element (default cron jobs).
import "../../components/proactive-oversight-panel";
import "../../components/completion-verdict";
import { mergeLiveAndHistory, type SubagentHistoryRow } from "./history-merge";
import { verdictTone, type CompletionVerdictData } from "../../components/completion-verdict";

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Rich review record (auto-generated or self-reported). Kept exactly as the
 * reviews subsystem / feed / detail-modal expect it. Used here as an OVERLAY on
 * top of the live run spine — not every run has one.
 */
export type AgentReview = {
  id: string;
  runId: string;
  sessionKey: string;
  label: string;
  projectId?: string;
  status: "completed" | "partial" | "errored" | "aborted";
  summary: string;
  filesTouched: string[];
  testsRun?: Array<{ name: string; passed: boolean; output?: string }>;
  buildPassed?: boolean;
  nextSteps: string[];
  blockers: string[];
  confidence: number; // 0–1
  tokenCost?: number;
  durationMs: number;
  completedAt: number;
  selfReported?: boolean;
  source?: "self" | "auto" | "sampler" | "verifier";
  /** Operator oversight decision. Absent ⇒ treated as "pending". */
  decision?: "pending" | "approved" | "sent_back";
  decisionNote?: string;
  decidedAt?: number;
  /** Set by the oversight sampler when a re-check finds drift. */
  drift?: boolean;
  driftNote?: string;
  /** Verified-completion verdict (RESULT block + evidence review). */
  completion?: CompletionVerdictData;
};

/** Normalised lifecycle bucket used by the list/filters. */
export type OversightStatus = "running" | "completed" | "errored" | "blocked" | "aborted";

/**
 * One live sub-agent run, projected from `subagents.list`. This is the row
 * spine. Optional `review` is the overlay (when a review record exists).
 */
type OversightEntry = {
  runId: string;
  sessionKey: string;
  label: string;
  task: string;
  status: OversightStatus;
  /** Raw status string from the registry, for tooltip/debug. */
  rawStatus: string;
  progress: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastUpdateAt: number;
  /** ms; for running rows this is computed against now() at projection time. */
  durationMs: number;
  /** Why the run ended (outcome.error / outcome.status), when finished. */
  exitReason?: string;
  filesTouchedCount: number;
  coderBackend?: string;
  kanbanTaskId?: string;
  remote: boolean;
  nodeName?: string;
  recentUpdates: Array<{ status: string; message: string; progress?: number; timestamp: number }>;
  /** Rich review overlay, when a review record exists for this runId. */
  review?: AgentReview;
};

// ── Module state ──────────────────────────────────────────────────────────────

let _entries: OversightEntry[] = [];
let _loading = false;
let _error: string | null = null;
let _client: GatewayBrowserClient | null = null;
let _requestUpdate: (() => void) | null = null;
let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _tickTimer: ReturnType<typeof setInterval> | null = null;
let _wsUnsub: (() => void) | null = null;
let _basePath = "";

// Filter state
type StatusFilter = "all" | OversightStatus;
type TimeRange = "all" | "1h" | "24h" | "7d";

// Review-decision filter (the oversight verdict track, distinct from run status).
type DecisionFilter = "all" | "pending" | "approved" | "sent_back" | "drift";

// Hydrate filter / expand / acked state from the durable snapshot so the page
// survives a full reload, not just client-side tab navigation. See ./persistence.
const _hydrated = loadOversightState();

let _filterStatus: StatusFilter = _hydrated.filterStatus as StatusFilter;
let _filterTime: TimeRange = _hydrated.filterTime;
let _filterProject = _hydrated.filterProject;
let _filterSearch = _hydrated.filterSearch;
let _filterHasBlockers = _hydrated.filterHasBlockers;
let _filterDecision: DecisionFilter = _hydrated.filterDecision;
// runId currently being decided (approve/send-back in flight), for button state.
let _decideLoading = new Set<string>();
let _samplerRunning = false;
let _samplerLastRunAt = 0;

// Detail / expand state
let _expandedIds = new Set<string>(_hydrated.expandedIds);
let _forceLoading = new Set<string>();
// runId → Set of acknowledged next-step indices
let _acked = new Map<string, Set<number>>(
  _hydrated.acked.map(([runId, idxs]) => [runId, new Set(idxs)]),
);

/**
 * Snapshot the current user-visible state into the durable store. Called from
 * renderOversightView, which runs after every state mutation (each handler
 * triggers requestUpdate → re-render), so this single chokepoint captures all
 * filter / expand / acknowledgement changes without sprinkling save() calls.
 * The write itself is debounced inside persistence.ts.
 */
function _persistState(): void {
  saveOversightState({
    v: 1,
    filterStatus: _filterStatus,
    filterTime: _filterTime,
    filterProject: _filterProject,
    filterSearch: _filterSearch,
    filterHasBlockers: _filterHasBlockers,
    filterDecision: _filterDecision,
    expandedIds: [..._expandedIds],
    acked: [..._acked].map(([runId, idxs]) => [runId, [...idxs]]),
    lastViewedAt: Date.now(),
  });
}

// ── Review badge registry (for feed + detail-modal integration) ───────────────
// Keyed by lowercased label and by runId so other surfaces can look up the
// rich review for a finished run. Populated from `subagent_reviews_list`.

const _badgeByLabel = new Map<string, AgentReview>();
const _badgeByRunId = new Map<string, AgentReview>();

function _rebuildBadgeRegistry(reviews: AgentReview[]): void {
  // Snapshot any in-flight / locally-decided overlays before we wipe the map.
  // The 15s poll rebuilds this registry from the server; without this guard an
  // operator's optimistic approve/send-back (recorded by _decide before the
  // server review refreshes) would silently revert on the next poll — the
  // "decision keeps resetting" symptom. We re-apply a local decision whenever
  // the incoming server review doesn't yet reflect it.
  const localDecided = new Map<string, AgentReview>();
  for (const [runId, prev] of _badgeByRunId) {
    if ((prev.decision === "approved" || prev.decision === "sent_back") && prev.decidedAt) {
      localDecided.set(runId, prev);
    }
  }

  _badgeByLabel.clear();
  _badgeByRunId.clear();
  for (const r of reviews) {
    const local = localDecided.get(r.runId);
    // Keep the local decision if the server hasn't caught up (no decision, or
    // an older decidedAt than the one the operator just made).
    const merged =
      local &&
      (r.decision !== local.decision || (r.decidedAt ?? 0) < (local.decidedAt ?? 0))
        ? { ...r, decision: local.decision, decidedAt: local.decidedAt, decisionNote: local.decisionNote ?? r.decisionNote }
        : r;
    if (merged.label) _badgeByLabel.set(merged.label.toLowerCase(), merged);
    _badgeByRunId.set(merged.runId, merged);
    localDecided.delete(r.runId);
  }
  // A run that was decided locally but is absent from the server's review list
  // this round (e.g. it dropped out of the time window) keeps its overlay so an
  // in-flight decision isn't lost mid-RPC.
  for (const [runId, prev] of localDecided) {
    if (_decideLoading.has(runId)) {
      _badgeByRunId.set(runId, prev);
      if (prev.label) _badgeByLabel.set(prev.label.toLowerCase(), prev);
    }
  }
}

export function getReviewBadgeByLabel(label: string): AgentReview | undefined {
  return _badgeByLabel.get(label.toLowerCase());
}

export function getReviewByRunId(runId: string): AgentReview | undefined {
  return _badgeByRunId.get(runId);
}

// ── RPC helper ────────────────────────────────────────────────────────────────

function rpc(client: GatewayBrowserClient, method: string, params?: unknown): Promise<unknown> {
  return (client as unknown as { request: (m: string, p?: unknown) => Promise<unknown> }).request(
    method,
    params,
  );
}

// ── Review shape normalisation ────────────────────────────────────────────────
// The server's AgentReview (src/agents/reviews/schema.ts) sends confidence as
// "high" | "medium" | "low" and filesTouched as {path, action, …} objects; this
// view renders a 0–1 number and path strings ("NaN% conf." / "[object Object]").
const _CONFIDENCE: Record<string, number> = { high: 0.9, medium: 0.6, low: 0.3 };

function _normalizeReviewShape(r: AgentReview): AgentReview {
  const raw = r as unknown as { confidence?: unknown; filesTouched?: unknown };
  const confidence =
    typeof raw.confidence === "number"
      ? raw.confidence
      : _CONFIDENCE[String(raw.confidence ?? "").toLowerCase()] ?? 0.5;
  const filesTouched = Array.isArray(raw.filesTouched)
    ? raw.filesTouched
        .map((f) => (typeof f === "string" ? f : f && typeof f === "object" ? String((f as { path?: unknown }).path ?? "") : ""))
        .filter(Boolean)
    : [];
  return { ...r, confidence, filesTouched };
}

// ── Status normalisation ──────────────────────────────────────────────────────

const _ERROR_STATES = new Set(["errored", "error", "failed", "failure", "timeout"]);
const _ABORT_STATES = new Set(["aborted", "cancelled", "canceled", "killed"]);
const _DONE_STATES = new Set(["completed", "complete", "done", "finished"]);

function _normalizeStatus(
  rawStatus: string,
  outcome: { status?: string; error?: string } | undefined,
  endedAt: number | undefined,
): OversightStatus {
  const s = (rawStatus || "").toLowerCase();
  const o = (outcome?.status || "").toLowerCase();

  if (_ERROR_STATES.has(o) || _ERROR_STATES.has(s)) return "errored";
  if (_ABORT_STATES.has(o) || _ABORT_STATES.has(s)) return "aborted";
  if (s === "blocked") return "blocked";
  if (o === "ok" || o === "success" || _DONE_STATES.has(s)) return "completed";
  // A run with an endedAt but no explicit error/abort is treated as completed.
  if (endedAt && endedAt > 0) return "completed";
  return "running";
}

// ── Projection: subagents.list item → OversightEntry ──────────────────────────

function _projectSubagent(sub: Record<string, unknown>): OversightEntry | null {
  const runId = typeof sub.runId === "string" ? sub.runId : "";
  if (!runId) return null;

  const rawStatus = typeof sub.status === "string" ? sub.status : "";
  const outcome = (sub.outcome as { status?: string; error?: string } | undefined) ?? undefined;
  const createdAt = typeof sub.createdAt === "number" ? sub.createdAt : 0;
  const startedAt = typeof sub.startedAt === "number" ? sub.startedAt : undefined;
  const endedAt = typeof sub.endedAt === "number" ? sub.endedAt : undefined;
  const lastUpdateAt = typeof sub.lastUpdateAt === "number" ? sub.lastUpdateAt : createdAt;

  const status = _normalizeStatus(rawStatus, outcome, endedAt);

  const startRef = startedAt || createdAt;
  const durationMs = endedAt && startRef ? endedAt - startRef : startRef ? Date.now() - startRef : 0;

  const exitReason =
    outcome?.error?.trim() ||
    (status === "errored" || status === "aborted"
      ? outcome?.status || rawStatus || undefined
      : undefined);

  const review = _badgeByRunId.get(runId);

  const recentUpdatesRaw = Array.isArray(sub.recentUpdates)
    ? (sub.recentUpdates as Array<Record<string, unknown>>)
    : [];
  const recentUpdates = recentUpdatesRaw.map((u) => ({
    status: typeof u.status === "string" ? u.status : "",
    message: typeof u.message === "string" ? u.message : "",
    progress: typeof u.progress === "number" ? u.progress : undefined,
    timestamp: typeof u.timestamp === "number" ? u.timestamp : 0,
  }));

  return {
    runId,
    sessionKey: typeof sub.sessionKey === "string" ? sub.sessionKey : "",
    label: String(sub.label || sub.task || runId),
    task: typeof sub.task === "string" ? sub.task : "",
    status,
    rawStatus,
    progress: typeof sub.progress === "number" ? sub.progress : status === "completed" ? 100 : 0,
    createdAt,
    startedAt,
    endedAt,
    lastUpdateAt,
    durationMs: Math.max(0, durationMs),
    exitReason,
    filesTouchedCount:
      typeof sub.filesTouchedCount === "number"
        ? sub.filesTouchedCount
        : review?.filesTouched.length ?? 0,
    coderBackend: typeof sub.coderBackend === "string" ? sub.coderBackend : undefined,
    kanbanTaskId: typeof sub.kanbanTaskId === "string" ? sub.kanbanTaskId : undefined,
    remote: sub.remote === true,
    nodeName: typeof sub.nodeName === "string" ? sub.nodeName : undefined,
    recentUpdates,
    review,
  };
}

/** When this entry finished (or last ticked, for running rows). */
function _finishedAt(e: OversightEntry): number {
  return e.endedAt || e.lastUpdateAt || e.createdAt;
}

// ── Data loading ──────────────────────────────────────────────────────────────

/**
 * Load the rich review records into the badge registry. These are the overlay
 * for finished runs and the source for the feed/modal badge lookups. Best
 * effort: the auto-reviewer only populates these on demand, so in practice this
 * is usually a small set (or empty), and that's fine.
 */
async function _loadReviewBadges(client: GatewayBrowserClient): Promise<void> {
  try {
    const params: Record<string, unknown> = { limit: 200 };
    if (_filterTime !== "all") {
      const ms: Record<TimeRange, number> = {
        all: 0,
        "1h": 3_600_000,
        "24h": 86_400_000,
        "7d": 604_800_000,
      };
      params.since = Date.now() - ms[_filterTime];
    }
    const res = (await rpc(client, "subagent_reviews_list", params)) as
      | { reviews?: AgentReview[] }
      | AgentReview[]
      | undefined;
    const reviews = Array.isArray(res)
      ? res
      : res && Array.isArray((res as { reviews?: AgentReview[] }).reviews)
        ? (res as { reviews: AgentReview[] }).reviews
        : [];
    _rebuildBadgeRegistry(reviews.map(_normalizeReviewShape));
  } catch {
    // Non-fatal: reviews are an optional overlay. Leave the registry as-is.
  }
}

/**
 * Load the live sub-agent run spine. Exported as `loadOversightReviews` for
 * backward-compatible call sites (app-render). Loads review badges first so
 * each projected entry can pick up its overlay.
 */
export async function loadOversightReviews(
  client: GatewayBrowserClient,
  requestUpdate: () => void,
): Promise<void> {
  _client = client;
  _requestUpdate = requestUpdate;
  if (_loading) return;
  _loading = true;
  _error = null;
  requestUpdate();

  try {
    // Reviews first (overlay), then the live run spine.
    await _loadReviewBadges(client);

    const sinceMs: Record<TimeRange, number> = {
      all: 0,
      "1h": 3_600_000,
      "24h": 86_400_000,
      "7d": 604_800_000,
    };
    // subagents.list only holds runs still in gateway memory (it forgets
    // everything on restart); finished runs persist in subagents.history.
    const [res, hist] = await Promise.all([
      rpc(client, "subagents.list", {
        includeCompleted: true,
        limit: 100,
        // Need recentUpdates for the detail timeline, so not compact.
        updatesTail: 6,
      }) as Promise<{ subagents?: Array<Record<string, unknown>> } | undefined>,
      (
        rpc(client, "subagents.history", {
          limit: 300,
          ...(_filterTime !== "all" ? { since: Date.now() - sinceMs[_filterTime] } : {}),
        }) as Promise<{ history?: SubagentHistoryRow[] } | undefined>
      ).catch(() => undefined),
    ]);

    const live = Array.isArray(res?.subagents) ? res!.subagents! : [];
    const subs = mergeLiveAndHistory(live, Array.isArray(hist?.history) ? hist!.history! : []);
    let entries = subs
      .map(_projectSubagent)
      .filter((e): e is OversightEntry => e !== null);

    // Apply the time-range filter against finish time (server doesn't filter
    // the run spine the way it filters reviews).
    if (_filterTime !== "all") {
      const cutoff = Date.now() - sinceMs[_filterTime];
      entries = entries.filter((e) => _finishedAt(e) >= cutoff);
    }

    _entries = entries;
    _error = null;
  } catch (err) {
    _error = err instanceof Error ? err.message : String(err);
  } finally {
    _loading = false;
    requestUpdate();
  }
}

// ── Live updates: poll + WS ────────────────────────────────────────────────────

const _LIFECYCLE_EVENTS = new Set([
  "subagent.spawned",
  "subagent.complete",
  "subagent.error",
  "verification.completion",
  "subagent.timeout",
  "subagent.completed", // tolerate alternate spellings
  "subagent:completed",
  "session.completed",
  "session:completed",
]);

function _startLiveUpdates(): void {
  if (!_pollTimer) {
    _pollTimer = setInterval(() => {
      if (!document.hidden && _client && _requestUpdate) {
        void loadOversightReviews(_client, _requestUpdate);
      }
    }, 15_000);

    document.addEventListener(
      "visibilitychange",
      () => {
        if (!document.hidden && _client && _requestUpdate) {
          void loadOversightReviews(_client, _requestUpdate);
        }
      },
      { passive: true },
    );
  }

  // 1 s tick so running-row durations advance smoothly between polls.
  if (!_tickTimer) {
    _tickTimer = setInterval(() => {
      if (!document.hidden && _requestUpdate && _entries.some((e) => e.status === "running")) {
        _requestUpdate();
      }
    }, 1_000);
  }

  // WS lifecycle subscription for instant updates on transitions.
  if (!_wsUnsub && _client) {
    const sub = (_client as unknown as {
      subscribe?: (h: (evt: { event?: string }) => void) => () => void;
    }).subscribe;
    if (typeof sub === "function") {
      _wsUnsub = sub.call(_client, (evt: { event?: string }) => {
        if (evt?.event && _LIFECYCLE_EVENTS.has(evt.event) && _client && _requestUpdate) {
          void loadOversightReviews(_client, _requestUpdate);
        }
      });
    }
  }
}

// ── Filtering ─────────────────────────────────────────────────────────────────

function _applyFilters(entries: OversightEntry[]): OversightEntry[] {
  const q = _filterSearch.trim().toLowerCase();
  const proj = _filterProject.trim().toLowerCase();
  return entries
    .filter((e) => {
      if (_filterStatus !== "all" && e.status !== _filterStatus) return false;
      if (_filterDecision !== "all") {
        if (_filterDecision === "drift") {
          if (!e.review?.drift) return false;
        } else {
          // Reviews without an explicit decision are "pending".
          const d = e.review?.decision ?? (e.review ? "pending" : undefined);
          if (d !== _filterDecision) return false;
        }
      }
      if (_filterHasBlockers && !(e.review && e.review.blockers.length > 0) && e.status !== "errored" && e.status !== "blocked")
        return false;
      if (proj) {
        const projHay = `${e.kanbanTaskId ?? ""} ${e.review?.projectId ?? ""}`.toLowerCase();
        if (!projHay.includes(proj)) return false;
      }
      if (q) {
        const haystack = [
          e.label,
          e.task,
          e.review?.summary ?? "",
          e.runId,
          e.sessionKey,
          e.coderBackend ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      // Running first, then by most recent finish/activity.
      const ar = a.status === "running" ? 1 : 0;
      const br = b.status === "running" ? 1 : 0;
      if (ar !== br) return br - ar;
      return _finishedAt(b) - _finishedAt(a);
    });
}

// ── Formatters ────────────────────────────────────────────────────────────────

function _timeAgo(ts: number): string {
  if (!ts) return "—";
  const d = Date.now() - ts;
  if (d < 60_000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function _fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function _fmtCost(usd?: number): string {
  if (!usd) return "";
  if (usd < 0.01) return `<$0.01`;
  return `$${usd.toFixed(3)}`;
}

function _statusColor(s: OversightStatus): string {
  switch (s) {
    case "running":
      return "#38bdf8";
    case "completed":
      return "#22c55e";
    case "blocked":
      return "#f59e0b";
    case "errored":
      return "#ef4444";
    case "aborted":
      return "#71717a";
  }
}

function _statusLabel(s: OversightStatus): string {
  switch (s) {
    case "running":
      return "RUNNING";
    case "completed":
      return "COMPLETED";
    case "blocked":
      return "BLOCKED";
    case "errored":
      return "ERRORED";
    case "aborted":
      return "ABORTED";
  }
}

function _confidenceColor(c: number): string {
  if (c >= 0.8) return "#22c55e";
  if (c >= 0.5) return "#f59e0b";
  return "#ef4444";
}

function _decisionColor(d: DecisionFilter | "pending" | "approved" | "sent_back"): string {
  switch (d) {
    case "approved":
      return "#22c55e";
    case "sent_back":
      return "#ef4444";
    case "drift":
      return "#f97316";
    case "pending":
      return "#f59e0b";
    default:
      return "#a78bfa";
  }
}

function _decisionLabel(d: "pending" | "approved" | "sent_back"): string {
  return d === "approved" ? "Approved" : d === "sent_back" ? "Sent back" : "Pending";
}

/** Inline Approve / Send-back actions on a finished run's detail action bar. */
function _renderDecisionActions(review: AgentReview): TemplateResult {
  const runId = review.runId;
  const busy = _decideLoading.has(runId);
  const decision = review.decision ?? "pending";
  const approved = decision === "approved";
  const sentBack = decision === "sent_back";
  return html`
    <button
      class="ov-btn ov-btn--approve ${approved ? "ov-btn--on" : ""}"
      ?disabled=${busy || approved}
      title="Approve this run"
      @click=${() => void _decide(runId, "approved")}
    >
      ${ICO_CHECK} ${approved ? "Approved" : "Approve"}
    </button>
    <button
      class="ov-btn ov-btn--sendback ${sentBack ? "ov-btn--on" : ""}"
      ?disabled=${busy || sentBack}
      title="Send this run back for rework"
      @click=${() => void _decide(runId, "sent_back")}
    >
      ${ICO_BACK} ${sentBack ? "Sent back" : "Send back"}
    </button>
  `;
}

function _fmtClock(ts?: number): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "—";
  }
}

// ── Hash-based detail navigation ──────────────────────────────────────────────

function _getHashRunId(): string | null {
  const h = window.location.hash;
  if (h.startsWith("#review-")) return h.slice("#review-".length);
  return null;
}

function _setHashRunId(runId: string | null): void {
  // Oversight renders as a sub-tab of Reviews (/reviews?view=oversight): keep
  // the current path + query and only swap the hash.
  const url = new URL(window.location.href);
  url.hash = runId ? `review-${runId}` : "";
  window.history.replaceState(null, "", url.toString());
}

// ── Cross-surface navigation (link back to session / kanban task) ─────────────

function _navigateTab(tab: Parameters<typeof pathForTab>[0], hash?: string): void {
  try {
    const path = pathForTab(tab, _basePath) + (hash ?? "");
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  } catch {
    /* best-effort navigation */
  }
}

function _openSession(e: OversightEntry): void {
  // The sub-agent / activity surfaces own the run focus modal. Deep-link via a
  // run hash; the surface picks it up if present, otherwise just lands there.
  _navigateTab("subagents", `#run-${e.runId}`);
}

function _openKanbanTask(taskId: string): void {
  _navigateTab("projects", `#task-${taskId}`);
}

// ── Force re-review ───────────────────────────────────────────────────────────

async function _forceReview(runId: string): Promise<void> {
  if (_forceLoading.has(runId) || !_client || !_requestUpdate) return;
  _forceLoading.add(runId);
  _requestUpdate();
  try {
    const res = (await rpc(_client, "subagent_review_force", { runId })) as
      | { ok?: boolean; review?: AgentReview; error?: string }
      | AgentReview
      | undefined;
    let updated: AgentReview | undefined;
    if (!res || Array.isArray(res)) {
      // no-op
    } else if ("runId" in (res as Record<string, unknown>)) {
      updated = res as AgentReview;
    } else if ((res as { review?: AgentReview }).review) {
      updated = (res as { review?: AgentReview }).review;
    }
    if (updated) {
      _badgeByRunId.set(updated.runId, updated);
      if (updated.label) _badgeByLabel.set(updated.label.toLowerCase(), updated);
      // Re-attach the overlay to the matching entry.
      _entries = _entries.map((e) =>
        e.runId === updated!.runId ? { ...e, review: updated } : e,
      );
    }
  } catch (e) {
    console.error("[oversight] force review failed:", e);
  } finally {
    _forceLoading.delete(runId);
    _requestUpdate?.();
  }
}

// ── Oversight decision (inline approve / send-back) ───────────────────────────

/**
 * Record an operator decision on a review with optimistic UI + revert.
 * Patches the overlay immediately, fires the RPC, and rolls back on failure.
 */
async function _decide(runId: string, decision: "approved" | "sent_back"): Promise<void> {
  if (_decideLoading.has(runId) || !_client) return;
  const prev = _badgeByRunId.get(runId);
  if (!prev) return;

  _decideLoading.add(runId);
  // Optimistic: apply the decision locally right away.
  const optimistic = { ...prev, decision, decidedAt: Date.now() } as AgentReview;
  _badgeByRunId.set(runId, optimistic);
  _entries = _entries.map((e) => (e.runId === runId ? { ...e, review: optimistic } : e));
  _requestUpdate?.();

  try {
    const res = (await rpc(_client, "subagent_review_decide", { runId, decision })) as
      | { ok?: boolean; review?: AgentReview; error?: string }
      | undefined;
    if (!res || res.ok === false) {
      throw new Error(res?.error || "decision rejected");
    }
    const updated = res.review;
    if (updated) {
      _badgeByRunId.set(runId, updated);
      if (updated.label) _badgeByLabel.set(updated.label.toLowerCase(), updated);
      _entries = _entries.map((e) => (e.runId === runId ? { ...e, review: updated } : e));
    }
  } catch (e) {
    // Revert to the prior overlay on failure.
    console.error("[oversight] decide failed:", e);
    _badgeByRunId.set(runId, prev);
    _entries = _entries.map((e) => (e.runId === runId ? { ...e, review: prev } : e));
  } finally {
    _decideLoading.delete(runId);
    _requestUpdate?.();
  }
}

/** Run a sampler pass on demand, then reload so drift flags surface. */
async function _runSampler(): Promise<void> {
  if (_samplerRunning || !_client || !_requestUpdate) return;
  _samplerRunning = true;
  _requestUpdate();
  try {
    const res = (await rpc(_client, "oversight_sampler_run", { limit: 8 })) as
      | { ok?: boolean; sampledAt?: number; error?: string }
      | undefined;
    if (res?.sampledAt) _samplerLastRunAt = res.sampledAt;
    await loadOversightReviews(_client, _requestUpdate);
  } catch (e) {
    console.error("[oversight] sampler run failed:", e);
  } finally {
    _samplerRunning = false;
    _requestUpdate?.();
  }
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────

const ICO_FILTER = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>`;
const ICO_SEARCH = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
const ICO_FILE = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
const ICO_CHECK = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const ICO_RERUN = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`;
const ICO_BACK = html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
const ICO_CHEV = html`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const ICO_ALERT = html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
const ICO_BUILD_OK = html`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
const ICO_BUILD_FAIL = html`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
const ICO_LINK = html`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;
const ICO_EMPTY = html`<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.35"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;

// ── Main public API ───────────────────────────────────────────────────────────

export function renderOversightView(
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  _client = client;
  _requestUpdate = state.requestUpdate ? () => state.requestUpdate!() : null;
  _basePath = (state as { basePath?: string }).basePath ?? "";

  // Capture the current filter / expand / acked state on every render. Every
  // mutation funnels through requestUpdate → re-render, so this is the single
  // place that keeps the durable snapshot in sync (write is debounced).
  _persistState();

  // Initialize on first render
  if (!_pollTimer) {
    const ru = _requestUpdate ?? (() => {});
    void loadOversightReviews(client, ru);
    _startLiveUpdates();
  }

  const hashRunId = _getHashRunId();
  if (hashRunId) {
    const detail = _entries.find((r) => r.runId === hashRunId);
    return html`
      ${_oversightStyles()}
      <div class="ov-root" role="main" aria-label="Oversight">
        ${_renderDetailPage(detail ?? null, hashRunId, state)}
      </div>
    `;
  }

  return html`
    ${_oversightStyles()}
    <div class="ov-root" role="main" aria-label="Oversight">
      <div class="ov-layout">
        ${_renderRail(state)}
        <div class="ov-main" data-learn-id="oversight-main">
          ${_renderHeader(state)}
          <proactive-oversight-panel .client=${client}></proactive-oversight-panel>
          ${_renderListArea(state)}
        </div>
      </div>
    </div>
    <div aria-live="polite" aria-atomic="false" class="ov-live-region" id="ov-live"></div>
  `;
}

// ── Left rail ─────────────────────────────────────────────────────────────────

function _renderRail(state: AppViewState): TemplateResult {
  const ru = () => state.requestUpdate?.();
  const statuses: StatusFilter[] = ["all", "running", "completed", "blocked", "errored", "aborted"];
  return html`
    <aside class="ov-rail" aria-label="Filters" data-learn-id="oversight-filters">
      <div class="ov-rail-section">
        <div class="ov-rail-label">${ICO_FILTER} Status</div>
        ${statuses.map(
          (s) => html`
            <button
              class="ov-rail-chip ${_filterStatus === s ? "ov-rail-chip--active" : ""}"
              style="${_filterStatus === s && s !== "all"
                ? `color:${_statusColor(s)};border-color:${_statusColor(s)}55;background:${_statusColor(s)}15;`
                : ""}"
              @click=${() => {
                _filterStatus = s;
                ru();
              }}
              aria-pressed="${_filterStatus === s}"
            >
              ${s === "all" ? "All statuses" : _statusLabel(s)}
            </button>
          `,
        )}
      </div>

      <div class="ov-rail-section" data-learn-id="oversight-decisions">
        <div class="ov-rail-label">${ICO_CHECK} Oversight</div>
        ${(
          [
            ["all", "All"],
            ["pending", "Pending"],
            ["approved", "Approved"],
            ["sent_back", "Sent back"],
            ["drift", "Drift detected"],
          ] as Array<[DecisionFilter, string]>
        ).map(
          ([d, lbl]) => html`
            <button
              class="ov-rail-chip ${_filterDecision === d ? "ov-rail-chip--active" : ""}"
              style="${_filterDecision === d && d !== "all"
                ? `color:${_decisionColor(d)};border-color:${_decisionColor(d)}55;background:${_decisionColor(d)}15;`
                : ""}"
              @click=${() => {
                _filterDecision = d;
                ru();
              }}
              aria-pressed="${_filterDecision === d}"
            >
              ${lbl}
            </button>
          `,
        )}
        <button
          class="ov-rail-chip ${_samplerRunning ? "ov-btn--loading" : ""}"
          ?disabled=${_samplerRunning}
          @click=${() => void _runSampler()}
          title="Re-sample recently-closed runs and flag drift"
        >
          ${ICO_RERUN} ${_samplerRunning ? "Sampling…" : "Run sampler"}
        </button>
      </div>

      <div class="ov-rail-section">
        <div class="ov-rail-label">Time range</div>
        ${(["all", "1h", "24h", "7d"] as const).map(
          (t) => html`
            <button
              class="ov-rail-chip ${_filterTime === t ? "ov-rail-chip--active" : ""}"
              @click=${() => {
                _filterTime = t;
                void loadOversightReviews(_client!, ru);
              }}
              aria-pressed="${_filterTime === t}"
            >
              ${t === "all" ? "All time" : t === "1h" ? "Last hour" : t === "24h" ? "Last 24h" : "Last 7 days"}
            </button>
          `,
        )}
      </div>

      <div class="ov-rail-section">
        <div class="ov-rail-label">Refinements</div>
        <label class="ov-rail-toggle">
          <input
            type="checkbox"
            .checked=${_filterHasBlockers}
            @change=${(e: Event) => {
              _filterHasBlockers = (e.target as HTMLInputElement).checked;
              ru();
            }}
          />
          <span>Needs attention</span>
        </label>
      </div>

      <div class="ov-rail-section">
        <div class="ov-rail-label">Project / Task</div>
        <input
          type="text"
          class="ov-rail-input"
          placeholder="Filter by kanban task…"
          .value=${_filterProject}
          @input=${(e: Event) => {
            _filterProject = (e.target as HTMLInputElement).value;
            ru();
          }}
          aria-label="Filter by project or task"
        />
      </div>
    </aside>
  `;
}

// ── Header + search ───────────────────────────────────────────────────────────

function _renderHeader(state: AppViewState): TemplateResult {
  const ru = () => state.requestUpdate?.();
  const filtered = _applyFilters(_entries);
  const running = _entries.filter((e) => e.status === "running").length;
  return html`
    <div class="ov-hdr" data-learn-id="oversight-header">
      <div class="ov-hdr-left">
        <span class="ov-subtitle">
          ${_loading && _entries.length === 0
            ? "Loading…"
            : html`${filtered.length} run${filtered.length !== 1 ? "s" : ""}${running > 0
                  ? html` · <span style="color:#38bdf8;">${running} live</span>`
                  : nothing}`}
          ${_loading ? html`<span class="ov-spin" aria-label="Loading"></span>` : nothing}
        </span>
      </div>
      <div class="ov-search-wrap">
        <span class="ov-search-icon">${ICO_SEARCH}</span>
        <input
          type="search"
          class="ov-search"
          data-learn-id="oversight-search"
          placeholder="Search label, task, runId…"
          .value=${_filterSearch}
          @input=${(e: Event) => {
            _filterSearch = (e.target as HTMLInputElement).value;
            ru();
          }}
          aria-label="Search runs"
        />
      </div>
    </div>
  `;
}

// ── Run list ──────────────────────────────────────────────────────────────────

function _renderListArea(state: AppViewState): TemplateResult {
  const filtered = _applyFilters(_entries);

  if (_loading && _entries.length === 0) {
    return html`<div class="ov-list">${_renderSkeleton()}</div>`;
  }

  if (_error && _entries.length === 0) {
    return html`
      <div class="ov-empty">
        <span style="color:#ef4444;font-size:12px;font-weight:700;">Error loading runs</span>
        <p class="ov-empty-sub">${_error}</p>
        <button
          class="ov-btn"
          @click=${() => void loadOversightReviews(_client!, () => state.requestUpdate?.())}
        >
          Retry
        </button>
      </div>
    `;
  }

  if (_entries.length === 0) {
    return html`
      <div class="ov-empty">
        ${ICO_EMPTY}
        <p class="ov-empty-text">No sub-agent runs yet.</p>
        <p class="ov-empty-sub">
          Runs appear here automatically as soon as an agent is spawned, and stay for review when
          they finish.
        </p>
      </div>
    `;
  }

  if (filtered.length === 0) {
    return html`
      <div class="ov-empty">
        ${ICO_SEARCH}
        <p class="ov-empty-text">No runs match your filters.</p>
        <button
          class="ov-btn"
          @click=${() => {
            _filterSearch = "";
            _filterStatus = "all";
            _filterHasBlockers = false;
            _filterProject = "";
            state.requestUpdate?.();
          }}
        >
          Clear filters
        </button>
      </div>
    `;
  }

  return html`
    <div class="ov-list" role="list" aria-label="Runs">
      ${filtered.map((r) => _renderRow(r, state))}
    </div>
  `;
}

const _VERDICT_COLOR = { ok: "#4ade80", warn: "#fbbf24", bad: "#f87171", muted: "#9aa2b1" } as const;

function _renderRow(r: OversightEntry, state: AppViewState): TemplateResult {
  const expanded = _expandedIds.has(r.runId);
  const color = _statusColor(r.status);
  const ru = () => state.requestUpdate?.();
  const summary = r.review?.summary || r.task;

  return html`
    <div
      class="ov-row ${expanded ? "ov-row--expanded" : ""}"
      style="--ov-row-color:${color}"
      role="listitem"
    >
      <div
        class="ov-row-main"
        role="button"
        tabindex="0"
        aria-expanded="${expanded}"
        @click=${() => _toggleRow(r.runId, ru)}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            _toggleRow(r.runId, ru);
          }
        }}
      >
        <!-- Live dot for running -->
        ${r.status === "running"
          ? html`<span class="ov-live-dot" title="Running"></span>`
          : nothing}

        <!-- Backend / node badge -->
        ${r.remote && r.nodeName
          ? html`<span class="ov-proj-badge" title="Node ${r.nodeName}">${r.nodeName}</span>`
          : r.coderBackend
            ? html`<span class="ov-proj-badge" title="Backend ${r.coderBackend}">${r.coderBackend}</span>`
            : nothing}

        <!-- Label -->
        <span class="ov-row-label">${r.label}</span>

        <!-- Status pill -->
        <span
          class="ov-status-pill"
          style="color:${color};border-color:${color}44;background:${color}12;"
          >${_statusLabel(r.status)}</span
        >

        <!-- Verified-completion verdict -->
        ${r.review?.completion
          ? html`<span
              class="ov-status-pill"
              title="${r.review.completion.reasons.slice(0, 3).join(" · ") || "Claims checked against evidence"}"
              style="color:${_VERDICT_COLOR[verdictTone(r.review.completion.state)]};border-color:${_VERDICT_COLOR[verdictTone(r.review.completion.state)]}44;"
              >${r.review.completion.verdict}</span
            >`
          : nothing}

        <!-- Summary (1-line truncated) -->
        <span class="ov-row-summary">${summary || html`<em style="opacity:0.5">no brief</em>`}</span>

        <!-- Files count -->
        ${r.filesTouchedCount > 0
          ? html`<span class="ov-row-meta" title="${r.filesTouchedCount} files touched">
              ${ICO_FILE} ${r.filesTouchedCount}
            </span>`
          : nothing}

        <!-- Duration -->
        <span class="ov-row-meta" title="Duration">${_fmtDuration(r.durationMs)}</span>

        <!-- Exit reason / blockers indicator -->
        ${r.exitReason
          ? html`<span class="ov-blocker-badge" title="${r.exitReason}">${ICO_ALERT}</span>`
          : r.review && r.review.blockers.length > 0
            ? html`<span class="ov-blocker-badge" title="${r.review.blockers.length} blockers"
                >${ICO_ALERT} ${r.review.blockers.length}</span
              >`
            : nothing}

        <!-- Time ago -->
        <span class="ov-time-ago" title="${_fmtClock(_finishedAt(r))}">${_timeAgo(_finishedAt(r))}</span>

        <!-- Expand chevron -->
        <span class="ov-chev" style="transform:rotate(${expanded ? "180deg" : "0deg"})"
          >${ICO_CHEV}</span
        >
      </div>

      <!-- Expanded inline detail -->
      ${expanded ? html`<div class="ov-row-detail">${_renderInlineDetail(r, state)}</div>` : nothing}
    </div>
  `;
}

function _toggleRow(runId: string, ru: () => void): void {
  if (_expandedIds.has(runId)) {
    _expandedIds.delete(runId);
    _setHashRunId(null);
  } else {
    _expandedIds.add(runId);
    _setHashRunId(runId);
  }
  ru();
}

// ── Inline / detail rendering ─────────────────────────────────────────────────

function _renderInlineDetail(r: OversightEntry, state: AppViewState): TemplateResult {
  return html`
    <div class="ov-detail-inner">
      <div class="ov-detail-actions">
        <button
          class="ov-btn ov-btn--primary"
          @click=${() => {
            _setHashRunId(r.runId);
            state.requestUpdate?.();
          }}
        >
          Open full page →
        </button>
        ${_renderLinkButtons(r)}
        ${r.status !== "running"
          ? html`<button
              class="ov-btn ${_forceLoading.has(r.runId) ? "ov-btn--loading" : ""}"
              ?disabled=${_forceLoading.has(r.runId)}
              title="Run the auto-reviewer for this run"
              @click=${() => void _forceReview(r.runId)}
            >
              ${ICO_RERUN} ${_forceLoading.has(r.runId) ? "Reviewing…" : r.review ? "Re-review" : "Generate review"}
            </button>`
          : nothing}
      </div>

      ${_renderSectionSummary(r)}
      ${r.exitReason ? _renderSectionExit(r) : nothing}
      ${r.review && r.review.blockers.length > 0 ? _renderSectionBlockers(r.review) : nothing}
      ${r.review && r.review.nextSteps.length > 0 ? _renderSectionNextSteps(r.review, state) : nothing}
      ${r.recentUpdates.length > 0 ? _renderSectionTimeline(r) : nothing}
      ${r.review && r.review.filesTouched.length > 0 ? _renderSectionFiles(r.review, false) : nothing}
      ${_renderSectionMeta(r)}
    </div>
  `;
}

function _renderLinkButtons(r: OversightEntry): TemplateResult {
  return html`
    ${r.sessionKey
      ? html`<button class="ov-btn" title="Open originating session" @click=${() => _openSession(r)}>
          ${ICO_LINK} Session
        </button>`
      : nothing}
    ${r.kanbanTaskId
      ? html`<button
          class="ov-btn"
          title="Open kanban task ${r.kanbanTaskId}"
          @click=${() => _openKanbanTask(r.kanbanTaskId!)}
        >
          ${ICO_LINK} Kanban task
        </button>`
      : nothing}
  `;
}

function _renderDetailPage(
  r: OversightEntry | null,
  runId: string,
  state: AppViewState,
): TemplateResult {
  return html`
    <div class="ov-detail-page">
      <div class="ov-detail-topbar">
        <button
          class="ov-btn ov-back-btn"
          @click=${() => {
            _setHashRunId(null);
            state.requestUpdate?.();
          }}
        >
          ${ICO_BACK} All runs
        </button>

        ${r
          ? html`
              <span
                class="ov-status-pill"
                style="color:${_statusColor(r.status)};border-color:${_statusColor(r.status)}44;background:${_statusColor(r.status)}12;"
                >${_statusLabel(r.status)}</span
              >
              ${_renderLinkButtons(r)}
              ${r.status !== "running"
                ? html`<button
                    class="ov-btn ${_forceLoading.has(runId) ? "ov-btn--loading" : ""}"
                    ?disabled=${_forceLoading.has(runId)}
                    @click=${() => void _forceReview(runId)}
                  >
                    ${ICO_RERUN} ${_forceLoading.has(runId) ? "Reviewing…" : r.review ? "Re-review" : "Generate review"}
                  </button>`
                : nothing}
              ${r.review ? _renderDecisionActions(r.review) : nothing}
            `
          : nothing}
      </div>

      ${r
        ? html`
            <div class="ov-detail-content">
              <div class="ov-detail-heading">
                <h2 class="ov-detail-label">${r.label}</h2>
                <div class="ov-detail-meta-row">
                  ${r.coderBackend
                    ? html`<span class="ov-meta-chip">${r.coderBackend}</span>`
                    : nothing}
                  ${r.remote && r.nodeName
                    ? html`<span class="ov-meta-chip">@${r.nodeName}</span>`
                    : nothing}
                  <span class="ov-meta-chip">${_fmtDuration(r.durationMs)}</span>
                  <span class="ov-meta-chip">${_timeAgo(_finishedAt(r))}</span>
                  ${r.review
                    ? html`<span
                        class="ov-meta-chip"
                        style="color:${_decisionColor(r.review.decision ?? "pending")};border-color:${_decisionColor(r.review.decision ?? "pending")}55;"
                        >${_decisionLabel(r.review.decision ?? "pending")}</span
                      >`
                    : nothing}
                  ${r.review?.drift
                    ? html`<span
                        class="ov-meta-chip"
                        style="color:${_decisionColor("drift")};border-color:${_decisionColor("drift")}55;"
                        title="${r.review.driftNote ?? "Drift detected by oversight sampler"}"
                        >⚠ Drift</span
                      >`
                    : nothing}
                  ${r.review?.tokenCost
                    ? html`<span class="ov-meta-chip">${_fmtCost(r.review.tokenCost)}</span>`
                    : nothing}
                  ${r.review
                    ? html`<span
                          class="ov-conf-bar"
                          title="Confidence ${Math.round(r.review.confidence * 100)}%"
                        >
                          <span
                            style="width:${Math.round(r.review.confidence * 100)}%;background:${_confidenceColor(r.review.confidence)}"
                          ></span> </span
                        ><span class="ov-conf-label" style="color:${_confidenceColor(r.review.confidence)}">
                          ${Math.round(r.review.confidence * 100)}% conf.
                        </span>`
                    : nothing}
                </div>
              </div>

              ${r.review?.completion
                ? html`<completion-verdict
                    style="margin: 0 0 16px"
                    .completion=${r.review.completion}
                    .runId=${r.runId}
                    .client=${_client}
                    @verdict-decided=${() => {
                      // Bound call: passing state.requestUpdate unbound loses `this` (Lit throws).
                      if (_client) void loadOversightReviews(_client, () => state.requestUpdate?.());
                    }}
                  ></completion-verdict>`
                : nothing}
              ${_renderSectionSummary(r)}
              ${r.exitReason ? _renderSectionExit(r) : nothing}
              ${r.review && r.review.blockers.length > 0 ? _renderSectionBlockers(r.review) : nothing}
              ${r.review && r.review.nextSteps.length > 0
                ? _renderSectionNextSteps(r.review, state)
                : nothing}
              ${r.recentUpdates.length > 0 ? _renderSectionTimeline(r) : nothing}
              ${r.review && r.review.filesTouched.length > 0
                ? _renderSectionFiles(r.review, true)
                : nothing}
              ${r.review?.testsRun?.length ? _renderSectionTests(r.review) : nothing}
              ${_renderSectionMeta(r)}
            </div>
          `
        : html`
            <div class="ov-empty">
              <p class="ov-empty-text">Run not found.</p>
              <p class="ov-empty-sub">
                Run ID: ${runId}. It may have aged out of the live registry.
              </p>
              <button
                class="ov-btn"
                @click=${() => void loadOversightReviews(_client!, () => state.requestUpdate?.())}
              >
                Reload
              </button>
            </div>
          `}
    </div>
  `;
}

// ── Detail sections ───────────────────────────────────────────────────────────

function _renderSectionSummary(r: OversightEntry): TemplateResult {
  const text = r.review?.summary || r.task;
  return html`
    <div class="ov-section">
      <div class="ov-section-label">${r.review ? "Review summary" : "Task brief"}</div>
      <p class="ov-summary-text">
        ${text || html`<em style="opacity:0.5">No brief recorded for this run.</em>`}
      </p>
    </div>
  `;
}

function _renderSectionExit(r: OversightEntry): TemplateResult {
  const color = r.status === "errored" ? "#ef4444" : r.status === "aborted" ? "#71717a" : "#f59e0b";
  return html`
    <div class="ov-section">
      <div class="ov-section-label" style="color:${color};">Exit reason</div>
      <div
        class="ov-blocker-item"
        style="color:${color};border-color:${color}40;background:${color}12;border-left-color:${color};"
      >
        ${r.exitReason}
      </div>
    </div>
  `;
}

function _renderSectionTimeline(r: OversightEntry): TemplateResult {
  const updates = [...r.recentUpdates].sort((a, b) => b.timestamp - a.timestamp);
  return html`
    <div class="ov-section">
      <div class="ov-section-label">Recent activity</div>
      <div class="ov-tests-table">
        ${updates.map(
          (u) => html`
            <div class="ov-test-row">
              <span class="ov-test-name" style="flex:0 0 auto;color:rgba(245,245,244,0.5);">
                ${_timeAgo(u.timestamp)}
              </span>
              <span class="ov-test-name">${u.message || u.status}</span>
              ${typeof u.progress === "number"
                ? html`<span class="ov-row-meta">${u.progress}%</span>`
                : nothing}
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

function _renderSectionBlockers(r: AgentReview): TemplateResult {
  return html`
    <div class="ov-section">
      <div class="ov-section-label" style="color:#ef4444;">${ICO_ALERT} Blockers</div>
      <div class="ov-blockers-list">
        ${r.blockers.map((b) => html`<div class="ov-blocker-item">${b}</div>`)}
      </div>
    </div>
  `;
}

function _renderSectionNextSteps(r: AgentReview, state: AppViewState): TemplateResult {
  const acked = _acked.get(r.runId) ?? new Set<number>();
  return html`
    <div class="ov-section">
      <div class="ov-section-label">Next steps</div>
      <ul class="ov-steps-list" role="list">
        ${r.nextSteps.map((step, i) => {
          const done = acked.has(i);
          return html`
            <li class="ov-step-item ${done ? "ov-step-item--done" : ""}">
              <button
                class="ov-step-check ${done ? "ov-step-check--done" : ""}"
                role="checkbox"
                aria-checked="${done}"
                title="${done ? "Mark as pending" : "Mark as acknowledged"}"
                @click=${() => {
                  if (!_acked.has(r.runId)) _acked.set(r.runId, new Set());
                  const s = _acked.get(r.runId)!;
                  if (done) s.delete(i);
                  else s.add(i);
                  state.requestUpdate?.();
                }}
              >
                ${done ? ICO_CHECK : ""}
              </button>
              <span>${step}</span>
            </li>
          `;
        })}
      </ul>
    </div>
  `;
}

function _renderSectionFiles(r: AgentReview, showAll: boolean): TemplateResult {
  const MAX_COLLAPSED = 10;
  const files = r.filesTouched;
  const limit = showAll ? files.length : Math.min(files.length, MAX_COLLAPSED);
  const hidden = files.length - limit;

  return html`
    <div class="ov-section">
      <details class="ov-files-details" ?open=${showAll}>
        <summary class="ov-files-summary">${ICO_FILE} Files touched (${files.length})</summary>
        <div class="ov-files-list">
          ${files
            .slice(0, limit)
            .map(
              (f) => html`<div class="ov-file-row"><code class="ov-file-path">${f}</code></div>`,
            )}
          ${hidden > 0
            ? html`<div class="ov-file-row" style="opacity:0.55">+ ${hidden} more</div>`
            : nothing}
        </div>
      </details>
    </div>
  `;
}

function _renderSectionTests(r: AgentReview): TemplateResult {
  const tests = r.testsRun ?? [];
  const passed = tests.filter((t) => t.passed).length;
  const allPass = passed === tests.length;
  return html`
    <div class="ov-section">
      <div class="ov-section-label" style="color:${allPass ? "#22c55e" : "#ef4444"};">
        Tests — ${passed}/${tests.length} pass
      </div>
      <div class="ov-tests-table">
        ${tests.map(
          (t) => html`
            <div class="ov-test-row">
              <span class="ov-test-indicator" style="color:${t.passed ? "#22c55e" : "#ef4444"};">
                ${t.passed ? ICO_BUILD_OK : ICO_BUILD_FAIL}
              </span>
              <span class="ov-test-name">${t.name}</span>
              ${t.output
                ? html`<details class="ov-test-output-wrap">
                    <summary class="ov-test-output-toggle">output</summary>
                    <pre class="ov-test-output">${t.output}</pre>
                  </details>`
                : nothing}
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

function _renderSectionMeta(r: OversightEntry): TemplateResult {
  return html`
    <div class="ov-section">
      <div class="ov-section-label">Run details</div>
      <div class="ov-meta-grid">
        <div class="ov-meta-row"><span class="ov-meta-key">Run ID</span><code>${r.runId}</code></div>
        <div class="ov-meta-row">
          <span class="ov-meta-key">Session</span><code>${r.sessionKey || "—"}</code>
        </div>
        ${r.kanbanTaskId
          ? html`<div class="ov-meta-row">
              <span class="ov-meta-key">Kanban task</span><code>${r.kanbanTaskId}</code>
            </div>`
          : nothing}
        <div class="ov-meta-row">
          <span class="ov-meta-key">Started</span><span>${_fmtClock(r.startedAt || r.createdAt)}</span>
        </div>
        <div class="ov-meta-row">
          <span class="ov-meta-key">${r.endedAt ? "Ended" : "Last update"}</span
          ><span>${_fmtClock(r.endedAt || r.lastUpdateAt)}</span>
        </div>
        <div class="ov-meta-row">
          <span class="ov-meta-key">Backend</span><span>${r.coderBackend || "—"}${r.remote && r.nodeName ? ` @ ${r.nodeName}` : ""}</span>
        </div>
      </div>
    </div>
  `;
}

// ── Skeleton loading ──────────────────────────────────────────────────────────

function _renderSkeleton(): TemplateResult {
  return html`
    ${Array.from(
      { length: 5 },
      (_, i) => html`
        <div class="ov-skel" style="animation-delay:${i * 0.07}s">
          <div class="ov-skel-pill"></div>
          <div class="ov-skel-line" style="width:${50 + (i % 3) * 12}%"></div>
          <div class="ov-skel-line ov-skel-line--sm" style="width:${30 + (i % 2) * 15}%"></div>
        </div>
      `,
    )}
  `;
}

// ── Styles ────────────────────────────────────────────────────────────────────

function _oversightStyles(): TemplateResult {
  return html`<style>
    @keyframes ov-shimmer {
      0% {
        background-position: -400% 0;
      }
      100% {
        background-position: 400% 0;
      }
    }
    @keyframes ov-spin {
      to {
        transform: rotate(360deg);
      }
    }
    @keyframes ov-row-in {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    @keyframes ov-pulse {
      0%,
      100% {
        opacity: 1;
        transform: scale(1);
      }
      50% {
        opacity: 0.4;
        transform: scale(0.7);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .ov-skel,
      .ov-live-dot {
        animation: none !important;
      }
    }

    /* ── Root / layout ── */
    .ov-root {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      background: transparent;
      font-family: var(--g-body-family, inherit);
      color: var(--g-fg, rgba(245, 245, 244, 0.92));
    }
    .ov-live-region {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .ov-layout {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    /* ── Rail ── */
    .ov-rail {
      width: 220px;
      flex-shrink: 0;
      border-right: 1px solid var(--g-border, rgba(255, 255, 255, 0.08));
      overflow-y: auto;
      padding: 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.08) transparent;
    }
    .ov-rail-section {
      margin-bottom: 18px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .ov-rail-label {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--g-fg-faint, rgba(245, 245, 244, 0.4));
      margin-bottom: 5px;
    }
    .ov-rail-chip {
      width: 100%;
      text-align: left;
      background: none;
      border: 1px solid transparent;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.65));
      font-family: inherit;
      font-size: 11px;
      padding: 5px 9px;
      border-radius: 5px;
      cursor: pointer;
      transition: color 120ms, background 120ms, border-color 120ms;
    }
    .ov-rail-chip:hover {
      background: rgba(255, 255, 255, 0.06);
      color: var(--g-fg, rgba(245, 245, 244, 0.92));
    }
    .ov-rail-chip--active {
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.15);
      color: var(--g-fg, rgba(245, 245, 244, 0.92));
    }
    .ov-rail-toggle {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 11px;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.7));
      cursor: pointer;
      padding: 3px 0;
    }
    .ov-rail-toggle input[type="checkbox"] {
      accent-color: var(--g-primary, #fbbf24);
      width: 13px;
      height: 13px;
    }
    .ov-rail-input {
      width: 100%;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: 5px;
      color: var(--g-fg, rgba(245, 245, 244, 0.92));
      font-family: inherit;
      font-size: 11px;
      padding: 5px 8px;
      outline: none;
      transition: border-color 120ms;
      box-sizing: border-box;
    }
    .ov-rail-input:focus {
      border-color: var(--g-primary, #fbbf24);
    }
    .ov-rail-input::placeholder {
      color: rgba(255, 255, 255, 0.25);
    }

    /* ── Main ── */
    .ov-main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .ov-hdr {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 14px 20px 10px;
      border-bottom: 1px solid var(--g-border, rgba(255, 255, 255, 0.08));
    }
    .ov-hdr-left {
      display: flex;
      align-items: baseline;
      gap: 10px;
      flex-shrink: 0;
    }
    .ov-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--g-fg, rgba(245, 245, 244, 0.95));
      margin: 0;
    }
    .ov-subtitle {
      font-size: 11px;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.55));
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .ov-spin {
      display: inline-block;
      width: 10px;
      height: 10px;
      border: 1.5px solid rgba(255, 255, 255, 0.2);
      border-top-color: var(--g-primary, #fbbf24);
      border-radius: 50%;
      animation: ov-spin 0.7s linear infinite;
    }
    .ov-search-wrap {
      flex: 1;
      max-width: 380px;
      position: relative;
      display: flex;
      align-items: center;
    }
    .ov-search-icon {
      position: absolute;
      left: 9px;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.4));
      display: flex;
      pointer-events: none;
    }
    .ov-search {
      width: 100%;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: 6px;
      color: var(--g-fg, rgba(245, 245, 244, 0.92));
      font-family: inherit;
      font-size: 12px;
      padding: 7px 10px 7px 30px;
      outline: none;
      transition: border-color 120ms;
    }
    .ov-search:focus {
      border-color: var(--g-primary, #fbbf24);
    }
    .ov-search::placeholder {
      color: rgba(255, 255, 255, 0.25);
    }

    /* ── List ── */
    .ov-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px 16px 16px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.08) transparent;
    }

    /* ── Row ── */
    .ov-row {
      border-radius: 7px;
      border: 1px solid transparent;
      transition: border-color 150ms, background 150ms;
      animation: ov-row-in 0.2s ease-out;
    }
    .ov-row:hover,
    .ov-row--expanded {
      background: rgba(255, 255, 255, 0.035);
      border-color: rgba(255, 255, 255, 0.1);
    }
    .ov-row--expanded {
      border-color: color-mix(in srgb, var(--ov-row-color, #22c55e) 30%, rgba(255, 255, 255, 0.1));
    }

    .ov-row-main {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 12px;
      cursor: pointer;
      min-width: 0;
      border-radius: 7px;
    }
    .ov-row-main:focus-visible {
      outline: 2px solid var(--g-primary, #fbbf24);
      outline-offset: -2px;
    }

    .ov-live-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #38bdf8;
      flex-shrink: 0;
      animation: ov-pulse 1.4s ease-in-out infinite;
    }

    .ov-proj-badge {
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.08em;
      font-family: var(--g-mono-family, "JetBrains Mono", monospace);
      color: #a855f7;
      background: rgba(168, 85, 247, 0.12);
      border: 1px solid rgba(168, 85, 247, 0.28);
      border-radius: 3px;
      padding: 1px 5px;
      flex-shrink: 0;
      max-width: 90px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ov-row-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--g-fg, rgba(245, 245, 244, 0.92));
      flex-shrink: 0;
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .ov-status-pill {
      font-size: 8px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      font-family: var(--g-mono-family, "JetBrains Mono", monospace);
      padding: 2px 7px;
      border: 1px solid;
      border-radius: 4px;
      flex-shrink: 0;
      line-height: 1.5;
    }

    .ov-row-summary {
      flex: 1;
      font-size: 11px;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.6));
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }

    .ov-row-meta {
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 10px;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.5));
      flex-shrink: 0;
      font-family: var(--g-mono-family, "JetBrains Mono", monospace);
    }

    .ov-blocker-badge {
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 10px;
      font-weight: 700;
      color: #ef4444;
      flex-shrink: 0;
    }

    .ov-time-ago {
      font-size: 10px;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.45));
      flex-shrink: 0;
      font-family: var(--g-mono-family, "JetBrains Mono", monospace);
      min-width: 52px;
      text-align: right;
    }
    .ov-chev {
      flex-shrink: 0;
      color: var(--g-fg-faint, rgba(245, 245, 244, 0.3));
      transition: transform 200ms ease;
      display: flex;
    }

    /* ── Expanded row detail ── */
    .ov-row-detail {
      border-top: 1px solid var(--g-border, rgba(255, 255, 255, 0.07));
      animation: ov-row-in 0.2s ease-out;
    }
    .ov-detail-inner {
      padding: 12px 16px 16px;
    }

    /* ── Detail page ── */
    .ov-detail-page {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    .ov-detail-topbar {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      padding: 12px 20px;
      border-bottom: 1px solid var(--g-border, rgba(255, 255, 255, 0.08));
    }
    .ov-back-btn {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .ov-detail-content {
      flex: 1;
      overflow-y: auto;
      padding: 20px 24px;
      display: flex;
      flex-direction: column;
      gap: 0;
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.08) transparent;
    }
    .ov-detail-heading {
      margin-bottom: 20px;
    }
    .ov-detail-label {
      font-size: 17px;
      font-weight: 700;
      color: var(--g-fg, rgba(245, 245, 244, 0.95));
      margin: 0 0 8px;
      line-height: 1.3;
    }
    .ov-detail-meta-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .ov-meta-chip {
      font-size: 10px;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.55));
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 4px;
      padding: 2px 7px;
      font-family: var(--g-mono-family, "JetBrains Mono", monospace);
    }
    .ov-conf-bar {
      width: 60px;
      height: 5px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 3px;
      overflow: hidden;
    }
    .ov-conf-bar > span {
      display: block;
      height: 100%;
      border-radius: 3px;
      transition: width 300ms ease;
    }
    .ov-conf-label {
      font-size: 10px;
      font-weight: 700;
      font-family: var(--g-mono-family, "JetBrains Mono", monospace);
    }

    /* ── Shared sections ── */
    .ov-section {
      margin-bottom: 20px;
    }
    .ov-section-label {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--g-fg-faint, rgba(245, 245, 244, 0.4));
      margin-bottom: 8px;
    }
    .ov-summary-text {
      font-size: 12.5px;
      color: var(--g-fg, rgba(245, 245, 244, 0.85));
      line-height: 1.65;
      margin: 0;
    }
    .ov-blockers-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .ov-blocker-item {
      font-size: 12px;
      color: #fca5a5;
      background: rgba(239, 68, 68, 0.08);
      border: 1px solid rgba(239, 68, 68, 0.25);
      border-left: 3px solid #ef4444;
      border-radius: 0 6px 6px 0;
      padding: 8px 12px;
      line-height: 1.5;
    }
    .ov-steps-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .ov-step-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      font-size: 12px;
      color: var(--g-fg, rgba(245, 245, 244, 0.82));
      padding: 4px 0;
      line-height: 1.5;
    }
    .ov-step-item--done {
      opacity: 0.45;
      text-decoration: line-through;
    }
    .ov-step-check {
      width: 16px;
      height: 16px;
      min-width: 16px;
      border: 1.5px solid rgba(255, 255, 255, 0.25);
      border-radius: 3px;
      background: none;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: border-color 120ms, background 120ms;
      color: #22c55e;
      margin-top: 1px;
      padding: 0;
    }
    .ov-step-check--done {
      background: rgba(34, 197, 94, 0.15);
      border-color: rgba(34, 197, 94, 0.6);
    }
    .ov-step-check:hover {
      border-color: rgba(255, 255, 255, 0.55);
    }

    /* ── Files section ── */
    .ov-files-details {
      display: block;
    }
    .ov-files-summary {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--g-fg-faint, rgba(245, 245, 244, 0.4));
      cursor: pointer;
      padding: 4px 0 8px;
      list-style: none;
      transition: color 120ms;
    }
    .ov-files-summary::-webkit-details-marker {
      display: none;
    }
    .ov-files-summary:hover {
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.6));
    }
    .ov-files-list {
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.08));
      border-radius: 6px;
      overflow: hidden;
    }
    .ov-file-row {
      padding: 5px 10px;
      font-size: 10.5px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    }
    .ov-file-row:last-child {
      border-bottom: none;
    }
    .ov-file-path {
      font-family: var(--g-mono-family, "JetBrains Mono", monospace);
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.7));
      font-size: 10px;
    }

    /* ── Tests / timeline ── */
    .ov-tests-table {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .ov-test-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 8px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.025);
    }
    .ov-test-indicator {
      display: flex;
      flex-shrink: 0;
    }
    .ov-test-name {
      font-size: 11px;
      font-family: var(--g-mono-family, "JetBrains Mono", monospace);
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.75));
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ov-test-output-wrap details {
      margin-left: auto;
    }
    .ov-test-output-toggle {
      font-size: 9px;
      cursor: pointer;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.4));
    }
    .ov-test-output {
      font-size: 9px;
      font-family: var(--g-mono-family, "JetBrains Mono", monospace);
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.65));
      background: rgba(0, 0, 0, 0.2);
      border-radius: 4px;
      padding: 6px 8px;
      margin: 4px 0 0;
      overflow-x: auto;
      white-space: pre;
    }

    /* ── Meta grid ── */
    .ov-meta-grid {
      display: flex;
      flex-direction: column;
      gap: 4px;
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.08));
      border-radius: 6px;
      padding: 8px 12px;
    }
    .ov-meta-row {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 10.5px;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.7));
    }
    .ov-meta-row code {
      font-family: var(--g-mono-family, "JetBrains Mono", monospace);
      font-size: 10px;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.65));
      word-break: break-all;
    }
    .ov-meta-key {
      flex: 0 0 90px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--g-fg-faint, rgba(245, 245, 244, 0.4));
    }

    /* ── Action buttons ── */
    .ov-detail-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .ov-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.8));
      font-family: inherit;
      font-size: 11px;
      font-weight: 500;
      padding: 6px 13px;
      cursor: pointer;
      transition: color 120ms, border-color 120ms, background 120ms;
    }
    .ov-btn:hover:not(:disabled) {
      color: var(--g-fg, rgba(245, 245, 244, 0.95));
      border-color: rgba(255, 255, 255, 0.28);
      background: rgba(255, 255, 255, 0.09);
    }
    .ov-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .ov-btn--primary {
      color: var(--g-primary, #fbbf24);
      border-color: rgba(251, 191, 36, 0.4);
      background: rgba(251, 191, 36, 0.07);
    }
    .ov-btn--primary:hover {
      color: var(--g-primary, #fbbf24);
      border-color: rgba(251, 191, 36, 0.65);
      background: rgba(251, 191, 36, 0.12);
    }
    .ov-btn--loading {
      opacity: 0.7;
      cursor: progress;
    }
    .ov-btn--approve {
      color: #22c55e;
      border-color: rgba(34, 197, 94, 0.4);
      background: rgba(34, 197, 94, 0.07);
    }
    .ov-btn--approve:hover:not(:disabled) {
      border-color: rgba(34, 197, 94, 0.7);
      background: rgba(34, 197, 94, 0.13);
    }
    .ov-btn--sendback {
      color: #ef4444;
      border-color: rgba(239, 68, 68, 0.4);
      background: rgba(239, 68, 68, 0.07);
    }
    .ov-btn--sendback:hover:not(:disabled) {
      border-color: rgba(239, 68, 68, 0.7);
      background: rgba(239, 68, 68, 0.13);
    }
    .ov-btn--on {
      font-weight: 700;
    }

    /* ── Empty state ── */
    .ov-empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 60px 24px;
      text-align: center;
    }
    .ov-empty-text {
      font-size: 14px;
      font-weight: 500;
      color: var(--g-fg-dim, rgba(245, 245, 244, 0.65));
      margin: 0;
    }
    .ov-empty-sub {
      font-size: 11.5px;
      color: var(--g-fg-faint, rgba(245, 245, 244, 0.4));
      margin: 0;
      max-width: 320px;
      line-height: 1.5;
    }

    /* ── Skeleton ── */
    .ov-skel {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.025);
      margin-bottom: 2px;
      animation: ov-shimmer 1.4s ease infinite;
      background-image: linear-gradient(
        90deg,
        rgba(255, 255, 255, 0.025) 25%,
        rgba(255, 255, 255, 0.06) 50%,
        rgba(255, 255, 255, 0.025) 75%
      );
      background-size: 400% 100%;
    }
    .ov-skel-pill {
      width: 60px;
      height: 16px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.07);
      flex-shrink: 0;
    }
    .ov-skel-line {
      height: 12px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.06);
    }
    .ov-skel-line--sm {
      height: 10px;
    }
  </style>`;
}

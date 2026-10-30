/**
 * AgentRunReview — an in-depth, durable review record captured for EVERY
 * agent/task run (CLI coder agents, native gateway agents, subagents).
 *
 * This is a CONTRACT shared with the Review-page UI agent: the gateway
 * `agents.reviews.*` methods return records of exactly this shape and the UI
 * renders them field-for-field. Do NOT rename fields — add optional ones only.
 *
 * Distinct from the older `AgentReview` (src/agents/reviews/) which powers the
 * operator Oversight decision feed (approve / send-back). This record is the
 * rich, look-back-any-time review with an AGENT-WRITTEN markdown summary.
 */

export type AgentKind = "cli" | "native" | "subagent";

/**
 * Build/outcome status.
 *   built        — ran to completion AND we captured positive build evidence
 *   not_built    — completed but no build/compile succeeded (or none was run)
 *   partial      — ended in error yet touched files (some work landed)
 *   failed       — ended in error with no meaningful work
 *   in_progress  — captured while still running (rare; snapshot)
 */
export type RunReviewStatus = "built" | "not_built" | "partial" | "failed" | "in_progress";

export type FileChangeKind = "added" | "modified" | "deleted";

export type IssueSeverity = "info" | "warning" | "error";

export type ForwardActionKind = "respawn" | "verify" | "open_pr" | "followup" | "custom";

export type RunReviewFile = {
  path: string;
  changeKind: FileChangeKind;
  linesAdded?: number;
  linesRemoved?: number;
};

export type RunReviewAction = {
  ts: number;
  kind: string;
  detail: string;
};

export type RunReviewIssue = {
  severity: IssueSeverity;
  text: string;
};

export type RunReviewForwardAction = {
  label: string;
  kind: ForwardActionKind;
  payload?: Record<string, unknown>;
};

/** A kanban move the verification reconciler made for this run (activity feed). */
export type RunReviewKanbanUpdate = {
  taskId: string;
  title?: string;
  relation: "primary" | "referenced" | "respawn-original" | "suggested";
  from?: string;
  to?: string;
  blocked?: boolean;
  outcome: "applied" | "dry-run" | "skipped" | "failed";
  reason?: string;
  state: string;
  at: number;
};

export type AgentRunReview = {
  /** Unique review id (uuid), generated at capture time. */
  id: string;
  /** Run id from the subagent registry. Primary dedup key. */
  runId: string;
  /** Task id, when the run was spawned from a task. */
  taskId?: string;
  /** Kanban card id, when the run was tied to a kanban task. */
  kanbanTaskId?: string;
  /** Project the run belongs to. */
  projectId?: string;

  /** Human-facing title (label or first line of the task). */
  title: string;
  agentKind: AgentKind;
  /** Coder backend when applicable (claude-code | opencode | codex | gemini). */
  backend?: string;
  /** Model id when known. */
  model?: string;

  status: RunReviewStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;

  /** AGENT-WRITTEN stylish markdown: what was done, why, key decisions. */
  summaryMarkdown: string;

  filesTouched: RunReviewFile[];
  /** Condensed timeline of meaningful steps / tool calls. */
  actions: RunReviewAction[];
  issues: RunReviewIssue[];

  /** Did it compile / build? */
  built: boolean;
  /** Evidence line(s) backing the `built` verdict. */
  buildEvidence?: string;

  forwardActions: RunReviewForwardAction[];

  tokensUsed?: number;
  cost?: number;

  /** Kanban tasks the verification step moved for this run (Done / Review / Blocked). */
  kanbanUpdates?: RunReviewKanbanUpdate[];
};

export const RUN_REVIEW_STATUSES: ReadonlyArray<RunReviewStatus> = [
  "built",
  "not_built",
  "partial",
  "failed",
  "in_progress",
];

const AGENT_KINDS: ReadonlyArray<AgentKind> = ["cli", "native", "subagent"];
const CHANGE_KINDS: ReadonlyArray<FileChangeKind> = ["added", "modified", "deleted"];
const SEVERITIES: ReadonlyArray<IssueSeverity> = ["info", "warning", "error"];
const FORWARD_KINDS: ReadonlyArray<ForwardActionKind> = [
  "respawn",
  "verify",
  "open_pr",
  "followup",
  "custom",
];

export function isValidRunReviewStatus(s: unknown): s is RunReviewStatus {
  return typeof s === "string" && RUN_REVIEW_STATUSES.includes(s as RunReviewStatus);
}

function coerceChangeKind(raw: unknown): FileChangeKind {
  return typeof raw === "string" && CHANGE_KINDS.includes(raw as FileChangeKind)
    ? (raw as FileChangeKind)
    : "modified";
}

function num(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function nonNegNum(raw: unknown): number | undefined {
  const n = num(raw);
  return n === undefined ? undefined : Math.max(0, n);
}

function parseFile(raw: unknown): RunReviewFile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.path !== "string" || !r.path) return null;
  return {
    path: r.path,
    changeKind: coerceChangeKind(r.changeKind),
    linesAdded: nonNegNum(r.linesAdded),
    linesRemoved: nonNegNum(r.linesRemoved),
  };
}

function parseAction(raw: unknown): RunReviewAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ts = num(r.ts);
  if (ts === undefined) return null;
  return {
    ts,
    kind: typeof r.kind === "string" ? r.kind : "step",
    detail: typeof r.detail === "string" ? r.detail : "",
  };
}

function parseIssue(raw: unknown): RunReviewIssue | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.text !== "string" || !r.text) return null;
  const severity: IssueSeverity =
    typeof r.severity === "string" && SEVERITIES.includes(r.severity as IssueSeverity)
      ? (r.severity as IssueSeverity)
      : "info";
  return { severity, text: r.text };
}

function parseForwardAction(raw: unknown): RunReviewForwardAction | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.label !== "string" || !r.label) return null;
  const kind: ForwardActionKind =
    typeof r.kind === "string" && FORWARD_KINDS.includes(r.kind as ForwardActionKind)
      ? (r.kind as ForwardActionKind)
      : "custom";
  const payload =
    r.payload && typeof r.payload === "object" ? (r.payload as Record<string, unknown>) : undefined;
  return { label: r.label, kind, payload };
}

/** Runtime guard used in handler validation + tests. */
export function isValidAgentRunReview(obj: unknown): obj is AgentRunReview {
  if (!obj || typeof obj !== "object") return false;
  const r = obj as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    r.id.length > 0 &&
    typeof r.runId === "string" &&
    r.runId.length > 0 &&
    typeof r.title === "string" &&
    typeof r.agentKind === "string" &&
    AGENT_KINDS.includes(r.agentKind as AgentKind) &&
    isValidRunReviewStatus(r.status) &&
    typeof r.startedAt === "number" &&
    typeof r.summaryMarkdown === "string" &&
    Array.isArray(r.filesTouched) &&
    Array.isArray(r.actions) &&
    Array.isArray(r.issues) &&
    typeof r.built === "boolean" &&
    Array.isArray(r.forwardActions)
  );
}

/** Parse + coerce a raw object into an AgentRunReview. Returns null on failure. */
export function parseAgentRunReview(raw: unknown): AgentRunReview | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  if (typeof r.runId !== "string" || !r.runId) return null;
  if (!isValidRunReviewStatus(r.status)) return null;
  const startedAt = num(r.startedAt);
  if (startedAt === undefined) return null;

  const agentKind: AgentKind = AGENT_KINDS.includes(r.agentKind as AgentKind)
    ? (r.agentKind as AgentKind)
    : "subagent";

  return {
    id: r.id,
    runId: r.runId,
    taskId: typeof r.taskId === "string" ? r.taskId : undefined,
    kanbanTaskId: typeof r.kanbanTaskId === "string" ? r.kanbanTaskId : undefined,
    projectId: typeof r.projectId === "string" ? r.projectId : undefined,
    title: typeof r.title === "string" ? r.title : "",
    agentKind,
    backend: typeof r.backend === "string" ? r.backend : undefined,
    model: typeof r.model === "string" ? r.model : undefined,
    status: r.status as RunReviewStatus,
    startedAt,
    finishedAt: num(r.finishedAt),
    durationMs: num(r.durationMs),
    summaryMarkdown: typeof r.summaryMarkdown === "string" ? r.summaryMarkdown : "",
    filesTouched: Array.isArray(r.filesTouched)
      ? r.filesTouched.map(parseFile).filter((f): f is RunReviewFile => f !== null)
      : [],
    actions: Array.isArray(r.actions)
      ? r.actions.map(parseAction).filter((a): a is RunReviewAction => a !== null)
      : [],
    issues: Array.isArray(r.issues)
      ? r.issues.map(parseIssue).filter((i): i is RunReviewIssue => i !== null)
      : [],
    built: r.built === true,
    buildEvidence: typeof r.buildEvidence === "string" ? r.buildEvidence : undefined,
    forwardActions: Array.isArray(r.forwardActions)
      ? r.forwardActions
          .map(parseForwardAction)
          .filter((a): a is RunReviewForwardAction => a !== null)
      : [],
    tokensUsed: num(r.tokensUsed),
    cost: num(r.cost),
    ...(Array.isArray(r.kanbanUpdates)
      ? {
          kanbanUpdates: r.kanbanUpdates.filter(
            (u): u is RunReviewKanbanUpdate =>
              Boolean(u) &&
              typeof u === "object" &&
              typeof (u as RunReviewKanbanUpdate).taskId === "string" &&
              typeof (u as RunReviewKanbanUpdate).at === "number",
          ),
        }
      : {}),
  };
}

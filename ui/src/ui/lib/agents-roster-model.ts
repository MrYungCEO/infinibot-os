/**
 * Agents page data model — pure shaping, no DOM, no gateway calls.
 *
 * Joins the configured roster (config.get → agents.list, incl. plugin agents
 * tagged `_plugin`) with real activity: verification completion records
 * (verdicts), the sub-agent history archive, the live sub-agent registry,
 * sessions and credits. Every number here is derived from those inputs; when
 * an input is missing the value is `null` and the UI shows "—".
 *
 * Consumers: views/agents-premium.ts (rail, KPI strip, cards, drawer) and
 * lib/agents-constellation-engine.ts (via buildConstellationScene).
 */

// ─── Inputs ──────────────────────────────────────────────────────────────

/** Roster entry as the page needs it (a subset of AgentListEntry). */
export interface RosterAgentInput {
  id: string;
  name: string;
  type: "native" | "cli";
  model: string;
  cliCommand?: string;
  plugin?: string | null;
  seedVersion?: string | null;
  isDefault?: boolean;
  isDisabled?: boolean;
  /** subagents.allowAgents — who this agent may delegate to. */
  subagents?: string[];
  avatarUrl?: string;
  description?: string;
}

/** Slice of agents.knowledge.profile used for roles, teams and liveness. */
export interface AgentProfileLite {
  id: string;
  department?: string | null;
  description?: string | null;
  emoji?: string | null;
  modelPrimary?: string | null;
  backendPrimary?: string | null;
  lastActiveAt?: number | null;
}

/** Terminal + in-flight states across all run sources. */
export type RunState =
  | "running"
  | "reviewing"
  | "continuing"
  | "interrupted"
  | "verified"
  | "accepted"
  | "unverified"
  | "failed"
  | "rejected"
  | "stalled"
  | "blocked"
  | "needs_input"
  | "needs_owner"
  /** History archive only (no verification record): finished cleanly. */
  | "complete"
  | "error"
  | "timeout";

export interface RunLite {
  runId: string;
  label: string;
  task: string;
  /** Agent whose session ran the work (childSessionKey `agent:<id>:…`). */
  agentId: string | null;
  /** Agent that asked for the run (requesterSessionKey `agent:<id>:…`). */
  requesterAgentId: string | null;
  /** CLI coder backend (claude-code / codex / opencode / gemini) when known. */
  backend: string | null;
  model: string | null;
  state: RunState;
  startedAt: number | null;
  endedAt: number | null;
  source: "verification" | "history" | "live";
  progress?: number | null;
  lastActivity?: string | null;
  /** Time actually spent working (sum of attempts), when known. */
  durationMs?: number | null;
  /** Review reasons (verification) or the error text (history). */
  reasons?: string[];
  childSessionKey?: string | null;
}

export interface SpendRow {
  key: string;
  tokens: number;
  costUsd: number;
  requests: number;
}

// ─── Constants ───────────────────────────────────────────────────────────

export const RUNNING_STATES: ReadonlySet<RunState> = new Set([
  "running",
  "reviewing",
  "continuing",
]);
export const VERIFIED_STATES: ReadonlySet<RunState> = new Set(["verified", "accepted"]);
export const FAILED_STATES: ReadonlySet<RunState> = new Set([
  "failed",
  "rejected",
  "stalled",
  "error",
  "timeout",
]);
export const BLOCKED_STATES: ReadonlySet<RunState> = new Set([
  "blocked",
  "needs_input",
  "needs_owner",
]);
/** States that carry a verification verdict (the success-rate denominator). */
export const JUDGED_STATES: ReadonlySet<RunState> = new Set([
  "verified",
  "accepted",
  "unverified",
  "failed",
  "rejected",
  "stalled",
  "blocked",
  "needs_input",
  "needs_owner",
]);

const KNOWN_RUN_STATES: ReadonlySet<string> = new Set([
  ...RUNNING_STATES,
  ...VERIFIED_STATES,
  ...FAILED_STATES,
  ...BLOCKED_STATES,
  "unverified",
  "interrupted",
  "complete",
]);

/** CLI coder backend → the `cliCommand` a configured CLI agent would use. */
export const BACKEND_CLI_COMMAND: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini",
  grok: "grok",
};

export const BACKEND_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
  grok: "Grok Build",
};

const DAY_MS = 86_400_000;
/** Longest believable single attempt; longer spans come from liveness sweeps. */
export const MAX_ATTEMPT_MS = DAY_MS;
/** A session updated this recently counts as "working". */
export const ACTIVE_SESSION_MS = 120_000;
/** Blocked/error colouring only applies to recent outcomes. */
const RECENT_OUTCOME_MS = DAY_MS;

// ─── Small helpers ───────────────────────────────────────────────────────

/** `agent:<id>:…` → `<id>`; anything else → null. */
export function agentIdFromSessionKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const parts = key.split(":");
  if (parts[0] !== "agent" || !parts[1]) return null;
  return parts[1];
}

export function startOfLocalDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** "content-studio" → "Content Studio". */
export function prettyId(id: string): string {
  return id
    .split(/[-_:.\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Up to two letters for the avatar monogram. */
export function monogram(name: string): string {
  const clean = name.replace(/[^\p{L}\p{N}\s-]/gu, " ").trim();
  if (!clean) return "?";
  const words = clean.split(/[\s-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

/** Last path segment of a provider/model id: "ollama-cloud/gpt-oss:120b" → "gpt-oss:120b". */
export function shortModel(model: string | null | undefined): string {
  if (!model) return "";
  const i = model.lastIndexOf("/");
  return i >= 0 ? model.slice(i + 1) : model;
}

// ─── Run normalisation ───────────────────────────────────────────────────

function asRunState(v: unknown, fallback: RunState): RunState {
  return typeof v === "string" && KNOWN_RUN_STATES.has(v) ? (v as RunState) : fallback;
}

/** verification.list record → RunLite. */
export function normalizeVerificationRecord(rec: Record<string, unknown>): RunLite | null {
  const runId = str(rec.runId);
  if (!runId) return null;
  const review = rec.review as { reasons?: unknown } | null | undefined;
  const reasons = Array.isArray(review?.reasons)
    ? (review!.reasons as unknown[]).filter((r): r is string => typeof r === "string")
    : undefined;
  // terminalAt can land long after the work (operator decisions, reopened
  // rounds), so duration = the sum of the attempts' own start→end spans.
  // Spans over MAX_ATTEMPT_MS are liveness-sweep artefacts (a dead run marked
  // failed days later), and interrupted attempts never finished — skip both.
  let durationMs: number | null = null;
  if (Array.isArray(rec.attempts)) {
    for (const a of rec.attempts as Array<{ startedAt?: unknown; endedAt?: unknown; kind?: unknown }>) {
      const st = num(a?.startedAt);
      const en = num(a?.endedAt);
      if (st === null || en === null || en < st || a?.kind === "interrupted") continue;
      if (en - st > MAX_ATTEMPT_MS) continue;
      durationMs = (durationMs ?? 0) + (en - st);
    }
  }
  return {
    runId,
    label: str(rec.label) || runId,
    task: str(rec.task),
    durationMs,
    agentId: agentIdFromSessionKey(rec.childSessionKey),
    requesterAgentId: agentIdFromSessionKey(rec.requesterSessionKey),
    backend: str(rec.backend) || null,
    model: str(rec.model) || null,
    state: asRunState(rec.state, "running"),
    startedAt: num(rec.startedAt),
    endedAt: num(rec.terminalAt),
    source: "verification",
    reasons,
    childSessionKey: str(rec.childSessionKey) || null,
  };
}

/** subagents.history entry → RunLite. */
export function normalizeHistoryEntry(h: Record<string, unknown>): RunLite | null {
  const runId = str(h.runId);
  if (!runId) return null;
  const status = str(h.status);
  const state: RunState =
    status === "complete" ? "complete" : status === "timeout" ? "timeout" : "error";
  const err = str(h.error) || str((h.outcome as { error?: unknown } | undefined)?.error);
  return {
    runId,
    label: str(h.label) || runId,
    task: str(h.task),
    agentId: agentIdFromSessionKey(h.childSessionKey),
    requesterAgentId: agentIdFromSessionKey(h.requesterSessionKey),
    backend: str(h.coderBackend) || null,
    model: null,
    state,
    startedAt: num(h.startedAt),
    endedAt: num(h.endedAt),
    source: "history",
    reasons: err ? [err] : undefined,
    childSessionKey: str(h.childSessionKey) || null,
  };
}

/** subagents.list row → RunLite (live registry; no requester on this shape). */
export function normalizeLiveRun(s: Record<string, unknown>): RunLite | null {
  const runId = str(s.runId);
  if (!runId) return null;
  const ended = num(s.endedAt);
  const status = str(s.status);
  const outcome = str((s.outcome as { status?: unknown } | undefined)?.status);
  let state: RunState = "running";
  if (ended || status === "completed" || status === "complete") {
    state = outcome === "error" || outcome === "failed" ? "error" : outcome === "timeout" ? "timeout" : "complete";
  }
  return {
    runId,
    label: str(s.label) || runId,
    task: str(s.task),
    agentId: agentIdFromSessionKey(s.sessionKey),
    requesterAgentId: null,
    backend: str(s.coderBackend) || null,
    model: null,
    state,
    startedAt: num(s.startedAt) ?? num(s.createdAt),
    endedAt: ended,
    source: "live",
    progress: num(s.progress),
    lastActivity: str(s.lastActivity) || null,
    childSessionKey: str(s.sessionKey) || null,
  };
}

/**
 * One row per runId. Verification records win (they carry the verdict); the
 * live registry fills in progress/activity for in-flight runs; history fills
 * gaps (older runs that never had a verification record).
 */
export function mergeRuns(
  verification: RunLite[],
  history: RunLite[],
  live: RunLite[],
): RunLite[] {
  const byId = new Map<string, RunLite>();
  for (const r of history) byId.set(r.runId, r);
  for (const r of live) {
    const prev = byId.get(r.runId);
    byId.set(r.runId, prev ? { ...prev, ...pickDefined(r), requesterAgentId: prev.requesterAgentId } : r);
  }
  for (const r of verification) {
    const prev = byId.get(r.runId);
    if (!prev) {
      byId.set(r.runId, r);
      continue;
    }
    byId.set(r.runId, {
      ...r,
      backend: r.backend ?? prev.backend,
      agentId: r.agentId ?? prev.agentId,
      requesterAgentId: r.requesterAgentId ?? prev.requesterAgentId,
      progress: prev.progress ?? null,
      lastActivity: prev.lastActivity ?? null,
      reasons: r.reasons?.length ? r.reasons : prev.reasons,
    });
  }
  return [...byId.values()].sort((a, b) => runTime(b) - runTime(a));
}

function pickDefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== null && v !== undefined && v !== "") (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function runTime(r: RunLite): number {
  return r.endedAt ?? r.startedAt ?? 0;
}

// ─── Grouping ────────────────────────────────────────────────────────────

export type AgentGroupKind = "core" | "plugin" | "cli" | "gateway";

export interface AgentGroup {
  kind: AgentGroupKind;
  /** Stable key: "core" | "gateway" | "cli" | "plugin:<id>". */
  key: string;
  label: string;
}

/**
 * Rail grouping:
 *  - plugin  → contributed by a plugin pack (`_plugin`), one group per pack
 *  - cli     → CLI coder agents (type "cli") and CLI backends seen in runs
 *  - core    → the seeded InfiniBot roster (`_seedVersion` without a plugin) + default/main
 *  - gateway → everything else (operator-created gateway agents)
 */
export function classifyAgent(a: RosterAgentInput & { virtual?: boolean }): AgentGroup {
  if (a.plugin) return { kind: "plugin", key: `plugin:${a.plugin}`, label: prettyId(a.plugin) };
  if (a.type === "cli" || a.virtual) return { kind: "cli", key: "cli", label: "CLI coders" };
  if (a.seedVersion || a.isDefault || a.id === "main") {
    return { kind: "core", key: "core", label: "Core roster" };
  }
  return { kind: "gateway", key: "gateway", label: "Gateway agents" };
}

/** Constellation cluster: plugin pack, else department (team), else rail group. */
export function clusterFor(
  a: RosterAgentInput & { virtual?: boolean },
  profile?: AgentProfileLite,
): { key: string; label: string } {
  const g = classifyAgent(a);
  if (g.kind === "plugin" || g.kind === "cli") return { key: g.key, label: g.label };
  const dept = profile?.department?.trim();
  if (dept) return { key: `team:${dept.toLowerCase()}`, label: prettyId(dept) };
  return { key: g.key, label: g.label };
}

/**
 * CLI backends that ran work but have no configured CLI agent become virtual
 * roster entries so their runs are visible (they are real executors, not mock).
 */
export function deriveVirtualCoders(
  agents: RosterAgentInput[],
  runs: RunLite[],
): Array<RosterAgentInput & { virtual: true; backend: string }> {
  const configured = new Set(
    agents.filter((a) => a.type === "cli").map((a) => (a.cliCommand || "").toLowerCase()),
  );
  const seen = new Set<string>();
  const out: Array<RosterAgentInput & { virtual: true; backend: string }> = [];
  for (const r of runs) {
    const b = r.backend;
    if (!b || seen.has(b)) continue;
    seen.add(b);
    const cmd = BACKEND_CLI_COMMAND[b] ?? b;
    if (configured.has(cmd)) continue;
    out.push({
      id: `cli:${b}`,
      name: BACKEND_LABEL[b] ?? prettyId(b),
      type: "cli",
      model: "",
      cliCommand: cmd,
      virtual: true,
      backend: b,
    });
  }
  return out;
}

/** Roster id that executed a run's CLI backend (configured CLI agent or `cli:<backend>`). */
export function executorIdForBackend(
  backend: string | null,
  agents: Array<RosterAgentInput & { virtual?: boolean }>,
): string | null {
  if (!backend) return null;
  const cmd = BACKEND_CLI_COMMAND[backend] ?? backend;
  const configured = agents.find(
    (a) => a.type === "cli" && !a.virtual && (a.cliCommand || "").toLowerCase() === cmd,
  );
  if (configured) return configured.id;
  return `cli:${backend}`;
}

// ─── Stats ───────────────────────────────────────────────────────────────

export interface AgentStats {
  runsToday: number;
  runs7d: number;
  runsTotal: number;
  running: number;
  verified: number;
  unverified: number;
  failed: number;
  blocked: number;
  /** Runs with a verification verdict (success-rate denominator). */
  judged: number;
  /** verified+accepted ÷ judged, 0..1; null when nothing was judged. */
  successRate: number | null;
  avgDurationMs: number | null;
  lastActiveAt: number | null;
  currentRun: RunLite | null;
  lastRun: RunLite | null;
  /** Most recent run that has a verdict. */
  lastVerdict: RunState | null;
  /** 14 buckets, oldest first; index 13 = today. */
  runsByDay: number[];
  verdictMix: { verified: number; unverified: number; failed: number; blocked: number; other: number };
  recent: RunLite[];
}

/** Runs attributed to an agent: it ran them, or it is the CLI executor of them. */
export function runsForAgent(
  agentId: string,
  runs: RunLite[],
  agents: Array<RosterAgentInput & { virtual?: boolean }>,
): RunLite[] {
  const isCli = agents.find((a) => a.id === agentId)?.type === "cli";
  return runs.filter(
    (r) => r.agentId === agentId || (isCli && executorIdForBackend(r.backend, agents) === agentId),
  );
}

export function computeAgentStats(runs: RunLite[], now: number, days = 14): AgentStats {
  const today = startOfLocalDay(now);
  const weekAgo = now - 7 * DAY_MS;
  const firstDay = today - (days - 1) * DAY_MS;
  const runsByDay = new Array<number>(days).fill(0);
  const mix = { verified: 0, unverified: 0, failed: 0, blocked: 0, other: 0 };
  let runsToday = 0;
  let runs7d = 0;
  let running = 0;
  let durTotal = 0;
  let durCount = 0;
  let lastActiveAt: number | null = null;
  let currentRun: RunLite | null = null;
  let lastRun: RunLite | null = null;
  let lastVerdict: RunState | null = null;
  let lastVerdictAt = -1;

  for (const r of runs) {
    const started = r.startedAt ?? r.endedAt;
    if (started !== null) {
      if (started >= today) runsToday++;
      if (started >= weekAgo) runs7d++;
      if (started >= firstDay) {
        const idx = Math.min(days - 1, Math.floor((started - firstDay) / DAY_MS));
        runsByDay[idx]++;
      }
    }
    const t = runTime(r);
    if (t && (lastActiveAt === null || t > lastActiveAt)) lastActiveAt = t;
    if (!lastRun || t > runTime(lastRun)) lastRun = r;
    if (RUNNING_STATES.has(r.state)) {
      running++;
      if (!currentRun || (r.startedAt ?? 0) > (currentRun.startedAt ?? 0)) currentRun = r;
    }
    if (typeof r.durationMs === "number") {
      durTotal += r.durationMs;
      durCount++;
    } else if (r.source !== "verification" && r.startedAt !== null && r.endedAt !== null && r.endedAt >= r.startedAt) {
      durTotal += r.endedAt - r.startedAt;
      durCount++;
    }
    if (VERIFIED_STATES.has(r.state)) mix.verified++;
    else if (r.state === "unverified") mix.unverified++;
    else if (FAILED_STATES.has(r.state)) mix.failed++;
    else if (BLOCKED_STATES.has(r.state)) mix.blocked++;
    else if (!RUNNING_STATES.has(r.state)) mix.other++;
    if (JUDGED_STATES.has(r.state) && t > lastVerdictAt) {
      lastVerdictAt = t;
      lastVerdict = r.state;
    }
  }

  const judged = runs.filter((r) => JUDGED_STATES.has(r.state)).length;
  const verified = mix.verified;
  return {
    runsToday,
    runs7d,
    runsTotal: runs.length,
    running,
    verified,
    unverified: mix.unverified,
    failed: mix.failed,
    blocked: mix.blocked,
    judged,
    successRate: judged > 0 ? verified / judged : null,
    avgDurationMs: durCount > 0 ? durTotal / durCount : null,
    lastActiveAt,
    currentRun,
    lastRun,
    lastVerdict,
    runsByDay,
    verdictMix: mix,
    recent: [...runs].sort((a, b) => runTime(b) - runTime(a)).slice(0, 12),
  };
}

// ─── Live state ──────────────────────────────────────────────────────────

export type AgentLiveState = "working" | "blocked" | "error" | "idle" | "disabled";

export function deriveLiveState(
  input: { isDisabled?: boolean; activeSessions?: number; lastSessionAt?: number | null },
  stats: AgentStats,
  now: number,
): AgentLiveState {
  if (input.isDisabled) return "disabled";
  if (stats.running > 0) return "working";
  if ((input.activeSessions ?? 0) > 0) return "working";
  if (input.lastSessionAt && now - input.lastSessionAt < ACTIVE_SESSION_MS) return "working";
  const last = stats.lastRun;
  if (last && now - runTime(last) < RECENT_OUTCOME_MS) {
    if (BLOCKED_STATES.has(last.state)) return "blocked";
    if (FAILED_STATES.has(last.state)) return "error";
  }
  return "idle";
}

// ─── Spend ───────────────────────────────────────────────────────────────

/** credits.summary().byBackend → SpendRow[] keyed by backend id. */
export function backendSpendRows(
  byBackend: Array<{ agentBackend?: string; tokensIn?: number; tokensOut?: number; costUsd?: number; requests?: number }> | undefined,
): SpendRow[] {
  return (byBackend ?? [])
    .filter((b) => typeof b.agentBackend === "string" && b.agentBackend)
    .map((b) => ({
      key: b.agentBackend!,
      tokens: (b.tokensIn ?? 0) + (b.tokensOut ?? 0),
      costUsd: b.costUsd ?? 0,
      requests: b.requests ?? 0,
    }));
}

/** credits.top(axis=session_key) rows → per-agent totals. */
export function spendByAgent(rows: SpendRow[]): Map<string, SpendRow> {
  const out = new Map<string, SpendRow>();
  for (const r of rows) {
    const id = agentIdFromSessionKey(r.key);
    if (!id) continue;
    const prev = out.get(id) ?? { key: id, tokens: 0, costUsd: 0, requests: 0 };
    prev.tokens += r.tokens || 0;
    prev.costUsd += r.costUsd || 0;
    prev.requests += r.requests || 0;
    out.set(id, prev);
  }
  return out;
}

// ─── Roster view ─────────────────────────────────────────────────────────

export interface AgentView {
  id: string;
  name: string;
  monogram: string;
  emoji: string | null;
  role: string;
  group: AgentGroup;
  cluster: { key: string; label: string };
  type: "native" | "cli";
  virtual: boolean;
  /** CLI backend id (claude-code/codex/…) for CLI agents; null for gateway agents. */
  backend: string | null;
  /** Human model label ("gpt-oss:120b"); "" when unknown. */
  model: string;
  modelFull: string;
  plugin: string | null;
  isDefault: boolean;
  avatarUrl: string;
  state: AgentLiveState;
  stats: AgentStats;
  activeSessions: number;
  sessionCount: number;
  lastActiveAt: number | null;
  spendToday: SpendRow | null;
  delegatesTo: string[];
}

export interface RosterInput {
  agents: Array<RosterAgentInput & { activeSessionCount?: number; sessionCount?: number; lastSessionAt?: number | null }>;
  profiles?: AgentProfileLite[];
  runs: RunLite[];
  spendToday?: SpendRow[];
  /** credits.summary(day).byBackend as rows keyed by agent backend (CLI coder spend). */
  spendByBackend?: SpendRow[];
  now: number;
}

function cliBackendForCommand(cmd: string | undefined): string | null {
  const c = (cmd || "").toLowerCase();
  for (const [backend, command] of Object.entries(BACKEND_CLI_COMMAND)) {
    if (c === command || c.endsWith(`/${command}`)) return backend;
  }
  return c ? c : null;
}

export function buildRoster(input: RosterInput): AgentView[] {
  const { now } = input;
  const profiles = new Map((input.profiles ?? []).map((p) => [p.id, p]));
  const virtual = deriveVirtualCoders(input.agents, input.runs);
  const all: Array<RosterAgentInput & { virtual?: boolean; backend?: string; activeSessionCount?: number; sessionCount?: number; lastSessionAt?: number | null }> = [
    ...input.agents,
    ...virtual,
  ];
  const spend = spendByAgent(input.spendToday ?? []);
  const backendSpend = new Map((input.spendByBackend ?? []).map((r) => [r.key, r]));

  return all.map((a) => {
    const profile = profiles.get(a.id);
    const runs = runsForAgent(a.id, input.runs, all);
    const stats = computeAgentStats(runs, now);
    const modelFull =
      a.type === "cli"
        ? ""
        : a.model && a.model !== "default"
          ? a.model
          : profile?.modelPrimary || "";
    const lastSessionAt = a.lastSessionAt ?? null;
    const lastActiveAt = maxNullable(stats.lastActiveAt, lastSessionAt, profile?.lastActiveAt ?? null);
    const role =
      (profile?.description || a.description || "").split(" · ")[0].trim() ||
      (a.virtual ? "CLI coder backend" : a.type === "cli" ? "CLI agent" : "");
    return {
      id: a.id,
      name: a.name || a.id,
      monogram: monogram(a.name || a.id),
      emoji: profile?.emoji || null,
      role,
      group: classifyAgent(a),
      cluster: clusterFor(a, profile),
      type: a.type,
      virtual: !!a.virtual,
      backend: a.type === "cli" ? (a.backend ?? cliBackendForCommand(a.cliCommand)) : null,
      model: shortModel(modelFull),
      modelFull,
      plugin: a.plugin ?? null,
      isDefault: !!a.isDefault,
      avatarUrl: a.avatarUrl || "",
      state: deriveLiveState(
        { isDisabled: a.isDisabled, activeSessions: a.activeSessionCount, lastSessionAt },
        stats,
        now,
      ),
      stats,
      activeSessions: a.activeSessionCount ?? 0,
      sessionCount: a.sessionCount ?? 0,
      lastActiveAt,
      // CLI coders bill per backend (entries keyed by run, not session).
      spendToday:
        spend.get(a.id) ??
        (a.type === "cli" ? backendSpend.get(a.backend ?? cliBackendForCommand(a.cliCommand) ?? "") ?? null : null),
      delegatesTo: (a.subagents ?? []).filter((s) => s && s !== "*"),
    };
  });
}

function maxNullable(...vals: Array<number | null | undefined>): number | null {
  let out: number | null = null;
  for (const v of vals) if (typeof v === "number" && (out === null || v > out)) out = v;
  return out;
}

// ─── Groups, filters, KPIs ───────────────────────────────────────────────

export interface GroupSummary extends AgentGroup {
  count: number;
  working: number;
}

const GROUP_ORDER: Record<AgentGroupKind, number> = { core: 0, plugin: 1, cli: 2, gateway: 3 };

export function summarizeGroups(views: AgentView[]): GroupSummary[] {
  const map = new Map<string, GroupSummary>();
  for (const v of views) {
    const g = map.get(v.group.key) ?? { ...v.group, count: 0, working: 0 };
    g.count++;
    if (v.state === "working") g.working++;
    map.set(v.group.key, g);
  }
  return [...map.values()].sort(
    (a, b) => GROUP_ORDER[a.kind] - GROUP_ORDER[b.kind] || a.label.localeCompare(b.label),
  );
}

export interface RosterFilter {
  /** "all" | group key | "kind:<kind>" */
  group: string;
  state: AgentLiveState | "all";
  query: string;
}

export function filterRoster(views: AgentView[], f: RosterFilter): AgentView[] {
  const q = f.query.trim().toLowerCase();
  return views.filter((v) => {
    if (f.group !== "all") {
      if (f.group.startsWith("kind:")) {
        if (v.group.kind !== f.group.slice(5)) return false;
      } else if (v.group.key !== f.group) return false;
    }
    if (f.state !== "all" && v.state !== f.state) return false;
    if (!q) return true;
    return [v.id, v.name, v.role, v.model, v.backend ?? "", v.plugin ?? "", v.cluster.label]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
}

/** Sort: working first, then blocked/error, then by recent activity. */
export function sortRoster(views: AgentView[]): AgentView[] {
  const rank: Record<AgentLiveState, number> = { working: 0, blocked: 1, error: 2, idle: 3, disabled: 4 };
  return [...views].sort(
    (a, b) =>
      rank[a.state] - rank[b.state] ||
      (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0) ||
      a.name.localeCompare(b.name),
  );
}

export interface Kpis {
  activeNow: number;
  runsToday: number;
  /** Today's verified ÷ judged, 0..1; null when nothing was judged today. */
  verifiedPct: number | null;
  judgedToday: number;
  /** credits.summary(day).totalCostUsd; null when unavailable. */
  spendToday: number | null;
  tokensToday: number | null;
}

export function computeKpis(
  views: AgentView[],
  runs: RunLite[],
  now: number,
  spend: { costUsd: number | null; tokens: number | null } = { costUsd: null, tokens: null },
): Kpis {
  const today = startOfLocalDay(now);
  const todays = runs.filter((r) => (r.startedAt ?? r.endedAt ?? 0) >= today);
  const judged = todays.filter((r) => JUDGED_STATES.has(r.state));
  const verified = judged.filter((r) => VERIFIED_STATES.has(r.state)).length;
  return {
    activeNow: views.filter((v) => v.state === "working").length,
    runsToday: todays.length,
    verifiedPct: judged.length > 0 ? verified / judged.length : null,
    judgedToday: judged.length,
    spendToday: spend.costUsd,
    tokensToday: spend.tokens,
  };
}

// ─── Relationships ───────────────────────────────────────────────────────

export type EdgeKind = "delegation" | "can-delegate";

export interface AgentEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Runs observed along this edge (0 for config-only edges). */
  weight: number;
  lastAt: number | null;
  /** Had traffic in the last 24h. */
  recent: boolean;
}

/**
 * Edges:
 *  - delegation: observed in runs — requester → worker agent (when different)
 *    and worker/requester → CLI executor (the coder that did the work).
 *  - can-delegate: configured `subagents.allowAgents` with no observed traffic.
 */
export function buildEdges(views: AgentView[], runs: RunLite[], now: number): AgentEdge[] {
  const ids = new Set(views.map((v) => v.id));
  const rosterLike = views.map((v) => ({
    id: v.id,
    name: v.name,
    type: v.type,
    model: v.modelFull,
    cliCommand: v.backend ? (BACKEND_CLI_COMMAND[v.backend] ?? v.backend) : "",
    virtual: v.virtual,
  }));
  const map = new Map<string, AgentEdge>();
  const bump = (from: string | null, to: string | null, at: number | null) => {
    if (!from || !to || from === to || !ids.has(from) || !ids.has(to)) return;
    const key = `${from}→${to}`;
    const e = map.get(key) ?? { from, to, kind: "delegation" as EdgeKind, weight: 0, lastAt: null, recent: false };
    e.weight++;
    if (at !== null && (e.lastAt === null || at > e.lastAt)) e.lastAt = at;
    e.recent = e.lastAt !== null && now - e.lastAt < DAY_MS;
    map.set(key, e);
  };
  for (const r of runs) {
    const at = r.startedAt ?? r.endedAt;
    const worker = r.agentId;
    bump(r.requesterAgentId, worker, at);
    const exec = executorIdForBackend(r.backend, rosterLike);
    bump(worker ?? r.requesterAgentId, exec, at);
  }
  for (const v of views) {
    for (const target of v.delegatesTo) {
      const key = `${v.id}→${target}`;
      if (map.has(key) || !ids.has(target) || target === v.id) continue;
      map.set(key, { from: v.id, to: target, kind: "can-delegate", weight: 0, lastAt: null, recent: false });
    }
  }
  return [...map.values()];
}

/** 0..1 activity score for node sizing (log-scaled 7-day runs + live sessions). */
export function activityScore(v: AgentView): number {
  const raw = v.stats.runs7d + v.activeSessions * 2 + (v.state === "working" ? 3 : 0);
  return Math.min(1, Math.log10(1 + raw) / 2);
}

// ─── Formatting ──────────────────────────────────────────────────────────

export function fmtPct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  if (v === 0) return "$0.00";
  if (v < 0.01) return "<$0.01";
  return `$${v.toFixed(2)}`;
}

export function fmtTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtAgo(ts: number | null, now: number): string {
  if (!ts) return "—";
  const d = Math.max(0, now - ts);
  if (d < 45_000) return "just now";
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < DAY_MS) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / DAY_MS)}d ago`;
}

export const STATE_LABEL: Record<AgentLiveState, string> = {
  working: "Working",
  blocked: "Blocked",
  error: "Error",
  idle: "Idle",
  disabled: "Disabled",
};

export const RUN_STATE_LABEL: Record<RunState, string> = {
  running: "Running",
  reviewing: "Reviewing",
  continuing: "Continuing",
  interrupted: "Interrupted",
  verified: "Verified",
  accepted: "Accepted",
  unverified: "Unverified",
  failed: "Failed",
  rejected: "Rejected",
  stalled: "Stalled",
  blocked: "Blocked",
  needs_input: "Needs input",
  needs_owner: "Needs owner",
  complete: "Completed",
  error: "Error",
  timeout: "Timed out",
};

/** Tone bucket for a run state (maps onto --g-success/warning/danger/info/neutral). */
export function runTone(s: RunState): "ok" | "warn" | "bad" | "live" | "muted" {
  if (VERIFIED_STATES.has(s)) return "ok";
  if (RUNNING_STATES.has(s)) return "live";
  if (FAILED_STATES.has(s)) return "bad";
  if (BLOCKED_STATES.has(s) || s === "unverified" || s === "interrupted") return "warn";
  return "muted";
}

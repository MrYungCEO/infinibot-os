/**
 * Voice Terminal HUD — pure data shaping for the HUD panels.
 *
 * Every function here takes a raw gateway RPC payload (already fetched by
 * hud-store.ts) and returns the small view model a panel renders. No I/O, no
 * DOM, so the whole module is unit-tested in node (hud-data.test.ts).
 *
 * Sources (existing gateway RPCs only):
 *   subagents.list            → running / blocked agents
 *   verification.list         → latest completions + verdicts + "restart pending"
 *   calendar.events.list      → today's calendar
 *   scheduledTasks.list       → scheduled runs in the next 24h + decisions waiting
 *   proactive.state           → current commitment, next tasks, projects needing attention
 *   system.version            → gateway version / uptime
 *   kanban.notionSync.status  → Notion sync state
 *   GET /api/hardware/nodes   → CPU / RAM / GPU of the local node (+ satellites)
 */

import {
  buildCompletedEntries,
  DEPLOY_TEXT,
  VERDICT_TEXT,
  VERDICT_TONE,
  type CompletedEntry,
  type CompletionRecordLite,
} from "../../lib/review-mesh/completed.js";

export type Tone = "ok" | "warn" | "bad" | "info" | "muted";

// ── formatting ──────────────────────────────────────────────────────────────

/** "now" / "45s" / "12m" / "3h" / "2d" — compact age or distance. */
export function compactSpan(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** "5m ago" for past, "in 2h" for future. */
export function relTime(at: number, now: number): string {
  const d = at - now;
  const span = compactSpan(d);
  if (span === "now" || span === "—") return span;
  return d >= 0 ? `in ${span}` : `${span} ago`;
}

/** 24h "14:05" in the viewer's local time. */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function uptimeText(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// ── agents ──────────────────────────────────────────────────────────────────

export type HudAgent = {
  runId: string;
  sessionKey: string;
  label: string;
  status: "starting" | "working" | "finishing" | "blocked" | "needs_input";
  /** Last tool/activity line ("Bash: pnpm build"), may be empty. */
  activity: string;
  /** Backend chip: claude-code / codex / opencode / gateway. */
  backend: string;
  node: string | null;
  startedAt: number;
  lastAt: number;
  progress: number;
};

const ACTIVE_STATUS = new Set(["starting", "running", "working", "finishing", "blocked", "needs_input", "stalled"]);

/** `subagents.list` (compact) → active runs, blocked first, then newest activity. */
export function shapeAgents(raw: unknown): HudAgent[] {
  const root = obj(raw);
  const rows = Array.isArray(raw) ? raw : arr(root.subagents).length ? arr(root.subagents) : arr(root.items);
  const out: HudAgent[] = [];
  for (const r of rows) {
    const a = obj(r);
    const runId = str(a.runId);
    if (!runId) continue;
    const status = str(a.status).toLowerCase();
    if (num(a.endedAt) || a.outcome || !ACTIVE_STATUS.has(status)) continue;
    const last = obj(a.lastActivity);
    const norm: HudAgent["status"] =
      status === "blocked" || status === "stalled"
        ? "blocked"
        : status === "needs_input"
          ? "needs_input"
          : status === "starting" || status === "finishing"
            ? status
            : "working";
    const startedAt = num(a.startedAt) ?? num(a.createdAt) ?? 0;
    out.push({
      runId,
      sessionKey: str(a.sessionKey) || runId,
      label: str(a.label) || str(a.task).slice(0, 80) || runId,
      status: norm,
      activity: str(last.label),
      backend: str(a.coderBackend) || str(last.coderBackend) || (a.remote ? "remote" : "agent"),
      node: str(a.nodeName) || null,
      startedAt,
      lastAt: num(last.at) ?? num(a.lastUpdateAt) ?? startedAt,
      progress: Math.max(0, Math.min(100, num(a.progress) ?? 0)),
    });
  }
  const rank = (s: HudAgent["status"]) => (s === "blocked" || s === "needs_input" ? 0 : 1);
  return out.sort((x, y) => rank(x.status) - rank(y.status) || y.lastAt - x.lastAt);
}

export const AGENT_STATUS_TEXT: Record<HudAgent["status"], string> = {
  starting: "Starting",
  working: "Working",
  finishing: "Finishing",
  blocked: "Blocked",
  needs_input: "Needs input",
};

export function agentTone(s: HudAgent["status"]): Tone {
  return s === "blocked" || s === "needs_input" ? "warn" : s === "starting" ? "info" : "ok";
}

// ── completions (verification.list) ────────────────────────────────────────

export type HudCompletion = Pick<CompletedEntry, "runId" | "sessionKey" | "label" | "verdict" | "finishedAt" | "summary" | "deploy"> & {
  verdictText: string;
  tone: Tone;
  deployText: string | null;
};

const VERDICT_TO_TONE: Record<string, Tone> = { green: "ok", amber: "warn", red: "bad", magenta: "warn", slate: "muted" };

export function shapeCompletions(raw: unknown, now: number, limit = 6): { recent: HudCompletion[]; restartPending: HudCompletion[] } {
  const records = arr(obj(raw).records) as CompletionRecordLite[];
  const entries = buildCompletedEntries(records, { now, windowMs: 24 * 3_600_000, limit: 60 });
  const toHud = (e: CompletedEntry): HudCompletion => ({
    runId: e.runId,
    sessionKey: e.sessionKey,
    label: e.label,
    verdict: e.verdict,
    finishedAt: e.finishedAt,
    summary: e.summary,
    deploy: e.deploy,
    verdictText: VERDICT_TEXT[e.verdict],
    tone: VERDICT_TO_TONE[VERDICT_TONE[e.verdict]] ?? "muted",
    deployText: e.deploy ? DEPLOY_TEXT[e.deploy] : null,
  });
  return {
    recent: entries.slice(0, limit).map(toHud),
    restartPending: entries.filter((e) => e.deploy === "restart_pending").map(toHud),
  };
}

// ── today ───────────────────────────────────────────────────────────────────

export type TodayItem = {
  id: string;
  kind: "event" | "scheduled" | "focus" | "next";
  title: string;
  /** When it happens (events / scheduled runs); null for un-timed tasks. */
  at: number | null;
  /** Left-column label: "14:30", "NOW", "NEXT". */
  when: string;
  detail: string;
  tone: Tone;
  /** Click-through target. */
  link: { tab?: string; taskId?: string; projectId?: string };
};

export type TodayModel = {
  items: TodayItem[];
  overdue: number;
  p0: number;
  openTasks: number | null;
  awaitingDecision: number;
};

function eventStart(e: Record<string, unknown>): number | null {
  const iso = str(e.startIso) || (str(e.startDate) ? `${str(e.startDate)}T00:00:00` : "");
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
}

export function shapeToday(input: { calendar?: unknown; scheduled?: unknown; proactive?: unknown; now: number }): TodayModel {
  const { now } = input;
  const items: TodayItem[] = [];
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  // Calendar: remaining events today (anything that ends later than now).
  for (const raw of arr(obj(input.calendar).events)) {
    const e = obj(raw);
    if (e.deletedAtMs) continue;
    const start = eventStart(e);
    if (start == null || start > endOfDay.getTime()) continue;
    const end = Date.parse(str(e.endIso)) || start + 30 * 60_000;
    if (end < now) continue;
    const allDay = !str(e.startIso);
    items.push({
      id: `ev:${str(e.id) || start}`,
      kind: "event",
      title: str(e.summary) || "Calendar event",
      at: start,
      when: allDay ? "ALL DAY" : start <= now ? "NOW" : clockTime(start),
      detail: str(e.location) || (allDay ? "all day" : relTime(start, now)),
      tone: start <= now ? "ok" : start - now < 30 * 60_000 ? "warn" : "info",
      link: { tab: "calendar" },
    });
  }

  // Scheduled agent tasks that fire within the next 24h.
  let awaitingDecision = 0;
  for (const raw of arr(obj(input.scheduled).tasks)) {
    const t = obj(raw);
    awaitingDecision += num(obj(t.counts).awaitingDecision) ?? 0;
    if (t.enabled === false) continue;
    const next = num(t.nextRunAt);
    if (next == null || next < now || next - now > 24 * 3_600_000) continue;
    items.push({
      id: `st:${str(t.id)}`,
      kind: "scheduled",
      title: str(t.name) || "Scheduled task",
      at: next,
      when: clockTime(next),
      detail: `scheduled run · ${relTime(next, now)}`,
      tone: "info",
      link: { tab: "schedule" },
    });
  }

  // Proactive: the active commitment, then the top next tasks.
  const p = obj(input.proactive);
  const active = obj(p.active);
  if (str(active.title)) {
    items.push({
      id: `focus:${str(active.taskId) || str(active.title)}`,
      kind: "focus",
      title: str(active.title),
      at: null,
      when: "FOCUS",
      detail: num(active.remainingMin) != null ? `focus block · ${num(active.remainingMin)}m left` : "current commitment",
      tone: "ok",
      link: { taskId: str(active.taskId) || undefined, projectId: str(active.projectId) || undefined },
    });
  }
  for (const raw of arr(p.candidates).slice(0, 3)) {
    const c = obj(raw);
    if (!str(c.title)) continue;
    const due = str(c.dueLabel);
    items.push({
      id: `next:${str(c.taskId) || str(c.title)}`,
      kind: "next",
      title: str(c.title),
      at: null,
      when: due ? due.toUpperCase().slice(0, 8) : "NEXT",
      detail: [str(c.projectName), str(c.priorityTag)].filter(Boolean).join(" · ") || str(c.reason),
      tone: /overdue/i.test(due) ? "bad" : due ? "warn" : "muted",
      link: { taskId: str(c.taskId) || undefined, projectId: str(c.projectId) || undefined },
    });
  }

  const order: Record<TodayItem["kind"], number> = { focus: 0, event: 1, scheduled: 1, next: 2 };
  items.sort((a, b) => order[a.kind] - order[b.kind] || (a.at ?? Infinity) - (b.at ?? Infinity));
  const summary = obj(p.summary);
  return {
    items,
    overdue: num(summary.overdue) ?? 0,
    p0: num(summary.p0Tasks) ?? 0,
    openTasks: num(summary.openTasks),
    awaitingDecision,
  };
}

// ── projects needing attention ─────────────────────────────────────────────

export type AttentionProject = {
  projectId: string;
  name: string;
  state: "blocked" | "drifting" | "stale" | "watch";
  reason: string;
  daysIdle: number | null;
  progress: number | null;
  tone: Tone;
};

const ATTENTION_RANK: Record<AttentionProject["state"], number> = { blocked: 0, drifting: 1, stale: 2, watch: 3 };

/**
 * proactive.state → projects that need the owner: blocked (has a blocker and no
 * agent on it), drifting (no progress past the drift window), watch. Deduped by
 * project, worst first.
 */
export function shapeAttention(raw: unknown, limit = 8): AttentionProject[] {
  const p = obj(raw);
  const byId = new Map<string, AttentionProject & { score: number }>();
  for (const raw2 of [...arr(p.driftRadar), ...arr(p.focused), ...arr(p.extras)]) {
    const r = obj(raw2);
    const projectId = str(r.projectId);
    if (!projectId || byId.has(projectId)) continue;
    const st = str(r.state).toLowerCase();
    const blocker = str(r.topBlocker);
    const days = num(r.daysSinceActivity);
    let state: AttentionProject["state"];
    if (st === "blocked") state = "blocked";
    else if (st === "drifting") state = "drifting";
    else if (st === "cold" || st === "stale") state = "stale";
    else if (st === "watch") state = "watch";
    else continue; // healthy / on-track projects are not "attention"
    const idle = days != null ? `idle ${Math.round(days)}d` : "";
    byId.set(projectId, {
      projectId,
      name: str(r.name) || "Untitled project",
      state,
      reason: blocker ? `Next: ${blocker}` : idle ? `No progress · ${idle}` : "Needs a decision",
      daysIdle: days,
      progress: num(r.progress),
      tone: state === "blocked" ? "bad" : state === "drifting" ? "warn" : "muted",
      score: num(r.driftScore) ?? 0,
    });
  }
  return Array.from(byId.values())
    .sort((a, b) => ATTENTION_RANK[a.state] - ATTENTION_RANK[b.state] || b.score - a.score || (b.daysIdle ?? 0) - (a.daysIdle ?? 0))
    .slice(0, limit)
    .map(({ score: _score, ...rest }) => rest);
}

/** The prompt the "Ask" button sends to the agent about a project. */
export function askAboutProjectPrompt(p: Pick<AttentionProject, "name" | "state" | "reason">): string {
  return `Give me a short status brief on the project "${p.name}" (flagged ${p.state}: ${p.reason}). What is blocking it, what changed recently, and what is the single next action I should take?`;
}

// ── system health ───────────────────────────────────────────────────────────

export type Meter = { label: string; pct: number; tone: Tone };

export type SystemModel = {
  gateway: { ok: boolean; text: string };
  version: string | null;
  uptime: string;
  host: string | null;
  meters: Meter[];
  nodes: { online: number; total: number };
  notion: { state: string; text: string; tone: Tone } | null;
};

function meter(label: string, pct: number | null): Meter | null {
  if (pct == null) return null;
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return { label, pct: v, tone: v >= 90 ? "bad" : v >= 75 ? "warn" : "ok" };
}

export function shapeSystem(input: { connected: boolean; version?: unknown; hardware?: unknown; notion?: unknown }): SystemModel {
  const info = obj(obj(input.version).info);
  const nodes = arr(obj(input.hardware).nodes).map(obj);
  const local = nodes.find((n) => n.isLocal) ?? nodes[0] ?? null;
  const snap = local ? obj(local.snapshot) : {};
  const meters = [
    meter("CPU", num(obj(snap.cpu).percent)),
    meter("RAM", num(obj(snap.memory).percent)),
    meter("GPU", num(obj(snap.gpu).utilizationPercent)),
  ].filter((m): m is Meter => m != null);

  let notion: SystemModel["notion"] = null;
  const n = obj(input.notion);
  if (str(n.state)) {
    const pending = num(n.pending) ?? 0;
    const attention = num(n.needsAttention) ?? 0;
    const state = str(n.state);
    const tone: Tone = attention > 0 || state === "error" ? "bad" : pending > 0 || state !== "ok" ? "warn" : "ok";
    const text =
      attention > 0
        ? `${attention} need attention`
        : pending > 0
          ? `${pending} pending`
          : state === "ok"
            ? "in sync"
            : state;
    notion = { state, text, tone };
  }

  return {
    gateway: { ok: input.connected, text: input.connected ? "Connected" : "Disconnected" },
    version: str(info.version) || null,
    uptime: uptimeText(num(info.uptime)),
    host: local ? str(local.nodeName) || str(local.nodeId) || null : str(info.hostname) || null,
    meters,
    nodes: { online: nodes.filter((x) => x.online === true).length, total: nodes.length },
    notion,
  };
}

// ── call status (props from the session view, no RPC) ──────────────────────

export type HudCallInput = {
  phase: string;
  engine: "local" | "robovoice";
  mode: "cloud" | "local" | "device" | null;
  agentName: string;
  voiceRoute: string;
  muted: boolean;
  agentState: string | null;
  blockedReason: string | null;
  error: string | null;
};

export type CallStatus = { label: string; tone: Tone; engine: string; route: string };

const ROUTE_TEXT: Record<string, string> = {
  gateway_agent: "Gateway agent",
  claude_code: "Claude Code CLI",
  codex: "Codex CLI",
  opencode: "OpenCode CLI",
  gemini: "Gemini CLI",
  grok: "Grok Build CLI",
  robovoice: "Robovoice agent",
};

export function callStatus(c: HudCallInput): CallStatus {
  const engine = c.engine === "local" ? "Local voice" : c.mode === "local" ? "Robovoice desktop" : "Robovoice cloud";
  const route = c.engine === "local" ? ROUTE_TEXT[c.voiceRoute] ?? c.voiceRoute : ROUTE_TEXT.robovoice;
  let label: string;
  let tone: Tone;
  switch (c.phase) {
    case "starting":
    case "connecting":
      label = "Connecting";
      tone = "info";
      break;
    case "active":
      if (c.muted) {
        label = "Muted";
        tone = "warn";
      } else if (c.agentState === "speaking") {
        label = "Speaking";
        tone = "ok";
      } else if (c.agentState === "thinking") {
        label = "Thinking";
        tone = "info";
      } else if (c.agentState === "listening") {
        label = "Listening";
        tone = "ok";
      } else {
        label = "Joining";
        tone = "info";
      }
      break;
    case "failed":
      label = "Call failed";
      tone = "bad";
      break;
    case "ending":
      label = "Ending";
      tone = "muted";
      break;
    default:
      label = c.blockedReason ? "Can't call" : "Ready";
      tone = c.blockedReason ? "warn" : "muted";
  }
  return { label, tone, engine, route };
}

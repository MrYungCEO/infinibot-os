/**
 * goals-model — pure data logic for the native Goals & Phases screen
 * (web: /autonomy → Goals / Phases / Scheduled tabs).
 *
 * Mirrors ui/src/ui/views/autonomy-goals.ts, autonomy-phases.ts and
 * autonomy-scheduled.ts 1:1: same labels, same filters, same form → RPC param
 * builders (the gateway schemas are additionalProperties:false, so the params
 * produced here are exactly what the web sends).
 *
 * NO react-native imports — covered by src/__tests__/goals-model.test.js.
 */

// ── Shared ──────────────────────────────────────────────────────────────────

export const VIEWS = [
  { key: 'goals', label: 'Goals', icon: 'flag-outline' },
  { key: 'phases', label: 'Phases', icon: 'layers-outline' },
  { key: 'scheduled', label: 'Scheduled', icon: 'calendar-outline' },
];

export function normalizeView(v) {
  const s = String(v || '').toLowerCase();
  return VIEWS.some((x) => x.key === s) ? s : 'goals';
}

/** Route params ({view, goal, phase, task}) → initial view + focus ids. */
export function resolveRouteParams(params) {
  const p = params || {};
  const goal = p.goal ? String(p.goal) : null;
  const phase = p.phase ? String(p.phase) : null;
  const task = p.task ? String(p.task) : null;
  let view = p.view ? normalizeView(p.view) : null;
  if (!view) view = goal ? 'goals' : phase ? 'phases' : task ? 'scheduled' : 'goals';
  return { view, goal, phase, task };
}

export const CLI_OPTIONS = [
  { id: 'claude-code', label: 'Claude Code', models: ['opus', 'sonnet', 'haiku'] },
  { id: 'codex', label: 'Codex', models: ['gpt-5.5', 'gpt-5.4', 'gpt-5-codex'] },
  { id: 'opencode', label: 'OpenCode', models: ['anthropic/claude-sonnet-4-5', 'openai/gpt-5'] },
  { id: 'gemini', label: 'Gemini CLI', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  { id: 'grok', label: 'Grok Build', models: ['grok-build', 'grok-4.6', 'grok-code-fast-1'] },
];

export function errMessage(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

/** True when the gateway does not serve the RPC (older build / not restarted). */
export function isUnknownMethod(err) {
  const msg = errMessage(err);
  const code = err && err.code ? String(err.code) : '';
  return /unknown method|no handler|method not found|not implemented/i.test(msg) || code === 'METHOD_NOT_FOUND';
}

export function isNotFound(err) {
  return /not found/i.test(errMessage(err));
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "just now" / "5m ago" / "3h ago" / "2d ago" — mirrors ui/src/ui/format formatAgo. */
export function formatAgo(ts, now = Date.now()) {
  if (!ts) return 'never';
  const t = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(t)) return '—';
  const diff = now - t;
  const abs = Math.abs(diff);
  const suffix = diff < 0 ? 'from now' : 'ago';
  const s = Math.round(abs / 1000);
  if (s < 60) return diff < 0 ? 'in <1m' : 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ${suffix}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ${suffix}`;
  const d = Math.round(h / 24);
  return `${d}d ${suffix}`;
}

/** agents.list payload → [{id, name}] (same mapping the web views use). */
export function normalizeAgents(res) {
  const list = Array.isArray(res?.agents) ? res.agents : [];
  return list
    .map((a) => ({
      id: String(a?.id ?? ''),
      name: String(a?.name || a?.identity?.name || a?.id || ''),
    }))
    .filter((a) => a.id);
}

/** "cli:codex" | "agent:main" + model → goal/scheduled Target. */
export function parseTarget(target, model) {
  const raw = String(target || 'cli:claude-code');
  const i = raw.indexOf(':');
  const kind = i >= 0 ? raw.slice(0, i) : 'cli';
  const id = i >= 0 ? raw.slice(i + 1) : raw;
  const m = String(model || '').trim();
  return kind === 'agent'
    ? { kind: 'agent', agentId: id, ...(m ? { model: m } : {}) }
    : { kind: 'cli', backend: id, ...(m ? { model: m } : {}) };
}

export function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ── Goals ───────────────────────────────────────────────────────────────────

export const GOAL_CHECK_TYPES = [
  { id: 'shell', label: 'Command', hint: 'passes when it exits 0' },
  { id: 'file', label: 'File exists', hint: 'path must exist' },
  { id: 'grep', label: 'File contains', hint: 'regex must match' },
  { id: 'llm', label: 'AI judge', hint: 'reviewer reads output + diff' },
  { id: 'visual', label: 'Screenshots look right', hint: 'visual_verify screenshots + vision review' },
];

export const GOAL_STATUS_LABEL = {
  queued: 'Queued',
  running: 'Running',
  checking: 'Checking',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  exhausted: 'Exhausted',
  canceled: 'Canceled',
};

export const GOAL_OUTCOME_LABEL = {
  running: 'Working',
  exited: 'Exited',
  nonzero_exit: 'Non-zero exit',
  crashed: 'Crashed',
  timeout: 'Timed out',
  hung: 'Hung (no output)',
  claimed_done_checks_failed: 'Claimed done · checks failed',
  checks_passed: 'Checks passed',
  spawn_failed: 'Failed to start',
  canceled: 'Canceled',
  interrupted: 'Interrupted',
};

export const TRIGGER_LABEL = {
  timer: 'while running',
  iteration: 'after iteration',
  manual: 'manual re-check',
  recovery: 'after restart',
};

export const GOAL_ACTIVE = new Set(['queued', 'running', 'checking', 'paused']);
export const GOAL_TERMINAL = new Set(['completed', 'failed', 'exhausted', 'canceled']);

export const GOAL_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'completed', label: 'Done' },
  { key: 'failed', label: 'Failed' },
];

/** Chip tone for a goal status. */
export function goalStatusTone(status) {
  switch (status) {
    case 'running':
    case 'checking':
      return 'primary';
    case 'completed':
      return 'success';
    case 'failed':
    case 'exhausted':
      return 'danger';
    case 'paused':
      return 'warning';
    case 'queued':
      return 'info';
    default:
      return 'neutral';
  }
}

export function goalMatchesFilter(g, filter) {
  if (filter === 'active') return GOAL_ACTIVE.has(g.status);
  if (filter === 'completed') return g.status === 'completed';
  if (filter === 'failed') return g.status === 'failed' || g.status === 'exhausted';
  return true;
}

export function filterGoals(goals, filter) {
  return (goals || []).filter((g) => goalMatchesFilter(g, filter));
}

export function goalCounts(goals) {
  const out = {};
  for (const f of GOAL_FILTERS) out[f.key] = filterGoals(goals, f.key).length;
  return out;
}

/** Poll while any goal is actively working (paused ones don't change). */
export function goalsHaveActive(goals) {
  return (goals || []).some((g) => GOAL_ACTIVE.has(g.status) && g.status !== 'paused');
}

export function describeGoalCheck(c) {
  if (!c) return '';
  if (c.label) return c.label;
  switch (c.type) {
    case 'shell':
      return `$ ${c.command ?? ''}`;
    case 'file':
      return `${c.negate ? 'absent' : 'exists'}: ${c.path ?? ''}`;
    case 'grep':
      return `${c.negate ? 'not ' : ''}/${c.pattern ?? ''}/ in ${c.path ?? ''}`;
    case 'llm':
      return c.criterion ?? '';
    case 'visual':
      return `${(c.routes ?? []).join(', ')}${c.expectation ? ` — ${c.expectation}` : ''}`;
    default:
      return c.criterion ?? c.type ?? '';
  }
}

export function checkTypeLabel(type) {
  return GOAL_CHECK_TYPES.find((t) => t.id === type)?.label ?? type;
}

export function goalTargetLabel(t) {
  if (!t) return '—';
  const base =
    t.kind === 'cli' ? (CLI_OPTIONS.find((o) => o.id === t.backend)?.label ?? t.backend) : `@${t.agentId}`;
  return t.model ? `${base} · ${t.model}` : base;
}

export function emptyGoalCheck(type = 'shell') {
  return { type, command: '', path: '', pattern: '', criterion: '', negate: false, routes: '' };
}

export function defaultGoalDraft() {
  return {
    goal: '',
    title: '',
    checks: [emptyGoalCheck('shell')],
    target: 'cli:claude-code',
    model: '',
    workdir: '',
    maxIterations: 5,
    maxMinutes: 120,
    iterationMinutes: 30,
    checkEverySec: 120,
    hangMinutes: 10,
    notify: true,
  };
}

/** Restore a persisted draft over the defaults (tolerates garbage). */
export function mergeGoalDraft(raw) {
  const base = defaultGoalDraft();
  if (!raw || typeof raw !== 'object') return base;
  const d = { ...base, ...raw };
  d.checks = Array.isArray(raw.checks) && raw.checks.length
    ? raw.checks.map((c) => ({ ...emptyGoalCheck(c?.type || 'shell'), ...c }))
    : base.checks;
  return d;
}

/** Draft check rows → GoalCheck[]; incomplete rows are dropped (as on web). */
export function draftChecksToGoalChecks(list) {
  const out = [];
  for (const c of list || []) {
    const command = String(c.command || '').trim();
    const path = String(c.path || '').trim();
    const pattern = String(c.pattern || '').trim();
    const criterion = String(c.criterion || '').trim();
    if (c.type === 'shell' && command) out.push({ type: 'shell', command });
    if (c.type === 'file' && path) out.push({ type: 'file', path, ...(c.negate ? { negate: true } : {}) });
    if (c.type === 'grep' && path && pattern) out.push({ type: 'grep', path, pattern });
    if (c.type === 'llm' && criterion) out.push({ type: 'llm', criterion });
    if (c.type === 'visual' && String(c.routes || '').trim()) {
      out.push({
        type: 'visual',
        routes: String(c.routes).split(',').map((r) => r.trim()).filter(Boolean),
        ...(criterion ? { expectation: criterion } : {}),
      });
    }
  }
  return out;
}

/** Composer draft → goals.create params, or { error }. */
export function buildGoalCreateParams(d) {
  const checks = draftChecksToGoalChecks(d.checks);
  if (!String(d.goal || '').trim()) return { error: 'Describe the goal first.' };
  if (checks.length === 0) {
    return { error: "Add at least one completion check — that's how the run knows it's done." };
  }
  const workdir = String(d.workdir || '').trim();
  const title = String(d.title || '').trim();
  return {
    params: {
      goal: d.goal.trim(),
      ...(title ? { title } : {}),
      checks,
      target: parseTarget(d.target, d.model),
      ...(workdir ? { workdir } : {}),
      notify: Boolean(d.notify),
      limits: {
        maxIterations: d.maxIterations,
        maxWallClockSec: Math.round(d.maxMinutes * 60),
        iterationTimeoutSec: Math.round(d.iterationMinutes * 60),
        checkIntervalSec: d.checkEverySec,
        hangSec: Math.round(d.hangMinutes * 60),
      },
    },
  };
}

/** Limit inputs, identical bounds to the web numField()s. */
export const GOAL_LIMIT_FIELDS = [
  { key: 'maxIterations', label: 'Max iterations', min: 1, max: 100 },
  { key: 'maxMinutes', label: 'Max time (min)', min: 1, max: 10080 },
  { key: 'iterationMinutes', label: 'Per iteration (min)', min: 1, max: 1440 },
  { key: 'checkEverySec', label: 'Check every (s)', min: 0, max: 86400 },
  { key: 'hangMinutes', label: 'Hang after (min)', min: 0, max: 1440 },
];

/** Which detail controls the web shows for a run in this status. */
export function goalControls(status) {
  const active = GOAL_ACTIVE.has(status);
  const out = [];
  if (status === 'paused') out.push('resume');
  else if (active) out.push('pause');
  out.push('recheck');
  if (status === 'failed' || status === 'exhausted' || status === 'canceled') out.push('retry');
  out.push(active ? 'cancel' : 'delete');
  return out;
}

export const GOAL_CONTROL_META = {
  resume: { method: 'goals.resume', label: 'Resume', variant: 'secondary', icon: 'play' },
  pause: { method: 'goals.pause', label: 'Pause', variant: 'secondary', icon: 'pause' },
  recheck: { method: 'goals.recheck', label: 'Re-check now', busyLabel: 'Checking…', variant: 'outline', icon: 'checkmark-done' },
  retry: { method: 'goals.retry', label: 'Retry', variant: 'primary', icon: 'refresh' },
  cancel: { method: 'goals.cancel', label: 'Cancel', variant: 'danger', icon: 'stop-circle-outline', confirm: 'Cancel this goal run? The running agent is stopped.' },
  delete: { method: 'goals.delete', label: 'Delete', variant: 'danger', icon: 'trash-outline', confirm: 'Delete this goal run and its history?' },
};

/** Elapsed time incl. the in-progress active span. */
export function goalElapsed(run, now = Date.now()) {
  if (!run) return 0;
  return (run.elapsedMs || 0) + (run.activeSince ? now - run.activeSince : 0);
}

export function iterationTone(it, runStatus) {
  const running = it.endedAt === null || it.endedAt === undefined;
  if (it.outcome === 'checks_passed' || (it.outcome === 'exited' && runStatus === 'completed')) return 'success';
  if (running) return 'primary';
  if (it.outcome === 'interrupted' || it.outcome === 'canceled') return 'neutral';
  if (it.outcome === 'exited') return 'warning';
  return 'danger';
}

/** Per-check pass/fail state + its last 16 history points. */
export function checkResultState(check, run, history) {
  const last = run?.lastResults?.[check?.id ?? ''] || null;
  const hist = (history || []).filter((h) => h.checkId === check?.id).slice(-16);
  const state = !last ? 'pending' : last.pass ? 'pass' : 'fail';
  return { last, hist, state };
}

export function checksPassingRatio(g) {
  const total = Number(g?.checksTotal) || 0;
  if (!total) return 0;
  return Math.min(1, (Number(g?.checksPassing) || 0) / total);
}

// ── Phases (persistent phase queue) ─────────────────────────────────────────

export const PHASE_CHECK_TYPES = GOAL_CHECK_TYPES.filter((t) => t.id !== 'visual');

export const QUEUE_STATUS_LABEL = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Failed',
  canceled: 'Canceled',
  dead: 'Dead-letter',
};
export const ALL_QUEUE_STATUSES = ['queued', 'running', 'paused', 'blocked', 'done', 'failed', 'canceled', 'dead'];

export const PHASE_OUTCOME_LABEL = {
  starting: 'Starting',
  running: 'Running',
  passed: 'Passed',
  gate_failed: 'Gate failed',
  unverified: 'Unverified',
  failed: 'Failed',
  needs_input: 'Needs input',
  timeout: 'Timed out',
  crashed: 'Crashed',
  spawn_failed: 'Failed to start',
  unavailable: 'Backend unavailable',
  interrupted: 'Interrupted',
  canceled: 'Canceled',
};

export const BLOCKED_LABEL = {
  gate_failed: 'Gate failed',
  unverified: 'Not verified',
  needs_input: 'Needs your input',
  backend_unavailable: 'Backend unavailable',
  model_unavailable: 'Model unavailable',
  spawn_failed: 'Agent failed to start',
  timeout: 'Timed out',
  dependency_failed: 'Dependency failed',
  invalid: 'Invalid entry',
  restart: 'Interrupted by restart',
  operator: 'Held by operator',
};

export const PHASE_FILTERS = [
  { key: 'all', label: 'All', statuses: null },
  { key: 'active', label: 'Active', statuses: ['queued', 'running', 'paused'] },
  { key: 'blocked', label: 'Blocked', statuses: ['blocked', 'dead'] },
  { key: 'done', label: 'Done', statuses: ['done'] },
  { key: 'failed', label: 'Failed', statuses: ['failed', 'canceled'] },
];

export const QUEUE_TERMINAL = new Set(['done', 'failed', 'canceled', 'dead']);

export const ISOLATION_OPTIONS = [
  { id: 'none', label: 'None (run in folder)' },
  { id: 'entry', label: 'One worktree per entry' },
  { id: 'phase', label: 'One worktree per phase' },
];

export function queueStatusTone(status) {
  switch (status) {
    case 'running':
      return 'primary';
    case 'done':
      return 'success';
    case 'blocked':
    case 'paused':
      return 'warning';
    case 'failed':
    case 'dead':
      return 'danger';
    case 'queued':
      return 'info';
    default:
      return 'neutral';
  }
}

export function entryMatchesFilter(e, filter) {
  const st = PHASE_FILTERS.find((f) => f.key === filter)?.statuses;
  return !st || st.includes(e.status);
}

export function filterEntries(entries, filter) {
  return (entries || []).filter((e) => entryMatchesFilter(e, filter));
}

export function entryFilterCounts(entries) {
  const out = {};
  for (const f of PHASE_FILTERS) out[f.key] = filterEntries(entries, f.key).length;
  return out;
}

/** [{status, label, count}] for the header strip, in canonical order. */
export function entryStatusCounts(entries) {
  const counts = new Map();
  for (const e of entries || []) counts.set(e.status, (counts.get(e.status) ?? 0) + 1);
  return ALL_QUEUE_STATUSES.filter((s) => counts.get(s)).map((s) => ({
    status: s,
    label: QUEUE_STATUS_LABEL[s].toLowerCase(),
    count: counts.get(s),
  }));
}

export function entriesHaveActive(entries) {
  return (entries || []).some((e) => e.status === 'queued' || e.status === 'running');
}

export function agentLabel(agent) {
  if (!agent) return 'default agent';
  const id = String(agent).startsWith('agent:') ? String(agent).slice(6) : String(agent);
  const cli = CLI_OPTIONS.find((o) => o.id === id);
  if (cli) return cli.label;
  return `@${id}`;
}

export function attemptModelLabel(a) {
  if (!a) return null;
  if (a.modelRequested && a.model && a.modelRequested !== a.model) return `${a.modelRequested} → ${a.model}`;
  return a.model || a.modelRequested || null;
}

/** web outcomeTone → kit tone */
export function attemptOutcomeTone(o) {
  if (o === 'passed') return 'success';
  if (o === 'running' || o === 'starting') return 'primary';
  if (o === 'interrupted' || o === 'canceled') return 'neutral';
  if (o === 'gate_failed' || o === 'unverified' || o === 'needs_input' || o === 'timeout' || o === 'unavailable') {
    return 'warning';
  }
  return 'danger';
}

export function verdictTone(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'verified' || s === 'accepted') return 'success';
  if (s === 'unverified' || s === 'stalled' || s === 'needs_input' || s === 'blocked') return 'warning';
  if (s === 'failed' || s === 'rejected') return 'danger';
  return 'neutral';
}

export function describeGate(c) {
  if (!c) return '';
  if (c.label) return c.label;
  switch (c.type) {
    case 'shell':
      return `$ ${c.command ?? ''}`;
    case 'file':
      return `${c.negate ? 'absent' : 'exists'}: ${c.path ?? ''}`;
    case 'grep':
      return `/${c.pattern ?? ''}/ in ${c.path ?? ''}`;
    default:
      return c.criterion ?? c.type;
  }
}

/** gateCriteria may be a string (one criterion per line, "$ cmd" = shell). */
export function gateList(g) {
  if (!g) return [];
  if (Array.isArray(g)) return g;
  return String(g)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith('$') ? { type: 'shell', command: l.slice(1).trim() } : { type: 'llm', criterion: l }));
}

export function emptyPhaseCheck(type = 'shell') {
  return { type, command: '', path: '', pattern: '', criterion: '', negate: false };
}

export function emptyPhase() {
  return {
    name: '',
    brief: '',
    agent: 'claude-code',
    model: '',
    fallbackAgent: '',
    checks: [],
    maxAttempts: 3,
    timeoutMin: 30,
  };
}

export function defaultPhaseDraft() {
  return { title: '', brief: '', workdir: '', isolation: 'none', priority: 0, phases: [emptyPhase()] };
}

export function mergePhaseDraft(raw) {
  const base = defaultPhaseDraft();
  if (!raw || typeof raw !== 'object') return base;
  const d = { ...base, ...raw };
  d.phases = Array.isArray(raw.phases) && raw.phases.length
    ? raw.phases.map((p) => ({ ...emptyPhase(), ...p, checks: Array.isArray(p?.checks) ? p.checks : [] }))
    : [emptyPhase()];
  return d;
}

export function toGateChecks(list) {
  const out = [];
  for (const c of list || []) {
    const command = String(c.command || '').trim();
    const path = String(c.path || '').trim();
    const pattern = String(c.pattern || '').trim();
    const criterion = String(c.criterion || '').trim();
    if (c.type === 'shell' && command) out.push({ type: 'shell', command });
    if (c.type === 'file' && path) out.push({ type: 'file', path, ...(c.negate ? { negate: true } : {}) });
    if (c.type === 'grep' && path && pattern) out.push({ type: 'grep', path, pattern });
    if (c.type === 'llm' && criterion) out.push({ type: 'llm', criterion });
  }
  return out;
}

export function movePhase(phases, i, dir) {
  const j = i + dir;
  const out = [...(phases || [])];
  if (j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Composer draft → queue.enqueue params, or { error }. */
export function buildEnqueueParams(d) {
  const phases = d?.phases || [];
  if (phases.length === 0) return { error: 'Add at least one phase.' };
  const unnamed = phases.findIndex((p) => !String(p.name || '').trim());
  if (unnamed >= 0) return { error: `Phase ${unnamed + 1} needs a name.`, phaseIndex: unnamed };
  const phaseSpec = phases.map((p) => {
    const checks = toGateChecks(p.checks);
    const brief = String(p.brief || '').trim();
    const model = String(p.model || '').trim();
    return {
      name: p.name.trim(),
      ...(brief ? { brief } : {}),
      agent: p.agent,
      ...(model ? { model } : {}),
      ...(p.fallbackAgent ? { fallbackAgent: p.fallbackAgent } : {}),
      ...(checks.length ? { gateCriteria: checks } : {}),
      maxAttempts: Math.min(20, Math.max(1, Math.round(p.maxAttempts || 3))),
      timeoutSec: Math.min(24 * 3600, Math.max(10, Math.round((p.timeoutMin || 30) * 60))),
    };
  });
  const title = String(d.title || '').trim();
  const workdir = String(d.workdir || '').trim();
  return {
    params: {
      ...(title ? { title } : {}),
      briefMd: String(d.brief || '').trim(),
      phaseSpec,
      priority: Math.round(d.priority) || 0,
      ...(workdir ? { workdir } : {}),
      isolation: d.isolation || 'none',
    },
  };
}

export function phaseState(e, i) {
  if (e.status === 'done') return 'done';
  if (i < e.currentPhaseIdx) return 'done';
  if (i > e.currentPhaseIdx) return 'pending';
  if (e.status === 'blocked' || e.status === 'dead' || e.status === 'failed') return 'blocked';
  if (e.status === 'canceled') return 'skipped';
  return 'active';
}

export function phaseStateLabel(e, st) {
  if (st === 'done') return 'Done';
  if (st === 'blocked') return QUEUE_STATUS_LABEL[e.status];
  if (st === 'skipped') return 'Canceled';
  if (st === 'active') return e.status === 'running' ? 'Running' : QUEUE_STATUS_LABEL[e.status];
  return 'Pending';
}

export function phaseStateTone(st) {
  return st === 'done' ? 'success' : st === 'blocked' ? 'danger' : st === 'active' ? 'primary' : 'neutral';
}

/** Which detail controls apply to an entry in this status (web renderDetail). */
export function entryCapabilities(e) {
  const s = e?.status;
  return {
    pause: s === 'running' || s === 'queued',
    forcePause: s === 'running',
    pauseRequested: s === 'running' && Boolean(e?.pauseRequested),
    resume: s === 'paused',
    retry: s === 'blocked' || s === 'dead' || s === 'failed' || s === 'canceled' || s === 'paused',
    skip: s === 'blocked' || s === 'paused' || s === 'dead' || s === 'failed',
    cancel: !QUEUE_TERMINAL.has(s),
    reorder: !QUEUE_TERMINAL.has(s),
  };
}

/** Banner (blocked / waiting / last error) — null when nothing to show. */
export function entryBanner(e, now = Date.now()) {
  if (!e) return null;
  const bad = e.status === 'blocked' || e.status === 'dead' || e.status === 'failed';
  const waiting = e.status === 'queued' && Boolean(e.waitingReason || e.nextAttemptAt);
  if (!bad && !waiting && !(e.lastError && e.status !== 'done')) return null;
  const tone = e.status === 'blocked' ? 'warning' : bad ? 'danger' : 'info';
  const title = bad
    ? `${QUEUE_STATUS_LABEL[e.status]}${e.blockedKind ? ` — ${BLOCKED_LABEL[e.blockedKind] ?? e.blockedKind}` : ''}`
    : waiting
      ? 'Waiting to dispatch'
      : 'Last error';
  let text = null;
  if (waiting) {
    text = `${e.waitingReason ?? ''}${e.nextAttemptAt && e.nextAttemptAt > now ? ` Next attempt in ${fmtDuration(e.nextAttemptAt - now)}.` : ''}`.trim() || null;
  }
  return { tone, title, text, fix: e.fixHint || null, error: e.lastError || null, alert: bad };
}

/** Header "phase n/N" counter shown next to the Phases section title. */
export function phaseProgress(e) {
  const total = e?.phaseSpec?.length || 0;
  return { current: Math.min((e?.currentPhaseIdx || 0) + (e?.status === 'done' ? 0 : 1), total), total };
}

/** List-row summary: phase position, current phase name, agent + model. */
export function entryRowSummary(e) {
  const total = e.phaseSpec?.length || 0;
  const idx = Math.min(e.currentPhaseIdx || 0, Math.max(0, total - 1));
  const phase = e.phaseSpec?.[idx];
  const a = e.currentAttempt;
  return {
    position: e.status === 'done' ? `${total}/${total} phases` : `phase ${idx + 1}/${total}`,
    phaseName: phase?.name ?? '—',
    who: a ? agentLabel(a.agent) : agentLabel(phase?.agent),
    model: a ? attemptModelLabel(a) : phase?.model || null,
    ratio: total ? (e.status === 'done' ? 1 : idx / total) : 0,
  };
}

export const RETRY_AGENTS = ['claude-code', 'codex', 'opencode', 'gemini', 'grok'];

/** Retry form → queue.retry params (sans id). */
export function buildRetryParams(e, form) {
  const from = form.from < 0 ? e.currentPhaseIdx : form.from;
  const instruction = String(form.instruction || '').trim();
  const model = String(form.model || '').trim();
  return {
    ...(from !== e.currentPhaseIdx ? { fromPhase: from } : {}),
    ...(instruction ? { instruction } : {}),
    ...(form.fresh ? { freshSession: true } : {}),
    ...(form.agent ? { agent: form.agent } : {}),
    ...(model ? { model } : {}),
  };
}

export function backendState(b) {
  const tone = b.authState === 'ok' && b.available ? 'success' : b.authState === 'auth-required' ? 'warning' : 'neutral';
  const label =
    b.authState === 'ok' ? (b.available ? 'ok' : 'unavailable')
      : b.authState === 'auth-required' ? 'not logged in'
        : b.authState === 'not-installed' ? 'not installed'
          : 'unknown';
  const tip = [b.version ? `v${b.version}` : '', b.reason ?? '', b.fix ?? ''].filter(Boolean).join(' — ');
  return { tone, label, tip };
}

export function sortAttemptsDesc(attempts) {
  return [...(attempts || [])].sort((a, b) => b.n - a.n);
}

export function sortEventsDesc(events) {
  return [...(events || [])].sort((a, b) => b.seq - a.seq);
}

export function gatePassSummary(gate) {
  if (!gate) return null;
  const results = gate.results || [];
  return { pass: Boolean(gate.pass), passed: results.filter((r) => r.pass).length, total: results.length };
}

// ── Scheduled agent tasks ───────────────────────────────────────────────────

export const CLI_TARGETS = [
  { id: 'cli:claude-code', label: 'Claude Code' },
  { id: 'cli:codex', label: 'Codex' },
  { id: 'cli:opencode', label: 'OpenCode' },
  { id: 'cli:gemini', label: 'Gemini CLI' },
];

export const SCHEDULE_PRESETS = [
  { label: 'Daily 17:00', cron: '0 17 * * *' },
  { label: 'Daily 09:00', cron: '0 9 * * *' },
  { label: 'Weekdays 09:00', cron: '0 9 * * 1-5' },
  { label: 'Mondays 10:00', cron: '0 10 * * 1' },
];

export const ACTION_LABEL = {
  approve: 'Approve',
  reject: 'Reject',
  modify: 'Modify',
  snooze: 'Snooze 24h',
  start: 'Start build',
  approve_deploy: 'Approve deploy',
  reject_deploy: 'Reject deploy',
  retry: 'Retry',
  continue: 'Continue…',
};

export function actionVariant(a) {
  if (a === 'approve' || a === 'approve_deploy' || a === 'start') return 'primary';
  if (a === 'reject' || a === 'reject_deploy') return 'danger';
  return 'outline';
}

/** modify / continue open an instruction box instead of deciding directly. */
export function actionNeedsInstruction(a) {
  return a === 'modify' || a === 'continue';
}

export const PIPELINE_STEPS = ['Suggested', 'Approved', 'Building', 'Verified', 'Deploy approval', 'Deployed'];

export function stepOf(stage) {
  switch (stage) {
    case 'suggested':
      return [0, 'now'];
    case 'snoozed':
      return [0, 'off'];
    case 'rejected':
      return [0, 'fail'];
    case 'approved':
      return [1, 'now'];
    case 'building':
      return [2, 'now'];
    case 'build_failed':
      return [2, 'fail'];
    case 'awaiting_deploy':
      return [4, 'now'];
    case 'deploy_rejected':
      return [4, 'fail'];
    case 'deploying':
      return [5, 'now'];
    case 'deploy_failed':
      return [5, 'fail'];
    case 'deployed':
      return [5, 'done'];
    default:
      return [0, 'off'];
  }
}

/** [{label, state: 'done'|'now'|'fail'|'off'|'todo'}] for the stepper. */
export function stepperStates(stage) {
  const [cur, st] = stepOf(stage);
  return PIPELINE_STEPS.map((label, idx) => ({
    label,
    state: idx < cur || (idx === cur && st === 'done') ? 'done' : idx === cur ? st : 'todo',
  }));
}

export const NEEDS_YOU = new Set(['suggested', 'awaiting_deploy', 'build_failed', 'deploy_failed']);
export const IN_FLIGHT = new Set(['approved', 'building', 'deploying']);

export function stageTone(stage) {
  if (stage === 'deployed') return 'success';
  if (stage === 'build_failed' || stage === 'deploy_failed' || stage === 'rejected' || stage === 'deploy_rejected') return 'danger';
  if (stage === 'awaiting_deploy' || stage === 'suggested') return 'warning';
  if (IN_FLIGHT.has(stage)) return 'primary';
  return 'neutral';
}

export function riskTone(risk) {
  return risk === 'high' ? 'danger' : risk === 'medium' ? 'warning' : 'success';
}

export function groupItems(items) {
  const needs = [];
  const flight = [];
  const done = [];
  for (const i of items || []) {
    if (NEEDS_YOU.has(i.stage)) needs.push(i);
    else if (IN_FLIGHT.has(i.stage)) flight.push(i);
    else done.push(i);
  }
  return { needs, flight, done };
}

/** Bulk "approve all low-risk" — only when ≥2 low-risk suggestions share a run. */
export function lowRiskBatch(needs) {
  const low = (needs || []).filter((i) => i.stage === 'suggested' && i.item?.risk === 'low');
  if (low.length < 2) return null;
  const runId = low[0].runId;
  const n = low.filter((i) => i.runId === runId).length;
  if (n < 2) return null;
  return { runId, n };
}

export function scheduledHasInFlight(items, runs) {
  return (items || []).some((i) => IN_FLIGHT.has(i.stage)) || (runs || []).some((r) => r.status === 'running');
}

export function runningRun(runs) {
  return (runs || []).find((r) => r.status === 'running' || r.status === 'validating') || null;
}

export function runStatusTone(status) {
  return status === 'delivered' ? 'success' : status === 'failed' ? 'danger' : status === 'running' || status === 'validating' ? 'primary' : 'neutral';
}

export function totalAwaiting(tasks) {
  return (tasks || []).reduce((n, t) => n + (t.counts?.awaitingDecision || 0), 0);
}

export function scheduledTargetLabel(t) {
  if (!t) return '—';
  if (t.kind === 'agent') return `Agent · ${t.agentId}`;
  const name = CLI_TARGETS.find((c) => c.id === `cli:${t.backend}`)?.label ?? t.backend;
  return t.model ? `${name} · ${t.model}` : name;
}

export function whenText(ms, tz) {
  if (!ms) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz || undefined,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      day: 'numeric',
      month: 'short',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleString();
  }
}

export function scheduledCheckText(c) {
  if (!c) return '';
  if (c.label) return c.label;
  if (c.type === 'shell') return `$ ${c.command ?? ''}`;
  if (c.type === 'file') return `${c.negate ? 'absent' : 'exists'}: ${c.path ?? ''}`;
  if (c.type === 'grep') return `/${c.pattern ?? ''}/ in ${c.path ?? ''}`;
  return `AI judge: ${c.criterion ?? ''}`;
}

export function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function emptyTaskDraft(tz = localTimezone()) {
  return {
    id: null,
    name: '',
    cron: '0 17 * * *',
    timezone: tz,
    target: 'cli:claude-code',
    model: '',
    repos: [{ label: '', path: '', branch: '' }],
    instructions: '',
    telegram: true,
    ui: true,
    requireDeployApproval: true,
    autoContinueOnApprove: true,
    deployCommand: '',
    enabled: true,
  };
}

export function taskToDraft(t) {
  const a = t.assignee || { kind: 'cli', backend: 'claude-code' };
  return {
    id: t.id,
    name: t.name || '',
    cron: t.cron || '',
    timezone: t.timezone || 'UTC',
    target: a.kind === 'cli' ? `cli:${a.backend}` : `agent:${a.agentId}`,
    model: a.model ?? '',
    repos: t.repos?.length
      ? t.repos.map((r) => ({ label: r.label || '', path: r.path || '', branch: r.branch ?? '' }))
      : [{ label: '', path: '', branch: '' }],
    instructions: t.instructions || '',
    telegram: (t.delivery || []).includes('telegram'),
    ui: (t.delivery || []).includes('ui'),
    requireDeployApproval: Boolean(t.approval?.requireDeployApproval),
    autoContinueOnApprove: Boolean(t.approval?.autoContinueOnApprove),
    deployCommand: t.deployCommand ?? '',
    enabled: Boolean(t.enabled),
  };
}

/** Task form → scheduledTasks.create / update body, or { error }. */
export function buildTaskBody(d) {
  if (!String(d.name || '').trim()) return { error: 'Give the task a name.' };
  const repos = (d.repos || [])
    .filter((r) => String(r.path || '').trim())
    .map((r) => ({
      path: r.path.trim(),
      ...(String(r.label || '').trim() ? { label: r.label.trim() } : {}),
      ...(String(r.branch || '').trim() ? { branch: r.branch.trim() } : {}),
    }));
  if (!repos.length) return { error: 'Add at least one repository path to review.' };
  const delivery = [...(d.telegram ? ['telegram'] : []), ...(d.ui ? ['ui'] : [])];
  return {
    body: {
      name: d.name.trim(),
      cron: String(d.cron || '').trim(),
      timezone: String(d.timezone || '').trim() || 'UTC',
      assignee: parseTarget(d.target, d.model),
      repos,
      instructions: d.instructions || '',
      delivery: delivery.length ? delivery : ['ui'],
      approval: {
        requireDeployApproval: Boolean(d.requireDeployApproval),
        autoContinueOnApprove: Boolean(d.autoContinueOnApprove),
      },
      deployCommand: String(d.deployCommand || '').trim() || null,
      enabled: Boolean(d.enabled),
    },
  };
}

export function saveNotice(d, runNow) {
  if (d.id) return 'Task saved';
  return runNow ? 'Task created — first review started' : 'Task created';
}

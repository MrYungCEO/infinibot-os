/**
 * agency-ops-model — pure data logic for the native Agencies page
 * (web /agency-operations, ui/src/ui/views/agency-operations.ts).
 *
 * No React, no gateway: everything here is a function of RPC payloads so it is
 * unit-tested in node (src/__tests__/agency-ops-model.test.js). The screen and
 * its tabs only render what these functions return.
 */

// ── Sections (the web's section nav, same ids and order) ─────────────────────
export const SECTIONS = [
  { key: 'overview', label: 'Command center', icon: 'speedometer-outline' },
  { key: 'delivery', label: 'Projects & tasks', icon: 'albums-outline' },
  { key: 'finance', label: 'Clients & revenue', icon: 'cash-outline' },
  { key: 'employees', label: 'Employees', icon: 'people-outline' },
  { key: 'employee-ops', label: 'Employee ops', icon: 'repeat-outline' },
  { key: 'allocation', label: 'Work allocation', icon: 'git-network-outline' },
  { key: 'approvals', label: 'Approval inbox', icon: 'checkmark-done-outline' },
  { key: 'activity', label: 'Activity & audit', icon: 'time-outline' },
  { key: 'reliability', label: 'Reliability', icon: 'shield-checkmark-outline' },
  { key: 'settings', label: 'Agency settings', icon: 'settings-outline' },
];

export const TASK_BOARD_STATUSES = [
  ['backlog', 'Backlog'],
  ['ready', 'Ready'],
  ['in_progress', 'In progress'],
  ['blocked', 'Blocked'],
  ['review', 'Review'],
  ['done', 'Done'],
];

export const TASK_EDIT_STATUSES = [...TASK_BOARD_STATUSES, ['cancelled', 'Cancelled']];

export const PROJECT_STATUSES = [
  ['planned', 'Planned'],
  ['active', 'Active'],
  ['on_hold', 'On hold'],
  ['completed', 'Completed'],
  ['cancelled', 'Cancelled'],
];

export const KANBAN_PROJECT_STATUS_OPTIONS = [
  ['Not started', 'Not started'],
  ['In progress', 'In progress'],
  ['Reviewing', 'Reviewing'],
  ['Awaiting Client', 'Awaiting client'],
  ['Completed', 'Completed'],
];

export const KANBAN_TASK_STATUS_OPTIONS = [
  ['backlog', 'Backlog'],
  ['todo', 'To do'],
  ['in_progress', 'In progress'],
  ['review', 'In review'],
  ['done', 'Done'],
];

/** Byte-identical to the web's KANBAN_ACTIVE_STATUSES (the /projects "Active" filter). */
export const KANBAN_ACTIVE_STATUSES = new Set(['In progress', 'Updating', 'Reviewing', 'Awaiting Client']);

export const PRIORITY_OPTIONS = [
  ['low', 'Low'],
  ['normal', 'Normal'],
  ['high', 'High'],
  ['urgent', 'Urgent'],
];

export const AUTONOMY_LEVELS = [
  { level: 0, label: 'Advisory', short: 'Never executes', detail: 'Proposes only. Every action needs a human to carry it out.', tone: 'neutral' },
  { level: 1, label: 'Supervised', short: 'Always lands in review', detail: 'Executes, but every result stops in review before it counts as done.', tone: 'info' },
  { level: 2, label: 'Bounded', short: 'Auto-completes under threshold', detail: 'Completes work unattended while estimated cost stays under the approval threshold; anything above it escalates.', tone: 'warning' },
  { level: 3, label: 'Autonomous', short: 'Auto-completes', detail: 'Completes work unattended. Nothing is held for review by default.', tone: 'danger' },
];

export function describeAutonomy(level) {
  if (typeof level !== 'number' || !Number.isFinite(level)) return null;
  return AUTONOMY_LEVELS.find((entry) => entry.level === Math.trunc(level)) ?? null;
}

export const EMPLOYEE_CHANNEL_IDS = ['discord', 'slack', 'telegram', 'whatsapp', 'signal', 'line', 'imessage'];
const CHANNEL_LABELS = {
  discord: 'Discord', slack: 'Slack', telegram: 'Telegram', whatsapp: 'WhatsApp',
  signal: 'Signal', line: 'LINE', imessage: 'iMessage',
};
export const channelLabel = (id) => CHANNEL_LABELS[id] ?? id;

export const COMMUNICATION_TONES = ['formal', 'professional', 'friendly', 'casual', 'blunt'];
export const COMMUNICATION_VERBOSITY = ['terse', 'concise', 'balanced', 'detailed'];
export const PROACTIVITY_LEVELS = ['reactive', 'responsive', 'proactive', 'driving'];
export const EMOJI_USAGE = ['none', 'sparing', 'expressive'];
export const OUTSIDE_HOURS_BEHAVIOURS = ['defer', 'auto_reply', 'respond'];
export const REPORT_CADENCES = ['continuous', 'hourly', 'daily', 'weekly', 'biweekly', 'monthly'];

export const MIGRATION_CONFIRMATION = 'RE-IMPORT';

export const EMPTY_FINANCE = {
  currency: 'USD', revenueMonth: 0, cashCollectedMonth: 0, mrr: 0, arr: 0, revenueTarget: 0,
  contractedBacklog: 0, outstandingReceivables: 0, overdueReceivables: 0, grossMarginPercent: 0,
  aiSpendMonth: 0, payrollMonth: 0,
};

// ── Formatting ───────────────────────────────────────────────────────────────
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function money(value, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(num(value));
  } catch {
    return `$${Math.round(num(value)).toLocaleString('en-US')}`;
  }
}

/** Exact cents rendering (receivables, balances) — never rounds a debt away. */
export function moneyCents(cents, currency = 'USD') {
  const value = num(cents) / 100;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(value) {
  if (value === null || value === undefined || value === '') return 'No date';
  const n = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(n)) return 'No date';
  const d = new Date(n);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function relativeTime(value, now = Date.now()) {
  const n = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(n)) return '';
  const diff = now - n;
  const abs = Math.abs(diff);
  const future = diff < 0;
  const fmt = (q, u) => (future ? `in ${q}${u}` : `${q}${u} ago`);
  if (abs < 60_000) return future ? 'in a moment' : 'just now';
  const m = Math.floor(abs / 60_000);
  if (m < 60) return fmt(m, 'm');
  const h = Math.floor(m / 60);
  if (h < 24) return fmt(h, 'h');
  const d = Math.floor(h / 24);
  if (d < 45) return fmt(d, 'd');
  return shortDate(n);
}

export function fileSize(bytes) {
  const b = num(bytes);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export const titleCase = (value) => {
  const s = String(value ?? '');
  return s.length ? s[0].toUpperCase() + s.slice(1).replace(/_/g, ' ') : s;
};
export const humanize = (value) => String(value ?? '').replace(/_/g, ' ');
export const initials = (name) => String(name ?? '?').trim().slice(0, 2).toUpperCase() || '?';
export const nameKey = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Allocation tone (web allocationTone): >100 danger, >85 warning, else success. */
export function allocationTone(pct) {
  if (pct > 100) return 'danger';
  if (pct > 85) return 'warning';
  return 'success';
}

// ── RPC unwrapping + load normalisation ─────────────────────────────────────
export function unwrap(value, key, fallback) {
  if (value && typeof value === 'object' && !Array.isArray(value) && key in value) return value[key];
  if (value === null || value === undefined) return fallback;
  return value;
}

const asArray = (v) => (Array.isArray(v) ? v : []);

/** The 26 panel RPCs the web loads for one agency (same params). */
export function panelRequests(agencyId) {
  return [
    ['dashboard', 'agency.ops.dashboard', { agencyId }],
    ['pipeline', 'agency.ops.pipeline.list', { agencyId }],
    ['engagements', 'agency.ops.engagements.list', { agencyId, status: 'active' }],
    ['approvals', 'agency.ops.approvals.list', { agencyId, status: 'pending' }],
    ['employees', 'agency.ops.employees.list', { agencyId, status: 'active' }],
    ['finance', 'agency.ops.finance.summary', { agencyId, period: 'month' }],
    ['invoices', 'agency.ops.invoices.list', { agencyId }],
    ['revenue', 'agency.ops.revenue.summary', { agencyId }],
    ['clients', 'agency.ops.clients.list', { agencyId }],
    ['projects', 'agency.ops.projects.list', { agencyId }],
    ['tasks', 'agency.ops.tasks.list', { agencyId }],
    ['clientSync', 'agency.ops.clients.source.status', { agencyId }],
    ['members', 'agency.ops.members.list', { agencyId }],
    ['audit', 'agency.ops.audit.list', { agencyId, limit: 100 }],
    ['assignments', 'agency.ops.assignments.list', { agencyId }],
    ['workItems', 'agency.ops.employee.inbox.list', { agencyId, limit: 250 }],
    ['schedules', 'agency.ops.employee.schedules.list', { agencyId }],
    ['responsibilities', 'agency.ops.employee.responsibilities.list', { agencyId }],
    ['reviews', 'agency.ops.employee.reviews.list', { agencyId }],
    ['sops', 'agency.ops.sops.list', { agencyId }],
    ['escalations', 'agency.ops.escalations.list', { agencyId }],
    ['kanbanProjects', 'kanban.projects.list', {}],
    ['kanbanTasks', 'kanban.tasks.list', {}],
  ];
}

/** Diagnostics loaded after the operating data paints (web does the same). */
export function diagnosticRequests(agencyId, canAdmin) {
  const out = [['replication', 'agency.ops.replication.status', { agencyId }]];
  if (canAdmin) {
    out.push(['dbHealth', 'agency.ops.database.health', { agencyId }]);
    out.push(['backups', 'agency.ops.database.backups.list', { agencyId }]);
  }
  return out;
}

export function pickSelectedAgency(agencies, preferredId) {
  const list = asArray(agencies);
  if (preferredId && list.some((a) => a.id === preferredId)) return preferredId;
  return list.find((a) => a.role === 'owner')?.id ?? list[0]?.id ?? null;
}

const IN_PROGRESS_KANBAN = new Set(['in progress', 'in_progress', 'updating', 'reviewing', 'active']);

/**
 * Folds a map of { key: result | null } into page state, keeping the previous
 * value for any panel whose request failed (never blank a panel on a blip).
 */
export function normalizePanels(results, prev = {}) {
  const r = results || {};
  const keep = (key, value) => (r[key] === null || r[key] === undefined ? prev[key] : value);
  const dashboard = unwrap(r.dashboard, 'dashboard', {}) || {};
  const pipeline = unwrap(r.pipeline, 'pipeline', {}) || {};
  const next = {
    kpis: keep('dashboard', asArray(dashboard.kpis)) ?? [],
    dashboardSummary: keep('dashboard', dashboard.summary ?? null) ?? null,
    pipelineStages: keep('pipeline', asArray(pipeline.stages)) ?? [],
    pipelineDeals: keep('pipeline', asArray(pipeline.deals)) ?? [],
    engagements: keep('engagements', asArray(unwrap(r.engagements, 'engagements', []))) ?? [],
    approvals: keep('approvals', asArray(unwrap(r.approvals, 'approvals', []))) ?? [],
    employees: keep('employees', asArray(unwrap(r.employees, 'employees', []))) ?? [],
    finance: keep('finance', { ...EMPTY_FINANCE, ...(unwrap(r.finance, 'finance', {}) || {}) }) ?? { ...EMPTY_FINANCE },
    invoices: keep('invoices', asArray(unwrap(r.invoices, 'invoices', []))) ?? [],
    clients: keep('clients', asArray(unwrap(r.clients, 'clients', []))) ?? [],
    knownPipelineStatuses: keep('clients', asArray(r.clients?.knownPipelineStatuses)) ?? [],
    projects: keep('projects', asArray(unwrap(r.projects, 'projects', []))) ?? [],
    tasks: keep('tasks', asArray(unwrap(r.tasks, 'tasks', []))) ?? [],
    clientSync: keep('clientSync', r.clientSync ?? null) ?? null,
    members: keep('members', asArray(unwrap(r.members, 'members', []))) ?? [],
    auditEvents: keep('audit', asArray(unwrap(r.audit, 'events', []))) ?? [],
    assignments: keep('assignments', asArray(unwrap(r.assignments, 'assignments', []))) ?? [],
    workItems: keep('workItems', asArray(unwrap(r.workItems, 'workItems', []))) ?? [],
    schedules: keep('schedules', asArray(unwrap(r.schedules, 'schedules', []))) ?? [],
    responsibilities: keep('responsibilities', asArray(unwrap(r.responsibilities, 'responsibilities', []))) ?? [],
    reviewCycles: keep('reviews', asArray(unwrap(r.reviews, 'reviewCycles', []))) ?? [],
    sops: keep('sops', asArray(unwrap(r.sops, 'sops', []))) ?? [],
    sopsLoaded: r.sops !== null && r.sops !== undefined ? true : !!prev.sopsLoaded,
    escalations: keep('escalations', asArray(unwrap(r.escalations, 'escalations', []))) ?? [],
    revenue: keep('revenue', unwrap(r.revenue, 'revenue', null)) ?? null,
    revenueEntries: keep('revenue', asArray(r.revenue?.entries)) ?? [],
    kanbanProjects: prev.kanbanProjects ?? [],
    kanbanTasks: prev.kanbanTasks ?? [],
  };
  if (r.kanbanProjects) {
    next.kanbanProjects = asArray(unwrap(r.kanbanProjects, 'projects', []))
      .filter((kp) => kp?.id)
      .map((kp) => ({ id: String(kp.id), name: kp.name ?? String(kp.id), status: kp.status, archived: kp.archived, businessId: kp.businessId }));
    // Mirror kanban in-progress projects into the agency register (web parity).
    const projects = next.projects.map((p) => ({ ...p }));
    const byId = new Map(projects.map((p) => [p.id, p]));
    const byName = new Map(projects.map((p) => [nameKey(p.name), p]));
    for (const kp of next.kanbanProjects) {
      if (kp.archived || !IN_PROGRESS_KANBAN.has(nameKey(kp.status))) continue;
      const existing = byId.get(kp.id) ?? byName.get(nameKey(kp.name));
      if (existing) { existing.status = 'active'; continue; }
      projects.push({ id: kp.id, clientId: null, name: kp.name, status: 'active', budgetCents: 0, mrrCents: 0, targetEndAt: null, mirrored: true });
    }
    next.projects = projects;
  }
  if (r.kanbanTasks) {
    next.kanbanTasks = asArray(unwrap(r.kanbanTasks, 'tasks', []))
      .filter((kt) => kt?.id && kt?.projectId)
      .map((kt) => ({ id: String(kt.id), projectId: String(kt.projectId), title: kt.title ?? 'Untitled task', status: String(kt.status ?? ''), done: kt.done, priority: kt.priority }));
  }
  return next;
}

// ── Command center (overview) ────────────────────────────────────────────────
export function overviewKpis(s) {
  if (s.kpis?.length) {
    return s.kpis.map((k) => ({
      label: k.label,
      value: String(k.value),
      context: k.change === undefined || k.change === null ? (k.context ?? '') : `${k.change >= 0 ? 'Up' : 'Down'} ${Math.abs(k.change)}% ${k.context ?? ''}`.trim(),
      tone: k.tone === 'negative' || k.tone === 'danger' ? 'danger' : k.tone === 'positive' || k.tone === 'good' ? 'success' : 'primary',
    }));
  }
  const f = s.finance || EMPTY_FINANCE;
  const util = s.employees?.length ? Math.round(s.employees.reduce((sum, e) => sum + num(e.utilizationPercent), 0) / s.employees.length) : 0;
  return [
    { label: 'Active engagements', value: String(s.engagements?.length ?? 0), context: 'Live client work', tone: 'primary' },
    { label: 'Cash collected', value: money(f.cashCollectedMonth, f.currency), context: 'Payments received', tone: 'primary' },
    { label: 'Pending decisions', value: String(s.approvals?.length ?? 0), context: 'Human approval required', tone: 'primary' },
    { label: 'Gross margin', value: `${num(f.grossMarginPercent)}%`, context: 'Current month', tone: 'primary' },
    { label: 'Team utilization', value: `${util}%`, context: 'Human + AI workforce', tone: 'primary' },
  ];
}

export const isKanbanTaskDone = (t) => t.status === 'done' || t.done === true;

export function kanbanProjectRoll(kanbanTasks, projectId) {
  const tasks = asArray(kanbanTasks).filter((t) => t.projectId === projectId);
  const done = tasks.filter(isKanbanTaskDone).length;
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length;
  const open = tasks.filter((t) => !isKanbanTaskDone(t));
  return { total: tasks.length, done, inProgress, pct: tasks.length ? Math.round((done / tasks.length) * 100) : 0, open };
}

export function taskStatusMeta(status) {
  switch (status) {
    case 'in_progress': return { label: 'In progress', tone: 'info' };
    case 'review': return { label: 'In review', tone: 'warning' };
    case 'backlog': return { label: 'Backlog', tone: 'neutral' };
    default: return { label: 'To do', tone: 'neutral' };
  }
}

/** Active Projects panel: kanban "Active" projects grouped by CRM client. */
export function activeProjectGroups(s) {
  const active = asArray(s.kanbanProjects).filter((p) => !p.archived && KANBAN_ACTIVE_STATUSES.has(String(p.status ?? '')));
  const clientsById = new Map(asArray(s.clients).map((c) => [c.id, c]));
  const agencyById = new Map(asArray(s.projects).map((p) => [p.id, p]));
  const agencyByName = new Map(asArray(s.projects).map((p) => [nameKey(p.name), p]));
  const INTERNAL = '__internal__';
  const groups = new Map();
  for (const project of active) {
    const agency = agencyById.get(project.id) ?? agencyByName.get(nameKey(project.name));
    const clientId = agency?.clientId && clientsById.has(agency.clientId) ? agency.clientId : null;
    const key = clientId ?? INTERNAL;
    const name = key === INTERNAL ? 'Internal / Unassigned' : clientsById.get(key).name;
    if (!groups.has(key)) groups.set(key, { key, clientId, name, projects: [] });
    groups.get(key).projects.push({ id: project.id, name: project.name, status: String(project.status ?? 'In progress'), agencyProjectId: agency?.id ?? null });
  }
  return [...groups.values()].sort((a, b) => (a.key === INTERNAL ? 1 : b.key === INTERNAL ? -1 : a.name.localeCompare(b.name)));
}

export function activeKanbanCount(s) {
  return asArray(s.kanbanProjects).filter((p) => !p.archived && KANBAN_ACTIVE_STATUSES.has(String(p.status ?? ''))).length;
}

/** Decision queue: pending approvals + queued (staged) employee work items. */
export function decisionQueue(s) {
  const workerName = new Map(asArray(s.employees).map((e) => [e.id, e.name]));
  const staged = asArray(s.workItems).filter((i) => i.status === 'queued');
  const risk = (p) => (p === 'urgent' || p === 'high' ? 'high' : p === 'low' ? 'low' : 'medium');
  return [
    ...asArray(s.approvals).map((a) => ({
      kind: 'approval', id: a.id, risk: a.risk ?? 'medium', at: a.requestedAt, title: a.title,
      detail: a.description ?? `${a.type ?? 'Action'} approval requested by ${a.requestedBy ?? 'an employee'}`,
      amount: a.amount ?? null, currency: a.currency ?? null,
    })),
    ...staged.map((i) => ({
      kind: 'work', id: i.id, risk: risk(i.priority), riskLabel: `${i.priority} priority`, at: i.updatedAt, title: i.title,
      detail: `${firstLine(i.instructions) || 'Staged work awaiting authorization.'} · ${workerName.get(i.workerId) ?? 'Unassigned worker'}`,
    })),
  ];
}

export function firstLine(text, max = 160) {
  const line = String(text ?? '').split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function sortedApprovals(approvals) {
  const rank = { high: 3, medium: 2, low: 1 };
  return [...asArray(approvals)].sort((a, b) => (rank[b.risk] ?? 0) - (rank[a.risk] ?? 0) || num(a.requestedAt) - num(b.requestedAt));
}

export function filterEmployees(employees, { filter = 'all', search = '' } = {}) {
  const needle = String(search).trim().toLowerCase();
  return asArray(employees).filter((e) => {
    if (filter !== 'all' && e.kind !== filter) return false;
    if (!needle) return true;
    return [e.name, e.role, e.department, e.model, e.modelBinding].filter((p) => typeof p === 'string').some((p) => p.toLowerCase().includes(needle));
  });
}

export function employeeSummary(employees) {
  const list = asArray(employees);
  return {
    total: list.length,
    humans: list.filter((e) => e.kind === 'human').length,
    ai: list.filter((e) => e.kind === 'ai').length,
    blocked: list.filter((e) => e.availability === 'blocked').length,
    autonomous: list.filter((e) => (e.autonomyLevel ?? -1) >= 2).length,
  };
}

export function allocationPct(e) {
  return e.capacityHours ? Math.round((num(e.allocatedHours) / num(e.capacityHours)) * 100) : 0;
}

// ── Delivery ─────────────────────────────────────────────────────────────────
export function deliveryKpis(s) {
  const tasks = asArray(s.tasks);
  const open = tasks.filter((t) => !['done', 'cancelled'].includes(t.status));
  const blocked = open.filter((t) => t.status === 'blocked');
  return {
    projects: asArray(s.projects).length,
    activeProjects: asArray(s.projects).filter((p) => p.status === 'active').length,
    open: open.length,
    done: tasks.filter((t) => t.status === 'done').length,
    blocked: blocked.length,
    aiAssigned: open.filter((t) => t.assigneeType === 'ai').length,
  };
}

export function tasksByProject(tasks) {
  const map = new Map();
  for (const t of asArray(tasks)) {
    const list = map.get(t.projectId) ?? [];
    list.push(t);
    map.set(t.projectId, list);
  }
  return map;
}

export function projectRoll(tasks) {
  const list = asArray(tasks);
  const active = list.filter((t) => !['done', 'cancelled'].includes(t.status));
  const done = list.filter((t) => t.status === 'done').length;
  return { total: list.length, done, active, pct: list.length ? Math.round((done / list.length) * 100) : 0 };
}

export function scopedProjects(projects, clientFilter) {
  return clientFilter ? asArray(projects).filter((p) => p.clientId === clientFilter) : asArray(projects);
}

export function boardColumns(s, { projectFilter = '', clientFilter = '' } = {}) {
  const clientProjectIds = clientFilter ? new Set(asArray(s.projects).filter((p) => p.clientId === clientFilter).map((p) => p.id)) : null;
  const filtered = asArray(s.tasks).filter((t) => (!projectFilter || t.projectId === projectFilter) && (!clientProjectIds || clientProjectIds.has(t.projectId)));
  const cols = new Map(TASK_BOARD_STATUSES.map(([key]) => [key, []]));
  for (const t of filtered) {
    if (!cols.has(t.status)) cols.set(t.status, []);
    cols.get(t.status).push(t);
  }
  return [...cols.entries()].map(([key, tasks]) => ({
    key,
    label: TASK_BOARD_STATUSES.find(([k]) => k === key)?.[1] ?? titleCase(key),
    tasks,
  }));
}

// ── Clients & revenue ───────────────────────────────────────────────────────
const DEFAULT_PIPELINE = ['Cold', 'Lead', 'In progress', 'Updating', 'Won', 'Active', 'Completed', 'Archived', 'Lost', 'Cancelled', 'Inactive'];

export function clientKanbanColumns(s) {
  const known = s.knownPipelineStatuses?.length ? [...s.knownPipelineStatuses] : [...DEFAULT_PIPELINE];
  const seen = new Set(known.map((l) => l.toLowerCase()));
  for (const c of asArray(s.clients)) {
    const label = c.pipelineStatusLabel ?? c.pipelineStatus;
    if (label && !seen.has(label.toLowerCase())) { seen.add(label.toLowerCase()); known.push(label); }
  }
  return known;
}

export function clientsByPipeline(s, clients) {
  const byCol = new Map(clientKanbanColumns(s).map((l) => [l.toLowerCase(), []]));
  for (const c of asArray(clients)) {
    const key = String(c.pipelineStatusLabel ?? c.pipelineStatus ?? 'Cold').trim().toLowerCase();
    if (!byCol.has(key)) byCol.set(key, []);
    byCol.get(key).push(c);
  }
  return byCol;
}

export function filterClients(clients, search) {
  const needle = String(search ?? '').trim().toLowerCase();
  if (!needle) return asArray(clients);
  return asArray(clients).filter((c) => String(c.name ?? '').toLowerCase().includes(needle) || String(c.billingEmail ?? '').toLowerCase().includes(needle));
}

export function financeKpis(s) {
  const rev = s.revenue || {};
  const f = s.finance || EMPTY_FINANCE;
  const currency = rev.currency ?? f.currency ?? 'USD';
  const clients = asArray(s.clients);
  const activeClients = clients.filter((c) => c.status === 'active').length;
  return [
    { label: 'Client records', value: String(clients.length), context: `${activeClients} active · ${clients.length - activeClients} prospects/inactive` },
    { label: 'Invoiced this month', value: money(num(rev.invoicedRevenueCents) / 100, currency), context: 'Accrual revenue' },
    { label: 'Cash collected', value: money(num(rev.collectedRevenueCents) / 100, currency), context: 'Payment ledger' },
    { label: 'MRR', value: money(num(rev.mrrCents) / 100, currency), context: `${num(rev.activeMrrClients)} recurring clients` },
    { label: 'ARR run rate', value: money(num(rev.arrCents) / 100, currency), context: 'MRR x 12' },
    { label: 'Receivables', value: money(f.outstandingReceivables, currency), context: `${money(f.overdueReceivables, currency)} overdue`, tone: num(f.overdueReceivables) > 0 ? 'danger' : 'primary' },
  ];
}

export function collectionRate(revenue) {
  const inv = num(revenue?.invoicedRevenueCents);
  return inv > 0 ? Math.round((num(revenue?.collectedRevenueCents) / inv) * 100) : 0;
}

export function financeEmployeeWork(s) {
  const fe = asArray(s.employees).find((e) => String(e.role ?? '').toLowerCase().includes('finance') || e.name === 'Felix');
  if (!fe) return { employee: null, work: [] };
  return { employee: fe, work: asArray(s.workItems).filter((i) => i.workerId === fe.id && !['completed', 'cancelled'].includes(i.status)) };
}

/** Invoice statuses that still accept a payment against a positive balance. */
export function invoiceAcceptsPayment(invoice) {
  return num(invoice?.balanceCents) > 0 && ['issued', 'partially_paid', 'overdue'].includes(invoice?.status);
}

export function isOverdue(invoice, asOf = Date.now()) {
  if (invoice?.status === 'overdue') return true;
  if (!['issued', 'partially_paid'].includes(invoice?.status)) return false;
  return num(invoice.balanceCents) > 0 && invoice.dueAt !== null && invoice.dueAt !== undefined && invoice.dueAt < asOf;
}

/** Client revenue rollup (web summarizeClientInvoices). */
export function summarizeClientInvoices(invoices, asOf = Date.now()) {
  const list = asArray(invoices).filter((i) => i.status !== 'void' && i.status !== 'voided');
  let invoicedCents = 0; let collectedCents = 0; let outstandingCents = 0; let overdueCents = 0;
  let paidCount = 0; let openCount = 0; let overdueCount = 0;
  for (const inv of list) {
    invoicedCents += num(inv.totalCents);
    collectedCents += num(inv.amountPaidCents);
    if (inv.status === 'paid') paidCount += 1;
    if (num(inv.balanceCents) > 0 && inv.status !== 'draft') { outstandingCents += num(inv.balanceCents); openCount += 1; }
    if (isOverdue(inv, asOf)) { overdueCents += num(inv.balanceCents); overdueCount += 1; }
  }
  return { invoices: asArray(invoices), invoicedCents, collectedCents, outstandingCents, overdueCents, paidCount, openCount, overdueCount };
}

/** Client profile — deadlines and activity timeline (web renderClientProfile). */
export function clientProfile(s, clientId, notes = [], now = Date.now()) {
  const projects = asArray(s.projects).filter((p) => p.clientId === clientId);
  const ids = new Set(projects.map((p) => p.id));
  const tasks = asArray(s.tasks).filter((t) => ids.has(t.projectId));
  const invoices = asArray(s.invoices).filter((i) => i.clientId === clientId);
  const pname = (id) => projects.find((p) => p.id === id)?.name ?? 'Project';
  const deadlines = [];
  for (const p of projects) {
    if (p.targetEndAt && !['completed', 'cancelled'].includes(p.status)) deadlines.push({ kind: 'project', name: p.name, due: p.targetEndAt, context: humanize(p.status), overdue: p.targetEndAt < now });
  }
  for (const t of tasks) {
    if (t.dueAt && !['done', 'cancelled'].includes(t.status)) deadlines.push({ kind: 'task', name: t.title, due: t.dueAt, context: pname(t.projectId), overdue: t.dueAt < now });
  }
  deadlines.sort((a, b) => a.due - b.due);
  const timeline = [];
  for (const inv of invoices) {
    if (inv.issuedAt) timeline.push({ ts: inv.issuedAt, icon: 'receipt-outline', label: `Invoice ${inv.number} issued · ${moneyCents(inv.totalCents, inv.currency)}`, sub: humanize(inv.status) });
    if (num(inv.amountPaidCents) > 0 && (inv.status === 'paid' || inv.status === 'partially_paid')) {
      timeline.push({ ts: inv.issuedAt ?? now, icon: 'cash-outline', label: `Payment · ${moneyCents(inv.amountPaidCents, inv.currency)} on ${inv.number}`, sub: humanize(inv.status) });
    }
  }
  for (const p of projects) if (p.targetEndAt) timeline.push({ ts: p.targetEndAt, icon: 'flag-outline', label: `${p.name} target`, sub: humanize(p.status) });
  for (const n of asArray(notes)) {
    const ts = typeof n.updatedAt === 'number' ? n.updatedAt : Date.parse(n.updatedAt);
    timeline.push({ ts: Number.isFinite(ts) ? ts : 0, icon: 'document-text-outline', label: `Note · ${n.name}`, sub: String(n.body ?? '').slice(0, 60) });
  }
  timeline.sort((a, b) => b.ts - a.ts);
  const board = PROJECT_STATUSES.map(([status, label]) => ({ status, label, projects: projects.filter((p) => p.status === status) }));
  return { projects, tasks, invoices, deadlines, timeline, board };
}

export function normalizeNotes(result) {
  const notes = asArray(unwrap(result, 'notes', []));
  return notes
    .map((n) => ({ id: String(n.id ?? ''), name: String(n.name ?? 'Untitled'), body: String(n.body ?? ''), updatedAt: n.updatedAt ?? Date.now() }))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

export const clientNoteTag = (id) => `client:${id}`;
export const projectNoteTag = (id) => `project:${id}`;

// ── Employee ops ─────────────────────────────────────────────────────────────
export function nextWorkItemStatus(status) {
  if (status === 'queued') return 'accepted';
  if (status === 'accepted' || status === 'waiting') return 'in_progress';
  if (status === 'in_progress') return 'review';
  if (status === 'review' || status === 'escalated') return 'completed';
  return null;
}

export function employeeOpsSummary(s) {
  const active = asArray(s.workItems).filter((i) => !['completed', 'cancelled'].includes(i.status));
  return {
    open: active.length,
    escalated: active.filter((i) => i.status === 'escalated').length,
    duties: asArray(s.responsibilities).filter((r) => r.enabled).length,
    reviewsDue: asArray(s.reviewCycles).filter((r) => ['due', 'overdue'].includes(r.status)).length,
  };
}

export const workerNameOf = (employees, id) => asArray(employees).find((e) => e.id === id)?.name ?? id ?? 'Unassigned';

// ── Allocation ───────────────────────────────────────────────────────────────
export function allocationSummary(employees) {
  const sorted = [...asArray(employees)].sort((a, b) => num(b.utilizationPercent) - num(a.utilizationPercent));
  return {
    sorted,
    capacity: sorted.reduce((sum, e) => sum + num(e.capacityHours), 0),
    allocated: sorted.reduce((sum, e) => sum + num(e.allocatedHours), 0),
    over: sorted.filter((e) => num(e.allocatedHours) > num(e.capacityHours)).length,
  };
}

/** Live oversight strip for Work allocation (running / waiting / off-track). */
export function oversightSummary(s) {
  const items = asArray(s.workItems);
  const running = items.filter((i) => i.status === 'in_progress');
  const waiting = items.filter((i) => i.status === 'queued' || i.status === 'review');
  const offTrack = items.filter((i) => i.status === 'escalated' || (i.dueAt && i.dueAt < Date.now() && !['completed', 'cancelled'].includes(i.status)));
  return { running, waiting, offTrack, escalations: asArray(s.escalations) };
}

// ── Activity ─────────────────────────────────────────────────────────────────
export function auditEntityLabel(s, entityType, entityId) {
  const type = String(entityType ?? '').toLowerCase();
  if (type.includes('task')) return asArray(s.tasks).find((i) => i.id === entityId)?.title;
  if (type.includes('project')) return asArray(s.projects).find((i) => i.id === entityId)?.name;
  if (type.includes('client')) return asArray(s.clients).find((i) => i.id === entityId)?.name;
  if (type.includes('worker') || type.includes('employee')) return asArray(s.employees).find((i) => i.id === entityId)?.name;
  if (type.includes('invoice')) return asArray(s.invoices).find((i) => i.id === entityId)?.number;
  if (type.startsWith('agency')) return asArray(s.agencies).find((i) => i.id === entityId)?.name ?? 'Agency settings';
  return undefined;
}

/** Where an audit row navigates (web focusAgencyAuditEntity). */
export function auditTarget(s, entityType, entityId) {
  const type = String(entityType ?? '').toLowerCase();
  if (type.includes('task')) {
    const t = asArray(s.tasks).find((i) => i.id === entityId);
    return t ? { section: 'delivery', projectId: t.projectId } : null;
  }
  if (type.includes('project')) return asArray(s.projects).some((i) => i.id === entityId) ? { section: 'delivery', projectId: entityId } : null;
  if (type.includes('client')) return asArray(s.clients).some((i) => i.id === entityId) ? { section: 'delivery', clientId: entityId } : null;
  if (type.includes('worker') || type.includes('employee')) return asArray(s.employees).some((i) => i.id === entityId) ? { section: 'employees', employeeId: entityId } : null;
  if (type.includes('invoice') || type.includes('revenue') || type.includes('payment')) return { section: 'finance' };
  if (type.startsWith('agency')) return { section: 'settings' };
  return null;
}

// ── Replication + reliability ───────────────────────────────────────────────
export function syncBanner(status) {
  const st = status?.state;
  const tone = st === 'in_sync' ? 'success' : st === 'offline' ? 'warning' : st === 'error' ? 'danger' : 'info';
  const title = st === 'in_sync' ? 'Shared agency data is in sync'
    : st === 'offline' ? 'Offline mode — local work is safely retained'
      : st === 'error' ? 'Shared data sync needs attention'
        : st === 'pending' ? 'Local changes are waiting to sync'
          : 'Shared data sync is ready';
  const detail = status?.lastError
    ?? (status?.lastSyncAt
      ? `Last reconciled ${shortDate(status.lastSyncAt)}${status.conflicts ? ` · ${status.conflicts} conflict(s) logged` : ''}`
      : 'This node stores agency data locally and reconciles it with the master after reconnect.');
  return { tone, title, detail, conflicts: num(status?.conflicts) };
}

export function roleCaps(role) {
  const canAdmin = role === 'owner' || role === 'admin';
  return { canAdmin, canWrite: canAdmin || role === 'member', isOwner: role === 'owner' };
}

export function healthLine(health) {
  if (!health) return { ok: false, text: 'Database health is unavailable.' };
  if (health.ok) return { ok: true, text: 'Database integrity, schema and latest recovery point are healthy.' };
  return {
    ok: false,
    text: `Reliability needs attention: integrity ${health.integrity}; schema ${health.schema?.upToDate ? 'current' : 'not current'}; latest backup ${health.latestVerified ? 'verified' : 'unverified or missing'}.`,
  };
}

/** SOP run, phrased as an outcome. */
export function lastRunSummary(runs, now = Date.now()) {
  const latest = [...asArray(runs)].sort((a, b) => num(b.createdAt) - num(a.createdAt))[0];
  if (!latest) return null;
  const tone = latest.status === 'failed' ? 'danger' : latest.status === 'cancelled' ? 'warning' : latest.status === 'materialised' ? 'success' : 'info';
  const outcome = latest.status === 'materialised' ? 'produced work' : latest.status === 'pending' ? 'queued' : latest.status;
  return { label: `Last run ${outcome} · ${relativeTime(latest.createdAt, now)}`, tone };
}

export function stringifyMemoryValue(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

/** Round-trips stringifyMemoryValue: valid JSON stays typed, prose stays a string. */
export function parseMemoryValue(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  try { return JSON.parse(trimmed); } catch { return raw; }
}

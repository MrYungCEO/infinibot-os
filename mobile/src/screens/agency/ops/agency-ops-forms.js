/**
 * agency-ops-forms — every create/edit dialog on the web Agencies page, as data.
 *
 * Each dialog kind has:
 *   buildDraft(kind, state, opts)  -> initial string-valued draft (web openAgencyOpsDialog)
 *   dialogFields(draft, state)     -> field specs the native FormSheet renders
 *   dialogValid(draft)             -> same validity rule as the web submit button
 *   dialogCalls(draft, agencyId)   -> ordered [method, params] RPC calls (web submit*)
 *
 * Pure — unit tested in src/__tests__/agency-ops-forms.test.js.
 */
import {
  AUTONOMY_LEVELS,
  COMMUNICATION_TONES,
  COMMUNICATION_VERBOSITY,
  EMOJI_USAGE,
  EMPLOYEE_CHANNEL_IDS,
  OUTSIDE_HOURS_BEHAVIOURS,
  PRIORITY_OPTIONS,
  PROACTIVITY_LEVELS,
  PROJECT_STATUSES,
  REPORT_CADENCES,
  TASK_EDIT_STATUSES,
  channelLabel,
  parseMemoryValue,
  stringifyMemoryValue,
  titleCase,
} from './agency-ops-model';

const asArray = (v) => (Array.isArray(v) ? v : []);
const optionsFrom = (values) => values.map((v) => [v, titleCase(v)]);

export function isoDate(value = Date.now()) {
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Noon local on a YYYY-MM-DD day (web: new Date(`${day}T12:00:00`)). */
export function dayNoon(day) {
  if (!day) return null;
  const t = new Date(`${day}T12:00:00`).getTime();
  return Number.isFinite(t) ? t : null;
}

export function localTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

const lines = (values) => asArray(values).join('\n');
export const textLines = (value) => String(value ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
export const csv = (value) => String(value ?? '').split(',').map((p) => p.trim()).filter(Boolean);

export function numberOrUndefined(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseSkillLines(value) {
  return textLines(value).map((line) => {
    const sep = line.lastIndexOf(':');
    const skill = sep > 0 ? line.slice(0, sep).trim() : line;
    const level = sep > 0 ? Number(line.slice(sep + 1).trim()) : 3;
    return { skill, level: Number.isFinite(level) ? Math.min(5, Math.max(1, Math.round(level))) : 3, yearsExperience: 0 };
  });
}

export function parseWeekdays(value) {
  const parsed = String(value ?? '').split(',').filter((p) => p.trim()).map((p) => Number(p.trim())).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return parsed.length ? parsed : [1, 2, 3, 4, 5];
}

export function nextRunTimestamp(runAt, cadence, now = new Date()) {
  const [h, m] = String(runAt || '09:00').split(':').map((p) => Number(p) || 0);
  const next = new Date(now.getTime());
  next.setSeconds(0, 0);
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= now.getTime()) {
    if (cadence === 'monthly') next.setMonth(next.getMonth() + 1);
    else if (cadence === 'weekly') next.setDate(next.getDate() + 7);
    else next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

export const DIALOG_TITLES = {
  deal: 'Create pipeline opportunity',
  engagement: 'Start engagement',
  employee: 'Add employee',
  agency: 'Create agency',
  client: 'Add client',
  project: 'Create project',
  task: 'Create task',
  assignment: 'Create assignment',
  share: 'Share agency',
  'employee-schedule': 'Add working schedule',
  'employee-responsibility': 'Add recurring responsibility',
  'employee-review': 'Schedule manager review',
  'employee-work-item': 'Hand work to an employee',
  'employee-edit': 'Edit employee',
  'client-edit': 'Edit client',
  'project-edit': 'Edit project',
  'task-edit': 'Edit task',
  'employee-memory': 'Employee memory entry',
  'employee-profile': 'Customise employee',
  'employee-channel': 'Channel binding',
  'employee-sop-attach': 'Attach an SOP schedule',
};

export const PROFILE_TABS = [
  ['identity', 'Identity & role'],
  ['operating', 'Operating & autonomy'],
  ['communication', 'Communication'],
  ['channels', 'Model & limits'],
];

export function isEditDialog(draft) {
  return draft.kind.endsWith('-edit') || draft.kind === 'employee-profile'
    || (draft.kind === 'employee-channel' && !!draft.bindingId)
    || (draft.kind === 'employee-memory' && !!draft.memoryId);
}

function employeeProfileDraft(state, employeeId, tab, detail) {
  const roster = asArray(state.employees).find((e) => e.id === employeeId);
  const d = detail?.employee?.id === employeeId ? detail.employee : null;
  const comm = d?.communicationProfile ?? null;
  const exec = d?.executionProfile ?? null;
  return {
    kind: 'employee-profile', employeeId, tab: tab || 'identity', detailLoaded: !!d,
    name: d?.displayName ?? roster?.name ?? '',
    role: d?.title ?? roster?.role ?? '',
    department: roster?.department ?? '',
    managerWorkerId: d?.managerWorkerId ?? roster?.managerWorkerId ?? '',
    capacityHours: String(d?.weeklyCapacityHours ?? roster?.capacityHours ?? 40),
    availabilityPercent: String(d?.availabilityPercent ?? 100),
    availability: roster?.availability ?? 'available',
    employmentStatus: d?.employmentStatus ?? roster?.employmentStatus ?? 'active',
    timezone: d?.timezone ?? roster?.timezone ?? 'UTC',
    persona: d?.persona ?? roster?.persona ?? '',
    goals: lines(d?.goals ?? roster?.goals),
    kpis: lines(d?.kpis ?? roster?.kpis),
    skills: asArray(d?.skills).map((s) => `${s.skill}:${s.level}`).join('\n'),
    capabilities: lines(d?.capabilities),
    autonomyLevel: String(d?.autonomyLevel ?? roster?.autonomyLevel ?? 1),
    approvalThreshold: String(d?.approvalThreshold ?? roster?.approvalThreshold ?? 0),
    modelBinding: d?.modelBinding ?? roster?.modelBinding ?? '',
    fallbackModelBinding: exec?.fallbackModelBinding ?? '',
    maxConcurrent: typeof exec?.maxConcurrent === 'number' ? String(exec.maxConcurrent) : '',
    timeoutMinutes: typeof exec?.timeoutMinutes === 'number' ? String(exec.timeoutMinutes) : '',
    maxRetries: String(exec?.maxRetries ?? 0),
    toolAllowlist: asArray(exec?.toolAllowlist).join(', '),
    toolDenylist: asArray(exec?.toolDenylist).join(', '),
    execNotes: exec?.notes ?? '',
    commTone: comm?.tone ?? 'professional',
    commVerbosity: comm?.verbosity ?? 'concise',
    commLanguage: comm?.language ?? 'en',
    commEmoji: comm?.emojiUse ?? 'sparing',
    commProactivity: comm?.proactivity ?? 'responsive',
    commMinSeconds: String(comm?.responseLatency?.minSeconds ?? 45),
    commTargetSeconds: String(comm?.responseLatency?.targetSeconds ?? 300),
    commBatchSeconds: String(comm?.responseLatency?.batchWindowSeconds ?? 120),
    commOutsideHours: comm?.workingHours?.outsideHours ?? 'defer',
    commOutsideHoursMessage: comm?.workingHours?.outsideHoursMessage ?? '',
    commRespectSchedule: String(comm?.workingHours?.respectSchedule ?? true),
    commReportCadence: comm?.reportCadence ?? 'daily',
    commReportTime: comm?.reportTime ?? '09:00',
    commGreeting: comm?.greeting ?? '',
    commSignOff: comm?.signOff ?? '',
    commEscalateAfterMinutes: String(comm?.escalation?.escalateAfterMinutes ?? 120),
    commEscalationPhrase: comm?.escalation?.escalationPhrase ?? '',
    commHandoffPhrase: comm?.escalation?.handoffPhrase ?? '',
    commNotifyManager: String(comm?.escalation?.notifyManager ?? false),
    commNotes: comm?.notes ?? d?.communicationCadence ?? '',
  };
}

/**
 * Initial draft for a dialog. `opts`: { entityId, memoryEntryId, bindingId, sopId,
 * tab, detail (employee.detail payload), memory (entries), channels (bindings),
 * selectedEmployeeId, detailProjectId }.
 */
export function buildDraft(kind, state, opts = {}) {
  const employees = asArray(state.employees);
  const firstWorkerId = employees[0]?.id ?? '';
  const eid = opts.entityId;
  switch (kind) {
    case 'employee-profile':
      return employeeProfileDraft(state, eid ?? opts.selectedEmployeeId ?? firstWorkerId, opts.tab, opts.detail);
    case 'employee-channel': {
      const existing = asArray(opts.channels).find((c) => c.id === opts.bindingId);
      return {
        kind, bindingId: existing?.id ?? '', workerId: existing?.workerId ?? eid ?? firstWorkerId,
        channelId: existing?.channelId ?? EMPLOYEE_CHANNEL_IDS[0], target: existing?.target ?? '',
        handle: existing?.handle ?? '', direction: existing?.direction ?? 'both',
        enabled: existing ? String(existing.enabled) : 'true',
      };
    }
    case 'employee-sop-attach': {
      const workerId = eid ?? firstWorkerId;
      const worker = employees.find((e) => e.id === workerId);
      const sops = asArray(state.sops);
      return {
        kind, sopId: opts.sopId ?? sops.find((s) => s.ownerWorkerId === workerId)?.id ?? sops[0]?.id ?? '',
        workerId, managerWorkerId: worker?.managerWorkerId ?? '', cadence: 'weekly', interval: '1',
        weekday: '1', monthDay: '1', runAt: '09:00', timezone: opts.detail?.employee?.timezone ?? 'UTC',
        slaMinutes: '1440', priority: 'normal',
      };
    }
    case 'employee-memory': {
      const existing = asArray(opts.memory).find((m) => m.id === opts.memoryEntryId);
      return {
        kind, memoryId: existing?.id ?? '', workerId: existing?.workerId ?? eid ?? firstWorkerId,
        namespace: existing?.namespace ?? 'general', key: existing?.key ?? '',
        value: existing ? stringifyMemoryValue(existing.value) : '',
        expiresDate: existing?.expiresAt ? isoDate(existing.expiresAt) : '',
      };
    }
    case 'employee-schedule':
      return { kind, workerId: eid ?? firstWorkerId, timezone: localTimezone(), weekdays: '1,2,3,4,5', shiftStart: '09:00', shiftEnd: '17:00', effectiveFrom: isoDate() };
    case 'employee-responsibility':
      return { kind, workerId: eid ?? firstWorkerId, managerWorkerId: '', title: '', instructions: '', cadence: 'daily', interval: '1', weekday: '1', monthDay: '1', runAt: '09:00', slaMinutes: '1440', priority: 'normal' };
    case 'employee-review':
      return {
        kind, workerId: eid ?? firstWorkerId,
        managerWorkerId: employees.find((e) => e.id !== firstWorkerId)?.id ?? firstWorkerId,
        cadenceDays: '7', nextReviewDate: isoDate(Date.now() + 7 * 86_400_000), agenda: '',
      };
    case 'employee-work-item':
      return { kind, workerId: eid ?? firstWorkerId, managerWorkerId: '', title: '', instructions: '', priority: 'normal', dueDate: '' };
    case 'employee-edit': {
      const e = employees.find((x) => x.id === eid);
      return { kind, employeeId: eid ?? '', name: e?.name ?? '', role: e?.role ?? '', department: e?.department ?? '', capacityHours: String(e?.capacityHours ?? 40), availability: e?.availability ?? 'available' };
    }
    case 'client-edit': {
      const c = asArray(state.clients).find((x) => x.id === eid);
      return {
        kind, clientId: eid ?? '', name: c?.name ?? '', billingEmail: c?.billingEmail ?? '', notes: c?.notes ?? '',
        status: c?.status ?? 'prospect', email: c?.email ?? '', phone: c?.phone ?? '', whatsapp: c?.whatsapp ?? '',
        telegram: c?.telegram ?? '', discord: c?.discord ?? '', instagram: c?.instagram ?? '',
      };
    }
    case 'project-edit': {
      const p = asArray(state.projects).find((x) => x.id === eid);
      return { kind, projectId: eid ?? '', name: p?.name ?? '', status: p?.status ?? 'planned', budget: p ? String((p.budgetCents ?? 0) / 100) : '0', dueDate: p?.targetEndAt ? isoDate(p.targetEndAt) : '' };
    }
    case 'task-edit': {
      const t = asArray(state.tasks).find((x) => x.id === eid);
      return { kind, taskId: eid ?? '', title: t?.title ?? '', status: t?.status ?? 'backlog', priority: t?.priority ?? 'normal', dueDate: t?.dueAt ? isoDate(t.dueAt) : '' };
    }
    case 'deal':
      return { kind, name: '', clientName: '', value: '', stageId: asArray(state.pipelineStages)[0]?.id ?? '' };
    case 'engagement':
      return { kind, name: '', clientName: '', budget: '', dueDate: '' };
    case 'employee':
      return { kind, name: '', workerKind: 'human', role: '', department: '', capacityHours: '40' };
    case 'agency':
      return { kind, name: '' };
    case 'client':
      return { kind, name: '', billingEmail: '' };
    case 'project':
      return { kind, name: '', clientId: eid ?? '', budget: '' };
    case 'task': {
      const ai = employees.find((e) => e.kind === 'ai');
      return {
        kind, title: '', projectId: eid ?? opts.detailProjectId ?? asArray(state.projects)[0]?.id ?? '',
        description: '', assigneeType: 'ai', assigneeId: ai?.id ?? '',
      };
    }
    case 'assignment':
      return { kind, title: '', description: '', estimatedHours: '8', priority: '3', memberId: '' };
    case 'share':
    default:
      return { kind: 'share', email: '', role: 'member' };
  }
}

const workerOptions = (state) => asArray(state.employees).map((e) => [e.id, `${e.name} · ${e.kind === 'ai' ? 'AI' : 'Human'} · ${e.role ?? ''}`]);
const managerOptions = (state) => [['', 'No manager'], ...workerOptions(state)];
const CADENCES = [['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly']];
const WEEKDAYS = [['0', 'Sunday'], ['1', 'Monday'], ['2', 'Tuesday'], ['3', 'Wednesday'], ['4', 'Thursday'], ['5', 'Friday'], ['6', 'Saturday']];
const BOOL = [['true', 'Yes'], ['false', 'No']];

/** Field specs for the native FormSheet. Each field: { key, label, type, options?, placeholder?, help?, tab? }. */
export function dialogFields(draft, state) {
  const f = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
  switch (draft.kind) {
    case 'share':
      return [
        f('email', 'Email', 'email', { placeholder: 'teammate@company.com' }),
        f('role', 'Access role', 'select', { options: [['admin', 'Admin'], ['member', 'Member'], ['viewer', 'Viewer']] }),
      ];
    case 'deal':
      return [
        f('name', 'Name', 'text', { placeholder: 'Project or opportunity' }),
        f('clientName', 'Client', 'text', { placeholder: 'Client or company' }),
        f('value', 'Value', 'number'),
        f('stageId', 'Pipeline stage', 'select', { options: asArray(state.pipelineStages).map((s) => [s.id, s.label]) }),
      ];
    case 'engagement':
      return [
        f('name', 'Name', 'text', { placeholder: 'Project or opportunity' }),
        f('clientName', 'Client', 'text', { placeholder: 'Client or company' }),
        f('budget', 'Budget', 'number'),
        f('dueDate', 'Target delivery', 'date'),
      ];
    case 'employee':
      return [
        f('name', 'Name', 'text', { placeholder: 'Employee name' }),
        f('workerKind', 'Worker type', 'select', { options: [['human', 'Human employee'], ['ai', 'AI employee']] }),
        f('role', 'Role', 'text', { placeholder: 'e.g. Account Manager' }),
        f('department', 'Department', 'text', { placeholder: 'e.g. Delivery' }),
        f('capacityHours', 'Weekly capacity', 'number'),
      ];
    case 'agency':
      return [f('name', 'Name', 'text', { placeholder: 'Agency name' })];
    case 'client':
      return [
        f('name', 'Name', 'text', { placeholder: 'Client or company name' }),
        f('billingEmail', 'Billing email', 'email', { placeholder: 'billing@company.com' }),
      ];
    case 'project':
      return [
        f('name', 'Name', 'text', { placeholder: 'Project name' }),
        f('clientId', 'Client', 'select', { searchable: true, options: [['', 'No client yet'], ...asArray(state.clients).map((c) => [c.id, c.name])] }),
        f('budget', 'Budget', 'number'),
      ];
    case 'task':
      return [
        f('title', 'Task title', 'text', { placeholder: 'Clear outcome or deliverable' }),
        f('projectId', 'Project', 'select', { searchable: true, options: asArray(state.projects).map((p) => [p.id, p.name]) }),
        f('description', 'Instructions', 'textarea'),
        f('assigneeId', 'Assignee', 'select', { options: [['', 'Unassigned'], ...workerOptions(state)] }),
      ];
    case 'assignment':
      return [
        f('title', 'Assignment title', 'text', { placeholder: 'Clear outcome or deliverable' }),
        f('description', 'Instructions', 'textarea'),
        f('memberId', 'Assign to', 'select', { options: [['', 'Unassigned'], ...workerOptions(state)] }),
        f('estimatedHours', 'Estimated hours', 'number'),
        f('priority', 'Priority (1 highest)', 'number'),
      ];
    case 'employee-channel':
      return [
        f('workerId', 'Employee', 'select', { options: workerOptions(state) }),
        f('channelId', 'Platform', 'select', { options: EMPLOYEE_CHANNEL_IDS.map((id) => [id, channelLabel(id)]) }),
        f('target', 'Target', 'text', { placeholder: 'Channel / chat / JID id. Empty uses the channel default.' }),
        f('handle', 'Handle', 'text', { placeholder: 'How this employee appears there' }),
        f('direction', 'Direction', 'select', { options: [['both', 'Inbound and outbound'], ['inbound', 'Inbound only'], ['outbound', 'Outbound only']] }),
        f('enabled', 'Enabled', 'select', { options: BOOL }),
        { type: 'note', key: 'n', text: 'Routing only. Never put tokens or secrets here — channel credentials belong in the gateway channel configuration, not in the replicated agency database.' },
      ];
    case 'employee-sop-attach': {
      const sops = asArray(state.sops);
      const out = [];
      if (sops.length) out.push(f('sopId', 'Procedure', 'select', { options: sops.map((s) => [s.id, s.name]) }));
      else out.push({ type: 'note', key: 'n', text: 'This agency has no SOP catalogue yet. Provision the starter SOPs first.' });
      out.push(f('workerId', 'Employee', 'select', { options: workerOptions(state) }));
      out.push(f('managerWorkerId', 'Manager', 'select', { options: managerOptions(state) }));
      out.push(f('cadence', 'Cadence', 'select', { options: CADENCES }));
      out.push(f('interval', 'Every', 'number'));
      if (draft.cadence === 'weekly') out.push(f('weekday', 'Weekday', 'select', { options: WEEKDAYS }));
      if (draft.cadence === 'monthly') out.push(f('monthDay', 'Day of month', 'number'));
      out.push(f('runAt', 'Run at', 'time'), f('timezone', 'Timezone'), f('slaMinutes', 'SLA (min)', 'number'), f('priority', 'Priority', 'select', { options: PRIORITY_OPTIONS }));
      return out;
    }
    case 'employee-schedule':
      return [
        f('workerId', 'Employee', 'select', { options: workerOptions(state) }),
        f('weekdays', 'Working days', 'weekdays'),
        f('shiftStart', 'Shift start', 'time'),
        f('shiftEnd', 'Shift end', 'time'),
        f('effectiveFrom', 'Effective from', 'date'),
        f('timezone', 'Timezone', 'text', { placeholder: 'e.g. America/New_York' }),
      ];
    case 'employee-responsibility': {
      const out = [
        f('workerId', 'Employee', 'select', { options: workerOptions(state) }),
        f('title', 'Responsibility', 'text', { placeholder: 'e.g. Weekly client status report' }),
        f('instructions', 'Instructions', 'textarea'),
        f('cadence', 'Cadence', 'select', { options: CADENCES }),
      ];
      if (draft.cadence === 'weekly') out.push(f('weekday', 'Weekday', 'select', { options: WEEKDAYS }));
      if (draft.cadence === 'monthly') out.push(f('monthDay', 'Day of month', 'number'));
      out.push(
        f('runAt', 'Run at', 'time'),
        f('interval', 'Repeat every (intervals)', 'number'),
        f('slaMinutes', 'SLA minutes', 'number'),
        f('priority', 'Priority', 'select', { options: PRIORITY_OPTIONS }),
        f('managerWorkerId', 'Manager', 'select', { options: managerOptions(state) }),
      );
      return out;
    }
    case 'employee-review':
      return [
        f('workerId', 'Employee', 'select', { options: workerOptions(state) }),
        f('managerWorkerId', 'Manager', 'select', { options: workerOptions(state) }),
        f('cadenceDays', 'Cadence (days)', 'number'),
        f('nextReviewDate', 'Next review', 'date'),
        f('agenda', 'Agenda (one item per line)', 'textarea'),
      ];
    case 'employee-work-item':
      return [
        f('workerId', 'Employee', 'select', { options: workerOptions(state) }),
        f('title', 'Work item', 'text', { placeholder: 'Clear outcome' }),
        f('instructions', 'Instructions', 'textarea'),
        f('priority', 'Priority', 'select', { options: PRIORITY_OPTIONS }),
        f('dueDate', 'Due', 'date'),
        f('managerWorkerId', 'Manager', 'select', { options: managerOptions(state) }),
      ];
    case 'employee-edit':
      return [
        f('name', 'Name'), f('role', 'Role'), f('department', 'Department'),
        f('capacityHours', 'Weekly capacity', 'number'),
        f('availability', 'Availability', 'select', { options: [['available', 'Available'], ['focused', 'Focused'], ['blocked', 'Blocked'], ['offline', 'Offline']] }),
      ];
    case 'employee-memory':
      return [
        f('workerId', 'Employee', 'select', { options: workerOptions(state) }),
        f('namespace', 'Namespace', 'text', { placeholder: 'e.g. clients, preferences, playbooks' }),
        f('key', 'Key', 'text', { placeholder: 'What this entry is about' }),
        f('value', 'Value', 'textarea', { placeholder: 'Plain text, or JSON for structured recall' }),
        f('expiresDate', 'Expires on', 'date'),
      ];
    case 'client-edit':
      return [
        f('name', 'Name'),
        f('status', 'Status', 'select', { options: [['prospect', 'Prospect'], ['active', 'Active'], ['inactive', 'Inactive']] }),
        f('billingEmail', 'Billing email', 'email'),
        f('email', 'Email', 'email'),
        f('phone', 'Phone', 'phone'),
        f('whatsapp', 'WhatsApp', 'text', { placeholder: '+1 555 000 0000', icon: 'logo-whatsapp' }),
        f('telegram', 'Telegram', 'text', { placeholder: '@username', icon: 'paper-plane-outline' }),
        f('discord', 'Discord', 'text', { placeholder: 'user#1234', icon: 'logo-discord' }),
        f('instagram', 'Instagram', 'text', { placeholder: '@handle', icon: 'logo-instagram' }),
        f('notes', 'Notes', 'textarea'),
      ];
    case 'task-edit':
      return [
        f('title', 'Title'),
        f('status', 'Status', 'select', { options: TASK_EDIT_STATUSES }),
        f('priority', 'Priority', 'select', { options: PRIORITY_OPTIONS }),
        f('dueDate', 'Due date', 'date'),
        { type: 'note', key: 'n', text: 'Title, priority and due date persist via agency.ops.tasks.update; the state move always saves.' },
      ];
    case 'project-edit':
      return [
        f('name', 'Name'),
        f('status', 'Status', 'select', { options: PROJECT_STATUSES }),
        f('budget', 'Budget', 'number', { placeholder: '0' }),
        f('dueDate', 'Target end date', 'date'),
        { type: 'note', key: 'n', text: 'Name, budget and deadline persist via agency.ops.projects.update; the status move always saves.' },
      ];
    case 'employee-profile':
      return [
        // identity
        f('name', 'Name', 'text', { tab: 'identity' }),
        f('role', 'Role / title', 'text', { tab: 'identity' }),
        f('department', 'Department', 'text', { tab: 'identity', placeholder: 'e.g. Growth. Created if it does not exist.' }),
        f('managerWorkerId', 'Reports to', 'select', { tab: 'identity', options: managerOptions(state).filter(([id]) => id !== draft.employeeId) }),
        f('capacityHours', 'Weekly capacity (h)', 'number', { tab: 'identity' }),
        f('availabilityPercent', 'Availability (%)', 'number', { tab: 'identity' }),
        f('availability', 'Current status', 'select', { tab: 'identity', options: [['available', 'Available'], ['focused', 'Focused'], ['blocked', 'Blocked'], ['offline', 'Offline']] }),
        f('employmentStatus', 'Employment', 'select', { tab: 'identity', options: [['active', 'Active'], ['onboarding', 'Onboarding'], ['suspended', 'Suspended'], ['inactive', 'Inactive']] }),
        f('timezone', 'Timezone', 'text', { tab: 'identity', placeholder: 'e.g. Europe/London' }),
        f('persona', 'Persona', 'textarea', { tab: 'identity', placeholder: 'Who this employee is: voice, remit, standing constraints.' }),
        // operating
        f('autonomyLevel', 'Autonomy level', 'autonomy', { tab: 'operating', options: AUTONOMY_LEVELS }),
        f('approvalThreshold', 'Approval threshold', 'number', { tab: 'operating', placeholder: 'Cost above which work always escalates' }),
        f('goals', 'Goals', 'textarea', { tab: 'operating', placeholder: 'One goal per line' }),
        f('kpis', 'KPIs', 'textarea', { tab: 'operating', placeholder: 'One KPI per line' }),
        f('skills', 'Skills', 'textarea', { tab: 'operating', placeholder: 'One per line as skill:level, where level is 1-5. e.g. copywriting:4' }),
        f('capabilities', 'Capabilities', 'textarea', { tab: 'operating', placeholder: 'One capability per line, e.g. can_publish_content' }),
        // communication
        f('commTone', 'Tone', 'select', { tab: 'communication', options: optionsFrom(COMMUNICATION_TONES) }),
        f('commVerbosity', 'Verbosity', 'select', { tab: 'communication', options: optionsFrom(COMMUNICATION_VERBOSITY) }),
        f('commProactivity', 'Proactivity', 'select', { tab: 'communication', options: optionsFrom(PROACTIVITY_LEVELS) }),
        f('commEmoji', 'Emoji use', 'select', { tab: 'communication', options: optionsFrom(EMOJI_USAGE) }),
        f('commLanguage', 'Language', 'text', { tab: 'communication', placeholder: 'BCP-47, e.g. en' }),
        f('commReportCadence', 'Report cadence', 'select', { tab: 'communication', options: optionsFrom(REPORT_CADENCES) }),
        f('commReportTime', 'Report time', 'time', { tab: 'communication' }),
        f('commMinSeconds', 'Minimum reply delay (s)', 'number', { tab: 'communication' }),
        f('commTargetSeconds', 'Target reply time (s)', 'number', { tab: 'communication' }),
        f('commBatchSeconds', 'Batch window (s)', 'number', { tab: 'communication' }),
        f('commRespectSchedule', 'Respect working schedule', 'select', { tab: 'communication', options: BOOL }),
        f('commOutsideHours', 'Outside working hours', 'select', { tab: 'communication', options: optionsFrom(OUTSIDE_HOURS_BEHAVIOURS) }),
        f('commEscalateAfterMinutes', 'Escalate after (min)', 'number', { tab: 'communication' }),
        f('commNotifyManager', 'Always notify manager', 'select', { tab: 'communication', options: BOOL }),
        f('commOutsideHoursMessage', 'Out-of-hours auto-reply', 'text', { tab: 'communication', placeholder: 'Sent when a message arrives outside working hours' }),
        f('commGreeting', 'Greeting', 'text', { tab: 'communication' }),
        f('commSignOff', 'Sign-off', 'text', { tab: 'communication' }),
        f('commEscalationPhrase', 'Escalation phrasing', 'text', { tab: 'communication', placeholder: 'How it tells the manager something is stuck' }),
        f('commHandoffPhrase', 'Hand-off phrasing', 'text', { tab: 'communication', placeholder: 'How it hands a conversation to a human' }),
        f('commNotes', 'Communication notes', 'textarea', { tab: 'communication', placeholder: 'Anything else it should know about how to talk' }),
        // model & limits
        f('modelBinding', 'Model / backend binding', 'text', { tab: 'channels', placeholder: 'e.g. claude, codex, openrouter:model. Empty uses the gateway default.' }),
        f('fallbackModelBinding', 'Fallback backend', 'text', { tab: 'channels', placeholder: 'Used when the primary backend fails' }),
        f('maxConcurrent', 'Max concurrent runs', 'number', { tab: 'channels' }),
        f('timeoutMinutes', 'Run timeout (min)', 'number', { tab: 'channels' }),
        f('maxRetries', 'Extra retries', 'number', { tab: 'channels' }),
        f('toolAllowlist', 'Tool allowlist', 'text', { tab: 'channels', placeholder: 'Comma separated. Empty allows every tool.' }),
        f('toolDenylist', 'Tool denylist', 'text', { tab: 'channels', placeholder: 'Comma separated. Wins over the allowlist.' }),
        f('execNotes', 'Operator notes', 'textarea', { tab: 'channels', placeholder: 'Why these limits are set the way they are' }),
        { type: 'note', key: 'n', tab: 'channels', text: 'Leave a numeric field empty to inherit the gateway default. Channel bindings are edited from the employee profile, one platform at a time.' },
      ];
    default:
      return [];
  }
}

export function dialogValid(d) {
  const t = (v) => String(v ?? '').trim().length > 0;
  switch (d.kind) {
    case 'share': return String(d.email ?? '').trim().length > 3;
    case 'task': return t(d.title) && t(d.projectId);
    case 'assignment': return t(d.title);
    case 'agency': case 'client': case 'project': return t(d.name);
    case 'employee': return t(d.name) && t(d.role);
    case 'deal': case 'engagement': return t(d.name) && t(d.clientName);
    case 'employee-profile': return t(d.employeeId) && t(d.name);
    case 'employee-channel': return t(d.workerId) && t(d.channelId);
    case 'employee-sop-attach': return t(d.sopId) && t(d.workerId);
    case 'employee-schedule': return t(d.workerId);
    case 'employee-responsibility': return t(d.workerId) && t(d.title);
    case 'employee-review': return t(d.workerId) && t(d.managerWorkerId);
    case 'employee-work-item': return t(d.workerId) && t(d.title);
    case 'employee-edit': return t(d.employeeId) && t(d.name);
    case 'employee-memory': return t(d.workerId) && t(d.key);
    case 'client-edit': return t(d.clientId) && t(d.name);
    case 'task-edit': return t(d.taskId) && t(d.title);
    case 'project-edit': return t(d.projectId) && t(d.name);
    default: return false;
  }
}

/** The ordered RPC calls a submit performs. `ctx.employees` resolves assignment members. */
export function dialogCalls(d, agencyId, ctx = {}) {
  const tr = (v) => String(v ?? '').trim();
  const orNull = (v) => tr(v) || null;
  const orUndef = (v) => tr(v) || undefined;
  switch (d.kind) {
    case 'deal':
      return [['agency.ops.pipeline.deal.create', { agencyId, name: tr(d.name), clientName: tr(d.clientName), value: Number(d.value) || 0, stageId: d.stageId }]];
    case 'engagement':
      return [['agency.ops.engagement.create', { agencyId, name: tr(d.name), clientName: tr(d.clientName), budget: Number(d.budget) || 0, dueAt: d.dueDate ? dayNoon(d.dueDate) : undefined }]];
    case 'employee':
      return [['agency.ops.employee.create', { agencyId, name: tr(d.name), kind: d.workerKind, role: tr(d.role), department: tr(d.department), capacityHours: Number(d.capacityHours) || 40 }]];
    case 'agency':
      return [['agency.ops.agency.create', { name: tr(d.name) }]];
    case 'client':
      return [['agency.ops.clients.create', { agencyId, name: tr(d.name), billingEmail: orUndef(d.billingEmail) }]];
    case 'project':
      return [['agency.ops.projects.create', { agencyId, name: tr(d.name), clientId: d.clientId || undefined, budget: Number(d.budget) || 0 }]];
    case 'task': {
      const assignee = asArray(ctx.employees).find((e) => e.id === d.assigneeId);
      return [['agency.ops.tasks.create', { agencyId, projectId: d.projectId, title: tr(d.title), description: tr(d.description), assigneeType: assignee?.kind ?? d.assigneeType, assigneeId: d.assigneeId || undefined }]];
    }
    case 'assignment': {
      const hours = Number(d.estimatedHours) || 0;
      const member = asArray(ctx.employees).find((e) => e.id === d.memberId);
      return [['agency.ops.assignment.create', {
        agencyId, title: tr(d.title), description: orUndef(d.description), estimatedHours: hours, priority: Number(d.priority) || 3,
        members: member ? [{ workerId: member.id, role: 'owner', allocatedHours: hours || 1 }] : [],
      }]];
    }
    case 'share':
      return [['agency.ops.agency.share', { agencyId, email: tr(d.email), role: d.role }]];
    case 'employee-profile':
      return [
        ['agency.ops.employee.update', {
          agencyId, employeeId: d.employeeId, name: tr(d.name), role: tr(d.role), department: orUndef(d.department),
          managerWorkerId: d.managerWorkerId || null, capacityHours: numberOrUndefined(d.capacityHours) ?? 40,
          availabilityPercent: numberOrUndefined(d.availabilityPercent), status: d.availability,
          employmentStatus: d.employmentStatus || undefined, persona: orUndef(d.persona), modelBinding: orNull(d.modelBinding),
          autonomyLevel: numberOrUndefined(d.autonomyLevel) ?? 1, timezone: orUndef(d.timezone),
          goals: textLines(d.goals), kpis: textLines(d.kpis), skills: parseSkillLines(d.skills),
        }],
        ['agency.ops.employee.execution.update', {
          agencyId, employeeId: d.employeeId, modelBinding: orNull(d.modelBinding),
          autonomyLevel: numberOrUndefined(d.autonomyLevel) ?? 1, approvalThreshold: numberOrUndefined(d.approvalThreshold) ?? 0,
          capabilities: textLines(d.capabilities),
          profile: {
            fallbackModelBinding: orNull(d.fallbackModelBinding), toolAllowlist: csv(d.toolAllowlist), toolDenylist: csv(d.toolDenylist),
            timeoutMinutes: numberOrUndefined(d.timeoutMinutes) ?? null, maxConcurrent: numberOrUndefined(d.maxConcurrent) ?? null,
            maxRetries: numberOrUndefined(d.maxRetries) ?? 0, notes: tr(d.execNotes),
          },
        }],
        ['agency.ops.employee.communication.update', {
          agencyId, employeeId: d.employeeId,
          profile: {
            tone: d.commTone, verbosity: d.commVerbosity, language: tr(d.commLanguage) || 'en', emojiUse: d.commEmoji, proactivity: d.commProactivity,
            responseLatency: {
              minSeconds: numberOrUndefined(d.commMinSeconds) ?? 45, targetSeconds: numberOrUndefined(d.commTargetSeconds) ?? 300,
              batchWindowSeconds: numberOrUndefined(d.commBatchSeconds) ?? 120,
            },
            workingHours: { respectSchedule: d.commRespectSchedule === 'true', outsideHours: d.commOutsideHours, outsideHoursMessage: orNull(d.commOutsideHoursMessage) },
            escalation: {
              escalateAfterMinutes: numberOrUndefined(d.commEscalateAfterMinutes) ?? 120, escalationPhrase: tr(d.commEscalationPhrase),
              handoffPhrase: tr(d.commHandoffPhrase), notifyManager: d.commNotifyManager === 'true',
            },
            reportCadence: d.commReportCadence, reportTime: d.commReportTime || '09:00', greeting: orNull(d.commGreeting),
            signOff: orNull(d.commSignOff), notes: tr(d.commNotes),
          },
        }],
      ];
    case 'employee-channel':
      return [['agency.ops.employee.channel.bind', { agencyId, employeeId: d.workerId, channelId: d.channelId, target: orNull(d.target), handle: orNull(d.handle), direction: d.direction, enabled: d.enabled === 'true' }]];
    case 'employee-sop-attach':
      return [['agency.ops.sop.schedule.attach', {
        agencyId, sopId: d.sopId, workerId: d.workerId, managerWorkerId: d.managerWorkerId || null, cadence: d.cadence,
        interval: numberOrUndefined(d.interval) ?? 1,
        weekday: d.cadence === 'weekly' ? (numberOrUndefined(d.weekday) ?? 1) : null,
        monthDay: d.cadence === 'monthly' ? (numberOrUndefined(d.monthDay) ?? 1) : null,
        runAt: d.runAt || '09:00', timezone: tr(d.timezone) || 'UTC', slaMinutes: numberOrUndefined(d.slaMinutes) ?? 1440,
        priority: d.priority, enabled: true,
      }]];
    case 'employee-schedule':
      return [['agency.ops.employee.schedule.create', {
        agencyId, workerId: d.workerId, timezone: tr(d.timezone) || 'UTC', weekdays: parseWeekdays(d.weekdays),
        shiftStart: d.shiftStart || '09:00', shiftEnd: d.shiftEnd || '17:00', effectiveFrom: d.effectiveFrom || isoDate(), enabled: true,
      }]];
    case 'employee-responsibility':
      return [['agency.ops.employee.responsibility.create', {
        agencyId, workerId: d.workerId, managerWorkerId: d.managerWorkerId || undefined, title: tr(d.title), instructions: orUndef(d.instructions),
        cadence: d.cadence, interval: Number(d.interval) || 1,
        weekday: d.cadence === 'weekly' ? (Number(d.weekday) || 0) : undefined,
        monthDay: d.cadence === 'monthly' ? (Number(d.monthDay) || 1) : undefined,
        runAt: d.runAt || '09:00', slaMinutes: Number(d.slaMinutes) || 1440, priority: d.priority, enabled: true,
        nextRunAt: nextRunTimestamp(d.runAt || '09:00', d.cadence, ctx.now ?? new Date()),
      }]];
    case 'employee-review':
      return [['agency.ops.employee.review-cycle.create', {
        agencyId, workerId: d.workerId, managerWorkerId: d.managerWorkerId, cadenceDays: Number(d.cadenceDays) || 7,
        nextReviewAt: d.nextReviewDate ? dayNoon(d.nextReviewDate) : Date.now(), agenda: textLines(d.agenda),
      }]];
    case 'employee-work-item':
      return [['agency.ops.employee.work-item.create', {
        agencyId, workerId: d.workerId, managerWorkerId: d.managerWorkerId || undefined, title: tr(d.title), instructions: orUndef(d.instructions),
        priority: d.priority, scheduledFor: ctx.now ? ctx.now.getTime() : Date.now(), dueAt: d.dueDate ? dayNoon(d.dueDate) : null,
      }]];
    case 'employee-edit':
      return [['agency.ops.employee.update', { agencyId, employeeId: d.employeeId, name: tr(d.name), role: tr(d.role), department: orUndef(d.department), capacityHours: Number(d.capacityHours) || 40, status: d.availability }]];
    case 'employee-memory':
      return [['agency.ops.employee.memory.upsert', {
        agencyId, workerId: d.workerId, namespace: tr(d.namespace) || 'general', key: tr(d.key), value: parseMemoryValue(d.value),
        source: 'operator', expiresAt: d.expiresDate ? dayNoon(d.expiresDate) : null,
      }]];
    case 'client-edit':
      return [['agency.ops.clients.update', {
        agencyId, clientId: d.clientId, name: tr(d.name), status: d.status, billingEmail: orNull(d.billingEmail), notes: orNull(d.notes),
        email: orNull(d.email), phone: orNull(d.phone), whatsapp: orNull(d.whatsapp), telegram: orNull(d.telegram), discord: orNull(d.discord), instagram: orNull(d.instagram),
      }]];
    case 'task-edit':
      return [
        ['agency.ops.tasks.transition', { agencyId, taskId: d.taskId, status: d.status }],
        ['agency.ops.tasks.update', { agencyId, taskId: d.taskId, title: tr(d.title), priority: d.priority, dueAt: d.dueDate ? dayNoon(d.dueDate) : null }],
      ];
    case 'project-edit':
      return [
        ['agency.ops.projects.transition', { agencyId, projectId: d.projectId, status: d.status }],
        ['agency.ops.projects.update', { agencyId, projectId: d.projectId, name: tr(d.name), budget: Number(d.budget) || 0, targetEndAt: d.dueDate ? dayNoon(d.dueDate) : null }],
      ];
    default:
      return [];
  }
}

/**
 * The web runs the three employee-profile writes independently and reports
 * every rejection; every other dialog stops at the first failure.
 */
export const INDEPENDENT_CALL_KINDS = new Set(['employee-profile']);

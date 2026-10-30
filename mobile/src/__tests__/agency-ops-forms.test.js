import {
  buildDraft,
  dialogCalls,
  dialogFields,
  dialogValid,
  isEditDialog,
  nextRunTimestamp,
  parseSkillLines,
  parseWeekdays,
  DIALOG_TITLES,
  PROFILE_TABS,
} from '../screens/agency/ops/agency-ops-forms';

const A = 'ag';
const state = {
  employees: [
    { id: 'e1', name: 'Atlas', kind: 'ai', role: 'CEO', capacityHours: 168, availability: 'available', autonomyLevel: 2, approvalThreshold: 5000 },
    { id: 'e2', name: 'Hana', kind: 'human', role: 'Designer', department: 'Studio', capacityHours: 40 },
  ],
  clients: [{ id: 'c1', name: 'Grant', status: 'active', billingEmail: 'g@x.io', phone: '+1' }],
  projects: [{ id: 'p1', name: 'Site', status: 'active', budgetCents: 250000, targetEndAt: new Date(2026, 9, 20, 12).getTime() }],
  tasks: [{ id: 't1', title: 'Copy', status: 'review', priority: 'high', dueAt: null }],
  pipelineStages: [{ id: 'lead', label: 'Lead' }],
  sops: [{ id: 's1', name: 'Standup', ownerWorkerId: 'e2' }],
};

describe('every web dialog kind has a title, draft and fields', () => {
  const kinds = Object.keys(DIALOG_TITLES);
  test.each(kinds)('%s', (kind) => {
    const draft = buildDraft(kind, state, { entityId: kind.includes('client') ? 'c1' : kind.includes('project') ? 'p1' : kind.includes('task') ? 't1' : 'e1' });
    expect(draft.kind).toBe(kind);
    expect(Array.isArray(dialogFields(draft, state))).toBe(true);
  });
  test('profile tabs', () => {
    expect(PROFILE_TABS.map((t) => t[0])).toEqual(['identity', 'operating', 'communication', 'channels']);
  });
});

describe('creates', () => {
  test('deal requires name + client and posts stage', () => {
    const d = { ...buildDraft('deal', state), name: ' Retainer ', clientName: 'Grant', value: '1500' };
    expect(dialogValid(d)).toBe(true);
    expect(dialogCalls(d, A)).toEqual([['agency.ops.pipeline.deal.create', { agencyId: A, name: 'Retainer', clientName: 'Grant', value: 1500, stageId: 'lead' }]]);
    expect(dialogValid({ ...d, clientName: '' })).toBe(false);
  });
  test('employee requires a role', () => {
    const d = { ...buildDraft('employee', state), name: 'Max' };
    expect(dialogValid(d)).toBe(false);
    expect(dialogCalls({ ...d, role: 'PM', workerKind: 'ai' }, A)[0][1]).toMatchObject({ kind: 'ai', role: 'PM', capacityHours: 40 });
  });
  test('task defaults to the first AI employee and derives assigneeType', () => {
    const d = buildDraft('task', state);
    expect(d).toMatchObject({ projectId: 'p1', assigneeId: 'e1' });
    const calls = dialogCalls({ ...d, title: 'Ship', assigneeId: 'e2' }, A, { employees: state.employees });
    expect(calls[0][1]).toMatchObject({ projectId: 'p1', title: 'Ship', assigneeType: 'human', assigneeId: 'e2' });
  });
  test('assignment creates an owner member', () => {
    const d = { ...buildDraft('assignment', state), title: 'Audit', memberId: 'e2', estimatedHours: '6' };
    expect(dialogCalls(d, A, { employees: state.employees })[0][1].members).toEqual([{ workerId: 'e2', role: 'owner', allocatedHours: 6 }]);
  });
  test('agency create has no agencyId; share validates email', () => {
    expect(dialogCalls({ kind: 'agency', name: 'New' }, A)).toEqual([['agency.ops.agency.create', { name: 'New' }]]);
    expect(dialogValid({ kind: 'share', email: 'a@' })).toBe(false);
    expect(dialogValid({ kind: 'share', email: 'a@b.io' })).toBe(true);
  });
});

describe('edits', () => {
  test('task edit transitions then updates', () => {
    const d = buildDraft('task-edit', state, { entityId: 't1' });
    expect(d).toMatchObject({ title: 'Copy', status: 'review', priority: 'high', dueDate: '' });
    const calls = dialogCalls({ ...d, dueDate: '2026-10-20' }, A);
    expect(calls.map((c) => c[0])).toEqual(['agency.ops.tasks.transition', 'agency.ops.tasks.update']);
    expect(calls[1][1].dueAt).toBe(new Date('2026-10-20T12:00:00').getTime());
  });
  test('project edit seeds budget in dollars and date', () => {
    const d = buildDraft('project-edit', state, { entityId: 'p1' });
    expect(d).toMatchObject({ budget: '2500', dueDate: '2026-10-20' });
    expect(dialogCalls(d, A)[1][1]).toMatchObject({ budget: 2500, name: 'Site' });
  });
  test('client edit nulls blanks', () => {
    const d = buildDraft('client-edit', state, { entityId: 'c1' });
    const [[m, p]] = dialogCalls({ ...d, telegram: '  ' }, A);
    expect(m).toBe('agency.ops.clients.update');
    expect(p).toMatchObject({ billingEmail: 'g@x.io', phone: '+1', telegram: null, email: null });
    expect(isEditDialog(d)).toBe(true);
  });
  test('employee profile writes identity, execution and communication', () => {
    const d = buildDraft('employee-profile', state, { entityId: 'e1', detail: { employee: { id: 'e1', displayName: 'Atlas', skills: [{ skill: 'ops', level: 4 }], capabilities: ['x'], goals: ['g'] } } });
    expect(d).toMatchObject({ skills: 'ops:4', autonomyLevel: '2', approvalThreshold: '5000', detailLoaded: true });
    const calls = dialogCalls({ ...d, toolAllowlist: 'a, b', commNotifyManager: 'true' }, A);
    expect(calls.map((c) => c[0])).toEqual(['agency.ops.employee.update', 'agency.ops.employee.execution.update', 'agency.ops.employee.communication.update']);
    expect(calls[0][1].skills).toEqual([{ skill: 'ops', level: 4, yearsExperience: 0 }]);
    expect(calls[1][1].profile.toolAllowlist).toEqual(['a', 'b']);
    expect(calls[2][1].profile.escalation.notifyManager).toBe(true);
    const fields = dialogFields(d, state);
    expect(new Set(fields.map((f) => f.tab))).toEqual(new Set(['identity', 'operating', 'communication', 'channels']));
    expect(fields.find((f) => f.key === 'managerWorkerId').options.some(([id]) => id === 'e1')).toBe(false);
  });
});

describe('employee operating loop dialogs', () => {
  test('sop attach defaults to the worker-owned SOP and sends weekday only for weekly', () => {
    const d = buildDraft('employee-sop-attach', state, { entityId: 'e2' });
    expect(d.sopId).toBe('s1');
    expect(dialogCalls(d, A)[0][1]).toMatchObject({ cadence: 'weekly', weekday: 1, monthDay: null, slaMinutes: 1440, enabled: true });
    expect(dialogFields({ ...d, cadence: 'monthly' }, state).some((f) => f.key === 'monthDay')).toBe(true);
  });
  test('schedule weekdays parse with fallback', () => {
    expect(parseWeekdays('1, 3,9,x')).toEqual([1, 3]);
    expect(parseWeekdays('')).toEqual([1, 2, 3, 4, 5]);
  });
  test('responsibility computes next run', () => {
    const now = new Date(2026, 0, 1, 10, 0);
    const d = { ...buildDraft('employee-responsibility', state), title: 'Report', runAt: '09:00' };
    const [[, p]] = dialogCalls(d, A, { now });
    expect(p.nextRunAt).toBe(new Date(2026, 0, 2, 9, 0).getTime());
    expect(nextRunTimestamp('11:00', 'daily', now)).toBe(new Date(2026, 0, 1, 11, 0).getTime());
  });
  test('memory upsert parses JSON and expiry', () => {
    const d = { ...buildDraft('employee-memory', state, { entityId: 'e1' }), key: 'tone', value: '{"x":1}', expiresDate: '2026-12-01' };
    expect(dialogCalls(d, A)[0][1]).toMatchObject({ workerId: 'e1', namespace: 'general', value: { x: 1 }, source: 'operator' });
  });
  test('review + work item', () => {
    const r = buildDraft('employee-review', state);
    expect(r).toMatchObject({ workerId: 'e1', managerWorkerId: 'e2' });
    expect(dialogCalls({ ...r, agenda: 'a\n\n b ' }, A)[0][1].agenda).toEqual(['a', 'b']);
    const w = { ...buildDraft('employee-work-item', state, { entityId: 'e2' }), title: 'Fix' };
    expect(dialogValid(w)).toBe(true);
    expect(dialogCalls(w, A, { now: new Date(5) })[0]).toEqual(['agency.ops.employee.work-item.create', { agencyId: A, workerId: 'e2', managerWorkerId: undefined, title: 'Fix', instructions: undefined, priority: 'normal', scheduledFor: 5, dueAt: null }]);
  });
  test('channel binding', () => {
    const d = buildDraft('employee-channel', state, { entityId: 'e1' });
    expect(dialogCalls({ ...d, target: '' }, A)[0][1]).toMatchObject({ employeeId: 'e1', channelId: 'discord', target: null, enabled: true });
  });
  test('skill lines clamp levels', () => {
    expect(parseSkillLines('copy:9\nseo\nads:0')).toEqual([
      { skill: 'copy', level: 5, yearsExperience: 0 },
      { skill: 'seo', level: 3, yearsExperience: 0 },
      { skill: 'ads', level: 1, yearsExperience: 0 },
    ]);
  });
});

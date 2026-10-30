import {
  SECTIONS,
  activeProjectGroups,
  allocationSummary,
  auditEntityLabel,
  auditTarget,
  boardColumns,
  clientKanbanColumns,
  clientProfile,
  clientsByPipeline,
  collectionRate,
  decisionQueue,
  deliveryKpis,
  describeAutonomy,
  diagnosticRequests,
  employeeOpsSummary,
  filterClients,
  filterEmployees,
  financeKpis,
  invoiceAcceptsPayment,
  isOverdue,
  kanbanProjectRoll,
  lastRunSummary,
  money,
  moneyCents,
  nextWorkItemStatus,
  normalizeNotes,
  normalizePanels,
  overviewKpis,
  panelRequests,
  parseMemoryValue,
  pickSelectedAgency,
  relativeTime,
  roleCaps,
  sortedApprovals,
  stringifyMemoryValue,
  summarizeClientInvoices,
  syncBanner,
  unwrap,
} from '../screens/agency/ops/agency-ops-model';

const A = 'agency-1';

describe('agency-ops-model: sections + requests', () => {
  test('ten sections in web order', () => {
    expect(SECTIONS.map((s) => s.key)).toEqual(['overview', 'delivery', 'finance', 'employees', 'employee-ops', 'allocation', 'approvals', 'activity', 'reliability', 'settings']);
  });
  test('panel requests mirror the web loader params', () => {
    const reqs = panelRequests(A);
    const byKey = Object.fromEntries(reqs.map(([k, m, p]) => [k, [m, p]]));
    expect(byKey.engagements).toEqual(['agency.ops.engagements.list', { agencyId: A, status: 'active' }]);
    expect(byKey.approvals[1]).toEqual({ agencyId: A, status: 'pending' });
    expect(byKey.workItems).toEqual(['agency.ops.employee.inbox.list', { agencyId: A, limit: 250 }]);
    expect(byKey.kanbanTasks).toEqual(['kanban.tasks.list', {}]);
  });
  test('diagnostics only for admins', () => {
    expect(diagnosticRequests(A, false).map((r) => r[1])).toEqual(['agency.ops.replication.status']);
    expect(diagnosticRequests(A, true)).toHaveLength(3);
  });
  test('pickSelectedAgency prefers stored, else owned, else first', () => {
    const list = [{ id: 'x', role: 'member' }, { id: 'y', role: 'owner' }];
    expect(pickSelectedAgency(list, 'x')).toBe('x');
    expect(pickSelectedAgency(list, 'gone')).toBe('y');
    expect(pickSelectedAgency([{ id: 'z', role: 'viewer' }], null)).toBe('z');
    expect(pickSelectedAgency([], null)).toBeNull();
  });
  test('unwrap', () => {
    expect(unwrap({ a: [1] }, 'a', [])).toEqual([1]);
    expect(unwrap(null, 'a', 'fb')).toBe('fb');
    expect(unwrap([2], 'a', [])).toEqual([2]);
  });
});

describe('normalizePanels', () => {
  const results = {
    dashboard: { dashboard: { kpis: [{ label: 'Cash', value: '$1', context: 'x' }] } },
    pipeline: { pipeline: { stages: [{ id: 'lead', label: 'Lead' }], deals: [] } },
    employees: { employees: [{ id: 'e1', name: 'Atlas', kind: 'ai', utilizationPercent: 50 }] },
    clients: { clients: [{ id: 'c1', name: 'Grant' }], knownPipelineStatuses: ['Cold', 'Lead'] },
    projects: { projects: [{ id: 'p1', name: 'Site', status: 'planned', clientId: 'c1' }] },
    kanbanProjects: { projects: [
      { id: 'k1', name: 'Site', status: 'In progress' },
      { id: 'k2', name: 'Internal tool', status: 'Reviewing' },
      { id: 'k3', name: 'Old', status: 'Completed' },
      { id: 'k4', name: 'Archived', status: 'In progress', archived: true },
    ] },
    kanbanTasks: { tasks: [{ id: 't1', projectId: 'k1', status: 'done' }, { id: 't2', projectId: 'k1', status: 'todo' }, { id: 'bad' }] },
    revenue: { revenue: { currency: 'USD', invoicedRevenueCents: 1000, collectedRevenueCents: 250 }, entries: [{ id: 'r1' }] },
    workItems: null,
  };
  const s = normalizePanels(results, { workItems: [{ id: 'w-prev' }] });
  test('unwraps envelopes', () => {
    expect(s.kpis).toHaveLength(1);
    expect(s.pipelineStages[0].id).toBe('lead');
    expect(s.knownPipelineStatuses).toEqual(['Cold', 'Lead']);
    expect(s.revenueEntries).toEqual([{ id: 'r1' }]);
  });
  test('a failed panel keeps the previous value', () => {
    expect(s.workItems).toEqual([{ id: 'w-prev' }]);
  });
  test('kanban in-progress projects mirror into the register', () => {
    const site = s.projects.find((p) => p.id === 'p1');
    expect(site.status).toBe('active');
    expect(s.projects.find((p) => p.id === 'k2')).toMatchObject({ name: 'Internal tool', status: 'active', mirrored: true });
    expect(s.projects.find((p) => p.id === 'k4')).toBeUndefined();
    expect(s.kanbanTasks).toHaveLength(2);
  });
  test('active projects group by client with internal last', () => {
    const groups = activeProjectGroups({ ...s, clients: [{ id: 'c1', name: 'Grant' }] });
    expect(groups.map((g) => g.name)).toEqual(['Grant', 'Internal / Unassigned']);
    expect(groups[0].projects[0]).toMatchObject({ id: 'k1', agencyProjectId: 'p1' });
  });
  test('kanban roll', () => {
    expect(kanbanProjectRoll(s.kanbanTasks, 'k1')).toMatchObject({ total: 2, done: 1, pct: 50 });
  });
});

describe('overview + decisions', () => {
  test('server kpis win, fallback derived otherwise', () => {
    expect(overviewKpis({ kpis: [{ label: 'X', value: 3, change: -5, context: 'wk' }] })[0]).toMatchObject({ value: '3', context: 'Down 5% wk' });
    const fb = overviewKpis({ kpis: [], engagements: [1, 2], approvals: [], employees: [{ utilizationPercent: 40 }, { utilizationPercent: 60 }], finance: { currency: 'USD', cashCollectedMonth: 1500, grossMarginPercent: 80 } });
    expect(fb.map((k) => k.value)).toEqual(['2', '$1,500', '0', '80%', '50%']);
  });
  test('decision queue = approvals + queued work items', () => {
    const q = decisionQueue({
      approvals: [{ id: 'a1', risk: 'high', title: 'Send', requestedAt: 1 }],
      workItems: [{ id: 'w1', status: 'queued', priority: 'urgent', title: 'Do', workerId: 'e1', instructions: '### Heading\nbody' }, { id: 'w2', status: 'accepted' }],
      employees: [{ id: 'e1', name: 'Atlas' }],
    });
    expect(q.map((i) => i.kind)).toEqual(['approval', 'work']);
    expect(q[1]).toMatchObject({ risk: 'high', detail: 'Heading · Atlas' });
  });
  test('approvals sort by risk then age', () => {
    const out = sortedApprovals([{ id: 'l', risk: 'low', requestedAt: 1 }, { id: 'h2', risk: 'high', requestedAt: 5 }, { id: 'h1', risk: 'high', requestedAt: 2 }]);
    expect(out.map((a) => a.id)).toEqual(['h1', 'h2', 'l']);
  });
});

describe('delivery', () => {
  const s = {
    projects: [{ id: 'p1', clientId: 'c1', status: 'active' }, { id: 'p2', clientId: 'c2', status: 'planned' }],
    tasks: [
      { id: 't1', projectId: 'p1', status: 'done' },
      { id: 't2', projectId: 'p1', status: 'blocked', assigneeType: 'ai' },
      { id: 't3', projectId: 'p2', status: 'in_progress' },
      { id: 't4', projectId: 'p2', status: 'weird' },
    ],
  };
  test('kpis', () => {
    expect(deliveryKpis(s)).toMatchObject({ projects: 2, activeProjects: 1, open: 3, done: 1, blocked: 1, aiAssigned: 1 });
  });
  test('board columns with filters and unknown statuses appended', () => {
    const cols = boardColumns(s);
    expect(cols.map((c) => c.key)).toEqual(['backlog', 'ready', 'in_progress', 'blocked', 'review', 'done', 'weird']);
    expect(boardColumns(s, { clientFilter: 'c1' }).reduce((n, c) => n + c.tasks.length, 0)).toBe(2);
    expect(boardColumns(s, { projectFilter: 'p2' }).find((c) => c.key === 'in_progress').tasks).toHaveLength(1);
  });
});

describe('clients & finance', () => {
  const s = {
    knownPipelineStatuses: ['Cold', 'Lead'],
    clients: [
      { id: 'c1', name: 'Alpha', status: 'active', pipelineStatusLabel: 'Lead', billingEmail: 'a@x.io' },
      { id: 'c2', name: 'Beta', status: 'prospect', pipelineStatusLabel: 'Bespoke' },
      { id: 'c3', name: 'Gamma', status: 'inactive' },
    ],
    revenue: { currency: 'USD', invoicedRevenueCents: 20000, collectedRevenueCents: 5000, mrrCents: 0, arrCents: 0 },
    finance: { currency: 'USD', outstandingReceivables: 100, overdueReceivables: 0 },
  };
  test('kanban columns union bespoke statuses', () => {
    expect(clientKanbanColumns(s)).toEqual(['Cold', 'Lead', 'Bespoke']);
    const by = clientsByPipeline(s, s.clients);
    expect(by.get('cold').map((c) => c.id)).toEqual(['c3']);
    expect(by.get('bespoke').map((c) => c.id)).toEqual(['c2']);
  });
  test('search by name or billing email', () => {
    expect(filterClients(s.clients, 'A@X').map((c) => c.id)).toEqual(['c1']);
    expect(filterClients(s.clients, '')).toHaveLength(3);
  });
  test('finance kpis + collection rate', () => {
    const k = financeKpis(s);
    expect(k[0]).toMatchObject({ value: '3', context: '1 active · 2 prospects/inactive' });
    expect(k[1].value).toBe('$200');
    expect(collectionRate(s.revenue)).toBe(25);
    expect(collectionRate({})).toBe(0);
  });
  test('payment acceptance + overdue', () => {
    expect(invoiceAcceptsPayment({ status: 'issued', balanceCents: 1 })).toBe(true);
    expect(invoiceAcceptsPayment({ status: 'draft', balanceCents: 1 })).toBe(false);
    expect(isOverdue({ status: 'issued', balanceCents: 5, dueAt: 10 }, 20)).toBe(true);
    expect(isOverdue({ status: 'paid', balanceCents: 0, dueAt: 10 }, 20)).toBe(false);
  });
  test('client invoice summary', () => {
    const sum = summarizeClientInvoices([
      { status: 'paid', totalCents: 1000, amountPaidCents: 1000, balanceCents: 0 },
      { status: 'issued', totalCents: 500, amountPaidCents: 0, balanceCents: 500, dueAt: 1 },
      { status: 'void', totalCents: 999 },
    ], 10);
    expect(sum).toMatchObject({ invoicedCents: 1500, collectedCents: 1000, outstandingCents: 500, overdueCents: 500, paidCount: 1, openCount: 1, overdueCount: 1 });
  });
  test('client profile deadlines + timeline', () => {
    const p = clientProfile({
      projects: [{ id: 'p1', clientId: 'c1', name: 'Site', status: 'active', targetEndAt: 50 }],
      tasks: [{ id: 't', projectId: 'p1', title: 'Copy', status: 'todo', dueAt: 200 }],
      invoices: [{ clientId: 'c1', number: 'INV-1', status: 'paid', totalCents: 100, amountPaidCents: 100, issuedAt: 10, currency: 'USD' }],
    }, 'c1', [{ name: 'N', body: 'hello', updatedAt: 300 }], 100);
    expect(p.deadlines.map((d) => [d.name, d.overdue])).toEqual([['Site', true], ['Copy', false]]);
    expect(p.timeline[0].label).toBe('Note · N');
    expect(p.board.find((c) => c.status === 'active').projects).toHaveLength(1);
  });
  test('notes normalise newest first', () => {
    expect(normalizeNotes({ notes: [{ id: 1, name: 'a', updatedAt: 1 }, { id: 2, name: 'b', updatedAt: 5 }] }).map((n) => n.id)).toEqual(['2', '1']);
  });
});

describe('workforce', () => {
  const emps = [
    { id: 'a', name: 'Atlas', kind: 'ai', role: 'CEO', autonomyLevel: 2, capacityHours: 10, allocatedHours: 12, utilizationPercent: 120 },
    { id: 'h', name: 'Hana', kind: 'human', role: 'Designer', department: 'Studio', availability: 'blocked', capacityHours: 40, allocatedHours: 10, utilizationPercent: 25 },
  ];
  test('filter + search', () => {
    expect(filterEmployees(emps, { filter: 'ai' }).map((e) => e.id)).toEqual(['a']);
    expect(filterEmployees(emps, { search: 'studio' }).map((e) => e.id)).toEqual(['h']);
  });
  test('allocation summary sorts by utilisation', () => {
    const s = allocationSummary(emps);
    expect(s.sorted[0].id).toBe('a');
    expect(s).toMatchObject({ capacity: 50, allocated: 22, over: 1 });
  });
  test('work item lifecycle', () => {
    expect(['queued', 'accepted', 'waiting', 'in_progress', 'review', 'escalated', 'completed'].map(nextWorkItemStatus)).toEqual(['accepted', 'in_progress', 'in_progress', 'review', 'completed', 'completed', null]);
  });
  test('employee ops summary', () => {
    expect(employeeOpsSummary({ workItems: [{ status: 'escalated' }, { status: 'completed' }], responsibilities: [{ enabled: true }, { enabled: false }], reviewCycles: [{ status: 'due' }] })).toEqual({ open: 1, escalated: 1, duties: 1, reviewsDue: 1 });
  });
  test('autonomy', () => {
    expect(describeAutonomy(2).label).toBe('Bounded');
    expect(describeAutonomy(null)).toBeNull();
  });
  test('sop last run', () => {
    expect(lastRunSummary([{ status: 'materialised', createdAt: 0 }, { status: 'failed', createdAt: 100 }], 100)).toEqual({ label: 'Last run failed · just now', tone: 'danger' });
    expect(lastRunSummary([])).toBeNull();
  });
  test('memory values round trip', () => {
    expect(stringifyMemoryValue({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(parseMemoryValue('{"a":1}')).toEqual({ a: 1 });
    expect(parseMemoryValue('plain words')).toBe('plain words');
    expect(stringifyMemoryValue(null)).toBe('');
  });
});

describe('activity, sync, roles, formatting', () => {
  const s = { tasks: [{ id: 't', title: 'Task T', projectId: 'p' }], projects: [{ id: 'p', name: 'P' }], employees: [{ id: 'e', name: 'E' }], invoices: [{ id: 'i', number: 'INV-9' }], agencies: [{ id: 'ag', name: 'Ag' }], clients: [] };
  test('audit labels + targets', () => {
    expect(auditEntityLabel(s, 'task', 't')).toBe('Task T');
    expect(auditEntityLabel(s, 'invoice', 'i')).toBe('INV-9');
    expect(auditTarget(s, 'task', 't')).toEqual({ section: 'delivery', projectId: 'p' });
    expect(auditTarget(s, 'worker', 'e')).toEqual({ section: 'employees', employeeId: 'e' });
    expect(auditTarget(s, 'payment', 'x')).toEqual({ section: 'finance' });
    expect(auditTarget(s, 'client', 'missing')).toBeNull();
  });
  test('sync banner', () => {
    expect(syncBanner({ state: 'in_sync', lastSyncAt: Date.UTC(2026, 9, 1, 12), conflicts: 2 })).toMatchObject({ tone: 'success', conflicts: 2 });
    expect(syncBanner({ state: 'never_synced' }).title).toBe('Shared data sync is ready');
    expect(syncBanner({ state: 'error', lastError: 'boom' }).detail).toBe('boom');
  });
  test('role caps', () => {
    expect(roleCaps('owner')).toEqual({ canAdmin: true, canWrite: true, isOwner: true });
    expect(roleCaps('member')).toEqual({ canAdmin: false, canWrite: true, isOwner: false });
    expect(roleCaps('viewer').canWrite).toBe(false);
  });
  test('money + time', () => {
    expect(money(1234.4)).toBe('$1,234');
    expect(moneyCents(605000)).toBe('$6,050.00');
    expect(relativeTime(0, 3 * 60_000)).toBe('3m ago');
    expect(relativeTime(5 * 3_600_000, 0)).toBe('in 5h');
  });
});

import * as M from '../screens/agency/daily/daily-model';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

describe('agency-daily model — loop + delivery', () => {
  test('readLoopStatus finds the operating-loop cron job', () => {
    const loop = M.readLoopStatus({
      jobs: [
        { name: 'other' },
        {
          name: 'agency-operating-loop',
          enabled: true,
          schedule: { kind: 'every', everyMs: 900000 },
          state: { nextRunAtMs: 2, lastRunAtMs: 1, lastStatus: 'ok' },
        },
      ],
    });
    expect(loop).toMatchObject({ found: true, enabled: true, everyMs: 900000, lastStatus: 'ok', lastError: null });
    expect(M.loopHealth(loop)).toEqual({ tone: 'ok', text: 'Running automatically every 15 min.' });
  });

  test('missing / disabled loop job reads as a warning', () => {
    expect(M.readLoopStatus({ jobs: [] }).found).toBe(false);
    expect(M.loopHealth(M.readLoopStatus(null)).tone).toBe('warn');
    const off = M.readLoopStatus([{ name: 'agency-operating-loop', enabled: false }]);
    expect(M.loopHealth(off).text).toMatch(/disabled/);
  });

  test('loopResultText distinguishes "nothing due" from work', () => {
    expect(M.loopResultText({})).toBe('Loop ran — nothing was due.');
    expect(
      M.loopResultText({ generatedWorkItemIds: ['a', 'b'], escalatedWorkItemIds: [], dueReviewCycleIds: ['r'] }),
    ).toBe('Loop ran — 2 generated, 0 escalated, 1 review due.');
  });

  test('readDeliveryPulse counts statuses, overdue and the ranked active sample', () => {
    const tasks = [
      { id: '1', title: 'a', status: 'ready', priority: 'normal', projectId: 'p', dueAt: NOW - 1000 },
      { id: '2', title: 'b', status: 'blocked', priority: 'high', projectId: 'p' },
      { id: '3', title: 'c', status: 'done', priority: 'low', projectId: 'x', dueAt: NOW - 5000 },
      { id: '4', title: 'd', status: 'in_progress', priority: 'normal', projectId: 'p', dueAt: NOW + 60_000 },
    ];
    const pulse = M.readDeliveryPulse({ tasks }, new Map([['p', 'Proj']]), NOW);
    expect(pulse.total).toBe(4);
    expect(pulse.byStatus).toEqual({ ready: 1, blocked: 1, done: 1, in_progress: 1 });
    expect(pulse.overdue).toBe(1);
    expect(pulse.active.map((t) => t.id)).toEqual(['2', '4', '1']);
    expect(pulse.active[0].projectName).toBe('Proj');
  });

  test('mergeExecutions keeps probed non-staged views and reads executorEnabled', () => {
    const out = M.mergeExecutions(
      { executorEnabled: true, items: [{ workItemId: 'a', stage: 'accepted' }] },
      { b: { workItemId: 'b', stage: 'completed' }, c: { workItemId: 'c', stage: 'accepted' } },
    );
    expect(Object.keys(out.executions).sort()).toEqual(['a', 'b']);
    expect(out.executorEnabled).toBe(true);
  });

  test('pickAgency prefers the explicit choice, then owner', () => {
    const list = [
      { id: 'm', role: 'member' },
      { id: 'o', role: 'owner' },
    ];
    expect(M.pickAgency(list, null).id).toBe('o');
    expect(M.pickAgency(list, 'm').id).toBe('m');
    expect(M.pickAgency([], null)).toBeNull();
  });

  test('attentionCount sums escalated + overdue reviews + approvals', () => {
    expect(
      M.attentionCount([{ status: 'escalated' }, { status: 'queued' }], [{ status: 'overdue' }], [{}, {}]),
    ).toEqual({ total: 4, escalated: 1, overdueReviews: 1, approvals: 2 });
  });
});

describe('agency-daily model — work board', () => {
  test('transition table forbids queued -> in_progress (staging is the gate)', () => {
    expect(M.canTransitionWorkItem('queued', 'in_progress')).toBe(false);
    expect(M.canTransitionWorkItem('queued', 'accepted')).toBe(true);
    expect(M.canTransitionWorkItem('completed', 'queued')).toBe(false);
  });

  test('outcomeLabel hides unstaged-only noise but surfaces real blockers', () => {
    const unstaged = { executionEligible: false, terminalStage: 'completed', blockedReason: 'move the card' };
    expect(M.isUnstagedOnly(unstaged)).toBe(true);
    expect(M.outcomeLabel(unstaged)).toBe('runs to completion automatically');
    const blocked = { executionEligible: false, terminalStage: null, blockedReason: 'no backend' };
    expect(M.outcomeLabel(blocked)).toBeNull();
    expect(M.outcomeLabel({ executionEligible: true, terminalStage: 'review' })).toMatch(/Review/);
  });

  test('groupWorkItems sorts each stage newest-first', () => {
    const g = M.groupWorkItems([
      { id: 'a', status: 'queued', updatedAt: 1 },
      { id: 'b', status: 'queued', updatedAt: 5 },
      { id: 'c', status: 'escalated' },
    ]);
    expect(g.queued.map((i) => i.id)).toEqual(['b', 'a']);
    expect(g.escalated).toHaveLength(1);
  });

  test('describeRunResult builds the deliverable view', () => {
    expect(M.describeRunResult({ status: 'queued' }, null).kind).toBe('none');
    const r = M.describeRunResult(
      { status: 'completed' },
      { backend: 'codex', lastRun: { outcome: 'completed', output: 'done!', startedAt: 1, recordedAt: 2, durationMs: 65000, attempts: 1 } },
    );
    expect(r).toMatchObject({ kind: 'done', output: 'done!', backend: 'codex', duration: '1m 5s', attempts: 1 });
    expect(r.timeline.map((t) => t.label)).toEqual(['Run started', 'Completed']);
  });
});

describe('agency-daily model — composer', () => {
  const employees = [
    { id: 'w1', name: 'Dev' },
    { id: 'w2', name: 'Vega' },
  ];

  test('createComposer defaults worker + a different manager', () => {
    const c = M.createComposer('review', {}, employees);
    expect(c.workerId).toBe('w1');
    expect(c.managerWorkerId).toBe('w2');
    expect(c.weekdays).toEqual([1, 2, 3, 4, 5]);
  });

  test('work-item maps to work-item.create with relative due date', () => {
    const c = M.createComposer('work-item', { title: ' Ship it ', dueInDays: 2 }, employees);
    const plan = M.composerRequest(c, employees, 'ag', NOW);
    expect(plan.method).toBe('agency.ops.employee.work-item.create');
    expect(plan.params).toMatchObject({ agencyId: 'ag', workerId: 'w1', title: 'Ship it', dueAt: NOW + 2 * M.DAY_MS });
    expect(plan.notice).toMatch(/Backlog/);
  });

  test('validation messages match the web', () => {
    expect(M.composerRequest(M.createComposer('work-item', {}, employees), employees, 'ag')).toBe(
      'Give the work item a title.',
    );
    expect(M.composerRequest(M.createComposer('schedule', { weekdays: [] }, employees), employees, 'ag')).toBe(
      'Pick at least one working day.',
    );
    expect(
      M.composerRequest(M.createComposer('review-complete', { reviewCycleId: 'r' }, employees), employees, 'ag'),
    ).toBe('Record what the review concluded.');
  });

  test('responsibility + schedule normalise times', () => {
    const r = M.composerRequest(M.createComposer('responsibility', { title: 'x', runAt: '9' }, employees), employees, 'ag');
    expect(r.params.runAt).toBe('09:00');
    expect(r.method).toBe('agency.ops.employee.responsibility.create');
    const bad = M.composerRequest(M.createComposer('responsibility', { title: 'x', runAt: '25:00' }, employees), employees, 'ag');
    expect(typeof bad).toBe('string');
    const s = M.composerRequest(
      M.createComposer('schedule', { weekdays: [5, 1], shiftStart: '0800', timezone: 'UTC' }, employees),
      employees,
      'ag',
      NOW,
    );
    expect(s.params).toMatchObject({ weekdays: [1, 5], shiftStart: '08:00', shiftEnd: '17:00', effectiveFrom: '2026-10-14' });
  });

  test('review cycle uses cadence for nextReviewAt', () => {
    const plan = M.composerRequest(M.createComposer('review', { cadenceDays: 3 }, employees), employees, 'ag', NOW);
    expect(plan.method).toBe('agency.ops.employee.review-cycle.create');
    expect(plan.params.nextReviewAt).toBe(NOW + 3 * M.DAY_MS);
  });
});

describe('agency-daily model — delivery + routing + handoff', () => {
  test('kanban task mapping and reverse status', () => {
    const t = M.mapKanbanTask({ id: 't', projectId: 'p', title: 'x', status: 'todo', priority: 'critical', assignedAgent: 'w1', dueDate: '2026-10-20' });
    expect(t).toMatchObject({ status: 'ready', priority: 'urgent', assigneeType: 'ai', assigneeId: 'w1' });
    expect(t.dueAt).toBe(Date.parse('2026-10-20'));
    expect(M.deliveryStatusToKanban('blocked')).toBe('in_progress');
    expect(M.deliveryStatusToKanban('ready')).toBe('todo');
  });

  test('visibleTasks applies unowned/closed/project/search filters and ordering', () => {
    const tasks = [
      { id: 'a', title: 'Alpha', status: 'ready', priority: 'normal', projectId: 'p' },
      { id: 'b', title: 'Beta', status: 'ready', priority: 'urgent', projectId: 'p' },
      { id: 'c', title: 'Gamma', status: 'done', priority: 'high', projectId: 'p' },
      { id: 'd', title: 'Delta', status: 'ready', priority: 'high', projectId: 'q', assigneeId: 'w' },
    ];
    expect(M.visibleTasks(tasks, { search: '', showDone: false, unassignedOnly: true, projectFilter: '' }).map((t) => t.id)).toEqual(['b', 'a']);
    expect(M.visibleTasks(tasks, { search: 'del', showDone: true, unassignedOnly: false, projectFilter: 'q' }).map((t) => t.id)).toEqual(['d']);
    expect(M.unownedOpenCount(tasks)).toBe(2);
    expect(M.eligibleForHandoff(['a', 'c', 'zz'], tasks)).toEqual(['a']);
  });

  test('routing preview is read defensively', () => {
    const r = M.routingFromResponse(
      { routing: { enabled: true, mode: 'auto', candidates: 8, assigned: 2, writes: 0, decisions: [{ taskId: 't', title: 'T', reason: 'fits', confidence: 0.5 }] } },
      'agency.ops.routing.preview',
      NOW,
    );
    expect(r).toMatchObject({ status: 'ready', enabled: true, mode: 'auto' });
    expect(r.counts.assigned).toBe(2);
    expect(r.decisions[0]).toMatchObject({ taskTitle: 'T', rationale: 'fits', confidence: 0.5 });
    expect(M.routingApplyNotice({ routing: { writes: 0 } })).toMatch(/changed nothing/);
    expect(M.routingApplyNotice({ routing: { writes: 3, assigned: 3, unmatched: 1, autoStaged: 0 } })).toBe(
      'Routing pass: 3 assigned, 1 left for a human, 0 auto-staged.',
    );
  });

  test('rankCandidates flags non-discriminating suitability scores', () => {
    const employees = [{ id: 'a' }, { id: 'b' }];
    const load = new Map([['a', 3]]);
    const flat = M.rankCandidates(employees, [{ workerId: 'a', score: 100 }, { workerId: 'b', score: 100 }], load);
    expect(flat.discriminating).toBe(false);
    expect(flat.ordered.map((e) => e.id)).toEqual(['b', 'a']);
    const ranked = M.rankCandidates(employees, [{ workerId: 'a', score: 90 }, { workerId: 'b', score: 40 }], load);
    expect(ranked.topId).toBe('a');
  });

  test('handoff consequence + notice wording', () => {
    const employee = { name: 'Dev', autonomyLevel: 1, model: 'coder' };
    expect(M.handoffConsequence({ employee: null }).tone).toBe('warning');
    expect(M.handoffConsequence({ employee, authorizeNow: true, executionsLoaded: true, executorEnabled: true }).text).toMatch(/These will run/);
    expect(M.handoffConsequence({ employee, authorizeNow: false, executionsLoaded: true, executorEnabled: false }).text).toMatch(/OFF/);
    expect(M.handoffNotice({ sent: 2, total: 2, failed: 0, workerName: 'Dev', authorizeNow: false })).toBe(
      '2 tasks handed to Dev — queued in Backlog, not yet authorised.',
    );
    expect(M.handoffNotice({ sent: 1, total: 3, failed: 2, workerName: 'Dev' })).toMatch(/2 failed/);
  });

  test('helpers', () => {
    expect(M.isZeroish('$0')).toBe(true);
    expect(M.isZeroish('1176h')).toBe(false);
    expect(M.money(605000)).toBe('$6,050');
    expect(M.relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(M.dueLabel(NOW + 3 * 3600_000, NOW)).toBe('due in 3h');
    expect(M.appendNote('desc', '  hi ', NOW)).toBe('desc\n\n[note 2026-10-14 12:00] hi');
    expect(M.appendNote('desc', '   ')).toBeNull();
    expect(M.isMissingMethod(new Error('unknown method: agency.ops.routing.preview'))).toBe(true);
    expect(M.isMissingMethod(new Error('agency not found'))).toBe(false);
    expect(M.unwrap({ jobs: [1] }, 'jobs', [])).toEqual([1]);
    expect(M.unwrap([2], 'jobs', [])).toEqual([2]);
  });
});

import * as M from '../screens/goals/goals-model';

describe('route params', () => {
  test('defaults to goals', () => {
    expect(M.resolveRouteParams(undefined)).toEqual({ view: 'goals', goal: null, phase: null, task: null });
  });
  test('infers view from focus id', () => {
    expect(M.resolveRouteParams({ phase: 'p1' }).view).toBe('phases');
    expect(M.resolveRouteParams({ task: 'st_1' }).view).toBe('scheduled');
    expect(M.resolveRouteParams({ goal: 'g1' })).toMatchObject({ view: 'goals', goal: 'g1' });
  });
  test('explicit view wins, junk normalizes', () => {
    expect(M.resolveRouteParams({ view: 'scheduled', goal: 'g' }).view).toBe('scheduled');
    expect(M.normalizeView('nope')).toBe('goals');
  });
});

describe('shared helpers', () => {
  test('isUnknownMethod', () => {
    expect(M.isUnknownMethod(new Error('unknown method: goals.list'))).toBe(true);
    expect(M.isUnknownMethod(new Error('boom'))).toBe(false);
  });
  test('fmtDuration', () => {
    expect(M.fmtDuration(5000)).toBe('5s');
    expect(M.fmtDuration(125000)).toBe('2m 5s');
    expect(M.fmtDuration(3 * 3600e3 + 60e3)).toBe('3h 1m');
    expect(M.fmtDuration(-1)).toBe('—');
  });
  test('formatAgo', () => {
    const now = 1_000_000_000;
    expect(M.formatAgo(now - 10_000, now)).toBe('just now');
    expect(M.formatAgo(now - 5 * 60_000, now)).toBe('5m ago');
    expect(M.formatAgo(now - 3 * 3600e3, now)).toBe('3h ago');
    expect(M.formatAgo(null, now)).toBe('never');
  });
  test('normalizeAgents', () => {
    expect(M.normalizeAgents({ agents: [{ id: 'main', identity: { name: 'Infini' } }, { name: 'x' }, { id: 'b' }] }))
      .toEqual([{ id: 'main', name: 'Infini' }, { id: 'b', name: 'b' }]);
  });
  test('parseTarget', () => {
    expect(M.parseTarget('cli:codex', ' gpt-5.5 ')).toEqual({ kind: 'cli', backend: 'codex', model: 'gpt-5.5' });
    expect(M.parseTarget('agent:main', '')).toEqual({ kind: 'agent', agentId: 'main' });
  });
});

describe('goals', () => {
  const goals = [
    { id: 'a', status: 'running' }, { id: 'b', status: 'paused' }, { id: 'c', status: 'completed' },
    { id: 'd', status: 'failed' }, { id: 'e', status: 'exhausted' }, { id: 'f', status: 'canceled' },
  ];
  test('filters + counts', () => {
    expect(M.goalCounts(goals)).toEqual({ all: 6, active: 2, completed: 1, failed: 2 });
    expect(M.filterGoals(goals, 'failed').map((g) => g.id)).toEqual(['d', 'e']);
  });
  test('goalsHaveActive ignores paused', () => {
    expect(M.goalsHaveActive([{ status: 'paused' }])).toBe(false);
    expect(M.goalsHaveActive([{ status: 'checking' }])).toBe(true);
  });
  test('describeGoalCheck', () => {
    expect(M.describeGoalCheck({ type: 'shell', command: 'pnpm test' })).toBe('$ pnpm test');
    expect(M.describeGoalCheck({ type: 'grep', path: 'a', pattern: 'x', negate: true })).toBe('not /x/ in a');
    expect(M.describeGoalCheck({ type: 'visual', routes: ['/chat'], expectation: 'ok' })).toBe('/chat — ok');
    expect(M.describeGoalCheck({ type: 'shell', label: 'L' })).toBe('L');
  });
  test('targetLabel', () => {
    expect(M.goalTargetLabel({ kind: 'cli', backend: 'claude-code', model: 'opus' })).toBe('Claude Code · opus');
    expect(M.goalTargetLabel({ kind: 'agent', agentId: 'main' })).toBe('@main');
  });
  test('draft checks drop incomplete rows', () => {
    const out = M.draftChecksToGoalChecks([
      { type: 'shell', command: ' pnpm test ' },
      { type: 'shell', command: '' },
      { type: 'file', path: 'dist', negate: true },
      { type: 'grep', path: 'a', pattern: '' },
      { type: 'llm', criterion: 'works' },
      { type: 'visual', routes: '/a, /b ,', criterion: '' },
    ]);
    expect(out).toEqual([
      { type: 'shell', command: 'pnpm test' },
      { type: 'file', path: 'dist', negate: true },
      { type: 'llm', criterion: 'works' },
      { type: 'visual', routes: ['/a', '/b'] },
    ]);
  });
  test('buildGoalCreateParams validates and maps limits', () => {
    expect(M.buildGoalCreateParams(M.defaultGoalDraft()).error).toMatch(/Describe the goal/);
    expect(M.buildGoalCreateParams({ ...M.defaultGoalDraft(), goal: 'x' }).error).toMatch(/at least one completion check/);
    const d = { ...M.defaultGoalDraft(), goal: ' Ship it ', checks: [{ type: 'shell', command: 'pnpm test' }], target: 'agent:main', workdir: ' ~/x ' };
    const { params } = M.buildGoalCreateParams(d);
    expect(params).toEqual({
      goal: 'Ship it',
      checks: [{ type: 'shell', command: 'pnpm test' }],
      target: { kind: 'agent', agentId: 'main' },
      workdir: '~/x',
      notify: true,
      limits: { maxIterations: 5, maxWallClockSec: 7200, iterationTimeoutSec: 1800, checkIntervalSec: 120, hangSec: 600 },
    });
  });
  test('mergeGoalDraft tolerates garbage', () => {
    expect(M.mergeGoalDraft('x')).toEqual(M.defaultGoalDraft());
    const d = M.mergeGoalDraft({ goal: 'g', checks: [{ type: 'llm', criterion: 'c' }] });
    expect(d.goal).toBe('g');
    expect(d.checks[0]).toMatchObject({ type: 'llm', criterion: 'c', command: '' });
  });
  test('goalControls per status', () => {
    expect(M.goalControls('running')).toEqual(['pause', 'recheck', 'cancel']);
    expect(M.goalControls('paused')).toEqual(['resume', 'recheck', 'cancel']);
    expect(M.goalControls('failed')).toEqual(['recheck', 'retry', 'delete']);
    expect(M.goalControls('completed')).toEqual(['recheck', 'delete']);
  });
  test('iterationTone + checkResultState + elapsed', () => {
    expect(M.iterationTone({ outcome: 'checks_passed', endedAt: 1 }, 'running')).toBe('success');
    expect(M.iterationTone({ outcome: 'running', endedAt: null }, 'running')).toBe('primary');
    expect(M.iterationTone({ outcome: 'exited', endedAt: 1 }, 'running')).toBe('warning');
    expect(M.iterationTone({ outcome: 'crashed', endedAt: 1 }, 'failed')).toBe('danger');
    const run = { lastResults: { c1: { pass: false } } };
    const hist = Array.from({ length: 20 }, (_, i) => ({ checkId: 'c1', pass: i % 2 === 0 }));
    const r = M.checkResultState({ id: 'c1' }, run, hist);
    expect(r.state).toBe('fail');
    expect(r.hist).toHaveLength(16);
    expect(M.checkResultState({ id: 'zz' }, run, hist).state).toBe('pending');
    expect(M.goalElapsed({ elapsedMs: 1000, activeSince: 500 }, 1500)).toBe(2000);
  });
});

describe('phases', () => {
  const entries = [
    { id: '1', status: 'queued' }, { id: '2', status: 'running' }, { id: '3', status: 'blocked' },
    { id: '4', status: 'dead' }, { id: '5', status: 'done' }, { id: '6', status: 'canceled' },
  ];
  test('filters + counts', () => {
    expect(M.entryFilterCounts(entries)).toEqual({ all: 6, active: 2, blocked: 2, done: 1, failed: 1 });
    expect(M.entryStatusCounts(entries).map((c) => c.status)).toEqual(['queued', 'running', 'blocked', 'done', 'canceled', 'dead']);
    expect(M.entriesHaveActive([{ status: 'paused' }])).toBe(false);
  });
  test('gateList parses string criteria', () => {
    expect(M.gateList('$ pnpm test\n\nlooks good')).toEqual([
      { type: 'shell', command: 'pnpm test' },
      { type: 'llm', criterion: 'looks good' },
    ]);
    expect(M.gateList(null)).toEqual([]);
  });
  test('agent / model labels', () => {
    expect(M.agentLabel('agent:main')).toBe('@main');
    expect(M.agentLabel('codex')).toBe('Codex');
    expect(M.agentLabel(null)).toBe('default agent');
    expect(M.attemptModelLabel({ modelRequested: 'opus', model: 'sonnet' })).toBe('opus → sonnet');
  });
  test('buildEnqueueParams', () => {
    const d = M.defaultPhaseDraft();
    expect(M.buildEnqueueParams(d)).toMatchObject({ error: 'Phase 1 needs a name.', phaseIndex: 0 });
    d.title = ' T ';
    d.brief = 'B';
    d.priority = 3.4;
    d.phases = [
      { ...M.emptyPhase(), name: 'Build', model: 'opus', fallbackAgent: 'codex', checks: [{ type: 'shell', command: 'x' }], maxAttempts: 50, timeoutMin: 0.01 },
    ];
    expect(M.buildEnqueueParams(d).params).toEqual({
      title: 'T',
      briefMd: 'B',
      phaseSpec: [{ name: 'Build', agent: 'claude-code', model: 'opus', fallbackAgent: 'codex', gateCriteria: [{ type: 'shell', command: 'x' }], maxAttempts: 20, timeoutSec: 10 }],
      priority: 3,
      isolation: 'none',
    });
  });
  test('movePhase', () => {
    expect(M.movePhase(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(M.movePhase(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
  test('phaseState', () => {
    const e = { status: 'blocked', currentPhaseIdx: 1 };
    expect([0, 1, 2].map((i) => M.phaseState(e, i))).toEqual(['done', 'blocked', 'pending']);
    expect(M.phaseState({ status: 'done', currentPhaseIdx: 0 }, 3)).toBe('done');
    expect(M.phaseStateLabel({ status: 'running' }, 'active')).toBe('Running');
  });
  test('entryCapabilities', () => {
    expect(M.entryCapabilities({ status: 'running' })).toMatchObject({ pause: true, forcePause: true, retry: false, cancel: true });
    expect(M.entryCapabilities({ status: 'paused' })).toMatchObject({ resume: true, retry: true, skip: true });
    expect(M.entryCapabilities({ status: 'done' })).toMatchObject({ cancel: false, reorder: false, retry: false });
  });
  test('entryBanner', () => {
    expect(M.entryBanner({ status: 'done', lastError: 'x' })).toBeNull();
    expect(M.entryBanner({ status: 'blocked', blockedKind: 'gate_failed', fixHint: 'fix' })).toMatchObject({ tone: 'warning', title: 'Blocked — Gate failed', fix: 'fix' });
    const w = M.entryBanner({ status: 'queued', waitingReason: 'Waiting.', nextAttemptAt: 70_000 }, 10_000);
    expect(w.title).toBe('Waiting to dispatch');
    expect(w.text).toBe('Waiting. Next attempt in 1m 0s.');
  });
  test('buildRetryParams', () => {
    const e = { currentPhaseIdx: 2 };
    expect(M.buildRetryParams(e, { from: -1, instruction: ' ', fresh: false, agent: '', model: '' })).toEqual({});
    expect(M.buildRetryParams(e, { from: 0, instruction: ' do x ', fresh: true, agent: 'codex', model: 'gpt' }))
      .toEqual({ fromPhase: 0, instruction: 'do x', freshSession: true, agent: 'codex', model: 'gpt' });
  });
  test('backendState + row summary', () => {
    expect(M.backendState({ authState: 'ok', available: true }).tone).toBe('success');
    expect(M.backendState({ authState: 'auth-required' }).label).toBe('not logged in');
    const sum = M.entryRowSummary({ status: 'running', currentPhaseIdx: 1, phaseSpec: [{ name: 'a' }, { name: 'b', agent: 'codex' }] });
    expect(sum).toMatchObject({ position: 'phase 2/2', phaseName: 'b', who: 'Codex' });
    expect(M.phaseProgress({ status: 'done', currentPhaseIdx: 2, phaseSpec: [1, 2] })).toEqual({ current: 2, total: 2 });
  });
});

describe('scheduled', () => {
  test('stepper', () => {
    expect(M.stepperStates('building').map((s) => s.state)).toEqual(['done', 'done', 'now', 'todo', 'todo', 'todo']);
    expect(M.stepperStates('deployed').every((s) => s.state === 'done')).toBe(true);
    expect(M.stepperStates('rejected')[0].state).toBe('fail');
  });
  test('groupItems + lowRiskBatch', () => {
    const items = [
      { id: 1, stage: 'suggested', runId: 'r1', item: { risk: 'low' } },
      { id: 2, stage: 'suggested', runId: 'r1', item: { risk: 'low' } },
      { id: 3, stage: 'building', runId: 'r1', item: {} },
      { id: 4, stage: 'deployed', runId: 'r1', item: {} },
    ];
    const g = M.groupItems(items);
    expect([g.needs.length, g.flight.length, g.done.length]).toEqual([2, 1, 1]);
    expect(M.lowRiskBatch(g.needs)).toEqual({ runId: 'r1', n: 2 });
    expect(M.lowRiskBatch(g.needs.slice(0, 1))).toBeNull();
    expect(M.scheduledHasInFlight(items, [])).toBe(true);
  });
  test('runningRun + totals', () => {
    expect(M.runningRun([{ status: 'delivered' }, { status: 'validating', id: 'x' }]).id).toBe('x');
    expect(M.totalAwaiting([{ counts: { awaitingDecision: 2 } }, { counts: { awaitingDecision: 3 } }])).toBe(5);
  });
  test('action helpers', () => {
    expect(M.actionVariant('approve')).toBe('primary');
    expect(M.actionVariant('reject_deploy')).toBe('danger');
    expect(M.actionNeedsInstruction('modify')).toBe(true);
    expect(M.actionNeedsInstruction('approve')).toBe(false);
  });
  test('task draft round trip + body', () => {
    const t = {
      id: 'st_1', name: 'Nightly', cron: '0 9 * * *', timezone: 'UTC',
      assignee: { kind: 'agent', agentId: 'main', model: 'm' },
      repos: [{ label: 'r', path: '/r', branch: 'main', focus: ['x'] }],
      instructions: 'i', delivery: ['ui'], approval: { autoContinueOnApprove: false, requireDeployApproval: true },
      deployCommand: null, enabled: false,
    };
    const d = M.taskToDraft(t);
    expect(d).toMatchObject({ target: 'agent:main', model: 'm', telegram: false, ui: true, deployCommand: '', enabled: false });
    expect(M.buildTaskBody(d).body).toEqual({
      name: 'Nightly', cron: '0 9 * * *', timezone: 'UTC',
      assignee: { kind: 'agent', agentId: 'main', model: 'm' },
      repos: [{ path: '/r', label: 'r', branch: 'main' }],
      instructions: 'i', delivery: ['ui'],
      approval: { requireDeployApproval: true, autoContinueOnApprove: false },
      deployCommand: null, enabled: false,
    });
  });
  test('buildTaskBody validation + delivery fallback', () => {
    expect(M.buildTaskBody(M.emptyTaskDraft('UTC')).error).toMatch(/name/);
    expect(M.buildTaskBody({ ...M.emptyTaskDraft('UTC'), name: 'x' }).error).toMatch(/repository/);
    const { body } = M.buildTaskBody({ ...M.emptyTaskDraft(''), name: 'x', telegram: false, ui: false, repos: [{ label: '', path: '/a', branch: '' }] });
    expect(body.delivery).toEqual(['ui']);
    expect(body.timezone).toBe('UTC');
    expect(body.repos).toEqual([{ path: '/a' }]);
    expect(body.assignee).toEqual({ kind: 'cli', backend: 'claude-code' });
  });
  test('labels', () => {
    expect(M.scheduledTargetLabel({ kind: 'cli', backend: 'codex' })).toBe('Codex');
    expect(M.scheduledTargetLabel({ kind: 'agent', agentId: 'main' })).toBe('Agent · main');
    expect(M.scheduledCheckText({ type: 'llm', criterion: 'c' })).toBe('AI judge: c');
    expect(M.whenText(null, 'UTC')).toBe('—');
    expect(M.saveNotice({ id: null }, true)).toBe('Task created — first review started');
  });
});

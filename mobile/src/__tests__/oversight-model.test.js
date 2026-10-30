import {
  normalizeReviewShape,
  normalizeStatus,
  historyRowToSubagent,
  mergeLiveAndHistory,
  projectSubagent,
  buildEntries,
  applyOversightFilters,
  rebuildOverlay,
  countActiveOversightFilters,
  clearedOversightFilters,
  DEFAULT_OVERSIGHT_FILTERS,
  parsePersisted,
  toPersisted,
  filtersFromPersisted,
  ackedFromPersisted,
  toggleAck,
  reviewFromResult,
  rpcFailure,
  entryFromReview,
  verdictTone,
  verdictBadgeTone,
  verdictSettled,
  visibleEvidence,
  verificationFileUrl,
  normalizeThread,
  packetTone,
  messageRoute,
  threadHeadline,
  stripAnsi,
  coerceRunReview,
  runReviewsFromList,
  runReviewFromResult,
  applyRunReviewFilters,
  runFileRow,
  forwardActionPlan,
  followUpDraft,
  isUnknownMethodError,
  groupOversightJobs,
  isOversightJob,
  fmtSchedule,
  fmtWhen,
  timeAgo,
  fmtDuration,
  fmtCost,
  severityTone,
  sortedActions,
} from '../screens/oversight/oversight-model';

const NOW = 1_800_000_000_000;

describe('formatters', () => {
  test('timeAgo / duration / cost', () => {
    expect(timeAgo(0, NOW)).toBe('—');
    expect(timeAgo(NOW - 5_000, NOW)).toBe('5s ago');
    expect(timeAgo(NOW - 3 * 60_000, NOW)).toBe('3m ago');
    expect(timeAgo(NOW - 2 * 3_600_000, NOW)).toBe('2h ago');
    expect(timeAgo(NOW - 3 * 86_400_000, NOW)).toBe('3d ago');
    expect(fmtDuration(0)).toBe('—');
    expect(fmtDuration(42_000)).toBe('42s');
    expect(fmtDuration(4_159_077)).toBe('1h 9m');
    expect(fmtCost(0.004)).toBe('<$0.01');
    expect(fmtCost(1.23456)).toBe('$1.235');
    expect(fmtCost(undefined)).toBe('');
  });
});

describe('review overlay shape', () => {
  test('string confidence + object files are normalised (web _normalizeReviewShape)', () => {
    const r = normalizeReviewShape({
      runId: 'a',
      confidence: 'high',
      filesTouched: [{ path: 'x.ts', action: 'modified' }, 'y.ts', null],
      completion: { verdict: 'VERIFIED', state: 'verified', evidence: [{ kind: 'command', ref: '\u001b[32mok\u001b[39m', status: 'pass' }] },
    });
    expect(r.confidence).toBe(0.9);
    expect(r.filesTouched).toEqual(['x.ts', 'y.ts']);
    expect(r.blockers).toEqual([]);
    expect(r.completion.evidence[0].ref).toBe('ok');
    expect(normalizeReviewShape({ runId: 'b', confidence: 0.42 }).confidence).toBe(0.42);
    expect(normalizeReviewShape({ runId: 'c' }).confidence).toBe(0.5);
  });
});

describe('run spine', () => {
  test('normalizeStatus', () => {
    expect(normalizeStatus('working', undefined, undefined)).toBe('running');
    expect(normalizeStatus('', { status: 'error' }, 5)).toBe('errored');
    expect(normalizeStatus('timeout')).toBe('errored');
    expect(normalizeStatus('killed')).toBe('aborted');
    expect(normalizeStatus('blocked')).toBe('blocked');
    expect(normalizeStatus('', { status: 'ok' })).toBe('completed');
    expect(normalizeStatus('working', undefined, 100)).toBe('completed');
  });

  test('history rows project and live wins on collision', () => {
    const h = historyRowToSubagent({ runId: 'h1', status: 'complete', startedAt: 10, endedAt: 20, childSessionKey: 'sk', coderBackend: 'claude-code' });
    expect(h).toMatchObject({ runId: 'h1', status: 'completed', sessionKey: 'sk', progress: 100, archived: true, coderBackend: 'claude-code' });
    expect(historyRowToSubagent({ runId: 'x' })).toBeNull();
    expect(historyRowToSubagent({ runId: 'e', endedAt: 5, error: 'boom' }).outcome).toEqual({ status: 'error', error: 'boom' });
    const merged = mergeLiveAndHistory(
      [{ runId: 'h1', status: 'working', lastUpdateAt: 30 }],
      [{ runId: 'h1', endedAt: 20 }, { runId: 'h2', endedAt: 40 }],
    );
    expect(merged.map((m) => m.runId)).toEqual(['h2', 'h1']);
    expect(merged[1].status).toBe('working');
  });

  test('projectSubagent computes duration, exit reason, overlay', () => {
    const review = normalizeReviewShape({ runId: 'r', filesTouched: ['a', 'b'] });
    const e = projectSubagent({ runId: 'r', status: 'error', createdAt: NOW - 60_000, endedAt: NOW - 1000, outcome: { status: 'error', error: ' crashed ' } }, review, NOW);
    expect(e.status).toBe('errored');
    expect(e.exitReason).toBe('crashed');
    expect(e.durationMs).toBe(59_000);
    expect(e.filesTouchedCount).toBe(2);
    expect(e.review).toBe(review);
    const live = projectSubagent({ runId: 'l', status: 'working', createdAt: NOW - 5000 }, undefined, NOW);
    expect(live.status).toBe('running');
    expect(live.durationMs).toBe(5000);
    expect(live.exitReason).toBeUndefined();
  });

  test('buildEntries applies the time window on finish time', () => {
    const live = [{ runId: 'new', status: 'done', endedAt: NOW - 1000, createdAt: NOW - 2000 }];
    const hist = [{ runId: 'old', status: 'complete', endedAt: NOW - 2 * 86_400_000, startedAt: NOW - 3 * 86_400_000 }];
    expect(buildEntries(live, hist, new Map(), 'all', NOW).map((e) => e.runId)).toEqual(['new', 'old']);
    expect(buildEntries(live, hist, new Map(), '24h', NOW).map((e) => e.runId)).toEqual(['new']);
  });

  test('entryFromReview builds a page for an aged-out run', () => {
    const e = entryFromReview(normalizeReviewShape({ runId: 'z', label: 'Z', status: 'errored', completedAt: 100, durationMs: 40 }));
    expect(e).toMatchObject({ runId: 'z', label: 'Z', status: 'errored', startedAt: 60, endedAt: 100 });
  });
});

describe('oversight filters', () => {
  const mk = (runId, status, review, extra = {}) => ({ runId, status, label: runId, task: '', sessionKey: '', endedAt: extra.endedAt || 1, lastUpdateAt: 1, createdAt: 1, review, ...extra });
  const entries = [
    mk('a', 'completed', normalizeReviewShape({ runId: 'a', decision: 'approved' }), { endedAt: 50 }),
    mk('b', 'completed', normalizeReviewShape({ runId: 'b', drift: true, blockers: ['x'] }), { endedAt: 40 }),
    mk('c', 'errored', undefined, { endedAt: 60, kanbanTaskId: 'TASK-9' }),
    mk('d', 'running', undefined, { endedAt: undefined, lastUpdateAt: 10, coderBackend: 'codex' }),
  ];
  const run = (f) => applyOversightFilters(entries, { ...DEFAULT_OVERSIGHT_FILTERS, ...f }).map((e) => e.runId);

  test('running first, then most recent', () => {
    expect(run({})).toEqual(['d', 'c', 'a', 'b']);
  });
  test('status / decision / drift / attention / project / search', () => {
    expect(run({ status: 'completed' })).toEqual(['a', 'b']);
    expect(run({ decision: 'approved' })).toEqual(['a']);
    expect(run({ decision: 'pending' })).toEqual(['b']);
    expect(run({ decision: 'drift' })).toEqual(['b']);
    expect(run({ hasBlockers: true })).toEqual(['c', 'b']);
    expect(run({ project: 'task-9' })).toEqual(['c']);
    expect(run({ search: 'codex' })).toEqual(['d']);
  });
  test('counts and clear (keeps decision + time like the web)', () => {
    const f = { ...DEFAULT_OVERSIGHT_FILTERS, status: 'errored', decision: 'drift', time: '1h', hasBlockers: true, project: 'p', search: 'q' };
    expect(countActiveOversightFilters(f)).toBe(5);
    expect(clearedOversightFilters(f)).toEqual({ ...f, status: 'all', hasBlockers: false, project: '', search: '' });
  });
});

describe('decision overlay guard', () => {
  test('a local decision survives a stale server list; in-flight absent runs keep overlay', () => {
    const prev = new Map([
      ['a', { runId: 'a', decision: 'approved', decidedAt: 200 }],
      ['b', { runId: 'b', decision: 'sent_back', decidedAt: 300 }],
    ]);
    const next = rebuildOverlay(prev, [{ runId: 'a', decision: 'pending' }, { runId: 'c' }], new Set(['b']));
    expect(next.get('a').decision).toBe('approved');
    expect(next.get('b').decision).toBe('sent_back');
    expect(next.get('c').runId).toBe('c');
    const settled = rebuildOverlay(prev, [{ runId: 'a', decision: 'approved', decidedAt: 250 }]);
    expect(settled.get('a').decidedAt).toBe(250);
    expect(settled.has('b')).toBe(false);
  });
  test('reviewFromResult / rpcFailure', () => {
    expect(reviewFromResult({ ok: true, review: { runId: 'x', confidence: 'low' } }).confidence).toBe(0.3);
    expect(reviewFromResult({ ok: false, error: 'nope' })).toBeNull();
    expect(rpcFailure({ ok: false, error: 'Run not found' }, 'x')).toBe('Run not found');
    expect(rpcFailure({ ok: true }, 'x')).toBeNull();
  });
});

describe('persistence (oversight:v1 snapshot)', () => {
  test('round trip + validation', () => {
    const snap = toPersisted({ ...DEFAULT_OVERSIGHT_FILTERS, status: 'errored', decision: 'drift', time: '7d' }, { r1: [0, 2] }, new Set(['r1']), 'oversight', 5);
    const back = parsePersisted(JSON.stringify(snap));
    expect(filtersFromPersisted(back)).toMatchObject({ status: 'errored', decision: 'drift', time: '7d' });
    expect(ackedFromPersisted(back)).toEqual({ r1: [0, 2] });
    expect(back.expandedIds).toEqual(['r1']);
    expect(back.tab).toBe('oversight');
    expect(parsePersisted('not json').filterStatus).toBe('all');
    expect(parsePersisted(JSON.stringify({ v: 2 })).tab).toBe('reviews');
    expect(parsePersisted(JSON.stringify({ v: 1, filterTime: 'forever', filterDecision: 'x', acked: [['a', ['bad']]] }))).toMatchObject({ filterTime: 'all', filterDecision: 'all', acked: [] });
  });
  test('toggleAck', () => {
    let a = toggleAck({}, 'r', 2);
    a = toggleAck(a, 'r', 0);
    expect(a.r).toEqual([0, 2]);
    expect(toggleAck(a, 'r', 2).r).toEqual([0]);
  });
});

describe('verdict + review thread', () => {
  test('tones and settled state', () => {
    expect(verdictTone('verified')).toBe('success');
    expect(verdictTone('rejected')).toBe('danger');
    expect(verdictTone('needs_owner')).toBe('warning');
    expect(verdictTone('weird')).toBe('neutral');
    expect(verdictBadgeTone('FAILED')).toBe('danger');
    expect(verdictBadgeTone('UNVERIFIED')).toBe('warning');
    expect(verdictSettled({ state: 'accepted' })).toBe(true);
    expect(verdictSettled({ state: 'unverified' })).toBe(false);
    expect(visibleEvidence({ evidence: [{ status: 'pass' }, { status: 'skipped' }] })).toHaveLength(1);
  });
  test('verification file URLs', () => {
    expect(verificationFileUrl('http://h:1', '/a b.png', true)).toBe('http://h:1/api/verification/file?path=%2Fa%20b.png&thumb=1');
    expect(verificationFileUrl('http://h:1', 'https://x/y.png')).toBe('https://x/y.png');
    expect(verificationFileUrl('', '/a.png')).toBe('');
  });
  test('thread normalisation pins the latest escalation and strips ANSI', () => {
    const t = normalizeThread({
      summary: { label: 'Job', verdict: null, state: 'needs_owner', rounds: 2 },
      messages: [
        { seq: 1, kind: 'submission', from: 'worker', to: 'reviewer', fromAgent: 'agent:main:subagent:abc', title: 'done', items: ['\u001b[2mx\u001b[22m'] },
        { seq: 2, kind: 'verdict', from: 'reviewer', to: 'worker', verdict: 'escalate', title: 'esc', escalation: { decision: 'Pick A', category: 'scope_change', reason: 'r' } },
      ],
    });
    expect(t.pinned.decision).toBe('Pick A');
    expect(t.messages[0].items).toEqual(['x']);
    expect(packetTone(t.messages[0])).toBe('primary');
    expect(packetTone(t.messages[1])).toBe('accent');
    expect(packetTone({ kind: 'challenge', evidence: [{ status: 'fail' }] })).toBe('danger');
    expect(messageRoute(t.messages[0], 'Job')).toEqual({ from: 'Job', to: 'Auditor' });
    expect(threadHeadline(t.summary)).toBe('Owner decision');
    expect(normalizeThread(null)).toBeNull();
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red');
  });
});

describe('run reviews (agents.reviews)', () => {
  const raw = [
    { id: '1', runId: 'r1', title: 'Alpha', agentKind: 'cli', status: 'built', built: true, startedAt: NOW - 10_000, finishedAt: NOW - 5000, summaryMarkdown: 'did **x**', projectId: 'proj-a' },
    { id: '2', runId: 'r2', title: 'Beta', status: 'not_built', startedAt: NOW - 3 * 86_400_000, finishedAt: NOW - 2 * 86_400_000, backend: 'codex' },
    { nothing: true },
  ];
  test('coerce + list + get', () => {
    const list = runReviewsFromList({ ok: true, reviews: raw });
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({ agentKind: 'agent', filesTouched: [], forwardActions: [], built: false });
    expect(coerceRunReview({ runId: 'x', built: true }).status).toBe('built');
    expect(runReviewFromResult({ ok: false, error: 'Review not found' })).toBeNull();
    expect(runReviewFromResult({ ok: true, review: raw[0] }).title).toBe('Alpha');
  });
  test('filters', () => {
    const list = runReviewsFromList(raw);
    const ids = (f) => applyRunReviewFilters(list, { status: 'all', time: 'all', search: '', project: '', ...f }, NOW).map((r) => r.runId);
    expect(ids({})).toEqual(['r1', 'r2']);
    expect(ids({ status: 'not_built' })).toEqual(['r2']);
    expect(ids({ time: '24h' })).toEqual(['r1']);
    expect(ids({ project: 'PROJ' })).toEqual(['r1']);
    expect(ids({ search: 'codex' })).toEqual(['r2']);
  });
  test('file rows, issues, actions', () => {
    expect(runFileRow({ path: 'a', action: 'modified', linesAdded: 0 })).toEqual({ path: 'a', kind: { glyph: 'M', tone: 'warning' }, added: null, removed: null });
    expect(runFileRow({ path: 'b', changeKind: 'add', linesAdded: 3, linesRemoved: 1 }).kind.glyph).toBe('A');
    expect(severityTone('critical')).toBe('danger');
    expect(severityTone('warning')).toBe('warning');
    expect(sortedActions([{ ts: 2 }, { ts: 1 }]).map((a) => a.ts)).toEqual([1, 2]);
  });
  test('forward action plans', () => {
    const rv = coerceRunReview(raw[0]);
    expect(forwardActionPlan(rv, { kind: 'verify', label: 'v', payload: { runId: 'r1' } })).toMatchObject({ type: 'rpc', method: 'subagent_review_force', confirm: false });
    expect(forwardActionPlan(rv, { kind: 'respawn' })).toMatchObject({ method: 'subagents.respawn', confirm: true, params: { runId: 'r1', id: '1' } });
    expect(forwardActionPlan(rv, { kind: 'open_pr', payload: { url: 'https://gh/pr/1' } })).toEqual({ type: 'url', url: 'https://gh/pr/1' });
    expect(forwardActionPlan(rv, { kind: 'followup', payload: { text: 't' } })).toMatchObject({ method: 'agents.reviews.followUp', fallback: 'chat' });
    expect(forwardActionPlan(rv, { kind: 'custom', payload: { method: 'x.y' } })).toMatchObject({ method: 'x.y' });
    expect(forwardActionPlan(rv, { kind: 'mystery' })).toEqual({ type: 'none' });
    expect(followUpDraft(rv, { label: 'L', payload: { text: 'fix tests' } })).toBe('Follow up on run r1 (Alpha): fix tests');
    expect(isUnknownMethodError(new Error('unknown method: agents.reviews.followUp'))).toBe(true);
  });
});

describe('proactive oversight jobs', () => {
  const jobs = [
    { id: '1', name: 'oversight-pulse', category: 'oversight:continuous', schedule: { kind: 'every', everyMs: 300000 } },
    { id: '2', name: 'oversight-brief', schedule: { kind: 'cron', expr: '0 7 * * *' } },
    { id: '3', name: 'oversight-weekly', schedule: { kind: 'cron', expr: '0 8 * * 1' } },
    { id: '4', name: 'oversight-monthly', schedule: { kind: 'cron', expr: '0 9 1 * *' } },
    { id: '5', name: 'backup', schedule: { kind: 'cron', expr: '0 1 * * *' } },
  ];
  test('selection, grouping, schedule text', () => {
    const mine = jobs.filter(isOversightJob);
    expect(mine).toHaveLength(4);
    expect(groupOversightJobs(mine).map((g) => g.key)).toEqual(['daily', 'weekly', 'monthly', 'continuous']);
    expect(fmtSchedule(jobs[0].schedule)).toBe('every 5m');
    expect(fmtSchedule({ kind: 'every', everyMs: 3_600_000 })).toBe('every 1h');
    expect(fmtWhen(NOW + 2 * 3_600_000, NOW)).toBe('in 2h');
    expect(fmtWhen(NOW - 5 * 60_000, NOW)).toBe('5m ago');
  });
});

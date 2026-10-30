import {
  compactNumber,
  fmtUsd,
  relTime,
  initials,
  sessionRows,
  toDisplayMessages,
  mergeMessages,
  applyChatEvent,
  reduceGroupEvent,
  groupRows,
  agentRows,
  topologicalLayers,
  validateWorkflow,
  starterWorkflow,
  emptyWorkflow,
  addStep,
  removeStep,
  updateStep,
  describeOrder,
  latestRun,
  runSummary,
  projectRows,
  taskRows,
  groupTasks,
  statusPatch,
  normalizeTaskStatus,
  activityModel,
  creditsModel,
  formatDbValue,
  dbRowPreview,
  dbRowDetail,
  chartSourceFor,
  candlesUrl,
  parseCandles,
  linePath,
  parseDexToken,
  terminalTail,
  terminalRows,
  employeeRows,
  auditRows,
  agencyRows,
} from '../screens/grid/grid-data';

const NOW = 1_800_000_000_000;

describe('formatting', () => {
  test('numbers, money, time, initials', () => {
    expect(compactNumber(85290447)).toBe('85.29M');
    expect(compactNumber(1500)).toBe('1.5k');
    expect(compactNumber('x')).toBe('-');
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(1234.5)).toBe('$1,235');
    expect(relTime(NOW - 30_000, NOW)).toBe('just now');
    expect(relTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(relTime(NOW - 3 * 3600_000, NOW)).toBe('3h ago');
    expect(relTime(0, NOW)).toBe('');
    expect(initials('Atlas Prime')).toBe('AP');
    expect(initials('🚀 Dev')).toBe('DE');
  });
});

describe('sessions', () => {
  test('rows newest first, group chats excluded, emoji stripped', () => {
    const rows = sessionRows({
      sessions: [
        { key: 'agent:main:a', label: '💬 Alpha', updatedAt: 1 },
        { key: 'agent:main:groupchat-x', label: 'G', updatedAt: 9 },
        { key: 'agent:main:b', updatedAt: 5 },
      ],
    });
    expect(rows.map((r) => r.key)).toEqual(['agent:main:b', 'agent:main:a']);
    expect(rows[1].title).toBe('Alpha');
    expect(rows[0].title).toBe('b');
  });
});

describe('group chat (logic.ts port)', () => {
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'hi all' }], timestamp: 1, groupChat: { messageId: 'm1' } },
    { role: 'assistant', content: 'hello', timestamp: 2, groupChat: { messageId: 'm2', agentId: 'dev', agentName: 'DEV' } },
    { role: 'assistant', content: 'Workflow started', timestamp: 3, groupChat: { messageId: 'm3', kind: 'status', workflowRunId: 'r1' } },
    { role: 'assistant', content: '', timestamp: 4 },
  ];

  test('history → attributed display messages', () => {
    const msgs = toDisplayMessages(history);
    expect(msgs.map((m) => m.kind)).toEqual(['user', 'agent', 'status']);
    expect(msgs[1]).toMatchObject({ agentId: 'dev', agentName: 'DEV', text: 'hello' });
    expect(msgs[2].workflowRunId).toBe('r1');
    expect(mergeMessages(msgs, toDisplayMessages(history.slice(0, 1)))).toBe(msgs);
  });

  test('live turns stream deltas only for their member session', () => {
    const turns = new Map([['run1', { runId: 'run1', agentId: 'dev', memberKey: 'agent:dev:g', text: '' }]]);
    expect(applyChatEvent(turns, { runId: 'zzz', state: 'delta' })).toBe(turns);
    expect(applyChatEvent(turns, { runId: 'run1', sessionKey: 'other', state: 'delta', message: { content: 'x' } })).toBe(turns);
    const next = applyChatEvent(turns, { runId: 'run1', sessionKey: 'agent:dev:g', state: 'delta', message: { content: [{ type: 'text', text: 'typing' }] } });
    expect(next.get('run1').text).toBe('typing');
  });

  test('groupchat events reduce into messages / live / refresh flags', () => {
    let st = { messages: [], live: new Map(), ended: new Map(), roundActive: false, group: { runs: [] } };
    st = reduceGroupEvent(st, { type: 'turn.start', runId: 'r', agentId: 'dev', memberKey: 'k' });
    expect(st.live.size).toBe(1);
    expect(st.roundActive).toBe(true);
    st = reduceGroupEvent(st, { type: 'turn.end', runId: 'r' }, 10);
    st = reduceGroupEvent(st, { type: 'message', message: history[1] });
    expect(st.messages).toHaveLength(1);
    expect(st.live.size).toBe(0);
    st = reduceGroupEvent(st, { type: 'workflow', run: { id: 'w1', status: 'done', steps: [] } });
    expect(st.group.runs).toHaveLength(1);
    expect(st.refresh).toBe(true);
    expect(reduceGroupEvent(st, { type: 'nope' })).toBe(st);
  });

  test('group + agent rows', () => {
    expect(groupRows({ sessions: [{ key: 'agent:main:groupchat-1', label: 'Team' }, { key: 'agent:main:x' }] })).toEqual([{ key: 'agent:main:groupchat-1', title: 'Team', updatedAt: 0 }]);
    expect(agentRows({ agents: [{ id: 'coder', name: 'DEV' }, { id: 'ceo', identity: { name: '👑 Atlas' } }] })).toEqual([{ id: 'coder', name: 'DEV' }, { id: 'ceo', name: 'Atlas' }]);
  });
});

describe('workflows (workflow-graph port)', () => {
  test('starter workflow is valid and layered Plan -> Build -> Review', () => {
    const g = starterWorkflow(['a', 'b', 'c']);
    expect(validateWorkflow(g, { members: ['a', 'b', 'c'] }).valid).toBe(true);
    expect(topologicalLayers(g).map((l) => l.map((n) => n.label))).toEqual([['Plan'], ['Build'], ['Review']]);
    expect(describeOrder(g, (n) => n.label)).toBe('Plan -> Build -> Review');
  });

  test('validation catches empty, non-members and cycles', () => {
    expect(validateWorkflow(emptyWorkflow('x')).errors).toContain('Add at least one agent step');
    const g = starterWorkflow(['a']);
    expect(validateWorkflow(g, { members: ['z'] }).valid).toBe(false);
    const cyc = { ...g, edges: [...g.edges, { id: 'back', sourceId: g.nodes[2].id, targetId: g.nodes[0].id }] };
    expect(validateWorkflow(cyc).errors.join(' ')).toMatch(/cycle/);
    expect(describeOrder(cyc, (n) => n.label)).toBe('');
  });

  test('addStep sequential and parallel, removeStep relinks, updateStep patches', () => {
    let g = starterWorkflow(['a', 'b', 'c']);
    const build = g.nodes[1];
    g = addStep(g, 'b', { afterId: build.id, parallel: true, label: 'Tests' });
    expect(describeOrder(g, (n) => n.label)).toBe('Plan -> (Build || Tests) -> Review');
    g = addStep(g, 'c', { label: 'Ship' });
    expect(describeOrder(g, (n) => n.label)).toBe('Plan -> (Build || Tests) -> Review -> Ship');
    g = removeStep(g, g.nodes.find((n) => n.label === 'Review').id);
    expect(describeOrder(g, (n) => n.label)).toBe('Plan -> (Build || Tests) -> Ship');
    g = updateStep(g, build.id, { prompt: 'do it' });
    expect(g.nodes.find((n) => n.id === build.id).prompt).toBe('do it');
    expect(validateWorkflow(g).valid).toBe(true);
    expect(describeOrder(addStep(emptyWorkflow(), 'a', { label: 'Solo' }), (n) => n.label)).toBe('Solo');
  });

  test('latest run + summary', () => {
    const g = { id: 'wf1' };
    const runs = [
      { id: 'r1', workflowId: 'wf1', status: 'done', steps: [] },
      { id: 'r2', workflowId: 'wf1', status: 'running', steps: [{ status: 'done' }, { status: 'running' }] },
      { id: 'r3', workflowId: 'other', status: 'done', steps: [] },
    ];
    expect(latestRun(g, runs).id).toBe('r2');
    expect(runSummary(latestRun(g, runs))).toBe('1/2 steps');
    expect(runSummary(runs[0])).toBe('done');
  });
});

describe('kanban', () => {
  const projects = [
    { id: 'p1', name: '🤖 Bot', status: 'In progress', type: ['AI Projects'], progress: 40, updatedAt: 5 },
    { id: 'p2', name: 'Old', status: 'Completed', type: [], progress: 100, updatedAt: 9 },
    { id: 'p3', name: 'Next', status: 'Not started', type: [], updatedAt: 7 },
    { id: 'p4', name: 'Arch', status: 'Not started', archived: true },
  ];

  test('filters + ordering', () => {
    expect(projectRows(projects, 'active').map((p) => p.id)).toEqual(['p1', 'p3']);
    expect(projectRows(projects, 'ai').map((p) => p.id)).toEqual(['p1']);
    expect(projectRows(projects, 'completed').map((p) => p.id)).toEqual(['p2']);
    expect(projectRows(projects, 'all').map((p) => p.id)).toEqual(['p1', 'p3', 'p4', 'p2']);
    expect(projectRows(projects, 'all', 'nex').map((p) => p.id)).toEqual(['p3']);
    expect(projectRows(projects, 'active')[0].name).toBe('Bot');
  });

  test('tasks normalize + group by column, status patch keeps done in sync', () => {
    const tasks = taskRows([
      { id: 't1', title: 'A', status: 'todo', rank: 2 },
      { id: 't2', title: 'B', status: 'In Progress' },
      { id: 't3', title: '📝 C', status: 'done', done: true },
      { id: 't4', title: 'D', status: 'reviewing' },
      { id: 't5', title: 'E', status: 'todo', rank: 1 },
    ]);
    const g = groupTasks(tasks);
    expect(g.todo.map((t) => t.id)).toEqual(['t5', 't1']);
    expect(g.in_progress.map((t) => t.id)).toEqual(['t2']);
    expect(g.review.map((t) => t.id)).toEqual(['t4']);
    expect(g.done[0].title).toBe('C');
    expect(statusPatch('done')).toEqual({ status: 'done', done: true });
    expect(statusPatch('review')).toEqual({ status: 'review', done: false });
    expect(normalizeTaskStatus('Awaiting Response')).toBe('review');
  });
});

describe('activity', () => {
  test('running vs finished sub-agents; live sessions', () => {
    const m = activityModel(
      {
        subagents: [
          { runId: 'a', label: 'Build it', status: 'working', lastUpdateAt: NOW - 1000, recentUpdates: [{ message: 'Write: x.js', timestamp: NOW - 1000 }] },
          { runId: 'b', label: 'Old', status: 'completed', lastUpdateAt: NOW - 50000 },
        ],
      },
      { sessions: [{ key: 'agent:main:main', updatedAt: NOW - 1000 }, { key: 'agent:main:subagent:x', updatedAt: NOW }, { key: 'agent:main:old', updatedAt: NOW - 3600_000 }] },
      NOW,
    );
    expect(m.running.map((r) => r.id)).toEqual(['a']);
    expect(m.running[0].lastMessage).toBe('Write: x.js');
    expect(m.finished.map((r) => r.id)).toEqual(['b']);
    expect(m.sessions.map((s) => s.key)).toEqual(['agent:main:main', 'agent:main:old']);
    expect(m.liveSessions).toBe(1);
  });
});

describe('credits', () => {
  test('falls back to request share when every cost is zero', () => {
    const m = creditsModel({
      totalRequests: 10,
      totalCostUsd: 0,
      totalTokensIn: 100,
      totalTokensOut: 50,
      byProvider: [
        { provider: 'openai', tokensIn: 10, tokensOut: 5, requests: 2, costUsd: 0 },
        { provider: 'anthropic', tokensIn: 90, tokensOut: 45, requests: 8, costUsd: 0 },
      ],
      byBackend: [{ agentBackend: 'direct-api', requests: 3 }, { agentBackend: 'claude-code', requests: 7 }],
    });
    expect(m.shareBy).toBe('requests');
    expect(m.providers[0]).toMatchObject({ provider: 'anthropic', share: 0.8 });
    expect(m.backends.map((b) => b.key)).toEqual(['claude-code', 'direct-api']);
    const paid = creditsModel({ byProvider: [{ provider: 'a', costUsd: 3, requests: 1 }, { provider: 'b', costUsd: 1, requests: 9 }] });
    expect(paid.shareBy).toBe('cost');
    expect(paid.providers[0]).toMatchObject({ provider: 'a', share: 0.75 });
  });
});

describe('databases', () => {
  const props = [
    { id: 'p0', name: 'Name', type: 'title', sortOrder: 0 },
    { id: 'p1', name: 'Status', type: 'status', sortOrder: 1, config: { options: [{ id: 'o1', name: '✅ Done' }] } },
    { id: 'p2', name: 'Due', type: 'date', sortOrder: 2 },
    { id: 'p3', name: 'Tags', type: 'multiSelect', sortOrder: 3, config: { options: [{ id: 'a', name: 'x' }, { id: 'b', name: 'y' }] } },
    { id: 'p4', name: 'Hidden', type: 'number', sortOrder: 4, hidden: true },
  ];
  const row = { id: 'r1', title: 'Row', values: { p1: { type: 'status', optionId: 'o1' }, p2: { type: 'date', iso: '2026-10-14T00:00:00Z' }, p3: { type: 'multiSelect', optionIds: ['a', 'b'] }, p4: { type: 'number', value: 3 } } };

  test('value formatting covers the union', () => {
    expect(formatDbValue(props[1], row.values.p1)).toBe('Done');
    expect(formatDbValue(null, { type: 'checkbox', checked: true })).toBe('Yes');
    expect(formatDbValue(null, { type: 'relation', rowIds: ['a', 'b'] })).toBe('2 linked');
    expect(formatDbValue(null, { type: 'files', files: [{}] })).toBe('1 file');
    expect(formatDbValue(null, null)).toBe('');
  });

  test('preview uses visible non-title props in order; detail lists all', () => {
    expect(dbRowPreview(row, props).chips).toEqual([
      { label: 'Status', value: 'Done' },
      { label: 'Due', value: '2026-10-14' },
      { label: 'Tags', value: 'x, y' },
    ]);
    expect(dbRowDetail(row, props).map((d) => d.label)).toEqual(['Status', 'Due', 'Tags', 'Hidden']);
  });
});

describe('chart', () => {
  test('symbol → candle source', () => {
    expect(chartSourceFor('BINANCE:BTCUSDT')).toEqual({ kind: 'binance', pair: 'BTCUSDT' });
    expect(chartSourceFor('COINBASE:ETHUSD')).toEqual({ kind: 'coinbase', product: 'ETH-USD' });
    expect(chartSourceFor('NASDAQ:AAPL')).toBeNull();
    expect(chartSourceFor('junk')).toBeNull();
    expect(candlesUrl({ kind: 'binance', pair: 'BTCUSDT' }, '1d')).toContain('interval=15m&limit=96');
    expect(candlesUrl({ kind: 'coinbase', product: 'ETH-USD' }, '3m', NOW)).toContain('/products/ETH-USD/candles?granularity=86400');
    expect(candlesUrl(null)).toBeNull();
  });

  test('candles parse ascending and draw a path', () => {
    const b = parseCandles({ kind: 'binance' }, [[1, '1', '2', '0', '10'], [2, '1', '2', '0', '12']]);
    expect(b).toEqual([{ t: 1, c: 10 }, { t: 2, c: 12 }]);
    const c = parseCandles({ kind: 'coinbase' }, [[20, 0, 0, 0, 5], [10, 0, 0, 0, 4]]);
    expect(c.map((p) => p.c)).toEqual([4, 5]);
    const lp = linePath(b, 100, 50);
    expect(lp.d.startsWith('M6.0 44.0')).toBe(true);
    expect(lp.changePct).toBeCloseTo(20);
    expect(linePath([{ c: 1 }], 100, 50)).toBeNull();
  });

  test('DexScreener picks the most liquid pair', () => {
    const t = parseDexToken({ pairs: [
      { baseToken: { symbol: 'AAA', name: 'A' }, priceUsd: '0.5', liquidity: { usd: 10 }, priceChange: { h24: 3 } },
      { baseToken: { symbol: 'BBB', name: 'B' }, priceUsd: '1.5', liquidity: { usd: 99 }, priceChange: { h24: -2, h1: 1 }, volume: { h24: 7 } },
    ] });
    expect(t).toMatchObject({ symbol: 'BBB', priceUsd: 1.5, volume24h: 7 });
    expect(t.changes.find((x) => x.key === 'h24').pct).toBe(-2);
    expect(parseDexToken({ pairs: [] })).toBeNull();
  });
});

describe('terminal', () => {
  test('ANSI stripped tail', () => {
    const buf = '\x1b[?1049h\x1b[32mhello\x1b[0m\r\nworld\r\n\r\n';
    expect(terminalTail(buf)).toBe('hello\nworld');
    expect(terminalTail('a\nb\nc', 2)).toBe('b\nc');
  });

  test('rows: claude mode string flag, newest first', () => {
    const rows = terminalRows({ terminals: [
      { id: 'a', title: 'T1', isClaudeMode: 'False', lastActiveAt: '2026-10-14T08:00:00Z' },
      { id: 'b', title: 'T2', isClaudeMode: 'True', lastActiveAt: '2026-10-14T09:00:00Z' },
    ] });
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(rows[0].cli).toBe('claude');
    expect(rows[1].cli).toBe('shell');
  });
});

describe('agency ops', () => {
  test('agencies, employees, audit rows', () => {
    expect(agencyRows({ agencies: [{ id: 'a', name: 'K', role: 'owner' }] })).toEqual([{ id: 'a', name: 'K', role: 'owner' }]);
    const e = employeeRows({ employees: [{ id: 'x', name: 'Atlas', kind: 'ai', utilizationPercent: 140, role: 'CEO' }] });
    expect(e[0]).toMatchObject({ kind: 'AI', utilization: 100 });
    expect(auditRows({ events: [{ id: 1, entityType: 'invoice', action: 'payment_link_attached', createdAt: 5 }] })[0].title).toBe('invoice payment link attached');
  });
});

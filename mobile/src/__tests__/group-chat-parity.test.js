/**
 * Parity: the mobile group-chat logic (src/chat/group/*) is a JS mirror of the
 * repo's shared TypeScript (src/shared/group-chat/*) and the web view logic
 * (ui/src/ui/features/group_chat/logic.ts). Both run on the same inputs here.
 */
const M = require('../chat/group/group-logic');
const MW = require('../chat/group/workflow-logic');
const keys = require('../../../src/shared/group-chat/keys.ts');
const planner = require('../../../src/shared/group-chat/planner.ts');
const wg = require('../../../src/shared/group-chat/workflow-graph.ts');
const web = require('../../../ui/src/ui/features/group_chat/logic.ts');

const members = [
  { id: 'main', name: 'Infini Bot' },
  { id: 'coder', name: 'Head of Dev' },
  { id: 'qa', name: 'QA' },
];

describe('keys parity', () => {
  const samples = [
    'agent:main:groupchat-mv7zfz921x6k', 'agent:coder:gcmember-mv7zfz921x6k', 'agent:main:webchat-abc',
    'agent:main:groupchat-', 'groupchat-x', '', null, undefined, 'agent:main:gcmember-', 'agent:x:groupchat-a:b',
  ];
  test.each(samples)('%s', (k) => {
    expect(M.isGroupChatKey(k)).toBe(keys.isGroupChatKey(k));
    expect(M.isGroupMemberKey(k)).toBe(keys.isGroupMemberKey(k));
    expect(M.groupIdFromKey(k)).toBe(keys.groupIdFromKey(k));
  });
});

describe('planner parity', () => {
  const texts = [
    'hello team', 'hey @coder can you look', '@qa and @main', '@all please', '@everyone', 'mail me@coder.com',
    '@head-of-dev ship it', '@infini what now', '@Coder_ trailing', '(@qa) inside parens', '@nobody here', '',
    '@main @main twice', 'a@qa no', '@here',
  ];
  test.each(texts)('mentions: %s', (t) => {
    expect(M.parseMentions(t, members)).toEqual(planner.parseMentions(t, members));
  });
  test.each(['Head of Dev', 'QA  team!!', '--x--', 'Ünïcode Name'])('slug %s', (v) => {
    expect(M.mentionSlug(v)).toBe(planner.mentionSlug(v));
  });
  for (const mode of ['everyone', 'round-robin', 'moderator']) {
    test.each(texts)(`planRound ${mode}: %s`, (t) => {
      for (const rr of [0, 1, 2, 5]) {
        const p = { text: t, members, mode, moderatorId: 'coder', rrIndex: rr };
        expect(M.planRound(p)).toEqual(planner.planRound(p));
      }
    });
  }
  test.each(['', '  ', 'NO_REPLY', 'NO_REPLY.', 'HEARTBEAT_OK!', 'real reply', 'NO_REPLY but more'])('isPassReply %s', (t) => {
    expect(M.isPassReply(t)).toBe(planner.isPassReply(t));
  });
});

describe('web view-logic parity', () => {
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'hi all' }], timestamp: 1, groupChat: { messageId: 'u1', kind: 'user' } },
    { role: 'assistant', content: [{ type: 'text', text: 'hello from coder' }], timestamp: 2, groupChat: { messageId: 'a1', kind: 'agent', agentId: 'coder', agentName: 'Head of Dev' } },
    { role: 'assistant', content: 'plain string', timestamp: 3 },
    { role: 'user', content: [{ type: 'text', text: 'Workflow started' }], timestamp: 4, groupChat: { messageId: 's1', kind: 'status', workflowRunId: 'r1', workflowId: 'w1' } },
    { role: 'assistant', content: [{ type: 'text', text: '  ' }], timestamp: 5 },
    { role: 'assistant', content: [{ type: 'text', text: 'boom' }], timestamp: 6, groupChat: { messageId: 'e1', kind: 'agent', agentId: 'qa', error: true, workflowRunId: 'r1' } },
    null, 'x', { role: 'tool', content: 'ignored' },
  ];
  test('toDisplayMessages', () => {
    expect(M.toDisplayMessages(history)).toEqual(web.toDisplayMessages(history));
  });
  test('filterMessages', () => {
    const msgs = web.toDisplayMessages(history);
    for (const f of [null, { runId: 'r1' }, { workflowId: 'w1' }, { runId: 'zz' }]) {
      expect(M.filterMessages(msgs, f)).toEqual(web.filterMessages(msgs, f));
    }
  });
  test('mentionQueryAt / suggestMembers / applyMention', () => {
    for (const [text, caret] of [['hi @co', 6], ['@', 1], ['email a@b', 9], ['(@q', 3], ['hi @coder and', 9], ['no mention', 10]]) {
      expect(M.mentionQueryAt(text, caret)).toEqual(web.mentionQueryAt(text, caret));
    }
    for (const q of ['', 'c', 'q', 'a', 'dev', 'zz', 'e']) {
      expect(M.suggestMembers(members, q)).toEqual(web.suggestMembers(members, q));
    }
    expect(M.applyMention('hi @co  rest', 3, 6, 'coder')).toEqual(web.applyMention('hi @co  rest', 3, 6, 'coder'));
  });
  test('avatars', () => {
    for (const id of ['main', 'coder', 'qa', '', 'Ünï']) expect(M.agentHue(id)).toBe(web.agentHue(id));
    for (const n of ['Infini Bot', 'qa', 'Head-of Dev', '', '🤖 Robo', 'Ünïcode Name']) expect(M.initials(n)).toBe(web.initials(n));
  });
  test('MODE_LABELS label + hint', () => {
    for (const k of Object.keys(web.MODE_LABELS)) {
      expect(M.MODE_LABELS[k].label).toBe(web.MODE_LABELS[k].label);
      expect(M.MODE_LABELS[k].hint).toBe(web.MODE_LABELS[k].hint);
    }
  });
  test('applyChatEvent (object vs Map)', () => {
    const turn = { runId: 'r', agentId: 'coder', memberKey: 'agent:coder:gcmember-x', text: '' };
    const evts = [
      { runId: 'r', sessionKey: turn.memberKey, state: 'delta', message: { content: [{ type: 'text', text: 'hel' }] } },
      { runId: 'r', sessionKey: 'agent:other:x', state: 'delta', message: { content: 'no' } },
      { runId: 'zz', state: 'delta', message: { content: 'no' } },
      { runId: 'r', state: 'final', message: { content: 'done' } },
    ];
    for (const e of evts) {
      const a = M.applyChatEvent({ r: turn }, e);
      const b = web.applyChatEvent(new Map([['r', turn]]), e);
      expect(a.r).toEqual(b.get('r'));
    }
  });
  test('runLabel', () => {
    const run = { id: 'r', workflowId: 'w', workflowName: 'Ship', status: 'running', input: '', startedAt: 0, steps: [{ status: 'done' }, { status: 'running' }] };
    expect(M.runLabel(run)).toBe(web.runLabel(run));
    expect(M.runLabel({ ...run, status: 'done' })).toBe(web.runLabel({ ...run, status: 'done' }));
  });
});

describe('workflow-graph parity', () => {
  const g = {
    id: 'wf-1', name: 'Mixed',
    nodes: [
      { id: 'a', agentId: 'main', x: 0, y: 0, parentId: null },
      { id: 'b', agentId: 'coder', x: 0, y: 0, parentId: 'a' },
      { id: 'c', agentId: 'qa', x: 0, y: 0, parentId: null },
      { id: 'd', agentId: 'qa', x: 0, y: 0, parentId: null },
    ],
    edges: [{ id: 'e1', sourceId: 'a', targetId: 'c' }, { id: 'e2', sourceId: 'b', targetId: 'd' }, { id: 'e3', sourceId: 'c', targetId: 'd' }],
  };
  const ids = (layers) => layers.map((l) => l.map((n) => n.id));
  test('dependencyPairs / layers / validate / cycles / layout / order', () => {
    expect(MW.dependencyPairs(g)).toEqual(wg.dependencyPairs(g));
    expect(ids(MW.topologicalLayers(g))).toEqual(ids(wg.topologicalLayers(g)));
    expect(MW.validateWorkflow(g, { members: ['main', 'coder', 'qa'] })).toEqual(wg.validateWorkflow(g, { members: ['main', 'coder', 'qa'] }));
    expect(MW.validateWorkflow(g, { members: ['main'] })).toEqual(wg.validateWorkflow(g, { members: ['main'] }));
    expect(MW.validateWorkflow({ ...g, name: ' ', nodes: [] })).toEqual(wg.validateWorkflow({ ...g, name: ' ', nodes: [] }));
    for (const [s, t] of [['d', 'a'], ['a', 'd'], ['c', 'b'], ['a', 'a']]) {
      expect(MW.wouldCreateCycle(g, s, t)).toBe(wg.wouldCreateCycle(g, s, t));
    }
    expect(MW.autoLayout(g)).toEqual(wg.autoLayout(g));
    expect(MW.removeNode(g, 'a')).toEqual(wg.removeNode(g, 'a'));
    const cyc = { ...g, edges: [...g.edges, { id: 'x', sourceId: 'd', targetId: 'a' }] };
    expect(() => MW.topologicalLayers(cyc)).toThrow(/cycle/);
    expect(MW.validateWorkflow(cyc)).toEqual(wg.validateWorkflow(cyc));
  });
  test('a mobile-built graph is accepted unchanged by the gateway normalizer', () => {
    let { stages } = MW.addStep([], 'main', { label: 'Plan', prompt: 'plan it' });
    ({ stages } = MW.addStep(stages, 'coder'));
    ({ stages } = MW.addStep(stages, 'qa', { parallelWith: 1 }));
    ({ stages } = MW.addStep(stages, 'main', { label: 'Wrap' }));
    const graph = MW.stagesToGraph({ id: 'wf-m', name: 'Mobile', nodes: [], edges: [] }, stages);
    const norm = wg.normalizeWorkflow(graph);
    const strip = (x) => ({ ...x, updatedAt: undefined });
    expect(strip(norm)).toEqual(strip({ ...graph, nodes: graph.nodes.map((n) => ({ ...n, label: n.label, prompt: n.prompt })) }));
    expect(wg.validateWorkflow(norm, { members: ['main', 'coder', 'qa'] }).valid).toBe(true);
    expect(ids(wg.topologicalLayers(norm))).toEqual(stages.map((s) => s.map((n) => n.id)));
  });
  test('starterWorkflow matches the web template text', () => {
    // builder-logic.ts can't be required here (its `.js` import of a .ts sibling),
    // so compare against its source text instead.
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../../ui/src/ui/features/workflow_builder/builder-logic.ts'), 'utf8');
    const a = MW.starterWorkflow(['main', 'coder', 'qa']);
    expect(src).toContain(`emptyWorkflow("${a.name}")`);
    for (const n of a.nodes) {
      expect(src).toContain(`label: "${n.label}", prompt: "${n.prompt}"`);
    }
    expect(a.edges.map((e) => [e.sourceId, e.targetId])).toEqual([[a.nodes[0].id, a.nodes[1].id], [a.nodes[1].id, a.nodes[2].id]]);
  });
});

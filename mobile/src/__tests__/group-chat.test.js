/**
 * Mobile group chat: message attribution, @mentions, the groupchat event
 * reducer and the touch workflow builder.
 */
import {
  appendMention, applyGroupRefresh, cardRun, emptyGroupState, expireTurn, isGroupBusy, loadedGroupState,
  memberInfos, reduceGroupEvent, replyHint, rosterName, toDisplayMessages, applyChatEvent, agentColor,
} from '../chat/group/group-logic';
import {
  addStep, dragTargetIndex, graphToStages, isStageShaped, moveStage, removeStep, runOptions, stagesToGraph,
  toggleParallel, updateStep, validateWorkflow, describeOrder, nodeStatuses,
} from '../chat/group/workflow-logic';
import { isChatSessionKey, mergeSessions, sessionTitle } from '../chat/session-sync';

const KEY = 'agent:main:groupchat-abc123';
const agents = [
  { id: 'main', identity: { name: 'Infini' } },
  { id: 'coder', name: 'Coder' },
  { id: 'qa', identity: { name: 'QA Lead', avatarUrl: 'https://x/qa.png' } },
];
const group = {
  key: KEY, title: 'Crew', mode: 'everyone', moderatorId: 'main', workflows: [], runs: [], busy: false, activeTurns: [],
  members: [{ id: 'main', name: 'main' }, { id: 'coder', name: 'coder' }, { id: 'qa', name: 'qa' }],
};
const agentMsg = (id, agentId, text) => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 10, groupChat: { messageId: id, kind: 'agent', agentId, agentName: agentId } });

describe('attribution', () => {
  test('agent messages keep their speaker; user + status are separate kinds', () => {
    const msgs = toDisplayMessages([
      { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1, groupChat: { messageId: 'u', kind: 'user' } },
      agentMsg('a', 'coder', 'on it'),
      { role: 'user', content: [{ type: 'text', text: 'Workflow "Ship" started' }], groupChat: { messageId: 's', kind: 'status', workflowRunId: 'r1' } },
    ]);
    expect(msgs.map((m) => [m.kind, m.agentId ?? null])).toEqual([['user', null], ['agent', 'coder'], ['status', null]]);
  });
  test('roster names win over member ids; avatars carry through', () => {
    const infos = memberInfos(group, agents);
    expect(infos.map((m) => m.name)).toEqual(['Infini', 'Coder', 'QA Lead']);
    expect(infos[2].avatarUrl).toBe('https://x/qa.png');
    expect(rosterName(agents, 'ghost', 'Ghost')).toBe('Ghost');
  });
  test('each agent gets a stable colour', () => {
    expect(agentColor('coder')).toBe(agentColor('coder'));
    expect(agentColor('coder')).not.toBe(agentColor('qa'));
  });
});

describe('mentions', () => {
  const members = memberInfos(group, agents);
  test('quick-mention chips append with one space', () => {
    expect(appendMention('', 'qa')).toBe('@qa ');
    expect(appendMention('hey', 'qa')).toBe('hey @qa ');
    expect(appendMention('hey ', 'qa')).toBe('hey @qa ');
  });
  test('reply hint follows the gateway planner', () => {
    expect(replyHint('hello', group, members)).toBe('Everyone replies in turn');
    expect(replyHint('@qa check this', group, members)).toBe('Only QA Lead will reply');
    expect(replyHint('@coder and @infini', group, members)).toBe('Only Coder, Infini will reply');
    expect(replyHint('x', { ...group, mode: 'moderator', moderatorId: 'coder' }, members)).toBe('Coder leads');
    expect(replyHint('x', { ...group, mode: 'round-robin' }, members)).toBe('Next agent in the rotation replies');
  });
});

describe('groupchat event reducer', () => {
  const start = loadedGroupState(group, []);
  const ev = (e) => ({ groupKey: KEY, ...e });
  test('other groups are ignored', () => {
    const r = reduceGroupEvent(start, { type: 'turn.start', groupKey: 'agent:main:groupchat-other', runId: 'r' }, KEY);
    expect(r.state).toBe(start);
  });
  test('a full turn: start → stream → end → message replaces the bubble', () => {
    let s = reduceGroupEvent(start, ev({ type: 'round.start', agents: ['coder'] }), KEY).state;
    expect(s.roundActive).toBe(true);
    s = reduceGroupEvent(s, ev({ type: 'turn.start', agentId: 'coder', memberKey: 'agent:coder:gcmember-abc123', runId: 'r1' }), KEY).state;
    expect(Object.keys(s.live)).toEqual(['r1']);
    s = { ...s, live: applyChatEvent(s.live, { runId: 'r1', sessionKey: 'agent:coder:gcmember-abc123', state: 'delta', message: { content: [{ type: 'text', text: 'Work' }] } }) };
    expect(s.live.r1.text).toBe('Work');
    const ended = reduceGroupEvent(s, ev({ type: 'turn.end', agentId: 'coder', runId: 'r1', ok: true }), KEY);
    expect(ended.effects).toEqual([{ type: 'expire', runId: 'r1', delay: 2500 }]);
    s = reduceGroupEvent(ended.state, ev({ type: 'message', message: agentMsg('m1', 'coder', 'Working on it') }), KEY).state;
    expect(s.live).toEqual({});
    expect(s.messages.map((m) => m.text)).toEqual(['Working on it']);
    // the expiry timer firing later is a no-op
    expect(expireTurn(s, 'r1')).toBe(s);
    const end = reduceGroupEvent(s, ev({ type: 'round.end' }), KEY);
    expect(end.effects).toEqual([{ type: 'refresh', delay: 150 }]);
    expect(isGroupBusy(applyGroupRefresh(end.state, { ...group, busy: false }))).toBe(false);
  });
  test('a passing agent (turn.end not ok) expires fast; parallel turns stream independently', () => {
    let s = reduceGroupEvent(start, ev({ type: 'turn.start', agentId: 'main', memberKey: 'm', runId: 'a' }), KEY).state;
    s = reduceGroupEvent(s, ev({ type: 'turn.start', agentId: 'qa', memberKey: 'q', runId: 'b' }), KEY).state;
    const r = reduceGroupEvent(s, ev({ type: 'turn.end', agentId: 'qa', runId: 'b', ok: false }), KEY);
    expect(r.effects[0].delay).toBe(300);
    s = expireTurn(r.state, 'b');
    expect(Object.keys(s.live)).toEqual(['a']);
  });
  test('duplicate messages (event + mirrored chat final + resync) are deduped', () => {
    let s = reduceGroupEvent(start, ev({ type: 'message', message: agentMsg('m1', 'qa', 'ok') }), KEY).state;
    s = reduceGroupEvent(s, ev({ type: 'message', message: agentMsg('m1', 'qa', 'ok') }), KEY).state;
    expect(s.messages).toHaveLength(1);
  });
  test('workflow run updates replace by id and drive the run card', () => {
    const run = { id: 'r1', workflowId: 'w', workflowName: 'Ship', status: 'running', startedAt: 1, steps: [{ nodeId: 'n', agentId: 'qa', status: 'running', layer: 0 }] };
    let s = reduceGroupEvent(start, ev({ type: 'workflow', run }), KEY).state;
    expect(s.roundActive).toBe(true);
    expect(cardRun(s.group, null).id).toBe('r1');
    const done = reduceGroupEvent(s, ev({ type: 'workflow', run: { ...run, status: 'done' } }), KEY);
    expect(done.state.group.runs).toHaveLength(1);
    expect(done.effects[0].type).toBe('refresh');
    expect(cardRun(done.state.group, null)).toBe(null);
    expect(cardRun(done.state.group, 'r1').status).toBe('done');
  });
  test('reconnect resync restores turns that were already running', () => {
    const s = loadedGroupState({ ...group, busy: true, activeTurns: [{ runId: 'x', agentId: 'qa', memberKey: 'q' }] }, [agentMsg('m', 'main', 'hi')]);
    expect(s.roundActive).toBe(true);
    expect(s.live.x.text).toBe('');
    expect(s.messages).toHaveLength(1);
    expect(isGroupBusy(emptyGroupState())).toBe(false);
  });
});

describe('chat list includes groups', () => {
  test('group keys are chat sessions (member sessions are not)', () => {
    expect(isChatSessionKey(KEY)).toBe(true);
    expect(isChatSessionKey('agent:coder:gcmember-abc123')).toBe(false);
    expect(mergeSessions([], [{ key: KEY, updatedAt: 1 }]).map((r) => r.key)).toEqual([KEY]);
  });
  test('an unlabeled group is titled "Group chat" like the web', () => {
    expect(sessionTitle({ key: KEY })).toBe('Group chat');
    expect(sessionTitle({ key: KEY, label: 'Crew' })).toBe('Crew');
  });
});

describe('workflow stage builder', () => {
  const base = { id: 'wf-1', name: 'Ship', nodes: [], edges: [] };
  const build = () => {
    let st = [];
    ({ stages: st } = addStep(st, 'main', { label: 'Plan' }));
    ({ stages: st } = addStep(st, 'coder'));
    ({ stages: st } = addStep(st, 'qa', { parallelWith: 1 }));
    ({ stages: st } = addStep(st, 'main', { label: 'Wrap' }));
    return st;
  };
  const shape = (st) => st.map((s) => s.map((n) => n.agentId));
  test('sequential + parallel stages become a valid layered graph', () => {
    const st = build();
    expect(shape(st)).toEqual([['main'], ['coder', 'qa'], ['main']]);
    const g = stagesToGraph(base, st);
    expect(g.edges).toHaveLength(4); // 1→2 (x2) and 2→1 (x2)
    expect(validateWorkflow(g, { members: ['main', 'coder', 'qa'] }).valid).toBe(true);
    expect(shape(graphToStages(g))).toEqual(shape(st));
    expect(isStageShaped(g)).toBe(true);
    expect(describeOrder(g, (n) => n.label || n.agentId)).toBe('Plan → (coder ∥ qa) → Wrap');
    // tidy positions: one column per stage, like the web's Tidy
    expect(new Set(g.nodes.map((n) => n.x)).size).toBe(3);
  });
  test('toggleParallel splits a shared stage and merges a lone one back', () => {
    const st = build();
    const qa = st[1][1].id;
    const split = toggleParallel(st, qa);
    expect(shape(split)).toEqual([['main'], ['coder'], ['qa'], ['main']]);
    expect(shape(toggleParallel(split, qa))).toEqual([['main'], ['coder', 'qa'], ['main']]);
    // first stage alone stays put
    expect(shape(toggleParallel(st, st[0][0].id))).toEqual(shape(st));
  });
  test('reorder, remove, edit', () => {
    const st = build();
    expect(shape(moveStage(st, 2, 0))).toEqual([['main'], ['main'], ['coder', 'qa']]);
    expect(moveStage(st, 1, 1)).toBe(st);
    expect(shape(removeStep(st, st[0][0].id))).toEqual([['coder', 'qa'], ['main']]);
    expect(shape(removeStep(removeStep(st, st[1][0].id), st[1][1].id))).toEqual([['main'], ['main']]);
    const ed = updateStep(st, st[1][0].id, { agentId: 'qa', prompt: 'test it' });
    expect(ed[1][0]).toMatchObject({ agentId: 'qa', prompt: 'test it' });
  });
  test('drag target crosses half a neighbour to swap', () => {
    const h = [60, 80, 60, 100];
    expect(dragTargetIndex(0, 20, h)).toBe(0);
    expect(dragTargetIndex(0, 41, h)).toBe(1);
    expect(dragTargetIndex(0, 80 + 31, h)).toBe(2);
    expect(dragTargetIndex(3, -31, h)).toBe(2);
    expect(dragTargetIndex(3, -500, h)).toBe(0);
    expect(dragTargetIndex(1, 999, h)).toBe(3);
  });
  test('web-built graphs with hierarchy or skip links are detected (edits would rebuild them)', () => {
    const web = {
      ...base,
      nodes: [
        { id: 'a', agentId: 'main', x: 0, y: 0, parentId: null },
        { id: 'b', agentId: 'coder', x: 0, y: 0, parentId: 'a' },
        { id: 'c', agentId: 'qa', x: 0, y: 0, parentId: null },
      ],
      edges: [{ id: 'e', sourceId: 'a', targetId: 'c' }],
    };
    expect(isStageShaped(web)).toBe(false);
    expect(shape(graphToStages(web))).toEqual([['main'], ['coder', 'qa']]);
    const skip = { ...base, nodes: web.nodes.map((n) => ({ ...n, parentId: null })), edges: [{ id: 'x', sourceId: 'a', targetId: 'b' }, { id: 'y', sourceId: 'b', targetId: 'c' }, { id: 'z', sourceId: 'a', targetId: 'c' }] };
    expect(isStageShaped(skip)).toBe(false);
    // rebuilding keeps the existing edge ids that survive
    const re = stagesToGraph(skip, graphToStages(skip));
    expect(re.edges.map((e) => e.id).sort()).toEqual(['x', 'y']);
  });
  test('run status per step and newest-first run options', () => {
    const g = stagesToGraph(base, build());
    const runs = [
      { id: 'r1', workflowId: 'wf-1', workflowName: 'Ship', status: 'done', startedAt: 1, steps: g.nodes.map((n) => ({ nodeId: n.id, agentId: n.agentId, status: 'done' })) },
      { id: 'r2', workflowId: 'wf-1', workflowName: 'Ship', status: 'running', startedAt: 2, steps: g.nodes.map((n, i) => ({ nodeId: n.id, agentId: n.agentId, status: i ? 'pending' : 'running' })) },
    ];
    const st = nodeStatuses(g, runs);
    expect(st.run.id).toBe('r2');
    expect(st.byNode[g.nodes[0].id]).toBe('running');
    expect(runOptions(runs).map((r) => [r.id, r.done, r.total])).toEqual([['r2', 0, 4], ['r1', 4, 4]]);
  });
});

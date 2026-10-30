/**
 * session-sync — the rules that keep mobile chat and web chat on the same
 * sessions. Fixtures use the shapes the live gateway returns (sessions.list /
 * chat.history / `chat` + `agent` broadcasts).
 */
import {
  SESSION_PREFIX,
  agentIdFromKey,
  agentLabel,
  buildTurns,
  cleanUserText,
  dayBucket,
  emptyLive,
  extractPanelRef,
  fetchHistoryPage,
  fetchSessionsPage,
  groupSessions,
  isChatSessionKey,
  isMultiAgent,
  makePagingCaps,
  markRead,
  mergeSessions,
  newSessionKey,
  pickDefaultAgentId,
  reduceActivity,
  reduceAgentActivity,
  reduceChatEvent,
  reduceToolEvent,
  relTime,
  sessionTitle,
  sortSessions,
  stripThinkingTags,
} from '../chat/session-sync';

const NOW = new Date(2026, 9, 1, 12, 0, 0).getTime(); // 1 Oct 2026, local noon
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const row = (suffix, over = {}) => ({ key: `agent:main:webchat-${suffix}`, kind: 'direct', updatedAt: NOW, ...over });

describe('session keys', () => {
  test('new keys use the web chat grammar: agent:<id>:webchat-<base36 ts>', () => {
    const key = newSessionKey('cmo', 1790769939338);
    expect(key).toBe(`agent:cmo:${SESSION_PREFIX}${(1790769939338).toString(36)}`);
    expect(isChatSessionKey(key)).toBe(true);
    expect(agentIdFromKey(key)).toBe('cmo');
  });

  test('a key minted on mobile is one the web sidebar lists', () => {
    // webchat.ts filters with /^agent:[^:]+:webchat-/
    expect(/^agent:[^:]+:webchat-/.test(newSessionKey())).toBe(true);
  });

  test('non-chat sessions are not chats', () => {
    for (const k of ['agent:main', 'agent:main:mobile-abc', 'agent:main:telegram', 'agent:dev:subagent:1', 'webchat-x', '', null]) {
      expect(isChatSessionKey(k)).toBe(false);
    }
  });

  test('falls back to main when no agent is given', () => {
    expect(agentIdFromKey(newSessionKey(undefined, 1))).toBe('main');
    expect(agentIdFromKey('garbage')).toBeNull();
  });
});

describe('titles', () => {
  test('label wins, then derived title, then "New chat"', () => {
    expect(sessionTitle(row('a', { label: 'Renamed', derivedTitle: 'first message' }))).toBe('Renamed');
    expect(sessionTitle(row('a', { derivedTitle: 'first message' }))).toBe('first message');
    expect(sessionTitle(row('a', { displayName: 'webchat:g-agent-main' }))).toBe('webchat:g-agent-main');
    expect(sessionTitle(row('a'))).toBe('New chat');
    expect(sessionTitle(null)).toBe('New chat');
  });

  test('strips transport envelopes and message_id tags, like the web', () => {
    expect(cleanUserText('[WebChat 2026-09-30 10:00] hello there [message_id: 123]')).toBe('hello there');
    expect(cleanUserText('[not an envelope] keep me')).toBe('[not an envelope] keep me');
    expect(sessionTitle(row('a', { derivedTitle: '[Telegram 2026-09-30T10:00Z] plan a feature' }))).toBe('plan a feature');
  });

  test('strips leaked reasoning from assistant text', () => {
    expect(stripThinkingTags('<think>secret</think>Answer')).toBe('Answer');
    expect(stripThinkingTags('<thinking>still going')).toBe('');
  });
});

describe('ordering and grouping', () => {
  const rows = [
    row('old', { updatedAt: NOW - 40 * DAY }),
    row('today', { updatedAt: NOW - HOUR }),
    row('pinned-old', { updatedAt: NOW - 90 * DAY, pinned: true }),
    row('yesterday', { updatedAt: NOW - 20 * HOUR }),
    row('week', { updatedAt: NOW - 3 * DAY }),
    row('month', { updatedAt: NOW - 12 * DAY }),
    row('never', { updatedAt: undefined }),
  ];

  test('pinned first, then newest first', () => {
    expect(sortSessions(rows).map((r) => r.key.split('webchat-')[1])).toEqual([
      'pinned-old', 'today', 'yesterday', 'week', 'month', 'old', 'never',
    ]);
  });

  test('groups are Pinned then the web day buckets, in order', () => {
    const groups = groupSessions(rows, { now: new Date(NOW) });
    expect(groups.map((g) => g.title)).toEqual(['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older']);
    expect(groups[0].rows).toHaveLength(1);
    expect(groups[5].rows.map((r) => r.key)).toEqual(['agent:main:webchat-old', 'agent:main:webchat-never']);
  });

  test('empty buckets are dropped and search matches title or key', () => {
    const data = [row('x1', { label: 'Quarterly plan' }), row('x2', { derivedTitle: 'hello' })];
    expect(groupSessions(data, { query: 'plan', now: new Date(NOW) })).toEqual([{ title: 'Today', rows: [data[0]] }]);
    expect(groupSessions(data, { query: 'WEBCHAT-X2', now: new Date(NOW) })[0].rows).toEqual([data[1]]);
    expect(groupSessions(data, { query: 'nope', now: new Date(NOW) })).toEqual([]);
  });

  test('dayBucket boundaries', () => {
    const now = new Date(NOW);
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    expect(dayBucket(midnight, now)).toBe('Today');
    expect(dayBucket(midnight - 1, now)).toBe('Yesterday');
    expect(dayBucket(midnight - DAY - 1, now)).toBe('Previous 7 days');
    expect(dayBucket(midnight - 7 * DAY - 1, now)).toBe('Previous 30 days');
    expect(dayBucket(midnight - 30 * DAY - 1, now)).toBe('Older');
    expect(dayBucket(null, now)).toBe('Older');
  });

  test('relTime is compact', () => {
    expect(relTime(NOW - 20_000, NOW)).toBe('now');
    expect(relTime(NOW - 12 * 60_000, NOW)).toBe('12m');
    expect(relTime(NOW - 3 * HOUR, NOW)).toBe('3h');
    expect(relTime(NOW - 20 * HOUR, NOW)).toBe('Yesterday');
    expect(relTime(0, NOW)).toBe('');
  });

  test('agent attribution only when more than one agent has chats', () => {
    expect(isMultiAgent([row('a'), row('b')])).toBe(false);
    expect(isMultiAgent([row('a'), { key: 'agent:cmo:webchat-b' }])).toBe(true);
    const agents = [{ id: 'main', identity: { name: 'INFINI' } }, { id: 'cmo', name: 'CMO' }, { id: 'dev' }];
    expect(agentLabel(agents, 'main')).toBe('INFINI');
    expect(agentLabel(agents, 'cmo')).toBe('CMO');
    expect(agentLabel(agents, 'dev')).toBe('dev');
    expect(agentLabel(agents, 'ghost')).toBe('ghost');
  });

  test('default agent prefers main, then the roster default', () => {
    expect(pickDefaultAgentId({ agents: [{ id: 'dev' }, { id: 'main' }], defaultId: 'dev' })).toBe('main');
    expect(pickDefaultAgentId({ agents: [{ id: 'dev' }, { id: 'ops' }], defaultId: 'ops' })).toBe('ops');
    expect(pickDefaultAgentId(null)).toBe('main');
  });
});

describe('mergeSessions', () => {
  test('replaces rows by key, drops non-chat keys, keeps an unsaved active chat', () => {
    const optimistic = row('fresh', { derivedTitle: 'just sent' });
    const prev = [optimistic, row('a', { derivedTitle: 'stale' })];
    const fetched = [row('a', { derivedTitle: 'updated', updatedAt: NOW - HOUR }), { key: 'agent:main:telegram' }];
    const out = mergeSessions(prev, fetched, { keep: [optimistic.key] });
    expect(out.map((r) => r.key)).toEqual([optimistic.key, 'agent:main:webchat-a']);
    expect(out[1].derivedTitle).toBe('updated');
  });

  test('does not duplicate the active chat once the store has it', () => {
    const a = row('a');
    expect(mergeSessions([a], [a], { keep: [a.key] })).toHaveLength(1);
  });

  test('a chat deleted on another device disappears', () => {
    expect(mergeSessions([row('a'), row('b')], [row('b')], { keep: [null] }).map((r) => r.key)).toEqual(['agent:main:webchat-b']);
  });
});

describe('paging', () => {
  const store = Array.from({ length: 150 }, (_, i) => row(`s${i}`, { updatedAt: NOW - i * HOUR }));

  test('modern gateway: uses offset and trusts hasMore/total', async () => {
    const calls = [];
    const sendReq = async (method, params) => {
      calls.push(params);
      const off = params.offset || 0;
      const slice = store.slice(off, off + params.limit);
      return { sessions: slice, total: store.length, hasMore: off + params.limit < store.length };
    };
    const caps = makePagingCaps();
    const p1 = await fetchSessionsPage(sendReq, { offset: 0, limit: 60, caps });
    const p2 = await fetchSessionsPage(sendReq, { offset: 60, limit: 60, caps });
    const p3 = await fetchSessionsPage(sendReq, { offset: 120, limit: 60, caps });
    expect(caps.sessionsOffset).toBe(true);
    // page one never carries an offset (no probe needed to show the list)
    expect(calls[0]).toEqual({ sessionPrefixes: ['webchat-', 'groupchat-'], includeDerivedTitles: true, limit: 60 });
    expect(calls[1]).toEqual({ sessionPrefixes: ['webchat-', 'groupchat-'], includeDerivedTitles: true, limit: 60, offset: 60 });
    expect([p1.rows.length, p2.rows.length, p3.rows.length]).toEqual([60, 60, 30]);
    expect([p1.hasMore, p2.hasMore, p3.hasMore]).toEqual([true, true, false]);
    expect(p1.total).toBe(150);
    expect(p2.rows[0].key).toBe('agent:main:webchat-s60');
  });

  test('legacy gateway (rejects offset): falls back to a growing limit, once', async () => {
    const calls = [];
    const sendReq = async (method, params) => {
      calls.push(params);
      if ('offset' in params) throw new Error("invalid sessions.list params: at root: unexpected property 'offset'");
      return { sessions: store.slice(0, params.limit), defaults: { model: 'm', modelProvider: 'p' } };
    };
    const caps = makePagingCaps();
    const p1 = await fetchSessionsPage(sendReq, { offset: 0, limit: 60, caps });
    const p2 = await fetchSessionsPage(sendReq, { offset: 60, limit: 60, caps });
    const p3 = await fetchSessionsPage(sendReq, { offset: 120, limit: 60, caps });
    expect(caps.sessionsOffset).toBe(false);
    // page one sends no offset at all; one rejected probe on page two, then never again
    expect('offset' in calls[0]).toBe(false);
    expect(calls.filter((c) => 'offset' in c)).toHaveLength(1);
    expect(calls.map((c) => c.limit)).toEqual([60, 60, 120, 180]);
    expect(p2.rows[0].key).toBe('agent:main:webchat-s60');
    expect([p1.rows.length, p2.rows.length, p3.rows.length]).toEqual([60, 60, 30]);
    expect([p1.hasMore, p2.hasMore, p3.hasMore]).toEqual([true, true, false]);
    expect(p1.defaults).toEqual({ model: 'm', modelProvider: 'p' });
  });

  test('opening the chat list on a legacy gateway makes no rejected call', async () => {
    let rejected = 0;
    const sendReq = async (method, params) => {
      if ('offset' in params) { rejected += 1; throw new Error("unexpected property 'offset'"); }
      return { sessions: store.slice(0, params.limit) };
    };
    const caps = makePagingCaps();
    await fetchSessionsPage(sendReq, { offset: 0, limit: 60, caps });
    await fetchSessionsPage(sendReq, { offset: 0, limit: 60, caps }); // refresh
    expect(rejected).toBe(0);
  });

  test('gateway without sessionPrefixes: falls back to the webchat search, once', async () => {
    const calls = [];
    const sendReq = async (method, params) => {
      calls.push(params);
      if ('sessionPrefixes' in params) throw new Error("invalid sessions.list params: at root: unexpected property 'sessionPrefixes'");
      return { sessions: store.slice(0, params.limit) };
    };
    const caps = makePagingCaps();
    const p1 = await fetchSessionsPage(sendReq, { offset: 0, limit: 60, caps });
    await fetchSessionsPage(sendReq, { offset: 0, limit: 60, caps });
    expect(caps.sessionPrefixes).toBe(false);
    expect(calls.filter((c) => 'sessionPrefixes' in c)).toHaveLength(1);
    expect(calls[1]).toEqual({ search: 'webchat-', includeDerivedTitles: true, limit: 60 });
    expect(p1.rows).toHaveLength(60);
  });

  test('group chats come back in the same list', async () => {
    const sendReq = async () => ({ sessions: [row('a'), { key: 'agent:main:groupchat-abc1', updatedAt: NOW }, { key: 'agent:qa:gcmember-abc1' }] });
    const page = await fetchSessionsPage(sendReq, { limit: 60 });
    expect(page.rows.map((r) => r.key)).toEqual(['agent:main:webchat-a', 'agent:main:groupchat-abc1']);
  });

  test('other errors are not swallowed', async () => {
    const sendReq = async () => { throw new Error('Not connected'); };
    await expect(fetchSessionsPage(sendReq, {})).rejects.toThrow('Not connected');
  });

  test('non-chat rows returned by a loose search are filtered out', async () => {
    const sendReq = async () => ({ sessions: [row('a'), { key: 'agent:main:cron-webchat-digest' }] });
    const page = await fetchSessionsPage(sendReq, { limit: 60 });
    expect(page.rows.map((r) => r.key)).toEqual(['agent:main:webchat-a']);
  });

  test('history: legacy gateway pages older messages by growing limit', async () => {
    const all = Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    const calls = [];
    const sendReq = async (method, params) => {
      calls.push(params);
      if ('beforeIndex' in params) throw new Error("invalid chat.history params: at root: unexpected property 'beforeIndex'");
      return { messages: all.slice(-params.limit) };
    };
    const caps = makePagingCaps();
    const first = await fetchHistoryPage(sendReq, { sessionKey: 'k', limit: 80, caps });
    expect(first.messages).toHaveLength(80);
    expect(first.messages[79].content).toBe('m199');
    expect(first.hasMore).toBe(true);
    const older = await fetchHistoryPage(sendReq, { sessionKey: 'k', limit: 80, before: 80, total: null, caps });
    expect(older.messages).toHaveLength(80);
    expect(older.messages[0].content).toBe('m40');
    expect(older.messages[79].content).toBe('m119');
    const last = await fetchHistoryPage(sendReq, { sessionKey: 'k', limit: 80, before: 160, caps });
    expect(last.messages.map((m) => m.content)).toEqual(all.slice(0, 40).map((m) => m.content));
    expect(last.hasMore).toBe(false);
    expect(calls.every((c) => !('beforeIndex' in c))).toBe(true);
  });

  test('history: modern gateway uses beforeIndex when the total is known', async () => {
    const calls = [];
    const sendReq = async (method, params) => {
      calls.push(params);
      return { messages: [{ role: 'user', content: 'older' }], startIndex: 40, hasMore: true, total: 200 };
    };
    const caps = makePagingCaps();
    const page = await fetchHistoryPage(sendReq, { sessionKey: 'k', limit: 80, before: 80, total: 200, caps });
    expect(calls[0]).toEqual({ sessionKey: 'k', limit: 80, beforeIndex: 120 });
    expect(page.hasMore).toBe(true);
    expect(caps.historyBefore).toBe(true);
  });
});

describe('buildTurns', () => {
  test('user + assistant with thinking, text and a paired tool call', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: '[WebChat 2026-09-30 10:00] list projects [message_id: 9]' }], timestamp: 1 },
      {
        role: 'assistant',
        provider: 'ollama-cloud',
        model: 'kimi-k2.6',
        content: [
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'Checking.' },
          { type: 'toolCall', id: 'call-1', name: 'kanban', arguments: { action: 'list' } },
        ],
      },
      { role: 'toolResult', toolCallId: 'call-1', toolName: 'kanban', content: [{ type: 'text', text: '3 projects' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'You have **3** projects.' }] },
    ];
    const turns = buildTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: 'user', text: 'list projects', images: [] });
    expect(turns[1].model).toBe('ollama-cloud/kimi-k2.6');
    expect(turns[1].blocks.map((b) => b.kind)).toEqual(['text', 'tool', 'text']);
    expect(turns[1].blocks[1].tool).toMatchObject({ id: 'call-1', name: 'kanban', args: { action: 'list' }, result: '3 projects' });
    // the tool result is consumed by its call, not rendered twice
    expect(turns[1].blocks.filter((b) => b.kind === 'tool')).toHaveLength(1);
  });

  test('heartbeat / silent replies and empty turns are dropped', () => {
    const turns = buildTurns([
      { role: 'user', content: 'ping' },
      { role: 'assistant', content: 'HEARTBEAT_OK' },
      { role: 'assistant', content: [{ type: 'text', text: 'NO_REPLY' }] },
      { role: 'user', content: '   ' },
      { role: 'system', content: 'ignored' },
    ]);
    expect(turns).toEqual([expect.objectContaining({ role: 'user', text: 'ping' })]);
  });

  test('user images become data URIs', () => {
    const turns = buildTurns([
      { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        { type: 'image', data: 'data:image/png;base64,BBBB' },
      ] },
    ]);
    expect(turns[0].images).toEqual(['data:image/jpeg;base64,AAAA', 'data:image/png;base64,BBBB']);
    expect(turns[0].text).toBe('');
  });

  test('a show_panel result renders as a panel block', () => {
    const ref = { v: 1, kind: 'projects', query: { status: 'in_progress' }, title: 'Projects', summary: '4 in progress', count: 4, link: { tab: 'projects', label: 'Open projects' }, refreshMs: 30000, ts: 5 };
    const turns = buildTurns([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'p1', name: 'show_panel', arguments: { kind: 'projects' } }] },
      { role: 'toolResult', toolCallId: 'p1', toolName: 'show_panel', content: [{ type: 'text', text: JSON.stringify({ chatPanel: ref, text: 'fallback' }) }] },
    ]);
    expect(turns[0].blocks).toHaveLength(1);
    expect(turns[0].blocks[0].kind).toBe('panel');
    expect(turns[0].blocks[0].panel).toMatchObject({ kind: 'projects', title: 'Projects', count: 4, refreshMs: 30000, display: 'inline' });
  });

  test('the live gateway shape: toolResult with `details.chatPanel` + pretty-printed JSON text', () => {
    // captured from chat.history on the live gateway (show_panel, kind "project")
    const ref = { v: 1, panelId: 'panel_d1bd209b', kind: 'project', query: { id: 'in-progress' }, title: 'In-Progress Projects', display: 'inline', summary: 'Could not load project', count: 0, empty: true, error: 'No project matches', link: { tab: 'projects', label: 'Open projects' }, refreshMs: 0, ts: 1 };
    const turns = buildTurns([
      { role: 'user', content: [{ type: 'text', text: 'show my projects' }] },
      { role: 'assistant', provider: 'ollama-cloud', model: 'gpt-oss:120b', content: [{ type: 'thinking', thinking: '…' }, { type: 'toolCall', id: 'call_a3ar3y0z', name: 'show_panel', arguments: { kind: 'project' } }] },
      { role: 'toolResult', toolCallId: 'call_a3ar3y0z', toolName: 'show_panel', isError: false, details: { chatPanel: ref }, content: [{ type: 'text', text: JSON.stringify({ chatPanel: ref }, null, 2) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'PANEL-DONE' }] },
    ]);
    expect(turns[1].blocks.map((b) => b.kind)).toEqual(['panel', 'text']);
    expect(turns[1].blocks[0].panel).toMatchObject({ panelId: 'panel_d1bd209b', kind: 'project', title: 'In-Progress Projects', error: 'No project matches' });
    // text-only (details stripped by a surface) still resolves from the JSON text
    const textOnly = buildTurns([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'show_panel', arguments: {} }] },
      { role: 'toolResult', toolCallId: 'c', toolName: 'show_panel', content: [{ type: 'text', text: JSON.stringify({ chatPanel: ref }, null, 2) }] },
    ]);
    expect(textOnly[0].blocks[0].kind).toBe('panel');
  });

  test('a show_panel call that errored (no chatPanel) stays a plain tool card', () => {
    const turns = buildTurns([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'show_panel', arguments: { kind: 'nope' } }] },
      { role: 'toolResult', toolCallId: 'c', toolName: 'show_panel', isError: true, content: [{ type: 'text', text: 'Unknown panel kind: nope' }] },
    ]);
    expect(turns[0].blocks[0]).toMatchObject({ kind: 'tool', tool: { name: 'show_panel', result: 'Unknown panel kind: nope' } });
  });

  test('a truncated panel JSON degrades to a plain tool card', () => {
    const turns = buildTurns([
      { role: 'toolResult', toolCallId: 'p1', toolName: 'show_panel', content: [{ type: 'text', text: '{"chatPanel":{"v":1,"kind":"mesh","query":{' }] },
    ]);
    expect(turns[0].blocks[0].kind).toBe('tool');
    expect(extractPanelRef('{"chatPanel":{"v":2,"kind":"x"}}')).toBeNull();
    expect(extractPanelRef({ details: { chatPanel: { v: 1, kind: 'mesh' } } })).toMatchObject({ kind: 'mesh', title: 'mesh' });
  });

  test('model errors surface as an error block', () => {
    const turns = buildTurns([{ role: 'assistant', content: [], errorMessage: 'rate limited' }]);
    expect(turns[0].blocks).toEqual([{ kind: 'text', text: 'Model error: rate limited' }]);
    const t2 = buildTurns([{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }], errorMessage: 'boom' }]);
    expect(t2[0].blocks).toEqual([{ kind: 'error', text: 'boom' }]);
  });

  test('the live run appends streaming tools + text to the last assistant turn', () => {
    const live = { runId: 'r1', stream: 'Working on', tools: [{ id: 't1', name: 'exec', args: { cmd: 'ls' }, pending: true }] };
    const turns = buildTurns([{ role: 'user', content: 'go' }], live);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ role: 'assistant', streaming: true, id: 'live-r1' });
    expect(turns[1].blocks.map((b) => b.kind)).toEqual(['tool', 'text']);
    expect(turns[1].blocks[0].tool.pending).toBe(true);
    // a run with nothing streamed yet still shows a (typing) turn
    expect(buildTurns([], { runId: 'r2', stream: '', tools: [] })[0]).toMatchObject({ streaming: true, blocks: [] });
  });

  test('optimistic and failed sends keep their flags', () => {
    const turns = buildTurns([{ role: 'user', content: [{ type: 'text', text: 'hi' }], pending: true, failed: true }]);
    expect(turns[0]).toMatchObject({ pending: true, failed: true });
  });
});

describe('live chat events (web ⇄ mobile sync)', () => {
  const KEY = 'agent:main:webchat-abc';
  const delta = (runId, text, sessionKey = KEY) => ({ runId, sessionKey, state: 'delta', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const final = (runId, text, sessionKey = KEY) => ({ runId, sessionKey, state: 'final', message: { role: 'assistant', content: [{ type: 'text', text }] } });

  test('events for another session never touch the open transcript', () => {
    const live = emptyLive();
    expect(reduceChatEvent(live, delta('r', 'x', 'agent:main:webchat-other'), KEY)).toEqual({ live, effect: null });
    expect(reduceChatEvent(live, delta('r', 'x'), null)).toEqual({ live, effect: null });
  });

  test('a run started on ANOTHER device is adopted: stream shows and history reloads', () => {
    // mobile is idle on the session; the web sends a message → gateway broadcasts deltas
    const a = reduceChatEvent(emptyLive(), delta('web-run', 'Hel'), KEY);
    expect(a.effect).toBe('adopt');
    expect(a.live).toMatchObject({ runId: 'web-run', stream: 'Hel' });
    const b = reduceChatEvent(a.live, delta('web-run', 'Hello there'), KEY);
    expect(b.effect).toBe('stream');
    expect(b.live.stream).toBe('Hello there');
    const c = reduceChatEvent(b.live, final('web-run', 'Hello there'), KEY);
    expect(c.effect).toBe('settle');
    expect(c.live).toEqual(emptyLive());
  });

  test('own run: deltas stream, a shorter out-of-order delta never rewinds the text', () => {
    const mine = { ...emptyLive(), runId: 'mine', startedAt: 1 };
    const a = reduceChatEvent(mine, delta('mine', 'Longer text'), KEY);
    expect(a.effect).toBe('stream');
    const b = reduceChatEvent(a.live, delta('mine', 'Long'), KEY);
    expect(b.live.stream).toBe('Longer text');
  });

  test('a different run finishing in this session (sub-agent announce) reloads history only', () => {
    const mine = { ...emptyLive(), runId: 'mine', stream: 'partial' };
    expect(reduceChatEvent(mine, delta('other', 'zzz'), KEY)).toEqual({ live: mine, effect: null });
    expect(reduceChatEvent(mine, final('other', 'done'), KEY)).toEqual({ live: mine, effect: 'settle' });
  });

  test('abort and error both settle; error keeps its message', () => {
    const mine = { ...emptyLive(), runId: 'mine', stream: 'partial' };
    expect(reduceChatEvent(mine, { runId: 'mine', sessionKey: KEY, state: 'aborted' }, KEY)).toEqual({ live: emptyLive(), effect: 'settle' });
    const e = reduceChatEvent(mine, { runId: 'mine', sessionKey: KEY, state: 'error', errorMessage: 'model down' }, KEY);
    expect(e.effect).toBe('settle');
    expect(e.live.error).toBe('model down');
    expect(e.live.runId).toBeNull();
  });

  test('tool stream: start → update → result builds one live tool card', () => {
    let live = { ...emptyLive(), runId: 'r1' };
    live = reduceToolEvent(live, { runId: 'r1', sessionKey: KEY, stream: 'tool', data: { phase: 'start', toolCallId: 't1', name: 'exec', args: { cmd: 'ls' } } }, KEY);
    expect(live.tools).toEqual([{ id: 't1', name: 'exec', args: { cmd: 'ls' }, result: undefined, pending: true }]);
    live = reduceToolEvent(live, { runId: 'r1', stream: 'tool', data: { phase: 'update', toolCallId: 't1', name: 'exec', partialResult: 'a.txt' } }, KEY);
    expect(live.tools[0]).toMatchObject({ result: 'a.txt', pending: true, args: { cmd: 'ls' } });
    live = reduceToolEvent(live, { runId: 'r1', stream: 'tool', data: { phase: 'result', toolCallId: 't1', name: 'exec', result: { content: [{ type: 'text', text: 'a.txt\nb.txt' }] } } }, KEY);
    expect(live.tools).toHaveLength(1);
    expect(live.tools[0]).toMatchObject({ result: 'a.txt\nb.txt', pending: false });
  });

  test('tool stream ignores other sessions, other runs and non-tool streams', () => {
    const live = { ...emptyLive(), runId: 'r1' };
    const ev = (over) => ({ runId: 'r1', sessionKey: KEY, stream: 'tool', data: { phase: 'start', toolCallId: 't', name: 'x' }, ...over });
    expect(reduceToolEvent(live, ev({ sessionKey: 'agent:main:webchat-zzz' }), KEY)).toBe(live);
    expect(reduceToolEvent(live, ev({ runId: 'r2' }), KEY)).toBe(live);
    expect(reduceToolEvent(live, ev({ stream: 'compaction' }), KEY)).toBe(live);
    expect(reduceToolEvent(live, ev({ data: { phase: 'start' } }), KEY)).toBe(live);
  });
});

describe('unread + streaming markers', () => {
  const A = 'agent:main:webchat-a';
  const B = 'agent:main:webchat-b';
  const start = { unread: {}, streaming: {} };
  const ev = (sessionKey, state, text = 'A real reply') => ({ sessionKey, runId: 'r', state, message: { role: 'assistant', content: [{ type: 'text', text }] } });

  test('a reply in a chat you are not looking at marks it unread', () => {
    let a = reduceActivity(start, ev(B, 'delta'), A);
    expect(a.streaming[B]).toBe('r');
    expect(a.unread[B]).toBeUndefined();
    a = reduceActivity(a, ev(B, 'final'), A);
    expect(a.streaming[B]).toBeUndefined();
    expect(typeof a.unread[B]).toBe('number');
  });

  test('a reply in the open chat is not unread', () => {
    const a = reduceActivity(reduceActivity(start, ev(A, 'delta'), A), ev(A, 'final'), A);
    expect(a).toEqual({ unread: {}, streaming: {} });
  });

  test('heartbeats, aborted runs and non-chat sessions never mark unread', () => {
    expect(reduceActivity(start, ev(B, 'final', 'HEARTBEAT_OK'), A).unread).toEqual({});
    expect(reduceActivity(start, ev(B, 'aborted'), A).unread).toEqual({});
    expect(reduceActivity(start, ev('agent:main:telegram', 'final'), A)).toBe(start);
  });

  test('agent lifecycle / tool events mark a chat busy before any reply text', () => {
    let a = reduceAgentActivity(start, { sessionKey: B, runId: 'r9', stream: 'lifecycle', data: { phase: 'start' } });
    expect(a.streaming[B]).toBe('r9');
    expect(reduceAgentActivity(a, { sessionKey: B, runId: 'r9', stream: 'tool', data: { phase: 'start', toolCallId: 't' } })).toBe(a);
    a = reduceAgentActivity(a, { sessionKey: B, runId: 'r9', stream: 'lifecycle', data: { phase: 'end' } });
    expect(a.streaming[B]).toBeUndefined();
    // a tool event alone is enough; other sessions and non-chat keys are ignored
    expect(reduceAgentActivity(start, { sessionKey: B, stream: 'tool', data: { phase: 'start' } }).streaming[B]).toBe(true);
    expect(reduceAgentActivity(start, { sessionKey: 'agent:main:telegram', stream: 'lifecycle', data: { phase: 'start' } })).toBe(start);
    expect(reduceAgentActivity(start, { stream: 'lifecycle', data: { phase: 'start' } })).toBe(start);
  });

  test('opening the chat clears its mark', () => {
    const a = reduceActivity(start, ev(B, 'final'), A);
    expect(markRead(a, B).unread).toEqual({});
    expect(markRead(a, A)).toBe(a);
  });
});

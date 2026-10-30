/**
 * Native Knowledge Graph interactions: the touch router (taps, double-tap,
 * orbit vs node drag, pinch / pan / twist, cancel), native Open targets, the
 * AI drawer session (doc_agent.spawn → chat.send → streamed reply), the
 * deep-link helpers, and the long-press lift guard.
 */
import { createTouchRouter, DOUBLE_TAP_MS, ORBIT_SLOP, wheelRatio } from '../kg/kg-gestures';
import { openTargetFor, canOpenNode } from '../kg/kg-open';
import { createAiSession, hashIds } from '../kg/kg-ai-session';
import { deepLinkOf, deepLinkSig } from '../kg/kg-deep-link';
import { KgController } from '../kg/kg-controller';


function fakeStage({ owns = false } = {}) {
  const calls = [];
  const s = {
    calls,
    owned: owns,
    pointerDown: (p) => (calls.push(['down', p.x, p.y, p.pointerType, p.buttons]), s.owned),
    pointerMove: (p) => (calls.push(['move', p.x, p.y]), s.owned),
    pointerUp: (p) => calls.push(['up', p.x, p.y, p.type]),
    pointerCancel: () => calls.push(['cancel']),
    doubleTapAt: (x, y) => calls.push(['dbl', x, y]),
    orbitBy: (dx, dy) => calls.push(['orbit', dx, dy]),
    panBy: (dx, dy) => calls.push(['pan', dx, dy]),
    dollyBy: (r) => calls.push(['dolly', r]),
    twistBy: (a) => calls.push(['twist', a]),
    names: () => calls.map((c) => c[0]),
  };
  return s;
}

describe('touch router', () => {
  test('tap: down → up at the same point, no orbit', () => {
    const st = fakeStage();
    const r = createTouchRouter(st, { now: () => 1000 });
    r.start([{ x: 50, y: 60 }]);
    r.end([], { x: 51, y: 60 });
    expect(st.names()).toEqual(['down', 'up']);
    expect(st.calls[0]).toEqual(['down', 50, 60, 'touch', 1]);
    expect(st.calls[1]).toEqual(['up', 51, 60, 'pointerup']);
  });

  test('double tap opens (second tap within the window, same spot)', () => {
    const st = fakeStage();
    let t = 1000;
    const r = createTouchRouter(st, { now: () => t });
    r.start([{ x: 50, y: 60 }]);
    r.end([], { x: 50, y: 60 });
    t += DOUBLE_TAP_MS - 50;
    r.start([{ x: 52, y: 61 }]);
    r.end([], { x: 52, y: 61 });
    expect(st.calls.at(-1)).toEqual(['dbl', 52, 61]);
    // too slow → no double tap
    const st2 = fakeStage();
    let t2 = 0;
    const r2 = createTouchRouter(st2, { now: () => t2 });
    r2.start([{ x: 5, y: 5 }]);
    r2.end([], { x: 5, y: 5 });
    t2 += DOUBLE_TAP_MS + 50;
    r2.start([{ x: 5, y: 5 }]);
    r2.end([], { x: 5, y: 5 });
    expect(st2.names()).not.toContain('dbl');
  });

  test('one finger on empty space orbits after the slop', () => {
    const st = fakeStage({ owns: false });
    const r = createTouchRouter(st);
    r.start([{ x: 100, y: 100 }]);
    r.move([{ x: 100 + ORBIT_SLOP - 2, y: 100 }]);
    expect(st.names()).not.toContain('orbit');
    r.move([{ x: 120, y: 104 }]);
    r.move([{ x: 130, y: 110 }]);
    expect(st.calls.filter((c) => c[0] === 'orbit')).toEqual([['orbit', 16, 4], ['orbit', 10, 6]]);
    r.end([], { x: 130, y: 110 });
    expect(st.names().at(-1)).toBe('up');
  });

  test('a node drag / link / lasso owned by the stage never orbits', () => {
    const st = fakeStage({ owns: true });
    const r = createTouchRouter(st);
    r.start([{ x: 10, y: 10 }]);
    r.move([{ x: 60, y: 60 }]);
    r.move([{ x: 90, y: 70 }]);
    expect(st.names()).toEqual(['down', 'move', 'move']);
  });

  test('second finger cancels the press; pinch dollies, drag pans, twist spins', () => {
    const st = fakeStage();
    const r = createTouchRouter(st);
    r.start([{ x: 100, y: 100 }]);
    r.start([{ x: 100, y: 100 }, { x: 200, y: 100 }]);
    expect(st.names()).toEqual(['down', 'cancel']);
    // fingers spread 100 → 200 px, midpoint moves +10,+20, rotate 90°
    r.move([{ x: 60, y: 120 }, { x: 260, y: 120 }]);
    const dolly = st.calls.find((c) => c[0] === 'dolly');
    expect(dolly[1]).toBeCloseTo(2);
    expect(st.calls.find((c) => c[0] === 'pan')).toEqual(['pan', 10, 20]);
    r.move([{ x: 160, y: 20 }, { x: 160, y: 220 }]);
    expect(st.calls.filter((c) => c[0] === 'twist').at(-1)[1]).toBeCloseTo(Math.PI / 2);
    // one finger lifts: drain until all fingers are up, no tap / up sent
    r.end([{ x: 160, y: 220 }]);
    r.move([{ x: 170, y: 230 }]);
    r.end([]);
    expect(st.names()).not.toContain('up');
    expect(r.mode).toBe('idle');
  });

  test('responder taken away cancels a press', () => {
    const st = fakeStage();
    const r = createTouchRouter(st);
    r.start([{ x: 1, y: 1 }]);
    r.cancel();
    expect(st.names()).toEqual(['down', 'cancel']);
    expect(r.mode).toBe('idle');
  });

  test('mouse wheel zooms like OrbitControls (down = out, up = in)', () => {
    expect(wheelRatio(100)).toBeLessThan(1);
    expect(wheelRatio(-100)).toBeGreaterThan(1);
  });
});

describe('Open → native screens (never the web page)', () => {
  test('projects, tasks, notes, docs, research, ideas, reports, runs, business objects', () => {
    expect(openTargetFor({ id: 'project:p1', kind: 'project', label: 'P', meta: { projectId: 'p1' } })).toMatchObject({ tab: 'Board', params: { projectId: 'p1' } });
    expect(openTargetFor({ id: 'task:t1', kind: 'task', label: 'T', meta: {} })).toMatchObject({ tab: 'Board', params: { taskId: 't1' } });
    expect(openTargetFor({ id: 'note:n1', kind: 'note', label: 'N', meta: {} })).toEqual({ tab: 'Knowledge', params: { screen: 'Notes', params: { noteId: 'n1' } }, title: 'N' });
    expect(openTargetFor({ id: 'note:doc:d9', kind: 'note', label: 'D', meta: {} })).toMatchObject({ params: { screen: 'Notes', params: { docId: 'd9' } } });
    expect(openTargetFor({ id: 'note:r1', kind: 'note', label: 'R', meta: { tags: ['Research'] } })).toMatchObject({ params: { screen: 'Research' } });
    expect(openTargetFor({ id: 'idea:i1', kind: 'idea', label: 'I', meta: {} })).toMatchObject({ params: { screen: 'Ideas', params: { ideaId: 'i1' } } });
    expect(openTargetFor({ id: 'report:r2', kind: 'report', label: 'R', meta: {} })).toMatchObject({ screen: 'ReportsScreen', params: { reportId: 'r2' } });
    expect(openTargetFor({ id: 'run:x', kind: 'run', label: 'Run', meta: { runId: 'run_9' } })).toMatchObject({ screen: 'OversightScreen', params: { runId: 'run_9' } });
    expect(openTargetFor({ id: 'client:c', kind: 'client', label: 'C', meta: {} })).toMatchObject({ businessScreen: 'Clients' });
    for (const t of [openTargetFor({ id: 'project:p', kind: 'project', label: 'P' }), openTargetFor({ id: 'note:n', kind: 'note', label: 'N' })]) {
      expect(t.webPath).toBeUndefined();
    }
    expect(canOpenNode({ id: 'session:s', kind: 'session', label: 'S' })).toBe(false);
  });
});

describe('AI drawer session', () => {
  test('spawns a doc agent on the selection, sends the opening prompt, streams the reply', async () => {
    const calls = [];
    let handler = null;
    const api = {
      request: jest.fn(async (m, p) => {
        calls.push([m, p]);
        if (m === 'doc_agent.spawn') return { sessionKey: 'agent:doc:kg-1', systemPrompt: 'SYS' };
        return {};
      }),
      subscribe: (ev, fn) => {
        expect(ev).toBe('chat');
        handler = fn;
        return () => (handler = null);
      },
    };
    const states = [];
    const s = createAiSession(api, (st) => states.push(st));
    await s.start({ intent: 'summarize', title: '2 items', context: 'CTX', count: 2, nodeIds: ['a', 'b'] });
    expect(calls[0][0]).toBe('doc_agent.spawn');
    expect(calls[0][1]).toMatchObject({ docType: 'generic', documentId: `knowledge-graph-${hashIds(['a', 'b'])}`, content: 'CTX' });
    const send = calls.find(([m]) => m === 'chat.send');
    expect(send[1]).toMatchObject({ sessionKey: 'agent:doc:kg-1', deliver: false });
    expect(send[1].message).toMatch(/^\[INSTRUCTIONS/);
    expect(s.state.busy).toBe(true);
    handler({ sessionKey: 'other', state: 'final', message: { role: 'assistant', content: 'nope' } });
    expect(s.state.messages).toHaveLength(1);
    handler({ sessionKey: 'agent:doc:kg-1', state: 'delta', message: { role: 'assistant', content: 'Hel' } });
    expect(s.state.streaming).toBe('Hel');
    handler({ sessionKey: 'agent:doc:kg-1', state: 'final', message: { role: 'assistant', content: 'Hello there' } });
    expect(s.state.busy).toBe(false);
    expect(s.state.messages.at(-1)).toEqual({ role: 'assistant', text: 'Hello there' });
    // same selection again: reuses the session (no second spawn)
    await s.start({ intent: 'chat', title: '2 items', context: 'CTX', count: 2, nodeIds: ['b', 'a'] });
    expect(calls.filter(([m]) => m === 'doc_agent.spawn')).toHaveLength(1);
    s.dispose();
    expect(handler).toBeNull();
  });

  test('a gateway error is shown, not simulated', async () => {
    const s = createAiSession({ request: async () => { throw new Error('unknown method: doc_agent.spawn'); }, subscribe: () => () => {} });
    await s.start({ intent: 'chat', title: 'x', context: '', count: 1, nodeIds: ['x'] });
    expect(s.state.error).toMatch(/unknown method/);
    expect(s.state.messages).toEqual([]);
  });
});

describe('screen helpers', () => {
  test('deep-link params', () => {
    expect(deepLinkOf({ focus: 'project:x', family: true })).toEqual({ focus: 'project:x', family: true, layer: null, group: null });
    expect(deepLinkOf({ nodeId: 'note:1' })).toMatchObject({ focus: 'note:1' });
    expect(deepLinkOf({ layer: 'client' })).toMatchObject({ focus: null, layer: 'client' });
    expect(deepLinkOf({})).toBeNull();
    expect(deepLinkSig({ focus: 'a' })).not.toBe(deepLinkSig({ focus: 'b' }));
  });
});

describe('long-press lift guard', () => {
  test('menu presses are ignored until the opening finger lifts (+ a short window)', () => {
    let t = 0;
    const c = new KgController({ request: async () => ({}), perfNow: () => t, now: () => 0 });
    c.nodeById.set('n', { id: 'n', kind: 'note', label: 'n' });
    c.openMenu('n', 1, 1);
    t = 2000; // a long hold
    expect(c.menuGuarded()).toBe(true);
    c.onStageRelease();
    t = 2100;
    expect(c.menuGuarded()).toBe(true);
    t = 2500;
    expect(c.menuGuarded()).toBe(false);
    c.closeMenu();
    expect(c.menu).toBeNull();
  });
});

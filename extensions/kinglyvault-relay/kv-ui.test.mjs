// node --test extensions/kinglyvault-relay/kv-ui.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { UiHub, forwardedPanel } from './kv-ui.mjs';

// The hub's timers are unref'd on purpose; keep the loop alive for the tests.
const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));

const tab = (hub, tabId, onEvent = () => 200) => {
  const events = [];
  const done = hub.attach({ tabId, route: '/courses', title: 'Courses' }, async (evs) => {
    events.push(...evs);
    return onEvent(evs);
  });
  return { events, done };
};
const answerAll = (hub, tabId) => (evs) => {
  for (const e of evs) if (e.type === 'kv.ui') queueMicrotask(() => hub.receive({ tabId, cmdId: e.data.cmdId, ok: true, result: { did: e.data.op } }));
  return 200;
};

test('a command reaches the tab and its ui.result resolves it', async () => {
  const hub = new UiHub();
  const t = tab(hub, 'tab-aaaaaaaa', answerAll(hub, 'tab-aaaaaaaa'));
  const r = await hub.tool({ action: 'navigate', route: '/courses' });
  assert.deepEqual(r, { ok: true, did: 'navigate' });
  const cmd = t.events.find((e) => e.type === 'kv.ui');
  assert.equal(cmd.data.op, 'navigate');
  assert.equal(cmd.data.args.route, '/courses');
});

test('no tab open is a plain error, never a hang', async () => {
  const hub = new UiHub();
  assert.deepEqual((await hub.tool({ action: 'status' })).tabOpen, false);
  const r = await hub.tool({ action: 'click', name: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /No KinglyVault tab/);
});

test('a closed request (409) drops the tab and falls back to the other one', async () => {
  const hub = new UiHub();
  tab(hub, 'tab-older000', answerAll(hub, 'tab-older000'));
  await new Promise((r) => setTimeout(r, 5));
  tab(hub, 'tab-newer000', () => 409);
  const r = await hub.tool({ action: 'read_state' });
  assert.equal(r.ok, true);
  assert.equal(hub.tabs.size, 1);
});

test('a silent tab times out and resolves the session on detach', async () => {
  const hub = new UiHub({ commandTimeoutMs: 20 });
  const t = tab(hub, 'tab-silent00');
  const r = await hub.tool({ action: 'click', name: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not answer/);
  assert.deepEqual(await t.done, { detached: true, why: 'silent' });
  assert.equal(hub.tabs.size, 0);
});

test('a human-only answer passes through for the agent', async () => {
  const hub = new UiHub();
  tab(hub, 'tab-human000', (evs) => {
    for (const e of evs) if (e.type === 'kv.ui') queueMicrotask(() => hub.receive({ tabId: 'tab-human000', cmdId: e.data.cmdId, ok: false, result: { humanRequired: true }, error: 'Your turn' }));
    return 200;
  });
  const r = await hub.tool({ action: 'click', name: 'Upgrade' });
  assert.equal(r.humanRequired, true);
  assert.equal(r.ok, false);
});

test('panels stream as kv.panel, oversize and unknown kinds are refused', async () => {
  const hub = new UiHub();
  const t = tab(hub, 'tab-panel000');
  const r = await hub.tool({ action: 'show_panel', kind: 'markdown', title: 'Plan', markdown: '# hi' });
  assert.equal(r.ok, true);
  const ev = t.events.find((e) => e.type === 'kv.panel');
  assert.equal(ev.data.markdown, '# hi');
  assert.equal(ev.data.id, r.panelId);
  assert.equal((await hub.tool({ action: 'show_panel', kind: 'nope' })).ok, false);
  assert.match((await hub.tool({ action: 'show_panel', kind: 'html', html: 'x'.repeat(50_000) })).error, /too large/);
});

test('show_panel from this link forwards; other sessions do not', async () => {
  const hub = new UiHub();
  const t = tab(hub, 'tab-forward0');
  let fire;
  const gw = { on: (fn) => ((fire = fn), () => {}), request: async () => ({ title: 'Agents', text: 'hello', data: { rows: [] }, summary: 's' }) };
  hub.bindGateway(gw, 'abcdefgh-1234');
  fire({ event: 'chat.panel.show', payload: { kind: 'agents', panelId: 'p1', sourceSession: 'agent:main:other', query: {} } });
  fire({ event: 'chat.panel.show', payload: { kind: 'agents', panelId: 'p2', sourceSession: 'agent:main:kv-abcdefgh-cs_1', query: {} } });
  await new Promise((r) => setTimeout(r, 5));
  const panels = t.events.filter((e) => e.type === 'kv.panel');
  assert.equal(panels.length, 1);
  assert.equal(panels[0].data.id, 'p2');
  assert.equal(panels[0].data.forwarded, true);
  assert.equal(panels[0].data.text, 'hello');
});

test('forwardedPanel keeps table rows only when they fit', () => {
  const big = { rows: ['x'.repeat(30_000)] };
  assert.equal(forwardedPanel({ kind: 'table', panelId: 'a' }, { data: big, text: 't' }).data, undefined);
  assert.ok(forwardedPanel({ kind: 'table', panelId: 'a' }, { data: { rows: [] }, text: 't' }).data);
});

// node --test extensions/kinglyvault-relay/relay-link.test.mjs
// The link must never freeze: gateway calls cannot block device.pull, and a
// stuck loop is replaced. Regression for "KV shows offline, gateway is up".
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { makeStubRoot, pairedState, silentLog, startRelayStub, stubGateway, waitFor, writeState } from './relay-link.test.helpers.mjs';

process.env.INFINIBOT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kvr-link-'));
process.env.KV_RELAY_SKIP_CLAUDE_MCP = '1';
const m = await import('./relay-client.mjs');
const here = path.dirname(fileURLToPath(import.meta.url));

const wedgedGateway = () => {
  const gw = { resets: 0, stops: 0, uiUrl: null };
  gw.request = () => new Promise(() => {});
  gw.reset = () => gw.resets++;
  gw.stop = () => gw.stops++;
  gw.on = () => () => {};
  return gw;
};
const fast = { pullWaitMs: 0, pullTimeoutMs: 5000, capsFirstWaitMs: 5, capsTimeoutMs: 40, capsRefreshMs: 60 };

let relay;
let link;
let running;
const startLink = (opts) => {
  link = new m.RelayLink({ log: silentLog(), ...fast, ...opts });
  running = link.run();
  return link;
};

beforeEach(async () => {
  relay = await startRelayStub();
  writeState(pairedState(relay.url));
  fs.rmSync(path.join(m.relayDir(), 'health.json'), { force: true });
});
afterEach(async () => {
  link?.stop();
  await running;
  link = null;
  running = null;
  await relay.close();
});

test('a gateway that never answers agents.list cannot stop the heartbeats', async () => {
  startLink({ gateway: wedgedGateway() });
  await waitFor(() => relay.pulls().length >= 20, { label: '20 pulls' });
  assert.ok(relay.pulls().every((c) => c.body.waitMs === 0));
});

test('LocalGateway on a wedged gateway: requests time out and the pulls continue', async () => {
  globalThis.__kvGw = undefined;
  const gateway = new m.LocalGateway({ root: makeStubRoot(), log: silentLog(), requestTimeoutMs: 40 });
  startLink({ gateway });
  await waitFor(() => relay.pulls().length >= 10, { label: 'pulls' });
  await assert.rejects(gateway.request('agents.list', {}), /timed out/);
  assert.ok(stubGateway().calls.includes('agents.list'));
  assert.ok(stubGateway().calls.includes('coder.backends.list'));
});

test('capability refresh keeps the last good caps when the gateway stops answering', async () => {
  const gw = wedgedGateway();
  const good = { 'agents.list': { agents: [{ id: 'main', name: 'Main' }], defaultId: 'main' }, 'coder.backends.list': { backends: [{ id: 'claude-code', displayName: 'Claude' }] } };
  let wedged = false;
  gw.request = (method) => (wedged ? new Promise(() => {}) : Promise.resolve(good[method]));
  startLink({ gateway: gw });
  await waitFor(() => relay.pulls().some((c) => c.body.capabilities?.agents?.length), { label: 'caps sent' });
  wedged = true;
  const seen = relay.pulls().length;
  await waitFor(() => relay.pulls().length >= seen + 15, { label: 'pulls after wedge' });
  for (const c of relay.pulls().slice(seen)) {
    assert.deepEqual(c.body.capabilities.agents.map((a) => a.id), ['main']);
    assert.deepEqual(c.body.capabilities.coderBackends.map((b) => b.id), ['claude-code']);
  }
});

test('a half answer only replaces the list that answered', async () => {
  const gw = wedgedGateway();
  let backends = [{ id: 'claude-code', displayName: 'Claude' }];
  gw.request = (method) => {
    if (method === 'agents.list') return Promise.resolve({ agents: [{ id: 'main' }], defaultId: 'main' });
    return backends ? Promise.resolve({ backends }) : Promise.reject(new Error('slow'));
  };
  startLink({ gateway: gw });
  await waitFor(() => relay.pulls().some((c) => c.body.capabilities?.coderBackends?.length), { label: 'caps' });
  backends = null;
  const seen = relay.pulls().length;
  await waitFor(() => relay.pulls().length >= seen + 10, { label: 'more pulls' });
  assert.equal(relay.pulls().at(-1).body.capabilities.coderBackends[0].id, 'claude-code');
});

test('watchdog: a pull that never answers is aborted, the link heals and health recovers', async () => {
  let hang = true;
  relay.handlers['device.pull'] = () => (hang ? null : { body: { requests: [] } });
  const log = silentLog();
  const gateway = wedgedGateway();
  startLink({ gateway, log, watchdogMs: 120, pullTimeoutMs: 60_000 });
  await waitFor(() => gateway.resets >= 1, { label: 'watchdog' });
  await waitFor(() => relay.closedEarly >= 1, { label: 'in-flight pull aborted' });
  assert.match(log.lines.join('\n'), /no successful pull for \d+s; restarting the link/);
  const bad = m.loadHealth();
  assert.equal(bad.ok, false);
  assert.match(bad.error, /reconnecting by itself/);
  hang = false;
  await waitFor(() => m.loadHealth().ok === true, { label: 'health ok' });
  const healed = m.loadHealth();
  assert.equal(healed.error, null);
  assert.ok(healed.lastSyncAt);
  const before = gateway.resets;
  const pulls = relay.pulls().length;
  await waitFor(() => relay.pulls().length >= pulls + 10, { label: 'pulls after healing' });
  assert.equal(gateway.resets, before);
});

test('watchdog steps on a real LocalGateway: abort, log, client rebuilt, loop restarted, health recovers', async () => {
  globalThis.__kvGw = undefined;
  const log = silentLog();
  const gateway = new m.LocalGateway({ root: makeStubRoot(), log, requestTimeoutMs: 30 });
  let hang = true;
  relay.handlers['device.pull'] = () => (hang ? null : { body: { requests: [] } });
  startLink({ gateway, log, watchdogMs: 150, pullTimeoutMs: 60_000 });
  await waitFor(() => stubGateway().clients.length === 1 && gateway.client, { label: 'first client' });
  const first = stubGateway().clients[0];
  await waitFor(() => relay.pulls().length === 1, { label: 'pull in flight' });
  await waitFor(() => first.stopped, { label: 'old client stopped' });
  await waitFor(() => relay.closedEarly === 1, { label: 'pull aborted' });
  const warning = log.lines.find((l) => l.includes('no successful pull'));
  assert.ok(warning);
  await waitFor(() => relay.pulls().length >= 2, { label: 'new loop pulling' });
  await waitFor(() => stubGateway().clients.length >= 2, { label: 'client rebuilt' });
  const bad = m.loadHealth();
  assert.equal(bad.ok, false);
  hang = false;
  await waitFor(() => m.loadHealth().ok === true, { label: 'health ok' });
  assert.equal(stubGateway().clients.at(-1).stopped, false);
  console.log(`step log: ${warning}`);
  console.log(`step abort: in-flight pulls cancelled by the client = ${relay.closedEarly}`);
  console.log(`step rebuild: first client stopped = ${first.stopped}; clients created = ${stubGateway().clients.length}; newest stopped = ${stubGateway().clients.at(-1).stopped}`);
  console.log(`step loop: pulls reaching the relay after the restart = ${relay.pulls().length - 1}`);
  console.log(`step health: during ok=${bad.ok} error=${JSON.stringify(bad.error)}; after ok=${m.loadHealth().ok} error=${m.loadHealth().error}`);
});

test('watchdog replaces a loop stuck on an await that ignores abort', async () => {
  const gateway = wedgedGateway();
  link = new m.RelayLink({ log: silentLog(), ...fast, gateway, watchdogMs: 120 });
  const realPost = link.post.bind(link);
  let stuck = 0;
  link.post = (state, op, body, opts) => (op === 'device.pull' && stuck++ === 0 ? new Promise(() => {}) : realPost(state, op, body, opts));
  running = link.run();
  await waitFor(() => relay.pulls().length >= 5, { label: 'pulls from the new loop' });
  assert.equal(gateway.resets, 1);
});

test('the watchdog keeps retrying through an outage without losing the loop', async () => {
  relay.handlers['device.pull'] = () => ({ status: 503, body: { error: 'server_error' } });
  const gateway = wedgedGateway();
  startLink({ gateway, watchdogMs: 100 });
  await waitFor(() => gateway.resets >= 2, { label: 'two heals' });
  assert.equal(m.loadHealth().ok, false);
  delete relay.handlers['device.pull'];
  await waitFor(() => m.loadHealth().ok === true, { label: 'recovery', timeoutMs: 5000 });
});

test('restart() reconnects, keeps the credentials and the pulls continue', async () => {
  const gateway = wedgedGateway();
  startLink({ gateway });
  await waitFor(() => relay.pulls().length >= 3, { label: 'pulls' });
  const before = fs.readFileSync(path.join(m.relayDir(), 'state.json'), 'utf8');
  assert.equal(link.restart(), true);
  assert.equal(gateway.resets, 1);
  const seen = relay.pulls().length;
  await waitFor(() => relay.pulls().length >= seen + 5, { label: 'pulls after restart' });
  assert.equal(fs.readFileSync(path.join(m.relayDir(), 'state.json'), 'utf8'), before);
});

test('restart() cancels a hung pull straight away', async () => {
  let hang = true;
  relay.handlers['device.pull'] = () => (hang ? null : { body: { requests: [] } });
  startLink({ gateway: wedgedGateway(), pullTimeoutMs: 60_000 });
  await waitFor(() => relay.pulls().length === 1, { label: 'first pull' });
  hang = false;
  link.restart();
  await waitFor(() => relay.closedEarly === 1, { label: 'abort' });
  await waitFor(() => relay.pulls().length >= 4, { label: 'fresh pulls' });
});

test('stop() ends run() at once even with a pull in flight, and releases the lock', async () => {
  relay.handlers['device.pull'] = () => null;
  startLink({ gateway: wedgedGateway(), pullTimeoutMs: 60_000 });
  await waitFor(() => relay.pulls().length === 1, { label: 'pull' });
  link.stop();
  await running;
  assert.equal(fs.existsSync(path.join(m.relayDir(), 'link.lock')), false);
  assert.equal(link.restart(), false);
});

test('a hanging claude CLI cannot block the pulls after a rotation', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'kvr-bin-'));
  // Shim only: the real claude CLI must never see a test's `mcp remove`.
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nsleep 1\n', { mode: 0o755 });
  const realPath = process.env.PATH;
  process.env.PATH = bin;
  delete process.env.KV_RELAY_SKIP_CLAUDE_MCP;
  try {
    writeState(pairedState(relay.url, { rotatedAt: new Date(Date.now() - 13 * 3600_000).toISOString() }));
    relay.handlers['device.rotate'] = () => ({ body: { deviceSecret: 'device-secret-new', rotatedAt: new Date().toISOString(), kvMcp: { url: 'https://kv.test/mcp', token: 'x' } } });
    startLink({ gateway: wedgedGateway() });
    await waitFor(() => relay.pulls().filter((c) => c.bearer === 'Bearer device-secret-new').length >= 5, { timeoutMs: 800, label: 'pulls during the claude CLI' });
  } finally {
    process.env.PATH = realPath;
    process.env.KV_RELAY_SKIP_CLAUDE_MCP = '1';
  }
});

test('a restart during rotation keeps the rotated secret', async () => {
  writeState(pairedState(relay.url, { rotatedAt: new Date(Date.now() - 13 * 3600_000).toISOString() }));
  relay.handlers['device.rotate'] = async () => {
    await new Promise((r) => setTimeout(r, 250));
    return { body: { deviceSecret: 'device-secret-new', rotatedAt: new Date().toISOString() } };
  };
  startLink({ gateway: wedgedGateway() });
  await waitFor(() => relay.calls.some((c) => c.op === 'device.rotate'), { label: 'rotate started' });
  link.restart();
  await waitFor(() => relay.pulls().length >= 3, { label: 'pulls' });
  assert.ok(relay.pulls().every((c) => c.bearer === 'Bearer device-secret-new'));
  assert.equal(relay.calls.filter((c) => c.op === 'device.rotate').length, 1);
  assert.equal(m.loadState().deviceSecret, 'device-secret-new');
});

test('LocalGateway: concurrent callers share one client', async () => {
  globalThis.__kvGw = undefined;
  const gw = new m.LocalGateway({ root: makeStubRoot(), log: silentLog() });
  stubGateway().handlers.ping = async () => 'pong';
  const out = await Promise.all([gw.request('ping'), gw.request('ping'), gw.connect().then(() => 'ok')]);
  assert.deepEqual(out, ['pong', 'pong', 'ok']);
  assert.equal(stubGateway().clients.length, 1);
  gw.stop();
});

test('LocalGateway: a socket that closes resets it, and the next request reconnects', async () => {
  globalThis.__kvGw = undefined;
  const gw = new m.LocalGateway({ root: makeStubRoot(), log: silentLog() });
  stubGateway().handlers.ping = async () => 'pong';
  await gw.request('ping');
  const [first] = stubGateway().clients;
  first.opts.onClose(1006, '');
  assert.equal(gw.ready, null);
  assert.equal(first.stopped, true);
  assert.equal(await gw.request('ping'), 'pong');
  assert.equal(stubGateway().clients.length, 2);
  gw.stop();
});

test('LocalGateway: a connect that never finishes is abandoned, not left retrying', async () => {
  globalThis.__kvGw = undefined;
  const gw = new m.LocalGateway({ root: makeStubRoot(), log: silentLog(), connectTimeoutMs: 30 });
  stubGateway().silent = true;
  await assert.rejects(gw.connect(), /did not answer/);
  assert.equal(stubGateway().clients[0].stopped, true);
  stubGateway().silent = false;
  stubGateway().handlers.ping = async () => 'pong';
  assert.equal(await gw.request('ping'), 'pong');
  gw.stop();
});

test('LocalGateway: reset() during an open does not leave an orphan client', async () => {
  globalThis.__kvGw = undefined;
  const gw = new m.LocalGateway({ root: makeStubRoot(), log: silentLog() });
  const pending = gw.connect();
  gw.reset();
  await assert.rejects(pending, /replaced/);
  assert.equal(stubGateway().clients.length, 0);
  gw.stop();
});

test('LocalGateway: a chat turn waiting on events gets its socket back without a request', async () => {
  globalThis.__kvGw = undefined;
  const gw = new m.LocalGateway({ root: makeStubRoot(), log: silentLog() });
  const off = gw.on(() => {});
  await gw.connect();
  stubGateway().clients[0].opts.onClose(1006, '');
  await waitFor(() => stubGateway().clients.length === 2 && gw.client === stubGateway().clients[1], { label: 'reconnect' });
  off();
  gw.stop();
});

test('LocalGateway: stopped means stopped', async () => {
  globalThis.__kvGw = undefined;
  const gw = new m.LocalGateway({ root: makeStubRoot(), log: silentLog() });
  stubGateway().handlers.ping = async () => 'pong';
  await gw.request('ping');
  gw.stop();
  await assert.rejects(gw.request('ping'), /stopped/);
  assert.equal(stubGateway().clients.length, 1);
});

test('chat.send failing leaves no listener and no timer behind', async () => {
  const gw = wedgedGateway();
  let listening = 0;
  gw.on = () => (listening++, () => listening--);
  gw.request = async () => {
    throw new Error('gateway not connected');
  };
  await assert.rejects(m.runAction('chat.send', { agentId: 'main', message: 'hi' }, { gw, state: pairedState('http://x/'), emit: async () => {} }), /not connected/);
  assert.equal(listening, 0);
});

test('relayCall: a body cut off by the timeout is an error, not an empty 200', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"requests":[');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  await assert.rejects(m.relayCall(url, {}, 'x', { timeoutMs: 60 }), { name: 'AbortError' });
  const ctl = new AbortController();
  const call = m.relayCall(url, {}, 'x', { timeoutMs: 5000, signal: ctl.signal });
  setTimeout(() => ctl.abort(), 30);
  await assert.rejects(call, { name: 'AbortError' });
  server.closeAllConnections();
  server.close();
});

// The real client from a build, when there is one: silence after hello trips
// its tick watch, and LocalGateway must reconnect on the next request.
const realRoot = path.resolve(here, '..', '..');
const hasBuild = fs.existsSync(path.join(realRoot, 'dist/gateway/client.js'));

test('real GatewayClient: a half-open socket is replaced on the next request', { skip: !hasBuild }, async () => {
  const conns = [];
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  wss.on('connection', (socket) => {
    conns.push(socket);
    socket.on('message', (data) => {
      const f = JSON.parse(String(data));
      if (f.method === 'connect') {
        socket.send(JSON.stringify({ type: 'res', id: f.id, ok: true, payload: { type: 'hello-ok', protocol: 3, server: { version: 'dev', connId: `c${conns.length}` }, features: { methods: [], events: [] }, snapshot: { presence: [], health: {}, stateVersion: { presence: 1, health: 1 }, uptimeMs: 1 }, policy: { maxPayload: 1048576, maxBufferedBytes: 1048576, tickIntervalMs: 200 } } }));
      } else if (f.method === 'ping' && conns.at(-1) === socket && conns.length > 1) {
        socket.send(JSON.stringify({ type: 'res', id: f.id, ok: true, payload: { pong: true } }));
      }
      // First connection: never answers anything after hello, and sends no ticks.
    });
  });
  m.setGatewayConnection({ url: `ws://127.0.0.1:${wss.address().port}`, token: 'x' });
  const gw = new m.LocalGateway({ root: realRoot, log: silentLog(), requestTimeoutMs: 300 });
  try {
    await assert.rejects(gw.request('ping', {}), /timed out/);
    await waitFor(() => gw.ready === null, { timeoutMs: 8000, label: 'tick timeout closes the socket' });
    gw.requestTimeoutMs = 3000;
    assert.deepEqual(await gw.request('ping', {}), { pong: true });
    assert.equal(conns.length, 2);
  } finally {
    gw.stop();
    m.setGatewayConnection(null);
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
  }
});

// Standalone mode is the same RelayLink in its own process, where a stuck await
// would otherwise look like a clean exit once nothing holds the event loop open.
test('standalone `run`: keeps pulling on a wedged gateway and exits cleanly on SIGTERM', async () => {
  const child = spawn(process.execPath, [path.join(here, 'relay-client.mjs'), 'run'], {
    env: { PATH: process.env.PATH, HOME: process.env.INFINIBOT_STATE_DIR, INFINIBOT_STATE_DIR: process.env.INFINIBOT_STATE_DIR, INFINIBOT_ROOT: makeStubRoot(), KV_RELAY_SKIP_CLAUDE_MCP: '1' },
    stdio: 'ignore',
  });
  const exited = new Promise((r) => child.once('exit', (code, sig) => r({ code, sig })));
  try {
    await waitFor(() => relay.pulls().length >= 10, { timeoutMs: 8000, label: 'standalone pulls' });
  } finally {
    child.kill('SIGTERM');
  }
  assert.deepEqual(await Promise.race([exited, new Promise((r) => setTimeout(() => r('still running'), 2000))]), { code: 0, sig: null });
});

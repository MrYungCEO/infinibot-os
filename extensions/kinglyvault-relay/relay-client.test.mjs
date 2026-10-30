// node --test extensions/kinglyvault-relay/relay-client.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.INFINIBOT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kvr-test-'));
const m = await import('./relay-client.mjs');

const token = 'test-token-0123456789abcdef0123456789';
const state = { token, grantedScopes: ['chat', 'coder.spawn'] };
const env = (over = {}) => {
  const e = { id: 'req-1', nonce: `n-${Math.random()}`, ts: Date.now(), action: 'chat.send', scope: 'chat', paramsJson: '{"agentId":"main","message":"hi"}', ...over };
  return { ...e, sig: m.signEnvelope(e, token) };
};

test('shared signing vector matches KinglyVault (infinibotRelay.test.ts)', () => {
  const sig = m.signEnvelope({ id: 'req-1', nonce: 'n-1', ts: 1761566400000, action: 'chat.send', paramsJson: '{"agentId":"main","message":"hi"}' }, token);
  assert.equal(sig, '676f8963d645fdf6a2d915ac36a26a5020bc7545e03361c184dc01cb2230afc8');
});

test('accepts a valid envelope once, then rejects the replay', () => {
  const e = env();
  assert.equal(m.verifyEnvelope(e, state).ok, true);
  assert.equal(m.verifyEnvelope(e, state).reason, 'replayed nonce');
});

test('rejects tampered params, wrong token, stale timestamps', () => {
  assert.equal(m.verifyEnvelope({ ...env(), paramsJson: '{"agentId":"main","message":"evil"}' }, state).reason, 'bad signature');
  assert.equal(m.verifyEnvelope(env(), { ...state, token: 'x'.repeat(40) }).reason, 'bad signature');
  assert.equal(m.verifyEnvelope(env({ ts: Date.now() - 10 * 60_000 }), state).reason, 'stale envelope');
});

test('enforces locally granted scopes and known actions only', () => {
  assert.match(m.verifyEnvelope(env({ action: 'ui.navigate', scope: 'ui.navigate', paramsJson: '{"route":"/chat"}' }), state).reason, /not granted/);
  assert.match(m.verifyEnvelope(env({ action: 'exec', scope: 'chat' }), state).reason, /unknown action/);
  // KV claims a scope that does not authorize the action.
  assert.match(m.verifyEnvelope(env({ action: 'coder.spawn', scope: 'chat', paramsJson: '{"backend":"claude-code","task":"x"}' }), state).reason, /not granted/);
});

test('coder folders are limited to the local allowlist', () => {
  const p = m.loadPolicy();
  assert.equal(m.resolveWorkdir(undefined, p).ok, true);
  assert.equal(m.resolveWorkdir('/etc', p).ok, false);
  assert.equal(m.resolveWorkdir(path.join(m.workspacesDir(), '..', '..'), p).ok, false);
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'kvr-allowed-'));
  assert.equal(m.resolveWorkdir(allowed, { allowedWorkdirs: [...p.allowedWorkdirs, allowed] }).ok, true);
  // A symlink inside an allowed folder that escapes it is refused.
  fs.symlinkSync('/etc', path.join(allowed, 'escape'));
  assert.equal(m.resolveWorkdir(path.join(allowed, 'escape'), { allowedWorkdirs: [allowed] }).ok, false);
});

// ── Agent D: shared memory (kv.context kind 'learning' → kv_learning_context) ──
test('kv.context kind learning calls kv_learning_context as the member', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.authorization, name: body.params.name, args: body.params.arguments });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { shared: true, path: { id: 'web-agency' } } } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const st = { ...state, grantedScopes: ['kv.read'], kvMcp: { url: 'https://kv.example/functions/v1/kv-mcp', token: 'kvmcp-token' } };
    const out = await m.runAction('kv.context', { kind: 'learning' }, { gw: {}, state: st, emit: async () => {}, scope: 'kv.read' });
    assert.deepEqual(out, { shared: true, path: { id: 'web-agency' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'kv_learning_context');
    assert.deepEqual(calls[0].args, {});
    assert.equal(calls[0].auth, 'Bearer kvmcp-token');
  } finally {
    globalThis.fetch = realFetch;
  }
});

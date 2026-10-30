// node --test extensions/kinglyvault-relay/kv-access.test.mjs
// Upgrade access on the device: a fresh kv-mcp token applies with no restart.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

process.env.INFINIBOT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kvr-access-'));
process.env.KV_RELAY_SKIP_CLAUDE_MCP = '1'; // never touch the real Claude Code entry from a test
const m = await import('./relay-client.mjs');

const realFetch = globalThis.fetch;
const state = { relayUrl: 'https://relay.test/fn', deviceSecret: 'dev-secret', token: 't', account: 'a', connectionId: 'c1', kvMcp: { url: 'https://kv.test/mcp', token: 'old' }, grantedScopes: ['chat', 'kv.read'] };
const stateFile = () => path.join(m.relayDir(), 'state.json');

beforeEach(() => {
  fs.mkdirSync(m.relayDir(), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(state));
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('fetches the new token with the device secret and applies it live', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ kvMcp: { url: 'https://kv.test/mcp', token: 'new', expiresAt: 'x' }, grantedScopes: ['chat', 'kv.read', 'kv.write'] }), { status: 200 });
  };
  const out = await m.refreshKvToken(m.loadState(), { warn() {} });
  assert.deepEqual(out.scopes, ['chat', 'kv.read', 'kv.write']);
  assert.equal(JSON.parse(calls[0].init.body).op, 'device.kv.refresh');
  assert.match(JSON.stringify(calls[0].init.headers), /dev-secret/);
  const after = m.loadState();
  assert.equal(after.kvMcp.token, 'new');
  assert.equal(after.token, 't'); // the envelope token and device secret are untouched
  assert.equal(after.deviceSecret, 'dev-secret');
});

test('merges onto the newest state, so a rotation in the pull loop is not overwritten', async () => {
  globalThis.fetch = async () => {
    fs.writeFileSync(stateFile(), JSON.stringify({ ...state, token: 'rotated', deviceSecret: 'rotated-secret' }));
    return new Response(JSON.stringify({ kvMcp: { url: 'u', token: 'new' }, grantedScopes: ['kv.read', 'kv.write'] }), { status: 200 });
  };
  await m.refreshKvToken(m.loadState(), { warn() {} });
  const after = m.loadState();
  assert.equal(after.token, 'rotated');
  assert.equal(after.deviceSecret, 'rotated-secret');
  assert.equal(after.kvMcp.token, 'new');
});

test('keeps the current token when the refresh fails', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 });
  await assert.rejects(m.refreshKvToken(m.loadState(), { warn() {} }));
  assert.equal(m.loadState().kvMcp.token, 'old');
});

test('a link holding only an old scope accepts the refresh envelope', () => {
  const e = { id: 'r1', nonce: 'n-refresh', ts: Date.now(), action: 'kv.token.refresh', scope: 'chat', paramsJson: '{}' };
  assert.equal(m.verifyEnvelope({ ...e, sig: m.signEnvelope(e, 't') }, state).ok, true);
  assert.match(m.scopeText('kv.admin'), /audit-logged/);
});

test('kvMcpTools filters by query and reports read-only', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ result: { tools: [
    { name: 'kv_create_my_note', description: 'Create a note', inputSchema: {}, annotations: { readOnlyHint: false } },
    { name: 'kv_search', description: 'Search', inputSchema: {}, annotations: { readOnlyHint: true } },
  ] } }), { status: 200 });
  const t = await m.kvMcpTools(state, 'NOTE');
  assert.deepEqual(t.map((x) => x.name), ['kv_create_my_note']);
  assert.equal(t[0].readOnly, false);
  assert.equal((await m.kvMcpTools(state)).length, 2);
});

// node --test extensions/kinglyvault-relay/brains.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.INFINIBOT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kvr-brains-'));
process.env.KV_RELAY_SKIP_CLAUDE_MCP = '1';
const b = await import('./brains.mjs');
const m = await import('./relay-client.mjs');

const MODELS = {
  models: [
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic', available: true },
    { id: 'gpt-5', name: 'GPT-5', provider: 'openai', available: false },
    { id: 'qwen3:8b', name: 'Qwen3 8B', provider: 'ollama', available: true, free: 'local' },
    { id: 'blocked', name: 'Not in allowlist', provider: 'anthropic', available: true, allowed: false },
    { id: '__setup__', name: 'Ollama Cloud — not connected', provider: 'ollama-cloud', unconfigured: true },
    { id: 'sonnet', name: 'dup from catalog', provider: 'claude-cli' },
  ],
  providers: [{ id: 'anthropic', available: true }, { id: 'openai', available: false }, { id: 'ollama', available: true }],
};
const CLI = {
  available: true,
  backends: [
    { id: 'claude-cli', label: 'Claude Code', installed: true, auth: 'signed-in', ready: true, model: 'sonnet', apiKey: 'sk-should-not-leak' },
    { id: 'codex-cli', label: 'Codex CLI', installed: true, auth: 'signed-out', ready: false, binPath: '/home/me/.secret/bin/codex' },
    { id: 'gemini-cli', label: 'Gemini CLI', installed: false, auth: 'unknown', ready: false },
  ],
};
const DEFAULTS = { modelProvider: 'anthropic', model: 'claude-sonnet-4-5' };
const catalog = () => b.buildBrainCatalog({ models: MODELS, cli: CLI, defaults: DEFAULTS, kind: 'desktop', now: 0 });

test('catalogue lists API, CLI and local brains with availability and the default', () => {
  const c = catalog();
  assert.equal(c.kind, 'desktop');
  assert.deepEqual(c.default, { provider: 'anthropic', model: 'claude-sonnet-4-5', ref: 'anthropic/claude-sonnet-4-5' });
  const by = Object.fromEntries(c.providers.map((p) => [p.id, p]));
  assert.equal(by.anthropic.available, true);
  assert.deepEqual(by.anthropic.models.map((x) => x.id), ['claude-sonnet-4-5']); // allowlist-blocked one dropped
  assert.equal(by.openai.available, false);
  assert.equal(by.openai.status, 'no-key');
  assert.equal(by.ollama.kind, 'local');
  assert.equal(by['claude-cli'].kind, 'cli');
  assert.equal(by['claude-cli'].available, true);
  assert.deepEqual(by['claude-cli'].models.map((x) => x.id), ['default', 'sonnet', 'opus', 'haiku']);
  assert.equal(by['codex-cli'].status, 'signed-out');
  assert.equal(by['gemini-cli'].status, 'not-installed');
  // Available first.
  assert.equal(c.providers.findIndex((p) => !p.available) > c.providers.findIndex((p) => p.id === 'ollama'), true);
});

test('catalogue carries no secrets, paths or auth details', () => {
  const json = JSON.stringify(catalog());
  assert.doesNotMatch(json, /sk-should-not-leak|\.secret|binPath|apiKey/);
});

test('catalogue stays small for big providers', () => {
  const many = { models: Array.from({ length: 500 }, (_, i) => ({ id: `m-${i}`, name: `M ${i}`, provider: 'openrouter', available: true })) };
  const c = b.buildBrainCatalog({ models: many });
  const g = c.providers.find((p) => p.id === 'openrouter');
  assert.equal(g.models.length, b.MAX_MODELS_PER_PROVIDER);
  assert.equal(g.total, 500);
  // A trimmed-but-valid id is still allowed through (the gateway re-validates).
  assert.equal(b.resolveBrainChoice(c, { provider: 'openrouter', model: 'm-499' }).kind, 'ok');
});

test('shared cloud: CLI brains are listed but unavailable', () => {
  const c = b.buildBrainCatalog({ models: MODELS, cli: { ...CLI, available: false }, kind: 'cloud' });
  const g = c.providers.find((p) => p.id === 'claude-cli');
  assert.equal(g.available, false);
  assert.equal(g.status, 'unavailable-here');
  assert.match(b.resolveBrainChoice(c, { provider: 'claude-cli', model: 'opus' }).reason, /can't run/);
});

test('resolveBrainChoice: none / default / ok / unavailable', () => {
  const c = catalog();
  assert.deepEqual(b.resolveBrainChoice(c, {}), { kind: 'none' });
  assert.deepEqual(b.resolveBrainChoice(c, { model: 'default' }), { kind: 'default' });
  assert.equal(b.resolveBrainChoice(c, { provider: 'claude-cli', model: 'opus' }).ref, 'claude-cli/opus');
  assert.equal(b.resolveBrainChoice(c, { model: 'ollama/qwen3:8b' }).ref, 'ollama/qwen3:8b');
  assert.equal(b.resolveBrainChoice(c, { model: 'claude-sonnet-4-5' }).provider, 'anthropic');
  assert.match(b.resolveBrainChoice(c, { provider: 'openai', model: 'gpt-5' }).reason, /no API key/);
  assert.match(b.resolveBrainChoice(c, { provider: 'codex-cli', model: 'default' }).reason, /not signed in/);
  assert.match(b.resolveBrainChoice(c, { provider: 'mistral', model: 'x' }).reason, /not set up/);
  assert.match(b.resolveBrainChoice(c, { provider: 'anthropic', model: 'claude-opus-9' }).reason, /not available/);
  assert.match(b.resolveBrainChoice(c, { provider: 'anthropic', model: 'bad model; rm -rf' }).reason, /not valid/);
});

test('brainsDigest ignores the timestamp but sees real changes', () => {
  const a = b.buildBrainCatalog({ models: MODELS, cli: CLI, defaults: DEFAULTS, now: 0 });
  const a2 = b.buildBrainCatalog({ models: MODELS, cli: CLI, defaults: DEFAULTS, now: 99_999 });
  const c = b.buildBrainCatalog({ models: MODELS, cli: { ...CLI, backends: CLI.backends.map((x) => ({ ...x, ready: true })) }, defaults: DEFAULTS });
  assert.equal(b.brainsDigest(a), b.brainsDigest(a2));
  assert.notEqual(b.brainsDigest(a), b.brainsDigest(c));
});

test('instanceKind: cloud machines vs desktops', () => {
  assert.equal(b.instanceKind({}), 'desktop');
  assert.equal(b.instanceKind({ FLEET_TENANT_ID: 't1' }), 'cloud');
  assert.equal(b.instanceKind({ FLY_APP_NAME: 'ib-x' }), 'cloud');
  assert.equal(b.instanceKind({ SAAS_MODE: '1' }), 'cloud');
});

// ── the relay honours { model, provider } ──────────────────────────────

function fakeGw({ patchFails = new Set(), olderGateway = false } = {}) {
  const calls = [];
  const listeners = new Set();
  return {
    calls,
    uiUrl: null,
    on: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'models.list') return MODELS;
      if (method === 'cliRouting.status') {
        if (olderGateway) throw new Error('unknown method');
        return CLI;
      }
      if (method === 'sessions.list') return { defaults: DEFAULTS, sessions: [] };
      if (method === 'agents.list') return { agents: [{ id: 'main', name: 'Main', model: 'anthropic/claude-sonnet-4-5' }], defaultId: 'main' };
      if (method === 'coder.backends.list') return { backends: [{ id: 'claude-code', displayName: 'Claude Code', install: { installed: true } }] };
      if (method === 'sessions.patch') {
        if (params.model && patchFails.has(params.model)) throw new Error('model not allowed');
        return { ok: true };
      }
      if (method === 'chat.send') {
        const runId = 'run-1';
        queueMicrotask(() => {
          for (const l of listeners) l({ event: 'chat', payload: { sessionKey: params.sessionKey, runId, state: 'final', message: { content: [{ type: 'text', text: 'hi back' }] } } });
        });
        return { runId };
      }
      throw new Error(`unexpected ${method}`);
    },
    async tool(name, args) {
      calls.push([`tool:${name}`, args]);
      return { runId: 'r-123' };
    },
  };
}

const relayState = { connectionId: 'conn-12345678', grantedScopes: ['chat', 'agents.spawn', 'coder.spawn'] };
const patches = (gw) => gw.calls.filter(([meth]) => meth === 'sessions.patch').map(([, p]) => p.model);

test('backwards compat: old KV clients (no model) never touch the session model', async () => {
  m.resetBrainsForTests();
  const gw = fakeGw();
  const out = await m.runAction('chat.send', { agentId: 'main', message: 'hi' }, { gw, state: relayState, emit: async () => {} });
  assert.equal(out.text, 'hi back');
  assert.equal(out.brain, undefined);
  assert.deepEqual(patches(gw), []);
});

test('chat.send runs on the picked brain', async () => {
  m.resetBrainsForTests();
  const gw = fakeGw();
  const out = await m.runAction('chat.send', { agentId: 'main', message: 'hi', provider: 'claude-cli', model: 'opus' }, { gw, state: relayState, emit: async () => {} });
  assert.deepEqual(patches(gw), ['claude-cli/opus']);
  assert.equal(out.brain.ref, 'claude-cli/opus');
  assert.equal(out.brain.fallback, false);
});

test('chat.send falls back to the default with a notice when the model is unavailable', async () => {
  m.resetBrainsForTests();
  const gw = fakeGw();
  const events = [];
  const out = await m.runAction('chat.send', { agentId: 'main', message: 'hi', provider: 'codex-cli', model: 'default' }, { gw, state: relayState, emit: async (e) => events.push(...e) });
  assert.deepEqual(patches(gw), [null]);
  assert.equal(out.brain.fallback, true);
  assert.equal(out.brain.ref, 'anthropic/claude-sonnet-4-5');
  assert.match(events[0].text, /not signed in.*Using Anthropic · Claude Sonnet 4\.5 instead/);
});

test('chat.send falls back when the gateway itself refuses the model', async () => {
  m.resetBrainsForTests();
  const gw = fakeGw({ patchFails: new Set(['ollama/qwen3:8b']) });
  const out = await m.runAction('chat.send', { agentId: 'main', message: 'hi', model: 'ollama/qwen3:8b' }, { gw, state: relayState, emit: async () => {} });
  assert.deepEqual(patches(gw), ['ollama/qwen3:8b', null]);
  assert.equal(out.brain.fallback, true);
  assert.match(out.brain.reason, /refused here/);
});

test('strictModel: unavailable model is a clear error, not a silent switch', async () => {
  m.resetBrainsForTests();
  const gw = fakeGw();
  await assert.rejects(
    m.runAction('chat.send', { agentId: 'main', message: 'hi', provider: 'openai', model: 'gpt-5', strictModel: true }, { gw, state: relayState, emit: async () => {} }),
    /OpenAI has no API key on this InfiniBot\. Pick another model/,
  );
  assert.equal(gw.calls.some(([meth]) => meth === 'chat.send'), false);
});

test('"default" resets the session to this InfiniBot default', async () => {
  m.resetBrainsForTests();
  const gw = fakeGw();
  const out = await m.runAction('chat.send', { agentId: 'main', message: 'hi', model: 'default' }, { gw, state: relayState, emit: async () => {} });
  assert.deepEqual(patches(gw), [null]);
  assert.equal(out.brain.fallback, false);
});

test('agents.spawn passes a validated model; coder.spawn passes the CLI model flag', async () => {
  m.resetBrainsForTests();
  const gw = fakeGw();
  await m.runAction('agents.spawn', { task: 't', model: 'ollama/qwen3:8b' }, { gw, state: relayState, emit: async () => {} });
  assert.equal(gw.calls.find(([meth]) => meth === 'tool:sessions_spawn')[1].model, 'ollama/qwen3:8b');
  const policy = m.loadPolicy();
  const out = await m.runAction('coder.spawn', { backend: 'claude-code', task: 't', provider: 'claude-cli', model: 'opus' }, { gw, state: relayState, emit: async () => {}, policy });
  assert.equal(gw.calls.find(([meth]) => meth === 'tool:claude_coder')[1].model, 'opus');
  assert.equal(out.brain.ref, 'claude-cli/opus');
  // A mismatched provider never reaches the coder.
  await m.runAction('coder.spawn', { backend: 'claude-code', task: 't', provider: 'openai', model: 'gpt-5' }, { gw, state: relayState, emit: async () => {}, policy });
  assert.equal(gw.calls.filter(([meth]) => meth === 'tool:claude_coder')[1][1].model, undefined);
});

test('capabilities advertise brains; an older gateway without cliRouting still works', async () => {
  m.resetBrainsForTests();
  const caps = await m.runAction('agents.list', {}, { gw: fakeGw(), state: relayState, emit: async () => {} });
  assert.equal(caps.instanceKind, 'desktop');
  assert.equal(caps.agents[0].id, 'main');
  assert.ok(caps.brains.providers.some((p) => p.id === 'claude-cli' && p.available));
  m.resetBrainsForTests();
  const old = await m.runAction('brains.list', {}, { gw: fakeGw({ olderGateway: true }), state: relayState, emit: async () => {} });
  assert.ok(old.brains.providers.some((p) => p.id === 'anthropic'));
  assert.ok(old.brains.providers.find((p) => p.id === 'claude-cli')); // from models.list then
});

test('brains.list is a known, scope-checked action', () => {
  const token = 'test-token-0123456789abcdef0123456789';
  const e = { id: 'req-b', nonce: `n-${Math.random()}`, ts: Date.now(), action: 'brains.list', scope: 'chat', paramsJson: '{}' };
  assert.equal(m.verifyEnvelope({ ...e, sig: m.signEnvelope(e, token) }, { token, grantedScopes: ['chat'] }).ok, true);
  const e2 = { ...e, nonce: `n-${Math.random()}`, scope: 'ui.navigate' };
  assert.equal(m.verifyEnvelope({ ...e2, sig: m.signEnvelope(e2, token) }, { token, grantedScopes: ['ui.navigate'] }).ok, false);
});

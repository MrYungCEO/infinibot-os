// node --test extensions/kinglyvault-relay/cli-sessions.test.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.INFINIBOT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kvcs-test-'));
const cs = await import('./cli-sessions.mjs');
const relay = await import('./relay-client.mjs');

const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'kvcs-allowed-'));
const other = fs.mkdtempSync(path.join(os.tmpdir(), 'kvcs-other-'));

/** child_process.spawn stand-in: records argv/stdin, replays scripted JSON lines. */
function fakeSpawn(script) {
  const calls = [];
  const fn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.pid = 999_999;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const call = { bin, args, cwd: opts.cwd, stdin: undefined };
    calls.push(call);
    child.kill = () => child.emit('close', null, 'SIGTERM');
    child.stdin = {
      end: (data) => {
        call.stdin = data;
        const lines = script(call, calls.length);
        setImmediate(() => {
          if (lines === 'hang') return;
          for (const l of lines) child.stdout.emit('data', `${JSON.stringify(l)}\n`);
          child.emit('close', 0, null);
        });
      },
    };
    return child;
  };
  fn.calls = calls;
  return fn;
}

function manager(opts = {}) {
  let allowList = [allowed];
  const resolve = (dir) => {
    const d = dir || allowed;
    return allowList.some((a) => d === a || d.startsWith(a + path.sep)) ? { ok: true, dir: d } : { ok: false, reason: `folder ${d} is not allowed` };
  };
  const m = new cs.CliSessionManager({
    store: new cs.CliSessionStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'kvcs-store-')) }),
    resolveFolder: resolve,
    isFolderAllowed: (d) => resolve(d).ok,
    findBin: (b) => `/fake/bin/${b}`,
    bypass: () => true,
    ...opts,
  });
  m.revoke = () => {
    allowList = [];
  };
  return m;
}

const claudeTurn = (sid, text) => [
  { type: 'system', subtype: 'init', session_id: sid },
  { type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x/a.ts' } }, { type: 'text', text }] } },
  { type: 'result', subtype: 'success', session_id: sid, result: text },
];

test('Claude Code: create spawns nothing; turn 1 uses --session-id, turn 2 resumes the SAME id', async () => {
  const spawn = fakeSpawn((call) => claudeTurn(call.args[call.args.indexOf('--session-id') + 1] || call.args[call.args.indexOf('--resume') + 1], `echo:${call.stdin}`));
  const m = manager({ spawn });
  const s = m.create({ backend: 'claude-code', folder: allowed, title: 'Test' });
  assert.equal(spawn.calls.length, 0, 'creating a session must not start a run');
  const r1 = await m.send(s.id, 'remember PINEAPPLE');
  const r2 = await m.send(s.id, 'what word?');
  assert.equal(spawn.calls.length, 2);
  const [a, b] = spawn.calls;
  const sid = a.args[a.args.indexOf('--session-id') + 1];
  assert.match(sid, /^[0-9a-f-]{36}$/);
  assert.ok(!a.args.includes('--resume'));
  assert.equal(b.args[b.args.indexOf('--resume') + 1], sid, 'second turn resumes the same Claude session');
  assert.ok(!b.args.includes('--session-id'));
  assert.equal(a.cwd, allowed);
  assert.equal(a.stdin, 'remember PINEAPPLE', 'message goes on stdin, never argv');
  assert.equal(r1.text, 'echo:remember PINEAPPLE');
  assert.equal(r2.session.turns, 2);
  assert.equal(m.list().sessions.length, 1, 'no new session per message');
  const h = m.history(s.id).history;
  assert.deepEqual(h.filter((e) => e.role !== 'event').map((e) => e.role), ['user', 'assistant', 'user', 'assistant']);
  assert.ok(h.some((e) => e.role === 'event' && e.text === 'Read: /x/a.ts'));
});

test('Codex: turn 1 captures thread_id, turn 2 runs `exec resume <thread_id> -`', async () => {
  const spawn = fakeSpawn((call) => [
    { type: 'thread.started', thread_id: 'thr-123' },
    { type: 'item.completed', item: { type: 'agent_message', text: `ok ${call.stdin}` } },
    { type: 'turn.completed' },
  ]);
  const m = manager({ spawn });
  const s = m.create({ backend: 'codex', folder: allowed });
  await m.send(s.id, 'one');
  await m.send(s.id, 'two');
  const [a, b] = spawn.calls;
  assert.ok(!a.args.includes('resume'));
  assert.deepEqual(b.args.slice(b.args.indexOf('resume'), b.args.indexOf('resume') + 3), ['resume', 'thr-123', '-']);
  assert.equal(b.stdin, 'two');
});

test('OpenCode resumes with --session; a failed first turn does not mark the session resumable', async () => {
  let n = 0;
  const spawn = fakeSpawn(() => {
    n += 1;
    if (n === 1) return [{ type: 'error', sessionID: 'ses_bad', error: { data: { message: 'credits' } } }];
    return [{ type: 'text', sessionID: 'ses_ok', part: { text: 'hi' } }];
  });
  const m = manager({ spawn });
  const s = m.create({ backend: 'opencode', folder: allowed });
  await assert.rejects(m.send(s.id, 'one'), /credits/);
  await m.send(s.id, 'two');
  await m.send(s.id, 'three');
  assert.ok(!spawn.calls[1].args.includes('--session'), 'failed turn 1 → turn 2 starts fresh');
  assert.equal(spawn.calls[2].args[spawn.calls[2].args.indexOf('--session') + 1], 'ses_ok');
});

test('allow-dir rule: create refuses other folders; revoking hides the session and blocks turns', async () => {
  const m = manager({ spawn: fakeSpawn(() => []) });
  assert.throws(() => m.create({ backend: 'claude-code', folder: other }), /not allowed/);
  const s = m.create({ backend: 'claude-code', folder: allowed });
  m.revoke();
  assert.equal(m.list().sessions.length, 0);
  await assert.rejects(m.send(s.id, 'hi'), /No such session/);
});

test('one turn at a time per session; stop kills the running turn', async () => {
  const spawn = fakeSpawn(() => 'hang');
  const m = manager({ spawn });
  const s = m.create({ backend: 'claude-code', folder: allowed });
  const first = m.send(s.id, 'long job');
  await new Promise((r) => setImmediate(r));
  await assert.rejects(m.send(s.id, 'again'), /still answering/);
  assert.equal(m.list().sessions[0].status, 'running');
  const origKill = process.kill;
  process.kill = () => {
    throw new Error('no group');
  };
  try {
    assert.deepEqual(m.stop(s.id), { stopped: true });
  } finally {
    process.kill = origKill;
  }
  await assert.rejects(first, /Stopped/);
  assert.equal(spawn.calls.length, 1);
});

test('sessions persist across a new store/manager (relay reconnect), interrupted turns become idle', async () => {
  const m = manager({ spawn: fakeSpawn((c) => claudeTurn(c.args[c.args.indexOf('--session-id') + 1], 'ok')) });
  const s = m.create({ backend: 'claude-code', folder: allowed, title: 'Keep me' });
  await m.send(s.id, 'hi');
  m.store.update(s.id, { status: 'running', pid: 2 ** 22 + 12345, ownerPid: 2 ** 22 + 12346 });
  const again = new cs.CliSessionStore({ dir: m.store.dir });
  const got = again.get(s.id);
  assert.equal(got.title, 'Keep me');
  assert.equal(got.status, 'idle');
  assert.equal(got.nativeStarted, true);
});

test('rename + archive; archived sessions are hidden unless asked for and refuse turns', async () => {
  const m = manager({ spawn: fakeSpawn(() => []) });
  const s = m.create({ backend: 'codex', folder: allowed });
  assert.equal(m.rename(s.id, '  Landing page\nwork ').title, 'Landing page work');
  m.archive(s.id);
  assert.equal(m.list().sessions.length, 0);
  assert.equal(m.list({ includeArchived: true }).sessions.length, 1);
  await assert.rejects(m.send(s.id, 'x'), /archived/);
  m.archive(s.id, false);
  assert.equal(m.list().sessions.length, 1);
});

test('agent sessions go through the gateway agent turn; helpers are listed and take follow-ups', async () => {
  const turns = [];
  const delivered = [];
  const m = manager({
    agentTurn: async (s, msg) => {
      turns.push([s.id, msg]);
      return { text: `agent:${msg}` };
    },
    helperMessage: async (s, msg) => {
      delivered.push([s.runId, msg]);
      return { ok: true };
    },
  });
  const a = m.create({ backend: 'agent', agentId: 'main' });
  await m.send(a.id, 'one');
  await m.send(a.id, 'two');
  assert.deepEqual(turns.map((t) => t[0]), [a.id, a.id], 'both turns land in the same agent session');
  const h = m.recordHelper({ runId: 'run-9', backend: 'claude-code', folder: allowed, title: 'Stuck tutor helper' });
  assert.equal(m.recordHelper({ runId: 'run-9' }).id, h.id, 'recording twice keeps one entry');
  assert.equal(h.kind, 'helper');
  await m.send(h.id, 'also add tests');
  assert.deepEqual(delivered, [['run-9', 'also add tests']]);
  m.helperFinished('run-9', { status: 'verified', summary: 'Done' });
  assert.equal(m.list().sessions.find((x) => x.id === h.id).status, 'done');
});

test('parseTurnLine streams Claude partial deltas without double-counting the final message', () => {
  const t = { text: '', events: [], final: null, error: null, streamed: false };
  cs.parseTurnLine('claude-code', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } }), t);
  cs.parseTurnLine('claude-code', JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo' } } }), t);
  cs.parseTurnLine('claude-code', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } }), t);
  assert.equal(t.text, 'Hello');
  cs.parseTurnLine('claude-code', JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }), t);
  assert.match(t.error, /error_max_turns/);
});

test('bypass off → no skip-permissions flags (tools.coder.autoApprove = never)', () => {
  const c = cs.buildTurnArgs('claude-code', { nativeId: 'x', nativeStarted: false, bypass: false, message: 'm' });
  assert.ok(!c.args.includes('--dangerously-skip-permissions'));
  assert.ok(c.args.includes('acceptEdits'));
  const x = cs.buildTurnArgs('codex', { nativeId: null, nativeStarted: false, bypass: false, message: 'm' });
  assert.ok(!x.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(x.args.includes('sandbox_mode=workspace-write'));
});

// ── relay scopes ──────────────────────────────────────────────────────

test('relay: the envelope scope must match the session kind', async () => {
  const m = manager({ spawn: fakeSpawn((c) => claudeTurn(c.args[c.args.indexOf('--session-id') + 1], 'ok')), agentTurn: async () => ({ text: 'hi' }) });
  relay.resetSessionsForTests(m);
  const emit = async () => {};
  const chatOnly = { grantedScopes: ['chat'] };
  await assert.rejects(relay.runSessionAction('cli.sessions.create', { backend: 'claude-code', folder: allowed }, { gw: {}, state: chatOnly, emit, scope: 'chat' }), /coder\.spawn/);
  const agent = await relay.runSessionAction('cli.sessions.create', { backend: 'agent', agentId: 'main' }, { gw: {}, state: chatOnly, emit, scope: 'chat' });
  assert.equal(agent.session.kind, 'agent');

  const full = { grantedScopes: ['chat', 'coder.spawn'] };
  const cli = await relay.runSessionAction('cli.sessions.create', { backend: 'claude-code', folder: allowed }, { gw: {}, state: full, emit, scope: 'coder.spawn' });
  // A chat-scoped envelope cannot drive the CLI session …
  await assert.rejects(relay.runSessionAction('cli.sessions.send', { id: cli.session.id, message: 'x' }, { gw: {}, state: full, emit, scope: 'chat' }), /needs the coder\.spawn/);
  // … the coder.spawn one can.
  const ok = await relay.runSessionAction('cli.sessions.send', { id: cli.session.id, message: 'x' }, { gw: {}, state: full, emit, scope: 'coder.spawn' });
  assert.equal(ok.text, 'ok');
  // chat-only links never even see CLI sessions in the list.
  const listed = await relay.runSessionAction('cli.sessions.list', {}, { gw: {}, state: chatOnly, emit, scope: 'chat' });
  assert.deepEqual(listed.sessions.map((s) => s.kind), ['agent']);
  relay.resetSessionsForTests(null);
});

test('relay: verifyEnvelope accepts the new cli.sessions actions only with a granted scope', () => {
  const token = 'test-token-0123456789abcdef0123456789';
  const mk = (action, scope) => {
    const e = { id: 'r', nonce: `n-${Math.random()}`, ts: Date.now(), action, scope, paramsJson: '{"id":"cs_abcdefabcdef"}' };
    return { ...e, sig: relay.signEnvelope(e, token) };
  };
  assert.equal(relay.verifyEnvelope(mk('cli.sessions.send', 'coder.spawn'), { token, grantedScopes: ['coder.spawn'] }).ok, true);
  assert.equal(relay.verifyEnvelope(mk('cli.sessions.send', 'coder.spawn'), { token, grantedScopes: ['chat'] }).ok, false);
  assert.equal(relay.verifyEnvelope(mk('cli.sessions.send', 'ui.navigate'), { token, grantedScopes: ['ui.navigate'] }).ok, false);
});

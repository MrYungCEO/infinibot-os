// node --test extensions/kinglyvault-relay/kv-workspace.test.mjs
// Agent C actions: outputs / files / tasks / approvals through the relay.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.INFINIBOT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kvr-ws-'));
process.env.KV_RELAY_SKIP_CLAUDE_MCP = '1';
const m = await import('./relay-client.mjs');
const w = await import('./kv-workspace.mjs');

const token = 'test-token-0123456789abcdef0123456789';
const env = (action, params, scope, over = {}) => {
  const e = { id: `req-${Math.random()}`, nonce: `n-${Math.random()}`, ts: Date.now(), action, scope, paramsJson: JSON.stringify(params), ...over };
  return { ...e, sig: m.signEnvelope(e, token) };
};

test('new actions are refused unless their scope was granted on this InfiniBot', () => {
  const old = { token, grantedScopes: ['chat', 'coder.spawn'] }; // a link made before Agent C
  for (const [action, scope] of [
    ['outputs.list', 'outputs.read'],
    ['tasks.update', 'tasks.manage'],
    ['files.read', 'files.read'],
    ['approvals.resolve', 'approvals.manage'],
  ]) {
    const v = m.verifyEnvelope(env(action, {}, scope), old);
    assert.equal(v.ok, false, action);
    assert.match(v.reason, /not granted/);
  }
  // A forged scope that does not authorize the action is refused even when granted.
  const all = { token, grantedScopes: ['chat', 'outputs.read', 'approvals.manage'] };
  assert.equal(m.verifyEnvelope(env('approvals.resolve', { id: 'a', decision: 'approve' }, 'outputs.read'), all).ok, false);
  assert.equal(m.verifyEnvelope(env('approvals.resolve', { id: 'a', decision: 'approve' }, 'approvals.manage'), all).ok, true);
});

function freshWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kvr-ws-root-'));
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(allowed, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  const ws = w.createWorkspace({ outputsRoot: path.join(allowed, 'outputs'), roots: () => [allowed] });
  return { root, allowed, outside, ws };
}

test('outputs: build folder, describe, inline site preview, chunked fetch', () => {
  const { ws } = freshWorkspace();
  const b = ws.createBuild({ tool: 'website', title: 'Coffee shop', spec: 'A landing page' });
  assert.equal(ws.get(b.id).output.status, 'building');
  fs.writeFileSync(path.join(b.dir, 'style.css'), 'body{background:#07060c}');
  fs.writeFileSync(path.join(b.dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  fs.writeFileSync(path.join(b.dir, 'index.html'), '<link rel="stylesheet" href="style.css"><img src="logo.png"><img src="https://x.test/a.png"><img src="../../outside/secret.txt">');
  fs.writeFileSync(path.join(b.dir, '.env'), 'TOKEN=1');
  const o = ws.get(b.id).output;
  assert.equal(o.status, 'ready');
  assert.equal(o.kind, 'site');
  assert.equal(o.entry, 'index.html');
  assert.ok(!o.files.some((f) => f.path === '.env' || f.path === 'output.json'));
  const listed = ws.list();
  assert.equal(listed.outputs[0].id, b.id);
  assert.equal(listed.outputs[0].files, undefined);

  const page = ws.fetchFile(b.id, { inline: true });
  assert.equal(page.encoding, 'utf8');
  assert.match(page.data, /<style>body\{background:#07060c\}<\/style>/);
  assert.match(page.data, /src="data:image\/png;base64,/);
  assert.match(page.data, /https:\/\/x\.test\/a\.png/); // remote refs untouched
  assert.match(page.data, /\.\.\/\.\.\/outside\/secret\.txt/); // never inlined from outside the output
  assert.doesNotMatch(page.data, /nope/);

  // A file bigger than one chunk comes back in base64 chunks that re-assemble exactly.
  const big = Buffer.alloc(w.FILE_CHUNK_BYTES + 1234, 7);
  fs.writeFileSync(path.join(b.dir, 'big.bin'), big);
  const c1 = ws.fetchFile(b.id, { file: 'big.bin' });
  assert.equal(c1.encoding, 'base64');
  assert.equal(c1.nextOffset, w.FILE_CHUNK_BYTES);
  const c2 = ws.fetchFile(b.id, { file: 'big.bin', offset: c1.nextOffset });
  assert.equal(c2.nextOffset, null);
  assert.deepEqual(Buffer.concat([Buffer.from(c1.data, 'base64'), Buffer.from(c2.data, 'base64')]), big);
  // Every chunk fits KV's per-action result cap (600 000 chars) with room for the JSON wrapper.
  assert.ok(JSON.stringify(c1).length < 600_000);
});

test('outputs: ids and file names cannot escape the output folder', () => {
  const { ws, allowed } = freshWorkspace();
  const b = ws.createBuild({ tool: 'linktree', title: 'Links', spec: 'x' });
  fs.symlinkSync(path.join(allowed, '..', 'outside', 'secret.txt'), path.join(b.dir, 'link.txt'));
  assert.throws(() => ws.get('../outside'), /Unknown output/);
  assert.throws(() => ws.get('out-does-not-exist'), /Unknown output/);
  assert.throws(() => ws.fetchFile(b.id, { file: '../../outside/secret.txt' }), /nothing to show|No such file/);
  assert.throws(() => ws.fetchFile(b.id, { file: '/etc/passwd' }), /nothing to show|No such file/);
  assert.throws(() => ws.fetchFile(b.id, { file: 'link.txt' }), /No such file/); // symlink pointing outside
});

test('files: only allow-listed folders, never dotfiles or keys', () => {
  const { ws, allowed, outside } = freshWorkspace();
  fs.mkdirSync(path.join(allowed, 'site'));
  fs.writeFileSync(path.join(allowed, 'site', 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(allowed, 'id_rsa'), 'KEY');
  fs.mkdirSync(path.join(allowed, '.git'));
  fs.writeFileSync(path.join(allowed, '.git', 'config'), 'x');
  fs.symlinkSync(outside, path.join(allowed, 'escape'));

  const roots = ws.listFiles();
  assert.deepEqual(roots.entries.map((e) => e.path), [fs.realpathSync(allowed)]);
  const top = ws.listFiles(allowed);
  const names = top.entries.map((e) => e.name);
  assert.ok(names.includes('site'));
  assert.ok(!names.includes('.git') && !names.includes('id_rsa'));
  assert.equal(top.parent, null);
  assert.equal(ws.readFile(path.join(allowed, 'site', 'index.html')).data, '<h1>hi</h1>');
  assert.throws(() => ws.readFile(path.join(outside, 'secret.txt')), /not shared/);
  assert.throws(() => ws.listFiles(path.join(allowed, 'escape')), /not shared/); // symlink out of the root
  assert.throws(() => ws.readFile(path.join(allowed, 'id_rsa')), /private/);
  assert.throws(() => ws.readFile(path.join(allowed, '.git', 'config')), /private/);
  assert.throws(() => ws.listFiles('/etc'), /not shared/);
});

/** Minimal gateway double: records requests, answers kanban + approvals. */
function fakeGateway() {
  const calls = [];
  const approvals = [
    { id: 'apr_1', source: 'agent', requester: { label: 'Social poster', agentId: 'cmo' }, title: 'Publish "Fall promo" to Instagram', summary: '3 slides', details: 'caption…', risk: 'medium', options: ['approve', 'deny'], createdAt: Date.now(), expiresAt: Date.now() + 60_000, status: 'pending' },
  ];
  const tasks = [
    { id: 't1', title: 'Write launch post', status: 'todo', projectId: 'p1', updatedAt: 2 },
    { id: 't2', title: 'Old', status: 'done', projectId: 'p1', updatedAt: 1 },
  ];
  return {
    calls,
    approvals,
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'approvals.list') return { approvals: approvals.filter((a) => a.status === 'pending') };
      if (method === 'approvals.resolve') {
        const a = approvals.find((x) => x.id === params.id);
        if (!a) return { ok: false, error: 'not_found', record: null };
        if (a.status !== 'pending') return { ok: false, error: 'already_resolved', record: a };
        a.status = params.action === 'approve' ? 'approved' : 'denied';
        a.decidedBy = params.by;
        return { ok: true, record: a };
      }
      if (method === 'kanban.tasks.list') return tasks;
      if (method === 'kanban.projects.list') return [{ id: 'p1', name: 'Launch' }];
      if (method === 'kanban.tasks.update') {
        const t = tasks.find((x) => x.id === params.id);
        Object.assign(t, params.patch);
        return t;
      }
      throw new Error(`unexpected ${method}`);
    },
    async tool(name, args) {
      calls.push({ tool: name, args });
      return { runId: 'run-build-1', childSessionKey: 'agent:main:sub' };
    },
  };
}

const run = (gw, action, params) => m.runAction(action, params, { gw, state: { account: 'o***@gmail.com', connectionId: 'c1234567' }, emit: async () => {}, policy: m.loadPolicy() });

test('approvals: list pending → approve round trip → second answer refused', async () => {
  const gw = fakeGateway();
  const list = await run(gw, 'approvals.list', {});
  assert.equal(list.pendingCount, 1);
  assert.equal(list.approvals[0].title, 'Publish "Fall promo" to Instagram');
  assert.equal(list.approvals[0].requester, 'Social poster');
  const r = await run(gw, 'approvals.resolve', { id: 'apr_1', decision: 'approve' });
  assert.deepEqual(r, { id: 'apr_1', decision: 'approve', status: 'approved' });
  assert.equal(gw.approvals[0].decidedBy, 'KinglyVault (o***@gmail.com)');
  assert.equal((await run(gw, 'approvals.list', {})).pendingCount, 0);
  await assert.rejects(run(gw, 'approvals.resolve', { id: 'apr_1', decision: 'deny' }), /already answered/);
  await assert.rejects(run(gw, 'approvals.resolve', { id: 'apr_1', decision: 'approve-always' }), /approval id/);
});

test('tasks: list trims + names projects; update sends only allowed fields', async () => {
  const gw = fakeGateway();
  const l = await run(gw, 'tasks.list', {});
  assert.deepEqual(l.tasks.map((t) => t.id), ['t1', 't2']);
  assert.deepEqual(l.projects, [{ id: 'p1', name: 'Launch' }]);
  assert.equal((await run(gw, 'tasks.list', { status: 'done' })).tasks.length, 1);
  const u = await run(gw, 'tasks.update', { id: 't1', status: 'in_progress', assignee: 'evil', description: 'x' });
  assert.equal(u.task.status, 'in_progress');
  const sent = gw.calls.find((c) => c.method === 'kanban.tasks.update');
  assert.deepEqual(sent.params, { id: 't1', patch: { status: 'in_progress' } });
  await assert.rejects(run(gw, 'tasks.update', { id: 't1', status: 'shipped' }), /Unknown status/);
  await assert.rejects(run(gw, 'tasks.update', { id: 't1' }), /Nothing to change/);
});

test('outputs.build creates an output and hands the spec to an agent that may only write there', async () => {
  const gw = fakeGateway();
  const r = await run(gw, 'outputs.build', { tool: 'website', title: 'Coffee shop', spec: 'Dark + gold landing page' });
  assert.equal(r.runId, 'run-build-1');
  assert.match(r.outputId, /^out-/);
  const spawn = gw.calls.find((c) => c.tool === 'sessions_spawn');
  const dir = path.join(m.workspacesDir(), 'outputs', r.outputId);
  assert.ok(spawn.args.task.includes(dir));
  assert.match(spawn.args.task, /Do not publish/);
  assert.match(spawn.args.task, /Dark \+ gold landing page/);
  const got = await run(gw, 'outputs.get', { id: r.outputId });
  assert.equal(got.output.status, 'building');
  assert.equal(got.output.runId, 'run-build-1');
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Coffee</h1>');
  const listed = await run(gw, 'outputs.list', {});
  assert.equal(listed.outputs.find((o) => o.id === r.outputId).status, 'ready');
  await assert.rejects(run(gw, 'outputs.build', { tool: 'rm-rf', title: 'x', spec: 'y' }), /Unknown Create tool/);
  await run(gw, 'outputs.build', { tool: 'carousel', title: 'C', spec: 'y', provider: 'anthropic', model: 'claude-opus' });
  assert.equal(gw.calls.filter((c) => c.tool === 'sessions_spawn').at(-1).args.model, 'anthropic/claude-opus');
});

test('KV learns this InfiniBot supports the workspace actions', () => {
  assert.ok(m.RELAY_FEATURES.includes('kv-workspace'));
});

test('list results stay under KV\'s 60 000-char result cap', async () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ id: `t${i}`, title: 'x'.repeat(300), status: i % 3 ? 'todo' : 'done', projectId: `p${i % 50}`, description: 'd'.repeat(2000), updatedAt: i }));
  const gw = {
    async request(method) {
      if (method === 'kanban.tasks.list') return many;
      if (method === 'kanban.projects.list') return Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, name: 'P'.repeat(200) }));
      if (method === 'approvals.list') return { approvals: Array.from({ length: 80 }, (_, i) => ({ id: `a${i}`, title: 't'.repeat(300), summary: 's'.repeat(2000), details: 'd'.repeat(5000), createdAt: 1, expiresAt: 2 })) };
      throw new Error(method);
    },
  };
  const t = await run(gw, 'tasks.list', { limit: 200 });
  assert.ok(JSON.stringify(t).length < 60_000, `tasks ${JSON.stringify(t).length}`);
  assert.equal(t.truncated, true);
  assert.equal(t.tasks[0].status, 'todo'); // open work first
  const a = await run(gw, 'approvals.list', {});
  assert.ok(JSON.stringify(a).length < 60_000, `approvals ${JSON.stringify(a).length}`);
  assert.equal(a.pendingCount, 80);
  const { ws, allowed } = freshWorkspace();
  const deep = path.join(allowed, 'd'.repeat(120));
  fs.mkdirSync(deep);
  for (let i = 0; i < 499; i++) fs.writeFileSync(path.join(deep, `${'f'.repeat(100)}-${i}.txt`), 'x');
  const l = ws.listFiles(deep);
  assert.ok(JSON.stringify(l).length < 60_000, `files ${JSON.stringify(l).length}`);
  assert.equal(l.truncated, true);
});

// node --test extensions/kinglyvault-relay/relay-link.freeze.test.mjs
// The incident itself, with production timings: no shortened options, no
// injected gateway. Only relay-client.mjs, a stand-in install and a relay stub,
// so the first test also runs (and fails) against the pre-fix client.
// Throwaway state dir; the claude CLI is never called.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeStubRoot, pairedState, silentLog, startRelayStub, stubGateway, waitFor, writeState } from './relay-link.test.helpers.mjs';

process.env.INFINIBOT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kvr-freeze-'));
process.env.KV_RELAY_SKIP_CLAUDE_MCP = '1';
const m = await import('./relay-client.mjs');
const here = path.dirname(fileURLToPath(import.meta.url));

test('freeze: pulls continue after the gateway wedges and the 5-minute caps refresh comes due', async () => {
  const relay = await startRelayStub();
  writeState(pairedState(relay.url));
  const gw = stubGateway();
  gw.handlers = { 'agents.list': async () => ({ agents: [{ id: 'main' }], defaultId: 'main' }), 'coder.backends.list': async () => ({ backends: [] }) };
  const link = new m.RelayLink({ root: makeStubRoot(), log: silentLog() });
  void link.run().catch(() => {});
  const realNow = Date.now;
  try {
    await waitFor(() => relay.pulls().length >= 3, { timeoutMs: 8000, label: 'healthy pulls' });
    gw.handlers = {}; // Nothing answers from here on.
    Date.now = () => realNow() + 5 * 60_000 + 1000;
    await new Promise((r) => setTimeout(r, 300));
    const before = relay.pulls().length;
    await new Promise((r) => setTimeout(r, 3000));
    const after = relay.pulls().length - before;
    console.log(`pulls in the 3 s after the gateway wedged: ${after}`);
    assert.ok(after >= 5, `only ${after} pulls: the link froze`);
  } finally {
    Date.now = realNow;
    link.stop(); // Not awaited: on the pre-fix client run() never settles.
    await relay.close();
  }
});

// Rebuilds the pre-fix client from git and runs the test above against it, so
// both sides of the regression can be re-checked with one command from here.
const PRE_FIX = 'b0a2a5647';
const preFixFile = (name) => execFileSync('git', ['show', `${PRE_FIX}:extensions/kinglyvault-relay/${name}`], { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const hasPreFix = (() => {
  try {
    return preFixFile('relay-client.mjs').includes('class RelayLink');
  } catch {
    return false;
  }
})();

test('freeze baseline: the pre-fix client fails the same test with 0 pulls', { skip: !hasPreFix, timeout: 60_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kvr-prefix-'));
  for (const f of ['relay-client.mjs', 'cli-sessions.mjs']) fs.writeFileSync(path.join(dir, f), preFixFile(f));
  for (const f of ['relay-link.freeze.test.mjs', 'relay-link.test.helpers.mjs']) fs.copyFileSync(path.join(here, f), path.join(dir, f));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // Otherwise the child reports to this runner, not to stdout.
  const run = spawnSync(process.execPath, ['--test', '--test-name-pattern=^freeze: pulls continue', 'relay-link.freeze.test.mjs'], { cwd: dir, env, encoding: 'utf8', timeout: 50_000 });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`pre-fix client (${PRE_FIX}): exit ${run.status}; ${run.stdout.match(/pulls in the 3 s after the gateway wedged: \d+/)?.[0]}`);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /wedged: 0\b/);
  assert.match(run.stdout, /only 0 pulls: the link froze/);
});

// About 100 s. Standalone process, default 90 s window, wedged gateway AND wedged relay.
test('standalone `run`: the default 90 s watchdog fires, reports, recovers', { timeout: 150_000 }, async () => {
  let hang = true;
  const relay = await startRelayStub({ 'device.pull': () => (hang ? null : { body: { requests: [] } }) });
  writeState(pairedState(relay.url));
  fs.rmSync(path.join(m.relayDir(), 'health.json'), { force: true });
  let out = '';
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(here, 'relay-client.mjs'), 'run'], {
    env: { PATH: process.env.PATH, HOME: process.env.INFINIBOT_STATE_DIR, INFINIBOT_STATE_DIR: process.env.INFINIBOT_STATE_DIR, INFINIBOT_ROOT: makeStubRoot(), KV_RELAY_SKIP_CLAUDE_MCP: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.once('exit', (code, sig) => r({ code, sig })));
  try {
    await waitFor(() => /no successful pull for \d+s; restarting the link/.test(out), { timeoutMs: 120_000, label: 'watchdog log line' });
    const firedAfter = Math.round((Date.now() - started) / 1000);
    await waitFor(() => /reconnecting by itself/.test(m.loadHealth()?.error ?? ''), { timeoutMs: 2000, label: 'health error' });
    const bad = m.loadHealth();
    assert.equal(bad.ok, false);
    assert.ok(firedAfter >= 90 && firedAfter < 110, `fired after ${firedAfter}s`);
    hang = false;
    await waitFor(() => m.loadHealth()?.ok === true, { timeoutMs: 15_000, label: 'health recovered' });
    const good = m.loadHealth();
    assert.equal(good.error, null);
    console.log(out.split('\n').filter((l) => l.includes('[kv-relay]')).join('\n'));
    console.log(`watchdog fired after ${firedAfter}s; health then ok=${bad.ok} error=${JSON.stringify(bad.error)}; after recovery ok=${good.ok} error=${good.error}`);
    const seen = relay.pulls().length;
    await waitFor(() => relay.pulls().length >= seen + 5, { timeoutMs: 5000, label: 'pulls after recovery' });
  } finally {
    child.kill('SIGTERM');
  }
  assert.deepEqual(await exited, { code: 0, sig: null });
  await relay.close();
});

// node --test extensions/kinglyvault-relay/device-link.test.mjs
// Device-started link ("Connect KinglyVault" button), link health and the
// queued remote revoke, against a fake relay (no network).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.INFINIBOT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kvr-link-'));
process.env.KV_RELAY_SKIP_CLAUDE_MCP = '1';
const m = await import('./relay-client.mjs');

const calls = [];
let reply = () => ({ status: 500, body: {} });
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, body, auth: init.headers.authorization ?? null });
  const r = reply(body);
  if (r.throw) throw new TypeError('fetch failed');
  return { status: r.status, json: async () => r.body };
};

test('start → poll pending → approved → approvePairing saves a link (token issued here)', async () => {
  calls.length = 0;
  let approved = false;
  reply = (b) => {
    if (b.op === 'device.link.start') {
      assert.ok(b.claimNonce.length >= 16);
      return { status: 200, body: { userCode: 'BCDF-GHJK', deviceCode: 'd'.repeat(43), verifyUrl: 'https://kinglyvault.com/infinibot/link?code=BCDF-GHJK', expiresAt: new Date(Date.now() + 600_000).toISOString(), intervalMs: 1 } };
    }
    if (b.op === 'device.link.poll') {
      if (!approved) {
        approved = true;
        return { status: 200, body: { status: 'pending' } };
      }
      return { status: 200, body: { status: 'approved', account: 'o****@gmail.com', requestedScopes: ['chat', 'ui.navigate', 'bogus'], kvOrigin: 'https://kinglyvault.com' } };
    }
    if (b.op === 'device.approve') {
      assert.equal(b.code, 'BCDF-GHJK');
      assert.ok(b.token.length >= 32);
      return { status: 200, body: { connectionId: 'c0ffee00-0000-4000-8000-000000000001', deviceSecret: 's'.repeat(43), grantedScopes: b.grantedScopes, kvOrigin: 'https://kinglyvault.com', kvMcp: null } };
    }
    return { status: 400, body: { error: 'unknown_op' } };
  };
  const link = await m.startDeviceLink({ relayUrl: 'https://relay.test', name: 'Test box' });
  assert.equal(link.verifyUrl, 'https://kinglyvault.com/infinibot/link?code=BCDF-GHJK');
  assert.equal(link.device.name, 'Test box');
  const r = await m.waitForDeviceLink(link);
  assert.equal(r.status, 'approved');
  assert.deepEqual(r.claim.requested, ['chat', 'ui.navigate']);
  const state = await m.approvePairing(r.claim, r.claim.requested);
  assert.equal(state.account, 'o****@gmail.com');
  assert.deepEqual(m.loadState().grantedScopes, ['chat', 'ui.navigate']);
  // Same claim nonce from start to approve; no bearer before pairing.
  const start = calls.find((c) => c.body.op === 'device.link.start');
  const fin = calls.find((c) => c.body.op === 'device.approve');
  assert.equal(fin.body.claimNonce, start.body.claimNonce);
  assert.equal(start.auth, null);
});

test('denied / expired links end the wait', async () => {
  reply = () => ({ status: 200, body: { status: 'denied' } });
  const link = { relayUrl: 'https://relay.test', deviceCode: 'x'.repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString(), intervalMs: 1 };
  assert.equal((await m.waitForDeviceLink(link)).status, 'denied');
  reply = () => ({ status: 404, body: { error: 'not_found' } });
  assert.equal((await m.waitForDeviceLink(link)).status, 'expired');
  assert.equal((await m.waitForDeviceLink({ ...link, expiresAt: new Date(Date.now() - 1).toISOString() })).status, 'expired');
});

test('disconnect while KinglyVault is unreachable queues the revoke and retries it', async () => {
  assert.ok(m.loadState());
  reply = () => ({ throw: true });
  const status = await m.disconnectLink();
  assert.notEqual(status, 200);
  assert.equal(m.loadState(), null, 'local secrets wiped right away');
  assert.equal(m.revokePending(), true);
  assert.equal(await m.retryPendingRevoke(), false);
  reply = (b) => (b.op === 'device.disconnect' ? { status: 200, body: { ok: true } } : { status: 400, body: {} });
  assert.equal(await m.retryPendingRevoke(), true);
  assert.equal(m.revokePending(), false);
  const last = calls.filter((c) => c.body.op === 'device.disconnect').at(-1);
  assert.equal(last.auth, `Bearer ${'s'.repeat(43)}`);
});

test('health file never holds secrets; errors read as plain English', () => {
  m.recordHealth({ ok: false, error: m.friendlyError(new TypeError('fetch failed')) }, { force: true });
  const h = m.loadHealth();
  assert.match(h.error, /Can’t reach KinglyVault/);
  const raw = fs.readFileSync(path.join(m.relayDir(), 'health.json'), 'utf8');
  assert.doesNotMatch(raw, /sss|ddd|token|secret/i);
  assert.match(m.friendlyError(new Error('rate_limited')), /Too many tries/);
  assert.match(m.friendlyError(new Error('pull failed (HTTP 503)')), /problem on its side/);
});

// node --test extensions/kinglyvault-relay/zero-pairing.test.mjs
// Agent A (one account, zero pairing): stable install fingerprint, connect
// intents carried into device.link.start, and the /kv-connect/begin localhost
// handoff the KinglyVault page uses. Fake relay, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.INFINIBOT_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kvr-zp-'));
process.env.KV_RELAY_SKIP_CLAUDE_MCP = '1';
const m = await import('./relay-client.mjs');
const lp = await import('./local-pair.mjs');

const calls = [];
let reply = () => ({ status: 500, body: {} });
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  calls.push({ url, body });
  const r = reply(body);
  return { status: r.status, json: async () => r.body };
};

const INTENT = 'i'.repeat(32);
const linkReply = (b) =>
  b.op === 'device.link.start'
    ? { status: 200, body: { userCode: 'BCDF-GHJK', deviceCode: 'd'.repeat(43), verifyUrl: 'https://kinglyvault.com/infinibot/link?code=BCDF-GHJK', expiresAt: new Date(Date.now() + 600_000).toISOString(), intervalMs: 1 } }
    : b.op === 'device.approve'
      ? { status: 200, body: { connectionId: 'same-row', deviceSecret: 's'.repeat(43), grantedScopes: b.grantedScopes, kvOrigin: 'https://kinglyvault.com', reused: true } }
      : { status: 200, body: { ok: true } };

test('the install fingerprint is stable, private (0600) and survives disconnect', async () => {
  const a = m.deviceFingerprint();
  assert.match(a, /^[A-Za-z0-9_-]{24,200}$/);
  assert.equal(m.deviceFingerprint(), a);
  const file = path.join(m.relayDir(), 'device-id');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  reply = linkReply;
  const link = await m.startDeviceLink({ relayUrl: 'https://relay.test', name: 'Box' });
  assert.equal(calls.at(-1).body.device.fingerprint, a, 'sent with device.link.start');
  await m.approvePairing({ code: link.userCode, claimNonce: link.claimNonce, relayUrl: link.relayUrl, device: link.device, account: 'o***@x.com', requested: ['chat'], kvOrigin: 'https://kinglyvault.com' }, ['chat']);
  assert.equal(JSON.stringify(m.loadState()).includes(a), false, 'not copied into state.json');
  await m.disconnectLink();
  assert.equal(m.deviceFingerprint(), a, 'disconnect keeps the device id so a re-sign reuses the KV row');
});

test('re-signing in on the same device keeps the link (no self-revoke when KV reuses the row)', async () => {
  calls.length = 0;
  reply = linkReply;
  const claim = (l) => ({ code: l.userCode, claimNonce: l.claimNonce, relayUrl: l.relayUrl, device: l.device, account: 'o***@x.com', requested: ['chat'], kvOrigin: 'https://kinglyvault.com' });
  await m.approvePairing(claim(await m.startDeviceLink({ relayUrl: 'https://relay.test' })), ['chat']);
  await m.approvePairing(claim(await m.startDeviceLink({ relayUrl: 'https://relay.test' })), ['chat']);
  assert.equal(calls.filter((c) => c.body.op === 'device.disconnect').length, 0);
  assert.equal(m.loadState().connectionId, 'same-row');
});

test('a connect intent rides device.link.start; junk intents are dropped', async () => {
  calls.length = 0;
  reply = linkReply;
  await m.startDeviceLink({ relayUrl: 'https://relay.test', intent: INTENT });
  assert.equal(calls.at(-1).body.intent, INTENT);
  await m.startDeviceLink({ relayUrl: 'https://relay.test', intent: 'short' });
  assert.equal('intent' in calls.at(-1).body, false);
  await m.startDeviceLink({ relayUrl: 'https://relay.test', intent: 'x'.repeat(30) + '<script>' });
  assert.equal('intent' in calls.at(-1).body, false);
});

// ── /kv-connect/begin ──
function fakeReq({ method = 'POST', origin = 'https://kinglyvault.com', host = '127.0.0.1:18789', addr = '127.0.0.1', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { origin, host, 'content-type': 'application/json', 'x-kv-connect': '1', ...headers };
  req.socket = { remoteAddress: addr };
  req[Symbol.asyncIterator] = async function* () {
    if (body !== null) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  };
  return req;
}
function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: '' };
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
  res.end = (b = '') => (res.body = String(b));
  return res;
}
async function begin(opts, onBegin = async () => ({ userCode: 'BCDF-GHJK', verifyUrl: 'https://kinglyvault.com/infinibot/link?code=BCDF-GHJK', expiresAt: 'x', deviceCode: 'SECRET' })) {
  const started = [];
  const h = lp.createBeginHandler({ guard: opts.guard ?? new lp.BeginGuard(), onBegin: async (a) => (started.push(a), onBegin(a)), env: {}, log: { warn() {} } });
  const res = fakeRes();
  await h(fakeReq(opts), res);
  return { res, json: res.body ? JSON.parse(res.body) : null, started };
}
const nonce = () => Math.random().toString(36).slice(2).padEnd(20, 'x');

test('begin: a KinglyVault page on loopback starts a link with the intent and gets only the public code', async () => {
  const { res, json, started } = await begin({ body: { intent: INTENT, nonce: nonce() } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(started, [{ intent: INTENT, origin: 'https://kinglyvault.com' }]);
  assert.equal(json.userCode, 'BCDF-GHJK');
  assert.equal(res.body.includes('SECRET'), false, 'device code never leaves the gateway');
  assert.equal(res.headers['access-control-allow-origin'], 'https://kinglyvault.com');
  assert.equal(res.headers['access-control-allow-private-network'], 'true');
});

test('begin: other origins, non-loopback, missing header, bad intent, replays and floods are refused', async () => {
  assert.equal((await begin({ origin: 'https://evil.example', body: { intent: INTENT, nonce: nonce() } })).res.statusCode, 403);
  const off = await begin({ addr: '192.168.1.9', body: { intent: INTENT, nonce: nonce() } });
  assert.equal(off.res.statusCode, 403);
  assert.equal(off.started.length, 0);
  assert.equal((await begin({ host: 'attacker.test', body: { intent: INTENT, nonce: nonce() } })).res.statusCode, 403);
  assert.equal((await begin({ headers: { 'x-kv-connect': '' }, body: { intent: INTENT, nonce: nonce() } })).res.statusCode, 400);
  assert.equal((await begin({ body: { intent: 'nope', nonce: nonce() } })).res.statusCode, 400);
  const guard = new lp.BeginGuard();
  const n = nonce();
  assert.equal((await begin({ guard, body: { intent: INTENT, nonce: n } })).res.statusCode, 200);
  assert.equal((await begin({ guard, body: { intent: INTENT, nonce: n } })).res.statusCode, 409);
  for (let i = 0; i < 5; i++) await begin({ guard, body: { intent: INTENT, nonce: nonce() } });
  assert.equal((await begin({ guard, body: { intent: INTENT, nonce: nonce() } })).res.statusCode, 429);
  // CORS preflight answers for KV only.
  const pre = await begin({ method: 'OPTIONS' });
  assert.equal(pre.res.statusCode, 204);
});

test('begin: a relay failure is a plain 502, no stack', async () => {
  const { res, json } = await begin({ body: { intent: INTENT, nonce: nonce() } }, async () => {
    throw new Error('rate_limited');
  });
  assert.equal(res.statusCode, 502);
  assert.equal(json.error, 'begin_failed');
});

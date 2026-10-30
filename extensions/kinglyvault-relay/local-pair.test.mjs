// node --test extensions/kinglyvault-relay/local-pair.test.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { LIMITS, PAIR_PATH, PendingPairings, createPairHandler, isAllowedOrigin, isLoopbackHost, normalizeCode } from './local-pair.mjs';

const KV = 'https://kinglyvault.com';
const nonce = () => `n${Math.random().toString(36).slice(2)}${Date.now().toString(36)}xxxxxxxx`;

async function withServer(onRequest, fn) {
  const pending = new PendingPairings();
  const handler = createPairHandler({ pending, onRequest, env: {}, log: { warn() {} } });
  const server = http.createServer((req, res) => (req.url === PAIR_PATH ? handler(req, res) : (res.statusCode = 404, res.end())));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const call = (opts = {}) =>
    new Promise((resolve, reject) => {
      const body = opts.body === undefined ? JSON.stringify({ code: 'ABCD-EFGH', nonce: nonce() }) : opts.body;
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: PAIR_PATH,
          method: opts.method || 'POST',
          headers: {
            host: opts.host || `127.0.0.1:${port}`,
            ...(opts.origin === null ? {} : { origin: opts.origin || KV }),
            'content-type': opts.contentType || 'application/json',
            ...(opts.noMarker ? {} : { 'x-kv-connect': '1' }),
            ...(opts.headers || {}),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }));
        },
      );
      req.on('error', reject);
      if (opts.method !== 'OPTIONS') req.end(body);
      else req.end();
    });
  try {
    await fn(call, pending);
  } finally {
    server.close();
  }
}

test('origin allowlist: kinglyvault.com, www and netlify previews only', () => {
  assert.equal(isAllowedOrigin('https://kinglyvault.com', {}), true);
  assert.equal(isAllowedOrigin('https://www.kinglyvault.com', {}), true);
  assert.equal(isAllowedOrigin('https://deploy-preview-12--kinglyvault.netlify.app', {}), true);
  assert.equal(isAllowedOrigin('http://kinglyvault.com', {}), false);
  assert.equal(isAllowedOrigin('https://kinglyvault.com.evil.io', {}), false);
  assert.equal(isAllowedOrigin('https://evil--kinglyvault.netlify.app.evil.io', {}), false);
  assert.equal(isAllowedOrigin('null', {}), false);
  assert.equal(isAllowedOrigin('https://staging.example', { KV_CONNECT_ORIGINS: 'https://staging.example' }), true);
});

test('loopback host check blocks DNS-rebinding hosts', () => {
  assert.equal(isLoopbackHost('127.0.0.1:18789'), true);
  assert.equal(isLoopbackHost('localhost:18789'), true);
  assert.equal(isLoopbackHost('[::1]:18789'), true);
  assert.equal(isLoopbackHost('evil.example:18789'), false);
  assert.equal(isLoopbackHost('100.88.1.2:18789'), false);
});

test('code normalisation', () => {
  assert.equal(normalizeCode('abcd-efgh'), 'ABCD-EFGH');
  assert.equal(normalizeCode('ABCDEFGH'), 'ABCD-EFGH');
  assert.equal(normalizeCode('ABC'), null);
  assert.equal(normalizeCode('ABCD-EFGH; rm -rf'), null);
});

test('PNA preflight is answered for KinglyVault only', async () => {
  await withServer(async () => ({ id: 'x' }), async (call) => {
    const ok = await call({ method: 'OPTIONS', headers: { 'access-control-request-private-network': 'true', 'access-control-request-method': 'POST' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers['access-control-allow-origin'], KV);
    assert.equal(ok.headers['access-control-allow-private-network'], 'true');
    const bad = await call({ method: 'OPTIONS', origin: 'https://evil.example' });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers['access-control-allow-origin'], undefined);
    assert.equal(bad.headers['access-control-allow-private-network'], undefined);
  });
});

test('a valid request only queues an approval and returns no secrets', async () => {
  let seen = null;
  await withServer(async ({ code }) => ((seen = code), { id: 'req-1' }), async (call) => {
    const r = await call();
    assert.equal(r.status, 202);
    assert.deepEqual(Object.keys(r.body).sort(), ['ok', 'requestId', 'status']);
    assert.equal(r.body.status, 'awaiting_approval');
    assert.equal(seen, 'ABCD-EFGH');
  });
});

test('refuses other origins, missing origin, non-loopback Host, missing marker header and bad bodies', async () => {
  let calls = 0;
  await withServer(async () => (calls++, { id: 'x' }), async (call) => {
    assert.equal((await call({ origin: 'https://evil.example' })).status, 403);
    assert.equal((await call({ origin: null })).status, 403);
    assert.equal((await call({ host: 'rebind.evil.example:18789' })).status, 403);
    assert.equal((await call({ noMarker: true })).status, 400);
    assert.equal((await call({ contentType: 'text/plain' })).status, 400);
    assert.equal((await call({ body: '{nope' })).status, 400);
    assert.equal((await call({ body: JSON.stringify({ code: 'bad', nonce: nonce() }) })).status, 400);
    assert.equal((await call({ body: JSON.stringify({ code: 'ABCD-EFGH', nonce: 'short' }) })).status, 400);
    assert.equal((await call({ body: 'x'.repeat(LIMITS.bodyBytes + 10) })).status, 413);
    assert.equal(calls, 0);
  });
});

test('nonce replay is refused', async () => {
  await withServer(async () => ({ id: 'x' }), async (call) => {
    const body = JSON.stringify({ code: 'ABCD-EFGH', nonce: nonce() });
    assert.equal((await call({ body })).status, 202);
    assert.equal((await call({ body })).status, 409);
  });
});

test('rate limit and max pending', () => {
  let t = 0;
  const p = new PendingPairings({ now: () => t, limits: { ...LIMITS, perMinute: 3, maxPending: 2 } });
  assert.equal(p.admit(nonce()), null);
  p.add({ code: 'AAAA-AAAA', source: 't' });
  assert.equal(p.admit(nonce()), null);
  p.add({ code: 'BBBB-BBBB', source: 't' });
  assert.equal(p.admit(nonce()), 'too_many_pending');
  t += 11 * 60_000; // pending entries expire with the code
  assert.equal(p.admit(nonce()), null);
  assert.equal(p.admit(nonce()), null);
  assert.equal(p.admit(nonce()), null);
  assert.equal(p.admit(nonce()), 'rate_limited');
});

test('an approval can be taken once', () => {
  const p = new PendingPairings();
  const e = p.add({ code: 'AAAA-AAAA', source: 't' });
  assert.equal(p.add({ code: 'AAAA-AAAA', source: 't' }).id, e.id);
  assert.ok(p.take(e.id));
  assert.equal(p.take(e.id), null);
});

test('claim errors from KinglyVault come back as 422 without internals', async () => {
  await withServer(async () => {
    throw new Error('That code expired. Make a new one in KinglyVault.');
  }, async (call) => {
    const r = await call();
    assert.equal(r.status, 422);
    assert.equal(r.body.error, 'claim_failed');
  });
});

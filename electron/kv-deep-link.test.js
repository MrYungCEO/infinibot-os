import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { parseKvConnectUrl, beginKvConnect, postBegin } = require('./kv-deep-link');

const INTENT = 'A'.repeat(32);

describe('infinibot://kv-connect deep link (KinglyVault "Connect this computer")', () => {
  it('parses the intent and keeps only KinglyVault origins', () => {
    expect(parseKvConnectUrl(`infinibot://kv-connect?intent=${INTENT}&kv=https%3A%2F%2Fkinglyvault.com`)).toEqual({ intent: INTENT, kvOrigin: 'https://kinglyvault.com' });
    expect(parseKvConnectUrl(`infinibot://kv-connect?intent=${INTENT}&kv=https%3A%2F%2Fevil.example`)).toEqual({ intent: INTENT, kvOrigin: 'https://kinglyvault.com' });
    expect(parseKvConnectUrl(`infinibot://kv-connect?intent=${INTENT}&kv=https%3A%2F%2Fdeploy-preview-9--kinglyvault.netlify.app`).kvOrigin).toBe('https://deploy-preview-9--kinglyvault.netlify.app');
    expect(parseKvConnectUrl('infinibot://kv-connect?intent=short')).toBeNull();
    expect(parseKvConnectUrl(`infinibot://callback?intent=${INTENT}`)).toBeNull();
    expect(parseKvConnectUrl('https://kv-connect?intent=x')).toBeNull();
  });

  it('retries while the gateway boots, then opens the KinglyVault link in the browser', async () => {
    const answers = [{ status: 0, json: {} }, { status: 503, json: {} }, { status: 200, json: { ok: true, userCode: 'BCDF-GHJK', verifyUrl: 'https://kinglyvault.com/infinibot/link?code=BCDF-GHJK' } }];
    const opened = [];
    const r = await beginKvConnect({ intent: INTENT, kvOrigin: 'https://kinglyvault.com', port: 1, post: async () => answers.shift(), sleep: async () => {}, openExternal: async (u) => opened.push(u) });
    expect(r.ok).toBe(true);
    expect(opened).toEqual(['https://kinglyvault.com/infinibot/link?code=BCDF-GHJK']);
  });

  it('stops on a real refusal and never opens a non-https URL', async () => {
    const opened = [];
    const refused = await beginKvConnect({ intent: INTENT, port: 1, post: async () => ({ status: 429, json: { error: 'rate_limited' } }), sleep: async () => {}, openExternal: async (u) => opened.push(u) });
    expect(refused).toEqual({ ok: false, reason: 'rate_limited' });
    const sneaky = await beginKvConnect({ intent: INTENT, port: 1, attempts: 2, post: async () => ({ status: 200, json: { ok: true, verifyUrl: 'file:///etc/passwd' } }), sleep: async () => {}, openExternal: async (u) => opened.push(u) });
    expect(sneaky.ok).toBe(false);
    expect(opened).toEqual([]);
  });

  it('postBegin talks to the loopback /kv-connect/begin with the KV origin + header', async () => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        seen.push({ path: req.url, origin: req.headers.origin, hdr: req.headers['x-kv-connect'], body: JSON.parse(b) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, userCode: 'X', verifyUrl: 'https://kinglyvault.com/infinibot/link?code=X' }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const r = await postBegin({ port: srv.address().port, origin: 'https://kinglyvault.com', intent: INTENT });
    srv.close();
    expect(r.status).toBe(200);
    expect(seen[0]).toMatchObject({ path: '/kv-connect/begin', origin: 'https://kinglyvault.com', hdr: '1', body: { intent: INTENT } });
    expect(seen[0].body.nonce).toMatch(/^[a-f0-9]{36}$/);
  });
});

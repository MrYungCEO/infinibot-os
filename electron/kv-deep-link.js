// infinibot://kv-connect?intent=…&kv=https://kinglyvault.com
//
// KinglyVault's "Connect this computer" opens this deep link when its page
// could not reach InfiniBot on localhost (app closed, gateway still starting,
// or the browser blocked the local request). We hand the one-time connect
// intent to our own gateway's /kv-connect/begin (the same handler the KV page
// uses), retrying while the gateway boots, then open the returned
// kinglyvault.com/infinibot/link URL in the default browser, where KV
// approves the link for the member who clicked. Nothing to type or approve.
//
// A deep link from any other site can only start a link KV will NOT
// auto-approve (the intent must belong to the member signed in on KV), so the
// worst case is an ordinary approval page.
'use strict';

const http = require('http');
const crypto = require('crypto');

const INTENT_RE = /^[A-Za-z0-9_-]{24,100}$/;
const KV_ORIGIN_RE = /^https:\/\/((www\.)?kinglyvault\.com|[a-z0-9-]+--kinglyvault\.netlify\.app)$/;
const DEFAULT_ORIGIN = 'https://kinglyvault.com';

function parseKvConnectUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    return null;
  }
  if (u.protocol !== 'infinibot:') return null;
  const host = u.hostname || u.pathname.replace(/^\/+/, '').split('/')[0] || '';
  if (host !== 'kv-connect') return null;
  const intent = u.searchParams.get('intent') || '';
  if (!INTENT_RE.test(intent)) return null;
  const kv = u.searchParams.get('kv') || '';
  return { intent, kvOrigin: KV_ORIGIN_RE.test(kv) ? kv : DEFAULT_ORIGIN };
}

function postBegin({ port, origin, intent, timeoutMs = 25_000 }) {
  const body = JSON.stringify({ intent, nonce: crypto.randomBytes(18).toString('hex') });
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/kv-connect/begin',
        method: 'POST',
        timeout: timeoutMs,
        headers: { origin, 'content-type': 'application/json', 'x-kv-connect': '1', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = {};
          try {
            json = JSON.parse(data);
          } catch {
            /* not ours */
          }
          resolve({ status: res.statusCode || 0, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ status: 0, json: {} }));
    req.end(body);
  });
}

/**
 * Resolves { ok: true, verifyUrl } once the link started and the browser was
 * asked to open it, or { ok: false, reason } after `attempts` tries.
 */
async function beginKvConnect({ intent, kvOrigin, port, openExternal, post = postBegin, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 30, delayMs = 2000, log = () => {} }) {
  let last = 'unreachable';
  for (let i = 0; i < attempts; i++) {
    const r = await post({ port, origin: kvOrigin || DEFAULT_ORIGIN, intent });
    if (r.status === 200 && r.json && r.json.ok && typeof r.json.verifyUrl === 'string' && /^https:\/\//.test(r.json.verifyUrl)) {
      log(`kv-connect: link started from KinglyVault (code ${r.json.userCode || '?'})`);
      await openExternal(r.json.verifyUrl);
      return { ok: true, verifyUrl: r.json.verifyUrl };
    }
    // 4xx other than 404 = a real answer (bad intent, rate limit): stop. 0/404/5xx = gateway not up yet.
    if (r.status >= 400 && r.status < 500 && r.status !== 404) return { ok: false, reason: (r.json && r.json.error) || `http_${r.status}` };
    last = r.status ? `http_${r.status}` : 'unreachable';
    await sleep(delayMs);
  }
  return { ok: false, reason: last };
}

module.exports = { parseKvConnectUrl, beginKvConnect, postBegin, INTENT_RE };

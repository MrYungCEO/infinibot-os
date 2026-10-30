// KinglyVault Connect: the one-click local handshake.
//
// The KinglyVault page (https://kinglyvault.com) POSTs the member's one-time
// pairing code to THIS gateway on http://127.0.0.1:18789/kv-connect/pair.
// Browsers allow that from an https page because loopback is a potentially
// trustworthy origin; Chrome first sends a Private Network Access preflight,
// answered below for the KinglyVault origins only.
//
// What the request can do: put ONE "KinglyVault wants to connect" approval in
// front of the owner in the InfiniBot UI. Nothing else.
//   - It never returns or touches the gateway token or any link secret. The
//     response is only { ok, requestId, status }.
//   - Nothing is granted until the owner clicks Approve in the InfiniBot UI
//     (an authenticated operator.admin RPC). The prompt shows the masked KV
//     account and the code, so the owner can compare it with the KV page.
//   - Origin must be a KinglyVault origin, Host and the socket must be
//     loopback, and the custom x-kv-connect header + JSON body force a CORS
//     preflight (no simple cross-site form posts).
//   - Each request carries a fresh nonce (replays are refused), and requests
//     are rate-limited (per minute, and at most a few pending at once).

import { randomUUID } from 'node:crypto';

export const PAIR_PATH = '/kv-connect/pair';

const KV_ORIGINS = ['https://kinglyvault.com', 'https://www.kinglyvault.com'];
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+--kinglyvault\.netlify\.app$/;
const CODE_RE = /^[A-Z0-9]{4}-?[A-Z0-9]{4}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export const LIMITS = {
  perMinute: 6,
  maxPending: 3,
  pendingTtlMs: 10 * 60_000, // pairing codes live 10 minutes in KV
  bodyBytes: 2048,
};

/** Extra origins for staging only: KV_CONNECT_ORIGINS="https://a.example,https://b.example". */
function extraOrigins(env = process.env) {
  return String(env.KV_CONNECT_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^https:\/\/[^/]+$/.test(s));
}

export function isAllowedOrigin(origin, env = process.env) {
  if (typeof origin !== 'string' || !origin) return false;
  return KV_ORIGINS.includes(origin) || PREVIEW_ORIGIN.test(origin) || extraOrigins(env).includes(origin);
}

export function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false;
  const host = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0];
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export function isLoopbackAddress(addr) {
  if (typeof addr !== 'string') return false;
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');
}

export function normalizeCode(code) {
  const c = String(code || '').trim().toUpperCase();
  if (!CODE_RE.test(c)) return null;
  return c.includes('-') ? c : `${c.slice(0, 4)}-${c.slice(4)}`;
}

/** In-memory pending approvals + replay/rate state for one gateway process. */
export class PendingPairings {
  constructor({ now = () => Date.now(), limits = LIMITS } = {}) {
    this.now = now;
    this.limits = limits;
    this.items = new Map(); // id → entry
    this.nonces = new Map(); // nonce → expiry
    this.hits = []; // request timestamps (rate limit)
  }

  prune() {
    const t = this.now();
    for (const [id, e] of this.items) if (e.expiresAt <= t || e.done) this.items.delete(id);
    for (const [n, exp] of this.nonces) if (exp <= t) this.nonces.delete(n);
    this.hits = this.hits.filter((h) => h > t - 60_000);
  }

  /** Rate limit + replay check for an incoming page request. Returns an error code or null. */
  admit(nonce) {
    this.prune();
    if (!NONCE_RE.test(String(nonce || ''))) return 'bad_nonce';
    if (this.nonces.has(nonce)) return 'replay';
    if (this.hits.length >= this.limits.perMinute) return 'rate_limited';
    if (this.list().length >= this.limits.maxPending) return 'too_many_pending';
    this.hits.push(this.now());
    this.nonces.set(nonce, this.now() + this.limits.pendingTtlMs);
    return null;
  }

  add({ code, source, claim = null }) {
    const existing = this.list().find((e) => e.code === code);
    if (existing) return existing;
    const entry = { id: randomUUID(), code, source, claim, createdAt: this.now(), expiresAt: this.now() + this.limits.pendingTtlMs, done: false };
    this.items.set(entry.id, entry);
    return entry;
  }

  get(id) {
    this.prune();
    return this.items.get(id) || null;
  }

  take(id) {
    const e = this.get(id);
    if (!e) return null;
    e.done = true;
    this.items.delete(id);
    return e;
  }

  list() {
    const t = this.now();
    return [...this.items.values()].filter((e) => !e.done && e.expiresAt > t);
  }
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-kv-connect',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('too large'), { code: 'too_large' });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

/**
 * HTTP handler for /kv-connect/pair. `onRequest({ code })` claims the code and
 * queues the approval prompt; it must never return secrets.
 */
export function createPairHandler({ pending, onRequest, env = process.env, log = console }) {
  return async (req, res) => {
    const origin = req.headers.origin;
    const allowed = isAllowedOrigin(origin, env);
    const local = isLoopbackHost(req.headers.host) && isLoopbackAddress(req.socket?.remoteAddress);
    if (!allowed || !local) {
      // No CORS headers: the browser hides even this answer from other sites.
      send(res, 403, { ok: false, error: !local ? 'loopback_only' : 'origin_not_allowed' });
      return;
    }
    const cors = corsHeaders(origin);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
      res.end();
      return;
    }
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' }, cors);
    if (req.headers['x-kv-connect'] !== '1' || !String(req.headers['content-type'] || '').startsWith('application/json')) {
      return send(res, 400, { ok: false, error: 'bad_request' }, cors);
    }
    let body;
    try {
      body = await readJson(req, LIMITS.bodyBytes);
    } catch (e) {
      return send(res, e?.code === 'too_large' ? 413 : 400, { ok: false, error: 'bad_request' }, cors);
    }
    const code = normalizeCode(body?.code);
    if (!code) return send(res, 400, { ok: false, error: 'bad_code' }, cors);
    const refused = pending.admit(body?.nonce);
    if (refused) return send(res, refused === 'replay' ? 409 : refused === 'bad_nonce' ? 400 : 429, { ok: false, error: refused }, cors);
    try {
      const entry = await onRequest({ code, origin });
      return send(res, 202, { ok: true, requestId: entry.id, status: 'awaiting_approval' }, cors);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn?.(`[kv-connect] local pairing request failed: ${msg}`);
      // KV's own messages (expired / unknown code) are safe to show.
      return send(res, 422, { ok: false, error: 'claim_failed', message: msg.slice(0, 200) }, cors);
    }
  };
}

// ── Agent A: zero-pairing localhost handoff ───────────────────────────
//
// POST /kv-connect/begin {intent, nonce} from the KinglyVault page ("Connect
// this computer"). The member already chose to connect by clicking in KV, and
// the intent is bound to their KV account, so this starts a device link that
// carries it (no prompt here, no code to type) and answers with the link's
// user code. The page then approves that link for the same member.
//
// Same guards as /kv-connect/pair: KinglyVault origin only (CORS + PNA
// preflight), loopback Host + socket, custom header + JSON body (forces a
// preflight), one-time nonce, rate limit. Never returns a secret: the user
// code is only the public half of the link (the device code stays here).
// The infinibot:// deep link (desktop app) reaches the same handler.

export const BEGIN_PATH = '/kv-connect/begin';
const INTENT_RE = /^[A-Za-z0-9_-]{24,100}$/;

/** `onBegin({ intent, origin })` starts the device link and resolves { userCode, verifyUrl, expiresAt }. */
export function createBeginHandler({ guard, onBegin, env = process.env, log = console }) {
  return async (req, res) => {
    const origin = req.headers.origin;
    const allowed = isAllowedOrigin(origin, env);
    const local = isLoopbackHost(req.headers.host) && isLoopbackAddress(req.socket?.remoteAddress);
    if (!allowed || !local) {
      send(res, 403, { ok: false, error: !local ? 'loopback_only' : 'origin_not_allowed' });
      return;
    }
    const cors = corsHeaders(origin);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
      res.end();
      return;
    }
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method_not_allowed' }, cors);
    if (req.headers['x-kv-connect'] !== '1' || !String(req.headers['content-type'] || '').startsWith('application/json')) {
      return send(res, 400, { ok: false, error: 'bad_request' }, cors);
    }
    let body;
    try {
      body = await readJson(req, LIMITS.bodyBytes);
    } catch (e) {
      return send(res, e?.code === 'too_large' ? 413 : 400, { ok: false, error: 'bad_request' }, cors);
    }
    const intent = typeof body?.intent === 'string' ? body.intent : '';
    if (!INTENT_RE.test(intent)) return send(res, 400, { ok: false, error: 'bad_intent' }, cors);
    const refused = guard.admit(body?.nonce);
    if (refused) return send(res, refused === 'replay' ? 409 : refused === 'bad_nonce' ? 400 : 429, { ok: false, error: refused }, cors);
    try {
      const l = await onBegin({ intent, origin });
      return send(res, 200, { ok: true, userCode: l.userCode, verifyUrl: l.verifyUrl, expiresAt: l.expiresAt }, cors);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn?.(`[kv-connect] begin failed: ${msg}`);
      return send(res, 502, { ok: false, error: 'begin_failed', message: msg.slice(0, 200) }, cors);
    }
  };
}

/** Rate limit + replay guard for /kv-connect/begin (no pending list). */
export class BeginGuard {
  constructor({ now = () => Date.now(), perMinute = LIMITS.perMinute } = {}) {
    this.now = now;
    this.perMinute = perMinute;
    this.nonces = new Map();
    this.hits = [];
  }
  admit(nonce) {
    const t = this.now();
    for (const [n, exp] of this.nonces) if (exp <= t) this.nonces.delete(n);
    this.hits = this.hits.filter((h) => h > t - 60_000);
    if (!NONCE_RE.test(String(nonce || ''))) return 'bad_nonce';
    if (this.nonces.has(nonce)) return 'replay';
    if (this.hits.length >= this.perMinute) return 'rate_limited';
    this.hits.push(t);
    this.nonces.set(nonce, t + LIMITS.pendingTtlMs);
    return null;
  }
}

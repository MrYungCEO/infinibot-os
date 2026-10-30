/**
 * connection-logic — pure rules for "which gateway does this app talk to, and
 * with what credential". No React, no AsyncStorage, no fetch: every function
 * here is deterministic so the chooser, the WS client and every HTTP caller
 * agree, and so it is unit-tested (src/__tests__/connection-logic.test.js).
 *
 * Two profile kinds:
 *
 *   self-hosted  { kind:'self-hosted', gatewayUrl:'ws://host:18789',
 *                  authMode:'token'|'password'|'user', secret:'…', username? }
 *                `user` = a multi-user workspace account: `secret` is the
 *                `ibus_…` session token from POST /api/access/login (never the
 *                user's password), sent as auth.token.
 *                The shared gateway secret goes in the WS connect frame
 *                (auth.token / auth.password) and as `Authorization: Bearer`
 *                on every HTTP call (the gateway's HTTP auth gate accepts the
 *                gateway token OR password as a Bearer credential).
 *
 *   cloud        { kind:'cloud', orchestratorUrl:'https://…', gatewayUrl
 *                  (resolved, cached), tenantId? }
 *                InfiniBot Cloud: the user signs in with Clerk; the tenant's
 *                gateway is resolved through the orchestrator's
 *                `/fleet/resolve`, and EVERY request carries a FRESH Clerk
 *                session token (they live ~60s) — never a stored secret.
 */

export const GATEWAY_DEFAULT_PORT = 18789;

export const PROFILE_KINDS = Object.freeze({ SELF_HOSTED: 'self-hosted', CLOUD: 'cloud' });

/**
 * Normalise whatever the user typed (or a QR carried) into a WebSocket URL.
 *
 *   192.168.1.120            -> ws://192.168.1.120:18789
 *   my-box.tail1234.ts.net  -> ws://my-box.tail1234.ts.net:18789
 *   http://host:8080/       -> ws://host:8080
 *   https://gw.example.com  -> wss://gw.example.com          (443, e.g. tailscale serve)
 *   ws://host / wss://host  -> kept (a bare ws:// host gets :18789)
 *
 * Returns '' for input that has no usable host.
 */
export function normalizeGatewayUrl(raw) {
  let v = String(raw ?? '').trim();
  if (!v) return '';
  let scheme = null;
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(v);
  if (m) {
    scheme = m[1].toLowerCase();
    v = v.slice(m[0].length);
  }
  if (scheme && !['ws', 'wss', 'http', 'https'].includes(scheme)) return '';
  // Drop path/query/fragment and userinfo.
  let authority = v.split(/[/?#]/)[0].replace(/^.*@/, '');
  if (!authority || /\s/.test(authority)) return '';
  const secure = scheme === 'wss' || scheme === 'https';
  const hasPort = authority.startsWith('[')
    ? /\]:\d+$/.test(authority)
    : /:\d+$/.test(authority);
  const host = authority.startsWith('[')
    ? authority.slice(0, authority.indexOf(']') + 1)
    : authority.replace(/:\d+$/, '');
  if (!host || host === '[]') return '';
  // A secure URL without a port means 443 (reverse proxy / tailscale serve);
  // a plain one means the gateway's own port.
  if (!hasPort && !secure) authority = `${host}:${GATEWAY_DEFAULT_PORT}`;
  return `${secure ? 'wss' : 'ws'}://${authority}`;
}

/** ws(s)://host:port -> http(s)://host:port ('' when unset). */
export function httpOriginFromWs(wsUrl) {
  const n = normalizeGatewayUrl(wsUrl);
  if (!n) return '';
  return n.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

/** True when a host is a Tailscale name or CGNAT (100.64/10) address. */
export function isTailscaleHost(wsUrl) {
  const n = normalizeGatewayUrl(wsUrl);
  if (!n) return false;
  const host = n.replace(/^wss?:\/\//, '').replace(/:\d+$/, '');
  if (/\.ts\.net$/i.test(host)) return true;
  const ip = /^100\.(\d+)\.\d+\.\d+$/.exec(host);
  return Boolean(ip && Number(ip[1]) >= 64 && Number(ip[1]) <= 127);
}

let idSeq = 0;
function newProfileId(kind) {
  idSeq += 1;
  return `${kind === PROFILE_KINDS.CLOUD ? 'cloud' : 'gw'}-${Date.now().toString(36)}-${idSeq}`;
}

/** Build a validated self-hosted profile, or throw with a user-facing message. */
export function normalizeAuthMode(mode) {
  return mode === 'password' ? 'password' : mode === 'user' ? 'user' : 'token';
}

export function makeSelfHostedProfile({ gatewayUrl, secret = '', authMode = 'token', label, id, username } = {}) {
  const url = normalizeGatewayUrl(gatewayUrl);
  if (!url) throw new Error(`Enter your gateway address, e.g. 192.168.1.20 or ws://my-pc:${GATEWAY_DEFAULT_PORT}`);
  const host = url.replace(/^wss?:\/\//, '');
  return {
    id: id || newProfileId(PROFILE_KINDS.SELF_HOSTED),
    kind: PROFILE_KINDS.SELF_HOSTED,
    label: (label || '').trim() || host,
    gatewayUrl: url,
    authMode: normalizeAuthMode(authMode),
    secret: String(secret || '').trim(),
    ...(normalizeAuthMode(authMode) === 'user' ? { username: String(username || '').trim() } : {}),
  };
}

/** Build a cloud profile. The gateway URL is filled in by resolveCloudGateway. */
export function makeCloudProfile({ orchestratorUrl, label, id, gatewayUrl = '', tenantId = null, email = null } = {}) {
  const base = String(orchestratorUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new Error('InfiniBot Cloud is not configured in this build (no orchestrator URL).');
  return {
    id: id || newProfileId(PROFILE_KINDS.CLOUD),
    kind: PROFILE_KINDS.CLOUD,
    label: (label || '').trim() || 'InfiniBot Cloud',
    orchestratorUrl: base,
    gatewayUrl: gatewayUrl ? normalizeGatewayUrl(gatewayUrl) : '',
    tenantId,
    email,
  };
}

/**
 * The WS `connect` auth block for a profile.
 *
 * Preference order mirrors the gateway (message-handler.ts): a paired device
 * token wins for self-hosted; cloud always sends the fresh Clerk token as
 * `auth.token` (the cloud gateway verifies it as a Clerk session JWT).
 */
export function buildConnectAuth(profile, { deviceToken = null, clerkToken = null } = {}) {
  if (!profile) return undefined;
  if (profile.kind === PROFILE_KINDS.CLOUD) {
    return clerkToken ? { token: clerkToken } : undefined;
  }
  // A workspace-user session must never be swapped for a device token: device
  // tokens authenticate as the gateway OWNER.
  if (profile.authMode === 'user') return profile.secret ? { token: profile.secret } : undefined;
  if (deviceToken) return { token: deviceToken };
  if (!profile.secret) return undefined;
  return profile.authMode === 'password' ? { password: profile.secret } : { token: profile.secret };
}

/**
 * HTTP headers for a gateway HTTP route. Every route sits behind the HTTP auth
 * gate, so this must be applied to EVERY fetch (voice, push-token register,
 * hardware, APK download, …) — the gateway answers 401 otherwise.
 */
export function buildAuthHeaders(profile, { clerkToken = null } = {}) {
  if (!profile) return {};
  if (profile.kind === PROFILE_KINDS.CLOUD) {
    return clerkToken ? { Authorization: `Bearer ${clerkToken}` } : {};
  }
  // Workspace users have no owner HTTP access (the gateway's HTTP routes are
  // owner-only); sending their session as Bearer would just 401.
  if (profile.authMode === 'user') return {};
  return profile.secret ? { Authorization: `Bearer ${profile.secret}` } : {};
}

/**
 * Parse a pairing payload scanned from the web UI's Mobile page QR (or pasted).
 * Accepts:
 *   infinibot://connect?url=ws%3A%2F%2Fhost%3A18789&token=…   (app link)
 *   https://host/…?gateway=…&token=…                          (web fallback)
 *   {"gatewayUrl":"ws://…","token":"…"}  / {"url":…,"password":…}  (JSON)
 *   ws://host:18789  (URL only — the user types the secret)
 * Returns { gatewayUrl, secret, authMode } or null.
 */
export function parsePairingPayload(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      const url = normalizeGatewayUrl(j.gatewayUrl || j.url || j.gateway || '');
      if (!url) return null;
      const pw = j.password ? String(j.password) : '';
      const tok = j.token ? String(j.token) : '';
      return { gatewayUrl: url, secret: tok || pw, authMode: tok ? 'token' : pw ? 'password' : 'token' };
    } catch {
      return null;
    }
  }
  const q = s.indexOf('?');
  if (q >= 0 && /^(infinibot|https?):/i.test(s)) {
    const params = parseQuery(s.slice(q + 1));
    const url = normalizeGatewayUrl(params.url || params.gateway || params.gatewayUrl || '');
    if (url) {
      const tok = params.token || '';
      const pw = params.password || '';
      return { gatewayUrl: url, secret: tok || pw, authMode: tok ? 'token' : pw ? 'password' : 'token' };
    }
  }
  const url = normalizeGatewayUrl(s);
  return url ? { gatewayUrl: url, secret: '', authMode: 'token' } : null;
}

export function parseQuery(qs) {
  const out = {};
  for (const part of String(qs || '').split('#')[0].split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, ' '));
    const v = i < 0 ? '' : decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
    if (k) out[k] = v;
  }
  return out;
}

/**
 * Interpret the orchestrator's `POST /fleet/resolve` answer (src/fleet/
 * orchestrator.ts + server.ts on the cloud branch):
 *   200 {status:'ready', gatewayWsUrl:'wss://<app>.fly.dev/ws', tenantId}
 *   200 {status:'serverless', mode:'serverless', plan}   — plan has no gateway
 *   409 {status:'provisioning', tenantId} + Retry-After   — machine starting
 *   401 unauthorized · 403 tenant_inactive · 503 wake_failed/provision_failed
 * Returns
 *   { state:'ready', gatewayUrl, tenantId } | { state:'waking', retryAfterMs }
 *   | { state:'serverless' } | { state:'error', message, retryable? }
 */
export function interpretFleetResolve(status, body, retryAfterHeader = null) {
  const b = body && typeof body === 'object' ? body : {};
  if (status === 401) {
    return { state: 'error', message: 'Your cloud session was rejected — sign in again.', reauth: true };
  }
  if (status === 403) {
    return { state: 'error', message: 'This InfiniBot Cloud workspace is not active. Check your plan at the web dashboard.' };
  }
  if (status === 409 || status === 202 || b.status === 'provisioning' || b.status === 'waking') {
    const hdr = Number(retryAfterHeader);
    const ra = Number(b.retryAfterMs ?? (Number.isFinite(hdr) && hdr > 0 ? hdr * 1000 : 2000));
    return { state: 'waking', retryAfterMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 8000) : 2000 };
  }
  if (b.mode === 'serverless' || b.status === 'serverless' || b.gateway === false) {
    return { state: 'serverless' };
  }
  if (status >= 200 && status < 300) {
    const raw = b.gatewayWsUrl || b.wsUrl || b.gatewayUrl || b.url || '';
    const gatewayUrl = normalizeGatewayUrl(raw);
    // Keep the path (/ws) the orchestrator gave us — the fleet gateway accepts
    // any WS path, but be faithful.
    const path = /^wss?:\/\/[^/]+(\/[^?#]*)/i.exec(String(raw))?.[1] || '';
    if (gatewayUrl) return { state: 'ready', gatewayUrl: gatewayUrl + (path && path !== '/' ? path : ''), tenantId: b.tenantId ?? null };
    return { state: 'error', message: 'The cloud did not return a gateway address.' };
  }
  const code = typeof b.error === 'string' ? b.error : b.error?.message;
  return {
    state: 'error',
    message: code === 'wake_failed' || code === 'provision_failed'
      ? 'Your cloud workspace failed to start — try again.'
      : code || b.message || `Cloud resolve failed (HTTP ${status}).`,
    retryable: status >= 500,
  };
}

/**
 * Resolve the tenant gateway through the orchestrator, polling while the
 * tenant's machine wakes. `fetchImpl` and `getToken` are injected (tests pass
 * fakes; the app passes global fetch and Clerk's getToken). A fresh token is
 * fetched for EVERY attempt.
 */
export async function resolveCloudGateway({
  orchestratorUrl,
  getToken,
  fetchImpl = globalThis.fetch,
  maxWaitMs = 300000,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  onWaking,
} = {}) {
  const base = String(orchestratorUrl || '').replace(/\/+$/, '');
  const started = now();
  let retriedAuth = false;
  for (;;) {
    const token = await getToken(retriedAuth ? { skipCache: true } : undefined);
    if (!token) return { state: 'error', message: 'Not signed in to InfiniBot Cloud.' };
    let res;
    try {
      res = await fetchImpl(`${base}/fleet/resolve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch (e) {
      return { state: 'error', message: `Cannot reach InfiniBot Cloud: ${e?.message || e}` };
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    const out = interpretFleetResolve(res.status, body, res.headers?.get?.('retry-after'));
    if (out.reauth && !retriedAuth) {
      // One retry with a forced-fresh token (Clerk may hand back a cached one
      // that expired in flight) — same as the cloud web UI.
      retriedAuth = true;
      continue;
    }
    if (out.state !== 'waking') return out;
    onWaking?.(out);
    if (now() - started + out.retryAfterMs > maxWaitMs) {
      return { state: 'error', message: 'Your cloud workspace is still starting — try again in a minute.' };
    }
    await sleep(out.retryAfterMs);
  }
}

/** Short user-facing description of a profile for the switcher list. */
export function describeProfile(p) {
  if (!p) return '';
  if (p.kind === PROFILE_KINDS.CLOUD) return p.email ? `Cloud · ${p.email}` : 'InfiniBot Cloud';
  const host = (p.gatewayUrl || '').replace(/^wss?:\/\//, '');
  return `${isTailscaleHost(p.gatewayUrl) ? 'Tailscale' : 'Self-hosted'} · ${host}`;
}

// ── Connect failures ────────────────────────────────────────────────────────

/**
 * Classify a failed `connect` (the gateway's res error, a close reason, or a
 * thrown Error) so the app knows whether retrying can ever help.
 *
 *   auth     wrong/missing password or token — retrying with the same secret
 *            only spams the gateway; the user must fix the credential.
 *   pairing  the gateway wants this device approved first.
 *   network  anything else (unreachable, timeout, socket dropped) — back off
 *            and retry.
 *
 * `authMode` is what the gateway EXPECTS ('password' | 'token' | null): taken
 * from error.details.authMode (gateways that send it) or the message text
 * ("gateway password mismatch" → password).
 *
 * @returns {{ kind:'auth'|'pairing'|'network', authMode:'password'|'token'|null, reason:string|null, message:string }}
 */
export function classifyConnectFailure(err) {
  const e = err && typeof err === 'object' ? err : { message: String(err ?? '') };
  const details = e.details && typeof e.details === 'object' ? e.details : {};
  const message = String(e.message || e.reason || '');
  const code = String(e.code || '');
  const reason = typeof details.authReason === 'string' ? details.authReason : null;
  let authMode = details.authMode === 'password' || details.authMode === 'token' ? details.authMode : null;
  if (!authMode) {
    if (/gateway password|password_(mismatch|missing)/i.test(message) || /^password_/.test(reason || '')) authMode = 'password';
    else if (/gateway token|token_(mismatch|missing)/i.test(message) || /^token_/.test(reason || '')) authMode = 'token';
  }
  if (code === 'NOT_PAIRED' || /pairing required|device identity required|not paired/i.test(message)) {
    return { kind: 'pairing', authMode, reason: reason || 'pairing_required', message };
  }
  if (details.kind === 'auth' || /unauthori[sz]ed|password mismatch|token mismatch|password missing|token missing|_mismatch|invite_token_invalid/i.test(message)) {
    return { kind: 'auth', authMode, reason, message };
  }
  return { kind: 'network', authMode: null, reason: null, message };
}

/** Hostname of a ws(s) URL, lower-cased, without port ('' when invalid). */
export function gatewayHost(wsUrl) {
  const n = normalizeGatewayUrl(wsUrl);
  if (!n) return '';
  const authority = n.replace(/^wss?:\/\//, '');
  return (authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.replace(/:\d+$/, '')).toLowerCase();
}

/** Headline for an auth-halted connection, e.g. "Wrong gateway password for my-pc". */
export function describeAuthFailure(failure, profile) {
  const host = gatewayHost(profile?.gatewayUrl) || 'this gateway';
  if (!failure) return '';
  if (failure.kind === 'pairing') return `This phone needs approval on ${host}`;
  const mode = failure.authMode || profile?.authMode || 'password';
  const missing = /missing/.test(failure.reason || failure.message || '');
  const what = mode === 'token' ? 'token' : 'password';
  return missing ? `${host} needs a gateway ${what}` : `Wrong gateway ${what} for ${host}`;
}

/**
 * "Use this build's credentials": when the saved profile fails auth and the
 * app was built with EXPO_PUBLIC_GATEWAY_URL/_TOKEN for the SAME host, offer
 * those instead. Returns a patched profile, or null when not applicable.
 */
export function buildCredentialOffer({ profile, failure, bakedUrl, bakedSecret } = {}) {
  if (!profile || profile.kind !== PROFILE_KINDS.SELF_HOSTED) return null;
  if (!failure || failure.kind !== 'auth') return null;
  const secret = String(bakedSecret || '').trim();
  if (!secret || !bakedUrl) return null;
  const host = gatewayHost(bakedUrl);
  if (!host || host !== gatewayHost(profile.gatewayUrl)) return null;
  const authMode = failure.authMode || profile.authMode || 'password';
  if (secret === profile.secret && authMode === profile.authMode) return null;
  return { ...profile, secret, authMode: authMode === 'token' ? 'token' : 'password' };
}

/**
 * The pairing QR payload the web UI's Mobile page renders (JSON, matching
 * parsePairingPayload). Exactly one of password/token is set.
 */
export function buildPairingPayload({ gatewayUrl, secret, authMode = 'password', label } = {}) {
  const url = normalizeGatewayUrl(gatewayUrl);
  if (!url) return '';
  const out = { gatewayUrl: url };
  if (secret) out[authMode === 'token' ? 'token' : 'password'] = String(secret);
  if (label) out.label = String(label);
  return JSON.stringify(out);
}

/** True for a multi-user workspace session token (POST /api/access/login). */
export function isUserSessionToken(token) {
  return typeof token === 'string' && token.startsWith('ibus_');
}

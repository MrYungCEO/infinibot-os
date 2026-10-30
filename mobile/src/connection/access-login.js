/**
 * Multi-user workspaces (gateway `auth.multiUser`): exchange a workspace
 * user's username + password (+ 2FA code) for an `ibus_` session token via
 * POST /api/access/login. The token — never the password — is what the
 * connection profile stores and sends as the WS connect `auth.token`.
 */
import { httpOriginFromWs } from './connection-logic';

const ERRORS = {
  invalid_credentials: 'Wrong username or password.',
  account_disabled: 'This account has been disabled — ask your admin.',
  totp_required: 'Enter the 6-digit code from your authenticator app.',
  totp_invalid: "That code didn't match — try the next one.",
  multi_user_disabled: "This gateway doesn't have workspace accounts turned on.",
};

/**
 * @returns {Promise<{ ok:true, token:string, expiresAt:number, user:object }
 *   | { ok:false, error:string, needsCode?:boolean }>}
 */
export async function loginWorkspaceUser({ gatewayUrl, username, password, code, fetchImpl = fetch }) {
  const origin = httpOriginFromWs(gatewayUrl);
  if (!origin) return { ok: false, error: 'Enter your gateway address first.' };
  if (!String(username || '').trim() || !password) return { ok: false, error: 'Enter your username and password.' };
  try {
    const res = await fetchImpl(`${origin}/api/access/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: String(username).trim(), password, code: code || undefined }),
    });
    let body = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON */
    }
    if (res.ok && typeof body.token === 'string') {
      return { ok: true, token: body.token, expiresAt: body.expiresAt || 0, user: body.user || null };
    }
    if (res.status === 429) return { ok: false, error: 'Too many attempts — try again in a few minutes.' };
    const err = body.error || '';
    return {
      ok: false,
      error: ERRORS[err] || `Sign-in failed (${res.status}).`,
      needsCode: err === 'totp_required' || err === 'totp_invalid',
    };
  } catch (e) {
    return { ok: false, error: `Can't reach the gateway: ${e?.message || e}` };
  }
}

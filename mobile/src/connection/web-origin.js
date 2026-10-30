/**
 * web-origin — first-run connection for the WEB EXPORT of the app.
 *
 * The gateway serves this export itself at `/mobile-web/` (on its own port,
 * or behind Tailscale Serve on https:443). In that case the gateway to talk to
 * is simply the page's own origin: `wss://<host>` on https, `ws://<host:port>`
 * on http. Same origin also means the web control UI's saved credential
 * (localStorage `infinibot.control.settings.v1`, password or token) is
 * readable, so a browser that already signed in to the control UI connects
 * without typing anything.
 *
 * Fallbacks, in order: the page origin (served by the gateway) → the build's
 * EXPO_PUBLIC_GATEWAY_URL → nothing (the chooser asks). The secret is NEVER
 * baked into the bundle: /mobile-web is a public static route, so a password
 * compiled into the JS would be readable by anyone who can load the page.
 */

export const CONTROL_UI_SETTINGS_KEY = 'infinibot.control.settings.v1';
export const MOBILE_WEB_PREFIX = '/mobile-web';

/** Is this page the export served by a gateway (`…/mobile-web/…`)? */
export function servedByGateway(loc) {
  if (!loc || typeof loc.pathname !== 'string') return false;
  if (!/^https?:$/.test(loc.protocol || '')) return false;
  return loc.pathname === MOBILE_WEB_PREFIX || loc.pathname.startsWith(`${MOBILE_WEB_PREFIX}/`);
}

/** The gateway WebSocket URL for this page's origin. */
export function originGatewayUrl(loc) {
  if (!loc || !loc.host) return '';
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}`;
}

/** The control UI's saved credential on this origin, or null. */
export function readControlUiCredential(storage) {
  try {
    const raw = storage?.getItem?.(CONTROL_UI_SETTINGS_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    const password = typeof v?.password === 'string' ? v.password.trim() : '';
    const token = typeof v?.token === 'string' ? v.token.trim() : '';
    if (password) return { secret: password, authMode: 'password' };
    if (token) return { secret: token, authMode: 'token' };
    return null;
  } catch {
    return null;
  }
}

/**
 * What to try first on a fresh web install.
 * @returns {{ gatewayUrl: string, secret: string, authMode: 'password'|'token', source: 'origin'|'env'|'none', credentialFrom: 'control-ui'|null }}
 */
export function suggestWebConnection({ location: loc, storage, bakedUrl } = {}) {
  const cred = readControlUiCredential(storage);
  if (servedByGateway(loc)) {
    return {
      gatewayUrl: originGatewayUrl(loc),
      secret: cred?.secret || '',
      authMode: cred?.authMode || 'password',
      source: 'origin',
      credentialFrom: cred ? 'control-ui' : null,
    };
  }
  const env = typeof bakedUrl === 'string' ? bakedUrl.trim() : '';
  if (env) return { gatewayUrl: env, secret: '', authMode: 'password', source: 'env', credentialFrom: null };
  return { gatewayUrl: '', secret: '', authMode: 'password', source: 'none', credentialFrom: null };
}

/** EXPO_PUBLIC_* values are inlined at export time (Metro). */
export function bakedGatewayUrl() {
  try {
    return process.env.EXPO_PUBLIC_GATEWAY_URL || '';
  } catch {
    return '';
  }
}

/**
 * The build's own gateway secret (EXPO_PUBLIC_GATEWAY_TOKEN — the dev client
 * / Expo Go bundle from the owner's .env), used ONLY to offer "Use this
 * build's credentials" when a saved profile for the same host fails auth.
 * Always '' in the web export: /mobile-web is public, so the secret must not
 * be compiled into it (EXPO_OS is inlined, so the branch below is dropped).
 */
export function bakedGatewaySecret() {
  if (process.env.EXPO_OS === 'web') return '';
  try {
    return process.env.EXPO_PUBLIC_GATEWAY_TOKEN || '';
  } catch {
    return '';
  }
}

/**
 * web-link — open a control-UI web path (a chat/CMO link like `/reviews` or
 * `/agency-daily?x=1`) on the NATIVE screen that implements it, falling back
 * to the authed WebSurface only for pages the app has no native screen for.
 *
 * Resolution reuses the deep-link table (deep-links.js `web/<path>`), so a
 * page that gains a native screen there is picked up here automatically.
 */
import { resolveDeepLink } from './deep-links';
import { navigateToScreen } from './screen-registry';
import { getPluginList } from '../plugins/plugin-store';

/** The registry entry a web path should open (pure; plugins injectable for tests). */
export function nativeEntryForWebPath(path, { plugins = getPluginList() } = {}) {
  const p = String(path || '').trim();
  if (!p.startsWith('/')) return null;
  const e = resolveDeepLink(p, { plugins });
  if (!e || e.unknown || e.pending || e.connect) return null;
  if (e.webPath) return null; // no native screen — caller uses the web host
  return e;
}

/**
 * Navigate `rootNav` to `path`. Returns true when something was opened.
 * `title` labels the web fallback.
 */
export function openWebPath(rootNav, path, title, ctx = {}) {
  if (!rootNav || !path) return false;
  const entry = nativeEntryForWebPath(path, ctx);
  if (entry && navigateToScreen(rootNav, entry, ctx)) return true;
  rootNav.navigate('WebSurfaceModal', { path, title, embed: true });
  return true;
}

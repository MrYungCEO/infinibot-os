// Every link to an external site opens in the user's default browser, never in
// an Electron window: sign-in pages (Claude, ChatGPT, Google, Grok), chat
// markdown, docs, plugin pages, download/update links, help links.
//
// Installed once for ALL webContents (app.on('web-contents-created')), so
// windows created later are covered too:
//   - window.open / target=_blank  → deny + shell.openExternal
//   - main-frame navigation or server redirect to a non-app origin
//                                   → preventDefault + shell.openExternal
// App origins keep navigating in-app: file:// app pages, the local gateway
// (loopback http/https on any port), plus any origin main.js loads itself.
// Only http, https and mailto ever reach the OS; other schemes are blocked,
// except infinibot:// which the protocol handler owns.
//
// KinglyVault licence sign-in and checkout also open in the default browser
// (kv-browser-flow.js waits for their infinibot:// return).
// Deliberate in-app browser windows (the KinglyVault device approval,
// InfiniBot Cloud in-app) are marked with
// markInAppBrowser() and keep their own behaviour, as do popups they open.
'use strict';

const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const PASSTHROUGH_SCHEMES = new Set(['infinibot:']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const appOrigins = new Set();
const inAppBrowsers = new WeakSet();

function parse(url) {
  try {
    return new URL(String(url));
  } catch {
    return null;
  }
}

/** Remember an origin main.js loads itself (e.g. a remote control UI). */
function addAppOrigin(url) {
  const u = parse(url);
  if (u && (u.protocol === 'http:' || u.protocol === 'https:')) appOrigins.add(u.origin);
}

/** True when `url` belongs to the app and may load inside its windows. */
function isAppUrl(url) {
  const u = parse(url);
  if (!u) return false;
  if (u.protocol === 'file:' || u.protocol === 'devtools:' || u.protocol === 'chrome-devtools:') return true;
  if (u.protocol === 'about:' || u.protocol === 'blob:' || u.protocol === 'data:') return true;
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    if (LOOPBACK_HOSTS.has(u.hostname)) return true;
    return appOrigins.has(u.origin);
  }
  return false;
}

/**
 * What to do with a URL leaving the app: 'external' (hand to the OS browser),
 * 'passthrough' (let Electron/the protocol handler deal with it), 'block'.
 */
function classify(url) {
  const u = parse(url);
  if (!u) return 'block';
  if (EXTERNAL_SCHEMES.has(u.protocol)) return 'external';
  if (PASSTHROUGH_SCHEMES.has(u.protocol)) return 'passthrough';
  return 'block';
}

function markInAppBrowser(contents) {
  if (contents) inAppBrowsers.add(contents);
}

function isInAppBrowser(contents) {
  return Boolean(contents) && inAppBrowsers.has(contents);
}

/**
 * Open `url` in the default browser if it is http(s)/mailto. Returns true when
 * handed to the OS. `log` gets one line per decision (the proof trail).
 */
async function openExternalSafe(shell, url, log = () => {}) {
  if (classify(url) !== 'external') {
    log(`[external-link] blocked ${String(url).slice(0, 200)}`);
    return false;
  }
  log(`[external-link] openExternal ${url}`);
  try {
    await shell.openExternal(String(url));
    return true;
  } catch (err) {
    log(`[external-link] openExternal failed: ${err?.message ?? err}`);
    return false;
  }
}

function navUrl(details, urlArg) {
  return (details && typeof details === 'object' && details.url) || urlArg;
}

function isMainFrameNav(details) {
  // Electron ≥ 25 passes a details object as the event; older passes (e, url).
  return !(details && typeof details === 'object' && details.isMainFrame === false);
}

/** Wire the policy onto one webContents. */
function guardWebContents(contents, { shell, log }) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isInAppBrowser(contents)) return { action: 'allow' };
    // The app's own pages (pop-outs of the local gateway UI) keep opening
    // in-app, as before.
    if (isAppUrl(url)) return { action: 'allow' };
    const kind = classify(url);
    if (kind === 'passthrough') return { action: 'allow' };
    if (kind === 'external') void openExternalSafe(shell, url, log);
    else log(`[external-link] blocked window.open ${String(url).slice(0, 200)}`);
    return { action: 'deny' };
  });
  contents.on('did-create-window', (win) => {
    // Popups a deliberate in-app browser opens (OAuth) stay in-app too.
    if (isInAppBrowser(contents)) markInAppBrowser(win.webContents);
  });
  const onNav = (event, urlArg) => {
    if (isInAppBrowser(contents)) return;
    const url = navUrl(event, urlArg);
    if (!isMainFrameNav(event) || isAppUrl(url)) return;
    const kind = classify(url);
    if (kind === 'passthrough') return;
    event.preventDefault();
    if (kind === 'external') void openExternalSafe(shell, url, log);
    else log(`[external-link] blocked navigation ${String(url).slice(0, 200)}`);
  };
  contents.on('will-navigate', onNav);
  contents.on('will-redirect', onNav);
}

/** Install for every webContents, including ones created later. */
function installExternalLinkPolicy(app, { shell, log }) {
  app.on('web-contents-created', (_e, contents) => guardWebContents(contents, { shell, log }));
}

module.exports = {
  addAppOrigin,
  classify,
  guardWebContents,
  installExternalLinkPolicy,
  isAppUrl,
  isInAppBrowser,
  markInAppBrowser,
  openExternalSafe,
};

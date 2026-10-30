// KinglyVault licence sign-in and checkout open in the user's default browser,
// like every other external link (see external-links.js). There is no in-app
// window to watch any more, so the infinibot:// return now arrives through
// the OS protocol handler. main.js passes each deep link to deliver(), and that
// settles the flow that is waiting for it.
//
//   open(url, { match })  → openExternalSafe(url), then wait for a deep link
//                           whose host passes `match` (or the timeout)
//   deliver(rawUrl)       → called for every infinibot:// URL the app receives
//
// Resolves { url, reachable }, the same shape the old in-app window returned:
//   url        the captured infinibot:// URL, or null (timed out / superseded)
//   reachable  false when the browser could not be opened at all
// Only one flow waits at a time. Starting a new one settles the previous with
// url:null.
'use strict';

const { openExternalSafe } = require('./external-links');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function hostOf(rawUrl) {
  try {
    const u = new URL(String(rawUrl));
    if (u.protocol !== 'infinibot:') return null;
    // Same host rule as main.js handleProtocolUrl (infinibot:callback?… too).
    return u.hostname || u.pathname.replace(/^\/+/, '').split('/')[0] || '';
  } catch {
    return null;
  }
}

function createKvBrowserFlow({ shell, log = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let pending = null;

  const settle = (result) => {
    const p = pending;
    if (!p) return;
    pending = null;
    clearTimer(p.timer);
    p.resolve(result);
  };

  async function open(targetUrl, { match = () => true } = {}) {
    settle({ url: null, reachable: true });
    const done = new Promise((resolve) => {
      pending = { resolve, match, timer: setTimer(() => settle({ url: null, reachable: true }), timeoutMs) };
    });
    const mine = pending;
    const opened = await openExternalSafe(shell, targetUrl, log);
    if (!opened && pending === mine) settle({ url: null, reachable: false });
    return done;
  }

  function deliver(rawUrl) {
    if (!pending) return false;
    const host = hostOf(rawUrl);
    if (host === null || !pending.match(host)) return false;
    settle({ url: String(rawUrl), reachable: true });
    return true;
  }

  return { open, deliver, isWaiting: () => pending !== null };
}

module.exports = { createKvBrowserFlow, DEFAULT_TIMEOUT_MS };

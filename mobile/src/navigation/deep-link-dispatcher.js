/**
 * deep-link-dispatcher — one place that OPENS a deep link, whoever received
 * it (OS Linking cold/warm start, push tap, in-app banner, notification
 * detail, proactive overlay). App.js registers the real handler once the
 * navigator is mounted; links that arrive earlier (cold start from a push or
 * a Telegram link) are queued and replayed.
 */
let handler = null;
const queue = [];

export function setDeepLinkHandler(fn) {
  handler = typeof fn === 'function' ? fn : null;
  if (handler) {
    while (queue.length) {
      try { handler(queue.shift()); } catch {}
    }
  }
}

/** Open a link; returns true when handled now, false when queued. */
export function openDeepLink(link) {
  if (!link || typeof link !== 'string') return false;
  if (!handler) {
    queue.push(link);
    return false;
  }
  handler(link);
  return true;
}

export function __resetDispatcherForTests() {
  handler = null;
  queue.length = 0;
}

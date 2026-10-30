/**
 * Mobile-side defense-in-depth for sub-agent notification titles.
 *
 * The server-side wiring in `src/notifications/mobile-push.ts` already
 * humanizes the title before it leaves the gateway. This module is a safety
 * net for two cases:
 *   1) An older mobile client cached a raw-runId title before the server fix
 *      shipped; on next open the locally cached notification still looks ugly.
 *   2) Some future code path emits a notification with `data.runId` but a raw
 *      title (e.g. third-party tooling that calls push.send directly without
 *      going through the formatter).
 *
 * Mirrors `humanizeSubagentLabel` in `src/notifications/subagent-format.ts` —
 * keep the regexes in sync if the TS helper changes.
 */

const RUNID_NOISE_RE = /^(coder|subagent|claude|opencode|codex)[-_]/i;
const HEX_TAIL_RE = /[-_][a-z0-9]{4,8}$/i;

export function humanizeSubagentLabel(raw, fallback = 'Sub-agent') {
  const seed = String(raw ?? '').trim();
  if (!seed) return String(fallback ?? '').trim() || 'Sub-agent';
  const looksHuman =
    /\s/.test(seed) && !RUNID_NOISE_RE.test(seed) && !HEX_TAIL_RE.test(seed);
  if (looksHuman) return seed.slice(0, 80);

  let body = seed
    .replace(RUNID_NOISE_RE, '')
    .replace(HEX_TAIL_RE, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!body) return String(fallback ?? '').trim() || 'Sub-agent';
  body = body.charAt(0).toUpperCase() + body.slice(1);
  return body.slice(0, 80);
}

/**
 * Return true if `title` looks like a raw runId / sessionKey leaked through to
 * the UI — e.g. "coder-mobile-foo-x9y2" or "Sub-agent abc12345".
 */
export function titleLooksRaw(title) {
  const s = String(title ?? '').trim();
  if (!s) return false;
  if (RUNID_NOISE_RE.test(s)) return true;
  if (HEX_TAIL_RE.test(s)) return true;
  // "Sub-agent <hex>" / "Subagent <hex>"
  if (/^sub-?agent\s+[a-z0-9]{4,}$/i.test(s)) return true;
  return false;
}

/**
 * Pick the best display title from a notification payload:
 *   1) `displayTitle` (the server-formatted humanized version), if present
 *   2) `title`, if it doesn't look raw
 *   3) humanized fallback derived from data.runId / data.agentLabel / title
 */
export function pickDisplayTitle(payload) {
  if (!payload) return '';
  const disp = String(payload.displayTitle ?? '').trim();
  if (disp) return disp;

  const title = String(payload.title ?? '').trim();
  if (title && !titleLooksRaw(title)) return title;

  const data = payload.data || {};
  const seed = data.agentLabel || data.label || data.runId || title;
  return humanizeSubagentLabel(seed, title || 'Sub-agent');
}

export default { humanizeSubagentLabel, titleLooksRaw, pickDisplayTitle };

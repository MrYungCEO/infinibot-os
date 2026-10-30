/**
 * secure-logic — pure helpers for Secure Mode on mobile (unit-tested in
 * src/__tests__/secure-mode.test.js against src/secure-mode/session-key.ts).
 *
 * Lane membership is decided by the session KEY alone (same rule as the
 * gateway):
 *   agent:<agentId>:secure-<id>          1:1 secure chat
 *   agent:<agentId>:groupchat-sec-<id>   secure group chat (shared session)
 *   agent:<agentId>:gcmember-sec-<id>    a member's private session in it
 *   …:secure-…                            nested sub-agent / thread keys
 */

export const SECURE_SESSION_PREFIX = 'secure-';
export const SECURE_GROUP_PREFIX = 'sec-';
export const SECURE_LOCKED_CODE = 'SECURE_MODE_LOCKED';

function keyRest(key) {
  const m = /^agent:[^:]+:(.+)$/i.exec(String(key).trim());
  return m ? m[1].toLowerCase() : null;
}

export function isSecureSessionKey(key) {
  if (!key || typeof key !== 'string') return false;
  const rest = keyRest(key);
  if (!rest) return false;
  if (rest.startsWith(SECURE_SESSION_PREFIX)) return true;
  if (rest.startsWith(`groupchat-${SECURE_GROUP_PREFIX}`)) return true;
  if (rest.startsWith(`gcmember-${SECURE_GROUP_PREFIX}`)) return true;
  return rest.includes(`:${SECURE_SESSION_PREFIX}`);
}

/** A secure group chat's shared session (never a member session). */
export function isSecureGroupKey(key) {
  const rest = key && typeof key === 'string' ? keyRest(key) : null;
  return Boolean(rest && rest.startsWith(`groupchat-${SECURE_GROUP_PREFIX}`));
}

export function newSecureSessionKey(agentId = 'main', now = Date.now(), rand = Math.random) {
  const tail = Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0');
  return `agent:${agentId || 'main'}:${SECURE_SESSION_PREFIX}${now.toString(36)}-${tail}`;
}

/** The secure board's columns (secure.kanban task statuses). */
export const SECURE_STATUSES = [
  { key: 'todo', label: 'To do' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'review', label: 'Review' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'done', label: 'Done' },
];

const STATUS_KEYS = SECURE_STATUSES.map((s) => s.key);

/** tasks → { todo: [...], in_progress: [...], … } newest first; unknown statuses land in todo. */
export function groupSecureTasks(tasks, projectId = null) {
  const out = Object.fromEntries(STATUS_KEYS.map((k) => [k, []]));
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!t || !t.id) continue;
    if (projectId && t.projectId !== projectId) continue;
    const k = STATUS_KEYS.includes(t.status) ? t.status : 'todo';
    out[k].push(t);
  }
  for (const k of STATUS_KEYS) out[k].sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  return out;
}

/** The next status a "move" tap advances a task to (done wraps to todo). */
export function nextSecureStatus(status) {
  const order = ['todo', 'in_progress', 'review', 'done'];
  const i = order.indexOf(status);
  return i < 0 ? 'in_progress' : order[(i + 1) % order.length];
}

/** True when an RPC error means the method does not exist on this gateway. */
export function isUnknownMethod(err) {
  return /unknown method|no handler|not found|method not/i.test(String(err?.message || err || ''));
}

/** A human message for a secure.* failure. */
export function secureErrorText(err) {
  if (err?.code === SECURE_LOCKED_CODE) return 'Secure Mode is off. Turn it on to open the secure lane.';
  if (isUnknownMethod(err)) return 'This gateway does not support Secure Mode yet. Update and restart the gateway.';
  return String(err?.message || err || 'Secure Mode request failed').replace(/^Error:\s*/, '');
}

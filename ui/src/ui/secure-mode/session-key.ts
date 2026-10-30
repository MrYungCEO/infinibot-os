/**
 * Secure Mode lane membership by session key (mirrors src/secure-mode/session-key.ts).
 *
 *   agent:<agentId>:secure-<id>          1:1 secure chat
 *   agent:<agentId>:groupchat-sec-<id>   secure group chat
 *   agent:<agentId>:gcmember-sec-<id>    a member's private session in it
 *
 * Pure + DOM-free so it runs under node vitest.
 */

export const SECURE_SESSION_PREFIX = "secure-";
export const SECURE_GROUP_KEY_PREFIX = "groupchat-sec-";
export const SECURE_MEMBER_KEY_PREFIX = "gcmember-sec-";

/** Last secure 1:1 chat key the user was in (restored when they toggle back on). */
export const LAST_SECURE_SESSION_STORAGE_KEY = "ib.secure.lastSessionKey";
/** Normal chat key to return to when the user toggles the composer off. */
export const LAST_NORMAL_SESSION_STORAGE_KEY = "ib.secure.lastNormalSessionKey";

function keyRest(key: string): string | null {
  const m = /^agent:[^:]+:(.+)$/i.exec(key.trim());
  return m ? m[1].toLowerCase() : null;
}

export function isSecureSessionKey(key: string | null | undefined): boolean {
  if (!key || typeof key !== "string") return false;
  const rest = keyRest(key);
  if (!rest) return false;
  if (rest.startsWith(SECURE_SESSION_PREFIX)) return true;
  if (rest.startsWith(SECURE_GROUP_KEY_PREFIX)) return true;
  if (rest.startsWith(SECURE_MEMBER_KEY_PREFIX)) return true;
  // Sub-agent / thread keys nest the parent key: agent:main:secure-x:thread:1
  return rest.includes(`:${SECURE_SESSION_PREFIX}`);
}

/** A secure GROUP chat key (`agent:<id>:groupchat-sec-…`). */
export function isSecureGroupKey(key: string | null | undefined): boolean {
  if (!key || typeof key !== "string") return false;
  const rest = keyRest(key);
  return Boolean(rest && rest.startsWith(SECURE_GROUP_KEY_PREFIX));
}

/** A fresh secure 1:1 key, same shape the gateway mints for `secure.session.new`. */
export function newSecureSessionKey(agentId = "main", now = Date.now(), rand = Math.random()): string {
  const id = (agentId || "main").trim() || "main";
  const tail = Math.floor(rand * 36 ** 6)
    .toString(36)
    .padStart(6, "0")
    .slice(-6);
  return `agent:${id}:${SECURE_SESSION_PREFIX}${now.toString(36)}-${tail}`;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function safeStorage(): StorageLike | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function readStoredKey(name: string, storage: StorageLike | null = safeStorage()): string | null {
  try {
    const v = storage?.getItem(name);
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

export function writeStoredKey(name: string, value: string | null, storage: StorageLike | null = safeStorage()): void {
  try {
    if (value) storage?.setItem(name, value);
    else storage?.removeItem(name);
  } catch {
    /* storage full / blocked */
  }
}

/**
 * Lane switch plan for a chat composer toggle. Pure: given where the user is
 * and what was remembered, returns the key to open and what to remember.
 * `next === null` means "open a fresh draft" (webchat creates the key on send).
 */
export function planSecureLaneSwitch(opts: {
  toSecure: boolean;
  currentKey: string | null;
  lastSecureKey: string | null;
  lastNormalKey: string | null;
  agentId?: string;
  now?: number;
  rand?: number;
}): { next: string | null; rememberSecure: string | null; rememberNormal: string | null } {
  const { toSecure, currentKey } = opts;
  if (toSecure) {
    const rememberNormal = currentKey && !isSecureSessionKey(currentKey) ? currentKey : opts.lastNormalKey;
    const reuse = opts.lastSecureKey && isSecureSessionKey(opts.lastSecureKey) ? opts.lastSecureKey : null;
    const next = reuse ?? newSecureSessionKey(opts.agentId ?? "main", opts.now, opts.rand);
    return { next, rememberSecure: next, rememberNormal };
  }
  const rememberSecure = currentKey && isSecureSessionKey(currentKey) ? currentKey : opts.lastSecureKey;
  const back = opts.lastNormalKey && !isSecureSessionKey(opts.lastNormalKey) ? opts.lastNormalKey : null;
  return { next: back, rememberSecure, rememberNormal: back };
}

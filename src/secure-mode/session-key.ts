/**
 * Which sessions belong to the Secure Mode lane.
 *
 * Lane membership is decided by the session KEY alone, so every layer
 * (model resolution, tool assembly, transcripts, hooks, chat.send) can check
 * it synchronously without a store lookup that might fail open:
 *
 *   agent:<agentId>:secure-<id>          1:1 secure chat
 *   agent:<agentId>:groupchat-sec-<id>   secure group chat (shared session)
 *   agent:<agentId>:gcmember-sec-<id>    a member's private session in it
 *
 * A key is secure forever: turning Secure Mode off locks the lane, it never
 * re-labels a secure session as normal.
 */

export const SECURE_SESSION_PREFIX = "secure-";
/** Group ids of secure group chats start with this (valid group-id chars). */
export const SECURE_GROUP_PREFIX = "sec-";

function keyRest(key: string): string | null {
  const m = /^agent:[^:]+:(.+)$/i.exec(key.trim());
  return m ? m[1].toLowerCase() : null;
}

export function isSecureSessionKey(key: string | null | undefined): boolean {
  if (!key || typeof key !== "string") return false;
  const rest = keyRest(key);
  if (!rest) return false;
  if (rest.startsWith(SECURE_SESSION_PREFIX)) return true;
  if (rest.startsWith(`groupchat-${SECURE_GROUP_PREFIX}`)) return true;
  if (rest.startsWith(`gcmember-${SECURE_GROUP_PREFIX}`)) return true;
  // Sub-agent / thread keys nest the parent key: agent:main:secure-x:thread:1
  return rest.includes(`:${SECURE_SESSION_PREFIX}`);
}

export function isSecureGroupId(groupId: string | null | undefined): boolean {
  return typeof groupId === "string" && groupId.toLowerCase().startsWith(SECURE_GROUP_PREFIX);
}

export function newSecureSessionKey(agentId = "main", now = Date.now()): string {
  const tail = Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .padStart(6, "0");
  return `agent:${agentId || "main"}:${SECURE_SESSION_PREFIX}${now.toString(36)}-${tail}`;
}

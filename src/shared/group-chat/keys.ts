/** Session-key helpers for agent group chats. */

/** Key rest prefix of the group's own (shared transcript) session. */
export const GROUP_CHAT_PREFIX = "groupchat-";
/**
 * Key rest prefix of a member agent's private session inside a group. Must NOT
 * start with GROUP_CHAT_PREFIX: chat lists filter by key-rest prefix.
 */
export const GROUP_MEMBER_PREFIX = "gcmember-";

const GROUP_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

function keyRest(key: string | null | undefined): string | null {
  if (!key) return null;
  const m = /^agent:[^:]+:(.+)$/.exec(key);
  return m ? m[1] : null;
}

export function isGroupMemberKey(key: string | null | undefined): boolean {
  return keyRest(key)?.startsWith(GROUP_MEMBER_PREFIX) ?? false;
}

/** True for the group's shared session (never for member sessions). */
export function isGroupChatKey(key: string | null | undefined): boolean {
  const rest = keyRest(key);
  return Boolean(
    rest && rest.startsWith(GROUP_CHAT_PREFIX) && !rest.startsWith(GROUP_MEMBER_PREFIX),
  );
}

export function groupIdFromKey(key: string | null | undefined): string | null {
  const rest = keyRest(key);
  if (!rest) return null;
  if (rest.startsWith(GROUP_MEMBER_PREFIX)) return rest.slice(GROUP_MEMBER_PREFIX.length) || null;
  if (rest.startsWith(GROUP_CHAT_PREFIX)) return rest.slice(GROUP_CHAT_PREFIX.length) || null;
  return null;
}

export function isValidGroupId(id: string): boolean {
  return GROUP_ID_RE.test(id);
}

export function newGroupId(now = Date.now(), rand = Math.random()): string {
  const tail = Math.floor(rand * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `${now.toString(36)}${tail}`;
}

export function groupChatKey(ownerAgentId: string, groupId: string): string {
  return `agent:${ownerAgentId || "main"}:${GROUP_CHAT_PREFIX}${groupId}`;
}

export function groupMemberKey(agentId: string, groupId: string): string {
  return `agent:${agentId}:${GROUP_MEMBER_PREFIX}${groupId}`;
}

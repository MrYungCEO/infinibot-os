/**
 * Which broadcast events a workspace-user connection may receive. Deny by
 * default: the owner's live events (kanban edits, device pairing, health,
 * other people's chats) never reach a user socket. Users get keep-alives and
 * the streaming events of their OWN chat sessions.
 */

import { isOwnSessionKey } from "./authz.js";
import type { ClientAccess } from "./runtime.js";

const ALWAYS = new Set(["tick", "shutdown", "access.changed"]);
const SESSION_SCOPED = new Set(["chat", "agent", "chat.tool_status", "tool_status"]);

export function userMayReceiveEvent(
  access: ClientAccess,
  event: string,
  payload: unknown,
): boolean {
  if (ALWAYS.has(event)) return true;
  if (SESSION_SCOPED.has(event)) {
    const key =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).sessionKey
        : undefined;
    return isOwnSessionKey(access.userId, key);
  }
  return false;
}

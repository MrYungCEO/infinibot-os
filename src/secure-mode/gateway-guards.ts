/** Small request-level guards shared by gateway handlers. */

import { getSecureModeRuntime } from "./runtime.js";

/**
 * Why a chat.send / groupchat.send into a secure session must be refused, or
 * null when it may proceed.
 */
export function secureChatSendBlockReason(p: { remote?: boolean }): string | null {
  if (!getSecureModeRuntime().isUnlocked()) {
    return "Secure Mode is off: this secure session is locked. Turn Secure Mode on to continue it.";
  }
  if (p.remote) {
    return "Blocked by Secure Mode: secure sessions run on this machine only and cannot be forwarded to another node.";
  }
  return null;
}

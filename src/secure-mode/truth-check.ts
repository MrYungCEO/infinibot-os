/**
 * Secure-chat truthfulness post-check — the same guard group chats use
 * (shared/group-chat/truth-guard.ts), applied to a Secure Mode chat reply.
 *
 * After a secure turn the gateway reads that turn's tool calls and REAL
 * results back from the (RAM) transcript. A reply that says files were
 * renamed / moved / tagged, a task was created, or that something is "done",
 * with no successful tool result behind it, gets a visible gateway note
 * appended to the same secure session: the owner sees it right under the
 * claim and the agent sees it on its next turn. Nothing leaves the lane.
 */
import type { ToolActivity } from "../shared/group-chat/activity.js";
import {
  checkReplyClaims,
  formatUnverified,
  type UnverifiedClaim,
} from "../shared/group-chat/truth-guard.js";

export function secureReplyTruthNote(params: {
  reply: string;
  activity: ToolActivity[];
  evidenceText?: string;
}): { flags: UnverifiedClaim[]; note: string } | null {
  const flags = checkReplyClaims({
    reply: params.reply,
    own: params.activity,
    knownText: params.evidenceText ?? "",
  });
  if (!flags.length) return null;
  const changed = params.activity.filter((a) => a.ok && a.organize && a.organize.changed > 0);
  const tail = changed.length
    ? `\n(Recorded file changes this turn: ${changed.map((a) => `${a.summary} → ${a.organize!.changed} changed`).join("; ")}.)`
    : "";
  return { flags, note: `${formatUnverified(flags)}${tail}` };
}

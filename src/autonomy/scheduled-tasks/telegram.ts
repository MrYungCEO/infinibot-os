/**
 * Telegram callbacks + replies for scheduled-task approvals.
 *
 *   callback_data  st:<code>:<id>   (codes in render.ts ACTION_CODES)
 *   Modify / Continue  → a force-reply prompt carrying `#sched-<m|c>:<itemId>`;
 *                        the owner's reply to it becomes the instruction.
 *
 * Only the owner (channels.telegram.allowFrom[0]) may decide. The functions are transport-free (they return
 * what to say) so bot-handlers.ts only needs a two-line hook and tests don't
 * need grammy.
 */

import { PipelineError } from "./pipeline.js";
import { ACTION_CODES, esc } from "./render.js";
import type { ScheduledTaskService } from "./service.js";
import type { DecisionAction } from "./types.js";

const CODE_TO_ACTION = new Map<string, DecisionAction | "approve_low_risk">(
  Object.entries(ACTION_CODES).map(([a, c]) => [c, a as DecisionAction | "approve_low_risk"]),
);

const REPLY_MARKER = /#sched-(m|c):(si_[A-Za-z0-9]+)/;

export function isScheduledTaskCallback(data: string): boolean {
  return data.startsWith("st:");
}

export function parseCallback(
  data: string,
): { action: DecisionAction | "approve_low_risk"; id: string } | null {
  const [prefix, code, id] = data.trim().split(":");
  if (prefix !== "st" || !code || !id) return null;
  const action = CODE_TO_ACTION.get(code);
  return action ? { action, id } : null;
}

export interface CallbackOutcome {
  /** Short toast / reply text for the owner. */
  reply: string;
  /** When set, send this as a force-reply prompt (modify / continue). */
  forceReplyPrompt?: string;
}

/** Stricter than the autopilot shortcut: no configured owner → nobody can decide from chat. */
function ownerAllowed(senderId: string | null, ownerId: string | null): boolean {
  return Boolean(ownerId && senderId && senderId === ownerId);
}

export async function handleScheduledTaskCallback(
  svc: ScheduledTaskService,
  input: { data: string; senderId: string | null; ownerId: string | null; actor: string },
): Promise<CallbackOutcome | null> {
  const parsed = parseCallback(input.data);
  if (!parsed) return null;
  if (!ownerAllowed(input.senderId, input.ownerId)) return { reply: "Only the owner can decide." };
  try {
    if (parsed.action === "approve_low_risk") {
      const done = await svc.approveLowRisk(parsed.id, input.actor);
      return { reply: `Approved ${done.length} low-risk item(s).` };
    }
    if (parsed.action === "modify" || parsed.action === "continue") {
      const item = svc.store.getItem(parsed.id);
      if (!item) return { reply: "That item no longer exists." };
      const tag = parsed.action === "modify" ? "m" : "c";
      const what =
        parsed.action === "modify"
          ? "how to change this item (it will be approved with your changes)"
          : "the instruction for the agent to continue with";
      return {
        reply: "Reply with your instructions.",
        forceReplyPrompt: `✎ <b>${esc(item.item.title)}</b>\nReply to this message with ${what}.\n#sched-${tag}:${item.id}`,
      };
    }
    const item = await svc.decide(parsed.id, {
      action: parsed.action,
      actor: input.actor,
      ...(parsed.action === "snooze" ? { snoozeHours: 24 } : {}),
    });
    return { reply: `${item.item.title}: ${item.stage.replace(/_/g, " ")}` };
  } catch (err) {
    if (err instanceof PipelineError || err instanceof Error) return { reply: err.message };
    return { reply: String(err) };
  }
}

/**
 * A text message that replies to one of our force-reply prompts. Returns null
 * when the message is not for us (so normal routing continues).
 */
export async function handleScheduledTaskReply(
  svc: ScheduledTaskService,
  input: {
    replyToText: string | null | undefined;
    text: string;
    senderId: string | null;
    ownerId: string | null;
    actor: string;
  },
): Promise<string | null> {
  const m = input.replyToText?.match(REPLY_MARKER);
  if (!m) return null;
  if (!ownerAllowed(input.senderId, input.ownerId)) return "Only the owner can decide.";
  const instruction = input.text.trim();
  if (!instruction) return "Empty instruction — nothing changed.";
  try {
    const item = await svc.decide(m[2], {
      action: m[1] === "m" ? "modify" : "continue",
      instruction,
      actor: input.actor,
    });
    return `✓ ${item.item.title}: ${item.stage.replace(/_/g, " ")} with your instruction.`;
  } catch (err) {
    return (err as Error)?.message ?? String(err);
  }
}

// ── grammy glue (kept here so bot-handlers.ts only needs a short hook) ──────

interface BotApiLike {
  sendMessage(
    chatId: number | string,
    text: string,
    other?: Record<string, unknown>,
  ): Promise<unknown>;
}

interface TgUser {
  id?: number;
  username?: string;
}

function actorOf(from: TgUser | undefined): string {
  return from?.username ? `@${from.username}` : from?.id ? `telegram:${from.id}` : "telegram";
}

/** Handle a `st:` callback; returns true when it was ours. */
export async function routeScheduledTaskCallback(
  api: BotApiLike,
  callback: { data?: string; from?: TgUser; message?: { chat: { id: number } } },
  ownerId: string | null,
): Promise<boolean> {
  const data = (callback.data ?? "").trim();
  if (!isScheduledTaskCallback(data)) return false;
  const chatId = callback.message?.chat.id;
  const { getScheduledTaskService } = await import("./runtime.js");
  const out = await handleScheduledTaskCallback(getScheduledTaskService(), {
    data,
    senderId: callback.from?.id ? String(callback.from.id) : null,
    ownerId,
    actor: actorOf(callback.from),
  });
  if (!out || chatId === undefined) return true;
  if (out.forceReplyPrompt) {
    await api
      .sendMessage(chatId, out.forceReplyPrompt, {
        parse_mode: "HTML",
        reply_markup: { force_reply: true, input_field_placeholder: "Your instructions…" },
      })
      .catch(() => {});
  } else {
    await api.sendMessage(chatId, out.reply).catch(() => {});
  }
  return true;
}

/** Handle a reply to one of our force-reply prompts; returns true when it was ours. */
export async function routeScheduledTaskReply(
  api: BotApiLike,
  msg: {
    text?: string;
    from?: TgUser;
    chat: { id: number };
    reply_to_message?: { text?: string };
  },
  ownerId: string | null,
): Promise<boolean> {
  const replyTo = msg.reply_to_message?.text;
  if (!replyTo || !REPLY_MARKER.test(replyTo) || typeof msg.text !== "string") return false;
  const { getScheduledTaskService } = await import("./runtime.js");
  const out = await handleScheduledTaskReply(getScheduledTaskService(), {
    replyToText: replyTo,
    text: msg.text,
    senderId: msg.from?.id ? String(msg.from.id) : null,
    ownerId,
    actor: actorOf(msg.from),
  });
  if (out) await api.sendMessage(msg.chat.id, out).catch(() => {});
  return out !== null;
}

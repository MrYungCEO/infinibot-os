/**
 * Inbound side of the escalation protocol.
 *
 * ── Why an observer rather than a branch in the reply pipeline ───────────────
 * `dispatchInboundMessage` is the one seam every channel funnels through, and
 * it is also the single hottest, most heavily tested path in this codebase.
 * Escalation correlation therefore registers as an *observer*: with no
 * observers registered the call is a no-op and nothing about message handling
 * changes. Errors are swallowed, because a failure to correlate a reply must
 * never drop the user's message.
 *
 * ── Correlation, honestly ───────────────────────────────────────────────────
 * The correlation handle lives in the message *body* (`[#ESC-7K2QF4]`) rather
 * than in provider threading metadata. That is a deliberate lowest-common-
 * denominator choice: Slack and Discord expose reply threading, Telegram
 * exposes `reply_to_message_id`, WhatsApp exposes quoted-message ids, Signal
 * exposes quote timestamps, and iMessage exposes essentially nothing usable.
 * A body tag works identically on all seven, survives a copy-paste, and a
 * human can type it from memory.
 *
 * The fallback — "most recently delivered, still unanswered escalation on this
 * channel and target" — is only correct when the human replies in the same
 * conversation and has not been sent two escalations at once. It is used only
 * when a channel+target is known, and never across agencies.
 */

import type { EscalationInboundResult, EscalationService } from "./escalation-service.js";
import { normalizeChatChannelId } from "../channels/registry.js";

export type EscalationInboundMessage = {
  /** Channel the message arrived on; normalised against the registry. */
  channelId?: string | null;
  /** Conversation identifier — chat id, channel id, JID. */
  target?: string | null;
  /** Who sent it, when the channel distinguishes sender from conversation. */
  from?: string | null;
  text: string;
  agencyId?: string | null;
  actorId?: string | null;
};

export type EscalationReplyObserver = (message: EscalationInboundMessage) => void | Promise<void>;

const observers = new Set<EscalationReplyObserver>();

/** Register an observer. Returns the un-register function. */
export function registerEscalationReplyObserver(observer: EscalationReplyObserver): () => void {
  observers.add(observer);
  return () => observers.delete(observer);
}

export function clearEscalationReplyObservers(): void {
  observers.clear();
}

export function hasEscalationReplyObservers(): boolean {
  return observers.size > 0;
}

/**
 * Fire-and-forget. Called from the inbound dispatch path; must never throw,
 * never await, and never alter what the agent does with the message.
 */
export function notifyEscalationReplyObservers(message: EscalationInboundMessage): void {
  if (!observers.size) return;
  for (const observer of observers) {
    try {
      void Promise.resolve(observer(message)).catch(() => {});
    } catch {
      /* an observer must not be able to break message handling */
    }
  }
}

/**
 * The standard observer: correlate an inbound message with an open escalation
 * for one agency. `resolveAgencyId` lets the gateway decide which agency a
 * conversation belongs to (today: the caller's single agency).
 */
export function createEscalationReplyObserver(input: {
  service: EscalationService;
  /**
   * Which agency this conversation belongs to. Returning null is legitimate
   * and common: without an agency the tag path still works (correlation codes
   * are globally unique in practice), but the "most recent on this channel"
   * fallback is skipped rather than guessed at.
   */
  resolveAgencyId?: (message: EscalationInboundMessage) => string | null;
  onResult?: (result: EscalationInboundResult) => void;
}): EscalationReplyObserver {
  return (message) => {
    const text = String(message.text ?? "").trim();
    if (!text) return;
    const agencyId = message.agencyId ?? input.resolveAgencyId?.(message) ?? null;
    const result = input.service.ingestReply({
      agencyId,
      channelId: normalizeChatChannelId(message.channelId ?? null),
      target: message.target ?? message.from ?? null,
      text,
      actorId: message.actorId ?? null,
    });
    input.onResult?.(result);
  };
}

/**
 * Last line of defence before an error reaches a chat client: provider
 * payloads (JSON blobs, "429 …" lines) become beginner-friendly text. The raw
 * error is logged here and never sent.
 */

import {
  friendlyErrorLine,
  humanizeProviderError,
  looksLikeRawProviderError,
} from "../agents/provider-error-messages.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/chat-errors");

export type ChatErrorDetail = { errorCode?: string; errorHint?: string };

/** Humanize a chat `state:"error"` message unless it's already user-facing. */
export function humanizeChatError(
  errorMessage: string | undefined,
  detail?: ChatErrorDetail,
): { errorMessage?: string; errorHint?: string } {
  if (!errorMessage || detail?.errorHint || !looksLikeRawProviderError(errorMessage)) {
    return { errorMessage, errorHint: detail?.errorHint };
  }
  log.warn(`provider error surfaced to chat: ${errorMessage.slice(0, 2000)}`);
  const h = humanizeProviderError(errorMessage);
  return { errorMessage: h.message, errorHint: h.resolution };
}

/**
 * chat.history: assistant turns that died on a provider error carry the raw
 * payload in `errorMessage`. Replace it with the friendly line (flagged
 * `errorFriendly` so the UI doesn't re-process it).
 */
export function humanizeHistoryErrors(messages: unknown[]): unknown[] {
  let changed = false;
  const out = messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    const rec = m as Record<string, unknown>;
    if (rec.role !== "assistant" || typeof rec.errorMessage !== "string" || rec.errorFriendly) {
      return m;
    }
    const raw = rec.errorMessage.trim();
    if (!raw) return m;
    changed = true;
    return {
      ...rec,
      errorMessage: friendlyErrorLine(raw, {
        provider: typeof rec.provider === "string" ? rec.provider : undefined,
        model: typeof rec.model === "string" ? rec.model : undefined,
      }),
      errorFriendly: true,
    };
  });
  return changed ? out : messages;
}

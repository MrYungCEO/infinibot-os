/**
 * Shared rendering for pre-reply agent failures and the "model healed" notice,
 * so webchat, classic chat, Grid panels, the agent chat modal and the voice
 * transcript all say the same thing.
 *
 * Gateway contract (src/gateway/server-chat.ts, src/agents/turn-failure.ts):
 *   chat  { state: "error", errorMessage, errorCode?, errorHint? }
 *   agent { stream: "notice", data: { kind: "model_fallback", from, to, message } }
 */

import {
  friendlyErrorLine,
  humanizeProviderError,
  looksLikeRawProviderError,
} from "../../../src/agents/provider-error-messages.js";

export type ChatErrorFields = {
  errorMessage?: string;
  errorCode?: string;
  errorHint?: string;
};

export type ModelFallbackNotice = {
  /** "secure_model": Secure Mode moved the run onto a local model. */
  kind?: "model_fallback" | "secure_model" | "cli_fallback";
  runId?: string;
  sessionKey?: string;
  from: string;
  to: string;
  message: string;
};

/** Default next step when the gateway didn't send one for a model failure. */
const MODEL_UNAVAILABLE_HINT =
  "Switch model: pick another one in the chat's model picker (or send /model provider/model).";

export function formatChatErrorText(payload: ChatErrorFields | undefined): string {
  let message = payload?.errorMessage?.trim() || "The agent failed before replying.";
  // Older gateways forward raw provider payloads; never show JSON to the user.
  if (!payload?.errorHint && looksLikeRawProviderError(message)) {
    const h = humanizeProviderError(message);
    return `${h.severity === "info" ? "ℹ️" : "⚠️"} ${h.message}\n\n${h.resolution}`;
  }
  const hint =
    payload?.errorHint?.trim() ||
    (payload?.errorCode === "model_unavailable" ? MODEL_UNAVAILABLE_HINT : "");
  return hint ? `⚠️ ${message}\n\n${hint}` : `⚠️ ${message}`;
}

export function parseModelFallbackNotice(payload: unknown): ModelFallbackNotice | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { stream?: unknown; runId?: unknown; sessionKey?: unknown; data?: unknown };
  if (p.stream !== "notice" || !p.data || typeof p.data !== "object") return null;
  const d = p.data as Record<string, unknown>;
  if (d.kind !== "model_fallback" && d.kind !== "secure_model" && d.kind !== "cli_fallback")
    return null;
  const from = typeof d.from === "string" ? d.from : "";
  const to = typeof d.to === "string" ? d.to : "";
  if (!from || !to) return null;
  return {
    kind: d.kind,
    runId: typeof p.runId === "string" ? p.runId : undefined,
    sessionKey: typeof p.sessionKey === "string" ? p.sessionKey : undefined,
    from,
    to,
    message: typeof d.message === "string" ? d.message : `model ${from} unavailable — using ${to}`,
  };
}

export function formatModelFallbackNotice(notice: ModelFallbackNotice): string {
  if (notice.kind === "secure_model") return `Secure Mode: using ${notice.to} (local)`;
  if (notice.kind === "cli_fallback") return `ℹ️ ${notice.message}`;
  return `ℹ️ ${notice.from} isn't available (retired upstream?) — this reply came from ${notice.to}. Pick a different model in the model picker to change it.`;
}

/**
 * Text for an assistant transcript turn that ended on a provider error.
 * The gateway pre-humanizes these (errorFriendly); older transcripts/gateways
 * still carry the raw provider payload.
 */
export function formatAssistantTurnError(message: {
  errorMessage?: unknown;
  errorFriendly?: unknown;
  provider?: unknown;
  model?: unknown;
}): string | null {
  const raw = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
  if (!raw) return null;
  const line =
    message.errorFriendly === true
      ? raw
      : friendlyErrorLine(raw, {
          provider: typeof message.provider === "string" ? message.provider : undefined,
          model: typeof message.model === "string" ? message.model : undefined,
        });
  return `⚠️ ${line}`;
}

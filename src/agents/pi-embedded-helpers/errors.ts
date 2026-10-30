import type { AssistantMessage } from "@mariozechner/pi-ai";

import type { InfinibotConfig } from "../../config/config.js";
import { friendlyProviderErrorText } from "../provider-error-messages.js";
import { formatSandboxToolPolicyBlockedMessage } from "../sandbox.js";
import {
  collapseConsecutiveDuplicateBlocks,
  ERROR_PREFIX_RE,
  formatRawAssistantErrorForUi,
  isContextOverflowError,
  isLikelyHttpErrorText,
  isOverloadedErrorMessage,
  isRateLimitErrorMessage,
  isRawApiErrorPayload,
  isTimeoutErrorMessage,
  stripFinalTagsFromText,
} from "./error-classify.js";

export * from "./error-classify.js";

export function formatAssistantErrorText(
  msg: AssistantMessage,
  opts?: { cfg?: InfinibotConfig; sessionKey?: string },
): string | undefined {
  // Also format errors if errorMessage is present, even if stopReason isn't "error"
  const raw = (msg.errorMessage ?? "").trim();
  if (msg.stopReason !== "error" && !raw) return undefined;
  if (!raw) return "LLM request failed with an unknown error.";

  const unknownTool =
    raw.match(/unknown tool[:\s]+["']?([a-z0-9_-]+)["']?/i) ??
    raw.match(/tool\s+["']?([a-z0-9_-]+)["']?\s+(?:not found|is not available)/i);
  if (unknownTool?.[1]) {
    const rewritten = formatSandboxToolPolicyBlockedMessage({
      cfg: opts?.cfg,
      sessionKey: opts?.sessionKey,
      toolName: unknownTool[1],
    });
    if (rewritten) return rewritten;
  }

  // Catch role ordering errors - including JSON-wrapped and "400" prefix variants
  if (
    /incorrect role information|roles must alternate|400.*role|"message".*role.*information/i.test(
      raw,
    )
  ) {
    return (
      "Message ordering conflict - please try again. " +
      "If this persists, use /new to start a fresh session."
    );
  }

  // Everything else is a provider error: beginner-friendly text for the user,
  // the raw payload stays in the logs.
  if (raw.length > 200 || isRawApiErrorPayload(raw)) {
    console.warn("[formatAssistantErrorText] provider error:", raw.slice(0, 2000));
  }
  return friendlyProviderErrorText(raw, { provider: msg.provider, model: msg.model });
}

export function sanitizeUserFacingText(text: string): string {
  if (!text) return text;
  const stripped = stripFinalTagsFromText(text);
  const trimmed = stripped.trim();
  if (!trimmed) return stripped;

  if (/incorrect role information|roles must alternate/i.test(trimmed)) {
    return (
      "Message ordering conflict - please try again. " +
      "If this persists, use /new to start a fresh session."
    );
  }

  if (isContextOverflowError(trimmed)) {
    return friendlyProviderErrorText(trimmed);
  }

  if (isRawApiErrorPayload(trimmed) || isLikelyHttpErrorText(trimmed)) {
    return friendlyProviderErrorText(trimmed);
  }

  if (ERROR_PREFIX_RE.test(trimmed)) {
    if (
      isOverloadedErrorMessage(trimmed) ||
      isRateLimitErrorMessage(trimmed) ||
      isTimeoutErrorMessage(trimmed)
    ) {
      return friendlyProviderErrorText(trimmed);
    }
    return formatRawAssistantErrorForUi(trimmed);
  }

  return collapseConsecutiveDuplicateBlocks(stripped);
}

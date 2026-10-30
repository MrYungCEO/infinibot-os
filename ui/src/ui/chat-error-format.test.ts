import { describe, expect, it } from "vitest";

import {
  formatAssistantTurnError,
  formatChatErrorText,
  formatModelFallbackNotice,
  parseModelFallbackNotice,
} from "./chat-error-format";

describe("formatChatErrorText", () => {
  it("prefers the gateway hint", () => {
    expect(
      formatChatErrorText({ errorMessage: "boom", errorCode: "model_unavailable", errorHint: "Do X" }),
    ).toBe("⚠️ boom\n\nDo X");
  });
  it("falls back to a model hint for model_unavailable and a generic message otherwise", () => {
    expect(formatChatErrorText({ errorMessage: "gone", errorCode: "model_unavailable" })).toMatch(
      /^⚠️ gone\n\nSwitch model/,
    );
    expect(formatChatErrorText({})).toBe("⚠️ The agent failed before replying.");
  });
  it("never shows a raw provider payload (older gateways)", () => {
    const gemini =
      '{"error":{"code":429,"message":"Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"30s"}]}}';
    const text = formatChatErrorText({ errorMessage: gemini });
    expect(text).toMatch(/^⚠️ Gemini free-tier rate limit reached/);
    expect(text).toContain("Try again in ~30s");
    expect(text).not.toContain("RESOURCE_EXHAUSTED");
  });
});

describe("formatAssistantTurnError", () => {
  it("humanizes raw transcript errors and trusts gateway-flagged ones", () => {
    expect(formatAssistantTurnError({ errorMessage: "429 Provider returned error" })).toMatch(
      /^⚠️ Rate limit reached/,
    );
    expect(formatAssistantTurnError({ errorMessage: "Already nice.", errorFriendly: true })).toBe(
      "⚠️ Already nice.",
    );
    expect(formatAssistantTurnError({ errorMessage: "  " })).toBeNull();
  });
});

describe("parseModelFallbackNotice", () => {
  it("parses notice events and ignores everything else", () => {
    const n = parseModelFallbackNotice({
      runId: "r",
      sessionKey: "s",
      stream: "notice",
      data: { kind: "model_fallback", from: "a/x", to: "a/y", message: "m" },
    });
    expect(n).toEqual({ kind: "model_fallback", runId: "r", sessionKey: "s", from: "a/x", to: "a/y", message: "m" });
    expect(formatModelFallbackNotice(n!)).toContain("a/y");
    expect(parseModelFallbackNotice({ stream: "notice", data: { kind: "other" } })).toBe(null);
    expect(parseModelFallbackNotice({ stream: "tool", data: {} })).toBe(null);
    expect(parseModelFallbackNotice(null)).toBe(null);
  });

  it("formats the Secure Mode auto-switch notice", () => {
    const n = parseModelFallbackNotice({
      runId: "r",
      sessionKey: "agent:main:secure-x",
      stream: "notice",
      data: {
        kind: "secure_model",
        from: "ollama-cloud/gpt-oss:120b",
        to: "vllm-local/qwen3.8-27b",
        message: "Secure Mode: using vllm-local/qwen3.8-27b (local)",
      },
    });
    expect(n?.kind).toBe("secure_model");
    expect(formatModelFallbackNotice(n!)).toBe("Secure Mode: using vllm-local/qwen3.8-27b (local)");
  });
});

describe("formatAssistantTurnError", () => {
  it("turns a rejected-key transcript turn into a visible key hint", () => {
    // What a provider 401 leaves in the transcript: empty content + errorMessage.
    const text = formatAssistantTurnError({
      errorMessage: "401 Unauthorized",
      provider: "ollama-cloud",
      model: "gpt-oss:120b",
    });
    expect(text).toMatch(/^⚠️ /);
    expect(text).toMatch(/Ollama/);
    expect(text).toMatch(/key/i);
  });

  it("returns null when the turn has no error", () => {
    expect(formatAssistantTurnError({ errorMessage: "  " })).toBeNull();
    expect(formatAssistantTurnError({})).toBeNull();
  });
});

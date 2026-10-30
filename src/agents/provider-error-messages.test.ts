import { describe, expect, it } from "vitest";

import {
  formatHumanizedError,
  friendlyProviderErrorText,
  humanizeProviderError,
  humanizeUnknownTool,
  parseUnknownToolError,
} from "./provider-error-messages.js";

const GEMINI_429 = JSON.stringify({
  error: {
    code: 429,
    message:
      "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-2.5-pro\nPlease retry in 56.68s.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          {
            quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
            quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
            quotaDimensions: { location: "global", model: "gemini-2.5-pro" },
            quotaValue: "5",
          },
        ],
      },
      { "@type": "type.googleapis.com/google.rpc.Help", links: [] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "56s" },
    ],
  },
});

function noJson(text: string) {
  expect(text).not.toMatch(/[{}]/);
  expect(text).not.toContain("RESOURCE_EXHAUSTED");
  expect(text).not.toContain("googleapis");
}

describe("humanizeProviderError", () => {
  it("turns the Gemini free-tier 429 blob into a short rate-limit message", () => {
    const h = humanizeProviderError(GEMINI_429, { provider: "google" });
    expect(h.kind).toBe("rate_limit");
    expect(h.retryAfterMs).toBe(56_680);
    expect(h.message).toBe("Gemini free-tier rate limit reached (5 requests/min).");
    expect(h.resolution).toBe(
      "Try again in ~57s, switch to another model, or add billing to your Google AI key.",
    );
    const text = formatHumanizedError(h);
    noJson(text);
    expect(text.startsWith("⚠️ ")).toBe(true);
  });

  it("handles the 'Model error:'-prefixed blob and infers the provider", () => {
    const h = humanizeProviderError(`Model error: ${GEMINI_429}`);
    expect(h.kind).toBe("rate_limit");
    expect(h.message).toContain("Gemini");
    expect(h.retryAfterMs).toBeGreaterThanOrEqual(56_000);
    noJson(formatHumanizedError(h));
  });

  it("parses RetryInfo retryDelay alone", () => {
    const blob = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Resource has been exhausted (e.g. check quota).",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12s" }],
      },
    });
    expect(humanizeProviderError(blob).retryAfterMs).toBe(12_000);
  });

  it("parses OpenAI/Groq 'try again in' hints", () => {
    const h = humanizeProviderError(
      "429 Rate limit reached for model `llama-3.3-70b` on tokens per minute (TPM): Limit 6000. Please try again in 1m2.5s.",
      { provider: "groq" },
    );
    expect(h.kind).toBe("rate_limit");
    expect(h.retryAfterMs).toBe(62_500);
    expect(h.message).toBe("Groq rate limit reached.");
  });

  it("maps 401 invalid key to the BYOK message", () => {
    const h = humanizeProviderError(
      '401 {"error":{"message":"Incorrect API key provided: sk-abc. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key"}}',
      { provider: "openai" },
    );
    expect(h.kind).toBe("auth");
    expect(h.message).toBe("Your OpenAI API key is missing or invalid.");
    expect(h.resolution).toContain("Connect your AI (BYOK)");
    noJson(formatHumanizedError(h));
  });

  it("maps Gemini API_KEY_INVALID (400/403 style)", () => {
    const h = humanizeProviderError(
      JSON.stringify({
        error: { code: 403, message: "Permission denied: API key not valid.", status: "PERMISSION_DENIED" },
      }),
      { provider: "google" },
    );
    expect(h.kind).toBe("auth");
    expect(h.message).toBe("Your Gemini API key is missing or invalid.");
  });

  it("maps missing credentials", () => {
    const h = humanizeProviderError(new Error('No API key found for provider "anthropic".'), {
      provider: "anthropic",
    });
    expect(h.kind).toBe("auth");
  });

  it("maps 402 billing", () => {
    const h = humanizeProviderError(
      '402 {"error":{"message":"This request requires more credits, or fewer max_tokens.","code":402}}',
      { provider: "openrouter" },
    );
    expect(h.kind).toBe("billing");
    expect(h.message).toBe("Your OpenRouter account is out of credit or billing isn't set up.");
    expect(h.resolution).toBe("Add credit/billing to your OpenRouter account, or switch to another model.");
  });

  it("maps Anthropic low credit balance and OpenAI insufficient_quota to billing", () => {
    expect(
      humanizeProviderError(
        '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
      ).kind,
    ).toBe("billing");
    const oa = humanizeProviderError(
      '429 {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}',
      { provider: "openai" },
    );
    expect(oa.kind).toBe("billing");
    expect(oa.message).toBe("Your OpenAI account has used up its quota.");
  });

  it("maps model-not-found", () => {
    const h = humanizeProviderError(
      '404 {"error":{"message":"The model `gpt-9` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}',
      { provider: "openai", model: "gpt-9" },
    );
    expect(h.kind).toBe("model_not_found");
    expect(h.message).toContain('"gpt-9" isn\'t available');
    expect(h.resolution).toContain("Pick another model");
    expect(humanizeProviderError("Unknown model: openai/gpt-9").kind).toBe("model_not_found");
  });

  it("maps context-length errors", () => {
    const h = humanizeProviderError(
      "400 This model's maximum context length is 128000 tokens. However, your messages resulted in 140000 tokens.",
    );
    expect(h.kind).toBe("context_overflow");
    expect(h.message).toBe("This conversation is too long for that model.");
    expect(h.resolution).toContain("Start a new chat");
  });

  it("maps network / 5xx to a transient message", () => {
    expect(humanizeProviderError(new Error("fetch failed (cause: ECONNRESET)")).kind).toBe("transient");
    const h = humanizeProviderError(
      '503 {"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}',
      { provider: "google" },
    );
    expect(h.kind).toBe("transient");
    expect(h.message).toBe("Temporary connection issue with Gemini (it's overloaded right now).");
  });

  it("falls back to a clean line without raw JSON", () => {
    const h = humanizeProviderError('{"error":{"message":{"nested":"weird"},"type":"strange"}}');
    expect(h.kind).toBe("unknown");
    noJson(formatHumanizedError(h));
    expect(h.resolution).toContain("gateway logs");
  });

  it("maps coding-agent exit 127 / not installed", () => {
    for (const raw of [
      "the process exited with code 127",
      "backend exited with code 127 before producing output",
      "No coding agent installed — code tasks have nothing to run on.",
    ]) {
      const h = humanizeProviderError(raw);
      expect(h.kind).toBe("coder_missing");
      expect(friendlyProviderErrorText(raw)).toBe(
        "⚠️ No coding agent is set up in this workspace yet. Connect one (Claude Code / OpenCode / Codex) under Settings → Connect your AI to run code tasks.",
      );
    }
  });

  it("maps unknown tools", () => {
    expect(parseUnknownToolError("Tool write_file not found")).toBe("write_file");
    const h = humanizeProviderError("Tool write_file not found");
    expect(h.kind).toBe("tool_unavailable");
    expect(h.message).toBe("That action (write_file) isn't available here.");
    const withList = humanizeUnknownTool("write_file", ["read", "notes"]);
    expect(withList.resolution).toContain("read, notes");
  });
});

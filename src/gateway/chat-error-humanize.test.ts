import { describe, expect, it } from "vitest";

import { humanizeChatError, humanizeHistoryErrors } from "./chat-error-humanize.js";

const GEMINI =
  '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.\\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5\\nPlease retry in 56.68s.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"56s"}]}}';

describe("humanizeChatError", () => {
  it("rewrites raw provider payloads", () => {
    const out = humanizeChatError(GEMINI);
    expect(out.errorMessage).toBe("Gemini free-tier rate limit reached (5 requests).");
    expect(out.errorHint).toContain("Try again in ~57s");
    expect(out.errorMessage).not.toContain("{");
  });

  it("passes through already-friendly errors", () => {
    expect(humanizeChatError("Agent failed", undefined)).toEqual({
      errorMessage: "Agent failed",
      errorHint: undefined,
    });
    expect(humanizeChatError("x {raw}", { errorHint: "do y" }).errorMessage).toBe("x {raw}");
  });
});

describe("humanizeHistoryErrors", () => {
  it("replaces raw assistant errorMessage and flags it", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [], stopReason: "error", provider: "google", errorMessage: GEMINI },
    ];
    const out = humanizeHistoryErrors(msgs) as Array<Record<string, unknown>>;
    expect(out[0]).toBe(msgs[0]);
    expect(out[1].errorFriendly).toBe(true);
    expect(String(out[1].errorMessage)).toMatch(/^Gemini free-tier rate limit reached/);
    expect(String(out[1].errorMessage)).not.toContain("RESOURCE_EXHAUSTED");
    // idempotent
    expect(humanizeHistoryErrors(out)).toBe(out);
  });
});

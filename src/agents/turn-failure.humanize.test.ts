import { describe, expect, it } from "vitest";

import { FailoverError } from "./failover-error.js";
import { describeAgentTurnFailure } from "./turn-failure.js";

describe("describeAgentTurnFailure (humanized)", () => {
  it("uses the FailoverError raw payload + provider for friendly text", () => {
    const inner = new FailoverError("⚠️ formatted", {
      reason: "rate_limit",
      provider: "google",
      model: "gemini-2.5-pro",
      rawMessage:
        '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota","details":[{"retryDelay":"30s"}]}}',
    });
    const err = new Error("All models failed (2): a | b", { cause: inner });
    const f = describeAgentTurnFailure(err);
    expect(f.errorCode).toBe("rate_limit");
    expect(f.errorMessage).toBe("Gemini rate limit reached.");
    expect(f.errorHint).toContain("Try again in ~30s");
  });

  it("maps missing keys to no_credentials with BYOK guidance", () => {
    const f = describeAgentTurnFailure(new Error('No API key found for provider "openai".'));
    expect(f.errorCode).toBe("no_credentials");
    expect(f.errorHint).toContain("Connect your AI");
  });

  it("keeps plain internal messages", () => {
    expect(describeAgentTurnFailure(new Error("Session is busy")).errorMessage).toBe(
      "Session is busy",
    );
  });
});

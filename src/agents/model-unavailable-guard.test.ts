import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { coerceToFailoverError, resolveFailoverReasonFromError } from "./failover-error.js";
import { orderHealCandidates } from "./model-heal.js";
import {
  clearModelUnavailable,
  getUnavailableModel,
  markModelUnavailable,
  resetUnavailableModelsForTest,
  UNAVAILABLE_TTL_MS,
} from "./model-unavailable.js";
import { classifyFailoverReason, isModelNotFoundErrorMessage } from "./pi-embedded-helpers.js";
import { describeAgentTurnFailure } from "./turn-failure.js";

describe("provider model-not-found detection", () => {
  it("recognises each provider's wording", () => {
    for (const msg of [
      "404 The model `gpt-4-turbo` does not exist or you do not have access to it.",
      '{"error":{"code":404,"message":"models/gemini-1.5-flash is not found for API version v1beta, or is not supported for generateContent.","status":"NOT_FOUND"}}',
      '404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-3-opus-20240229"}}',
      "400 meta/llama-3:free is not a valid model ID",
      "404 No endpoints found for google/gemma-2-9b-it:free.",
      "model 'kimi-k2.5' not found",
      'model "qwen9" not found, try pulling it first',
      "The model `llama3-70b-8192` has been decommissioned and is no longer supported.",
      "Invalid model: devstral-small-2505",
      '{"error":{"code":"model_not_found"}}',
      "410 kimi-k2.5 was retired at 2026-07-31 00:00:00 -0700 PDT (ref: 9bd8dcf1)",
    ]) {
      expect(isModelNotFoundErrorMessage(msg), msg).toBe(true);
      expect(resolveFailoverReasonFromError(new Error(msg)), msg).toBe("model_not_found");
    }
  });

  it("does not misread other failures", () => {
    for (const msg of [
      "429 rate limit exceeded for model gpt-5",
      "401 Incorrect API key provided",
      "This model's maximum context length is 128000 tokens",
      "The model is overloaded. Please try again later.",
      "tool `search` not found",
      "",
    ]) {
      expect(isModelNotFoundErrorMessage(msg), msg).toBe(false);
    }
    // Profile-level classification is untouched (a missing model must not cool down a key).
    expect(
      classifyFailoverReason("The model `x` does not exist or you do not have access to it"),
    ).toBeNull();
  });

  it("coerces a provider 404 into a typed failover error", () => {
    const err = coerceToFailoverError(
      new Error("models/gemini-1.5-pro is not found for API version v1beta"),
      {
        provider: "google",
        model: "gemini-1.5-pro",
      },
    );
    expect(err).toMatchObject({
      reason: "model_not_found",
      provider: "google",
      model: "gemini-1.5-pro",
      status: 404,
    });
  });
});

describe("heal + suggestion", () => {
  const catalog = [
    { provider: "google", id: "gemini-2.5-pro" },
    { provider: "google", id: "gemini-2.5-flash" },
    { provider: "google", id: "gemini-3.8-flash" },
    { provider: "openai", id: "gpt-6-sol" },
  ];

  it("heals onto the nearest model of the same provider first", () => {
    const out = orderHealCandidates({
      failedProvider: "google",
      failedModel: "gemini-1.5-flash",
      catalog,
      hasCredentials: () => true,
      exclude: new Set(["google/gemini-1.5-flash"]),
    });
    expect(out[0]).toEqual({ provider: "google", model: "gemini-2.5-flash" });
    expect(out[1]).toEqual({ provider: "openai", model: "gpt-6-sol" });
  });

  it("falls back to the provider's first model when nothing is related", () => {
    const out = orderHealCandidates({
      failedProvider: "google",
      failedModel: "palm-2",
      catalog,
      hasCredentials: (p) => p === "google",
    });
    expect(out).toEqual([{ provider: "google", model: "gemini-2.5-pro" }]);
  });

  it("tells the user the model is unavailable and names the closest valid one", () => {
    const failure = describeAgentTurnFailure(
      new Error(
        "Model unavailable: google/gemini-1.5-flash was rejected by the provider as not found (models/gemini-1.5-flash is not found)",
      ),
      {
        suggest: (provider, model) =>
          provider === "google" && model === "gemini-1.5-flash"
            ? "google/gemini-2.5-flash"
            : undefined,
      },
    );
    expect(failure.errorCode).toBe("model_unavailable");
    expect(failure.errorMessage).toMatch(/^Model unavailable — google\/gemini-1\.5-flash/);
    expect(failure.errorMessage).toMatch(/Choose another model/);
    expect(failure.suggestedModel).toBe("google/gemini-2.5-flash");
    expect(failure.errorHint).toContain("/model google/gemini-2.5-flash");

    const none = describeAgentTurnFailure(new Error("Unknown model: ollama-cloud/kimi-k2.5"), {
      suggest: () => undefined,
    });
    expect(none.errorCode).toBe("model_unavailable");
    expect(none.suggestedModel).toBeUndefined();
    expect(none.errorHint).toMatch(/model picker/);
  });
});

describe("unavailable model memo", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-unavail-"));
    resetUnavailableModelsForTest(path.join(dir, "u.json"));
  });
  afterEach(() => {
    resetUnavailableModelsForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("remembers a rejected model across restarts, expires it, and clears it on success", () => {
    markModelUnavailable("Google", "gemini-1.5-flash", "not found", 1_000);
    expect(getUnavailableModel("google", "gemini-1.5-flash", 2_000)?.error).toBe("not found");
    resetUnavailableModelsForTest(path.join(dir, "u.json")); // "restart"
    expect(getUnavailableModel("google", "gemini-1.5-flash", 2_000)).toBeDefined();
    expect(
      getUnavailableModel("google", "gemini-1.5-flash", 1_000 + UNAVAILABLE_TTL_MS + 1),
    ).toBeUndefined();
    clearModelUnavailable("google", "gemini-1.5-flash");
    expect(getUnavailableModel("google", "gemini-1.5-flash", 2_000)).toBeUndefined();
  });
});

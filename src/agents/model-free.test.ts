import { describe, expect, it } from "vitest";

import { classifyModelFree, classifyProviderFree, FREE_TIER_TABLE } from "./model-free.js";

const zero = { input: 0, output: 0 };

describe("classifyModelFree", () => {
  it("marks $0 models as free only when the pricing is live-sourced", () => {
    const live = classifyModelFree({
      provider: "opencode",
      id: "big-pickle",
      cost: zero,
      costSource: "provider-api",
    });
    expect(live?.kind).toBe("free");
    expect(live?.source).toMatch(/models\.dev pricing/);
    // The bundled registry snapshot is not a source: a model free at build time may be paid now.
    expect(classifyModelFree({ provider: "opencode", id: "grok-code", cost: zero })).toBeNull();
    expect(
      classifyModelFree({
        provider: "openai",
        id: "gpt-5",
        cost: { input: 1, output: 8 },
        costSource: "models.dev",
      }),
    ).toBeNull();
  });

  it("recognises OpenRouter free variants from API pricing or the :free suffix", () => {
    const priced = classifyModelFree({
      provider: "openrouter",
      id: "stealth/space-bunny-alpha",
      cost: zero,
      costSource: "openrouter-api",
    });
    expect(priced).toMatchObject({ kind: "free", source: "OpenRouter models API (pricing 0)" });
    expect(priced?.note).toMatch(/50 requests\/day/);
    const suffix = classifyModelFree({ provider: "openrouter", id: "qwen/qwen3.8-27b:free" });
    expect(suffix).toMatchObject({
      kind: "free",
      source: "https://openrouter.ai/docs/api-reference/limits",
    });
    expect(classifyModelFree({ provider: "openrouter", id: "openai/freedom-1" })).toBeNull();
  });

  it("never calls an unmetered subscription or unpriced provider free", () => {
    for (const provider of [
      "ollama-cloud",
      "github-copilot",
      "openai-codex",
      "moonshot",
      "llamacloud",
      "my-proxy",
    ]) {
      expect(
        classifyModelFree({ provider, id: "m", cost: zero, costSource: "models.dev" }),
      ).toBeNull();
    }
    expect(classifyModelFree({ provider: "opencode", id: "jev-1.13-free" })).toBeNull();
  });

  it("marks Google AI Studio and Groq free-tier models, with a dated source", () => {
    const flash = classifyModelFree({
      provider: "google",
      id: "gemini-3.8-flash",
      cost: { input: 0.75, output: 3.75 },
      costSource: "models.dev",
    });
    expect(flash).toMatchObject({
      kind: "free-tier",
      source: "https://ai.google.dev/gemini-api/docs/pricing",
      verified: "2026-10-01",
    });
    expect(classifyModelFree({ provider: "google", id: "gemma-4-31b-it" })?.kind).toBe("free-tier");
    // Pro previews have no free tier.
    expect(classifyModelFree({ provider: "google", id: "gemini-3.1-pro-preview" })).toBeNull();
    // Vertex is billed through Google Cloud — no AI Studio free tier.
    expect(classifyModelFree({ provider: "google-vertex", id: "gemini-3.8-flash" })).toBeNull();
    expect(classifyModelFree({ provider: "groq", id: "openai/gpt-oss-120b" })?.kind).toBe(
      "free-tier",
    );
    expect(classifyModelFree({ provider: "groq", id: "llama-3.3-70b-versatile" })).toBeNull();
    // A trial credit is not a free tier.
    expect(classifyModelFree({ provider: "cerebras", id: "gpt-oss-120b" })).toBeNull();
  });

  it("marks local endpoints as local, ahead of any pricing", () => {
    expect(classifyModelFree({ provider: "ollama", id: "qwen3" })?.kind).toBe("local");
    expect(
      classifyModelFree({ provider: "vllm-local", id: "qwen3.8-27b", local: true })?.kind,
    ).toBe("local");
    expect(classifyModelFree({ provider: "vllm-local", id: "qwen3.8-27b" })).toBeNull();
  });

  it("every free-tier row is sourced and dated", () => {
    for (const row of Object.values(FREE_TIER_TABLE)) {
      expect(row.source).toMatch(/^https:\/\//);
      expect(row.keyUrl).toMatch(/^https:\/\//);
      expect(row.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("classifyProviderFree", () => {
  const info = (provider: string, id: string, extra: object = {}) =>
    classifyModelFree({ provider, id, ...extra });

  it("summarises a provider from its models", () => {
    const google = classifyProviderFree("google", [
      info("google", "gemini-3.8-flash"),
      info("google", "gemini-3.1-pro-preview"),
    ]);
    expect(google).toMatchObject({ kind: "free-tier", label: "Free tier", count: 1 });
    expect(google?.keyUrl).toBe("https://aistudio.google.com/apikey");

    const or = classifyProviderFree("openrouter", [
      info("openrouter", "a/b:free"),
      info("openrouter", "openai/gpt-5"),
    ]);
    expect(or).toMatchObject({ kind: "free", label: "Free models", count: 1 });

    expect(classifyProviderFree("ollama", [info("ollama", "qwen3")])).toMatchObject({
      kind: "local",
      label: "Local",
    });
    expect(classifyProviderFree("openai", [info("openai", "gpt-5")])).toBeNull();
    expect(classifyProviderFree("google", [])).toBeNull();
  });
});

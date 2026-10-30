import { describe, expect, it } from "vitest";

import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import {
  markModelUnavailable,
  resetUnavailableModelsForTest,
} from "../../agents/model-unavailable.js";
import { resolveReferenceModel } from "../../agents/pi-embedded-runner/model.js";
import type { InfinibotConfig } from "../../config/config.js";
import { annotateModelFree, annotateModelUnavailable } from "./models.js";

const catalog: ModelCatalogEntry[] = [
  {
    provider: "google",
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    cost: { input: 0.75, output: 3.75 },
    costSource: "models.dev",
  },
  {
    provider: "google",
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro",
    cost: { input: 2, output: 12 },
    costSource: "models.dev",
  },
  {
    provider: "openrouter",
    id: "x/y:free",
    name: "Y",
    cost: { input: 0, output: 0 },
    costSource: "openrouter-api",
  },
  {
    provider: "openrouter",
    id: "openai/gpt-6-sol",
    name: "GPT-6",
    cost: { input: 2, output: 10 },
    costSource: "openrouter-api",
  },
  {
    provider: "ollama-cloud",
    id: "gpt-oss:120b",
    name: "gpt-oss:120b",
    cost: { input: 0, output: 0 },
  },
  { provider: "vllm-local", id: "qwen3.8-27b", name: "qwen", cost: { input: 0, output: 0 } },
];

const cfg = {
  models: { providers: { "vllm-local": { baseUrl: "http://127.0.0.1:8010/v1", models: [] } } },
} as unknown as InfinibotConfig;

describe("models.list free annotations", () => {
  it("stamps each row and summarises providers, including not-connected ones", () => {
    const rows = [
      ...catalog.map((m) => ({
        id: m.id,
        provider: m.provider,
        available: m.provider !== "google",
      })),
      { id: "__setup__", provider: "ollama", unconfigured: true },
    ] as Array<{
      id: string;
      provider: string;
      available?: boolean;
      unconfigured?: boolean;
      free?: string;
      freeSource?: string;
    }>;
    const providers = annotateModelFree(rows, catalog, cfg);

    expect(Object.fromEntries(rows.map((r) => [`${r.provider}/${r.id}`, r.free]))).toEqual({
      "google/gemini-3.8-flash": "free-tier",
      "google/gemini-3.1-pro-preview": undefined,
      "openrouter/x/y:free": "free",
      "openrouter/openai/gpt-6-sol": undefined,
      "ollama-cloud/gpt-oss:120b": undefined,
      "vllm-local/qwen3.8-27b": "local",
      "ollama/__setup__": undefined,
    });
    expect(rows[0].freeSource).toBe(
      "https://ai.google.dev/gemini-api/docs/pricing (verified 2026-10-01)",
    );

    const by = Object.fromEntries(providers.map((p) => [p.id, p]));
    expect(by.google).toMatchObject({
      available: false,
      free: { kind: "free-tier", label: "Free tier", count: 1 },
    });
    expect(by.openrouter.free).toMatchObject({ kind: "free", label: "Free models", count: 1 });
    expect(by["vllm-local"].free).toMatchObject({ kind: "local", label: "Local" });
    // Not-connected local Ollama (placeholder only) still advertises that it is free.
    expect(by.ollama.free).toMatchObject({ kind: "local", count: 0 });
    expect(by["ollama-cloud"].free).toBeUndefined();
  });

  it("flags provider-rejected models with the nearest valid replacement", () => {
    resetUnavailableModelsForTest();
    markModelUnavailable("google", "gemini-3.1-pro-preview", "not found");
    const rows = catalog.map((m) => ({ id: m.id, provider: m.provider })) as Array<{
      id: string;
      provider: string;
      unavailable?: boolean;
      suggestion?: string;
    }>;
    annotateModelUnavailable(rows, cfg, () => "google/gemini-3.8-flash");
    expect(rows.filter((r) => r.unavailable)).toEqual([
      {
        id: "gemini-3.1-pro-preview",
        provider: "google",
        unavailable: true,
        suggestion: "google/gemini-3.8-flash",
      },
    ]);
    resetUnavailableModelsForTest();
  });
});

describe("resolveReferenceModel", () => {
  const registry = [
    {
      provider: "google",
      id: "gemini-3-flash-preview",
      api: "google-generative-ai",
      baseUrl: "https://g",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 65_536,
      name: "G3",
    },
    {
      provider: "google",
      id: "gemini-2.5-pro",
      api: "google-generative-ai",
      baseUrl: "https://g",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 1.25, output: 10, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 65_536,
      name: "G25",
    },
    {
      provider: "opencode",
      id: "claude-opus-4-5",
      api: "anthropic-messages",
      baseUrl: "https://z",
      reasoning: true,
      input: ["text"],
      cost: { input: 5, output: 25, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
      name: "C",
    },
    {
      provider: "opencode",
      id: "big-pickle",
      api: "openai-completions",
      baseUrl: "https://z/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
      name: "BP",
    },
  ] as never[];
  const reference = {
    providers: {
      google: {
        source: "models.dev" as const,
        fetchedAt: 1,
        models: [
          {
            id: "gemini-3.8-flash",
            name: "Gemini 3.8 Flash",
            contextWindow: 1_048_576,
            cost: { input: 0.75, output: 3.75 },
          },
          { id: "gemini-embedding-2" },
        ],
      },
      opencode: {
        source: "provider-api" as const,
        fetchedAt: 1,
        live: true,
        models: [{ id: "claude-opus-5-5" }, { id: "deepseek-v4-flash-free" }],
      },
    },
  };

  it("builds a current model from the closest built-in sibling", () => {
    const m = resolveReferenceModel("google", "gemini-3.8-flash", registry, reference);
    expect(m).toMatchObject({
      id: "gemini-3.8-flash",
      provider: "google",
      api: "google-generative-ai",
      baseUrl: "https://g",
      contextWindow: 1_048_576,
      cost: { input: 0.75, output: 3.75, cacheRead: 0.05 },
    });
  });

  it("picks the right transport in a mixed provider", () => {
    expect(resolveReferenceModel("opencode", "claude-opus-5-5", registry, reference)?.api).toBe(
      "anthropic-messages",
    );
    expect(
      resolveReferenceModel("opencode", "deepseek-v4-flash-free", registry, reference)?.api,
    ).toBe("openai-completions");
  });

  it("refuses ids the reference doesn't list, non-chat ids and unknown providers", () => {
    expect(
      resolveReferenceModel("google", "gemini-1.5-flash", registry, reference),
    ).toBeUndefined();
    expect(
      resolveReferenceModel("google", "gemini-embedding-2", registry, reference),
    ).toBeUndefined();
    expect(resolveReferenceModel("groq", "x", registry, reference)).toBeUndefined();
    expect(resolveReferenceModel("google", "gemini-3.8-flash", registry, null)).toBeUndefined();
  });
});

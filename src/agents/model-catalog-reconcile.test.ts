import { describe, expect, it } from "vitest";

import {
  type CatalogReference,
  isChatModel,
  isChatModelId,
  nearestModelId,
  reconcileCatalog,
} from "./model-catalog-reconcile.js";

const entry = (provider: string, id: string, extra: object = {}) => ({
  provider,
  id,
  name: id,
  ...extra,
});

const reference: CatalogReference = {
  providers: {
    google: {
      source: "models.dev",
      fetchedAt: 1,
      models: [
        { id: "gemini-2.5-flash", cost: { input: 0.3, output: 2.5 }, output: ["text"] },
        {
          id: "gemini-3.8-flash",
          name: "Gemini 3.8 Flash",
          contextWindow: 1_048_576,
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0.75, output: 3.75 },
          output: ["text"],
        },
        { id: "gemini-3.1-flash-lite-preview", deprecated: true, output: ["text"] },
        { id: "gemini-embedding-2", output: ["text"] },
        { id: "gemini-3.1-flash-image", output: ["text", "image"] },
        { id: "veo-3.1-generate-preview", output: ["video"] },
      ],
    },
    opencode: {
      source: "provider-api",
      fetchedAt: 1,
      live: true,
      models: [{ id: "deepseek-v4-flash-free", deprecated: true, cost: { input: 0, output: 0 } }],
    },
    broken: { source: "models.dev", fetchedAt: 1, models: [] },
  },
};

describe("chat model filter", () => {
  it("drops embedding, speech, image and safety models by id", () => {
    for (const id of [
      "nomic-embed-text:latest",
      "text-embedding-3-large",
      "gemini-embedding-001",
      "gemini-2.5-flash-preview-tts",
      "whisper-large-v3",
      "gemini-live-2.5-flash",
      "gemini-3.1-flash-live-preview",
      "gemini-3-pro-image-preview",
      "veo-3.1-generate-preview",
      "meta-llama/llama-prompt-guard-2-86m",
      "openai/gpt-oss-safeguard-20b",
      "o3-deep-research",
      "gemini-2.5-computer-use-preview-10-2025",
      "gpt-realtime",
    ]) {
      expect(isChatModelId(id), id).toBe(false);
    }
    for (const id of [
      "gemini-3.8-flash",
      "gemini-flash-lite-latest",
      "gpt-5.6-luna",
      "claude-opus-5-5",
      "openai/gpt-oss-120b",
      "huihui_ai/Qwen3.8-abliterated:latest",
      "llama-3.1-8b-instant",
      "deepseek-v4-flash-vision-exp",
      "olive-1",
    ]) {
      expect(isChatModelId(id), id).toBe(true);
    }
  });

  it("uses output modalities when the source reports them", () => {
    expect(isChatModel({ id: "x", output: ["text"] })).toBe(true);
    expect(isChatModel({ id: "x", output: ["text", "audio"] })).toBe(false);
    expect(isChatModel({ id: "x" })).toBe(true);
  });
});

describe("reconcileCatalog", () => {
  const base = [
    entry("google", "gemini-1.5-flash"),
    entry("google", "gemini-2.5-flash", { cost: { input: 9, output: 9 }, contextWindow: 1000 }),
    entry("google", "gemini-3.1-flash-lite-preview"),
    entry("ollama", "nomic-embed-text:latest"),
    entry("ollama", "qwen3"),
    entry("opencode", "glm-4.7-free"),
    entry("broken", "still-here"),
  ];

  it("removes retired and non-chat ids and adds current ones", () => {
    const r = reconcileCatalog(base, reference);
    expect(r.entries.map((e) => `${e.provider}/${e.id}`)).toEqual([
      "google/gemini-2.5-flash",
      "ollama/qwen3",
      "broken/still-here",
      "google/gemini-3.8-flash",
      "opencode/deepseek-v4-flash-free",
    ]);
    expect(r.removed.map((c) => `${c.provider}/${c.id}`)).toEqual([
      "google/gemini-1.5-flash",
      "google/gemini-3.1-flash-lite-preview",
      "ollama/nomic-embed-text:latest",
      "opencode/glm-4.7-free",
    ]);
    expect(r.added.map((c) => c.id)).toEqual(["gemini-3.8-flash", "deepseek-v4-flash-free"]);
  });

  it("refreshes pricing and metadata from the reference and records the source", () => {
    const r = reconcileCatalog(base, reference);
    const flash = r.entries.find((e) => e.id === "gemini-2.5-flash");
    expect(flash).toMatchObject({
      cost: { input: 0.3, output: 2.5 },
      costSource: "models.dev",
      contextWindow: 1000,
    });
    expect(r.entries.find((e) => e.id === "gemini-3.8-flash")).toMatchObject({
      name: "Gemini 3.8 Flash",
      contextWindow: 1_048_576,
      reasoning: true,
      input: ["text", "image"],
      costSource: "models.dev",
    });
  });

  it("trusts a live provider list over a models.dev deprecation flag", () => {
    const r = reconcileCatalog([], reference);
    expect(r.entries.some((e) => e.id === "deepseek-v4-flash-free")).toBe(true);
    expect(r.entries.some((e) => e.id === "gemini-3.1-flash-lite-preview")).toBe(false);
  });

  it("keeps operator-declared models and never empties a provider on a bad reference", () => {
    const r = reconcileCatalog(base, reference, { keep: new Set(["google/gemini-1.5-flash"]) });
    expect(r.entries.some((e) => e.id === "gemini-1.5-flash")).toBe(true);
    expect(r.entries.some((e) => e.id === "still-here")).toBe(true);
  });

  it("falls back to the static list (minus non-chat ids) without a reference", () => {
    const r = reconcileCatalog(base, null);
    expect(r.entries).toHaveLength(base.length - 1);
    expect(r.added).toEqual([]);
  });
});

describe("nearestModelId", () => {
  const google = [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3.8-flash",
    "gemma-4-31b-it",
  ];
  it("stays in the model family", () => {
    expect(nearestModelId("gemini-1.5-flash", google)).toBe("gemini-2.5-flash");
    expect(nearestModelId("gemini-1.5-pro", google)).toBe("gemini-2.5-pro");
    expect(nearestModelId("kimi-k2.5", ["gpt-oss:120b", "kimi-k2.6", "kimi-k3", "glm-5.2"])).toBe(
      "kimi-k2.6",
    );
    expect(nearestModelId("meta/llama-3:free", ["meta/llama-4:free", "openai/gpt-5"])).toBe(
      "meta/llama-4:free",
    );
  });
  it("returns nothing when no candidate is related", () => {
    expect(nearestModelId("gemini-1.5-flash", ["gpt-oss:120b", "claude-opus-5"])).toBeUndefined();
    expect(nearestModelId("x", [])).toBeUndefined();
  });
});

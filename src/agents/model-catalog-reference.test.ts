import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getCatalogReferenceSync,
  loadCatalogReference,
  mapGoogleModels,
  mapModelsDevProvider,
  mapOpenRouterModels,
  narrowToLive,
  resetCatalogReferenceForTest,
} from "./model-catalog-reference.js";

const modelsDev = {
  google: {
    models: {
      "gemini-3.8-flash": {
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1_048_576, output: 65_536 },
        cost: { input: 0.75, output: 3.75 },
      },
      "gemini-old": {
        id: "gemini-old",
        status: "deprecated",
        modalities: { input: ["text"], output: ["text"] },
      },
    },
  },
  "google-vertex": {
    models: {
      "gemini-3.8-flash": { id: "gemini-3.8-flash" },
      "claude-opus-5@default": { id: "claude-opus-5@default" },
    },
  },
  openai: {
    models: {
      "gpt-6-sol": { id: "gpt-6-sol", cost: { input: 2, output: 10 } },
      "gpt-gone": { id: "gpt-gone" },
    },
  },
};

const openRouter = {
  data: [
    {
      id: "x/y:free",
      name: "Y (free)",
      context_length: 131072,
      pricing: { prompt: "0", completion: "0" },
      architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    },
    {
      id: "openai/gpt-6-sol",
      pricing: { prompt: "0.000002", completion: "0.00001" },
      supported_parameters: ["reasoning"],
      architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    },
  ],
};

function fakeFetch(routes: Record<string, unknown>, calls: string[] = []) {
  return async (url: string, init?: RequestInit) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return new Response("nope", { status: 404 });
    const body =
      typeof hit[1] === "function" ? (hit[1] as (i?: RequestInit) => unknown)(init) : hit[1];
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

describe("reference mappers", () => {
  it("maps models.dev entries", () => {
    const [flash, old] = mapModelsDevProvider(modelsDev.google);
    expect(flash).toMatchObject({
      id: "gemini-3.8-flash",
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      reasoning: true,
      input: ["text", "image"],
      output: ["text"],
      cost: { input: 0.75, output: 3.75 },
    });
    expect(old.deprecated).toBe(true);
    expect(mapModelsDevProvider(undefined)).toEqual([]);
  });

  it("converts OpenRouter per-token pricing to per-million", () => {
    const [free, paid] = mapOpenRouterModels(openRouter);
    expect(free.cost).toEqual({ input: 0, output: 0 });
    expect(paid.cost).toEqual({ input: 2, output: 10 });
    expect(paid).toMatchObject({ reasoning: true, input: ["text", "image"] });
  });

  it("keeps only Google models that can generateContent", () => {
    const models = mapGoogleModels({
      models: [
        {
          name: "models/gemini-3.8-flash",
          displayName: "Gemini 3.8 Flash",
          inputTokenLimit: 1048576,
          supportedGenerationMethods: ["generateContent", "countTokens"],
        },
        { name: "models/gemini-embedding-2", supportedGenerationMethods: ["embedContent"] },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["gemini-3.8-flash"]);
  });

  it("narrows to live ids and adds live-only chat models", () => {
    const out = narrowToLive(
      [{ id: "a" }, { id: "retired" }],
      ["a", "new-chat", "new-embedding-1"],
      [{ id: "new-chat" }, { id: "new-embedding-1" }],
    );
    expect(out.map((m) => m.id)).toEqual(["a", "new-chat"]);
    expect(narrowToLive([{ id: "a" }], [])).toEqual([{ id: "a" }]);
  });
});

describe("loadCatalogReference", () => {
  let dir: string;
  let cachePath: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-ref-"));
    cachePath = path.join(dir, "ref.json");
    resetCatalogReferenceForTest();
  });
  afterEach(() => {
    resetCatalogReferenceForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const routes = {
    "https://models.dev/api.json": modelsDev,
    "https://openrouter.ai/api/v1/models": openRouter,
    "https://opencode.ai/zen/v1/models": { data: [{ id: "big-pickle" }] },
  };

  it("uses models.dev without a key and the provider API with one", async () => {
    const seenKeys: string[] = [];
    const ref = await loadCatalogReference({
      cachePath,
      resolveKey: async (p) => (p === "openai" ? "sk-test" : undefined),
      fetchImpl: fakeFetch({
        ...routes,
        "https://api.openai.com/v1/models": (init?: RequestInit) => {
          seenKeys.push(String((init?.headers as Record<string, string>)?.Authorization));
          return { data: [{ id: "gpt-6-sol" }, { id: "text-embedding-3-large" }] };
        },
      }),
    });
    expect(ref?.providers.google).toMatchObject({ source: "models.dev" });
    expect(ref?.providers.google.live).toBeUndefined();
    // Vertex only carries Gemini here.
    expect(ref?.providers["google-vertex"].models.map((m) => m.id)).toEqual(["gemini-3.8-flash"]);
    // The live list drops what models.dev still lists but the provider no longer serves.
    expect(ref?.providers.openai).toMatchObject({ source: "provider-api", live: true });
    expect(ref?.providers.openai.models.map((m) => m.id)).toEqual(["gpt-6-sol"]);
    expect(ref?.providers.openrouter).toMatchObject({ source: "openrouter-api", live: true });
    expect(ref?.providers.opencode.models.map((m) => m.id)).toEqual(["big-pickle"]);
    expect(seenKeys).toEqual(["Bearer sk-test"]);
    // The key never reaches the cache.
    expect(fs.readFileSync(cachePath, "utf8")).not.toContain("sk-test");
  });

  it("serves the cache within the TTL and survives a failed refresh after it", async () => {
    let now = 1_700_000_000_000;
    const calls: string[] = [];
    await loadCatalogReference({ cachePath, now: () => now, fetchImpl: fakeFetch(routes, calls) });
    const first = calls.length;
    resetCatalogReferenceForTest();

    await loadCatalogReference({ cachePath, now: () => now, fetchImpl: fakeFetch(routes, calls) });
    expect(
      calls.slice(first).some((u) => u.includes("models.dev") || u.includes("openrouter")),
    ).toBe(false);

    now += 7 * 60 * 60 * 1000;
    resetCatalogReferenceForTest();
    const stale = await loadCatalogReference({
      cachePath,
      now: () => now,
      fetchImpl: fakeFetch({}),
    });
    expect(stale?.providers.google.models.map((m) => m.id)).toContain("gemini-3.8-flash");
    resetCatalogReferenceForTest();
    expect(getCatalogReferenceSync(cachePath)).toBeNull(); // sync accessor is off under vitest
  });

  it("returns null with no cache and no network (static list is used)", async () => {
    const ref = await loadCatalogReference({ cachePath, fetchImpl: fakeFetch({}) });
    expect(ref).toBeNull();
  });
});

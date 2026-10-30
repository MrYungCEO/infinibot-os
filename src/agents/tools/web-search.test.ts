import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __testing, createWebSearchTool } from "./web-search.js";

const {
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  resolveSearchProvider,
  resolveSearxngUrl,
  normalizeFreshness,
} = __testing;

function clearSearchEnv() {
  delete process.env.BRAVE_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SEARXNG_URL;
}

beforeEach(clearSearchEnv);

afterEach(() => {
  vi.unstubAllGlobals();
  clearSearchEnv();
});

describe("web_search keyless fallback", () => {
  it("falls through to DuckDuckGo instant answers with no configured keys", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              Heading: "InfiniBot",
              AbstractText: "A local-first assistant.",
              AbstractURL: "https://example.com/infinibot",
              RelatedTopics: [],
            }),
            { status: 200 },
          ),
      ),
    );

    const tool = createWebSearchTool();
    const result = await tool?.execute("call-1", { query: "InfiniBot" });

    expect(result?.details).toMatchObject({
      provider: "duckduckgo",
      count: 1,
      results: [expect.objectContaining({ title: "InfiniBot" })],
    });
  });

  it("prefers keys, then SearXNG, before the keyless chain", () => {
    process.env.PERPLEXITY_API_KEY = "pplx-test";
    expect(resolveSearchProvider(undefined)).toBe("perplexity");
    delete process.env.PERPLEXITY_API_KEY;
    process.env.SEARXNG_URL = "https://search.example.test/";
    expect(resolveSearchProvider(undefined)).toBe("searxng");
    expect(resolveSearxngUrl(undefined)).toBe("https://search.example.test");
    delete process.env.SEARXNG_URL;
    expect(resolveSearchProvider(undefined)).toBe("keyless");
  });

  it("only spends the general OpenRouter key on search when perplexity is configured", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    expect(resolveSearchProvider(undefined)).toBe("keyless");
    expect(resolveSearchProvider({ provider: "perplexity" } as never)).toBe("perplexity");
  });

  it("falls back to the keyless chain when a keyed provider fails", async () => {
    process.env.BRAVE_API_KEY = "brave-dead-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("api.search.brave.com"))
          return new Response("unauthorized", { status: 401 });
        return new Response(
          JSON.stringify({
            Heading: "Fallback",
            AbstractText: "From the keyless chain.",
            AbstractURL: "https://example.com/fallback",
            RelatedTopics: [],
          }),
          { status: 200 },
        );
      }),
    );
    const result = await createWebSearchTool()?.execute("call-2", { query: "fallback probe" });
    expect(result?.details).toMatchObject({
      provider: "duckduckgo",
      fallbackFrom: "brave",
      fallbackReason: expect.stringContaining("401"),
      results: [expect.objectContaining({ title: "Fallback" })],
    });
  });
});

describe("web_search perplexity baseUrl defaults", () => {
  it("detects a Perplexity key prefix", () => {
    expect(inferPerplexityBaseUrlFromApiKey("pplx-123")).toBe("direct");
  });

  it("detects an OpenRouter key prefix", () => {
    expect(inferPerplexityBaseUrlFromApiKey("sk-or-v1-123")).toBe("openrouter");
  });

  it("returns undefined for unknown key formats", () => {
    expect(inferPerplexityBaseUrlFromApiKey("unknown-key")).toBeUndefined();
  });

  it("prefers explicit baseUrl over key-based defaults", () => {
    expect(resolvePerplexityBaseUrl({ baseUrl: "https://example.com" }, "config", "pplx-123")).toBe(
      "https://example.com",
    );
  });

  it("defaults to direct when using PERPLEXITY_API_KEY", () => {
    expect(resolvePerplexityBaseUrl(undefined, "perplexity_env")).toBe("https://api.perplexity.ai");
  });

  it("defaults to OpenRouter when using OPENROUTER_API_KEY", () => {
    expect(resolvePerplexityBaseUrl(undefined, "openrouter_env")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  it("defaults to direct when config key looks like Perplexity", () => {
    expect(resolvePerplexityBaseUrl(undefined, "config", "pplx-123")).toBe(
      "https://api.perplexity.ai",
    );
  });

  it("defaults to OpenRouter when config key looks like OpenRouter", () => {
    expect(resolvePerplexityBaseUrl(undefined, "config", "sk-or-v1-123")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });

  it("defaults to OpenRouter for unknown config key formats", () => {
    expect(resolvePerplexityBaseUrl(undefined, "config", "weird-key")).toBe(
      "https://openrouter.ai/api/v1",
    );
  });
});

describe("web_search freshness normalization", () => {
  it("accepts Brave shortcut values", () => {
    expect(normalizeFreshness("pd")).toBe("pd");
    expect(normalizeFreshness("PW")).toBe("pw");
  });

  it("accepts valid date ranges", () => {
    expect(normalizeFreshness("2024-01-01to2024-01-31")).toBe("2024-01-01to2024-01-31");
  });

  it("rejects invalid date ranges", () => {
    expect(normalizeFreshness("2024-13-01to2024-01-31")).toBeUndefined();
    expect(normalizeFreshness("2024-02-30to2024-03-01")).toBeUndefined();
    expect(normalizeFreshness("2024-03-10to2024-03-01")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import { validateConfigObject } from "./config.js";

describe("web search provider config", () => {
  it("accepts keyless providers and a SearXNG URL", () => {
    expect(
      validateConfigObject({
        tools: {
          web: {
            search: {
              provider: "searxng",
              searxngUrl: "https://search.example.test",
            },
          },
        },
      }).ok,
    ).toBe(true);
    expect(
      validateConfigObject({ tools: { web: { search: { provider: "duckduckgo" } } } }).ok,
    ).toBe(true);
  });

  it("accepts perplexity provider and config", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "perplexity",
            perplexity: {
              apiKey: "test-key",
              baseUrl: "https://api.perplexity.ai",
              model: "perplexity/sonar-pro",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});

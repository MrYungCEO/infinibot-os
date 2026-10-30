import { describe, expect, it } from "vitest";

import { buildProviderPatch, listSetupProviders, setupProviderIds } from "./providers.js";

describe("setup providers", () => {
  it("leads with the big three and Ollama Cloud, ends with local Ollama", () => {
    const ids = setupProviderIds();
    expect(ids.slice(0, 4)).toEqual(["anthropic", "openai", "google", "ollama-cloud"]);
    expect(ids.at(-1)).toBe("ollama");
    expect(ids).not.toContain("replicate");
  });

  it("reports configured keys masked, never in full", () => {
    const list = listSetupProviders({
      models: {
        providers: {
          anthropic: { apiKey: "sk-ant-1234567890abcdef" },
          ollama: { baseUrl: "http://localhost:11434" },
        },
      },
    });
    const anthropic = list.find((p) => p.id === "anthropic")!;
    expect(anthropic).toMatchObject({ configured: true, maskedKey: "sk-a…cdef", verifiable: true });
    expect(JSON.stringify(list)).not.toContain("1234567890");
    expect(list.find((p) => p.id === "ollama")).toMatchObject({ kind: "local", configured: true });
    expect(list.find((p) => p.id === "openai")).toMatchObject({
      configured: false,
      maskedKey: null,
    });
  });

  it("writes the canonical provider block and primary model", () => {
    expect(buildProviderPatch({ provider: "ollama-cloud", apiKey: " key-123 " })).toEqual({
      models: {
        providers: {
          "ollama-cloud": {
            baseUrl: "https://ollama.com/v1",
            api: "openai-completions",
            apiKey: "key-123",
            models: [
              {
                id: "gpt-oss:120b",
                name: "gpt-oss:120b",
                api: "openai-completions",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
      agents: { defaults: { model: { primary: "ollama-cloud/gpt-oss:120b" } } },
    });
  });

  it("keeps an existing primary when adding a second provider, and rejects unknown ids", () => {
    const patch = buildProviderPatch({ provider: "openai", apiKey: "sk-x", keepPrimary: true });
    expect(patch.agents).toBeUndefined();
    expect(() => buildProviderPatch({ provider: "nope" })).toThrow(/Unsupported/);
  });
});

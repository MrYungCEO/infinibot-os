import { describe, expect, it } from "vitest";
import { createMediaProviderRegistryForTest } from "./registry.js";
import type { MediaGenerationProvider } from "./types.js";

function provider(id: string): MediaGenerationProvider {
  return {
    id,
    name: id,
    kinds: ["image"],
    async generate(request) {
      const now = Date.now();
      return {
        id: `${id}-job`,
        providerId: id,
        kind: request.kind,
        status: "succeeded",
        outputs: [],
        createdAt: now,
        updatedAt: now,
      };
    },
    async getStatus() {
      throw new Error("unused");
    },
    async listModels() {
      return [];
    },
    async estimateCost() {
      return { amount: 0, currency: "USD", estimated: true };
    },
  };
}

describe("MediaProviderRegistry", () => {
  it("combines built-in and active plugin providers", () => {
    const registry = createMediaProviderRegistryForTest(() => [
      { pluginId: "flypic", provider: provider("flypic") },
    ]);
    registry.registerBuiltIn(provider("comfyui"));
    expect(registry.list().map((item) => [item.provider.id, item.source])).toEqual([
      ["comfyui", "core"],
      ["flypic", "plugin"],
    ]);
    expect(registry.require("flypic").name).toBe("flypic");
  });

  it("rejects duplicate provider ids", () => {
    const registry = createMediaProviderRegistryForTest(() => [
      { pluginId: "plugin", provider: provider("same") },
    ]);
    registry.registerBuiltIn(provider("same"));
    expect(() => registry.list()).toThrow("already registered");
  });

  it("waits for queued jobs to reach a terminal state", async () => {
    let calls = 0;
    const queued = provider("async");
    queued.getStatus = async (id) => {
      calls += 1;
      const now = Date.now();
      return {
        id,
        providerId: "async",
        kind: "image",
        status: calls > 1 ? "succeeded" : "running",
        outputs: [],
        createdAt: now,
        updatedAt: now,
      };
    };
    const registry = createMediaProviderRegistryForTest(() => [
      { pluginId: "p", provider: queued },
    ]);
    const now = Date.now();
    const result = await registry.waitForCompletion(
      "async",
      {
        id: "j1",
        providerId: "async",
        kind: "image",
        status: "queued",
        outputs: [],
        createdAt: now,
        updatedAt: now,
      },
      { pollMs: 1, timeoutMs: 100 },
    );
    expect(result.status).toBe("succeeded");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PREFERRED_OLLAMA_MODELS,
  clearOllamaProbeCache,
  getOllamaSafetyNetFallbacks,
  getOllamaSafetyNetFallbacksAsync,
} from "./ollama-safety-net.js";

function mockTags(models: string[]) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ models: models.map((name) => ({ name })) }),
  })) as unknown as typeof fetch;
}

function mockDown() {
  return vi.fn(async () => {
    throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), {
      code: "ECONNREFUSED",
    });
  }) as unknown as typeof fetch;
}

describe("ollama-safety-net", () => {
  beforeEach(() => {
    clearOllamaProbeCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearOllamaProbeCache();
  });

  it("returns [] when Ollama is not running", async () => {
    vi.stubGlobal("fetch", mockDown());
    const result = await getOllamaSafetyNetFallbacksAsync();
    expect(result).toEqual([]);
  });

  it("returns [] on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    );
    const result = await getOllamaSafetyNetFallbacksAsync();
    expect(result).toEqual([]);
  });

  it("returns the top 3 preferred installed models in priority order", async () => {
    // Install a mix; only some are preferred. qwen2.5:32b is highest priority.
    vi.stubGlobal(
      "fetch",
      mockTags(["llama3.1:8b", "qwen2.5:14b", "qwen2.5:32b", "mistral:latest", "llama3.3:70b"]),
    );
    const result = await getOllamaSafetyNetFallbacksAsync();
    expect(result).toEqual(["ollama/qwen2.5:32b", "ollama/qwen2.5:14b", "ollama/llama3.3:70b"]);
  });

  it("matches preferred models case-insensitively", async () => {
    vi.stubGlobal("fetch", mockTags(["QWEN2.5:32B"]));
    const result = await getOllamaSafetyNetFallbacksAsync();
    expect(result).toEqual(["ollama/QWEN2.5:32B"]);
  });

  it("falls back to generic installed models when no preferred match", async () => {
    vi.stubGlobal("fetch", mockTags(["mistral:latest", "phi3:mini", "gemma2:9b", "codellama:7b"]));
    const result = await getOllamaSafetyNetFallbacksAsync();
    expect(result).toEqual(["ollama/mistral:latest", "ollama/phi3:mini", "ollama/gemma2:9b"]);
  });

  it("respects disabled: true", async () => {
    const fetchMock = mockTags(["qwen2.5:32b"]);
    vi.stubGlobal("fetch", fetchMock);
    const result = await getOllamaSafetyNetFallbacksAsync({ disabled: true });
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches the probe within the TTL (single fetch for repeated calls)", async () => {
    const fetchMock = mockTags(["qwen2.5:32b"]);
    vi.stubGlobal("fetch", fetchMock);

    const first = await getOllamaSafetyNetFallbacksAsync();
    const second = await getOllamaSafetyNetFallbacksAsync();
    expect(first).toEqual(["ollama/qwen2.5:32b"]);
    expect(second).toEqual(["ollama/qwen2.5:32b"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-probes after clearOllamaProbeCache()", async () => {
    const fetchMock = mockTags(["qwen2.5:32b"]);
    vi.stubGlobal("fetch", fetchMock);

    await getOllamaSafetyNetFallbacksAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    clearOllamaProbeCache();
    await getOllamaSafetyNetFallbacksAsync();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sync variant returns [] cold then the resolved list once the probe lands", async () => {
    const fetchMock = mockTags(["qwen2.5:32b"]);
    vi.stubGlobal("fetch", fetchMock);

    // Cold call kicks off the probe and returns empty immediately.
    expect(getOllamaSafetyNetFallbacks()).toEqual([]);

    // Let the in-flight probe settle.
    await getOllamaSafetyNetFallbacksAsync();

    // Now the cache is warm and the sync call returns the resolved list.
    expect(getOllamaSafetyNetFallbacks()).toEqual(["ollama/qwen2.5:32b"]);
  });

  it("honors a custom preferred list", async () => {
    vi.stubGlobal("fetch", mockTags(["qwen2.5:32b", "llama3.1:8b"]));
    const result = await getOllamaSafetyNetFallbacksAsync({ preferred: ["llama3.1:8b"] });
    expect(result).toEqual(["ollama/llama3.1:8b"]);
  });

  it("exposes PREFERRED_OLLAMA_MODELS with Qwen first", () => {
    expect(PREFERRED_OLLAMA_MODELS[0]).toBe("qwen2.5:32b");
    expect(PREFERRED_OLLAMA_MODELS).toContain("qwen3:32b");
  });
});

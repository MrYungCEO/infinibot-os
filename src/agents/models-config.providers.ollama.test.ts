import { describe, expect, it } from "vitest";
import {
  probeOllamaRuntimeContext,
  resolveImplicitProviders,
  resolveOllamaContextWindow,
} from "./models-config.providers.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Ollama provider", () => {
  it("should not include ollama when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "clawd-test-"));
    const providers = await resolveImplicitProviders({ agentDir });

    // Ollama requires explicit configuration via OLLAMA_API_KEY env var or profile
    expect(providers?.ollama).toBeUndefined();
  });
});

describe("Ollama runtime context", () => {
  const psFetch = (body: unknown, ok = true) =>
    (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

  it("reads each loaded model's runtime context from /api/ps", async () => {
    const runtime = await probeOllamaRuntimeContext(
      "http://127.0.0.1:11434",
      psFetch({
        models: [
          {
            name: "huihui_ai/Qwen3.8-abliterated:latest",
            model: "huihui_ai/Qwen3.8-abliterated:latest",
            context_length: 32768,
          },
        ],
      }),
    );
    expect(runtime.byModel.get("huihui_ai/Qwen3.8-abliterated:latest")).toBe(32768);
    expect(runtime.server).toBe(32768);
    // The loaded model gets its real window, not the 128k trained maximum.
    expect(resolveOllamaContextWindow("huihui_ai/Qwen3.8-abliterated:latest", runtime)).toBe(32768);
    // A model that isn't loaded uses the server-wide value.
    expect(resolveOllamaContextWindow("gemma4:31b", runtime)).toBe(32768);
  });

  it("falls back to a conservative 32k when nothing is loaded or /api/ps fails", async () => {
    const empty = await probeOllamaRuntimeContext("http://x", psFetch({ models: [] }));
    expect(resolveOllamaContextWindow("any", empty)).toBe(32768);
    const failed = await probeOllamaRuntimeContext("http://x", (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    expect(resolveOllamaContextWindow("any", failed)).toBe(32768);
  });

  it("caps at 128k and never drops below the runner's 16k hard minimum", () => {
    expect(resolveOllamaContextWindow("big", { byModel: new Map([["big", 262_144]]) })).toBe(
      128_000,
    );
    expect(resolveOllamaContextWindow("tiny", { byModel: new Map([["tiny", 4096]]) })).toBe(16_000);
  });
});

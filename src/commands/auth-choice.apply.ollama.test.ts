import { describe, expect, it, vi } from "vitest";

import {
  __testing,
  discoverOnboardingOllama,
  resolveOnboardingOllamaHost,
} from "./auth-choice.apply.ollama.js";

describe("Ollama onboarding", () => {
  it("normalizes OLLAMA_HOST", () => {
    expect(resolveOnboardingOllamaHost({ OLLAMA_HOST: "localhost:2244/v1" } as never)).toBe(
      "http://localhost:2244",
    );
  });

  it("detects the local server and de-duplicates installed models", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            models: [{ name: "qwen3:8b" }, { name: "llama3.2" }, { name: "qwen3:8b" }],
          }),
          { status: 200 },
        ),
    );

    await expect(
      discoverOnboardingOllama({ fetchImpl: fetchImpl as typeof fetch, timeoutMs: 20 }),
    ).resolves.toEqual({
      host: "http://127.0.0.1:11434",
      running: true,
      models: ["qwen3:8b", "llama3.2"],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/tags",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("builds a selectable provider and defaults to the first detected model", () => {
    const config = __testing.withOllamaProvider(
      {},
      { host: "http://127.0.0.1:11434", running: true, models: ["qwen3:8b", "llama3.2"] },
      true,
    );

    expect(config.models?.providers?.ollama?.baseUrl).toBe("http://127.0.0.1:11434/v1");
    expect(config.models?.providers?.ollama?.models.map((model) => model.id)).toEqual([
      "qwen3:8b",
      "llama3.2",
    ]);
    expect(config.agents?.defaults?.model).toMatchObject({ primary: "ollama/qwen3:8b" });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { InfinibotConfig } from "../config/config.js";
import {
  listSecureModelCandidates,
  resolveSecureRunModel,
  setSecureModelListerForTests,
} from "../secure-mode/local-models.js";

function cfg(defaultModel?: string): InfinibotConfig {
  return {
    models: {
      providers: {
        "vllm-local": {
          baseUrl: "http://127.0.0.1:8010/v1",
          api: "openai-completions",
          models: [{ id: "qwen3.8-27b", name: "Qwen", input: ["text"] }],
        },
        ollama: {
          baseUrl: "http://127.0.0.1:11434",
          api: "ollama",
          models: [{ id: "qwen-local", name: "q" }],
        },
      },
    },
    localRuntimes: {
      runtimes: {
        "vllm-qwen": {
          kind: "systemd",
          unit: "vllm-qwen.service",
          baseUrl: "http://127.0.0.1:8010/v1",
          providers: ["vllm-local"],
          models: ["qwen3.8-27b"],
          etaSec: 90,
          label: "vLLM Qwen3.8-27B",
        },
      },
    },
    ...(defaultModel ? { secureMode: { defaultModel } } : {}),
  } as unknown as InfinibotConfig;
}

afterEach(() => setSecureModelListerForTests(null));

describe("Secure Mode + runtime manager", () => {
  it("a stopped vLLM is offered as 'starts on demand' instead of unreachable", async () => {
    // vLLM down, Ollama up.
    setSecureModelListerForTests(async (baseUrl) =>
      baseUrl.includes(":8010") ? null : ["qwen-local"],
    );
    const list = await listSecureModelCandidates({ cfg: cfg() });
    const v = list.find((c) => c.ref === "vllm-local/qwen3.8-27b")!;
    expect(v).toMatchObject({ reachable: true, onDemand: true });
    expect(v.note).toMatch(/starts on demand \(vLLM Qwen3\.8-27B, ≈90 s\)/);
  });

  it("the owner's secure default on a stopped runtime is used (the run gate starts it)", async () => {
    setSecureModelListerForTests(async (baseUrl) =>
      baseUrl.includes(":8010") ? null : ["qwen-local"],
    );
    const pick = await resolveSecureRunModel({
      cfg: cfg("vllm-local/qwen3.8-27b"),
      provider: "openrouter",
      model: "remote-x",
    });
    expect(pick).toMatchObject({ provider: "vllm-local", model: "qwen3.8-27b", source: "default" });
  });

  it("automatic picks prefer a running local model over starting vLLM", async () => {
    setSecureModelListerForTests(async (baseUrl) =>
      baseUrl.includes(":8010") ? null : ["qwen-local"],
    );
    const pick = await resolveSecureRunModel({
      cfg: cfg(),
      provider: "openrouter",
      model: "remote-x",
    });
    expect(pick).toMatchObject({ provider: "ollama", model: "qwen-local" });
  });
});

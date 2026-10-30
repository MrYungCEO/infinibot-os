import { describe, expect, it } from "vitest";
import { normalizeSecureModels } from "./secure-model";
import { normalizeSecureStatus } from "./store";

describe("normalizeSecureModels", () => {
  it("keeps local candidates only and flags the ones that are not running", () => {
    const res = normalizeSecureModels({
      defaultModel: null,
      suggested: "vllm-local/qwen3.8-27b",
      candidates: [
        { ref: "vllm-local/qwen3.8-27b", provider: "vllm-local", model: "qwen3.8-27b", source: "suggested", local: true, reachable: true },
        { ref: "ollama/huihui_ai/Qwen3.8-abliterated:latest", provider: "ollama", model: "huihui_ai/Qwen3.8-abliterated:latest", source: "suggested", local: true, reachable: false, note: "not answering" },
        { ref: "ollama-cloud/gpt-oss:120b", provider: "ollama-cloud", model: "gpt-oss:120b", source: "agent", local: false, reachable: false },
        null,
        { nope: 1 },
      ],
    });
    expect(res.suggested).toBe("vllm-local/qwen3.8-27b");
    expect(res.candidates.map((c) => [c.ref, c.reachable])).toEqual([
      ["vllm-local/qwen3.8-27b", true],
      ["ollama/huihui_ai/Qwen3.8-abliterated:latest", false],
    ]);
    expect(normalizeSecureModels(undefined)).toEqual({ defaultModel: null, suggested: null, candidates: [] });
  });
});

describe("secure status: model switch capability", () => {
  it("keeps modelSwitch + defaultModel across secure.set payloads that omit them", () => {
    const first = normalizeSecureStatus({
      enabled: true,
      unlocked: true,
      keyAccount: "a",
      updatedAt: 1,
      allowedTools: ["read"],
      modelSwitch: true,
      defaultModel: "vllm-local/qwen3.8-27b",
    });
    expect(first).toMatchObject({ modelSwitch: true, defaultModel: "vllm-local/qwen3.8-27b" });
    const next = normalizeSecureStatus({ enabled: false, unlocked: false, keyAccount: "a", updatedAt: 2 }, first);
    expect(next).toMatchObject({ modelSwitch: true, defaultModel: "vllm-local/qwen3.8-27b" });
    const cleared = normalizeSecureStatus({ enabled: true, unlocked: true, keyAccount: "a", updatedAt: 3, defaultModel: null }, first);
    expect(cleared?.defaultModel).toBe(null);
    // Older gateways: no capability.
    expect(normalizeSecureStatus({ enabled: true, unlocked: true, keyAccount: "a", updatedAt: 1 })?.modelSwitch).toBeUndefined();
  });
});

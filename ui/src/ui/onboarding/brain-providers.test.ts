import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listModelProviders } from "../../../../src/agents/known-providers.js";
import { OLLAMA_CLOUD_DEFAULT_MODEL_ID } from "../../../../src/agents/provider-model-defaults.js";
import {
  BRAIN_PROVIDERS,
  brainModelRef,
  getBrainProvider,
  saveBrainProvider,
} from "../lib/brain-providers";

/** Cloud providers the retired setup wizard offered (runtime ids; its "gemini" is "google"). */
const OLD_SETUP_WIZARD = ["openrouter", "anthropic", "openai", "groq", "google", "ollama-cloud"];

function fakeRpc(config: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const rpc = async <T,>(method: string, params: Record<string, unknown>): Promise<T> => {
    calls.push({ method, params });
    if (method === "config.get") return { hash: "h1", config } as T;
    return { ok: true } as T;
  };
  return { rpc, calls };
}

describe("onboarding brain step providers", () => {
  it("offers Ollama Cloud, featured first with the shared default model", () => {
    const oc = getBrainProvider("ollama-cloud");
    expect(oc).toBeDefined();
    expect(oc!.featured).toBe(true);
    expect(oc!.model).toBe(OLLAMA_CLOUD_DEFAULT_MODEL_ID);
    expect(oc!.keyUrl).toBe("https://ollama.com/settings/keys");
    expect(BRAIN_PROVIDERS[0]!.id).toBe("ollama-cloud");
  });

  it("keeps every provider the old setup wizard offered", () => {
    const ids = BRAIN_PROVIDERS.map((p) => p.id);
    for (const id of OLD_SETUP_WIZARD) expect(ids).toContain(id);
  });

  it("matches the shared catalogue: every cloud model provider is offered", () => {
    const ids = BRAIN_PROVIDERS.map((p) => p.id).sort();
    const catalogue = listModelProviders()
      .filter((p) => !("local" in p && p.local) && p.envKey)
      .map((p) => p.id)
      .sort();
    expect(ids).toEqual(catalogue);
  });

  it("provider card titles are the bare label (release gate matches the title exactly)", () => {
    const src = readFileSync(new URL("../views/onboarding-flow.ts", import.meta.url), "utf8");
    expect(src).toContain('<span class="sob-opt__title">${x.label}</span>');
    expect(getBrainProvider("ollama-cloud")!.label).toBe("Ollama Cloud");
  });

  it("onboarding-flow.ts uses the shared list, not a hand-written one", () => {
    const src = readFileSync(new URL("../views/onboarding-flow.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/const PROVIDERS\s*:/);
    expect(src).toContain("BRAIN_PROVIDERS");
  });

  it("builds provider/model refs without double-prefixing", () => {
    const oc = getBrainProvider("ollama-cloud")!;
    expect(brainModelRef(oc, "gpt-oss:120b")).toBe("ollama-cloud/gpt-oss:120b");
    expect(brainModelRef(oc, "ollama-cloud/glm-5.1")).toBe("ollama-cloud/glm-5.1");
    expect(brainModelRef(getBrainProvider("openrouter")!, "anthropic/claude-sonnet-4-5")).toBe(
      "openrouter/anthropic/claude-sonnet-4-5",
    );
    expect(brainModelRef(getBrainProvider("together")!, "meta-llama/Llama-3.3-70B")).toBe(
      "together/meta-llama/Llama-3.3-70B",
    );
  });

  it("saves Ollama Cloud: key to ollama-cloud:default, primary ollama-cloud/<model>, no config patch", async () => {
    const { rpc, calls } = fakeRpc();
    const ref = await saveBrainProvider(rpc, getBrainProvider("ollama-cloud")!, "  oc-key  ", "glm-5.1");
    expect(ref).toBe("ollama-cloud/glm-5.1");
    expect(calls).toEqual([
      {
        method: "auth.profiles.upsert",
        params: { profileId: "ollama-cloud:default", provider: "ollama-cloud", type: "api_key", key: "oc-key" },
      },
      { method: "voice.setup.brain", params: { provider: "cloud", modelId: "ollama-cloud/glm-5.1" } },
    ]);
  });

  it("registers the endpoint for providers the runtime doesn't ship", async () => {
    const { rpc, calls } = fakeRpc({ models: { providers: { deepseek: { models: [{ id: "deepseek-reasoner" }] } } } });
    await saveBrainProvider(rpc, getBrainProvider("deepseek")!, "sk-x", "deepseek-chat");
    const patch = calls.find((c) => c.method === "config.patch");
    expect(patch?.params.baseHash).toBe("h1");
    const raw = JSON.parse(String(patch?.params.raw)) as {
      models: { providers: { deepseek: { baseUrl: string; models: Array<{ id: string }> } } };
    };
    expect(raw.models.providers.deepseek.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(raw.models.providers.deepseek.models.map((m) => m.id)).toEqual(["deepseek-reasoner", "deepseek-chat"]);
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InfinibotConfig } from "../config/config.js";
import { saveAuthProfileStore, type AuthProfileStore } from "./auth-profiles.js";
import { AUTH_STORE_VERSION } from "./auth-profiles/constants.js";
import { FailoverError } from "./failover-error.js";
import { runWithModelFallback } from "./model-fallback.js";
import {
  orderHealCandidates,
  resetModelHealWarningsForTest,
  resolveHealCandidates,
} from "./model-heal.js";
import { OLLAMA_CLOUD_DEFAULT_MODEL_ID } from "./provider-model-defaults.js";

const safetyNet = vi.hoisted(() => ({ fallbacks: [] as string[] }));
vi.mock("./ollama-safety-net.js", () => ({
  getOllamaSafetyNetFallbacksAsync: vi.fn(async () => safetyNet.fallbacks),
  logOllamaSafetyNetExercised: vi.fn(),
}));

beforeEach(() => {
  safetyNet.fallbacks = [];
  resetModelHealWarningsForTest();
});

// The tenant's live ollama-cloud catalog from the incident (no kimi-k2.5).
const LIVE_OLLAMA_CLOUD = [
  "glm-5.2",
  "glm-5.3-flash",
  "kimi-k2.6",
  "gpt-oss:120b",
  "minimax-m2.7",
  "kimi-k3",
];

function notFound(provider: string, model: string) {
  return new FailoverError(
    `Unknown model: ${provider}/${model} (not in the provider's model catalog — retired upstream?)`,
    {
      reason: "model_not_found",
      provider,
      model,
    },
  );
}

describe("orderHealCandidates", () => {
  const catalog = [
    ...LIVE_OLLAMA_CLOUD.map((id) => ({ provider: "ollama-cloud", id })),
    { provider: "nokey", id: "free-lunch" },
    { provider: "openrouter", id: "anthropic/claude-sonnet-4-5" },
    { provider: "openrouter", id: "meta/llama" },
  ];

  it("prefers the provider default, then the first same-provider model, then other credentialed providers", () => {
    const out = orderHealCandidates({
      failedProvider: "ollama-cloud",
      catalog,
      hasCredentials: (p) => p !== "nokey",
    });
    expect(out).toEqual([
      { provider: "ollama-cloud", model: OLLAMA_CLOUD_DEFAULT_MODEL_ID },
      { provider: "ollama-cloud", model: "glm-5.2" },
      // openrouter default (DEFAULT_MODEL) picked over its first listed model
      { provider: "openrouter", model: "anthropic/claude-sonnet-4-5" },
    ]);
  });

  it("never offers a provider the tenant has no credentials for", () => {
    const out = orderHealCandidates({
      failedProvider: "ollama-cloud",
      catalog,
      hasCredentials: (p) => (p === "nokey" ? false : p === "openrouter"),
    });
    // ollama-cloud has no credentials here either → only openrouter.
    expect(out.map((c) => c.provider)).toEqual(["openrouter"]);
    expect(out.some((c) => c.provider === "nokey")).toBe(false);
  });

  it("falls back to the first model when the default isn't in the catalog, and honours exclude", () => {
    const out = orderHealCandidates({
      failedProvider: "ollama-cloud",
      catalog: [
        { provider: "ollama-cloud", id: "kimi-k2.6" },
        { provider: "ollama-cloud", id: "glm-5.2" },
      ],
      hasCredentials: () => true,
      exclude: new Set(["ollama-cloud/kimi-k2.6"]),
    });
    expect(out).toEqual([{ provider: "ollama-cloud", model: "glm-5.2" }]);
  });

  it("ranks tenant-configured providers before others", () => {
    const out = orderHealCandidates({
      failedProvider: "gone",
      catalog: [
        { provider: "zeta", id: "z1" },
        { provider: "alpha", id: "a1" },
      ],
      preferredProviders: ["alpha"],
      hasCredentials: () => true,
    });
    expect(out.map((c) => c.provider)).toEqual(["alpha", "zeta"]);
  });
});

describe("resolveHealCandidates (real agent dir)", () => {
  let agentDir: string;
  beforeEach(async () => {
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "ib-heal-"));
    const def = (id: string) => ({
      id,
      name: id,
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    });
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "ollama-cloud": {
            baseUrl: "https://ollama.com/v1",
            api: "openai-completions",
            // As written by models-config for a profile-backed key.
            apiKey: "test-key",
            models: LIVE_OLLAMA_CLOUD.map(def),
          },
          "keyless-custom": {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            // A literal models.json key alone is not a runtime credential.
            apiKey: "literal-but-unusable",
            models: [def("keyless-1")],
          },
        },
      }),
    );
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {
        "ollama-cloud:default": { type: "api_key", provider: "ollama-cloud", key: "test-key" },
      },
    };
    saveAuthProfileStore(store, agentDir);
  });
  afterEach(async () => {
    await fs.rm(agentDir, { recursive: true, force: true });
  });

  it("heals a retired ollama-cloud primary onto gpt-oss:120b from models.json + auth profiles", () => {
    const out = resolveHealCandidates({
      cfg: {} as InfinibotConfig,
      agentDir,
      failedProvider: "ollama-cloud",
      exclude: new Set(["ollama-cloud/kimi-k2.5"]),
    });
    expect(out[0]).toEqual({ provider: "ollama-cloud", model: "gpt-oss:120b" });
    expect(out.some((c) => c.provider === "keyless-custom")).toBe(false);
  });
});

describe("runWithModelFallback self-healing", () => {
  const cfg = {
    agents: {
      defaults: {
        model: {
          primary: "ollama-cloud/kimi-k2.5",
          fallbacks: ["ollama-cloud/also-retired", "openrouter/meta/llama"],
          ollamaSafetyNet: false,
        },
      },
    },
  } as unknown as InfinibotConfig;
  const available = new Set([
    "ollama-cloud/gpt-oss:120b",
    "openrouter/meta/llama",
    "ollama/qwen3:14b",
  ]);
  const runner = () =>
    vi.fn(async (provider: string, model: string) => {
      if (!available.has(`${provider}/${model}`)) throw notFound(provider, model);
      return `reply from ${provider}/${model}`;
    });

  it("uses an available configured fallback first and reports the heal once", async () => {
    const run = runner();
    const onModelHealed = vi.fn();
    const heal = vi.fn(() => [{ provider: "ollama-cloud", model: "gpt-oss:120b" }]);
    const res = await runWithModelFallback({
      cfg,
      provider: "ollama-cloud",
      model: "kimi-k2.5",
      run,
      onModelHealed,
      resolveHealCandidates: heal,
    });
    expect(run.mock.calls.map((c) => `${c[0]}/${c[1]}`)).toEqual([
      "ollama-cloud/kimi-k2.5",
      "ollama-cloud/also-retired",
      "openrouter/meta/llama",
    ]);
    expect(res.result).toBe("reply from openrouter/meta/llama");
    expect(res.healedFrom).toBe("ollama-cloud/kimi-k2.5");
    expect(heal).toHaveBeenCalledTimes(1);
    expect(onModelHealed).toHaveBeenCalledTimes(1);
    expect(onModelHealed.mock.calls[0]?.[0]).toMatchObject({
      from: "ollama-cloud/kimi-k2.5",
      to: "openrouter/meta/llama",
      message: "model ollama-cloud/kimi-k2.5 unavailable (retired?) — using openrouter/meta/llama",
    });
  });

  it("heals onto the provider default when no configured fallback is available", async () => {
    const run = runner();
    const res = await runWithModelFallback({
      cfg,
      provider: "ollama-cloud",
      model: "kimi-k2.5",
      fallbacksOverride: ["ollama-cloud/also-retired"],
      run,
      resolveHealCandidates: () => [
        { provider: "ollama-cloud", model: "gpt-oss:120b" },
        { provider: "openrouter", model: "meta/llama" },
      ],
    });
    expect(res.provider).toBe("ollama-cloud");
    expect(res.model).toBe("gpt-oss:120b");
  });

  it("inserts heal candidates before the local Ollama safety net", async () => {
    safetyNet.fallbacks = ["ollama/qwen3:14b"];
    const run = runner();
    const res = await runWithModelFallback({
      cfg: {
        agents: { defaults: { model: { primary: "ollama-cloud/kimi-k2.5" } } },
      } as unknown as InfinibotConfig,
      provider: "ollama-cloud",
      model: "kimi-k2.5",
      run,
      resolveHealCandidates: () => [{ provider: "ollama-cloud", model: "gpt-oss:120b" }],
    });
    expect(res.model).toBe("gpt-oss:120b");
    expect(run.mock.calls.map((c) => `${c[0]}/${c[1]}`)).toEqual([
      "ollama-cloud/kimi-k2.5",
      "ollama-cloud/gpt-oss:120b",
    ]);
  });

  it("surfaces a model_not_found error when nothing is available", async () => {
    const run = runner();
    const onModelHealed = vi.fn();
    await expect(
      runWithModelFallback({
        cfg,
        provider: "ollama-cloud",
        model: "kimi-k2.5",
        fallbacksOverride: [],
        run,
        onModelHealed,
        resolveHealCandidates: () => [],
      }),
    ).rejects.toThrow(/Unknown model: ollama-cloud\/kimi-k2\.5/);
    expect(onModelHealed).not.toHaveBeenCalled();
  });

  it("does not report a heal when the primary failed for another reason", async () => {
    const onModelHealed = vi.fn();
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("nope"), { status: 429 }))
      .mockResolvedValueOnce("ok");
    const res = await runWithModelFallback({
      cfg,
      provider: "ollama-cloud",
      model: "gpt-oss:120b",
      fallbacksOverride: ["openrouter/meta/llama"],
      run,
      onModelHealed,
      resolveHealCandidates: () => [],
    });
    expect(res.result).toBe("ok");
    expect(res.healedFrom).toBeUndefined();
    expect(onModelHealed).not.toHaveBeenCalled();
  });
});

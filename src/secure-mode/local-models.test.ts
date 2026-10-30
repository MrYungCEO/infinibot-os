import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runWithModelFallback } from "../agents/model-fallback.js";
import { resetModelHealedNoticesForTest } from "../agents/turn-failure.js";
import type { InfinibotConfig } from "../config/config.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { HostLocalityChecker, setHostLocalityCheckerForTests } from "./host-locality.js";
import {
  listSecureModelCandidates,
  resolveSecureDefaultModel,
  resolveSecureRunModel,
  setSecureModelListerForTests,
} from "./local-models.js";
import { SecureModeBlockedError } from "./policy.js";

// The Ollama safety net would probe a real daemon; keep it controlled.
const safetyNet = vi.hoisted(() => ({ fallbacks: [] as string[] }));
vi.mock("../agents/ollama-safety-net.js", () => ({
  getOllamaSafetyNetFallbacksAsync: vi.fn(async () => safetyNet.fallbacks),
  logOllamaSafetyNetExercised: vi.fn(),
}));

const SECURE = "agent:main:secure-abc123";
const QWEN_OLLAMA = "huihui_ai/Qwen3.8-abliterated:latest";

/** What each local endpoint serves; a missing entry = server not answering. */
let served: Record<string, string[]> = {};

function cfg(extra: Partial<InfinibotConfig> = {}): InfinibotConfig {
  return {
    models: {
      providers: {
        "ollama-cloud": { baseUrl: "https://ollama.com/v1", models: [{ id: "gpt-oss:120b" }] },
        openrouter: { baseUrl: "https://openrouter.ai/api/v1", models: [] },
        "vllm-local": { baseUrl: "http://172.17.0.1:8010/v1", models: [{ id: "qwen3.8-27b" }] },
      },
    },
    agents: {
      defaults: {
        model: { primary: "ollama-cloud/gpt-oss:120b", fallbacks: ["ollama-cloud/gpt-oss:20b"] },
      },
    },
    ...extra,
  } as unknown as InfinibotConfig;
}

beforeEach(() => {
  safetyNet.fallbacks = [];
  served = {};
  resetModelHealedNoticesForTest();
  setHostLocalityCheckerForTests(
    new HostLocalityChecker({
      interfaces: () =>
        ({
          lo: [{ address: "127.0.0.1", family: "IPv4" }],
          docker0: [{ address: "172.17.0.1", family: "IPv4" }],
          tailscale0: [{ address: "100.64.0.1", family: "IPv4" }],
        }) as never,
      hostname: () => "testbox",
      lookup: async (h) => {
        const table: Record<string, string[]> = {
          "ollama.com": ["34.36.133.15"],
          "openrouter.ai": ["104.18.2.3"],
          "llm.rebind.test": ["127.0.0.1"],
        };
        if (table[h]) return table[h] as string[];
        throw new Error("ENOTFOUND");
      },
    }),
  );
  setSecureModelListerForTests(async (baseUrl) => served[baseUrl] ?? null);
});

afterEach(() => {
  setHostLocalityCheckerForTests(null);
  setSecureModelListerForTests(null);
});

describe("secure default model", () => {
  it("suggests vllm-local/qwen3.8-27b when it is local and running", async () => {
    served["http://172.17.0.1:8010/v1"] = ["qwen3.8-27b"];
    served["http://127.0.0.1:11434/v1"] = [QWEN_OLLAMA];
    expect((await resolveSecureDefaultModel({ cfg: cfg() }))?.ref).toBe("vllm-local/qwen3.8-27b");
  });

  it("falls back to the abliterated Qwen3.8 on Ollama when vLLM is down", async () => {
    served["http://127.0.0.1:11434/v1"] = [QWEN_OLLAMA, "nomic-embed-text:latest"];
    const best = await resolveSecureDefaultModel({ cfg: cfg() });
    expect(best?.ref).toBe(`ollama/${QWEN_OLLAMA}`);
    const all = await listSecureModelCandidates({ cfg: cfg() });
    expect(all.find((c) => c.ref === "vllm-local/qwen3.8-27b")).toMatchObject({
      local: true,
      reachable: false,
    });
    // Embedding models are never offered; remote ones are flagged, not picked.
    expect(all.some((c) => c.model.includes("embed"))).toBe(false);
    expect(all.find((c) => c.ref === "ollama-cloud/gpt-oss:120b")).toMatchObject({ local: false });
  });

  it("honours secureMode.defaultModel when it is local and reachable", async () => {
    served["http://172.17.0.1:8010/v1"] = ["qwen3.8-27b"];
    served["http://127.0.0.1:11434/v1"] = [QWEN_OLLAMA];
    const c = cfg({ secureMode: { defaultModel: `ollama/${QWEN_OLLAMA}` } });
    expect((await resolveSecureDefaultModel({ cfg: c }))?.ref).toBe(`ollama/${QWEN_OLLAMA}`);
  });

  it("ignores a remote secureMode.defaultModel instead of using it", async () => {
    served["http://127.0.0.1:11434/v1"] = [QWEN_OLLAMA];
    const c = cfg({ secureMode: { defaultModel: "ollama-cloud/gpt-oss:120b" } });
    expect((await resolveSecureDefaultModel({ cfg: c }))?.ref).toBe(`ollama/${QWEN_OLLAMA}`);
  });
});

describe("auto-switch for secure runs", () => {
  it("keeps a requested model that is already local", async () => {
    served["http://172.17.0.1:8010/v1"] = ["qwen3.8-27b"];
    const r = await resolveSecureRunModel({
      cfg: cfg(),
      sessionKey: SECURE,
      provider: "vllm-local",
      model: "qwen3.8-27b",
    });
    expect(r).toMatchObject({ provider: "vllm-local", model: "qwen3.8-27b", source: "requested" });
    expect(r.switchedFrom).toBeUndefined();
  });

  it("moves a remote model onto the secure default", async () => {
    served["http://172.17.0.1:8010/v1"] = ["qwen3.8-27b"];
    const r = await resolveSecureRunModel({
      cfg: cfg(),
      sessionKey: SECURE,
      provider: "ollama-cloud",
      model: "gpt-oss:120b",
    });
    expect(r).toMatchObject({
      provider: "vllm-local",
      model: "qwen3.8-27b",
      switchedFrom: "ollama-cloud/gpt-oss:120b",
    });
  });

  it("a secureOnly agent uses its own local model before the default", async () => {
    served["http://172.17.0.1:8010/v1"] = ["qwen3.8-27b"];
    served["http://127.0.0.1:11434/v1"] = [QWEN_OLLAMA];
    const c = cfg({
      agents: {
        defaults: { model: { primary: "ollama-cloud/gpt-oss:120b" } },
        list: [
          {
            id: "vault",
            secureOnly: true,
            model: { primary: "openrouter/x-ai/grok", fallbacks: [`ollama/${QWEN_OLLAMA}`] },
          },
        ],
      } as never,
    });
    const r = await resolveSecureRunModel({
      cfg: c,
      sessionKey: "agent:vault:secure-x1",
      provider: "openrouter",
      model: "x-ai/grok",
    });
    expect(r).toMatchObject({ provider: "ollama", model: QWEN_OLLAMA, source: "agent" });
    // Without a local model of its own, the agent gets the default.
    const r2 = await resolveSecureRunModel({
      cfg: c,
      sessionKey: "agent:main:secure-x2",
      provider: "openrouter",
      model: "x-ai/grok",
    });
    expect(r2).toMatchObject({ provider: "vllm-local", model: "qwen3.8-27b" });
  });

  it("never falls back to a remote model: no local model reachable = clear error", async () => {
    const err = await resolveSecureRunModel({
      cfg: cfg(),
      sessionKey: SECURE,
      provider: "ollama-cloud",
      model: "gpt-oss:120b",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SecureModeBlockedError);
    expect(String((err as Error).message)).toMatch(/no local model is reachable/);
    expect(String((err as Error).message)).toMatch(/vllm-local\/qwen3\.8-27b: .*not answering/);
  });
});

describe("runWithModelFallback in Secure Mode", () => {
  it("runs a remote-configured session on the local default and posts the notice", async () => {
    served["http://172.17.0.1:8010/v1"] = ["qwen3.8-27b"];
    const notices: unknown[] = [];
    const off = onAgentEvent((e) => {
      if (e.stream === "notice") notices.push(e.data);
    });
    const run = vi.fn(async (p: string, m: string) => `${p}/${m}`);
    const res = await runWithModelFallback({
      cfg: cfg(),
      provider: "ollama-cloud",
      model: "gpt-oss:120b",
      sessionKey: SECURE,
      runId: "run-1",
      run,
    });
    off();
    expect(res.result).toBe("vllm-local/qwen3.8-27b");
    expect(run).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([
      expect.objectContaining({
        kind: "secure_model",
        from: "ollama-cloud/gpt-oss:120b",
        to: "vllm-local/qwen3.8-27b",
        message: "Secure Mode: using vllm-local/qwen3.8-27b (local)",
      }),
    ]);
  });

  it("never attempts a remote fallback when the local model fails", async () => {
    served["http://172.17.0.1:8010/v1"] = ["qwen3.8-27b"];
    safetyNet.fallbacks = [];
    const run = vi.fn(async () => {
      throw Object.assign(new Error("rate limited"), { status: 429 });
    });
    await expect(
      runWithModelFallback({
        cfg: cfg(),
        provider: "ollama-cloud",
        model: "gpt-oss:120b",
        fallbacksOverride: ["openrouter/x-ai/grok", "ollama-cloud/gpt-oss:20b"],
        sessionKey: SECURE,
        run,
      }),
    ).rejects.toThrow();
    const called = run.mock.calls.map((c) => `${c[0]}/${c[1]}`);
    expect(called).toEqual(["vllm-local/qwen3.8-27b"]);
  });

  it("refuses to run at all when no local model is reachable", async () => {
    const run = vi.fn(async () => "ok");
    await expect(
      runWithModelFallback({
        cfg: cfg(),
        provider: "ollama-cloud",
        model: "gpt-oss:120b",
        sessionKey: SECURE,
        run,
      }),
    ).rejects.toBeInstanceOf(SecureModeBlockedError);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps local fallbacks (e.g. the Ollama safety net) and drops remote ones", async () => {
    served["http://172.17.0.1:8010/v1"] = ["qwen3.8-27b"];
    safetyNet.fallbacks = [`ollama/${QWEN_OLLAMA}`];
    const run = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("overloaded"), { status: 503 }))
      .mockResolvedValueOnce("ok");
    const res = await runWithModelFallback({
      cfg: cfg(),
      provider: "ollama-cloud",
      model: "gpt-oss:120b",
      sessionKey: SECURE,
      run,
    });
    expect(res.result).toBe("ok");
    expect(run.mock.calls.map((c) => `${c[0]}/${c[1]}`)).toEqual([
      "vllm-local/qwen3.8-27b",
      `ollama/${QWEN_OLLAMA}`,
    ]);
  });

  it("normal sessions are untouched", async () => {
    const run = vi.fn(async (p: string, m: string) => `${p}/${m}`);
    const res = await runWithModelFallback({
      cfg: cfg(),
      provider: "ollama-cloud",
      model: "gpt-oss:120b",
      sessionKey: "agent:main:main",
      run,
    });
    expect(res.result).toBe("ollama-cloud/gpt-oss:120b");
  });
});

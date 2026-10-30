import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentSecureReadiness,
  effectiveModelRef,
  ensureLocalModels,
  ensureSecureVerdicts,
  localModelOptions,
  providerProbeRefs,
  resetSecureAgentsCache,
  secureAgentsCache,
  type CatalogModel,
  type SecureVerdict,
} from "./agent-readiness";

const verdicts = new Map<string, SecureVerdict>([
  ["ollama/gemma4:31b", { allowed: true }],
  ["ollama-cloud/gpt-oss:120b", { allowed: false, reason: "Blocked by Secure Mode: ollama-cloud/gpt-oss:120b is served from ollama.com, not this machine." }],
]);

describe("effectiveModelRef", () => {
  it("prefers the agent's own model, else the defaults primary", () => {
    expect(effectiveModelRef("ollama/gemma4:31b", "x/y")).toBe("ollama/gemma4:31b");
    expect(effectiveModelRef("default", "ollama-cloud/gpt-oss:120b")).toBe("ollama-cloud/gpt-oss:120b");
    expect(effectiveModelRef("", " a/b ")).toBe("a/b");
    expect(effectiveModelRef(undefined, "")).toBeNull();
  });
});

describe("agentSecureReadiness", () => {
  it("is Secure-ready only when the gateway says the model is local", () => {
    expect(agentSecureReadiness({ type: "native", model: "ollama/gemma4:31b" }, "", verdicts)).toEqual({
      kind: "ready",
      modelRef: "ollama/gemma4:31b",
    });
  });

  it("is blocked for a remote default model, with the gateway's reason (prefix stripped)", () => {
    const r = agentSecureReadiness({ type: "native", model: "default" }, "ollama-cloud/gpt-oss:120b", verdicts);
    expect(r.kind).toBe("blocked");
    if (r.kind === "blocked") {
      expect(r.modelRef).toBe("ollama-cloud/gpt-oss:120b");
      expect(r.reason).toMatch(/^ollama-cloud\/gpt-oss:120b is served from ollama.com/);
    }
  });

  it("never offers CLI agents (real or virtual backends)", () => {
    expect(agentSecureReadiness({ type: "cli", model: "default" }, "ollama/gemma4:31b", verdicts).kind).toBe("cli");
    expect(agentSecureReadiness({ type: "native", virtual: true, model: "" }, "ollama/gemma4:31b", verdicts).kind).toBe("cli");
  });

  it("reports checking until the verdict lands, and blocked with no model at all", () => {
    expect(agentSecureReadiness({ type: "native", model: "vllm-local/qwen" }, "", verdicts)).toEqual({ kind: "checking", modelRef: "vllm-local/qwen" });
    expect(agentSecureReadiness({ type: "native", model: "default" }, "", verdicts).kind).toBe("blocked");
  });
});

const catalog: CatalogModel[] = [
  { id: "gemma4:31b", provider: "ollama" },
  { id: "nomic-embed-text:latest", provider: "ollama" },
  { id: "qwen3:8b", provider: "ollama", name: "Qwen3 8B" },
  { id: "gpt-oss:120b", provider: "ollama-cloud" },
  { id: "__setup__", provider: "lmstudio", unconfigured: true },
  { id: "qwen3.8-27b", provider: "vllm-local" },
];

describe("local model options", () => {
  it("probes one chat model per provider", () => {
    expect([...providerProbeRefs(catalog)]).toEqual([
      ["ollama", "ollama/gemma4:31b"],
      ["ollama-cloud", "ollama-cloud/gpt-oss:120b"],
      ["vllm-local", "vllm-local/qwen3.8-27b"],
    ]);
  });

  it("lists only chat models of providers the gateway confirmed local", () => {
    const pv = new Map<string, SecureVerdict>([
      ["ollama", { allowed: true }],
      ["ollama-cloud", { allowed: false }],
      ["vllm-local", { allowed: false }],
    ]);
    expect(localModelOptions(catalog, pv).map((o) => o.ref)).toEqual(["ollama/gemma4:31b", "ollama/qwen3:8b"]);
    expect(localModelOptions(catalog, pv).find((o) => o.ref === "ollama/qwen3:8b")?.label).toBe("Qwen3 8B");
  });
});

describe("runtime cache", () => {
  afterEach(() => resetSecureAgentsCache());

  it("fetches each verdict once via secure.check", async () => {
    const request = vi.fn(async (_m: string, p: unknown) => ({
      model: { ref: (p as { model: string }).model, allowed: (p as { model: string }).model.startsWith("ollama/") },
    }));
    const onUpdate = vi.fn();
    ensureSecureVerdicts({ request } as never, ["ollama/a", "x/b", "ollama/a"], onUpdate);
    ensureSecureVerdicts({ request } as never, ["ollama/a"], onUpdate);
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith("secure.check", { model: "ollama/a" });
    expect(secureAgentsCache.verdicts.get("ollama/a")?.allowed).toBe(true);
    expect(secureAgentsCache.verdicts.get("x/b")?.allowed).toBe(false);
  });

  it("records a failed check as blocked with the error", async () => {
    const request = vi.fn(async () => {
      throw new Error("unknown method: secure.check");
    });
    const onUpdate = vi.fn();
    ensureSecureVerdicts({ request } as never, ["ollama/a"], onUpdate);
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(secureAgentsCache.verdicts.get("ollama/a")).toEqual({ allowed: false, reason: "Could not check this model: unknown method: secure.check" });
  });

  it("builds the local model list from models.list + per-provider secure.check", async () => {
    const request = vi.fn(async (method: string, p: unknown) => {
      if (method === "models.list") return { models: catalog };
      const ref = (p as { model: string }).model;
      return { model: { ref, allowed: ref.startsWith("ollama/") } };
    });
    await ensureLocalModels({ request } as never, () => {});
    expect(secureAgentsCache.local?.map((o) => o.ref)).toEqual(["ollama/gemma4:31b", "ollama/qwen3:8b"]);
    expect(request.mock.calls.filter(([m]) => m === "secure.check")).toHaveLength(3);
  });
});

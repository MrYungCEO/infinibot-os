import { describe, expect, it } from "vitest";

import {
  brainSummary,
  cliState,
  filterModels,
  shortModelName,
  splitApiProviders,
  splitRef,
  type BrainCatalog,
} from "./voice-brain-state.js";

const cat: BrainCatalog = {
  current: null,
  agentModel: "ollama-cloud/gpt-oss:120b",
  api: [
    { id: "groq", label: "Groq", configured: false, models: [] },
    { id: "openrouter", label: "OpenRouter", configured: true, models: [{ id: "openai/gpt-oss-120b:free", free: true }, { id: "anthropic/claude-sonnet-4.5" }] },
    { id: "ollama-cloud", label: "Ollama Cloud", configured: true, models: [{ id: "gpt-oss:120b" }] },
    { id: "zai", label: "Z.ai", configured: false, models: [] },
  ],
  local: [{ ref: "vllm-local/qwen3.8-27b", provider: "vllm-local", model: "qwen3.8-27b", reachable: true }],
  cli: [{ id: "claude-cli", label: "Claude Code", account: "Claude", installed: true, auth: "signed-in", ready: true, model: "sonnet", installUrl: "" }],
};

describe("voice brain state", () => {
  it("configured providers first, in the onboarding order", () => {
    const { configured, unconfigured } = splitApiProviders(cat.api);
    expect(configured.map((p) => p.id)).toEqual(["ollama-cloud", "openrouter"]);
    expect(unconfigured.map((p) => p.id)).toEqual(["groq", "zai"]);
  });

  it("filters by search and Free", () => {
    const m = cat.api[1]!.models;
    expect(filterModels(m, "", true).map((x) => x.id)).toEqual(["openai/gpt-oss-120b:free"]);
    expect(filterModels(m, "claude", false).map((x) => x.id)).toEqual(["anthropic/claude-sonnet-4.5"]);
  });

  it("splits refs whose model id has slashes", () => {
    expect(splitRef("openrouter/openai/gpt-oss-120b:free")).toEqual({ provider: "openrouter", model: "openai/gpt-oss-120b:free" });
    expect(shortModelName("openrouter/openai/gpt-oss-120b:free")).toBe("gpt-oss-120b:free");
  });

  it("summarises the active brain", () => {
    expect(brainSummary(null, cat)).toMatchObject({ kind: "agent", title: "gpt-oss:120b" });
    expect(brainSummary("openrouter/openai/gpt-oss-120b:free", cat)).toMatchObject({ kind: "api", detail: "OpenRouter · openai/gpt-oss-120b:free" });
    expect(brainSummary("vllm-local/qwen3.8-27b", cat).kind).toBe("local");
    expect(brainSummary("claude-cli/sonnet", cat)).toMatchObject({ kind: "cli", detail: "Claude · sonnet" });
  });

  it("CLI state in plain words", () => {
    const c = cat.cli[0]!;
    expect(cliState(c)).toMatchObject({ text: "Signed in", usable: true });
    expect(cliState({ ...c, auth: "signed-out" })).toMatchObject({ text: "Signed out", usable: false });
    expect(cliState({ ...c, installed: false })).toMatchObject({ text: "Not installed", usable: false });
  });
});

import { describe, expect, it } from "vitest";
import { buildProviderPatch, createInitialWizardState, getWizardProgress } from "./setup-wizard";

describe("setup wizard — provider first", () => {
  it("starts on the provider step, with federation later and optional", () => {
    const s = createInitialWizardState();
    expect(s.step).toBe(1);
    const labels = getWizardProgress().steps.map((st) => st.label);
    expect(labels[0]).toBe("Provider");
    expect(labels.indexOf("Federation")).toBeGreaterThan(labels.indexOf("Voice"));
    expect(getWizardProgress().steps.find((st) => st.label === "Federation")?.optional).toBe(true);
  });

  it("defaults to OpenRouter (the runtime default provider)", () => {
    expect(createInitialWizardState().provider).toBe("openrouter");
  });

  it("writes a schema-valid default model, not root providers/defaultModel", () => {
    const s = { ...createInitialWizardState(), provider: "openrouter" as const, defaultModel: "anthropic/claude-sonnet-4-5" };
    expect(buildProviderPatch(s)).toEqual({
      agents: { defaults: { model: { primary: "openrouter/anthropic/claude-sonnet-4-5" } } },
    });
    const ollama = { ...s, provider: "ollama" as const, defaultModel: "qwen3:8b" };
    expect(buildProviderPatch(ollama)).toEqual({ agents: { defaults: { model: { primary: "ollama/qwen3:8b" } } } });
    const gemini = { ...s, provider: "gemini" as const, defaultModel: "" };
    expect(buildProviderPatch(gemini)).toEqual({
      agents: { defaults: { model: { primary: "google/gemini-2.0-flash" } } },
    });
    expect(Object.keys(buildProviderPatch(s))).not.toContain("providers");
  });
});

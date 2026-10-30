import { describe, expect, it } from "vitest";
import { curateModels, pickDefaultModel } from "./provider-model-curation.js";
import { describeTestFailure } from "./server-methods/quickstart-providers.js";

// Cut-down copies of the live listings captured 2026-10-17.
const GEMINI = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.5-flash-preview-tts",
  "gemma-4-31b-it",
  "gemini-flash-latest",
  "gemini-2.5-flash-image",
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.5-transcribe",
  "gemini-3.8-flash",
  "gemini-3.8-flash-tts",
  "gemini-4-argon",
  "lyria-3.5",
  "gemini-2.5-computer-use-preview-10-2025",
  "deep-research-preview-04-2026",
  "gemini-2.0-flash",
  "gemini-1.5-pro",
].map((id) => ({ id }));

const NOW = Date.UTC(2026, 9, 17);

describe("curateModels", () => {
  it("Gemini: chat models only, no retired or non-chat, free tier flagged", () => {
    const out = curateModels("google", GEMINI, NOW);
    const ids = out.map((m) => m.id);
    expect(ids).toEqual([
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemma-4-31b-it",
      "gemini-flash-latest",
      "gemini-3-flash-preview",
      "gemini-3.1-pro-preview",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash",
      "gemini-3.8-flash",
      "gemini-4-argon",
    ]);
    const free = Object.fromEntries(out.map((m) => [m.id, m.free]));
    expect(free["gemini-3.8-flash"]).toBe(true);
    expect(free["gemini-2.5-pro"]).toBe(true);
    expect(free["gemma-4-31b-it"]).toBe(true);
    expect(free["gemini-3.1-pro-preview"]).toBe(false);
    expect(free["gemini-4-argon"]).toBe(false);
  });

  it("Gemini default: newest GA Flash, never the retired 2.0 Flash", () => {
    const out = curateModels("gemini", GEMINI, NOW);
    expect(pickDefaultModel("gemini", out)).toBe("gemini-3.8-flash");
    expect(pickDefaultModel("gemini", out, "gemini-2.0-flash")).toBe("gemini-3.8-flash");
  });

  it("OpenRouter: API pricing drives Free, expired models are hidden", () => {
    const out = curateModels("openrouter", [
      { id: "nvidia/nemotron-3.5-lightning:free", free: true },
      { id: "anthropic/claude-sonnet-4.5", free: false },
      { id: "anthropic/claude-sonnet-4.6", free: false },
      { id: "xiaomi/mimo-v2.5", deprecated: true },
      { id: "some/image-only", chat: false },
      { id: "google/lyria-3-pro-preview", free: true },
      { id: "anthropic/claude-sonnet-4.6:batch", free: false },
      { id: "nvidia/nemotron-3.5-content-safety:free", free: true },
    ]);
    expect(out.map((m) => [m.id, m.free])).toEqual([
      ["nvidia/nemotron-3.5-lightning:free", true],
      ["anthropic/claude-sonnet-4.5", false],
      ["anthropic/claude-sonnet-4.6", false],
    ]);
    // The old hard-coded "anthropic/claude-sonnet-4-5" doesn't exist on OpenRouter.
    expect(pickDefaultModel("openrouter", out, "anthropic/claude-sonnet-4-5")).toBe(
      "anthropic/claude-sonnet-4.6",
    );
    expect(pickDefaultModel("openrouter", out, "anthropic/claude-sonnet-4.5")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
  });

  it("Ollama Cloud: drops non-chat and retired models, keeps the shared default", () => {
    const out = curateModels("ollama-cloud", [
      { id: "gpt-oss:120b", chat: true },
      { id: "glm-5.3", chat: true },
      { id: "clef:27b", chat: false },
      { id: "kimi-k2.5" },
    ]);
    expect(out.map((m) => m.id)).toEqual(["gpt-oss:120b", "glm-5.3"]);
    expect(out.every((m) => m.free === false)).toBe(true);
    expect(pickDefaultModel("ollama-cloud", out, "gpt-oss:120b")).toBe("gpt-oss:120b");
  });

  it("Groq: inactive and speech models hidden, chat models free", () => {
    const out = curateModels("groq", [
      { id: "llama-3.3-70b-versatile" },
      { id: "whisper-large-v3" },
      { id: "old-model", deprecated: true },
    ]);
    expect(out).toEqual([{ id: "llama-3.3-70b-versatile", free: true }]);
  });
});

describe("describeTestFailure", () => {
  it("gives plain reasons", () => {
    expect(describeTestFailure("Google", 401, "")).toBe("Google rejected the key (401).");
    expect(describeTestFailure("Google", 404, "x")).toMatch(/isn't available to your Google key/);
    expect(describeTestFailure("openrouter", 429, "")).toMatch(/rate-limiting/);
    expect(
      describeTestFailure("OpenRouter", 500, '{"error":{"message":"User not found.","code":401}}'),
    ).toBe("OpenRouter couldn't run this model (500): User not found.");
  });
});

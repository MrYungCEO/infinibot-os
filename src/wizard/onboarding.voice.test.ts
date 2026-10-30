import { describe, expect, it, vi } from "vitest";

import { setupVoice, type VoiceSetupDeps } from "./onboarding.voice.js";
import type { WizardPrompter } from "./prompts.js";
import type { VoiceSetupConfig } from "../voice/schema.js";

function makePrompter(answers: {
  select?: (msg: string) => unknown;
  text?: string;
  confirm?: boolean;
}): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async (p: { message: string }) => answers.select?.(p.message)),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => answers.text ?? ""),
    confirm: vi.fn(async () => answers.confirm ?? false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  } as unknown as WizardPrompter;
}

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

function deps(over: Partial<VoiceSetupDeps> = {}): VoiceSetupDeps {
  const saved: VoiceSetupConfig[] = [];
  return {
    validateKey: vi.fn(async () => ({ ok: true, message: "ok" })),
    detectModels: vi.fn(async () => ({
      kokoro: { present: true, detail: "ok" },
      speaches: { present: true, detail: "ok" },
    })),
    runSmoke: vi.fn(async () => ({
      pass: true,
      stage: "ok" as const,
      message: "round-trip ok",
      at: 0,
    })),
    saveSetup: vi.fn(async (s: VoiceSetupConfig) => {
      saved.push(s);
      return s;
    }),
    // Keep the step hermetic — never run real env detection or write to the
    // real ~/.infinibot/voice.json during tests.
    detectEnv: vi.fn(async () => ({
      mic: { present: false, detail: "test" },
      stt: {
        whisper: { present: false, detail: "test" },
        whisperCpp: { present: false, detail: "test" },
        fasterWhisper: { present: false, detail: "test" },
        any: false,
      },
      tts: { piper: { present: false, detail: "test" }, any: false },
      cloudKeys: [],
      docker: { present: false, detail: "test" },
    })),
    setInput: vi.fn((input) => ({
      mode: "cloud" as const,
      stt: { provider: "openai" as const },
      tts: { provider: "openai" as const },
      input,
    })),
    ...over,
  };
}

describe("setupVoice", () => {
  it("cloud flow validates the key and saves a cloud config", async () => {
    const d = deps();
    const prompter = makePrompter({
      select: (msg) => (msg.startsWith("Voice setup") ? "cloud" : "openai"),
      text: "sk-valid",
    });
    const cfg = await setupVoice({ config: {}, prompter, runtime, deps: d });
    expect(d.validateKey).toHaveBeenCalledWith("openai", "sk-valid");
    expect(d.saveSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "cloud",
        cloud: expect.objectContaining({ tts: "openai", apiKey: "sk-valid" }),
      }),
    );
    expect(cfg.voice?.provider).toBe("cloud");
  });

  it("native flow detects models and saves a native config", async () => {
    const d = deps();
    const prompter = makePrompter({ select: () => "native" });
    const cfg = await setupVoice({ config: {}, prompter, runtime, deps: d });
    expect(d.detectModels).toHaveBeenCalled();
    expect(d.saveSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "native",
        native: expect.objectContaining({ tts: "kokoro" }),
      }),
    );
    expect(cfg.voice?.provider).toBe("native");
  });

  it("skip leaves config untouched and saves nothing", async () => {
    const d = deps();
    const prompter = makePrompter({ select: () => "skip" });
    const cfg = await setupVoice({ config: { voice: {} }, prompter, runtime, deps: d });
    expect(d.saveSetup).not.toHaveBeenCalled();
    expect(cfg.voice?.provider).toBeUndefined();
  });

  it("rejects a bad API key and abandons when user declines retry", async () => {
    const d = deps({
      validateKey: vi.fn(async () => ({ ok: false, message: "openai rejected the key (401)" })),
    });
    // confirm=false → don't retry after rejection.
    const prompter = makePrompter({
      select: (msg) => (msg.startsWith("Voice setup") ? "cloud" : "openai"),
      text: "sk-bad",
      confirm: false,
    });
    const cfg = await setupVoice({ config: {}, prompter, runtime, deps: d });
    expect(d.validateKey).toHaveBeenCalled();
    expect(d.saveSetup).not.toHaveBeenCalled();
    expect(cfg.voice?.provider).toBeUndefined();
  });

  it("loops on the smoke test failure and accepts on retry success", async () => {
    let calls = 0;
    const d = deps({
      runSmoke: vi.fn(async () => {
        calls += 1;
        return calls === 1
          ? { pass: false, stage: "tts" as const, message: "kokoro down", at: 0 }
          : { pass: true, stage: "ok" as const, message: "ok", at: 0 };
      }),
    });
    const prompter = makePrompter({ select: () => "native", confirm: true });
    await setupVoice({ config: {}, prompter, runtime, deps: d });
    expect(calls).toBe(2);
  });
});

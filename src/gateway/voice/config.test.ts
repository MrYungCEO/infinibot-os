import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  anyCloudKeyInEnv,
  normalizeVoiceConfig,
  resolveSttApiKey,
  resolveTtsApiKey,
} from "./config.js";

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});
beforeEach(() => {
  for (const k of [
    "GROQ_API_KEY",
    "ELEVENLABS_API_KEY",
    "XI_API_KEY",
    "OPENAI_API_KEY",
    "DEEPGRAM_API_KEY",
    "CARTESIA_API_KEY",
  ]) {
    delete process.env[k];
  }
});

describe("normalizeVoiceConfig", () => {
  it("fills cloud defaults for an empty object", () => {
    const cfg = normalizeVoiceConfig({});
    expect(cfg.mode).toBe("cloud");
    expect(cfg.stt.provider).toBe("groq");
    expect(cfg.tts.provider).toBe("elevenlabs");
  });

  it("fills native defaults when mode=native", () => {
    const cfg = normalizeVoiceConfig({ mode: "native" });
    expect(cfg.stt.provider).toBe("native");
    expect(cfg.tts.voice).toBe("am_puck");
  });

  it("rejects invalid providers and falls back to the base default", () => {
    const cfg = normalizeVoiceConfig({ stt: { provider: "bogus" }, tts: { provider: "nope" } });
    expect(cfg.stt.provider).toBe("groq");
    expect(cfg.tts.provider).toBe("elevenlabs");
  });

  it("preserves valid overrides", () => {
    const cfg = normalizeVoiceConfig({
      mode: "cloud",
      stt: { provider: "deepgram", model: "nova-2" },
      tts: { provider: "cartesia", voice: "v1" },
    });
    expect(cfg.stt).toMatchObject({ provider: "deepgram", model: "nova-2" });
    expect(cfg.tts).toMatchObject({ provider: "cartesia", voice: "v1" });
  });
});

describe("api key resolution", () => {
  it("prefers the config apiKey over env", () => {
    process.env.GROQ_API_KEY = "from-env";
    expect(resolveSttApiKey({ provider: "groq", apiKey: "from-config" })).toBe("from-config");
  });

  it("falls back to provider env var", () => {
    process.env.ELEVENLABS_API_KEY = "xi-env";
    expect(resolveTtsApiKey({ provider: "elevenlabs" })).toBe("xi-env");
  });

  it("returns undefined when no key anywhere", () => {
    expect(resolveSttApiKey({ provider: "groq" })).toBeUndefined();
  });

  it("native providers need no key", () => {
    expect(resolveSttApiKey({ provider: "native" })).toBeUndefined();
    expect(anyCloudKeyInEnv()).toBe(false);
  });

  it("anyCloudKeyInEnv detects a present cloud key", () => {
    process.env.OPENAI_API_KEY = "sk-x";
    expect(anyCloudKeyInEnv()).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { VoiceSetupSchema } from "./schema.js";

describe("VoiceSetupSchema", () => {
  it("accepts a valid cloud config", () => {
    const r = VoiceSetupSchema.safeParse({
      provider: "cloud",
      cloud: { stt: "openai", tts: "openai", apiKey: "sk-test" },
      fallback: "cloud-to-native",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a valid native config", () => {
    const r = VoiceSetupSchema.safeParse({
      provider: "native",
      native: { tts: "kokoro", ttsVoice: "coral", sttModel: "whisper-base", wakeWord: false },
    });
    expect(r.success).toBe(true);
  });

  it("rejects a cloud config with an empty API key", () => {
    const r = VoiceSetupSchema.safeParse({
      provider: "cloud",
      cloud: { stt: "openai", tts: "openai", apiKey: "" },
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("apiKey"))).toBe(true);
    }
  });

  it("rejects provider=cloud with no cloud block", () => {
    const r = VoiceSetupSchema.safeParse({ provider: "cloud" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes("cloud"))).toBe(true);
    }
  });

  it("rejects provider=native with no native block", () => {
    const r = VoiceSetupSchema.safeParse({ provider: "native" });
    expect(r.success).toBe(false);
  });

  it("strips federation endpoint keys that share the voice block", () => {
    const r = VoiceSetupSchema.safeParse({
      provider: "native",
      native: { tts: "kokoro" },
      kokoroUrl: "http://localhost:8882",
      speachesUrl: "http://localhost:8002",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as Record<string, unknown>).kokoroUrl).toBeUndefined();
    }
  });

  it("rejects an unknown provider", () => {
    const r = VoiceSetupSchema.safeParse({ provider: "telepathy" });
    expect(r.success).toBe(false);
  });
});

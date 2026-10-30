import { describe, expect, it, vi } from "vitest";

import { selectVoiceBackend, VoiceUnavailableError, type VoiceProbe } from "./router.js";
import type { VoiceSetupConfig } from "./schema.js";

const cloudSetup: VoiceSetupConfig = {
  provider: "cloud",
  cloud: { stt: "openai", tts: "openai", apiKey: "sk-x", ttsVoice: "alloy" },
  fallback: "cloud-to-native",
};

const nativeSetup: VoiceSetupConfig = {
  provider: "native",
  native: { tts: "kokoro", ttsVoice: "coral", sttModel: "whisper-base" },
  fallback: "native-to-cloud",
};

const okProbe: VoiceProbe = async () => ({ ok: true });

describe("selectVoiceBackend", () => {
  it("uses the primary when it's healthy", async () => {
    const emit = vi.fn();
    const res = await selectVoiceBackend({
      setup: cloudSetup,
      component: "tts",
      probe: okProbe,
      emit,
    });
    expect(res.kind).toBe("cloud");
    expect(res.fellBack).toBe(false);
    expect(res.apiKey).toBe("sk-x");
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "voice_backend_selected" }));
  });

  it("falls back to native when cloud fails and policy allows", async () => {
    const probe: VoiceProbe = async (kind) =>
      kind === "cloud" ? { ok: false, error: "5xx" } : { ok: true };
    const emit = vi.fn();
    const res = await selectVoiceBackend({
      setup: cloudSetup,
      component: "tts",
      probe,
      emit,
    });
    expect(res.kind).toBe("native");
    expect(res.fellBack).toBe(true);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "voice_fallback", primary: "cloud", chosen: "native" }),
    );
  });

  it("falls back native→cloud when policy is native-to-cloud", async () => {
    const probe: VoiceProbe = async (kind) =>
      kind === "native" ? { ok: false, error: "container down" } : { ok: true };
    const res = await selectVoiceBackend({ setup: nativeSetup, component: "stt", probe });
    expect(res.kind).toBe("cloud");
    expect(res.fellBack).toBe(true);
  });

  it("does NOT fall back when fallback is off", async () => {
    const setup: VoiceSetupConfig = { ...cloudSetup, fallback: "off" };
    const probe: VoiceProbe = async (kind) =>
      kind === "cloud" ? { ok: false, error: "boom" } : { ok: true };
    await expect(selectVoiceBackend({ setup, component: "tts", probe })).rejects.toBeInstanceOf(
      VoiceUnavailableError,
    );
  });

  it("does NOT fall back native→cloud under cloud-to-native policy", async () => {
    // primary native, policy only allows cloud→native, so a native failure
    // must not silently jump to cloud.
    const setup: VoiceSetupConfig = { ...nativeSetup, fallback: "cloud-to-native" };
    const probe: VoiceProbe = async () => ({ ok: false, error: "down" });
    await expect(selectVoiceBackend({ setup, component: "tts", probe })).rejects.toBeInstanceOf(
      VoiceUnavailableError,
    );
  });

  it("throws when both backends are down", async () => {
    const probe: VoiceProbe = async () => ({ ok: false, error: "down" });
    await expect(
      selectVoiceBackend({ setup: cloudSetup, component: "tts", probe }),
    ).rejects.toThrow(/unavailable/);
  });
});

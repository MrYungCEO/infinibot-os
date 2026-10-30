import { describe, expect, it } from "vitest";

import { migrateLegacyVoiceSettings } from "./config.js";
import { VoiceSetupSchema } from "./schema.js";

describe("migrateLegacyVoiceSettings", () => {
  it("maps the current kokoro voice-settings.json to native", () => {
    const out = migrateLegacyVoiceSettings({
      tts_provider: "kokoro",
      tts_voice_kokoro: "coral",
      wake_word_enabled: false,
      tts_voice_piper: "en_US-kristin-medium",
      voice_route: "claude_code",
    });
    expect(out.provider).toBe("native");
    expect(out.native?.tts).toBe("kokoro");
    expect(out.native?.ttsVoice).toBe("coral");
    expect(out.native?.wakeWord).toBe(false);
    // Migrated output must itself validate.
    expect(VoiceSetupSchema.safeParse(out).success).toBe(true);
  });

  it("maps piper provider to native/piper", () => {
    const out = migrateLegacyVoiceSettings({
      tts_provider: "piper",
      tts_voice_piper: "en_US-ryan-medium",
    });
    expect(out.provider).toBe("native");
    expect(out.native?.tts).toBe("piper");
    expect(out.native?.ttsVoice).toBe("en_US-ryan-medium");
  });

  it("maps elevenlabs provider to cloud and carries the key + voice", () => {
    const out = migrateLegacyVoiceSettings({
      tts_provider: "elevenlabs",
      elevenlabs_api_key: "xi-123",
      tts_voice_elevenlabs: "Daniel",
    });
    expect(out.provider).toBe("cloud");
    expect(out.cloud?.tts).toBe("elevenlabs");
    expect(out.cloud?.apiKey).toBe("xi-123");
    expect(out.cloud?.ttsVoice).toBe("Daniel");
  });

  it("defaults to native/kokoro when nothing is set", () => {
    const out = migrateLegacyVoiceSettings(null);
    expect(out.provider).toBe("native");
    expect(out.native?.tts).toBe("kokoro");
    expect(out.native?.ttsVoice).toBe("bm_george");
  });

  it("treats an unknown provider as native/kokoro", () => {
    const out = migrateLegacyVoiceSettings({ tts_provider: "festival" });
    expect(out.provider).toBe("native");
    expect(out.native?.tts).toBe("kokoro");
  });
});

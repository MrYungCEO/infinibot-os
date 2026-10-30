import { describe, expect, it } from "vitest";

import { runVoiceSmokeTest, type SmokeStages } from "./smoke-test.js";
import type { VoiceSetupConfig } from "./schema.js";

const setup: VoiceSetupConfig = {
  provider: "native",
  native: { tts: "kokoro", ttsVoice: "coral", sttModel: "whisper-base" },
};

function stages(overrides: Partial<SmokeStages> = {}): SmokeStages {
  return {
    mic: async () => ({ ok: true }),
    stt: async () => ({ ok: true }),
    tts: async () => ({ ok: true }),
    speaker: async () => ({ ok: true }),
    ...overrides,
  };
}

describe("runVoiceSmokeTest", () => {
  it("passes when every stage passes", async () => {
    const r = await runVoiceSmokeTest({ setup, stages: stages(), persist: false });
    expect(r.pass).toBe(true);
    expect(r.stage).toBe("ok");
    expect(r.timings?.speaker).toBeGreaterThanOrEqual(0);
  });

  it("surfaces a mic failure at the mic stage", async () => {
    const r = await runVoiceSmokeTest({
      setup,
      stages: stages({ mic: async () => ({ ok: false, message: "no input device" }) }),
      persist: false,
    });
    expect(r.pass).toBe(false);
    expect(r.stage).toBe("mic");
    expect(r.message).toContain("no input device");
  });

  it("stops at the first failing stage (stt) without running later stages", async () => {
    let ttsRan = false;
    const r = await runVoiceSmokeTest({
      setup,
      stages: stages({
        stt: async () => ({ ok: false, message: "stt 500" }),
        tts: async () => {
          ttsRan = true;
          return { ok: true };
        },
      }),
      persist: false,
    });
    expect(r.stage).toBe("stt");
    expect(ttsRan).toBe(false);
  });

  it("surfaces a tts failure at the tts stage", async () => {
    const r = await runVoiceSmokeTest({
      setup,
      stages: stages({ tts: async () => ({ ok: false, message: "kokoro down" }) }),
      persist: false,
    });
    expect(r.stage).toBe("tts");
  });

  it("surfaces a speaker failure at the speaker stage", async () => {
    const r = await runVoiceSmokeTest({
      setup,
      stages: stages({ speaker: async () => ({ ok: false, message: "no output" }) }),
      persist: false,
    });
    expect(r.stage).toBe("speaker");
  });

  it("treats a thrown stage as a failure at that stage", async () => {
    const r = await runVoiceSmokeTest({
      setup,
      stages: stages({
        tts: async () => {
          throw new Error("network reset");
        },
      }),
      persist: false,
    });
    expect(r.pass).toBe(false);
    expect(r.stage).toBe("tts");
    expect(r.message).toContain("network reset");
  });
});

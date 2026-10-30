import { describe, expect, it } from "vitest";
import { flagVoiceModels, isLessacVoice, isOpenWakeWordDefaultModel } from "./commercial-safety.js";

describe("commercial-safety", () => {
  it("flags Piper Lessac voices", () => {
    expect(isLessacVoice("en_US-lessac-medium")).toBe(true);
    expect(isLessacVoice("speaches-ai/piper-en_US-lessac-high")).toBe(true);
    expect(isLessacVoice("en_US-kristin-medium")).toBe(false);
    expect(isLessacVoice(undefined)).toBe(false);
  });

  it("flags openWakeWord default weights but not custom models", () => {
    expect(isOpenWakeWordDefaultModel("openwakeword", "models/hey_jarvis.onnx")).toBe(true);
    expect(isOpenWakeWordDefaultModel("openWakeWord", "hey_jarvis_v0.1.tflite")).toBe(true);
    expect(isOpenWakeWordDefaultModel("openWakeWord", undefined)).toBe(true);
    expect(isOpenWakeWordDefaultModel("openwakeword", "models/hey_infinibot.onnx")).toBe(false);
    expect(isOpenWakeWordDefaultModel("whisper-vad", undefined)).toBe(false);
  });

  it("returns deduplicated self-host-only flags", () => {
    const flags = flagVoiceModels({
      ttsVoices: ["en_US-lessac-medium", "en_US-lessac-medium", "af_heart"],
      wakeWords: [{ engine: "openwakeword", model: "models/hey_jarvis.onnx" }, null],
    });
    expect(flags.map((f) => f.code)).toEqual([
      "piper-lessac-voice",
      "openwakeword-default-weights",
    ]);
    expect(flags.every((f) => f.severity === "self-host-only")).toBe(true);
  });
});

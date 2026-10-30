/**
 * Commercial-safety checks for voice model choices.
 *
 * Some freely downloadable voice models are licensed for non-commercial or
 * research use only (see the license scan, /tmp/fsl-license-scan/REPORT.md):
 *   - openWakeWord's bundled pretrained weights (hey_jarvis, alexa, hey_mycroft,
 *     …) are CC-BY-NC-SA 4.0.
 *   - The Piper "Lessac" voices are trained on the Blizzard 2013 Lessac corpus,
 *     which is research-only.
 *
 * These are fine on a self-hosted, non-commercial install. They must never
 * back a paid cloud offering. Voice providers run their config through
 * `flagVoiceModels()` and surface the flags as "self-host only" in the UI.
 * Nothing here blocks a call; it only labels.
 */

export type VoiceSafetyFlag = {
  /** Stable code: "openwakeword-default-weights" | "piper-lessac-voice". */
  code: string;
  severity: "self-host-only";
  /** Which setting/model triggered it, e.g. "tts voice en_US-lessac-medium". */
  subject: string;
  message: string;
};

/** openWakeWord pretrained models shipped/downloaded by `openwakeword.utils.download_models`. */
const OPENWAKEWORD_DEFAULT_MODELS = [
  "hey_jarvis",
  "alexa",
  "hey_mycroft",
  "hey_rhasspy",
  "timer",
  "weather",
];

export type VoiceModelRefs = {
  /** TTS voice / model ids (any provider). */
  ttsVoices?: Array<string | undefined | null>;
  /** Wake-word model paths or names, with the engine when known. */
  wakeWords?: Array<{ engine?: string | null; model?: string | null } | undefined | null>;
};

function norm(v: string): string {
  return v.trim().toLowerCase();
}

export function isLessacVoice(voice: string | undefined | null): boolean {
  return typeof voice === "string" && norm(voice).includes("lessac");
}

/**
 * True for an openWakeWord model that is one of the default pretrained
 * weights. A custom-trained model (any other file name) is not flagged.
 */
export function isOpenWakeWordDefaultModel(
  engine: string | undefined | null,
  model: string | undefined | null,
): boolean {
  const e = typeof engine === "string" ? norm(engine) : "";
  const m = typeof model === "string" ? norm(model) : "";
  if (!m && e.replace(/[^a-z]/g, "") === "openwakeword") return true; // engine default = hey_jarvis
  const base =
    m
      .split("/")
      .pop()
      ?.replace(/\.(onnx|tflite)$/, "") ?? "";
  const stem = base.replace(/_v\d+(\.\d+)*$/, "");
  return OPENWAKEWORD_DEFAULT_MODELS.includes(stem);
}

export function flagVoiceModels(refs: VoiceModelRefs): VoiceSafetyFlag[] {
  const flags: VoiceSafetyFlag[] = [];
  const seen = new Set<string>();
  const push = (flag: VoiceSafetyFlag) => {
    const key = `${flag.code}:${flag.subject}`;
    if (seen.has(key)) return;
    seen.add(key);
    flags.push(flag);
  };
  for (const voice of refs.ttsVoices ?? []) {
    if (isLessacVoice(voice)) {
      push({
        code: "piper-lessac-voice",
        severity: "self-host-only",
        subject: `tts voice ${voice}`,
        message:
          "Piper Lessac voices are trained on a research-only dataset. Self-host only; not for paid/cloud use.",
      });
    }
  }
  for (const ww of refs.wakeWords ?? []) {
    if (!ww) continue;
    if (isOpenWakeWordDefaultModel(ww.engine, ww.model)) {
      push({
        code: "openwakeword-default-weights",
        severity: "self-host-only",
        subject: `wake word ${ww.model || "openwakeword default"}`,
        message:
          "openWakeWord's pretrained weights are CC-BY-NC-SA (non-commercial). Self-host only; train a custom model for commercial use.",
      });
    }
  }
  return flags;
}

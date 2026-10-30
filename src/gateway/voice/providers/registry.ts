/**
 * Maps a VoiceConfig onto concrete STT/TTS adapters. The one place that knows
 * which provider id → which factory, and how API keys are resolved.
 */

import {
  resolveSttApiKey,
  resolveTtsApiKey,
  type VoiceConfig,
  type VoiceSttConfig,
  type VoiceTtsConfig,
} from "../config.js";
import type { SttProvider, TtsProvider } from "../types.js";
import { createGroqStt } from "./groq-stt.js";
import { createOpenAiStt } from "./openai-stt.js";
import { createDeepgramStt } from "./deepgram-stt.js";
import { createElevenLabsTts } from "./elevenlabs-tts.js";
import { createOpenAiTts } from "./openai-tts.js";
import { createCartesiaTts } from "./cartesia-tts.js";
import { createNativeStt } from "./native-stt.js";
import { createNativeTts } from "./native-tts.js";
import { localProvidersEnabled } from "../../../saas/config.js";

export class VoiceConfigError extends Error {}

export function createSttProvider(stt: VoiceSttConfig): SttProvider {
  if (stt.provider === "native") {
    if (!localProvidersEnabled()) {
      throw new VoiceConfigError(
        "Native (on-device) STT is disabled in cloud-only mode — choose a cloud STT provider (Groq/OpenAI/Deepgram).",
      );
    }
    // Prefer the absolute paths the installer wrote into voice.json.
    return createNativeStt({ model: stt.model, binary: stt.binary });
  }
  const apiKey = resolveSttApiKey(stt);
  if (!apiKey) {
    throw new VoiceConfigError(
      "Cloud STT requires an API key — set it via Quickstart → Voice → STT provider.",
    );
  }
  switch (stt.provider) {
    case "groq":
      return createGroqStt({ apiKey, model: stt.model });
    case "openai":
      return createOpenAiStt({ apiKey, model: stt.model });
    case "deepgram":
      return createDeepgramStt({ apiKey, model: stt.model });
    default:
      throw new VoiceConfigError(`unknown STT provider ${JSON.stringify(stt.provider)}`);
  }
}

export function createTtsProvider(tts: VoiceTtsConfig): TtsProvider {
  if (tts.provider === "native") {
    if (!localProvidersEnabled()) {
      throw new VoiceConfigError(
        "Native (on-device) TTS is disabled in cloud-only mode — choose a cloud TTS provider (ElevenLabs/OpenAI/Cartesia).",
      );
    }
    return createNativeTts({ voice: tts.voice });
  }
  const apiKey = resolveTtsApiKey(tts);
  if (!apiKey) {
    throw new VoiceConfigError(
      "Cloud TTS requires an API key — set it via Quickstart → Voice → TTS provider.",
    );
  }
  switch (tts.provider) {
    case "elevenlabs":
      return createElevenLabsTts({ apiKey, voice: tts.voice });
    case "openai":
      return createOpenAiTts({ apiKey, voice: tts.voice });
    case "cartesia":
      return createCartesiaTts({ apiKey, voice: tts.voice });
    default:
      throw new VoiceConfigError(`unknown TTS provider ${JSON.stringify(tts.provider)}`);
  }
}

export function createProviders(cfg: VoiceConfig): { stt: SttProvider; tts: TtsProvider } {
  return { stt: createSttProvider(cfg.stt), tts: createTtsProvider(cfg.tts) };
}

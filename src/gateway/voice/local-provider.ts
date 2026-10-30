/**
 * The built-in "local" voice provider — this gateway's own voice stack.
 *
 * It wraps what already existed (unchanged): voice.json STT/TTS adapters
 * (cloud Groq/ElevenLabs by default, or native whisper.cpp + Kokoro), the
 * legacy Docker Kokoro/Speaches containers when voice.json is absent, and
 * LiveKit tokens minted against this gateway's LiveKit. The STT/TTS HTTP
 * handlers keep their own routing; this provider only reports status and
 * issues realtime sessions, so voice works with every voice plugin disabled.
 */

import { mintLocalLivekitSession } from "../server-voice-connection.js";
import { flagVoiceModels } from "./commercial-safety.js";
import { isVoiceConfigured, loadVoiceConfig } from "./config.js";
import {
  LOCAL_VOICE_PROVIDER_ID,
  registerBuiltinVoiceProvider,
  type VoiceProvider,
  type VoiceProviderStatus,
} from "./provider-registry.js";

export function createLocalVoiceProvider(): VoiceProvider {
  return {
    id: LOCAL_VOICE_PROVIDER_ID,
    label: "Built-in voice",
    description:
      "This gateway's own voice stack: cloud STT/TTS from Voice setup, or on-device whisper + Kokoro.",
    capabilities: ["realtime", "stt", "tts", "wakeWord"],
    async status(): Promise<VoiceProviderStatus> {
      const cfg = loadVoiceConfig();
      if (!cfg) {
        // No voice.json → legacy Docker path (Kokoro + Speaches containers).
        return {
          ready: true,
          deployment: "local",
          detail: "Docker voice stack (Kokoro + Speaches)",
        };
      }
      const safety = flagVoiceModels({ ttsVoices: [cfg.tts.voice, cfg.tts.voicePath] });
      const summary = `${cfg.mode} · STT ${cfg.stt.provider} · TTS ${cfg.tts.provider}`;
      // Docker mode = the local Speaches (STT) + Kokoro (TTS) containers: no keys involved.
      if (cfg.mode === "docker") {
        return { ready: true, deployment: "local", detail: "Docker voice stack (Speaches + Kokoro)", safety };
      }
      if (!isVoiceConfigured()) {
        return {
          ready: false,
          deployment: cfg.mode === "cloud" ? "cloud" : "local",
          detail: summary,
          error: "Voice provider key missing — finish Setup › Voice.",
          safety,
        };
      }
      return {
        ready: true,
        deployment: cfg.mode === "cloud" ? "cloud" : "local",
        detail: summary,
        safety,
      };
    },
    createRealtimeSession: (req) => mintLocalLivekitSession(req),
    // Wake word runs in the browser on local whisper (ui wake-word.ts) — no
    // openWakeWord weights involved, so it is commercially safe.
    wakeWord: () => ({ engine: "whisper-vad", phrases: ["hey infinibot"], commercialSafe: true }),
  };
}

let registered = false;

/** Idempotent: called from the gateway voice routes + RPCs on first use. */
export function ensureLocalVoiceProvider(): void {
  if (registered) return;
  registered = true;
  registerBuiltinVoiceProvider(createLocalVoiceProvider());
}

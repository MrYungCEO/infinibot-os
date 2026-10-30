/**
 * ElevenLabs TTS — streaming /v1/text-to-speech/{voiceId}/stream. DEFAULT TTS.
 * eleven_turbo_v2_5 keeps first-audio latency low for conversational use.
 */

import { Readable } from "node:stream";

import type { TtsProvider, TtsSynthesizeOptions } from "../types.js";

const ELEVENLABS_BASE = "https://api.elevenlabs.io";
// "Daniel" — deep British male, the common Jarvis-ish stock pick.
const DEFAULT_VOICE = "onwK4e9ZLuTAKqWW03F9";
const DEFAULT_MODEL = "eleven_turbo_v2_5";

export function createElevenLabsTts(opts: {
  apiKey: string;
  voice?: string;
  model?: string;
}): TtsProvider {
  return {
    name: "elevenlabs",
    mimeFor() {
      return "audio/mpeg";
    },
    async synthesize(text: string, synth?: TtsSynthesizeOptions): Promise<Readable> {
      const voiceId = synth?.voice || opts.voice || DEFAULT_VOICE;
      const res = await fetch(
        `${ELEVENLABS_BASE}/v1/text-to-speech/${voiceId}/stream` +
          `?optimize_streaming_latency=2&output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
            "xi-api-key": opts.apiKey,
          },
          body: JSON.stringify({
            text,
            model_id: opts.model || DEFAULT_MODEL,
            voice_settings: {
              stability: 0.45,
              similarity_boost: 0.8,
              style: 0.0,
              use_speaker_boost: true,
            },
          }),
        },
      );
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        throw new Error(`elevenlabs TTS ${res.status}: ${errText.slice(0, 300)}`);
      }
      return Readable.fromWeb(res.body as any);
    },
  };
}

/**
 * Cartesia TTS (optional) — /tts/bytes, Sonic model. Returns the full audio
 * body (Cartesia's REST bytes endpoint is non-chunked but low-latency).
 */

import { Readable } from "node:stream";

import type { TtsProvider, TtsSynthesizeOptions } from "../types.js";

const CARTESIA_ENDPOINT = "https://api.cartesia.ai/tts/bytes";
const CARTESIA_VERSION = "2024-11-13";
const DEFAULT_VOICE = "a0e99841-438c-4a64-b679-ae501e7d6091";
const DEFAULT_MODEL = "sonic-2";

export function createCartesiaTts(opts: {
  apiKey: string;
  voice?: string;
  model?: string;
}): TtsProvider {
  return {
    name: "cartesia",
    mimeFor(format?: string) {
      return format === "wav" ? "audio/wav" : format === "pcm" ? "audio/pcm" : "audio/mpeg";
    },
    async synthesize(text: string, synth?: TtsSynthesizeOptions): Promise<Readable> {
      const container = synth?.format === "wav" ? "wav" : synth?.format === "pcm" ? "raw" : "mp3";
      const res = await fetch(CARTESIA_ENDPOINT, {
        method: "POST",
        headers: {
          "X-API-Key": opts.apiKey,
          "Cartesia-Version": CARTESIA_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model_id: opts.model || DEFAULT_MODEL,
          transcript: text,
          voice: { mode: "id", id: synth?.voice || opts.voice || DEFAULT_VOICE },
          output_format: {
            container,
            encoding: container === "raw" ? "pcm_s16le" : "mp3",
            sample_rate: 44100,
          },
        }),
      });
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        throw new Error(`cartesia TTS ${res.status}: ${errText.slice(0, 300)}`);
      }
      return Readable.fromWeb(res.body as any);
    },
  };
}

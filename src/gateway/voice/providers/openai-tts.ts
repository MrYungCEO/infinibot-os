/**
 * OpenAI TTS — tts-1 via /v1/audio/speech. Streams the encoded audio body.
 */

import { Readable } from "node:stream";

import type { TtsProvider, TtsSynthesizeOptions } from "../types.js";

const OPENAI_ENDPOINT = "https://api.openai.com/v1/audio/speech";
const DEFAULT_VOICE = "onyx";
const DEFAULT_MODEL = "tts-1";

export function createOpenAiTts(opts: {
  apiKey: string;
  voice?: string;
  model?: string;
}): TtsProvider {
  return {
    name: "openai",
    mimeFor(format?: string) {
      return format === "wav"
        ? "audio/wav"
        : format === "opus"
          ? "audio/opus"
          : format === "pcm"
            ? "audio/pcm"
            : "audio/mpeg";
    },
    async synthesize(text: string, synth?: TtsSynthesizeOptions): Promise<Readable> {
      const res = await fetch(OPENAI_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: opts.model || DEFAULT_MODEL,
          voice: synth?.voice || opts.voice || DEFAULT_VOICE,
          input: text,
          response_format: synth?.format || "mp3",
          ...(synth?.speed ? { speed: synth.speed } : {}),
        }),
      });
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        throw new Error(`openai TTS ${res.status}: ${errText.slice(0, 300)}`);
      }
      return Readable.fromWeb(res.body as any);
    },
  };
}

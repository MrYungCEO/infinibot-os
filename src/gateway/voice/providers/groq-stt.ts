/**
 * Groq STT — whisper-large-v3-turbo via the OpenAI-compatible
 * /openai/v1/audio/transcriptions endpoint. DEFAULT cloud STT.
 *
 * Batch provider: pushAudio() accumulates frames, end() POSTs the whole
 * buffer as multipart/form-data and returns { text }.
 */

import type { SttProvider, SttStartOptions, SttStream } from "../types.js";
import { wavWrap } from "../audio.js";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";
const DEFAULT_MODEL = "whisper-large-v3-turbo";

export function createGroqStt(opts: { apiKey: string; model?: string }): SttProvider {
  const model = opts.model || DEFAULT_MODEL;
  return {
    name: "groq",
    start(start?: SttStartOptions): SttStream {
      const chunks: Buffer[] = [];
      return {
        pushAudio(chunk) {
          chunks.push(chunk);
        },
        async end() {
          const body = prepareAudio(Buffer.concat(chunks), start);
          const form = new FormData();
          form.append(
            "file",
            new Blob([new Uint8Array(body.bytes)], { type: body.mime }),
            body.filename,
          );
          form.append("model", start?.model || model);
          form.append("response_format", "json");
          if (start?.language) form.append("language", start.language);

          const res = await fetch(GROQ_ENDPOINT, {
            method: "POST",
            headers: { Authorization: `Bearer ${opts.apiKey}` },
            body: form,
          });
          if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`groq STT ${res.status}: ${errText.slice(0, 300)}`);
          }
          const json = (await res.json()) as { text?: string };
          return (json.text ?? "").trim();
        },
      };
    },
  };
}

/**
 * Cloud Whisper endpoints want a real container. Raw 16 kHz PCM gets wrapped
 * into a WAV header; anything already containerized (webm/ogg/mp3/wav) passes
 * through with the matching mime.
 */
export function prepareAudio(
  raw: Buffer,
  start?: SttStartOptions,
): { bytes: Buffer; mime: string; filename: string } {
  const enc = start?.encoding ?? "wav";
  switch (enc) {
    case "pcm":
      return {
        bytes: wavWrap(raw, start?.sampleRate ?? 16000),
        mime: "audio/wav",
        filename: "audio.wav",
      };
    case "webm":
      return { bytes: raw, mime: "audio/webm", filename: "audio.webm" };
    case "ogg":
      return { bytes: raw, mime: "audio/ogg", filename: "audio.ogg" };
    case "mp3":
      return { bytes: raw, mime: "audio/mpeg", filename: "audio.mp3" };
    case "wav":
    default:
      // Bytes that already start with RIFF are a real WAV; otherwise wrap.
      if (raw.length >= 4 && raw.toString("ascii", 0, 4) === "RIFF") {
        return { bytes: raw, mime: "audio/wav", filename: "audio.wav" };
      }
      return {
        bytes: wavWrap(raw, start?.sampleRate ?? 16000),
        mime: "audio/wav",
        filename: "audio.wav",
      };
  }
}

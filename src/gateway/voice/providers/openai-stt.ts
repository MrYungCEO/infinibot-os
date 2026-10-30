/**
 * OpenAI STT — gpt-4o-transcribe via /v1/audio/transcriptions.
 * Batch provider, same multipart shape as Groq.
 */

import type { SttProvider, SttStartOptions, SttStream } from "../types.js";
import { prepareAudio } from "./groq-stt.js";

const OPENAI_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const DEFAULT_MODEL = "gpt-4o-transcribe";

export function createOpenAiStt(opts: { apiKey: string; model?: string }): SttProvider {
  const model = opts.model || DEFAULT_MODEL;
  return {
    name: "openai",
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

          const res = await fetch(OPENAI_ENDPOINT, {
            method: "POST",
            headers: { Authorization: `Bearer ${opts.apiKey}` },
            body: form,
          });
          if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`openai STT ${res.status}: ${errText.slice(0, 300)}`);
          }
          const json = (await res.json()) as { text?: string };
          return (json.text ?? "").trim();
        },
      };
    },
  };
}

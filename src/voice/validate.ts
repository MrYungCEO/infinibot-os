/**
 * Provider validation + native model detection for the voice setup paths.
 *
 * The wizard (CLI + browser) calls these before persisting a config so the
 * user finds out a bad key / missing model immediately instead of at first
 * use.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveStateDir } from "../config/paths.js";
import { resolveVoiceUrls } from "../gateway/server-voice-urls.js";
import type { VoiceCloudTtsProvider } from "./schema.js";

export type KeyValidation = { ok: boolean; message: string };

/** Injectable fetch so this is testable. */
export type FetchLike = typeof fetch;

/**
 * Validate a managed-provider API key by hitting a cheap authenticated
 * endpoint (`/v1/voices` or `/v1/models`). Edge TTS needs no key.
 */
export async function validateCloudVoiceKey(
  provider: VoiceCloudTtsProvider,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<KeyValidation> {
  if (provider === "edge") return { ok: true, message: "Edge TTS needs no API key" };
  const key = apiKey?.trim();
  if (!key) return { ok: false, message: "API key is empty" };

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let res: Response;
    if (provider === "elevenlabs") {
      res = await fetchImpl("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": key },
        signal: ctrl.signal,
      });
    } else {
      // openai
      res = await fetchImpl("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: ctrl.signal,
      });
    }
    clearTimeout(timer);
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: `${provider} rejected the key (${res.status})` };
    }
    if (!res.ok) {
      return { ok: false, message: `${provider} returned ${res.status}` };
    }
    return { ok: true, message: `${provider} key validated` };
  } catch (err) {
    return { ok: false, message: `could not reach ${provider}: ${(err as Error).message}` };
  }
}

export type NativeModelStatus = {
  kokoro: { present: boolean; detail: string };
  speaches: { present: boolean; detail: string };
};

/** Local model directory for downloaded (Piper) voices. */
export function voiceModelsDir(): string {
  return path.join(resolveStateDir(), "voice", "models");
}

/**
 * Detect whether the native engines are available. Kokoro/Speaches run as
 * local containers, so "present" = the container answers. Returns detail
 * strings the wizard surfaces verbatim.
 */
export async function detectNativeModels(fetchImpl: FetchLike = fetch): Promise<NativeModelStatus> {
  const urls = resolveVoiceUrls();
  const probe = async (url: string): Promise<{ present: boolean; detail: string }> => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetchImpl(url, { signal: ctrl.signal });
      clearTimeout(timer);
      return { present: res.status < 500, detail: `${url} → ${res.status}` };
    } catch (err) {
      return { present: false, detail: `${url} unreachable: ${(err as Error).message}` };
    }
  };
  const [kokoro, speaches] = await Promise.all([
    probe(`${urls.kokoro}/v1/audio/voices`),
    probe(`${urls.speaches}/v1/models`),
  ]);
  return { kokoro, speaches };
}

/** True when a downloaded Piper voice already exists on disk. */
export function piperVoiceInstalled(voiceId: string): boolean {
  const dir = voiceModelsDir();
  return fs.existsSync(path.join(dir, `${voiceId}.onnx`));
}

/**
 * Download a Piper voice (.onnx + .onnx.json) from the rhasspy piper-voices
 * HF repo into the local models dir. Reports byte progress so the wizard can
 * show a bar. Quality/locale are derived from the voice id (en_US-kristin-medium).
 */
export async function downloadPiperVoice(
  voiceId: string,
  onProgress?: (received: number, total: number | null) => void,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: boolean; message: string; path?: string }> {
  const m = /^([a-z]{2})_([A-Z]{2})-(.+)-(low|medium|high|x_low)$/.exec(voiceId);
  if (!m) return { ok: false, message: `unrecognized Piper voice id: ${voiceId}` };
  const [, lang, region, name, quality] = m;
  const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${lang}_${region}/${name}/${quality}`;
  const dir = voiceModelsDir();
  fs.mkdirSync(dir, { recursive: true });

  try {
    for (const ext of [".onnx", ".onnx.json"]) {
      const url = `${base}/${voiceId}${ext}`;
      const res = await fetchImpl(url);
      if (!res.ok || !res.body) {
        return { ok: false, message: `download failed for ${voiceId}${ext} (${res.status})` };
      }
      const total = Number(res.headers.get("content-length")) || null;
      const chunks: Uint8Array[] = [];
      let received = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          received += value.length;
          if (ext === ".onnx") onProgress?.(received, total);
        }
      }
      fs.writeFileSync(path.join(dir, `${voiceId}${ext}`), Buffer.concat(chunks));
    }
    return { ok: true, message: `installed ${voiceId}`, path: path.join(dir, `${voiceId}.onnx`) };
  } catch (err) {
    return { ok: false, message: `download error: ${(err as Error).message}` };
  }
}

/**
 * Local speech-to-text with timestamps. Two on-device engines, tried in order:
 *
 *   1. The voice stack's speaches server (OpenAI-compatible, loopback only —
 *      faster-whisper large-v3-turbo on the GPU).
 *   2. faster-whisper in-process via Python with a cached model (HF offline).
 *
 * Nothing is sent off the machine: the HTTP endpoint is re-validated as
 * loopback on every call, and the Python fallback runs with the Hugging Face
 * hub forced offline.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertLocalEndpoint } from "../../ocr/local-only.js";
import { round3 } from "./sampling.js";
import type { TranscriptSegment } from "./types.js";

const execFileAsync = promisify(execFile);

export interface TranscribeResult {
  segments: TranscriptSegment[];
  language: string | null;
  engine: string;
  model: string;
}

export interface Transcriber {
  /** Engine label (null when none is usable). */
  available(): Promise<string | null>;
  transcribe(wavPath: string, offset: number): Promise<TranscribeResult>;
}

export interface SttConfig {
  /** Loopback speaches/OpenAI-compatible origin, or null to skip. */
  url: string | null;
  urlRefused?: string;
  model: string;
  python: string;
  whisperModel: string | null;
}

export function resolveSttConfig(env: NodeJS.ProcessEnv = process.env): SttConfig {
  const raw = env.INFINIBOT_VIDEO_STT_URL?.trim() ?? "http://127.0.0.1:8002";
  let url: string | null = null;
  let urlRefused: string | undefined;
  if (raw && raw !== "off") {
    try {
      url = assertLocalEndpoint(raw);
    } catch (err) {
      urlRefused = (err as Error).message;
    }
  }
  return {
    url,
    urlRefused,
    model: env.INFINIBOT_VIDEO_STT_MODEL?.trim() || "deepdml/faster-whisper-large-v3-turbo-ct2",
    python: env.INFINIBOT_VIDEO_PYTHON?.trim() || "python3",
    whisperModel: env.INFINIBOT_VIDEO_WHISPER_MODEL?.trim() || null,
  };
}

/** Normalise + offset raw segments; drop empty and hallucinated filler lines. */
export function normalizeSegments(
  raw: Array<{ start?: number; end?: number; text?: string }>,
  offset: number,
): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const s of raw) {
    const text = String(s.text ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    if (/^(\[?(music|silence|blank_audio|inaudible)\]?|\.+|thank you\.?)$/i.test(text)) continue;
    const start = round3(Number(s.start ?? 0) + offset);
    const end = round3(Math.max(Number(s.end ?? s.start ?? 0) + offset, start));
    const prev = out[out.length - 1];
    if (prev && prev.text === text && start - prev.end < 1) {
      prev.end = end; // collapse whisper repetition loops
      continue;
    }
    out.push({ start, end, text });
  }
  return out;
}

const WHISPER_PREF = [
  "large-v3",
  "large-v3-turbo",
  "medium",
  "small",
  "base",
  "small.en",
  "base.en",
  "tiny",
];

/** First cached faster-whisper model (multilingual preferred). */
export function pickCachedWhisperModel(hubDir: string): string | null {
  let names: string[] = [];
  try {
    names = fs.readdirSync(hubDir);
  } catch {
    return null;
  }
  for (const m of WHISPER_PREF) {
    if (names.includes(`models--Systran--faster-whisper-${m}`)) return m;
  }
  return null;
}

const PY_RUNNER = `
import json, sys
from faster_whisper import WhisperModel
wav, model_name = sys.argv[1], sys.argv[2]
try:
    model = WhisperModel(model_name, device="cuda", compute_type="float16")
except Exception:
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
segs, info = model.transcribe(wav, vad_filter=True, beam_size=1)
out = [{"start": s.start, "end": s.end, "text": s.text} for s in segs]
print(json.dumps({"language": info.language, "segments": out}))
`;

export function createLocalTranscriber(
  cfg: SttConfig,
  fetchImpl: typeof fetch = fetch,
): Transcriber {
  let httpOk: { ok: boolean; at: number } | null = null;
  const hub = path.join(os.homedir(), ".cache", "huggingface", "hub");

  const httpAvailable = async (): Promise<boolean> => {
    if (!cfg.url) return false;
    if (httpOk && Date.now() - httpOk.at < 60_000) return httpOk.ok;
    let ok = false;
    try {
      const res = await fetchImpl(`${assertLocalEndpoint(cfg.url)}/v1/models`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<{ id: string }> };
        ok = (body.data ?? []).some((m) => m.id === cfg.model);
      }
    } catch {
      ok = false;
    }
    httpOk = { ok, at: Date.now() };
    return ok;
  };

  const pyModel = () => cfg.whisperModel ?? pickCachedWhisperModel(hub);

  const viaHttp = async (wav: string, offset: number): Promise<TranscribeResult> => {
    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(wav)], { type: "audio/wav" }), "chunk.wav");
    form.append("model", cfg.model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    const res = await fetchImpl(`${assertLocalEndpoint(cfg.url!)}/v1/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(15 * 60_000),
    });
    if (!res.ok)
      throw new Error(`local STT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      language?: string;
      segments?: Array<{ start: number; end: number; text: string }>;
      text?: string;
    };
    const segs = body.segments?.length
      ? body.segments
      : body.text
        ? [{ start: 0, end: 0, text: body.text }]
        : [];
    return {
      segments: normalizeSegments(segs, offset),
      language: body.language ?? null,
      engine: "speaches",
      model: cfg.model,
    };
  };

  const viaPython = async (wav: string, offset: number): Promise<TranscribeResult> => {
    const model = pyModel();
    if (!model) throw new Error("no cached faster-whisper model");
    const env: NodeJS.ProcessEnv = {};
    for (const k of ["PATH", "HOME", "LANG", "LD_LIBRARY_PATH"])
      if (process.env[k]) env[k] = process.env[k];
    env.HF_HUB_OFFLINE = "1";
    env.TRANSFORMERS_OFFLINE = "1";
    env.NO_PROXY = "*";
    const { stdout } = await execFileAsync(cfg.python, ["-P", "-c", PY_RUNNER, wav, model], {
      timeout: 30 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
      env,
    });
    const body = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as {
      language?: string;
      segments?: Array<{ start: number; end: number; text: string }>;
    };
    return {
      segments: normalizeSegments(body.segments ?? [], offset),
      language: body.language ?? null,
      engine: "faster-whisper",
      model,
    };
  };

  return {
    async available() {
      if (await httpAvailable()) return `speaches:${cfg.model}`;
      const m = pyModel();
      return m ? `faster-whisper:${m}` : null;
    },
    async transcribe(wav, offset) {
      if (await httpAvailable()) {
        try {
          return await viaHttp(wav, offset);
        } catch (err) {
          httpOk = { ok: false, at: Date.now() };
          if (!pyModel()) throw err;
        }
      }
      return await viaPython(wav, offset);
    },
  };
}

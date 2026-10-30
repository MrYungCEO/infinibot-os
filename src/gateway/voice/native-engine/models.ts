/**
 * What the built-in voice engine downloads: ONNX models from Hugging Face,
 * stored under <stateDir>/voice/engine/models/<repo>/<file> — the layout
 * transformers.js reads with `env.localModelPath`, so the engine then runs
 * fully offline. Kokoro's voice files ship inside the kokoro-js package.
 */

import * as path from "node:path";

export interface ModelFile {
  repo: string;
  file: string;
  /** Size used for estimates until the server reports the real one. */
  approxBytes: number;
}

export interface ModelSet {
  id: "kokoro" | "whisper";
  label: string;
  repo: string;
  files: ModelFile[];
}

const MB = 1024 * 1024;

export const KOKORO_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";

export const KOKORO_MODEL: ModelSet = {
  id: "kokoro",
  label: "Voice engine",
  repo: KOKORO_REPO,
  files: [
    { repo: KOKORO_REPO, file: "config.json", approxBytes: 100 },
    { repo: KOKORO_REPO, file: "tokenizer.json", approxBytes: 4000 },
    { repo: KOKORO_REPO, file: "tokenizer_config.json", approxBytes: 200 },
    { repo: KOKORO_REPO, file: "onnx/model_quantized.onnx", approxBytes: 92 * MB },
  ],
};

export type WhisperSize = "base" | "small";

export const WHISPER_REPOS: Record<
  WhisperSize,
  { repo: string; approxMb: { encoder: number; decoder: number } }
> = {
  base: { repo: "onnx-community/whisper-base", approxMb: { encoder: 23, decoder: 54 } },
  small: { repo: "onnx-community/whisper-small", approxMb: { encoder: 94, decoder: 160 } },
};

export function whisperModel(size: WhisperSize): ModelSet {
  const { repo, approxMb } = WHISPER_REPOS[size];
  return {
    id: "whisper",
    label: "Speech-to-text engine",
    repo,
    files: [
      { repo, file: "config.json", approxBytes: 2300 },
      { repo, file: "generation_config.json", approxBytes: 4000 },
      { repo, file: "preprocessor_config.json", approxBytes: 400 },
      { repo, file: "tokenizer.json", approxBytes: 2.5 * MB },
      { repo, file: "tokenizer_config.json", approxBytes: 290_000 },
      { repo, file: "onnx/encoder_model_quantized.onnx", approxBytes: approxMb.encoder * MB },
      {
        repo,
        file: "onnx/decoder_model_merged_quantized.onnx",
        approxBytes: approxMb.decoder * MB,
      },
    ],
  };
}

/** Bigger, more accurate speech model when the computer has the memory for it. */
export function chooseWhisperSize(ramGb: number): WhisperSize {
  return ramGb >= 16 ? "small" : "base";
}

/** Accept "base" / "small" / a full onnx-community repo id. */
export function whisperSizeFrom(v: string | undefined, ramGb: number): WhisperSize {
  const s = (v ?? "").toLowerCase();
  if (s.includes("small")) return "small";
  if (s.includes("base")) return "base";
  return chooseWhisperSize(ramGb);
}

export function engineDir(stateDir: string): string {
  return path.join(stateDir, "voice", "engine");
}

export function modelsDir(stateDir: string): string {
  return path.join(engineDir(stateDir), "models");
}

export function localPath(dir: string, f: ModelFile): string {
  return path.join(dir, ...f.repo.split("/"), ...f.file.split("/"));
}

export function remoteUrl(
  f: ModelFile,
  host = process.env.INFINIBOT_VOICE_MODEL_HOST || "https://huggingface.co",
): string {
  return `${host.replace(/\/+$/, "")}/${f.repo}/resolve/main/${f.file}`;
}

/** Default local port for the engine's OpenAI-compatible API (one port, STT + TTS). */
export const ENGINE_DEFAULT_PORT = 8886;

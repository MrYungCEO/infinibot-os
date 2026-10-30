/**
 * Filesystem layout for the native (no-Docker) voice stack. Binaries and
 * models live under ~/.infinibot/voice/, downloaded on `voice up --native`.
 */

import * as os from "node:os";
import * as path from "node:path";

import { STATE_DIR } from "../../../config/paths.js";

export const VOICE_HOME = path.join(STATE_DIR, "voice");
export const WHISPER_DIR = path.join(VOICE_HOME, "whisper");
export const WHISPER_MODELS_DIR = path.join(WHISPER_DIR, "models");
export const KOKORO_DIR = path.join(VOICE_HOME, "kokoro");
/** whisper.cpp source checkout used when we build the binary from source. */
export const WHISPER_SRC_DIR = path.join(WHISPER_DIR, "src");
/** piper binary + voices (only used when the native TTS engine is piper). */
export const PIPER_DIR = path.join(VOICE_HOME, "piper");
export const PIPER_VOICES_DIR = path.join(PIPER_DIR, "voices");

/** whisper.cpp CLI binary location (built or downloaded). */
export function whisperBinaryPath(): string {
  const name = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
  return path.join(WHISPER_DIR, name);
}

export function whisperModelPath(model = "ggml-base.en"): string {
  const file = model.endsWith(".bin") ? model : `${model}.bin`;
  return path.join(WHISPER_MODELS_DIR, file);
}

/** piper CLI binary location. */
export function piperBinaryPath(): string {
  const name = process.platform === "win32" ? "piper.exe" : "piper";
  return path.join(PIPER_DIR, name);
}

/** Candidate names whisper.cpp's CLI has shipped under (renamed main → whisper-cli). */
export const WHISPER_CLI_NAMES = ["whisper-cli", "whisper-cpp", "main"] as const;

/** True on Apple Silicon — Metal acceleration available. */
export function isAppleSilicon(): boolean {
  return process.platform === "darwin" && os.arch() === "arm64";
}

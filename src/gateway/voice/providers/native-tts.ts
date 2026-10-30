/**
 * Native TTS — kokoro-js ONNX, in-process. Default voice am_puck.
 *
 * kokoro-js is an OPTIONAL dependency (downloads its own ONNX weights on first
 * use). It's loaded via dynamic import so a build without it still typechecks;
 * synthesize() throws a clear, actionable error when the package is missing.
 */

import { Readable } from "node:stream";

import type { TtsProvider, TtsSynthesizeOptions } from "../types.js";

const DEFAULT_VOICE = "am_puck";

// Lazily-instantiated singleton — model load is ~hundreds of ms, do it once.
let ttsPromise: Promise<any> | null = null;

async function loadKokoro(): Promise<any> {
  if (ttsPromise) return ttsPromise;
  ttsPromise = (async () => {
    let mod: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mod = await import(/* @vite-ignore */ "kokoro-js" as any);
    } catch {
      throw new Error(
        "kokoro-js is not installed — run `infinibot voice up --native` (it installs the native TTS dependency and downloads the ONNX model)",
      );
    }
    const KokoroTTS = mod.KokoroTTS ?? mod.default?.KokoroTTS ?? mod.default;
    // q8 quantization keeps the model small (~80MB) and fast on CPU.
    return KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
      dtype: "q8",
    });
  })();
  return ttsPromise;
}

export function createNativeTts(opts: { voice?: string }): TtsProvider {
  return {
    name: "native",
    mimeFor() {
      return "audio/wav";
    },
    async synthesize(text: string, synth?: TtsSynthesizeOptions): Promise<Readable> {
      const tts = await loadKokoro();
      const audio = await tts.generate(text, {
        voice: synth?.voice || opts.voice || DEFAULT_VOICE,
      });
      // kokoro-js RawAudio exposes toWav() → ArrayBuffer of a WAV container.
      const wav: ArrayBuffer = typeof audio.toWav === "function" ? audio.toWav() : audio;
      return Readable.from(Buffer.from(wav));
    },
  };
}

/**
 * Where the built-in engine runs Whisper, and the accuracy self-check that
 * decides whether a graphics-card setup may be used.
 *
 * Measured 2026-10-18 (desktop 10.19 Windows build, onnxruntime-node 1.21,
 * transformers.js 3.8.1, RTX GPU through DirectML): with the DECODER on
 * DirectML Whisper gets the first word right and then repeats garbage
 * ("This people people people … mazmazmaz") until the token limit — 800-990%
 * word error rate for every dtype (q8, fp16, fp32), 10× slower than real time.
 * The encoder on DirectML is fine (3.9% WER, faster than the processor), so on
 * Windows the encoder uses the graphics card and the decoder the processor.
 *
 * A device that loads is not proof it transcribes, so every candidate must
 * pass a self-check (Kokoro speaks a known sentence, Whisper must get it back)
 * before it is used; a failing candidate falls through to the next one.
 */

export type WhisperDevice = string | { encoder_model: string; decoder_model_merged: string };

export interface SttDeviceCandidate {
  /** Short label for /health and logs: "dml-encoder", "cuda", "cpu", "wasm". */
  label: string;
  device: WhisperDevice;
  gpu: boolean;
}

/** Candidates in order of preference; the last one is always the processor. */
export function sttDevicePlan(opts: {
  device: string;
  wasm: boolean;
  platform: NodeJS.Platform;
  arch: string;
}): SttDeviceCandidate[] {
  const cpu: SttDeviceCandidate = { label: opts.wasm ? "wasm" : "cpu", device: "cpu", gpu: false };
  if (opts.wasm || opts.device === "cpu") return [cpu];
  if (opts.platform === "win32")
    // Never the decoder on DirectML (see above).
    return [
      {
        label: "dml-encoder",
        device: { encoder_model: "dml", decoder_model_merged: "cpu" },
        gpu: true,
      },
      cpu,
    ];
  if (opts.platform === "linux" && opts.arch === "x64")
    return [{ label: "cuda", device: "cuda", gpu: true }, cpu];
  return [cpu];
}

/** Sentence Kokoro speaks for the self-check (plain words, no numbers or names). */
export const SELF_CHECK_SENTENCE =
  "Please open the project dashboard and read me the latest messages from the team.";

/** Above this word error rate a device is producing garbage, not mishearing. */
export const SELF_CHECK_MAX_WER = 0.35;

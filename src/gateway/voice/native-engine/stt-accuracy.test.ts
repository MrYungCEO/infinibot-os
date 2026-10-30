import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { SELF_CHECK_MAX_WER, SELF_CHECK_SENTENCE, sttDevicePlan } from "./stt-device.js";
import {
  decodeWav,
  decodeWithFfmpeg,
  encodeWav16,
  resample,
  toWhisperInput,
  UnsupportedAudioError,
} from "./wav.js";
import { corpusWer, normalizeTranscript, numberToWords, wordErrorRate } from "./wer.js";

/** WAV with any channel count / sample format, built by hand (no encoder shortcuts). */
function wav(opts: {
  rate: number;
  channels: number;
  bits: 8 | 16 | 24 | 32;
  float?: boolean;
  extensible?: boolean;
  frames: (i: number, ch: number) => number;
  n: number;
}): Buffer {
  const bytes = opts.bits / 8;
  const data = Buffer.alloc(opts.n * opts.channels * bytes);
  for (let i = 0; i < opts.n; i++)
    for (let c = 0; c < opts.channels; c++) {
      const v = Math.max(-1, Math.min(1, opts.frames(i, c)));
      const o = (i * opts.channels + c) * bytes;
      if (opts.float) data.writeFloatLE(v, o);
      else if (opts.bits === 16) data.writeInt16LE(Math.round(v * 32767), o);
      else if (opts.bits === 24) data.writeIntLE(Math.round(v * 8388607), o, 3);
      else if (opts.bits === 32) data.writeInt32LE(Math.round(v * 2147483647), o);
      else data.writeUInt8(Math.round(v * 127 + 128), o);
    }
  const fmtLen = opts.extensible ? 40 : 16;
  const fmt = Buffer.alloc(8 + fmtLen);
  fmt.write("fmt ", 0, "ascii");
  fmt.writeUInt32LE(fmtLen, 4);
  const tag = opts.float ? 3 : 1;
  fmt.writeUInt16LE(opts.extensible ? 0xfffe : tag, 8);
  fmt.writeUInt16LE(opts.channels, 10);
  fmt.writeUInt32LE(opts.rate, 12);
  fmt.writeUInt32LE(opts.rate * opts.channels * bytes, 16);
  fmt.writeUInt16LE(opts.channels * bytes, 20);
  fmt.writeUInt16LE(opts.bits, 22);
  if (opts.extensible) {
    fmt.writeUInt16LE(22, 24);
    fmt.writeUInt16LE(tag, 32); // first two bytes of the SubFormat GUID
  }
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(4 + fmt.length + 8 + data.length, 4);
  head.write("WAVE", 8, "ascii");
  const dh = Buffer.alloc(8);
  dh.write("data", 0, "ascii");
  dh.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, fmt, dh, data]);
}

/** Dominant frequency by counting upward zero crossings. */
function freqOf(s: Float32Array, rate: number): number {
  let n = 0;
  for (let i = 1; i < s.length; i++) if (s[i - 1]! < 0 && s[i]! >= 0) n++;
  return (n * rate) / s.length;
}

const peak = (s: Float32Array) => s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const tone =
  (hz: number, rate: number, amp = 0.5) =>
  (i: number) =>
    amp * Math.sin((2 * Math.PI * hz * i) / rate);

describe("speech input → 16 kHz mono float32 in [-1, 1]", () => {
  it("44.1 kHz stereo int16: downmixed, normalised, resampled, pitch kept", async () => {
    const buf = wav({ rate: 44100, channels: 2, bits: 16, n: 44100, frames: tone(440, 44100) });
    const out = await toWhisperInput(buf);
    expect(out.length).toBe(16000);
    expect(peak(out)).toBeGreaterThan(0.45);
    expect(peak(out)).toBeLessThanOrEqual(0.5);
    expect(freqOf(out, 16000)).toBeCloseTo(440, -1);
  });

  it("48 kHz mono float32 (browser capture rate)", async () => {
    const buf = wav({
      rate: 48000,
      channels: 1,
      bits: 32,
      float: true,
      n: 48000,
      frames: tone(300, 48000, 0.8),
    });
    const out = await toWhisperInput(buf);
    expect(out.length).toBe(16000);
    expect(peak(out)).toBeCloseTo(0.8, 2);
    expect(freqOf(out, 16000)).toBeCloseTo(300, -1);
  });

  it("16 kHz float32 (voice-call VAD encodeWAV) passes through untouched", async () => {
    const buf = wav({
      rate: 16000,
      channels: 1,
      bits: 32,
      float: true,
      n: 1600,
      frames: tone(200, 16000),
    });
    const out = await toWhisperInput(buf);
    expect(out.length).toBe(1600);
    expect(out[40]).toBeCloseTo(tone(200, 16000)(40), 5);
  });

  it("stereo channels are averaged, not concatenated or interleaved", () => {
    const buf = wav({
      rate: 16000,
      channels: 2,
      bits: 16,
      n: 100,
      frames: (_i, c) => (c ? -0.5 : 0.5),
    });
    const { samples } = decodeWav(buf);
    expect(samples.length).toBe(100);
    expect(peak(samples)).toBeLessThan(1e-4);
  });

  it("8-, 24- and 32-bit integer PCM and WAVE_FORMAT_EXTENSIBLE scale to [-1, 1]", () => {
    for (const bits of [8, 24, 32] as const) {
      const { samples } = decodeWav(
        wav({ rate: 16000, channels: 1, bits, n: 160, frames: tone(100, 16000, 0.9) }),
      );
      expect(peak(samples)).toBeCloseTo(0.9, 1);
    }
    const ext = decodeWav(
      wav({ rate: 22050, channels: 6, bits: 16, extensible: true, n: 100, frames: () => 0.25 }),
    );
    expect(ext.sampleRate).toBe(22050);
    expect(ext.samples[50]).toBeCloseTo(0.25, 3);
  });

  it("resample keeps duration for every common rate", () => {
    for (const rate of [8000, 22050, 24000, 32000, 44100, 48000]) {
      const out = resample(new Float32Array(rate * 2), rate, 16000);
      expect(Math.abs(out.length - 32000)).toBeLessThanOrEqual(1);
    }
  });

  it("encodeWav16 → decodeWav round-trips within int16 precision", () => {
    const src = new Float32Array(500).map((_, i) => tone(330, 24000, 0.7)(i));
    const { samples, sampleRate } = decodeWav(encodeWav16(src, 24000));
    expect(sampleRate).toBe(24000);
    for (let i = 0; i < src.length; i++) expect(Math.abs(samples[i]! - src[i]!)).toBeLessThan(1e-4);
  });

  it("non-WAV without ffmpeg is a clear 'send WAV' error, never silent garbage", async () => {
    await expect(
      decodeWithFfmpeg(Buffer.from("OggS fake"), "/nonexistent/ffmpeg"),
    ).rejects.toBeInstanceOf(UnsupportedAudioError);
  });

  const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
  it.skipIf(!hasFfmpeg)("48 kHz WebM/Opus (MediaRecorder) decodes through ffmpeg", async () => {
    const r = spawnSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=1",
      "-ac",
      "2",
      "-c:a",
      "libopus",
      "-f",
      "webm",
      "pipe:1",
    ]);
    const out = await toWhisperInput(Buffer.from(r.stdout));
    expect(Math.abs(out.length - 16000)).toBeLessThan(800);
    expect(freqOf(out.subarray(2000, 14000), 16000)).toBeCloseTo(440, -1);
    expect(peak(out)).toBeLessThanOrEqual(1);
  });
});

describe("word error rate", () => {
  it("scores a perfect transcript 0 despite case, punctuation, abbreviations and digits", () => {
    expect(wordErrorRate("MISTER QUILTER HAS THREE CATS", "Mr. Quilter has 3 cats.").wer).toBe(0);
    expect(normalizeTranscript("It's 21 — twenty-one!")).toEqual([
      "it's",
      "twenty",
      "one",
      "twenty",
      "one",
    ]);
    expect(numberToWords(1905)).toBe("one thousand nine hundred five");
  });

  it("counts substitutions, deletions and insertions; garbage can exceed 100%", () => {
    expect(wordErrorRate("the quick brown fox", "the quick red fox").wer).toBe(0.25);
    expect(wordErrorRate("the quick brown fox", "").wer).toBe(1);
    expect(wordErrorRate("hello there", "hello people people people people").wer).toBe(2); // 1 sub + 3 ins over 2 words
  });

  it("corpus WER weights by words, not by clip", () => {
    const a = wordErrorRate("one two three four", "one two three four");
    const b = wordErrorRate("five", "six");
    expect(corpusWer([a, b])).toBeCloseTo(1 / 5);
  });
});

describe("whisper device plan", () => {
  it("never runs the decoder on DirectML (garbage on 10.19), encoder may use the GPU", () => {
    const plan = sttDevicePlan({ device: "auto", wasm: false, platform: "win32", arch: "x64" });
    for (const c of plan) {
      const d = c.device;
      if (typeof d === "string") expect(d).not.toBe("dml");
      else expect(d.decoder_model_merged).toBe("cpu");
    }
    expect(plan[0]!.label).toBe("dml-encoder");
    expect(plan.at(-1)!.device).toBe("cpu");
  });

  it("CPU-only and wasm installs try the processor only", () => {
    expect(sttDevicePlan({ device: "cpu", wasm: false, platform: "win32", arch: "x64" })).toEqual([
      { label: "cpu", device: "cpu", gpu: false },
    ]);
    expect(sttDevicePlan({ device: "auto", wasm: true, platform: "win32", arch: "x64" })).toEqual([
      { label: "wasm", device: "cpu", gpu: false },
    ]);
    expect(
      sttDevicePlan({ device: "auto", wasm: false, platform: "darwin", arch: "arm64" }),
    ).toHaveLength(1);
  });

  it("self-check rejects the garbage the DirectML decoder produced", () => {
    const garbage = "Please groom suff glauben duh duh duh duh Flint Bali Bali Bali";
    expect(wordErrorRate(SELF_CHECK_SENTENCE, garbage).wer).toBeGreaterThan(SELF_CHECK_MAX_WER);
    expect(wordErrorRate(SELF_CHECK_SENTENCE, SELF_CHECK_SENTENCE.toUpperCase()).wer).toBe(0);
  });
});

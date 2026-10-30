/**
 * Audio in/out for the built-in voice engine: WAV parse (8/16/24/32-bit PCM,
 * 32-bit float, any rate / channel count) → 16 kHz mono Float32 for Whisper,
 * and Float32 → 16-bit WAV / PCM for clients. Other containers (WebM, Ogg,
 * MP3) go through ffmpeg when it is installed.
 */

import { spawn } from "node:child_process";

export class UnsupportedAudioError extends Error {}

export function isWav(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WAVE"
  );
}

/** Decode a WAV file to mono Float32 at its own sample rate. */
export function decodeWav(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  if (!isWav(buf)) throw new UnsupportedAudioError("not a WAV file");
  let off = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      let format = buf.readUInt16LE(body);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24); // WAVE_FORMAT_EXTENSIBLE
      fmt = {
        format,
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new UnsupportedAudioError("WAV data before fmt");
      // Streaming writers leave 0 / 0xFFFFFFFF as the size: read to the end.
      if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      return { samples: toMono(buf.subarray(body, body + size), fmt), sampleRate: fmt.rate };
    }
    off = body + size + (size % 2);
  }
  throw new UnsupportedAudioError("WAV has no data chunk");
}

function toMono(data: Buffer, f: { format: number; channels: number; bits: number }): Float32Array {
  const bytes = f.bits / 8;
  const frame = bytes * f.channels;
  const n = Math.floor(data.length / frame);
  const out = new Float32Array(n);
  const read = (o: number): number => {
    if (f.format === 3 && f.bits === 32) return data.readFloatLE(o);
    if (f.format === 3 && f.bits === 64) return data.readDoubleLE(o);
    if (f.bits === 16) return data.readInt16LE(o) / 32768;
    if (f.bits === 8) return (data.readUInt8(o) - 128) / 128;
    if (f.bits === 24) return data.readIntLE(o, 3) / 8388608;
    if (f.bits === 32) return data.readInt32LE(o) / 2147483648;
    throw new UnsupportedAudioError(`unsupported WAV sample format (${f.format}/${f.bits}-bit)`);
  };
  if (f.format !== 1 && f.format !== 3)
    throw new UnsupportedAudioError(`unsupported WAV encoding ${f.format}`);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < f.channels; c++) s += read(i * frame + c * bytes);
    out[i] = s / f.channels;
  }
  return out;
}

/** Linear resample (fine for speech recognition input). */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const a = Math.floor(x);
    const b = Math.min(a + 1, samples.length - 1);
    out[i] = samples[a]! + (samples[b]! - samples[a]!) * (x - a);
  }
  return out;
}

export function pcm16(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    out.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), i * 2);
  }
  return out;
}

export function encodeWav16(samples: Float32Array, sampleRate: number): Buffer {
  const data = pcm16(samples);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Non-WAV input → 16 kHz mono Float32 via ffmpeg (when installed). */
export function decodeWithFfmpeg(
  buf: Buffer,
  ffmpeg = process.env.FFMPEG_PATH || "ffmpeg",
): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          "pipe:0",
          "-f",
          "f32le",
          "-ac",
          "1",
          "-ar",
          "16000",
          "pipe:1",
        ],
        {
          windowsHide: true,
        },
      );
    } catch {
      reject(new UnsupportedAudioError("Send WAV audio, or install ffmpeg for other formats."));
      return;
    }
    const chunks: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => (err += String(d)));
    child.on("error", () =>
      reject(new UnsupportedAudioError("Send WAV audio, or install ffmpeg for other formats.")),
    );
    child.on("close", (code) => {
      if (code !== 0)
        return reject(
          new UnsupportedAudioError(`could not decode audio: ${err.trim().slice(0, 200)}`),
        );
      const all = Buffer.concat(chunks);
      resolve(new Float32Array(all.buffer, all.byteOffset, Math.floor(all.length / 4)).slice());
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(buf);
  });
}

/** Any supported input → 16 kHz mono Float32. */
export async function toWhisperInput(buf: Buffer): Promise<Float32Array> {
  if (isWav(buf)) {
    const { samples, sampleRate } = decodeWav(buf);
    return resample(samples, sampleRate, 16000);
  }
  return decodeWithFfmpeg(buf);
}

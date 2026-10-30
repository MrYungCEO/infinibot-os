/**
 * `voice doctor` core — STT + TTS roundtrips with timings, reusable from the
 * CLI and from tests. No process.exit / console here; returns a report.
 */

import { loadVoiceConfigOrDefault, type VoiceConfig } from "./config.js";
import { makeToneWav } from "./audio.js";
import { createSttProvider, createTtsProvider } from "./providers/registry.js";
import { transcribeBuffer } from "./types.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  ms?: number;
  detail?: string;
  error?: string;
}

export interface DoctorReport {
  mode: VoiceConfig["mode"];
  sttProvider: string;
  ttsProvider: string;
  checks: DoctorCheck[];
  ok: boolean;
}

/** Drain a Readable to a Buffer (bounded by what TTS produces for 5 words). */
async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function runDoctor(
  cfg: VoiceConfig = loadVoiceConfigOrDefault(),
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // ── STT roundtrip — transcribe a 1s tone. Success = a 200 that returns a
  //    (possibly empty) transcript. We're proving the pipe, not accuracy.
  {
    const t0 = Date.now();
    try {
      const stt = createSttProvider(cfg.stt);
      const transcript = await transcribeBuffer(stt, makeToneWav(1), { encoding: "wav" });
      checks.push({
        name: `STT roundtrip (${cfg.stt.provider})`,
        ok: true,
        ms: Date.now() - t0,
        detail: transcript ? `transcript: "${transcript.slice(0, 60)}"` : "200 OK (empty for tone)",
      });
    } catch (err) {
      checks.push({
        name: `STT roundtrip (${cfg.stt.provider})`,
        ok: false,
        ms: Date.now() - t0,
        error: (err as Error).message,
      });
    }
  }

  // ── TTS roundtrip — synthesize a 5-word phrase, expect non-empty audio.
  {
    const t0 = Date.now();
    try {
      const tts = createTtsProvider(cfg.tts);
      const audio = await drain(await tts.synthesize("InfiniBot voice check one two"));
      const ok = audio.length > 0;
      checks.push({
        name: `TTS roundtrip (${cfg.tts.provider})`,
        ok,
        ms: Date.now() - t0,
        detail: `${audio.length} bytes of audio`,
        error: ok ? undefined : "received 0 bytes of audio",
      });
    } catch (err) {
      checks.push({
        name: `TTS roundtrip (${cfg.tts.provider})`,
        ok: false,
        ms: Date.now() - t0,
        error: (err as Error).message,
      });
    }
  }

  return {
    mode: cfg.mode,
    sttProvider: cfg.stt.provider,
    ttsProvider: cfg.tts.provider,
    checks,
    ok: checks.every((c) => c.ok),
  };
}

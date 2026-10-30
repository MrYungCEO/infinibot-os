#!/usr/bin/env -S node --import tsx
/**
 * Speech-to-text ACCURACY harness for the built-in voice engine (or anything
 * OpenAI-compatible: Speaches, the gateway's /api/voice/stt route).
 *
 * Sends known-transcript clips through the SAME HTTP endpoint the app uses, in
 * the audio formats the app actually produces, and scores word error rate
 * (WER) and real-time factor (RTF = inference time / audio length) per format.
 *
 *   node --import tsx scripts/voice/stt-accuracy.mts --url http://127.0.0.1:8886
 *   node --import tsx scripts/voice/stt-accuracy.mts --start-engine --models <dir> \
 *        --stt onnx-community/whisper-base [--backend native|wasm] [--max-wer 0.15]
 *   node --import tsx scripts/voice/stt-accuracy.mts --url http://127.0.0.1:18789 \
 *        --path /api/voice/stt --header "Authorization: Bearer …"
 *
 * Corpus: scripts/voice/fixtures/stt-corpus (LibriSpeech test-clean, CC BY 4.0,
 * 10 speakers) plus, with --tts-corpus, sentences synthesised by the engine's
 * own Kokoro TTS in four voices. Formats (needs ffmpeg on THIS machine):
 *   wav16   16 kHz mono int16 WAV   — what the browser mic paths send after clipToWav()
 *   vadf32  16 kHz mono float32 WAV — what the voice call's VAD (encodeWAV) sends
 *   wav44s  44.1 kHz stereo int16   — a desktop recorder's WAV
 *   webm48  48 kHz Opus in WebM     — raw MediaRecorder output (engine needs ffmpeg for it)
 *
 * Exits 1 when any format's corpus WER is above --max-wer (default 0.15) or a
 * request fails, so a release gate can run it as-is. --out writes JSON.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  corpusWer,
  wordErrorRate,
  type WerResult,
} from "../../src/gateway/voice/native-engine/wer.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

type Format = "wav16" | "vadf32" | "wav44s" | "webm48";
const ALL_FORMATS: Format[] = ["wav16", "vadf32", "wav44s", "webm48"];
const FFMPEG_ARGS: Record<Format, { ext: string; args: string[]; mime: string }> = {
  wav16: { ext: "wav", mime: "audio/wav", args: ["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"] },
  vadf32: {
    ext: "wav",
    mime: "audio/wav",
    args: ["-ar", "16000", "-ac", "1", "-c:a", "pcm_f32le"],
  },
  wav44s: {
    ext: "wav",
    mime: "audio/wav",
    args: ["-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le"],
  },
  webm48: {
    ext: "webm",
    mime: "audio/webm",
    args: ["-ar", "48000", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-f", "webm"],
  },
};

/** Sentences for the synthetic (Kokoro) part of the corpus. */
const TTS_SENTENCES = [
  "Please schedule a meeting with the design team for Thursday afternoon.",
  "What is the weather going to be like in London this weekend?",
  "Send a message to Sarah saying I will be ten minutes late.",
  "Open the project dashboard and show me the open tasks.",
  "The quick brown fox jumps over the lazy dog.",
  "Remind me to call the dentist tomorrow morning at nine.",
  "Summarize the last three emails from the marketing department.",
  "Turn the volume down and play some relaxing music.",
];
const TTS_VOICES = ["af_heart", "am_michael", "bf_emma", "bm_george"];

interface Args {
  url: string;
  path: string;
  headers: Record<string, string>;
  corpus: string;
  ttsCorpus: boolean;
  formats: Format[];
  maxWer: number;
  out: string;
  limit: number;
  label: string;
  startEngine: boolean;
  models: string;
  stt: string;
  backend: string;
  device: string;
  node: string;
  server: string;
  port: number;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string, d = ""): string => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d;
  };
  const all = (k: string): string[] =>
    argv.flatMap((a, i) => (a === `--${k}` && argv[i + 1] ? [argv[i + 1]!] : []));
  const has = (k: string) => argv.includes(`--${k}`);
  const headers: Record<string, string> = {};
  for (const h of all("header")) {
    const i = h.indexOf(":");
    if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  const port = Number(get("port", "18996"));
  return {
    url: get("url", has("start-engine") ? `http://127.0.0.1:${port}` : "http://127.0.0.1:8886"),
    path: get("path", "/v1/audio/transcriptions"),
    headers,
    corpus: get("corpus", path.join(here, "fixtures", "stt-corpus")),
    ttsCorpus: has("tts-corpus"),
    formats: (get("formats") ? get("formats").split(",") : ALL_FORMATS).filter((f): f is Format =>
      (ALL_FORMATS as string[]).includes(f),
    ),
    maxWer: Number(get("max-wer", "0.15")),
    out: get("out"),
    limit: Number(get("limit", "0")),
    label: get("label", ""),
    startEngine: has("start-engine"),
    models: get("models"),
    stt: get("stt", "onnx-community/whisper-base"),
    backend: get("backend", "auto"),
    device: get("device", "auto"),
    node: get("node", process.execPath),
    server: get("server", path.join(repo, "src/gateway/voice/native-engine/server.ts")),
    port,
    verbose: has("verbose"),
  };
}

interface Clip {
  id: string;
  text: string;
  /** Source audio (any format ffmpeg reads). */
  file: string;
  source: string;
  durationSec: number;
}

function ffmpeg(args: string[]): void {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  if (r.status !== 0)
    throw new Error(`ffmpeg ${args.join(" ")}: ${String(r.stderr).slice(0, 300)}`);
}

function durationSec(file: string): number {
  const r = spawnSync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    file,
  ]);
  return Number(String(r.stdout).trim()) || 0;
}

function loadCorpus(dir: string): Clip[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
    clips: { id: string; file: string; text: string; source?: string }[];
  };
  return manifest.clips.map((c) => {
    const file = path.join(dir, c.file);
    return {
      id: c.id,
      text: c.text,
      file,
      source: c.source ?? "corpus",
      durationSec: durationSec(file),
    };
  });
}

async function ttsCorpus(
  url: string,
  headers: Record<string, string>,
  work: string,
): Promise<Clip[]> {
  const out: Clip[] = [];
  let i = 0;
  for (const text of TTS_SENTENCES) {
    const voice = TTS_VOICES[i++ % TTS_VOICES.length]!;
    const r = await fetch(`${url}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ input: text, voice, response_format: "wav" }),
    });
    if (!r.ok) throw new Error(`TTS corpus: HTTP ${r.status} ${await r.text()}`);
    const file = path.join(work, `kokoro-${i}-${voice}.wav`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    out.push({
      id: `kokoro-${i}-${voice}`,
      text,
      file,
      source: `kokoro:${voice}`,
      durationSec: durationSec(file),
    });
  }
  return out;
}

async function waitHealthy(
  url: string,
  child: ChildProcess | null,
  ms = 10 * 60_000,
): Promise<unknown> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (child && child.exitCode !== null) throw new Error(`engine exited with ${child.exitCode}`);
    const j = await fetch(`${url}/health`)
      .then((r) => r.json())
      .catch(() => null);
    if (j && (j as { status?: string }).status === "ok") return j;
    if (j && (j as { status?: string }).status === "error")
      throw new Error(`engine failed: ${JSON.stringify(j)}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`engine at ${url} not healthy after ${ms} ms`);
}

interface Row {
  clip: string;
  source: string;
  format: Format;
  ref: string;
  hyp: string;
  status: number;
  error?: string;
  wer: WerResult;
  audioMs: number;
  inferMs: number;
  wallMs: number;
}

async function transcribe(
  a: Args,
  file: string,
  fmt: Format,
): Promise<{ status: number; text: string; error?: string; inferMs: number; wallMs: number }> {
  const spec = FFMPEG_ARGS[fmt];
  const fd = new FormData();
  fd.append("file", new Blob([fs.readFileSync(file)], { type: spec.mime }), `clip.${spec.ext}`);
  fd.append("model", "whisper-1");
  fd.append("response_format", "json");
  const t0 = Date.now();
  const r = await fetch(`${a.url}${a.path}`, { method: "POST", body: fd, headers: a.headers });
  const wallMs = Date.now() - t0;
  const body = await r.text();
  let j: { text?: string; error?: string } = {};
  try {
    j = JSON.parse(body);
  } catch {
    j = r.ok ? { text: body } : { error: body };
  }
  const inferMs = Number(r.headers.get("x-transcription-ms")) || wallMs;
  return {
    status: r.status,
    text: String(j.text ?? ""),
    error: r.ok ? undefined : String(j.error ?? body).slice(0, 200),
    inferMs,
    wallMs,
  };
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "stt-accuracy-"));
  let engine: ChildProcess | null = null;
  let health: unknown = null;
  try {
    if (a.startEngine) {
      if (!a.models) throw new Error("--start-engine needs --models <dir>");
      const isTs = a.server.endsWith(".ts");
      engine = spawn(
        a.node,
        [
          ...(isTs ? ["--import", "tsx"] : []),
          a.server,
          "--port",
          String(a.port),
          "--host",
          "127.0.0.1",
          "--models",
          a.models,
          "--stt",
          a.stt,
          "--backend",
          a.backend,
          "--device",
          a.device,
        ],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] },
      );
      engine.stdout?.on("data", (d) => a.verbose && process.stderr.write(String(d)));
      engine.stderr?.on("data", (d) => a.verbose && process.stderr.write(String(d)));
    }
    if (a.path.startsWith("/v1/") || a.startEngine) health = await waitHealthy(a.url, engine);

    const clips = loadCorpus(a.corpus);
    if (a.ttsCorpus) {
      // TTS lives on the engine (same base URL as /v1/audio/transcriptions).
      clips.push(...(await ttsCorpus(a.url.replace(/\/api\/voice.*$/, ""), a.headers, work)));
    }
    const use = a.limit > 0 ? clips.slice(0, a.limit) : clips;

    // Warm-up: the first request pays one-off graph setup and would skew RTF.
    {
      const w = path.join(work, "warm.wav");
      ffmpeg(["-i", use[0]!.file, ...FFMPEG_ARGS.wav16.args, w]);
      await transcribe(a, w, "wav16");
    }

    const rows: Row[] = [];
    for (const fmt of a.formats) {
      for (const c of use) {
        const spec = FFMPEG_ARGS[fmt];
        const f = path.join(work, `${c.id}.${fmt}.${spec.ext}`);
        ffmpeg(["-i", c.file, ...spec.args, f]);
        const r = await transcribe(a, f, fmt);
        const row: Row = {
          clip: c.id,
          source: c.source,
          format: fmt,
          ref: c.text,
          hyp: r.text,
          status: r.status,
          error: r.error,
          wer: r.error ? wordErrorRate(c.text, "") : wordErrorRate(c.text, r.text),
          audioMs: Math.round(c.durationSec * 1000),
          inferMs: r.inferMs,
          wallMs: r.wallMs,
        };
        rows.push(row);
        if (a.verbose)
          process.stderr.write(
            `${fmt} ${c.id} wer=${row.wer.wer.toFixed(2)} ${r.status} "${r.text || r.error}"\n`,
          );
      }
    }

    const summary = a.formats.map((fmt) => {
      const rs = rows.filter((r) => r.format === fmt);
      const audio = rs.reduce((n, r) => n + r.audioMs, 0);
      const infer = rs.reduce((n, r) => n + r.inferMs, 0);
      const wall = rs.reduce((n, r) => n + r.wallMs, 0);
      return {
        format: fmt,
        clips: rs.length,
        failed: rs.filter((r) => r.error).length,
        wer: corpusWer(rs.map((r) => r.wer)),
        rtf: audio ? infer / audio : 0,
        rtfWall: audio ? wall / audio : 0,
        firstError: rs.find((r) => r.error)?.error,
      };
    });

    const h = (health ?? {}) as Record<string, unknown>;
    const label =
      a.label ||
      `${h.sttModel ?? a.stt} backend=${h.backend ?? "?"} device=${h.sttDevice ?? "?"} via ${a.path}`;
    console.log(`\nSTT accuracy — ${label}`);
    console.log(
      `clips: ${use.length} (${use.reduce((n, c) => n + c.durationSec, 0).toFixed(1)} s audio)`,
    );
    console.log("format   clips  failed   WER      RTF(infer)  RTF(wall)");
    for (const s of summary)
      console.log(
        `${s.format.padEnd(8)} ${String(s.clips).padStart(5)}  ${String(s.failed).padStart(6)}   ${(s.wer * 100).toFixed(1).padStart(5)}%   ${s.rtf.toFixed(3).padStart(8)}   ${s.rtfWall.toFixed(3).padStart(8)}${s.firstError ? `   ${s.firstError}` : ""}`,
      );
    const worst = [...rows].sort((x, y) => y.wer.wer - x.wer.wer).slice(0, 3);
    for (const w of worst)
      if (w.wer.wer > 0)
        console.log(
          `  worst ${w.format} ${w.clip} ${(w.wer.wer * 100).toFixed(0)}%: "${w.hyp || w.error}"`,
        );

    if (a.out)
      fs.writeFileSync(
        a.out,
        JSON.stringify({ label, health, maxWer: a.maxWer, summary, rows }, null, 2),
      );
    const bad = summary.filter((s) => s.wer > a.maxWer || s.failed > 0);
    if (bad.length) {
      console.log(
        `FAIL: ${bad.map((b) => `${b.format} WER ${(b.wer * 100).toFixed(1)}%${b.failed ? ` (${b.failed} failed)` : ""}`).join(", ")} — limit ${(a.maxWer * 100).toFixed(0)}%`,
      );
      process.exitCode = 1;
    } else console.log(`PASS: every format at or under ${(a.maxWer * 100).toFixed(0)}% WER`);
  } finally {
    engine?.kill();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(`stt-accuracy: ${String((err as Error)?.stack ?? err)}`);
  process.exit(2);
});

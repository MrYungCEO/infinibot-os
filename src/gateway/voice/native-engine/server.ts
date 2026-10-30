/**
 * InfiniBot's built-in voice engine — a small local HTTP server, run as a
 * supervised child of the gateway (supervisor.ts). No Docker, no admin rights.
 *
 *   TTS  Kokoro-82M (kokoro-js, ONNX q8)            POST /v1/audio/speech
 *   STT  Whisper base/small (transformers.js, ONNX)  POST /v1/audio/transcriptions
 *        GET /health · GET /v1/models · GET /v1/audio/voices
 *
 * Same request/response shapes as Kokoro-FastAPI and Speaches, so the gateway's
 * voice routes, the LiveKit agent and anything else pointed at a Speaches /
 * Kokoro URL work unchanged. Models load offline from --models (downloaded by
 * the one-click setup); nothing is fetched at runtime.
 *
 *   node server.js --port 8886 --models <dir> --stt onnx-community/whisper-base [--host 127.0.0.1]
 *                  [--backend auto|native|wasm]
 *
 * --backend auto (default) uses the native ONNX runtime when it loads and the
 * WebAssembly runtime when it doesn't (backend.ts). /health reports which.
 */

import * as http from "node:http";
import * as os from "node:os";

import {
  chooseBackend,
  installWasmOnnx,
  parseBackendPref,
  preferBundledDlls,
  probeNativeOnnx,
  type BackendPref,
  type OnnxBackend,
} from "./backend.js";
import { SELF_CHECK_MAX_WER, SELF_CHECK_SENTENCE, sttDevicePlan } from "./stt-device.js";
import { encodeWav16, pcm16, resample, toWhisperInput, UnsupportedAudioError } from "./wav.js";
import { wordErrorRate } from "./wer.js";

interface Args {
  port: number;
  host: string;
  models: string;
  stt: string;
  device: string;
  backend: BackendPref;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string, d = "") => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
  };
  return {
    port: Number(get("port", "8886")),
    host: get("host", "127.0.0.1"),
    models: get("models"),
    stt: get("stt", "onnx-community/whisper-base"),
    device: get("device", "auto"),
    backend: parseBackendPref(get("backend", "auto")),
  };
}

const KOKORO_REPO = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DEFAULT_VOICE = "af_heart";
/** OpenAI voice names → Kokoro voices (same idea as Kokoro-FastAPI's mapping). */
const VOICE_ALIASES: Record<string, string> = {
  alloy: "am_adam",
  ash: "af_nicole",
  coral: "bf_emma",
  echo: "af_bella",
  fable: "af_sarah",
  onyx: "bm_george",
  nova: "bf_isabella",
  sage: "am_michael",
  shimmer: "af_sky",
};

const state = {
  ttsReady: false,
  sttReady: false,
  sttDevice: "cpu",
  error: null as string | null,
  backend: null as OnnxBackend | null,
  backendReason: "",
  startedAt: Date.now(),
  loadMs: { tts: 0, stt: 0 },
  /** Last speech-recognition self-check (the one the chosen device passed). */
  sttCheck: null as { device: string; wer: number; text: string; ms: number } | null,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tts: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let asr: any = null;
let voices: string[] = [];

/** One inference at a time per model: keeps memory flat and latency predictable. */
function queue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}
const ttsQueue = queue();
const sttQueue = queue();

function log(msg: string): void {
  process.stdout.write(`[voice-engine] ${msg}\n`);
}

async function load(args: Args): Promise<void> {
  // Pick the ONNX runtime before transformers.js is imported (it binds to one at import).
  preferBundledDlls();
  const choice = chooseBackend(args.backend, () => probeNativeOnnx());
  if (choice.detail) log(`native onnxruntime unavailable: ${choice.detail}`);
  if (choice.backend === "wasm") {
    const threads = Math.max(1, Math.min(4, Math.ceil(os.cpus().length / 2)));
    const w = await installWasmOnnx({ threads });
    log(`using the WebAssembly runtime ${w.version} (${w.threads} threads): ${choice.reason}`);
  } else log(`using the native onnxruntime`);
  state.backend = choice.backend;
  state.backendReason = choice.reason;
  const wasm = choice.backend === "wasm";

  const tf = await import("@huggingface/transformers");
  tf.env.allowRemoteModels = false;
  tf.env.allowLocalModels = true;
  tf.env.localModelPath = args.models.endsWith("/") ? args.models : `${args.models}/`;
  tf.env.cacheDir = args.models;

  const t0 = Date.now();
  const { KokoroTTS } = await import("kokoro-js");
  // On wasm, "cpu" maps to onnxruntime-web's WebAssembly backend.
  tts = await KokoroTTS.from_pretrained(KOKORO_REPO, { dtype: "q8", device: "cpu" });
  try {
    voices = Object.keys((tts as { voices?: Record<string, unknown> }).voices ?? {});
  } catch {
    voices = [];
  }
  state.ttsReady = true;
  state.loadMs.tts = Date.now() - t0;
  log(`kokoro ready in ${state.loadMs.tts} ms (${voices.length} voices)`);

  const t1 = Date.now();
  const opts = { dtype: { encoder_model: "q8", decoder_model_merged: "q8" } };
  const failures: string[] = [];
  for (const c of sttDevicePlan({
    device: args.device,
    wasm,
    platform: process.platform,
    arch: process.arch,
  })) {
    let candidate: typeof asr = null;
    try {
      candidate = await tf.pipeline("automatic-speech-recognition", args.stt, {
        ...opts,
        device: c.device,
      } as never);
      // Loading is not proof: a GPU path can load and still transcribe garbage.
      const check = await selfCheck(candidate);
      state.sttCheck = { device: c.label, ...check };
      if (check.wer <= SELF_CHECK_MAX_WER) {
        asr = candidate;
        state.sttDevice = c.label;
        log(
          `whisper self-check on ${c.label}: ${Math.round(check.wer * 100)}% word errors in ${check.ms} ms ("${check.text}")`,
        );
        break;
      }
      failures.push(
        `${c.label}: ${Math.round(check.wer * 100)}% word errors ("${check.text.slice(0, 80)}")`,
      );
      log(`whisper on ${c.label} failed its self-check: ${failures.at(-1)}`);
    } catch (err) {
      failures.push(`${c.label}: ${String(err).slice(0, 160)}`);
      log(`whisper on ${c.label} unavailable (${String(err).slice(0, 160)})`);
    }
    try {
      await candidate?.dispose?.();
    } catch {
      /* already unusable */
    }
  }
  if (!asr) throw new Error(`speech recognition failed its self-check — ${failures.join("; ")}`);
  state.sttReady = true;
  state.loadMs.stt = Date.now() - t1;
  log(`whisper (${args.stt}) ready on ${state.sttDevice} in ${state.loadMs.stt} ms`);
}

/** Kokoro says a known sentence; Whisper must hear it back (see stt-device.ts). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function selfCheck(pipe: any): Promise<{ wer: number; text: string; ms: number }> {
  const audio = await tts.generate(SELF_CHECK_SENTENCE, { voice: DEFAULT_VOICE });
  const samples = resample(audio.audio as Float32Array, audio.sampling_rate ?? 24000, 16000);
  const t0 = Date.now();
  // Bounded: a broken device loops on garbage until the token limit.
  const res = await pipe(samples, { task: "transcribe", language: "en", max_new_tokens: 48 });
  const text = String((Array.isArray(res) ? res[0]?.text : res?.text) ?? "").trim();
  return { wer: wordErrorRate(SELF_CHECK_SENTENCE, text).wer, text, ms: Date.now() - t0 };
}

function pickVoice(v: unknown): string {
  const name = typeof v === "string" ? v.trim() : "";
  const mapped = VOICE_ALIASES[name.toLowerCase()] ?? name;
  if (mapped && (voices.length === 0 || voices.includes(mapped))) return mapped;
  return DEFAULT_VOICE;
}

/** Kokoro handles ~500 tokens per call: split long text on sentence ends. */
export function splitText(text: string, max = 280): string[] {
  const parts = text
    .replace(/\s+/g, " ")
    .trim()
    .match(/[^.!?。！？]+[.!?。！？]*\s*/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + p).length > max && cur) {
      out.push(cur.trim());
      cur = "";
    }
    if (p.length > max) {
      for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max).trim());
    } else cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

async function synthesize(
  text: string,
  voice: string,
  speed: number,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  return ttsQueue(async () => {
    const chunks: Float32Array[] = [];
    let sampleRate = 24000;
    for (const piece of splitText(text)) {
      const audio = await tts.generate(piece, { voice, speed });
      sampleRate = audio.sampling_rate ?? sampleRate;
      chunks.push(audio.audio as Float32Array);
    }
    const len = chunks.reduce((n, c) => n + c.length, 0);
    const samples = new Float32Array(len);
    let o = 0;
    for (const c of chunks) {
      samples.set(c, o);
      o += c.length;
    }
    return { samples, sampleRate };
  });
}

async function transcribe(audio: Float32Array, language?: string): Promise<string> {
  return sttQueue(async () => {
    const opts: Record<string, unknown> = { task: "transcribe" };
    if (language) opts.language = language;
    if (audio.length > 16000 * 30) {
      opts.chunk_length_s = 30;
      opts.stride_length_s = 5;
    }
    const res = await asr(audio, opts);
    return String((Array.isArray(res) ? res[0]?.text : res?.text) ?? "").trim();
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, limit = 100 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new Error("request too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

function ready(): boolean {
  return state.ttsReady && state.sttReady;
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  args: Args,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://local");
  const p = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && (p === "/health" || p === "/")) {
    return json(res, ready() ? 200 : 503, {
      engine: "infinibot-voice",
      status: state.error ? "error" : ready() ? "ok" : "loading",
      backend: state.backend,
      backendReason: state.backendReason,
      tts: state.ttsReady,
      stt: state.sttReady,
      sttModel: args.stt,
      sttDevice: state.sttDevice,
      sttCheck: state.sttCheck,
      loadMs: state.loadMs,
      error: state.error,
      uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
      pid: process.pid,
    });
  }
  if (req.method === "GET" && p === "/v1/models") {
    if (!ready()) return json(res, 503, { error: "loading" });
    const now = Math.floor(state.startedAt / 1000);
    return json(res, 200, {
      object: "list",
      data: [
        { id: "kokoro", object: "model", created: now, owned_by: "infinibot" },
        { id: args.stt, object: "model", created: now, owned_by: "infinibot" },
        { id: "whisper-1", object: "model", created: now, owned_by: "infinibot" },
      ],
    });
  }
  if (req.method === "GET" && p === "/v1/audio/voices") {
    if (!state.ttsReady) return json(res, 503, { error: "loading" });
    return json(res, 200, { voices });
  }
  if (req.method === "POST" && p === "/v1/audio/speech") {
    if (!state.ttsReady) return json(res, 503, { error: "voice engine is still loading" });
    let body: Record<string, unknown>;
    try {
      body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch {
      return json(res, 400, { error: "expected JSON { input, voice }" });
    }
    const input = typeof body.input === "string" ? body.input.trim() : "";
    if (!input) return json(res, 400, { error: "input is required" });
    const speed =
      typeof body.speed === "number" && body.speed > 0.25 && body.speed < 4 ? body.speed : 1;
    const t0 = Date.now();
    const { samples, sampleRate } = await synthesize(input, pickVoice(body.voice), speed);
    const format = String(body.response_format ?? "wav").toLowerCase();
    res.setHeader("X-Synthesis-Ms", String(Date.now() - t0));
    if (format === "pcm") {
      // OpenAI "pcm": raw 24 kHz 16-bit mono little-endian.
      res.writeHead(200, { "Content-Type": "audio/pcm" });
      return void res.end(
        pcm16(sampleRate === 24000 ? samples : resample(samples, sampleRate, 24000)),
      );
    }
    // wav for everything else (mp3/opus requests included): every player handles it.
    res.writeHead(200, { "Content-Type": "audio/wav" });
    return void res.end(encodeWav16(samples, sampleRate));
  }
  if (req.method === "POST" && p === "/v1/audio/transcriptions") {
    if (!state.sttReady) return json(res, 503, { error: "voice engine is still loading" });
    const raw = await readBody(req);
    const ct = req.headers["content-type"] ?? "";
    let audio: Buffer;
    let language: string | undefined;
    let format = "json";
    if (ct.includes("multipart/form-data")) {
      const fd = await new Request("http://local/", {
        method: "POST",
        headers: { "content-type": ct },
        body: new Uint8Array(raw),
      }).formData();
      const file = fd.get("file");
      if (!file || typeof file === "string")
        return json(res, 400, { error: "multipart field `file` is required" });
      audio = Buffer.from(await (file as Blob).arrayBuffer());
      const lang = fd.get("language");
      if (typeof lang === "string" && lang.trim()) language = lang.trim();
      const rf = fd.get("response_format");
      if (typeof rf === "string" && rf) format = rf;
    } else {
      audio = raw;
    }
    let samples: Float32Array;
    try {
      samples = await toWhisperInput(audio);
    } catch (err) {
      if (err instanceof UnsupportedAudioError) return json(res, 415, { error: err.message });
      throw err;
    }
    const t0 = Date.now();
    const text = await transcribe(samples, language);
    res.setHeader("X-Transcription-Ms", String(Date.now() - t0));
    if (format === "text") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return void res.end(text);
    }
    return json(res, 200, { text });
  }
  return json(res, 404, { error: `not found: ${req.method} ${p}` });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (!args.models) {
    log("--models <dir> is required");
    process.exit(2);
  }
  const server = http.createServer((req, res) => {
    handle(req, res, args).catch((err: unknown) => {
      log(`request failed: ${String(err)}`);
      if (!res.headersSent) json(res, 500, { error: String((err as Error)?.message ?? err) });
      else res.end();
    });
  });
  // Listen first so the supervisor sees "loading" while models load.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, args.host, () => resolve());
  });
  log(`listening on http://${args.host}:${args.port} (pid ${process.pid})`);
  // Die with the gateway: the IPC channel closes when the parent goes away.
  process.on("disconnect", () => process.exit(0));
  try {
    await load(args);
    process.send?.({
      type: "ready",
      loadMs: state.loadMs,
      sttDevice: state.sttDevice,
      backend: state.backend,
      backendReason: state.backendReason,
    });
  } catch (err) {
    state.error = String((err as Error)?.message ?? err);
    log(`failed to load models: ${state.error}`);
    // The supervisor retries a native failure once on the WebAssembly runtime.
    process.send?.({ type: "error", error: state.error, backend: state.backend });
    // Free the port now: a process stuck in exit must not block the next engine.
    server.close();
    setTimeout(() => hardExit(3), 200);
  }
}

/**
 * Exit without running DLL detach code. After a native runtime failed inside
 * DllMain, a normal exit can hang in the loader on Windows and keep the
 * process (and its port) alive; TerminateProcess skips that.
 */
function hardExit(code: number): void {
  if (process.platform === "win32") {
    try {
      process.kill(process.pid, "SIGKILL");
    } catch {
      /* fall through */
    }
  }
  process.exit(code);
}

// Run when executed directly (node server.js …), not when imported by tests.
const invoked = process.argv[1] ?? "";
if (/native-engine[\\/]server\.(js|ts|mjs)$/.test(invoked)) void main();

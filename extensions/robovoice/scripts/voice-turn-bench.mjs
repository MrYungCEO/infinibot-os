#!/usr/bin/env node
/**
 * One voice turn, timed end to end, the way a Robovoice voice agent runs it:
 *
 *   spoken WAV → STT (Speaches) → InfiniBot voice-LLM callback (SSE, the same
 *   scoped route Robovoice calls) → first complete sentence → TTS (Kokoro,
 *   streamed PCM) → first audio byte
 *
 * Reports where the time went and proves audio was really produced (RMS energy
 * of the PCM the TTS returned; a silent or empty buffer fails the run).
 *
 *   node voice-turn-bench.mjs --callback http://127.0.0.1:19071/plugins/robovoice/voice-llm/v1 \
 *     --token rvllm_… --agent main --label after --runs 3 \
 *     --say "Hey, how are you doing today?" [--say "…second turn of the same call…"]
 *
 * Options: --stt http://127.0.0.1:8002 --stt-model Systran/faster-whisper-medium
 *          --tts http://127.0.0.1:8882 --voice am_puck --out <dir> --json <file>
 * Every --say is one turn of the SAME call (history is sent like Robovoice does).
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const all = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));

const CALLBACK = opt("callback");
const TOKEN = opt("token");
const AGENT = opt("agent", "main");
const LABEL = opt("label", "run");
const RUNS = Number(opt("runs", "1"));
const STT = opt("stt", "http://127.0.0.1:8002");
const STT_MODEL = opt("stt-model", "Systran/faster-whisper-medium");
const TTS = opt("tts", "http://127.0.0.1:8882");
const VOICE = opt("voice", "am_puck");
const OUT = opt("out", "/tmp/ibvf/bench");
const SAYS = all("say").length ? all("say") : ["Hey, how are you doing today?"];
// Robovoice vouches for a signed-in caller this way (owner when on the owner list).
const CALLER_EMAIL = opt("caller-email");
// --expect-tool <name>[|<name>…]: fail unless a turn's full agent called that tool (or one of the alternatives).
// --no-refusals: fail when any spoken reply is a refusal.
const EXPECT_TOOLS = all("expect-tool");
const NO_REFUSALS = args.includes("--no-refusals");
const REFUSAL = /\b(i'?m sorry,? but|i can(?:'t|not| not)|i(?:'m| am) (?:unable|not able)|can'?t (?:share|discuss|do that))/i;
const SILENCE_RMS = 200; // int16; real speech from Kokoro is in the thousands

if (!CALLBACK || !TOKEN) {
  console.error("need --callback <voice-llm base url> and --token <rvllm_…>");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const SENTENCE_END = /[.!?…。！？](?:["')\]]*)(?:\s|$)|\n/;

async function tts(text, format) {
  const t0 = performance.now();
  const res = await fetch(`${TTS}/v1/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "kokoro", voice: VOICE, input: text, response_format: format, stream: true }),
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let firstByteMs = null;
  const chunks = [];
  for await (const c of res.body) {
    if (firstByteMs === null && c.length) firstByteMs = performance.now() - t0;
    chunks.push(Buffer.from(c));
  }
  return { firstByteMs, totalMs: performance.now() - t0, audio: Buffer.concat(chunks) };
}

/** RMS + peak of 16-bit little-endian PCM. */
function energy(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return { samples: 0, rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  return { samples: n, rms: Math.round(Math.sqrt(sum / n)), peak };
}

function wavOf(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function stt(wav) {
  const t0 = performance.now();
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
  form.append("model", STT_MODEL);
  form.append("language", "en");
  const res = await fetch(`${STT}/v1/audio/transcriptions`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`STT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = String((await res.json()).text ?? "").trim();
  return { text, ms: performance.now() - t0 };
}

/** The callback, streamed: first token, first sentence, full text, gateway-side timing. */
async function llm(messages, room) {
  const t0 = performance.now();
  const res = await fetch(`${CALLBACK}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      model: `infinibot:${AGENT}`,
      stream: true,
      messages,
      user: room,
      ...(CALLER_EMAIL ? { metadata: { room, caller: { email: CALLER_EMAIL, verified: true } } } : {}),
    }),
  });
  if (!res.ok) throw new Error(`voice-LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  let buf = "";
  let text = "";
  let firstTokenMs = null;
  let firstSentenceMs = null;
  let firstSentence = "";
  let gateway = null;
  let onSentence;
  const sentenceReady = new Promise((r) => (onSentence = r));
  const done = (async () => {
    const dec = new TextDecoder();
    for await (const c of res.body) {
      buf += dec.decode(c, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 2);
        if (!line.startsWith("data:") || line.endsWith("[DONE]")) continue;
        const o = JSON.parse(line.slice(5));
        if (o.infinibot) gateway = o.infinibot;
        const d = o.choices?.[0]?.delta?.content;
        if (!d) continue;
        if (firstTokenMs === null) firstTokenMs = performance.now() - t0;
        text += d;
        if (firstSentenceMs === null) {
          const m = SENTENCE_END.exec(text);
          if (m) {
            firstSentenceMs = performance.now() - t0;
            firstSentence = text.slice(0, m.index + 1).trim();
            onSentence();
          }
        }
      }
    }
    if (firstSentenceMs === null) {
      firstSentenceMs = performance.now() - t0;
      firstSentence = text.trim();
      onSentence();
    }
    return { totalMs: performance.now() - t0 };
  })();
  return { sentenceReady, done, get: () => ({ text, firstTokenMs, firstSentenceMs, firstSentence, gateway }) };
}

const r = (v) => (typeof v === "number" ? Math.round(v) : null);
const rows = [];

// The caller's utterances as audio (made once; STT is timed on every run).
const utterances = [];
for (const say of SAYS) utterances.push((await tts(say, "wav")).audio);

for (let run = 1; run <= RUNS; run++) {
  const room = `bench-${LABEL}-${Date.now()}-${run}`;
  const messages = [];
  for (let turn = 0; turn < SAYS.length; turn++) {
    const t0 = performance.now();
    const heard = await stt(utterances[turn]);
    messages.push({ role: "user", content: heard.text });
    const stream = await llm(messages, room);
    await stream.sentenceReady;
    const s = stream.get();
    const sentenceAt = performance.now() - t0;
    let speech = null;
    let ttsError = null;
    if (s.firstSentence) {
      try {
        speech = await tts(s.firstSentence, "pcm");
      } catch (err) {
        ttsError = err.message;
      }
    }
    const { totalMs } = await stream.done;
    const full = stream.get();
    messages.push({ role: "assistant", content: full.text });
    const e = speech ? energy(speech.audio) : { samples: 0, rms: 0, peak: 0 };
    const file = path.join(OUT, `${LABEL}-run${run}-turn${turn + 1}.wav`);
    if (speech) fs.writeFileSync(file, wavOf(speech.audio));
    const row = {
      label: LABEL,
      run,
      turn: turn + 1,
      said: SAYS[turn],
      heard: heard.text,
      reply: full.text.trim(),
      path: full.gateway?.path ?? null,
      model: full.gateway?.model ?? null,
      trust: full.gateway?.trust ?? null,
      routeReason: full.gateway?.route_reason ?? null,
      toolCalls: full.gateway?.tool_calls ?? [],
      refusal: REFUSAL.test(full.text),
      sttMs: r(heard.ms),
      llmPrepMs: full.gateway?.prep_ms ?? null,
      llmFirstTokenMs: r(s.firstTokenMs),
      llmFirstSentenceMs: r(s.firstSentenceMs),
      llmTotalMs: r(totalMs),
      ttsFirstByteMs: r(speech?.firstByteMs),
      // user stopped speaking → first audio byte of the reply
      firstAudioMs: speech ? r(sentenceAt + speech.firstByteMs) : null,
      audioSamples: e.samples,
      audioSeconds: Number((e.samples / 24000).toFixed(2)),
      audioRms: e.rms,
      audioPeak: e.peak,
      audible: e.rms >= SILENCE_RMS,
      wav: speech ? file : null,
      ttsError,
    };
    rows.push(row);
    console.log(
      `${LABEL} run ${run} turn ${row.turn} path=${row.path ?? "?"} | stt ${row.sttMs} | llm first-token ${row.llmFirstTokenMs} first-sentence ${row.llmFirstSentenceMs} total ${row.llmTotalMs} | tts first-byte ${row.ttsFirstByteMs} | FIRST AUDIO ${row.firstAudioMs} ms | audio ${row.audioSeconds}s rms ${row.audioRms} ${row.audible ? "AUDIBLE" : "SILENT"} | "${row.reply.slice(0, 70)}"`,
    );
    console.log(
      `   heard "${row.heard}" → (${row.trust}) route "${row.routeReason ?? "?"}" tools [${row.toolCalls.join(",")}]${row.refusal ? " REFUSAL SPOKEN" : ""} | reply "${row.reply.slice(0, 300)}"`,
    );
  }
}

const med = (xs) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
const summary = {
  label: LABEL,
  turns: rows.length,
  median: {
    sttMs: med(rows.map((x) => x.sttMs)),
    llmFirstTokenMs: med(rows.map((x) => x.llmFirstTokenMs)),
    llmFirstSentenceMs: med(rows.map((x) => x.llmFirstSentenceMs)),
    ttsFirstByteMs: med(rows.map((x) => x.ttsFirstByteMs)),
    firstAudioMs: med(rows.map((x) => x.firstAudioMs)),
  },
  allAudible: rows.every((x) => x.audible),
  refusals: rows.filter((x) => x.refusal).length,
  toolsCalled: [...new Set(rows.flatMap((x) => x.toolCalls))],
};
// "a|b|c" = any one of them (models pick different spawn tools for the same request).
const missingTools = EXPECT_TOOLS.filter((t) => !t.split("|").some((alt) => summary.toolsCalled.includes(alt)));
if (missingTools.length) console.log(`FAIL expected tool call(s) not made: ${missingTools.join(", ")}`);
if (NO_REFUSALS && summary.refusals) console.log(`FAIL ${summary.refusals} spoken refusal(s)`);
console.log(`SUMMARY ${JSON.stringify(summary)}`);
const jsonOut = opt("json");
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ summary, rows }, null, 1));
process.exit(summary.allAudible && !missingTools.length && !(NO_REFUSALS && summary.refusals) ? 0 : 1);

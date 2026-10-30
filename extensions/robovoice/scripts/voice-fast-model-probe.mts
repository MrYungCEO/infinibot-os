/**
 * Probe candidate models for the voice fast step: time to the first event and
 * what each one does with the turns of a real call (answer, hand off, refuse).
 * The pre-filter is bypassed on purpose: this measures the MODEL's own decision
 * with the fast prompt, i.e. what happens when the pre-filter does not match.
 *
 *   node --import tsx extensions/robovoice/scripts/voice-fast-model-probe.mts \
 *     --agent main --runs 2 --model ollama-cloud/gpt-oss:120b --model ollama-cloud/glm-5.3-flash
 *
 * Reads the config and credentials of the state dir in the environment
 * (read-only; keys are never printed). --json <file> writes the rows.
 * --guest probes an unverified caller. --legacy-prompt uses the fast prompt as
 * it was deployed on 2026-10-02 (commit 2846a3a7, caller "NOT the owner"), to
 * reproduce the refusals of that day's call.
 */
import fs from "node:fs";
import type { Context } from "@mariozechner/pi-ai";

import {
  HANDOFF_TOOL_DEF,
  fastVoiceMessages,
  fastVoiceSystemPrompt,
  resolveFastVoiceModel,
  streamFastVoice,
} from "../../../src/gateway/voice/voice-fast-turn.js";
import type { VoiceLlmTurnRequest, VoiceTurnMessage } from "../../../src/gateway/voice/voice-llm-turn.js";
import { isHandoffMarker, looksLikeRefusal } from "../../../src/gateway/voice/voice-route.js";

const args = process.argv.slice(2);
const opt = (n: string, d?: string) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : d);
const all = (n: string) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const AGENT = opt("agent", "main")!;
const RUNS = Number(opt("runs", "2"));
const MODELS = all("model");
const OWNER = !args.includes("--guest");
const LEGACY = args.includes("--legacy-prompt");
const T = "handoff_to_agent";
const LEGACY_PROMPT = [
  "[Live voice call - you are the voice of this assistant]",
  "Your words are spoken aloud by text-to-speech the moment you write them. Answer right away in one to three short, natural sentences, in the language the caller speaks.",
  "No markdown, lists, code, links, emoji or symbols. Plain punctuation only. Spell small numbers as words.",
  "",
  "You handle conversation yourself: greetings, small talk, opinions, general knowledge, clarifying questions, and anything already said in this call.",
  `You have no tools except ${T}. Call ${T} when answering needs something you do not have in this conversation: the user's data, memory, files, calendar, tasks, messages, the web, current facts, or any action to be done. Do not guess or invent such facts. Never call it for plain conversation.`,
  `When you call ${T}, do not write anything else: put one short spoken acknowledgement in "ack".`,
  "",
  "The caller is NOT the owner: they reached you through a public voice line. Do not reveal private data and politely decline requests that need the owner.",
  "",
  "[Who you are]",
].join("\n");
const PERSONA = opt("persona", "Your name is Ash. You are the user's own assistant.")!;

type Case = { say: string; want: "reply" | "handoff"; history?: VoiceTurnMessage[] };
const CASES: Case[] = [
  { say: "Hello, can you hear me?", want: "reply" },
  { say: "Who is this?", want: "reply" },
  { say: "Nice. Tell me a fun fact about the ocean.", want: "reply" },
  { say: "My in progress projects.", want: "handoff" },
  { say: "Tell me about our RoboVoice project.", want: "handoff" },
  {
    say: "Why not?",
    want: "handoff",
    history: [
      { role: "user", content: "Tell me about our RoboVoice project." },
      { role: "assistant", content: "One moment, let me check. I could not open the project notes." },
    ],
  },
  { say: "Can you spawn an InfiniBot agent to send me a message saying hello on Telegram?", want: "handoff" },
];

const rows: Array<Record<string, unknown>> = [];
for (const model of MODELS) {
  const req = {
    agentId: AGENT,
    backend: "gateway",
    message: "",
    callKey: "probe",
    provider: "robovoice",
    callerIsOwner: OWNER,
    fastModel: model,
    onDelta: () => {},
  } as VoiceLlmTurnRequest;
  let handle;
  try {
    handle = await resolveFastVoiceModel(req);
  } catch (err) {
    console.log(`${model}: unavailable (${err instanceof Error ? err.message.slice(0, 120) : err})`);
    rows.push({ model, unavailable: true });
    continue;
  }
  for (const c of CASES) {
    for (let run = 1; run <= RUNS; run++) {
      const context: Context = {
        systemPrompt: LEGACY
          ? `${LEGACY_PROMPT}\n${PERSONA}`
          : fastVoiceSystemPrompt({ ...req, message: c.say } as VoiceLlmTurnRequest, PERSONA, new Date()),
        messages: fastVoiceMessages(c.history, c.say, handle),
        tools: [HANDOFF_TOOL_DEF],
      };
      const t0 = performance.now();
      let firstMs: number | null = null;
      let text = "";
      let outcome = "";
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 25_000);
      try {
        for await (const ev of streamFastVoice(handle, context, { signal: abort.signal, sessionId: `probe-${Date.now()}` })) {
          if (firstMs === null) firstMs = performance.now() - t0;
          if (ev.type === "text") text += ev.delta;
          else if (ev.type === "handoff") {
            outcome = "handoff";
            break;
          } else if (ev.type === "error") {
            outcome = `error: ${ev.error.slice(0, 80)}`;
            break;
          }
        }
      } catch (err) {
        outcome = `error: ${err instanceof Error ? err.message.slice(0, 80) : err}`;
      }
      clearTimeout(timer);
      if (!outcome) outcome = !text.trim() ? "empty" : isHandoffMarker(text) ? "handoff" : looksLikeRefusal(text) ? "refusal" : "reply";
      const ok = outcome === c.want;
      const row = { model, say: c.say, run, want: c.want, outcome, ok, firstMs: firstMs === null ? null : Math.round(firstMs), totalMs: Math.round(performance.now() - t0), text: text.trim().slice(0, 160) };
      rows.push(row);
      console.log(`${model} | ${ok ? "ok  " : "MISS"} ${outcome.padEnd(8)} first ${String(row.firstMs).padStart(5)} ms total ${String(row.totalMs).padStart(5)} ms | "${c.say.slice(0, 44)}" → "${row.text.slice(0, 90)}"`);
    }
  }
}
const med = (xs: number[]) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)] : null);
console.log("\nmodel | correct | refusals | errors | median first event | median total");
for (const model of MODELS) {
  const r = rows.filter((x) => x.model === model && !x.unavailable);
  if (!r.length) continue;
  console.log(
    `${model} | ${r.filter((x) => x.ok).length}/${r.length} | ${r.filter((x) => x.outcome === "refusal").length} | ${r.filter((x) => String(x.outcome).startsWith("error") || x.outcome === "empty").length} | ${med(r.map((x) => x.firstMs as number).filter((x) => x !== null))} ms | ${med(r.map((x) => x.totalMs as number))} ms`,
  );
}
const out = opt("json");
if (out) fs.writeFileSync(out, JSON.stringify(rows, null, 1));
process.exit(0);

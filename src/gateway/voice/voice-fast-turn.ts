/**
 * Voice fast path — a conversational voice turn answered by ONE direct,
 * streaming model call instead of a full agent run.
 *
 * Why: a full agent run (agentCommand) spends seconds before the model is even
 * asked — session store, skills snapshot, tool list, a 30k+ token system
 * prompt — and a caller hears nothing meanwhile. Measured on the live gateway
 * (2026-10-02): 6.9–15.8 s to the first token, of which the model was ~1.7 s.
 *
 * The fast step is the voice FRONT-END of the agent: it answers small talk,
 * greetings and clarifications itself and — for the owner — runs a small,
 * sharp set of the agent's own tools (voice-tools.ts: board, notes, memory,
 * web search, sub-agent status, spawning coders…) in parallel with a timeout.
 * Only what those tools cannot do goes to the full agent (runGatewayVoiceTurn,
 * same trust rules). Routing (voice-route.ts), cheapest first:
 *
 *   1. a deterministic pre-filter sends obvious work requests (projects, tasks,
 *      agents, messages, "check / send / spawn / remind"…) and follow-ups to an
 *      agent turn to the TOOL step (or, with no tools, straight to the agent);
 *   2. otherwise the fast model decides: it gets a short persona + speakable
 *      prompt and the call's recent turns, and must call `handoff_to_agent`
 *      for anything it cannot answer from the conversation;
 *   3. its reply is held back until the first sentence is complete: a refusal
 *      or "I can't" is never spoken — the turn goes to the full agent instead.
 *
 * A fast step that fails or stalls before saying anything falls back to the
 * full agent, so a turn is never silent because of this path.
 *
 * Nothing is said "before every reply" any more: an acknowledgement is spoken
 * only when work is in flight and nothing was said for ACK_DELAY_MS
 * (voice-ack.ts), and everything spoken goes through the SpeechShaper
 * (voice-speech.ts: once, in order, no markdown / JSON, long replies cut to a
 * spoken summary). Work that outlives the turn keeps running and is reported
 * on the next turn (voice-pending.ts).
 */

import fs from "node:fs";
import path from "node:path";

import { Type } from "@sinclair/typebox";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";

import type { AnyAgentTool } from "../../agents/tools/common.js";
import type { InfinibotConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  SENTENCE_END,
  VoiceTurnAbortedError,
  makeTurnTracker,
  runGatewayVoiceTurn,
  voiceCallSessionKey,
  type GatewayTurnDeps,
  type VoiceLlmTurnRequest,
  type VoiceLlmTurnResult,
  type VoiceTurnMessage,
  type VoiceTurnTimings,
} from "./voice-llm-turn.js";

import { ACK_DELAY_MS, ackIntentFor, pickAck, scheduleAck } from "./voice-ack.js";
import {
  SPAWN_TOOLS,
  startVoiceDelegation,
  watchCallChildren,
  type VoiceTaskHandle,
} from "./voice-delegate.js";
import { voiceProgress } from "./voice-progress.js";
import { resolveVoiceTiming, type VoiceTimingConfig } from "./voice-timing.js";
import {
  busyBackground,
  cancelBackground,
  isCancelUtterance,
  takeFinished,
  trackBackground,
} from "./voice-pending.js";
import { SpeechShaper } from "./voice-speech.js";
import { mirrorVoiceTurnToSession } from "./voice-session-mirror.js";
import {
  executeVoiceToolCalls,
  resolveVoiceToolset,
  toolDefs,
  type VoiceToolResult,
} from "./voice-tools.js";
import {
  isActionRequest,
  isHandoffMarker,
  looksLikeRefusal,
  prefilterVoiceRoute,
  recallVoiceRoute,
  rememberVoiceRoute,
  HANDOFF_MARKER,
} from "./voice-route.js";

const log = createSubsystemLogger("voice/fast-turn");

export const HANDOFF_TOOL = "handoff_to_agent";
/** Async hand-off of a task to the main tool-use agent (voice-delegate.ts). */
export const DELEGATE_TOOL = "delegate_to_main";
/** Tool rounds per turn before the fast step stops and answers with what it has. */
const MAX_TOOL_ROUNDS = 3;
/** No event from the fast model for this long → the full agent answers instead. */
const FAST_FIRST_EVENT_TIMEOUT_MS = 6_000;
/** What the caller hears when work goes to the main agent (unless the model wrote a fresh one). */
export { DELEGATE_ACKS } from "./voice-ack.js";
/** A reply is held back until this much text ends on a sentence (refusal guard). */
const GUARD_MIN_CHARS = 40;
const GUARD_MAX_CHARS = 200;
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CHARS = 700;
const MAX_PERSONA_CHARS = 1800;
const MODEL_CACHE_MS = 60_000;
const FAST_TIMEOUT_MS = 20_000;

export type FastModelHandle = { ref: string; model: Model<Api>; apiKey: string };

export type FastStreamEvent =
  | { type: "text"; delta: string }
  | { type: "handoff"; request?: string; ack?: string }
  /** Async hand-off of a task to the main agent. */
  | { type: "delegate"; task?: string; ack?: string }
  /** A call of one of the voice tools (not the hand-off). */
  | { type: "toolcall"; call: ToolCall }
  /** The finished assistant message (kept in the context for the next tool round). */
  | { type: "message"; message: AssistantMessage }
  | { type: "error"; error: string };

export type FastTurnDeps = {
  /** Model + key for the fast step (default: fastModel override, else the agent's model). */
  resolveModel?: (req: VoiceLlmTurnRequest) => Promise<FastModelHandle>;
  /** One streaming completion → normalised events. */
  stream?: (
    handle: FastModelHandle,
    context: Context,
    opts: { signal?: AbortSignal; sessionId: string },
  ) => AsyncIterable<FastStreamEvent>;
  /** Persona text for the agent (default: IDENTITY.md + SOUL.md of its workspace). */
  persona?: (req: VoiceLlmTurnRequest) => Promise<string> | string;
  gateway?: GatewayTurnDeps;
  now?: () => Date;
  /** The call's voice tools (default: the agent's tools ∩ the voice allowlist; owner only). */
  tools?: (req: VoiceLlmTurnRequest, sessionKey: string) => Promise<AnyAgentTool[]>;
  /** Wait before an acknowledgement is spoken over work in flight (default ACK_DELAY_MS). */
  ackDelayMs?: number;
  /** Per-tool timeout of fast tools (default: the call's voice timing). */
  toolTimeoutMs?: number;
  /** Start a delegation to the main agent (default startVoiceDelegation). */
  delegate?: (p: Parameters<typeof startVoiceDelegation>[0]) => Promise<VoiceTaskHandle>;
  /** Follow sub-agents a turn started on the call session (default watchCallChildren). */
  watchChildren?: (p: Parameters<typeof watchCallChildren>[0]) => Promise<VoiceTaskHandle | null>;
  /** Where full results go (default: the bound chat session, else the agent's main session). */
  chatSessionKey?: (req: VoiceLlmTurnRequest, sessionKey: string) => Promise<string | undefined>;
};

// ── prompt ─────────────────────────────────────────────────────────────────────

/** The compact system prompt of the fast step (a few hundred tokens, stable per call → cacheable). */
export function fastVoiceSystemPrompt(
  req: Pick<VoiceLlmTurnRequest, "callerIsOwner" | "context" | "agentId">,
  persona: string,
  now?: Date,
  toolNames: string[] = [],
  /** The main agent takes delegated tasks (owner calls with tools). */
  delegate = toolNames.length > 0,
): string {
  const hasTools = toolNames.length > 0;
  return [
    `[Live voice call - you are the voice front-end of the assistant "${req.agentId}"]`,
    "You are the fast first responder of this assistant on a live call. The full assistant is the same you with tools, memory and access to everything the user runs: their projects, tasks, agents, messages, files, calendar, code and systems. It takes over the moment you hand a turn to it.",
    "Your words are spoken aloud by text-to-speech the moment you write them. Answer right away in one to three short, natural sentences, in the language the caller speaks.",
    "No markdown, lists, code, links, emoji or symbols. Plain punctuation only. Spell small numbers as words.",
    "",
    ...(hasTools
      ? [
          "You answer plain conversation yourself: greetings, small talk, who you are, opinions, general knowledge, clarifying questions, and what was already said in this call.",
          `For the user's data and simple actions, call your tools directly (${toolNames.join(", ")}). Call independent tools together in one step. Never guess or invent facts a tool can give you.`,
          ...(delegate
            ? [
                `You work with the main agent: the same assistant with EVERY tool. It spawns sub-agents and coders (Claude, Codex, OpenCode), runs goals and workflows, changes the board, sends messages, and drives every plugin: Droid Swarm phones, content posting, FlyPic images and video, the browser, the desktop and more. So there is nothing the caller can ask that you "can't" do.`,
                `Any task your own tools cannot finish in a few seconds, needs a tool you do not have, or is long or heavy (coding, spawning agents, research, multi-step jobs): call ${DELEGATE_TOOL} with the complete task. It starts at once in the background and the caller gets spoken progress updates and the result; you keep talking with them meanwhile.`,
                `Call ${HANDOFF_TOOL} only for a question whose answer the caller wants right now and that your tools cannot answer.`,
                `Never refuse and never say you cannot do something, cannot spawn agents, or do not have a tool: use a tool, or ${DELEGATE_TOOL}.`,
              ]
            : [
                "Long or heavy work (coding, research, multi-step jobs, anything that takes minutes) is never done inline: start it in the background with sessions_spawn or a coder tool, say in one sentence that it is started, and move on. You report its result when it comes back.",
                `Call ${HANDOFF_TOOL} only for what none of your tools can do. Never refuse and never say you cannot do something: use a tool or hand off.`,
              ]),
          `Do not write any filler before a tool call ("One moment", "Let me check", "Sure, checking"): the voice system covers the wait. After the tools answer, lead with the answer itself in one sentence.`,
          `When you call ${HANDOFF_TOOL}${delegate ? ` or ${DELEGATE_TOOL}` : ""}, write nothing else: put a short, natural acknowledgement in "ack" (vary it; never "One moment, let me check"). If you cannot call tools, reply with exactly the single word ${HANDOFF_MARKER}.`,
        ]
      : [
          "You answer ONLY plain conversation yourself: greetings, small talk, who you are, opinions, general knowledge, clarifying questions, and what was already said in this call.",
          `Everything else goes to the full assistant by calling ${HANDOFF_TOOL}: anything about the user's projects, tasks, business, agents, data, memory, files, calendar, messages or systems; current facts or the web; and any request to do, check, look up, send, make, create, spawn, schedule or remember something. Do not guess or invent such facts.`,
          `Never refuse and never say you cannot share, discuss or do something. If you do not have the information or cannot do it from here, that is exactly when you call ${HANDOFF_TOOL}: the full assistant can. When in doubt, hand off.`,
          `When you call ${HANDOFF_TOOL}, write nothing else: put a short, natural acknowledgement in "ack" (vary it; never "One moment, let me check"). If you cannot call tools, reply with exactly the single word ${HANDOFF_MARKER}.`,
        ]),
    delegate
      ? 'To the caller you are one assistant: never mention a front-end, a tool or "the full assistant". Saying that the main agent is handling a delegated task is fine.'
      : 'To the caller you are simply yourself, one assistant: never mention a front-end, a hand-off, a tool or "the full assistant".',
    "Long answers: say the key point in one or two sentences; the full details are shown in the chat.",
    "Never read out passwords, API keys or tokens.",
    "",
    req.callerIsOwner
      ? "The caller is the owner of this assistant: the person you work for, authenticated by the voice platform. Nothing about their own projects, business, data, agents or systems is confidential from them."
      : "The caller is not verified as the owner: they reached you through a voice line. Chat with them normally, do not volunteer the owner's private data yourself, and hand off any request as usual: the full assistant decides what a guest may get. Do not refuse on its behalf.",
    ...(req.context ? [req.context] : []),
    ...(persona.trim() ? ["", "[Who you are]", persona.trim()] : []),
    // Last, so everything above stays a stable (cacheable) prefix.
    ...(now ? ["", `Current date and time: ${formatNow(now)}.`] : []),
  ].join("\n");
}

function formatNow(now: Date): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(now);
  } catch {
    return now.toISOString();
  }
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** The call's recent turns as model messages, ending with the caller's latest utterance. */
export function fastVoiceMessages(
  history: VoiceTurnMessage[] | undefined,
  message: string,
  handle: Pick<FastModelHandle, "model">,
  now = Date.now(),
): Message[] {
  const turns = (history ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
    .slice(-MAX_HISTORY_MESSAGES);
  // The provider's history normally ends with the utterance being answered.
  const last = turns[turns.length - 1];
  if (last && last.role === "user" && last.content.trim() === message.trim()) turns.pop();
  // Providers reject a conversation that starts with the assistant.
  while (turns.length && turns[0].role !== "user") turns.shift();
  const out: Message[] = [];
  for (const m of turns) {
    const text = clip(m.content, MAX_HISTORY_CHARS);
    if (m.role === "user") out.push({ role: "user", content: text, timestamp: now });
    else
      out.push({
        role: "assistant",
        content: [{ type: "text", text }],
        api: handle.model.api,
        provider: handle.model.provider,
        model: handle.model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: now,
      } as Message);
  }
  out.push({ role: "user", content: message.trim(), timestamp: now });
  return out;
}

/** Recent turns as plain text, for the full agent when a turn is handed off. */
export function historyAsContext(history: VoiceTurnMessage[] | undefined, message: string): string {
  const turns = (history ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
    .slice(-MAX_HISTORY_MESSAGES);
  const last = turns[turns.length - 1];
  if (last && last.role === "user" && last.content.trim() === message.trim()) turns.pop();
  if (!turns.length) return "";
  return [
    "Earlier in this call (spoken, most recent last):",
    ...turns.map((m) => `${m.role === "user" ? "Caller" : "You"}: ${clip(m.content, 400)}`),
  ].join("\n");
}

// ── defaults: persona, model, stream ───────────────────────────────────────────

const personaCache = new Map<string, { key: string; text: string }>();

async function defaultPersona(req: VoiceLlmTurnRequest): Promise<string> {
  const [{ loadConfig }, { resolveAgentWorkspaceDir }, { resolveAgentIdentity }] =
    await Promise.all([
      import("../../config/config.js"),
      import("../../agents/agent-scope.js"),
      import("../../agents/identity.js"),
    ]);
  const cfg = loadConfig();
  const dir = resolveAgentWorkspaceDir(cfg, req.agentId);
  const files = ["IDENTITY.md", "SOUL.md"].map((f) => path.join(dir, f));
  const stats = await Promise.all(files.map((f) => fs.promises.stat(f).catch(() => null)));
  const key = stats.map((s, i) => `${files[i]}:${s ? s.mtimeMs : 0}`).join("|");
  const cached = personaCache.get(req.agentId);
  if (cached && cached.key === key) return cached.text;
  const name = resolveAgentIdentity(cfg, req.agentId)?.name?.trim();
  const bodies = await Promise.all(
    files.map((f, i) => (stats[i] ? fs.promises.readFile(f, "utf8").catch(() => "") : "")),
  );
  const text = clip(
    [name ? `Your name is ${name}.` : "", ...bodies.map((b) => b.trim())]
      .filter(Boolean)
      .join("\n\n"),
    MAX_PERSONA_CHARS,
  );
  personaCache.set(req.agentId, { key, text });
  return text;
}

const modelCache = new Map<string, { at: number; handle: FastModelHandle }>();

/** The agent's model → a faster model of the same provider for the voice step. */
export const FAST_SIBLINGS: Record<string, string> = {
  "gpt-oss:120b": "gpt-oss:20b",
  "gpt-oss-120b": "gpt-oss-20b",
  "openai/gpt-oss-120b": "openai/gpt-oss-20b",
};

export function clearVoiceFastCachesForTests(): void {
  modelCache.clear();
  personaCache.clear();
}

export async function resolveFastVoiceModel(req: VoiceLlmTurnRequest): Promise<FastModelHandle> {
  const cacheKey = `${req.agentId}|${req.fastModel ?? ""}`;
  const hit = modelCache.get(cacheKey);
  if (hit && Date.now() - hit.at < MODEL_CACHE_MS) return hit.handle;
  const [
    { loadConfig },
    { resolveAgentDir },
    { resolveDefaultModelForAgent, resolveModelRefFromString, buildModelAliasIndex },
    { resolveModel },
    { getApiKeyForModel, requireApiKey },
  ] = await Promise.all([
    import("../../config/config.js"),
    import("../../agents/agent-scope.js"),
    import("../../agents/model-selection.js"),
    import("../../agents/pi-embedded-runner/model.js"),
    import("../../agents/model-auth.js"),
  ]);
  const cfg: InfinibotConfig = loadConfig();
  let ref = resolveDefaultModelForAgent({ cfg, agentId: req.agentId });
  const override = req.fastModel?.trim();
  if (override) {
    const parsed = resolveModelRefFromString({
      raw: override,
      defaultProvider: ref.provider,
      aliasIndex: buildModelAliasIndex({ cfg, defaultProvider: ref.provider }),
    });
    if (parsed) ref = parsed.ref;
  }
  const agentDir = resolveAgentDir(cfg, req.agentId);
  // No explicit voice model: use the agent's provider's faster sibling when it
  // has one (same account and key, so nothing new is billed). Measured on
  // ollama-cloud 2026-10-07: gpt-oss:20b 0.86–1.05 s to first token vs
  // gpt-oss:120b 1.41–1.61 s.
  if (!override) {
    const sibling = FAST_SIBLINGS[ref.model];
    if (sibling) {
      const fast = resolveModel(ref.provider, sibling, agentDir, cfg);
      if (fast.model) ref = { ...ref, model: sibling };
    }
  }
  const resolved = resolveModel(ref.provider, ref.model, agentDir, cfg);
  if (!resolved.model)
    throw new Error(resolved.error ?? `unknown voice model ${ref.provider}/${ref.model}`);
  const apiKey = requireApiKey(
    await getApiKeyForModel({ model: resolved.model, cfg, agentDir }),
    ref.provider,
  );
  const handle = { ref: `${ref.provider}/${ref.model}`, model: resolved.model, apiKey };
  modelCache.set(cacheKey, { at: Date.now(), handle });
  return handle;
}

export async function* streamFastVoice(
  handle: FastModelHandle,
  context: Context,
  opts: { signal?: AbortSignal; sessionId: string },
): AsyncIterable<FastStreamEvent> {
  const { streamSimple } = await import("@mariozechner/pi-ai");
  const events = streamSimple(handle.model, context, {
    apiKey: handle.apiKey,
    signal: opts.signal,
    sessionId: opts.sessionId,
    maxTokens: 400,
    temperature: 0.6,
    ...(handle.model.reasoning ? { reasoning: "minimal" as const } : {}),
  });
  for await (const ev of events as AsyncIterable<AssistantMessageEvent>) {
    if (ev.type === "text_delta") yield { type: "text", delta: ev.delta };
    else if (ev.type === "done") yield { type: "message", message: ev.message };
    else if (ev.type === "toolcall_end") {
      if (ev.toolCall.name === DELEGATE_TOOL) {
        const args = (ev.toolCall.arguments ?? {}) as { task?: unknown; ack?: unknown };
        yield {
          type: "delegate",
          task: typeof args.task === "string" ? args.task : undefined,
          ack: typeof args.ack === "string" ? args.ack : undefined,
        };
        continue;
      }
      if (ev.toolCall.name !== HANDOFF_TOOL) {
        yield { type: "toolcall", call: ev.toolCall };
        continue;
      }
      const args = (ev.toolCall.arguments ?? {}) as { request?: unknown; ack?: unknown };
      yield {
        type: "handoff",
        request: typeof args.request === "string" ? args.request : undefined,
        ack: typeof args.ack === "string" ? args.ack : undefined,
      };
    } else if (ev.type === "error") {
      yield { type: "error", error: ev.error.errorMessage || "model error" };
    }
  }
}

export const HANDOFF_TOOL_DEF = {
  name: HANDOFF_TOOL,
  description:
    "Hand this turn to the full assistant, which has tools: the user's projects, tasks, agents, memory, files, calendar, messages, the web, and the ability to take actions or start background work. Call it for anything that is not plain conversation, and instead of ever refusing or saying you cannot do or share something.",
  parameters: Type.Object({
    request: Type.String({
      description: "What the caller wants, as a complete self-contained request.",
    }),
    ack: Type.String({
      description:
        "A few natural words to say to the caller if the work takes a while, in their language (e.g. 'Sure, pulling up your board.'). Vary it; never 'One moment, let me check'.",
    }),
  }),
};

export const DELEGATE_TOOL_DEF = {
  name: DELEGATE_TOOL,
  description:
    "Hand a task to the main agent, which has every tool: spawning sub-agents and coders, the board, messages, goals, workflows and all plugins (Droid Swarm, content posting, FlyPic, browser, desktop…). Returns at once; the work runs in the background and the caller gets spoken progress and the result. Use it for anything your own tools cannot finish in a few seconds, instead of ever saying you cannot do something.",
  parameters: Type.Object({
    task: Type.String({
      description:
        "The complete, self-contained task for the main agent, with every detail the caller gave (names, repos, sites, what done looks like).",
    }),
    ack: Type.String({
      description:
        "One short natural sentence for the caller, e.g. 'On it, I'll keep you posted.' Never say you are handing it to another agent. Vary it.",
    }),
  }),
};

// ── the turn ───────────────────────────────────────────────────────────────────

async function defaultVoiceTools(
  req: VoiceLlmTurnRequest,
  sessionKey: string,
): Promise<AnyAgentTool[]> {
  return resolveVoiceToolset({ agentId: req.agentId, sessionKey, allow: req.voiceTools });
}

function toolCallMessage(
  handle: FastModelHandle,
  calls: ToolCall[],
  now: number,
): AssistantMessage {
  return {
    role: "assistant",
    content: calls.map((c) => ({ ...c, type: "toolCall" as const })),
    api: handle.model.api,
    provider: handle.model.provider,
    model: handle.model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: now,
  } as AssistantMessage;
}

function toolResultMessage(r: VoiceToolResult): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: r.call.id,
    toolName: r.call.name,
    content: [{ type: "text", text: r.text }],
    isError: r.isError,
    timestamp: Date.now(),
  };
}

/**
 * What happened in the background since the last turn, as a note for the
 * model: results of detached work (voice-pending.ts), progress and results of
 * delegated tasks that are due (voice-progress.ts), and what is still running.
 */
function backgroundUpdateNote(sessionKey: string): string {
  const finished = takeFinished(sessionKey);
  const due = voiceProgress.take(sessionKey, { inTurn: true });
  const status = voiceProgress.statusNote(sessionKey);
  const parts: string[] = [];
  if (finished.length || due.length) {
    parts.push(
      [
        "Background work of this call finished or moved on since your last reply. Tell the caller about it FIRST, one short spoken sentence each, then answer what they just said:",
        ...finished.map((i) =>
          i.error
            ? `- "${clip(i.label, 80)}" failed: ${clip(i.error, 200)}`
            : `- "${clip(i.label, 80)}": ${clip(i.result ?? "", 700)}`,
        ),
        ...due.map((line) => `- ${clip(line, 400)}`),
      ].join("\n"),
    );
  }
  if (status) parts.push(status);
  return parts.join("\n\n");
}

let chatSinkWired = false;

/** Full results of delegated work go to the chat: the session the call is bound to, else the agent's main chat. */
async function defaultChatSessionKey(
  req: VoiceLlmTurnRequest,
  sessionKey: string,
): Promise<string | undefined> {
  if (!chatSinkWired) {
    chatSinkWired = true;
    voiceProgress.configure({
      deliverToChat: (key, text) => mirrorVoiceTurnToSession(key, "", text),
      log: (m) => log.warn(m),
    });
  }
  if (req.boundSession) return sessionKey;
  if (!req.callerIsOwner) return undefined;
  const [{ loadConfig }, { resolveAgentMainSessionKey }] = await Promise.all([
    import("../../config/config.js"),
    import("../../config/sessions/main-session.js"),
  ]);
  return resolveAgentMainSessionKey({ cfg: loadConfig(), agentId: req.agentId });
}

/** The model's own confirmation when fresh, else the next unused phrase of the delegate pool. */
function delegateAck(sessionKey: string, modelAck?: string): string {
  const candidate = modelAck?.trim();
  return pickAck(
    sessionKey,
    "delegate",
    candidate && !looksLikeRefusal(candidate) ? candidate : undefined,
  );
}

export async function runFastVoiceTurn(
  req: VoiceLlmTurnRequest,
  deps: FastTurnDeps = {},
): Promise<VoiceLlmTurnResult> {
  const start = Date.now();
  const sessionKey = voiceCallSessionKey(req);
  const tracker = makeTurnTracker(start, req.onDelta);
  const shaper = new SpeechShaper({ emit: (t) => tracker.push(t) });
  const trust = req.callerIsOwner ? "owner" : "caller";
  const ackDelayMs = deps.ackDelayMs ?? ACK_DELAY_MS;
  const timing: VoiceTimingConfig = resolveVoiceTiming(req.voiceTiming);
  let handle: FastModelHandle | null = null;
  let handoff: { request?: string; ack?: string } | null = null;
  let delegation: { task?: string; ack?: string; reason: string } | null = null;
  let fastError: string | undefined;
  let prepMs = 0;
  const toolsUsed: string[] = [];
  const base = {
    backend: "gateway" as const,
    sessionKey,
    trust: trust as "owner" | "caller",
  };
  const chatKeyP = (deps.chatSessionKey ?? defaultChatSessionKey)(req, sessionKey).catch(
    () => undefined,
  );
  const result = (
    timings: Omit<VoiceTurnTimings, "firstTokenMs" | "firstSentenceMs" | "totalMs">,
  ): VoiceLlmTurnResult => {
    shaper.end();
    if (req.boundSession && timings.path !== "agent" && shaper.fullText) {
      void mirrorVoiceTurnToSession(sessionKey, req.message, shaper.fullText).catch(
        () => undefined,
      );
    }
    return {
      ...base,
      text: tracker.text,
      firstTokenMs: tracker.firstTokenMs,
      totalMs: Date.now() - start,
      timings: {
        ...timings,
        firstTokenMs: tracker.firstTokenMs,
        firstSentenceMs: tracker.firstSentenceMs,
        totalMs: Date.now() - start,
        ...(toolsUsed.length && !timings.toolCalls ? { toolCalls: [...toolsUsed] } : {}),
      },
    };
  };

  // The call is alive and the agent is about to speak: progress waits a full interval.
  voiceProgress.callSeen(sessionKey, {
    spoke: true,
    intervalMs: timing.progressIntervalMs,
    idleMs: timing.callIdleMs,
  });

  // 0. "Stop" / "never mind" while background work of this call is running.
  if (
    isCancelUtterance(req.message) &&
    (busyBackground(sessionKey).length || voiceProgress.running(sessionKey).length)
  ) {
    const n = cancelBackground(sessionKey) + voiceProgress.cancel(sessionKey);
    shaper.say(n > 1 ? "Okay, I stopped those." : "Okay, I stopped that.");
    rememberVoiceRoute(sessionKey, "reply");
    return result({ path: "fast", prepMs: 0, routeReason: "cancel background work" });
  }
  const updateNote = backgroundUpdateNote(sessionKey);

  // 1. Pre-filter: an obvious work request goes to the tool step (or the agent).
  const pre = prefilterVoiceRoute(req.message, {
    history: req.history,
    lastRoute: recallVoiceRoute(sessionKey),
  });
  let routeReason = pre.route === "agent" ? `prefilter: ${pre.reason}` : "";

  const timeout = new AbortController();
  // The turn's model time is bounded per model round, not across tool waits.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const armTurnTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => timeout.abort(), FAST_TIMEOUT_MS);
  };
  const disarmTurnTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  armTurnTimer();
  let firstEventTimer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => timeout.abort();
  req.signal?.addEventListener("abort", onAbort, { once: true });
  let ack: ReturnType<typeof scheduleAck> | null = null;
  const startAck = (modelAck?: string) => {
    if (ack || shaper.hasOutput()) return;
    ack = scheduleAck({
      delayMs: ackDelayMs,
      spoken: () => shaper.hasOutput(),
      speak: (t) => shaper.say(t),
      phrase: () => pickAck(sessionKey, ackIntentFor(toolsUsed, req.message), modelAck),
    });
  };

  let tools: AnyAgentTool[] = [];
  let canDelegate = false;
  try {
    const [resolved, persona] = await Promise.all([
      (deps.resolveModel ?? resolveFastVoiceModel)(req),
      Promise.resolve((deps.persona ?? defaultPersona)(req)).catch(() => ""),
    ]);
    handle = resolved;
    // Tools only for the owner: a guest's work always goes through the full
    // agent, which applies the guest rules.
    if (req.callerIsOwner) {
      tools = await (deps.tools ?? defaultVoiceTools)(req, sessionKey).catch((err) => {
        log.warn(`voice tools unavailable: ${err instanceof Error ? err.message : String(err)}`);
        return [] as AnyAgentTool[];
      });
    }
    canDelegate = req.callerIsOwner && timing.delegate && tools.length > 0;
    if (pre.route === "agent" && !tools.length) {
      handoff = {};
    } else {
      const toolNames = tools.map((t) => t.name);
      const context: Context = {
        systemPrompt: [
          fastVoiceSystemPrompt(req, persona, deps.now?.() ?? new Date(), toolNames, canDelegate),
          ...(updateNote ? ["", updateNote] : []),
        ].join("\n"),
        messages: fastVoiceMessages(req.history, req.message, handle, start),
        tools: [...toolDefs(tools), ...(canDelegate ? [DELEGATE_TOOL_DEF] : []), HANDOFF_TOOL_DEF],
      };
      prepMs = Date.now() - start;

      // 2. The fast model answers, calls tools, delegates or hands off; 3. every opening is checked before it is spoken.
      let held = "";
      let released = false;
      /** A refusal never reaches the caller: an owner's task goes to the main agent, anything else to the full agent. */
      const onRefusal = (reason: string) => {
        if (
          canDelegate &&
          (toolsUsed.length || isActionRequest(req.message) || pre.route === "agent")
        ) {
          delegation = { task: req.message, reason };
        } else {
          handoff = {};
          routeReason = reason;
        }
      };
      /** Speak the held opening, unless it is a refusal or the hand-off marker. */
      const release = (final: boolean): boolean => {
        if (released || !held.trim()) return true;
        const complete = SENTENCE_END.test(held) && held.trim().length >= GUARD_MIN_CHARS;
        if (!final && !complete && held.length < GUARD_MAX_CHARS) return true;
        if (isHandoffMarker(held)) {
          handoff = {};
          routeReason = "model: hand-off marker";
          return false;
        }
        if (looksLikeRefusal(held)) {
          log.warn(
            `fast voice step refused (${handle?.ref ?? "no model"}), not spoken: "${clip(held, 120)}"`,
          );
          onRefusal(toolsUsed.length ? "refusal guard (after tools)" : "refusal guard");
          return false;
        }
        released = true;
        shaper.push(held);
        held = "";
        return true;
      };

      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const calls: ToolCall[] = [];
        let message: AssistantMessage | undefined;
        armTurnTimer();
        firstEventTimer = setTimeout(() => timeout.abort(), FAST_FIRST_EVENT_TIMEOUT_MS);
        for await (const ev of (deps.stream ?? streamFastVoice)(handle, context, {
          signal: timeout.signal,
          sessionId: sessionKey,
        })) {
          if (firstEventTimer) {
            clearTimeout(firstEventTimer);
            firstEventTimer = null;
          }
          if (ev.type === "text") {
            if (released) shaper.push(ev.delta);
            else {
              held += ev.delta;
              if (!release(false)) break;
            }
          } else if (ev.type === "toolcall") {
            calls.push(ev.call);
          } else if (ev.type === "message") {
            message = ev.message;
          } else if (ev.type === "delegate") {
            if (canDelegate) {
              delegation = {
                task: ev.task,
                ack: ev.ack,
                reason: round === 0 ? "model: delegate" : "model: delegate after tools",
              };
            } else {
              handoff = { request: ev.task, ack: ev.ack };
              routeReason = "model: hand-off";
            }
            break;
          } else if (ev.type === "handoff") {
            handoff = ev;
            routeReason = round === 0 ? "model: hand-off" : "model: hand-off after tools";
            break;
          } else if (ev.type === "error") {
            fastError = ev.error;
            break;
          }
        }
        if (firstEventTimer) {
          clearTimeout(firstEventTimer);
          firstEventTimer = null;
        }
        if (handoff || delegation || fastError) break;
        if (!calls.length || round === MAX_TOOL_ROUNDS) {
          if (!released) release(true);
          break;
        }
        // Tool round. Text the model wrote before its calls is not spoken now:
        // it is the acknowledgement candidate, spoken only if the tools are slow.
        const preamble = released ? "" : held.trim();
        held = "";
        toolsUsed.push(...calls.map((c) => c.name));
        if (!routeReason) routeReason = `model: tools ${calls.map((c) => c.name).join(",")}`;
        // Spoken only if the tools (and the answer after them) take longer than the ack delay.
        startAck(preamble || undefined);
        context.messages.push(message ?? toolCallMessage(handle, calls, Date.now()));
        disarmTurnTimer();
        const results = await executeVoiceToolCalls(calls, tools, {
          timeoutMs: deps.toolTimeoutMs,
          timing,
          delegateHint: canDelegate,
          signal: req.signal,
        });
        for (const r of results) {
          context.messages.push(toolResultMessage(r));
          if (r.late) {
            trackBackground(
              sessionKey,
              `${r.call.name} for "${clip(req.message, 60)}"`,
              r.late.then((t) => clip(t, 1200)),
            );
          }
        }
        if (calls.some((c) => SPAWN_TOOLS.has(c.name))) {
          // A sub-agent started straight from the fast step: follow it like a delegated task.
          void (deps.watchChildren ?? watchCallChildren)({
            callSessionKey: sessionKey,
            chatSessionKey: await chatKeyP,
            since: start,
            label: clip(req.message, 70),
            progressIntervalMs: timing.progressIntervalMs,
            callIdleMs: timing.callIdleMs,
          }).catch(() => null);
        }
        if (req.signal?.aborted) break;
        // The answer after the tools is guarded again: a tool error must not become "I can't".
        released = false;
      }
      if (!handoff && !delegation && !fastError && released && looksLikeRefusal(tracker.text)) {
        // A refusal after an opening already spoken: the work still gets done.
        log.warn(`fast voice step refused mid-answer (${handle.ref}), routing the request`);
        onRefusal("refusal guard (after speaking)");
      }
    }
  } catch (err) {
    fastError = err instanceof Error ? err.message : String(err);
  } finally {
    disarmTurnTimer();
    if (firstEventTimer) clearTimeout(firstEventTimer);
    req.signal?.removeEventListener("abort", onAbort);
    (ack as ReturnType<typeof scheduleAck> | null)?.cancel();
  }
  if (timeout.signal.aborted && !req.signal?.aborted && !handoff && !delegation)
    fastError = fastError ? `timed out (${fastError})` : "timed out";
  if (req.signal?.aborted && !delegation) throw new VoiceTurnAbortedError();

  const fastFirstTokenMs = tracker.firstTokenMs;
  const fastMs = Date.now() - start;

  // Delegated to the main agent: confirm in one sentence, the work runs in the background.
  if (delegation) {
    const d = delegation as { task?: string; ack?: string; reason: string };
    const task = d.task?.trim() || req.message;
    shaper.say(delegateAck(sessionKey, d.ack));
    rememberVoiceRoute(sessionKey, "agent");
    try {
      await (deps.delegate ?? startVoiceDelegation)({
        agentId: req.agentId,
        callSessionKey: sessionKey,
        chatSessionKey: await chatKeyP,
        task,
        context:
          [historyAsContext(req.history, req.message), req.context].filter(Boolean).join("\n\n") ||
          undefined,
        progressIntervalMs: timing.progressIntervalMs,
        callIdleMs: timing.callIdleMs,
      });
    } catch (err) {
      log.warn(
        `voice delegation failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return result({
      path: "fast+delegate",
      model: handle?.ref,
      prepMs,
      routeReason: routeReason ? `${routeReason}; ${d.reason}` : d.reason,
      ...(fastError ? { fastError } : {}),
    });
  }

  // Answered by the fast step (with or without tools).
  if (!handoff && !fastError && shaper.hasOutput()) {
    rememberVoiceRoute(sessionKey, toolsUsed.length ? "agent" : "reply");
    return result({
      path: "fast",
      model: handle?.ref,
      prepMs,
      routeReason:
        routeReason || (pre.route === "reply" ? `prefilter: ${pre.reason}` : "model: reply"),
    });
  }

  // A failure after the caller already heard part of an answer: stop there.
  if (!handoff && fastError && shaper.hasOutput()) {
    log.warn(`fast voice step failed mid-answer (${handle?.ref ?? "no model"}): ${fastError}`);
    return result({ path: "fast", model: handle?.ref, prepMs, fastError });
  }

  // Hand off to the full agent. No canned line: the acknowledgement is spoken
  // only if the agent has not started answering after the ack delay.
  if (fastError)
    log.warn(
      `fast voice step failed (${handle?.ref ?? "no model"}), using the full agent: ${fastError}`,
    );
  if (!routeReason) routeReason = fastError ? "fast step failed" : "fast step said nothing";
  rememberVoiceRoute(sessionKey, "agent");
  const history = historyAsContext(req.history, req.message);
  const agent = await runGatewayVoiceTurn(
    {
      ...req,
      context:
        [
          req.context,
          history,
          updateNote,
          "A short acknowledgement may already have been spoken to the caller: do not acknowledge again and do not open with filler. Go straight to the work and lead with the answer.",
        ]
          .filter(Boolean)
          .join("\n\n") || undefined,
      onDelta: req.onDelta,
    },
    deps.gateway,
    {
      shaper,
      ack: {
        callKey: sessionKey,
        delayMs: ackDelayMs,
        modelAck: (handoff as { ack?: string } | null)?.ack,
      },
      // A tool-only agent turn: a short confirmation, never silence.
      emptyFallback: "Done.",
      tracker,
      watchChildren: deps.watchChildren,
      chatSessionKey: await chatKeyP,
    },
  );
  shaper.end();
  return {
    ...base,
    text: tracker.text,
    firstTokenMs: tracker.firstTokenMs,
    totalMs: Date.now() - start,
    timings: {
      path: handoff ? "fast+agent" : "agent",
      model: handle?.ref,
      prepMs,
      firstTokenMs: tracker.firstTokenMs,
      firstSentenceMs: tracker.firstSentenceMs,
      totalMs: Date.now() - start,
      fastFirstTokenMs,
      handoffMs: fastMs,
      toolCalls: [...toolsUsed, ...(agent.timings?.toolCalls ?? [])],
      routeReason: agent.timings?.detached ? `${routeReason}; detached to background` : routeReason,
      agentPrepMs: agent.timings?.agentPrepMs,
      agentFirstTokenMs:
        agent.timings?.agentFirstTokenMs != null ? fastMs + agent.timings.agentFirstTokenMs : null,
      ...(agent.timings?.detached ? { detached: true } : {}),
      ...(fastError ? { fastError } : {}),
    },
  };
}

// ── update poll / hang-up ──────────────────────────────────────────────────────

/**
 * The voice provider asks what to say while the caller and the agent are
 * quiet (progress of delegated work, results of detached work). Marks what it
 * returns as said; `callEnded` = the caller hung up.
 */
export function pollVoiceUpdates(
  req: Pick<
    VoiceLlmTurnRequest,
    "agentId" | "provider" | "callKey" | "callerIsOwner" | "sessionKey" | "voiceTiming"
  > & { callEnded?: boolean },
): { sessionKey: string; updates: string[]; running: number } {
  const sessionKey = voiceCallSessionKey(req);
  if (req.callEnded) {
    voiceProgress.endCall(sessionKey);
    return { sessionKey, updates: [], running: voiceProgress.running(sessionKey).length };
  }
  const timing = resolveVoiceTiming(req.voiceTiming);
  voiceProgress.callSeen(sessionKey, {
    intervalMs: timing.progressIntervalMs,
    idleMs: timing.callIdleMs,
    revive: false,
  });
  const updates: string[] = [];
  for (const item of takeFinished(sessionKey)) {
    const what = clip(item.label.replace(/^[a-z_]+ for /, ""), 60);
    updates.push(
      item.error
        ? `Quick update: ${what} didn't work out.`
        : `Quick update on ${what}: ${spokenLine(item.result ?? "")}`,
    );
  }
  updates.push(...voiceProgress.take(sessionKey));
  if (updates.length) voiceProgress.callSeen(sessionKey, { spoke: true, revive: false });
  return { sessionKey, updates, running: voiceProgress.running(sessionKey).length };
}

function spokenLine(text: string): string {
  const shaped: string[] = [];
  const s = new SpeechShaper({ emit: (t) => shaped.push(t), maxChars: 260 });
  s.say(text);
  s.end();
  return shaped.join("").trim();
}

// ── warm-up ────────────────────────────────────────────────────────────────────

/**
 * Called when a call connects, before the caller's first words: resolves the
 * model, persona and tools, and opens the provider's connection pool, so the
 * first turn pays for none of it.
 */
export async function prewarmFastVoice(
  req: VoiceLlmTurnRequest,
): Promise<{ ms: number; model?: string; tools: number }> {
  const start = Date.now();
  const sessionKey = voiceCallSessionKey(req);
  const [handle] = await Promise.all([
    resolveFastVoiceModel(req),
    defaultPersona(req).catch(() => ""),
    import("@mariozechner/pi-ai"),
  ]);
  const tools = req.callerIsOwner ? await defaultVoiceTools(req, sessionKey).catch(() => []) : [];
  // The owner may hand work to the main agent: load that stack now, not on the first delegation.
  if (req.callerIsOwner) {
    void import("./voice-delegate.js").then((m) => m.defaultDelegateDeps()).catch(() => undefined);
    void defaultChatSessionKey(req, sessionKey).catch(() => undefined);
  }
  const baseUrl = (handle.model as { baseUrl?: string }).baseUrl;
  if (baseUrl) {
    // TLS + connection pool warm-up: no request body, nothing billed.
    await fetch(new URL(baseUrl).origin, {
      method: "HEAD",
      signal: AbortSignal.timeout(2_500),
    }).catch(() => undefined);
  }
  return { ms: Date.now() - start, model: handle.ref, tools: tools.length };
}

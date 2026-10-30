/**
 * Voice LLM turns — InfiniBot as the LLM step of an EXTERNAL voice pipeline.
 *
 * A voice provider (Robovoice) runs STT and TTS itself and calls back into the
 * gateway for the language-model step. This module runs that one turn on the
 * backend chosen for the agent and streams the reply text as it is produced,
 * so TTS can start on the first phrase:
 *
 *   - "gateway"      the agent itself (agentCommand: full tool loop, skills,
 *                    memory, sub-agent spawning — the same machinery as chat).
 *   - "claude-code" / "codex" / "opencode" / "gemini"
 *                    a CLI agent in print/JSON mode, one process per turn,
 *                    resuming the CLI's own session so the call keeps context.
 *
 * Trust (W5, src/routing/sender-trust.ts): a voice caller is NOT the operator.
 * The session key is `agent:<id>:voicecall:<provider>:<call>`, which resolves
 * to `untrusted-sender` (no host/coder/session tools by default); only a caller
 * the provider authenticated as the owner gets `voicecall-owner:` (owner
 * trust). CLI backends mirror that: untrusted callers never get a permission
 * bypass and run with read-only sandboxes / no shell tools.
 *
 * Plugins reach this through `api.runtime.host.voiceTurn` (plugins run in their
 * own module instances, so the seam is handed over rather than imported).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";

import { resolveBin, enrichedPathEnv } from "../../agents/coder-backend/bin-detect.js";
import {
  VOICE_CALLER_SESSION_PREFIX,
  VOICE_OWNER_SESSION_PREFIX,
} from "../../routing/sender-trust.js";
import { ackIntentFor, pickAck, scheduleAck, ACK_DELAY_MS } from "./voice-ack.js";
import { trackBackground } from "./voice-pending.js";
import { SpeechShaper } from "./voice-speech.js";

export const VOICE_LLM_BACKENDS = [
  "gateway",
  "claude-code",
  "codex",
  "opencode",
  "gemini",
  "grok",
] as const;
export type VoiceLlmBackend = (typeof VOICE_LLM_BACKENDS)[number];
export type VoiceCliBackend = Exclude<VoiceLlmBackend, "gateway">;

export function isVoiceLlmBackend(v: unknown): v is VoiceLlmBackend {
  return typeof v === "string" && (VOICE_LLM_BACKENDS as readonly string[]).includes(v);
}

export type VoiceLlmTurnRequest = {
  agentId: string;
  backend: VoiceLlmBackend;
  /** The caller's latest utterance (already transcribed by the provider). */
  message: string;
  /** Stable per-call id (room / session) — keeps conversation context across turns. */
  callKey: string;
  /** Voice provider id, e.g. "robovoice" (part of the session key). */
  provider: string;
  /** True only when the provider authenticated the caller as the owner. */
  callerIsOwner: boolean;
  /** Extra per-turn context (location name, caller label…). */
  context?: string;
  /**
   * Gateway backend only. "auto" answers conversational turns with one direct
   * streaming model call (voice-fast-turn.ts) and hands tool work to the full
   * agent after a spoken acknowledgement; "agent" always runs the full agent.
   * Default "agent" (what callers that predate the fast path get).
   */
  mode?: VoiceTurnMode;
  /** The call's earlier turns as the voice provider sent them (oldest first). */
  history?: VoiceTurnMessage[];
  /** `provider/model` (or alias) for the fast step; default: the agent's model. */
  fastModel?: string;
  /**
   * `provider/model` the full agent answers with instead of its primary
   * (Voice page brain picker, voice-cli-route.ts `model`). Default: the agent's model.
   */
  primaryModel?: string;
  /** Voice tool allowlist override (default DEFAULT_VOICE_TOOLS ∩ the agent's tools). */
  voiceTools?: string[];
  /**
   * Bind the call to an existing chat session (owner only): turns run on this
   * session key, so history and replies are that chat's. Ignored for guests
   * and for a key that is not this agent's.
   */
  sessionKey?: string;
  /** Set by voiceCallSessionKey's caller when `sessionKey` was honoured. */
  boundSession?: boolean;
  /** Warm the turn path (model, persona, tools, provider TLS) without answering. */
  warmup?: boolean;
  /**
   * Tool budgets, delegation and progress pacing of the call (voice-timing.ts).
   * Omitted fields use the defaults.
   */
  voiceTiming?: Partial<import("./voice-timing.js").VoiceTimingConfig>;
  /**
   * No utterance: return what is due to be spoken now (progress / results of
   * background work) in `updates`. The provider polls while the line is quiet.
   */
  pollUpdates?: boolean;
  /** No utterance: the call ended; background results go to the chat only. */
  callEnded?: boolean;
  signal?: AbortSignal;
  onDelta: (text: string) => void;
};

export type VoiceTurnMode = "auto" | "agent";
export type VoiceTurnMessage = { role: "user" | "assistant" | "system"; content: string };

/** Where one turn's time went (all ms from the request reaching the gateway). */
export type VoiceTurnTimings = {
  /** fast = direct model call; agent = full agent run; fast+agent = handed off after an acknowledgement. */
  path: "fast" | "agent" | "fast+agent" | "fast+delegate" | "cli";
  /** Model that answered the fast step (`provider/model`). */
  model?: string;
  /** Until the model request was sent (fast step), or the agent run reached its model (agent). */
  prepMs: number;
  firstTokenMs: number | null;
  /** Until the first complete sentence was streamed — what TTS can start speaking. */
  firstSentenceMs: number | null;
  totalMs: number;
  fastFirstTokenMs?: number | null;
  /** When the fast step decided to hand off. */
  handoffMs?: number;
  /** Full agent: from its start until its run reached the model. */
  agentPrepMs?: number | null;
  /** Full agent: first token of the agent's own answer (after the acknowledgement). */
  agentFirstTokenMs?: number | null;
  fastError?: string;
  /** Why the turn took this path, e.g. "prefilter: action request", "model: hand-off", "refusal guard". */
  routeReason?: string;
  /** Tools the full agent called during the turn, in order. */
  toolCalls?: string[];
  /** The agent's work outlived the turn and continues in the background. */
  detached?: boolean;
};

/** The caller hung up, or spoke again before this turn answered (barge-in). */
export class VoiceTurnAbortedError extends Error {
  readonly code = "aborted";
  constructor() {
    super("voice turn aborted");
    this.name = "VoiceTurnAbortedError";
  }
}

export type VoiceLlmTurnResult = {
  text: string;
  backend: VoiceLlmBackend;
  sessionKey: string;
  trust: "owner" | "caller";
  /** ms from request start to the first streamed text (null = nothing streamed). */
  firstTokenMs: number | null;
  totalMs: number;
  /** CLI session id the next turn resumes (CLI backends). */
  cliSessionId?: string;
  /** pollUpdates: lines to speak now, in order (already marked as said). */
  updates?: string[];
  /** pollUpdates: delegated tasks still running on the call. */
  running?: number;
  timings?: VoiceTurnTimings;
};

export type RunVoiceTurn = (req: VoiceLlmTurnRequest) => Promise<VoiceLlmTurnResult>;

// ── shared ─────────────────────────────────────────────────────────────────────

const SAFE = /[^A-Za-z0-9_.-]/g;

/** A chat session key the owner's call may be bound to (`agent:<agentId>:…`). */
export function bindableSessionKey(
  req: Pick<VoiceLlmTurnRequest, "agentId" | "callerIsOwner" | "sessionKey">,
): string | undefined {
  const key = req.sessionKey?.trim();
  if (!key || !req.callerIsOwner) return undefined;
  if (!key.startsWith(`agent:${req.agentId}:`) || key.length > 200) return undefined;
  // Never bind to another caller's voice session or a sub-agent's run.
  if (/:voicecall(?:-owner)?:|:subagent:/.test(key)) return undefined;
  return key;
}

export function voiceCallSessionKey(
  req: Pick<
    VoiceLlmTurnRequest,
    "agentId" | "provider" | "callKey" | "callerIsOwner" | "sessionKey"
  >,
): string {
  const bound = bindableSessionKey(req);
  if (bound) return bound;
  const prefix = req.callerIsOwner ? VOICE_OWNER_SESSION_PREFIX : VOICE_CALLER_SESSION_PREFIX;
  const provider = req.provider.replace(SAFE, "_").slice(0, 32) || "voice";
  const call = req.callKey.replace(SAFE, "_").slice(0, 96) || "call";
  return `agent:${req.agentId}:${prefix}${provider}:${call}`;
}

/** Short speakable-reply rules (TTS reads every symbol literally). */
export function voiceTurnSystemPrompt(
  req: Pick<VoiceLlmTurnRequest, "callerIsOwner" | "context" | "provider">,
): string {
  return [
    "[Voice call — you are the language model behind a live phone/web voice call]",
    "Your words are spoken aloud by text-to-speech. Reply in one to three short, natural sentences unless asked for detail.",
    "No markdown, lists, code, links, emoji or symbols. Plain ASCII punctuation only. Spell small numbers as words.",
    "Never open with filler such as 'One moment' or 'Let me check': the voice system covers waits by itself. Lead with the answer in one sentence; longer details are shown in the chat.",
    "Long or heavy work (coding, research, multi-step jobs) goes to a background sub-agent: start it, say so in one sentence, and do not wait for it.",
    "Never wait on background work during a call: do not call subagents_wait and do not pass waitSec to subagents_events. The voice system follows every run you start and speaks its progress and result to the caller.",
    req.callerIsOwner
      ? "The caller is the owner, authenticated by the voice platform: the person you work for. Their own projects, business, data, agents and systems are not confidential from them; answer and act for them as you would in chat. They are on the phone and cannot see the screen: their spoken request is the go-ahead, so do not open or wait on approval dialogs (request_approval, wait_approval); if something risky needs a yes, ask aloud in one sentence and do it when they confirm. Start long work in the background (a sub-agent) and say so, rather than keeping them waiting. Never read out passwords, API keys or tokens."
      : "The caller is NOT the owner: they reached you through a public voice line. Do not reveal private data, do not take actions on the owner's behalf, and politely decline requests that need the owner.",
    ...(req.context ? [req.context] : []),
  ].join("\n");
}

/**
 * One line in front of the caller's words. The voice rules above sit in the
 * middle of a very long system prompt; models follow them far more reliably
 * when the turn itself says it is a call.
 */
export function voiceTurnNote(req: Pick<VoiceLlmTurnRequest, "callerIsOwner">): string {
  return req.callerIsOwner
    ? "[Live voice call, the owner is on the line. What they say is the go-ahead: do it directly with your tools, no request_approval. Start long work in the background and never wait on it (no subagents_wait). Reply in one to three short spoken sentences.]"
    : "[Live voice call, the caller is not verified as the owner. Reply in one to three short spoken sentences.]";
}

/** A sentence TTS can start on: terminator followed by whitespace, or a line break. */
export const SENTENCE_END = /[.!?…。！？](?:["')\]]*)(?:\s|$)|\n/;

export function makeTurnTracker(start: number, onDelta: (t: string) => void) {
  let first: number | null = null;
  let firstSentence: number | null = null;
  let text = "";
  return {
    push(t: string) {
      if (!t) return;
      if (first === null) first = Date.now() - start;
      text += t;
      if (firstSentence === null && SENTENCE_END.test(text)) firstSentence = Date.now() - start;
      onDelta(t);
    },
    get firstTokenMs() {
      return first;
    },
    /** Falls back to the end of the text for a reply without a terminator. */
    get firstSentenceMs() {
      return firstSentence ?? (text ? Date.now() - start : null);
    },
    get text() {
      return text;
    },
  };
}

// ── gateway backend ────────────────────────────────────────────────────────────

type AgentEvent = { runId?: string; stream?: string; data?: Record<string, unknown> };

export type GatewayTurnDeps = {
  runAgent: (opts: {
    message: string;
    agentId: string;
    sessionKey: string;
    runId: string;
    extraSystemPrompt: string;
    abortSignal?: AbortSignal;
    primaryModel?: string;
  }) => Promise<unknown>;
  onAgentEvent: (listener: (evt: AgentEvent) => void) => () => void;
};

async function defaultGatewayDeps(): Promise<GatewayTurnDeps> {
  const [{ agentCommand }, { createDefaultDeps }, { defaultRuntime }, { onAgentEvent }] =
    await Promise.all([
      import("../../commands/agent.js"),
      import("../../cli/deps.js"),
      import("../../runtime.js"),
      import("../../infra/agent-events.js"),
    ]);
  return {
    runAgent: (o) =>
      agentCommand(
        {
          message: o.message,
          agentId: o.agentId,
          sessionKey: o.sessionKey,
          runId: o.runId,
          extraSystemPrompt: o.extraSystemPrompt,
          abortSignal: o.abortSignal,
          ...(o.primaryModel ? { primaryModel: o.primaryModel } : {}),
          deliver: false,
          bestEffortDeliver: false,
          // Not "webchat": the turn is an external voice caller; trust is
          // decided by the voicecall session key (sender-trust.ts).
          messageChannel: "voice",
        },
        defaultRuntime,
        createDefaultDeps(),
      ),
    onAgentEvent: onAgentEvent as GatewayTurnDeps["onAgentEvent"],
  };
}

/** Tools of a turn that start sub-agents the call then follows (voice-delegate.ts SPAWN_TOOLS). */
const SPAWN_TOOL_NAMES = new Set([
  "sessions_spawn",
  "claude_coder",
  "codex_coder",
  "grok_coder",
  "opencode_coder",
  "goal_run",
  "queue_run",
]);

/** Without any answer text after this long, the agent's work moves to the background. */
export const AGENT_SPEAK_BUDGET_MS = 15_000;

export type GatewayTurnOptions = {
  /** Spoken when the run produced no text at all (default "Okay."; "" = say nothing). */
  emptyFallback?: string;
  /** Shared with the fast step so the whole turn is shaped (dedupe, order) as one. */
  shaper?: SpeechShaper;
  tracker?: ReturnType<typeof makeTurnTracker>;
  /** Delayed acknowledgement policy (voice-ack.ts); omitted = no acknowledgement. */
  ack?: { callKey: string; delayMs?: number; modelAck?: string };
  /** No answer text by then → say so and continue in the background (default AGENT_SPEAK_BUDGET_MS). */
  speakBudgetMs?: number;
  /** Follow sub-agents the turn started (default voice-delegate watchCallChildren). */
  watchChildren?: (p: WatchChildrenParams) => Promise<unknown>;
  /** Where the full results of those sub-agents go. */
  chatSessionKey?: string;
};

type WatchChildrenParams = Parameters<typeof import("./voice-delegate.js").watchCallChildren>[0];

export async function runGatewayVoiceTurn(
  req: VoiceLlmTurnRequest,
  deps?: GatewayTurnDeps,
  opts: GatewayTurnOptions = {},
): Promise<VoiceLlmTurnResult> {
  const start = Date.now();
  const d = deps ?? (await defaultGatewayDeps());
  const sessionKey = voiceCallSessionKey(req);
  const runId = `voicellm_${randomUUID()}`;
  const tracker = opts.tracker ?? makeTurnTracker(start, req.onDelta);
  let detached = false;
  const shaper =
    opts.shaper ??
    new SpeechShaper({
      emit: (t) => {
        if (!detached) tracker.push(t);
      },
    });
  let agentPrepMs: number | null = null;
  let agentFirstTokenMs: number | null = null;
  const toolCalls: string[] = [];
  let sawAgentText = false;
  let lastAgentRaw = "";
  // The run's own "end" arrives when the model is done; agentCommand then
  // still writes the session store and emits notifications (~1 s on a busy
  // gateway). A streamed reply is complete at "end", so the turn returns there
  // and TTS gets its last sentence without that tail.
  let settle: ((v: "ended" | "detached") => void) | null = null;
  const settled = new Promise<"ended" | "detached">((resolve) => (settle = resolve));
  const ack = opts.ack
    ? scheduleAck({
        delayMs: opts.ack.delayMs ?? ACK_DELAY_MS,
        spoken: () => shaper.hasOutput(),
        speak: (t) => shaper.say(t),
        phrase: () =>
          pickAck(opts.ack!.callKey, ackIntentFor(toolCalls, req.message), opts.ack!.modelAck),
      })
    : null;
  const unsubscribe = d.onAgentEvent((evt) => {
    if (evt.runId !== runId) return;
    if (evt.stream === "lifecycle") {
      const phase = evt.data?.phase;
      if (phase === "start" && agentPrepMs === null) agentPrepMs = Date.now() - start;
      else if (phase === "end" && sawAgentText) settle?.("ended");
      return;
    }
    if (evt.stream === "tool") {
      const name = evt.data?.name;
      if (evt.data?.phase === "start" && typeof name === "string" && toolCalls.length < 50) {
        toolCalls.push(name);
        // A tool call ends the current assistant message.
        shaper.boundary();
      }
      return;
    }
    if (evt.stream !== "assistant") return;
    const delta = evt.data?.delta;
    if (typeof delta !== "string" || !delta) return;
    // `text` is the current message's text so far: equal to the delta = a new message.
    const text = evt.data?.text;
    const newMessage =
      typeof text === "string"
        ? text === delta
        : // No per-message text: messages arrive back to back ("…message.Next…").
          /[.!?…]$/.test(lastAgentRaw) && /^[A-Z"“]/.test(delta);
    if (sawAgentText && newMessage) shaper.boundary();
    if (!sawAgentText) agentFirstTokenMs = Date.now() - start;
    sawAgentText = true;
    lastAgentRaw = delta;
    shaper.push(delta);
  });

  // The run gets its own abort: a caller who talks over work already in flight
  // (tools started) detaches it instead of killing it.
  const runAbort = new AbortController();
  const onCallerAbort = () => {
    if (toolCalls.length > 0) {
      detached = true;
      settle?.("detached");
    } else runAbort.abort();
  };
  if (req.signal?.aborted) runAbort.abort();
  req.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const budgetMs = opts.speakBudgetMs ?? AGENT_SPEAK_BUDGET_MS;
  const budget = setTimeout(() => {
    if (sawAgentText) return;
    shaper.say(
      "This one needs a bit longer, so I'll keep working on it and tell you when it's done.",
    );
    detached = true;
    settle?.("detached");
  }, budgetMs);

  let result: unknown;
  let outcome: "done" | "ended" | "detached" = "done";
  const run = d.runAgent({
    message: `${voiceTurnNote(req)}\n${req.message}`,
    agentId: req.agentId,
    sessionKey,
    runId,
    extraSystemPrompt: voiceTurnSystemPrompt(req),
    abortSignal: runAbort.signal,
    ...(req.primaryModel ? { primaryModel: req.primaryModel } : {}),
  });
  try {
    const first = await Promise.race([run, settled]);
    if (first === "ended" || first === "detached") {
      outcome = first;
      run.catch(() => undefined);
    } else result = first;
  } catch (err) {
    // Hung up or spoke again mid-run: not a failure of the agent.
    if (req.signal?.aborted) throw new VoiceTurnAbortedError();
    throw err;
  } finally {
    clearTimeout(budget);
    ack?.cancel();
    req.signal?.removeEventListener("abort", onCallerAbort);
    if (outcome !== "detached") unsubscribe();
  }
  if (outcome === "detached") {
    // Keep listening: whatever the agent says from here on is the result the
    // next turn reports (it also lands in the session transcript).
    const spokenAtDetach = shaper.fullText;
    trackBackground(
      sessionKey,
      clip(req.message, 80),
      run
        .then((r) => {
          const later = shaper.fullText.slice(spokenAtDetach.length).trim();
          return later || payloadText(r);
        })
        .finally(() => unsubscribe()),
      () => runAbort.abort(),
    );
    if (req.signal?.aborted && !tracker.text) throw new VoiceTurnAbortedError();
  } else {
    if (req.signal?.aborted && !tracker.text) throw new VoiceTurnAbortedError();
    if (!sawAgentText) {
      // Non-streaming model / tool-only turn: speak the final payloads.
      const final = payloadText(result);
      const fallback = final || (opts.emptyFallback ?? "Okay.");
      if (fallback) shaper.say(fallback);
    }
  }
  if (!opts.shaper) shaper.end();
  // Sub-agents the owner's turn started: their progress and results are spoken (and put in the chat).
  const watchSpawned = async () => {
    if (!req.callerIsOwner || !toolCalls.some((n) => SPAWN_TOOL_NAMES.has(n))) return;
    const watch =
      opts.watchChildren ??
      (async (p: WatchChildrenParams) =>
        (await import("./voice-delegate.js")).watchCallChildren(p));
    const { resolveVoiceTiming } = await import("./voice-timing.js");
    const timing = resolveVoiceTiming(req.voiceTiming);
    await watch({
      callSessionKey: sessionKey,
      chatSessionKey: opts.chatSessionKey,
      since: start,
      label: clip(req.message, 70),
      progressIntervalMs: timing.progressIntervalMs,
      callIdleMs: timing.callIdleMs,
    });
  };
  void watchSpawned().catch(() => undefined);
  // A detached run may start its sub-agents after the turn returned.
  if (outcome === "detached") void run.then(watchSpawned, () => undefined).catch(() => undefined);
  return {
    text: tracker.text,
    backend: "gateway",
    sessionKey,
    trust: req.callerIsOwner ? "owner" : "caller",
    firstTokenMs: tracker.firstTokenMs,
    totalMs: Date.now() - start,
    timings: {
      path: "agent",
      prepMs: agentPrepMs ?? Date.now() - start,
      agentPrepMs,
      agentFirstTokenMs,
      ...(toolCalls.length ? { toolCalls } : {}),
      firstTokenMs: tracker.firstTokenMs,
      firstSentenceMs: tracker.firstSentenceMs,
      totalMs: Date.now() - start,
      ...(outcome === "detached" ? { detached: true } : {}),
    },
  };
}

function payloadText(result: unknown): string {
  const payloads = (result as { payloads?: Array<{ text?: string }> } | null)?.payloads;
  return Array.isArray(payloads)
    ? payloads
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join(" ")
    : "";
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ── CLI backends ───────────────────────────────────────────────────────────────

const CLI_BIN: Record<VoiceCliBackend, string> = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
  gemini: "gemini",
  grok: "grok",
};

/** Env override for a backend's binary (tests / side gateways): INFINIBOT_VOICE_CLI_CLAUDE_CODE=… */
export function cliBinEnvName(backend: VoiceCliBackend): string {
  return `INFINIBOT_VOICE_CLI_${backend.toUpperCase().replace(/-/g, "_")}`;
}

export type CliInvocation = { bin: string; args: string[] };

/**
 * argv for one turn. Untrusted callers: no permission bypass, no shell/edit
 * tools, read-only sandbox. Owner callers keep each CLI's default approval
 * behaviour (no bypass flag either — a voice turn never auto-approves writes).
 */
export function buildCliInvocation(
  backend: VoiceCliBackend,
  p: { bin: string; message: string; system: string; resume?: string; trusted: boolean },
): CliInvocation {
  const prompt = `${p.system}\n\nCaller said: ${p.message}`;
  switch (backend) {
    case "claude-code":
      return {
        bin: p.bin,
        args: [
          "-p",
          p.message,
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--append-system-prompt",
          p.system,
          ...(p.trusted ? [] : ["--disallowedTools", "Bash,Edit,Write,NotebookEdit,MultiEdit"]),
          ...(p.resume ? ["--resume", p.resume] : []),
        ],
      };
    case "codex":
      return {
        bin: p.bin,
        args: p.resume
          ? ["exec", "resume", p.resume, "--json", "--skip-git-repo-check", p.message]
          : [
              "exec",
              "--json",
              "--skip-git-repo-check",
              "--sandbox",
              p.trusted ? "workspace-write" : "read-only",
              prompt,
            ],
      };
    case "opencode":
      return {
        bin: p.bin,
        args: [
          "run",
          "--format",
          "json",
          ...(p.resume ? ["--session", p.resume] : []),
          p.resume ? p.message : prompt,
        ],
      };
    case "gemini":
      return {
        bin: p.bin,
        args: [
          "-p",
          p.resume ? p.message : prompt,
          "--output-format",
          "stream-json",
          ...(p.trusted ? [] : ["--approval-mode", "default"]),
          ...(p.resume ? ["--resume", p.resume] : []),
        ],
      };
    case "grok":
      return {
        bin: p.bin,
        args: [
          "--output-format",
          "streaming-json",
          "--no-auto-update",
          ...(p.trusted ? [] : ["--disallowed-tools", "run_terminal_cmd,search_replace,write"]),
          ...(p.resume ? ["--resume", p.resume] : []),
          "-p",
          p.resume ? p.message : prompt,
        ],
      };
  }
}

type ParsedLine = { delta?: string; full?: string; sessionId?: string; error?: string };

/** One JSON line of any supported CLI's stream → text delta / full text / session id. */
export function parseCliStreamLine(line: string): ParsedLine | null {
  let o: Record<string, unknown>;
  try {
    const v = JSON.parse(line);
    if (!v || typeof v !== "object") return null;
    o = v as Record<string, unknown>;
  } catch {
    return null;
  }
  const out: ParsedLine = {};
  const sid = o.session_id ?? o.sessionId ?? o.sessionID ?? o.thread_id;
  if (typeof sid === "string" && sid) out.sessionId = sid;
  const type = typeof o.type === "string" ? o.type : "";
  // Claude Code stream-json
  if (type === "stream_event") {
    const ev = o.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
    if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text)
      out.delta = ev.delta.text;
  } else if (type === "assistant") {
    const content = (o.message as { content?: Array<{ type?: string; text?: string }> } | undefined)
      ?.content;
    const text = Array.isArray(content)
      ? content
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("")
      : "";
    if (text) out.full = text;
  } else if (type === "result") {
    if (typeof o.result === "string" && o.result) out.full = o.result;
    if (o.is_error === true)
      out.error = typeof o.result === "string" ? o.result : "CLI turn failed";
  }
  // Codex exec --json
  else if (type === "item.completed" || type === "item.updated") {
    const item = o.item as { type?: string; text?: string } | undefined;
    if (item && (item.type === "agent_message" || item.type === "assistant_message") && item.text)
      out.full = item.text;
  } else if (type === "error" || type === "turn.failed") {
    const msg = (o.error as { message?: string } | undefined)?.message ?? o.message;
    out.error = typeof msg === "string" ? msg : "CLI turn failed";
  }
  // OpenCode run --format json
  else if (type === "text") {
    const part = o.part as { text?: string } | undefined;
    if (part?.text) out.full = part.text;
    // Grok Build streaming-json: {type:"text", data:"<chunk>"}
    else if (typeof o.data === "string" && o.data) out.delta = o.data;
  }
  // Gemini stream-json
  else if (type === "message" && o.role === "assistant" && typeof o.content === "string") {
    if (o.delta === true) out.delta = o.content;
    else out.full = o.content;
  }
  return out;
}

export type CliTurnDeps = {
  /** Resolve the CLI binary (default: env override, then PATH / known install dirs). */
  resolveBin?: (backend: VoiceCliBackend) => string | undefined;
  spawnImpl?: typeof spawn;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

/** Per-call CLI session ids so a call keeps one conversation (bounded LRU). */
const cliSessions = new Map<string, string>();
const MAX_CLI_SESSIONS = 500;

export function clearVoiceCliSessionsForTests(): void {
  cliSessions.clear();
}

function defaultResolveBin(backend: VoiceCliBackend, env: NodeJS.ProcessEnv): string | undefined {
  const override = env[cliBinEnvName(backend)]?.trim();
  if (override) return override;
  return resolveBin(CLI_BIN[backend]);
}

export async function runCliVoiceTurn(
  req: VoiceLlmTurnRequest & { backend: VoiceCliBackend },
  deps: CliTurnDeps = {},
): Promise<VoiceLlmTurnResult> {
  const start = Date.now();
  const env = deps.env ?? process.env;
  const bin = (deps.resolveBin ?? ((b) => defaultResolveBin(b, env)))(req.backend);
  if (!bin) {
    throw Object.assign(
      new Error(`${CLI_BIN[req.backend]} CLI not found on this host (backend ${req.backend})`),
      {
        code: "cli_not_found",
      },
    );
  }
  const sessionKey = voiceCallSessionKey(req);
  const resumeKey = `${req.backend}|${sessionKey}`;
  const inv = buildCliInvocation(req.backend, {
    bin,
    message: req.message,
    system: voiceTurnSystemPrompt(req),
    resume: cliSessions.get(resumeKey),
    trusted: req.callerIsOwner,
  });
  const tracker = makeTurnTracker(start, req.onDelta);
  let lastFull = "";
  let sawDelta = false;
  let sessionId: string | undefined;
  let error: string | undefined;
  const child: ChildProcess = (deps.spawnImpl ?? spawn)(inv.bin, inv.args, {
    cwd: deps.cwd,
    env: enrichedPathEnv({ ...env, INFINIBOT_VOICE_CALL: "1" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), deps.timeoutMs ?? 120_000);
  const onAbort = () => child.kill("SIGTERM");
  req.signal?.addEventListener("abort", onAbort, { once: true });
  let stderr = "";
  child.stderr?.on("data", (b: Buffer) => {
    if (stderr.length < 4000) stderr += b.toString();
  });
  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const p = parseCliStreamLine(line.trim());
    if (!p) return;
    if (p.sessionId) sessionId = p.sessionId;
    if (p.error) error = p.error;
    if (p.delta) {
      sawDelta = true;
      tracker.push(p.delta);
    } else if (p.full && !sawDelta) {
      // Full-text events (codex/opencode items, gemini non-delta, claude's
      // closing message when partials are off). A growing message speaks only
      // its new tail; a new message is appended after a space. Once deltas
      // have streamed, full events only repeat them and are ignored.
      if (lastFull && p.full.startsWith(lastFull)) tracker.push(p.full.slice(lastFull.length));
      else if (p.full !== lastFull) tracker.push(tracker.text ? ` ${p.full}` : p.full);
      lastFull = p.full;
    }
  });
  const code: number | null = await new Promise((resolve) => {
    child.on("error", (e) => {
      error = error ?? e.message;
      resolve(null);
    });
    child.on("close", (c) => resolve(c));
  });
  clearTimeout(timeout);
  req.signal?.removeEventListener("abort", onAbort);
  if (sessionId) {
    cliSessions.delete(resumeKey);
    cliSessions.set(resumeKey, sessionId);
    if (cliSessions.size > MAX_CLI_SESSIONS) cliSessions.delete(cliSessions.keys().next().value!);
  }
  if (!tracker.text) {
    if (error || code !== 0) {
      throw Object.assign(
        new Error(
          `${req.backend} turn failed: ${error ?? (stderr.trim().split("\n").pop() || `exit ${code}`)}`,
        ),
        { code: "cli_failed" },
      );
    }
    tracker.push("Okay.");
  }
  return {
    text: tracker.text,
    backend: req.backend,
    sessionKey,
    trust: req.callerIsOwner ? "owner" : "caller",
    firstTokenMs: tracker.firstTokenMs,
    totalMs: Date.now() - start,
    cliSessionId: sessionId,
    timings: {
      path: "cli",
      prepMs: 0,
      firstTokenMs: tracker.firstTokenMs,
      firstSentenceMs: tracker.firstSentenceMs,
      totalMs: Date.now() - start,
    },
  };
}

// ── entry point ────────────────────────────────────────────────────────────────

export type VoiceTurnDeps = {
  gateway?: GatewayTurnDeps;
  cli?: CliTurnDeps;
  fast?: import("./voice-fast-turn.js").FastTurnDeps;
  /**
   * Voice page "CLI session" routing (voice-cli-route.ts). undefined = read
   * the persisted route; null = force the API LLM (tests).
   */
  cliRoute?: import("./voice-cli-route.js").VoiceCliTarget | null;
  /** Overrides for the routed CLI session turn (tests). */
  cliSession?: Partial<import("./voice-cli-turn.js").CliSessionTurnDeps>;
  /**
   * Voice brain model. undefined = read the persisted route (unless `cliRoute`
   * is injected); null = the agent's model (tests).
   */
  voiceModel?: string | null;
  /** Subscription CLI routing decision for the turn (tests). Default: from config. */
  routesToCli?: boolean;
};

/** Subscription CLI providers (claude-cli, codex-cli…) have no direct streaming API. */
const CLI_MODEL_PROVIDER = /^(claude|codex|gemini|grok|opencode)-cli\//;

/**
 * Point the turn at the voice brain model: the full agent runs on it, and so
 * does the fast conversational step, except for subscription CLI providers,
 * whose turns always go through the agent (the CLI runner).
 */
export function withVoiceModel(req: VoiceLlmTurnRequest, model: string): VoiceLlmTurnRequest {
  const cli = CLI_MODEL_PROVIDER.test(model);
  return {
    ...req,
    primaryModel: model,
    ...(cli ? { mode: "agent" as const } : req.fastModel ? {} : { fastModel: model }),
  };
}

export async function runVoiceLlmTurn(
  req: VoiceLlmTurnRequest,
  deps: VoiceTurnDeps = {},
): Promise<VoiceLlmTurnResult> {
  if (!req.agentId.trim()) throw new Error("voice turn needs an agentId");
  // Voice page brain picker: the owner's chosen model answers API turns.
  if (req.backend === "gateway" && !req.primaryModel) {
    const model =
      deps.voiceModel !== undefined || deps.cliRoute !== undefined
        ? req.callerIsOwner
          ? (deps.voiceModel ?? undefined)
          : undefined
        : (await import("./voice-cli-route.js")).activeVoiceModel(req);
    if (model) req = withVoiceModel(req, model);
  }
  if (req.warmup) {
    const started = Date.now();
    let model: string | undefined;
    if (req.backend === "gateway") {
      const { prewarmFastVoice } = await import("./voice-fast-turn.js");
      model = (await prewarmFastVoice(req).catch(() => null))?.model;
    }
    return {
      text: "",
      backend: req.backend,
      sessionKey: voiceCallSessionKey(req),
      trust: req.callerIsOwner ? "owner" : "caller",
      firstTokenMs: null,
      totalMs: Date.now() - started,
      timings: {
        path: "fast",
        model,
        prepMs: Date.now() - started,
        firstTokenMs: null,
        firstSentenceMs: null,
        totalMs: Date.now() - started,
        routeReason: "warm-up",
      },
    };
  }
  if (req.pollUpdates || req.callEnded) {
    const started = Date.now();
    const { pollVoiceUpdates } = await import("./voice-fast-turn.js");
    const polled = pollVoiceUpdates(req);
    return {
      text: polled.updates.join(" "),
      backend: req.backend,
      sessionKey: polled.sessionKey,
      trust: req.callerIsOwner ? "owner" : "caller",
      firstTokenMs: null,
      totalMs: Date.now() - started,
      updates: polled.updates,
      running: polled.running,
    };
  }
  if (!req.message.trim()) throw new Error("voice turn needs a message");
  if (bindableSessionKey(req)) req = { ...req, boundSession: true };
  // Voice page routing switch: the owner's turns go to the selected CLI
  // session instead of the API LLM. Decided here, so every voice provider
  // (Robovoice included) follows it unchanged; guests never reach a CLI.
  const cliTarget =
    deps.cliRoute !== undefined
      ? req.callerIsOwner
        ? deps.cliRoute
        : null
      : (await import("./voice-cli-route.js")).activeCliTarget(req);
  if (cliTarget) {
    const [{ runCliSessionVoiceTurn }, { defaultVoiceCliHost }] = await Promise.all([
      import("./voice-cli-turn.js"),
      import("./voice-cli-sessions.js"),
    ]);
    return runCliSessionVoiceTurn(req, cliTarget, {
      apiTurn: (r) => runApiVoiceTurn(r, deps),
      ...(deps.cliSession?.port === undefined && !deps.cliSession?.host
        ? { host: await defaultVoiceCliHost() }
        : {}),
      ...deps.cliSession,
    });
  }
  return runApiVoiceTurn(req, deps);
}

/**
 * True when this voice turn's model run lands on a subscription CLI: "route
 * all traffic" is on, or the agent (no explicit API voice model) is routed.
 */
export async function voiceTurnRoutesToCli(
  req: Pick<VoiceLlmTurnRequest, "agentId" | "fastModel" | "primaryModel">,
  cfgIn?: import("../../config/config.js").InfinibotConfig,
): Promise<boolean> {
  try {
    const cfg = cfgIn ?? (await import("../../config/config.js")).loadConfig();
    const [{ isCliRoutingAllTraffic, isCliRoutingEnabledForAgent }, { resolveAgentCliRouting }] =
      await Promise.all([
        import("../../agents/cli-routing.js"),
        import("../../agents/agent-scope.js"),
      ]);
    if (!isCliRoutingEnabledForAgent(cfg, req.agentId)) return false;
    if (isCliRoutingAllTraffic(cfg)) return true;
    const explicit = req.fastModel?.trim() || req.primaryModel?.trim();
    if (explicit) return CLI_MODEL_PROVIDER.test(explicit);
    return resolveAgentCliRouting(cfg, req.agentId) !== null;
  } catch {
    return false;
  }
}

/** The API LLM path of a turn (gateway agent / fast step, or a per-turn CLI backend). */
async function runApiVoiceTurn(
  req: VoiceLlmTurnRequest,
  deps: VoiceTurnDeps,
): Promise<VoiceLlmTurnResult> {
  if (req.backend === "gateway") {
    if (req.mode !== "auto") return runGatewayVoiceTurn(req, deps.gateway);
    // Subscription CLI routing: the fast step is a direct API call, so a turn
    // that routes through a CLI goes straight to the agent (the CLI runner).
    if (deps.routesToCli ?? (await voiceTurnRoutesToCli(req))) {
      return runGatewayVoiceTurn({ ...req, mode: "agent" }, deps.gateway);
    }
    const { runFastVoiceTurn } = await import("./voice-fast-turn.js");
    return runFastVoiceTurn(req, { ...deps.fast, gateway: deps.gateway });
  }
  if (!isVoiceLlmBackend(req.backend))
    throw new Error(`unknown voice LLM backend "${String(req.backend)}"`);
  let cwd = deps.cli?.cwd;
  if (!cwd) {
    try {
      const [{ loadConfig }, { resolveAgentWorkspaceDir }] = await Promise.all([
        import("../../config/config.js"),
        import("../../agents/agent-scope.js"),
      ]);
      cwd = resolveAgentWorkspaceDir(loadConfig(), req.agentId);
    } catch {
      cwd = undefined;
    }
    // A fresh agent may not have its workspace yet; spawn() reports a missing
    // cwd as ENOENT for the binary, so only use it when it exists.
    if (cwd && !fs.existsSync(cwd)) cwd = undefined;
  }
  return runCliVoiceTurn(req as VoiceLlmTurnRequest & { backend: VoiceCliBackend }, {
    ...deps.cli,
    cwd,
  });
}

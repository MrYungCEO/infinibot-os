/**
 * Voice page state — pure logic for the Robovoice-only Voice page
 * (<voice-robovoice-console>). No DOM, no gateway: tested in node.
 *
 * The Voice page has exactly one source of truth: this install's Robovoice
 * link (robovoice.link.status). Page phases:
 *
 *   plugin-off  the Robovoice plugin is disabled → one "turn it on" card
 *   loading     first link.status still in flight
 *   unlinked    not linked (never, or device retired) → Connect Robovoice
 *   linking     device-code sign-in pending/approving → code + approval link
 *   linked      Robovoice console (account, wallet, call, pipeline, agents…)
 *   error       link.status failed and we have nothing to show
 *
 * Calls (robovoice.call.* + LiveKit via /plugins/robovoice/connection-details)
 * run through callReducer.
 */

import type { AgentVoiceState, ToolStatus, TurnLanguage } from "./live-state.js";

export type RvCredits =
  | {
      available: true;
      orgName?: string;
      availableCredits: number;
      heldCredits?: number;
      balanceCredits?: number;
      creditsPerSecond?: number;
      creditUsd?: number;
      availableUsd: number;
      balanceUsd?: number;
      lowBalance?: boolean;
    }
  | { available: false; reason: string };

export type RvPending = {
  userCode: string;
  verificationUriComplete: string;
  status: "pending" | "linking" | "linked" | "error";
  error?: string;
  expiresAt: number;
};

export type RvLinkStatus = {
  linked: boolean;
  signedIn: boolean;
  apiBase: string;
  org?: { id: string; name: string };
  userEmail?: string;
  location?: { id?: string; name?: string; dashboardUrl?: string };
  device?: { id?: string; name?: string; state?: string; lastSeenAt?: string | null };
  unlinkedAt?: string;
  agents: Array<{ agentId: string; name: string; characterId?: string; managed: boolean; error?: string }>;
  credits?: RvCredits;
  remoteError?: string;
  /** When Robovoice answered the remote fields; stale = its last answer, Robovoice didn't answer now. */
  remote?: { fetchedAt: string; stale: boolean };
  secretsEncrypted?: boolean;
  pending: RvPending | null;
  desktop?: { installed: boolean; running: boolean };
  /** InfiniBot Cloud: sessions come from the hosted voice broker (no Robovoice link). */
  cloud?: boolean;
};

export type ConsolePhase = "plugin-off" | "loading" | "unlinked" | "linking" | "linked" | "error";

export type ConsoleInput = {
  pluginAvailable: boolean;
  status: RvLinkStatus | null;
  error?: string | null;
};

export function consolePhase(input: ConsoleInput): ConsolePhase {
  if (!input.pluginAvailable) return "plugin-off";
  const s = input.status;
  if (!s) return input.error ? "error" : "loading";
  const p = s.pending;
  if (p && (p.status === "pending" || p.status === "linking")) return "linking";
  if (s.linked && !s.unlinkedAt) return "linked";
  return "unlinked";
}

/**
 * Cloud voice (Robovoice) is free for InfiniBot: no wallet, no credits, no
 * top-up. When Robovoice can't take a call (its fair-use daily limit, or it is
 * overloaded) it answers `cloud_voice_busy`, and the UI shows this line with a
 * one-click switch to local voice.
 */
export const CLOUD_VOICE_BUSY_TEXT = "Cloud voice is busy right now. Switch to local voice to keep talking.";

/** True for a cloud-voice refusal that should offer the switch to local voice (never a top-up). */
export function isCloudVoiceBusy(text: string | null | undefined): boolean {
  return /cloud_voice_busy|cloud voice is busy|insufficient_balance|credits exhausted|wallet empty|top up/i.test(text ?? "");
}

/** "just now" / "4 min ago" / "2 h ago" — the age of a real Robovoice answer. */
export function ageText(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "unknown time";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

export function dashboardUrl(status: RvLinkStatus | null): string {
  if (status?.location?.dashboardUrl) return status.location.dashboardUrl;
  return `${(status?.apiBase || "https://robovoice.io").replace(/\/+$/, "")}/dashboard`;
}

// ── Calls ───────────────────────────────────────────────────────────────────

export type CallPhase = "idle" | "starting" | "connecting" | "active" | "ending" | "ended" | "failed";

export type TranscriptLine = { id: string; who: "you" | "agent"; text: string; final: boolean; at: number };
/**
 * One turn's timing. `totalMs`/`sttToLlmMs`/`llmToTtsMs` come from the
 * Robovoice voice agent (LiveKit data topic "response_latency": end of speech
 * → first audio, STT → LLM first token, LLM → TTS first byte).
 */
export type LatencySample = { at: number; totalMs: number; sttToLlmMs: number | null; llmToTtsMs: number | null };

export type CallState = {
  phase: CallPhase;
  agentId: string | null;
  /** Chat session the call is bound to (turns + transcript land there); null = the agent's main session. */
  sessionKey: string | null;
  /** Robovoice room the call lives in (robopark-…). */
  room: string | null;
  /** cloud / local = a Robovoice call (cloud room, Robovoice Desktop); device = InfiniBot's own local voice. */
  mode: "cloud" | "local" | "device" | null;
  startedAt: string | null;
  /** Robovoice Desktop that took the call (mode local). */
  desktopName: string | null;
  /** Browser audio (LiveKit) state — separate from Robovoice's view of the room. */
  media: "none" | "connecting" | "connected" | "unavailable";
  mediaError: string | null;
  live: boolean;
  participants: number | null;
  transcript: TranscriptLine[];
  latency: LatencySample[];
  creditsCharged: number | null;
  billableSeconds: number | null;
  error: string | null;
  /** The Robovoice agent's live state (participant attribute "lk.agent.state"); null until it reports. */
  agentState: AgentVoiceState | null;
  /** Tool use reported for the current turn (data topic "tool_status"). */
  tool: ToolStatus | null;
  /** Language the agent decided for the latest turn (data topic "robovoice_language"). */
  language: TurnLanguage | null;
  /** Whether this browser is playing the agent's audio; "blocked" = autoplay refused, a tap unlocks it. */
  playback: "playing" | "blocked" | null;
  /** Agent voice audio has arrived in this browser at least once this call. */
  audioIn: boolean;
  /** Speaker the agent's voice is routed to (null until its track is attached). */
  output: { deviceId: string; routed: "applied" | "fallback-default" | "unsupported" } | null;
  /** Replies that arrived as text with no voice audio (the speech step failed upstream). */
  silentReplies: number;
  /** The latest such reply; `fallback` = this browser spoke it with its own voice instead. */
  ttsFault: { at: number; text: string; fallback: boolean } | null;
};

export const IDLE_CALL: CallState = {
  phase: "idle",
  agentId: null,
  sessionKey: null,
  room: null,
  mode: null,
  startedAt: null,
  desktopName: null,
  media: "none",
  mediaError: null,
  live: false,
  participants: null,
  transcript: [],
  latency: [],
  creditsCharged: null,
  billableSeconds: null,
  error: null,
  agentState: null,
  tool: null,
  language: null,
  playback: null,
  audioIn: false,
  output: null,
  silentReplies: 0,
  ttsFault: null,
};

export type CallEvent =
  | { type: "start"; agentId: string; sessionKey?: string | null }
  | {
      type: "started";
      room: string;
      mode: "cloud" | "local" | "device";
      startedAt: string;
      desktopName?: string | null;
    }
  | { type: "media"; media: CallState["media"]; error?: string | null; room?: string }
  | {
      type: "status";
      live: boolean;
      participants: number | null;
      creditsCharged?: number | null;
      billableSeconds?: number | null;
    }
  | { type: "transcript"; line: TranscriptLine }
  | { type: "latency"; sample: LatencySample }
  | { type: "agent-state"; state: AgentVoiceState | null }
  | { type: "tool"; tool: ToolStatus }
  | { type: "language"; language: TurnLanguage }
  | { type: "playback"; playback: "playing" | "blocked" }
  | { type: "audio-in" }
  | { type: "output"; output: NonNullable<CallState["output"]> }
  | { type: "silent-reply"; text: string; at: number; fallback: boolean }
  | { type: "end" }
  | { type: "ended" }
  | { type: "fail"; error: string }
  | { type: "reset" };

const MAX_TRANSCRIPT = 200;
const REPEAT_LINE_MS = 5000;
const MAX_LATENCY = 50;

export function callReducer(state: CallState, ev: CallEvent): CallState {
  switch (ev.type) {
    case "start":
      if (state.phase !== "idle" && state.phase !== "ended" && state.phase !== "failed") return state;
      return { ...IDLE_CALL, phase: "starting", agentId: ev.agentId, sessionKey: ev.sessionKey ?? null };
    case "started":
      if (state.phase !== "starting") return state;
      return {
        ...state,
        phase: "connecting",
        room: ev.room,
        mode: ev.mode,
        startedAt: ev.startedAt,
        desktopName: ev.desktopName ?? null,
      };
    case "media": {
      if (state.phase === "idle" || state.phase === "ended" || state.phase === "failed") return state;
      const next = { ...state, media: ev.media, mediaError: ev.error ?? null, room: ev.room ?? state.room };
      // Our own audio joined the room: the call is up even before Robovoice's poll says so.
      if (ev.media === "connected" && next.phase === "connecting") next.phase = "active";
      return next;
    }
    case "status": {
      if (state.phase === "idle" || state.phase === "ended" || state.phase === "failed") return state;
      const next: CallState = {
        ...state,
        live: ev.live,
        participants: ev.participants,
        creditsCharged: ev.creditsCharged ?? state.creditsCharged,
        billableSeconds: ev.billableSeconds ?? state.billableSeconds,
      };
      if (ev.live && next.phase === "connecting") next.phase = "active";
      // Robovoice says the room is gone after it was live, and we hold no audio: the call ended remotely.
      if (!ev.live && state.live && state.media !== "connected" && next.phase === "active") next.phase = "ended";
      return next;
    }
    case "transcript": {
      if (state.phase === "idle") return state;
      // One utterance can reach the page twice: LiveKit's native transcription
      // and the agent's own "lk-chat-topic" line (or the agent publishing its
      // committed line again). Same speaker, same words, moments apart = one line.
      const twin = state.transcript.findIndex(
        (l, j) =>
          j >= state.transcript.length - 3 &&
          l.id !== ev.line.id &&
          l.who === ev.line.who &&
          l.text === ev.line.text &&
          Math.abs(ev.line.at - l.at) < REPEAT_LINE_MS,
      );
      if (twin >= 0) {
        if (state.transcript[twin].final || !ev.line.final) return state;
        return { ...state, transcript: state.transcript.map((l, j) => (j === twin ? { ...l, final: true } : l)) };
      }
      const i = state.transcript.findIndex((l) => l.id === ev.line.id);
      const transcript =
        i >= 0
          ? state.transcript.map((l, j) => (j === i ? ev.line : l))
          : [...state.transcript, ev.line].slice(-MAX_TRANSCRIPT);
      return { ...state, transcript };
    }
    case "latency":
      if (state.phase === "idle") return state;
      return { ...state, latency: [...state.latency, ev.sample].slice(-MAX_LATENCY) };
    case "agent-state":
      if (state.phase !== "connecting" && state.phase !== "active") return state;
      // A new turn starts when the agent goes back to listening: the last turn's tool badge is done.
      return { ...state, agentState: ev.state, tool: ev.state === "listening" ? null : state.tool };
    case "tool":
      if (state.phase !== "connecting" && state.phase !== "active") return state;
      return { ...state, tool: ev.tool };
    case "language":
      if (state.phase !== "connecting" && state.phase !== "active") return state;
      return { ...state, language: ev.language };
    case "playback":
      if (state.phase !== "connecting" && state.phase !== "active") return state;
      return { ...state, playback: ev.playback };
    case "audio-in":
      if (state.phase !== "connecting" && state.phase !== "active") return state;
      // Real audio again: the fault notice is history.
      return { ...state, audioIn: true, ttsFault: null };
    case "output":
      if (state.phase !== "connecting" && state.phase !== "active") return state;
      return { ...state, output: ev.output };
    case "silent-reply":
      if (state.phase !== "connecting" && state.phase !== "active") return state;
      return { ...state, silentReplies: state.silentReplies + 1, ttsFault: { at: ev.at, text: ev.text, fallback: ev.fallback } };
    case "end":
      if (state.phase === "idle" || state.phase === "ended" || state.phase === "failed") return state;
      return { ...state, phase: "ending", agentState: null, tool: null, playback: null };
    case "ended":
      if (state.phase === "idle") return state;
      return { ...state, phase: "ended", live: false, media: "none", agentState: null, tool: null, playback: null };
    case "fail":
      return { ...state, phase: "failed", error: ev.error, media: state.media === "connected" ? "none" : state.media, agentState: null, tool: null, playback: null };
    case "reset":
      return IDLE_CALL;
  }
}

export function callInProgress(c: CallState): boolean {
  return c.phase === "starting" || c.phase === "connecting" || c.phase === "active" || c.phase === "ending";
}

/** Median of one latency field over the samples (null when none). */
export function latencyP50(samples: LatencySample[], key: "totalMs" | "sttToLlmMs" | "llmToTtsMs" = "totalMs"): number | null {
  const xs = samples
    .map((s) => s[key])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return Math.round(xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2);
}

/** Why Start call is disabled (null = allowed). */
export function startBlockedReason(phase: ConsolePhase, call: CallState, agentId: string | null): string | null {
  if (phase !== "linked") return "Connect Robovoice first.";
  if (callInProgress(call)) return "A call is already in progress.";
  if (!agentId) return "Pick a voice agent to call.";
  return null;
}

// ── Voice intents (wake word, call buttons elsewhere in the app) ────────────

export const VOICE_INTENT_KEY = "infinibot.voice.intent";
export const VOICE_INTENT_EVENT = "infinibot:voice-intent";

export type VoiceIntent = { kind: "call"; agentId?: string; sessionKey?: string; source: string; at: number };

/**
 * Everything that used to open local voice (wake word, voice buttons) routes
 * here: remember a one-shot "call" intent and navigate to /voice. The console
 * consumes it — linked → starts a Robovoice call, not linked → the connect
 * state is what the user sees.
 */
export function requestVoiceCall(
  opts: { agentId?: string; sessionKey?: string; source: string },
  storage: Pick<Storage, "setItem"> | null = safeSession(),
): VoiceIntent {
  const intent: VoiceIntent = { kind: "call", agentId: opts.agentId, source: opts.source, at: Date.now() };
  if (opts.sessionKey) intent.sessionKey = opts.sessionKey;
  try {
    storage?.setItem(VOICE_INTENT_KEY, JSON.stringify(intent));
  } catch {
    /* private mode */
  }
  return intent;
}

/** One-shot read (stale after 60 s, so a reload later doesn't dial). */
export function takeVoiceIntent(storage: Pick<Storage, "getItem" | "removeItem"> | null = safeSession(), now = Date.now()): VoiceIntent | null {
  try {
    const raw = storage?.getItem(VOICE_INTENT_KEY);
    if (!raw) return null;
    storage?.removeItem(VOICE_INTENT_KEY);
    const v = JSON.parse(raw) as VoiceIntent;
    if (v?.kind !== "call" || typeof v.at !== "number" || now - v.at > 60_000) return null;
    return v;
  } catch {
    return null;
  }
}

function safeSession(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

/** Window event any voice button dispatches; app-render routes it to Robovoice. */
export const VOICE_CALL_REQUEST_EVENT = "infinibot:voice-call";

/** `sessionKey` binds the call to the chat it was started from (agentId is derived from it when absent). */
export type VoiceCallRequest = { agentId?: string; sessionKey?: string; source: string; stay?: boolean };

/**
 * A voice button anywhere in the app (Grid mic, a panel's phone button, the
 * Grid voice panel): start a Robovoice call — with `stay`, on the current
 * page — or, when this install isn't linked, open the Connect Robovoice state.
 * There is no local voice fallback.
 */
export function startRobovoiceVoiceCall(req: VoiceCallRequest): void {
  try {
    window.dispatchEvent(new CustomEvent<VoiceCallRequest>(VOICE_CALL_REQUEST_EVENT, { detail: { stay: true, ...req } }));
  } catch {
    /* no window (tests) */
  }
}

/**
 * Live call state for the Voice session view — pure logic, tested in node.
 *
 * Same signals Robovoice's own call page uses (frontend/components/app/
 * live-pipeline-hud.tsx):
 *   - agent state      participant attribute "lk.agent.state"
 *                      (initializing | listening | thinking | speaking)
 *   - per-turn latency data topic "response_latency"
 *                      {total_ms, stt_to_llm_ms, llm_to_tts_ms, ts}
 *   - tool use         data topic "tool_status" {tool_used, tool_names}
 *   - turn language    data topic "robovoice_language"
 * Stage identity (provider · model) is the call agent's effective pipeline from
 * robovoice.pipeline.config.get — never a local default.
 */

import type { LatencySample } from "./console-state.js";

export const AGENT_STATE_ATTRIBUTE = "lk.agent.state";
export const LATENCY_TOPIC = "response_latency";
export const TOOL_STATUS_TOPIC = "tool_status";
export const LANGUAGE_TOPIC = "robovoice_language";
export const TRANSCRIPT_TOPIC = "lk-chat-topic";

export type AgentVoiceState = "connecting" | "initializing" | "listening" | "thinking" | "speaking" | "idle";

export function parseAgentState(v: unknown): AgentVoiceState | null {
  return v === "connecting" || v === "initializing" || v === "listening" || v === "thinking" || v === "speaking" || v === "idle" ? v : null;
}

export type ToolStatus = { used: boolean; names: string[] };

export function parseToolStatus(msg: Record<string, unknown>): ToolStatus {
  return {
    used: msg.tool_used === true,
    names: Array.isArray(msg.tool_names) ? msg.tool_names.filter((n): n is string => typeof n === "string") : [],
  };
}

export type TurnLanguage = { language: string; label: string; switched: boolean };

export function parseTurnLanguage(msg: Record<string, unknown>): TurnLanguage | null {
  const language = typeof msg.language === "string" ? msg.language : "";
  if (!language) return null;
  return { language, label: typeof msg.label === "string" && msg.label ? msg.label : language, switched: msg.switched === true };
}

export type StageId = "stt" | "llm" | "tts";
export type StageInfo = { provider: string; model: string };
export type CallPipelineInfo = Record<StageId, StageInfo>;

/** Response-time tiers — the same thresholds, words and colours as Robovoice's HUD. */
export function latencyTier(ms: number | null | undefined): { label: string; color: string; glow: string } {
  if (ms == null) return { label: "—", color: "rgba(255,255,255,0.5)", glow: "rgba(255,255,255,0.25)" };
  if (ms < 800) return { label: "snappy", color: "#6ee7b7", glow: "rgba(52,211,153,0.9)" };
  if (ms < 1600) return { label: "good", color: "#bef264", glow: "rgba(163,230,53,0.9)" };
  if (ms < 2500) return { label: "okay", color: "#fcd34d", glow: "rgba(251,191,36,0.9)" };
  if (ms < 4000) return { label: "slow", color: "#fdba74", glow: "rgba(251,146,60,0.9)" };
  return { label: "sluggish", color: "#fda4af", glow: "rgba(251,113,133,0.9)" };
}

const PROVIDER_LABEL: Record<string, string> = {
  speaches: "Speaches",
  groq: "Groq",
  fal: "fal.ai",
  ollama: "Ollama",
  ollama_cloud: "Ollama Cloud",
  openrouter: "OpenRouter",
  gemini: "Gemini",
  kokoro: "Kokoro",
  qwen: "Qwen3-TTS",
  elevenlabs: "ElevenLabs",
  piper: "Piper",
  infinibot: "InfiniBot",
  cerebras: "Cerebras",
  assemblyai: "AssemblyAI",
  soniox: "Soniox",
  inworld: "Inworld",
  vibevoice: "VibeVoice",
};

export function prettyProvider(p: string | null | undefined): string {
  if (!p) return "—";
  return PROVIDER_LABEL[p] ?? p.charAt(0).toUpperCase() + p.slice(1);
}

export type LiveStage = {
  id: StageId;
  label: "STT" | "LLM" | "TTS";
  color: string;
  /** This stage is running right now (pulsing ring). */
  active: boolean;
  /** A later stage is running: this one finished for the turn (check mark). */
  done: boolean;
  /** Lit: active, or every stage while the models warm. */
  lit: boolean;
  provider: string;
  model: string;
  toolName: string | null;
};

export type LiveConnector = { color: string; flowing: boolean; active: boolean; ms: number | null };

export type LivePipelineModel = {
  stages: LiveStage[];
  /** connectors[i] sits between stages[i] and stages[i+1]. */
  connectors: LiveConnector[];
  totalMs: number | null;
  tier: ReturnType<typeof latencyTier>;
  avgMs: number | null;
  footer: string;
  warming: boolean;
  activeIndex: number;
};

const STAGE_DEFS: Array<{ id: StageId; label: LiveStage["label"]; color: string; activeWhen: AgentVoiceState; word: string }> = [
  { id: "stt", label: "STT", color: "#6366f1", activeWhen: "listening", word: "listening" },
  { id: "llm", label: "LLM", color: "#818cf8", activeWhen: "thinking", word: "thinking" },
  { id: "tts", label: "TTS", color: "#c4b5fd", activeWhen: "speaking", word: "speaking" },
];

export type LivePipelineInput = {
  agentState: AgentVoiceState | null;
  latency: LatencySample[];
  tool: ToolStatus | null;
  /** Effective pipeline of the call's agent; null = not answered / unavailable. */
  pipeline: CallPipelineInfo | null;
  /** True once Robovoice answered (or failed) for the pipeline. */
  pipelineLoaded: boolean;
  /** False when no call is up: nothing lights. */
  inCall: boolean;
  /** Label of the language the agent decided for the latest turn. */
  language?: string | null;
};

export function livePipelineModel(input: LivePipelineInput): LivePipelineModel {
  const state = input.inCall ? input.agentState : null;
  const activeIndex = STAGE_DEFS.findIndex((s) => s.activeWhen === state);
  const warming = state === "initializing" || state === "connecting";
  const flowing = activeIndex >= 0 || warming;
  const latest = input.latency.length ? input.latency[input.latency.length - 1] : null;
  const history = input.latency.slice(-10);
  const avgMs = history.length ? Math.round(history.reduce((s, h) => s + h.totalMs, 0) / history.length) : null;
  const showTool = !!input.tool?.used && input.tool.names.length > 0;
  const stages: LiveStage[] = STAGE_DEFS.map((def, i) => {
    const info = input.pipeline?.[def.id];
    const active = activeIndex === i;
    return {
      id: def.id,
      label: def.label,
      color: def.color,
      active,
      done: activeIndex > i,
      lit: active || warming,
      provider: info?.provider ? prettyProvider(info.provider) : input.pipelineLoaded ? "unavailable" : "…",
      model: info?.model ?? "",
      toolName: def.id === "llm" && showTool ? input.tool!.names[0] : null,
    };
  });
  const connectors: LiveConnector[] = [0, 1].map((i) => ({
    color: STAGE_DEFS[i + 1].color,
    flowing,
    active: activeIndex >= 0 && activeIndex >= i,
    ms: latest ? (i === 0 ? latest.sttToLlmMs : latest.llmToTtsMs) : null,
  }));
  return {
    stages,
    connectors,
    totalMs: latest?.totalMs ?? null,
    tier: latencyTier(latest?.totalMs),
    avgMs,
    footer: warming ? "warming models…" : activeIndex >= 0 ? `${STAGE_DEFS[activeIndex].word}…` : "idle · awaiting turn",
    warming,
    activeIndex,
  };
}

// ── Audio levels (drive the voice blob) ─────────────────────────────────────

export type AudioLevels = { level: number; bass: number; treble: number; bars: number[] };
export const SILENT_LEVELS: AudioLevels = { level: 0, bass: 0, treble: 0, bars: Array(12).fill(0) as number[] };

/**
 * One analyser frame (byte frequency data) → the numbers the original voice
 * terminal fed its blob and mic waveform: RMS level 0..100, bass/treble 0..1,
 * and 12 bar heights (4..36 px).
 */
export function sampleLevels(data: ArrayLike<number>): AudioLevels {
  const n = data.length;
  if (!n) return SILENT_LEVELS;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += data[i] * data[i];
  const level = Math.min(100, Math.round(Math.sqrt(sum / n) * 0.8));
  const half = Math.floor(n / 2);
  let bassMax = 0;
  let trebleSum = 0;
  for (let i = 0; i < half; i++) if (data[i] > bassMax) bassMax = data[i];
  for (let i = half; i < n; i++) trebleSum += data[i];
  const seg = Math.max(1, Math.floor(n / 12));
  const bars: number[] = [];
  for (let i = 0; i < 12; i++) {
    let s = 0;
    for (let j = 0; j < seg; j++) s += data[i * seg + j] ?? 0;
    bars.push(Math.min(36, Math.max(4, (s / seg / 255) * 40)));
  }
  return { level, bass: bassMax / 255, treble: trebleSum / Math.max(1, n - half) / 255, bars };
}

export type BlobDrive = { state: "idle" | "listening" | "speaking" | "processing"; dominant: number; bass: number; treble: number; user: number; agent: number };

/**
 * Blob inputs for one frame — the original terminal's mapping: two energy
 * lanes (user mic, agent audio), a floor while someone is known to be
 * speaking, and a 0.06 ambient floor so the idle blob keeps breathing.
 */
export function blobDrive(input: {
  connected: boolean;
  muted: boolean;
  agentState: AgentVoiceState | null;
  mic: AudioLevels;
  agentLevel: number;
  userSpeaking: boolean;
  agentSpeaking: boolean;
}): BlobDrive {
  const speaking = input.agentSpeaking || input.agentState === "speaking";
  const thinking = input.agentState === "thinking" || input.agentState === "initializing" || input.agentState === "connecting";
  const state: BlobDrive["state"] = speaking ? "speaking" : thinking ? "processing" : input.connected && !input.muted ? "listening" : "idle";
  const user = Math.max(Math.min(1, (input.mic.level / 100) * 1.4), input.userSpeaking ? 0.72 : 0);
  const agent = Math.max(Math.min(1, Math.max(0, input.agentLevel / 100)), speaking ? 0.15 : 0);
  const dominant = Math.max(0.06, user, agent);
  const hasFft = input.mic.bass > 0 || input.mic.treble > 0;
  return {
    state,
    dominant,
    bass: hasFft ? Math.min(1, input.mic.bass * 1.3) : dominant,
    treble: hasFft ? Math.min(1, input.mic.treble * 1.8) : Math.pow(dominant, 1.4),
    user,
    agent,
  };
}

/** The original terminal's four-state read-out (orb label / status display). */
export function aiState(d: BlobDrive): "idle" | "thinking" | "speaking" | "listening" {
  return d.state === "processing" ? "thinking" : d.state;
}

/**
 * Our audio is in the room but Robovoice's agent is not listening yet (a cloud
 * agent takes ~10-15 s to start). Anything said now is lost, so the session
 * must not read "LISTENING".
 */
export function agentPending(call: { phase: string; media: string; agentState: AgentVoiceState | null }): boolean {
  if (call.phase !== "active" || call.media !== "connected") return false;
  return call.agentState === null || call.agentState === "initializing" || call.agentState === "connecting";
}

export type TranscriptEmptyInput = {
  phase: string;
  media: string;
  agentState: AgentVoiceState | null;
  muted: boolean;
  agentName: string;
  /** Why a call can't start right now (null = it can). */
  blockedReason: string | null;
};

/**
 * What the empty transcript says. Follows the call: before, while it connects,
 * once the agent listens (or the mic is muted), and after it ends — so the
 * caller always knows whether speaking now will land.
 */
export function transcriptEmptyText(c: TranscriptEmptyInput): string {
  switch (c.phase) {
    case "starting":
      return `Calling ${c.agentName}…`;
    case "connecting":
      return "Joining the call audio…";
    case "ending":
      return "Ending call…";
    case "ended":
      return "Call ended with nothing said. Connect to try again.";
    case "failed":
      return "Call failed. Connect to try again.";
    case "active":
      if (c.media !== "connected") return "Waiting for call audio…";
      if (agentPending(c)) return `${c.agentName} is joining. Speak once it is listening.`;
      if (c.muted) return "Your mic is muted. Unmute to talk.";
      if (c.agentState === "speaking") return `${c.agentName} is speaking…`;
      if (c.agentState === "thinking") return `${c.agentName} is thinking…`;
      return `${c.agentName} is listening. Say something.`;
    default:
      return c.blockedReason ?? `Connect to call ${c.agentName}. The conversation shows up here.`;
  }
}

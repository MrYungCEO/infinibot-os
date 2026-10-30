import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RobovoiceCallSession, type RoomHandlers } from "./call-session.js";
import { IDLE_CALL, callReducer, type CallState } from "./console-state.js";
import {
  AGENT_STATE_ATTRIBUTE,
  LATENCY_TOPIC,
  SILENT_LEVELS,
  TOOL_STATUS_TOPIC,
  agentPending,
  aiState,
  blobDrive,
  latencyTier,
  livePipelineModel,
  parseAgentState,
  parseToolStatus,
  parseTurnLanguage,
  sampleLevels,
  transcriptEmptyText,
  type LivePipelineInput,
} from "./live-state.js";

const here = dirname(fileURLToPath(import.meta.url));
// TEST FIXTURE — not shipped: a pipeline shaped like robovoice.pipeline.config.get's effective stages.
const FIXTURE_PIPELINE = {
  stt: { provider: "groq", model: "whisper-large-v3" },
  llm: { provider: "openrouter", model: "fixture/model" },
  tts: { provider: "elevenlabs", model: "fixture-voice" },
};
const base: LivePipelineInput = { agentState: null, latency: [], tool: null, pipeline: FIXTURE_PIPELINE, pipelineLoaded: true, inCall: true };
const sample = (totalMs: number, a: number | null = null, b: number | null = null) => ({ at: 1, totalMs, sttToLlmMs: a, llmToTtsMs: b });

describe("live pipeline stages (Robovoice call HUD semantics)", () => {
  it("uses the same LiveKit signals as Robovoice's call page", () => {
    expect(AGENT_STATE_ATTRIBUTE).toBe("lk.agent.state");
    expect(LATENCY_TOPIC).toBe("response_latency");
    expect(TOOL_STATUS_TOPIC).toBe("tool_status");
  });

  it("listening lights STT, thinking lights LLM (STT done), speaking lights TTS (STT + LLM done)", () => {
    const at = (s: LivePipelineInput["agentState"]) => livePipelineModel({ ...base, agentState: s }).stages.map((x) => `${x.active ? "A" : x.done ? "D" : "-"}`).join("");
    expect(at("listening")).toBe("A--");
    expect(at("thinking")).toBe("DA-");
    expect(at("speaking")).toBe("DDA");
    expect(at(null)).toBe("---");
    expect(livePipelineModel({ ...base, agentState: "thinking" }).footer).toBe("thinking…");
    expect(livePipelineModel(base).footer).toBe("idle · awaiting turn");
  });

  it("warming (initializing/connecting) lights every stage and flows the connectors slowly", () => {
    const m = livePipelineModel({ ...base, agentState: "initializing" });
    expect(m.stages.every((s) => s.lit && !s.active)).toBe(true);
    expect(m.connectors.every((c) => c.flowing && !c.active)).toBe(true);
    expect(m.footer).toBe("warming models…");
  });

  it("connector i is active once stage i or later runs", () => {
    expect(livePipelineModel({ ...base, agentState: "listening" }).connectors.map((c) => c.active)).toEqual([true, false]);
    expect(livePipelineModel({ ...base, agentState: "speaking" }).connectors.map((c) => c.active)).toEqual([true, true]);
  });

  it("per-stage latency: STT→LLM and LLM→TTS on the connectors, total tiered, rolling average of the last 10", () => {
    const m = livePipelineModel({ ...base, latency: [sample(900, 200, 300), sample(700, 150, 250)] });
    expect(m.totalMs).toBe(700);
    expect(m.connectors.map((c) => c.ms)).toEqual([150, 250]);
    expect(m.avgMs).toBe(800);
    expect(m.tier.label).toBe("snappy");
    expect(livePipelineModel(base).totalMs).toBeNull();
    expect([500, 1000, 2000, 3000, 5000].map((ms) => latencyTier(ms).label)).toEqual(["snappy", "good", "okay", "slow", "sluggish"]);
  });

  it("nothing lights when no call is up, even with a stale agent state", () => {
    const m = livePipelineModel({ ...base, inCall: false, agentState: "speaking" });
    expect(m.activeIndex).toBe(-1);
    expect(m.stages.some((s) => s.lit)).toBe(false);
  });

  it("stage names come from Robovoice only: unanswered → …, answered without a pipeline → unavailable", () => {
    expect(livePipelineModel(base).stages.map((s) => s.provider)).toEqual(["Groq", "OpenRouter", "ElevenLabs"]);
    expect(livePipelineModel({ ...base, pipeline: null, pipelineLoaded: false }).stages.map((s) => s.provider)).toEqual(["…", "…", "…"]);
    expect(livePipelineModel({ ...base, pipeline: null }).stages.map((s) => s.provider)).toEqual(["unavailable", "unavailable", "unavailable"]);
  });

  it("the tool chip shows on the LLM stage while a tool ran this turn", () => {
    const m = livePipelineModel({ ...base, agentState: "thinking", tool: { used: true, names: ["sessions_spawn"] } });
    expect(m.stages.map((s) => s.toolName)).toEqual([null, "sessions_spawn", null]);
    expect(livePipelineModel({ ...base, tool: { used: false, names: ["x"] } }).stages[1].toolName).toBeNull();
  });

  it("parsers accept only the documented shapes", () => {
    expect(parseAgentState("speaking")).toBe("speaking");
    expect(parseAgentState("dancing")).toBeNull();
    expect(parseToolStatus({ tool_used: true, tool_names: ["a", 3] })).toEqual({ used: true, names: ["a"] });
    expect(parseTurnLanguage({ language: "he", label: "Hebrew", switched: true })).toEqual({ language: "he", label: "Hebrew", switched: true });
    expect(parseTurnLanguage({})).toBeNull();
  });
});

describe("call state carries the live agent state", () => {
  const active: CallState = { ...IDLE_CALL, phase: "active", agentId: "main", room: "r" };
  it("agent-state / tool / language only apply during a call and reset when it ends", () => {
    expect(callReducer(IDLE_CALL, { type: "agent-state", state: "speaking" }).agentState).toBeNull();
    let s = callReducer(active, { type: "agent-state", state: "thinking" });
    s = callReducer(s, { type: "tool", tool: { used: true, names: ["t"] } });
    expect(s.agentState).toBe("thinking");
    expect(s.tool?.names).toEqual(["t"]);
    // Back to listening = next turn: the tool badge clears.
    s = callReducer(s, { type: "agent-state", state: "listening" });
    expect(s.tool).toBeNull();
    s = callReducer(s, { type: "agent-state", state: "speaking" });
    expect(callReducer(s, { type: "ended" }).agentState).toBeNull();
    expect(callReducer(s, { type: "fail", error: "x" }).agentState).toBeNull();
  });

  it("the session forwards room agent state, tool status and levels", async () => {
    let handlers: RoomHandlers | null = null;
    const states: CallState[] = [];
    const session = new RobovoiceCallSession({
      rpc: async <T>(method: string) => (method === "robovoice.call.start" ? { mode: "cloud", room: "r", started_at: new Date(0).toISOString() } : { room: "r", live: true, participants: 2 }) as T,
      fetchConnection: async () => ({ serverUrl: "wss://fixture.invalid", participantToken: "fixture", roomName: "r" }),
      joinRoom: async (_c, h) => {
        handlers = h;
        return {
          leave: async () => undefined,
          setMuted: async () => undefined,
          levels: () => ({ mic: { ...SILENT_LEVELS, level: 42 }, agentLevel: 7, userSpeaking: true, agentSpeaking: false }),
        };
      },
      onChange: (s) => states.push(s),
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    expect(session.levels().mic.level).toBe(0);
    await session.begin("main");
    handlers!.onAgentState?.("thinking");
    handlers!.onTool?.({ used: true, names: ["lookup"] });
    expect(session.state.agentState).toBe("thinking");
    expect(session.state.tool?.names).toEqual(["lookup"]);
    expect(session.levels()).toMatchObject({ agentLevel: 7, userSpeaking: true });
    expect(session.levels().mic.level).toBe(42);
    await session.end();
    expect(session.state.agentState).toBeNull();
    expect(session.levels().mic.level).toBe(0);
  });
});

describe("voice blob drive (original terminal mapping, Robovoice inputs)", () => {
  const quiet = { connected: true, muted: false, agentState: "listening" as const, mic: SILENT_LEVELS, agentLevel: 0, userSpeaking: false, agentSpeaking: false };
  it("idle when no call; listening when connected; processing while the agent thinks; speaking wins", () => {
    expect(blobDrive({ ...quiet, connected: false, agentState: null }).state).toBe("idle");
    expect(blobDrive(quiet).state).toBe("listening");
    expect(blobDrive({ ...quiet, muted: true }).state).toBe("idle");
    expect(blobDrive({ ...quiet, agentState: "thinking" }).state).toBe("processing");
    expect(aiState(blobDrive({ ...quiet, agentState: "thinking" }))).toBe("thinking");
    expect(blobDrive({ ...quiet, agentState: "thinking", agentSpeaking: true }).state).toBe("speaking");
  });

  it("keeps the 0.06 ambient floor, floors a speaking user at 0.72 and a speaking agent at 0.15", () => {
    expect(blobDrive(quiet).dominant).toBeCloseTo(0.06);
    expect(blobDrive({ ...quiet, userSpeaking: true }).user).toBeCloseTo(0.72);
    expect(blobDrive({ ...quiet, agentState: "speaking" }).agent).toBeCloseTo(0.15);
    const loud = blobDrive({ ...quiet, agentLevel: 80, agentSpeaking: true });
    expect(loud.agent).toBeCloseTo(0.8);
    expect(loud.dominant).toBeCloseTo(0.8);
  });

  it("sampleLevels: RMS 0..100, bass/treble 0..1, 12 bars clamped 4..36", () => {
    const silent = sampleLevels(new Uint8Array(32));
    expect(silent.level).toBe(0);
    expect(silent.bars).toHaveLength(12);
    expect(silent.bars.every((b) => b === 4)).toBe(true);
    const loud = sampleLevels(new Uint8Array(32).fill(255));
    expect(loud.level).toBe(100);
    expect(loud.bass).toBe(1);
    expect(loud.treble).toBe(1);
    expect(Math.max(...loud.bars)).toBe(36);
    expect(sampleLevels([])).toBe(SILENT_LEVELS);
  });
});

describe("the session view restores the original look without the local voice stack", () => {
  const src = (f: string) => readFileSync(join(here, f), "utf8");
  it("uses the original stylesheet and blob/HUD components", () => {
    const view = src("session-view.ts");
    for (const dep of ["session-styles.js", "components/voice-blob.js", "components/voice-floating-hud.js", "components/voice-controls-dock.js", "./hud-panels.js", "./live-pipeline.js"]) {
      expect(view).toContain(dep);
    }
    expect(src("session-styles.ts")).toContain(".hud-container");
  });

  it("has no local voice backend: no /api/voice routes, VAD, push-to-talk STT or mock data", () => {
    for (const f of ["session-view.ts", "live-pipeline.ts", "live-state.ts", "../../components/voice-controls-dock.ts"]) {
      const code = src(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/\/api\/voice|vad-web|MicVAD|toggle-stt|toggle-char|mock|demo data/i);
    }
  });

  it("Session is the default sub-tab and settings are their own tabs", () => {
    const consoleSrc = src("voice-console.ts");
    expect(consoleSrc).toMatch(/section: Section = "session"/);
    for (const label of ["Session", "Pipeline", "Voice agents", "Characters", "Voice LLM", "Account"]) expect(consoleSrc).toContain(`label: "${label}"`);
    expect(consoleSrc).toContain("<voice-session-view");
  });
});

describe("the session never says LISTENING before the agent is", () => {
  const joined: CallState = { ...IDLE_CALL, phase: "active", agentId: "main", room: "r", media: "connected" };
  it("is pending from our audio joining until the agent reports a live state", () => {
    expect(agentPending(joined)).toBe(true);
    expect(agentPending({ ...joined, agentState: "initializing" })).toBe(true);
    expect(agentPending({ ...joined, agentState: "listening" })).toBe(false);
    expect(agentPending({ ...joined, agentState: "speaking" })).toBe(false);
  });
  it("only applies to a call whose audio is in this page", () => {
    // Robovoice Desktop took the call: no agent state ever reaches the page.
    expect(agentPending({ ...joined, media: "none" })).toBe(false);
    expect(agentPending({ ...joined, phase: "ended" })).toBe(false);
  });
});

describe("transcript lines the agent publishes twice show once", () => {
  const active: CallState = { ...IDLE_CALL, phase: "active", agentId: "main", room: "r" };
  const line = (id: string, who: "you" | "agent", text: string, at: number) => ({ id, who, text, final: true, at });
  it("drops an identical line from the same speaker moments later", () => {
    let s = callReducer(active, { type: "transcript", line: line("d-1", "you", "Hey Infini", 1000) });
    s = callReducer(s, { type: "transcript", line: line("d-2", "you", "Hey Infini", 1000) });
    expect(s.transcript).toHaveLength(1);
  });
  it("merges the native transcription with the agent's own line, whichever is first", () => {
    // Seen on a live call: the native segment (local clock) and the data-topic line (agent clock).
    let s = callReducer(active, { type: "transcript", line: { ...line("t-seg1", "you", "Hey Infini", 2000), final: false } });
    s = callReducer(s, { type: "transcript", line: line("d-1", "you", "Hey Infini", 1400) });
    expect(s.transcript).toEqual([line("t-seg1", "you", "Hey Infini", 2000)]);
    // The native segment's final update still lands on its own line.
    s = callReducer(s, { type: "transcript", line: line("t-seg1", "you", "Hey Infini", 2100) });
    expect(s.transcript).toHaveLength(1);
  });
  it("keeps a real repeat, the other speaker, and later lines", () => {
    let s = callReducer(active, { type: "transcript", line: line("d-1", "you", "yes", 1000) });
    s = callReducer(s, { type: "transcript", line: line("d-2", "agent", "yes", 1200) });
    s = callReducer(s, { type: "transcript", line: line("d-3", "agent", "yes", 9000) });
    expect(s.transcript.map((l) => l.id)).toEqual(["d-1", "d-2", "d-3"]);
  });
});

describe("agent audio playback state", () => {
  const active: CallState = { ...IDLE_CALL, phase: "active", agentId: "main", room: "r", media: "connected" };
  it("is tracked only during a call and cleared when it ends", () => {
    expect(callReducer(IDLE_CALL, { type: "playback", playback: "blocked" }).playback).toBeNull();
    const blocked = callReducer(active, { type: "playback", playback: "blocked" });
    expect(blocked.playback).toBe("blocked");
    expect(callReducer(blocked, { type: "playback", playback: "playing" }).playback).toBe("playing");
    expect(callReducer(blocked, { type: "ended" }).playback).toBeNull();
    expect(callReducer(blocked, { type: "end" }).playback).toBeNull();
  });
});

describe("empty transcript message", () => {
  const base = { phase: "idle", media: "none", agentState: null, muted: false, agentName: "INFINI", blockedReason: null };
  it("follows the call instead of one fixed line", () => {
    expect(transcriptEmptyText(base)).toBe("Connect to call INFINI. The conversation shows up here.");
    expect(transcriptEmptyText({ ...base, blockedReason: "Wallet empty" })).toBe("Wallet empty");
    expect(transcriptEmptyText({ ...base, phase: "starting" })).toBe("Calling INFINI…");
    expect(transcriptEmptyText({ ...base, phase: "connecting" })).toBe("Joining the call audio…");
    const live = { ...base, phase: "active", media: "connected" };
    expect(transcriptEmptyText({ ...live, media: "connecting" })).toBe("Waiting for call audio…");
    expect(transcriptEmptyText({ ...live, agentState: "initializing" })).toBe("INFINI is joining. Speak once it is listening.");
    expect(transcriptEmptyText({ ...live, agentState: "listening" })).toBe("INFINI is listening. Say something.");
    expect(transcriptEmptyText({ ...live, agentState: "listening", muted: true })).toBe("Your mic is muted. Unmute to talk.");
    expect(transcriptEmptyText({ ...live, agentState: "thinking" })).toBe("INFINI is thinking…");
    expect(transcriptEmptyText({ ...live, agentState: "speaking" })).toBe("INFINI is speaking…");
    expect(transcriptEmptyText({ ...base, phase: "ending" })).toBe("Ending call…");
    expect(transcriptEmptyText({ ...base, phase: "ended" })).toBe("Call ended with nothing said. Connect to try again.");
    expect(transcriptEmptyText({ ...base, phase: "failed" })).toBe("Call failed. Connect to try again.");
  });
});

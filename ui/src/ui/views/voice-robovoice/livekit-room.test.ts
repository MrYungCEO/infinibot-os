/**
 * joinLivekitRoom against a fake livekit-client: the room events and data
 * topics Robovoice's voice agent emits (TEST FIXTURES, injected here) must
 * reach the session as agent state, per-stage latency, tool status, language
 * and transcript lines.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;
const rooms: FakeRoom[] = [];

class FakeRoom {
  listeners = new Map<string, Listener[]>();
  remoteParticipants = new Map<string, { isLocal: boolean; attributes: Record<string, string> }>();
  micArgs: unknown[] = [];
  canPlaybackAudio = true;
  startAudioCalls = 0;
  startAudio = async () => {
    this.startAudioCalls++;
    if (!this.canPlaybackAudio) throw new Error("NotAllowedError");
  };
  localParticipant = {
    setMicrophoneEnabled: async (...args: unknown[]) => {
      this.micArgs = args;
    },
    getTrackPublication: () => undefined,
  };
  constructor() {
    rooms.push(this);
  }
  on(ev: string, fn: Listener) {
    this.listeners.set(ev, [...(this.listeners.get(ev) ?? []), fn]);
    return this;
  }
  emit(ev: string, ...args: unknown[]) {
    for (const fn of this.listeners.get(ev) ?? []) fn(...args);
  }
  async connect() {}
  async disconnect() {
    this.emit("disconnected");
  }
}

vi.mock("livekit-client", () => ({
  Room: FakeRoom,
  RoomEvent: {
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    DataReceived: "dataReceived",
    TranscriptionReceived: "transcriptionReceived",
    Disconnected: "disconnected",
    ParticipantAttributesChanged: "participantAttributesChanged",
    ParticipantConnected: "participantConnected",
    ActiveSpeakersChanged: "activeSpeakersChanged",
    AudioPlaybackStatusChanged: "audioPlaybackChanged",
  },
  Track: { Kind: { Audio: "audio" }, Source: { Microphone: "microphone" } },
}));

const { joinLivekitRoom, loadLivekit, primeCallAudio } = await import("./call-session.js");
const data = (topic: string, body: unknown) => [new TextEncoder().encode(JSON.stringify(body)), undefined, undefined, topic] as const;

describe("joinLivekitRoom — Robovoice room signals", () => {
  beforeEach(() => {
    rooms.length = 0;
  });

  async function join() {
    const seen = { playback: [] as string[], states: [] as unknown[], latency: [] as unknown[], tools: [] as unknown[], languages: [] as unknown[], lines: [] as unknown[], disconnected: 0 };
    const joined = await joinLivekitRoom(
      { serverUrl: "wss://fixture.invalid", participantToken: "fixture", roomName: "fixture-room" },
      {
        onTranscript: (l) => seen.lines.push(l),
        onLatency: (s) => seen.latency.push(s),
        onDisconnected: () => seen.disconnected++,
        onAgentState: (s) => seen.states.push(s),
        onTool: (t) => seen.tools.push(t),
        onLanguage: (l) => seen.languages.push(l),
        onPlayback: (p) => seen.playback.push(p),
      },
    );
    return { joined, seen, room: rooms[0] };
  }

  it("agent state follows the agent's lk.agent.state attribute (remote participants only)", async () => {
    const { seen, room } = await join();
    const agent = { isLocal: false, attributes: { "lk.agent.state": "listening" } };
    room.emit("participantConnected", agent);
    for (const state of ["thinking", "speaking", "listening"]) {
      agent.attributes = { "lk.agent.state": state };
      room.emit("participantAttributesChanged", { "lk.agent.state": state }, agent);
    }
    room.emit("participantAttributesChanged", {}, { isLocal: true, attributes: { "lk.agent.state": "speaking" } });
    room.emit("participantAttributesChanged", {}, { isLocal: false, attributes: { other: "x" } });
    expect(seen.states).toEqual(["listening", "thinking", "speaking", "listening"]);
  });

  it("response_latency → per-stage latency; tool_status → tool; robovoice_language → language", async () => {
    const { seen, room } = await join();
    room.emit("dataReceived", ...data("response_latency", { total_ms: 840, stt_to_llm_ms: 210, llm_to_tts_ms: 330, ts: 5 }));
    room.emit("dataReceived", ...data("tool_status", { tool_used: true, tool_names: ["sessions_spawn"] }));
    room.emit("dataReceived", ...data("robovoice_language", { language: "en", label: "English", switched: false }));
    room.emit("dataReceived", ...data("response_latency", { nope: true }));
    expect(seen.latency).toEqual([{ at: 5, totalMs: 840, sttToLlmMs: 210, llmToTtsMs: 330 }]);
    expect(seen.tools).toEqual([{ used: true, names: ["sessions_spawn"] }]);
    expect(seen.languages).toEqual([{ language: "en", label: "English", switched: false }]);
    expect(seen.lines).toEqual([]);
  });

  it("lk-chat-topic lines are the transcript", async () => {
    const { seen, room } = await join();
    room.emit("dataReceived", ...data("lk-chat-topic", { role: "user", message: "hello", timestamp: 1 }));
    room.emit("dataReceived", ...data("lk-chat-topic", { role: "assistant", message: "hi there", timestamp: 2 }));
    expect((seen.lines as Array<{ who: string; text: string }>).map((l) => `${l.who}:${l.text}`)).toEqual(["you:hello", "agent:hi there"]);
  });

  it("levels are silent without analysers, track who is speaking, and the agent state clears on disconnect", async () => {
    const { joined, seen, room } = await join();
    expect(joined.levels?.()).toMatchObject({ agentLevel: 0, userSpeaking: false, agentSpeaking: false });
    room.emit("activeSpeakersChanged", [{ isLocal: false }]);
    expect(joined.levels?.()).toMatchObject({ userSpeaking: false, agentSpeaking: true });
    room.emit("activeSpeakersChanged", [{ isLocal: true }]);
    expect(joined.levels?.()).toMatchObject({ userSpeaking: true, agentSpeaking: false });
    await joined.leave();
    expect(seen.disconnected).toBe(1);
    expect(seen.states.at(-1)).toBeNull();
  });

  it("blocked autoplay is reported, and the tap-to-enable retry reports playing once the element plays", async () => {
    const { joined, seen, room } = await join();
    const el = { paused: true, muted: false, isConnected: true, dataset: {} as Record<string, string>, autoplay: false, setAttribute() {}, addEventListener() {}, remove() {}, play: async () => {} };
    room.canPlaybackAudio = false;
    room.emit("trackSubscribed", { kind: "audio", sid: "TR_agent", attach: () => el, detach: () => [el], mediaStreamTrack: { clone: () => { throw new Error("no clone"); } } });
    room.emit("audioPlaybackChanged");
    expect(seen.playback).toEqual(["blocked"]);
    expect(el.autoplay).toBe(true);
    // Still blocked: the retry says so (no duplicate report).
    await joined.startAudio?.();
    expect(seen.playback).toEqual(["blocked"]);
    // The tap: the browser lets it play now.
    room.canPlaybackAudio = true;
    el.paused = false;
    await joined.startAudio?.();
    expect(room.startAudioCalls).toBe(2);
    expect(seen.playback).toEqual(["blocked", "playing"]);
    expect(joined.levels?.().agentLevel).toBe(0);
    room.emit("activeSpeakersChanged", [{ isLocal: false, audioLevel: 0.42 }]);
    expect(joined.levels?.().agentLevel).toBe(42);
  });

  it("the Connect tap unlocks audio on the room and the element the agent's track later plays on", async () => {
    const played: string[] = [];
    const made: Array<Record<string, unknown>> = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const el = { dataset: {}, autoplay: false, paused: false, muted: false, isConnected: true, setAttribute() {}, addEventListener() {}, remove() {}, play: async () => void played.push("el") };
        made.push(el);
        return el;
      },
      body: { appendChild() {} },
    });
    try {
      await loadLivekit();
      primeCallAudio(); // synchronous, in the gesture
      expect(rooms).toHaveLength(1);
      expect(rooms[0].startAudioCalls).toBe(1);
      expect(played).toEqual(["el"]);
      const { seen, room } = await join();
      expect(rooms).toHaveLength(1); // the primed room is the call's room
      let attachedTo: unknown = null;
      room.emit("trackSubscribed", { kind: "audio", sid: "TR_agent", attach: (el?: unknown) => (attachedTo = el), detach: () => [], mediaStreamTrack: { clone: () => { throw new Error("no clone"); } } });
      expect(attachedTo).toBe(made[0]);
      expect(seen.playback).toEqual(["playing"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

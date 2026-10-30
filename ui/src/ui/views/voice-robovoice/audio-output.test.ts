import { describe, expect, it } from "vitest";

import {
  AUDIO_KEYS,
  DEFAULT_AUDIO_PREFS,
  SilentReplyDetector,
  applySink,
  clampVolume,
  loadAudioPrefs,
  outputSelectionSupported,
  resolveDevice,
  saveAudioPrefs,
  splitDevices,
} from "./audio-output.js";
import { RobovoiceCallSession, type JoinedRoom, type RoomHandlers } from "./call-session.js";
import { IDLE_CALL, callReducer, type CallState } from "./console-state.js";

function memoryStore() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("audio prefs (this browser)", () => {
  it("defaults: system devices, full volume, fallback voice on", () => {
    expect(loadAudioPrefs(memoryStore())).toEqual(DEFAULT_AUDIO_PREFS);
    expect(loadAudioPrefs(null)).toEqual(DEFAULT_AUDIO_PREFS);
  });

  it("remembers speaker, mic, volume and the fallback switch; '' clears a device back to default", () => {
    const store = memoryStore();
    saveAudioPrefs({ outputDeviceId: "spk-1", micDeviceId: "mic-9", volume: 0.42, fallbackVoice: false }, store);
    expect(loadAudioPrefs(store)).toEqual({ outputDeviceId: "spk-1", micDeviceId: "mic-9", volume: 0.42, fallbackVoice: false });
    saveAudioPrefs({ outputDeviceId: "" }, store);
    expect(store.m.has(AUDIO_KEYS.output)).toBe(false);
    expect(loadAudioPrefs(store).outputDeviceId).toBe("");
    expect(loadAudioPrefs(store).micDeviceId).toBe("mic-9");
  });

  it("volume is clamped to 0..1 and garbage means full volume", () => {
    expect(clampVolume(1.7)).toBe(1);
    expect(clampVolume(-3)).toBe(0);
    expect(clampVolume("0.25")).toBe(0.25);
    expect(clampVolume("loud")).toBe(1);
    const store = memoryStore();
    store.setItem(AUDIO_KEYS.volume, "9");
    expect(loadAudioPrefs(store).volume).toBe(1);
  });
});

describe("device list", () => {
  const all = [
    { deviceId: "default", kind: "audioinput" as const, label: "Default - Built-in mic" },
    { deviceId: "m1", kind: "audioinput" as const, label: "USB mic" },
    { deviceId: "m1", kind: "audioinput" as const, label: "USB mic" },
    { deviceId: "s1", kind: "audiooutput" as const, label: "" },
    { deviceId: "s2", kind: "audiooutput" as const, label: "Headphones" },
    { deviceId: "c1", kind: "videoinput" as const, label: "Camera" },
  ];

  it("splits inputs and outputs, de-duplicates, names unlabelled devices", () => {
    const d = splitDevices(all);
    expect(d.inputs.map((x) => x.deviceId)).toEqual(["default", "m1"]);
    expect(d.outputs).toEqual([
      { deviceId: "s1", label: "speaker 1" },
      { deviceId: "s2", label: "Headphones" },
    ]);
  });

  it("a saved device that disappeared falls back to the default and says so", () => {
    const { outputs } = splitDevices(all);
    expect(resolveDevice("s2", outputs)).toEqual({ deviceId: "s2", missing: false });
    expect(resolveDevice("gone", outputs)).toEqual({ deviceId: "", missing: true });
    expect(resolveDevice("", outputs)).toEqual({ deviceId: "", missing: false });
    // No permission yet (ids hidden) or no list: can't tell — keep the choice.
    expect(resolveDevice("s2", [])).toEqual({ deviceId: "s2", missing: false });
    expect(resolveDevice("s2", [{ deviceId: "", label: "" }])).toEqual({ deviceId: "s2", missing: false });
  });
});

describe("speaker routing (setSinkId)", () => {
  const el = (impl?: (id: string) => Promise<void>) => {
    const calls: string[] = [];
    const node = { sinkId: "", setSinkId: impl ? (id: string) => (calls.push(id), impl(id)) : undefined } as unknown as HTMLMediaElement;
    return { node, calls };
  };

  it("routes to the chosen speaker", async () => {
    const { node, calls } = el(async () => undefined);
    expect(await applySink(node, "s2")).toBe("applied");
    expect(calls).toEqual(["s2"]);
  });

  it("a speaker that is gone falls back to the system default instead of failing", async () => {
    const { node, calls } = el(async (id) => {
      if (id) throw new DOMException("gone", "NotFoundError");
    });
    expect(await applySink(node, "unplugged")).toBe("fallback-default");
    expect(calls).toEqual(["unplugged", ""]);
  });

  it("browsers without setSinkId (Safari / iOS) report unsupported", async () => {
    expect(await applySink(el().node, "s2")).toBe("unsupported");
    expect(outputSelectionSupported({})).toBe(false);
    expect(outputSelectionSupported({ setSinkId: () => undefined })).toBe(true);
    expect(outputSelectionSupported(null)).toBe(false);
  });
});

describe("silent reply detector (text arrived, voice did not)", () => {
  it("a reply with no agent audio around it is silent once the grace period ends", () => {
    const d = new SilentReplyDetector(12_000, 6_000);
    d.noteReply("r1", 100_000, "Hello there.");
    expect(d.due(105_000)).toEqual([]);
    expect(d.due(106_000)).toEqual([{ id: "r1", at: 100_000, text: "Hello there." }]);
    expect(d.due(120_000)).toEqual([]); // reported once
  });

  it("audio shortly before the text (spoken, then transcribed) or after it means it was voiced", () => {
    const d = new SilentReplyDetector(12_000, 6_000);
    d.noteAudio(95_000);
    d.noteReply("r1", 100_000, "spoken already");
    expect(d.waiting).toBe(0);
    d.noteReply("r2", 200_000, "voice is on its way");
    d.noteAudio(203_000);
    expect(d.due(210_000)).toEqual([]);
  });

  it("old audio from an earlier turn does not excuse a later silent reply", () => {
    const d = new SilentReplyDetector(12_000, 6_000);
    d.noteAudio(10_000);
    d.noteReply("r2", 60_000, "nothing heard");
    expect(d.due(66_000).map((r) => r.id)).toEqual(["r2"]);
  });
});

describe("call state: audio in, output route, silent replies", () => {
  const active: CallState = { ...IDLE_CALL, phase: "active", agentId: "main", room: "r", media: "connected" };

  it("a silent reply raises the fault; real audio afterwards clears it", () => {
    let s = callReducer(active, { type: "silent-reply", text: "Hi.", at: 5, fallback: true });
    expect(s).toMatchObject({ silentReplies: 1, ttsFault: { text: "Hi.", fallback: true }, audioIn: false });
    s = callReducer(s, { type: "audio-in" });
    expect(s).toMatchObject({ silentReplies: 1, ttsFault: null, audioIn: true });
    s = callReducer(s, { type: "output", output: { deviceId: "", routed: "fallback-default" } });
    expect(s.output).toEqual({ deviceId: "", routed: "fallback-default" });
    // Nothing of this leaks into the next call.
    expect(callReducer(callReducer(s, { type: "ended" }), { type: "start", agentId: "main" })).toMatchObject({ silentReplies: 0, ttsFault: null, audioIn: false, output: null });
  });

  it("the session speaks a silent reply with the fallback voice and records whether it could", async () => {
    let handlers: RoomHandlers | null = null;
    const spoken: string[] = [];
    const states: CallState[] = [];
    const routed: Array<[string, number]> = [];
    const joined: JoinedRoom = {
      leave: async () => undefined,
      setMuted: async () => undefined,
      setOutput: async (id, v) => void routed.push([id, v]),
    };
    const session = new RobovoiceCallSession({
      rpc: async <T>(method: string) => (method === "robovoice.call.start" ? ({ mode: "cloud", room: "robopark-1", started_at: new Date().toISOString() } as T) : ({ room: "robopark-1", live: true, participants: 2 } as T)),
      fetchConnection: async () => ({ serverUrl: "wss://x", participantToken: "t", roomName: "robopark-1" }),
      joinRoom: async (_c, h) => ((handlers = h), joined),
      onChange: (s) => states.push(s),
      speakFallback: (text) => (spoken.push(text), true),
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    await session.begin("main");
    handlers!.onSilentReply?.({ text: "I am here.", at: 1 });
    expect(spoken).toEqual(["I am here."]);
    expect(session.state).toMatchObject({ silentReplies: 1, ttsFault: { text: "I am here.", fallback: true } });
    handlers!.onAudioIn?.();
    expect(session.state).toMatchObject({ audioIn: true, ttsFault: null });
    await session.setOutput("s2", 0.5);
    expect(routed).toEqual([["s2", 0.5]]);
  });
});

import { describe, expect, it } from "vitest";
import type { CallState } from "./console-state.js";
import { LocalVoiceCallSession, isLikelyEcho, type LocalCallDeps, type LocalTurnBody, type LocalTurnEvent, type MicHandlers, type VoicePlayer } from "./local-call-session.js";
import { SILENT_LEVELS } from "./live-state.js";

function harness(script: (body: LocalTurnBody, on: (e: LocalTurnEvent) => void) => Promise<void> | void) {
  const states: CallState[] = [];
  const turns: LocalTurnBody[] = [];
  const played: string[] = [];
  let mic: MicHandlers | null = null;
  let playing = false;
  const player: VoicePlayer = {
    synth: async (text) => new Blob([text], { type: "audio/mpeg" }),
    play: async (audio) => {
      playing = true;
      played.push(await audio.text());
      playing = false;
    },
    stop: () => undefined,
    level: () => 40,
    playing: () => playing,
    setOutput: async () => "applied",
    unlock: () => undefined,
  };
  const timers: Array<() => void> = [];
  const deps: LocalCallDeps = {
    onChange: (s) => states.push(s),
    openMic: async (_id, h) => {
      mic = h;
      return { pause: () => undefined, resume: () => undefined, destroy: async () => undefined, levels: () => SILENT_LEVELS, speaking: () => false };
    },
    transcribe: async (wav) => wav.text(),
    turn: async (body, on) => {
      turns.push(body);
      await script(body, on);
    },
    player,
    newCallKey: () => "local-test",
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => undefined,
  };
  const session = new LocalVoiceCallSession(deps);
  return { session, states, turns, played, timers, say: (t: string) => mic!.onSpeechEnd(new Blob([t])) };
}

describe("LocalVoiceCallSession", () => {
  it("opens the mic and goes live listening, with no account step", async () => {
    const h = harness(() => undefined);
    await h.session.begin("main");
    const s = h.session.state;
    expect(s.phase).toBe("active");
    expect(s.mode).toBe("device");
    expect(s.media).toBe("connected");
    expect(s.agentState).toBe("listening");
    expect(s.room).toBe("local-test");
  });

  it("a turn: your words → the reply streams into the transcript and is spoken as it arrives", async () => {
    const h = harness((body, on) => {
      if (body.poll || body.ended) return;
      on({ delta: "Seventeen times three " });
      on({ delta: "is fifty-one." });
      on({ done: true, text: "Seventeen times three is fifty-one." });
    });
    await h.session.begin("main", { sessionKey: "agent:main:webchat:abc" });
    await h.session.onUtterance(new Blob(["what is seventeen times three"]));
    const s = h.session.state;
    expect(s.transcript.map((l) => [l.who, l.text, l.final])).toEqual([
      ["you", "what is seventeen times three", true],
      ["agent", "Seventeen times three is fifty-one.", true],
    ]);
    // Only the reply is spoken: no relay narration in front of it.
    expect(h.played).toEqual(["Seventeen times three", "is fifty-one."]);
    expect(h.turns[0]).toMatchObject({ message: "what is seventeen times three", agentId: "main", callKey: "local-test", sessionKey: "agent:main:webchat:abc" });
    expect(s.latency).toHaveLength(1);
    expect(s.agentState).toBe("listening");
  });

  it("speaks results of spawned work when the line is quiet (poll)", async () => {
    const h = harness((body, on) => {
      if (body.poll) on({ done: true, text: "", updates: ["The coder finished: tests pass."], running: 0 });
    });
    await h.session.begin("main");
    await h.session.poll();
    expect(h.turns.at(-1)).toMatchObject({ poll: true, callKey: "local-test" });
    expect(h.played).toEqual(["The coder finished: tests pass."]);
    expect(h.session.state.transcript.at(-1)?.text).toBe("The coder finished: tests pass.");
  });

  it("drops Whisper noise and the agent's own echo", async () => {
    const h = harness((body, on) => {
      if (!body.poll && !body.ended) on({ done: true, text: "Sure thing, the build is green now." });
    });
    await h.session.begin("main");
    await h.session.onUtterance(new Blob(["you"]));
    expect(h.turns).toHaveLength(0);
    await h.session.onUtterance(new Blob(["is the build green"]));
    await h.session.onUtterance(new Blob(["the build is green now"]));
    expect(h.turns.filter((t) => !t.poll)).toHaveLength(1);
  });

  it("end closes the call on the gateway (background results go to chat only)", async () => {
    const h = harness(() => undefined);
    await h.session.begin("main");
    await h.session.end();
    expect(h.session.state.phase).toBe("ended");
    expect(h.turns.at(-1)).toMatchObject({ ended: true, callKey: "local-test" });
  });

  it("a failed turn is said and shown, and the call keeps listening", async () => {
    const h = harness((body, on) => {
      if (!body.poll && !body.ended) on({ error: "model offline" });
    });
    await h.session.begin("main");
    await h.session.onUtterance(new Blob(["hello there"]));
    expect(h.session.state.transcript.at(-1)?.text).toMatch(/model offline/);
    expect(h.session.state.agentState).toBe("listening");
  });
});

describe("isLikelyEcho", () => {
  it("matches recent agent speech only", () => {
    const spoken = [{ text: "The build is green now.", at: 1000 }];
    expect(isLikelyEcho("the build is green", spoken, 2000)).toBe(true);
    expect(isLikelyEcho("the build is green", spoken, 60_000)).toBe(false);
    expect(isLikelyEcho("deploy it", spoken, 2000)).toBe(false);
  });
});

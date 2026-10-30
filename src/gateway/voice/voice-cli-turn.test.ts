import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activeCliTarget,
  readVoiceCliRoute,
  setVoiceCliRouteFileForTests,
  writeVoiceCliRoute,
  type VoiceCliTarget,
} from "./voice-cli-route.js";
import type { CliSessionPort } from "./voice-cli-sessions.js";
import {
  resetVoiceCliTurnsForTests,
  runCliSessionVoiceTurn,
  voiceCliSessionState,
} from "./voice-cli-turn.js";
import {
  runVoiceLlmTurn,
  type VoiceLlmTurnRequest,
  type VoiceLlmTurnResult,
} from "./voice-llm-turn.js";
import { VoiceProgressHub } from "./voice-progress.js";

const TARGET: VoiceCliTarget = {
  kind: "terminal",
  terminalId: "term-1",
  cliType: "shell",
  label: "mock-cli",
};

/** A scripted CLI: each input line produces output chunks after small delays. */
class FakeSession implements CliSessionPort {
  readonly label = "mock-cli";
  readonly acceptsKeys = true;
  alive = true;
  written: string[] = [];
  private listeners = new Set<(c: string) => void>();
  constructor(
    readonly cliType: string,
    private readonly script: (input: string, s: FakeSession) => void,
  ) {}
  out(chunk: string, delay = 0) {
    setTimeout(() => {
      for (const l of this.listeners) l(chunk);
    }, delay);
  }
  async isAlive() {
    return this.alive;
  }
  async send(text: string) {
    this.written.push(`${text}\r`);
    this.script(text, this);
  }
  async keys(data: string) {
    this.written.push(data);
    this.script(data, this);
  }
  subscribe(cb: (c: string) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  async snapshot() {
    return "";
  }
  async interrupt() {
    this.written.push("<INTERRUPT>");
    return "keys" as const;
  }
}

function req(
  message: string,
  extra: Partial<VoiceLlmTurnRequest> = {},
): VoiceLlmTurnRequest & { spoken: string[] } {
  const spoken: string[] = [];
  return {
    agentId: "main",
    backend: "gateway",
    message,
    callKey: "call-1",
    provider: "robovoice",
    callerIsOwner: true,
    onDelta: (t) => spoken.push(t),
    spoken,
    ...extra,
  };
}

const apiTurn = vi.fn(async (r: VoiceLlmTurnRequest): Promise<VoiceLlmTurnResult> => {
  r.onDelta("API answer.");
  return {
    text: "API answer.",
    backend: r.backend,
    sessionKey: "k",
    trust: "owner",
    firstTokenMs: 1,
    totalMs: 1,
  };
});

const fast = { settleMs: 80, speakBudgetMs: 400 };

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-cli-route-"));
  setVoiceCliRouteFileForTests(path.join(dir, "cli-route.json"));
  resetVoiceCliTurnsForTests();
  apiTurn.mockClear();
});
afterEach(() => {
  setVoiceCliRouteFileForTests(null);
  resetVoiceCliTurnsForTests();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("routing decision", () => {
  it("persists the route and only routes the owner", () => {
    expect(readVoiceCliRoute().mode).toBe("api");
    writeVoiceCliRoute({ mode: "cli", target: TARGET });
    expect(readVoiceCliRoute()).toMatchObject({ mode: "cli", target: { terminalId: "term-1" } });
    expect(activeCliTarget({ callerIsOwner: true })).toMatchObject({ terminalId: "term-1" });
    expect(activeCliTarget({ callerIsOwner: false })).toBeNull();
    writeVoiceCliRoute({ mode: "api", target: TARGET });
    expect(activeCliTarget({ callerIsOwner: true })).toBeNull();
  });

  it("cli mode without a target is not routable", () => {
    writeVoiceCliRoute({ mode: "cli" });
    expect(readVoiceCliRoute().mode).toBe("api");
  });

  it("runVoiceLlmTurn sends owner turns to the CLI session, guests to the API LLM", async () => {
    const s = new FakeSession("shell", (input, me) => {
      if (input.startsWith("hello")) me.out("hello\r\nHi from the CLI.\r\n$ ", 10);
    });
    const owner = req("hello there");
    const r = await runVoiceLlmTurn(owner, {
      cliRoute: TARGET,
      cliSession: { port: s, apiTurn, ...fast, emit: () => {} },
    });
    expect(r.timings?.path).toBe("cli");
    expect(r.text).toContain("Hi from the CLI.");
    expect(apiTurn).not.toHaveBeenCalled();

    // A guest never reaches the CLI: the API path runs (fake gateway agent here).
    const listeners = new Set<
      (e: { runId?: string; stream?: string; data?: Record<string, unknown> }) => void
    >();
    const guest = req("hello there", { callerIsOwner: false, mode: "agent" });
    const g = await runVoiceLlmTurn(guest, {
      cliRoute: TARGET,
      cliSession: { port: s, apiTurn, ...fast },
      gateway: {
        onAgentEvent: (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        runAgent: async (o) => {
          for (const l of listeners)
            l({
              runId: o.runId,
              stream: "assistant",
              data: { delta: "Guest answer.", text: "Guest answer." },
            });
          for (const l of listeners)
            l({ runId: o.runId, stream: "lifecycle", data: { phase: "end" } });
        },
      },
    });
    expect(g.timings?.path).not.toBe("cli");
    expect(g.text).toContain("Guest answer.");
    expect(s.written).toEqual(["hello there\r"]);
  });
});

describe("CLI session turn", () => {
  it("talks directly (no relay ack), streams the cleaned reply, ends when the session settles", async () => {
    const s = new FakeSession("shell", (input, me) => {
      me.out(`${input}\r\n`, 5);
      me.out("\x1b[1mLine one of the answer.\x1b[0m\r\n", 30);
      me.out("Line two of the answer.\r\n$ ", 60);
    });
    const r0 = req("explain the build");
    const r = await runCliSessionVoiceTurn(r0, TARGET, {
      port: s,
      apiTurn,
      ...fast,
      emit: () => {},
    });
    expect(r0.spoken.join("")).toMatch(/^Line one of the answer\./);
    expect(r0.spoken.join("")).not.toMatch(/sending|passing that/i);
    expect(r.text).toBe("Line one of the answer.\nLine two of the answer.");
    expect(r0.spoken.join("")).toContain("Line one of the answer. Line two of the answer.");
    expect(r0.spoken.join("")).not.toContain("explain the build");
    expect(s.written).toEqual(["explain the build\r"]);
  });

  it("reads a permission prompt aloud and answers it by voice", async () => {
    const s = new FakeSession("shell", (input, me) => {
      if (input.startsWith("deploy")) me.out("About to deploy.\r\nProceed with deploy? [y/N] ", 10);
      else if (input === "y\r") me.out("y\r\nDeployed to staging.\r\n$ ", 10);
    });
    const r1 = req("deploy it");
    const a = await runCliSessionVoiceTurn(r1, TARGET, {
      port: s,
      apiTurn,
      ...fast,
      emit: () => {},
    });
    expect(a.text).toBe("About to deploy.\nThe terminal asks: Proceed with deploy? Say yes or no.");
    expect(r1.spoken.join("")).not.toContain("[y/N]");
    expect(r1.spoken.join("")).toContain("Say yes or no.");
    expect(voiceCliSessionState(TARGET).approval?.question).toMatch(/Proceed with deploy\?/);

    const r2 = req("yes, go ahead");
    const b = await runCliSessionVoiceTurn(r2, TARGET, {
      port: s,
      apiTurn,
      ...fast,
      emit: () => {},
    });
    expect(s.written).toContain("y\r");
    expect(r2.spoken.join("")).toMatch(/^Approved\./);
    expect(b.text).toBe("Deployed to staging.");
    expect(voiceCliSessionState(TARGET).approval).toBeUndefined();
  });

  it("deny answers the menu with its No option", async () => {
    const s = new FakeSession("claude", (input, me) => {
      if (input.startsWith("delete"))
        me.out("● Bash(rm -rf dist)\r\n Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n", 10);
      else if (input === "2") me.out("● Okay, I won't delete it.\r\n\r\n", 10);
    });
    const tgt = { ...TARGET, cliType: "claude" };
    await runCliSessionVoiceTurn(req("delete the dist folder"), tgt, {
      port: s,
      apiTurn,
      ...fast,
      emit: () => {},
    });
    const r = await runCliSessionVoiceTurn(req("no"), tgt, {
      port: s,
      apiTurn,
      ...fast,
      emit: () => {},
    });
    expect(s.written).toContain("2");
    expect(r.text).toBe("Okay, I won't delete it.");
  });

  it("barge-in interrupts a session that is still producing", async () => {
    const s = new FakeSession("claude", (_input, me) => {
      me.out("● Bash(pnpm test)\r\n", 10);
    });
    const abort = new AbortController();
    const r0 = req("run all the tests", { signal: abort.signal });
    setTimeout(() => abort.abort(), 60);
    const r = await runCliSessionVoiceTurn(
      r0,
      { ...TARGET, cliType: "claude" },
      { port: s, apiTurn, ...fast, emit: () => {} },
    );
    expect(s.written).toContain("<INTERRUPT>");
    expect(r.timings?.routeReason).toMatch(/barge-in/);
  });

  it("'stop' spoken interrupts at any time", async () => {
    const s = new FakeSession("shell", () => {});
    const r0 = req("stop");
    const r = await runCliSessionVoiceTurn(r0, TARGET, {
      port: s,
      apiTurn,
      ...fast,
      emit: () => {},
    });
    expect(s.written).toEqual(["<INTERRUPT>"]);
    expect(r.text).toBe("Stopped.");
  });

  it("a dead session → spoken notice, route falls back, API LLM answers", async () => {
    const s = new FakeSession("shell", () => {});
    s.alive = false;
    const fallBack = vi.fn();
    const r0 = req("what's the status");
    const r = await runCliSessionVoiceTurn(r0, TARGET, {
      port: s,
      apiTurn,
      fallBack,
      ...fast,
      emit: () => {},
    });
    expect(fallBack).toHaveBeenCalledOnce();
    expect(apiTurn).toHaveBeenCalledOnce();
    expect(r0.spoken.join("")).toMatch(/mock-cli session isn't running any more/);
    expect(r.text).toMatch(/API answer\.$/);
    expect(s.written).toEqual([]);
  });

  it("the session dying mid-turn falls back, says so, and lets the API answer", async () => {
    const s = new FakeSession("shell", (_i, me) => {
      setTimeout(() => (me.alive = false), 50);
    });
    const fallBack = vi.fn();
    const r = await runCliSessionVoiceTurn(req("build it"), TARGET, {
      port: s,
      apiTurn,
      fallBack,
      settleMs: 80,
      speakBudgetMs: 5_000,
      emit: () => {},
    });
    expect(fallBack).toHaveBeenCalledOnce();
    expect(apiTurn).toHaveBeenCalledOnce();
    expect(r.text).toMatch(/session just closed/);
    expect(r.text).toMatch(/API answer\.$/);
  }, 10_000);

  it("long work: 'still working', then milestones and the result through the progress hub", async () => {
    const hub = new VoiceProgressHub();
    const s = new FakeSession("claude", (_i, me) => {
      me.out("● Bash(pnpm build)\r\n", 50);
      me.out("● The build finished without errors.\r\n\r\n", 600);
    });
    const r0 = req("build everything");
    const r = await runCliSessionVoiceTurn(
      r0,
      { ...TARGET, cliType: "claude" },
      { port: s, apiTurn, progress: hub, ...fast, emit: () => {} },
    );
    expect(r.text).toMatch(/still working on it/i);
    expect(r.running).toBe(1);
    await new Promise((res) => setTimeout(res, 1_000));
    const sessionKey = r.sessionKey;
    hub.callSeen(sessionKey, { intervalMs: 1 });
    const said = hub.take(sessionKey).join(" ");
    expect(said).toMatch(/The build finished without errors/);
  }, 10_000);
});

describe("reply source: transcript / rendered screen (not raw TUI bytes)", () => {
  /** Claude Code-like: the PTY gets spinner frames; the transcript gets the answer. */
  class TranscriptSession extends FakeSession {
    events: Array<import("./voice-cli-transcript.js").CliTranscriptEvent> = [];
    transcript() {
      return {
        file: () => "/fake/transcript.jsonl",
        poll: () => this.events.splice(0),
      };
    }
  }

  it("speaks the transcript's answer and ends on its end-of-turn, ignoring spinner bytes", async () => {
    const s = new TranscriptSession("claude", (input, me) => {
      if (!input.startsWith("What is")) return;
      me.out("\x1b[2;1H✶ h i\x1b[3;1H✢ t s · tmux detected", 5);
      setTimeout(() => me.events.push({ kind: "tool", name: "Bash" }), 15);
      setTimeout(() => me.events.push({ kind: "text", text: "17 times 3 is 51." }), 30);
      // Spinner keeps going after the answer: the transcript's end decides, not quiet time.
      me.out("\x1b[2;1H✻ Crunched for 1s", 40);
      setTimeout(() => me.events.push({ kind: "end" }), 50);
    });
    const r0 = req("What is 17 times 3?");
    const r = await runCliSessionVoiceTurn(
      r0,
      { ...TARGET, cliType: "claude" },
      {
        port: s,
        apiTurn,
        settleMs: 5_000,
        speakBudgetMs: 5_000,
        emit: () => {},
      },
    );
    expect(r.text).toBe("17 times 3 is 51.");
    expect(r.timings?.routeReason).toContain("reply (transcript)");
    const said = r0.spoken.join("");
    expect(said).toContain("17 times 3 is 51.");
    expect(said).not.toMatch(/✶|tmux|Crunched|h i/);
    expect(r.totalMs).toBeLessThan(2_000);
  });

  it("long transcript work goes to the background and finishes from the transcript", async () => {
    const s = new TranscriptSession("claude", (input, me) => {
      if (!input.startsWith("refactor")) return;
      setTimeout(() => me.events.push({ kind: "tool", name: "Edit" }), 20);
      setTimeout(
        () => me.events.push({ kind: "text", text: "Refactor done." }, { kind: "end" }),
        250,
      );
    });
    const progress = new VoiceProgressHub();
    const r = await runCliSessionVoiceTurn(
      req("refactor the parser"),
      { ...TARGET, cliType: "claude" },
      {
        port: s,
        apiTurn,
        progress,
        settleMs: 80,
        speakBudgetMs: 100,
        emit: () => {},
      },
    );
    expect(r.text).toMatch(/still working/i);
    await new Promise((res) => setTimeout(res, 900));
    progress.callSeen(r.sessionKey, { intervalMs: 1 });
    expect(progress.take(r.sessionKey).join(" ")).toContain("Refactor done.");
  });

  it("no transcript: the reply is read off the rendered screen once the session is quiet", async () => {
    let screen = "$ gemini\n> hello there\n";
    const s = new FakeSession("gemini", (input, me) => {
      if (!input.startsWith("hello")) return;
      me.out("\x1b[5;1H⠋ Thinking\x1b[5;1H⠙", 5);
      setTimeout(() => {
        screen += "✦ Hi! What can I do for you?\n\n> Type your message\n";
      }, 10);
    }) as FakeSession & { screen?: () => Promise<string> };
    s.screen = async () => screen;
    const r0 = req("hello there");
    const r = await runCliSessionVoiceTurn(
      r0,
      { ...TARGET, cliType: "gemini" },
      {
        port: s,
        apiTurn,
        ...fast,
        emit: () => {},
      },
    );
    expect(r.timings?.routeReason).toContain("reply (screen)");
    expect(r.text).toContain("Hi! What can I do for you?");
    expect(r0.spoken.join("")).not.toContain("Thinking");
  });

  it("the CLI exited to its shell: the turn falls back instead of typing into bash", async () => {
    const s = new FakeSession("claude", () => {});
    s.alive = false;
    const r0 = req("hello");
    const r = await runCliSessionVoiceTurn(
      r0,
      { ...TARGET, cliType: "claude" },
      {
        port: s,
        apiTurn,
        ...fast,
        fallBack: () => {},
        emit: () => {},
      },
    );
    expect(s.written).toEqual([]);
    expect(apiTurn).toHaveBeenCalledOnce();
    expect(r.text).toContain("API answer.");
  });
});

import { beforeEach, describe, expect, it } from "vitest";

import {
  HANDOFF_TOOL,
  fastVoiceMessages,
  fastVoiceSystemPrompt,
  historyAsContext,
  runFastVoiceTurn,
  type FastModelHandle,
  type FastStreamEvent,
  type FastTurnDeps,
} from "./voice-fast-turn.js";
import {
  makeTurnTracker,
  runVoiceLlmTurn,
  type GatewayTurnDeps,
  type VoiceLlmTurnRequest,
} from "./voice-llm-turn.js";
import { clearVoiceRoutesForTests } from "./voice-route.js";

beforeEach(() => clearVoiceRoutesForTests());

const handle = {
  ref: "fake/voice",
  model: { id: "voice", provider: "fake", api: "openai-completions" },
  apiKey: "k",
} as unknown as FastModelHandle;

const base = (over: Partial<VoiceLlmTurnRequest> = {}): VoiceLlmTurnRequest => ({
  agentId: "main",
  backend: "gateway",
  mode: "auto",
  message: "hello there",
  callKey: "loc-1:room",
  provider: "robovoice",
  callerIsOwner: false,
  onDelta: () => {},
  ...over,
});

type Seen = { system: string; messages: Array<{ role: string; text: string }>; tools: string[] };

function fastDeps(events: FastStreamEvent[] | Error, seen: Seen[] = [], gateway?: GatewayTurnDeps) {
  const deps: FastTurnDeps = {
    resolveModel: async () => handle,
    persona: () => "Your name is INFINI.",
    tools: async () => [],
    now: () => new Date("2026-10-02T08:00:00Z"),
    gateway,
    stream: async function* (_h, context) {
      seen.push({
        system: context.systemPrompt ?? "",
        messages: context.messages.map((m) => ({
          role: m.role,
          text:
            typeof m.content === "string"
              ? m.content
              : m.content.map((c) => ("text" in c ? c.text : "")).join(""),
        })),
        tools: (context.tools ?? []).map((t) => t.name),
      });
      if (events instanceof Error) throw events;
      for (const ev of events) yield ev;
    },
  };
  return deps;
}

/** A full-agent stand-in: streams `reply` as assistant deltas, records what it was asked. */
function agentDeps(reply: string[], calls: Array<{ message: string; extraSystemPrompt: string }>) {
  let listener:
    | ((evt: { runId?: string; stream?: string; data?: Record<string, unknown> }) => void)
    | null = null;
  const deps: GatewayTurnDeps = {
    onAgentEvent: (l) => {
      listener = l;
      return () => (listener = null);
    },
    runAgent: async (o) => {
      calls.push({ message: o.message, extraSystemPrompt: o.extraSystemPrompt });
      listener?.({ runId: o.runId, stream: "lifecycle", data: { phase: "start" } });
      for (const d of reply)
        listener?.({ runId: o.runId, stream: "assistant", data: { delta: d } });
      return { payloads: [] };
    },
  };
  return deps;
}

/** Like agentDeps, but the answer arrives after `delayMs` (a slow tool / model). */
function slowAgentDeps(reply: string[], delayMs: number) {
  let listener:
    | ((evt: { runId?: string; stream?: string; data?: Record<string, unknown> }) => void)
    | null = null;
  const deps: GatewayTurnDeps = {
    onAgentEvent: (l) => {
      listener = l;
      return () => (listener = null);
    },
    runAgent: async (o) => {
      listener?.({ runId: o.runId, stream: "lifecycle", data: { phase: "start" } });
      await new Promise((r) => setTimeout(r, delayMs));
      for (const d of reply)
        listener?.({ runId: o.runId, stream: "assistant", data: { delta: d } });
      return { payloads: [] };
    },
  };
  return deps;
}

describe("fast voice turn", () => {
  it("answers a conversational turn with one streamed model call (no agent run)", async () => {
    const seen: Seen[] = [];
    const calls: Array<{ message: string; extraSystemPrompt: string }> = [];
    const deltas: string[] = [];
    const r = await runFastVoiceTurn(
      base({ onDelta: (t) => deltas.push(t) }),
      fastDeps(
        [
          { type: "text", delta: "I'm doing well. " },
          { type: "text", delta: "How can I help?" },
        ],
        seen,
        agentDeps(["never"], calls),
      ),
    );
    // The opening is held until it is a full sentence of some length (refusal guard), then streamed.
    expect(deltas.join("")).toBe("I'm doing well. How can I help?");
    expect(r.text).toBe("I'm doing well. How can I help?");
    expect(r.timings).toMatchObject({ path: "fast", model: "fake/voice" });
    expect(r.timings?.firstSentenceMs).not.toBeNull();
    expect(r.sessionKey).toBe("agent:main:voicecall:robovoice:loc-1_room");
    expect(calls).toEqual([]);
    expect(seen[0].tools).toEqual([HANDOFF_TOOL]);
    expect(seen[0].system).toContain("[Live voice call");
    expect(seen[0].system).toContain("not verified as the owner");
    expect(seen[0].system).toContain("Never refuse");
    expect(r.timings?.routeReason).toBe("prefilter: small talk");
    expect(seen[0].system).toContain("Your name is INFINI.");
    expect(seen[0].system).toContain("Current date and time:");
  });

  it("hands tool work to the full agent; a fast agent answer gets NO acknowledgement", async () => {
    const calls: Array<{ message: string; extraSystemPrompt: string }> = [];
    const deltas: string[] = [];
    const r = await runFastVoiceTurn(
      base({
        message: "what was it we said last week?",
        history: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "Hello. How can I help?" },
          { role: "user", content: "what was it we said last week?" },
        ],
        onDelta: (t) => deltas.push(t),
      }),
      fastDeps(
        [{ type: "handoff", request: "look up the decision", ack: "Let me look that up" }],
        [],
        agentDeps(["You decided ", "to ship."], calls),
      ),
    );
    expect(deltas.join("")).toBe("You decided to ship.");
    expect(r.text).toBe("You decided to ship.");
    expect(r.timings?.path).toBe("fast+agent");
    expect(r.timings?.routeReason).toBe("model: hand-off");
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toMatch(
      /^\[Live voice call, the caller is not verified as the owner\..*\]\nwhat was it we said last week\?$/,
    );
    // The agent gets the call so far (the fast turns are not in its session).
    expect(calls[0].extraSystemPrompt).toContain("Caller: hi");
    expect(calls[0].extraSystemPrompt).toContain("You: Hello. How can I help?");
    expect(calls[0].extraSystemPrompt).not.toContain("Caller: what was it we said last week?");
  });

  it("a slow agent gets the model's own acknowledgement, spoken in parallel after the ack delay", async () => {
    const r = await runFastVoiceTurn(base({ message: "what was it we said last week?" }), {
      ...fastDeps(
        [{ type: "handoff", request: "look up the decision", ack: "Let me look that up" }],
        [],
        slowAgentDeps(["You decided to ship."], 60),
      ),
      ackDelayMs: 10,
    });
    expect(r.text).toBe("Let me look that up. You decided to ship.");
  });

  it("the old canned line is never spoken, even when the model writes it", async () => {
    const r = await runFastVoiceTurn(base({ message: "what was it we said last week?" }), {
      ...fastDeps(
        [{ type: "handoff", ack: "One moment, let me check." }],
        [],
        slowAgentDeps(["Found it."], 60),
      ),
      ackDelayMs: 10,
    });
    expect(r.text).not.toMatch(/one moment/i);
    expect(r.text).toMatch(/Found it\.$/);
  });

  it("a tool-only agent turn with nothing to say ends with a short 'Done.'", async () => {
    const r = await runFastVoiceTurn(
      base(),
      fastDeps([{ type: "handoff" }], [], agentDeps([], [])),
    );
    expect(r.text).toBe("Done.");
  });

  it("falls back to the full agent when the fast step fails before saying anything", async () => {
    const calls: Array<{ message: string; extraSystemPrompt: string }> = [];
    const r = await runFastVoiceTurn(
      base(),
      fastDeps(new Error("401 no key"), [], agentDeps(["Hi from the agent."], calls)),
    );
    expect(r.text).toBe("Hi from the agent.");
    expect(r.timings).toMatchObject({ path: "agent", fastError: "401 no key" });
    expect(calls).toHaveLength(1);
  });

  it("a model error after part of the answer was spoken stops there (no second answer)", async () => {
    const calls: Array<{ message: string; extraSystemPrompt: string }> = [];
    const r = await runFastVoiceTurn(
      base(),
      fastDeps(
        [
          { type: "text", delta: "Sure, the tides come from the pull of the moon on the oceans. " },
          { type: "error", error: "stream reset" },
        ],
        [],
        agentDeps(["again"], calls),
      ),
    );
    expect(r.text).toBe("Sure, the tides come from the pull of the moon on the oceans. ");
    expect(r.timings).toMatchObject({ path: "fast", fastError: "stream reset" });
    expect(calls).toEqual([]);
  });

  it("a model error before anything was spoken (opening still held) falls back to the agent", async () => {
    const calls: Array<{ message: string; extraSystemPrompt: string }> = [];
    const r = await runFastVoiceTurn(
      base(),
      fastDeps(
        [
          { type: "text", delta: "Sure, " },
          { type: "error", error: "stream reset" },
        ],
        [],
        agentDeps(["Hi from the agent."], calls),
      ),
    );
    expect(r.text).toBe("Hi from the agent.");
    expect(r.timings).toMatchObject({ path: "agent", fastError: "stream reset" });
  });

  it("mode decides the path: agent (default) never uses the fast step", async () => {
    const calls: Array<{ message: string; extraSystemPrompt: string }> = [];
    const seen: Seen[] = [];
    const gateway = agentDeps(["Agent reply."], calls);
    const fast = fastDeps([{ type: "text", delta: "Fast reply." }], seen);
    const a = await runVoiceLlmTurn(base({ mode: undefined }), { gateway, fast });
    expect(a.text).toBe("Agent reply.");
    expect(a.timings?.path).toBe("agent");
    expect(seen).toHaveLength(0);
    const b = await runVoiceLlmTurn(base({ mode: "auto" }), { gateway, fast });
    expect(b.text).toBe("Fast reply.");
    expect(calls).toHaveLength(1);
  });
});

describe("fast voice prompt + history", () => {
  it("owner callers are told so; context lines are included", () => {
    const p = fastVoiceSystemPrompt(
      { callerIsOwner: true, context: 'Location "HQ".', agentId: "main" },
      "",
    );
    expect(p).toContain("The caller is the owner of this assistant");
    expect(p).toContain(
      "Nothing about their own projects, business, data, agents or systems is confidential from them.",
    );
    expect(p).not.toContain("decline");
    expect(p).toContain('Location "HQ".');
    expect(p).not.toContain("[Who you are]");
  });

  it("history: last turns only, no duplicate of the current utterance, starts with the caller", () => {
    const history = [
      { role: "assistant" as const, content: "Greeting." },
      { role: "system" as const, content: "ignored" },
      { role: "user" as const, content: "one" },
      { role: "assistant" as const, content: "two" },
      { role: "user" as const, content: "three" },
    ];
    const msgs = fastVoiceMessages(history, "three", handle);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[2].content).toBe("three");
    expect(historyAsContext(history, "three")).toBe(
      "Earlier in this call (spoken, most recent last):\nYou: Greeting.\nCaller: one\nYou: two",
    );
    expect(historyAsContext([], "x")).toBe("");
  });
});

describe("turn tracker", () => {
  it("marks the first complete sentence, not just the first token", async () => {
    const t = makeTurnTracker(Date.now() - 100, () => {});
    t.push("Hello");
    expect(t.firstTokenMs).toBeGreaterThanOrEqual(100);
    const before = t.firstSentenceMs;
    t.push(" there. ");
    await new Promise((r) => setTimeout(r, 15));
    t.push("More");
    expect(t.firstSentenceMs).toBeGreaterThanOrEqual(before ?? 0);
    const marked = t.firstSentenceMs;
    await new Promise((r) => setTimeout(r, 15));
    expect(t.firstSentenceMs).toBe(marked);
    expect(t.text).toBe("Hello there. More");
  });
});

describe("gateway voice turn", () => {
  it("returns at the run's own end without waiting for agentCommand's tail", async () => {
    let listener:
      | ((evt: { runId?: string; stream?: string; data?: Record<string, unknown> }) => void)
      | null = null;
    let finishTail: (() => void) | null = null;
    const deps: GatewayTurnDeps = {
      onAgentEvent: (l) => {
        listener = l;
        return () => (listener = null);
      },
      runAgent: (o) => {
        listener?.({ runId: o.runId, stream: "lifecycle", data: { phase: "start" } });
        listener?.({ runId: o.runId, stream: "assistant", data: { delta: "Done." } });
        listener?.({ runId: o.runId, stream: "lifecycle", data: { phase: "end" } });
        return new Promise((resolve) => (finishTail = () => resolve({ payloads: [] })));
      },
    };
    const { runGatewayVoiceTurn } = await import("./voice-llm-turn.js");
    const r = await runGatewayVoiceTurn(base({ mode: "agent" }), deps);
    expect(r.text).toBe("Done.");
    expect(r.timings).toMatchObject({ path: "agent" });
    expect(r.timings?.agentPrepMs).not.toBeNull();
    finishTail?.();
  });
});

// The live call of 2026-10-02 20:51: the fast model answered work requests with refusals.
describe("routing: the fast step is only for small talk", () => {
  const owner = (message: string, over: Partial<VoiceLlmTurnRequest> = {}) =>
    base({ message, callerIsOwner: true, ...over });

  it.each([
    "My in progress projects.",
    "Tell me about our RoboVoice project.",
    "Can you spawn an InfiniBot agent to send me a message saying hello on Telegram?",
  ])("work request goes to the agent without asking the fast model: %s", async (message) => {
    const seen: Seen[] = [];
    const calls: Array<{ message: string; extraSystemPrompt: string }> = [];
    const deltas: string[] = [];
    const r = await runFastVoiceTurn(
      owner(message, { onDelta: (t) => deltas.push(t) }),
      fastDeps(
        [{ type: "text", delta: "I'm sorry, but I can't share details about that project." }],
        seen,
        agentDeps(["Here is what I found."], calls),
      ),
    );
    expect(seen).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toBe(
      `[Live voice call, the owner is on the line. What they say is the go-ahead: do it directly with your tools, no request_approval. Start long work in the background and never wait on it (no subagents_wait). Reply in one to three short spoken sentences.]\n${message}`,
    );
    expect(calls[0].extraSystemPrompt).toContain("not confidential from them");
    expect(r.timings?.path).toBe("fast+agent");
    expect(r.timings?.routeReason).toMatch(/^prefilter: /);
    // The agent answered at once: no filler in front of it, never a refusal.
    expect(r.text).toBe("Here is what I found.");
    expect(r.text).not.toMatch(/sorry|can't/i);
  });

  it('"Why not?" after an agent turn stays with the agent', async () => {
    const calls: Array<{ message: string; extraSystemPrompt: string }> = [];
    const seen: Seen[] = [];
    const deps = fastDeps(
      [{ type: "text", delta: "I'm sorry, but I can't discuss that." }],
      seen,
      agentDeps(["Because the bot token is missing."], calls),
    );
    await runFastVoiceTurn(owner("Tell me about our RoboVoice project."), deps);
    const r = await runFastVoiceTurn(owner("Why not?"), deps);
    expect(seen).toHaveLength(0);
    expect(calls.map((c) => c.message.split("\n").pop())).toEqual([
      "Tell me about our RoboVoice project.",
      "Why not?",
    ]);
    expect(r.timings?.routeReason).toBe("prefilter: follow-up to an agent turn");
  });

  it('"Why not?" after a spoken refusal in the history goes to the agent (new gateway process)', async () => {
    const calls: Array<{ message: string; extraSystemPrompt: string }> = [];
    const r = await runFastVoiceTurn(
      owner("Why not?", {
        history: [
          { role: "user", content: "Tell me about our RoboVoice project." },
          {
            role: "assistant",
            content: "I'm sorry, but I can't share details about that project.",
          },
          { role: "user", content: "Why not?" },
        ],
      }),
      fastDeps(
        [{ type: "text", delta: "I'm sorry, but I can't discuss that." }],
        [],
        agentDeps(["Let me explain."], calls),
      ),
    );
    expect(calls).toHaveLength(1);
    expect(r.timings?.routeReason).toBe("prefilter: follow-up to a refusal");
    expect(r.text).not.toMatch(/sorry/i);
  });

  it.each(["Hello, can you hear me?", "Who is this?"])(
    "small talk stays on the fast step: %s",
    async (message) => {
      const calls: Array<{ message: string; extraSystemPrompt: string }> = [];
      const r = await runFastVoiceTurn(
        owner(message),
        fastDeps(
          [{ type: "text", delta: "Yes, loud and clear. This is Ash." }],
          [],
          agentDeps(["never"], calls),
        ),
      );
      expect(calls).toEqual([]);
      expect(r.timings).toMatchObject({ path: "fast", routeReason: "prefilter: small talk" });
      expect(r.text).toBe("Yes, loud and clear. This is Ash.");
    },
  );
});

describe("refusal guard", () => {
  it.each([
    "I'm sorry, but I can't share details about that project.",
    "I'm sorry, but I can't discuss that.",
    "I'm sorry, but I can't do that.",
    "I am unable to help with that request.",
    "Unfortunately I'm not able to look that up from here.",
    "I don't have access to your files.",
  ])("a refusal from the fast model is never spoken; the agent answers: %s", async (refusal) => {
    const calls: Array<{ message: string; extraSystemPrompt: string }> = [];
    const deltas: string[] = [];
    const words = refusal.split(" ");
    const r = await runFastVoiceTurn(
      // Nothing the pre-filter recognises, so the fast model is asked.
      base({
        message: "the thing from yesterday, you know the one",
        onDelta: (t) => deltas.push(t),
      }),
      fastDeps(
        words.map((w, i) => ({ type: "text" as const, delta: i ? ` ${w}` : w })),
        [],
        agentDeps(["Found it."], calls),
      ),
    );
    expect(calls).toHaveLength(1);
    expect(deltas.join("")).toBe("Found it.");
    expect(r.text).not.toContain(refusal);
    expect(r.timings).toMatchObject({ path: "fast+agent", routeReason: "refusal guard" });
  });

  it("a model without tool calling hands off with the HANDOFF marker (not spoken)", async () => {
    const calls: Array<{ message: string; extraSystemPrompt: string }> = [];
    const r = await runFastVoiceTurn(
      base({ message: "the thing from yesterday, you know the one" }),
      fastDeps([{ type: "text", delta: "HANDOFF" }], [], agentDeps(["Found it."], calls)),
    );
    expect(calls).toHaveLength(1);
    expect(r.text).toBe("Found it.");
    expect(r.timings?.routeReason).toBe("model: hand-off marker");
  });

  it("a refusal after an opening that was already spoken still continues on the agent", async () => {
    const calls: Array<{ message: string; extraSystemPrompt: string }> = [];
    const r = await runFastVoiceTurn(
      base({ message: "the thing from yesterday, you know the one" }),
      fastDeps(
        [
          { type: "text", delta: "Good question, that one is interesting to think about. " },
          { type: "text", delta: "I can't share that." },
        ],
        [],
        agentDeps(["Found it."], calls),
      ),
    );
    expect(calls).toHaveLength(1);
    expect(r.text).toMatch(/Found it\.$/);
    expect(r.timings?.routeReason).toBe("refusal guard (after speaking)");
  });

  it("ordinary replies that merely contain 'can't' in a harmless phrase are spoken", async () => {
    const calls: Array<{ message: string; extraSystemPrompt: string }> = [];
    const r = await runFastVoiceTurn(
      base(),
      fastDeps(
        [{ type: "text", delta: "Hey! I can't wait to hear what you are up to today." }],
        [],
        agentDeps(["never"], calls),
      ),
    );
    expect(calls).toEqual([]);
    expect(r.timings?.path).toBe("fast");
  });
});

describe("hand-off wording", () => {
  it("the agent is told not to acknowledge again and that spoken requests need no approval dialog", async () => {
    const calls: Array<{ message: string; extraSystemPrompt: string }> = [];
    const r = await runFastVoiceTurn(
      base({ message: "Send a message to the team.", callerIsOwner: true }),
      fastDeps([], [], agentDeps(["Sending it now.", "Done."], calls)),
    );
    expect(calls[0].extraSystemPrompt).toContain("do not acknowledge again");
    expect(calls[0].extraSystemPrompt).toContain("do not open or wait on approval dialogs");
    expect(calls[0].extraSystemPrompt).not.toMatch(/one moment, checking/i);
    // Two assistant messages of one run are not glued together.
    expect(r.text).toBe("Sending it now. Done.");
  });

  it("an untrusted caller's agent turn keeps the guest rules", async () => {
    const calls: Array<{ message: string; extraSystemPrompt: string }> = [];
    await runFastVoiceTurn(
      base({ message: "Send a message to the team." }),
      fastDeps([], [], agentDeps(["No."], calls)),
    );
    expect(calls[0].extraSystemPrompt).toContain("The caller is NOT the owner");
    expect(calls[0].extraSystemPrompt).toContain("do not acknowledge again");
    expect(calls[0].extraSystemPrompt).not.toContain("approval dialogs");
  });
});

describe("aborted turns", () => {
  it("a caller who speaks again (request aborted) ends the turn with a typed abort, no agent run", async () => {
    const calls: Array<{ message: string; extraSystemPrompt: string }> = [];
    const abort = new AbortController();
    const deps = fastDeps([], [], agentDeps(["never"], calls));
    deps.stream = async function* () {
      abort.abort();
      yield { type: "text", delta: "Well" };
    };
    await expect(runFastVoiceTurn(base({ signal: abort.signal }), deps)).rejects.toMatchObject({
      code: "aborted",
      message: "voice turn aborted",
    });
    expect(calls).toEqual([]);
  });
});

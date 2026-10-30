import { Type } from "@sinclair/typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AnyAgentTool } from "../../agents/tools/common.js";
import { clearAcksForTests, DELEGATE_ACKS } from "./voice-ack.js";
import {
  activityPhrase,
  startVoiceDelegation,
  watchCallChildren,
  type ChildActivity,
  type ChildCompletion,
  type ChildRun,
  type DelegateDeps,
} from "./voice-delegate.js";
import {
  fastVoiceSystemPrompt,
  pollVoiceUpdates,
  runFastVoiceTurn,
  type FastModelHandle,
  type FastStreamEvent,
  type FastTurnDeps,
} from "./voice-fast-turn.js";
import {
  runGatewayVoiceTurn,
  voiceCallSessionKey,
  type GatewayTurnDeps,
  type VoiceLlmTurnRequest,
} from "./voice-llm-turn.js";
import { clearBackgroundForTests } from "./voice-pending.js";
import { spokenSummary, VoiceProgressHub, voiceProgress } from "./voice-progress.js";
import { clearVoiceRoutesForTests, looksLikeRefusal } from "./voice-route.js";
import { DEFAULT_VOICE_TIMING, resolveVoiceTiming, voiceToolTimeoutMs } from "./voice-timing.js";
import { executeVoiceToolCalls, sanitizeVoiceToolArgs, DELEGATE_HINT } from "./voice-tools.js";

beforeEach(() => {
  clearVoiceRoutesForTests();
  clearBackgroundForTests();
  clearAcksForTests();
  voiceProgress.resetForTests();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const handle = {
  ref: "fake/voice",
  model: { id: "voice", provider: "fake", api: "openai-completions" },
  apiKey: "k",
} as unknown as FastModelHandle;

const owner = (over: Partial<VoiceLlmTurnRequest> = {}): VoiceLlmTurnRequest => ({
  agentId: "main",
  backend: "gateway",
  mode: "auto",
  message: "spawn a coder to fix the login bug in the cloud app",
  callKey: "loc-1:room",
  provider: "robovoice",
  callerIsOwner: true,
  onDelta: () => {},
  ...over,
});

function tool(name: string, run: (args: unknown) => Promise<string> | string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: Type.Object({ task: Type.String(), cleanup: Type.Optional(Type.String()) }),
    execute: async (_id: string, args: unknown) => ({
      content: [{ type: "text", text: await run(args) }],
      details: {},
    }),
  } as unknown as AnyAgentTool;
}

function scripted(
  rounds: FastStreamEvent[][],
  seen: Array<{ tools: string[]; system: string }> = [],
) {
  const queue = [...rounds];
  return async function* (
    _h: FastModelHandle,
    context: Parameters<NonNullable<FastTurnDeps["stream"]>>[1],
  ) {
    seen.push({
      tools: (context.tools ?? []).map((t) => t.name),
      system: context.systemPrompt ?? "",
    });
    for (const ev of queue.shift() ?? []) yield ev;
  };
}

const noAgent: GatewayTurnDeps = {
  onAgentEvent: () => () => {},
  runAgent: async () => {
    throw new Error("the full agent must not run on a delegated turn");
  },
};

function baseDeps(over: Partial<FastTurnDeps> = {}) {
  const delegated: Array<Record<string, unknown>> = [];
  const deps: FastTurnDeps = {
    resolveModel: async () => handle,
    persona: () => "",
    gateway: noAgent,
    ackDelayMs: 1000,
    chatSessionKey: async () => "agent:main:main",
    tools: async () => [tool("kanban", () => "2 open tasks")],
    delegate: async (p) => {
      delegated.push(p as unknown as Record<string, unknown>);
      return {
        taskId: "vt-test",
        sessionKey: `${p.callSessionKey}:dlg-x`,
        done: Promise.resolve(),
      };
    },
    ...over,
  };
  return { deps, delegated };
}

// ── routing ───────────────────────────────────────────────────────────────────

describe("delegation to the main agent", () => {
  it("routes a spawn request to the main agent at once and confirms in one sentence", async () => {
    const { deps, delegated } = baseDeps({
      stream: scripted([
        [
          {
            type: "delegate",
            task: "Spawn a coder to fix the login bug in the cloud app",
            ack: "On it. I'll keep you posted.",
          },
        ],
      ]),
    });
    const t0 = Date.now();
    const r = await runFastVoiceTurn(
      owner({
        history: [
          { role: "user", content: "the login on cloud is broken" },
          { role: "assistant", content: "Sorry to hear that." },
        ],
      }),
      deps,
    );
    expect(Date.now() - t0).toBeLessThan(200);
    expect(r.text).toBe("On it. I'll keep you posted.");
    expect(r.timings?.path).toBe("fast+delegate");
    expect(r.timings?.routeReason).toContain("model: delegate");
    expect(delegated).toHaveLength(1);
    expect(delegated[0].task).toBe("Spawn a coder to fix the login bug in the cloud app");
    expect(delegated[0].callSessionKey).toBe(voiceCallSessionKey(owner()));
    expect(delegated[0].chatSessionKey).toBe("agent:main:main");
    // The conversation so far goes with the task.
    expect(String(delegated[0].context)).toContain("Caller: the login on cloud is broken");
    expect(delegated[0].progressIntervalMs).toBe(DEFAULT_VOICE_TIMING.progressIntervalMs);
  });

  it("offers delegate_to_main to the owner's fast step and says the main agent can do everything", async () => {
    const seen: Array<{ tools: string[]; system: string }> = [];
    const { deps } = baseDeps({
      stream: scripted([[{ type: "delegate", task: "x", ack: "" }]], seen),
    });
    await runFastVoiceTurn(owner(), deps);
    expect(seen[0].tools).toContain("delegate_to_main");
    expect(seen[0].system).toContain("spawns sub-agents and coders");
    expect(seen[0].system).toContain(
      "Never refuse and never say you cannot do something, cannot spawn agents",
    );
    // No prompt line tells the model it lacks the ability to spawn.
    expect(seen[0].system).not.toMatch(/you (?:cannot|can't|can not) spawn/i);
    // An empty model ack → a pool line that promises an update.
    expect(DELEGATE_ACKS.some((a) => a.includes("update") || a.includes("posted"))).toBe(true);
  });

  it("guests get no delegation (their requests go to the full agent's guest rules)", () => {
    const p = fastVoiceSystemPrompt(
      { agentId: "main", callerIsOwner: false },
      "",
      undefined,
      [],
      false,
    );
    expect(p).not.toContain("delegate_to_main");
  });

  it("delegation can be switched off: the fast step falls back to the hand-off", async () => {
    const seen: Array<{ tools: string[]; system: string }> = [];
    const { deps } = baseDeps({
      stream: scripted(
        [[{ type: "text", delta: "You have two open tasks, ship voice and billing." }]],
        seen,
      ),
    });
    await runFastVoiceTurn(owner({ voiceTiming: { delegate: false } }), deps);
    expect(seen[0].tools).not.toContain("delegate_to_main");
  });
});

describe('never says it "can\'t spawn"', () => {
  const refusals = [
    "I'm sorry, but I can't spawn sub-agents from here.",
    "I can't spawn sub agents, unfortunately.",
    "Unfortunately I don't have the ability to start a coder.",
  ];
  for (const refusal of refusals) {
    it(`refusal before any tool is not spoken, the task is delegated: ${refusal}`, async () => {
      expect(looksLikeRefusal(refusal)).toBe(true);
      const spoken: string[] = [];
      const { deps, delegated } = baseDeps({
        stream: scripted([[{ type: "text", delta: refusal }]]),
      });
      const r = await runFastVoiceTurn(owner({ onDelta: (t) => spoken.push(t) }), deps);
      expect(spoken.join("")).not.toContain(refusal.slice(0, 20));
      expect(r.text).not.toMatch(/can't|cannot|don't have/i);
      // A delegate ack, with no relay narration ("handing that to the main agent").
      expect(DELEGATE_ACKS).toContain(r.text);
      expect(r.text).not.toMatch(/main agent|handing|sending/i);
      expect(r.timings?.path).toBe("fast+delegate");
      expect(delegated).toHaveLength(1);
      expect(delegated[0].task).toBe(owner().message);
    });
  }

  it('a tool error followed by "I can\'t spawn" is not spoken: the task goes to the main agent', async () => {
    const seen: Array<{ tools: string[]; system: string }> = [];
    const { deps, delegated } = baseDeps({
      tools: async () => [
        tool("sessions_spawn", () => '{"status":"error","error":"node: unknown node"}'),
      ],
      stream: scripted(
        [
          [
            {
              type: "toolcall",
              call: {
                type: "toolCall",
                id: "c1",
                name: "sessions_spawn",
                arguments: { task: "fix login", cleanup: "", node: "" },
              },
            },
          ],
          [{ type: "text", delta: "Sorry, I can't spawn sub-agents right now." }],
        ],
        seen,
      ),
    });
    const r = await runFastVoiceTurn(owner(), deps);
    expect(r.text).not.toMatch(/can't spawn/);
    expect(DELEGATE_ACKS).toContain(r.text);
    expect(r.text).not.toMatch(/main agent|handing|sending/i);
    expect(delegated).toHaveLength(1);
    expect(r.timings?.routeReason).toContain("refusal guard (after tools)");
  });

  it("a failed tool result tells the model to delegate instead of refusing", async () => {
    const results = await executeVoiceToolCalls(
      [{ type: "toolCall", id: "c1", name: "sessions_spawn", arguments: { task: "x" } }],
      [tool("sessions_spawn", () => '{"status":"forbidden","error":"agentId is not allowed"}')],
      { delegateHint: true },
    );
    expect(results[0].isError).toBe(true);
    expect(results[0].text).toContain(DELEGATE_HINT);
  });
});

// ── tool budgets ──────────────────────────────────────────────────────────────

describe("timing tiers", () => {
  it("fast tools get the fast budget, slow tools the slow one", async () => {
    const timing = resolveVoiceTiming({
      fastToolTimeoutMs: 1_000,
      slowToolTimeoutMs: 20_000,
      slowTools: ["web_search"],
    });
    expect(voiceToolTimeoutMs("kanban", timing)).toBe(1_000);
    expect(voiceToolTimeoutMs("web_search", timing)).toBe(20_000);
    // Defaults: ~6 s fast, 25 s slow, coders/spawn/web reads are slow.
    expect(voiceToolTimeoutMs("kanban", DEFAULT_VOICE_TIMING)).toBe(6_000);
    expect(voiceToolTimeoutMs("claude_coder", DEFAULT_VOICE_TIMING)).toBe(25_000);
    expect(voiceToolTimeoutMs("web_search", DEFAULT_VOICE_TIMING)).toBe(25_000);
  });

  it("a fast tool past its budget moves to the background; a slow tool of the same length finishes", async () => {
    const slow = (name: string) => tool(name, async () => (await sleep(80), `${name} ok`));
    const timing = {
      ...resolveVoiceTiming(),
      fastToolTimeoutMs: 20,
      slowToolTimeoutMs: 400,
      slowTools: ["web_search"],
    };
    const results = await executeVoiceToolCalls(
      [
        { type: "toolCall", id: "a", name: "kanban", arguments: {} },
        { type: "toolCall", id: "b", name: "web_search", arguments: {} },
      ],
      [slow("kanban"), slow("web_search")],
      { timing },
    );
    expect(results[0].late).toBeDefined();
    expect(results[0].text).toMatch(/Still running after 0 seconds|continues in the background/);
    expect(results[1].late).toBeUndefined();
    expect(results[1].text).toBe("web_search ok");
  });

  it("clamps owner settings to sane ranges", () => {
    const t = resolveVoiceTiming({
      fastToolTimeoutMs: 1,
      slowToolTimeoutMs: 999_999,
      progressIntervalMs: 10,
    });
    expect(t.fastToolTimeoutMs).toBe(1_000);
    expect(t.slowToolTimeoutMs).toBe(60_000);
    expect(t.progressIntervalMs).toBe(8_000);
  });

  it("drops empty optional args a small model invents, and never waits on runs", () => {
    const spawn = tool("sessions_spawn", () => "");
    expect(
      sanitizeVoiceToolArgs(spawn, {
        task: "fix",
        cleanup: "",
        node: "",
        caps: [],
        extra: {},
        n: 0,
      }),
    ).toEqual({ task: "fix", n: 0 });
    const events = {
      ...tool("subagents_events", () => ""),
      name: "subagents_events",
    } as AnyAgentTool;
    expect(sanitizeVoiceToolArgs(events, { waitSec: 180, runIds: ["r1"] })).toEqual({
      runIds: ["r1"],
    });
  });
});

// ── progress pacing ───────────────────────────────────────────────────────────

describe("spoken progress (VoiceProgressHub)", () => {
  function clockHub() {
    let t = 1_000_000;
    const chat: Array<{ key: string; text: string }> = [];
    const hub = new VoiceProgressHub({
      now: () => t,
      deliverToChat: (key, text) => {
        chat.push({ key, text });
      },
    });
    return { hub, chat, advance: (ms: number) => (t += ms) };
  }

  it("speaks progress no more often than the interval, newest only, never repeated", () => {
    const { hub, advance } = clockHub();
    hub.callSeen("call", { intervalMs: 18_000, chatSessionKey: "agent:main:main" });
    const task = hub.startTask("call", "fix the login bug");
    hub.progress(task.id, "I started a coder on it.");
    advance(5_000);
    expect(hub.take("call")).toEqual([]); // too soon after the confirmation
    hub.progress(task.id, "Still working: the coder is reading through the code.");
    advance(13_000);
    // Only the newest pending line of the task is spoken.
    expect(hub.take("call")).toEqual(["Still working: the coder is reading through the code."]);
    hub.progress(task.id, "Still working: the coder is running tests.");
    advance(10_000);
    expect(hub.take("call")).toEqual([]);
    advance(8_000);
    expect(hub.take("call")).toEqual(["Still working: the coder is running tests."]);
    // The same line again is dropped.
    expect(hub.progress(task.id, "Still working: the coder is running tests.")).toBe(false);
    advance(60_000);
    expect(hub.take("call")).toEqual([]);
  });

  it("a reply on the call resets the clock (no update right after the agent spoke)", () => {
    const { hub, advance } = clockHub();
    hub.callSeen("call", { intervalMs: 18_000 });
    const task = hub.startTask("call", "x");
    advance(20_000);
    hub.progress(task.id, "Still working: the sub-agent is researching.");
    hub.callSeen("call", { spoke: true });
    advance(3_000);
    expect(hub.take("call")).toEqual([]);
    // …but the next turn may weave it into its reply.
    expect(hub.take("call", { inTurn: true })).toEqual([
      "Still working: the sub-agent is researching.",
    ]);
  });

  it("merges progress of two tasks into one line", () => {
    const { hub, advance } = clockHub();
    hub.callSeen("call", { intervalMs: 18_000 });
    const a = hub.startTask("call", "a");
    const b = hub.startTask("call", "b");
    hub.progress(a.id, "Still working: the coder is building.");
    hub.progress(b.id, "Still working: the sub-agent is researching.");
    advance(18_000);
    expect(hub.take("call")).toEqual([
      "Still working: the sub-agent is researching; Still working: the coder is building.",
    ]);
  });

  it("the final result is due at once: a short spoken summary, the full text in the chat", () => {
    const { hub, chat, advance } = clockHub();
    hub.callSeen("call", { intervalMs: 18_000, chatSessionKey: "agent:main:main" });
    const task = hub.startTask("call", "fix the login bug");
    hub.progress(task.id, "Still working: the coder is running tests.");
    advance(2_000);
    const full =
      "Done: the PR is ready. The login bug was a stale cookie domain. I changed the cookie scope in auth.ts, added a regression test, and the full suite passes. Commit abc123 on fix/login.";
    hub.finish(task.id, { text: full });
    const said = hub.take("call");
    expect(said).toHaveLength(1);
    expect(said[0]).toBe(
      "Done: the PR is ready. The login bug was a stale cookie domain. The full details are in the chat.",
    );
    // A task's pending progress is dropped once its result is due.
    expect(said[0]).not.toContain("running tests");
    expect(chat).toEqual([
      { key: "agent:main:main", text: `Voice task "fix the login bug" finished:\n\n${full}` },
    ]);
    expect(hub.take("call")).toEqual([]);
  });

  it("after a hang-up nothing is spoken, the result still reaches the chat", () => {
    const { hub, chat, advance } = clockHub();
    hub.callSeen("call", { intervalMs: 18_000, idleMs: 60_000, chatSessionKey: "agent:main:s1" });
    const task = hub.startTask("call", "deploy check");
    advance(61_000);
    expect(hub.sweep()).toEqual(["call"]); // no turn / poll for the idle window → call over
    hub.finish(task.id, { text: "All three sites pass." });
    expect(hub.take("call")).toEqual([]);
    expect(chat).toEqual([
      {
        key: "agent:main:s1",
        text: 'Voice task "deploy check" finished:\n\nAll three sites pass.',
      },
    ]);
  });

  it("an explicit hang-up drops what was pending", () => {
    const { hub, advance } = clockHub();
    hub.callSeen("call", { intervalMs: 18_000 });
    const task = hub.startTask("call", "x");
    hub.progress(task.id, "Still working: the coder is building.");
    advance(20_000);
    hub.endCall("call");
    expect(hub.take("call")).toEqual([]);
  });

  it("summaries are speakable", () => {
    expect(spokenSummary("**Done.** See [the PR](https://github.com/x/y/pull/1).")).toBe(
      "Done. See the PR.",
    );
  });
});

// ── the tracker end to end (fake gateway) ────────────────────────────────────

type AgentEvt = {
  runId?: string;
  stream?: string;
  sessionKey?: string;
  data?: Record<string, unknown>;
};

function fakeGateway() {
  const listeners = new Set<(e: AgentEvt) => void>();
  const emit = (e: AgentEvt) => {
    for (const l of listeners) l(e);
  };
  const children: ChildRun[] = [];
  const completions = new Map<string, ChildCompletion>();
  const activities = new Map<string, ChildActivity>();
  return {
    emit,
    children,
    completions,
    activities,
    onAgentEvent: (l: (e: AgentEvt) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

describe("startVoiceDelegation (main agent + its coder)", () => {
  it("delegates, reports milestones and activity on schedule, then the final result", async () => {
    const gw = fakeGateway();
    let now = Date.now();
    const chat: Array<{ key: string; text: string }> = [];
    const hub = new VoiceProgressHub({
      now: () => now,
      deliverToChat: (key, text) => void chat.push({ key, text }),
    });
    const runs: Array<{ sessionKey: string; message: string; extraSystemPrompt: string }> = [];
    const deps: DelegateDeps = {
      onAgentEvent: gw.onAgentEvent,
      runAgent: async (o) => {
        runs.push({
          sessionKey: o.sessionKey,
          message: o.message,
          extraSystemPrompt: o.extraSystemPrompt,
        });
        const ev = (stream: string, data: Record<string, unknown>) =>
          gw.emit({ runId: o.runId, sessionKey: o.sessionKey, stream, data });
        ev("lifecycle", { phase: "start" });
        ev("tool", { phase: "start", name: "claude_coder" });
        gw.children.push({
          runId: "child-1",
          label: "fix-login",
          startedAt: now,
          coder: true,
        });
        ev("assistant", { delta: "I've started a coder to fix the login bug." });
        ev("lifecycle", { phase: "end" });
        return { payloads: [{ text: "I've started a coder to fix the login bug." }] };
      },
      listChildRuns: () => gw.children,
      completion: (id) => gw.completions.get(id),
      activity: (id) => gw.activities.get(id),
      hub,
      now: () => now,
      tickMs: 10,
      finalGraceMs: 400,
      maxTaskMs: 60_000,
    };
    const callKey = "agent:main:voicecall-owner:robovoice:loc-1_room";
    const h = await startVoiceDelegation(
      {
        agentId: "main",
        callSessionKey: callKey,
        chatSessionKey: "agent:main:main",
        task: "Spawn a coder to fix the login bug",
        context: "Earlier in this call (spoken, most recent last):\nCaller: login is broken",
        progressIntervalMs: 400,
      },
      deps,
    );
    expect(h.sessionKey).toMatch(/^agent:main:voicecall-owner:robovoice:loc-1_room:dlg-/);
    await sleep(30);
    expect(runs).toHaveLength(1);
    expect(runs[0].message).toContain("Caller: login is broken");
    expect(runs[0].message).toContain(
      "The owner asked on the call: Spawn a coder to fix the login bug",
    );
    expect(runs[0].extraSystemPrompt).toContain("Never wait on background work");
    expect(runs[0].extraSystemPrompt).toContain("Do simple actions directly");
    expect(runs[0].extraSystemPrompt).toContain("Coders are only for code, repository changes");
    expect(runs[0].extraSystemPrompt).toContain("Never put a backend/tool name");
    // Within the interval after the confirmation nothing is spoken.
    expect(hub.take(callKey)).toEqual([]);
    now += 420;
    await sleep(30);
    const first = hub.take(callKey);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatch(/started a coder/);
    // The coder runs its tests.
    gw.activities.set("child-1", { kind: "Bash", label: "Bash: pnpm vitest run", at: now });
    now += 60;
    await sleep(30);
    expect(hub.take(callKey)).toEqual([]); // throttled
    now += 400;
    await sleep(30);
    expect(hub.take(callKey)).toEqual(["Still working: the coder is running tests."]);
    // The coder finishes verified; the main agent summarises it on its session.
    gw.completions.set("child-1", {
      terminal: true,
      state: "verified",
      verdict: "VERIFIED",
      summary: "Fixed the cookie domain; tests pass.",
    });
    now += 30;
    await sleep(30);
    gw.emit({
      runId: "announce-1",
      sessionKey: h.sessionKey,
      stream: "lifecycle",
      data: { phase: "start" },
    });
    gw.emit({
      runId: "announce-1",
      sessionKey: h.sessionKey,
      stream: "assistant",
      data: { delta: "Done: the PR is ready. The login fix is verified and the tests pass." },
    });
    gw.emit({
      runId: "announce-1",
      sessionKey: h.sessionKey,
      stream: "lifecycle",
      data: { phase: "end" },
    });
    await h.done;
    expect(hub.take(callKey)).toEqual([
      "Done: the PR is ready. The login fix is verified and the tests pass.",
    ]);
    expect(chat).toHaveLength(1);
    expect(chat[0].key).toBe("agent:main:main");
    expect(chat[0].text).toContain("Done: the PR is ready.");
  });

  it("without a summary from the main agent the result is composed from the runs", async () => {
    const gw = fakeGateway();
    const hub = new VoiceProgressHub();
    const deps: DelegateDeps = {
      onAgentEvent: gw.onAgentEvent,
      runAgent: async (o) => {
        gw.emit({
          runId: o.runId,
          sessionKey: o.sessionKey,
          stream: "tool",
          data: { phase: "start", name: "sessions_spawn" },
        });
        gw.children.push({ runId: "c1", label: "site-check", startedAt: Date.now() });
        return { payloads: [{ text: "Started a sub-agent." }] };
      },
      listChildRuns: () => gw.children,
      completion: (id) => gw.completions.get(id),
      activity: () => undefined,
      hub,
      now: Date.now,
      tickMs: 10,
      finalGraceMs: 50,
      maxTaskMs: 60_000,
    };
    const h = await startVoiceDelegation(
      {
        agentId: "main",
        callSessionKey: "call-2",
        task: "check the sites",
        progressIntervalMs: 10_000,
      },
      deps,
    );
    await sleep(20);
    gw.completions.set("c1", {
      terminal: true,
      state: "verified",
      verdict: "VERIFIED",
      summary: "All three sites load.",
    });
    await h.done;
    const said = hub.take("call-2");
    expect(said).toEqual(["Done: site check is done and verified. All three sites load."]);
  });

  it("speaks a failed coder's reason and offers a retry", async () => {
    const gw = fakeGateway();
    const hub = new VoiceProgressHub();
    const deps: DelegateDeps = {
      onAgentEvent: gw.onAgentEvent,
      runAgent: async (o) => {
        gw.emit({
          runId: o.runId,
          sessionKey: o.sessionKey,
          stream: "tool",
          data: { phase: "start", name: "codex_coder" },
        });
        gw.children.push({ runId: "c1", label: "send-hello", startedAt: Date.now(), coder: true });
        return { payloads: [{ text: "Started a coder." }] };
      },
      listChildRuns: () => gw.children,
      completion: (id) => gw.completions.get(id),
      activity: () => undefined,
      hub,
      now: Date.now,
      tickMs: 10,
      finalGraceMs: 50,
      maxTaskMs: 60_000,
    };
    const h = await startVoiceDelegation(
      {
        agentId: "main",
        callSessionKey: "call-failed",
        task: "send hello",
        progressIntervalMs: 10_000,
      },
      deps,
    );
    await sleep(20);
    gw.completions.set("c1", {
      terminal: true,
      state: "failed",
      verdict: "FAILED",
      reasons: ["coding agent error: The 'codex' model is not supported with a ChatGPT account."],
    });
    await h.done;
    const said = hub.take("call-failed").join(" ");
    expect(said).toContain("failed because coding agent error");
    expect(said).toContain("not supported with a ChatGPT account");
    expect(said).toMatch(/retry/i);
  });

  it("the main agent's summary counts even when the run's review settles after it", async () => {
    const gw = fakeGateway();
    const hub = new VoiceProgressHub();
    let sessionKey = "";
    const h = await startVoiceDelegation(
      { agentId: "main", callSessionKey: "call-5", task: "fix it", progressIntervalMs: 10_000 },
      {
        onAgentEvent: gw.onAgentEvent,
        runAgent: async (o) => {
          sessionKey = o.sessionKey;
          gw.emit({
            runId: o.runId,
            sessionKey: o.sessionKey,
            stream: "tool",
            data: { phase: "start", name: "claude_coder" },
          });
          gw.children.push({ runId: "c1", label: "fix", startedAt: Date.now(), coder: true });
          return { payloads: [{ text: "Started a coder." }] };
        },
        listChildRuns: () => gw.children,
        completion: (id) => gw.completions.get(id),
        activity: () => undefined,
        hub,
        now: Date.now,
        tickMs: 10,
        finalGraceMs: 2_000,
        maxTaskMs: 60_000,
      },
    );
    await sleep(20);
    // The run ends; the main agent is told at once and answers…
    gw.children[0].endedAt = Date.now();
    gw.completions.set("c1", { terminal: false, state: "reviewing" });
    for (const [stream, data] of [
      ["lifecycle", { phase: "start" }],
      ["assistant", { delta: "Done: the fix is merged." }],
      ["lifecycle", { phase: "end" }],
    ] as const)
      gw.emit({ runId: "announce-9", sessionKey, stream, data });
    await sleep(150);
    // …and the verdict lands later.
    gw.completions.set("c1", {
      terminal: true,
      state: "verified",
      verdict: "VERIFIED",
      summary: "x",
    });
    await h.done;
    expect(hub.take("call-5")).toEqual(["Done: the fix is merged."]);
  });

  it("registry bookkeeping is not spoken as progress", () => {
    expect(
      activityPhrase(
        { kind: "progress", label: "", at: 0, message: "Starting: fix-login", status: "starting" },
        "the sub-agent",
      ),
    ).toBe("");
    expect(
      activityPhrase(
        { kind: "progress", label: "", at: 0, message: "Task completed", status: "finishing" },
        "the sub-agent",
      ),
    ).toBe("");
    expect(
      activityPhrase(
        {
          kind: "progress",
          label: "",
          at: 0,
          message: "running the test suite",
          status: "working",
        },
        "the sub-agent",
      ),
    ).toBe("Still working: running the test suite");
  });

  it("a task with no background work speaks the main agent's answer", async () => {
    const gw = fakeGateway();
    const hub = new VoiceProgressHub();
    const h = await startVoiceDelegation(
      {
        agentId: "main",
        callSessionKey: "call-3",
        task: "post the video",
        progressIntervalMs: 10_000,
      },
      {
        onAgentEvent: gw.onAgentEvent,
        runAgent: async () => ({ payloads: [{ text: "Posted the video to the TikTok page." }] }),
        listChildRuns: () => [],
        completion: () => undefined,
        activity: () => undefined,
        hub,
        now: Date.now,
        tickMs: 10,
        finalGraceMs: 50,
        maxTaskMs: 60_000,
      },
    );
    await h.done;
    expect(hub.take("call-3")).toEqual(["Posted the video to the TikTok page."]);
  });

  it("a main-agent error is reported, not swallowed", async () => {
    const gw = fakeGateway();
    const hub = new VoiceProgressHub();
    const h = await startVoiceDelegation(
      { agentId: "main", callSessionKey: "call-4", task: "x", progressIntervalMs: 10_000 },
      {
        onAgentEvent: gw.onAgentEvent,
        runAgent: async () => {
          throw new Error("model overloaded");
        },
        listChildRuns: () => [],
        completion: () => undefined,
        activity: () => undefined,
        hub,
        now: Date.now,
        tickMs: 10,
        finalGraceMs: 50,
        maxTaskMs: 60_000,
      },
    );
    await h.done;
    expect(hub.take("call-4")[0]).toMatch(/main agent hit an error: model overloaded/);
  });

  it("activity phrases", () => {
    expect(activityPhrase({ kind: "Edit", label: "Edit src/a.ts", at: 0 }, "the coder")).toBe(
      "Still working: the coder is editing the code.",
    );
    expect(activityPhrase({ kind: "Bash", label: "Bash: pnpm build", at: 0 }, "the coder")).toBe(
      "Still working: the coder is building.",
    );
    expect(activityPhrase(undefined, "x")).toBe("");
  });
});

// ── update poll / hang-up through the turn entry ──────────────────────────────

describe("update poll", () => {
  it("returns what is due and marks it said; a hang-up ends speech", () => {
    const req = owner();
    const key = voiceCallSessionKey(req);
    voiceProgress.callSeen(key, { intervalMs: 8_000 });
    const t = voiceProgress.startTask(key, "x", { spoke: false });
    voiceProgress.finish(t.id, { text: "Done: posted." });
    const first = pollVoiceUpdates(req);
    expect(first.updates).toEqual(["Done: posted."]);
    expect(pollVoiceUpdates(req).updates).toEqual([]);
    const t2 = voiceProgress.startTask(key, "y", { spoke: false });
    pollVoiceUpdates({ ...req, callEnded: true });
    // A late poll after the hang-up does not reopen the call.
    expect(pollVoiceUpdates({ ...req }).updates).toEqual([]);
    voiceProgress.finish(t2.id, { text: "Done: second." });
    expect(pollVoiceUpdates({ ...req }).updates).toEqual([]);
  });
});

// ── the full-agent path follows what it spawned ───────────────────────────────

describe("full agent voice turn", () => {
  it("follows the sub-agents an owner's turn started", async () => {
    const watched: Array<Record<string, unknown>> = [];
    const listeners = new Set<(e: AgentEvt) => void>();
    const gateway: GatewayTurnDeps = {
      onAgentEvent: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      runAgent: async (o) => {
        for (const l of listeners)
          l({ runId: o.runId, stream: "tool", data: { phase: "start", name: "sessions_spawn" } });
        for (const l of listeners)
          l({
            runId: o.runId,
            stream: "assistant",
            data: { delta: "Started three testers.", text: "Started three testers." },
          });
        return { payloads: [{ text: "Started three testers." }] };
      },
    };
    const r = await runGatewayVoiceTurn(
      owner({ mode: "agent", message: "test the three sites" }),
      gateway,
      {
        watchChildren: async (p) => {
          watched.push(p as unknown as Record<string, unknown>);
          return null;
        },
        chatSessionKey: "agent:main:main",
      },
    );
    expect(r.text).toBe("Started three testers.");
    await sleep(10);
    expect(watched).toHaveLength(1);
    expect(watched[0].callSessionKey).toBe(voiceCallSessionKey(owner()));
    expect(watched[0].chatSessionKey).toBe("agent:main:main");
  });

  it("tells the full agent never to wait on background work on a call", async () => {
    const prompts: string[] = [];
    await runGatewayVoiceTurn(owner({ mode: "agent" }), {
      onAgentEvent: () => () => {},
      runAgent: async (o) => {
        prompts.push(`${o.extraSystemPrompt}\n${o.message}`);
        return { payloads: [{ text: "ok" }] };
      },
    });
    expect(prompts[0]).toContain("do not call subagents_wait");
    expect(prompts[0]).toContain("never wait on it (no subagents_wait)");
  });
});

describe("watchCallChildren", () => {
  it("drops the task quietly when nothing was started", async () => {
    vi.useFakeTimers();
    try {
      const hub = new VoiceProgressHub();
      const h = await watchCallChildren(
        { callSessionKey: "c", since: Date.now(), label: "spawn x", progressIntervalMs: 10_000 },
        {
          onAgentEvent: () => () => {},
          runAgent: async () => ({}),
          listChildRuns: () => [],
          completion: () => undefined,
          activity: () => undefined,
          hub,
          now: Date.now,
          tickMs: 1_000,
          finalGraceMs: 50,
          maxTaskMs: 60_000,
        },
      );
      expect(h).not.toBeNull();
      expect(hub.running("c")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(21_000);
      expect(hub.running("c")).toHaveLength(0);
      expect(hub.take("c")).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { describe, expect, it, vi } from "vitest";

import type { GroupMember } from "../../shared/group-chat/planner.js";
import type {
  GroupChatEvent,
  GroupChatMeta,
  GroupTranscriptMessage,
  WorkflowGraph,
} from "../../shared/group-chat/types.js";
import { GroupChatService, type AgentTurnRunner, type GroupChatServiceDeps } from "./service.js";
import type { GroupChatStore, GroupRecord } from "./store.js";

const NAMES: Record<string, string> = { main: "Infini", coder: "Coder", qa: "QA" };

function memoryStore() {
  const groups = new Map<string, { title: string; meta: GroupChatMeta; updatedAt: number }>();
  const transcripts = new Map<string, GroupTranscriptMessage[]>();
  const memberLabels = new Map<string, string>();
  const store: GroupChatStore = {
    getGroup(key) {
      const g = groups.get(key);
      return g
        ? { key, title: g.title, meta: structuredClone(g.meta), updatedAt: g.updatedAt }
        : null;
    },
    async createGroup(key, title, meta) {
      groups.set(key, { title, meta: structuredClone(meta), updatedAt: Date.now() });
      transcripts.set(key, []);
      return { key, title, meta, updatedAt: Date.now() } satisfies GroupRecord;
    },
    async updateGroup(key, fn) {
      const g = groups.get(key);
      if (!g) return null;
      const res = fn(structuredClone(g.meta), { label: g.title }) ?? {};
      if (res.meta) g.meta = res.meta;
      if (res.label !== undefined) g.title = res.label;
      return { key, title: g.title, meta: g.meta, updatedAt: Date.now() };
    },
    readMessages: (key) => [...(transcripts.get(key) ?? [])],
    appendMessage(key, message) {
      transcripts.get(key)!.push(message);
      return message;
    },
    async ensureMemberSession(memberKey, label) {
      memberLabels.set(memberKey, label);
    },
    resolveMembers: (ids): GroupMember[] => ids.map((id) => ({ id, name: NAMES[id] ?? id })),
  };
  return { store, transcripts, memberLabels, groups };
}

function setup(runTurn: AgentTurnRunner, extra: Partial<GroupChatServiceDeps> = {}) {
  const mem = memoryStore();
  const events: GroupChatEvent[] = [];
  const svc = new GroupChatService({
    store: mem.store,
    runTurn,
    emit: (e) => events.push(e),
    ...extra,
  });
  const textOf = (key: string) =>
    mem.transcripts.get(key)!.map((m) => {
      const who =
        m.groupChat?.kind === "user"
          ? "user"
          : m.groupChat?.kind === "status"
            ? "status"
            : m.groupChat?.agentId;
      return `${who}: ${m.content[0].text}`;
    });
  return { ...mem, events, svc, textOf };
}

describe("GroupChatService conversation", () => {
  it("everyone mode: each member replies in order through its own member session, seeing prior replies", async () => {
    const prompts: Array<{ agentId: string; sessionKey: string; message: string }> = [];
    const { svc, textOf, memberLabels, events } = setup(async (p) => {
      prompts.push({ agentId: p.agentId, sessionKey: p.sessionKey, message: p.message });
      return { text: `${p.agentId} says hi` };
    });
    const g = await svc.createGroup({
      ownerAgentId: "main",
      members: ["main", "coder"],
      title: "Room",
    });
    expect(g.key).toMatch(/^agent:main:groupchat-/);
    await svc.postUserMessage(g.key, "hello team");
    await svc.idle(g.key);
    expect(textOf(g.key)).toEqual([
      "user: hello team",
      "main: main says hi",
      "coder: coder says hi",
    ]);
    const gid = g.key.split("groupchat-")[1];
    expect(prompts.map((p) => p.sessionKey)).toEqual([
      `agent:main:gcmember-${gid}`,
      `agent:coder:gcmember-${gid}`,
    ]);
    // Coder's turn sees the user message AND Infini's reply as group context.
    expect(prompts[1].message).toContain("User: hello team");
    expect(prompts[1].message).toContain("Infini (@main): main says hi");
    expect(memberLabels.get(`agent:coder:gcmember-${gid}`)).toBe("Room · Coder");
    expect(
      events.filter((e) => e.type === "turn.start").map((e) => (e as { agentId: string }).agentId),
    ).toEqual(["main", "coder"]);
  });

  it("an agent is only shown messages it has not seen before (no duplicated context)", async () => {
    const prompts: Record<string, string[]> = {};
    const { svc } = setup(async (p) => {
      (prompts[p.agentId] ??= []).push(p.message);
      return { text: `reply from ${p.agentId}` };
    });
    const g = await svc.createGroup({ ownerAgentId: "main", members: ["main", "coder"] });
    await svc.postUserMessage(g.key, "first question");
    await svc.idle(g.key);
    await svc.postUserMessage(g.key, "second question");
    await svc.idle(g.key);
    const second = prompts.main[1];
    expect(second).not.toContain("first question");
    expect(second).not.toContain("reply from main");
    expect(second).toContain("Coder (@coder): reply from coder");
    expect(second).toContain("User: second question");
  });

  it("@mention directs the turn; an agent's @mention hands off to another member", async () => {
    const { svc, textOf } = setup(async (p) => ({
      text: p.agentId === "coder" ? "Done. @qa please verify" : `${p.agentId} verified`,
    }));
    const g = await svc.createGroup({ ownerAgentId: "main", members: ["main", "coder", "qa"] });
    const res = await svc.postUserMessage(g.key, "@coder build it");
    expect(res.agents).toEqual(["coder"]);
    await svc.idle(g.key);
    expect(textOf(g.key)).toEqual([
      "user: @coder build it",
      "coder: Done. @qa please verify",
      "qa: qa verified",
    ]);
  });

  it("round-robin rotates and moderator mode asks only the lead; NO_REPLY is silent", async () => {
    const { svc, textOf } = setup(async (p) => ({
      text: p.agentId === "qa" ? "NO_REPLY" : `${p.agentId}!`,
    }));
    const rr = await svc.createGroup({
      ownerAgentId: "main",
      members: ["main", "coder"],
      mode: "round-robin",
    });
    await svc.postUserMessage(rr.key, "a");
    await svc.postUserMessage(rr.key, "b");
    await svc.idle(rr.key);
    expect(textOf(rr.key)).toEqual(["user: a", "user: b", "main: main!", "coder: coder!"]);
    const mod = await svc.createGroup({
      ownerAgentId: "main",
      members: ["main", "qa", "coder"],
      mode: "moderator",
      moderatorId: "qa",
    });
    await svc.postUserMessage(mod.key, "anyone?");
    await svc.idle(mod.key);
    expect(textOf(mod.key)).toEqual(["user: anyone?"]);
  });

  it("the user can interject while agents are replying; later turns see it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const prompts: string[] = [];
    const { svc, textOf } = setup(async (p) => {
      prompts.push(`${p.agentId}|${p.message}`);
      if (p.agentId === "main" && prompts.length === 1) await gate;
      return { text: `${p.agentId} ok` };
    });
    const g = await svc.createGroup({ ownerAgentId: "main", members: ["main", "coder"] });
    await svc.postUserMessage(g.key, "start");
    await vi.waitFor(() => expect(prompts.length).toBe(1));
    await svc.postUserMessage(g.key, "wait, also add tests");
    release();
    await svc.idle(g.key);
    const log = textOf(g.key);
    expect(log[0]).toBe("user: start");
    expect(log[1]).toBe("user: wait, also add tests");
    // Coder's first turn (still in round 1) already sees the interjection.
    expect(prompts[1]).toMatch(/^coder\|[\s\S]*wait, also add tests/);
    // Round 2 answers the interjection too.
    expect(log.filter((l) => l.startsWith("main:")).length).toBe(2);
  });

  it("abort stops the running turn and drops queued work", async () => {
    const { svc, textOf } = setup(
      (p) =>
        new Promise((resolve) => {
          p.signal.addEventListener("abort", () => resolve({ text: "", error: "aborted" }));
        }),
    );
    const g = await svc.createGroup({ ownerAgentId: "main", members: ["main", "coder"] });
    await svc.postUserMessage(g.key, "go");
    await vi.waitFor(() => expect(svc.describe(g.key).activeTurns.length).toBe(1));
    expect(svc.abort(g.key).aborted).toBe(1);
    await svc.idle(g.key);
    // The stopped turn reports, coder never runs.
    expect(textOf(g.key)).toEqual(["user: go", "main: Could not reply: stopped"]);
    expect(svc.describe(g.key).busy).toBe(false);
  });

  it("update renames and changes members/mode; unknown modes are rejected", async () => {
    const { svc } = setup(async () => ({ text: "x" }));
    const g = await svc.createGroup({ ownerAgentId: "main", members: ["main"] });
    await svc.updateGroup(g.key, { title: "Renamed", members: ["coder", "qa"], mode: "moderator" });
    const d = svc.describe(g.key);
    expect(d.title).toBe("Renamed");
    expect(d.members.map((m) => m.id)).toEqual(["coder", "qa"]);
    expect(d.moderatorId).toBe("coder");
    await expect(svc.updateGroup(g.key, { mode: "chaos" as never })).rejects.toThrow(
      /Unknown mode/,
    );
    await expect(svc.createGroup({ ownerAgentId: "main", members: [] })).rejects.toThrow(
      /at least one/,
    );
  });
});

describe("GroupChatService workflows", () => {
  const chain = (): WorkflowGraph => ({
    id: "wf-1",
    name: "Build → Review → Ship",
    nodes: [
      { id: "build", agentId: "coder", label: "Build", prompt: "Write the code", x: 0, y: 0 },
      { id: "review", agentId: "qa", label: "Review", prompt: "Review it", x: 0, y: 0 },
      { id: "ship", agentId: "main", label: "Ship", prompt: "Summarize", x: 0, y: 0 },
    ],
    edges: [
      { id: "e1", sourceId: "build", targetId: "review" },
      { id: "e2", sourceId: "review", targetId: "ship" },
    ],
  });

  it("runs steps in order, handing each step's output to the next, and logs status in the chat", async () => {
    const prompts: Record<string, string> = {};
    const { svc, textOf, events } = setup(async (p) => {
      prompts[p.agentId] = p.message;
      return { text: `OUT[${p.agentId}]` };
    });
    const g = await svc.createGroup({ ownerAgentId: "main", members: ["main", "coder", "qa"] });
    await svc.saveWorkflow(g.key, chain());
    const { run, done } = await svc.startWorkflow(g.key, "wf-1", "make a todo app");
    expect(run.status).toBe("running");
    const final = await done;
    expect(final.status).toBe("done");
    expect(final.steps.map((s) => [s.nodeId, s.status, s.output])).toEqual([
      ["build", "done", "OUT[coder]"],
      ["review", "done", "OUT[qa]"],
      ["ship", "done", "OUT[main]"],
    ]);
    expect(prompts.coder).toContain("make a todo app");
    expect(prompts.coder).toContain("first step");
    expect(prompts.qa).toContain("### Build — Coder (@coder)\nOUT[coder]");
    expect(prompts.main).toContain("### Review — QA (@qa)\nOUT[qa]");
    expect(prompts.main).not.toContain("OUT[coder]");
    const log = textOf(g.key);
    expect(log[0]).toBe("user: make a todo app");
    expect(log[1]).toMatch(
      /^status: Workflow "Build → Review → Ship" started — 3 steps in 3 stages/,
    );
    expect(log.slice(2)).toEqual([
      "coder: OUT[coder]",
      "qa: OUT[qa]",
      "main: OUT[main]",
      'status: Workflow "Build → Review → Ship" finished — 3 steps done.',
    ]);
    // Every workflow message is tagged with the run id (powers the chat filter).
    const runMsgs = svc["deps"].store
      .readMessages(g.key)
      .filter((m) => m.groupChat?.workflowRunId === run.id);
    expect(runMsgs).toHaveLength(6);
    expect(svc.describe(g.key).runs.at(-1)?.status).toBe("done");
    expect(events.filter((e) => e.type === "workflow").length).toBeGreaterThan(3);
  });

  it("sub-agents of a lead run in parallel and a join step receives both outputs", async () => {
    let concurrent = 0;
    let peak = 0;
    const prompts: Record<string, string> = {};
    const { svc } = setup(async (p) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent -= 1;
      prompts[p.agentId] = p.message;
      return { text: `OUT[${p.agentId}]` };
    });
    const g = await svc.createGroup({ ownerAgentId: "main", members: ["main", "coder", "qa"] });
    await svc.saveWorkflow(g.key, {
      id: "wf-2",
      name: "Fan out",
      nodes: [
        { id: "lead", agentId: "main", label: "Plan", x: 0, y: 0 },
        { id: "a", agentId: "coder", label: "Backend", x: 0, y: 0, parentId: "lead" },
        { id: "b", agentId: "qa", label: "Tests", x: 0, y: 0, parentId: "lead" },
      ],
      edges: [],
    });
    const { done } = await svc.startWorkflow(g.key, "wf-2", "");
    const final = await done;
    expect(final.status).toBe("done");
    expect(peak).toBe(2);
    expect(prompts.coder).toContain("### Plan — Infini (@main)\nOUT[main]");
    expect(prompts.qa).toContain("### Plan — Infini (@main)\nOUT[main]");
  });

  it("a failing step fails the run and skips the rest", async () => {
    const { svc, textOf } = setup(async (p) =>
      p.agentId === "qa" ? { text: "", error: "model down" } : { text: "ok" },
    );
    const g = await svc.createGroup({ ownerAgentId: "main", members: ["main", "coder", "qa"] });
    await svc.saveWorkflow(g.key, chain());
    const final = await (await svc.startWorkflow(g.key, "wf-1", "x")).done;
    expect(final.status).toBe("error");
    expect(final.steps.map((s) => s.status)).toEqual(["done", "error", "skipped"]);
    expect(textOf(g.key).at(-1)).toMatch(/failed/);
  });

  it("rejects cyclic workflows and steps for non-members", async () => {
    const { svc } = setup(async () => ({ text: "x" }));
    const g = await svc.createGroup({ ownerAgentId: "main", members: ["main", "coder"] });
    const cyc = chain();
    cyc.edges.push({ id: "e3", sourceId: "ship", targetId: "build" });
    await expect(svc.saveWorkflow(g.key, cyc)).rejects.toThrow(/cycle/);
    await svc.saveWorkflow(g.key, chain()); // drafts with a non-member save…
    await expect(svc.startWorkflow(g.key, "wf-1", "")).rejects.toThrow(/@qa is not a member/); // …but don't run
  });
});

describe("GroupChatService composer parity (model, thinking, images, panels, commands)", () => {
  type Seen = { agentId: string; settings: unknown; images?: unknown };

  it("group model/thinking fan out to every member; a per-member override wins", async () => {
    const seen: Seen[] = [];
    const { svc } = setup(async (p) => {
      seen.push({ agentId: p.agentId, settings: p.settings });
      return { text: `${p.agentId} ok` };
    });
    const g = await svc.createGroup({
      ownerAgentId: "main",
      members: ["main", "coder", "qa"],
      settings: { model: "mock/fast-1", thinkingLevel: "high" },
      memberSettings: { qa: { model: "mock/smart-2" } },
    });
    await svc.postUserMessage(g.key, "go");
    await svc.idle(g.key);
    expect(seen).toEqual([
      { agentId: "main", settings: { model: "mock/fast-1", thinkingLevel: "high" } },
      { agentId: "coder", settings: { model: "mock/fast-1", thinkingLevel: "high" } },
      { agentId: "qa", settings: { model: "mock/smart-2", thinkingLevel: "high" } },
    ]);
    const d = svc.describe(g.key);
    expect(d.effective.qa.source).toEqual({ model: "member", thinkingLevel: "group" });
    expect(d.effective.main.source).toEqual({ model: "group", thinkingLevel: "group" });
  });

  it("update patches settings (null clears back to the agent default) and prunes overrides of removed members", async () => {
    const seen: Seen[] = [];
    const { svc } = setup(async (p) => {
      seen.push({ agentId: p.agentId, settings: p.settings });
      return { text: "ok" };
    });
    const g = await svc.createGroup({ ownerAgentId: "main", members: ["main", "coder"] });
    await svc.updateGroup(g.key, {
      settings: { model: "mock/fast-1" },
      memberSettings: { coder: { thinkingLevel: "low" } },
    });
    await svc.updateGroup(g.key, { settings: { model: null, thinkingLevel: "medium" } });
    await svc.postUserMessage(g.key, "hi");
    await svc.idle(g.key);
    expect(seen.map((x) => x.settings)).toEqual([
      { thinkingLevel: "medium" },
      { thinkingLevel: "low" },
    ]);
    await svc.updateGroup(g.key, { members: ["main"] });
    expect(svc.describe(g.key).memberSettings).toEqual({});
  });

  it("settings are validated (syntax + the gateway's checkSettings hook)", async () => {
    const check = vi.fn(async (patch: { model?: string | null }) => {
      if (patch.model === "nope/missing") throw new Error("model not allowed: nope/missing");
    });
    const { svc } = setup(async () => ({ text: "x" }), { checkSettings: check });
    const g = await svc.createGroup({ ownerAgentId: "main", members: ["main", "coder"] });
    await expect(svc.updateGroup(g.key, { settings: { thinkingLevel: "ultra" } })).rejects.toThrow(
      /thinkingLevel/,
    );
    await expect(svc.updateGroup(g.key, { settings: { model: "nope/missing" } })).rejects.toThrow(
      /not allowed/,
    );
    await svc.updateGroup(g.key, { memberSettings: { coder: { model: "mock/ok" } } });
    expect(check).toHaveBeenLastCalledWith({ model: "mock/ok" }, "coder");
  });

  it("attached images go into the group transcript and to every member answering that message", async () => {
    const seen: Seen[] = [];
    const { svc, transcripts } = setup(async (p) => {
      seen.push({ agentId: p.agentId, settings: p.settings, images: p.images });
      return { text: "I see it" };
    });
    const g = await svc.createGroup({ ownerAgentId: "main", members: ["main", "coder"] });
    const img = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
    await svc.postUserMessage(g.key, "", { images: [img] });
    await svc.idle(g.key);
    expect(seen.map((s) => s.images)).toEqual([[img], [img]]);
    expect(transcripts.get(g.key)![0].content).toEqual([{ type: "text", text: "" }, img]);
    // a later text-only message carries no images
    await svc.postUserMessage(g.key, "thanks");
    await svc.idle(g.key);
    expect(seen.slice(2).map((s) => s.images)).toEqual([undefined, undefined]);
  });

  it("chat panels a member's run produced are attached to its group message (even with NO_REPLY)", async () => {
    const panel = {
      v: 1 as const,
      panelId: "p1",
      kind: "tasks",
      query: {},
      title: "Tasks",
      display: "inline" as const,
      summary: "",
      count: 2,
      empty: false,
      error: null,
      link: { tab: "tasks", label: "Tasks" },
      refreshMs: 0,
      ts: 1,
    };
    const { svc, transcripts } = setup(async (p) =>
      p.agentId === "main"
        ? { text: "Here are the tasks", panels: [panel], model: "mock/fast-1" }
        : { text: "NO_REPLY", panels: [{ ...panel, panelId: "p2" }] },
    );
    const g = await svc.createGroup({ ownerAgentId: "main", members: ["main", "coder"] });
    await svc.postUserMessage(g.key, "show tasks");
    await svc.idle(g.key);
    const agentMsgs = transcripts.get(g.key)!.filter((m) => m.groupChat?.kind === "agent");
    expect(
      agentMsgs.map((m) => [
        m.groupChat?.agentId,
        m.groupChat?.panels?.map((x) => x.panelId),
        m.groupChat?.model,
      ]),
    ).toEqual([
      ["main", ["p1"], "mock/fast-1"],
      ["coder", ["p2"], undefined],
    ]);
  });

  it("slash commands change the group instead of reaching the agents", async () => {
    const seen: Seen[] = [];
    const messages: string[] = [];
    const { svc, textOf } = setup(async (p) => {
      seen.push({ agentId: p.agentId, settings: p.settings });
      messages.push(p.message);
      return { text: "ok" };
    });
    const g = await svc.createGroup({ ownerAgentId: "main", members: ["main", "coder"] });
    const r1 = await svc.postUserMessage(g.key, "/model mock/fast-1");
    expect(r1).toMatchObject({ agents: [], command: { name: "model", ok: true } });
    await svc.postUserMessage(g.key, "/think @coder high");
    await svc.postUserMessage(g.key, "/mode round-robin");
    const bad = await svc.postUserMessage(g.key, "/think ultra");
    expect(bad.command).toMatchObject({ ok: false });
    expect(seen).toEqual([]);
    const d = svc.describe(g.key);
    expect(d.mode).toBe("round-robin");
    expect(d.settings).toEqual({ model: "mock/fast-1" });
    expect(d.memberSettings).toEqual({ coder: { thinkingLevel: "high" } });
    expect(textOf(g.key)).toContain("status: Thinking for Coder: high.");
    const help = await svc.postUserMessage(g.key, "/help");
    expect(help.command?.reply).toMatch(/\/model/);
    // plain text that merely starts with a slash path still goes to the agents…
    const orig = seen.length;
    await svc.postUserMessage(g.key, "/home/me/file.txt looks wrong");
    await svc.idle(g.key);
    expect(seen).toHaveLength(orig + 1);
    // …and the commands themselves never reach the agents as context
    expect(messages.join("\n")).not.toMatch(/\/think|\/model|Thinking for/);
    expect(messages.join("\n")).toContain("/home/me/file.txt");
  });

  it("workflow steps run with each member's effective settings", async () => {
    const seen: Seen[] = [];
    const { svc } = setup(async (p) => {
      seen.push({ agentId: p.agentId, settings: p.settings });
      return { text: "done" };
    });
    const g = await svc.createGroup({
      ownerAgentId: "main",
      members: ["main", "coder"],
      settings: { model: "mock/fast-1" },
      memberSettings: { coder: { model: "mock/smart-2", thinkingLevel: "high" } },
    });
    await svc.saveWorkflow(g.key, {
      id: "wf",
      name: "Two",
      nodes: [
        { id: "a", agentId: "main", x: 0, y: 0 },
        { id: "b", agentId: "coder", x: 0, y: 0, parentId: "a" },
      ],
      edges: [],
    });
    await (
      await svc.startWorkflow(g.key, "wf", "go")
    ).done;
    expect(seen).toEqual([
      { agentId: "main", settings: { model: "mock/fast-1" } },
      { agentId: "coder", settings: { model: "mock/smart-2", thinkingLevel: "high" } },
    ]);
  });
});

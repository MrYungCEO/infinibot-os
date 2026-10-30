import { describe, expect, it } from "vitest";

import {
  groupChatKey,
  groupIdFromKey,
  groupMemberKey,
  isGroupChatKey,
  isGroupMemberKey,
} from "./keys.js";
import {
  buildStepPrompt,
  buildTurnPrompt,
  formatTranscript,
  handoffsFromReply,
  isPassReply,
  parseMentions,
  planRound,
  type GroupMember,
} from "./planner.js";
import type { GroupTranscriptMessage, WorkflowGraph } from "./types.js";
import {
  addEdge,
  autoLayout,
  normalizeWorkflow,
  predecessorsOf,
  removeNode,
  setParent,
  topologicalLayers,
  validateWorkflow,
  wouldCreateCycle,
} from "./workflow-graph.js";

const members: GroupMember[] = [
  { id: "main", name: "Infini" },
  { id: "coder", name: "Coder" },
  { id: "head-of-dev", name: "Head of Dev" },
];

const msg = (
  role: "user" | "assistant",
  text: string,
  agentId?: string,
  kind: "user" | "agent" | "status" = role === "user" ? "user" : "agent",
): GroupTranscriptMessage => ({
  role,
  content: [{ type: "text", text }],
  timestamp: 1,
  groupChat: { messageId: Math.random().toString(36), kind, agentId },
});

describe("group chat keys", () => {
  it("distinguishes the group session from member sessions", () => {
    const g = groupChatKey("main", "abc123");
    const m = groupMemberKey("coder", "abc123");
    expect(g).toBe("agent:main:groupchat-abc123");
    expect(isGroupChatKey(g)).toBe(true);
    expect(isGroupMemberKey(g)).toBe(false);
    expect(isGroupChatKey(m)).toBe(false);
    expect(isGroupMemberKey(m)).toBe(true);
    expect(groupIdFromKey(g)).toBe("abc123");
    expect(groupIdFromKey(m)).toBe("abc123");
    expect(isGroupChatKey("agent:main:webchat-x")).toBe(false);
    // Member keys must not match the group chat-list prefix filter.
    expect(m.split(":")[2].startsWith("groupchat-")).toBe(false);
  });
});

describe("mentions + round planning", () => {
  it("matches ids, name slugs and first names; @all expands", () => {
    expect(parseMentions("hey @coder and @head-of-dev", members)).toEqual(["coder", "head-of-dev"]);
    expect(parseMentions("@Infini what do you think?", members)).toEqual(["main"]);
    expect(parseMentions("@head please", members)).toEqual(["head-of-dev"]);
    expect(parseMentions("@all go", members)).toEqual(["main", "coder", "head-of-dev"]);
    expect(parseMentions("mail me at a@coder.com", members)).toEqual([]);
    expect(parseMentions("@nobody", members)).toEqual([]);
  });

  it("mentions override the mode", () => {
    const plan = planRound({ text: "@coder fix it", members, mode: "everyone" });
    expect(plan).toEqual({ agents: ["coder"], rrIndex: 0, reason: "mention" });
  });

  it("everyone / round-robin / moderator", () => {
    expect(planRound({ text: "hi", members, mode: "everyone" }).agents).toEqual([
      "main",
      "coder",
      "head-of-dev",
    ]);
    const r1 = planRound({ text: "hi", members, mode: "round-robin", rrIndex: 0 });
    const r2 = planRound({ text: "hi", members, mode: "round-robin", rrIndex: r1.rrIndex });
    const r3 = planRound({ text: "hi", members, mode: "round-robin", rrIndex: 5 });
    expect([r1.agents, r2.agents, r3.agents]).toEqual([["main"], ["coder"], ["head-of-dev"]]);
    expect(
      planRound({ text: "hi", members, mode: "moderator", moderatorId: "coder" }).agents,
    ).toEqual(["coder"]);
    expect(
      planRound({ text: "hi", members, mode: "moderator", moderatorId: "gone" }).agents,
    ).toEqual(["main"]);
  });

  it("agent hand-offs skip self, already-queued and @all, and respect the turn cap", () => {
    expect(
      handoffsFromReply({
        reply: "@coder can you? @main too",
        speakerId: "main",
        members,
        queued: [],
        turnsSoFar: 1,
      }),
    ).toEqual(["coder"]);
    expect(
      handoffsFromReply({
        reply: "@coder",
        speakerId: "main",
        members,
        queued: ["coder"],
        turnsSoFar: 1,
      }),
    ).toEqual([]);
    expect(
      handoffsFromReply({
        reply: "@all thoughts?",
        speakerId: "main",
        members,
        queued: [],
        turnsSoFar: 1,
      }),
    ).toEqual([]);
    expect(
      handoffsFromReply({ reply: "@coder", speakerId: "main", members, queued: [], turnsSoFar: 8 }),
    ).toEqual([]);
  });

  it("detects pass replies", () => {
    expect(isPassReply("")).toBe(true);
    expect(isPassReply(" NO_REPLY ")).toBe(true);
    expect(isPassReply("HEARTBEAT_OK.")).toBe(true);
    expect(isPassReply("No reply needed? I disagree")).toBe(false);
  });
});

describe("context prompts", () => {
  it("attributes speakers and keeps the newest messages under the cap", () => {
    const t = formatTranscript(
      [msg("user", "hello"), msg("assistant", "hi there", "coder")],
      members,
    );
    expect(t).toBe("User: hello\n\nCoder (@coder): hi there");
    const long = Array.from({ length: 50 }, (_, i) =>
      msg("user", `message number ${i} ${"x".repeat(80)}`),
    );
    const capped = formatTranscript(long, members, 1000);
    expect(capped.length).toBeLessThan(1200);
    expect(capped).toContain("message number 49");
    expect(capped).toMatch(/earlier messages omitted/);
  });

  it("first turn introduces the room; later turns carry only new messages", () => {
    const first = buildTurnPrompt({
      groupTitle: "Launch",
      self: members[1],
      members,
      unseen: [msg("user", "plan the launch")],
      firstTurn: true,
    });
    expect(first).toContain('[Group chat "Launch"] You are Coder (@coder)');
    expect(first).toContain("Infini (@main)");
    expect(first).toContain("User: plan the launch");
    expect(first).toContain("NO_REPLY");
    const later = buildTurnPrompt({
      groupTitle: "Launch",
      self: members[1],
      members,
      unseen: [msg("assistant", "draft ready", "main")],
      firstTurn: false,
      cue: "Infini handed you the floor with an @mention.",
    });
    expect(later).not.toContain("NO_REPLY");
    expect(later).toContain("Infini (@main): draft ready");
    expect(later).toContain("handed you the floor");
  });

  it("step prompt carries the input and every upstream output", () => {
    const p = buildStepPrompt({
      groupTitle: "G",
      workflowName: "Ship",
      self: members[2],
      stepLabel: "Review",
      stepPrompt: "Review the code",
      input: "build a todo app",
      upstream: [{ label: "Build", agent: members[1], output: "CODE-OUTPUT-123" }],
      stepIndex: 2,
      stepCount: 3,
    });
    expect(p).toContain("step 2/3: Review");
    expect(p).toContain("build a todo app");
    expect(p).toContain("### Build — Coder (@coder)\nCODE-OUTPUT-123");
  });
});

describe("workflow graph", () => {
  const base = (): WorkflowGraph => ({
    id: "wf",
    name: "Ship",
    nodes: [
      { id: "lead", agentId: "main", x: 0, y: 0 },
      { id: "a", agentId: "coder", x: 0, y: 0, parentId: "lead" },
      { id: "b", agentId: "head-of-dev", x: 0, y: 0, parentId: "lead" },
      { id: "sum", agentId: "main", x: 0, y: 0 },
    ],
    edges: [
      { id: "e1", sourceId: "a", targetId: "sum" },
      { id: "e2", sourceId: "b", targetId: "sum" },
    ],
  });

  it("layers lead → parallel sub-agents → join", () => {
    const layers = topologicalLayers(base()).map((l) => l.map((n) => n.id));
    expect(layers).toEqual([["lead"], ["a", "b"], ["sum"]]);
    expect(predecessorsOf(base(), "sum")).toEqual(["a", "b"]);
    expect(predecessorsOf(base(), "a")).toEqual(["lead"]);
  });

  it("rejects cycles via edges or hierarchy", () => {
    const g = base();
    expect(wouldCreateCycle(g, "sum", "lead")).toBe(true);
    expect(() => addEdge(g, "sum", "lead")).toThrow(/loop/);
    expect(() => setParent(g, "lead", "a")).toThrow(/lead itself/);
    const bad = { ...g, edges: [...g.edges, { id: "x", sourceId: "sum", targetId: "lead" }] };
    expect(validateWorkflow(bad).errors.join()).toMatch(/cycle/);
  });

  it("validates membership and emptiness", () => {
    expect(validateWorkflow({ id: "w", name: "x", nodes: [], edges: [] }).valid).toBe(false);
    expect(validateWorkflow(base(), { members: ["main", "coder"] }).errors).toContain(
      "@head-of-dev is not a member of this group",
    );
    expect(validateWorkflow(base(), { members: ["main", "coder", "head-of-dev"] }).valid).toBe(
      true,
    );
  });

  it("removing a lead re-parents its sub-agents and drops its links", () => {
    const g = removeNode(base(), "lead");
    expect(g.nodes.find((n) => n.id === "a")?.parentId).toBeNull();
    const g2 = removeNode(base(), "sum");
    expect(g2.edges).toEqual([]);
  });

  it("setParent replaces a duplicate plain edge; autoLayout places layers in columns", () => {
    let g = addEdge(
      { ...base(), nodes: base().nodes.map((n) => ({ ...n, parentId: null })) },
      "lead",
      "a",
    );
    g = setParent(g, "a", "lead");
    expect(g.edges.some((e) => e.sourceId === "lead" && e.targetId === "a")).toBe(false);
    const laid = autoLayout(base());
    const x = Object.fromEntries(laid.nodes.map((n) => [n.id, n.x]));
    expect(x.lead).toBeLessThan(x.a);
    expect(x.a).toBe(x.b);
    expect(x.b).toBeLessThan(x.sum);
  });

  it("normalizes untrusted input", () => {
    const g = normalizeWorkflow({
      name: "  ",
      nodes: [
        { id: "n1", agentId: "main", x: 1.6, parentId: "ghost" },
        { agentId: "coder" },
        "junk",
      ],
      edges: [
        { sourceId: "n1", targetId: "missing" },
        { sourceId: "n1", targetId: "n1" },
      ],
    });
    expect(g.name).toBe("Untitled workflow");
    expect(g.nodes[0]).toMatchObject({ id: "n1", x: 2, parentId: null });
    expect(g.nodes[1].id).toMatch(/^n-/);
    expect(g.edges).toEqual([]);
  });
});

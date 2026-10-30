import { describe, expect, it } from "vitest";

import type { ToolActivity } from "../../shared/group-chat/activity.js";
import type { GroupMember } from "../../shared/group-chat/planner.js";
import type { GroupChatMeta, GroupTranscriptMessage } from "../../shared/group-chat/types.js";
import { GroupChatService, type AgentTurnRunner } from "./service.js";
import type { GroupChatStore } from "./store.js";

const NAMES: Record<string, string> = { main: "INFINI", coder: "DEV", qa: "INSPECTOR" };

function setup(runTurn: AgentTurnRunner) {
  const groups = new Map<string, { title: string; meta: GroupChatMeta }>();
  const transcripts = new Map<string, GroupTranscriptMessage[]>();
  const store: GroupChatStore = {
    getGroup: (key) => {
      const g = groups.get(key);
      return g ? { key, title: g.title, meta: structuredClone(g.meta), updatedAt: 1 } : null;
    },
    async createGroup(key, title, meta) {
      groups.set(key, { title, meta: structuredClone(meta) });
      transcripts.set(key, []);
      return { key, title, meta, updatedAt: 1 };
    },
    async updateGroup(key, fn) {
      const g = groups.get(key);
      if (!g) return null;
      const res = fn(structuredClone(g.meta), { label: g.title }) ?? {};
      if (res.meta) g.meta = res.meta;
      return { key, title: g.title, meta: g.meta, updatedAt: 1 };
    },
    readMessages: (key) => [...(transcripts.get(key) ?? [])],
    appendMessage(key, m) {
      transcripts.get(key)!.push(m);
      return m;
    },
    async ensureMemberSession() {},
    resolveMembers: (ids): GroupMember[] => ids.map((id) => ({ id, name: NAMES[id] ?? id })),
  };
  const svc = new GroupChatService({
    store,
    runTurn,
    emit: () => {},
    probeRepo: (dir) => ({ path: dir, exists: true, isGitRepo: true, branch: "main", head: "abc1234", remotes: [] }),
    profileMembers: (ms) => ms.map((m) => ({ ...m, role: m.id === "qa" ? "test runner" : "dev", canExec: true, canWrite: m.id !== "qa" })),
    ownerInfo: () => ({ name: "Ra", timeZone: "UTC" }),
  });
  return { svc, transcripts, groups };
}

const PUSH_FAILED: ToolActivity[] = [
  { tool: "exec", summary: 'git commit -m "add"', ok: true, exitCode: 0, commit: "1a2b3c4", cwd: "/repo" },
  {
    tool: "exec",
    summary: "git push origin main",
    ok: false,
    exitCode: 128,
    error: "fatal: 'origin' does not appear to be a git repository",
    push: { ok: false, target: "origin main" },
    cwd: "/repo",
  },
];

describe("group chat shared context", () => {
  it("binds a repo at create/update and gives every member turn the same cwd + context block", async () => {
    const calls: Array<{ agentId: string; cwd?: string; systemPrompt?: string; message: string }> = [];
    const { svc, groups } = setup(async (p) => {
      calls.push({ agentId: p.agentId, cwd: p.cwd, systemPrompt: p.systemPrompt, message: p.message });
      return { text: "NO_REPLY" };
    });
    const g = await svc.createGroup({
      ownerAgentId: "main",
      members: ["coder", "qa"],
      title: "Crew",
      binding: { workdir: "/repo", projectName: "Sum", projectId: "p1", purpose: "ship sum" },
    });
    expect(groups.get(g.key)!.meta.binding).toEqual({
      workdir: "/repo",
      projectName: "Sum",
      projectId: "p1",
      purpose: "ship sum",
    });
    expect(svc.describe(g.key)).toMatchObject({
      binding: { workdir: "/repo" },
      repo: { branch: "main", remotes: [] },
    });

    await svc.postUserMessage(g.key, "go");
    await svc.idle(g.key);
    expect(calls.map((c) => c.cwd)).toEqual(["/repo", "/repo"]);
    for (const c of calls) {
      expect(c.systemPrompt).toContain("Shared repo / working directory: /repo");
      expect(c.systemPrompt).toContain("NO git remote is configured");
      expect(c.systemPrompt).toContain("Linked kanban project: Sum (id p1)");
      expect(c.systemPrompt).toContain("Purpose: ship sum");
    }
    expect(calls[1].systemPrompt).toContain("INSPECTOR (@qa) ← you — test runner");

    // Patch: clear the purpose only; then unbind entirely.
    await svc.updateGroup(g.key, { binding: { purpose: null } });
    expect(groups.get(g.key)!.meta.binding).toEqual({ workdir: "/repo", projectName: "Sum", projectId: "p1" });
    await svc.updateGroup(g.key, { binding: null });
    expect(groups.get(g.key)!.meta.binding).toBeUndefined();
    calls.length = 0;
    await svc.postUserMessage(g.key, "again");
    await svc.idle(g.key);
    expect(calls[0].cwd).toBeUndefined();
    expect(calls[0].systemPrompt).toContain("No shared repo is bound");
  });

  it("stamps each turn's real tool results on the message, flags false claims, and shows both to the next member", async () => {
    const prompts: Record<string, string[]> = {};
    const { svc, transcripts } = setup(async (p) => {
      (prompts[p.agentId] ??= []).push(p.message);
      if (p.agentId === "coder")
        return { text: "Added sum() and pushed it to origin main.", activity: PUSH_FAILED };
      if (p.agentId === "main") return { text: "I've created a Kanban task for this and it's done." };
      return { text: "NO_REPLY" };
    });
    const g = await svc.createGroup({ ownerAgentId: "main", members: ["coder", "main", "qa"], binding: { workdir: "/repo" } });
    await svc.postUserMessage(g.key, "ship it");
    await svc.idle(g.key);

    const msgs = transcripts.get(g.key)!;
    const coder = msgs.find((m) => m.groupChat?.agentId === "coder")!;
    expect(coder.groupChat!.activity).toEqual(PUSH_FAILED);
    expect(coder.groupChat!.unverified!.map((f) => f.kind)).toEqual(["push"]);
    expect(coder.groupChat!.unverified![0].reason).toMatch(/FAILED/);

    const main = msgs.find((m) => m.groupChat?.agentId === "main")!;
    expect(main.groupChat!.activity).toBeUndefined();
    expect(main.groupChat!.unverified!.map((f) => f.kind)).toEqual(["task"]);

    // QA's prompt carries the ledger, not just the claim.
    const qa = prompts.qa[0];
    expect(qa).toContain("DEV (@coder): Added sum() and pushed it to origin main.");
    expect(qa).toContain("PUSH FAILED");
    expect(qa).toContain("fatal: 'origin' does not appear to be a git repository");
    expect(qa).toContain("UNVERIFIED");
  });

  it("records a member's tool activity even when it replies NO_REPLY, and run results as status", async () => {
    const { svc, transcripts } = setup(async () => ({ text: "NO_REPLY", activity: PUSH_FAILED }));
    const g = await svc.createGroup({ ownerAgentId: "main", members: ["coder"] });
    await svc.postUserMessage(g.key, "x");
    await svc.idle(g.key);
    svc.recordMemberRunResult(g.key, "coder", "Run update (r1): finished. Verification: UNVERIFIED");
    const status = transcripts.get(g.key)!.filter((m) => m.groupChat?.kind === "status");
    expect(status).toHaveLength(2);
    expect(status[0].groupChat!.activity).toEqual(PUSH_FAILED);
    expect(status[1].content[0].text).toContain("Verification: UNVERIFIED");
  });
});

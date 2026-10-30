import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SubagentRunRecord } from "../subagent-registry.js";

// ── Registry / side-effect mocks ───────────────────────────────────────────
const runs = new Map<string, SubagentRunRecord>();
vi.mock("../subagent-registry.js", () => ({
  getSubagentRun: (id: string) => runs.get(id),
  getSubagentRunBySessionKey: (k: string) =>
    [...runs.values()].find((r) => r.childSessionKey === k),
  listAllSubagentRuns: () => [...runs.values()],
}));
const broadcasts: Array<{ event: string; payload: any }> = [];
vi.mock("../coder-runtime/subagent-broadcast.js", () => ({
  getGatewayBroadcaster: () => (event: string, payload: unknown) =>
    broadcasts.push({ event, payload }),
}));
const progress: string[] = [];
vi.mock("../subagent-progress.js", () => ({
  recordActivity: vi.fn(),
  reportProgress: vi.fn(async (p: { message: string }) => {
    progress.push(p.message);
    return { ok: true };
  }),
}));
vi.mock("../../config/sessions/transcript.js", () => ({
  appendAssistantMessageToSessionTranscript: vi.fn(async () => ({ ok: true })),
}));
const sessionStore: Record<string, { coderBackend?: string }> = {};
vi.mock("../../config/sessions/store.js", () => ({ loadSessionStore: () => sessionStore }));
vi.mock("../../config/config.js", () => ({ loadConfig: () => ({}) }));

import {
  drainInboxForSession,
  getSubagentMessageStatus,
  piggybackInboxOnToolResult,
  resetSubagentInboxForTests,
  resumeInboxWatching,
  routeSessionsSendToCoder,
  scanChildOutputForAcks,
  sendSubagentMessage,
} from "./service.js";
import { claimPendingInboxMessages, readInbox } from "./store.js";

const KEY = "agent:main:subagent:1111";
function addRun(over: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  const r = {
    runId: "run-a",
    childSessionKey: KEY,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "t",
    cleanup: "delete",
    createdAt: 1,
    startedAt: 1,
    coderBackend: "claude-code",
    ...over,
  } as SubagentRunRecord;
  runs.set(r.runId, r);
  return r;
}

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), "ib-inbox-svc-"));
  process.env.INFINIBOT_STATE_DIR = stateDir;
  runs.clear();
  broadcasts.length = 0;
  progress.length = 0;
  for (const k of Object.keys(sessionStore)) delete sessionStore[k];
});
afterEach(() => {
  resetSubagentInboxForTests();
  delete process.env.INFINIBOT_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("sendSubagentMessage — honest status", () => {
  it("queues for a live coder run and says how it will be delivered", async () => {
    addRun();
    const r = await sendSubagentMessage({ sessionKey: KEY, message: "add a README", from: "orch" });
    expect(r).toMatchObject({
      ok: true,
      status: "queued",
      runId: "run-a",
      backend: "claude-code",
      deliveryMode: "claude-hook",
    });
    expect(r.messageId).toMatch(/^im_[a-f0-9]{10}$/);
    expect(readInbox("run-a")).toMatchObject([{ text: "add a README", from: "orch" }]);
    expect(broadcasts.map((b) => [b.event, b.payload.status])).toEqual([
      ["subagent.message", "queued"],
    ]);
  });

  it("reports delivered when the agent drains within waitMs", async () => {
    addRun({ coderBackend: "codex" });
    setTimeout(() => claimPendingInboxMessages("run-a", "mcp-piggyback"), 250);
    const r = await sendSubagentMessage({ runId: "run-a", message: "x", waitMs: 3000 });
    expect(r).toMatchObject({
      status: "delivered",
      deliveredVia: "mcp-piggyback",
      deliveryMode: "mcp-piggyback",
    });
  });

  it("caps waitMs under the 10s gateway RPC timeout", async () => {
    addRun();
    const t0 = Date.now();
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    try {
      const r = await sendSubagentMessage({ runId: "run-a", message: "x", waitMs: 60_000 });
      expect(r.status).toBe("queued");
    } finally {
      vi.useRealTimers();
    }
    expect(Date.now() - t0).toBeLessThan(9_000);
  });

  it("not_running for an ended run, even through an interrupted-but-live window", async () => {
    addRun({ endedAt: 5, outcome: { status: "ok" } });
    const r = await sendSubagentMessage({ runId: "run-a", message: "x" });
    expect(r.status).toBe("not_running");
    expect(r.ok).toBe(false);
    expect(readInbox("run-a")).toEqual([]);

    // A durable run whose gateway restarted (interruptedAt) is still working.
    addRun({ runId: "run-b", childSessionKey: "agent:main:subagent:2", interruptedAt: 9 });
    expect((await sendSubagentMessage({ runId: "run-b", message: "y" })).status).toBe("queued");
  });

  it("unsupported_backend for embedded sub-agents, not_found for unknown targets", async () => {
    addRun({ coderBackend: undefined, durableSpawn: undefined });
    expect((await sendSubagentMessage({ runId: "run-a", message: "x" })).status).toBe(
      "unsupported_backend",
    );
    expect((await sendSubagentMessage({ runId: "nope", message: "x" })).status).toBe("not_found");
  });
});

describe("routeSessionsSendToCoder (sessions_send hook)", () => {
  it("routes a coder child key to the inbox — never to a gateway LLM", async () => {
    addRun();
    const r = await routeSessionsSendToCoder({ sessionKey: KEY, message: "new requirement" });
    expect(r?.status).toBe("queued");
  });

  it("returns null for non-coder keys so sessions_send keeps its normal path", async () => {
    addRun({ coderBackend: undefined });
    expect(await routeSessionsSendToCoder({ sessionKey: KEY, message: "hi" })).toBeNull();
    expect(
      await routeSessionsSendToCoder({ sessionKey: "agent:main:main", message: "hi" }),
    ).toBeNull();
  });

  it("a coder session the registry lost is not_running, not an LLM turn", async () => {
    sessionStore[KEY] = { coderBackend: "claude-code" };
    const r = await routeSessionsSendToCoder({ sessionKey: KEY, message: "hi" });
    expect(r?.status).toBe("not_running");
  });
});

describe("child-side consumption", () => {
  it("MCP piggyback appends pending messages to the tool result once", async () => {
    addRun({ coderBackend: "codex" });
    const sent = await sendSubagentMessage({ runId: "run-a", message: "use pnpm" });
    const base = { content: [{ type: "text", text: "kanban ok" }], details: {} };
    const out = piggybackInboxOnToolResult(KEY, base) as { content: Array<{ text: string }> };
    expect(out.content).toHaveLength(2);
    expect(out.content[1]!.text).toContain(`[OPERATOR MESSAGE id=${sent.messageId}`);
    expect(out.content[1]!.text).toContain("use pnpm");
    expect(piggybackInboxOnToolResult(KEY, base)).toBe(base);
    expect(getSubagentMessageStatus({ runId: "run-a", messageId: sent.messageId })).toMatchObject({
      ok: true,
      messages: [{ status: "delivered", deliveredVia: "mcp-piggyback" }],
    });
    // Non-coder sessions are untouched.
    expect(piggybackInboxOnToolResult("agent:main:main", base)).toBe(base);
  });

  it("ACK in the agent's output marks the message acknowledged and emits it", async () => {
    addRun();
    const sent = await sendSubagentMessage({ runId: "run-a", message: "m" });
    drainInboxForSession(KEY, "inbox-tool");
    scanChildOutputForAcks("run-a", JSON.stringify({ text: `ok\nACK ${sent.messageId}` }));
    expect(readInbox("run-a")[0]!.status).toBe("acknowledged");
    expect(broadcasts.map((b) => b.payload.status)).toEqual([
      "queued",
      "delivered",
      "acknowledged",
    ]);
    expect(progress.some((p) => p.includes("acknowledged"))).toBe(true);
  });
});

describe("persistence across a gateway restart", () => {
  it("messages queued before a restart are still delivered and tracked after it", async () => {
    addRun();
    const sent = await sendSubagentMessage({ runId: "run-a", message: "survive me" });
    resetSubagentInboxForTests(); // gateway process dies; files remain

    // …the durable child's hook drains it while the gateway is down…
    claimPendingInboxMessages("run-a", "claude-hook:PostToolUse");

    // New gateway boots and resumes watching; the agent's ACK is still picked up.
    resumeInboxWatching();
    scanChildOutputForAcks("run-a", `ACK ${sent.messageId}`);
    expect(getSubagentMessageStatus({ runId: "run-a", messageId: sent.messageId })).toMatchObject({
      messages: [{ status: "acknowledged", deliveredVia: "claude-hook:PostToolUse" }],
    });
  });

  it("expires messages that were never drained once the run ends", async () => {
    const run = addRun();
    const sent = await sendSubagentMessage({ runId: "run-a", message: "too late" });
    run.endedAt = Date.now();
    run.outcome = { status: "ok" };
    resetSubagentInboxForTests();
    resumeInboxWatching();
    await new Promise((r) => setTimeout(r, 1200));
    expect(getSubagentMessageStatus({ runId: "run-a", messageId: sent.messageId })).toMatchObject({
      messages: [{ status: "not_running" }],
    });
  });
});

describe("MCP bridge session key (claude-coder:<runId>)", () => {
  it("piggybacks for the bridged key every coder backend's MCP entry uses", async () => {
    addRun({ coderBackend: "codex" });
    const sent = await sendSubagentMessage({ runId: "run-a", message: "bridged" });
    const out = piggybackInboxOnToolResult("claude-coder:run-a", {
      content: [{ type: "text", text: "ok" }],
    }) as { content: Array<{ text: string }> };
    expect(out.content[1]!.text).toContain(sent.messageId!);
    expect(drainInboxForSession("claude-coder:nope", "inbox-tool").run).toBeUndefined();
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";

import type { SubagentProgressRecord, ProgressUpdate } from "../../agents/subagent-progress.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";

const requester = "agent:coder:requester-1";

const baseRun: SubagentRunRecord = {
  runId: "run-1",
  childSessionKey: "agent:coder:child-1",
  requesterSessionKey: requester,
  requesterDisplayKey: requester,
  task: "x".repeat(500),
  label: "Rollout planner",
  cleanup: "delete",
  createdAt: 1_000,
  startedAt: 1_100,
};

function mkUpdate(ts: number, msg = "u"): ProgressUpdate {
  return {
    runId: baseRun.runId,
    sessionKey: baseRun.childSessionKey,
    status: "working",
    message: msg,
    progress: ts % 100,
    timestamp: ts,
  };
}

const baseProgress: SubagentProgressRecord = {
  runId: baseRun.runId,
  sessionKey: baseRun.childSessionKey,
  task: baseRun.task,
  requesterSessionKey: requester,
  status: "working",
  progress: 42,
  checkpoints: [],
  updates: [
    mkUpdate(2_000, "first update message"),
    mkUpdate(3_000, "second update message"),
    mkUpdate(4_000, "third update message"),
    mkUpdate(5_000, "fourth update message"),
    mkUpdate(6_000, "y".repeat(400)), // intentionally long → must be truncated
  ],
  createdAt: 1_000,
  lastUpdateAt: 6_000,
};

vi.mock("../../agents/subagent-registry.js", () => ({
  listAllSubagentRuns: vi.fn(() => [baseRun]),
  listSubagentRunsForRequester: vi.fn(() => [baseRun]),
}));

vi.mock("../../agents/subagent-progress.js", () => ({
  listActiveProgress: vi.fn(() => [baseProgress]),
  listProgressForRequester: vi.fn(() => [baseProgress]),
  getProgress: vi.fn(() => baseProgress),
  reportProgress: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../federation/remote-session-registry.js", () => ({
  listRemoteSessions: vi.fn(() => []),
  getRemoteSessionsSpawnedBy: vi.fn(() => []),
}));

// Import after mocks
import { subagentsHandlers } from "./subagents.handlers.js";
import { listProgressForRequester } from "../../agents/subagent-progress.js";

type Resp = {
  ok?: boolean;
  subagents?: any[];
  total?: number;
  serverTime?: number;
  error?: string;
};

function invoke(params: Record<string, unknown>): Resp {
  let captured: Resp = {};
  const handler = subagentsHandlers["subagents.list"];
  // The handler is sync (no await needed); respond fires synchronously.
  void handler({
    params,
    respond: (_ok: boolean, body: any) => {
      captured = body as Resp;
    },
  } as any);
  return captured;
}

describe("subagents.list payload slimming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("omits recentUpdates entirely when compact:true", () => {
    const res = invoke({ requesterSessionKey: requester, compact: true });
    expect(res.subagents).toHaveLength(1);
    expect(res.subagents![0].recentUpdates).toEqual([]);
    expect(res.serverTime).toBeTypeOf("number");
  });

  it("joins global progress rows with live registry metadata", () => {
    const res = invoke({ compact: true });
    expect(res.subagents).toHaveLength(1);
    expect(res.subagents![0]).toMatchObject({
      runId: "run-1",
      sessionKey: "agent:coder:child-1",
      label: "Rollout planner",
      task: "x".repeat(159) + "…",
    });
  });

  it("defaults to 3 updates (not 10) when verbose payload is requested", () => {
    const res = invoke({ requesterSessionKey: requester, compact: false });
    expect(res.subagents).toHaveLength(1);
    expect(res.subagents![0].recentUpdates).toHaveLength(3);
    // Should be the most recent 3 by timestamp
    const tss = res.subagents![0].recentUpdates.map((u: any) => u.timestamp);
    expect(tss).toEqual([4_000, 5_000, 6_000]);
  });

  it("respects since cursor — only ships updates newer than since", () => {
    const res = invoke({
      requesterSessionKey: requester,
      compact: false,
      since: 4_500,
      updatesTail: 10,
    });
    const updates = res.subagents![0].recentUpdates;
    expect(updates).toHaveLength(2);
    expect(updates.map((u: any) => u.timestamp)).toEqual([5_000, 6_000]);
  });

  it("truncates the task field and long update messages", () => {
    const res = invoke({ requesterSessionKey: requester, compact: false });
    const sa = res.subagents![0];
    expect(sa.task.length).toBeLessThanOrEqual(160);
    expect(sa.task.endsWith("…")).toBe(true);
    const longMessage = sa.recentUpdates.find((u: any) => u.timestamp === 6_000);
    expect(longMessage.message.length).toBeLessThanOrEqual(140);
    expect(longMessage.message.endsWith("…")).toBe(true);
  });

  it("returns serverTime so callers can chain diff-style polls", () => {
    const before = Date.now();
    const res = invoke({ requesterSessionKey: requester });
    expect(res.serverTime).toBeGreaterThanOrEqual(before);
  });

  it("clamps updatesTail to the 10 max even if a noisy caller asks for more", () => {
    // Extend the mock to ship 15 updates and verify the cap holds
    const longProgress: SubagentProgressRecord = {
      ...baseProgress,
      updates: Array.from({ length: 15 }, (_, i) => mkUpdate(10_000 + i * 100, `m${i}`)),
    };
    (listProgressForRequester as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      longProgress,
    ]);
    const res = invoke({
      requesterSessionKey: requester,
      compact: false,
      updatesTail: 999,
    });
    expect(res.subagents![0].recentUpdates.length).toBeLessThanOrEqual(10);
  });

  it("badges a sync coder run (progress record only) with the backend from its activity", () => {
    const syncRun: SubagentProgressRecord = {
      ...baseProgress,
      runId: "sync-grok",
      sessionKey: "agent:coder:sync-grok",
      lastActivity: { kind: "Read", label: "Read src/x.ts", at: 7_000, coderBackend: "grok" },
    };
    (listProgressForRequester as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce([
      syncRun,
    ]);
    const res = invoke({ requesterSessionKey: requester, compact: true });
    const row = res.subagents!.find((r: any) => r.runId === "sync-grok");
    expect(row?.coderBackend).toBe("grok");
  });
});

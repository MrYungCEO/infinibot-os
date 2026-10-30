/**
 * Tests for the `subagents.detail` gateway handler.
 *
 * Specifically exercises the live-vs-archive lookup path: when the live
 * registry no longer holds an entry (post-sweep, after the 10-minute grace
 * window), the handler must fall back to the 30-day persistent history
 * archive and flag the response with `source: "archive"`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import type { SubagentHistoryEntry } from "../../agents/subagent-history.js";

vi.mock("../../agents/subagent-registry.js", () => ({
  listSubagentRunsForRequester: vi.fn(() => []),
  getSubagentRun: vi.fn(),
  getSubagentRunBySessionKey: vi.fn(),
}));

vi.mock("../../agents/subagent-history.js", () => ({
  getSubagentHistoryEntryByRunId: vi.fn(),
}));

vi.mock("../../databases/kanban-store-ops.js", () => ({
  getTask: vi.fn(() => undefined),
  getProject: vi.fn(() => undefined),
  listTasks: vi.fn(() => []),
}));

vi.mock("../../content/pages-store.js", () => ({
  getContentPagesStore: vi.fn(() => ({ list: () => [] })),
}));

// Partial mock: other modules in the import graph read constants
// (DEFAULT_ACCOUNT_ID, …) from this module at load time.
vi.mock("../../routing/session-key.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../routing/session-key.js")>()),
  resolveAgentIdFromSessionKey: vi.fn(() => undefined),
}));

vi.mock("../../agents/subagent-progress.js", () => ({
  listActiveProgress: vi.fn(() => []),
  listProgressForRequester: vi.fn(() => []),
  getProgress: vi.fn(),
  reportProgress: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../federation/remote-session-registry.js", () => ({
  listRemoteSessions: vi.fn(() => []),
  getRemoteSessionsSpawnedBy: vi.fn(() => []),
}));

import { subagentsHandlers } from "./subagents.handlers.js";
import { getSubagentRun, getSubagentRunBySessionKey } from "../../agents/subagent-registry.js";
import { getSubagentHistoryEntryByRunId } from "../../agents/subagent-history.js";

type DetailResp = {
  ok?: boolean;
  run?: Record<string, unknown>;
  source?: "live" | "archive";
  error?: string;
};

function invokeDetail(params: Record<string, unknown>): DetailResp {
  let captured: DetailResp = {};
  const handler = subagentsHandlers["subagents.detail"];
  void handler({
    params,
    respond: (_ok: boolean, body: unknown) => {
      captured = body as DetailResp;
    },
  } as any);
  return captured;
}

describe("subagents.detail archive fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the live record with source:live when the registry has it", () => {
    const liveRun: SubagentRunRecord = {
      runId: "run-live",
      childSessionKey: "agent:sub:run-live",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "live task",
      cleanup: "delete",
      createdAt: 1_000,
      startedAt: 1_500,
    };
    (getSubagentRun as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(liveRun);
    (getSubagentHistoryEntryByRunId as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      undefined,
    );

    const res = invokeDetail({ runId: "run-live" });
    expect(res.ok).toBe(true);
    expect(res.source).toBe("live");
    expect(res.run?.runId).toBe("run-live");
    // Archive path should not have been consulted when live hit.
    expect(getSubagentHistoryEntryByRunId).not.toHaveBeenCalled();
  });

  it("falls back to the archive when live registry misses", () => {
    (getSubagentRun as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);
    (getSubagentRunBySessionKey as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      undefined,
    );
    const archived: SubagentHistoryEntry = {
      runId: "run-archived",
      label: "archived label",
      task: "archived task",
      status: "complete",
      startedAt: 10_000,
      endedAt: 20_000,
      outcome: { status: "ok" },
      requesterSessionKey: "agent:main:main",
      filesTouchedCount: 7,
      filesTouchedSample: ["/repo/foo.ts", "/repo/bar.ts"],
      coderBackend: "claude-code",
    };
    (getSubagentHistoryEntryByRunId as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      archived,
    );

    const res = invokeDetail({ runId: "run-archived" });
    expect(res.ok).toBe(true);
    expect(res.source).toBe("archive");
    expect(res.run?.runId).toBe("run-archived");
    expect(res.run?.label).toBe("archived label");
    expect(res.run?.task).toBe("archived task");
    expect(res.run?.startedAt).toBe(10_000);
    expect(res.run?.endedAt).toBe(20_000);
    expect(res.run?.outcome).toEqual({ status: "ok" });
    expect(res.run?.filesTouchedCount).toBe(7);
    expect(res.run?.filesTouchedSample).toEqual(["/repo/foo.ts", "/repo/bar.ts"]);
    expect(res.run?.coderBackend).toBe("claude-code");
    // No live progress fields leak from the archive shape.
    expect(res.run?.childPid).toBeUndefined();
    expect(res.run?.claudeSessionId).toBeUndefined();
    expect(res.run?.filesTouched).toBeUndefined();
  });

  it("returns the live `not found` error when neither registry nor archive has it", () => {
    (getSubagentRun as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);
    (getSubagentRunBySessionKey as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      undefined,
    );
    (getSubagentHistoryEntryByRunId as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      undefined,
    );

    const res = invokeDetail({ runId: "missing" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not found/i);
  });

  it("does not consult the archive when the caller only supplies a sessionKey", () => {
    (getSubagentRun as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);
    (getSubagentRunBySessionKey as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      undefined,
    );
    (getSubagentHistoryEntryByRunId as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      undefined,
    );

    const res = invokeDetail({ sessionKey: "agent:sub:gone" });
    expect(res.ok).toBe(false);
    // The archive is runId-keyed, so missing-runId callers shouldn't hit it.
    expect(getSubagentHistoryEntryByRunId).not.toHaveBeenCalled();
  });
});

/**
 * `subagents.stop` — the focus modal's Stop button falls back to this when the
 * run has a runId but no live sessionKey (`agent.abort` needs a sessionKey).
 * It had no handler, so that path always errored.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSubagentRun = vi.fn();
const markSubagentRunComplete = vi.fn();
const abortEmbeddedPiRun = vi.fn(() => true);
const clearSessionQueues = vi.fn(() => ({ followupCleared: 1, laneCleared: 0 }));
const loadSessionEntry = vi.fn(() => ({ entry: { sessionId: "sess-1" } }));

vi.mock("../../agents/subagent-registry.js", () => ({
  getSubagentRun,
  markSubagentRunComplete,
  listSubagentRunsForRequester: vi.fn(() => []),
  getSubagentRunBySessionKey: vi.fn(),
  getSubagentRunByKanbanTaskId: vi.fn(),
  updateSubagentRunSpecAnalysis: vi.fn(),
  reconcileSubagentLiveness: vi.fn(() => 0),
}));
vi.mock("../../agents/pi-embedded.js", () => ({ abortEmbeddedPiRun }));
vi.mock("../../auto-reply/reply/queue.js", () => ({ clearSessionQueues }));
vi.mock("../session-utils.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadSessionEntry,
}));

const { subagentsHandlers } = await import("./subagents.handlers.js");

type Reply = { ok: boolean; payload?: any; error?: any };

async function call(params: Record<string, unknown>): Promise<Reply> {
  const handler = subagentsHandlers["subagents.stop"];
  let reply: Reply | undefined;
  await handler!({
    params,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      reply = { ok, payload, error };
    },
  } as any);
  return reply!;
}

beforeEach(() => {
  vi.clearAllMocks();
  abortEmbeddedPiRun.mockReturnValue(true);
  clearSessionQueues.mockReturnValue({ followupCleared: 1, laneCleared: 0 });
  loadSessionEntry.mockReturnValue({ entry: { sessionId: "sess-1" } });
});

describe("subagents.stop", () => {
  it("aborts the child session and marks the run ended", async () => {
    getSubagentRun.mockReturnValue({ runId: "r1", childSessionKey: "agent:child" });

    const res = await call({ runId: "r1" });

    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({ ok: true, runId: "r1", aborted: true });
    expect(clearSessionQueues).toHaveBeenCalledWith(["agent:child"]);
    expect(abortEmbeddedPiRun).toHaveBeenCalledWith("sess-1");
    expect(markSubagentRunComplete).toHaveBeenCalledWith("r1", {
      status: "error",
      error: "Stopped by operator",
    });
  });

  it("is idempotent for an already-finished run", async () => {
    getSubagentRun.mockReturnValue({
      runId: "r1",
      childSessionKey: "agent:child",
      endedAt: 123,
    });

    const res = await call({ runId: "r1" });

    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({ ok: true, alreadyStopped: true });
    expect(abortEmbeddedPiRun).not.toHaveBeenCalled();
    expect(markSubagentRunComplete).not.toHaveBeenCalled();
  });

  it("reports an unknown run without throwing", async () => {
    getSubagentRun.mockReturnValue(undefined);

    const res = await call({ runId: "ghost" });

    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({ ok: false });
    expect(markSubagentRunComplete).not.toHaveBeenCalled();
  });

  it("requires a runId", async () => {
    const res = await call({});
    expect(res.payload).toMatchObject({ ok: false, error: "runId is required" });
    expect(getSubagentRun).not.toHaveBeenCalled();
  });

  it("kills a coder-backed child process when the run carries a pid", async () => {
    getSubagentRun.mockReturnValue({
      runId: "r1",
      childSessionKey: "agent:child",
      childPid: 4242,
    });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true as never);

    const res = await call({ runId: "r1" });

    expect(res.payload.killedPid).toBe(true);
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    kill.mockRestore();
  });
});

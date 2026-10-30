/**
 * Tests for the subagents.history gateway handler.
 *
 * Asserts that:
 *  - The handler returns persisted complete/error/timeout entries.
 *  - `limit`, `since`, and `statusFilter` params filter as expected.
 *  - Garbage / out-of-range params fall back to safe defaults.
 *  - The response shape matches what the UI feed component expects.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("subagents.history gateway handler", () => {
  const previousStateDir = process.env.INFINIBOT_STATE_DIR;
  const previousRetention = process.env.INFINIBOT_SUBAGENT_HISTORY_DAYS;
  let tempStateDir: string | null = null;

  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "infinibot-subagent-history-"));
    process.env.INFINIBOT_STATE_DIR = tempStateDir;
    delete process.env.INFINIBOT_SUBAGENT_HISTORY_DAYS;
    vi.resetModules();
  });

  afterEach(async () => {
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    if (previousStateDir === undefined) delete process.env.INFINIBOT_STATE_DIR;
    else process.env.INFINIBOT_STATE_DIR = previousStateDir;
    if (previousRetention === undefined) delete process.env.INFINIBOT_SUBAGENT_HISTORY_DAYS;
    else process.env.INFINIBOT_SUBAGENT_HISTORY_DAYS = previousRetention;
    vi.resetModules();
  });

  async function seed(): Promise<{
    handler: any;
    entries: Array<{ runId: string; status: "complete" | "error" | "timeout"; endedAt: number }>;
  }> {
    const history = await import("../../agents/subagent-history.js");
    history.resetSubagentHistoryForTests();
    const now = Date.now();
    const entries = [
      { runId: "run-a", status: "complete" as const, endedAt: now - 60_000 },
      { runId: "run-b", status: "error" as const, endedAt: now - 30_000 },
      { runId: "run-c", status: "timeout" as const, endedAt: now - 10_000 },
      { runId: "run-d", status: "complete" as const, endedAt: now - 5_000 },
    ];
    for (const e of entries) {
      history.addHistoryEntryForTests({
        runId: e.runId,
        task: `task ${e.runId}`,
        status: e.status,
        endedAt: e.endedAt,
        requesterSessionKey: "agent:main:main",
      });
    }
    const mod = await import("./subagents-history.handlers.js");
    return { handler: mod.subagentsHistoryHandlers["subagents.history"], entries };
  }

  it("returns all persisted entries, newest first", async () => {
    const { handler } = await seed();
    let captured: any = null;
    handler({
      params: { limit: 10 },
      respond: (_ok: boolean, payload: unknown) => { captured = payload; },
    } as any);
    expect(captured?.ok).toBe(true);
    expect(captured?.total).toBe(4);
    expect(captured?.history).toHaveLength(4);
    // Newest first.
    expect(captured.history[0].runId).toBe("run-d");
    expect(captured.history[3].runId).toBe("run-a");
  });

  it("respects the limit parameter", async () => {
    const { handler } = await seed();
    let captured: any = null;
    handler({
      params: { limit: 2 },
      respond: (_ok: boolean, payload: unknown) => { captured = payload; },
    } as any);
    expect(captured?.history).toHaveLength(2);
    expect(captured?.history[0].runId).toBe("run-d");
    expect(captured?.history[1].runId).toBe("run-c");
    // `total` reflects what's available, not what was returned.
    expect(captured?.total).toBe(4);
  });

  it("filters by statusFilter", async () => {
    const { handler } = await seed();
    let captured: any = null;
    handler({
      params: { limit: 10, statusFilter: ["error", "timeout"] },
      respond: (_ok: boolean, payload: unknown) => { captured = payload; },
    } as any);
    const runIds = new Set(captured.history.map((e: { runId: string }) => e.runId));
    expect(runIds).toEqual(new Set(["run-b", "run-c"]));
  });

  it("filters by since (epoch ms)", async () => {
    const { handler, entries } = await seed();
    // Only entries newer than run-b's endedAt should survive.
    const since = entries[1].endedAt + 1;
    let captured: any = null;
    handler({
      params: { limit: 10, since },
      respond: (_ok: boolean, payload: unknown) => { captured = payload; },
    } as any);
    const runIds = new Set(captured.history.map((e: { runId: string }) => e.runId));
    expect(runIds).toEqual(new Set(["run-c", "run-d"]));
  });

  it("ignores unknown statusFilter values without erroring", async () => {
    const { handler } = await seed();
    let captured: any = null;
    handler({
      // "bogus" should be dropped; the remaining "complete" filters to run-a and run-d.
      params: { statusFilter: ["bogus", "complete"] },
      respond: (_ok: boolean, payload: unknown) => { captured = payload; },
    } as any);
    const runIds = new Set(captured.history.map((e: { runId: string }) => e.runId));
    expect(runIds).toEqual(new Set(["run-a", "run-d"]));
  });

  it("falls back to default limit when limit is invalid or absent", async () => {
    const { handler } = await seed();
    let captured: any = null;
    handler({
      params: { limit: -5 },
      respond: (_ok: boolean, payload: unknown) => { captured = payload; },
    } as any);
    // default is 30 — all 4 fit
    expect(captured?.history).toHaveLength(4);
  });

  it("returns the shape the UI feed component consumes", async () => {
    const { handler } = await seed();
    let captured: any = null;
    handler({
      params: { limit: 1 },
      respond: (_ok: boolean, payload: unknown) => { captured = payload; },
    } as any);
    expect(captured).toMatchObject({
      ok: true,
      total: expect.any(Number),
      serverTime: expect.any(Number),
      history: expect.arrayContaining([
        expect.objectContaining({
          runId: expect.any(String),
          task: expect.any(String),
          status: expect.stringMatching(/^(complete|error|timeout)$/),
          endedAt: expect.any(Number),
        }),
      ]),
    });
  });
});

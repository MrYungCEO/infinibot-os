/**
 * Tests for the subagent history archive module.
 *
 * Covers:
 *  - archiveSubagentRun upserts (no duplicates on re-archive of same runId).
 *  - Skips in-flight runs (no endedAt).
 *  - Status derivation from outcome (timeout vs error vs complete).
 *  - Retention prunes entries older than INFINIBOT_SUBAGENT_HISTORY_DAYS.
 *  - listSubagentHistory honors limit / since / statusFilter / requesterSessionKey.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("subagent history archive", () => {
  const previousStateDir = process.env.INFINIBOT_STATE_DIR;
  const previousRetention = process.env.INFINIBOT_SUBAGENT_HISTORY_DAYS;
  let tempStateDir: string | null = null;

  beforeEach(async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "infinibot-subagent-history-mod-"));
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

  it("archives a finished run and reads it back", async () => {
    const mod = await import("./subagent-history.js");
    mod.resetSubagentHistoryForTests();
    mod.archiveSubagentRun({
      runId: "r1",
      childSessionKey: "agent:sub:r1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "task one",
      cleanup: "delete",
      createdAt: Date.now() - 10_000,
      startedAt: Date.now() - 9_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" },
    } as any);
    const { entries, total } = mod.listSubagentHistory();
    expect(total).toBe(1);
    expect(entries[0].runId).toBe("r1");
    expect(entries[0].status).toBe("complete");
  });

  it("does not archive runs that haven't ended", async () => {
    const mod = await import("./subagent-history.js");
    mod.resetSubagentHistoryForTests();
    mod.archiveSubagentRun({
      runId: "still-running",
      childSessionKey: "agent:sub:x",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "x",
      cleanup: "delete",
      createdAt: Date.now(),
      startedAt: Date.now(),
      // no endedAt — should be skipped
    } as any);
    expect(mod.listSubagentHistory().total).toBe(0);
  });

  it("upserts on repeated archive of the same runId (no duplicates)", async () => {
    const mod = await import("./subagent-history.js");
    mod.resetSubagentHistoryForTests();
    const base = {
      runId: "r-dup",
      childSessionKey: "agent:sub:dup",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "first task",
      cleanup: "delete" as const,
      createdAt: Date.now() - 10_000,
      startedAt: Date.now() - 9_000,
      endedAt: Date.now() - 1_000,
      outcome: { status: "ok" as const },
    };
    mod.archiveSubagentRun(base as any);
    mod.archiveSubagentRun({ ...base, task: "second task" } as any);
    const { entries, total } = mod.listSubagentHistory();
    expect(total).toBe(1);
    expect(entries[0].task).toBe("second task");
  });

  it("derives timeout status from outcome.error containing 'timeout'", async () => {
    const mod = await import("./subagent-history.js");
    mod.resetSubagentHistoryForTests();
    mod.archiveSubagentRun({
      runId: "r-timeout",
      childSessionKey: "agent:sub:timeout",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stuck task",
      cleanup: "delete",
      createdAt: Date.now() - 10_000,
      startedAt: Date.now() - 9_000,
      endedAt: Date.now() - 1_000,
      outcome: {
        status: "error",
        error: "Run exceeded expected timeout (1800s without lifecycle end event)",
      },
    } as any);
    const { entries } = mod.listSubagentHistory();
    expect(entries[0].status).toBe("timeout");
  });

  it("prunes entries older than retention window", async () => {
    // Override retention to 1 day to keep the test fast.
    process.env.INFINIBOT_SUBAGENT_HISTORY_DAYS = "1";
    vi.resetModules();
    const mod = await import("./subagent-history.js");
    mod.resetSubagentHistoryForTests();
    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
    // Old entry — must be pruned.
    mod.addHistoryEntryForTests({
      runId: "old",
      task: "old task",
      status: "complete",
      endedAt: Date.now() - TWO_DAYS_MS,
      requesterSessionKey: "agent:main:main",
    });
    // Fresh entry — should survive.
    mod.archiveSubagentRun({
      runId: "fresh",
      childSessionKey: "agent:sub:fresh",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "fresh task",
      cleanup: "delete",
      createdAt: Date.now(),
      startedAt: Date.now(),
      endedAt: Date.now(),
      outcome: { status: "ok" },
    } as any);
    const { entries, total } = mod.listSubagentHistory();
    expect(total).toBe(1);
    expect(entries[0].runId).toBe("fresh");
  });

  it("filters by statusFilter and respects limit", async () => {
    const mod = await import("./subagent-history.js");
    mod.resetSubagentHistoryForTests();
    const now = Date.now();
    mod.addHistoryEntryForTests({
      runId: "a",
      task: "t",
      status: "complete",
      endedAt: now - 30_000,
      requesterSessionKey: "main",
    });
    mod.addHistoryEntryForTests({
      runId: "b",
      task: "t",
      status: "error",
      endedAt: now - 20_000,
      requesterSessionKey: "main",
    });
    mod.addHistoryEntryForTests({
      runId: "c",
      task: "t",
      status: "timeout",
      endedAt: now - 10_000,
      requesterSessionKey: "main",
    });

    const errorsOnly = mod.listSubagentHistory({ statusFilter: ["error"] });
    expect(errorsOnly.total).toBe(1);
    expect(errorsOnly.entries[0].runId).toBe("b");

    const limited = mod.listSubagentHistory({ limit: 2 });
    expect(limited.entries).toHaveLength(2);
    expect(limited.total).toBe(3);
  });

  it("filters by requesterSessionKey", async () => {
    const mod = await import("./subagent-history.js");
    mod.resetSubagentHistoryForTests();
    const now = Date.now();
    mod.addHistoryEntryForTests({
      runId: "x",
      task: "t",
      status: "complete",
      endedAt: now - 5_000,
      requesterSessionKey: "alice",
    });
    mod.addHistoryEntryForTests({
      runId: "y",
      task: "t",
      status: "complete",
      endedAt: now - 2_000,
      requesterSessionKey: "bob",
    });
    const result = mod.listSubagentHistory({ requesterSessionKey: "alice" });
    expect(result.total).toBe(1);
    expect(result.entries[0].runId).toBe("x");
  });

  describe("getSubagentHistoryEntryByRunId", () => {
    it("returns the entry when it exists in memCache", async () => {
      const mod = await import("./subagent-history.js");
      mod.resetSubagentHistoryForTests();
      mod.addHistoryEntryForTests({
        runId: "lookup-hit",
        task: "the task",
        status: "complete",
        endedAt: Date.now() - 1_000,
        requesterSessionKey: "agent:main:main",
        label: "the label",
        kanbanTaskId: "task-1",
      });
      const found = mod.getSubagentHistoryEntryByRunId("lookup-hit");
      expect(found?.runId).toBe("lookup-hit");
      expect(found?.label).toBe("the label");
      expect(found?.kanbanTaskId).toBe("task-1");
    });

    it("returns undefined when the runId is absent", async () => {
      const mod = await import("./subagent-history.js");
      mod.resetSubagentHistoryForTests();
      mod.addHistoryEntryForTests({
        runId: "present",
        task: "t",
        status: "complete",
        endedAt: Date.now(),
        requesterSessionKey: "main",
      });
      expect(mod.getSubagentHistoryEntryByRunId("absent")).toBeUndefined();
      expect(mod.getSubagentHistoryEntryByRunId("")).toBeUndefined();
    });

    it("loads from disk when memCache is cold", async () => {
      // First module load — write an entry and persist.
      let mod = await import("./subagent-history.js");
      mod.resetSubagentHistoryForTests();
      mod.archiveSubagentRun({
        runId: "persisted-run",
        childSessionKey: "agent:sub:persisted-run",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "persisted task",
        cleanup: "delete",
        createdAt: Date.now() - 5_000,
        startedAt: Date.now() - 4_500,
        endedAt: Date.now() - 500,
        outcome: { status: "ok" },
      } as any);
      // Simulate a fresh process: clear the module cache + memCache so the
      // next call has to read from disk.
      vi.resetModules();
      mod = await import("./subagent-history.js");
      // memCache is null inside the freshly-imported module — first call must
      // hydrate from the file we just wrote.
      const found = mod.getSubagentHistoryEntryByRunId("persisted-run");
      expect(found?.runId).toBe("persisted-run");
      expect(found?.task).toBe("persisted task");
    });
  });

  it("registry terminal transition: archiveSubagentRun produces entry in listSubagentHistory", async () => {
    const mod = await import("./subagent-history.js");
    mod.resetSubagentHistoryForTests();
    const terminalRecord = {
      runId: "wired-run",
      childSessionKey: "agent:sub:wired-run",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do something important",
      cleanup: "delete" as const,
      createdAt: Date.now() - 5_000,
      startedAt: Date.now() - 4_500,
      endedAt: Date.now() - 500,
      outcome: { status: "ok" as const },
    };
    mod.archiveSubagentRun(terminalRecord as any);
    const { entries, total } = mod.listSubagentHistory();
    expect(total).toBe(1);
    expect(entries[0].runId).toBe("wired-run");
    expect(entries[0].status).toBe("complete");
    expect(entries[0].task).toBe("do something important");
  });
});

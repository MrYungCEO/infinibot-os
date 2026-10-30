import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We need to control STATE_DIR. Do this before importing the module under test
// by mocking the paths module.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spawn-ledger-test-"));

vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => tmpDir,
}));

// Also stub out the logger so tests don't need a full gateway config
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    warn: () => {},
    info: () => {},
    error: () => {},
  }),
}));

import {
  appendSpawnEvent,
  compactLedger,
  readSpawnLedger,
  replayLedgerToRunRecords,
  type SpawnLedgerEvent,
} from "./spawn-ledger.js";

const LEDGER = path.join(tmpDir, "subagents", "spawn-ledger.ndjson");

function clearLedger() {
  try {
    fs.writeFileSync(LEDGER, "");
  } catch {
    // File may not exist yet — that's fine
  }
}

beforeEach(() => clearLedger());
afterEach(() => clearLedger());

describe("appendSpawnEvent + readSpawnLedger", () => {
  it("round-trips a single intent event", () => {
    const ev: SpawnLedgerEvent = {
      v: 1,
      ts: 1_700_000_000_000,
      event: "spawn.intent",
      runId: "run-abc",
      kind: "coder",
      task: "build the thing",
      backend: "claude-code",
    };
    appendSpawnEvent(ev);
    const events = readSpawnLedger();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject(ev);
  });

  it("respects sinceMs filter", () => {
    appendSpawnEvent({
      v: 1,
      ts: 1000,
      event: "spawn.intent",
      runId: "old",
      kind: "coder",
      task: "old task",
    });
    appendSpawnEvent({
      v: 1,
      ts: 5000,
      event: "spawn.intent",
      runId: "new",
      kind: "coder",
      task: "new task",
    });
    const events = readSpawnLedger({ sinceMs: 2000 });
    expect(events).toHaveLength(1);
    expect(events[0].runId).toBe("new");
  });

  it("tolerates a torn last line — returns only valid lines", () => {
    // Write a complete line then a partial (torn) line
    const full: SpawnLedgerEvent = {
      v: 1,
      ts: 2000,
      event: "spawn.pid",
      runId: "run-1",
      pid: 12345,
    };
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(LEDGER, `${JSON.stringify(full)}\n{"v":1,"ts":3000,"event":"spawn`); // torn
    const events = readSpawnLedger();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject(full);
  });

  it("skips lines with wrong version", () => {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.writeFileSync(
      LEDGER,
      `{"v":2,"ts":1000,"event":"spawn.intent","runId":"x","kind":"coder","task":"t"}\n`,
    );
    const events = readSpawnLedger();
    expect(events).toHaveLength(0);
  });
});

describe("replayLedgerToRunRecords", () => {
  it("folds intent → spawn.pid → run.ended correctly", () => {
    const events: SpawnLedgerEvent[] = [
      {
        v: 1,
        ts: 1000,
        event: "spawn.intent",
        runId: "run-xyz",
        kind: "coder",
        task: "my task",
        backend: "opencode",
      },
      { v: 1, ts: 1100, event: "spawn.pid", runId: "run-xyz", pid: 9999 },
      { v: 1, ts: 5000, event: "run.ended", runId: "run-xyz", outcome: "ok", durationMs: 3900 },
    ];
    const map = replayLedgerToRunRecords(events);
    const record = map.get("run-xyz");
    expect(record).toBeDefined();
    expect(record?.childPid).toBe(9999);
    expect(record?.task).toBe("my task");
    expect(record?.endedAt).toBe(5000);
    expect(record?.outcome).toMatchObject({ status: "ok" });
  });

  it("intent without run.ended marks run as still-running (no endedAt)", () => {
    const events: SpawnLedgerEvent[] = [
      {
        v: 1,
        ts: 1000,
        event: "spawn.intent",
        runId: "run-live",
        kind: "session",
        task: "ongoing",
      },
    ];
    const map = replayLedgerToRunRecords(events);
    const record = map.get("run-live");
    expect(record).toBeDefined();
    expect(record?.endedAt).toBeUndefined();
  });

  it("spawn.failed sets endedAt and error outcome", () => {
    const events: SpawnLedgerEvent[] = [
      { v: 1, ts: 2000, event: "spawn.intent", runId: "fail-run", kind: "coder", task: "boom" },
      { v: 1, ts: 2050, event: "spawn.failed", runId: "fail-run", error: "binary not found" },
    ];
    const map = replayLedgerToRunRecords(events);
    const record = map.get("fail-run");
    expect(record?.endedAt).toBe(2050);
    expect(record?.outcome).toMatchObject({ status: "error", error: "binary not found" });
  });
});

describe("compactLedger", () => {
  it("preserves only events for kept runIds", () => {
    appendSpawnEvent({
      v: 1,
      ts: 1000,
      event: "spawn.intent",
      runId: "keep-me",
      kind: "coder",
      task: "a",
    });
    appendSpawnEvent({
      v: 1,
      ts: 2000,
      event: "spawn.intent",
      runId: "drop-me",
      kind: "coder",
      task: "b",
    });
    appendSpawnEvent({ v: 1, ts: 3000, event: "spawn.pid", runId: "keep-me", pid: 1234 });

    compactLedger({ keepRunIds: new Set(["keep-me"]) });

    const events = readSpawnLedger();
    expect(events.every((e) => e.runId === "keep-me")).toBe(true);
    expect(events).toHaveLength(2);
  });

  it("results in empty file when keepRunIds is empty", () => {
    appendSpawnEvent({
      v: 1,
      ts: 1000,
      event: "spawn.intent",
      runId: "gone",
      kind: "coder",
      task: "t",
    });
    compactLedger({ keepRunIds: new Set() });
    const events = readSpawnLedger();
    expect(events).toHaveLength(0);
  });
});

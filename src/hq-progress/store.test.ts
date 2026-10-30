import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HQ_BULK_BURST_THRESHOLD,
  HQ_BULK_BURST_WINDOW_MS,
  HqProgressStore,
  isCommitmentSettledStatus,
  isCountedHqEvent,
  parseHqProgressOrigin,
  isDecisionDecidedStatus,
  isRiskResolvedStatus,
} from "./store.js";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "hq-progress-"));
  const file = join(dir, "hq-progress.json");
  return { file, store: new HqProgressStore(file) };
}

describe("HqProgressStore", () => {
  it("records a completion once per object per 24h and persists it", () => {
    const { file, store } = fresh();
    const a = store.record({ kind: "task.done", objectId: "t1", title: "Ship", source: "kanban" });
    const b = store.record({ kind: "task.done", objectId: "t1", title: "Ship", source: "kanban" });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.events).toHaveLength(1);
    // A fresh instance reads the same file.
    expect(new HqProgressStore(file).get().events).toHaveLength(1);
  });

  it("unrecord removes a same-day completion (reopen can't be farmed)", () => {
    const { store } = fresh();
    store.record({ kind: "task.done", objectId: "t1", title: "x", source: "kanban" });
    expect(store.unrecord("task.done", "t1")).toBe(1);
    expect(store.get().events).toHaveLength(0);
    // completing again after a reopen counts again
    expect(
      store.record({ kind: "task.done", objectId: "t1", title: "x", source: "kanban" }),
    ).not.toBeNull();
  });

  it("keeps the first snapshot of a day as the baseline and updates the latest", () => {
    const { store } = fresh();
    store.snapshot("2026-09-28", { overdue: 5 }, 1000);
    const pair = store.snapshot("2026-09-28", { overdue: 3, junk: Number.NaN }, 2000);
    expect(pair.first.metrics.overdue).toBe(5);
    expect(pair.last.metrics).toEqual({ overdue: 3 });
  });

  it("validates settings and manages snoozes", () => {
    const { store } = fresh();
    expect(() => store.setSettings({ dailyTarget: 0 })).toThrow();
    expect(store.setSettings({ dailyTarget: 7, parentProjectId: "p1" })).toMatchObject({
      dailyTarget: 7,
      parentProjectId: "p1",
    });
    const until = Date.now() + 60_000;
    expect(store.snooze("t9", until).snoozes.t9).toBe(until);
    expect(store.snooze("t9", null).snoozes.t9).toBeUndefined();
  });

  it("classifies terminal statuses", () => {
    expect(isDecisionDecidedStatus("Decided")).toBe(true);
    expect(isDecisionDecidedStatus("Deferred")).toBe(false);
    expect(isRiskResolvedStatus("Mitigated")).toBe(true);
    expect(isRiskResolvedStatus("Monitoring")).toBe(false);
    expect(isCommitmentSettledStatus("Paid")).toBe(true);
    expect(isCommitmentSettledStatus("Partially Paid")).toBe(false);
  });

  it("stores bulk/automation origins but marks them bulk (not counted)", () => {
    const { file, store } = fresh();
    const bulk = store.record({ kind: "task.done", objectId: "b1", title: "x", source: "kanban", origin: "bulk" });
    const auto = store.record({ kind: "task.done", objectId: "b2", title: "x", source: "kanban", origin: "automation" });
    const user = store.record({ kind: "task.done", objectId: "u1", title: "x", source: "kanban", origin: "user" });
    const agent = store.record({ kind: "task.done", objectId: "a1", title: "x", source: "kanban", origin: "agent" });
    expect(bulk).toMatchObject({ bulk: true, bulkReason: "origin", origin: "bulk" });
    expect(auto).toMatchObject({ bulk: true, origin: "automation" });
    expect(user?.bulk).toBeUndefined();
    expect(agent?.bulk).toBeUndefined();
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.events).toHaveLength(4); // raw events kept for audit
    expect(onDisk.events.filter(isCountedHqEvent).map((e: { objectId: string }) => e.objectId)).toEqual(["u1", "a1"]);
  });

  it("validates the source param", () => {
    expect(parseHqProgressOrigin(undefined)).toEqual({ ok: true, origin: undefined });
    expect(parseHqProgressOrigin("bulk")).toEqual({ ok: true, origin: "bulk" });
    expect(parseHqProgressOrigin("script").ok).toBe(false);
    expect(parseHqProgressOrigin(3).ok).toBe(false);
  });

  it("burst heuristic: >THRESHOLD from one connection in the window marks the whole burst", () => {
    const { store } = fresh();
    let t = 1_790_000_000_000;
    const clock = () => t;
    const s = new HqProgressStore(store.file, { now: clock });
    for (let i = 0; i < 25; i++) {
      t += 1_000; // 25 completions in 25s
      s.record({ kind: "task.done", objectId: `a${i}`, title: "x", source: "kanban", connKey: "conn:A" });
    }
    for (let i = 0; i < 5; i++) {
      t += 1_000;
      s.record({ kind: "task.done", objectId: `b${i}`, title: "x", source: "kanban", connKey: "conn:B" });
    }
    const events = new HqProgressStore(store.file).get(0).events;
    const a = events.filter((e) => e.objectId.startsWith("a"));
    const b = events.filter((e) => e.objectId.startsWith("b"));
    expect(a).toHaveLength(25);
    // Retroactive: the first THRESHOLD events are marked too.
    expect(a.every((e) => e.bulk === true && e.bulkReason === "burst")).toBe(true);
    expect(b.every((e) => isCountedHqEvent(e))).toBe(true);
  });

  it("burst heuristic: exactly THRESHOLD, or spread past the window, still counts", () => {
    const { store } = fresh();
    let t = 1_790_000_000_000;
    const s = new HqProgressStore(store.file, { now: () => t });
    for (let i = 0; i < HQ_BULK_BURST_THRESHOLD; i++) {
      t += 100;
      s.record({ kind: "task.done", objectId: `x${i}`, title: "x", source: "kanban", connKey: "conn:A" });
    }
    expect(s.get(0).events.every(isCountedHqEvent)).toBe(true);
    // Next one arrives after the window has slid past all of them.
    t += HQ_BULK_BURST_WINDOW_MS;
    s.record({ kind: "task.done", objectId: "late", title: "x", source: "kanban", connKey: "conn:A" });
    expect(s.get(0).events.every(isCountedHqEvent)).toBe(true);
  });

  it("burst thresholds are injectable", () => {
    const { store } = fresh();
    let t = 1_790_000_000_000;
    const s = new HqProgressStore(store.file, { now: () => t, burstThreshold: 2, burstWindowMs: 10_000 });
    for (let i = 0; i < 3; i++) {
      t += 1_000;
      s.record({ kind: "task.done", objectId: `y${i}`, title: "x", source: "kanban", connKey: "k" });
    }
    expect(s.get(0).events.filter(isCountedHqEvent)).toHaveLength(0);
  });

  it("applyBulkCorrection marks matching task events once, keeps them, and is idempotent", () => {
    const { file, store } = fresh();
    store.record({ kind: "task.done", objectId: "t1", title: "x", source: "kanban" });
    store.record({ kind: "task.done", objectId: "t2", title: "x", source: "kanban" });
    store.record({ kind: "decision.decided", objectId: "t1", title: "x", source: "decision" });
    const ids = new Set(["t1", "zz"]);
    expect(store.applyBulkCorrection("k1", ids, { file: "f", sha256: "s" })).toEqual({
      applied: true,
      matched: 1,
      marked: 1,
    });
    expect(store.applyBulkCorrection("k1", ids, { file: "f", sha256: "s" }).applied).toBe(false);
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.events).toHaveLength(3);
    expect(onDisk.corrections.k1).toMatchObject({ file: "f", sha256: "s", ids: 2, matched: 1, marked: 1 });
    const t1 = onDisk.events.find((e: { objectId: string; kind: string }) => e.objectId === "t1" && e.kind === "task.done");
    expect(t1).toMatchObject({ bulk: true, bulkReason: "correction" });
    // The marker survives later writes from a fresh instance.
    const again = new HqProgressStore(file);
    again.record({ kind: "task.done", objectId: "t3", title: "x", source: "kanban" });
    expect(JSON.parse(readFileSync(file, "utf8")).corrections.k1).toBeDefined();
  });
});

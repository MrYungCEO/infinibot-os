import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { QueueStore, QUEUE_SCHEMA_VERSION } from "./store.js";

const fresh = () => new QueueStore(mkdtempSync(join(tmpdir(), "queue-store-")));

function claimArgs(id: string, runId: string, phaseIdx = 0) {
  return {
    id,
    phaseIdx,
    orchestratorId: "o",
    runId,
    agent: "codex",
    backend: "codex" as const,
    modelRequested: "openai/gpt-5",
    model: "gpt-5",
    resumedSession: null,
    fallbackFrom: null,
    workdir: "/tmp",
  };
}

describe("QueueStore — schema + migrations", () => {
  it("creates a v2 schema on a fresh DB", () => {
    const s = fresh();
    expect(s.schemaVersion()).toBe(QUEUE_SCHEMA_VERSION);
    const tables = (
      s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining(["queue_entries", "queue_attempts", "queue_events", "queue_meta"]),
    );
  });

  it("migrates a legacy v1 table (old CHECK, no new columns) preserving rows + gate data", () => {
    const dir = mkdtempSync(join(tmpdir(), "queue-legacy-"));
    const db = new Database(join(dir, "queue.db"));
    db.exec(`CREATE TABLE queue_entries (
      id TEXT PRIMARY KEY, brief_md TEXT NOT NULL, phase_spec TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','running','blocked','done','failed','canceled')),
      priority INTEGER NOT NULL DEFAULT 0, depends_on TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, orchestrator_id TEXT,
      current_phase_idx INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, current_run_id TEXT);
      ALTER TABLE queue_entries ADD COLUMN phase_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE queue_entries ADD COLUMN last_gate TEXT;
      CREATE TABLE goal_runs (id TEXT PRIMARY KEY, data TEXT);
      INSERT INTO goal_runs VALUES ('goal_1', '{}');`);
    db.prepare(
      "INSERT INTO queue_entries (id,brief_md,phase_spec,status,created_at,current_phase_idx,attempts,phase_attempts,last_gate) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      "legacy-1",
      "# Old brief",
      JSON.stringify([
        { name: "a", brief: "" },
        { name: "b", brief: "" },
      ]),
      "blocked",
      1000,
      1,
      3,
      2,
      JSON.stringify({ pass: false, at: 1, phaseIdx: 1, attempt: 2, results: [] }),
    );
    db.close();

    const s = new QueueStore(dir);
    expect(s.schemaVersion()).toBe(QUEUE_SCHEMA_VERSION);
    const e = s.get("legacy-1")!;
    expect([
      e.status,
      e.currentPhaseIdx,
      e.attempts,
      e.phaseAttempts,
      e.lastGate?.phaseIdx,
    ]).toEqual(["blocked", 1, 3, 2, 1]);
    expect(e.updatedAt).toBe(1000);
    expect(e.isolation).toBe("none");
    expect(e.trusted).toBe(true);
    // New states are accepted after the rebuild.
    s.markPaused("legacy-1", ["blocked"]);
    expect(s.get("legacy-1")!.status).toBe("paused");
    // Goal tables sharing queue.db are untouched.
    expect((s.db.prepare("SELECT COUNT(*) c FROM goal_runs").get() as { c: number }).c).toBe(1);
    // Idempotent re-open.
    s.close();
    const again = new QueueStore(dir);
    expect(again.get("legacy-1")!.status).toBe("paused");
  });
});

describe("QueueStore — enqueue validation", () => {
  it("rejects empty phases + unknown deps; deps must pre-exist so a new entry cannot close a cycle", () => {
    const s = fresh();
    expect(() => s.enqueue({ briefMd: "", phaseSpec: [] })).toThrow(/at least one phase/);
    expect(() =>
      s.enqueue({ briefMd: "", phaseSpec: [{ name: "p", brief: "" }], dependsOn: ["nope"] }),
    ).toThrow(/unknown queue entry/);
    const a = s.enqueue({ briefMd: "", phaseSpec: [{ name: "p", brief: "" }] });
    const b = s.enqueue({ briefMd: "", phaseSpec: [{ name: "p", brief: "" }], dependsOn: [a.id] });
    // a → b cycle: only possible by editing deps; the checker still catches it.
    s.db
      .prepare("UPDATE queue_entries SET depends_on=? WHERE id=?")
      .run(JSON.stringify([b.id]), a.id);
    expect(() =>
      s.enqueue({ briefMd: "", phaseSpec: [{ name: "p", brief: "" }], dependsOn: [a.id] }),
    ).not.toThrow();
  });

  it("dedupes on idempotencyKey and derives a title", () => {
    const s = fresh();
    const a = s.enqueue({
      briefMd: "# Ship the widget\nmore",
      phaseSpec: [{ name: "p", brief: "" }],
      idempotencyKey: "k1",
    });
    const b = s.enqueue({
      briefMd: "other",
      phaseSpec: [{ name: "p", brief: "" }],
      idempotencyKey: "k1",
    });
    expect(b.id).toBe(a.id);
    expect(b.deduped).toBe(true);
    expect(a.title).toBe("Ship the widget");
    expect(s.list()).toHaveLength(1);
  });

  it("resolves unique id prefixes", () => {
    const s = fresh();
    const a = s.enqueue({ briefMd: "", phaseSpec: [{ name: "p", brief: "" }] });
    expect(s.resolveId(a.id.slice(0, 8))).toBe(a.id);
    expect(s.resolveId("zz")).toBeNull();
  });
});

describe("QueueStore — exactly-once transitions", () => {
  it("claim is atomic: a second claim of the same queued phase fails", () => {
    const s = fresh();
    const e = s.enqueue({ briefMd: "", phaseSpec: [{ name: "p", brief: "" }] });
    const a1 = s.claim(claimArgs(e.id, "run-1"));
    const a2 = s.claim(claimArgs(e.id, "run-2"));
    expect(a1?.runId).toBe("run-1");
    expect(a1?.outcome).toBe("starting");
    expect(a2).toBeNull();
    expect(s.get(e.id)!.currentRunId).toBe("run-1");
  });

  it("settleAttempt applies once; completePhase advances once", () => {
    const s = fresh();
    const e = s.enqueue({
      briefMd: "",
      phaseSpec: [
        { name: "a", brief: "" },
        { name: "b", brief: "" },
      ],
    });
    const a = s.claim(claimArgs(e.id, "run-1"))!;
    s.attemptStarted(a.id, { sessionId: "sess-1" });
    expect(s.settleAttempt(a.id, { outcome: "passed", counted: true, verdict: "verified" })).toBe(
      true,
    );
    expect(s.settleAttempt(a.id, { outcome: "failed", counted: true })).toBe(false);
    expect(s.getAttempt(a.id)!.outcome).toBe("passed");
    expect(s.completePhase(e.id, 0)?.currentPhaseIdx).toBe(1);
    expect(s.completePhase(e.id, 0)).toBeNull();
    expect(s.get(e.id)!.currentPhaseIdx).toBe(1);
    expect(s.getAttempt(a.id)!.sessionId).toBe("sess-1");
  });

  it("requeuePhase counts attempts, tracks transient failures and honours pause requests", () => {
    const s = fresh();
    const e = s.enqueue({ briefMd: "", phaseSpec: [{ name: "a", brief: "" }] });
    s.claim(claimArgs(e.id, "r1"));
    s.requeuePhase(e.id, 0, {
      feedback: "gate failed",
      counted: true,
      nextAttemptAt: Date.now() + 60_000,
    });
    let x = s.get(e.id)!;
    expect([x.status, x.phaseAttempts, x.transientFailures, x.lastError]).toEqual([
      "queued",
      1,
      0,
      "gate failed",
    ]);
    expect(s.eligible()).toHaveLength(0); // backoff
    s.db.prepare("UPDATE queue_entries SET next_attempt_at=NULL WHERE id=?").run(e.id);
    s.claim(claimArgs(e.id, "r2"));
    s.requestPause(e.id);
    s.requeuePhase(e.id, 0, { feedback: null, counted: false, transient: true });
    x = s.get(e.id)!;
    expect([x.status, x.phaseAttempts, x.transientFailures, x.pauseRequested]).toEqual([
      "paused",
      1,
      1,
      false,
    ]);
  });

  it("advancePhase refuses terminal entries (no resurrecting canceled/done)", () => {
    const s = fresh();
    const e = s.enqueue({
      briefMd: "",
      phaseSpec: [
        { name: "a", brief: "" },
        { name: "b", brief: "" },
      ],
    });
    s.markCanceled(e.id);
    expect(s.advancePhase(e.id)).toBeNull();
    expect(s.get(e.id)!.status).toBe("canceled");
    expect(s.retry(e.id)).toBe(true);
    expect(s.get(e.id)!.status).toBe("queued");
  });
});

describe("QueueStore — lease, events, metrics", () => {
  it("lease: one holder at a time; expired or dead-pid leases are stealable", () => {
    const s = fresh();
    expect(s.acquireLease("a", 10_000)).toBe(true);
    expect(s.acquireLease("b", 10_000)).toBe(false);
    expect(s.acquireLease("a", 10_000)).toBe(true); // renew
    expect(s.acquireLease("b", 10_000, process.pid, Date.now() + 20_000)).toBe(true); // expired
    // Dead holder pid → immediate steal.
    s.setMeta("lease_pid", "999999999");
    s.setMeta("lease_expires", String(Date.now() + 60_000));
    expect(s.acquireLease("c", 10_000)).toBe(true);
    s.releaseLease("c");
    expect(s.getMeta("lease_owner")).toBeNull();
  });

  it("events are persisted in order and trimmed per entry", () => {
    const s = fresh();
    const e = s.enqueue({ briefMd: "", phaseSpec: [{ name: "a", brief: "" }] });
    for (let i = 0; i < 450; i++) s.addEvent(e.id, "queue.test", `m${i}`, 0, { i });
    const ev = s.listEvents(e.id, 2000);
    expect(ev.length).toBeLessThanOrEqual(401);
    expect(ev[ev.length - 1].message).toBe("m449");
    expect(ev[ev.length - 1].data).toEqual({ i: 449 });
  });

  it("metrics: success rate + durations per agent", () => {
    const s = fresh();
    const e = s.enqueue({ briefMd: "", phaseSpec: [{ name: "a", brief: "" }] });
    const a1 = s.claim(claimArgs(e.id, "r1"))!;
    s.settleAttempt(a1.id, { outcome: "gate_failed", counted: true });
    s.requeuePhase(e.id, 0, { feedback: null, counted: true });
    const a2 = s.claim(claimArgs(e.id, "r2"))!;
    s.settleAttempt(a2.id, { outcome: "passed", counted: true });
    const m = s.metrics();
    expect(m.byAgent).toEqual([
      expect.objectContaining({
        agent: "codex",
        attempts: 2,
        passed: 1,
        failed: 1,
        successRate: 0.5,
      }),
    ]);
  });
});

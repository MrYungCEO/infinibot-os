import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  DEFAULT_TASK_ROUTING_POLICY,
  WorkforceRoutingStore,
  type StoredRoutingDecision,
} from "./routing-store.js";
import type { TaskRoutingDecision } from "./task-routing.js";

const AGENCY = "agency-1";

let dir: string;
let dbPath: string;
let store: WorkforceRoutingStore;

function decision(overrides: Partial<TaskRoutingDecision> = {}): TaskRoutingDecision {
  return {
    agencyId: AGENCY,
    taskId: "task-1",
    projectId: "project-1",
    taskTitle: "Rebuild the landing page",
    outcome: "assigned",
    workerId: "wren",
    workerName: "Wren",
    assigneeType: "ai",
    discipline: "frontend",
    matchStrength: 0.75,
    matchedTerms: ["landing page", "css"],
    score: 88.5,
    skillCoverage: 1,
    confidence: 0.83,
    matchedSkills: ["css"],
    missingSkills: [],
    estimatedHours: 2,
    runnerUp: { workerId: "dev", workerName: "Dev", score: 61 },
    rationale: "Routed to Wren: matched Front end / web.",
    needsHuman: false,
    autoStaged: false,
    stageRecommended: true,
    stageReason: "staged: confidence 0.83 at autonomy level 2",
    signature: "sig-1",
    ...overrides,
  };
}

function rowCount(): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT COUNT(*) FROM wf_task_routing_decisions").pluck().get() as number;
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "routing-store-"));
  dbPath = join(dir, "agency.db");
  store = new WorkforceRoutingStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("decisions", () => {
  it("round-trips every explainability field", () => {
    const { decision: stored, changed } = store.upsertDecision(AGENCY, decision());
    expect(changed).toBe(true);
    const read = store.getDecision(AGENCY, "task-1")!;
    expect(read).toMatchObject({
      workerId: "wren",
      matchedTerms: ["landing page", "css"],
      runnerUp: { workerId: "dev", workerName: "Dev", score: 61 },
      rationale: stored.rationale,
      decidedBy: "auto",
      pinned: false,
    });
  });

  it("declines to write an identical decision", () => {
    store.upsertDecision(AGENCY, decision());
    const before = store.getDecision(AGENCY, "task-1")!.updatedAt;
    const second = store.upsertDecision(AGENCY, decision(), { now: before + 5_000 });
    expect(second.changed).toBe(false);
    expect(store.getDecision(AGENCY, "task-1")!.updatedAt).toBe(before);
    expect(rowCount()).toBe(1);
  });

  it("writes when anything real changed", () => {
    store.upsertDecision(AGENCY, decision());
    const second = store.upsertDecision(AGENCY, decision({ workerId: "dev", workerName: "Dev" }));
    expect(second.changed).toBe(true);
    expect(store.getDecision(AGENCY, "task-1")!.workerId).toBe("dev");
    expect(rowCount()).toBe(1);
  });

  it("counts and filters for the operator's attention list", () => {
    store.upsertDecision(AGENCY, decision({ taskId: "t1" }));
    store.upsertDecision(
      AGENCY,
      decision({ taskId: "t2", outcome: "unmatched", workerId: null, needsHuman: true }),
    );
    expect(store.countDecisions(AGENCY)).toMatchObject({
      total: 2,
      assigned: 1,
      unmatched: 1,
      needsHuman: 1,
    });
    expect(store.listDecisions(AGENCY, { needsHuman: true }).map((d) => d.taskId)).toEqual(["t2"]);
    expect(store.listDecisions(AGENCY, { workerId: "wren" }).map((d) => d.taskId)).toEqual(["t1"]);
  });

  it("counts auto-staged cards inside the rolling window only", () => {
    const now = Date.now();
    store.upsertDecision(AGENCY, decision({ taskId: "old" }), {
      autoStaged: true,
      stagedAt: now - 2 * 86_400_000,
    });
    store.upsertDecision(AGENCY, decision({ taskId: "new" }), {
      autoStaged: true,
      stagedAt: now - 60_000,
    });
    expect(store.countAutoStagedSince(AGENCY, now - 86_400_000)).toBe(1);
  });

  it("scopes strictly by agency", () => {
    store.upsertDecision(AGENCY, decision());
    store.upsertDecision("other", { ...decision(), agencyId: "other" });
    expect(store.listDecisions(AGENCY)).toHaveLength(1);
    expect(store.decisionIndex("other").size).toBe(1);
  });
});

describe("policy", () => {
  it("reads defaults without writing a row", () => {
    const policy = store.getPolicy(AGENCY);
    expect(policy).toMatchObject(DEFAULT_TASK_ROUTING_POLICY);
    expect(policy.updatedAt).toBe(0);
    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) FROM wf_routing_policy").pluck().get()).toBe(0);
    db.close();
  });

  it("defaults to autostage 'auto' so the agency actually moves by itself", () => {
    expect(DEFAULT_TASK_ROUTING_POLICY.mode).toBe("auto");
    expect(DEFAULT_TASK_ROUTING_POLICY.enabled).toBe(true);
  });

  it("merges patches and clamps every bound", () => {
    const policy = store.setPolicy(AGENCY, {
      mode: "recommend",
      minConfidence: 9,
      maxAutoStagePerDay: 100_000,
      capacityHeadroom: -1,
    });
    expect(policy.mode).toBe("recommend");
    expect(policy.minConfidence).toBe(1);
    expect(policy.maxAutoStagePerDay).toBe(500);
    expect(policy.capacityHeadroom).toBe(0);
    expect(policy.minScore).toBe(DEFAULT_TASK_ROUTING_POLICY.minScore);
  });

  it("stores and clears per-worker mode overrides", () => {
    store.setPolicy(AGENCY, { workerModes: { wren: "off" } });
    expect(store.getPolicy(AGENCY).workerModes).toEqual({ wren: "off" });
    store.setPolicy(AGENCY, { workerModes: { wren: null } });
    expect(store.getPolicy(AGENCY).workerModes).toEqual({});
  });

  it("a no-op patch does not rewrite the row", () => {
    store.setPolicy(AGENCY, { mode: "off" });
    const before = store.getPolicy(AGENCY).updatedAt;
    store.setPolicy(AGENCY, { mode: "off" }, before + 10_000);
    expect(store.getPolicy(AGENCY).updatedAt).toBe(before);
  });
});

describe("provisioning ledger", () => {
  it("records and reports applied versions", () => {
    expect(store.getProvisionedVersion(AGENCY, "sops")).toBe(0);
    store.recordProvisioned(AGENCY, "sops", 1, { created: 7 });
    expect(store.getProvisionedVersion(AGENCY, "sops")).toBe(1);
    expect(store.listProvisioning(AGENCY)).toEqual([
      { key: "sops", version: 1, detail: { created: 7 }, appliedAt: expect.any(Number) },
    ]);
  });
});

describe("pinning", () => {
  it("keeps operator decisions distinguishable from the router's", () => {
    store.upsertDecision(AGENCY, decision(), { decidedBy: "operator", pinned: true });
    const read = store.getDecision(AGENCY, "task-1") as StoredRoutingDecision;
    expect(read.decidedBy).toBe("operator");
    expect(read.pinned).toBe(true);
  });
});

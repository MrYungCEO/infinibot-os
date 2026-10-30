import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { coerceRunResult } from "./contract.js";
import {
  __resetKanbanReconcileForTests,
  buildNote,
  claimRespawnTask,
  extractTaskIdTokens,
  findReferencedTasks,
  mergeKanbanUpdatesIntoReview,
  normalizeTaskId,
  planForState,
  reconcileRunKanban,
  reopenRunKanban,
  runLinkFromRunReview,
  sweepStalledRunTasks,
  sweepStateFor,
  type BoardTask,
  type KanbanUpdate,
  type ReconcileDeps,
  type RunLink,
} from "./kanban-reconcile.js";
import type { CompletionRecord, CompletionState } from "./store.js";

const P1 = "3f8f4bdd-9bcf-8144-a566-c44ee392ab6e";
const P2 = "3bbf4bdd-9bcf-8199-bd4b-fdcc77ac0216";
const T_MAIN = "3f9f4bdd-9bcf-812f-ae83-f2313fbae3e0";
const T_REF = "3f9f4bdd-9bcf-81fc-a841-e344c83e1587";
const T_OTHER_PROJECT = "3f8f4bdd-9bcf-81fc-89fa-f42f0c40a563";
const T_FUZZY = "3f9f4bdd-9bcf-8166-bc11-cf248924ea06";
const T_ORIG = "3f2f4bdd-9bcf-8141-8eb4-e383ba7a4fd7";

function rec(
  runId: string,
  state: CompletionState,
  over: Partial<CompletionRecord> = {},
): CompletionRecord {
  return {
    runId,
    token: "tok",
    childSessionKey: "agent:main:subagent:x",
    requesterSessionKey: "agent:main:main",
    label: "label",
    task: "task",
    backend: null,
    model: null,
    workdir: null,
    baseCommit: null,
    startedAt: 1,
    updatedAt: 2,
    state,
    attempts: [],
    maxContinuations: 3,
    result: {
      status: "done",
      summary: "Shipped the reconciler",
      commits: ["abc1234"],
      files_changed: [],
      claims: [],
      checks_run: [],
      screenshots: [],
      open_issues: [],
    },
    review: {
      verdict: state === "verified" ? "VERIFIED" : state === "failed" ? "FAILED" : "UNVERIFIED",
      reasons: state === "verified" ? [] : ["no screenshot for a visual change"],
      evidence: [{ kind: "command", ref: "pnpm test", status: "pass" } as never],
      visualFiles: [],
      visualSatisfied: true,
      screenshots: state === "verified" ? ["/tmp/a.png"] : [],
      llm: null,
      changedFiles: [],
      commits: ["abc1234"],
      reviewedAt: 3,
    },
    terminalAt: 4,
    round: 1,
    ...over,
  };
}

interface Harness {
  deps: ReconcileDeps;
  board: BoardTask[];
  writes: Array<{ id: string; patch: Record<string, unknown> }>;
  notes: Array<{ id: string; note: string }>;
  recorded: KanbanUpdate[][];
  records: Map<string, CompletionRecord>;
  runs: Map<string, RunLink>;
}

function harness(boardInit?: BoardTask[]): Harness {
  const board: BoardTask[] = boardInit ?? [
    {
      id: T_MAIN,
      title: "Verifier reconciles project Kanban",
      status: "in_progress",
      projectId: P1,
    },
    { id: T_REF, title: "Kanban real-time sync", status: "in_progress", projectId: P1 },
    { id: T_FUZZY, title: "Write the release notes", status: "todo", projectId: P1 },
    { id: T_OTHER_PROJECT, title: "Knowledge graph galaxy", status: "in_progress", projectId: P2 },
    {
      id: T_ORIG,
      title: "Original card",
      status: "review",
      projectId: P1,
      autonomousStatus: "blocked",
    },
  ];
  const writes: Harness["writes"] = [];
  const notes: Harness["notes"] = [];
  const recorded: KanbanUpdate[][] = [];
  const records = new Map<string, CompletionRecord>();
  const runs = new Map<string, RunLink>();
  const deps: ReconcileDeps = {
    listTasks: async () => board.map((t) => ({ ...t })),
    updateTask: async (id, patch) => {
      writes.push({ id, patch });
      const t = board.find((b) => normalizeTaskId(b.id) === normalizeTaskId(id));
      if (!t) return false;
      if (typeof patch.status === "string") t.status = patch.status;
      if (typeof patch.autonomousStatus === "string") t.autonomousStatus = patch.autonomousStatus;
      return true;
    },
    appendNote: async (id, note) => {
      notes.push({ id, note });
      return true;
    },
    resolveRun: (runId) => runs.get(runId) ?? null,
    getRecord: (runId) => records.get(runId),
    recordUpdates: (_runId, u) => recorded.push(u),
    now: () => 10_000_000,
  };
  return { deps, board, writes, notes, recorded, records, runs };
}

let stateDir: string;
const prevState = process.env.INFINIBOT_STATE_DIR;

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "vk-state-"));
  process.env.INFINIBOT_STATE_DIR = stateDir;
  __resetKanbanReconcileForTests();
});

afterEach(() => {
  __resetKanbanReconcileForTests();
  if (prevState === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prevState;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("planForState (verdict → board status)", () => {
  it("maps every terminal state, never leaving In progress", () => {
    expect(planForState("verified")).toMatchObject({ status: "done", blocked: false });
    expect(planForState("accepted")).toMatchObject({ status: "done", blocked: false });
    expect(planForState("unverified")).toMatchObject({ status: "review", blocked: false });
    for (const s of [
      "failed",
      "stalled",
      "blocked",
      "needs_input",
      "needs_owner",
      "rejected",
    ] as const)
      expect(planForState(s)).toMatchObject({ status: "review", blocked: true });
    expect(planForState("reopened")).toMatchObject({ status: "in_progress" });
    expect(planForState("running")).toBeNull();
    expect(planForState("reviewing")).toBeNull();
    expect(planForState("interrupted")).toBeNull();
  });
});

describe("referenced-task extraction", () => {
  it("normalizes dashed and compact Notion ids", () => {
    const compact = T_REF.replace(/-/g, "").toUpperCase();
    expect(extractTaskIdTokens(`see ${T_MAIN} and https://notion.so/x-${compact}`)).toEqual([
      T_MAIN,
      T_REF,
    ]);
    expect(extractTaskIdTokens(null)).toEqual([]);
  });

  it("keeps only same-project tasks, excludes the primary, suggests title matches", () => {
    const { board } = harness();
    const primary = board[0];
    const refs = findReferencedTasks({
      primary,
      board,
      texts: [`Also closes ${T_REF}, ${T_OTHER_PROJECT} and ${T_MAIN}`],
      summary: "Also covered: write the release notes for the launch",
    });
    expect(refs.explicit.map((t) => t.id)).toEqual([T_REF]);
    expect(refs.suggested.map((t) => t.id)).toEqual([T_FUZZY]);
  });

  it("honours RESULT.tasks_completed and parses it from the RESULT block", () => {
    const r = coerceRunResult({ status: "done", summary: "x", tasks_completed: [T_REF] });
    expect(r?.tasks_completed).toEqual([T_REF]);
    expect(coerceRunResult({ status: "done", summary: "x" })).not.toHaveProperty("tasks_completed");
    const { board } = harness();
    const refs = findReferencedTasks({
      primary: board[0],
      board,
      texts: [],
      tasksCompleted: [T_REF],
    });
    expect(refs.explicit.map((t) => t.id)).toEqual([T_REF]);
  });

  it("references nothing when the primary task has no project", () => {
    const { board } = harness();
    const refs = findReferencedTasks({
      primary: { ...board[0], projectId: "" },
      board,
      texts: [T_REF],
    });
    expect(refs.explicit).toEqual([]);
  });
});

describe("reconcileRunKanban", () => {
  it("VERIFIED → Done with evidence note; referenced task follows; other boards untouched", async () => {
    const h = harness();
    h.records.set(
      "run-1",
      rec("run-1", "verified", { task: `Fix it. Related task ${T_REF}. Not ${T_OTHER_PROJECT}` }),
    );
    h.runs.set("run-1", { runId: "run-1", kanbanTaskId: T_MAIN, endedAt: 1 });
    const ups = await reconcileRunKanban("run-1", h.deps);
    expect(h.board.find((t) => t.id === T_MAIN)?.status).toBe("done");
    expect(h.board.find((t) => t.id === T_REF)?.status).toBe("done");
    expect(h.board.find((t) => t.id === T_OTHER_PROJECT)?.status).toBe("in_progress");
    expect(ups.filter((u) => u.outcome === "applied").map((u) => u.relation)).toEqual([
      "primary",
      "referenced",
    ]);
    const note = h.notes.find((n) => n.id === T_MAIN)!.note;
    expect(note).toMatch(/VERIFIED → Done/);
    expect(note).toMatch(/abc1234/);
    expect(note).toMatch(/\/tmp\/a\.png/);
    expect(h.recorded).toHaveLength(1);
  });

  it("UNVERIFIED → Review with what is missing", async () => {
    const h = harness();
    h.records.set("run-2", rec("run-2", "unverified"));
    h.runs.set("run-2", { runId: "run-2", kanbanTaskId: T_MAIN, endedAt: 1 });
    await reconcileRunKanban("run-2", h.deps);
    expect(h.board[0]).toMatchObject({ status: "review" });
    expect(h.writes[0].patch).toEqual({ status: "review" });
    expect(h.notes[0].note).toMatch(/Missing:[\s\S]*no screenshot/);
  });

  it.each(["failed", "stalled", "blocked", "needs_input", "needs_owner"] as const)(
    "%s → Review + blocked flag with a follow-up pointer",
    async (state) => {
      const h = harness();
      h.records.set("run-3", rec("run-3", state));
      h.runs.set("run-3", { runId: "run-3", kanbanTaskId: T_MAIN, endedAt: 1 });
      await reconcileRunKanban("run-3", h.deps);
      expect(h.board[0]).toMatchObject({ status: "review", autonomousStatus: "blocked" });
      expect(h.notes[0].note).toMatch(/run-3/);
      expect(h.notes[0].note).toMatch(/Follow-up/);
    },
  );

  it("is idempotent: re-running does not write or note again", async () => {
    const h = harness();
    h.records.set("run-4", rec("run-4", "verified"));
    h.runs.set("run-4", { runId: "run-4", kanbanTaskId: T_MAIN, endedAt: 1 });
    await reconcileRunKanban("run-4", h.deps);
    const again = await reconcileRunKanban("run-4", h.deps);
    expect(h.writes).toHaveLength(1);
    expect(h.notes).toHaveLength(1);
    expect(again[0]).toMatchObject({
      outcome: "skipped",
      reason: "already reconciled for this run",
    });
  });

  it("does not flap a task the owner moved after reconciliation", async () => {
    const h = harness();
    h.records.set("run-5", rec("run-5", "unverified"));
    h.runs.set("run-5", { runId: "run-5", kanbanTaskId: T_MAIN, endedAt: 1 });
    await reconcileRunKanban("run-5", h.deps);
    h.board[0].status = "in_progress"; // owner dragged it back
    const again = await reconcileRunKanban("run-5", h.deps);
    expect(h.board[0].status).toBe("in_progress");
    expect(again[0].reason).toMatch(/moved to in_progress after reconciliation/);
  });

  it("never pulls a Done task back to Review", async () => {
    const h = harness();
    h.board[0].status = "done";
    h.records.set("run-6", rec("run-6", "failed"));
    h.runs.set("run-6", { runId: "run-6", kanbanTaskId: T_MAIN, endedAt: 1 });
    const ups = await reconcileRunKanban("run-6", h.deps);
    expect(h.writes).toHaveLength(0);
    expect(ups[0]).toMatchObject({ outcome: "skipped", reason: "task is already Done" });
  });

  it("dry-run reports without writing", async () => {
    const h = harness();
    h.records.set("run-7", rec("run-7", "verified"));
    h.runs.set("run-7", { runId: "run-7", kanbanTaskId: T_MAIN, endedAt: 1 });
    const ups = await reconcileRunKanban("run-7", h.deps, { dryRun: true });
    expect(ups[0]).toMatchObject({ outcome: "dry-run", to: "done" });
    expect(h.writes).toHaveLength(0);
    expect(h.notes).toHaveLength(0);
  });

  it("clears the blocked flag when a blocked task later verifies", async () => {
    const h = harness();
    h.board[0].status = "review";
    h.board[0].autonomousStatus = "blocked";
    h.records.set("run-8", rec("run-8", "verified"));
    h.runs.set("run-8", { runId: "run-8", kanbanTaskId: T_MAIN, endedAt: 1 });
    await reconcileRunKanban("run-8", h.deps);
    expect(h.writes[0].patch).toEqual({ status: "done", autonomousStatus: "complete" });
  });

  it("suggests fuzzy matches in a note but never moves them", async () => {
    const h = harness();
    const r = rec("run-9", "verified");
    r.result!.summary = "Done, and also write the release notes was handled";
    h.records.set("run-9", r);
    h.runs.set("run-9", { runId: "run-9", kanbanTaskId: T_MAIN, endedAt: 1 });
    const ups = await reconcileRunKanban("run-9", h.deps);
    expect(h.board.find((t) => t.id === T_FUZZY)?.status).toBe("todo");
    expect(ups.find((u) => u.taskId === T_FUZZY)).toMatchObject({
      relation: "suggested",
      outcome: "skipped",
    });
    expect(h.notes.some((n) => n.id === T_MAIN && /may also cover/.test(n.note))).toBe(true);
  });

  it("skips runs without a kanban task or with a non-settled state", async () => {
    const h = harness();
    h.records.set("run-10", rec("run-10", "verified"));
    h.runs.set("run-10", { runId: "run-10" });
    expect(await reconcileRunKanban("run-10", h.deps)).toEqual([]);
    h.records.set("run-11", rec("run-11", "reviewing"));
    h.runs.set("run-11", { runId: "run-11", kanbanTaskId: T_MAIN });
    expect(await reconcileRunKanban("run-11", h.deps)).toEqual([]);
    expect(h.writes).toHaveLength(0);
  });
});

describe("respawn handling", () => {
  it("claimRespawnTask reuses the original card and moves it back to In progress", async () => {
    const h = harness();
    h.runs.set("orig", { runId: "orig", kanbanTaskId: T_ORIG, endedAt: 1 });
    const id = await claimRespawnTask("orig", "new-run", h.deps);
    expect(id).toBe(T_ORIG);
    expect(h.board.find((t) => t.id === T_ORIG)).toMatchObject({
      status: "in_progress",
      autonomousStatus: "in_progress",
    });
    expect(h.notes[0].note).toMatch(/respawned as run new-run/);
    expect(await claimRespawnTask("unknown", "x", h.deps)).toBeUndefined();
  });

  it("a respawn on its own card also settles the original card (no stale duplicate)", async () => {
    const h = harness();
    h.board.find((t) => t.id === T_ORIG)!.status = "in_progress";
    h.board.find((t) => t.id === T_ORIG)!.autonomousStatus = null;
    h.runs.set("orig", { runId: "orig", kanbanTaskId: T_ORIG, endedAt: 1 });
    h.runs.set("re", { runId: "re", kanbanTaskId: T_MAIN, respawnOfRunId: "orig", endedAt: 2 });
    h.records.set("re", rec("re", "verified"));
    const ups = await reconcileRunKanban("re", h.deps);
    expect(ups.map((u) => [u.relation, u.outcome])).toEqual([
      ["primary", "applied"],
      ["respawn-original", "applied"],
    ]);
    expect(h.board.find((t) => t.id === T_ORIG)?.status).toBe("done");
  });

  it("operator Continue reopens a Done task for the new round", async () => {
    const h = harness();
    h.records.set("run-c", rec("run-c", "verified"));
    h.runs.set("run-c", { runId: "run-c", kanbanTaskId: T_MAIN, endedAt: 1 });
    await reconcileRunKanban("run-c", h.deps);
    expect(h.board[0].status).toBe("done");
    h.records.set("run-c", rec("run-c", "continuing", { round: 2, terminalAt: null }));
    await reopenRunKanban("run-c", h.deps);
    expect(h.board[0].status).toBe("in_progress");
    h.records.set("run-c", rec("run-c", "unverified", { round: 2 }));
    await reconcileRunKanban("run-c", h.deps);
    expect(h.board[0].status).toBe("review");
  });
});

describe("sweep", () => {
  const NOW = 10_000_000;
  it("derives a state for runs the hook never settled", () => {
    expect(sweepStateFor({ runId: "a" }, rec("a", "verified")).state).toBe("verified");
    expect(sweepStateFor({ runId: "a" }, rec("a", "interrupted", { terminalAt: null }))).toEqual({
      state: "stalled",
      source: "record-stuck",
    });
    expect(sweepStateFor({ runId: "a", outcomeStatus: "error" }, undefined).state).toBe("failed");
    expect(sweepStateFor({ runId: "a", outcomeStatus: "timeout" }, undefined).state).toBe(
      "stalled",
    );
    expect(sweepStateFor({ runId: "a", outcomeStatus: "ok" }, undefined).state).toBe("unverified");
  });

  it("reconciles ended runs, skips live / recent ones, and is idempotent", async () => {
    const h = harness();
    h.records.set("old-ok", rec("old-ok", "verified"));
    const runs: RunLink[] = [
      { runId: "old-ok", kanbanTaskId: T_MAIN, endedAt: NOW - 60 * 60_000 },
      { runId: "old-err", kanbanTaskId: T_REF, endedAt: NOW - 90 * 60_000, outcomeStatus: "error" },
      { runId: "recent", kanbanTaskId: T_FUZZY, endedAt: NOW - 60_000 },
      { runId: "live", kanbanTaskId: T_OTHER_PROJECT },
    ];
    const dry = await sweepStalledRunTasks({
      deps: h.deps,
      runs,
      olderThanMs: 30 * 60_000,
      dryRun: true,
    });
    expect(dry.candidates.map((c) => [c.taskId, c.state])).toEqual([
      [T_MAIN, "verified"],
      [T_REF, "failed"],
    ]);
    expect(dry.skipped.map((s) => s.reason)).toEqual([
      "run ended recently",
      "a run on this task is still live",
    ]);
    expect(h.writes).toHaveLength(0);

    await sweepStalledRunTasks({ deps: h.deps, runs, olderThanMs: 30 * 60_000 });
    expect(h.board.find((t) => t.id === T_MAIN)?.status).toBe("done");
    expect(h.board.find((t) => t.id === T_REF)).toMatchObject({
      status: "review",
      autonomousStatus: "blocked",
    });
    const writes = h.writes.length;
    const again = await sweepStalledRunTasks({ deps: h.deps, runs, olderThanMs: 30 * 60_000 });
    expect(again.candidates).toHaveLength(0);
    expect(h.writes).toHaveLength(writes);
  });

  it("links old runs through their run review (registry history is short)", () => {
    expect(
      runLinkFromRunReview({ runId: "a", kanbanTaskId: T_MAIN, status: "failed", finishedAt: 5 }),
    ).toMatchObject({ kanbanTaskId: T_MAIN, outcomeStatus: "error", endedAt: 5, live: false });
    expect(
      runLinkFromRunReview({ runId: "b", kanbanTaskId: T_MAIN, status: "in_progress" }),
    ).toBeNull();
    expect(runLinkFromRunReview({ runId: "c", status: "built" })).toBeNull();
  });

  it("uses the latest run when several runs share a task", async () => {
    const h = harness();
    h.records.set("first", rec("first", "failed"));
    h.records.set("second", rec("second", "verified"));
    const runs: RunLink[] = [
      { runId: "first", kanbanTaskId: T_MAIN, endedAt: NOW - 5 * 60 * 60_000 },
      { runId: "second", kanbanTaskId: T_MAIN, endedAt: NOW - 2 * 60 * 60_000 },
    ];
    const r = await sweepStalledRunTasks({ deps: h.deps, runs, dryRun: true });
    expect(r.candidates).toEqual([expect.objectContaining({ runId: "second", state: "verified" })]);
  });

  it("leaves a task the owner moved back after a sweep alone", async () => {
    const h = harness();
    const runs: RunLink[] = [
      { runId: "r", kanbanTaskId: T_MAIN, endedAt: NOW - 60 * 60_000, outcomeStatus: "ok" },
    ];
    await sweepStalledRunTasks({ deps: h.deps, runs });
    expect(h.board[0].status).toBe("review");
    h.board[0].status = "in_progress";
    const again = await sweepStalledRunTasks({ deps: h.deps, runs });
    expect(again.candidates).toHaveLength(0);
    expect(again.skipped[0].reason).toMatch(/left alone/);
  });
});

describe("run review recording", () => {
  it("adds kanban actions once (deduped)", () => {
    const u: KanbanUpdate = {
      runId: "r",
      taskId: T_MAIN,
      title: "Card",
      relation: "primary",
      from: "in_progress",
      to: "done",
      outcome: "applied",
      state: "verified",
      at: 5,
    };
    const first = mergeKanbanUpdatesIntoReview({ actions: [] }, [u]);
    expect(first.actions[0]).toMatchObject({
      kind: "kanban",
      detail: 'Kanban: "Card" in_progress → done',
    });
    const second = mergeKanbanUpdatesIntoReview(first, [u]);
    expect(second.actions).toHaveLength(1);
    expect(second.kanbanUpdates).toHaveLength(1);
  });

  it("buildNote for a referenced task names the run and primary task", () => {
    expect(
      buildNote({ state: "verified", runId: "r1", relation: "referenced", primaryTaskId: T_MAIN }),
    ).toMatch(/referenced by run r1, task 3f9f4bdd/);
  });
});

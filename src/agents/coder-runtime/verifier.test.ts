/**
 * Verifier-gated kanban transition tests.
 *
 * Proves the GATE — `gateKanbanTransition` — enforces verifier-gating:
 *   A. All criteria pass        → kanban observes "done".
 *   B. 1 of 3 criteria fail     → kanban observes "review", failing criterion
 *                                 appears in the appended comment.
 *   C. No criteria provided     → legacy path runs (kanban → "done"), and the
 *                                 verifier is NEVER invoked.
 *
 * The gate's external effects (spawning the verifier child, flipping the kanban
 * task, appending the comment) are dependency-injected, so these tests observe
 * the real decision logic without spawning a process or touching a live board.
 */
import { describe, expect, it, vi } from "vitest";

import {
  gateKanbanTransition,
  type KanbanGateDeps,
  type VerifierReport,
  type VerifierTarget,
} from "./verifier.js";

/** Build a deps object with recording spies + an injected verifier verdict. */
function makeDeps(verdict?: VerifierReport): {
  deps: KanbanGateDeps;
  updates: Array<{ taskId: string; patch: { status: string } }>;
  comments: Array<{ taskId: string; body: string }>;
  spawnVerifier: ReturnType<typeof vi.fn>;
} {
  const updates: Array<{ taskId: string; patch: { status: string } }> = [];
  const comments: Array<{ taskId: string; body: string }> = [];
  const spawnVerifier = vi.fn(async (_t: VerifierTarget) => {
    if (!verdict) throw new Error("verifier should not be called in this test");
    return verdict;
  });
  const deps: KanbanGateDeps = {
    spawnVerifier,
    updateTask: async (taskId, patch) => {
      updates.push({ taskId, patch });
    },
    appendComment: async (taskId, body) => {
      comments.push({ taskId, body });
    },
  };
  return { deps, updates, comments, spawnVerifier };
}

const baseTarget = (overrides: Partial<VerifierTarget> = {}): VerifierTarget => ({
  runId: "run-1",
  task: "do the thing",
  kanbanTaskId: "task-1",
  workdir: "/repo",
  ...overrides,
});

describe("gateKanbanTransition — verifier gating", () => {
  it("Test A: all criteria pass → kanban observes 'done'", async () => {
    const verdict: VerifierReport = {
      passed: true,
      results: [
        { criterion: "exports bar()", status: "pass", evidence: "src/foo.ts line 4" },
        { criterion: "tests pass", status: "pass", evidence: "npm test green" },
      ],
    };
    const { deps, updates, comments, spawnVerifier } = makeDeps(verdict);

    const result = await gateKanbanTransition(
      {
        target: baseTarget({ acceptanceCriteria: ["exports bar()", "tests pass"] }),
        outcomeStatus: "ok",
      },
      deps,
    );

    expect(spawnVerifier).toHaveBeenCalledOnce();
    expect(result.status).toBe("done");
    expect(result.verified).toBe(true);
    expect(updates).toEqual([{ taskId: "task-1", patch: { status: "done" } }]);
    // A pass still records a verifier comment for the audit trail.
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("PASSED");
  });

  it("Test B: 1 of 3 criteria fail → kanban observes 'review' with failing criterion in comment", async () => {
    const verdict: VerifierReport = {
      passed: false,
      results: [
        { criterion: "schema updated", status: "pass", evidence: "zod-schema.ts changed" },
        { criterion: "verifier auto-spawns", status: "pass", evidence: "registry wired" },
        {
          criterion: "stale-task sweeper exists",
          status: "fail",
          evidence: "no stale-task-sweep.ts found",
        },
      ],
    };
    const { deps, updates, comments, spawnVerifier } = makeDeps(verdict);

    const result = await gateKanbanTransition(
      {
        target: baseTarget({
          acceptanceCriteria: [
            "schema updated",
            "verifier auto-spawns",
            "stale-task sweeper exists",
          ],
        }),
        outcomeStatus: "ok",
      },
      deps,
    );

    expect(spawnVerifier).toHaveBeenCalledOnce();
    expect(result.status).toBe("review");
    expect(result.verified).toBe(true);
    expect(updates).toEqual([{ taskId: "task-1", patch: { status: "review" } }]);
    // The failing criterion + its evidence must be in the appended comment.
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("stale-task sweeper exists");
    expect(comments[0].body).toContain("no stale-task-sweep.ts found");
    expect(comments[0].body).toContain("FAILED");
  });

  it("Test C: no criteria → legacy path runs (kanban → 'done'), verifier never called", async () => {
    const { deps, updates, comments, spawnVerifier } = makeDeps(/* no verdict */);

    const result = await gateKanbanTransition(
      { target: baseTarget({ acceptanceCriteria: [] }), outcomeStatus: "ok" },
      deps,
    );

    expect(spawnVerifier).not.toHaveBeenCalled();
    expect(result.status).toBe("done");
    expect(result.verified).toBe(false);
    expect(updates).toEqual([{ taskId: "task-1", patch: { status: "done" } }]);
    expect(comments).toHaveLength(0);
  });
});

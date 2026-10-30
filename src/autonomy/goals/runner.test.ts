import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalStore } from "./store.js";
import { GoalRunner, claimsDone, type GoalExecutor, type ExecutorStartParams } from "./runner.js";
import { normalizeChecks } from "./checks.js";
import type { CreateGoalInput, GoalRun } from "./types.js";

interface FakeRun {
  params: ExecutorStartParams;
  state: "running" | "exited" | "missing";
  exitCode: number | null;
  lastOutputAt: number;
  output: string;
  killed: boolean;
}

/** Deterministic executor: tests decide when/how each spawned run ends. */
function makeExecutor(clock: { t: number }) {
  const runs = new Map<string, FakeRun>();
  const order: string[] = [];
  let seq = 0;
  let failStart = 0;
  const exec: GoalExecutor & {
    runs: typeof runs;
    order: string[];
    last(): FakeRun;
    finish(code: number, output?: string): void;
    failNextStarts(n: number): void;
  } = {
    runs,
    order,
    async start(p) {
      if (failStart > 0) {
        failStart--;
        throw new Error("binary not found");
      }
      const runId = `run-${++seq}`;
      runs.set(runId, {
        params: p,
        state: "running",
        exitCode: null,
        lastOutputAt: clock.t,
        output: "",
        killed: false,
      });
      order.push(runId);
      return { runId, sessionId: p.resumeSessionId ?? `sess-${seq}` };
    },
    async status(runId) {
      const r = runs.get(runId);
      if (!r) return { state: "missing" };
      return { state: r.state, exitCode: r.exitCode, lastOutputAt: r.lastOutputAt };
    },
    async output(runId) {
      return runs.get(runId)?.output ?? "";
    },
    async kill(runId) {
      const r = runs.get(runId);
      if (r) {
        r.killed = true;
        r.state = "exited";
        r.exitCode = 143;
      }
    },
    supportsResume: (t) => t.kind === "cli",
    last() {
      return runs.get(order.at(-1)!)!;
    },
    finish(code, output = "") {
      const r = exec.last();
      r.state = "exited";
      r.exitCode = code;
      r.output = output;
    },
    failNextStarts(n) {
      failStart = n;
    },
  };
  return exec;
}

describe("GoalRunner", () => {
  let dir: string;
  let work: string;
  let store: GoalStore;
  let clock: { t: number };
  let exec: ReturnType<typeof makeExecutor>;
  let runner: GoalRunner;
  let notified: GoalRun[];

  const create = (over: Partial<CreateGoalInput> = {}) =>
    store.create({
      goal: "create hello.txt containing HELLO",
      target: { kind: "cli", backend: "claude-code" },
      workdir: work,
      limits: { maxIterations: 3, checkIntervalSec: 0, hangSec: 0, iterationTimeoutSec: 600 },
      ...over,
      checks: normalizeChecks(
        over.checks ?? [{ type: "grep", path: "hello.txt", pattern: "HELLO" }],
      ),
    } as CreateGoalInput & { checks: any });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "goal-store-"));
    work = mkdtempSync(join(tmpdir(), "goal-work-"));
    store = new GoalStore(dir);
    clock = { t: 1_000_000 };
    exec = makeExecutor(clock);
    notified = [];
    runner = new GoalRunner({
      store,
      executor: exec,
      now: () => clock.t,
      notify: (r) => {
        notified.push(r);
      },
      judge: async () => ({ pass: true, rationale: "ok" }),
    });
  });

  it("completes on the first iteration when checks pass", async () => {
    const g = create();
    await runner.tick(); // spawn
    expect(store.get(g.id)!.status).toBe("running");
    writeFileSync(join(work, "hello.txt"), "HELLO\n");
    exec.finish(0, "Done.");
    await runner.tick();
    const r = store.get(g.id)!;
    expect(r.status).toBe("completed");
    expect(r.iterations).toHaveLength(1);
    expect(r.lastResults.c1.pass).toBe(true);
    expect(notified.map((n) => n.status)).toEqual(["completed"]);
  });

  it("never completes on a clean exit alone; feeds failing checks back and passes on iteration 2", async () => {
    const g = create();
    await runner.tick();
    exec.finish(0, "I have completed the task. Done.");
    await runner.tick();
    let r = store.get(g.id)!;
    expect(r.status).toBe("running");
    expect(r.iterations[0].outcome).toBe("claimed_done_checks_failed");
    expect(r.iterations).toHaveLength(2);
    // Iteration 2 resumes the same session and carries the failing check output.
    const second = exec.last().params;
    expect(second.resumeSessionId).toBe("sess-1");
    expect(second.prompt).toContain("Failing checks");
    expect(second.prompt).toContain("hello.txt");
    writeFileSync(join(work, "hello.txt"), "HELLO");
    exec.finish(0);
    await runner.tick();
    r = store.get(g.id)!;
    expect(r.status).toBe("completed");
    expect(r.iterations).toHaveLength(2);
    expect(store.checkHistory(g.id).map((h) => h.pass)).toEqual([false, true]);
  });

  it("is exhausted after max iterations with the failing checks in the reason", async () => {
    const g = create();
    for (let i = 0; i < 3; i++) {
      await runner.tick();
      exec.finish(0, "working");
    }
    await runner.tick();
    const r = store.get(g.id)!;
    expect(r.status).toBe("exhausted");
    expect(r.reason).toMatch(/^max_iterations: 3/);
    expect(r.reason).toContain("c1");
    expect(exec.order).toHaveLength(3);
    expect(notified[0]?.status).toBe("exhausted");
  });

  it("kills and records a per-iteration timeout, then continues", async () => {
    const g = create();
    await runner.tick();
    clock.t += 601_000;
    await runner.tick();
    const r = store.get(g.id)!;
    expect(r.iterations[0].outcome).toBe("timeout");
    expect(exec.runs.get("run-1")!.killed).toBe(true);
    expect(r.iterations).toHaveLength(2);
  });

  it("detects a hang (no output for hangSec) as a distinct outcome", async () => {
    const g = create({ limits: { maxIterations: 3, hangSec: 60, checkIntervalSec: 0 } });
    await runner.tick();
    clock.t += 30_000;
    exec.last().lastOutputAt = clock.t; // some output
    await runner.tick();
    expect(store.get(g.id)!.iterations[0].outcome).toBe("running");
    clock.t += 61_000;
    await runner.tick();
    const r = store.get(g.id)!;
    expect(r.iterations[0].outcome).toBe("hung");
    expect(r.iterations[1].prompt).toContain("no output");
  });

  it("classifies non-zero exits and crashes distinctly; repeated crashes FAIL", async () => {
    const g = create({ limits: { maxIterations: 10, checkIntervalSec: 0, hangSec: 0 } });
    await runner.tick();
    exec.finish(2, "error: boom");
    await runner.tick();
    expect(store.get(g.id)!.iterations[0].outcome).toBe("nonzero_exit");
    for (let i = 0; i < 3; i++) {
      exec.runs.delete(exec.order.at(-1)!); // process vanished
      await runner.tick();
    }
    const r = store.get(g.id)!;
    expect(r.iterations.slice(-3).map((i) => i.outcome)).toEqual(["crashed", "crashed", "crashed"]);
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/^crashed/);
  });

  it("fails after repeated spawn failures", async () => {
    const g = create({ limits: { maxIterations: 10 } });
    exec.failNextStarts(5);
    for (let i = 0; i < 4; i++) await runner.tick();
    const r = store.get(g.id)!;
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/^spawn_failed/);
    expect(r.iterations[0].note).toContain("binary not found");
  });

  it("completes early when periodic checks pass while the agent is still working", async () => {
    const g = create({ limits: { maxIterations: 3, checkIntervalSec: 30, hangSec: 0 } });
    await runner.tick();
    clock.t += 31_000;
    await runner.tick(); // timer check fails, keeps running
    expect(store.get(g.id)!.status).toBe("running");
    writeFileSync(join(work, "hello.txt"), "HELLO");
    clock.t += 31_000;
    await runner.tick();
    const r = store.get(g.id)!;
    expect(r.status).toBe("completed");
    expect(r.iterations[0].outcome).toBe("checks_passed");
    expect(exec.last().killed).toBe(true);
  });

  it("recovers after a gateway restart: live durable agent is re-attached, mid-check run is re-checked", async () => {
    const a = create();
    const b = create();
    await runner.tick();
    // Simulate a crash mid-check for b.
    const rb = store.get(b.id)!;
    rb.status = "checking";
    rb.iterations[0].endedAt = clock.t;
    rb.iterations[0].outcome = "exited";
    store.save(rb);
    writeFileSync(join(work, "hello.txt"), "HELLO");
    // "Restart": a brand-new store + runner over the same state dir and executor.
    const store2 = new GoalStore(dir);
    const runner2 = new GoalRunner({ store: store2, executor: exec, now: () => clock.t });
    runner2.recover();
    await runner2.tick();
    expect(store2.get(b.id)!.status).toBe("completed");
    // a's agent is still alive → still supervised, not blocked or restarted.
    expect(store2.get(a.id)!.status).toBe("running");
    expect(store2.get(a.id)!.iterations).toHaveLength(1);
    exec.runs.get(store2.get(a.id)!.iterations[0].runId!)!.state = "exited";
    exec.runs.get(store2.get(a.id)!.iterations[0].runId!)!.exitCode = 0;
    await runner2.tick();
    expect(store2.get(a.id)!.status).toBe("completed");
  });

  it("pause / resume / cancel / continue / recheck controls", async () => {
    const g = create();
    await runner.tick();
    await runner.pause(g.id);
    let r = store.get(g.id)!;
    expect(r.status).toBe("paused");
    expect(r.iterations[0].outcome).toBe("interrupted");
    await runner.tick(); // paused runs are not touched
    expect(exec.order).toHaveLength(1);
    await runner.resume(g.id); // re-verifies, then continues
    r = store.get(g.id)!;
    expect(r.status).toBe("running");
    expect(r.iterations).toHaveLength(2);
    await runner.continueWith(g.id, "Use uppercase HELLO");
    r = store.get(g.id)!;
    expect(r.iterations[1].outcome).toBe("interrupted");
    expect(exec.last().params.prompt).toContain("Use uppercase HELLO");
    // Interrupted iterations don't burn the budget.
    expect(r.iterations).toHaveLength(3);
    writeFileSync(join(work, "hello.txt"), "HELLO");
    const { allPass } = await runner.recheck(g.id);
    expect(allPass).toBe(true);
    expect(store.get(g.id)!.status).toBe("completed");

    const c = create();
    await runner.tick();
    await runner.cancel(c.id);
    expect(store.get(c.id)!.status).toBe("canceled");
  });

  it("retry reopens an exhausted run with a fresh budget", async () => {
    const g = create({ limits: { maxIterations: 1, checkIntervalSec: 0, hangSec: 0 } });
    await runner.tick();
    exec.finish(0);
    await runner.tick();
    expect(store.get(g.id)!.status).toBe("exhausted");
    await runner.retry(g.id);
    let r = store.get(g.id)!;
    expect(r.status).toBe("running");
    expect(r.limits.maxIterations).toBe(2);
    writeFileSync(join(work, "hello.txt"), "HELLO");
    exec.finish(0);
    await runner.tick();
    r = store.get(g.id)!;
    expect(r.status).toBe("completed");
  });

  it("llm checks use the injected judge and only run on the timer once cheap checks pass", async () => {
    let judged = 0;
    const r2 = new GoalRunner({
      store,
      executor: exec,
      now: () => clock.t,
      judge: async () => {
        judged++;
        return { pass: true, rationale: "looks right" };
      },
    });
    const g = create({
      checks: [
        { type: "file", path: "hello.txt" },
        { type: "llm", criterion: "the file greets the world" },
      ] as any,
      limits: { maxIterations: 3, checkIntervalSec: 10, hangSec: 0 },
    });
    await r2.tick();
    clock.t += 11_000;
    await r2.tick();
    expect(judged).toBe(0);
    writeFileSync(join(work, "hello.txt"), "HELLO");
    clock.t += 11_000;
    await r2.tick();
    expect(judged).toBe(1);
    expect(store.get(g.id)!.status).toBe("completed");
  });

  it("shell checks: exit code and timeout", async () => {
    mkdirSync(join(work, "sub"), { recursive: true });
    const g = create({
      checks: [
        { type: "shell", command: "test -f sub/ok" },
        { type: "shell", command: "sleep 5", timeoutSec: 1 },
      ] as any,
      limits: { maxIterations: 1 },
    });
    await runner.tick();
    writeFileSync(join(work, "sub", "ok"), "");
    exec.finish(0);
    await runner.tick();
    const r = store.get(g.id)!;
    expect(r.lastResults.c1.pass).toBe(true);
    expect(r.lastResults.c2.pass).toBe(false);
    expect(r.lastResults.c2.output).toContain("timed out");
    expect(r.status).toBe("exhausted");
    rmSync(work, { recursive: true, force: true });
  });

  it("claimsDone heuristic", () => {
    expect(claimsDone("All tests pass. Done.")).toBe(true);
    expect(claimsDone("I have completed the task")).toBe(true);
    expect(claimsDone("still working on it")).toBe(false);
  });
});

describe("visual goal checks", () => {
  it("normalizes a visual check and requires routes", () => {
    const [c] = normalizeChecks([
      { type: "visual", routes: ["/chat", " "], expectation: "chat renders" },
    ]);
    expect(c).toMatchObject({
      type: "visual",
      routes: ["/chat"],
      expectation: "chat renders",
      id: "c1",
    });
    expect(() => normalizeChecks([{ type: "visual", routes: [] }])).toThrow(
      /visual check needs routes/,
    );
  });
});

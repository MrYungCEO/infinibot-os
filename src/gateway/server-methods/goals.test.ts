import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalStore } from "../../autonomy/goals/store.js";
import { createGoalRunner, setGoalRunnerForTests } from "../../autonomy/goals/service.js";
import type { GoalExecutor } from "../../autonomy/goals/runner.js";

const work = mkdtempSync(join(tmpdir(), "goals-rpc-work-"));
const runs = new Map<string, { state: "running" | "exited"; exitCode: number | null }>();
let seq = 0;
const executor: GoalExecutor = {
  async start() {
    const runId = `r${++seq}`;
    runs.set(runId, { state: "running", exitCode: null });
    return { runId, sessionId: `s${seq}` };
  },
  async status(runId) {
    return runs.get(runId) ?? { state: "missing" };
  },
  async output() {
    return "Done.";
  },
  async kill(runId) {
    runs.set(runId, { state: "exited", exitCode: 143 });
  },
  supportsResume: () => true,
};

async function call(handlers: any, method: string, params: unknown) {
  let out: { ok: boolean; payload?: any; error?: any } = { ok: false };
  await handlers[method]({
    params,
    client: null,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      out = { ok, payload, error };
    },
  });
  return out;
}

describe("goals.* RPCs", () => {
  let handlers: any;
  beforeAll(async () => {
    const runner = createGoalRunner({
      store: new GoalStore(mkdtempSync(join(tmpdir(), "goals-rpc-state-"))),
      executor,
    });
    setGoalRunnerForTests(runner);
    handlers = (await import("./goals.js")).goalsHandlers;
  });

  it("validates params against the schema", async () => {
    const r = await call(handlers, "goals.create", { goal: "x", checks: [] });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("INVALID_PARAMS");
    const r2 = await call(handlers, "goals.create", {
      goal: "x",
      checks: [{ type: "bogus" }],
    });
    expect(r2.ok).toBe(false);
    const r3 = await call(handlers, "goals.create", {
      goal: "x",
      checks: [{ type: "shell" }],
    });
    expect(r3.error.message).toContain("needs a command");
  });

  it("create → list → get → recheck completes once checks pass", async () => {
    const created = await call(handlers, "goals.create", {
      goal: "make ok.txt",
      checks: [{ type: "file", path: "ok.txt" }],
      target: { kind: "cli", backend: "codex", model: "gpt-5" },
      workdir: work,
      limits: { maxIterations: 2 },
    });
    expect(created.ok).toBe(true);
    const id = created.payload.id;
    await new Promise((r) => setTimeout(r, 20));
    const list = await call(handlers, "goals.list", {});
    expect(list.payload.goals.map((g: any) => g.id)).toContain(id);
    const got = await call(handlers, "goals.get", { id });
    expect(got.payload.run.target).toEqual({ kind: "cli", backend: "codex", model: "gpt-5" });
    expect(got.payload.run.status).toBe("running");
    const miss = await call(handlers, "goals.recheck", { id });
    expect(miss.payload.allPass).toBe(false);
    writeFileSync(join(work, "ok.txt"), "ok");
    const hit = await call(handlers, "goals.recheck", { id });
    expect(hit.payload.allPass).toBe(true);
    expect(hit.payload.run.status).toBe("completed");
    expect(hit.payload.history.length).toBe(2);
  });

  it("pause / resume / continue / cancel / delete", async () => {
    const created = await call(handlers, "goals.create", {
      goal: "never",
      checks: [{ type: "file", path: "never.txt" }],
      target: { kind: "agent", agentId: "coder" },
      workdir: work,
    });
    const id = created.payload.id;
    await new Promise((r) => setTimeout(r, 20));
    expect((await call(handlers, "goals.pause", { id })).payload.run.status).toBe("paused");
    expect((await call(handlers, "goals.resume", { id })).payload.run.status).toBe("running");
    const cont = await call(handlers, "goals.continue", { id, instruction: "try harder" });
    expect(cont.payload.run.iterations.at(-1).prompt).toContain("try harder");
    expect((await call(handlers, "goals.delete", { id })).ok).toBe(false);
    expect((await call(handlers, "goals.cancel", { id })).payload.run.status).toBe("canceled");
    expect((await call(handlers, "goals.delete", { id })).ok).toBe(true);
    expect((await call(handlers, "goals.get", { id })).error.code).toBe("NOT_FOUND");
  });

  it("is registered, scoped and advertised", async () => {
    const { listGatewayMethods } = await import("../server-methods-list.js");
    const { coreGatewayHandlers } = await import("../server-methods.js");
    for (const m of [
      "goals.create",
      "goals.list",
      "goals.get",
      "goals.pause",
      "goals.resume",
      "goals.cancel",
      "goals.recheck",
      "goals.continue",
    ]) {
      expect(listGatewayMethods()).toContain(m);
      expect(coreGatewayHandlers[m]).toBeTypeOf("function");
    }
  });
});

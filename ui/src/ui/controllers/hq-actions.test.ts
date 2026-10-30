import { describe, expect, it, vi } from "vitest";
import type { KanbanTask } from "../types";
import type { HqDecision, HqObjectsState } from "./business-hq-objects";
import { askAgent, runPlan, type HqHost, type RpcClient } from "./hq-actions";
import { decisionItem, planAction, riskItem, taskItem } from "./hq-model";

const task = (id: string, extra: Partial<KanbanTask> = {}): KanbanTask =>
  ({ id, projectId: "p1", title: id, status: "todo", createdAt: 0, updatedAt: 0, ...extra }) as KanbanTask;

function objects(partial: Partial<HqObjectsState> = {}): HqObjectsState {
  return {
    loaded: true, loading: false, anyServed: true, errors: {},
    opportunities: [], products: [], decisions: [], ceoDecisions: [], risks: [], commitments: [], people: [], clients: [],
    ...partial,
  };
}

function fakeClient(impl: (method: string, params: unknown) => unknown): RpcClient & { calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    request: vi.fn(async (method: string, params: unknown) => {
      calls.push([method, params]);
      return impl(method, params);
    }),
  };
}

describe("runPlan", () => {
  it("applies the optimistic patch before the RPC resolves and keeps it on success", async () => {
    const host: HqHost = { kanbanTasks: [task("t1"), task("t2")], requestUpdate: vi.fn() };
    let seenDuringCall: string | undefined;
    const client = fakeClient(() => {
      seenDuringCall = host.kanbanTasks[0].status;
      return { ok: true };
    });
    const res = await runPlan(host, client, planAction("task.done", taskItem(host.kanbanTasks[0])), objects());
    expect(res.ok).toBe(true);
    expect(seenDuringCall).toBe("done"); // optimistic: UI already shows it
    expect(host.kanbanTasks[0]).toMatchObject({ status: "done", done: true });
    expect(client.calls).toEqual([["kanban.tasks.update", { id: "t1", patch: { status: "done", done: true } }]]);
  });

  it("rolls the task back to its exact prior state when the RPC fails", async () => {
    const before = [task("t1", { dueDate: "2026-09-01" }), task("t2")];
    const host: HqHost = { kanbanTasks: before, requestUpdate: vi.fn() };
    const client = fakeClient(() => {
      throw new Error("gateway offline");
    });
    const res = await runPlan(host, client, planAction("task.reschedule", taskItem(before[0]), { date: "2026-10-05" }), objects());
    expect(res).toMatchObject({ ok: false, error: "gateway offline" });
    expect(host.kanbanTasks).toEqual(before);
    expect(host.kanbanTasks[0]).toBe(before[0]); // the exact prior row object
    expect(host.kanbanTasks[0].dueDate).toBe("2026-09-01");
  });

  it("rolls back object stores (decision in both lists) on failure", async () => {
    const d = { id: "d1", title: "Pricing", status: "CEO Review" } as HqDecision;
    const objs = objects({ decisions: [d], ceoDecisions: [d] });
    const host: HqHost = { kanbanTasks: [] };
    const client = fakeClient(() => Promise.reject(new Error("nope")));
    const pending = runPlan(host, client, planAction("decision.decide", decisionItem(d), { option: "Raise 10%" }), objs);
    expect(objs.ceoDecisions[0].status).toBe("Decided"); // optimistic, synchronously
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(objs.decisions[0]).toBe(d);
    expect(objs.ceoDecisions[0]).toBe(d);
  });

  it("threads the previous step's result into the next (create → date the new task)", async () => {
    const host: HqHost = { kanbanTasks: [] };
    const client = fakeClient((method) => (method === "kanban.tasks.create" ? { id: "new-1" } : { ok: true }));
    const res = await runPlan(host, client, planAction("risk.mitigate", riskItem({ id: "r1", title: "Churn" } as never), { projectId: "p1", date: "2026-10-02" }), objects({ risks: [{ id: "r1" } as never] }));
    expect(res.ok).toBe(true);
    expect(client.calls[1]).toEqual(["kanban.tasks.update", { id: "new-1", patch: { dueDate: "2026-10-02" } }]);
    expect(client.calls[2][0]).toBe("risk.update");
  });

  it("stops at the first failing step and rolls back even after partial success", async () => {
    const d = { id: "r1", title: "Churn", status: "Open" };
    const objs = objects({ risks: [d as never] });
    const client = fakeClient((method) => {
      if (method === "risk.update") throw new Error("§27 owner required");
      return { id: "new-1" };
    });
    const res = await runPlan({ kanbanTasks: [] }, client, planAction("risk.mitigate", riskItem(d as never), { projectId: "p1" }), objs);
    expect(res.ok).toBe(false);
    expect(res.results).toHaveLength(2);
    expect(objs.risks[0]).toBe(d);
  });
});

describe("askAgent", () => {
  it("sends on a dedicated session, waits for the run and returns the last assistant text", async () => {
    const client = fakeClient((method) => {
      if (method === "chat.send") return { runId: "run-1", status: "started" };
      if (method === "agent.wait") return { status: "ok" };
      if (method === "chat.history")
        return { messages: [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "text", text: "Recommend: B" }] }] };
      return null;
    });
    await expect(askAgent(client, "q")).resolves.toBe("Recommend: B");
    expect((client.calls[0][1] as { sessionKey: string; deliver: boolean }).sessionKey).toBe("agent:main:hq-advisor");
    expect((client.calls[0][1] as { deliver: boolean }).deliver).toBe(false);
    expect(client.calls[1]).toEqual(["agent.wait", { runId: "run-1", timeoutMs: 90_000 }]);
  });

  it("surfaces a timeout as an error", async () => {
    const client = fakeClient((method) => (method === "chat.send" ? { runId: "r" } : { status: "timeout" }));
    await expect(askAgent(client, "q")).rejects.toThrow(/in time/);
  });
});

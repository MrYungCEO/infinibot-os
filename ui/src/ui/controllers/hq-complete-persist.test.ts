/**
 * Regression: a task / decision completed on the Dashboard ("Needs you",
 * "Operating Picture") must stay completed. It used to vanish and come back
 * a few seconds later when the post-write board reload (or the next poll,
 * or a Notion-backed list still carrying the old row) replaced state.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../app-view-state";
import type { KanbanTask } from "../types";
import { ceoDecisions, hqObjectsState, loadHqObjects, type HqDecision } from "./business-hq-objects";
import { runPlan, type RpcClient } from "./hq-actions";
import { decisionItem, planAction, taskItem } from "./hq-model";
import { loadKanban } from "./kanban";
import {
  applyPendingTaskWrites,
  PENDING_WRITE_TTL_MS,
  recordPendingTaskWrite,
  resetPendingTaskWrites,
} from "./kanban-pending-writes";

vi.mock("../plugin-host.js", () => ({ isTabAvailable: () => false }));

const task = (id: string, extra: Partial<KanbanTask> = {}): KanbanTask =>
  ({ id, projectId: "p1", title: id, status: "todo", done: false, createdAt: 0, updatedAt: 0, ...extra }) as KanbanTask;

/** A gateway whose task list is whatever `serverTasks` says right now. */
function fakeGateway(serverTasks: () => KanbanTask[], onUpdate?: (p: any) => unknown) {
  const request = vi.fn(async (method: string, params?: any) => {
    if (method === "kanban.projects.list") return [{ id: "p1", name: "Ops", createdAt: 0, updatedAt: 0 }];
    if (method === "kanban.tasks.list") return serverTasks().map((t) => ({ ...t }));
    if (method === "kanban.tasks.update") return onUpdate ? onUpdate(params) : { id: params.id, ...params.patch };
    throw new Error(`unexpected ${method}`);
  });
  return { request } as unknown as RpcClient & { request: typeof request };
}

function appState(client: RpcClient, tasks: KanbanTask[]): AppViewState {
  return {
    client,
    kanbanProjects: [],
    kanbanTasks: tasks,
    kanbanLoading: false,
    kanbanRefreshing: false,
    kanbanError: null,
    requestUpdate: vi.fn(),
  } as unknown as AppViewState;
}

const isDone = (t?: KanbanTask) => t?.status === "done" || t?.done === true;

describe("task completion survives reloads, polls and stale Notion reads", () => {
  beforeEach(() => resetPendingTaskWrites());

  it("complete → kanban:changed reload → next poll → Notion pull: stays done", async () => {
    // The gateway keeps serving the pre-write row (Notion list not caught up yet).
    let server = [task("t1", { title: "Sign off Q4 budget" }), task("t2")];
    const client = fakeGateway(() => server);
    const state = appState(client, server.map((t) => ({ ...t })));

    const res = await runPlan(state as never, client, planAction("task.done", taskItem(state.kanbanTasks[0])));
    expect(res.ok).toBe(true);
    expect(isDone(state.kanbanTasks.find((t) => t.id === "t1"))).toBe(true);

    await loadKanban(state); // kanban:changed reload
    expect(isDone(state.kanbanTasks.find((t) => t.id === "t1"))).toBe(true);
    await loadKanban(state); // next poll
    expect(isDone(state.kanbanTasks.find((t) => t.id === "t1"))).toBe(true);
    // Notion pull cycle: a fresh read that still lags behind the write.
    server = [task("t1", { title: "Sign off Q4 budget", notionStatus: "Not started" } as never), task("t2")];
    await loadKanban(state);
    expect(isDone(state.kanbanTasks.find((t) => t.id === "t1"))).toBe(true);
    expect(isDone(state.kanbanTasks.find((t) => t.id === "t2"))).toBe(false);

    // Once the server reports it done, the pending entry retires itself …
    server = [task("t1", { status: "done", done: true }), task("t2")];
    await loadKanban(state);
    // … so a later legitimate reopen elsewhere shows through.
    server = [task("t1"), task("t2")];
    await loadKanban(state);
    expect(isDone(state.kanbanTasks.find((t) => t.id === "t1"))).toBe(false);
  });

  it("a real failure restores the row and is reported (never a silent revert)", async () => {
    const server = [task("t1")];
    const client = fakeGateway(
      () => server,
      () => {
        throw new Error("Notion didn't save the change (Notion API 429)");
      },
    );
    const state = appState(client, server.map((t) => ({ ...t })));
    const res = await runPlan(state as never, client, planAction("task.done", taskItem(state.kanbanTasks[0])));
    expect(res).toMatchObject({ ok: false });
    expect(res.error).toMatch(/Notion/);
    expect(isDone(state.kanbanTasks[0])).toBe(false);
    await loadKanban(state);
    expect(isDone(state.kanbanTasks[0])).toBe(false); // nothing pending to re-apply
  });

  it("an older gateway's ok-with-notionSyncFailed counts as a failure", async () => {
    const server = [task("t1")];
    const client = fakeGateway(() => server, (p) => ({ id: p.id, ...p.patch, notionSyncFailed: true }));
    const state = appState(client, server.map((t) => ({ ...t })));
    const res = await runPlan(state as never, client, planAction("task.done", taskItem(state.kanbanTasks[0])));
    expect(res.ok).toBe(false);
    expect(isDone(state.kanbanTasks[0])).toBe(false);
  });

  it("pending writes match Notion ids with or without dashes and expire", () => {
    const now = 1_000_000;
    recordPendingTaskWrite("3f9f4bdd-9bcf-8113", { status: "done", done: true }, now);
    const rows = [task("3f9f4bdd9bcf8113")];
    expect(applyPendingTaskWrites(rows, now + 1000)[0]).toMatchObject({ status: "done", done: true });
    expect(applyPendingTaskWrites(rows, now + PENDING_WRITE_TTL_MS + 1)).toBe(rows);
  });

  it("the board's own cache (already patched) never retires a pending write", () => {
    const now = 2_000_000;
    recordPendingTaskWrite("t9", { status: "done", done: true }, now);
    // Page reload: the localStorage board cache holds the patched row …
    applyPendingTaskWrites([task("t9", { status: "done", done: true })], now + 10, { fromServer: false });
    // … then the gateway answers with the stale pre-write row.
    expect(applyPendingTaskWrites([task("t9")], now + 20)[0]).toMatchObject({ status: "done", done: true });
  });
});

describe("decisions decided from Needs you stay out of it", () => {
  const decided = { id: "d1", title: "Combine dashboards", status: "Decided", ceoRequired: true, priority: "P2" } as HqDecision;
  const open = { id: "d2", title: "Price change", status: "CEO Review", ceoRequired: true, priority: "P1" } as HqDecision;

  function serve(decisions: HqDecision[], queue: HqDecision[] | Error) {
    return {
      request: vi.fn(async (method: string) => {
        if (method === "decision.list") return { decisions };
        if (method === "decision.ceoQueue") {
          if (queue instanceof Error) throw queue;
          return { decisions: queue };
        }
        return {};
      }),
    };
  }

  it("an empty CEO queue means nothing is waiting — Decided decisions don't resurface", async () => {
    // Live data on 2026-10-14: ceoQueue = [], decision.list = one Decided ceoRequired decision.
    await loadHqObjects({ requestUpdate: vi.fn() } as never, serve([decided], []) as never);
    expect(ceoDecisions()).toEqual([]);
  });

  it("decide → re-list: gone; still gone after the next poll", async () => {
    await loadHqObjects({ requestUpdate: vi.fn() } as never, serve([open], [open]) as never);
    expect(ceoDecisions().map((d) => d.id)).toEqual(["d2"]);
    const client = { request: vi.fn(async () => ({ ...open, status: "Decided" })) };
    const res = await runPlan({ kanbanTasks: [] }, client, planAction("decision.decide", decisionItem(open), { option: "Raise" }));
    expect(res.ok).toBe(true);
    expect(ceoDecisions()).toEqual([]); // optimistic
    const after = { ...open, status: "Decided" };
    await loadHqObjects({ requestUpdate: vi.fn() } as never, serve([after], []) as never);
    expect(ceoDecisions()).toEqual([]);
    await loadHqObjects({ requestUpdate: vi.fn() } as never, serve([after], []) as never);
    expect(ceoDecisions()).toEqual([]);
  });

  it("falls back to deriving from decision.list only when the queue RPC failed — still open-only", async () => {
    await loadHqObjects({ requestUpdate: vi.fn() } as never, serve([decided, open], new Error("unknown method")) as never);
    expect(ceoDecisions().map((d) => d.id)).toEqual(["d2"]);
  });

  it("a list that started before a write re-lists instead of restoring the old row", async () => {
    let first = true;
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => (releaseFirst = r));
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "decision.ceoQueue" || method === "decision.list") {
          if (first) {
            await gate;
            return { decisions: method === "decision.ceoQueue" ? [open] : [open] };
          }
          return { decisions: [{ ...open, status: "Decided" }].filter((d) => method === "decision.list") };
        }
        return {};
      }),
    };
    const loading = loadHqObjects({ requestUpdate: vi.fn() } as never, client as never);
    await new Promise((r) => setTimeout(r, 5));
    hqObjectsState.decisions = [open];
    hqObjectsState.ceoDecisions = [open];
    await runPlan({ kanbanTasks: [] }, { request: async () => ({}) }, planAction("decision.decide", decisionItem(open), { option: "Raise" }));
    first = false;
    releaseFirst();
    await loading;
    expect(ceoDecisions()).toEqual([]);
  });
});

/**
 * Regression: drag a task to Done on the Dashboard / Projects board → it
 * showed Done, then "refreshed and reset". The board's own mutations didn't
 * record a pending write, and every live reload (`kanban:changed`) re-rendered
 * the pre-write localStorage copy before the server answered. Also covers the
 * versioned `kanban.task.updated` event (other tabs/devices) and the refetch
 * after a websocket reconnect.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppViewState } from "../app-view-state";
import type { KanbanTask } from "../types";
import { applyTaskUpdateEvent, deleteTask, handleTaskDrop, loadKanban, updateTask } from "./kanban";
import { runPlan } from "./hq-actions";
import { planAction, taskItem } from "./hq-model";
import { applyKnownVersions, recentlyAppliedTaskUpdate, resetKanbanLive } from "./kanban-live";
import { hasPendingTaskWrite, resetPendingTaskWrites } from "./kanban-pending-writes";

vi.mock("../plugin-host.js", () => ({ isTabAvailable: () => false }));

const task = (id: string, extra: Partial<KanbanTask> = {}): KanbanTask =>
  ({ id, projectId: "p1", title: id, status: "todo", done: false, createdAt: 0, updatedAt: 0, ...extra }) as KanbanTask;

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
}

function deferred<T = unknown>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function gateway(serverTasks: () => KanbanTask[], onUpdate: (p: any) => Promise<unknown> | unknown) {
  const request = vi.fn(async (method: string, params?: any) => {
    if (method === "kanban.projects.list") return [{ id: "p1", name: "Ops", createdAt: 0, updatedAt: 0 }];
    if (method === "kanban.tasks.list") return serverTasks().map((t) => ({ ...t }));
    if (method === "kanban.tasks.update") return onUpdate(params);
    if (method === "kanban.tasks.reorder") return { ok: true };
    throw new Error(`unexpected ${method}`);
  });
  return { request };
}

function appState(client: unknown, tasks: KanbanTask[]): AppViewState {
  return {
    client,
    kanbanProjects: [{ id: "p1", name: "Ops", createdAt: 0, updatedAt: 0 }],
    kanbanTasks: tasks,
    kanbanLoading: false,
    kanbanRefreshing: false,
    kanbanError: null,
    requestUpdate: vi.fn(),
  } as unknown as AppViewState;
}

const statusOf = (s: AppViewState, id: string) => s.kanbanTasks.find((t) => t.id === id)?.status;

describe("board drag / status change survives live reloads", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemStorage());
    resetPendingTaskWrites();
    resetKanbanLive();
  });

  it("drag to Done: a kanban:changed reload during the write (stale list + stale cache) keeps it Done", async () => {
    const server = [task("t1"), task("t2")];
    const write = deferred();
    const client = gateway(() => server, () => write.promise);
    const state = appState(client, server.map((t) => ({ ...t })));
    await loadKanban(state); // board shown; localStorage copy now holds t1 = todo

    const drop = handleTaskDrop(state, "t1", "done", 0);
    expect(statusOf(state, "t1")).toBe("done");
    expect(hasPendingTaskWrite("t1")).toBe(true); // recorded BEFORE the request

    // Another write's kanban:changed reloads while ours is in flight: the
    // server still has the old row and the cold-start cache is stale.
    const seen: Array<string | undefined> = [];
    (state.requestUpdate as any).mockImplementation(() => seen.push(statusOf(state, "t1")));
    await loadKanban(state);
    expect(seen.every((s) => s === "done")).toBe(true); // never flashed back to todo
    expect(statusOf(state, "t1")).toBe("done");

    write.resolve({ id: "t1", status: "done", done: true, version: 5, syncPending: true });
    await drop;
    for (let i = 0; i < 2; i++) {
      await loadKanban(state); // next reloads / polls, server still lagging
      expect(statusOf(state, "t1")).toBe("done");
    }
    // Server catches up → pending write retires.
    server[0] = task("t1", { status: "done", done: true });
    await loadKanban(state);
    expect(hasPendingTaskWrite("t1")).toBe(false);
    expect(statusOf(state, "t1")).toBe("done");
  });

  it("a failed drag reverts only that card and drops the pending write", async () => {
    const server = [task("t1"), task("t2", { status: "review" })];
    const client = gateway(() => server, () => {
      throw new Error("gateway offline");
    });
    const state = appState(client, server.map((t) => ({ ...t })));
    await handleTaskDrop(state, "t1", "done", 0);
    expect(statusOf(state, "t1")).toBe("todo");
    expect(statusOf(state, "t2")).toBe("review");
    expect(hasPendingTaskWrite("t1")).toBe(false);
    expect(state.kanbanError).toMatch(/offline/);
  });

  it("status select / modal (updateTask): moving off Done clears done and stays through reloads", async () => {
    const server = [task("t1", { status: "done", done: true })];
    const client = gateway(() => server, (p) => ({ id: p.id, ...p.patch, version: 7 }));
    const state = appState(client, server.map((t) => ({ ...t })));
    await updateTask(state, "t1", { status: "in_progress" });
    expect(state.kanbanTasks[0]).toMatchObject({ status: "in_progress", done: false });
    expect(client.request).toHaveBeenCalledWith("kanban.tasks.update", {
      id: "t1",
      patch: { status: "in_progress", done: false },
    });
    await loadKanban(state); // stale server row (still done)
    expect(state.kanbanTasks[0]).toMatchObject({ status: "in_progress", done: false });
  });

  it("status menu / task modal select (updateTask → Done): a reload while the save is in flight keeps Done", async () => {
    // Context menu (views/kanban.ts:2085) and modal selects (:4065, :5339) all call
    // props.onUpdateTask → controllers/kanban.ts updateTask.
    const server = [task("t1", { status: "review" }), task("t2")];
    const write = deferred();
    const client = gateway(() => server, () => write.promise);
    const state = appState(client, server.map((t) => ({ ...t })));
    const p = updateTask(state, "t1", { status: "done" });
    expect(state.kanbanTasks[0]).toMatchObject({ status: "done", done: true });
    await loadKanban(state); // kanban:changed / Refresh during the request; server still stale
    expect(state.kanbanTasks[0]).toMatchObject({ status: "done", done: true });
    write.resolve({ id: "t1", status: "done", done: true, version: 9 });
    await p;
    await loadKanban(state);
    expect(state.kanbanTasks[0]).toMatchObject({ status: "done", done: true });
  });

  it("HQ bulk Done (sequential runPlan): a reload between plans keeps every completed row", async () => {
    const server = [task("a"), task("b"), task("c")];
    const gates = [deferred(), deferred(), deferred()];
    let n = 0;
    const client = gateway(() => server, () => gates[n++].promise);
    const state = appState(client, server.map((t) => ({ ...t })));
    const bulk = (async () => {
      for (const id of ["a", "b", "c"]) {
        const r = await runPlan(state as never, client as never, planAction("task.done", taskItem(state.kanbanTasks.find((t) => t.id === id)!)));
        expect(r.ok).toBe(true);
      }
    })();
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await loadKanban(state); // the previous plan's kanban:changed reload lands mid-flight
      for (const id of ["a", "b", "c"].slice(0, i + 1)) expect(statusOf(state, id)).toBe("done");
      gates[i].resolve({ ok: true });
    }
    await bulk;
    await loadKanban(state);
    expect(state.kanbanTasks.map((t) => t.status)).toEqual(["done", "done", "done"]);
  });

  it("a live reload never re-renders the cold-start localStorage copy", async () => {
    const server = [task("t1")];
    const list = deferred<KanbanTask[]>();
    const client = {
      request: vi.fn(async (m: string) => {
        if (m === "kanban.projects.list") return [{ id: "p1", name: "Ops" }];
        if (m === "kanban.tasks.list") return list.promise;
        return null;
      }),
    };
    localStorage.setItem(
      "kanban-data-cache-v2",
      JSON.stringify({ ts: Date.now(), projects: [], tasks: [task("t1", { title: "OLD" })] }),
    );
    const state = appState(client, [task("t1", { title: "NOW", status: "done", done: true })]);
    const p = loadKanban(state);
    expect(state.kanbanTasks[0].title).toBe("NOW");
    list.resolve(server.map((t) => ({ ...t, title: "NOW", status: "done", done: true })));
    await p;
    expect(state.kanbanTasks[0].title).toBe("NOW");
  });
});

describe("kanban.task.updated (other tabs / devices / agents)", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemStorage());
    resetPendingTaskWrites();
    resetKanbanLive();
  });

  it("patches the row in place; older versions are ignored", () => {
    const state = appState({ request: vi.fn() }, [task("t1"), task("t2")]);
    expect(applyTaskUpdateEvent(state, { id: "t1", fields: { status: "done", done: true }, version: 10, source: "agent" })).toBe(true);
    expect(state.kanbanTasks[0]).toMatchObject({ status: "done", done: true, version: 10 });
    expect(recentlyAppliedTaskUpdate("t1")).toBe(true);
    // A late, older event (reordered delivery) can't undo it.
    expect(applyTaskUpdateEvent(state, { id: "t1", fields: { status: "todo", done: false }, version: 9 })).toBe(false);
    expect(state.kanbanTasks[0].status).toBe("done");
    expect(state.requestUpdate).toHaveBeenCalled();
  });

  it("matches dashed / undashed Notion ids", () => {
    const state = appState({ request: vi.fn() }, [task("3bcf4bdd-9bcf-81e0")]);
    applyTaskUpdateEvent(state, { id: "3bcf4bdd9bcf81e0", fields: { status: "review" }, version: 3 });
    expect(state.kanbanTasks[0].status).toBe("review");
  });

  it("a list read before the event doesn't overwrite it", () => {
    const current = [task("t1", { status: "done", done: true, version: 10 } as never)];
    applyTaskUpdateEvent(appState({}, current), { id: "t1", fields: { status: "done", done: true }, version: 10 });
    const staleList = [task("t1")];
    expect(applyKnownVersions(staleList, current)[0].status).toBe("done");
    // …but only briefly: later lists are trusted (the gateway ledger guards them).
    expect(applyKnownVersions(staleList, current, Date.now() + 61_000)[0].status).toBe("todo");
  });

  it("the event confirms a pending write", async () => {
    const write = deferred();
    const state = appState(gateway(() => [], () => write.promise), [task("t1")]);
    const p = updateTask(state, "t1", { status: "done" });
    expect(hasPendingTaskWrite("t1")).toBe(true);
    applyTaskUpdateEvent(state, { id: "t1", fields: { status: "done", done: true, notionStatus: "Done" }, version: 4 });
    expect(hasPendingTaskWrite("t1")).toBe(false);
    write.resolve({ id: "t1", status: "done", done: true, version: 4 });
    await p;
    expect(state.kanbanTasks[0].status).toBe("done");
  });

  it("a delete event from another tab/agent removes the card, and a stale list can't bring it back", () => {
    const state = appState({ request: vi.fn() }, [task("t1"), task("t2")]);
    applyTaskUpdateEvent(state, { id: "t1", fields: { deleted: true }, version: 20, source: "ui" });
    expect(state.kanbanTasks.map((t) => t.id)).toEqual(["t2"]);
    expect(applyKnownVersions([task("t1"), task("t2")], state.kanbanTasks).map((t) => t.id)).toEqual(["t2"]);
  });
});

describe("board delete", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemStorage());
    resetPendingTaskWrites();
    resetKanbanLive();
  });

  it("goes through kanban.tasks.delete (cache eviction + broadcast) and survives a stale reload", async () => {
    const server = [task("t1"), task("t2")];
    const del = deferred();
    const request = vi.fn(async (method: string) => {
      if (method === "kanban.projects.list") return [{ id: "p1", name: "Ops" }];
      if (method === "kanban.tasks.list") return server.map((t) => ({ ...t })); // still lists t1
      if (method === "kanban.tasks.delete") return del.promise;
      throw new Error(`unexpected ${method}`);
    });
    const state = appState({ request }, server.map((t) => ({ ...t })));
    const p = deleteTask(state, "t1");
    expect(request).toHaveBeenCalledWith("kanban.tasks.delete", { id: "t1" });
    await loadKanban(state); // reload while the delete is in flight
    expect(state.kanbanTasks.map((t) => t.id)).toEqual(["t2"]);
    del.resolve({ deleted: true });
    await p;
    await loadKanban(state);
    expect(state.kanbanTasks.map((t) => t.id)).toEqual(["t2"]);
  });

  it("a failed delete puts the card back", async () => {
    const request = vi.fn(async () => {
      throw new Error("gateway offline");
    });
    const state = appState({ request }, [task("t1"), task("t2")]);
    await deleteTask(state, "t1");
    expect(state.kanbanTasks.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    expect(state.kanbanError).toMatch(/offline/);
  });
});

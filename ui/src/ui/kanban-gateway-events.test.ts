/** Gateway wiring for live board updates: event → in-place patch, reconnect → refetch. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./plugin-host.js", () => ({
  isTabAvailable: () => false,
  openedAtRoot: () => false,
  pluginLanding: () => null,
  syncPluginHost: () => undefined,
}));

const { handleGatewayEvent, refetchKanbanAfterReconnect } = await import("./app-gateway");
const { resetKanbanLive } = await import("./controllers/kanban-live");

const flush = () => new Promise((r) => setTimeout(r, 0));
async function until(fn: () => boolean, ms = 2_000) {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
}

function host(tasks: any[], request = vi.fn(async () => [])) {
  return {
    tab: "dashboard",
    eventLogBuffer: [],
    connected: true,
    client: { request },
    kanbanProjects: [{ id: "p1", name: "Ops" }],
    kanbanTasks: tasks,
    kanbanLoading: false,
    requestUpdate: vi.fn(),
  } as any;
}

describe("kanban realtime gateway wiring", () => {
  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    resetKanbanLive();
  });

  it("kanban.task.updated patches the dashboard board within a tick, no reload", async () => {
    const h = host([{ id: "t1", status: "todo", done: false, projectId: "p1" }]);
    const seen: unknown[] = [];
    (window as unknown as EventTarget).addEventListener("kanban-task-updated", (e) => seen.push((e as CustomEvent).detail));
    handleGatewayEvent(h, {
      type: "event",
      event: "kanban.task.updated",
      payload: { id: "t1", fields: { status: "done", done: true }, version: 2, source: "ui" },
    } as any);
    await until(() => h.kanbanTasks[0].status === "done");
    expect(h.kanbanTasks[0]).toMatchObject({ status: "done", done: true });
    expect(seen).toHaveLength(1);
    // The kanban:changed that follows the same write doesn't trigger a full reload.
    handleGatewayEvent(h, { type: "event", event: "kanban:changed", payload: { entity: "task", op: "update", id: "t1" } } as any);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.client.request).not.toHaveBeenCalled();
  });

  it("reconnect refetches a board that was showing (missed events)", async () => {
    const request = vi.fn(async (m: string) => (m === "kanban.tasks.list" ? [{ id: "t1", status: "done", done: true }] : []));
    const h = host([{ id: "t1", status: "todo" }], request);
    refetchKanbanAfterReconnect(h);
    await until(() => h.kanbanTasks[0].status === "done");
    expect(request).toHaveBeenCalledWith("kanban.tasks.list");
    expect(h.kanbanTasks[0].status).toBe("done");
  });

  it("no board loaded yet → no refetch", async () => {
    const h = host([]);
    refetchKanbanAfterReconnect(h);
    await flush();
    expect(h.client.request).not.toHaveBeenCalled();
  });

  it("hq.object.changed re-lists the HQ object stores on the dashboard", async () => {
    const request = vi.fn(async () => ({}));
    const h = host([], request);
    handleGatewayEvent(h, { type: "event", event: "hq.object.changed", payload: { kind: "commitment", op: "update", id: "c1" } } as any);
    await until(() => request.mock.calls.some((c: any[]) => c[0] === "commitment.list"));
    expect(request.mock.calls.map((c: any[]) => c[0])).toContain("commitment.list");
  });
});

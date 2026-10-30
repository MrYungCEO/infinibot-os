/**
 * Regression: completing a task from the dashboard must stay completed.
 *
 * Live symptom: "Needs you" / "Operating Picture" → mark done → the row
 * vanished for ~4 s and then came back. The dashboard reloads the board on
 * `kanban:changed`; `kanban.tasks.list` (Notion-backed, stale-while-revalidate)
 * served a list fetched before the write — either a refresh that started
 * before the PATCH and landed after it, or a wedged in-flight refresh that
 * never settled. These tests drive the real handlers against a fake Notion.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let stateDir: string;

vi.mock("../../config/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/paths.js")>();
  return { ...actual, resolveStateDir: () => stateDir };
});
vi.mock("../../federation/satellite-context.js", () => ({
  getConnectedSatellite: () => null,
  proxyToMaster: async () => ({ success: false }),
  proxyMethodsToMaster: (handlers: unknown) => handlers,
}));
vi.mock("../../databases/notion-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../databases/notion-config.js")>();
  return {
    ...actual,
    getNotionConfig: () => ({ syncMode: "mirror", apiKey: "secret_test" }),
    getNotionApiKeyOrNull: () => "secret_test",
    resolveNotionDbId: (role: string) => (role === "kanban-tasks" ? "db-tasks" : "db-projects"),
  };
});
vi.mock("../../databases/notion-option-map.js", () => ({
  sanitizeNotionPageWrite: async (_k: string, _p: string, _m: string, body: string) => body,
}));
vi.mock("../../databases/kanban-store-ops.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../databases/kanban-store-ops.js")>();
  return {
    ...actual,
    resolveKanbanId: (_kind: string, id: string) => ({ where: "notion", notionId: id }),
    listNotionPendingTasks: () => [],
    isNotionCircuitOpen: () => false,
    tripNotionCircuit: () => {},
    listProjects: () => [],
  };
});
const localTasks = new Map<string, Record<string, unknown>>();
vi.mock("../../tasks/store.js", () => ({
  getKanbanStore: () => ({
    getTasks: async () => [...localTasks.values()],
    deleteTask: async (id: string) => localTasks.delete(id),
    updateTask: async (id: string, f: Record<string, unknown>) => {
      localTasks.set(id, { ...localTasks.get(id), ...f });
    },
    createTask: async (t: Record<string, unknown>) => {
      localTasks.set(String(t.id), t);
    },
  }),
}));

// ── Fake Notion ────────────────────────────────────────────────────────────
type Page = {
  id: string;
  status: string;
  done: boolean;
  edited?: string;
  archived?: boolean;
  in_trash?: boolean;
};
let pages: Page[];
/** What `databases/:id/query` sees (lags behind writes when `indexLag`). */
let indexed: Page[];
let indexLag = false;
let patchFails = false;
let queryGate: Promise<void> | null = null;

function toNotion(p: Page) {
  return {
    id: p.id,
    archived: p.archived === true,
    in_trash: p.in_trash === true,
    created_time: "2026-10-14T00:00:00.000Z",
    last_edited_time: p.edited ?? "2026-10-14T00:00:00.000Z",
    properties: {
      "Task Name": { title: [{ plain_text: `Task ${p.id}` }] },
      "Status Update": { status: { name: p.status } },
      Done: { checkbox: p.done },
      Project: { relation: [{ id: "proj-1" }] },
    },
  };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.includes("/databases/db-tasks/query")) {
    const snapshot = (indexLag ? indexed : pages).map((p) => ({ ...p }));
    if (queryGate) await queryGate;
    return json({ results: snapshot.map(toNotion), has_more: false, next_cursor: null });
  }
  const m = url.match(/\/pages\/([^/?]+)$/);
  if (m) {
    const page = pages.find((p) => p.id === m[1]);
    if (!page) return json({ message: "not found" }, 404);
    if (method === "PATCH") {
      if (patchFails) return json({ message: "rate limited" }, 429);
      const props = JSON.parse(init?.body as string).properties ?? {};
      if (props["Status Update"]) page.status = props["Status Update"].status.name;
      if (props.Done) page.done = props.Done.checkbox;
      const body = JSON.parse(init?.body as string);
      if (body.archived === true) page.archived = true;
    }
    return json(toNotion(page));
  }
  return json({ message: `unexpected ${method} ${url}` }, 400);
}

// ── Harness ────────────────────────────────────────────────────────────────
type Handlers = Record<string, (opts: unknown) => unknown>;
let h: Handlers;
let mod: typeof import("./kanban.js");
const broadcasts: string[] = [];
/** Gateway-wide events (kanban-events bridge): `kanban.task.updated` etc. */
const events: Array<{ event: string; payload: any }> = [];

async function loadHandlers() {
  vi.resetModules();
  mod = await import("./kanban.js");
  const ev = await import("../../tasks/kanban-events.js");
  ev.setKanbanEventBroadcaster((event, payload) => events.push({ event, payload }));
  h = mod.kanbanHandlers as unknown as Handlers;
}
const taskUpdates = (id: string) =>
  events
    .filter((e) => e.event === "kanban.task.updated" && e.payload.id === id)
    .map((e) => e.payload);

function call(method: string, params: Record<string, unknown> = {}) {
  return new Promise<{ ok: boolean; data?: any; error?: any }>((resolve) => {
    void h[method]({
      params,
      client: { connId: "owner-tab" },
      context: { broadcast: (ev: string) => broadcasts.push(ev) },
      respond: (ok: boolean, data?: unknown, error?: unknown) => resolve({ ok, data, error }),
    });
  });
}
async function statusOf(id: string): Promise<string | undefined> {
  const r = await call("kanban.tasks.list");
  return (r.data as Array<{ id: string; status: string }>).find((t) => t.id === id)?.status;
}

describe("dashboard completion persists across list refreshes (Notion-backed)", () => {
  beforeEach(async () => {
    stateDir = mkdtempSync(join(tmpdir(), "kanban-persist-"));
    pages = [
      { id: "task-a", status: "Not started", done: false },
      { id: "task-b", status: "In progress", done: false },
    ];
    indexed = pages.map((p) => ({ ...p }));
    indexLag = false;
    patchFails = false;
    queryGate = null;
    localTasks.clear();
    broadcasts.length = 0;
    events.length = 0;
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    await loadHandlers();
  });
  afterEach(async () => {
    await mod.kanbanTaskPushesIdle();
    mod.resetKanbanTaskPusherForTests();
    vi.unstubAllGlobals();
  });

  it("complete → next poll → Notion re-read: the task stays done", async () => {
    expect(await statusOf("task-a")).toBe("todo"); // dashboard's first load primes the cache
    const r = await call("kanban.tasks.update", {
      id: "task-a",
      patch: { status: "done", done: true },
    });
    expect(r.ok).toBe(true);
    expect(r.data.status).toBe("done");
    expect(broadcasts).toContain("kanban:task:completed");
    // The kanban:changed reload (next poll) and every read after it.
    expect(await statusOf("task-a")).toBe("done");
    expect(await statusOf("task-a")).toBe("done");
    expect(await statusOf("task-b")).toBe("in_progress"); // other rows untouched
  });

  it("a refresh that read Notion BEFORE the write and lands after it can't bring the task back", async () => {
    expect(await statusOf("task-a")).toBe("todo");
    // Another write dirties the list; the refresh it triggers reads Notion now
    // (pre-write) but is slow to return.
    await call("kanban.tasks.update", { id: "task-b", patch: { title: "renamed" } });
    let release!: () => void;
    queryGate = new Promise<void>((r) => (release = r));
    const slowRead = call("kanban.tasks.list");
    await new Promise((r) => setTimeout(r, 10)); // the query snapshot is taken
    const done = await call("kanban.tasks.update", {
      id: "task-a",
      patch: { status: "done", done: true },
    });
    expect(done.ok).toBe(true);
    queryGate = null;
    release();
    await slowRead;
    expect(await statusOf("task-a")).toBe("done");
  });

  it("Notion's query index lagging behind the write doesn't revert it (Notion pull cycle)", async () => {
    expect(await statusOf("task-a")).toBe("todo");
    indexLag = true; // queries keep returning the pre-write row
    await call("kanban.tasks.update", { id: "task-a", patch: { status: "done", done: true } });
    for (let i = 0; i < 3; i++) expect(await statusOf("task-a")).toBe("done");
    // Once the index catches up the source agrees on its own.
    indexed = pages.map((p) => ({ ...p }));
    indexLag = false;
    expect(await statusOf("task-a")).toBe("done");
  });

  it("a failed Notion write stays (local wins, sync pending) and is retried until it lands", async () => {
    expect(await statusOf("task-a")).toBe("todo");
    patchFails = true;
    const r = await call("kanban.tasks.update", {
      id: "task-a",
      patch: { status: "done", done: true },
    });
    expect(r.ok).toBe(true);
    expect(r.data.syncPending).toBe(true);
    await mod.kanbanTaskPushesIdle();
    expect(pages[0].status).toBe("Not started"); // Notion refused it…
    expect(await statusOf("task-a")).toBe("done"); // …the board still shows it
    const failed = taskUpdates("task-a").at(-1);
    expect(failed.syncPending).toBe(true);
    expect(failed.syncError).toMatch(/429/);
    patchFails = false;
    await new Promise((res) => setTimeout(res, 1_100)); // first retry backoff
    await mod.kanbanTaskPushesIdle();
    expect(pages[0]).toMatchObject({ status: "Done", done: true });
    expect(taskUpdates("task-a").at(-1).syncPending).toBe(false);
    expect(await statusOf("task-a")).toBe("done");
  });

  it("reopening after completing shows the reopened state", async () => {
    await statusOf("task-a");
    await call("kanban.tasks.update", { id: "task-a", patch: { status: "done", done: true } });
    await call("kanban.tasks.update", { id: "task-a", patch: { status: "todo", done: false } });
    expect(await statusOf("task-a")).toBe("todo");
  });

  it("answers at once and broadcasts a versioned kanban.task.updated per write", async () => {
    await statusOf("task-a");
    const r1 = await call("kanban.tasks.update", {
      id: "task-a",
      patch: { status: "in_progress" },
    });
    const r2 = await call("kanban.tasks.update", { id: "task-a", patch: { status: "done" } });
    expect(r2.data.version).toBeGreaterThan(r1.data.version);
    const ups = taskUpdates("task-a");
    expect(ups[0]).toMatchObject({ fields: { status: "in_progress", done: false }, source: "ui" });
    expect(ups.some((u) => u.fields.status === "done" && u.version === r2.data.version)).toBe(true);
    expect(events.some((e) => e.event === "kanban:changed")).toBe(true);
    await mod.kanbanTaskPushesIdle();
    expect(pages[0]).toMatchObject({ status: "Done", done: true });
  });

  it("moving a task off Done clears Notion's Done checkbox (no bounce back to Done)", async () => {
    await statusOf("task-a");
    await call("kanban.tasks.update", { id: "task-a", patch: { status: "done" } });
    await mod.kanbanTaskPushesIdle();
    await call("kanban.tasks.update", { id: "task-a", patch: { status: "in_progress" } });
    await mod.kanbanTaskPushesIdle();
    expect(pages[0]).toMatchObject({ status: "In progress", done: false });
    expect(await statusOf("task-a")).toBe("in_progress");
  });

  it("an older Notion pull can't overwrite the newer local write, however long it lags", async () => {
    expect(await statusOf("task-a")).toBe("todo");
    indexLag = true; // every query keeps returning the pre-write row
    await call("kanban.tasks.update", { id: "task-a", patch: { status: "done" } });
    await mod.kanbanTaskPushesIdle();
    // Well past the list cache's 60 s overlay grace: the ledger still guards it.
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 5 * 60_000);
    try {
      for (let i = 0; i < 3; i++) expect(await statusOf("task-a")).toBe("done");
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
  });

  it("a genuinely newer remote edit (later minute in Notion) wins and is broadcast", async () => {
    await statusOf("task-a");
    await call("kanban.tasks.update", { id: "task-a", patch: { status: "done" } });
    await mod.kanbanTaskPushesIdle();
    // Someone reopens it in Notion two minutes later.
    pages[0].status = "In progress";
    pages[0].done = false;
    pages[0].edited = new Date(Date.now() + 2 * 60_000).toISOString();
    events.length = 0;
    // Force a source read (TTL expiry → background refresh).
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 3 * 60_000);
    try {
      await statusOf("task-a"); // stale serve, refresh starts
      await new Promise((res) => setTimeout(res, 20));
      expect(await statusOf("task-a")).toBe("in_progress");
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
    const remote = taskUpdates("task-a").find((u) => u.source === "notion");
    expect(remote?.fields.status).toBe("in_progress");
  });

  it("a write still pending at restart is pushed by the next gateway process", async () => {
    await statusOf("task-a");
    patchFails = true;
    await call("kanban.tasks.update", { id: "task-a", patch: { status: "done" } });
    await mod.kanbanTaskPushesIdle();
    mod.resetKanbanTaskPusherForTests();
    const ev = await import("../../tasks/kanban-events.js");
    ev.getKanbanWriteLedger().flush();
    // "Restart": fresh modules, same state dir.
    patchFails = false;
    await loadHandlers();
    expect(await statusOf("task-a")).toBe("done"); // ledger reloaded from disk
    mod.resumeKanbanTaskPushes();
    await new Promise((res) => setTimeout(res, 10));
    await mod.kanbanTaskPushesIdle();
    expect(pages[0]).toMatchObject({ status: "Done", done: true });
  });

  it("a deleted task leaves every list at once, even while Notion's query still returns it", async () => {
    expect(await statusOf("task-a")).toBe("todo"); // cached board
    localTasks.set("local-a", { id: "local-a", notionId: "task-a", status: "todo" });
    indexLag = true; // Notion's query keeps returning the page for a while
    const r = await call("kanban.tasks.delete", { id: "task-a" });
    expect(r).toMatchObject({ ok: true, data: { deleted: true } });
    expect(pages[0].archived).toBe(true);
    expect(await statusOf("task-a")).toBeUndefined(); // cached list
    const realNow = Date.now;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 2 * 60_000);
    try {
      await statusOf("task-a"); // TTL → refresh from the lagging Notion query
      await new Promise((res) => setTimeout(res, 20));
      expect(await statusOf("task-a")).toBeUndefined();
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
    expect(localTasks.has("local-a")).toBe(false); // local mirror row gone too
    expect(taskUpdates("task-a").at(-1)).toMatchObject({ fields: { deleted: true } });
    expect(events.some((e) => e.event === "kanban:changed" && e.payload.op === "delete")).toBe(
      true,
    );
    // A late write to the deleted task can't resurrect it.
    await call("kanban.tasks.update", { id: "task-a", patch: { status: "done" } });
    expect(await statusOf("task-a")).toBeUndefined();
  });

  it("the Notion pull never lists archived / trashed pages", async () => {
    pages.push({ id: "task-trash", status: "Done", done: true, in_trash: true });
    pages.push({ id: "task-arch", status: "Not started", done: false, archived: true });
    indexed = pages.map((p) => ({ ...p }));
    const r = await call("kanban.tasks.list");
    const ids = (r.data as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toContain("task-a");
    expect(ids).not.toContain("task-trash");
    expect(ids).not.toContain("task-arch");
  });
});

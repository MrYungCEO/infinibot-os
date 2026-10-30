/**
 * Focus works without Notion: kanban items resolve from the local store, a
 * Notion outage never blocks adding, and focus.sync never drops items just
 * because Notion errored (it only removes on a definite "not found").
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let stateDir: string;
const originalEnv = { ...process.env };

const { setFocusStateDir, loadFocusStore, saveFocusStore } = await import("./focus-store.js");
const { createFocusHandlers } = await import("./focus-rpc.js");
const handlers = createFocusHandlers();

async function call(method: string, params: Record<string, unknown>) {
  let reply: { ok: boolean; payload?: any; error?: any } | undefined;
  await handlers[method]!({
    params,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      reply = { ok, payload, error };
    },
  } as any);
  return reply!;
}

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "focus-notion-optional-"));
  process.env.HOME = stateDir;
  process.env.INFINIBOT_STATE_DIR = stateDir;
  process.env.MOLTBOT_STATE_DIR = stateDir;
  delete process.env.NOTION_API_KEY;
  setFocusStateDir(() => stateDir);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  rmSync(stateDir, { recursive: true, force: true });
});

describe("focus without Notion", () => {
  it("adds a local kanban task and project with no Notion configured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const ops = await import("../../../src/databases/kanban-store-ops.js");
    const project = ops.upsertProject({ name: "Local focus project" });
    const task = ops.upsertTask({ title: "Local focus task", projectId: project.id });

    const t = await call("discipline.focus.add.task", { taskId: task.id });
    expect(t.ok).toBe(true);
    expect(t.payload.item.title).toBe("Local focus task");
    expect(t.payload.item.projectName).toBe("Local focus project");

    const p = await call("discipline.focus.add.project", { projectId: project.id });
    expect(p.ok).toBe(true);
    expect(p.payload.item.title).toBe("Local focus project");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Notion erroring: add still succeeds and sync keeps every item", async () => {
    process.env.NOTION_API_KEY = "secret_test_only";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "boom" }), { status: 500 })),
    );
    const notionTaskId = "aaaaaaaa-bbbb-cccc-dddd-000000000001";
    const added = await call("discipline.focus.add.task", {
      taskId: notionTaskId,
      title: "From the board",
    });
    expect(added.ok).toBe(true);
    expect(added.payload.item.title).toBe("From the board");

    const before = loadFocusStore().items.length;
    const synced = await call("discipline.focus.sync", {});
    expect(synced.ok).toBe(true);
    expect(synced.payload.removed).toBe(0);
    expect(loadFocusStore().items).toHaveLength(before);
  });

  it("sync removes an item only when Notion says it is gone (404)", async () => {
    process.env.NOTION_API_KEY = "secret_test_only";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ message: "Could not find page" }), { status: 404 }),
      ),
    );
    const store = loadFocusStore();
    store.items = [
      {
        id: "aaaaaaaa-bbbb-cccc-dddd-000000000002",
        type: "task",
        title: "Deleted in Notion",
        description: "",
        status: "",
        priority: 1,
        addedAt: Date.now(),
      } as any,
    ];
    saveFocusStore(store);
    const synced = await call("discipline.focus.sync", {});
    expect(synced.payload.removed).toBe(1);
  });
});

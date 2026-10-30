/**
 * kanban.tasks.update → Business HQ progress log: the `source` param and the
 * burst heuristic. A maintenance script that closed 937 stale tasks used to
 * read as "939 cleared this week"; bulk completions must be logged (auditable)
 * but never counted.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

let stateDir: string;
const upserts: Array<Record<string, unknown>> = [];

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
    getNotionConfig: () => ({ syncMode: "off", apiKey: null }),
    getNotionApiKeyOrNull: () => null,
  };
});

vi.mock("../../databases/kanban-store-ops.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../databases/kanban-store-ops.js")>();
  return {
    ...actual,
    upsertTask: (task: Record<string, unknown>) => {
      upserts.push(task);
      return { projectId: "p1", title: `Task ${String(task.id)}`, ...task };
    },
    listProjects: () => [],
  };
});

type Handlers = Record<string, (opts: unknown) => unknown>;

async function loadHandlers(): Promise<Handlers> {
  return (await import("./kanban.js")).kanbanHandlers as unknown as Handlers;
}

function call(
  handlers: Handlers,
  params: Record<string, unknown>,
  connId: string | null = "c1",
  info?: { id: string; mode: string },
): Promise<{ ok: boolean; data?: any; error?: any }> {
  return new Promise((resolve) => {
    void handlers["kanban.tasks.update"]({
      params,
      client: connId ? { connId, ...(info ? { connect: { client: info } } : {}) } : null,
      context: { broadcast: () => {} },
      respond: (ok: boolean, data?: unknown, error?: unknown) => resolve({ ok, data, error }),
    });
  });
}

function events(): Array<{ objectId: string; bulk?: boolean; origin?: string; bulkReason?: string }> {
  const file = join(stateDir, "hq-progress.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).events : [];
}

describe("kanban.tasks.update → hq progress", () => {
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "kanban-hq-"));
    upserts.length = 0;
    vi.resetModules();
  });

  it('source:"bulk" is logged but marked bulk, and is not written to the task', async () => {
    const h = await loadHandlers();
    const r = await call(h, { id: "t1", status: "done", source: "bulk" });
    expect(r.ok).toBe(true);
    expect(upserts[0]).toEqual({ id: "t1", status: "done" });
    expect(events()).toEqual([
      expect.objectContaining({ objectId: "t1", bulk: true, origin: "bulk", bulkReason: "origin" }),
    ]);
    // Nested-patch form reads the same top-level source.
    await call(h, { id: "t2", patch: { status: "done" }, source: "automation" });
    expect(events()[1]).toMatchObject({ objectId: "t2", bulk: true, origin: "automation" });
  });

  it("omitted / user source counts normally; unknown source is rejected", async () => {
    const h = await loadHandlers();
    await call(h, { id: "t1", status: "done" });
    await call(h, { id: "t2", status: "done", source: "user" });
    expect(events().every((e) => e.bulk !== true)).toBe(true);
    const bad = await call(h, { id: "t3", status: "done", source: "cron-job" });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe("INVALID_PARAMS");
    expect(upserts.map((u) => u.id)).toEqual(["t1", "t2"]);
  });

  it("a burst of 25 from one connection is all bulk; 5 from another still count", async () => {
    const h = await loadHandlers();
    for (let i = 0; i < 25; i++) await call(h, { id: `a${i}`, status: "done" }, "script-conn");
    for (let i = 0; i < 5; i++) await call(h, { id: `b${i}`, status: "done" }, "owner-tab");
    const ev = events();
    expect(ev.filter((e) => e.objectId.startsWith("a")).every((e) => e.bulk === true)).toBe(true);
    expect(ev.filter((e) => e.objectId.startsWith("b")).every((e) => e.bulk !== true)).toBe(true);
    expect(ev).toHaveLength(30);
  });

  it("below the threshold from one connection everything counts", async () => {
    const h = await loadHandlers();
    for (let i = 0; i < 20; i++) await call(h, { id: `c${i}`, status: "done" }, "owner-tab");
    expect(events().filter((e) => e.bulk !== true)).toHaveLength(20);
  });

  it("a CLI script opening one connection per call is still caught (keyed by client identity)", async () => {
    const h = await loadHandlers();
    const cli = { id: "cli", mode: "cli" };
    for (let i = 0; i < 25; i++) await call(h, { id: `s${i}`, status: "done" }, `cli-conn-${i}`, cli);
    // Two browser tabs of the control UI stay per connection.
    const ui = { id: "infinibot-control-ui", mode: "webchat" };
    for (let i = 0; i < 12; i++) await call(h, { id: `u${i}`, status: "done" }, "tab-1", ui);
    for (let i = 0; i < 12; i++) await call(h, { id: `v${i}`, status: "done" }, "tab-2", ui);
    const ev = events();
    expect(ev.filter((e) => e.objectId.startsWith("s")).every((e) => e.bulk === true)).toBe(true);
    expect(ev.filter((e) => /^[uv]/.test(e.objectId)).every((e) => e.bulk !== true)).toBe(true);
  });
});

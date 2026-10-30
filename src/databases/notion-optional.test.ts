/**
 * Notion is optional: creating projects / tasks / kanban cards / clients and
 * coder-tracked tasks must work with Notion unconfigured, with Notion
 * erroring (500 / timeout), and must mirror when Notion is configured.
 *
 * Every test runs against a throwaway state dir and a stubbed global fetch —
 * nothing here can reach the real Notion API or the owner's config.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../federation/satellite-context.js", () => ({
  getConnectedSatellite: () => null,
  proxyToMaster: async () => ({ success: false }),
  proxyMethodsToMaster: (handlers: unknown) => handlers,
  applySatelliteProxy: (handlers: unknown) => handlers,
}));

type Handlers = Record<string, (opts: unknown) => unknown>;
type FetchRoute = (url: string, init: RequestInit) => Promise<Response> | Response;

const PROJECTS_DB = "11111111111111111111111111111111";
const TASKS_DB = "22222222222222222222222222222222";

let tempDir: string;
const originalEnv = { ...process.env };
const fetchCalls: Array<{ url: string; method: string }> = [];
let route: FetchRoute;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let pageSeq = 0;
function newNotionId(): string {
  pageSeq++;
  return `aaaaaaaa-bbbb-cccc-dddd-${String(pageSeq).padStart(12, "0")}`;
}

/** A healthy fake Notion: creates pages, returns empty queries/schemas. */
const healthyNotion: FetchRoute = (url, init) => {
  const method = (init.method ?? "GET").toUpperCase();
  if (url.endsWith("/v1/pages") && method === "POST") {
    const body = JSON.parse((init.body as string | undefined) ?? "{}");
    return json(200, {
      id: newNotionId(),
      created_time: new Date().toISOString(),
      last_edited_time: new Date().toISOString(),
      properties: Object.fromEntries(
        Object.entries(body.properties ?? {}).map(([k, v]: [string, any]) => [
          k,
          v?.title
            ? { type: "title", title: v.title.map((t: any) => ({ plain_text: t.text.content })) }
            : v,
        ]),
      ),
    });
  }
  if (url.includes("/v1/databases/") && url.endsWith("/query")) {
    return json(200, { results: [], has_more: false });
  }
  if (url.includes("/v1/databases/")) {
    return json(200, { id: "db", properties: {} });
  }
  if (url.includes("/v1/pages/")) {
    return json(200, { id: url.split("/").pop(), properties: {} });
  }
  return json(200, {});
};

const notion500: FetchRoute = () => json(500, { message: "internal error" });
const notionTimeout: FetchRoute = () =>
  Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

function useNotion(mode: "unconfigured" | "configured") {
  return import("./notion-config.js").then(({ setNotionRuntimeOverride }) => {
    if (mode === "unconfigured") {
      setNotionRuntimeOverride({ syncMode: "off", apiKey: null });
    } else {
      setNotionRuntimeOverride({
        syncMode: "mirror",
        apiKey: "secret_test_only",
        projectsDbId: PROJECTS_DB,
        tasksDbId: TASKS_DB,
      });
    }
  });
}

async function loadKanbanHandlers(): Promise<Handlers> {
  return (await import("../gateway/server-methods/kanban.js"))
    .kanbanHandlers as unknown as Handlers;
}

function call(
  handlers: Handlers,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; data?: any; error?: any }> {
  return new Promise((resolve) => {
    void handlers[method]({
      params,
      client: { connId: "test" },
      context: { broadcast: () => {} },
      respond: (ok: boolean, data?: unknown, error?: unknown) => resolve({ ok, data, error }),
    });
  });
}

function notionWrites(): number {
  return fetchCalls.filter((c) => c.url.includes("api.notion.com") && c.method !== "GET").length;
}

beforeEach(async () => {
  // No vi.resetModules(): better-sqlite3 can't be loaded twice per process.
  // Stores are keyed by state dir, so a fresh temp dir isolates each test;
  // the kanban list cache is dropped through its invalidation hook.
  const { broadcastKanbanChanged } = await import("../tasks/kanban-events.js");
  broadcastKanbanChanged({ entity: "project", op: "update" } as any);
  broadcastKanbanChanged({ entity: "task", op: "update" } as any);
  tempDir = mkdtempSync(join(tmpdir(), "notion-optional-"));
  process.env.HOME = tempDir;
  process.env.INFINIBOT_STATE_DIR = tempDir;
  process.env.MOLTBOT_STATE_DIR = tempDir;
  process.env.INFINIBOT_CONFIG_PATH = join(tempDir, "infinibot.json");
  writeFileSync(process.env.INFINIBOT_CONFIG_PATH, "{}\n");
  delete process.env.NOTION_API_KEY;
  fetchCalls.length = 0;
  route = healthyNotion;
  vi.stubGlobal("fetch", (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push({ url, method: (init.method ?? "GET").toUpperCase() });
    return Promise.resolve(route(url, init));
  });
});

afterEach(async () => {
  const { setNotionRuntimeOverride } = await import("./notion-config.js");
  setNotionRuntimeOverride(null);
  const ops = await import("./kanban-store-ops.js");
  ops.resetNotionOutboxForTests();
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Notion unconfigured", () => {
  beforeEach(() => useNotion("unconfigured"));

  it("RPC: creates a project, a task and lists both without touching Notion", async () => {
    const h = await loadKanbanHandlers();
    const p = await call(h, "kanban.projects.create", { name: "Local project" });
    expect(p.ok).toBe(true);
    expect(p.data.id).toBeTruthy();
    const t = await call(h, "kanban.tasks.create", { title: "Local card", projectId: p.data.id });
    expect(t.ok).toBe(true);

    const projects = await call(h, "kanban.projects.list", {});
    expect(projects.data.map((x: any) => x.id)).toContain(p.data.id);
    const tasks = await call(h, "kanban.tasks.list", { projectId: p.data.id });
    expect(tasks.data.map((x: any) => x.title)).toContain("Local card");

    const upd = await call(h, "kanban.tasks.update", { id: t.data.id, status: "done" });
    expect(upd.ok).toBe(true);
    expect(fetchCalls.filter((c) => c.url.includes("notion.com"))).toHaveLength(0);

    const status = await call(h, "kanban.notionSync.status", {});
    expect(status.data.state).toBe("off");
  });

  it("agent tool: create_project / create_task / list / update work locally", async () => {
    const { createKanbanTool } = await import("../agents/tools/kanban-tool.js");
    const tool = createKanbanTool({ agentId: "main" });
    const run = async (args: Record<string, unknown>) =>
      JSON.parse(((await tool.execute("call", args)) as any).content[0].text);

    const proj = await run({ action: "create_project", project_name: "Agent project" });
    expect(proj, JSON.stringify(proj)).toMatchObject({ status: "ok" });
    const task = await run({
      action: "create_task",
      title: "Agent card",
      project_id: proj.project.id,
    });
    expect(task, JSON.stringify(task)).toMatchObject({ status: "ok" });
    const list = await run({ action: "list_tasks", filter_project: proj.project.id });
    expect(list.status).toBe("ok");
    expect(list.tasks.map((x: any) => x.title)).toContain("Agent card");
    const upd = await run({ action: "update_task", task_id: task.task.id, status: "review" });
    expect(upd.status).toBe("ok");
    expect(upd.task.status).toBe("review");
    const projects = await run({ action: "list_projects" });
    expect(projects.source).toBe("local");
    expect(projects.projects.map((x: any) => x.name)).toContain("Agent project");
    expect(fetchCalls.filter((c) => c.url.includes("notion.com"))).toHaveLength(0);
  });

  it("coder tracking: findOrCreateProject + mcpCreateTask + notes + update return local ids", async () => {
    const kt = await import("../agents/tools/kanban-tool.js");
    const proj = await kt.findOrCreateProject("Dummy coder project");
    expect(proj?.matched).toBe("created");
    const again = await kt.findOrCreateProject("Dummy coder project");
    expect(again?.projectId).toBe(proj?.projectId);

    const created = await kt.mcpCreateTask({
      title: "claude_coder: dummy run",
      projectId: proj!.projectId,
      status: "in_progress",
    });
    expect(created?.id).toBeTruthy();
    expect(await kt.mcpAppendTaskNote(created!.id, "▶ run started")).toBe(true);
    expect(await kt.mcpUpdateTask(created!.id, { status: "done" })).toBe(true);

    const ops = await import("./kanban-store-ops.js");
    expect(ops.getTask(created!.id)?.status).toBe("done");
    expect(fetchCalls.filter((c) => c.url.includes("notion.com"))).toHaveLength(0);
  });

  it("clients: leads Save to CRM writes a local client with no Notion database", async () => {
    const { LeadService } = await import("../services/lead-generation/lead-service.js");
    const service = new LeadService({});
    const lead = {
      id: "lead-1",
      companyName: "Acme Plumbing",
      email: "hi@acme.test",
      type: "business",
      source: "google_maps",
      status: "new",
      quality: "warm",
      scrapedAt: Date.now(),
      lastUpdated: Date.now(),
    } as any;
    const saved = await service.saveLeadToCRM({ lead });
    expect(saved.notionSync).toBe("off");
    // Save to CRM lands in the Business hub (company + contact + open deal);
    // a lead only becomes an agency client once its deal is won.
    const { getHubDb } = await import("../business-hub/db.js");
    const { getContact, getCompany } = await import("../business-hub/contacts.js");
    const db = getHubDb(tempDir);
    const rec = getContact(db, saved.clientId) ?? getCompany(db, saved.clientId);
    const names = [rec?.name, (rec as { companyName?: string } | null)?.companyName];
    expect(names).toContain("Acme Plumbing");
    // Idempotent: saving again reuses the client.
    const again = await service.saveLeadToCRM({ lead });
    expect(again.clientId).toBe(saved.clientId);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe.each([
  ["500", notion500],
  ["timeout", notionTimeout],
])("Notion configured but failing (%s)", (_label, failing) => {
  beforeEach(async () => {
    await useNotion("configured");
    route = failing;
  });

  it("RPC create never fails; the item is saved locally, listed, and queued", async () => {
    const h = await loadKanbanHandlers();
    const p = await call(h, "kanban.projects.create", { name: "Made while Notion is down" });
    expect(p.ok).toBe(true);
    expect(p.data.syncPending).toBe(true);

    const t = await call(h, "kanban.tasks.create", {
      title: "Card while down",
      projectId: p.data.id,
    });
    expect(t.ok).toBe(true);

    // Notion query also failing → list falls back to local and includes them.
    const projects = await call(h, "kanban.projects.list", {});
    expect(projects.ok).toBe(true);
    expect(projects.data.map((x: any) => x.id)).toContain(p.data.id);
    const tasks = await call(h, "kanban.tasks.list", {});
    expect(tasks.data.map((x: any) => x.id)).toContain(t.data.id);

    // Updating a local-only card stays local (no Notion PATCH on a local id).
    const upd = await call(h, "kanban.tasks.update", { id: t.data.id, status: "in_progress" });
    expect(upd.ok).toBe(true);

    const ops = await import("./kanban-store-ops.js");
    await new Promise((r) => setTimeout(r, 20));
    const health = ops.getNotionSyncHealth();
    expect(health.state).toBe("paused");
    expect(health.pending).toBeGreaterThanOrEqual(2);

    // Notion recovers → the outbox mirrors both and clears the queue.
    route = healthyNotion;
    const remaining = await ops.flushNotionOutbox();
    expect(remaining).toBe(0);
    expect(ops.getProject(p.data.id)?.notionId).toBeTruthy();
    expect(ops.getTask(t.data.id)?.notionId).toBeTruthy();
    expect(ops.getNotionSyncHealth().state).toBe("ok");
  });

  it("pending local rows are merged into a healthy Notion list", async () => {
    const h = await loadKanbanHandlers();
    const p = await call(h, "kanban.projects.create", { name: "Queued project" });
    expect(p.ok).toBe(true);
    // Even while Notion is still considered down, the local list flags it.
    const local = await call(h, "kanban.projects.list", {});
    expect(local.data.find((x: any) => x.id === p.data.id)?.syncPending).toBe(true);
    const { broadcastKanbanChanged } = await import("../tasks/kanban-events.js");
    broadcastKanbanChanged({ entity: "project", op: "update" } as any);
    (await import("./kanban-store-ops.js")).closeNotionCircuit();
    // Notion reads work again, but the create hasn't been mirrored yet.
    route = (url, init) =>
      (init.method ?? "GET").toUpperCase() === "POST" && url.endsWith("/v1/pages")
        ? notion500(url, init)
        : healthyNotion(url, init);
    const list = await call(h, "kanban.projects.list", {});
    const mine = list.data.find((x: any) => x.id === p.data.id);
    expect(mine?.syncPending).toBe(true);
  });

  it("agent tool + coder tracking fall back to local instead of erroring", async () => {
    const kt = await import("../agents/tools/kanban-tool.js");
    const tool = kt.createKanbanTool({ agentId: "main" });
    const out = JSON.parse(
      ((await tool.execute("call", { action: "create_task", title: "Tool card" })) as any)
        .content[0].text,
    );
    expect(out.status).toBe("ok");
    expect(out.syncPending).toBe(true);

    const proj = await kt.findOrCreateProject("Coder project during outage");
    expect(proj?.projectId).toBeTruthy();
    const created = await kt.mcpCreateTask({ title: "coder run", projectId: proj!.projectId });
    expect(created?.id).toBeTruthy();
    expect(await kt.mcpAppendTaskNote(created!.id, "note")).toBe(true);

    const list = JSON.parse(
      ((await tool.execute("call", { action: "list_tasks" })) as any).content[0].text,
    );
    expect(list.status).toBe("ok");
    expect(list.tasks.map((x: any) => x.title)).toEqual(
      expect.arrayContaining(["Tool card", "coder run"]),
    );
  });
});

describe("Notion configured and healthy", () => {
  beforeEach(() => useNotion("configured"));

  it("RPC create goes to Notion (mirrored) and returns the Notion page", async () => {
    const h = await loadKanbanHandlers();
    const p = await call(h, "kanban.projects.create", { name: "Mirrored project" });
    expect(p.ok).toBe(true);
    expect(p.data.syncPending).toBeUndefined();
    expect(p.data.id).toMatch(/^aaaaaaaa-/);
    const t = await call(h, "kanban.tasks.create", {
      title: "Mirrored card",
      projectId: p.data.id,
    });
    expect(t.ok).toBe(true);
    expect(t.data.id).toMatch(/^aaaaaaaa-/);
    expect(
      fetchCalls.filter((c) => c.url.endsWith("/v1/pages") && c.method === "POST"),
    ).toHaveLength(2);
  });

  it("local-first writes are mirrored by the outbox and linked back", async () => {
    const ops = await import("./kanban-store-ops.js");
    const project = ops.upsertProject({ name: "Local then mirrored" });
    const task = ops.upsertTask({ title: "Local card", projectId: project.id });
    await ops.flushNotionOutbox();
    expect(ops.getProject(project.id)?.notionId).toMatch(/^aaaaaaaa-/);
    expect(ops.getTask(task.id)?.notionId).toMatch(/^aaaaaaaa-/);
    expect(ops.getNotionSyncHealth()).toMatchObject({ state: "ok", pending: 0 });
    // create → immediate update must not create two Notion pages.
    const before = notionWrites();
    const p2 = ops.upsertProject({ name: "Rapid" });
    ops.upsertProject({ id: p2.id, description: "edited right away" });
    await ops.flushNotionOutbox();
    const creates = fetchCalls
      .slice(0)
      .filter((c) => c.url.endsWith("/v1/pages") && c.method === "POST").length;
    expect(notionWrites() - before).toBeGreaterThanOrEqual(1);
    expect(creates).toBe(3); // project + task + the single "Rapid" page
  });
});

// ── Circuit breaker + the generic /databases surface ─────────────────────

async function loadDatabasesHandlers(): Promise<Handlers> {
  return (await import("../gateway/server-methods/databases.js"))
    .databasesHandlers as unknown as Handlers;
}

async function kanbanDbIds(): Promise<{ projectsDbId: string; tasksDbId: string }> {
  const { getDatabasesStore, ensureKanbanBuiltInDatabases } = await import("./store.js");
  return ensureKanbanBuiltInDatabases(getDatabasesStore());
}

describe("Notion unconfigured: /databases kanban rows + clients", () => {
  beforeEach(() => useNotion("unconfigured"));

  it("db.rows.upsert on the built-in Projects/Tasks databases saves locally", async () => {
    const h = await loadDatabasesHandlers();
    const { projectsDbId, tasksDbId } = await kanbanDbIds();
    const p = await call(h, "db.rows.upsert", { databaseId: projectsDbId, title: "DB project" });
    expect(p.ok).toBe(true);
    expect(p.data.row.title).toBe("DB project");
    const t = await call(h, "db.rows.upsert", { databaseId: tasksDbId, title: "DB card" });
    expect(t.ok).toBe(true);
    // Editing the local row stays local too.
    const e = await call(h, "db.rows.upsert", {
      databaseId: projectsDbId,
      id: p.data.row.id,
      title: "DB project (edited)",
    });
    expect(e.ok).toBe(true);
    expect(e.data.row.id).toBe(p.data.row.id);
    const list = await call(h, "db.rows.list", { databaseId: projectsDbId });
    expect(list.data.rows.map((r: any) => r.title)).toContain("DB project (edited)");
    expect(fetchCalls.filter((c) => c.url.includes("notion.com"))).toHaveLength(0);
  });

  it("clients.create works with no Notion at all", async () => {
    const { clientsHandlers } = await import("../gateway/server-methods/clients.js");
    const h = clientsHandlers as unknown as Handlers;
    const c = await call(h, "clients.create", { name: "Local Client Co" });
    expect(c.ok).toBe(true);
    expect(c.data.client.name).toBe("Local Client Co");
    const list = await call(h, "clients.list", { all: true });
    expect(list.ok).toBe(true);
    expect(list.data.clients.map((x: any) => x.name)).toContain("Local Client Co");
    expect(fetchCalls.filter((x) => x.url.includes("notion.com"))).toHaveLength(0);
  });
});

describe("Notion configured but down: circuit breaker", () => {
  beforeEach(async () => {
    await useNotion("configured");
    route = notionTimeout;
  });

  it("after one failure, creates skip Notion entirely and save locally at once", async () => {
    const ops = await import("./kanban-store-ops.js");
    const h = await loadKanbanHandlers();
    const first = await call(h, "kanban.projects.create", { name: "First during outage" });
    expect(first.ok).toBe(true);
    expect(ops.isNotionCircuitOpen()).toBe(true);

    const requestPathCalls = () =>
      fetchCalls.filter((c) => c.url.endsWith("/v1/pages") && c.method === "POST").length;
    const before = requestPathCalls();
    const second = await call(h, "kanban.projects.create", { name: "Second during outage" });
    const card = await call(h, "kanban.tasks.create", { title: "Card during outage" });
    expect(second.ok && card.ok).toBe(true);
    expect(second.data.syncPending).toBe(true);
    // Only the background outbox may have tried Notion — never the request path
    // more than once per write; with the circuit open the RPCs add none.
    const kt = await import("../agents/tools/kanban-tool.js");
    const created = await kt.mcpCreateTask({ title: "coder run during outage" });
    expect(created?.id).toBeTruthy();
    // With the circuit open neither the handlers nor the per-write outbox
    // kick touch Notion — the queued rows wait for the scheduled retry.
    expect(requestPathCalls() - before).toBe(0);

    // Recovery closes the circuit and drains the queue.
    route = healthyNotion;
    expect(await ops.flushNotionOutbox()).toBe(0);
    expect(ops.isNotionCircuitOpen()).toBe(false);
  });

  it("db.rows.upsert on a kanban database falls back to local and queues the mirror", async () => {
    const h = await loadDatabasesHandlers();
    const { projectsDbId } = await kanbanDbIds();
    const r = await call(h, "db.rows.upsert", { databaseId: projectsDbId, title: "Outage row" });
    expect(r.ok).toBe(true);
    expect(r.data.syncPending).toBe(true);
    const ops = await import("./kanban-store-ops.js");
    route = healthyNotion;
    expect(await ops.flushNotionOutbox()).toBe(0);
  });
});

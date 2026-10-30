/**
 * Notion sync robustness against a fake Notion API (no network, throwaway
 * state dir):
 *   - local statuses map onto the DB's real options (never an invalid one),
 *   - permanent 4xx rejections dead-letter instead of retrying forever,
 *   - network failures back off (outbox + per-DB pull breaker) and catch up,
 *   - repeated pulls of the same pages never create duplicate rows,
 *   - the agent kanban tool works with Notion unconfigured / half-bound.
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

const PROJECTS_DB = "11111111111111111111111111111111";
const TASKS_DB = "22222222222222222222222222222222";

/** The live KK Tasks schema: no "review"/"In review" option. */
const TASKS_SCHEMA = {
  id: TASKS_DB,
  properties: {
    "Task Name": { type: "title", title: {} },
    "Status Update": {
      type: "status",
      status: {
        options: [
          { id: "s1", name: "Not started" },
          { id: "s2", name: "Awaiting Response" },
          { id: "s3", name: "Revisit" },
          { id: "s4", name: "In progress" },
          { id: "s5", name: "Done" },
        ],
        groups: [
          { name: "To-do", option_ids: ["s1"] },
          { name: "In progress", option_ids: ["s2", "s3", "s4"] },
          { name: "Complete", option_ids: ["s5"] },
        ],
      },
    },
    "Priority Level": {
      type: "select",
      select: {
        options: [{ name: "High" }, { name: "Low" }, { name: "Medium" }, { name: "Immediate" }],
      },
    },
  },
};
const PROJECTS_SCHEMA = {
  id: PROJECTS_DB,
  properties: {
    Project: { type: "title", title: {} },
    Status: {
      type: "status",
      status: {
        options: [{ name: "Not started" }, { name: "In progress" }, { name: "Completed" }],
        groups: [],
      },
    },
  },
};

let tempDir: string;
const originalEnv = { ...process.env };
interface Call {
  url: string;
  method: string;
  body: any;
}
const calls: Call[] = [];
type Route = (url: string, init: RequestInit) => Promise<Response> | Response;
let route: Route;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let seq = 0;
const newId = () => `aaaaaaaa-bbbb-cccc-dddd-${String(++seq).padStart(12, "0")}`;

/** Fake Notion that validates status names against the schema like the real API. */
function strictNotion(opts: { tasksSchema?: any; rejectAll?: boolean } = {}): Route {
  const tasksSchema = opts.tasksSchema ?? TASKS_SCHEMA;
  return (url, init) => {
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET" && url.endsWith(`/databases/${TASKS_DB}`)) return json(200, tasksSchema);
    if (method === "GET" && url.endsWith(`/databases/${PROJECTS_DB}`))
      return json(200, PROJECTS_SCHEMA);
    if ((url.endsWith("/v1/pages") && method === "POST") || /\/v1\/pages\/[^/]+$/.test(url)) {
      const body = JSON.parse((init.body as string | undefined) ?? "{}");
      const isTask =
        body?.parent?.database_id === TASKS_DB || "Task Name" in (body.properties ?? {});
      const schema = isTask ? tasksSchema : PROJECTS_SCHEMA;
      for (const [k, v] of Object.entries<any>(body.properties ?? {})) {
        if (v?.status) {
          const ok = (schema.properties[k]?.status?.options ?? []).some(
            (o: any) => o.name === v.status.name,
          );
          if (!ok || opts.rejectAll) {
            return json(400, {
              object: "error",
              code: "validation_error",
              message: `Invalid status option. Status option "${v.status.name}" does not exist".`,
            });
          }
        }
      }
      return json(200, { id: method === "POST" ? newId() : url.split("/").pop() });
    }
    return json(200, {});
  };
}

const fetchFailed: Route = () => Promise.reject(new TypeError("fetch failed"));

async function useNotion(mode: "off" | "mirror", extra: Record<string, unknown> = {}) {
  const { setNotionRuntimeOverride } = await import("./notion-config.js");
  if (mode === "off") setNotionRuntimeOverride({ syncMode: "off", apiKey: null });
  else {
    const notion = {
      syncMode: "mirror",
      apiKey: "secret_test_only",
      projectsDbId: PROJECTS_DB,
      tasksDbId: TASKS_DB,
      ...extra,
    };
    // Also on disk: persisting the pull cursor (upsertBinding) rewrites the
    // config file and drops the runtime override, like the real gateway.
    const { readFileSync } = await import("node:fs");
    const cur = JSON.parse(readFileSync(process.env.INFINIBOT_CONFIG_PATH!, "utf8") || "{}");
    const onDisk = Object.fromEntries(Object.entries(notion).filter(([, v]) => v != null));
    writeFileSync(
      process.env.INFINIBOT_CONFIG_PATH!,
      JSON.stringify({ ...cur, notion: { ...cur.notion, ...onDisk } }),
    );
    setNotionRuntimeOverride(notion as never);
  }
}

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "notion-robust-"));
  process.env.HOME = tempDir;
  process.env.INFINIBOT_STATE_DIR = tempDir;
  process.env.MOLTBOT_STATE_DIR = tempDir;
  process.env.INFINIBOT_CONFIG_PATH = join(tempDir, "infinibot.json");
  writeFileSync(process.env.INFINIBOT_CONFIG_PATH, "{}\n");
  delete process.env.NOTION_API_KEY;
  calls.length = 0;
  route = strictNotion();
  vi.stubGlobal("fetch", (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let body: unknown = null;
    try {
      body = init.body ? JSON.parse(init.body as string) : null;
    } catch {
      body = init.body;
    }
    calls.push({ url, method: (init.method ?? "GET").toUpperCase(), body });
    return Promise.resolve().then(() => route(url, init));
  });
  const ops = await import("./kanban-store-ops.js");
  ops.resetNotionOutboxForTests({ random: () => 0.5 });
  const bidir = await import("./notion-bidirectional-sync.js");
  bidir.resetNotionPullStateForTests({ random: () => 0.5 });
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

const pageWrites = () =>
  calls.filter((c) => c.url.includes("/v1/pages") && (c.method === "POST" || c.method === "PATCH"));

describe("A. status mapping + dead-letter", () => {
  it("maps local 'review' onto an option the DB has and never sends an invalid one", async () => {
    await useNotion("mirror");
    const ops = await import("./kanban-store-ops.js");
    const p = ops.upsertProject({ name: "P", status: "In progress" });
    const statuses = ["todo", "in_progress", "review", "done", "backlog"] as const;
    for (const s of statuses) ops.upsertTask({ title: `t-${s}`, projectId: p.id, status: s });
    expect(await ops.flushNotionOutbox()).toBe(0);
    const sent = pageWrites()
      .filter((c) => c.body?.properties?.["Status Update"])
      .map((c) => [
        c.body.properties["Task Name"].title[0].text.content,
        c.body.properties["Status Update"].status.name,
      ]);
    expect(Object.fromEntries(sent)).toEqual({
      "t-todo": "Not started",
      "t-in_progress": "In progress",
      "t-review": "Awaiting Response",
      "t-done": "Done",
      "t-backlog": "Not started",
    });
    // Priority canonicalised to the existing option, never a new "high" option.
    ops.upsertTask({ title: "prio", projectId: p.id, status: "todo", priority: "high" });
    await ops.flushNotionOutbox();
    const prio = pageWrites().at(-1)!.body.properties["Priority Level"];
    expect(prio).toEqual({ select: { name: "High" } });
    expect(ops.getNotionSyncHealth()).toMatchObject({ state: "ok", pending: 0, needsAttention: 0 });
  });

  it("operator option map overrides the default", async () => {
    writeFileSync(
      process.env.INFINIBOT_CONFIG_PATH!,
      JSON.stringify({ notion: { optionMap: { tasks: { review: "Revisit" } } } }),
    );
    await useNotion("mirror");
    const ops = await import("./kanban-store-ops.js");
    const p = ops.upsertProject({ name: "P" });
    ops.upsertTask({ title: "r", projectId: p.id, status: "review" });
    await ops.flushNotionOutbox();
    const w = pageWrites().find((c) => c.body?.properties?.["Task Name"]);
    expect(w!.body.properties["Status Update"]).toEqual({ status: { name: "Revisit" } });
  });

  it("a permanent 400 dead-letters the row (no retry storm) and can be retried", async () => {
    await useNotion("mirror");
    route = strictNotion({ rejectAll: true });
    const ops = await import("./kanban-store-ops.js");
    const p = ops.upsertProject({ name: "P", status: "Not started" });
    const t = ops.upsertTask({ title: "stuck", projectId: p.id, status: "review" });
    // Let the fire-and-forget mirrors settle.
    await new Promise((r) => setTimeout(r, 20));
    await ops.flushNotionOutbox();
    const writesAfterFirst = pageWrites().length;
    // Further flushes make NO calls for the dead-lettered rows.
    for (let i = 0; i < 5; i++) await ops.flushNotionOutbox();
    expect(pageWrites().length).toBe(writesAfterFirst);
    const health = ops.getNotionSyncHealth();
    expect(health.pending).toBe(0);
    expect(health.needsAttention).toBe(2);
    expect(health.state).toBe("attention");
    expect(health.deadLetters.map((d) => d.id).sort()).toEqual([p.id, t.id].sort());
    expect(health.deadLetters[0]!.reason).toMatch(/Invalid status option/);
    // The circuit was NOT tripped by a validation error: request paths still try Notion.
    expect(ops.isNotionCircuitOpen()).toBe(false);

    // Operator fixes Notion → retry clears the backlog.
    route = strictNotion();
    expect(ops.retryNotionDeadLetters()).toBe(2);
    await ops.flushNotionOutbox();
    expect(ops.getNotionSyncHealth()).toMatchObject({ state: "ok", pending: 0, needsAttention: 0 });
  });

  it("a status the DB can't express is omitted, not sent", async () => {
    await useNotion("mirror");
    route = strictNotion({
      tasksSchema: {
        ...TASKS_SCHEMA,
        properties: {
          ...TASKS_SCHEMA.properties,
          "Status Update": {
            type: "status",
            status: { options: [{ id: "x", name: "Someday" }], groups: [] },
          },
        },
      },
    });
    const ops = await import("./kanban-store-ops.js");
    const p = ops.upsertProject({ name: "P" });
    ops.upsertTask({ title: "odd", projectId: p.id, status: "review" });
    expect(await ops.flushNotionOutbox()).toBe(0);
    const w = pageWrites().find((c) => c.body?.properties?.["Task Name"]);
    expect(w!.body.properties["Status Update"]).toBeUndefined();
    expect(ops.getNotionSyncHealth().needsAttention).toBe(0);
  });
});

describe("A2. outbox honours a cleared pending flag mid-flush", () => {
  it("a row cleared after the flush started is not pushed", async () => {
    await useNotion("mirror");
    route = fetchFailed; // keep rows pending while we seed them
    const ops = await import("./kanban-store-ops.js");
    const p = ops.upsertProject({ name: "P" });
    const keep = ops.upsertTask({ title: "real", projectId: p.id, status: "todo" });
    const junk = ops.upsertTask({ title: "task-in_progress", projectId: p.id, status: "review" });
    await new Promise((r) => setTimeout(r, 20));
    ops.resetNotionOutboxForTests({ random: () => 0.5 });
    // Notion comes back; clear the junk row's flag as soon as the first page write lands.
    const { resolveKanbanDatabase, NOTION_PENDING_KEY } = ops;
    let cleared = false;
    route = (url, init) => {
      const isTaskCreate =
        url.endsWith("/v1/pages") &&
        (init.method ?? "GET").toUpperCase() === "POST" &&
        ((init.body as string | undefined) ?? "").includes('"Task Name"');
      if (!cleared && isTaskCreate) {
        cleared = true;
        const { store } = resolveKanbanDatabase("tasks");
        const row = store.getRow(junk.id)!;
        store.upsertRow({
          id: junk.id,
          databaseId: row.databaseId,
          values: { [NOTION_PENDING_KEY]: { type: "richText", markdown: "" } },
        });
      }
      return strictNotion()(url, init);
    };
    calls.length = 0;
    await ops.flushNotionOutbox();
    const titles = pageWrites()
      .map((c) => c.body?.properties?.["Task Name"]?.title?.[0]?.text?.content)
      .filter(Boolean);
    expect(titles).toContain("real");
    expect(titles).not.toContain("task-in_progress");
    expect(ops.getTask(keep.id)?.notionId).toBeTruthy();
  });
});

describe("C. outbox network resilience", () => {
  it("fetch failures keep rows pending, stop the flush after one failure, and back off with jitter", async () => {
    await useNotion("mirror");
    route = fetchFailed;
    const ops = await import("./kanban-store-ops.js");
    const p = ops.upsertProject({ name: "P" });
    for (let i = 0; i < 10; i++)
      ops.upsertTask({ title: `t${i}`, projectId: p.id, status: "todo" });
    await new Promise((r) => setTimeout(r, 20));
    calls.length = 0;
    ops.closeNotionCircuit();
    const remaining = await ops.flushNotionOutbox();
    expect(remaining).toBe(11);
    // One failed probe (schema GET or page write), not one per queued row.
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(ops.isNotionCircuitOpen()).toBe(true);
    const h = ops.getNotionSyncHealth();
    expect(h.state).toBe("paused");
    expect(h.lastError).toMatch(/fetch failed/);
    // Jitter bounds: ±20% around each base delay.
    ops.resetNotionOutboxForTests({ random: () => 0 });
    expect(ops.outboxRetryDelay(0)).toBe(24_000);
    ops.resetNotionOutboxForTests({ random: () => 1 });
    expect(ops.outboxRetryDelay(3)).toBe(2_160_000);
    expect(ops.outboxRetryDelay(99)).toBe(2_160_000);
    // Recovery: everything queued catches up.
    ops.resetNotionOutboxForTests({ random: () => 0.5 });
    route = strictNotion();
    expect(await ops.flushNotionOutbox()).toBe(0);
  });
});

// ── Pull side ───────────────────────────────────────────────────────────

interface FakePage {
  id: string;
  title: string;
  status: string;
  edited: string;
}

function pullNotion(pages: FakePage[], opts: { down?: () => boolean } = {}): Route {
  return (url, init) => {
    if (opts.down?.()) return Promise.reject(new TypeError("fetch failed"));
    const method = (init.method ?? "GET").toUpperCase();
    if (url.endsWith(`/databases/${TASKS_DB}/query`) && method === "POST") {
      const body = JSON.parse((init.body as string | undefined) ?? "{}");
      const since = Date.parse(body?.filter?.last_edited_time?.on_or_after ?? 0) || 0;
      const results = pages
        .filter((p) => Date.parse(p.edited) >= since)
        .map((p) => ({
          id: p.id,
          last_edited_time: p.edited,
          properties: {
            "Task Name": { type: "title", title: [{ plain_text: p.title }] },
            "Status Update": { type: "status", status: { name: p.status } },
          },
        }));
      return json(200, { results, has_more: false });
    }
    if (url.includes("/query")) return json(200, { results: [], has_more: false });
    return strictNotion()(url, init);
  };
}

async function kanbanTaskRows(): Promise<
  Array<{ id: string; notionId: string | null; title: string }>
> {
  const { getKanbanStore } = await import("../tasks/store.js");
  const store = getKanbanStore(tempDir);
  return (await store.getTasks()).map((t: any) => ({
    id: t.id,
    notionId: t.notionId ?? null,
    title: t.title,
  }));
}

describe("B. idempotent pulls", () => {
  it("re-pulling the same pages (same minute cursor) never creates duplicate rows", async () => {
    await useNotion("mirror");
    const pages: FakePage[] = [
      {
        id: "3dcf4bdd-9bcf-8146-8b9e-ecb65514c880",
        title: "A",
        status: "Revisit",
        edited: "2026-10-13T09:00:00.000Z",
      },
      {
        id: "3cef4bdd-9bcf-8148-9690-f76cab3a34b2",
        title: "B",
        status: "In progress",
        edited: "2026-10-13T09:01:00.000Z",
      },
      {
        id: "3b6f4bdd-9bcf-8138-b2f6-ebfce80a27be",
        title: "C",
        status: "Done",
        edited: "2026-10-13T09:01:00.000Z",
      },
    ];
    route = pullNotion(pages);
    const bidir = await import("./notion-bidirectional-sync.js");
    for (let i = 0; i < 6; i++) await bidir.pollNotionNow();
    let rows = await kanbanTaskRows();
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.notionId)).size).toBe(3);
    // Rows are addressable by the page id; status mapped Revisit → review.
    expect(rows.find((r) => r.title === "A")!.id).toBe(pages[0]!.id);

    // A fresh process (in-memory memo/cursor gone) still finds them by notionId.
    bidir.resetNotionPullStateForTests({ random: () => 0.5 });
    for (let i = 0; i < 3; i++) await bidir.pollNotionNow({ force: true });
    rows = await kanbanTaskRows();
    expect(rows).toHaveLength(3);

    // An edit updates in place.
    pages[1]!.title = "B renamed";
    pages[1]!.edited = new Date(Date.now() + 60_000).toISOString();
    await bidir.pollNotionNow();
    rows = await kanbanTaskRows();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.title)).toContain("B renamed");
  });

  it("finds legacy rows linked only by notionId (hyphenated or bare)", async () => {
    await useNotion("mirror");
    const { getKanbanStore } = await import("../tasks/store.js");
    const store = getKanbanStore(tempDir);
    const legacy = await store.createTask({
      projectId: "default",
      title: "legacy",
      status: "todo",
      notionId: "376f4bdd9bcf81038a67ca5a47d09a10",
    } as any);
    route = pullNotion([
      {
        id: "376f4bdd-9bcf-8103-8a67-ca5a47d09a10",
        title: "legacy (edited)",
        status: "Done",
        edited: new Date(Date.now() + 120_000).toISOString(),
      },
    ]);
    const bidir = await import("./notion-bidirectional-sync.js");
    await bidir.pollNotionNow();
    await bidir.pollNotionNow();
    const rows = await kanbanTaskRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(legacy.id);
    expect(rows[0]!.title).toBe("legacy (edited)");
  });

  it("concurrent pulls (timer + forced RPC) are serialized and stay duplicate-free", async () => {
    await useNotion("mirror");
    route = pullNotion([
      {
        id: "377f4bdd-9bcf-81aa-adf0-db20802277a0",
        title: "X",
        status: "Not started",
        edited: "2026-10-13T10:00:00.000Z",
      },
    ]);
    const bidir = await import("./notion-bidirectional-sync.js");
    await Promise.all([
      bidir.pollNotionNow(),
      bidir.pollNotionNow({ force: true }),
      bidir.pollNotionNow(),
    ]);
    expect(await kanbanTaskRows()).toHaveLength(1);
  });
});

describe("C. pull backoff + circuit breaker + catch-up", () => {
  it("backs off per DB, opens the breaker after 3 failures, logs once per state change, and catches up", async () => {
    await useNotion("mirror");
    let now = Date.parse("2026-10-13T12:00:00.000Z");
    let down = true;
    const pages: FakePage[] = [
      {
        id: "3c5f4bdd-9bcf-81ee-98e3-c1759bcd2aab",
        title: "before",
        status: "Not started",
        edited: "2026-10-13T11:00:00.000Z",
      },
    ];
    route = pullNotion(pages, { down: () => down });
    const bidir = await import("./notion-bidirectional-sync.js");
    bidir.resetNotionPullStateForTests({ random: () => 0.5, now: () => now });
    const queries = () =>
      calls.filter((c) => c.url.endsWith(`/databases/${TASKS_DB}/query`)).length;

    await bidir.pollNotionNow(); // failure 1
    let h = bidir.getNotionPullHealth().find((x) => x.dbId === TASKS_DB)!;
    expect(h).toMatchObject({ state: "failing", failures: 1 });
    expect(h.nextAttemptAt - now).toBe(60_000);
    // Inside the backoff window: no request at all.
    const q1 = queries();
    now += 30_000;
    await bidir.pollNotionNow();
    expect(queries()).toBe(q1);
    now += 31_000;
    await bidir.pollNotionNow(); // failure 2 → 120s
    h = bidir.getNotionPullHealth().find((x) => x.dbId === TASKS_DB)!;
    expect(h.nextAttemptAt - now).toBe(120_000);
    now += 121_000;
    await bidir.pollNotionNow(); // failure 3 → open, 240s
    h = bidir.getNotionPullHealth().find((x) => x.dbId === TASKS_DB)!;
    expect(h).toMatchObject({ state: "open", failures: 3 });
    expect(h.nextAttemptAt - now).toBe(240_000);
    // Backoff caps at 30 min.
    expect(bidir.pullBackoffMs(50)).toBe(30 * 60_000);

    // Notion edits made during the outage are caught up on recovery.
    pages.push({
      id: "3d1f4bdd-9bcf-8179-85c0-c60b86c961ae",
      title: "during outage",
      status: "Done",
      edited: "2026-10-13T12:03:00.000Z",
    });
    down = false;
    now += 241_000;
    await bidir.pollNotionNow();
    h = bidir.getNotionPullHealth().find((x) => x.dbId === TASKS_DB)!;
    expect(h).toMatchObject({ state: "ok", failures: 0, lastCatchUpPages: 2 });
    const rows = await kanbanTaskRows();
    expect(rows.map((r) => r.title).sort()).toEqual(["before", "during outage"]);

    // The outbox health surfaces pull state for the UI chip.
    const ops = await import("./kanban-store-ops.js");
    ops.registerNotionPullHealth(() => bidir.getNotionPullHealth() as never);
    expect(ops.getNotionSyncHealth().pull.length).toBeGreaterThan(0);
  });
});

describe("D. Notion optional for the agent kanban tool", () => {
  async function tool() {
    const { createKanbanTool } = await import("../agents/tools/kanban-tool.js");
    const t = createKanbanTool({ agentId: "main" });
    return async (args: Record<string, unknown>) =>
      JSON.parse(((await t.execute("call", args)) as any).content[0].text);
  }

  it("every action works with Notion unconfigured (no errors, no Notion calls)", async () => {
    await useNotion("off");
    const run = await tool();
    const proj = await run({ action: "create_project", project_name: "Local" });
    expect(proj.status).toBe("ok");
    const task = await run({ action: "create_task", title: "c", project_id: proj.project.id });
    expect(task.status).toBe("ok");
    for (const args of [
      { action: "list_projects" },
      { action: "list_tasks", filter_project: proj.project.id },
      { action: "update_task", task_id: task.task.id, status: "review" },
      { action: "update_project", project_id: proj.project.id, status: "Completed" },
    ]) {
      const r = await run(args);
      expect(r.status, JSON.stringify(r)).toBe("ok");
      expect(JSON.stringify(r)).not.toMatch(/No Notion/);
    }
    expect(calls.filter((c) => c.url.includes("notion.com"))).toHaveLength(0);
  });

  it("projects bound but tasks unbound: project status cascade stays local, no 'No Notion tasks database' error", async () => {
    await useNotion("mirror", { tasksDbId: null });
    const ops = await import("./kanban-store-ops.js");
    route = (url, init) => {
      const method = (init.method ?? "GET").toUpperCase();
      if (/\/v1\/pages\/[^/]+$/.test(url))
        return json(200, {
          id: url.split("/").pop(),
          properties: { Project: { type: "title", title: [{ plain_text: "Bound" }] } },
        });
      if (url.endsWith(`/databases/${PROJECTS_DB}`) && method === "GET")
        return json(200, PROJECTS_SCHEMA);
      return strictNotion()(url, init);
    };
    const run = await tool();
    const projectId = "44444444-4444-4444-4444-444444444444";
    ops.upsertTask({ title: "child", projectId, status: "todo" });
    const r = await run({ action: "update_project", project_id: projectId, status: "Completed" });
    expect(JSON.stringify(r)).not.toMatch(/No Notion tasks database/);
    expect(r.status, JSON.stringify(r)).toBe("ok");
  });
});

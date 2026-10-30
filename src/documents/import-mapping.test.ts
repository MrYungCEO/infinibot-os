import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyJournal,
  ImportLedger,
  journalSize,
  journalStore,
  undoJournal,
} from "./import-journal.js";
import { ImportJobManager } from "./import-jobs.js";
import {
  applyMapping,
  buildPreview,
  relationIds,
  toPriority,
  toTaskStatus,
  undoDepsFor,
  type MappingDeps,
  type MappingRole,
} from "./import-mapping.js";
import { createNotionClient, importNotion } from "./notion/api-import.js";
import { importNotionZip } from "./notion/zip-import.js";
import { DocumentStore } from "./store.js";
import type { DocNode } from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- recorded Notion JSON */
const FIX = path.join(import.meta.dirname, "notion", "__fixtures__");
const VAULT = path.join(import.meta.dirname, "obsidian", "__fixtures__", "vault");
const PROJECTS_DB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASKS_DB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let tmp: string;
let store: DocumentStore;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "import-mapping-"));
  store = new DocumentStore(path.join(tmp, "documents"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** In-memory kanban + clients (same contract as the real stores). */
function memDeps() {
  const tables: Record<MappingRole, Map<string, Record<string, unknown>>> = {
    projects: new Map(),
    tasks: new Map(),
    clients: new Map(),
  };
  let n = 0;
  const create = (role: MappingRole) => async (v: Record<string, unknown>) => {
    const id = `${role}-${++n}`;
    tables[role].set(id, { ...v, id });
    return { id };
  };
  const update = (role: MappingRole) => async (id: string, patch: Record<string, unknown>) => {
    const cur = tables[role].get(id);
    if (!cur) throw new Error("not found");
    tables[role].set(id, { ...cur, ...patch });
  };
  const get = (role: MappingRole) => async (id: string) => tables[role].get(id) ?? null;
  const deps: MappingDeps = {
    createProject: create("projects"),
    updateProject: update("projects"),
    getProject: get("projects"),
    listProjects: async () =>
      [...tables.projects.values()].map((p) => ({ id: String(p.id), name: String(p.name) })),
    createTask: create("tasks"),
    updateTask: update("tasks"),
    getTask: get("tasks"),
    createClient: create("clients"),
    updateClient: update("clients"),
    getClient: get("clients"),
    deleteEntity: async (role, id) => {
      tables[role].delete(id);
    },
  };
  return { deps, tables };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Fake Notion API over a recorded workspace (read endpoints only). */
function fakeFetch(ws: any): typeof fetch {
  const n = (id: string) => id.replace(/-/g, "");
  const by = (rec: Record<string, any>, id: string) =>
    Object.entries(rec).find(([k]) => n(k) === n(id))?.[1];
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    const p = url.pathname.replace(/^\/v1/, "");
    let m: RegExpExecArray | null;
    if (method === "GET" && (m = /^\/pages\/([^/]+)$/.exec(p))) {
      const page = by(ws.pages, m[1]!);
      if (page) return json(page);
      return json(
        {
          object: "error",
          code: by(ws.databases, m[1]!) ? "validation_error" : "object_not_found",
          message: "x",
        },
        by(ws.databases, m[1]!) ? 400 : 404,
      );
    }
    if (method === "GET" && (m = /^\/databases\/([^/]+)$/.exec(p))) {
      const db = by(ws.databases, m[1]!);
      return db ? json(db) : json({ code: "object_not_found", message: "nf" }, 404);
    }
    if (method === "POST" && (m = /^\/databases\/([^/]+)\/query$/.exec(p))) {
      return json({
        object: "list",
        results: (by(ws.queries, m[1]!) ?? []).map((id: string) => by(ws.pages, id)),
        has_more: false,
        next_cursor: null,
      });
    }
    if (method === "GET" && (m = /^\/blocks\/([^/]+)\/children$/.exec(p))) {
      return json({
        object: "list",
        results: by(ws.blocks, m[1]!) ?? [],
        has_more: false,
        next_cursor: null,
      });
    }
    if (method === "POST" && p === "/search") {
      const all = [...Object.values(ws.pages), ...Object.values(ws.databases)] as any[];
      all.sort((a, b) => String(b.last_edited_time).localeCompare(String(a.last_edited_time)));
      return json({ object: "list", results: all, has_more: false, next_cursor: null });
    }
    return json({ code: "invalid_request", message: `unexpected ${method} ${p}` }, 400);
  }) as typeof fetch;
}

function loadWs(): any {
  return JSON.parse(fs.readFileSync(path.join(FIX, "api-projects-tasks.json"), "utf-8"));
}

async function importApi(ws: any, s: DocumentStore = store) {
  const client = createNotionClient({
    apiKey: "secret_test",
    fetchImpl: fakeFetch(ws),
    minIntervalMs: 0,
    maxRetries: 0,
    sleep: async () => {},
  } as any);
  return importNotion(s, client, {
    ids: [PROJECTS_DB, TASKS_DB],
    parentId: null,
    mode: "full",
  } as any);
}

const folder = (title: string): DocNode =>
  store.tree().find((x) => x.kind === "folder" && x.title === title)!;

describe("value conversion", () => {
  it("maps statuses, priorities and relation ids", () => {
    expect(toTaskStatus("In progress")).toBe("in_progress");
    expect(toTaskStatus("Not started")).toBe("todo");
    expect(toTaskStatus("whatever", true)).toBe("done");
    expect(toPriority("P0 urgent")).toBe("Immediate");
    expect(toPriority("Low")).toBe("Low");
    expect(
      relationIds(
        "Website (https://www.notion.so/Website-a1a1a1a1a1a14a1a8a1aa1a1a1a1a1a1?pvs=21)",
      ),
    ).toEqual(["a1a1a1a1a1a14a1a8a1aa1a1a1a1a1a1"]);
    expect(relationIds(["a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1"])).toEqual([
      "a1a1a1a1a1a14a1a8a1aa1a1a1a1a1a1",
    ]);
  });
});

describe("Notion API (recorded) → projects + tasks", () => {
  it("previews, maps with relations, dedupes on re-sync and undoes", async () => {
    const r = await importApi(loadWs());
    expect(r.errors).toEqual([]);
    const projects = folder("Projects");
    const tasks = folder("Tasks");
    const ledger = ImportLedger.forStore(store);

    const pv = buildPreview(store, projects.id, null, undefined, ledger);
    expect(pv.suggestedRole).toBe("projects");
    expect(pv.fieldMap).toMatchObject({
      name: "__title",
      status: "Status",
      priority: "Priority",
      dueDate: "Deadline",
      description: "Summary",
    });
    expect(pv.create).toBe(2);
    expect(pv.sample[0]!.values).toMatchObject({
      name: "Website Redesign",
      status: "In progress",
      priority: "High",
      dueDate: "2026-11-01",
    });

    const tv = buildPreview(store, tasks.id, null, undefined, ledger);
    expect(tv.suggestedRole).toBe("tasks");
    expect(tv.fieldMap).toMatchObject({
      title: "__title",
      status: "Status",
      done: "Done",
      dueDate: "Due",
      project: "Project",
      tags: "Tags",
    });

    const { deps, tables } = memDeps();
    const journal = emptyJournal();
    const pr = await applyMapping(
      store,
      { folderId: projects.id, role: "projects" },
      deps,
      journal,
    );
    expect(pr).toMatchObject({ created: 2, updated: 0 });
    const tr = await applyMapping(store, { folderId: tasks.id, role: "tasks" }, deps, journal);
    expect(tr).toMatchObject({ created: 3, relationsLinked: 3, errors: [] });
    const byName = new Map([...tables.projects.values()].map((p) => [p.name, p.id]));
    const t = [...tables.tasks.values()];
    expect(t.find((x) => x.title === "Draft homepage copy")).toMatchObject({
      projectId: byName.get("Website Redesign"),
      status: "done",
      done: true,
      dueDate: "2026-10-10",
      tags: ["copy", "web"],
      notionId: "b1b1b1b1b1b14b1b8b1bb1b1b1b1b1b1",
    });
    expect(t.find((x) => x.title === "Pick app framework")?.projectId).toBe(
      byName.get("Mobile App"),
    );
    expect(tables.projects.size).toBe(2); // no fallback project needed

    // Re-sync: nothing changes → nothing written.
    const again = await applyMapping(
      store,
      { folderId: tasks.id, role: "tasks" },
      deps,
      emptyJournal(),
    );
    expect(again).toMatchObject({ created: 0, updated: 0, unchanged: 3 });

    // Incremental: Notion edit → re-import (changes mode) → mapping updates in place.
    const ws = loadWs();
    const t2 = ws.pages["b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2"];
    t2.properties.Status.status.name = "Done";
    t2.last_edited_time = new Date(Date.now() + 60_000).toISOString();
    const client = createNotionClient({
      apiKey: "x",
      fetchImpl: fakeFetch(ws),
      minIntervalMs: 0,
      maxRetries: 0,
      sleep: async () => {},
    } as any);
    const re = await importNotion(store, client, {
      ids: [TASKS_DB],
      parentId: null,
      mode: "changes",
    } as any);
    expect(re.updated).toBeGreaterThanOrEqual(1);
    const j2 = emptyJournal();
    const upd = await applyMapping(store, { folderId: tasks.id, role: "tasks" }, deps, j2);
    expect(upd).toMatchObject({ created: 0, updated: 1, unchanged: 2 });
    expect([...tables.tasks.values()].find((x) => x.title === "Build hero section")?.status).toBe(
      "done",
    );

    // Undo the update batch → previous status back.
    await undoJournal(store, j2, undoDepsFor(deps));
    expect([...tables.tasks.values()].find((x) => x.title === "Build hero section")?.status).toBe(
      "in_progress",
    );
    // Undo the first batch → all created entities removed.
    const u = await undoJournal(store, journal, undoDepsFor(deps));
    expect(u.entitiesDeleted).toBe(5);
    expect(tables.tasks.size + tables.projects.size).toBe(0);
  });

  it("journals a Notion import and undo trashes created docs", async () => {
    const journal = emptyJournal();
    await importApi(loadWs(), journalStore(store, journal));
    const created = journal.docsCreated.length;
    expect(created).toBeGreaterThanOrEqual(7); // 2 DB folders + 5 rows
    const res = await undoJournal(store, journal);
    expect(res.trashed).toBe(created);
    expect(store.tree().length).toBe(0);
  });
});

describe("Notion export ZIP fixture → projects + tasks", () => {
  it("resolves ZIP relation cells to the imported projects", async () => {
    const zip = fs.readFileSync(path.join(FIX, "notion-export-projects-tasks.zip"));
    const r = await importNotionZip(store, zip, { parentId: null });
    expect(r.errors).toEqual([]);
    const { deps, tables } = memDeps();
    const journal = emptyJournal();
    await applyMapping(store, { folderId: folder("Projects").id, role: "projects" }, deps, journal);
    const tr = await applyMapping(
      store,
      { folderId: folder("Tasks").id, role: "tasks" },
      deps,
      journal,
    );
    expect(tr).toMatchObject({ created: 3, relationsLinked: 3 });
    const byName = new Map([...tables.projects.values()].map((p) => [p.name, p.id]));
    expect([...tables.tasks.values()].find((x) => x.title === "Build hero section")).toMatchObject({
      projectId: byName.get("Website Redesign"),
      status: "in_progress",
      dueDate: "2026-10-20",
    });
    // Re-importing the same ZIP converges (dedupe by Notion id).
    const again = await importNotionZip(store, zip, { parentId: null });
    expect(again.created).toBe(0);
  });
});

describe("clients mapping", () => {
  it("maps a contacts collection onto clients with email/phone", async () => {
    const f = store.create({
      kind: "folder",
      title: "Clients",
      schema: [
        { key: "Name", name: "Name", type: "title" },
        { key: "Email", name: "Email", type: "email" },
        { key: "Phone", name: "Phone", type: "phone" },
        { key: "Stage", name: "Stage", type: "select" },
      ],
    });
    store.create({
      kind: "doc",
      title: "Acme Co",
      parentId: f.id,
      properties: { Email: "hi@acme.test", Phone: "+1 555", Stage: "Lead" },
    });
    const pv = buildPreview(store, f.id, null, undefined, ImportLedger.forStore(store));
    expect(pv.suggestedRole).toBe("clients");
    expect(pv.fieldMap).toMatchObject({
      name: "__title",
      email: "Email",
      phone: "Phone",
      pipelineStatus: "Stage",
    });
    const { deps, tables } = memDeps();
    const rep = await applyMapping(
      store,
      { folderId: f.id, role: "clients" },
      deps,
      emptyJournal(),
    );
    expect(rep.created).toBe(1);
    expect([...tables.clients.values()][0]).toMatchObject({
      name: "Acme Co",
      email: "hi@acme.test",
      phone: "+1 555",
      pipelineStatus: "Lead",
    });
  });
});

describe("ImportJobManager: Obsidian jobs, mapping jobs, undo", () => {
  function manager(deps: MappingDeps) {
    const events: any[] = [];
    const m = new ImportJobManager({
      dir: path.join(tmp, "jobs"),
      resolveApiKey: () => null,
      createClient: () => {
        throw new Error("no notion");
      },
      broadcast: (_e, p) => events.push(p),
      documentsChanged: () => {},
      storeAt: () => store,
      mappingDeps: async () => deps,
      extractAttachment: null,
      progressThrottleMs: 0,
    });
    return { m, events };
  }

  it("imports a folder vault in the background with tasks → kanban, then undoes it", async () => {
    const { deps, tables } = memDeps();
    const { m, events } = manager(deps);
    const { job } = m.startObsidian({
      source: "folder",
      origin: VAULT,
      parentId: null,
      createTasks: true,
    });
    expect(job.status).toMatch(/queued|running/);
    expect(job.obsidian?.origin).toBe("vault"); // folder path is not exposed
    const done = await m.wait(job.id, 10_000);
    expect(done?.status).toBe("done");
    expect(done?.details).toMatchObject({
      notes: 4,
      dailyNotes: 1,
      tasksFound: 4,
      tasks: { created: 4 },
    });
    expect(done?.undoable).toBeGreaterThan(0);
    expect(events.some((e) => e.job.progress.phase === "write")).toBe(true);
    expect(tables.tasks.size).toBe(4);
    expect([...tables.projects.values()][0]?.name).toBe("vault tasks");

    // Same vault again → no duplicates (docs unchanged, tasks unchanged).
    const second = await m.wait(
      m.startObsidian({ source: "folder", origin: VAULT, parentId: null, createTasks: true }).job
        .id,
      10_000,
    );
    expect(second?.report.created).toBe(0);
    expect(second?.details).toMatchObject({ tasks: { created: 0, unchanged: 4 } });
    expect(tables.tasks.size).toBe(4);

    const undone = await m.undo(job.id);
    expect(undone?.undoneAt).toBeTruthy();
    expect(undone?.undoReport).toMatchObject({ entitiesDeleted: 5 });
    expect(store.tree().length).toBe(0);
    expect(tables.tasks.size).toBe(0);
    await expect(m.undo(job.id)).rejects.toThrow(/already undone/);
  });

  it("imports a git vault via the injected cloner", async () => {
    const { deps } = memDeps();
    const m = new ImportJobManager({
      dir: path.join(tmp, "jobs"),
      resolveApiKey: () => null,
      createClient: () => {
        throw new Error("no");
      },
      broadcast: () => {},
      documentsChanged: () => {},
      storeAt: () => store,
      mappingDeps: async () => deps,
      extractAttachment: null,
      gitClone: async (_url, dest) => {
        fs.cpSync(VAULT, dest, { recursive: true });
      },
    });
    const { job } = m.startObsidian({
      source: "git",
      origin: "https://github.com/me/notes.git",
      parentId: null,
    });
    const done = await m.wait(job.id, 10_000);
    expect(done?.status).toBe("done");
    expect(done?.label).toBe("notes");
    expect(store.tree().some((n) => n.title === "Home")).toBe(true);
  });

  it("records mapping runs as undoable jobs", async () => {
    await importApi(loadWs());
    const { deps, tables } = memDeps();
    const { m } = manager(deps);
    const job = await m.runMapping({ folderId: folder("Projects").id, role: "projects" });
    expect(job).toMatchObject({ kind: "map", status: "done", undoable: 2 });
    expect(tables.projects.size).toBe(2);
    expect(m.list().map((j) => j.id)).toContain(job.id);
    await m.undo(job.id);
    expect(tables.projects.size).toBe(0);
    expect(journalSize(emptyJournal())).toBe(0);
  });
});

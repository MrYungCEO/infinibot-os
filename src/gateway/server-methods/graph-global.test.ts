import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildNameIndex,
  computeInsights,
  deriveProjectHealth,
  findMentions,
  STALE_AFTER_MS,
} from "./graph-global-derive.js";

// Clients / opportunities / people / decisions are graphed only while the
// Business & Agency plugin is loaded (src/business-agency/runtime.ts).
const businessAgency = vi.hoisted(() => ({ on: true }));
vi.mock("../../business-agency/runtime.js", () => ({
  isBusinessAgencyActive: () => businessAgency.on,
}));

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-26T12:00:00Z");

describe("deriveProjectHealth", () => {
  const base = { lastActivityAt: NOW - DAY, overdue: 0, blocked: 0, live: false, now: NOW };

  it("maps raw kanban statuses", () => {
    expect(deriveProjectHealth({ ...base, status: "In progress" }).health).toBe("active");
    expect(deriveProjectHealth({ ...base, status: "Reviewing" }).health).toBe("review");
    expect(deriveProjectHealth({ ...base, status: "Awaiting Client" }).health).toBe("blocked");
    expect(deriveProjectHealth({ ...base, status: "Completed" }).health).toBe("done");
    expect(deriveProjectHealth({ ...base, status: "Cancelled" }).health).toBe("done");
    expect(deriveProjectHealth({ ...base, status: "Not started" }).health).toBe("backlog");
    expect(deriveProjectHealth({ ...base, status: undefined }).health).toBe("backlog");
  });

  it("flags overdue and stale open projects as at-risk", () => {
    const overdue = deriveProjectHealth({ ...base, status: "In progress", overdue: 2 });
    expect(overdue.health).toBe("at_risk");
    expect(overdue.reasons).toContain("2 overdue tasks");
    const stale = deriveProjectHealth({
      ...base,
      status: "In progress",
      lastActivityAt: NOW - STALE_AFTER_MS - DAY,
    });
    expect(stale.health).toBe("at_risk");
    expect(stale.stale).toBe(true);
    // Backlog projects are never "stale" — nobody promised progress.
    expect(deriveProjectHealth({ ...base, status: "Not started", lastActivityAt: 1 }).stale).toBe(
      false,
    );
  });

  it("live agent work promotes backlog to active and suppresses staleness", () => {
    const r = deriveProjectHealth({
      ...base,
      status: "Not started",
      live: true,
      lastActivityAt: 1,
    });
    expect(r.health).toBe("active");
    expect(r.stale).toBe(false);
  });

  it("blocked tasks block an otherwise active project", () => {
    expect(deriveProjectHealth({ ...base, status: "In progress", blocked: 1 }).health).toBe(
      "blocked",
    );
  });
});

describe("name mentions", () => {
  const index = buildNameIndex([
    { id: "project:robo", name: "RoboPark" },
    { id: "project:ws", name: "workspace" },
    { id: "project:josh", name: "Josh Golf" },
    { id: "project:dupe1", name: "Twin Name" },
    { id: "project:dupe2", name: "twin name" },
  ]);

  it("drops generic single words and ambiguous names", () => {
    const ids = index.map((e) => e.id).sort();
    expect(ids).toEqual(["project:josh", "project:robo"]);
  });

  it("matches whole words case-insensitively", () => {
    expect(findMentions("Notes from the robopark site visit", index)).toEqual(["project:robo"]);
    expect(findMentions("Proposal — Josh Golf (UK)", index)).toEqual(["project:josh"]);
    expect(findMentions("roboparking lot", index)).toEqual([]);
  });
});

describe("computeInsights", () => {
  it("surfaces blocked, stale, clientless projects, idle clients and orphan notes", () => {
    const nodes = [
      { id: "project:a", kind: "project", label: "A", meta: { health: "blocked" } },
      {
        id: "project:b",
        kind: "project",
        label: "B",
        meta: { health: "at_risk", stale: true, lastActivityAt: NOW - 30 * DAY, overdue: 3 },
      },
      { id: "project:c", kind: "project", label: "C", meta: { health: "done" } },
      { id: "client:x", kind: "client", label: "X", meta: { status: "active" } },
      {
        id: "client:y",
        kind: "client",
        label: "Y",
        meta: { status: "prospect", pipelineStatus: "lead" },
      },
      { id: "note:n", kind: "note", label: "Lonely" },
    ];
    const edges = [
      { source: "client:x", target: "project:c", rel: "client of" },
      { source: "client:y", target: "project:a", rel: "client of" },
    ];
    const insights = computeInsights(nodes, edges, NOW);
    const byId = new Map(insights.map((i) => [i.id, i]));
    expect(byId.get("blocked")?.nodeIds).toEqual(["project:a"]);
    expect(byId.get("stale")?.nodeIds).toEqual(["project:b"]);
    expect(byId.get("overdue")?.title).toMatch(/3 overdue tasks/);
    expect(byId.get("no-client")?.nodeIds).toEqual(["project:b"]);
    // X is an active client whose only project is done; Y is just a lead.
    expect(byId.get("idle-client")?.nodeIds).toEqual(["client:x"]);
    expect(byId.get("orphan-notes")?.nodeIds).toEqual(["note:n"]);
  });
});

describe("buildSnapshot (real stores, temp state dir)", () => {
  let stateDir: string;
  let prevStateDir: string | undefined;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-graph-"));
    prevStateDir = process.env.INFINIBOT_STATE_DIR;
    process.env.INFINIBOT_STATE_DIR = stateDir;

    const { getKanbanStore } = await import("../../tasks/store.js");
    const kanban = getKanbanStore(stateDir);
    await kanban.createProject({ id: "p-robo", name: "RoboPark", status: "In progress" });
    await kanban.createProject({ id: "p-idle", name: "Internal Tooling", status: "Not started" });
    await kanban.createProject({
      id: "p-sub",
      name: "RoboPark Phase Two",
      status: "Reviewing",
      parentProjectId: "p-robo",
    });
    await kanban.createTask({ projectId: "p-robo", title: "Wire voice", status: "done" });
    await kanban.createTask({
      projectId: "p-robo",
      title: "Ship kiosk",
      status: "in_progress",
      dueDate: "2020-01-01",
    });
    await kanban.createTask({ projectId: "p-idle", title: "Someday", status: "backlog" });

    const { getAgencyOperationsStore } = await import("../../agency-operations/store.js");
    const agency = getAgencyOperationsStore(stateDir);
    ids.exampleClient = agency.createClient({
      name: "Example RoboPark",
      pipelineStatus: "active",
    }).id;
    ids.cold = agency.createClient({ name: "Cold Lead Co", pipelineStatus: "cold" }).id;
    ids.gengu = agency.createClient({ name: "Gengu Dinosaurs", pipelineStatus: "cold" }).id;

    const { getOpportunityStore } = await import("../../opportunity/store.js");
    ids.opp = getOpportunityStore(stateDir).create({
      name: "Gengu voice deal",
      owner: "ceo",
      clientId: ids.gengu,
      projectId: "p-sub",
    }).id;

    const { getIssuesStore } = await import("../../issues/store.js");
    ids.issue = getIssuesStore(stateDir).create({
      title: "Kiosk mic dead",
      relatedProject: "RoboPark",
    }).id;

    const { getRelationsStore } = await import("../../relations/store.js");
    getRelationsStore(stateDir).create({
      fromType: "client",
      fromId: ids.exampleClient,
      edge: "relates_to",
      toType: "project",
      toId: "p-idle",
    });

    // Notes live wherever the notes RPC puts them: the role-mapped
    // database on a seeded install, the file store otherwise.
    const bridge = await import("../../databases/system-role-bridge.js");
    const { NoteStore } = await import("../../notes/store.js");
    const addNote = (name: string, body: string) => {
      if (bridge.getRoleMode("notes").mode === "database") {
        bridge.upsertRowForRole("notes", { title: name, body });
      } else new NoteStore(stateDir).create({ name, body, tags: [] });
    };
    addNote("RoboPark continuation plan", "Next steps.");
    addNote("Linked note", "See [[RoboPark continuation plan]]");
    addNote("Random musing", "nothing here");
  });

  afterAll(() => {
    if (prevStateDir === undefined) delete process.env.INFINIBOT_STATE_DIR;
    else process.env.INFINIBOT_STATE_DIR = prevStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  async function snap(kinds: string[], extra: Record<string, unknown> = {}) {
    const { buildSnapshot } = await import("./graph-global.js");
    return buildSnapshot({
      kinds: new Set(kinds as never[]),
      maxRowsPerDatabase: 50,
      stateDir,
      now: NOW,
      ...extra,
    });
  }

  it("never touches task rows unless tasks are requested", async () => {
    const { KanbanStore } = (await import("../../tasks/store.js")) as unknown as {
      KanbanStore: { prototype: Record<string, (...a: unknown[]) => unknown> };
    };
    const { DEFAULT_KINDS } = await import("./graph-global.js");
    expect(DEFAULT_KINDS).not.toContain("task");
    const getTasks = vi.spyOn(KanbanStore.prototype, "getTasks");
    const recent = vi.spyOn(KanbanStore.prototype, "getRecentTasks");
    const s = await snap(DEFAULT_KINDS);
    expect(s.nodes.some((n) => n.kind === "task")).toBe(false);
    expect(getTasks).not.toHaveBeenCalled();
    expect(recent).not.toHaveBeenCalled();
    getTasks.mockRestore();
    recent.mockRestore();
  });

  it("reads local-first role tables (no Notion) and reflects a task re-assign", async () => {
    const ops = await import("../../databases/kanban-store-ops.js");
    const a = ops.upsertProject(
      { name: "Local Alpha", status: "In progress" },
      { syncToNotion: false },
    );
    const b = ops.upsertProject(
      { name: "Local Beta", status: "In progress" },
      { syncToNotion: false },
    );
    const t = ops.upsertTask(
      { title: "Local task", status: "review", projectId: a.id },
      { syncToNotion: false },
    );
    let s = await snap(["project", "task"], { taskProjectIds: [a.id] });
    const alpha = s.nodes.find((n) => n.id === `project:${a.id}`)!;
    expect(alpha.meta?.tasks).toBe(1);
    expect(alpha.meta?.review).toBe(1);
    expect(s.edges).toContainEqual({
      source: `project:${a.id}`,
      target: `task:${t.id}`,
      rel: "contains",
    });
    // Legacy kanban.db projects are still graphed alongside.
    expect(s.nodes.some((n) => n.id === "project:p-robo")).toBe(true);
    // Task meta carries no tags here (role tables don't keep them) → UI won't clobber.
    expect(s.nodes.find((n) => n.id === `task:${t.id}`)?.meta?.tags).toBeUndefined();
    ops.upsertTask({ id: t.id, projectId: b.id }, { syncToNotion: false });
    s = await snap(["project", "task"], { taskProjectIds: [b.id] });
    expect(s.edges).toContainEqual({
      source: `project:${b.id}`,
      target: `task:${t.id}`,
      rel: "contains",
    });
    expect(s.nodes.find((n) => n.id === `project:${a.id}`)?.meta?.tasks).toBe(0);
    ops.deleteTask(t.id);
    ops.deleteProject(a.id);
    ops.deleteProject(b.id);
  });

  it("puts task rollups + health on project nodes", async () => {
    const s = await snap(["project"]);
    const robo = s.nodes.find((n) => n.id === "project:p-robo")!;
    expect(robo.meta).toMatchObject({ tasks: 2, done: 1, inProgress: 1, overdue: 1 });
    expect(robo.meta?.progress).toBe(0.5);
    expect(robo.meta?.health).toBe("at_risk");
    expect(s.edges).toContainEqual(
      expect.objectContaining({
        source: "project:p-sub",
        target: "project:p-robo",
        rel: "sub-project of",
      }),
    );
  });

  it("lazily expands one project's tasks", async () => {
    const s = await snap(["project", "task"], { taskProjectIds: ["p-robo"] });
    const tasks = s.nodes.filter((n) => n.kind === "task");
    expect(tasks.map((t) => t.label).sort()).toEqual(["Ship kiosk", "Wire voice"]);
    expect(s.edges.filter((e) => e.rel === "contains")).toHaveLength(2);
  });

  it("links clients, opportunities, issues and notes to projects", async () => {
    const { DEFAULT_KINDS } = await import("./graph-global.js");
    const s = await snap(DEFAULT_KINDS);
    const has = (source: string, target: string, rel?: string) =>
      s.edges.some(
        (e) => e.source === source && e.target === target && (rel == null || e.rel === rel),
      );
    const exampleClient = `client:${ids.exampleClient}`;
    const gengu = `client:${ids.gengu}`;
    // Stored relation + inferred name match ("RoboPark" ⊂ "Example RoboPark").
    expect(has(exampleClient, "project:p-idle", "relates to")).toBe(true);
    expect(has(exampleClient, "project:p-robo", "client of")).toBe(true);
    expect(has(`opportunity:${ids.opp}`, gengu, "for client")).toBe(true);
    expect(has(`opportunity:${ids.opp}`, "project:p-sub", "for project")).toBe(true);
    expect(has(`issue:${ids.issue}`, "project:p-robo", "affects")).toBe(true);
    const planNote = s.nodes.find((n) => n.label === "RoboPark continuation plan")!;
    const linkedNote = s.nodes.find((n) => n.label === "Linked note")!;
    expect(has(planNote.id, "project:p-robo", "mentions")).toBe(true);
    expect(has(linkedNote.id, planNote.id, "links")).toBe(true);
    // Dormant client with no links is pruned; linked cold client is kept.
    expect(s.nodes.some((n) => n.id === `client:${ids.cold}`)).toBe(false);
    expect(s.nodes.some((n) => n.id === gengu)).toBe(true);
    expect(s.hidden?.client).toBe(1);
    const exampleClientNode = s.nodes.find((n) => n.id === exampleClient)!;
    expect(exampleClientNode.meta).toMatchObject({ projects: 2, openProjects: 1 });
    expect(s.insights?.find((i) => i.id === "orphan-notes")?.nodeIds).toHaveLength(1);
    // Every edge endpoint exists.
    const nodeIds = new Set(s.nodes.map((n) => n.id));
    expect(s.edges.every((e) => nodeIds.has(e.source) && nodeIds.has(e.target))).toBe(true);
  });

  it("graph.global.snapshot({projectId}) returns only that project's connected graph", async () => {
    const { graphGlobalHandlers, DEFAULT_KINDS } = await import("./graph-global.js");
    const call = async (params: Record<string, unknown>) => {
      let out: unknown;
      await graphGlobalHandlers["graph.global.snapshot"]!({
        params: { types: [...DEFAULT_KINDS, "task"], refresh: true, ...params },
        respond: (ok: boolean, payload: unknown, err?: unknown) => {
          if (!ok) throw new Error(JSON.stringify(err));
          out = payload;
        },
      } as never);
      return out as {
        nodes: Array<{ id: string; kind: string; label: string; meta?: Record<string, unknown> }>;
        edges: Array<{ source: string; target: string }>;
        scope: { found: boolean; projectNodeId: string; totalNodes: number; hops: number };
      };
    };
    const robo = await call({ projectId: "p-robo" });
    const labels = new Set(robo.nodes.map((n) => n.label));
    expect(robo.scope).toMatchObject({ found: true, projectNodeId: "project:p-robo", hops: 2 });
    expect(labels.has("Wire voice")).toBe(true);
    expect(labels.has("Ship kiosk")).toBe(true);
    expect(labels.has("RoboPark Phase Two")).toBe(true); // direct sub-project
    expect(labels.has("Kiosk mic dead")).toBe(true); // issue → affects
    expect(labels.has("RoboPark continuation plan")).toBe(true);
    // Unrelated: the other project's task and an unlinked note.
    expect(labels.has("Someday")).toBe(false);
    expect(labels.has("Random musing")).toBe(false);
    expect(labels.has("Internal Tooling")).toBe(false); // only via the shared client
    expect(robo.scope.totalNodes).toBeGreaterThan(robo.nodes.length);
    const ids = new Set(robo.nodes.map((n) => n.id));
    expect(robo.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);

    const idle = await call({ projectId: "p-idle", hops: 4 });
    const idleLabels = new Set(idle.nodes.map((n) => n.label));
    expect(idleLabels.has("Someday")).toBe(true);
    expect(idleLabels.has("Wire voice")).toBe(false);
    expect(idleLabels.has("Ship kiosk")).toBe(false);
    // Only this project's tasks were collected (no global task layer).
    expect(
      idle.nodes.filter((n) => n.kind === "task").every((n) => n.meta?.projectId === "p-idle"),
    ).toBe(true);
  });

  it("allClients keeps dormant clients", async () => {
    const s = await snap(["client"], { allClients: true });
    expect(s.nodes.filter((n) => n.kind === "client")).toHaveLength(3);
  });

  it("graphs no business objects while the Business & Agency plugin is off", async () => {
    businessAgency.on = false;
    try {
      const { DEFAULT_KINDS } = await import("./graph-global.js");
      const s = await snap(DEFAULT_KINDS, { allClients: true });
      const kinds = new Set(s.nodes.map((n) => n.kind));
      for (const k of ["client", "opportunity", "person", "decision"])
        expect(kinds.has(k as never), k).toBe(false);
      expect(kinds.has("project" as never)).toBe(true);
    } finally {
      businessAgency.on = true;
    }
  });
});

describe("documents in the knowledge graph", () => {
  it("adds imported docs as note nodes with their wikilink edges", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { DocumentStore } = await import("../../documents/store.js");
    const { importObsidianVault, vaultKeyFor } = await import("../../documents/obsidian/import.js");
    const { listFolderVault } = await import("../../documents/obsidian/vault-source.js");
    const { buildSnapshot } = await import("./graph-global.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-docs-"));
    try {
      const store = DocumentStore.at(path.join(dir, "documents"));
      const vault = path.join(
        import.meta.dirname,
        "..",
        "..",
        "documents",
        "obsidian",
        "__fixtures__",
        "vault",
      );
      await importObsidianVault(store, listFolderVault(vault), {
        vaultKey: vaultKeyFor("graph"),
        vaultName: "Vault",
        parentId: null,
      });
      const snap = await buildSnapshot({
        kinds: new Set(["note"]),
        maxRowsPerDatabase: 0,
        stateDir: dir,
      });
      const byLabel = new Map(snap.nodes.map((n) => [n.label, n.id]));
      expect([...byLabel.keys()]).toEqual(
        expect.arrayContaining(["Home", "Alpha", "Beta", "2026-10-07"]),
      );
      const linked = (a: string, b: string) =>
        snap.edges.some(
          (e) => e.source === byLabel.get(a) && e.target === byLabel.get(b) && e.rel === "links",
        );
      expect(linked("Home", "Alpha")).toBe(true);
      expect(linked("Beta", "Alpha")).toBe(true);
      expect(linked("2026-10-07", "Home")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

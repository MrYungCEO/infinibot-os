/**
 * Document types: built-in registry, custom CRUD (persisted), migration
 * inference + dry-run/apply, the create path honouring the type (RPC + agent
 * tool), and the ideas merge into the library list.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  BUILTIN_DOC_TYPES,
  DocTypeStore,
  DocTypeValidationError,
  effectiveDocType,
  inferDocType,
  renderTemplate,
} from "./doc-types.js";
import { buildLibrary } from "./library.js";
import { DocumentStore } from "./store.js";
import {
  applyTypeMigration,
  formatTypeMigrationReport,
  planTypeMigration,
} from "./type-migration.js";

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe("type registry", () => {
  it("ships the 13 built-in types with icon names (no emoji) and colours", () => {
    const ids = BUILTIN_DOC_TYPES.map((t) => t.id);
    expect(ids).toEqual([
      "note",
      "idea",
      "document",
      "meeting",
      "research",
      "report",
      "sop",
      "spec",
      "brief",
      "journal",
      "plan",
      "template",
      "snippet",
    ]);
    for (const t of BUILTIN_DOC_TYPES) {
      expect(t.icon).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
      expect(t.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t.builtin).toBe(true);
    }
    expect(BUILTIN_DOC_TYPES.find((t) => t.id === "idea")?.backing).toBe("ideas");
    const report = BUILTIN_DOC_TYPES.find((t) => t.id === "report")!;
    expect(report.backing).toBe("reports");
    expect(report.creatable).toBe(false);
  });

  it("fills {{date}} in templates", () => {
    expect(renderTemplate("## {{date}}\n", new Date("2026-10-14T12:00:00Z"))).toBe(
      "## 2026-10-14\n",
    );
    expect(renderTemplate(undefined)).toBe("");
  });
});

describe("custom types CRUD", () => {
  let root: string;
  let types: DocTypeStore;
  beforeEach(() => {
    root = tmp("ib-doctypes-");
    types = new DocTypeStore(root);
  });

  it("creates, renames, recolours, re-icons, reorders and archives — persisted to types.json", () => {
    const t = types.create({
      label: "Recipe",
      icon: "flame",
      color: "#AA3311",
      template: "## Ingredients\n",
    });
    expect(t.id).toBe("c-recipe");
    expect(t.builtin).toBe(false);
    expect(t.color).toBe("#aa3311");

    types.update(t.id, { label: "Recipes", color: "#112233", icon: "star" });
    types.reorder([t.id, "note"]);

    // A fresh instance reads the same file.
    const again = new DocTypeStore(root);
    const list = again.list();
    expect(list[0]).toMatchObject({
      id: "c-recipe",
      label: "Recipes",
      color: "#112233",
      icon: "star",
      order: 0,
    });
    expect(list[1]!.id).toBe("note");
    expect(list).toHaveLength(BUILTIN_DOC_TYPES.length + 1);

    again.archive(t.id);
    expect(new DocTypeStore(root).get(t.id)?.archived).toBe(true);
    expect(again.assignable(t.id)).toBe(false);
    again.archive(t.id, false);
    expect(again.assignable(t.id)).toBe(true);
    const file = JSON.parse(fs.readFileSync(path.join(root, "types.json"), "utf8"));
    expect(file.custom[0].label).toBe("Recipes");
  });

  it("built-ins can be hidden/recoloured but never renamed, archived or deleted", () => {
    types.update("journal", { hidden: true, color: "#000000" });
    const j = types.get("journal")!;
    expect(j.hidden).toBe(true);
    expect(j.color).toBe("#000000");
    expect(() => types.update("journal", { label: "Diary" })).toThrow(DocTypeValidationError);
    expect(() => types.update("journal", { archived: true })).toThrow(/hide/);
    // archive() on a built-in hides it instead.
    types.archive("plan");
    expect(types.get("plan")?.hidden).toBe(true);
    expect(types.list().filter((t) => t.builtin)).toHaveLength(BUILTIN_DOC_TYPES.length);
  });

  it("validates labels, colours, icons and duplicates", () => {
    expect(() => types.create({ label: "" })).toThrow(/label/);
    expect(() => types.create({ label: "x".repeat(41) })).toThrow(/40/);
    expect(() => types.create({ label: "Ok", color: "red" })).toThrow(/colour/);
    expect(() => types.create({ label: "Ok", icon: "🔥" })).toThrow(/icon/);
    expect(() => types.create({ label: "plan" })).toThrow(/already exists/);
    types.create({ label: "Client" });
    expect(() => types.create({ label: "client" })).toThrow(/already exists/);
    expect(() => types.update("c-nope", { label: "x" })).toThrow(/not found/);
  });
});

describe("migration inference", () => {
  const doc = (title: string, extra: Record<string, unknown> = {}) =>
    ({ kind: "doc", title, ...extra }) as Parameters<typeof inferDocType>[0];

  it.each([
    ["COO Standup — 2026-07-06", "meeting"],
    ["Weekly sync with design", "meeting"],
    ["Hardware Instability — i9-14900K Vmin Shift (Diagnostic Log)", "journal"],
    ["seedance-2.0-prompt-anatomy.md", "snippet"],
    ["seedance-2.0-skill.md", "sop"],
    ["Phase 1 Operations Build Specification", "spec"],
    ["Funnel System — Gap Analysis & Implementation Plan", "plan"],
    ["Desktop Control System — Full Reference", "sop"],
    ["Proposal — Josh Golf (UK Golf Consumables Subscription App)", "brief"],
    ["Hermes Agent Competitor Report", "research"],
    ["Latest World News — July 2026", "research"],
    ["WhatsApp → Comms Hub message sync (root cause + fix)", "note"],
    ["Blog catalog dialog", "note"],
    ["Planet facts", "note"],
  ])("title %s → %s", (title, type) => {
    expect(inferDocType(doc(title)).type).toBe(type);
  });

  it("prefers legacy category property, then tags, then title, then source", () => {
    expect(inferDocType(doc("Plan for x", { properties: { Category: "log" } }))).toEqual({
      type: "journal",
      reason: "property Category=log",
    });
    expect(inferDocType(doc("Overview", { tags: ["kingly", "research"] })).type).toBe("research");
    expect(inferDocType(doc("Overview", { source: { type: "notion", id: "x" } })).type).toBe(
      "document",
    );
    expect(inferDocType(doc("Overview", { source: { type: "obsidian", id: "x" } })).type).toBe(
      "note",
    );
    expect(inferDocType({ kind: "file", title: "scan.pdf" } as never).type).toBe("document");
    expect(inferDocType(doc("Overview")).type).toBe("note");
    // A property naming a custom type by label maps to it.
    expect(
      inferDocType(doc("x", { properties: { Type: "Recipe" } }), [
        { id: "c-recipe", label: "Recipe" },
      ]).type,
    ).toBe("c-recipe");
  });

  it("an explicit type always wins over inference; folders have no type", () => {
    expect(effectiveDocType({ kind: "doc", title: "Q3 Plan", type: "note" } as never)).toEqual({
      type: "note",
      inferred: false,
    });
    expect(effectiveDocType({ kind: "doc", title: "Q3 Plan" } as never)).toEqual({
      type: "plan",
      inferred: true,
    });
    expect(effectiveDocType({ kind: "folder", title: "Plans" } as never).type).toBeNull();
  });

  it("dry run reports without writing; apply backs up first and never touches typed docs", () => {
    const root = tmp("ib-doctypes-mig-");
    const store = new DocumentStore(root);
    store.create({ kind: "folder", title: "Notes" });
    const a = store.create({ kind: "doc", title: "COO Standup — Monday", body: "x" });
    const b = store.create({ kind: "doc", title: "Roadmap 2027", body: "y" });
    const c = store.create({ kind: "doc", title: "Random thought", body: "z", type: "brief" });
    const indexBefore = fs.readFileSync(path.join(root, "index.json"), "utf8");
    const updatedBefore = store.getNode(a.id)!.updatedAt;

    const plan = planTypeMigration(store);
    expect(plan.dryRun).toBe(true);
    expect(plan).toMatchObject({ documents: 3, folders: 1, alreadyTyped: 1, toSet: 2 });
    expect(plan.byType).toEqual({ meeting: 1, plan: 1 });
    expect(fs.readFileSync(path.join(root, "index.json"), "utf8")).toBe(indexBefore);
    expect(formatTypeMigrationReport(plan)).toContain("DRY RUN");

    const applied = applyTypeMigration(store);
    expect(applied.applied).toBe(2);
    expect(applied.backupPath && fs.readFileSync(applied.backupPath, "utf8")).toBe(indexBefore);
    const fresh = new DocumentStore(root);
    expect(fresh.getNode(a.id)?.type).toBe("meeting");
    expect(fresh.getNode(b.id)?.type).toBe("plan");
    expect(fresh.getNode(c.id)?.type).toBe("brief");
    expect(fresh.getNode(a.id)?.updatedAt).toBe(updatedBefore);
    expect(fresh.getBody(a.id)).toBe("x");
    // Idempotent.
    expect(applyTypeMigration(fresh)).toMatchObject({ toSet: 0, applied: 0, backupPath: null });
  });
});

describe("ideas merge into the library", () => {
  it("lists docs, ideas, reports and research together with per-type counts and filters", () => {
    const root = tmp("ib-doctypes-lib-");
    const store = new DocumentStore(root);
    const folder = store.create({ kind: "folder", title: "Work" });
    store.create({ kind: "doc", title: "Kickoff meeting", parentId: folder.id, body: "agenda" });
    store.create({ kind: "doc", title: "Scratch", body: "", type: "note", category: "personal" });
    const docs = store.tree().map((node) => ({ node, path: store.pathString(node.id) }));
    const ideas = [
      {
        id: "i1",
        title: "Voice-first CRM",
        body: "talk to it",
        tags: ["crm"],
        status: "new",
        createdAt: "2026-10-10T00:00:00Z",
        updatedAt: "2026-10-12T00:00:00Z",
      },
      {
        id: "i2",
        title: "Kickoff template",
        body: "",
        tags: [],
        status: "promoted",
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z",
        promotedTo: { kind: "document", id: "d9" },
      },
    ];
    const reports = [
      {
        id: "r1",
        kind: "research_brief",
        title: "Market scan",
        status: "rendered",
        category: "research",
        createdAt: Date.parse("2026-09-01"),
      },
    ];
    const research = [
      {
        id: "res1",
        name: "Kokoro TTS comparison",
        createdAt: 1,
        updatedAt: Date.parse("2026-08-01"),
      },
    ];

    const all = buildLibrary({ docs, ideas, reports, research, types: [] });
    expect(all.counts.all).toBe(6); // folder excluded
    expect(all.counts.byType).toEqual({ meeting: 1, note: 1, idea: 2, report: 1, research: 1 });
    expect(all.counts.byCategory).toEqual({ personal: 1 }); // report categories stay on the Reports page
    expect(all.items.find((i) => i.id === "i2")).toMatchObject({
      source: "idea",
      type: "idea",
      status: "promoted",
      promotedTo: { kind: "document", id: "d9" },
    });
    expect(all.items.find((i) => i.id === "r1")?.readOnly).toBe(true);

    const onlyIdeas = buildLibrary({ docs, ideas, reports, research, types: [] }, { type: "idea" });
    expect(onlyIdeas.items.map((i) => i.id)).toEqual(["i1", "i2"]); // newest first
    expect(onlyIdeas.counts.all).toBe(6); // counts ignore the type filter

    const search = buildLibrary(
      { docs, ideas, reports, research, types: [] },
      { query: "kickoff" },
    );
    expect(search.items.map((i) => i.source).sort()).toEqual(["doc", "idea"]);
    expect(search.counts.byType).toEqual({ meeting: 1, idea: 1 });

    const cat = buildLibrary({ docs, ideas, types: [] }, { category: "personal" });
    expect(cat.items.map((i) => i.title)).toEqual(["Scratch"]);
  });
});

describe("create path honours the type (service + RPC + agent tool)", () => {
  let stateDir: string;
  const prevEnv = process.env.INFINIBOT_STATE_DIR;
  beforeAll(() => {
    stateDir = tmp("ib-doctypes-svc-");
    process.env.INFINIBOT_STATE_DIR = stateDir;
  });
  afterAll(() => {
    if (prevEnv === undefined) delete process.env.INFINIBOT_STATE_DIR;
    else process.env.INFINIBOT_STATE_DIR = prevEnv;
  });

  async function rpc(method: string, params: Record<string, unknown>) {
    const { documentsHandlers } = await import("../gateway/server-methods/documents.js");
    let out: { ok: boolean; payload?: any; error?: any } = { ok: false };
    await documentsHandlers[method]!({
      params,
      respond: (ok: boolean, payload?: unknown, error?: unknown) => {
        out = { ok, payload, error };
      },
    } as never);
    return out;
  }

  it("documents.create stores the type, applies the template and reads back", async () => {
    const created = await rpc("documents.create", {
      kind: "doc",
      title: "Sprint review",
      type: "meeting",
    });
    expect(created.ok).toBe(true);
    expect(created.payload.node.type).toBe("meeting");
    const got = await rpc("documents.get", { id: created.payload.node.id });
    expect(got.payload.node.type).toBe("meeting");
    expect(got.payload.node.typeInferred).toBeUndefined();
    expect(got.payload.body).toContain("## Action items");

    const changed = await rpc("documents.update", {
      id: created.payload.node.id,
      type: "spec",
      category: "Acme",
    });
    expect(changed.payload.node).toMatchObject({ type: "spec", category: "Acme" });

    const bad = await rpc("documents.create", { kind: "doc", title: "x", type: "nope" });
    expect(bad.ok).toBe(false);
    expect(bad.error.message).toMatch(/Unknown document type/);
    const report = await rpc("documents.create", { kind: "doc", title: "x", type: "report" });
    expect(report.error.message).toMatch(/read-only/);
  });

  it("custom types via RPC, then a doc created with one, listed by type in documents.library", async () => {
    const t = await rpc("documents.types.create", {
      label: "Client brief",
      icon: "briefcase",
      color: "#336699",
    });
    expect(t.ok).toBe(true);
    const id = t.payload.type.id as string;
    await rpc("documents.create", { kind: "doc", title: "Acme onboarding", type: id, body: "hi" });
    const lib = await rpc("documents.library", { type: id, include: [] });
    expect(lib.ok).toBe(true);
    expect(lib.payload.items.map((i: any) => i.title)).toEqual(["Acme onboarding"]);
    expect(lib.payload.counts.byType[id]).toBe(1);
    const list = await rpc("documents.types.list", {});
    expect(list.payload.types.some((x: any) => x.id === id)).toBe(true);
    await rpc("documents.types.archive", { id });
    const blocked = await rpc("documents.create", { kind: "doc", title: "x", type: id });
    expect(blocked.error.message).toMatch(/archived/);
  });

  it("agent notes tool: create_doc/create with type, idea → Ideas store, list by type", async () => {
    const { createNotesTool } = await import("../agents/tools/notes-tool.js");
    const tool = createNotesTool({ agentId: "tester" });
    const run = async (args: Record<string, unknown>) => {
      const r = (await tool.execute("call", args as never)) as {
        details?: any;
        content?: Array<{ text: string }>;
      };
      return r.details ?? JSON.parse(r.content![0]!.text);
    };
    const doc = await run({
      action: "create_doc",
      title: "Onboarding runbook",
      type: "sop",
      body: "steps",
    });
    expect(doc.status).toBe("ok");
    expect(doc.node.type).toBe("sop");

    const note = await run({
      action: "create",
      name: "Daily log",
      body: "did things",
      type: "journal",
    });
    expect(note.status).toBe("ok");
    expect(note.document?.type).toBe("journal");

    const idea = await run({
      action: "create",
      name: "Phone widget for capture",
      body: "",
      type: "idea",
    });
    expect(idea).toMatchObject({ status: "ok", type: "idea" });
    const { getIdeaStore } = await import("../ideas/store.js");
    expect(
      getIdeaStore(stateDir)
        .list({})
        .some((i) => i.title === "Phone widget for capture"),
    ).toBe(true);

    const listed = await run({ action: "list", type: "idea" });
    expect(listed.items.map((i: any) => i.title)).toContain("Phone widget for capture");
    const sops = await run({ action: "library", type: "sop" });
    expect(sops.items.map((i: any) => i.title)).toEqual(["Onboarding runbook"]);

    // Backward compatible: create without type is still a plain note.
    const plain = await run({ action: "create", name: "Plain", body: "x" });
    expect(plain.status).toBe("ok");
    expect(plain.document).toBeUndefined();
  });
});

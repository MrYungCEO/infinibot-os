import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractDueDate,
  extractTags,
  heuristicDraft,
  inferProject,
  mergeModelDraft,
  parseJsonObject,
  structureCapture,
} from "./capture.js";
import {
  createIdea,
  linkIdea,
  promoteIdea,
  saveCapture,
  type GatewayCall,
  type RelationWriter,
} from "./service.js";
import { IdeaStore, IdeaValidationError } from "./store.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ideas-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function memRelations(): RelationWriter & {
  edges: Array<{ fromType: string; fromId: string; edge: string; toType: string; toId: string }>;
} {
  const edges: Array<{
    fromType: string;
    fromId: string;
    edge: string;
    toType: string;
    toId: string;
  }> = [];
  return {
    edges,
    link: (e) => {
      if (!edges.some((x) => x.fromId === e.fromId && x.edge === e.edge && x.toId === e.toId))
        edges.push(e);
    },
    unlink: (e) => {
      for (let i = edges.length - 1; i >= 0; i--)
        if (edges[i].fromId === e.fromId && edges[i].toId === e.toId) edges.splice(i, 1);
    },
    linksFrom: (t, id) => edges.filter((e) => e.fromType === t && e.fromId === id),
  };
}

/** Records in-process RPC calls and answers like the real stores. */
function fakeCall(): GatewayCall & { calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let n = 0;
  const fn = (async (method: string, params: Record<string, unknown>) => {
    calls.push([method, params]);
    n += 1;
    if (method === "kanban.tasks.create") return { id: `task-${n}`, title: params.title };
    if (method === "kanban.projects.create") return { id: `proj-${n}`, name: params.name };
    if (method === "notes.create") return { id: `note-${n}`, name: params.name };
    throw new Error(`unexpected ${method}`);
  }) as GatewayCall & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe("IdeaStore", () => {
  it("creates, lists (query / status / tag), updates, deletes and persists to <stateDir>/ideas/ideas.json", () => {
    const dir = tmp();
    const store = new IdeaStore(dir);
    const a = store.create({
      title: "  Voice journaling app ",
      body: "Talk, it writes",
      tags: ["#Voice", "apps", "voice"],
    }).idea;
    store.create({ title: "Pricing page refresh", tags: ["web"], status: "parked" });
    expect(a.title).toBe("Voice journaling app");
    expect(a.tags).toEqual(["voice", "apps"]);
    expect(a.status).toBe("new");
    expect(a.id).toMatch(/^idea_/);
    expect(store.list({ query: "writes" }).map((i) => i.id)).toEqual([a.id]);
    expect(store.list({ status: "parked" })).toHaveLength(1);
    expect(store.list({ tag: "#voice" })).toHaveLength(1);
    expect(store.counts()).toMatchObject({ new: 1, parked: 1, exploring: 0, promoted: 0 });
    expect(store.tags()[0]).toEqual({ tag: "apps", count: 1 });

    store.update(a.id, { status: "exploring", body: "v2" });
    const disk = JSON.parse(readFileSync(join(dir, "ideas", "ideas.json"), "utf8"));
    expect(disk.ideas.find((i: { id: string }) => i.id === a.id)).toMatchObject({
      status: "exploring",
      body: "v2",
    });

    // A fresh store over the same dir reads it back.
    expect(new IdeaStore(dir).get(a.id)?.status).toBe("exploring");
    expect(store.delete(a.id)).toBe(true);
    expect(store.get(a.id)).toBeNull();
  });

  it("is idempotent per clientRequestId (offline retry)", () => {
    const store = new IdeaStore(tmp());
    const first = store.create({ title: "x", clientRequestId: "cap-1" });
    const again = store.create({ title: "x (retry)", clientRequestId: "cap-1" });
    expect(again.created).toBe(false);
    expect(again.idea.id).toBe(first.idea.id);
    expect(store.list()).toHaveLength(1);
  });

  it("rejects an empty title and a bad status", () => {
    const store = new IdeaStore(tmp());
    expect(() => store.create({ title: "   " })).toThrow(IdeaValidationError);
    const { idea } = store.create({ title: "ok" });
    expect(() => store.update(idea.id, { status: "done" as never })).toThrow(/status must be/);
  });
});

describe("capture heuristics", () => {
  const now = new Date(2026, 9, 13, 10, 0, 0); // Tue 13 Oct 2026

  it("due dates: relative, weekday, month-day", () => {
    expect(extractDueDate("call the bank tomorrow", now).dueDate).toBe("2026-10-14");
    expect(extractDueDate("ship it by Friday", now)).toEqual({
      dueDate: "2026-10-16",
      phrase: "by Friday",
      rest: "ship it",
    });
    expect(extractDueDate("review next Friday", now).dueDate).toBe("2026-10-23");
    expect(extractDueDate("file taxes on October 20th", now).dueDate).toBe("2026-10-20");
    expect(extractDueDate("renew in 3 days", now).dueDate).toBe("2026-10-16");
    expect(extractDueDate("no deadline here", now).dueDate).toBeUndefined();
  });

  it("tags: #hashtags and a trailing 'tag it X and Y'", () => {
    expect(extractTags("buy a mic #studio")).toEqual({ tags: ["studio"], rest: "buy a mic" });
    expect(extractTags("Pitch deck for the fund, tag it finance and investors")).toEqual({
      tags: ["finance", "investors"],
      rest: "Pitch deck for the fund",
    });
  });

  it("project inference picks the longest whole-word project name", () => {
    const projects = [
      { id: "p1", name: "Robovoice" },
      { id: "p2", name: "Robovoice Cloud" },
      { id: "p3", name: "Ads" },
    ];
    expect(inferProject("fix the robovoice cloud billing", projects)?.id).toBe("p2");
    expect(inferProject("nothing about roads", projects)).toBeUndefined();
  });

  it("task draft strips the lead-in and fills due date, priority and project", () => {
    const d = heuristicDraft(
      "task",
      "Remind me to send the FlyPic invoice to Gengu by Friday, it's urgent",
      {
        now,
        projects: [{ id: "fp", name: "FlyPic" }],
      },
    );
    expect(d).toMatchObject({
      kind: "task",
      title: "Send the FlyPic invoice to Gengu, it's urgent",
      dueDate: "2026-10-16",
      priority: "high",
      projectId: "fp",
      structuredBy: "heuristic",
    });
  });

  it("log entries get a dated title and the log tag", () => {
    const d = heuristicDraft("log", "log that the 5090 render took 41 minutes", { now });
    expect(d.title).toMatch(/^Log · 2026-10-1/);
    expect(d.tags).toContain("log");
    expect(d.body).toBe("The 5090 render took 41 minutes");
  });
});

describe("structureCapture with a mocked LLM", () => {
  const now = new Date(2026, 9, 13, 10, 0, 0);
  const projects = [{ id: "kv", name: "KinglyVault" }];

  it("merges a valid model reply (title/body/tags/project/due/priority)", async () => {
    const complete = vi.fn(async (_s: string, user: string) => {
      expect(user).toContain("KinglyVault");
      return '```json\n{"title":"Add annual plan to KinglyVault","body":"Offer a yearly CEO plan at 2 months free.","tags":["pricing","Vault"],"projectId":"kv","dueDate":"2026-10-30","priority":"high"}\n```';
    });
    const d = await structureCapture(
      "task",
      "um we should add an annual plan to kingly vault by the 30th of october",
      { complete, now, projects },
    );
    expect(d).toMatchObject({
      structuredBy: "ai",
      title: "Add annual plan to KinglyVault",
      body: "Offer a yearly CEO plan at 2 months free.",
      projectId: "kv",
      projectName: "KinglyVault",
      dueDate: "2026-10-30",
      priority: "high",
    });
    expect(d.tags).toEqual(["pricing", "vault"]);
  });

  it("ignores a model-invented project id and bad fields", () => {
    const base = heuristicDraft("note", "random thought", { now });
    const merged = mergeModelDraft(
      base,
      { title: "T", projectId: "nope", tags: ["ok", "bad tag!"], dueDate: "soon" },
      projects,
    );
    expect(merged.projectId).toBeUndefined();
    expect(merged.tags).toEqual(["ok"]);
    expect(merged.dueDate).toBeUndefined();
  });

  it("falls back to the heuristic draft on bad JSON, errors and no model", async () => {
    expect(parseJsonObject("sure! here you go")).toBeNull();
    const bad = await structureCapture("idea", "what if the app had a face", {
      complete: async () => "not json",
      now,
    });
    expect(bad).toMatchObject({
      structuredBy: "heuristic",
      aiError: "model reply was not JSON",
      title: "The app had a face",
    });
    const err = await structureCapture("idea", "x y z", {
      complete: async () => Promise.reject(new Error("401")),
      now,
    });
    expect(err.aiError).toBe("401");
    const none = await structureCapture("note", "hello world", { complete: null, now });
    expect(none).toMatchObject({ structuredBy: "heuristic", aiError: "no model available" });
  });

  it("times out a slow model and keeps the heuristic draft", async () => {
    const d = await structureCapture("note", "slow model", {
      complete: () => new Promise((r) => setTimeout(() => r('{"title":"late"}'), 200)),
      timeoutMs: 20,
      now,
    });
    expect(d.structuredBy).toBe("heuristic");
    expect(d.aiError).toBe("timed out");
  });
});

describe("promotion + linking (service, mocked RPCs)", () => {
  it("promotes an idea into a task through kanban.tasks.create and links both ways", async () => {
    const dir = tmp();
    const store = new IdeaStore(dir);
    const call = fakeCall();
    const relations = memRelations();
    const { idea } = await createIdea(
      {
        title: "Face for InfiniBot",
        body: "Blob face on calls",
        tags: ["mobile"],
        projectIds: ["p9"],
      },
      { store, relations, call },
    );
    expect(relations.edges).toEqual([
      expect.objectContaining({ edge: "idea_about_project", toId: "p9" }),
    ]);

    const res = await promoteIdea(idea.id, "task", {}, { store, call, relations });
    expect(call.calls[0][0]).toBe("kanban.tasks.create");
    expect(call.calls[0][1]).toMatchObject({
      title: "Face for InfiniBot",
      projectId: "p9",
      status: "todo",
    });
    expect(String(call.calls[0][1].description)).toContain("Promoted from idea");
    expect(res.target).toMatchObject({ kind: "task", id: "task-1" });
    expect(res.idea).toMatchObject({
      status: "promoted",
      promotedTo: { kind: "task", id: "task-1" },
      taskIds: ["task-1"],
    });
    expect(relations.edges.map((e) => e.edge)).toEqual([
      "idea_about_project",
      "idea_becomes_task",
      "project_has_task",
    ]);

    // Promoting to the same kind again returns the first target (no duplicate task).
    const again = await promoteIdea(idea.id, "task", {}, { store, call, relations });
    expect(again.target.id).toBe("task-1");
    expect(call.calls).toHaveLength(1);
  });

  it("promotes into a project and into a document", async () => {
    const store = new IdeaStore(tmp());
    const call = fakeCall();
    const a = (
      await createIdea({ title: "Studio rental side business" }, { store, call, relations: null })
    ).idea;
    const p = await promoteIdea(a.id, "project", {}, { store, call, relations: null });
    expect(call.calls[0]).toEqual([
      "kanban.projects.create",
      expect.objectContaining({ name: "Studio rental side business" }),
    ]);
    expect(p.idea.projectIds).toContain(p.target.id);

    const b = (
      await createIdea(
        { title: "Essay on agents", body: "draft", tags: ["writing"] },
        { store, call, relations: null },
      )
    ).idea;
    const d = await promoteIdea(b.id, "document", {}, { store, call, relations: null });
    expect(call.calls[1]).toEqual([
      "notes.create",
      expect.objectContaining({ name: "Essay on agents", tags: ["writing"], category: "idea" }),
    ]);
    expect(d.idea.docIds).toEqual([d.target.id]);
  });

  it("rejects unknown targets and missing ideas", async () => {
    const store = new IdeaStore(tmp());
    await expect(
      promoteIdea("idea_missing", "task", {}, { store, call: fakeCall(), relations: null }),
    ).rejects.toThrow(/not found/);
    await expect(
      promoteIdea("x", "email" as never, {}, { store, call: fakeCall(), relations: null }),
    ).rejects.toThrow(/to must be one of/);
  });

  it("links and unlinks a document", async () => {
    const store = new IdeaStore(tmp());
    const relations = memRelations();
    const { idea } = await createIdea({ title: "Linked" }, { store, relations });
    const linked = await linkIdea(idea.id, "doc", "note-7", {}, { store, relations });
    expect(linked.docIds).toEqual(["note-7"]);
    expect(relations.edges).toEqual([expect.objectContaining({ toType: "note", toId: "note-7" })]);
    const unlinked = await linkIdea(
      idea.id,
      "doc",
      "note-7",
      { unlink: true },
      { store, relations },
    );
    expect(unlinked.docIds).toEqual([]);
    expect(relations.edges).toEqual([]);
  });
});

describe("saveCapture", () => {
  it("routes each kind to its store and is idempotent per clientRequestId", async () => {
    const dir = tmp();
    const store = new IdeaStore(dir);
    const call = fakeCall();
    const deps = { store, call, relations: null, stateDir: dir };
    const base = { body: "b", tags: ["t"], transcript: "t", structuredBy: "heuristic" as const };

    const note = await saveCapture(
      { ...base, kind: "note", title: "N", projectId: "p1" },
      "k-note",
      deps,
    );
    expect(call.calls.at(-1)).toEqual([
      "notes.create",
      expect.objectContaining({ name: "N", projectId: "p1", category: "voice-note" }),
    ]);
    expect(note.open).toEqual({ kind: "note", id: note.id, projectId: "p1" });

    const task = await saveCapture(
      { ...base, kind: "task", title: "T", dueDate: "2026-10-16", priority: "high" },
      "k-task",
      deps,
    );
    expect(call.calls.at(-1)).toEqual([
      "kanban.tasks.create",
      expect.objectContaining({ title: "T", dueDate: "2026-10-16", priority: "high" }),
    ]);
    expect(String(call.calls.at(-1)![1].description)).toContain("Due: Fri 16 Oct");
    expect(task.open.kind).toBe("task");

    const proj = await saveCapture({ ...base, kind: "project", title: "P" }, "k-proj", deps);
    expect(proj.open).toEqual({ kind: "project", id: proj.id, projectId: proj.id });

    const log = await saveCapture(
      { ...base, kind: "log", title: "Log · today", tags: [] },
      undefined,
      deps,
    );
    expect(call.calls.at(-1)![1]).toMatchObject({ tags: ["log"], category: "log" });
    expect(log.open.kind).toBe("note");

    const idea = await saveCapture(
      { ...base, kind: "idea", title: "I", projectId: "p2" },
      "k-idea",
      deps,
    );
    expect(store.get(idea.id)).toMatchObject({ source: "voice", projectIds: ["p2"] });

    // Offline retry of an already-saved capture → same item, nothing new written.
    const before = call.calls.length;
    const dup = await saveCapture({ ...base, kind: "task", title: "T" }, "k-task", deps);
    expect(dup).toMatchObject({ duplicate: true, id: task.id, kind: "task" });
    expect(call.calls.length).toBe(before);
    const dupIdea = await saveCapture({ ...base, kind: "idea", title: "I" }, "k-idea", deps);
    expect(dupIdea).toMatchObject({ duplicate: true, id: idea.id });
    expect(store.list()).toHaveLength(1);
  });
});

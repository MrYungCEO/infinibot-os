import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  chooseSuggestion,
  guardDraftProject,
  heuristicDraft,
  structureCapture,
} from "./capture.js";
import { assignProject, saveCapture } from "./service.js";
import {
  matchProject,
  parseConfidence,
  rankProjects,
  shortlistProjects,
  type CaptureProject,
} from "./project-match.js";
import { syncProjectLinks } from "./project-links.js";
import { IdeaStore } from "./store.js";

const P: CaptureProject[] = [
  { id: "kv", name: "KinglyVault", description: "Membership vault with CEO pricing plans" },
  { id: "ib", name: "InfiniBot", updatedAt: 10 },
  {
    id: "ib-gw",
    name: "InfiniBot gateway stability",
    parentId: "ib",
    parentName: "InfiniBot",
    updatedAt: 20,
  },
  { id: "fp", name: "FlyPic", aliases: ["fly pic studio"] },
  { id: "old", name: "Robovoice", archived: true },
  { id: "web", name: "Website" },
];

describe("project matching", () => {
  it("explicit mentions win with high confidence and a reason", () => {
    const m = matchProject("add an annual plan for the KinglyVault project", P)!;
    expect(m.project.id).toBe("kv");
    expect(m.confidence).toBeGreaterThanOrEqual(0.95);
    expect(m.reason).toMatch(/KinglyVault/);
  });

  it("matches spacing variants and aliases", () => {
    expect(matchProject("the kingly vault checkout is broken", P)?.project.id).toBe("kv");
    expect(matchProject("new filter for fly pic studio", P)?.project.id).toBe("fp");
  });

  it("prefers the longest (sub-project) name and partial word overlap", () => {
    expect(matchProject("infinibot gateway stability keeps dropping", P)?.project.id).toBe("ib-gw");
    const partial = matchProject("the gateway stability work needs a watchdog", P)!;
    expect(partial.project.id).toBe("ib-gw");
    expect(partial.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("ignores archived projects, generic words and unrelated text", () => {
    expect(matchProject("robovoice cloud billing", P)).toBeUndefined();
    expect(matchProject("update the website copy", P)?.project.id).toBe("web");
    expect(matchProject("buy milk and eggs", P)).toBeUndefined();
  });

  it("description context gives a weak (non-auto) suggestion", () => {
    const m = matchProject("think about membership pricing", P)!;
    expect(m.project.id).toBe("kv");
    expect(m.confidence).toBeLessThan(0.6);
  });

  it("shortlists ranked hits first, then recent, within the cap", () => {
    const many: CaptureProject[] = Array.from({ length: 300 }, (_, i) => ({
      id: `p${i}`,
      name: `Project number ${i}`,
      updatedAt: i,
    }));
    many.push({ id: "kv", name: "KinglyVault", updatedAt: 0 });
    const list = shortlistProjects("kinglyvault pricing", many, 40);
    expect(list).toHaveLength(40);
    expect(list[0].id).toBe("kv");
    expect(list[1].id).toBe("p299");
    expect(rankProjects("nothing", many)).toEqual([]);
  });

  it("parses model confidence in any shape", () => {
    expect(parseConfidence(0.7)).toBe(0.7);
    expect(parseConfidence(85)).toBe(0.85);
    expect(parseConfidence("high")).toBe(0.85);
    expect(parseConfidence("low")).toBe(0.35);
    expect(parseConfidence(undefined)).toBe(0.75);
  });
});

describe("capture project association", () => {
  const now = new Date(2026, 9, 14);

  it("heuristic draft preselects only confident matches", () => {
    const sure = heuristicDraft("task", "remind me to fix the KinglyVault login", {
      now,
      projects: P,
    });
    expect(sure.projectId).toBe("kv");
    expect(sure.projectSuggestion).toMatchObject({ id: "kv", source: "match", auto: true });
    const weak = heuristicDraft("note", "membership pricing thoughts", { now, projects: P });
    expect(weak.projectId).toBeUndefined();
    expect(weak.projectSuggestion).toMatchObject({ id: "kv", auto: false });
  });

  it("the model picks from the shortlist with confidence + reason; invented ids are dropped", async () => {
    let prompt = "";
    const draft = await structureCapture("idea", "idea: a watchdog that restarts the socket", {
      now,
      projects: P,
      complete: async (_s, user) => {
        prompt = user;
        return JSON.stringify({
          title: "Socket watchdog",
          body: "x",
          projectId: "ib-gw",
          projectConfidence: 0.8,
          projectReason: "about gateway reliability",
        });
      },
    });
    expect(prompt).toContain("ib-gw: InfiniBot gateway stability — sub-project of InfiniBot");
    expect(prompt).not.toContain("Robovoice");
    expect(draft).toMatchObject({
      projectId: "ib-gw",
      projectName: "InfiniBot gateway stability",
      projectSuggestion: { source: "ai", confidence: 0.8, reason: "about gateway reliability" },
    });

    const invented = await structureCapture("note", "something about nothing", {
      now,
      projects: P,
      complete: async () =>
        JSON.stringify({ title: "T", projectId: "ghost", projectConfidence: 1 }),
    });
    expect(invented.projectId).toBeUndefined();
    expect(invented.projectSuggestion).toBeUndefined();
  });

  it("low model confidence suggests without preselecting", async () => {
    const d = await structureCapture("note", "general musings on the week", {
      now,
      projects: P,
      complete: async () =>
        JSON.stringify({
          title: "Musings",
          projectId: "fp",
          projectConfidence: 0.3,
          projectReason: "guess",
        }),
    });
    expect(d.projectId).toBeUndefined();
    expect(d.projectSuggestion).toMatchObject({ id: "fp", auto: false });
  });

  it("an explicit spoken name beats a weaker model guess; agreement boosts", () => {
    const match = {
      id: "kv",
      name: "KinglyVault",
      confidence: 0.96,
      reason: "named",
      source: "match" as const,
      auto: true,
    };
    const ai = {
      id: "fp",
      name: "FlyPic",
      confidence: 0.7,
      reason: "guess",
      source: "ai" as const,
      auto: true,
    };
    expect(chooseSuggestion(match, ai)?.id).toBe("kv");
    expect(chooseSuggestion({ ...match, confidence: 0.5, auto: false }, ai)?.id).toBe("fp");
    expect(chooseSuggestion(match, { ...ai, id: "kv" })?.confidence).toBe(0.99);
  });

  it("guard strips ids that are not real projects", () => {
    const d = guardDraftProject(
      {
        kind: "task",
        title: "t",
        body: "",
        tags: [],
        transcript: "",
        structuredBy: "ai",
        projectId: "ghost",
        projectName: "Ghost",
      },
      P,
    );
    expect(d.projectId).toBeUndefined();
    expect(d.projectName).toBeUndefined();
  });
});

function fakeLinkers() {
  const objrel: Array<Record<string, string>> = [];
  const pairs = new Set<string>();
  return {
    objrel,
    pairs,
    relations: {
      link: (e: Record<string, string>) => {
        if (!objrel.some((x) => x.fromId === e.fromId && x.toId === e.toId)) objrel.push(e);
      },
      unlink: (e: { fromId: string; toId: string }) => {
        const i = objrel.findIndex((x) => x.fromId === e.fromId && x.toId === e.toId);
        if (i >= 0) objrel.splice(i, 1);
      },
      linksFrom: () => [],
    },
    entities: {
      link: (a: { id: string }, b: { type: string; id: string }) =>
        pairs.add(`${a.id}|${b.type}:${b.id}`),
      unlink: (a: { id: string }, b: { type: string; id: string }) =>
        pairs.delete(`${a.id}|${b.type}:${b.id}`),
    },
  };
}

describe("saved captures carry the project everywhere", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "capture-proj-"));
  const fakeCall = () => {
    let n = 0;
    const calls: Array<[string, Record<string, unknown>]> = [];
    const notes = new Map<string, Record<string, unknown>>();
    const fn = async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      n += 1;
      if (method === "notes.get") return notes.get(String(params.id)) ?? null;
      if (method === "notes.create") {
        const id = `note-${n}`;
        notes.set(id, { id, ...params });
        return { id, ...params };
      }
      if (method === "notes.update") {
        notes.set(String(params.id), { ...notes.get(String(params.id)), ...params });
        return notes.get(String(params.id));
      }
      return { id: `${method}-${n}`, ...params };
    };
    return Object.assign(fn, { calls });
  };
  const base = { body: "b", tags: [], transcript: "t", structuredBy: "ai" as const };

  it("idea / note / task saves persist projectId and write both relation indexes", async () => {
    const dir = tmp();
    const store = new IdeaStore(dir);
    const call = fakeCall();
    const L = fakeLinkers();
    const deps = { store, call, relations: L.relations, entities: L.entities, stateDir: dir };

    const idea = await saveCapture(
      { ...base, kind: "idea", title: "I", projectId: "kv" },
      "a",
      deps,
    );
    expect(store.get(idea.id)?.projectIds).toEqual(["kv"]);
    expect(L.objrel).toContainEqual(
      expect.objectContaining({ edge: "idea_about_project", fromId: idea.id, toId: "kv" }),
    );
    expect(L.pairs.has(`kv|idea:${idea.id}`)).toBe(true);

    const note = await saveCapture(
      { ...base, kind: "note", title: "N", projectId: "kv" },
      "b",
      deps,
    );
    expect(call.calls.find((c) => c[0] === "notes.create")?.[1]).toMatchObject({ projectId: "kv" });
    expect(L.pairs.has(`kv|note:${note.id}`)).toBe(true);

    const task = await saveCapture(
      { ...base, kind: "task", title: "T", projectId: "ib" },
      "c",
      deps,
    );
    expect(call.calls.find((c) => c[0] === "kanban.tasks.create")?.[1]).toMatchObject({
      projectId: "ib",
    });
    expect(L.objrel).toContainEqual(
      expect.objectContaining({ edge: "project_has_task", fromId: "ib", toId: task.id }),
    );
    expect(task.open).toMatchObject({ kind: "task", projectId: "ib" });
  });

  it("assignProject moves an idea / note / task and re-links the indexes", async () => {
    const dir = tmp();
    const store = new IdeaStore(dir);
    const call = fakeCall();
    const L = fakeLinkers();
    const deps = { store, call, relations: L.relations, entities: L.entities, stateDir: dir };

    const idea = await saveCapture(
      { ...base, kind: "idea", title: "I", projectId: "kv" },
      "a",
      deps,
    );
    const moved = await assignProject("idea", idea.id, "fp", deps);
    expect(moved).toMatchObject({ projectId: "fp", previous: ["kv"] });
    expect(store.get(idea.id)?.projectIds).toEqual(["fp"]);
    expect(L.pairs.has(`kv|idea:${idea.id}`)).toBe(false);
    expect(L.pairs.has(`fp|idea:${idea.id}`)).toBe(true);
    expect(L.objrel.filter((e) => e.fromId === idea.id).map((e) => e.toId)).toEqual(["fp"]);

    const note = await saveCapture(
      { ...base, kind: "note", title: "N", projectId: "kv" },
      "b",
      deps,
    );
    await assignProject("note", note.id, null, deps);
    expect(call.calls.at(-1)).toEqual(["notes.update", { id: note.id, projectId: "" }]);
    expect(L.pairs.has(`kv|note:${note.id}`)).toBe(false);

    await assignProject("task", "t-1", "ib", { ...deps, previousProjectId: "kv" });
    expect(call.calls.at(-1)).toEqual([
      "kanban.tasks.update",
      { id: "t-1", patch: { projectId: "ib" } },
    ]);
    expect(L.pairs.has("ib|task:t-1")).toBe(true);
  });

  it("syncProjectLinks only unlinks what was left", () => {
    const L = fakeLinkers();
    const r = syncProjectLinks(
      { kind: "note", id: "n", before: ["a", "b"], after: ["b", "c"] },
      { objrel: L.relations, entity: L.entities },
    );
    expect(r).toEqual({ linked: ["c"], unlinked: ["a"] });
    expect([...L.pairs].sort()).toEqual(["b|note:n", "c|note:n"]);
  });
});

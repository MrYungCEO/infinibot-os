import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  guardDraftClient,
  guardModelDate,
  heuristicDraft,
  mergeModelDraft,
  structureCapture,
} from "./capture.js";
import {
  clientsOfProject,
  matchClient,
  shortlistClients,
  toCaptureClients,
  type CaptureClient,
} from "./client-match.js";
import { syncClientLinks, type EntityLinker } from "./project-links.js";
import { assignClient, saveCapture, type GatewayCall, type RelationWriter } from "./service.js";
import { NoteStore } from "../notes/store.js";
import { IdeaStore } from "./store.js";

const TZ = "Asia/Bangkok";
const now = new Date(Date.UTC(2026, 9, 14, 3, 0, 0)); // Wed 14 Oct 2026, 10:00 Bangkok

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "capture-client-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// Agency rows as the store returns them (camelCase + Notion data blob).
const CLIENTS: CaptureClient[] = toCaptureClients([
  {
    id: "c-gengu",
    name: "Gengu Dinosaurs Technology Co., Ltd.",
    data: { Company: "Gengu", "Business Type": ["robotics"] },
    email: "gengudino@zggengu.com",
    notionPageId: "202f4bdd-aaaa",
    updatedAt: 300,
  },
  { id: "c-Sample", name: "SAMPLE Robopark", pipelineStatusLabel: "Active", updatedAt: 200 },
  { id: "c-alan", name: "Alan", updatedAt: 100 },
  { id: "c-afk", name: "AfriKayla", data: { "Business Type": ["Black Brand", "clothing"] } },
  { id: "", name: "no id" },
  { id: "c-blank", name: "   " },
]);
const PROJECTS = [
  { id: "p-park", name: "Robopark site", clientNotionIds: [] as string[] },
  { id: "p-dino", name: "Dino ride app", clientNotionIds: ["202f4bddaaaa"] },
];
const clientOfProject = (pid: string) =>
  clientsOfProject(CLIENTS, {
    linkedIds: pid === "p-park" ? ["c-Sample"] : [],
    notionIds: PROJECTS.find((p) => p.id === pid)?.clientNotionIds,
  })[0];

describe("client matching", () => {
  it("normalises agency rows (company alias, about, notion id) and drops nameless rows", () => {
    expect(CLIENTS.map((c) => c.id)).toEqual(["c-gengu", "c-Sample", "c-alan", "c-afk"]);
    expect(CLIENTS[0]).toMatchObject({
      aliases: ["Gengu"],
      notionPageId: "202f4bdd-aaaa",
      email: "gengudino@zggengu.com",
    });
    expect(CLIENTS[3].description).toContain("clothing");
  });

  it("matches names, aliases, spacing variants and explicit cues", () => {
    expect(matchClient("send the invoice to Gengu", CLIENTS)?.client.id).toBe("c-gengu");
    expect(matchClient("call Sample robo park about the gate", CLIENTS)?.client.id).toBe("c-Sample");
    const explicit = matchClient("for client Alan: draft the proposal", CLIENTS)!;
    expect(explicit.client.id).toBe("c-alan");
    expect(explicit.confidence).toBeGreaterThanOrEqual(0.97);
    expect(matchClient("buy groceries", CLIENTS)).toBeUndefined();
  });

  it("shortlist puts hits first, then recent clients", () => {
    const many = [
      ...CLIENTS,
      ...Array.from({ length: 60 }, (_, i) => ({ id: `x${i}`, name: `Client ${i}`, updatedAt: i })),
    ];
    const s = shortlistClients("invoice for Gengu", many, 10);
    expect(s[0].id).toBe("c-gengu");
    expect(s).toHaveLength(10);
  });

  it("resolves a project's client from links and its Notion 'Clients' relation", () => {
    expect(clientOfProject("p-park")?.id).toBe("c-Sample");
    expect(clientOfProject("p-dino")?.id).toBe("c-gengu"); // dashes don't matter
    expect(clientOfProject("p-none")).toBeUndefined();
  });
});

describe("capture drafts: dates + clients", () => {
  const ctx = { now, timeZone: TZ, projects: PROJECTS, clients: CLIENTS, clientOfProject };

  it("task: due date + time + phrase, explicit client preselected", () => {
    const d = heuristicDraft("task", "Remind me to send Gengu the quote next Tuesday at 3", ctx);
    expect(d).toMatchObject({
      dueDate: "2026-10-20",
      dueTime: "15:00",
      dateSuggestion: { phrase: "next Tuesday at 3", source: "parse", label: "Tue 20 Oct, 3 pm" },
      clientId: "c-gengu",
      clientSuggestion: { source: "match", auto: true },
    });
    expect(d.title).toBe("Send Gengu the quote");
  });

  it("client inferred from the chosen project when none is said", () => {
    const d = heuristicDraft("note", "the robopark site needs a new gate photo", ctx);
    expect(d.projectId).toBe("p-park");
    expect(d.clientSuggestion).toMatchObject({ id: "c-Sample", source: "project", auto: true });
    expect(d.clientId).toBe("c-Sample");
  });

  it("an explicit client beats the project's client", () => {
    const d = heuristicDraft("task", "robopark site: ask Alan for the photos by Friday", ctx);
    expect(d.projectId).toBe("p-park");
    expect(d.clientId).toBe("c-alan");
  });

  it("notes / ideas only take a date when asked; logs take past dates", () => {
    expect(heuristicDraft("note", "Friday's meeting went well", ctx).dueDate).toBeUndefined();
    expect(heuristicDraft("idea", "revisit the pricing idea next week", ctx).dueDate).toBe(
      "2026-10-19",
    );
    const log = heuristicDraft("log", "log that the render finished yesterday", ctx);
    expect(log.dueDate).toBe("2026-10-13");
    expect(log.title).toBe("Log · 2026-10-13");
    expect(heuristicDraft("log", "we will ship next week", ctx).dueDate).toBeUndefined();
  });

  it("project kind: target date, no project association", () => {
    const d = heuristicDraft(
      "project",
      "new project Dino merch store, launch by end of month",
      ctx,
    );
    expect(d).toMatchObject({ dueDate: "2026-10-31" });
    expect(d.projectId).toBeUndefined();
  });

  it("the model's date is guarded by the parser and the transcript", () => {
    const t = "move the Alan call to next Tuesday";
    // Model got the weekday maths wrong — the parser's reading of its phrase wins.
    expect(
      guardModelDate("task", { dueDate: "2026-10-27", datePhrase: "next Tuesday" }, t, now, TZ),
    ).toMatchObject({ date: "2026-10-20", source: "parse" });
    // A phrase that isn't in the transcript is an invention.
    expect(
      guardModelDate("task", { dueDate: "2026-10-30", datePhrase: "by Halloween" }, t, now, TZ),
    ).toBeNull();
    // A phrase the parser can't read: keep the model's date if it is real and in range.
    expect(
      guardModelDate(
        "task",
        { dueDate: "2026-10-31", datePhrase: "on halloween" },
        "send it on halloween",
        now,
        TZ,
      ),
    ).toMatchObject({ date: "2026-10-31", source: "ai" });
    expect(
      guardModelDate(
        "task",
        { dueDate: "2020-01-01", datePhrase: "on halloween" },
        "send it on halloween",
        now,
        TZ,
      ),
    ).toBeNull();
  });

  it("the model may only pick a real client; invented ids are dropped", () => {
    const base = heuristicDraft("idea", "a loyalty card for the dino park", ctx);
    const invented = mergeModelDraft(base, { clientId: "c-nope", clientConfidence: 0.9 }, [], {
      clients: CLIENTS,
      now,
      timeZone: TZ,
    });
    expect(invented.clientId).toBeUndefined();
    const real = mergeModelDraft(
      base,
      { clientId: "c-gengu", clientConfidence: 0.8, clientReason: "dino park is Gengu's" },
      [],
      { clients: CLIENTS, now, timeZone: TZ },
    );
    expect(real).toMatchObject({
      clientId: "c-gengu",
      clientSuggestion: { source: "ai", reason: "dino park is Gengu's" },
    });
    const weak = mergeModelDraft(base, { clientId: "c-alan", clientConfidence: 0.4 }, [], {
      clients: CLIENTS,
    });
    expect(weak.clientId).toBeUndefined();
    expect(weak.clientSuggestion).toMatchObject({ id: "c-alan", auto: false });
    expect(guardDraftClient({ ...real, clientId: "gone" }, CLIENTS).clientId).toBeUndefined();
  });

  it("structureCapture end-to-end with a mocked model (timezone-aware)", async () => {
    const complete = vi.fn(async (_s: string, user: string) => {
      expect(user).toContain("Asia/Bangkok");
      expect(user).toContain("c-gengu: Gengu Dinosaurs");
      return JSON.stringify({
        title: "Quote for Gengu",
        clientId: "c-gengu",
        clientConfidence: 0.9,
        dueDate: "2026-10-28",
        datePhrase: "in two weeks",
      });
    });
    const d = await structureCapture("task", "um send the quote to gengu in two weeks", {
      ...ctx,
      complete,
    });
    expect(d).toMatchObject({
      structuredBy: "ai",
      clientId: "c-gengu",
      clientName: "Gengu Dinosaurs Technology Co., Ltd.",
      dueDate: "2026-10-28",
      dateSuggestion: { label: "Wed 28 Oct" },
    });
  });
});

// ── persistence ───────────────────────────────────────────────────────────────

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

function memEntities(): EntityLinker & { pairs: string[] } {
  const pairs: string[] = [];
  const key = (a: { type: string; id: string }, b: { type: string; id: string }) =>
    `${a.type}:${a.id}<->${b.type}:${b.id}`;
  return {
    pairs,
    link: (a, b) => {
      if (!pairs.includes(key(a, b))) pairs.push(key(a, b));
    },
    unlink: (a, b) => {
      const i = pairs.indexOf(key(a, b));
      if (i >= 0) pairs.splice(i, 1);
    },
  };
}

function fakeCall(
  notes: Record<string, Record<string, unknown>> = {},
): GatewayCall & { calls: Array<[string, Record<string, unknown>]> } {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let n = 0;
  const fn = (async (method: string, params: Record<string, unknown>) => {
    calls.push([method, params]);
    n += 1;
    if (method === "kanban.tasks.create") return { id: `task-${n}` };
    if (method === "kanban.projects.create") return { id: `proj-${n}` };
    if (method === "notes.create") return { id: `note-${n}` };
    if (method === "notes.get") return notes[String(params.id)] ?? null;
    if (method === "notes.update" || method.endsWith(".update")) return { ok: true };
    throw new Error(`unexpected ${method}`);
  }) as GatewayCall & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe("saveCapture persists client + date", () => {
  const base = { body: "b", tags: [], transcript: "t", structuredBy: "ai" as const };

  it("idea / note / log / task / project", async () => {
    const dir = tmp();
    const store = new IdeaStore(dir);
    const call = fakeCall();
    const relations = memRelations();
    const entities = memEntities();
    const deps = { store, call, relations, entities, stateDir: dir };

    const idea = await saveCapture(
      { ...base, kind: "idea", title: "I", clientId: "c-gengu", dueDate: "2026-10-19" },
      "k1",
      deps,
    );
    expect(store.get(idea.id)).toMatchObject({ clientIds: ["c-gengu"], reviewOn: "2026-10-19" });

    await saveCapture(
      {
        ...base,
        kind: "note",
        title: "N",
        clientId: "c-alan",
        dueDate: "2026-10-20",
        dueTime: "15:00",
      },
      "k2",
      deps,
    );
    expect(call.calls.at(-1)).toEqual([
      "notes.create",
      expect.objectContaining({ clientId: "c-alan", reviewOn: "2026-10-20T15:00" }),
    ]);

    await saveCapture(
      {
        ...base,
        kind: "task",
        title: "T",
        clientId: "c-Sample",
        dueDate: "2026-10-16",
        dueTime: "09:30",
      },
      "k3",
      deps,
    );
    const [, task] = call.calls.at(-1)!;
    expect(task).toMatchObject({ clientId: "c-Sample", dueDate: "2026-10-16", dueTime: "09:30" });
    expect(String(task.description)).toContain("Due: Fri 16 Oct, 9:30 am");

    await saveCapture(
      { ...base, kind: "project", title: "P", clientId: "c-gengu", dueDate: "2026-10-31" },
      "k4",
      deps,
    );
    expect(call.calls.at(-1)![1]).toMatchObject({ dueDate: "2026-10-31", clientId: "c-gengu" });

    await saveCapture(
      { ...base, kind: "log", title: "Log · 2026-10-13", dueDate: "2026-10-13" },
      "k5",
      deps,
    );
    expect(call.calls.at(-1)![1]).toMatchObject({ reviewOn: "2026-10-13", category: "log" });

    // client → item edges for the client page / knowledge graph
    expect(relations.edges.filter((e) => e.fromType === "client")).toEqual([
      expect.objectContaining({ fromId: "c-gengu", edge: "relates_to", toType: "idea" }),
      expect.objectContaining({ fromId: "c-alan", toType: "note" }),
      expect.objectContaining({ fromId: "c-Sample", toType: "task" }),
      expect.objectContaining({ fromId: "c-gengu", toType: "project" }),
    ]);
    expect(entities.pairs).toContain("client:c-alan<->note:note-1");
  });

  it("drops a malformed date instead of saving it", async () => {
    const dir = tmp();
    const call = fakeCall();
    await saveCapture({ ...base, kind: "task", title: "T", dueDate: "friday" }, undefined, {
      store: new IdeaStore(dir),
      call,
      relations: null,
      entities: null,
      stateDir: dir,
    });
    expect(call.calls[0][1].dueDate).toBeUndefined();
  });
});

describe("assignClient", () => {
  it("moves an idea between clients and keeps the edges in line", async () => {
    const dir = tmp();
    const store = new IdeaStore(dir);
    const relations = memRelations();
    const entities = memEntities();
    const { idea } = store.create({ title: "x", clientIds: ["c-alan"] });
    syncClientLinks(
      { kind: "idea", id: idea.id, before: [], after: ["c-alan"] },
      { objrel: relations, entity: entities },
    );
    const res = await assignClient("idea", idea.id, "c-gengu", {
      store,
      relations,
      entities,
      call: fakeCall(),
      stateDir: dir,
    });
    expect(res).toMatchObject({ clientId: "c-gengu", previous: ["c-alan"] });
    expect(store.get(idea.id)?.clientIds).toEqual(["c-gengu"]);
    expect(relations.edges.map((e) => e.fromId)).toEqual(["c-gengu"]);
    expect(entities.pairs).toEqual([`client:c-gengu<->idea:${idea.id}`]);
    await assignClient("idea", idea.id, null, {
      store,
      relations,
      entities,
      call: fakeCall(),
      stateDir: dir,
    });
    expect(store.get(idea.id)?.clientIds).toEqual([]);
    expect(relations.edges).toEqual([]);
  });

  it("notes go through notes.update; tasks / projects through kanban with the previous client", async () => {
    const dir = tmp();
    const call = fakeCall({ "note-1": { id: "note-1", clientId: "c-alan" } });
    const deps = {
      store: new IdeaStore(dir),
      call,
      relations: memRelations(),
      entities: memEntities(),
      stateDir: dir,
    };
    const n = await assignClient("note", "note-1", "c-Sample", deps);
    expect(n.previous).toEqual(["c-alan"]);
    expect(call.calls.at(-1)).toEqual(["notes.update", { id: "note-1", clientId: "c-Sample" }]);
    await assignClient("note", "note-1", null, deps);
    expect(call.calls.at(-1)).toEqual(["notes.update", { id: "note-1", clientId: "" }]);

    await assignClient("task", "task-9", "c-gengu", { ...deps, previousClientId: "c-alan" });
    expect(call.calls.at(-1)).toEqual([
      "kanban.tasks.update",
      { id: "task-9", patch: { clientId: "c-gengu", previousClientIds: [] } },
    ]);
    await assignClient("project", "proj-2", "c-gengu", deps);
    expect(call.calls.at(-1)![0]).toBe("kanban.projects.update");
    await expect(assignClient("nope" as never, "x", null, deps)).rejects.toThrow(/kind must be/);
  });
});

describe("NoteStore client + review date", () => {
  it("round-trips clientId / reviewOn through frontmatter, filters, and clears with ''", () => {
    const store = new NoteStore(tmp());
    const n = store.create({
      name: "Call notes",
      body: "b",
      clientId: "c-gengu",
      reviewOn: "2026-10-20T15:00",
    });
    expect(store.get(n.id)).toMatchObject({ clientId: "c-gengu", reviewOn: "2026-10-20T15:00" });
    store.create({ name: "Other", body: "b" });
    expect(store.list({ clientId: "c-gengu" }).map((x) => x.id)).toEqual([n.id]);
    store.update({ id: n.id, name: "Renamed" });
    expect(store.get(n.id)).toMatchObject({ clientId: "c-gengu", reviewOn: "2026-10-20T15:00" });
    store.update({ id: n.id, clientId: "", reviewOn: "" });
    expect(store.get(n.id)?.clientId).toBeUndefined();
    expect(store.get(n.id)?.reviewOn).toBeUndefined();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// promote / capture.save dispatch into the core handler map in-process; give
// them fake kanban + notes handlers instead of the real (Notion-aware) ones.
const created: Array<[string, Record<string, unknown>]> = [];
vi.mock("../server-methods.js", () => {
  let n = 0;
  const make =
    (method: string, prefix: string) =>
    ({
      params,
      respond,
    }: {
      params: Record<string, unknown>;
      respond: (ok: boolean, p?: unknown) => void;
    }) => {
      created.push([method, params]);
      n += 1;
      respond(true, { id: `${prefix}-${n}`, ...params });
    };
  return {
    coreGatewayHandlers: {
      "kanban.tasks.create": make("kanban.tasks.create", "task"),
      "kanban.projects.create": make("kanban.projects.create", "proj"),
      "notes.create": make("notes.create", "note"),
      "notes.update": make("notes.update", "note"),
      "notes.get": ({
        params,
        respond,
      }: {
        params: { id: string };
        respond: (ok: boolean, p?: unknown) => void;
      }) => respond(true, { id: params.id, projectId: "p-face" }),
      "kanban.tasks.update": make("kanban.tasks.update", "task"),
      "kanban.projects.list": ({ respond }: { respond: (ok: boolean, p?: unknown) => void }) =>
        respond(true, [
          { id: "p-face", name: "InfiniBot Face", updatedAt: 5 },
          { id: "p-kv", name: "KinglyVault", description: "membership vault" },
          { id: "p-kv-pay", name: "Vault payments", parentProjectId: "p-kv" },
          { id: "p-arch", name: "Old Archive", archived: true },
        ]),
    },
  };
});

let stateDir = "";
const prevState = process.env.INFINIBOT_STATE_DIR;

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "ideas-rpc-"));
  process.env.INFINIBOT_STATE_DIR = stateDir;
});
afterAll(() => {
  if (prevState === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = prevState;
  rmSync(stateDir, { recursive: true, force: true });
});

const { ideasHandlers, ideasRpcDeps, IDEAS_READ_METHODS, IDEAS_WRITE_METHODS } =
  await import("./ideas.js");

async function rpc(
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ ok: boolean; payload: any; error: any }> {
  return await new Promise((resolve) => {
    void ideasHandlers[method]!({
      req: { type: "req", id: "t", method, params } as never,
      params,
      client: null,
      isWebchatConnect: () => false,
      respond: ((ok: boolean, payload?: unknown, error?: unknown) =>
        resolve({ ok, payload, error })) as never,
      context: undefined as never,
    });
  });
}

describe("ideas.* RPCs", () => {
  it("create → list → get → update → read back", async () => {
    const c = await rpc("ideas.create", {
      title: "Phone face for calls",
      body: "A blob that listens",
      tags: "mobile, voice",
      source: "mobile",
      clientRequestId: "r1",
    });
    expect(c.ok).toBe(true);
    const id = c.payload.idea.id as string;
    expect(c.payload.idea).toMatchObject({
      title: "Phone face for calls",
      tags: ["mobile", "voice"],
      source: "mobile",
      status: "new",
    });

    const list = await rpc("ideas.list", { query: "blob" });
    expect(list.payload.ideas.map((i: { id: string }) => i.id)).toEqual([id]);
    expect(list.payload.counts.new).toBe(1);
    expect(list.payload.tags.map((t: { tag: string }) => t.tag)).toEqual(
      expect.arrayContaining(["mobile", "voice"]),
    );

    const upd = await rpc("ideas.update", { id, patch: { status: "exploring", tags: ["voice"] } });
    expect(upd.payload.idea).toMatchObject({ status: "exploring", tags: ["voice"] });
    const got = await rpc("ideas.get", { id });
    expect(got.payload.idea.status).toBe("exploring");

    const bad = await rpc("ideas.update", { id, status: "done" });
    expect(bad.ok).toBe(false);
    expect(bad.error.code).toBe("INVALID_REQUEST");
  });

  it("promote → kanban task, link a doc, delete", async () => {
    const { payload } = await rpc("ideas.create", {
      title: "Voice capture buttons",
      projectIds: ["p-face"],
    });
    const id = payload.idea.id;
    const pr = await rpc("ideas.promote", { id, to: "task" });
    expect(pr.ok).toBe(true);
    expect(pr.payload.target).toMatchObject({ kind: "task" });
    expect(created.at(-1)).toEqual([
      "kanban.tasks.create",
      expect.objectContaining({ title: "Voice capture buttons", projectId: "p-face" }),
    ]);
    expect(pr.payload.idea).toMatchObject({
      status: "promoted",
      promotedTo: { kind: "task", id: pr.payload.target.id },
    });

    const rel = await rpc("ideas.get", { id });
    expect(rel.payload.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ edge: "idea_about_project", toId: "p-face" }),
        expect.objectContaining({ edge: "idea_becomes_task", toId: pr.payload.target.id }),
      ]),
    );

    const ln = await rpc("ideas.link", { id, kind: "doc", targetId: "note-x" });
    expect(ln.payload.idea.docIds).toEqual(["note-x"]);
    expect((await rpc("ideas.promote", { id, to: "slack" })).error.code).toBe("INVALID_REQUEST");

    expect((await rpc("ideas.delete", { id })).payload).toEqual({ deleted: true, id });
    expect((await rpc("ideas.get", { id })).error.code).toBe("NOT_FOUND");
  });
});

describe("capture.* RPCs (mocked LLM)", () => {
  it("structure uses the model + board projects, save writes through and read-back works", async () => {
    ideasRpcDeps.complete = async () => async (_system, user) => {
      expect(user).toContain("p-face: InfiniBot Face");
      return JSON.stringify({
        title: "Mouth sync for the face",
        body: "Drive the mouth from TTS amplitude.",
        tags: ["animation"],
        projectId: "p-face",
      });
    };
    const s = await rpc("capture.structure", {
      kind: "idea",
      transcript: "idea: the infinibot face mouth should follow the tts amplitude",
    });
    expect(s.ok).toBe(true);
    expect(s.payload.draft).toMatchObject({
      kind: "idea",
      structuredBy: "ai",
      title: "Mouth sync for the face",
      projectId: "p-face",
      projectName: "InfiniBot Face",
    });

    const saved = await rpc("capture.save", { draft: s.payload.draft, clientRequestId: "cap-xyz" });
    expect(saved.payload).toMatchObject({ kind: "idea", duplicate: false, open: { kind: "idea" } });
    const back = await rpc("ideas.get", { id: saved.payload.id });
    expect(back.payload.idea).toMatchObject({
      title: "Mouth sync for the face",
      source: "voice",
      projectIds: ["p-face"],
    });

    const retry = await rpc("capture.save", { draft: s.payload.draft, clientRequestId: "cap-xyz" });
    expect(retry.payload).toMatchObject({ duplicate: true, id: saved.payload.id });

    const note = await rpc("capture.save", {
      draft: { kind: "note", title: "Groceries", body: "milk", tags: ["home"] },
      clientRequestId: "cap-note",
    });
    expect(note.payload.open.kind).toBe("note");
    expect(created.at(-1)).toEqual([
      "notes.create",
      expect.objectContaining({ name: "Groceries", body: "milk", tags: ["home"] }),
    ]);
  });

  it("validates kind / transcript / title", async () => {
    expect((await rpc("capture.structure", { kind: "email", transcript: "x" })).error.code).toBe(
      "INVALID_REQUEST",
    );
    expect((await rpc("capture.structure", { kind: "note", transcript: "  " })).error.code).toBe(
      "INVALID_REQUEST",
    );
    expect((await rpc("capture.save", { draft: { kind: "note", title: "" } })).error.code).toBe(
      "INVALID_REQUEST",
    );
  });

  it("ai:false skips the model", async () => {
    const spy = vi.fn();
    ideasRpcDeps.complete = async () => spy;
    const s = await rpc("capture.structure", {
      kind: "task",
      transcript: "remind me to call mom tomorrow",
      ai: false,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(s.payload.draft).toMatchObject({ structuredBy: "heuristic", title: "Call mom" });
  });

  it("every method is scope-classified", () => {
    expect([...IDEAS_READ_METHODS, ...IDEAS_WRITE_METHODS].sort()).toEqual(
      Object.keys(ideasHandlers).sort(),
    );
  });
});

describe("capture project association (RPC)", () => {
  it("structure returns only real project ids, with confidence + reason", async () => {
    let seen = "";
    ideasRpcDeps.complete = async () => async (_system, user) => {
      seen = user;
      return JSON.stringify({
        title: "Pay",
        body: "b",
        projectId: "invented-123",
        projectConfidence: 0.99,
      });
    };
    const s = await rpc("capture.structure", {
      kind: "task",
      transcript: "task for the vault payments project: retry failed charges",
    });
    expect(seen).toContain("p-kv-pay: Vault payments — sub-project of KinglyVault");
    expect(seen).not.toContain("Old Archive");
    // The model's invented id is ignored; the deterministic match stands.
    expect(s.payload.draft).toMatchObject({
      projectId: "p-kv-pay",
      projectName: "Vault payments",
      projectSuggestion: { id: "p-kv-pay", source: "match", auto: true },
    });
    expect(s.payload.projectCount).toBe(3);
  });

  it("capture.save keeps projectId for idea / note / task", async () => {
    for (const kind of ["idea", "note", "task"] as const) {
      const r = await rpc("capture.save", {
        draft: { kind, title: `${kind} x`, body: "b", projectId: "p-kv" },
        clientRequestId: `cap-proj-${kind}`,
      });
      expect(r.ok).toBe(true);
      expect(r.payload.open.projectId).toBe("p-kv");
    }
    expect(
      created.find((c) => c[0] === "kanban.tasks.create" && c[1].title === "task x")?.[1],
    ).toMatchObject({
      projectId: "p-kv",
    });
    expect(
      created.find((c) => c[0] === "notes.create" && c[1].name === "note x")?.[1],
    ).toMatchObject({
      projectId: "p-kv",
    });
  });

  it("capture.assignProject validates and moves items", async () => {
    const idea = await rpc("ideas.create", { title: "Move me", projectIds: ["p-face"] });
    const id = idea.payload.idea.id;
    const moved = await rpc("capture.assignProject", { kind: "idea", id, projectId: "p-kv" });
    expect(moved.payload).toMatchObject({ kind: "idea", projectId: "p-kv", previous: ["p-face"] });
    expect((await rpc("ideas.get", { id })).payload.idea.projectIds).toEqual(["p-kv"]);

    expect(
      (await rpc("capture.assignProject", { kind: "idea", id, projectId: "nope" })).error.code,
    ).toBe("NOT_FOUND");
    expect((await rpc("capture.assignProject", { kind: "email", id })).error.code).toBe(
      "INVALID_REQUEST",
    );

    const cleared = await rpc("capture.assignProject", { kind: "note", id: "n1", projectId: null });
    expect(cleared.payload).toMatchObject({ projectId: null, previous: ["p-face"] });
    expect(created.at(-1)).toEqual(["notes.update", { id: "n1", projectId: "" }]);

    await rpc("capture.assignProject", { kind: "task", id: "t1", projectId: "p-face" });
    expect(created.at(-1)).toEqual([
      "kanban.tasks.update",
      { id: "t1", patch: { projectId: "p-face" } },
    ]);
  });
});

describe("capture dates + client association (RPC)", () => {
  const CLIENTS = [
    { id: "c-gengu", name: "Gengu", updatedAt: 3 },
    { id: "c-Sample", name: "SAMPLE Robopark", updatedAt: 2 },
  ];
  beforeAll(() => {
    ideasRpcDeps.clients = async () => CLIENTS;
    // InfiniBot Face is SAMPLE's project.
    ideasRpcDeps.clientResolver = async (clients) => (pid) =>
      pid === "p-face" ? clients.find((c) => c.id === "c-Sample") : undefined;
  });

  it("structure resolves dates in the phone's timezone and only real client ids", async () => {
    ideasRpcDeps.complete = async () => async () =>
      JSON.stringify({ title: "Quote", clientId: "c-invented", clientConfidence: 0.99 });
    const s = await rpc("capture.structure", {
      kind: "task",
      transcript: "send Gengu the quote tomorrow at 3pm",
      timeZone: "Asia/Bangkok",
    });
    expect(s.payload.timeZone).toBe("Asia/Bangkok");
    expect(s.payload.clientCount).toBe(2);
    expect(s.payload.draft).toMatchObject({
      clientId: "c-gengu",
      dueTime: "15:00",
      dateSuggestion: { phrase: "tomorrow at 3pm", source: "parse" },
    });
    expect(s.payload.draft.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("structure infers the client from the project", async () => {
    ideasRpcDeps.complete = async () => null;
    const s = await rpc("capture.structure", {
      kind: "note",
      transcript: "infinibot face idea: blink when listening",
      timeZone: "Asia/Bangkok",
    });
    expect(s.payload.draft).toMatchObject({
      projectId: "p-face",
      clientId: "c-Sample",
      clientSuggestion: { source: "project" },
    });
  });

  it("save keeps clientId + date, drops unknown clients and bad dates", async () => {
    const ok = await rpc("capture.save", {
      draft: {
        kind: "task",
        title: "dated",
        body: "b",
        clientId: "c-gengu",
        dueDate: "2026-10-20",
        dueTime: "15:00",
      },
    });
    expect(ok.ok).toBe(true);
    expect(created.at(-1)![1]).toMatchObject({
      title: "dated",
      clientId: "c-gengu",
      dueDate: "2026-10-20",
      dueTime: "15:00",
    });
    await rpc("capture.save", {
      draft: { kind: "task", title: "bad", body: "b", clientId: "c-zzz", dueDate: "friday" },
    });
    const bad = created.at(-1)![1];
    expect(bad.clientId).toBeUndefined();
    expect(bad.dueDate).toBeUndefined();

    const idea = await rpc("capture.save", {
      draft: { kind: "idea", title: "review me", clientId: "c-Sample", dueDate: "2026-10-19" },
    });
    const got = await rpc("ideas.get", { id: idea.payload.id });
    expect(got.payload.idea).toMatchObject({ clientIds: ["c-Sample"], reviewOn: "2026-10-19" });
    const listed = await rpc("ideas.list", { clientId: "c-Sample" });
    expect(listed.payload.ideas.map((i: { id: string }) => i.id)).toContain(idea.payload.id);
  });

  it("assignClient validates and moves; clients + clientForProject read", async () => {
    const idea = await rpc("ideas.create", { title: "client me" });
    const id = idea.payload.idea.id;
    const res = await rpc("capture.assignClient", { kind: "idea", id, clientId: "c-gengu" });
    expect(res.payload).toMatchObject({ kind: "idea", clientId: "c-gengu" });
    expect((await rpc("ideas.get", { id })).payload.idea.clientIds).toEqual(["c-gengu"]);
    expect(
      (await rpc("capture.assignClient", { kind: "idea", id, clientId: "nope" })).error.code,
    ).toBe("NOT_FOUND");
    expect((await rpc("capture.assignClient", { kind: "deal", id })).error.code).toBe(
      "INVALID_REQUEST",
    );
    await rpc("capture.assignClient", { kind: "task", id: "t7", clientId: "c-Sample" });
    expect(created.at(-1)).toEqual([
      "kanban.tasks.update",
      { id: "t7", patch: { clientId: "c-Sample", previousClientIds: [] } },
    ]);

    const list = await rpc("capture.clients");
    expect(list.payload.clients.map((c: { id: string }) => c.id)).toEqual(["c-gengu", "c-Sample"]);
    const forProject = await rpc("capture.clientForProject", { projectId: "p-face" });
    expect(forProject.payload.client).toMatchObject({ id: "c-Sample" });
    expect(
      (await rpc("capture.clientForProject", { projectId: "p-kv" })).payload.client,
    ).toBeNull();
  });
});

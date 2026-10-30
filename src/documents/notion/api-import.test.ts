import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentStore } from "../store.js";
import type { DocNode } from "../types.js";
import { createNotionClient, importNotion, searchNotion, type NotionClient } from "./api-import.js";

/* eslint-disable @typescript-eslint/no-explicit-any -- recorded Notion JSON */
type Workspace = {
  pages: Record<string, any>;
  databases: Record<string, any>;
  queries: Record<string, string[]>;
  blocks: Record<string, any[]>;
};

const FIXTURE = path.join(import.meta.dirname, "__fixtures__", "api-workspace.json");
const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const DB = "33333333-3333-4333-8333-333333333333";
const ROW1 = "44444444-4444-4444-8444-444444444444";
const n = (id: string) => id.replace(/-/g, "");
const IMAGE_URL_PREFIX = "https://prod-files-secure.s3.us-west-2.amazonaws.com/";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Fake Notion API serving the recorded workspace fixture. Only reads are routed. */
function fakeNotion(ws: Workspace) {
  const calls: string[] = [];
  const byNorm = <T>(rec: Record<string, T>, id: string): T | undefined =>
    Object.entries(rec).find(([k]) => n(k) === n(id))?.[1];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    const p = url.pathname.replace(/^\/v1/, "");
    calls.push(`${method} ${p}`);
    let m: RegExpExecArray | null;
    if (method === "GET" && (m = /^\/pages\/([^/]+)$/.exec(p))) {
      const page = byNorm(ws.pages, m[1]!);
      if (page) return json(page);
      if (byNorm(ws.databases, m[1]!)) {
        return json({ object: "error", code: "validation_error", message: "is a database" }, 400);
      }
      return json({ object: "error", code: "object_not_found", message: "not found" }, 404);
    }
    if (method === "GET" && (m = /^\/databases\/([^/]+)$/.exec(p))) {
      const db = byNorm(ws.databases, m[1]!);
      return db ? json(db) : json({ code: "object_not_found", message: "nf" }, 404);
    }
    if (method === "POST" && (m = /^\/databases\/([^/]+)\/query$/.exec(p))) {
      const ids = byNorm(ws.queries, m[1]!) ?? [];
      return json({
        object: "list",
        results: ids.map((id) => byNorm(ws.pages, id)),
        has_more: false,
        next_cursor: null,
      });
    }
    if (method === "GET" && (m = /^\/blocks\/([^/]+)\/children$/.exec(p))) {
      return json({
        object: "list",
        results: byNorm(ws.blocks, m[1]!) ?? [],
        has_more: false,
        next_cursor: null,
      });
    }
    if (method === "POST" && p === "/search") {
      return json({
        object: "list",
        results: [...Object.values(ws.pages), ...Object.values(ws.databases)],
        has_more: false,
        next_cursor: null,
      });
    }
    return json({ code: "invalid_request", message: `unexpected ${method} ${p}` }, 400);
  }) as typeof fetch;
  return { fetchImpl, calls };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("importNotion (API)", () => {
  let dir: string;
  let store: DocumentStore;
  let ws: Workspace;
  let fake: ReturnType<typeof fakeNotion>;
  let client: NotionClient;
  const assetFetches: string[] = [];
  const fetchAsset = async (url: string) => {
    assetFetches.push(url);
    return { data: PNG, contentType: "image/png" };
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "notion-api-"));
    store = DocumentStore.at(dir);
    ws = JSON.parse(fs.readFileSync(FIXTURE, "utf-8")) as Workspace;
    fake = fakeNotion(ws);
    client = createNotionClient({
      apiKey: "secret_test",
      fetchImpl: fake.fetchImpl,
      minIntervalMs: 0,
    });
    assetFetches.length = 0;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const bySource = (id: string): DocNode => {
    const node = store.findBySource("notion", id);
    if (!node) throw new Error(`no node for ${id}`);
    return node;
  };

  it("imports a page tree with a child page, a database and a hosted image", async () => {
    const inbox = store.create({ kind: "folder", title: "Inbox" });
    const report = await importNotion(store, client, {
      ids: [`https://www.notion.so/Team-Handbook-${n(ROOT)}`],
      parentId: inbox.id,
      fetchAsset,
    });
    expect(report.errors).toEqual([]);
    // folder:root + root doc + child doc + db folder + 2 rows
    expect(report).toMatchObject({ created: 6, updated: 0, unchanged: 0, skipped: 0 });

    const rootFolder = bySource(`folder:${n(ROOT)}`);
    expect(report.rootNodeIds).toEqual([rootFolder.id]);
    expect(rootFolder).toMatchObject({
      kind: "folder",
      title: "Team Handbook",
      parentId: inbox.id,
    });

    const rootDoc = bySource(n(ROOT));
    const childDoc = bySource(n(CHILD));
    const dbFolder = bySource(n(DB));
    expect(rootDoc).toMatchObject({
      kind: "doc",
      title: "Team Handbook",
      parentId: rootFolder.id,
      icon: "📘",
    });
    expect(rootDoc.source).toMatchObject({
      type: "notion",
      remoteEditedAt: "2026-09-01T10:00:00.000Z",
      url: expect.stringContaining(n(ROOT)),
    });
    expect(childDoc).toMatchObject({ kind: "doc", title: "Onboarding", parentId: rootFolder.id });
    expect(dbFolder).toMatchObject({
      kind: "folder",
      title: "Roadmap",
      parentId: rootFolder.id,
      view: { mode: "table" },
    });
    // The page's own doc is sorted first among the folder's docs.
    const docs = store.children(rootFolder.id).filter((c) => c.kind === "doc");
    expect(docs[0]!.id).toBe(rootDoc.id);

    // Schema (button column dropped, title first).
    expect(dbFolder.schema?.map((c) => `${c.key}:${c.type}`)).toEqual([
      "Name:title",
      "Status:select",
      "Tags:multiSelect",
      "Due:date",
      "Done:checkbox",
      "Score:number",
      "Owner:person",
      "Link:url",
      "Related:relation",
      "Calc:text",
      "Created:createdAt",
    ]);

    const rows = store.children(dbFolder.id);
    expect(rows.map((r) => r.title).sort()).toEqual(["Ship importer", "Write tests"]);
    const row1 = bySource(n(ROW1));
    expect(row1.parentId).toBe(dbFolder.id);
    expect(row1.properties).toMatchObject({
      Status: "Done",
      Tags: ["eng", "docs"],
      Due: "2026-09-01 → 2026-09-05",
      Done: true,
      Score: 3,
      Owner: ["Ada Lovelace"],
      Calc: 6,
    });
    expect(store.getBody(row1.id)).toBe("Importer ships **today**\n");
    expect(store.getBody(bySource("55555555555545558555555555555555").id)).toBe(
      "- [x] cover zip\n- [ ] cover api\n",
    );

    // Root body: links to in-scope pages become doc links, out-of-scope → notion URL,
    // hosted image downloaded into the asset store, external image left alone.
    const body = store.getBody(rootDoc.id);
    expect(assetFetches).toHaveLength(1);
    expect(assetFetches[0]).toMatch(/^https:\/\/prod-files-secure/);
    const asset = /!\[Diagram\]\((\/api\/documents\/assets\/[a-f0-9]{24}\.png)\)/.exec(body);
    expect(asset).not.toBeNull();
    expect(store.assetPath(asset![1]!.split("/").pop()!)).not.toBeNull();
    expect(body).not.toContain(IMAGE_URL_PREFIX);
    expect(body).toContain("![](https://images.example.com/logo.png)");
    expect(body).toContain(`[Onboarding](doc:${childDoc.id})`);
    expect(body).toContain("[Elsewhere](https://www.notion.so/99999999999949998999999999999999)");
    expect(body).toContain(`[Roadmap](doc:${dbFolder.id})`);
    expect(body.startsWith("# Welcome\n")).toBe(true);
    // Relative notion link in the child resolves back to the root doc.
    expect(store.getBody(childDoc.id)).toBe(
      `Welcome aboard. Back to [the handbook](doc:${rootDoc.id}).\n`,
    );
  });

  it("is idempotent: a second run is unchanged, skips block fetches and creates no duplicates", async () => {
    await importNotion(store, client, { ids: [ROOT], parentId: null, fetchAsset });
    const countBefore = store.all().length;
    fake.calls.length = 0;
    const report = await importNotion(store, client, { ids: [ROOT], parentId: null, fetchAsset });
    expect(report.errors).toEqual([]);
    expect(report).toMatchObject({ created: 0, updated: 0, unchanged: 6, skipped: 0 });
    expect(store.all().length).toBe(countBefore);
    expect(fake.calls.filter((c) => c.includes("/blocks/"))).toEqual([]);
    expect(assetFetches).toHaveLength(1);
  });

  it("detects remote edits via last_edited_time and updates only those docs", async () => {
    await importNotion(store, client, { ids: [ROOT], parentId: null, fetchAsset });
    ws.pages[CHILD].last_edited_time = "2026-09-03T00:00:00.000Z";
    ws.blocks[CHILD] = [
      {
        object: "block",
        id: "b2000000-0000-4000-8000-00000000000f",
        type: "paragraph",
        has_children: false,
        paragraph: {
          rich_text: [{ type: "text", plain_text: "Edited", text: { content: "Edited" } }],
        },
      },
    ];
    fake.calls.length = 0;
    const report = await importNotion(store, client, { ids: [ROOT], parentId: null, fetchAsset });
    expect(report).toMatchObject({ created: 0, updated: 1, unchanged: 5 });
    expect(fake.calls.filter((c) => c.includes("/blocks/"))).toEqual([
      `GET /blocks/${n(CHILD)}/children`,
    ]);
    const child = bySource(n(CHILD));
    expect(store.getBody(child.id)).toBe("Edited\n");
    expect(child.source?.remoteEditedAt).toBe("2026-09-03T00:00:00.000Z");
    expect(store.history(child.id).length).toBeGreaterThan(0);
  });

  it("force re-fetches unchanged pages; user moves survive re-import", async () => {
    await importNotion(store, client, { ids: [ROOT], parentId: null, fetchAsset });
    const elsewhere = store.create({ kind: "folder", title: "Elsewhere" });
    const child = bySource(n(CHILD));
    store.move(child.id, elsewhere.id);
    fake.calls.length = 0;
    const report = await importNotion(store, client, {
      ids: [ROOT],
      parentId: null,
      force: true,
      fetchAsset,
    });
    expect(report.created).toBe(0);
    expect(fake.calls.some((c) => c === `GET /blocks/${n(ROOT)}/children`)).toBe(true);
    expect(bySource(n(CHILD)).parentId).toBe(elsewhere.id);
  });

  it("imports a database directly and honours maxDepth / downloadAssets:false", async () => {
    const report = await importNotion(store, client, { ids: [DB], parentId: null, fetchAsset });
    expect(report.errors).toEqual([]);
    const folder = bySource(n(DB));
    expect(report.rootNodeIds).toEqual([folder.id]);
    expect(store.children(folder.id)).toHaveLength(2);

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "notion-api-"));
    try {
      const store2 = DocumentStore.at(dir2);
      const r2 = await importNotion(store2, client, {
        ids: [ROOT],
        parentId: null,
        maxDepth: 0,
        downloadAssets: false,
        fetchAsset,
      });
      expect(r2.created).toBe(1); // just the page doc: children beyond depth are not followed
      const doc = store2.findBySource("notion", n(ROOT))!;
      expect(doc.kind).toBe("doc");
      const body = store2.getBody(doc.id);
      expect(body).toContain(IMAGE_URL_PREFIX);
      expect(body).toContain("**Roadmap**");
      expect(assetFetches).toEqual([]); // no downloads when downloadAssets is false
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("reports bad ids and missing pages without aborting the rest", async () => {
    const report = await importNotion(store, client, {
      ids: ["not-an-id", "ffffffffffffffffffffffffffffffff", CHILD],
      parentId: null,
      fetchAsset,
    });
    expect(report.errors.map((e) => e.id)).toEqual([
      "not-an-id",
      "ffffffffffffffffffffffffffffffff",
    ]);
    expect(report.created).toBe(1);
  });

  it("skips pages the user trashed", async () => {
    await importNotion(store, client, { ids: [CHILD], parentId: null, fetchAsset });
    store.softDelete(bySource(n(CHILD)).id);
    const report = await importNotion(store, client, {
      ids: [CHILD],
      parentId: null,
      force: true,
      fetchAsset,
    });
    expect(report).toMatchObject({ skipped: 1, created: 0 });
  });
});

describe("createNotionClient", () => {
  it("retries 429 responses honouring Retry-After", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1)
        return json({ code: "rate_limited", message: "slow down" }, 429, { "retry-after": "2" });
      return json({ object: "page", id: "x" });
    }) as typeof fetch;
    const client = createNotionClient({
      apiKey: "k",
      fetchImpl,
      minIntervalMs: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await expect(client.request("GET", "/pages/x")).resolves.toMatchObject({ id: "x" });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([2000]);
  });

  it("gives up after maxRetries and surfaces the API error", async () => {
    const fetchImpl = (async () =>
      json({ code: "rate_limited", message: "nope" }, 429)) as typeof fetch;
    const client = createNotionClient({
      apiKey: "k",
      fetchImpl,
      minIntervalMs: 0,
      maxRetries: 2,
      sleep: async () => {},
    });
    await expect(client.request("GET", "/pages/x")).rejects.toMatchObject({ status: 429 });
  });

  it("paginates GET (query cursor) and POST (body cursor) lists", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const cursor =
        init?.method === "POST"
          ? (JSON.parse(init.body as string) as { start_cursor?: string }).start_cursor
          : (url.searchParams.get("start_cursor") ?? undefined);
      seen.push(`${init?.method} ${cursor ?? "-"}`);
      return cursor
        ? json({ results: [2], has_more: false, next_cursor: null })
        : json({ results: [1], has_more: true, next_cursor: "c2" });
    }) as typeof fetch;
    const client = createNotionClient({ apiKey: "k", fetchImpl, minIntervalMs: 0 });
    expect(await client.paginate("GET", "/blocks/x/children")).toEqual([1, 2]);
    expect(await client.paginate("POST", "/databases/x/query")).toEqual([1, 2]);
    expect(seen).toEqual(["GET -", "GET c2", "POST -", "POST c2"]);
  });

  it("sends the auth + version headers", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_: RequestInfo | URL, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>;
      return json({});
    }) as typeof fetch;
    await createNotionClient({ apiKey: "secret_x", fetchImpl, minIntervalMs: 0 }).request(
      "GET",
      "/users/me",
    );
    expect(headers).toMatchObject({
      Authorization: "Bearer secret_x",
      "Notion-Version": "2022-06-28",
    });
  });
});

describe("searchNotion", () => {
  it("returns picker rows for pages and databases", async () => {
    const ws = JSON.parse(fs.readFileSync(FIXTURE, "utf-8")) as Workspace;
    const client = createNotionClient({
      apiKey: "k",
      fetchImpl: fakeNotion(ws).fetchImpl,
      minIntervalMs: 0,
    });
    const results = await searchNotion(client, "");
    expect(results).toContainEqual({
      id: n(ROOT),
      type: "page",
      title: "Team Handbook",
      icon: "📘",
      url: expect.stringContaining(n(ROOT)),
      lastEditedTime: "2026-09-01T10:00:00.000Z",
      parentType: "workspace",
    });
    expect(results.find((r) => r.type === "database")).toMatchObject({
      id: n(DB),
      title: "Roadmap",
      parentType: "page_id",
    });
  });
});

describe("importNotion (API) — relations become links", () => {
  let dir: string;
  let store: DocumentStore;
  let client: NotionClient;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "notion-api-rel-"));
    store = DocumentStore.at(dir);
    const ws = JSON.parse(fs.readFileSync(FIXTURE, "utf-8")) as Workspace;
    client = createNotionClient({
      apiKey: "secret_test",
      fetchImpl: fakeNotion(ws).fetchImpl,
      minIntervalMs: 0,
    });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("stores relation values as doc: refs, backlinks see them, re-import is stable", async () => {
    const fetchAsset = async () => ({ data: PNG, contentType: "image/png" });
    const first = await importNotion(store, client, { ids: [ROOT], parentId: null, fetchAsset });
    expect(first.errors).toEqual([]);
    const row1 = store.findBySource("notion", n(ROW1))!;
    const row2 = store.findBySource("notion", "55555555555545558555555555555555")!;
    expect(row1.properties?.Related).toEqual([`doc:${row2.id}`]);
    expect(store.backlinks(row2.id).map((x) => x.id)).toContain(row1.id);
    expect(first.summary).toMatchObject({ failed: 0 });
    expect(first.links?.resolved).toBeGreaterThan(0);
    const total = store.all().length;
    const second = await importNotion(store, client, { ids: [ROOT], parentId: null, fetchAsset });
    expect(second).toMatchObject({ created: 0, updated: 0 });
    expect(store.all()).toHaveLength(total);
    expect(store.findBySource("notion", n(ROW1))!.properties?.Related).toEqual([`doc:${row2.id}`]);
  });

  it("relinks relation ids whose target is only written later in the run", async () => {
    // Import the row alone first (its related row is out of scope → raw id),
    // then the whole database: the relink pass upgrades the stored id.
    const fetchAsset = async () => ({ data: PNG, contentType: "image/png" });
    await importNotion(store, client, { ids: [ROW1], parentId: null, fetchAsset });
    const row1 = store.findBySource("notion", n(ROW1))!;
    expect(row1.properties?.Related).toEqual(["55555555555545558555555555555555"]);
    await importNotion(store, client, { ids: [DB], parentId: null, fetchAsset, force: true });
    const row2 = store.findBySource("notion", "55555555555545558555555555555555")!;
    expect(store.getNode(row1.id)!.properties?.Related).toEqual([`doc:${row2.id}`]);
  });
});

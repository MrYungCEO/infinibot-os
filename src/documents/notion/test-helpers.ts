/**
 * Fake Notion API for tests and the side-gateway e2e mock server (excluded
 * from the build by the `src/** /test-helpers.ts` tsconfig rule).
 *
 * Generates a deterministic workspace (nested pages + a database), serves the
 * read endpoints the importer uses (pages, databases, database query, block
 * children, search — all paginated), and can inject latency, 429s (fixed
 * cadence and/or a ~3 req/s token bucket) and hangs.
 */

import { randomUUID } from "node:crypto";
import http from "node:http";

/* eslint-disable @typescript-eslint/no-explicit-any -- Notion JSON payloads */
type Json = Record<string, any>;

export interface FakePage {
  id: string;
  title: string;
  parent: Json;
  lastEdited: string;
  childPages: string[];
  childDatabases: string[];
  paragraphs: string[];
  /** Page ids mentioned inline (exercises the relink pass). */
  mentions: string[];
  rowProps?: { status: string };
  archived?: boolean;
}

export interface FakeDatabase {
  id: string;
  title: string;
  parent: Json;
  lastEdited: string;
  rows: string[];
}

export interface FakeWorkspace {
  rootId: string;
  pages: Map<string, FakePage>;
  databases: Map<string, FakeDatabase>;
}

export interface BuildWorkspaceOptions {
  topPages?: number;
  childrenPerPage?: number;
  grandchildrenPerPage?: number;
  rows?: number;
  paragraphs?: number;
  baseTime?: string;
}

const uuid = (n: number, salt: number) => {
  const hex = (salt.toString(16).padStart(4, "0") + n.toString(16).padStart(28, "0")).slice(-32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
};

/** ~ 1 + top + top*children + top*children*grandchildren pages + `rows` database rows. */
export function buildWorkspace(o: BuildWorkspaceOptions = {}): FakeWorkspace {
  const top = o.topPages ?? 8;
  const kids = o.childrenPerPage ?? 6;
  const grand = o.grandchildrenPerPage ?? 4;
  const rows = o.rows ?? 250;
  const paras = o.paragraphs ?? 3;
  const base = Date.parse(o.baseTime ?? "2026-09-01T00:00:00.000Z");
  let n = 0;
  const pages = new Map<string, FakePage>();
  const databases = new Map<string, FakeDatabase>();
  const time = () => new Date(base + n * 60_000).toISOString();
  const para = (title: string) =>
    Array.from({ length: paras }, (_, i) => `${title} — paragraph ${i + 1}.`);
  const mkPage = (title: string, parent: Json): FakePage => {
    n += 1;
    const p: FakePage = {
      id: uuid(n, 0xa11),
      title,
      parent,
      lastEdited: time(),
      childPages: [],
      childDatabases: [],
      paragraphs: para(title),
      mentions: [],
    };
    pages.set(p.id, p);
    return p;
  };
  const root = mkPage("Company Wiki", { type: "workspace", workspace: true });
  const allPages: FakePage[] = [];
  for (let t = 0; t < top; t++) {
    const tp = mkPage(`Section ${t + 1}`, { type: "page_id", page_id: root.id });
    root.childPages.push(tp.id);
    allPages.push(tp);
    for (let c = 0; c < kids; c++) {
      const cp = mkPage(`Section ${t + 1}.${c + 1}`, { type: "page_id", page_id: tp.id });
      tp.childPages.push(cp.id);
      allPages.push(cp);
      for (let g = 0; g < grand; g++) {
        const gp = mkPage(`Note ${t + 1}.${c + 1}.${g + 1}`, { type: "page_id", page_id: cp.id });
        cp.childPages.push(gp.id);
        allPages.push(gp);
      }
    }
  }
  // Forward mentions: early pages mention pages imported much later.
  for (let i = 0; i < allPages.length; i += 7) {
    const target = allPages[(i + Math.floor(allPages.length / 2)) % allPages.length]!;
    allPages[i]!.mentions.push(target.id);
  }
  n += 1;
  const db: FakeDatabase = {
    id: uuid(n, 0xdb0),
    title: "Tasks",
    parent: { type: "page_id", page_id: root.id },
    lastEdited: time(),
    rows: [],
  };
  databases.set(db.id, db);
  root.childDatabases.push(db.id);
  for (let r = 0; r < rows; r++) {
    const row = mkPage(`Task ${r + 1}`, { type: "database_id", database_id: db.id });
    row.rowProps = { status: r % 3 === 0 ? "Done" : "Todo" };
    db.rows.push(row.id);
  }
  return { rootId: root.id, pages, databases };
}

export function workspaceSize(ws: FakeWorkspace): number {
  return ws.pages.size + ws.databases.size;
}

/** Simulate a remote edit (bumps last_edited_time + body text). */
export function editPage(ws: FakeWorkspace, id: string, at = new Date().toISOString()): void {
  const p = ws.pages.get(id);
  if (!p) throw new Error(`no page ${id}`);
  p.lastEdited = at;
  p.paragraphs = [...p.paragraphs, `Edited at ${at}.`];
}

/** Simulate a new database row. */
export function addRow(
  ws: FakeWorkspace,
  dbId: string,
  title: string,
  at = new Date().toISOString(),
): string {
  const db = ws.databases.get(dbId)!;
  const id = randomUUID();
  ws.pages.set(id, {
    id,
    title,
    parent: { type: "database_id", database_id: db.id },
    lastEdited: at,
    childPages: [],
    childDatabases: [],
    paragraphs: [`${title} body.`],
    mentions: [],
    rowProps: { status: "Todo" },
  });
  db.rows.push(id);
  return id;
}

const norm = (id: string) => id.replace(/-/g, "").toLowerCase();
const rt = (text: string) => [{ type: "text", plain_text: text, text: { content: text } }];

function pageJson(p: FakePage): Json {
  const isRow = p.parent.type === "database_id";
  return {
    object: "page",
    id: p.id,
    created_time: p.lastEdited,
    last_edited_time: p.lastEdited,
    archived: !!p.archived,
    in_trash: !!p.archived,
    url: `https://www.notion.so/${p.title.replace(/[^a-z0-9]+/gi, "-")}-${norm(p.id)}`,
    icon: null,
    parent: p.parent,
    properties: isRow
      ? {
          Name: { id: "title", type: "title", title: rt(p.title) },
          Status: { id: "st", type: "select", select: { name: p.rowProps?.status ?? "Todo" } },
        }
      : { title: { id: "title", type: "title", title: rt(p.title) } },
  };
}

function dbJson(d: FakeDatabase): Json {
  return {
    object: "database",
    id: d.id,
    title: rt(d.title),
    last_edited_time: d.lastEdited,
    archived: false,
    in_trash: false,
    url: `https://www.notion.so/${norm(d.id)}`,
    parent: d.parent,
    properties: {
      Name: { id: "title", name: "Name", type: "title", title: {} },
      Status: {
        id: "st",
        name: "Status",
        type: "select",
        select: { options: [{ name: "Todo" }, { name: "Done" }] },
      },
    },
  };
}

function blocksFor(ws: FakeWorkspace, p: FakePage): Json[] {
  const out: Json[] = [];
  let i = 0;
  const bid = () => `${norm(p.id).slice(0, 24)}${(i++).toString(16).padStart(8, "0")}`;
  for (const text of p.paragraphs) {
    out.push({
      object: "block",
      id: bid(),
      type: "paragraph",
      has_children: false,
      paragraph: { rich_text: rt(text) },
    });
  }
  for (const m of p.mentions) {
    const target = ws.pages.get(m);
    out.push({
      object: "block",
      id: bid(),
      type: "paragraph",
      has_children: false,
      paragraph: {
        rich_text: [
          { type: "text", plain_text: "See ", text: { content: "See " } },
          {
            type: "mention",
            plain_text: target?.title ?? "page",
            mention: { type: "page", page: { id: m } },
            href: `https://www.notion.so/${norm(m)}`,
          },
        ],
      },
    });
  }
  for (const c of p.childPages) {
    const cp = ws.pages.get(c);
    if (cp)
      out.push({
        object: "block",
        id: c,
        type: "child_page",
        has_children: true,
        child_page: { title: cp.title },
      });
  }
  for (const d of p.childDatabases) {
    const db = ws.databases.get(d);
    if (db)
      out.push({
        object: "block",
        id: d,
        type: "child_database",
        has_children: false,
        child_database: { title: db.title },
      });
  }
  return out;
}

export interface FakeNotionOptions {
  latencyMs?: number;
  /** Every Nth request gets a 429 (Retry-After: `retryAfterSec`). */
  rateLimitEvery?: number;
  retryAfterSec?: number;
  /** Token-bucket limit (requests/second); excess requests get a 429. */
  maxRps?: number;
  /** Requests after this many never resolve (until aborted) — simulates a dying process. */
  hangAfter?: number;
  /** Expected bearer token (401 otherwise). */
  token?: string;
}

export interface FakeNotionStats {
  requests: number;
  rateLimited: number;
  calls: string[];
}

interface FakeResponse {
  status: number;
  body: Json;
  headers?: Record<string, string>;
}

function paginate<T>(items: T[], cursor: string | undefined, size: number) {
  const start = cursor ? Number(cursor) || 0 : 0;
  const results = items.slice(start, start + size);
  const next = start + size < items.length ? String(start + size) : null;
  return { object: "list", results, has_more: !!next, next_cursor: next };
}

export function createFakeNotion(ws: FakeWorkspace, opts: FakeNotionOptions = {}) {
  const stats: FakeNotionStats = { requests: 0, rateLimited: 0, calls: [] };
  let bucket = opts.maxRps ?? 0;
  let bucketAt = Date.now();

  function handle(
    method: string,
    rawPath: string,
    body: Json,
    auth: string | undefined,
  ): FakeResponse {
    const url = new URL(rawPath, "http://fake");
    const p = url.pathname.replace(/^\/v1/, "");
    stats.calls.push(`${method} ${p}`);
    if (opts.token && auth !== `Bearer ${opts.token}`) {
      return {
        status: 401,
        body: { object: "error", code: "unauthorized", message: "API token is invalid." },
      };
    }
    const n = stats.requests;
    let limited = !!opts.rateLimitEvery && n % opts.rateLimitEvery === 0;
    if (opts.maxRps) {
      const now = Date.now();
      bucket = Math.min(opts.maxRps, bucket + ((now - bucketAt) / 1000) * opts.maxRps);
      bucketAt = now;
      if (bucket < 1) limited = true;
      else bucket -= 1;
    }
    if (limited) {
      stats.rateLimited += 1;
      return {
        status: 429,
        body: { object: "error", code: "rate_limited", message: "Rate limited" },
        headers: { "retry-after": String(opts.retryAfterSec ?? 1) },
      };
    }
    const size = Math.min(
      100,
      Number(url.searchParams.get("page_size") ?? body.page_size ?? 100) || 100,
    );
    const cursor = url.searchParams.get("start_cursor") ?? body.start_cursor;
    let m: RegExpExecArray | null;
    const byId = <T>(map: Map<string, T>, id: string) =>
      [...map.entries()].find(([k]) => norm(k) === norm(id))?.[1];
    if (method === "GET" && (m = /^\/pages\/([^/]+)$/.exec(p))) {
      const page = byId(ws.pages, m[1]!);
      if (page) return { status: 200, body: pageJson(page) };
      if (byId(ws.databases, m[1]!)) {
        return {
          status: 400,
          body: { object: "error", code: "validation_error", message: "is a database" },
        };
      }
      return {
        status: 404,
        body: { object: "error", code: "object_not_found", message: "not found" },
      };
    }
    if (method === "GET" && (m = /^\/databases\/([^/]+)$/.exec(p))) {
      const db = byId(ws.databases, m[1]!);
      return db
        ? { status: 200, body: dbJson(db) }
        : {
            status: 404,
            body: { object: "error", code: "object_not_found", message: "not found" },
          };
    }
    if (method === "POST" && (m = /^\/databases\/([^/]+)\/query$/.exec(p))) {
      const db = byId(ws.databases, m[1]!);
      if (!db)
        return { status: 404, body: { object: "error", code: "object_not_found", message: "nf" } };
      const rows = db.rows
        .map((id) => ws.pages.get(id)!)
        .filter((r) => !r.archived)
        .map(pageJson);
      return { status: 200, body: paginate(rows, cursor, size) };
    }
    if (method === "GET" && (m = /^\/blocks\/([^/]+)\/children$/.exec(p))) {
      const page = byId(ws.pages, m[1]!);
      return { status: 200, body: paginate(page ? blocksFor(ws, page) : [], cursor, size) };
    }
    if (method === "POST" && p === "/search") {
      const q = String(body.query ?? "").toLowerCase();
      const all = [
        ...[...ws.pages.values()].filter((x) => !x.archived).map(pageJson),
        ...[...ws.databases.values()].map(dbJson),
      ]
        .filter((o) => {
          if (!q) return true;
          const title =
            o.object === "database"
              ? o.title[0].plain_text
              : Object.values<Json>(o.properties).find((v) => v.type === "title")?.title?.[0]
                  ?.plain_text;
          return String(title ?? "")
            .toLowerCase()
            .includes(q);
        })
        .sort((a, b) => b.last_edited_time.localeCompare(a.last_edited_time));
      return { status: 200, body: paginate(all, cursor, size) };
    }
    return {
      status: 400,
      body: { object: "error", code: "invalid_request", message: `unexpected ${method} ${p}` },
    };
  }

  async function respond(
    method: string,
    path: string,
    body: Json,
    auth: string | undefined,
    signal?: AbortSignal | null,
  ): Promise<FakeResponse> {
    stats.requests += 1;
    if (opts.hangAfter !== undefined && stats.requests > opts.hangAfter) {
      await new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), {
          once: true,
        });
      });
    }
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    return handle(method, path, body, auth);
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Json) : {};
    const r = await respond(
      init?.method ?? "GET",
      url.pathname + url.search,
      body,
      headers.get("authorization") ?? undefined,
      init?.signal,
    );
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json", ...r.headers },
    });
  }) as typeof fetch;

  /** Real HTTP server (for the side-gateway e2e). */
  function listen(port: number, host = "127.0.0.1"): Promise<http.Server> {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const ctl = new AbortController();
        res.on("close", () => ctl.abort());
        let body: Json = {};
        try {
          body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Json) : {};
        } catch {
          /* ignore */
        }
        void respond(
          req.method ?? "GET",
          req.url ?? "/",
          body,
          req.headers.authorization,
          ctl.signal,
        )
          .then((r) => {
            res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
            res.end(JSON.stringify(r.body));
          })
          .catch(() => res.destroy());
      });
    });
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  }

  return { fetchImpl, stats, listen };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

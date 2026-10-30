import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateNotionImportParams } from "../gateway/server-methods/documents.js";
import { ImportJobManager, type ImportJobView } from "./import-jobs.js";
import { createNotionClient, type NotionClientOptions } from "./notion/api-import.js";
import {
  addRow,
  buildWorkspace,
  createFakeNotion,
  editPage,
  workspaceSize,
  type FakeNotionOptions,
  type FakeWorkspace,
} from "./notion/test-helpers.js";
import { DocumentStore } from "./store.js";

const norm = (id: string) => id.replace(/-/g, "");

describe("ImportJobManager (Notion import jobs)", () => {
  let dir: string;
  let storeRoot: string;
  let jobsDir: string;
  let ws: FakeWorkspace;
  const events: Array<{ event: string; job: ImportJobView }> = [];
  const treeRefreshes: string[][] = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "import-jobs-"));
    storeRoot = path.join(dir, "documents");
    jobsDir = path.join(dir, "jobs");
    process.env.INFINIBOT_STATE_DIR = dir;
    ws = buildWorkspace({ topPages: 3, childrenPerPage: 3, grandchildrenPerPage: 2, rows: 30 });
    events.length = 0;
    treeRefreshes.length = 0;
  });

  afterEach(() => {
    delete process.env.INFINIBOT_STATE_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function manager(
    fake: FakeNotionOptions = {},
    extra: { pid?: number; alive?: boolean; sleeps?: number[]; token?: string | null } = {},
  ) {
    const notion = createFakeNotion(ws, fake);
    const sleeps = extra.sleeps;
    const m = new ImportJobManager({
      dir: jobsDir,
      resolveApiKey: () => (extra.token === undefined ? "secret_fake" : extra.token),
      createClient: (o: NotionClientOptions) => createNotionClient(o),
      clientOptions: {
        fetchImpl: notion.fetchImpl,
        minIntervalMs: 0,
        ...(sleeps
          ? {
              sleep: async (ms: number) => {
                sleeps.push(ms);
              },
            }
          : {}),
      },
      broadcast: (event, payload) =>
        events.push({ event, job: (payload as { job: ImportJobView }).job }),
      documentsChanged: (ids) => treeRefreshes.push(ids),
      storeAt: (root) => DocumentStore.at(root),
      pid: extra.pid ?? 1111,
      isPidAlive: () => extra.alive ?? false,
      progressThrottleMs: 0,
    });
    return { m, notion };
  }

  const store = () => DocumentStore.at(storeRoot);
  const notionDocs = () =>
    store()
      .all()
      .filter((n) => n.source?.type === "notion");
  const blockCalls = (calls: string[]) => calls.filter((c) => c.includes("/blocks/")).length;

  it("runs a full import as a background job: queued → running → done, streaming progress + tree refreshes", async () => {
    const { m } = manager();
    const { job, reattached } = m.startNotion({ ids: [ws.rootId], parentId: null });
    expect(reattached).toBe(false);
    expect(["queued", "running"]).toContain(job.status);
    expect(job.id).toMatch(/^imp_/);
    const done = await m.wait(job.id, 20_000);
    expect(done?.status).toBe("done");
    expect(done?.report.errors).toEqual([]);
    // pages + the database folder + one folder per page with children
    const pagesWithKids = [...ws.pages.values()].filter(
      (p) => p.childPages.length || p.childDatabases.length,
    ).length;
    expect(done?.report.created).toBe(workspaceSize(ws) + pagesWithKids);
    expect(notionDocs().filter((n) => n.kind === "doc")).toHaveLength(ws.pages.size);
    expect(done?.progress.done).toBe(workspaceSize(ws));
    expect(done?.progress.total).toBe(workspaceSize(ws));

    const statuses = events.filter((e) => e.job.id === job.id).map((e) => e.job.status);
    expect(statuses[0]).toBe("queued");
    expect(statuses).toContain("running");
    expect(statuses.at(-1)).toBe("done");
    // Progress was streamed with a current page title while running.
    expect(events.some((e) => e.job.status === "running" && e.job.progress.current)).toBe(true);
    expect(treeRefreshes.length).toBeGreaterThan(0);

    // Persisted terminal state.
    const onDisk = JSON.parse(fs.readFileSync(path.join(jobsDir, `${job.id}.json`), "utf-8"));
    expect(onDisk.status).toBe("done");
    expect(onDisk.storeRoot).toBe(storeRoot);
    expect(m.list()[0]?.id).toBe(job.id);
    expect(m.get(job.id)?.status).toBe("done");

    // Forward mentions (pages written before their target) were relinked to doc: links.
    const early = [...ws.pages.values()].find((p) => p.mentions.length)!;
    const target = store().findBySource("notion", norm(early.mentions[0]!))!;
    const body = store().getBody(store().findBySource("notion", norm(early.id))!.id);
    expect(body).toContain(`(doc:${target.id})`);
  });

  it("reattaches to an identical active job instead of starting a second one", async () => {
    const { m } = manager({ latencyMs: 2 });
    const a = m.startNotion({ ids: [ws.rootId], parentId: null });
    const b = m.startNotion({ ids: [ws.rootId], parentId: null });
    expect(b.reattached).toBe(true);
    expect(b.job.id).toBe(a.job.id);
    const c = m.startNotion({ ids: [ws.rootId], parentId: null, mode: "changes" });
    expect(c.job.id).not.toBe(a.job.id);
    m.cancel(c.job.id);
    await m.wait(a.job.id, 20_000);
  });

  it("resumes after a gateway restart without redoing written pages or duplicating docs", async () => {
    // Process A dies (requests hang forever) part-way through the import.
    const a = manager({ hangAfter: 40 }, { pid: 1111 });
    const { job } = a.m.startNotion({ ids: [ws.rootId], parentId: null });
    for (let i = 0; i < 200 && a.notion.stats.requests <= 40; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const writtenBefore = notionDocs().length;
    expect(writtenBefore).toBeGreaterThan(0);
    expect(writtenBefore).toBeLessThan(workspaceSize(ws));
    const persisted = JSON.parse(fs.readFileSync(path.join(jobsDir, `${job.id}.json`), "utf-8"));
    expect(persisted.status).toBe("running");

    // Process B boots with the same state dir; A's pid is dead → B resumes it.
    const b = manager({}, { pid: 2222, alive: false });
    const { resumed } = b.m.resumeAll();
    expect(resumed).toEqual([job.id]);
    const done = await b.m.wait(job.id, 20_000);
    expect(done?.status).toBe("done");
    expect(done?.attempts).toBe(2);
    expect(done?.report.errors).toEqual([]);
    expect(notionDocs().filter((n) => n.kind === "doc")).toHaveLength(ws.pages.size);
    // No duplicates: every Notion source id appears once.
    const ids = notionDocs().map((n) => n.source!.id);
    expect(new Set(ids).size).toBe(ids.length);
    // B skipped block fetches for pages A had already finished.
    expect(blockCalls(b.notion.stats.calls)).toBeLessThan(ws.pages.size);
    // Every doc carries this job's sync stamp.
    expect(notionDocs().every((n) => n.source?.syncRun === job.id)).toBe(true);
    // Forward mentions in pages written before the "crash" were still relinked.
    for (const p of [...ws.pages.values()].filter((x) => x.mentions.length)) {
      const body = store().getBody(store().findBySource("notion", norm(p.id))!.id);
      const target = store().findBySource("notion", norm(p.mentions[0]!))!;
      expect(body).toContain(`(doc:${target.id})`);
      expect(body).not.toContain("notion.so");
    }
  });

  it("leaves a job alone when another live gateway still owns it", async () => {
    const a = manager({ hangAfter: 5 }, { pid: 1111 });
    const { job } = a.m.startNotion({ ids: [ws.rootId], parentId: null });
    await new Promise((r) => setTimeout(r, 30));
    const b = manager({}, { pid: 2222, alive: true });
    expect(b.m.resumeAll().resumed).toEqual([]);
    a.m.cancel(job.id);
  });

  it("backs off on 429s (honouring Retry-After) and still completes", async () => {
    const sleeps: number[] = [];
    const { m, notion } = manager({ rateLimitEvery: 9, retryAfterSec: 2 }, { sleeps });
    const { job } = m.startNotion({ ids: [ws.rootId], parentId: null });
    const done = await m.wait(job.id, 20_000);
    expect(done?.status).toBe("done");
    expect(done?.report.errors).toEqual([]);
    expect(notion.stats.rateLimited).toBeGreaterThan(5);
    expect(sleeps.filter((s) => s === 2000).length).toBe(notion.stats.rateLimited);
    expect(done?.progress.rateLimited).toBe(notion.stats.rateLimited);
    expect(events.some((e) => e.job.progress.rateLimitedUntil)).toBe(true);
    expect(notionDocs().filter((n) => n.kind === "doc")).toHaveLength(ws.pages.size);
  });

  it("full re-sync skips unchanged pages; 'changes' mode refreshes only edited pages", async () => {
    const first = manager();
    await first.m.wait(first.m.startNotion({ ids: [ws.rootId], parentId: null }).job.id, 20_000);
    const docCount = notionDocs().length;

    // Second full re-sync: nothing changed → no block fetches, everything unchanged.
    const second = manager();
    const r2 = await second.m.wait(
      second.m.startNotion({ ids: [ws.rootId], parentId: null }).job.id,
      20_000,
    );
    expect(r2?.status).toBe("done");
    expect(r2?.report).toMatchObject({ created: 0, updated: 0 });
    expect(r2?.report.unchanged).toBe(docCount);
    expect(blockCalls(second.notion.stats.calls)).toBe(0);

    // Two remote edits + one new database row.
    const pages = [...ws.pages.values()].filter((p) => p.parent.type === "page_id");
    const later = new Date(Date.now() + 60_000).toISOString();
    editPage(ws, pages[2]!.id, later);
    editPage(ws, pages[9]!.id, later);
    const dbId = [...ws.databases.keys()][0]!;
    const newRow = addRow(ws, dbId, "Fresh task", later);

    const third = manager();
    const r3 = await third.m.wait(
      third.m.startNotion({ ids: [ws.rootId], parentId: null, mode: "changes" }).job.id,
      20_000,
    );
    expect(r3?.status).toBe("done");
    expect(r3?.report.errors).toEqual([]);
    expect(r3?.report.updated).toBe(2);
    expect(r3?.report.created).toBe(1);
    // Only the 3 changed pages had their blocks fetched; search did the discovery.
    expect(blockCalls(third.notion.stats.calls)).toBe(3);
    expect(third.notion.stats.calls).toContain("POST /search");
    expect(third.notion.stats.requests).toBeLessThan(ws.pages.size / 4);
    const edited = store().findBySource("notion", norm(pages[2]!.id))!;
    expect(store().getBody(edited.id)).toContain("Edited at");
    const row = store().findBySource("notion", norm(newRow))!;
    expect(row.parentId).toBe(store().findBySource("notion", norm(dbId))!.id);
  });

  it("cancels a running job, keeps pages written so far, and never resumes it", async () => {
    const { m } = manager({ latencyMs: 3 });
    const { job } = m.startNotion({ ids: [ws.rootId], parentId: null });
    for (let i = 0; i < 400 && notionDocs().length < 5; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const view = m.cancel(job.id);
    expect(view?.cancelRequested).toBe(true);
    const done = await m.wait(job.id, 10_000);
    expect(done?.status).toBe("cancelled");
    const kept = notionDocs().length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(workspaceSize(ws));
    const b = manager({}, { pid: 3333 });
    expect(b.m.resumeAll().resumed).toEqual([]);
    expect(b.m.get(job.id)?.status).toBe("cancelled");
  });

  it("cancelling a queued job finishes it immediately", () => {
    const { m } = manager({ hangAfter: 0 });
    const a = m.startNotion({ ids: [ws.rootId], parentId: null });
    const q = m.startNotion({ ids: [ws.rootId], parentId: null, mode: "changes" });
    expect(m.get(q.job.id)?.status).toBe("queued"); // one job per tenant at a time
    expect(m.cancel(q.job.id)?.status).toBe("cancelled");
    m.cancel(a.job.id);
  });

  it("an inline (pasted) token isn't persisted, so a resumed job fails with a clear message", async () => {
    const a = manager({ hangAfter: 3 }, { token: null });
    const { job } = a.m.startNotion({ ids: [ws.rootId], parentId: null, token: "secret_inline" });
    await new Promise((r) => setTimeout(r, 30));
    expect(fs.readFileSync(path.join(jobsDir, `${job.id}.json`), "utf-8")).not.toContain(
      "secret_inline",
    );
    const b = manager({}, { pid: 4444, token: null });
    b.m.resumeAll();
    const done = await b.m.wait(job.id, 5_000);
    expect(done?.status).toBe("failed");
    expect(done?.error).toMatch(/token isn't stored/);
  });

  it("fails cleanly when the target folder was deleted", async () => {
    const folder = store().create({ kind: "folder", title: "Inbox" });
    const { m } = manager({ hangAfter: 0 });
    const blocker = m.startNotion({ ids: [ws.rootId], parentId: null });
    const { job } = m.startNotion({ ids: [ws.rootId], parentId: folder.id });
    store().softDelete(folder.id);
    m.cancel(blocker.job.id);
    const done = await m.wait(job.id, 5_000);
    expect(done?.status).toBe("failed");
    expect(done?.error).toMatch(/folder/);
  });
  it("hosted (SaaS) tenants: an API import stops at the page cap and keeps what it wrote", async () => {
    process.env.SAAS_MODE = "1";
    process.env.INFINIBOT_DOCUMENTS_NOTION_MAX_PAGES = "5";
    try {
      const { m } = manager();
      const { job } = m.startNotion({ ids: [ws.rootId], parentId: null });
      const done = await m.wait(job.id, 20_000);
      expect(done?.status).toBe("failed");
      expect(done?.error).toMatch(/Stopped after 5 pages/);
      const kept = notionDocs().filter((n) => n.kind === "doc").length;
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThan(ws.pages.size);
    } finally {
      delete process.env.SAAS_MODE;
      delete process.env.INFINIBOT_DOCUMENTS_NOTION_MAX_PAGES;
    }
  });
});

describe("validateNotionImportParams", () => {
  it("accepts a well-formed request and applies defaults", () => {
    expect(validateNotionImportParams({ ids: [" abc "], parentId: null })).toMatchObject({
      ids: ["abc"],
      parentId: null,
      mode: "full",
      force: false,
      waitMs: 0,
    });
    expect(
      validateNotionImportParams({ ids: ["x"], mode: "changes", waitMs: 999_999 }).waitMs,
    ).toBe(50_000);
  });

  it.each([
    [{}, /ids/],
    [{ ids: [] }, /ids/],
    [{ ids: [1] }, /ids must be/],
    [{ ids: ["x"], mode: "everything" }, /mode/],
    [{ ids: ["x"], force: "yes" }, /force/],
    [{ ids: ["x"], parentId: 5 }, /parentId/],
    [{ ids: Array.from({ length: 101 }, () => "x") }, /at most/],
  ])("rejects %j", (params, err) => {
    expect(() => validateNotionImportParams(params as Record<string, unknown>)).toThrow(err);
  });
});

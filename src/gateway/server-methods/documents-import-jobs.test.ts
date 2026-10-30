import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImportJobManager, setImportJobManagerForTest } from "../../documents/import-jobs.js";
import { createNotionClient } from "../../documents/notion/api-import.js";
import { buildWorkspace, createFakeNotion } from "../../documents/notion/test-helpers.js";
import { DocumentStore } from "../../documents/store.js";
import { GATEWAY_EVENTS, listGatewayMethods } from "../server-methods-list.js";
import { DOCUMENTS_READ_METHODS, DOCUMENTS_WRITE_METHODS, documentsHandlers } from "./documents.js";

type Res = { ok: boolean; payload?: any; error?: { message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(method: string, params: Record<string, unknown>): Promise<Res> {
  let out: Res = { ok: false };
  await documentsHandlers[method]!({
    params,
    respond: (ok: boolean, payload?: unknown, error?: { message: string }) => {
      out = { ok, payload, error };
    },
  } as never);
  return out;
}

describe("documents.notion.import / jobs RPCs", () => {
  let dir: string;
  const ws = buildWorkspace({ topPages: 2, childrenPerPage: 2, grandchildrenPerPage: 1, rows: 5 });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-jobs-rpc-"));
    process.env.INFINIBOT_STATE_DIR = dir;
    process.env.NOTION_API_KEY = "secret_rpc_test";
    const fake = createFakeNotion(ws);
    setImportJobManagerForTest(
      new ImportJobManager({
        dir: path.join(dir, "jobs"),
        resolveApiKey: () => "secret_rpc_test",
        createClient: (o) => createNotionClient(o),
        clientOptions: { fetchImpl: fake.fetchImpl, minIntervalMs: 0 },
        broadcast: () => undefined,
        documentsChanged: () => undefined,
        storeAt: (root) => DocumentStore.at(root),
      }),
    );
  });

  afterEach(() => {
    setImportJobManagerForTest(null);
    delete process.env.INFINIBOT_STATE_DIR;
    delete process.env.NOTION_API_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns a job id immediately and exposes get / list / cancel", async () => {
    const started = await call("documents.notion.import", { ids: [ws.rootId], parentId: null });
    expect(started.ok).toBe(true);
    expect(started.payload.jobId).toMatch(/^imp_/);
    expect(started.payload.job.status).toMatch(/queued|running/);

    const got = await call("documents.notion.jobs.get", { jobId: started.payload.jobId });
    expect(got.ok).toBe(true);
    expect(got.payload.job.id).toBe(started.payload.jobId);
    expect(got.payload.job).not.toHaveProperty("storeRoot");

    const listed = await call("documents.notion.jobs.list", { active: false, limit: 5 });
    expect(listed.payload.jobs.map((j: { id: string }) => j.id)).toContain(started.payload.jobId);

    const waited = await call("documents.notion.import", {
      ids: [ws.rootId],
      parentId: null,
      waitMs: 20_000,
    });
    // Identical active job is reattached; waitMs returns the finished job inline.
    expect(waited.payload.jobId).toBe(started.payload.jobId);
    expect(waited.payload.reattached).toBe(true);
    expect(waited.payload.job.status).toBe("done");

    const cancelled = await call("documents.notion.jobs.cancel", { jobId: started.payload.jobId });
    expect(cancelled.payload.job.status).toBe("done"); // already finished → unchanged
  });

  it("rejects malformed params and unknown job ids", async () => {
    expect((await call("documents.notion.import", { ids: "x" })).error?.message).toMatch(/ids/);
    expect(
      (await call("documents.notion.import", { ids: ["x"], mode: "all" })).error?.message,
    ).toMatch(/mode/);
    expect(
      (await call("documents.notion.jobs.get", { jobId: "../../etc/passwd" })).error?.message,
    ).toMatch(/valid/);
    expect(
      (await call("documents.notion.jobs.get", { jobId: "imp_nope_1234" })).error?.message,
    ).toMatch(/not found/);
    expect((await call("documents.notion.jobs.list", { active: "yes" })).error?.message).toMatch(
      /active/,
    );
  });

  it("is registered, scope-classified and announces its progress event", () => {
    const methods = listGatewayMethods();
    for (const m of [
      "documents.notion.jobs.get",
      "documents.notion.jobs.list",
      "documents.notion.jobs.cancel",
    ]) {
      expect(methods).toContain(m);
      expect(documentsHandlers[m]).toBeTypeOf("function");
    }
    expect(DOCUMENTS_READ_METHODS).toEqual(
      expect.arrayContaining(["documents.notion.jobs.get", "documents.notion.jobs.list"]),
    );
    expect(DOCUMENTS_WRITE_METHODS).toEqual(
      expect.arrayContaining(["documents.notion.import", "documents.notion.jobs.cancel"]),
    );
    const src = fs.readFileSync(path.join(import.meta.dirname, "..", "server-methods.ts"), "utf-8");
    for (const m of [
      "documents.notion.jobs.get",
      "documents.notion.jobs.list",
      "documents.notion.jobs.cancel",
    ]) {
      expect(src).toContain(`"${m}"`); // present in the READ/WRITE scope sets
    }
    expect(GATEWAY_EVENTS).toContain("documents.import.progress");
  });
});

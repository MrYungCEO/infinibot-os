/**
 * Documents in the hosted cloud: per-tenant stores, per-file + per-workspace
 * upload limits. Runs against a temp INFINIBOT_STATE_DIR.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runWithUserId } from "../config/paths.js";

let stateDir: string;
const prev = { ...process.env };

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-docs-limits-"));
  process.env.INFINIBOT_STATE_DIR = stateDir;
});
afterAll(() => {
  process.env = { ...prev };
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("documents limits", () => {
  it("self-hosted keeps 200 MB / no quota; SaaS tenants get 25 MB / 1 GB / 500 pages", async () => {
    const { documentsLimits } = await import("./tenant-limits.js");
    expect(documentsLimits({})).toEqual({
      maxUploadBytes: 200 * 1024 * 1024,
      quotaBytes: null,
      notionMaxPages: null,
    });
    expect(documentsLimits({ SAAS_MODE: "1" })).toEqual({
      maxUploadBytes: 25 * 1024 * 1024,
      quotaBytes: 1024 * 1024 * 1024,
      notionMaxPages: 500,
    });
    expect(
      documentsLimits({ SAAS_MODE: "1", INFINIBOT_DOCUMENTS_QUOTA_BYTES: "4096" }).quotaBytes,
    ).toBe(4096);
  });

  it("each tenant has its own store; one tenant never sees another's files", async () => {
    const svc = await import("./service.js");
    await runWithUserId("t_alice", () =>
      svc.uploadFile({ name: "alice.md", data: Buffer.from("# Alice secret\n"), author: "user" }),
    );
    const bobTitles = runWithUserId("t_bob", () =>
      svc
        .documentsStore()
        .tree({})
        .map((n) => n.title),
    );
    const aliceTitles = runWithUserId("t_alice", () =>
      svc
        .documentsStore()
        .tree({})
        .map((n) => n.title),
    );
    expect(aliceTitles).toContain("alice");
    expect(bobTitles).not.toContain("alice");
    expect(runWithUserId("t_alice", () => svc.documentsStore().root)).toBe(
      path.join(stateDir, "users", "t_alice", "documents"),
    );
  });

  it("an upload that would exceed the workspace quota is refused with 413", async () => {
    process.env.SAAS_MODE = "1";
    process.env.INFINIBOT_DOCUMENTS_QUOTA_BYTES = String(64 * 1024);
    try {
      const svc = await import("./service.js");
      const big = Buffer.alloc(80 * 1024, "a");
      await expect(
        runWithUserId("t_quota", () =>
          svc.uploadFile({ name: "big.txt", data: big, author: "user", keepAsFile: true }),
        ),
      ).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/storage is full/) });
      // A small file still fits.
      await runWithUserId("t_quota", () =>
        svc.uploadFile({ name: "small.md", data: Buffer.from("ok"), author: "user" }),
      );
    } finally {
      delete process.env.SAAS_MODE;
      delete process.env.INFINIBOT_DOCUMENTS_QUOTA_BYTES;
    }
  });
});

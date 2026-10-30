import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearAuth,
  loadAuth,
  resolveAuthFilePath,
  saveAuth,
  type StoredAuth,
} from "./token-store.js";

const ORIGINAL_ENV = process.env.INFINIBOT_AUTH_FILE;

function makeAuth(overrides: Partial<StoredAuth> = {}): StoredAuth {
  const now = Date.now();
  return {
    access_token: "a-token",
    refresh_token: "r-token",
    expires_at: now + 60_000,
    refresh_expires_at: now + 600_000,
    tenant_id: "tenant-123",
    scopes: ["gateway", "mesh"],
    vault_url: "https://vault.example",
    saved_at: now,
    ...overrides,
  };
}

describe("token-store", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ib-auth-"));
    tmpFile = path.join(tmpDir, "auth.json");
    process.env.INFINIBOT_AUTH_FILE = tmpFile;
  });

  afterEach(async () => {
    if (ORIGINAL_ENV === undefined) delete process.env.INFINIBOT_AUTH_FILE;
    else process.env.INFINIBOT_AUTH_FILE = ORIGINAL_ENV;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("uses INFINIBOT_AUTH_FILE override", () => {
    expect(resolveAuthFilePath()).toBe(tmpFile);
  });

  it("returns null when no file exists", async () => {
    expect(await loadAuth()).toBeNull();
  });

  it("round-trips an auth bundle", async () => {
    const auth = makeAuth();
    await saveAuth(auth);
    expect(await loadAuth()).toEqual(auth);
  });

  it("chmods the file to 600 on POSIX", async () => {
    if (process.platform === "win32") return;
    await saveAuth(makeAuth());
    const stat = await fs.stat(tmpFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("clearAuth deletes the file and is safe to call twice", async () => {
    await saveAuth(makeAuth());
    await clearAuth();
    expect(await loadAuth()).toBeNull();
    await expect(clearAuth()).resolves.toBeUndefined();
  });

  it("loadAuth returns null on corrupted JSON", async () => {
    await fs.mkdir(path.dirname(tmpFile), { recursive: true });
    await fs.writeFile(tmpFile, "{ not json", "utf8");
    expect(await loadAuth()).toBeNull();
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./vault-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./vault-client.js")>();
  return {
    ...original,
    refreshToken: vi.fn(),
    validateToken: vi.fn(),
  };
});

import { NotAuthenticatedError } from "./errors.js";
import { __resetValidateCacheForTests, ensureValidToken } from "./guard.js";
import { loadAuth, saveAuth, type StoredAuth } from "./token-store.js";
import { refreshToken, validateToken, VaultError } from "./vault-client.js";

const refreshMock = refreshToken as unknown as ReturnType<typeof vi.fn>;
const validateMock = validateToken as unknown as ReturnType<typeof vi.fn>;

const ORIGINAL_AUTH_FILE = process.env.INFINIBOT_AUTH_FILE;
const ORIGINAL_ENV_TOKEN = process.env.INFINIBOT_TOKEN;

function freshAuth(overrides: Partial<StoredAuth> = {}): StoredAuth {
  const now = Date.now();
  return {
    access_token: "old-access",
    refresh_token: "old-refresh",
    expires_at: now + 5 * 60_000,
    refresh_expires_at: now + 24 * 3600_000,
    tenant_id: "tenant-x",
    scopes: ["gateway"],
    vault_url: "https://vault.test",
    saved_at: now,
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ib-guard-"));
  process.env.INFINIBOT_AUTH_FILE = path.join(tmpDir, "auth.json");
  delete process.env.INFINIBOT_TOKEN;
  refreshMock.mockReset();
  validateMock.mockReset();
  __resetValidateCacheForTests();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_AUTH_FILE === undefined) delete process.env.INFINIBOT_AUTH_FILE;
  else process.env.INFINIBOT_AUTH_FILE = ORIGINAL_AUTH_FILE;
  if (ORIGINAL_ENV_TOKEN === undefined) delete process.env.INFINIBOT_TOKEN;
  else process.env.INFINIBOT_TOKEN = ORIGINAL_ENV_TOKEN;
});

describe("ensureValidToken", () => {
  it("throws NotAuthenticatedError when no bundle exists", async () => {
    await expect(ensureValidToken()).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it("refreshes an expired access token and persists the new bundle", async () => {
    const expired = freshAuth({ expires_at: Date.now() - 1000 });
    await saveAuth(expired);
    refreshMock.mockResolvedValueOnce({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      token_type: "Bearer",
      tenant_id: "tenant-x",
      scopes: ["gateway"],
    });
    validateMock.mockResolvedValueOnce({
      valid: true,
      tenant_id: "tenant-x",
      user_id: "u1",
      scopes: ["gateway"],
      expires_at: Date.now() + 3600_000,
    });

    const out = await ensureValidToken();
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(out.access_token).toBe("new-access");
    const onDisk = await loadAuth();
    expect(onDisk?.access_token).toBe("new-access");
    expect(onDisk?.refresh_token).toBe("new-refresh");
  });

  it("clears the bundle and throws when refresh returns invalid_grant", async () => {
    const expired = freshAuth({ expires_at: Date.now() - 1000 });
    await saveAuth(expired);
    refreshMock.mockRejectedValueOnce(new VaultError("invalid_grant", 400, "bad refresh"));

    await expect(ensureValidToken()).rejects.toBeInstanceOf(NotAuthenticatedError);
    expect(await loadAuth()).toBeNull();
  });

  it("caches /cli-token-validate calls for one hour", async () => {
    const stored = freshAuth();
    await saveAuth(stored);
    validateMock.mockResolvedValue({
      valid: true,
      tenant_id: "tenant-x",
      user_id: "u1",
      scopes: ["gateway"],
      expires_at: Date.now() + 3600_000,
    });

    await ensureValidToken();
    await ensureValidToken();
    await ensureValidToken();
    expect(validateMock).toHaveBeenCalledTimes(1);
  });

  it("clears auth on 401 from validate", async () => {
    const stored = freshAuth();
    await saveAuth(stored);
    validateMock.mockRejectedValueOnce(new VaultError("invalid_token", 401, "revoked"));

    await expect(ensureValidToken()).rejects.toBeInstanceOf(NotAuthenticatedError);
    expect(await loadAuth()).toBeNull();
  });

  it("uses INFINIBOT_TOKEN env var path when set", async () => {
    process.env.INFINIBOT_TOKEN = "env-token";
    validateMock.mockResolvedValueOnce({
      valid: true,
      tenant_id: "tenant-env",
      user_id: "u-env",
      scopes: ["mesh"],
      expires_at: Date.now() + 3600_000,
    });
    const out = await ensureValidToken();
    expect(out.tenant_id).toBe("tenant-env");
    expect(out.access_token).toBe("env-token");
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

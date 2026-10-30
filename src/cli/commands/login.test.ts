import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../auth/vault-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../auth/vault-client.js")>();
  return {
    ...original,
    startDevice: vi.fn(),
    pollToken: vi.fn(),
  };
});

import { runLogin } from "./login.js";
import { loadAuth } from "../../auth/token-store.js";
import { pollToken, startDevice } from "../../auth/vault-client.js";

const startMock = startDevice as unknown as ReturnType<typeof vi.fn>;
const pollMock = pollToken as unknown as ReturnType<typeof vi.fn>;

const ORIGINAL_AUTH_FILE = process.env.INFINIBOT_AUTH_FILE;
let tmpDir: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ib-login-"));
  process.env.INFINIBOT_AUTH_FILE = path.join(tmpDir, "auth.json");
  startMock.mockReset();
  pollMock.mockReset();
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  if (ORIGINAL_AUTH_FILE === undefined) delete process.env.INFINIBOT_AUTH_FILE;
  else process.env.INFINIBOT_AUTH_FILE = ORIGINAL_AUTH_FILE;
  vi.restoreAllMocks();
});

describe("runLogin", () => {
  it("completes the device flow and saves the bundle", async () => {
    startMock.mockResolvedValueOnce({
      device_code: "dc",
      user_code: "UC",
      verification_uri: "https://vault.test/device",
      verification_uri_complete: "https://vault.test/device?code=UC",
      expires_in: 600,
      interval: 0,
    });
    pollMock.mockResolvedValueOnce({
      access_token: "a",
      refresh_token: "r",
      expires_in: 3600,
      token_type: "Bearer",
      tenant_id: "tenant-login",
      scopes: ["gateway"],
    });
    await runLogin({ scope: ["gateway"], label: "test-host" });
    const stored = await loadAuth();
    expect(stored?.tenant_id).toBe("tenant-login");
    expect(stored?.access_token).toBe("a");
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("Signed in as tenant-login"));
    expect(stderrSpy).toHaveBeenCalled();
  });
});

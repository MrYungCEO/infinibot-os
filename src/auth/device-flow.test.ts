import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./vault-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./vault-client.js")>();
  return {
    ...original,
    startDevice: vi.fn(),
    pollToken: vi.fn(),
  };
});

import { pollUntilApproved, startDeviceFlow } from "./device-flow.js";
import { DeviceDeniedError, TokenExpiredError } from "./errors.js";
import { pollToken, startDevice, VaultError } from "./vault-client.js";

const startMock = startDevice as unknown as ReturnType<typeof vi.fn>;
const pollMock = pollToken as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  startMock.mockReset();
  pollMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startDeviceFlow", () => {
  it("returns the device-code envelope and computes an absolute expiry", async () => {
    startMock.mockResolvedValueOnce({
      device_code: "dc",
      user_code: "ABCD-EFGH",
      verification_uri: "https://vault.test/device",
      verification_uri_complete: "https://vault.test/device?code=ABCD-EFGH",
      expires_in: 600,
      interval: 5,
    });
    const start = await startDeviceFlow({ silent: true, openBrowser: () => {} });
    expect(start.userCode).toBe("ABCD-EFGH");
    expect(start.interval).toBe(5);
    expect(start.expiresAt).toBeGreaterThan(Date.now());
  });
});

describe("pollUntilApproved", () => {
  const start = { deviceCode: "dc", interval: 1, expiresAt: Date.now() + 60_000 };

  it("returns tokens once approval lands", async () => {
    pollMock
      .mockRejectedValueOnce(new VaultError("authorization_pending", 400))
      .mockResolvedValueOnce({
        access_token: "a",
        refresh_token: "r",
        expires_in: 3600,
        token_type: "Bearer",
        tenant_id: "t",
        scopes: ["gateway"],
      });
    const out = await pollUntilApproved(start, { sleep: async () => {} });
    expect(out.access_token).toBe("a");
    expect(pollMock).toHaveBeenCalledTimes(2);
  });

  it("throws TokenExpiredError on expired_token", async () => {
    pollMock.mockRejectedValueOnce(new VaultError("expired_token", 400));
    await expect(pollUntilApproved(start, { sleep: async () => {} })).rejects.toBeInstanceOf(
      TokenExpiredError,
    );
  });

  it("throws DeviceDeniedError on access_denied", async () => {
    pollMock.mockRejectedValueOnce(new VaultError("access_denied", 400));
    await expect(pollUntilApproved(start, { sleep: async () => {} })).rejects.toBeInstanceOf(
      DeviceDeniedError,
    );
  });

  it("throws TokenExpiredError when wall clock passes expiresAt", async () => {
    const tooLate = { deviceCode: "dc", interval: 1, expiresAt: Date.now() - 1 };
    await expect(pollUntilApproved(tooLate, { sleep: async () => {} })).rejects.toBeInstanceOf(
      TokenExpiredError,
    );
  });
});

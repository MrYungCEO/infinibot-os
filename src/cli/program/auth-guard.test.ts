import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureValidToken = vi.fn();
vi.mock("../../auth/guard.js", () => ({ ensureValidToken: () => ensureValidToken() }));

import { NotAuthenticatedError } from "../../auth/errors.js";
import { ensureVaultAuth, isVaultGateEnabled } from "./auth-guard.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.INFINIBOT_REQUIRE_VAULT;
  delete process.env.INFINIBOT_DISABLE_AUTH;
  ensureValidToken.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

describe("isVaultGateEnabled", () => {
  it("is off by default (self-hosted needs no Kingly Vault account)", () => {
    expect(isVaultGateEnabled({})).toBe(false);
  });
  it("is on only with INFINIBOT_REQUIRE_VAULT=1", () => {
    expect(isVaultGateEnabled({ INFINIBOT_REQUIRE_VAULT: "1" })).toBe(true);
  });
  it("INFINIBOT_DISABLE_AUTH still wins (back-compat)", () => {
    expect(isVaultGateEnabled({ INFINIBOT_REQUIRE_VAULT: "1", INFINIBOT_DISABLE_AUTH: "1" })).toBe(
      false,
    );
  });
});

describe("ensureVaultAuth", () => {
  it("never checks the Vault token when the gate is off", async () => {
    await ensureVaultAuth(["gateway"]);
    await ensureVaultAuth(["onboard"]);
    expect(ensureValidToken).not.toHaveBeenCalled();
  });

  it("exits when opted in and not signed in", async () => {
    process.env.INFINIBOT_REQUIRE_VAULT = "1";
    ensureValidToken.mockRejectedValue(new NotAuthenticatedError("nope"));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await ensureVaultAuth(["gateway"]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("skips allowlisted commands even when opted in", async () => {
    process.env.INFINIBOT_REQUIRE_VAULT = "1";
    await ensureVaultAuth(["login"]);
    expect(ensureValidToken).not.toHaveBeenCalled();
  });
});

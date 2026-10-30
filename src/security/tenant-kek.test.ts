import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  rewrapTenantDataKey,
  tenantKekConfigured,
  unwrapTenantDataKey,
  wrapTenantDataKey,
} from "./tenant-kek.js";

const kek = () => randomBytes(32).toString("base64");

describe("tenant KEK envelope", () => {
  it("round-trips a data key and never stores it in the clear", () => {
    const env = { BYOK_KEK: kek(), BYOK_KEK_ID: "k7" };
    const dek = randomBytes(32);
    const wrapped = wrapTenantDataKey(dek, "t_1", "solatrix-wallets", env);
    expect(wrapped.kekId).toBe("k7");
    expect(JSON.stringify(wrapped)).not.toContain(dek.toString("base64"));
    expect(JSON.stringify(wrapped)).not.toContain(dek.toString("hex"));
    expect(unwrapTenantDataKey(wrapped, "t_1", "solatrix-wallets", env).equals(dek)).toBe(true);
  });

  it("is bound to tenant and purpose", () => {
    const env = { BYOK_KEK: kek() };
    const wrapped = wrapTenantDataKey(randomBytes(32), "t_1", "solatrix-wallets", env);
    expect(() => unwrapTenantDataKey(wrapped, "t_2", "solatrix-wallets", env)).toThrow();
    expect(() => unwrapTenantDataKey(wrapped, "t_1", "other", env)).toThrow();
  });

  it("fails closed without a KEK and rejects malformed ones", () => {
    expect(tenantKekConfigured({})).toBe(false);
    expect(tenantKekConfigured({ BYOK_KEK: "short" })).toBe(false);
    expect(() => wrapTenantDataKey(randomBytes(32), "t", "p", {})).toThrow(/BYOK_KEK/);
  });

  it("rotates: old key still unwraps via BYOK_KEK_PREVIOUS, rewrap moves to the new key", () => {
    const oldKek = kek();
    const dek = randomBytes(32);
    const wrapped = wrapTenantDataKey(dek, "t", "p", { BYOK_KEK: oldKek, BYOK_KEK_ID: "k1" });
    const rotated = { BYOK_KEK: kek(), BYOK_KEK_ID: "k2", BYOK_KEK_PREVIOUS: `k1:${oldKek}` };
    expect(unwrapTenantDataKey(wrapped, "t", "p", rotated).equals(dek)).toBe(true);
    const re = rewrapTenantDataKey(wrapped, "t", "p", rotated);
    expect(re.kekId).toBe("k2");
    expect(
      unwrapTenantDataKey(re, "t", "p", { BYOK_KEK: rotated.BYOK_KEK, BYOK_KEK_ID: "k2" }).equals(
        dek,
      ),
    ).toBe(true);
  });
});

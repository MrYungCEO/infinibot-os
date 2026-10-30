import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { commercialUsesForTier, licenseExpirySeconds } from "./catalog.js";
import { signCommercialLicense, verifyCommercialLicense } from "./token.js";

const keys = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const issued = 1_800_000_000;

function minted() {
  return signCommercialLicense(
    {
      sub: "license-test",
      iat: issued,
      nbf: issued,
      exp: licenseExpirySeconds(issued),
      tier: "business",
      licensee: "Example, Inc.",
      email: "buyer@example.test",
      seats: 20,
      organizations: 3,
      whiteLabel: false,
      commercialUses: ["competing", "hosted"],
      source: "whop",
    },
    keys.privateKey,
  );
}

describe("commercial license Ed25519 tokens", () => {
  it("carries the licensor, revenue cap, term and agreement version in the signed payload", () => {
    const { token } = minted();
    const result = verifyCommercialLicense(token, {
      publicKeyPem: keys.publicKey,
      nowSeconds: issued + 1,
    });
    expect(result.payload).toMatchObject({
      licensor: "Kingly Intelligence Systems LLC",
      licensee: "Example, Inc.",
      tier: "business",
      revenueCapUsd: 10_000_000,
      term: { interval: "year", termDays: 365, autoRenew: true },
      agreementVersion: "1.0 (2026-10-27)",
    });
  });

  it("grants resale and OEM only to the tiers that include them", () => {
    expect(commercialUsesForTier("indie", false)).not.toContain("resale");
    expect(commercialUsesForTier("agency", true)).toEqual(
      expect.arrayContaining(["resale", "white-label"]),
    );
    expect(commercialUsesForTier("agency", true)).not.toContain("oem");
    expect(commercialUsesForTier("enterprise", true)).toContain("oem");
  });

  it("signs and verifies offline", () => {
    const { token, payload } = minted();
    const result = verifyCommercialLicense(token, {
      publicKeyPem: keys.publicKey,
      nowSeconds: issued + 1,
    });
    expect(result).toMatchObject({ valid: true, state: "active" });
    expect(result.payload).toMatchObject({ jti: payload.jti, tier: "business", seats: 20 });
  });

  it("rejects a tampered payload and a different key", () => {
    const { token } = minted();
    const parts = token.split(".");
    parts[1] = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(parts[1]!, "base64url").toString()), seats: 999 }),
    ).toString("base64url");
    expect(
      verifyCommercialLicense(parts.join("."), {
        publicKeyPem: keys.publicKey,
        nowSeconds: issued + 1,
      }).reason,
    ).toBe("bad_signature");
    const other = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    expect(
      verifyCommercialLicense(token, { publicKeyPem: other.publicKey, nowSeconds: issued + 1 })
        .valid,
    ).toBe(false);
  });

  it("honors the post-expiry grace window and then expires", () => {
    const { token, payload } = minted();
    expect(
      verifyCommercialLicense(token, { publicKeyPem: keys.publicKey, nowSeconds: payload.exp + 1 }),
    ).toMatchObject({ valid: true, state: "grace" });
    expect(
      verifyCommercialLicense(token, {
        publicKeyPem: keys.publicKey,
        nowSeconds: payload.exp + 15 * 86_400,
      }),
    ).toMatchObject({ valid: false, state: "expired" });
  });
});

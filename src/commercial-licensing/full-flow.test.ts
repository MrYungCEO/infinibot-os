import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { activateCommercialLicense } from "./local.js";
import { licenseExpirySeconds } from "./catalog.js";
import { signCommercialLicense } from "./token.js";
const old = process.env.INFINIBOT_STATE_DIR;
let dir = "";
afterEach(() => {
  if (old === undefined) delete process.env.INFINIBOT_STATE_DIR;
  else process.env.INFINIBOT_STATE_DIR = old;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});
describe("mock purchase to CLI activation", () => {
  it("issues, persists and offline-verifies the signed key", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-commercial-e2e-"));
    process.env.INFINIBOT_STATE_DIR = dir;
    const keys = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const iat = Math.floor(Date.now() / 1000);
    const { token } = signCommercialLicense(
      {
        sub: "purchase-1",
        iat,
        nbf: iat,
        exp: licenseExpirySeconds(iat),
        tier: "agency",
        licensee: "Example Agency",
        email: "buyer@example.test",
        seats: 50,
        organizations: 25,
        whiteLabel: true,
        commercialUses: ["hosted", "resale", "white-label"],
        source: "whop",
      },
      keys.privateKey,
    );
    const result = activateCommercialLicense(token, { publicKeyPem: keys.publicKey });
    expect(result).toMatchObject({
      valid: true,
      state: "active",
      payload: { tier: "agency", whiteLabel: true },
    });
    expect(fs.readFileSync(path.join(dir, "commercial-license.jwt"), "utf8").trim()).toBe(token);
    expect(fs.statSync(path.join(dir, "commercial-license.jwt")).mode & 0o777).toBe(0o600);
  });
});

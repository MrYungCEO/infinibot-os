import { describe, it, expect } from "vitest";

import {
  encodeInvite,
  decodeInvite,
  inviteFingerprint,
  InvalidInviteError,
  ExpiredInviteError,
  INVITE_PREFIX,
  type FederationInvite,
} from "./invite.js";
import type { SatelliteToken } from "./security.js";

function buildToken(over: Partial<SatelliteToken> = {}): SatelliteToken {
  return {
    satelliteId: "node_abc123",
    issuedAt: 1_700_000_000_000,
    expiresAt: 1_800_000_000_000,
    signature: "deadbeef".repeat(8),
    permissions: {
      level: "full",
      allowedOperations: ["session.spawn"],
    },
    ...over,
  } as SatelliteToken;
}

function buildInvite(over: Partial<FederationInvite> = {}): FederationInvite {
  return {
    v: 1,
    masterUrl: "wss://master.example/federation",
    iss: "master.example",
    label: "demo-windows",
    expiresAt: Date.now() + 60 * 60 * 1000,
    satelliteToken: buildToken(),
    ...over,
  };
}

describe("encodeInvite / decodeInvite", () => {
  it("round-trips an invite via the prefixed form", () => {
    const invite = buildInvite();
    const encoded = encodeInvite(invite);
    expect(encoded.startsWith(INVITE_PREFIX)).toBe(true);
    const decoded = decodeInvite(encoded);
    expect(decoded).toEqual(invite);
  });

  it("round-trips the operator-chosen satelliteName", () => {
    const invite = buildInvite({ satelliteName: "CEO laptop 5050" });
    const decoded = decodeInvite(encodeInvite(invite));
    expect(decoded.satelliteName).toBe("CEO laptop 5050");
  });

  it("trims and length-caps satelliteName on decode", () => {
    const invite = buildInvite({ satelliteName: `  ${"x".repeat(80)}  ` });
    const decoded = decodeInvite(encodeInvite(invite));
    expect(decoded.satelliteName).toHaveLength(48);
    expect(decoded.satelliteName?.startsWith(" ")).toBe(false);
  });

  it("omits satelliteName when not provided (back-compat)", () => {
    const invite = buildInvite();
    const decoded = decodeInvite(encodeInvite(invite));
    expect(decoded.satelliteName).toBeUndefined();
  });

  it("accepts raw base64url (prefix is optional on input)", () => {
    const invite = buildInvite();
    const encoded = encodeInvite(invite);
    const raw = encoded.slice(INVITE_PREFIX.length);
    expect(decodeInvite(raw)).toEqual(invite);
  });

  it("rejects expired invites", () => {
    const invite = buildInvite({ expiresAt: Date.now() - 1000 });
    const encoded = encodeInvite(invite);
    expect(() => decodeInvite(encoded)).toThrowError(ExpiredInviteError);
  });

  it("rejects malformed base64", () => {
    expect(() => decodeInvite(INVITE_PREFIX + "@@@not-base64@@@")).toThrowError(InvalidInviteError);
  });

  it("rejects empty input", () => {
    expect(() => decodeInvite("")).toThrowError(InvalidInviteError);
    expect(() => decodeInvite("   ")).toThrowError(InvalidInviteError);
  });

  it("rejects missing required fields (no masterUrl)", () => {
    const bad = Buffer.from(JSON.stringify({ v: 1, iss: "x", expiresAt: Date.now() + 1000 }))
      .toString("base64")
      .replace(/=+$/g, "");
    expect(() => decodeInvite(INVITE_PREFIX + bad)).toThrowError(InvalidInviteError);
  });

  it("rejects unsupported version", () => {
    const bad = Buffer.from(JSON.stringify({ v: 2, masterUrl: "x", iss: "x", expiresAt: 1 }))
      .toString("base64")
      .replace(/=+$/g, "");
    expect(() => decodeInvite(INVITE_PREFIX + bad)).toThrowError(InvalidInviteError);
  });
});

describe("inviteFingerprint", () => {
  it("is stable for the same signature", () => {
    const inv = buildInvite();
    expect(inviteFingerprint(inv)).toBe(inviteFingerprint(inv));
    expect(inviteFingerprint(inv)).toHaveLength(8);
  });

  it("changes when signature changes", () => {
    const a = buildInvite({ satelliteToken: buildToken({ signature: "a".repeat(64) }) });
    const b = buildInvite({ satelliteToken: buildToken({ signature: "b".repeat(64) }) });
    expect(inviteFingerprint(a)).not.toBe(inviteFingerprint(b));
  });
});

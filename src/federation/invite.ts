/**
 * Federation Invite encoding helpers.
 *
 * A `FederationInvite` is a self-contained envelope that bundles everything a
 * fresh satellite needs to attach to a master federation hub: the master URL,
 * a signed `SatelliteToken` (which carries permissions + its own expiry), and
 * a human-readable label/issuer for confirmation prompts.
 *
 * The encoded form is a base64url-of-JSON string, prefixed with
 * `infinibot-invite-v1:` so it's obvious-to-the-eye what the blob is and easy
 * to grep out of logs. Decoding accepts the prefixed form or a raw base64url
 * string (so the prefix is optional on input — convenient when copy/pasting
 * across tools that mangle colons).
 *
 * No I/O. No process state. Pure functions only — easy to test.
 */

import { createHash } from "node:crypto";

import type { SatelliteToken } from "./security.js";

export type FederationInvite = {
  /** Schema version. Bump on incompatible changes. */
  v: 1;
  /** Master URL as the operator typed it (post-formatMasterUrl normalization). */
  masterUrl: string;
  /** Signed satellite token (carries its own permissions + expiry). */
  satelliteToken: SatelliteToken;
  /** Suggested satellite id for the joiner. Optional. */
  satelliteIdHint?: string;
  /**
   * Operator-chosen display name the joining satellite should adopt as its own
   * `federation.nodeName` when it pairs. Distinct from `label` (which carries
   * the master/hub name for the confirmation prompt). When set, this is what
   * fixes the "satellite inherits the master's device name" confusion: the
   * satellite registers under THIS name instead of the master's. Optional —
   * older invites omit it, and those satellites keep their existing name.
   */
  satelliteName?: string;
  /** Free-form label, surfaced in the master UI and on the satellite during pairing. */
  label?: string;
  /** Invite expiry (ms epoch). Distinct from `satelliteToken.expiresAt`. */
  expiresAt: number;
  /** Master hostname, for human display only. */
  iss: string;
};

export const INVITE_PREFIX = "infinibot-invite-v1:";

export class InvalidInviteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInviteError";
  }
}

export class ExpiredInviteError extends Error {
  constructor(message = "Invite has expired") {
    super(message);
    this.name = "ExpiredInviteError";
  }
}

function toBase64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64Url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function encodeInvite(invite: FederationInvite): string {
  if (invite.v !== 1) {
    throw new InvalidInviteError(`unsupported invite version: ${String(invite.v)}`);
  }
  const json = JSON.stringify(invite);
  return INVITE_PREFIX + toBase64Url(Buffer.from(json, "utf8"));
}

export function decodeInvite(input: string, now: number = Date.now()): FederationInvite {
  if (typeof input !== "string" || input.trim() === "") {
    throw new InvalidInviteError("invite is empty");
  }
  const trimmed = input.trim();
  const payload = trimmed.startsWith(INVITE_PREFIX) ? trimmed.slice(INVITE_PREFIX.length) : trimmed;

  let buf: Buffer;
  try {
    buf = fromBase64Url(payload);
  } catch {
    throw new InvalidInviteError("invite is not valid base64url");
  }
  if (buf.length === 0) {
    throw new InvalidInviteError("invite payload is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new InvalidInviteError("invite payload is not valid JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new InvalidInviteError("invite payload is not an object");
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.v !== 1) {
    throw new InvalidInviteError(`unsupported invite version: ${String(obj.v)}`);
  }
  if (typeof obj.masterUrl !== "string" || obj.masterUrl.trim() === "") {
    throw new InvalidInviteError("invite missing masterUrl");
  }
  if (typeof obj.iss !== "string") {
    throw new InvalidInviteError("invite missing iss");
  }
  if (typeof obj.expiresAt !== "number" || !Number.isFinite(obj.expiresAt)) {
    throw new InvalidInviteError("invite missing expiresAt");
  }
  const tok = obj.satelliteToken as Partial<SatelliteToken> | undefined;
  if (
    !tok ||
    typeof tok !== "object" ||
    typeof tok.satelliteId !== "string" ||
    typeof tok.signature !== "string" ||
    typeof tok.issuedAt !== "number" ||
    !tok.permissions ||
    typeof tok.permissions !== "object"
  ) {
    throw new InvalidInviteError("invite missing satelliteToken");
  }

  const invite: FederationInvite = {
    v: 1,
    masterUrl: obj.masterUrl,
    iss: obj.iss,
    expiresAt: obj.expiresAt,
    label: typeof obj.label === "string" ? obj.label : undefined,
    satelliteName:
      typeof obj.satelliteName === "string" && obj.satelliteName.trim()
        ? obj.satelliteName.trim().slice(0, 48)
        : undefined,
    satelliteIdHint: typeof obj.satelliteIdHint === "string" ? obj.satelliteIdHint : undefined,
    satelliteToken: tok as SatelliteToken,
  };

  if (invite.expiresAt < now) {
    throw new ExpiredInviteError(
      `Invite expired ${new Date(invite.expiresAt).toISOString()} (now ${new Date(now).toISOString()})`,
    );
  }
  return invite;
}

/**
 * Short, human-comparable fingerprint of the underlying satellite token
 * signature. Master prints it; satellite operator should see the same string
 * to confirm they're pairing with the intended hub.
 */
export function inviteFingerprint(invite: FederationInvite): string {
  return createHash("sha256").update(invite.satelliteToken.signature).digest("hex").slice(0, 8);
}

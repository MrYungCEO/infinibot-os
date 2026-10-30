/**
 * `infinibot federation invite` — master-side helper to mint a single,
 * paste-able onboarding token for a new satellite.
 *
 * Produces an encoded `FederationInvite` (see src/federation/invite.ts) that
 * bundles the master URL + a signed satellite token. The operator hands the
 * blob to the satellite which runs `infinibot federation join <blob>`.
 *
 * Persists an audit record of every minted invite to
 * `<state-dir>/federation-invites.json` so they can be listed + revoked later.
 */

import { hostname } from "node:os";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";

import { loadConfig } from "../../config/config.js";
import {
  getFederationSecurity,
  DEFAULT_PERMISSIONS,
  type SatellitePermissions,
} from "../../federation/security.js";
import { encodeInvite, inviteFingerprint, type FederationInvite } from "../../federation/invite.js";
import { appendInvite } from "../../federation/invite-store.js";
import { formatMasterUrl } from "./satellite.js";

export interface InviteMintOptions {
  label?: string;
  /** Duration string like `30d`, `12h`, `60m`, or a bare integer (hours). */
  expires?: string;
  satelliteId?: string;
  masterUrl?: string;
  /** Override permissions; default = DEFAULT_PERMISSIONS.full */
  permissions?: SatellitePermissions;
}

export interface InviteMintResult {
  encoded: string;
  invite: FederationInvite;
  fingerprint: string;
  inviteId: string;
}

const DURATION_RE = /^(\d+)(s|m|h|d|w)?$/i;

export function parseDurationToHours(input: string | undefined, fallbackHours: number): number {
  if (!input) return fallbackHours;
  const m = DURATION_RE.exec(input.trim());
  if (!m) throw new Error(`invalid duration: ${input}`);
  const n = Number.parseInt(m[1], 10);
  const unit = (m[2] ?? "h").toLowerCase();
  switch (unit) {
    case "s":
      return Math.max(1, Math.ceil(n / 3600));
    case "m":
      return Math.max(1, Math.ceil(n / 60));
    case "h":
      return n;
    case "d":
      return n * 24;
    case "w":
      return n * 24 * 7;
    default:
      return fallbackHours;
  }
}

function pickLanAddress(): string | null {
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const addr of list) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return null;
}

function resolveMasterUrl(opt?: string): string {
  if (opt && opt.trim()) return formatMasterUrl(opt.trim());
  const cfg = loadConfig();
  const fromCfg = cfg.federation?.publicUrl;
  if (fromCfg && fromCfg.trim()) return formatMasterUrl(fromCfg.trim());
  const lan = pickLanAddress();
  const port = cfg.gateway?.port ?? 18789;
  if (lan) return formatMasterUrl(`ws://${lan}:${port}`);
  return formatMasterUrl(`ws://${hostname()}:${port}`);
}

function autoSatelliteId(): string {
  return `node_${randomBytes(6).toString("hex").slice(0, 9)}`;
}

/**
 * Mint and persist a federation invite. Pure helper — no console output, no
 * process.exit — so it can be unit-tested.
 */
export function mintInvite(opts: InviteMintOptions = {}): InviteMintResult {
  const label = opts.label ?? hostname();
  const ttlHours = parseDurationToHours(opts.expires, 24 * 30);
  const satelliteId = opts.satelliteId ?? autoSatelliteId();
  const masterUrl = resolveMasterUrl(opts.masterUrl);
  const permissions = opts.permissions ?? DEFAULT_PERMISSIONS.full;

  const security = getFederationSecurity();
  const token = security.createSatelliteToken(satelliteId, permissions, ttlHours);

  const now = Date.now();
  const invite: FederationInvite = {
    v: 1,
    masterUrl,
    iss: hostname(),
    label,
    satelliteIdHint: satelliteId,
    satelliteToken: token,
    expiresAt: now + ttlHours * 60 * 60 * 1000,
  };

  const encoded = encodeInvite(invite);
  const fingerprint = inviteFingerprint(invite);
  const record = appendInvite({
    satelliteId,
    fingerprint,
    label,
    createdAt: now,
    expiresAt: invite.expiresAt,
    redeemedAt: null,
    revokedAt: null,
  });

  return { encoded, invite, fingerprint, inviteId: record.inviteId };
}

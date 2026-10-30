/**
 * Tiny JSON-file store for federation invites issued by this master.
 *
 * Each record captures enough metadata to revoke + audit an invite without
 * having to keep the encoded blob around. We deliberately do NOT persist the
 * raw `SatelliteToken` — only its fingerprint (8 chars of sha256 of the
 * signature) plus identifying metadata. The token itself lives inside the
 * already-distributed invite blob; the master's in-process `FederationSecurity`
 * remains the source of truth for active tokens.
 *
 * The store is a single JSON file at `<shared-dir>/federation-invites.json`.
 * Writes use the standard tmp-file + rename atomic pattern.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { resolveSharedDir } from "../config/paths.js";

export interface InviteRecord {
  inviteId: string;
  satelliteId: string;
  fingerprint: string;
  label?: string;
  createdAt: number;
  expiresAt: number;
  redeemedAt: number | null;
  revokedAt: number | null;
}

const FILE_NAME = "federation-invites.json";

function storePath(): string {
  return path.join(resolveSharedDir(), FILE_NAME);
}

export function readInvites(): InviteRecord[] {
  const p = storePath();
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as InviteRecord[];
  } catch {
    return [];
  }
}

function writeInvites(records: InviteRecord[]): void {
  const p = storePath();
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    fs.renameSync(tmp, p);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EPERM" || code === "EEXIST") {
      fs.copyFileSync(tmp, p);
      try {
        fs.chmodSync(p, 0o600);
      } catch {
        /* best effort */
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best effort */
      }
      return;
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw err;
  }
}

export function appendInvite(rec: Omit<InviteRecord, "inviteId">): InviteRecord {
  const inviteId = randomUUID();
  const full: InviteRecord = { inviteId, ...rec };
  const all = readInvites();
  all.push(full);
  writeInvites(all);
  return full;
}

export function markRevoked(matcher: string): InviteRecord | null {
  const all = readInvites();
  let hit: InviteRecord | null = null;
  for (const rec of all) {
    if (rec.inviteId === matcher || rec.fingerprint === matcher) {
      rec.revokedAt = Date.now();
      hit = rec;
      break;
    }
  }
  if (hit) writeInvites(all);
  return hit;
}

export function markRedeemed(fingerprint: string): void {
  const all = readInvites();
  let changed = false;
  for (const rec of all) {
    if (rec.fingerprint === fingerprint && rec.redeemedAt === null) {
      rec.redeemedAt = Date.now();
      changed = true;
      break;
    }
  }
  if (changed) writeInvites(all);
}

export function getStorePath(): string {
  return storePath();
}

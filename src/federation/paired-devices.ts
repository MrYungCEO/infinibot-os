/**
 * Paired satellite devices on a MASTER, plus the satellite-side credential.
 *
 * Joining works in two steps:
 *  1. The satellite registers with the short-lived invite token (15 min).
 *  2. The master checks it, records the device here and mints a durable,
 *     signed per-device credential (no expiry, same satelliteId) that it
 *     returns in `node.register.ack`. The satellite stores that credential in
 *     `<state>/federation/satellite-credential.json` (mode 0600) and presents it
 *     on every reconnect, so sleep, reboots and network changes never need a
 *     new invite.
 *
 * Removing a device (master) or leaving (satellite) revokes the satelliteId,
 * and the revocation survives restarts because it lives in this file.
 *
 * Token signatures, private keys and credentials are never written to logs.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveSharedDir } from "../config/paths.js";
import type { SatelliteToken } from "./security.js";

export interface PairedDeviceRecord {
  satelliteId: string;
  /** Node id the device registered under last time. */
  nodeId?: string;
  name?: string;
  hostname?: string;
  platform?: string;
  pairedAt: number;
  lastSeenAt?: number;
  revokedAt?: number | null;
}

function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows can refuse rename over an open file; fall back to copy.
    fs.copyFileSync(tmp, file);
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort (Windows) */
  }
}

// ── Master side ─────────────────────────────────────────────────────────────

export function pairedDevicesPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSharedDir(env), "federation", "paired-devices.json");
}

export function readPairedDevices(file = pairedDevicesPath()): PairedDeviceRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(parsed) ? (parsed as PairedDeviceRecord[]) : [];
  } catch {
    return [];
  }
}

export function upsertPairedDevice(
  rec: Omit<PairedDeviceRecord, "pairedAt"> & { pairedAt?: number },
  file = pairedDevicesPath(),
): PairedDeviceRecord {
  const all = readPairedDevices(file);
  const idx = all.findIndex((r) => r.satelliteId === rec.satelliteId);
  const merged: PairedDeviceRecord = {
    ...(idx >= 0 ? all[idx] : { pairedAt: rec.pairedAt ?? Date.now() }),
    ...rec,
    pairedAt: idx >= 0 ? all[idx].pairedAt : (rec.pairedAt ?? Date.now()),
  } as PairedDeviceRecord;
  if (idx >= 0) all[idx] = merged;
  else all.push(merged);
  writeJsonAtomic(file, all);
  return merged;
}

/** Mark a device revoked by satelliteId OR node id. Returns the record, if any. */
export function revokePairedDevice(
  idOrNodeId: string,
  file = pairedDevicesPath(),
): PairedDeviceRecord | null {
  const all = readPairedDevices(file);
  const rec = all.find((r) => r.satelliteId === idOrNodeId || r.nodeId === idOrNodeId);
  if (!rec) return null;
  rec.revokedAt = Date.now();
  writeJsonAtomic(file, all);
  return rec;
}

export function revokedSatelliteIds(file = pairedDevicesPath()): string[] {
  return readPairedDevices(file)
    .filter((r) => r.revokedAt)
    .map((r) => r.satelliteId);
}

// ── Satellite side ──────────────────────────────────────────────────────────

export interface SatelliteCredential {
  token: SatelliteToken;
  masterUrl?: string;
  /** Fingerprint of the master's public key at pairing time. */
  hubFingerprint?: string;
  savedAt: number;
}

export function satelliteCredentialPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveSharedDir(env), "federation", "satellite-credential.json");
}

export function readSatelliteCredential(
  file = satelliteCredentialPath(),
): SatelliteCredential | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as SatelliteCredential;
    if (
      parsed?.token &&
      typeof parsed.token.satelliteId === "string" &&
      typeof parsed.token.signature === "string"
    ) {
      return parsed;
    }
  } catch {
    /* none yet */
  }
  return null;
}

export function writeSatelliteCredential(
  cred: Omit<SatelliteCredential, "savedAt">,
  file = satelliteCredentialPath(),
): void {
  writeJsonAtomic(file, { ...cred, savedAt: Date.now() });
}

export function clearSatelliteCredential(file = satelliteCredentialPath()): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}

/**
 * The token a satellite should present: the durable credential when it has
 * one for this satellite id, otherwise the invite token from config.
 */
export function resolveSatelliteAuthToken(
  configToken: unknown,
  credential: SatelliteCredential | null = readSatelliteCredential(),
): SatelliteToken | undefined {
  const invite = isSatelliteToken(configToken) ? configToken : undefined;
  if (credential?.token) {
    // A credential from a previous pairing is only reused while the invite in
    // config (if any) is for the same satelliteId — a NEW invite means the
    // operator is re-joining, so the invite wins.
    if (!invite || invite.satelliteId === credential.token.satelliteId) return credential.token;
  }
  return invite;
}

export function isSatelliteToken(v: unknown): v is SatelliteToken {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as SatelliteToken).satelliteId === "string" &&
    typeof (v as SatelliteToken).signature === "string" &&
    !!(v as SatelliteToken).permissions
  );
}

/** Short non-secret fingerprint for logs and UI ("ab12cd34"). */
export function tokenFingerprint(token: SatelliteToken | undefined | null): string {
  if (!token?.signature) return "none";
  return createHash("sha256").update(token.signature).digest("hex").slice(0, 8);
}

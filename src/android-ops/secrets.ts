/**
 * Android Ops secret storage.
 *
 * The provisioning pipeline has a step called "Generate unique password into the
 * vault". It used to be marked done while nothing was generated and nothing was
 * stored — a green tick asserting a credential was safe. This module is what
 * makes that step true.
 *
 * The rules it exists to keep:
 *   - A password is generated here and written straight to encrypted storage.
 *   - Only an opaque `vault://android-ops/<platform>/<handle>` reference ever
 *     reaches the database, an RPC payload or the dashboard.
 *   - Nothing in this file logs, returns or throws a plaintext secret. Read-back
 *     exists for an operator tool, not for the API surface.
 *
 * Encryption reuses the same AES-256-GCM helper and key as the email
 * credentials, so there is one key to protect rather than two.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { encryptSecret, decryptSecret } from "../services/email/secret-crypto.js";

/** Ambiguous glyphs are dropped: these get read off a screen and retyped. */
const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%^&*-_=+";

export interface StoredSecretMeta {
  ref: string;
  createdAt: number;
  rotatedAt: number | null;
  length: number;
}

function secretsPath(stateDir: string): string {
  return join(stateDir, "android-ops-secrets.json");
}

function readAll(stateDir: string): Record<string, { blob: string; meta: StoredSecretMeta }> {
  try {
    const raw = readFileSync(secretsPath(stateDir), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(
  stateDir: string,
  value: Record<string, { blob: string; meta: StoredSecretMeta }>,
): void {
  const path = secretsPath(stateDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  try {
    // an existing file keeps its old mode through writeFileSync
    chmodSync(path, 0o600);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
}

/** The reference shape the rest of the system stores and passes around. */
export function vaultRef(platform: string, handle: string): string {
  const safe = (s: string) =>
    String(s)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-");
  return `vault://android-ops/${safe(platform)}/${safe(handle)}`;
}

/** Crypto-random password. Never logged, never returned to a caller that stores it. */
export function generatePassword(length = 24): string {
  const size = Math.max(16, Math.min(64, length));
  const bytes = randomBytes(size * 2);
  let out = "";
  for (let i = 0; out.length < size && i < bytes.length; i += 1) {
    // reject above the largest whole multiple, so the alphabet stays uniform
    const limit = 256 - (256 % ALPHABET.length);
    if (bytes[i] >= limit) continue;
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out.length === size
    ? out
    : out + generatePassword(size - out.length).slice(0, size - out.length);
}

/** Encrypt and store. Returns the reference only — never the value. */
export function putSecret(stateDir: string, ref: string, value: string): StoredSecretMeta {
  const blob = encryptSecret(value);
  if (!blob) throw new Error("Refusing to store an unencryptable secret.");
  const all = readAll(stateDir);
  const existing = all[ref]?.meta;
  const meta: StoredSecretMeta = {
    ref,
    createdAt: existing?.createdAt ?? Date.now(),
    rotatedAt: existing ? Date.now() : null,
    length: value.length,
  };
  all[ref] = { blob, meta };
  writeAll(stateDir, all);
  return meta;
}

/** Whether a reference resolves to stored material — the safe question to ask. */
export function hasSecret(stateDir: string, ref: string): boolean {
  if (!ref) return false;
  return Boolean(readAll(stateDir)[ref]);
}

export function secretMeta(stateDir: string, ref: string): StoredSecretMeta | null {
  return readAll(stateDir)[ref]?.meta ?? null;
}

/**
 * Decrypt a stored secret. Deliberately NOT reachable from any HTTP route or
 * RPC in this system — it exists for an operator-run tool that needs to type a
 * password into a handset.
 */
export function revealSecret(stateDir: string, ref: string): string | null {
  const entry = readAll(stateDir)[ref];
  if (!entry) return null;
  return decryptSecret(entry.blob);
}

/** Move stored material to a new reference, so renaming cannot orphan it. */
export function moveSecret(stateDir: string, fromRef: string, toRef: string): boolean {
  if (fromRef === toRef) return true;
  const all = readAll(stateDir);
  const entry = all[fromRef];
  if (!entry) return false;
  all[toRef] = { blob: entry.blob, meta: { ...entry.meta, ref: toRef, rotatedAt: Date.now() } };
  delete all[fromRef];
  writeAll(stateDir, all);
  return true;
}

/** True when the file exists at all — used to report vault availability. */
export function secretsStoreReady(stateDir: string): boolean {
  return existsSync(secretsPath(stateDir));
}

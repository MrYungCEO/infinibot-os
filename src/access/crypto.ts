/**
 * Password hashing, opaque tokens and RFC 6238 TOTP for multi-user access.
 *
 * Passwords use Node's scrypt (memory-hard; no native addon to build) with a
 * per-hash salt and the cost parameters encoded in the hash so they can be
 * raised later without invalidating old hashes. argon2/bcrypt are not in the
 * dependency tree and the gateway avoids new native modules.
 */

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
// N=32768,r=8 needs ~32 MiB; Node's default maxmem (32 MiB) is just short.
const MAXMEM = 128 * 1024 * 1024;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const dk = scryptSync(plain, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${dk.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every((n) => Number.isFinite(n) && n > 0)) return false;
  const expected = Buffer.from(parts[5], "hex");
  const dk = scryptSync(plain, parts[4], expected.length, { N, r, p, maxmem: MAXMEM });
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}

/** Minimum password policy; returns an error message or null. */
export function passwordProblem(plain: unknown): string | null {
  if (typeof plain !== "string" || plain.length < 8)
    return "Password must be at least 8 characters.";
  if (plain.length > 256) return "Password is too long.";
  return null;
}

/** Session tokens are prefixed so the connect path can recognise them cheaply. */
export const SESSION_TOKEN_PREFIX = "ibus_";
export const INVITE_TOKEN_PREFIX = "ibinv_";

export function newToken(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ─────────────────────────────

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, atMs = Date.now(), stepSec = 30): string {
  const counter = Math.floor(atMs / 1000 / stepSec);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

/** Accepts the current code and one step either side (clock drift). */
export function verifyTotp(secret: string, code: unknown, atMs = Date.now()): boolean {
  if (typeof code !== "string") return false;
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  for (const d of [-1, 0, 1]) {
    const expected = totpCode(secret, atMs + d * 30_000);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return true;
  }
  return false;
}

export function totpUri(secret: string, account: string, issuer = "InfiniBot"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

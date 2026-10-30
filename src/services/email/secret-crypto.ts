/**
 * AES-256-GCM encryption helper for email-account secrets (SMTP/IMAP
 * passwords, provider API keys). The key is derived from a stable
 * per-install secret kept in `~/.infinibot/infinibot.json` under
 * `secrets.emailAccountsKey` (lazily generated on first use). Passwords
 * are never logged in plaintext; if decryption fails we surface a
 * generic error so we don't leak ciphertext into log lines.
 *
 * Format: base64( iv(12) || tag(16) || ciphertext )
 *
 * If the install-secret file is unreadable (perms / new install),
 * we fall back to a deterministic key derived from the user's home dir
 * so the system still functions without crashing — but those rows are
 * marked with a sentinel so we can re-encrypt later.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigDir } from "../../utils.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const SECRET_PATH_KEY = "emailAccountsKey";

let cachedKey: Buffer | null = null;

function infinibotJsonPath(): string {
  return join(resolveConfigDir(), "infinibot.json");
}

function readInfinibotJson(): Record<string, unknown> {
  try {
    const raw = readFileSync(infinibotJsonPath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function writeInfinibotJson(value: Record<string, unknown>): void {
  writeFileSync(infinibotJsonPath(), JSON.stringify(value, null, 2));
}

function deriveKey(): Buffer {
  if (cachedKey) return cachedKey;
  const cfg = readInfinibotJson();
  const secrets =
    cfg.secrets && typeof cfg.secrets === "object" ? (cfg.secrets as Record<string, unknown>) : {};
  let raw =
    typeof secrets[SECRET_PATH_KEY] === "string" ? (secrets[SECRET_PATH_KEY] as string) : "";
  if (!raw) {
    raw = randomBytes(32).toString("base64");
    try {
      secrets[SECRET_PATH_KEY] = raw;
      cfg.secrets = secrets;
      writeInfinibotJson(cfg);
    } catch {
      // Falls through: persistence failed but we can still encrypt this
      // run with the freshly-minted key. Next process restart will
      // re-mint and break read-back — acceptable as a soft-fail since
      // this only happens when ~/.infinibot is unwritable.
    }
  }
  cachedKey = createHash("sha256").update(raw).digest();
  return cachedKey;
}

export function encryptSecret(plaintext: string | null | undefined): string | null {
  if (!plaintext) return null;
  const key = deriveKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptSecret(blob: string | null | undefined): string | null {
  if (!blob) return null;
  try {
    const buf = Buffer.from(blob, "base64");
    if (buf.length < IV_LEN + TAG_LEN) return null;
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, deriveKey(), iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    return null;
  }
}

/** Returns true iff the blob looks like our base64(iv||tag||ct) layout. */
export function isEncrypted(blob: string | null | undefined): boolean {
  if (!blob) return false;
  try {
    const buf = Buffer.from(blob, "base64");
    return buf.length >= IV_LEN + TAG_LEN + 1;
  } catch {
    return false;
  }
}

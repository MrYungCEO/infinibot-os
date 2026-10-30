/**
 * Envelope encryption for Secure Mode stores (AES-256-GCM, node:crypto only).
 *
 * Every write encrypts the whole document under a fresh random 32-byte data
 * key (DEK); the DEK is wrapped with the master key from the OS keyring. Both
 * layers use AES-256-GCM with a random 96-bit IV and an AAD that binds the
 * ciphertext to its store name, so a file renamed or copied over another store
 * fails authentication instead of decrypting into the wrong place.
 *
 * Plaintext only ever exists in memory: we encrypt before touching disk and
 * write with tmp + rename at mode 0600.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const VAULT_MAGIC = "ibsec1";

interface Sealed {
  iv: string;
  tag: string;
  data: string;
}

export interface VaultFile {
  magic: typeof VAULT_MAGIC;
  alg: "aes-256-gcm";
  store: string;
  /** First 8 bytes of sha256(master key): detects a wrong key up front. */
  kid: string;
  dek: Sealed;
  body: Sealed;
}

export class SecureVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecureVaultError";
  }
}

function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function open(key: Buffer, sealed: Sealed, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]);
}

export function keyId(master: Buffer): string {
  return createHash("sha256").update(master).digest("hex").slice(0, 16);
}

const STORE_NAME = /^[a-z0-9][a-z0-9._-]{0,120}$/i;

export function encryptDocument(master: Buffer, store: string, plaintext: Buffer): VaultFile {
  if (master.length !== 32) throw new SecureVaultError("master key must be 32 bytes");
  const dek = randomBytes(32);
  try {
    return {
      magic: VAULT_MAGIC,
      alg: "aes-256-gcm",
      store,
      kid: keyId(master),
      dek: seal(master, dek, `${VAULT_MAGIC}|dek|${store}`),
      body: seal(dek, plaintext, `${VAULT_MAGIC}|body|${store}`),
    };
  } finally {
    dek.fill(0);
  }
}

export function decryptDocument(master: Buffer, store: string, file: VaultFile): Buffer {
  if (file?.magic !== VAULT_MAGIC || file.alg !== "aes-256-gcm") {
    throw new SecureVaultError(`secure store "${store}" is not an ibsec1 file`);
  }
  if (file.store !== store) {
    throw new SecureVaultError(`secure store "${store}" holds data for "${file.store}"`);
  }
  if (file.kid !== keyId(master)) {
    throw new SecureVaultError(
      `secure store "${store}" was sealed with a different master key (kid ${file.kid}); the keyring key does not match`,
    );
  }
  let dek: Buffer | null = null;
  try {
    dek = open(master, file.dek, `${VAULT_MAGIC}|dek|${store}`);
    return open(dek, file.body, `${VAULT_MAGIC}|body|${store}`);
  } catch (err) {
    if (err instanceof SecureVaultError) throw err;
    throw new SecureVaultError(`secure store "${store}" failed authentication (tampered or wrong key)`);
  } finally {
    dek?.fill(0);
  }
}

/** A directory of encrypted JSON documents, one file per store name. */
export class SecureVault {
  constructor(
    private readonly master: Buffer,
    readonly dir: string,
  ) {
    if (master.length !== 32) throw new SecureVaultError("master key must be 32 bytes");
  }

  filePath(store: string): string {
    if (!STORE_NAME.test(store)) throw new SecureVaultError(`bad secure store name "${store}"`);
    return path.join(this.dir, `${store}.ibsec`);
  }

  has(store: string): boolean {
    return fs.existsSync(this.filePath(store));
  }

  readBuffer(store: string): Buffer | null {
    const file = this.filePath(store);
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as VaultFile;
    return decryptDocument(this.master, store, parsed);
  }

  writeBuffer(store: string, plaintext: Buffer): void {
    const file = this.filePath(store);
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const sealed = JSON.stringify(encryptDocument(this.master, store, plaintext));
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, sealed, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  readJson<T>(store: string, fallback: T): T {
    const buf = this.readBuffer(store);
    if (!buf) return fallback;
    try {
      return JSON.parse(buf.toString("utf8")) as T;
    } finally {
      buf.fill(0);
    }
  }

  writeJson(store: string, value: unknown): void {
    const buf = Buffer.from(JSON.stringify(value), "utf8");
    try {
      this.writeBuffer(store, buf);
    } finally {
      buf.fill(0);
    }
  }

  remove(store: string): void {
    fs.rmSync(this.filePath(store), { force: true });
  }

  list(prefix = ""): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith(".ibsec") && f.startsWith(prefix))
      .map((f) => f.slice(0, -".ibsec".length));
  }
}

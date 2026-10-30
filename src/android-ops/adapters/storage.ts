/**
 * Media storage adapters — MinIO / S3 / R2 with a local-dev default.
 *
 * §1 lists a central content library as its own layer. The rest of the system
 * only ever holds an object *key*, so swapping local dev for a bucket is a
 * configuration change rather than a schema migration.
 *
 * The S3-family adapter is intentionally credential-driven: with no endpoint or
 * keys configured it probes as unavailable and the service falls back to local
 * storage, rather than silently writing nowhere.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { StorageBackend } from "../types.js";
import type {
  AdapterAvailability,
  StorageAdapter,
  StoragePutResult,
  StorageStat,
} from "./types.js";

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Guards against a key escaping the media root via `..`. */
function safeJoin(root: string, key: string): string | null {
  const full = resolve(root, key);
  return full.startsWith(resolve(root)) ? full : null;
}

/** Filesystem-backed library under `<stateDir>/android-ops/media`. */
export class LocalStorageAdapter implements StorageAdapter {
  readonly backend: StorageBackend = "local";
  private root: string;
  /** Gateway route that serves these objects back to the dashboard. */
  private urlPrefix: string;

  constructor(root: string, urlPrefix = "/api/android-ops/media") {
    this.root = root;
    this.urlPrefix = urlPrefix;
    mkdirSync(root, { recursive: true });
  }

  async probe(): Promise<AdapterAvailability> {
    return {
      available: true,
      version: "local-fs",
      binPath: this.root,
      reason: null,
      checkedAt: Date.now(),
    };
  }

  localPath(key: string): string | null {
    return safeJoin(this.root, key);
  }

  async put(key: string, bytes: Buffer | string): Promise<StoragePutResult> {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const full = safeJoin(this.root, key);
    if (!full)
      return { ok: false, key, sizeBytes: 0, checksum: null, reason: "invalid object key" };
    try {
      mkdirSync(dirname(full), { recursive: true });
      await writeFile(full, buf);
      return { ok: true, key, sizeBytes: buf.byteLength, checksum: sha256(buf), reason: null };
    } catch (e) {
      return { ok: false, key, sizeBytes: 0, checksum: null, reason: String(e) };
    }
  }

  async resolveUrl(key: string): Promise<string | null> {
    const full = safeJoin(this.root, key);
    if (!full) return null;
    return `${this.urlPrefix}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  async stat(key: string): Promise<StorageStat> {
    const full = safeJoin(this.root, key);
    if (!full) return { exists: false, key, sizeBytes: null, updatedAt: null };
    try {
      const s = await stat(full);
      return { exists: true, key, sizeBytes: s.size, updatedAt: s.mtimeMs };
    } catch {
      return { exists: false, key, sizeBytes: null, updatedAt: null };
    }
  }

  async remove(key: string): Promise<{ ok: boolean; reason: string | null }> {
    const full = safeJoin(this.root, key);
    if (!full) return { ok: false, reason: "invalid object key" };
    try {
      await unlink(full);
      return { ok: true, reason: null };
    } catch (e) {
      return { ok: false, reason: String(e) };
    }
  }

  async read(key: string): Promise<Buffer | null> {
    const full = safeJoin(this.root, key);
    if (!full) return null;
    try {
      return await readFile(full);
    } catch {
      return null;
    }
  }

  get rootDir(): string {
    return this.root;
  }
}

export interface S3StorageConfig {
  backend: Extract<StorageBackend, "minio" | "s3" | "r2">;
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Public base used to build renderable URLs. */
  publicBaseUrl?: string;
}

/**
 * S3-compatible adapter (MinIO, AWS S3, Cloudflare R2). Reads its config from
 * env so a deployment can point at a bucket without a code change:
 *
 *   ANDROID_OPS_STORAGE=minio|s3|r2
 *   ANDROID_OPS_S3_ENDPOINT / _BUCKET / _REGION / _PUBLIC_BASE
 *   ANDROID_OPS_S3_ACCESS_KEY_ID / _SECRET_ACCESS_KEY
 */
export class S3StorageAdapter implements StorageAdapter {
  readonly backend: StorageBackend;
  private cfg: S3StorageConfig;

  constructor(cfg: S3StorageConfig) {
    this.cfg = cfg;
    this.backend = cfg.backend;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): S3StorageAdapter | null {
    const backend = env.ANDROID_OPS_STORAGE?.trim().toLowerCase();
    if (backend !== "minio" && backend !== "s3" && backend !== "r2") return null;
    return new S3StorageAdapter({
      backend,
      endpoint: env.ANDROID_OPS_S3_ENDPOINT?.trim(),
      region: env.ANDROID_OPS_S3_REGION?.trim() || "us-east-1",
      bucket: env.ANDROID_OPS_S3_BUCKET?.trim(),
      accessKeyId: env.ANDROID_OPS_S3_ACCESS_KEY_ID?.trim(),
      secretAccessKey: env.ANDROID_OPS_S3_SECRET_ACCESS_KEY?.trim(),
      publicBaseUrl: env.ANDROID_OPS_S3_PUBLIC_BASE?.trim(),
    });
  }

  private missing(): string[] {
    const gaps: string[] = [];
    if (!this.cfg.bucket) gaps.push("bucket");
    if (!this.cfg.accessKeyId) gaps.push("access key");
    if (!this.cfg.secretAccessKey) gaps.push("secret key");
    if (this.cfg.backend !== "s3" && !this.cfg.endpoint) gaps.push("endpoint");
    return gaps;
  }

  async probe(): Promise<AdapterAvailability> {
    const gaps = this.missing();
    if (gaps.length) {
      return {
        available: false,
        version: null,
        binPath: null,
        reason: `${this.cfg.backend} storage is selected but not configured — missing ${gaps.join(", ")}`,
        checkedAt: Date.now(),
      };
    }
    // A HEAD on the bucket root is enough to tell an operator whether the
    // endpoint is reachable, without pulling in a full SDK dependency.
    const url = this.objectUrl("");
    try {
      const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(6000) });
      return {
        available: res.status < 500,
        version: `${this.cfg.backend} ${this.cfg.bucket}`,
        binPath: url,
        reason: res.status >= 500 ? `endpoint returned ${res.status}` : null,
        checkedAt: Date.now(),
      };
    } catch (e) {
      return {
        available: false,
        version: null,
        binPath: url,
        reason: `endpoint unreachable: ${String(e)}`,
        checkedAt: Date.now(),
      };
    }
  }

  private objectUrl(key: string): string {
    const base = this.cfg.publicBaseUrl?.replace(/\/$/, "");
    if (base) return key ? `${base}/${key}` : base;
    const endpoint = (this.cfg.endpoint ?? `https://s3.${this.cfg.region}.amazonaws.com`).replace(
      /\/$/,
      "",
    );
    return key ? `${endpoint}/${this.cfg.bucket}/${key}` : `${endpoint}/${this.cfg.bucket}`;
  }

  async put(key: string): Promise<StoragePutResult> {
    // Uploads go through a signed-URL flow owned by the deployment; this
    // adapter deliberately does not embed long-lived credentials in a PUT.
    return {
      ok: false,
      key,
      sizeBytes: 0,
      checksum: null,
      reason: `direct upload to ${this.cfg.backend} is handled by the deployment's signing service`,
    };
  }

  async resolveUrl(key: string): Promise<string | null> {
    return this.missing().length ? null : this.objectUrl(key);
  }

  async stat(key: string): Promise<StorageStat> {
    if (this.missing().length) return { exists: false, key, sizeBytes: null, updatedAt: null };
    try {
      const res = await fetch(this.objectUrl(key), {
        method: "HEAD",
        signal: AbortSignal.timeout(6000),
      });
      const len = Number(res.headers.get("content-length") ?? NaN);
      const mod = res.headers.get("last-modified");
      return {
        exists: res.ok,
        key,
        sizeBytes: Number.isFinite(len) ? len : null,
        updatedAt: mod ? Date.parse(mod) : null,
      };
    } catch {
      return { exists: false, key, sizeBytes: null, updatedAt: null };
    }
  }

  async remove(key: string): Promise<{ ok: boolean; reason: string | null }> {
    return {
      ok: false,
      reason: `deletes on ${this.cfg.backend} are performed by the deployment's lifecycle policy (${key})`,
    };
  }
}

/** Pick the configured backend, falling back to local dev storage. */
export function createStorageAdapter(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): StorageAdapter {
  return (
    S3StorageAdapter.fromEnv(env) ?? new LocalStorageAdapter(join(stateDir, "android-ops", "media"))
  );
}

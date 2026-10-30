/**
 * sha256-verified downloader with progress, for native voice models/binaries.
 * Uses undici's global fetch (streamed) — no extra deps.
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface DownloadSpec {
  url: string;
  dest: string;
  /** Hex sha256 of the expected file. When omitted, no verification. */
  sha256?: string;
  label?: string;
}

export type ProgressFn = (received: number, total: number | null) => void;

/** Returns true if `dest` exists and (when given) matches `sha256`. */
export async function alreadyPresent(dest: string, sha256?: string): Promise<boolean> {
  if (!fs.existsSync(dest)) return false;
  if (!sha256) return true;
  return (await fileSha256(dest)) === sha256.toLowerCase();
}

export async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * Download `url` → `dest`, verifying sha256 when provided. Streams to a
 * .part file then atomically renames. Skips when already present + verified.
 */
export async function downloadVerified(spec: DownloadSpec, onProgress?: ProgressFn): Promise<void> {
  if (await alreadyPresent(spec.dest, spec.sha256)) return;

  fs.mkdirSync(path.dirname(spec.dest), { recursive: true });
  const tmp = `${spec.dest}.part`;

  const res = await fetch(spec.url);
  if (!res.ok || !res.body) {
    throw new Error(`download ${spec.label ?? spec.url} failed: HTTP ${res.status}`);
  }
  const total = Number(res.headers.get("content-length")) || null;

  let received = 0;
  const hash = createHash("sha256");
  const source = Readable.fromWeb(res.body as any);
  source.on("data", (chunk: Buffer) => {
    received += chunk.length;
    hash.update(chunk);
    onProgress?.(received, total);
  });
  await pipeline(source, createWriteStream(tmp));

  if (spec.sha256) {
    const got = hash.digest("hex");
    if (got !== spec.sha256.toLowerCase()) {
      fs.rmSync(tmp, { force: true });
      throw new Error(
        `sha256 mismatch for ${spec.label ?? spec.dest}: expected ${spec.sha256}, got ${got}`,
      );
    }
  }
  fs.renameSync(tmp, spec.dest);
}

/** Render a received/total pair as a terse one-line progress string. */
export function formatProgress(label: string, received: number, total: number | null): string {
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  if (!total) return `${label}: ${mb(received)} MB`;
  const pct = Math.floor((received / total) * 100);
  return `${label}: ${pct}% (${mb(received)}/${mb(total)} MB)`;
}

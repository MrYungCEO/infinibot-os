/**
 * Resumable model download for the built-in voice engine.
 *
 * Each file streams to `<file>.part`; a later run sends `Range: bytes=<n>-`
 * and appends, so closing the app mid-download continues where it stopped.
 * A file only gets its final name once its size matches what the server said.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { localPath, remoteUrl, type ModelFile } from "./models.js";

export interface FileSize {
  file: ModelFile;
  total: number;
  have: number;
  done: boolean;
}

type FetchFn = typeof fetch;

function sizeOf(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Real sizes from the server (HEAD), falling back to the estimate. */
export async function measure(
  files: ModelFile[],
  dir: string,
  fetchFn: FetchFn = fetch,
): Promise<FileSize[]> {
  return Promise.all(
    files.map(async (file) => {
      const dest = localPath(dir, file);
      if (fs.existsSync(dest)) {
        const n = sizeOf(dest);
        return { file, total: n, have: n, done: true };
      }
      let total = file.approxBytes;
      try {
        const r = await fetchFn(remoteUrl(file), {
          method: "HEAD",
          redirect: "follow",
          signal: AbortSignal.timeout(15_000),
        });
        const len = Number(r.headers.get("x-linked-size") ?? r.headers.get("content-length"));
        if (r.ok && Number.isFinite(len) && len > 0) total = len;
      } catch {
        /* offline: keep the estimate; the download step reports the real error */
      }
      return { file, total, have: Math.min(sizeOf(`${dest}.part`), total), done: false };
    }),
  );
}

/**
 * Download one file with resume. `onBytes` gets the bytes added since the last
 * call (including bytes already on disk at the start).
 */
export async function downloadFile(
  file: ModelFile,
  dir: string,
  onBytes: (n: number) => void,
  opts: { signal?: AbortSignal; fetchFn?: FetchFn } = {},
): Promise<void> {
  const dest = localPath(dir, file);
  if (fs.existsSync(dest)) return;
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let have = sizeOf(part);
  const f = opts.fetchFn ?? fetch;
  const res = await f(remoteUrl(file), {
    headers: have > 0 ? { Range: `bytes=${have}-` } : {},
    redirect: "follow",
    signal: opts.signal,
  });
  if (res.status === 416) {
    // Already complete on disk.
    fs.renameSync(part, dest);
    return;
  }
  if (!res.ok || !res.body)
    throw new Error(`download ${file.repo}/${file.file}: HTTP ${res.status}`);
  let total: number | null = null;
  if (res.status === 206) {
    const m = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "");
    total = m ? Number(m[1]) : null;
    if (have > 0) onBytes(have);
  } else {
    // Server ignored the range: start over.
    have = 0;
    const len = Number(res.headers.get("content-length"));
    total = Number.isFinite(len) && len > 0 ? len : null;
  }
  // Append each chunk synchronously: whatever arrived before a dropped
  // connection is on disk for the next resume.
  const fd = fs.openSync(part, res.status === 206 ? "a" : "w");
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (opts.signal?.aborted) throw new Error("cancelled");
      fs.writeSync(fd, chunk);
      onBytes(chunk.length);
    }
  } finally {
    fs.closeSync(fd);
  }
  const got = sizeOf(part);
  if (total !== null && got !== total)
    throw new Error(`download ${file.file}: got ${got} of ${total} bytes (connection reset)`);
  fs.renameSync(part, dest);
}

/** Every file of a model set is on disk. */
export function modelsPresent(files: ModelFile[], dir: string): boolean {
  return files.every((f) => fs.existsSync(localPath(dir, f)));
}

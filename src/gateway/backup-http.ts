/**
 * Backup HTTP endpoints.
 *
 * Two routes:
 *   GET  /backup/download
 *     Creates a fresh backup zip (config + databases + credentials +
 *     agent workspace) and streams it back with a download
 *     Content-Disposition. Default filename:
 *     `infinibot-backup-<timestamp>.zip`.
 *
 *   POST /backup/restore
 *     Accepts a multipart/form-data upload with a single `file` field
 *     (the .zip). Calls restoreBackup({ force: true }) and replies
 *     with the resulting manifest. The current install's existing
 *     dirs are rotated to `.bak-<ts>` so the operator can roll back.
 *
 * Both endpoints reuse `src/infra/backup.ts` so HTTP and the CLI
 * (`infinibot backup` / `infinibot restore`) produce / consume the
 * same zip format and manifest.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createBackup, defaultBackupFilename, restoreBackup } from "../infra/backup.js";
import { sendJson } from "./http-common.js";
import { parseMultipartBoundary, parseMultipartToDisk } from "./video-swift-http.js";

const DOWNLOAD_PATH = "/backup/download";
const RESTORE_PATH = "/backup/restore";

function respondError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

async function handleDownload(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "infinibot-backup-"));
  const filename = defaultBackupFilename();
  const outPath = path.join(tmpDir, filename);
  try {
    const result = await createBackup({
      outPath,
      includeWorkspace: true,
      logger: { warn: (m) => console.warn("[backup-http]", m) },
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", String(result.bytes));
    res.setHeader("X-InfiniBot-Backup-Files", String(result.fileCount));
    // Stream the file so a multi-MB backup doesn't sit fully in memory.
    const stream = fs.createReadStream(outPath);
    stream.on("error", () => {
      // Connection already failed; nothing useful to send.
      res.destroy();
    });
    stream.on("close", () => {
      // Best-effort cleanup of the temp dir + zip.
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    });
    stream.pipe(res);
  } catch (err) {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    respondError(res, 500, err instanceof Error ? err.message : String(err));
  }
}

async function handleRestore(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const boundary = parseMultipartBoundary(req.headers["content-type"]);
  if (!boundary) {
    respondError(res, 400, "expected multipart/form-data with a `file` field");
    return;
  }
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "infinibot-restore-"));
  try {
    const fields = await parseMultipartToDisk(req, boundary, tmpDir);
    const file = fields.find((f) => f.kind === "file" && f.name === "file");
    if (!file || file.kind !== "file") {
      respondError(res, 400, "missing `file` field in upload");
      return;
    }
    const result = await restoreBackup({
      zipPath: file.path,
      force: true,
      logger: { info: (m) => console.warn("[backup-http]", m) },
    });
    sendJson(res, 200, {
      ok: true,
      manifest: result.manifest,
      targets: result.targets,
      rotated: result.rotated,
    });
  } catch (err) {
    respondError(res, 500, err instanceof Error ? err.message : String(err));
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Returns true when the request was handled.
 */
export async function handleBackupHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? "";
  const pathname = url.split("?")[0];
  if (pathname === DOWNLOAD_PATH) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      respondError(res, 405, "method not allowed");
      return true;
    }
    if (req.method === "HEAD") {
      res.statusCode = 200;
      res.end();
      return true;
    }
    await handleDownload(req, res);
    return true;
  }
  if (pathname === RESTORE_PATH) {
    if (req.method !== "POST") {
      respondError(res, 405, "method not allowed — POST a zip");
      return true;
    }
    await handleRestore(req, res);
    return true;
  }
  return false;
}

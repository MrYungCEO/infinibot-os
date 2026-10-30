/**
 * /api/compositions/:compositionId/assets — streaming HTTP asset upload.
 *
 * The base64-over-WebSocket upload path tops out at the WS frame limit
 * (~25MB client / 50MB server) which makes it useless for typical raw
 * camera footage. This endpoint instead streams a multipart/form-data body
 * straight to the composition's assets directory, then registers the asset
 * via `addAsset()` so it shows up in the editor library and at the
 * `/media/...` URL the existing media handler serves.
 *
 *   POST /api/compositions/{compositionId}/assets
 *     Content-Type: multipart/form-data; boundary=...
 *     Body: form fields:
 *       file        — the binary (required)
 *       width       — optional probed width (px)
 *       height      — optional probed height (px)
 *       durationSec — optional probed duration (s)
 *
 *   200 → { asset: AssetMetadata }
 *   400 → { error }
 *
 * Hard cap is 2GB (the parser's default). The gateway is local, so the
 * limit exists only to stop a runaway body from filling the disk.
 */

import { renameSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  addAsset,
  assetsDir,
  assetPublicUrl,
  ensureProjectDir,
  type AssetKind,
  type AssetMetadata,
} from "../compositions/project-dir.js";
import { resolveStateDir } from "../config/paths.js";
import { getCompositionsStore } from "../compositions/store.js";
import { sendJson, sendMethodNotAllowed } from "./http-common.js";
import {
  parseMultipartBoundary,
  parseMultipartToDisk,
} from "./video-swift-http.js";

const ROUTE_PREFIX = "/api/compositions/";
const ASSETS_SUFFIX = "/assets";

function kindForExt(ext: string): AssetKind {
  const e = ext.toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(e)) return "image";
  if (["mp4", "mov", "webm", "mkv", "avi"].includes(e)) return "video";
  if (["mp3", "wav", "flac", "ogg", "m4a", "aac"].includes(e)) return "audio";
  return "other";
}

export async function handleCompositionAssetsUploadRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? "";
  if (!url.startsWith(ROUTE_PREFIX)) return false;
  // Path shape: /api/compositions/{id}/assets   (and only that)
  const tail = url.slice(ROUTE_PREFIX.length).split("?")[0]!;
  if (!tail.endsWith(ASSETS_SUFFIX)) return false;
  const compositionId = decodeURIComponent(tail.slice(0, -ASSETS_SUFFIX.length));
  if (!compositionId) return false;

  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }

  try {
    // Validate composition exists before we accept the body so we don't
    // stream gigabytes only to discard them.
    const store = getCompositionsStore(resolveStateDir());
    const comp = store.get(compositionId);
    if (!comp) {
      sendJson(res, 404, { error: `Composition ${compositionId} not found` });
      return true;
    }
    ensureProjectDir(comp.id, comp.name);

    const boundary = parseMultipartBoundary(req.headers["content-type"]);
    if (!boundary) {
      sendJson(res, 400, { error: "Content-Type must be multipart/form-data with a boundary" });
      return true;
    }

    const fields = await parseMultipartToDisk(req, boundary, tmpdir());
    const fileField = fields.find((f) => f.kind === "file" && f.name === "file");
    if (!fileField || fileField.kind !== "file") {
      sendJson(res, 400, { error: "Missing required field: file" });
      // Clean up any other files that snuck through.
      for (const f of fields) if (f.kind === "file") tryUnlink(f.path);
      return true;
    }
    if (fileField.size === 0) {
      tryUnlink(fileField.path);
      sendJson(res, 400, { error: "Uploaded file is 0 bytes" });
      return true;
    }

    // Move the streamed temp file into the composition's assets dir under
    // a collision-proof name. Don't trust the client filename for disk.
    const safeName = (fileField.filename || "upload.bin").replace(/[^a-zA-Z0-9._-]+/g, "_");
    const filename = `${Date.now()}-${randSlug()}-${safeName}`;
    const finalPath = join(assetsDir(compositionId), filename);
    try {
      renameSync(fileField.path, finalPath);
    } catch {
      // Cross-device rename can fail on Windows when temp + state are on
      // different volumes. Fall back to copy + unlink.
      const { copyFileSync } = await import("node:fs");
      copyFileSync(fileField.path, finalPath);
      tryUnlink(fileField.path);
    }
    const stat = statSync(finalPath);

    const text = (name: string): { kind: "text"; value: string } | undefined => {
      const f = fields.find((x) => x.kind === "text" && x.name === name);
      return f && f.kind === "text" ? f : undefined;
    };
    const width = numField(text("width"));
    const height = numField(text("height"));
    const durationSec = numField(text("durationSec"));

    const ext = (fileField.filename.split(".").pop() ?? "").toLowerCase();
    const meta: AssetMetadata = {
      filename,
      name: fileField.filename || filename,
      url: assetPublicUrl(compositionId, filename),
      kind: kindForExt(ext),
      size: stat.size,
      uploadedAt: stat.mtimeMs,
      mime: fileField.mime,
      width,
      height,
      durationSec,
    };
    addAsset(compositionId, meta);
    sendJson(res, 200, { asset: meta });
    return true;
  } catch (err) {
    sendJson(res, 500, { error: (err as Error).message });
    return true;
  }
}

function tryUnlink(p: string): void {
  try { unlinkSync(p); } catch { /* noop */ }
}

function numField(field: { kind: "text"; value: string } | undefined): number | undefined {
  if (!field) return undefined;
  const n = Number(field.value);
  return Number.isFinite(n) ? n : undefined;
}

function randSlug(): string {
  return Math.random().toString(36).slice(2, 8);
}

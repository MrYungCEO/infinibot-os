/**
 * Gateway RPC handlers for object covers (Notion-style banner images).
 *
 * Thin wrappers over the SQLite-backed `CoversStore` (src/covers/store.ts).
 * The upload path deliberately mirrors `issues.attach` / the kanban attachment
 * upload: base64 in, SHA256-keyed bytes written under the shared files root, a
 * files-root-relative `path` recorded — so `files.download` serves cover bytes
 * with zero new plumbing.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join as pathJoin, extname as pathExtname } from "node:path";
import { createHash } from "node:crypto";
import type { GatewayRequestHandlers } from "./types.js";
import { getCoversStore } from "../../covers/store.js";
import { resolveStateDir } from "../../config/paths.js";
import type { CoverListParams } from "../../covers/types.js";

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".bmp", ".ico"];

/** Filesystem-safe segment so an object id can never escape the covers dir. */
function safeSegment(v: string): string {
  return String(v)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 128);
}

export const coverHandlers: GatewayRequestHandlers = {
  "covers.get": async ({ params, respond }) => {
    try {
      const { objectType, objectId } = (params ?? {}) as {
        objectType?: string;
        objectId?: string;
      };
      if (!objectType || !objectId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "objectType and objectId are required",
        });
        return;
      }
      respond(true, { cover: getCoversStore().get({ objectType, objectId }) });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Batch lookup so a whole board/grid resolves its thumbnails in one call. */
  "covers.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as unknown as CoverListParams;
      if (!p.objectType) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "objectType is required" });
        return;
      }
      const objectIds = Array.isArray(p.objectIds) ? p.objectIds.map(String) : undefined;
      const covers = getCoversStore().list({ objectType: p.objectType, objectIds });
      respond(true, { covers, count: covers.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Set a cover from an external image/GIF URL (the "Add link" path). */
  "covers.setLink": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        objectType?: string;
        objectId?: string;
        url?: string;
        name?: string;
        positionY?: number;
      };
      if (!p.objectType || !p.objectId || !p.url) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "objectType, objectId and url are required",
        });
        return;
      }
      const url = String(p.url).trim();
      if (!/^(https?:)?\/\//i.test(url) && !url.startsWith("data:image/")) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "url must be an http(s) URL or a data:image/… URI",
        });
        return;
      }
      const cover = getCoversStore().setLink({
        objectType: p.objectType,
        objectId: p.objectId,
        url,
        name: p.name,
        positionY: p.positionY,
      });
      respond(true, { cover });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Upload + set a cover in one call. Accepts base64 `content`, writes it to
   *   <state-dir>/files/covers/<objectType>/<objectId>/<sha256><ext>
   * and records the row. Mirrors `issues.attach`.
   */
  "covers.upload": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        objectType?: string;
        objectId?: string;
        name?: string;
        content?: string;
        mimeType?: string;
        positionY?: number;
      };
      if (!p.objectType || !p.objectId || !p.name || !p.content) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "objectType, objectId, name and content (base64) are required",
        });
        return;
      }

      const name = String(p.name);
      const mimeType = typeof p.mimeType === "string" ? p.mimeType : "application/octet-stream";
      const ext = pathExtname(name).toLowerCase();
      const isImage = mimeType.startsWith("image/") || IMAGE_EXTS.includes(ext);
      if (!isImage) {
        respond(false, undefined, {
          code: "UNSUPPORTED_MEDIA_TYPE",
          message: `Only image files are supported (got ${mimeType || ext || "unknown"})`,
        });
        return;
      }

      const buffer = Buffer.from(String(p.content), "base64");
      const size = buffer.length;
      const maxBytes = parseInt(process.env.INFINIBOT_ATTACHMENT_MAX_BYTES ?? "52428800", 10);
      if (size > maxBytes) {
        respond(false, undefined, {
          code: "PAYLOAD_TOO_LARGE",
          message: `Image exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit`,
        });
        return;
      }

      const typeSeg = safeSegment(p.objectType);
      const idSeg = safeSegment(p.objectId);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const stateDir = resolveStateDir();
      const dir = pathJoin(stateDir, "files", "covers", typeSeg, idSeg);
      mkdirSync(dir, { recursive: true });
      const stableFilename = `${sha256}${ext || ".png"}`;
      writeFileSync(pathJoin(dir, stableFilename), buffer);
      const relativePath = `covers/${typeSeg}/${idSeg}/${stableFilename}`;

      const cover = getCoversStore().setUpload({
        objectType: p.objectType,
        objectId: p.objectId,
        path: relativePath,
        name,
        mimeType,
        size,
        sha256,
        positionY: p.positionY,
      });
      respond(true, { cover });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Reposition the banner crop without re-uploading (Notion "Reposition"). */
  "covers.setPosition": async ({ params, respond }) => {
    try {
      const { objectType, objectId, positionY } = (params ?? {}) as {
        objectType?: string;
        objectId?: string;
        positionY?: number;
      };
      if (!objectType || !objectId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "objectType and objectId are required",
        });
        return;
      }
      const cover = getCoversStore().setPosition(objectType, objectId, Number(positionY) || 50);
      if (!cover) {
        respond(false, undefined, { code: "NOT_FOUND", message: "No cover set on that object" });
        return;
      }
      respond(true, { cover });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "covers.clear": async ({ params, respond }) => {
    try {
      const { objectType, objectId } = (params ?? {}) as {
        objectType?: string;
        objectId?: string;
      };
      if (!objectType || !objectId) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "objectType and objectId are required",
        });
        return;
      }
      const cleared = getCoversStore().clear(objectType, objectId);
      respond(true, { cleared, objectType, objectId });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

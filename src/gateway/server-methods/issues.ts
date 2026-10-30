/**
 * Gateway RPC handlers for the System Issues / Improvement Log (K.I.S.).
 *
 * Thin wrappers over the SQLite-backed `IssuesStore` (src/issues/store.ts).
 * Mirrors the shape of the notes handlers: each method validates params, calls
 * the store, and reports through `respond(ok, data, error?)`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join as pathJoin, extname as pathExtname } from "node:path";
import { createHash } from "node:crypto";
import type { GatewayRequestHandlers } from "./types.js";
import { getIssuesStore } from "../../issues/store.js";
import { resolveStateDir } from "../../config/paths.js";
import type {
  IssueCreateParams,
  IssueSearchParams,
  IssueUpdateParams,
} from "../../issues/types.js";

export const issueHandlers: GatewayRequestHandlers = {
  "issues.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as IssueSearchParams;
      const issues = getIssuesStore().list(p);
      respond(true, { issues, count: issues.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "issues.search": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as IssueSearchParams;
      const issues = getIssuesStore().list(p);
      respond(true, { issues, count: issues.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "issues.get": async ({ params, respond }) => {
    try {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const issue = getIssuesStore().get(id);
      if (!issue) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Issue "${id}" not found` });
        return;
      }
      respond(true, issue);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "issues.create": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as unknown as IssueCreateParams;
      if (!p.title || typeof p.title !== "string") {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "title is required" });
        return;
      }
      const issue = getIssuesStore().create(p);
      respond(true, issue);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "issues.update": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as unknown as IssueUpdateParams;
      if (!p.id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const issue = getIssuesStore().update(p);
      if (!issue) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Issue "${p.id}" not found` });
        return;
      }
      respond(true, issue);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "issues.delete": async ({ params, respond }) => {
    try {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const ok = getIssuesStore().delete(id);
      if (!ok) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Issue "${id}" not found` });
        return;
      }
      respond(true, { deleted: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Atomic upload + register of a screenshot/image on an issue. Accepts base64
   * `content`, writes it to a stable SHA256-keyed path under
   *   <state-dir>/files/issues/<issueId>/<sha256><ext>
   * (the same files root `files.download` serves from), dedups by sha256, and
   * records the row. Mirrors `kanban.projects.content.uploadAttachment`.
   */
  "issues.attach": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        issueId?: string;
        name?: string;
        content?: string;
        mimeType?: string;
      };
      if (!p.issueId || !p.name || !p.content) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "issueId, name and content (base64) are required",
        });
        return;
      }
      const store = getIssuesStore();
      const issue = store.get(p.issueId);
      if (!issue) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Issue "${p.issueId}" not found` });
        return;
      }

      const name = String(p.name);
      const mimeType = typeof p.mimeType === "string" ? p.mimeType : "application/octet-stream";
      // Images only — the UI surface is screenshots.
      const ext = pathExtname(name).toLowerCase();
      const isImage =
        mimeType.startsWith("image/") ||
        [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"].includes(ext);
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

      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const existing = store.findAttachmentBySha256(p.issueId, sha256);
      if (existing) {
        respond(true, existing);
        return;
      }

      const stateDir = resolveStateDir();
      const issueFilesDir = pathJoin(stateDir, "files", "issues", p.issueId);
      mkdirSync(issueFilesDir, { recursive: true });
      const stableFilename = `${sha256}${ext || ".png"}`;
      writeFileSync(pathJoin(issueFilesDir, stableFilename), buffer);
      const relativePath = `issues/${p.issueId}/${stableFilename}`;

      const att = store.createAttachment({
        issueId: p.issueId,
        name,
        path: relativePath,
        mimeType,
        size,
        sha256,
      });
      respond(true, att);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "issues.attachments.list": async ({ params, respond }) => {
    try {
      const { issueId } = (params ?? {}) as { issueId?: string };
      if (!issueId) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "issueId is required" });
        return;
      }
      const attachments = getIssuesStore().listAttachments(issueId);
      respond(true, { attachments, count: attachments.length });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "issues.attachment.delete": async ({ params, respond }) => {
    try {
      const { id } = (params ?? {}) as { id?: string };
      if (!id) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "id is required" });
        return;
      }
      const ok = getIssuesStore().deleteAttachment(id);
      if (!ok) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Attachment "${id}" not found` });
        return;
      }
      respond(true, { deleted: true, id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

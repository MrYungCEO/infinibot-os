/**
 * Auto-OCR RPCs — file context for agents and the Files page.
 *
 *   files.context.get     { id | path | sha256 | docId, secure? } → entry + sidecar
 *   files.context.search  { query, limit?, secure? }              → content hits
 *   files.context.list    { status?, projectId?, sessionKey?, limit?, secure? }
 *   files.ocr.status      engines, model, per-lane queue counts
 *   files.ocr.rerun       { id | path, secure? }
 *   files.inspect         { id | path, question, page?, secure? } → local VL answer
 *   files.secure.list / upload / download / delete — the encrypted Files lane
 *   files.secure.update / bulkUpdate, files.secure.collections.* — user
 *     organisation (collections, tags, project, name, notes), sealed in the vault
 *
 * `secure: true` selects the Secure Mode lane and fails closed while it is
 * locked. Secure results never come back from a normal-lane call.
 */
import path from "node:path";
import { broadcastSecureLaneChanged } from "../../secure-mode/events.js";
import { getSecureModeRuntime } from "../../secure-mode/runtime.js";
import {
  SecureFilesOrganizer,
  SecureOrganizeError,
  type SecureFilePatch,
} from "../../ocr/secure-organize.js";
import { backfillWorkspace, getOcrService, resolveFilesRoot } from "../../ocr/runtime.js";
import type { OcrRef } from "../../ocr/service.js";
import type { OcrLane, OcrStatus } from "../../ocr/types.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

type Respond = GatewayRequestHandlerOptions["respond"];

class LockedError extends Error {}

function fail(respond: Respond, err: unknown, code = "INTERNAL_ERROR") {
  const message = err instanceof Error ? err.message : String(err);
  respond(false, undefined, {
    code:
      err instanceof LockedError || /Secure Mode is locked/.test(message)
        ? "SECURE_MODE_LOCKED"
        : err instanceof SecureOrganizeError
          ? "INVALID_REQUEST"
          : code,
    message,
  });
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function laneOf(p: Record<string, unknown>): OcrLane {
  if (p.secure === true) {
    if (!getSecureModeRuntime().isUnlocked()) throw new LockedError("Secure Mode is locked");
    return "secure";
  }
  return "normal";
}

/** Files-page relative paths resolve under the files root; absolute paths pass through. */
function refOf(p: Record<string, unknown>): OcrRef {
  const rel = str(p.path);
  const abs = rel
    ? path.isAbsolute(rel)
      ? rel
      : path.resolve(resolveFilesRoot(), rel)
    : undefined;
  if (abs && !path.isAbsolute(rel) && !abs.startsWith(path.resolve(resolveFilesRoot()))) {
    throw new Error("path escapes the files root");
  }
  return {
    id: str(p.id) || undefined,
    path: abs,
    sha256: str(p.sha256) || undefined,
    docId: str(p.docId) || undefined,
  };
}

function relPath(abs: string | null): string | null {
  if (!abs) return null;
  const root = path.resolve(resolveFilesRoot());
  return abs.startsWith(root + path.sep) ? path.relative(root, abs).replace(/\\/g, "/") : abs;
}

function publicEntry<T extends { path: string | null; sidecarPath?: string }>(e: T) {
  const { sidecarPath: _s, ...rest } = e;
  return { ...rest, relPath: relPath(e.path) };
}

const SECURE_UPLOAD_MAX = 40 * 1024 * 1024;
const SECURE_LIST_MAX = 2000;

/** Organiser over the unlocked vault (throws SECURE_MODE_LOCKED otherwise). */
function organizer(): SecureFilesOrganizer {
  laneOf({ secure: true });
  return new SecureFilesOrganizer(getSecureModeRuntime().requireVault());
}

function secureIds(): string[] {
  return getOcrService()
    .list("secure", { limit: SECURE_LIST_MAX })
    .map((e) => e.id);
}

const idList = (v: unknown): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && !!x))] : [];

/** Only the organise keys a caller sent (undefined = leave as is, null = clear). */
function patchOf(p: Record<string, unknown>): SecureFilePatch {
  const out: SecureFilePatch = {};
  if ("name" in p) out.name = typeof p.name === "string" ? p.name : null;
  if ("collectionId" in p)
    out.collectionId = typeof p.collectionId === "string" ? p.collectionId : null;
  if ("tags" in p) out.tags = Array.isArray(p.tags) ? (p.tags as string[]) : [];
  if (Array.isArray(p.addTags)) out.addTags = p.addTags as string[];
  if (Array.isArray(p.removeTags)) out.removeTags = p.removeTags as string[];
  if ("projectId" in p) out.projectId = typeof p.projectId === "string" ? p.projectId : null;
  if ("notes" in p) out.notes = typeof p.notes === "string" ? p.notes : null;
  return out;
}

function organizedChanged() {
  broadcastSecureLaneChanged("files");
}

export const filesOcrHandlers: GatewayRequestHandlers = {
  "files.context.get": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const lane = laneOf(p);
      const ctx = getOcrService().getContext(lane, refOf(p));
      if (!ctx) {
        respond(true, { found: false });
        return;
      }
      respond(true, { found: true, entry: publicEntry(ctx.entry), sidecar: ctx.sidecar });
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.context.search": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const lane = laneOf(p);
      const query = str(p.query);
      if (!query) {
        respond(true, { results: [] });
        return;
      }
      const limit = Number(p.limit) || 20;
      const results = getOcrService()
        .search(lane, query, limit)
        .map((h) => ({ ...h, relPath: relPath(h.path) }));
      respond(true, { results });
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.context.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const lane = laneOf(p);
      const status = str(p.status) as OcrStatus | "";
      const entries = getOcrService()
        .list(lane, {
          status: status || undefined,
          projectId: str(p.projectId) || undefined,
          sessionKey: str(p.sessionKey) || undefined,
          limit: Number(p.limit) || 200,
        })
        .map(publicEntry);
      respond(true, { entries });
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.ocr.status": async ({ respond }) => {
    try {
      respond(true, await getOcrService().status());
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.ocr.rerun": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const lane = laneOf(p);
      const svc = getOcrService();
      const ref = refOf(p);
      let entry = svc.rerun(lane, ref);
      const root = path.resolve(resolveFilesRoot());
      if (
        !entry &&
        lane === "normal" &&
        ref.path &&
        path.resolve(ref.path).startsWith(root + path.sep)
      ) {
        // Never registered (uploaded before auto-OCR existed): register now.
        entry = svc.enqueuePath({
          absPath: ref.path,
          source: { kind: "files" },
          priority: 5,
          force: true,
        });
      }
      if (!entry) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: "file is not OCR-able or not found",
        });
        return;
      }
      respond(true, { entry: publicEntry(entry) });
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.ocr.backfill": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      respond(true, backfillWorkspace({ force: true, maxFiles: Number(p.maxFiles) || undefined }));
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.inspect": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const lane = laneOf(p);
      const question = str(p.question);
      if (!question) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "question is required" });
        return;
      }
      const res = await getOcrService().inspect(lane, refOf(p), question, {
        page: Number(p.page) || undefined,
      });
      respond(true, res);
    } catch (err) {
      fail(respond, err);
    }
  },

  // ── Secure Files lane (vault-sealed bytes + OCR) ──────────────────────

  "files.secure.list": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      laneOf({ secure: true });
      const raw = getOcrService().list("secure", {
        limit: Math.min(Number(p.limit) || 500, SECURE_LIST_MAX),
      });
      const org = organizer();
      // First list after an upgrade files every existing entry at the root, no tags.
      org.migrate(secureIds());
      const fields = org.fieldsFor(raw);
      const collectionId = "collectionId" in p ? str(p.collectionId) || null : undefined;
      const tag = str(p.tag).toLowerCase();
      const entries = raw
        .map((e) => ({ ...publicEntry(e), ...fields.get(e.id) }))
        .filter((e) => collectionId === undefined || e.collectionId === collectionId)
        .filter((e) => !tag || (e.tags ?? []).some((t) => t.toLowerCase() === tag));
      respond(true, { entries, organize: true });
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.secure.upload": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      laneOf({ secure: true });
      const name =
        str(p.name)
          .split(/[\\/]/)
          .pop()
          ?.replace(/[^\w.\- ]+/g, "_")
          .slice(0, 120) ?? "";
      const content = str(p.content);
      if (!name || !content) {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: "name and content are required",
        });
        return;
      }
      const data = Buffer.from(content.replace(/^data:[^,]*,/, ""), "base64");
      if (data.length > SECURE_UPLOAD_MAX) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "file too large (>40MB)" });
        return;
      }
      const org = organizer();
      const target = patchOf({
        ...("collectionId" in p ? { collectionId: p.collectionId } : {}),
        ...(Array.isArray(p.tags) ? { addTags: p.tags } : {}),
        ...(str(p.projectId) ? { projectId: p.projectId } : {}),
      });
      if (
        target.collectionId &&
        !org.listCollections().collections.some((c) => c.id === target.collectionId)
      ) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "collection not found" });
        return;
      }
      const entry = getOcrService().enqueueSecure({
        name,
        data,
        source: { kind: "secure-files", projectId: str(p.projectId) || undefined },
      });
      data.fill(0);
      const meta = org.update(entry.id, target);
      organizedChanged();
      respond(true, {
        entry: { ...publicEntry(entry), ...org.fieldsFor([entry]).get(entry.id) },
        meta,
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.secure.download": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      laneOf({ secure: true });
      const r = getOcrService().readBytes("secure", { id: str(p.id) });
      if (!r) {
        respond(false, undefined, { code: "NOT_FOUND", message: "secure file not found" });
        return;
      }
      respond(true, {
        id: r.entry.id,
        name: r.entry.name,
        mime: r.entry.mime,
        content: r.data.toString("base64"),
      });
      r.data.fill(0);
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.secure.delete": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      laneOf({ secure: true });
      const ok = getOcrService().remove("secure", { id: str(p.id) });
      if (ok) organizer().forget(str(p.id));
      respond(true, { ok });
    } catch (err) {
      fail(respond, err);
    }
  },

  // ── Secure Files organisation (sealed in the vault) ───────────────────

  "files.secure.update": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const org = organizer();
      const id = str(p.id);
      if (!id || !secureIds().includes(id)) {
        respond(false, undefined, { code: "NOT_FOUND", message: "secure file not found" });
        return;
      }
      const patch = patchOf(
        (p.patch && typeof p.patch === "object" ? p.patch : p) as Record<string, unknown>,
      );
      const meta = org.update(id, patch);
      organizedChanged();
      respond(true, { id, meta });
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.secure.bulkUpdate": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const org = organizer();
      const ids = idList(p.ids);
      if (!ids.length) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "ids[] is required" });
        return;
      }
      if (ids.length > SECURE_LIST_MAX) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: "too many ids" });
        return;
      }
      const known = new Set(secureIds());
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `${missing.length} secure file(s) not found`,
        });
        return;
      }
      const patch = patchOf(
        (p.patch && typeof p.patch === "object" ? p.patch : p) as Record<string, unknown>,
      );
      delete patch.name; // names are per file
      const files = org.bulkUpdate(ids, patch);
      organizedChanged();
      respond(true, { updated: Object.keys(files).length, files });
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.secure.collections.list": async ({ respond }) => {
    try {
      const org = organizer();
      const ids = secureIds();
      org.migrate(ids);
      respond(true, { ...org.listCollections(ids), total: ids.length });
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.secure.collections.create": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const collection = organizer().createCollection({ name: p.name, parentId: p.parentId });
      organizedChanged();
      respond(true, { collection });
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.secure.collections.rename": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const collection = organizer().updateCollection({
        id: str(p.id),
        ...("name" in p ? { name: p.name } : {}),
        ...("parentId" in p ? { parentId: p.parentId ?? null } : {}),
      });
      organizedChanged();
      respond(true, { collection });
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.secure.collections.delete": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const res = organizer().deleteCollection(str(p.id));
      if (!res.ok) {
        respond(false, undefined, { code: "NOT_FOUND", message: "collection not found" });
        return;
      }
      organizedChanged();
      respond(true, res);
    } catch (err) {
      fail(respond, err);
    }
  },
};

export const FILES_OCR_READ_METHODS = [
  "files.context.get",
  "files.context.search",
  "files.context.list",
  "files.ocr.status",
  "files.secure.list",
  "files.secure.download",
  "files.secure.collections.list",
] as const;

export const FILES_OCR_WRITE_METHODS = [
  "files.ocr.rerun",
  "files.ocr.backfill",
  "files.inspect",
  "files.secure.upload",
  "files.secure.delete",
  "files.secure.update",
  "files.secure.bulkUpdate",
  "files.secure.collections.create",
  "files.secure.collections.rename",
  "files.secure.collections.delete",
] as const;

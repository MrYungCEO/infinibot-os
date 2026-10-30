import fs from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { getOcrService, laneForSession, resolveFilesRoot } from "../../ocr/runtime.js";
import { SecureFilesOps } from "../../ocr/secure-files-ops.js";
import { broadcastSecureLaneChanged } from "../../secure-mode/events.js";
import { getSecureModeRuntime } from "../../secure-mode/runtime.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  BATCH_MAX_FILES,
  capToolPayload,
  compactFileDigest,
  cut,
  readIdList,
} from "./file-digest.js";

const FileContextSchema = Type.Object({
  action: Type.Union([
    Type.Literal("search"),
    Type.Literal("get"),
    Type.Literal("inspect"),
    Type.Literal("list"),
    Type.Literal("rename"),
    Type.Literal("move"),
    Type.Literal("digest"),
  ]),
  newName: Type.Optional(
    Type.String({
      description:
        "rename: the new file name (normal lane keeps the extension if omitted; secure lane sets the display name)",
    }),
  ),
  folder: Type.Optional(
    Type.String({
      description:
        'move: target folder under the files root (normal lane) or collection name/id (secure lane; "root" = Unfiled)',
    }),
  ),
  query: Type.Optional(Type.String({ description: "search: words to find inside files" })),
  id: Type.Optional(
    Type.String({ description: "file id (f_… / s_…) from search, list or an attachment" }),
  ),
  ids: Type.Optional(
    Type.Array(Type.String(), {
      description: `get/digest: several file ids at once (up to ${BATCH_MAX_FILES}) — one call instead of one per file`,
    }),
  ),
  compact: Type.Optional(
    Type.Boolean({
      description:
        "get: short digest (description, entities, saved analyses, excerpt) instead of full text",
    }),
  ),
  refresh: Type.Optional(
    Type.Boolean({
      description:
        "inspect: look again with the vision model even if this question was already answered",
    }),
  ),
  path: Type.Optional(
    Type.String({ description: "Files-page path (relative to the files root) or absolute" }),
  ),
  question: Type.Optional(Type.String({ description: "inspect: what to look for in the image" })),
  page: Type.Optional(Type.Number({ description: "inspect: PDF page (1-based)" })),
  maxChars: Type.Optional(
    Type.Number({ description: "get: cap on returned text (default 20000)" }),
  ),
  limit: Type.Optional(Type.Number()),
});

/**
 * file_context — read what local auto-OCR extracted from uploaded files and
 * ask the local vision model about an image. Lane-bound: a Secure Mode
 * session sees only secure-lane files, a normal session only normal files.
 */
export function createFileContextTool(options: { agentSessionKey?: string } = {}): AnyAgentTool {
  return {
    label: "File Context",
    name: "file_context",
    description:
      "Uploaded files, images and videos (Files page, chat attachments, Documents, inbox media) are already OCR'd and described locally; results are SAVED, so reading them is instant. " +
      'To review many files, call action "digest" ONCE (saved description, entities, analyses and a short excerpt for every recent file, or for ids[]) — never one call per file. ' +
      '"get" returns one file\'s full saved text + description (or pass ids[] for several; compact:true for short digests). "search" finds files by CONTENT. "list" shows recent files and OCR status. ' +
      '"inspect" runs the GPU vision model on an image/PDF page (slow, 10–60 s): use it only when the saved description cannot answer a specific visual question; the same question returns the saved answer unless refresh:true. "rename" (newName) and "move" (folder) organise a file; they return the real resulting name/location — report only that.',
    parameters: FileContextSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", { required: true });
      const lane = laneForSession(options.agentSessionKey);
      if (lane === "secure" && !getSecureModeRuntime().isUnlocked()) {
        return jsonResult({ error: "Secure Mode is locked; secure files are unavailable." });
      }
      const svc = getOcrService();
      const rawPath = readStringParam(params, "path");
      const ref = {
        id: readStringParam(params, "id"),
        path: rawPath
          ? rawPath.startsWith("/")
            ? rawPath
            : `${resolveFilesRoot()}/${rawPath.replace(/^\.?\//, "")}`
          : undefined,
      };
      try {
        if (action === "search") {
          const query = readStringParam(params, "query", { required: true });
          return jsonResult(
            capToolPayload({
              lane,
              results: svc.search(lane, query, readNumberParam(params, "limit") ?? 10),
            }),
          );
        }
        if (action === "list") {
          const entries = svc
            .list(lane, { limit: readNumberParam(params, "limit") ?? 30 })
            .map((e) => ({
              id: e.id,
              name: e.name,
              path: e.path,
              status: e.status,
              error: e.error,
              summary: e.summary,
              pages: e.pages,
              confidence: e.confidence,
              source: e.source,
              updatedAt: new Date(e.updatedAt).toISOString(),
            }));
          return jsonResult(capToolPayload({ lane, entries }));
        }
        const ids = readIdList(params.ids);
        if (action === "digest" || (action === "get" && ids.length > 0)) {
          // Batch from saved sidecars only — no OCR/vision runs here.
          const entries = ids.length
            ? ids.map((id) => svc.find(lane, { id }) ?? id)
            : svc.list(lane, {
                limit: Math.min(BATCH_MAX_FILES, readNumberParam(params, "limit") ?? 30),
              });
          const n = Math.max(1, entries.length);
          const full = action === "get" && params.compact === false;
          const budget = Math.max(300, Math.floor((full ? 22_000 : 20_000) / n));
          const files = entries.map((e) => {
            if (typeof e === "string") return { id: e, found: false };
            const sc = svc.getContext(lane, { id: e.id })?.sidecar ?? null;
            const digest = compactFileDigest(e, sc, budget);
            return full
              ? { ...digest, text: cut(sc?.markdown, Math.floor(budget * 0.6)) ?? "" }
              : digest;
          });
          return jsonResult(
            capToolPayload({
              lane,
              count: files.length,
              files,
              note: "Saved local analyses (no model re-run). Use get with one id + maxChars for a file's full text.",
            }),
          );
        }
        if (!ref.id && !ref.path) return jsonResult({ error: "id or path is required" });
        if (action === "rename" || action === "move") {
          return jsonResult(
            organizeFile(
              lane,
              action,
              ref,
              readStringParam(params, "newName"),
              readStringParam(params, "folder"),
            ),
          );
        }
        if (action === "get" && params.compact === true) {
          const ctx = svc.getContext(lane, ref);
          if (!ctx) return jsonResult({ found: false });
          return jsonResult(
            capToolPayload({ found: true, ...compactFileDigest(ctx.entry, ctx.sidecar, 4000) }),
          );
        }
        if (action === "get") {
          const ctx = svc.getContext(lane, ref);
          if (!ctx) return jsonResult({ found: false });
          const max = Math.max(
            500,
            Math.min(readNumberParam(params, "maxChars") ?? 12_000, 20_000),
          );
          const sc = ctx.sidecar;
          const text = sc?.markdown ?? "";
          return jsonResult(
            capToolPayload({
              found: true,
              id: ctx.entry.id,
              name: ctx.entry.name,
              path: ctx.entry.path,
              status: ctx.entry.status,
              error: ctx.entry.error,
              source: ctx.entry.source,
              pageCount: sc?.pageCount ?? 0,
              confidence: sc?.confidence ?? null,
              engines: sc?.engines,
              description: sc?.description ?? null,
              entities: sc?.entities ?? [],
              text:
                text.length > max
                  ? `${text.slice(0, max)}\n[… truncated ${text.length - max} chars]`
                  : text,
              pages: (sc?.pages ?? []).map((p) => ({
                page: p.page,
                method: p.method,
                confidence: p.confidence,
                chars: p.text.length,
              })),
              warnings: sc?.warnings ?? [],
              // Saved analyses, compact (the raw analyzer payloads can be huge).
              analyses: (sc?.analyses ?? []).map((a) => ({
                id: a.id,
                analyzer: a.analyzer,
                agentId: a.agentId,
                model: a.model,
                createdAt: new Date(a.createdAt).toISOString(),
                summary: cut(a.summary, 1500),
              })),
              ...(sc?.video !== undefined
                ? {
                    video:
                      "saved video analysis available — use video_analysis get for keyframes/transcript",
                  }
                : {}),
            }),
          );
        }
        if (action === "inspect") {
          const question = readStringParam(params, "question", { required: true });
          const res = await svc.inspect(lane, ref, question, {
            page: readNumberParam(params, "page"),
            refresh: params.refresh === true,
          });
          return jsonResult(capToolPayload(res as Record<string, unknown>));
        }
        return jsonResult({ error: `unknown action ${action}` });
      } catch (err) {
        return jsonResult({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

/** Rename / move one file in the session's lane; returns the state after the change. */
function organizeFile(
  lane: "normal" | "secure",
  action: "rename" | "move",
  ref: { id?: string; path?: string },
  newName: string | undefined,
  folder: string | undefined,
): Record<string, unknown> {
  if (action === "rename" && !newName?.trim())
    return { ok: false, status: "error", error: "newName is required" };
  if (action === "move" && folder === undefined)
    return { ok: false, status: "error", error: "folder is required" };
  if (lane === "secure") {
    const ops = new SecureFilesOps(getSecureModeRuntime().requireVault(), getOcrService());
    const file = ref.id ?? (ref.path ? path.basename(ref.path) : "");
    const res =
      action === "rename"
        ? ops.update([file], { name: newName!.trim() })
        : ops.update([file], { collection: folder!, createCollection: true });
    broadcastSecureLaneChanged("files");
    return { ok: true, lane, ...res };
  }
  const root = path.resolve(resolveFilesRoot());
  const entry = ref.id ? getOcrService().find("normal", { id: ref.id }) : null;
  const src = path.resolve(entry?.path ?? ref.path ?? "");
  if (!src.startsWith(root + path.sep))
    return {
      ok: false,
      status: "error",
      error: "only files under the files root can be renamed or moved",
    };
  if (!fs.existsSync(src) || !fs.statSync(src).isFile())
    return { ok: false, status: "error", error: "file not found" };
  let dest: string;
  if (action === "rename") {
    let base = newName!.trim();
    if (/[\\/]/.test(base) || base === "." || base === "..")
      return {
        ok: false,
        status: "error",
        error: "newName must be a plain file name (use move for folders)",
      };
    if (!path.extname(base)) base += path.extname(src);
    dest = path.join(path.dirname(src), base);
  } else {
    const dir = path.resolve(root, folder!.replace(/^\/+/, ""));
    if (dir !== root && !dir.startsWith(root + path.sep))
      return { ok: false, status: "error", error: "folder escapes the files root" };
    dest = path.join(dir, path.basename(src));
  }
  if (dest === src) return { ok: true, lane, changed: 0, path: path.relative(root, src) };
  if (fs.existsSync(dest))
    return { ok: false, status: "error", error: `${path.relative(root, dest)} already exists` };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  try {
    getOcrService().moved(src, dest);
  } catch {
    /* OCR bookkeeping must not fail the rename */
  }
  return {
    ok: fs.existsSync(dest),
    lane,
    changed: 1,
    from: path.relative(root, src),
    path: path.relative(root, dest),
  };
}

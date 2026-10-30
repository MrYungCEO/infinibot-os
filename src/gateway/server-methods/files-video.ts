/**
 * Video analysis RPCs (Files page video detail, chat attachments, agents).
 *
 *   files.video.get              { id | path | sha256, secure? } → entry, video block, analyses, jobs
 *   files.video.process          { id | path, secure? }          → queue (or re-queue) processing
 *   files.video.analysts         {}                              → analyst picker options
 *   files.video.analysts.create  { name, focus }                 → new analyst persona agent
 *   files.video.analyze          { ref…, agentIds[], instructions?, secure? }
 *   files.video.ask              { ref…, question, analysisId? | agentId?, times?, secure? }
 *   files.video.frame            { ref…, frame, secure? }        → JPEG (base64)
 *   files.video.media            { ref…, offset?, secure? }      → playback proxy chunk (base64)
 *
 * `secure: true` selects the Secure Mode lane and fails closed while locked.
 */
import fs from "node:fs";
import path from "node:path";
import {
  createAnalystAgent,
  listAnalystOptions,
  ANALYST_TEMPLATES,
} from "../../media/video-analysis/personas.js";
import { getFrameStore, getVideoAnalysisService } from "../../media/video-analysis/runtime.js";
import { videoBlockOf } from "../../media/video-analysis/pipeline.js";
import { isVideoEntry, videoAnalysesOf } from "../../media/video-analysis/service.js";
import { frameKeyFor, mimeForFrame } from "../../media/video-analysis/frame-store.js";
import { parseTimecode } from "../../media/video-analysis/sampling.js";
import { getOcrService, resolveFilesRoot } from "../../ocr/runtime.js";
import type { OcrRef } from "../../ocr/service.js";
import type { OcrLane } from "../../ocr/types.js";
import { getSecureModeRuntime } from "../../secure-mode/runtime.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

type Respond = GatewayRequestHandlerOptions["respond"];

class LockedError extends Error {}

function fail(respond: Respond, err: unknown, code = "INTERNAL_ERROR") {
  const message = err instanceof Error ? err.message : String(err);
  respond(false, undefined, {
    code:
      err instanceof LockedError || /Secure Mode is locked/.test(message)
        ? "SECURE_MODE_LOCKED"
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

function absOf(rel: string): string | undefined {
  if (!rel) return undefined;
  const root = path.resolve(resolveFilesRoot());
  const abs = path.isAbsolute(rel) ? rel : path.resolve(root, rel);
  if (!path.isAbsolute(rel) && !abs.startsWith(root))
    throw new Error("path escapes the files root");
  return abs;
}

function refOf(p: Record<string, unknown>): OcrRef {
  return {
    id: str(p.id) || undefined,
    path: absOf(str(p.path)),
    sha256: str(p.sha256) || undefined,
  };
}

function relPath(abs: string | null): string | null {
  if (!abs) return null;
  const root = path.resolve(resolveFilesRoot());
  return abs.startsWith(root + path.sep) ? path.relative(root, abs).replace(/\\/g, "/") : abs;
}

const MEDIA_CHUNK = 4 * 1024 * 1024;
const FRAME_NAME = /^[a-z0-9][a-z0-9._-]{0,60}$/i;

export const filesVideoHandlers: GatewayRequestHandlers = {
  "files.video.get": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const lane = laneOf(p);
      const ctx = getOcrService().getContext(lane, refOf(p));
      if (!ctx || !isVideoEntry(ctx.entry)) {
        respond(true, { found: false });
        return;
      }
      const { sidecarPath: _s, ...entry } = ctx.entry;
      const sc = ctx.sidecar;
      respond(true, {
        found: true,
        lane,
        entry: { ...entry, relPath: relPath(ctx.entry.path) },
        video: videoBlockOf(sc),
        description: sc?.description ?? null,
        entities: sc?.entities ?? [],
        warnings: sc?.warnings ?? [],
        analyses: videoAnalysesOf(sc),
        jobs: getVideoAnalysisService()
          .jobsFor(lane, ctx.entry.id)
          .map((j) => ({
            id: j.id,
            kind: j.kind,
            agentId: j.agentId,
            analysisId: j.analysisId,
            status: j.status,
            error: j.error,
          })),
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.video.process": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const lane = laneOf(p);
      const svc = getOcrService();
      const ref = refOf(p);
      const existing = svc.find(lane, ref);
      if (existing) {
        if (!isVideoEntry(existing)) throw new Error("not a video file");
        const force = p.force === true || existing.status === "failed";
        respond(true, { entry: force ? svc.rerun(lane, ref) : existing });
        return;
      }
      if (lane === "secure" || !ref.path) throw new Error("video not found");
      if (!fs.existsSync(ref.path)) throw new Error("file not found");
      const entry = svc.enqueuePath({
        absPath: ref.path,
        source: { kind: "files", projectId: str(p.projectId) || undefined },
        priority: 5,
      });
      if (!entry) throw new Error("unsupported video type");
      respond(true, { entry });
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.video.analysts": async ({ respond }) => {
    try {
      respond(true, {
        analysts: listAnalystOptions(),
        templates: ANALYST_TEMPLATES.map(({ id, name, tagline, icon }) => ({
          id,
          name,
          tagline,
          icon,
        })),
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.video.analysts.create": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const r = await createAnalystAgent({ name: str(p.name), focus: str(p.focus) });
      respond(true, r);
    } catch (err) {
      fail(respond, err, "INVALID_REQUEST");
    }
  },

  "files.video.analyze": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const lane = laneOf(p);
      const agentIds = Array.isArray(p.agentIds) ? p.agentIds.map(String) : [str(p.agentId)];
      const analyses = await getVideoAnalysisService().requestAnalysis({
        lane,
        ref: refOf(p),
        agentIds,
        instructions: str(p.instructions) || undefined,
        // A person pressed Analyze: always run (agent tools reuse saved analyses).
        refresh: true,
      });
      respond(true, { analyses });
    } catch (err) {
      fail(respond, err, "INVALID_REQUEST");
    }
  },

  "files.video.ask": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const lane = laneOf(p);
      const times = Array.isArray(p.times)
        ? p.times
            .map((t) => (typeof t === "number" ? t : parseTimecode(String(t))))
            .filter((t): t is number => t !== null && Number.isFinite(t))
        : undefined;
      const r = getVideoAnalysisService().requestFollowUp({
        lane,
        ref: refOf(p),
        analysisId: str(p.analysisId) || undefined,
        agentId: str(p.agentId) || undefined,
        question: str(p.question),
        times,
        refresh: true,
      });
      respond(true, r);
    } catch (err) {
      fail(respond, err, "INVALID_REQUEST");
    }
  },

  "files.video.frame": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const lane = laneOf(p);
      const name = str(p.frame);
      if (!FRAME_NAME.test(name) || name.endsWith(".mp4")) throw new Error("bad frame name");
      const entry = getOcrService().find(lane, refOf(p));
      if (!entry || !isVideoEntry(entry)) throw new Error("video not found");
      const buf = getFrameStore(lane).get(frameKeyFor(entry.sha256), name);
      if (!buf) {
        respond(true, { found: false });
        return;
      }
      respond(true, { found: true, mime: mimeForFrame(name), content: buf.toString("base64") });
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.video.media": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as Record<string, unknown>;
      const lane = laneOf(p);
      const entry = getOcrService().find(lane, refOf(p));
      if (!entry || !isVideoEntry(entry)) throw new Error("video not found");
      const buf = getFrameStore(lane).get(frameKeyFor(entry.sha256), "proxy.mp4");
      if (!buf) {
        respond(true, { found: false });
        return;
      }
      const offset = Math.max(0, Math.floor(Number(p.offset) || 0));
      const slice = buf.subarray(offset, offset + MEDIA_CHUNK);
      respond(true, {
        found: true,
        mime: "video/mp4",
        size: buf.length,
        offset,
        done: offset + slice.length >= buf.length,
        content: slice.toString("base64"),
      });
      if (lane === "secure") buf.fill(0);
    } catch (err) {
      fail(respond, err);
    }
  },
};

export const FILES_VIDEO_READ_METHODS = [
  "files.video.get",
  "files.video.analysts",
  "files.video.frame",
  "files.video.media",
] as const;

export const FILES_VIDEO_WRITE_METHODS = [
  "files.video.process",
  "files.video.analysts.create",
  "files.video.analyze",
  "files.video.ask",
] as const;

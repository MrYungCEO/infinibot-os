/**
 * Gateway Methods — Native video editor compositions.
 *
 * RPCs for the Compositions store. The UI's video editor view is the
 * primary consumer; agent tooling can also reach these to author timelines
 * programmatically.
 */

import { existsSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { resolveStateDir } from "../../config/paths.js";
import { getCompositionsStore } from "../../compositions/store.js";
type CompositionRenderModule = typeof import("../../compositions/render.js");

let compositionRenderModulePromise: Promise<CompositionRenderModule> | null = null;

async function loadCompositionRenderModule(): Promise<CompositionRenderModule> {
  if (!compositionRenderModulePromise) {
    compositionRenderModulePromise = import("../../compositions/render.js");
  }
  return compositionRenderModulePromise;
}
import {
  addAsset,
  assetsDir,
  assetPublicUrl,
  ensureProjectDir,
  findAsset,
  listAssets,
  projectDir,
  removeAsset,
  removeProjectDir,
  taskPath,
  updateAssetMetadata,
  type AssetKind,
  type AssetMetadata,
} from "../../compositions/project-dir.js";
import { transcribeMedia } from "../../compositions/transcribe.js";
import { CAPTION_PRESETS, findCaptionPreset } from "../../compositions/caption-presets.js";
import {
  listAllBlocks as listBlocks,
  getBlock,
  createBlock as createBlockDef,
  updateBlockById as updateBlockDef,
  deleteBlockById as deleteBlockDef,
} from "../../compositions/blocks/store.js";
import type {
  ClipKind,
  ClipProps,
  CaptionsClipProps,
  TrackKind,
} from "../../compositions/types.js";
import type { GatewayRequestHandlers } from "./types.js";

function store() {
  return getCompositionsStore(resolveStateDir());
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Pull the children of `#stage-zoom-container` out of a full
 * generateHyperframesHtml() output. We use a depth-counted string scan
 * (not a DOM parser) because the doc is internally generated and
 * structurally stable, and we want zero parser dependencies on the
 * gateway path.
 *
 * Failure mode: if the generator ever changes its envelope we return
 * `""` rather than throw — the editor stage simply looks empty, which
 * is a recoverable UX hit (re-render the editor), not a crash.
 */
export function extractElementsHtml(fullDoc: string): string {
  const openMarker = `id="stage-zoom-container"`;
  const openIdx = fullDoc.indexOf(openMarker);
  if (openIdx === -1) return "";
  const tagClose = fullDoc.indexOf(">", openIdx);
  if (tagClose === -1) return "";
  // Walk forward counting <div openers vs </div> closers until depth
  // returns to zero — that's the matching close for the zoom container.
  let depth = 1;
  let i = tagClose + 1;
  const len = fullDoc.length;
  while (i < len && depth > 0) {
    const nextOpen = fullDoc.indexOf("<div", i);
    const nextClose = fullDoc.indexOf("</div>", i);
    if (nextClose === -1) return "";
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      i = fullDoc.indexOf(">", nextOpen);
      if (i === -1) return "";
      i += 1;
    } else {
      depth -= 1;
      if (depth === 0) {
        return fullDoc.slice(tagClose + 1, nextClose).trim();
      }
      i = nextClose + "</div>".length;
    }
  }
  return "";
}

export const compositionsHandlers: GatewayRequestHandlers = {
  "compositions.list": async ({ respond }) => {
    try {
      respond(true, { compositions: store().list() });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.get": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      const slug = asStr(params.slug);
      if (!id && !slug) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id or slug required" });
        return;
      }
      const s = store();
      const comp = id
        ? s.getWithChildren(id)
        : (() => {
            const byslug = s.getBySlug(slug!);
            return byslug ? s.getWithChildren(byslug.id) : null;
          })();
      if (!comp) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Composition ${id ?? slug} not found`,
        });
        return;
      }
      respond(true, { composition: comp });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.create": async ({ respond, params }) => {
    try {
      const name = asStr(params.name);
      if (!name) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "name required" });
        return;
      }
      const comp = store().create({
        name,
        slug: asStr(params.slug),
        widthPx: asNum(params.widthPx),
        heightPx: asNum(params.heightPx),
        fps: asNum(params.fps),
        durationSec: asNum(params.durationSec),
        bgColor: asStr(params.bgColor),
        meta: (params.meta as Record<string, unknown>) ?? {},
      });
      // Spin up the per-composition project directory so the embedded
      // Claude TUI has a real working dir + the asset metadata index is
      // ready before the first upload.
      try {
        ensureProjectDir(comp.id, comp.name);
      } catch {
        // Project dir creation is best-effort — never fail composition
        // create on a filesystem hiccup.
      }
      // Register in /apps catalog.
      try {
        const { autoRegister } = await import("../../apps/store.js");
        autoRegister(resolveStateDir(), {
          sourceKind: "composition",
          sourceId: comp.id,
          name: comp.name,
          description: "Video composition",
          type: "composition",
          meta: { widthPx: comp.widthPx, heightPx: comp.heightPx, fps: comp.fps },
        });
      } catch {
        /* swallow */
      }
      respond(true, { composition: comp, projectDir: projectDir(comp.id) });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.update": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      const patch: Record<string, unknown> = {};
      if (params.name !== undefined) patch.name = params.name;
      if (params.widthPx !== undefined) patch.widthPx = params.widthPx;
      if (params.heightPx !== undefined) patch.heightPx = params.heightPx;
      if (params.fps !== undefined) patch.fps = params.fps;
      if (params.durationSec !== undefined) patch.durationSec = params.durationSec;
      if (params.bgColor !== undefined) patch.bgColor = params.bgColor;
      if (params.meta !== undefined) patch.meta = params.meta;
      const comp = store().update(id, patch as Parameters<ReturnType<typeof store>["update"]>[1]);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      respond(true, { composition: comp });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.delete": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      const deleted = store().delete(id);
      try {
        removeProjectDir(id);
      } catch {
        /* swallow */
      }
      respond(true, { deleted });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.tracks.create": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const kind = asStr(params.kind) as TrackKind | undefined;
      if (!compositionId || !kind) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId and kind required",
        });
        return;
      }
      const track = store().createTrack({
        compositionId,
        kind,
        name: asStr(params.name),
        sortOrder: asNum(params.sortOrder),
      });
      respond(true, { track });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.tracks.update": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      const patch: Record<string, unknown> = {};
      if (params.name !== undefined) patch.name = params.name;
      if (params.kind !== undefined) patch.kind = params.kind;
      if (params.sortOrder !== undefined) patch.sortOrder = params.sortOrder;
      if (params.muted !== undefined) patch.muted = asBool(params.muted) ?? false;
      if (params.locked !== undefined) patch.locked = asBool(params.locked) ?? false;
      if (params.hidden !== undefined) patch.hidden = asBool(params.hidden) ?? false;
      const track = store().updateTrack(
        id,
        patch as Parameters<ReturnType<typeof store>["updateTrack"]>[1],
      );
      if (!track) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Track ${id} not found` });
        return;
      }
      respond(true, { track });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.tracks.delete": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      respond(true, { deleted: store().deleteTrack(id) });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.clips.create": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const trackId = asStr(params.trackId);
      const kind = asStr(params.kind) as ClipKind | undefined;
      const startSec = asNum(params.startSec);
      const durationSec = asNum(params.durationSec);
      if (
        !compositionId ||
        !trackId ||
        !kind ||
        startSec === undefined ||
        durationSec === undefined
      ) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId, trackId, kind, startSec, durationSec required",
        });
        return;
      }
      const clip = store().createClip({
        compositionId,
        trackId,
        kind,
        label: asStr(params.label),
        startSec,
        durationSec,
        z: asNum(params.z),
        props: (params.props as ClipProps) ?? ({} as ClipProps),
      });
      respond(true, { clip });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.clips.update": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      const patch: Record<string, unknown> = {};
      if (params.trackId !== undefined) patch.trackId = params.trackId;
      if (params.kind !== undefined) patch.kind = params.kind;
      if (params.label !== undefined) patch.label = params.label;
      if (params.startSec !== undefined) patch.startSec = params.startSec;
      if (params.durationSec !== undefined) patch.durationSec = params.durationSec;
      if (params.z !== undefined) patch.z = params.z;
      if (params.props !== undefined) patch.props = params.props;
      // Hard-cap durationSec for video/audio clips to the source media's
      // natural length (minus the post-patch trimStart). Frontend already
      // clamps but the agent + RPC clients also need the guard rail.
      if (patch.durationSec !== undefined && typeof patch.durationSec === "number") {
        const existing = store().getClip(id);
        if (existing && (existing.kind === "video" || existing.kind === "audio")) {
          const mergedProps = {
            ...((existing.props ?? {}) as unknown as Record<string, unknown>),
            ...((patch.props as Record<string, unknown>) ?? {}),
          };
          const sourceDur =
            typeof mergedProps.sourceDurationSec === "number"
              ? mergedProps.sourceDurationSec
              : undefined;
          const trim = typeof mergedProps.trimStart === "number" ? mergedProps.trimStart : 0;
          if (sourceDur && sourceDur > 0) {
            const cap = Math.max(0.1, sourceDur - trim);
            if (patch.durationSec > cap) patch.durationSec = cap;
          }
        }
      }
      const clip = store().updateClip(
        id,
        patch as Parameters<ReturnType<typeof store>["updateClip"]>[1],
      );
      if (!clip) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Clip ${id} not found` });
        return;
      }
      respond(true, { clip });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.clips.delete": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      respond(true, { deleted: store().deleteClip(id) });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  // ── Render ────────────────────────────────────────────────────

  /**
   * Translate a composition through the hyperframes translator and
   * return the generated HTML directly. Used by the video editor's
   * "Preview HF" button — the UI opens a Blob URL of the HTML in a new
   * window so the operator can see what hyperframes will actually
   * render, without kicking off a full export.
   */
  "compositions.preview.html": async ({ respond, params }) => {
    try {
      const id = asStr(params.compositionId) ?? asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const comp = store().getWithChildren(id);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      const { compositionToHyperframes } =
        await import("../../compositions/hyperframes-translator.js");
      const { buildRenderHtml } = await import("../../compositions/render.js");
      const t = compositionToHyperframes(comp);
      const html = buildRenderHtml(comp);
      respond(true, {
        compositionId: comp.id,
        elementCount: t.elements.length,
        totalDuration: t.totalDuration,
        resolution: t.options.resolution,
        html,
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Parts-mode preview — same hyperframes render pipeline as
   * `compositions.preview.html`, but split into the minimum pieces the
   * editor needs to mount the runtime *inline* in the parent DOM (no
   * iframe). The UI's <hyperframes-stage> element wires these in so
   * every clip becomes an addressable `#${clip.id}` DOM node and the
   * `ui_control` agent can `querySelector` / `click_selector` scene
   * elements directly. We re-use the existing translator + generator —
   * no parallel pipeline — so what you see live in the editor is bit-
   * identical to what the producer renders at export time.
   */
  "compositions.preview.parts": async ({ respond, params }) => {
    try {
      const id = asStr(params.compositionId) ?? asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const comp = store().getWithChildren(id);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      const { compositionToHyperframes } =
        await import("../../compositions/hyperframes-translator.js");
      const { generateHyperframesHtml, generateHyperframesStyles, generateGsapTimelineScript } =
        await import("@hyperframes/core");
      const t = compositionToHyperframes(comp);
      const sortedElements = [...t.elements].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
      // Reuse generateHyperframesHtml to produce the elements markup,
      // then slice out the `#stage-zoom-container` body. This keeps the
      // single source of truth for element HTML inside @hyperframes/core
      // (instead of forking a parallel generator) — the inline mount and
      // the export render therefore stay bit-identical.
      const fullDoc = generateHyperframesHtml(sortedElements, t.totalDuration, {
        ...t.options,
        includeScripts: false,
        includeStyles: false,
      });
      const elementsHtml = extractElementsHtml(fullDoc);
      const { coreCss, customCss, googleFontsLink } = generateHyperframesStyles(
        sortedElements,
        t.options.resolution ?? "landscape",
        t.options.styles ?? "",
      );
      const gsapTimelineScript = generateGsapTimelineScript(sortedElements, t.totalDuration, {
        animations: t.options.animations,
        generateDefaultAnimations: t.options.generateDefaultAnimations ?? true,
        resolution: t.options.resolution,
        keyframes: t.options.keyframes,
        stageZoomKeyframes: t.options.stageZoomKeyframes,
      });
      respond(true, {
        compositionId: comp.id,
        elementCount: sortedElements.length,
        totalDuration: t.totalDuration,
        resolution: t.options.resolution ?? "landscape",
        widthPx: t.widthPx,
        heightPx: t.heightPx,
        bgColor: t.bgColor,
        fps: t.fps,
        rev: comp.updatedAt ?? 0,
        elementsHtml,
        coreCss,
        customCss,
        googleFontsLink,
        gsapTimelineScript,
        stageZoomKeyframes: t.options.stageZoomKeyframes ?? null,
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.render.start": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      if (!compositionId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const { startRender } = await loadCompositionRenderModule();
      const job = await startRender({
        compositionId,
        fps: asNum(params.fps),
        format: asStr(params.format) === "webm" ? "webm" : "mp4",
      });
      respond(true, {
        job: {
          id: job.id,
          compositionId: job.compositionId,
          status: job.status,
          progress: job.progress,
          frame: job.frame,
          totalFrames: job.totalFrames,
          startedAt: job.startedAt,
        },
      });
    } catch (e) {
      respond(false, undefined, {
        code: "RENDER_FAILED",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.render.status": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      const { getJob: getRenderJob } = await loadCompositionRenderModule();
      const job = getRenderJob(id);
      if (!job) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Job ${id} not found` });
        return;
      }
      respond(true, {
        job: {
          id: job.id,
          compositionId: job.compositionId,
          status: job.status,
          progress: job.progress,
          frame: job.frame,
          totalFrames: job.totalFrames,
          startedAt: job.startedAt,
          endedAt: job.endedAt,
          outputUrl: job.outputUrl,
          error: job.error,
          transitions: job.transitions ?? null,
        },
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.render.list": async ({ respond }) => {
    try {
      respond(true, {
        jobs: (await loadCompositionRenderModule()).listJobs().map((j) => ({
          id: j.id,
          compositionId: j.compositionId,
          status: j.status,
          progress: j.progress,
          frame: j.frame,
          totalFrames: j.totalFrames,
          startedAt: j.startedAt,
          endedAt: j.endedAt,
          outputUrl: j.outputUrl,
          error: j.error,
        })),
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.render.cancel": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      const { cancelJob: cancelRenderJob } = await loadCompositionRenderModule();
      respond(true, { cancelled: cancelRenderJob(id) });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  // Live render preview — returns the most recent in-flight frame as a
  // JPEG data URL. UI polls this every ~1.5s alongside compositions.
  // render.status so the operator sees the render assembling rather than
  // just a progress bar. NO_PREVIEW if the job hasn't taken its first
  // screenshot yet (still in "preparing").
  "compositions.render.preview": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      const { getJob: getRenderJob } = await loadCompositionRenderModule();
      const job = getRenderJob(id);
      if (!job) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Job ${id} not found` });
        return;
      }
      if (!job.latestPreviewJpeg) {
        respond(false, undefined, { code: "NO_PREVIEW", message: "preview not yet available" });
        return;
      }
      respond(true, {
        jobId: job.id,
        frame: job.latestPreviewFrame ?? job.frame,
        totalFrames: job.totalFrames,
        progress: job.progress,
        status: job.status,
        dataUrl: `data:image/jpeg;base64,${job.latestPreviewJpeg.toString("base64")}`,
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  // ── Assets — per-composition. Stored under
  //    ~/.infinibot/media/compositions/<compId>/assets/  and indexed by
  //    metadata.json in the same project dir. The editor agent reads
  //    metadata.json to make context-aware placement decisions. ────────

  "compositions.assets.upload": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const name = asStr(params.name);
      const content = asStr(params.content);
      const missing: string[] = [];
      if (!compositionId) missing.push("compositionId");
      if (!name) missing.push("name");
      if (!content) missing.push("content (base64)");
      if (!compositionId || !name || !content) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: `Asset upload missing: ${missing.join(", ")}`,
        });
        return;
      }
      // Make sure the project dir exists even if compositions.create wasn't
      // the entry point (e.g. legacy compositions seeded before this feature).
      const comp = store().get(compositionId);
      if (!comp) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Composition ${compositionId} not found`,
        });
        return;
      }
      ensureProjectDir(comp.id, comp.name);

      const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "_");
      const filename = `${Date.now()}-${randomUUID().slice(0, 6)}-${safe}`;
      const filePath = join(assetsDir(compositionId), filename);
      writeFileSync(filePath, Buffer.from(content, "base64"));
      const stat = statSync(filePath);

      const ext = (name.split(".").pop() ?? "").toLowerCase();
      const kind: AssetKind = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)
        ? "image"
        : ["mp4", "mov", "webm", "mkv", "avi"].includes(ext)
          ? "video"
          : ["mp3", "wav", "flac", "ogg", "m4a", "aac"].includes(ext)
            ? "audio"
            : "other";

      // Optional client-side enrichment (width/height/duration) — caller
      // can pass a `probe` object from the browser File API.
      const probe = (params.probe as Partial<AssetMetadata> | undefined) ?? {};

      const meta: AssetMetadata = {
        filename,
        name,
        url: assetPublicUrl(compositionId, filename),
        kind,
        size: stat.size,
        uploadedAt: stat.mtimeMs,
        mime: asStr(params.mime),
        width: typeof probe.width === "number" ? probe.width : undefined,
        height: typeof probe.height === "number" ? probe.height : undefined,
        durationSec: typeof probe.durationSec === "number" ? probe.durationSec : undefined,
      };
      addAsset(compositionId, meta);

      respond(true, { asset: meta });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.assets.list": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      if (!compositionId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      respond(true, { assets: listAssets(compositionId) });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.assets.delete": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const filename = asStr(params.filename);
      if (!compositionId || !filename) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId and filename required",
        });
        return;
      }
      if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "invalid filename" });
        return;
      }
      respond(true, { deleted: removeAsset(compositionId, filename) });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Patch the asset metadata index — typically called by the editor agent
   * to populate `description`, `tags`, `mood`, `colorPalette`, etc. so it
   * can make smarter placement decisions on the next pass.
   */
  "compositions.assets.updateMetadata": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const filename = asStr(params.filename);
      if (!compositionId || !filename) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId and filename required",
        });
        return;
      }
      const patch = (params.patch as Partial<AssetMetadata> | undefined) ?? {};
      const updated = updateAssetMetadata(compositionId, filename, patch);
      if (!updated) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Asset ${filename} not found` });
        return;
      }
      respond(true, { asset: updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Run the AI analyzer on an asset and persist the metadata it returns.
   * Routes through `analyzeAsset()` which prefers the `claude-video`
   * upstream skill (https://github.com/bradautomates/claude-video) when
   * CLAUDE_VIDEO_BIN is wired up, and falls back to Anthropic vision
   * when it isn't. The merged AssetMetadata is broadcast back to the UI
   * so the asset card can render the new fields immediately.
   */
  "compositions.assets.analyze": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const filename = asStr(params.filename);
      if (!compositionId || !filename) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId and filename required",
        });
        return;
      }
      const asset = findAsset(compositionId, filename);
      if (!asset) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Asset ${filename} not found` });
        return;
      }
      const filePath = join(assetsDir(compositionId), filename);
      const { analyzeAsset } = await import("../../compositions/asset-analyzer.js");
      const result = await analyzeAsset({ filePath, asset });
      const updated = updateAssetMetadata(compositionId, filename, {
        description: result.description || asset.description,
        tags: result.tags?.length ? result.tags : asset.tags,
        mood: result.mood ?? asset.mood,
        scene: result.scene ?? asset.scene,
        colorPalette: result.colorPalette ?? asset.colorPalette,
        energy: result.energy ?? asset.energy,
        suggestedUses: result.suggestedUses ?? asset.suggestedUses,
        transcript: result.transcript ?? asset.transcript,
        notes: result.notes ?? asset.notes,
      });
      respond(true, { asset: updated, via: result.via });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Look up a single asset's metadata by filename — handy for the editor
   * UI when it needs the agent-populated context for an already-placed
   * clip.
   */
  "compositions.assets.get": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const filename = asStr(params.filename);
      if (!compositionId || !filename) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId and filename required",
        });
        return;
      }
      const asset = findAsset(compositionId, filename);
      if (!asset) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Asset ${filename} not found` });
        return;
      }
      respond(true, { asset });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Read the project's style context — populated by the operator either
   * by dropping a reference video into the editor's Style slot (which
   * runs the `claude-video`/`/watch` skill via `analyzeAsset`) or by
   * the AI motion designer agent after it picks a direction. The motion
   * presets, template gallery filter chips, and agent prompt all read
   * this. Returns `{ style: null }` for compositions that have no style
   * set yet — never throws.
   */
  "compositions.style.get": async ({ respond, params }) => {
    try {
      const id = asStr(params.compositionId) ?? asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const comp = store().get(id);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      const meta = (comp.meta ?? {}) as Record<string, unknown>;
      const style = (meta.style as Record<string, unknown> | undefined) ?? null;
      respond(true, { style });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Set (or replace) the project style. Accepts the same shape
   * `analyzeAsset` returns plus optional `referenceFilename` so the UI
   * knows which asset the analysis came from. We merge into existing
   * `comp.meta.style` rather than overwrite so the agent and the
   * operator can each contribute partial fields without stomping each
   * other.
   */
  "compositions.style.set": async ({ respond, params }) => {
    try {
      const id = asStr(params.compositionId) ?? asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const incoming = (params.style as Record<string, unknown> | undefined) ?? {};
      const comp = store().get(id);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      const meta = { ...comp.meta } as Record<string, unknown>;
      const prev = (meta.style as Record<string, unknown> | undefined) ?? {};
      meta.style = { ...prev, ...incoming, updatedAt: Date.now() };
      const updated = store().update(id, { meta });
      respond(true, { style: meta.style, composition: updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Drop the project style entirely. Useful when an operator wants the
   * template gallery's "filter by style" chips to clear without picking
   * a new reference video.
   */
  "compositions.style.clear": async ({ respond, params }) => {
    try {
      const id = asStr(params.compositionId) ?? asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const comp = store().get(id);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      const meta = { ...comp.meta } as Record<string, unknown>;
      delete meta.style;
      const updated = store().update(id, { meta });
      respond(true, { composition: updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Convenience RPC: run the watch-skill against an existing asset and
   * write the result to `comp.meta.style` in one round-trip. Equivalent
   * to `compositions.assets.analyze` followed by `compositions.style.set`,
   * but the UI's Style Reference slot drops a single button on this so
   * the operator doesn't have to chain calls.
   */
  "compositions.style.fromAsset": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const filename = asStr(params.filename);
      if (!compositionId || !filename) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId and filename required",
        });
        return;
      }
      const asset = findAsset(compositionId, filename);
      if (!asset) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Asset ${filename} not found` });
        return;
      }
      const comp = store().get(compositionId);
      if (!comp) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Composition ${compositionId} not found`,
        });
        return;
      }
      const filePath = join(assetsDir(compositionId), filename);
      const { analyzeAsset } = await import("../../compositions/asset-analyzer.js");
      const result = await analyzeAsset({ filePath, asset });
      const meta = { ...comp.meta } as Record<string, unknown>;
      meta.style = {
        description: result.description,
        tags: result.tags ?? [],
        mood: result.mood,
        scene: result.scene,
        colorPalette: result.colorPalette ?? [],
        energy: result.energy,
        suggestedUses: result.suggestedUses ?? [],
        transcript: result.transcript,
        notes: result.notes,
        via: result.via,
        referenceFilename: filename,
        updatedAt: Date.now(),
      };
      const updated = store().update(compositionId, { meta });
      respond(true, { style: meta.style, composition: updated, via: result.via });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Read the composition's variable declarations + currently-bound
   * values. Variables are stored under `comp.meta.variables` (typed
   * declarations: id / type / label / default / type-specific options)
   * and `comp.meta.variableValues` (the current bindings). The
   * translator's `resolveProps` substitutes `{{id}}` patterns and
   * `{$var: id}` bindings on every clip's props using this pair, so the
   * agent and the operator both see the same render.
   */
  "compositions.variables.list": async ({ respond, params }) => {
    try {
      const id = asStr(params.compositionId) ?? asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const comp = store().get(id);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      const meta = (comp.meta ?? {}) as Record<string, unknown>;
      respond(true, {
        variables: Array.isArray(meta.variables) ? meta.variables : [],
        values: (meta.variableValues as Record<string, unknown>) ?? {},
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Create or replace a variable declaration. The caller passes the
   * full variable object (`{id, type, label, default, ...}`); we merge
   * by id so a second upsert with the same id replaces the previous
   * decl instead of appending a duplicate. Templates use this on save
   * to capture every variable the composition declares.
   */
  "compositions.variables.upsert": async ({ respond, params }) => {
    try {
      const id = asStr(params.compositionId);
      const variable = params.variable as Record<string, unknown> | undefined;
      if (
        !id ||
        !variable ||
        typeof variable.id !== "string" ||
        typeof variable.type !== "string"
      ) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId + variable{id, type, ...} required",
        });
        return;
      }
      const comp = store().get(id);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      const meta = { ...comp.meta } as Record<string, unknown>;
      const list = Array.isArray(meta.variables)
        ? [...(meta.variables as Record<string, unknown>[])]
        : [];
      const idx = list.findIndex((v) => v.id === variable.id);
      if (idx >= 0) list[idx] = variable;
      else list.push(variable);
      meta.variables = list;
      const updated = store().update(id, { meta });
      respond(true, { variables: meta.variables, composition: updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Remove a variable declaration AND drop its bound value. We don't
   * scan clip props for `{{id}}` references — the translator will
   * render those literally as `{{id}}` once the decl is gone, which is
   * the correct "this is unbound" signal.
   */
  "compositions.variables.delete": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const variableId = asStr(params.variableId);
      if (!compositionId || !variableId) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId + variableId required",
        });
        return;
      }
      const comp = store().get(compositionId);
      if (!comp) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Composition ${compositionId} not found`,
        });
        return;
      }
      const meta = { ...comp.meta } as Record<string, unknown>;
      const list = Array.isArray(meta.variables)
        ? (meta.variables as Record<string, unknown>[])
        : [];
      meta.variables = list.filter((v) => v.id !== variableId);
      const vals = { ...((meta.variableValues as Record<string, unknown> | undefined) ?? {}) };
      delete vals[variableId];
      meta.variableValues = vals;
      const updated = store().update(compositionId, { meta });
      respond(true, { variables: meta.variables, composition: updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Bind / unbind a value for a declared variable. Pass `value: null`
   * to clear (the resolver will fall back to the variable's declared
   * default). Validates the type matches the declaration so the agent
   * can't silently write `"hot"` to a number variable.
   */
  "compositions.variables.setValue": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const variableId = asStr(params.variableId);
      if (!compositionId || !variableId) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId + variableId required",
        });
        return;
      }
      const value = params.value;
      const comp = store().get(compositionId);
      if (!comp) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Composition ${compositionId} not found`,
        });
        return;
      }
      const meta = { ...comp.meta } as Record<string, unknown>;
      const list = Array.isArray(meta.variables)
        ? (meta.variables as Record<string, unknown>[])
        : [];
      const decl = list.find((v) => v.id === variableId) as
        | { type?: string; default?: unknown }
        | undefined;
      if (!decl) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Variable ${variableId} not declared`,
        });
        return;
      }
      const vals = { ...((meta.variableValues as Record<string, unknown> | undefined) ?? {}) };
      if (value === null || value === undefined) {
        delete vals[variableId];
      } else {
        // Best-effort type guard. The resolveVariables path also coerces,
        // so a slightly off value still renders sanely.
        const t = decl.type;
        if (
          (t === "string" && typeof value !== "string") ||
          (t === "color" && typeof value !== "string") ||
          (t === "number" && typeof value !== "number") ||
          (t === "boolean" && typeof value !== "boolean") ||
          (t === "enum" && typeof value !== "string")
        ) {
          respond(false, undefined, {
            code: "TYPE_MISMATCH",
            message: `Variable ${variableId} expects ${t}, got ${typeof value}`,
          });
          return;
        }
        vals[variableId] = value;
      }
      meta.variableValues = vals;
      const updated = store().update(compositionId, { meta });
      respond(true, { values: meta.variableValues, composition: updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Project context — operator-curated reference material the agent
   * reads alongside the composition. Stored under
   * `comp.meta.context = { referenceDir, referenceSites[], notes }`:
   *
   *   - `referenceDir`: an additional folder the agent should treat as
   *     reference material (brand kit, asset library, prior projects).
   *     **Does NOT override the composition's own working directory** —
   *     that's still the gateway-managed project dir at
   *     `state/compositions/<id>/`. The agent reads files from
   *     referenceDir as supplementary context.
   *   - `referenceSites`: a curated list of URLs the agent can study
   *     for style + content reference.
   *   - `notes`: free-form text the agent reads on every `get`.
   *
   * All three end up under `comp.meta.context` so they ride along in
   * `summarizeComp`'s `projectContext` payload.
   */
  "compositions.context.get": async ({ respond, params }) => {
    try {
      const id = asStr(params.compositionId) ?? asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const comp = store().get(id);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      const meta = (comp.meta ?? {}) as Record<string, unknown>;
      const context = (meta.context as Record<string, unknown> | undefined) ?? {};
      // Accept legacy `workingDir` reads so any data written under the
      // old key still surfaces. The renamed setter writes only
      // `referenceDir` going forward.
      const referenceDir =
        typeof context.referenceDir === "string"
          ? context.referenceDir
          : typeof context.workingDir === "string"
            ? context.workingDir
            : "";
      respond(true, {
        context: {
          referenceDir,
          referenceSites: Array.isArray(context.referenceSites) ? context.referenceSites : [],
          notes: typeof context.notes === "string" ? context.notes : "",
        },
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.context.setReferenceDir": async ({ respond, params }) => {
    try {
      const id = asStr(params.compositionId);
      const referenceDir = asStr(params.referenceDir) ?? asStr(params.workingDir) ?? "";
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const comp = store().get(id);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      const meta = { ...comp.meta } as Record<string, unknown>;
      const ctx = { ...((meta.context as Record<string, unknown>) ?? {}) };
      ctx.referenceDir = referenceDir.trim();
      // Drop any legacy `workingDir` so the rename sticks.
      delete (ctx as { workingDir?: unknown }).workingDir;
      meta.context = ctx;
      const updated = store().update(id, { meta });
      respond(true, { context: meta.context, composition: updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.context.setNotes": async ({ respond, params }) => {
    try {
      const id = asStr(params.compositionId);
      const notes = asStr(params.notes) ?? "";
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const comp = store().get(id);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      const meta = { ...comp.meta } as Record<string, unknown>;
      const ctx = { ...((meta.context as Record<string, unknown>) ?? {}) };
      ctx.notes = notes;
      meta.context = ctx;
      const updated = store().update(id, { meta });
      respond(true, { context: meta.context, composition: updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.context.addReferenceSite": async ({ respond, params }) => {
    try {
      const id = asStr(params.compositionId);
      const url = asStr(params.url);
      const label = asStr(params.label);
      if (!id || !url) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId + url required" });
        return;
      }
      // Light validation — must look like a URL. Don't fetch it (no
      // network on hot paths). Strip whitespace.
      const clean = url.trim();
      if (!/^https?:\/\//i.test(clean)) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "url must start with http(s)://",
        });
        return;
      }
      const comp = store().get(id);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      const meta = { ...comp.meta } as Record<string, unknown>;
      const ctx = { ...((meta.context as Record<string, unknown>) ?? {}) };
      const list = Array.isArray(ctx.referenceSites)
        ? [...(ctx.referenceSites as Array<{ url: string; label?: string; addedAt?: number }>)]
        : [];
      // Replace if URL already present (avoid duplicates) — useful when
      // the operator pastes the same URL twice while iterating.
      const existing = list.findIndex((r) => r.url === clean);
      const entry = { url: clean, label: label?.trim() || undefined, addedAt: Date.now() };
      if (existing >= 0) list[existing] = entry;
      else list.push(entry);
      ctx.referenceSites = list;
      meta.context = ctx;
      const updated = store().update(id, { meta });
      respond(true, { context: meta.context, composition: updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.context.removeReferenceSite": async ({ respond, params }) => {
    try {
      const id = asStr(params.compositionId);
      const url = asStr(params.url);
      if (!id || !url) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId + url required" });
        return;
      }
      const comp = store().get(id);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      const meta = { ...comp.meta } as Record<string, unknown>;
      const ctx = { ...((meta.context as Record<string, unknown>) ?? {}) };
      const list = Array.isArray(ctx.referenceSites)
        ? (ctx.referenceSites as Array<{ url: string }>)
        : [];
      ctx.referenceSites = list.filter((r) => r.url !== url);
      meta.context = ctx;
      const updated = store().update(id, { meta });
      respond(true, { context: meta.context, composition: updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Comp markers — labelled time targets on the composition timeline.
   * Each marker is `{id, time, label, color}`. Stored on
   * `comp.meta.markers`. The timeline ruler renders them as vertical
   * lines with hover labels; pressing M with the playhead drops one.
   * Used for "intro ends", "drop", "outro starts" type beats so the
   * operator can keyboard-navigate by name.
   */
  "compositions.markers.list": async ({ respond, params }) => {
    try {
      const id = asStr(params.compositionId) ?? asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const comp = store().get(id);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      const meta = (comp.meta ?? {}) as Record<string, unknown>;
      respond(true, { markers: Array.isArray(meta.markers) ? meta.markers : [] });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.markers.upsert": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const m = params.marker as Record<string, unknown> | undefined;
      if (!compositionId || !m) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId + marker required",
        });
        return;
      }
      const comp = store().get(compositionId);
      if (!comp) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Composition ${compositionId} not found`,
        });
        return;
      }
      if (typeof m.time !== "number" || !Number.isFinite(m.time)) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "marker.time required (number)",
        });
        return;
      }
      const cleaned = {
        id: typeof m.id === "string" ? m.id : `mk-${Date.now().toString(36)}`,
        time: Math.max(0, Math.min(comp.durationSec, m.time)),
        label: typeof m.label === "string" ? m.label : "",
        color: typeof m.color === "string" ? m.color : "#d4a02b",
      };
      const meta = { ...comp.meta } as Record<string, unknown>;
      const list = Array.isArray(meta.markers)
        ? [...(meta.markers as Record<string, unknown>[])]
        : [];
      const idx = list.findIndex((mk) => (mk as Record<string, unknown>).id === cleaned.id);
      if (idx >= 0) list[idx] = cleaned;
      else list.push(cleaned);
      list.sort((a, b) => (a as { time: number }).time - (b as { time: number }).time);
      meta.markers = list;
      const updated = store().update(compositionId, { meta });
      respond(true, { markers: meta.markers, composition: updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.markers.delete": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const markerId = asStr(params.markerId);
      if (!compositionId || !markerId) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId + markerId required",
        });
        return;
      }
      const comp = store().get(compositionId);
      if (!comp) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Composition ${compositionId} not found`,
        });
        return;
      }
      const meta = { ...comp.meta } as Record<string, unknown>;
      const list = Array.isArray(meta.markers) ? (meta.markers as Record<string, unknown>[]) : [];
      meta.markers = list.filter((mk) => (mk as Record<string, unknown>).id !== markerId);
      const updated = store().update(compositionId, { meta });
      respond(true, { markers: meta.markers, composition: updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Stage-zoom keyframes are composition-level camera moves. Each entry
   * is `{id, time, zoom: {scale, focusX, focusY}, ease?}`. The
   * generator emits them via `data-zoom-keyframes` on the stage host
   * and the runtime tweens the stage's CSS transform between them.
   * Persisted on `comp.meta.stageZoomKeyframes`.
   */
  "compositions.stageZoom.list": async ({ respond, params }) => {
    try {
      const id = asStr(params.compositionId) ?? asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const comp = store().get(id);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      const meta = (comp.meta ?? {}) as Record<string, unknown>;
      respond(true, {
        keyframes: Array.isArray(meta.stageZoomKeyframes) ? meta.stageZoomKeyframes : [],
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Upsert a keyframe. Pass the full `{id, time, zoom, ease?}` shape;
   * we replace by id or append. Keys are clamped to sane ranges so an
   * agent or operator can't write nonsense (e.g. scale: -42, focusY: 2):
   *   - scale ∈ [0.2, 8]
   *   - focusX / focusY ∈ [0, 1]  (normalized canvas coords)
   *   - time ∈ [0, comp.durationSec]
   */
  "compositions.stageZoom.upsert": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const kf = params.keyframe as Record<string, unknown> | undefined;
      if (!compositionId || !kf) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId + keyframe required",
        });
        return;
      }
      const comp = store().get(compositionId);
      if (!comp) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Composition ${compositionId} not found`,
        });
        return;
      }
      const zoom = kf.zoom as Record<string, unknown> | undefined;
      if (!zoom) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "keyframe.zoom required" });
        return;
      }
      const clamp = (n: unknown, lo: number, hi: number, fallback: number): number => {
        if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
        return Math.max(lo, Math.min(hi, n));
      };
      const cleaned = {
        id: typeof kf.id === "string" ? kf.id : `kf-${Date.now().toString(36)}`,
        time: clamp(kf.time, 0, comp.durationSec, 0),
        zoom: {
          scale: clamp(zoom.scale, 0.2, 8, 1),
          focusX: clamp(zoom.focusX, 0, 1, 0.5),
          focusY: clamp(zoom.focusY, 0, 1, 0.5),
        },
        ease: typeof kf.ease === "string" ? kf.ease : "power2.inOut",
      };
      const meta = { ...comp.meta } as Record<string, unknown>;
      const list = Array.isArray(meta.stageZoomKeyframes)
        ? [...(meta.stageZoomKeyframes as Record<string, unknown>[])]
        : [];
      const idx = list.findIndex((k) => k && (k as Record<string, unknown>).id === cleaned.id);
      if (idx >= 0) list[idx] = cleaned;
      else list.push(cleaned);
      list.sort((a, b) => (a as { time: number }).time - (b as { time: number }).time);
      meta.stageZoomKeyframes = list;
      const updated = store().update(compositionId, { meta });
      respond(true, { keyframes: meta.stageZoomKeyframes, composition: updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.stageZoom.delete": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const keyframeId = asStr(params.keyframeId);
      if (!compositionId || !keyframeId) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId + keyframeId required",
        });
        return;
      }
      const comp = store().get(compositionId);
      if (!comp) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Composition ${compositionId} not found`,
        });
        return;
      }
      const meta = { ...comp.meta } as Record<string, unknown>;
      const list = Array.isArray(meta.stageZoomKeyframes)
        ? (meta.stageZoomKeyframes as Record<string, unknown>[])
        : [];
      meta.stageZoomKeyframes = list.filter(
        (k) => k && (k as Record<string, unknown>).id !== keyframeId,
      );
      const updated = store().update(compositionId, { meta });
      respond(true, { keyframes: meta.stageZoomKeyframes, composition: updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Clip transitions — pairs of (fromClipId, toClipId) decorated with a
   * `kind` and `durationSec`. Stored on `comp.meta.transitions`. The
   * translator emits matching GSAP animations on both sides of every
   * transition so the cut becomes a wipe / dissolve / glitch / etc.
   *
   * Phase 3 ships 11 CSS-driven kinds; the data shape is forward-
   * compatible with WebGL-shader replacements later.
   */
  "compositions.transitions.list": async ({ respond, params }) => {
    try {
      const id = asStr(params.compositionId) ?? asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const comp = store().get(id);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      const meta = (comp.meta ?? {}) as Record<string, unknown>;
      respond(true, { transitions: Array.isArray(meta.transitions) ? meta.transitions : [] });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.transitions.upsert": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const tr = params.transition as Record<string, unknown> | undefined;
      if (!compositionId || !tr) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId + transition required",
        });
        return;
      }
      const validKinds = new Set([
        "crossDissolve",
        "wipeLeft",
        "wipeRight",
        "wipeUp",
        "wipeDown",
        "zoomBlur",
        "glitch",
        "slideLeft",
        "slideRight",
        "fadeBlack",
        "fadeWhite",
      ]);
      if (typeof tr.fromClipId !== "string" || typeof tr.toClipId !== "string") {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "fromClipId + toClipId required",
        });
        return;
      }
      if (typeof tr.kind !== "string" || !validKinds.has(tr.kind)) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: `Unknown transition kind: ${tr.kind}`,
        });
        return;
      }
      const comp = store().get(compositionId);
      if (!comp) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Composition ${compositionId} not found`,
        });
        return;
      }
      const dur =
        typeof tr.durationSec === "number" && tr.durationSec > 0
          ? Math.min(tr.durationSec, 10) // sanity cap
          : 0.4;
      const cleaned = {
        id: typeof tr.id === "string" ? tr.id : `tr-${tr.fromClipId}-${tr.toClipId}`,
        fromClipId: tr.fromClipId,
        toClipId: tr.toClipId,
        kind: tr.kind,
        durationSec: dur,
        ease: typeof tr.ease === "string" ? tr.ease : undefined,
      };
      const meta = { ...comp.meta } as Record<string, unknown>;
      const list = Array.isArray(meta.transitions)
        ? [...(meta.transitions as Record<string, unknown>[])]
        : [];
      const idx = list.findIndex((t) => (t as Record<string, unknown>).id === cleaned.id);
      if (idx >= 0) list[idx] = cleaned;
      else list.push(cleaned);
      meta.transitions = list;
      const updated = store().update(compositionId, { meta });
      respond(true, { transitions: meta.transitions, composition: updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.transitions.delete": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const transitionId = asStr(params.transitionId);
      if (!compositionId || !transitionId) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId + transitionId required",
        });
        return;
      }
      const comp = store().get(compositionId);
      if (!comp) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Composition ${compositionId} not found`,
        });
        return;
      }
      const meta = { ...comp.meta } as Record<string, unknown>;
      const list = Array.isArray(meta.transitions)
        ? (meta.transitions as Record<string, unknown>[])
        : [];
      meta.transitions = list.filter((t) => (t as Record<string, unknown>).id !== transitionId);
      const updated = store().update(compositionId, { meta });
      respond(true, { transitions: meta.transitions, composition: updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Run @hyperframes/core's HTML linter against the composition's
   * fully-rendered HTML. Returns the same `HyperframeLintResult` shape
   * the lib produces: `{ok, errorCount, warningCount, findings[]}`.
   * Findings carry severity / message / element / fix hint so the UI
   * can surface a structured drawer.
   *
   * We deliberately skip the async `lintMediaUrls` / `lintScriptUrls`
   * passes here — those HEAD-check remote URLs, which is too slow for
   * a "lint on every save" UX and is best gated behind an explicit
   * "Verify links" action.
   */
  "compositions.lint": async ({ respond, params }) => {
    try {
      const id = asStr(params.compositionId) ?? asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const comp = store().getWithChildren(id);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      const { lintHyperframeHtml } = await import("@hyperframes/core");
      const { buildRenderHtml } = await import("../../compositions/render.js");
      const html = buildRenderHtml(comp);
      const result = lintHyperframeHtml(html, { filePath: `composition-${id}.html` });
      respond(true, { ...result });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.stageZoom.clear": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      if (!compositionId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const comp = store().get(compositionId);
      if (!comp) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: `Composition ${compositionId} not found`,
        });
        return;
      }
      const meta = { ...comp.meta } as Record<string, unknown>;
      meta.stageZoomKeyframes = [];
      const updated = store().update(compositionId, { meta });
      respond(true, { composition: updated });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Surface the project dir + key paths so the UI can spawn an embedded
   * Claude TUI rooted at the composition's working dir.
   */
  "compositions.projectDir": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      const comp = store().get(id);
      if (!comp) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Composition ${id} not found` });
        return;
      }
      // Re-ensure on every call — covers compositions created before this
      // feature shipped and operators who manually wiped the dir.
      ensureProjectDir(comp.id, comp.name);
      respond(true, {
        compositionId: comp.id,
        path: projectDir(comp.id),
        assetsPath: assetsDir(comp.id),
        taskPath: taskPath(comp.id),
        exists: existsSync(projectDir(comp.id)),
      });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  // ── Production-editor extensions ─────────────────────────────
  // Brief, timeline, audio, render, QC, asset sweep — wired in one
  // place so the editor agent has the whole production loop available.

  /**
   * Sweep every asset in the project and run the AI analyzer over the
   * ones that don't have description/tags yet. Useful when a workspace
   * has accumulated raw uploads — the agent can call this once and get
   * a fully populated `metadata.json` back.
   */
  "compositions.assets.analyzeAll": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      if (!compositionId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const force = asBool(params.force) === true;
      const all = listAssets(compositionId);
      const targets = force
        ? all
        : all.filter((a) => !(a.description && a.tags && a.tags.length > 0));
      const { analyzeAsset } = await import("../../compositions/asset-analyzer.js");
      const results: Array<{ filename: string; ok: boolean; error?: string; via?: string }> = [];
      for (const a of targets) {
        const filePath = join(assetsDir(compositionId), a.filename);
        try {
          const r = await analyzeAsset({ filePath, asset: a });
          updateAssetMetadata(compositionId, a.filename, {
            description: r.description || a.description,
            tags: r.tags?.length ? r.tags : a.tags,
            mood: r.mood ?? a.mood,
            scene: r.scene ?? a.scene,
            colorPalette: r.colorPalette ?? a.colorPalette,
            energy: r.energy ?? a.energy,
            suggestedUses: r.suggestedUses ?? a.suggestedUses,
            transcript: r.transcript ?? a.transcript,
            notes: r.notes ?? a.notes,
          });
          results.push({ filename: a.filename, ok: true, via: r.via });
        } catch (err) {
          results.push({
            filename: a.filename,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      respond(true, { processed: results.length, total: all.length, results });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /** Read the structured Brief (TASK.md) for a composition. */
  "compositions.brief.get": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      if (!compositionId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const { readBriefFile, emptyBrief } = await import("../../compositions/brief.js");
      const brief = readBriefFile(compositionId) ?? emptyBrief();
      respond(true, { brief });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /** Persist the structured Brief — re-renders TASK.md from scratch. */
  "compositions.brief.set": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const brief = (params.brief as Record<string, unknown> | undefined) ?? null;
      if (!compositionId || !brief) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId and brief required",
        });
        return;
      }
      const { writeBriefFile, emptyBrief } = await import("../../compositions/brief.js");
      // Merge into a clean Brief so callers can send partial updates.
      const merged = { ...emptyBrief(), ...brief } as never;
      writeBriefFile(compositionId, merged);
      respond(true, { brief: merged });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /** Read the canonical timeline.json. */
  "compositions.timeline.get": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      if (!compositionId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const { readTimeline, emptyTimeline } = await import("../../compositions/timeline.js");
      const timeline = readTimeline(compositionId) ?? emptyTimeline(compositionId);
      respond(true, { timeline });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /** Persist a timeline.json. Callers should run validate first. */
  "compositions.timeline.set": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const timeline = params.timeline as Record<string, unknown> | undefined;
      if (!compositionId || !timeline) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId and timeline required",
        });
        return;
      }
      const { writeTimeline } = await import("../../compositions/timeline.js");
      writeTimeline(compositionId, timeline as never);
      respond(true, { ok: true });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /** Validate a timeline against the brief + on-disk assets. */
  "compositions.timeline.validate": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      if (!compositionId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const { readTimeline, validateTimeline } = await import("../../compositions/timeline.js");
      const { readBriefFile } = await import("../../compositions/brief.js");
      const timeline = readTimeline(compositionId);
      if (!timeline) {
        respond(false, undefined, {
          code: "NOT_FOUND",
          message: "timeline.json not found — write one first",
        });
        return;
      }
      const report = validateTimeline(timeline, readBriefFile(compositionId));
      respond(true, report);
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /** Compile the saved timeline.json into an MP4 (proof / master / prores). */
  "compositions.timeline.render": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      if (!compositionId) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "compositionId required" });
        return;
      }
      const preset = (asStr(params.preset) ?? "proof") as "proof" | "master" | "prores";
      const { readTimeline, validateTimeline } = await import("../../compositions/timeline.js");
      const { readBriefFile } = await import("../../compositions/brief.js");
      const timeline = readTimeline(compositionId);
      if (!timeline) {
        respond(false, undefined, { code: "NOT_FOUND", message: "timeline.json not found" });
        return;
      }
      const report = validateTimeline(timeline, readBriefFile(compositionId));
      if (!report.ok) {
        respond(false, undefined, {
          code: "TIMELINE_INVALID",
          message: `Refusing to render — ${report.issues.filter((i) => i.level === "error").length} errors. Run compositions.timeline.validate.`,
        });
        return;
      }
      const { renderTimelineToMp4 } = await import("../../compositions/timeline-render.js");
      const result = await renderTimelineToMp4(timeline, {
        preset,
        watermarkText:
          preset === "proof" && asBool(params.watermark) !== false ? "PROOF" : undefined,
      });
      respond(true, result);
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /** Measure integrated LUFS / true-peak / LRA for an audio source. */
  "compositions.audio.measure": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const filename = asStr(params.filename);
      if (!compositionId || !filename) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId and filename required",
        });
        return;
      }
      const filePath = join(assetsDir(compositionId), filename);
      const { measureLoudness } = await import("../../compositions/audio-tools.js");
      const reading = await measureLoudness(filePath);
      respond(true, reading);
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /** Two-pass loudnorm to a delivery target. Returns before/after readings. */
  "compositions.audio.normalize": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const filename = asStr(params.filename);
      const preset = asStr(params.preset) ?? "tiktok";
      if (!compositionId || !filename) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId and filename required",
        });
        return;
      }
      const inputPath = join(assetsDir(compositionId), filename);
      const outputName = filename.replace(/\.([^.]+)$/, ".loudnorm.$1");
      const outputPath = join(assetsDir(compositionId), outputName);
      const { normalizeToTarget } = await import("../../compositions/audio-tools.js");
      const result = await normalizeToTarget(inputPath, outputPath, preset as never);
      respond(true, { ...result, outputName });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /** Sidechain-duck a music bed under a voiceover and emit a mixed audio file. */
  "compositions.audio.duck": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const bed = asStr(params.bed);
      const vo = asStr(params.vo);
      const outputName = asStr(params.output) ?? "ducked-mix.m4a";
      if (!compositionId || !bed || !vo) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId, bed, vo required",
        });
        return;
      }
      const dir = assetsDir(compositionId);
      const { sidechainDuck } = await import("../../compositions/audio-tools.js");
      const result = await sidechainDuck(
        join(dir, bed),
        join(dir, vo),
        join(dir, outputName),
        params.options as Record<string, number> | undefined,
      );
      respond(true, { ...result, outputName });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Run the QC checker on a rendered file. Compares against the saved
   * brief by default; pass `briefOverride` to test against a hypothetical.
   */
  "compositions.qc": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const filePath = asStr(params.filePath);
      if (!compositionId || !filePath) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId and filePath required",
        });
        return;
      }
      const { runQc } = await import("../../compositions/qc.js");
      const { readBriefFile } = await import("../../compositions/brief.js");
      const brief = (params.briefOverride as never) ?? readBriefFile(compositionId);
      const captionCoveragePct =
        typeof params.captionCoveragePct === "number" ? params.captionCoveragePct : undefined;
      const report = await runQc({ filePath, brief, captionCoveragePct });
      respond(true, report);
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  // ── Captions — pycaps-style auto-captions backed by faster-whisper ──

  /**
   * List the styling presets the captions clip can use. Pure data; UI
   * pulls this once and caches.
   */
  "compositions.captions.presets": async ({ respond }) => {
    try {
      respond(true, { presets: CAPTION_PRESETS });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * Run faster-whisper over a composition's asset (image clips not
   * supported). Returns word-level cues + the full caption clip props,
   * ready to be inserted as a new clip via compositions.clips.create.
   */
  "compositions.captions.transcribe": async ({ respond, params }) => {
    try {
      const compositionId = asStr(params.compositionId);
      const filename = asStr(params.filename);
      if (!compositionId || !filename) {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "compositionId and filename required",
        });
        return;
      }
      const asset = findAsset(compositionId, filename);
      if (!asset) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Asset ${filename} not found` });
        return;
      }
      if (asset.kind !== "video" && asset.kind !== "audio") {
        respond(false, undefined, {
          code: "BAD_REQUEST",
          message: "Only video or audio assets can be transcribed",
        });
        return;
      }
      const filePath = join(assetsDir(compositionId), filename);
      if (!existsSync(filePath)) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Asset file missing on disk` });
        return;
      }
      const presetId = asStr(params.presetId) ?? "tiktok-highlight";
      const language = asStr(params.language);
      const model = asStr(params.model);

      const result = await transcribeMedia({
        filePath,
        model,
        language,
        maxWordsPerCue:
          typeof params.maxWordsPerCue === "number" ? params.maxWordsPerCue : undefined,
      });

      // Mirror the transcript onto the asset's metadata for cross-reference.
      try {
        updateAssetMetadata(compositionId, filename, {
          transcript: result.cues.map((c) => c.text).join(" "),
        });
      } catch {
        /* best-effort */
      }

      const preset = findCaptionPreset(presetId);
      const props: CaptionsClipProps = {
        presetId: preset.id,
        cues: result.cues,
        sourceAsset: filename,
        lang: result.language,
        x: preset.layout.x,
        y: preset.layout.y,
        width: preset.layout.width,
        height: preset.layout.height,
        opacity: 1,
      };
      respond(true, {
        cues: result.cues,
        language: result.language,
        duration: result.duration,
        clipProps: props,
      });
    } catch (e) {
      respond(false, undefined, {
        code: "TRANSCRIBE_FAILED",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  // ── Composition blocks (HTML/CSS clip templates) ────────────────────

  "compositions.blocks.list": async ({ respond }) => {
    try {
      respond(true, { blocks: await listBlocks() });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.blocks.get": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      const block = await getBlock(id);
      if (!block) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Block ${id} not found` });
        return;
      }
      respond(true, { block });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.blocks.create": async ({ respond, params }) => {
    try {
      const name = asStr(params.name);
      const template = asStr(params.template);
      if (!name || !template) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "name and template required" });
        return;
      }
      const block = await createBlockDef({
        id: asStr(params.id),
        name,
        description: asStr(params.description),
        icon: asStr(params.icon),
        durationSec: asNum(params.durationSec),
        defaults: (params.defaults as Record<string, unknown>) ?? undefined,
        slots:
          (params.slots as Array<{ key: string; label?: string; default?: string }>) ?? undefined,
        template,
        css: asStr(params.css),
      });
      respond(true, { block });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.blocks.update": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      const patch: Record<string, unknown> = {};
      for (const k of [
        "name",
        "description",
        "icon",
        "durationSec",
        "defaults",
        "slots",
        "template",
        "css",
      ]) {
        if (params[k] !== undefined) patch[k] = params[k];
      }
      const block = await updateBlockDef(id, patch as Parameters<typeof updateBlockDef>[1]);
      if (!block) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Block ${id} not found` });
        return;
      }
      respond(true, { block });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "compositions.blocks.delete": async ({ respond, params }) => {
    try {
      const id = asStr(params.id);
      if (!id) {
        respond(false, undefined, { code: "BAD_REQUEST", message: "id required" });
        return;
      }
      respond(true, { deleted: await deleteBlockDef(id) });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

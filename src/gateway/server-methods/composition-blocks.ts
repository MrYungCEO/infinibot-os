import {
  deleteCustomBlock,
  deleteTemplate,
  getBlock,
  getTemplate,
  listAllBlocks,
  listTemplates,
  saveTemplate,
  upsertCustomBlock,
} from "../../compositions/blocks/store.js";
import type { BlockDefinition, CompositionTemplate } from "../../compositions/blocks/types.js";
import { resolveStateDir } from "../../config/paths.js";
import { getCompositionsStore } from "../../compositions/store.js";
import { ensureProjectDir } from "../../compositions/project-dir.js";
import type { ClipKind, ClipProps, TrackKind } from "../../compositions/types.js";
import type { GatewayRequestHandlers } from "./types.js";

function err(e: unknown): { code: string; message: string } {
  return { code: "INTERNAL_ERROR", message: e instanceof Error ? e.message : String(e) };
}

export const compositionBlocksHandlers: GatewayRequestHandlers = {
  // ── Block catalog ─────────────────────────────────────────
  "composition.blocks.list": async ({ respond }) => {
    try {
      respond(true, { blocks: await listAllBlocks() });
    } catch (e) {
      respond(false, undefined, err(e));
    }
  },

  "composition.blocks.get": async ({ params, respond }) => {
    try {
      const id = (params?.id || params?.blockId) as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const block = await getBlock(id);
      if (!block) {
        respond(false, undefined, { code: "NOT_FOUND", message: "block not found" });
        return;
      }
      respond(true, { block });
    } catch (e) {
      respond(false, undefined, err(e));
    }
  },

  "composition.blocks.upsertCustom": async ({ params, respond }) => {
    try {
      const block = params?.block as BlockDefinition | undefined;
      if (!block || !block.id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "block + block.id required" });
        return;
      }
      const saved = await upsertCustomBlock(block);
      respond(true, { block: saved });
    } catch (e) {
      respond(false, undefined, err(e));
    }
  },

  "composition.blocks.deleteCustom": async ({ params, respond }) => {
    try {
      const id = params?.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      respond(true, { deleted: await deleteCustomBlock(id) });
    } catch (e) {
      respond(false, undefined, err(e));
    }
  },

  // ── Templates ─────────────────────────────────────────────
  "composition.templates.list": async ({ respond }) => {
    try {
      respond(true, { templates: await listTemplates() });
    } catch (e) {
      respond(false, undefined, err(e));
    }
  },

  "composition.templates.get": async ({ params, respond }) => {
    try {
      const id = params?.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      const tpl = await getTemplate(id);
      if (!tpl) {
        respond(false, undefined, { code: "NOT_FOUND", message: "template not found" });
        return;
      }
      respond(true, { template: tpl });
    } catch (e) {
      respond(false, undefined, err(e));
    }
  },

  "composition.templates.save": async ({ params, respond }) => {
    try {
      const p = params as Partial<CompositionTemplate> | undefined;
      if (!p || typeof p.name !== "string" || !p.composition) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "name + composition required",
        });
        return;
      }
      const tpl = await saveTemplate({
        id: p.id,
        name: p.name,
        description: p.description,
        thumbnail: p.thumbnail,
        tags: p.tags ?? [],
        composition: p.composition,
        tracks: p.tracks ?? [],
        clips: p.clips ?? [],
      });
      respond(true, { template: tpl });
    } catch (e) {
      respond(false, undefined, err(e));
    }
  },

  /**
   * Synthesize a preview-parts payload from a template without
   * persisting a composition. Returns the same shape as the existing
   * `compositions.preview.parts` RPC so the editor's `<hyperframes-
   * stage>` component can mount a template card directly off the
   * template id — no temp comps, no double-translate.
   *
   * The flow: build an in-memory `CompositionWithChildren` from the
   * template's `composition / tracks / clips`, run it through the
   * standard translator, then call the same generators the live
   * preview uses. Element HTML + GSAP timeline + styles match the
   * eventual instantiated composition pixel-for-pixel.
   */
  "composition.templates.preview.parts": async ({ params, respond }) => {
    try {
      const id = (params?.templateId || params?.id) as string | undefined;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "templateId required" });
        return;
      }
      const tpl = await getTemplate(id);
      if (!tpl) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Template ${id} not found` });
        return;
      }
      const { compositionToHyperframes } =
        await import("../../compositions/hyperframes-translator.js");
      const { generateHyperframesHtml, generateHyperframesStyles, generateGsapTimelineScript } =
        await import("@hyperframes/core");

      const now = Date.now();
      // Build the in-memory composition tree the translator expects.
      // Track ids are synthesized so trackIndex → trackId mapping is
      // self-consistent; clip ids reuse the template's order so the
      // emitted element ids are stable across renders.
      const synthTracks = tpl.tracks.map((t, i) => ({
        id: `tpl-${id}-track-${i}`,
        compositionId: `tpl-${id}`,
        kind: t.kind as TrackKind,
        name: t.name,
        sortOrder: t.sortOrder,
        muted: false,
        locked: false,
        hidden: false,
      }));
      const synthClips = tpl.clips
        .filter((c) => synthTracks[c.trackIndex])
        .map((c, i) => ({
          id: `tpl-${id}-clip-${i}`,
          compositionId: `tpl-${id}`,
          trackId: synthTracks[c.trackIndex]!.id,
          kind: c.kind as ClipKind,
          label: c.label,
          startSec: c.startSec,
          durationSec: c.durationSec,
          z: c.z,
          props: c.props as unknown as ClipProps,
          createdAt: now,
          updatedAt: now,
        }));
      const synthComp = {
        id: `tpl-${id}`,
        name: tpl.composition.name,
        slug: tpl.composition.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        widthPx: tpl.composition.widthPx,
        heightPx: tpl.composition.heightPx,
        fps: tpl.composition.fps,
        durationSec: tpl.composition.durationSec,
        bgColor: tpl.composition.bgColor,
        meta: {},
        createdAt: tpl.createdAt,
        updatedAt: tpl.updatedAt,
        tracks: synthTracks,
        clips: synthClips,
      };

      const t = compositionToHyperframes(synthComp);
      const sortedElements = [...t.elements].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
      const fullDoc = generateHyperframesHtml(sortedElements, t.totalDuration, {
        ...t.options,
        includeScripts: false,
        includeStyles: false,
      });
      // Re-use the same extractElementsHtml from the compositions
      // server file via a dynamic import — keeping one source of truth.
      const { extractElementsHtml } = await import("./compositions.js");
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
        compositionId: synthComp.id,
        templateId: id,
        elementCount: sortedElements.length,
        totalDuration: t.totalDuration,
        resolution: t.options.resolution ?? "landscape",
        widthPx: t.widthPx,
        heightPx: t.heightPx,
        bgColor: t.bgColor,
        fps: t.fps,
        rev: tpl.updatedAt ?? 0,
        elementsHtml,
        coreCss,
        customCss,
        googleFontsLink,
        gsapTimelineScript,
        stageZoomKeyframes: t.options.stageZoomKeyframes ?? null,
      });
    } catch (e) {
      respond(false, undefined, err(e));
    }
  },

  "composition.templates.delete": async ({ params, respond }) => {
    try {
      const id = params?.id as string;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id required" });
        return;
      }
      respond(true, { deleted: await deleteTemplate(id) });
    } catch (e) {
      respond(false, undefined, err(e));
    }
  },

  /**
   * Instantiate a template — create a fresh composition with the same
   * canvas/fps/duration/bg, then replay the template's tracks + clips
   * verbatim into it. Returns the newly-created composition with full
   * children so the editor can `selectComposition(id)` immediately.
   *
   * The clone explicitly re-IDs every track + clip so two operators
   * spawning the same template in the same workspace don't collide.
   * Clip.props are passed through unchanged — they carry the canonical
   * `animationPresetId` references the motion presets read at render
   * time, so the template's look is preserved.
   */
  "composition.templates.instantiate": async ({ params, respond }) => {
    try {
      const id = (params?.templateId || params?.id) as string | undefined;
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "templateId required" });
        return;
      }
      const tpl = await getTemplate(id);
      if (!tpl) {
        respond(false, undefined, { code: "NOT_FOUND", message: `Template ${id} not found` });
        return;
      }

      const overrideName =
        typeof params?.name === "string" && params.name.trim()
          ? (params.name as string).trim()
          : null;

      const store = getCompositionsStore(resolveStateDir());
      const comp = store.create({
        name: overrideName ?? tpl.composition.name,
        widthPx: tpl.composition.widthPx,
        heightPx: tpl.composition.heightPx,
        fps: tpl.composition.fps,
        durationSec: tpl.composition.durationSec,
        bgColor: tpl.composition.bgColor,
        meta: { instantiatedFromTemplate: tpl.id, templateName: tpl.name },
      });

      try {
        ensureProjectDir(comp.id, comp.name);
      } catch {
        /* best effort */
      }

      // Replay tracks first so we can map trackIndex → trackId for clips.
      const createdTracks = tpl.tracks.map((t) =>
        store.createTrack({
          compositionId: comp.id,
          kind: t.kind as TrackKind,
          name: t.name,
          sortOrder: t.sortOrder,
        }),
      );

      for (const c of tpl.clips) {
        const track = createdTracks[c.trackIndex];
        if (!track) continue;
        store.createClip({
          compositionId: comp.id,
          trackId: track.id,
          kind: c.kind as ClipKind,
          label: c.label,
          startSec: c.startSec,
          durationSec: c.durationSec,
          z: c.z,
          props: c.props as unknown as ClipProps,
        });
      }

      const full = store.getWithChildren(comp.id);
      respond(true, { composition: full, templateId: tpl.id });
    } catch (e) {
      respond(false, undefined, err(e));
    }
  },
};

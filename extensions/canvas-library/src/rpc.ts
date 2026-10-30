/**
 * HoloCanvas library — gateway RPC handlers (`canvas-library.*`).
 *
 *   canvas-library.list          — saved canvases (paged, optional tag filter)
 *   canvas-library.get           — full entry by id
 *   canvas-library.tags          — every tag in use
 *   canvas-library.save          — upsert a canvas (title + payload + tags)
 *   canvas-library.delete        — remove a canvas
 *   canvas-library.bake          — synthesize per-scene narration audio
 *   canvas-library.fromSource    — report / markdown / walkthrough → saved canvas
 *   canvas-library.examples.load — add the example canvases (opt-in, idempotent)
 *
 * All storage and conversion goes through the core `canvasRuntime` seam; the
 * store is the core saved-canvas store, so work-review canvases show up here
 * and anything saved here keeps its /canvas/:id link when the plugin is off.
 *
 * Broadcasts `canvas-library:changed` after mutations so open UIs refresh.
 * (These were the core `canvas.library.*` RPCs before the plugin move.)
 */

import type { CanvasRuntime, GatewayRequestHandler } from "infinibot/plugin-sdk";
import { EXAMPLE_CANVASES, type CanvasPayload } from "./examples.js";

export const CHANGED_EVENT = "canvas-library:changed";

type Runtime = Pick<CanvasRuntime, "store" | "parseSource" | "convert" | "bakeNarration">;
type Respond = Parameters<GatewayRequestHandler>[0]["respond"];
type Ctx = Parameters<GatewayRequestHandler>[0]["context"];

function fail(respond: Respond, e: unknown) {
  const code =
    e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string"
      ? (e as { code: string }).code
      : "CANVAS_LIBRARY_ERROR";
  respond(false, undefined, { code, message: e instanceof Error ? e.message : String(e) });
}

function broadcast(context: Ctx, payload: unknown) {
  try {
    context.broadcast(CHANGED_EVENT, payload);
  } catch {
    /* best-effort */
  }
}

function requireId(params: unknown, respond: Respond): string | null {
  const id = (params as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string" || !id.trim()) {
    respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
    return null;
  }
  return id;
}

function cleanTags(v: unknown): string[] {
  return Array.isArray(v)
    ? [...new Set(v.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean))]
    : [];
}

export function isCanvasPayload(v: unknown): v is CanvasPayload {
  return (
    !!v &&
    typeof v === "object" &&
    Array.isArray((v as CanvasPayload).nodes) &&
    Array.isArray((v as CanvasPayload).scenes)
  );
}

export function createCanvasLibraryHandlers(rt: Runtime): Record<string, GatewayRequestHandler> {
  return {
    "canvas-library.list": async ({ params, respond }) => {
      try {
        const p = (params ?? {}) as { tag?: unknown; limit?: unknown; offset?: unknown };
        const tag = typeof p.tag === "string" && p.tag ? p.tag : undefined;
        const store = await rt.store();
        const entries = store.list({
          tag,
          limit: typeof p.limit === "number" ? p.limit : 100,
          offset: typeof p.offset === "number" ? p.offset : 0,
        });
        respond(true, {
          entries: entries.map(({ payload, bakedAudioManifest, ...rest }) => ({
            ...rest,
            sceneCount: payload.scenes?.length ?? 0,
            nodeCount: payload.nodes?.length ?? 0,
            hasBakedAudio: bakedAudioManifest != null && Object.keys(bakedAudioManifest).length > 0,
          })),
          total: store.count(tag),
        });
      } catch (e) {
        fail(respond, e);
      }
    },

    "canvas-library.get": async ({ params, respond }) => {
      try {
        const id = requireId(params, respond);
        if (!id) return;
        const entry = (await rt.store()).get(id);
        if (!entry) {
          respond(false, undefined, { code: "NOT_FOUND", message: `canvas ${id} not found` });
          return;
        }
        respond(true, { entry });
      } catch (e) {
        fail(respond, e);
      }
    },

    "canvas-library.tags": async ({ respond }) => {
      try {
        respond(true, { tags: (await rt.store()).allTags() });
      } catch (e) {
        fail(respond, e);
      }
    },

    "canvas-library.save": async ({ params, respond, context }) => {
      try {
        const p = (params ?? {}) as {
          title?: unknown;
          payload?: unknown;
          tags?: unknown;
          thumbnailDataUrl?: unknown;
          id?: unknown;
        };
        if (typeof p.title !== "string" || !p.title.trim()) {
          respond(false, undefined, { code: "INVALID_PARAMS", message: "title is required" });
          return;
        }
        if (!isCanvasPayload(p.payload)) {
          respond(false, undefined, {
            code: "INVALID_PARAMS",
            message: "payload must have nodes[] and scenes[]",
          });
          return;
        }
        const entry = (await rt.store()).save({
          title: p.title.trim(),
          payload: p.payload,
          tags: cleanTags(p.tags),
          thumbnailDataUrl: typeof p.thumbnailDataUrl === "string" ? p.thumbnailDataUrl : null,
          id: typeof p.id === "string" && p.id ? p.id : undefined,
        });
        broadcast(context, { action: "saved", id: entry.id });
        respond(true, { entry });
      } catch (e) {
        fail(respond, e);
      }
    },

    "canvas-library.delete": async ({ params, respond, context }) => {
      try {
        const id = requireId(params, respond);
        if (!id) return;
        if (!(await rt.store()).delete(id)) {
          respond(false, undefined, { code: "NOT_FOUND", message: `canvas ${id} not found` });
          return;
        }
        broadcast(context, { action: "deleted", id });
        respond(true, { ok: true });
      } catch (e) {
        fail(respond, e);
      }
    },

    "canvas-library.bake": async ({ params, respond, context }) => {
      try {
        const id = requireId(params, respond);
        if (!id) return;
        const store = await rt.store();
        const entry = store.get(id);
        if (!entry) {
          respond(false, undefined, { code: "NOT_FOUND", message: `canvas ${id} not found` });
          return;
        }
        const baked = await rt.bakeNarration(entry.payload);
        const manifest: Record<string, string> = {};
        for (const scene of baked.scenes ?? []) {
          if (scene.narration?.audioUrl) manifest[scene.id] = scene.narration.audioUrl;
        }
        store.save({
          id,
          title: entry.title,
          payload: baked,
          tags: entry.tags,
          thumbnailDataUrl: entry.thumbnailDataUrl,
        });
        store.updateBakedManifest(id, manifest);
        broadcast(context, { action: "baked", id });
        respond(true, { ok: true, manifest });
      } catch (e) {
        fail(respond, e);
      }
    },

    "canvas-library.fromSource": async ({ params, respond, context }) => {
      try {
        const converted = await rt.convert(await rt.parseSource(params));
        const extra = cleanTags((params as { tags?: unknown } | undefined)?.tags);
        const entry = (await rt.store()).save({
          title: converted.title,
          payload: converted.payload,
          tags: [...new Set([converted.source, ...extra])],
        });
        broadcast(context, { action: "saved", id: entry.id });
        respond(true, { entry, mediaKind: converted.mediaKind });
      } catch (e) {
        fail(respond, e);
      }
    },

    "canvas-library.examples.load": async ({ respond, context }) => {
      try {
        const store = await rt.store();
        const added: string[] = [];
        for (const ex of EXAMPLE_CANVASES) {
          if (store.findByTitle(ex.title)) continue;
          added.push(store.save({ title: ex.title, payload: ex.payload, tags: ex.tags }).id);
        }
        if (added.length > 0) broadcast(context, { action: "examples", ids: added });
        respond(true, { added, alreadyPresent: EXAMPLE_CANVASES.length - added.length });
      } catch (e) {
        fail(respond, e);
      }
    },
  };
}

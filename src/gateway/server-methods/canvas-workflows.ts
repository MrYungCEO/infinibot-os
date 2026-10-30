/**
 * Canvas Workflow RPC handlers.
 *
 *   canvas.list  — return registered workflows [{id,title,description}]
 *   canvas.run   — build a workflow payload and emit it as an
 *                  `infinite-canvas-walkthrough` proactive overlay event.
 *   canvas.convert — report / markdown / stylized walkthrough → canvas payload;
 *                  optionally save it (saved-canvas store, /canvas/:id) and/or
 *                  emit it as a proactive overlay. Core runtime: works with the
 *                  HoloCanvas library plugin off.
 *
 * `canvas.run` looks up the workflow in the registry, calls `build(ctx)` with
 * an in-process {@link getDefaultBuildCtx} (no HTTP), then wraps the result
 * into a proactive emit via `emitProactiveServerSide`. Returns `{ ok, eventId }`.
 *
 * The gateway needs a restart for these RPCs to be live — the handler is
 * registered in `server-methods.ts` but the method table is built at startup.
 */

import type { GatewayRequestHandlers } from "./types.js";
import { STATE_DIR } from "../../config/paths.js";
import {
  getWorkflow,
  listWorkflows,
  getDefaultBuildCtx,
  type BuildCtx,
} from "../../canvas-workflows/registry.js";
// Side-effect: registers the two shipped templates.
import "../../canvas-workflows/templates/systems-overview.js";
import "../../canvas-workflows/templates/project-ops.js";
import { emitProactiveServerSide } from "../../proactive/emit.js";
import { validatePopupMedia } from "../../proactive/popup-types.js";
import { TIER_ORDER, type PopupTier } from "../../proactive/popup-types.js";
import {
  CanvasConvertError,
  convertToCanvas,
  parseCanvasSource,
} from "../../canvas-host/canvas-convert.js";
import { getSavedCanvasStore } from "../../canvas-host/saved-canvases.js";

export const canvasWorkflowHandlers: GatewayRequestHandlers = {
  "canvas.list": async ({ respond }) => {
    respond(true, {
      workflows: listWorkflows().map((wf) => ({
        id: wf.id,
        title: wf.title,
        description: wf.description,
      })),
    });
  },

  "canvas.run": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        id?: string;
        ctx?: BuildCtx;
        tier?: string;
      };
      const id = typeof p.id === "string" ? p.id.trim() : "";
      if (!id) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "id is required" });
        return;
      }
      const wf = getWorkflow(id);
      if (!wf) {
        respond(false, undefined, { code: "NOT_FOUND", message: `workflow ${id} not found` });
        return;
      }

      const ctx = p.ctx ?? getDefaultBuildCtx();
      const payload = await wf.build(ctx);

      // Validate the payload against the overlay schema before emitting.
      const v = validatePopupMedia({ kind: "infinite-canvas-walkthrough", payload });
      if (v.error) {
        respond(false, undefined, {
          code: "INVALID_PAYLOAD",
          message: `workflow ${id} produced an invalid payload: ${v.error}`,
        });
        return;
      }

      const tier = ((p.tier ?? "NOTABLE").toString().toUpperCase() as PopupTier) || "NOTABLE";
      const built = emitProactiveServerSide(
        {
          tier,
          title: wf.title,
          body: wf.description ?? "",
          attribution: { agentId: "canvas-workflow" },
          actions: [],
          dedupKey: `canvas-workflow:${id}:${Date.now()}`,
          media: {
            kind: "infinite-canvas-walkthrough",
            // Ensure voiceSuppress is set so the overlay speaks, not the orchestrator.
            payload: { ...payload, voiceSuppress: true, voice: payload.voice ?? wf.defaultVoice },
          },
        },
        STATE_DIR,
      );

      if (!built) {
        respond(false, undefined, {
          code: "EMIT_FAILED",
          message: `emit failed for workflow ${id}`,
        });
        return;
      }
      respond(true, { ok: true, eventId: built.event.id });
    } catch (e) {
      respond(false, undefined, {
        code: "CANVAS_WORKFLOW_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },

  "canvas.convert": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        save?: boolean;
        emit?: boolean;
        tags?: unknown;
        tier?: string;
      };
      const tier = (p.tier ?? "NOTABLE").toString().toUpperCase() as PopupTier;
      if (p.emit === true && !TIER_ORDER.includes(tier)) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: `tier must be one of ${TIER_ORDER.join(", ")}`,
        });
        return;
      }
      const converted = convertToCanvas(parseCanvasSource(params));
      const v = validatePopupMedia({ kind: converted.mediaKind, payload: converted.payload });
      if (v.error) {
        respond(false, undefined, { code: "INVALID_PAYLOAD", message: v.error });
        return;
      }
      let canvasId: string | undefined;
      if (p.save === true) {
        const extra = Array.isArray(p.tags)
          ? p.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "")
          : [];
        canvasId = getSavedCanvasStore(STATE_DIR).save({
          title: converted.title,
          payload: converted.payload,
          tags: [...new Set([converted.source, ...extra])],
        }).id;
      }
      let eventId: string | undefined;
      if (p.emit === true) {
        const built = emitProactiveServerSide(
          {
            tier,
            title: converted.title,
            body: "",
            attribution: { agentId: "canvas-runtime" },
            actions: [],
            dedupKey: `canvas-convert:${canvasId ?? converted.source}:${Date.now()}`,
            media: { kind: converted.mediaKind, payload: converted.payload },
          },
          STATE_DIR,
        );
        eventId = built?.event.id;
      }
      respond(true, {
        ok: true,
        title: converted.title,
        mediaKind: converted.mediaKind,
        payload: converted.payload,
        ...(canvasId ? { canvasId, sharePath: `/canvas/${canvasId}` } : {}),
        ...(p.emit === true ? { emitted: eventId !== undefined } : {}),
        ...(eventId ? { eventId } : {}),
      });
    } catch (e) {
      respond(false, undefined, {
        code: e instanceof CanvasConvertError ? e.code : "CANVAS_CONVERT_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

/**
 * Overlay verbs for the `ui_control` agent tool.
 *
 * Adds the 8 overlay ops from spec §4 to `ui_control` so an agent can spawn /
 * drive on-screen overlay cards the same way it drives views. These run
 * in-process with the gateway and call the shared overlay router directly
 * (which persists + broadcasts on `overlay.events`), so they behave exactly
 * like the matching `ui.overlay.*` gateway RPCs.
 *
 * NB: the file the build spec named (`src/mcp/tools/ui-control-overlay.ts`)
 * does not exist in this repo — the `ui_control` MCP tool is the agent tool in
 * `src/agents/tools/ui-control-tool.ts`, so the overlay ops live alongside it.
 */

import {
  clearHighlight,
  closeOverlay,
  focusOverlay,
  highlightText,
  listOverlays,
  popOutOverlay,
  spawnOverlay,
  updateOverlay,
} from "../../overlay/router.js";
import { OverlayValidationError } from "../../overlay/registry.js";

/** The overlay action names exposed on the `ui_control` tool's `action` enum. */
export const OVERLAY_ACTIONS = [
  "spawn_overlay",
  "update_overlay",
  "close_overlay",
  "list_overlays",
  "focus_overlay",
  "pop_out_overlay",
  "highlight_text",
  "clear_highlight",
] as const;

export type OverlayAction = (typeof OVERLAY_ACTIONS)[number];

const OVERLAY_ACTION_SET = new Set<string>(OVERLAY_ACTIONS);

export function isOverlayAction(action: unknown): action is OverlayAction {
  return typeof action === "string" && OVERLAY_ACTION_SET.has(action);
}

/**
 * Overlay args are passed through the tool's existing `args` object so we
 * don't have to add a parameter per field. e.g.
 *   { action: 'spawn_overlay', args: { type: 'note', payload: { id: '123' } } }
 */
export function handleOverlayAction(
  action: OverlayAction,
  rawArgs: unknown,
): Record<string, unknown> {
  const args = (
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {}
  ) as Record<string, unknown>;
  try {
    switch (action) {
      case "spawn_overlay": {
        const record = spawnOverlay({
          type: typeof args.type === "string" ? args.type : "",
          payload: args.payload,
          anchor: args.anchor,
          position: args.position,
          ttlMs: args.ttlMs,
        });
        return { ok: true, overlayId: record.overlayId, record };
      }
      case "update_overlay": {
        const overlayId = typeof args.overlayId === "string" ? args.overlayId.trim() : "";
        if (!overlayId)
          return { ok: false, error: "overlayId is required", code: "INVALID_PARAMS" };
        const record = updateOverlay(overlayId, { payload: args.payload, position: args.position });
        if (!record) return { ok: false, error: "overlay not found", code: "NOT_FOUND" };
        return { ok: true, record };
      }
      case "close_overlay": {
        const overlayId = typeof args.overlayId === "string" ? args.overlayId.trim() : "";
        if (!overlayId)
          return { ok: false, error: "overlayId is required", code: "INVALID_PARAMS" };
        const existed = closeOverlay(overlayId);
        if (!existed) return { ok: false, error: "overlay not found", code: "NOT_FOUND" };
        return { ok: true };
      }
      case "list_overlays":
        return { ok: true, overlays: listOverlays() };
      case "focus_overlay": {
        const overlayId = typeof args.overlayId === "string" ? args.overlayId.trim() : "";
        if (!overlayId)
          return { ok: false, error: "overlayId is required", code: "INVALID_PARAMS" };
        const exists = focusOverlay(overlayId);
        if (!exists) return { ok: false, error: "overlay not found", code: "NOT_FOUND" };
        return { ok: true };
      }
      case "pop_out_overlay": {
        const overlayId = typeof args.overlayId === "string" ? args.overlayId.trim() : "";
        if (!overlayId)
          return { ok: false, error: "overlayId is required", code: "INVALID_PARAMS" };
        return { ok: true, ...popOutOverlay(overlayId) };
      }
      case "highlight_text": {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return { ok: false, error: "query is required", code: "INVALID_PARAMS" };
        return {
          ok: true,
          ...highlightText({
            query,
            color: typeof args.color === "string" ? args.color : undefined,
            durationMs: typeof args.durationMs === "number" ? args.durationMs : undefined,
            scope: typeof args.scope === "string" ? args.scope : undefined,
          }),
        };
      }
      case "clear_highlight": {
        clearHighlight(typeof args.id === "string" ? args.id : undefined);
        return { ok: true };
      }
      default:
        return { ok: false, error: `unknown overlay action: ${action}` };
    }
  } catch (e) {
    if (e instanceof OverlayValidationError) {
      return { ok: false, error: e.message, code: e.code };
    }
    return { ok: false, error: String(e), code: "INTERNAL_ERROR" };
  }
}

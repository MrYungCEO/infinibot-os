/**
 * Agentic Overlay System — gateway RPC handlers (`ui.overlay.*`).
 *
 * Thin shells over {@link file://./router.ts}: validate params, call the
 * shared operation, respond. The router owns persistence + the `overlay.events`
 * WS broadcast, so these handlers do not broadcast themselves.
 *
 * Registration: spread `overlayHandlers` into `coreGatewayHandlers`
 * (src/gateway/server-methods.ts) and classify the methods in the scope sets
 * in the same file (mutations → WRITE_METHODS, `ui.overlay.list` → READ_METHODS).
 * New RPCs require a gateway restart before the running daemon serves them.
 */

import type { GatewayRequestHandlers, GatewayRequestHandler } from "../gateway/server-methods/types.js";
import { STATE_DIR } from "../config/paths.js";
import { OverlayValidationError } from "./registry.js";
import {
  clearHighlight,
  closeAllOverlays,
  closeOverlay,
  focusOverlay,
  highlightText,
  listOverlays,
  popOutOverlay,
  spawnOverlay,
  updateOverlay,
} from "./router.js";

function fail(
  respond: (ok: boolean, payload?: unknown, error?: { code: string; message: string }) => void,
  e: unknown,
): void {
  if (e instanceof OverlayValidationError) {
    respond(false, undefined, { code: e.code, message: e.message });
    return;
  }
  respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
}

export const overlayHandlers: GatewayRequestHandlers = {
  "ui.overlay.spawn": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        type?: string;
        payload?: unknown;
        anchor?: unknown;
        position?: unknown;
        ttlMs?: unknown;
      };
      const record = spawnOverlay(
        {
          type: p.type ?? "",
          payload: p.payload,
          anchor: p.anchor,
          position: p.position,
          ttlMs: p.ttlMs,
        },
        STATE_DIR,
      );
      respond(true, { overlayId: record.overlayId });
    } catch (e) {
      fail(respond, e);
    }
  },

  "ui.overlay.update": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { overlayId?: string; payload?: unknown; position?: unknown };
      const overlayId = (p.overlayId ?? "").trim();
      if (!overlayId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "overlayId is required" });
        return;
      }
      const record = updateOverlay(
        overlayId,
        { payload: p.payload, position: p.position },
        STATE_DIR,
      );
      if (!record) {
        respond(false, undefined, { code: "NOT_FOUND", message: "overlay not found" });
        return;
      }
      respond(true, { ok: true });
    } catch (e) {
      fail(respond, e);
    }
  },

  "ui.overlay.close": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { overlayId?: string };
      const overlayId = (p.overlayId ?? "").trim();
      if (!overlayId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "overlayId is required" });
        return;
      }
      const existed = closeOverlay(overlayId, STATE_DIR);
      if (!existed) {
        respond(false, undefined, { code: "NOT_FOUND", message: "overlay not found" });
        return;
      }
      respond(true, { ok: true });
    } catch (e) {
      fail(respond, e);
    }
  },

  "ui.overlay.list": async ({ respond }) => {
    try {
      respond(true, { overlays: listOverlays(STATE_DIR) });
    } catch (e) {
      fail(respond, e);
    }
  },

  "ui.overlay.focus": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { overlayId?: string };
      const overlayId = (p.overlayId ?? "").trim();
      if (!overlayId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "overlayId is required" });
        return;
      }
      const exists = focusOverlay(overlayId, STATE_DIR);
      if (!exists) {
        respond(false, undefined, { code: "NOT_FOUND", message: "overlay not found" });
        return;
      }
      respond(true, { ok: true });
    } catch (e) {
      fail(respond, e);
    }
  },

  "ui.overlay.popOut": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { overlayId?: string };
      const overlayId = (p.overlayId ?? "").trim();
      if (!overlayId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "overlayId is required" });
        return;
      }
      respond(true, popOutOverlay(overlayId));
    } catch (e) {
      fail(respond, e);
    }
  },

  "ui.overlay.highlightText": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        query?: string;
        color?: string;
        durationMs?: number;
        scope?: string;
      };
      const query = (p.query ?? "").trim();
      if (!query) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "query is required" });
        return;
      }
      respond(
        true,
        highlightText({ query, color: p.color, durationMs: p.durationMs, scope: p.scope }),
      );
    } catch (e) {
      fail(respond, e);
    }
  },

  "ui.overlay.clearHighlight": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { id?: string };
      clearHighlight(typeof p.id === "string" ? p.id : undefined);
      respond(true, { ok: true });
    } catch (e) {
      fail(respond, e);
    }
  },

  // ── Agent-friendly modal aliases (`ui.modals.*`) ────────────────────────
  // Thin, well-named shells over `ui.overlay.spawn`/`close` so an agent can say
  // `ui.modals.openProject { data: {...} }` in chat without knowing the overlay
  // type registry. Each maps onto the exact same spawn/close path (persist +
  // `overlay.events` broadcast), so they behave identically to `ui.overlay.*`.
  "ui.modals.openProject": openModalHandler("project"),
  "ui.modals.openTask": openModalHandler("task"),
  "ui.modals.openClient": openModalHandler("client"),
  "ui.modals.openPortfolio": openModalHandler("portfolio"),

  "ui.modals.close": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { overlayId?: string; id?: string };
      const overlayId = (p.overlayId ?? p.id ?? "").trim();
      if (!overlayId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "overlayId is required" });
        return;
      }
      const existed = closeOverlay(overlayId, STATE_DIR);
      if (!existed) {
        respond(false, undefined, { code: "NOT_FOUND", message: "overlay not found" });
        return;
      }
      respond(true, { ok: true });
    } catch (e) {
      fail(respond, e);
    }
  },

  "ui.modals.closeAll": async ({ respond }) => {
    try {
      respond(true, { ok: true, closed: closeAllOverlays(STATE_DIR) });
    } catch (e) {
      fail(respond, e);
    }
  },
};

/**
 * Build an `ui.modals.open*` handler for a fixed overlay `type`. Accepts the
 * card fields under either `data` (spec wording) or `payload` (overlay wording),
 * plus optional `position`/`ttlMs`/`anchor`, and returns the new `overlayId`.
 */
function openModalHandler(type: string): GatewayRequestHandler {
  return async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        data?: unknown;
        payload?: unknown;
        position?: unknown;
        ttlMs?: unknown;
        anchor?: unknown;
      };
      const record = spawnOverlay(
        {
          type,
          payload: p.data ?? p.payload,
          position: p.position,
          ttlMs: p.ttlMs,
          anchor: p.anchor,
        },
        STATE_DIR,
      );
      respond(true, { overlayId: record.overlayId });
    } catch (e) {
      fail(respond, e);
    }
  };
}

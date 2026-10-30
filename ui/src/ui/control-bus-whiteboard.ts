/** Agent-facing UI controller for the Whiteboard plugin. */

import type { AppViewState } from "./app-view-state";
import { attachViewController, UIControlBus, type RegistrationHandle } from "./control-bus";
import { createMasonryGridState } from "./controllers/masonry-grid";

type WhiteboardControllerOptions = {
  isAvailable: () => boolean;
};

function requestUpdate(host: AppViewState): void {
  (host as unknown as { requestUpdate?: () => void }).requestUpdate?.();
}

export function registerWhiteboardController(
  host: AppViewState,
  options: WhiteboardControllerOptions,
): RegistrationHandle {
  return attachViewController({
    viewName: "whiteboard",
    description:
      "Whiteboard plugin: open the live editable Excalidraw canvas as a full page or add it to the Grid as a canvas panel. Drawing/editing is handled by the whiteboard plugin's excalidraw_* tools.",
    getState: () => {
      const grid = host.masonryGridState;
      const activeCanvas = grid?.canvases?.find((c) => c.id === grid.activeCanvasId);
      const panels = activeCanvas?.panels ?? grid?.panels ?? [];
      return {
        available: options.isAvailable(),
        active: host.tab === "whiteboard",
        route: "/whiteboard",
        canvasPanels: panels
          .filter((panel) => panel.type === "canvas")
          .map((panel) => ({ panelId: panel.id, title: panel.title })),
      };
    },
    describeActions: () => [
      {
        type: "open",
        doc: "Open the full-page Whiteboard plugin view.",
      },
      {
        type: "open_in_grid",
        args: { title: "string? default 'Whiteboard'" },
        doc: "Open Grid and add a live Whiteboard canvas panel. This is the convenience form of grid.add_panel with panelType='canvas'.",
      },
    ],
    dispatch: async (action) => {
      const a = action as Record<string, unknown>;
      if (!options.isAvailable()) {
        return {
          ok: false,
          error: "Whiteboard plugin is not enabled. Enable it in Setup > Plugins > Whiteboard.",
        };
      }
      switch (a.type) {
        case "open":
          host.setTab("whiteboard");
          requestUpdate(host);
          return { ok: true, result: { tab: "whiteboard", route: "/whiteboard" } };
        case "open_in_grid": {
          if (!host.masonryGridState) {
            host.masonryGridState = createMasonryGridState();
          }
          host.setTab("grid");
          requestUpdate(host);
          return UIControlBus.dispatchTo("grid", {
            type: "add_panel",
            panelType: "canvas",
            options: {
              title: typeof a.title === "string" && a.title.trim() ? a.title.trim() : "Whiteboard",
            },
          });
        }
        default:
          return { ok: false, error: `unknown action: ${String(a.type)}` };
      }
    },
  });
}

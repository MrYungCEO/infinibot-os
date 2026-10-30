/**
 * HoloCanvas library — first-party InfiniBot plugin (manifest v2).
 *
 * The Canvas Library used to be a core surface. It is now this plugin, bundled
 * but OFF on a fresh install; an upgrading install that already has saved
 * canvases is switched on once (src/plugins/canvas-library-migration.ts).
 * While enabled it contributes:
 *   - the library page (plugin-gated tab `canvas`, route /canvas) and its
 *     "HoloCanvas" sidebar entry in the Work group;
 *   - the `canvas-library.*` RPCs (browse, save, delete, bake narration,
 *     build from a report / markdown, load examples);
 *   - the `canvas_library` agent tool.
 *
 * The canvas RUNTIME stays core (PLUGIN-PLATFORM.md B34): the saved-canvas
 * store, the converters, narration baking, /canvas/:id share pages, proactive
 * walkthrough overlays and work-review all work with this plugin off. The
 * plugin reaches them only through the `canvasRuntime` seam, so turning it off
 * removes the library UI, RPCs and tool and never touches stored canvases.
 *
 * Docs: docs/plugins/canvas-library/README.md.
 */

import type { InfiniBotPluginApi } from "infinibot/plugin-sdk";
import { canvasRuntime } from "infinibot/plugin-sdk";
import { createCanvasLibraryHandlers } from "./src/rpc.js";
import { CANVAS_LIBRARY_TOOL, createCanvasLibraryTool } from "./src/tool.js";

export default function register(api: InfiniBotPluginApi) {
  for (const [method, handler] of Object.entries(createCanvasLibraryHandlers(canvasRuntime))) {
    api.registerGatewayMethod(method, handler);
  }
  api.registerTool(() => createCanvasLibraryTool(canvasRuntime), { name: CANVAS_LIBRARY_TOOL });
}

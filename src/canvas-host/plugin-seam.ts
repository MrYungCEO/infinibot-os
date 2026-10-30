/**
 * `canvasRuntime` — the seam between the core canvas runtime (B34) and the
 * HoloCanvas library plugin (extensions/canvas-library).
 *
 * Core owns the saved-canvas store, the report/markdown/walkthrough
 * converters, narration baking and the /canvas/:id share pages; they all work
 * with the plugin off. The plugin reaches them only through this object
 * (re-exported from `infinibot/plugin-sdk`). Modules load lazily so importing
 * the SDK never opens SQLite or pulls in the report system.
 */

import type { InfiniteCanvasWalkthroughMedia } from "../proactive/popup-types.js";
import type { CanvasSource, ConvertedCanvas } from "./canvas-convert.js";
import type { SavedCanvas, SavedCanvasStore } from "./saved-canvases.js";

export type { CanvasSource, ConvertedCanvas, SavedCanvas, SavedCanvasStore };

async function stateDir(): Promise<string> {
  return (await import("../config/paths.js")).STATE_DIR;
}

export const canvasRuntime = {
  /** The shared saved-canvas store (`<stateDir>/canvas-library.db`). */
  async store(): Promise<SavedCanvasStore> {
    const { getSavedCanvasStore } = await import("./saved-canvases.js");
    return getSavedCanvasStore(await stateDir());
  },

  /** Validate loose params into a source (throws with a `code` on bad input). */
  async parseSource(raw: unknown): Promise<CanvasSource> {
    return (await import("./canvas-convert.js")).parseCanvasSource(raw);
  },

  /** Report / markdown / stylized walkthrough → canvas payload. */
  async convert(src: CanvasSource): Promise<ConvertedCanvas> {
    return (await import("./canvas-convert.js")).convertToCanvas(src);
  },

  /** Synthesize per-scene narration audio (mutates + returns the payload). */
  async bakeNarration(
    payload: InfiniteCanvasWalkthroughMedia,
  ): Promise<InfiniteCanvasWalkthroughMedia> {
    const { bakeScenesNarration } = await import("../proactive/canvas-narration.js");
    return bakeScenesNarration(payload, await stateDir());
  },

  /** Share page path for a saved canvas (served by core, plugin on or off). */
  sharePath(id: string): string {
    return `/canvas/${id}`;
  },
};

export type CanvasRuntime = typeof canvasRuntime;

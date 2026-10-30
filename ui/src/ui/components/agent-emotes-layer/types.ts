/**
 * Shared types for <agent-emotes-layer>.
 *
 * The emotes layer is a self-contained reaction overlay for the Agency World
 * map. It needs exactly one thing from the world: each agent's *screen*
 * position (CSS px, relative to the layer's own bounding box). It reuses the
 * established `window.__agentFxState` contract that <agent-fx-layer> already
 * consumes, so no viz changes are required to position emotes.
 */

/** The seven supported emote reactions. */
export type EmoteType =
  | "success"
  | "fail"
  | "blocked"
  | "shipping"
  | "spawn"
  | "levelup"
  | "thinking";

export const EMOTE_TYPES: EmoteType[] = [
  "success",
  "fail",
  "blocked",
  "shipping",
  "spawn",
  "levelup",
  "thinking",
];

/** Per-emote tuning knobs. All optional with sensible defaults. */
export interface EmoteOptions {
  /** Pixel offset above the agent's anchor point. Default −34. */
  offsetY?: number;
  /** Horizontal offset from the agent's anchor. Default 0. */
  offsetX?: number;
  /** Visual scale multiplier. Default 1. */
  scale?: number;
  /**
   * Explicit screen position (CSS px, relative to the layer). When supplied the
   * emote is pinned here instead of following an agent — used for demos/tests
   * and for emotes whose agent isn't in `__agentFxState`.
   */
  x?: number;
  y?: number;
}

/** A minimal agent position record, mirroring agent-fx-layer's FxAgent. */
export interface EmoteAgentPos {
  id: string;
  x: number;
  y: number;
}

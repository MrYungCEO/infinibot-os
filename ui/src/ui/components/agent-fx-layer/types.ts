/**
 * Shared types for <agent-fx-layer>.
 *
 * FxAgent is the *only* contract the layer needs from the world viz: an id, a
 * screen-space position (CSS px, relative to the layer's own bounding box), the
 * agent's status, and optionally its coder backend. Everything else (sprites,
 * walk state, PixiJS internals) stays private to the viz.
 */

export interface FxAgent {
  /** Stable identity — sessionKey/agentId. Used to track motion + transitions. */
  id: string;
  /** Screen X in CSS px, relative to the layer's top-left. */
  x: number;
  /** Screen Y in CSS px, relative to the layer's top-left. */
  y: number;
  /** Free-form status string (see colors.statusKey for accepted values). */
  status: string;
  /** Coder backend, when known — drives trail colour. */
  backend?: string;
}

/** A pull source the layer polls once per frame. Return current agents. */
export type FxSource = () => FxAgent[];

/** Which effect families can be toggled independently. */
export type FxEffect = "trails" | "glow" | "bursts";

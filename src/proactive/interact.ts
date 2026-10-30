/**
 * src/proactive/interact.ts — proactive interact-channel op vocabulary.
 *
 * The canonical wire type + validator (`PopupInteract`, `validatePopupInteract`)
 * live in `./popup-types.ts` because the gateway RPC imports them there. This
 * module is the focused home for the **scene-timeline orchestration** layer
 * added on top of the original element ops: it classifies ops into groups and
 * documents each so the gateway handler, the voice orchestrator, and tests can
 * reason about an op without re-deriving the taxonomy.
 *
 * An agent drives a live walkthrough / presenter overlay by emitting these via
 * `proactive.interact`; the overlay host routes them by eventId to the live
 * card's `applyInteract()` (see ui/.../proactive-media/interactive-registry.ts).
 */

import { type PopupInteract, type PopupInteractOp, validatePopupInteract } from "./popup-types.js";

export { validatePopupInteract };
export type { PopupInteract, PopupInteractOp };

/** Element-level ops: target a single element within the timeline. */
export const ELEMENT_OPS = [
  "highlight",
  "scrollTo",
  "replaceElement",
  "appendElement",
  "element.cue",
  "element.hold",
] as const satisfies readonly PopupInteractOp[];

/** Scene-level ops: move between whole scenes of a walkthrough. */
export const SCENE_OPS = [
  "scene.goto",
  "scene.next",
  "scene.prev",
] as const satisfies readonly PopupInteractOp[];

/** Timeline transport ops: pause / resume / seek the active reveal animation. */
export const TIMELINE_OPS = [
  "timeline.pause",
  "timeline.play",
  "timeline.seek",
] as const satisfies readonly PopupInteractOp[];

/** Cursor ops: advance / rewind / reveal a stylized-markdown or deck cursor. */
export const CURSOR_OPS = [
  "next",
  "prev",
  "revealAll",
] as const satisfies readonly PopupInteractOp[];

export type InteractGroup = "element" | "scene" | "timeline" | "cursor" | "lifecycle";

/** Classify an op into its orchestration group (used for routing + docs). */
export function interactGroup(op: PopupInteractOp): InteractGroup {
  if ((ELEMENT_OPS as readonly string[]).includes(op)) return "element";
  if ((SCENE_OPS as readonly string[]).includes(op)) return "scene";
  if ((TIMELINE_OPS as readonly string[]).includes(op)) return "timeline";
  if ((CURSOR_OPS as readonly string[]).includes(op)) return "cursor";
  return "lifecycle"; // "dismiss"
}

/** Human-readable one-liner per op — surfaced in agent-facing docs / errors. */
export const INTERACT_OP_DOC: Record<PopupInteractOp, string> = {
  highlight: "Glow + settle a specific element while it is being spoken.",
  scrollTo: "Scroll an element into view.",
  replaceElement: "Swap an element's markdown in place.",
  appendElement: "Append a new element to the timeline.",
  next: "Advance the timeline / deck cursor.",
  prev: "Step the timeline / deck cursor back.",
  revealAll: "Reveal every remaining element at once.",
  dismiss: "Close the overlay.",
  "scene.goto": "Jump the walkthrough to scene `index`.",
  "scene.next": "Advance to the next scene.",
  "scene.prev": "Step back one scene.",
  "element.cue": "Re-pulse / spotlight a specific element (elementId).",
  "element.hold": "Pin auto-advance on an element until released (elementId).",
  "timeline.pause": "Pause auto-advance and any in-flight reveal animation.",
  "timeline.play": "Resume auto-advance and the reveal animation.",
  "timeline.seek": "Seek the active reveal animation to `seekMs`.",
};

/**
 * Live interactive-overlay registry.
 *
 * Stateful media cards (stylized-markdown timeline, card-deck) register
 * themselves here by eventId on connect. The overlay host receives
 * `proactive.interact` WS frames and routes them through {@link applyInteract}
 * WITHOUT having to traverse nested shadow DOM — it just looks up the live card
 * by eventId. This is the server→client interact channel's client landing pad.
 */

import type { PopupInteract } from "../proactive-popup-shared.js";

export interface InteractiveOverlay {
  eventId: string;
  /** Apply a live control op. Returns true if handled. */
  applyInteract(interact: PopupInteract): boolean;
}

const registry = new Map<string, InteractiveOverlay>();

export function registerOverlay(o: InteractiveOverlay): void {
  if (o.eventId) registry.set(o.eventId, o);
}

export function unregisterOverlay(o: InteractiveOverlay): void {
  if (o.eventId && registry.get(o.eventId) === o) registry.delete(o.eventId);
}

/** Route an interact frame to the matching live overlay. Returns true if delivered. */
export function dispatchInteract(interact: PopupInteract): boolean {
  const o = registry.get(interact.eventId);
  if (!o) return false;
  try {
    return o.applyInteract(interact);
  } catch {
    return false;
  }
}

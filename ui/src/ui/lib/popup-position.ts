/**
 * computePopupPosition — shared flip-aware positioning for fixed-position
 * dropdown menus anchored to a trigger button.
 *
 * The voice HUD control panel is draggable and usually parks bottom-left, so a
 * menu that always opens *downward* spills off the bottom of the viewport and
 * becomes unreachable. This helper picks "up" vs "down" based on available
 * space, clamps horizontally to stay on-screen, and returns a maxHeight so the
 * menu scrolls instead of overflowing.
 */

export type PopupPlacement = "up" | "down";

export interface PopupPos {
  top: number;
  left: number;
  /** Max height the menu may occupy before it should scroll internally. */
  maxHeight: number;
  placement: PopupPlacement;
}

export interface PopupPositionOpts {
  /** Menu width (used for horizontal clamping). Default 260. */
  width?: number;
  /** Estimated / measured menu height. Default 280. */
  height?: number;
  /** Gap between trigger and menu. Default 6. */
  gap?: number;
  /** Viewport margin to keep the menu off the edges. Default 8. */
  margin?: number;
}

export function computePopupPosition(rect: DOMRect, opts: PopupPositionOpts = {}): PopupPos {
  const gap = opts.gap ?? 6;
  const margin = opts.margin ?? 8;
  const width = opts.width ?? 260;
  const desired = opts.height ?? 280;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const spaceBelow = vh - rect.bottom - gap - margin;
  const spaceAbove = rect.top - gap - margin;

  // Open upward when there isn't room below for a reasonable menu and there's
  // more room above. Keeps the menu fully on-screen no matter where the
  // draggable panel sits.
  const minUseful = Math.min(desired, 180);
  const openUp = spaceBelow < minUseful && spaceAbove > spaceBelow;

  // Right-align to the trigger, then clamp into the viewport.
  let left = rect.right - width;
  if (left + width > vw - margin) left = vw - margin - width;
  if (left < margin) left = margin;

  if (openUp) {
    const maxHeight = Math.max(80, Math.min(desired, spaceAbove));
    return {
      top: Math.max(margin, rect.top - gap - maxHeight),
      left,
      maxHeight,
      placement: "up",
    };
  }

  const maxHeight = Math.max(80, Math.min(desired, spaceBelow));
  return { top: rect.bottom + gap, left, maxHeight, placement: "down" };
}

/**
 * A `position: fixed` element is positioned relative to the viewport ONLY when
 * no ancestor establishes a containing block. transform / filter /
 * backdrop-filter / perspective / will-change / contain all do — and the voice
 * HUD panel uses backdrop-filter for its glass look. When that happens, our
 * viewport coordinates must be translated into the containing block's local
 * space (subtract its top-left), or the menu lands off-screen.
 *
 * Walks up the flat tree (crossing shadow boundaries via the host) from `el`
 * and returns the offset of the nearest containing block, or {0,0} if none.
 */
export function containingBlockOffset(el: Element): { dx: number; dy: number } {
  let node: Element | null = el.parentElement ?? hostOf(el);
  while (node) {
    const cs = getComputedStyle(node);
    const wc = cs.willChange || "";
    const contain = cs.contain || "";
    if (
      cs.transform !== "none" ||
      cs.perspective !== "none" ||
      (cs.filter && cs.filter !== "none") ||
      (cs.backdropFilter && cs.backdropFilter !== "none") ||
      // @ts-expect-error - vendor-prefixed
      (cs.webkitBackdropFilter && cs.webkitBackdropFilter !== "none") ||
      wc.includes("transform") ||
      wc.includes("filter") ||
      wc.includes("perspective") ||
      contain.includes("paint") ||
      contain.includes("layout") ||
      contain === "strict" ||
      contain === "content"
    ) {
      const r = node.getBoundingClientRect();
      return { dx: r.left, dy: r.top };
    }
    node = node.parentElement ?? hostOf(node);
  }
  return { dx: 0, dy: 0 };
}

function hostOf(el: Element): Element | null {
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

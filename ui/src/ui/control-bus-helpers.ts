/**
 * Pure DOM helpers shared by control-bus-app-views.
 *
 * Extracted so they can be exercised by scripts/ui-control-smoke.mts
 * without dragging the entire bus registration (Lit, gateway client,
 * controllers) along for the ride.
 */

export type ScrollTarget =
    | { kind: "window"; element: null }
    | { kind: "element"; element: HTMLElement };

/**
 * Decide what `page.scroll_*` should move. If the document body itself
 * overflows, scrolling the window is correct. But most InfiniBot views
 * flex inside a non-scrolling shell and put their long content in an
 * inner pane with `overflow: auto` — calling window.scrollBy on those
 * does nothing because the document already fits. So we find the largest
 * overflowing container intersecting the viewport center and scroll that
 * instead, falling back to the window only when nothing better exists.
 */
export function pickScrollTarget(): ScrollTarget {
    if (typeof window === "undefined" || typeof document === "undefined") {
        return { kind: "window", element: null };
    }
    const docH = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    if (docH > window.innerHeight + 4) {
        return { kind: "window", element: null };
    }
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    let best: HTMLElement | null = null;
    let bestArea = 0;
    const all = document.body.querySelectorAll<HTMLElement>("*");
    for (const el of all) {
        if (el.scrollHeight <= el.clientHeight + 4) continue;
        const style = window.getComputedStyle(el);
        const oy = style.overflowY;
        if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) continue;
        if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
        const area = r.width * r.height;
        if (area > bestArea) { bestArea = area; best = el; }
    }
    return best ? { kind: "element", element: best } : { kind: "window", element: null };
}

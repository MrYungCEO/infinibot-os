/**
 * InfiniBar — collapsed-rail hover flyout.
 *
 * In slim icon-rail mode, hovering a tab opens a flyout showing the full label
 * + its group context. The flyout can't live inside the sidebar's scroll
 * container — `.nav-categories` has `overflow-y:auto` (which clips horizontal
 * overflow), and `.nav.enhanced`'s `backdrop-filter` re-bases any
 * `position:fixed` child into the sidebar's coordinate space (the documented
 * "fixed dropdown containing-block trap").
 *
 * So we mount ONE flyout element directly on <body> — free of any clipping or
 * containing-block ancestor — and position it in true viewport coordinates from
 * the hovered icon's bounding rect.
 */

let _el: HTMLDivElement | null = null;
let _hideTimer: ReturnType<typeof setTimeout> | null = null;

function ensureEl(): HTMLDivElement {
  if (_el) return _el;
  const el = document.createElement("div");
  el.className = "nav-flyout-pop";
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  _el = el;
  return el;
}

export function showNavFlyout(
  anchor: HTMLElement,
  info: {
    group: string;
    label: string;
    badge: number;
    /** "Needs setup" hint (nav-setup-status.ts) — also shown for expanded rows. */
    setup?: { state: string; text: string; action?: string };
  },
): void {
  if (typeof document === "undefined") return;
  if (_hideTimer) {
    clearTimeout(_hideTimer);
    _hideTimer = null;
  }
  const el = ensureEl();
  const badgeHtml =
    info.badge > 0
      ? `<span class="nav-flyout-pop__badge">${info.badge > 99 ? "99+" : info.badge}</span>`
      : "";
  // textContent-safe interpolation: group/label come from the tab catalog, not
  // user input, but escape defensively anyway.
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) =>
      c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
    );
  const setupHtml = info.setup
    ? `<span class="nav-flyout-pop__setup nav-flyout-pop__setup--${esc(info.setup.state)}"><span class="nav-flyout-pop__setup-dot"></span><span>${esc(info.setup.text)}</span></span>${
        info.setup.action ? `<span class="nav-flyout-pop__setup-action">${esc(info.setup.action)} →</span>` : ""
      }`
    : "";
  el.classList.toggle("nav-flyout-pop--setup", Boolean(info.setup));
  el.innerHTML = `<span class="nav-flyout-pop__group">${esc(info.group)}</span><span class="nav-flyout-pop__row"><span class="nav-flyout-pop__label">${esc(info.label)}</span>${badgeHtml}</span>${setupHtml}`;

  const r = anchor.getBoundingClientRect();
  // <body> may carry a CSS zoom (UI scale): rects are viewport px, left/top
  // on a body child are zoomed CSS px.
  const zoom = parseFloat(getComputedStyle(document.body).zoom);
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  // Beside the sidebar, vertically centered on the row — or below the chip
  // when the nav is the stacked top bar (≤1100px). Kept on screen.
  const row = window.matchMedia?.("(max-width: 1100px)").matches ?? false;
  el.classList.toggle("nav-flyout-pop--below", row);
  const vw = window.innerWidth / z;
  const w = el.offsetWidth || 0;
  const left = row ? r.left / z : r.right / z + 12;
  el.style.left = `${Math.round(row ? Math.min(Math.max(8, left), Math.max(8, vw - w - 8)) : left)}px`;
  el.style.top = `${Math.round(row ? r.bottom / z + 8 : (r.top + r.height / 2) / z)}px`;
  // Force reflow so the entry transition runs from the hidden state.
  void el.offsetWidth;
  el.classList.add("is-visible");
}

export function hideNavFlyout(): void {
  if (!_el) return;
  const el = _el;
  el.classList.remove("is-visible");
  if (_hideTimer) clearTimeout(_hideTimer);
  // Keep the node around (cheap) — just leave it hidden for reuse.
  _hideTimer = setTimeout(() => {
    el.innerHTML = "";
  }, 200);
}

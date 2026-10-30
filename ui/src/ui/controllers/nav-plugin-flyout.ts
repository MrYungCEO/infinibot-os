/**
 * Collapsed-rail flyout MENU for a plugin sidebar section.
 *
 * In icon-rail mode a plugin section collapses to its monogram tile; hovering
 * or activating the tile opens this menu listing the plugin's pages. Like the
 * label flyout (nav-collapsed-flyout.ts) it is mounted on <body> to escape the
 * sidebar's scroll clip and backdrop-filter containing block, but unlike that
 * one it is interactive: real links, arrow-key navigation, Escape to close.
 */

import { html, render } from "lit";

export type PluginFlyoutItem = {
  label: string;
  href: string;
  icon: unknown;
  active: boolean;
  /** "Needs setup" state of the page (nav-setup-status.ts), if any. */
  setup?: { state: string; text: string };
  onSelect: () => void;
};

export type PluginFlyoutSpec = {
  pluginId: string;
  title: string;
  monogram: string;
  accentStyle: string;
  items: PluginFlyoutItem[];
};

let _el: HTMLDivElement | null = null;
let _anchor: HTMLElement | null = null;
let _openId: string | null = null;
let _hideTimer: ReturnType<typeof setTimeout> | null = null;
let _docBound = false;

function ensureEl(): HTMLDivElement {
  if (_el) return _el;
  const el = document.createElement("div");
  el.className = "nav-plugin-flyout";
  el.addEventListener("mouseenter", cancelHide);
  el.addEventListener("mouseleave", () => scheduleHideNavPluginFlyout());
  el.addEventListener("keydown", onMenuKey);
  document.body.appendChild(el);
  _el = el;
  return el;
}

function cancelHide(): void {
  if (_hideTimer) {
    clearTimeout(_hideTimer);
    _hideTimer = null;
  }
}

function menuItems(): HTMLElement[] {
  return _el ? [..._el.querySelectorAll<HTMLElement>("[role=menuitem]")] : [];
}

function onMenuKey(e: KeyboardEvent): void {
  const items = menuItems();
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === "Escape") {
    e.preventDefault();
    const anchor = _anchor;
    hideNavPluginFlyout();
    anchor?.focus();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const next = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  } else if (e.key === "Home" || e.key === "End") {
    e.preventDefault();
    items[e.key === "Home" ? 0 : items.length - 1]?.focus();
  } else if (e.key === "Tab") {
    hideNavPluginFlyout();
  }
}

function bindDocument(): void {
  if (_docBound) return;
  _docBound = true;
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (!_openId) return;
      const t = e.target as Node;
      if (_el?.contains(t) || _anchor?.contains(t)) return;
      hideNavPluginFlyout();
    },
    true,
  );
}

function bodyZoom(): number {
  const z = parseFloat(getComputedStyle(document.body).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

export function isNavPluginFlyoutOpen(pluginId?: string): boolean {
  return pluginId ? _openId === pluginId : _openId !== null;
}

/** Open (or re-point) the menu next to `anchor`. `focusFirst` for keyboard opens. */
export function showNavPluginFlyout(anchor: HTMLElement, spec: PluginFlyoutSpec, focusFirst = false): void {
  if (typeof document === "undefined") return;
  cancelHide();
  bindDocument();
  const el = ensureEl();
  if (_anchor && _anchor !== anchor) _anchor.setAttribute("aria-expanded", "false");
  _anchor = anchor;
  _openId = spec.pluginId;
  anchor.setAttribute("aria-expanded", "true");
  const menuId = `nav-plugin-flyout-${spec.pluginId}`;
  el.id = menuId;
  anchor.setAttribute("aria-controls", menuId);
  el.setAttribute("style", spec.accentStyle);
  el.dataset.pluginFlyout = spec.pluginId;
  render(
    html`<div class="nav-plugin-flyout__head">
        <span class="nav-plugin-mark" aria-hidden="true">${spec.monogram}</span>
        <span class="nav-plugin-flyout__title">${spec.title}</span>
      </div>
      <div class="nav-plugin-flyout__list" role="menu" aria-label=${`${spec.title} pages`}>
        ${spec.items.map(
          (it) => html`<a
            role="menuitem"
            class="nav-plugin-flyout__item ${it.active ? "is-active" : ""} ${it.setup ? `nav-plugin-flyout__item--setup nav-plugin-flyout__item--setup-${it.setup.state}` : ""}"
            href=${it.href}
            title=${it.setup ? it.setup.text : ""}
            aria-description=${it.setup ? it.setup.text : ""}
            aria-current=${it.active ? "page" : "false"}
            @click=${(e: MouseEvent) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              hideNavPluginFlyout();
              it.onSelect();
            }}
            ><span class="nav-plugin-flyout__icon" aria-hidden="true">${it.icon}</span
            ><span>${it.label}</span
            >${it.setup ? html`<span class="nav-plugin-flyout__setup-dot" aria-hidden="true"></span>` : ""}</a
          >`,
        )}
      </div>`,
    el,
  );
  // <body> may carry a CSS zoom (UI scale): rects are in viewport px, but
  // left/top on a body child are in its zoomed CSS px.
  const z = bodyZoom();
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth / z;
  const vh = window.innerHeight / z;
  const w = el.offsetWidth || 0;
  const h = el.offsetHeight || 0;
  // Beside the rail normally; below the chip when the nav is a horizontal
  // row (≤1100px). Always kept fully on screen.
  const row = window.matchMedia?.("(max-width: 1100px)").matches ?? false;
  const left = row ? r.left / z : r.right / z + 12;
  const top = row ? r.bottom / z + 8 : r.top / z;
  el.style.left = `${Math.round(Math.min(Math.max(8, left), Math.max(8, vw - w - 8)))}px`;
  el.style.top = `${Math.round(Math.min(Math.max(8, top), Math.max(8, vh - h - 8)))}px`;
  void el.offsetWidth;
  el.classList.add("is-visible");
  if (focusFirst) (menuItems().find((m) => m.classList.contains("is-active")) ?? menuItems()[0])?.focus();
}

export function scheduleHideNavPluginFlyout(delay = 160): void {
  cancelHide();
  _hideTimer = setTimeout(() => {
    _hideTimer = null;
    // Keep it open while keyboard focus is inside the menu.
    if (_el?.contains(document.activeElement)) return;
    hideNavPluginFlyout();
  }, delay);
}

export function hideNavPluginFlyout(): void {
  cancelHide();
  if (!_el) return;
  _el.classList.remove("is-visible");
  _anchor?.setAttribute("aria-expanded", "false");
  _anchor = null;
  _openId = null;
}

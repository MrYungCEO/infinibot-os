/**
 * Control bar (topbar) layout — priority-based responsive behaviour.
 *
 * The topbar keeps its three-column grid (left group · centred clock · right
 * group). Each side gets exactly its grid track; when a side's controls don't
 * fit, they degrade one step at a time in a fixed priority order instead of
 * overlapping the clock or each other:
 *
 *   1. drop secondary text (page title, brand wordmark, button labels → icons),
 *   2. shorten selectors (agency name ellipsised, coder pill → logo),
 *   3. move whole controls into the "⋯" overflow menu.
 *
 * The bell, the sidebar toggle, the brand logo and the clock never leave the
 * bar. Everything moved into the menu stays usable from there: buttons are
 * proxied (the menu row clicks the real control) and <select>s are mirrored.
 *
 * `planControlBar` is the pure planner (unit tested). The DOM layer measures
 * each control at each level, runs the planner and applies the result as
 * `data-cb-level` / `data-cb-hidden` attributes — only when the bar's width or
 * contents change (it is called from every app render, which ticks at 1 Hz).
 *
 * Markup contract (app-render.ts): `<header class="topbar" data-cb>`, controls
 * carry `data-cb-item="<id>"`, and `<div class="cb-more" data-cb-more>` sits at
 * the end of `.topbar-status`.
 */

import { html, nothing, render, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

import { ensureControlBarStyles } from "./control-bar.styles";

// ── the plan ─────────────────────────────────────────────────────────────

export type CbSide = "left" | "right";

export type CbItemSpec = {
  id: string;
  side: CbSide;
  /** Degrade order of each level ≥ 1 (lower degrades first). */
  orders: number[];
  /** The last level removes the control from the bar (into the menu). */
  lastHidden: boolean;
  /** Menu label when hidden (falls back to aria-label / title / text). */
  label?: string;
  /**
   * false: hiding it just drops it (informational — the page title is on the
   * page and in the sidebar), so it never summons the ⋯ menu by itself.
   */
  menu?: boolean;
};

/**
 * Every control the planner manages. Controls not listed (nav toggle, bell,
 * clock) are pinned. Orders are global, so the same step always goes first:
 * labels shrink before selectors, selectors before anything is moved away.
 */
export const CONTROL_BAR_ITEMS: readonly CbItemSpec[] = [
  // ── left group ──
  { id: "tabctx", side: "left", orders: [8, 10], lastHidden: true, label: "Page", menu: false },
  { id: "federation", side: "left", orders: [12], lastHidden: true, label: "Connected UI tabs" },
  // Cross-node device switcher: stays after the tab pills fold away.
  { id: "devices", side: "left", orders: [78], lastHidden: true, label: "Devices" },
  { id: "brand", side: "left", orders: [20], lastHidden: false },
  { id: "coder", side: "left", orders: [30, 70], lastHidden: true, label: "Coding backend" },
  { id: "health", side: "left", orders: [40, 50, 75], lastHidden: true, label: "Gateway health" },
  { id: "instance", side: "left", orders: [45, 76], lastHidden: true, label: "Instance" },
  { id: "satellite", side: "left", orders: [46, 77], lastHidden: true, label: "Satellite link" },
  { id: "agency", side: "left", orders: [55, 80], lastHidden: true, label: "Agency" },
  // ── right group ──
  { id: "language", side: "right", orders: [15], lastHidden: true, label: "Language" },
  { id: "newwindow", side: "right", orders: [16], lastHidden: true, label: "Open new window" },
  { id: "restart", side: "right", orders: [22, 62], lastHidden: true, label: "Restart gateway" },
  { id: "canvas", side: "right", orders: [24, 64], lastHidden: true, label: "Canvas" },
  { id: "chart", side: "right", orders: [26, 66], lastHidden: true, label: "Chart" },
  { id: "chat", side: "right", orders: [28, 68], lastHidden: true, label: "Chat with an agent" },
  { id: "live", side: "right", orders: [32, 82], lastHidden: true, label: "Live Action" },
  // Right-placed plugin topbar slots (e.g. the Solatrix wallet chip): drop the
  // USD/24h detail early, move to the ⋯ menu only after the big buttons.
  { id: "plugin-right", side: "right", orders: [21, 72], lastHidden: true, label: "Wallet" },
  { id: "learn", side: "right", orders: [63], lastHidden: true, label: "Learn" },
  { id: "agent", side: "right", orders: [65], lastHidden: true, label: "Agent sidebar" },
  { id: "activity", side: "right", orders: [67], lastHidden: true, label: "Agent activity" },
  // Pending approvals never move into the overflow menu.
  { id: "approvals", side: "right", orders: [69], lastHidden: false, label: "Approvals" },
];

export type PlanItem = {
  id: string;
  side: CbSide;
  /** Width at level 0..n (the hidden level, if any, is 0). */
  widths: number[];
  orders: number[];
  lastHidden: boolean;
  /** Hidden without a menu entry (does not count as overflow). */
  dropOnly?: boolean;
};

export type PlanInput = {
  items: PlanItem[];
  /** Width available to each side's group. */
  budgets: Record<CbSide, number>;
  /** Fixed width already used on each side by pinned controls (incl. their gaps). */
  pinned?: Partial<Record<CbSide, number>>;
  gap: number;
  /** Width of the ⋯ button (right side) once anything is hidden. */
  moreWidth: number;
};

export type Plan = {
  levels: Record<string, number>;
  /** Everything removed from the bar. */
  hidden: string[];
  /** The subset that lives in the ⋯ menu. */
  overflow: string[];
};

/** Width a side needs at the given levels. */
export function sideWidth(input: PlanInput, side: CbSide, levels: Record<string, number>, anyHidden: boolean): number {
  let total = input.pinned?.[side] ?? 0;
  let count = 0;
  for (const it of input.items) {
    if (it.side !== side) continue;
    const w = it.widths[levels[it.id] ?? 0] ?? 0;
    const hidden = it.lastHidden && (levels[it.id] ?? 0) === it.widths.length - 1;
    if (hidden || w <= 0) continue;
    total += w;
    count++;
  }
  if (side === "right" && anyHidden) {
    total += input.moreWidth;
    count++;
  }
  // Gaps between the managed controls, plus one to the pinned block.
  if (count > 0) total += input.gap * (count - (input.pinned?.[side] ? 0 : 1));
  return total;
}

/**
 * Degrade controls, lowest order first, until both sides fit their budgets.
 * Only steps on a side that still overflows are taken, so a crowded right
 * side never strips labels off the left. Pure and deterministic.
 */
export function planControlBar(input: PlanInput): Plan {
  const levels: Record<string, number> = {};
  for (const it of input.items) levels[it.id] = 0;
  const steps = input.items
    .flatMap((it) => it.orders.slice(0, it.widths.length - 1).map((order, i) => ({ it, level: i + 1, order })))
    .sort((a, b) => a.order - b.order || a.it.id.localeCompare(b.it.id));
  const isHidden = (it: PlanItem) => it.lastHidden && levels[it.id] === it.widths.length - 1;
  const anyHidden = () => input.items.some((it) => isHidden(it) && !it.dropOnly);
  const overflows = (side: CbSide) => sideWidth(input, side, levels, anyHidden()) > input.budgets[side] + 0.5;

  for (let guard = 0; guard < steps.length + 2; guard++) {
    const sides = (["left", "right"] as const).filter(overflows);
    if (!sides.length) break;
    const step = steps.find((s) => sides.includes(s.it.side) && levels[s.it.id] === s.level - 1);
    if (!step) break;
    levels[step.it.id] = step.level;
  }
  const hidden = input.items.filter(isHidden);
  return { levels, hidden: hidden.map((it) => it.id), overflow: hidden.filter((it) => !it.dropOnly).map((it) => it.id) };
}

// ── DOM layer ────────────────────────────────────────────────────────────

const SPEC_BY_ID = new Map(CONTROL_BAR_ITEMS.map((s) => [s.id, s]));

let rafId = 0;
let timerId = 0;
let pending = false;
let lastSignature = "";
let observer: ResizeObserver | null = null;
let observed: Element | null = null;
let hiddenIds: string[] = [];
let menuOpen = false;
let menuListeners: { down: (e: Event) => void; key: (e: KeyboardEvent) => void } | null = null;

function itemEl(bar: Element, id: string): HTMLElement | null {
  return bar.querySelector<HTMLElement>(`[data-cb-item="${id}"]`);
}

/**
 * A slot whose renderer returned nothing takes no part in the layout. A
 * custom-element control that has nothing to show marks itself
 * `data-cb-empty` (its content lives in shadow DOM, so it can't be counted).
 */
function isPresent(el: HTMLElement): boolean {
  if (el.childElementCount === 0 && !el.textContent?.trim()) return false;
  const leaves = el.querySelectorAll<HTMLElement>("*:not(.topbar-slot)");
  if (leaves.length > 0 && !el.textContent?.trim() && [...leaves].every((n) => n.hasAttribute("data-cb-empty"))) {
    return false;
  }
  return true;
}

function signature(bar: HTMLElement): string {
  const parts = [String(Math.round(bar.getBoundingClientRect().width)), String(window.innerWidth)];
  for (const el of bar.querySelectorAll<HTMLElement>("[data-cb-item]")) {
    parts.push(
      `${el.dataset.cbItem}:${el.textContent?.trim().length ?? 0}:${el.childElementCount}:${el.querySelectorAll("[data-cb-empty]").length}`,
    );
  }
  return parts.join("|");
}

/**
 * True when a group's controls need more room than its track. Measured, not
 * scrollWidth: the right group is end-aligned, so it spills toward the start
 * edge, which scrollWidth never reports.
 */
function groupOverflows(bar: HTMLElement): boolean {
  for (const g of bar.querySelectorAll<HTMLElement>(":scope > .topbar-left, :scope > .topbar-status")) {
    const scale = g.getBoundingClientRect().width / (g.offsetWidth || 1) || 1;
    const gap = (parseFloat(getComputedStyle(g).columnGap) || 0) * scale;
    let total = 0;
    let n = 0;
    for (const child of g.children) {
      const w = child.getBoundingClientRect().width;
      if (w <= 0) continue;
      total += w;
      n++;
    }
    if (total + Math.max(0, n - 1) * gap > g.getBoundingClientRect().width + 1) return true;
  }
  return false;
}

let fontsHooked = false;

/**
 * Re-plan on the next frame if the bar's width or contents changed. Cheap to
 * call on every render.
 */
export function scheduleControlBarLayout(): void {
  if (typeof window === "undefined" || pending) return;
  ensureControlBarStyles();
  if (!fontsHooked && typeof document !== "undefined" && document.fonts?.ready) {
    fontsHooked = true;
    void document.fonts.ready.then(() => {
      lastSignature = "";
      scheduleControlBarLayout();
    });
  }
  pending = true;
  // rAF normally; the timer covers background tabs, where rAF is paused and
  // a resize would otherwise leave the old plan (and overlaps) in place.
  const run = () => {
    if (!pending) return;
    pending = false;
    window.cancelAnimationFrame(rafId);
    window.clearTimeout(timerId);
    runLayoutPass();
  };
  rafId = window.requestAnimationFrame(run);
  timerId = window.setTimeout(run, 150);
}

function runLayoutPass(): void {
  const bar = document.querySelector<HTMLElement>("header.topbar[data-cb]");
  if (!bar) return;
  if (observed !== bar) {
    observer?.disconnect();
    observer = new ResizeObserver(() => scheduleControlBarLayout());
    observer.observe(bar);
    observed = bar;
  }
  if (menuOpen) renderMenu(bar);
  const sig = signature(bar);
  // Contents can grow without changing the signature (custom elements
  // rendering late, web fonts arriving): re-plan whenever a group spills.
  if (sig === lastSignature && !groupOverflows(bar)) return;
  layoutControlBar(bar);
  lastSignature = signature(bar);
}

/** Measure, plan and apply. Exported for the dev console / harness. */
export function layoutControlBar(bar: HTMLElement): Plan {
  const left = bar.querySelector<HTMLElement>(".topbar-left");
  const right = bar.querySelector<HTMLElement>(".topbar-status");
  const more = bar.querySelector<HTMLElement>("[data-cb-more]");
  if (!left || !right) return { levels: {}, hidden: [], overflow: [] };

  if (more && !more.childElementCount) renderMenu(bar);
  bar.setAttribute("data-cb-measuring", "");
  // Rects include the body zoom used at some widths; CSS gaps don't.
  const scale = bar.getBoundingClientRect().width / (bar.offsetWidth || 1) || 1;
  const cs = getComputedStyle(bar);
  const inner = (bar.getBoundingClientRect().width) - (parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)) * scale;
  bar.dataset.cbClock = inner < 860 * scale ? "compact" : "full";
  const gap = (parseFloat(getComputedStyle(right).columnGap) || 8) * scale;

  const items: PlanItem[] = [];
  for (const spec of CONTROL_BAR_ITEMS) {
    const el = itemEl(bar, spec.id);
    if (!el) continue;
    el.removeAttribute("data-cb-hidden");
    if (!isPresent(el)) {
      el.dataset.cbLevel = "0";
      continue;
    }
    const levelCount = spec.orders.length + 1;
    const widths: number[] = [];
    for (let lvl = 0; lvl < levelCount; lvl++) {
      if (spec.lastHidden && lvl === levelCount - 1) {
        widths.push(0);
        continue;
      }
      el.dataset.cbLevel = String(lvl);
      widths.push(el.getBoundingClientRect().width);
    }
    items.push({
      id: spec.id,
      side: spec.side,
      widths,
      orders: spec.orders,
      lastHidden: spec.lastHidden,
      ...(spec.menu === false ? { dropOnly: true } : {}),
    });
  }
  // Pinned controls: everything in a group that the planner doesn't manage.
  const pinnedWidth = (group: HTMLElement): number => {
    let total = 0;
    let n = 0;
    for (const child of group.children) {
      const el = child as HTMLElement;
      if (el.dataset.cbItem || el.hasAttribute("data-cb-more") || el.tagName === "STYLE") continue;
      const w = el.getBoundingClientRect().width;
      if (w <= 0) continue;
      total += w;
      n++;
    }
    return total + Math.max(0, n - 1) * gap;
  };
  const moreWidth = more ? more.getBoundingClientRect().width : 44;
  const budgets = { left: left.getBoundingClientRect().width, right: right.getBoundingClientRect().width };
  const plan = planControlBar({
    items,
    budgets,
    pinned: { left: pinnedWidth(left), right: pinnedWidth(right) },
    gap,
    moreWidth,
  });
  bar.removeAttribute("data-cb-measuring");

  for (const it of items) {
    const el = itemEl(bar, it.id);
    if (!el) continue;
    const lvl = plan.levels[it.id] ?? 0;
    el.dataset.cbLevel = String(lvl);
    if (plan.hidden.includes(it.id)) el.setAttribute("data-cb-hidden", "");
    else el.removeAttribute("data-cb-hidden");
  }
  hiddenIds = plan.overflow;
  bar.toggleAttribute("data-cb-overflowing", plan.overflow.length > 0);
  if (!plan.overflow.length) menuOpen = false;
  renderMenu(bar);
  return plan;
}

// ── overflow menu ────────────────────────────────────────────────────────

function labelOf(el: HTMLElement, spec: CbItemSpec | undefined): string {
  const inner = el.matches("button, a, select, [role=button]") ? el : el.querySelector<HTMLElement>("button, a, select, [title], [aria-label]");
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return (
    inner?.getAttribute("aria-label") ||
    inner?.getAttribute("title") ||
    el.getAttribute("title") ||
    (text && text.length <= 28 ? text : "") ||
    spec?.label ||
    el.dataset.cbItem ||
    ""
  );
}

const svgIcon = (body: string) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/** Icons for controls that have none of their own (dots, selects, pills). */
const FALLBACK_ICONS: Record<string, string> = {
  language: svgIcon('<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20z"/>'),
  federation: svgIcon('<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18"/>'),
  devices: svgIcon('<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>'),
  health: svgIcon('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  agency: svgIcon('<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  "plugin-right": svgIcon('<path d="M20 7H5a2 2 0 0 1 0-4h13v4"/><path d="M3 5v14a2 2 0 0 0 2 2h15V7"/><circle cx="16" cy="14" r="1.5"/>'),
};

function iconOf(el: HTMLElement): string {
  const own = FALLBACK_ICONS[el.dataset.cbItem ?? ""];
  if (own) return own;
  const svg = el.querySelector("svg:not([class*='chev'])");
  if (svg) return svg.outerHTML;
  const img = el.querySelector("img");
  return img ? `<img src="${img.getAttribute("src") ?? ""}" alt="" />` : "";
}

function closeMenu(bar?: HTMLElement | null): void {
  menuOpen = false;
  if (menuListeners) {
    document.removeEventListener("pointerdown", menuListeners.down, true);
    document.removeEventListener("keydown", menuListeners.key, true);
    menuListeners = null;
  }
  const b = bar ?? document.querySelector<HTMLElement>("header.topbar[data-cb]");
  if (b) renderMenu(b);
}

function openMenu(bar: HTMLElement): void {
  menuOpen = true;
  if (!menuListeners) {
    menuListeners = {
      down: (e: Event) => {
        const path = e.composedPath?.() ?? [];
        if (!path.some((n) => n instanceof HTMLElement && n.hasAttribute("data-cb-more"))) closeMenu();
      },
      key: (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        closeMenu();
        document.querySelector<HTMLElement>(".cb-more__btn")?.focus();
      },
    };
    document.addEventListener("pointerdown", menuListeners.down, true);
    document.addEventListener("keydown", menuListeners.key, true);
  }
  renderMenu(bar);
  requestAnimationFrame(() => document.querySelector<HTMLElement>(".cb-more__menu [role=menuitem], .cb-more__menu select")?.focus());
}

function renderEntry(bar: HTMLElement, id: string): TemplateResult | typeof nothing {
  const el = itemEl(bar, id);
  if (!el) return nothing;
  const spec = SPEC_BY_ID.get(id);
  const select = el.querySelector<HTMLSelectElement>("select");
  const icon = iconOf(el);
  if (select) {
    const opts = [...select.options];
    return html`<label class="cb-more__row cb-more__row--select">
      <span class="cb-more__icon" aria-hidden="true">${icon ? unsafeHTML(icon) : nothing}</span>
      <span class="cb-more__text">${spec?.label ?? labelOf(el, spec)}</span>
      <select
        class="cb-more__select"
        title=${select.selectedOptions[0]?.textContent?.trim() ?? ""}
        aria-label=${spec?.label ?? labelOf(el, spec)}
        ?disabled=${select.disabled}
        @change=${(e: Event) => {
          select.value = (e.target as HTMLSelectElement).value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          closeMenu(bar);
        }}
      >
        ${opts.map((o) => html`<option value=${o.value} ?selected=${o.value === select.value}>${o.textContent?.trim()}</option>`)}
      </select>
    </label>`;
  }
  // `data-cb-proxy-target`: a custom element whose button lives in its shadow
  // root and that handles a host click itself (e.g. plugin topbar slots).
  const target = el.matches("button, a, [role=button], .pill") ? el : el.querySelector<HTMLElement>("[data-cb-proxy-target], button, a, [role=button], .pill");
  const label = labelOf(el, spec);
  // Status controls show their current value next to the label.
  const valueEl = el.querySelector<HTMLElement>(".topbar-coder-label, .instance-name, .topbar-satellite-label") ?? el;
  const detail = id === "health" || id === "instance" || id === "satellite" || id === "coder" || id === "federation"
    ? (valueEl.textContent ?? "").replace(/\s+/g, " ").trim()
    : "";
  return html`<button
    type="button"
    role="menuitem"
    class="cb-more__row"
    data-cb-proxy=${id}
    @click=${() => {
      closeMenu(bar);
      target?.click();
    }}
  >
    <span class="cb-more__icon" aria-hidden="true">${icon ? unsafeHTML(icon) : nothing}</span>
    <span class="cb-more__text">${spec?.label ?? label}</span>
    ${detail && detail !== spec?.label ? html`<span class="cb-more__detail">${detail}</span>` : nothing}
  </button>`;
}

function renderMenu(bar: HTMLElement): void {
  const host = bar.querySelector<HTMLElement>("[data-cb-more]");
  if (!host) return;
  // Right-side controls first, in bar order; then left-side ones.
  const order = [...CONTROL_BAR_ITEMS.filter((s) => s.side === "right").reverse(), ...CONTROL_BAR_ITEMS.filter((s) => s.side === "left")];
  const ids = order.map((s) => s.id).filter((id) => hiddenIds.includes(id));
  render(
    html`<button
        type="button"
        class="cb-more__btn topbar-glass-btn topbar-glass-btn--icon ${menuOpen ? "active" : ""}"
        aria-haspopup="menu"
        aria-expanded=${menuOpen ? "true" : "false"}
        aria-label="More controls (${ids.length})"
        title="More controls"
        @click=${() => (menuOpen ? closeMenu(bar) : openMenu(bar))}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle>
        </svg>
      </button>
      ${menuOpen && ids.length
        ? html`<div class="cb-more__menu" role="menu" aria-label="More controls">${ids.map((id) => renderEntry(bar, id))}</div>`
        : nothing}`,
    host,
  );
}

/** Test hook. */
export function resetControlBarForTests(): void {
  lastSignature = "";
  hiddenIds = [];
  menuOpen = false;
}

/**
 * Launchpad — a macOS-Launchpad-meets-command-palette page switcher.
 *
 * An ADDITIVE full-screen modal overlay that surfaces every OS page as a
 * stylish card, grouped by nav section, with a big centric fuzzy-search input.
 * It does NOT replace the sidebar collapse/expand behaviour — it sits on top of
 * it as an overlay opened from a dedicated trigger button (see
 * nav-sidebar-enhanced.ts) or the Cmd/Ctrl+P keyboard shortcut.
 *
 * The page list is derived DYNAMICALLY from the nav registry (NAV_CATALOG_GROUPS +
 * titleForTab / subtitleForTab / iconForTab / pathForTab), so pages added to
 * navigation.ts appear here automatically with no edits to this file.
 */

import { html, nothing, type TemplateResult } from "lit";
import { NAV_CATALOG_GROUPS, type Tab } from "../navigation";
import { isPluginGatedTab, isTabAvailable, pluginNavSections, pluginSectionOfTab } from "../plugin-host.js";
import {
  iconForTab,
  titleForTab,
  subtitleForTab,
  pathForTab,
  groupLabel,
} from "../navigation";
import { icons } from "../icons";
import { ensureHomeGlassStyles } from "./home-glass";
import type { NavSidebarState } from "../controllers/nav-sidebar.js";
import { getNavTabDisplayName, isFavorite, toggleFavorite, visibleFavorites } from "../controllers/nav-sidebar.js";

// ============================================================
// Open/close store (module-level, lightweight)
// ============================================================

let _open = false;
let _query = "";
let _selIndex = 0;
let _shouldFocus = false;
let _contextMenu: { tab: Tab; x: number; y: number } | null = null;
// Latest requestUpdate hook — refreshed on every render / trigger so the
// global keyboard listener can force a re-render from outside the render tree.
let _requestUpdate: (() => void) | null = null;

export function isLaunchpadOpen(): boolean {
  return _open;
}

export function openLaunchpad(): void {
  if (_open) return;
  _open = true;
  _query = "";
  _selIndex = 0;
  _shouldFocus = true;
  _requestUpdate?.();
}

export function closeLaunchpad(): void {
  if (!_open) return;
  _open = false;
  _query = "";
  _selIndex = 0;
  _contextMenu = null;
  _requestUpdate?.();
}

export function toggleLaunchpad(): void {
  _open ? closeLaunchpad() : openLaunchpad();
}

// ============================================================
// Page catalogue — derived from the nav registry
// ============================================================

interface LaunchpadItem {
  tab: Tab;
  title: string;
  subtitle: string;
  path: string;
  group: string;
  icon: TemplateResult | typeof nothing;
  /** haystack for substring filtering (lowercased) */
  hay: string;
  /** lowercased title for typo-tolerant subsequence matching */
  titleLc: string;
}

interface LaunchpadGroup {
  label: string;
  items: LaunchpadItem[];
}

/**
 * Build the grouped catalogue from NAV_CATALOG_GROUPS (sidebar tabs plus the
 * retired/hidden pages they host, so every page stays searchable). Duplicate tab ids across groups
 * (a handful exist in the registry) are de-duped so a page shows once, in the
 * first group that lists it. Respects the multi-user page allowlist.
 */
function buildCatalogue(
  basePath: string,
  isPageAllowed?: (tab: Tab) => boolean,
  navState?: NavSidebarState,
): LaunchpadGroup[] {
  const seen = new Set<string>();
  const groups: LaunchpadGroup[] = [];
  if (navState) {
    const favorites = visibleFavorites(navState, (tab) =>
      isTabAvailable(tab) && (!isPageAllowed || isPageAllowed(tab)),
    ).map((tab) => {
      const plugin = pluginSectionOfTab(tab);
      const item = plugin?.items.find((candidate) => candidate.tab === tab);
      const title = getNavTabDisplayName(navState, tab, item?.label ?? titleForTab(tab));
      const subtitle = plugin ? `${plugin.title} plugin` : subtitleForTab(tab);
      const path = pathForTab(tab, basePath);
      seen.add(tab);
      return {
        tab,
        title,
        subtitle,
        path,
        group: "Favorites",
        icon: icons[iconForTab(tab)] ?? nothing,
        hay: `${title} ${subtitle} ${path} favorites ${tab}`.toLowerCase(),
        titleLc: title.toLowerCase(),
      } satisfies LaunchpadItem;
    });
    if (favorites.length) groups.push({ label: "Favorites", items: favorites });
  }
  // Plugin-gated tabs are never catalogued here: an enabled plugin's pages
  // come from its own section below, a disabled plugin's don't show at all.
  for (const g of NAV_CATALOG_GROUPS) {
    const items: LaunchpadItem[] = [];
    for (const rawTab of g.tabs) {
      const tab = rawTab as Tab;
      if (seen.has(tab) || isPluginGatedTab(tab)) continue;
      if (isPageAllowed && !isPageAllowed(tab)) continue;
      seen.add(tab);
      const title = titleForTab(tab);
      const subtitle = subtitleForTab(tab);
      const path = pathForTab(tab, basePath);
      const label = groupLabel(g.label);
      items.push({
        tab,
        title,
        subtitle,
        path,
        group: label,
        icon: icons[iconForTab(tab)] ?? nothing,
        hay: `${title} ${subtitle} ${path} ${label} ${tab}`.toLowerCase(),
        titleLc: title.toLowerCase(),
      });
    }
    if (items.length) groups.push({ label: groupLabel(g.label), items });
  }
  // Each enabled plugin's pages, grouped under the plugin's name (same
  // sections the sidebar shows; a disabled plugin contributes nothing).
  for (const section of pluginNavSections()) {
    const items: LaunchpadItem[] = [];
    for (const it of section.items) {
      if (seen.has(it.tab)) continue;
      if (isPageAllowed && !isPageAllowed(it.tab)) continue;
      seen.add(it.tab);
      const subtitle = it.title && it.title !== it.label ? it.title : `${section.title} plugin`;
      const path = pathForTab(it.tab, basePath);
      const declared = it.icon ? (icons as Record<string, TemplateResult | undefined>)[it.icon] : undefined;
      items.push({
        tab: it.tab,
        title: it.label,
        subtitle,
        path,
        group: section.title,
        icon: declared ?? icons[iconForTab(it.tab)] ?? nothing,
        hay: `${it.label} ${subtitle} ${path} ${section.title} ${section.pluginId} ${it.tab}`.toLowerCase(),
        titleLc: it.label.toLowerCase(),
      });
    }
    if (items.length) groups.push({ label: section.title, items });
  }
  return groups;
}

/** True when every query char appears in order in `s` (subsequence match). */
function isSubsequence(s: string, q: string): boolean {
  let i = 0;
  for (const ch of s) {
    if (ch === q[i]) {
      i++;
      if (i === q.length) return true;
    }
  }
  return i === q.length;
}

/**
 * Match an item against the query. Substring anywhere in the full haystack
 * (title / subtitle / route / group / tab) OR a typo-tolerant subsequence match
 * against the short title only. Subsequence is deliberately NOT run over the
 * whole haystack — the long subtitle prose would make almost any query match.
 */
function itemMatches(it: LaunchpadItem, q: string): boolean {
  if (!q) return true;
  if (it.hay.includes(q)) return true;
  return isSubsequence(it.titleLc, q);
}

function filterGroups(
  groups: LaunchpadGroup[],
  q: string,
): { groups: LaunchpadGroup[]; flat: LaunchpadItem[] } {
  const query = q.trim().toLowerCase();
  const flat: LaunchpadItem[] = [];
  const out: LaunchpadGroup[] = [];
  for (const g of groups) {
    const items = query
      ? g.items.filter((it) => itemMatches(it, query))
      : g.items;
    if (items.length) {
      out.push({ label: g.label, items });
      flat.push(...items);
    }
  }
  return { groups: out, flat };
}

// ============================================================
// Keyboard navigation
// ============================================================

/** Best-effort column count of the live grid for ↑/↓ row movement. */
function measureColumns(): number {
  const grid = document.querySelector<HTMLElement>("[data-launchpad-grid]");
  if (!grid) return 1;
  const cards = grid.querySelectorAll<HTMLElement>("[data-lp-card]");
  if (cards.length < 2) return 1;
  const firstTop = cards[0]!.offsetTop;
  let cols = 0;
  for (const c of cards) {
    if (c.offsetTop !== firstTop) break;
    cols++;
  }
  return Math.max(1, cols);
}

/**
 * Handle navigation keys while the Launchpad is open. Returns true when the
 * event was consumed. Wired from the global keydown listener below.
 */
function handleNavKey(
  e: KeyboardEvent,
  flatLen: number,
  onSelect: (index: number) => void,
): boolean {
  if (!_open) return false;
  switch (e.key) {
    case "Escape":
      closeLaunchpad();
      return true;
    case "Enter":
      if (flatLen > 0) onSelect(Math.min(_selIndex, flatLen - 1));
      return true;
    case "ArrowRight":
      if (flatLen > 0) {
        _selIndex = Math.min(_selIndex + 1, flatLen - 1);
        _requestUpdate?.();
      }
      return true;
    case "ArrowLeft":
      if (flatLen > 0) {
        _selIndex = Math.max(_selIndex - 1, 0);
        _requestUpdate?.();
      }
      return true;
    case "ArrowDown": {
      if (flatLen > 0) {
        const cols = measureColumns();
        _selIndex = Math.min(_selIndex + cols, flatLen - 1);
        _requestUpdate?.();
      }
      return true;
    }
    case "ArrowUp": {
      if (flatLen > 0) {
        const cols = measureColumns();
        _selIndex = Math.max(_selIndex - cols, 0);
        _requestUpdate?.();
      }
      return true;
    }
    default:
      return false;
  }
}

// One-time global keydown wiring: Cmd/Ctrl+P toggles the Launchpad from
// anywhere. Cmd/Ctrl+K stays owned by the sidebar tab-search (untouched).
let _shortcutBound = false;
// Reference to the current onSelect closure so the global listener can act on
// the up-to-date navigation callback / filtered list.
let _liveNav: { flatLen: number; onSelect: (index: number) => void } = {
  flatLen: 0,
  onSelect: () => {},
};

function ensureLaunchpadShortcut(): void {
  if (_shortcutBound || typeof window === "undefined") return;
  _shortcutBound = true;
  window.addEventListener(
    "keydown",
    (e) => {
      const isCmdP =
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "p" || e.key === "P");
      if (isCmdP) {
        e.preventDefault(); // stop the browser Print dialog
        toggleLaunchpad();
        return;
      }
      if (_open) {
        const consumed = handleNavKey(e, _liveNav.flatLen, _liveNav.onSelect);
        if (consumed) e.preventDefault();
      }
    },
    // capture so we beat page-level handlers (and print) reliably.
    true,
  );
}

// ============================================================
// Render
// ============================================================

export interface LaunchpadProps {
  basePath: string;
  currentTab: Tab;
  onTabSelect: (tab: Tab) => void;
  requestUpdate?: () => void;
  isPageAllowed?: (tab: Tab) => boolean;
  navState: NavSidebarState;
  onNavStateChange: (state: NavSidebarState) => void;
}

export function renderLaunchpad(props: LaunchpadProps) {
  ensureHomeGlassStyles();
  _requestUpdate = props.requestUpdate ?? null;
  ensureLaunchpadShortcut();
  if (!_open) return nothing;

  const catalogue = buildCatalogue(props.basePath, props.isPageAllowed, props.navState);
  const { groups, flat } = filterGroups(catalogue, _query);
  if (_selIndex > flat.length - 1) _selIndex = Math.max(0, flat.length - 1);

  const navigate = (index: number) => {
    const item = flat[index];
    if (!item) return;
    props.onTabSelect(item.tab);
    closeLaunchpad();
  };

  // Keep the global listener pointed at the current filtered list + callback.
  _liveNav = { flatLen: flat.length, onSelect: navigate };

  // Autofocus the search input once per open.
  if (_shouldFocus) {
    _shouldFocus = false;
    requestAnimationFrame(() => {
      const input = document.querySelector<HTMLInputElement>(
        "[data-launchpad-input]",
      );
      input?.focus();
      input?.select();
    });
  }

  // Flat index bookkeeping so each card knows its global position.
  let running = 0;

  return html`
    ${LAUNCHPAD_STYLES}
    <div
      class="lp-overlay"
      @click=${(e: MouseEvent) => {
        // Click on the backdrop (not the panel) closes.
        if ((e.target as HTMLElement).classList.contains("lp-overlay")) {
          _contextMenu = null;
          closeLaunchpad();
        }
      }}
    >
      <div class="lp-panel" role="dialog" aria-modal="true" aria-label="Page launcher" data-ib-target="modal:launchpad">
        <div class="lp-searchbar">
          <span class="lp-searchbar__icon" aria-hidden="true">${icons.search}</span>
          <input
            data-launchpad-input
            data-ib-target="control:launchpad/search"
            class="lp-searchbar__input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="Search pages… (title, route, or group)"
            .value=${_query}
            @input=${(e: InputEvent) => {
              _query = (e.target as HTMLInputElement).value;
              _selIndex = 0;
              props.requestUpdate?.();
            }}
          />
          <kbd class="lp-searchbar__kbd">ESC</kbd>
          <button
            class="lp-searchbar__close"
            type="button"
            title="Close (Esc)"
            aria-label="Close launcher"
            @click=${() => closeLaunchpad()}
          >
            ${icons.x}
          </button>
        </div>

        <div class="lp-body">
          ${flat.length === 0
            ? html`<div class="lp-empty">No pages match “${_query}”.</div>`
            : groups.map(
                (g) => html`
                  <section class="lp-section">
                    <header class="lp-section__head">
                      <span class="lp-section__label">${g.label}</span>
                      <span class="lp-section__count">${g.items.length}</span>
                    </header>
                    <div class="lp-grid" data-launchpad-grid>
                      ${g.items.map((it) => {
                        const idx = running++;
                        const selected = idx === _selIndex;
                        const active = it.tab === props.currentTab;
                        return html`
                          <div
                            data-lp-card
                            data-learn-id=${`launchpad-card-${it.tab}`}
                            class="lp-card ${selected ? "is-selected" : ""} ${active
                              ? "is-active"
                              : ""}"
                            role="button"
                            tabindex=${selected ? "0" : "-1"}
                            title=${it.subtitle}
                            @click=${() => navigate(idx)}
                            @keydown=${(e: KeyboardEvent) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                navigate(idx);
                              }
                            }}
                            @contextmenu=${(e: MouseEvent) => {
                              e.preventDefault();
                              _contextMenu = { tab: it.tab, x: e.clientX, y: e.clientY };
                              props.requestUpdate?.();
                            }}
                            @mouseenter=${() => {
                              _selIndex = idx;
                              props.requestUpdate?.();
                            }}
                          >
                            <span class="lp-card__icon" aria-hidden="true"
                              >${it.icon}</span
                            >
                            <span class="lp-card__body">
                              <span class="lp-card__title">${it.title}</span>
                              <span class="lp-card__sub">${it.subtitle}</span>
                            </span>
                            <span class="lp-card__route">${it.path}</span>
                            ${active
                              ? html`<span class="lp-card__badge">Current</span>`
                              : nothing}
                            <button
                              class="lp-card__favorite ${isFavorite(props.navState, it.tab) ? "is-favorite" : ""}"
                              type="button"
                              title=${isFavorite(props.navState, it.tab) ? "Remove from favorites" : "Add to favorites"}
                              aria-label=${isFavorite(props.navState, it.tab) ? `Remove ${it.title} from favorites` : `Add ${it.title} to favorites`}
                              aria-pressed=${String(isFavorite(props.navState, it.tab))}
                              @click=${(e: MouseEvent) => {
                                e.stopPropagation();
                                props.onNavStateChange(toggleFavorite(props.navState, it.tab));
                              }}
                            >${icons.star}</button>
                          </div>
                        `;
                      })}
                    </div>
                  </section>
                `,
              )}
        </div>

        <footer class="lp-foot">
          <span><kbd>↑↓←→</kbd> navigate</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>esc</kbd> close</span>
          <span class="lp-foot__spacer"></span>
          <span class="lp-foot__count">${flat.length} pages</span>
        </footer>
      </div>
      ${_contextMenu ? html`
        <div class="lp-context-menu" role="menu" style="left:${Math.min(_contextMenu.x, innerWidth - 230)}px;top:${Math.min(_contextMenu.y, innerHeight - 70)}px;">
          <button role="menuitem" @click=${() => {
            props.onNavStateChange(toggleFavorite(props.navState, _contextMenu!.tab));
            _contextMenu = null;
            props.requestUpdate?.();
          }}>
            ${icons.star} ${isFavorite(props.navState, _contextMenu.tab) ? "Remove from favorites" : "Add to favorites"}
          </button>
        </div>
      ` : nothing}
    </div>
  `;
}

// ============================================================
// Styles (inline; light-DOM render like dashboard.ts)
// ============================================================

const LAUNCHPAD_STYLES = html`
  <style>
    .lp-overlay {
      position: fixed;
      inset: 0;
      z-index: 5000;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 6vh 24px 24px;
      background: radial-gradient(
          120% 90% at 50% -10%,
          color-mix(in srgb, var(--g-primary, #ffd700) 10%, transparent),
          transparent 60%
        ),
        rgba(3, 3, 3, 0.82);
      backdrop-filter: blur(14px) saturate(120%);
      -webkit-backdrop-filter: blur(14px) saturate(120%);
      animation: lp-fade 160ms ease-out;
    }
    @keyframes lp-fade {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
    .lp-panel {
      width: min(1180px, 100%);
      max-height: 88vh;
      display: flex;
      flex-direction: column;
      border: 1px solid var(--border-strong, #3f3f46);
      border-radius: 18px;
      background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--bg-elevated, #111) 96%, var(--g-primary, #ffd700) 4%),
        var(--panel, #050505)
      );
      box-shadow: 0 40px 120px -20px rgba(0, 0, 0, 0.8),
        0 0 0 1px rgba(255, 255, 255, 0.02),
        inset 0 1px 0 rgba(255, 255, 255, 0.04);
      overflow: hidden;
      animation: lp-rise 200ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes lp-rise {
      from {
        transform: translateY(14px) scale(0.985);
        opacity: 0;
      }
      to {
        transform: translateY(0) scale(1);
        opacity: 1;
      }
    }
    .lp-searchbar {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 20px 22px;
      border-bottom: 1px solid var(--border, #27272a);
      background: color-mix(in srgb, var(--g-primary, #ffd700) 4%, transparent);
    }
    .lp-searchbar__icon {
      display: inline-flex;
      color: var(--g-primary, #ffd700);
      opacity: 0.9;
    }
    .lp-searchbar__icon svg {
      width: 24px;
      height: 24px;
    }
    .lp-searchbar__input {
      flex: 1;
      /* Let the long placeholder shrink so the close button stays on screen at 390px. */
      min-width: 0;
      border: none;
      outline: none;
      background: transparent;
      color: var(--text-strong, #fff);
      font-size: 22px;
      font-weight: 500;
      letter-spacing: -0.01em;
    }
    .lp-searchbar__input::placeholder {
      color: var(--text-faint, #6b7280);
      font-weight: 400;
    }
    .lp-searchbar__kbd {
      font-size: 10px;
      letter-spacing: 0.06em;
      color: var(--text-faint, #71717a);
      border: 1px solid var(--border, #27272a);
      border-radius: 6px;
      padding: 3px 7px;
      background: rgba(255, 255, 255, 0.03);
    }
    .lp-searchbar__close {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      border-radius: 9px;
      border: 1px solid var(--border, #27272a);
      background: transparent;
      color: var(--text-dim, #a1a1aa);
      cursor: pointer;
      transition: all 140ms ease;
    }
    .lp-searchbar__close:hover {
      color: var(--text-strong, #fff);
      border-color: var(--g-primary, #ffd700);
      background: color-mix(in srgb, var(--g-primary, #ffd700) 12%, transparent);
    }
    .lp-searchbar__close svg {
      width: 16px;
      height: 16px;
    }
    .lp-body {
      overflow-y: auto;
      padding: 22px;
      display: flex;
      flex-direction: column;
      gap: 26px;
      scrollbar-width: thin;
      scrollbar-color: var(--border-strong, #3f3f46) transparent;
    }
    .lp-section__head {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    .lp-section__label {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--g-primary, #ffd700);
    }
    .lp-section__count {
      font-size: 11px;
      color: var(--text-faint, #71717a);
      border: 1px solid var(--border, #27272a);
      border-radius: 999px;
      padding: 1px 8px;
    }
    .lp-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
      gap: 12px;
    }
    .lp-card {
      position: relative;
      display: grid;
      grid-template-columns: auto 1fr;
      grid-template-areas: "icon body" "route route";
      align-items: start;
      gap: 4px 14px;
      text-align: left;
      padding: 16px;
      border-radius: 14px;
      border: 1px solid var(--border, #27272a);
      background: linear-gradient(
        180deg,
        rgba(255, 255, 255, 0.02),
        rgba(255, 255, 255, 0)
      );
      color: var(--text, #e4e4e7);
      cursor: pointer;
      transition: transform 140ms ease, border-color 140ms ease,
        box-shadow 140ms ease, background 140ms ease;
    }
    .lp-card:hover,
    .lp-card.is-selected {
      transform: translateY(-2px);
      border-color: var(--g-primary, #ffd700);
      background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--g-primary, #ffd700) 12%, transparent),
        color-mix(in srgb, var(--g-primary, #ffd700) 3%, transparent)
      );
      box-shadow: 0 12px 30px -12px color-mix(in srgb, var(--g-primary, #ffd700) 45%, transparent),
        0 0 0 1px color-mix(in srgb, var(--g-primary, #ffd700) 40%, transparent);
    }
    .lp-card.is-active {
      border-color: color-mix(in srgb, var(--g-primary, #ffd700) 60%, transparent);
    }
    .lp-card__favorite {
      position: absolute;
      top: 10px;
      right: 10px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--text-faint);
      background: transparent;
      opacity: 0;
      cursor: pointer;
    }
    .lp-card:hover .lp-card__favorite,
    .lp-card:focus-within .lp-card__favorite,
    .lp-card__favorite.is-favorite {
      opacity: 1;
    }
    .lp-card__favorite:hover,
    .lp-card__favorite:focus-visible,
    .lp-card__favorite.is-favorite {
      color: var(--g-primary);
      border-color: color-mix(in srgb, var(--g-primary) 45%, transparent);
      background: color-mix(in srgb, var(--g-primary) 10%, var(--bg-elevated));
      outline: none;
    }
    .lp-card__favorite.is-favorite svg {
      fill: currentColor;
    }
    .lp-context-menu {
      position: fixed;
      z-index: 5100;
      min-width: 210px;
      padding: 6px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      background: var(--bg-elevated);
      box-shadow: var(--shadow-lg);
    }
    .lp-context-menu button {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 10px;
      border: 0;
      border-radius: var(--radius-sm);
      color: var(--text);
      background: transparent;
      cursor: pointer;
    }
    .lp-context-menu button:hover,
    .lp-context-menu button:focus-visible {
      color: var(--g-primary);
      background: color-mix(in srgb, var(--g-primary) 10%, transparent);
      outline: none;
    }
    .lp-card__icon {
      grid-area: icon;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 40px;
      height: 40px;
      border-radius: 11px;
      border: 1px solid var(--border, #27272a);
      background: color-mix(in srgb, var(--g-primary, #ffd700) 8%, var(--bg, #050505));
      color: var(--g-primary, #ffd700);
    }
    .lp-card__icon svg {
      width: 20px;
      height: 20px;
    }
    .lp-card__body {
      grid-area: body;
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 0;
    }
    .lp-card__title {
      font-size: 15px;
      font-weight: 650;
      color: var(--text-strong, #fff);
      letter-spacing: -0.01em;
    }
    .lp-card__sub {
      font-size: 12px;
      line-height: 1.45;
      color: var(--text-dim, #a1a1aa);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .lp-card__route {
      grid-area: route;
      justify-self: start;
      margin-top: 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 10.5px;
      color: var(--text-faint, #8b8b93);
      border: 1px solid var(--border, #27272a);
      border-radius: 6px;
      padding: 2px 8px;
      background: rgba(255, 255, 255, 0.02);
    }
    .lp-card__badge {
      position: absolute;
      top: 12px;
      right: 12px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--bg, #050505);
      background: var(--g-primary, #ffd700);
      border-radius: 999px;
      padding: 2px 8px;
    }
    .lp-empty {
      padding: 60px 20px;
      text-align: center;
      color: var(--text-dim, #a1a1aa);
      font-size: 15px;
    }
    .lp-foot {
      display: flex;
      align-items: center;
      gap: 18px;
      padding: 12px 22px;
      border-top: 1px solid var(--border, #27272a);
      font-size: 11px;
      color: var(--text-faint, #71717a);
      background: color-mix(in srgb, var(--bg, #050505) 60%, transparent);
    }
    .lp-foot kbd {
      font-family: inherit;
      border: 1px solid var(--border, #27272a);
      border-radius: 5px;
      padding: 1px 6px;
      background: rgba(255, 255, 255, 0.03);
      color: var(--text-dim, #a1a1aa);
    }
    .lp-foot__spacer {
      flex: 1;
    }
    .lp-foot__count {
      color: var(--g-primary, #ffd700);
      font-weight: 600;
    }
  </style>
`;

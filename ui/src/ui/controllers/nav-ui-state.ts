/**
 * InfiniBar — transient navigation UI state.
 *
 * The persisted sidebar layout (categories, hidden tabs, custom names) lives in
 * `nav-sidebar.ts` and is synced to the gateway. This module owns the *transient*
 * UI state that should NOT be persisted to the server on every keystroke:
 *
 *   • search query        — filters the tab list, ephemeral per session
 *   • collapsed flyout     — which category rail is being hovered (icon mode)
 *   • bottom-strip index   — which compressed bottom widget is visible
 *
 * Keeping these out of `NavSidebarState` avoids firing a debounced
 * `nav.sidebar.set` gateway write for every search character or hover, and keeps
 * the persistence payload limited to real layout changes. State is module-level
 * (the sidebar is a singleton in the shell) and consumers re-render through the
 * `requestUpdate` hook already threaded into the render layer.
 */

import type { Tab } from "../navigation";

// ── Search ──────────────────────────────────────────────────────────────────

let _searchQuery = "";

export function getNavSearchQuery(): string {
  return _searchQuery;
}

export function setNavSearchQuery(value: string): void {
  _searchQuery = value;
}

export function clearNavSearchQuery(): void {
  _searchQuery = "";
}

/** True when the user is actively filtering. */
export function isNavSearching(): boolean {
  return _searchQuery.trim().length > 0;
}

/**
 * Does this tab match the active search query? Matches against the tab id and
 * its (possibly custom) display name, case-insensitively. Empty query → always
 * true so the full tree shows.
 */
export function tabMatchesSearch(tab: Tab, displayName: string, extraTerms: string[] = []): boolean {
  const q = _searchQuery.trim().toLowerCase();
  if (!q) return true;
  return (
    tab.toLowerCase().includes(q) ||
    displayName.toLowerCase().includes(q) ||
    extraTerms.some((term) => term.toLowerCase().includes(q))
  );
}

// ── Collapsed-rail flyout ────────────────────────────────────────────────────
//
// In slim icon-rail mode, hovering a tab/category opens a flyout panel that
// re-expands the label + group context. We track the hovered group id so the
// flyout can render the full group beside the rail. Transient: cleared on leave.

let _flyoutCategoryId: string | null = null;

export function getNavFlyoutCategory(): string | null {
  return _flyoutCategoryId;
}

export function setNavFlyoutCategory(id: string | null): void {
  _flyoutCategoryId = id;
}

// ── Bottom-strip rotation ────────────────────────────────────────────────────
//
// The update + backup widgets are compressed into a single rotating strip; only
// one is visible at a time. The chosen index persists across reloads so the user
// returns to the widget they last parked on.

const BOTTOM_STRIP_KEY = "infinibot-nav-bottom-strip";

export function getNavBottomStripIndex(count: number): number {
  if (count <= 0) return 0;
  try {
    const raw = localStorage.getItem(BOTTOM_STRIP_KEY);
    const n = raw == null ? 0 : Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n % count;
  } catch {
    /* localStorage unavailable (private mode) — fall through to 0 */
  }
  return 0;
}

export function setNavBottomStripIndex(index: number): void {
  try {
    localStorage.setItem(BOTTOM_STRIP_KEY, String(Math.max(0, index)));
  } catch {
    /* non-fatal */
  }
}

export function cycleNavBottomStrip(count: number): number {
  if (count <= 0) return 0;
  const next = (getNavBottomStripIndex(count) + 1) % count;
  setNavBottomStripIndex(next);
  return next;
}

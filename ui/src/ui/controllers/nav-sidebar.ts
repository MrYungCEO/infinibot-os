/**
 * Navigation Sidebar Controller
 * Discord-style categories with drag-drop, editing, and collapsible sections
 * Synced across browsers via gateway server storage
 */

import type { Tab } from "../navigation";
import { NAV_CATALOG_GROUPS, TAB_GROUPS, titleForTab, iconForTab } from "../navigation";
import type { GatewayBrowserClient } from "../gateway";
import { isPluginGatedTab, pluginSectionOfTab } from "../plugin-host.js";

// Get gateway client from window (set by app-gateway.ts on connect)
function getGatewayClient(): GatewayBrowserClient | null {
  return (window as any).__infinibotGatewayClient || null;
}

// Gateway request helper using the global client
async function gatewayRequest(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const client = getGatewayClient();
  if (!client) {
    throw new Error('Gateway client not connected');
  }
  return await client.request(method, params);
}

// ============================================================
// Types
// ============================================================

export interface NavCategory {
  id: string;
  label: string;
  collapsed: boolean;
  position: number;
  tabs: Tab[];
  icon?: string;
  isCustom?: boolean;
}

export interface NavSidebarState {
  categories: NavCategory[];
  hiddenTabs: Tab[];
  tabCustomNames: Record<string, string>; // tab -> custom display name
  /** Which built-in grouping the default categories were laid out from. */
  layoutVersion?: string;
  /**
   * Per-plugin sidebar-section preferences, keyed by plugin id. Plugin
   * sections are derived live from plugins.list (never stored as categories);
   * only the user's collapse/hide choice persists, so a disabled plugin keeps
   * its preference for when it comes back.
   */
  pluginSections?: Record<string, PluginSectionPref>;
  /** Ordered page ids. Disabled-plugin favorites stay here and reappear later. */
  favorites: Tab[];
  favoritesCollapsed: boolean;
  /** Unified ids: category ids and `plugin:<pluginId>`. Favorites is always pinned. */
  sectionOrder: string[];
  /** One-level hierarchy: child section id -> top-level parent section id. */
  sectionParents: Record<string, string>;
  /** Cross-kind page moves, including core pages inside plugin sections. */
  tabSectionOverrides: Record<string, string>;
  dragState: NavDragState | null;
  editState: NavEditState | null;
  contextMenu: NavContextMenuState | null;
}

export interface PluginSectionPref {
  collapsed?: boolean;
  hidden?: boolean;
}

export interface NavDragState {
  type: 'tab' | 'category';
  id: string; // tab name or category id
  sourceIndex: number;
  sourceCategoryId: string;
  currentDropTarget: NavDropTarget | null;
}

export interface NavDropTarget {
  type: 'category' | 'tab-gap' | 'category-gap';
  categoryId?: string;
  position?: number;
}

export interface NavEditState {
  type: 'category' | 'tab';
  id: string;
  value: string;
}

export interface NavContextMenuState {
  type: 'tab' | 'category' | 'plugin-section';
  id: string;
  x: number;
  y: number;
}

// ============================================================
// Storage - Gateway-synced with localStorage fallback
// ============================================================

const STORAGE_KEY = 'infinibot-nav-sidebar';
const NAV_VERSION_KEY = 'infinibot-nav-version';
const CURRENT_NAV_VERSION = '2026.09.26a'; // Bump this when adding new tabs (sidebar consolidation)
// A fresh browser renders a local default before the websocket handshake
// finishes. Never let a transient interaction (opening a context menu, starting
// a drag) write that placeholder over an existing server layout.
let gatewayHydrationComplete = false;

// Bump when TAB_GROUPS is REGROUPED (not just extended). A stored state with an
// older layout gets its built-in categories rebuilt from TAB_GROUPS once, while
// custom categories, hidden tabs and renames are kept. Without this, the merge
// below only prunes/appends, so a saved sidebar would keep the old grouping
// forever and a regroup would never reach existing users.
// 2026.09.28: the core "Business" group left for the business-agency plugin's
// own section (Inbox → Chat & Voice, Research → Work, Business settings → the
// plugin section).
export const NAV_LAYOUT_VERSION = '2026.09.30-favorites-hierarchy';

export const pluginSectionId = (pluginId: string): string => `plugin:${pluginId}`;
export const pluginIdFromSectionId = (sectionId: string): string | null =>
  sectionId.startsWith("plugin:") ? sectionId.slice("plugin:".length) : null;

// Async load from gateway (call this on app init)
export async function loadNavSidebarStateAsync(): Promise<NavSidebarState> {
  try {
    const res = await gatewayRequest("nav.sidebar.get", {});
    if (res.state) {
      console.log('[nav-sidebar] Loaded from gateway:', JSON.stringify(res.state.categories?.map((c: any) => ({ id: c.id, label: c.label, tabs: c.tabs?.length }))));
      const merged = mergeWithDefaults(res.state);
      // Detect whether pruning happened — if so, push the cleaned state back to the gateway
      const storedTabCount = (res.state.categories || []).reduce((n: number, c: any) => n + (c.tabs?.length || 0), 0);
      const mergedTabCount = merged.categories.reduce((n, c) => n + c.tabs.length, 0);
      const storedCatCount = (res.state.categories || []).length;
      if (
        storedTabCount !== mergedTabCount ||
        storedCatCount !== merged.categories.length ||
        res.state.layoutVersion !== merged.layoutVersion
      ) {
        console.log('[nav-sidebar] Pruned stale tabs/categories, syncing cleaned state to gateway');
        debouncedGatewaySave(merged);
      }
      // Also save to localStorage as cache
      gatewayHydrationComplete = true;
      saveToLocalStorage(merged);
      return merged;
    } else {
      console.log('[nav-sidebar] Gateway returned no state, using localStorage');
      const local = loadNavSidebarState();
      gatewayHydrationComplete = true;
      // First browser for this user seeds its private gateway layout from the
      // local cache/default only after the read has confirmed no server state.
      debouncedGatewaySave(local);
      return local;
    }
  } catch (e) {
    console.warn('[nav-sidebar] Gateway load failed, using localStorage fallback:', e);
  }
  // Fallback to localStorage
  const local = loadNavSidebarState();
  gatewayHydrationComplete = true;
  return local;
}

// Sync version for immediate use (from localStorage cache)
export function loadNavSidebarState(): NavSidebarState {
  try {
    const storedVersion = localStorage.getItem(NAV_VERSION_KEY);
    const stored = localStorage.getItem(STORAGE_KEY);
    
    // Force reset if version changed (new tabs added)
    if (storedVersion !== CURRENT_NAV_VERSION) {
      console.log('[nav-sidebar] Version changed, resetting to defaults with new tabs');
      localStorage.setItem(NAV_VERSION_KEY, CURRENT_NAV_VERSION);
      if (stored) {
        const parsed = JSON.parse(stored);
        const merged = mergeWithDefaults(parsed);
        saveNavSidebarState(merged);
        return merged;
      }
      return getDefaultState();
    }
    
    if (stored) {
      const parsed = JSON.parse(stored);
      // Validate and merge with current TAB_GROUPS to catch new tabs
      return mergeWithDefaults(parsed);
    }
  } catch (e) {
    console.error('Failed to load nav sidebar state:', e);
  }
  return getDefaultState();
}

function saveToLocalStorage(state: NavSidebarState): void {
  try {
    const toStore = {
      categories: state.categories,
      hiddenTabs: state.hiddenTabs,
      tabCustomNames: state.tabCustomNames,
      layoutVersion: state.layoutVersion,
      pluginSections: state.pluginSections ?? {},
      favorites: state.favorites,
      favoritesCollapsed: state.favoritesCollapsed,
      sectionOrder: state.sectionOrder,
      sectionParents: state.sectionParents,
      tabSectionOverrides: state.tabSectionOverrides,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
    localStorage.setItem(NAV_VERSION_KEY, CURRENT_NAV_VERSION);
  } catch (e) {
    console.error('Failed to save nav sidebar state to localStorage:', e);
  }
}

// Debounced gateway save
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let pendingSave: NavSidebarState | null = null;

async function pushStateToGateway(state: NavSidebarState): Promise<void> {
  try {
    const toStore = {
      categories: state.categories,
      hiddenTabs: state.hiddenTabs,
      tabCustomNames: state.tabCustomNames,
      layoutVersion: state.layoutVersion,
      pluginSections: state.pluginSections ?? {},
      favorites: state.favorites,
      favoritesCollapsed: state.favoritesCollapsed,
      sectionOrder: state.sectionOrder,
      sectionParents: state.sectionParents,
      tabSectionOverrides: state.tabSectionOverrides,
    };
    await gatewayRequest("nav.sidebar.set", { state: toStore });
    console.log('[nav-sidebar] Synced to gateway');
  } catch (e) {
    console.error('[nav-sidebar] Failed to sync to gateway:', e);
  }
}

function debouncedGatewaySave(state: NavSidebarState): void {
  pendingSave = state;
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    const next = pendingSave;
    pendingSave = null;
    if (next) void pushStateToGateway(next);
  }, 500); // 500ms debounce
}

// Flush a pending debounced save immediately. Without this, creating a category
// and reloading within the debounce window loses it server-side (localStorage
// keeps it, but other browsers never see it).
export function flushNavSidebarSave(): void {
  if (!saveTimeout && !pendingSave) return;
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = null;
  const next = pendingSave;
  pendingSave = null;
  if (next) void pushStateToGateway(next);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushNavSidebarSave);
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNavSidebarSave();
  });
}

// Force sync current localStorage state to gateway (for initial setup)
export async function forceNavSidebarSync(): Promise<boolean> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      console.warn('[nav-sidebar] No localStorage state to sync');
      return false;
    }
    const parsed = JSON.parse(stored);
    const toStore = {
      categories: parsed.categories || [],
      hiddenTabs: parsed.hiddenTabs || [],
      tabCustomNames: parsed.tabCustomNames || {},
      layoutVersion: parsed.layoutVersion,
      pluginSections: parsed.pluginSections || {},
      favorites: parsed.favorites || [],
      favoritesCollapsed: parsed.favoritesCollapsed === true,
      sectionOrder: parsed.sectionOrder || [],
      sectionParents: parsed.sectionParents || {},
      tabSectionOverrides: parsed.tabSectionOverrides || {},
    };
    console.log('[nav-sidebar] Syncing state:', JSON.stringify(toStore.categories.map((c: any) => ({ id: c.id, label: c.label, tabs: c.tabs?.length }))));
    await gatewayRequest("nav.sidebar.set", { state: toStore });
    console.log('[nav-sidebar] Force synced to gateway successfully!');
    return true;
  } catch (e) {
    console.error('[nav-sidebar] Force sync failed:', e);
    return false;
  }
}

// Expose to window for console access
if (typeof window !== 'undefined') {
  (window as any).forceNavSidebarSync = forceNavSidebarSync;
}

export function saveNavSidebarState(state: NavSidebarState): void {
  // Save to localStorage immediately (for instant feedback)
  saveToLocalStorage(state);
  if (!gatewayHydrationComplete) return;
  // Sync to gateway (debounced)
  debouncedGatewaySave(state);
}

function getDefaultState(): NavSidebarState {
  const categories: NavCategory[] = TAB_GROUPS.map((group, index) => ({
    id: `default-${group.label.toLowerCase().replace(/\s+/g, '-')}`,
    label: group.label,
    collapsed: false,
    position: index,
    tabs: [...group.tabs] as Tab[],
    isCustom: false,
  }));
  
  return {
    categories,
    hiddenTabs: [],
    tabCustomNames: {},
    layoutVersion: NAV_LAYOUT_VERSION,
    pluginSections: {},
    favorites: [],
    favoritesCollapsed: false,
    sectionOrder: categories.map((category) => category.id),
    sectionParents: {},
    tabSectionOverrides: {},
    dragState: null,
    editState: null,
    contextMenu: null,
  };
}

// A category the user made themselves (vs. one of the built-in TAB_GROUPS).
// Older states predate the isCustom flag, so fall back to the id prefix.
export function isCustomCategory(c: { id?: string; isCustom?: boolean }): boolean {
  return c.isCustom === true || String(c.id || "").startsWith("custom-");
}

/**
 * Rebuild the built-in categories from the current TAB_GROUPS while keeping
 * everything the user made: custom categories (at their relative position, and
 * they keep the tabs they claimed), collapsed flags of built-in groups that
 * still exist, hidden tabs and renames (the latter two via the normal merge).
 */
function relayoutCategories(stored: Partial<NavSidebarState>): NavCategory[] {
  const defaults = getDefaultState().categories;
  const storedCats = [...(stored.categories || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const custom = storedCats
    .map((c, index) => ({ c, index }))
    .filter(({ c }) => isCustomCategory(c));
  // Tabs the user moved into a custom category or hid stay where they put them.
  const claimed = new Set<Tab>([...custom.flatMap(({ c }) => c.tabs || []), ...(stored.hiddenTabs || [])]);
  const collapsedById = new Map(storedCats.map((c) => [c.id, c.collapsed] as const));

  const out: NavCategory[] = defaults.map((d) => ({
    ...d,
    collapsed: collapsedById.get(d.id) ?? d.collapsed,
    tabs: d.tabs.filter((t) => !claimed.has(t)),
  }));
  for (const { c, index } of custom) {
    out.splice(Math.min(index, out.length), 0, { ...c, tabs: [...(c.tabs || [])] });
  }
  return out.map((c, position) => ({ ...c, position }));
}

function sanitizePluginSections(raw: unknown): Record<string, PluginSectionPref> {
  const out: Record<string, PluginSectionPref> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const pref: PluginSectionPref = {};
    const { collapsed, hidden } = v as PluginSectionPref;
    if (typeof collapsed === "boolean") pref.collapsed = collapsed;
    if (hidden === true) pref.hidden = true;
    if (Object.keys(pref).length) out[id] = pref;
  }
  return out;
}

function stringRecord(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value && value !== key) out[key] = value;
  }
  return out;
}

function uniqueStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

/** All core, hidden and hosted entries that can be favorited while their plugin is off. */
function knownNavTabs(): Set<string> {
  return new Set([
    ...NAV_CATALOG_GROUPS.flatMap((group) => group.tabs as readonly string[]),
    ...TAB_GROUPS.flatMap((group) => group.tabs as readonly string[]),
  ]);
}

function sanitizeFavorites(raw: unknown): Tab[] {
  const core = knownNavTabs();
  return uniqueStrings(raw).filter((tab) => core.has(tab) || isPluginGatedTab(tab)) as Tab[];
}

function sanitizeSectionLayout(
  categories: NavCategory[],
  rawOrder: unknown,
  rawParents: unknown,
): { sectionOrder: string[]; sectionParents: Record<string, string> } {
  const categoryIds = categories.map((category) => category.id);
  const order = uniqueStrings(rawOrder);
  const sectionOrder = [...order, ...categoryIds.filter((id) => !order.includes(id))];
  const parents = stringRecord(rawParents);
  const sectionParents: Record<string, string> = {};
  for (const [child, parent] of Object.entries(parents)) {
    if (child === parent || parents[parent]) continue; // one level only; also rejects simple chains
    sectionParents[child] = parent;
  }
  return { sectionOrder, sectionParents };
}

/** Exported for tests: merge a stored layout with the current TAB_GROUPS. */
export function mergeNavSidebarState(stored: Partial<NavSidebarState>): NavSidebarState {
  return mergeWithDefaults(stored);
}

function mergeWithDefaults(stored: Partial<NavSidebarState>): NavSidebarState {
  const defaults = getDefaultState();
  if (stored.categories && stored.layoutVersion !== NAV_LAYOUT_VERSION) {
    stored = { ...stored, categories: relayoutCategories(stored) };
  }

  // Get all tabs from current TAB_GROUPS
  const allCurrentTabs = new Set<Tab>(
    TAB_GROUPS.flatMap(g => g.tabs) as Tab[]
  );

  // Prune stored categories: remove tabs that no longer exist in TAB_GROUPS,
  // and drop default groups that become empty. User-created categories are
  // ALWAYS kept, even with zero tabs — they are born empty and filled by
  // dragging tabs in, so pruning them here would delete a category the moment
  // it was created (and, worse, sync that deletion back to the gateway).
  //
  // Exception: a user-created category whose tabs ALL moved into plugin
  // sections (e.g. a custom "Revenue" holding clients + business, which the
  // business-agency plugin now owns) would be left as an empty, unusable
  // header — plugin pages never render inside categories. It is dropped; a
  // custom category that still holds any core tab keeps it.
  const prunedCategories = (stored.categories || defaults.categories)
    .map(c => ({
      ...c,
      tabs: (c.tabs || []).filter((t): t is Tab => allCurrentTabs.has(t as Tab)),
      movedToPlugins:
        (c.tabs || []).length > 0 && (c.tabs || []).every((t) => isPluginGatedTab(t)),
    }))
    .filter(c => c.tabs.length > 0 || (isCustomCategory(c) && !c.movedToPlugins))
    .map(({ movedToPlugins: _moved, ...c }) => c);

  // Tabs after pruning
  const storedTabs = new Set<Tab>(
    prunedCategories.flatMap(c => c.tabs)
  );

  // Also prune hiddenTabs to drop non-existent tabs. Plugin pages aren't in
  // TAB_GROUPS but live in plugin sections, so a user's hide/rename of one
  // survives (even while the plugin is off).
  const keepTab = (t: string) => allCurrentTabs.has(t as Tab) || isPluginGatedTab(t);
  const prunedHidden = (stored.hiddenTabs || []).filter((t): t is Tab => keepTab(t));

  // Find new tabs that aren't in stored state
  const newTabs: Tab[] = [];
  allCurrentTabs.forEach(tab => {
    if (!storedTabs.has(tab) && !prunedHidden.includes(tab)) {
      newTabs.push(tab);
    }
  });

  // Add new tabs to appropriate default categories
  const categories = prunedCategories;
  if (newTabs.length > 0) {
    for (const tab of newTabs) {
      // Find which default group this tab belongs to
      const defaultGroup = TAB_GROUPS.find(g => (g.tabs as readonly Tab[]).includes(tab));
      if (defaultGroup) {
        const categoryId = `default-${defaultGroup.label.toLowerCase().replace(/\s+/g, '-')}`;
        const category = categories.find(c => c.id === categoryId);
        if (category && !category.tabs.includes(tab)) {
          category.tabs.push(tab);
        } else if (!category) {
          // Category doesn't exist, add the default group
          const defaultCat = defaults.categories.find(c => c.id === categoryId);
          if (defaultCat) {
            categories.push({ ...defaultCat, tabs: [tab] });
          } else if (categories[0]) {
            categories[0].tabs.push(tab);
          }
        }
      }
    }
  }

  // Prune tabCustomNames for tabs that no longer exist
  const prunedCustomNames: Record<string, string> = {};
  for (const [tab, name] of Object.entries(stored.tabCustomNames || {})) {
    if (keepTab(tab)) {
      prunedCustomNames[tab] = name as string;
    }
  }

  const { sectionOrder, sectionParents } = sanitizeSectionLayout(
    categories,
    stored.sectionOrder,
    stored.sectionParents,
  );

  return {
    categories,
    hiddenTabs: prunedHidden,
    tabCustomNames: prunedCustomNames,
    layoutVersion: NAV_LAYOUT_VERSION,
    pluginSections: sanitizePluginSections(stored.pluginSections),
    favorites: sanitizeFavorites(stored.favorites),
    favoritesCollapsed: stored.favoritesCollapsed === true,
    sectionOrder,
    sectionParents,
    tabSectionOverrides: stringRecord(stored.tabSectionOverrides),
    dragState: null,
    editState: null,
    contextMenu: null,
  };
}

// ============================================================
// Category Operations
// ============================================================

export function createNavCategory(state: NavSidebarState, label: string, icon?: string): NavSidebarState {
  const id = `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const position = state.categories.length;
  
  const newState = {
    ...state,
    categories: [
      ...state.categories,
      {
        id,
        label,
        collapsed: false,
        position,
        tabs: [],
        icon,
        isCustom: true,
      },
    ],
    sectionOrder: [...state.sectionOrder, id],
  };
  
  saveNavSidebarState(newState);
  return newState;
}

export function renameNavCategory(state: NavSidebarState, categoryId: string, label: string): NavSidebarState {
  const newState = {
    ...state,
    categories: state.categories.map(cat =>
      cat.id === categoryId ? { ...cat, label } : cat
    ),
  };
  
  saveNavSidebarState(newState);
  return newState;
}

export function renameNavTab(state: NavSidebarState, tab: Tab, customName: string): NavSidebarState {
  const newState = {
    ...state,
    tabCustomNames: {
      ...state.tabCustomNames,
      [tab]: customName,
    },
  };
  
  saveNavSidebarState(newState);
  return newState;
}

export function clearNavTabCustomName(state: NavSidebarState, tab: Tab): NavSidebarState {
  const { [tab]: _, ...rest } = state.tabCustomNames;
  const newState = {
    ...state,
    tabCustomNames: rest,
  };
  
  saveNavSidebarState(newState);
  return newState;
}

export function getNavTabDisplayName(
  state: Pick<NavSidebarState, "tabCustomNames">,
  tab: Tab,
  defaultTitle: string,
): string {
  // Plugin section items: renames apply unless they'd duplicate a sibling.
  const section = pluginSectionOfTab(tab);
  if (section) {
    return (
      pluginSectionDisplayNames(
        state,
        section.items.map((it) => ({ tab: it.tab, label: it.label })),
      ).get(tab) ?? defaultTitle
    );
  }
  return state.tabCustomNames[tab] || defaultTitle;
}

/**
 * Display names for the items of one plugin section. A user rename is kept,
 * except when it would duplicate another item's label in the same section —
 * e.g. a saved rename of `business` to "Sales Pipeline" from before the
 * business-agency plugin, whose section now has its own "Sales Pipeline".
 * The rename is ignored (not deleted), so the section never shows two
 * entries with the same name.
 */
export function pluginSectionDisplayNames(
  state: Pick<NavSidebarState, "tabCustomNames">,
  items: ReadonlyArray<{ tab: Tab; label: string }>,
): Map<Tab, string> {
  const norm = (v: string) => v.trim().toLowerCase();
  const defaults = new Map(items.map((it) => [it.tab, it.label] as const));
  const out = new Map<Tab, string>();
  const taken = new Set<string>();
  // Items keeping their own default label claim it first.
  for (const it of items) {
    if (!state.tabCustomNames[it.tab]?.trim()) taken.add(norm(it.label));
  }
  for (const it of items) {
    const custom = state.tabCustomNames[it.tab]?.trim();
    const collides =
      custom &&
      (taken.has(norm(custom)) ||
        items.some((o) => o.tab !== it.tab && norm(defaults.get(o.tab) ?? "") === norm(custom)));
    const label = custom && !collides ? custom : (defaults.get(it.tab) ?? it.label);
    out.set(it.tab, label);
    taken.add(norm(label));
  }
  return out;
}

export function deleteNavCategory(state: NavSidebarState, categoryId: string): NavSidebarState {
  const category = state.categories.find(c => c.id === categoryId);
  if (!category) return state;
  
  // Move all tabs to hidden or to first category
  const tabsToMove = category.tabs;
  
  let newCategories = state.categories.filter(c => c.id !== categoryId);
  
  // If there are still categories, move tabs to first one
  if (newCategories.length > 0 && tabsToMove.length > 0) {
    newCategories[0] = {
      ...newCategories[0],
      tabs: [...newCategories[0].tabs, ...tabsToMove],
    };
  }
  
  const newState = {
    ...state,
    categories: newCategories,
    hiddenTabs: newCategories.length === 0 ? [...state.hiddenTabs, ...tabsToMove] : state.hiddenTabs,
    sectionOrder: state.sectionOrder.filter((id) => id !== categoryId),
    sectionParents: Object.fromEntries(
      Object.entries(state.sectionParents).filter(([child, parent]) => child !== categoryId && parent !== categoryId),
    ),
    tabSectionOverrides: Object.fromEntries(
      Object.entries(state.tabSectionOverrides).filter(([, sectionId]) => sectionId !== categoryId),
    ),
  };
  
  saveNavSidebarState(newState);
  return newState;
}

export function toggleNavCategoryCollapsed(state: NavSidebarState, categoryId: string): NavSidebarState {
  const newState = {
    ...state,
    categories: state.categories.map(cat =>
      cat.id === categoryId ? { ...cat, collapsed: !cat.collapsed } : cat
    ),
  };
  
  saveNavSidebarState(newState);
  return newState;
}

// ============================================================
// Plugin sections (derived from plugins.list; only prefs persist)
// ============================================================

export function isPluginSectionCollapsed(
  state: NavSidebarState,
  pluginId: string,
  collapsedByDefault = false,
): boolean {
  return state.pluginSections?.[pluginId]?.collapsed ?? collapsedByDefault;
}

export function isPluginSectionHidden(state: NavSidebarState, pluginId: string): boolean {
  return state.pluginSections?.[pluginId]?.hidden === true;
}

function withPluginSectionPref(
  state: NavSidebarState,
  pluginId: string,
  patch: PluginSectionPref,
): NavSidebarState {
  const prev = state.pluginSections?.[pluginId] ?? {};
  const pref: PluginSectionPref = { ...prev, ...patch };
  if (pref.hidden !== true) delete pref.hidden;
  const next = { ...state, pluginSections: { ...(state.pluginSections ?? {}), [pluginId]: pref } };
  saveNavSidebarState(next);
  return next;
}

export function togglePluginSectionCollapsed(
  state: NavSidebarState,
  pluginId: string,
  collapsedByDefault = false,
): NavSidebarState {
  const collapsed = !isPluginSectionCollapsed(state, pluginId, collapsedByDefault);
  return withPluginSectionPref(state, pluginId, { collapsed });
}

export function setPluginSectionHidden(state: NavSidebarState, pluginId: string, hidden: boolean): NavSidebarState {
  return withPluginSectionPref(state, pluginId, { hidden });
}

// ============================================================
// Favorites
// ============================================================

export function isFavorite(state: Pick<NavSidebarState, "favorites">, tab: Tab): boolean {
  return state.favorites.includes(tab);
}

export function addFavorite(state: NavSidebarState, tab: Tab): NavSidebarState {
  if (state.favorites.includes(tab)) return state;
  const next = { ...state, favorites: [...state.favorites, tab] };
  saveNavSidebarState(next);
  return next;
}

export function removeFavorite(state: NavSidebarState, tab: Tab): NavSidebarState {
  if (!state.favorites.includes(tab)) return state;
  const next = { ...state, favorites: state.favorites.filter((item) => item !== tab) };
  saveNavSidebarState(next);
  return next;
}

export function toggleFavorite(state: NavSidebarState, tab: Tab): NavSidebarState {
  return isFavorite(state, tab) ? removeFavorite(state, tab) : addFavorite(state, tab);
}

export function reorderFavorite(state: NavSidebarState, tab: Tab, toIndex: number): NavSidebarState {
  const fromIndex = state.favorites.indexOf(tab);
  if (fromIndex < 0) return state;
  const favorites = [...state.favorites];
  favorites.splice(fromIndex, 1);
  favorites.splice(Math.max(0, Math.min(toIndex, favorites.length)), 0, tab);
  const next = { ...state, favorites };
  saveNavSidebarState(next);
  return next;
}

export function moveFavorite(state: NavSidebarState, tab: Tab, delta: -1 | 1): NavSidebarState {
  const index = state.favorites.indexOf(tab);
  if (index < 0) return state;
  return reorderFavorite(state, tab, index + delta);
}

export function toggleFavoritesCollapsed(state: NavSidebarState): NavSidebarState {
  const next = { ...state, favoritesCollapsed: !state.favoritesCollapsed };
  saveNavSidebarState(next);
  return next;
}

/** Enabled/allowed filtering belongs to the caller so disabled plugin ids remain persisted. */
export function visibleFavorites(
  state: Pick<NavSidebarState, "favorites" | "hiddenTabs">,
  isVisible: (tab: Tab) => boolean,
): Tab[] {
  const hidden = new Set(state.hiddenTabs);
  return state.favorites.filter((tab) => !hidden.has(tab) && isVisible(tab));
}

// ============================================================
// Unified section hierarchy
// ============================================================

export function orderedSectionIds(state: NavSidebarState, availableIds: readonly string[]): string[] {
  const available = new Set(availableIds);
  return [
    ...state.sectionOrder.filter((id) => available.has(id)),
    ...availableIds.filter((id) => !state.sectionOrder.includes(id)),
  ];
}

export function sectionParent(
  state: Pick<NavSidebarState, "sectionParents">,
  sectionId: string,
  availableIds?: readonly string[],
): string | null {
  const parent = state.sectionParents[sectionId];
  if (!parent || parent === sectionId) return null;
  if (availableIds && !availableIds.includes(parent)) return null;
  // A parent cannot itself be nested: flatten old/foreign chains safely.
  if (state.sectionParents[parent]) return null;
  return parent;
}

function withSectionLayout(
  state: NavSidebarState,
  sectionOrder: string[],
  sectionParents = state.sectionParents,
): NavSidebarState {
  const next = { ...state, sectionOrder: uniqueStrings(sectionOrder), sectionParents };
  saveNavSidebarState(next);
  return next;
}

export function moveSection(
  state: NavSidebarState,
  sectionId: string,
  mode: "up" | "down" | "top" | "bottom",
  availableIds: readonly string[],
): NavSidebarState {
  const order = orderedSectionIds(state, availableIds);
  const parent = sectionParent(state, sectionId, availableIds);
  const siblings = order.filter((id) => sectionParent(state, id, availableIds) === parent);
  const from = siblings.indexOf(sectionId);
  if (from < 0) return state;
  const to = mode === "top" ? 0 : mode === "bottom" ? siblings.length - 1 : from + (mode === "up" ? -1 : 1);
  if (to < 0 || to >= siblings.length || to === from) return state;
  const reordered = [...siblings];
  reordered.splice(from, 1);
  reordered.splice(to, 0, sectionId);
  let cursor = 0;
  const sectionOrder = order.map((id) =>
    sectionParent(state, id, availableIds) === parent ? reordered[cursor++]! : id,
  );
  return withSectionLayout(state, sectionOrder);
}

export function moveSectionBefore(
  state: NavSidebarState,
  sectionId: string,
  targetId: string,
  availableIds: readonly string[],
): NavSidebarState {
  if (sectionId === targetId) return state;
  const order = orderedSectionIds(state, availableIds).filter((id) => id !== sectionId);
  const targetIndex = order.indexOf(targetId);
  if (targetIndex < 0) return state;
  order.splice(targetIndex, 0, sectionId);
  const parents = { ...state.sectionParents };
  const targetParent = sectionParent(state, targetId, availableIds);
  if (targetParent) parents[sectionId] = targetParent;
  else delete parents[sectionId];
  return withSectionLayout(state, order, parents);
}

export function nestSection(
  state: NavSidebarState,
  sectionId: string,
  parentId: string,
  availableIds: readonly string[],
): NavSidebarState {
  if (sectionId === parentId || !availableIds.includes(sectionId) || !availableIds.includes(parentId)) return state;
  if (sectionParent(state, parentId, availableIds)) return state;
  const parents = { ...state.sectionParents };
  // Children cannot own children: move any existing children out first.
  for (const [child, parent] of Object.entries(parents)) {
    if (parent === sectionId) delete parents[child];
  }
  parents[sectionId] = parentId;
  return withSectionLayout(state, orderedSectionIds(state, availableIds), parents);
}

export function unnestSection(state: NavSidebarState, sectionId: string): NavSidebarState {
  if (!state.sectionParents[sectionId]) return state;
  const parents = { ...state.sectionParents };
  delete parents[sectionId];
  return withSectionLayout(state, state.sectionOrder, parents);
}

export function moveTabToSection(
  state: NavSidebarState,
  tab: Tab,
  targetSectionId: string,
  position?: number,
): NavSidebarState {
  const pluginId = pluginIdFromSectionId(targetSectionId);
  let categories = state.categories.map((category) => ({
    ...category,
    tabs: category.tabs.filter((item) => item !== tab),
  }));
  const overrides = { ...state.tabSectionOverrides };
  if (pluginId) {
    overrides[tab] = targetSectionId;
  } else {
    const target = categories.find((category) => category.id === targetSectionId);
    if (!target) return state;
    categories = categories.map((category) => {
      if (category.id !== targetSectionId) return category;
      const tabs = [...category.tabs];
      tabs.splice(position === undefined ? tabs.length : Math.max(0, Math.min(position, tabs.length)), 0, tab);
      return { ...category, tabs };
    });
    if (isPluginGatedTab(tab)) overrides[tab] = targetSectionId;
    else delete overrides[tab];
  }
  const next = {
    ...state,
    categories,
    hiddenTabs: state.hiddenTabs.filter((item) => item !== tab),
    tabSectionOverrides: overrides,
  };
  saveNavSidebarState(next);
  return next;
}

export function reorderNavCategories(state: NavSidebarState, fromIndex: number, toIndex: number): NavSidebarState {
  const newCategories = [...state.categories];
  const [moved] = newCategories.splice(fromIndex, 1);
  newCategories.splice(toIndex, 0, moved);
  
  // Update positions
  newCategories.forEach((cat, idx) => {
    cat.position = idx;
  });
  
  const newState = { ...state, categories: newCategories };
  saveNavSidebarState(newState);
  return newState;
}

// ============================================================
// Tab Operations
// ============================================================

export function moveTabToCategory(
  state: NavSidebarState,
  tab: Tab,
  targetCategoryId: string,
  position?: number
): NavSidebarState {
  return moveTabToSection(state, tab, targetCategoryId, position);
}

export function reorderTabWithinCategory(
  state: NavSidebarState,
  tab: Tab,
  categoryId: string,
  newPosition: number
): NavSidebarState {
  const newCategories = state.categories.map(cat => {
    if (cat.id === categoryId) {
      const tabs = cat.tabs.filter(t => t !== tab);
      tabs.splice(newPosition, 0, tab);
      return { ...cat, tabs };
    }
    return cat;
  });
  
  const newState = { ...state, categories: newCategories };
  saveNavSidebarState(newState);
  return newState;
}

export function hideTab(state: NavSidebarState, tab: Tab): NavSidebarState {
  // Remove from all categories
  const newCategories = state.categories.map(cat => ({
    ...cat,
    tabs: cat.tabs.filter(t => t !== tab),
  }));
  
  const newState = {
    ...state,
    categories: newCategories,
    hiddenTabs: state.hiddenTabs.includes(tab) ? state.hiddenTabs : [...state.hiddenTabs, tab],
  };
  
  saveNavSidebarState(newState);
  return newState;
}

export function unhideTab(state: NavSidebarState, tab: Tab, categoryId?: string): NavSidebarState {
  const newHiddenTabs = state.hiddenTabs.filter(t => t !== tab);
  if (isPluginGatedTab(tab)) {
    // Plugin pages live in their plugin's section: just un-hide.
    const next = { ...state, hiddenTabs: newHiddenTabs };
    saveNavSidebarState(next);
    return next;
  }
  
  // Add to specified category or first category
  const targetId = categoryId || state.categories[0]?.id;
  const newCategories = state.categories.map(cat => {
    if (cat.id === targetId) {
      return { ...cat, tabs: [...cat.tabs, tab] };
    }
    return cat;
  });
  
  const newState = {
    ...state,
    categories: newCategories,
    hiddenTabs: newHiddenTabs,
  };
  
  saveNavSidebarState(newState);
  return newState;
}

// ============================================================
// Drag Operations
// ============================================================

export function startNavDrag(
  state: NavSidebarState,
  type: 'tab' | 'category',
  id: string,
  sourceIndex: number,
  sourceCategoryId: string
): NavSidebarState {
  return {
    ...state,
    dragState: {
      type,
      id,
      sourceIndex,
      sourceCategoryId,
      currentDropTarget: null,
    },
  };
}

export function updateNavDropTarget(state: NavSidebarState, dropTarget: NavDropTarget | null): NavSidebarState {
  if (!state.dragState) return state;
  return {
    ...state,
    dragState: {
      ...state.dragState,
      currentDropTarget: dropTarget,
    },
  };
}

export function endNavDrag(state: NavSidebarState): NavSidebarState {
  if (!state.dragState) return state;
  
  const { type, id, sourceCategoryId, currentDropTarget } = state.dragState;
  
  if (!currentDropTarget) {
    return { ...state, dragState: null };
  }
  
  let newState: NavSidebarState = { ...state, dragState: null };
  
  if (type === 'category') {
    // Reorder categories
    if (currentDropTarget.type === 'category-gap' && currentDropTarget.position !== undefined) {
      const fromIndex = state.categories.findIndex(c => c.id === id);
      let toIndex = currentDropTarget.position;
      if (fromIndex !== -1 && fromIndex !== toIndex) {
        // Adjust for removal
        if (fromIndex < toIndex) toIndex--;
        newState = reorderNavCategories(newState, fromIndex, toIndex);
      }
    }
  } else if (type === 'tab') {
    const tab = id as Tab;
    if (currentDropTarget.type === 'category' && currentDropTarget.categoryId) {
      // Move to category (at end)
      newState = moveTabToCategory(newState, tab, currentDropTarget.categoryId);
    } else if (currentDropTarget.type === 'tab-gap' && currentDropTarget.categoryId) {
      if (currentDropTarget.categoryId === sourceCategoryId) {
        // Reorder within same category
        if (currentDropTarget.position !== undefined) {
          newState = reorderTabWithinCategory(newState, tab, currentDropTarget.categoryId, currentDropTarget.position);
        }
      } else {
        // Move to different category at position
        newState = moveTabToCategory(newState, tab, currentDropTarget.categoryId, currentDropTarget.position);
      }
    }
  }
  
  return newState;
}

export function cancelNavDrag(state: NavSidebarState): NavSidebarState {
  return { ...state, dragState: null };
}

// ============================================================
// Edit Operations
// ============================================================

export function startNavEdit(state: NavSidebarState, categoryId: string, initialValue: string): NavSidebarState {
  return {
    ...state,
    editState: { type: 'category', id: categoryId, value: initialValue },
  };
}

export function startNavTabEdit(state: NavSidebarState, tab: Tab, initialValue: string): NavSidebarState {
  return {
    ...state,
    editState: { type: 'tab', id: tab, value: initialValue },
  };
}

export function updateNavEditValue(state: NavSidebarState, value: string): NavSidebarState {
  if (!state.editState) return state;
  return {
    ...state,
    editState: { ...state.editState, value },
  };
}

export function finishNavEdit(state: NavSidebarState): NavSidebarState {
  if (!state.editState) return state;
  
  const { type, id, value } = state.editState;
  let newState: NavSidebarState = { ...state, editState: null };
  
  if (value.trim()) {
    if (type === 'category') {
      newState = renameNavCategory(newState, id, value.trim());
    } else if (type === 'tab') {
      newState = renameNavTab(newState, id as Tab, value.trim());
    }
  }
  
  return newState;
}

export function cancelNavEdit(state: NavSidebarState): NavSidebarState {
  return { ...state, editState: null };
}

// ============================================================
// Context Menu Operations
// ============================================================

export function showNavContextMenu(
  state: NavSidebarState,
  type: 'tab' | 'category' | 'plugin-section',
  id: string,
  x: number,
  y: number
): NavSidebarState {
  return {
    ...state,
    contextMenu: { type, id, x, y },
  };
}

export function hideNavContextMenu(state: NavSidebarState): NavSidebarState {
  return { ...state, contextMenu: null };
}

// ============================================================
// Reset to Defaults
// ============================================================

export function resetNavSidebarToDefaults(): NavSidebarState {
  const state = getDefaultState();
  saveNavSidebarState(state);
  return state;
}

/** Reset locally only after the gateway has durably backed up the prior layout. */
export async function resetNavSidebarToDefaultsWithBackup(): Promise<NavSidebarState> {
  const state = getDefaultState();
  const toStore = {
    categories: state.categories,
    hiddenTabs: state.hiddenTabs,
    tabCustomNames: state.tabCustomNames,
    layoutVersion: state.layoutVersion,
    pluginSections: state.pluginSections,
    favorites: state.favorites,
    favoritesCollapsed: state.favoritesCollapsed,
    sectionOrder: state.sectionOrder,
    sectionParents: state.sectionParents,
    tabSectionOverrides: state.tabSectionOverrides,
  };
  await gatewayRequest("nav.sidebar.reset", { state: toStore });
  saveToLocalStorage(state);
  return state;
}

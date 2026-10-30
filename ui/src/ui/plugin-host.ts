/**
 * Plugin host (control UI side) — manifest-v2 UI contributions.
 *
 * The gateway's `plugins.list` reports each v2 plugin's declared nav entries
 * and pages. A page is either `builtin` (first-party UI compiled into this
 * bundle as a lazy chunk, listed in FIRST_PARTY_PAGES) or `entry` (a module
 * the plugin serves under /plugins/<id>/ — marketplace plugins).
 *
 * Tabs owned by a first-party plugin are PLUGIN-GATED: they have no sidebar
 * entry and render a "plugin disabled" card unless the owning plugin is
 * loaded and contributes them. Disabling the plugin therefore removes its
 * nav entry and page without touching navigation.ts.
 *
 * Every loaded plugin that contributes a routable page gets its OWN sidebar
 * section (pluginNavSections): header = plugin name + monogram, items = its
 * pages in manifest order, optionally shaped by `contributes.navSection`.
 * The nav entries' `group` no longer places them inside core groups.
 *
 * Design: docs/plugins/PLUGIN-PLATFORM.md §3.4.
 */

import type { GatewayBrowserClient } from "./gateway.js";
import type { Tab } from "./navigation.js";
import {
  PLUGIN_APPEARANCE_EVENT,
  appearanceBridgeMessage,
} from "../../../src/plugin-sdk/appearance-client.js";

export type PluginNavEntry = { tab: string; label: string; icon?: string; group?: string };
export type PluginPageEntry = { tab: string; route: string; builtin?: string; entry?: string; title?: string };
export type PluginNavSectionManifest = {
  title?: string;
  order?: number;
  collapsedByDefault?: boolean;
  items?: { page: string; label?: string; icon?: string }[];
};

export type PluginClockSectionManifest = {
  id: string;
  label: string;
  description?: string;
  builtin: string;
  defaultEnabled?: boolean;
};

export type PluginTopbarSlotManifest = {
  id: string;
  label: string;
  description?: string;
  builtin: string;
  order?: number;
  placement?: "left" | "right";
};

export type PluginSettingsSectionManifest = {
  id: string;
  label: string;
  description?: string;
  builtin: string;
  order?: number;
};

export type PluginAccessUi = {
  status: string;
  loadable: boolean;
  reason?: string;
  requires: { purchase: boolean; desktop: boolean };
  price: { priceCents: number; currency: string; label: string } | null;
};

type PluginOwner = { pluginId: string; pluginName: string; status: string; access?: PluginAccessUi };

export type PluginListItem = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  origin: string;
  enabled: boolean;
  status: "loaded" | "disabled" | "error";
  error?: string;
  manifestVersion?: number;
  contributes?: {
    nav: PluginNavEntry[];
    pages: PluginPageEntry[];
    rpc: { method: string; scope: string }[];
    http: string[];
    services?: string[];
    agents?: string[];
    landing?: string;
    tools?: string[];
    panels?: string[];
    rpcAliases?: { method: string; target: string; scope: string }[];
    navSection?: PluginNavSectionManifest;
    clockSections?: PluginClockSectionManifest[];
    topbarSlots?: PluginTopbarSlotManifest[];
    settings?: PluginSettingsSectionManifest[];
    /** The plugin's room on the agent mesh map (docs/plugins/MAP-ROOMS.md). */
    mapRoom?: {
      title?: string;
      theme?: string;
      accent?: string;
      props?: string[];
      size?: string;
      placement?: string;
    };
  };
  /** Roster agent ids seeded by `contributes.agents` (mesh-map plugin rooms). */
  rosterAgentIds?: string[];
  /** Paid / desktop-only gate (gateway entitlements/access.ts); older gateways omit it. */
  access?: PluginAccessUi;
  permissions?: Record<string, unknown>;
  source?: string;
  publisher?: string;
  license?: string;
  tier?: "first-party" | "verified" | "community";
  health?: { state: "ok" | "degraded" | "error" | "off"; reason?: string };
  updateAvailable?: string | null;
  /** Contribution keys currently off (owner toggle or revoked permission). */
  disabledContributions?: string[];
  appearance?: PluginAppearanceSummary;
  gatewayMethods?: string[];
  ui?: { navLabel: string; navIcon?: string; entry: string };
};

export type ThemeVars = { vars: Record<string, string>; contrast?: Record<string, number> };
export type PluginAppearanceSummary = {
  icon?: string;
  monogram?: string;
  customized: boolean;
  themes: { dark: ThemeVars; light: ThemeVars };
};

/**
 * First-party pages compiled into the control UI, keyed by the manifest's
 * `pages[].builtin`. The value is the Tab whose render block draws it. Every
 * tab listed here is plugin-gated.
 */
export const FIRST_PARTY_PAGES: Readonly<Record<string, Tab>> = {
  whiteboard: "whiteboard",
  "monsoon-studio": "monsoon-studio",
  inficode: "inficode",
  robovoice: "robovoice",
  "products-catalog": "products",
  "products-portfolio": "product-portfolio",
  omniclinic: "omniclinic",
  "omniclinic-research": "oc-research",
  "omniclinic-databases": "oc-databases",
  infinitrade: "infinitrade",
  "infinitrade-knowledge": "infinitrade-knowledge",
  "infinitrade-calendar": "infinitrade-calendar",
  "infinitrade-scanner": "infinitrade-scanner",
  "infinitrade-signals": "infinitrade-signals",
  "infinitrade-journal": "infinitrade-journal",
  "infinitrade-accounts": "infinitrade-accounts",
  "infinitrade-toolkit": "infinitrade-toolkit",
  "infinitrade-indicators": "infinitrade-indicators",
  "infinitrade-personal": "infinitrade-personal",
  "infinitrade-research": "infinitrade-research",
  "infinitrade-settings": "infinitrade-settings",
  // Solatrix Intelligence pages (extensions/solatrix/ui/intel).
  "solatrix-bubblemap": "solatrix-bubblemap",
  "solatrix-convergence": "solatrix-convergence",
  "solatrix-alerts": "solatrix-alerts",
  "solatrix-terminal": "solatrix",
  "solatrix-portfolio": "solatrix-portfolio",
  "solatrix-wallets": "solatrix-wallets",
  "solatrix-discovery": "solatrix-discovery",
  "solatrix-copy": "solatrix-copy",
  "solatrix-launcher": "solatrix-launcher",
  "solatrix-map": "solatrix-map",
  "solatrix-queue": "solatrix-queue",
  "solatrix-settings": "solatrix-settings",
  // Entry-module page (UI served by the plugin), mounted by <plugin-entry-page>.
  flypic: "flypic",
  // Droid Swarm (extensions/droid-swarm): the plugin serves its own console; mounted full-bleed.
  "droid-swarm": "droid-swarm",
  // Community Manager plugin (extensions/community-manager): dashboard + setup wizard.
  community: "community",
  // Discipline plugin (extensions/discipline): Day + Focus board.
  discipline: "discipline",
  focus: "focus",
  // content-studio plugin (extensions/content-studio)
  "content-pages": "content-pages",
  "content-intel": "content-intel",
  // HoloCanvas library plugin (extensions/canvas-library).
  "canvas-library": "canvas",
  // Business & Agency plugin (extensions/business-agency): one sidebar section.
  "business-hq": "business-hq",
  hub: "hub",
  "command-ceo": "command-ceo",
  "command-ops": "command-ops",
  "agency-daily": "agency-daily",
  "agency-operations": "agency-operations",
  "agency-topology": "agency-topology",
  clients: "clients",
  pipeline: "pipeline",
  opportunities: "opportunities",
  decisions: "decisions",
  risks: "risks",
  commitments: "commitments",
  people: "people",
  "people-network": "people-network",
  leads: "leads",
  qualifier: "qualifier",
  funnels: "funnels",
  campaigns: "campaigns",
  business: "business",
  "part-scan": "part-scan",
};

export type PluginLanding = { pluginId: string; tab: string; route: string };

const GATED_TABS: ReadonlySet<string> = new Set(Object.values(FIRST_PARTY_PAGES));

type ContributedTab = { pluginId: string; pluginName: string; nav?: PluginNavEntry; page: PluginPageEntry };

let contributed = new Map<string, ContributedTab>();
/** Owner plugin of every gated tab, loaded or not (for the disabled card). */
let owners = new Map<string, PluginOwner>();
let synced = false;
let topbarSlots: PluginTopbarSlot[] = [];
let appearances = new Map<string, PluginAppearanceSummary>();
let landing: PluginLanding | null = null;
let sections: PluginNavSection[] = [];
let clockSections: PluginClockSection[] = [];
let sectionSignature = "";
let lastList: PluginListItem[] = [];

/** Window event fired whenever the plugin host state changes (plugins.list
 *  re-sync after enable/disable, a contribution toggle, appearance). */
export const PLUGIN_HOST_EVENT = "infinibot-plugin-host";

// ── sidebar sections ─────────────────────────────────────────────────────

export type PluginNavSectionItem = { tab: Tab; label: string; icon?: string; title?: string };
export type PluginNavSection = {
  pluginId: string;
  title: string;
  monogram: string;
  icon?: string;
  order: number;
  collapsedByDefault: boolean;
  /** --plugin-accent per theme (from the plugin's resolved appearance). */
  accent?: { dark?: string; light?: string };
  items: PluginNavSectionItem[];
};

export const DEFAULT_SECTION_ORDER = 1000;

/** Two-letter fallback monogram from the plugin name ("InfiniCode" → "IC"). */
export function monogramFor(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const w = words[0] ?? "?";
  const caps = w.match(/[A-Z]/g);
  if (caps && caps.length >= 2) return caps.slice(0, 2).join("");
  return w.slice(0, 2).toUpperCase();
}

/** Tab a page renders on, or undefined when this UI can't route it. */
function routableTab(page: PluginPageEntry): Tab | undefined {
  const tab = page.builtin ? FIRST_PARTY_PAGES[page.builtin] : undefined;
  return tab && tab === page.tab ? tab : undefined;
}

/**
 * Sidebar sections for a plugins.list response (pure). Only loaded v2
 * plugins with at least one routable, switched-on page get a section; a nav
 * contribution the owner hid in Setup › Plugins stays hidden.
 */
export function derivePluginNavSections(plugins: PluginListItem[]): PluginNavSection[] {
  const out: PluginNavSection[] = [];
  for (const p of plugins) {
    if (p.manifestVersion !== 2 || !p.contributes || p.status !== "loaded") continue;
    const off = new Set(p.disabledContributions ?? []);
    const { pages, nav } = p.contributes;
    const shape = p.contributes.navSection;
    const wanted = shape?.items?.length
      ? shape.items
      : pages.map((pg) => ({ page: pg.tab, label: undefined, icon: undefined }));
    const items: PluginNavSectionItem[] = [];
    for (const w of wanted) {
      const page = pages.find((pg) => pg.tab === w.page);
      if (!page || items.some((i) => i.tab === page.tab)) continue;
      const tab = routableTab(page);
      if (!tab || off.has(`page:${tab}`) || off.has(`nav:${tab}`)) continue;
      const entry = nav.find((n) => n.tab === tab);
      items.push({
        tab,
        label: w.label ?? entry?.label ?? page.title ?? p.name,
        icon: w.icon ?? entry?.icon,
        title: page.title,
      });
    }
    if (!items.length) continue;
    const accentDark = p.appearance?.themes?.dark?.vars?.["--plugin-accent"];
    const accentLight = p.appearance?.themes?.light?.vars?.["--plugin-accent"];
    out.push({
      pluginId: p.id,
      title: shape?.title ?? p.name,
      monogram: (p.appearance?.monogram ?? monogramFor(p.name)).slice(0, 3),
      icon: p.appearance?.icon,
      order: typeof shape?.order === "number" ? shape.order : DEFAULT_SECTION_ORDER,
      collapsedByDefault: shape?.collapsedByDefault === true,
      accent: accentDark || accentLight ? { dark: accentDark, light: accentLight } : undefined,
      items,
    });
  }
  return out.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title) || a.pluginId.localeCompare(b.pluginId));
}

/** The current sidebar sections (from the last plugins.list sync). */
export function pluginNavSections(): readonly PluginNavSection[] {
  return sections;
}

/** The section a plugin tab is listed in, if any. */
export function pluginSectionOfTab(tab: string): PluginNavSection | undefined {
  return sections.find((s) => s.items.some((i) => i.tab === tab));
}

// ── topbar clock sections ────────────────────────────────────────────────

/** A section a loaded plugin adds to the expanded topbar clock. */
export type PluginClockSection = {
  /** `<pluginId>:<id>` — stable per-user preference key. */
  key: string;
  pluginId: string;
  pluginName: string;
  id: string;
  label: string;
  description?: string;
  builtin: string;
  defaultEnabled: boolean;
};

/**
 * Clock sections of every LOADED v2 plugin, minus the ones the owner switched
 * off (`clockSection:<id>` in disabledContributions). A disabled plugin
 * contributes nothing, so its toggle disappears from the clock.
 * Design: docs/plugins/CLOCK-SECTIONS.md.
 */
export function derivePluginClockSections(plugins: PluginListItem[]): PluginClockSection[] {
  const out: PluginClockSection[] = [];
  for (const p of plugins) {
    if (p.manifestVersion !== 2 || p.status !== "loaded" || !p.contributes?.clockSections) continue;
    const off = new Set(p.disabledContributions ?? []);
    for (const c of p.contributes.clockSections) {
      if (!c?.id || !c.label || !c.builtin || off.has(`clockSection:${c.id}`)) continue;
      out.push({
        key: `${p.id}:${c.id}`,
        pluginId: p.id,
        pluginName: p.name,
        id: c.id,
        label: c.label,
        ...(c.description ? { description: c.description } : {}),
        builtin: c.builtin,
        defaultEnabled: c.defaultEnabled !== false,
      });
    }
  }
  return out;
}

export function pluginClockSections(): readonly PluginClockSection[] {
  return clockSections;
}

/** Rebuild the contribution maps from a plugins.list response. */
/** Last plugins.list result — deep-link routing resolves plugin pages from it. */
let linkPlugins: PluginListItem[] | null = null;

/** Plugins for deep-link page resolution (null until the first plugins.list sync). */
export function pluginLinkInfo(): readonly PluginListItem[] | null {
  return linkPlugins;
}

export function applyPluginList(plugins: PluginListItem[], nextLanding: PluginLanding | null = null): void {
  linkPlugins = plugins;
  const nextContributed = new Map<string, ContributedTab>();
  const nextOwners = new Map<string, PluginOwner>();
  for (const p of plugins) {
    if (p.manifestVersion !== 2 || !p.contributes) continue;
    const off = new Set(p.disabledContributions ?? []);
    for (const page of p.contributes.pages) {
      const tab = page.builtin ? FIRST_PARTY_PAGES[page.builtin] : undefined;
      if (!tab || tab !== page.tab) continue;
      nextOwners.set(tab, { pluginId: p.id, pluginName: p.name, status: p.status, access: p.access });
      if (p.status !== "loaded") continue;
      // Owner switched the page off in Setup › Plugins → gated like a
      // disabled plugin. Hiding only the nav entry keeps the page routable.
      if (off.has(`page:${tab}`)) continue;
      nextContributed.set(tab, {
        pluginId: p.id,
        pluginName: p.name,
        page,
        nav: off.has(`nav:${tab}`) ? undefined : p.contributes.nav.find((n) => n.tab === tab),
      });
    }
  }
  lastList = plugins.slice();
  topbarSlots = derivePluginTopbarSlots(plugins);
  contributed = nextContributed;
  owners = nextOwners;
  sections = derivePluginNavSections(plugins);
  clockSections = derivePluginClockSections(plugins);
  applyPluginAppearances(plugins);
  // A landing page only counts while its tab is actually contributed.
  landing = nextLanding && nextContributed.has(nextLanding.tab) ? nextLanding : null;
  synced = true;
  // Tell the shell (sidebar, launchpad) — only when something visible moved,
  // so a periodic re-sync doesn't re-render for nothing.
  const mapRooms = plugins
    .filter((p) => p.manifestVersion === 2 && p.status === "loaded" && p.contributes?.mapRoom && !(p.disabledContributions ?? []).includes(`mapRoom:${p.id}`))
    .map((p) => [p.id, p.contributes?.mapRoom]);
  const sig = JSON.stringify([sections, [...contributed.keys()], landing, clockSections, topbarSlots, mapRooms]);
  if (sig !== sectionSignature) {
    sectionSignature = sig;
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PLUGIN_HOST_EVENT));
  }
}

// ── topbar slots ─────────────────────────────────────────────────────────

/** A control a loaded plugin adds to the app topbar (`contributes.topbarSlots`). */
export type PluginTopbarSlot = {
  /** `<pluginId>:<id>` — stable key (DOM `data-topbar-slot`). */
  key: string;
  pluginId: string;
  pluginName: string;
  id: string;
  label: string;
  description?: string;
  builtin: string;
  order: number;
  /** Topbar group: "left" (default) or "right" (status group). */
  placement: "left" | "right";
};

/**
 * Topbar slots of every LOADED v2 plugin, minus the ones the owner switched off
 * (`topbarSlot:<id>` in disabledContributions), sorted by order then key. A
 * disabled plugin contributes nothing, so its control leaves the topbar.
 * Design: docs/plugins/TOPBAR-SLOTS.md.
 */
export function derivePluginTopbarSlots(plugins: PluginListItem[]): PluginTopbarSlot[] {
  const out: PluginTopbarSlot[] = [];
  for (const p of plugins) {
    if (p.manifestVersion !== 2 || p.status !== "loaded" || !p.contributes?.topbarSlots) continue;
    const off = new Set(p.disabledContributions ?? []);
    for (const t of p.contributes.topbarSlots) {
      if (!t?.id || !t.label || !t.builtin || off.has(`topbarSlot:${t.id}`)) continue;
      if (out.some((o) => o.key === `${p.id}:${t.id}`)) continue;
      out.push({
        key: `${p.id}:${t.id}`,
        pluginId: p.id,
        pluginName: p.name,
        id: t.id,
        label: t.label,
        ...(t.description ? { description: t.description } : {}),
        builtin: t.builtin,
        order: typeof t.order === "number" ? t.order : 100,
        placement: t.placement === "right" ? "right" : "left",
      });
    }
  }
  return out.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

// ── settings sections (Setup › Plugins › <plugin>) ─────────────────────────

/** A first-party settings section a loaded plugin adds to its detail page. */
export type PluginSettingsSection = {
  key: string;
  pluginId: string;
  id: string;
  label: string;
  description?: string;
  builtin: string;
  order: number;
};

/**
 * Settings sections of one plugin: only while it is LOADED (its RPCs exist)
 * and not switched off (`settings:<id>` in disabledContributions).
 * Design: docs/plugins/SETTINGS-SECTIONS.md.
 */
export function derivePluginSettingsSections(p: PluginListItem | null | undefined): PluginSettingsSection[] {
  if (!p || p.manifestVersion !== 2 || p.status !== "loaded" || !p.contributes?.settings) return [];
  const off = new Set(p.disabledContributions ?? []);
  const out: PluginSettingsSection[] = [];
  for (const s of p.contributes.settings) {
    if (!s?.id || !s.label || !s.builtin || off.has(`settings:${s.id}`)) continue;
    if (out.some((o) => o.id === s.id)) continue;
    out.push({
      key: `${p.id}:${s.id}`,
      pluginId: p.id,
      id: s.id,
      label: s.label,
      ...(s.description ? { description: s.description } : {}),
      builtin: s.builtin,
      order: typeof s.order === "number" ? s.order : 100,
    });
  }
  return out.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** The topbar slots from the last plugins.list sync. */
export function pluginTopbarSlots(): readonly PluginTopbarSlot[] {
  return topbarSlots;
}

/** The raw plugins.list items from the last sync (mesh-map plugin rooms read
 *  contributes.mapRoom / tools / rpc / pages / rosterAgentIds from here). */
export function pluginListSnapshot(): readonly PluginListItem[] {
  return lastList;
}

// ── per-plugin appearance ────────────────────────────────────────────────

const STYLE_ID = "infinibot-plugin-appearance";
/** Base rule: a scope container is a transparent full-size box. */
const SCOPE_BASE_CSS = `[data-plugin-scope] { display: block; height: 100%; min-height: 0; }`;

function cssDecls(vars: Record<string, string>): string {
  return Object.entries(vars)
    .filter(([k]) => /^--[a-z0-9-]+$/i.test(k))
    .map(([k, v]) => `${k}: ${String(v).replace(/[;{}<>]/g, "")};`)
    .join(" ");
}

/** Stylesheet scoping each plugin's resolved variables to its container. */
export function buildPluginAppearanceCss(entries: [string, PluginAppearanceSummary][]): string {
  const out = [SCOPE_BASE_CSS];
  for (const [id, a] of entries) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) continue;
    const sel = `[data-plugin-scope="${id}"]`;
    out.push(`${sel} { ${cssDecls(a.themes.dark.vars)} }`);
    out.push(`:root[data-theme="light"] ${sel} { ${cssDecls(a.themes.light.vars)} }`);
  }
  return out.join("\n");
}

/** Install/refresh the document stylesheet and notify plugin UIs. */
export function applyPluginAppearances(plugins: PluginListItem[]): void {
  const next = new Map<string, PluginAppearanceSummary>();
  for (const p of plugins) if (p.appearance) next.set(p.id, p.appearance);
  appearances = next;
  if (typeof document === "undefined") return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  const css = buildPluginAppearanceCss([...next]);
  if (el.textContent !== css) {
    el.textContent = css;
    window.dispatchEvent(new CustomEvent(PLUGIN_APPEARANCE_EVENT));
  }
}

export function currentThemeName(): "dark" | "light" {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** Inline declarations for a scope container inside a shadow root (where the
 *  document stylesheet can't reach). */
export function pluginScopeInlineStyle(pluginId: string, theme = currentThemeName()): string {
  const a = appearances.get(pluginId);
  return a ? cssDecls(a.themes[theme].vars) : "";
}

export function pluginAppearanceOf(pluginId: string): PluginAppearanceSummary | undefined {
  return appearances.get(pluginId);
}

/** The contributed page for a tab (e.g. its plugin-served `entry` module). */
export function pluginPageOfTab(tab: string): PluginPageEntry | undefined {
  return contributed.get(tab)?.page;
}

/** Owning plugin id of a first-party tab (for its scope container). */
export function pluginScopeOfTab(tab: string): string | undefined {
  return contributed.get(tab)?.pluginId ?? owners.get(tab)?.pluginId;
}

/** Push the current appearance into a sandboxed plugin iframe (bridge tier). */
export function postPluginAppearanceToFrame(frame: HTMLIFrameElement, pluginId: string): boolean {
  const a = appearances.get(pluginId);
  if (!a || !frame.contentWindow) return false;
  const theme = currentThemeName();
  // Opaque-origin sandboxed frames require "*"; the payload holds no secrets.
  frame.contentWindow.postMessage(appearanceBridgeMessage(pluginId, theme, a.themes[theme].vars), "*");
  return true;
}

/** Fetch plugins.list and rebuild. Keeps the last state on failure. */
export async function syncPluginHost(client: GatewayBrowserClient | null | undefined): Promise<boolean> {
  if (!client) return false;
  try {
    const res = await client.request<{ plugins?: PluginListItem[]; landing?: PluginLanding | null }>(
      "plugins.list",
      {},
    );
    applyPluginList(res?.plugins ?? [], res?.landing ?? null);
    return true;
  } catch {
    return false;
  }
}

export function isPluginGatedTab(tab: string): boolean {
  return GATED_TABS.has(tab);
}

/** False only for a plugin-gated tab whose plugin isn't loaded. */
export function isTabAvailable(tab: string): boolean {
  return !GATED_TABS.has(tab) || contributed.has(tab);
}

/**
 * The start page a plugin supplies ("clinic mode"), when the operator opted
 * in (`plugins.landing`) and the plugin is loaded. Null → normal dashboard.
 */
export function pluginLanding(): PluginLanding | null {
  return landing;
}

export function pluginNavLabel(tab: string): string | undefined {
  return pluginSectionOfTab(tab)?.items.find((i) => i.tab === tab)?.label ?? contributed.get(tab)?.nav?.label;
}

/** Owner of a gated tab, for the "plugin disabled" card. */
export function pluginOwnerOfTab(tab: string): PluginOwner | undefined {
  return owners.get(tab);
}

export function isPluginHostSynced(): boolean {
  return synced;
}

/**
 * True when the browser opened the control UI at its root ("/" under the base
 * path) — the only case where a plugin landing page replaces the dashboard.
 * An explicit /dashboard (or any other route) is always respected.
 */
export function isRootPath(pathname: string, basePath = ""): boolean {
  const base = basePath.trim().replace(/\/+$/, "");
  let path = pathname || "/";
  if (base && (path === base || path.startsWith(`${base}/`))) path = path.slice(base.length) || "/";
  path = path.replace(/\/index\.html$/i, "/").replace(/\/+$/, "");
  return path === "";
}

/**
 * The pathname the page was opened with. Captured at module load because the
 * router rewrites "/" to "/dashboard" during boot — before plugins.list
 * arrives — so reading location later can't tell a root visit apart.
 */
const INITIAL_PATHNAME = typeof window !== "undefined" ? window.location.pathname : "/";

/** True when this page load started at the control UI's root. */
export function openedAtRoot(basePath = ""): boolean {
  return isRootPath(INITIAL_PATHNAME, basePath);
}

/** Test hook. */
export function resetPluginHostForTests(): void {
  contributed = new Map();
  owners = new Map();
  appearances = new Map();
  landing = null;
  sections = [];
  clockSections = [];
  sectionSignature = "";
  synced = false;
  topbarSlots = [];
}

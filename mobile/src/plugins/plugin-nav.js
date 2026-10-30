/**
 * plugin-nav — turns the gateway's `plugins.list` answer into mobile
 * navigation (pure; unit-tested in src/__tests__/plugin-nav.test.js).
 *
 * Mirrors the web's derivePluginNavSections (ui/src/ui/plugin-host.ts): one
 * section per LOADED manifest-v2 plugin, items from `contributes.navSection`
 * (else every page in manifest order), pages the owner switched off
 * (`disabledContributions` page:<tab> / nav:<tab>) dropped, sections sorted by
 * navSection.order then title.
 *
 * Differences from web, on purpose:
 *   - A page is routable on mobile when it has a web `route` (rendered in an
 *     authed WebSurface) OR a native screen in NATIVE_PLUGIN_PAGES. The web's
 *     FIRST_PARTY_PAGES check is a property of the web bundle, not of mobile.
 *   - Core catalogue entries that moved into a plugin are tagged `plugin:` in
 *     screen-registry.js; once the plugin list is known they are removed (the
 *     plugin's own section supersedes them, or the plugin is off and the page
 *     is gone) — see mergeCatalogue().
 */

/** Default web sidebar order for a navSection without `order`. */
export const DEFAULT_SECTION_ORDER = 1000;

/**
 * Plugin page (manifest page `tab`, which equals `builtin` for first-party
 * pages) → the native mobile screen that already implements it. Same routing
 * keys as screen-registry entries (`screen` / `businessScreen` / `tab`).
 */
export const NATIVE_PLUGIN_PAGES = {
  // Discipline plugin
  discipline: { screen: 'DisciplineScreen' },
  // Content Studio plugin
  'content-pages': { screen: 'ContentPagesScreen' },
  'content-intel': { screen: 'ContentIntelScreen' },
  // Business & Agency plugin — the KIS native screens
  'business-hq': { tab: 'Business' },
  'command-ceo': { screen: 'ExecutiveCommandCenterScreen' },
  'command-ops': { screen: 'OperationsCommandCenterScreen' },
  clients: { businessScreen: 'Clients' },
  opportunities: { businessScreen: 'Opportunities' },
  decisions: { businessScreen: 'Decisions' },
  risks: { businessScreen: 'Risks' },
  commitments: { businessScreen: 'Commitments' },
  people: { businessScreen: 'People' },
  campaigns: { screen: 'CampaignsScreen' },
  'agency-daily': { screen: 'AgencyDailyScreen' },
  'agency-operations': { screen: 'AgencyOperationsScreen' },
  'agency-topology': { screen: 'AgencyTopologyScreen' },
  // Products plugin
  'product-portfolio': { businessScreen: 'ProductRegistry' },
  products: { screen: 'ProductCatalogScreen' },
  'products-catalog': { screen: 'ProductCatalogScreen' },
  // Whiteboard plugin
  whiteboard: { screen: 'WhiteboardScreen' },
};

/** Web-sidebar icon names (lucide-ish) → Ionicons. Unknown → fallback. */
const ICONS = {
  target: 'locate-outline', star: 'star-outline', brain: 'bulb-outline', chart: 'stats-chart-outline',
  calendar: 'calendar-outline', scanner: 'scan-outline', radar: 'radio-outline', book: 'book-outline',
  wallet: 'wallet-outline', settings: 'settings-outline', gear: 'settings-outline', user: 'person-outline',
  users: 'people-outline', search: 'search-outline', bell: 'notifications-outline', alert: 'warning-outline',
  map: 'map-outline', globe: 'globe-outline', layers: 'layers-outline', grid: 'grid-outline',
  code: 'code-slash-outline', terminal: 'terminal-outline', mic: 'mic-outline', phone: 'call-outline',
  image: 'image-outline', camera: 'camera-outline', video: 'videocam-outline', film: 'film-outline',
  pen: 'brush-outline', brush: 'brush-outline', canvas: 'easel-outline', box: 'cube-outline',
  package: 'cube-outline', tag: 'pricetags-outline', briefcase: 'briefcase-outline', building: 'business-outline',
  heart: 'heart-outline', activity: 'pulse-outline', pulse: 'pulse-outline', flask: 'flask-outline',
  database: 'server-outline', file: 'document-text-outline', doc: 'document-text-outline', list: 'list-outline',
  check: 'checkmark-done-outline', clock: 'time-outline', zap: 'flash-outline', bolt: 'flash-outline',
  trending: 'trending-up-outline', dollar: 'cash-outline', coins: 'logo-bitcoin', rocket: 'rocket-outline',
  shield: 'shield-checkmark-outline', lock: 'lock-closed-outline', link: 'link-outline', share: 'share-social-outline',
  sparkles: 'sparkles-outline', wand: 'color-wand-outline', copy: 'copy-outline', queue: 'albums-outline',
};

export function ioniconFor(name, fallback = 'extension-puzzle-outline') {
  if (!name || typeof name !== 'string') return fallback;
  const k = name.toLowerCase().replace(/[-_](outline|icon)$/, '');
  if (ICONS[k]) return ICONS[k];
  const base = k.split(/[-_]/)[0];
  return ICONS[base] || fallback;
}

export function monogramFor(name) {
  const w = String(name || '').trim();
  const caps = w.match(/[A-Z]/g);
  if (caps && caps.length >= 2) return caps.slice(0, 2).join('');
  return w.slice(0, 2).toUpperCase();
}

/** Accent colour for the app's (dark) theme; falls back to light, then null. */
export function accentFor(p) {
  const v = (t) => p?.appearance?.themes?.[t]?.vars?.['--plugin-accent'];
  const a = v('dark') || v('light');
  return typeof a === 'string' && /^#|^rgb|^hsl/i.test(a.trim()) ? a.trim() : null;
}

export function isPluginActive(p) {
  return Boolean(p && p.enabled !== false && p.status === 'loaded');
}

/** A page's routing entry for mobile, or null when it can't be shown. */
export function pageEntry(plugin, page, overrides = {}) {
  if (!page) return null;
  const native = NATIVE_PLUGIN_PAGES[page.tab] || (page.builtin && NATIVE_PLUGIN_PAGES[page.builtin]);
  const route = typeof page.route === 'string' && page.route.startsWith('/') ? page.route : null;
  if (!native && !route) return null;
  const title = overrides.label || page.title || plugin.name;
  return {
    key: `plugin:${plugin.id}:${page.tab}`,
    title,
    icon: ioniconFor(overrides.icon),
    desc: overrides.label && page.title && page.title !== overrides.label ? page.title : plugin.name,
    pluginId: plugin.id,
    pageTab: page.tab,
    ...(native ? { ...native, webFallback: route } : { webPath: route, embed: true }),
  };
}

/**
 * Mobile sections for a plugins.list result. Each section:
 *   { title, pluginId, monogram, accent, order, collapsedByDefault, items:[entry…] }
 */
export function derivePluginSections(listResult) {
  const plugins = Array.isArray(listResult?.plugins) ? listResult.plugins : Array.isArray(listResult) ? listResult : [];
  const out = [];
  for (const p of plugins) {
    if (p.manifestVersion !== 2 || !p.contributes || !isPluginActive(p)) continue;
    const off = new Set(p.disabledContributions || []);
    const pages = Array.isArray(p.contributes.pages) ? p.contributes.pages : [];
    const nav = Array.isArray(p.contributes.nav) ? p.contributes.nav : [];
    const shape = p.contributes.navSection;
    const wanted = shape?.items?.length ? shape.items : pages.map((pg) => ({ page: pg.tab }));
    const items = [];
    for (const w of wanted) {
      const page = pages.find((pg) => pg.tab === w.page);
      if (!page || items.some((i) => i.pageTab === page.tab)) continue;
      if (off.has(`page:${page.tab}`) || off.has(`nav:${page.tab}`)) continue;
      const navEntry = nav.find((n) => n.tab === page.tab);
      const entry = pageEntry(p, page, { label: w.label || navEntry?.label, icon: w.icon || navEntry?.icon || p.appearance?.icon });
      if (entry) items.push(entry);
    }
    if (!items.length) continue;
    out.push({
      title: shape?.title || p.name,
      pluginId: p.id,
      monogram: String(p.appearance?.monogram || monogramFor(p.name)).slice(0, 3),
      accent: accentFor(p),
      order: typeof shape?.order === 'number' ? shape.order : DEFAULT_SECTION_ORDER,
      collapsedByDefault: shape?.collapsedByDefault === true,
      items,
    });
  }
  return out.sort(
    (a, b) => a.order - b.order || a.title.localeCompare(b.title) || a.pluginId.localeCompare(b.pluginId),
  );
}

/**
 * Merge the static core catalogue with plugin sections.
 *
 * @param coreSections  SCREEN_SECTIONS (entries may carry `plugin: '<id>'`)
 * @param pluginSections derivePluginSections() output, or null while unknown
 * @returns sections: core (minus plugin-owned entries once plugins are known,
 *          and minus sections left empty), with a "Plugins" index entry, then
 *          one section per enabled plugin (tagged `plugin: true`).
 */
export function mergeCatalogue(coreSections, pluginSections) {
  if (!pluginSections) return coreSections; // offline / first load: static fallback
  const core = [];
  for (const s of coreSections) {
    const items = s.items.filter((it) => !it.plugin);
    if (items.length) core.push(items.length === s.items.length ? s : { ...s, items });
  }
  const plugin = pluginSections.map((s) => ({ ...s, isPluginSection: true }));
  return [...core, ...plugin];
}

/**
 * Resolve `plugin/<id>/<page>` (a deep link) to a page entry.
 *   page matches a page tab, `<id>-<page>` tab, or a route ending in /<page>;
 *   no page → the navSection's first item (else the first page);
 *   unknown page → the main page with `?section=<page>` (Infinitrade style).
 * Returns { entry } | { disabled: plugin } | { unknown: true }.
 */
export function resolvePluginPage(listResult, pluginId, pageKey, query = '') {
  const plugins = Array.isArray(listResult?.plugins) ? listResult.plugins : Array.isArray(listResult) ? listResult : [];
  const p = plugins.find((x) => x.id === pluginId);
  if (!p) return { unknown: true };
  if (!isPluginActive(p)) return { disabled: p };
  const pages = Array.isArray(p.contributes?.pages) ? p.contributes.pages : [];
  const q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
  const withQuery = (entry, extra = '') => {
    if (!entry) return null;
    const qs = [q.replace(/^\?/, ''), extra].filter(Boolean).join('&');
    if (entry.webPath) return { ...entry, webPath: entry.webPath + (qs ? (entry.webPath.includes('?') ? '&' : '?') + qs : '') };
    return qs ? { ...entry, query: qs } : entry;
  };
  if (pageKey) {
    const k = String(pageKey).toLowerCase();
    const page =
      pages.find((pg) => pg.tab === k) ||
      pages.find((pg) => pg.tab === `${pluginId}-${k}`) ||
      pages.find((pg) => typeof pg.route === 'string' && pg.route.toLowerCase().endsWith(`/${k}`));
    if (page) return { entry: withQuery(pageEntry(p, page)) };
  }
  const firstTab = p.contributes?.navSection?.items?.[0]?.page;
  const main =
    pages.find((pg) => pg.route === `/${pluginId}`) ||
    (firstTab && pages.find((pg) => pg.tab === firstTab)) ||
    pages[0];
  if (!main) return { unknown: true };
  const entry = pageEntry(p, main);
  if (!pageKey) return { entry: withQuery(entry) };
  // Unknown sub-page: the main page with ?section=<page> (the web views read it).
  const asWeb = entry?.webPath ? entry : entry?.webFallback ? { ...entry, webPath: entry.webFallback, screen: undefined, businessScreen: undefined, tab: undefined } : entry;
  return { entry: withQuery(asWeb, `section=${encodeURIComponent(pageKey)}`) };
}

/**
 * Which plugin page (if any) owns a web path, e.g. '/solatrix/alerts' or
 * '/infinitrade?section=signals'. Longest route prefix wins.
 */
export function pluginPageForWebPath(listResult, webPath) {
  const plugins = Array.isArray(listResult?.plugins) ? listResult.plugins : Array.isArray(listResult) ? listResult : [];
  const [pathOnly, qs = ''] = String(webPath || '').split('?');
  const path = pathOnly.replace(/\/+$/, '') || '/';
  let best = null;
  for (const p of plugins) {
    for (const pg of p.contributes?.pages || []) {
      const r = typeof pg.route === 'string' ? pg.route.replace(/\/+$/, '') : '';
      if (!r) continue;
      if (path === r || path.startsWith(`${r}/`)) {
        if (!best || r.length > best.route.length) best = { plugin: p, page: pg, route: r };
      }
    }
  }
  if (!best) return null;
  const exact = path === best.route;
  return { pluginId: best.plugin.id, page: best.page, plugin: best.plugin, exact, query: qs, path };
}

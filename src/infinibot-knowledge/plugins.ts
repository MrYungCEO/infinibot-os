/**
 * Plugin manifest (v2 `contributes`) → knowledge entries.
 *
 * Used twice: at build time over extensions/* /infinibot.plugin.json (the
 * snapshot) and at runtime over the live plugin registry, so a newly
 * installed or updated plugin is known to agents without a rebuild.
 */

import { checkTarget, pageTarget, pluginTarget, toolTarget } from "./targets.js";
import type { KnowledgeEntry, KnowledgeSnapshot } from "./types.js";

/**
 * Plugins is its own Home sidebar page at /plugins (a Setup sub-tab until
 * 2026-10-16); a plugin's detail adds ?plugin=<id>[&ptab=<section>].
 */
export const PLUGINS_ROUTE = "/plugins";
export const PLUGINS_BREADCRUMB = ["Home", "Plugins"];

/** Detail-page tabs of Home › Plugins › <plugin> (views/plugins/model.ts DETAIL_SECTIONS). */
export const PLUGIN_DETAIL_SECTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "contributions", label: "What it adds" },
  { id: "permissions", label: "Permissions" },
  { id: "settings", label: "Settings" },
  { id: "appearance", label: "Appearance" },
  { id: "health", label: "Health & Logs" },
  { id: "data", label: "Data" },
  { id: "versions", label: "Versions" },
  { id: "uninstall", label: "Uninstall" },
];

export function pluginDetailRoute(id: string, section?: string): string {
  const base = `${PLUGINS_ROUTE}?plugin=${encodeURIComponent(id)}`;
  return section && section !== "overview" ? `${base}&ptab=${section}` : base;
}

/** The subset of a manifest / registry record we read. Tolerant of missing fields. */
export type PluginManifestLike = {
  id: string;
  name?: string;
  description?: string;
  listing?: { tagline?: string };
  contributes?: {
    nav?: Array<{ tab: string; label?: string; group?: string }>;
    pages?: Array<{
      tab: string;
      route?: string;
      title?: string;
      builtin?: string;
      entry?: string;
    }>;
    navSection?: { title?: string; items?: Array<{ page: string; label?: string }> };
    settings?: Array<{ id: string; label: string; description?: string }>;
    tools?: Array<string | { name: string; trust?: string; requires?: string[] }>;
    setupChecks?: Array<{
      id: string;
      title: string;
      tabs?: string[];
      action?: { label?: string; tab?: string };
    }>;
    topbarSlots?: Array<{ id: string; label: string; description?: string }>;
    panels?: string[];
  };
  permissions?: {
    gated?: Array<{ id: string; label: string; description?: string }>;
    secrets?: string[];
    network?: string[];
  };
  configSchema?: { properties?: Record<string, { description?: string }> };
  uiHints?: Record<string, { label?: string }>;
};

const firstSentence = (s: string | undefined, max = 220): string => {
  const text = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const m = text.match(/^(.+?[.!?])(\s|$)/);
  const out = m ? m[1] : text;
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
};

function toolName(t: string | { name: string }): string {
  return typeof t === "string" ? t : t.name;
}

/** The plugin's sidebar section: header + items in manifest order. */
export function pluginSection(
  m: PluginManifestLike,
): KnowledgeSnapshot["pluginSections"][number] | null {
  const c = m.contributes ?? {};
  const pages = c.pages ?? [];
  if (!pages.length) return null;
  const labelOf = (tab: string) =>
    c.navSection?.items?.find((i) => i.page === tab)?.label ??
    c.nav?.find((n) => n.tab === tab)?.label ??
    pages.find((p) => p.tab === tab)?.title ??
    tab;
  const order = c.navSection?.items?.length
    ? c.navSection.items.map((i) => i.page).filter((t) => pages.some((p) => p.tab === t))
    : pages.map((p) => p.tab);
  return {
    pluginId: m.id,
    title: c.navSection?.title ?? m.name ?? m.id,
    items: order.map((tab) => ({ tab, label: labelOf(tab) })),
  };
}

export function pluginEntries(m: PluginManifestLike, source: string): KnowledgeEntry[] {
  const c = m.contributes ?? {};
  const name = m.name ?? m.id;
  const out: KnowledgeEntry[] = [];
  const section = pluginSection(m);
  const crumb = [...PLUGINS_BREADCRUMB, name];
  const settingsPanels = c.settings ?? [];
  const configKeys = Object.keys(m.configSchema?.properties ?? {});
  const gated = m.permissions?.gated ?? [];
  const tools = (c.tools ?? []).map(toolName);

  out.push({
    id: pluginTarget(m.id),
    kind: "plugin",
    title: `${name} plugin`,
    summary: firstSentence(m.listing?.tagline || m.description) || `${name} plugin.`,
    breadcrumb: crumb,
    route: pluginDetailRoute(m.id),
    tab: "plugins",
    targets: [pluginTarget(m.id)],
    keywords: [
      m.id,
      name,
      `enable ${name}`,
      `turn on ${name}`,
      `install ${name}`,
      `${name} plugin`,
    ],
    pluginId: m.id,
    related: [
      ...(section ? [pageTarget(section.items[0]?.tab ?? m.id)] : []),
      ...settingsPanels.map((s) => pluginTarget(m.id, "settings", s.id)),
    ],
    source,
    facts: {
      sidebarSection: section?.title ?? null,
      pages: section?.items.map((i) => i.label) ?? [],
      tools,
      gatedPermissions: gated.map((g) => g.label),
      enableHow: `Home › Plugins › ${name} → Enable (turning a plugin on or off reloads the gateway).`,
    },
  });

  for (const d of PLUGIN_DETAIL_SECTIONS) {
    if (d.id === "overview") continue;
    if (d.id === "settings" && !settingsPanels.length && !configKeys.length) continue;
    if (d.id === "permissions" && !gated.length && !m.permissions?.secrets?.length) continue;
    if (!["settings", "permissions", "contributions", "health"].includes(d.id)) continue;
    const summary =
      d.id === "settings"
        ? `${name} settings: ${[...settingsPanels.map((s) => s.label), ...configKeys.map((k) => m.uiHints?.[k]?.label ?? k)].join(", ")}.`
        : d.id === "permissions"
          ? gated.length
            ? `Host permissions for ${name} (off by default): ${gated.map((g) => `${g.label} — ${firstSentence(g.description, 120)}`).join(" ")}`
            : `Permissions ${name} requested.`
          : d.id === "contributions"
            ? `Everything ${name} adds (pages, tools, panels), each with its own on/off toggle.`
            : `Load status, errors and logs of ${name}.`;
    out.push({
      id: pluginTarget(m.id, d.id),
      kind: "plugin-detail",
      title: `${name} › ${d.label}`,
      summary,
      breadcrumb: [...crumb, d.label],
      route: pluginDetailRoute(m.id, d.id),
      tab: "plugins",
      targets: [pluginTarget(m.id, d.id)],
      keywords: [
        `${name} ${d.label.toLowerCase()}`,
        `${m.id} ${d.id}`,
        ...(d.id === "permissions" ? gated.map((g) => g.label) : []),
      ],
      pluginId: m.id,
      source,
    });
  }

  for (const s of settingsPanels) {
    // A plugin settings panel is also reachable from the plugin's own sidebar
    // "Settings" page when it has one (Solatrix › Settings embeds agent access).
    const ownSettingsPage = section?.items.find(
      (i) => /settings/i.test(i.tab) || /^settings$/i.test(i.label),
    );
    out.push({
      id: pluginTarget(m.id, "settings", s.id),
      kind: "plugin-settings",
      title: `${name} › ${s.label}`,
      summary: firstSentence(s.description, 260) || s.label,
      breadcrumb: [...crumb, "Settings", s.label],
      route: pluginDetailRoute(m.id, "settings"),
      tab: ownSettingsPage?.tab ?? "plugins",
      targets: [
        pluginTarget(m.id, "settings", s.id),
        ...(ownSettingsPage ? [pageTarget(ownSettingsPage.tab)] : []),
      ],
      keywords: [s.label, s.id.replace(/-/g, " "), `${name} ${s.label}`],
      pluginId: m.id,
      requiresPlugin: m.id,
      source,
      facts: ownSettingsPage
        ? { alsoAt: [section!.title, ownSettingsPage.label].join(" › ") }
        : undefined,
    });
  }

  if (section) {
    for (const item of section.items) {
      const page = c.pages?.find((p) => p.tab === item.tab);
      out.push({
        id: pageTarget(item.tab),
        kind: "page",
        title: page?.title ?? item.label,
        summary: `${name} page "${item.label}" — in the ${section.title} sidebar section (only while the ${name} plugin is enabled).`,
        breadcrumb: [section.title, item.label],
        route: page?.route,
        tab: item.tab,
        targets: [pageTarget(item.tab)],
        keywords: [item.label, `${name} ${item.label}`, item.tab.replace(/-/g, " ")],
        pluginId: m.id,
        requiresPlugin: m.id,
        source,
      });
    }
    // Pages the manifest routes but its sidebar section doesn't list
    // (e.g. a page folded into another page's sub-tabs).
    for (const page of c.pages ?? []) {
      if (section.items.some((i) => i.tab === page.tab)) continue;
      const title = page.title ?? c.nav?.find((n) => n.tab === page.tab)?.label ?? page.tab;
      out.push({
        id: pageTarget(page.tab),
        kind: "page",
        title,
        summary: `${name} page "${title}" — not listed in the ${section.title} sidebar section; reachable from its parent page, by URL or ⌘K (only while ${name} is enabled).`,
        breadcrumb: [section.title, title],
        route: page.route,
        tab: page.tab,
        targets: [pageTarget(page.tab)],
        keywords: [title, `${name} ${title}`, page.tab.replace(/-/g, " ")],
        pluginId: m.id,
        requiresPlugin: m.id,
        source,
        facts: { notInSidebar: true },
      });
    }
  }

  for (const t of c.tools ?? []) {
    const n = toolName(t);
    const trust = typeof t === "string" ? undefined : t.trust;
    const requires = typeof t === "string" ? [] : (t.requires ?? []);
    out.push({
      id: toolTarget(n),
      kind: "tool",
      title: n,
      summary: `Agent tool from the ${name} plugin${trust ? ` (${trust})` : ""}. Exists only while ${name} is enabled${requires.length ? `; also needs the ${requires.map((r) => gated.find((g) => `gated:${g.id}` === r)?.label ?? r).join(", ")} permission` : ""}.`,
      breadcrumb: [...crumb, "What it adds"],
      route: pluginDetailRoute(m.id, "contributions"),
      tab: "plugins",
      targets: [toolTarget(n)],
      keywords: [n, n.replace(/_/g, " ")],
      pluginId: m.id,
      requiresPlugin: m.id,
      source,
      facts: { trust: trust ?? null, requires },
    });
  }

  for (const chk of c.setupChecks ?? []) {
    const id = chk.id.includes(".") ? chk.id : `${m.id}.${chk.id}`;
    const actionTab = chk.action?.tab;
    const actionLabel = actionTab
      ? section?.items.find((i) => i.tab === actionTab)?.label
      : undefined;
    out.push({
      id: checkTarget(id),
      kind: "setup-check",
      title: `${chk.title} (${name} setup check)`,
      summary: `Makes ${(chk.tabs ?? []).join(", ") || "its pages"} glow in the sidebar until done.${chk.action?.label ? ` Fix: "${chk.action.label}"${actionLabel ? ` on ${section!.title} › ${actionLabel}` : ""}.` : ""}`,
      breadcrumb: actionLabel ? [section!.title, actionLabel] : crumb,
      route: actionTab ? c.pages?.find((p) => p.tab === actionTab)?.route : pluginDetailRoute(m.id),
      tab: actionTab ?? "plugins",
      targets: [checkTarget(id), ...(actionTab ? [pageTarget(actionTab)] : [])],
      keywords: [chk.title, chk.action?.label ?? ""].filter(Boolean),
      pluginId: m.id,
      requiresPlugin: m.id,
      source,
    });
  }

  return out;
}

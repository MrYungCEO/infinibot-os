/**
 * Pure derivations of UI targets from other registries:
 *
 *   - plugin manifests (`contributes.pages / navSection / settings / topbarSlots`)
 *   - guided Learn tracks (every `learn:<id>` anchor a walkthrough points at)
 *   - setup-status checks ("needs setup" items and their fix actions)
 *
 * Dependency-free (imported by the gateway, the UI tests and the JSON dump
 * script). The navigation-derived half lives in the UI
 * (ui/src/ui/guide/derive-nav-targets.ts → generated/nav-targets.json).
 */

import type { RevealStep, UiTarget } from "./types.js";
import { learnAttrSelector, targetAttrSelector } from "./types.js";

// ── plugin manifests ────────────────────────────────────────────────────────

/** The subset of a v2 manifest / plugin record the derivation reads. */
export type PluginTargetInput = {
  id: string;
  name?: string;
  description?: string;
  listing?: { tagline?: string; tags?: string[]; category?: string };
  contributes?: {
    pages?: Array<{ tab: string; route: string; title?: string }>;
    nav?: Array<{ tab: string; label?: string; group?: string }>;
    navSection?: { title?: string; items?: Array<{ page: string; label?: string }> };
    settings?: Array<{
      id: string;
      label: string;
      description?: string;
      builtin?: string;
      order?: number;
    }>;
    topbarSlots?: Array<{ id: string; label?: string; placement?: string }>;
  };
};

/** Plugin detail page sections (ui/src/ui/views/plugins/model.ts DETAIL_SECTIONS). */
export const PLUGIN_DETAIL_SECTIONS: ReadonlyArray<{
  id: string;
  label: string;
  keywords: string[];
}> = [
  { id: "overview", label: "Overview", keywords: ["about", "what it does"] },
  {
    id: "contributions",
    label: "What it adds",
    keywords: ["contributions", "pages it adds", "tools it adds"],
  },
  {
    id: "permissions",
    label: "Permissions",
    keywords: ["grant", "allow", "revoke", "gated", "permission"],
  },
  { id: "settings", label: "Settings", keywords: ["configure", "config", "options"] },
  { id: "appearance", label: "Appearance", keywords: ["theme", "colors", "look"] },
  { id: "health", label: "Health & Logs", keywords: ["logs", "errors", "health", "status"] },
  { id: "data", label: "Data", keywords: ["storage", "export data", "delete data"] },
  { id: "versions", label: "Versions", keywords: ["update", "version", "upgrade"] },
  { id: "uninstall", label: "Uninstall", keywords: ["remove", "uninstall", "delete plugin"] },
];

const PLUGINS_ROUTE = "/plugins";

export function pluginDetailRoute(pluginId: string, section?: string): string {
  const q = `${PLUGINS_ROUTE}?plugin=${encodeURIComponent(pluginId)}`;
  return section && section !== "overview" ? `${q}&ptab=${encodeURIComponent(section)}` : q;
}

/** Open a plugin's detail page (works when the Plugins page is already mounted). */
export function pluginOpenReveal(pluginId: string, section?: string): RevealStep[] {
  return [
    {
      kind: "event",
      name: "infinibot:plugins-open",
      detail: { plugin: pluginId, ...(section ? { section } : {}) },
    },
    { kind: "wait", selectors: [`[data-plugin-detail="${pluginId}"]`], timeoutMs: 6000 },
  ];
}

/** `/solatrix/settings` → `solatrix/settings`. */
function routeId(route: string): string {
  return route.replace(/^\/+/, "").replace(/\?.*$/, "") || route;
}

export function derivePluginTargets(p: PluginTargetInput): UiTarget[] {
  const out: UiTarget[] = [];
  const name = p.name?.trim() || p.id;
  const c = p.contributes ?? {};
  const avail = { plugin: p.id };
  // Tags describe the plugin as a whole: only the plugin's own card gets them.
  const pluginKw = [name, p.id];
  const cardKw = [...pluginKw, ...(p.listing?.tags ?? [])];

  out.push({
    id: `plugin:${p.id}`,
    kind: "plugin",
    title: `${name} plugin`,
    description:
      p.listing?.tagline ||
      p.description?.slice(0, 220) ||
      `The ${name} plugin's page in Home › Plugins.`,
    keywords: [...cardKw, "plugin", `${name} plugin`, "details"],
    route: pluginDetailRoute(p.id),
    reveal: pluginOpenReveal(p.id),
    selectors: [`[data-plugin-detail="${p.id}"] .pm-dhero-text`, `[data-plugin-card="${p.id}"]`],
    parent: "page:plugins",
    tab: "plugins",
    source: "plugin-manifest",
    pluginId: p.id,
  });
  out.push({
    id: `plugin:${p.id}/enable`,
    kind: "control",
    title: `${name} › On/off switch`,
    description: `Turns the ${name} plugin on or off (Home › Plugins › ${name}). Turning it on restarts the gateway to load its code.`,
    keywords: [
      ...pluginKw,
      "enable",
      "disable",
      "turn on",
      "turn off",
      "activate",
      "switch on",
      "install",
      "where is it enabled",
      "on off",
    ],
    aliases: [`control:plugins/${p.id}/enable`],
    route: pluginDetailRoute(p.id),
    reveal: pluginOpenReveal(p.id),
    selectors: [
      `[data-plugin-detail="${p.id}"] [data-learn-id="plugin-detail-onoff"]`,
      `[data-plugin-card="${p.id}"] .pm-switch`,
    ],
    parent: `plugin:${p.id}`,
    tab: "plugins",
    source: "plugin-manifest",
    pluginId: p.id,
  });
  for (const s of PLUGIN_DETAIL_SECTIONS) {
    if (s.id === "overview") continue;
    out.push({
      id: `plugin:${p.id}/section/${s.id}`,
      kind: "section",
      title: `${name} › ${s.label}`,
      description: `The ${s.label} section of ${name}'s page in Home › Plugins.`,
      keywords: [...pluginKw, s.label, ...s.keywords],
      route: pluginDetailRoute(p.id, s.id),
      reveal: pluginOpenReveal(p.id, s.id),
      selectors: [`[data-plugin-detail="${p.id}"] section[data-section="${s.id}"]`],
      parent: `plugin:${p.id}`,
      tab: "plugins",
      source: "plugin-manifest",
      pluginId: p.id,
    });
  }
  for (const s of c.settings ?? []) {
    if (typeof s?.id !== "string" || typeof s.label !== "string") continue;
    out.push({
      id: `plugin:${p.id}/settings/${s.id}`,
      kind: "section",
      title: `${name} › ${s.label}`,
      description:
        s.description || `${name}'s ${s.label} settings (Home › Plugins › ${name} › Settings).`,
      keywords: [...pluginKw, s.label, s.id.replace(/-/g, " "), "settings"],
      route: pluginDetailRoute(p.id, "settings"),
      reveal: [
        ...pluginOpenReveal(p.id, "settings"),
        { kind: "wait", selectors: [`[data-settings-section="${p.id}:${s.id}"]`], timeoutMs: 8000 },
      ],
      selectors: [`[data-settings-section="${p.id}:${s.id}"]`],
      parent: `plugin:${p.id}`,
      tab: "plugins",
      availability: avail,
      source: "plugin-manifest",
      pluginId: p.id,
    });
  }
  const navLabel = new Map<string, string>();
  for (const n of c.nav ?? []) if (n.label) navLabel.set(n.tab, n.label);
  for (const it of c.navSection?.items ?? []) if (it.label) navLabel.set(it.page, it.label);
  const section = c.navSection?.title || name;
  for (const page of c.pages ?? []) {
    if (typeof page?.tab !== "string" || typeof page.route !== "string") continue;
    const rid = routeId(page.route);
    const label = navLabel.get(page.tab);
    const title = page.title || label || page.tab;
    const id = `page:${rid}`;
    out.push({
      id,
      kind: "page",
      title:
        label && label !== title ? `${section} › ${label} (${title})` : `${section} › ${title}`,
      description: `${title} — a page of the ${name} plugin.`,
      keywords: [...pluginKw, title, label, page.tab.replace(/-/g, " ")].filter((k): k is string =>
        Boolean(k),
      ),
      aliases: page.tab !== rid ? [`page:${page.tab}`] : undefined,
      route: page.route,
      tab: page.tab,
      parent: `plugin:${p.id}`,
      availability: avail,
      source: "plugin-manifest",
      pluginId: p.id,
    });
    if (navLabel.has(page.tab)) {
      out.push({
        id: `nav:sidebar/${page.tab}`,
        kind: "nav",
        title: `Sidebar › ${section} › ${label}`,
        description: `The "${label}" entry in the ${section} section of the left sidebar.`,
        keywords: [...pluginKw, label ?? title],
        reveal: [{ kind: "sidebar", tab: page.tab }],
        selectors: [`.nav-item[data-tab-pill="${page.tab}"]`],
        tab: page.tab,
        parent: id,
        availability: avail,
        source: "plugin-manifest",
        pluginId: p.id,
      });
    }
  }
  for (const slot of c.topbarSlots ?? []) {
    if (typeof slot?.id !== "string") continue;
    out.push({
      id: `plugin:${p.id}/topbar/${slot.id}`,
      kind: "control",
      title: `Topbar › ${name} ${slot.label ?? slot.id}`,
      description: `The ${slot.label ?? slot.id} control ${name} adds to the topbar.`,
      keywords: [...pluginKw, "topbar", slot.label ?? slot.id, slot.id],
      aliases: [`control:topbar/${p.id}-${slot.id}`],
      selectors: [`[data-topbar-slot="${p.id}:${slot.id}"]`],
      fallbackSelectors: ["[data-cb] [data-cb-more] .cb-more__btn"],
      fallbackHint: "It's in this ⋯ menu at this window width.",
      availability: avail,
      source: "plugin-manifest",
      pluginId: p.id,
    });
  }
  return out;
}

// ── guided Learn anchors ────────────────────────────────────────────────────

export type LearnTrackInput = {
  id: string;
  title: string;
  pluginId?: string;
  walkthroughs: Array<{
    id: string;
    title: string;
    steps: Array<{
      id: string;
      title: string;
      body: string;
      route?: string;
      target?: string | string[];
    }>;
  }>;
};

/**
 * Every `learn:<id>` a walkthrough spotlights becomes `learn:<id>` here, with
 * the step's route and copy — Learn's audit proves those anchors render.
 */
export function deriveLearnTargets(
  tracks: LearnTrackInput[],
  pluginOf?: (trackId: string) => string | undefined,
): UiTarget[] {
  const out = new Map<string, UiTarget>();
  for (const track of tracks) {
    if (!track || !Array.isArray(track.walkthroughs)) continue;
    const plugin = track.pluginId ?? pluginOf?.(track.id);
    for (const wt of track.walkthroughs) {
      if (!wt || !Array.isArray(wt.steps)) continue;
      let route: string | undefined;
      for (const step of wt.steps) {
        if (step.route) route = step.route;
        const list = (
          Array.isArray(step.target) ? step.target : step.target ? [step.target] : []
        ).filter((x): x is string => typeof x === "string");
        const first = list.find((t) => t.startsWith("learn:"));
        if (!first) continue;
        const anchor = first.slice("learn:".length);
        const id = `learn:${anchor}`;
        if (out.has(id)) continue;
        out.set(id, {
          id,
          kind: "control",
          title: step.title,
          description: plainText(step.body).slice(0, 260),
          keywords: [track.title, wt.title, anchor.replace(/-/g, " ")],
          route,
          selectors: [learnAttrSelector(anchor), ...list.filter((t) => !t.startsWith("learn:"))],
          ...(plugin ? { availability: { plugin }, pluginId: plugin } : {}),
          source: "learn",
        });
      }
    }
  }
  return [...out.values()];
}

function plainText(md: string): string {
  return md
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// ── setup-status checks ─────────────────────────────────────────────────────

export type SetupCheckInput = {
  id: string;
  title: string;
  tabs: string[];
  action?: { label: string; tab?: string; view?: string; section?: string; href?: string };
  localOnly?: boolean;
  source?: string;
};

/** `core.models` → `setup-check:models`; plugin checks keep their `<plugin>.<name>`. */
export function setupCheckTargetId(checkId: string): string {
  return `setup-check:${checkId.startsWith("core.") ? checkId.slice(5) : checkId}`;
}

export function deriveSetupCheckTargets(
  checks: SetupCheckInput[],
  pathForTab: (tab: string) => string = (t) => `/${t}`,
): UiTarget[] {
  return checks
    .filter((c) => typeof c?.id === "string" && c.id)
    .map((c) => {
      const a = c.action;
      const tab = a?.tab ?? c.tabs[0];
      const route = tab
        ? `${pathForTab(tab)}${a?.view ? `?view=${encodeURIComponent(a.view)}` : ""}`
        : undefined;
      const reveal: RevealStep[] = a?.section
        ? [{ kind: "event", name: "infinibot:setup-section", detail: { section: a.section } }]
        : [];
      const plugin = c.source && c.source !== "core" ? c.source : undefined;
      return {
        id: setupCheckTargetId(c.id),
        kind: "setup-check" as const,
        title: `Setup: ${c.title}`,
        description: a?.label
          ? `${a.label} — fixes the "${c.title}" setup item.`
          : `Where to set up ${c.title}.`,
        keywords: [
          c.title,
          a?.label,
          "setup",
          "set up",
          "configure",
          "needs setup",
          ...c.tabs,
        ].filter((k): k is string => Boolean(k)),
        route,
        reveal: reveal.length ? reveal : undefined,
        selectors: [
          targetAttrSelector(setupCheckTargetId(c.id)),
          `.setup-banner[data-setup-check="${c.id}"]`,
        ],
        tab,
        availability: {
          ...(c.localOnly ? { cloud: false } : {}),
          ...(plugin ? { plugin } : {}),
        },
        source: "setup-status" as const,
        ...(plugin ? { pluginId: plugin } : {}),
      };
    });
}

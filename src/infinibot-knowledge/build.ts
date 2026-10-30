/**
 * Pure knowledge-base builder. Inputs are plain data extracted from the code
 * (scripts/gen-infinibot-knowledge.ts does the extraction at build time); the
 * output is the snapshot committed at generated/core-knowledge.generated.ts.
 */

import { CURATED, type CuratedEntry } from "./curated.js";
import { pluginEntries, pluginSection, type PluginManifestLike } from "./plugins.js";
import { checkTarget, flowTarget, pageTarget, sectionTarget, toolTarget } from "./targets.js";
import type { KnowledgeEntry, KnowledgeSnapshot } from "./types.js";

export type HostSubViewInput = {
  id: string;
  label: string;
  tab: string;
  routes?: readonly string[];
  hidden?: boolean;
};

export type NavInput = {
  groups: ReadonlyArray<{ label: string; tabs: readonly string[] }>;
  retired: Record<string, string>;
  hidden: Record<string, string>;
  redirects: Record<string, string>;
  subviews: Record<string, readonly HostSubViewInput[]>;
  paths: Record<string, string>;
  title: (tab: string) => string;
  subtitle: (tab: string) => string;
  navLabel: (tab: string) => string;
  searchTerms: (tab: string) => string[];
  synonyms: Record<string, string[]>;
  /** Tabs owned by first-party plugins (plugin-host FIRST_PARTY_PAGES). */
  gatedTabs: ReadonlySet<string>;
};

export type SetupSectionInput = { id: string; label: string; desc?: string };
export type SetupCheckInput = {
  id: string;
  title: string;
  tabs: string[];
  localOnly?: boolean;
  action?: { label: string; tab?: string; view?: string; section?: string };
};
export type LearnTrackInput = {
  id: string;
  title: string;
  summary: string;
  pluginId?: string;
  routes?: string[];
  walkthroughs: Array<{
    id: string;
    title: string;
    summary: string;
    steps: Array<{ title: string; body?: string; route?: string }>;
  }>;
};
export type DocInput = { path: string; title: string; summary: string; headings: string[] };
export type ToolInput = {
  name: string;
  description: string;
  allowedForMain: boolean;
  group?: string;
};

export type BuildInputs = {
  nav: NavInput;
  setupSections: SetupSectionInput[];
  setupChecks: SetupCheckInput[];
  learn: LearnTrackInput[];
  docs: DocInput[];
  plugins: PluginManifestLike[];
  /** Status pill labels on a plugin card (On, Off, Needs setup, …). */
  pluginCardStatuses?: string[];
  tools?: ToolInput[];
  inputsHash: string;
};

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const firstSentence = (s: string, max = 240) => {
  const t = clean(s);
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  const out = m ? m[1] : t;
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
};
const uniq = <T>(xs: T[]) => [...new Set(xs.filter(Boolean))];

/** Setup sections whose URL is /setup?view=<id> (routing-only host sub-views). */
function setupSectionRoute(id: string, subviews: NavInput["subviews"]): string {
  return subviews.setup?.some((v) => v.id === id) ? `/setup?view=${id}` : "/setup";
}

export function buildCoreEntries(inputs: BuildInputs): {
  entries: KnowledgeEntry[];
  sidebar: KnowledgeSnapshot["sidebar"];
  pluginSections: KnowledgeSnapshot["pluginSections"];
} {
  const { nav } = inputs;
  const out: KnowledgeEntry[] = [];
  const groupOf = new Map<string, string>();
  for (const g of nav.groups) for (const t of g.tabs) groupOf.set(t, g.label);

  const pluginSections = inputs.plugins
    .map(pluginSection)
    .filter((s): s is NonNullable<typeof s> => !!s);
  const pluginOfTab = new Map<string, { pluginId: string; section: string; label: string }>();
  for (const s of pluginSections)
    for (const i of s.items)
      pluginOfTab.set(i.tab, { pluginId: s.pluginId, section: s.title, label: i.label });

  /** Breadcrumb + owner of a (host) tab. */
  const crumbOf = (tab: string): { crumb: string[]; pluginId?: string } | null => {
    const g = groupOf.get(tab);
    if (g) return { crumb: [g, nav.navLabel(tab)] };
    const p = pluginOfTab.get(tab);
    if (p) return { crumb: [p.section, p.label], pluginId: p.pluginId };
    const hiddenGroup = nav.hidden[tab];
    if (hiddenGroup) return { crumb: [hiddenGroup, nav.title(tab)] };
    return null;
  };

  // Redirect aliases → keywords on their target.
  const aliasesOf = new Map<string, string[]>();
  for (const [from, to] of Object.entries(nav.redirects)) {
    aliasesOf.set(to, [...(aliasesOf.get(to) ?? []), from, nav.title(from)]);
  }

  const subviewTabs = new Set<string>();
  const pageEntry = (
    tab: string,
    crumb: string[],
    extra: Partial<KnowledgeEntry> = {},
  ): KnowledgeEntry => ({
    id: pageTarget(tab),
    kind: "page",
    title: nav.title(tab),
    summary: clean(nav.subtitle(tab)) || nav.title(tab),
    breadcrumb: crumb,
    route: nav.paths[tab],
    tab,
    targets: [pageTarget(tab)],
    keywords: uniq([
      ...nav.searchTerms(tab),
      ...(nav.synonyms[tab] ?? []),
      ...(aliasesOf.get(tab) ?? []),
    ]),
    source: "ui/src/ui/navigation.ts",
    ...extra,
  });

  // 1. Sidebar pages (core groups).
  for (const g of nav.groups) {
    for (const tab of g.tabs) {
      if (nav.gatedTabs.has(tab)) continue;
      out.push(pageEntry(tab, [g.label, nav.navLabel(tab)], { facts: { sidebarGroup: g.label } }));
    }
  }

  // 2. Host sub-tabs.
  for (const [host, views] of Object.entries(nav.subviews)) {
    const hostCrumb = crumbOf(host);
    if (!hostCrumb) continue;
    views.forEach((v, i) => {
      const retiredRoutes = v.routes ?? (v.tab === host ? [] : [v.tab]);
      for (const r of retiredRoutes) subviewTabs.add(r);
      if (i === 0 && !v.hidden) return; // default view = the host page itself
      const id = pageTarget(`${host}/${v.id}`);
      const aliasTargets = retiredRoutes.map((r) => pageTarget(r));
      out.push({
        id,
        kind: "subview",
        title: v.hidden ? v.label : `${nav.navLabel(host)} › ${v.label}`,
        summary: clean(nav.subtitle(v.tab === host ? host : v.tab)) || v.label,
        breadcrumb: [...hostCrumb.crumb, v.label],
        route: `${nav.paths[host]}?view=${v.id}`,
        tab: retiredRoutes[0] ?? host,
        targets: [id, ...aliasTargets],
        keywords: uniq([
          v.label,
          v.id,
          ...retiredRoutes,
          ...retiredRoutes.map((r) => nav.title(r)),
          ...retiredRoutes.flatMap((r) => nav.synonyms[r] ?? []),
          ...(nav.searchTerms(v.tab) ?? []).slice(0, 12),
        ]),
        pluginId: hostCrumb.pluginId,
        requiresPlugin: hostCrumb.pluginId,
        source: "ui/src/ui/navigation.ts HOST_SUBVIEWS",
        facts: { host, view: v.id, ...(v.hidden ? { setupSection: true } : {}) },
      });
    });
  }

  // 3. Retired (non-subview) and hidden pages — still routable.
  for (const [tab, host] of Object.entries(nav.retired)) {
    if (subviewTabs.has(tab) || nav.redirects[tab] || nav.gatedTabs.has(tab) || !nav.paths[tab])
      continue;
    const hc = crumbOf(host);
    if (!hc) continue;
    out.push(
      pageEntry(tab, [...hc.crumb, nav.title(tab)], {
        summary: `${clean(nav.subtitle(tab)) || nav.title(tab)} Not a sidebar entry of its own: reached from ${hc.crumb.join(" › ")} ("Also here") or ⌘K.`,
        pluginId: hc.pluginId,
        requiresPlugin: hc.pluginId,
        facts: { retiredInto: host },
      }),
    );
  }
  for (const [tab, group] of Object.entries(nav.hidden)) {
    if (nav.gatedTabs.has(tab) || !nav.paths[tab]) continue;
    out.push(
      pageEntry(tab, [nav.title(tab)], {
        summary: `${clean(nav.subtitle(tab)) || nav.title(tab)} Not in the sidebar — open it with ⌘K search or the launcher (catalogued under ${group}).`,
        facts: { hiddenFromSidebar: true, catalogGroup: group },
      }),
    );
  }

  // 4. Setup page sections (in-page nav of Settings › Setup).
  const setupCrumb = crumbOf("setup")?.crumb ?? ["Settings", "Setup"];
  for (const s of inputs.setupSections) {
    const route = setupSectionRoute(s.id, nav.subviews);
    const asSubview = out.find((e) => e.id === pageTarget(`setup/${s.id}`));
    const id = sectionTarget("setup", s.id);
    if (asSubview) {
      // Same place as the routing-only sub-view: keep one entry, both ids.
      asSubview.targets = uniq([id, ...asSubview.targets]);
      asSubview.id = id;
      asSubview.kind = "section";
      asSubview.title = `Setup › ${s.label}`;
      asSubview.summary = clean(`${s.desc ?? ""}. ${asSubview.summary}`).replace(/^\.\s*/, "");
      asSubview.breadcrumb = [...setupCrumb, s.label];
      continue;
    }
    out.push({
      id,
      kind: "section",
      title: `Setup › ${s.label}`,
      summary: s.desc ? `${s.label}: ${s.desc}.` : s.label,
      breadcrumb: [...setupCrumb, s.label],
      route,
      tab: "setup",
      targets: [id],
      keywords: uniq([s.label, s.id, s.desc ?? ""]),
      source: "ui/src/ui/views/setup.ts (setup-nav)",
      facts: { openWith: `infinibot:setup-section {section:"${s.id}"}` },
    });
  }

  // 5. Core setup-status checks.
  for (const c of inputs.setupChecks) {
    const a = c.action;
    const fix = a?.section
      ? out.find((e) => e.id === sectionTarget("setup", a.section!))
      : a?.view
        ? out.find(
            (e) =>
              e.targets.includes(sectionTarget(a.tab ?? "setup", a.view!)) ||
              e.id === pageTarget(`${a.tab}/${a.view}`),
          )
        : a?.tab
          ? out.find((e) => e.id === pageTarget(a.tab!))
          : undefined;
    out.push({
      id: checkTarget(c.id),
      kind: "setup-check",
      title: `${c.title} (setup check)`,
      summary: `Sidebar glow + banner on ${c.tabs.map((t) => nav.title(t)).join(", ")} until ready.${a ? ` Fix: "${a.label}"${fix ? ` → ${fix.breadcrumb.join(" › ")}` : ""}.` : ""}${c.localOnly ? " Not checked on InfiniBot Cloud." : ""}`,
      breadcrumb: fix?.breadcrumb ?? setupCrumb,
      route: fix?.route,
      tab: fix?.tab,
      targets: uniq([checkTarget(c.id), ...(fix ? [fix.id] : [])]),
      keywords: uniq([c.title, a?.label ?? "", ...c.tabs]),
      localOnly: c.localOnly,
      source: "src/gateway/setup-status/core-checks.ts",
      facts: { glowsOn: c.tabs },
    });
  }

  // 6. Plugins (manifests).
  for (const m of inputs.plugins) {
    const entries = pluginEntries(m, `extensions/${m.id}/infinibot.plugin.json`);
    const card = entries.find((e) => e.kind === "plugin");
    if (card && inputs.pluginCardStatuses?.length) {
      card.facts = { ...card.facts, cardStatusLabels: inputs.pluginCardStatuses };
      card.summary = `${card.summary} Its card in Home › Plugins shows a status pill (${inputs.pluginCardStatuses.filter((l) => !l.endsWith("…")).join(" / ")}); Enable/Disable is on the card and its detail page.`;
    }
    out.push(...entries);
  }

  // 7. Learn walkthroughs → flows.
  for (const t of inputs.learn) {
    for (const w of t.walkthroughs) {
      const firstRoute = w.steps.find((s) => s.route)?.route;
      out.push({
        id: flowTarget(`learn/${t.id}/${w.id}`),
        kind: "flow",
        title: `${w.title} (${t.title})`,
        summary: firstSentence(w.summary || t.summary),
        breadcrumb: ["Home", "Learn", t.title, w.title],
        route: "/learn",
        tab: "learn",
        targets: [flowTarget(`learn/${t.id}/${w.id}`)],
        keywords: uniq([t.title, w.title, ...w.steps.map((s) => s.title)]),
        steps: w.steps.map(
          (s) =>
            `${s.title}${s.route ? ` [${s.route}]` : ""}${s.body ? ` — ${firstSentence(s.body, 160)}` : ""}`,
        ),
        pluginId: t.pluginId,
        requiresPlugin: t.pluginId,
        source: t.pluginId ? `extensions/${t.pluginId}/learn.json` : "src/learn/guided/core",
        facts: { learnTrack: t.id, walkthrough: w.id, firstRoute: firstRoute ?? null },
      });
    }
  }

  // 8. Docs.
  for (const d of inputs.docs) {
    const id = `doc:${d.path.replace(/\.mdx?$/, "")}`;
    out.push({
      id,
      kind: "doc",
      title: d.title,
      summary: firstSentence(d.summary, 300),
      breadcrumb: ["Docs", d.path],
      targets: [id],
      keywords: uniq([d.title, ...d.headings.slice(0, 20)]),
      source: d.path,
    });
  }

  // 9. Core tools (optional input).
  for (const t of inputs.tools ?? []) {
    if (out.some((e) => e.id === toolTarget(t.name))) continue;
    out.push({
      id: toolTarget(t.name),
      kind: "tool",
      title: t.name,
      summary: firstSentence(t.description, 260),
      breadcrumb: ["Agent tools", t.name],
      targets: [toolTarget(t.name)],
      keywords: [t.name, t.name.replace(/_/g, " ")],
      source: "src/agents/infinibot-tools.ts",
      facts: { allowedForMain: t.allowedForMain, group: t.group ?? null },
    });
  }

  // 10. Curated — inherits breadcrumb/route/tab from its anchor.
  const byAnyId = indexEntries(out);
  for (const c of CURATED) out.push(materializeCurated(c, byAnyId));

  const sidebar = nav.groups.map((g) => ({
    label: g.label,
    items: g.tabs
      .filter((t) => !nav.gatedTabs.has(t))
      .map((t) => ({ tab: t, label: nav.navLabel(t) })),
  }));
  return { entries: out, sidebar, pluginSections };
}

export function indexEntries(entries: KnowledgeEntry[]): Map<string, KnowledgeEntry> {
  const map = new Map<string, KnowledgeEntry>();
  for (const e of entries) {
    if (!map.has(e.id)) map.set(e.id, e);
  }
  for (const e of entries) for (const t of e.targets) if (!map.has(t)) map.set(t, e);
  return map;
}

export function materializeCurated(
  c: CuratedEntry,
  byId: Map<string, KnowledgeEntry>,
): KnowledgeEntry {
  const at = byId.get(c.at);
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    summary: c.summary,
    breadcrumb: at ? [...at.breadcrumb, ...(c.crumbTail ?? [])] : [c.title],
    route: at?.route,
    tab: at?.tab,
    targets: uniq([c.id, ...(c.targets ?? []), ...(at ? [at.id] : [])]),
    keywords: c.keywords,
    pluginId: c.pluginId ?? at?.pluginId,
    requiresPlugin: c.requiresPlugin ?? at?.requiresPlugin,
    localOnly: c.localOnly,
    steps: c.steps,
    related: c.related,
    source: "src/infinibot-knowledge/curated.ts",
    facts: { ...c.facts, anchor: c.at, anchorFound: Boolean(at) },
  };
}

export function buildSnapshot(inputs: BuildInputs): KnowledgeSnapshot {
  const { entries, sidebar, pluginSections } = buildCoreEntries(inputs);
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return { version: 1, inputsHash: inputs.inputsHash, entries, sidebar, pluginSections, counts };
}

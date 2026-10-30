/**
 * Derive UI targets from the control UI's own navigation tables — the single
 * source of truth for pages, merged-host sub-tabs, sidebar entries and topbar
 * controls. The output is committed as src/ui-targets/generated/nav-targets.json
 * (the gateway can't import UI modules); guide/nav-targets.test.ts fails when
 * the JSON drifts from navigation.ts. Regenerate:
 *
 *   UPDATE_UI_TARGETS=1 pnpm -C ui vitest run --config vitest.guide.config.ts
 */

import type { UiTarget } from "../../../../src/ui-targets/types.js";
import { CONTROL_BAR_ITEMS } from "../components/control-bar";
import {
  HIDDEN_TABS,
  HOST_SUBVIEWS,
  NAV_CATALOG_GROUPS,
  RETIRED_TABS,
  SUBVIEW_ROUTES,
  TAB_GROUPS,
  TAB_PATHS,
  TAB_REDIRECTS,
  navSearchTermsForTab,
  subtitleForTab,
  titleForTab,
  type Tab,
} from "../navigation";
import { FIRST_PARTY_PAGES } from "../plugin-host";
import { TAB_SYNONYMS } from "../tab-synonyms";

const PLUGIN_TABS = new Set<string>(Object.values(FIRST_PARTY_PAGES));

/** Topbar control copy the control-bar spec doesn't carry. */
const TOPBAR_EXTRA: Record<string, { title?: string; description: string; keywords?: string[] }> = {
  tabctx: { title: "Page context", description: "The current page name and its quick actions.", keywords: ["current page"] },
  federation: { description: "Every InfiniBot window/tab connected to this gateway (Alpha, Bravo…).", keywords: ["windows", "tabs", "connected tabs"] },
  brand: { title: "InfiniBot logo", description: "Brand mark — opens the launchpad of every page.", keywords: ["logo", "launchpad", "home"] },
  coder: { description: "Which coding agent (Claude Code, Codex, OpenCode…) sub-agents use.", keywords: ["claude code", "codex", "opencode", "coding agent"] },
  health: { description: "Gateway health: connected, degraded or offline.", keywords: ["status", "connection", "online"] },
  instance: { description: "Which InfiniBot instance this window is connected to.", keywords: ["instance name"] },
  satellite: { description: "Federation link to the master node (satellite installs).", keywords: ["master", "federation link"] },
  agency: { description: "Active agency selector (Business & Agency plugin).", keywords: ["agency", "business"] },
  language: { description: "Interface language.", keywords: ["translate", "locale"] },
  newwindow: { description: "Open another InfiniBot window.", keywords: ["new tab", "second window"] },
  restart: { description: "Restart the gateway (reloads plugins and config).", keywords: ["reboot", "reload gateway"] },
  canvas: { description: "Open the holo canvas overlay.", keywords: ["holo canvas", "whiteboard"] },
  chart: { description: "Open the live chart panel (market data).", keywords: ["price chart", "candles", "chart panel"] },
  chat: { description: "Open a chat with any agent in a floating modal.", keywords: ["talk to agent", "agent chat", "message agent"] },
  live: { description: "Live Action mode: voice + the agent drives the UI.", keywords: ["voice control", "live action", "hands free"] },
  "plugin-right": { title: "Plugin topbar controls", description: "Controls plugins add to the topbar (e.g. the Solatrix wallet chip).", keywords: ["plugin controls"] },
  learn: { description: "Guided walkthroughs and courses for this page.", keywords: ["tutorial", "tour", "help"] },
  agent: { description: "Show or hide the agent sidebar.", keywords: ["agent panel"] },
  activity: { description: "Live agent activity feed.", keywords: ["activity feed", "what agents are doing"] },
  approvals: { description: "Pending approvals from agents (exec, trades, messages).", keywords: ["approve", "pending approvals", "approval inbox"] },
};

function uniq(list: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const v = raw?.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

function groupOf(tab: Tab): string | undefined {
  for (const g of NAV_CATALOG_GROUPS) if ((g.tabs as readonly Tab[]).includes(tab)) return g.label;
  return undefined;
}

/** `/setup` → `setup`. */
function pathId(tab: Tab): string {
  const p = (TAB_PATHS as Record<string, string>)[tab] ?? `/${tab}`;
  return p.replace(/^\/+/, "") || tab;
}

/**
 * A host's search terms minus those of retired tabs that have their own
 * sub-view target ("coders" belongs to page:setup/coders, not page:setup).
 */
function hostKeywords(tab: Tab): string[] {
  const own = new Set<string>();
  for (const [retired, sub] of Object.entries(SUBVIEW_ROUTES) as [Tab, { host: Tab; view: string }][]) {
    if (sub.host !== tab || retired === tab) continue;
    for (const k of [retired, titleForTab(retired), ...navSearchTermsForTab(retired)]) own.add(k.toLowerCase());
  }
  return navSearchTermsForTab(tab).filter((s) => s !== tab && !own.has(s.toLowerCase()));
}

export function sidebarSelector(tab: string): string {
  return `.nav-item[data-tab-pill="${tab}"]`;
}

export function deriveNavTargets(): UiTarget[] {
  const out: UiTarget[] = [];
  const byId = new Map<string, UiTarget>();
  const push = (t: UiTarget) => {
    if (byId.has(t.id)) return;
    byId.set(t.id, t);
    out.push(t);
  };
  const addAlias = (id: string, alias: string) => {
    const t = byId.get(id);
    if (!t || alias === id) return;
    t.aliases = uniq([...(t.aliases ?? []), alias]);
  };
  const sidebarTabs = new Set<Tab>(TAB_GROUPS.flatMap((g) => g.tabs as readonly Tab[]));

  // ── pages ──────────────────────────────────────────────────────────────
  const tabs = (Object.keys(TAB_PATHS) as Tab[]).filter(
    (t) => !PLUGIN_TABS.has(t) && !TAB_REDIRECTS[t] && !SUBVIEW_ROUTES[t],
  );
  for (const tab of tabs) {
    const host = RETIRED_TABS[tab];
    const id = `page:${pathId(tab)}`;
    push({
      id,
      kind: "page",
      title: titleForTab(tab),
      description: subtitleForTab(tab) || undefined,
      keywords: uniq([
        ...hostKeywords(tab),
        ...(TAB_SYNONYMS[tab] ?? []),
        groupOf(tab),
      ]),
      aliases: tab !== pathId(tab) ? [`page:${tab}`] : undefined,
      route: `/${pathId(tab)}`,
      tab,
      parent: host ? `page:${pathId(host)}` : undefined,
      source: "navigation",
      ...(HIDDEN_TABS[tab] ? { availability: { note: "Not in the sidebar — reachable by link, launchpad and ⌘K." } } : {}),
    });
    const views = HOST_SUBVIEWS[tab] ?? [];
    views.forEach((v, i) => {
      if (i === 0) return; // the default sub-view is the host page itself
      const subId = `page:${pathId(tab)}/${v.id}`;
      const backing = v.tab !== tab ? v.tab : undefined;
      push({
        id: subId,
        kind: v.hidden ? "section" : "page",
        title: `${titleForTab(tab)} › ${v.label}`,
        description: backing ? subtitleForTab(backing) || undefined : undefined,
        keywords: uniq([
          v.label,
          ...(backing ? [titleForTab(backing), ...(TAB_SYNONYMS[backing] ?? []), ...navSearchTermsForTab(backing)] : []),
          ...(v.routes ?? []).flatMap((r) => [r, titleForTab(r), ...(TAB_SYNONYMS[r] ?? []), ...navSearchTermsForTab(r)]),
        ]).filter((k) => k !== v.id),
        route: `/${pathId(tab)}?view=${encodeURIComponent(v.id)}`,
        selectors: v.hidden ? undefined : [`.host-subtabs[data-host-subtabs="${tab}"] [data-host-view="${v.id}"]`],
        tab: backing ?? tab,
        parent: id,
        source: "host-subview",
      });
    });
    // The default sub-view's own id also lands on the host.
    if (views[0] && views[0].id !== pathId(tab)) addAlias(id, `page:${pathId(tab)}/${views[0].id}`);
  }
  // Retired / redirected routes resolve to where they land.
  for (const [from, host] of Object.entries(TAB_REDIRECTS) as [Tab, Tab][]) {
    if (PLUGIN_TABS.has(from) || PLUGIN_TABS.has(host)) continue;
    const sub = SUBVIEW_ROUTES[from];
    const target = sub
      ? (HOST_SUBVIEWS[sub.host]?.[0]?.id === sub.view ? `page:${pathId(sub.host)}` : `page:${pathId(sub.host)}/${sub.view}`)
      : `page:${pathId(host)}`;
    addAlias(target, `page:${from}`);
    const t = byId.get(target);
    if (t) t.keywords = uniq([...(t.keywords ?? []), from, titleForTab(from), ...(TAB_SYNONYMS[from] ?? [])]);
  }

  // ── sidebar entries ─────────────────────────────────────────────────────
  for (const g of TAB_GROUPS) {
    for (const tab of g.tabs as readonly Tab[]) {
      if (PLUGIN_TABS.has(tab)) continue;
      push({
        id: `nav:sidebar/${tab}`,
        kind: "nav",
        title: `Sidebar › ${g.label} › ${titleForTab(tab)}`,
        description: `The "${titleForTab(tab)}" entry in the ${g.label} group of the left sidebar.`,
        keywords: uniq([titleForTab(tab), ...(TAB_SYNONYMS[tab] ?? [])]),
        reveal: [{ kind: "sidebar", tab }],
        selectors: [sidebarSelector(tab)],
        tab,
        parent: `page:${pathId(tab)}`,
        source: "navigation",
      });
    }
  }
  for (const [i, g] of TAB_GROUPS.entries()) {
    const slug = g.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    push({
      id: `nav:sidebar-group/${slug}`,
      kind: "nav",
      title: `Sidebar group › ${g.label}`,
      description: `The ${g.label} group of the left sidebar (${(g.tabs as readonly Tab[]).filter((t) => sidebarTabs.has(t)).map((t) => titleForTab(t)).join(", ")}).`,
      keywords: ["sidebar group"],
      selectors: [`.nav-group[data-section-id="default-${g.label.toLowerCase().replace(/\s+/g, "-")}"] .nav-category-header`],
      source: "navigation",
      ...(i < 0 ? {} : {}),
    });
  }
  push({
    id: "nav:sidebar",
    kind: "nav",
    title: "Sidebar (left navigation)",
    description: "The left sidebar: every page grouped by area, plus plugin sections. ☰ collapses it to an icon rail.",
    keywords: ["sidebar", "left menu", "navigation", "nav bar", "side menu", "menu"],
    selectors: ["aside.nav.enhanced"],
    source: "navigation",
  });
  push({
    id: "control:sidebar/collapse",
    kind: "control",
    title: "Collapse / expand sidebar",
    description: "The ☰ button at the top-left: collapses the sidebar to an icon rail or expands it.",
    keywords: ["hamburger", "menu button", "icon rail", "hide sidebar", "show sidebar", "collapse sidebar"],
    selectors: [".topbar .nav-collapse-toggle"],
    source: "navigation",
  });

  // ── topbar (control bar) ───────────────────────────────────────────────
  for (const item of CONTROL_BAR_ITEMS) {
    const extra = TOPBAR_EXTRA[item.id];
    push({
      id: `control:topbar/${item.id}`,
      kind: "control",
      title: `Topbar › ${extra?.title ?? item.label ?? item.id}`,
      description: extra?.description,
      keywords: uniq(["topbar", "top bar", extra?.title ? undefined : item.label, ...(extra?.keywords ?? [])]),
      selectors: [`[data-cb] [data-cb-item="${item.id}"]`],
      fallbackSelectors: item.lastHidden ? ["[data-cb] [data-cb-more] .cb-more__btn", "[data-cb] [data-cb-more]"] : undefined,
      fallbackHint: item.lastHidden ? "It's tucked into this ⋯ menu at this window width." : undefined,
      source: "control-bar",
    });
  }
  push({
    id: "control:topbar/more",
    kind: "control",
    title: "Topbar › ⋯ overflow menu",
    description: "Topbar controls that don't fit at this window width move into this menu.",
    keywords: ["more", "overflow", "three dots", "ellipsis"],
    selectors: ["[data-cb] [data-cb-more] .cb-more__btn", "[data-cb] [data-cb-more]"],
    source: "control-bar",
  });
  return out;
}

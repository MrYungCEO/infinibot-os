import { readFileSync } from "node:fs";
import { isPluginGatedTab } from "./plugin-host";
import { describe, expect, it } from "vitest";

import {
  HIDDEN_TABS,
  HOST_SUBVIEWS,
  HOSTS_WITH_OWN_SWITCHER,
  SUBVIEW_ROUTES,
  contentTabFor,
  resolveSubView,
  subViewRouteForTab,
  subViewsForHost,
  NAV_CATALOG_GROUPS,
  RETIRED_TABS,
  TAB_GROUPS,
  TAB_PATHS,
  TAB_REDIRECTS,
  hostForTab,
  matchRoute,
  navLabelForTab,
  navSearchTermsForTab,
  navTargetForEntry,
  pathForTab,
  relatedTabsForHost,
  resolveTabRedirect,
  tabFromPath,
  titleForTab,
  type Tab,
} from "./navigation";

const SIDEBAR_TABS = TAB_GROUPS.flatMap((g) => g.tabs as readonly Tab[]);
const SIDEBAR = new Set<Tab>(SIDEBAR_TABS);
const RETIRED = Object.keys(RETIRED_TABS) as Tab[];
const APP_RENDER_SOURCE = readFileSync(new URL("./app-render.ts", import.meta.url), "utf8");

function hasRenderBlock(tab: Tab): boolean {
  const escaped = tab.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:state\\.tab|view)\\s*===\\s*["']${escaped}["']`).test(APP_RENDER_SOURCE);
}

/** A tab is "valid" when it has a registered route (TAB_PATHS is Record<Tab, …>). */
function isValidTab(tab: Tab): boolean {
  const path = pathForTab(tab);
  return typeof path === "string" && path.startsWith("/") && tabFromPath(path) !== null;
}

describe("sidebar consolidation", () => {
  it("has the five core groups (Business left for the business-agency plugin section)", () => {
    expect(TAB_GROUPS.map((g) => g.label)).toEqual([
      "Home",
      "Chat & Voice",
      "Work",
      "Agents",
      "Settings",
    ]);
  });

  it("every TAB_GROUPS tab is a valid, routable Tab", () => {
    for (const tab of SIDEBAR_TABS) {
      expect(isValidTab(tab), tab).toBe(true);
      expect(titleForTab(tab), tab).toBeTruthy();
    }
  });

  it("lists each sidebar tab once and never lists a retired or hidden tab", () => {
    expect(new Set(SIDEBAR_TABS).size).toBe(SIDEBAR_TABS.length);
    for (const tab of RETIRED) expect(SIDEBAR.has(tab), tab).toBe(false);
    for (const tab of Object.keys(HIDDEN_TABS) as Tab[]) expect(SIDEBAR.has(tab), tab).toBe(false);
  });

  it("every retired tab resolves to a sidebar host", () => {
    for (const tab of RETIRED) {
      const host = hostForTab(tab);
      expect(host, tab).not.toBe(tab);
      // A plugin-gated host (e.g. Discipline) gets its sidebar entry from the
      // plugin while enabled — plugin-host-discipline.test.ts.
      expect(SIDEBAR.has(host) || isPluginGatedTab(host), `${tab} → ${host}`).toBe(true);
    }
  });

  it("retired tabs stay routable (no 404/dead end) and land on a real page", () => {
    for (const tab of RETIRED) {
      expect(isValidTab(tab), tab).toBe(true);
      const landed = tabFromPath(pathForTab(tab));
      // Either the page itself (kept routable) or its redirect target.
      expect(landed, tab).toBe(resolveTabRedirect(tab));
      expect(matchRoute(pathForTab(tab)).tab, tab).toBe(resolveTabRedirect(tab));
    }
  });

  it("every retired tab is reachable from its host: a sub-tab, an 'Also here' link or an alias of the host view", () => {
    for (const tab of RETIRED) {
      const merged = SUBVIEW_ROUTES[tab];
      if (merged) {
        expect(merged.host, tab).toBe(hostForTab(tab));
        continue;
      }
      expect(relatedTabsForHost(hostForTab(tab)), tab).toContain(tab);
    }
  });

  it("retired + hidden tabs stay in the catalogue used by launchpad / ui_control / wake words", () => {
    const catalogue = new Set(NAV_CATALOG_GROUPS.flatMap((g) => g.tabs));
    for (const tab of [...SIDEBAR_TABS, ...RETIRED, ...(Object.keys(HIDDEN_TABS) as Tab[])]) {
      // Pages hosted by a plugin-gated tab are catalogued by the plugin's own
      // section while it's enabled, and must not be reachable while it's off.
      if (isPluginGatedTab(tab) || isPluginGatedTab(hostForTab(tab))) continue;
      expect(catalogue.has(tab), tab).toBe(true);
    }
    expect(NAV_CATALOG_GROUPS.map((g) => g.label)).toEqual(TAB_GROUPS.map((g) => g.label));
  });

  it("every registered route has a render block or redirect and is launchpad-reachable", () => {
    const catalogue = new Set(NAV_CATALOG_GROUPS.flatMap((g) => g.tabs));
    for (const tab of Object.keys(TAB_PATHS) as Tab[]) {
      const redirect = TAB_REDIRECTS[tab];
      expect(hasRenderBlock(tab) || redirect !== undefined, `${tab} has no render or redirect`).toBe(true);
      // Plugin-gated tabs are catalogued by the plugin host only while their
      // plugin is loaded (plugin-host.ts), so they're exempt here.
      expect(
        catalogue.has(tab) || redirect !== undefined || isPluginGatedTab(tab),
        `${tab} is absent from the catalogue`,
      ).toBe(true);
      if (redirect) expect(hasRenderBlock(redirect), `${tab} redirects to unrendered ${redirect}`).toBe(true);
    }
  });

  it("hard redirects are single-hop and land on routable tabs", () => {
    for (const [from, to] of Object.entries(TAB_REDIRECTS) as [Tab, Tab][]) {
      expect(TAB_REDIRECTS[to], `${from} → ${to}`).toBeUndefined();
      expect(tabFromPath(pathForTab(from))).toBe(to);
      expect(matchRoute(pathForTab(from)).tab).toBe(to);
    }
    expect(tabFromPath("/chat")).toBe("grid");
    // /business-hq is the business-agency plugin's own HQ page now.
    expect(tabFromPath("/business-hq")).toBe("business-hq");
    expect(tabFromPath("/overview")).toBe("dashboard");
    expect(tabFromPath("/cron")).toBe("schedule");
    expect(tabFromPath("/sessions")).toBe("sessions");
    expect(hostForTab("sessions")).toBe("webchat");
    expect(tabFromPath("/vcs")).toBe("workspace");
    expect(tabFromPath("/subagents")).toBe("reviews");
  });

  it("keeps deep-link slugs on a redirected/retired route", () => {
    // /databases is merged into Projects: the slug keeps its database kind.
    expect(matchRoute("/databases/crm--abc")).toEqual({
      tab: "projects",
      view: "databases",
      detail: { kind: "database", slug: "crm--abc" },
    });
    // /agency-operations is merged into Command: its nested project deep link
    // lands on the Agencies sub-tab with the project detail intact.
    expect(matchRoute("/agency-operations/projects/p1")).toEqual({
      tab: "command-ceo",
      view: "agencies",
      detail: { kind: "project", slug: "p1" },
    });
  });

  it("uses umbrella sidebar labels without renaming the page", () => {
    expect(navLabelForTab("command-ceo")).toBe("Command");
    expect(navLabelForTab("opportunities")).toBe("Register");
    expect(navLabelForTab("federation")).toBe("Fleet");
    expect(navLabelForTab("apikeys")).toBe("Keys & Usage");
    expect(titleForTab("opportunities")).toBe("Opportunities");
    expect(navLabelForTab("projects")).toBe(titleForTab("projects"));
  });

  it("sidebar search terms include the pages an entry hosts", () => {
    const terms = navSearchTermsForTab("opportunities").map((s) => s.toLowerCase());
    expect(terms).toContain("decisions");
    expect(terms).toContain("people");
  });

  it("sidebar search (⌘K) on a hosted page's name opens that page's sub-tab", async () => {
    const { navSearchTargetForEntry } = await import("./navigation");
    expect(navSearchTargetForEntry("logs", "debug")).toBe("debug");
    expect(tabFromPath(pathForTab(navSearchTargetForEntry("logs", "debug")!))).toBe("logs");
    expect(navSearchTargetForEntry("apikeys", "tokens")).toBe("credits");
    expect(navSearchTargetForEntry("logs", "log")).toBeNull(); // the entry itself matches
    expect(navSearchTargetForEntry("logs", "")).toBeNull();
    expect(navSearchTargetForEntry("logs", "debug", () => false)).toBeNull();
  });

  it("allowlisted users reach a hosted page through its sidebar entry", () => {
    const onlyDecisions = (tab: Tab) => tab === "decisions";
    expect(navTargetForEntry("opportunities", onlyDecisions)).toBe("decisions");
    expect(navTargetForEntry("projects", onlyDecisions)).toBeNull();
    expect(navTargetForEntry("projects")).toBe("projects");
  });

  it("describes the dashboard as what it renders (generic home; Business HQ only with the plugin)", async () => {
    const { subtitleForTab } = await import("./navigation");
    expect(subtitleForTab("dashboard").toLowerCase()).not.toContain("course");
    expect(subtitleForTab("dashboard")).toMatch(/^Home/);
    expect(subtitleForTab("dashboard")).not.toMatch(/Business HQ/);
  });
});

/**
 * Phase 2: retired tab → [host, sub-view id, tab rendered in that sub-view].
 * One row per merged route; extend when a pair is merged.
 */
const MERGED: ReadonlyArray<[Tab, Tab, string, Tab]> = [
  ["oversight", "reviews", "oversight", "oversight"],
  ["subagents", "reviews", "oversight", "oversight"],
  ["email", "inbox", "mail", "inbox"],
  ["emails", "inbox", "mail", "inbox"],
  ["reply-inbox", "inbox", "replies", "inbox"],
  ["content-intel", "content-pages", "intel", "content-intel"],
  ["prompt-templates", "workflows", "templates", "prompt-templates"],
  ["directories", "files", "directories", "directories"],
  ["knowledge-graph", "memory", "graph", "knowledge-graph"],
  ["mobilepage", "mobile", "web", "mobile"],
  ["debug", "logs", "debug", "debug"],
  ["credits", "apikeys", "usage", "credits"],
  ["budget", "apikeys", "usage", "credits"],
  ["comms", "channels", "inbox", "comms"],
  ["messages", "channels", "inbox", "comms"],
  ["focus", "discipline", "focus", "focus"],
  ["databases", "projects", "databases", "databases"],
  ["product-portfolio", "products", "portfolio", "product-portfolio"],
  ["hardware", "federation", "hardware", "hardware"],
  ["ollama", "federation", "ollama", "ollama"],
  ["config", "setup", "config", "config"],
  ["components", "setup", "components", "setup"],
  ["coders", "setup", "coders", "setup"],
  ["command-ops", "command-ceo", "operations", "command-ops"],
  ["agency-daily", "command-ceo", "today", "agency-daily"],
  ["agency-operations", "command-ceo", "agencies", "agency-operations"],
  ["agency-topology", "command-ceo", "topology", "agency-topology"],
  ["decisions", "opportunities", "decisions", "decisions"],
  ["risks", "opportunities", "risks", "risks"],
  ["commitments", "opportunities", "commitments", "commitments"],
  ["people", "opportunities", "people", "people"],
  // Business Hub draws its own switcher; the old pages land on its sections.
  ["leads", "hub", "leads", "hub"],
  ["pipeline", "hub", "pipeline", "hub"],
  ["campaigns", "hub", "campaigns", "hub"],
  ["qualifier", "funnels", "qualifier", "qualifier"],
];

describe("merged host pages (phase 2)", () => {
  it.each(MERGED)("%s → %s ?view=%s", (retired, host, view, content) => {
    expect(subViewRouteForTab(retired)).toEqual({ host, view });
    expect(TAB_REDIRECTS[retired]).toBe(host);
    expect(tabFromPath(pathForTab(retired))).toBe(host);
    expect(matchRoute(pathForTab(retired))).toEqual({ tab: host, view });
    expect(matchRoute(`/base${pathForTab(retired)}`, "/base")).toEqual({ tab: host, view });
    expect(contentTabFor(host, view)).toBe(content);
    expect(subViewsForHost(host).map((v) => v.id)).toContain(view);
  });

  it("covers every SUBVIEW_ROUTES entry in the table above", () => {
    expect(new Set(Object.keys(SUBVIEW_ROUTES))).toEqual(new Set(MERGED.map((m) => m[0])));
  });

  it("each merged host's first sub-view is the host's own content (the default)", () => {
    for (const [host, views] of Object.entries(HOST_SUBVIEWS) as [Tab, NonNullable<(typeof HOST_SUBVIEWS)[Tab]>][]) {
      expect(views[0]!.tab, host).toBe(host);
      expect(resolveSubView(host, undefined)?.id).toBe(views[0]!.id);
      expect(resolveSubView(host, "no-such-view")?.id).toBe(views[0]!.id);
      expect(contentTabFor(host)).toBe(host);
      expect(new Set(views.map((v) => v.id)).size, host).toBe(views.length);
      // Plugin-gated hosts (content-studio's content-pages) get their sidebar
      // entry from the plugin host while the plugin is loaded.
      expect(SIDEBAR.has(host) || isPluginGatedTab(host), host).toBe(true);
    }
  });

  it("merged routes drop the 'Also here' chip but stay in the launchpad / wake-word catalogue", () => {
    const catalogue = new Set(NAV_CATALOG_GROUPS.flatMap((g) => g.tabs));
    for (const [retired, host] of MERGED) {
      expect(relatedTabsForHost(host), retired).not.toContain(retired);
      if (RETIRED_TABS[retired] && !isPluginGatedTab(host) && !isPluginGatedTab(retired))
        expect(catalogue.has(retired), retired).toBe(true);
    }
  });

  it("the inbox keeps its own badge-carrying switcher (no second bar)", () => {
    expect(HOSTS_WITH_OWN_SWITCHER.has("inbox")).toBe(true);
    expect(subViewsForHost("inbox").map((v) => v.id)).toEqual(["mail", "replies", "insights"]);
  });

  it("InfiCode is a plugin-gated route of its own, not a Setup or terminal sub-tab", () => {
    expect(subViewsForHost("terminals").map((v) => v.id)).toEqual(["terminals"]);
    expect(subViewRouteForTab("inficode")).toBeUndefined();
    expect(matchRoute("/inficode")).toEqual({ tab: "inficode" });
  });

  it("ordinary pages have no sub-views and render themselves", () => {
    expect(subViewsForHost("research")).toEqual([]);
    expect(contentTabFor("research", "anything")).toBe("research");
  });

  it("Documents has a Documents | Ideas switch of its own, both on the notes page", () => {
    expect(subViewsForHost("notes").map((v) => v.id)).toEqual(["documents", "ideas"]);
    expect(contentTabFor("notes", "ideas")).toBe("notes");
    expect(contentTabFor("notes", "anything")).toBe("notes");
    expect(HOSTS_WITH_OWN_SWITCHER.has("notes")).toBe(true);
  });
});

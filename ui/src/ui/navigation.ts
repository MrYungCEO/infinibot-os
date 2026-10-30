import type { IconName } from "./icons.js";
import { t } from "./i18n";
import type { EntityKind } from "./lib/slugs.js";
import { isTabAvailable, pluginNavLabel } from "./plugin-host.js";

export const TAB_GROUPS = [
  // Plugins: its own page (catalog, purchases), no longer a Setup sub-tab.
  { label: "Home", tabs: ["dashboard", "daily-review", "learn", "plugins"] },
  // Inbox (email) and Research stay core — communication and knowledge, not
  // business (docs/plugins/BUSINESS-AGENCY.md § What stayed core).
  { label: "Chat & Voice", tabs: ["webchat", "grid", "voice", "inbox"] },
  // "discipline", "whiteboard" and "canvas" (HoloCanvas library) left core:
  // their plugins contribute them (own sidebar sections) only while enabled —
  // plugin-host.ts FIRST_PARTY_PAGES.
  { label: "Work", tabs: ["projects", "notes", "schedule", "research"] },
  // content-pages (+ content-intel) and products (Catalog + Portfolio) left
  // core: each is contributed as its own plugin section (plugin-host.ts
  // FIRST_PARTY_PAGES) and is absent from every core catalogue while off.
  // Business HQ, Command, Clients, Sales Pipeline, Register, Leads & Funnels
  // and Business settings left core: the business-agency plugin contributes
  // them as ONE "Business & Agency" section while enabled.
  { label: "Agents", tabs: ["agents", "activity", "mesh", "reviews", "launch-panel", "reports", "autonomy", "workflows", "memory", "issues", "terminals", "workspace", "files", "browser", "federation"] },
  { label: "Settings", tabs: ["setup", "channels", "apikeys", "mcp", "skills", "profiles", "access", "appearance", "mobile", "docs", "logs"] },
] as const;

/**
 * Old control-bus vocabulary may still pass these ids. They deliberately have
 * no URL, title, icon, render block, or catalogue entry.
 */
export type LegacyUnroutableTab = "wallet" | "trading" | "moltbook";

export type Tab =
  | "overview"
  | "channels"
  | "instances"
  | "sessions"
  | "cron"
  | "schedule"
  | "projects"
  | "agents"
  | "skills"
  | "nodes"
  | "chat"
  | "grid"
  | "voice"
  | "voicecommands"
  | "webchat"
  | "config"
  | "apikeys"
  | "components"
  | "coders"
  | "kinglyvault"
  | "debug"
  | "activity"
  | "mesh"
  | "subagents"
  | "autonomy"
  | "memory"
  | "workflows"
  | "launch-panel"
  | "logs"
  | "mcp"
  | "notes"
  | "issues"
  | "research"
  | "terminals"
  | "business"
  | "business-hq"
  | "hub"
  | "command-ceo"
  | "command-ops"
  | "android-ops"
  | "agency-operations"
  | "agency-topology"
  | "agency-daily"
  | "clients"
  | "comms"
  | "leads"
  | "funnels"
  | "databases"
  | "repos"
  | "messages"
  | "vcs"
  | "budget"
  | "credits"
  | "files"
  | "directories"
  | "whiteboard"
  | "monsoon-studio"
  | "browser"
  | "setup"
  | "federation"
  | "storyboard"
  | "discipline"
  | "appearance"
  | "sites"
  | "workspace"
  | "docs"
  | "qualifier"
  | "users"
  | "access"
  | "profiles"
  | "mobile"
  | "mobilepage"
  | "knowledge-graph"
  | "learn"
  | "daily-review"
  | "apps"
  | "email"
  | "emails"
  | "inbox"
  | "products"
  | "opportunities"
  | "decisions"
  | "risks"
  | "commitments"
  | "product-portfolio"
  | "people"
  | "people-network"
  | "design"
  | "hardware"
  | "pipeline"
  | "campaigns"
  | "reply-inbox"
  | "content-pages"
  | "content-intel"
  | "prompt-templates"
  | "dashboard"
  | "oversight"
  | "reports"
  | "reviews"
  | "inficode"
  | "robovoice"
  | "omniclinic"
  | "oc-research"
  | "oc-databases"
  | "infinitrade"
  | "infinitrade-knowledge"
  | "infinitrade-calendar"
  | "infinitrade-scanner"
  | "infinitrade-signals"
  | "infinitrade-journal"
  | "infinitrade-accounts"
  | "infinitrade-toolkit"
  | "infinitrade-indicators"
  | "infinitrade-personal"
  | "infinitrade-research"
  | "infinitrade-settings"
  | "solatrix-bubblemap"
  | "solatrix-convergence"
  | "solatrix-alerts"
  | "solatrix"
  | "solatrix-portfolio"
  | "solatrix-wallets"
  | "solatrix-discovery"
  | "solatrix-copy"
  | "solatrix-launcher"
  | "solatrix-map"
  | "solatrix-queue"
  | "solatrix-settings"
  | "flypic"
  | "droid-swarm"
  | "community"
  | "part-scan"
  | "canvas"
  | "plugins"
  | "robopark"
  | "systems"
  | "image-studio"
  | "vault"
  | "ollama"
  | "focus"
  | LegacyUnroutableTab;

// ---------------------------------------------------------------------------
// Sidebar consolidation (phase 1: nav/routing only)
// ---------------------------------------------------------------------------
//
// TAB_GROUPS above is the sidebar. Tabs that used to have their own sidebar
// entry but now live under a "host" entry are RETIRED: they are no longer in
// the sidebar, but they stay routable (URL, bookmark, ui_control, launchpad,
// wake word) and the host page links to them ("Also here"). Only tabs whose
// content the host view already fully covers are hard-redirected (see
// TAB_REDIRECTS). Phase 2 folds the retired views into their hosts.

/** Retired sidebar tab → the sidebar entry that now hosts it. */
export const RETIRED_TABS: Partial<Record<Tab, Tab>> = {
  // voicecommands: now a hard redirect to the Voice page (TAB_REDIRECTS).
  databases: "projects",
  messages: "channels",
  budget: "apikeys",
  focus: "discipline",
  "command-ops": "command-ceo",
  "agency-daily": "command-ceo",
  "agency-operations": "command-ceo",
  "agency-topology": "command-ceo",
  email: "inbox",
  "product-portfolio": "products",
  // content-intel: plugin-gated sub-view of content-pages (content-studio
  // plugin); HOST_SUBVIEWS still routes /content-intel → ?view=intel.
  decisions: "opportunities",
  risks: "opportunities",
  commitments: "opportunities",
  people: "opportunities",
  // Business & Agency plugin: leads, the sales pipeline and campaigns live in
  // the Business Hub; the funnel builder hosts the lead-qualifier forms.
  qualifier: "funnels",
  leads: "hub",
  pipeline: "hub",
  campaigns: "hub",
  oversight: "reviews",
  "prompt-templates": "workflows",
  "knowledge-graph": "memory",
  // Session registry (filters, labels, per-session levels, delete): its own
  // page again, listed under Chat in the sidebar.
  sessions: "webchat",
  // inficode is NOT retired: it is a plugin-gated tab owned by the
  // `infinicode` manifest-v2 plugin (plugin-host.ts). Its sidebar entry and
  // page exist only while that plugin is loaded.
  directories: "files",
  hardware: "federation",
  ollama: "federation",
  config: "setup",
  components: "setup",
  coders: "setup",
  kinglyvault: "setup",
  comms: "channels",
  credits: "apikeys",
  mobilepage: "mobile",
  debug: "logs",
};

/**
 * Tabs deliberately kept out of the sidebar but reachable by direct URL,
 * launchpad and ui_control. Value = the sidebar group they are catalogued in.
 */
export const HIDDEN_TABS: Partial<Record<Tab, string>> = {
  apps: "Home",
  sites: "Work",
  design: "Work",
  storyboard: "Work",
  instances: "Agents",
  nodes: "Agents",
  "android-ops": "Agents",
  users: "Settings",
  vault: "Work",
};

/**
 * Hard redirects: hitting one of these tabs (URL, bookmark, ui_control,
 * setTab) lands on the target instead. Reserved for routes whose content the
 * target view already shows — anything else stays routable via RETIRED_TABS
 * so no feature becomes unreachable.
 */
export const TAB_REDIRECTS: Partial<Record<Tab, Tab>> = {
  // Standalone /chat is deprecated → the grid chat panel.
  chat: "grid",
  // /business-hq is the Business & Agency plugin's HQ page (no redirect).
  // Legacy routes with no render block (they showed a blank page) → the
  // surface that actually carries that content today.
  overview: "dashboard",
  cron: "schedule",
  // Legacy routes that previously rendered a blank content area.
  vcs: "workspace",
  // Systems Intelligence page removed from the UI; backend RPCs still feed
  // the dashboard insights card.
  systems: "dashboard",
  // Image Studio page removed from the UI.
  "image-studio": "dashboard",
  // Robopark page removed; its Fleet siblings now live under Federation.
  robopark: "federation",
  // The old local wake-phrase page is gone; wake words are set on the Voice page.
  voicecommands: "voice",
};

// ---------------------------------------------------------------------------
// Sidebar consolidation (phase 2: merged hosts)
// ---------------------------------------------------------------------------
//
// A merged host is ONE page with in-page sub-tabs (views/host-subtabs.ts).
// Each sub-view is backed by an existing tab's render block + data loaders
// (`tab`), so the retired view's content renders inside the host unchanged.
// The retired route hard-redirects to host + sub-view: /oversight →
// /reviews?view=oversight. Bookmarks, ui_control, wake words, launchpad and
// ⌘K all go through setTab/matchRoute, so they land on the right sub-tab.

export type HostSubView = {
  /** Value of `?view=` (the first sub-view is the default and omits it). */
  id: string;
  label: string;
  /** Tab whose render block and data loaders back this sub-view. */
  tab: Tab;
  /** Retired routes that land here. Default: `[tab]` unless `tab` is the host. */
  routes?: readonly Tab[];
  /**
   * Routing-only sub-view: not shown in the bar (its tab's entry lights up
   * instead). Used when a retired page folds into a section of the host's
   * own view, e.g. /components → Setup › Components.
   */
  hidden?: boolean;
};

export const HOST_SUBVIEWS: Partial<Record<Tab, readonly HostSubView[]>> = {
  // "Command": two lenses over the same kanban + business-object data (CEO
  // exceptions vs Ops full visibility — different derivations, no shared
  // panels), plus the three agency.ops.* surfaces (daily board, the agency
  // CRUD workspace, the relations graph).
  "command-ceo": [
    { id: "executive", label: "Executive", tab: "command-ceo" },
    { id: "operations", label: "Operations", tab: "command-ops" },
    { id: "today", label: "Today", tab: "agency-daily" },
    { id: "agencies", label: "Agencies", tab: "agency-operations" },
    { id: "topology", label: "Topology", tab: "agency-topology" },
  ],
  // "Register": one store each (opportunity.* / decision.* / risk.* /
  // commitment.* / person.*).
  opportunities: [
    { id: "opportunities", label: "Opportunities", tab: "opportunities" },
    { id: "decisions", label: "Decisions", tab: "decisions" },
    { id: "risks", label: "Risks", tab: "risks" },
    { id: "commitments", label: "Commitments", tab: "commitments" },
    { id: "people", label: "People", tab: "people" },
  ],
  // Business Hub (business-agency plugin): one connected page for leads, the
  // pipeline, contacts, clients, campaigns, landing pages, imports and revenue.
  // It draws its own section switcher (HOSTS_WITH_OWN_SWITCHER); the retired
  // /leads, /pipeline and /campaigns routes land on their section.
  hub: [
    { id: "overview", label: "Overview", tab: "hub" },
    { id: "offers", label: "Offers", tab: "hub" },
    { id: "autopilot", label: "Autopilot", tab: "hub" },
    { id: "autopilot-inbox", label: "Autopilot inbox", tab: "hub" },
    { id: "bookings", label: "Bookings", tab: "hub" },
    { id: "leads", label: "Leads", tab: "hub", routes: ["leads"] },
    { id: "pipeline", label: "Pipeline", tab: "hub", routes: ["pipeline"] },
    { id: "contacts", label: "Contacts", tab: "hub" },
    { id: "clients", label: "Clients", tab: "hub" },
    { id: "campaigns", label: "Campaigns", tab: "hub", routes: ["campaigns"] },
    { id: "tracking", label: "Landing pages", tab: "hub" },
    { id: "imports", label: "Imports", tab: "hub" },
    { id: "revenue", label: "Revenue", tab: "hub" },
  ],
  // "Funnels & Forms" (business-agency plugin): the funnel builder and the
  // lead-qualifier form builder. Their submissions land in the Business Hub.
  funnels: [
    { id: "funnels", label: "Funnels", tab: "funnels" },
    { id: "qualifier", label: "Forms", tab: "qualifier" },
  ],
  setup: [
    { id: "setup", label: "Setup", tab: "setup" },
    { id: "config", label: "Config", tab: "config" },
    // Components is one small Electron-only card: folded into Setup's own
    // section nav rather than given a sub-tab.
    { id: "components", label: "Components", tab: "setup", routes: ["components"], hidden: true },
    // /setup?view=coders → Setup's "Coders" section (install / sign in CLI
    // coding agents). Routing-only, like Components.
    { id: "coders", label: "Coders", tab: "setup", routes: ["coders"], hidden: true },
    // /setup?view=kinglyvault → Setup's "Connect KinglyVault" section (the
    // kinglyvault-relay plugin's pairing screen). Routing-only, like Coders.
    { id: "kinglyvault", label: "Connect KinglyVault", tab: "setup", routes: ["kinglyvault"], hidden: true },
  ],
  // "Fleet": InfiniBot gateway nodes, their live hardware telemetry and the
  // local Ollama server — separate sources. (Robopark page removed.)
  federation: [
    { id: "federation", label: "Federation", tab: "federation" },
    { id: "hardware", label: "Hardware", tab: "hardware" },
    { id: "ollama", label: "Ollama", tab: "ollama" },
  ],
  // Separate stores despite the names: products.* is the inventory catalog
  // (SKU/price/stock/Stripe), product.* the strategy portfolio (validation
  // stage, owners, value proposition).
  products: [
    { id: "catalog", label: "Catalog", tab: "products" },
    { id: "portfolio", label: "Portfolio", tab: "product-portfolio" },
  ],
  terminals: [
    { id: "terminals", label: "Terminals", tab: "terminals" },
  ],
  projects: [
    { id: "projects", label: "Projects", tab: "projects" },
    { id: "databases", label: "Databases", tab: "databases" },
    // Deploy branch per repo + branch health / safe cleanup (src/projects/repos).
    { id: "repos", label: "Repos & deploy", tab: "repos" },
  ],
  discipline: [
    { id: "discipline", label: "Day", tab: "discipline" },
    { id: "focus", label: "Focus board", tab: "focus" },
  ],
  // Comms Hub's own channel-setup panel duplicated this page; only its
  // cross-channel inbox (threads, composer, draft approvals) comes across.
  channels: [
    { id: "channels", label: "Channels", tab: "channels" },
    { id: "inbox", label: "Inbox", tab: "comms", routes: ["comms", "messages"] },
  ],
  apikeys: [
    { id: "keys", label: "API keys", tab: "apikeys" },
    { id: "usage", label: "Usage & plans", tab: "credits", routes: ["credits", "budget"] },
  ],
  logs: [
    { id: "logs", label: "Logs", tab: "logs" },
    { id: "debug", label: "Debug", tab: "debug" },
  ],
  reviews: [
    { id: "reviews", label: "Run reviews", tab: "reviews" },
    // /subagents had no page of its own; it has always meant live oversight.
    { id: "oversight", label: "Oversight", tab: "oversight", routes: ["oversight", "subagents"] },
  ],
  // Voice has no sub-tabs: everything (local voice, the default, and the
  // optional Cloud voice (Robovoice)) lives on one page. The old
  // "Commands" sub-tab (local wake phrases) redirects to it — see TAB_REDIRECTS.
  "content-pages": [
    { id: "pages", label: "Pages", tab: "content-pages" },
    { id: "intel", label: "Intelligence", tab: "content-intel" },
  ],
  workflows: [
    { id: "workflows", label: "Workflows", tab: "workflows" },
    { id: "templates", label: "Prompt templates", tab: "prompt-templates" },
  ],
  files: [
    { id: "files", label: "Files", tab: "files" },
    { id: "directories", label: "Directory map", tab: "directories" },
  ],
  memory: [
    // Per-agent "what does it know / what can it reach" (agents.knowledge.profile);
    // same backing tab as Memory — app-render branches on the sub-view id.
    { id: "agents", label: "Agents", tab: "memory" },
    { id: "memory", label: "Memory", tab: "memory" },
    { id: "graph", label: "Knowledge graph", tab: "knowledge-graph" },
  ],
  // /mobilepage was a chrome-free iframe of the same /mobile-web/ bundle the
  // Mobile page's "Web Preview" tab embeds: folded onto that tab.
  mobile: [
    { id: "expo", label: "Dev client (Metro)", tab: "mobile" },
    { id: "build", label: "Build the app", tab: "mobile" },
    { id: "web", label: "Web Preview", tab: "mobile", routes: ["mobilepage"] },
  ],
  // Gmail is an account/source of the unified inbox (connected via the
  // inbox's email-accounts manager), not a page: the old mail routes land on
  // the inbox's own All Mail / Replies / Insights switch.
  // Documents › Ideas (views/documents/ideas.ts): same page, its own switcher
  // (views/documents/shell.ts) — /notes?view=ideas deep-links the Ideas section.
  notes: [
    { id: "documents", label: "Documents", tab: "notes" },
    { id: "ideas", label: "Ideas", tab: "notes" },
  ],
  inbox: [
    { id: "mail", label: "All Mail", tab: "inbox", routes: ["email", "emails"] },
    { id: "replies", label: "Replies", tab: "inbox", routes: ["reply-inbox"] },
    { id: "insights", label: "Insights", tab: "inbox" },
  ],
};

/**
 * Hosts whose view draws its own sub-view switcher (bound to state.hostView)
 * instead of the shared host-subtabs bar — e.g. the inbox toggle carries
 * unread/urgent badges.
 */
export const HOSTS_WITH_OWN_SWITCHER: ReadonlySet<Tab> = new Set<Tab>(["inbox", "mobile", "hub", "notes"]);

/** Retired route → the host + sub-view it now lands on. */
export const SUBVIEW_ROUTES: Partial<Record<Tab, { host: Tab; view: string }>> = {};

for (const [host, views] of Object.entries(HOST_SUBVIEWS) as [Tab, readonly HostSubView[]][]) {
  for (const v of views) {
    for (const route of v.routes ?? (v.tab === host ? [] : [v.tab])) {
      SUBVIEW_ROUTES[route] = { host, view: v.id };
      TAB_REDIRECTS[route] = host;
    }
  }
}

/** The sub-tabs of a merged host page (empty for ordinary pages). */
export function subViewsForHost(host: Tab): readonly HostSubView[] {
  return HOST_SUBVIEWS[host] ?? [];
}

/** Where a retired route lands inside its merged host, if it was merged. */
export function subViewRouteForTab(tab: Tab): { host: Tab; view: string } | undefined {
  return SUBVIEW_ROUTES[tab];
}

/** The active sub-view of a host for a (possibly missing/unknown) `?view=` value. */
export function resolveSubView(host: Tab, view?: string | null): HostSubView | undefined {
  const views = subViewsForHost(host);
  return views.find((v) => v.id === view) ?? views[0];
}

/** The tab whose content is on screen: the active sub-view's tab, or the tab itself. */
export function contentTabFor(tab: Tab, view?: string | null): Tab {
  return resolveSubView(tab, view)?.tab ?? tab;
}

/** contentTabFor for an app-like host ({ tab, hostView }). */
export function contentTabOf(host: { tab: Tab; hostView?: Partial<Record<Tab, string>> }): Tab {
  return contentTabFor(host.tab, host.hostView?.[host.tab]);
}

/** Follow TAB_REDIRECTS (single hop — targets are never themselves redirected). */
export function resolveTabRedirect(tab: Tab): Tab {
  return TAB_REDIRECTS[tab] ?? tab;
}

/** The sidebar entry a tab lives under: itself, or its host if retired. */
export function hostForTab(tab: Tab): Tab {
  return RETIRED_TABS[tab] ?? tab;
}

/**
 * Sidebar-only labels for consolidated entries. The page title (topbar,
 * launchpad, wake words) keeps titleForTab so the page still names what it
 * shows; the sidebar names the umbrella.
 */
const NAV_LABEL_OVERRIDES: Partial<Record<Tab, string>> = {
  "command-ceo": "Command",
  opportunities: "Register",
  federation: "Fleet",
  apikeys: "Keys & Usage",
};

/** Label for a tab's sidebar entry. */
export function navLabelForTab(tab: Tab): string {
  // Plugin-contributed entries use the label from their manifest.
  return pluginNavLabel(tab) ?? NAV_LABEL_OVERRIDES[tab] ?? titleForTab(tab);
}

/**
 * Search haystack for a sidebar entry: its own id/label plus the ids and
 * titles of the retired tabs it hosts, so typing "decisions" in the sidebar
 * search still finds "Register".
 */
/**
 * Extra ⌘K phrases for pages whose name isn't what people type
 * ("install claude code" → Setup › Coders).
 */
const TAB_SEARCH_KEYWORDS: Partial<Record<Tab, readonly string[]>> = {
  "people-network": ["my network", "relationships", "contacts", "connections", "warm intro", "who do i know"],
  coders: [
    "install claude code",
    "claude code",
    "install codex",
    "codex cli",
    "opencode",
    "gemini cli",
    "qwen code",
    "aider",
    "coding agent",
    "coder cli",
  ],
};

function keywordsMatch(tab: Tab, q: string): boolean {
  return (TAB_SEARCH_KEYWORDS[tab] ?? []).some((k) => k.includes(q) || q.includes(k));
}

export function navSearchTermsForTab(tab: Tab): string[] {
  const hosted = (Object.keys(RETIRED_TABS) as Tab[]).filter((t) => RETIRED_TABS[t] === tab);
  return [
    tab,
    titleForTab(tab),
    ...hosted,
    ...hosted.map((t) => titleForTab(t)),
    ...[tab, ...hosted].flatMap((t) => TAB_SEARCH_KEYWORDS[t] ?? []),
  ];
}

/**
 * Where a sidebar entry navigates for a user gated by a page allowlist: the
 * entry itself when allowed, otherwise the first page it hosts that IS allowed
 * (so a user allowed only /decisions still reaches it through "Register").
 * Null when neither the entry nor anything it hosts is allowed.
 */
export function navTargetForEntry(tab: Tab, isAllowed?: (tab: Tab) => boolean): Tab | null {
  if (!isAllowed || isAllowed(tab)) return tab;
  const hosted = (Object.keys(RETIRED_TABS) as Tab[]).filter((t) => RETIRED_TABS[t] === tab);
  return hosted.find((t) => isAllowed(t)) ?? null;
}

/**
 * Sidebar search (⌘K): when the query names a page an entry hosts rather than
 * the entry itself ("debug" → Logs), clicking the entry opens that page — for
 * a merged host that is its sub-tab (/debug → /logs?view=debug). Null when the
 * entry's own name matches or nothing it hosts does.
 */
export function navSearchTargetForEntry(
  tab: Tab,
  query: string,
  isAllowed?: (tab: Tab) => boolean,
): Tab | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  if ([tab, titleForTab(tab), navLabelForTab(tab)].some((s) => s.toLowerCase().includes(q))) return null;
  const hosted = (Object.keys(RETIRED_TABS) as Tab[]).filter((t) => RETIRED_TABS[t] === tab);
  return (
    hosted.find(
      (t) =>
        (!isAllowed || isAllowed(t)) &&
        (t.includes(q) || titleForTab(t).toLowerCase().includes(q) || keywordsMatch(t, q)),
    ) ?? null
  );
}

/** Retired tabs a host page should surface as "Also here" links. */
export function relatedTabsForHost(host: Tab): Tab[] {
  return (Object.keys(RETIRED_TABS) as Tab[]).filter(
    (t) => RETIRED_TABS[t] === host && !TAB_REDIRECTS[t],
  );
}

/**
 * Every routable page grouped the way the sidebar groups them: the sidebar
 * tabs, then each group's retired tabs (right after their host's group
 * members) and hidden tabs. Used by surfaces that must reach EVERY page —
 * launchpad, ui_control's app catalogue, tab wake words — so consolidating
 * the sidebar doesn't make pages unreachable from them.
 */
export const NAV_CATALOG_GROUPS: ReadonlyArray<{ label: string; tabs: readonly Tab[] }> =
  TAB_GROUPS.map((g) => {
    const own = g.tabs as readonly Tab[];
    const retired = own.flatMap((host) =>
      (Object.keys(RETIRED_TABS) as Tab[]).filter(
        (t) => RETIRED_TABS[t] === host && (!TAB_REDIRECTS[t] || SUBVIEW_ROUTES[t]),
      ),
    );
    const hidden = (Object.keys(HIDDEN_TABS) as Tab[]).filter((t) => HIDDEN_TABS[t] === g.label);
    return { label: g.label, tabs: [...own, ...retired, ...hidden] };
  });

export const TAB_PATHS: Record<Exclude<Tab, LegacyUnroutableTab>, string> = {
  overview: "/overview",
  channels: "/channels",
  instances: "/instances",
  sessions: "/sessions",
  cron: "/cron",
  schedule: "/schedule",
  projects: "/projects",
  agents: "/agents",
  activity: "/activity",
  subagents: "/subagents",
  autonomy: "/autonomy",
  memory: "/memory",
  workflows: "/workflows",
  "launch-panel": "/launch-panel",
  skills: "/skills",
  nodes: "/nodes",
  chat: "/chat",
  grid: "/grid",
  voice: "/voice",
  voicecommands: "/voice-commands",
  webchat: "/webchat",
  config: "/config",
  apikeys: "/apikeys",
  components: "/components",
  coders: "/coders",
  kinglyvault: "/kinglyvault",
  debug: "/debug",
  logs: "/logs",
  mcp: "/mcp",
  notes: "/notes",
  issues: "/issues",
  research: "/research",
  terminals: "/terminals",
  business: "/business",
  "business-hq": "/business-hq",
  hub: "/hub",
  "command-ceo": "/ceo",
  "command-ops": "/ops",
  "android-ops": "/android-ops",
  "agency-operations": "/agency-operations",
  "agency-topology": "/agency-topology",
  "agency-daily": "/agency-daily",
  clients: "/clients",
  comms: "/comms",
  leads: "/leads",
  funnels: "/funnels",
  databases: "/databases",
  repos: "/repos",
  messages: "/messages",
  budget: "/budget",
  credits: "/credits",
  vcs: "/vcs",
  files: "/files",
  directories: "/directories",
  whiteboard: "/whiteboard",
  "monsoon-studio": "/product-studio",
  browser: "/browser",
  setup: "/setup",
  federation: "/federation",
  storyboard: "/storyboard",
  discipline: "/discipline",
  appearance: "/appearance",
  sites: "/sites",
  workspace: "/workspace",
  docs: "/docs",
  qualifier: "/qualifier",
  users: "/users",
  access: "/access",
  profiles: "/profiles",
  mobile: "/mobile",
  mobilepage: "/mobilepage",
  "knowledge-graph": "/knowledge-graph",
  learn: "/learn",
  "daily-review": "/daily-review",
  apps: "/apps",
  email: "/email",
  emails: "/emails",
  inbox: "/inbox",
  products: "/products",
  opportunities: "/opportunities",
  decisions: "/decisions",
  risks: "/risks",
  commitments: "/commitments",
  "product-portfolio": "/product-portfolio",
  people: "/people",
  // My Network (business-agency plugin) — not the federation /network page.
  "people-network": "/people-network",
  design: "/design",
  hardware: "/hardware",
  pipeline: "/pipeline",
  campaigns: "/campaigns",
  "reply-inbox": "/reply-inbox",
  "content-pages": "/content-pages",
  "content-intel": "/content-intel",
  "prompt-templates": "/prompt-templates",
  dashboard: "/dashboard",
  oversight: "/oversight",
  reports: "/reports",
  reviews: "/reviews",
  mesh: "/mesh",
  inficode: "/inficode",
  robovoice: "/robovoice",
  omniclinic: "/omniclinic",
  "oc-research": "/omniclinic/research",
  "oc-databases": "/omniclinic/databases",
  infinitrade: "/infinitrade",
  "infinitrade-knowledge": "/infinitrade/knowledge",
  "infinitrade-calendar": "/infinitrade/calendar",
  "infinitrade-scanner": "/infinitrade/scanner",
  "infinitrade-signals": "/infinitrade/signals",
  "infinitrade-journal": "/infinitrade/journal",
  "infinitrade-accounts": "/infinitrade/accounts",
  "infinitrade-toolkit": "/infinitrade/toolkit",
  "infinitrade-indicators": "/infinitrade/indicators",
  "infinitrade-personal": "/infinitrade/personal",
  "infinitrade-research": "/infinitrade/research",
  "infinitrade-settings": "/infinitrade/settings",
  "solatrix-bubblemap": "/solatrix/bubble-map",
  "solatrix-convergence": "/solatrix/convergence",
  "solatrix-alerts": "/solatrix/alerts",
  solatrix: "/solatrix",
  "solatrix-portfolio": "/solatrix/portfolio",
  "solatrix-wallets": "/solatrix/wallets",
  "solatrix-discovery": "/solatrix/discovery",
  "solatrix-copy": "/solatrix/copy-bot",
  "solatrix-launcher": "/solatrix/launcher",
  "solatrix-map": "/solatrix/map",
  "solatrix-queue": "/solatrix/queue",
  "solatrix-settings": "/solatrix/settings",
  flypic: "/flypic",
  "droid-swarm": "/droid-swarm",
  community: "/community",
  "part-scan": "/part-scan",
  canvas: "/canvas",
  plugins: "/plugins",
  robopark: "/robopark",
  systems: "/systems",
  "image-studio": "/image-studio",
  vault: "/vault",
  ollama: "/ollama",
  focus: "/focus",
};

const PATH_TO_TAB = new Map(
  Object.entries(TAB_PATHS).map(([tab, path]) => [path, tab as Tab]),
);
// Short alias: /knowledge?project=<id> opens a project's knowledge graph.
PATH_TO_TAB.set("/knowledge", "knowledge-graph");

export function normalizeBasePath(basePath: string): string {
  if (!basePath) return "";
  let base = basePath.trim();
  if (!base.startsWith("/")) base = `/${base}`;
  if (base === "/") return "";
  if (base.endsWith("/")) base = base.slice(0, -1);
  return base;
}

export function normalizePath(path: string): string {
  if (!path) return "/";
  let normalized = path.trim();
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function pathForTab(tab: Tab, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  // Legacy non-routable ids can still arrive from old control-bus commands.
  // Send them to a real page rather than reconstructing their former blanks.
  const path = (TAB_PATHS as Partial<Record<Tab, string>>)[tab] ?? TAB_PATHS.dashboard;
  return base ? `${base}${path}` : path;
}

export function tabFromPath(pathname: string, basePath = ""): Tab | null {
  const base = normalizeBasePath(basePath);
  let path = pathname || "/";
  if (base) {
    if (path === base) {
      path = "/";
    } else if (path.startsWith(`${base}/`)) {
      path = path.slice(base.length);
    }
  }
  let normalized = normalizePath(path).toLowerCase();
  if (normalized.endsWith("/index.html")) normalized = "/";
  // The Notes tab is now the Documents workspace; /documents[/...] aliases it.
  if (normalized === "/documents" || normalized.startsWith("/documents/")) {
    normalized = `/notes${normalized.slice("/documents".length)}`;
  }
  // Root URL → dashboard (operational command center).
  if (normalized === "/") return "dashboard";
  const tab = PATH_TO_TAB.get(normalized);
  // Retired/deprecated routes (e.g. /chat, /business-hq) land on their host.
  return tab ? resolveTabRedirect(tab) : null;
}

// ---------------------------------------------------------------------------
// Slug / deep-link routing
// ---------------------------------------------------------------------------
//
// In addition to the flat `/tab` routes above, the app supports slug-scoped
// detail routes for dynamic entities, so a pasted URL / refresh restores the
// exact selected item:
//
//   /projects/:slug                        → projects tab, opens that project
//   /tasks/:slug                           → projects tab, opens that task
//   /notes/:slug                           → notes tab, opens that note
//   /clients/:slug                         → clients tab, opens that client
//   /databases/:slug                       → databases tab (generic pattern)
//   /agency-operations/projects/:slug      → agency-operations tab, project detail
//   /<anytab>/:slug                        → generic: that tab + slug
//
// `matchRoute` returns the tab plus an optional detail descriptor. The router
// stores the detail descriptor in view-state so list pages can auto-open it.

/** URL root segments that name an entity kind, independent of the tab list. */
const DETAIL_ROOTS: Record<string, { tab: Tab; kind: EntityKind }> = {
  projects: { tab: "projects", kind: "project" },
  tasks: { tab: "projects", kind: "task" },
  notes: { tab: "notes", kind: "note" },
  documents: { tab: "notes", kind: "note" },
  clients: { tab: "clients", kind: "client" },
  databases: { tab: "databases", kind: "database" },
};

let routeRootsCache: Set<string> | undefined;

/**
 * First path segment of every app route (tab paths incl. plugin tabs + entity
 * deep-link roots), lowercased — e.g. "setup", "solatrix", "tasks". Used to
 * tell app routes from server paths when applying a base path (app-base.ts);
 * scripts/cloud/legacy-redirects.mjs derives the same list for the cloud's
 * legacy /<route> → /app/<route> redirects.
 */
export function appRouteRoots(): ReadonlySet<string> {
  if (!routeRootsCache) {
    routeRootsCache = new Set(
      [...Object.values(TAB_PATHS), ...Object.keys(DETAIL_ROOTS).map((k) => `/${k}`)]
        .map((p) => p.slice(1).split("/")[0]!.toLowerCase())
        .filter(Boolean),
    );
  }
  return routeRootsCache;
}

/** Which URL root a given entity kind serializes to. */
const ROOT_FOR_KIND: Record<EntityKind, string> = {
  project: "/projects",
  task: "/tasks",
  note: "/notes",
  client: "/clients",
  database: "/databases",
  generic: "",
};

export type RouteMatch = {
  tab: Tab;
  /** Sub-view of a merged host implied by the route (e.g. /oversight → "oversight"). */
  view?: string;
  /** Present when the URL addresses a specific entity within the tab. */
  detail?: {
    kind: EntityKind;
    /** Raw slug segment from the URL (may embed the id). */
    slug: string;
  };
};

function kindForTab(tab: Tab): EntityKind {
  switch (tab) {
    case "projects":
      return "project";
    case "notes":
      return "note";
    case "clients":
      return "client";
    case "databases":
      return "database";
    default:
      return "generic";
  }
}

function safeDecodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function buildDetail(tab: Tab, trailing: string[], kindTab: Tab = tab): RouteMatch {
  const slug = safeDecodeSegment(trailing[trailing.length - 1] ?? "");
  const rootWord = trailing.length >= 2 ? trailing[0] : undefined;
  const rootKind = rootWord ? DETAIL_ROOTS[rootWord]?.kind : undefined;
  const kind = rootKind ?? kindForTab(kindTab);
  return { tab, detail: { kind, slug } };
}

/** Route match for a (possibly retired) tab: its redirect target + implied sub-view. */
function redirectedMatch(tab: Tab): RouteMatch {
  const sub = SUBVIEW_ROUTES[tab];
  return sub ? { tab: sub.host, view: sub.view } : { tab: resolveTabRedirect(tab) };
}

/**
 * Resolve a full pathname to a tab + optional entity-detail descriptor.
 * Superset of tabFromPath: exact tab paths still resolve the same way, but
 * trailing slug segments now produce a `detail` descriptor instead of 404ing
 * back to the dashboard.
 */
export function matchRoute(pathname: string, basePath = ""): RouteMatch {
  const base = normalizeBasePath(basePath);
  let path = pathname || "/";
  if (base) {
    if (path === base) path = "/";
    else if (path.startsWith(`${base}/`)) path = path.slice(base.length);
  }
  let normalized = normalizePath(path).toLowerCase();
  if (normalized.endsWith("/index.html")) normalized = "/";
  if (normalized === "/documents" || normalized.startsWith("/documents/")) {
    normalized = `/notes${normalized.slice("/documents".length)}`;
  }
  if (normalized === "/") return { tab: "dashboard" };
  const exact = PATH_TO_TAB.get(normalized);
  if (exact && TAB_REDIRECTS[exact]) return redirectedMatch(exact);

  const segs = normalized.split("/").filter(Boolean);

  // Longest tab-path prefix wins; trailing segments become the detail slug.
  for (let i = segs.length; i >= 1; i--) {
    const prefixPath = `/${segs.slice(0, i).join("/")}`;
    const prefixTab = PATH_TO_TAB.get(prefixPath);
    if (prefixTab) {
      const trailing = segs.slice(i);
      const target = redirectedMatch(prefixTab);
      if (trailing.length === 0) return target;
      return { ...buildDetail(target.tab, trailing, prefixTab), ...(target.view ? { view: target.view } : {}) };
    }
  }

  // No tab prefix, but the first segment names an entity root (e.g. /tasks/:slug).
  const root = DETAIL_ROOTS[segs[0]!];
  if (root && segs.length >= 2) {
    return {
      ...redirectedMatch(root.tab),
      detail: { kind: root.kind, slug: safeDecodeSegment(segs[segs.length - 1]!) },
    };
  }

  const fallback = tabFromPath(pathname, basePath);
  return { tab: fallback ?? "dashboard" };
}

/**
 * Build the deep-link path for an entity. Projects under the agency-operations
 * surface serialize to the nested `/agency-operations/projects/:slug` form.
 */
export function pathForEntity(opts: {
  kind: EntityKind;
  slug: string;
  tab?: Tab;
  basePath?: string;
}): string {
  const base = normalizeBasePath(opts.basePath ?? "");
  const encoded = encodeURIComponent(opts.slug);
  let rel: string;
  if (opts.kind === "project" && opts.tab === "agency-operations") {
    rel = `/agency-operations/projects/${encoded}`;
  } else {
    const rootPath = ROOT_FOR_KIND[opts.kind] || pathForTab(opts.tab ?? "dashboard");
    rel = `${rootPath}/${encoded}`;
  }
  return base ? `${base}${rel}` : rel;
}

export function inferBasePathFromPathname(pathname: string): string {
  let normalized = normalizePath(pathname);
  if (normalized.endsWith("/index.html")) {
    normalized = normalizePath(normalized.slice(0, -"/index.html".length));
  }
  if (normalized === "/") return "";
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return "";
  const prefixBefore = (i: number) => (i > 0 ? `/${segments.slice(0, i).join("/")}` : "");

  // Pass 1 — the whole remaining path is a tab path. Longest base wins, so
  // "/apps/infinibot/sessions" is the "sessions" tab under "/apps/infinibot"
  // rather than the "apps" tab at the root.
  for (let i = 0; i < segments.length; i++) {
    if (PATH_TO_TAB.has(`/${segments.slice(i).join("/")}`.toLowerCase())) return prefixBefore(i);
  }

  // Pass 2 — no exact match, so the path likely carries a trailing entity slug.
  // Find the SHORTEST base whose remainder starts with a tab path or an
  // entity-detail root, and let matchRoute split tab from slug.
  //
  // Without this, a pasted record URL ("/clients/acme--<id>") fell through to
  // the return below and was read as one long base path — so the app booted to
  // the dashboard instead of opening the record. Every deep link with a
  // trailing slug (a client, a task, a note) hit this.
  for (let i = 0; i < segments.length; i++) {
    const rest = segments.slice(i);
    if (rest.length < 2) break;
    for (let j = rest.length - 1; j >= 1; j--) {
      if (PATH_TO_TAB.has(`/${rest.slice(0, j).join("/")}`.toLowerCase())) return prefixBefore(i);
    }
    if (DETAIL_ROOTS[rest[0]!.toLowerCase()]) return prefixBefore(i);
  }

  return `/${segments.join("/")}`;
}

export function iconForTab(tab: Tab): IconName {
  switch (tab) {
    case "chat":
      return "messageSquare";
    case "grid":
      return "gridFour";
    case "voice":
      return "mic";
    case "voicecommands":
      return "zap";
    case "webchat":
      return "messageSquare";
    case "overview":
      return "barChart";
    case "channels":
      return "link";
    case "instances":
      return "radio";
    case "sessions":
      return "users";
    case "cron":
      return "loader";
    case "schedule":
      return "clock";
    case "projects":
      return "layout";
    case "agents":
      return "brain";
    case "activity":
      return "pulse";
    case "mesh":
      return "network";
    case "subagents":
      return "bot";
    case "autonomy":
      return "shield";
    case "memory":
      return "brain";
    case "workflows":
      return "fileText";
    case "launch-panel":
      return "target";
    case "skills":
      return "zap";
    case "nodes":
      return "monitor";
    case "config":
      return "settings";
    case "apikeys":
      return "key";
    case "components":
      return "download";
    case "coders":
      return "terminal";
    case "kinglyvault":
      return "link";
    case "debug":
      return "bug";
    case "logs":
      return "scrollText";
    case "mcp":
      return "zap";
    case "notes":
      return "fileText";
    case "issues":
      return "bug";
    case "research":
      return "book";
    case "terminals":
      return "monitor";
    case "business-hq":
      return "layout";
    case "command-ceo":
      return "target";
    case "command-ops":
      return "activity";
    case "android-ops":
      return "smartphone";
    case "business":
      return "briefcase";
    case "agency-operations":
      return "briefcase";
    case "agency-topology":
      return "link";
    case "agency-daily":
      return "pulse";
    case "clients":
      return "users";
    case "comms":
      return "mail";
    case "leads":
      return "search";
    case "qualifier":
      return "filter";
    case "funnels":
      return "filter";
    case "databases":
      return "layout";
    case "repos":
      return "rocket";
    case "messages":
      return "messageSquare";
    case "budget":
      return "dollarSign";
    case "credits":
      return "dollarSign";
    case "vcs":
      return "fileCode";
    case "files":
      return "folder";
    case "directories":
      return "link";
    case "whiteboard":
      return "penTool";
    case "monsoon-studio":
      return "book";
    case "browser":
      return "globe";
    case "setup":
      return "settings";
    case "federation":
      return "radio";
    case "plugins":
      return "plug";
    case "storyboard":
      return "video";
    case "community":
      return "community";
    case "discipline":
      return "target";
    case "appearance":
      return "palette";
    case "sites":
      return "globe";
    case "workspace":
      return "fileCode";
    case "docs":
      return "book";
    case "users":
      return "users";
    case "profiles":
      return "users";
    case "access":
      return "shieldCheck";
    case "mobile":
      return "smartphone";
    case "mobilepage":
      return "smartphone";
    case "knowledge-graph":
      return "link";
    case "learn":
      return "book";
    case "daily-review":
      return "chart";
    case "apps":
      return "layout";
    case "inbox":
      return "mail";
    case "email":
      return "mail";
    case "emails":
      return "mail";
    case "products":
      return "briefcase";
    case "design":
      return "palette";
    case "hardware":
      return "monitor";
    case "pipeline":
      return "filter";
    case "campaigns":
      return "zap";
    case "hub":
      return "briefcase";
    case "reply-inbox":
      return "mail";
    case "content-pages":
      return "fileText";
    case "content-intel":
      return "barChart";
    case "prompt-templates":
      return "fileText";
    case "dashboard":
      return "house";
    case "oversight":
      return "eye";
    case "reports":
      return "fileText";
    case "reviews":
      return "eye";
    case "inficode":
      return "terminal";
    case "robovoice":
      return "mic";
    case "omniclinic":
      return "pulse";
    case "oc-research":
      return "search";
    case "oc-databases":
      return "database";
    case "infinitrade":
      return "chart";
    case "infinitrade-knowledge":
      return "brain";
    case "infinitrade-calendar":
      return "calendar";
    case "infinitrade-scanner":
      return "radio";
    case "infinitrade-signals":
      return "zap";
    case "infinitrade-journal":
      return "book";
    case "infinitrade-accounts":
      return "briefcase";
    case "infinitrade-toolkit":
      return "sliders";
    case "infinitrade-indicators":
      return "layers";
    case "infinitrade-personal":
      return "target";
    case "infinitrade-research":
      return "search";
    case "infinitrade-settings":
      return "shield";
    case "solatrix-bubblemap":
      return "network";
    case "solatrix-convergence":
      return "target";
    case "solatrix-alerts":
      return "alert";
    case "solatrix":
      return "chart";
    case "solatrix-portfolio":
      return "briefcase";
    case "solatrix-wallets":
      return "key";
    case "solatrix-discovery":
      return "search";
    case "solatrix-copy":
      return "bot";
    case "solatrix-launcher":
      return "rocket";
    case "solatrix-map":
      return "network";
    case "solatrix-queue":
      return "rows";
    case "solatrix-settings":
      return "settings";
    case "flypic":
      return "palette";
    case "droid-swarm":
      return "smartphone";
    case "part-scan":
      return "camera";
    case "robopark":
      return "server";
    case "canvas":
      return "layout";
    case "systems":
      return "target";
    case "image-studio":
      return "palette";
    case "vault":
      return "shield";
    case "ollama":
      return "brain";
    case "focus":
      return "target";
    case "opportunities":
      return "zap";
    case "decisions":
      return "check";
    case "risks":
      return "alert";
    case "commitments":
      return "dollarSign";
    case "product-portfolio":
      return "briefcase";
    case "people":
      return "users";
    case "people-network":
      return "network";
    default:
      return "folder";
  }
}

/** Translate the default nav-group label (TAB_GROUPS[i].label). */
export function groupLabel(label: string): string {
  return t(`nav.group.${label.toLowerCase()}`, undefined, label);
}

export function titleForTab(tab: Tab): string {
  return t(`tab.title.${tab}`, undefined, titleForTabEn(tab));
}

function titleForTabEn(tab: Tab) {
  switch (tab) {
    case "overview":
      return "Overview";
    case "channels":
      return "Channels";
    case "instances":
      return "Instances";
    case "sessions":
      return "Sessions";
    case "cron":
      return "Cron Jobs";
    case "schedule":
      return "Schedule";
    case "projects":
      return "Projects";
    case "agents":
      return "Agents";
    case "activity":
      return "Activity";
    case "mesh":
      return "Agent Mesh";
    case "subagents":
      return "Sub-Agents";
    case "autonomy":
      return "Autonomy";
    case "memory":
      return "Memory";
    case "workflows":
      return "Workflows";
    case "launch-panel":
      return "Launch Panel";
    case "skills":
      return "Skills";
    case "nodes":
      return "Nodes";
    case "chat":
      return "Chat";
    case "grid":
      return "Grid";
    case "voice":
      return "Voice";
    case "voicecommands":
      return "Voice Commands";
    case "webchat":
      return "Chat";
    case "config":
      return "Config";
    case "apikeys":
      return "API Keys";
    case "components":
      return "Components";
    case "coders":
      return "Coders";
    case "kinglyvault":
      return "Connect KinglyVault";
    case "debug":
      return "Debug";
    case "logs":
      return "Logs";
    case "mcp":
      return "MCP";
    case "notes":
      return "Documents";
    case "issues":
      return "Issues";
    case "research":
      return "Research";
    case "terminals":
      return "Terminals";
    case "business-hq":
      return "Business HQ";
    case "command-ceo":
      return "Executive Command";
    case "command-ops":
      return "Operations Command";
    case "android-ops":
      return "Droid Swarm";
    case "business":
      return "Business";
    case "agency-operations":
      return "Agency Operations";
    case "agency-topology":
      return "Agency Topology";
    case "agency-daily":
      return "Daily Operations";
    case "clients":
      return "Clients";
    case "comms":
      return "Comms Hub";
    case "leads":
      return "Lead Dashboard";
    case "qualifier":
      return "Lead Dashboard";
    case "funnels":
      return "Funnels";
    case "databases":
      return "Databases";
    case "repos":
      return "Repos & deploy";
    case "messages":
      return "Messages";
    case "budget":
      return "Budget";
    case "credits":
      return "Tokens";
    case "vcs":
      return "Version Control";
    case "files":
      return "Files";
    case "directories":
      return "Directories";
    case "whiteboard":
      return "Whiteboard";
    case "monsoon-studio":
      return "Product Studio";
    case "browser":
      return "Browser";
    case "setup":
      return "Setup";
    case "federation":
      return "Federation";
    case "plugins":
      return "Plugins";
    case "storyboard":
      return "Storyboard Studio";
    case "community":
      return "Community";
    case "discipline":
      return "Discipline";
    case "appearance":
      return "Appearance";
    case "sites":
      return "Sites";
    case "workspace":
      return "Workspace";
    case "docs":
      return "Docs";
    case "users":
      return "Users";
    case "profiles":
      return "Profiles";
    case "access":
      return "Team & Access";
    case "mobile":
      return "Mobile";
    case "mobilepage":
      return "Mobile Page";
    case "knowledge-graph":
      return "Knowledge Graph";
    case "learn":
      return "Learn";
    case "daily-review":
      return "Daily Review";
    case "apps":
      return "Apps & Sites";
    case "inbox":
      return "Inbox";
    case "email":
      return "Gmail";
    case "emails":
      return "Emails";
    case "products":
      return "Products";
    case "design":
      return "Design";
    case "hardware":
      return "Hardware";
    case "pipeline":
      return "Lead Dashboard";
    case "campaigns":
      return "Campaigns";
    case "hub":
      return "Business Hub";
    case "reply-inbox":
      return "Reply Inbox";
    case "content-pages":
      return "Content Pages";
    case "content-intel":
      return "Content Intelligence";
    case "prompt-templates":
      return "Prompt Templates";
    case "dashboard":
      return "Dashboard";
    case "oversight":
      return "Oversight";
    case "reports":
      return "Reports";
    case "reviews":
      return "Reviews";
    case "inficode":
      return "InfiniCode";
    case "robovoice":
      return "Robovoice";
    case "omniclinic":
      return "Clinic";
    case "oc-research":
      return "Clinic research";
    case "oc-databases":
      return "Clinic databases";
    case "infinitrade":
      return "Infinitrade";
    case "infinitrade-knowledge":
      return "Market Knowledge Hub";
    case "infinitrade-calendar":
      return "Economic Calendar";
    case "infinitrade-scanner":
      return "Market Scanner";
    case "infinitrade-signals":
      return "Signals";
    case "infinitrade-journal":
      return "Trading Journal";
    case "infinitrade-accounts":
      return "Accounts";
    case "infinitrade-toolkit":
      return "Trading Toolkit";
    case "infinitrade-indicators":
      return "Indicator Studio";
    case "infinitrade-personal":
      return "Personal OS";
    case "infinitrade-research":
      return "Research";
    case "infinitrade-settings":
      return "Connection & Safety";
    case "solatrix-bubblemap":
      return "Solatrix Bubble Map";
    case "solatrix-convergence":
      return "Solatrix Convergence";
    case "solatrix-alerts":
      return "Solatrix Alerts";
    case "solatrix":
      return "Solatrix Terminal";
    case "solatrix-portfolio":
      return "Solatrix Portfolio";
    case "solatrix-wallets":
      return "Solatrix Wallets";
    case "solatrix-discovery":
      return "Solatrix Discovery";
    case "solatrix-copy":
      return "Solatrix Copy Bot";
    case "solatrix-launcher":
      return "Solatrix Launcher";
    case "solatrix-map":
      return "Solatrix Map";
    case "solatrix-queue":
      return "Solatrix Queue";
    case "solatrix-settings":
      return "Solatrix Settings";
    case "flypic":
      return "FlyPic Studio";
    case "droid-swarm":
      return "Droid Swarm";
    case "part-scan":
      return "Part Scan";
    case "robopark":
      return "Robopark";
    case "canvas":
      return "HoloCanvas";
    case "systems":
      return "Systems Intelligence";
    case "image-studio":
      return "Image Studio";
    case "vault":
      return "Vault";
    case "ollama":
      return "Ollama";
    case "focus":
      return "Focus Board";
    case "opportunities":
      return "Opportunities";
    case "decisions":
      return "Decisions";
    case "risks":
      return "Risks";
    case "commitments":
      return "Commitments";
    case "product-portfolio":
      return "Product Portfolio";
    case "people":
      return "People";
    case "people-network":
      return "My Network";
    default:
      return "Control";
  }
}

export function subtitleForTab(tab: Tab): string {
  return t(`tab.subtitle.${tab}`, undefined, subtitleForTabEn(tab));
}

function subtitleForTabEn(tab: Tab) {
  switch (tab) {
    case "overview":
      return "Gateway status, entry points, and a fast health read.";
    case "daily-review":
      return "What got done today, where the work went, and how the day compares.";
    case "channels":
      return "Manage channels and settings.";
    case "instances":
      return "Presence beacons from connected clients and nodes.";
    case "sessions":
      return "Monitor active agents, concurrent tasks, and real-time workload.";
    case "cron":
      return "Schedule wakeups and recurring agent runs.";
    case "schedule":
      return "Google Calendar integration — view meetings, events, and manage your schedule with MCP tools.";
    case "projects":
      return "Projects & databases — Kanban board + generic Notion-style databases with system-role registry.";
    case "agents":
      return "Create and manage AI agents and sub-agents.";
    case "activity":
      return "Real-time monitoring of all running agents, sub-agents, and their chain-of-thought.";
    case "mesh":
      return "Live isometric map of every agent, sub-agent and session moving across the mesh.";
    case "subagents":
      return "Comprehensive sub-agent monitoring — real-time status, transcripts, interaction, and control.";
    case "autonomy":
      return "Trust infrastructure — audit logging, task queue, pause control, API monitoring, and cage interference detection.";
    case "memory":
      return "Deep memory architecture — identity, beliefs, values, relationships, and semantic memory search.";
    case "workflows":
      return "Create and manage reusable markdown instruction workflows.";
    case "launch-panel":
      return "Customer-avatar agents test real website flows and produce screenshot-backed launch decisions.";
    case "skills":
      return "Manage skill availability and API key injection.";
    case "nodes":
      return "Paired devices, capabilities, and command exposure.";
    case "chat":
      return "Direct gateway chat session for quick interventions.";
    case "grid":
      return "Draggable, resizable multi-session masonry chat grid for parallel conversations.";
    case "voice":
      return "Talk to your agents or straight to a CLI agent. Voice runs locally by default; cloud voice (Robovoice) is optional.";
    case "voicecommands":
      return "Manage wake-words, voice triggers, and workflow voice bindings.";
    case "webchat":
      return "Full-page chat with persistent, searchable sessions for any agent.";
    case "config":
      return "Edit ~/.infinibot/infinibot.json safely.";
    case "apikeys":
      return "Manage API keys for AI providers, services, and integrations.";
    case "components":
      return "Install or remove optional packs (voice, local LLM, video, browser, image) — downloaded on demand.";
    case "coders":
      return "Install, sign in and configure CLI coding agents (Claude Code, Codex, OpenCode, Gemini, Grok Build…).";
    case "kinglyvault":
      return "Link this InfiniBot to your KinglyVault account with a one-time code, approve it, or disconnect.";
    case "debug":
      return "Gateway snapshots, events, and manual RPC calls.";
    case "logs":
      return "Live tail of the gateway file logs.";
    case "mcp":
      return "MCP server status, agent tool config, and server management.";
    case "notes":
      return "Folders, rich markdown docs, uploaded files and Notion imports — all readable by your agents.";
    case "issues":
      return "System Issues / Improvement Log — capture bugs, broken functions, automation failures, workflow friction, and improvement opportunities.";
    case "research":
      return "Automated news & finance intelligence — topics, watchlists, sentiment analysis, and Notion sync.";
    case "terminals":
      return "Multi-terminal session management with CLI agent integration.";
    case "business-hq":
      return "AI Business HQ — one control layer showing active work, clients, opportunities, projects, products and what needs the CEO today.";
    case "command-ceo":
      return "Executive Command Center — exceptions, priorities and decisions only: Today / This Week / Business Health, plus the CEO Queue in structured request format.";
    case "command-ops":
      return "Operations Command Center — full-visibility operating view: Needs Attention, Portfolio, Workload and System Quality.";
    case "android-ops":
      return "Droid Swarm — four-phone rack operations: live device health, account assignment, scheduled jobs, human checkpoints, compliance-safe control.";
    case "business":
      return "Business profile setup and Notion database integration.";
    case "agency-operations":
      return "Run owned and shared agencies: pipeline, delivery, approvals, employees, AI workforce and finance.";
    case "agency-topology":
      return "Visual org + delivery map — clients, projects and the workforce reporting lines in one graph.";
    case "agency-daily":
      return "Today's operating picture — work queue, reviews, approvals and what the AI workforce is doing.";
    case "clients":
      return "Client management CRM with Notion sync — grid, table, and kanban views.";
    case "people-network":
      return "My Network — the people you know (clients included), how they connect, what each relationship is worth and the open opportunities riding on them.";
    case "comms":
      return "Cross-channel client inbox — threads from every connected channel, replies, and draft approvals.";
    case "leads":
      return "Unified Lead Dashboard — Generation · Qualifier · Pipeline · Timeline in one page.";
    case "qualifier":
      return "Unified Lead Dashboard — Qualifier section: webhook criteria, action stack, routing.";
    case "funnels":
      return "Visual funnel builder — map customer journeys, track KPIs, and automate sales flows.";
    case "databases":
      return "Connect any Notion database — auto-detect schema, manage pages with grid, table, and kanban views.";
    case "repos":
      return "Where each repo deploys from, which branches and worktrees are merged and safe to delete, and one-click safe cleanup with restore.";
    case "messages":
      return "Inter-agent communication hub — view and send messages across sessions.";
    case "budget":
      return "API usage budget tracking, smart delegation routing, and provider subscription management.";
    case "credits":
      return "Tokens & subscriptions — real token usage per agent, your provider plans + quota, and approx USD spend (BYOK).";
    case "vcs":
      return "Task worktree management — review, approve, and revert changes across workspaces.";
    case "files":
      return "Browse, upload, and manage files in the InfiniBot workspace with tree view and preview.";
    case "directories":
      return "Map local directories to projects, Notion databases, and agents for automatic context injection.";
    case "whiteboard":
      return "Excalidraw-powered whiteboard for visual thinking, diagrams, and collaborative sketching.";
    case "monsoon-studio":
      return "Design ebooks, guides, reports and microsites with agents, then render verified PDF and HTML.";
    case "browser":
      return "Embedded Chromium browser with persistent cookies and session context for web automation.";
    case "setup":
      return "MCP integration, Docker deployment, setup wizard, and instance configuration management.";
    case "federation":
      return "Multi-node network configuration — connect satellites, manage nodes, and route compute.";
    case "storyboard":
      return "Automated storyboard generation — script writing, scene splitting, and AI image generation for video production.";
    case "community":
      return "Discord community manager — verification, lead routing, moderation with approvals, tickets and Pulse compliance.";
    case "discipline":
      return "Time-militant accountability — block the day, log the drift, score the streak.";
    case "access":
      return "Workspace users, signup invites and the visibility matrix — decide who sees which projects, documents, chats and reports.";
    case "profiles":
      return "Password-free user profiles — separate data & agent memory per person, shared services. Add, rename, re-theme, switch, or delete profiles.";
    case "appearance":
      return "Theme, colors, glass-HUD intensity, app name, logo.";
    case "sites":
      return "Drag-and-drop landing pages — block builder, AI code control, Netlify hosting, per-business CRM capture and KPIs.";
    case "workspace":
      return "Per-project IDE — file tree, code/diff/preview, Claude Coder chat — Bolt-style with HUD glassmorphism.";
    case "docs":
      return "Detailed reference for every feature, command, channel, and integration.";
    case "inbox":
      return "Unified inbox — account-segmented All Mail, AI-triaged lead Replies, and Insights with Telegram alert rules.";
    case "email":
      return "Connected Gmail accounts — inbox, AI summarization, multi-account switcher, and Telegram alert rules for important mail.";
    case "emails":
      return "Connected Gmail accounts — inbox, AI summarization, multi-account switcher, and Telegram alert rules for important mail.";
    case "products":
      return "Catalog of digital + physical products with inventory, pricing, variants, and Notion sync.";
    case "product-portfolio":
      return "Product portfolio — validation stage, ownership and commercial readiness of every product, platform and service.";
    case "design":
      return "AI-driven design generation — skills + design systems + Claude Coder, with live iframe preview and per-project artifacts.";
    case "hardware":
      return "Real-time hardware analysis HUD — live CPU, GPU, RAM, disk, and network metrics with insights.";
    case "pipeline":
      return "Unified Lead Dashboard — Pipeline section: kanban grouped by stage or temperature.";
    case "campaigns":
      return "Outreach campaigns — funnel KPIs, template management, A/B variants, and conversion tracking.";
    case "hub":
      return "Business Hub — leads, pipeline, contacts, clients, email campaigns, landing-page tracking, imports and revenue (Whop + Stripe) in one connected model.";
    case "reply-inbox":
      return "Reply triage — AI-classified replies sorted by urgency with suggested actions and one-click mark handled.";
    case "content-pages":
      return "Per-business content surfaces — Scripts, Videos, Content, Ideas, deep analytics, and connections to campaigns, products, funnels.";
    case "content-intel":
      return "Reel intelligence — transcription status, AI scores/tiers, views/saves/reach, and full transcripts across your reel corpus.";
    case "prompt-templates":
      return "Reusable instruction blueprints — author once, point any agent at a template to apply a consistent style or workflow.";
    case "dashboard":
      // Business HQ belongs to the business-agency plugin; without it the
      // dashboard is the generic OS home (views/core-home.ts).
      return isTabAvailable("business-hq")
        ? "Business HQ — CEO focus for today plus live clients, pipeline, projects, products, governance (risks, decisions, commitments) and people."
        : "Home — your AI OS at a glance: chat, voice, projects, notes, schedule, inbox, research and agents.";
    case "oversight":
      return "Post-task review — quality scores, blockers, next steps, and build status for every completed agent run.";
    case "reports":
      return "Stylized PDF reporting — scheduled, triggered, and on-demand. List, preview, download, resend, with schedules & triggers.";
    case "reviews":
      return "In-depth review of every agent run — summary, files touched, issues, built / not-built, and one-click follow-ups.";
    case "canvas":
      return "HoloCanvas library (plugin) — browse, replay, narrate and share canvas walkthroughs; build one from a report.";
    case "inficode":
      return "Terminal mesh command center · live control";
    case "robovoice":
      return "Cloud voice (Robovoice) · optional and free — connection, character mapping and pipelines";
    case "omniclinic":
      return "OmniClinic — research feed, research engine and clinic databases. Not clinical decision support.";
    case "oc-research":
      return "Medical research intelligence feed and cited research engine.";
    case "oc-databases":
      return "The clinic's own tables, properties and roles.";
    case "infinitrade":
      return "Trading desk — TradeLocker positions, charts, scanner and market intel. Analysis, not financial advice.";
    case "infinitrade-knowledge":
      return "Live market intelligence, sentiment and the research knowledge graph. Analysis, not financial advice.";
    case "infinitrade-calendar":
      return "High-impact events, forecasts and market holidays. Analysis, not financial advice.";
    case "infinitrade-scanner":
      return "Multi-strategy confluence scanner, radar and Pine export. Analysis, not financial advice.";
    case "infinitrade-signals":
      return "Your strategy alerts and Telegram signal ingestion. Analysis, not financial advice.";
    case "infinitrade-journal":
      return "P&L calendar, streaks, AI insights and per-trade review. Analysis, not financial advice.";
    case "infinitrade-accounts":
      return "Every TradeLocker account, status and archive highlights. Analysis, not financial advice.";
    case "infinitrade-toolkit":
      return "Position sizing, risk and trade planning tools. Analysis, not financial advice.";
    case "infinitrade-indicators":
      return "Build, backtest and export strategies (Aurum engine, Pine). Analysis, not financial advice.";
    case "infinitrade-personal":
      return "Daily trading command center: watchlist, risk, catalysts, planner. Analysis, not financial advice.";
    case "infinitrade-research":
      return "Deep market research runs, library and schedules. Analysis, not financial advice.";
    case "infinitrade-settings":
      return "Broker connection, order permission and limits, OmniTrade import. Analysis, not financial advice.";
    case "solatrix-bubblemap":
      return "Holder bubble map: linked wallet clusters, bundles and snipers, and an AI risk read. Not financial advice.";
    case "solatrix-convergence":
      return "Tokens several of your tracked wallets are buying, ranked by convergence score. Not financial advice.";
    case "solatrix-alerts":
      return "Copy-trading alerts per wallet: triggers, channels, quiet hours, digests, mutes and filters.";
    case "solatrix":
      return "Solana terminal — real-time charts, token intelligence and guarded DEX execution. Not financial advice.";
    case "solatrix-portfolio":
      return "Solana holdings, P&L, allocation, TP/SL rules and verified trade history.";
    case "solatrix-wallets":
      return "Encrypted Solana wallet vault, groups, balances and guarded transfers.";
    case "solatrix-discovery":
      return "Token search, trenches feed, strategy scoring and wallet intelligence.";
    case "solatrix-copy":
      return "Default-off copy engine with mirror, scaled and filtered strategies plus hard limits.";
    case "solatrix-launcher":
      return "Default-off token and bundle launch coordinator with simulation and human confirmation.";
    case "solatrix-map":
      return "Interactive token/wallet relationship map with top traders and transaction flow.";
    case "solatrix-queue":
      return "Persistent operation queue, execution progress and verification evidence.";
    case "solatrix-settings":
      return "Solana network, slippage, fee, notification, permission and import settings.";
    case "flypic":
      return "Image and video generation with FlyPic, plus the plugin's recent-generation gallery.";
    case "droid-swarm":
      return "Phone rack operations — devices, accounts, workflows, egress routes and the live fleet globe.";
    case "part-scan":
      return "Camera photogrammetry to a metric, color-textured 3D model with dimension inspection and GLB/STL export.";
    case "robopark":
      return "Robopark fleet — live map, Tailscale hub link, and per-node Up / Restart / Stop control.";
    case "plugins":
      return "Browse, buy and manage plugins: apps, channels and integrations, with what each one adds.";
    case "systems":
      return "Values, goals, priorities and reviews as one linked graph — with auto-linking and generated insights.";
    case "image-studio":
      return "Crop, upscale and background-removal batch pipeline, routed to any federation node with an image worker.";
    case "vault":
      return "Community vault HUD — Discord members, tiers, courses, moderation log and automation rules.";
    case "ollama":
      return "Local Ollama command center — server status, GPU/VRAM gauges, and per-model load / unload.";
    case "focus":
      return "Full-screen priority board — drag your top 5 out of the kanban source and work them in order.";
    default:
      return "";
  }
}

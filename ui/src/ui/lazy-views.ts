import { html, type TemplateResult, nothing } from "lit";
import type { AppViewState } from "./app-view-state";
import type { GatewayBrowserClient } from "./gateway";

const PLACEHOLDER = (label: string) =>
  html`<div
    class="lazy-loading"
    style="min-height:60vh;display:flex;align-items:center;justify-content:center;padding:2rem;opacity:0.55;"
  >
    Loading ${label}…
  </div>`;

/*
 * Generic route-chunk factory.
 *
 * app-render.ts used to statically import ~150 view modules, so every route
 * downloaded and parsed the entire application in one 7 MB entry chunk. Each
 * view wrapped here becomes its own Rollup chunk that is fetched the first
 * time its tab is opened, and cached for the rest of the session.
 *
 * The placeholder reserves 60vh so the swap from "Loading…" to the real view
 * does not shift the surrounding layout (CLS).
 */
type LazyRender<M> = (render: (mod: M) => unknown, requestUpdate?: () => void) => unknown;

function createLazyView<M>(loader: () => Promise<M>, label: string): LazyRender<M> {
  let mod: M | null = null;
  let promise: Promise<M> | null = null;
  return (render, requestUpdate) => {
    if (mod) return render(mod);
    if (!promise) {
      promise = loader().then((m) => {
        mod = m;
        requestUpdate?.();
        return m;
      });
    }
    return PLACEHOLDER(label);
  };
}

/*
 * Side-effect-only modules (custom-element registrations). The tag is already
 * in the template; an undefined custom element renders as an empty inline box
 * and upgrades itself the moment the definition lands, so no placeholder or
 * re-render is needed — we only have to kick the import off once.
 */
const sideEffectsLoaded = new Set<string>();
function loadOnce(key: string, loader: () => Promise<unknown>): void {
  if (sideEffectsLoaded.has(key)) return;
  sideEffectsLoaded.add(key);
  void loader().catch((err) => {
    sideEffectsLoaded.delete(key);
    console.error(`[lazy-views] failed to load ${key}`, err);
  });
}

// ── Tab views (one chunk each) ────────────────────────────────────────────────

export const lazyBusiness = createLazyView(() => import("./views/business"), "business");
export const lazySaasOnboarding = createLazyView(
  () => import("./views/saas-onboarding"),
  "workspace setup",
);
export const lazyBusinessHq = createLazyView(() => import("./views/business-hq"), "business HQ");
export const lazyCommandCeo = createLazyView(() => import("./views/command-ceo"), "executive command center");
export const lazyCommandOps = createLazyView(() => import("./views/command-ops"), "operations command center");
export const lazyAndroidOps = createLazyView(() => import("./views/android-ops"), "Droid Swarm");
export const lazyClients = createLazyView(() => import("./views/clients"), "clients");
export const lazyCommsHub = createLazyView(() => import("./views/comms-hub"), "comms hub");
export const lazyKanban = createLazyView(() => import("./views/kanban"), "projects");
export const lazyAgentsManagement = createLazyView(
  () => import("./views/agents-management"),
  "agents",
);
export const lazyMcp = createLazyView(() => import("./views/mcp"), "MCP");
// Products pages live in the first-party manifest-v2 plugin and are compiled
// as lazy builtin chunks. plugin-host.ts gates both tabs while it is off.
export const lazyProducts = createLazyView(
  () => import("../../../extensions/products/ui/catalog"),
  "products catalog",
);
export const lazyTerminals = createLazyView(() => import("./views/terminals"), "terminals");
export const lazySchedule = createLazyView(() => import("./views/schedule"), "schedule");
export const lazyDatabases = createLazyView(() => import("./views/databases"), "databases");
export const lazyRepos = createLazyView(() => import("./views/repos"), "repos");
export const lazyNotionDatabases = createLazyView(
  () => import("./views/notion-databases"),
  "Notion databases",
);
export const lazyDesign = createLazyView(() => import("./views/design"), "design");
// Research workspace: runs, library, linking, ask-your-knowledge.
export const lazyResearch = createLazyView(() => import("./views/research/index"), "research");
export const lazyWorkspace = createLazyView(() => import("./views/workspace"), "workspace");
export const lazyFunnels = createLazyView(() => import("./views/funnels"), "funnels");
// Business Hub (business-agency plugin): leads, pipeline, contacts, clients,
// campaigns, landing-page tracking, imports and revenue.
export const lazyBusinessHub = createLazyView(() => import("./views/business-hub/index"), "Business Hub");
export const loadWhiteboardPlugin = () => loadOnce("whiteboard", () => import("../../../extensions/mcp-excalidraw/ui/index"));
export const loadMonsoonStudioPlugin = () => loadOnce("monsoon-studio", () => import("../../../extensions/monsoon-studio/ui/index"));
/*
 * Kanban deep-link bridge without eagerly loading the (444 KB) kanban view.
 * We listen for the same event with a stub; the first time one actually fires
 * we pull the real module in, hand it the host callback, and replay the event
 * so no deep-link is dropped.
 */
let kanbanDeepLinkMounted = false;
export function mountLazyKanbanDeepLink(
  host: (projectId?: string, taskId?: string) => void,
): void {
  if (kanbanDeepLinkMounted) return;
  kanbanDeepLinkMounted = true;
  const forward = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    void import("./views/kanban").then((m) => {
      window.removeEventListener("infinibot:kanban-open-task", forward);
      m.mountKanbanDeepLinkListener(host);
      window.dispatchEvent(new CustomEvent("infinibot:kanban-open-task", { detail }));
    });
  };
  window.addEventListener("infinibot:kanban-open-task", forward);
}
export const lazyAgencyOperations = createLazyView(
  () => import("./views/agency-operations"),
  "agency operations",
);
export const lazyAgencyTopology = createLazyView(
  () => import("./views/agency-topology"),
  "agency topology",
);
export const lazyAgencyDaily = createLazyView(() => import("./views/agency-daily"), "agency daily");
export const lazyLeadDashboard = createLazyView(() => import("./views/lead-dashboard"), "leads");
export const lazyInbox = createLazyView(() => import("./views/inbox"), "inbox");
export const lazyKnowledgeGraph = createLazyView(
  () => import("./views/knowledge-graph"),
  "knowledge graph",
);
export const lazyOversight = createLazyView(() => import("./views/oversight/index"), "oversight");
export const lazyReports = createLazyView(() => import("./views/reports/index"), "reports");
export const lazyReviews = createLazyView(() => import("./views/reviews/index"), "reviews");
// HoloCanvas library page lives in its plugin (extensions/canvas-library/ui).
export const lazyCanvasLibrary = createLazyView(
  () => import("../../../extensions/canvas-library/ui/index"),
  "HoloCanvas",
);
export const lazyMemory = createLazyView(() => import("./views/memory"), "memory");
export const lazyNotes = createLazyView(() => import("./views/notes"), "notes");
export const lazyIssues = createLazyView(() => import("./views/issues"), "issues");
// KIS Phase 1 — 10 Core Business Objects
export const lazyOpportunities = createLazyView(() => import("./views/opportunity"), "opportunities");
export const lazyDecisions = createLazyView(() => import("./views/decision"), "decisions");
export const lazyRisks = createLazyView(() => import("./views/risk"), "risks");
export const lazyCommitments = createLazyView(() => import("./views/commitment"), "commitments");
export const lazyPeople = createLazyView(() => import("./views/person"), "people");
export const lazyPeopleNetwork = createLazyView(() => import("./views/people-network"), "my network");
export const lazyProductPortfolio = createLazyView(
  () => import("../../../extensions/products/ui/portfolio"),
  "product portfolio",
);
export const lazyWorkflows = createLazyView(() => import("./views/workflows"), "workflows");
export const lazyLaunchPanel = createLazyView(() => import("./views/launch-panel"), "launch panel");
export const lazyPromptTemplates = createLazyView(
  () => import("./views/prompt-templates"),
  "prompt templates",
);
export const lazySites = createLazyView(() => import("./views/sites"), "sites");
export const lazyLearn = createLazyView(() => import("./views/learn"), "learn");
export const lazyDailyReview = createLazyView(() => import("./views/daily-review/index"), "daily review");
export const lazyApps = createLazyView(() => import("./views/apps"), "apps");
export const lazyUsers = createLazyView(() => import("./views/users"), "users");
export const lazyAccessAdmin = createLazyView(() => import("./views/access-admin"), "team & access");
export const lazyProfilesManager = createLazyView(
  () => import("./views/profiles-manager"),
  "profiles",
);
export const lazyFiles = createLazyView(() => import("./views/files"), "files");
export const lazyDirectories = createLazyView(() => import("./views/directories"), "directories");
export const lazySetupView = createLazyView(() => import("./views/setup"), "setup");
export const lazyVaultDashboard = createLazyView(() => import("./views/vault-dashboard"), "vault");
export const lazyFocus = createLazyView(() => import("./views/focus"), "focus");

// ── Custom-element registrations (side-effect imports) ───────────────────────

export const loadHardwareAnalysis = () =>
  loadOnce("hardware-analysis", () => import("./views/hardware-analysis"));
/** Content Studio shell (pipeline board, Ideas) — it pulls in the content-pages hub. */
export const loadContentPages = () =>
  loadOnce("content-pages", () => import("./views/content-studio/shell"));
/** Community Manager dashboard + setup wizard (community-manager plugin). */
export const loadCommunity = () => loadOnce("community", () => import("./views/community/shell"));
export const loadWebchat = () => loadOnce("webchat", () => import("./views/webchat"));
export const loadContentIntel = () =>
  loadOnce("content-intel", () => import("./views/content-intel"));
export const loadMemoryAgents = () =>
  loadOnce("memory-agents", () => import("./views/memory-agents"));
export const loadInficode = () => loadOnce("inficode", () => import("./views/inficode"));
export const loadRobovoice = () => loadOnce("robovoice", () => import("./views/robovoice"));
// The Voice page: Robovoice console (connect state / linked console).
export const loadVoiceConsole = () =>
  loadOnce("voice-console", () => import("./views/voice-robovoice/voice-console"));
// OmniClinic pages live in the plugin (extensions/omniclinic/ui) and are
// compiled into this bundle as their own lazy chunk (manifest builtin pages).
export const loadOmniclinic = () =>
  loadOnce("omniclinic", () => import("../../../extensions/omniclinic/ui/index"));
export const loadPluginEntryPage = () =>
  loadOnce("plugin-entry-page", () => import("./views/plugin-entry-page"));
// Infinitrade pages live in the plugin (extensions/infinitrade/ui), compiled
// into this bundle as their own lazy chunks (manifest builtin page).
export const loadInfinitrade = () =>
  loadOnce("infinitrade", () => import("../../../extensions/infinitrade/ui/index"));
// Solatrix Intelligence (bubble map, convergence, alerts) — its own element and chunk.
export const loadSolatrixIntel = () =>
  loadOnce("solatrix-intel", () => import("../../../extensions/solatrix/ui/intel/index"));
// Solatrix's nine routed pages share one plugin-owned custom element and
// switch their surface from the host-provided `page` property.
export const loadSolatrix = () =>
  loadOnce("solatrix", () => import("../../../extensions/solatrix/ui/index"));
export const loadPartScan = () =>
  loadOnce("part-scan", () => import("../../../extensions/part-scan/ui/index"));
export const loadPluginsView = () => loadOnce("plugins", () => import("./views/plugins"));
export const loadAgentMesh = () => loadOnce("mesh", () => import("./views/agent-mesh-page"));
export const loadOllamaMonitor = () =>
  loadOnce("ollama-monitor", () => import("./views/ollama-monitor"));


// ── Agent Activity (/activity) ────────────────────────────────────────────────
// Deferring this keeps activity-specific component registrations out of the
// initial parse for routes that never visit /activity.

type AgentActivityModule = typeof import("./views/agent-activity");
let agentActivityModule: AgentActivityModule | null = null;
let agentActivityPromise: Promise<AgentActivityModule> | null = null;

export function lazyRenderAgentActivity(
  state: AppViewState,
  client: GatewayBrowserClient,
  requestUpdate?: () => void,
): TemplateResult | typeof nothing {
  if (agentActivityModule) return agentActivityModule.renderAgentActivity(state, client);
  if (!agentActivityPromise) {
    agentActivityPromise = import("./views/agent-activity").then((m) => {
      agentActivityModule = m;
      requestUpdate?.();
      return m;
    });
  }
  return PLACEHOLDER("activity");
}

// ── Dashboard (/dashboard) ───────────────────────────────────────────────────
// Non-dashboard wall windows skip loading dashboard's component subtree.

type DashboardModule = typeof import("./views/dashboard");
let dashboardModule: DashboardModule | null = null;
let dashboardPromise: Promise<DashboardModule> | null = null;

export function lazyRenderDashboard(
  state: AppViewState,
  client: GatewayBrowserClient,
  requestUpdate?: () => void,
): TemplateResult | typeof nothing {
  if (dashboardModule) return dashboardModule.renderDashboard(state as any, client);
  if (!dashboardPromise) {
    dashboardPromise = import("./views/dashboard").then((m) => {
      dashboardModule = m;
      requestUpdate?.();
      return m;
    });
  }
  return PLACEHOLDER("dashboard");
}

// ── Discipline (/discipline) ─────────────────────────────────────────────────

type DisciplineModule = typeof import("./views/discipline");
let disciplineModule: DisciplineModule | null = null;
let disciplinePromise: Promise<DisciplineModule> | null = null;

export function lazyRenderDiscipline(
  state: AppViewState,
  client: GatewayBrowserClient,
  requestUpdate?: () => void,
): TemplateResult | typeof nothing {
  if (disciplineModule) return disciplineModule.renderDiscipline(state, client);
  if (!disciplinePromise) {
    disciplinePromise = import("./views/discipline").then((m) => {
      disciplineModule = m;
      requestUpdate?.();
      return m;
    });
  }
  return PLACEHOLDER("discipline");
}

// ── Storyboard ────────────────────────────────────────────────────────────────

type StoryboardModule = typeof import("./views/storyboard");
let storyboardModule: StoryboardModule | null = null;
let storyboardPromise: Promise<StoryboardModule> | null = null;

export function lazyRenderStoryboard(
  state: AppViewState,
  client: GatewayBrowserClient,
  requestUpdate?: () => void,
): TemplateResult {
  if (storyboardModule) return storyboardModule.renderStoryboard(state, client);
  if (!storyboardPromise) {
    storyboardPromise = import("./views/storyboard").then((m) => {
      storyboardModule = m;
      requestUpdate?.();
      return m;
    });
  }
  return PLACEHOLDER("storyboard");
}

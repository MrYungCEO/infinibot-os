/**
 * /dashboard — InfiniBot operational command center.
 *
 * Layout (top-down, "F-pattern" scan):
 *   1. Hero band      — greeting + CEO-style synthesized briefing
 *   2. KPI strip      — 6 ops tiles (active agents, done today, blocked, …)
 *   3. Proactive row  — AI Recommendations (left) | Live Pulse (right)
 *   4. Workbench row  — Priority Queue (left)     | Recently Shipped (right)
 *   5. Learning band  — condensed Continue / Path (kept from prior surface)
 *
 * Style: glassmorphism cards in the InfiniBot HUD palette (gold accent,
 * deep neutrals, subtle status tints). Designed to be scannable in 5 seconds:
 * each section answers a single question ("what should I look at next?",
 * "what's working?", "what's stuck?").
 */

import { html, nothing, type TemplateResult } from "lit";
import { isTabAvailable } from "../plugin-host.js";
import { isCloudVoiceActive } from "../controllers/voice-provider";
import "../components/credit-usage-breakdown";
import type { GatewayBrowserClient } from "../gateway";
import { icons } from "../icons";
import {
  type DashboardState,
  type EnrolledCourse,
  type QuickStat,
  type DashBriefing,
  type DashBriefingLine,
  type DashInsight,
  type DashRunningAgent,
  type DashCompletedEntry,
  type DashPriorityTask,
  type DashAgentRoster,
  type DashWorkflow,
  type DashCronJob,
  type DashNote,
  type DashNode,
  type DashProjectVelocity,
  type DashSystemHealth,
  type DashRevenue,
  type DashDiscipline,
  type DashPipeline,
  type DashFocus,
  type DashFocusPriority,
  type DashKanbanLanes,
  type DashProjectProgress,
  type DashContent,
  type DashFederationOverview,
  type DashClientInProgress,
  type DashBusinessFederationSummary,
  type DashCeoInsight,
  type DashAutonomyMini,
  type DashAgencyExecutive,
  type DashSuggestedProject,
  createInitialDashboardState,
  loadDashboardData,
  setDashboardUserName,
} from "../controllers/dashboard";
import { type TrackSummary } from "../controllers/learn";
import { renderSparkline, renderHourlyBars, renderDonut, renderGauge } from "./dashboard-viz";
import { ensureHomeGlassStyles } from "./home-glass";
// Side-effect import: registers the <dashboard-kanban-card> custom element used
// in the Focus row below for the full drag-and-drop main-project board.
import "./dashboard-kanban-card";
import { isSecureModeActive } from "../secure-mode/store";
// Side-effect imports: register <proactive-panel> + <report-card> + <report-thumbnail>
// so the dashboard can mount the v2 commitment/drift surface and the mini report gallery.
import "../components/proactive-panel";
import "../components/trends-radar";
// Side-effect import: registers <todays-priorities>, the prominent shared
// (web + mobile) draggable/hierarchical daily priorities checklist.
import "../components/todays-priorities";
import "../components/report-card";
import "../components/report-thumbnail";
import { loadKanban, updateTask, createProject } from "../controllers/kanban";
import { getFocusItems } from "../controllers/focus";
import { createInitialClientsState, loadClients, openClientDetail } from "../controllers/clients";
import type { AppViewState } from "../app-view-state";
import type { BusinessState } from "../controllers/business";

// ── Host interface ───────────────────────────────────────────

interface DashboardHost {
  dashboard?: DashboardState;
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
  setTab?: (tab: string) => void;
  kanbanGalleryView?: boolean;
  kanbanSelectedProjectId?: string | null;
  businessState?: BusinessState | null;
}

type DashboardNavigateOptions = {
  projectId?: string | null;
  taskId?: string | null;
  clientId?: string | null;
};

const DASHBOARD_NAV_ALIASES: Record<string, string> = {
  kanban: "projects",
  cron: "schedule",
  email: "inbox",
  emails: "inbox",
  "reply-inbox": "inbox",
};

const DASHBOARD_RENDERED_TABS = new Set([
  "activity",
  "agents",
  "agency-operations",
  "apikeys",
  "appearance",
  "apps",
  "autonomy",
  "browser",
  "business",
  "campaigns",
  "channels",
  "chat",
  "clients",
  "config",
  "content-pages",
  "credits",
  "dashboard",
  "databases",
  "debug",
  "design",
  "directories",
  "discipline",
  "docs",
  "federation",
  "files",
  "funnels",
  "grid",
  "hardware",
  "hub",
  "inbox",
  "knowledge-graph",
  "learn",
  "logs",
  "mcp",
  "memory",
  "mobile",
  "mobilepage",
  "nodes",
  "notes",
  "pipeline",
  "plugins",
  "products",
  "profiles",
  "projects",
  "prompt-templates",
  "qualifier",
  "research",
  "schedule",
  "setup",
  "sites",
  "skills",
  "storyboard",
  "terminals",
  "users",
  "voice",
  "voicecommands",
  "whiteboard",
  "workflows",
  "workspace",
]);

const WORLDMAP_SPLIT_STORAGE_KEY = "infinibot-dashboard-worldmap-split";
const WORLDMAP_SPLIT_MIN = 30;
const WORLDMAP_SPLIT_MAX = 80;
const WORLDMAP_SPLIT_DEFAULT = 58;

let worldMapSplitDrag: {
  layout: HTMLElement;
  pointerId: number;
  resizer: HTMLElement;
} | null = null;

function clampWorldMapSplit(value: number): number {
  if (!Number.isFinite(value)) return WORLDMAP_SPLIT_DEFAULT;
  return Math.min(WORLDMAP_SPLIT_MAX, Math.max(WORLDMAP_SPLIT_MIN, value));
}

function getStoredWorldMapSplit(): number {
  if (typeof localStorage === "undefined") return WORLDMAP_SPLIT_DEFAULT;
  const raw = localStorage.getItem(WORLDMAP_SPLIT_STORAGE_KEY);
  if (!raw) return WORLDMAP_SPLIT_DEFAULT;
  return clampWorldMapSplit(Number.parseFloat(raw));
}

function setWorldMapSplit(layout: HTMLElement, split: number, persist = false) {
  const clamped = clampWorldMapSplit(split);
  layout.style.setProperty("--worldmap-split", `${clamped}%`);
  if (persist && typeof localStorage !== "undefined") {
    localStorage.setItem(WORLDMAP_SPLIT_STORAGE_KEY, String(clamped));
  }
}

function getCurrentWorldMapSplit(layout: HTMLElement): number {
  return clampWorldMapSplit(Number.parseFloat(layout.style.getPropertyValue("--worldmap-split")));
}

function splitFromPointer(layout: HTMLElement, clientX: number): number {
  const rect = layout.getBoundingClientRect();
  if (rect.width <= 0) return WORLDMAP_SPLIT_DEFAULT;
  return ((clientX - rect.left) / rect.width) * 100;
}

export function ensureDashboardState<T extends DashboardHost>(state: T): DashboardState {
  if (!state.dashboard) state.dashboard = createInitialDashboardState();
  return state.dashboard;
}

function resolveDashboardTarget(tab: string): string | null {
  const target = DASHBOARD_NAV_ALIASES[tab] ?? tab;
  return DASHBOARD_RENDERED_TABS.has(target) ? target : null;
}

function applyKanbanDeepLink<T extends DashboardHost>(
  state: T,
  options: DashboardNavigateOptions,
): void {
  if (options.projectId) {
    state.kanbanSelectedProjectId = options.projectId;
    state.kanbanGalleryView = false;
  }
  if (options.taskId && typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("infinibot:kanban-open-task", {
        detail: {
          projectId: options.projectId ?? undefined,
          taskId: options.taskId,
        },
      }),
    );
  }
}

async function openDashboardClient<T extends DashboardHost>(
  state: T,
  client: GatewayBrowserClient,
  clientId: string,
): Promise<void> {
  const appState = state as unknown as AppViewState;
  const businessState = appState.businessState;
  if (!businessState) return;
  if (!businessState._clientsState) {
    businessState._clientsState = createInitialClientsState();
  }
  const clientsState = businessState._clientsState;
  if (clientsState.clients.length === 0 && !clientsState.loading) {
    await loadClients(appState, client);
  }
  const record = clientsState.clients.find((c) => c.id === clientId);
  if (record) {
    openClientDetail(appState, client, record);
  } else {
    console.warn(`[dashboard] Client ${clientId} was not found after opening CRM.`);
  }
  state.requestUpdate?.();
}

let _autoLoaded = false;
let _refreshTimer: ReturnType<typeof setInterval> | null = null;

// ── Voice card (first-run discovery) ────────────────────────────────────────
// Local voice is the default and needs no setup. Only when the user picked
// Cloud voice (Robovoice) and this install isn't linked yet does the dashboard
// offer to finish linking it (or switch back to local). Dismissible.
const VOICE_CARD_DISMISS_KEY = "infinibot-voice-card-dismissed";
let _voiceCard: { loaded: boolean; loading: boolean; linked: boolean; dismissed: boolean } = {
  loaded: false,
  loading: false,
  linked: false,
  dismissed:
    typeof localStorage !== "undefined" && localStorage.getItem(VOICE_CARD_DISMISS_KEY) === "1",
};

type DashCommandIntel = {
  loading: boolean;
  loadedAt: number;
  unread: number;
  calendarToday: number;
  nextMeeting: string | null;
  hubRevenueCents: number | null;
  hubPipelineCents: number | null;
  hubOpenDeals: number;
  hubDueActions: number;
  pluginAlerts: number;
  pluginAlertTitle: string | null;
};

const commandIntel: DashCommandIntel = {
  loading: false,
  loadedAt: 0,
  unread: 0,
  calendarToday: 0,
  nextMeeting: null,
  hubRevenueCents: null,
  hubPipelineCents: null,
  hubOpenDeals: 0,
  hubDueActions: 0,
  pluginAlerts: 0,
  pluginAlertTitle: null,
};

async function loadCommandIntel(host: DashboardHost, client: GatewayBrowserClient): Promise<void> {
  if (commandIntel.loading || Date.now() - commandIntel.loadedAt < 30_000) return;
  commandIntel.loading = true;
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  const safe = <T>(request: Promise<T>, fallback: T) => request.catch(() => fallback);
  try {
    const [hub, gmail, calendar, setup] = await Promise.all([
      safe(client.request("hub.overview", {}) as Promise<Record<string, any>>, {}),
      safe(client.request("gmail.insights", { lookbackDays: 7 }) as Promise<{ unread?: number }>, {}),
      safe(
        client.request("calendar.events.list", {
          fromIso: start.toISOString(),
          toIso: end.toISOString(),
        }) as Promise<{ events?: Array<Record<string, unknown>> }>,
        { events: [] },
      ),
      safe(
        client.request("setup.status", {}) as Promise<{
          checks?: Array<{ source?: string; title?: string; state?: string }>;
        }>,
        { checks: [] },
      ),
    ]);
    const events = (calendar.events ?? []).filter((event) => !event.deletedAtMs);
    const next = events
      .filter((event) => Date.parse(String(event.startIso ?? `${event.startDate ?? ""}T00:00:00`)) >= Date.now())
      .sort((a, b) => Date.parse(String(a.startIso ?? a.startDate ?? "")) - Date.parse(String(b.startIso ?? b.startDate ?? "")))[0];
    const alerts = (setup.checks ?? []).filter(
      (check) => check.source !== "core" && (check.state === "needs-setup" || check.state === "error"),
    );
    commandIntel.unread = Number(gmail.unread ?? 0);
    commandIntel.calendarToday = events.length;
    commandIntel.nextMeeting = next ? String(next.summary ?? "Upcoming event") : null;
    commandIntel.hubRevenueCents = typeof hub.revenue?.netCents === "number" ? hub.revenue.netCents : null;
    commandIntel.hubPipelineCents = typeof hub.pipeline?.open?.valueCents === "number" ? hub.pipeline.open.valueCents : null;
    commandIntel.hubOpenDeals = Number(hub.pipeline?.open?.count ?? 0);
    commandIntel.hubDueActions = Array.isArray(hub.attention?.dueActions) ? hub.attention.dueActions.length : 0;
    commandIntel.pluginAlerts = alerts.length;
    commandIntel.pluginAlertTitle = alerts[0]?.title ?? null;
    commandIntel.loadedAt = Date.now();
  } finally {
    commandIntel.loading = false;
    host.requestUpdate?.();
  }
}

async function loadVoiceCardStatus(host: DashboardHost): Promise<void> {
  if (_voiceCard.loaded || _voiceCard.loading) return;
  _voiceCard.loading = true;
  try {
    // Local voice (the default) needs no link: the card is for cloud voice only.
    if (!isCloudVoiceActive()) _voiceCard.linked = true;
    else if (isTabAvailable("robovoice") && host.client) {
      const st = (await host.client.request("robovoice.link.status", { remote: false })) as {
        linked?: boolean;
        unlinkedAt?: string | null;
      };
      _voiceCard.linked = Boolean(st?.linked && !st.unlinkedAt);
    }
  } catch {
    /* unknown → offer to finish cloud voice setup */
  } finally {
    _voiceCard.loaded = true;
    _voiceCard.loading = false;
    host.requestUpdate?.();
  }
}

function dismissVoiceCard(host: DashboardHost): void {
  _voiceCard.dismissed = true;
  if (typeof localStorage !== "undefined") localStorage.setItem(VOICE_CARD_DISMISS_KEY, "1");
  host.requestUpdate?.();
}

function renderVoiceSetupCard(host: DashboardHost): TemplateResult | typeof nothing {
  void loadVoiceCardStatus(host);
  if (!_voiceCard.loaded || _voiceCard.linked || _voiceCard.dismissed) return nothing;
  return html`
    <div class="dash-voice-card" data-testid="dash-voice-robovoice">
      <span class="dash-voice-icon">${icons.mic}</span>
      <div class="dash-voice-text">
        <strong>Finish setting up Cloud voice</strong>
        <span>You picked Cloud voice (Robovoice). Link this install to use it, or switch back to local voice any time.</span>
      </div>
      <button class="dash-voice-cta" @click=${() => host.setTab?.("voice")}>
        Open Voice page →
      </button>
      <button class="dash-voice-dismiss" title="Dismiss" @click=${() => dismissVoiceCard(host)}>${icons.x}</button>
    </div>
  `;
}

// ── Actionable card infrastructure ───────────────────────────
//
// Suggestions / tasks / suggested-projects each get a forward-moving primary
// action wired to the SAME real handlers the rest of the app uses:
//   • suggestions  → sessions.spawn (coder) / navigate (schedule|open|generic)
//   • tasks        → updateTask(status:"done")  (shared kanban update path)
//   • suggested-projects → createProject(...)   (shared kanban create path)
// Per-card loading/error/done is tracked in module-scoped maps so it survives
// the dashboard's pure-function re-renders; mutating them then calling
// requestUpdate() repaints just the affected card.

type ActionUiState = { loading: boolean; error: string | null };
const insightActionState = new Map<string, ActionUiState>();
const taskActionState = new Map<string, ActionUiState & { done: boolean }>();
const projectSuggestState = new Map<
  string,
  ActionUiState & { created: { id: string; name: string } | null }
>();

function insightUi(id: string): ActionUiState {
  let s = insightActionState.get(id);
  if (!s) {
    s = { loading: false, error: null };
    insightActionState.set(id, s);
  }
  return s;
}
function taskUi(id: string): ActionUiState & { done: boolean } {
  let s = taskActionState.get(id);
  if (!s) {
    s = { loading: false, error: null, done: false };
    taskActionState.set(id, s);
  }
  return s;
}
function projectUi(id: string): ActionUiState & { created: { id: string; name: string } | null } {
  let s = projectSuggestState.get(id);
  if (!s) {
    s = { loading: false, error: null, created: null };
    projectSuggestState.set(id, s);
  }
  return s;
}

type InsightActionKind = "coder" | "schedule" | "open" | "email" | "generic" | "none";

/**
 * Resolve a suggestion's forward action. Prefers the explicit, server-set
 * `suggestionKind`; falls back to classifying the suggestion's own text so
 * older / synthesized insights still get a sensible button. Never invents an
 * action — a non-actionable insight with no recognizable verb resolves to
 * "none" (FYI + Dismiss only).
 */
function classifyInsightKind(insight: DashInsight): InsightActionKind {
  if (insight.suggestionKind === "create-project") return "none"; // handled elsewhere
  if (insight.suggestionKind && insight.suggestionKind !== "generic") {
    return insight.suggestionKind;
  }
  const text = `${insight.title} ${insight.description} ${insight.action ?? ""}`.toLowerCase();
  if (
    /\b(spawn|spin up|delegate|assign|deploy|kick off)\b.*\b(coder|agent|engineer|dev)\b/.test(
      text,
    ) ||
    /\b(coder|agent)\b.*\b(spawn|deploy|on (this|it))\b/.test(text)
  ) {
    return "coder";
  }
  if (
    /\b(schedule|cron|recurring|routine|every (day|week|morning|hour)|set up a reminder)\b/.test(
      text,
    )
  ) {
    return "schedule";
  }
  if (/\b(open|view|review)\b.*\b(file|pr|pull request|issue|#\d+|link)\b/.test(text)) {
    return "open";
  }
  if (
    /\b(email|e-mail|reply to|respond to|inbox|message from|follow up with|unanswered)\b/.test(text)
  ) {
    return "email";
  }
  if (insight.suggestionKind === "generic" || insight.actionable) return "generic";
  return "none";
}

function dismissDashInsight(host: DashboardHost, id: string): void {
  const ds = host.dashboard;
  if (!ds) return;
  ds.dismissedInsights.add(id);
  ds.insights = ds.insights.filter((i) => i.id !== id);
  ds.suggestedProjects = ds.suggestedProjects.filter((p) => p.id !== id);
  host.requestUpdate?.();
}

const SNOOZE_MS = 4 * 60 * 60 * 1000; // 4h
function snoozeDashInsight(host: DashboardHost, id: string): void {
  const ds = host.dashboard;
  if (!ds) return;
  ds.snoozedInsights.set(id, Date.now() + SNOOZE_MS);
  ds.insights = ds.insights.filter((i) => i.id !== id);
  host.requestUpdate?.();
}

async function spawnCoderFromInsight(
  host: DashboardHost,
  client: GatewayBrowserClient,
  insight: DashInsight,
): Promise<void> {
  const ui = insightUi(insight.id);
  if (ui.loading) return;
  ui.loading = true;
  ui.error = null;
  host.requestUpdate?.();
  try {
    const task = insight.coderTask ?? insight.description ?? insight.title;
    await client.request("sessions.spawn", {
      task,
      agentId: "coder",
      label: insight.title.slice(0, 60),
    });
    ui.loading = false;
    // Spawned → it now lives in the subagents list; clear it from the nudge feed.
    dismissDashInsight(host, insight.id);
  } catch (err) {
    ui.loading = false;
    ui.error = err instanceof Error ? err.message : "Failed to spawn coder";
    host.requestUpdate?.();
  }
}

async function completePriorityTask(
  host: DashboardHost,
  client: GatewayBrowserClient,
  task: DashPriorityTask,
): Promise<void> {
  const ds = host.dashboard;
  if (!ds) return;
  const ui = taskUi(task.id);
  if (ui.loading || ui.done) return;
  ui.loading = true;
  ui.error = null;
  // Optimistic: drop it from the dashboard's priority list immediately.
  const prevPriority = ds.priorityTasks;
  ds.priorityTasks = ds.priorityTasks.filter((t) => t.id !== task.id);
  host.requestUpdate?.();

  const appState = host as unknown as AppViewState;
  try {
    const errBefore = appState.kanbanError ?? null;
    const known = (appState.kanbanTasks ?? []).some((t) => t.id === task.id);
    if (known) {
      // Reuse the shared kanban update path (optimistic + rollback + Notion sync).
      await updateTask(appState, task.id, { status: "done" });
    } else {
      // The dashboard loaded before the kanban store hydrated — hit the exact
      // same gateway endpoint updateTask() uses rather than forking a new one.
      await client.request("kanban.tasks.update", {
        id: task.id,
        patch: { status: "done", done: true },
      });
    }
    // updateTask swallows request errors into state.kanbanError instead of
    // throwing, so detect a fresh error and roll the dashboard list back.
    const errAfter = appState.kanbanError ?? null;
    if (errAfter && errAfter !== errBefore) throw new Error(errAfter);
    ui.loading = false;
    ui.done = true;
    host.requestUpdate?.();
  } catch (err) {
    ds.priorityTasks = prevPriority; // rollback the optimistic removal
    ui.loading = false;
    ui.error = err instanceof Error ? err.message : "Failed to complete task";
    host.requestUpdate?.();
  }
}

async function createSuggestedProject(
  host: DashboardHost,
  suggestion: DashSuggestedProject,
): Promise<void> {
  const ds = host.dashboard;
  if (!ds) return;
  const ui = projectUi(suggestion.id);
  if (ui.loading || ui.created) return;
  ui.loading = true;
  ui.error = null;
  host.requestUpdate?.();

  const appState = host as unknown as AppViewState;
  try {
    const before = appState.kanbanProjects?.length ?? 0;
    const errBefore = appState.kanbanError ?? null;
    // Shared kanban project-creation path (Notion-backed, local fallback).
    await createProject(appState, {
      name: suggestion.name,
      description: suggestion.description,
    });
    const after = appState.kanbanProjects ?? [];
    const errAfter = appState.kanbanError ?? null;
    if (after.length > before) {
      const created = after[after.length - 1];
      ui.created = { id: created.id, name: created.name };
      ui.loading = false;
      host.requestUpdate?.();
    } else if (errAfter && errAfter !== errBefore) {
      throw new Error(errAfter);
    } else {
      // Created but list didn't grow (unexpected) — still surface success.
      ui.created = { id: "", name: suggestion.name };
      ui.loading = false;
      host.requestUpdate?.();
    }
  } catch (err) {
    ui.loading = false;
    ui.error = err instanceof Error ? err.message : "Failed to create project";
    host.requestUpdate?.();
  }
}

// ── Focus & Priorities inline actions ────────────────────────
// The Focus card was display-only. These wire the SAME real RPC the
// Systems/Autonomy view uses (systems.priorities.update) plus sessions.spawn,
// with optimistic UI + rollback, so the operator can act without navigating.
type FocusUiState = ActionUiState & { done: boolean; pinning: boolean; handing: boolean };
const focusActionState = new Map<string, FocusUiState>();
function focusUi(id: string): FocusUiState {
  let s = focusActionState.get(id);
  if (!s) {
    s = { loading: false, error: null, done: false, pinning: false, handing: false };
    focusActionState.set(id, s);
  }
  return s;
}

async function completeFocusPriority(
  host: DashboardHost,
  client: GatewayBrowserClient,
  p: DashFocusPriority,
): Promise<void> {
  const ds = host.dashboard;
  if (!ds) return;
  const ui = focusUi(p.id);
  if (ui.loading || ui.done) return;
  ui.loading = true;
  ui.error = null;
  const prevFocus = ds.focus;
  // Optimistic: drop it from the focus list immediately.
  ds.focus = {
    ...ds.focus,
    priorities: ds.focus.priorities.filter((x) => x.id !== p.id),
    activeCount: Math.max(0, ds.focus.activeCount - 1),
  };
  host.requestUpdate?.();
  try {
    await client.request("systems.priorities.update", { id: p.id, status: "completed" });
    ui.loading = false;
    ui.done = true;
    host.requestUpdate?.();
  } catch (err) {
    ds.focus = prevFocus; // rollback
    ui.loading = false;
    ui.error = err instanceof Error ? err.message : "Failed to complete priority";
    host.requestUpdate?.();
  }
}

async function pinFocusPriority(
  host: DashboardHost,
  client: GatewayBrowserClient,
  p: DashFocusPriority,
): Promise<void> {
  const ds = host.dashboard;
  if (!ds) return;
  const ui = focusUi(p.id);
  if (ui.pinning) return;
  ui.pinning = true;
  ui.error = null;
  const prevFocus = ds.focus;
  const willPin = !p.isFocus;
  // Optimistic reorder: pin → top + #1 focus; unpin → bottom + clear focus.
  const others = ds.focus.priorities
    .filter((x) => x.id !== p.id)
    .map((x) => ({ ...x, isFocus: false }));
  const self: DashFocusPriority = { ...p, isFocus: willPin };
  const reordered = willPin ? [self, ...others] : [...others, self];
  ds.focus = {
    ...ds.focus,
    priorities: reordered,
    focusTitle: willPin ? self.title : (others[0]?.title ?? null),
  };
  host.requestUpdate?.();
  try {
    await client.request("systems.priorities.update", { id: p.id, rank: willPin ? 1 : 99 });
    ui.pinning = false;
    host.requestUpdate?.();
  } catch (err) {
    ds.focus = prevFocus; // rollback
    ui.pinning = false;
    ui.error = err instanceof Error ? err.message : "Failed to pin priority";
    host.requestUpdate?.();
  }
}

async function handoffFocusPriority(
  host: DashboardHost,
  client: GatewayBrowserClient,
  p: DashFocusPriority,
): Promise<void> {
  const ui = focusUi(p.id);
  if (ui.handing) return;
  ui.handing = true;
  ui.error = null;
  host.requestUpdate?.();
  try {
    const task = `Work on priority: ${p.title}${p.nextStep ? ` — next step: ${p.nextStep}` : ""}${
      p.description ? `\n\n${p.description}` : ""
    }`;
    await client.request("sessions.spawn", {
      task,
      agentId: "coder",
      label: p.title.slice(0, 60),
    });
    ui.handing = false;
    host.requestUpdate?.();
  } catch (err) {
    ui.handing = false;
    ui.error = err instanceof Error ? err.message : "Failed to hand off priority";
    host.requestUpdate?.();
  }
}

// ── Task-suggestion (AI Recommendation) extra inline actions ──
// "Mark complete" flips a backing kanban card when one exists, otherwise it
// acknowledges and clears the nudge. "Draft reply" reveals an inline composer
// and hands the operator's intent to a coder via sessions.spawn.
async function completeDashInsight(
  host: DashboardHost,
  client: GatewayBrowserClient,
  insight: DashInsight,
): Promise<void> {
  const appState = host as unknown as AppViewState;
  const ui = insightUi(insight.id);
  if (ui.loading) return;
  const known = (appState.kanbanTasks ?? []).some((t) => t.id === insight.id);
  if (!known) {
    // No backing kanban card — acknowledge & clear it from the feed.
    dismissDashInsight(host, insight.id);
    return;
  }
  ui.loading = true;
  ui.error = null;
  host.requestUpdate?.();
  try {
    const errBefore = appState.kanbanError ?? null;
    await updateTask(appState, insight.id, { status: "done" });
    const errAfter = appState.kanbanError ?? null;
    if (errAfter && errAfter !== errBefore) throw new Error(errAfter);
    ui.loading = false;
    dismissDashInsight(host, insight.id);
  } catch (err) {
    ui.loading = false;
    ui.error = err instanceof Error ? err.message : "Failed to mark complete";
    host.requestUpdate?.();
  }
}

type InsightDraft = { open: boolean; text: string; sending: boolean };
const insightDraftState = new Map<string, InsightDraft>();
function insightDraft(id: string): InsightDraft {
  let s = insightDraftState.get(id);
  if (!s) {
    s = { open: false, text: "", sending: false };
    insightDraftState.set(id, s);
  }
  return s;
}
function toggleInsightDraft(host: DashboardHost, id: string): void {
  const d = insightDraft(id);
  d.open = !d.open;
  host.requestUpdate?.();
}
async function sendInsightDraft(
  host: DashboardHost,
  client: GatewayBrowserClient,
  insight: DashInsight,
): Promise<void> {
  const d = insightDraft(insight.id);
  if (d.sending || !d.text.trim()) return;
  d.sending = true;
  const ui = insightUi(insight.id);
  ui.error = null;
  host.requestUpdate?.();
  try {
    await client.request("sessions.spawn", {
      task: `Draft and send a reply for: ${insight.title}\n\n${insight.description}\n\nOperator's intent for the reply:\n${d.text.trim()}`,
      agentId: "coder",
      label: `Draft reply: ${insight.title.slice(0, 48)}`,
    });
    d.sending = false;
    d.open = false;
    d.text = "";
    dismissDashInsight(host, insight.id);
  } catch (err) {
    d.sending = false;
    ui.error = err instanceof Error ? err.message : "Failed to draft reply";
    host.requestUpdate?.();
  }
}

// ── Main render entry point ──────────────────────────────────

function warmDashboardData<T extends DashboardHost>(state: T, client: GatewayBrowserClient): void {
  if (_autoLoaded) return;
  _autoLoaded = true;
  void loadDashboardData(state as never, client).then(() => state.requestUpdate?.());
  void resolveUserName(state, client);
  // Warm the kanban store so the main-project board can mount (and so the
  // lanes fallback is only shown while genuinely empty, not just unloaded).
  if (((state as any).kanbanProjects?.length ?? 0) === 0) {
    void loadKanban(state as never).then(() => state.requestUpdate?.());
  }
  // Light auto-refresh — keeps KPIs + agent pulse live without WS plumbing.
  if (_refreshTimer === null && typeof window !== "undefined") {
    _refreshTimer = setInterval(() => {
      void loadDashboardData(state as never, client).then(() => state.requestUpdate?.());
    }, 30_000);
  }
}

function createDashboardNavigate<T extends DashboardHost>(
  state: T,
  client: GatewayBrowserClient,
): (tab: string, options?: DashboardNavigateOptions) => void {
  return (tab: string, options: DashboardNavigateOptions = {}) => {
    let target = resolveDashboardTarget(tab);
    if (!target) {
      console.warn(`[dashboard] Unknown navigation target "${tab}", falling back to autonomy.`);
      target = "autonomy";
    }
    if (target === "projects") {
      applyKanbanDeepLink(state, options);
    }
    state.setTab?.(target);
    if (target === "clients" && options.clientId) {
      void openDashboardClient(state, client, options.clientId);
    }
    state.requestUpdate?.();
  };
}

/**
 * The live, actionable command-center band shared by the full dashboard and
 * the core home shown when the Business & Agency pack is off.
 */
export function renderDashboardCommandCenter<T extends DashboardHost>(
  state: T,
  client: GatewayBrowserClient,
): TemplateResult {
  const ds = ensureDashboardState(state);
  warmDashboardData(state, client);
  injectStyles();
  ensureHomeGlassStyles();
  void loadCommandIntel(state, client);
  void loadVoiceCardStatus(state);
  return renderNeedsNow(ds, createDashboardNavigate(state, client));
}

export function renderDashboard<T extends DashboardHost>(
  state: T,
  client: GatewayBrowserClient,
): ReturnType<typeof html> {
  const ds = ensureDashboardState(state);
  warmDashboardData(state, client);

  injectStyles();
  ensureHomeGlassStyles();
  void loadCommandIntel(state, client);
  const navigate = createDashboardNavigate(state, client);
  const openBusiness = (businessId?: string) => {
    const bs = (state as unknown as AppViewState).businessState;
    if (bs) {
      if (businessId) bs.activeBusinessId = businessId;
      bs.activeSection = businessId ? "overview" : "profile";
    }
    navigate("business");
  };
  const startClientFlow = () => {
    const bs = (state as unknown as AppViewState).businessState;
    if (bs) {
      bs.activeSection = "clients";
      bs._clientsState ??= createInitialClientsState();
      bs._clientsState.showCreateDialog = true;
    }
    navigate("business");
  };
  const dismissInsight = (id: string) => {
    ds.dismissedInsights.add(id);
    ds.ceoInsights = ds.ceoInsights.filter((insight) => insight.id !== id);
    state.requestUpdate?.();
  };

  const preset = readDashboardPreset();
  const show = (id: SectionId) => DASH_PRESETS[preset].sections.has(id);
  const setPreset = (next: DashboardPreset) => {
    writeDashboardPreset(next);
    state.requestUpdate?.();
  };

  return html`
    <div class="dash-page" data-preset=${preset}>
      ${renderPresetSwitcher(preset, setPreset)}
      ${renderHero(ds, navigate)}
      ${renderNeedsNow(ds, navigate)}
      ${renderAgencyExecutive(ds.agencyExecutive, navigate)}
      <todays-priorities .client=${client} .navigate=${navigate}></todays-priorities>
      ${show("proactive") ? html`<proactive-panel .client=${client}></proactive-panel>` : nothing}
      ${show("voice-setup") ? renderVoiceSetupCard(state) : nothing}
      ${show("world-map") ? renderWorldMapBand(state, client, navigate) : nothing}
      ${
        // Trends radar + content card come from the content-studio plugin.
        show("trends-radar") && isTabAvailable("content-pages")
          ? html`<trends-radar .client=${client} .navigate=${navigate}></trends-radar>`
          : nothing
      }
      ${ds.error ? renderError(ds.error) : nothing}
      ${ds.loading && ds.kpis.length === 0 ? renderLoading() : nothing}

      ${
        show("command-zone")
          ? html`
        <section class="dash-command-zone" aria-label="Multi-business federation CEO command center">
          ${renderClientsInProgressHero(
            ds.clientsInProgress,
            (clientRecord) => navigate("clients", { clientId: clientRecord.id }),
            startClientFlow,
          )}
          ${renderBusinessFederationStrip(ds.businessSummaries, openBusiness)}
          <div class="dash-row dash-row-2 dash-command-row">
            ${renderCeoInsightsCard(ds.ceoInsights, navigate, openBusiness, dismissInsight)}
            ${renderAutonomyOversightMini(ds.autonomyMini, navigate)}
          </div>
        </section>
      `
          : nothing
      }

      ${
        show("ops-divider")
          ? html`
              <div class="dash-ops-separator" aria-hidden="true">
                <span></span>
                <strong>Operations</strong>
                <span></span>
              </div>
            `
          : nothing
      }

      ${show("kpi-strip") ? renderKpiStrip(ds) : nothing}
      ${show("activity-timeline") ? renderActivityTimeline(ds) : nothing}

      ${
        show("insights-pulse")
          ? html`
        <div class="dash-row dash-row-2">
          ${renderInsightsCard(state, ds, client, navigate)}
          ${renderPulseCard(ds, navigate)}
        </div>
      `
          : nothing
      }

      ${show("suggested-projects") ? renderSuggestedProjectsCard(state, ds, navigate) : nothing}

      ${
        show("roster-velocity-health")
          ? html`
        <div class="dash-row dash-row-3">
          ${renderRosterCard(ds.agentRoster, navigate)}
          ${renderVelocityCard(ds.projectVelocity, navigate)}
          ${renderHealthCard(ds.systemHealth, navigate)}
        </div>
      `
          : nothing
      }

      ${
        show("revenue-discipline-pipeline")
          ? html`
        <div class="dash-row dash-row-3">
          ${renderRevenueCard(ds.revenue, navigate)}
          ${isTabAvailable("discipline") ? renderDisciplineCard(ds.discipline, navigate) : nothing}
          ${renderPipelineCard(ds.pipeline, navigate)}
        </div>
      `
          : nothing
      }

      ${
        show("priority-shipped")
          ? html`
        <div class="dash-row dash-row-2">
          ${renderPriorityCard(state, ds, client, navigate)}
          ${renderShippedCard(ds, navigate)}
        </div>
      `
          : nothing
      }

      ${renderFocusBoardBand(navigate)}

      ${
        show("focus-kanban")
          ? html`
        <div class="dash-row dash-row-2">
          ${renderFocusCard(state, ds, client, navigate)}
          ${
            ((state as any).kanbanProjects?.length ?? 0) > 0 || isSecureModeActive()
              ? html`<dashboard-kanban-card
                .appState=${state}
                .client=${client}
              ></dashboard-kanban-card>`
              : renderKanbanLanesCard(ds.kanbanLanes, navigate)
          }
        </div>
      `
          : nothing
      }

      ${show("reports-mini") ? renderReportsMini(state, client, navigate) : nothing}
      ${show("content-card") && isTabAvailable("content-pages") ? renderContentCard(ds.content, navigate) : nothing}

      ${
        show("workflows-cron-notes")
          ? html`
        <div class="dash-row dash-row-3">
          ${renderWorkflowsCard(ds.workflows, navigate)}
          ${renderCronCard(ds.cronJobs, navigate)}
          ${renderNotesCard(ds.notes, navigate)}
        </div>
      `
          : nothing
      }

      ${show("federation") ? renderFederationCard(ds.federationOverview, ds.nodes, navigate) : nothing}
      ${show("nodes-strip") ? renderNodesStrip(ds.nodes, navigate) : nothing}
      ${show("learning-band") ? renderLearningBand(ds, navigate) : nothing}
    </div>
  `;
}

type NeedsNowTile = {
  id: string;
  priority: number;
  tone: "danger" | "warn" | "ok" | "gold" | "info";
  icon: TemplateResult;
  value: string;
  label: string;
  detail: string;
  action: string;
  tab: string;
};

function compactMoney(cents: number | null): string {
  if (cents === null) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(cents / 100);
}

function renderNeedsNow(
  ds: DashboardState,
  navigate: (tab: string, options?: DashboardNavigateOptions) => void,
): TemplateResult {
  const failedRuns = ds.recentRuns.filter((run) => run.status === "error" || run.status === "timeout").length;
  const blockedAgents = ds.agencyExecutive.blockedEmployees;
  const agentProblems = failedRuns + blockedAgents;
  const tasksToday = ds.priorityTasks.length;
  const systemPressure = Math.max(ds.systemHealth.cpu, ds.systemHealth.memory, ds.systemHealth.agentLoad);
  const tiles: NeedsNowTile[] = [];

  if (ds.agencyExecutive.pendingApprovals > 0) {
    tiles.push({
      id: "approvals",
      priority: ds.agencyExecutive.highRiskApprovals > 0 ? 100 : 92,
      tone: ds.agencyExecutive.highRiskApprovals > 0 ? "danger" : "warn",
      icon: icons.shield,
      value: String(ds.agencyExecutive.pendingApprovals),
      label: "Approvals waiting",
      detail: ds.agencyExecutive.highRiskApprovals
        ? `${ds.agencyExecutive.highRiskApprovals} high-risk decision${ds.agencyExecutive.highRiskApprovals === 1 ? "" : "s"}`
        : "Ready for your decision",
      action: "Review approvals",
      tab: "agency-operations",
    });
  }
  if (agentProblems > 0 || ds.blockedCount > 0) {
    const total = agentProblems + ds.blockedCount;
    tiles.push({
      id: "blocked-agents",
      priority: 96,
      tone: "danger",
      icon: icons.alertCircle,
      value: String(total),
      label: "Blocked or errored",
      detail: `${agentProblems} agent signal${agentProblems === 1 ? "" : "s"} · ${ds.blockedCount} blocked task${ds.blockedCount === 1 ? "" : "s"}`,
      action: "Intervene now",
      tab: agentProblems ? "activity" : "projects",
    });
  }
  if (ds.runningAgents.length > 0) {
    tiles.push({
      id: "runs",
      priority: 84,
      tone: "ok",
      icon: icons.activity,
      value: String(ds.runningAgents.length),
      label: "Sub-agent runs live",
      detail: ds.runningAgents[0]?.task || ds.runningAgents[0]?.label || "Work in flight",
      action: "Watch live",
      tab: "activity",
    });
  }

  tiles.push({
    id: "today",
    priority: 76,
    tone: tasksToday || commandIntel.calendarToday ? "gold" : "info",
    icon: icons.calendar,
    value: String(tasksToday + commandIntel.calendarToday),
    label: "Today",
    detail: commandIntel.nextMeeting
      ? `${tasksToday} priority task${tasksToday === 1 ? "" : "s"} · next: ${commandIntel.nextMeeting}`
      : tasksToday
        ? `${tasksToday} priority task${tasksToday === 1 ? "" : "s"} · no meetings queued`
        : "Your day is open — set the next move",
    action: commandIntel.calendarToday ? "Open schedule" : "Plan the day",
    tab: commandIntel.calendarToday ? "schedule" : "projects",
  });

  if (commandIntel.hubRevenueCents !== null || commandIntel.hubPipelineCents !== null) {
    tiles.push({
      id: "business",
      priority: commandIntel.hubDueActions > 0 ? 90 : 68,
      tone: commandIntel.hubDueActions > 0 ? "warn" : "gold",
      icon: icons.dollarSign,
      value: compactMoney(commandIntel.hubRevenueCents),
      label: "Business pulse",
      detail: `${compactMoney(commandIntel.hubPipelineCents)} open pipeline · ${commandIntel.hubOpenDeals} deals${commandIntel.hubDueActions ? ` · ${commandIntel.hubDueActions} due` : ""}`,
      action: commandIntel.hubDueActions ? "Clear next actions" : "Open Business Hub",
      tab: "hub",
    });
  }
  if (commandIntel.unread > 0) {
    tiles.push({
      id: "inbox",
      priority: 88,
      tone: commandIntel.unread > 10 ? "warn" : "info",
      icon: icons.mail,
      value: String(commandIntel.unread),
      label: "Unread inbox",
      detail: "Messages waiting for triage or reply",
      action: "Triage inbox",
      tab: "inbox",
    });
  }
  if (_voiceCard.loaded && !_voiceCard.linked) {
    tiles.push({
      id: "voice",
      priority: 62,
      tone: "warn",
      icon: icons.mic,
      value: "OFF",
      label: "Cloud voice not linked",
      detail: "Link Robovoice, or switch back to local voice",
      action: "Open Voice page",
      tab: "voice",
    });
  }
  if (systemPressure >= 80 || ds.systemHealth.nodesOnline < ds.systemHealth.nodesTotal) {
    tiles.push({
      id: "health",
      priority: 94,
      tone: systemPressure >= 90 ? "danger" : "warn",
      icon: icons.server,
      value: `${Math.round(systemPressure)}%`,
      label: "System pressure",
      detail: `${ds.systemHealth.nodesOnline}/${ds.systemHealth.nodesTotal} nodes online · peak resource load`,
      action: "Inspect health",
      tab: "hardware",
    });
  }
  if (commandIntel.pluginAlerts > 0) {
    tiles.push({
      id: "plugins",
      priority: 86,
      tone: "warn",
      icon: icons.puzzle,
      value: String(commandIntel.pluginAlerts),
      label: "Plugin alerts",
      detail: commandIntel.pluginAlertTitle ?? "Plugin setup needs attention",
      action: "Fix setup",
      tab: "plugins",
    });
  }

  const visible = [...new Map(tiles.map((tile) => [tile.id, tile])).values()]
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 8);
  const ticker = [
    ds.runningAgents.length ? `${ds.runningAgents.length} agents active` : "agent queue clear",
    ds.blockedCount ? `${ds.blockedCount} blocked tasks` : "no blocked tasks",
    commandIntel.unread ? `${commandIntel.unread} unread` : "inbox clear",
    commandIntel.hubDueActions ? `${commandIntel.hubDueActions} business actions due` : "pipeline checked",
  ].join("  ·  ");

  return html`
    <section class="dash-needs-now g-panel" aria-labelledby="dash-needs-title">
      <div class="dash-hud-corner dash-hud-corner--tl" aria-hidden="true"></div>
      <div class="dash-hud-corner dash-hud-corner--br" aria-hidden="true"></div>
      <header class="dash-needs-head">
        <div>
          <div class="dash-needs-kicker"><span class="dash-status-light"></span> LIVE COMMAND FEED</div>
          <h2 id="dash-needs-title">What needs me now</h2>
          <p>Priority-sorted actions from agents, work, business, communications, voice and system health.</p>
        </div>
        <div class="dash-needs-gauges" aria-label="Live system gauges">
          <span class="dash-gauge-stat">
            ${renderGauge(ds.systemHealth.agentLoad, { size: 64, thickness: 6, color: "var(--glass-gold)" })}
            <small>agents</small>
          </span>
          <span class="dash-gauge-stat">
            ${renderGauge(ds.systemHealth.memory, { size: 64, thickness: 6 })}
            <small>memory</small>
          </span>
        </div>
      </header>
      <div class="dash-live-ticker" aria-label=${ticker}>
        <span>LIVE</span>
        <div><span class="dash-ticker-track"><b>${ticker}</b><b aria-hidden="true">${ticker}</b></span></div>
      </div>
      ${commandIntel.loading && commandIntel.loadedAt === 0
        ? html`<div class="dash-needs-grid" aria-label="Loading command signals">
            ${[0, 1, 2, 3].map(() => html`<div class="dash-need-tile g-card"><span class="g-skeleton"></span><span class="g-skeleton"></span></div>`)}
          </div>`
        : html`<div class="dash-needs-grid">
            ${visible.map((tile, index) => html`
              <button
                type="button"
                class="dash-need-tile g-card g-card--interactive dash-need-tone-${tile.tone}"
                style=${`--dash-need-index:${index}`}
                @click=${() => navigate(tile.tab)}
                aria-label=${`${tile.label}: ${tile.detail}. ${tile.action}`}
              >
                <span class="dash-need-icon">${tile.icon}</span>
                <span class="dash-need-copy">
                  <span class="dash-need-value g-tabular">${tile.value}</span>
                  <strong>${tile.label}</strong>
                  <small>${tile.detail}</small>
                </span>
                <span class="dash-need-action">${tile.action} ${icons.arrowRight}</span>
              </button>
            `)}
          </div>`}
    </section>
  `;
}

// ── Dashboard Preset Layouts (v2 spec: Hyperfocus / Operator / Executive / Full) ────

type DashboardPreset = "hyperfocus" | "operator" | "executive" | "full";

type SectionId =
  | "proactive"
  | "voice-setup"
  | "world-map"
  | "trends-radar"
  | "command-zone"
  | "ops-divider"
  | "kpi-strip"
  | "activity-timeline"
  | "insights-pulse"
  | "suggested-projects"
  | "roster-velocity-health"
  | "revenue-discipline-pipeline"
  | "priority-shipped"
  | "focus-kanban"
  | "reports-mini"
  | "content-card"
  | "workflows-cron-notes"
  | "federation"
  | "nodes-strip"
  | "learning-band";

const DASH_PRESETS: Record<
  DashboardPreset,
  { label: string; hint: string; sections: Set<SectionId> }
> = {
  hyperfocus: {
    label: "Hyperfocus",
    hint: "Active commitment, top-3 picks, drift radar. ADHD-first.",
    sections: new Set<SectionId>([
      "proactive",
      "insights-pulse",
      "suggested-projects",
      "focus-kanban",
      "priority-shipped",
      "activity-timeline",
    ]),
  },
  operator: {
    label: "Operator",
    hint: "Agent pulse, drift, credits, workflows. Ops-heavy.",
    sections: new Set<SectionId>([
      "proactive",
      "world-map",
      "trends-radar",
      "ops-divider",
      "kpi-strip",
      "activity-timeline",
      "insights-pulse",
      "suggested-projects",
      "roster-velocity-health",
      "priority-shipped",
      "focus-kanban",
      "reports-mini",
      "workflows-cron-notes",
      "federation",
      "nodes-strip",
    ]),
  },
  executive: {
    label: "Executive",
    hint: "Business KPIs, federation roll-up, critical alerts only.",
    sections: new Set<SectionId>([
      "proactive",
      "command-zone",
      "ops-divider",
      "kpi-strip",
      "insights-pulse",
      "suggested-projects",
      "revenue-discipline-pipeline",
      "reports-mini",
      "federation",
    ]),
  },
  full: {
    label: "Full",
    hint: "Every panel. Default legacy layout.",
    sections: new Set<SectionId>([
      "proactive",
      "voice-setup",
      "world-map",
      "trends-radar",
      "command-zone",
      "ops-divider",
      "kpi-strip",
      "activity-timeline",
      "insights-pulse",
      "suggested-projects",
      "roster-velocity-health",
      "revenue-discipline-pipeline",
      "priority-shipped",
      "focus-kanban",
      "reports-mini",
      "content-card",
      "workflows-cron-notes",
      "federation",
      "nodes-strip",
      "learning-band",
    ]),
  },
};

const DASH_PRESET_KEY = "infinibot.dashboard.preset";

function readDashboardPreset(): DashboardPreset {
  if (typeof window === "undefined") return "full";
  const raw = window.localStorage?.getItem(DASH_PRESET_KEY);
  if (raw && raw in DASH_PRESETS) return raw as DashboardPreset;
  return "full";
}

function writeDashboardPreset(next: DashboardPreset): void {
  if (typeof window === "undefined") return;
  window.localStorage?.setItem(DASH_PRESET_KEY, next);
}

function renderPresetSwitcher(
  active: DashboardPreset,
  onSelect: (p: DashboardPreset) => void,
): ReturnType<typeof html> {
  const order: DashboardPreset[] = ["hyperfocus", "operator", "executive", "full"];
  return html`
    <div class="dash-preset-bar" role="tablist" aria-label="Dashboard layout preset">
      ${order.map(
        (p) => html`
          <button
            class="dash-preset ${active === p ? "is-active" : ""}"
            role="tab"
            aria-selected=${active === p}
            title=${DASH_PRESETS[p].hint}
            @click=${() => onSelect(p)}
          >
            ${DASH_PRESETS[p].label}
          </button>
        `,
      )}
    </div>
  `;
}

// ── Mini Reports Gallery — quick generate + first-page thumbnails ────────────

type MiniReport = {
  id: string;
  title: string;
  kind: string;
  createdAt: number;
  status: string;
  filePath?: string;
  mimeType?: string;
};
const REPORT_KINDS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "ceo-hourly", label: "CEO Hourly" },
  { id: "daily-summary", label: "Daily Summary" },
  { id: "weekly-review", label: "Weekly Review" },
  { id: "ops-snapshot", label: "Ops Snapshot" },
];

const reportsMiniState = new WeakMap<
  GatewayBrowserClient,
  { reports: MiniReport[]; loading: boolean; loaded: boolean }
>();

function renderReportsMini<T extends DashboardHost>(
  state: T,
  client: GatewayBrowserClient,
  navigate: (tab: string) => void,
): ReturnType<typeof html> {
  let s = reportsMiniState.get(client);
  if (!s) {
    s = { reports: [], loading: false, loaded: false };
    reportsMiniState.set(client, s);
  }
  if (!s.loaded && !s.loading) {
    s.loading = true;
    void (async () => {
      try {
        const res = (await client.request("reports.list", { limit: 6 })) as
          | { reports?: MiniReport[] }
          | undefined;
        s!.reports = res?.reports ?? [];
      } catch {
        s!.reports = [];
      } finally {
        s!.loaded = true;
        s!.loading = false;
        state.requestUpdate?.();
      }
    })();
  }

  const generate = async (kind: string) => {
    try {
      await client.request("reports.generate", { kind });
      s!.loaded = false;
      state.requestUpdate?.();
    } catch (err) {
      console.warn("[dashboard] reports.generate failed", err);
    }
  };

  return html`
    <section class="dash-card dash-card-lg dash-reports-mini">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon">${icons.fileText ?? nothing}</span>
          <span>Recent reports</span>
        </div>
        <div class="dash-reports-actions">
          ${REPORT_KINDS.map(
            (k) => html`
              <button
                class="dash-cta"
                @click=${() => generate(k.id)}
                title=${`Generate ${k.label}`}
              >
                ${icons.zap ?? nothing} <span>${k.label}</span>
              </button>
            `,
          )}
          <button class="dash-card-link" @click=${() => navigate("reports")}>
            All reports ${icons.arrowRight ?? nothing}
          </button>
        </div>
      </header>
      <div class="dash-card-body">
        ${
          s.loading && s.reports.length === 0
            ? html`
                <div class="dash-empty-row"><span>Loading reports…</span></div>
              `
            : s.reports.length === 0
              ? html`
                <div class="dash-empty-row">
                  <span class="dash-empty-icon">${icons.fileText ?? nothing}</span>
                  <span>No reports yet. Pick a kind above to generate one.</span>
                </div>
              `
              : html`
                <div class="dash-reports-grid">
                  ${s.reports.map(
                    (r) => html`
                      <button
                        class="dash-report-card glass-panel hud-frame"
                        @click=${() => navigate("reports")}
                        title=${r.title}
                      >
                        <report-thumbnail
                          .client=${client}
                          .reportId=${r.id}
                          .filePath=${r.filePath ?? null}
                          .format=${r.mimeType ?? null}
                          .fileSize=${(r as unknown as { fileSize?: number }).fileSize ?? null}
                          .renderedAt=${(r as unknown as { renderedAt?: number }).renderedAt ?? null}
                          .createdAt=${r.createdAt}
                        ></report-thumbnail>
                        <div class="dash-report-meta">
                          <strong>${r.title}</strong>
                          <span>${r.kind} · ${timeAgo(r.createdAt)}</span>
                        </div>
                      </button>
                    `,
                  )}
                </div>
              `
        }
      </div>
    </section>
  `;
}

// ── User name resolution ─────────────────────────────────────

async function resolveUserName<T extends DashboardHost>(
  state: T,
  client: GatewayBrowserClient,
): Promise<void> {
  try {
    const res = (await client.request("users.me", {})) as {
      user?: { username?: string; displayName?: string };
    };
    const name = res.user?.displayName ?? res.user?.username ?? "Operator";
    setDashboardUserName(state as never, name);
    state.requestUpdate?.();
  } catch {
    // keep default
  }
}

// ── Hero band (greeting + briefing) ──────────────────────────

// Lazy-load the world-viz custom element on first dashboard render. Until it is
// registered, the frame shows a CSS-only skeleton shimmer at the same fixed
// height so the layout doesn't pop when the (Pixi-heavy) component mounts.
let _worldVizImportRequested = false;
function ensureWorldVizLoaded() {
  if (_worldVizImportRequested) return;
  if (!customElements.get("agency-world-viz")) {
    _worldVizImportRequested = true;
    void import("../components/agency-world-viz.js").catch((err) =>
      console.warn("[dashboard] world-viz lazy import failed", err),
    );
  }
  if (!customElements.get("world-timeline-scrubber")) {
    void import("../components/world-timeline-scrubber.js").catch((err) =>
      console.warn("[dashboard] timeline-scrubber lazy import failed", err),
    );
  }
}

let _focusPanelImportRequested = false;
function ensureFocusPanelLoaded() {
  if (_focusPanelImportRequested) return;
  if (!customElements.get("agent-focus-panel")) {
    _focusPanelImportRequested = true;
    void import("../components/agent-focus-panel.js").catch((err) =>
      console.warn("[dashboard] agent-focus-panel lazy import failed", err),
    );
  }
}

let _calendarPanelImportRequested = false;
function ensureCalendarPanelLoaded() {
  if (_calendarPanelImportRequested) return;
  if (!customElements.get("dashboard-calendar-panel")) {
    _calendarPanelImportRequested = true;
    void import("../components/dashboard-calendar-panel.js").catch((err) =>
      console.warn("[dashboard] dashboard-calendar-panel lazy import failed", err),
    );
  }
}

// ── World map band (live agent field, embedded under hero) ───
//
// <agency-world-viz> instantiates its own ActivityMap engine per element with
// its own PixiJS canvas — there is no module-level singleton — and the
// dashboard and /grid views are mutually exclusive in the DOM (only the active
// tab renders), so the band and the full-size grid mount never coexist.
function renderWorldMapBand<T extends DashboardHost>(
  _state: T,
  client: GatewayBrowserClient,
  navigate: (tab: string) => void,
): TemplateResult {
  ensureWorldVizLoaded();
  ensureFocusPanelLoaded();
  ensureCalendarPanelLoaded();
  const onAgentSelect = (e: Event) => {
    const ev = e as CustomEvent;
    const panel = (e.currentTarget as HTMLElement).querySelector("agent-focus-panel") as
      | (HTMLElement & { agent?: any; node?: any; open?: boolean })
      | null;
    if (!panel) return;
    panel.agent = ev.detail?.agent ?? null;
    panel.node = null;
    panel.open = true;
  };
  const onNodeSelect = (e: Event) => {
    const ev = e as CustomEvent;
    const panel = (e.currentTarget as HTMLElement).querySelector("agent-focus-panel") as
      | (HTMLElement & { agent?: any; node?: any; open?: boolean })
      | null;
    if (!panel) return;
    panel.node = ev.detail?.node ?? null;
    panel.agent = null;
    panel.open = true;
  };
  const onFocusStop = (e: Event) => {
    const sessionKey = (e as CustomEvent).detail?.sessionKey;
    if (!sessionKey) return;
    void client.request("agent.abort", { sessionKey });
  };
  const onFocusOpenSession = () => navigate("terminals");
  const onFocusOpenRun = () => navigate("runs");
  const onOpenCalendar = () => navigate("schedule");
  const initialSplit = getStoredWorldMapSplit();
  const findLayout = (target: EventTarget | null): HTMLElement | null =>
    target instanceof HTMLElement ? target.closest<HTMLElement>(".dash-worldmap__layout") : null;
  const onSplitPointerDown = (e: PointerEvent) => {
    const resizer = e.currentTarget as HTMLElement;
    const layout = findLayout(resizer);
    if (!layout) return;
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add("is-dragging");
    worldMapSplitDrag = { layout, pointerId: e.pointerId, resizer };
    setWorldMapSplit(layout, splitFromPointer(layout, e.clientX));
  };
  const onSplitPointerMove = (e: PointerEvent) => {
    if (!worldMapSplitDrag || worldMapSplitDrag.pointerId !== e.pointerId) return;
    setWorldMapSplit(
      worldMapSplitDrag.layout,
      splitFromPointer(worldMapSplitDrag.layout, e.clientX),
    );
  };
  const finishSplitPointer = (e: PointerEvent, persistFromPointer: boolean) => {
    if (!worldMapSplitDrag || worldMapSplitDrag.pointerId !== e.pointerId) return;
    const { layout, resizer, pointerId } = worldMapSplitDrag;
    setWorldMapSplit(
      layout,
      persistFromPointer ? splitFromPointer(layout, e.clientX) : getCurrentWorldMapSplit(layout),
      true,
    );
    if (resizer.hasPointerCapture(pointerId)) {
      resizer.releasePointerCapture(pointerId);
    }
    resizer.classList.remove("is-dragging");
    worldMapSplitDrag = null;
  };
  const onSplitKeydown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const layout = findLayout(e.currentTarget);
    if (!layout) return;
    e.preventDefault();
    const current =
      Number.parseFloat(layout.style.getPropertyValue("--worldmap-split")) ||
      getStoredWorldMapSplit();
    const delta = e.key === "ArrowLeft" ? -2 : 2;
    setWorldMapSplit(layout, current + delta, true);
  };
  return html`
    <section
      class="dash-worldmap"
      @agency-agent-select=${onAgentSelect}
      @agency-node-select=${onNodeSelect}
      @focus-stop=${onFocusStop}
      @focus-open-session=${onFocusOpenSession}
      @focus-open-run=${onFocusOpenRun}
      @dashboard-open-calendar=${onOpenCalendar}
    >
      <header class="dash-worldmap__head">
        <div>
          <div class="dash-worldmap__eyebrow">AGENT FIELD</div>
          <div class="dash-worldmap__title">Live operations</div>
        </div>
        <button
          class="dash-worldmap__fullscreen"
          @click=${() => navigate("grid")}
          title="Open full agent world"
        >
          ${icons.maximize} EXPAND
        </button>
      </header>
      <div
        class="dash-worldmap__layout"
        style="--worldmap-split: ${initialSplit}%"
      >
        <div class="dash-worldmap__frame">
          <div class="dash-worldmap__skeleton" aria-hidden="true"></div>
          <agency-world-viz .client=${client} no-overlays></agency-world-viz>
          <world-timeline-scrubber></world-timeline-scrubber>
          <div class="dash-worldmap__bl"></div>
          <div class="dash-worldmap__br"></div>
        </div>
        <div
          class="dash-worldmap__resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize live operations panels"
          tabindex="0"
          @pointerdown=${onSplitPointerDown}
          @pointermove=${onSplitPointerMove}
          @pointerup=${(e: PointerEvent) => finishSplitPointer(e, true)}
          @pointercancel=${(e: PointerEvent) => finishSplitPointer(e, false)}
          @keydown=${onSplitKeydown}
        ></div>
        <div class="dash-worldmap__aside">
          <dashboard-calendar-panel
            .client=${client}
          ></dashboard-calendar-panel>
        </div>
      </div>
      <!-- Slide-in inspector: same panel the Activity grid uses. -->
      <agent-focus-panel></agent-focus-panel>
    </section>
  `;
}

function renderHero(ds: DashboardState, navigate: (tab: string) => void): TemplateResult {
  const greeting = timeBasedGreeting();
  const briefing = ds.briefing;
  return html`
    <header class="dash-hero">
      <div class="dash-hero-glow" aria-hidden="true"></div>
      <div class="dash-hero-content">
        <div class="dash-hero-left">
          <div class="dash-hero-tag">
            <span class="dash-hero-dot"></span>
            <span>InfiniBot · Command Center</span>
          </div>
          <h1 class="dash-hero-title">
            ${greeting}, ${ds.userName}.
          </h1>
          <p class="dash-hero-headline">
            ${briefing?.headline ?? "Loading today's briefing…"}
          </p>
          ${
            briefing && briefing.lines.length > 0
              ? html`
                <ul class="dash-brief-list">
                  ${briefing.lines.map((line) => renderBriefingLine(line, navigate))}
                </ul>
              `
              : nothing
          }
        </div>
        <div class="dash-hero-right">
          <button class="dash-cta dash-cta-primary" @click=${() => navigate("chat")}>
            ${icons.messageSquare ?? nothing}
            <span>Brief an agent</span>
          </button>
          <button class="dash-cta" @click=${() => navigate("autonomy")}>
            ${icons.target ?? nothing}
            <span>Set a goal</span>
          </button>
          <button class="dash-cta" @click=${() => navigate("activity")}>
            ${icons.activity ?? nothing}
            <span>See live pulse</span>
          </button>
          ${
            briefing
              ? html`<span class="dash-hero-meta">Updated ${timeAgo(briefing.generatedAt)}</span>`
              : nothing
          }
        </div>
      </div>
    </header>
  `;
}

function renderAgencyExecutive(
  agency: DashAgencyExecutive,
  navigate: (tab: string) => void,
): TemplateResult {
  if (!agency.available) {
    return html`
      <section class="dash-card glass-panel hud-frame" style="padding:18px;">
        <div class="dash-command-head">
          <div>
            <span class="dash-command-eyebrow">Agency operating system</span>
            <h2>Set up your agency workspace</h2>
          </div>
          <button class="dash-cta dash-cta-primary" @click=${() => navigate("agency-operations")}>
            Open agency setup ${icons.arrowRight ?? nothing}
          </button>
        </div>
        <p class="dash-card-sub">
          Create or select the canonical agency that owns your clients, projects, workforce,
          approvals, finances, and private collaboration.
        </p>
      </section>
    `;
  }

  const health =
    agency.highRiskApprovals || agency.atRiskEngagements || agency.blockedEmployees
      ? "Needs attention"
      : agency.gaps.length
        ? "Setup gaps"
        : "Healthy";
  const healthTone = health === "Healthy" ? "var(--dash-ok)" : "var(--dash-warn)";
  return html`
    <section class="dash-card glass-panel hud-frame" style="padding:18px;display:flex;flex-direction:column;gap:16px;">
      <header class="dash-command-head">
        <div>
          <span class="dash-command-eyebrow">Agency operating system · ${agency.agencyRole ?? "member"}</span>
          <h2>${agency.agencyName}</h2>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="dash-status-pill" style="color:${healthTone};border-color:${healthTone};">${health}</span>
          <button class="dash-card-link" @click=${() => navigate("agency-operations")}>
            Operate agency ${icons.arrowRight ?? nothing}
          </button>
        </div>
      </header>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px;">
        ${agency.kpis.slice(0, 4).map(
          (kpi) => html`
            <div class="dash-fed-stat">
              <span class="dash-fed-stat-value">${kpi.value}</span>
              <span class="dash-fed-stat-label">${kpi.label}</span>
              ${kpi.context ? html`<small class="dash-card-sub">${kpi.context}</small>` : nothing}
            </div>
          `,
        )}
        <div class="dash-fed-stat">
          <span class="dash-fed-stat-value">${agency.humanEmployees} + ${agency.aiEmployees}</span>
          <span class="dash-fed-stat-label">Human + AI employees</span>
          <small class="dash-card-sub">${agency.averageUtilization}% average utilization</small>
        </div>
        <div class="dash-fed-stat">
          <span class="dash-fed-stat-value">${agency.pendingApprovals}</span>
          <span class="dash-fed-stat-label">Pending approvals</span>
          <small class="dash-card-sub">${agency.highRiskApprovals} high risk</small>
        </div>
      </div>

      <div class="dash-row dash-row-2" style="align-items:stretch;">
        <div style="display:flex;flex-direction:column;gap:8px;">
          <span class="dash-command-eyebrow">Operating gaps</span>
          ${
            agency.gaps.length
              ? agency.gaps.slice(0, 5).map(
                  (gap) => html`
                  <div class="dash-priority" style="--tone:var(--dash-warn);">
                    <span class="dash-priority-rank">!</span>
                    <span class="dash-priority-title">${gap}</span>
                  </div>
                `,
                )
              : html`
                  <div class="dash-command-empty"><strong>No critical operating gaps.</strong></div>
                `
          }
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <span class="dash-command-eyebrow">Next best actions</span>
          ${agency.nextActions.map(
            (action, index) => html`
              <button
                class="dash-priority ${index === 0 ? "is-focus" : ""}"
                style="--tone:${action.tone === "danger" ? "var(--dash-danger)" : action.tone === "warn" ? "var(--dash-warn)" : "var(--dash-gold)"};text-align:left;"
                @click=${() => navigate(action.tab)}
              >
                <span class="dash-priority-rank">${index + 1}</span>
                <span class="dash-priority-body">
                  <span class="dash-priority-title">${action.label}</span>
                  <span class="dash-priority-next">${action.detail}</span>
                </span>
                ${icons.arrowRight ?? nothing}
              </button>
            `,
          )}
        </div>
      </div>

      <footer style="display:flex;flex-wrap:wrap;gap:8px;color:var(--dash-fg-dim);font-size:11px;">
        <span>${agency.activeEngagements} active engagements</span>
        <span>·</span>
        <span>${agency.collaborationState === "ready" ? "Private collaboration ready" : agency.collaborationMessage}</span>
        ${
          agency.migrationPending
            ? html`<span>· ${agency.migrationBusinesses} legacy workspace(s) pending migration</span>`
            : nothing
        }
      </footer>
    </section>
  `;
}

function renderBriefingLine(
  line: DashBriefingLine,
  navigate?: (tab: string) => void,
): TemplateResult {
  const iconEl = line.icon ? ((icons as any)[line.icon] ?? nothing) : nothing;
  // Actionable "Where am I" lines (recent runs / tasks / branch) deep-link to
  // the surface that names them. Falls back to a plain row when no action.
  const actionable = Boolean(line.actionTab && navigate);
  const go = () => {
    if (line.actionTab && navigate) navigate(line.actionTab);
  };
  return html`
    <li
      class="dash-brief-line dash-tone-${line.tone}${actionable ? " dash-brief-line-action" : ""}"
      role=${actionable ? "button" : nothing}
      tabindex=${actionable ? "0" : nothing}
      @click=${actionable ? go : nothing}
      @keydown=${
        actionable
          ? (e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                go();
              }
            }
          : nothing
      }
    >
      <span class="dash-brief-dot"></span>
      ${iconEl ? html`<span class="dash-brief-icon">${iconEl}</span>` : nothing}
      <span class="dash-brief-text">${line.text}</span>
      ${actionable ? html`<span class="dash-brief-arrow">${icons.arrowRight ?? nothing}</span>` : nothing}
    </li>
  `;
}

// ── Command zone · clients in progress ───────────────────────

function renderClientsInProgressHero(
  clients: DashClientInProgress[],
  openClient: (client: DashClientInProgress) => void,
  startClientFlow: () => void,
): TemplateResult {
  return html`
    <section class="dash-clients-hero">
      <header class="dash-command-head">
        <div>
          <span class="dash-command-eyebrow">Command priority</span>
          <h2>Clients in progress</h2>
        </div>
        <button class="dash-card-link" @click=${startClientFlow}>
          New client ${icons.arrowRight ?? nothing}
        </button>
      </header>
      ${
        clients.length === 0
          ? html`
            <div class="dash-command-empty glass-panel hud-frame">
              <span class="dash-empty-icon">${(icons as { users?: TemplateResult }).users ?? icons.bot ?? nothing}</span>
              <div>
                <strong>No active client work yet.</strong>
                <span>Start a client flow from Business CRM and it will surface here.</span>
              </div>
              <button class="dash-cta dash-cta-primary" @click=${startClientFlow}>
                ${icons.arrowRight ?? nothing}
                <span>Open business clients</span>
              </button>
            </div>
          `
          : html`
            <div class="dash-client-tiles">
              ${clients.map((client) => renderClientInProgressTile(client, openClient))}
            </div>
          `
      }
    </section>
  `;
}

function renderClientInProgressTile(
  client: DashClientInProgress,
  openClient: (client: DashClientInProgress) => void,
): TemplateResult {
  // Tone the progress bar so a stale client visually screams.
  const stale = client.lastActivityAt
    ? Date.now() - client.lastActivityAt > 72 * 60 * 60_000
    : false;
  const progressTone = stale
    ? "var(--dash-warn)"
    : client.progress >= 75
      ? "var(--dash-ok)"
      : client.progress >= 25
        ? "var(--client-accent)"
        : "var(--dash-danger)";

  const stop = (e: Event) => e.stopPropagation();
  const action = (e: Event, label: string) => {
    e.stopPropagation();
    e.preventDefault();
    if (client.activeProjectId) {
      window.dispatchEvent(
        new CustomEvent("infinibot:focus-project", {
          detail: {
            projectId: client.activeProjectId,
            clientId: client.id,
            source: "dashboard-clients",
            intent: label,
          },
        }),
      );
    } else {
      openClient(client);
    }
  };

  return html`
    <div class="dash-client-tile-wrap" style="--client-accent:${client.businessColor};">
      <button
        class="dash-client-tile glass-panel hud-frame"
        @click=${() => openClient(client)}
        title=${`Open ${client.name}`}
      >
        <div class="dash-client-topline">
          <span class="dash-client-badge">${client.businessName}</span>
          <span class="dash-client-status">${client.status}</span>
        </div>
        <strong class="dash-client-name">${client.name}</strong>
        <span class="dash-client-project">${client.activeProjectTitle}</span>
        <div class="dash-client-progress" aria-label=${`${client.progress}% complete`}>
          <span style="width:${client.progress}%;background:${progressTone};"></span>
        </div>
        <div class="dash-client-metrics">
          <span>${client.progress}%</span>
          <span>${client.daysInProgress}d active</span>
          <span>${client.lastActivityAt ? timeAgo(client.lastActivityAt) : "no activity"}</span>
        </div>
        <div class="dash-client-agent">
          ${icons.bot ?? nothing}
          <span>${client.agentAssigned}</span>
        </div>
      </button>
      ${
        client.activeProjectId
          ? html`
            <div class="dash-client-project-card glass-panel hud-frame" @click=${stop}>
              <div class="dash-client-project-head">
                <span class="dash-client-project-eyebrow">Active project</span>
                <span class="dash-client-project-title">${client.activeProjectTitle}</span>
                ${
                  client.activeProjectStatus
                    ? html`<span class="dash-client-project-status">${client.activeProjectStatus}</span>`
                    : nothing
                }
              </div>
              <div class="dash-client-project-bar">
                <span style="width:${client.progress}%;background:${progressTone};"></span>
              </div>
              <div class="dash-client-project-actions">
                <button class="dash-cta dash-cta-primary" @click=${(e: Event) => action(e, "commit")}>
                  ${icons.target ?? nothing} <span>Commit focus</span>
                </button>
                <button class="dash-cta" @click=${(e: Event) => action(e, "open-kanban")}>
                  ${icons.layout ?? nothing} <span>Open kanban</span>
                </button>
                <button class="dash-cta" @click=${(e: Event) => action(e, "update")}>
                  ${icons.refresh ?? icons.zap ?? nothing} <span>Update</span>
                </button>
              </div>
            </div>
          `
          : nothing
      }
    </div>
  `;
}

// ── Command zone · business federation strip ─────────────────

function renderBusinessFederationStrip(
  businesses: DashBusinessFederationSummary[],
  openBusiness: (businessId?: string) => void,
): TemplateResult {
  return html`
    <section class="dash-business-strip-wrap">
      <header class="dash-command-head dash-command-head-compact">
        <div>
          <span class="dash-command-eyebrow">Federation</span>
          <h2>Business fleet</h2>
        </div>
        <button class="dash-card-link" @click=${() => openBusiness()}>
          Business hub ${icons.arrowRight ?? nothing}
        </button>
      </header>
      ${
        businesses.length === 0
          ? html`
            <div class="dash-command-empty glass-panel hud-frame">
              <span class="dash-empty-icon">${icons.briefcase ?? icons.book ?? nothing}</span>
              <div>
                <strong>No business summaries loaded.</strong>
                <span>Connect a business profile to surface revenue, clients, and activity.</span>
              </div>
            </div>
          `
          : html`
            <div class="dash-business-strip ${businesses.length === 1 ? "single" : ""}">
              ${businesses.map((business) => renderBusinessFederationCard(business, openBusiness))}
            </div>
          `
      }
    </section>
  `;
}

function renderBusinessFederationCard(
  business: DashBusinessFederationSummary,
  openBusiness: (businessId?: string) => void,
): TemplateResult {
  return html`
    <button
      class="dash-business-card glass-panel hud-frame"
      style="--biz-accent:${business.brandColor};"
      @click=${() => openBusiness(business.id)}
      title=${`Open ${business.name}`}
    >
      <div class="dash-business-top">
        <span class="dash-business-logo">
          ${business.logo ? html`<img src=${business.logo} alt="" />` : business.name.slice(0, 2).toUpperCase()}
        </span>
        <span class="dash-business-name">${business.name}</span>
        <span class="dash-status-pill dash-status-${business.status}">${business.status}</span>
      </div>
      <div class="dash-business-kpis">
        <span><strong>$${formatMoney(business.revenue7d)}</strong><small>7d revenue</small></span>
        <span><strong>${business.activeClients}</strong><small>clients</small></span>
        <span><strong>${business.projectsInProgress}</strong><small>projects</small></span>
        <span><strong>${business.blockedTasks}</strong><small>blocked</small></span>
      </div>
      <div class="dash-business-spark" aria-label="Last 7 day revenue">
        ${business.revenueSpark7d.map((value) => {
          const max = Math.max(1, ...business.revenueSpark7d);
          const height = Math.max(8, Math.round((value / max) * 34));
          return html`<span style="height:${height}px"></span>`;
        })}
      </div>
      <div class="dash-business-activity">
        <span>24h activity</span>
        <strong>${business.activityScore24h}</strong>
      </div>
    </button>
  `;
}

// ── Command zone · CEO insights ──────────────────────────────

function renderCeoInsightsCard(
  insights: DashCeoInsight[],
  navigate: (tab: string, options?: DashboardNavigateOptions) => void,
  openBusiness: (businessId?: string) => void,
  dismissInsight: (id: string) => void,
): TemplateResult {
  return html`
    <section class="dash-card dash-card-lg dash-ceo-card">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-warn">${icons.sparkles ?? nothing}</span>
          <span>CEO insights</span>
        </div>
        <span class="dash-card-sub">Proactive cross-business signals</span>
      </header>
      <div class="dash-card-body dash-ceo-body">
        ${
          insights.length === 0
            ? html`
              <div class="dash-empty-row">
                <span class="dash-empty-icon">${icons.checkCircle ?? nothing}</span>
                <span>No urgent CEO-level signals right now.</span>
              </div>
            `
            : insights.map((insight) =>
                renderCeoInsightRow(insight, navigate, openBusiness, dismissInsight),
              )
        }
      </div>
    </section>
  `;
}

function renderCeoInsightRow(
  insight: DashCeoInsight,
  navigate: (tab: string, options?: DashboardNavigateOptions) => void,
  openBusiness: (businessId?: string) => void,
  dismissInsight: (id: string) => void,
): TemplateResult {
  const icon =
    insight.severity === "critical"
      ? icons.alertCircle
      : insight.severity === "success"
        ? icons.checkCircle
        : insight.severity === "warn"
          ? ((icons as any).alertTriangle ?? icons.alertCircle)
          : ((icons as any).info ?? icons.sparkles);
  const act = () => {
    if (insight.clientId) navigate("clients", { clientId: insight.clientId });
    else if (insight.businessId) openBusiness(insight.businessId);
    else navigate(insight.actionTab);
  };
  return html`
    <article class="dash-ceo-insight dash-ceo-${insight.severity}">
      <span class="dash-ceo-icon">${icon ?? nothing}</span>
      <div class="dash-ceo-copy">
        <strong>${insight.title}</strong>
        <span>${insight.rationale}</span>
      </div>
      <button class="dash-ceo-action" @click=${act}>${insight.actionLabel}</button>
      <button
        class="dash-ceo-dismiss"
        @click=${(event: Event) => {
          event.stopPropagation();
          dismissInsight(insight.id);
        }}
        title="Dismiss insight"
        aria-label="Dismiss insight"
      >x</button>
    </article>
  `;
}

// ── Command zone · autonomy oversight ────────────────────────

function renderAutonomyOversightMini(
  autonomy: DashAutonomyMini,
  navigate: (tab: string, options?: DashboardNavigateOptions) => void,
): TemplateResult {
  const tone =
    autonomy.status === "blocked" || autonomy.status === "error"
      ? "danger"
      : autonomy.status === "paused"
        ? "warn"
        : autonomy.status === "running"
          ? "ok"
          : "primary";
  return html`
    <section class="dash-card dash-card-lg dash-auto-mini dash-tone-${tone}">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-${tone}">${icons.target ?? nothing}</span>
          <span>Autonomy oversight</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("autonomy")}>
          Review queue ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body dash-auto-body">
        <div class="dash-auto-status">
          <span class="dash-auto-orb"></span>
          <div>
            <strong>${autonomy.statusLabel}</strong>
            <span>${autonomy.lastUpdatedAt ? `Updated ${timeAgo(autonomy.lastUpdatedAt)}` : "Waiting for status"}</span>
          </div>
          ${
            autonomy.openPrefireDrafts > 0
              ? html`<span class="dash-prefire-badge">${autonomy.openPrefireDrafts} prefire</span>`
              : nothing
          }
        </div>
        <div class="dash-auto-decisions">
          ${
            autonomy.decisions.length === 0
              ? html`
                  <div class="dash-empty-row"><span>No recent autonomy decisions.</span></div>
                `
              : autonomy.decisions.map(
                  (decision) => html`
                <div class="dash-auto-decision">
                  <span class=${decision.ok ? "ok" : "fail"}>${decision.ok ? icons.checkCircle : icons.xCircle}</span>
                  <strong>${decision.summary}</strong>
                  <em>${timeAgo(decision.timestamp)}</em>
                </div>
              `,
                )
          }
        </div>
        ${autonomy.error ? html`<div class="dash-auto-error">${autonomy.error}</div>` : nothing}
      </div>
    </section>
  `;
}

function timeBasedGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

// ── Loading / Error ──────────────────────────────────────────

function renderLoading(): TemplateResult {
  return html`
    <div class="dash-loading">
      <span class="dash-spinner"></span>
      <span>Reading the fleet…</span>
    </div>
  `;
}

function renderError(error: string): TemplateResult {
  return html`
    <div class="dash-banner dash-banner-error">
      ${icons.alertCircle ?? nothing}
      <span>${error}</span>
    </div>
  `;
}

// ── KPI strip ────────────────────────────────────────────────

function renderKpiStrip(ds: DashboardState): TemplateResult {
  const kpis = ds.kpis;
  if (kpis.length === 0)
    return html`

    `;
  // Pair the spark series with the matching label so we render only on the
  // two ops tiles that benefit from a trend (not every tile gets a spark —
  // dashboard noise budget).
  const sparkFor = (label: string): number[] | null => {
    if (label === "Active Agents") return ds.activeSpark;
    if (label === "Done Today") return ds.completionsSpark;
    return null;
  };
  return html`
    <section class="dash-kpis">
      ${kpis.map((stat) => renderKpiCard(stat, sparkFor(stat.label)))}
    </section>
  `;
}

function renderKpiCard(stat: QuickStat, spark: number[] | null): TemplateResult {
  const iconEl = (icons as any)[stat.icon] ?? icons.barChart ?? nothing;
  const tone = stat.tone ?? "primary";
  const trendIcon =
    stat.trend === "up"
      ? ((icons as any).trendingUp ?? icons.arrowRight)
      : stat.trend === "down"
        ? ((icons as any).trendingDown ?? icons.arrowRight)
        : nothing;
  const toneColor = toneCssVar(tone);
  return html`
    <div class="dash-kpi dash-tone-${tone}">
      <div class="dash-kpi-head">
        <span class="dash-kpi-icon">${iconEl}</span>
        <span class="dash-kpi-label">${stat.label}</span>
      </div>
      <div class="dash-kpi-body">
        <span class="dash-kpi-value">${stat.value}</span>
        ${
          stat.trend && stat.trend !== "neutral"
            ? html`<span class="dash-kpi-trend dash-kpi-trend-${stat.trend}">${trendIcon}</span>`
            : nothing
        }
      </div>
      ${
        spark && spark.some((v) => v > 0)
          ? html`
            <div class="dash-kpi-spark">
              ${renderSparkline(spark, {
                width: 110,
                height: 26,
                color: toneColor,
                fill: `${toneColor}24`,
              })}
            </div>
          `
          : nothing
      }
      ${stat.deltaLabel ? html`<span class="dash-kpi-delta">${stat.deltaLabel}</span>` : nothing}
    </div>
  `;
}

function toneCssVar(tone: string): string {
  switch (tone) {
    case "ok":
      return "#22c55e";
    case "warn":
      return "#f59e0b";
    case "danger":
      return "#ef4444";
    case "info":
      return "#38bdf8";
    case "neutral":
      return "rgba(245,245,244,0.55)";
    default:
      return "#ffd700";
  }
}

// ── Activity Timeline (24h hourly bars) ──────────────────────

function renderActivityTimeline(ds: DashboardState): TemplateResult {
  const total = ds.completionsByHour.reduce((s, v) => s + v, 0);
  const peakIdx = ds.completionsByHour.reduce((best, v, i, arr) => (v > arr[best] ? i : best), 0);
  const peakHour = ((new Date().getHours() - (23 - peakIdx) + 24) % 24).toString().padStart(2, "0");
  return html`
    <section class="dash-card dash-card-tl">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-primary">${icons.activity ?? nothing}</span>
          <span>Activity Timeline · last 24h</span>
        </div>
        <div class="dash-tl-meta">
          <span class="dash-tl-stat">
            <span class="dash-tl-stat-value">${total}</span>
            <span class="dash-tl-stat-label">tasks shipped</span>
          </span>
          <span class="dash-tl-divider"></span>
          <span class="dash-tl-stat">
            <span class="dash-tl-stat-value">${peakHour}h</span>
            <span class="dash-tl-stat-label">peak hour</span>
          </span>
          <span class="dash-tl-divider"></span>
          <span class="dash-tl-stat">
            <span class="dash-tl-stat-value">${ds.runningAgents.length}</span>
            <span class="dash-tl-stat-label">working now</span>
          </span>
        </div>
      </header>
      <div class="dash-card-body dash-tl-body">
        ${renderHourlyBars(ds.completionsByHour, {
          height: 96,
          color: "var(--dash-gold, #ffd700)",
          overlay: ds.runningByHour,
          overlayColor: "rgba(56,189,248,0.85)",
        })}
        <div class="dash-tl-legend">
          <span class="dash-tl-legend-item">
            <span class="dash-tl-swatch dash-tl-swatch-gold"></span>
            Completions per hour
          </span>
          <span class="dash-tl-legend-item">
            <span class="dash-tl-swatch dash-tl-swatch-blue"></span>
            Agents online (now)
          </span>
        </div>
      </div>
    </section>
  `;
}

// ── AI Recommendations card ──────────────────────────────────

function renderInsightsCard<T extends DashboardHost>(
  host: T,
  ds: DashboardState,
  client: GatewayBrowserClient,
  navigate: (tab: string) => void,
): TemplateResult {
  return html`
    <section class="dash-card dash-card-lg">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-primary">${icons.sparkles ?? nothing}</span>
          <span>AI Recommendations</span>
        </div>
        <span class="dash-card-sub">Proactive nudges from your agents</span>
      </header>
      <div class="dash-card-body">
        ${
          ds.insights.length === 0
            ? html`
              <div class="dash-empty-row">
                <span class="dash-empty-icon">${icons.checkCircle ?? nothing}</span>
                <span>Nothing on fire. Your agents will surface insights as work flows in.</span>
              </div>
            `
            : html`
              <ul class="dash-insight-list">
                ${ds.insights.map((i) => renderInsightRow(host, client, i, navigate))}
              </ul>
            `
        }
      </div>
    </section>
  `;
}

function renderInsightRow<T extends DashboardHost>(
  host: T,
  client: GatewayBrowserClient,
  insight: DashInsight,
  navigate: (tab: string) => void,
): TemplateResult {
  const tone =
    insight.severity === "high"
      ? "danger"
      : insight.severity === "medium"
        ? "warn"
        : insight.type === "alignment"
          ? "ok"
          : "primary";
  const iconName =
    insight.type === "warning"
      ? "alertCircle"
      : insight.type === "alignment"
        ? "trendingUp"
        : insight.type === "opportunity"
          ? "zap"
          : "info";
  const iconEl = (icons as any)[iconName] ?? icons.zap ?? nothing;

  const kind = classifyInsightKind(insight);
  const ui = insightUi(insight.id);

  // The primary forward action, as a thunk so keyboard (Enter) can reuse it.
  let primaryLabel: string | null = null;
  let primaryIcon: TemplateResult | typeof nothing = nothing;
  let primaryFire: (() => void) | null = null;
  let primaryAria = "";
  switch (kind) {
    case "coder":
      primaryLabel = "Approve & Spawn";
      primaryIcon = icons.bot ?? icons.zap ?? nothing;
      primaryFire = () => void spawnCoderFromInsight(host, client, insight);
      primaryAria = `Approve and spawn a coder for: ${insight.title}`;
      break;
    case "email":
      primaryLabel = "Draft reply";
      primaryIcon =
        (icons as any).mail ?? (icons as any).messageSquare ?? icons.arrowRight ?? nothing;
      primaryFire = () => toggleInsightDraft(host, insight.id);
      primaryAria = `Draft a reply for: ${insight.title}`;
      break;
    case "schedule":
      primaryLabel = "Schedule";
      primaryIcon = (icons as any).clock ?? icons.target ?? nothing;
      primaryFire = () => navigate(insight.actionTab ?? "schedule");
      primaryAria = `Schedule: ${insight.title}`;
      break;
    case "open":
      primaryLabel = "Open";
      primaryIcon = (icons as any).externalLink ?? icons.arrowRight ?? nothing;
      primaryFire = () => navigate(insight.actionTab ?? "activity");
      primaryAria = `Open: ${insight.title}`;
      break;
    case "generic":
      primaryLabel = insight.action ?? "Act on this";
      primaryIcon = icons.arrowRight ?? nothing;
      primaryFire = () => navigate(insight.actionTab ?? "autonomy");
      primaryAria = `${insight.action ?? "Act on this"}: ${insight.title}`;
      break;
    case "none":
    default:
      primaryLabel = null;
  }

  const draft = insightDraft(insight.id);

  // Keyboard (AC6): Enter = primary act / complete, S = snooze, D = dismiss.
  const onCardKeydown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLTextAreaElement) return;
    const k = e.key.toLowerCase();
    if (e.key === "Enter") {
      e.preventDefault();
      if (primaryFire && !ui.loading) primaryFire();
      else if (!ui.loading) void completeDashInsight(host, client, insight);
    } else if (k === "s") {
      e.preventDefault();
      snoozeDashInsight(host, insight.id);
    } else if (k === "d") {
      e.preventDefault();
      dismissDashInsight(host, insight.id);
    }
  };

  return html`
    <li
      class="dash-insight dash-tone-${tone}"
      tabindex="0"
      role="group"
      aria-label=${insight.title}
      @keydown=${onCardKeydown}
    >
      <span class="dash-insight-icon">${iconEl}</span>
      <div class="dash-insight-body">
        <span class="dash-insight-title">${insight.title}</span>
        <span class="dash-insight-desc">${insight.description}</span>
        ${
          ui.error ? html`<span class="dash-action-error" role="alert">${ui.error}</span>` : nothing
        }
        ${
          draft.open
            ? html`
              <div class="dash-insight-draft" @click=${(e: Event) => e.stopPropagation()}>
                <textarea
                  class="dash-draft-input"
                  rows="3"
                  placeholder="Your intent for the reply — a coder will draft &amp; send it…"
                  .value=${draft.text}
                  ?disabled=${draft.sending}
                  @input=${(e: Event) => {
                    draft.text = (e.target as HTMLTextAreaElement).value;
                  }}
                ></textarea>
                <div class="dash-draft-actions">
                  <button
                    class="dash-cta dash-cta-ok"
                    ?disabled=${draft.sending || !draft.text.trim()}
                    @click=${() => void sendInsightDraft(host, client, insight)}
                  >
                    ${
                      draft.sending
                        ? html`
                            <span class="dash-btn-spinner" aria-hidden="true"></span>
                          `
                        : ((icons as any).send ?? icons.arrowRight ?? nothing)
                    }
                    <span>${draft.sending ? "Sending…" : "Send draft"}</span>
                  </button>
                  <button
                    class="dash-cta dash-cta-ghost"
                    ?disabled=${draft.sending}
                    @click=${() => toggleInsightDraft(host, insight.id)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            `
            : nothing
        }
      </div>
      <div class="dash-insight-actions" @click=${(e: Event) => e.stopPropagation()}>
        ${
          primaryLabel
            ? html`
              <button
                class="dash-insight-action"
                ?disabled=${ui.loading}
                aria-busy=${ui.loading ? "true" : "false"}
                aria-label=${primaryAria}
                title=${primaryLabel}
                @click=${() => primaryFire && primaryFire()}
              >
                ${
                  ui.loading
                    ? html`
                        <span class="dash-btn-spinner" aria-hidden="true"></span>
                      `
                    : primaryIcon
                }
                <span>${ui.loading ? "Working…" : primaryLabel}</span>
              </button>
            `
            : html`
                <span class="dash-insight-badge">FYI</span>
              `
        }
        <button
          class="dash-icon-btn"
          aria-label=${`Mark complete: ${insight.title}`}
          title="Mark complete"
          ?disabled=${ui.loading}
          @click=${() => void completeDashInsight(host, client, insight)}
        >${icons.checkCircle ?? nothing}</button>
        <button
          class="dash-icon-btn"
          aria-label=${`Snooze suggestion: ${insight.title}`}
          title="Snooze for 4 hours"
          @click=${() => snoozeDashInsight(host, insight.id)}
        >${(icons as any).clock ?? nothing}</button>
        ${
          insight.actionTab && kind !== "open"
            ? html`
              <button
                class="dash-icon-btn"
                aria-label=${`Open: ${insight.title}`}
                title="Open"
                @click=${() => navigate(insight.actionTab ?? "activity")}
              >${(icons as any).externalLink ?? icons.arrowRight ?? nothing}</button>
            `
            : nothing
        }
        <button
          class="dash-icon-btn"
          aria-label=${`Dismiss suggestion: ${insight.title}`}
          title="Dismiss"
          @click=${() => dismissDashInsight(host, insight.id)}
        >${icons.x}</button>
      </div>
    </li>
  `;
}

// ── Live Pulse card (running agents) ─────────────────────────

function renderPulseCard(ds: DashboardState, navigate: (tab: string) => void): TemplateResult {
  return html`
    <section class="dash-card dash-card-lg">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-ok dash-pulse">${icons.activity ?? nothing}</span>
          <span>Live Pulse</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("activity")}>
          Full activity ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body">
        ${
          ds.runningAgents.length === 0
            ? html`
              <div class="dash-empty-row">
                <span class="dash-empty-icon">${icons.bot ?? nothing}</span>
                <span>No agents running right now. Idle fleet, ready to deploy.</span>
                <button class="dash-mini-cta" @click=${() => navigate("chat")}>
                  Spawn one ${icons.arrowRight ?? nothing}
                </button>
              </div>
            `
            : html`
              <ul class="dash-pulse-list">
                ${ds.runningAgents.map(renderRunningAgent)}
              </ul>
            `
        }
      </div>
    </section>
  `;
}

function renderRunningAgent(run: DashRunningAgent): TemplateResult {
  const pct = typeof run.progress === "number" ? Math.max(0, Math.min(100, run.progress)) : null;
  // Tone status pill by status keyword so blocked/error visually screams.
  const lc = (run.status || "").toLowerCase();
  const statusTone = /error|fail/.test(lc)
    ? "danger"
    : /block|wait/.test(lc)
      ? "warn"
      : /idle|stop/.test(lc)
        ? "muted"
        : "ok";
  const openFocus = (e: Event) => {
    e.stopPropagation();
    const w = window as unknown as { openAgentFocus?: (t: unknown) => void };
    if (typeof w.openAgentFocus === "function") {
      w.openAgentFocus({
        runId: run.runId,
        sessionKey: run.sessionKey || undefined,
        label: run.label,
        status: run.status,
        progress: run.progress,
        task: run.task,
      });
    } else {
      window.dispatchEvent(
        new CustomEvent("infinibot:open-agent-focus", {
          detail: { runId: run.runId, sessionKey: run.sessionKey || undefined },
        }),
      );
    }
  };
  const stop = (label: string) => (e: Event) => {
    e.stopPropagation();
    window.dispatchEvent(
      new CustomEvent("infinibot:agent-action", { detail: { runId: run.runId, intent: label } }),
    );
  };
  return html`
    <li class="dash-run-row dash-run-tone-${statusTone}" @click=${openFocus}>
      <div class="dash-run-head">
        <span class="dash-run-dot dash-run-dot-anim"></span>
        <span class="dash-run-label">${run.label}</span>
        <span class="dash-run-status">${run.status || "running"}</span>
        <span class="dash-run-time">${formatDuration(run.durationMs)}</span>
      </div>
      <span class="dash-run-task">${run.task || "(no task description)"}</span>
      ${
        pct !== null
          ? html`
            <div class="dash-progress dash-progress-anim">
              <div class="dash-progress-bar">
                <div class="dash-progress-fill" style="width:${pct}%"></div>
                <div class="dash-progress-shimmer"></div>
              </div>
              <span class="dash-progress-text">${pct}%</span>
            </div>
          `
          : html`
              <div class="dash-progress dash-progress-indeterminate">
                <div class="dash-progress-bar"><div class="dash-progress-fill-indet"></div></div>
                <span class="dash-progress-text">working…</span>
              </div>
            `
      }
      <div class="dash-run-actions" @click=${(e: Event) => e.stopPropagation()}>
        <button class="dash-cta" @click=${openFocus} title="Open detailed focus modal">
          ${icons.eye ?? icons.zap ?? nothing} <span>Focus</span>
        </button>
        <button class="dash-cta" @click=${stop("pause")} title="Pause this agent">
          ${icons.pause ?? nothing} <span>Pause</span>
        </button>
        <button class="dash-cta" @click=${stop("intervene")} title="Intervene / redirect">
          ${icons.target ?? nothing} <span>Intervene</span>
        </button>
      </div>
    </li>
  `;
}

// ── Priority Queue card ──────────────────────────────────────

function renderPriorityCard<T extends DashboardHost>(
  host: T,
  ds: DashboardState,
  client: GatewayBrowserClient,
  navigate: (tab: string, options?: DashboardNavigateOptions) => void,
): TemplateResult {
  return html`
    <section class="dash-card dash-card-lg">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-warn">${icons.target ?? nothing}</span>
          <span>Priority Queue</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("projects")}>
          Open board ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body">
        ${
          ds.priorityTasks.length === 0
            ? html`
              <div class="dash-empty-row">
                <span class="dash-empty-icon">${icons.checkCircle ?? nothing}</span>
                <span>Queue is clear. Add a task or set a goal to keep things moving.</span>
              </div>
            `
            : html`
              <ul class="dash-task-list">
                ${ds.priorityTasks.map((t) => renderPriorityTask(host, client, t, navigate))}
              </ul>
            `
        }
      </div>
    </section>
  `;
}

function renderPriorityTask<T extends DashboardHost>(
  host: T,
  client: GatewayBrowserClient,
  task: DashPriorityTask,
  navigate: (tab: string, options?: DashboardNavigateOptions) => void,
): TemplateResult {
  const tone = task.blocked
    ? "danger"
    : task.priority === "high" || task.priority === "urgent"
      ? "warn"
      : "primary";
  const ui = taskUi(task.id);
  const open = () => navigate("projects", { projectId: task.projectId, taskId: task.id });
  const complete = () => void completePriorityTask(host, client, task);
  // Keyboard: Enter on the focused row fires the PRIMARY forward action
  // (mark complete). Click on the row keeps the existing open behavior.
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    if (e.target instanceof HTMLButtonElement) return;
    e.preventDefault();
    if (!ui.loading && !ui.done) complete();
  };
  return html`
    <li
      class="dash-task dash-tone-${tone}"
      tabindex="0"
      role="group"
      aria-label=${task.title}
      @click=${open}
      @keydown=${onKeydown}
    >
      <span class="dash-task-pri">
        ${task.blocked ? "BLOCKED" : task.priority.toUpperCase()}
      </span>
      <div class="dash-task-body">
        <span class="dash-task-title">${task.title}</span>
        <span class="dash-task-meta">
          ${task.projectName}
          <span class="dash-task-sep">·</span>
          ${task.updatedAt ? timeAgo(task.updatedAt) : "—"}
        </span>
        ${
          ui.error ? html`<span class="dash-action-error" role="alert">${ui.error}</span>` : nothing
        }
      </div>
      <div class="dash-task-actions" @click=${(e: Event) => e.stopPropagation()}>
        <button
          class="dash-cta dash-cta-ok"
          ?disabled=${ui.loading || ui.done}
          aria-busy=${ui.loading ? "true" : "false"}
          aria-label=${`Mark task complete: ${task.title}`}
          title="Mark complete"
          @click=${complete}
        >
          ${
            ui.loading
              ? html`
                  <span class="dash-btn-spinner" aria-hidden="true"></span>
                `
              : (icons.checkCircle ?? nothing)
          }
          <span>${ui.done ? "Completed" : ui.loading ? "Saving…" : "Mark complete"}</span>
        </button>
      </div>
      <span class="dash-task-arrow">${icons.arrowRight ?? nothing}</span>
    </li>
  `;
}

// ── Suggested projects card ──────────────────────────────────
//
// Forward-moving project suggestions sourced from real signals (clients in
// progress with no project, ungrouped tasks, backend create-project insights).
// Each card has Create project / Open details / Dismiss. On successful create
// the card flips to a confirmation with a deep-link into the new project.

function renderSuggestedProjectsCard<T extends DashboardHost>(
  host: T,
  ds: DashboardState,
  navigate: (tab: string, options?: DashboardNavigateOptions) => void,
): TemplateResult {
  return html`
    <section class="dash-card dash-card-lg dash-suggested-projects">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-primary">${(icons as any).folderPlus ?? icons.layout ?? icons.sparkles ?? nothing}</span>
          <span>Suggested projects</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("projects")}>
          All projects ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body">
        ${
          ds.suggestedProjects.length === 0
            ? html`
              <div class="dash-empty-row">
                <span class="dash-empty-icon">${icons.checkCircle ?? nothing}</span>
                <span>No project suggestions right now. They appear when work needs a home.</span>
              </div>
            `
            : html`
              <div class="dash-sugproj-grid">
                ${ds.suggestedProjects.map((sp) => renderSuggestedProjectCard(host, sp, navigate))}
              </div>
            `
        }
      </div>
    </section>
  `;
}

function renderSuggestedProjectCard<T extends DashboardHost>(
  host: T,
  sp: DashSuggestedProject,
  navigate: (tab: string, options?: DashboardNavigateOptions) => void,
): TemplateResult {
  const ui = projectUi(sp.id);

  // After a successful create, replace the card with a confirmation + link.
  if (ui.created) {
    return html`
      <div class="dash-sugproj-card glass-panel hud-frame dash-sugproj-done">
        <div class="dash-sugproj-confirm">
          <span class="dash-sugproj-check">${icons.checkCircle ?? nothing}</span>
          <div>
            <strong>Project created</strong>
            <span>${ui.created.name}</span>
          </div>
        </div>
        <button
          class="dash-cta dash-cta-primary"
          aria-label=${`Open project ${ui.created.name}`}
          @click=${() => navigate("projects", ui.created?.id ? { projectId: ui.created.id } : {})}
        >
          ${icons.arrowRight ?? nothing} <span>Open project</span>
        </button>
      </div>
    `;
  }

  const create = () => void createSuggestedProject(host, sp);
  const openDetails = () => {
    if (sp.clientId) navigate("clients", { clientId: sp.clientId });
    else navigate("projects");
  };
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    if (e.target instanceof HTMLButtonElement) return;
    e.preventDefault();
    if (!ui.loading) create();
  };

  return html`
    <div
      class="dash-sugproj-card glass-panel hud-frame"
      tabindex="0"
      role="group"
      aria-label=${`Suggested project: ${sp.name}`}
      @keydown=${onKeydown}
    >
      <div class="dash-sugproj-head">
        <strong class="dash-sugproj-name">${sp.name}</strong>
        <button
          class="dash-icon-btn"
          aria-label=${`Dismiss suggested project: ${sp.name}`}
          title="Dismiss"
          @click=${() => dismissDashInsight(host, sp.id)}
        >${icons.x}</button>
      </div>
      <span class="dash-sugproj-rationale">${sp.rationale}</span>
      ${sp.description ? html`<span class="dash-sugproj-desc">${sp.description}</span>` : nothing}
      ${ui.error ? html`<span class="dash-action-error" role="alert">${ui.error}</span>` : nothing}
      <div class="dash-sugproj-actions">
        <button
          class="dash-cta dash-cta-primary"
          ?disabled=${ui.loading}
          aria-busy=${ui.loading ? "true" : "false"}
          aria-label=${`Create project: ${sp.name}`}
          title="Create project"
          @click=${create}
        >
          ${
            ui.loading
              ? html`
                  <span class="dash-btn-spinner" aria-hidden="true"></span>
                `
              : ((icons as any).folderPlus ?? icons.layout ?? nothing)
          }
          <span>${ui.loading ? "Creating…" : "Create project"}</span>
        </button>
        <button
          class="dash-cta"
          aria-label=${`Open details for: ${sp.name}`}
          title="Open details"
          @click=${openDetails}
        >
          ${icons.eye ?? icons.arrowRight ?? nothing} <span>Open details</span>
        </button>
      </div>
    </div>
  `;
}

// ── Recently shipped card ────────────────────────────────────

function renderShippedCard(ds: DashboardState, navigate: (tab: string) => void): TemplateResult {
  return html`
    <section class="dash-card dash-card-lg">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-ok">${icons.checkCircle ?? nothing}</span>
          <span>Recently Shipped</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("activity")}>
          History ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body">
        ${
          ds.recentDone.length === 0
            ? html`
              <div class="dash-empty-row">
                <span class="dash-empty-icon">${icons.zap ?? nothing}</span>
                <span>First completion of the day lands here. Keep shipping.</span>
              </div>
            `
            : html`
              <ul class="dash-done-list">
                ${ds.recentDone.map(renderCompletedRow)}
              </ul>
            `
        }
      </div>
    </section>
  `;
}

function renderCompletedRow(entry: DashCompletedEntry): TemplateResult {
  const tone = entry.status === "error" ? "danger" : "ok";
  return html`
    <li class="dash-done dash-tone-${tone}">
      <span class="dash-done-check">${icons.checkCircle ?? nothing}</span>
      <div class="dash-done-body">
        <span class="dash-done-title">${entry.title}</span>
        <span class="dash-done-meta">
          ${entry.projectName}
          <span class="dash-task-sep">·</span>
          ${formatDuration(entry.durationMs)}
        </span>
      </div>
      <span class="dash-done-time">${timeAgo(entry.completedAt)}</span>
    </li>
  `;
}

// ── Learning band (condensed) ────────────────────────────────

function renderLearningBand(ds: DashboardState, navigate: (tab: string) => void): TemplateResult {
  // Hide entirely if there's no learning signal and there's no empty-state
  // value to show — the ops surface above is enough.
  if (ds.learningPath.length === 0 && ds.enrolledCourses.length === 0 && !ds.isEmpty) {
    return html`

    `;
  }
  return html`
    <section class="dash-learn">
      <header class="dash-learn-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-primary">${icons.book ?? nothing}</span>
          <span>Continue Learning</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("learn")}>
          Learn page ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-learn-grid">
        ${
          ds.currentTrack
            ? renderContinueCard(ds.currentTrack, ds.currentStepTitle)
            : html`
                <div class="dash-card dash-card-empty">
                  Pick a track to get rolling. Recommended paths are tailored to where you are.
                </div>
              `
        }
        ${ds.enrolledCourses.slice(0, 3).map(renderCourseCard)}
      </div>
    </section>
  `;
}

function renderContinueCard(track: TrackSummary, stepTitle: string): TemplateResult {
  const pct = track.percent ?? 0;
  return html`
    <div class="dash-card dash-continue">
      <div class="dash-continue-head">
        <h3>${track.title}</h3>
        <span class="dash-pill">${track.category ?? "Track"}</span>
      </div>
      <p class="dash-continue-desc">${track.description}</p>
      <div class="dash-continue-step">
        <span class="dash-step-label">Up next:</span>
        <span class="dash-step-name">${stepTitle || track.steps?.[0]?.title || "Getting started"}</span>
      </div>
      <div class="dash-progress">
        <div class="dash-progress-bar">
          <div class="dash-progress-fill" style="width:${pct}%"></div>
        </div>
        <span class="dash-progress-text">
          ${track.completedCount ?? 0}/${track.totalSteps ?? track.steps.length}
        </span>
      </div>
    </div>
  `;
}

function renderCourseCard(course: EnrolledCourse): TemplateResult {
  return html`
    <div class="dash-card dash-course">
      ${
        course.coverImage
          ? html`<div class="dash-course-cover" style="background-image:url(${course.coverImage})"></div>`
          : html`<div class="dash-course-cover dash-course-cover-empty">${icons.book ?? nothing}</div>`
      }
      <div class="dash-course-body">
        <div class="dash-course-head">
          <h3>${course.title}</h3>
          <span class="dash-pill">${course.tier}</span>
        </div>
        <p class="dash-course-desc">${course.description}</p>
        <div class="dash-progress">
          <div class="dash-progress-bar">
            <div class="dash-progress-fill" style="width:${course.progress}%"></div>
          </div>
          <span class="dash-progress-text">
            ${course.completedLessons}/${course.totalLessons}
          </span>
        </div>
      </div>
    </div>
  `;
}

// ── Agent Roster card ────────────────────────────────────────

function renderRosterCard(
  roster: DashAgentRoster[],
  navigate: (tab: string) => void,
): TemplateResult {
  return html`
    <section class="dash-card dash-card-lg">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-primary">${icons.bot ?? nothing}</span>
          <span>Agent Roster</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("agents")}>
          Manage ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body">
        ${
          roster.length === 0
            ? html`
              <div class="dash-empty-row">
                <span class="dash-empty-icon">${icons.bot ?? nothing}</span>
                <span>No agents registered. Create one to start delegating.</span>
              </div>
            `
            : html`
              <ul class="dash-roster">
                ${roster.map(renderRosterRow)}
              </ul>
            `
        }
      </div>
    </section>
  `;
}

function renderRosterRow(agent: DashAgentRoster): TemplateResult {
  const tone = agent.successPct >= 80 ? "ok" : agent.successPct >= 50 ? "warn" : "danger";
  return html`
    <li class="dash-roster-row dash-tone-${tone}">
      <div class="dash-roster-avatar">
        <span class="dash-roster-initials">
          ${agent.name.slice(0, 2).toUpperCase()}
        </span>
        ${
          agent.active
            ? html`
                <span class="dash-roster-online"></span>
              `
            : nothing
        }
      </div>
      <div class="dash-roster-body">
        <span class="dash-roster-name">${agent.name}</span>
        <span class="dash-roster-meta">
          ${agent.backend}
          <span class="dash-task-sep">·</span>
          ${agent.runsRecent} run${agent.runsRecent === 1 ? "" : "s"}
        </span>
      </div>
      <div class="dash-roster-score">
        <span class="dash-roster-pct">${agent.successPct}%</span>
        <div class="dash-mini-bar">
          <div
            class="dash-mini-bar-fill"
            style="width:${agent.successPct}%;background:var(--tone)"
          ></div>
        </div>
      </div>
    </li>
  `;
}

// ── Project Velocity (donut) ─────────────────────────────────

function renderVelocityCard(
  velocity: DashProjectVelocity[],
  navigate: (tab: string) => void,
): TemplateResult {
  const total = velocity.reduce((s, v) => s + v.count, 0);
  return html`
    <section class="dash-card dash-card-lg">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-info">${icons.barChart ?? nothing}</span>
          <span>Project Velocity</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("projects")}>
          All projects ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body dash-velocity-body">
        ${
          velocity.length === 0
            ? html`
              <div class="dash-empty-row">
                <span class="dash-empty-icon">${icons.barChart ?? nothing}</span>
                <span>No completions yet. Ship one to start the chart.</span>
              </div>
            `
            : html`
              <div class="dash-velocity-chart">
                ${renderDonut(
                  velocity.map((v) => ({
                    label: v.projectName,
                    value: v.count,
                    color: v.color,
                  })),
                  { size: 140, thickness: 16, centerValue: String(total), centerLabel: "shipped" },
                )}
              </div>
              <ul class="dash-velocity-legend">
                ${velocity.map(
                  (v) => html`
                    <li class="dash-velocity-row">
                      <span class="dash-velocity-dot" style="background:${v.color}"></span>
                      <span class="dash-velocity-name">${v.projectName}</span>
                      <span class="dash-velocity-count">${v.count}</span>
                    </li>
                  `,
                )}
              </ul>
            `
        }
      </div>
    </section>
  `;
}

// ── System Health (gauges) ───────────────────────────────────

function renderHealthCard(
  health: DashSystemHealth,
  navigate: (tab: string) => void,
): TemplateResult {
  return html`
    <section class="dash-card dash-card-lg">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-ok">${(icons as any).cpu ?? icons.activity ?? nothing}</span>
          <span>System Health</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("hardware")}>
          Details ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body dash-health-body">
        <div class="dash-health-gauges">
          <div class="dash-health-gauge">${renderGauge(health.cpu, { label: "CPU" })}</div>
          <div class="dash-health-gauge">${renderGauge(health.memory, { label: "Memory" })}</div>
          <div class="dash-health-gauge">
            ${renderGauge(health.agentLoad, { label: "Agent Load", color: "#38bdf8" })}
          </div>
        </div>
        <div class="dash-health-foot">
          <span class="dash-health-pill ${health.nodesOnline === health.nodesTotal ? "ok" : "warn"}">
            ${icons.activity ?? nothing}
            ${health.nodesOnline}/${health.nodesTotal} nodes online
          </span>
        </div>
      </div>
    </section>
  `;
}

// ── Workflows card ───────────────────────────────────────────

function renderWorkflowsCard(
  workflows: DashWorkflow[],
  navigate: (tab: string) => void,
): TemplateResult {
  return html`
    <section class="dash-card dash-card-lg">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-info">${icons.zap ?? nothing}</span>
          <span>Workflows</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("workflows")}>
          Manage ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body">
        ${
          workflows.length === 0
            ? html`
              <div class="dash-empty-row">
                <span class="dash-empty-icon">${icons.zap ?? nothing}</span>
                <span>No workflows yet. Build one to automate routines.</span>
              </div>
            `
            : html`
              <ul class="dash-wf-list">
                ${workflows.map(renderWorkflowRow)}
              </ul>
            `
        }
      </div>
    </section>
  `;
}

function renderWorkflowRow(wf: DashWorkflow): TemplateResult {
  const tone =
    wf.status === "running"
      ? "ok"
      : wf.status === "error"
        ? "danger"
        : wf.status === "paused"
          ? "warn"
          : "neutral";
  return html`
    <li class="dash-wf dash-tone-${tone}">
      <span class="dash-wf-status"></span>
      <div class="dash-wf-body">
        <span class="dash-wf-name">${wf.name}</span>
        <span class="dash-wf-meta">
          ${wf.kind ?? "manual"}
          <span class="dash-task-sep">·</span>
          ${wf.status}
          ${
            wf.lastRunAt
              ? html`<span class="dash-task-sep">·</span>${timeAgo(wf.lastRunAt)}`
              : nothing
          }
        </span>
      </div>
    </li>
  `;
}

// ── Cron card ────────────────────────────────────────────────

function renderCronCard(jobs: DashCronJob[], navigate: (tab: string) => void): TemplateResult {
  return html`
    <section class="dash-card dash-card-lg">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-warn">${(icons as any).clock ?? icons.target ?? nothing}</span>
          <span>Scheduled</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("schedule")}>
          Cron jobs ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body">
        ${
          jobs.length === 0
            ? html`
              <div class="dash-empty-row">
                <span class="dash-empty-icon">${icons.target ?? nothing}</span>
                <span>No scheduled jobs. Add a cron to run agents on a beat.</span>
              </div>
            `
            : html`
              <ul class="dash-cron-list">
                ${jobs.map(renderCronRow)}
              </ul>
            `
        }
      </div>
    </section>
  `;
}

function renderCronRow(job: DashCronJob): TemplateResult {
  const tone = job.enabled ? "primary" : "neutral";
  return html`
    <li class="dash-cron dash-tone-${tone}">
      <span class="dash-cron-spec">${job.schedule || "—"}</span>
      <div class="dash-cron-body">
        <span class="dash-cron-name">${job.label}</span>
        <span class="dash-cron-meta">
          ${job.enabled ? "active" : "paused"}
          ${
            job.nextRunAt
              ? html`<span class="dash-task-sep">·</span>next ${timeUntil(job.nextRunAt)}`
              : nothing
          }
        </span>
      </div>
    </li>
  `;
}

// ── Notes / knowledge card ───────────────────────────────────

function renderNotesCard(notes: DashNote[], navigate: (tab: string) => void): TemplateResult {
  return html`
    <section class="dash-card dash-card-lg">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-primary">${icons.book ?? nothing}</span>
          <span>Knowledge</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("notes")}>
          Notes ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body">
        ${
          notes.length === 0
            ? html`
              <div class="dash-empty-row">
                <span class="dash-empty-icon">${icons.book ?? nothing}</span>
                <span>Capture a thought to start a knowledge base.</span>
              </div>
            `
            : html`
              <ul class="dash-notes-list">
                ${notes.map(renderNoteRow)}
              </ul>
            `
        }
      </div>
    </section>
  `;
}

function renderNoteRow(note: DashNote): TemplateResult {
  return html`
    <li class="dash-note">
      <span class="dash-note-tick"></span>
      <div class="dash-note-body">
        <span class="dash-note-title">${note.title}</span>
        <span class="dash-note-preview">${note.preview || "(empty)"}</span>
      </div>
      <span class="dash-note-time">${note.updatedAt ? timeAgo(note.updatedAt) : "—"}</span>
    </li>
  `;
}

// ── Revenue card ─────────────────────────────────────────────

function renderRevenueCard(rev: DashRevenue, navigate: (tab: string) => void): TemplateResult {
  const isLive = rev.allTime > 0 || rev.year > 0 || rev.daily30.some((v) => v > 0);
  return html`
    <section class="dash-card dash-card-lg">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-ok">${icons.zap ?? nothing}</span>
          <span>Revenue</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("business")}>
          Income ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body dash-rev-body">
        ${
          !isLive
            ? html`
              <div class="dash-empty-row">
                <span class="dash-empty-icon">${icons.zap ?? nothing}</span>
                <span>Log a sale or connect Stripe/Whop to start the curve.</span>
              </div>
            `
            : html`
              <div class="dash-rev-totals">
                <div class="dash-rev-cell">
                  <span class="dash-rev-cell-label">Today</span>
                  <span class="dash-rev-cell-value">${rev.currency}${formatMoney(rev.today)}</span>
                </div>
                <div class="dash-rev-cell">
                  <span class="dash-rev-cell-label">Week</span>
                  <span class="dash-rev-cell-value">${rev.currency}${formatMoney(rev.week)}</span>
                </div>
                <div class="dash-rev-cell">
                  <span class="dash-rev-cell-label">Month</span>
                  <span class="dash-rev-cell-value">${rev.currency}${formatMoney(rev.month)}</span>
                </div>
                <div class="dash-rev-cell">
                  <span class="dash-rev-cell-label">Year</span>
                  <span class="dash-rev-cell-value">${rev.currency}${formatMoney(rev.year)}</span>
                </div>
                <div class="dash-rev-cell dash-rev-cell-total">
                  <span class="dash-rev-cell-label">All-Time</span>
                  <span class="dash-rev-cell-value">${rev.currency}${formatMoney(rev.allTime)}</span>
                </div>
              </div>
              <div class="dash-rev-chart">
                ${renderHourlyBars(rev.daily30, {
                  height: 70,
                  color: "#22c55e",
                  labelEvery: 7,
                })}
                <span class="dash-rev-chart-cap">Last 30 days</span>
              </div>
              ${
                rev.topStreams.length > 0
                  ? html`
                    <ul class="dash-rev-streams">
                      ${rev.topStreams.map(
                        (s) => html`
                          <li class="dash-rev-stream">
                            <span class="dash-rev-stream-name">${s.label}</span>
                            <span class="dash-rev-stream-amt">${rev.currency}${formatMoney(s.amount)}</span>
                          </li>
                        `,
                      )}
                    </ul>
                  `
                  : nothing
              }
            `
        }
      </div>
    </section>
  `;
}

// ── Discipline card ──────────────────────────────────────────

function renderDisciplineCard(d: DashDiscipline, navigate: (tab: string) => void): TemplateResult {
  const tone = d.todayScore >= 80 ? "ok" : d.todayScore >= 50 ? "warn" : "danger";
  return html`
    <section class="dash-card dash-card-lg">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-${tone}">${icons.target ?? nothing}</span>
          <span>Discipline · today</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("discipline")}>
          Blocks ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body dash-disc-body">
        ${
          d.blocks.length === 0
            ? html`
              <div class="dash-empty-row">
                <span class="dash-empty-icon">${icons.target ?? nothing}</span>
                <span>No blocks scheduled. Define your day in /discipline.</span>
              </div>
            `
            : html`
              <div class="dash-disc-score-row">
                <div class="dash-disc-score dash-tone-${tone}">
                  <span class="dash-disc-score-value">${d.todayScore}</span>
                  <span class="dash-disc-score-label">score</span>
                </div>
                <div class="dash-disc-week">
                  ${d.weekScores.map(
                    (s, i) => html`
                      <div
                        class="dash-disc-week-bar ${i === d.weekScores.length - 1 ? "today" : ""}"
                        style="height:${Math.max(6, s)}%"
                        title="Day ${i + 1}: ${s}"
                      ></div>
                    `,
                  )}
                </div>
              </div>
              ${
                d.currentBlockLabel
                  ? html`
                    <div class="dash-disc-now">
                      <span class="dash-disc-now-dot"></span>
                      <span>${d.currentBlockLabel}</span>
                    </div>
                  `
                  : nothing
              }
              <div class="dash-disc-timeline">
                ${renderDayTimeline(d)}
              </div>
              <ul class="dash-disc-list">
                ${d.blocks.slice(0, 4).map(renderBlockRow)}
              </ul>
            `
        }
      </div>
    </section>
  `;
}

function renderDayTimeline(d: DashDiscipline): TemplateResult {
  // Single horizontal day with each block drawn as a segment, plus a "now"
  // cursor line. Width-relative (% of 24h).
  return html`
    <div class="dash-disc-day">
      ${d.blocks.map((b) => {
        const left = (b.startMinute / 1440) * 100;
        const width = Math.max(1, ((b.endMinute - b.startMinute) / 1440) * 100);
        return html`
          <div
            class="dash-disc-day-block ${b.done ? "done" : ""} ${b.active ? "active" : ""}"
            style="left:${left}%;width:${width}%"
            title="${b.label} (${b.done ? "done" : b.active ? "now" : "pending"})"
          ></div>
        `;
      })}
      <div class="dash-disc-day-cursor" style="left:${(d.nowMinute / 1440) * 100}%"></div>
    </div>
  `;
}

function renderBlockRow(b: {
  id: string;
  label: string;
  startMinute: number;
  endMinute: number;
  done: boolean;
  active: boolean;
}): TemplateResult {
  return html`
    <li class="dash-disc-block ${b.done ? "done" : ""} ${b.active ? "active" : ""}">
      <span class="dash-disc-block-tick"></span>
      <span class="dash-disc-block-time">
        ${formatBlockTimeShort(b.startMinute)}–${formatBlockTimeShort(b.endMinute)}
      </span>
      <span class="dash-disc-block-label">${b.label}</span>
    </li>
  `;
}

function formatBlockTimeShort(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}:${m.toString().padStart(2, "0")}`;
}

// ── Pipeline card ────────────────────────────────────────────

function renderPipelineCard(
  p: DashPipeline,
  navigate: (tab: string, options?: DashboardNavigateOptions) => void,
): TemplateResult {
  return html`
    <section class="dash-card dash-card-lg">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-info">${(icons as any).users ?? icons.bot ?? nothing}</span>
          <span>Client Pipeline</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("clients")}>
          CRM ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body dash-pipe-body">
        ${
          p.total === 0
            ? html`
              <div class="dash-empty-row">
                <span class="dash-empty-icon">${icons.bot ?? nothing}</span>
                <span>No clients yet. Add one to start your pipeline.</span>
              </div>
            `
            : html`
              <div class="dash-pipe-chart">
                ${renderDonut(
                  p.stages.map((s) => ({ label: s.stage, value: s.count, color: s.color })),
                  {
                    size: 120,
                    thickness: 14,
                    centerValue: String(p.total),
                    centerLabel: "clients",
                  },
                )}
              </div>
              <ul class="dash-pipe-stages">
                ${p.stages.slice(0, 4).map(
                  (s) => html`
                    <li class="dash-pipe-stage">
                      <span class="dash-pipe-dot" style="background:${s.color}"></span>
                      <span class="dash-pipe-stage-name">${s.stage}</span>
                      <span class="dash-pipe-stage-count">${s.count}</span>
                    </li>
                  `,
                )}
              </ul>
              ${
                p.topClients.length > 0
                  ? html`
                    <div class="dash-pipe-hot-head">Top to follow up</div>
                    <ul class="dash-pipe-hot">
                      ${p.topClients.slice(0, 3).map(
                        (c) => html`
                          <li
                            class="dash-pipe-client dash-pipe-hot-${c.hot}"
                            @click=${() => navigate("clients", { clientId: c.id })}
                          >
                            <span class="dash-pipe-client-flame">${c.hot === 0 ? icons.flame : c.hot === 1 ? "•" : "·"}</span>
                            <span class="dash-pipe-client-name">${c.name}</span>
                            <span class="dash-pipe-client-stage">${c.stage}</span>
                          </li>
                        `,
                      )}
                    </ul>
                  `
                  : nothing
              }
            `
        }
      </div>
    </section>
  `;
}

// ── Focus & Priorities card ──────────────────────────────────

function renderFocusCard<T extends DashboardHost>(
  host: T,
  ds: DashboardState,
  client: GatewayBrowserClient,
  navigate: (tab: string) => void,
): TemplateResult {
  const f = ds.focus;
  return html`
    <section class="dash-card dash-card-lg">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-primary">${icons.target ?? nothing}</span>
          <span>Focus &amp; Priorities</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("autonomy")}>
          Systems ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body dash-focus-body">
        ${
          f.priorities.length === 0
            ? html`
              <div class="dash-empty-row">
                <span class="dash-empty-icon">${icons.target ?? nothing}</span>
                <span>No priorities set. Define one to sharpen your focus.</span>
              </div>
            `
            : html`
              <div class="dash-focus-summary">
                <div class="dash-focus-ring">
                  ${renderGauge(f.avgProgress, { size: 72, thickness: 8, label: "avg" })}
                </div>
                <div class="dash-focus-stats">
                  <div class="dash-focus-stat">
                    <span class="dash-focus-stat-value">${f.activeCount}</span>
                    <span class="dash-focus-stat-label">active</span>
                  </div>
                  <div class="dash-focus-stat">
                    <span class="dash-focus-stat-value">${f.total}</span>
                    <span class="dash-focus-stat-label">total</span>
                  </div>
                  ${
                    f.focusTitle
                      ? html`
                        <div class="dash-focus-now">
                          <span class="dash-focus-now-label">#1 FOCUS</span>
                          <span class="dash-focus-now-title">${f.focusTitle}</span>
                        </div>
                      `
                      : nothing
                  }
                </div>
              </div>
              <ul class="dash-focus-list">
                ${f.priorities.map((p) => renderPriorityRow(host, client, p, navigate))}
              </ul>
            `
        }
      </div>
    </section>
  `;
}

function renderPriorityRow<T extends DashboardHost>(
  host: T,
  client: GatewayBrowserClient,
  p: DashFocusPriority,
  navigate: (tab: string) => void,
): TemplateResult {
  const tone = p.progress >= 70 ? "ok" : p.progress >= 35 ? "primary" : "warn";
  const ui = focusUi(p.id);
  const complete = () => void completeFocusPriority(host, client, p);
  const pin = () => void pinFocusPriority(host, client, p);
  const handoff = () => void handoffFocusPriority(host, client, p);
  const open = () => navigate("autonomy");
  // Keyboard (AC6): Enter = mark complete, P = pin, H = hand off.
  const onKeydown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLButtonElement) return;
    const k = e.key.toLowerCase();
    if (e.key === "Enter") {
      e.preventDefault();
      if (!ui.loading && !ui.done) complete();
    } else if (k === "p") {
      e.preventDefault();
      if (!ui.pinning) pin();
    } else if (k === "h") {
      e.preventDefault();
      if (!ui.handing) handoff();
    }
  };
  return html`
    <li
      class="dash-priority dash-tone-${tone} ${p.isFocus ? "is-focus" : ""}"
      tabindex="0"
      role="group"
      aria-label=${p.title}
      @keydown=${onKeydown}
    >
      <span class="dash-priority-rank">${p.isFocus ? icons.starFilled : "·"}</span>
      <div class="dash-priority-body">
        <div class="dash-priority-head">
          <span class="dash-priority-title">${p.title}</span>
          <span class="dash-priority-pct">${p.progress}%</span>
        </div>
        <div class="dash-mini-bar">
          <div
            class="dash-mini-bar-fill"
            style="width:${p.progress}%;background:var(--tone)"
          ></div>
        </div>
        ${p.nextStep ? html`<span class="dash-priority-next">Next: ${p.nextStep}</span>` : nothing}
        ${
          ui.error ? html`<span class="dash-action-error" role="alert">${ui.error}</span>` : nothing
        }
      </div>
      <div class="dash-priority-actions" @click=${(e: Event) => e.stopPropagation()}>
        <button
          class="dash-cta dash-cta-ok"
          ?disabled=${ui.loading || ui.done}
          aria-busy=${ui.loading ? "true" : "false"}
          aria-label=${`Mark priority complete: ${p.title}`}
          title="Mark complete"
          @click=${complete}
        >
          ${
            ui.loading
              ? html`
                  <span class="dash-btn-spinner" aria-hidden="true"></span>
                `
              : (icons.checkCircle ?? nothing)
          }
          <span>${ui.done ? "Completed" : ui.loading ? "Saving…" : "Complete"}</span>
        </button>
        <button
          class="dash-icon-btn ${p.isFocus ? "is-pinned" : ""}"
          ?disabled=${ui.pinning}
          aria-label=${p.isFocus ? `Unpin priority: ${p.title}` : `Pin priority: ${p.title}`}
          title=${p.isFocus ? "Unpin" : "Pin to top"}
          @click=${pin}
        >${
          ui.pinning
            ? html`
                <span class="dash-btn-spinner" aria-hidden="true"></span>
              `
            : p.isFocus
              ? icons.starFilled
              : icons.star
        }</button>
        <button
          class="dash-icon-btn"
          ?disabled=${ui.handing}
          aria-label=${`Hand off to agent: ${p.title}`}
          title="Hand off to agent"
          @click=${handoff}
        >${
          ui.handing
            ? html`
                <span class="dash-btn-spinner" aria-hidden="true"></span>
              `
            : ((icons as any).bot ?? "→")
        }</button>
        <button
          class="dash-icon-btn"
          aria-label=${`Open priority in Systems: ${p.title}`}
          title="Open in Systems"
          @click=${open}
        >${(icons as any).externalLink ?? icons.arrowRight ?? nothing}</button>
      </div>
    </li>
  `;
}

// ── Kanban lanes mini-board ──────────────────────────────────

function renderKanbanLanesCard(
  k: DashKanbanLanes,
  navigate: (tab: string, options?: DashboardNavigateOptions) => void,
): TemplateResult {
  const lanes: Array<{
    key: keyof DashKanbanLanes["lanes"];
    label: string;
    tone: string;
    count: number;
  }> = [
    { key: "todo", label: "To Do", tone: "neutral", count: k.counts.todo },
    { key: "inProgress", label: "In Progress", tone: "primary", count: k.counts.inProgress },
    { key: "blocked", label: "Blocked", tone: "danger", count: k.counts.blocked },
    { key: "doneToday", label: "Done Today", tone: "ok", count: k.counts.doneToday },
  ];
  return html`
    <section class="dash-card dash-card-lg">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-info">${(icons as any).layout ?? icons.bot ?? nothing}</span>
          <span>Kanban · today</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("projects")}>
          Open board ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body dash-lanes-body">
        <div class="dash-lanes">
          ${lanes.map(
            (lane) => html`
              <div class="dash-lane dash-tone-${lane.tone}">
                <div class="dash-lane-head">
                  <span class="dash-lane-label">${lane.label}</span>
                  <span class="dash-lane-count">${lane.count}</span>
                </div>
                ${
                  k.lanes[lane.key].length === 0
                    ? html`
                        <div class="dash-lane-empty">—</div>
                      `
                    : html`
                      <ul class="dash-lane-tasks">
                        ${k.lanes[lane.key].map(
                          (t) => html`
                            <li
                              class="dash-lane-task"
                              title="${t.title}"
                              @click=${() => navigate("projects", { projectId: t.projectId, taskId: t.id })}
                            >
                              <span class="dash-lane-task-dot"></span>
                              <div class="dash-lane-task-body">
                                <span class="dash-lane-task-title">${t.title}</span>
                                <span class="dash-lane-task-project">${t.project}</span>
                              </div>
                            </li>
                          `,
                        )}
                      </ul>
                    `
                }
              </div>
            `,
          )}
        </div>
      </div>
    </section>
  `;
}

// ── Projects in progress ─────────────────────────────────────

function renderProjectsInProgressCard(
  projects: DashProjectProgress[],
  navigate: (tab: string) => void,
): TemplateResult {
  return html`
    <section class="dash-card dash-card-lg">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-primary">${(icons as any).folder ?? icons.book ?? nothing}</span>
          <span>Projects · in motion</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("projects")}>
          All projects ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body">
        ${
          projects.length === 0
            ? html`
              <div class="dash-empty-row">
                <span class="dash-empty-icon">${icons.book ?? nothing}</span>
                <span>No active projects. Start one in the kanban.</span>
              </div>
            `
            : html`
              <ul class="dash-projects">
                ${projects.map((p) => renderProjectProgressRow(p, navigate))}
              </ul>
            `
        }
      </div>
    </section>
  `;
}

function renderProjectProgressRow(
  p: DashProjectProgress,
  navigate: (tab: string, options?: DashboardNavigateOptions) => void,
): TemplateResult {
  const tone = p.blocked > 0 ? "danger" : p.progress >= 70 ? "ok" : "primary";
  return html`
    <li class="dash-project dash-tone-${tone}" @click=${() => navigate("projects", { projectId: p.id })}>
      <div class="dash-project-head">
        <span class="dash-project-name">${p.name}</span>
        <span class="dash-project-pct">${p.progress}%</span>
      </div>
      <div class="dash-project-bar">
        <div class="dash-project-bar-done" style="width:${(p.done / Math.max(1, p.total)) * 100}%"></div>
        <div
          class="dash-project-bar-ip"
          style="width:${(p.inProgress / Math.max(1, p.total)) * 100}%"
        ></div>
        <div
          class="dash-project-bar-blk"
          style="width:${(p.blocked / Math.max(1, p.total)) * 100}%"
        ></div>
      </div>
      <div class="dash-project-meta">
        <span class="dash-project-chip ok">${p.done} done</span>
        <span class="dash-project-chip ip">${p.inProgress} in-progress</span>
        ${
          p.blocked > 0
            ? html`<span class="dash-project-chip blk">${p.blocked} blocked</span>`
            : nothing
        }
        <span class="dash-project-chip total">${p.total} total</span>
      </div>
    </li>
  `;
}

// ── Content surfaces ─────────────────────────────────────────

function renderContentCard(c: DashContent, navigate: (tab: string) => void): TemplateResult {
  return html`
    <section class="dash-card dash-card-lg">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-info">${(icons as any).image ?? icons.book ?? nothing}</span>
          <span>Content Pages</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("content-pages")}>
          Surfaces ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body dash-content-body">
        ${
          c.total === 0
            ? html`
              <div class="dash-empty-row">
                <span class="dash-empty-icon">${icons.book ?? nothing}</span>
                <span>No content surfaces yet. Spin up your first one.</span>
              </div>
            `
            : html`
              <div class="dash-content-grid">
                ${c.surfaces.slice(0, 6).map(
                  (s) => html`
                    <div class="dash-surface" style="--surface-color:${s.color}">
                      <div class="dash-surface-head">
                        <span class="dash-surface-dot"></span>
                        <span class="dash-surface-name">${s.surface}</span>
                      </div>
                      <span class="dash-surface-count">${s.count}</span>
                      <span class="dash-surface-sub">${s.published} live</span>
                    </div>
                  `,
                )}
              </div>
              ${
                c.recent.length > 0
                  ? html`
                    <div class="dash-content-recent-head">Recently updated</div>
                    <ul class="dash-content-recent">
                      ${c.recent.map(
                        (r) => html`
                          <li class="dash-content-recent-row">
                            <span class="dash-content-recent-surface">${r.surface}</span>
                            <span class="dash-content-recent-name">${r.name}</span>
                            <span class="dash-content-recent-status">${r.status}</span>
                            <span class="dash-content-recent-time">
                              ${r.updatedAt ? timeAgo(r.updatedAt) : "—"}
                            </span>
                          </li>
                        `,
                      )}
                    </ul>
                  `
                  : nothing
              }
            `
        }
      </div>
    </section>
  `;
}

// ── Federation overview card ─────────────────────────────────

function renderFederationCard(
  fed: DashFederationOverview,
  nodes: { id: string; name: string; online: boolean; isLocal: boolean; kind?: string }[],
  navigate: (tab: string) => void,
): TemplateResult {
  if (fed.totalNodes === 0)
    return html`

    `;
  const onlinePct = fed.totalNodes > 0 ? Math.round((fed.onlineNodes / fed.totalNodes) * 100) : 0;
  return html`
    <section class="dash-card dash-card-lg dash-fed-card">
      <header class="dash-card-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-info">${(icons as any).radio ?? icons.activity ?? nothing}</span>
          <span>Federation · fleet</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("federation")}>
          Manage ${icons.arrowRight ?? nothing}
        </button>
      </header>
      <div class="dash-card-body dash-fed-body">
        <div class="dash-fed-summary">
          <div class="dash-fed-gauge">${renderGauge(onlinePct, { size: 100, label: "online" })}</div>
          <div class="dash-fed-stats">
            <div class="dash-fed-stat">
              <span class="dash-fed-stat-value">${fed.totalNodes}</span>
              <span class="dash-fed-stat-label">nodes</span>
            </div>
            <div class="dash-fed-stat">
              <span class="dash-fed-stat-value">${fed.onlineNodes}</span>
              <span class="dash-fed-stat-label">online</span>
            </div>
            <div class="dash-fed-stat">
              <span class="dash-fed-stat-value">${fed.byKind.length}</span>
              <span class="dash-fed-stat-label">kinds</span>
            </div>
            <div class="dash-fed-stat">
              <span class="dash-fed-stat-value ${fed.hasRemoteLink ? "ok" : "warn"}">
                ${fed.hasRemoteLink ? "YES" : "NO"}
              </span>
              <span class="dash-fed-stat-label">remote link</span>
            </div>
          </div>
        </div>
        ${
          fed.byKind.length > 0
            ? html`
              <ul class="dash-fed-kinds">
                ${fed.byKind.map(
                  (k) => html`
                    <li class="dash-fed-kind">
                      <span class="dash-fed-kind-dot" style="background:${k.color}"></span>
                      <span class="dash-fed-kind-name">${k.kind}</span>
                      <span class="dash-fed-kind-count">${k.count}</span>
                    </li>
                  `,
                )}
              </ul>
            `
            : nothing
        }
        ${
          nodes.length > 0
            ? html`
              <div class="dash-fed-recent-head">Live roster</div>
              <ul class="dash-fed-roster">
                ${nodes.slice(0, 6).map(
                  (n) => html`
                    <li class="dash-fed-roster-row ${n.online ? "online" : "offline"}">
                      <span class="dash-fed-roster-dot"></span>
                      <span class="dash-fed-roster-name">${n.name}</span>
                      <span class="dash-fed-roster-kind">${n.isLocal ? "local" : n.kind || "node"}</span>
                    </li>
                  `,
                )}
              </ul>
            `
            : nothing
        }
      </div>
    </section>
  `;
}

// ── Federation / nodes strip ─────────────────────────────────

function renderNodesStrip(nodes: DashNode[], navigate: (tab: string) => void): TemplateResult {
  if (nodes.length === 0)
    return html`

    `;
  return html`
    <section class="dash-nodes">
      <div class="dash-nodes-head">
        <div class="dash-card-title">
          <span class="dash-card-icon dash-tone-info">${(icons as any).radio ?? icons.activity ?? nothing}</span>
          <span>Connected Fleet</span>
        </div>
        <button class="dash-card-link" @click=${() => navigate("federation")}>
          Federation ${icons.arrowRight ?? nothing}
        </button>
      </div>
      <div class="dash-nodes-grid">
        ${nodes.map(
          (n) => html`
            <div class="dash-node ${n.online ? "online" : "offline"} ${n.isLocal ? "local" : ""}">
              <span class="dash-node-dot"></span>
              <div class="dash-node-body">
                <span class="dash-node-name">${n.name}</span>
                <span class="dash-node-meta">
                  ${n.isLocal ? "this device" : n.kind || "node"}
                  <span class="dash-task-sep">·</span>
                  ${n.online ? "online" : "offline"}
                </span>
              </div>
            </div>
          `,
        )}
      </div>
    </section>
  `;
}

// ── Formatters ───────────────────────────────────────────────

function timeAgo(ts: number): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function timeUntil(ts: number): string {
  if (!ts) return "—";
  const diff = ts - Date.now();
  if (diff <= 0) return "now";
  if (diff < 60_000) return `in ${Math.ceil(diff / 1000)}s`;
  if (diff < 3_600_000) return `in ${Math.ceil(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.ceil(diff / 3_600_000)}h`;
  return `in ${Math.ceil(diff / 86_400_000)}d`;
}

function formatMoney(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

// ── Styles ───────────────────────────────────────────────────

let _stylesInjected = false;
function injectStyles() {
  if (_stylesInjected || typeof document === "undefined") return;
  _stylesInjected = true;
  const s = document.createElement("style");
  s.textContent = DASH_CSS;
  document.head.appendChild(s);
}

const DASH_CSS = `
/* Live Pulse — enhanced agent rows */
.dash-run-row { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; background: rgba(255,255,255,0.02); cursor: pointer; transition: border-color 140ms, background 140ms; }
.dash-run-row:hover { background: rgba(255,255,255,0.04); border-color: rgba(255,215,0,0.32); }
.dash-run-tone-warn { border-left: 3px solid var(--dash-warn, #f59e0b); }
.dash-run-tone-danger { border-left: 3px solid var(--dash-danger, #ef4444); }
.dash-run-tone-ok { border-left: 3px solid var(--dash-ok, #22c55e); }
.dash-run-tone-muted { border-left: 3px solid var(--dash-fg-faint, rgba(245,245,244,0.42)); }
.dash-run-head { display: flex; align-items: center; gap: 8px; }
.dash-run-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dash-ok, #22c55e); }
.dash-run-dot-anim { animation: dash-run-dot-pulse 1.4s ease-in-out infinite; box-shadow: 0 0 0 0 currentColor; color: var(--dash-ok, #22c55e); }
@keyframes dash-run-dot-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(34,197,94,0.55); } 50% { box-shadow: 0 0 0 8px rgba(34,197,94,0); } }
.dash-run-label { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-run-status { font-size: 11px; color: var(--dash-fg-dim); padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.05); }
.dash-run-time { font-size: 11px; color: var(--dash-fg-faint); font-variant-numeric: tabular-nums; }
.dash-run-task { font-size: 12px; color: var(--dash-fg-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-progress { display: flex; align-items: center; gap: 8px; }
.dash-progress-bar { position: relative; flex: 1; height: 5px; border-radius: 4px; background: rgba(255,255,255,0.06); overflow: hidden; }
.dash-progress-fill { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg, var(--g-primary, #ffd700), color-mix(in srgb, var(--g-primary, #ffd700) 60%, #fff)); transition: width 320ms ease; }
.dash-progress-shimmer { position: absolute; inset: 0; background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.18) 50%, transparent 100%); transform: translateX(-100%); animation: dash-shimmer 1.4s linear infinite; }
@keyframes dash-shimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
.dash-progress-fill-indet { position: absolute; inset: 0 auto 0 0; width: 33%; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--g-primary, #ffd700) 80%, transparent), transparent); animation: dash-indeterminate 1.6s ease-in-out infinite; }
@keyframes dash-indeterminate { 0% { left: -33%; } 100% { left: 100%; } }
.dash-progress-text { font-size: 11px; color: var(--dash-fg-dim); min-width: 56px; text-align: right; font-variant-numeric: tabular-nums; }
.dash-run-actions { display: flex; gap: 6px; margin-top: 4px; }

/* Client project sub-card */
.dash-client-tile-wrap { display: flex; flex-direction: column; gap: 8px; }
.dash-client-project-card {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-radius: 12px;
  border: 1px solid var(--dash-border, rgba(255,255,255,0.08));
  background: rgba(8,8,10,0.42);
}
.dash-client-project-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dash-client-project-eyebrow { font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--dash-fg-faint); }
.dash-client-project-title { font-weight: 600; color: var(--dash-fg); flex: 1; min-width: 0; }
.dash-client-project-status { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(255,255,255,0.06); color: var(--dash-fg-dim); }
.dash-client-project-bar { position: relative; height: 4px; border-radius: 4px; background: rgba(255,255,255,0.06); overflow: hidden; }
.dash-client-project-bar > span { position: absolute; inset: 0 auto 0 0; transition: width 240ms; }
.dash-client-project-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.dash-cta { appearance: none; border: 1px solid var(--dash-border, rgba(255,255,255,0.08)); background: rgba(255,255,255,0.04); color: var(--dash-fg); padding: 6px 10px; border-radius: 8px; cursor: pointer; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; gap: 6px; transition: background 120ms, transform 120ms; }
.dash-cta:hover { background: rgba(255,255,255,0.08); }
.dash-cta-primary { background: linear-gradient(135deg, var(--g-primary, #ffd700), color-mix(in srgb, var(--g-primary, #ffd700) 70%, #fff)); color: #0a0a0c; border-color: transparent; }
.dash-cta-primary:hover { transform: translateY(-1px); }

/* Mini reports gallery */
.dash-reports-mini .dash-reports-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.dash-reports-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
.dash-report-card { display: flex; flex-direction: column; gap: 8px; padding: 8px; border: 1px solid var(--dash-border, rgba(255,255,255,0.08)); border-radius: 12px; cursor: pointer; background: rgba(8,8,10,0.42); text-align: left; transition: transform 160ms, border-color 160ms; }
.dash-report-card:hover { transform: translateY(-2px); border-color: rgba(255,215,0,0.4); }
.dash-report-card report-thumbnail { display: block; width: 100%; aspect-ratio: 4 / 5; border-radius: 8px; overflow: hidden; background: rgba(0,0,0,0.4); }
.dash-report-meta { display: flex; flex-direction: column; gap: 2px; }
.dash-report-meta strong { font-size: 13px; color: var(--dash-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-report-meta span { font-size: 11px; color: var(--dash-fg-dim); }

.dash-preset-bar {
  display: flex;
  gap: 6px;
  padding: 6px;
  margin: 4px 0 14px;
  background: rgba(8,8,10,0.55);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px;
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  width: max-content;
  align-self: flex-start;
}
.dash-preset {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--g-fg-dim, rgba(245,245,244,0.65));
  padding: 7px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.01em;
  cursor: pointer;
  transition: background 120ms, color 120ms, border-color 120ms, transform 120ms;
}
.dash-preset:hover {
  color: var(--g-fg, #f5f5f4);
  background: rgba(255,255,255,0.04);
}
.dash-preset.is-active {
  color: #0a0a0c;
  background: linear-gradient(135deg, var(--g-primary, #ffd700), color-mix(in srgb, var(--g-primary, #ffd700) 70%, #fff));
  border-color: color-mix(in srgb, var(--g-primary, #ffd700) 60%, transparent);
  box-shadow: 0 6px 18px -8px rgba(255,215,0,0.55);
}
.dash-page {
  --dash-gold: var(--g-primary, #ffd700);
  --dash-ok: #22c55e;
  --dash-warn: #f59e0b;
  --dash-danger: #ef4444;
  --dash-info: #38bdf8;
  --dash-fg: var(--g-fg, #f5f5f4);
  --dash-fg-dim: var(--g-fg-dim, rgba(245,245,244,0.65));
  --dash-fg-faint: var(--g-fg-faint, rgba(245,245,244,0.42));
  --dash-border: rgba(255,255,255,0.08);
  --dash-border-strong: rgba(255,255,255,0.14);
  --dash-surface: rgba(8,8,10,0.55);
  --dash-surface-raised: rgba(14,14,18,0.75);

  padding: 24px 28px 56px;
  max-width: 1480px;
  margin: 0 auto;
  color: var(--dash-fg);
  font-family: var(--font-body, system-ui, sans-serif);
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* ─────────────── Tone vars ─────────────── */
.dash-tone-primary { --tone: var(--dash-gold); }
.dash-tone-ok      { --tone: var(--dash-ok); }
.dash-tone-warn    { --tone: var(--dash-warn); }
.dash-tone-danger  { --tone: var(--dash-danger); }
.dash-tone-info    { --tone: var(--dash-info); }
.dash-tone-neutral { --tone: var(--dash-fg-dim); }

/* ═════════════════ HERO ═════════════════ */
.dash-hero {
  position: relative;
  border-radius: 16px;
  border: 1px solid var(--dash-border-strong);
  background:
    linear-gradient(135deg, rgba(255,215,0,0.06), rgba(255,255,255,0.02) 50%, rgba(0,0,0,0.4)),
    var(--dash-surface-raised);
  backdrop-filter: blur(22px) saturate(160%);
  -webkit-backdrop-filter: blur(22px) saturate(160%);
  overflow: hidden;
  padding: 28px 32px;
}
.dash-hero-glow {
  position: absolute; inset: -40% -10% auto auto;
  width: 520px; height: 520px;
  background: radial-gradient(closest-side, rgba(255,215,0,0.18), transparent 70%);
  filter: blur(40px);
  pointer-events: none;
}
.dash-hero-content {
  position: relative; z-index: 1;
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 36px;
  align-items: start;
}
@media (max-width: 880px) {
  .dash-hero-content { grid-template-columns: 1fr; }
}
.dash-hero-left { min-width: 0; }
.dash-hero-tag {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--dash-fg-dim);
  margin-bottom: 10px;
}
.dash-hero-dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--dash-gold);
  box-shadow: 0 0 10px var(--dash-gold);
  animation: dash-pulse 2.4s ease-in-out infinite;
}
.dash-hero-title {
  margin: 0 0 12px;
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.15;
}
.dash-hero-headline {
  margin: 0 0 18px;
  font-size: 16px;
  font-weight: 500;
  color: var(--dash-fg);
  line-height: 1.45;
  max-width: 720px;
}
.dash-brief-list {
  list-style: none;
  margin: 0; padding: 0;
  display: flex; flex-direction: column;
  gap: 8px;
  max-width: 720px;
}
.dash-brief-line {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 12px;
  border-radius: 8px;
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--dash-border);
  font-size: 13px;
  color: var(--dash-fg);
}
.dash-brief-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--tone, var(--dash-gold));
  box-shadow: 0 0 10px color-mix(in srgb, var(--tone, var(--dash-gold)) 60%, transparent);
  flex-shrink: 0;
}
.dash-brief-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px;
  color: var(--tone, var(--dash-gold));
}
.dash-brief-icon svg { width: 14px; height: 14px; }
.dash-brief-text { flex: 1; line-height: 1.4; }
.dash-brief-line-action {
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
}
.dash-brief-line-action:hover,
.dash-brief-line-action:focus-visible {
  background: rgba(255,255,255,0.06);
  border-color: color-mix(in srgb, var(--tone, var(--dash-gold)) 45%, var(--dash-border));
  transform: translateX(2px);
  outline: none;
}
.dash-brief-arrow {
  display: inline-flex; align-items: center;
  width: 14px; height: 14px;
  color: var(--tone, var(--dash-gold));
  opacity: 0; transition: opacity 0.15s ease;
  flex-shrink: 0;
}
.dash-brief-line-action:hover .dash-brief-arrow,
.dash-brief-line-action:focus-visible .dash-brief-arrow { opacity: 0.8; }
.dash-brief-arrow svg { width: 13px; height: 13px; }

.dash-hero-right {
  display: flex; flex-direction: column;
  gap: 8px;
  min-width: 200px;
}
.dash-cta {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--dash-border-strong);
  color: var(--dash-fg);
  font-size: 13px; font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, transform 0.12s;
  font-family: inherit;
}
.dash-cta svg { width: 15px; height: 15px; color: var(--dash-fg-dim); }
.dash-cta:hover {
  background: rgba(255,255,255,0.08);
  border-color: color-mix(in srgb, var(--dash-gold) 35%, transparent);
  transform: translateY(-1px);
}
.dash-cta-primary {
  background: linear-gradient(135deg, color-mix(in srgb, var(--dash-gold) 22%, transparent), rgba(255,215,0,0.04));
  border-color: color-mix(in srgb, var(--dash-gold) 50%, transparent);
}
.dash-cta-primary svg { color: var(--dash-gold); }
.dash-cta-primary:hover {
  background: linear-gradient(135deg, color-mix(in srgb, var(--dash-gold) 32%, transparent), rgba(255,215,0,0.08));
}
.dash-hero-meta {
  margin-top: 4px;
  font-size: 11px;
  color: var(--dash-fg-faint);
  text-align: right;
  font-family: ui-monospace, monospace;
}

/* ═════════════════ CEO COMMAND ZONE ═════════════════ */
.dash-command-zone {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.dash-command-head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 14px;
  margin-bottom: 10px;
}
.dash-command-head h2 {
  margin: 2px 0 0;
  font-size: 19px;
  line-height: 1.15;
  letter-spacing: 0;
}
.dash-command-head-compact { margin-bottom: 8px; }
.dash-command-eyebrow {
  font: 700 10px ui-monospace, "JetBrains Mono", monospace;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--dash-gold);
}
.dash-command-empty {
  min-height: 118px;
  padding: 18px;
  border-radius: 14px;
  border: 1px solid var(--dash-border);
  display: flex;
  align-items: center;
  gap: 14px;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--dash-gold) 8%, transparent), transparent 52%),
    var(--dash-surface);
}
.dash-command-empty > div {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.dash-command-empty strong { color: var(--dash-fg); }
.dash-command-empty span { color: var(--dash-fg-dim); }
.dash-clients-hero {
  min-width: 0;
}
.dash-client-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}
.dash-client-tile {
  min-width: 280px;
  min-height: 140px;
  text-align: left;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--client-accent, var(--dash-gold)) 24%, var(--dash-border));
  padding: 13px 14px;
  color: var(--dash-fg);
  background:
    radial-gradient(circle at 20% 0%, color-mix(in srgb, var(--client-accent, var(--dash-gold)) 18%, transparent), transparent 42%),
    linear-gradient(155deg, rgba(255,255,255,0.052), rgba(255,255,255,0.012));
  display: flex;
  flex-direction: column;
  gap: 8px;
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.16s ease, box-shadow 0.16s ease, transform 0.16s ease;
}
.dash-client-tile:hover {
  border-color: var(--dash-gold);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--dash-gold) 24%, transparent),
    0 18px 48px color-mix(in srgb, #8b5cf6 24%, transparent);
  transform: translateY(-2px);
}
.dash-client-topline,
.dash-client-metrics,
.dash-client-agent {
  display: flex;
  align-items: center;
  gap: 7px;
}
.dash-client-topline { justify-content: space-between; }
.dash-client-badge,
.dash-client-status {
  min-width: 0;
  max-width: 62%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-radius: 999px;
  padding: 3px 8px;
  font: 700 9px ui-monospace, monospace;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.dash-client-badge {
  color: var(--client-accent, var(--dash-gold));
  background: color-mix(in srgb, var(--client-accent, var(--dash-gold)) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--client-accent, var(--dash-gold)) 28%, transparent);
}
.dash-client-status {
  color: var(--dash-fg-dim);
  background: rgba(255,255,255,0.035);
  border: 1px solid var(--dash-border);
}
.dash-client-name {
  font-size: 16px;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dash-client-project {
  color: var(--dash-fg-dim);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dash-client-progress {
  height: 7px;
  border-radius: 999px;
  overflow: hidden;
  background: rgba(255,255,255,0.06);
  border: 1px solid var(--dash-border);
}
.dash-client-progress span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--client-accent, var(--dash-gold)), var(--dash-gold));
}
.dash-client-metrics {
  justify-content: space-between;
  color: var(--dash-fg-faint);
  font: 600 10px ui-monospace, monospace;
}
.dash-client-agent {
  margin-top: auto;
  color: var(--dash-fg-dim);
  font-size: 11px;
}
.dash-client-agent svg { width: 13px; height: 13px; color: var(--client-accent, var(--dash-gold)); }
.dash-business-strip-wrap { min-width: 0; }
.dash-business-strip {
  display: flex;
  gap: 12px;
  overflow-x: auto;
  padding-bottom: 3px;
  scrollbar-width: none;
}
.dash-business-strip::-webkit-scrollbar { display: none; }
.dash-business-strip.single .dash-business-card {
  width: 100%;
  min-width: min(100%, 520px);
}
.dash-business-card {
  flex: 0 0 220px;
  min-height: 178px;
  padding: 13px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--biz-accent, var(--dash-gold)) 22%, var(--dash-border));
  color: var(--dash-fg);
  text-align: left;
  cursor: pointer;
  font-family: inherit;
  background:
    radial-gradient(circle at 15% 0%, color-mix(in srgb, var(--biz-accent, var(--dash-gold)) 15%, transparent), transparent 42%),
    linear-gradient(155deg, rgba(255,255,255,0.044), rgba(255,255,255,0.012));
  display: flex;
  flex-direction: column;
  gap: 11px;
}
.dash-business-top {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 8px;
}
.dash-business-logo {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  color: var(--biz-accent, var(--dash-gold));
  background: color-mix(in srgb, var(--biz-accent, var(--dash-gold)) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--biz-accent, var(--dash-gold)) 32%, transparent);
  font: 800 10px ui-monospace, monospace;
}
.dash-business-logo img { width: 100%; height: 100%; object-fit: cover; }
.dash-business-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 700;
}
.dash-status-pill {
  border-radius: 999px;
  padding: 3px 7px;
  font: 800 8.5px ui-monospace, monospace;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.dash-status-green { color: var(--dash-ok); background: color-mix(in srgb, var(--dash-ok) 14%, transparent); }
.dash-status-amber { color: var(--dash-warn); background: color-mix(in srgb, var(--dash-warn) 14%, transparent); }
.dash-status-red { color: var(--dash-danger); background: color-mix(in srgb, var(--dash-danger) 14%, transparent); }
.dash-business-kpis {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.dash-business-kpis span {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dash-business-kpis strong {
  font: 800 15px ui-monospace, monospace;
  color: var(--dash-fg);
}
.dash-business-kpis small {
  color: var(--dash-fg-faint);
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.dash-business-spark {
  height: 38px;
  display: flex;
  align-items: end;
  gap: 4px;
}
.dash-business-spark span {
  flex: 1;
  min-width: 10px;
  border-radius: 5px 5px 2px 2px;
  background: linear-gradient(180deg, var(--biz-accent, var(--dash-gold)), color-mix(in srgb, var(--biz-accent, var(--dash-gold)) 35%, transparent));
}
.dash-business-activity {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--dash-fg-dim);
  font-size: 11px;
}
.dash-business-activity strong {
  color: var(--dash-fg);
  font-family: ui-monospace, monospace;
}
.dash-command-row .dash-card-lg { min-height: 240px; }
.dash-ceo-body,
.dash-auto-body {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.dash-ceo-insight {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  align-items: center;
  gap: 10px;
  padding: 10px 10px;
  border-radius: 10px;
  background: rgba(255,255,255,0.025);
  border: 1px solid var(--dash-border);
  border-left: 3px solid var(--severity);
}
.dash-ceo-critical { --severity: #ef4444; }
.dash-ceo-warn { --severity: #fbbf24; }
.dash-ceo-success { --severity: #10b981; }
.dash-ceo-info { --severity: #a78bfa; }
.dash-ceo-icon {
  color: var(--severity);
  display: inline-flex;
  align-items: center;
}
.dash-ceo-icon svg { width: 16px; height: 16px; }
.dash-ceo-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dash-ceo-copy strong {
  color: var(--dash-fg);
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dash-ceo-copy span {
  color: var(--dash-fg-dim);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dash-ceo-action,
.dash-ceo-dismiss {
  border: 1px solid var(--dash-border);
  border-radius: 7px;
  background: rgba(255,255,255,0.035);
  color: var(--dash-fg);
  cursor: pointer;
  font-family: inherit;
}
.dash-ceo-action {
  padding: 6px 9px;
  font-size: 11px;
  font-weight: 700;
}
.dash-ceo-dismiss {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dash-fg-faint);
}
/* Voice setup card / docker-missing banner */
.dash-voice-card {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 14px 0;
  padding: 14px 18px;
  border: 1px solid color-mix(in srgb, var(--g-primary, #8b5cf6) 30%, transparent);
  border-radius: 12px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--g-primary, #8b5cf6) 10%, transparent), rgba(255,255,255,0.02));
}
.dash-voice-icon { font-size: 20px; line-height: 1; flex-shrink: 0; }
.dash-voice-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.dash-voice-text strong { font-size: 14px; color: var(--dash-fg); }
.dash-voice-text span { font-size: 12px; color: var(--dash-fg-faint); }
.dash-voice-cta {
  flex-shrink: 0;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, var(--g-primary, #8b5cf6) 45%, transparent);
  background: color-mix(in srgb, var(--g-primary, #8b5cf6) 18%, transparent);
  color: var(--dash-fg);
  font-family: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}
.dash-voice-cta:hover { background: color-mix(in srgb, var(--g-primary, #8b5cf6) 28%, transparent); }
.dash-voice-dismiss {
  flex-shrink: 0;
  width: 24px; height: 24px;
  display: inline-flex; align-items: center; justify-content: center;
  border: none; background: transparent;
  color: var(--dash-fg-faint); cursor: pointer; font-size: 13px;
}
.dash-auto-status {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--tone, var(--dash-gold)) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--tone, var(--dash-gold)) 22%, transparent);
}
.dash-auto-orb {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--tone, var(--dash-gold));
  box-shadow: 0 0 14px color-mix(in srgb, var(--tone, var(--dash-gold)) 70%, transparent);
}
.dash-auto-status div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.dash-auto-status strong {
  color: var(--dash-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dash-auto-status span {
  color: var(--dash-fg-dim);
  font-size: 11px;
}
.dash-prefire-badge {
  justify-self: end;
  border-radius: 999px;
  padding: 5px 9px;
  color: var(--dash-gold);
  background: color-mix(in srgb, var(--dash-gold) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--dash-gold) 32%, transparent);
  font: 800 10px ui-monospace, monospace;
  text-transform: uppercase;
}
.dash-auto-decisions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dash-auto-decision {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 7px 8px;
  border-radius: 8px;
  background: rgba(255,255,255,0.025);
  border: 1px solid var(--dash-border);
}
.dash-auto-decision span.ok { color: var(--dash-ok); }
.dash-auto-decision span.fail { color: var(--dash-danger); }
.dash-auto-decision strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--dash-fg);
}
.dash-auto-decision em {
  color: var(--dash-fg-faint);
  font: normal 10px ui-monospace, monospace;
}
.dash-auto-error {
  color: var(--dash-danger);
  font-size: 11px;
}
.dash-ops-separator {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 12px;
  margin: 2px 0 -2px;
}
.dash-ops-separator span {
  height: 1px;
  background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--dash-gold) 46%, transparent), transparent);
}
.dash-ops-separator strong {
  color: var(--dash-gold);
  font: 800 10px ui-monospace, monospace;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

/* ═════════════════ KPI STRIP ═════════════════ */
.dash-kpis {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 12px;
}
@media (max-width: 1180px) { .dash-kpis { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 640px)  { .dash-kpis { grid-template-columns: repeat(2, 1fr); } }
.dash-kpi {
  position: relative;
  border-radius: 12px;
  border: 1px solid var(--dash-border);
  background: linear-gradient(155deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01));
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  padding: 14px 16px;
  display: flex; flex-direction: column;
  gap: 6px;
  overflow: hidden;
  transition: border-color 0.15s, transform 0.12s;
}
.dash-kpi::before {
  content: "";
  position: absolute; left: 0; top: 0; bottom: 0;
  width: 3px;
  background: var(--tone, var(--dash-gold));
  opacity: 0.85;
}
.dash-kpi:hover {
  border-color: color-mix(in srgb, var(--tone, var(--dash-gold)) 40%, transparent);
  transform: translateY(-2px);
}
.dash-kpi-head {
  display: flex; align-items: center; gap: 8px;
  color: var(--dash-fg-dim);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-weight: 600;
}
.dash-kpi-icon { display: inline-flex; align-items: center; color: var(--tone, var(--dash-gold)); }
.dash-kpi-icon svg { width: 14px; height: 14px; }
.dash-kpi-label { line-height: 1; }
.dash-kpi-body { display: flex; align-items: baseline; gap: 8px; }
.dash-kpi-value {
  font-size: 26px;
  font-weight: 700;
  line-height: 1;
  font-family: ui-monospace, "JetBrains Mono", monospace;
  color: var(--dash-fg);
}
.dash-kpi-trend {
  display: inline-flex; align-items: center;
}
.dash-kpi-trend svg { width: 14px; height: 14px; }
.dash-kpi-trend-up   svg { color: var(--dash-ok); }
.dash-kpi-trend-down svg { color: var(--dash-danger); }
.dash-kpi-delta {
  font-size: 11px;
  color: var(--dash-fg-faint);
  font-family: ui-monospace, monospace;
}

/* ═════════════════ ROW LAYOUT ═════════════════ */
.dash-row {
  display: grid;
  gap: 16px;
}
.dash-row-2 { grid-template-columns: 1fr 1fr; }
@media (max-width: 1080px) {
  .dash-row-2 { grid-template-columns: 1fr; }
}

/* ═════════════════ CARDS ═════════════════ */
.dash-card {
  border-radius: 14px;
  border: 1px solid var(--dash-border);
  background:
    linear-gradient(160deg, rgba(255,255,255,0.04), rgba(255,255,255,0.012));
  backdrop-filter: blur(18px) saturate(140%);
  -webkit-backdrop-filter: blur(18px) saturate(140%);
  overflow: hidden;
}
.dash-card-lg {
  display: flex;
  flex-direction: column;
  min-height: 280px;
}
.dash-card-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--dash-border);
  background: rgba(0,0,0,0.18);
}
.dash-card-title {
  display: flex; align-items: center; gap: 10px;
  font-size: 13px; font-weight: 600;
  color: var(--dash-fg);
  letter-spacing: 0.01em;
}
.dash-card-sub {
  font-size: 11px;
  color: var(--dash-fg-faint);
  font-style: italic;
}
.dash-card-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--tone, var(--dash-gold)) 18%, transparent);
  border: 1px solid color-mix(in srgb, var(--tone, var(--dash-gold)) 32%, transparent);
  color: var(--tone, var(--dash-gold));
}
.dash-card-icon svg { width: 14px; height: 14px; }
.dash-card-link {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--dash-fg-dim);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 5px;
  font-family: inherit;
}
.dash-card-link svg { width: 12px; height: 12px; }
.dash-card-link:hover { color: var(--dash-gold); background: rgba(255,255,255,0.04); }

.dash-card-body { padding: 12px 14px; flex: 1; }
.dash-card-empty {
  padding: 22px 18px;
  text-align: center;
  font-size: 13px;
  color: var(--dash-fg-faint);
}
.dash-empty-row {
  display: flex; align-items: center;
  gap: 12px;
  padding: 18px 4px;
  color: var(--dash-fg-dim);
  font-size: 13px;
}
.dash-empty-icon {
  display: inline-flex;
  width: 28px; height: 28px;
  align-items: center; justify-content: center;
  border-radius: 8px;
  background: rgba(255,255,255,0.04);
  color: var(--dash-fg-faint);
}
.dash-empty-icon svg { width: 16px; height: 16px; }
.dash-mini-cta {
  margin-left: auto;
  display: inline-flex; align-items: center; gap: 4px;
  padding: 6px 10px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--dash-gold) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--dash-gold) 30%, transparent);
  color: var(--dash-gold);
  font-size: 11px; font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}
.dash-mini-cta svg { width: 12px; height: 12px; }

/* ═════════════════ AI INSIGHTS ═════════════════ */
.dash-insight-list {
  list-style: none;
  margin: 0; padding: 0;
  display: flex; flex-direction: column;
  gap: 8px;
}
.dash-insight {
  display: flex; align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(255,255,255,0.025);
  border: 1px solid var(--dash-border);
  border-left: 3px solid var(--tone, var(--dash-gold));
  transition: background 0.15s, border-color 0.15s, transform 0.12s;
}
.dash-insight:hover {
  background: rgba(255,255,255,0.05);
  border-color: color-mix(in srgb, var(--tone, var(--dash-gold)) 35%, transparent);
  border-left-color: var(--tone, var(--dash-gold));
  transform: translateX(2px);
}
.dash-insight-icon {
  flex-shrink: 0;
  width: 24px; height: 24px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 6px;
  background: color-mix(in srgb, var(--tone, var(--dash-gold)) 16%, transparent);
  color: var(--tone, var(--dash-gold));
}
.dash-insight-icon svg { width: 13px; height: 13px; }
.dash-insight-body {
  display: flex; flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.dash-insight-title {
  font-size: 13px; font-weight: 600;
  color: var(--dash-fg);
  line-height: 1.3;
}
.dash-insight-desc {
  font-size: 11.5px;
  color: var(--dash-fg-dim);
  line-height: 1.4;
}
.dash-insight-action {
  flex-shrink: 0;
  display: inline-flex; align-items: center; gap: 4px;
  padding: 6px 10px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--tone, var(--dash-gold)) 16%, transparent);
  border: 1px solid color-mix(in srgb, var(--tone, var(--dash-gold)) 38%, transparent);
  color: var(--tone, var(--dash-gold));
  font-size: 11px; font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
}
.dash-insight-action svg { width: 11px; height: 11px; }
.dash-insight-action:hover {
  background: color-mix(in srgb, var(--tone, var(--dash-gold)) 28%, transparent);
}
.dash-insight-badge {
  flex-shrink: 0;
  font-size: 9px; font-weight: 700;
  letter-spacing: 0.1em;
  padding: 3px 7px;
  border-radius: 4px;
  background: rgba(255,255,255,0.05);
  color: var(--dash-fg-faint);
}

/* ═════════════════ ACTIONABLE CARD CONTROLS ═════════════════ */
.dash-insight-actions, .dash-task-actions {
  flex-shrink: 0;
  display: inline-flex; align-items: center; gap: 6px;
}
.dash-insight:focus-visible, .dash-task:focus-visible, .dash-sugproj-card:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--dash-gold, #ffd700) 60%, transparent);
  outline-offset: 2px;
}
.dash-icon-btn {
  flex-shrink: 0;
  appearance: none;
  width: 24px; height: 24px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.03);
  color: var(--dash-fg-faint, rgba(255,255,255,0.55));
  font-size: 12px; line-height: 1;
  cursor: pointer; font-family: inherit;
  transition: background 120ms, color 120ms;
}
.dash-icon-btn:hover { background: rgba(255,80,80,0.16); color: #ff8a8a; }
.dash-cta-ghost { background: transparent; }
.dash-cta-ok {
  background: color-mix(in srgb, var(--dash-ok, #22c55e) 16%, transparent);
  border-color: color-mix(in srgb, var(--dash-ok, #22c55e) 40%, transparent);
  color: var(--dash-ok, #22c55e);
}
.dash-cta-ok:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dash-ok, #22c55e) 26%, transparent);
}
.dash-cta:disabled, .dash-insight-action:disabled, .dash-cta-primary:disabled {
  opacity: 0.55; cursor: not-allowed; transform: none;
}
.dash-btn-spinner {
  width: 11px; height: 11px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.25);
  border-top-color: currentColor;
  display: inline-block;
  animation: dash-spin 0.7s linear infinite;
}
@keyframes dash-spin { to { transform: rotate(360deg); } }
.dash-action-error {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: #ff8a8a;
}

/* ═════════════════ SUGGESTED PROJECTS ═════════════════ */
.dash-sugproj-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 12px;
}
.dash-sugproj-card {
  display: flex; flex-direction: column; gap: 8px;
  padding: 14px;
  border-radius: 12px;
}
.dash-sugproj-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
}
.dash-sugproj-name { font-size: 14px; font-weight: 700; color: var(--dash-fg); }
.dash-sugproj-rationale { font-size: 12px; color: var(--dash-fg-faint, rgba(255,255,255,0.6)); }
.dash-sugproj-desc { font-size: 12px; color: var(--dash-fg-dim, rgba(255,255,255,0.7)); }
.dash-sugproj-actions { display: flex; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
.dash-sugproj-confirm { display: flex; align-items: center; gap: 10px; }
.dash-sugproj-confirm > div { display: flex; flex-direction: column; }
.dash-sugproj-confirm strong { font-size: 13px; color: var(--dash-fg); }
.dash-sugproj-confirm span { font-size: 12px; color: var(--dash-fg-faint); }
.dash-sugproj-check { color: var(--dash-ok, #22c55e); display: inline-flex; }
.dash-sugproj-check svg { width: 20px; height: 20px; }
.dash-sugproj-done { gap: 12px; }

/* ═════════════════ LIVE PULSE ═════════════════ */
.dash-pulse {
  animation: dash-pulse 1.8s ease-in-out infinite;
}
.dash-pulse-list {
  list-style: none;
  margin: 0; padding: 0;
  display: flex; flex-direction: column;
  gap: 10px;
}
.dash-run-row {
  display: flex; flex-direction: column;
  gap: 6px;
  padding: 11px 12px;
  border-radius: 9px;
  background: rgba(34,197,94,0.04);
  border: 1px solid rgba(34,197,94,0.18);
}
.dash-run-head {
  display: flex; align-items: center; gap: 8px;
}
.dash-run-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--dash-ok);
  box-shadow: 0 0 8px var(--dash-ok);
  animation: dash-pulse 1.2s ease-in-out infinite;
}
.dash-run-label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--dash-fg);
  flex: 1;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-run-time {
  font-size: 10.5px;
  font-family: ui-monospace, monospace;
  color: var(--dash-fg-dim);
}
.dash-run-task {
  font-size: 11.5px;
  color: var(--dash-fg-dim);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ═════════════════ PRIORITY QUEUE ═════════════════ */
.dash-task-list {
  list-style: none;
  margin: 0; padding: 0;
  display: flex; flex-direction: column;
  gap: 6px;
}
.dash-task {
  display: flex; align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(255,255,255,0.025);
  border: 1px solid var(--dash-border);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, transform 0.12s;
}
.dash-task:hover {
  background: rgba(255,255,255,0.05);
  border-color: color-mix(in srgb, var(--tone, var(--dash-gold)) 36%, transparent);
  transform: translateX(2px);
}
.dash-task-pri {
  flex-shrink: 0;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.08em;
  padding: 4px 7px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--tone, var(--dash-gold)) 18%, transparent);
  color: var(--tone, var(--dash-gold));
  border: 1px solid color-mix(in srgb, var(--tone, var(--dash-gold)) 36%, transparent);
  font-family: ui-monospace, monospace;
  min-width: 64px;
  text-align: center;
}
.dash-task-body {
  display: flex; flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.dash-task-title {
  font-size: 13px; font-weight: 600;
  color: var(--dash-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-task-meta {
  font-size: 11px;
  color: var(--dash-fg-dim);
  display: flex; align-items: center; gap: 6px;
}
.dash-task-sep { opacity: 0.4; }
.dash-task-arrow {
  flex-shrink: 0;
  color: var(--dash-fg-faint);
  opacity: 0; transition: opacity 0.12s, transform 0.12s;
}
.dash-task-arrow svg { width: 14px; height: 14px; }
.dash-task:hover .dash-task-arrow {
  opacity: 1; transform: translateX(2px);
  color: var(--tone, var(--dash-gold));
}

/* ═════════════════ RECENTLY SHIPPED ═════════════════ */
.dash-done-list {
  list-style: none;
  margin: 0; padding: 0;
  display: flex; flex-direction: column;
  gap: 4px;
}
.dash-done {
  display: flex; align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 7px;
  transition: background 0.12s;
}
.dash-done:hover { background: rgba(255,255,255,0.03); }
.dash-done-check {
  flex-shrink: 0;
  width: 22px; height: 22px;
  border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--tone, var(--dash-ok)) 14%, transparent);
  color: var(--tone, var(--dash-ok));
}
.dash-done-check svg { width: 12px; height: 12px; }
.dash-done-body {
  display: flex; flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
}
.dash-done-title {
  font-size: 12.5px; font-weight: 500;
  color: var(--dash-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-done-meta {
  font-size: 10.5px;
  color: var(--dash-fg-dim);
  display: flex; align-items: center; gap: 6px;
}
.dash-done-time {
  font-size: 10.5px;
  color: var(--dash-fg-faint);
  font-family: ui-monospace, monospace;
  flex-shrink: 0;
}

/* ═════════════════ LEARNING BAND ═════════════════ */
.dash-learn {
  border-radius: 14px;
  border: 1px solid var(--dash-border);
  background: rgba(255,255,255,0.02);
  padding: 16px;
  margin-top: 8px;
}
.dash-learn-head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 12px;
}
.dash-learn-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.dash-continue {
  padding: 16px;
  display: flex; flex-direction: column; gap: 10px;
  border: 1px solid color-mix(in srgb, var(--dash-gold) 22%, transparent);
  background:
    linear-gradient(150deg, color-mix(in srgb, var(--dash-gold) 8%, transparent), rgba(255,255,255,0.02));
}
.dash-continue-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dash-continue-head h3 { margin: 0; font-size: 15px; font-weight: 600; }
.dash-continue-desc { margin: 0; font-size: 12px; color: var(--dash-fg-dim); line-height: 1.4; }
.dash-continue-step { display: flex; align-items: center; gap: 6px; font-size: 11.5px; }
.dash-step-label { color: var(--dash-fg-faint); }
.dash-step-name { color: var(--dash-gold); font-weight: 500; }

.dash-course {
  overflow: hidden;
}
.dash-course-cover {
  height: 80px;
  background-size: cover;
  background-position: center;
}
.dash-course-cover-empty {
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--dash-gold) 10%, transparent);
}
.dash-course-cover-empty svg { width: 22px; height: 22px; color: var(--dash-gold); opacity: 0.6; }
.dash-course-body { padding: 12px; display: flex; flex-direction: column; gap: 6px; }
.dash-course-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.dash-course-head h3 { margin: 0; font-size: 13px; font-weight: 600; }
.dash-course-desc {
  margin: 0;
  font-size: 11px;
  color: var(--dash-fg-dim);
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ═════════════════ PILLS / PROGRESS ═════════════════ */
.dash-pill {
  display: inline-flex; align-items: center;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 9.5px; font-weight: 600;
  letter-spacing: 0.04em;
  background: rgba(255,255,255,0.06);
  color: var(--dash-fg-dim);
  white-space: nowrap;
}
.dash-progress {
  display: flex; align-items: center;
  gap: 8px;
}
.dash-progress-bar {
  flex: 1;
  height: 4px;
  background: rgba(255,255,255,0.06);
  border-radius: 999px;
  overflow: hidden;
}
.dash-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--dash-gold), #f0a040);
  border-radius: 999px;
  transition: width 0.35s ease;
}
.dash-progress-text {
  font-size: 10.5px;
  color: var(--dash-fg-dim);
  font-family: ui-monospace, monospace;
  white-space: nowrap;
}

/* ═════════════════ STATUS ROW STATES ═════════════════ */
.dash-loading {
  display: flex; align-items: center; gap: 10px;
  padding: 18px 22px;
  color: var(--dash-fg-dim);
  font-size: 13px;
  border-radius: 10px;
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--dash-border);
}
.dash-spinner {
  width: 14px; height: 14px;
  border: 2px solid color-mix(in srgb, var(--dash-gold) 28%, transparent);
  border-top-color: var(--dash-gold);
  border-radius: 50%;
  animation: dash-spin 0.6s linear infinite;
}
.dash-banner {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px;
  border-radius: 10px;
  font-size: 13px;
}
.dash-banner svg { width: 16px; height: 16px; }
.dash-banner-error {
  background: color-mix(in srgb, var(--dash-danger) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--dash-danger) 28%, transparent);
  color: #fca5a5;
}

/* ═════════════════ ANIMATIONS ═════════════════ */
@keyframes dash-spin { to { transform: rotate(360deg); } }
@keyframes dash-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%       { opacity: 0.55; transform: scale(0.94); }
}
@media (prefers-reduced-motion: reduce) {
  .dash-page *,
  .dash-page *::before,
  .dash-page *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.001ms !important;
  }
  .dash-client-tile:hover,
  .dash-cta:hover,
  .dash-kpi:hover {
    transform: none !important;
  }
}

/* ═════════════════ KPI SPARKS ═════════════════ */
.dash-kpi-spark { margin-top: 2px; opacity: 0.92; }
.dash-kpi-spark svg { display: block; width: 100%; height: 26px; }

/* ═════════════════ ROW 3-COL ═════════════════ */
.dash-row-3 { grid-template-columns: 1.2fr 1fr 1fr; }
@media (max-width: 1180px) {
  .dash-row-3 { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 720px) {
  .dash-row-3 { grid-template-columns: 1fr; }
}

/* ═════════════════ ACTIVITY TIMELINE ═════════════════ */
.dash-card-tl { min-height: 0; }
.dash-tl-meta {
  display: flex; align-items: center; gap: 14px;
}
.dash-tl-stat { display: flex; flex-direction: column; align-items: flex-end; }
.dash-tl-stat-value {
  font-size: 16px; font-weight: 700;
  font-family: ui-monospace, monospace;
  color: var(--dash-fg);
  line-height: 1;
}
.dash-tl-stat-label {
  font-size: 9.5px; letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--dash-fg-faint);
  margin-top: 2px;
}
.dash-tl-divider {
  width: 1px; height: 22px;
  background: var(--dash-border);
}
.dash-tl-body { padding-top: 4px; padding-bottom: 6px; }
.dash-tl-body svg { display: block; width: 100%; }
.dash-tl-legend {
  display: flex; gap: 16px;
  margin-top: 6px;
  padding: 0 4px;
}
.dash-tl-legend-item {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 10.5px;
  color: var(--dash-fg-dim);
}
.dash-tl-swatch {
  width: 10px; height: 10px;
  border-radius: 3px;
}
.dash-tl-swatch-gold {
  background: linear-gradient(180deg, var(--dash-gold), color-mix(in srgb, var(--dash-gold) 35%, transparent));
}
.dash-tl-swatch-blue {
  background: linear-gradient(180deg, var(--dash-info), color-mix(in srgb, var(--dash-info) 35%, transparent));
}

/* ═════════════════ AGENT ROSTER ═════════════════ */
.dash-roster { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dash-roster-row {
  display: flex; align-items: center; gap: 12px;
  padding: 9px 10px;
  border-radius: 9px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--dash-border);
  transition: background 0.12s, border-color 0.12s;
}
.dash-roster-row:hover {
  background: rgba(255,255,255,0.04);
  border-color: color-mix(in srgb, var(--tone, var(--dash-gold)) 32%, transparent);
}
.dash-roster-avatar {
  position: relative;
  width: 32px; height: 32px;
  border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, color-mix(in srgb, var(--tone, var(--dash-gold)) 28%, transparent), rgba(255,255,255,0.04));
  border: 1px solid color-mix(in srgb, var(--tone, var(--dash-gold)) 40%, transparent);
  font-size: 11px; font-weight: 700;
  color: var(--dash-fg);
  flex-shrink: 0;
  font-family: ui-monospace, monospace;
}
.dash-roster-online {
  position: absolute; bottom: -2px; right: -2px;
  width: 9px; height: 9px;
  border-radius: 50%;
  background: var(--dash-ok);
  box-shadow: 0 0 8px var(--dash-ok);
  border: 1.5px solid rgba(0,0,0,0.4);
}
.dash-roster-body { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
.dash-roster-name {
  font-size: 12.5px; font-weight: 600;
  color: var(--dash-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-roster-meta {
  font-size: 10.5px;
  color: var(--dash-fg-dim);
  display: flex; gap: 5px; align-items: center;
}
.dash-roster-score { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; min-width: 70px; }
.dash-roster-pct {
  font-size: 11px;
  font-weight: 700;
  font-family: ui-monospace, monospace;
  color: var(--tone, var(--dash-gold));
}
.dash-mini-bar {
  width: 60px; height: 3px;
  background: rgba(255,255,255,0.07);
  border-radius: 999px;
  overflow: hidden;
}
.dash-mini-bar-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.3s;
}

/* ═════════════════ PROJECT VELOCITY ═════════════════ */
.dash-velocity-body {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 18px;
  align-items: center;
}
.dash-velocity-chart {
  display: flex; align-items: center; justify-content: center;
}
.dash-velocity-chart svg { display: block; }
.dash-velocity-legend {
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-direction: column;
  gap: 5px;
}
.dash-velocity-row {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px;
  color: var(--dash-fg);
}
.dash-velocity-dot {
  width: 9px; height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dash-velocity-name {
  flex: 1;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dash-fg-dim);
}
.dash-velocity-count {
  font-family: ui-monospace, monospace;
  font-weight: 700;
  color: var(--dash-fg);
}

/* ═════════════════ HEALTH GAUGES ═════════════════ */
.dash-health-body {
  display: flex; flex-direction: column; gap: 10px;
}
.dash-health-gauges {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}
.dash-health-gauge {
  display: flex; align-items: center; justify-content: center;
}
.dash-health-gauge svg { display: block; }
.dash-health-foot {
  display: flex; justify-content: center;
  padding-top: 4px;
  border-top: 1px solid var(--dash-border);
}
.dash-health-pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 10.5px; font-weight: 600;
  font-family: ui-monospace, monospace;
  letter-spacing: 0.04em;
}
.dash-health-pill svg { width: 11px; height: 11px; }
.dash-health-pill.ok {
  color: var(--dash-ok);
  background: color-mix(in srgb, var(--dash-ok) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--dash-ok) 30%, transparent);
}
.dash-health-pill.warn {
  color: var(--dash-warn);
  background: color-mix(in srgb, var(--dash-warn) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--dash-warn) 32%, transparent);
}

/* ═════════════════ WORKFLOWS ═════════════════ */
.dash-wf-list, .dash-cron-list, .dash-notes-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.dash-wf {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 10px;
  border-radius: 8px;
  border: 1px solid var(--dash-border);
  background: rgba(255,255,255,0.02);
}
.dash-wf-status {
  flex-shrink: 0;
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--tone, var(--dash-gold));
  box-shadow: 0 0 8px color-mix(in srgb, var(--tone, var(--dash-gold)) 70%, transparent);
}
.dash-wf-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.dash-wf-name {
  font-size: 12.5px; font-weight: 600;
  color: var(--dash-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-wf-meta {
  font-size: 10.5px;
  color: var(--dash-fg-dim);
  display: flex; gap: 5px; align-items: center;
}

/* ═════════════════ CRON ═════════════════ */
.dash-cron {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 10px;
  border-radius: 8px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--dash-border);
}
.dash-cron-spec {
  flex-shrink: 0;
  padding: 3px 8px;
  border-radius: 5px;
  font-size: 10.5px;
  font-family: ui-monospace, monospace;
  font-weight: 600;
  color: var(--tone, var(--dash-gold));
  background: color-mix(in srgb, var(--tone, var(--dash-gold)) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--tone, var(--dash-gold)) 30%, transparent);
  min-width: 90px;
  text-align: center;
}
.dash-cron-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.dash-cron-name {
  font-size: 12.5px; font-weight: 600;
  color: var(--dash-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-cron-meta {
  font-size: 10.5px;
  color: var(--dash-fg-dim);
  display: flex; gap: 5px; align-items: center;
}

/* ═════════════════ NOTES ═════════════════ */
.dash-note {
  display: flex; align-items: flex-start; gap: 10px;
  padding: 9px 10px;
  border-radius: 8px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--dash-border);
  transition: background 0.12s;
}
.dash-note:hover { background: rgba(255,255,255,0.04); }
.dash-note-tick {
  flex-shrink: 0;
  width: 3px; align-self: stretch;
  border-radius: 999px;
  background: linear-gradient(180deg, var(--dash-gold), color-mix(in srgb, var(--dash-gold) 40%, transparent));
}
.dash-note-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.dash-note-title {
  font-size: 12.5px; font-weight: 600;
  color: var(--dash-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-note-preview {
  font-size: 11px;
  color: var(--dash-fg-dim);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dash-note-time {
  font-size: 10.5px;
  color: var(--dash-fg-faint);
  font-family: ui-monospace, monospace;
  flex-shrink: 0;
}

/* ═════════════════ NODES STRIP ═════════════════ */
.dash-nodes {
  padding: 14px 16px;
  border-radius: 14px;
  border: 1px solid var(--dash-border);
  background: linear-gradient(155deg, rgba(56,189,248,0.04), rgba(255,255,255,0.012));
}
.dash-nodes-head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 12px;
}
.dash-nodes-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 8px;
}
.dash-node {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px;
  border-radius: 9px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--dash-border);
  transition: background 0.12s, border-color 0.12s;
}
.dash-node.online {
  border-color: color-mix(in srgb, var(--dash-ok) 25%, transparent);
}
.dash-node.offline {
  opacity: 0.6;
}
.dash-node.local {
  background: linear-gradient(135deg, color-mix(in srgb, var(--dash-gold) 8%, transparent), rgba(255,255,255,0.02));
  border-color: color-mix(in srgb, var(--dash-gold) 30%, transparent);
}
.dash-node-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--dash-fg-faint);
  flex-shrink: 0;
}
.dash-node.online .dash-node-dot {
  background: var(--dash-ok);
  box-shadow: 0 0 8px var(--dash-ok);
}
.dash-node-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.dash-node-name {
  font-size: 12px; font-weight: 600;
  color: var(--dash-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-node-meta {
  font-size: 10px;
  color: var(--dash-fg-dim);
  display: flex; gap: 4px;
}

/* ═════════════════ REVENUE ═════════════════ */
.dash-rev-body { display: flex; flex-direction: column; gap: 12px; }
.dash-rev-totals {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
}
.dash-rev-cell {
  display: flex; flex-direction: column;
  padding: 8px 10px;
  border-radius: 8px;
  background: linear-gradient(135deg, rgba(34,197,94,0.08), rgba(255,255,255,0.02));
  border: 1px solid rgba(34,197,94,0.18);
}
.dash-rev-cell-total {
  background: linear-gradient(135deg, rgba(34,197,94,0.18), rgba(212,180,84,0.08));
  border-color: rgba(212,180,84,0.35);
  box-shadow: 0 0 12px rgba(212,180,84,0.08) inset;
}
.dash-rev-cell-total .dash-rev-cell-value { color: var(--g-primary, #d4b454); }
.dash-rev-cell-label {
  font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--dash-fg-faint);
}
.dash-rev-cell-value {
  font-size: 15px; font-weight: 700;
  font-family: ui-monospace, monospace;
  color: var(--dash-ok);
}
.dash-rev-chart { position: relative; }
.dash-rev-chart svg { display: block; width: 100%; }
.dash-rev-chart-cap {
  position: absolute; right: 6px; top: -2px;
  font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--dash-fg-faint);
  font-family: ui-monospace, monospace;
}
.dash-rev-streams { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.dash-rev-stream {
  display: flex; justify-content: space-between; align-items: center;
  padding: 5px 8px;
  border-radius: 6px;
  background: rgba(255,255,255,0.02);
  font-size: 11.5px;
}
.dash-rev-stream-name { color: var(--dash-fg-dim); }
.dash-rev-stream-amt {
  color: var(--dash-ok);
  font-weight: 700;
  font-family: ui-monospace, monospace;
}

/* ═════════════════ DISCIPLINE ═════════════════ */
.dash-disc-body { display: flex; flex-direction: column; gap: 10px; }
.dash-disc-score-row {
  display: flex; align-items: center; gap: 14px;
  padding: 8px 6px;
}
.dash-disc-score {
  display: flex; flex-direction: column; align-items: center;
  padding: 6px 12px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--tone, var(--dash-gold)) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--tone, var(--dash-gold)) 32%, transparent);
  min-width: 64px;
}
.dash-disc-score-value {
  font-size: 22px; font-weight: 800;
  font-family: ui-monospace, monospace;
  color: var(--tone, var(--dash-gold));
  line-height: 1;
}
.dash-disc-score-label {
  font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--dash-fg-faint);
  margin-top: 2px;
}
.dash-disc-week {
  flex: 1;
  display: flex; align-items: flex-end; justify-content: space-between;
  gap: 4px;
  height: 36px;
}
.dash-disc-week-bar {
  flex: 1;
  border-radius: 2px 2px 0 0;
  background: linear-gradient(180deg, var(--dash-gold), color-mix(in srgb, var(--dash-gold) 45%, transparent));
  opacity: 0.6;
  transition: opacity 0.15s;
}
.dash-disc-week-bar.today { opacity: 1; box-shadow: 0 0 8px color-mix(in srgb, var(--dash-gold) 50%, transparent); }
.dash-disc-now {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--dash-gold) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--dash-gold) 28%, transparent);
  font-size: 12px; font-weight: 600;
  color: var(--dash-fg);
}
.dash-disc-now-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--dash-gold);
  box-shadow: 0 0 8px var(--dash-gold);
  animation: dash-pulse 1.8s ease-in-out infinite;
}
.dash-disc-timeline {
  padding: 6px 0;
}
.dash-disc-day {
  position: relative;
  height: 14px;
  border-radius: 4px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--dash-border);
  overflow: hidden;
}
.dash-disc-day-block {
  position: absolute;
  top: 1px; bottom: 1px;
  border-radius: 2px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--dash-gold) 45%, transparent), color-mix(in srgb, var(--dash-gold) 18%, transparent));
}
.dash-disc-day-block.done {
  background: linear-gradient(180deg, var(--dash-ok), color-mix(in srgb, var(--dash-ok) 45%, transparent));
}
.dash-disc-day-block.active {
  background: linear-gradient(180deg, var(--dash-info), color-mix(in srgb, var(--dash-info) 45%, transparent));
  box-shadow: 0 0 10px color-mix(in srgb, var(--dash-info) 50%, transparent);
}
.dash-disc-day-cursor {
  position: absolute;
  top: -2px; bottom: -2px;
  width: 2px;
  background: var(--dash-fg);
  box-shadow: 0 0 6px rgba(255,255,255,0.6);
}
.dash-disc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.dash-disc-block {
  display: grid;
  grid-template-columns: 8px 70px 1fr;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--dash-fg-dim);
}
.dash-disc-block.done {
  background: color-mix(in srgb, var(--dash-ok) 8%, transparent);
  color: var(--dash-fg);
}
.dash-disc-block.active {
  background: color-mix(in srgb, var(--dash-info) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--dash-info) 25%, transparent);
  color: var(--dash-fg);
}
.dash-disc-block-tick {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--dash-fg-faint);
}
.dash-disc-block.done .dash-disc-block-tick { background: var(--dash-ok); box-shadow: 0 0 6px var(--dash-ok); }
.dash-disc-block.active .dash-disc-block-tick { background: var(--dash-info); box-shadow: 0 0 6px var(--dash-info); }
.dash-disc-block-time {
  font-family: ui-monospace, monospace;
  font-size: 10.5px;
  color: var(--dash-fg-faint);
}
.dash-disc-block.done .dash-disc-block-time { color: var(--dash-ok); }
.dash-disc-block-label {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-weight: 500;
}

/* ═════════════════ PIPELINE ═════════════════ */
.dash-pipe-body {
  display: grid;
  grid-template-rows: auto auto auto auto;
  gap: 10px;
}
.dash-pipe-chart {
  display: flex; justify-content: center;
  padding: 4px 0;
}
.dash-pipe-stages { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.dash-pipe-stage {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  background: rgba(255,255,255,0.02);
  font-size: 11.5px;
}
.dash-pipe-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dash-pipe-stage-name {
  flex: 1;
  text-transform: capitalize;
  color: var(--dash-fg-dim);
}
.dash-pipe-stage-count {
  font-family: ui-monospace, monospace;
  font-weight: 700;
  color: var(--dash-fg);
}
.dash-pipe-hot-head {
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--dash-fg-faint);
  padding-top: 4px;
  border-top: 1px solid var(--dash-border);
}
.dash-pipe-hot { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.dash-pipe-client {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 8px;
  border-radius: 6px;
  background: rgba(255,255,255,0.02);
  font-size: 11.5px;
  cursor: pointer;
  transition: background 0.16s ease, transform 0.16s ease;
}
.dash-pipe-client:hover { background: rgba(255,255,255,0.05); transform: translateX(2px); }
.dash-pipe-hot-0 { background: color-mix(in srgb, #ef4444 10%, transparent); }
.dash-pipe-client-flame { font-size: 12px; }
.dash-pipe-client-name {
  flex: 1;
  font-weight: 600;
  color: var(--dash-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-pipe-client-stage {
  font-size: 9.5px; letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--dash-fg-faint);
  font-family: ui-monospace, monospace;
}

/* ═════════════════ FOCUS & PRIORITIES ═════════════════ */
.dash-focus-body { display: flex; flex-direction: column; gap: 12px; }
.dash-focus-summary {
  display: flex; align-items: center; gap: 18px;
  padding: 6px 4px 4px;
}
.dash-focus-ring { flex-shrink: 0; }
.dash-focus-ring svg { display: block; }
.dash-focus-stats {
  display: grid;
  grid-template-columns: auto auto 1fr;
  align-items: center;
  gap: 14px;
  flex: 1;
  min-width: 0;
}
.dash-focus-stat { display: flex; flex-direction: column; align-items: flex-start; }
.dash-focus-stat-value {
  font-size: 22px; font-weight: 800;
  font-family: ui-monospace, monospace;
  color: var(--dash-fg);
  line-height: 1;
}
.dash-focus-stat-label {
  font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--dash-fg-faint);
  margin-top: 3px;
}
.dash-focus-now {
  min-width: 0;
  display: flex; flex-direction: column;
  padding: 8px 12px;
  border-radius: 10px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--dash-gold) 18%, transparent), rgba(255,255,255,0.02));
  border: 1px solid color-mix(in srgb, var(--dash-gold) 35%, transparent);
}
.dash-focus-now-label {
  font-size: 9px; letter-spacing: 0.14em; font-weight: 700;
  color: var(--dash-gold);
  font-family: ui-monospace, monospace;
}
.dash-focus-now-title {
  font-size: 13px; font-weight: 600;
  color: var(--dash-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  margin-top: 2px;
}
.dash-focus-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dash-priority {
  display: grid;
  grid-template-columns: 18px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 9px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--dash-border);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, transform 0.12s;
}
.dash-priority:hover {
  background: rgba(255,255,255,0.05);
  border-color: color-mix(in srgb, var(--tone, var(--dash-gold)) 35%, transparent);
  transform: translateX(2px);
}
.dash-priority.is-focus {
  background: linear-gradient(135deg, color-mix(in srgb, var(--dash-gold) 14%, transparent), rgba(255,255,255,0.02));
  border-color: color-mix(in srgb, var(--dash-gold) 38%, transparent);
}
.dash-priority-rank {
  font-size: 14px;
  color: var(--tone, var(--dash-gold));
  text-align: center;
  line-height: 1;
}
.dash-priority.is-focus .dash-priority-rank {
  color: var(--dash-gold);
  text-shadow: 0 0 8px var(--dash-gold);
}
.dash-priority-body { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.dash-priority-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.dash-priority-title {
  font-size: 12.5px; font-weight: 600;
  color: var(--dash-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  flex: 1; min-width: 0;
}
.dash-priority-pct {
  font-size: 11px; font-weight: 700;
  color: var(--tone, var(--dash-gold));
  font-family: ui-monospace, monospace;
}
.dash-priority-next {
  font-size: 10.5px;
  color: var(--dash-fg-dim);
  font-style: italic;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-priority-actions {
  flex-shrink: 0;
  display: inline-flex; align-items: center; gap: 6px;
}
/* Focus-row icon buttons are non-destructive (pin / hand off / open) — use a
   neutral hover instead of the red dismiss hover the shared .dash-icon-btn has. */
.dash-priority-actions .dash-icon-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dash-gold, #ffd700) 18%, transparent);
  color: var(--dash-gold, #ffd700);
}
.dash-priority-actions .dash-icon-btn.is-pinned {
  background: color-mix(in srgb, var(--dash-gold, #ffd700) 16%, transparent);
  border-color: color-mix(in srgb, var(--dash-gold, #ffd700) 40%, transparent);
  color: var(--dash-gold, #ffd700);
}
.dash-priority-actions .dash-cta { padding: 4px 8px; font-size: 11px; }
.dash-priority-actions .dash-btn-spinner,
.dash-insight-draft .dash-btn-spinner { width: 11px; height: 11px; }

/* Inline "Draft reply" composer inside an AI Recommendation row */
.dash-insight-draft {
  display: flex; flex-direction: column; gap: 8px;
  margin-top: 8px;
}
.dash-draft-input {
  width: 100%;
  resize: vertical;
  box-sizing: border-box;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--dash-border);
  background: rgba(0,0,0,0.25);
  color: var(--dash-fg);
  font-family: inherit; font-size: 12px; line-height: 1.5;
}
.dash-draft-input:focus-visible {
  outline: none;
  border-color: color-mix(in srgb, var(--dash-gold, #ffd700) 50%, transparent);
}
.dash-draft-actions { display: inline-flex; gap: 8px; }

/* ═════════════════ KANBAN LANES ═════════════════ */
.dash-lanes-body { padding: 12px; }
.dash-lanes {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
@media (max-width: 600px) {
  .dash-lanes { grid-template-columns: repeat(2, 1fr); }
}
.dash-lane {
  display: flex; flex-direction: column;
  gap: 6px;
  padding: 10px 8px;
  border-radius: 9px;
  background: rgba(255,255,255,0.02);
  border-top: 2px solid var(--tone, var(--dash-gold));
  min-height: 130px;
}
.dash-lane-head {
  display: flex; justify-content: space-between; align-items: center;
  gap: 6px;
  padding: 0 2px;
}
.dash-lane-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--tone, var(--dash-gold));
  font-family: ui-monospace, monospace;
}
.dash-lane-count {
  font-size: 11px;
  font-weight: 700;
  font-family: ui-monospace, monospace;
  color: var(--dash-fg);
  padding: 1px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--tone, var(--dash-gold)) 14%, transparent);
}
.dash-lane-empty {
  font-size: 11px;
  color: var(--dash-fg-faint);
  text-align: center;
  padding: 20px 0;
}
.dash-lane-tasks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.dash-lane-task {
  display: flex; align-items: flex-start;
  gap: 6px;
  padding: 5px 6px;
  border-radius: 6px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--dash-border);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.dash-lane-task:hover {
  background: rgba(255,255,255,0.05);
  border-color: color-mix(in srgb, var(--tone, var(--dash-gold)) 28%, transparent);
}
.dash-lane-task-dot {
  width: 5px; height: 5px;
  border-radius: 50%;
  background: var(--tone, var(--dash-gold));
  margin-top: 5px;
  flex-shrink: 0;
}
.dash-lane-task-body { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.dash-lane-task-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--dash-fg);
  line-height: 1.35;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-lane-task-project {
  font-size: 9.5px;
  color: var(--dash-fg-faint);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-family: ui-monospace, monospace;
}

/* ═════════════════ PROJECTS IN PROGRESS ═════════════════ */
.dash-projects { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.dash-project {
  display: flex; flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 10px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--dash-border);
  border-left: 3px solid var(--tone, var(--dash-gold));
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, transform 0.12s;
}
.dash-project:hover {
  background: rgba(255,255,255,0.05);
  transform: translateX(2px);
}
.dash-project-head { display: flex; justify-content: space-between; align-items: center; }
.dash-project-name {
  font-size: 13px; font-weight: 600;
  color: var(--dash-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-project-pct {
  font-size: 12px;
  font-weight: 700;
  color: var(--tone, var(--dash-gold));
  font-family: ui-monospace, monospace;
}
.dash-project-bar {
  display: flex;
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  background: rgba(255,255,255,0.05);
}
.dash-project-bar-done { background: var(--dash-ok); }
.dash-project-bar-ip   { background: var(--dash-gold); }
.dash-project-bar-blk  { background: var(--dash-danger); }
.dash-project-meta { display: flex; flex-wrap: wrap; gap: 5px; }
.dash-project-chip {
  font-size: 9.5px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 4px;
  letter-spacing: 0.04em;
  font-family: ui-monospace, monospace;
}
.dash-project-chip.ok    { color: var(--dash-ok); background: color-mix(in srgb, var(--dash-ok) 14%, transparent); }
.dash-project-chip.ip    { color: var(--dash-gold); background: color-mix(in srgb, var(--dash-gold) 14%, transparent); }
.dash-project-chip.blk   { color: var(--dash-danger); background: color-mix(in srgb, var(--dash-danger) 14%, transparent); }
.dash-project-chip.total { color: var(--dash-fg-dim); background: rgba(255,255,255,0.04); }

/* ═════════════════ CONTENT PAGES ═════════════════ */
.dash-content-body { display: flex; flex-direction: column; gap: 12px; }
.dash-content-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 8px;
}
.dash-surface {
  display: flex; flex-direction: column;
  gap: 4px;
  padding: 10px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--surface-color, var(--dash-gold)) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--surface-color, var(--dash-gold)) 28%, transparent);
}
.dash-surface-head { display: flex; align-items: center; gap: 6px; }
.dash-surface-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--surface-color, var(--dash-gold));
  box-shadow: 0 0 6px var(--surface-color, var(--dash-gold));
}
.dash-surface-name {
  font-size: 10.5px;
  font-weight: 600;
  text-transform: capitalize;
  color: var(--dash-fg);
}
.dash-surface-count {
  font-size: 22px;
  font-weight: 800;
  font-family: ui-monospace, monospace;
  color: var(--surface-color, var(--dash-gold));
  line-height: 1;
}
.dash-surface-sub {
  font-size: 10px;
  color: var(--dash-fg-faint);
  font-family: ui-monospace, monospace;
}
.dash-content-recent-head {
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--dash-fg-faint);
  padding-top: 4px;
  border-top: 1px solid var(--dash-border);
}
.dash-content-recent { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.dash-content-recent-row {
  display: grid;
  grid-template-columns: 80px 1fr auto auto;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(255,255,255,0.02);
  font-size: 11.5px;
}
.dash-content-recent-surface {
  font-size: 9.5px; letter-spacing: 0.05em; text-transform: uppercase;
  color: var(--dash-fg-faint);
  font-family: ui-monospace, monospace;
}
.dash-content-recent-name {
  color: var(--dash-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-weight: 500;
}
.dash-content-recent-status {
  font-size: 9.5px;
  text-transform: uppercase;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(34,197,94,0.14);
  color: var(--dash-ok);
  font-family: ui-monospace, monospace;
  font-weight: 600;
}
.dash-content-recent-time {
  font-size: 10px;
  color: var(--dash-fg-faint);
  font-family: ui-monospace, monospace;
}

/* ═════════════════ FEDERATION OVERVIEW ═════════════════ */
.dash-fed-body { display: flex; flex-direction: column; gap: 14px; }
.dash-fed-summary {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 18px;
  align-items: center;
}
.dash-fed-gauge { flex-shrink: 0; }
.dash-fed-gauge svg { display: block; }
.dash-fed-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}
.dash-fed-stat {
  display: flex; flex-direction: column;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(255,255,255,0.025);
  border: 1px solid var(--dash-border);
}
.dash-fed-stat-value {
  font-size: 18px;
  font-weight: 800;
  font-family: ui-monospace, monospace;
  color: var(--dash-fg);
  line-height: 1;
}
.dash-fed-stat-value.ok   { color: var(--dash-ok); }
.dash-fed-stat-value.warn { color: var(--dash-warn); }
.dash-fed-stat-label {
  font-size: 9.5px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--dash-fg-faint);
  margin-top: 3px;
  font-family: ui-monospace, monospace;
}
.dash-fed-kinds {
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-wrap: wrap;
  gap: 6px;
}
.dash-fed-kind {
  display: inline-flex; align-items: center;
  gap: 6px;
  padding: 4px 9px;
  border-radius: 999px;
  background: rgba(255,255,255,0.025);
  border: 1px solid var(--dash-border);
  font-size: 11px;
}
.dash-fed-kind-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dash-fed-kind-name {
  color: var(--dash-fg-dim);
  text-transform: capitalize;
}
.dash-fed-kind-count {
  color: var(--dash-fg);
  font-weight: 700;
  font-family: ui-monospace, monospace;
}
.dash-fed-recent-head {
  font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--dash-fg-faint);
  padding-top: 4px;
  border-top: 1px solid var(--dash-border);
}
.dash-fed-roster {
  list-style: none; margin: 0; padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 5px;
}
.dash-fed-roster-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px;
  border-radius: 7px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--dash-border);
  font-size: 11px;
}
.dash-fed-roster-row.online {
  border-color: color-mix(in srgb, var(--dash-ok) 25%, transparent);
}
.dash-fed-roster-row.offline { opacity: 0.55; }
.dash-fed-roster-dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--dash-fg-faint);
  flex-shrink: 0;
}
.dash-fed-roster-row.online .dash-fed-roster-dot {
  background: var(--dash-ok);
  box-shadow: 0 0 6px var(--dash-ok);
}
.dash-fed-roster-name {
  flex: 1;
  font-weight: 600;
  color: var(--dash-fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dash-fed-roster-kind {
  font-size: 9.5px; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--dash-fg-faint);
  font-family: ui-monospace, monospace;
}

/* ═════════════════ MOBILE ═════════════════ */
@media (max-width: 720px) {
  .dash-page { padding: 16px 16px 40px; gap: 14px; }
  .dash-hero { padding: 22px 20px; }
  .dash-hero-title { font-size: 26px; }
  .dash-hero-headline { font-size: 14px; }
  .dash-card-lg { min-height: auto; }
  .dash-velocity-body { grid-template-columns: 1fr; }
  .dash-velocity-chart { justify-content: center; }
  .dash-tl-meta { gap: 8px; }
  .dash-tl-divider { display: none; }
}

/* ── World map band — futuristic HUD frame under the hero ───── */
.dash-worldmap { position: relative; margin: 12px 0 16px; padding: 0; }
.dash-worldmap__head {
  display: flex; align-items: end; justify-content: space-between;
  padding: 0 4px 10px;
}
.dash-worldmap__eyebrow {
  font-family: "Space Grotesk", system-ui, sans-serif;
  font-size: 10px; font-weight: 700; letter-spacing: 0.5em;
  color: var(--hud-gold, #d4af37); text-transform: uppercase;
}
.dash-worldmap__eyebrow::before {
  content: ""; display: inline-block;
  width: 28px; height: 1px; background: var(--hud-gold, #d4af37);
  margin-right: 10px; vertical-align: middle;
}
.dash-worldmap__title {
  font-size: 18px; font-weight: 700; color: #fff;
  letter-spacing: 0.01em; margin-top: 4px;
}
.dash-worldmap__fullscreen {
  cursor: pointer;
  background: linear-gradient(120deg, rgba(124,58,237,0.22), rgba(212,175,55,0.18));
  border: 1px solid rgba(212,175,55,0.5);
  color: #fff; padding: 6px 14px; border-radius: 999px;
  font-size: 11px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.dash-worldmap__fullscreen:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(124,58,237,0.3); }
/* Side-by-side: persisted split defaults to map 58% / calendar ~42%. */
.dash-worldmap__layout {
  --worldmap-split: 58%;
  display: grid;
  grid-template-columns: minmax(280px, var(--worldmap-split)) 6px minmax(280px, 1fr);
  grid-auto-rows: minmax(clamp(260px, 38vh, 390px), auto);
  gap: 0;
  align-items: stretch;
}
.dash-worldmap__aside {
  min-width: 0;
  min-height: 0;
  height: 100%;
}
.dash-worldmap__aside dashboard-calendar-panel {
  display: block;
  width: 100%;
  height: 100%;
}
.dash-worldmap__resizer {
  position: relative;
  width: 6px;
  min-width: 6px;
  height: 100%;
  cursor: col-resize;
  touch-action: none;
  border: 0;
  background: transparent;
  outline: none;
  z-index: 5;
}
.dash-worldmap__resizer::before {
  content: "";
  position: absolute;
  top: 12px;
  bottom: 12px;
  left: 50%;
  width: 1px;
  transform: translateX(-50%);
  background: linear-gradient(180deg, transparent, rgba(212,175,55,0.5), transparent);
  box-shadow: 0 0 10px rgba(212,175,55,0.16);
  transition: width 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.dash-worldmap__resizer:hover::before,
.dash-worldmap__resizer.is-dragging::before {
  width: 3px;
  background: linear-gradient(180deg, transparent, rgba(212,175,55,0.95), rgba(124,58,237,0.42), transparent);
  box-shadow: 0 0 18px rgba(212,175,55,0.46);
}
.dash-worldmap__resizer:focus-visible {
  border-radius: 999px;
  outline: 2px solid rgba(212,175,55,0.78);
  outline-offset: 3px;
}
@media (max-width: 900px) {
  .dash-worldmap__layout {
    grid-template-columns: 1fr;
    grid-auto-rows: auto;
    gap: 12px;
  }
  .dash-worldmap__resizer { display: none; }
  .dash-worldmap__aside { height: clamp(260px, 34vh, 360px); }
}
.dash-worldmap__frame {
  position: relative;
  min-height: clamp(260px, 38vh, 390px);
  height: 100%;
  border-radius: 12px;
  background:
    repeating-linear-gradient(180deg, transparent 0, transparent 22px, rgba(212,175,55,0.05) 22px, rgba(212,175,55,0.05) 23px),
    radial-gradient(120% 80% at 50% 0%, rgba(167,139,250,0.08), transparent 70%),
    #06000f;
  border: 1px solid rgba(212,175,55,0.32);
  overflow: hidden;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.04), 0 18px 40px -18px rgba(0,0,0,0.7);
}
.dash-worldmap__frame::before,
.dash-worldmap__frame::after,
.dash-worldmap__frame > .dash-worldmap__br,
.dash-worldmap__frame > .dash-worldmap__bl {
  content: ""; position: absolute; width: 18px; height: 18px;
  border-color: var(--hud-gold, #d4af37); pointer-events: none;
}
.dash-worldmap__frame::before { top: 8px; left: 8px; border-top: 1.5px solid; border-left: 1.5px solid; }
.dash-worldmap__frame::after { top: 8px; right: 8px; border-top: 1.5px solid; border-right: 1.5px solid; }
.dash-worldmap__frame > .dash-worldmap__br { bottom: 8px; right: 8px; border-bottom: 1.5px solid; border-right: 1.5px solid; }
.dash-worldmap__frame > .dash-worldmap__bl { bottom: 8px; left: 8px; border-bottom: 1.5px solid; border-left: 1.5px solid; }
.dash-worldmap__frame agency-world-viz { position: absolute; inset: 0; display: block; width: 100%; height: 100%; z-index: 1; }
/* Skeleton sits behind the viz; once <agency-world-viz> upgrades + mounts its
   opaque Pixi canvas (inset:0, z-index:1) it fully covers this placeholder. */
.dash-worldmap__skeleton {
  position: absolute; inset: 0; z-index: 0;
  background:
    linear-gradient(100deg, transparent 30%, rgba(212,175,55,0.07) 50%, transparent 70%),
    radial-gradient(60% 50% at 50% 55%, rgba(167,139,250,0.06), transparent 70%);
  background-size: 200% 100%, 100% 100%;
  animation: dash-worldmap-shimmer 1.6s ease-in-out infinite;
}
@keyframes dash-worldmap-shimmer {
  0% { background-position: 200% 0, 0 0; }
  100% { background-position: -100% 0, 0 0; }
}
@media (prefers-reduced-motion: reduce) {
  .dash-worldmap__skeleton { animation: none; }
}
@media (max-width: 720px) { .dash-worldmap__frame { min-height: 220px; } }
@media (prefers-reduced-motion: reduce) { .dash-worldmap__fullscreen { transition: none; } }

/* ═════════════ ACTION COMMAND CENTER ═════════════ */
.dash-needs-now {
  position: relative;
  overflow: hidden;
  padding: 20px 20px 36px !important;
  background: var(--glass-sheen), var(--glass-tint), var(--glass-2) !important;
  border-color: var(--glass-stroke-gold) !important;
  box-shadow: var(--glass-elev-3), var(--glass-glow-soft), var(--glass-specular) !important;
}
.dash-needs-now::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  opacity: .22;
  background: repeating-linear-gradient(180deg, transparent 0 5px, var(--glass-gold-a06) 6px);
  animation: dash-scan 14s linear infinite;
}
@keyframes dash-scan { from { background-position: 0 -40px; } to { background-position: 0 40px; } }
.dash-hud-corner { position: absolute; z-index: 0; width: 24px; height: 24px; pointer-events: none; border-color: var(--glass-gold); opacity: .72; }
.dash-hud-corner--tl { left: 9px; top: 9px; border-left: 1px solid; border-top: 1px solid; }
.dash-hud-corner--br { right: 9px; bottom: 9px; border-right: 1px solid; border-bottom: 1px solid; }
.dash-needs-head { position: relative; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 14px; }
.dash-needs-kicker { display: flex; align-items: center; gap: 8px; color: var(--glass-gold-hi); font: 700 10px/1 var(--glass-font-mono, monospace); letter-spacing: .18em; }
.dash-status-light { width: 7px; height: 7px; border-radius: 50%; background: var(--dash-ok); box-shadow: 0 0 0 4px color-mix(in srgb, var(--dash-ok) 14%, transparent), 0 0 12px color-mix(in srgb, var(--dash-ok) 70%, transparent); animation: dash-status-pulse 2s ease-in-out infinite; }
@keyframes dash-status-pulse { 50% { opacity: .46; transform: scale(.82); } }
.dash-needs-head h2 { margin: 6px 0 4px; color: var(--glass-fg); font-size: clamp(22px, 2.4vw, 30px); letter-spacing: -.035em; }
.dash-needs-head p { margin: 0; color: var(--glass-fg-3); font-size: 12px; }
.dash-needs-gauges { display: flex; align-items: center; gap: 5px; flex: none; }
.dash-needs-gauges .dash-gauge { filter: drop-shadow(0 0 10px var(--glass-gold-a10)); }
:root[data-theme="light"] .dash-needs-gauges .dash-gauge text { fill: var(--glass-fg) !important; }
.dash-gauge-stat { display: grid; justify-items: center; gap: 1px; }
.dash-gauge-stat small { color: var(--glass-fg-4); font: 650 8px/1 var(--glass-font-mono, monospace); letter-spacing: .12em; text-transform: uppercase; }
.dash-live-ticker { position: relative; z-index: 1; display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; min-height: 28px; margin-bottom: 14px; border: 1px solid var(--glass-stroke); border-radius: var(--glass-radius-pill); background: var(--glass-1); overflow: hidden; }
.dash-live-ticker > span { position: relative; z-index: 2; align-self: stretch; display: grid; place-items: center; padding: 0 12px; background: var(--glass-gold-fill); box-shadow: 8px 0 14px var(--glass-base); color: var(--glass-ink); font: 800 9px/1 var(--glass-font-mono, monospace); letter-spacing: .16em; }
.dash-live-ticker > div { min-width: 0; overflow: hidden; mask-image: linear-gradient(90deg, transparent, #000 16px, #000 calc(100% - 12px), transparent); }
.dash-ticker-track { display: flex; width: max-content; animation: dash-ticker 28s linear infinite; }
.dash-live-ticker b { padding-left: 42px; color: var(--glass-fg-3); font: 550 10px/28px var(--glass-font-mono, monospace); letter-spacing: .06em; white-space: nowrap; }
@keyframes dash-ticker { to { transform: translateX(-50%); } }
.dash-needs-grid { position: relative; z-index: 1; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 10px; }
.dash-need-tile { appearance: none; min-width: 0; min-height: 142px; padding: 15px !important; display: grid; grid-template-columns: 34px minmax(0, 1fr); grid-template-rows: 1fr auto; column-gap: 11px; text-align: left; color: var(--glass-fg); cursor: pointer; border: 1px solid var(--glass-stroke) !important; background: var(--glass-sheen), var(--glass-3) !important; animation: dash-need-enter .45s var(--glass-spring) both; animation-delay: calc(var(--dash-need-index) * 38ms); }
@keyframes dash-need-enter { from { opacity: 0; transform: translateY(8px) scale(.985); } }
.dash-need-tile:hover { border-color: color-mix(in srgb, var(--dash-need-tone, var(--glass-gold)) 58%, var(--glass-stroke)) !important; box-shadow: var(--glass-elev-3), 0 0 24px color-mix(in srgb, var(--dash-need-tone, var(--glass-gold)) 14%, transparent) !important; }
.dash-need-tone-danger { --dash-need-tone: var(--dash-danger); }
.dash-need-tone-warn { --dash-need-tone: var(--dash-warn); }
.dash-need-tone-ok { --dash-need-tone: var(--dash-ok); }
.dash-need-tone-gold { --dash-need-tone: var(--glass-gold); }
.dash-need-tone-info { --dash-need-tone: var(--dash-info); }
.dash-need-icon { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 10px; color: var(--dash-need-tone); background: color-mix(in srgb, var(--dash-need-tone) 12%, transparent); border: 1px solid color-mix(in srgb, var(--dash-need-tone) 24%, transparent); }
.dash-need-icon svg { width: 16px; height: 16px; }
.dash-need-copy { min-width: 0; display: flex; flex-direction: column; }
.dash-need-value { color: var(--dash-need-tone); font: 750 22px/1 var(--glass-font-mono, monospace); letter-spacing: -.04em; }
.dash-need-copy strong { margin-top: 6px; color: var(--glass-fg); font-size: 12px; }
.dash-need-copy small { margin-top: 5px; color: var(--glass-fg-3); font-size: 10.5px; line-height: 1.35; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.dash-need-action { grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 13px; padding-top: 10px; border-top: 1px solid var(--glass-stroke); color: var(--glass-fg-3); font-size: 10px; font-weight: 650; letter-spacing: .04em; }
.dash-need-action svg { width: 13px; height: 13px; color: var(--dash-need-tone); transition: transform var(--glass-dur-fast) var(--glass-ease); }
.dash-need-tile:hover .dash-need-action svg { transform: translateX(3px); }
.dash-need-tile .g-skeleton { display: block; width: 100%; height: 18px; border-radius: 6px; background: var(--glass-hover); }
.dash-need-tile .g-skeleton + .g-skeleton { grid-column: 1 / -1; height: 42px; }

@media (max-width: 1040px) { .dash-needs-grid { grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); } }
@media (max-width: 600px) {
  .dash-needs-now { width: 100%; min-width: 0; max-width: 100%; padding: 16px 16px 34px !important; box-sizing: border-box; }
  .dash-needs-head { align-items: flex-start; }
  .dash-needs-head > div:first-child { min-width: 0; }
  .dash-needs-head p { overflow-wrap: anywhere; }
  .dash-needs-gauges { display: none; }
  .dash-live-ticker > span { padding-inline: 10px; }
  .dash-live-ticker b { padding-left: 22px; }
  .dash-needs-grid { grid-template-columns: minmax(0, 1fr); }
  .dash-need-tile { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .dash-needs-now::before, .dash-status-light, .dash-ticker-track, .dash-need-tile { animation: none !important; }
}
:root[data-page-visibility="hidden"] .dash-needs-now::before,
:root[data-page-visibility="hidden"] .dash-status-light,
:root[data-page-visibility="hidden"] .dash-ticker-track { animation-play-state: paused !important; }
`;

// ---------------------------------------------------------------------------
// Focus Board Band — shows top-5 focus items as clickable chips on dashboard
// ---------------------------------------------------------------------------

const FOCUS_STATUS_COLORS: Record<string, string> = {
  backlog: "#6b7280",
  todo: "#3b82f6",
  in_progress: "#c9a84c",
  review: "#8b5cf6",
  done: "#10b981",
  "Not started": "#6b7280",
  "In progress": "#c9a84c",
  Completed: "#10b981",
  Paused: "#ef4444",
};

function _fmtFocusStatus(s?: string): string {
  if (!s) return "";
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function renderFocusBoardBand(navigate: (tab: string) => void): TemplateResult {
  const items = getFocusItems().slice(0, 5);
  if (items.length === 0) return html``;

  const openFocus = () => navigate("focus");
  const openAddFocus = (e: Event) => {
    e.stopPropagation();
    navigate("focus");
    window.dispatchEvent(new CustomEvent("infinibot:open-focus-add"));
  };

  return html`
    <style>
      .dash-focus-board-band {
        margin: 0 0 1.25rem;
        background: rgba(255,255,255,0.025);
        backdrop-filter: blur(24px) saturate(160%);
        -webkit-backdrop-filter: blur(24px) saturate(160%);
        border: 1px solid rgba(201,168,76,0.18);
        border-top: 1px solid rgba(201,168,76,0.45);
        border-radius: 14px;
        padding: 1rem 1.25rem;
        animation: dash-fb-in 0.35s cubic-bezier(0.16,1,0.3,1) both;
      }
      @keyframes dash-fb-in {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: none; }
      }
      .dash-fb-head {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 0.875rem;
      }
      .dash-fb-title {
        display: flex; align-items: center; gap: 0.5rem;
        font-size: 0.8rem; font-weight: 700; text-transform: uppercase;
        letter-spacing: 0.06em;
        background: linear-gradient(135deg, #c9a84c, #f5d78e);
        -webkit-background-clip: text; -webkit-text-fill-color: transparent;
        background-clip: text;
        cursor: pointer;
      }
      .dash-fb-actions {
        display: flex; gap: 0.4rem; align-items: center;
      }
      .dash-fb-link {
        font-size: 0.7rem; color: rgba(201,168,76,0.6);
        background: none; border: none; cursor: pointer;
        padding: 0.25rem 0.5rem; border-radius: 6px;
        transition: color 0.15s;
      }
      .dash-fb-link:hover { color: #c9a84c; }
      .dash-fb-add-btn {
        font-size: 0.7rem; color: #0a0a0f;
        background: linear-gradient(135deg, #c9a84c, #f5d78e);
        border: none; cursor: pointer;
        padding: 0.25rem 0.65rem; border-radius: 6px; font-weight: 700;
        transition: opacity 0.15s;
      }
      .dash-fb-add-btn:hover { opacity: 0.85; }
      .dash-fb-chips {
        display: flex; gap: 0.5rem; flex-wrap: wrap;
      }
      .dash-fb-chip {
        display: flex; align-items: center; gap: 0.5rem;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(201,168,76,0.15);
        border-radius: 999px;
        padding: 0.3rem 0.75rem;
        cursor: pointer; transition: all 0.18s;
        animation: dash-fb-chip-in 0.3s cubic-bezier(0.16,1,0.3,1) both;
      }
      .dash-fb-chip:nth-child(1) { animation-delay: 0ms; }
      .dash-fb-chip:nth-child(2) { animation-delay: 40ms; }
      .dash-fb-chip:nth-child(3) { animation-delay: 80ms; }
      .dash-fb-chip:nth-child(4) { animation-delay: 120ms; }
      .dash-fb-chip:nth-child(5) { animation-delay: 160ms; }
      @keyframes dash-fb-chip-in {
        from { opacity: 0; transform: translateX(-6px); }
        to { opacity: 1; transform: none; }
      }
      .dash-fb-chip:hover {
        border-color: rgba(201,168,76,0.45);
        background: rgba(201,168,76,0.05);
        transform: translateY(-1px);
      }
      .dash-fb-chip-rank {
        width: 18px; height: 18px; border-radius: 50%;
        background: linear-gradient(135deg, #c9a84c, #f5d78e);
        color: #0a0a0f; font-size: 0.6rem; font-weight: 800;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      }
      .dash-fb-chip-title {
        font-size: 0.775rem; font-weight: 500; color: rgba(255,255,255,0.85);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        max-width: 180px;
      }
      .dash-fb-chip-status {
        font-size: 0.62rem; font-weight: 600; text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--fsc, #6b7280);
        display: flex; align-items: center; gap: 0.2rem;
        flex-shrink: 0;
      }
      .dash-fb-chip-status::before {
        content: ""; width: 4px; height: 4px; border-radius: 50%;
        background: var(--fsc, #6b7280); flex-shrink: 0;
      }
    </style>
    <section class="dash-focus-board-band">
      <div class="dash-fb-head">
        <div class="dash-fb-title" @click=${openFocus}>
          ${icons.target} Focus Priority
        </div>
        <div class="dash-fb-actions">
          <button class="dash-fb-link" @click=${openFocus}>View All →</button>
          <button class="dash-fb-add-btn" @click=${openAddFocus}>+ Add</button>
        </div>
      </div>
      <div class="dash-fb-chips">
        ${items.map((item, i) => html`
          <div class="dash-fb-chip" style="animation-delay:${i * 40}ms" @click=${openFocus}>
            <span class="dash-fb-chip-rank">${i + 1}</span>
            <span class="dash-fb-chip-title">${item.title}</span>
            ${item.status ? html`
              <span class="dash-fb-chip-status" style="--fsc:${FOCUS_STATUS_COLORS[item.status] ?? "#6b7280"}">
                ${_fmtFocusStatus(item.status)}
              </span>
            ` : nothing}
          </div>
        `)}
      </div>
    </section>
  `;
}

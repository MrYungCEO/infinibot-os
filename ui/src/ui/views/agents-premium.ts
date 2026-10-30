/**
 * Agents page — full-page roster, constellation and detail drawer.
 *
 *   ┌ KPI strip: active now · runs today · verified % · spend today ──────────┐
 *   │ rail (groups,  │ constellation  ⇄  card grid            │ detail drawer │
 *   │ status, search)│ (clusters, delegation edges, pulses)   │ (tabs)        │
 *   └────────────────┴────────────────────────────────────────┴───────────────┘
 *
 * Data: the configured roster (controllers/agents-management → config.get,
 * incl. plugin agents tagged `_plugin`) joined with runs/verdicts/usage from
 * agents-premium-data.ts through lib/agents-roster-model.ts. Real data only:
 * unknown values render "—", failed sources are named, nothing is invented.
 *
 * The legacy per-agent editors (model/type/CLI/prompt/tools/skills/MCP/
 * sub-agents/references) are reused inside the Settings tab via the
 * `editors` bridge from views/agents-management.ts.
 */

import { html, nothing, svg, type SVGTemplateResult, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { AppViewState } from "../app-view-state";
import type { GatewayBrowserClient } from "../gateway";
import type { AgentListEntry } from "../controllers/agents-management";
import { loadAgentsList, setAgentPrimaryModel, updateAgentSecureOnly } from "../controllers/agents-management";
import { icons } from "../icons";
import {
  ensureSecureMode,
  getSecureState,
  isSecureSessionKey,
  LAST_SECURE_SESSION_STORAGE_KEY,
  secureActive,
  secureRequest,
  writeStoredKey,
} from "../secure-mode";
import {
  agentSecureReadiness,
  ensureLocalModels,
  ensureSecureVerdicts,
  resetSecureAgentsCache,
  secureAgentsCache,
  type AgentSecureReadiness,
} from "../secure-mode/agent-readiness";
import {
  AgentsConstellation,
  supportsWebGL,
  type ConstellationEngine,
  type CxEdge,
  type CxNode,
} from "../lib/agents-constellation-engine";
import {
  activityScore,
  BACKEND_CLI_COMMAND,
  BACKEND_LABEL,
  buildEdges,
  buildRoster,
  computeKpis,
  filterRoster,
  fmtAgo,
  fmtDuration,
  fmtPct,
  fmtTokens,
  fmtUsd,
  RUN_STATE_LABEL,
  runTime,
  runTone,
  sortRoster,
  spendByAgent,
  STATE_LABEL,
  summarizeGroups,
  type AgentLiveState,
  type AgentView,
  type AgentEdge,
  type RunLite,
} from "../lib/agents-roster-model";
import {
  agentsLive,
  loadAgentsLive,
  setPulseListener,
  startAgentsLive,
  stopAgentsLive,
} from "./agents-premium-data";
import { getAgentVoiceSlot, onAgentVoiceSlotChange } from "./agents-voice-slot";
import { takeAgentDrawerIntent } from "../lib/agents-drawer-intent";
import { getCoderBackendIcon } from "../lib/coder-backend-brand";

// ─── Bridge to the legacy editors in agents-management.ts ────────────────

export interface AgentsLegacyEditors {
  styles: () => TemplateResult;
  typeSelector: (a: AgentListEntry) => unknown;
  modelSelector: (a: AgentListEntry) => unknown;
  cliConfig: (a: AgentListEntry) => unknown;
  prompt: (a: AgentListEntry) => unknown;
  tools: (a: AgentListEntry) => unknown;
  skills: (a: AgentListEntry) => unknown;
  mcps: (a: AgentListEntry) => unknown;
  subagents: (a: AgentListEntry) => unknown;
  references: (a: AgentListEntry) => unknown;
  sessions: (a: AgentListEntry) => unknown;
  createDialog: () => unknown;
  configPopup: () => unknown;
  openConfigPopup: () => void;
  openCreate: () => void;
  setDefault: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export interface AgentsPremiumProps {
  state: AppViewState;
  client: GatewayBrowserClient;
  editors: AgentsLegacyEditors;
}

// ─── Module UI state (survives functional re-renders) ────────────────────

type DrawerTab = "overview" | "performance" | "tools" | "memory" | "channels" | "settings" | "voice" | "logs";

const ui = {
  view: (localStorage.getItem("agp.view") as "constellation" | "grid") || "constellation",
  /** Constellation renderer: 3D (three.js, default when WebGL works) or the 2D canvas engine. */
  renderer: (localStorage.getItem("agp.cx") as "3d" | "2d") || "3d",
  group: "all",
  status: "all" as AgentLiveState | "all",
  query: "",
  selected: null as string | null,
  tab: "overview" as DrawerTab,
  railOpen: false,
  composer: null as null | "assign" | "spawn",
  composerText: "",
  busy: false,
  notice: null as null | { kind: "ok" | "err"; text: string },
  /** Agent id whose model / secure policy is being saved from the Secure Mode controls. */
  secureSaving: null as string | null,
  secureError: null as null | { id: string; text: string },
};

let engine: ConstellationEngine | null = null;
let engineHost: HTMLElement | null = null;
/** Guards the async 3D mount against a remount/unmount racing the module load. */
let mountSeq = 0;
let lastSceneSig = "";
let lastState: AppViewState | null = null;
let lastClient: GatewayBrowserClient | null = null;
let liveBound = false;
let voiceUnsub: (() => void) | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;

function rerender() {
  lastState?.requestUpdate?.();
}

function select(id: string | null, tab?: DrawerTab) {
  ui.selected = id;
  // Phones: the drawer is an in-page sheet at the top of the page.
  if (id && rootEl && window.matchMedia?.("(max-width: 760px)").matches) {
    rootEl.scrollIntoView({ block: "start" });
  }
  if (tab) ui.tab = tab;
  ui.composer = null;
  ui.notice = null;
  engine?.setSelected(id);
  if (id) engine?.focus(id);
  rerender();
}

// ─── Icons (inline, currentColor) ────────────────────────────────────────

const icon = (d: SVGTemplateResult, size = 16) =>
  html`<svg viewBox="0 0 24 24" width=${size} height=${size} fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I = {
  constellation: icon(svg`<circle cx="5" cy="6" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="13" r="2.5"/><circle cx="6" cy="19" r="2"/><circle cx="19" cy="18" r="2"/><path d="M6.7 7.3l3.6 4M16.4 6.4l-3 5M10.4 14.7l-2.8 2.8M14.2 14.4l3.2 2.4"/>`),
  grid: icon(svg`<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>`),
  refresh: icon(svg`<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>`),
  plus: icon(svg`<path d="M12 5v14M5 12h14"/>`),
  gear: icon(svg`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`),
  search: icon(svg`<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>`, 15),
  close: icon(svg`<path d="M18 6L6 18M6 6l12 12"/>`),
  chat: icon(svg`<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`, 15),
  task: icon(svg`<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>`, 15),
  spawn: icon(svg`<path d="M12 2v6M12 22v-6M4.9 4.9l4.2 4.2M19.1 19.1l-4.2-4.2M2 12h6M22 12h-6"/><circle cx="12" cy="12" r="2"/>`, 15),
  stop: icon(svg`<rect x="6" y="6" width="12" height="12" rx="2"/>`, 15),
  filter: icon(svg`<path d="M3 5h18M6 12h12M10 19h4"/>`),
  zoomIn: icon(svg`<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>`, 15),
  zoomOut: icon(svg`<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M8 11h6"/>`, 15),
  fit: icon(svg`<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>`, 15),
  arrow: icon(svg`<path d="M5 12h14M13 6l6 6-6 6"/>`, 14),
  gateway: icon(svg`<rect x="3" y="4" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="18" height="6" rx="1.5"/><path d="M7 7h.01M7 17h.01"/>`, 13),
  terminal: icon(svg`<path d="M4 8l5 4-5 4M12 16h7"/>`, 13),
  plug: icon(svg`<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5"/>`, 13),
};

// ─── Entry ───────────────────────────────────────────────────────────────

export function renderAgentsPremium(props: AgentsPremiumProps) {
  const { state, client, editors } = props;
  lastState = state;
  lastClient = client;
  const mgmt = state.agentsManagementState;
  const now = Date.now();
  maybeReloadRoster(state, client, now);
  // "Agent profile" from the mesh inspector (lib/agents-drawer-intent).
  const intent = takeAgentDrawerIntent();
  if (intent) {
    ui.selected = intent.agentId;
    ui.tab = intent.tab ?? "overview";
    ui.composer = null;
    ui.notice = null;
    if (engine) {
      engine.setSelected(intent.agentId);
      engine.focus(intent.agentId);
    }
  }

  const rosterAgents = (mgmt?.agents ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    model: a.model,
    cliCommand: a.cliCommand,
    plugin: a.plugin,
    seedVersion: a.seedVersion,
    isDefault: a.isDefault,
    isDisabled: a.isDisabled,
    subagents: a.subagents,
    avatarUrl: a.avatarUrl,
    description: a.description,
    activeSessionCount: a.activeSessionCount,
    sessionCount: a.sessionCount,
    lastSessionAt: a.sessions[0]?.updatedAt ?? null,
  }));
  const views = buildRoster({
    agents: rosterAgents,
    profiles: agentsLive.profiles,
    runs: agentsLive.runs,
    spendToday: agentsLive.spendRows,
    spendByBackend: agentsLive.backendDay,
    now,
  });
  const edges = buildEdges(views, agentsLive.runs, now);
  const kpis = computeKpis(views, agentsLive.runs, now, agentsLive.spendToday);
  const groups = summarizeGroups(views);
  const filtered = sortRoster(filterRoster(views, { group: ui.group, state: ui.status, query: ui.query }));
  const selected = ui.selected ? views.find((v) => v.id === ui.selected) ?? null : null;
  if (ui.selected && !selected && mgmt && !mgmt.loading && views.length) ui.selected = null;

  syncEngine(views, edges, filtered, now);
  const sec = syncSecure(views, mgmt, client);

  const loadingFirst = (!mgmt || mgmt.loading) && views.length === 0;
  const clusters = new Set(views.map((v) => v.cluster.key)).size;

  return html`
    <div
      class="agp-root ${selected ? "has-drawer" : ""} ${ui.railOpen ? "rail-open" : ""} ${sec.on ? "agp-root--secure" : ""}"
      data-view=${ui.view}
      ${ref(rootRef)}
    >
      <style>${AGP_CSS}</style>
      ${editors.styles()}

      <header class="agp-top">
        <div class="agp-title">
          <div class="agp-eyebrow">Agents</div>
          <h1>Agent roster${sec.on ? html`<span class="ib-secure-lockbadge agp-sm-badge" data-secure-agents-badge title="Secure Mode is on — agents run on local models only, encrypted, without network tools">${icons.lock}<span>Secure Mode</span></span>` : nothing}</h1>
          <div class="agp-sub">
            ${views.length} agents · ${clusters} ${clusters === 1 ? "cluster" : "clusters"} ·
            ${sec.on
              ? html`<span class="agp-sm-count">${sec.ready} secure-ready · ${sec.blocked} blocked</span>`
              : agentsLive.loadedAt ? html`live, updated ${fmtAgo(agentsLive.loadedAt, now)}` : "connecting…"}
          </div>
        </div>
        <div class="agp-kpis" role="list" aria-label="Today at a glance">
          ${kpiTile("Active now", String(kpis.activeNow), `${views.filter((v) => v.state === "blocked").length} blocked · ${views.filter((v) => v.state === "error").length} errored`, "live")}
          ${kpiTile("Runs today", String(kpis.runsToday), `${agentsLive.runs.filter((r) => r.state === "running" || r.state === "reviewing" || r.state === "continuing").length} in flight`)}
          ${kpiTile("Verified", fmtPct(kpis.verifiedPct), kpis.judgedToday ? `of ${kpis.judgedToday} judged today` : "no verdicts yet today", kpis.verifiedPct === null ? "" : kpis.verifiedPct >= 0.7 ? "ok" : kpis.verifiedPct >= 0.4 ? "warn" : "bad")}
          ${kpiTile("Spend today", fmtUsd(kpis.spendToday), kpis.tokensToday === null ? (agentsLive.sourceErrors.spend ? "usage unavailable" : "—") : `${fmtTokens(kpis.tokensToday)} tokens`)}
        </div>
        <div class="agp-actions">
          <ib-secure-toggle compact data-secure-surface="agents"></ib-secure-toggle>
          <button class="agp-btn agp-only-mobile" @click=${() => { ui.railOpen = !ui.railOpen; rerender(); }} aria-expanded=${ui.railOpen}>${I.filter}<span>Filters</span></button>
          <div class="agp-seg" role="tablist" aria-label="View">
            <button role="tab" aria-selected=${ui.view === "constellation"} class=${ui.view === "constellation" ? "on" : ""} @click=${() => setView("constellation")}>${I.constellation}<span>Constellation</span></button>
            <button role="tab" aria-selected=${ui.view === "grid"} class=${ui.view === "grid" ? "on" : ""} @click=${() => setView("grid")}>${I.grid}<span>Cards</span></button>
          </div>
          <button class="agp-btn agp-icon" title="Refresh" aria-label="Refresh" ?disabled=${agentsLive.loading || mgmt?.loading} @click=${async () => { await Promise.all([loadAgentsList(state, client), loadAgentsLive(client)]); rerender(); }}>${I.refresh}</button>
          <button class="agp-btn agp-icon" title="Agent defaults" aria-label="Agent defaults" @click=${() => { editors.openConfigPopup(); rerender(); }}>${I.gear}</button>
          <button class="agp-btn agp-primary" @click=${() => { editors.openCreate(); rerender(); }}>${I.plus}<span>New agent</span></button>
        </div>
      </header>

      <div class="agp-banners">
        ${mgmt?.error ? html`<div class="agp-banner agp-banner--bad" role="alert">Couldn't load the roster: ${mgmt.error}</div>` : nothing}
        ${sourceBanner()}
        ${sec.on ? secureBanner(sec) : nothing}
      </div>

      <aside class="agp-rail" aria-label="Filter agents">
        ${renderRail(views, groups)}
      </aside>

      <main class="agp-main" aria-label=${ui.view === "constellation" ? "Agent constellation" : "Agent cards"}>
        ${loadingFirst
          ? html`<div class="agp-empty"><div class="agp-spinner"></div><p>Loading agents…</p></div>`
          : views.length === 0
            ? html`<div class="agp-empty"><h3>No agents yet</h3><p>Create an agent, or enable a plugin pack that contributes agents.</p><button class="agp-btn agp-primary" @click=${() => { editors.openCreate(); rerender(); }}>${I.plus}<span>New agent</span></button></div>`
            : ui.view === "constellation"
              ? renderConstellation(filtered.length, views.length)
              : renderGrid(filtered, now)}
      </main>

      ${selected ? renderDrawer(selected, views, edges, props, now) : nothing}
      ${ui.railOpen ? html`<div class="agp-scrim" @click=${() => { ui.railOpen = false; rerender(); }}></div>` : nothing}

      ${mgmt?.showCreateDialog ? editors.createDialog() : nothing}
      ${editors.configPopup()}
    </div>
  `;
}

let lastRosterReload = 0;
/**
 * The tab-open roster load can race the gateway handshake and come back empty
 * without an error; re-request it (throttled) instead of showing a thin roster.
 */
function maybeReloadRoster(state: AppViewState, client: GatewayBrowserClient, now: number) {
  const mgmt = state.agentsManagementState;
  const empty = !mgmt || (!mgmt.loading && mgmt.agents.length === 0);
  if (!empty || now - lastRosterReload < 4_000) return;
  lastRosterReload = now;
  void loadAgentsList(state, client).then(rerender);
}

function setView(v: "constellation" | "grid") {
  ui.view = v;
  try { localStorage.setItem("agp.view", v); } catch { /* private mode */ }
  rerender();
}

function kpiTile(label: string, value: string, sub: string, tone = "") {
  return html`<div class="agp-kpi ${tone ? `agp-kpi--${tone}` : ""}" role="listitem">
    <div class="agp-kpi-label">${tone === "live" ? html`<span class="agp-live-dot"></span>` : nothing}${label}</div>
    <div class="agp-kpi-value">${value}</div>
    <div class="agp-kpi-sub">${sub}</div>
  </div>`;
}

function sourceBanner() {
  const e = agentsLive.sourceErrors;
  const names: string[] = [];
  if (e.verification) names.push("verdicts");
  if (e.history) names.push("run history");
  if (e.live) names.push("live runs");
  if (e.profiles) names.push("agent profiles");
  if (!names.length) return nothing;
  return html`<div class="agp-banner" role="status">Some sources are unavailable (${names.join(", ")}). Their numbers show “—”.</div>`;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────

let rootEl: HTMLElement | null = null;
/** Stable ref callback (a fresh closure per render would re-fire mount/unmount). */
const rootRef = (el?: Element) => {
  if (lastState && lastClient) mountRoot(el as HTMLElement | undefined, lastState, lastClient);
};

function mountRoot(el: HTMLElement | undefined, state: AppViewState, client: GatewayBrowserClient) {
  if (el) {
    rootEl = el;
    if (!liveBound) {
      liveBound = true;
      startAgentsLive(client, rerender);
      setPulseListener((from, to, kind) => engine?.pulse(from, to, kind));
      voiceUnsub = onAgentVoiceSlotChange(rerender);
      // Relative times ("2m ago") stay fresh between polls.
      clockTimer = setInterval(() => { if (!document.hidden) rerender(); }, 30_000);
    } else {
      startAgentsLive(client, rerender);
    }
    return;
  }
  // Unmounted (tab switched away).
  queueMicrotask(() => {
    if (rootEl && rootEl.isConnected) return;
    rootEl = null;
    liveBound = false;
    stopAgentsLive();
    setPulseListener(null);
    voiceUnsub?.();
    voiceUnsub = null;
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
  });
}

// ─── Rail ────────────────────────────────────────────────────────────────

function renderRail(views: AgentView[], groups: ReturnType<typeof summarizeGroups>) {
  const byState = (s: AgentLiveState) => views.filter((v) => v.state === s).length;
  const kinds: Array<{ kind: string; label: string; icon: TemplateResult }> = [
    { kind: "core", label: "Core roster", icon: I.gateway },
    { kind: "plugin", label: "Plugin packs", icon: I.plug },
    { kind: "cli", label: "CLI coders", icon: I.terminal },
    { kind: "gateway", label: "Gateway agents", icon: I.gateway },
  ];
  const groupBtn = (key: string, label: string, count: number, working: number, sub = false, icon?: TemplateResult) => html`
    <button class="agp-rail-item ${sub ? "is-sub" : ""} ${ui.group === key ? "on" : ""}" aria-pressed=${ui.group === key}
      @click=${() => { ui.group = key; ui.railOpen = false; rerender(); }}>
      ${icon ? html`<span class="agp-rail-ico">${icon}</span>` : nothing}
      <span class="agp-rail-label">${label}</span>
      ${working ? html`<span class="agp-rail-live" title="${working} working">${working}</span>` : nothing}
      <span class="agp-rail-count">${count}</span>
    </button>`;
  return html`
    <div class="agp-search">
      ${I.search}
      <input type="search" placeholder="Search agents, roles, models…" aria-label="Search agents" .value=${ui.query}
        @input=${(e: Event) => { ui.query = (e.target as HTMLInputElement).value; rerender(); }} />
    </div>
    <div class="agp-rail-sec">
      <div class="agp-rail-h">Groups</div>
      ${groupBtn("all", "All agents", views.length, views.filter((v) => v.state === "working").length)}
      ${kinds.map((k) => {
        const inKind = groups.filter((g) => g.kind === k.kind);
        if (!inKind.length) return nothing;
        const count = inKind.reduce((a, g) => a + g.count, 0);
        const working = inKind.reduce((a, g) => a + g.working, 0);
        return html`
          ${groupBtn(k.kind === "plugin" ? "kind:plugin" : inKind[0].key, k.label, count, working, false, k.icon)}
          ${k.kind === "plugin" ? inKind.map((g) => groupBtn(g.key, g.label, g.count, g.working, true)) : nothing}
        `;
      })}
    </div>
    <div class="agp-rail-sec">
      <div class="agp-rail-h">Status</div>
      <div class="agp-status-chips">
        ${(["all", "working", "blocked", "error", "idle", "disabled"] as const).map((s) => {
          const n = s === "all" ? views.length : byState(s);
          if (s === "disabled" && n === 0) return nothing;
          return html`<button class="agp-chip ${ui.status === s ? "on" : ""}" aria-pressed=${ui.status === s}
            @click=${() => { ui.status = s; rerender(); }}>
            ${s !== "all" ? html`<span class="agp-dot agp-dot--${s}"></span>` : nothing}${s === "all" ? "All" : STATE_LABEL[s]}<b>${n}</b></button>`;
        })}
      </div>
    </div>
    <div class="agp-rail-sec agp-legend">
      <div class="agp-rail-h">Legend</div>
      <div><span class="agp-dot agp-dot--working"></span>Working — running a task or live session</div>
      <div><span class="agp-dot agp-dot--blocked"></span>Blocked — last run needs input or an owner</div>
      <div><span class="agp-dot agp-dot--error"></span>Error — last run failed (24h)</div>
      <div><span class="agp-dot agp-dot--idle"></span>Idle</div>
      <div><span class="agp-line"></span>Delegated work (runs)</div>
      <div><span class="agp-line agp-line--dash"></span>May delegate (config)</div>
      <div class="agp-legend-note">Node size = activity over 7 days. Dashed ring = CLI backend seen in runs.${ui.renderer === "3d" ? " 3D: colour = cluster, satellites = sub-agent runs in flight, light pulses = live messages." : ""}</div>
    </div>
  `;
}

// ─── Constellation ───────────────────────────────────────────────────────

function hoverFor(v: AgentView, now: number): CxNode["hover"] {
  const cur = v.stats.currentRun;
  const lv = v.stats.lastVerdict;
  return {
    role: v.role,
    model: v.model || (v.type === "cli" ? "set by the CLI" : ""),
    backend: v.backend ? (BACKEND_LABEL[v.backend] ?? v.backend) : "Gateway",
    task: cur ? cur.label : v.state === "working" ? "Live session" : "Idle",
    verdict: lv ? RUN_STATE_LABEL[lv] : "",
    verdictTone: lv ? runTone(lv) : "muted",
    runsToday: String(v.stats.runsToday),
    successRate: v.stats.judged ? `${fmtPct(v.stats.successRate)} of ${v.stats.judged}` : "",
    lastActive: fmtAgo(v.lastActiveAt, now),
  };
}

function syncEngine(views: AgentView[], edges: AgentEdge[], filtered: AgentView[], now: number) {
  if (!engine) return;
  const nodes: CxNode[] = views.map((v) => ({
    id: v.id,
    name: v.name,
    monogram: v.monogram,
    cluster: v.cluster.key,
    clusterLabel: v.cluster.label,
    state: v.state,
    size: activityScore(v),
    virtual: v.virtual,
    avatarUrl: v.avatarUrl,
    running: v.stats.running,
    hover: hoverFor(v, now),
  }));
  const cxEdges: CxEdge[] = edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, weight: e.weight, recent: e.recent }));
  const sig = JSON.stringify([nodes.map((n) => [n.id, n.name, n.cluster, n.state, n.size.toFixed(2), n.avatarUrl, n.running, n.hover]), cxEdges]);
  if (sig !== lastSceneSig) {
    lastSceneSig = sig;
    engine.setData(nodes, cxEdges);
  }
  const filterActive = ui.group !== "all" || ui.status !== "all" || ui.query.trim() !== "";
  engine.setDimmed(filterActive ? new Set(filtered.map((v) => v.id)) : null);
  engine.setSelected(ui.selected);
}

function mountEngine(el: Element | undefined) {
  if (el) {
    const host = el as HTMLElement;
    if (engine && engineHost === host) return;
    engine?.destroy();
    engine = null;
    engineHost = host;
    lastSceneSig = "";
    const seq = ++mountSeq;
    if (ui.renderer === "3d" && supportsWebGL()) {
      // three.js stays out of the main bundle; the 2D engine is the fallback at every step.
      void import("../lib/agents-constellation-3d")
        .then(({ AgentsConstellation3D }) => {
          if (seq !== mountSeq || engineHost !== host || !host.isConnected) return;
          try {
            engine = new AgentsConstellation3D(host, {
              onSelect: (id) => select(id),
              onFallback: (reason) => {
                console.warn(`[agents] 3D constellation unavailable (${reason}); using the 2D engine`);
                mount2D(host);
              },
            });
          } catch (err) {
            console.warn("[agents] 3D constellation failed to start; using the 2D engine", err);
            mount2D(host);
          }
          lastSceneSig = "";
          rerender();
        })
        .catch((err) => {
          console.warn("[agents] 3D constellation module failed to load; using the 2D engine", err);
          if (seq === mountSeq && engineHost === host) mount2D(host);
        });
      return;
    }
    mount2D(host);
    // First data push happens on the next render.
    queueMicrotask(rerender);
    return;
  }
  mountSeq++;
  engine?.destroy();
  engine = null;
  engineHost = null;
  lastSceneSig = "";
}

function mount2D(host: HTMLElement) {
  engine?.destroy();
  engine = new AgentsConstellation(host, { onSelect: (id) => select(id) });
  engineHost = host;
  lastSceneSig = "";
  queueMicrotask(rerender);
}

function setRenderer(r: "3d" | "2d") {
  if (ui.renderer === r) return;
  ui.renderer = r;
  try { localStorage.setItem("agp.cx", r); } catch { /* private mode */ }
  const host = engineHost;
  engine?.destroy();
  engine = null;
  engineHost = null;
  if (host && host.isConnected) mountEngine(host);
  rerender();
}

/** Which engine is actually on screen (the 3D one may have fallen back). */
function activeRenderer(): "3d" | "2d" {
  return engine instanceof AgentsConstellation ? "2d" : "3d";
}

function renderConstellation(shown: number, total: number) {
  return html`
    <div class="agp-cx-wrap">
      <div class="agp-cx-host" ${ref(mountEngine)}></div>
      <div class="agp-cx-controls" role="toolbar" aria-label="Constellation controls">
        <button class="agp-btn agp-icon" title="Zoom in (+)" aria-label="Zoom in" @click=${() => engine?.zoomBy(1.25)}>${I.zoomIn}</button>
        <button class="agp-btn agp-icon" title="Zoom out (−)" aria-label="Zoom out" @click=${() => engine?.zoomBy(0.8)}>${I.zoomOut}</button>
        <button class="agp-btn agp-icon" title="Frame all (0)" aria-label="Frame all" @click=${() => engine?.resetView()}>${I.fit}</button>
        ${supportsWebGL()
          ? html`<button class="agp-btn agp-icon agp-cx-mode" title=${ui.renderer === "3d" ? "Switch to the 2D map" : "Switch to the 3D constellation"} aria-label=${ui.renderer === "3d" ? "Switch to the 2D map" : "Switch to the 3D constellation"} aria-pressed=${ui.renderer === "3d"} @click=${() => setRenderer(ui.renderer === "3d" ? "2d" : "3d")}>${ui.renderer === "3d" ? "2D" : "3D"}</button>`
          : nothing}
      </div>
      ${ui.renderer === "3d" && engine && activeRenderer() === "2d"
        ? html`<div class="agp-cx-filter">3D view unavailable here · showing the 2D map</div>`
        : nothing}
      ${shown !== total
        ? html`<div class="agp-cx-filter">Showing ${shown} of ${total} · <button class="agp-link" @click=${() => { ui.group = "all"; ui.status = "all"; ui.query = ""; rerender(); }}>clear filters</button></div>`
        : nothing}
    </div>
  `;
}

// ─── Card grid ───────────────────────────────────────────────────────────

function avatar(v: AgentView, size: "sm" | "md" | "lg" = "md") {
  return html`<span class="agp-av agp-av--${size} agp-av--${v.state}" aria-hidden="true">
    ${v.avatarUrl ? html`<img src=${v.avatarUrl} alt="" loading="lazy" />` : html`<span>${v.monogram}</span>`}
  </span>`;
}

function backendChip(v: AgentView) {
  if (v.backend) {
    const label = BACKEND_LABEL[v.backend] ?? v.backend;
    const known =
      v.backend === "claude-code" ||
      v.backend === "codex" ||
      v.backend === "opencode" ||
      v.backend === "gemini" ||
      v.backend === "grok";
    return html`<span class="agp-tag" title="CLI backend: ${label}">${known ? getCoderBackendIcon(v.backend as "codex") : I.terminal}${label}</span>`;
  }
  return html`<span class="agp-tag" title=${v.modelFull ? `Gateway agent · model ${v.modelFull}` : "Gateway agent · default model"}>${I.gateway}${v.model || "default model"}</span>`;
}

function sparkline(days: number[]) {
  const max = Math.max(1, ...days);
  const w = 4;
  const gap = 2;
  return html`<svg class="agp-spark" viewBox="0 0 ${days.length * (w + gap)} 20" preserveAspectRatio="none" aria-hidden="true">
    ${days.map((d, i) => {
      const h = d === 0 ? 1.5 : 3 + (d / max) * 17;
      return svg`<rect x=${i * (w + gap)} y=${20 - h} width=${w} height=${h} rx="1" class=${i === days.length - 1 ? "today" : d === 0 ? "zero" : ""}></rect>`;
    })}
  </svg>`;
}

function renderGrid(list: AgentView[], now: number) {
  if (!list.length) {
    return html`<div class="agp-empty"><h3>No agents match</h3><p>Try another group, status or search.</p>
      <button class="agp-btn" @click=${() => { ui.group = "all"; ui.status = "all"; ui.query = ""; rerender(); }}>Clear filters</button></div>`;
  }
  return html`<div class="agp-grid">${list.map((v) => renderCard(v, now))}</div>`;
}

function renderCard(v: AgentView, now: number) {
  const cur = v.stats.currentRun;
  const last = v.stats.lastRun;
  const detail = cur ? agentsLive.liveDetails.get(cur.runId) : undefined;
  return html`
    <article class="agp-card agp-card--${v.state} ${ui.selected === v.id ? "on" : ""}" tabindex="0" role="button"
      aria-label="${v.name}, ${STATE_LABEL[v.state]}. Open details"
      @click=${() => select(v.id)} @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(v.id); } }}>
      <div class="agp-card-head">
        ${avatar(v)}
        <div class="agp-card-id">
          <div class="agp-card-name">${v.emoji ? html`<span class="agp-emoji">${v.emoji}</span>` : nothing}${v.name}${v.isDefault ? html`<span class="agp-badge">default</span>` : nothing}</div>
          <div class="agp-card-role">${v.role || v.id}</div>
        </div>
        <span class="agp-pill agp-pill--${v.state}">${STATE_LABEL[v.state]}</span>
      </div>
      <div class="agp-card-tags">
        ${backendChip(v)}
        ${v.plugin ? html`<span class="agp-tag agp-tag--plugin" title="Contributed by the ${v.group.label} plugin">${I.plug}${v.group.label}</span>` : html`<span class="agp-tag agp-tag--muted">${v.cluster.label}</span>`}
      </div>
      ${secureCardRow(v)}
      <div class="agp-card-now">
        ${cur
          ? html`<div class="agp-now-label"><span class="agp-live-dot"></span>${cur.label}</div>
              <div class="agp-progress"><i style="width:${Math.max(4, Math.min(100, detail?.progress ?? 0))}%"></i></div>`
          : last
            ? html`<div class="agp-now-label is-muted">Last: ${last.label}</div>
                <span class="agp-verdict agp-tone--${runTone(last.state)}">${RUN_STATE_LABEL[last.state]}</span>`
            : html`<div class="agp-now-label is-muted">No runs recorded yet</div>`}
      </div>
      <div class="agp-card-stats">
        <div title="Runs started today"><b>${v.stats.runsToday}</b><span>Runs today</span></div>
        <div title=${v.stats.judged ? `${v.stats.verified} verified of ${v.stats.judged} judged runs` : "No verification verdicts yet"}><b>${fmtPct(v.stats.successRate)}</b><span>Verified</span></div>
        <div title=${v.spendToday ? `${fmtTokens(v.spendToday.tokens)} tokens · ${v.spendToday.requests} requests today` : "No usage recorded today"}><b>${v.spendToday ? fmtUsd(v.spendToday.costUsd) : "—"}</b><span>${v.spendToday ? `${fmtTokens(v.spendToday.tokens)} tok` : "Spend"}</span></div>
        <div title="Last active"><b>${fmtAgo(v.lastActiveAt, now)}</b><span>Active</span></div>
      </div>
      <div class="agp-card-foot">${sparkline(v.stats.runsByDay)}<span>14-day runs</span></div>
    </article>
  `;
}

// ─── Secure Mode ─────────────────────────────────────────────────────────
// The header toggle is the shared <ib-secure-toggle> (one store, ws-broadcast
// via secure.mode.changed). Readiness per agent is the gateway's secure.check
// verdict for the agent's primary model (secure-mode/agent-readiness.ts).

type SecSummary = { on: boolean; ready: number; blocked: number; checking: number; byId: Map<string, AgentSecureReadiness> };

let lastSec: SecSummary = { on: false, ready: 0, blocked: 0, checking: 0, byId: new Map() };
let secWasOn = false;

function isSecureOnly(id: string, state: AppViewState | null = lastState): boolean {
  return state?.agentsManagementState?.agents.find((a) => a.id === id)?.secureOnly === true;
}

function syncSecure(views: AgentView[], mgmt: AppViewState["agentsManagementState"], client: GatewayBrowserClient): SecSummary {
  const on = secureActive(getSecureState());
  if (on !== secWasOn) {
    secWasOn = on;
    resetSecureAgentsCache();
    ui.secureError = null;
  }
  const byId = new Map<string, AgentSecureReadiness>();
  const needed = on || Boolean(mgmt?.agents.some((a) => a.secureOnly));
  if (needed) {
    const refs = new Set<string>();
    for (const v of views) {
      const legacy = mgmt?.agents.find((a) => a.id === v.id);
      const r = agentSecureReadiness(
        { type: legacy?.type ?? v.type, virtual: v.virtual, model: legacy?.model ?? "default" },
        mgmt?.defaultModel ?? "",
        secureAgentsCache.verdicts,
      );
      byId.set(v.id, r);
      if (r.kind === "checking" && r.modelRef) refs.add(r.modelRef);
    }
    if (refs.size) ensureSecureVerdicts(client, refs, rerender);
    if (on) void ensureLocalModels(client, rerender);
  }
  let ready = 0, blocked = 0, checking = 0;
  for (const r of byId.values()) {
    if (r.kind === "ready") ready++;
    else if (r.kind === "checking") checking++;
    else blocked++;
  }
  lastSec = { on, ready, blocked, checking, byId };
  return lastSec;
}

/** A fresh secure session key for this agent (turns Secure Mode on for a secureOnly agent). */
async function openSecureSessionFor(agentId: string): Promise<string> {
  if (!(await ensureSecureMode())) {
    throw new Error(getSecureState().error ?? "Secure Mode could not be turned on.");
  }
  const res = await secureRequest<{ sessionKey?: string }>("secure.session.new", { agentId });
  const key = res?.sessionKey ?? "";
  if (!isSecureSessionKey(key)) throw new Error("The gateway did not return a secure session.");
  writeStoredKey(LAST_SECURE_SESSION_STORAGE_KEY, key);
  return key;
}

function secureBanner(sec: SecSummary) {
  return html`<div class="agp-banner agp-banner--secure" role="status" data-secure-agents-summary>
    <span class="agp-sm-banner-ico">${icons.shieldCheck}</span>
    <span><b>Secure Mode is on.</b> ${sec.ready} ${sec.ready === 1 ? "agent is" : "agents are"} Secure-ready (local model).
      ${sec.blocked ? html`${sec.blocked} on hosted models or CLI backends ${sec.blocked === 1 ? "is" : "are"} blocked until switched to a local model.` : nothing}
      ${sec.checking ? html`Checking ${sec.checking}…` : nothing}</span>
    ${ui.view === "constellation"
      ? html`<button class="agp-btn agp-btn--secure" @click=${() => setView("grid")}>${I.grid}<span>Show per agent</span></button>`
      : nothing}
  </div>`;
}

function secureChip(r: AgentSecureReadiness) {
  switch (r.kind) {
    case "ready":
      return html`<span class="agp-sm agp-sm--ok" data-secure-state="ready" title="Runs on ${r.modelRef}, served from this machine">${icons.shieldCheck}<span>Secure-ready</span></span>`;
    case "blocked":
      return html`<span class="agp-sm agp-sm--bad" data-secure-state="blocked" title=${r.reason}>${icons.lock}<span>Remote model — blocked in Secure Mode</span></span>`;
    case "cli":
      return html`<span class="agp-sm agp-sm--bad" data-secure-state="cli" title=${r.reason}>${icons.lock}<span>CLI backend — blocked in Secure Mode</span></span>`;
    default:
      return html`<span class="agp-sm agp-sm--muted" data-secure-state="checking">${icons.loader}<span>Checking model…</span></span>`;
  }
}

const stopEvent = (e: Event) => e.stopPropagation();

async function switchToLocal(agentId: string, ref: string) {
  const state = lastState;
  const client = lastClient;
  if (!state || !client || !ref || ui.secureSaving) return;
  ui.secureSaving = agentId;
  ui.secureError = null;
  rerender();
  try {
    await setAgentPrimaryModel(client, agentId, ref);
    await loadAgentsList(state, client);
  } catch (err) {
    ui.secureError = { id: agentId, text: err instanceof Error ? err.message : String(err) };
  } finally {
    ui.secureSaving = null;
    rerender();
  }
}

function localPicker(agentId: string, name: string) {
  const c = secureAgentsCache;
  const saving = ui.secureSaving === agentId;
  const err = ui.secureError?.id === agentId && !ui.secureError.text.startsWith("policy:") ? html`<span class="agp-sm-err" role="alert">${ui.secureError.text}</span>` : nothing;
  if (c.local === null) {
    return html`<span class="agp-sm-note">${c.localError ? `Local models unavailable: ${c.localError}` : "Finding local models…"}</span>`;
  }
  if (!c.local.length) {
    return html`<span class="agp-sm-note">No local models installed — start Ollama (or a loopback vLLM) and pull a model.</span>`;
  }
  const providers = [...new Set(c.local.map((m) => m.provider))];
  return html`<label class="agp-sm-pick ${saving ? "is-busy" : ""}" @click=${stopEvent} @keydown=${stopEvent}>
      ${saving ? icons.loader : icons.server}
      <select data-secure-local-picker aria-label="Switch ${name} to a local model" ?disabled=${saving} .value=${""}
        @change=${(e: Event) => void switchToLocal(agentId, (e.target as HTMLSelectElement).value)}>
        <option value="">${saving ? "Switching…" : "Switch to a local model"}</option>
        ${providers.map((p) => html`<optgroup label=${p}>${c.local!.filter((m) => m.provider === p).map((m) => html`<option value=${m.ref}>${m.label}</option>`)}</optgroup>`)}
      </select>
    </label>${err}`;
}

function secureCardRow(v: AgentView) {
  if (!lastSec.on) return nothing;
  const r = lastSec.byId.get(v.id);
  if (!r) return nothing;
  const canSwitch = r.kind === "blocked" && !v.virtual && Boolean(lastState?.agentsManagementState?.agents.some((a) => a.id === v.id));
  return html`<div class="agp-sm-row">${secureChip(r)}${canSwitch ? localPicker(v.id, v.name) : nothing}</div>`;
}

function renderSecureSection(v: AgentView, props: AgentsPremiumProps) {
  const { state, client } = props;
  const legacy = state.agentsManagementState?.agents.find((a) => a.id === v.id) ?? null;
  if (!legacy && !lastSec.on) return nothing;
  if (getSecureState().supported === false) return nothing;
  const secureOnly = legacy?.secureOnly === true;
  const r = lastSec.byId.get(v.id) ?? null;
  const showReadiness = (lastSec.on || secureOnly) && r;
  const isCli = v.virtual || legacy?.type === "cli";
  const policy = getSecureState().status?.agentPolicy === true;
  const saving = ui.secureSaving === v.id;
  const note = !legacy
    ? "Only configured agents have a Secure Mode policy."
    : isCli
      ? "CLI agents never run in Secure Mode."
      : !policy
        ? "Needs the gateway restarted onto the build with per-agent Secure Mode."
        : "Every run of this agent goes to the encrypted secure lane; normal-lane runs are refused.";
  return html`<section class="agp-secure ${lastSec.on || secureOnly ? "is-on" : ""}" data-secure-agent-section aria-label="Secure Mode for ${v.name}">
    <div class="agp-secure-head">
      <span class="agp-secure-title">${icons.shield}<span>Secure Mode</span></span>
      ${showReadiness ? secureChip(r!) : nothing}
    </div>
    ${showReadiness && r!.kind === "blocked"
      ? html`<p class="agp-secure-reason">${r!.reason}</p>${legacy && !isCli ? html`<div class="agp-sm-row">${localPicker(v.id, v.name)}</div>` : nothing}`
      : showReadiness && r!.kind === "cli"
        ? html`<p class="agp-secure-reason">${r!.reason}</p>`
        : nothing}
    ${legacy
      ? html`<ib-secure-toggle
          mode="custom"
          compact
          data-secure-agent-policy
          label="Always run in Secure Mode"
          hint="Normal-lane runs of this agent are refused"
          .on=${secureOnly}
          .busy=${saving}
          .disabled=${isCli || (!policy && !secureOnly)}
          .note=${note}
          .error=${ui.secureError?.id === v.id && ui.secureError.text.startsWith("policy:") ? ui.secureError.text.slice(7) : null}
          @secure-toggle=${async (e: CustomEvent<{ on: boolean }>) => {
            if (ui.secureSaving) return;
            ui.secureSaving = v.id;
            ui.secureError = null;
            rerender();
            try {
              await updateAgentSecureOnly(client, v.id, e.detail.on);
              await loadAgentsList(state, client);
            } catch (err) {
              ui.secureError = { id: v.id, text: `policy:${err instanceof Error ? err.message : String(err)}` };
            } finally {
              ui.secureSaving = null;
              rerender();
            }
          }}
        ></ib-secure-toggle>
        <span class="agp-secure-note">${note}</span>`
      : nothing}
  </section>`;
}

// ─── Drawer ──────────────────────────────────────────────────────────────

function renderDrawer(v: AgentView, views: AgentView[], edges: AgentEdge[], props: AgentsPremiumProps, now: number) {
  const { state } = props;
  const legacy = state.agentsManagementState?.agents.find((a) => a.id === v.id) ?? null;
  const tabs: Array<{ id: DrawerTab; label: string; badge?: string }> = [
    { id: "overview", label: "Overview" },
    { id: "performance", label: "Performance" },
    { id: "tools", label: "Tools & Skills" },
    { id: "memory", label: "Memory" },
    { id: "channels", label: "Channels" },
    { id: "settings", label: "Settings" },
    { id: "voice", label: "Voice" },
    { id: "logs", label: "Logs", badge: String(agentsLive.activity.filter((a) => a.agentId === v.id).length || "") },
  ];
  return html`
    <aside class="agp-drawer" aria-label="${v.name} details">
      <div class="agp-dr-head">
        ${avatar(v, "lg")}
        <div class="agp-dr-id">
          <div class="agp-dr-name">${v.emoji ? html`<span class="agp-emoji">${v.emoji}</span>` : nothing}${v.name}</div>
          <div class="agp-dr-role">${v.role || "—"}</div>
          <div class="agp-dr-chips">
            <span class="agp-pill agp-pill--${v.state}">${STATE_LABEL[v.state]}</span>
            ${backendChip(v)}
            <span class="agp-tag agp-tag--muted">${v.group.label}</span>
            <code class="agp-tag agp-tag--mono">${v.id}</code>
          </div>
        </div>
        <button class="agp-btn agp-icon agp-dr-close" aria-label="Close details" @click=${() => select(null)}>${I.close}</button>
      </div>
      ${renderQuickActions(v, props)}
      ${renderSecureSection(v, props)}
      <nav class="agp-tabs" role="tablist" aria-label="Agent detail sections">
        ${tabs.map((t) => html`<button role="tab" aria-selected=${ui.tab === t.id} class=${ui.tab === t.id ? "on" : ""}
          @click=${() => { ui.tab = t.id; rerender(); }}>${t.label}${t.badge ? html`<b>${t.badge}</b>` : nothing}</button>`)}
      </nav>
      <div class="agp-dr-body" role="tabpanel">
        ${ui.tab === "overview" ? renderOverview(v, views, edges, props, now) : nothing}
        ${ui.tab === "performance" ? renderPerformance(v, now) : nothing}
        ${ui.tab === "tools" ? renderTools(v, legacy) : nothing}
        ${ui.tab === "memory" ? renderMemory(v, now, props) : nothing}
        ${ui.tab === "channels" ? renderChannels(v, legacy, now) : nothing}
        ${ui.tab === "settings" ? renderSettings(v, legacy, props) : nothing}
        ${ui.tab === "voice" ? renderVoice(v, props) : nothing}
        ${ui.tab === "logs" ? renderLogs(v, legacy, props, now) : nothing}
      </div>
    </aside>
  `;
}

function openChat(state: AppViewState, sessionKey: string) {
  try { state.setTab("chat" as never); } catch { (state as unknown as { tab: string }).tab = "chat"; }
  void import("../controllers/chat.js").then(({ switchChatSession }) => {
    try { switchChatSession(state as never, sessionKey); } catch (err) { console.warn("[agents] switchChatSession failed:", err); }
  });
  state.requestUpdate?.();
}

function renderQuickActions(v: AgentView, props: AgentsPremiumProps) {
  const { state, client } = props;
  // Secure Mode on (or a secureOnly agent): chat / tasks / runs open a secure
  // session (secure.session.new), never a normal one.
  const secureLane = lastSec.on || isSecureOnly(v.id, state);
  const readiness = secureLane ? (lastSec.byId.get(v.id) ?? null) : null;
  const secureBlock = !secureLane
    ? null
    : !readiness || readiness.kind === "checking"
      ? "Checking whether this agent's model is local…"
      : readiness.kind === "ready"
        ? null
        : readiness.kind === "cli"
          ? readiness.reason
          : `Remote model — blocked in Secure Mode. ${readiness.reason}`;
  const running = agentsLive.runs.filter((r) => (r.agentId === v.id || (v.virtual && r.backend === v.backend)) && (r.state === "running" || r.state === "continuing"));
  const setNotice = (kind: "ok" | "err", text: string) => { ui.notice = { kind, text }; rerender(); };
  const submit = async () => {
    const text = ui.composerText.trim();
    if (!text || ui.busy) return;
    ui.busy = true;
    rerender();
    try {
      if (secureLane) {
        const sessionKey = await openSecureSessionFor(v.id);
        await client.request("chat.send", {
          sessionKey,
          message: text,
          idempotencyKey: `agents-page-sec-${v.id}-${Date.now().toString(36)}`,
        });
        setNotice("ok", `Started a secure session for ${v.name} (local model, encrypted). Follow along in Chat.`);
      } else if (ui.composer === "assign") {
        await client.request("chat.send", {
          sessionKey: `agent:${v.id}:main`,
          message: text,
          idempotencyKey: `agents-page-${v.id}-${Date.now().toString(36)}`,
        });
        setNotice("ok", `Sent to ${v.name}. Follow along in Chat.`);
      } else {
        const res = (await client.request("sessions.spawn", v.virtual
          ? { task: text, label: text.slice(0, 60), coderBackend: v.backend }
          : { task: text, agentId: v.id, label: text.slice(0, 60) })) as { runId?: string } | undefined;
        setNotice("ok", `Spawned${res?.runId ? ` run ${res.runId}` : ""}. It will appear under Overview.`);
        void loadAgentsLive(client, { full: false });
      }
      ui.composer = null;
      ui.composerText = "";
    } catch (err) {
      setNotice("err", err instanceof Error ? err.message : String(err));
    } finally {
      ui.busy = false;
      rerender();
    }
  };
  const stopRuns = async () => {
    if (!running.length) return;
    if (!confirm(`Stop ${running.length} running run${running.length === 1 ? "" : "s"} for ${v.name}?`)) return;
    ui.busy = true;
    rerender();
    let stopped = 0;
    for (const r of running) {
      try {
        const res = (await client.request("subagents.stop", { runId: r.runId })) as { ok?: boolean } | undefined;
        if (res?.ok !== false) stopped++;
      } catch { /* reported below */ }
    }
    ui.busy = false;
    setNotice(stopped === running.length ? "ok" : "err", `Stopped ${stopped} of ${running.length}.`);
    void loadAgentsLive(client, { full: false });
  };
  return html`
    <div class="agp-qa">
      ${secureLane
        ? html`<button class="agp-btn agp-btn--secure" data-secure-chat ?disabled=${Boolean(secureBlock) || ui.busy} title=${secureBlock ?? "Open a new secure chat with this agent (local model, encrypted)"}
              @click=${async () => {
                try {
                  const key = await openSecureSessionFor(v.id);
                  openChat(state, key);
                } catch (err) {
                  setNotice("err", err instanceof Error ? err.message : String(err));
                }
              }}>${icons.lock}<span>Secure chat</span></button>
            <button class="agp-btn agp-btn--secure ${ui.composer === "assign" ? "on" : ""}" ?disabled=${Boolean(secureBlock)} title=${secureBlock ?? "Send a task to a new secure session"} @click=${() => { ui.composer = ui.composer === "assign" ? null : "assign"; ui.notice = null; rerender(); }}>${I.task}<span>Assign task</span></button>
            <button class="agp-btn agp-btn--secure ${ui.composer === "spawn" ? "on" : ""}" ?disabled=${Boolean(secureBlock)} title=${secureBlock ?? "Start a run in a new secure session"} @click=${() => { ui.composer = ui.composer === "spawn" ? null : "spawn"; ui.notice = null; rerender(); }}>${I.spawn}<span>Start</span></button>`
        : html`<button class="agp-btn" ?disabled=${v.virtual} title=${v.virtual ? "CLI backends have no chat session" : "Open this agent's main chat"} @click=${() => openChat(state, `agent:${v.id}:main`)}>${I.chat}<span>Chat</span></button>
      <button class="agp-btn ${ui.composer === "assign" ? "on" : ""}" ?disabled=${v.virtual} title="Send a task to this agent's main session" @click=${() => { ui.composer = ui.composer === "assign" ? null : "assign"; ui.notice = null; rerender(); }}>${I.task}<span>Assign task</span></button>
      <button class="agp-btn ${ui.composer === "spawn" ? "on" : ""}" title="Spawn a sub-agent run for this agent" @click=${() => { ui.composer = ui.composer === "spawn" ? null : "spawn"; ui.notice = null; rerender(); }}>${I.spawn}<span>Spawn</span></button>`}
      <button class="agp-btn" ?disabled=${!running.length || ui.busy} title=${running.length ? "Pause: stop this agent's running runs" : "Nothing running"} @click=${stopRuns}>${I.stop}<span>Pause${running.length ? ` (${running.length})` : ""}</span></button>
    </div>
    ${ui.composer
      ? html`<form class="agp-composer" @submit=${(e: Event) => { e.preventDefault(); void submit(); }}>
          <label for="agp-composer-text">${secureLane
            ? html`<span class="agp-sm-inline">${icons.lock}Secure session · ${ui.composer === "assign" ? `task for ${v.name}` : `run as ${v.name}`}</span>`
            : ui.composer === "assign" ? `Task for ${v.name}` : `Spawn a run${v.virtual ? ` on ${v.name}` : ` as ${v.name}`}`}</label>
          <textarea id="agp-composer-text" rows="3" placeholder=${ui.composer === "assign" ? "What should this agent do?" : "Describe the task for the sub-agent…"}
            .value=${ui.composerText} @input=${(e: Event) => { ui.composerText = (e.target as HTMLTextAreaElement).value; }}
            @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }}></textarea>
          <div class="agp-composer-row">
            <span class="agp-hint">⌘/Ctrl + Enter to send</span>
            <button type="button" class="agp-btn" @click=${() => { ui.composer = null; rerender(); }}>Cancel</button>
            <button type="submit" class="agp-btn agp-primary" ?disabled=${ui.busy}>${ui.busy ? "Sending…" : secureLane ? (ui.composer === "assign" ? "Send securely" : "Start securely") : ui.composer === "assign" ? "Send task" : "Spawn"}</button>
          </div>
        </form>`
      : nothing}
    ${ui.notice ? html`<div class="agp-notice agp-notice--${ui.notice.kind}" role="status">${ui.notice.text}</div>` : nothing}
  `;
}

function runRow(r: RunLite, now: number) {
  const dur = r.startedAt && r.endedAt ? r.endedAt - r.startedAt : r.startedAt && !r.endedAt ? now - r.startedAt : null;
  return html`<li class="agp-run">
    <span class="agp-verdict agp-tone--${runTone(r.state)}">${RUN_STATE_LABEL[r.state]}</span>
    <div class="agp-run-main">
      <div class="agp-run-label" title=${r.task || r.label}>${r.label}</div>
      <div class="agp-run-meta">${r.backend ? `${BACKEND_LABEL[r.backend] ?? r.backend} · ` : ""}${fmtDuration(dur)} · ${fmtAgo(runTime(r) || null, now)}${r.source === "history" ? " · no verification record" : ""}</div>
      ${r.reasons?.length && runTone(r.state) !== "ok" ? html`<div class="agp-run-why">${r.reasons[0]}</div>` : nothing}
    </div>
  </li>`;
}

function renderOverview(v: AgentView, views: AgentView[], edges: AgentEdge[], props: AgentsPremiumProps, now: number) {
  const cur = v.stats.currentRun;
  const detail = cur ? agentsLive.liveDetails.get(cur.runId) : undefined;
  const feed = agentsLive.activity.filter((a) => a.agentId === v.id).slice(0, 8);
  const name = (id: string) => views.find((x) => x.id === id)?.name ?? id;
  const outgoing = edges.filter((e) => e.from === v.id);
  const incoming = edges.filter((e) => e.to === v.id);
  const profile = agentsLive.profileRaw.get(v.id) as { description?: string; department?: string } | undefined;
  return html`
    <section class="agp-sec">
      <h4>Current run</h4>
      ${cur
        ? html`<div class="agp-current">
            <div class="agp-current-top"><span class="agp-live-dot"></span><b>${cur.label}</b><span class="agp-verdict agp-tone--live">${RUN_STATE_LABEL[cur.state]}</span></div>
            ${cur.task && cur.task !== cur.label ? html`<p class="agp-clamp">${cur.task}</p>` : nothing}
            <div class="agp-progress agp-progress--lg"><i style="width:${Math.max(3, Math.min(100, detail?.progress ?? 0))}%"></i></div>
            <div class="agp-run-meta">${detail?.progress != null ? `${Math.round(detail.progress)}% · ` : ""}started ${fmtAgo(cur.startedAt, now)}${detail?.checkpoint ? ` · ${detail.checkpoint}` : ""}</div>
            ${detail?.lastActivity ? html`<div class="agp-run-why">Now: ${detail.lastActivity}</div>` : nothing}
            ${detail?.updates.length ? html`<ul class="agp-updates">${detail.updates.slice(-4).reverse().map((u) => html`<li><time>${fmtAgo(u.ts, now)}</time>${u.text}</li>`)}</ul>` : nothing}
          </div>`
        : html`<p class="agp-muted">${v.state === "working" ? "In a live chat session (no tracked run)." : "Nothing running right now."}</p>`}
    </section>
    <section class="agp-sec">
      <h4>Live activity</h4>
      ${feed.length
        ? html`<ul class="agp-feed">${feed.map((f) => html`<li class="agp-feed--${f.kind}"><time>${fmtAgo(f.ts, now)}</time><span>${f.text}</span></li>`)}</ul>`
        : html`<p class="agp-muted">Waiting for events — tool calls, replies, spawns and completions show up here as they happen.</p>`}
    </section>
    <section class="agp-sec">
      <div class="agp-sec-h"><h4>Recent runs</h4>
        <button class="agp-link" @click=${() => { try { props.state.setTab("reviews" as never); } catch { /* no-op */ } props.state.requestUpdate?.(); }}>All reviews ${I.arrow}</button></div>
      ${v.stats.recent.length
        ? html`<ul class="agp-runs">${v.stats.recent.slice(0, 8).map((r) => runRow(r, now))}</ul>`
        : html`<p class="agp-muted">No runs recorded for this agent in the last 14 days.</p>`}
    </section>
    <section class="agp-sec">
      <h4>Relationships</h4>
      ${outgoing.length || incoming.length
        ? html`<div class="agp-rel">
            ${outgoing.length ? html`<div><span class="agp-rel-h">Delegates to</span>${outgoing.map((e) => html`<button class="agp-tag agp-tag--btn" @click=${() => select(e.to)}>${name(e.to)}${e.weight ? html`<b>${e.weight}</b>` : html`<i>config</i>`}</button>`)}</div>` : nothing}
            ${incoming.length ? html`<div><span class="agp-rel-h">Receives work from</span>${incoming.map((e) => html`<button class="agp-tag agp-tag--btn" @click=${() => select(e.from)}>${name(e.from)}${e.weight ? html`<b>${e.weight}</b>` : html`<i>config</i>`}</button>`)}</div>` : nothing}
          </div>`
        : html`<p class="agp-muted">No delegation observed or configured.</p>`}
    </section>
    ${profile?.description ? html`<section class="agp-sec"><h4>About</h4><p>${profile.description}</p>${profile.department ? html`<p class="agp-muted">Team: ${profile.department}</p>` : nothing}</section>` : nothing}
  `;
}

function renderPerformance(v: AgentView, now: number) {
  const s = v.stats;
  const week =
    spendByAgent(agentsLive.spendWeek).get(v.id) ??
    (v.backend ? agentsLive.backendWeek.find((r) => r.key === v.backend) ?? null : null);
  const max = Math.max(1, ...s.runsByDay);
  const dayLabel = (i: number) => {
    const d = new Date(now - (s.runsByDay.length - 1 - i) * 86_400_000);
    return d.toLocaleDateString(undefined, { weekday: "narrow" });
  };
  const mix = s.verdictMix;
  const mixTotal = mix.verified + mix.unverified + mix.failed + mix.blocked + mix.other;
  const seg = (n: number, cls: string, label: string) =>
    n ? html`<i class=${cls} style="flex:${n}" title="${label}: ${n}"></i>` : nothing;
  return html`
    <div class="agp-tiles">
      <div><b>${s.runs7d}</b><span>runs · 7 days</span></div>
      <div><b>${fmtPct(s.successRate)}</b><span>verified${s.judged ? ` · ${s.judged} judged` : ""}</span></div>
      <div><b>${fmtDuration(s.avgDurationMs)}</b><span>avg duration</span></div>
      <div><b>${v.spendToday ? fmtUsd(v.spendToday.costUsd) : "—"}</b><span>spend today</span></div>
      <div><b>${week ? fmtUsd(week.costUsd) : "—"}</b><span>spend · 7 days</span></div>
      <div><b>${fmtTokens(week?.tokens ?? null)}</b><span>tokens · 7 days</span></div>
    </div>
    <section class="agp-sec">
      <h4>Runs over time <span class="agp-muted">(14 days)</span></h4>
      ${s.runsTotal
        ? html`<div class="agp-bars" role="img" aria-label="Runs per day over 14 days: ${s.runsByDay.join(", ")}">
            ${s.runsByDay.map((n, i) => html`<div class="agp-bar ${i === s.runsByDay.length - 1 ? "today" : ""}" title="${n} run${n === 1 ? "" : "s"}">
              <i style="height:${n ? Math.max(6, (n / max) * 100) : 2}%"></i><span>${dayLabel(i)}</span></div>`)}
          </div>`
        : html`<p class="agp-muted">No runs in the last 14 days.</p>`}
    </section>
    <section class="agp-sec">
      <h4>Verdict mix</h4>
      ${mixTotal
        ? html`<div class="agp-mix">${seg(mix.verified, "ok", "Verified")}${seg(mix.unverified, "warn", "Unverified")}${seg(mix.blocked, "blocked", "Blocked / needs input")}${seg(mix.failed, "bad", "Failed")}${seg(mix.other, "muted", "Completed without a verdict")}</div>
          <ul class="agp-mix-legend">
            <li><i class="ok"></i>Verified <b>${mix.verified}</b></li>
            <li><i class="warn"></i>Unverified <b>${mix.unverified}</b></li>
            <li><i class="blocked"></i>Blocked <b>${mix.blocked}</b></li>
            <li><i class="bad"></i>Failed <b>${mix.failed}</b></li>
            <li><i class="muted"></i>No verdict <b>${mix.other}</b></li>
          </ul>`
        : html`<p class="agp-muted">No finished runs yet.</p>`}
      <p class="agp-hint">Verified % = verified or accepted runs ÷ runs that received a verification verdict. Spend comes from the credits ledger (session-keyed usage).</p>
    </section>
  `;
}

type Caps = {
  tools?: { allowed?: number; total?: number; profile?: string; domains?: Array<{ domain: string; allowed: number; total: number; allowedTools: string[] }> };
  skills?: { mode?: string; enabled?: string[]; count?: number; catalogTotal?: number };
  mcp?: { status?: string; servers?: Array<{ name: string; status: string; toolCount: number; enabledForAgent: boolean }> };
  channels?: Array<{ channel: string; accountId?: string; peer?: string; source: string }>;
  subagents?: { canSpawn?: boolean; allowAgents?: string[]; coders?: string[] };
  access?: Record<string, boolean>;
};

function capsOf(id: string): Caps | null {
  const p = agentsLive.profileRaw.get(id) as { capabilities?: Caps } | undefined;
  return p?.capabilities ?? null;
}

function chips(list: string[], empty: string) {
  return list.length ? html`<div class="agp-chips">${list.map((t) => html`<span class="agp-tag">${t}</span>`)}</div>` : html`<p class="agp-muted">${empty}</p>`;
}

function renderTools(v: AgentView, legacy: AgentListEntry | null) {
  const caps = capsOf(v.id);
  const editBtn = legacy ? html`<button class="agp-link" @click=${() => { ui.tab = "settings"; rerender(); }}>Edit in Settings ${I.arrow}</button>` : nothing;
  if (!caps) {
    return html`
      <section class="agp-sec"><div class="agp-sec-h"><h4>Tools allow-list</h4>${editBtn}</div>${chips(legacy?.tools ?? [], v.virtual ? "CLI backends use their own tool set." : "Uses the default tool profile.")}</section>
      <section class="agp-sec"><h4>Skills</h4>${chips(legacy?.skills ?? [], "No skills pinned.")}</section>
      <section class="agp-sec"><h4>MCP servers</h4>${chips(legacy?.mcps ?? [], "No MCP servers pinned.")}</section>
      ${agentsLive.sourceErrors.profiles ? html`<p class="agp-hint">Resolved capabilities unavailable: ${agentsLive.sourceErrors.profiles}</p>` : nothing}`;
  }
  const access = Object.entries(caps.access ?? {});
  return html`
    ${access.length ? html`<section class="agp-sec"><h4>Access</h4><div class="agp-access">${access.map(([k, on]) => html`<span class="agp-acc ${on ? "on" : ""}">${on ? "✓" : "–"} ${k.replace(/([A-Z])/g, " $1").toLowerCase()}</span>`)}</div></section>` : nothing}
    <section class="agp-sec">
      <div class="agp-sec-h"><h4>Tools <span class="agp-muted">${caps.tools?.allowed ?? "—"} of ${caps.tools?.total ?? "—"} allowed${caps.tools?.profile ? ` · profile ${caps.tools.profile}` : ""}</span></h4>${editBtn}</div>
      ${(caps.tools?.domains ?? []).filter((d) => d.allowed > 0).map((d) => html`
        <details class="agp-domain"><summary><span>${d.domain}</span><span class="agp-meter"><i style="width:${d.total ? (d.allowed / d.total) * 100 : 0}%"></i></span><b>${d.allowed}/${d.total}</b></summary>
          ${chips(d.allowedTools, "")}</details>`)}
    </section>
    <section class="agp-sec">
      <h4>Skills <span class="agp-muted">${caps.skills?.mode === "all" ? `all ${caps.skills?.catalogTotal ?? ""} available` : `${caps.skills?.count ?? 0} enabled`}</span></h4>
      ${caps.skills?.mode === "all" ? html`<p class="agp-muted">Every eligible skill in the catalogue.</p>` : chips(caps.skills?.enabled ?? [], "No skills enabled.")}
    </section>
    <section class="agp-sec">
      <h4>MCP servers</h4>
      ${(caps.mcp?.servers ?? []).length
        ? html`<ul class="agp-list">${caps.mcp!.servers!.map((s) => html`<li><span class="agp-dot ${s.status === "connected" || s.status === "ok" ? "agp-dot--working" : "agp-dot--idle"}"></span><b>${s.name}</b><span class="agp-muted">${s.toolCount} tools · ${s.enabledForAgent ? "enabled" : "not enabled"}</span></li>`)}</ul>`
        : html`<p class="agp-muted">${caps.mcp?.status === "ok" || !caps.mcp?.status ? "No MCP servers." : `MCP ${caps.mcp.status}.`}</p>`}
    </section>
    ${caps.subagents ? html`<section class="agp-sec"><h4>Delegation</h4>
      <p class="agp-muted">${caps.subagents.canSpawn ? "Can spawn sub-agents" : "Cannot spawn sub-agents"}${caps.subagents.coders?.length ? ` · coders: ${caps.subagents.coders.join(", ")}` : ""}</p>
      ${chips(caps.subagents.allowAgents ?? [], "No agent allow-list.")}</section>` : nothing}
  `;
}

function renderMemory(v: AgentView, now: number, props: AgentsPremiumProps) {
  const p = agentsLive.profileRaw.get(v.id) as
    | {
        identity?: { workspace?: string; present?: number; total?: number; files?: Array<{ name: string; exists: boolean; size: number; updatedAt: number | null }> };
        memory?: {
          vector?: { status: string; files: number; chunks: number; provider?: string; model?: string; lastIndexedAt: number | null };
          notebook?: { status: string; memoryMdBytes: number; dailyFiles: number; lastUpdatedAt: number | null };
          transcripts?: { status: string; sessions: number; indexedIntoMemory: boolean; indexedChunks: number };
          sovereign?: { status: string; counts: Record<string, number>; error?: string };
        };
        knowledge?: Array<{ id: string; status: string; count: number | null; reachable: boolean }>;
      }
    | undefined;
  if (!p) {
    return html`<div class="agp-empty agp-empty--inline"><p>${v.virtual ? "CLI backends keep their own memory; nothing is indexed by InfiniBot for them." : agentsLive.sourceErrors.profiles ? `Memory profile unavailable: ${agentsLive.sourceErrors.profiles}` : "Loading memory profile…"}</p></div>`;
  }
  const m = p.memory ?? {};
  const st = (s?: string) => html`<span class="agp-src agp-src--${s ?? "unknown"}">${s ?? "—"}</span>`;
  return html`
    <div class="agp-tiles">
      <div><b>${m.vector ? fmtTokens(m.vector.chunks) : "—"}</b><span>indexed chunks</span></div>
      <div><b>${m.notebook?.dailyFiles ?? "—"}</b><span>daily notes</span></div>
      <div><b>${m.transcripts?.sessions ?? "—"}</b><span>transcripts</span></div>
    </div>
    <section class="agp-sec">
      <h4>Stores</h4>
      <ul class="agp-list">
        <li><b>Semantic index</b>${st(m.vector?.status)}<span class="agp-muted">${m.vector ? `${m.vector.files} files · ${m.vector.chunks} chunks${m.vector.provider ? ` · ${m.vector.provider}` : ""} · indexed ${fmtAgo(m.vector.lastIndexedAt, now)}` : "—"}</span></li>
        <li><b>Notebook</b>${st(m.notebook?.status)}<span class="agp-muted">${m.notebook ? `MEMORY.md ${(m.notebook.memoryMdBytes / 1024).toFixed(1)} KB · ${m.notebook.dailyFiles} daily files · updated ${fmtAgo(m.notebook.lastUpdatedAt, now)}` : "—"}</span></li>
        <li><b>Transcripts</b>${st(m.transcripts?.status)}<span class="agp-muted">${m.transcripts ? `${m.transcripts.sessions} sessions · ${m.transcripts.indexedIntoMemory ? `${m.transcripts.indexedChunks} chunks indexed` : "not indexed"}` : "—"}</span></li>
        <li><b>Shared memory</b>${st(m.sovereign?.status)}<span class="agp-muted">${m.sovereign?.status === "ok" ? Object.entries(m.sovereign.counts).map(([k, n]) => `${n} ${k}`).join(" · ") || "empty" : m.sovereign?.error ?? "—"}</span></li>
      </ul>
    </section>
    <section class="agp-sec">
      <h4>Identity files <span class="agp-muted">${p.identity?.present ?? 0}/${p.identity?.total ?? 0} present</span></h4>
      ${p.identity?.workspace ? html`<p class="agp-hint"><code>${p.identity.workspace}</code></p>` : nothing}
      <div class="agp-chips">${(p.identity?.files ?? []).map((f) => html`<span class="agp-tag ${f.exists ? "" : "agp-tag--muted"}" title=${f.exists ? `${f.size} bytes · updated ${fmtAgo(f.updatedAt, now)}` : "missing"}>${f.name}</span>`)}</div>
    </section>
    ${p.knowledge?.length ? html`<section class="agp-sec"><h4>Knowledge sources</h4>
      <ul class="agp-list">${p.knowledge.map((k) => html`<li><b>${k.id}</b>${st(k.status)}<span class="agp-muted">${k.count ?? "—"} items · ${k.reachable ? "reachable" : "no tool access"}</span></li>`)}</ul></section>` : nothing}
    <button class="agp-btn" @click=${() => { try { props.state.setTab("memory" as never); } catch { /* no-op */ } props.state.requestUpdate?.(); }}>Open Memory page ${I.arrow}</button>
  `;
}

function renderChannels(v: AgentView, legacy: AgentListEntry | null, now: number) {
  const caps = capsOf(v.id);
  const bindings = caps?.channels ?? [];
  const byChannel = new Map<string, { n: number; last: number | null }>();
  for (const s of legacy?.sessions ?? []) {
    const ch = s.channel || "webchat";
    const cur = byChannel.get(ch) ?? { n: 0, last: null };
    cur.n++;
    if (s.updatedAt && (!cur.last || s.updatedAt > cur.last)) cur.last = s.updatedAt;
    byChannel.set(ch, cur);
  }
  return html`
    <section class="agp-sec">
      <h4>Bindings</h4>
      ${bindings.length
        ? html`<ul class="agp-list">${bindings.map((b) => html`<li><b>${b.channel}</b><span class="agp-tag agp-tag--muted">${b.source.replace("-", " ")}</span><span class="agp-muted">${[b.accountId, b.peer].filter(Boolean).join(" · ") || "all accounts"}</span></li>`)}</ul>`
        : html`<p class="agp-muted">${caps ? "No channel bindings — this agent is reached through chat, delegation or the default route." : v.virtual ? "CLI backends are driven by coder spawns, not channels." : "Channel bindings unavailable."}</p>`}
    </section>
    <section class="agp-sec">
      <h4>Sessions by channel <span class="agp-muted">(last 24h)</span></h4>
      ${byChannel.size
        ? html`<ul class="agp-list">${[...byChannel.entries()].sort((a, b) => b[1].n - a[1].n).map(([ch, s]) => html`<li><b>${ch}</b><span class="agp-muted">${s.n} session${s.n === 1 ? "" : "s"} · last ${fmtAgo(s.last, now)}</span></li>`)}</ul>`
        : html`<p class="agp-muted">No sessions in the last 24 hours.</p>`}
    </section>
  `;
}

function renderSettings(v: AgentView, legacy: AgentListEntry | null, props: AgentsPremiumProps) {
  const { editors } = props;
  if (!legacy) {
    return html`<div class="agp-empty agp-empty--inline"><p>${v.virtual
      ? `${v.name} isn't a configured agent: it appears because coder runs used this CLI backend. Add a CLI agent with command "${BACKEND_CLI_COMMAND[v.backend ?? ""] ?? v.backend}" to configure it.`
      : "This agent isn't in the local config."}</p></div>`;
  }
  const isNative = legacy.type !== "cli";
  const block = (title: string, body: unknown, open = false) =>
    html`<details class="agp-set" ?open=${open}><summary>${title}</summary><div class="agp-set-body">${body}</div></details>`;
  return html`
    <div class="agp-set-grid">
      <div><span>Type</span>${editors.typeSelector(legacy)}</div>
      ${isNative ? html`<div><span>Model</span>${editors.modelSelector(legacy)}</div>` : html`<div><span>CLI</span><code>${legacy.cliCommand || "not set"}</code></div>`}
      <div><span>Workspace</span><code>${legacy.workspace || props.state.agentsManagementState?.defaultWorkspace || "—"}</code></div>
    </div>
    ${isNative ? block("Tools allow-list", editors.tools(legacy), true) : block("CLI configuration", editors.cliConfig(legacy), true)}
    ${block("Skills", editors.skills(legacy))}
    ${block("MCP servers", editors.mcps(legacy))}
    ${block("Sub-agents (delegation)", editors.subagents(legacy))}
    ${block("References", editors.references(legacy))}
    ${isNative ? block("System prompt", editors.prompt(legacy)) : nothing}
    <div class="agp-set agp-set--voice">
      <div><b>Voice</b><p class="agp-muted">Voice agent toggle and voice choice live in the Voice tab.</p></div>
      <button class="agp-btn" @click=${() => { ui.tab = "voice"; rerender(); }}>Open Voice ${I.arrow}</button>
    </div>
    <div class="agp-danger">
      ${!legacy.isDefault ? html`<button class="agp-btn" @click=${async () => { await editors.setDefault(legacy.id); rerender(); }}>Make default agent</button>` : html`<span class="agp-muted">Default agent</span>`}
      <button class="agp-btn agp-btn--danger" @click=${async () => {
        if (confirm(`Delete agent "${legacy.id}"?\n\nThis removes it from config but keeps workspace files.`)) {
          await editors.remove(legacy.id);
          select(null);
        }
      }}>Delete agent</button>
    </div>
  `;
}

function renderVoice(v: AgentView, props: AgentsPremiumProps) {
  const body = getAgentVoiceSlot()({ agentId: v.id, agentName: v.name, agentType: v.type, state: props.state, client: props.client, requestUpdate: rerender });
  return html`<div class="agp-voice-slot" data-slot="agent-voice" data-agent-id=${v.id}>${body ?? nothing}</div>`;
}

function renderLogs(v: AgentView, legacy: AgentListEntry | null, props: AgentsPremiumProps, now: number) {
  const feed = agentsLive.activity.filter((a) => a.agentId === v.id).slice(0, 60);
  const failures = v.stats.recent.filter((r) => r.reasons?.length && runTone(r.state) !== "ok").slice(0, 6);
  return html`
    <section class="agp-sec">
      <h4>Event log <span class="agp-muted">(since this page opened)</span></h4>
      ${feed.length
        ? html`<ol class="agp-log">${feed.map((f) => html`<li class="agp-feed--${f.kind}"><time>${new Date(f.ts).toLocaleTimeString()}</time><span class="agp-log-kind">${f.kind}</span><span>${f.text}</span></li>`)}</ol>`
        : html`<p class="agp-muted">No events yet.</p>`}
    </section>
    ${failures.length ? html`<section class="agp-sec"><h4>Recent review notes</h4><ul class="agp-runs">${failures.map((r) => runRow(r, now))}</ul></section>` : nothing}
    ${legacy ? html`<section class="agp-sec agp-legacy"><h4>Sessions</h4>${props.editors.sessions(legacy)}</section>` : nothing}
  `;
}

// ─── Styles (tokens only; light + dark) ──────────────────────────────────

const AGP_CSS = `
/* Full-bleed: the Agents page owns the content area (scoped via :has, no global CSS edits). */
@media (min-width: 761px) {
  .content:has(> .agp-root), .content:has(> * > .agp-root) {
    padding: 0 !important; gap: 0 !important; overflow: hidden !important;
    display: flex; flex-direction: column; min-height: 0;
  }
  :root[data-theme="hud"] .content:has(.agp-root) { margin: 0 !important; border-radius: 0 !important; border: 0 !important; background: transparent !important; box-shadow: none !important; backdrop-filter: none !important; }
  .content:has(.agp-root) > .content-header { flex: none; }
}
.agp-root {
  --agp-gold: var(--g-primary);
  --agp-gold-text: color-mix(in srgb, var(--g-primary) 80%, var(--g-fg));
  --agp-fg: var(--g-fg);
  --agp-dim: var(--g-fg-dim);
  --agp-faint: var(--g-fg-faint);
  --agp-surface: var(--g-surface);
  --agp-surface-2: var(--g-surface-strong);
  --agp-hover: var(--g-surface-hover);
  --agp-border: var(--g-border);
  --agp-border-2: var(--g-border-strong);
  --agp-ok: var(--g-success);
  --agp-warn: var(--g-warning);
  --agp-bad: var(--g-danger);
  --agp-info: var(--g-info);
  --agp-neutral: var(--g-neutral);
  --agp-panel: color-mix(in srgb, var(--g-bg) 72%, transparent);
  --agp-drawer-w: min(460px, 36vw);
  --agp-rail-w: 244px;
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  height: 100%;
  display: grid;
  grid-template-columns: var(--agp-rail-w) minmax(0, 1fr);
  grid-template-rows: auto auto minmax(0, 1fr);
  grid-template-areas: "top top" "banner banner" "rail main";
  color: var(--agp-fg);
  font-family: var(--g-font-family, inherit);
  overflow: hidden;
  /* Own backdrop so shell background layers never show through as seams. */
  background:
    radial-gradient(ellipse 70% 40% at 55% 0%, color-mix(in srgb, var(--agp-gold) 6%, transparent), transparent 70%),
    var(--g-bg);
}
:root[data-theme="light"] .agp-root { --agp-gold-text: color-mix(in srgb, var(--g-primary) 42%, var(--g-fg)); --agp-panel: color-mix(in srgb, var(--g-bg) 80%, white); }
.agp-root.has-drawer { grid-template-columns: var(--agp-rail-w) minmax(0, 1fr) var(--agp-drawer-w); grid-template-areas: "top top top" "banner banner banner" "rail main drawer"; }

/* Top bar + KPI strip */
.agp-top { grid-area: top; display: flex; align-items: center; gap: 18px; padding: 14px 18px 12px; border-bottom: 1px solid var(--agp-border);
  background: linear-gradient(180deg, color-mix(in srgb, var(--agp-gold) 7%, transparent), transparent); }
.agp-title { min-width: 180px; }
.agp-eyebrow { font-size: 10px; letter-spacing: .22em; text-transform: uppercase; color: var(--agp-gold-text); font-weight: 700; }
.agp-title h1 { margin: 2px 0 2px; font-size: 20px; font-weight: 700; letter-spacing: -.01em; color: var(--agp-fg); }
.agp-sub { font-size: 12px; color: var(--agp-dim); }
.agp-kpis { flex: 1; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; min-width: 0; }
.agp-kpi { padding: 10px 14px; border-radius: 12px; border: 1px solid var(--agp-border); background: var(--agp-surface); min-width: 0; position: relative; overflow: hidden; }
.agp-kpi::after { content: ""; position: absolute; inset: 0 0 auto 0; height: 2px; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--agp-gold) 55%, transparent), transparent); opacity: .7; }
.agp-kpi--ok::after { background: linear-gradient(90deg, transparent, var(--agp-ok), transparent); }
.agp-kpi--warn::after { background: linear-gradient(90deg, transparent, var(--agp-warn), transparent); }
.agp-kpi--bad::after { background: linear-gradient(90deg, transparent, var(--agp-bad), transparent); }
.agp-kpi-label { font-size: 10.5px; text-transform: uppercase; letter-spacing: .12em; color: var(--agp-dim); display: flex; align-items: center; gap: 6px; }
.agp-kpi-value { font-size: 24px; font-weight: 700; line-height: 1.15; font-variant-numeric: tabular-nums; color: var(--agp-fg); }
.agp-kpi-sub { font-size: 11px; color: var(--agp-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agp-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

/* Buttons, chips, pills */
.agp-btn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--agp-border);
  background: var(--agp-surface); color: var(--agp-fg); font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; white-space: nowrap;
  transition: border-color .15s ease, background .15s ease, transform .15s ease, color .15s ease; }
.agp-btn:hover:not(:disabled) { border-color: var(--agp-border-2); background: var(--agp-hover); color: var(--agp-gold-text); }
.agp-btn:active:not(:disabled) { transform: translateY(1px); }
.agp-btn:disabled { opacity: .45; cursor: not-allowed; }
.agp-btn:focus-visible, .agp-card:focus-visible, .agp-chip:focus-visible, .agp-rail-item:focus-visible, .agp-tabs button:focus-visible, .agp-seg button:focus-visible, .agp-cx:focus-visible { outline: 2px solid var(--agp-gold); outline-offset: 2px; }
.agp-btn.on { border-color: var(--agp-gold); color: var(--agp-gold-text); }
.agp-icon { width: 34px; padding: 0; justify-content: center; }
.agp-primary { background: var(--agp-gold); color: var(--g-bg); border-color: transparent; }
.agp-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--agp-gold) 88%, white); color: var(--g-bg); }
:root[data-theme="light"] .agp-primary { color: var(--g-fg); }
.agp-btn--danger { color: var(--agp-bad); border-color: color-mix(in srgb, var(--agp-bad) 40%, transparent); }
.agp-btn--danger:hover:not(:disabled) { color: var(--agp-bad); background: color-mix(in srgb, var(--agp-bad) 10%, transparent); }
.agp-link { background: none; border: 0; padding: 0; color: var(--agp-gold-text); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.agp-link:hover { text-decoration: underline; }
.agp-seg { display: inline-flex; padding: 3px; border-radius: 11px; border: 1px solid var(--agp-border); background: var(--agp-surface); }
.agp-seg button { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--agp-dim); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
.agp-seg button.on { background: color-mix(in srgb, var(--agp-gold) 16%, transparent); color: var(--agp-gold-text); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--agp-gold) 35%, transparent); }
.agp-only-mobile { display: none; }
.agp-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; background: var(--agp-gold); }
.agp-dot--working { background: var(--agp-ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--agp-ok) 22%, transparent); }
.agp-dot--blocked { background: var(--agp-warn); }
.agp-dot--error { background: var(--agp-bad); }
.agp-dot--idle { background: color-mix(in srgb, var(--agp-gold) 75%, transparent); }
.agp-dot--disabled { background: var(--agp-neutral); }
.agp-live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--agp-ok); display: inline-block; flex: none; animation: agp-breathe 1.8s ease-in-out infinite; }
@keyframes agp-breathe { 0%,100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--agp-ok) 55%, transparent); } 50% { box-shadow: 0 0 0 5px transparent; } }
.agp-pill { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 999px; font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap;
  color: var(--agp-gold-text); background: color-mix(in srgb, var(--agp-gold) 12%, transparent); border: 1px solid color-mix(in srgb, var(--agp-gold) 26%, transparent); }
.agp-pill--working { color: var(--agp-ok); background: color-mix(in srgb, var(--agp-ok) 12%, transparent); border-color: color-mix(in srgb, var(--agp-ok) 35%, transparent); }
.agp-pill--blocked { color: var(--agp-warn); background: color-mix(in srgb, var(--agp-warn) 12%, transparent); border-color: color-mix(in srgb, var(--agp-warn) 35%, transparent); }
.agp-pill--error { color: var(--agp-bad); background: color-mix(in srgb, var(--agp-bad) 12%, transparent); border-color: color-mix(in srgb, var(--agp-bad) 35%, transparent); }
.agp-pill--disabled { color: var(--agp-neutral); background: color-mix(in srgb, var(--agp-neutral) 12%, transparent); border-color: color-mix(in srgb, var(--agp-neutral) 35%, transparent); }
.agp-tag { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; height: 22px; padding: 0 8px; border-radius: 7px; font-size: 11px; font-weight: 600; color: var(--agp-fg);
  background: var(--agp-surface-2); border: 1px solid var(--agp-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agp-tag svg { flex: none; color: var(--agp-gold-text); }
.agp-tag--muted { color: var(--agp-dim); background: transparent; }
.agp-tag--plugin { color: var(--agp-gold-text); border-color: color-mix(in srgb, var(--agp-gold) 30%, transparent); background: color-mix(in srgb, var(--agp-gold) 8%, transparent); }
.agp-tag--mono { font-family: var(--mono, ui-monospace, monospace); font-weight: 500; color: var(--agp-dim); }
.agp-tag--btn { cursor: pointer; font: inherit; font-size: 11px; font-weight: 600; }
.agp-tag--btn:hover { border-color: var(--agp-gold); }
.agp-tag--btn b { color: var(--agp-gold-text); } .agp-tag--btn i { color: var(--agp-faint); font-style: normal; font-weight: 500; }
.agp-badge { margin-left: 6px; font-size: 9.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; padding: 1px 6px; border-radius: 5px; color: var(--agp-gold-text); border: 1px solid color-mix(in srgb, var(--agp-gold) 35%, transparent); vertical-align: 2px; }
.agp-emoji { margin-right: 6px; }
.agp-muted { color: var(--agp-dim); font-weight: 400; }
.agp-hint { color: var(--agp-faint); font-size: 11.5px; }
.agp-banner { grid-area: banner; margin: 8px 18px 0; padding: 8px 12px; border-radius: 10px; font-size: 12.5px; color: var(--agp-warn); border: 1px solid color-mix(in srgb, var(--agp-warn) 35%, transparent); background: color-mix(in srgb, var(--agp-warn) 8%, transparent); }
.agp-banner--bad { color: var(--agp-bad); border-color: color-mix(in srgb, var(--agp-bad) 40%, transparent); background: color-mix(in srgb, var(--agp-bad) 8%, transparent); }

/* Rail */
.agp-rail { grid-area: rail; min-height: 0; overflow-y: auto; padding: 14px 12px 20px; border-right: 1px solid var(--agp-border); display: flex; flex-direction: column; gap: 16px; background: color-mix(in srgb, var(--agp-surface) 60%, transparent); }
.agp-search { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 10px; border-radius: 10px; border: 1px solid var(--agp-border); background: var(--agp-surface); color: var(--agp-dim); }
.agp-search:focus-within { border-color: var(--agp-gold); }
.agp-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--agp-fg); font: inherit; font-size: 13px; }
.agp-rail-sec { display: flex; flex-direction: column; gap: 2px; }
.agp-rail-h { font-size: 10px; font-weight: 700; letter-spacing: .18em; text-transform: uppercase; color: var(--agp-faint); padding: 0 8px 6px; }
.agp-rail-item { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 34px; padding: 0 8px; border: 0; border-radius: 9px; background: transparent; color: var(--agp-fg); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.agp-rail-item:hover { background: var(--agp-hover); }
.agp-rail-item.on { background: color-mix(in srgb, var(--agp-gold) 14%, transparent); color: var(--agp-gold-text); box-shadow: inset 2px 0 0 var(--agp-gold); }
.agp-rail-item.is-sub { padding-left: 30px; font-size: 12.5px; color: var(--agp-dim); min-height: 30px; }
.agp-rail-item.is-sub.on { color: var(--agp-gold-text); }
.agp-rail-ico { display: inline-flex; color: var(--agp-gold-text); opacity: .85; }
.agp-rail-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agp-rail-count { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--agp-faint); }
.agp-rail-live { font-size: 10px; font-weight: 700; padding: 0 6px; border-radius: 999px; color: var(--agp-ok); background: color-mix(in srgb, var(--agp-ok) 14%, transparent); }
.agp-status-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 4px; }
.agp-chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--agp-border); background: var(--agp-surface); color: var(--agp-fg); font: inherit; font-size: 12px; cursor: pointer; }
.agp-chip b { font-weight: 600; color: var(--agp-faint); font-variant-numeric: tabular-nums; }
.agp-chip.on { border-color: var(--agp-gold); color: var(--agp-gold-text); background: color-mix(in srgb, var(--agp-gold) 12%, transparent); }
.agp-legend { font-size: 11.5px; color: var(--agp-dim); gap: 6px; padding: 0 4px; }
.agp-legend > div:not(.agp-rail-h) { display: flex; align-items: center; gap: 8px; padding-left: 4px; }
.agp-legend .agp-rail-h { padding-left: 4px; }
.agp-legend-note { color: var(--agp-faint) !important; line-height: 1.4; }
.agp-line { width: 18px; height: 0; border-top: 2px solid color-mix(in srgb, var(--agp-gold) 70%, transparent); flex: none; }
.agp-line--dash { border-top: 1.5px dashed var(--agp-faint); }

/* Main */
.agp-main { grid-area: main; min-height: 0; min-width: 0; position: relative; overflow: hidden; display: flex; flex-direction: column; }
.agp-root[data-view="grid"] .agp-main { overflow-y: auto; }
.agp-cx-wrap { position: relative; flex: 1; min-height: 0; }
.agp-cx-host { position: absolute; inset: 0; overflow: hidden;
  background: radial-gradient(ellipse 60% 55% at 50% 45%, color-mix(in srgb, var(--agp-gold) 7%, transparent), transparent 70%); }
.agp-cx-host::before { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .5;
  background-image: radial-gradient(circle, color-mix(in srgb, var(--agp-fg) 16%, transparent) 1px, transparent 1.2px); background-size: 34px 34px;
  mask-image: radial-gradient(ellipse at center, black 30%, transparent 78%); -webkit-mask-image: radial-gradient(ellipse at center, black 30%, transparent 78%); }
.agp-cx-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.agp-cx-host.agp-cx--3d { background: #070604; }
.agp-cx-host.agp-cx--3d::before { display: none; }
.agp-cx-host.agp-cx--3d .agp-cx-canvas { touch-action: none; outline: none; }
.agp-cx-host.agp-cx--3d .agp-cx-tip { color: #f3f4f6; background: rgba(8, 9, 16, 0.86); }
.agp-cx-host.agp-cx--3d .agp-cx-mini { background: rgba(8, 9, 16, 0.6); border-color: rgba(255,255,255,0.1); }
.agp-cx-host.agp-cx--3d::after { content: ""; position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 0 120px 20px rgba(3, 4, 10, 0.55); }
.agp-cx-mode { font-size: 11px; font-weight: 700; letter-spacing: .04em; }
.agp-cx-mini { position: absolute; right: 14px; bottom: 14px; border-radius: 10px; border: 1px solid var(--agp-border); background: var(--agp-panel); backdrop-filter: blur(10px); cursor: crosshair; box-shadow: var(--g-shadow-sm); }
.agp-cx-controls { position: absolute; right: 14px; top: 14px; display: flex; flex-direction: column; gap: 6px; }
.agp-cx-controls .agp-btn { background: var(--agp-panel); backdrop-filter: blur(10px); }
.agp-cx-filter { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); padding: 6px 12px; border-radius: 999px; font-size: 12px; color: var(--agp-dim); background: var(--agp-panel); border: 1px solid var(--agp-border); backdrop-filter: blur(10px); }
.agp-cx-tip { position: absolute; left: 0; top: 0; width: 260px; padding: 12px 14px; border-radius: 12px; pointer-events: none; opacity: 0; transition: opacity .12s ease;
  background: color-mix(in srgb, var(--g-bg) 93%, transparent); border: 1px solid var(--agp-border-2); backdrop-filter: blur(16px) saturate(160%); box-shadow: var(--g-shadow); color: var(--agp-fg); z-index: 3; font-size: 12.5px; }
:root[data-theme="light"] .agp-cx-tip { background: color-mix(in srgb, white 92%, transparent); }
.agp-cx-tip.is-on { opacity: 1; }
.agp-cx-tip-head { display: flex; align-items: center; gap: 8px; }
.agp-cx-tip-head strong { flex: 1; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agp-cx-tip-head .agp-pill { height: 18px; font-size: 9.5px; }
.agp-cx-tip-role { color: var(--agp-dim); margin: 4px 0 8px; line-height: 1.35; }
.agp-cx-tip-grid { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin: 0; }
.agp-cx-tip-grid dt { color: var(--agp-faint); } .agp-cx-tip-grid dd { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agp-cx-tip-hint { margin-top: 8px; font-size: 10.5px; color: var(--agp-gold-text); letter-spacing: .04em; }
.agp-tone--ok { color: var(--agp-ok); } .agp-tone--warn { color: var(--agp-warn); } .agp-tone--bad { color: var(--agp-bad); } .agp-tone--live { color: var(--agp-info); } .agp-tone--muted { color: var(--agp-dim); }

/* Card grid */
.agp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; padding: 16px 18px 28px; align-content: start; }
.agp-card { position: relative; display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: 16px; border: 1px solid var(--agp-border); background: var(--g-gradient-surface, var(--agp-surface)); cursor: pointer;
  transition: border-color .18s ease, transform .18s ease, box-shadow .18s ease; min-width: 0; }
.agp-card::before { content: ""; position: absolute; inset: 0 14px auto; height: 1px; background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--agp-gold) 45%, transparent), transparent); }
.agp-card:hover { border-color: var(--agp-border-2); transform: translateY(-2px); box-shadow: var(--g-shadow-sm); }
.agp-card.on { border-color: var(--agp-gold); box-shadow: 0 0 0 1px color-mix(in srgb, var(--agp-gold) 40%, transparent), var(--g-shadow-sm); }
.agp-card--working { border-color: color-mix(in srgb, var(--agp-ok) 35%, var(--agp-border)); }
.agp-card--error { border-color: color-mix(in srgb, var(--agp-bad) 35%, var(--agp-border)); }
.agp-card--blocked { border-color: color-mix(in srgb, var(--agp-warn) 35%, var(--agp-border)); }
.agp-card-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.agp-card-id { flex: 1; min-width: 0; }
.agp-card-name { font-size: 14.5px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agp-card-role { font-size: 12px; color: var(--agp-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agp-card-tags { display: flex; gap: 6px; flex-wrap: wrap; min-width: 0; }
.agp-card-now { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 22px; font-size: 12px; }
.agp-now-label { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agp-now-label.is-muted { color: var(--agp-dim); }
.agp-progress { width: 100%; height: 4px; border-radius: 99px; background: var(--agp-surface-2); overflow: hidden; }
.agp-progress i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--agp-ok), color-mix(in srgb, var(--agp-ok) 50%, var(--agp-gold))); transition: width .6s ease; }
.agp-progress--lg { height: 6px; margin: 8px 0 6px; }
.agp-verdict { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 6px; font-size: 10.5px; font-weight: 700; letter-spacing: .03em; white-space: nowrap; background: color-mix(in srgb, currentColor 11%, transparent); border: 1px solid color-mix(in srgb, currentColor 28%, transparent); }
.agp-card-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; padding-top: 10px; border-top: 1px solid var(--agp-border); }
.agp-card-stats div { display: flex; flex-direction: column; min-width: 0; }
.agp-card-stats b { font-size: 14px; font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agp-card-stats span { font-size: 11px; color: var(--agp-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agp-card-foot { display: flex; align-items: center; gap: 8px; font-size: 10px; color: var(--agp-faint); text-transform: uppercase; letter-spacing: .06em; }
.agp-spark { width: 96px; height: 20px; flex: none; }
.agp-spark rect { fill: color-mix(in srgb, var(--agp-gold) 55%, transparent); } .agp-spark rect.zero { fill: var(--agp-border); } .agp-spark rect.today { fill: var(--agp-gold); }

/* Avatars */
.agp-av { flex: none; display: inline-grid; place-items: center; border-radius: 12px; overflow: hidden; font-weight: 800; letter-spacing: .02em; color: var(--agp-gold-text);
  background: linear-gradient(140deg, color-mix(in srgb, var(--agp-gold) 26%, var(--g-bg)), color-mix(in srgb, var(--g-accent) 16%, var(--g-bg)));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--agp-gold) 30%, transparent); }
:root[data-theme="light"] .agp-av { background: linear-gradient(140deg, color-mix(in srgb, var(--agp-gold) 22%, white), color-mix(in srgb, var(--g-accent) 14%, white)); }
.agp-av img { width: 100%; height: 100%; object-fit: cover; }
.agp-av--sm { width: 28px; height: 28px; font-size: 11px; border-radius: 8px; }
.agp-av--md { width: 40px; height: 40px; font-size: 14px; }
.agp-av--lg { width: 56px; height: 56px; font-size: 19px; border-radius: 16px; }
.agp-av--working { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--agp-ok) 60%, transparent), 0 0 0 3px color-mix(in srgb, var(--agp-ok) 16%, transparent); }
.agp-av--error { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--agp-bad) 60%, transparent); }
.agp-av--blocked { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--agp-warn) 60%, transparent); }

/* Drawer */
.agp-drawer { grid-area: drawer; min-height: 0; display: flex; flex-direction: column; border-left: 1px solid var(--agp-border); background: var(--agp-panel); backdrop-filter: var(--g-blur, blur(14px)); animation: agp-slide .22s ease-out; overflow: hidden; }
@keyframes agp-slide { from { transform: translateX(16px); opacity: 0; } to { transform: none; opacity: 1; } }
.agp-dr-head { display: flex; gap: 12px; padding: 16px 16px 12px; align-items: flex-start; }
.agp-dr-id { flex: 1; min-width: 0; }
.agp-dr-name { font-size: 18px; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agp-dr-role { font-size: 12.5px; color: var(--agp-dim); margin: 2px 0 8px; }
.agp-dr-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.agp-dr-close { flex: none; }
.agp-qa { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; padding: 0 16px 12px; }
.agp-qa .agp-btn { justify-content: center; padding: 0 6px; font-size: 12px; }
.agp-composer { margin: 0 16px 12px; padding: 12px; border-radius: 12px; border: 1px solid var(--agp-border-2); background: var(--agp-surface); display: flex; flex-direction: column; gap: 8px; }
.agp-composer label { font-size: 12px; font-weight: 700; color: var(--agp-gold-text); }
.agp-composer textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 64px; padding: 8px 10px; border-radius: 9px; border: 1px solid var(--agp-border); background: var(--agp-surface-2); color: var(--agp-fg); font: inherit; font-size: 13px; }
.agp-composer textarea:focus { outline: none; border-color: var(--agp-gold); }
.agp-composer-row { display: flex; align-items: center; gap: 8px; } .agp-composer-row .agp-hint { flex: 1; }
.agp-notice { margin: 0 16px 12px; padding: 8px 12px; border-radius: 10px; font-size: 12.5px; }
.agp-notice--ok { color: var(--agp-ok); background: color-mix(in srgb, var(--agp-ok) 10%, transparent); border: 1px solid color-mix(in srgb, var(--agp-ok) 30%, transparent); }
.agp-notice--err { color: var(--agp-bad); background: color-mix(in srgb, var(--agp-bad) 10%, transparent); border: 1px solid color-mix(in srgb, var(--agp-bad) 30%, transparent); }
.agp-tabs { display: flex; flex-wrap: wrap; gap: 0 2px; padding: 0 10px; border-bottom: 1px solid var(--agp-border); flex: none; }
.agp-tabs::-webkit-scrollbar { display: none; }
.agp-tabs button { position: relative; flex: none; height: 34px; padding: 0 9px; border: 0; background: transparent; color: var(--agp-dim); font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.agp-tabs button:hover { color: var(--agp-fg); }
.agp-tabs button.on { color: var(--agp-gold-text); }
.agp-tabs button.on::after { content: ""; position: absolute; left: 8px; right: 8px; bottom: -1px; height: 2px; border-radius: 2px; background: var(--agp-gold); }
.agp-tabs b { font-size: 10px; padding: 0 5px; border-radius: 99px; background: var(--agp-surface-2); color: var(--agp-dim); }
.agp-dr-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px 28px; display: flex; flex-direction: column; gap: 16px; font-size: 13px; }
.agp-sec h4 { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--agp-dim); }
.agp-sec h4 .agp-muted { text-transform: none; letter-spacing: 0; font-weight: 500; }
.agp-sec p { margin: 0 0 6px; line-height: 1.5; }
.agp-sec-h { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.agp-current { padding: 12px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--agp-ok) 30%, var(--agp-border)); background: color-mix(in srgb, var(--agp-ok) 5%, var(--agp-surface)); }
.agp-current-top { display: flex; align-items: center; gap: 8px; } .agp-current-top b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agp-clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; color: var(--agp-dim); margin: 6px 0 0 !important; font-size: 12.5px; }
.agp-updates, .agp-feed, .agp-runs, .agp-list, .agp-log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.agp-updates { margin-top: 8px; gap: 4px; font-size: 12px; } .agp-updates time { color: var(--agp-faint); margin-right: 8px; font-size: 11px; }
.agp-feed { gap: 0; }
.agp-feed li, .agp-log li { display: flex; gap: 10px; padding: 6px 0; border-bottom: 1px dashed var(--agp-border); font-size: 12.5px; align-items: baseline; }
.agp-feed time, .agp-log time { flex: none; width: 64px; color: var(--agp-faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.agp-feed--spawn span:last-child { color: var(--agp-gold-text); } .agp-feed--complete span:last-child { color: var(--agp-ok); } .agp-feed--error span:last-child { color: var(--agp-bad); }
.agp-log-kind { flex: none; width: 72px; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--agp-dim); }
.agp-runs { gap: 8px; }
.agp-run { display: flex; gap: 10px; align-items: flex-start; padding: 10px; border-radius: 11px; border: 1px solid var(--agp-border); background: var(--agp-surface); }
.agp-run-main { flex: 1; min-width: 0; }
.agp-run-label { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agp-run-meta { font-size: 11.5px; color: var(--agp-faint); margin-top: 2px; }
.agp-run-why { font-size: 11.5px; color: var(--agp-dim); margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.agp-rel { display: flex; flex-direction: column; gap: 10px; } .agp-rel > div { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.agp-rel-h { width: 100%; font-size: 11.5px; color: var(--agp-faint); }
.agp-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.agp-tiles > div { padding: 10px 12px; border-radius: 12px; border: 1px solid var(--agp-border); background: var(--agp-surface); display: flex; flex-direction: column; min-width: 0; }
.agp-tiles b { font-size: 18px; font-variant-numeric: tabular-nums; }
.agp-tiles span { font-size: 10.5px; color: var(--agp-faint); text-transform: uppercase; letter-spacing: .06em; }
.agp-bars { display: grid; grid-template-columns: repeat(14, minmax(0, 1fr)); gap: 5px; height: 130px; align-items: end; }
.agp-bar { height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 4px; }
.agp-bar i { width: 100%; border-radius: 5px 5px 2px 2px; background: linear-gradient(180deg, color-mix(in srgb, var(--agp-gold) 85%, transparent), color-mix(in srgb, var(--agp-gold) 35%, transparent)); transition: height .5s ease; }
.agp-bar.today i { background: linear-gradient(180deg, var(--agp-ok), color-mix(in srgb, var(--agp-ok) 40%, transparent)); }
.agp-bar span { font-size: 10px; color: var(--agp-faint); }
.agp-mix { display: flex; height: 12px; border-radius: 99px; overflow: hidden; gap: 2px; background: var(--agp-surface-2); }
.agp-mix i, .agp-mix-legend i { display: block; } .agp-mix i.ok, .agp-mix-legend i.ok { background: var(--agp-ok); } .agp-mix i.warn, .agp-mix-legend i.warn { background: color-mix(in srgb, var(--agp-warn) 70%, var(--agp-gold)); }
.agp-mix i.blocked, .agp-mix-legend i.blocked { background: var(--agp-warn); } .agp-mix i.bad, .agp-mix-legend i.bad { background: var(--agp-bad); } .agp-mix i.muted, .agp-mix-legend i.muted { background: var(--agp-neutral); }
.agp-mix-legend { list-style: none; padding: 0; margin: 10px 0 8px; display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--agp-dim); }
.agp-mix-legend li { display: flex; align-items: center; gap: 6px; } .agp-mix-legend i { width: 9px; height: 9px; border-radius: 3px; } .agp-mix-legend b { color: var(--agp-fg); }
.agp-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.agp-list { gap: 6px; }
.agp-list li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--agp-border); background: var(--agp-surface); font-size: 12.5px; }
.agp-list li .agp-muted { flex-basis: 100%; font-size: 11.5px; }
.agp-src { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; padding: 1px 6px; border-radius: 5px; color: var(--agp-dim); border: 1px solid var(--agp-border); }
.agp-src--ok { color: var(--agp-ok); border-color: color-mix(in srgb, var(--agp-ok) 35%, transparent); }
.agp-src--error, .agp-src--offline { color: var(--agp-bad); border-color: color-mix(in srgb, var(--agp-bad) 35%, transparent); }
.agp-access { display: flex; flex-wrap: wrap; gap: 6px; }
.agp-acc { font-size: 11.5px; padding: 3px 8px; border-radius: 7px; color: var(--agp-faint); border: 1px dashed var(--agp-border); text-transform: capitalize; }
.agp-acc.on { color: var(--agp-fg); border-style: solid; background: var(--agp-surface-2); }
.agp-domain { border: 1px solid var(--agp-border); border-radius: 10px; margin-bottom: 6px; background: var(--agp-surface); }
.agp-domain summary { display: flex; align-items: center; gap: 10px; padding: 8px 10px; cursor: pointer; font-size: 12.5px; list-style: none; }
.agp-domain summary span:first-child { width: 110px; flex: none; text-transform: capitalize; font-weight: 600; }
.agp-domain .agp-chips { padding: 0 10px 10px; }
.agp-meter { flex: 1; height: 5px; border-radius: 99px; background: var(--agp-surface-2); overflow: hidden; } .agp-meter i { display: block; height: 100%; background: var(--agp-gold); }
.agp-domain b { font-size: 11px; color: var(--agp-dim); font-variant-numeric: tabular-nums; }
.agp-set-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.agp-set-grid > div { display: flex; flex-direction: column; gap: 4px; padding: 10px; border-radius: 10px; border: 1px solid var(--agp-border); background: var(--agp-surface); min-width: 0; }
.agp-set-grid span { font-size: 10.5px; color: var(--agp-faint); text-transform: uppercase; letter-spacing: .08em; }
.agp-set-grid code { font-size: 11.5px; overflow-wrap: anywhere; color: var(--agp-fg); }
.agp-set { border: 1px solid var(--agp-border); border-radius: 12px; background: var(--agp-surface); overflow: hidden; }
.agp-set > summary { padding: 11px 14px; font-weight: 700; font-size: 13px; cursor: pointer; }
.agp-set > summary:hover { color: var(--agp-gold-text); }
.agp-set-body { border-top: 1px solid var(--agp-border); max-height: 560px; overflow: auto; }
.agp-set--voice { display: flex; align-items: center; gap: 12px; padding: 12px 14px; } .agp-set--voice > div { flex: 1; } .agp-set--voice p { margin: 2px 0 0; font-size: 12px; }
.agp-danger { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding-top: 12px; border-top: 1px dashed var(--agp-border); }
.agp-voice-slot { display: flex; flex-direction: column; gap: 12px; }

/* Empty / loading */
.agp-empty { margin: auto; max-width: 420px; text-align: center; padding: 40px 20px; color: var(--agp-dim); display: flex; flex-direction: column; align-items: center; gap: 10px; }
.agp-empty h3 { margin: 0; color: var(--agp-fg); font-size: 16px; }
.agp-empty p { margin: 0; line-height: 1.5; }
.agp-empty--inline { margin: 0; max-width: none; padding: 22px 14px; border: 1px dashed var(--agp-border); border-radius: 12px; }
.agp-spinner { width: 28px; height: 28px; border-radius: 50%; border: 2px solid var(--agp-border); border-top-color: var(--agp-gold); animation: agp-spin .9s linear infinite; }
@keyframes agp-spin { to { transform: rotate(360deg); } }
.agp-scrim { display: none; }

/* Legacy editors inside Settings: keep them on-theme */
.agp-set-body .hud-tabs, .agp-legacy .hud-tabs { background: transparent; }
.agp-set-body button, .agp-legacy button { font-family: inherit; }

/* ── Responsive ───────────────────────────── */
/* Secure Mode (shared emerald tokens from secure-mode/styles.ts) */
.agp-banners { grid-area: banner; display: flex; flex-direction: column; min-width: 0; }
.agp-banners:empty { display: none; }
.agp-banners .agp-banner { grid-area: auto; }
.agp-root--secure .agp-top { box-shadow: inset 0 -1px 0 var(--ib-secure-ring); background: linear-gradient(180deg, var(--ib-secure-soft), transparent); }
.agp-sm-badge { margin-left: 10px; vertical-align: 3px; }
.agp-sm-count { color: var(--ib-secure); font-weight: 600; }
.agp-banner--secure { display: flex; align-items: center; gap: 10px; color: var(--agp-fg); border-color: var(--ib-secure-ring); background: var(--ib-secure-soft); }
.agp-banner--secure b { color: var(--ib-secure); }
.agp-banner--secure > span:nth-child(2) { flex: 1; min-width: 0; }
.agp-sm-banner-ico { display: inline-flex; color: var(--ib-secure); }
.agp-sm-banner-ico svg { width: 16px; height: 16px; }
.agp-btn--secure { border-color: var(--ib-secure-ring) !important; color: var(--ib-secure) !important; }
.agp-btn--secure:hover:not(:disabled) { background: var(--ib-secure-soft) !important; }
.agp-btn--secure svg { width: 15px; height: 15px; }
.agp-sm-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.agp-sm { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; min-height: 22px; padding: 0 8px; border-radius: 999px; font-size: 11px; font-weight: 650; letter-spacing: .01em; white-space: nowrap; border: 1px solid; }
.agp-sm > span { overflow: hidden; text-overflow: ellipsis; }
.agp-sm svg { width: 12px; height: 12px; flex: none; }
.agp-sm--ok { color: var(--ib-secure); background: var(--ib-secure-soft); border-color: var(--ib-secure-ring); box-shadow: var(--ib-secure-glow); }
.agp-sm--bad { color: var(--agp-bad); background: color-mix(in srgb, var(--agp-bad) 9%, transparent); border-color: color-mix(in srgb, var(--agp-bad) 38%, transparent); }
.agp-sm--muted { color: var(--agp-dim); border-color: var(--agp-border); border-style: dashed; }
.agp-sm-pick { position: relative; display: inline-flex; align-items: center; gap: 5px; min-height: 24px; padding: 0 4px 0 8px; border-radius: 999px; color: var(--ib-secure); border: 1px solid var(--ib-secure-ring); background: color-mix(in srgb, var(--ib-secure) 6%, transparent); cursor: pointer; max-width: 100%; }
.agp-sm-pick:hover, .agp-sm-pick:focus-within { background: var(--ib-secure-soft); }
.agp-sm-pick svg { width: 12px; height: 12px; flex: none; }
.agp-sm-pick select { appearance: none; -webkit-appearance: none; border: 0; background: transparent; color: inherit; font: inherit; font-size: 11px; font-weight: 650; padding: 0 14px 0 0; cursor: pointer; min-width: 0; max-width: 220px; text-overflow: ellipsis;
  background-image: linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%); background-position: right 5px top 50%, right 1px top 50%; background-size: 4px 4px; background-repeat: no-repeat; }
.agp-sm-pick select:focus-visible { outline: none; }
.agp-sm-pick:focus-within { outline: 2px solid var(--ib-secure); outline-offset: 1px; }
.agp-sm-pick select option, .agp-sm-pick select optgroup { color: var(--g-fg); background: var(--g-bg); }
.agp-sm-pick.is-busy svg { animation: agp-sec-spin 1s linear infinite; }
@keyframes agp-sec-spin { to { transform: rotate(360deg); } }
.agp-sm-note { font-size: 11px; color: var(--agp-dim); }
.agp-sm-err { flex-basis: 100%; font-size: 11.5px; color: var(--agp-bad); }
.agp-sm-inline { display: inline-flex; align-items: center; gap: 6px; color: var(--ib-secure); }
.agp-sm-inline svg { width: 13px; height: 13px; }
.agp-card .agp-sm-row { margin-top: -2px; }
.agp-secure { margin: 0 16px 12px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--agp-border); background: var(--agp-surface); display: flex; flex-direction: column; gap: 8px; }
.agp-secure.is-on { border-color: var(--ib-secure-ring); background: color-mix(in srgb, var(--ib-secure) 5%, var(--agp-surface)); }
.agp-secure-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: space-between; }
.agp-secure-title { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: var(--agp-dim); }
.agp-secure.is-on .agp-secure-title { color: var(--ib-secure); }
.agp-secure-title svg { width: 14px; height: 14px; }
.agp-secure-reason { margin: 0; font-size: 12px; line-height: 1.45; color: var(--agp-dim); }
.agp-secure-note { font-size: 11px; color: var(--agp-faint); line-height: 1.4; }
.agp-secure ib-secure-toggle { align-self: flex-start; }
@media (prefers-reduced-motion: reduce) { .agp-sm-pick.is-busy svg { animation: none; } }
@media (max-width: 1440px) { .agp-root { --agp-rail-w: 224px; --agp-drawer-w: min(430px, 38vw); } .agp-kpi-value { font-size: 21px; } }
@media (max-width: 1280px) {
  .agp-top { flex-wrap: wrap; }
  .agp-kpis { order: 3; flex-basis: 100%; }
}
@media (max-width: 1100px) {
  .agp-root.has-drawer { grid-template-columns: var(--agp-rail-w) minmax(0, 1fr); grid-template-areas: "top top" "banner banner" "rail main"; }
  .agp-drawer { position: absolute; right: 0; top: 0; bottom: 0; width: min(460px, 92vw); z-index: 20; box-shadow: var(--g-shadow-lg); background: color-mix(in srgb, var(--g-bg) 94%, transparent); }
}
@media (max-width: 760px) {
  .agp-root { display: flex; flex-direction: column; height: auto; min-height: 100%; overflow: visible; }
  .agp-top { padding: 12px 12px 10px; gap: 10px; }
  .agp-title { min-width: 0; flex: 1; }
  .agp-title h1 { font-size: 18px; }
  .agp-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .agp-kpi { padding: 8px 10px; } .agp-kpi-value { font-size: 19px; }
  .agp-actions { flex-basis: 100%; justify-content: flex-start; }
  .agp-actions .agp-seg span, .agp-actions .agp-primary span { display: none; }
  .agp-actions .agp-primary { width: 34px; padding: 0; justify-content: center; }
  .agp-actions .agp-seg { flex: 1; } .agp-seg button { flex: 1; justify-content: center; }
  .agp-only-mobile { display: inline-flex; }
  /* In-page layers (not position:fixed): the content pane is its own stacking
     context, so fixed layers would slide under the app's top bar. */
  .agp-root { position: relative; }
  .agp-rail { position: absolute; left: 0; top: 0; bottom: auto; height: calc(100dvh - 120px); min-height: 520px; width: min(300px, 86vw); z-index: 31; transform: translateX(-102%); transition: transform .22s ease; background: var(--g-bg); box-shadow: var(--g-shadow-lg); }
  .agp-root.rail-open .agp-rail { transform: none; }
  .agp-scrim { display: block; position: absolute; inset: 0; z-index: 30; background: color-mix(in srgb, black 45%, transparent); }
  .agp-main { overflow: visible; }
  .agp-cx-wrap { height: calc(100dvh - 230px); min-height: 420px; flex: none; }
  .agp-grid { grid-template-columns: minmax(0, 1fr); padding: 12px; gap: 10px; }
  /* Full-screen sheet above the app chrome (top bar / dock). */
  .agp-drawer { position: absolute; top: 0; left: 0; right: 0; bottom: auto; height: calc(100dvh - 120px); min-height: 520px; width: auto; z-index: 32; border-left: 0; animation: agp-rise .22s ease-out; background: var(--g-bg); overflow: hidden; }
  @keyframes agp-rise { from { transform: translateY(20px); opacity: 0; } to { transform: none; opacity: 1; } }
  .agp-qa { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .agp-banner--secure { flex-wrap: wrap; align-items: flex-start; }
  .agp-banner--secure > span:nth-child(2) { flex: 1 1 calc(100% - 30px); }
  .agp-banner--secure > .agp-btn { margin-left: 26px; }
  .agp-sm-badge > span { display: none; }
  .agp-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .agp-cx-mini { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .agp-root *, .agp-root *::before, .agp-root *::after { animation: none !important; transition: none !important; }
}
`;

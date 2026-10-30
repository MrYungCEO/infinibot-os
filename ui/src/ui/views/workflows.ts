/**
 * Workflows View — premium glass gallery of workflow cards, a run timeline,
 * live autonomous-control loops, and a glass drawer for create / edit
 * (markdown editor with Notion sync + visual flow preview).
 *
 * Styles: ./workflows-glass.css (page-scoped under `.wfg`).
 */

import { html, nothing, svg } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { toSanitizedMarkdownHtml } from "../markdown";
import "../components/doc-agent-panel.js";
import "../components/import-upload.js";
import "./workflows-glass.css";
import {
  type WfFilter,
  STATUS_LABEL,
  ago,
  daemonFor,
  fmtDuration,
  parseSteps,
  previewStepCount,
  runDurationMs,
  runsFor,
  statusOf,
} from "./workflows-model";
import type {
  WorkflowItem,
  WorkflowsState,
  WorkflowInputDef,
  WorkflowPreflightIssue,
  WorkflowRun,
} from "../controllers/workflows";
import {
  loadWorkflows,
  loadWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  syncWorkflowToNotion,
  startCreateWorkflow,
  openRunDialog,
  closeRunDialog,
  setRunInput,
  runPreflight,
  startRun,
  cancelRun,
  loadRecentRuns,
  loadLiveDaemons,
  stopContinuous,
  pauseContinuous,
  resumeContinuous,
} from "../controllers/workflows";

// ── Icons (inline SVG, stroke = currentColor) ────────────────

const svgAttrs = `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
const ICONS = {
  search: `<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  play: `<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>`,
  loop: `<path d="M17 2.5 20.5 6 17 9.5"/><path d="M3.5 11V9.5A3.5 3.5 0 0 1 7 6h13.5"/><path d="M7 21.5 3.5 18 7 14.5"/><path d="M20.5 13v1.5A3.5 3.5 0 0 1 17 18H3.5"/>`,
  bolt: `<path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12z"/>`,
  external: `<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>`,
  trash: `<path d="M3.5 6h17"/><path d="M8.5 6V4.5A1.5 1.5 0 0 1 10 3h4a1.5 1.5 0 0 1 1.5 1.5V6"/><path d="M18.5 6l-.8 13a2 2 0 0 1-2 1.9H8.3a2 2 0 0 1-2-1.9L5.5 6"/>`,
  save: `<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z"/><path d="M8 3v5h7V3"/><path d="M8 21v-7h8v7"/>`,
  edit: `<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>`,
  eye: `<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>`,
  close: `<path d="M6 6l12 12M18 6 6 18"/>`,
  terminal: `<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7 9 3 3-3 3M13 15h4"/>`,
  chat: `<path d="M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>`,
  pause: `<path d="M8 5v14M16 5v14"/>`,
  stop: `<rect x="6" y="6" width="12" height="12" rx="2"/>`,
  refresh: `<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>`,
  check: `<path d="m5 12.5 4.5 4.5L19 7.5"/>`,
  alert: `<path d="M12 3 2 20.5h20z"/><path d="M12 10v4.5M12 17.6v.1"/>`,
  x: `<path d="M7 7l10 10M17 7 7 17"/>`,
  sync: `<path d="M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 12a9 9 0 0 1 15.4-6.4L21 8"/><path d="M3 21v-5h5M21 3v5h-5"/>`,
  link: `<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>`,
  flow: `<rect x="3" y="3.5" width="6" height="6" rx="1.5"/><rect x="15" y="14.5" width="6" height="6" rx="1.5"/><path d="M9 6.5h3.5a2 2 0 0 1 2 2v6"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  agent: `<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>`,
  spark: `<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>`,
  timeline: `<path d="M6 4v16"/><circle cx="6" cy="7" r="2"/><circle cx="6" cy="17" r="2"/><path d="M11 7h9M11 17h6"/>`,
  gateway: `<path d="M12 2.5 21 7.5v9L12 21.5 3 16.5v-9z"/><path d="M12 12 21 7.5M12 12v9.5M12 12 3 7.5"/>`,
} as const;
type IconName = keyof typeof ICONS;
const iconCache = new Map<IconName, ReturnType<typeof unsafeHTML>>();
function icon(name: IconName) {
  let hit = iconCache.get(name);
  if (!hit) {
    hit = unsafeHTML(`<svg ${svgAttrs}>${ICONS[name]}</svg>`);
    iconCache.set(name, hit);
  }
  return hit;
}

// ── View-local UI state (filters are client-side; search hits the gateway) ──


const ui: { filter: WfFilter; openingId: string | null } = {
  filter: "all",
  openingId: null,
};

// ── Polling ──────────────────────────────────────────────────

// Cached poller so we don't fire a poll storm on every re-render. Daemons
// refresh every 3s; the run timeline every 15s.
let daemonPollHandle: number | null = null;
let pollTick = 0;
function ensureDaemonPolling(state: AppViewState, client: GatewayBrowserClient) {
  if (daemonPollHandle !== null) return;
  void loadLiveDaemons(state, client);
  void loadRecentRuns(state, client);
  daemonPollHandle = window.setInterval(() => {
    void loadLiveDaemons(state, client);
    pollTick += 1;
    if (pollTick % 5 === 0) void loadRecentRuns(state, client);
  }, 3000);
}

// "/" focuses the search field while this page is mounted.
let keysBound = false;
function bindShortcuts() {
  if (keysBound) return;
  keysBound = true;
  window.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = (e.composedPath()[0] ?? e.target) as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const el = document.querySelector<HTMLInputElement>(".wfg-search input");
    if (!el) return;
    e.preventDefault();
    el.focus();
  });
}

// ── Derived data helpers ─────────────────────────────────────

function triggerIcon(wf: WorkflowItem): { name: IconName; label: string } {
  return wf.kind === "continuous"
    ? { name: "loop", label: "Continuous loop" }
    : { name: "bolt", label: "Manual trigger" };
}

// ── Main Render ──────────────────────────────────────────────

export function renderWorkflows(state: AppViewState, client: GatewayBrowserClient) {
  const ws = state.workflowsState;
  if (!ws) {
    return html`<div class="wfg"><div class="wfg-stage">
      <div class="wfg-grid">${[0, 1, 2].map(() => html`<div class="wfg-skel"></div>`)}</div>
    </div></div>`;
  }
  ensureDaemonPolling(state, client);
  bindShortcuts();
  const drawerOpen = !!(ws.selected || ws.isCreating);

  return html`
    <div class="wfg">
      <div class="wfg-stage">
        ${renderHero(ws, state, client)}
        ${!drawerOpen ? renderBanners(ws, state) : nothing}
        ${renderToolbar(ws, state, client)}
        <div class="wfg-layout">
          <section aria-label="Workflows">${renderGallery(ws, state, client)}</section>
          <aside class="wfg-aside" aria-label="Activity">
            ${renderLiveDaemonsPanel(ws, state, client)}
            ${renderRunTimelinePanel(ws, state, client)}
          </aside>
        </div>
      </div>
      ${drawerOpen ? renderDrawer(ws, state, client) : nothing}
      ${renderRunDialog(ws, state, client)}
    </div>
    ${ws.selected
      ? html`<doc-agent-panel
          .client=${client}
          docType="workflow"
          .documentId=${ws.selected.id}
          .title=${ws.selected.name}
          .content=${ws.editorBody || ws.selected.body || ""}
        ></doc-agent-panel>`
      : nothing}
  `;
}

// ── Hero ─────────────────────────────────────────────────────

function renderHero(ws: WorkflowsState, state: AppViewState, client: GatewayBrowserClient) {
  const total = ws.workflows.length;
  const loops = ws.workflows.filter((w) => w.kind === "continuous").length;
  const live = (ws.liveDaemons ?? []).filter((d) => !d.stopped).length;
  const finished = (ws.recentRuns ?? []).filter((r) =>
    r.status === "completed" || r.status === "failed" || r.status === "timeout",
  );
  const okRuns = finished.filter((r) => r.status === "completed").length;
  const rate = finished.length ? Math.round((okRuns / finished.length) * 100) : null;
  const failing = ws.workflows.filter((w) => statusOf(ws, w) === "failed").length;
  const parentPageId = state.notionSyncStatus?.parentPageId;

  return html`
    <header class="wfg-hero">
      <div class="wfg-aurora" aria-hidden="true"></div>
      <div class="wfg-hero__grain" aria-hidden="true"></div>
      <div>
        <span class="wfg-eyebrow"><i class="wfg-eyebrow__dot"></i>Automation studio</span>
        <h1 class="wfg-title">Work<em>flows</em></h1>
        <p class="wfg-sub">
          Reusable playbooks your agents run on demand or as autonomous loops.
          Preflight every run, watch it live, and keep Notion in sync. Agents can
          reach them in chat with <code class="wfg-code">/workflows</code>.
        </p>
      </div>
      <div class="wfg-hero__actions">
        ${parentPageId
          ? html`<a
              class="wfg-btn"
              href="https://notion.so/${parentPageId.replace(/-/g, "")}"
              target="_blank"
              rel="noreferrer"
              title="Open workspace in Notion"
            >${icon("external")} Notion</a>`
          : nothing}
        <import-upload
          .client=${client}
          method="workflows.import"
          noun="workflow"
          accept=".json,.md,.markdown"
          label="Import workflow"
          @imported=${async () => {
            await loadWorkflows(state, client);
            state.requestUpdate?.();
          }}
        ></import-upload>
        <button
          class="wfg-btn wfg-btn--primary wfg-btn--lg"
          @click=${() => {
            startCreateWorkflow(state);
            state.requestUpdate?.();
          }}
        >${icon("plus")} New workflow</button>
      </div>
      <div class="wfg-stats" role="list">
        <div class="wfg-stat" role="listitem">
          <div class="wfg-stat__label">Workflows</div>
          <div class="wfg-stat__value">${total}<small>${loops} loop${loops === 1 ? "" : "s"}</small></div>
        </div>
        <div class="wfg-stat wfg-stat--gold" role="listitem">
          <div class="wfg-stat__label">Live loops</div>
          <div class="wfg-stat__value">${live}</div>
        </div>
        <div class="wfg-stat" role="listitem">
          <div class="wfg-stat__label">Success rate</div>
          <div class="wfg-stat__value">${rate === null ? "—" : `${rate}%`}<small>${finished.length} run${finished.length === 1 ? "" : "s"}</small></div>
        </div>
        <div class="wfg-stat ${failing ? "wfg-stat--bad" : ""}" role="listitem">
          <div class="wfg-stat__label">Needs attention</div>
          <div class="wfg-stat__value">${failing}</div>
        </div>
      </div>
    </header>
  `;
}

function renderBanners(ws: WorkflowsState, state: AppViewState) {
  return html`
    ${ws.error
      ? html`<div class="wfg-banner wfg-banner--bad" role="alert">
          ${icon("alert")}<span>${ws.error}</span>
          <button class="wfg-btn wfg-btn--ghost wfg-btn--sm wfg-btn--icon" aria-label="Dismiss error"
            @click=${() => { ws.error = null; state.requestUpdate?.(); }}>${icon("x")}</button>
        </div>`
      : nothing}
    ${ws.successMessage
      ? html`<div class="wfg-banner" role="status">${icon("check")}<span>${ws.successMessage}</span></div>`
      : nothing}
  `;
}

// ── Toolbar: search + filters ────────────────────────────────

function renderToolbar(ws: WorkflowsState, state: AppViewState, client: GatewayBrowserClient) {
  const counts: Record<WfFilter, number> = {
    all: ws.workflows.length,
    loops: ws.workflows.filter((w) => w.kind === "continuous").length,
    oneshot: ws.workflows.filter((w) => w.kind !== "continuous").length,
    running: ws.workflows.filter((w) => {
      const s = statusOf(ws, w);
      return s === "running" || s === "paused";
    }).length,
    failed: ws.workflows.filter((w) => statusOf(ws, w) === "failed").length,
    notion: ws.workflows.filter((w) => !!w.notionPageId).length,
  };
  const filters: Array<[WfFilter, string]> = [
    ["all", "All"],
    ["running", "Running"],
    ["failed", "Failed"],
    ["loops", "Loops"],
    ["oneshot", "One-shot"],
    ["notion", "Notion"],
  ];
  return html`
    <div class="wfg-toolbar">
      <label class="wfg-search">
        ${icon("search")}
        <input
          type="search"
          placeholder="Search workflows, tags, steps…"
          aria-label="Search workflows"
          .value=${ws.searchQuery}
          @input=${async (e: Event) => {
            ws.searchQuery = (e.target as HTMLInputElement).value;
            await loadWorkflows(state, client);
            state.requestUpdate?.();
          }}
        />
        <span class="wfg-search__kbd" aria-hidden="true">/</span>
      </label>
      <div class="wfg-filters" role="group" aria-label="Filter workflows">
        ${filters.map(
          ([key, label]) => html`<button
            class="wfg-filter"
            aria-pressed=${ui.filter === key ? "true" : "false"}
            @click=${() => { ui.filter = key; state.requestUpdate?.(); }}
          >${label}<span class="wfg-filter__n">${counts[key]}</span></button>`,
        )}
      </div>
    </div>
  `;
}

function applyFilter(ws: WorkflowsState, list: WorkflowItem[]): WorkflowItem[] {
  switch (ui.filter) {
    case "loops":
      return list.filter((w) => w.kind === "continuous");
    case "oneshot":
      return list.filter((w) => w.kind !== "continuous");
    case "running":
      return list.filter((w) => {
        const s = statusOf(ws, w);
        return s === "running" || s === "paused";
      });
    case "failed":
      return list.filter((w) => statusOf(ws, w) === "failed");
    case "notion":
      return list.filter((w) => !!w.notionPageId);
    default:
      return list;
  }
}

// ── Gallery ──────────────────────────────────────────────────

function renderGallery(ws: WorkflowsState, state: AppViewState, client: GatewayBrowserClient) {
  if (ws.loading && ws.workflows.length === 0) {
    return html`
      <h2 class="wfg-section-head">Library</h2>
      <div class="wfg-grid" aria-busy="true" aria-label="Loading workflows">
        ${[0, 1, 2, 3, 4, 5].map(() => html`<div class="wfg-skel"></div>`)}
      </div>
    `;
  }
  if (ws.workflows.length === 0) {
    return html`
      <div class="wfg-empty">
        <div>
          <div class="wfg-empty__orb">${icon("flow")}</div>
          <h3>${ws.searchQuery ? "No workflows match your search" : "No workflows yet"}</h3>
          <p>
            ${ws.searchQuery
              ? html`Nothing matches “${ws.searchQuery}”. Try a different name, tag or step.`
              : html`Capture a repeatable process once — inputs, requirements and steps — and let any agent run it. Use <code>/workflows</code> in chat to reach them.`}
          </p>
          ${ws.searchQuery
            ? html`<button class="wfg-btn" @click=${async () => {
                ws.searchQuery = "";
                await loadWorkflows(state, client);
                state.requestUpdate?.();
              }}>${icon("x")} Clear search</button>`
            : html`<button class="wfg-btn wfg-btn--primary wfg-btn--lg" @click=${() => {
                startCreateWorkflow(state);
                state.requestUpdate?.();
              }}>${icon("plus")} Create your first workflow</button>`}
        </div>
      </div>
    `;
  }
  const list = applyFilter(ws, ws.workflows);
  return html`
    <h2 class="wfg-section-head">
      Library <span class="wfg-section-head__n">${list.length}</span>
    </h2>
    ${list.length === 0
      ? html`<div class="wfg-empty">
          <div>
            <div class="wfg-empty__orb">${icon("search")}</div>
            <h3>Nothing in this view</h3>
            <p>No workflows match the “${ui.filter}” filter right now.</p>
            <button class="wfg-btn" @click=${() => { ui.filter = "all"; state.requestUpdate?.(); }}>Show all workflows</button>
          </div>
        </div>`
      : html`<div class="wfg-grid">
          ${list.map((wf, i) => renderCard(wf, i, ws, state, client))}
        </div>`}
  `;
}

function renderCard(
  wf: WorkflowItem,
  i: number,
  ws: WorkflowsState,
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  const isSelected = ws.selected?.id === wf.id;
  const status = statusOf(ws, wf);
  const runs = runsFor(ws, wf.id);
  const last = runs[0];
  const daemon = daemonFor(ws, wf.id);
  const trig = triggerIcon(wf);
  const steps = previewStepCount(wf.preview);
  const next =
    wf.kind === "continuous"
      ? daemon
        ? daemon.paused
          ? "Paused"
          : `Iteration ${daemon.iterationCount + 1}`
        : "Loop idle"
      : "On demand";

  const open = async () => {
    if (ws.dirty && (ws.selected || ws.isCreating) && ws.selected?.id !== wf.id) {
      if (!confirm("Discard unsaved changes?")) return;
    }
    ui.openingId = wf.id;
    state.requestUpdate?.();
    try {
      await loadWorkflow(state, client, wf.id);
    } finally {
      ui.openingId = null;
      state.requestUpdate?.();
    }
  };

  return html`
    <article
      class="wfg-card ${isSelected ? "is-selected" : ""}"
      data-status=${status}
      style="--i:${Math.min(i, 12)}"
      tabindex="0"
      role="button"
      aria-label="Open workflow ${wf.name}"
      aria-busy=${ui.openingId === wf.id ? "true" : "false"}
      @click=${open}
      @keydown=${(e: KeyboardEvent) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void open();
        }
      }}
      @pointermove=${(e: PointerEvent) => {
        const el = e.currentTarget as HTMLElement;
        const r = el.getBoundingClientRect();
        el.style.setProperty("--mx", `${Math.round(e.clientX - r.left)}px`);
      }}
    >
      <span class="wfg-card__rail" aria-hidden="true"></span>
      <div class="wfg-card__top">
        <span class="wfg-trigger" title=${trig.label} aria-label=${trig.label}>${icon(trig.name)}</span>
        <div class="wfg-card__title">
          <h3 class="wfg-card__name" title=${wf.name}>${wf.name}</h3>
          <div class="wfg-card__meta">
            ${wf.kind === "continuous" ? html`<span>Loop</span>` : html`<span>One-shot</span>`}
            <span aria-hidden="true">·</span>
            <span>${(wf.bodyLength / 1000).toFixed(1)}k chars</span>
            ${wf.notionPageId
              ? html`<span aria-hidden="true">·</span><span title="Synced to Notion" aria-label="Synced to Notion" style="display:inline-flex;color:var(--wf-gold);">${icon("link")}</span>`
              : nothing}
          </div>
        </div>
        <span class="wfg-chip" data-s=${status}><i class="wfg-chip__dot"></i>${ui.openingId === wf.id ? "Opening…" : STATUS_LABEL[status]}</span>
      </div>

      <p class="wfg-card__desc">${wf.description || html`<span style="color:var(--wf-fg-4)">No description</span>`}</p>

      ${steps.n > 0
        ? html`<div class="wfg-miniflow" aria-label="${steps.n}${steps.more ? "+" : ""} steps">
            ${Array.from({ length: Math.min(steps.n, 6) }, (_, k) => html`${k > 0 ? html`<span class="wfg-miniflow__link"></span>` : nothing}<span class="wfg-miniflow__node"></span>`)}
            <span class="wfg-miniflow__more">${steps.n}${steps.more ? "+" : ""} steps</span>
          </div>`
        : nothing}

      ${(wf.tags ?? []).length
        ? html`<div class="wfg-tags">
            ${(wf.tags ?? []).slice(0, 4).map((t) => html`<span class="wfg-tag">${t}</span>`)}
            ${(wf.tags ?? []).length > 4 ? html`<span class="wfg-tag">+${(wf.tags ?? []).length - 4}</span>` : nothing}
          </div>`
        : nothing}

      <div class="wfg-card__foot">
        <div class="wfg-times">
          <div>
            <div class="wfg-time__k">Last run</div>
            <div class="wfg-time__v" title=${last ? new Date(last.startedAt).toLocaleString() : "Never run"}>${last ? ago(last.startedAt) : "Never"}</div>
          </div>
          <div>
            <div class="wfg-time__k">Next</div>
            <div class="wfg-time__v">${next}</div>
          </div>
        </div>
        <div class="wfg-card__run">
          ${renderSparkline(runs)}
          <button
            class="wfg-btn wfg-btn--sm wfg-btn--icon"
            title=${wf.kind === "continuous" ? "Start loop" : "Run workflow"}
            aria-label=${`${wf.kind === "continuous" ? "Start loop" : "Run"} ${wf.name}`}
            @click=${(e: Event) => {
              e.stopPropagation();
              void openRunDialog(state, client, wf.id);
            }}
            @keydown=${(e: Event) => e.stopPropagation()}
          >${icon(wf.kind === "continuous" ? "loop" : "play")}</button>
        </div>
      </div>
    </article>
  `;
}

/** Bar sparkline of the last runs (oldest → newest); height = duration. */
function renderSparkline(runs: WorkflowRun[]) {
  const W = 92;
  const H = 30;
  const slots = 12;
  const recent = runs.slice(0, slots).reverse();
  const bw = 5;
  const gap = (W - slots * bw) / (slots - 1);
  if (recent.length === 0) {
    return html`<svg class="wfg-spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="No runs yet">
      <line class="s-base" x1="0" y1=${H - 1} x2=${W} y2=${H - 1}></line>
    </svg>`;
  }
  const durs = recent.map((r) => runDurationMs(r) ?? 0);
  const max = Math.max(1, ...durs);
  const offset = slots - recent.length;
  const ok = recent.filter((r) => r.status === "completed").length;
  return html`<svg class="wfg-spark" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="${recent.length} recent runs, ${ok} succeeded">
    ${Array.from({ length: offset }, (_, k) => svg`<rect class="s-empty" x=${k * (bw + gap)} y=${H - 2} width=${bw} height="2" rx="1"></rect>`)}
    ${recent.map((r, k) => {
      const h = Math.max(5, Math.round((durs[k] / max) * (H - 2)));
      return svg`<rect class="s-${r.status}" x=${(offset + k) * (bw + gap)} y=${H - h} width=${bw} height=${h} rx="1.5">
        <title>${r.status} · ${fmtDuration(runDurationMs(r))} · ${ago(r.startedAt)}</title>
      </rect>`;
    })}
  </svg>`;
}

// ── Run timeline ─────────────────────────────────────────────

function renderRunTimelinePanel(ws: WorkflowsState, state: AppViewState, client: GatewayBrowserClient) {
  const runs = (ws.recentRuns ?? []).slice(0, 10);
  return html`
    <section class="wfg-panel">
      <div class="wfg-panel__head">
        <h2 class="wfg-panel__title">${icon("timeline")} Run timeline</h2>
        <button class="wfg-btn wfg-btn--ghost wfg-btn--sm wfg-btn--icon" title="Refresh runs" aria-label="Refresh runs"
          @click=${() => void loadRecentRuns(state, client)}>${icon("refresh")}</button>
      </div>
      ${runs.length === 0
        ? html`<div class="wfg-empty-note">No runs yet. Press <strong>Run</strong> on any workflow — each run shows up here with its status, duration and a link back to the session.</div>`
        : renderTimeline(runs, ws, state, client, true)}
    </section>
  `;
}

function renderTimeline(
  runs: WorkflowRun[],
  ws: WorkflowsState,
  state: AppViewState,
  client: GatewayBrowserClient,
  showName: boolean,
) {
  return html`<ol class="wfg-timeline">
    ${runs.map((r) => {
      const live = r.status === "running" || r.status === "pending";
      const mode = r.executionMode ?? "gateway";
      return html`<li class="wfg-tl" data-s=${r.status}>
        <span class="wfg-tl__node" aria-hidden="true"></span>
        <div class="wfg-tl__body">
          <div class="wfg-tl__row">
            <span class="wfg-tl__name">${showName ? r.workflowName || r.workflowId : new Date(r.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
            <span class="wfg-tl__when" title=${new Date(r.startedAt).toLocaleString()}>${ago(r.startedAt)}</span>
          </div>
          <div class="wfg-tl__meta">
            <span class="wfg-tl__status">${r.status}</span>
            <span aria-hidden="true">·</span>
            <span>${fmtDuration(runDurationMs(r))}${r.finishedAt ? "" : " so far"}</span>
            ${r.kind === "continuous" && r.iterationCount !== undefined
              ? html`<span aria-hidden="true">·</span><span>${r.iterationCount} iter</span>`
              : nothing}
            <span aria-hidden="true">·</span>
            <span>${mode === "terminal" ? `${r.cli ?? "claude"} PTY` : r.agent || "gateway"}</span>
          </div>
          ${r.error ? html`<div class="wfg-tl__err" title=${r.error}><span>${r.error}</span></div>` : nothing}
          ${(live || r.terminalId || r.sessionKey)
            ? html`<div class="wfg-tl__actions">
                ${mode === "terminal" && r.terminalId
                  ? html`<button class="wfg-btn wfg-btn--sm wfg-btn--violet" title="Open the Claude Code terminal — full scrollback intact"
                      @click=${() => openTerminalFromWorkflow(state, r.terminalId!)}>${icon("terminal")} Terminal</button>`
                  : r.sessionKey
                    ? html`<button class="wfg-btn wfg-btn--sm" title="Open this run's chat session"
                        @click=${() => openSessionFromWorkflow(state, r.sessionKey!)}>${icon("chat")} Session</button>`
                    : nothing}
                ${live
                  ? html`<button class="wfg-btn wfg-btn--sm wfg-btn--danger" title="Cancel this run"
                      @click=${() => void cancelRun(state, client, r.id)}>${icon("stop")} Cancel</button>`
                  : nothing}
              </div>`
            : nothing}
        </div>
      </li>`;
    })}
  </ol>`;
}

// ── Drawer (create / edit) ───────────────────────────────────

function closeDrawer(ws: WorkflowsState, state: AppViewState) {
  if (ws.dirty && !confirm("Discard unsaved changes?")) return;
  ws.selected = null;
  ws.isCreating = false;
  ws.dirty = false;
  state.requestUpdate?.();
}

function renderDrawer(ws: WorkflowsState, state: AppViewState, client: GatewayBrowserClient) {
  const isNew = ws.isCreating;
  const sel = ws.selected;
  const status = sel ? statusOf(ws, sel) : null;
  const runs = sel ? runsFor(ws, sel.id).slice(0, 8) : [];
  return html`
    <div class="wfg-scrim" @click=${() => closeDrawer(ws, state)}></div>
    <section
      class="wfg-drawer"
      role="dialog"
      aria-label=${isNew ? "New workflow" : `Edit workflow ${ws.editorName}`}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Escape" && !ws.dirty && !ws.editing) {
          e.stopPropagation();
          closeDrawer(ws, state);
        }
      }}
    >
      <div class="wfg-drawer__glow" aria-hidden="true"></div>
      <div class="wfg-drawer__head">
        <div class="wfg-drawer__titles">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <span class="wfg-eyebrow"><i class="wfg-eyebrow__dot"></i>${isNew ? "New workflow" : sel?.kind === "continuous" ? "Continuous loop" : "Workflow"}</span>
            ${status ? html`<span class="wfg-chip" data-s=${status}><i class="wfg-chip__dot"></i>${STATUS_LABEL[status]}</span>` : nothing}
          </div>
          <h2 class="wfg-drawer__name">
            ${ws.editorName || (isNew ? "Untitled workflow" : "Untitled")}
            ${ws.dirty ? html`<span class="wfg-unsaved">Unsaved</span>` : nothing}
          </h2>
        </div>
        <button class="wfg-btn wfg-btn--ghost wfg-btn--icon" aria-label="Close editor" title="Close"
          @click=${() => closeDrawer(ws, state)}>${icon("close")}</button>
      </div>

      ${renderEditorToolbar(ws, state, client)}

      <div class="wfg-drawer__scroll">
        ${renderBanners(ws, state)}
        ${renderMetadataFields(ws, state)}
        ${renderFlowPreview(ws)}
        <div class="wfg-editor">
          ${ws.editing ? renderRawEditor(ws, state, client) : renderMarkdownPreview(ws, state)}
        </div>
        ${sel
          ? html`<div class="wfg-drawer__section">
              <h3 class="wfg-section-head">Run history <span class="wfg-section-head__n">${runs.length}</span></h3>
              ${runs.length
                ? renderTimeline(runs, ws, state, client, false)
                : html`<div class="wfg-empty-note">This workflow hasn't run yet.</div>`}
            </div>`
          : nothing}
      </div>

      ${renderStatusBar(ws)}
    </section>
  `;
}

// ── Flow preview ─────────────────────────────────────────────

function renderFlowPreview(ws: WorkflowsState) {
  const steps = parseSteps(ws.editorBody);
  const sel = ws.selected;
  const shown = steps.slice(0, 8);
  const extra = steps.length - shown.length;
  const trigger =
    sel?.kind === "continuous"
      ? sel.continuous
        ? `Loop every ${sel.continuous.iterationIntervalSeconds}s`
        : "Continuous loop"
      : sel?.inputs?.length
        ? `Run with ${sel.inputs.length} input${sel.inputs.length === 1 ? "" : "s"}`
        : "Manual run";
  let li = 0;
  return html`
    <div class="wfg-flow">
      <div class="wfg-flow__head">
        <span class="wfg-label">Flow · ${steps.length} step${steps.length === 1 ? "" : "s"}</span>
        ${sel?.requires?.length
          ? html`<span class="wfg-chip wfg-chip--loop">${sel.requires.length} requirement${sel.requires.length === 1 ? "" : "s"}</span>`
          : nothing}
      </div>
      ${steps.length === 0
        ? html`<div class="wfg-flow__empty">Add a numbered list (<code class="wfg-code">1. Do X</code>) or <code class="wfg-code">## Step</code> headings to the body and the flow draws itself here.</div>`
        : html`<div class="wfg-flow__track">
            <div class="wfg-node wfg-node--start" style="--i:0">
              <div class="wfg-node__n">${icon(sel?.kind === "continuous" ? "loop" : "bolt")}</div>
              <div class="wfg-node__t">${trigger}</div>
            </div>
            ${shown.map(
              (s, k) => html`
                <span class="wfg-link" style="--i:${li++}" aria-hidden="true"></span>
                <div class="wfg-node" style="--i:${k + 1}" title=${s}>
                  <div class="wfg-node__n">${k + 1}</div>
                  <div class="wfg-node__t">${s}</div>
                </div>
              `,
            )}
            ${extra > 0
              ? html`<span class="wfg-link" style="--i:${li++}" aria-hidden="true"></span>
                  <div class="wfg-node wfg-node--end" style="--i:${shown.length + 1}">
                    <div class="wfg-node__n">+${extra}</div>
                    <div class="wfg-node__t">more step${extra === 1 ? "" : "s"}</div>
                  </div>`
              : nothing}
            <span class="wfg-link" style="--i:${li++}" aria-hidden="true"></span>
            <div class="wfg-node wfg-node--end" style="--i:${shown.length + 2}">
              <div class="wfg-node__n">${icon("agent")}</div>
              <div class="wfg-node__t">Agent <strong>${sel?.agent ?? "main"}</strong> reports back</div>
            </div>
          </div>`}
    </div>
  `;
}

// ── Editor body: preview vs raw ──────────────────────────────

/**
 * Rendered-markdown view of the workflow body. Click anywhere to flip into
 * raw-edit mode. Mirrors the Notes preview pane so the two surfaces feel
 * identical.
 */
function renderMarkdownPreview(ws: WorkflowsState, state: AppViewState) {
  const body = ws.editorBody?.trim() ?? "";
  const html_ = body ? toSanitizedMarkdownHtml(ws.editorBody) : "";
  const enterEditMode = () => {
    ws.editing = true;
    state.requestUpdate?.();
  };
  return html`
    <div
      class="wfg-preview notes-preview"
      @click=${enterEditMode}
      @keydown=${(e: KeyboardEvent) => {
        if (
          e.key === "Enter" ||
          e.key === " " ||
          e.key === "ArrowUp" ||
          e.key === "ArrowDown" ||
          e.key.length === 1
        ) {
          enterEditMode();
        }
      }}
      tabindex="0"
      title="Click to edit"
    >
      ${body
        ? html`<div class="notes-md-body wfg-md">${unsafeHTML(html_)}</div>`
        : html`<div class="wfg-preview__empty">This workflow is empty — click to start writing in Markdown.</div>`}
    </div>
  `;
}

/**
 * Raw markdown textarea — original workflow editor, preserved as-is so
 * existing muscle memory (Tab indent, Ctrl+S save) keeps working.
 */
function renderRawEditor(ws: WorkflowsState, state: AppViewState, client: GatewayBrowserClient) {
  return html`
    <textarea
      class="wfg-textarea"
      aria-label="Workflow body (Markdown)"
      .value=${ws.editorBody}
      placeholder="Write your workflow instructions in Markdown..."
      ?disabled=${ws.saving}
      @input=${(e: Event) => {
        ws.editorBody = (e.target as HTMLTextAreaElement).value;
        ws.dirty = true;
        state.requestUpdate?.();
      }}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Tab") {
          e.preventDefault();
          const ta = e.target as HTMLTextAreaElement;
          const start = ta.selectionStart;
          const end = ta.selectionEnd;
          ta.value = ta.value.substring(0, start) + "  " + ta.value.substring(end);
          ta.selectionStart = ta.selectionEnd = start + 2;
          ws.editorBody = ta.value;
          ws.dirty = true;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
          e.preventDefault();
          if (ws.isCreating) {
            createWorkflow(state, client).then(() => state.requestUpdate?.());
          } else if (ws.selected) {
            updateWorkflow(state, client).then(() => state.requestUpdate?.());
          }
        }
        // Escape returns to preview when there's nothing to lose.
        if (e.key === "Escape" && !ws.dirty) {
          e.stopPropagation();
          ws.editing = false;
          state.requestUpdate?.();
        }
      }}
    ></textarea>
  `;
}

// ── Editor Toolbar ───────────────────────────────────────────

function renderEditorToolbar(ws: WorkflowsState, state: AppViewState, client: GatewayBrowserClient) {
  const isNew = ws.isCreating;
  const notionId = ws.selected?.notionPageId || state.notionSyncStatus?.parentPageId;
  return html`
    <div class="wfg-drawer__bar">
      <!-- Edit / Preview toggle — markdown-insert helpers only show in edit mode. -->
      <div class="wfg-seg" role="group" aria-label="Editor mode">
        <button aria-pressed=${ws.editing ? "true" : "false"} title="Raw markdown editor"
          @click=${() => { ws.editing = true; state.requestUpdate?.(); }}>${icon("edit")} Edit</button>
        <button aria-pressed=${ws.editing ? "false" : "true"} title="Rendered preview"
          @click=${() => { ws.editing = false; state.requestUpdate?.(); }}>${icon("eye")} Preview</button>
      </div>
      ${ws.editing
        ? html`<div class="wfg-md-tools" role="group" aria-label="Markdown helpers">
            ${renderMdButton("H", "## Heading\n", ws, state)}
            ${renderMdButton("B", "**bold**", ws, state)}
            ${renderMdButton("I", "_italic_", ws, state)}
            ${renderMdButton("•", "\n- ", ws, state)}
            ${renderMdButton("1.", "\n1. ", ws, state)}
            ${renderMdButton("```", "\n```\n\n```\n", ws, state)}
            ${renderMdButton("☐", "\n- [ ] ", ws, state)}
          </div>`
        : nothing}

      <span class="wfg-spacer"></span>

      <!-- Run -->
      ${!isNew && ws.selected
        ? html`<button
            class="wfg-btn ${ws.dirty ? "" : "wfg-btn--primary"}"
            title="Run this workflow — preflight + spawn dedicated agent"
            @click=${() => {
              if (ws.selected) void openRunDialog(state, client, ws.selected.id);
            }}
          >${icon(ws.selected.kind === "continuous" ? "loop" : "play")} Run</button>`
        : nothing}

      <!-- Notion Sync -->
      ${!isNew && ws.selected
        ? html`<button class="wfg-btn" ?disabled=${ws.notionSyncing} title="Sync this workflow to Notion"
            @click=${async () => {
              if (ws.selected) {
                await syncWorkflowToNotion(state, client, ws.selected.id);
                state.requestUpdate?.();
              }
            }}>${icon("sync")} ${ws.notionSyncing ? "Syncing…" : "Sync"}</button>`
        : nothing}
      ${!isNew && notionId
        ? html`<a
            class="wfg-btn wfg-btn--icon"
            href="https://notion.so/${notionId.replace(/-/g, "")}"
            target="_blank"
            rel="noreferrer"
            title="${ws.selected?.notionPageId ? "Open workflow in Notion" : "Open workspace in Notion"}"
            aria-label="Open in Notion"
          >${icon("external")}</a>`
        : nothing}

      <!-- Delete -->
      ${!isNew && ws.selected
        ? html`<button class="wfg-btn wfg-btn--icon wfg-btn--danger" title="Delete workflow" aria-label="Delete workflow"
            @click=${async () => {
              if (ws.selected && confirm(`Delete workflow "${ws.selected.name}"?`)) {
                await deleteWorkflow(state, client, ws.selected.id);
                state.requestUpdate?.();
              }
            }}>${icon("trash")}</button>`
        : nothing}

      <!-- Discard -->
      ${ws.dirty
        ? html`<button class="wfg-btn wfg-btn--ghost"
            @click=${() => {
              if (isNew) {
                ws.isCreating = false;
                ws.dirty = false;
              } else if (ws.selected) {
                ws.editorBody = ws.selected.body;
                ws.editorName = ws.selected.name;
                ws.editorDescription = ws.selected.description || "";
                ws.editorTags = ws.selected.tags?.join(", ") || "";
                ws.dirty = false;
              }
              state.requestUpdate?.();
            }}>Discard</button>`
        : nothing}

      <!-- Save -->
      <button class="wfg-btn ${ws.dirty ? "wfg-btn--primary" : ""}"
        ?disabled=${!ws.dirty || ws.saving}
        title="Save (Ctrl+S)"
        @click=${async () => {
          if (isNew) {
            await createWorkflow(state, client);
          } else {
            await updateWorkflow(state, client);
          }
          state.requestUpdate?.();
        }}>${icon("save")} ${ws.saving ? "Saving…" : isNew ? "Create" : "Save"}</button>
    </div>
  `;
}

function renderMdButton(label: string, insert: string, ws: WorkflowsState, state: AppViewState) {
  return html`
    <button
      title="${insert.trim()}"
      aria-label="Insert ${insert.trim()}"
      @click=${() => {
        ws.editorBody += insert;
        ws.dirty = true;
        state.requestUpdate?.();
      }}
    >${label}</button>
  `;
}

// ── Metadata Fields ──────────────────────────────────────────

function renderMetadataFields(ws: WorkflowsState, state: AppViewState) {
  return html`
    <div class="wfg-fields">
      <label class="wfg-field">
        <span class="wfg-label">Name</span>
        <input class="wfg-input" type="text" placeholder="Workflow name"
          .value=${ws.editorName}
          @input=${(e: Event) => {
            ws.editorName = (e.target as HTMLInputElement).value;
            ws.dirty = true;
            state.requestUpdate?.();
          }}
        />
      </label>
      <label class="wfg-field">
        <span class="wfg-label">Description</span>
        <input class="wfg-input" type="text" placeholder="Short description"
          .value=${ws.editorDescription}
          @input=${(e: Event) => {
            ws.editorDescription = (e.target as HTMLInputElement).value;
            ws.dirty = true;
            state.requestUpdate?.();
          }}
        />
      </label>
      <label class="wfg-field">
        <span class="wfg-label">Tags</span>
        <input class="wfg-input wfg-input--mono" type="text" placeholder="tag1, tag2, tag3"
          .value=${ws.editorTags}
          @input=${(e: Event) => {
            ws.editorTags = (e.target as HTMLInputElement).value;
            ws.dirty = true;
            state.requestUpdate?.();
          }}
        />
      </label>
    </div>
  `;
}

// ── Status Bar ───────────────────────────────────────────────

function renderStatusBar(ws: WorkflowsState) {
  const chars = ws.editorBody.length;
  const lines = ws.editorBody.split("\n").length;
  const words = ws.editorBody.trim() ? ws.editorBody.trim().split(/\s+/).length : 0;

  return html`
    <div class="wfg-statusbar">
      <div>
        <span>${lines} lines</span>
        <span>${words} words</span>
        <span>${chars.toLocaleString()} chars</span>
      </div>
      <div>
        ${ws.selected?.notionPageId
          ? html`<a
              href="https://notion.so/${ws.selected.notionPageId.replace(/-/g, "")}"
              target="_blank"
              rel="noreferrer"
              title="Open in Notion"
            >${icon("external")} Notion
              ${ws.selected.notionSyncedAt
                ? html`<span style="color:var(--wf-fg-4);">(${new Date(ws.selected.notionSyncedAt).toLocaleDateString()})</span>`
                : nothing}
            </a>`
          : nothing}
        <span>Markdown</span>
        <span>Ctrl+S to save</span>
      </div>
    </div>
  `;
}

// ── Run dialog ───────────────────────────────────────────────

function renderRunDialog(
  ws: WorkflowsState,
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  const dlg = ws.runDialog;
  if (!dlg.open) return nothing;
  const isLoop = dlg.workflow?.kind === "continuous";

  return html`
    <div
      class="wfg-modal-wrap"
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) closeRunDialog(state);
      }}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Escape") closeRunDialog(state);
      }}
    >
      <div class="wfg-modal" role="dialog" aria-modal="true" aria-label="Run workflow">
        <!-- Header -->
        <div class="wfg-modal__head">
          <span class="wfg-trigger">${icon(isLoop ? "loop" : "play")}</span>
          <div style="flex:1; min-width:0;">
            <span class="wfg-eyebrow">${isLoop ? "Start continuous loop" : "Run workflow"}</span>
            <div class="wfg-drawer__name" style="margin-top:6px; font-size:18px;">${dlg.workflow?.name ?? "Loading…"}</div>
          </div>
          <button class="wfg-btn wfg-btn--ghost wfg-btn--icon" aria-label="Close" @click=${() => closeRunDialog(state)}>${icon("close")}</button>
        </div>

        <!-- Body -->
        <div class="wfg-modal__body">
          ${dlg.workflow
            ? html`
              ${dlg.workflow.description ? html`<p class="wfg-desc">${dlg.workflow.description}</p>` : nothing}

              ${dlg.workflow.kind === "continuous" && dlg.workflow.continuous
                ? html`
                    <div class="wfg-callout">
                      <div class="wfg-callout__k">Autonomous-control loop</div>
                      Runs continuously until you stop it.
                      Iteration interval ${dlg.workflow.continuous.iterationIntervalSeconds}s ·
                      ${dlg.workflow.continuous.maxIterations === null
                        ? "unlimited iterations"
                        : `max ${dlg.workflow.continuous.maxIterations} iterations`}
                      · auto-stop after ${dlg.workflow.continuous.errorStreakThreshold} consecutive failures.
                    </div>
                  `
                : nothing}

              ${renderInputForm(dlg.workflow.inputs ?? [], dlg.inputs, state, client)}

              ${dlg.workflow.requires?.length
                ? renderRequirementsBlock(dlg.workflow.requires, dlg.preflight?.issues ?? [])
                : nothing}

              ${dlg.preflightInFlight
                ? html`<div class="wfg-hint" style="padding:10px 0; display:flex; align-items:center; gap:8px;">
                    <span class="wfg-orbit" aria-hidden="true"></span> Checking requirements…
                  </div>`
                : nothing}

              ${dlg.preflight && !dlg.preflightInFlight ? renderPreflightSummary(dlg.preflight.issues) : nothing}

              ${dlg.error
                ? html`<div class="wfg-callout wfg-callout--bad" style="margin-top:14px;" role="alert">${dlg.error}</div>`
                : nothing}

              <!-- Agent / execution mode -->
              <div class="wfg-mode">
                <span class="wfg-label">Agent mode</span>
                <div class="wfg-mode__opts">
                  <button
                    type="button"
                    class="wfg-mode__opt"
                    aria-pressed=${dlg.executionMode === "gateway" ? "true" : "false"}
                    @click=${() => { state.workflowsState!.runDialog.executionMode = "gateway"; state.requestUpdate?.(); }}
                  >
                    ${icon("gateway")}
                    <span>
                      <div class="wfg-mode__t">Gateway agent</div>
                      <div class="wfg-mode__d">Native sessions.spawn — fastest, no TUI</div>
                    </span>
                  </button>
                  <button
                    type="button"
                    class="wfg-mode__opt wfg-mode__opt--violet"
                    aria-pressed=${dlg.executionMode === "terminal" ? "true" : "false"}
                    @click=${() => { state.workflowsState!.runDialog.executionMode = "terminal"; state.requestUpdate?.(); }}
                  >
                    ${icon("terminal")}
                    <span>
                      <div class="wfg-mode__t">CLI in terminal</div>
                      <div class="wfg-mode__d">Long-lived PTY — re-attach from the run card</div>
                    </span>
                  </button>
                </div>

                ${dlg.executionMode === "terminal"
                  ? html`
                    <div class="wfg-mode__term">
                      <label class="wfg-field">
                        <span class="wfg-label">CLI</span>
                        <select
                          class="wfg-input wfg-select"
                          .value=${dlg.cli}
                          @change=${(e: Event) => { state.workflowsState!.runDialog.cli = (e.target as HTMLSelectElement).value as any; state.requestUpdate?.(); }}
                        >
                          <option value="claude">Claude Code</option>
                          <option value="opencode">OpenCode</option>
                          <option value="gemini">Gemini</option>
                          <option value="codex">Codex</option>
                          <option value="grok">Grok Build</option>
                        </select>
                      </label>
                      <label class="wfg-field">
                        <span class="wfg-label">Working directory</span>
                        <input
                          class="wfg-input wfg-input--mono"
                          type="text"
                          placeholder="."
                          .value=${dlg.cwd}
                          @input=${(e: Event) => { state.workflowsState!.runDialog.cwd = (e.target as HTMLInputElement).value; state.requestUpdate?.(); }}
                        />
                      </label>
                    </div>
                    <div class="wfg-hint" style="margin-top:8px;">
                      Terminal persists after the run finishes — close it from the Terminals page when you're done.
                    </div>
                  `
                  : nothing}
              </div>
            `
            : html`<div style="display:grid; gap:10px;">
                <div class="wfg-skel wfg-skel--row"></div>
                <div class="wfg-skel wfg-skel--row"></div>
                <div class="wfg-hint" style="text-align:center;">Loading workflow…</div>
              </div>`}
        </div>

        <!-- Footer -->
        <div class="wfg-modal__foot">
          <div class="wfg-foot-note">
            Will spawn agent <strong>${dlg.workflow?.agent ?? "main"}</strong>
            ${dlg.workflow?.timeoutSeconds ? html`· timeout ${dlg.workflow.timeoutSeconds}s` : nothing}
          </div>
          <button
            class="wfg-btn"
            ?disabled=${dlg.preflightInFlight}
            @click=${() => void runPreflight(state, client)}
          >${icon("refresh")} Re-check</button>
          <button
            class="wfg-btn wfg-btn--primary"
            ?disabled=${dlg.starting || dlg.preflightInFlight || !dlg.preflight?.ok}
            @click=${() => void startRun(state, client)}
          >${icon(isLoop ? "loop" : "play")} ${dlg.starting ? "Starting…" : isLoop ? "Start loop" : "Start run"}</button>
        </div>
      </div>
    </div>
  `;
}

function renderInputForm(
  defs: WorkflowInputDef[],
  values: Record<string, unknown>,
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  if (defs.length === 0) {
    return html`<div class="wfg-muted-i">No inputs required for this workflow.</div>`;
  }
  return html`
    <div class="wfg-inputs">
      ${defs.map((def) => renderOneInput(def, values[def.name], state, client))}
    </div>
  `;
}

function renderOneInput(
  def: WorkflowInputDef,
  value: unknown,
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  const label = def.label || humanize(def.name);
  const onChange = (v: unknown) => {
    setRunInput(state, def.name, v);
    void runPreflight(state, client);
  };
  const inputId = `wfg-in-${def.name}`;

  let control;
  switch (def.type) {
    case "text":
      control = html`<textarea
        id=${inputId}
        class="wfg-input wfg-input--mono"
        placeholder=${def.placeholder ?? ""}
        .value=${(value as string | undefined) ?? ""}
        @input=${(e: Event) => onChange((e.target as HTMLTextAreaElement).value)}
      ></textarea>`;
      break;
    case "number":
      control = html`<input
        id=${inputId}
        type="number"
        class="wfg-input wfg-input--mono"
        min=${def.min ?? ""}
        max=${def.max ?? ""}
        placeholder=${def.placeholder ?? ""}
        .value=${value !== undefined && value !== null ? String(value) : ""}
        @input=${(e: Event) => {
          const raw = (e.target as HTMLInputElement).value;
          onChange(raw === "" ? undefined : Number(raw));
        }}
      />`;
      break;
    case "boolean":
      control = html`<label class="wfg-check">
        <input
          id=${inputId}
          type="checkbox"
          .checked=${value === true}
          @change=${(e: Event) => onChange((e.target as HTMLInputElement).checked)}
        />
        <span>${value === true ? "Enabled" : "Disabled"}</span>
      </label>`;
      break;
    case "select":
      control = html`<select
        id=${inputId}
        class="wfg-input wfg-select"
        .value=${(value as string | undefined) ?? ""}
        @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value)}
      >
        ${value === undefined || value === "" ? html`<option value="" disabled selected>Select…</option>` : nothing}
        ${(def.options ?? []).map(
          (opt) => html`<option value=${opt.value}>${opt.label || opt.value}</option>`,
        )}
      </select>`;
      break;
    case "multiSelect":
      control = html`<div class="wfg-pills" role="group" aria-label=${label}>
        ${(def.options ?? []).map((opt) => {
          const arr = Array.isArray(value) ? (value as string[]) : [];
          const active = arr.includes(opt.value);
          return html`<button
            type="button"
            class="wfg-pill"
            aria-pressed=${active ? "true" : "false"}
            @click=${() => {
              const next = active
                ? arr.filter((v) => v !== opt.value)
                : [...arr, opt.value];
              onChange(next);
            }}
          >${opt.label || opt.value}</button>`;
        })}
      </div>`;
      break;
    case "date":
      control = html`<input
        id=${inputId}
        type="date"
        class="wfg-input"
        .value=${(value as string | undefined) ?? ""}
        @input=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
      />`;
      break;
    case "url":
    case "email":
    case "string":
    default:
      control = html`<input
        id=${inputId}
        type=${def.type === "email" ? "email" : def.type === "url" ? "url" : "text"}
        class="wfg-input"
        placeholder=${def.placeholder ?? ""}
        .value=${(value as string | undefined) ?? ""}
        @input=${(e: Event) => onChange((e.target as HTMLInputElement).value)}
      />`;
  }

  return html`
    <div class="wfg-field">
      <label class="wfg-label" for=${inputId}>
        ${label}${def.required ? html`<span class="req"> *</span>` : nothing}
      </label>
      ${control}
      ${def.description ? html`<div class="wfg-hint">${def.description}</div>` : nothing}
    </div>
  `;
}

function renderRequirementsBlock(
  reqs: WorkflowsState["runDialog"]["workflow"] extends infer W
    ? W extends { requires?: infer R }
      ? R
      : never
    : never,
  issues: WorkflowPreflightIssue[],
) {
  const arr = (reqs ?? []) as Array<{
    kind: string;
    name: string;
    optional?: boolean;
    reason?: string;
  }>;
  if (arr.length === 0) return nothing;
  const issueByKey = (kind: string, name: string) =>
    issues.find((i) => i.requirement.kind === kind && i.requirement.name === name);
  return html`
    <div class="wfg-reqs">
      <div class="wfg-label" style="margin-bottom:8px; color:var(--wf-gold);">Requirements</div>
      ${arr.map((r) => {
        const issue = issueByKey(r.kind, r.name);
        const ok = !issue;
        const tone = ok ? "" : issue?.severity === "warning" ? "wfg-req--warn" : "wfg-req--bad";
        const ic: IconName = ok ? "check" : issue?.severity === "warning" ? "alert" : "x";
        return html`
          <div class="wfg-req ${tone}">
            <span class="wfg-req__icon">${icon(ic)}</span>
            <span class="wfg-req__kind">${r.kind}:</span>
            <strong>${r.name}</strong>
            ${r.optional ? html`<span class="wfg-hint">(optional)</span>` : nothing}
            ${issue ? html`<span class="wfg-req__detail">${issue.detail}</span>` : nothing}
            ${ok && r.reason ? html`<span class="wfg-req__reason">${r.reason}</span>` : nothing}
          </div>
        `;
      })}
    </div>
  `;
}

function renderPreflightSummary(issues: WorkflowPreflightIssue[]) {
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  if (errors.length === 0 && warnings.length === 0) {
    return html`<div class="wfg-callout wfg-callout--ok" style="margin:12px 0 0; display:flex; align-items:center; gap:8px;">
      <span class="wfg-req__icon" style="--c:var(--wf-ok)">${icon("check")}</span> Preflight passed — ready to run.
    </div>`;
  }
  return html`
    <div class="wfg-issues">
      ${errors.map((e) => html`<div class="wfg-issue">${e.requirement.kind}:${e.requirement.name} — ${e.detail}</div>`)}
      ${warnings.map((w) => html`<div class="wfg-issue wfg-issue--warn">${w.requirement.kind}:${w.requirement.name} — ${w.detail}</div>`)}
    </div>
  `;
}

function humanize(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

// ── Live daemons panel (autonomous-control continuous workflows) ─────

function renderLiveDaemonsPanel(
  ws: WorkflowsState,
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  const daemons = ws.liveDaemons ?? [];
  return html`
    <section class="wfg-panel">
      <div class="wfg-panel__head">
        <h2 class="wfg-panel__title">${icon("loop")} Live loops</h2>
        <span class="wfg-panel__count">${daemons.length} running</span>
      </div>
      ${daemons.length === 0
        ? html`<div class="wfg-empty-note">
            No continuous workflows are running. Pick a workflow marked
            <span class="wfg-chip wfg-chip--loop" style="height:18px; font-size:10px; vertical-align:1px;">Loop</span>
            and press <strong>Start loop</strong> to kick one off.
          </div>`
        : daemons.map((d) => renderDaemonRow(d, ws, state, client))}
    </section>
  `;
}

function renderDaemonRow(
  d: WorkflowsState["liveDaemons"][number],
  ws: WorkflowsState,
  state: AppViewState,
  client: GatewayBrowserClient,
) {
  const workflowName =
    ws.workflows.find((w) => w.id === d.workflowId)?.name ?? d.workflowId;
  // The daemon snapshot is small; the full run record carries executionMode /
  // terminalId / sessionKey, which we need to surface the "Open session"
  // affordance. Match by runId (the parent run id equals d.runId).
  const run = ws.recentRuns?.find((r) => r.id === d.runId);
  const mode = run?.executionMode ?? "gateway";
  const terminalId = run?.terminalId;
  const sessionKey = run?.sessionKey;
  return html`
    <div class="wfg-daemon">
      <div class="wfg-daemon__name">
        <span class="wfg-orbit ${d.paused ? "is-paused" : ""}" aria-hidden="true"></span>
        <span title=${workflowName}>${workflowName}</span>
      </div>
      <div class="wfg-daemon__meta">
        <span>Iteration ${d.iterationCount}</span>
        ${d.errorStreak > 0 ? html`<span class="is-bad">· streak ${d.errorStreak} fail</span>` : nothing}
        ${d.paused ? html`<span class="is-warn">· paused</span>` : nothing}
        ${mode === "terminal" ? html`<span class="is-violet">· ${run?.cli ?? "claude"} PTY</span>` : nothing}
      </div>
      <div class="wfg-daemon__actions">
        ${mode === "terminal" && terminalId
          ? html`<button class="wfg-btn wfg-btn--sm wfg-btn--violet"
              title="Open the running Claude Code terminal — full scrollback intact"
              @click=${() => openTerminalFromWorkflow(state, terminalId)}>${icon("terminal")} Terminal</button>`
          : sessionKey
            ? html`<button class="wfg-btn wfg-btn--sm"
                title="Switch to the chat view for this iteration's session"
                @click=${() => openSessionFromWorkflow(state, sessionKey)}>${icon("chat")} Session</button>`
            : nothing}
        ${d.paused
          ? html`<button class="wfg-btn wfg-btn--sm"
              @click=${() => void resumeContinuous(state, client, d.runId)}>${icon("play")} Resume</button>`
          : html`<button class="wfg-btn wfg-btn--sm"
              @click=${() => void pauseContinuous(state, client, d.runId)}>${icon("pause")} Pause</button>`}
        <button class="wfg-btn wfg-btn--sm wfg-btn--danger"
          @click=${() => void stopContinuous(state, client, d.runId)}>${icon("stop")} Stop</button>
      </div>
    </div>
  `;
}

/**
 * Switch to the Terminals tab and focus the spawned PTY. Used by daemon /
 * recent-run rows to "re-attach" to a Claude Code terminal that was spawned
 * by the workflow runner with autoClose:false.
 */
function openTerminalFromWorkflow(state: AppViewState, terminalId: string) {
  try { state.setTab("terminals" as any); } catch { (state as any).tab = "terminals"; }
  void import("../controllers/terminals.js").then(({ setActiveSession }) => {
    try { setActiveSession(state, terminalId); } catch (err) { console.warn("[workflows] setActiveSession failed:", err); }
  });
  state.requestUpdate?.();
}

/**
 * Switch to the Chat tab and select the iteration's session so the operator
 * can read the live transcript. Mirrors the autonomy view's onOpenSession.
 */
function openSessionFromWorkflow(state: AppViewState, sessionKey: string) {
  try { state.setTab("chat" as any); } catch { (state as any).tab = "chat"; }
  void import("../controllers/chat.js").then(({ switchChatSession }) => {
    try { switchChatSession(state, sessionKey); } catch (err) { console.warn("[workflows] switchChatSession failed:", err); }
  });
  state.requestUpdate?.();
}

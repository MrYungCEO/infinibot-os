/**
 * Business — per-business home (priorities, projects, tasks, activity),
 * overview, workspace, brand and settings. Black-gold glass skin from
 * ./ba-glass (styles in ./ba-glass/business.css). Leads, pipeline, clients
 * and revenue live in the Business hub; this page links there.
 */

import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../markdown";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import type { BusinessState, BusinessProfile, NotionDatabase } from "../controllers/business";
import {
  saveBusiness,
  loadNotionDatabases,
  createNotionDatabase,
  connectNotionDatabase,
  syncNotionDatabase,
  switchBusiness,
  createBusiness,
  deleteBusiness,
  fetchPlanContent,
  loadBusinessSummary,
  loadRecentKanban,
  setTaskBoardGroupBy,
  setTaskBoardShowDone,
  loadContextMemory,
  selectContextEntry,
  startNewContextEntry,
  closeContextEditor,
  updateContextEditor,
  saveContextEntry,
  deleteContextEntry,
  syncContextToNotion,
} from "../controllers/business";
import {
  getPriorities,
  addPriority,
  removePriority,
  reorderPriority,
  migrateLegacyPriorities,
  MAX_PRIORITIES,
} from "../lib/priorities";
import {
  createInitialClientsState,
  loadClients,
  openClientDetail,
  getClientName,
  getTitleProperty,
} from "../controllers/clients";
import { renderClients } from "./clients";
import { createInitialBrandState, loadBrand } from "../controllers/brand";
import { renderBrandControl } from "./brand-control";
import { renderWorkspace } from "./business-workspace";
import { getBizFilter, setBizFilter } from "../lib/biz-filter";
import { openInvoiceComposer } from "../controllers/agency-invoicing";
import type { AgencyOperationsHost } from "../controllers/agency-operations";
import { baAurora, openHubSection, renderHubLink } from "./ba-glass";
import "./ba-glass/business-base.css";
import "./ba-glass/business.css";

// ── Inline SVG icon set (replacing emojis throughout the HUD) ─────
// Lucide-style 24x24 strokes, designed to render via the `.action-btn .icon`
// + `.section-title` slots which size them to 18px / 14px respectively.
const I = {
  users: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  `,
  palette: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="13.5" cy="6.5" r="1" />
      <circle cx="17.5" cy="10.5" r="1" />
      <circle cx="8.5" cy="7.5" r="1" />
      <circle cx="6.5" cy="12.5" r="1" />
      <path
        d="M12 2C6.5 2 2 6.5 2 12c0 5 4 9 9 9 1.4 0 2-1 2-2 0-.6-.2-1-.6-1.4-.4-.4-.6-.8-.6-1.4 0-1 .8-1.8 1.8-1.8H16c3.3 0 6-2.7 6-6 0-4.4-4.5-8-10-8z"
      />
    </svg>
  `,
  refresh: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
      <path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  `,
  save: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  `,
  doc: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  `,
  plus: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  `,
  trash: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  `,
  close: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  `,
  alert: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path
        d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
      />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  `,
  check: html`
    <svg viewBox="0 0 24 24" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  `,
  zap: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  `,
  chart: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="20" x2="12" y2="10" />
      <line x1="18" y1="20" x2="18" y2="4" />
      <line x1="6" y1="20" x2="6" y2="16" />
    </svg>
  `,
  note: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  `,
  briefcase: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </svg>
  `,
  globe: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path
        d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
      />
    </svg>
  `,
  key: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path
        d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"
      />
    </svg>
  `,
  settings: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
      />
    </svg>
  `,
  grip: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="9" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
      <circle cx="15" cy="6" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="18" r="1" />
    </svg>
  `,
  target: html`
    <svg viewBox="0 0 24 24" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  `,
  eye: html`
    <svg
      viewBox="0 0 24 24"
      width="100%"
      height="100%"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  `,
  eyeOff: html`
    <svg
      viewBox="0 0 24 24"
      width="100%"
      height="100%"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
      <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <line x1="2" x2="22" y1="2" y2="22" />
    </svg>
  `,
};

// Styles live in ./ba-glass/business.css (scoped under .ba-glass.cmd-center).

// ── Main Render ──────────────────────────────────────────────

export function renderBusiness(state: AppViewState, client: GatewayBrowserClient) {
  const bs = state.businessState;
  if (!bs || bs.loading) return renderBusinessSkeleton();

  // If clients section is active, render the CRM view
  if (bs.activeSection === "clients" && bs.activeBusinessId) {
    if (!bs._clientsState) {
      bs._clientsState = createInitialClientsState();
      loadClients(state, client);
    }
    return html`
      <div class="cmd-center ba-glass cmd-center--fixed">
        ${baAurora()}
        ${renderHudHeader(state, bs, client)}
        <div class="bz-section-body bz-section-body--clients">
          ${renderClients(state, client)}
        </div>
        ${bs.showCreateDialog ? renderCreateDialog(state, bs, client) : nothing}
        ${bs.showDeleteConfirm ? renderDeleteConfirm(state, bs, client) : nothing}
        ${renderClientSearchModal(state, bs, client)}
      </div>
    `;
  }

  // Per-business workspace: grouped system DBs (CRM/Sales/Operations/Service/
  // Agency) with row counts scoped to the active business, custom databases,
  // and a Library pane for one-click pack installs.
  if (bs.activeSection === "workspace") {
    return html`
      <div class="cmd-center ba-glass">
        ${baAurora()}
        ${renderHudHeader(state, bs, client)}
        <div class="bz-section-body">
          ${renderWorkspace(state, client)}
        </div>
        ${bs.showCreateDialog ? renderCreateDialog(state, bs, client) : nothing}
        ${renderClientSearchModal(state, bs, client)}
      </div>
    `;
  }

  // Per-business overview: pages, leads, KPIs, brand, asset oversight.
  if (bs.activeSection === "overview" && bs.activeBusinessId) {
    if (!bs.summary || bs.summary.businessId !== bs.activeBusinessId) {
      void loadBusinessSummary(state, client);
    }
    return html`
      <div class="cmd-center ba-glass">
        ${baAurora()}
        ${renderHudHeader(state, bs, client)}
        <div class="bz-section-body">
          ${renderBusinessOverview(state, bs, client)}
        </div>
        ${bs.showCreateDialog ? renderCreateDialog(state, bs, client) : nothing}
        ${renderClientSearchModal(state, bs, client)}
      </div>
    `;
  }

  // If brand section is active, render the Brand Identity editor
  if (bs.activeSection === "brand" && bs.activeBusinessId) {
    const activeBiz = bs.businesses.find((b) => b.id === bs.activeBusinessId);
    if (!state.brandState) {
      state.brandState = createInitialBrandState();
      loadBrand(client, bs.activeBusinessId, (fn) => {
        Object.assign(state, fn(state));
        state.requestUpdate?.();
      });
    }
    return html`
      <div class="cmd-center ba-glass">
        ${baAurora()}
        ${renderHudHeader(state, bs, client)}
        <div class="bz-section-body bz-section-body--brand">
          ${renderBrandControl(
            client,
            state,
            activeBiz?.name || "Business",
            bs.activeBusinessId,
            (fn) => {
              Object.assign(state, fn(state));
              state.requestUpdate?.();
            },
          )}
        </div>
        ${bs.showCreateDialog ? renderCreateDialog(state, bs, client) : nothing}
        ${renderClientSearchModal(state, bs, client)}
      </div>
    `;
  }

  return html`
    <div class="cmd-center ba-glass">
      ${baAurora()}
      ${
        bs.success
          ? html`
        <div class="msg-success" role="status">
          <span class="msg-icon">${I.check}</span>
          <span>${bs.success}</span>
        </div>
      `
          : nothing
      }
      ${
        bs.error
          ? html`
        <div class="msg-error" role="alert">
          <span class="msg-icon">${I.alert}</span>
          <span class="msg-text">${bs.error}</span>
          <button class="msg-error-dismiss" aria-label="Dismiss" @click=${() => {
            bs.error = null;
            state.requestUpdate?.();
          }}>
            <span class="msg-icon msg-icon--sm">${I.close}</span>
          </button>
        </div>
      `
          : nothing
      }
      ${renderHudHeader(state, bs, client)}
      ${
        bs.businesses.length === 0 && !bs.activeBusinessId
          ? renderEmptyState(state, bs, client)
          : bs.activeSection === "settings"
            ? renderSettingsShell(state, bs, client)
            : renderHomeSurface(state, bs, client)
      }
      ${bs.showNotionPicker ? renderDatabasePicker(state, bs, client) : nothing}
      ${bs.showCreateDialog ? renderCreateDialog(state, bs, client) : nothing}
      ${bs.showDeleteConfirm ? renderDeleteConfirm(state, bs, client) : nothing}
      ${renderContextEditorModal(state, bs, client)}
      ${_wizOpen ? renderOnboardingWizard(state, bs, client) : nothing}
      ${renderClientSearchModal(state, bs, client)}
    </div>
  `;
}

/** Loading placeholder shaped like the page (hero + KPI row + tiles). */
function renderBusinessSkeleton(): TemplateResult {
  return html`
    <div class="cmd-center ba-glass" aria-busy="true">
      ${baAurora()}
      <header class="bz-hero g-panel">
        <div class="bz-hero-text">
          <span class="bag-eyebrow">Business</span>
          <span class="bag-skel" style="width:min(320px,70%);height:34px;margin-top:8px;"></span>
          <span class="bag-skel" style="width:min(460px,90%);height:14px;margin-top:10px;"></span>
        </div>
      </header>
      <div class="bz-home">
        <section class="bz-kpi-strip">
          ${[0, 1, 2, 3].map(
            () => html`<article class="bz-kpi"><span class="bag-skel" style="width:40%;"></span><span class="bag-skel" style="width:60%;height:28px;"></span><span class="bag-skel" style="width:75%;"></span></article>`,
          )}
        </section>
        <section class="bz-tiles">
          ${[0, 1, 2, 3, 4, 5].map(
            () => html`<div class="bz-tile bz-tile--skeleton"><span class="bag-skel" style="width:36px;height:36px;border-radius:12px;"></span><span class="bag-skel" style="width:50%;"></span><span class="bag-skel" style="width:80%;"></span></div>`,
          )}
        </section>
        <span class="bz-sr-only">Loading your businesses…</span>
      </div>
    </div>
  `;
}

// ── Hero header ──────────────────────────────────────────────
// Hub-style hero: eyebrow + business name + sub copy, with every control the
// old HUD bar carried (business switcher, add, client search, hide $, sync,
// setup, settings) plus a segmented section switcher.

type BizSection = BusinessState["activeSection"];

const SECTION_NAV: Array<{ id: BizSection; label: string; icon: TemplateResult }> = [
  { id: "profile", label: "Home", icon: I.target },
  { id: "overview", label: "Overview", icon: I.chart },
  { id: "workspace", label: "Workspace", icon: I.briefcase },
  { id: "clients", label: "Clients", icon: I.users },
  { id: "brand", label: "Brand", icon: I.palette },
  { id: "settings", label: "Settings", icon: I.settings },
];

const SECTION_SUB: Partial<Record<BizSection, string>> = {
  profile: "Priorities, active projects, open tasks and recent activity for this business.",
  overview: "Pages, form leads, engagement, brand and assets in one place.",
  workspace: "Databases scoped to this business, plus one-click packs.",
  clients: "The client records and invoices for this business.",
  brand: "Colours, fonts, voice and assets your agents design with.",
  settings: "Profile, AI context, Notion and connection health.",
};

function renderHudHeader(state: AppViewState, bs: BusinessState, client: GatewayBrowserClient) {
  const activeBiz = bs.businesses.find((b) => b.id === bs.activeBusinessId);
  const hidden = isRevenueHidden();
  const section: BizSection = bs.activeSection === "notion" || bs.activeSection === "plan" ? "profile" : bs.activeSection;
  const goSection = (id: BizSection) => {
    bs.activeSection = id;
    if (id === "overview") void loadBusinessSummary(state, client);
    state.requestUpdate?.();
  };
  const sub = activeBiz
    ? (SECTION_SUB[section] ?? SECTION_SUB.profile)
    : bs.businesses.length > 0
      ? "Pick a business to see its priorities, projects, tasks and activity."
      : "Set up your first business and your agents will know who you are, what you sell and what matters this quarter.";

  return html`
    <header class="bz-hero g-panel">
      <div class="bz-hero-text">
        <span class="bag-eyebrow">Business</span>
        <h1 class="bz-hero-title">
          ${
            activeBiz
              ? html`<span class="bag-gold-text">${activeBiz.name || "Untitled"}</span>`
              : html`Your <span class="bag-gold-text">businesses</span>`
          }
        </h1>
        <p class="bz-hero-sub">
          ${activeBiz?.industry ? html`<span class="bz-hero-tag">${activeBiz.industry}</span>` : nothing}
          <span>${sub}</span>
        </p>
        <div class="bz-hero-status" aria-label="Connection status">
          <span class="bz-status-chip ${bs.notionConnected ? "is-ok" : "is-off"}">
            <span class="bz-status-dot"></span>Notion ${bs.notionConnected ? "connected" : "off"}
          </span>
          <span class="bz-status-chip ${state.connected ? "is-ok" : "is-off"}">
            <span class="bz-status-dot"></span>Gateway ${state.connected ? "online" : "offline"}
          </span>
        </div>
      </div>
      <div class="bz-hero-actions">
        <button class="bz-btn" @click=${() => openClientSearch(state, client)} title="Search clients (⌘K)">
          <span class="bz-btn-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg></span>
          <span>Find client</span>
        </button>
        <button
          class="bz-btn ${hidden ? "is-on" : ""}"
          @click=${() => toggleRevenueHidden(state)}
          aria-pressed=${hidden ? "true" : "false"}
          title=${hidden ? "Show revenue values" : "Hide revenue values"}
          aria-label=${hidden ? "Show revenue values" : "Hide revenue values"}
        >
          <span class="bz-btn-icon">${hidden ? I.eyeOff : I.eye}</span>
          <span>${hidden ? "Show $" : "Hide $"}</span>
        </button>
        <button
          class="bz-btn"
          @click=${() => syncNotionDatabase(state, client)}
          ?disabled=${bs.notionSyncStatus?.syncing || !bs.notionConnected}
          title=${bs.notionConnected ? "Run Notion sync now" : "Connect Notion in Settings to sync"}
        >
          <span class="bz-btn-icon ${bs.notionSyncStatus?.syncing ? "is-spinning" : ""}">${I.refresh}</span>
          <span>${bs.notionSyncStatus?.syncing ? "Syncing…" : "Sync"}</span>
        </button>
        <button class="bz-btn" @click=${() => openOnboarding(state)} title="Re-run the guided setup walkthrough">
          <span class="bz-btn-icon">${I.zap}</span>
          <span>Setup</span>
        </button>
        <button
          class="bz-btn bz-btn--primary"
          @click=${() => {
            bs.showCreateDialog = true;
            state.requestUpdate?.();
          }}
          title="Add a new business"
        >
          <span class="bz-btn-icon">${I.plus}</span>
          <span>New business</span>
        </button>
      </div>
    </header>

    <nav class="bz-hero-nav" aria-label="Business navigation">
      ${
        bs.businesses.length > 0
          ? html`
        <div class="bz-seg bz-seg--biz" role="tablist" aria-label="Businesses">
          ${bs.businesses.map(
            (biz) => html`
            <button
              role="tab"
              aria-selected=${bs.activeBusinessId === biz.id ? "true" : "false"}
              class="bz-seg-btn ${bs.activeBusinessId === biz.id ? "is-active" : ""}"
              @click=${() => switchBusiness(state, client, biz.id)}
              title=${biz.name || "Untitled"}
            >
              <span class="bz-seg-avatar" aria-hidden="true">${initialsOf(biz.name || "Untitled")}</span>
              <span class="bz-seg-label">${biz.name || "Untitled"}</span>
            </button>
          `,
          )}
          <button
            class="bz-seg-btn bz-seg-add"
            @click=${() => {
              bs.showCreateDialog = true;
              state.requestUpdate?.();
            }}
            title="Add business"
            aria-label="Add business"
          ><span class="bz-btn-icon">${I.plus}</span></button>
        </div>
      `
          : nothing
      }
      ${
        bs.activeBusinessId || bs.businesses.length > 0
          ? html`
        <div class="bz-seg bz-seg--sections" role="tablist" aria-label="Sections">
          ${SECTION_NAV.map(
            (s) => html`
            <button
              role="tab"
              aria-selected=${section === s.id ? "true" : "false"}
              class="bz-seg-btn ${section === s.id ? "is-active" : ""}"
              @click=${() => goSection(s.id)}
            >
              <span class="bz-btn-icon">${s.icon}</span>
              <span>${s.label}</span>
            </button>
          `,
          )}
        </div>
      `
          : nothing
      }
    </nav>
  `;
}

// ── AI Context Panel ─────────────────────────────────────────

function renderAIContextPanel(
  state: AppViewState,
  bs: BusinessState,
  client: GatewayBrowserClient,
) {
  // Brand palette — pull from the brand controller so the user's actual brand
  // colors show up as swatches at the top of the context panel. Falls back to
  // a single primary swatch if no brand has been set up yet.
  type BrandColor = { name?: string; hex?: string };
  const brand = (state as unknown as { brandState?: { brand?: { colors?: BrandColor[] } } })
    .brandState;
  const brandColors = (brand?.brand?.colors ?? [])
    .filter((c): c is { name: string; hex: string } => Boolean(c?.hex))
    .slice(0, 6);

  const ctx = bs.context;
  const hasBusiness = Boolean(bs.activeBusinessId);

  // Lazy-load the context entries the first time the panel renders for a
  // business — and re-load whenever the active business switches. Both
  // conditions are checked inside loadContextMemory; this is just the kick.
  if (hasBusiness && client) {
    if (!ctx || ctx.loadedForBusinessId !== bs.activeBusinessId) {
      void loadContextMemory(state, client);
    }
  }

  const entries = ctx?.entries ?? [];
  const editorOpen = Boolean(ctx?.editorOpen);
  const notionAvailable = bs.notionConnected;
  const fmtUpdated = (iso: string | null | undefined) => {
    if (!iso) return "—";
    const diff = Math.max(0, Date.now() - new Date(iso).getTime());
    const m = Math.floor(diff / 60_000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  return html`
    <div class="ai-context-panel">
      <div class="ai-context-header">
        <div class="ai-context-title">
          <div class="ai-context-icon">${I.zap}</div>
          <div class="ai-context-title-text">
            <span class="ai-context-title-main">AI Context Memory</span>
            <span class="ai-context-title-sub">Markdown pages the agent reads as durable business context</span>
          </div>
        </div>
        <div class="ai-context-header-right">
          <div class="ai-brand-strip" title="Your brand palette — used by the designer agent">
            <span class="ai-brand-strip-label">Brand</span>
            <span class="ai-brand-swatches">
              ${
                brandColors.length > 0
                  ? brandColors.map(
                      (c) => html`
                    <span class="ai-brand-swatch"
                      style="background:${c.hex};"
                      title="${c.name} · ${c.hex}"></span>
                  `,
                    )
                  : html`
                      <span class="ai-brand-swatch-empty" title="No brand colors set">+</span>
                    `
              }
            </span>
          </div>
          <div class="ai-status-badge ${entries.length > 0 ? "healthy" : "warning"}">
            ${entries.length > 0 ? `${entries.length} ${entries.length === 1 ? "page" : "pages"}` : "Empty"}
          </div>
        </div>
      </div>

      <div class="ai-context-actions" role="toolbar" aria-label="Context memory actions">
        <button class="ai-action-btn" type="button"
          ?disabled=${!hasBusiness}
          title=${hasBusiness ? "Add a new context page" : "Select a business first"}
          @click=${() => startNewContextEntry(state)}>
          <span class="ai-action-icon">${I.plus}</span>
          New page
        </button>
        <button class="ai-action-btn" type="button"
          ?disabled=${!hasBusiness || ctx?.loading}
          @click=${() => loadContextMemory(state, client, { force: true })}>
          <span class="ai-action-icon">${I.refresh}</span>
          ${ctx?.loading ? "Loading…" : "Refresh"}
        </button>
        ${
          notionAvailable
            ? html`<button class="ai-action-btn" type="button"
              ?disabled=${ctx?.notionSyncing}
              title="Push these pages to Notion + pull any remote edits back"
              @click=${() => syncContextToNotion(state, client)}>
              <span class="ai-action-icon">${I.refresh}</span>
              ${ctx?.notionSyncing ? "Syncing Notion…" : "Sync to Notion"}
            </button>`
            : html`<button class="ai-action-btn" type="button" disabled
              title="Connect a Notion workspace in Settings → Notion to enable sync">
              <span class="ai-action-icon">${I.doc}</span>
              Notion (off)
            </button>`
        }
      </div>

      ${
        ctx?.error && !editorOpen
          ? html`<div class="bz-inline-error" role="alert">${ctx.error}</div>`
          : nothing
      }

      ${renderContextEntryList(state, bs, client, entries, fmtUpdated)}
    </div>
  `;
}

function renderContextEntryList(
  state: AppViewState,
  bs: BusinessState,
  client: GatewayBrowserClient,
  entries: Array<{
    id: string;
    name: string;
    preview: string;
    updatedAt: string;
    notionPageId?: string;
  }>,
  fmtUpdated: (iso: string | null | undefined) => string,
) {
  if (!bs.activeBusinessId) {
    return html`
      <div class="bz-empty-card">
        <span class="bz-empty-glyph" aria-hidden="true">${I.doc}</span>
        <span class="bz-empty-title">No business selected</span>
        <span class="bz-empty-text">Select or create a business profile to start curating its context memory.</span>
      </div>
    `;
  }
  if (entries.length === 0) {
    return html`
      <div class="bz-empty-card">
        <span class="bz-empty-glyph" aria-hidden="true">${I.doc}</span>
        <span class="bz-empty-title">No context pages yet</span>
        <span class="bz-empty-text">
          Add one to give the agent durable, hand-written background on this business — pitch, voice, offers, anything you'd otherwise repeat in every chat.
        </span>
        <button class="ai-action-btn ai-action-btn--primary" type="button"
          @click=${() => startNewContextEntry(state)}>
          <span class="ai-action-icon">${I.plus}</span>
          Create first page
        </button>
      </div>
    `;
  }
  return html`
    <div class="ai-memory-header">
      <span class="ai-memory-title">Pages</span>
      <span class="ai-memory-count">${entries.length} ${entries.length === 1 ? "entry" : "entries"}</span>
    </div>
    <div class="ai-work-items">
      ${entries.map(
        (e) => html`
        <div class="ai-work-item" style="--ai-work-accent: var(--g-primary);"
          @click=${() => selectContextEntry(state, client, e.id)}
          @keydown=${(ev: KeyboardEvent) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              selectContextEntry(state, client, e.id);
            }
          }}
          tabindex="0" role="button" title="Open ${e.name}">
          <div class="ai-work-icon">${I.doc}</div>
          <div class="ai-work-content">
            <div class="ai-work-title">${e.name || "Untitled page"}</div>
            <div class="ai-work-meta">
              ${e.preview ? e.preview.slice(0, 80) : "Empty page"} · ${fmtUpdated(e.updatedAt)}${e.notionPageId ? " · Notion ✓" : ""}
            </div>
          </div>
          <button type="button" class="ai-work-delete" aria-label="Delete ${e.name || "page"}"
            @click=${(ev: Event) => {
              ev.stopPropagation();
              if (confirm(`Delete "${e.name}"? This also removes the Notion page if synced.`)) {
                void deleteContextEntry(state, client, e.id);
              }
            }}
            title="Delete this page">
            ${I.trash}
          </button>
        </div>
      `,
      )}
    </div>
  `;
}

function renderContextEditorModal(
  state: AppViewState,
  bs: BusinessState,
  client: GatewayBrowserClient,
) {
  const ctx = bs.context;
  if (!ctx?.editorOpen) return nothing;
  const body = ctx.editorBody;
  const previewHtml = body.trim() ? toSanitizedMarkdownHtml(body) : "";
  const close = () => {
    if (ctx.dirty && !confirm("Discard unsaved changes?")) return;
    closeContextEditor(state);
  };
  return html`
    <div class="bz-modal-backdrop" @click=${close}>
      <div class="bz-modal bz-modal--ctx" role="dialog" aria-modal="true" aria-label="Context page editor"
        @click=${(e: Event) => e.stopPropagation()}>
        <div class="bz-modal-head">
          <input type="text"
            .value=${ctx.editorTitle}
            placeholder="Page title (e.g. Voice & Tone, Ideal Customer, Offer Catalog…)"
            @input=${(e: Event) => updateContextEditor(state, { title: (e.target as HTMLInputElement).value })}
            class="bz-ctx-title-input"
            aria-label="Page title"
          />
          <div class="bz-modal-meta">
            ${
              ctx.isNew
                ? html`
                    <span class="bz-modal-tag">New page</span>
                  `
                : html`<span class="bz-modal-tag bz-modal-tag--muted">
                  Updated ${ctx.selected?.updatedAt ? new Date(ctx.selected.updatedAt).toLocaleString() : "—"}
                </span>`
            }
            ${
              ctx.selected?.notionPageId
                ? html`
                    <span class="bz-modal-tag bz-modal-tag--ok">Notion ✓</span>
                  `
                : nothing
            }
            ${
              ctx.dirty
                ? html`
                    <span class="bz-modal-tag bz-modal-tag--warn">Unsaved</span>
                  `
                : nothing
            }
          </div>
          <button class="bz-modal-close" @click=${close} title="Close (discards if unsaved)">
            ${I.close}
          </button>
        </div>

        <div class="bz-modal-body bz-modal-body--flush">
          <div class="bz-ctx-toolbar">
            <button class="ai-action-btn" type="button"
              @click=${() => updateContextEditor(state, { editing: !ctx.editing })}
              title=${ctx.editing ? "Switch to rendered preview" : "Switch to raw markdown editor"}>
              ${ctx.editing ? "Preview" : "Edit"}
            </button>
            <div style="flex: 1;"></div>
            ${
              ctx.error
                ? html`<span class="bz-ctx-error" role="alert">${ctx.error}</span>`
                : nothing
            }
            <button class="ai-action-btn ai-action-btn--primary" type="button"
              ?disabled=${ctx.saving || !ctx.editorTitle.trim() || !ctx.dirty}
              @click=${() => saveContextEntry(state, client)}
              title="Save changes (Cmd/Ctrl-S)">
              <span class="ai-action-icon">${I.save}</span>
              ${ctx.saving ? "Saving…" : ctx.dirty ? "Save" : "Saved"}
            </button>
          </div>

          ${
            ctx.editing
              ? html`<textarea
                .value=${body}
                placeholder="Write in Markdown — headings, lists, links, code blocks all render in preview mode. Cmd/Ctrl+S saves."
                @input=${(e: Event) => updateContextEditor(state, { body: (e.target as HTMLTextAreaElement).value })}
                @keydown=${(e: KeyboardEvent) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                    e.preventDefault();
                    void saveContextEntry(state, client);
                  }
                  if (e.key === "Tab") {
                    e.preventDefault();
                    const ta = e.target as HTMLTextAreaElement;
                    const start = ta.selectionStart;
                    const end = ta.selectionEnd;
                    ta.value = ta.value.substring(0, start) + "  " + ta.value.substring(end);
                    ta.selectionStart = ta.selectionEnd = start + 2;
                    updateContextEditor(state, { body: ta.value });
                  }
                  if (e.key === "Escape" && !ctx.dirty) close();
                }}
                class="bz-ctx-textarea mono"
                aria-label="Page body (Markdown)"
                autofocus
              ></textarea>`
              : html`<div
                class="notes-md-body bz-ctx-preview"
                @click=${() => updateContextEditor(state, { editing: true })}
                title="Click to edit"
                tabindex="0"
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter" || e.key === " " || e.key.length === 1) {
                    updateContextEditor(state, { editing: true });
                  }
                }}>
                ${
                  body.trim()
                    ? unsafeHTML(previewHtml)
                    : html`
                        <span class="bz-ctx-placeholder"
                          >This page is empty — click here to start writing in Markdown.</span
                        >
                      `
                }
              </div>`
          }
        </div>
      </div>
    </div>
  `;
}

// ── Revenue → Business hub ───────────────────────────────────
// Revenue used to live here as a legacy income store (business.income.*:
// Whop / Stripe / Square keys, sync buttons, a manual "log income" dialog).
// The Business hub now owns revenue: it imported that legacy income.json
// into its ledger once and connects Whop + Stripe itself, so anything
// written to the old store never reached it. These cards send people to
// Business hub › Revenue instead. Manual payments are logged through
// Agency Operations' "Log money" (a back-dated, paid invoice).

/** Open Agency Operations with the "Log money" composer already open. */
function openLogMoney(state: AppViewState): void {
  const host = state as unknown as { setTab?: (tab: string) => void };
  host.setTab?.("agency-operations");
  openInvoiceComposer(state as unknown as AgencyOperationsHost, { backdated: true });
  state.requestUpdate?.();
}

function renderRevenueHubLink(state: AppViewState, opts: { compact?: boolean } = {}) {
  return renderHubLink(state, {
    section: "revenue",
    title: opts.compact ? "Revenue lives in the Business hub" : "Revenue moved to the Business hub",
    text: opts.compact
      ? "Connect Whop or Stripe, sync payments and see every payment in Business hub › Revenue."
      : "Connect Whop or Stripe, sync payments and track MRR in Business hub › Revenue. Your old income log was imported there; record a cash or bank payment with Log money.",
    cta: "Open Revenue",
    extra: [{ label: "Log money", run: () => openLogMoney(state) }],
    learnId: "business-revenue-hub",
  });
}

// ════════════════════════════════════════════════════════════════════════
// HOME SURFACE — single-flow command page that replaces the two-column
// analytics+controls layout. Three vertical zones:
//   1. KPI strip   (4 live stat cards)
//   2. Jump tiles  (6 entry-points: Workspace / Overview / Clients /
//                   Brand / Funnels / Settings)
//   3. Activity    (mixed timeline of transactions, leads, page edits)
//
// Renders only when bs.activeSection === "profile" — the default route.
// Other sections (workspace, overview, clients, brand, settings) handle
// their own layouts upstream of this function.
// ════════════════════════════════════════════════════════════════════════

// loadRecentKanban moved to controllers/business.ts so the workspace tab can
// reuse it for the linked-projects panel without duplicating the loader.

function renderHomeSurface(state: AppViewState, bs: BusinessState, client: GatewayBrowserClient) {
  // Trigger the data fetches the home surface needs. No-ops when already
  // loaded (the summary loader checks businessId equality before refetching).
  // Revenue is no longer read from the legacy business.income store here —
  // it lives in the Business hub (see renderRevenueHubLink).
  if (
    bs.activeBusinessId &&
    (!bs.summary || bs.summary.businessId !== bs.activeBusinessId) &&
    !bs.summaryLoading &&
    client
  ) {
    void loadBusinessSummary(state, client);
  }
  // Recent kanban — TTL-aware. The loader short-circuits when the cache
  // is < 30s old, so this stays cheap; switching business or assigning
  // a project to a business invalidates the cache and forces a refetch.
  if (client && bs.activeBusinessId) {
    void loadRecentKanban(state, client);
  }

  return html`
    <div class="bz-home">
      ${renderHomeSystemStatus(state, bs, client)}
      ${renderHomeKpiStrip(state, bs)}
      ${renderHomeJumpTiles(state, bs)}
      ${renderHomePriorities(state, bs, client)}
      ${renderHomeActiveProjects(state, bs, client)}
      ${renderHomeTaskBoard(state, bs)}
      ${renderHomeActivity(state, bs, client)}
    </div>
    ${bs.homeDetailModal ? renderHomeDetailModal(state, bs, client) : nothing}
  `;
}

// ── System status rail ──────────────────────────────────────
// At-a-glance health of the integrations the Command Center depends on.
// Each pill shows the integration name + its current value (e.g. last sync
// time, project count) + a status dot. Click any pill to jump to the
// relevant setting / panel. Replaces the buried HUD-header status indicators
// with foreground oversight.

interface SystemPill {
  key: string;
  icon: TemplateResult;
  label: string;
  value: string;
  state: "ok" | "warn" | "off" | "link";
  onClick?: () => void;
}

function renderHomeSystemStatus(
  state: AppViewState,
  bs: BusinessState,
  _client: GatewayBrowserClient,
) {
  const lastSyncMs = bs.notionSyncStatus?.lastSync ?? null;
  const lastSyncStr = lastSyncMs ? fmtRelative(lastSyncMs) : "never";
  const businessesCount = bs.businesses.length;
  const planLoaded = !!bs.planContentPreview && bs.planContentPreview.length > 0;
  const brandReady =
    !!state.brandState && (state.brandState as unknown as { loading?: boolean }).loading !== true;

  const pills: SystemPill[] = [
    {
      key: "notion",
      icon: I.doc,
      label: "Notion",
      value: bs.notionConnected ? `synced ${lastSyncStr}` : "disconnected",
      state: bs.notionConnected ? (bs.notionSyncStatus?.error ? "warn" : "ok") : "off",
      onClick: () => {
        bs.activeSection = "settings";
        state.requestUpdate?.();
      },
    },
    {
      key: "gateway",
      icon: I.globe,
      label: "Gateway",
      value: state.connected ? "online" : "offline",
      state: state.connected ? "ok" : "off",
    },
    {
      key: "businesses",
      icon: I.briefcase,
      label: "Businesses",
      value:
        businessesCount === 0
          ? "none yet"
          : `${businessesCount} active${bs.activeBusinessId ? "" : " · none selected"}`,
      state: businessesCount > 0 ? "ok" : "off",
    },
    {
      key: "revenue",
      icon: I.chart,
      label: "Revenue",
      value: "Business hub ›",
      state: "link",
      onClick: () => openHubSection(state, "revenue"),
    },
    {
      key: "plan",
      icon: I.note,
      label: "Plan content",
      value: planLoaded
        ? `${bs.planContentPreview!.length.toLocaleString()} chars cached`
        : bs.profileForm.planNotionUrl
          ? "URL set, not fetched"
          : "no URL",
      state: planLoaded ? "ok" : bs.profileForm.planNotionUrl ? "warn" : "off",
    },
    {
      key: "brand",
      icon: I.palette,
      label: "Brand",
      value: brandReady ? "loaded" : "not loaded",
      state: brandReady ? "ok" : "off",
      onClick: () => {
        bs.activeSection = "brand";
        state.requestUpdate?.();
      },
    },
  ];

  return html`
    <section class="bz-systems-rail" aria-label="System status">
      ${pills.map(
        (p) => html`
        <button
          class="bz-system-pill bz-system-pill--${p.state}"
          @click=${p.onClick ?? (() => {})}
          ?disabled=${!p.onClick}
          title=${`${p.label}: ${p.value}`}
        >
          <span class="bz-system-pill-icon">${p.icon}</span>
          <span class="bz-system-pill-text">
            <span class="bz-system-pill-label">${p.label}</span>
            <span class="bz-system-pill-value">${p.value}</span>
          </span>
          <span class="bz-system-pill-status-dot" aria-hidden="true"></span>
        </button>
      `,
      )}
    </section>
  `;
}

function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n >= 100 ? 0 : 2,
  }).format(n);
}

// Revenue hide-mode — masks every currency value on the business dashboard
// and command-center analytics tab behind "••••" until the user re-reveals.
// State is persisted in localStorage so it survives reloads.
const REVENUE_HIDE_KEY = "business.hideRevenue";

function isRevenueHidden(): boolean {
  try {
    return localStorage.getItem(REVENUE_HIDE_KEY) === "1";
  } catch {
    return false;
  }
}

function toggleRevenueHidden(state: AppViewState): void {
  try {
    const next = !isRevenueHidden();
    localStorage.setItem(REVENUE_HIDE_KEY, next ? "1" : "0");
  } catch {}
  state.requestUpdate?.();
}

function maskMoney(n: number | null | undefined): string {
  if (isRevenueHidden()) return "••••";
  return fmtMoney(n);
}

function fmtCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(
    n,
  );
}

function fmtRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function renderHomeKpiStrip(_state: AppViewState, bs: BusinessState) {
  // Scope projects to the active business. Projects with no businessId stay
  // visible across every workspace so newly-onboarded items still count.
  const projects = (bs.recentKanban?.projects ?? []).filter(
    (p) => !bs.activeBusinessId || p.businessId === bs.activeBusinessId,
  );

  let totalMade = 0;
  let totalPending = 0;
  let activeProjects = 0;
  const ACTIVE_PROJECT_STATUSES = new Set([
    "In progress",
    "Updating",
    "Reviewing",
    "Awaiting Client",
  ]);
  const activeProjectIds = new Set<string>();
  for (const p of projects) {
    if (typeof p.paidAmount === "number") totalMade += p.paidAmount;
    if (typeof p.pendingPay === "number") totalPending += p.pendingPay;
    if (p.status && ACTIVE_PROJECT_STATUSES.has(p.status)) {
      activeProjects += 1;
      activeProjectIds.add(p.id);
    }
  }

  // Active tasks: any task that's open (not done) AND attached to one of the
  // business's active projects, so the count tracks what's actively being
  // worked on for this brand rather than the global backlog.
  const ACTIVE_TASK_STATUSES = new Set(["todo", "in_progress", "review", "backlog"]);
  const tasks = bs.recentKanban?.tasks ?? [];
  let activeTasks = 0;
  for (const t of tasks) {
    if (!t.projectId || !activeProjectIds.has(t.projectId)) continue;
    if (t.status && ACTIVE_TASK_STATUSES.has(t.status)) activeTasks += 1;
  }

  return html`
    <section class="bz-kpi-strip">
      <article class="bz-kpi bz-kpi--up">
        <span class="bz-kpi-icon">${I.chart}</span>
        <span class="bz-kpi-label">Total made</span>
        <span class="bz-kpi-value">${maskMoney(totalMade)}</span>
        <span class="bz-kpi-sub">sum of project paid amounts</span>
      </article>
      <article class="bz-kpi">
        <span class="bz-kpi-icon">${I.target}</span>
        <span class="bz-kpi-label">Total pending</span>
        <span class="bz-kpi-value">${maskMoney(totalPending)}</span>
        <span class="bz-kpi-sub">sum of project pending pay</span>
      </article>
      <article class="bz-kpi">
        <span class="bz-kpi-icon">${I.briefcase}</span>
        <span class="bz-kpi-label">Active projects</span>
        <span class="bz-kpi-value">${fmtCompact(activeProjects)}</span>
        <span class="bz-kpi-sub">in progress · reviewing · awaiting</span>
      </article>
      <article class="bz-kpi">
        <span class="bz-kpi-icon">${I.zap}</span>
        <span class="bz-kpi-label">Active tasks</span>
        <span class="bz-kpi-value">${fmtCompact(activeTasks)}</span>
        <span class="bz-kpi-sub">open across active projects</span>
      </article>
    </section>
  `;
}

interface JumpTile {
  id: string;
  icon: TemplateResult;
  label: string;
  desc: string;
  accent: string;
  go: () => void;
  disabled?: boolean;
  badge?: string;
}

function renderHomeJumpTiles(state: AppViewState, bs: BusinessState) {
  const noBiz = !bs.activeBusinessId;
  const clientCount = bs._clientsState?.clients?.length ?? null;
  const projectCount = bs.recentKanban?.projects?.length ?? null;
  const taskCount = bs.recentKanban?.tasks?.length ?? null;
  const leadCount = bs.summary?.leads?.total ?? null;
  const pageCount = bs.summary?.kpi?.views ?? null;

  const fmtCount = (n: number | null): string | undefined => {
    if (n == null) return undefined;
    return new Intl.NumberFormat(undefined, {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(n);
  };

  type ExtendedTile = JumpTile & { primary?: boolean; count?: string; countLabel?: string };
  const tiles: ExtendedTile[] = [
    {
      id: "workspace",
      icon: I.briefcase,
      label: "Workspace",
      desc: "CRM, Sales, Operations databases.",
      accent: "var(--g-primary)",
      go: () => {
        bs.activeSection = "workspace";
        state.requestUpdate?.();
      },
      disabled: noBiz,
      primary: true,
      count: fmtCount(projectCount),
      countLabel: "projects",
    },
    {
      id: "overview",
      icon: I.chart,
      label: "Overview",
      desc: "Pages, leads, KPIs, assets.",
      accent: "#22c55e",
      go: () => {
        bs.activeSection = "overview";
        state.requestUpdate?.();
      },
      disabled: noBiz,
      primary: true,
      count: fmtCount(pageCount),
      countLabel: "page views",
    },
    {
      id: "clients",
      icon: I.users,
      label: "Clients",
      desc: "CRM scoped to this business.",
      accent: "#a855f7",
      go: () => {
        bs.activeSection = "clients";
        state.requestUpdate?.();
      },
      disabled: noBiz,
      count: fmtCount(clientCount),
      countLabel: clientCount === 1 ? "client" : "clients",
    },
    {
      id: "brand",
      icon: I.palette,
      label: "Brand",
      desc: "Identity, palette, fonts, assets.",
      accent: "#ec4899",
      go: () => {
        bs.activeSection = "brand";
        state.requestUpdate?.();
      },
      disabled: noBiz,
    },
    {
      // Form leads (landing pages, funnels, lead qualifiers) now land in the
      // Business hub as contacts with an open deal, so this tile opens the
      // hub pipeline instead of the legacy funnels page.
      id: "leads",
      icon: I.zap,
      label: "Leads",
      desc: "Form leads land as deals in the Business hub.",
      accent: "var(--g-primary)",
      go: () => openHubSection(state, "pipeline"),
      count: fmtCount(leadCount),
      countLabel: leadCount === 1 ? "lead" : "leads",
    },
    {
      id: "tasks",
      icon: I.target,
      label: "Tasks",
      desc: "Pull tasks across active projects.",
      accent: "#f59e0b",
      go: () => {
        (state as unknown as { tab: string }).tab = "kanban";
        state.requestUpdate?.();
      },
      disabled: noBiz,
      count: fmtCount(taskCount),
      countLabel: taskCount === 1 ? "task" : "tasks",
    },
    {
      id: "settings",
      icon: I.settings,
      label: "Settings",
      desc: "Profile, AI context, Notion.",
      accent: "#94a3b8",
      go: () => {
        bs.activeSection = "settings";
        state.requestUpdate?.();
      },
      disabled: noBiz,
    },
  ];

  return html`
    <section class="bz-tiles">
      ${tiles.map(
        (t) => html`
        <button
          class="bz-tile ${t.primary ? "bz-tile--primary" : ""}"
          ?disabled=${t.disabled}
          @click=${t.go}
          title=${t.disabled ? "Pick a business first" : `Open ${t.label}`}
        >
          <div class="bz-tile-aurora"></div>
          <span class="bz-tile-icon">${t.icon}</span>
          <span class="bz-tile-label">${t.label}</span>
          <span class="bz-tile-desc">${t.desc}</span>
          ${
            t.count
              ? html`<span class="bz-tile-count">${t.count}${t.countLabel ? html` <span style="opacity:0.7;">${t.countLabel}</span>` : nothing}</span>`
              : nothing
          }
          ${t.badge ? html`<span class="bz-tile-badge">${t.badge}</span>` : nothing}
          <span class="bz-tile-arrow" aria-hidden="true">→</span>
        </button>
      `,
      )}
    </section>
  `;
}

// ── Top Priorities ───────────────────────────────────────────
// Up to 5 pinned projects per business. Order is meaningful (#1 = top
// focus). Persisted to localStorage so the choice survives reloads. Drag
// & drop reorders in place; the picker dropdown adds projects from the
// kanban list (already cached on bs.recentKanban for the activity feed).

function renderHomePriorities(
  state: AppViewState,
  bs: BusinessState,
  client: GatewayBrowserClient,
) {
  const businessId = bs.activeBusinessId ?? null;
  const allProjects = bs.recentKanban?.projects ?? [];
  // Project lookup keyed by canonical (no-dashes, lowercase) id so a
  // dashed Notion UUID matches its undashed form. Notion-backed pinned
  // ids round-trip in different shapes depending on whether the project
  // came from the local store or directly from Notion's API.
  const canon = (s: string | null | undefined): string => (s ?? "").replace(/-/g, "").toLowerCase();
  const projectById = new Map<
    string,
    { id: string; name: string; status: string | null; businessId?: string | null }
  >();
  for (const p of allProjects) {
    const k = canon(p.id);
    if (k) projectById.set(k, p);
  }

  // Run the legacy localStorage → gateway migration once per render-pass.
  // No-op when the profile already has priorities, or when the legacy
  // bucket is empty. Cheap to call repeatedly.
  migrateLegacyPriorities(bs, client, businessId);

  // Read the live priorities from the BusinessProfile (already loaded by
  // loadBusiness on app start). The auto-prune for stale ids is intentionally
  // NOT here — pinned ids are kept until the user explicitly removes them,
  // because an early/empty kanban list shouldn't get to wipe a multi-week
  // pinned focus list.
  const rawIds = getPriorities(bs, businessId);
  const cacheLoaded = bs.recentKanban !== null;
  const resolvedIds = rawIds;

  const atMax = resolvedIds.length >= MAX_PRIORITIES;
  const noBiz = !businessId;

  // Picker source: every project linked to this business (or all when no
  // businessId scope) minus the ones already pinned. Sorted by recency so
  // the most relevant options surface first.
  const pinnedCanon = new Set(resolvedIds.map(canon));
  const pickerCandidates = allProjects
    .filter((p) => !pinnedCanon.has(canon(p.id)))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  const onDragStart = (idx: number) => (e: DragEvent) => {
    bs.draggingPriorityIndex = idx;
    bs.priorityDropTarget = idx;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      // Some browsers refuse to fire drop without setData.
      e.dataTransfer.setData("text/plain", String(idx));
    }
    state.requestUpdate?.();
  };
  const onDragOver = (idx: number) => (e: DragEvent) => {
    if (bs.draggingPriorityIndex == null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (bs.priorityDropTarget !== idx) {
      bs.priorityDropTarget = idx;
      state.requestUpdate?.();
    }
  };
  const onDrop = (idx: number) => (e: DragEvent) => {
    e.preventDefault();
    const from = bs.draggingPriorityIndex;
    bs.draggingPriorityIndex = null;
    bs.priorityDropTarget = null;
    if (from == null || from === idx) {
      state.requestUpdate?.();
      return;
    }
    reorderPriority(bs, client, businessId, from, idx);
    state.requestUpdate?.();
  };
  const onDragEnd = () => {
    if (bs.draggingPriorityIndex == null && bs.priorityDropTarget == null) return;
    bs.draggingPriorityIndex = null;
    bs.priorityDropTarget = null;
    state.requestUpdate?.();
  };

  return html`
    <section class="bz-priorities">
      <header class="bz-pri-head">
        <div class="bz-pri-head-text">
          <span class="bz-eyebrow">Focus</span>
          <h2 class="bz-pri-title">Top Priorities</h2>
          <span class="bz-pri-count">${resolvedIds.length} of ${MAX_PRIORITIES} · drag to reorder</span>
        </div>
        <button
          class="bz-pri-add"
          ?disabled=${noBiz || atMax || pickerCandidates.length === 0}
          title=${
            noBiz
              ? "Pick a business first"
              : atMax
                ? `Maximum ${MAX_PRIORITIES} priorities — remove one to add another`
                : pickerCandidates.length === 0
                  ? "No projects available — create one in the Kanban first"
                  : "Add a project to your top priorities"
          }
          @click=${(e: Event) => {
            e.stopPropagation();
            bs.priorityPickerOpen = !bs.priorityPickerOpen;
            state.requestUpdate?.();
          }}
        >
          <span style="display:inline-flex; width:14px; height:14px;">${I.plus}</span>
          <span>Add priority</span>
        </button>
      </header>

      ${
        resolvedIds.length === 0
          ? html`
            <div class="bz-pri-empty">
              ${
                noBiz
                  ? "Pick a business to start pinning your top priorities."
                  : pickerCandidates.length === 0
                    ? "No projects yet. Create one in the Kanban, then pin up to 5 here."
                    : "Pin up to 5 projects to focus on. Click “Add priority” to start."
              }
            </div>
          `
          : html`
            <ol class="bz-pri-list">
              ${resolvedIds.map((id, idx) => {
                // Cache may not be loaded yet — render shimmer placeholders
                // for the name + status until loadRecentKanban resolves so
                // the panel feels active rather than stuck. Real labels
                // fill in on the next render.
                const proj = projectById.get(canon(id));
                const showSkeleton = !cacheLoaded && !proj;
                const projName = proj?.name?.trim() || (cacheLoaded ? "Untitled project" : "");
                const projStatus = proj?.status ?? null;
                const status = (projStatus ?? "").toLowerCase().replace(/\s+/g, "-");
                const isDragging = bs.draggingPriorityIndex === idx;
                const target = bs.priorityDropTarget;
                const dragFrom = bs.draggingPriorityIndex;
                const showBefore =
                  !isDragging && target === idx && dragFrom != null && dragFrom > idx;
                const showAfter =
                  !isDragging && target === idx && dragFrom != null && dragFrom < idx;
                return html`
                  <li
                    class="bz-pri-card"
                    draggable="true"
                    data-dragging=${isDragging ? "true" : "false"}
                    data-drop-before=${showBefore ? "true" : "false"}
                    data-drop-after=${showAfter ? "true" : "false"}
                    title="Open project details"
                    @dragstart=${onDragStart(idx)}
                    @dragover=${onDragOver(idx)}
                    @drop=${onDrop(idx)}
                    @dragend=${onDragEnd}
                    @click=${(e: MouseEvent) => {
                      // Drag handle / remove button stop propagation themselves;
                      // a body click opens the detail modal. Skipping when
                      // skeleton placeholders are showing avoids opening on a
                      // not-yet-resolved id.
                      if (showSkeleton) return;
                      const targetId = proj?.id ?? id;
                      if (e.shiftKey || e.metaKey || e.ctrlKey) {
                        // Power-user shortcut: skip the modal and jump to /projects.
                        (state as unknown as { tab: string }).tab = "projects";
                        (
                          state as unknown as { kanbanSelectedProjectId?: string }
                        ).kanbanSelectedProjectId = targetId;
                        if (typeof window !== "undefined") window.location.hash = "#/projects";
                      } else {
                        bs.homeDetailModal = { kind: "project", id: targetId };
                      }
                      state.requestUpdate?.();
                    }}
                  >
                    <span class="bz-pri-handle" aria-hidden="true">${I.grip}</span>
                    <span class="bz-pri-rank">${idx + 1}</span>
                    <div class="bz-pri-body">
                      ${
                        showSkeleton
                          ? html`
                              <span
                                class="bz-skel bz-skel--block"
                                style="width: 65%; height: 12px"
                                aria-label="Loading project name"
                                >&nbsp;</span
                              >
                              <span
                                class="bz-skel bz-skel--block"
                                style="width: 32px; height: 9px; margin-top: 4px"
                                aria-hidden="true"
                                >&nbsp;</span
                              >
                            `
                          : html`<span class="bz-pri-name">${projName}</span>
                               <span class="bz-pri-detail">Project</span>`
                      }
                    </div>
                    ${
                      showSkeleton
                        ? html`
                            <span class="bz-skel bz-skel--pill" style="width: 64px; height: 16px" aria-hidden="true"
                              >&nbsp;</span
                            >
                          `
                        : projStatus
                          ? html`<span class="bz-pri-status" data-status=${status}>${projStatus}</span>`
                          : html`
                              <span></span>
                            `
                    }
                    <button
                      class="bz-pri-remove"
                      title="Remove from priorities"
                      @click=${(e: Event) => {
                        e.stopPropagation();
                        removePriority(bs, client, businessId, id);
                        state.requestUpdate?.();
                      }}
                    >
                      <span style="display:inline-flex; width:14px; height:14px;">${I.close}</span>
                    </button>
                  </li>
                `;
              })}
            </ol>
          `
      }

      ${
        bs.priorityPickerOpen && !noBiz && !atMax
          ? html`
            <div
              class="bz-pri-picker"
              @click=${(e: Event) => e.stopPropagation()}
            >
              ${
                pickerCandidates.length === 0
                  ? html`
                      <div class="bz-pri-picker-empty">No projects available to pin.</div>
                    `
                  : pickerCandidates.map(
                      (p) => html`
                    <button
                      class="bz-pri-picker-item"
                      @click=${async () => {
                        addPriority(bs, client, businessId, p.id);
                        bs.priorityPickerOpen = false;
                        state.requestUpdate?.();
                        // Auto-link the project to this business if it's not
                        // already linked. Pinning a project as a "top priority"
                        // of business X strongly implies it belongs to X — we
                        // shouldn't make the user also do it manually from
                        // /projects. Persists through kanban.projects.update,
                        // which writes project_meta.businessId. The kanban
                        // controller's invalidation already drops the
                        // recentKanban + summary caches, so the linked-projects
                        // panel and KPIs refresh on next render.
                        if (businessId && p.businessId !== businessId) {
                          try {
                            await client.request("kanban.projects.update", {
                              id: p.id,
                              patch: { businessId },
                            });
                            if (bs.recentKanban) {
                              bs.recentKanban = {
                                ...bs.recentKanban,
                                projects: bs.recentKanban.projects.map((x) =>
                                  x.id === p.id ? { ...x, businessId } : x,
                                ),
                              };
                            }
                            bs.summary = null;
                            bs.summaryLoadedAt = null;
                            state.requestUpdate?.();
                          } catch (err) {
                            console.warn("[priorities] auto-link to business failed:", err);
                          }
                        }
                      }}
                    >
                      <span>${p.name || "Untitled project"}</span>
                      ${
                        p.status
                          ? html`<span class="bz-pri-picker-item-detail">${p.status}</span>`
                          : nothing
                      }
                    </button>
                  `,
                    )
              }
            </div>
          `
          : nothing
      }
    </section>
  `;
}

// ── Active Projects ──────────────────────────────────────────
// Every project where the user ticked "Active Client Project". No cap,
// scoped to the active business. Independent of the pinned Top Priorities
// list. Horizontal scroll on desktop, 3 cards visible at a time.

function renderHomeActiveProjects(
  state: AppViewState,
  bs: BusinessState,
  client: GatewayBrowserClient,
) {
  const businessId = bs.activeBusinessId ?? null;
  const allProjects = bs.recentKanban?.projects ?? [];

  // Filter to active projects scoped to the current business (or unscoped)
  const activeProjects = allProjects.filter((p) => {
    if (!p.active) return false;
    if (businessId && p.businessId && p.businessId !== businessId) return false;
    return true;
  });

  const hidden = bs.activeProjectsHidden ?? false;
  const count = activeProjects.length;
  const cacheLoaded = bs.recentKanban !== null;

  const fmtMoney = (n: number | null | undefined): string => {
    if (n == null) return "—";
    if (n >= 1000) return `$${(n / 1000).toFixed(1)}k`;
    return `$${Math.round(n)}`;
  };

  const businessById = new Map<string, string>();
  // Build biz name map from loaded profiles for cross-business badge
  for (const biz of bs.businesses ?? []) {
    businessById.set(biz.id, biz.name);
  }

  return html`
    <section class="bz-act-projects">
      <header class="bz-act-head">
        <div class="bz-act-head-text">
          <span class="bz-eyebrow">Running</span>
          <h2 class="bz-act-title">Active Projects</h2>
          <span class="bz-act-count">${count} active${cacheLoaded ? "" : " · loading…"}</span>
        </div>
        <button
          class="bz-pri-add"
          @click=${() => {
            bs.activeProjectsHidden = !hidden;
            state.requestUpdate?.();
          }}
          title=${hidden ? "Show active projects" : "Collapse active projects"}
        >
          ${hidden ? "Show" : "Hide"}
        </button>
      </header>

      ${
        hidden
          ? nothing
          : count === 0
            ? html`
              <div class="bz-act-empty">
                ${
                  !cacheLoaded
                    ? "Loading projects…"
                    : !businessId
                      ? "Select a business to see its active projects."
                      : 'No active projects yet. Open any project in the Kanban and tick "Active Client Project" to surface it here.'
                }
              </div>
            `
            : html`
              <div class="bz-act-scroll">
                <div class="bz-act-cards">
                  ${activeProjects.map((p) => {
                    const statusKey = (p.status ?? "").toLowerCase().replace(/\s+/g, "-");
                    const bizName = p.businessId ? (businessById.get(p.businessId) ?? null) : null;
                    const isCross = businessId && p.businessId && p.businessId !== businessId;
                    return html`
                      <div
                        class="bz-act-card"
                        tabindex="0"
                        role="button"
                        title="Open ${p.name}"
                        @click=${() => {
                          bs.homeDetailModal = { kind: "project", id: p.id };
                          state.requestUpdate?.();
                        }}
                        @keydown=${(e: KeyboardEvent) => {
                          if (e.key === "Enter" || e.key === " ") {
                            bs.homeDetailModal = { kind: "project", id: p.id };
                            state.requestUpdate?.();
                          }
                        }}
                      >
                        <div class="bz-act-card-head">
                          <span class="bz-act-pulse" aria-hidden="true"></span>
                          <span class="bz-act-name">${p.name || "Untitled project"}</span>
                          ${
                            p.status
                              ? html`<span class="bz-pri-status" data-status=${statusKey}>${p.status}</span>`
                              : nothing
                          }
                        </div>
                        ${
                          isCross && bizName
                            ? html`<span class="bz-act-biz">${bizName}</span>`
                            : nothing
                        }
                        <div class="bz-act-kpi">
                          ${
                            p.paidAmount != null
                              ? html`<div class="bz-act-kpi-item">
                                <span class="bz-act-kpi-label">Paid</span>
                                <span class="bz-act-kpi-value bz-act-kpi-value--gold">${fmtMoney(p.paidAmount)}</span>
                              </div>`
                              : nothing
                          }
                          ${
                            p.pendingPay != null
                              ? html`<div class="bz-act-kpi-item">
                                <span class="bz-act-kpi-label">Pending</span>
                                <span class="bz-act-kpi-value">${fmtMoney(p.pendingPay)}</span>
                              </div>`
                              : nothing
                          }
                        </div>
                      </div>
                    `;
                  })}
                </div>
              </div>
            `
      }
    </section>
  `;
}

// ── Home Task Board ──────────────────────────────────────────
// Incomplete tasks across this business, rendered as a kanban-style
// column board. Group setting (status / project / priority) is persisted
// to localStorage. Each card shows a project highlight (colored top
// stripe + project name pill) so the user can spot which project a task
// belongs to at a glance.

const TASK_PRIORITY_ORDER = ["critical", "high", "normal", "low"] as const;
const TASK_PRIORITY_LABEL: Record<string, string> = {
  critical: "Critical",
  high: "High",
  normal: "Normal",
  low: "Low",
};
const TASK_PRIORITY_ACCENT: Record<string, string> = {
  critical: "#ef4444",
  high: "#f59e0b",
  normal: "#06b6d4",
  low: "#64748b",
};
// Stable order for status columns. Anything not in this list is appended
// alphabetically after these. Notion + canonical TaskStatus values share
// this map (case-insensitive lookup).
const TASK_STATUS_ORDER: Record<string, number> = {
  backlog: 0,
  "not started": 1,
  todo: 2,
  "to do": 2,
  "in progress": 3,
  in_progress: 3,
  updating: 4,
  review: 5,
  reviewing: 5,
  "awaiting client": 6,
  blocked: 7,
  paused: 8,
  done: 100, // pinned to the right when shown
  complete: 100,
  completed: 100,
};

function isTaskComplete(status: string | null): boolean {
  if (!status) return false;
  const s = status.toLowerCase();
  return s === "done" || s.includes("complete");
}

/** Stable HSL accent from a string (project id or name). Used for the
 *  card's project-highlight stripe + chip border. */
function projectAccentFromId(id: string): string {
  if (!id) return "hsl(0, 0%, 50%)";
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 55%)`;
}

function dueDateBadge(
  dueDate: string | null,
  now: number = Date.now(),
): { label: string; tone: "overdue" | "soon" | "later" } | null {
  if (!dueDate) return null;
  const ts = Date.parse(dueDate);
  if (!Number.isFinite(ts)) return null;
  const day = 24 * 60 * 60 * 1000;
  const diff = ts - now;
  if (diff < 0) return { label: "Overdue", tone: "overdue" };
  if (diff < day * 2) return { label: "Due soon", tone: "soon" };
  if (diff < day * 7) return { label: "This week", tone: "later" };
  return null;
}

interface TaskColumn {
  key: string;
  label: string;
  accent: string;
  tasks: Array<{
    id: string;
    title: string;
    status: string | null;
    projectId: string | null;
    updatedAt: number | null;
    priority: string | null;
    dueDate: string | null;
  }>;
}

function renderHomeTaskBoard(state: AppViewState, bs: BusinessState) {
  const businessId = bs.activeBusinessId;
  if (!businessId) return nothing;
  const allProjects = bs.recentKanban?.projects ?? [];
  const allTasks = bs.recentKanban?.tasks ?? [];
  // Project lookup. Used both for the business-scope filter (task.project →
  // project.businessId) and for the project-highlight chip on each card.
  // Indexed by a canonical (no-dashes, lowercased) form so a Notion UUID
  // stripped of dashes still matches its dashed twin — without this, tasks
  // pulled from one source and projects from another (mixed local + Notion
  // sync) would silently disappear from the board.
  const canon = (s: string | null | undefined): string => (s ?? "").replace(/-/g, "").toLowerCase();
  const projectById = new Map<string, { id: string; name: string; businessId?: string | null }>();
  for (const p of allProjects) {
    const k = canon(p.id);
    if (k) projectById.set(k, p);
  }

  // Tasks scoped to this business: keep tasks whose parent project is linked
  // to the active business, OR (when project meta is unknown) keep tasks
  // with an unlinked project so the user isn't blind. Drops completed tasks.
  // Canonical-id lookup so Notion UUID format drift doesn't hide rows.
  const lookupProject = (taskProjectId: string | null | undefined) => {
    const k = canon(taskProjectId);
    return k ? (projectById.get(k) ?? null) : null;
  };
  const showDone = !!bs.taskBoardShowDone;
  const scoped = allTasks.filter((t) => {
    // When showDone is on, keep completed tasks too — they land in their
    // own column (status mode) or sit alongside open ones (project/priority).
    if (!showDone && isTaskComplete(t.status)) return false;
    if (!t.projectId) return false;
    const proj = lookupProject(t.projectId);
    if (!proj) return false;
    return proj.businessId === businessId;
  });

  // Bucket into columns based on the current group setting.
  const groupBy = bs.taskBoardGroupBy;
  const columns = bucketTasksIntoColumns(scoped, groupBy, projectById);

  const openCount = scoped.filter((t) => !isTaskComplete(t.status)).length;
  const doneCount = scoped.length - openCount;

  const groupOptions: Array<{ key: "status" | "project" | "priority"; label: string }> = [
    { key: "status", label: "Status" },
    { key: "project", label: "Project" },
    { key: "priority", label: "Priority" },
  ];

  return html`
    <section class="bz-tboard">
      <header class="bz-tboard-head">
        <div class="bz-tboard-head-text">
          <span class="bz-eyebrow">Pipeline</span>
          <h2 class="bz-tboard-title">${showDone ? "Tasks" : "Incomplete Tasks"}</h2>
          <span class="bz-tboard-count">
            ${openCount} open${showDone && doneCount > 0 ? ` · ${doneCount} done` : ""} · grouped by ${groupBy}
          </span>
        </div>
        <div class="bz-tboard-controls">
          <div class="bz-tboard-pill-group" role="tablist" aria-label="Group tasks by">
            ${groupOptions.map(
              (opt) => html`
                <button
                  class="bz-tboard-pill ${groupBy === opt.key ? "is-active" : ""}"
                  role="tab"
                  aria-selected=${groupBy === opt.key}
                  @click=${() => setTaskBoardGroupBy(state, opt.key)}
                  title="Group by ${opt.label.toLowerCase()}"
                >
                  ${opt.label}
                </button>
              `,
            )}
          </div>
          <button
            class="bz-tboard-toggle ${showDone ? "is-active" : ""}"
            role="switch"
            aria-checked=${showDone}
            @click=${() => setTaskBoardShowDone(state, !showDone)}
            title=${showDone ? "Hide completed tasks" : "Include completed tasks"}
          >
            <span class="bz-tboard-toggle-track" aria-hidden="true">
              <span class="bz-tboard-toggle-thumb"></span>
            </span>
            <span>Show done</span>
          </button>
        </div>
      </header>

      ${
        bs.recentKanban === null
          ? html`
            <div class="bz-tboard-scroll">
              <div class="bz-tboard-cols">${renderTaskBoardSkeleton()}</div>
            </div>
          `
          : scoped.length === 0
            ? html`
              <div class="bz-tboard-empty">
                No open tasks for this business. New tasks created in
                <button
                  class="bz-inline-link"
                  @click=${() => {
                    (state as unknown as { tab: string }).tab = "projects";
                    if (typeof window !== "undefined") window.location.hash = "#/projects";
                    state.requestUpdate?.();
                  }}
                >Projects</button>
                will show up here.
              </div>
            `
            : html`
              <div class="bz-tboard-scroll">
                <div class="bz-tboard-cols">
                  ${columns.map((col) => renderTaskColumn(state, col, projectById))}
                </div>
              </div>
            `
      }
    </section>
  `;
}

/**
 * Three placeholder columns with shimmer task cards. Rendered while
 * `bs.recentKanban === null` (cold-start before the kanban list has
 * landed). The layout mirrors the real board so the panel doesn't jump
 * once data resolves — only the content swaps in.
 */
function renderTaskBoardSkeleton(): TemplateResult {
  const columnCounts = [3, 2, 2];
  return html`${columnCounts.map(
    (cardCount) => html`
      <div class="bz-tcol bz-tcol--skeleton" aria-hidden="true">
        <header class="bz-tcol-head">
          <span class="bz-skel" style="width: 8px; height: 8px; border-radius: 50%;">&nbsp;</span>
          <span class="bz-skel bz-skel--block" style="flex: 1; height: 10px;">&nbsp;</span>
          <span class="bz-skel bz-skel--pill" style="width: 22px; height: 14px;">&nbsp;</span>
        </header>
        <ol class="bz-tcol-list">
          ${Array.from(
            { length: cardCount },
            () => html`
              <li class="bz-tcard bz-tcard--skeleton">
                <span class="bz-tcard-stripe" aria-hidden="true"></span>
                <div class="bz-tcard-body">
                  <span class="bz-skel bz-skel--block" style="width: 90%; height: 12px">&nbsp;</span>
                  <div class="bz-tcard-meta">
                    <span class="bz-skel bz-skel--pill" style="width: 80px; height: 14px">&nbsp;</span>
                    <span class="bz-skel bz-skel--pill" style="width: 50px; height: 14px">&nbsp;</span>
                  </div>
                </div>
              </li>
            `,
          )}
        </ol>
      </div>
    `,
  )}`;
}

function bucketTasksIntoColumns(
  tasks: TaskColumn["tasks"],
  groupBy: "status" | "project" | "priority",
  projectById: Map<string, { id: string; name: string }>,
): TaskColumn[] {
  const buckets = new Map<string, TaskColumn>();
  const add = (key: string, label: string, accent: string, t: TaskColumn["tasks"][number]) => {
    let col = buckets.get(key);
    if (!col) {
      col = { key, label, accent, tasks: [] };
      buckets.set(key, col);
    }
    col.tasks.push(t);
  };
  if (groupBy === "status") {
    for (const t of tasks) {
      const raw = (t.status ?? "Untitled").trim() || "Untitled";
      const key = raw.toLowerCase();
      add(key, raw, "var(--g-primary)", t);
    }
    // Sort by canonical status order, fallback to alpha.
    return Array.from(buckets.values()).sort((a, b) => {
      const ai = TASK_STATUS_ORDER[a.key] ?? 99;
      const bi = TASK_STATUS_ORDER[b.key] ?? 99;
      if (ai !== bi) return ai - bi;
      return a.label.localeCompare(b.label);
    });
  }
  if (groupBy === "priority") {
    for (const t of tasks) {
      const key = (t.priority ?? "normal").toLowerCase();
      const known = TASK_PRIORITY_LABEL[key];
      add(
        key,
        known ?? key.charAt(0).toUpperCase() + key.slice(1),
        TASK_PRIORITY_ACCENT[key] ?? "var(--g-primary)",
        t,
      );
    }
    return Array.from(buckets.values()).sort((a, b) => {
      const ai = TASK_PRIORITY_ORDER.indexOf(a.key as (typeof TASK_PRIORITY_ORDER)[number]);
      const bi = TASK_PRIORITY_ORDER.indexOf(b.key as (typeof TASK_PRIORITY_ORDER)[number]);
      const aa = ai === -1 ? 99 : ai;
      const bb = bi === -1 ? 99 : bi;
      if (aa !== bb) return aa - bb;
      return a.label.localeCompare(b.label);
    });
  }
  // groupBy === "project"
  for (const t of tasks) {
    const pid = t.projectId ?? "_none";
    // The Map is keyed by canonical id (no dashes, lowercase) — see
    // renderHomeTaskBoard. Canonicalize here too so the project name
    // resolves regardless of how the task's projectId was formatted.
    const canonPid = pid === "_none" ? "_none" : pid.replace(/-/g, "").toLowerCase();
    const proj = canonPid !== "_none" ? projectById.get(canonPid) : null;
    const label = proj?.name?.trim() || (pid === "_none" ? "No project" : "Untitled project");
    // Use the project's own id as the bucket key when we resolved one, so
    // tasks pointing at "abcd-1234" and "abcd1234" land in the same column.
    const bucketKey = proj?.id ?? pid;
    add(bucketKey, label, projectAccentFromId(bucketKey), t);
  }
  // Sort columns by task count descending — busiest projects on the left.
  return Array.from(buckets.values()).sort(
    (a, b) => b.tasks.length - a.tasks.length || a.label.localeCompare(b.label),
  );
}

function renderTaskColumn(
  state: AppViewState,
  col: TaskColumn,
  projectById: Map<string, { id: string; name: string }>,
): TemplateResult {
  // Sort within the column: priority first (critical→low), then due-soon
  // before later, then most-recently-updated. Mirrors what the user expects
  // from a focus list: hot stuff first, fresh stuff next.
  const sorted = [...col.tasks].sort((a, b) => {
    const ap = TASK_PRIORITY_ORDER.indexOf(
      (a.priority ?? "normal") as (typeof TASK_PRIORITY_ORDER)[number],
    );
    const bp = TASK_PRIORITY_ORDER.indexOf(
      (b.priority ?? "normal") as (typeof TASK_PRIORITY_ORDER)[number],
    );
    const aa = ap === -1 ? 99 : ap;
    const bb = bp === -1 ? 99 : bp;
    if (aa !== bb) return aa - bb;
    const ad = a.dueDate ? Date.parse(a.dueDate) : Number.POSITIVE_INFINITY;
    const bd = b.dueDate ? Date.parse(b.dueDate) : Number.POSITIVE_INFINITY;
    if (ad !== bd) return ad - bd;
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  });
  return html`
    <div class="bz-tcol" style="--tcol-accent: ${col.accent};">
      <header class="bz-tcol-head">
        <span class="bz-tcol-dot" aria-hidden="true"></span>
        <span class="bz-tcol-name">${col.label}</span>
        <span class="bz-tcol-count">${sorted.length}</span>
      </header>
      <ol class="bz-tcol-list">
        ${sorted.map((t) => renderTaskCard(state, t, projectById))}
      </ol>
    </div>
  `;
}

function renderTaskCard(
  state: AppViewState,
  t: TaskColumn["tasks"][number],
  projectById: Map<string, { id: string; name: string }>,
): TemplateResult {
  // Canonical lookup — the Map keys are stripped of dashes and lowercased
  // upstream so dashed/undashed Notion UUIDs resolve to the same project.
  const canonPid = (t.projectId ?? "").replace(/-/g, "").toLowerCase();
  const proj = canonPid ? projectById.get(canonPid) : null;
  const projAccent = proj
    ? projectAccentFromId(proj.id)
    : t.projectId
      ? projectAccentFromId(t.projectId)
      : "var(--g-primary)";
  const due = dueDateBadge(t.dueDate);
  const priorityKey = (t.priority ?? "").toLowerCase();
  const priorityAccent = TASK_PRIORITY_ACCENT[priorityKey];
  return html`
    <li
      class="bz-tcard"
      style="--tcard-accent: ${projAccent};"
      title=${proj ? `Open task — ${proj.name}` : "Open task details"}
      @click=${(e: MouseEvent) => {
        // Shift / meta / ctrl click → jump straight to the kanban board
        // for power users who already know what they want. Default click
        // pops the home detail modal so the user doesn't lose context.
        const bs = state.businessState;
        if (!bs) return;
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          (state as unknown as { tab: string }).tab = "projects";
          if (t.projectId) {
            (state as unknown as { kanbanSelectedProjectId?: string }).kanbanSelectedProjectId =
              t.projectId;
          }
          if (typeof window !== "undefined") window.location.hash = "#/projects";
        } else {
          bs.homeDetailModal = { kind: "task", id: t.id };
        }
        state.requestUpdate?.();
      }}
    >
      <span class="bz-tcard-stripe" aria-hidden="true"></span>
      <div class="bz-tcard-body">
        <div class="bz-tcard-title">${t.title}</div>
        <div class="bz-tcard-meta">
          ${
            proj
              ? html`<span class="bz-tcard-proj"><span class="bz-tcard-proj-dot" aria-hidden="true"></span>${proj.name}</span>`
              : nothing
          }
          ${
            priorityKey && TASK_PRIORITY_LABEL[priorityKey]
              ? html`<span
                class="bz-tcard-pri"
                style=${priorityAccent ? `--tcard-pri: ${priorityAccent};` : ""}
              >${TASK_PRIORITY_LABEL[priorityKey]}</span>`
              : nothing
          }
          ${
            due
              ? html`<span class="bz-tcard-due bz-tcard-due--${due.tone}">${due.label}</span>`
              : nothing
          }
        </div>
      </div>
    </li>
  `;
}

// ── Home Detail Modal (project + task) ──────────────────────
//
// Shared modal for both kinds of cards on the command center. We don't
// fetch extra data — everything is already in `bs.recentKanban` (loaded
// for the activity feed, task board, and priorities). For projects, we
// also pull the related task list so the modal acts as a mini-board.
//
// Click anywhere outside the dialog body, hit Escape, or click the close
// button to dismiss. Shift/Cmd/Ctrl-click on the source card bypasses
// the modal and jumps straight to /projects (handled in the card itself).

function closeHomeDetailModal(state: AppViewState): void {
  const bs = state.businessState;
  if (!bs) return;
  bs.homeDetailModal = null;
  state.requestUpdate?.();
}

function jumpToProjectsBoard(state: AppViewState, projectId: string): void {
  (state as unknown as { tab: string }).tab = "projects";
  (state as unknown as { kanbanSelectedProjectId?: string }).kanbanSelectedProjectId = projectId;
  if (typeof window !== "undefined") window.location.hash = "#/projects";
  closeHomeDetailModal(state);
}

function renderHomeDetailModal(
  state: AppViewState,
  bs: BusinessState,
  client: GatewayBrowserClient,
): TemplateResult {
  const modal = bs.homeDetailModal;
  if (!modal)
    return html`

    `;
  const onBackdrop = (e: MouseEvent) => {
    if (e.target === e.currentTarget) closeHomeDetailModal(state);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeHomeDetailModal(state);
  };
  // The backdrop binds keydown so Esc works once it has focus. Without
  // an autofocus, focus stays on whatever card opened the modal, so the
  // first Esc keypress wouldn't reach this handler. The `ref` callback
  // calls .focus() once the element mounts.
  const focusOnMount = (el: Element | undefined) => {
    if (el && document.activeElement !== el) {
      try {
        (el as HTMLElement).focus({ preventScroll: true });
      } catch {
        /* noop */
      }
    }
  };
  return html`
    <div
      class="bz-modal-backdrop"
      tabindex="-1"
      ${ref(focusOnMount)}
      @click=${onBackdrop}
      @keydown=${onKey}
    >
      ${
        modal.kind === "project"
          ? renderProjectDetailBody(state, bs, modal.id, client)
          : renderTaskDetailBody(state, bs, modal.id)
      }
    </div>
  `;
}

// Cash-flow inputs for the project detail modal. Persists to Notion (or the
// local SQLite mirror) via `kanban.projects.update`; the recentKanban cache
// is patched optimistically so the KPI strip recomputes without a refetch.
function renderProjectCashFlow(
  state: AppViewState,
  bs: BusinessState,
  client: GatewayBrowserClient,
  project: {
    id: string;
    pendingPay?: number | null;
    paidAmount?: number | null;
    pendingPayDate?: string | null;
    paidAmountDate?: string | null;
  },
): TemplateResult {
  const persist = async (patch: {
    pendingPay?: number | null;
    paidAmount?: number | null;
    pendingPayDate?: string | null;
    paidAmountDate?: string | null;
  }) => {
    if (bs.recentKanban) {
      bs.recentKanban = {
        ...bs.recentKanban,
        projects: bs.recentKanban.projects.map((p) =>
          p.id === project.id ? { ...p, ...patch } : p,
        ),
      };
      state.requestUpdate?.();
    }
    try {
      await client.request("kanban.projects.update", { id: project.id, patch });
    } catch (err) {
      console.warn("[project cash flow] update failed:", err);
    }
  };
  const parseAmount = (raw: string): number | null => {
    const cleaned = raw.replace(/[$,\s]/g, "");
    if (cleaned === "") return null;
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  };
  const fmtAmount = (n: number | null | undefined): string => (n == null ? "" : String(n));
  return html`
    <section class="bz-modal-section">
      <header class="bz-modal-section-head">
        <span class="bz-eyebrow">Cash flow</span>
        <span class="bz-modal-count">USD</span>
      </header>
      <div class="bz-cashflow-grid">
        <label class="bz-cashflow-field">
          <span class="bz-cashflow-label">Pending pay</span>
          <span class="bz-cashflow-input-wrap">
            <span class="bz-cashflow-prefix">$</span>
            <input
              class="bz-cashflow-input"
              type="number"
              step="0.01"
              min="0"
              inputmode="decimal"
              placeholder="0.00"
              .value=${fmtAmount(project.pendingPay)}
              @change=${(e: Event) => {
                const v = parseAmount((e.target as HTMLInputElement).value);
                void persist({ pendingPay: v });
              }}
            />
          </span>
          <input
            class="bz-cashflow-date"
            type="date"
            title="Optional — scopes this pending amount to a calendar month"
            .value=${project.pendingPayDate ?? ""}
            @change=${(e: Event) => {
              const v = (e.target as HTMLInputElement).value || null;
              void persist({ pendingPayDate: v });
            }}
          />
        </label>
        <label class="bz-cashflow-field">
          <span class="bz-cashflow-label">Paid amount</span>
          <span class="bz-cashflow-input-wrap">
            <span class="bz-cashflow-prefix">$</span>
            <input
              class="bz-cashflow-input"
              type="number"
              step="0.01"
              min="0"
              inputmode="decimal"
              placeholder="0.00"
              .value=${fmtAmount(project.paidAmount)}
              @change=${(e: Event) => {
                const v = parseAmount((e.target as HTMLInputElement).value);
                void persist({ paidAmount: v });
              }}
            />
          </span>
          <input
            class="bz-cashflow-date"
            type="date"
            title="Optional — when this payment was received"
            .value=${project.paidAmountDate ?? ""}
            @change=${(e: Event) => {
              const v = (e.target as HTMLInputElement).value || null;
              void persist({ paidAmountDate: v });
            }}
          />
        </label>
      </div>
    </section>
  `;
}

function renderProjectDetailBody(
  state: AppViewState,
  bs: BusinessState,
  projectId: string,
  client: GatewayBrowserClient,
): TemplateResult {
  const allProjects = bs.recentKanban?.projects ?? [];
  const allTasks = bs.recentKanban?.tasks ?? [];
  const canon = (s: string | null | undefined): string => (s ?? "").replace(/-/g, "").toLowerCase();
  const target = canon(projectId);
  const project = allProjects.find((p) => canon(p.id) === target) ?? null;

  if (!project) {
    return html`
      <div class="bz-modal" @click=${(e: Event) => e.stopPropagation()}>
        <header class="bz-modal-head">
          <span class="bz-eyebrow">Project</span>
          <h3 class="bz-modal-title">Project not found</h3>
          <button class="bz-modal-close" @click=${() => closeHomeDetailModal(state)} title="Close (Esc)">${I.close}</button>
        </header>
        <div class="bz-modal-body">
          <p class="bz-modal-empty">
            This project may have been deleted from the kanban or hasn't synced yet.
            ${bs.recentKanbanLoading ? "Still loading the project list — try again in a moment." : ""}
          </p>
        </div>
      </div>
    `;
  }

  const projectTasks = allTasks
    .filter((t) => canon(t.projectId) === target)
    .sort((a, b) => {
      const aDone = isTaskComplete(a.status) ? 1 : 0;
      const bDone = isTaskComplete(b.status) ? 1 : 0;
      if (aDone !== bDone) return aDone - bDone;
      const ap = TASK_PRIORITY_ORDER.indexOf(
        (a.priority ?? "normal") as (typeof TASK_PRIORITY_ORDER)[number],
      );
      const bp = TASK_PRIORITY_ORDER.indexOf(
        (b.priority ?? "normal") as (typeof TASK_PRIORITY_ORDER)[number],
      );
      const aa = ap === -1 ? 99 : ap;
      const bb = bp === -1 ? 99 : bp;
      if (aa !== bb) return aa - bb;
      return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    });
  const openTasks = projectTasks.filter((t) => !isTaskComplete(t.status));
  const doneTasks = projectTasks.filter((t) => isTaskComplete(t.status));
  const accent = projectAccentFromId(project.id);
  const projectStatus = project.status ?? null;
  const statusKey = (projectStatus ?? "").toLowerCase().replace(/\s+/g, "-");
  const isPinned = getPriorities(bs, bs.activeBusinessId).map(canon).includes(target);

  return html`
    <div class="bz-modal" style="--bz-modal-accent: ${accent};" @click=${(e: Event) => e.stopPropagation()}>
      <header class="bz-modal-head">
        <span class="bz-eyebrow">Project</span>
        <h3 class="bz-modal-title">${project.name || "Untitled project"}</h3>
        <div class="bz-modal-meta">
          ${
            projectStatus
              ? html`<span class="bz-pri-status" data-status=${statusKey}>${projectStatus}</span>`
              : nothing
          }
          ${
            isPinned
              ? html`
                  <span class="bz-modal-tag">Pinned</span>
                `
              : nothing
          }
          ${
            project.active
              ? html`
                  <span class="bz-modal-tag bz-modal-tag--gold">Active</span>
                `
              : nothing
          }
          ${
            project.businessId
              ? html`
                  <span class="bz-modal-tag bz-modal-tag--muted">Linked to business</span>
                `
              : html`
                  <span class="bz-modal-tag bz-modal-tag--muted">Unlinked</span>
                `
          }
        </div>
        <button class="bz-modal-close" @click=${() => closeHomeDetailModal(state)} title="Close (Esc)">${I.close}</button>
      </header>
      <div class="bz-modal-body">
        ${renderProjectCashFlow(state, bs, client, project)}
        <section class="bz-modal-section">
          <header class="bz-modal-section-head">
            <span class="bz-eyebrow">Tasks</span>
            <span class="bz-modal-count">
              ${openTasks.length} open${doneTasks.length > 0 ? ` · ${doneTasks.length} done` : ""}
            </span>
          </header>
          ${
            projectTasks.length === 0
              ? html`
                  <p class="bz-modal-empty">No tasks for this project yet.</p>
                `
              : html`
                <ul class="bz-modal-tasks">
                  ${projectTasks.map((t) => {
                    const status = (t.status ?? "").toLowerCase();
                    const due = dueDateBadge(t.dueDate);
                    const priorityKey = (t.priority ?? "").toLowerCase();
                    return html`
                      <li
                        class="bz-modal-task ${isTaskComplete(t.status) ? "is-done" : ""}"
                        @click=${() => {
                          bs.homeDetailModal = { kind: "task", id: t.id };
                          state.requestUpdate?.();
                        }}
                      >
                        <span class="bz-modal-task-status" data-status=${status}>${t.status ?? "—"}</span>
                        <span class="bz-modal-task-title">${t.title}</span>
                        ${
                          priorityKey && TASK_PRIORITY_LABEL[priorityKey]
                            ? html`<span class="bz-modal-task-pri" style="--tcard-pri: ${TASK_PRIORITY_ACCENT[priorityKey] ?? "var(--g-primary)"};">${TASK_PRIORITY_LABEL[priorityKey]}</span>`
                            : nothing
                        }
                        ${
                          due
                            ? html`<span class="bz-tcard-due bz-tcard-due--${due.tone}">${due.label}</span>`
                            : nothing
                        }
                      </li>
                    `;
                  })}
                </ul>
              `
          }
        </section>
      </div>
      <footer class="bz-modal-foot">
        <button class="bz-link-btn" @click=${() => closeHomeDetailModal(state)}>Close</button>
        ${
          !isPinned
            ? html`<button
              class="bz-link-btn"
              title="Pin to Top Priorities"
              @click=${() => {
                const bizId = bs.activeBusinessId ?? null;
                addPriority(bs, client, bizId, project.id);
                state.requestUpdate?.();
              }}
            >Pin priority</button>`
            : html`<button
              class="bz-link-btn"
              title="Remove from Top Priorities"
              @click=${() => {
                const bizId = bs.activeBusinessId ?? null;
                removePriority(bs, client, bizId, project.id);
                state.requestUpdate?.();
              }}
            >Unpin</button>`
        }
        <button
          class="bz-link-btn"
          title=${project.active ? "Mark as inactive" : "Mark as active"}
          @click=${async () => {
            const newActive = !project.active;
            if (bs.recentKanban) {
              bs.recentKanban = {
                ...bs.recentKanban,
                projects: bs.recentKanban.projects.map((p) =>
                  p.id === project.id ? { ...p, active: newActive } : p,
                ),
              };
              state.requestUpdate?.();
            }
            try {
              await client.request("kanban.projects.update", {
                id: project.id,
                patch: { active: newActive },
              });
            } catch (err) {
              console.warn("[project detail] active toggle failed:", err);
            }
          }}
        >${project.active ? "Mark inactive" : "Mark active"}</button>
        <button
          class="bz-modal-cta"
          @click=${() => jumpToProjectsBoard(state, project.id)}
          title="Open this project on the kanban board"
        >Open in /projects →</button>
      </footer>
    </div>
  `;
}

function renderTaskDetailBody(
  state: AppViewState,
  bs: BusinessState,
  taskId: string,
): TemplateResult {
  const allTasks = bs.recentKanban?.tasks ?? [];
  const allProjects = bs.recentKanban?.projects ?? [];
  const canon = (s: string | null | undefined): string => (s ?? "").replace(/-/g, "").toLowerCase();
  const task = allTasks.find((t) => t.id === taskId) ?? null;

  if (!task) {
    return html`
      <div class="bz-modal" @click=${(e: Event) => e.stopPropagation()}>
        <header class="bz-modal-head">
          <span class="bz-eyebrow">Task</span>
          <h3 class="bz-modal-title">Task not found</h3>
          <button class="bz-modal-close" @click=${() => closeHomeDetailModal(state)} title="Close (Esc)">${I.close}</button>
        </header>
        <div class="bz-modal-body">
          <p class="bz-modal-empty">
            This task may have been deleted or hasn't synced yet.
            ${bs.recentKanbanLoading ? "Still loading the task list — try again in a moment." : ""}
          </p>
        </div>
      </div>
    `;
  }

  const project = task.projectId
    ? (allProjects.find((p) => canon(p.id) === canon(task.projectId)) ?? null)
    : null;
  const accent = project
    ? projectAccentFromId(project.id)
    : task.priority
      ? (TASK_PRIORITY_ACCENT[(task.priority ?? "").toLowerCase()] ?? "var(--g-primary)")
      : "var(--g-primary)";
  const statusKey = (task.status ?? "").toLowerCase();
  const due = dueDateBadge(task.dueDate);
  const priorityKey = (task.priority ?? "").toLowerCase();
  const updatedAgo = task.updatedAt ? fmtRelative(task.updatedAt) : null;

  return html`
    <div class="bz-modal" style="--bz-modal-accent: ${accent};" @click=${(e: Event) => e.stopPropagation()}>
      <header class="bz-modal-head">
        <span class="bz-eyebrow">Task</span>
        <h3 class="bz-modal-title">${task.title}</h3>
        <div class="bz-modal-meta">
          ${
            task.status
              ? html`<span class="bz-pri-status" data-status=${statusKey}>${task.status}</span>`
              : nothing
          }
          ${
            priorityKey && TASK_PRIORITY_LABEL[priorityKey]
              ? html`<span class="bz-modal-tag" style="color:${TASK_PRIORITY_ACCENT[priorityKey] ?? "var(--g-primary)"}; border-color:color-mix(in srgb, ${TASK_PRIORITY_ACCENT[priorityKey] ?? "var(--g-primary)"} 32%, transparent);">${TASK_PRIORITY_LABEL[priorityKey]}</span>`
              : nothing
          }
          ${
            due
              ? html`<span class="bz-tcard-due bz-tcard-due--${due.tone}">${due.label}</span>`
              : nothing
          }
        </div>
        <button class="bz-modal-close" @click=${() => closeHomeDetailModal(state)} title="Close (Esc)">${I.close}</button>
      </header>
      <div class="bz-modal-body">
        <dl class="bz-modal-fields">
          <div class="bz-modal-field">
            <dt>Project</dt>
            <dd>
              ${
                project
                  ? html`<button
                    class="bz-modal-field-link"
                    @click=${() => {
                      bs.homeDetailModal = { kind: "project", id: project.id };
                      state.requestUpdate?.();
                    }}
                    title="View this project"
                  >${project.name}</button>`
                  : html`<span class="bz-modal-field-muted">${task.projectId ? "Unknown project" : "No project"}</span>`
              }
            </dd>
          </div>
          <div class="bz-modal-field">
            <dt>Status</dt>
            <dd>${
              task.status ??
              html`
                <span class="bz-modal-field-muted">—</span>
              `
            }</dd>
          </div>
          <div class="bz-modal-field">
            <dt>Priority</dt>
            <dd>${
              priorityKey && TASK_PRIORITY_LABEL[priorityKey]
                ? TASK_PRIORITY_LABEL[priorityKey]
                : html`
                    <span class="bz-modal-field-muted">—</span>
                  `
            }</dd>
          </div>
          <div class="bz-modal-field">
            <dt>Due</dt>
            <dd>${
              task.dueDate
                ? task.dueDate
                : html`
                    <span class="bz-modal-field-muted">No due date</span>
                  `
            }</dd>
          </div>
          <div class="bz-modal-field">
            <dt>Updated</dt>
            <dd>${
              updatedAgo ??
              html`
                <span class="bz-modal-field-muted">—</span>
              `
            }</dd>
          </div>
        </dl>
      </div>
      <footer class="bz-modal-foot">
        <button class="bz-link-btn" @click=${() => closeHomeDetailModal(state)}>Close</button>
        ${
          task.projectId
            ? html`<button
              class="bz-modal-cta"
              @click=${() => jumpToProjectsBoard(state, task.projectId!)}
              title="Open the kanban board for this project"
            >Open in /projects →</button>`
            : nothing
        }
      </footer>
    </div>
  `;
}

interface ActivityItem {
  ts: number;
  kind: "lead" | "page" | "project" | "task";
  title: string;
  detail: string;
  amount?: string;
  href?: string;
}

function renderHomeActivity(state: AppViewState, bs: BusinessState, _client: GatewayBrowserClient) {
  const items: ActivityItem[] = [];

  // Payments are no longer listed here: revenue lives in the Business hub
  // (the legacy business.income transactions stopped receiving new entries).

  // Leads — recent form submissions (they also land in the Business hub as
  // contacts with an open deal, so clicking one opens the hub pipeline).
  for (const l of bs.summary?.leads.recent ?? []) {
    const name =
      typeof l.data?.name === "string"
        ? l.data.name
        : typeof l.data?.email === "string"
          ? l.data.email
          : "Lead";
    items.push({
      ts: l.receivedAtMs,
      kind: "lead",
      title: `New lead: ${name}`,
      detail: `Form ${l.formId.slice(0, 8)}…`,
    });
  }

  // Recent page edits.
  for (const p of bs.summary?.pages.recent ?? []) {
    const ts = Date.parse(p.updatedAt);
    if (Number.isFinite(ts)) {
      items.push({
        ts,
        kind: "page",
        title: p.name,
        detail: `Page · ${p.status}`,
      });
    }
  }

  // Recent kanban activity — projects + tasks. When a business is active,
  // prefer items linked to it (via kanban project meta); otherwise show
  // everything so an unconfigured workspace still gets a useful feed.
  const activeBiz = bs.activeBusinessId;
  const projectsFiltered = (bs.recentKanban?.projects ?? []).filter(
    (p) => !activeBiz || p.businessId === activeBiz,
  );
  for (const p of projectsFiltered) {
    if (p.updatedAt == null) continue;
    items.push({
      ts: p.updatedAt,
      kind: "project",
      title: p.name,
      detail: p.status ? `Project · ${p.status}` : "Project",
    });
  }
  // Map projects → ids that this business should see, then filter tasks.
  const allowedProjectIds = new Set(projectsFiltered.map((p) => p.id));
  for (const t of bs.recentKanban?.tasks ?? []) {
    if (t.updatedAt == null) continue;
    if (activeBiz && t.projectId && !allowedProjectIds.has(t.projectId)) continue;
    items.push({
      ts: t.updatedAt,
      kind: "task",
      title: t.title,
      detail: t.status ? `Task · ${t.status}` : "Task",
    });
  }

  items.sort((a, b) => b.ts - a.ts);
  const top = items.slice(0, 12);

  return html`
    <section class="bz-activity">
      <header class="bz-activity-head">
        <div>
          <span class="bz-eyebrow">Recent activity</span>
          <h2 class="bz-activity-title">Live feed</h2>
        </div>
        <button
          class="bz-link-btn bz-link-btn-sm"
          @click=${() => {
            bs.activeSection = "overview";
            state.requestUpdate?.();
          }}
        >Full overview →</button>
      </header>
      ${
        top.length === 0
          ? html`
              <div class="bz-activity-empty">
                No activity yet. Once leads come in, pages publish, or projects move, they'll appear here.
              </div>
            `
          : html`
            <ol class="bz-activity-list">
              ${top.map(
                (item) => html`
                <li
                  class="bz-activity-item bz-act-${item.kind} ${item.kind === "lead" ? "is-link" : ""}"
                  @click=${item.kind === "lead" ? () => openHubSection(state, "pipeline") : nothing}
                  title=${item.kind === "lead" ? "Open in Business hub › Pipeline" : nothing}
                >
                  <span class="bz-act-dot"></span>
                  <div class="bz-act-body">
                    <span class="bz-act-title">${item.title}</span>
                    <span class="bz-act-detail">${item.detail}</span>
                  </div>
                  ${item.amount ? html`<span class="bz-act-amount">${item.amount}</span>` : nothing}
                  <time class="bz-act-time" datetime=${new Date(item.ts).toISOString()}>${fmtRelative(item.ts)}</time>
                </li>
              `,
              )}
            </ol>
          `
      }
    </section>
  `;
}

function renderControls(state: AppViewState, bs: BusinessState, client: GatewayBrowserClient) {
  return html`
    <div class="cmd-controls cmd-controls-grid">
      <!-- AI Context Panel: spans full width on wide layouts.
           NOTE: renderAIContextPanel already returns its own .ai-context-panel
           wrapper, so the outer div is grid-placement only — no .control-panel
           class or it nests panels-in-panels and visually collapses the body. -->
      <div id="settings-context" class="control-panel--full">${renderAIContextPanel(state, bs, client)}</div>

      <div id="settings-income" class="control-panel--full">${renderRevenueHubLink(state)}</div>

      <!-- Quick Actions, grouped by intent -->
      <div id="settings-quick" class="control-panel">
        <div class="section-header-row">
          <span class="section-icon">${I.target}</span>
          <div class="section-title-row">
            <div class="section-title">Quick Actions</div>
            <div class="section-subtitle">Navigate and operate this business</div>
          </div>
        </div>

        <div class="actions-group">
          <div class="actions-group-label">
            <span class="actions-group-label-dot"></span>
            Navigate
          </div>
          <div class="quick-actions-3">
            <button class="action-btn primary" @click=${() => {
              bs.activeSection = "workspace";
              state.requestUpdate?.();
            }} ?disabled=${!bs.activeBusinessId}>
              <span class="icon">${I.briefcase}</span>
              <span>Workspace</span>
            </button>
            <button class="action-btn primary" @click=${() => {
              bs.activeSection = "overview";
              state.requestUpdate?.();
              void loadBusinessSummary(state, client);
            }} ?disabled=${!bs.activeBusinessId}>
              <span class="icon">${I.chart}</span>
              <span>Overview</span>
            </button>
            <button class="action-btn primary" @click=${() => {
              bs.activeSection = "clients";
              state.requestUpdate?.();
            }} ?disabled=${!bs.activeBusinessId}>
              <span class="icon">${I.users}</span>
              <span>Clients</span>
            </button>
          </div>
        </div>

        <div class="actions-group">
          <div class="actions-group-label">
            <span class="actions-group-label-dot"></span>
            Identity
          </div>
          <div class="quick-actions-3">
            <button class="action-btn" @click=${() => {
              bs.activeSection = "brand";
              state.requestUpdate?.();
            }} ?disabled=${!bs.activeBusinessId}>
              <span class="icon">${I.palette}</span>
              <span>Brand</span>
            </button>
            <button class="action-btn" @click=${() => fetchPlanContent(state, client)} ?disabled=${bs.planContentLoading || !bs.profileForm.planNotionUrl}>
              <span class="icon">${I.doc}</span>
              <span>${bs.planContentLoading ? "Fetching…" : "Plan"}</span>
            </button>
            <button class="action-btn" @click=${() => saveBusiness(state, client)} ?disabled=${bs.saving}>
              <span class="icon">${I.save}</span>
              <span>${bs.saving ? "Saving…" : "Save Profile"}</span>
            </button>
          </div>
        </div>

        <div class="actions-group">
          <div class="actions-group-label">
            <span class="actions-group-label-dot"></span>
            System
          </div>
          <div class="quick-actions-3">
            <button class="action-btn" @click=${() => syncNotionDatabase(state, client)} ?disabled=${bs.notionSyncStatus?.syncing || !bs.notionConnected}>
              <span class="icon">${I.refresh}</span>
              <span>${bs.notionSyncStatus?.syncing ? "Syncing…" : "Sync Notion"}</span>
            </button>
            <button class="action-btn" @click=${() => {
              bs.showCreateDialog = true;
              state.requestUpdate?.();
            }}>
              <span class="icon">${I.plus}</span>
              <span>New Business</span>
            </button>
            <button class="action-btn" @click=${() => openHubSection(state, "revenue")} title="Open Business hub › Revenue">
              <span class="icon">${I.chart}</span>
              <span>Revenue</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Notion Integration -->
      <div id="settings-notion" class="control-panel">
        <div class="section-header-row">
          <span class="section-icon ${bs.notionConnected ? "section-icon--ok" : "section-icon--off"}">${I.doc}</span>
          <div class="section-title-row">
            <div class="section-title">Notion Integration</div>
            <div class="section-subtitle">${
              bs.notionConnected
                ? bs.notionSyncStatus?.lastSync
                  ? `Last sync ${fmtRelative(bs.notionSyncStatus.lastSync)}`
                  : "Connected, never synced"
                : "Not connected"
            }</div>
          </div>
        </div>
        ${
          !bs.notionConnected
            ? html`
          <div class="notion-actions">
            <button class="btn primary" ?disabled=${bs.notionCreateLoading} @click=${() => createNotionDatabase(state, client)}>
              ${bs.notionCreateLoading ? "Creating…" : "Create database"}
            </button>
            <button class="btn" @click=${() => {
              bs.showNotionPicker = true;
              state.requestUpdate?.();
              loadNotionDatabases(state, client);
            }}>
              Connect existing
            </button>
          </div>
        `
            : html`
          <button class="btn btn--block" @click=${() => {
            bs.showNotionPicker = true;
            state.requestUpdate?.();
            loadNotionDatabases(state, client);
          }}>
            Change database
          </button>
        `
        }
      </div>

      <!-- Profile Editor -->
      <div id="settings-profile" class="control-panel">
        <div class="section-header-row">
          <span class="section-icon">${I.briefcase}</span>
          <div class="section-title-row">
            <div class="section-title">Edit Profile</div>
            <div class="section-subtitle">Identity, plan, AI-visible context</div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Business Name</label>
          <input class="form-input" type="text" placeholder="Enter business name"
            .value=${bs.profileForm.name}
            @input=${(e: Event) => {
              bs.profileForm.name = (e.target as HTMLInputElement).value;
              state.requestUpdate?.();
            }} />
        </div>
        <div class="form-group">
          <label class="form-label">Industry</label>
          <input class="form-input" type="text" placeholder="Technology, Finance, etc."
            .value=${bs.profileForm.industry}
            @input=${(e: Event) => {
              bs.profileForm.industry = (e.target as HTMLInputElement).value;
              state.requestUpdate?.();
            }} />
        </div>
        <div class="form-group">
          <label class="form-label">Notion Plan URL</label>
          <input class="form-input" type="text" placeholder="https://notion.so/..."
            .value=${bs.profileForm.planNotionUrl}
            @input=${(e: Event) => {
              bs.profileForm.planNotionUrl = (e.target as HTMLInputElement).value;
              state.requestUpdate?.();
            }} />
        </div>
        <div class="form-group">
          <label class="form-label">Business Context</label>
          <textarea class="form-textarea" placeholder="Goals, team, market position..."
            .value=${bs.profileForm.context}
            @input=${(e: Event) => {
              bs.profileForm.context = (e.target as HTMLTextAreaElement).value;
              state.requestUpdate?.();
            }}></textarea>
        </div>
      </div>

      <!-- Live Connections panel (replaces static System Log) -->
      <div id="settings-connections" class="control-panel control-panel--full">
        <div class="section-header-row">
          <span class="section-icon">${I.globe}</span>
          <div class="section-title-row">
            <div class="section-title">Connections</div>
            <div class="section-subtitle">Live state of every integration this Command Center depends on</div>
          </div>
        </div>
        ${renderConnectionsList(state, bs)}
      </div>

      <!-- Danger Zone — destructive actions parked away from everyday controls -->
      <div id="settings-danger" class="control-panel control-panel--full danger-zone">
        <div class="section-header-row">
          <span class="section-icon">${I.alert}</span>
          <div class="section-title-row">
            <div class="section-title">Danger Zone</div>
            <div class="section-subtitle">Irreversible operations — handle with care</div>
          </div>
        </div>
        <div class="danger-row">
          <div class="danger-row-body">
            <div class="danger-row-title">Delete this business</div>
            <div class="danger-row-sub">Removes the profile, brand settings, and unlinks integrations. Cannot be undone.</div>
          </div>
          <button class="action-btn danger" style="min-width:140px;"
            @click=${() => {
              bs.showDeleteConfirm = bs.activeBusinessId;
              state.requestUpdate?.();
            }}
            ?disabled=${!bs.activeBusinessId}>
            <span class="icon">${I.trash}</span>
            <span>Delete</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

// ── Settings shell (themed hero + sticky nav + save bar) ───────────
// Wraps the legacy renderControls() with: a hero header showing oversight
// chips (business / connections / sync / save state), a sticky chip-nav
// that anchors-jumps between panels, and a floating save bar at the bottom
// that exposes Save Profile + live save status so the user always has
// visibility into what state the profile is in.
function renderSettingsShell(state: AppViewState, bs: BusinessState, client: GatewayBrowserClient) {
  const biz = bs.businesses.find((b) => b.id === bs.activeBusinessId);
  const bizName = biz?.name?.trim() || (bs.activeBusinessId ? "Untitled" : "No business selected");
  const bizCount = bs.businesses.length;

  // Oversight chips — at-a-glance signals
  const notionState: "ok" | "warn" | "off" = bs.notionConnected
    ? bs.notionSyncStatus?.error
      ? "warn"
      : "ok"
    : "off";
  const notionValue = bs.notionConnected
    ? bs.notionSyncStatus?.lastSync
      ? `Synced ${fmtRelative(bs.notionSyncStatus.lastSync)}`
      : "Connected"
    : "Not connected";

  // Save state — saving / dirty (best-effort: presence of profile.name) / saved
  const saveState: "saving" | "ok" | "warn" = bs.saving
    ? "saving"
    : bs.profileForm?.name
      ? "ok"
      : "warn";
  const saveLabel = bs.saving
    ? "Saving changes…"
    : bs.profileForm?.name
      ? "Profile in good shape"
      : "Profile name missing";

  // Errors badge — count visible error text from controller state
  const errorState: "ok" | "warn" = bs.error ? "warn" : "ok";
  const errorValue = bs.error ? "Issue detected" : "All clear";

  const jumpTo = (anchorId: string) => {
    const host = state as unknown as { shadowRoot?: ShadowRoot | null; renderRoot?: ParentNode };
    const root: ParentNode | null = host.shadowRoot ?? host.renderRoot ?? null;
    const el = root?.querySelector?.(`#${anchorId}`) as HTMLElement | null;
    el?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  return html`
    <div class="bz-settings-shell">
      <header class="bz-settings-hero">
        <div class="bz-settings-head">
          <button
            class="bz-link-btn"
            @click=${() => {
              bs.activeSection = "profile";
              state.requestUpdate?.();
            }}
          >← Back to home</button>
          <div class="bz-settings-head-text">
            <span class="bz-eyebrow">Settings</span>
            <h2 class="bz-settings-title">
              <span class="bz-settings-title-icon">${I.settings}</span>
              <span class="bz-settings-title-text">${bizName}</span>
            </h2>
            <span class="bz-settings-subtitle">
              Tuning ${bizCount} business${bizCount === 1 ? "" : "es"} · Identity, AI context, Notion and connection health. Revenue lives in the Business hub.
            </span>
          </div>
          <div class="bz-settings-head-actions">
            <button class="bz-link-btn"
              @click=${() => syncNotionDatabase(state, client)}
              ?disabled=${bs.notionSyncStatus?.syncing || !bs.notionConnected}>
              <span class="bz-link-icon">${I.refresh}</span>
              ${bs.notionSyncStatus?.syncing ? "Syncing…" : "Sync Notion"}
            </button>
            <button class="bz-link-btn"
              @click=${() => openHubSection(state, "revenue")}
              title="Open Business hub › Revenue">
              <span class="bz-link-icon">${I.chart}</span>
              Revenue
            </button>
          </div>
        </div>

        <div class="bz-settings-chips">
          <div class="bz-settings-chip bz-settings-chip--ok" title="Active business">
            <span class="bz-settings-chip-dot"></span>
            <div class="bz-settings-chip-text">
              <span class="bz-settings-chip-label">Active</span>
              <span class="bz-settings-chip-value">${bizName}</span>
            </div>
          </div>
          <div class="bz-settings-chip bz-settings-chip--${notionState}" title="Notion integration">
            <span class="bz-settings-chip-dot"></span>
            <div class="bz-settings-chip-text">
              <span class="bz-settings-chip-label">Notion</span>
              <span class="bz-settings-chip-value">${notionValue}</span>
            </div>
          </div>
          <button class="bz-settings-chip bz-settings-chip--link" title="Open Business hub › Revenue"
            @click=${() => openHubSection(state, "revenue")}>
            <span class="bz-settings-chip-dot"></span>
            <div class="bz-settings-chip-text">
              <span class="bz-settings-chip-label">Revenue</span>
              <span class="bz-settings-chip-value">Business hub ›</span>
            </div>
          </button>
          <div class="bz-settings-chip bz-settings-chip--${saveState === "saving" ? "warn" : saveState}" title="Profile save state">
            <span class="bz-settings-chip-dot"></span>
            <div class="bz-settings-chip-text">
              <span class="bz-settings-chip-label">Profile</span>
              <span class="bz-settings-chip-value">${saveLabel}</span>
            </div>
          </div>
          <div class="bz-settings-chip bz-settings-chip--${errorState}" title="Last error">
            <span class="bz-settings-chip-dot"></span>
            <div class="bz-settings-chip-text">
              <span class="bz-settings-chip-label">Health</span>
              <span class="bz-settings-chip-value">${errorValue}</span>
            </div>
          </div>
        </div>
      </header>

      <nav class="bz-settings-nav" aria-label="Settings sections">
        <button class="bz-settings-nav-item" @click=${() => jumpTo("settings-context")}>
          <span class="bz-settings-nav-item-dot"></span>Context
        </button>
        <button class="bz-settings-nav-item bz-settings-nav-item--hub" @click=${() => openHubSection(state, "revenue")}
          title="Revenue lives in the Business hub">
          <span class="bz-settings-nav-item-dot"></span>Revenue ↗
        </button>
        <button class="bz-settings-nav-item" @click=${() => jumpTo("settings-quick")}>
          <span class="bz-settings-nav-item-dot"></span>Quick Actions
        </button>
        <button class="bz-settings-nav-item" @click=${() => jumpTo("settings-notion")}>
          <span class="bz-settings-nav-item-dot"></span>Notion
        </button>
        <button class="bz-settings-nav-item" @click=${() => jumpTo("settings-profile")}>
          <span class="bz-settings-nav-item-dot"></span>Profile
        </button>
        <button class="bz-settings-nav-item" @click=${() => jumpTo("settings-connections")}>
          <span class="bz-settings-nav-item-dot"></span>Connections
        </button>
        <button class="bz-settings-nav-item" @click=${() => jumpTo("settings-danger")}>
          <span class="bz-settings-nav-item-dot bz-settings-nav-item-dot--bad"></span>Danger
        </button>
      </nav>

      ${renderControls(state, bs, client)}

      <div class="bz-settings-savebar">
        <div class="bz-settings-savebar-status">
          <span class="bz-settings-savebar-pulse ${bs.saving ? "bz-settings-savebar-pulse--saving" : "bz-settings-savebar-pulse--ok"}"></span>
          <div class="bz-settings-savebar-text">
            <span class="bz-settings-savebar-label">Profile</span>
            <span class="bz-settings-savebar-value">${saveLabel}</span>
          </div>
        </div>
        <div class="bz-settings-savebar-actions">
          <button class="action-btn primary"
            @click=${() => saveBusiness(state, client)}
            ?disabled=${bs.saving || !bs.activeBusinessId}>
            <span class="icon">${I.save}</span>
            <span>${bs.saving ? "Saving…" : "Save"}</span>
          </button>
        </div>
      </div>
    </div>
  `;
}

// ── Connections list ─────────────────────────────────────────
// Visible inventory of every external integration the Command Center
// depends on. Each row shows: icon, name, current value, status pill.
// Replaces the static "System Log" panel with something that actually
// reflects the live state of the system.

function renderConnectionsList(state: AppViewState, bs: BusinessState) {
  type Conn = {
    key: string;
    icon: TemplateResult;
    label: string;
    value: string;
    state: "ok" | "warn" | "off" | "link";
    stateLabel: string;
    onClick?: () => void;
  };
  const lastSync = bs.notionSyncStatus?.lastSync ? fmtRelative(bs.notionSyncStatus.lastSync) : null;
  const brandReady =
    !!state.brandState && (state.brandState as unknown as { loading?: boolean }).loading !== true;

  const conns: Conn[] = [
    {
      key: "gateway",
      icon: I.globe,
      label: "Gateway",
      value: state.connected ? "WS connection open" : "disconnected",
      state: state.connected ? "ok" : "off",
      stateLabel: state.connected ? "Online" : "Offline",
    },
    {
      key: "notion",
      icon: I.doc,
      label: "Notion API",
      value: bs.notionConnected
        ? bs.notionSyncStatus?.error
          ? `last error: ${bs.notionSyncStatus.error}`
          : lastSync
            ? `last sync ${lastSync}`
            : "connected, never synced"
        : "no database connected",
      state: bs.notionConnected ? (bs.notionSyncStatus?.error ? "warn" : "ok") : "off",
      stateLabel: bs.notionConnected ? (bs.notionSyncStatus?.error ? "Warn" : "Connected") : "Off",
    },
    {
      key: "active-business",
      icon: I.briefcase,
      label: "Active business",
      value: bs.activeBusinessId ? bs.profileForm.name || "(unnamed)" : "none selected",
      state: bs.activeBusinessId ? "ok" : "warn",
      stateLabel: bs.activeBusinessId ? "Selected" : "None",
    },
    {
      key: "plan",
      icon: I.note,
      label: "Plan content",
      value: bs.planContentPreview
        ? `${bs.planContentPreview.length.toLocaleString()} chars cached`
        : bs.profileForm.planNotionUrl
          ? "URL set, not fetched"
          : "no plan URL",
      state: bs.planContentPreview ? "ok" : bs.profileForm.planNotionUrl ? "warn" : "off",
      stateLabel: bs.planContentPreview
        ? "Loaded"
        : bs.profileForm.planNotionUrl
          ? "Pending"
          : "Empty",
    },
    {
      key: "revenue",
      icon: I.chart,
      label: "Revenue (Whop / Stripe)",
      value: "connected and synced in Business hub › Revenue",
      state: "link",
      stateLabel: "Open hub",
      onClick: () => openHubSection(state, "revenue"),
    },
    {
      key: "brand",
      icon: I.palette,
      label: "Brand identity",
      value: brandReady ? "loaded for this business" : "not loaded",
      state: brandReady ? "ok" : "off",
      stateLabel: brandReady ? "Ready" : "Off",
    },
  ];

  return html`
    <div class="connections-list">
      ${conns.map(
        (c) =>
          c.onClick
            ? html`
        <button type="button" class="connection-row connection-row--${c.state}" @click=${c.onClick}>
          <span class="connection-row-icon">${c.icon}</span>
          <span class="connection-row-body">
            <span class="connection-row-label">${c.label}</span>
            <span class="connection-row-value">${c.value}</span>
          </span>
          <span class="connection-row-state">${c.stateLabel} ›</span>
        </button>
      `
            : html`
        <div class="connection-row connection-row--${c.state}">
          <span class="connection-row-icon">${c.icon}</span>
          <div class="connection-row-body">
            <span class="connection-row-label">${c.label}</span>
            <span class="connection-row-value">${c.value}</span>
          </div>
          <span class="connection-row-state">${c.stateLabel}</span>
        </div>
      `,
      )}
    </div>
  `;
}

// ── Empty State ──────────────────────────────────────────────

function renderEmptyState(state: AppViewState, bs: BusinessState, _client: GatewayBrowserClient) {
  // First visit ever — auto-open the wizard so beginners aren't dropped on a
  // staring-at-empty-state screen. After they complete it once OR explicitly
  // dismiss it, we never auto-open again; the buttons below stay available.
  if (!_wizOpen && !wasOnboardingCompletedOnce() && !wasOnboardingDismissed()) {
    queueMicrotask(() => openOnboarding(state));
  }
  return html`
    <div class="bz-home">
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">${I.briefcase}</div>
        <h2 class="empty-text">No businesses yet</h2>
        <p class="empty-hint">A guided setup will personalize your agent in about two minutes. You can also create a blank business and configure it later.</p>
        <div class="empty-actions">
          <button class="btn primary"
                  @click=${() => openOnboarding(state, { reset: true })}>
            <span class="btn-icon">${I.zap}</span> Start guided setup
          </button>
          <button class="btn"
                  @click=${() => {
                    bs.showCreateDialog = true;
                    state.requestUpdate?.();
                  }}>
            Create blank
          </button>
        </div>
      </div>
      ${renderHubLink(state, {
        section: "overview",
        title: "Leads, pipeline, clients and revenue live in the Business hub",
        text: "Find leads, work deals, run campaigns and connect Whop or Stripe there — this page keeps your business profiles, projects and tasks.",
        cta: "Open Business hub",
      })}
    </div>
  `;
}

// ── Global Client Search Modal ───────────────────────────────
// A search-and-pick popup wired into the HUD header. Lazy-loads the
// active business's client list, filters as you type, opens the detail
// page on selection. Closes on Esc or backdrop click.

let _clientSearchOpen = false;
let _clientSearchQuery = "";

function openClientSearch(state: AppViewState, client: GatewayBrowserClient) {
  _clientSearchOpen = true;
  _clientSearchQuery = "";
  state.requestUpdate?.();
  // Ensure the clients controller has loaded the list at least once.
  const bs = state.businessState;
  if (!bs) return;
  if (!bs._clientsState) {
    bs._clientsState = createInitialClientsState();
  }
  if (bs._clientsState.clients.length === 0 && !bs._clientsState.loading) {
    void loadClients(state, client);
  }
}

function closeClientSearch(state: AppViewState) {
  _clientSearchOpen = false;
  _clientSearchQuery = "";
  state.requestUpdate?.();
}

function renderClientSearchModal(
  state: AppViewState,
  bs: BusinessState,
  client: GatewayBrowserClient,
): TemplateResult | typeof nothing {
  if (!_clientSearchOpen) return nothing;
  const cs = bs._clientsState;
  const all = cs?.clients ?? [];
  const titleProp = cs?.schema ? getTitleProperty(cs.schema) : null;
  const q = _clientSearchQuery.trim().toLowerCase();
  const filtered = !q
    ? all.slice(0, 200)
    : all
        .filter((c) => {
          const data = c.data ?? {};
          const name = (titleProp ? data[titleProp] : null) ?? data.Name ?? data.name ?? "";
          const company = data.Company ?? data.company ?? "";
          const email = data.Email ?? data.email ?? "";
          return (
            String(name).toLowerCase().includes(q) ||
            String(company).toLowerCase().includes(q) ||
            String(email).toLowerCase().includes(q)
          );
        })
        .slice(0, 200);

  return html`
    <div class="bz-cs-overlay"
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) closeClientSearch(state);
      }}
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Escape") closeClientSearch(state);
      }}
    >
      <div class="bz-cs" role="dialog" aria-modal="true">
        <header class="bz-cs-head">
          <span class="bz-cs-eyebrow">Find a client</span>
          <button class="bz-cs-close" @click=${() => closeClientSearch(state)} aria-label="Close">×</button>
        </header>
        <input
          class="bz-cs-input"
          type="text"
          autofocus
          placeholder=${cs?.loading ? "Loading clients…" : `Search ${all.length} client${all.length === 1 ? "" : "s"} by name, company, or email…`}
          .value=${_clientSearchQuery}
          @input=${(e: Event) => {
            _clientSearchQuery = (e.target as HTMLInputElement).value;
            state.requestUpdate?.();
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Escape") closeClientSearch(state);
            if (e.key === "Enter" && filtered[0]) {
              const first = filtered[0];
              closeClientSearch(state);
              bs.activeSection = "clients";
              state.requestUpdate?.();
              setTimeout(() => openClientDetail(state, client, first), 0);
            }
          }}
        />
        <div class="bz-cs-meta">
          <span>${all.length === 0 && cs?.loading ? "" : `${filtered.length} match${filtered.length === 1 ? "" : "es"}`}</span>
          <span>Enter to open · Esc to close</span>
        </div>
        <div class="bz-cs-list">
          ${
            all.length === 0 && cs?.loading
              ? html`
                  <div class="bz-cs-empty">Loading…</div>
                `
              : filtered.length === 0
                ? html`
            <div class="bz-cs-empty">${q ? "No matches." : "No clients yet — add one from the Clients page."}</div>
          `
                : filtered.map((c) => {
                    const data = c.data ?? {};
                    const fromSchema = cs?.schema ? getClientName(c, cs.schema) : null;
                    const name =
                      (titleProp ? data[titleProp] : null) ??
                      data.Name ??
                      data.name ??
                      fromSchema ??
                      c.id;
                    const company = data.Company ?? data.company ?? "";
                    const email = data.Email ?? data.email ?? "";
                    const iconUrl = typeof data._icon === "string" ? data._icon : null;
                    const accent = typeof data._cardColor === "string" ? data._cardColor : "";
                    return html`
              <button
                class="bz-cs-row"
                @click=${() => {
                  closeClientSearch(state);
                  bs.activeSection = "clients";
                  state.requestUpdate?.();
                  setTimeout(() => openClientDetail(state, client, c), 0);
                }}
              >
                <span class="bz-cs-row-avatar ${iconUrl ? "has-image" : ""}"
                  style=${
                    iconUrl
                      ? `background-image: url('${iconUrl}');`
                      : `background: ${accent || "var(--g-primary)"};`
                  }
                >${iconUrl ? "" : initialsOf(String(name))}</span>
                <span class="bz-cs-row-text">
                  <span class="bz-cs-row-name">${name}</span>
                  ${company || email ? html`<span class="bz-cs-row-sub">${[company, email].filter(Boolean).join(" · ")}</span>` : nothing}
                </span>
                <span class="bz-cs-row-go">↵</span>
              </button>
            `;
                  })
          }
        </div>
      </div>
    </div>
  `;
}

function initialsOf(name: string): string {
  if (!name) return "??";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ── Business Onboarding Wizard ───────────────────────────────
// A multi-step popup that walks beginners through naming their business,
// declaring goals, pasting context for the agent, and toggling a couple of
// sensible defaults. The canonical identity is an agency workspace from
// agency.ops.*. This wizard deliberately does not create a second legacy
// business profile.

type WizStep = "welcome" | "identity" | "goals" | "context" | "settings" | "done";
const WIZ_STEPS: WizStep[] = ["welcome", "identity", "goals", "context", "settings", "done"];
const WIZ_DRAFT_KEY = "business.onboarding.draft";
const WIZ_DONE_KEY = "business.onboarding.completedOnce";

interface WizDraft {
  agencyId: string;
  name: string;
  industry: string;
  goals: string;
  context: string;
  notionUrl: string;
  hideRevenueDefault: boolean;
  voiceDefault: boolean;
}

const WIZ_INDUSTRY_CHIPS = [
  "Agency",
  "SaaS",
  "E-commerce",
  "Coaching",
  "Consulting",
  "Creator",
  "Real Estate",
  "Local Service",
  "Other",
];

const EMPTY_DRAFT: WizDraft = {
  agencyId: "",
  name: "",
  industry: "",
  goals: "",
  context: "",
  notionUrl: "",
  hideRevenueDefault: false,
  voiceDefault: false,
};

// Module-level wizard state. Single-business-at-a-time UI, so a module ref
// is fine and avoids extending the BusinessState interface.
let _wizOpen = false;
let _wizStep: WizStep = "welcome";
let _wizDraft: WizDraft = { ...EMPTY_DRAFT };
let _wizSaving = false;
let _wizAgencyLoading = false;
let _wizAgencyLoaded = false;
let _wizAgencyContext: {
  agencies: Array<{ id: string; name: string; role: string; ownership?: string }>;
  migration: {
    sourceExists?: boolean;
    businessesFound?: number;
    completedAt?: number | null;
    warnings?: string[];
  } | null;
  collaboration: {
    state?: string;
    message?: string;
    collaborationUrl?: string;
  } | null;
  error: string | null;
} = { agencies: [], migration: null, collaboration: null, error: null };

async function loadWizardAgencyContext(
  state: AppViewState,
  client: GatewayBrowserClient,
  force = false,
): Promise<void> {
  if (_wizAgencyLoading || (_wizAgencyLoaded && !force)) return;
  _wizAgencyLoading = true;
  _wizAgencyContext.error = null;
  state.requestUpdate?.();
  try {
    const [listResult, migrationResult, collaborationResult] = await Promise.all([
      client.request("agency.ops.agencies.list", {}),
      client.request("agency.ops.migration.preview", {}).catch(() => null),
      client.request("agency.ops.collaboration.status", {}).catch(() => null),
    ]);
    const list =
      listResult && typeof listResult === "object"
        ? (listResult as {
            agencies?: typeof _wizAgencyContext.agencies;
            migration?: typeof _wizAgencyContext.migration;
          })
        : {};
    _wizAgencyContext.agencies = list.agencies ?? [];
    _wizAgencyContext.migration =
      (migrationResult as typeof _wizAgencyContext.migration) ?? list.migration ?? null;
    _wizAgencyContext.collaboration =
      (collaborationResult as typeof _wizAgencyContext.collaboration) ?? null;
    const selected = getBizFilter();
    if (
      !_wizDraft.agencyId &&
      selected &&
      _wizAgencyContext.agencies.some((agency) => agency.id === selected)
    ) {
      _wizDraft.agencyId = selected;
    }
    _wizAgencyLoaded = true;
  } catch (err) {
    _wizAgencyContext.error = err instanceof Error ? err.message : String(err);
  } finally {
    _wizAgencyLoading = false;
    state.requestUpdate?.();
  }
}

async function enableWizardCollaboration(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  _wizAgencyLoading = true;
  state.requestUpdate?.();
  try {
    _wizAgencyContext.collaboration = (await client.request(
      "agency.ops.collaboration.enable",
      {},
    )) as typeof _wizAgencyContext.collaboration;
  } catch (err) {
    _wizAgencyContext.error = err instanceof Error ? err.message : String(err);
  } finally {
    _wizAgencyLoading = false;
    state.requestUpdate?.();
  }
}

function loadWizDraft(): WizDraft {
  try {
    const raw = localStorage.getItem(WIZ_DRAFT_KEY);
    if (!raw) return { ...EMPTY_DRAFT };
    const parsed = JSON.parse(raw);
    return { ...EMPTY_DRAFT, ...parsed };
  } catch {
    return { ...EMPTY_DRAFT };
  }
}

function saveWizDraft() {
  try {
    localStorage.setItem(WIZ_DRAFT_KEY, JSON.stringify(_wizDraft));
  } catch {}
}

function clearWizDraft() {
  try {
    localStorage.removeItem(WIZ_DRAFT_KEY);
  } catch {}
}

function wasOnboardingCompletedOnce(): boolean {
  try {
    return localStorage.getItem(WIZ_DONE_KEY) === "1";
  } catch {
    return false;
  }
}

function markOnboardingDoneOnce() {
  try {
    localStorage.setItem(WIZ_DONE_KEY, "1");
  } catch {}
}

// Session-level "user dismissed it, don't auto-reopen" flag. Persisted to
// localStorage so the wizard doesn't pop back up on every render when the
// user closed it without completing.
const WIZ_DISMISSED_KEY = "business.onboarding.dismissed";
function wasOnboardingDismissed(): boolean {
  try {
    return localStorage.getItem(WIZ_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}
function markOnboardingDismissed() {
  try {
    localStorage.setItem(WIZ_DISMISSED_KEY, "1");
  } catch {}
}
function clearOnboardingDismissed() {
  try {
    localStorage.removeItem(WIZ_DISMISSED_KEY);
  } catch {}
}

function openOnboarding(state: AppViewState, opts?: { reset?: boolean }) {
  if (opts?.reset) {
    clearWizDraft();
    _wizDraft = { ...EMPTY_DRAFT };
  } else {
    _wizDraft = loadWizDraft();
  }
  // Re-opening explicitly clears the dismissed flag so the "Setup" button
  // always reliably opens the wizard again.
  clearOnboardingDismissed();
  _wizOpen = true;
  _wizStep = "welcome";
  state.requestUpdate?.();
}

function closeOnboarding(state: AppViewState) {
  _wizOpen = false;
  saveWizDraft();
  // Mark dismissed so renderEmptyState's auto-open guard doesn't re-pop it
  // on the very next render. The Setup button + "Start Guided Setup"
  // button both call openOnboarding which clears this flag.
  markOnboardingDismissed();
  state.requestUpdate?.();
}

function setWizStep(s: WizStep, state: AppViewState) {
  _wizStep = s;
  saveWizDraft();
  state.requestUpdate?.();
}

function patchDraft(p: Partial<WizDraft>, state: AppViewState) {
  _wizDraft = { ..._wizDraft, ...p };
  saveWizDraft();
  state.requestUpdate?.();
}

function stepIndex(s: WizStep): number {
  return WIZ_STEPS.indexOf(s);
}

function isWizStepValid(s: WizStep, d: WizDraft): boolean {
  if (s === "identity") return d.name.trim().length > 0;
  return true; // every other step is optional / informational
}

async function finishOnboarding(
  state: AppViewState,
  bs: BusinessState,
  client: GatewayBrowserClient,
) {
  if (_wizSaving) return;
  _wizSaving = true;
  state.requestUpdate?.();

  const d = _wizDraft;
  const name = d.name.trim() || "My Agency";

  try {
    let agencyId = d.agencyId;
    if (!agencyId) {
      const result = await client.request("agency.ops.agency.create", {
        name,
        industry: d.industry.trim(),
        goals: d.goals.trim(),
        context: d.context.trim(),
        planNotionUrl: d.notionUrl.trim(),
      });
      const agency =
        result && typeof result === "object" && "agency" in result
          ? (result as { agency?: { id?: string } }).agency
          : null;
      if (!agency?.id) throw new Error("Agency creation did not return an agency id");
      agencyId = agency.id;
    }
    setBizFilter(agencyId);
    if (state.agencyOperationsState) {
      state.agencyOperationsState.selectedAgencyId = agencyId;
      state.agencyOperationsState.lastLoadedAt = null;
    }

    // Persist display personalization without creating a legacy identity.
    //    rest of the UI already reads from.
    try {
      localStorage.setItem("business.hideRevenue", d.hideRevenueDefault ? "1" : "0");
    } catch {}

    markOnboardingDoneOnce();
    clearWizDraft();
    setWizStep("done", state);
  } catch (err) {
    bs.error = err instanceof Error ? err.message : String(err);
  } finally {
    _wizSaving = false;
    state.requestUpdate?.();
  }
}

function renderWizardHero(): TemplateResult {
  return html`
    <div class="bz-wiz-hero bz-wizard-step">
      <div class="bz-wiz-hero-ring">◇</div>
      <h2 class="bz-wiz-hero-title">
        Let's set up your <span class="bz-wiz-hero-italic">command center</span>
      </h2>
      <p class="bz-wiz-hero-sub">
        Two minutes of questions and your agent will know your business, your goals, and how to help.
        You can skip anything and refine later.
      </p>
      <div class="bz-wiz-checklist">
        <div class="bz-wiz-checklist-item">
          <span class="bz-wiz-checklist-icon">1</span>
          Name your business + pick an industry
        </div>
        <div class="bz-wiz-checklist-item">
          <span class="bz-wiz-checklist-icon">2</span>
          Drop your top goals for this quarter
        </div>
        <div class="bz-wiz-checklist-item">
          <span class="bz-wiz-checklist-icon">3</span>
          Give the agent context — team, market, tone
        </div>
        <div class="bz-wiz-checklist-item">
          <span class="bz-wiz-checklist-icon">4</span>
          Pick a couple of sensible defaults
        </div>
      </div>
    </div>
  `;
}

function renderWizardIdentity(state: AppViewState): TemplateResult {
  const existing = _wizAgencyContext.agencies;
  return html`
    <div class="bz-wizard-step">
      ${
        existing.length
          ? html`
            <div class="bz-wiz-field">
              <label class="bz-wiz-label">Use an existing agency</label>
              <div class="bz-wiz-chips">
                ${existing.map(
                  (agency) => html`
                    <button
                      type="button"
                      class="bz-wiz-chip ${_wizDraft.agencyId === agency.id ? "is-selected" : ""}"
                      @click=${() =>
                        patchDraft(
                          {
                            agencyId: agency.id,
                            name: agency.name,
                          },
                          state,
                        )}
                    >
                      ${agency.name} · ${agency.role}
                    </button>
                  `,
                )}
                <button
                  type="button"
                  class="bz-wiz-chip ${!_wizDraft.agencyId ? "is-selected" : ""}"
                  @click=${() => patchDraft({ agencyId: "", name: "" }, state)}
                >
                  + New agency
                </button>
              </div>
            </div>
          `
          : nothing
      }
      <div class="bz-wiz-field">
        <label class="bz-wiz-label">Agency Name</label>
        <input
          class="bz-wiz-input"
          type="text"
          autofocus
          placeholder="e.g. Acme Co · BrightFunnel · Atlas Coaching"
          .value=${_wizDraft.name}
          ?disabled=${Boolean(_wizDraft.agencyId)}
          @input=${(e: Event) => patchDraft({ name: (e.target as HTMLInputElement).value }, state)}
        />
        <span class="bz-wiz-hint">
          This is how the command center will refer to it. You can rename later.
        </span>
      </div>
      <div class="bz-wiz-field">
        <label class="bz-wiz-label">Industry</label>
        <input
          class="bz-wiz-input"
          type="text"
          placeholder="What space are you in?"
          .value=${_wizDraft.industry}
          @input=${(e: Event) => patchDraft({ industry: (e.target as HTMLInputElement).value }, state)}
        />
        <div class="bz-wiz-chips">
          ${WIZ_INDUSTRY_CHIPS.map(
            (chip) => html`
            <button
              type="button"
              class="bz-wiz-chip ${_wizDraft.industry.toLowerCase() === chip.toLowerCase() ? "is-selected" : ""}"
              @click=${() => patchDraft({ industry: chip }, state)}
            >${chip}</button>
          `,
          )}
        </div>
      </div>
    </div>
  `;
}

function renderWizardGoals(state: AppViewState): TemplateResult {
  return html`
    <div class="bz-wizard-step">
      <div class="bz-wiz-field">
        <label class="bz-wiz-label">Top goals this quarter</label>
        <textarea
          class="bz-wiz-textarea"
          placeholder="e.g.&#10;1. Hit $30k MRR by July&#10;2. Onboard 5 new agency clients&#10;3. Launch the funnels v2 product"
          .value=${_wizDraft.goals}
          @input=${(e: Event) => patchDraft({ goals: (e.target as HTMLTextAreaElement).value }, state)}
        ></textarea>
        <span class="bz-wiz-hint">
          Plain text. Numbered or freeform — both work. The agent reads this to
          prioritize what it surfaces.
        </span>
      </div>
    </div>
  `;
}

function renderWizardContext(state: AppViewState): TemplateResult {
  return html`
    <div class="bz-wizard-step">
      <div class="bz-wiz-field">
        <label class="bz-wiz-label">Context for the agent</label>
        <textarea
          class="bz-wiz-textarea"
          style="min-height:140px;"
          placeholder="Who you are, who your customers are, what tone you want the agent to use. Anything you'd tell a new hire on day one."
          .value=${_wizDraft.context}
          @input=${(e: Event) => patchDraft({ context: (e.target as HTMLTextAreaElement).value }, state)}
        ></textarea>
        <span class="bz-wiz-hint">
          This is the most personalizing input you can give. The agent reads
          this on every reply — keep it tight and honest.
        </span>
      </div>
    </div>
  `;
}

function renderWizardSettings(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const migration = _wizAgencyContext.migration;
  const collaboration = _wizAgencyContext.collaboration;
  const collaborationReady = collaboration?.state === "ready";
  return html`
    <div class="bz-wizard-step">
      <div class="bz-wiz-field">
        <label class="bz-wiz-label">Workspace readiness</label>
        <div class="bz-wiz-checklist">
          <div class="bz-wiz-checklist-item">
            <span class="bz-wiz-checklist-icon">${migration?.sourceExists ? "↗" : "✓"}</span>
            ${
              migration?.sourceExists
                ? `${migration.businessesFound ?? 0} legacy business workspace(s) ready to migrate`
                : "No legacy business migration required"
            }
          </div>
          <div class="bz-wiz-checklist-item">
            <span class="bz-wiz-checklist-icon">${collaborationReady ? "✓" : "○"}</span>
            ${
              collaborationReady
                ? `Private collaboration ready${collaboration?.collaborationUrl ? ` · ${collaboration.collaborationUrl}` : ""}`
                : (collaboration?.message ?? "Tailscale private collaboration is not ready")
            }
          </div>
        </div>
        ${
          !collaborationReady
            ? html`
              <button
                type="button"
                class="bz-wiz-btn"
                ?disabled=${_wizAgencyLoading}
                @click=${() => enableWizardCollaboration(state, client)}
              >
                ${_wizAgencyLoading ? "Checking…" : "Enable private collaboration"}
              </button>
            `
            : nothing
        }
      </div>
      <div class="bz-wiz-field">
        <label class="bz-wiz-label">Notion plan link <span style="opacity:.6;font-weight:400;text-transform:none;letter-spacing:0;">(optional)</span></label>
        <input
          class="bz-wiz-input"
          type="url"
          placeholder="https://notion.so/your-business-plan"
          .value=${_wizDraft.notionUrl}
          @input=${(e: Event) => patchDraft({ notionUrl: (e.target as HTMLInputElement).value }, state)}
        />
        <span class="bz-wiz-hint">
          Paste a Notion URL and the agent can read your long-form plan whenever it needs it.
        </span>
      </div>
      <div class="bz-wiz-field" style="margin-top:18px;">
        <label class="bz-wiz-label">Defaults</label>
        <div class="bz-wiz-toggle ${_wizDraft.hideRevenueDefault ? "is-on" : ""}"
             @click=${() => patchDraft({ hideRevenueDefault: !_wizDraft.hideRevenueDefault }, state)}>
          <div class="bz-wiz-toggle-text">
            <span class="bz-wiz-toggle-title">Hide revenue by default</span>
            <span class="bz-wiz-toggle-sub">Masks $ values on the command center until you tap the eye icon.</span>
          </div>
          <div class="bz-wiz-toggle-switch"></div>
        </div>
        <div class="bz-wiz-toggle ${_wizDraft.voiceDefault ? "is-on" : ""}"
             @click=${() => patchDraft({ voiceDefault: !_wizDraft.voiceDefault }, state)}
             style="margin-top:8px;">
          <div class="bz-wiz-toggle-text">
            <span class="bz-wiz-toggle-title">Enable voice greeting</span>
            <span class="bz-wiz-toggle-sub">Agent says hi out loud the first time you open the app each day.</span>
          </div>
          <div class="bz-wiz-toggle-switch"></div>
        </div>
      </div>
    </div>
  `;
}

function renderWizardDone(state: AppViewState, bs: BusinessState): TemplateResult {
  const selectedAgency = _wizAgencyContext.agencies.find((agency) => agency.id === getBizFilter());
  return html`
    <div class="bz-wiz-hero bz-wizard-step">
      <div class="bz-wiz-hero-ring" style="font-size:42px;">✓</div>
      <h2 class="bz-wiz-hero-title">
        <span class="bz-wiz-hero-italic">${selectedAgency?.name ?? _wizDraft.name ?? "Your agency"}</span> is ready
      </h2>
      <p class="bz-wiz-hero-sub">
        Your canonical agency workspace is selected across projects, clients,
        employees, approvals, and finance. Continue in Agency Operations to
        assign work and tune employee context.
      </p>
      <div class="bz-wiz-checklist">
        <div class="bz-wiz-checklist-item">
          <span class="bz-wiz-checklist-icon">→</span>
          Optional: connect Notion to mirror your databases (Settings → Notion)
        </div>
        <div class="bz-wiz-checklist-item">
          <span class="bz-wiz-checklist-icon">→</span>
          Connect Whop or Stripe in Business hub › Revenue for live revenue
        </div>
        <div class="bz-wiz-checklist-item">
          <span class="bz-wiz-checklist-icon">→</span>
          Invite the agent to your CRM by creating a Client
        </div>
      </div>
      <button
        class="bz-wiz-btn is-primary"
        style="margin-top:8px;padding:11px 22px;"
        @click=${() => closeOnboarding(state)}
      >Open Command Center →</button>
    </div>
  `;
}

function renderOnboardingWizard(
  state: AppViewState,
  bs: BusinessState,
  client: GatewayBrowserClient,
): TemplateResult {
  if (!_wizAgencyLoaded && !_wizAgencyLoading) {
    void loadWizardAgencyContext(state, client);
  }
  const idx = stepIndex(_wizStep);
  const totalStepsForProgress = WIZ_STEPS.length - 1; // exclude welcome from %
  const pctIdx = _wizStep === "welcome" ? 0 : idx;
  const pct = Math.round((pctIdx / totalStepsForProgress) * 100);
  const canContinue = isWizStepValid(_wizStep, _wizDraft);
  const titles: Record<WizStep, { eyebrow: string; title: string; sub: string }> = {
    welcome: {
      eyebrow: "Setup",
      title: "Personalize your agent",
      sub: "A 60-second walkthrough — answer what you want, skip what you don't.",
    },
    identity: {
      eyebrow: "Step 1 of 4",
      title: "What are we naming this?",
      sub: "Business name + industry. You can change both later.",
    },
    goals: {
      eyebrow: "Step 2 of 4",
      title: "What's the quarter look like?",
      sub: "Top goals. The agent uses these to decide what to surface first.",
    },
    context: {
      eyebrow: "Step 3 of 4",
      title: "Brief the agent",
      sub: "Team, market, tone — anything you'd tell a new hire.",
    },
    settings: {
      eyebrow: "Step 4 of 4",
      title: "A couple of defaults",
      sub: "Optional — pick the toggles that fit your workflow.",
    },
    done: {
      eyebrow: "Complete",
      title: "You're set",
      sub: "",
    },
  };
  const t = titles[_wizStep];

  return html`
    <div class="bz-modal-backdrop"
         @click=${(e: Event) => {
           if (e.target === e.currentTarget) closeOnboarding(state);
         }}>
      <div class="bz-wizard" role="dialog" aria-modal="true" aria-labelledby="bz-wiz-title">
        <header class="bz-wizard-head">
          <span class="bz-wizard-eyebrow">
            <span class="bz-wizard-eyebrow-dot"></span>
            ${t.eyebrow}
          </span>
          <h1 id="bz-wiz-title" class="bz-wizard-title">${t.title}</h1>
          ${t.sub ? html`<p class="bz-wizard-sub">${t.sub}</p>` : nothing}
          <button
            class="bz-wizard-close"
            @click=${() => closeOnboarding(state)}
            title=${_wizStep === "done" ? "Close" : "Close — your answers are saved as a draft"}
            aria-label="Close wizard"
          >${I.close}</button>
        </header>

        ${
          _wizStep !== "done"
            ? html`
          <div class="bz-wizard-dots" aria-hidden="true">
            ${WIZ_STEPS.slice(0, -1).map((s) => {
              const sIdx = stepIndex(s);
              const cls = sIdx < idx ? "is-done" : sIdx === idx ? "is-active" : "";
              return html`<div class="bz-wizard-dot ${cls}"></div>`;
            })}
            <span class="bz-wizard-step-counter">${pct}%</span>
          </div>
          <div class="bz-wizard-progress">
            <div class="bz-wizard-progress-fill" style="width:${pct}%"></div>
          </div>
        `
            : nothing
        }

        <div class="bz-wizard-body">
          ${
            _wizStep === "welcome"
              ? renderWizardHero()
              : _wizStep === "identity"
                ? renderWizardIdentity(state)
                : _wizStep === "goals"
                  ? renderWizardGoals(state)
                  : _wizStep === "context"
                    ? renderWizardContext(state)
                    : _wizStep === "settings"
                      ? renderWizardSettings(state, client)
                      : _wizStep === "done"
                        ? renderWizardDone(state, bs)
                        : nothing
          }
        </div>

        ${
          _wizStep !== "done"
            ? html`
          <footer class="bz-wizard-foot">
            <div class="bz-wizard-foot-left">
              ${
                idx > 0
                  ? html`
                <button class="bz-wiz-btn" @click=${() => setWizStep(WIZ_STEPS[idx - 1], state)}>← Back</button>
              `
                  : nothing
              }
              <!-- Universal exit. Available on EVERY step so users are never trapped. -->
              <button class="bz-wiz-btn bz-wiz-btn-text"
                      @click=${() => closeOnboarding(state)}
                      title="Close — your answers stay saved as a draft">Close</button>
            </div>
            <div class="bz-wizard-foot-right">
              ${
                _wizStep === "welcome"
                  ? html`
                <button class="bz-wiz-btn bz-wiz-btn-text" @click=${() => closeOnboarding(state)}>Skip for now</button>
                <button class="bz-wiz-btn is-primary" @click=${() => setWizStep("identity", state)}>Start →</button>
              `
                  : _wizStep === "settings"
                    ? html`
                <button class="bz-wiz-btn bz-wiz-btn-text" @click=${() => closeOnboarding(state)}>Skip & close</button>
                <button
                  class="bz-wiz-btn is-primary"
                  ?disabled=${_wizSaving || !_wizDraft.name.trim()}
                  @click=${() => finishOnboarding(state, bs, client)}
                  title=${!_wizDraft.name.trim() ? "Add a business name on Step 1 to finish" : ""}
                >${_wizSaving ? "Creating…" : !_wizDraft.name.trim() ? "Add a name to finish" : "Finish & create →"}</button>
              `
                    : html`
                <button class="bz-wiz-btn bz-wiz-btn-text"
                  @click=${() => setWizStep(WIZ_STEPS[idx + 1], state)}>Skip</button>
                <button
                  class="bz-wiz-btn is-primary"
                  ?disabled=${!canContinue}
                  @click=${() => setWizStep(WIZ_STEPS[idx + 1], state)}
                >Continue →</button>
              `
              }
            </div>
          </footer>
        `
            : nothing
        }
      </div>
    </div>
  `;
}

// ── Create Dialog ────────────────────────────────────────────

function renderCreateDialog(state: AppViewState, bs: BusinessState, client: GatewayBrowserClient) {
  let newName = "";
  return html`
    <div class="dialog-overlay" @click=${(e: Event) => {
      if (e.target === e.currentTarget) {
        bs.showCreateDialog = false;
        state.requestUpdate?.();
      }
    }}>
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="bz-create-title">
        <span class="bag-eyebrow">Business</span>
        <div class="dialog-title" id="bz-create-title">New business</div>
        <p class="dialog-sub">Give it a name — you can add the industry, plan and AI context in Settings.</p>
        <div class="form-group">
          <label class="form-label">Business Name</label>
          <input class="form-input" type="text" placeholder="Enter name" autofocus
            @input=${(e: Event) => {
              newName = (e.target as HTMLInputElement).value;
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter" && newName.trim())
                createBusiness(state, client, newName.trim());
            }} />
        </div>
        <div class="dialog-actions">
          <button class="btn" @click=${() => {
            bs.showCreateDialog = false;
            state.requestUpdate?.();
          }}>Cancel</button>
          <button class="btn primary" @click=${() => {
            const input = document.querySelector(".dialog .form-input") as HTMLInputElement;
            const name = input?.value?.trim();
            if (name) createBusiness(state, client, name);
          }}>Create</button>
        </div>
      </div>
    </div>
  `;
}

// ── Delete Confirm ───────────────────────────────────────────

function renderDeleteConfirm(state: AppViewState, bs: BusinessState, client: GatewayBrowserClient) {
  const biz = bs.businesses.find((b) => b.id === bs.showDeleteConfirm);
  return html`
    <div class="dialog-overlay" @click=${(e: Event) => {
      if (e.target === e.currentTarget) {
        bs.showDeleteConfirm = null;
        state.requestUpdate?.();
      }
    }}>
      <div class="dialog dialog--danger" role="alertdialog" aria-modal="true" aria-labelledby="bz-delete-title">
        <span class="dialog-danger-glyph" aria-hidden="true">${I.alert}</span>
        <div class="dialog-title" id="bz-delete-title">Delete business</div>
        <p class="dialog-sub">
          Are you sure you want to delete <strong>${biz?.name || "this business"}</strong>? This action cannot be undone.
        </p>
        <div class="dialog-actions">
          <button class="btn" @click=${() => {
            bs.showDeleteConfirm = null;
            state.requestUpdate?.();
          }}>Cancel</button>
          <button class="btn danger" @click=${() => {
            if (bs.showDeleteConfirm) deleteBusiness(state, client, bs.showDeleteConfirm);
          }}>Delete</button>
        </div>
      </div>
    </div>
  `;
}

// ── Database Picker ──────────────────────────────────────────

function renderDatabasePicker(
  state: AppViewState,
  bs: BusinessState,
  client: GatewayBrowserClient,
) {
  const query = (bs.searchQuery || "").toLowerCase();
  const filtered = query
    ? bs.notionDatabases.filter((db) => db.title.toLowerCase().includes(query))
    : bs.notionDatabases;

  return html`
    <div class="dialog-overlay" @click=${(e: Event) => {
      if (e.target === e.currentTarget) {
        bs.showNotionPicker = false;
        state.requestUpdate?.();
      }
    }}>
      <div class="dialog dialog--wide" role="dialog" aria-modal="true" aria-labelledby="bz-notion-title">
        <span class="bag-eyebrow">Notion</span>
        <div class="dialog-title" id="bz-notion-title">Select a Notion database</div>
        <input class="form-input dialog-search" type="text" placeholder="Search databases…" aria-label="Search databases"
          .value=${bs.searchQuery}
          @input=${(e: Event) => {
            bs.searchQuery = (e.target as HTMLInputElement).value;
            state.requestUpdate?.();
          }} />
        ${
          bs.notionDatabasesLoading
            ? html`
                <div class="db-list" aria-busy="true">
                  ${[0, 1, 2, 3].map(() => html`<div class="db-item db-item--skeleton"><span class="bag-skel" style="width:22px;height:22px;border-radius:7px;"></span><span class="bag-skel" style="flex:1;"></span></div>`)}
                </div>
              `
            : filtered.length === 0
              ? html`<div class="db-empty">${bs.notionDatabases.length === 0 ? "No databases found in your workspace. Share a database with the InfiniBot integration in Notion, then refresh." : "No matching databases."}</div>`
              : html`
              <div class="db-list">
                ${filtered.map(
                  (db) => html`
                  <div class="db-item ${bs.notionSelectedDbId === db.id ? "selected" : ""}" @click=${() => {
                    bs.notionSelectedDbId = db.id;
                    state.requestUpdate?.();
                  }}>
                    <span class="db-item-icon">${db.icon || "📄"}</span>
                    <div class="db-item-info">
                      <div class="db-item-name">${db.title}</div>
                      ${db.createdTime ? html`<div class="db-item-date">${new Date(db.createdTime).toLocaleDateString()}</div>` : nothing}
                    </div>
                    ${
                      bs.notionSelectedDbId === db.id
                        ? html`
                            <span class="db-item-check">◆</span>
                          `
                        : nothing
                    }
                  </div>
                `,
                )}
              </div>
            `
        }
        <div class="dialog-actions">
          <button class="btn" @click=${() => {
            bs.showNotionPicker = false;
            bs.notionSelectedDbId = null;
            state.requestUpdate?.();
          }}>Cancel</button>
          <button class="btn" @click=${() => loadNotionDatabases(state, client)} ?disabled=${bs.notionDatabasesLoading}>Refresh</button>
          <button class="btn primary" ?disabled=${!bs.notionSelectedDbId} @click=${() => {
            const sel = bs.notionDatabases.find((db) => db.id === bs.notionSelectedDbId);
            if (sel) connectNotionDatabase(state, client, sel.id, sel.title);
          }}>Connect</button>
        </div>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════
// BUSINESS OVERVIEW (per-business command center)
// ═══════════════════════════════════════════════════════════════════
//
// Aggregates content + asset counts from every store that's already keyed
// by business id. Reads `bs.summary` populated by `loadBusinessSummary`.

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function relTime(ms: number): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function renderBusinessOverview(
  state: AppViewState,
  bs: BusinessState,
  client: GatewayBrowserClient,
) {
  const s = bs.summary;
  const loading = bs.summaryLoading;
  const activeBiz = bs.businesses.find((b) => b.id === bs.activeBusinessId);
  const lastFetched = (bs as unknown as { summaryFetchedAt?: number }).summaryFetchedAt;
  return html`
    <div class="ovr-page">
      <!-- Command header: who, when, controls -->
      <div class="ovr-head">
        <div class="ovr-head-text">
          <span class="ovr-eyebrow">
            <span style="display:inline-flex;width:14px;height:14px;">${I.chart}</span>
            Overview
          </span>
          <span class="ovr-title">${activeBiz?.name ?? "No business selected"}</span>
          <div class="ovr-head-meta">
            ${activeBiz?.industry ? html`<span><strong>${activeBiz.industry}</strong></span>` : nothing}
            ${
              s
                ? html`
              <span>·</span>
              <span><strong>${s.pages.total}</strong> pages</span>
              <span>·</span>
              <span><strong>${s.leads.total}</strong> leads</span>
              <span>·</span>
              <span><strong>${s.assets.total}</strong> assets</span>
            `
                : nothing
            }
            ${lastFetched ? html`<span>·</span><span>fetched ${relTime(lastFetched)}</span>` : nothing}
          </div>
        </div>
        <div class="ovr-head-actions">
          <button class="ovr-btn" @click=${() => {
            bs.activeSection = "profile";
            state.requestUpdate?.();
          }} title="Back to Command Center">
            <span class="ovr-btn-icon">${I.briefcase}</span>
            <span>Back</span>
          </button>
          <button class="ovr-btn" @click=${() => {
            bs.activeSection = "clients";
            state.requestUpdate?.();
          }} title="Jump to Clients CRM">
            <span class="ovr-btn-icon">${I.users}</span>
            <span>Clients</span>
          </button>
          <button class="ovr-btn" @click=${() => {
            bs.activeSection = "brand";
            state.requestUpdate?.();
          }} title="Edit brand identity">
            <span class="ovr-btn-icon">${I.palette}</span>
            <span>Brand</span>
          </button>
          <button class="ovr-btn ovr-btn--primary" @click=${() => loadBusinessSummary(state, client, { force: true })} ?disabled=${loading}>
            <span class="ovr-btn-icon">${I.refresh}</span>
            <span>${loading ? "Loading…" : "Refresh"}</span>
          </button>
        </div>
      </div>

      ${
        !s
          ? html`
        <div class="ovr-list-panel">
          <div class="ovr-list">
            <div class="empty">${loading ? "Loading aggregated data…" : "No summary loaded yet. Press Refresh to fetch."}</div>
          </div>
        </div>
      `
          : html`
        <!-- KPI grid (Pages / Leads / Engagement / Assets / Brand) -->
        <div class="ovr-grid">
          <div class="ovr-tile">
            <div class="ovr-tile-head">
              <span class="ovr-tile-icon">${I.doc}</span>
              <span class="ovr-tile-label">Pages</span>
            </div>
            <span class="ovr-num">${s.pages.total}</span>
            <span class="ovr-sub">
              ${s.pages.published} published · ${s.pages.draft} draft${s.pages.archived > 0 ? ` · ${s.pages.archived} archived` : ""}
            </span>
          </div>

          <button
            type="button"
            class="ovr-tile ovr-tile--link"
            @click=${() => openHubSection(state, "pipeline")}
            title="Form leads land in the Business hub as contacts with an open deal"
          >
            <div class="ovr-tile-head">
              <span class="ovr-tile-icon">${I.users}</span>
              <span class="ovr-tile-label">Leads</span>
              <span class="ovr-tile-go">Pipeline ›</span>
            </div>
            <span class="ovr-num">${s.leads.total}</span>
            <span class="ovr-sub">
              ${s.leads.lastSubmittedAtMs ? `Last ${relTime(s.leads.lastSubmittedAtMs)}` : "No submissions yet"}
            </span>
          </button>

          <div class="ovr-tile">
            <div class="ovr-tile-head">
              <span class="ovr-tile-icon">${I.chart}</span>
              <span class="ovr-tile-label">Engagement</span>
            </div>
            <span class="ovr-num">${s.kpi.views}</span>
            <span class="ovr-sub">
              ${s.kpi.uniqueSessions} unique · ${s.kpi.formSubmits} submits · ${(s.kpi.conversion * 100).toFixed(1)}% conv
            </span>
          </div>

          <div class="ovr-tile">
            <div class="ovr-tile-head">
              <span class="ovr-tile-icon">${I.briefcase}</span>
              <span class="ovr-tile-label">Assets</span>
            </div>
            <span class="ovr-num">${s.assets.total}</span>
            <span class="ovr-sub">${formatBytes(s.assets.bytes)} across ${s.assets.rootPaths.length} root${s.assets.rootPaths.length === 1 ? "" : "s"}</span>
            ${
              s.assets.total > 0
                ? html`
              <div class="ovr-bar">
                ${(["images", "videos", "audio", "docs", "other"] as const).map((k) => {
                  const v = s.assets.byKind[k];
                  const pct = s.assets.total > 0 ? (v / s.assets.total) * 100 : 0;
                  const color =
                    k === "images"
                      ? "#a78bfa"
                      : k === "videos"
                        ? "#22c55e"
                        : k === "audio"
                          ? "#f59e0b"
                          : k === "docs"
                            ? "#60a5fa"
                            : "#737373";
                  return pct > 0
                    ? html`<span style="width:${pct}%; background:${color};" title="${k}: ${v}"></span>`
                    : nothing;
                })}
              </div>
              <div class="ovr-asset-legend">
                ${(["images", "videos", "audio", "docs", "other"] as const).map((k) => {
                  const v = s.assets.byKind[k];
                  if (!v) return nothing;
                  const color =
                    k === "images"
                      ? "#a78bfa"
                      : k === "videos"
                        ? "#22c55e"
                        : k === "audio"
                          ? "#f59e0b"
                          : k === "docs"
                            ? "#60a5fa"
                            : "#737373";
                  return html`<span><i style="background:${color};"></i>${k} ${v}</span>`;
                })}
              </div>
            `
                : nothing
            }
          </div>

          <div class="ovr-tile ${s.brand.hasBranding ? "" : "ovr-tile--muted"}">
            <div class="ovr-tile-head">
              <span class="ovr-tile-icon">${I.palette}</span>
              <span class="ovr-tile-label">Brand</span>
            </div>
            ${
              s.brand.hasBranding
                ? html`
              <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                ${s.brand.primaryColor ? html`<span title="Primary" style="width:22px; height:22px; border-radius:6px; background:${s.brand.primaryColor}; border:1px solid rgba(255,255,255,0.15);"></span>` : nothing}
                ${s.brand.accentColor ? html`<span title="Accent" style="width:22px; height:22px; border-radius:6px; background:${s.brand.accentColor}; border:1px solid rgba(255,255,255,0.15);"></span>` : nothing}
                <span class="ovr-pill ovr-pill--ok">${s.brand.assetCount} assets</span>
              </div>
              <div class="ovr-sub ovr-sub--fonts">
                ${s.brand.fontHeading ? html`Heading: <strong>${s.brand.fontHeading.split(",")[0]}</strong><br/>` : nothing}
                ${s.brand.fontBody ? html`Body: <strong>${s.brand.fontBody.split(",")[0]}</strong>` : nothing}
              </div>
            `
                : html`
              <span class="ovr-num ovr-num--muted">Not configured</span>
              <span class="ovr-sub">Set colours, fonts, voice in the Brand panel.</span>
              <button class="ovr-btn ovr-btn--inline" @click=${() => {
                bs.activeSection = "brand";
                state.requestUpdate?.();
              }}>
                <span class="ovr-btn-icon">${I.palette}</span>
                <span>Configure Brand</span>
              </button>
            `
            }
          </div>
        </div>

        <!-- Recent pages + leads + assets in a 3-up row -->
        <div class="ovr-grid">
          <div class="ovr-list-panel">
            <div class="ovr-list-head">
              <span class="ovr-list-icon">${I.doc}</span>
              <span class="ovr-list-title">Recent pages</span>
              <span class="ovr-list-count">${s.pages.recent.length}</span>
            </div>
            <div class="ovr-list">
              ${
                s.pages.recent.length === 0
                  ? html`
                      <div class="empty">No landing pages for this business yet.</div>
                    `
                  : s.pages.recent.map(
                      (p) => html`
                  <div class="item">
                    <span class="ovr-pill ${p.status === "published" ? "ovr-pill--ok" : "ovr-pill--warn"}">${p.status}</span>
                    <span class="name">${p.name}</span>
                    <span class="meta">/${p.slug}</span>
                  </div>
                `,
                    )
              }
            </div>
          </div>

          <div class="ovr-list-panel">
            <div class="ovr-list-head">
              <span class="ovr-list-icon">${I.users}</span>
              <span class="ovr-list-title">Recent leads</span>
              <span class="ovr-list-count">${s.leads.recent.length}</span>
              <button type="button" class="ovr-list-go" @click=${() => openHubSection(state, "pipeline")}
                title="Work these leads in Business hub › Pipeline">Open in hub ›</button>
            </div>
            <div class="ovr-list">
              ${
                s.leads.recent.length === 0
                  ? html`
                      <div class="empty">No form submissions yet.</div>
                    `
                  : s.leads.recent.map((l) => {
                      const data = l.data as Record<string, unknown>;
                      const summary =
                        (typeof data.email === "string" && data.email) ||
                        (typeof data.name === "string" && data.name) ||
                        (typeof data.message === "string" &&
                          (data.message as string).slice(0, 40)) ||
                        "(submission)";
                      return html`
                    <div class="item">
                      <span class="ovr-pill">${l.formId.slice(-8)}</span>
                      <span class="name">${summary}</span>
                      <span class="meta">${relTime(l.receivedAtMs)}</span>
                    </div>
                  `;
                    })
              }
            </div>
          </div>

          <div class="ovr-list-panel">
            <div class="ovr-list-head">
              <span class="ovr-list-icon">${I.briefcase}</span>
              <span class="ovr-list-title">Recent assets</span>
              <span class="ovr-list-count">${s.assets.recent.length}</span>
            </div>
            <div class="ovr-list">
              ${
                s.assets.recent.length === 0
                  ? html`<div class="empty">No business-scoped files yet. Drop assets in <code>${"<config>/business/"}${s.businessId}/</code>.</div>`
                  : s.assets.recent.map(
                      (a) => html`
                  <div class="item">
                    <span class="ovr-pill">${a.kind}</span>
                    <span class="name" title=${a.relPath}>${a.name}</span>
                    <span class="meta">${formatBytes(a.bytes)} · ${relTime(a.modifiedAtMs)}</span>
                  </div>
                `,
                    )
              }
            </div>
          </div>
        </div>

        <!-- Pending integrations (transparent about what isn't business-scoped yet) -->
        ${
          s.pending.projects.available === false ||
          s.pending.databases.available === false ||
          s.pending.schedule.available === false
            ? html`
            <div class="ovr-list-panel">
              <div class="ovr-list-head">
                <span class="ovr-list-icon">${I.alert}</span>
                <span class="ovr-list-title">Pending integrations</span>
              </div>
              <div class="ovr-list">
                ${
                  s.pending.projects.available === false
                    ? html`
                  <div class="ovr-pending"><strong>Projects / Tasks:</strong> ${s.pending.projects.reason}</div>
                `
                    : nothing
                }
                ${
                  s.pending.schedule.available === false
                    ? html`
                  <div class="ovr-pending"><strong>Schedule:</strong> ${s.pending.schedule.reason}</div>
                `
                    : nothing
                }
                ${
                  s.pending.databases.available === false
                    ? html`
                  <div class="ovr-pending"><strong>Databases:</strong> ${s.pending.databases.reason}</div>
                `
                    : nothing
                }
              </div>
            </div>
          `
            : nothing
        }
      `
      }
    </div>
  `;
}

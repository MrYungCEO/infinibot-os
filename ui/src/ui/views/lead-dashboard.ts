/**
 * Forms & qualifier — the "Forms" sub-tab of Funnels & Forms (/qualifier).
 *
 * Sections:
 *   - Qualifier — embeds `renderLeadQualifier` (webhook qualifier, action
 *                 stack and the lead-qualifier form builder). A builder, so
 *                 it stays here.
 *   - Overview  — lead KPIs read from the Business hub (`hub.overview`), the
 *                 one store for contacts, deals and landing-page events
 *                 (docs/business/DATA_MODEL.md). Form submissions land there.
 *
 * Lead search, the pipeline board and per-lead timelines used to be copies
 * here backed by the old leads-role database. They now live in the Business
 * hub, so those tabs open its Leads / Pipeline / Contacts sections instead.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import { renderLeadQualifier } from "./lead-qualifier";
import { createInitialLeadQualifierState } from "../controllers/lead-qualifier";
import { createInitialFormBuilderState } from "../controllers/lead-qualifier-forms";
import type { OverviewData } from "./business-hub/types";
import { money, num, pct, relTime } from "./business-hub/format";
import {
  bizAurora,
  bizEmpty,
  bizGlassStyles,
  bizHero,
  bizIcons,
  bizKpi,
  bizSeg,
  bizSkeletonKpis,
  hubHandoff,
  openHubSection,
  type BizSegItem,
} from "./biz-glass";

// ── Section model ────────────────────────────────────────────────────────────

export type LeadDashboardSection = "qualifier" | "overview";

export const LEAD_DASHBOARD_SECTIONS: ReadonlyArray<BizSegItem<LeadDashboardSection> | "sep"> = [
  { id: "qualifier", label: "Forms & qualifier", icon: "file", learnId: "leads-tab-qualifier" },
  { id: "overview", label: "Lead overview", icon: "overview", learnId: "leads-tab-overview" },
  "sep",
  { id: "qualifier", label: "Find leads", icon: "leads", hub: "leads", learnId: "leads-tab-generation" },
  { id: "qualifier", label: "Pipeline", icon: "pipeline", hub: "pipeline", learnId: "leads-tab-pipeline" },
  { id: "qualifier", label: "Contacts & timelines", icon: "contacts", hub: "contacts", learnId: "leads-tab-timeline" },
];

/**
 * Map the legacy top-nav tab id (`leads` / `qualifier` / `pipeline`) to a
 * section. Only /qualifier reaches this page today (/leads and /pipeline
 * route to the Business hub); the others fall back to the overview.
 */
export function sectionForLegacyTab(tab: "leads" | "qualifier" | "pipeline"): LeadDashboardSection {
  return tab === "qualifier" ? "qualifier" : "overview";
}

// ── State (lazily attached to AppViewState) ──────────────────────────────────

export interface LeadHubOverviewState {
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
  data: OverviewData | null;
}

export interface LeadDashboardState {
  section: LeadDashboardSection;
  overview: LeadHubOverviewState;
  /** Last forceSection from the router; only a change overrides the user's tab. */
  _lastForcedSection: LeadDashboardSection | null;
}

export function createLeadDashboardState(initialSection: LeadDashboardSection = "qualifier"): LeadDashboardState {
  return {
    section: initialSection,
    overview: { loading: false, error: null, loadedAt: null, data: null },
    _lastForcedSection: initialSection,
  };
}

function ensureDashboardState(appState: AppViewState, forSection: LeadDashboardSection | null): LeadDashboardState {
  const host = appState as unknown as { leadDashboardState?: LeadDashboardState };
  const slot = host.leadDashboardState;
  // An older build may have left a slot with a retired section id.
  if (slot && (slot.section === "qualifier" || slot.section === "overview") && "data" in (slot.overview ?? {})) {
    if (forSection && forSection !== slot._lastForcedSection) {
      slot.section = forSection;
      slot._lastForcedSection = forSection;
    }
    return slot;
  }
  const fresh = createLeadDashboardState(forSection ?? "qualifier");
  host.leadDashboardState = fresh;
  return fresh;
}

const OVERVIEW_TTL_MS = 60_000;

async function loadHubOverview(st: LeadHubOverviewState, client: GatewayBrowserClient, onUpdate: () => void): Promise<void> {
  st.loading = true;
  st.error = null;
  onUpdate();
  try {
    const to = Date.now();
    st.data = await client.request<OverviewData>("hub.overview", { from: to - 30 * 86_400_000, to });
    st.loadedAt = Date.now();
  } catch (err) {
    st.error = err instanceof Error ? err.message : String(err);
    st.loadedAt = Date.now();
  } finally {
    st.loading = false;
    onUpdate();
  }
}

// ── Render ───────────────────────────────────────────────────────────────────

export interface LeadDashboardProps {
  appState: AppViewState;
  client: GatewayBrowserClient;
  /** Section to focus on first paint, derived from the URL tab id by the router. */
  forceSection?: LeadDashboardSection;
  onUpdate: () => void;
}

export function renderLeadDashboard(props: LeadDashboardProps): TemplateResult {
  const { appState, client, forceSection, onUpdate } = props;
  const dash = ensureDashboardState(appState, forceSection ?? null);
  const section = dash.section;
  const ov = dash.overview;
  if (!ov.loading && (ov.loadedAt === null || Date.now() - ov.loadedAt > OVERVIEW_TTL_MS)) {
    void loadHubOverview(ov, client, onUpdate);
  }
  const c = ov.data?.contacts;

  return html`
    ${bizGlassStyles()}
    ${leadDashboardStyles()}
    <div class="bzg ld-page">
      ${bizAurora()}
      ${bizHero({
        eyebrow: "Funnels & Forms",
        title: section === "overview" ? html`Leads, <span class="bzg-gold">at a glance</span>` : html`Forms & <span class="bzg-gold">qualifier</span>`,
        sub:
          section === "overview"
            ? "Live from the Business hub — every form submission becomes a contact there, with a deal when it qualifies."
            : "Build application forms, score them with your qualifier rules, and route each verdict to an action. Submissions land in the Business hub.",
        actions: html`
          <span class="g-chip bzg-chip" title="Contacts in the Business hub"><span>Contacts</span><strong>${c ? num(c.total) : "—"}</strong></span>
          <span class="g-chip g-chip--gold bzg-chip bzg-chip--gold" title="Open leads (lead + qualified)"><span>Open leads</span><strong>${c ? num(c.leads) : "—"}</strong></span>
          <span class="g-chip bzg-chip" title="New contacts in the last 30 days"><span>New · 30d</span><strong>${c ? num(c.newInPeriod) : "—"}</strong></span>
        `,
      })}
      <nav class="ld-nav" data-learn-id="leads-tabs">
        ${bizSeg(LEAD_DASHBOARD_SECTIONS, section, (id) => {
          dash.section = id;
          onUpdate();
        }, "Forms and leads sections")}
      </nav>
      <div class="ld-body">
        ${section === "overview" ? renderOverviewSection(dash, client, onUpdate) : renderQualifierSection(appState, client)}
      </div>
    </div>
  `;
}

// ── Overview (Business hub data) ─────────────────────────────────────────────

function renderOverviewSection(dash: LeadDashboardState, client: GatewayBrowserClient, onUpdate: () => void): TemplateResult {
  const ov = dash.overview;
  const d = ov.data;
  if (!d && ov.error) {
    return bizEmpty({
      icon: "shield",
      title: "Couldn't load the Business hub",
      text: ov.error,
      actions: [
        { label: "Retry", primary: true, run: () => void loadHubOverview(ov, client, onUpdate) },
        { label: "Open Business hub", run: () => openHubSection("overview") },
      ],
    });
  }
  if (!d) return html`${bizSkeletonKpis(4)}<div class="bzg-glass ld-sk-panel"><div class="bzg-sk" style="height:180px"></div></div>`;

  const p = d.pipeline;
  const openStages = p.stages.filter((s) => s.kind === "open");
  const maxStage = Math.max(1, ...openStages.map((s) => s.count));
  const submitRate = d.tracking.visitors ? d.tracking.submits / d.tracking.visitors : null;

  if (d.contacts.total === 0 && p.open.count === 0) {
    return html`
      ${bizEmpty({
        icon: "leads",
        title: "No leads yet",
        text: "Publish a qualifier form, track a landing page, or import a list — every new person shows up here and in the Business hub.",
        actions: [
          { label: "Build a form", primary: true, run: () => { dash.section = "qualifier"; onUpdate(); } },
          { label: "Find leads", run: () => openHubSection("leads") },
          { label: "Import a list", run: () => openHubSection("imports") },
        ],
      })}
    `;
  }

  return html`
    ${ov.error ? html`<div class="bzg-glass bzg-banner"><span class="ld-bad">●</span><span style="flex:1">Showing the last snapshot — ${ov.error}</span><button class="bzg-btn bzg-btn--sm" @click=${() => void loadHubOverview(ov, client, onUpdate)}>Retry</button></div>` : nothing}
    <div class="bzg-kpis">
      ${bizKpi({ label: "Open leads", value: num(d.contacts.leads), foot: `${num(d.contacts.newInPeriod)} new in 30 days`, onClick: () => openHubSection("contacts") })}
      ${bizKpi({ label: "Open pipeline", value: money(p.open.valueCents, "USD", { compact: true }), foot: `${num(p.open.count)} deals · ${money(p.open.weightedCents, "USD", { compact: true })} weighted`, onClick: () => openHubSection("pipeline") })}
      ${bizKpi({ label: "Win rate", value: pct(p.winRate), foot: `${num(p.won.count)} won · ${num(p.lost.count)} lost`, onClick: () => openHubSection("pipeline") })}
      ${bizKpi({ label: "Form submits · 30d", value: num(d.tracking.submits), foot: submitRate === null ? "Track a landing page to see conversion" : `${pct(submitRate, 1)} of ${num(d.tracking.visitors)} visitors`, onClick: () => openHubSection("tracking") })}
    </div>

    <div class="bzg-grid bzg-cols">
      <section class="bzg-glass bzg-panel">
        <div class="bzg-head"><h2>Pipeline by stage</h2><button class="bzg-btn bzg-btn--ghost bzg-btn--sm" @click=${() => openHubSection("pipeline")}>Open board ${bizIcons.arrowRight()}</button></div>
        ${openStages.length
          ? html`<div class="bzg-bars">${openStages.map(
              (s) => html`<div class="bzg-bar">
                <span class="bzg-bar__label">${s.name}</span>
                <span class="bzg-bar__track"><span class="bzg-bar__fill" style="width:${Math.max(2, (s.count / maxStage) * 100)}%"></span></span>
                <span class="bzg-bar__value">${num(s.count)}${s.rotting ? html` <span class="ld-warn" title="Rotting deals">· ${s.rotting}</span>` : nothing}</span>
              </div>`,
            )}</div>`
          : html`<p class="bzg-faint">No pipeline stages yet.</p>`}
        ${p.avgCycleDays !== null ? html`<p class="bzg-faint ld-note">Average cycle ${Math.round(p.avgCycleDays)} days from first touch to won.</p>` : nothing}
      </section>

      <section class="bzg-glass bzg-panel">
        <div class="bzg-head"><h2>Hottest leads</h2><span class="bzg-meta">by score</span></div>
        ${d.attention.hotLeads.length
          ? html`<div class="bzg-list">${d.attention.hotLeads.map(
              (l) => html`<button class="bzg-li" @click=${() => openHubSection("contacts")} title="Open in Business hub › Contacts">
                <span class="ld-score" style="--s:${Math.max(0, Math.min(100, l.score))}">${l.score}</span>
                <span class="bzg-li__main"><b>${l.name || l.email || "Unnamed"}</b><span>${l.email ?? "No email"} · ${l.lifecycle}</span></span>
                ${bizIcons.arrowRight()}
              </button>`,
            )}</div>`
          : html`<p class="bzg-faint">Scores appear once leads engage with emails and pages.</p>`}
      </section>
    </div>

    <section class="g-panel bzg-glass bzg-panel ld-recent">
      <div class="bzg-head"><h2>Latest activity</h2><span class="bzg-meta">from the Business hub timeline</span></div>
      ${d.recent.length
        ? html`<div class="bzg-list">${d.recent.slice(0, 8).map(
            (a) => html`<div class="bzg-li">
              <span class="ld-dot" aria-hidden="true"></span>
              <span class="bzg-li__main"><b>${a.subjectName ?? a.subjectType}</b><span>${a.summary}</span></span>
              <span class="bzg-faint bzg-num">${relTime(a.occurredAt)}</span>
            </div>`,
          )}</div>`
        : html`<p class="bzg-faint">Nothing has happened yet.</p>`}
    </section>

    <div class="bzg-handoffs">
      ${hubHandoff({ section: "leads", icon: "leads", title: "Find new leads", text: "Search, enrich and verify prospects, then import them as contacts." })}
      ${hubHandoff({ section: "contacts", icon: "contacts", title: "Contacts & timelines", text: "Every email, page view, form and stage change per person." })}
      ${hubHandoff({ section: "tracking", icon: "tracking", title: "Landing pages", text: "One snippet: visits, UTMs and form leads." })}
    </div>
  `;
}

// ── Qualifier (wraps lead-qualifier.ts) ──────────────────────────────────────

function renderQualifierSection(appState: AppViewState, client: GatewayBrowserClient): TemplateResult {
  if (!appState.leadQualifierState) appState.leadQualifierState = createInitialLeadQualifierState();
  if (!appState.leadQualifierFormsState) appState.leadQualifierFormsState = createInitialFormBuilderState();
  return html`
    <section class="ld-section ld-section--embed">${renderLeadQualifier(appState, client)}</section>
    <div class="ld-foot">
      ${hubHandoff({ section: "contacts", icon: "contacts", title: "Where do submissions go?", text: "Each form submission becomes a Business hub contact, with a deal when it qualifies.", cta: "See contacts" })}
    </div>
  `;
}

// ── Styles ───────────────────────────────────────────────────────────────────

function leadDashboardStyles(): TemplateResult {
  return html`<style>
    .ld-page { padding: 22px clamp(14px, 2.6vw, 34px) 60px; max-width: 1480px; margin: 0 auto; min-height: 100%; }
    .ld-nav { position: sticky; top: 0; z-index: 20; margin: 0 -4px 18px; padding: 4px; }
    .ld-body { display: grid; gap: 16px; }
    .ld-section--embed { min-width: 0; }
    .ld-foot { margin-top: 4px; }
    .ld-sk-panel { padding: 18px; margin-top: 2px; }
    .ld-note { margin: 12px 0 0; font-size: 12px; }
    .ld-recent { min-width: 0; }
    .ld-bad { color: var(--danger, #e36b6b); }
    .ld-warn { color: var(--warn, #e7a74b); }
    .ld-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; background: var(--glass-gold); box-shadow: 0 0 10px var(--glass-gold-a40); }
    .ld-score {
      width: 36px; height: 36px; border-radius: 11px; flex: 0 0 auto; display: grid; place-items: center; font-weight: 660; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--glass-fg);
      background: conic-gradient(var(--glass-gold) calc(var(--s) * 1%), color-mix(in srgb, var(--glass-fg) 8%, transparent) 0);
      position: relative; isolation: isolate;
    }
    .ld-score::after { content: ""; position: absolute; inset: 3px; border-radius: 9px; background: var(--glass-base); z-index: -1; }
    .bzg-li svg.i { width: 15px; height: 15px; color: var(--glass-fg-3); flex: 0 0 auto; }
    @media (max-width: 720px) {
      .ld-page { padding: 14px 12px 70px; }
      .ld-page .bzg-hero__actions { gap: 6px; }
      .ld-page .bzg-hero__actions .bzg-chip { flex: 1 1 auto; justify-content: center; }
    }
  </style>`;
}

/**
 * Business & Agency glass skin — shared helpers for the business, agency and
 * command pages. Importing this module loads `ba-glass.css` (page-scoped
 * under `.ba-glass`). See the header of ba-glass.css for the rules.
 *
 *   html`<div class="cmd-center ba-glass">${baAurora()} …</div>`
 *
 * `renderHubLink` / `openHubSection` send people to the Business hub
 * (`/hub?view=…`) where leads, the pipeline, contacts, clients and revenue
 * live, instead of keeping a second copy of that UI on these pages.
 */

import { html, nothing, type TemplateResult } from "lit";
import "./ba-glass.css";

/** Business hub sections (mirrors views/business-hub/app.ts SECTIONS ids). */
export type HubSection =
  | "overview"
  | "leads"
  | "pipeline"
  | "contacts"
  | "clients"
  | "campaigns"
  | "tracking"
  | "imports"
  | "revenue";

/** Minimal app-state surface needed to navigate to the hub. */
export interface HubNavHost {
  setTab: (tab: never) => void;
  setHostView: (view: string) => void;
  requestUpdate?: () => void;
}

/** The decorative gold aurora layer. Put it first inside a `.ba-glass` root. */
export function baAurora(): TemplateResult {
  return html`<div class="ba-aurora" aria-hidden="true"></div>`;
}

/** Open a Business hub section (`/hub?view=<section>`). */
export function openHubSection(state: unknown, section: HubSection): void {
  const host = state as HubNavHost;
  (host.setTab as (t: string) => void)("hub");
  host.setHostView(section);
  host.requestUpdate?.();
}

const HUB_ICONS: Record<HubSection, TemplateResult> = {
  overview: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>`,
  leads: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`,
  pipeline: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/></svg>`,
  contacts: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/></svg>`,
  clients: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18"/></svg>`,
  campaigns: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>`,
  tracking: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 4 8-9"/><path d="M14 6h6v6"/></svg>`,
  imports: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 21h16"/></svg>`,
  revenue: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>`,
};

const HUB_LABEL: Record<HubSection, string> = {
  overview: "Overview",
  leads: "Leads",
  pipeline: "Pipeline",
  contacts: "Contacts",
  clients: "Clients",
  campaigns: "Campaigns",
  tracking: "Landing pages",
  imports: "Imports",
  revenue: "Revenue",
};

/**
 * A glass card that says where this lives now and opens it in the Business
 * hub. `extra` buttons (e.g. "Log a manual payment") render after the main one.
 */
export function renderHubLink(
  state: unknown,
  opts: {
    section: HubSection;
    title: string;
    text: string;
    cta?: string;
    extra?: Array<{ label: string; run: () => void }>;
    learnId?: string;
  },
): TemplateResult {
  return html`<div class="bag-hublink" role="note" data-learn-id=${opts.learnId ?? nothing}>
    <span class="bag-hublink__icon" aria-hidden="true">${HUB_ICONS[opts.section]}</span>
    <span class="bag-hublink__body">
      <span class="bag-hublink__title">${opts.title}</span>
      <span class="bag-hublink__text">${opts.text}</span>
    </span>
    <span class="bag-hublink__actions">
      ${(opts.extra ?? []).map((b) => html`<button type="button" class="bag-btn" @click=${b.run}>${b.label}</button>`)}
      <button type="button" class="bag-btn bag-btn--primary" @click=${() => openHubSection(state, opts.section)}>
        ${opts.cta ?? `Open Business hub › ${HUB_LABEL[opts.section]}`}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </button>
    </span>
  </div>`;
}

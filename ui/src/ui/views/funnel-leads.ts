/**
 * Lead Engine view — the browser surface for the server-side lead/CRM engine.
 *
 * Layout notes that are deliberate rather than incidental:
 *  - The board never uses drag as the only way to move a lead. Every card
 *    carries a stage <select>, so the interaction is keyboard and touch
 *    reachable by construction. A drag-only board was the worst finding of the
 *    last design audit.
 *  - Failed and degraded RPCs are rendered above the panels. A panel with no
 *    rows and a panel we could not fetch must never look the same.
 */

import { html, nothing, type TemplateResult } from "lit";

import type { GatewayBrowserClient } from "../gateway";
import {
  analyzeFunnel,
  archiveLead,
  classifyLeadIntent,
  clearLeadFilters,
  closeLeadDraft,
  closeOfferDraft,
  closeTaskDraft,
  completeTask,
  createLead,
  createStage,
  createTask,
  dismissLeadNotice,
  generateFunnelSOP,
  generateLeadQuestions,
  generateLeadResponse,
  getLeadEngineState,
  getSelectedLead,
  leadsByStage,
  loadLeadEngine,
  logMetric,
  matchOffersForLead,
  moveLeadToStage,
  openLeadDraft,
  openOfferDraft,
  openTaskDraft,
  patchLeadDraft,
  patchMetricDraft,
  patchOfferDraft,
  patchTaskDraft,
  qualifyLead,
  reloadLeadActivity,
  reloadMetrics,
  reloadTasks,
  saveOffer,
  scoreLead,
  searchLeads,
  selectLead,
  selectLeadBusiness,
  selectLeadFunnel,
  setLeadEngineClient,
  setLeadEngineRequestUpdate,
  setLeadFilter,
  setLeadLayout,
  setLeadSection,
  setOfferStatus,
  setScoreDraft,
  suggestFunnelImprovements,
  updateLead,
  type FunnelTask,
  type Lead,
  type LeadEngineSection,
  type LeadEngineState,
  type LeadPriority,
  type LeadSource,
  type LeadStatus,
  type Offer,
  type OfferStatus,
  type OfferType,
  type TaskPriority,
  type TaskType,
} from "../controllers/funnel-leads";

export interface FunnelLeadsProps {
  client?: GatewayBrowserClient;
  requestUpdate: () => void;
}

let _initialised = false;

// ══════════════════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════════════════

const LEAD_STATUSES: LeadStatus[] = [
  "new",
  "contacted",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
  "nurturing",
  "disqualified",
];

const LEAD_PRIORITIES: LeadPriority[] = ["low", "medium", "high", "urgent"];

const LEAD_SOURCES: LeadSource[] = [
  "website",
  "referral",
  "social",
  "email",
  "phone",
  "advertisement",
  "event",
  "import",
  "manual",
  "other",
];

const OFFER_TYPES: OfferType[] = [
  "lead_magnet",
  "low_ticket",
  "mid_ticket",
  "high_ticket",
  "product",
  "service",
  "subscription",
  "bundle",
  "custom",
];

const OFFER_STATUSES: OfferStatus[] = ["draft", "active", "paused", "expired", "archived"];

const TASK_TYPES: TaskType[] = [
  "follow_up",
  "call",
  "email",
  "meeting",
  "proposal",
  "demo",
  "review",
  "custom",
];

const TASK_PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];

const SECTIONS: Array<{ id: LeadEngineSection; label: string }> = [
  { id: "pipeline", label: "Pipeline" },
  { id: "offers", label: "Offers" },
  { id: "tasks", label: "Tasks" },
  { id: "metrics", label: "Metrics" },
  { id: "intelligence", label: "Intelligence" },
];

// ══════════════════════════════════════════════════════════════════════════════
// Styles
// ══════════════════════════════════════════════════════════════════════════════

const styles = html`
  <style>
    .lead-engine {
      height: 100%;
      overflow: auto;
      padding: 20px;
      color: var(--g-fg, var(--glass-fg));
      font-family: var(--g-font-family, inherit);
      background:
        radial-gradient(circle at 88% -8%, var(--g-accent-soft, transparent), transparent 42%),
        radial-gradient(circle at 4% 4%, var(--g-primary-soft, transparent), transparent 38%);
    }
    .le-head {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: flex-end;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .le-head h2 {
      margin: 0;
      font-size: 19px;
      letter-spacing: -0.01em;
    }
    .le-head p {
      margin: 5px 0 0;
      font-size: 11px;
      color: var(--g-fg-dim, var(--glass-fg-2));
      max-width: 62ch;
    }
    .le-scope {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }
    .le-field {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .le-field > span {
      font-size: 9px;
      letter-spacing: 0.09em;
      text-transform: uppercase;
      color: var(--g-fg-faint, var(--glass-fg-2));
    }
    .le-input,
    .le-select {
      font: inherit;
      font-size: 12px;
      color: var(--g-fg, var(--glass-fg));
      background: var(--g-surface, color-mix(in srgb, var(--glass-fg) 5%, transparent));
      border: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 10%, transparent));
      border-radius: var(--g-radius-sm, 8px);
      padding: 7px 9px;
      min-width: 0;
      max-width: 100%;
      backdrop-filter: blur(var(--g-blur, 12px));
    }
    .le-input:hover,
    .le-select:hover {
      background: var(--g-surface-hover, color-mix(in srgb, var(--glass-fg) 8%, transparent));
    }
    textarea.le-input {
      resize: vertical;
      min-height: 62px;
    }
    .le-btn {
      font: inherit;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: var(--g-fg, var(--glass-fg));
      background: var(--g-surface, color-mix(in srgb, var(--glass-fg) 5%, transparent));
      border: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 10%, transparent));
      border-radius: var(--g-radius-sm, 8px);
      padding: 7px 12px;
      cursor: pointer;
      backdrop-filter: blur(var(--g-blur, 12px));
      transition: background var(--g-motion-fast, 120ms) ease, transform var(--g-motion-fast, 120ms) ease;
    }
    .le-btn:hover:not(:disabled) {
      background: var(--g-surface-hover, color-mix(in srgb, var(--glass-fg) 9%, transparent));
    }
    .le-btn:active:not(:disabled) {
      transform: translateY(1px);
    }
    .le-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .le-btn.primary {
      background: var(--g-primary, var(--glass-gold));
      border-color: var(--g-primary-strong, var(--glass-gold));
      color: var(--g-bg-deep, var(--glass-ink));
      font-weight: 650;
    }
    .le-btn.accent {
      background: var(--g-accent-soft, color-mix(in srgb, var(--glass-gold-hi) 16%, transparent));
      border-color: var(--g-accent-muted, color-mix(in srgb, var(--glass-gold-hi) 40%, transparent));
    }
    .le-btn.tiny {
      font-size: 11px;
      padding: 5px 9px;
    }
    .le-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 14px;
      padding: 5px;
      border-radius: var(--g-radius, 12px);
      background: var(--g-surface, color-mix(in srgb, var(--glass-fg) 5%, transparent));
      border: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 10%, transparent));
      backdrop-filter: blur(var(--g-blur, 12px));
    }
    .le-tab {
      font: inherit;
      font-size: 12px;
      border: 1px solid transparent;
      border-radius: var(--g-radius-sm, 8px);
      padding: 6px 13px;
      background: transparent;
      color: var(--g-fg-dim, var(--glass-fg-2));
      cursor: pointer;
    }
    .le-tab[aria-selected="true"] {
      background: var(--g-surface-strong, color-mix(in srgb, var(--glass-fg) 11%, transparent));
      border-color: var(--g-border-strong, color-mix(in srgb, var(--glass-fg) 18%, transparent));
      color: var(--g-fg, var(--glass-fg));
      box-shadow: var(--g-shadow-sm, 0 2px 10px rgba(0, 0, 0, 0.3));
    }
    .le-panel {
      background: var(--g-surface, color-mix(in srgb, var(--glass-fg) 5%, transparent));
      border: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 10%, transparent));
      border-radius: var(--g-radius, 12px);
      box-shadow: var(--g-shadow-sm, 0 2px 10px rgba(0, 0, 0, 0.25));
      backdrop-filter: blur(var(--g-blur, 12px));
      padding: 15px;
      margin-bottom: 12px;
      min-width: 0;
    }
    .le-panel > h3 {
      margin: 0 0 12px;
      font-size: 10px;
      letter-spacing: 0.09em;
      text-transform: uppercase;
      color: var(--g-fg-dim, var(--glass-fg-2));
    }
    .le-panel-head {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .le-panel-head h3 {
      margin: 0;
      font-size: 10px;
      letter-spacing: 0.09em;
      text-transform: uppercase;
      color: var(--g-fg-dim, var(--glass-fg-2));
    }
    .le-kpis {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .le-kpi {
      background: var(--g-surface, color-mix(in srgb, var(--glass-fg) 5%, transparent));
      border: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 10%, transparent));
      border-radius: var(--g-radius, 12px);
      padding: 12px 14px;
      min-width: 0;
      backdrop-filter: blur(var(--g-blur, 12px));
      box-shadow: var(--g-shadow-sm, 0 2px 10px rgba(0, 0, 0, 0.22));
    }
    .le-kpi span {
      display: block;
      font-size: 9px;
      letter-spacing: 0.09em;
      text-transform: uppercase;
      color: var(--g-fg-faint, var(--glass-fg-2));
    }
    .le-kpi strong {
      display: block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 23px;
      margin-top: 6px;
      font-variant-numeric: tabular-nums;
    }
    .le-filters {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 9px;
      align-items: end;
    }
    .le-board {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(255px, 1fr);
      gap: 11px;
      overflow-x: auto;
      padding-bottom: 8px;
    }
    .le-col {
      background: var(--g-surface, color-mix(in srgb, var(--glass-fg) 4%, transparent));
      border: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 10%, transparent));
      border-radius: var(--g-radius, 12px);
      padding: 11px;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .le-col-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
    }
    .le-col-head strong {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }
    .le-col-head small {
      color: var(--g-fg-faint, var(--glass-fg-2));
      font-size: 10px;
      flex: none;
      font-variant-numeric: tabular-nums;
    }
    .le-card {
      width: 100%;
      text-align: left;
      font: inherit;
      color: inherit;
      display: grid;
      gap: 6px;
      background: var(--g-surface-strong, color-mix(in srgb, var(--glass-fg) 8%, transparent));
      border: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 10%, transparent));
      border-radius: var(--g-radius-sm, 9px);
      padding: 10px;
      cursor: pointer;
      min-width: 0;
    }
    .le-card:hover {
      background: var(--g-surface-hover, color-mix(in srgb, var(--glass-fg) 12%, transparent));
    }
    .le-card[aria-current="true"] {
      border-color: var(--g-primary, var(--glass-gold));
      box-shadow: 0 0 0 1px var(--g-primary-muted, color-mix(in srgb, var(--glass-gold) 40%, transparent));
    }
    .le-card-name {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 600;
    }
    .le-card-sub {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 10px;
      color: var(--g-fg-faint, var(--glass-fg-2));
    }
    .le-card-foot {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      align-items: center;
      min-width: 0;
    }
    .le-move {
      display: flex;
      gap: 5px;
      align-items: center;
      min-width: 0;
    }
    .le-move select {
      font: inherit;
      font-size: 10px;
      flex: 1;
      min-width: 0;
      color: var(--g-fg-dim, var(--glass-fg-2));
      background: var(--g-surface, color-mix(in srgb, var(--glass-fg) 5%, transparent));
      border: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 10%, transparent));
      border-radius: 7px;
      padding: 4px 6px;
    }
    .le-chip {
      font-size: 9px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 3px 7px;
      border-radius: 99px;
      border: 1px solid var(--g-neutral-border, color-mix(in srgb, var(--glass-fg) 14%, transparent));
      background: var(--g-neutral-soft, color-mix(in srgb, var(--glass-fg) 7%, transparent));
      color: var(--g-fg-dim, var(--glass-fg-2));
      white-space: nowrap;
    }
    .le-chip.good {
      background: var(--g-success-soft, rgba(34, 197, 94, 0.14));
      border-color: var(--g-success-border, rgba(34, 197, 94, 0.4));
      color: var(--g-success, #22c55e);
    }
    .le-chip.warn {
      background: var(--g-warning-soft, color-mix(in srgb, var(--glass-gold) 14%, transparent));
      border-color: var(--g-warning-border, color-mix(in srgb, var(--glass-gold) 40%, transparent));
      color: var(--g-warning, #f59e0b);
    }
    .le-chip.bad {
      background: var(--g-danger-soft, rgba(239, 68, 68, 0.14));
      border-color: var(--g-danger-border, rgba(239, 68, 68, 0.4));
      color: var(--g-danger, #ef4444);
    }
    .le-chip.info {
      background: var(--g-info-soft, color-mix(in srgb, var(--glass-gold) 14%, transparent));
      border-color: var(--g-info-border, color-mix(in srgb, var(--glass-gold) 40%, transparent));
      color: var(--g-info, var(--glass-gold));
    }
    .le-table-wrap {
      overflow-x: auto;
      border-radius: var(--g-radius-sm, 9px);
    }
    table.le-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
      min-width: 720px;
    }
    .le-table th {
      text-align: left;
      font-size: 9px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--g-fg-faint, var(--glass-fg-2));
      padding: 7px 9px;
      border-bottom: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 10%, transparent));
      white-space: nowrap;
    }
    .le-table td {
      padding: 8px 9px;
      border-bottom: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 7%, transparent));
      max-width: 220px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .le-table tr:hover td {
      background: var(--g-surface-hover, color-mix(in srgb, var(--glass-fg) 5%, transparent));
    }
    .le-link {
      font: inherit;
      background: none;
      border: none;
      padding: 0;
      color: var(--g-primary, var(--glass-gold));
      cursor: pointer;
      text-align: left;
      max-width: 100%;
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .le-split {
      display: grid;
      grid-template-columns: minmax(0, 1.55fr) minmax(300px, 0.85fr);
      gap: 12px;
      align-items: start;
    }
    .le-detail {
      position: sticky;
      top: 0;
      min-width: 0;
    }
    .le-kv {
      display: grid;
      grid-template-columns: minmax(0, auto) minmax(0, 1fr);
      gap: 5px 11px;
      font-size: 11px;
    }
    .le-kv dt {
      color: var(--g-fg-faint, var(--glass-fg-2));
      white-space: nowrap;
    }
    .le-kv dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .le-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 11px;
    }
    .le-verdict {
      margin-top: 11px;
      padding: 11px;
      border-radius: var(--g-radius-sm, 9px);
      border: 1px solid var(--g-border-strong, color-mix(in srgb, var(--glass-fg) 18%, transparent));
      background: var(--g-surface-strong, color-mix(in srgb, var(--glass-fg) 8%, transparent));
    }
    .le-verdict.qualified {
      border-color: var(--g-success-border, rgba(34, 197, 94, 0.45));
      background: var(--g-success-soft, rgba(34, 197, 94, 0.12));
    }
    .le-verdict.unqualified {
      border-color: var(--g-warning-border, color-mix(in srgb, var(--glass-gold) 45%, transparent));
      background: var(--g-warning-soft, color-mix(in srgb, var(--glass-gold) 12%, transparent));
    }
    .le-verdict-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 9px;
      margin-bottom: 9px;
    }
    .le-verdict-head strong {
      font-size: 13px;
    }
    .le-meter {
      height: 6px;
      border-radius: 99px;
      background: var(--g-neutral-soft, color-mix(in srgb, var(--glass-fg) 9%, transparent));
      overflow: hidden;
      margin-bottom: 9px;
    }
    .le-meter i {
      display: block;
      height: 100%;
      background: var(--g-primary, var(--glass-gold));
    }
    .le-factors {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 5px;
      font-size: 10px;
    }
    .le-factor {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }
    .le-factor b {
      flex: none;
      width: 13px;
      text-align: center;
    }
    .le-factor.on b {
      color: var(--g-success, #22c55e);
    }
    .le-factor.off b {
      color: var(--g-fg-faint, var(--glass-fg-2));
    }
    .le-factor span {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--g-fg-dim, var(--glass-fg-2));
    }
    .le-list {
      display: grid;
      gap: 7px;
    }
    .le-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 9px;
      align-items: center;
      background: var(--g-surface, color-mix(in srgb, var(--glass-fg) 4%, transparent));
      border: 1px solid var(--g-border, color-mix(in srgb, var(--glass-fg) 9%, transparent));
      border-radius: var(--g-radius-sm, 9px);
      padding: 9px 11px;
      min-width: 0;
    }
    .le-row strong {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }
    .le-row small {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 10px;
      color: var(--g-fg-faint, var(--glass-fg-2));
      margin-top: 2px;
    }
    .le-row-actions {
      display: flex;
      gap: 5px;
      align-items: center;
      flex: none;
    }
    .le-timeline {
      display: grid;
      gap: 0;
      margin-top: 4px;
    }
    .le-event {
      display: grid;
      grid-template-columns: 11px minmax(0, 1fr);
      gap: 9px;
      padding-bottom: 11px;
      position: relative;
      min-width: 0;
    }
    .le-event::before {
      content: "";
      position: absolute;
      left: 5px;
      top: 12px;
      bottom: 0;
      width: 1px;
      background: var(--g-border, color-mix(in srgb, var(--glass-fg) 12%, transparent));
    }
    .le-event:last-child::before {
      display: none;
    }
    .le-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      margin-top: 3px;
      background: var(--g-neutral, color-mix(in srgb, var(--glass-fg) 28%, transparent));
      border: 1px solid var(--g-border-strong, color-mix(in srgb, var(--glass-fg) 20%, transparent));
      z-index: 1;
    }
    .le-dot.score_change {
      background: var(--g-primary, var(--glass-gold));
    }
    .le-dot.stage_change {
      background: var(--g-accent, var(--glass-gold-hi));
    }
    .le-event p {
      margin: 0;
      font-size: 11px;
      overflow-wrap: anywhere;
    }
    .le-event time {
      display: block;
      font-size: 9px;
      color: var(--g-fg-faint, var(--glass-fg-2));
      margin-top: 2px;
    }
    .le-form {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 9px;
      align-items: end;
      padding: 12px;
      margin-bottom: 12px;
      border-radius: var(--g-radius-sm, 9px);
      border: 1px solid var(--g-border-strong, color-mix(in srgb, var(--glass-fg) 16%, transparent));
      background: var(--g-surface-strong, color-mix(in srgb, var(--glass-fg) 7%, transparent));
    }
    .le-form .le-form-actions {
      display: flex;
      gap: 7px;
      align-items: center;
    }
    .le-form .full {
      grid-column: 1 / -1;
    }
    .le-note,
    .le-alert,
    .le-warn,
    .le-empty {
      border-radius: var(--g-radius-sm, 9px);
      padding: 10px 12px;
      font-size: 11px;
      margin-bottom: 11px;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .le-note {
      background: var(--g-info-soft, color-mix(in srgb, var(--glass-gold) 12%, transparent));
      border: 1px solid var(--g-info-border, color-mix(in srgb, var(--glass-gold) 35%, transparent));
      color: var(--g-fg, var(--glass-fg));
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
    }
    .le-alert {
      background: var(--g-danger-soft, rgba(239, 68, 68, 0.12));
      border: 1px solid var(--g-danger-border, rgba(239, 68, 68, 0.38));
      color: var(--g-danger, #fca5a5);
    }
    .le-warn {
      background: var(--g-warning-soft, color-mix(in srgb, var(--glass-gold) 11%, transparent));
      border: 1px solid var(--g-warning-border, color-mix(in srgb, var(--glass-gold) 34%, transparent));
      color: var(--g-warning, var(--glass-gold));
    }
    .le-alert ul,
    .le-warn ul {
      margin: 6px 0 0;
      padding-left: 17px;
    }
    .le-warn summary {
      cursor: pointer;
      list-style-position: outside;
    }
    .le-warn summary strong {
      color: var(--g-warning, var(--glass-gold));
    }
    .le-empty {
      background: var(--g-surface, color-mix(in srgb, var(--glass-fg) 4%, transparent));
      border: 1px dashed var(--g-border, color-mix(in srgb, var(--glass-fg) 14%, transparent));
      color: var(--g-fg-dim, var(--glass-fg-2));
      text-align: center;
      padding: 20px;
      margin-bottom: 0;
    }
    .le-run {
      border-left: 2px solid var(--g-neutral-border, color-mix(in srgb, var(--glass-fg) 16%, transparent));
      padding: 8px 0 8px 11px;
      min-width: 0;
    }
    .le-run.ok {
      border-left-color: var(--g-success, #22c55e);
    }
    .le-run.fail {
      border-left-color: var(--g-danger, #ef4444);
    }
    .le-run strong {
      display: block;
      font-size: 11px;
    }
    .le-run code {
      display: block;
      font-size: 10px;
      color: var(--g-fg-dim, var(--glass-fg-2));
      overflow-wrap: anywhere;
      margin-top: 3px;
    }
    .le-run time {
      display: block;
      font-size: 9px;
      color: var(--g-fg-faint, var(--glass-fg-2));
      margin-top: 3px;
    }
    .lead-engine :focus-visible {
      outline: 2px solid var(--g-primary, var(--glass-gold));
      outline-offset: 2px;
      border-radius: 6px;
    }
    @media (max-width: 980px) {
      .le-split {
        grid-template-columns: minmax(0, 1fr);
      }
      .le-detail {
        position: static;
      }
    }
    @media (max-width: 620px) {
      .lead-engine {
        padding: 12px;
      }
      .le-board {
        grid-auto-columns: minmax(215px, 1fr);
      }
    }
  </style>
`;

// ══════════════════════════════════════════════════════════════════════════════
// Small helpers
// ══════════════════════════════════════════════════════════════════════════════

function money(value: number | undefined, currency = "USD"): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${value}`;
  }
}

function when(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function scoreTone(score: number | undefined): string {
  if (score === undefined) return "";
  if (score >= 75) return "good";
  if (score >= 50) return "warn";
  return "bad";
}

function humanize(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function selectField(
  label: string,
  value: string,
  options: readonly string[],
  onChange: (value: string) => void,
  placeholder?: string,
): TemplateResult {
  return html`
    <label class="le-field">
      <span>${label}</span>
      <select
        class="le-select"
        aria-label=${label}
        .value=${value}
        @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value)}
      >
        ${placeholder ? html`<option value="">${placeholder}</option>` : nothing}
        ${options.map(
          (option) =>
            html`<option value=${option} ?selected=${option === value}>${humanize(option)}</option>`,
        )}
      </select>
    </label>
  `;
}

function textField(
  label: string,
  value: string,
  onInput: (value: string) => void,
  options: { type?: string; placeholder?: string; full?: boolean } = {},
): TemplateResult {
  return html`
    <label class="le-field ${options.full ? "full" : ""}">
      <span>${label}</span>
      <input
        class="le-input"
        type=${options.type ?? "text"}
        aria-label=${label}
        placeholder=${options.placeholder ?? ""}
        .value=${value}
        @input=${(e: Event) => onInput((e.target as HTMLInputElement).value)}
      />
    </label>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Banners
// ══════════════════════════════════════════════════════════════════════════════

/**
 * The failure banners are the whole reason this surface can be trusted. An
 * operator must be able to tell "this funnel has no leads" from "we could not
 * reach the lead store", so both lists render even while data is on screen.
 */
function renderBanners(state: LeadEngineState): TemplateResult {
  return html`
    ${state.notice
      ? html`
          <div class="le-note" role="status">
            <span>${state.notice}</span>
            <button class="le-btn tiny" aria-label="Dismiss notice" @click=${dismissLeadNotice}>
              Dismiss
            </button>
          </div>
        `
      : nothing}
    ${state.failedRequests.length
      ? html`
          <div class="le-alert" role="alert">
            <strong>${state.failedRequests.length} request(s) failed.</strong> The panels below are
            incomplete — this is not an empty pipeline.
            <ul>
              ${state.failedRequests.map((entry) => html`<li>${entry}</li>`)}
            </ul>
          </div>
        `
      : nothing}
    ${state.degraded.length
      ? html`
          <div class="le-warn" role="status">
            <details>
              <summary>
                <strong>Running on ${state.degraded.length} fallback method(s).</strong>
                This gateway build advertises them but does not implement them, so an equivalent
                handler answered instead. The data below is real.
              </summary>
              <ul>
                ${state.degraded.map((entry) => html`<li>${entry}</li>`)}
              </ul>
            </details>
          </div>
        `
      : nothing}
  `;
}

function renderScope(state: LeadEngineState): TemplateResult {
  return html`
    <div class="le-scope">
      <label class="le-field">
        <span>Business</span>
        <select
          class="le-select"
          aria-label="Select business"
          @change=${(e: Event) => selectLeadBusiness((e.target as HTMLSelectElement).value)}
        >
          ${state.businesses.map(
            (business) =>
              html`<option value=${business.id} ?selected=${business.id === state.businessId}>
                ${business.name}
              </option>`,
          )}
          ${state.businesses.length ? nothing : html`<option value="">No businesses</option>`}
        </select>
      </label>
      <label class="le-field">
        <span>Funnel</span>
        <select
          class="le-select"
          aria-label="Select funnel"
          @change=${(e: Event) => selectLeadFunnel((e.target as HTMLSelectElement).value)}
        >
          ${state.funnels.map(
            (funnel) =>
              html`<option value=${funnel.id} ?selected=${funnel.id === state.funnelId}>
                ${funnel.name}
              </option>`,
          )}
          ${state.funnels.length ? nothing : html`<option value="">No funnels</option>`}
        </select>
      </label>
      <button
        class="le-btn"
        aria-label="Reload lead engine"
        ?disabled=${state.loading || state.refreshing}
        @click=${() => void loadLeadEngine({ background: true })}
      >
        ${state.refreshing ? "Refreshing…" : "Refresh"}
      </button>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Pipeline
// ══════════════════════════════════════════════════════════════════════════════

function renderKpis(state: LeadEngineState): TemplateResult {
  const a = state.analytics;
  return html`
    <div class="le-kpis">
      <div class="le-kpi">
        <span>Leads in view</span><strong>${state.leads.length}</strong>
      </div>
      <div class="le-kpi">
        <span>Total leads</span><strong>${a ? a.totalLeads : state.leadTotal}</strong>
      </div>
      <div class="le-kpi">
        <span>Conversion</span>
        <strong>${a ? `${a.overallConversionRate.toFixed(1)}%` : "—"}</strong>
      </div>
      <div class="le-kpi">
        <span>Pipeline value</span><strong>${a ? money(a.totalValue) : "—"}</strong>
      </div>
      <div class="le-kpi">
        <span>Won value</span><strong>${a ? money(a.wonValue) : "—"}</strong>
      </div>
      <div class="le-kpi">
        <span>Avg deal</span><strong>${a ? money(a.averageDealSize) : "—"}</strong>
      </div>
    </div>
  `;
}

function renderFilters(state: LeadEngineState): TemplateResult {
  const f = state.filters;
  return html`
    <div class="le-panel">
      <div class="le-panel-head">
        <h3>Filter leads</h3>
        <div class="le-row-actions">
          <button
            class="le-btn tiny"
            aria-label=${`Switch to ${state.layout === "board" ? "table" : "board"} layout`}
            @click=${() => setLeadLayout(state.layout === "board" ? "table" : "board")}
          >
            ${state.layout === "board" ? "Table view" : "Board view"}
          </button>
          <button class="le-btn tiny" aria-label="Clear all filters" @click=${clearLeadFilters}>
            Clear
          </button>
          <button class="le-btn tiny primary" aria-label="Apply filters" @click=${() => void searchLeads()}>
            Search
          </button>
        </div>
      </div>
      <div class="le-filters">
        <label class="le-field">
          <span>Search</span>
          <input
            class="le-input"
            type="search"
            aria-label="Search leads by name, email or company"
            placeholder="Name, email, company…"
            .value=${f.search}
            @input=${(e: Event) => setLeadFilter("search", (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") void searchLeads();
            }}
          />
        </label>
        ${selectField("Status", f.status, LEAD_STATUSES, (v) => setLeadFilter("status", v as LeadStatus | ""), "Any status")}
        ${selectField("Priority", f.priority, LEAD_PRIORITIES, (v) => setLeadFilter("priority", v as LeadPriority | ""), "Any priority")}
        ${selectField("Source", f.source, LEAD_SOURCES, (v) => setLeadFilter("source", v as LeadSource | ""), "Any source")}
        ${textField("Min score", f.minScore, (v) => setLeadFilter("minScore", v), { type: "number" })}
      </div>
    </div>
  `;
}

function renderLeadDraft(state: LeadEngineState): TemplateResult {
  const draft = state.leadDraft;
  if (!draft) return html``;
  return html`
    <div class="le-form" role="group" aria-label="New lead">
      ${textField("Name", draft.name, (v) => patchLeadDraft({ name: v }))}
      ${textField("Email", draft.email, (v) => patchLeadDraft({ email: v }), { type: "email" })}
      ${textField("Phone", draft.phone, (v) => patchLeadDraft({ phone: v }))}
      ${textField("Company", draft.company, (v) => patchLeadDraft({ company: v }))}
      ${selectField("Source", draft.source, LEAD_SOURCES, (v) => patchLeadDraft({ source: v as LeadSource }))}
      <label class="le-field">
        <span>Stage</span>
        <select
          class="le-select"
          aria-label="Stage for the new lead"
          .value=${draft.stageId}
          @change=${(e: Event) => patchLeadDraft({ stageId: (e.target as HTMLSelectElement).value })}
        >
          ${state.stages.map(
            (stage) =>
              html`<option value=${stage.id} ?selected=${stage.id === draft.stageId}>
                ${stage.name}
              </option>`,
          )}
        </select>
      </label>
      ${textField("Est. value", draft.estimatedValue, (v) => patchLeadDraft({ estimatedValue: v }), { type: "number" })}
      ${textField("Tags", draft.tags, (v) => patchLeadDraft({ tags: v }), { placeholder: "comma,separated" })}
      <div class="le-form-actions">
        <button
          class="le-btn primary"
          aria-label="Create lead"
          ?disabled=${state.busyId === "lead:create"}
          @click=${() => void createLead()}
        >
          ${state.busyId === "lead:create" ? "Creating…" : "Create lead"}
        </button>
        <button class="le-btn" aria-label="Cancel new lead" @click=${closeLeadDraft}>Cancel</button>
      </div>
    </div>
  `;
}

function renderLeadCard(state: LeadEngineState, lead: Lead): TemplateResult {
  return html`
    <div>
      <button
        class="le-card"
        aria-current=${lead.id === state.selectedLeadId ? "true" : "false"}
        aria-label=${`Open lead ${lead.name}`}
        @click=${() => void selectLead(lead.id)}
      >
        <span class="le-card-name">${lead.name}</span>
        <span class="le-card-sub">${lead.company || lead.email || lead.source}</span>
        <span class="le-card-foot">
          <span class="le-chip ${scoreTone(lead.score)}"
            >Score ${lead.score ?? "—"}</span
          >
          <span class="le-chip">${humanize(lead.status)}</span>
          ${lead.estimatedValue
            ? html`<span class="le-chip info">${money(lead.estimatedValue, lead.currency)}</span>`
            : nothing}
        </span>
      </button>
      <div class="le-move">
        <select
          aria-label=${`Move ${lead.name} to another stage`}
          .value=${lead.stageId}
          ?disabled=${state.busyId === `move:${lead.id}`}
          @change=${(e: Event) => void moveLeadToStage(lead.id, (e.target as HTMLSelectElement).value)}
        >
          ${state.stages.map(
            (stage) =>
              html`<option value=${stage.id} ?selected=${stage.id === lead.stageId}>
                ${stage.name}
              </option>`,
          )}
        </select>
      </div>
    </div>
  `;
}

function renderBoard(state: LeadEngineState): TemplateResult {
  const columns = leadsByStage();
  if (!columns.length) {
    // A funnel with no stages cannot accept a lead at all, so the fix is
    // offered right here rather than sending the operator to another tab.
    return html`
      <div class="le-empty" style="text-align:left">
        <p style="margin:0 0 10px">
          This funnel has no stages, so leads have nowhere to live. Add the first one to start
          working leads.
        </p>
        <div class="le-move" style="max-width:340px">
          <input
            class="le-input"
            id="le-new-stage"
            aria-label="Name for the first stage"
            placeholder="e.g. Awareness"
            @keydown=${(e: KeyboardEvent) => {
              if (e.key !== "Enter") return;
              const input = e.target as HTMLInputElement;
              void createStage(input.value);
              input.value = "";
            }}
          />
          <button
            class="le-btn tiny primary"
            aria-label="Add first stage"
            ?disabled=${state.busyId === "stage:create"}
            @click=${() => {
              const input = document.getElementById("le-new-stage") as HTMLInputElement | null;
              if (!input) return;
              void createStage(input.value);
              input.value = "";
            }}
          >
            Add stage
          </button>
        </div>
      </div>
    `;
  }
  return html`
    <div class="le-board" role="list" aria-label="Lead pipeline by stage">
      ${columns.map(
        (column) => html`
          <section class="le-col" role="listitem" aria-label=${`${column.stage.name} stage`}>
            <div class="le-col-head">
              <strong>${column.stage.name}</strong>
              <small>${column.leads.length}</small>
            </div>
            ${column.leads.length
              ? column.leads.map((lead) => renderLeadCard(state, lead))
              : html`<div class="le-empty">No leads here.</div>`}
          </section>
        `,
      )}
    </div>
  `;
}

function renderTable(state: LeadEngineState): TemplateResult {
  if (!state.leads.length) {
    return html`<div class="le-empty">No leads match these filters.</div>`;
  }
  return html`
    <div class="le-table-wrap">
      <table class="le-table">
        <thead>
          <tr>
            <th scope="col">Lead</th>
            <th scope="col">Company</th>
            <th scope="col">Stage</th>
            <th scope="col">Status</th>
            <th scope="col">Priority</th>
            <th scope="col">Score</th>
            <th scope="col">Value</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          ${state.leads.map((lead) => {
            const stage = state.stages.find((s) => s.id === lead.stageId);
            return html`
              <tr>
                <td>
                  <button
                    class="le-link"
                    aria-label=${`Open lead ${lead.name}`}
                    @click=${() => void selectLead(lead.id)}
                  >
                    ${lead.name}
                  </button>
                </td>
                <td>${lead.company || "—"}</td>
                <td>${stage?.name ?? "Unmapped"}</td>
                <td><span class="le-chip">${humanize(lead.status)}</span></td>
                <td>${humanize(lead.priority)}</td>
                <td><span class="le-chip ${scoreTone(lead.score)}">${lead.score ?? "—"}</span></td>
                <td>${money(lead.estimatedValue, lead.currency)}</td>
                <td>${when(lead.updatedAt)}</td>
              </tr>
            `;
          })}
        </tbody>
      </table>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Lead detail — score, qualify, match, timeline, AI
// ══════════════════════════════════════════════════════════════════════════════

function renderQualification(state: LeadEngineState): TemplateResult {
  const q = state.qualification;
  if (!q) return html``;
  const percent = q.maxScore > 0 ? (q.qualificationScore / q.maxScore) * 100 : 0;
  const factors = Object.entries(q.factors);
  return html`
    <div class="le-verdict ${q.isQualified ? "qualified" : "unqualified"}">
      <div class="le-verdict-head">
        <strong>${q.isQualified ? "Qualified" : "Not yet qualified"}</strong>
        <span class="le-chip ${q.isQualified ? "good" : "warn"}">
          ${q.qualificationScore} / ${q.maxScore}
        </span>
      </div>
      <div
        class="le-meter"
        role="meter"
        aria-valuenow=${q.qualificationScore}
        aria-valuemin="0"
        aria-valuemax=${q.maxScore}
        aria-label="Qualification factors met"
      >
        <i style=${`width:${Math.max(0, Math.min(100, percent))}%`}></i>
      </div>
      ${factors.length
        ? html`
            <div class="le-factors">
              ${factors.map(
                ([key, met]) => html`
                  <div class="le-factor ${met ? "on" : "off"}">
                    <b aria-hidden="true">${met ? "✓" : "○"}</b>
                    <span>${humanize(key)}</span>
                  </div>
                `,
              )}
            </div>
          `
        : html`<div class="le-empty">The verdict came back without a factor breakdown.</div>`}
    </div>
  `;
}

function renderMatchedOffers(state: LeadEngineState): TemplateResult {
  if (!state.matchChecked) return html``;
  if (!state.matchedOffers.length) {
    return html`
      <div class="le-empty">
        No active offer matches this lead. Check the offer targeting rules — stage, tags and minimum
        score all have to pass.
      </div>
    `;
  }
  return html`
    <div class="le-list">
      ${state.matchedOffers.map(
        (offer) => html`
          <div class="le-row">
            <div>
              <strong>${offer.name}</strong>
              <small>${humanize(offer.type)} · ${money(offer.price, offer.currency)}</small>
            </div>
            <div class="le-row-actions">
              <span class="le-chip good">Eligible</span>
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

function renderTimeline(state: LeadEngineState): TemplateResult {
  if (state.detailLoading) return html`<div class="le-empty">Loading timeline…</div>`;
  if (!state.selectedLeadActivities.length) {
    return html`<div class="le-empty">No activity recorded for this lead yet.</div>`;
  }
  return html`
    <div class="le-timeline">
      ${state.selectedLeadActivities.map(
        (activity) => html`
          <div class="le-event">
            <span class="le-dot ${activity.type}" aria-hidden="true"></span>
            <div>
              <p>${activity.description}</p>
              <time datetime=${activity.createdAt}
                >${humanize(activity.type)} · ${when(activity.createdAt)}</time
              >
            </div>
          </div>
        `,
      )}
    </div>
  `;
}

function renderLeadDetail(state: LeadEngineState): TemplateResult {
  const lead = getSelectedLead();
  if (!lead) {
    return html`
      <div class="le-panel le-detail">
        <h3>Lead detail</h3>
        <div class="le-empty">
          Select a lead to score it, run qualification, match offers and read its timeline.
        </div>
      </div>
    `;
  }
  const busy = (key: string): boolean => state.busyId === key;
  return html`
    <div class="le-panel le-detail">
      <div class="le-panel-head">
        <h3>${lead.name}</h3>
        <button class="le-btn tiny" aria-label="Close lead detail" @click=${() => void selectLead(null)}>
          Close
        </button>
      </div>

      <dl class="le-kv">
        <dt>Email</dt><dd>${lead.email || "—"}</dd>
        <dt>Phone</dt><dd>${lead.phone || "—"}</dd>
        <dt>Company</dt><dd>${lead.company || "—"}</dd>
        <dt>Source</dt><dd>${humanize(lead.source)}</dd>
        <dt>Value</dt><dd>${money(lead.estimatedValue, lead.currency)}</dd>
        <dt>Created</dt><dd>${when(lead.createdAt)}</dd>
      </dl>

      <div class="le-filters" style="margin-top:11px">
        ${selectField("Status", lead.status, LEAD_STATUSES, (v) =>
          void updateLead(lead.id, { status: v as LeadStatus }),
        )}
        ${selectField("Priority", lead.priority, LEAD_PRIORITIES, (v) =>
          void updateLead(lead.id, { priority: v as LeadPriority }),
        )}
        <label class="le-field">
          <span>Score (0-100)</span>
          <input
            class="le-input"
            type="number"
            min="0"
            max="100"
            aria-label="Lead score between 0 and 100"
            .value=${state.scoreDraft}
            @input=${(e: Event) => setScoreDraft((e.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      <div class="le-actions">
        <button
          class="le-btn primary"
          aria-label="Save score for this lead"
          ?disabled=${busy(`score:${lead.id}`)}
          @click=${() => void scoreLead(lead.id, Number(state.scoreDraft))}
        >
          ${busy(`score:${lead.id}`) ? "Scoring…" : "Set score"}
        </button>
        <button
          class="le-btn primary"
          aria-label="Run qualification for this lead"
          ?disabled=${busy(`qualify:${lead.id}`)}
          @click=${() => void qualifyLead(lead.id)}
        >
          ${busy(`qualify:${lead.id}`) ? "Qualifying…" : "Qualify"}
        </button>
        <button
          class="le-btn"
          aria-label="Match offers to this lead"
          ?disabled=${busy(`match:${lead.id}`)}
          @click=${() => void matchOffersForLead(lead.id)}
        >
          ${busy(`match:${lead.id}`) ? "Matching…" : "Match offers"}
        </button>
        <button class="le-btn" aria-label="Create a task for this lead" @click=${() => openTaskDraft(lead.id)}>
          New task
        </button>
      </div>

      ${renderQualification(state)}
      ${state.matchChecked
        ? html`<h3 style="margin:14px 0 8px">Matched offers</h3>${renderMatchedOffers(state)}`
        : nothing}

      <h3 style="margin:15px 0 8px">AI actions</h3>
      <div class="le-actions" style="margin-top:0">
        <button
          class="le-btn accent"
          aria-label="Classify this lead's intent"
          ?disabled=${busy("ai:funnels.ai.classifyIntent")}
          @click=${() => void classifyLeadIntent(lead.id)}
        >
          Classify intent
        </button>
        <button
          class="le-btn accent"
          aria-label="Generate qualification questions for this lead"
          ?disabled=${busy("ai:funnels.ai.generateQuestions")}
          @click=${() => void generateLeadQuestions(lead.id)}
        >
          Generate questions
        </button>
        <button
          class="le-btn accent"
          aria-label="Draft a response to this lead"
          ?disabled=${busy("ai:funnels.ai.generateResponse")}
          @click=${() => void generateLeadResponse(lead.id)}
        >
          Draft response
        </button>
      </div>
      ${state.aiRuns.length
        ? html`
            <div style="margin-top:10px">
              ${state.aiRuns.slice(0, 3).map(
                (run) => html`
                  <div class="le-run ${run.ok ? "ok" : "fail"}">
                    <strong>${run.label}</strong>
                    <code>${run.detail}</code>
                  </div>
                `,
              )}
            </div>
          `
        : nothing}

      <div class="le-panel-head" style="margin:16px 0 6px">
        <h3>Activity timeline</h3>
        <button
          class="le-btn tiny"
          aria-label="Refresh activity timeline"
          ?disabled=${busy(`activity:${lead.id}`)}
          @click=${() => void reloadLeadActivity(lead.id)}
        >
          Refresh
        </button>
      </div>
      ${renderTimeline(state)}

      <div class="le-actions">
        <button
          class="le-btn tiny"
          aria-label="Disqualify this lead"
          ?disabled=${busy(`lead:${lead.id}`)}
          @click=${() => void archiveLead(lead.id)}
        >
          Disqualify
        </button>
      </div>
    </div>
  `;
}

function renderPipeline(state: LeadEngineState): TemplateResult {
  return html`
    ${renderKpis(state)} ${renderFilters(state)}
    <div class="le-split">
      <div style="min-width:0">
        <div class="le-panel">
          <div class="le-panel-head">
            <h3>
              Leads ${state.leads.length ? `(${state.leads.length} of ${state.leadTotal})` : ""}
            </h3>
            <button class="le-btn tiny primary" aria-label="Add a new lead" @click=${() => openLeadDraft()}>
              New lead
            </button>
          </div>
          ${renderLeadDraft(state)}
          ${state.loading
            ? html`<div class="le-empty">Loading pipeline…</div>`
            : state.layout === "board"
              ? renderBoard(state)
              : renderTable(state)}
        </div>
        ${state.bottlenecks.length
          ? html`
              <div class="le-panel">
                <h3>Bottlenecks</h3>
                <div class="le-list">
                  ${state.bottlenecks.map(
                    (b) => html`
                      <div class="le-row">
                        <div>
                          <strong>${b.stageName}</strong>
                          <small>${b.issue}</small>
                        </div>
                        <div class="le-row-actions">
                          <span class="le-chip ${b.severity === "critical" ? "bad" : "warn"}">
                            ${b.severity}
                          </span>
                        </div>
                      </div>
                    `,
                  )}
                </div>
              </div>
            `
          : nothing}
      </div>
      ${renderLeadDetail(state)}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Offers
// ══════════════════════════════════════════════════════════════════════════════

function renderOfferDraft(state: LeadEngineState): TemplateResult {
  const draft = state.offerDraft;
  if (!draft) return html``;
  return html`
    <div class="le-form" role="group" aria-label=${draft.id ? "Edit offer" : "New offer"}>
      ${textField("Name", draft.name, (v) => patchOfferDraft({ name: v }))}
      ${selectField("Type", draft.type, OFFER_TYPES, (v) => patchOfferDraft({ type: v as OfferType }))}
      ${textField("Price", draft.price, (v) => patchOfferDraft({ price: v }), { type: "number" })}
      ${textField("Min score", draft.minScore, (v) => patchOfferDraft({ minScore: v }), { type: "number" })}
      ${draft.id
        ? selectField("Status", draft.status, OFFER_STATUSES, (v) =>
            patchOfferDraft({ status: v as OfferStatus }),
          )
        : nothing}
      ${textField("Description", draft.description, (v) => patchOfferDraft({ description: v }), { full: true })}
      <div class="le-form-actions">
        <button
          class="le-btn primary"
          aria-label=${draft.id ? "Save offer" : "Create offer"}
          ?disabled=${state.busyId === "offer:save"}
          @click=${() => void saveOffer()}
        >
          ${state.busyId === "offer:save" ? "Saving…" : draft.id ? "Save offer" : "Create offer"}
        </button>
        <button class="le-btn" aria-label="Cancel offer edit" @click=${closeOfferDraft}>Cancel</button>
      </div>
    </div>
  `;
}

function renderOffers(state: LeadEngineState): TemplateResult {
  return html`
    <div class="le-panel">
      <div class="le-panel-head">
        <h3>Offers (${state.offers.length})</h3>
        <button class="le-btn tiny primary" aria-label="Create an offer" @click=${() => openOfferDraft()}>
          New offer
        </button>
      </div>
      ${renderOfferDraft(state)}
      ${state.offers.length
        ? html`
            <div class="le-list">
              ${state.offers.map((offer: Offer) => {
                const busy = state.busyId === `offer:${offer.id}`;
                return html`
                  <div class="le-row">
                    <div>
                      <strong>${offer.name}</strong>
                      <small>
                        ${humanize(offer.type)} · ${money(offer.price, offer.currency)}
                        ${offer.minScore !== undefined ? ` · min score ${offer.minScore}` : ""}
                      </small>
                    </div>
                    <div class="le-row-actions">
                      <span class="le-chip ${offer.status === "active" ? "good" : ""}">
                        ${offer.status}
                      </span>
                      <button
                        class="le-btn tiny"
                        aria-label=${`${offer.status === "active" ? "Pause" : "Activate"} offer ${offer.name}`}
                        ?disabled=${busy}
                        @click=${() =>
                          void setOfferStatus(offer.id, offer.status === "active" ? "paused" : "active")}
                      >
                        ${offer.status === "active" ? "Pause" : "Activate"}
                      </button>
                      <button
                        class="le-btn tiny"
                        aria-label=${`Edit offer ${offer.name}`}
                        @click=${() => openOfferDraft(offer)}
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                `;
              })}
            </div>
          `
        : html`<div class="le-empty">
            No offers for this business yet. Offers are what lead matching scores against.
          </div>`}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Tasks
// ══════════════════════════════════════════════════════════════════════════════

function renderTaskDraft(state: LeadEngineState): TemplateResult {
  const draft = state.taskDraft;
  if (!draft) return html``;
  return html`
    <div class="le-form" role="group" aria-label="New task">
      ${textField("Title", draft.title, (v) => patchTaskDraft({ title: v }))}
      ${selectField("Type", draft.type, TASK_TYPES, (v) => patchTaskDraft({ type: v as TaskType }))}
      ${selectField("Priority", draft.priority, TASK_PRIORITIES, (v) =>
        patchTaskDraft({ priority: v as TaskPriority }),
      )}
      ${textField("Due", draft.dueAt, (v) => patchTaskDraft({ dueAt: v }), { type: "date" })}
      <div class="le-form-actions">
        <button
          class="le-btn primary"
          aria-label="Create task"
          ?disabled=${state.busyId === "task:create"}
          @click=${() => void createTask()}
        >
          ${state.busyId === "task:create" ? "Creating…" : "Create task"}
        </button>
        <button class="le-btn" aria-label="Cancel new task" @click=${closeTaskDraft}>Cancel</button>
      </div>
    </div>
  `;
}

function renderTasks(state: LeadEngineState): TemplateResult {
  const open = state.tasks.filter((t) => t.status !== "completed");
  const done = state.tasks.filter((t) => t.status === "completed");
  const row = (task: FunnelTask): TemplateResult => {
    const lead = state.leads.find((l) => l.id === task.leadId);
    return html`
      <div class="le-row">
        <div>
          <strong>${task.title}</strong>
          <small>
            ${humanize(task.type)} · ${humanize(task.priority)}
            ${task.dueAt ? ` · due ${when(task.dueAt)}` : ""}
            ${lead ? ` · ${lead.name}` : ""}
          </small>
        </div>
        <div class="le-row-actions">
          <span class="le-chip ${task.status === "completed" ? "good" : ""}">${task.status}</span>
          ${task.status !== "completed"
            ? html`
                <button
                  class="le-btn tiny"
                  aria-label=${`Complete task ${task.title}`}
                  ?disabled=${state.busyId === `task:${task.id}`}
                  @click=${() => void completeTask(task.id)}
                >
                  Complete
                </button>
              `
            : nothing}
        </div>
      </div>
    `;
  };
  return html`
    <div class="le-panel">
      <div class="le-panel-head">
        <h3>Open tasks (${open.length})</h3>
        <div class="le-row-actions">
          <button
            class="le-btn tiny"
            aria-label="Reload tasks"
            ?disabled=${state.busyId === "task:list"}
            @click=${() => void reloadTasks()}
          >
            Reload
          </button>
          <button class="le-btn tiny primary" aria-label="Create a task" @click=${() => openTaskDraft()}>
            New task
          </button>
        </div>
      </div>
      ${renderTaskDraft(state)}
      ${open.length
        ? html`<div class="le-list">${open.map(row)}</div>`
        : html`<div class="le-empty">No open tasks on this funnel.</div>`}
    </div>
    ${done.length
      ? html`
          <div class="le-panel">
            <h3>Completed (${done.length})</h3>
            <div class="le-list">${done.slice(0, 25).map(row)}</div>
          </div>
        `
      : nothing}
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Metrics
// ══════════════════════════════════════════════════════════════════════════════

function renderMetrics(state: LeadEngineState): TemplateResult {
  const draft = state.metricDraft;
  return html`
    <div class="le-panel">
      <div class="le-panel-head">
        <h3>Log a metric</h3>
        <button
          class="le-btn tiny"
          aria-label="Reload metrics"
          ?disabled=${state.busyId === "metric:get"}
          @click=${() => void reloadMetrics()}
        >
          Reload
        </button>
      </div>
      <div class="le-form" role="group" aria-label="Log a KPI metric">
        ${textField("Metric name", draft.name, (v) => patchMetricDraft({ name: v }))}
        ${textField("Value", draft.value, (v) => patchMetricDraft({ value: v }), { type: "number" })}
        ${selectField(
          "Type",
          draft.type,
          ["count", "sum", "average", "percentage", "ratio", "duration", "currency"],
          (v) => patchMetricDraft({ type: v }),
        )}
        ${selectField(
          "Period",
          draft.period,
          ["daily", "weekly", "monthly", "quarterly", "yearly", "all_time"],
          (v) => patchMetricDraft({ period: v }),
        )}
        <div class="le-form-actions">
          <button
            class="le-btn primary"
            aria-label="Log metric"
            ?disabled=${state.busyId === "metric:log"}
            @click=${() => void logMetric()}
          >
            ${state.busyId === "metric:log" ? "Logging…" : "Log metric"}
          </button>
        </div>
      </div>
    </div>
    <div class="le-panel">
      <h3>Recorded metrics (${state.metrics.length})</h3>
      ${state.metrics.length
        ? html`
            <div class="le-list">
              ${state.metrics.map(
                (metric) => html`
                  <div class="le-row">
                    <div>
                      <strong>${metric.name}</strong>
                      <small>${humanize(metric.type)} · ${metric.period} · ${when(metric.calculatedAt)}</small>
                    </div>
                    <div class="le-row-actions">
                      <span class="le-chip info">${metric.currentValue}${metric.unit ?? ""}</span>
                      ${metric.changePercent !== undefined
                        ? html`<span class="le-chip ${metric.changePercent >= 0 ? "good" : "bad"}">
                            ${metric.changePercent >= 0 ? "+" : ""}${metric.changePercent.toFixed(1)}%
                          </span>`
                        : nothing}
                    </div>
                  </div>
                `,
              )}
            </div>
          `
        : html`<div class="le-empty">
            No metrics logged for this funnel yet. Metrics logged here feed the funnel KPI history.
          </div>`}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Intelligence
// ══════════════════════════════════════════════════════════════════════════════

function renderIntelligence(state: LeadEngineState): TemplateResult {
  const a = state.analytics;
  return html`
    <div class="le-panel">
      <h3>Funnel intelligence</h3>
      <p style="margin:0 0 12px;font-size:11px;color:var(--g-fg-dim,#a1a1aa)">
        Operator-triggered analysis. Each run appends to the log below — including failures, so a
        method this gateway does not implement is a visible answer rather than a dead button.
      </p>
      <div class="le-actions" style="margin-top:0">
        <button
          class="le-btn primary"
          aria-label="Analyze this funnel"
          ?disabled=${!state.funnelId || state.busyId === "ai:funnels.analyze"}
          @click=${() => void analyzeFunnel()}
        >
          Analyze funnel
        </button>
        <button
          class="le-btn accent"
          aria-label="Generate a standard operating procedure from this funnel"
          ?disabled=${!state.funnelId || state.busyId === "ai:funnels.generateSOP"}
          @click=${() => void generateFunnelSOP()}
        >
          Generate SOP
        </button>
        <button
          class="le-btn accent"
          aria-label="Suggest improvements for this funnel"
          ?disabled=${!state.funnelId || state.busyId === "ai:funnels.ai.suggestImprovements"}
          @click=${() => void suggestFunnelImprovements()}
        >
          Suggest improvements
        </button>
      </div>
    </div>

    ${a
      ? html`
          <div class="le-panel">
            <h3>Latest analysis</h3>
            <div class="le-kpis" style="margin-bottom:0">
              <div class="le-kpi"><span>Total leads</span><strong>${a.totalLeads}</strong></div>
              <div class="le-kpi"><span>New (30d)</span><strong>${a.newLeads}</strong></div>
              <div class="le-kpi"><span>Converted</span><strong>${a.convertedLeads}</strong></div>
              <div class="le-kpi"><span>Lost</span><strong>${a.lostLeads}</strong></div>
              <div class="le-kpi">
                <span>Conversion</span><strong>${a.overallConversionRate.toFixed(1)}%</strong>
              </div>
              <div class="le-kpi"><span>Won value</span><strong>${money(a.wonValue)}</strong></div>
              <div class="le-kpi"><span>Lost value</span><strong>${money(a.lostValue)}</strong></div>
              <div class="le-kpi"><span>Avg deal</span><strong>${money(a.averageDealSize)}</strong></div>
            </div>
          </div>
        `
      : nothing}

    <div class="le-panel">
      <h3>Run log</h3>
      ${state.aiRuns.length
        ? state.aiRuns.map(
            (run) => html`
              <div class="le-run ${run.ok ? "ok" : "fail"}">
                <strong>${run.label} ${run.ok ? "" : "— failed"}</strong>
                <code>${run.method}: ${run.detail}</code>
                <time>${new Date(run.ranAt).toLocaleString()}</time>
              </div>
            `,
          )
        : html`<div class="le-empty">Nothing has been run yet.</div>`}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// Entry point
// ══════════════════════════════════════════════════════════════════════════════

export function renderFunnelLeads(props: FunnelLeadsProps): TemplateResult {
  const { client, requestUpdate } = props;
  setLeadEngineRequestUpdate(requestUpdate);
  if (client && !_initialised) {
    _initialised = true;
    setLeadEngineClient(client);
    void loadLeadEngine();
  }

  const state = getLeadEngineState();

  return html`
    ${styles}
    <div class="lead-engine">
      <div class="le-head">
        <div style="min-width:0">
          <h2>Lead Engine</h2>
          <p>
            Pipeline, scoring, qualification, offer matching, tasks and KPIs for the selected funnel
            — backed directly by the server lead store.
          </p>
        </div>
        ${renderScope(state)}
      </div>

      ${renderBanners(state)}

      <div class="le-tabs" role="tablist" aria-label="Lead engine sections">
        ${SECTIONS.map(
          (section) => html`
            <button
              class="le-tab"
              role="tab"
              aria-selected=${state.section === section.id ? "true" : "false"}
              @click=${() => setLeadSection(section.id)}
            >
              ${section.label}
            </button>
          `,
        )}
      </div>

      ${!state.funnelId && !state.loading
        ? html`<div class="le-empty">
            No funnel selected. Create a funnel in the Builder tab, then come back to work its
            leads.
          </div>`
        : state.section === "pipeline"
          ? renderPipeline(state)
          : state.section === "offers"
            ? renderOffers(state)
            : state.section === "tasks"
              ? renderTasks(state)
              : state.section === "metrics"
                ? renderMetrics(state)
                : renderIntelligence(state)}
    </div>
  `;
}

/**
 * Funnels — End-to-End Flow Visualization
 *
 * Renders the aggregate returned by gateway method `funnels.flow.snapshot`
 * as a 3-column layout:
 *
 *    Sources   →   Stages   →   Outcomes
 *
 * Sources column lists bound forms, bound pages, and any "untracked"
 * upstreams (manual imports / raw webhooks). Stages column shows live
 * lead counts per stage with qualified/unqualified/pending breakdown.
 * Outcomes column shows won / lost / promoted-to-CRM and total leads.
 *
 * This view is owned by the parent `funnels.ts` view module — it
 * exports `renderFunnelsFlowEndToEnd(props)` which the parent calls
 * when `_activeView === "flow"`.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";

export interface FlowSource {
  kind: "form" | "page" | "untracked";
  id: string;
  tag: string;
  entryStageId: string | null;
  leadCount: number;
}

export interface FlowStage {
  id: string;
  name: string;
  type: string;
  position: number;
  leadCount: number;
  qualified: number;
  unqualified: number;
  pending: number;
}

export interface FlowOutcomes {
  won: number;
  lost: number;
  promotedToCrm: number;
  totalLeads: number;
}

export interface FlowSnapshot {
  funnel: {
    id: string;
    name: string;
    type: string;
    businessId: string;
    status: string;
  };
  sources: FlowSource[];
  stages: FlowStage[];
  outcomes: FlowOutcomes;
}

export interface FunnelsFlowEndToEndProps {
  funnelId: string | null;
  client?: GatewayBrowserClient;
  requestUpdate: () => void;
}

// Module-scoped cache so renders stay cheap as the parent re-renders.
const _cache = new Map<string, FlowSnapshot>();
let _loading = false;
let _error: string | null = null;
let _lastLoaded: string | null = null;

async function loadSnapshot(funnelId: string, client: GatewayBrowserClient, requestUpdate: () => void) {
  if (_loading && _lastLoaded === funnelId) return;
  _loading = true;
  _error = null;
  requestUpdate();
  try {
    const result = await client.request<FlowSnapshot>("funnels.flow.snapshot", { funnelId });
    if (result) {
      _cache.set(funnelId, result);
    } else {
      _error = "Failed to load flow snapshot";
    }
  } catch (err) {
    _error = err instanceof Error ? err.message : String(err);
  } finally {
    _loading = false;
    _lastLoaded = funnelId;
    requestUpdate();
  }
}

export function refreshFlowSnapshot(funnelId: string, client?: GatewayBrowserClient, requestUpdate?: () => void) {
  if (!client || !requestUpdate) return;
  _cache.delete(funnelId);
  loadSnapshot(funnelId, client, requestUpdate);
}

export function renderFunnelsFlowEndToEnd(props: FunnelsFlowEndToEndProps): TemplateResult {
  const { funnelId, client, requestUpdate } = props;
  if (!funnelId) {
    return html`<div class="flow-e2e flow-e2e--empty">
      <div class="flow-e2e__empty">
        <h2>End-to-End Flow</h2>
        <p>Select a funnel in the sidebar to see its sources, stages and outcomes.</p>
      </div>
    </div>`;
  }
  if (client && (!_cache.has(funnelId) || _lastLoaded !== funnelId)) {
    void loadSnapshot(funnelId, client, requestUpdate);
  }
  const snap = _cache.get(funnelId);
  return html`
    <style>${flowStyles}</style>
    <div class="flow-e2e">
      <div class="flow-e2e__toolbar">
        <div class="flow-e2e__title hud-title">
          ${snap ? html`<strong>${snap.funnel.name}</strong>` : "Loading..."}
          ${snap ? html`<span class="glass-chip">${snap.funnel.type}</span>` : nothing}
        </div>
        <button
          class="glass-button"
          @click=${() => refreshFlowSnapshot(funnelId, client, requestUpdate)}
        >
          Refresh
        </button>
      </div>

      ${_loading && !snap ? html`<div class="flow-e2e__loading glass">Loading flow snapshot…</div>` : nothing}
      ${_error ? html`<div class="flow-e2e__error glass">${_error}</div>` : nothing}

      ${snap ? renderColumns(snap) : nothing}
    </div>
  `;
}

function renderColumns(snap: FlowSnapshot): TemplateResult {
  return html`
    <div class="flow-e2e__grid">
      ${renderSourcesColumn(snap)}
      ${renderStagesColumn(snap)}
      ${renderOutcomesColumn(snap.outcomes)}
    </div>
  `;
}

function renderSourcesColumn(snap: FlowSnapshot): TemplateResult {
  const totalIn = snap.sources.reduce((n, s) => n + s.leadCount, 0);
  return html`
    <div class="flow-col glass-deep flow-col--sources">
      <div class="flow-col__header">
        <span class="flow-col__label hud-title">Sources</span>
        <span class="flow-col__count">${totalIn}</span>
      </div>
      ${snap.sources.length === 0
        ? html`<div class="flow-col__empty">No leads have arrived yet.</div>`
        : snap.sources.map(
            (s) => html`
              <div class="flow-card glass lift-on-hover flow-card--${s.kind}">
                <div class="flow-card__kind">${s.kind}</div>
                <div class="flow-card__id">${s.tag}</div>
                <div class="flow-card__metric">
                  <span class="flow-card__metric-value">${s.leadCount}</span>
                  <span class="flow-card__metric-label">leads</span>
                </div>
                ${s.kind === "untracked"
                  ? html`<div class="flow-card__hint">Bind this source to a stage to track it.</div>`
                  : nothing}
              </div>
            `,
          )}
    </div>
  `;
}

function renderStagesColumn(snap: FlowSnapshot): TemplateResult {
  const stages = [...snap.stages].sort((a, b) => a.position - b.position);
  return html`
    <div class="flow-col glass-deep flow-col--stages">
      <div class="flow-col__header">
        <span class="flow-col__label hud-title">Stages</span>
        <span class="flow-col__count">${stages.length}</span>
      </div>
      ${stages.length === 0
        ? html`<div class="flow-col__empty">No stages defined.</div>`
        : stages.map((st) => {
            const total = st.leadCount || 0;
            const q = st.qualified || 0;
            const u = st.unqualified || 0;
            const p = st.pending || 0;
            const qPct = total > 0 ? Math.round((q / total) * 100) : 0;
            const uPct = total > 0 ? Math.round((u / total) * 100) : 0;
            const pPct = total > 0 ? Math.max(0, 100 - qPct - uPct) : 0;
            return html`
              <div class="flow-card glass lift-on-hover flow-card--stage">
                <div class="flow-card__row">
                  <span class="flow-card__name">${st.name}</span>
                  <span class="flow-card__kind">${st.type}</span>
                </div>
                <div class="flow-card__metric">
                  <span class="flow-card__metric-value">${total}</span>
                  <span class="flow-card__metric-label">leads</span>
                </div>
                <div class="flow-card__bar">
                  <span class="flow-card__bar-q" style="width:${qPct}%"></span>
                  <span class="flow-card__bar-u" style="width:${uPct}%"></span>
                  <span class="flow-card__bar-p" style="width:${pPct}%"></span>
                </div>
                <div class="flow-card__legend">
                  <span class="flow-card__legend-item flow-card__legend-item--q">Qualified ${q}</span>
                  <span class="flow-card__legend-item flow-card__legend-item--u">Unqualified ${u}</span>
                  <span class="flow-card__legend-item flow-card__legend-item--p">Pending ${p}</span>
                </div>
              </div>
            `;
          })}
    </div>
  `;
}

function renderOutcomesColumn(out: FlowOutcomes): TemplateResult {
  const won = out.won || 0;
  const lost = out.lost || 0;
  const promoted = out.promotedToCrm || 0;
  const total = out.totalLeads || 0;
  const winRate = total > 0 ? Math.round((won / total) * 100) : 0;
  return html`
    <div class="flow-col glass-deep flow-col--outcomes">
      <div class="flow-col__header">
        <span class="flow-col__label hud-title">Outcomes</span>
        <span class="flow-col__count">${total}</span>
      </div>
      <div class="flow-card glass lift-on-hover flow-card--won">
        <div class="flow-card__name">Won</div>
        <div class="flow-card__metric">
          <span class="flow-card__metric-value">${won}</span>
          <span class="flow-card__metric-label">${winRate}% win rate</span>
        </div>
      </div>
      <div class="flow-card glass lift-on-hover flow-card--lost">
        <div class="flow-card__name">Lost</div>
        <div class="flow-card__metric">
          <span class="flow-card__metric-value">${lost}</span>
          <span class="flow-card__metric-label">closed-lost</span>
        </div>
      </div>
      <div class="flow-card glass lift-on-hover flow-card--promoted">
        <div class="flow-card__name">Promoted to CRM</div>
        <div class="flow-card__metric">
          <span class="flow-card__metric-value">${promoted}</span>
          <span class="flow-card__metric-label">mirrored to clients</span>
        </div>
      </div>
    </div>
  `;
}

const flowStyles = `
  .flow-e2e {
    position: relative;
    z-index: 1;
    padding: 18px 22px 28px;
    color: var(--g-fg);
    height: 100%;
    overflow-y: auto;
    font-family: var(--g-font-family);
    background: transparent;
  }
  .flow-e2e--empty {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .flow-e2e__empty {
    text-align: center;
    color: var(--g-fg-dim);
    max-width: 460px;
    padding: 32px;
  }
  .flow-e2e__empty h2 {
    color: var(--g-primary);
    letter-spacing: 2px;
    margin: 0 0 8px 0;
    font-size: 18px;
    text-transform: uppercase;
  }
  .flow-e2e__toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 16px;
    gap: 12px;
  }
  .flow-e2e__title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
  }
  .flow-e2e__title strong {
    color: var(--g-fg);
    text-transform: none;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .flow-e2e__loading,
  .flow-e2e__error {
    padding: 12px 14px;
    border-radius: var(--g-radius-sm);
    margin-bottom: 12px;
    font-size: 12px;
  }
  .flow-e2e__loading { color: var(--g-fg-dim); }
  .flow-e2e__error {
    color: var(--destructive, #ef4444);
    border-color: color-mix(in srgb, var(--destructive, #ef4444) 35%, transparent) !important;
    background:
      linear-gradient(color-mix(in srgb, var(--destructive, #ef4444) 10%, transparent),
                      color-mix(in srgb, var(--destructive, #ef4444) 4%, transparent)),
      var(--g-surface) !important;
  }

  .flow-e2e__grid {
    display: grid;
    grid-template-columns: minmax(240px, 1fr) minmax(320px, 1.4fr) minmax(240px, 1fr);
    gap: 16px;
    align-items: start;
  }

  .flow-col {
    /* glass-deep handles bg + border + glow; we just lay out children */
    padding: 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .flow-col__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-bottom: 1px solid var(--g-border);
    padding-bottom: 8px;
    margin-bottom: 4px;
  }
  .flow-col__label {
    font-size: 11px;
  }
  .flow-col__count {
    color: var(--g-primary);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    background: var(--g-primary-soft);
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid var(--g-primary-muted);
  }
  .flow-col__empty {
    color: var(--g-fg-faint);
    font-size: 11px;
    text-align: center;
    padding: 18px 8px;
  }

  .flow-card {
    /* .glass utility provides bg + border + blur + radius */
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    cursor: default;
  }
  .flow-card__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .flow-card__kind {
    font-size: 9px;
    color: var(--g-primary);
    opacity: 0.85;
    letter-spacing: 1.5px;
    text-transform: uppercase;
  }
  .flow-card__id,
  .flow-card__name {
    font-size: 13px;
    color: var(--g-fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .flow-card__metric {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-top: 2px;
  }
  .flow-card__metric-value {
    font-size: 24px;
    color: var(--g-primary);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    background: var(--g-gradient-accent);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    text-shadow: 0 0 24px color-mix(in srgb, var(--g-primary) 22%, transparent);
  }
  .flow-card__metric-label {
    font-size: 11px;
    color: var(--g-fg-faint);
  }
  .flow-card__hint {
    font-size: 10px;
    color: color-mix(in srgb, var(--warn, #f59e0b) 70%, var(--g-fg-faint));
  }
  .flow-card--form {
    border-color: color-mix(in srgb, var(--g-accent) 32%, var(--g-border)) !important;
  }
  .flow-card--page {
    border-color: color-mix(in srgb, var(--info, var(--glass-gold)) 32%, var(--g-border)) !important;
  }
  .flow-card--untracked {
    border-color: color-mix(in srgb, var(--warn, #f59e0b) 32%, var(--g-border)) !important;
  }
  .flow-card--won {
    border-color: color-mix(in srgb, var(--ok, #22c55e) 38%, var(--g-border)) !important;
  }
  .flow-card--lost {
    border-color: color-mix(in srgb, var(--destructive, #ef4444) 38%, var(--g-border)) !important;
  }
  .flow-card--promoted {
    border-color: color-mix(in srgb, var(--g-accent) 38%, var(--g-border)) !important;
  }

  .flow-card__bar {
    display: flex;
    width: 100%;
    height: 6px;
    background: var(--g-surface-strong);
    border-radius: 999px;
    overflow: hidden;
    margin-top: 4px;
  }
  .flow-card__bar-q { background: linear-gradient(90deg, color-mix(in srgb, var(--ok, #22c55e) 80%, transparent), var(--ok, #22c55e)); }
  .flow-card__bar-u { background: linear-gradient(90deg, color-mix(in srgb, var(--destructive, #ef4444) 80%, transparent), var(--destructive, #ef4444)); }
  .flow-card__bar-p { background: linear-gradient(90deg, color-mix(in srgb, var(--g-primary) 60%, transparent), var(--g-primary)); }
  .flow-card__legend {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    font-size: 10px;
    color: var(--g-fg-faint);
  }
  .flow-card__legend-item--q { color: color-mix(in srgb, var(--ok, #22c55e) 85%, var(--g-fg)); }
  .flow-card__legend-item--u { color: color-mix(in srgb, var(--destructive, #ef4444) 85%, var(--g-fg)); }
  .flow-card__legend-item--p { color: color-mix(in srgb, var(--g-primary) 85%, var(--g-fg)); }

  @media (max-width: 980px) {
    .flow-e2e__grid {
      grid-template-columns: 1fr;
    }
  }
`;

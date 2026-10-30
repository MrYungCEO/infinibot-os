import { html, nothing, type TemplateResult } from "lit";

import type { GatewayBrowserClient } from "../gateway";
import { getBizFilter } from "../lib/biz-filter";
import {
  assignAgencyFunnelGap,
  bootstrapAgencyCoreFunnel,
  checkAgencyFunnelConnection,
  checkAgencyFunnelHealth,
  closeAgencyFunnelConnectionDraft,
  getAgencyFunnelOpsState,
  loadAgencyFunnelOverview,
  openAgencyFunnelConnectionDraft,
  patchAgencyFunnelConnectionDraft,
  recordAgencyFunnelKpi,
  saveAgencyFunnelConnection,
  setAgencyFunnelGapOwner,
  setAgencyFunnelKpiDraft,
  setAgencyFunnelOpsRequestUpdate,
  type AgencyFunnelOpsState,
  type AgencyFunnelOverview,
  type AgencyFunnelSummary,
} from "../controllers/agency-funnel-ops";

export interface AgencyFunnelOpsProps {
  client?: GatewayBrowserClient;
  requestUpdate: () => void;
}

const styles = html`
  <style>
    .afop{height:100%;overflow:auto;padding:20px;color: var(--g-text,var(--glass-fg));background: radial-gradient(circle at 12% 0,color-mix(in srgb, var(--glass-gold) 4%, transparent),transparent 30%),var(--glass-3)}
    .afop-head,.afop-row{display:flex;align-items:center;justify-content:space-between;gap:12px}.afop-head h2{margin:0;font-size:20px}.afop-head p{margin:4px 0 0;color: var(--glass-fg-2);font-size:11px}.afop-btn{border: 1px solid color-mix(in srgb, var(--glass-fg) 9%, transparent);border-radius:8px;padding:8px 11px;background: var(--glass-3);color:inherit;cursor:pointer}.afop-btn.primary{background: var(--glass-gold);color: var(--glass-ink);border-color: var(--glass-gold);font-weight:700}.afop-btn:disabled{opacity:.5}
    .afop-metrics{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:10px;margin:16px 0}.afop-card{background: var(--glass-3);border: 1px solid color-mix(in srgb, var(--glass-fg) 7%, transparent);border-radius:12px;padding:14px}.afop-card>span{display:block;color: var(--glass-fg-3);font-size:9px;text-transform:uppercase;letter-spacing:.08em}.afop-card>strong{display:block;font-size:25px;margin-top:7px}.afop-grid{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(300px,.9fr);gap:12px}.afop-panel{background: var(--glass-3);border: 1px solid color-mix(in srgb, var(--glass-fg) 7%, transparent);border-radius:12px;padding:15px;margin-bottom:12px}.afop-panel h3{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color: var(--glass-fg-2);margin:0 0 12px}
    .afop-core{border: 1px solid color-mix(in srgb, var(--glass-gold) 33%, transparent);background: color-mix(in srgb, var(--glass-gold) 5%, transparent);border-radius:10px;padding:12px}.afop-subs{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:8px;margin-top:12px}.afop-funnel{background: color-mix(in srgb, var(--glass-fg) 2%, transparent);border: 1px solid color-mix(in srgb, var(--glass-fg) 5%, transparent);border-radius:9px;padding:10px}.afop-funnel strong,.afop-funnel small{display:block}.afop-funnel small{color: var(--glass-fg-3);margin-top:4px}.afop-tree-line{height:18px;width:1px;background: color-mix(in srgb, var(--glass-gold) 27%, transparent);margin:auto}
    .afop-list{display:grid;gap:7px}.afop-item{display:grid;grid-template-columns:10px minmax(0,1fr) auto;gap:9px;align-items:center;background: color-mix(in srgb, var(--glass-fg) 2%, transparent);border-radius:8px;padding:9px}.afop-dot{width:8px;height:8px;border-radius:50%;background: color-mix(in srgb, var(--glass-fg) 28%, transparent)}.afop-dot.healthy,.afop-dot.connected{background:#22c55e}.afop-dot.warning,.afop-dot.degraded,.afop-dot.configuring{background:#f59e0b}.afop-dot.critical,.afop-dot.disconnected,.afop-dot.error,.afop-dot.unhealthy{background:#ef4444}.afop-item strong{font-size:11px}.afop-item small{display:block;color: var(--glass-fg-3);margin-top:2px}.afop-badge{font-size:9px;text-transform:uppercase;padding:3px 6px;border-radius:99px;background: color-mix(in srgb, var(--glass-fg) 4%, transparent)}.afop-gap.high,.afop-gap.critical{border-left:2px solid #ef4444}.afop-gap.medium,.afop-gap.warning{border-left:2px solid #f59e0b}.afop-progress{height:5px;background: color-mix(in srgb, var(--glass-fg) 4%, transparent);border-radius:99px;overflow:hidden;margin-top:8px}.afop-progress i{display:block;height:100%;background: var(--glass-gold)}.afop-empty,.afop-error{padding:22px;text-align:center;color: var(--glass-fg-3)}.afop-error{color:#fca5a5}
    .afop-item.wide{grid-template-columns:10px minmax(0,1fr)}.afop-item-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px}.afop-item-actions input,.afop-item-actions select{font:inherit;background: color-mix(in srgb,var(--g-fg,var(--glass-fg)) 6%,transparent);color:inherit;border: 1px solid color-mix(in srgb,var(--g-fg,var(--glass-fg)) 14%,transparent);border-radius:7px;padding:5px 7px;min-width:0}.afop-item-actions input{max-width:110px}.afop-btn.compact{padding:5px 9px;font-size:11px}
    .afop-steps{display:grid;gap:6px}.afop-step{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:9px;align-items:center;background: color-mix(in srgb,var(--g-fg,var(--glass-fg)) 4%,transparent);border-radius:8px;padding:8px 10px}.afop-step b{font-size:10px;color: var(--g-muted,var(--glass-fg-2));min-width:18px}.afop-step small{display:block;color: var(--g-muted,var(--glass-fg-3));margin-top:2px}
    .afop-form{display:grid;gap:8px;margin-bottom:10px;padding:10px;border-radius:9px;border: 1px solid color-mix(in srgb,var(--g-fg,var(--glass-fg)) 14%,transparent)}.afop-form label{display:grid;gap:3px;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color: var(--g-muted,var(--glass-fg-2))}.afop-form input,.afop-form select{font:inherit;text-transform:none;letter-spacing:normal;background: color-mix(in srgb,var(--g-fg,var(--glass-fg)) 6%,transparent);color: var(--g-text,var(--glass-fg));border: 1px solid color-mix(in srgb,var(--g-fg,var(--glass-fg)) 14%,transparent);border-radius:7px;padding:6px 8px}
    .afop-notice{padding:9px 11px;border-radius:9px;font-size:11px;background: color-mix(in srgb,var(--g-fg,var(--glass-fg)) 6%,transparent);color: var(--g-muted,var(--glass-fg-2));margin-bottom:10px}.afop-notice ul{margin:5px 0 0;padding-left:16px}
    .afop :focus-visible{outline: 2px solid var(--g-primary,var(--glass-gold));outline-offset:2px}
    @media(max-width:950px){.afop-grid{grid-template-columns:1fr}.afop-metrics{grid-template-columns:repeat(2,1fr)}}@media(max-width:560px){.afop{padding:12px}.afop-head{align-items:flex-start;flex-direction:column}.afop-metrics{grid-template-columns:1fr 1fr}}
  </style>
`;

function funnelCard(funnel: AgencyFunnelSummary): TemplateResult {
  return html`
    <div class="afop-funnel">
      <div class="afop-row">
        <strong>${funnel.name}</strong>
        <span class="afop-dot ${funnel.health}"></span>
      </div>
      <small>${funnel.status} · ${funnel.leads ?? 0} leads</small>
      <div class="afop-progress"><i style=${`width:${Math.max(0, Math.min(100, funnel.conversionRate ?? 0))}%`}></i></div>
    </div>
  `;
}

/**
 * The journey steps and their transitions. `nodes`/`edges` were already fetched
 * and normalized but never drawn, so the "authoritative map" showed only the
 * funnel names and none of the actual steps operators are asked to complete.
 */
function renderJourneySteps(overview: AgencyFunnelOverview): TemplateResult {
  if (!overview.nodes.length) {
    return html`<div class="afop-empty">No journey steps defined on this funnel yet.</div>`;
  }
  const nameById = new Map(overview.nodes.map((node) => [node.id, node.name]));
  const outgoing = new Map<string, string[]>();
  for (const edge of overview.edges) {
    const targets = outgoing.get(edge.sourceNodeId) ?? [];
    targets.push(nameById.get(edge.targetNodeId) ?? "an unmapped step");
    outgoing.set(edge.sourceNodeId, targets);
  }
  return html`
    <div class="afop-steps">
      ${overview.nodes.map((node, index) => {
        const next = outgoing.get(node.id) ?? [];
        return html`
          <div class="afop-step">
            <b>${index + 1}</b>
            <div>
              <strong>${node.name}</strong>
              <small>
                ${node.kind} · ${node.status}
                ${next.length ? ` → ${next.join(", ")}` : " · terminal step"}
              </small>
            </div>
            <span class="afop-dot ${node.health}" title=${node.health}></span>
          </div>
        `;
      })}
    </div>
  `;
}

/** Create/edit form for a funnel integration. */
function renderConnectionForm(
  state: AgencyFunnelOpsState,
  props: AgencyFunnelOpsProps,
): TemplateResult {
  const draft = state.connectionDraft;
  if (!draft) return html``;
  const valid = draft.provider.trim().length > 0 && draft.connectionKey.trim().length > 0;
  return html`
    <form
      class="afop-form"
      aria-label=${draft.id ? "Edit funnel connection" : "Add funnel connection"}
      @submit=${(event: Event) => {
        event.preventDefault();
        if (valid && props.client) void saveAgencyFunnelConnection(props.client);
      }}
    >
      <label>Provider
        <input
          .value=${draft.provider}
          placeholder="e.g. stripe, ghl, resend"
          aria-label="Connection provider"
          @input=${(event: Event) =>
            patchAgencyFunnelConnectionDraft({
              provider: (event.target as HTMLInputElement).value,
            })}
        />
      </label>
      <label>Connection key
        <input
          .value=${draft.connectionKey}
          placeholder="What this connection is used for"
          aria-label="Connection key"
          @input=${(event: Event) =>
            patchAgencyFunnelConnectionDraft({
              connectionKey: (event.target as HTMLInputElement).value,
            })}
        />
      </label>
      <label>Status
        <select
          aria-label="Connection status"
          .value=${draft.status}
          @change=${(event: Event) =>
            patchAgencyFunnelConnectionDraft({
              status: (event.target as HTMLSelectElement)
                .value as typeof draft.status,
            })}
        >
          <option value="disconnected">Disconnected</option>
          <option value="configuring">Configuring</option>
          <option value="connected">Connected</option>
          <option value="degraded">Degraded</option>
          <option value="error">Error</option>
        </select>
      </label>
      <div class="afop-row">
        <button type="button" class="afop-btn compact" @click=${closeAgencyFunnelConnectionDraft}>
          Cancel
        </button>
        <button class="afop-btn primary compact" ?disabled=${!valid || state.busyId !== null}>
          ${state.busyId ? "Saving…" : draft.id ? "Save connection" : "Add connection"}
        </button>
      </div>
    </form>
  `;
}

export function renderAgencyFunnelOps(props: AgencyFunnelOpsProps): TemplateResult {
  const state = getAgencyFunnelOpsState();
  setAgencyFunnelOpsRequestUpdate(props.requestUpdate);
  if (props.client && state.agencyId !== getBizFilter() && !state.loading) {
    queueMicrotask(() => void loadAgencyFunnelOverview(props.client!));
  }
  const overview = state.overview;
  return html`
    ${styles}
    <section class="afop">
      <header class="afop-head">
        <div>
          <h2>Live Agency Funnel System</h2>
          <p>One core journey, connected sub-funnels, setup health, KPIs and agent-readable operating gaps.</p>
        </div>
        <div>
          <button class="afop-btn" ?disabled=${state.loading || !props.client} @click=${() => props.client && void loadAgencyFunnelOverview(props.client,{force:true})}>Refresh</button>
          <button class="afop-btn primary" ?disabled=${state.checking || !props.client} @click=${() => props.client && void checkAgencyFunnelHealth(props.client)}>${state.checking ? "Checking…" : "Run health checks"}</button>
        </div>
      </header>
      ${state.error ? html`<div class="afop-error">${state.error}</div>` : nothing}
      ${
        state.failedRequests.length
          ? html`<div class="afop-notice" role="status">
              <strong>${state.failedRequests.length} request${state.failedRequests.length === 1 ? "" : "s"} failed.</strong>
              What is shown below may be incomplete.
              <ul>${state.failedRequests.map((entry) => html`<li>${entry}</li>`)}</ul>
            </div>`
          : nothing
      }
      ${state.notice ? html`<div class="afop-notice" role="status">${state.notice}</div>` : nothing}
      ${state.loading && !overview
        ? html`<div class="afop-empty">Loading the authoritative funnel map…</div>`
        : overview
          ? html`
              <div class="afop-metrics">
                <div class="afop-card"><span>System health</span><strong>${overview.healthScore}%</strong><div class="afop-progress"><i style=${`width:${overview.healthScore}%`}></i></div></div>
                <div class="afop-card"><span>Setup complete</span><strong>${overview.setupPercent}%</strong><div class="afop-progress"><i style=${`width:${overview.setupPercent}%`}></i></div></div>
                <div class="afop-card"><span>Active sub-funnels</span><strong>${overview.subFunnels.length}</strong></div>
                <div class="afop-card"><span>Open gaps</span><strong>${overview.gaps.length}</strong></div>
              </div>
              <div class="afop-grid">
                <div>
                  <section class="afop-panel">
                    <h3>Authoritative core and sub-funnel map</h3>
                    ${overview.coreFunnel
                      ? html`
                          <div class="afop-core">${funnelCard(overview.coreFunnel)}</div>
                          <div class="afop-tree-line"></div>
                          <div class="afop-subs">${overview.subFunnels.map(funnelCard)}</div>
                        `
                      : html`
                          <div class="afop-empty">
                            <p>No core funnel configured. Create the agency's primary customer journey first.</p>
                            <button class="afop-btn primary" ?disabled=${state.checking || !props.client}
                              @click=${() => props.client && void bootstrapAgencyCoreFunnel(props.client)}>
                              Create core funnel
                            </button>
                          </div>
                        `}
                  </section>
                  <section class="afop-panel">
                    <h3>Journey steps and transitions</h3>
                    ${renderJourneySteps(overview)}
                  </section>
                  <section class="afop-panel">
                    <h3>Live KPI board</h3>
                    <div class="afop-list">
                      ${overview.kpis.length
                        ? overview.kpis.map((kpi) => {
                            const draft = state.kpiDrafts[kpi.id] ?? "";
                            return html`
                            <div class="afop-item wide">
                              <span class="afop-dot ${kpi.status ?? "unknown"}"></span>
                              <div>
                                <div class="afop-row">
                                  <strong>${kpi.name}</strong>
                                  <b>${kpi.value ?? "—"} ${kpi.unit ?? ""}</b>
                                </div>
                                <small>Target ${kpi.target ?? "—"} ${kpi.unit ?? ""}</small>
                                <div class="afop-item-actions">
                                  <input
                                    type="number"
                                    step="any"
                                    placeholder="New reading"
                                    aria-label=${`Record a new reading for ${kpi.name}`}
                                    .value=${draft}
                                    @input=${(event: Event) =>
                                      setAgencyFunnelKpiDraft(
                                        kpi.id,
                                        (event.target as HTMLInputElement).value,
                                      )}
                                  />
                                  <button
                                    class="afop-btn compact"
                                    aria-label=${`Save the new reading for ${kpi.name}`}
                                    ?disabled=${!props.client || state.busyId !== null || draft.trim() === ""}
                                    @click=${() =>
                                      props.client && void recordAgencyFunnelKpi(props.client, kpi.id)}
                                  >${state.busyId === kpi.id ? "Recording…" : "Record"}</button>
                                </div>
                              </div>
                            </div>`;
                          })
                        : html`<div class="afop-empty">No KPI readings yet.</div>`}
                    </div>
                  </section>
                </div>
                <div>
                  <section class="afop-panel">
                    <div class="afop-row">
                      <h3>Connection and setup health</h3>
                      <button
                        class="afop-btn compact"
                        aria-label="Add a funnel integration"
                        ?disabled=${!props.client || state.busyId !== null}
                        @click=${() => openAgencyFunnelConnectionDraft()}
                      >+ Connection</button>
                    </div>
                    ${renderConnectionForm(state, props)}
                    <div class="afop-list">
                      ${overview.connections.length
                        ? overview.connections.map((connection) => html`
                            <div class="afop-item wide">
                              <span class="afop-dot ${connection.status}"></span>
                              <div>
                                <div class="afop-row">
                                  <strong>${connection.name}</strong>
                                  <span class="afop-badge">${connection.required ? "required" : "optional"}</span>
                                </div>
                                <small>${connection.message ?? connection.kind}</small>
                                <div class="afop-item-actions">
                                  <button
                                    class="afop-btn compact"
                                    aria-label=${`Run a live health check on the ${connection.name} connection`}
                                    ?disabled=${!props.client || state.busyId !== null}
                                    @click=${() =>
                                      props.client &&
                                      void checkAgencyFunnelConnection(props.client, connection.id)}
                                  >${state.busyId === connection.id ? "Checking…" : "Check"}</button>
                                  <button
                                    class="afop-btn compact"
                                    aria-label=${`Edit the ${connection.name} connection`}
                                    ?disabled=${state.busyId !== null}
                                    @click=${() => openAgencyFunnelConnectionDraft(connection)}
                                  >Edit</button>
                                  ${connection.lastCheckedAt
                                    ? html`<small>checked ${new Date(connection.lastCheckedAt).toLocaleString()}</small>`
                                    : html`<small>never checked</small>`}
                                </div>
                              </div>
                            </div>`)
                        : html`<div class="afop-empty">No integrations declared.</div>`}
                    </div>
                  </section>
                  <section class="afop-panel">
                    <h3>Operator and agent gap queue</h3>
                    <div class="afop-list">
                      ${overview.gaps.length
                        ? overview.gaps.map((gap) => {
                            const owner = state.gapOwners[gap.id] ?? "";
                            return html`
                            <div class="afop-item afop-gap wide ${gap.severity}">
                              <span class="afop-dot ${gap.severity === "critical" || gap.severity === "high" ? "critical" : "warning"}"></span>
                              <div>
                                <div class="afop-row">
                                  <strong>${gap.title}</strong>
                                  <span class="afop-badge">${gap.severity}</span>
                                </div>
                                <small>${gap.recommendedAction ?? gap.description ?? "Close this funnel readiness gap."}</small>
                                <div class="afop-item-actions">
                                  <select
                                    aria-label=${`Choose the employee who owns "${gap.title}"`}
                                    .value=${owner}
                                    @change=${(event: Event) =>
                                      setAgencyFunnelGapOwner(
                                        gap.id,
                                        (event.target as HTMLSelectElement).value,
                                      )}
                                  >
                                    <option value="">Choose an owner…</option>
                                    ${state.workers.map(
                                      (worker) => html`<option value=${worker.id}>
                                        ${worker.name} · ${worker.kind === "ai" ? "AI" : "Human"}
                                      </option>`,
                                    )}
                                  </select>
                                  <button
                                    class="afop-btn compact"
                                    aria-label=${`Assign "${gap.title}" to the chosen employee`}
                                    ?disabled=${!props.client || !owner || state.busyId !== null}
                                    @click=${() =>
                                      props.client && void assignAgencyFunnelGap(props.client, gap)}
                                  >${state.busyId === gap.id ? "Assigning…" : "Assign owner"}</button>
                                </div>
                                ${state.workers.length
                                  ? nothing
                                  : html`<small>No active employees to assign. Add one in Employees first.</small>`}
                              </div>
                            </div>`;
                          })
                        : html`<div class="afop-empty">No detected operating gaps.</div>`}
                    </div>
                  </section>
                </div>
              </div>
            `
          : html`<div class="afop-empty">Select an agency to inspect its funnel system.</div>`}
    </section>
  `;
}

/**
 * Network Management View
 * Multi-instance federation UI for Infinibot Network
 */

import { html, nothing, render as litRender } from "lit";
import {
  ensureSystemGlass,
  sgAurora,
  sgChip,
  sgEmpty,
  sgHero,
  sgIcon,
  sgSkeleton,
  type SgTone,
} from "./system-glass";
import type { GatewayBrowserClient } from "../gateway";
import {
  type NetworkState,
  type NetworkInstance,
  createNetworkState,
  loadNetworkState,
  addInstance,
  removeInstance,
  updateInstance,
  setActiveInstance,
  checkInstanceStatus,
  showAddInstanceDialog,
  hideAddInstanceDialog,
  updateAddInstanceForm,
  assignProjectToInstance,
} from "../controllers/network";

// ── Styles ────────────────────────────────────────────────────────────────
// Glass G7: the page uses the shared system-glass kit (sg-*) and only adds the
// network-specific layer here (`nw-*`). Tokens only, so light theme, reduced
// motion / transparency and palette changes follow automatically.

export const networkStyles = html`
<style>
  .sg-page.sg-network {
    padding: clamp(14px, 2vw, 22px);
    gap: 16px;
    max-width: none;
  }
  /* Setup's content panel already blurs; one backdrop-filter per stack. */
  .sg-network .sg-hero {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    padding: clamp(18px, 2.2vw, 26px);
  }
  .sg-network .sg-title { font-size: clamp(22px, 2.4vw, 30px); }
  .sg-network .sg-stats { grid-template-columns: repeat(auto-fit, minmax(min(140px, 100%), 1fr)); }

  .nw-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr));
    gap: 14px;
    min-width: 0;
  }

  /* Instance card */
  .nw-card {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px;
  }
  .nw-card:hover {
    transform: var(--glass-lift, translateY(-1px));
    box-shadow: var(--glass-elev-2), var(--glass-glow-soft, none);
  }
  .nw-card.current::before { background: var(--glass-edge, var(--glass-stroke-gold)); }
  .nw-card.active {
    box-shadow:
      var(--glass-elev-2),
      0 0 0 1px color-mix(in srgb, var(--sg-ok) 38%, transparent),
      0 14px 40px -20px color-mix(in srgb, var(--sg-ok) 55%, transparent);
  }
  .nw-card__head { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
  .nw-card__icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: 13px;
    color: var(--sg-fg-2);
    background: var(--glass-hover, rgba(255, 255, 255, 0.05));
    box-shadow: inset 0 0 0 1px var(--glass-stroke, rgba(255, 255, 255, 0.08));
  }
  .nw-card.current .nw-card__icon {
    color: var(--sg-gold);
    background: var(--glass-gold-tint, var(--glass-gold-a10));
    box-shadow: inset 0 0 0 1px var(--glass-stroke-gold), var(--glass-glow-soft, none);
  }
  .nw-card__id { flex: 1; min-width: 0; }
  .nw-card__name {
    margin: 0 0 3px;
    color: var(--sg-fg);
    font-size: 15px;
    font-weight: 640;
    letter-spacing: -0.012em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nw-card__url {
    display: block;
    color: var(--sg-fg-3);
    font-family: var(--glass-font-mono, ui-monospace, monospace);
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nw-card .sg-chip { text-transform: capitalize; }
  .nw-chips { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
  .nw-chips .sg-chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }

  .nw-facts {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 8px 14px;
    margin: 0;
    padding: 12px 14px;
    border-radius: var(--sg-radius-sm);
    background: color-mix(in srgb, var(--glass-base, #07070a) 28%, transparent);
    box-shadow: inset 0 0 0 1px var(--glass-stroke, rgba(255, 255, 255, 0.08));
    font-size: 12.5px;
  }
  :root[data-theme="light"] .nw-facts { background: color-mix(in srgb, #fff 55%, transparent); }
  .nw-facts dt {
    color: var(--sg-fg-3);
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    align-self: center;
  }
  .nw-facts dd { margin: 0; color: var(--sg-fg); min-width: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .nw-facts .nw-err dt, .nw-facts .nw-err dd { color: var(--sg-bad); }
  .nw-facts .nw-err { display: contents; }

  .nw-actions {
    display: flex;
    gap: 8px;
    margin-top: auto;
    padding-top: 14px;
    border-top: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.08));
  }
  .nw-actions .nw-connect { flex: 1 1 auto; }
  .nw-connect.is-active {
    color: var(--sg-ok);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-ok) 40%, transparent);
    background: color-mix(in srgb, var(--sg-ok) 10%, transparent);
  }

  /* Add-instance tile */
  .nw-add {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    min-height: 220px;
    padding: 20px;
    border: 1.5px dashed var(--glass-stroke-gold, rgba(217, 180, 95, 0.28));
    border-radius: var(--sg-radius-md);
    background: transparent;
    color: var(--sg-fg-2);
    font: inherit;
    cursor: pointer;
    transition: background var(--sg-dur) var(--sg-ease), border-color var(--sg-dur) var(--sg-ease), transform var(--sg-dur) var(--sg-spring);
  }
  .nw-add:hover {
    border-color: var(--sg-gold);
    background: var(--glass-gold-a06);
    color: var(--sg-fg);
    transform: var(--glass-lift, translateY(-1px));
  }
  .nw-add__icon {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border-radius: 15px;
    color: var(--sg-gold);
    background: var(--glass-gold-a10);
    box-shadow: inset 0 0 0 1px var(--glass-gold-a24);
    transition: transform var(--sg-dur) var(--sg-spring);
  }
  .nw-add:hover .nw-add__icon { transform: scale(1.06) rotate(90deg); }
  .nw-add__title { color: var(--sg-fg); font-size: 14px; font-weight: 620; }
  .nw-add__sub { color: var(--sg-fg-3); font-size: 12px; max-width: 240px; text-align: center; line-height: 1.5; }

  /* Add-instance sheet (portalled to <body> so Setup's blurred panel can't trap it) */
  .sg-page.nw-portal {
    position: fixed;
    inset: 0;
    z-index: 2000;
    display: block;
    max-width: none;
    margin: 0;
    pointer-events: none;
  }
  .nw-portal .sg-backdrop { pointer-events: auto; z-index: 0; }
  .nw-sheet { width: min(500px, 100%); padding: 0; }
  .nw-sheet__head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 20px 22px 16px;
    border-bottom: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.08));
  }
  .nw-sheet__icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 12px;
    color: var(--sg-gold);
    background: var(--glass-gold-a10);
    box-shadow: inset 0 0 0 1px var(--glass-gold-a24);
  }
  .nw-sheet__title { flex: 1; margin: 0; font-size: 17px; font-weight: 650; letter-spacing: -0.015em; }
  .nw-sheet__body { display: grid; gap: 16px; padding: 20px 22px; }
  .nw-field { display: grid; gap: 7px; }
  .nw-field label {
    color: var(--sg-fg-3);
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .nw-hint { color: var(--sg-fg-3); font-size: 12px; line-height: 1.45; }
  .nw-alert {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 11px 14px;
    border-radius: var(--sg-radius-sm);
    color: var(--sg-bad);
    font-size: 13px;
    background: color-mix(in srgb, var(--sg-bad) 10%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sg-bad) 28%, transparent);
  }
  .nw-alert .sg-ico { flex: none; margin-top: 1px; }
  .nw-sheet__foot {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 10px;
    padding: 14px 22px 20px;
    border-top: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.08));
  }
  .nw-spin { animation: nw-spin 0.9s linear infinite; }
  @keyframes nw-spin { to { transform: rotate(360deg); } }

  @media (max-width: 720px) {
    .sg-page.sg-network { padding: 14px; }
    .nw-card { padding: 15px; }
    .nw-add { min-height: 150px; }
    .nw-sheet__foot > .sg-btn { flex: 1 1 auto; }
  }
  @media (prefers-reduced-motion: reduce) {
    .nw-card, .nw-add, .nw-add__icon { transition: none !important; }
    .nw-add:hover .nw-add__icon { transform: none; }
    .nw-spin { animation: none; }
  }
</style>
`;

// ── Render Functions ──────────────────────────────────────────────────────

const STATUS_TONE: Record<NetworkInstance["status"], SgTone> = {
  online: "ok",
  offline: "bad",
  connecting: "warn",
  error: "bad",
};

function renderInstanceCard(
  instance: NetworkInstance,
  isActive: boolean,
  handlers: {
    onConnect: (id: string) => void;
    onRemove: (id: string) => void;
    onRefresh: (id: string) => void;
  }
) {
  const tone = STATUS_TONE[instance.status] ?? "off";
  const chipTone = tone === "off" ? undefined : (tone as Exclude<SgTone, "off" | "info">);

  return html`
    <article class="sg-card sg-enter nw-card instance-card ${instance.isCurrent ? "current" : ""} ${isActive ? "active" : ""}">
      <div class="nw-card__head">
        <span class="nw-card__icon">${sgIcon(instance.isCurrent ? "cpu" : "server", 20)}</span>
        <div class="nw-card__id">
          <h4 class="nw-card__name" title=${instance.name}>${instance.name}</h4>
          <span class="nw-card__url" title=${instance.url}>${instance.url}</span>
        </div>
        ${sgChip(instance.status, chipTone, true)}
      </div>

      <div class="nw-chips">
        ${instance.isCurrent ? sgChip("This Device", "gold") : nothing}
        ${sgChip(instance.role)}
        ${instance.agents.map((a) => sgChip(html`${sgIcon("spark", 11)}${a}`))}
      </div>

      <dl class="nw-facts">
        <dt>Projects</dt>
        <dd>${instance.projects.length || "None assigned"}</dd>
        <dt>Last seen</dt>
        <dd>${instance.lastSeen ? new Date(instance.lastSeen).toLocaleString() : "Never"}</dd>
        ${instance.lastError ? html`
          <div class="nw-err">
            <dt>Error</dt>
            <dd>${instance.lastError}</dd>
          </div>
        ` : nothing}
      </dl>

      <div class="nw-actions">
        <button
          class="sg-btn nw-connect ${isActive ? "is-active" : "sg-btn--primary"}"
          @click=${() => handlers.onConnect(instance.id)}
          ?disabled=${instance.status === "offline"}
        >
          ${isActive ? html`${sgIcon("check", 15)} Connected` : html`${sgIcon("link", 15)} Connect`}
        </button>
        <button
          class="sg-btn sg-btn--icon"
          @click=${() => handlers.onRefresh(instance.id)}
          title="Refresh status"
          aria-label="Refresh status of ${instance.name}"
        >
          ${sgIcon("refresh", 15)}
        </button>
        ${!instance.isCurrent ? html`
          <button
            class="sg-btn sg-btn--icon sg-btn--danger"
            @click=${() => handlers.onRemove(instance.id)}
            title="Remove instance"
            aria-label="Remove ${instance.name}"
          >
            ${sgIcon("trash", 15)}
          </button>
        ` : nothing}
      </div>
    </article>
  `;
}

function renderAddInstanceDialog(
  state: NetworkState,
  handlers: {
    onClose: () => void;
    onSubmit: () => void;
    onFieldChange: (field: "name" | "url" | "token", value: string) => void;
  }
) {
  if (!state.showAddInstance) return nothing;

  return html`
    <div class="sg-page nw-portal">
      <div class="sg-backdrop" @click=${handlers.onClose}>
        <div
          class="sg-sheet nw-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nw-add-title"
          @click=${(e: Event) => e.stopPropagation()}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") handlers.onClose(); }}
        >
          <div class="nw-sheet__head">
            <span class="nw-sheet__icon">${sgIcon("plus", 18)}</span>
            <h3 class="nw-sheet__title" id="nw-add-title">Add Instance</h3>
            <button class="sg-btn sg-btn--ghost sg-btn--icon" aria-label="Close" @click=${handlers.onClose}>
              ${sgIcon("close", 16)}
            </button>
          </div>
          <div class="nw-sheet__body">
            ${state.error ? html`
              <div class="nw-alert" role="alert">${sgIcon("alert", 15)}<span>${state.error}</span></div>
            ` : nothing}

            <div class="nw-field">
              <label for="nw-f-name">Instance Name</label>
              <input
                id="nw-f-name"
                class="sg-input"
                type="text"
                placeholder="e.g., MacBook Pro, Work Server"
                .value=${state.addInstanceForm.name}
                @input=${(e: Event) => handlers.onFieldChange("name", (e.target as HTMLInputElement).value)}
              />
            </div>

            <div class="nw-field">
              <label for="nw-f-url">Gateway URL</label>
              <input
                id="nw-f-url"
                class="sg-input sg-mono"
                type="text"
                placeholder="e.g., 192.168.1.100:47913 or my-server.tailnet.ts.net:47913"
                .value=${state.addInstanceForm.url}
                @input=${(e: Event) => handlers.onFieldChange("url", (e.target as HTMLInputElement).value)}
              />
              <div class="nw-hint">The URL where the other InfiniBot gateway is running</div>
            </div>

            <div class="nw-field">
              <label for="nw-f-token">Gateway Token</label>
              <input
                id="nw-f-token"
                class="sg-input"
                type="password"
                placeholder="Enter the gateway password/token"
                .value=${state.addInstanceForm.token}
                @input=${(e: Event) => handlers.onFieldChange("token", (e.target as HTMLInputElement).value)}
              />
              <div class="nw-hint">Found in the other instance's Setup → Install & Connect</div>
            </div>
          </div>
          <div class="nw-sheet__foot">
            <button class="sg-btn sg-btn--ghost" @click=${handlers.onClose}>Cancel</button>
            <button
              class="sg-btn sg-btn--primary"
              @click=${handlers.onSubmit}
              ?disabled=${state.connecting || !state.addInstanceForm.url}
            >
              ${state.connecting
                ? html`<span class="nw-spin">${sgIcon("refresh", 15)}</span> Connecting...`
                : html`${sgIcon("plus", 15)} Add Instance`}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * The add dialog is rendered into a <body>-level host: Setup's content panel
 * uses backdrop-filter + overflow:hidden, which would otherwise become the
 * containing block for the fixed backdrop and clip the sheet to the panel.
 */
let portalHost: HTMLDivElement | null = null;
function renderDialogPortal(tpl: ReturnType<typeof renderAddInstanceDialog>): void {
  if (typeof document === "undefined") return;
  if (tpl === nothing) {
    if (portalHost) litRender(nothing, portalHost);
    return;
  }
  if (!portalHost || !portalHost.isConnected) {
    portalHost = document.createElement("div");
    portalHost.dataset.networkDialog = "";
    document.body.appendChild(portalHost);
  }
  const host = portalHost;
  const wasEmpty = !host.firstElementChild;
  litRender(tpl, host);
  if (wasEmpty) queueMicrotask(() => host.querySelector<HTMLInputElement>("input")?.focus());
}

// ── Main Render ───────────────────────────────────────────────────────────

export function renderNetworkSection(
  state: NetworkState,
  handlers: {
    onConnect: (id: string) => void;
    onRemove: (id: string) => void;
    onRefresh: (id: string) => void;
    onShowAdd: () => void;
    onHideAdd: () => void;
    onAddSubmit: () => void;
    onFieldChange: (field: "name" | "url" | "token", value: string) => void;
  }
) {
  ensureSystemGlass();
  const total = state.instances.length;
  const onlineCount = state.instances.filter(i => i.status === "online").length;
  const totalAgents = state.instances.reduce((sum, i) => sum + i.agents.length, 0);
  const totalProjects = state.instances.reduce((sum, i) => sum + i.projects.length, 0);
  const loading = state.loading && total === 0;

  const status: { tone: SgTone; label: string } = loading
    ? { tone: "gold", label: "Discovering" }
    : total === 0
      ? { tone: "off", label: "No instances" }
      : onlineCount === total
        ? { tone: "ok", label: total === 1 ? "Online" : "All online" }
        : { tone: onlineCount === 0 ? "bad" : "warn", label: `${onlineCount}/${total} online` };

  renderDialogPortal(renderAddInstanceDialog(state, {
    onClose: handlers.onHideAdd,
    onSubmit: handlers.onAddSubmit,
    onFieldChange: handlers.onFieldChange,
  }));

  return html`
    ${networkStyles}
    <div class="sg-page sg-network network-section">
      ${sgAurora()}
      ${sgHero({
        eyebrow: "Setup · Network",
        title: "InfiniBot",
        accent: "Network",
        icon: "network",
        sub: "Link the InfiniBot gateways on your other machines into one network, then switch which instance this console drives.",
        status,
        actions: html`
          <button class="sg-btn sg-btn--primary" @click=${handlers.onShowAdd}>
            ${sgIcon("plus", 15)} Add Instance
          </button>
        `,
        stats: [
          { label: "Instances", value: total, icon: "server", tone: "gold" },
          {
            label: "Online",
            value: onlineCount,
            icon: "activity",
            tone: total > 0 && onlineCount === total ? "ok" : onlineCount < total ? "warn" : undefined,
            meter: total ? onlineCount / total : 0,
            meterKind: "health",
          },
          { label: "Agents", value: totalAgents, icon: "users" },
          { label: "Projects", value: totalProjects, icon: "layers" },
        ],
      })}

      <div>
        <div class="sg-section-head">Instances <span class="sg-count">${total}</span></div>
        ${loading
          ? html`<div class="nw-grid">${[0, 1].map(() => html`<div class="sg-card nw-card">${sgSkeleton(4)}</div>`)}</div>`
          : total === 0
            ? html`<div class="sg-card">${sgEmpty({
                icon: "network",
                title: "No instances yet",
                body: "Add the gateway URL and token of another InfiniBot machine to start building your network.",
                action: html`<button class="sg-btn sg-btn--primary" @click=${handlers.onShowAdd}>${sgIcon("plus", 15)} Add your first instance</button>`,
              })}</div>`
            : html`
              <div class="nw-grid instance-grid">
                ${state.instances.map(instance =>
                  renderInstanceCard(
                    instance,
                    instance.id === state.activeInstanceId,
                    handlers
                  )
                )}
                <button class="nw-add add-instance-card" @click=${handlers.onShowAdd}>
                  <span class="nw-add__icon">${sgIcon("plus", 22)}</span>
                  <span class="nw-add__title">Add another instance</span>
                  <span class="nw-add__sub">Connect a gateway on your LAN or tailnet</span>
                </button>
              </div>
            `}
      </div>
    </div>
  `;
}

export default renderNetworkSection;

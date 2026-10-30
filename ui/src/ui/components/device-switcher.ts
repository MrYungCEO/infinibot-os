/**
 * <ib-device-switcher> — pick any window on any federation node and drive it.
 *
 * Lists every connected node (online, version, round-trip latency, UI-control
 * protocol) with its InfiniBot windows (codename/label, route, focus, last
 * seen). For the selected window: navigate it to a screen, preview its live
 * screen, mirror it into this or another window, or — when the node runs an
 * older build — start the existing federation update for that node.
 *
 * Rendered in the Network Hub (Federation dashboard) and in the top-bar
 * Devices popover, so it is reachable from Grid and every other page.
 */

import { LitElement, css, html, nothing } from "lit";

import {
  listFederationWindows,
  mirrorWindow,
  navigateWindow,
  routeChoices,
  screenshotWindow,
  timeAgo,
  updateNode,
  addressArgs,
  type FedListing,
  type FedNode,
  type FedWindow,
} from "../federation-ui-control";
import { getGatewayClient } from "../gateway-client";
import { icons } from "../icons";
import { openRemoteScreen } from "./remote-screen";

const REFRESH_MS = 10_000;
/** Windows shown per node before "+N more" (a busy master can hold dozens of stale tabs). */
const WINDOWS_PER_NODE = 6;

/** Focused first, then most recently seen. */
function rankWindows(wins: FedWindow[]): FedWindow[] {
  return [...wins].sort(
    (a, b) => Number(Boolean(b.focused)) - Number(Boolean(a.focused)) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0),
  );
}

function winKey(w: FedWindow): string {
  return `${w.node}::${w.connId}`;
}

export class IbDeviceSwitcher extends LitElement {
  static properties = {
    compact: { type: Boolean, reflect: true },
    _listing: { state: true },
    _loading: { state: true },
    _error: { state: true },
    _selected: { state: true },
    _route: { state: true },
    _mirrorTo: { state: true },
    _status: { state: true },
    _preview: { state: true },
    _busy: { state: true },
    _expandedNodes: { state: true },
  };

  compact = false;
  private _listing: FedListing | null = null;
  private _loading = false;
  private _error = "";
  private _selected = "";
  private _route = "";
  private _mirrorTo = "";
  private _status: { tone: "ok" | "bad" | "info"; text: string } | null = null;
  private _preview = "";
  private _busy = false;
  private _expandedNodes = new Set<string>();
  private timer: number | undefined;

  static styles = css`
    :host {
      display: block;
      font-family: var(--glass-font, system-ui, sans-serif);
      color: var(--glass-fg, #f4f1ea);
      --ds-gold: var(--glass-gold, #d9b45f);
      --ds-stroke: var(--glass-stroke, rgba(255, 255, 255, 0.09));
    }
    .panel {
      border-radius: 18px;
      padding: 14px;
      background: var(--glass-sheen, none), var(--glass-2, rgba(22, 20, 17, 0.62));
      backdrop-filter: var(--glass-blur, blur(20px));
      -webkit-backdrop-filter: var(--glass-blur, blur(20px));
      border: 1px solid var(--glass-stroke-gold, rgba(217, 180, 95, 0.26));
    }
    .head {
      display: flex;
      align-items: center;
      gap: 9px;
      margin-bottom: 10px;
    }
    .head h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.01em;
      flex: 1;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .head h3 span {
      color: var(--ds-gold);
    }
    .sub {
      font-size: 11.5px;
      color: rgba(244, 241, 234, 0.55);
    }
    button,
    select {
      font: inherit;
      font-size: 12.5px;
      color: inherit;
      background: var(--glass-3, rgba(255, 255, 255, 0.06));
      border: 1px solid var(--ds-stroke);
      border-radius: 10px;
      padding: 6px 10px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    button:hover:not(:disabled) {
      border-color: rgba(217, 180, 95, 0.55);
    }
    button:disabled {
      opacity: 0.45;
      cursor: default;
    }
    button.primary {
      background: linear-gradient(180deg, rgba(217, 180, 95, 0.95), rgba(176, 140, 60, 0.95));
      color: #17130b;
      border-color: transparent;
      font-weight: 600;
    }
    .nodes {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 10px;
    }
    :host([compact]) .nodes {
      grid-template-columns: 1fr;
      max-height: 46vh;
      overflow: auto;
    }
    .node {
      border-radius: 14px;
      border: 1px solid var(--ds-stroke);
      background: rgba(255, 255, 255, 0.025);
      padding: 10px;
    }
    .node.offline {
      opacity: 0.6;
    }
    .node-top {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .node-name {
      font-weight: 600;
      font-size: 13px;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .led {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #4ade80;
      box-shadow: 0 0 8px rgba(74, 222, 128, 0.8);
      flex-shrink: 0;
    }
    .led.off {
      background: #f87171;
      box-shadow: none;
    }
    .led.warn {
      background: #fbbf24;
      box-shadow: 0 0 8px rgba(251, 191, 36, 0.7);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin: 7px 0 8px;
    }
    .chip {
      font-size: 10.5px;
      padding: 2px 7px;
      border-radius: 999px;
      border: 1px solid var(--ds-stroke);
      color: rgba(244, 241, 234, 0.72);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .chip.gold {
      color: var(--ds-gold);
      border-color: rgba(217, 180, 95, 0.4);
    }
    .chip.bad {
      color: #fca5a5;
      border-color: rgba(248, 113, 113, 0.45);
    }
    .wins {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .win {
      width: 100%;
      justify-content: flex-start;
      text-align: left;
      padding: 7px 9px;
    }
    .win[aria-pressed="true"] {
      border-color: var(--ds-gold);
      background: rgba(217, 180, 95, 0.12);
    }
    .win .label {
      font-weight: 600;
    }
    .win .route {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: rgba(244, 241, 234, 0.55);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
    }
    .win .seen {
      font-size: 10.5px;
      color: rgba(244, 241, 234, 0.45);
    }
    .focus-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--ds-gold);
    }
    .more {
      justify-content: center;
      font-size: 11.5px;
      color: var(--ds-gold);
      background: transparent;
      border-style: dashed;
    }
    .none {
      font-size: 12px;
      color: rgba(244, 241, 234, 0.5);
      padding: 4px 2px;
    }
    .actions {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--ds-stroke);
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .actions .target {
      font-size: 12.5px;
      width: 100%;
      color: rgba(244, 241, 234, 0.7);
    }
    .actions .target b {
      color: var(--ds-gold);
    }
    .status {
      margin-top: 9px;
      font-size: 12px;
      padding: 7px 10px;
      border-radius: 10px;
      border: 1px solid var(--ds-stroke);
    }
    .status.ok {
      border-color: rgba(74, 222, 128, 0.4);
      color: #bbf7d0;
    }
    .status.bad {
      border-color: rgba(248, 113, 113, 0.45);
      color: #fecaca;
    }
    .preview {
      margin-top: 10px;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid var(--ds-stroke);
      background: #050505;
    }
    .preview img {
      display: block;
      width: 100%;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(true), REFRESH_MS);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this.timer);
  }

  async refresh(quiet = false): Promise<void> {
    const client = getGatewayClient();
    if (!client || this._loading) return;
    if (!quiet) this._loading = true;
    try {
      this._listing = await listFederationWindows(client);
      this._error = "";
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    } finally {
      this._loading = false;
    }
  }

  private allWindows(): FedWindow[] {
    return this._listing?.windows ?? [];
  }

  private selectedWindow(): FedWindow | undefined {
    return this.allWindows().find((w) => winKey(w) === this._selected);
  }

  private async run(label: string, fn: () => Promise<Record<string, unknown> | unknown>): Promise<void> {
    this._busy = true;
    this._status = { tone: "info", text: `${label}…` };
    try {
      const res = (await fn()) as Record<string, unknown> | undefined;
      if (res && res.ok === false) {
        this._status = { tone: "bad", text: String(res.error ?? `${label} failed`) };
        if (res.code === "NODE_UPDATE_REQUIRED") void this.refresh(true);
        return;
      }
      const resolved = (res?.resolved as { title?: string } | undefined)?.title;
      const finalRoute = typeof res?.finalRoute === "string" ? res.finalRoute : undefined;
      this._status = { tone: "ok", text: `${label}: done${resolved ? ` · ${resolved}` : ""}${finalRoute ? ` (${finalRoute})` : ""}` };
      void this.refresh(true);
    } catch (err) {
      this._status = { tone: "bad", text: err instanceof Error ? err.message : String(err) };
    } finally {
      this._busy = false;
    }
  }

  private navigate(): void {
    const win = this.selectedWindow();
    const client = getGatewayClient();
    if (!win || !client || !this._route) return;
    void this.run(`Navigate ${win.label} on ${win.nodeName}`, () => navigateWindow(client, win, this._route));
  }

  private preview(): void {
    const win = this.selectedWindow();
    const client = getGatewayClient();
    if (!win || !client) return;
    void this.run(`Preview ${win.label}`, async () => {
      const res = await screenshotWindow(client, addressArgs(win), { maxWidth: 900, quality: 0.7 });
      const url = (res.payload as { dataUrl?: string } | undefined)?.dataUrl;
      if (url) this._preview = url;
      return res;
    });
  }

  private mirrorHere(): void {
    const win = this.selectedWindow();
    if (!win) return;
    openRemoteScreen({
      node: win.isLocal ? "local" : win.node,
      tab: win.codename,
      label: `${win.nodeName} · ${win.label}`,
    });
    this._status = { tone: "ok", text: `Showing ${win.nodeName} · ${win.label} here` };
  }

  private mirrorTo(): void {
    const source = this.selectedWindow();
    const display = this.allWindows().find((w) => winKey(w) === this._mirrorTo);
    const client = getGatewayClient();
    if (!source || !display || !client) return;
    void this.run(`Show ${source.label} on ${display.nodeName} · ${display.label}`, () =>
      mirrorWindow(client, display, source),
    );
  }

  private startNodeUpdate(node: FedNode): void {
    const client = getGatewayClient();
    if (!client) return;
    const ok = window.confirm(
      `Update ${node.name}? That device will git pull its checkout (origin main), run npm run build and restart its gateway. Make sure the new build is pushed first.`,
    );
    if (!ok) return;
    void this.run(`Update ${node.name}`, () => updateNode(client, node.nodeId));
  }

  private visibleWindows(node: FedNode): FedWindow[] {
    const ranked = rankWindows(node.windows);
    if (this._expandedNodes.has(node.nodeId) || ranked.length <= WINDOWS_PER_NODE) return ranked;
    const shown = ranked.slice(0, WINDOWS_PER_NODE);
    // Keep the selected window visible even when it ranks low.
    const sel = ranked.find((w) => winKey(w) === this._selected);
    return sel && !shown.includes(sel) ? [...shown, sel] : shown;
  }

  private renderNode(node: FedNode) {
    const led = !node.online ? "off" : node.updateRequired ? "warn" : "";
    return html`
      <section class="node ${node.online ? "" : "offline"}" data-node=${node.nodeId}>
        <div class="node-top">
          <span class="led ${led}" title=${node.online ? "online" : "offline"}></span>
          <span class="node-name" title=${node.nodeId}>${node.name}</span>
          ${node.isLocal ? html`<span class="chip gold">this device</span>` : nothing}
        </div>
        <div class="chips">
          <span class="chip">${node.role}</span>
          ${node.version ? html`<span class="chip">v${node.version.replace(/^v/, "")}</span>` : nothing}
          ${node.latencyMs !== undefined && !node.isLocal ? html`<span class="chip">${node.latencyMs} ms</span>` : nothing}
          ${node.updateRequired ? html`<span class="chip bad">update needed</span>` : nothing}
          ${!node.online ? html`<span class="chip bad">${node.status}</span>` : nothing}
        </div>
        ${node.updateRequired
          ? html`<div class="none">${node.error ?? "This node runs an older build."}</div>
              <button @click=${() => this.startNodeUpdate(node)} ?disabled=${this._busy}>${icons.download} Update ${node.name}</button>`
          : node.error && !node.windows.length
            ? html`<div class="none">${node.error}</div>`
            : nothing}
        <div class="wins">
          ${node.windows.length === 0 && !node.error
            ? html`<div class="none">No InfiniBot window open</div>`
            : this.visibleWindows(node).map(
                (w) => html`
                  <button
                    class="win"
                    aria-pressed=${winKey(w) === this._selected ? "true" : "false"}
                    data-window=${w.codename}
                    @click=${() => {
                      this._selected = winKey(w);
                      this._preview = "";
                    }}
                  >
                    ${w.focused ? html`<span class="focus-dot" title="focused"></span>` : nothing}
                    ${icons.monitor}
                    <span class="label">${w.label}</span>
                    <span class="route">${w.route ?? ""}</span>
                    ${w.lastSeenAt ? html`<span class="seen">${timeAgo(w.lastSeenAt)}</span>` : nothing}
                  </button>
                `,
              )}
          ${node.windows.length > WINDOWS_PER_NODE
            ? html`<button
                class="more"
                @click=${() => {
                  const next = new Set(this._expandedNodes);
                  if (next.has(node.nodeId)) next.delete(node.nodeId);
                  else next.add(node.nodeId);
                  this._expandedNodes = next;
                }}
              >
                ${this._expandedNodes.has(node.nodeId) ? "Show fewer" : `+${node.windows.length - WINDOWS_PER_NODE} more windows`}
              </button>`
            : nothing}
        </div>
      </section>
    `;
  }

  private renderActions() {
    const win = this.selectedWindow();
    if (!win) return html`<div class="actions"><span class="sub">Pick a window to drive it.</span></div>`;
    const others = this.allWindows().filter((w) => winKey(w) !== winKey(win));
    return html`
      <div class="actions">
        <div class="target">Selected <b>${win.nodeName} · ${win.label}</b> ${win.route ? html`on <code>${win.route}</code>` : nothing}</div>
        <select aria-label="Screen to open" @change=${(e: Event) => (this._route = (e.target as HTMLSelectElement).value)}>
          <option value="">Choose a screen…</option>
          ${routeChoices().map((r) => html`<option value=${r.route} ?selected=${r.route === this._route}>${r.title}</option>`)}
        </select>
        <button class="primary" data-action="navigate" ?disabled=${!this._route || this._busy} @click=${() => this.navigate()}>
          ${icons.arrowRight} Navigate ${win.label}
        </button>
        <button data-action="preview" ?disabled=${this._busy} @click=${() => this.preview()}>${icons.eye} Preview</button>
        <button data-action="mirror-here" @click=${() => this.mirrorHere()}>${icons.pictureInPicture} Mirror here</button>
        ${others.length
          ? html`
              <select aria-label="Show this screen on" @change=${(e: Event) => (this._mirrorTo = (e.target as HTMLSelectElement).value)}>
                <option value="">Show on…</option>
                ${others.map((w) => html`<option value=${winKey(w)}>${w.nodeName} · ${w.label}</option>`)}
              </select>
              <button data-action="mirror-to" ?disabled=${!this._mirrorTo || this._busy} @click=${() => this.mirrorTo()}>
                ${icons.send} Show there
              </button>
            `
          : nothing}
      </div>
      ${this._preview ? html`<div class="preview"><img alt="Preview of ${win.label}" src=${this._preview} /></div>` : nothing}
    `;
  }

  render() {
    const nodes = this._listing?.nodes ?? [];
    const online = nodes.filter((n) => n.online).length;
    return html`
      <div class="panel">
        <div class="head">
          <h3>${icons.monitor} Device <span>switcher</span></h3>
          <span class="sub">${nodes.length ? `${online}/${nodes.length} nodes · ${this.allWindows().length} windows` : ""}</span>
          <button title="Refresh" ?disabled=${this._loading} @click=${() => this.refresh()}>${icons.refresh}</button>
        </div>
        ${this._error ? html`<div class="status bad">${this._error}</div>` : nothing}
        ${!this._listing && this._loading ? html`<div class="none">Looking for devices…</div>` : nothing}
        <div class="nodes">${nodes.map((n) => this.renderNode(n))}</div>
        ${this.renderActions()}
        ${this._status ? html`<div class="status ${this._status.tone}" role="status">${this._status.text}</div>` : nothing}
      </div>
    `;
  }
}

if (!customElements.get("ib-device-switcher")) customElements.define("ib-device-switcher", IbDeviceSwitcher);

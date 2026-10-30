/**
 * <ib-remote-screen> — a live view of another window's screen (on this or any
 * federation node) floating inside this window.
 *
 * Opened from the device switcher ("Mirror here") or remotely through
 * ui_control `mirror` (control-bus view `remote_screen`, op `open`), so an
 * agent on node A can put node B's screen on A's "Foxtrot" window. It polls
 * ui_control `screenshot` through this window's own gateway, which forwards
 * to the owning node; the header can navigate the mirrored window.
 */

import { LitElement, css, html, nothing } from "lit";

import { attachViewController, type RegistrationHandle } from "../control-bus";
import { routeChoices, screenshotWindow, invokeUi } from "../federation-ui-control";
import { getGatewayClient } from "../gateway-client";
import { icons } from "../icons";

type Source = { node: string; tab: string; label?: string };

const DEFAULT_INTERVAL_MS = 2_500;

export class IbRemoteScreen extends LitElement {
  static properties = {
    source: { attribute: false },
    intervalMs: { type: Number },
    _img: { state: true },
    _meta: { state: true },
    _error: { state: true },
    _paused: { state: true },
    _expanded: { state: true },
    _route: { state: true },
    _busy: { state: true },
  };

  source: Source | null = null;
  intervalMs = DEFAULT_INTERVAL_MS;
  private _img = "";
  private _meta: { route?: string; latencyMs?: number; at?: number; ms?: number } = {};
  private _error = "";
  private _paused = false;
  private _expanded = false;
  private _route = "";
  private _busy = false;
  private timer: number | undefined;
  private inflight = false;

  static styles = css`
    :host {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483000;
      width: min(46vw, 720px);
      min-width: 300px;
      font-family: var(--glass-font, system-ui, sans-serif);
      color: var(--glass-fg, #f4f1ea);
    }
    :host([expanded]) {
      inset: 4vh 4vw;
      width: auto;
    }
    .frame {
      display: flex;
      flex-direction: column;
      height: 100%;
      border-radius: 18px;
      overflow: hidden;
      background: var(--glass-sheen, none), var(--glass-2, rgba(20, 18, 15, 0.78));
      backdrop-filter: var(--glass-blur, blur(22px));
      -webkit-backdrop-filter: var(--glass-blur, blur(22px));
      border: 1px solid var(--glass-stroke-gold, rgba(217, 180, 95, 0.34));
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.04) inset;
    }
    header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 12px;
      border-bottom: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.08));
      font-size: 12.5px;
    }
    .who {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      flex: 1;
    }
    .who strong {
      color: var(--glass-gold, #d9b45f);
      font-weight: 600;
      white-space: nowrap;
    }
    .route {
      color: rgba(244, 241, 234, 0.6);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
    }
    .led {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #4ade80;
      box-shadow: 0 0 8px #4ade80;
      flex-shrink: 0;
    }
    .led.err {
      background: #f87171;
      box-shadow: 0 0 8px #f87171;
    }
    .led.paused {
      background: #fbbf24;
      box-shadow: none;
    }
    button,
    select {
      font: inherit;
      color: inherit;
      background: var(--glass-3, rgba(255, 255, 255, 0.06));
      border: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.1));
      border-radius: 9px;
      padding: 4px 7px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    button:hover {
      border-color: var(--glass-stroke-gold, rgba(217, 180, 95, 0.5));
    }
    select {
      max-width: 150px;
    }
    .screen {
      position: relative;
      background: #050505;
      aspect-ratio: 16 / 10;
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    :host([expanded]) .screen {
      aspect-ratio: auto;
    }
    img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }
    .msg {
      position: absolute;
      inset: auto 10px 10px 10px;
      font-size: 12px;
      padding: 7px 10px;
      border-radius: 10px;
      background: rgba(127, 29, 29, 0.72);
      border: 1px solid rgba(248, 113, 113, 0.45);
    }
    .empty {
      color: rgba(244, 241, 234, 0.55);
      font-size: 12.5px;
    }
    footer {
      font-size: 11px;
      color: rgba(244, 241, 234, 0.5);
      padding: 5px 12px 7px;
      display: flex;
      justify-content: space-between;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.schedule(0);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearTimeout(this.timer);
  }

  private target() {
    const src = this.source;
    if (!src) return null;
    return src.node && src.node !== "local" ? { node: src.node, tab: src.tab } : { tab: src.tab };
  }

  private schedule(ms: number): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    if (!this.isConnected) return;
    if (this._paused || document.visibilityState !== "visible") {
      this.schedule(this.intervalMs);
      return;
    }
    await this.refresh();
    this.schedule(this.intervalMs);
  }

  async refresh(): Promise<void> {
    const client = getGatewayClient();
    const target = this.target();
    if (!client || !target || this.inflight) return;
    this.inflight = true;
    const started = performance.now();
    try {
      const res = await screenshotWindow(client, target, { maxWidth: this._expanded ? 1600 : 960, quality: 0.72 });
      const payload = (res.payload ?? {}) as { dataUrl?: string; route?: string; ms?: number };
      if (res.ok === false || !payload.dataUrl) {
        this._error = String(res.error ?? "No picture from that window");
        return;
      }
      this._error = "";
      this._img = payload.dataUrl;
      this._meta = {
        route: payload.route,
        ms: payload.ms,
        at: Date.now(),
        latencyMs: typeof res.latencyMs === "number" ? res.latencyMs : Math.round(performance.now() - started),
      };
    } catch (err) {
      this._error = err instanceof Error ? err.message : String(err);
    } finally {
      this.inflight = false;
    }
  }

  private async navigateSource(): Promise<void> {
    const client = getGatewayClient();
    const target = this.target();
    if (!client || !target || !this._route) return;
    this._busy = true;
    try {
      const res = await invokeUi(client, { action: "navigate", route: this._route, ...target });
      if (res.ok === false) this._error = String(res.error ?? "Navigate failed");
      await this.refresh();
    } finally {
      this._busy = false;
    }
  }

  private toggleExpanded(): void {
    this._expanded = !this._expanded;
    this.toggleAttribute("expanded", this._expanded);
    void this.refresh();
  }

  render() {
    const src = this.source;
    if (!src) return nothing;
    const ledClass = this._error ? "err" : this._paused ? "paused" : "";
    return html`
      <div class="frame" role="dialog" aria-label="Remote screen ${src.label ?? src.tab}">
        <header>
          <div class="who">
            <span class="led ${ledClass}"></span>
            ${icons.monitor}
            <strong>${src.label ?? (src.node === "local" ? src.tab : `${src.node} · ${src.tab}`)}</strong>
            <span class="route" title=${this._meta.route ?? ""}>${this._meta.route ?? "…"}</span>
          </div>
          <select
            aria-label="Navigate the mirrored window"
            @change=${(e: Event) => (this._route = (e.target as HTMLSelectElement).value)}
          >
            <option value="">Go to…</option>
            ${routeChoices().map((r) => html`<option value=${r.route}>${r.title}</option>`)}
          </select>
          <button title="Navigate the mirrored window" ?disabled=${!this._route || this._busy} @click=${() => this.navigateSource()}>
            ${icons.arrowRight}
          </button>
          <button title=${this._paused ? "Resume" : "Pause"} @click=${() => (this._paused = !this._paused)}>
            ${this._paused ? icons.play : icons.pause}
          </button>
          <button title="Refresh now" @click=${() => this.refresh()}>${icons.refresh}</button>
          <button title=${this._expanded ? "Shrink" : "Expand"} @click=${() => this.toggleExpanded()}>
            ${this._expanded ? icons.minimize : icons.maximize}
          </button>
          <button title="Close" @click=${() => closeRemoteScreen()}>${icons.x}</button>
        </header>
        <div class="screen">
          ${this._img ? html`<img alt="Live view of ${src.tab}" src=${this._img} />` : html`<span class="empty">Connecting to ${src.tab}…</span>`}
          ${this._error ? html`<div class="msg" role="alert">${this._error}</div>` : nothing}
        </div>
        <footer>
          <span>${this._meta.latencyMs !== undefined ? `${this._meta.latencyMs} ms round trip` : ""}</span>
          <span>${this._meta.at ? `updated ${new Date(this._meta.at).toLocaleTimeString()}` : ""}</span>
        </footer>
      </div>
    `;
  }
}

if (!customElements.get("ib-remote-screen")) customElements.define("ib-remote-screen", IbRemoteScreen);

let current: IbRemoteScreen | null = null;

export function openRemoteScreen(source: Source, intervalMs?: number): IbRemoteScreen {
  if (!current) {
    current = document.createElement("ib-remote-screen") as IbRemoteScreen;
    // Never capture the mirror itself (no picture-in-picture recursion).
    current.dataset.ibCaptureSkip = "";
    document.body.appendChild(current);
  }
  current.source = { ...source };
  if (intervalMs && intervalMs >= 800) current.intervalMs = intervalMs;
  void current.refresh();
  return current;
}

export function closeRemoteScreen(): void {
  current?.remove();
  current = null;
}

export function registerRemoteScreenController(): RegistrationHandle {
  return attachViewController({
    viewName: "remote_screen",
    description:
      "Live view of another window's screen (this or another federation node) floating in this window. Opened by ui_control action='mirror'.",
    getState: () => ({
      open: Boolean(current),
      source: current?.source ?? null,
    }),
    describeActions: () => [
      {
        type: "open",
        args: { node: "string? node id (omit/local = this node)", tab: "string window codename", intervalMs: "number?" },
        doc: "Show that window's screen live here.",
      },
      { type: "close", doc: "Close the remote view." },
    ],
    dispatch: async (action) => {
      const a = action as Record<string, unknown>;
      if (a.type === "close") {
        closeRemoteScreen();
        return { ok: true, result: { open: false } };
      }
      if (a.type === "open") {
        const tab = typeof a.tab === "string" ? a.tab.trim() : "";
        if (!tab) return { ok: false, error: "tab is required" };
        const node = typeof a.node === "string" && a.node.trim() ? a.node.trim() : "local";
        openRemoteScreen(
          { node, tab, label: typeof a.label === "string" ? a.label : undefined },
          typeof a.intervalMs === "number" ? a.intervalMs : undefined,
        );
        return { ok: true, result: { open: true, node, tab } };
      }
      return { ok: false, error: `unknown action: ${String(a.type)}` };
    },
  });
}

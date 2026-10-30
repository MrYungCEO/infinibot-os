import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import type { GatewayBrowserClient } from "../gateway";
import { awaitGatewayClient, getGatewayClient } from "../gateway-client.js";
import "./provider-logo.js";
import { KV_CONNECT_CHANGED, KV_CONNECT_REFRESH, kvConnectAvailable, type KvConnectStatus } from "./kv-connect-approval.js";

/**
 * <kv-connect-card>: Connect KinglyVault, the same flow everywhere it shows up
 * (onboarding step, Plugins page card, Setup › Connect KinglyVault).
 *
 *  - One click: kvconnect.start asks KinglyVault for a link, this opens
 *    kinglyvault.com/infinibot/link?code=… in a new tab, the member approves
 *    there and the plugin finishes by itself (polling with its own device code).
 *  - Or paste the 8-character code KinglyVault shows (kvconnect.code), then
 *    approve it in the global prompt.
 *  - Connected ✓ with account, permissions, last sync and plain-English
 *    errors; Reconnect restarts the link without restarting the gateway
 *    (kvconnect.restart); Disconnect revokes on both sides (kvconnect.disconnect).
 *
 * Backed by the kinglyvault-relay plugin (on by default, idle until paired).
 * When the plugin is off it says so instead of calling a missing method.
 *
 * mode: "onboarding" (big, with Skip), "card" (Plugins page), "settings".
 */

const UNLOCKS: ReadonlyArray<{ title: string; text: string }> = [
  { title: "Your courses", text: "KinglyVault lessons and projects show up for your agents, who can read them and help you through them." },
  { title: "Skills & plugins", text: "Your agents can pull skills, workflows and starter packs from your KinglyVault library." },
  { title: "The KV agent drives InfiniBot", text: "From kinglyvault.com, chat with your agents, start coders in folders you allow and open pages here. Every action is scoped and logged." },
];

function ago(iso: string | null | undefined): string {
  if (!iso) return "not yet";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function plain(e: unknown): string {
  const m = String((e as Error)?.message ?? e ?? "");
  if (/unknown method/i.test(m)) return "KinglyVault Connect is turned off on this InfiniBot. Turn on “KinglyVault Connect” in Plugins.";
  if (/not connected|gateway/i.test(m) && m.length < 60) return "InfiniBot isn’t reachable right now. Wait a moment and try again.";
  return m || "Something went wrong. Try again.";
}

@customElement("kv-connect-card")
export class KvConnectCard extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property() mode: "onboarding" | "card" | "settings" = "card";
  /** Onboarding: show the Skip button (fires `kv-skip`). */
  @property({ type: Boolean }) skippable = false;

  @state() private status: KvConnectStatus | null = null;
  @state() private off = false;
  @state() private busy: "" | "start" | "code" | "disconnect" | "reconnect" = "";
  @state() private error = "";
  @state() private code = "";
  @state() private showCode = false;
  @state() private confirmDisconnect = false;

  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsub: (() => void) | null = null;
  private onChanged = (e: Event) => {
    this.status = (e as CustomEvent<KvConnectStatus>).detail;
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(KV_CONNECT_CHANGED, this.onChanged);
    void this.init();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(KV_CONNECT_CHANGED, this.onChanged);
    clearTimeout(this.timer);
    this.unsub?.();
    this.unsub = null;
  }

  private async rpc(): Promise<GatewayBrowserClient | null> {
    return this.client ?? getGatewayClient() ?? (await awaitGatewayClient(15_000).catch(() => null));
  }

  private async init(): Promise<void> {
    const c = await this.rpc();
    if (c && typeof c.subscribe === "function" && !this.unsub) {
      this.unsub = c.subscribe((evt) => {
        if (evt.event === "kvconnect.changed" || evt.event === "kvconnect.request") void this.refresh();
      });
    }
    await this.refresh();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.off || !this.isConnected) return;
    const fast = this.status?.linking?.state === "waiting" || this.status?.linking?.state === "finishing" || (this.status?.pending.length ?? 0) > 0;
    this.timer = setTimeout(() => void this.refresh(), fast ? 2500 : 20_000);
  }

  private pluginsSynced = false;

  /**
   * One connection: linking KinglyVault here also unlocks the plugins the
   * account owns or its plan includes (the gateway links the plugin licence
   * from this connection; plugins.entitlements.syncFromRelay).
   */
  private async syncPlugins(c: GatewayBrowserClient): Promise<void> {
    if (this.pluginsSynced) return;
    this.pluginsSynced = true;
    try {
      const res = await c.request<{ ok?: boolean; changed?: string[] }>("plugins.entitlements.syncFromRelay", {});
      if (res?.ok) this.dispatchEvent(new CustomEvent("kv-changed", { bubbles: true, composed: true }));
    } catch {
      // older gateway, or KinglyVault unreachable: the gateway retries by itself
      this.pluginsSynced = false;
    }
  }

  private async refresh(): Promise<void> {
    const c = await this.rpc();
    if (!c) {
      this.error = "InfiniBot isn’t reachable right now. Wait a moment and try again.";
      return this.schedule();
    }
    if (!kvConnectAvailable(c)) {
      this.off = true;
      return;
    }
    try {
      const s = await c.request<KvConnectStatus>("kvconnect.status", {});
      const was = this.status?.connected;
      this.status = s;
      this.off = false;
      if (s.connected && !was) {
        this.dispatchEvent(new CustomEvent("kv-connected", { bubbles: true, composed: true, detail: s }));
        void this.syncPlugins(c);
      }
      window.dispatchEvent(new CustomEvent(KV_CONNECT_CHANGED, { detail: s }));
    } catch (e) {
      if (/unknown method/i.test(String((e as Error)?.message ?? e))) this.off = true;
      else this.error = plain(e);
    }
    this.schedule();
  }

  private async start(): Promise<void> {
    this.error = "";
    this.busy = "start";
    // Browsers: open the tab inside the click (popup blockers), then point it
    // at KV. Desktop app: window.open goes straight to the system browser
    // (electron/external-links.js), so open it once we have the URL.
    const desktop = /\bElectron\//.test(navigator.userAgent);
    const tab = desktop ? null : window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const c = await this.rpc();
      if (!c) throw new Error("InfiniBot isn’t reachable right now. Wait a moment and try again.");
      const s = await c.request<KvConnectStatus>("kvconnect.start", {});
      this.status = s;
      const url = s.linking?.verifyUrl;
      if (url) {
        if (tab && !tab.closed) tab.location.href = url;
        else window.open(url, "_blank", "noopener");
      } else tab?.close();
    } catch (e) {
      tab?.close();
      this.error = plain(e);
    } finally {
      this.busy = "";
      this.schedule();
    }
  }

  private async cancel(): Promise<void> {
    const c = await this.rpc();
    try {
      this.status = (await c?.request<KvConnectStatus>("kvconnect.cancel", {})) ?? this.status;
    } catch (e) {
      this.error = plain(e);
    }
  }

  private async submitCode(): Promise<void> {
    const code = this.code.trim();
    if (!code) return;
    this.error = "";
    this.busy = "code";
    try {
      const c = await this.rpc();
      await c?.request("kvconnect.code", { code });
      this.code = "";
      this.showCode = false;
      // The global prompt shows "Connect KinglyVault?" with the account to approve.
      window.dispatchEvent(new Event(KV_CONNECT_REFRESH));
      await this.refresh();
    } catch (e) {
      this.error = plain(e);
    } finally {
      this.busy = "";
    }
  }

  private async reconnect(): Promise<void> {
    this.error = "";
    this.busy = "reconnect";
    try {
      const c = await this.rpc();
      const s = await c?.request<KvConnectStatus>("kvconnect.restart", {});
      if (s) this.status = s;
      window.dispatchEvent(new CustomEvent(KV_CONNECT_CHANGED, { detail: s }));
      // The first pull after a reconnect lands within seconds.
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.refresh(), 3000);
    } catch (e) {
      const unknown = /unknown method/i.test(String((e as Error)?.message ?? e));
      this.error = unknown ? "Restart InfiniBot once to finish updating, then Reconnect will work." : plain(e);
    } finally {
      this.busy = "";
    }
  }

  private async disconnect(): Promise<void> {
    this.error = "";
    this.busy = "disconnect";
    try {
      const c = await this.rpc();
      const s = await c?.request<KvConnectStatus & { remote?: number | null }>("kvconnect.disconnect", {});
      if (s) this.status = s;
      this.confirmDisconnect = false;
      window.dispatchEvent(new CustomEvent(KV_CONNECT_CHANGED, { detail: s }));
    } catch (e) {
      this.error = plain(e);
    } finally {
      this.busy = "";
    }
  }

  private skip(): void {
    this.dispatchEvent(new CustomEvent("kv-skip", { bubbles: true, composed: true }));
  }

  private renderUnlocks(): TemplateResult {
    return html`<ul class="unlocks" aria-label="What connecting unlocks">
      ${UNLOCKS.map((u) => html`<li><strong>${u.title}</strong><span>${u.text}</span></li>`)}
    </ul>`;
  }

  private renderConnected(s: KvConnectStatus): TemplateResult {
    const l = s.link!;
    const h = s.health;
    const problem = h?.error ?? (l.paused ? "Paused on this InfiniBot: KinglyVault requests are refused until you resume." : null);
    return html`
      <div class="state state--ok" data-testid="kv-connected">
        <span class="badge badge--ok">Connected ✓</span>
        <div class="who">
          <strong>${l.account}</strong>
          <span>${l.deviceName ? `as “${l.deviceName}”` : ""}</span>
        </div>
      </div>
      <dl class="facts">
        <div><dt>Last sync</dt><dd data-testid="kv-last-sync">${h?.online === false ? "offline" : ago(h?.lastSyncAt)}</dd></div>
        <div><dt>Last KV action</dt><dd>${ago(h?.lastRequestAt)}</dd></div>
        <div><dt>Linked</dt><dd>${ago(l.pairedAt)}</dd></div>
      </dl>
      ${problem ? html`<p class="warn" role="status">${problem}</p>` : nothing}
      ${this.mode !== "onboarding"
        ? html`<details class="perms">
            <summary>What KinglyVault may do (${l.permissions.length})</summary>
            <ul>${l.permissions.map((p) => html`<li>${p.text}</li>`)}</ul>
            <p class="muted">Change these on kinglyvault.com → InfiniBot. No shell access is ever granted.</p>
          </details>`
        : nothing}
      <div class="row">
        ${this.confirmDisconnect
          ? html`<span class="muted">Remove the link on both sides?</span>
              <button class="btn btn--danger" ?disabled=${this.busy === "disconnect"} @click=${() => void this.disconnect()} data-testid="kv-disconnect-confirm">
                ${this.busy === "disconnect" ? "Disconnecting…" : "Yes, disconnect"}
              </button>
              <button class="btn btn--ghost" @click=${() => (this.confirmDisconnect = false)}>Keep it</button>`
          : html`<button class="btn btn--ghost" ?disabled=${this.busy === "reconnect"} @click=${() => void this.reconnect()} data-testid="kv-reconnect">
                ${this.busy === "reconnect" ? "Reconnecting…" : "Reconnect"}
              </button>
              <button class="btn btn--ghost" @click=${() => (this.confirmDisconnect = true)} data-testid="kv-disconnect">Disconnect</button>
              <a class="btn btn--ghost" href=${`${l.kvOrigin.replace(/\/$/, "")}/infinibot#connect`} target="_blank" rel="noopener">Open KinglyVault</a>`}
      </div>
    `;
  }

  private renderLinking(s: KvConnectStatus): TemplateResult {
    const k = s.linking!;
    if (k.state === "waiting" || k.state === "finishing") {
      return html`<div class="state" data-testid="kv-linking">
          <span class="spinner" aria-hidden="true"></span>
          <div>
            <strong>${k.state === "finishing" ? "Approved. Finishing the link…" : "Approve on kinglyvault.com"}</strong>
            <span class="muted">A KinglyVault tab opened. Check the code matches, then click Approve. This page updates by itself.</span>
          </div>
        </div>
        <p class="code" aria-label="Link code">${k.userCode}</p>
        <div class="row">
          <a class="btn btn--primary" href=${k.verifyUrl} target="_blank" rel="noopener">Open kinglyvault.com again</a>
          <button class="btn btn--ghost" @click=${() => void this.cancel()}>Cancel</button>
        </div>`;
    }
    return nothing as unknown as TemplateResult;
  }

  private renderIdle(s: KvConnectStatus | null): TemplateResult {
    const k = s?.linking;
    const failed = k && (k.state === "denied" || k.state === "expired" || k.state === "error") ? k.error : null;
    return html`
      ${this.renderUnlocks()}
      ${failed ? html`<p class="warn" role="status">${failed}</p>` : nothing}
      ${s?.revokePending ? html`<p class="muted">Finishing the last disconnect on KinglyVault’s side as soon as it’s reachable.</p>` : nothing}
      <div class="row">
        <button class="btn btn--primary" ?disabled=${this.busy === "start"} @click=${() => void this.start()} data-testid="kv-connect-start">
          ${this.busy === "start" ? "Opening KinglyVault…" : "Sign in with KinglyVault"}
        </button>
        <button class="btn btn--ghost" @click=${() => (this.showCode = !this.showCode)} aria-expanded=${this.showCode}>I have a code</button>
        ${this.skippable ? html`<button class="btn btn--link" @click=${() => this.skip()} data-testid="kv-skip">Skip for now</button>` : nothing}
      </div>
      ${this.showCode
        ? html`<form class="codeform" @submit=${(e: Event) => (e.preventDefault(), void this.submitCode())}>
            <label for="kv-code">Code from kinglyvault.com → InfiniBot → Connect</label>
            <div class="row">
              <input id="kv-code" .value=${this.code} @input=${(e: Event) => (this.code = (e.target as HTMLInputElement).value.toUpperCase())} placeholder="ABCD-EFGH" maxlength="9" autocomplete="off" spellcheck="false" />
              <button class="btn btn--primary" type="submit" ?disabled=${this.busy === "code" || this.code.trim().length < 8}>${this.busy === "code" ? "Checking…" : "Continue"}</button>
            </div>
          </form>`
        : nothing}
      <p class="muted small">No KinglyVault account? <a href="https://kinglyvault.com" target="_blank" rel="noopener">Create one free</a>. You can connect any time from Plugins or Settings.</p>
    `;
  }

  render(): TemplateResult {
    const s = this.status;
    const linking = s?.linking && (s.linking.state === "waiting" || s.linking.state === "finishing");
    return html`<section class="kv kv--${this.mode}" data-testid="kv-connect-card">
      <header class="head">
        <ib-provider-logo provider="kinglyvault" size="44"></ib-provider-logo>
        <div>
          <h3>KinglyVault</h3>
          <p>${s?.connected ? "Your InfiniBot is linked to your KinglyVault account." : "Link your KinglyVault account: courses, plugins and the KV agent, right here."}</p>
        </div>
      </header>
      ${this.off
        ? html`<p class="warn">KinglyVault Connect is turned off on this InfiniBot. Turn on “KinglyVault Connect” in Plugins to link your account.</p>
            ${this.skippable ? html`<div class="row"><button class="btn btn--link" @click=${() => this.skip()}>Skip for now</button></div>` : nothing}`
        : s?.connected
          ? this.renderConnected(s)
          : linking
            ? this.renderLinking(s!)
            : this.renderIdle(s)}
      ${this.error ? html`<p class="warn" role="alert">${this.error}</p>` : nothing}
    </section>`;
  }

  static styles = css`
    :host {
      display: block;
      min-width: 0;
      color: var(--text, #e8e6e3);
      font: inherit;
    }
    .kv {
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4af37) 28%, transparent);
      border-radius: 18px;
      padding: 20px;
      background: linear-gradient(160deg, rgba(212, 175, 55, 0.07), rgba(10, 10, 12, 0.55) 55%);
      backdrop-filter: blur(10px);
      display: grid;
      gap: 14px;
      min-width: 0;
    }
    .kv--onboarding {
      padding: 24px;
    }
    .head {
      display: flex;
      gap: 14px;
      align-items: center;
      min-width: 0;
    }
    h3 {
      margin: 0;
      font-size: 1.05rem;
    }
    .head p {
      margin: 2px 0 0;
      color: var(--muted, #a8a29e);
      font-size: 0.9rem;
    }
    .unlocks {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 10px;
    }
    .unlocks li {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 10px 12px;
      background: rgba(255, 255, 255, 0.025);
      display: grid;
      align-content: start;
      gap: 4px;
      font-size: 0.85rem;
      color: var(--muted, #a8a29e);
    }
    .unlocks strong {
      color: var(--g-primary, #d4af37);
      font-size: 0.9rem;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .btn {
      appearance: none;
      border-radius: 10px;
      padding: 10px 16px;
      min-height: 44px;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
    }
    .btn:disabled {
      opacity: 0.6;
      cursor: default;
    }
    .btn--primary {
      background: linear-gradient(135deg, #f3d77a, var(--g-primary, #d4af37));
      color: #0b0b0d;
    }
    .btn--ghost {
      background: rgba(255, 255, 255, 0.04);
      color: var(--text, #e8e6e3);
      border-color: rgba(255, 255, 255, 0.14);
    }
    .btn--danger {
      background: rgba(239, 68, 68, 0.14);
      color: #fca5a5;
      border-color: rgba(239, 68, 68, 0.4);
    }
    .btn--link {
      background: none;
      color: var(--muted, #a8a29e);
      text-decoration: underline;
      padding-inline: 6px;
    }
    .state {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }
    .state > div {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .badge {
      border-radius: 999px;
      padding: 4px 12px;
      font-weight: 700;
      font-size: 0.85rem;
    }
    .badge--ok {
      background: rgba(34, 197, 94, 0.15);
      color: #86efac;
      border: 1px solid rgba(34, 197, 94, 0.4);
    }
    .who {
      display: grid;
      min-width: 0;
    }
    .who strong {
      overflow-wrap: anywhere;
    }
    .who span,
    .muted {
      color: var(--muted, #a8a29e);
      font-size: 0.85rem;
    }
    .small {
      font-size: 0.8rem;
      margin: 0;
    }
    .small a {
      color: var(--g-primary, #d4af37);
    }
    .facts {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin: 0;
    }
    .facts div {
      border-radius: 10px;
      padding: 8px 10px;
      background: rgba(255, 255, 255, 0.03);
    }
    dt {
      font-size: 0.75rem;
      color: var(--muted, #a8a29e);
    }
    dd {
      margin: 2px 0 0;
      font-weight: 600;
    }
    .perms summary {
      cursor: pointer;
      color: var(--muted, #a8a29e);
      font-size: 0.9rem;
    }
    .perms ul {
      margin: 8px 0;
      padding-left: 18px;
      font-size: 0.85rem;
    }
    .warn {
      margin: 0;
      padding: 10px 12px;
      border-radius: 10px;
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.35);
      color: #fcd34d;
      font-size: 0.88rem;
    }
    .code {
      margin: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 1.6rem;
      letter-spacing: 0.25em;
      color: var(--g-primary, #d4af37);
    }
    .spinner {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 2px solid rgba(212, 175, 55, 0.25);
      border-top-color: var(--g-primary, #d4af37);
      animation: spin 0.9s linear infinite;
      flex: none;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .spinner {
        animation: none;
      }
    }
    .codeform {
      display: grid;
      gap: 8px;
    }
    .codeform label {
      font-size: 0.85rem;
      color: var(--muted, #a8a29e);
    }
    input {
      flex: 1 1 160px;
      min-width: 0;
      min-height: 44px;
      box-sizing: border-box;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(0, 0, 0, 0.35);
      color: inherit;
      padding: 0 12px;
      font: inherit;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.15em;
      text-transform: uppercase;
    }
    @media (max-width: 480px) {
      .kv {
        padding: 16px;
      }
      .row .btn {
        flex: 1 1 auto;
      }
      .code {
        font-size: 1.3rem;
      }
      .facts {
        grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
      }
      .facts div {
        padding: 6px 8px;
      }
      dd {
        font-size: 0.85rem;
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "kv-connect-card": KvConnectCard;
  }
}

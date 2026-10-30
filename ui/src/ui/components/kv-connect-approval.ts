import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import type { GatewayBrowserClient } from "../gateway";
import { clearKvIntent, startKvIntentLink, takeKvIntentFromUrl } from "./kv-connect-intent";

/**
 * Global "KinglyVault wants to connect" prompt.
 *
 * The kinglyvault-relay plugin queues a request when the KinglyVault page
 * hands this gateway a one-time pairing code (POST /kv-connect/pair) or when
 * the owner types one in Setup → Connect KinglyVault. Nothing is granted
 * until the owner clicks Approve here (kvconnect.approve, an admin RPC).
 *
 * Listens for the plugin's `kvconnect.request` event and also polls
 * kvconnect.status every few seconds (only while the plugin answers, so a
 * gateway without it costs one failed call).
 */

export interface KvConnectPermission {
  scope: string;
  text: string;
}

export interface KvConnectPending {
  id: string;
  code: string;
  source: string;
  account: string | null;
  kvOrigin: string | null;
  permissions: KvConnectPermission[];
  expiresAt: string;
}

export interface KvConnectStatus {
  pluginActive: boolean;
  connected: boolean;
  link: {
    account: string;
    kvOrigin: string;
    connectionId: string;
    deviceName: string | null;
    permissions: KvConnectPermission[];
    paused: boolean;
    pairedAt: string | null;
    running: boolean;
  } | null;
  pending: KvConnectPending[];
  /** One-click link waiting for approval on kinglyvault.com (kvconnect.start). */
  linking?: {
    state: "waiting" | "finishing" | "connected" | "denied" | "expired" | "error";
    userCode: string;
    verifyUrl: string;
    expiresAt: string;
    error: string | null;
  } | null;
  /** A disconnect is waiting for KinglyVault to confirm the revoke. */
  revokePending?: boolean;
  health?: {
    online: boolean;
    lastSyncAt: string | null;
    lastRequestAt: string | null;
    error: string | null;
  } | null;
}

/** True when this gateway serves the KinglyVault Connect RPCs (plugin on). */
export function kvConnectAvailable(client: GatewayBrowserClient | null | undefined): boolean {
  if (!client) return false;
  return typeof client.supports === "function" ? client.supports("kvconnect.status") : true;
}

/** Fired on window to make the prompt re-check right away (e.g. after entering a code). */
export const KV_CONNECT_REFRESH = "kvconnect:refresh";
/** Fired on window with the fresh status after any change. */
export const KV_CONNECT_CHANGED = "kvconnect:changed";

const POLL_MS = 5000;

@customElement("kv-connect-approval")
export class KvConnectApproval extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @state() private current: KvConnectPending | null = null;
  @state() private unticked = new Set<string>();
  @state() private busy: "" | "approve" | "deny" = "";
  @state() private error = "";
  @state() private done: string | null = null;

  private unsub: (() => void) | null = null;
  private subscribedTo: GatewayBrowserClient | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private unavailable = false;
  private dismissed = new Set<string>();
  private onRefresh = () => void this.check();

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(KV_CONNECT_REFRESH, this.onRefresh);
    document.addEventListener("visibilitychange", this.onRefresh);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(KV_CONNECT_REFRESH, this.onRefresh);
    document.removeEventListener("visibilitychange", this.onRefresh);
    clearTimeout(this.timer);
    this.unsub?.();
    this.unsub = null;
    this.subscribedTo = null;
  }

  // Agent A: "Link my Cloud InfiniBot" from KinglyVault (?kvconnect=start&kvintent=…).
  private kvIntent: string | null = takeKvIntentFromUrl();
  private kvIntentTries = 0;
  private async consumeKvIntent(): Promise<void> {
    const intent = this.kvIntent;
    const c = this.client;
    if (!intent || !c) return;
    this.kvIntent = null;
    try {
      const url = await startKvIntentLink(c, intent, window.location.origin + window.location.pathname);
      clearKvIntent();
      if (url) window.location.assign(url);
    } catch {
      // Gateway still waking (Cloud Free plan sleeps): retry for ~1 minute.
      this.kvIntent = intent;
      if (++this.kvIntentTries < 20) setTimeout(() => void this.consumeKvIntent(), 3000);
    }
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has("client") && this.client && this.kvIntent) void this.consumeKvIntent();
    if (changed.has("client") && this.subscribedTo !== this.client) {
      this.unsub?.();
      this.unsub = null;
      this.subscribedTo = this.client;
      this.unavailable = false;
      if (this.client && typeof this.client.subscribe === "function") {
        this.unsub = this.client.subscribe((evt) => {
          if (evt.event === "kvconnect.request" || evt.event === "kvconnect.changed") void this.check();
        });
      }
      void this.check();
    }
    const d = this.renderRoot.querySelector<HTMLDialogElement>("dialog");
    if (d && !d.open) d.showModal();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.unavailable || !this.client) return;
    this.timer = setTimeout(() => void this.check(), POLL_MS);
  }

  private async check(): Promise<void> {
    const c = this.client;
    if (!c || this.unavailable) return;
    if (document.visibilityState === "hidden") return this.schedule();
    // Plugin turned off on this gateway: never call a method it doesn't serve.
    if (!kvConnectAvailable(c)) return this.schedule();
    try {
      const s = await c.request<KvConnectStatus>("kvconnect.status", {});
      window.dispatchEvent(new CustomEvent(KV_CONNECT_CHANGED, { detail: s }));
      if (!this.busy && !this.done) {
        const next = s.pending.find((p) => !this.dismissed.has(p.id)) ?? null;
        if (next?.id !== this.current?.id) {
          this.current = next;
          this.unticked = new Set();
          this.error = "";
        }
      }
    } catch (e) {
      // Plugin not loaded on this gateway: stop asking.
      if (/unknown method/i.test(String((e as Error)?.message ?? e))) this.unavailable = true;
    }
    this.schedule();
  }

  private async approve(): Promise<void> {
    const p = this.current;
    if (!p || !this.client) return;
    const scopes = p.permissions.map((x) => x.scope).filter((s) => !this.unticked.has(s));
    if (!scopes.length) {
      this.error = "Leave at least one permission on, or choose Deny.";
      return;
    }
    this.busy = "approve";
    this.error = "";
    try {
      const s = await this.client.request<KvConnectStatus>("kvconnect.approve", { id: p.id, scopes });
      window.dispatchEvent(new CustomEvent(KV_CONNECT_CHANGED, { detail: s }));
      this.done = s.link?.account ?? p.account ?? "KinglyVault";
      setTimeout(() => this.close(), 2600);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.busy = "";
    }
  }

  private async deny(): Promise<void> {
    const p = this.current;
    if (!p || !this.client) return;
    this.busy = "deny";
    try {
      await this.client.request("kvconnect.deny", { id: p.id });
    } catch {
      /* expired already */
    }
    this.busy = "";
    this.dismissed.add(p.id);
    this.close();
  }

  private close(): void {
    this.current = null;
    this.done = null;
    this.error = "";
    void this.check();
  }

  render() {
    const p = this.current;
    if (!p) return nothing;
    if (this.done) {
      return html`<dialog aria-labelledby="kvc-title" @cancel=${(e: Event) => (e.preventDefault(), this.close())}>
        <div class="badge ok" aria-hidden="true">${checkIcon}</div>
        <h2 id="kvc-title">Connected to KinglyVault</h2>
        <p class="lede">Signed in as ${this.done}. You can go back to KinglyVault; it shows Connected in a moment.</p>
        <div class="actions"><button class="primary" @click=${() => this.close()}>Done</button></div>
      </dialog>`;
    }
    return html`<dialog aria-labelledby="kvc-title" @cancel=${(e: Event) => (e.preventDefault(), void this.deny())}>
      <div class="badge" aria-hidden="true">${linkIcon}</div>
      <h2 id="kvc-title">Connect KinglyVault?</h2>
      <p class="lede">
        ${p.account ? html`The KinglyVault account <strong>${p.account}</strong> wants to connect to this InfiniBot.` : "KinglyVault wants to connect to this InfiniBot."}
      </p>
      <div class="code">
        <span>Check this matches the code on the KinglyVault page</span>
        <strong>${p.code}</strong>
      </div>
      <fieldset>
        <legend>It can</legend>
        ${p.permissions.map(
          (x) => html`<label>
            <input
              type="checkbox"
              .checked=${!this.unticked.has(x.scope)}
              @change=${(e: Event) => {
                const next = new Set(this.unticked);
                if ((e.target as HTMLInputElement).checked) next.delete(x.scope);
                else next.add(x.scope);
                this.unticked = next;
              }}
            />
            <span>${x.text}</span>
          </label>`,
        )}
      </fieldset>
      <p class="fine">No shell access. Coders only run in folders you allow. You can disconnect any time in Setup → Connect KinglyVault.</p>
      ${this.error ? html`<p class="err" role="alert">${this.error}</p>` : nothing}
      <div class="actions">
        <button class="ghost" ?disabled=${!!this.busy} @click=${() => void this.deny()}>${this.busy === "deny" ? "Denying…" : "Deny"}</button>
        <button class="primary" ?disabled=${!!this.busy} @click=${() => void this.approve()} data-testid="kvc-approve">
          ${this.busy === "approve" ? "Connecting…" : "Approve"}
        </button>
      </div>
    </dialog>`;
  }

  static styles = css`
    :host { --gold: var(--glass-gold, var(--g-primary, #d4af37)); }
    dialog {
      width: min(440px, calc(100vw - 32px)); box-sizing: border-box; padding: 26px 24px 20px;
      border-radius: 20px; color: var(--text, #f4f1ea);
      border: 1px solid color-mix(in srgb, var(--gold) 34%, transparent);
      background: linear-gradient(160deg, color-mix(in srgb, var(--gold) 10%, #0d0b09), #0a0908 70%);
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.06);
      font: 14px/1.5 var(--font-body, system-ui, sans-serif);
    }
    dialog::backdrop { background: rgba(4, 3, 2, 0.62); backdrop-filter: blur(6px); }
    .badge {
      width: 44px; height: 44px; border-radius: 14px; display: grid; place-items: center; color: var(--gold);
      border: 1px solid color-mix(in srgb, var(--gold) 40%, transparent); background: color-mix(in srgb, var(--gold) 12%, transparent);
    }
    .badge.ok { color: #6ee7b7; border-color: rgba(110, 231, 183, 0.4); background: rgba(110, 231, 183, 0.1); }
    .badge svg { width: 22px; height: 22px; }
    h2 { margin: 14px 0 6px; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
    .lede { margin: 0 0 14px; color: var(--muted, #b9b2a5); }
    .lede strong { color: var(--text, #fff); font-weight: 600; }
    .code {
      display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-radius: 12px;
      border: 1px dashed color-mix(in srgb, var(--gold) 45%, transparent); background: rgba(0, 0, 0, 0.3); margin-bottom: 14px;
    }
    .code span { font-size: 12px; color: var(--muted, #b9b2a5); }
    .code strong { font: 700 18px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.14em; color: var(--gold); white-space: nowrap; }
    fieldset { border: 0; margin: 0 0 10px; padding: 0; display: grid; gap: 6px; }
    legend { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted, #b9b2a5); margin-bottom: 6px; }
    label { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border-radius: 10px; background: rgba(255, 255, 255, 0.03); cursor: pointer; }
    input[type="checkbox"] { accent-color: var(--gold); margin-top: 3px; }
    .fine { font-size: 12px; color: var(--muted, #b9b2a5); margin: 8px 0 0; }
    .err { color: var(--danger, #f87171); font-size: 13px; margin: 10px 0 0; }
    .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }
    button { min-height: 42px; padding: 0 18px; border-radius: 12px; font: 600 14px/1 inherit; cursor: pointer; }
    button:disabled { opacity: 0.55; cursor: default; }
    .ghost { background: transparent; color: var(--text, #fff); border: 1px solid rgba(255, 255, 255, 0.16); }
    .primary { border: 0; color: #1d1200; background: linear-gradient(135deg, #f5d27a, var(--gold)); box-shadow: 0 10px 26px color-mix(in srgb, var(--gold) 30%, transparent); }
  `;
}

const linkIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/></svg>`;
const checkIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;

declare global {
  interface HTMLElementTagNameMap {
    "kv-connect-approval": KvConnectApproval;
  }
}

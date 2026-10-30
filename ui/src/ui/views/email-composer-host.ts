/**
 * <email-composer-host> — global modal host for the unified "Send Email"
 * composer. Mounted once at the app root. Listens for the
 * `infinibot:open-email-composer` CustomEvent so any view (Lead detail,
 * Client detail, Funnel inbox) can pop the composer with one line:
 *
 *   document.dispatchEvent(new CustomEvent("infinibot:open-email-composer", {
 *     detail: { to: "lead@example.com", subject: "...", businessId: "..." }
 *   }));
 *
 * The composer talks to the gateway's `email.send` RPC, which routes to
 * the unified email dispatcher (Resend / Loops). Provider availability
 * is shown so the operator knows whether the send will land.
 */
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";

import type { GatewayBrowserClient } from "../gateway";
import { commIcon, ensureCommunicationGlassStyles } from "./communication-glass";

let registeredClient: GatewayBrowserClient | null = null;

export function setEmailComposerHostClient(client: GatewayBrowserClient | null): void {
  registeredClient = client;
}

export function requestEmailCompose(input: {
  to: string;
  subject?: string;
  body?: string;
  businessId?: string;
  contextLabel?: string;
}): void {
  document.dispatchEvent(
    new CustomEvent("infinibot:open-email-composer", { detail: input }),
  );
}

interface AccountChoice {
  id: string;
  kind: string;
  address: string;
  displayName: string;
  isPrimary: boolean;
  businessId: string | null;
  outboundEnabled: boolean;
}

interface ProviderInfo {
  resend: boolean;
  loops: boolean;
  smtp?: boolean;
  defaultFrom: string | null;
  accounts?: AccountChoice[];
}

interface ComposerState {
  open: boolean;
  to: string;
  subject: string;
  body: string;
  businessId: string;
  contextLabel: string;
  /** Selected EmailAccount id when the user picks "From: …". Empty = auto. */
  accountId: string;
  busy: boolean;
  status: { ok: boolean; message: string } | null;
  providerInfo: ProviderInfo | null;
}

function createState(): ComposerState {
  return {
    open: false,
    to: "",
    subject: "",
    body: "",
    businessId: "",
    contextLabel: "",
    accountId: "",
    busy: false,
    status: null,
    providerInfo: null,
  };
}

async function rpc<T = unknown>(client: GatewayBrowserClient, method: string, params: unknown): Promise<T> {
  const fn = (client as any)?.request || (client as any)?.call || (client as any)?.invoke;
  if (!fn) throw new Error("gateway client has no request/call/invoke method");
  return fn.call(client, method, params) as Promise<T>;
}

@customElement("email-composer-host")
export class EmailComposerHost extends LitElement {
  createRenderRoot() {
    return this;
  }

  @state() private s: ComposerState = createState();

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("infinibot:open-email-composer", this._onOpen);
  }

  disconnectedCallback(): void {
    document.removeEventListener("infinibot:open-email-composer", this._onOpen);
    super.disconnectedCallback();
  }

  private _onOpen = (e: Event): void => {
    const d = (e as CustomEvent).detail as {
      to?: string;
      subject?: string;
      body?: string;
      businessId?: string;
      contextLabel?: string;
    };
    this.s = createState();
    this.s.open = true;
    this.s.to = d?.to ?? "";
    this.s.subject = d?.subject ?? "";
    this.s.body = d?.body ?? "";
    this.s.businessId = d?.businessId ?? "";
    this.s.contextLabel = d?.contextLabel ?? "";
    this.requestUpdate();
    void this._loadProviderInfo();
  };

  private async _loadProviderInfo(): Promise<void> {
    if (!registeredClient) return;
    try {
      const info = await rpc<ProviderInfo>(registeredClient, "email.providerInfo", {});
      this.s.providerInfo = info;
      // Preselect the primary for the active business when present.
      if (!this.s.accountId && info.accounts && info.accounts.length > 0) {
        const bizPrimary = info.accounts.find(
          (a) => a.businessId === this.s.businessId && a.isPrimary,
        );
        const fallback =
          bizPrimary ?? info.accounts.find((a) => a.outboundEnabled);
        if (fallback) this.s.accountId = fallback.id;
      }
      this.requestUpdate();
    } catch {
      /* providerInfo is informational; no fatal */
    }
  }

  private _close(): void {
    this.s.open = false;
    this.requestUpdate();
  }

  private async _send(): Promise<void> {
    if (!registeredClient) return;
    if (!this.s.to.trim()) {
      this.s.status = { ok: false, message: "Recipient required" };
      this.requestUpdate();
      return;
    }
    if (!this.s.subject.trim()) {
      this.s.status = { ok: false, message: "Subject required" };
      this.requestUpdate();
      return;
    }
    this.s.busy = true;
    this.s.status = null;
    this.requestUpdate();
    try {
      const res = await rpc<{ providerUsed: string; providerMessageId?: string }>(
        registeredClient,
        "email.send",
        {
          to: this.s.to.trim(),
          subject: this.s.subject,
          body: this.s.body,
          businessId: this.s.businessId || undefined,
          accountId: this.s.accountId || undefined,
        },
      );
      this.s.status = { ok: true, message: `Sent via ${res.providerUsed}` };
      // Auto-close on success after a short beat so the operator sees it landed.
      setTimeout(() => {
        this.s.open = false;
        this.requestUpdate();
      }, 1200);
    } catch (e: any) {
      const msg = e?.error?.message ?? e?.message ?? String(e);
      this.s.status = { ok: false, message: msg };
    } finally {
      this.s.busy = false;
      this.requestUpdate();
    }
  }

  private _renderAccountOptions(accounts: AccountChoice[]): TemplateResult[] {
    // Group by business so users with multi-tenant accounts see them clustered.
    const groups = new Map<string, AccountChoice[]>();
    for (const a of accounts) {
      const key = a.businessId ?? "__personal__";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(a);
    }
    const opts: TemplateResult[] = [];
    for (const [key, list] of groups) {
      const label = key === "__personal__" ? "Personal" : `Business ${key.slice(0, 8)}`;
      opts.push(html`<optgroup label=${label}>
        ${list.map(
          (a) => html`<option value=${a.id} ?selected=${a.id === this.s.accountId}>
            ${a.displayName || a.address} (${a.kind}${a.isPrimary ? ", primary" : ""})
          </option>`,
        )}
      </optgroup>`);
    }
    return opts;
  }

  render(): TemplateResult {
    if (!this.s.open) return html``;
    injectStyles();
    ensureCommunicationGlassStyles();
    const info = this.s.providerInfo;
    const accounts = info?.accounts?.filter((a) => a.outboundEnabled) ?? [];
    const noProvider = info && !info.resend && !info.loops && !info.smtp && accounts.length === 0;
    return html`
      <div class="ec-backdrop" @click=${(e: Event) => { if (e.target === e.currentTarget) this._close(); }}>
        <section class="ec-modal" @click=${(e: Event) => e.stopPropagation()}>
          <header class="ec-header">
            <strong>Send email</strong>
            ${this.s.contextLabel ? html`<span class="ec-muted">${this.s.contextLabel}</span>` : nothing}
            <span class="ec-spacer"></span>
            ${info?.defaultFrom ? html`<span class="ec-muted">From: ${info.defaultFrom}</span>` : nothing}
            <button class="ec-icon" aria-label="Close composer" @click=${() => this._close()}>${commIcon("close", 17)}</button>
          </header>
          ${noProvider
            ? html`<div class="ec-warn">
                No email provider configured. Set <code>RESEND_API_KEY</code>,
                <code>LOOPS_API_KEY</code>, or add an SMTP/IMAP account from
                the <strong>Emails → Manage accounts</strong> page.
              </div>`
            : nothing}
          <main class="ec-body">
            ${accounts.length > 0
              ? html`
                  <label>
                    <span>From</span>
                    <select class="ec-input"
                      .value=${this.s.accountId}
                      @change=${(e: Event) => { this.s.accountId = (e.target as HTMLSelectElement).value; this.requestUpdate(); }}
                    >
                      ${this._renderAccountOptions(accounts)}
                    </select>
                  </label>
                `
              : nothing}
            <label>
              <span>To</span>
              <input class="ec-input" type="email" .value=${this.s.to}
                @input=${(e: Event) => { this.s.to = (e.target as HTMLInputElement).value; this.requestUpdate(); }} />
            </label>
            <label>
              <span>Subject</span>
              <input class="ec-input" .value=${this.s.subject}
                @input=${(e: Event) => { this.s.subject = (e.target as HTMLInputElement).value; this.requestUpdate(); }} />
            </label>
            <label>
              <span>Body</span>
              <textarea class="ec-textarea" rows="10" .value=${this.s.body}
                @input=${(e: Event) => { this.s.body = (e.target as HTMLTextAreaElement).value; this.requestUpdate(); }}></textarea>
            </label>
            ${this.s.status
              ? html`<div class=${`ec-status ${this.s.status.ok ? "ec-status-ok" : "ec-status-err"}`}>${this.s.status.message}</div>`
              : nothing}
          </main>
          <footer class="ec-footer">
            <button class="ec-btn" @click=${() => this._close()}>Cancel</button>
            <span class="ec-spacer"></span>
            <button class="ec-btn ec-btn-primary" ?disabled=${this.s.busy || !!noProvider} @click=${() => void this._send()}>
              ${this.s.busy ? "Sending…" : "Send"}
            </button>
          </footer>
        </section>
      </div>
    `;
  }
}

let stylesInjected = false;
function injectStyles(): void {
  if (stylesInjected || typeof document === "undefined") return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "infinibot-email-composer-styles";
  style.textContent = EC_STYLES;
  document.head.appendChild(style);
}

const EC_STYLES = `
.ec-backdrop {
  position:fixed; inset:0; z-index:9999; display:flex; align-items:center; justify-content:center;
  padding:24px; background:color-mix(in srgb,var(--glass-base,#090806) 68%,transparent);
  backdrop-filter:blur(8px); -webkit-backdrop-filter:blur(8px);
  animation:ec-fade var(--glass-dur,180ms) var(--glass-ease,ease-out);
}
.ec-modal {
  position:relative; isolation:isolate; overflow:hidden;
  max-width:640px; width:100%; max-height:85vh; display:flex; flex-direction:column;
  color:var(--glass-fg,var(--g-fg,#f5f5f4)); font:13px/1.45 var(--glass-font,var(--font-ui,Inter,-apple-system,sans-serif));
  border-radius:var(--glass-radius-lg,20px)!important;
  animation:ec-rise var(--glass-dur,180ms) var(--glass-spring,cubic-bezier(.2,.8,.2,1));
}
.ec-modal::after {
  content:""; position:absolute; inset:0; z-index:-1; pointer-events:none;
  background:radial-gradient(520px 220px at 4% 0,var(--glass-gold-a16,rgba(217,180,95,.14)),transparent 70%);
}
.ec-header { display:flex; align-items:center; gap:10px; padding:15px 18px; border-bottom:1px solid var(--glass-stroke,rgba(217,180,95,.16)); }
.ec-header strong { font-size:15px; letter-spacing:var(--glass-tracking-tight,-.02em); }
.ec-spacer { flex:1; }
.ec-muted { color:var(--glass-fg-3,var(--g-fg-faint,#a3a3ad)); font-size:11px; }
.ec-icon {
  width:34px; height:34px; display:grid; place-items:center; flex:0 0 auto; cursor:pointer;
  border:1px solid var(--glass-stroke)!important; border-radius:var(--glass-radius-sm,10px)!important;
  background:var(--glass-hover)!important; color:var(--glass-fg-2)!important;
}
.ec-icon:hover { color:var(--glass-gold-hi)!important; border-color:var(--glass-stroke-gold)!important; transform:var(--glass-lift,translateY(-1px)); }
.ec-warn {
  color:var(--glass-gold-hi,#f1d38a); font-size:12px; padding:10px 18px;
  background:var(--glass-gold-tint); border-bottom:1px solid var(--glass-stroke-gold);
}
.ec-warn code { background:var(--glass-press); padding:1px 5px; border-radius:var(--glass-radius-xs,7px); }
.ec-body { flex:1; overflow-y:auto; padding:18px; display:flex; flex-direction:column; gap:12px; }
.ec-body label { display:flex; flex-direction:column; gap:6px; font-size:11px; color:var(--glass-fg-2,var(--g-fg-dim,#b9b4aa)); }
.ec-input, .ec-textarea {
  width:100%; box-sizing:border-box; padding:10px 12px; resize:vertical; font:inherit;
  border:1px solid var(--glass-stroke)!important; border-radius:var(--glass-radius-sm,10px)!important;
  background:color-mix(in srgb,var(--glass-base,#090806) 62%,transparent)!important;
  color:var(--glass-fg,var(--g-fg,#f5f5f4))!important;
  transition:border-color var(--glass-dur-fast,120ms),box-shadow var(--glass-dur-fast,120ms);
}
.ec-input:focus, .ec-textarea:focus { outline:none; border-color:var(--glass-stroke-gold)!important; box-shadow:var(--glass-focus-ring)!important; }
.ec-status { font-size:12px; padding:9px 11px; border-radius:var(--glass-radius-sm,10px); border:1px solid; }
.ec-status-ok { color:var(--glass-ok,#5fd17a); background:color-mix(in srgb,var(--glass-ok,#5fd17a) 9%,transparent); border-color:color-mix(in srgb,var(--glass-ok,#5fd17a) 28%,transparent); }
.ec-status-err { color:var(--glass-danger,#ef7373); background:color-mix(in srgb,var(--glass-danger,#ef7373) 9%,transparent); border-color:color-mix(in srgb,var(--glass-danger,#ef7373) 28%,transparent); }
.ec-footer { display:flex; align-items:center; gap:8px; padding:13px 18px; border-top:1px solid var(--glass-stroke); background:var(--glass-1); }
.ec-btn {
  min-height:36px; font:inherit; cursor:pointer; padding:7px 15px; font-size:12px; font-weight:650;
  border-radius:var(--glass-radius-sm,10px); border:1px solid var(--glass-stroke);
  background:var(--glass-sheen),var(--glass-hover); color:var(--glass-fg);
  box-shadow:var(--glass-elev-1); transition:transform var(--glass-dur-fast),border-color var(--glass-dur-fast),background var(--glass-dur-fast);
}
.ec-btn:disabled { opacity:0.5; cursor:not-allowed; }
.ec-btn:hover:not(:disabled) { transform:var(--glass-lift,translateY(-1px)); border-color:var(--glass-stroke-gold); }
.ec-btn-primary { border-color:transparent; background:var(--glass-gold-fill); color:var(--glass-ink,#160f03); box-shadow:var(--glass-elev-2),var(--glass-glow-soft); }
.ec-btn-primary:hover:not(:disabled) { filter:brightness(1.04); box-shadow:var(--glass-elev-3),var(--glass-glow); }
:where(.ec-icon,.ec-btn,.ec-input,.ec-textarea):focus-visible { outline:none; box-shadow:var(--glass-focus-ring)!important; }
@keyframes ec-fade { from { opacity:0; } }
@keyframes ec-rise { from { opacity:0; transform:translateY(10px) scale(.985); } }
@media(max-width:520px) {
  .ec-backdrop { padding:10px; align-items:flex-end; }
  .ec-modal { max-height:calc(100dvh - 20px); border-radius:var(--glass-radius-lg,20px) var(--glass-radius-lg,20px) 12px 12px!important; }
  .ec-header { padding:13px 14px; flex-wrap:wrap; }
  .ec-header .ec-muted { max-width:calc(100% - 48px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ec-body { padding:14px; }
  .ec-footer { padding:12px 14px; }
  .ec-btn { min-height:42px; }
}
@media(prefers-reduced-motion:reduce) { .ec-backdrop,.ec-modal { animation:none; } .ec-btn,.ec-icon { transition:none; } }
@media(prefers-reduced-transparency:reduce) { .ec-backdrop { backdrop-filter:none; -webkit-backdrop-filter:none; } }
`;

declare global {
  interface HTMLElementTagNameMap {
    "email-composer-host": EmailComposerHost;
  }
}

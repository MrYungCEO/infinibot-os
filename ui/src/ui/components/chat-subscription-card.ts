/**
 * <ib-chat-subscription-card> — a chat turn routed through the user's own AI
 * account (ChatGPT / Grok / Google / Claude) failed. Shows one friendly
 * sentence and ONE fix:
 *
 *   subscription_signed_out  "Sign in again"            browser sign-in for the active account, then a test message
 *   subscription_limit       "Switch to Gemini"  set up / connect Google; else "Try again in X min"
 *   subscription_missing     "Set it up again"          reinstall + sign in + test message (same flow as onboarding)
 *   timeout / failed         "Try again"                resend the last message
 *
 * Fires `resend` (detail: { text }) when the user should send the message
 * again, and `dismiss`. The fix flows reuse onboarding/cli-setup.ts.
 *
 * Copy rules: plain sentences, no raw errors, no jargon, no emoji.
 */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import { CliRoutingModel, type SubscriptionErrorCode } from "../controllers/cli-routing";
import { getGatewayClient } from "../gateway-client.js";
import { withAppBase } from "../app-base";
import { icon } from "../icons";
import { CliSetupRunner, GOOGLE_ID } from "../onboarding/cli-setup";

const TITLE: Record<string, string> = {
  subscription_limit: "You've reached your plan's limit for now",
  subscription_signed_out: "You're signed out",
  subscription_missing: "Your AI app needs setting up again",
  subscription_timeout: "That took too long",
  subscription_unsupported: "This account can't be used here",
  subscription_plan: "Your plan doesn't include this",
  subscription_untrusted: "Gemini CLI couldn't start",
  subscription_failed: "That message didn't go through",
};

/** "resets in 2 hours" / "try again in 45 minutes" → minutes, when present. */
export function parseRetryMinutes(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n) || n <= 0) return null;
  return /^h/i.test(m[2]!) ? Math.round(n * 60) : Math.round(n);
}

@customElement("ib-chat-subscription-card")
export class ChatSubscriptionCard extends LitElement {
  @property() code: SubscriptionErrorCode | string = "subscription_failed";
  @property() message = "";
  /** The user's last message (resent after a fix). */
  @property() text = "";

  private model = new CliRoutingModel(this, () => getGatewayClient(), { onSignedIn: (id) => this.runner.onSignedIn(id) });
  private runner = new CliSetupRunner(this, this.model, null, { onUseApiKey: () => this.openSetup() });
  @state() private loaded = false;
  @state() private pasted = "";

  connectedCallback(): void {
    super.connectedCallback();
    void this.model.load(true).then(() => (this.loaded = true));
  }

  private resend(): void {
    this.dispatchEvent(new CustomEvent("resend", { detail: { text: this.text }, bubbles: true, composed: true }));
  }

  private dismiss(): void {
    this.dispatchEvent(new CustomEvent("dismiss", { bubbles: true, composed: true }));
  }

  private openSetup(): void {
    this.dismiss();
    window.location.assign(withAppBase("/setup?step=model"));
  }

  private fix(): { label: string; run: () => void } {
    const st = this.model.status;
    const active = this.model.backend(st?.active ?? null);
    const google = this.model.backend(GOOGLE_ID);
    switch (this.code) {
      case "subscription_signed_out":
        return {
          label: active ? `${active.signInLabel} again` : "Sign in again",
          run: () => {
            if (!active) return this.resend();
            this.runner.backendId = active.id;
            void this.runner.fix("relogin");
          },
        };
      case "subscription_limit": {
        const canGoogle = google && active?.id !== GOOGLE_ID && (google.ready || google.installed || Boolean(google.coderId));
        if (canGoogle) return { label: "Switch to Gemini", run: () => void this.runner.start(GOOGLE_ID) };
        const mins = parseRetryMinutes(this.message);
        const when = !mins ? "" : mins >= 90 ? ` in about ${Math.round(mins / 60)} hours` : mins >= 60 ? " in about an hour" : ` in ${mins} min`;
        return { label: `Try again${when}`, run: () => this.resend() };
      }
      case "subscription_unsupported":
      case "subscription_plan":
        return { label: "Choose another AI", run: () => void this.openSetup() };
      case "subscription_missing":
        return {
          label: "Set it up again",
          run: () => (active ? void this.runner.start(active.id) : this.resend()),
        };
      default:
        return { label: "Try again", run: () => this.resend() };
    }
  }

  private renderFlow(): TemplateResult {
    const v = this.runner.view();
    const pct = Math.round(v.progress * 100);
    const onPrimary = () => {
      const p = v.primary;
      if (!p || p.busy) return;
      if (p.id === "chat") {
        this.runner.reset();
        return this.resend();
      }
      if (p.id === "code") return void this.runner.submitCode(this.pasted);
      if (p.id === "retry" || p.id === "google" || p.id === "relogin" || p.id === "guide" || p.id === "apikey") return this.runner.fix(p.id);
      this.runner.primary(p.id);
    };
    const label = v.phase === "done" ? "Send my message again" : (v.primary?.label ?? "");
    return html`
      <div class="bar" role="progressbar" aria-label="Fix progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${pct}><span style=${`width:${pct}%`}></span></div>
      <p class="line" aria-live="polite">${v.phase === "error" ? (v.error?.message ?? v.line) : v.line}</p>
      ${v.login?.userCode ? html`<div class="code">${v.login.userCode}</div>` : nothing}
      ${v.login?.needsCode
        ? html`<input
            class="paste"
            placeholder="Paste the code from the sign-in page"
            autocomplete="off"
            .value=${this.pasted}
            @input=${(e: Event) => (this.pasted = (e.target as HTMLInputElement).value)}
          />`
        : nothing}
      <div class="row">
        ${v.primary
          ? html`<button type="button" class="btn primary" data-testid="chat-sub-fix" ?disabled=${Boolean(v.primary.busy)} @click=${onPrimary}>
              ${v.primary.busy ? html`<span class="spin"></span>` : nothing}${label}
            </button>`
          : nothing}
        ${v.nudge
          ? html`<button type="button" class="link" data-testid="chat-sub-reopen" @click=${() => this.runner.nudge(v.nudge!.action)}>${v.nudge.text}</button>`
          : html`<button type="button" class="link" @click=${() => (this.runner.reset(), this.dismiss())}>Not now</button>`}
      </div>
    `;
  }

  render() {
    const fix = this.fix();
    return html`<div class="card" role="alert" data-testid="chat-sub-error" data-code=${this.code}>
      <div class="head">${icon("alertCircle")}<strong>${TITLE[this.code] ?? TITLE.subscription_failed}</strong></div>
      ${this.message ? html`<p class="msg">${this.message}</p>` : nothing}
      ${this.runner.active
        ? this.renderFlow()
        : html`<div class="row">
            <button type="button" class="btn primary" data-testid="chat-sub-fix" ?disabled=${!this.loaded && this.code !== "subscription_failed" && this.code !== "subscription_timeout"} @click=${fix.run}>
              ${fix.label}
            </button>
            <button type="button" class="link" @click=${() => this.dismiss()}>Dismiss</button>
          </div>`}
    </div>`;
  }

  static styles = css`
    :host { display: block; margin: 10px 0 4px; --gold: var(--glass-gold, var(--g-primary, #d4af37)); }
    .card {
      display: grid; gap: 10px; padding: 14px 16px; border-radius: 16px; color: var(--text);
      border: 1px solid color-mix(in srgb, var(--warn, #e0a33a) 40%, transparent);
      background: color-mix(in srgb, var(--warn, #e0a33a) 7%, var(--panel, transparent));
    }
    .head { display: flex; align-items: center; gap: 8px; font-size: 14.5px; }
    .head svg { width: 17px; height: 17px; color: var(--warn, #e0a33a); flex: none; }
    .msg, .line { margin: 0; font-size: 13.5px; line-height: 1.5; color: var(--muted); overflow-wrap: anywhere; }
    .line { color: var(--text); }
    .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    .btn {
      appearance: none; font: inherit; font-size: 13.5px; font-weight: 600; cursor: pointer; min-height: 40px; padding: 0 16px;
      border-radius: 10px; display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--gold);
      color: var(--bg, #0b0a08); background: linear-gradient(180deg, color-mix(in srgb, var(--gold) 82%, var(--text)), var(--gold));
    }
    .btn[disabled] { opacity: 0.55; cursor: not-allowed; }
    .btn:focus-visible, .link:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
    .link { appearance: none; background: none; border: 0; padding: 4px 2px; font: inherit; font-size: 13px; color: var(--muted); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; min-height: 36px; }
    .link:hover { color: var(--text); }
    .bar { height: 5px; border-radius: 999px; overflow: hidden; background: color-mix(in srgb, var(--text) 8%, transparent); }
    .bar span { display: block; height: 100%; background: var(--gold); border-radius: inherit; transition: width 0.4s; }
    .code { font: 600 22px/1 ui-monospace, monospace; letter-spacing: 0.16em; color: var(--gold); padding: 10px 14px; border-radius: 12px; border: 1px dashed color-mix(in srgb, var(--gold) 50%, transparent); width: fit-content; }
    .paste { min-height: 40px; padding: 0 12px; border-radius: 10px; font: inherit; color: inherit; border: 1px solid var(--border, #444); background: transparent; }
    .spin { width: 13px; height: 13px; border-radius: 50%; border: 2px solid color-mix(in srgb, currentColor 30%, transparent); border-top-color: currentColor; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 520px) { .btn { flex: 1 1 100%; justify-content: center; } }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } .bar span { transition: none; } }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-chat-subscription-card": ChatSubscriptionCard;
  }
}

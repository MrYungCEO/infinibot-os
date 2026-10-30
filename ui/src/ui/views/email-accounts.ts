/**
 * <email-accounts-page> — manage SMTP/IMAP / Gmail / API email accounts.
 *
 * Surface:
 *   • Health-aware account cards (primary badge, label chips, biz badge)
 *   • Add-account wizard (provider pick → autodiscover form → test → meta)
 *   • Edit / delete / set-primary
 *   • Test-connection button per account, with detailed pass/fail
 *
 * Styling rules:
 *   • Pure depth-gradient glassmorphism via the global theme tokens
 *     (--g-primary, --g-surface, .glass-panel) so the page picks up the
 *     active palette without per-component overrides.
 *   • Zero emojis — provider/state glyphs are inline SVGs.
 *
 * The page is invoked from the existing Gmail page (top-right "Manage
 * accounts" button) — no `navigation.ts` changes needed, which keeps
 * this PR out of the lane the Lead-Dashboard agent is currently
 * touching.
 */

import { html, css, LitElement, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { gatewayCall } from "../gateway-client";
import { gatewayOrigin } from "../gateway-endpoint";
import { commIcon, communicationGlassShadowStyles } from "./communication-glass";

type EmailProviderKind = "gmail" | "smtp-imap" | "mailgun" | "sendgrid" | "resend";

interface AccountSummary {
  id: string;
  kind: EmailProviderKind;
  displayName: string;
  address: string;
  isPrimary: boolean;
  labels: string[];
  businessId: string | null;
  outbound: {
    enabled: boolean;
    config: {
      smtpHost?: string;
      smtpPort?: number;
      smtpSecure?: boolean;
      smtpUser?: string;
      smtpPassword?: string;
      fromAddress?: string;
      apiKey?: string;
      apiDomain?: string;
      gmailAccount?: string;
    };
  };
  inbound: {
    enabled: boolean;
    pollIntervalSec?: number;
    config: {
      imapHost?: string;
      imapPort?: number;
      imapSecure?: boolean;
      imapUser?: string;
      imapPassword?: string;
      imapMailbox?: string;
      gmailWatchTopic?: string;
    };
  };
  health: {
    outbound: { ok: boolean; lastCheckedAt: number; lastError?: string };
    inbound: { ok: boolean; lastCheckedAt: number; lastError?: string };
  };
}

interface BusinessOption {
  id: string;
  name: string;
}

interface WizardState {
  step: 1 | 2 | 3 | 4;
  kind: EmailProviderKind;
  address: string;
  displayName: string;
  labels: string[];
  businessId: string | null;
  isPrimary: boolean;
  outbound: AccountSummary["outbound"]["config"] & { enabled: boolean };
  inbound: AccountSummary["inbound"]["config"] & { enabled: boolean; pollIntervalSec?: number };
  sameInboundCreds: boolean;
  discovery?: { source: string; outboundFound?: boolean; inboundFound?: boolean };
  testResult?: {
    outbound?: { ok: boolean; error?: string; latencyMs?: number };
    inbound?: { ok: boolean; error?: string; latencyMs?: number };
  };
  busy: boolean;
  error?: string;
}

interface GmailOauthState {
  redirectUrl: string;
  scopes: string[];
  consentUrl: string | null;
  sessionId: string | null;
  authorizing: boolean;
  copyOk: boolean;
  configLoaded: boolean;
  busy: boolean;
  clientId: string;
  clientSecret: string;
  authCode: string;
  id: string;
  email: string;
  makeDefault: boolean;
  error: string | null;
}

function emptyGmailOauth(): GmailOauthState {
  return {
    redirectUrl: "",
    scopes: [],
    consentUrl: null,
    sessionId: null,
    authorizing: false,
    copyOk: false,
    configLoaded: false,
    busy: false,
    clientId: "",
    clientSecret: "",
    authCode: "",
    id: "",
    email: "",
    makeDefault: true,
    error: null,
  };
}

function emptyWizard(): WizardState {
  return {
    step: 1,
    kind: "smtp-imap",
    address: "",
    displayName: "",
    labels: ["business"],
    businessId: null,
    isPrimary: false,
    outbound: { enabled: true, smtpSecure: false, smtpPort: 587 },
    inbound: { enabled: true, imapSecure: true, imapPort: 993, imapMailbox: "INBOX" },
    sameInboundCreds: true,
    busy: false,
  };
}

@customElement("email-accounts-page")
export class EmailAccountsPage extends LitElement {
  @state() private accounts: AccountSummary[] = [];
  @state() private businesses: BusinessOption[] = [];
  @state() private loading = true;
  @state() private wizard: WizardState | null = null;
  @state() private editingId: string | null = null;
  @state() private actionBusyId: string | null = null;
  @state() private bannerError: string | null = null;

  // ── Gmail OAuth flow state (mirrors gmail.ts connect drawer) ──
  // Kept on the component rather than the wizard object so the poll timer and
  // transient copy/consent state survive re-renders cleanly.
  @state() private gmail: GmailOauthState = emptyGmailOauth();
  private gmailPollTimer: number | null = null;

  static styles = css`
    :host { display: block; padding: 18px; color: var(--g-fg, #f5f5f4); }
    .page-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .page-title { font-size: 18px; font-weight: 600; letter-spacing: 0.2px; }
    .page-sub { color: var(--g-fg-faint, #a3a3ad); font-size: 12px; }
    .spacer { flex: 1; }
    .btn {
      font: inherit; cursor: pointer; padding: 7px 14px; border-radius: 8px;
      border: 1px solid var(--g-border, rgba(255,255,255,0.12));
      background: var(--g-surface, rgba(255,255,255,0.04));
      color: inherit; font-size: 12.5px;
      transition: background 120ms, border 120ms;
    }
    .btn:hover { background: var(--g-surface-hover, rgba(255,255,255,0.08)); }
    .btn-primary {
      border-color: var(--g-primary, rgba(110,167,255,0.5));
      background: linear-gradient(135deg, var(--g-primary, rgba(110,167,255,0.18)), rgba(255,255,255,0.04));
    }
    .btn-danger { color: #f87171; border-color: rgba(248,113,113,0.4); }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .health-strip {
      display: flex; gap: 14px; padding: 10px 14px; margin-bottom: 16px;
      border-radius: 12px;
      background: linear-gradient(180deg, var(--g-surface, rgba(255,255,255,0.04)), transparent);
      border: 1px solid var(--g-border, rgba(255,255,255,0.08));
      font-size: 12px; color: var(--g-fg-faint, #a3a3ad);
    }
    .health-pill { display: inline-flex; align-items: center; gap: 6px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .dot-ok { background: #34d399; box-shadow: 0 0 6px rgba(52,211,153,0.6); }
    .dot-err { background: #f87171; box-shadow: 0 0 6px rgba(248,113,113,0.6); }
    .dot-idle { background: #6b7280; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 14px; }
    .card {
      padding: 14px;
      border-radius: 14px;
      background: linear-gradient(160deg, var(--g-surface, rgba(255,255,255,0.05)), rgba(0,0,0,0.18));
      border: 1px solid var(--g-border, rgba(255,255,255,0.1));
      display: flex; flex-direction: column; gap: 10px;
      backdrop-filter: blur(10px) saturate(140%);
    }
    .card-head { display: flex; align-items: center; gap: 10px; }
    .provider-glyph {
      width: 36px; height: 36px; border-radius: 10px;
      background: rgba(255,255,255,0.05); border: 1px solid var(--g-border, rgba(255,255,255,0.12));
      display: grid; place-items: center; color: var(--g-primary, #6ea7ff);
    }
    .provider-glyph svg { width: 20px; height: 20px; }
    .card-title { font-weight: 600; font-size: 14px; }
    .card-address { font-size: 11.5px; color: var(--g-fg-faint, #a3a3ad); }
    .badges { display: flex; flex-wrap: wrap; gap: 6px; }
    .badge {
      padding: 2px 8px; border-radius: 999px; font-size: 11px;
      background: rgba(255,255,255,0.06); border: 1px solid var(--g-border, rgba(255,255,255,0.1));
    }
    .badge-primary { color: #fde68a; border-color: rgba(253,230,138,0.4); }
    .badge-biz { color: var(--g-primary, #6ea7ff); border-color: rgba(110,167,255,0.4); }
    .card-health { display: flex; gap: 14px; font-size: 11px; color: var(--g-fg-faint, #a3a3ad); }
    .card-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .card-actions .btn { padding: 5px 10px; font-size: 11.5px; }

    .empty {
      text-align: center; padding: 48px 16px;
      color: var(--g-fg-faint, #a3a3ad);
      border: 1px dashed var(--g-border, rgba(255,255,255,0.12));
      border-radius: 14px;
    }
    .empty .big { font-size: 32px; margin-bottom: 6px; }

    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(5,5,8,0.7);
      backdrop-filter: blur(6px); display: grid; place-items: center;
      z-index: 200; padding: 24px;
    }
    .modal {
      width: min(620px, 100%);
      max-height: 90vh; overflow-y: auto;
      background: linear-gradient(180deg, rgba(20,20,28,0.96), rgba(10,10,16,0.96));
      border: 1px solid var(--g-border, rgba(255,255,255,0.12));
      border-radius: 16px; padding: 18px;
      box-shadow: 0 30px 60px rgba(0,0,0,0.5);
    }
    .modal-head { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
    .modal-title { font-weight: 600; font-size: 15px; }
    .step-bar { display: flex; gap: 4px; flex: 1; margin-left: 14px; }
    .step-dot {
      flex: 1; height: 4px; border-radius: 999px;
      background: rgba(255,255,255,0.08);
    }
    .step-dot.active { background: var(--g-primary, #6ea7ff); }
    .step-dot.done { background: rgba(52,211,153,0.7); }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 14px; }
    .form-grid label, .form-stack label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--g-fg-faint, #a3a3ad); }
    .form-stack { display: flex; flex-direction: column; gap: 12px; }
    .input, select, textarea {
      padding: 7px 10px; border-radius: 8px;
      border: 1px solid var(--g-border, rgba(255,255,255,0.14));
      background: rgba(0,0,0,0.35); color: inherit;
      font: inherit; font-size: 12.5px;
    }
    .input:focus, select:focus, textarea:focus {
      outline: none; border-color: var(--g-primary, rgba(110,167,255,0.6));
    }
    .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; }
    .section-title { font-size: 12px; font-weight: 600; margin-top: 6px; color: var(--g-primary, #6ea7ff); text-transform: uppercase; letter-spacing: 0.4px; }
    .footer-row { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
    .footer-row .spacer { flex: 1; }
    .error-box { padding: 8px 10px; border-radius: 8px; background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.3); color: #fca5a5; font-size: 12px; }
    .ok-box { padding: 8px 10px; border-radius: 8px; background: rgba(52,211,153,0.08); border: 1px solid rgba(52,211,153,0.3); color: #a7f3d0; font-size: 12px; }
    .kind-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
    .kind-card {
      padding: 10px; border-radius: 10px; cursor: pointer;
      border: 1px solid var(--g-border, rgba(255,255,255,0.1));
      background: rgba(255,255,255,0.03);
      display: flex; flex-direction: column; gap: 4px;
    }
    .kind-card.selected { border-color: var(--g-primary, #6ea7ff); background: rgba(110,167,255,0.08); }
    .kind-card .glyph { width: 26px; height: 26px; color: var(--g-primary, #6ea7ff); }
    .redirect-row { display: flex; align-items: center; gap: 8px; }
    .redirect-code {
      flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap;
      padding: 7px 10px; border-radius: 8px;
      background: rgba(0,0,0,0.35);
      border: 1px solid var(--g-border, rgba(255,255,255,0.14));
      font-size: 11.5px; color: var(--g-primary, #6ea7ff);
    }
    .form-stack a { color: var(--g-primary, #6ea7ff); }
    .form-stack code {
      background: rgba(0,0,0,0.3); padding: 1px 5px; border-radius: 5px;
      font-size: 11px; color: var(--g-fg, #f5f5f4);
    }
    ${communicationGlassShadowStyles}
    :host { padding: var(--glass-space-5, 20px); }
    .page-head { gap: 14px; }
    .page-title { font-size: clamp(18px, 2vw, 22px); }
    .page-sub { margin-top: 3px; line-height: 1.45; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; font-weight: 620; }
    .btn-primary { box-shadow: var(--glass-elev-2), var(--glass-glow-soft) !important; }
    .btn-danger { color: var(--glass-danger, #ef7373) !important; border-color: color-mix(in srgb, var(--glass-danger, #ef7373) 32%, transparent) !important; }
    .health-strip { border-radius: var(--glass-radius, 14px); box-shadow: var(--glass-elev-1) !important; }
    .card { border-radius: var(--glass-radius-lg, 20px); padding: 16px; transition: transform var(--glass-dur), border-color var(--glass-dur), box-shadow var(--glass-dur); }
    .card:hover { transform: var(--glass-lift, translateY(-2px)); border-color: var(--comms-line-strong) !important; box-shadow: var(--glass-elev-3), var(--glass-glow-soft) !important; }
    .provider-glyph { background: var(--glass-gold-a10); border-color: var(--comms-line) !important; color: var(--comms-gold-hi); box-shadow: inset 0 1px 0 var(--glass-specular); }
    .card-address, .card-health { color: var(--comms-fg-3); }
    .badge { background: var(--glass-hover); }
    .badge-primary { background: var(--glass-gold-tint); color: var(--comms-gold-hi); border-color: var(--comms-line-strong) !important; }
    .badge-biz { color: var(--comms-gold); }
    .modal { border-radius: var(--glass-radius-lg, 20px); padding: 20px; }
    .modal-head { padding-bottom: 14px; border-bottom: 1px solid var(--comms-line); }
    .modal-title { font-size: 17px; letter-spacing: var(--glass-tracking-tight, -.02em); }
    .step-dot { background: var(--glass-hover); }
    .step-dot.active { background: var(--comms-gold); box-shadow: 0 0 10px var(--glass-gold-a40); }
    .step-dot.done { background: var(--glass-ok, #5fd17a); }
    .section-title { color: var(--comms-gold); letter-spacing: var(--glass-tracking-caps, .11em); }
    .kind-card.selected { border-color: var(--comms-line-strong) !important; background: var(--glass-gold-tint) !important; box-shadow: var(--glass-elev-2), var(--glass-glow-soft) !important; }
    .kind-card .glyph, .redirect-code, .form-stack a { color: var(--comms-gold-hi); }
    .redirect-code, .form-stack code { background: color-mix(in srgb, var(--glass-base, #090806) 62%, transparent); border-color: var(--comms-line); color: var(--comms-fg); }
    .error-box, .ok-box { border-radius: var(--glass-radius-sm, 10px); }
    .empty .big + div { color: var(--comms-fg) !important; }
    @media (max-width: 520px) {
      :host { padding: 10px; }
      .page-head { flex-wrap: wrap; }
      .page-head > div:first-child { flex: 1 0 100%; }
      .page-head > .spacer { display: none; }
      .page-head > .btn { flex: 1; min-width: 0; min-height: 42px; }
      .health-strip { flex-wrap: wrap; gap: 8px 14px; }
      .health-strip .spacer { display: none; }
      .card { padding: 14px; }
      .card-health { flex-direction: column; gap: 7px; }
      .card-actions .btn { flex: 1 1 calc(50% - 4px); min-height: 40px; }
      .modal-backdrop { padding: 10px; align-items: end; }
      .modal { max-height: calc(100dvh - 20px); padding: 15px; border-radius: var(--glass-radius-lg, 20px) var(--glass-radius-lg, 20px) 12px 12px; }
      .modal-head { flex-wrap: wrap; }
      .modal-head .step-bar { order: 3; flex-basis: 100%; margin-left: 0; }
      .form-grid { grid-template-columns: minmax(0, 1fr); }
      .kind-row { grid-template-columns: minmax(0, 1fr); }
      .redirect-row { align-items: stretch; flex-direction: column; }
      .footer-row { position: sticky; bottom: -15px; margin-inline: -15px; padding: 12px 15px 15px; background: var(--comms-float); border-top: 1px solid var(--comms-line); }
      .footer-row .btn { min-height: 42px; }
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.bannerError = null;
    try {
      const [accountsRes, businessRes] = await Promise.all([
        gatewayCall<{ accounts: AccountSummary[] }>("email.accounts.list", {}),
        gatewayCall<{ businesses?: BusinessOption[] }>("business.list", {}).catch(() => ({
          businesses: [],
        })),
      ]);
      this.accounts = accountsRes.accounts ?? [];
      this.businesses = (businessRes.businesses ?? []).map((b: any) => ({
        id: b.id,
        name: b.name || b.id,
      }));
    } catch (e) {
      this.bannerError = (e as Error).message;
    } finally {
      this.loading = false;
    }
  }

  // ── Card-level actions ────────────────────────────────────

  private async runTest(account: AccountSummary): Promise<void> {
    this.actionBusyId = account.id;
    try {
      const result = await gatewayCall<{
        outbound?: { ok: boolean; error?: string };
        inbound?: { ok: boolean; error?: string };
      }>("email.accounts.test", { id: account.id, direction: "both" });
      const ok =
        (!account.outbound.enabled || result.outbound?.ok !== false) &&
        (!account.inbound.enabled || result.inbound?.ok !== false);
      const errs: string[] = [];
      if (result.outbound && !result.outbound.ok && result.outbound.error)
        errs.push(`outbound: ${result.outbound.error}`);
      if (result.inbound && !result.inbound.ok && result.inbound.error)
        errs.push(`inbound: ${result.inbound.error}`);
      this.bannerError = ok ? null : errs.join("  ·  ") || "test reported failures";
      await this.refresh();
    } catch (e) {
      this.bannerError = (e as Error).message;
    } finally {
      this.actionBusyId = null;
    }
  }

  private async setPrimary(id: string): Promise<void> {
    this.actionBusyId = id;
    try {
      await gatewayCall("email.accounts.setPrimary", { id });
      await this.refresh();
    } catch (e) {
      this.bannerError = (e as Error).message;
    } finally {
      this.actionBusyId = null;
    }
  }

  private async deleteAccount(id: string): Promise<void> {
    if (!confirm("Delete this email account? Inbound listener will stop immediately.")) return;
    this.actionBusyId = id;
    try {
      await gatewayCall("email.accounts.delete", { id });
      await this.refresh();
    } catch (e) {
      this.bannerError = (e as Error).message;
    } finally {
      this.actionBusyId = null;
    }
  }

  private startEdit(account: AccountSummary): void {
    const w = emptyWizard();
    w.kind = account.kind;
    w.address = account.address;
    w.displayName = account.displayName;
    w.labels = [...account.labels];
    w.businessId = account.businessId;
    w.isPrimary = account.isPrimary;
    w.outbound = { ...account.outbound.config, enabled: account.outbound.enabled };
    w.inbound = {
      ...account.inbound.config,
      enabled: account.inbound.enabled,
      pollIntervalSec: account.inbound.pollIntervalSec,
    };
    w.sameInboundCreds = false;
    w.step = 2; // skip kind picker on edit
    this.wizard = w;
    this.editingId = account.id;
  }

  // ── Wizard ────────────────────────────────────────────────

  private openWizard(): void {
    this.wizard = emptyWizard();
    this.editingId = null;
  }

  private closeWizard(): void {
    this.wizard = null;
    this.editingId = null;
    this.stopGmailPolling();
    this.gmail = emptyGmailOauth();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopGmailPolling();
  }

  // ── Gmail OAuth flow (ported from gmail.ts connect drawer) ─────────
  //
  // Reuses the server-side gmail.oauth.* RPCs — no new endpoints. The
  // confidential-client parameters (scopes, access_type=offline,
  // prompt=consent) are owned by the gateway, so this client only supplies
  // the Client ID / Secret and drives consent + poll + exchange.

  private selectKind(kind: EmailProviderKind): void {
    const w = this.wizard;
    if (!w) return;
    w.kind = kind;
    if (kind === "gmail" && !this.gmail.configLoaded) {
      void this.loadGmailOauthConfig();
    }
    this.requestUpdate();
  }

  private async loadGmailOauthConfig(): Promise<void> {
    // Ask the gateway for the canonical redirect URL (derived from its bind
    // host + port) plus the scopes it will request, so we can show them for
    // Google Cloud Console registration and keep the later exchange's
    // redirect_uri identical.
    // Optimistic fallback FIRST, synchronously: derive the loopback redirect
    // from the page origin so the "Open Google consent" button (gated on
    // `!redirectUrl`) is usable immediately. Otherwise a slow or hung
    // `gmail.oauth.config` RPC leaves redirectUrl "" forever and the flow
    // appears to "grey out" even after creds are entered. The gateway's
    // canonical value only refines this once (if) the RPC comes back.
    this.gmail = {
      ...this.gmail,
      redirectUrl: this.gmail.redirectUrl || `${gatewayOrigin()}/gmail/oauth/callback`,
      configLoaded: true,
    };
    try {
      const res = await gatewayCall<{ redirectUrl: string; scopes: string[] }>(
        "gmail.oauth.config",
        {},
      );
      this.gmail = {
        ...this.gmail,
        redirectUrl: res.redirectUrl || this.gmail.redirectUrl,
        scopes: res.scopes ?? [],
        configLoaded: true,
      };
    } catch (e) {
      // Fallback already applied above — nothing more to do.
      console.warn("[EmailAccounts] gmail.oauth.config failed:", e);
    }
  }

  private async copyGmailRedirect(): Promise<void> {
    if (!this.gmail.redirectUrl) return;
    try {
      await navigator.clipboard.writeText(this.gmail.redirectUrl);
      this.gmail = { ...this.gmail, copyOk: true };
      setTimeout(() => {
        this.gmail = { ...this.gmail, copyOk: false };
      }, 1600);
    } catch {
      /* clipboard may be blocked — user can select the code manually */
    }
  }

  private stopGmailPolling(): void {
    if (this.gmailPollTimer != null) {
      clearInterval(this.gmailPollTimer);
      this.gmailPollTimer = null;
    }
    this.gmail = { ...this.gmail, sessionId: null };
  }

  private setGmail(patch: Partial<GmailOauthState>): void {
    this.gmail = { ...this.gmail, ...patch };
    this.requestUpdate();
  }

  private async startGmailOAuth(): Promise<void> {
    // Validate BEFORE opening consent — a blank/malformed Client ID or Secret
    // otherwise only surfaces as an invalid_client failure at the very end.
    const clientId = this.gmail.clientId.trim();
    const clientSecret = this.gmail.clientSecret.trim();
    if (!clientId) {
      this.setGmail({ error: "Google Client ID is required." });
      return;
    }
    if (!clientId.endsWith(".apps.googleusercontent.com")) {
      this.setGmail({
        error:
          'That does not look like a Google Client ID — it should end with ".apps.googleusercontent.com".',
      });
      return;
    }
    if (!clientSecret) {
      this.setGmail({ error: "Google Client Secret is required (starts with GOCSPX-)." });
      return;
    }

    let url: string;
    let sessionId: string;
    try {
      const r = await gatewayCall<{
        url: string;
        sessionId: string;
        redirectUrl: string;
        scopes: string[];
      }>("gmail.oauth.authUrl", { clientId });
      url = r.url;
      sessionId = r.sessionId;
      this.gmail = {
        ...this.gmail,
        sessionId,
        consentUrl: url,
        // Keep the redirect URL / scopes in lockstep with the auth URL so the
        // later token exchange uses an identical redirect_uri.
        redirectUrl: r.redirectUrl || this.gmail.redirectUrl,
        scopes: Array.isArray(r.scopes) ? r.scopes : this.gmail.scopes,
        authorizing: true,
        error: null,
      };
    } catch (e) {
      this.setGmail({
        error: `Could not start OAuth session: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }

    // window.open returns null when the popup is blocked — detect it so the
    // flow shows a clickable fallback link instead of hanging on "Waiting…".
    let win: Window | null = null;
    try {
      win = window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      win = null;
    }
    if (!win) {
      this.setGmail({
        error:
          "Your browser blocked the consent popup. Use the “Open Google consent in a new tab” link below to authorize, then return here.",
      });
    }
    this.requestUpdate();

    // Poll the gateway every 2s for the parked callback code.
    this.stopGmailPollingTimerOnly();
    this.gmail = { ...this.gmail, sessionId };
    const startedAt = Date.now();
    this.gmailPollTimer = window.setInterval(async () => {
      if (!this.gmail.sessionId) {
        this.stopGmailPollingTimerOnly();
        return;
      }
      if (Date.now() - startedAt > 5 * 60 * 1000) {
        this.stopGmailPolling();
        this.setGmail({
          authorizing: false,
          error: "OAuth timed out (5 min). Reopen the consent flow to try again.",
        });
        return;
      }
      try {
        const r = await gatewayCall<{ code: string | null }>("gmail.oauth.pollCode", {
          sessionId: this.gmail.sessionId,
        });
        if (r.code) {
          this.stopGmailPollingTimerOnly();
          this.gmail = { ...this.gmail, authCode: r.code, sessionId: null };
          await this.completeGmailOAuth();
        }
      } catch (e) {
        // Transient errors are fine — keep polling.
        console.warn("[EmailAccounts] gmail poll failed:", e);
      }
    }, 2000);
  }

  private stopGmailPollingTimerOnly(): void {
    if (this.gmailPollTimer != null) {
      clearInterval(this.gmailPollTimer);
      this.gmailPollTimer = null;
    }
  }

  private async completeGmailOAuth(): Promise<void> {
    const clientId = this.gmail.clientId.trim();
    const clientSecret = this.gmail.clientSecret.trim();
    const authCode = this.gmail.authCode.trim();
    if (!clientId || !clientSecret || !authCode) {
      this.setGmail({
        error: "Client ID, Client Secret, and the authorization code are all required.",
      });
      return;
    }
    if (!this.gmail.redirectUrl) {
      this.setGmail({ error: "Redirect URL not loaded — close and reopen the wizard." });
      return;
    }
    this.setGmail({ busy: true, error: null });
    try {
      // Exchange on the GATEWAY (Node), not the browser — Google's token
      // endpoint has no CORS for confidential-client (client_secret) exchanges.
      // The gateway completes the handshake and persists into
      // integrations.gmail.accounts[].
      const res = await gatewayCall<{ accounts: unknown[]; id?: string; email?: string }>(
        "gmail.oauth.exchange",
        {
          code: authCode,
          clientId,
          clientSecret,
          redirectUri: this.gmail.redirectUrl,
          id: this.gmail.id.trim() || undefined,
          email: this.gmail.email.trim() || undefined,
          makeDefault: this.gmail.makeDefault,
        },
      );
      // Bridge the Gmail integration account into the unified email-accounts
      // store so it shows up in this list and routes outbound sends. This is a
      // client-side call to an EXISTING RPC — no server change.
      const gmailAccountId = res.id ?? this.gmail.id.trim();
      const email = res.email ?? (this.gmail.email.trim() || gmailAccountId);
      if (gmailAccountId) {
        try {
          await gatewayCall("email.accounts.create", {
            kind: "gmail",
            address: email,
            displayName: email,
            labels: ["business"],
            businessId: null,
            isPrimary: this.gmail.makeDefault && this.accounts.length === 0,
            outbound: { enabled: true, config: { gmailAccount: gmailAccountId } },
            inbound: { enabled: true, config: { gmailAccount: gmailAccountId } },
          });
        } catch (e) {
          // If the row already exists (e.g. reconnect), that's fine — the Gmail
          // integration itself succeeded, which is the source of truth.
          console.warn("[EmailAccounts] email.accounts.create for gmail bridge:", e);
        }
      }
      this.stopGmailPolling();
      this.closeWizard();
      await this.refresh();
    } catch (e) {
      this.setGmail({ busy: false, authorizing: false, error: friendlyGmailError(e) });
    }
  }

  private async runDiscover(): Promise<void> {
    if (!this.wizard) return;
    const addr = this.wizard.address.trim();
    if (!addr.includes("@")) return;
    this.wizard.busy = true;
    this.requestUpdate();
    try {
      const result = await gatewayCall<{
        ok: boolean;
        error?: string;
        suggestion?: {
          source: string;
          outbound?: { smtpHost: string; smtpPort: number; smtpSecure: boolean };
          inbound?: { imapHost: string; imapPort: number; imapSecure: boolean };
        };
      }>("email.accounts.discover", { address: addr });
      if (this.wizard && result.ok && result.suggestion) {
        if (result.suggestion.outbound) {
          this.wizard.outbound.smtpHost = result.suggestion.outbound.smtpHost;
          this.wizard.outbound.smtpPort = result.suggestion.outbound.smtpPort;
          this.wizard.outbound.smtpSecure = result.suggestion.outbound.smtpSecure;
        }
        if (result.suggestion.inbound) {
          this.wizard.inbound.imapHost = result.suggestion.inbound.imapHost;
          this.wizard.inbound.imapPort = result.suggestion.inbound.imapPort;
          this.wizard.inbound.imapSecure = result.suggestion.inbound.imapSecure;
        }
        this.wizard.discovery = {
          source: result.suggestion.source,
          outboundFound: !!result.suggestion.outbound,
          inboundFound: !!result.suggestion.inbound,
        };
      } else if (this.wizard) {
        this.wizard.discovery = { source: "none" };
      }
    } finally {
      if (this.wizard) this.wizard.busy = false;
      this.requestUpdate();
    }
  }

  private async runTestInWizard(): Promise<void> {
    if (!this.wizard) return;
    if (!this.editingId) {
      // For new accounts, we need to create the row before we can test it.
      // The wizard saves on test instead so the row exists.
      try {
        await this.saveWizard(false);
      } catch (e) {
        this.wizard.error = (e as Error).message;
        this.requestUpdate();
        return;
      }
    }
    if (!this.editingId) return;
    this.wizard.busy = true;
    this.requestUpdate();
    try {
      const result = await gatewayCall<{
        outbound?: { ok: boolean; error?: string; latencyMs?: number };
        inbound?: { ok: boolean; error?: string; latencyMs?: number };
      }>("email.accounts.test", { id: this.editingId, direction: "both" });
      this.wizard.testResult = result;
    } catch (e) {
      this.wizard.error = (e as Error).message;
    } finally {
      this.wizard.busy = false;
      this.requestUpdate();
    }
  }

  private async saveWizard(closeAfter: boolean): Promise<void> {
    if (!this.wizard) return;
    const w = this.wizard;
    w.busy = true;
    w.error = undefined;
    this.requestUpdate();
    try {
      const inboundConfig = { ...w.inbound };
      if (w.sameInboundCreds && w.kind === "smtp-imap") {
        inboundConfig.imapUser = w.outbound.smtpUser;
        if (w.outbound.smtpPassword) inboundConfig.imapPassword = w.outbound.smtpPassword;
      }
      const payload = {
        kind: w.kind,
        address: w.address,
        displayName: w.displayName || w.address,
        labels: w.labels,
        businessId: w.businessId,
        isPrimary: w.isPrimary,
        outbound: {
          enabled: w.outbound.enabled,
          config: { ...w.outbound, enabled: undefined },
        },
        inbound: {
          enabled: w.inbound.enabled,
          pollIntervalSec: w.inbound.pollIntervalSec,
          config: { ...inboundConfig, enabled: undefined, pollIntervalSec: undefined },
        },
      };
      if (this.editingId) {
        const res = await gatewayCall<{ account: AccountSummary }>("email.accounts.update", {
          id: this.editingId,
          patch: payload,
        });
        if (closeAfter) {
          this.closeWizard();
        }
        await this.refresh();
        return;
      } else {
        const res = await gatewayCall<{ account: AccountSummary }>("email.accounts.create", payload);
        this.editingId = res.account.id;
        if (closeAfter) this.closeWizard();
        await this.refresh();
      }
    } catch (e) {
      w.error = (e as Error).message;
    } finally {
      if (this.wizard) this.wizard.busy = false;
      this.requestUpdate();
    }
  }

  // ── Render ────────────────────────────────────────────────

  render(): TemplateResult {
    return html`
      <div class="page-head">
        <div>
          <div class="page-title">Email Accounts</div>
          <div class="page-sub">SMTP/IMAP, Gmail, and API providers — one per business primary.</div>
        </div>
        <div class="spacer"></div>
        <button class="btn" @click=${() => void this.refresh()} ?disabled=${this.loading}>
          ${commIcon("refresh", 15)} ${this.loading ? "Loading…" : "Refresh"}
        </button>
        <button class="btn btn-primary" @click=${() => this.openWizard()}>${commIcon("mail", 15)} Add account</button>
      </div>

      ${this.bannerError
        ? html`<div class="error-box">${this.bannerError}</div>`
        : nothing}

      ${this.renderHealthStrip()}
      ${this.renderAccountsGrid()}
      ${this.wizard ? this.renderWizard() : nothing}
    `;
  }

  private renderHealthStrip(): TemplateResult | typeof nothing {
    if (this.accounts.length === 0) return nothing;
    const outOk = this.accounts.filter((a) => a.outbound.enabled && a.health.outbound.ok).length;
    const outErr = this.accounts.filter(
      (a) => a.outbound.enabled && !a.health.outbound.ok && a.health.outbound.lastCheckedAt > 0,
    ).length;
    const inOk = this.accounts.filter((a) => a.inbound.enabled && a.health.inbound.ok).length;
    const inErr = this.accounts.filter(
      (a) => a.inbound.enabled && !a.health.inbound.ok && a.health.inbound.lastCheckedAt > 0,
    ).length;
    return html`
      <div class="health-strip">
        <span class="health-pill">
          <span class="dot ${outErr > 0 ? "dot-err" : outOk > 0 ? "dot-ok" : "dot-idle"}"></span>
          Outbound: ${outOk} ok, ${outErr} failing
        </span>
        <span class="health-pill">
          <span class="dot ${inErr > 0 ? "dot-err" : inOk > 0 ? "dot-ok" : "dot-idle"}"></span>
          Inbound: ${inOk} ok, ${inErr} failing
        </span>
        <span class="spacer"></span>
        <span>${this.accounts.length} accounts</span>
      </div>
    `;
  }

  private renderAccountsGrid(): TemplateResult {
    if (this.loading && this.accounts.length === 0) {
      return html`<div class="empty"><div class="big">…</div>Loading email accounts</div>`;
    }
    if (this.accounts.length === 0) {
      return html`
        <div class="empty">
          <div class="big">${providerSvg("smtp-imap")}</div>
          <div style="font-size:14px; color:var(--g-fg);">No email accounts yet</div>
          <div style="margin-top:6px;">
            Connect any provider — Gmail, custom SMTP, Fastmail, IONOS, Mailgun.
          </div>
          <button class="btn btn-primary" style="margin-top:14px" @click=${() => this.openWizard()}>
            ${commIcon("mail", 15)} Add your first account
          </button>
        </div>
      `;
    }
    return html`
      <div class="grid">
        ${this.accounts.map((a) => this.renderAccountCard(a))}
      </div>
    `;
  }

  private renderAccountCard(a: AccountSummary): TemplateResult {
    const busy = this.actionBusyId === a.id;
    return html`
      <div class="card">
        <div class="card-head">
          <div class="provider-glyph">${providerSvg(a.kind)}</div>
          <div style="flex:1; min-width: 0;">
            <div class="card-title">${a.displayName || a.address}</div>
            <div class="card-address">${a.address}</div>
          </div>
        </div>
        <div class="badges">
          ${a.isPrimary ? html`<span class="badge badge-primary">primary</span>` : nothing}
          ${a.businessId
            ? html`<span class="badge badge-biz">${this.businessName(a.businessId)}</span>`
            : html`<span class="badge">personal</span>`}
          ${a.labels.map((l) => html`<span class="badge">${l}</span>`)}
        </div>
        <div class="card-health">
          <span class="health-pill">
            <span class="dot ${healthDot(a.outbound.enabled, a.health.outbound)}"></span>
            Outbound${a.health.outbound.lastError ? html` — <em>${a.health.outbound.lastError}</em>` : nothing}
          </span>
          <span class="health-pill">
            <span class="dot ${healthDot(a.inbound.enabled, a.health.inbound)}"></span>
            Inbound${a.health.inbound.lastError ? html` — <em>${a.health.inbound.lastError}</em>` : nothing}
          </span>
        </div>
        <div class="card-actions">
          <button class="btn" ?disabled=${busy} @click=${() => void this.runTest(a)}>${commIcon("bolt", 14)} Test</button>
          ${a.isPrimary
            ? nothing
            : html`<button class="btn" ?disabled=${busy} @click=${() => void this.setPrimary(a.id)}>${commIcon("star", 14)} Set primary</button>`}
          <button class="btn" ?disabled=${busy} @click=${() => this.startEdit(a)}>${commIcon("edit", 14)} Edit</button>
          <button class="btn btn-danger" ?disabled=${busy} @click=${() => void this.deleteAccount(a.id)}>${commIcon("trash", 14)} Delete</button>
        </div>
      </div>
    `;
  }

  private renderWizard(): TemplateResult {
    const w = this.wizard!;
    const isEdit = !!this.editingId;
    return html`
      <div class="modal-backdrop" @click=${(e: Event) => { if (e.target === e.currentTarget) this.closeWizard(); }}>
        <div class="modal">
          <div class="modal-head">
            <div class="modal-title">${isEdit ? "Edit account" : "Add email account"}</div>
            <div class="step-bar">
              ${[1, 2, 3, 4].map((n) => html`
                <span class="step-dot ${w.step === n ? "active" : w.step > n ? "done" : ""}"></span>
              `)}
            </div>
            <button class="btn" @click=${() => this.closeWizard()}>Close</button>
          </div>
          ${w.error ? html`<div class="error-box">${w.error}</div>` : nothing}
          ${w.kind === "gmail"
            ? html`
                ${w.step === 1 ? this.renderStep1() : nothing}
                ${w.step >= 2 ? this.renderGmailConnect() : nothing}
              `
            : html`
                ${w.step === 1 ? this.renderStep1() : nothing}
                ${w.step === 2 ? this.renderStep2() : nothing}
                ${w.step === 3 ? this.renderStep3() : nothing}
                ${w.step === 4 ? this.renderStep4() : nothing}
              `}
          <div class="footer-row">
            ${w.step > 1 && !isEdit
              ? html`<button class="btn" @click=${() => { w.step = (w.step - 1) as WizardState["step"]; this.requestUpdate(); }}>Back</button>`
              : nothing}
            <div class="spacer"></div>
            ${w.kind === "gmail"
              ? w.step === 1
                ? html`<button class="btn btn-primary"
                    @click=${() => { w.step = 2; this.requestUpdate(); }}
                  >Next</button>`
                : html`<button class="btn" @click=${() => this.closeWizard()}>Done</button>`
              : w.step < 4
                ? html`<button class="btn btn-primary"
                    ?disabled=${w.busy || (w.step === 2 && !w.address.includes("@"))}
                    @click=${() => { w.step = (w.step + 1) as WizardState["step"]; this.requestUpdate(); }}
                  >Next</button>`
                : html`<button class="btn btn-primary" ?disabled=${w.busy} @click=${() => void this.saveWizard(true)}>
                    ${isEdit ? "Save changes" : "Create account"}
                  </button>`}
          </div>
        </div>
      </div>
    `;
  }

  private renderStep1(): TemplateResult {
    const w = this.wizard!;
    const kinds: { key: EmailProviderKind; title: string; sub: string }[] = [
      { key: "smtp-imap", title: "SMTP / IMAP", sub: "Any provider (Fastmail, IONOS, ProtonMail Bridge, etc.)" },
      { key: "gmail", title: "Gmail", sub: "OAuth-based Gmail account" },
      { key: "mailgun", title: "Mailgun", sub: "Transactional API" },
      { key: "sendgrid", title: "SendGrid", sub: "Transactional API" },
      { key: "resend", title: "Resend", sub: "Transactional API" },
    ];
    return html`
      <div class="form-stack">
        <div class="section-title">Provider</div>
        <div class="kind-row">
          ${kinds.map(
            (k) => html`
              <div
                class="kind-card ${w.kind === k.key ? "selected" : ""}"
                @click=${() => this.selectKind(k.key)}
              >
                <div class="glyph">${providerSvg(k.key)}</div>
                <div style="font-weight:600; font-size:13px;">${k.title}</div>
                <div style="font-size:11px; color:var(--g-fg-faint,#a3a3ad);">${k.sub}</div>
              </div>
            `,
          )}
        </div>
        ${w.kind === "gmail"
          ? html`<div class="ok-box">Connect Google directly here — click <strong>Next</strong> to enter your OAuth credentials and authorize.</div>`
          : nothing}
      </div>
    `;
  }

  private renderGmailConnect(): TemplateResult {
    const g = this.gmail;
    // Lazily load the OAuth redirect config whenever this block renders without
    // it. Covers every entry path — not just clicking the Gmail kind-card via
    // selectKind(), but also startEdit() (which jumps straight to step 2 for an
    // existing Gmail account) — so the redirect URL never stays stuck on
    // "Loading…". Deferred to a microtask so we don't mutate reactive state
    // during render; loadGmailOauthConfig() sets configLoaded synchronously so
    // this fires at most once.
    if (!g.configLoaded) {
      queueMicrotask(() => {
        if (!this.gmail.configLoaded) void this.loadGmailOauthConfig();
      });
    }
    return html`
      <div class="form-stack">
        ${g.error ? html`<div class="error-box">${g.error}</div>` : nothing}

        <div class="section-title">1 · Register this redirect URL</div>
        <div style="font-size:11.5px; color:var(--g-fg-faint,#a3a3ad);">
          In
          <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud → Credentials</a>,
          create an <strong>OAuth 2.0 Client ID</strong>. For a <em>Web application</em> client, paste this exact URL into
          <strong>Authorized redirect URIs</strong>.
        </div>
        <div class="redirect-row">
          <code class="redirect-code">${g.redirectUrl || "Loading…"}</code>
          <button class="btn" ?disabled=${!g.redirectUrl} @click=${() => void this.copyGmailRedirect()}>
            ${g.copyOk ? "Copied" : "Copy"}
          </button>
        </div>
        ${g.scopes.length > 0
          ? html`<div style="font-size:11px; color:var(--g-fg-faint,#a3a3ad);">
              Scopes requested:
              ${g.scopes.map((s) => html`<code style="margin-right:4px;">${s.split("/").pop()}</code>`)}
            </div>`
          : nothing}

        <div class="section-title">2 · Google OAuth credentials</div>
        <label>Client ID
          <input class="input" type="text" placeholder="xxxx.apps.googleusercontent.com"
            .value=${g.clientId}
            @input=${(e: Event) => this.setGmail({ clientId: (e.target as HTMLInputElement).value })} />
        </label>
        <label>Client Secret
          <input class="input" type="password" placeholder="GOCSPX-..."
            .value=${g.clientSecret}
            @input=${(e: Event) => this.setGmail({ clientSecret: (e.target as HTMLInputElement).value })} />
        </label>
        <div style="font-size:11px; color:var(--g-fg-faint,#a3a3ad);">
          Enable the
          <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">Gmail API</a>
          on the same Google Cloud project.
        </div>

        <div class="section-title">3 · Authorize the account</div>
        <div style="font-size:11.5px; color:var(--g-fg-faint,#a3a3ad);">
          Opens Google's consent screen in a new tab. After you approve, Google redirects to the URL above and setup
          finishes automatically — no code-pasting needed.
        </div>
        <div class="row">
          <button class="btn btn-primary" ?disabled=${!g.redirectUrl || g.busy}
            @click=${() => void this.startGmailOAuth()}>
            Open Google consent
          </button>
          ${g.authorizing
            ? html`<span style="font-size:11.5px; color:var(--g-fg-faint,#a3a3ad);">Waiting for Google to redirect back…</span>`
            : nothing}
        </div>
        ${g.consentUrl
          ? html`<div style="font-size:11px; color:var(--g-fg-faint,#a3a3ad);">
              Popup blocked or closed?
              <a href=${g.consentUrl} target="_blank" rel="noopener">Open Google consent in a new tab</a>
            </div>`
          : nothing}

        <div class="section-title">4 · Authorization code
          <span style="font-weight:normal; text-transform:none; color:var(--g-fg-faint,#a3a3ad); letter-spacing:0;">(filled automatically)</span>
        </div>
        <label>
          <input class="input" type="text" placeholder="auto-populated after consent"
            .value=${g.authCode}
            @input=${(e: Event) => this.setGmail({ authCode: (e.target as HTMLInputElement).value })} />
        </label>
        <div style="font-size:11px; color:var(--g-fg-faint,#a3a3ad);">
          If automatic capture fails, paste the <code>code=…</code> value from the redirected URL here, then click Connect.
        </div>

        <div class="section-title">5 · Naming</div>
        <div class="form-grid">
          <label>Account ID <span style="opacity:0.7;">(optional)</span>
            <input class="input" type="text" placeholder="auto from email"
              .value=${g.id}
              @input=${(e: Event) => this.setGmail({ id: (e.target as HTMLInputElement).value })} />
          </label>
          <label>Email <span style="opacity:0.7;">(optional — auto-detected)</span>
            <input class="input" type="email" placeholder="you@gmail.com"
              .value=${g.email}
              @input=${(e: Event) => this.setGmail({ email: (e.target as HTMLInputElement).value })} />
          </label>
        </div>
        <label class="check">
          <input type="checkbox" .checked=${g.makeDefault}
            @change=${(e: Event) => this.setGmail({ makeDefault: (e.target as HTMLInputElement).checked })} />
          Make this the default account
        </label>

        <div class="row">
          <button class="btn btn-primary" ?disabled=${g.busy || !g.authCode.trim()}
            @click=${() => void this.completeGmailOAuth()}>
            ${g.busy ? "Connecting…" : "Connect account"}
          </button>
        </div>
      </div>
    `;
  }

  private renderStep2(): TemplateResult {
    const w = this.wizard!;
    const isSmtp = w.kind === "smtp-imap";
    return html`
      <div class="form-stack">
        <div class="section-title">Address & autodiscover</div>
        <div class="row">
          <input
            class="input" type="email" placeholder="you@example.com"
            style="flex:1; min-width: 220px;"
            .value=${w.address}
            @input=${(e: Event) => { w.address = (e.target as HTMLInputElement).value; this.requestUpdate(); }}
            @blur=${() => void this.runDiscover()}
          />
          <button class="btn" ?disabled=${!w.address.includes("@") || w.busy} @click=${() => void this.runDiscover()}>
            ${w.busy ? "Probing…" : "Auto-discover"}
          </button>
        </div>
        ${w.discovery
          ? html`<div class="${w.discovery.source === "none" ? "error-box" : "ok-box"}">
              ${w.discovery.source === "none"
                ? "No autoconfig record found — fill the host/port fields by hand."
                : `Prefilled via ${w.discovery.source} — adjust below as needed.`}
            </div>`
          : nothing}
        ${isSmtp ? this.renderSmtpFields() : html`<div class="error-box">Step 2 only applies to SMTP/IMAP for now.</div>`}
      </div>
    `;
  }

  private renderSmtpFields(): TemplateResult {
    const w = this.wizard!;
    return html`
      <div class="section-title">Outbound (SMTP)</div>
      <div class="form-grid">
        <label>Host
          <input class="input" .value=${w.outbound.smtpHost ?? ""}
            @input=${(e: Event) => { w.outbound.smtpHost = (e.target as HTMLInputElement).value; this.requestUpdate(); }} />
        </label>
        <label>Port
          <input class="input" type="number" .value=${String(w.outbound.smtpPort ?? 587)}
            @input=${(e: Event) => { w.outbound.smtpPort = Number((e.target as HTMLInputElement).value) || undefined; this.requestUpdate(); }} />
        </label>
        <label>Username
          <input class="input" .value=${w.outbound.smtpUser ?? w.address}
            @input=${(e: Event) => { w.outbound.smtpUser = (e.target as HTMLInputElement).value; this.requestUpdate(); }} />
        </label>
        <label>Password ${this.editingId ? html`<span style="font-size:10px; opacity:0.7;">(leave empty to keep current)</span>` : nothing}
          <input class="input" type="password" placeholder="••••••••"
            @input=${(e: Event) => { w.outbound.smtpPassword = (e.target as HTMLInputElement).value; this.requestUpdate(); }} />
        </label>
        <label class="check"><input type="checkbox" .checked=${!!w.outbound.smtpSecure}
          @change=${(e: Event) => { w.outbound.smtpSecure = (e.target as HTMLInputElement).checked; this.requestUpdate(); }} />
          Implicit SSL (port 465)
        </label>
        <label>From address
          <input class="input" placeholder=${w.address} .value=${w.outbound.fromAddress ?? ""}
            @input=${(e: Event) => { w.outbound.fromAddress = (e.target as HTMLInputElement).value; this.requestUpdate(); }} />
        </label>
      </div>

      <div class="section-title">Inbound (IMAP)</div>
      <label class="check">
        <input type="checkbox" .checked=${w.sameInboundCreds}
          @change=${(e: Event) => { w.sameInboundCreds = (e.target as HTMLInputElement).checked; this.requestUpdate(); }} />
        Same credentials as outbound
      </label>
      <div class="form-grid">
        <label>Host
          <input class="input" .value=${w.inbound.imapHost ?? ""}
            @input=${(e: Event) => { w.inbound.imapHost = (e.target as HTMLInputElement).value; this.requestUpdate(); }} />
        </label>
        <label>Port
          <input class="input" type="number" .value=${String(w.inbound.imapPort ?? 993)}
            @input=${(e: Event) => { w.inbound.imapPort = Number((e.target as HTMLInputElement).value) || undefined; this.requestUpdate(); }} />
        </label>
        <label>Mailbox
          <input class="input" .value=${w.inbound.imapMailbox ?? "INBOX"}
            @input=${(e: Event) => { w.inbound.imapMailbox = (e.target as HTMLInputElement).value; this.requestUpdate(); }} />
        </label>
        <label class="check"><input type="checkbox" .checked=${!!w.inbound.imapSecure}
          @change=${(e: Event) => { w.inbound.imapSecure = (e.target as HTMLInputElement).checked; this.requestUpdate(); }} />
          Implicit SSL (port 993)
        </label>
        ${w.sameInboundCreds
          ? nothing
          : html`
              <label>Username
                <input class="input" .value=${w.inbound.imapUser ?? ""}
                  @input=${(e: Event) => { w.inbound.imapUser = (e.target as HTMLInputElement).value; this.requestUpdate(); }} />
              </label>
              <label>Password
                <input class="input" type="password" placeholder="••••••••"
                  @input=${(e: Event) => { w.inbound.imapPassword = (e.target as HTMLInputElement).value; this.requestUpdate(); }} />
              </label>
            `}
      </div>
    `;
  }

  private renderStep3(): TemplateResult {
    const w = this.wizard!;
    const t = w.testResult;
    return html`
      <div class="form-stack">
        <div class="section-title">Test connection</div>
        <div>
          <button class="btn btn-primary" ?disabled=${w.busy} @click=${() => void this.runTestInWizard()}>
            ${w.busy ? "Testing…" : "Run test"}
          </button>
        </div>
        ${t?.outbound
          ? html`<div class="${t.outbound.ok ? "ok-box" : "error-box"}">
              Outbound: ${t.outbound.ok ? `ok in ${t.outbound.latencyMs ?? "?"}ms` : t.outbound.error ?? "failed"}
            </div>`
          : nothing}
        ${t?.inbound
          ? html`<div class="${t.inbound.ok ? "ok-box" : "error-box"}">
              Inbound: ${t.inbound.ok ? `ok in ${t.inbound.latencyMs ?? "?"}ms` : t.inbound.error ?? "failed"}
            </div>`
          : nothing}
      </div>
    `;
  }

  private renderStep4(): TemplateResult {
    const w = this.wizard!;
    return html`
      <div class="form-stack">
        <div class="section-title">Metadata</div>
        <label>Display name
          <input class="input" .value=${w.displayName}
            @input=${(e: Event) => { w.displayName = (e.target as HTMLInputElement).value; this.requestUpdate(); }} />
        </label>
        <label>Labels (comma-separated)
          <input class="input" .value=${w.labels.join(", ")}
            @input=${(e: Event) => { w.labels = (e.target as HTMLInputElement).value.split(",").map((s) => s.trim()).filter(Boolean); this.requestUpdate(); }} />
        </label>
        <label>Business
          <select class="input"
            @change=${(e: Event) => { const v = (e.target as HTMLSelectElement).value; w.businessId = v || null; this.requestUpdate(); }}>
            <option value="" ?selected=${!w.businessId}>— Personal —</option>
            ${this.businesses.map((b) => html`<option value=${b.id} ?selected=${w.businessId === b.id}>${b.name}</option>`)}
          </select>
        </label>
        <label class="check">
          <input type="checkbox" .checked=${w.isPrimary}
            @change=${(e: Event) => { w.isPrimary = (e.target as HTMLInputElement).checked; this.requestUpdate(); }} />
          Set as primary for this business
        </label>
        <label class="check">
          <input type="checkbox" .checked=${w.outbound.enabled}
            @change=${(e: Event) => { w.outbound.enabled = (e.target as HTMLInputElement).checked; this.requestUpdate(); }} />
          Outbound enabled
        </label>
        <label class="check">
          <input type="checkbox" .checked=${w.inbound.enabled}
            @change=${(e: Event) => { w.inbound.enabled = (e.target as HTMLInputElement).checked; this.requestUpdate(); }} />
          Inbound enabled (IMAP listener)
        </label>
      </div>
    `;
  }

  private businessName(id: string): string {
    return this.businesses.find((b) => b.id === id)?.name ?? id;
  }
}

// ── Provider glyphs ──────────────────────────────────────────

function providerSvg(kind: EmailProviderKind): TemplateResult {
  switch (kind) {
    case "gmail":
      return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="m22 6-10 7L2 6"/></svg>`;
    case "smtp-imap":
      return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/><path d="M2 14h6M16 14h6"/></svg>`;
    case "mailgun":
      return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="m20 14-3-1"/></svg>`;
    case "sendgrid":
      return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-11 11"/><path d="M22 2 15 22l-4-9-9-4 20-7z"/></svg>`;
    case "resend":
      return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="m20 4-9 9"/><path d="M10 4H4v16h16v-6"/></svg>`;
  }
}

// Map raw gmail.oauth.exchange failures to actionable guidance. Google returns
// these strings inside the token-endpoint error; the gateway forwards them.
function friendlyGmailError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const low = raw.toLowerCase();
  if (low.includes("oauth client was disabled") || (low.includes("invalid_client") && low.includes("disabled"))) {
    return "Google reports this OAuth client was disabled. Re-enable or recreate the OAuth Client ID in Google Cloud Console → Credentials, and publish the consent screen, then reconnect.";
  }
  if (low.includes("invalid_client")) {
    return "invalid_client — the Client ID or Client Secret is wrong, or the client was deleted. Double-check both values in Google Cloud Console → Credentials.";
  }
  if (low.includes("redirect_uri_mismatch")) {
    return "redirect_uri_mismatch — the redirect URL above is not registered on this OAuth client. Add it verbatim under Authorized redirect URIs in Google Cloud Console, then retry.";
  }
  if (low.includes("no_refresh_token") || low.includes("did not return a refresh_token")) {
    return "Google did not return a refresh token. Revoke this app at myaccount.google.com/permissions and reconnect — the refresh token is only issued on the first consent (access_type=offline + prompt=consent).";
  }
  if (low.includes("invalid_grant")) {
    return "invalid_grant — the authorization code expired or was already used. Reopen Google consent to get a fresh code.";
  }
  return raw;
}

function healthDot(enabled: boolean, h: { ok: boolean; lastCheckedAt: number }): string {
  if (!enabled) return "dot-idle";
  if (h.lastCheckedAt === 0) return "dot-idle";
  return h.ok ? "dot-ok" : "dot-err";
}

declare global {
  interface HTMLElementTagNameMap {
    "email-accounts-page": EmailAccountsPage;
  }
}

export function renderEmailAccountsPage(): TemplateResult {
  return html`<email-accounts-page></email-accounts-page>`;
}

/**
 * <ib-remote-access-setup> — "Reach InfiniBot from anywhere" with Tailscale.
 *
 * Walks a beginner from wherever they are (not installed → not running →
 * signed out → MagicDNS / HTTPS certificates off) to a private
 * https://<machine>.<tailnet>.ts.net link for this gateway, then proves the
 * link answers before showing a green check. Used by the onboarding Phone step
 * and Setup › Remote access (context="settings").
 *
 * Fires `remote-link` ({url, verified}) whenever the link changes, so the
 * phone pairing QR can use it. `?remoteDemo=<step>` renders a fixture state
 * with no RPC calls (visual checks only).
 */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icon } from "../icons.js";
import { renderQrSvg } from "../qr-svg.js";
import {
  REMOTE_LINK_EVENT,
  checklist,
  demoStatus,
  linkFor,
  openExternal,
  osLabel,
  otherMappings,
  remoteDemoState,
  type RemoteStatus,
  type VerifyResult,
} from "../onboarding/remote-access-model.js";

type Requester = { request: (method: string, params?: unknown) => Promise<unknown> };

const POLL_MS = 4000;
/** Steps where we keep checking on our own (the user is doing something elsewhere). */
const WAITING = new Set(["install", "start", "login", "approve", "magicdns", "https"]);

function errText(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(/^Error:\s*/, "").slice(0, 300);
}

@customElement("ib-remote-access-setup")
export class RemoteAccessSetup extends LitElement {
  @property({ attribute: false }) client: Requester | null = null;
  @property({ reflect: true }) context: "onboarding" | "settings" = "onboarding";

  @state() private status: RemoteStatus | null = null;
  @state() private loading = false;
  @state() private busy: "login" | "create" | "verify" | "remove" | null = null;
  @state() private error: string | null = null;
  @state() private note: string | null = null;
  @state() private authUrl: string | null = null;
  @state() private verify: VerifyResult | null = null;
  @state() private showQr = false;
  @state() private copied = false;
  @state() private openedHow: string | null = null;

  private readonly demo = remoteDemoState();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private verifiedFor: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    if (this.demo) {
      this.status = demoStatus(this.demo);
      if (this.demo === "ready") this.verify = { ok: true, url: linkFor(this.status)!, ms: 412, checks: [] };
      return;
    }
    if (this.client) void this.load();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopPoll();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("client") && this.client && !this.status && !this.loading && !this.demo) void this.load();
  }

  private async rpc<T>(method: string, params?: unknown): Promise<T> {
    if (!this.client) throw new Error("Not connected to InfiniBot yet.");
    return (await this.client.request(method, params ?? {})) as T;
  }

  /** Re-read the status; on a new link, verify it. */
  async load(quiet = false): Promise<void> {
    if (this.demo) return;
    if (!quiet) this.loading = true;
    try {
      const s = await this.rpc<RemoteStatus>("network.tailscale.remote.status");
      this.status = s;
      if (s.nextStep !== "login") this.authUrl = null;
      if (!quiet) this.error = null;
      if (WAITING.has(s.nextStep)) this.startPoll();
      else this.stopPoll();
      const link = linkFor(s);
      if (link && this.verifiedFor !== link) void this.runVerify(link);
      if (!link) this.emit(null, false);
    } catch (err) {
      if (!quiet) this.error = errText(err);
    } finally {
      this.loading = false;
    }
  }

  private startPoll() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.load(true), POLL_MS);
  }

  private stopPoll() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private emit(url: string | null, verified: boolean) {
    this.dispatchEvent(new CustomEvent(REMOTE_LINK_EVENT, { detail: { url, verified }, bubbles: true, composed: true }));
  }

  private async open(url: string) {
    if (this.demo) {
      this.openedHow = "Demo: nothing opened.";
      return;
    }
    const how = await openExternal(url, this.client);
    this.openedHow = how === "tab" ? "Opened in a new browser tab." : "Opened in your web browser.";
  }

  private async signIn() {
    this.busy = "login";
    this.error = null;
    try {
      const r = await this.rpc<{ authUrl: string | null; connected: boolean; output: string }>("network.tailscale.remote.login");
      if (r.authUrl) {
        this.authUrl = r.authUrl;
        await this.open(r.authUrl);
      } else if (!r.connected) {
        this.error = r.output.trim()
          ? `Tailscale said: ${r.output.trim().slice(-240)}`
          : "Tailscale didn't give a sign-in link. Open the Tailscale app and sign in there.";
      }
      this.startPoll();
      await this.load(true);
    } catch (err) {
      this.error = errText(err);
    } finally {
      this.busy = null;
    }
  }

  private async create() {
    this.busy = "create";
    this.error = null;
    this.note = null;
    try {
      const r = await this.rpc<{ url: string; httpsPort: number; reused: boolean; note: string | null }>("network.tailscale.remote.create");
      this.note = r.note ?? (r.reused ? "This computer already had a link for InfiniBot, so it's reused." : null);
      this.verifiedFor = null;
      await this.load(true);
    } catch (err) {
      this.error = errText(err);
    } finally {
      this.busy = null;
    }
  }

  private async runVerify(url: string) {
    this.busy = "verify";
    this.verify = null;
    this.verifiedFor = url;
    try {
      this.verify = await this.rpc<VerifyResult>("network.tailscale.remote.verify", { url });
    } catch (err) {
      this.verify = { ok: false, url, ms: 0, checks: [{ path: "/", ok: false, status: null, detail: errText(err) }] };
    } finally {
      this.busy = null;
      this.emit(url, Boolean(this.verify?.ok));
    }
  }

  private async removeLink() {
    const m = this.status?.gatewayMapping;
    if (!m) return;
    this.busy = "remove";
    this.error = null;
    try {
      await this.rpc("network.tailscale.remote.remove", { httpsPort: m.port });
      this.verify = null;
      this.verifiedFor = null;
      this.note = "The link is off. Nothing else this computer shares was changed.";
      await this.load(true);
    } catch (err) {
      this.error = errText(err);
    } finally {
      this.busy = null;
    }
  }

  private async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.copied = true;
      setTimeout(() => (this.copied = false), 1600);
    } catch {
      this.error = "Couldn't copy. Select the link and copy it by hand.";
    }
  }

  // ── render ──

  private renderChecklist() {
    return html`<ul class="checks" data-testid="ra-checks">
      ${checklist(this.status).map(
        (c) => html`<li class="check is-${c.state}" data-check=${c.id} data-state=${c.state} title=${c.label}>
          <span class="check__dot">${c.state === "ok" ? icon("check") : c.state === "todo" ? icon("circle") : icon("clock")}</span>
          <span>${c.label}</span>
        </li>`,
      )}
    </ul>`;
  }

  private waiting(text: string) {
    return html`<p class="wait" data-testid="ra-waiting"><span class="spin"></span>${text}</p>`;
  }

  private renderAction(s: RemoteStatus): TemplateResult {
    const os = osLabel(s.platform);
    switch (s.nextStep) {
      case "install":
        return html`<div class="act" data-testid="ra-install">
          <p>Tailscale makes a private network between your devices, so your phone can reach InfiniBot from anywhere. It's free for personal use.</p>
          <div class="row">
            <button class="btn primary" data-testid="ra-download" @click=${() => void this.open(s.downloadUrl)}>
              ${icon("download")} Download Tailscale for ${os}
            </button>
            <button class="btn" @click=${() => void this.load()}>${icon("refresh")} I've installed it</button>
          </div>
          ${s.platform === "linux"
            ? html`<p class="hint">Or in a terminal: <code>curl -fsSL https://tailscale.com/install.sh | sh</code></p>`
            : html`<p class="hint">Run the installer, then come back here. We'll notice when it's done.</p>`}
          ${this.waiting("Watching for Tailscale…")}
        </div>`;
      case "start":
        return html`<div class="act" data-testid="ra-start">
          <p>${s.message}</p>
          <p class="hint">${s.platform === "linux" ? html`On Linux: <code>sudo systemctl enable --now tailscaled</code>` : html`Open <b>Tailscale</b> from the ${s.platform === "darwin" ? "menu bar or Applications" : "Start menu or the system tray"}.`}</p>
          <div class="row"><button class="btn" @click=${() => void this.load()}>${icon("refresh")} Check again</button></div>
          ${this.waiting("Waiting for Tailscale to start…")}
        </div>`;
      case "login":
        return html`<div class="act" data-testid="ra-login">
          <p>${s.backendState === "Stopped" ? "Tailscale is signed in but switched off." : "Sign in to Tailscale with Google, Microsoft, GitHub or Apple. A browser window opens for it."}</p>
          <div class="row">
            <button class="btn primary" data-testid="ra-signin" ?disabled=${this.busy === "login"} @click=${() => void this.signIn()}>
              ${icon("lock")} ${this.busy === "login" ? "Starting…" : s.backendState === "Stopped" ? "Turn Tailscale on" : "Sign in to Tailscale"}
            </button>
          </div>
          ${this.authUrl
            ? html`<p class="hint">Browser didn't open? <a href=${this.authUrl} target="_blank" rel="noopener" @click=${(e: Event) => { e.preventDefault(); void this.open(this.authUrl!); }}>Open the sign-in page</a></p>
                ${this.waiting("Waiting for you to finish signing in…")}`
            : nothing}
        </div>`;
      case "approve":
        return html`<div class="act" data-testid="ra-approve">
          <p>${s.message}</p>
          <div class="row">
            <button class="btn primary" @click=${() => void this.open("https://login.tailscale.com/admin/machines")}>${icon("externalLink")} Open Machines</button>
          </div>
          ${this.waiting("Waiting for approval…")}
        </div>`;
      case "magicdns":
      case "https":
        return html`<div class="act" data-testid=${`ra-${s.nextStep}`}>
          <p>${s.message}</p>
          <ol class="steps">
            <li>Open the DNS page of the Tailscale admin console.</li>
            ${s.nextStep === "magicdns"
              ? html`<li>Under <b>MagicDNS</b>, click <b>Enable MagicDNS</b>.</li><li>Then, under <b>HTTPS Certificates</b>, click <b>Enable HTTPS</b>.</li>`
              : html`<li>Under <b>HTTPS Certificates</b>, click <b>Enable HTTPS</b> and confirm.</li>`}
            <li>Come back here. We check again by ourselves.</li>
          </ol>
          <div class="row">
            <button class="btn primary" data-testid="ra-admin-dns" @click=${() => void this.open(s.adminDnsUrl)}>${icon("externalLink")} Open DNS settings</button>
            <button class="btn" @click=${() => void this.load()}>${icon("refresh")} Check again</button>
          </div>
          ${this.waiting("Watching for the change…")}
        </div>`;
      case "create":
        return html`<div class="act" data-testid="ra-create">
          <p>Everything's ready. InfiniBot will make a private link that only your own devices signed in to <b>${s.account ?? "your tailnet"}</b> can open.</p>
          <div class="row">
            <button class="btn primary" data-testid="ra-create-btn" ?disabled=${this.busy === "create"} @click=${() => void this.create()}>
              ${icon("link")} ${this.busy === "create" ? "Creating…" : "Create my private link"}
            </button>
          </div>
          ${s.mappings.length
            ? html`<p class="hint">This computer already shares ${s.mappings.length} other ${s.mappings.length === 1 ? "thing" : "things"} over Tailscale. Those stay exactly as they are.</p>`
            : nothing}
        </div>`;
      case "ready":
        return this.renderReady(s);
    }
  }

  private renderReady(s: RemoteStatus): TemplateResult {
    const url = linkFor(s)!;
    const v = this.verify;
    const checking = this.busy === "verify" || (!v && this.verifiedFor === url);
    let qr = "";
    if (this.showQr) {
      try {
        qr = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderQrSvg(url))}`;
      } catch {
        qr = "";
      }
    }
    const others = otherMappings(s);
    return html`<div class="act" data-testid="ra-ready">
      <div class="link ${v?.ok ? "is-ok" : v ? "is-bad" : ""}">
        <span class="link__icon">${v?.ok ? icon("checkCircle") : v ? icon("alert") : icon("link")}</span>
        <code class="link__url" data-testid="ra-url">${url}</code>
      </div>
      <p class="verify ${v?.ok ? "ok" : v ? "bad" : ""}" data-testid="ra-verify" data-ok=${v ? String(v.ok) : "pending"}>
        ${checking
          ? html`<span class="spin"></span>Checking the link answers…`
          : v?.ok
            ? html`It works. InfiniBot answered over Tailscale in ${v.ms} ms.`
            : v
              ? html`The link didn't answer yet: ${v.checks.filter((c) => !c.ok).map((c) => `${c.path} ${c.detail}`).join("; ")}. Wait a few seconds and check again.`
              : nothing}
      </p>
      <div class="row">
        <button class="btn" data-testid="ra-copy" @click=${() => void this.copy(url)}>${icon("copy")} ${this.copied ? "Copied" : "Copy"}</button>
        <button class="btn" data-testid="ra-qr" @click=${() => (this.showQr = !this.showQr)}>${icon("smartphone")} ${this.showQr ? "Hide QR" : "QR code"}</button>
        <button class="btn" data-testid="ra-open" @click=${() => void this.open(url)}>${icon("externalLink")} Open</button>
        <button class="btn" ?disabled=${checking} @click=${() => void this.runVerify(url)}>${icon("refresh")} Check again</button>
      </div>
      ${this.showQr && qr ? html`<img class="qr" data-testid="ra-qr-img" alt="QR code for ${url}" src=${qr} />` : nothing}
      <p class="hint">Saved as your phone link, so the pairing code on the next screen uses it. Only devices signed in to your Tailscale account can open it, so install Tailscale on your phone too (App Store or Google Play) and sign in with the same account.</p>
      ${others.length
        ? html`<details class="others"><summary>${others.length} other ${others.length === 1 ? "link" : "links"} on this computer (unchanged)</summary>
            <ul>${others.map((m) => html`<li><code>${m.url}</code> → ${m.target}${m.funnel ? " (public)" : ""}</li>`)}</ul>
          </details>`
        : nothing}
      ${this.context === "settings"
        ? html`<div class="row"><button class="btn danger" data-testid="ra-remove" ?disabled=${this.busy === "remove"} @click=${() => void this.removeLink()}>${icon("xCircle")} Turn off this link</button></div>`
        : nothing}
    </div>`;
  }

  render() {
    const s = this.status;
    return html`<section class="card" data-testid="remote-access" data-step=${s?.nextStep ?? "loading"}>
      <header class="head">
        <span class="head__icon">${icon("globe")}</span>
        <div>
          <div class="eyebrow">Tailscale · private · free</div>
          <h3>Reach InfiniBot from anywhere</h3>
          <p class="sub">Use InfiniBot from your phone on mobile data or any Wi-Fi, not just at home. Nothing is opened to the public internet.</p>
        </div>
      </header>
      ${this.demo ? html`<p class="demo">Demo preview: ${this.demo}. Nothing here is real.</p>` : nothing}
      ${this.renderChecklist()}
      ${this.note ? html`<p class="note" data-testid="ra-note">${icon("shieldCheck")} ${this.note}</p>` : nothing}
      ${s ? this.renderAction(s) : this.loading ? this.waiting("Checking Tailscale on this computer…") : nothing}
      ${this.openedHow ? html`<p class="hint">${this.openedHow}</p>` : nothing}
      ${this.error ? html`<p class="err" role="alert" data-testid="ra-error">${icon("alert")} ${this.error}</p>` : nothing}
    </section>`;
  }

  static styles = css`
    :host { display: block; color: var(--text, #e8e6e1); font-size: 14px; }
    .card { border: 1px solid rgba(212, 175, 55, 0.22); border-radius: 16px; padding: 20px 22px; background: rgba(12, 12, 16, 0.72); display: grid; gap: 14px; }
    .head { display: flex; gap: 14px; align-items: flex-start; }
    .head__icon { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; color: #d4af37; background: rgba(212, 175, 55, 0.1); border: 1px solid rgba(212, 175, 55, 0.25); flex-shrink: 0; }
    .head__icon svg { width: 20px; height: 20px; }
    .eyebrow { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #d4af37; font-weight: 650; }
    h3 { margin: 2px 0 4px; font-size: 17px; font-weight: 650; color: #fff; }
    .sub { margin: 0; color: rgba(255, 255, 255, 0.6); line-height: 1.5; }
    .checks { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .check > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    :host([context="onboarding"]) .card { border: none; background: transparent; padding: 0; }
    .check { display: flex; gap: 8px; align-items: center; padding: 8px 10px; border-radius: 10px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.06); color: rgba(255, 255, 255, 0.65); }
    .check__dot { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; flex-shrink: 0; }
    .check__dot svg { width: 13px; height: 13px; }
    .check.is-ok { color: #fff; border-color: rgba(74, 222, 128, 0.25); }
    .check.is-ok .check__dot { background: rgba(74, 222, 128, 0.16); color: #4ade80; }
    .check.is-todo .check__dot { color: #d4af37; }
    .check.is-unknown .check__dot { color: rgba(255, 255, 255, 0.35); }
    .act { display: grid; gap: 10px; }
    .act p { margin: 0; line-height: 1.55; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    .btn { display: inline-flex; align-items: center; gap: 7px; padding: 9px 14px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.14); background: rgba(255, 255, 255, 0.05); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
    .btn:hover:not(:disabled) { border-color: rgba(212, 175, 55, 0.5); }
    .btn:disabled { opacity: 0.55; cursor: progress; }
    .btn.primary { background: linear-gradient(135deg, #d4af37, #b8902a); color: #111; border-color: #c9951d; }
    .btn.danger { color: #fca5a5; border-color: rgba(248, 113, 113, 0.35); }
    .btn svg { width: 15px; height: 15px; }
    .hint { color: rgba(255, 255, 255, 0.55); font-size: 13px; }
    .hint a { color: #d4af37; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; background: rgba(255, 255, 255, 0.06); padding: 2px 6px; border-radius: 6px; word-break: break-all; }
    .steps { margin: 0; padding-left: 20px; display: grid; gap: 4px; color: rgba(255, 255, 255, 0.8); line-height: 1.5; }
    .wait { display: flex; align-items: center; gap: 8px; color: rgba(255, 255, 255, 0.55); font-size: 13px; }
    .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid rgba(212, 175, 55, 0.25); border-top-color: #d4af37; animation: spin 0.9s linear infinite; flex-shrink: 0; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .link { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: 12px; background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(212, 175, 55, 0.3); }
    .link.is-ok { border-color: rgba(74, 222, 128, 0.45); }
    .link.is-bad { border-color: rgba(248, 113, 113, 0.45); }
    .link__icon { color: #d4af37; display: grid; }
    .link.is-ok .link__icon { color: #4ade80; }
    .link.is-bad .link__icon { color: #f87171; }
    .link__icon svg { width: 18px; height: 18px; }
    .link__url { background: none; padding: 0; font-size: 14px; color: #fff; }
    .verify { font-size: 13px; color: rgba(255, 255, 255, 0.6); display: flex; gap: 8px; align-items: center; }
    .verify.ok { color: #4ade80; }
    .verify.bad { color: #fca5a5; }
    .qr { width: 196px; height: 196px; background: #fff; padding: 8px; border-radius: 12px; image-rendering: pixelated; }
    .others { color: rgba(255, 255, 255, 0.55); font-size: 13px; }
    .others ul { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 3px; }
    .note { margin: 0; display: flex; gap: 8px; align-items: flex-start; color: #e9d48b; font-size: 13px; line-height: 1.5; }
    .note svg, .err svg { width: 15px; height: 15px; flex-shrink: 0; margin-top: 2px; }
    .err { margin: 0; display: flex; gap: 8px; color: #fca5a5; font-size: 13px; line-height: 1.5; }
    .demo { margin: 0; font-size: 12px; color: #fbbf24; }
    @media (max-width: 560px) { .checks { grid-template-columns: 1fr; } .card { padding: 16px; } .btn { flex: 1 1 auto; justify-content: center; } }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-remote-access-setup": RemoteAccessSetup;
  }
}

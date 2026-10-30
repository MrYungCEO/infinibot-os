/**
 * <ib-phone-app-setup> — "Put InfiniBot on your phone": pick Android or
 * iPhone, see the install paths that really exist today (Android APK served by
 * this gateway when one is published, the phone web app at /mobile-web on any
 * phone, store builds "coming soon"), scan a QR, and get Add to Home Screen
 * steps for Safari / Chrome.
 *
 * Links use the Tailscale link from <ib-remote-access-setup> (`remoteUrl`)
 * when there is one, else this computer's Wi-Fi address with a same-Wi-Fi
 * warning. The Android app pairing QR carries the gateway secret (same payload
 * as the Mobile page, ../mobile-pairing.ts) and stays hidden until revealed.
 */
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ensureGatewaySession, gatewayHttpBase } from "../gateway-http-auth.js";
import { icon } from "../icons.js";
import { buildMobilePairingPayload, pickPairingGatewayUrl } from "../mobile-pairing.js";
import { renderQrSvg } from "../qr-svg.js";
import {
  homeScreenSteps,
  installPaths,
  lanBase,
  openExternal,
  phoneWebAppUrl,
  type PhoneOs,
} from "../onboarding/remote-access-model.js";

type Requester = { request: (method: string, params?: unknown) => Promise<unknown> };

type MobileConfigGet = {
  config?: { gatewayUrlOverride?: string };
  suggested?: { gatewayUrl?: string; gatewayToken?: string | null; lanAddress?: string | null };
};

const REVEAL_MS = 120_000;
const SETTINGS_KEY = "infinibot.control.settings.v1";

function qrData(text: string): string {
  try {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderQrSvg(text))}`;
  } catch {
    return "";
  }
}

function browserSecret(): { password: string | null; token: string | null } {
  try {
    const v = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as { password?: string; token?: string } | null;
    const password = v?.password?.trim() || "";
    const token = v?.token?.trim() || "";
    return { password: password || null, token: password ? null : token || null };
  } catch {
    return { password: null, token: null };
  }
}

@customElement("ib-phone-app-setup")
export class PhoneAppSetup extends LitElement {
  @property({ attribute: false }) client: Requester | null = null;
  /** Verified Tailscale link (https://…ts.net[:port]) or null. */
  @property({ attribute: false }) remoteUrl: string | null = null;
  @property({ type: Boolean }) remoteVerified = false;
  @property({ reflect: true }) context: "onboarding" | "settings" = "onboarding";

  @state() private os: PhoneOs | null = null;
  @state() private cfg: MobileConfigGet | null = null;
  @state() private apk: { available: boolean; version?: string; error?: string } | null = null;
  @state() private apkLink: { url: string; expiresAt: number } | null = null;
  @state() private apkBusy = false;
  @state() private revealUntil = 0;
  @state() private copied: string | null = null;
  @state() private error: string | null = null;
  private loaded = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    const pick = new URLSearchParams(window.location.search).get("phoneOs");
    if (pick === "android" || pick === "iphone") this.os = pick;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.hideTimer) clearTimeout(this.hideTimer);
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("client") && this.client && !this.loaded) {
      this.loaded = true;
      void this.load();
    }
    if (changed.has("remoteUrl")) this.apkLink = null;
  }

  private async load() {
    try {
      this.cfg = (await this.client!.request("mobile.config.get", {})) as MobileConfigGet;
    } catch {
      this.cfg = {};
    }
    try {
      await ensureGatewaySession();
      const res = await fetch(`${gatewayHttpBase()}/api/mobile/apk`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.apk = (await res.json()) as { available: boolean; version?: string };
    } catch (err) {
      this.apk = { available: false, error: String((err as Error)?.message ?? err) };
    }
  }

  private port(): number {
    const m = /:(\d+)(?:\/|$)/.exec(this.cfg?.suggested?.gatewayUrl ?? "");
    if (m) return Number(m[1]);
    return Number(window.location.port) || 18789;
  }

  /** Base the phone uses: the Tailscale link, else Wi-Fi (LAN) address. */
  private base(): { url: string | null; remote: boolean } {
    if (this.remoteUrl) return { url: this.remoteUrl.replace(/\/+$/, ""), remote: true };
    return { url: lanBase(this.cfg?.suggested?.lanAddress, this.port()), remote: false };
  }

  private async copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.copied = id;
      setTimeout(() => (this.copied = null), 1600);
    } catch {
      this.error = "Couldn't copy. Select the link and copy it by hand.";
    }
  }

  private async makeApkLink(baseUrl: string) {
    this.apkBusy = true;
    this.error = null;
    try {
      const res = await fetch(`${gatewayHttpBase()}/api/mobile/apk/link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { url: string; expiresAt: number };
      this.apkLink = { url: body.url, expiresAt: body.expiresAt };
    } catch (err) {
      this.error = `Couldn't make the download link: ${String((err as Error)?.message ?? err)}`;
    } finally {
      this.apkBusy = false;
    }
  }

  private reveal(on: boolean) {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.revealUntil = on ? Date.now() + REVEAL_MS : 0;
    if (on) this.hideTimer = setTimeout(() => (this.revealUntil = 0), REVEAL_MS);
  }

  private renderChooser() {
    const card = (id: PhoneOs, label: string, sub: string, glyph: "android" | "apple") => html`
      <button type="button" role="radio" aria-checked=${this.os === id ? "true" : "false"} class="os ${this.os === id ? "is-on" : ""}"
        data-testid=${`phone-os-${id}`} @click=${() => (this.os = id)}>
        <span class="os__icon">${icon(glyph)}</span>
        <span class="os__text"><b>${label}</b><span>${sub}</span></span>
      </button>`;
    return html`<div class="oses" role="radiogroup" aria-label="Your phone">
      ${card("android", "Android", "Samsung, Pixel, Xiaomi, …", "android")}
      ${card("iphone", "iPhone", "iPhone and iPad", "apple")}
    </div>`;
  }

  private renderLinkBlock(id: string, title: string, url: string, sub: string) {
    const qr = qrData(url);
    return html`<div class="qrblock" data-testid=${`phone-link-${id}`}>
      ${qr ? html`<img class="qr" alt="QR code: ${title}" src=${qr} />` : nothing}
      <div class="qrside">
        <div class="k">${title}</div>
        <code data-testid=${`phone-url-${id}`}>${url}</code>
        <p class="hint">${sub}</p>
        <div class="row">
          <button class="btn" @click=${() => void this.copy(url, id)}>${icon("copy")} ${this.copied === id ? "Copied" : "Copy"}</button>
          <button class="btn" @click=${() => void openExternal(url, this.client)}>${icon("externalLink")} Open</button>
        </div>
      </div>
    </div>`;
  }

  private renderPairing(base: { url: string | null; remote: boolean }) {
    const { password, token } = browserSecret();
    const secretPw = password ?? this.cfg?.suggested?.gatewayToken ?? null;
    const gatewayUrl = pickPairingGatewayUrl({
      override: base.remote ? base.url : this.cfg?.config?.gatewayUrlOverride ?? null,
      gatewayUrl: base.url,
      port: this.port(),
    });
    const kind = secretPw ? "password" : token ? "token" : null;
    const payload = gatewayUrl && kind ? buildMobilePairingPayload({ gatewayUrl, password: secretPw, token }) : "";
    const revealed = this.revealUntil > Date.now() && payload;
    return html`<div class="pair" data-testid="phone-pair">
      <div class="k">Connect the Android app</div>
      <p class="hint">In the app choose <b>Self-hosted gateway › Scan pairing QR</b>. The code holds this computer's address and your
        ${kind ?? "password"}, so it stays hidden until you reveal it.</p>
      <div class="addr"><span class="hint">Address</span><code data-testid="phone-pair-url">${gatewayUrl || "unknown"}</code></div>
      ${revealed
        ? html`<img class="qr" data-testid="phone-pair-qr" alt="Pairing QR" src=${qrData(payload)} />
            <div class="row"><button class="btn" @click=${() => this.reveal(false)}>${icon("eye")} Hide</button></div>`
        : html`<div class="row"><button class="btn primary" data-testid="phone-pair-reveal" ?disabled=${!payload} @click=${() => this.reveal(true)}>
            ${icon("eye")} Reveal pairing QR</button></div>
            ${payload ? nothing : html`<p class="hint">This browser has no saved password, so type it in the app by hand.</p>`}`}
    </div>`;
  }

  render() {
    const base = this.base();
    const os = this.os;
    return html`<section class="card" data-testid="phone-app-setup" data-os=${os ?? "none"}>
      <div class="k">Which phone do you have?</div>
      ${this.renderChooser()}
      ${os
        ? html`
            ${base.remote
              ? html`<p class="ok" data-testid="phone-base-remote">${icon("checkCircle")} Using your private Tailscale link, so this works on mobile data and any Wi-Fi${this.remoteVerified ? "" : " (still checking it answers)"}.</p>`
              : html`<p class="warn" data-testid="phone-base-lan">${icon("alert")} No Tailscale link yet, so these links only work while your phone is on the <b>same Wi-Fi</b> as this computer. Set up "Reach InfiniBot from anywhere" above to use it everywhere.</p>`}
            <ul class="paths" data-testid="phone-paths">
              ${installPaths(os, this.apk).map(
                (p) => html`<li class="path is-${p.status}" data-path=${p.id} data-status=${p.status}>
                  <span class="chip">${p.status === "available" ? "Available" : p.status === "coming-soon" ? "Coming soon" : "Not set up"}</span>
                  <b>${p.title}</b><span class="hint">${p.body}</span>
                </li>`,
              )}
            </ul>
            ${base.url
              ? html`
                  ${os === "android" && this.apk?.available
                    ? this.apkLink
                      ? this.renderLinkBlock("apk", "1. Download the Android app", this.apkLink.url, "Scan with the phone's camera. The download link works for 15 minutes.")
                      : html`<div class="row"><button class="btn primary" data-testid="phone-apk-link" ?disabled=${this.apkBusy}
                          @click=${() => void this.makeApkLink(base.url!)}>${icon("download")} ${this.apkBusy ? "Making link…" : "Get the Android app download QR"}</button></div>`
                    : nothing}
                  ${os === "android" && this.apk?.available ? this.renderPairing(base) : nothing}
                  ${this.renderLinkBlock(
                    "pwa",
                    os === "iphone" ? "Open InfiniBot on your iPhone" : this.apk?.available ? "Or use the web app" : "Open InfiniBot on your phone",
                    phoneWebAppUrl(base.url),
                    os === "iphone" ? "Scan with the Camera app; it opens in Safari. Sign in with your InfiniBot password." : "Scan with the camera; it opens in Chrome. Sign in with your InfiniBot password.",
                  )}
                  <div class="a2hs" data-testid=${`phone-a2hs-${os}`}>
                    <div class="k">Add to Home Screen (${os === "iphone" ? "iPhone Safari" : "Android Chrome"})</div>
                    <ol>${homeScreenSteps(os).map((s) => html`<li>${s}</li>`)}</ol>
                  </div>`
              : html`<p class="hint">Finding this computer's address…</p>`}
          `
        : nothing}
      ${this.error ? html`<p class="err" role="alert">${icon("alert")} ${this.error}</p>` : nothing}
    </section>`;
  }

  static styles = css`
    :host { display: block; color: var(--text, #e8e6e1); font-size: 14px; }
    .card { border: 1px solid rgba(212, 175, 55, 0.22); border-radius: 16px; padding: 20px 22px; background: rgba(12, 12, 16, 0.72); display: grid; gap: 14px; }
    :host([context="onboarding"]) .card { border: none; background: transparent; padding: 0; }
    .k { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #d4af37; font-weight: 650; }
    .oses { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .os { display: flex; gap: 12px; align-items: center; text-align: left; padding: 14px 16px; border-radius: 14px; cursor: pointer; font: inherit; color: #fff;
      background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.12); transition: border-color 0.15s, background 0.15s; }
    .os:hover { border-color: rgba(212, 175, 55, 0.45); }
    .os.is-on { border-color: #d4af37; background: rgba(212, 175, 55, 0.1); box-shadow: 0 0 0 1px rgba(212, 175, 55, 0.35) inset; }
    .os__icon { width: 42px; height: 42px; border-radius: 12px; display: grid; place-items: center; color: #d4af37; background: rgba(212, 175, 55, 0.1); border: 1px solid rgba(212, 175, 55, 0.25); flex-shrink: 0; }
    .os__icon svg { width: 22px; height: 22px; }
    .os__text { display: grid; gap: 2px; }
    .os__text span { color: rgba(255, 255, 255, 0.55); font-size: 12.5px; }
    .paths { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
    .path { display: grid; grid-template-columns: auto 1fr; column-gap: 10px; row-gap: 2px; align-items: baseline; padding: 10px 12px; border-radius: 12px; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.07); }
    .path .hint { grid-column: 2; }
    .chip { grid-row: span 2; font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; white-space: nowrap; }
    .is-available .chip { color: #4ade80; background: rgba(74, 222, 128, 0.12); }
    .is-coming-soon .chip { color: rgba(255, 255, 255, 0.6); background: rgba(255, 255, 255, 0.08); }
    .is-needs-setup .chip { color: #fbbf24; background: rgba(251, 191, 36, 0.12); }
    .is-coming-soon b { color: rgba(255, 255, 255, 0.6); }
    .qrblock { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 16px; align-items: start; }
    .qr { width: 168px; height: 168px; background: #fff; padding: 8px; border-radius: 12px; image-rendering: pixelated; box-sizing: border-box; }
    .qrside { display: grid; gap: 6px; min-width: 0; }
    .pair { display: grid; gap: 8px; padding-top: 4px; }
    .addr { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    .btn { display: inline-flex; align-items: center; gap: 7px; padding: 9px 14px; border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.14); background: rgba(255, 255, 255, 0.05); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
    .btn.primary { background: linear-gradient(135deg, #d4af37, #b8902a); color: #111; border-color: #c9951d; }
    .btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .btn svg { width: 15px; height: 15px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; background: rgba(255, 255, 255, 0.06); padding: 2px 6px; border-radius: 6px; word-break: break-all; }
    .hint { color: rgba(255, 255, 255, 0.55); font-size: 13px; line-height: 1.5; margin: 0; }
    .ok, .warn, .err { margin: 0; display: flex; gap: 8px; align-items: flex-start; font-size: 13px; line-height: 1.5; }
    .ok { color: #86efac; } .warn { color: #fcd34d; } .err { color: #fca5a5; }
    .ok svg, .warn svg, .err svg { width: 15px; height: 15px; flex-shrink: 0; margin-top: 2px; }
    .a2hs ol { margin: 6px 0 0; padding-left: 20px; display: grid; gap: 4px; line-height: 1.5; color: rgba(255, 255, 255, 0.82); }
    @media (max-width: 560px) {
      .card { padding: 16px; }
      .oses { grid-template-columns: 1fr; }
      .qrblock { grid-template-columns: 1fr; justify-items: center; }
      .qrside { width: 100%; }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-phone-app-setup": PhoneAppSetup;
  }
}

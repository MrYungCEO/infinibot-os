/**
 * <ib-browser-connect-setup> — "Connect your browser" step.
 *
 * Gets the InfiniBot Browser Relay extension into the user's Chrome
 * (Chrome Web Store when a listing is configured, otherwise the visible
 * extension folder + Load unpacked in three illustrated steps), pairs it with
 * a one-time code, watches for the live "Connected ✓" state, and proves it
 * works by opening example.com in that Chrome and reading the title.
 *
 * Used by onboarding (Browser step), Setup › Quick Start and the cloud
 * onboarding. Skip is always offered (fires `browser-skip`); `browser-connected`
 * fires once Chrome is connected. Works against gateways that predate
 * `browser.connect.status` by falling back to `browser.extension.status`.
 * `?browserDemo=new|code|waiting|connected|tested|cloud` renders a fixture with no RPCs.
 */
import { LitElement, css, html, nothing, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { icon } from "../icons.js";

type Requester = { request: (method: string, params?: unknown) => Promise<unknown> };

export type BrowserConnectState = {
  cloud: boolean;
  connected: boolean;
  paired: boolean;
  relayReachable: boolean;
  profileName?: string;
  webStoreUrl?: string;
  killSwitch?: boolean;
};

type ExtensionFolder = { found: boolean; path?: string; version?: string };
type TestResult = { ok: boolean; title?: string; url?: string; ms: number; error?: string };
type Pairing = { code: string; expiresAt: number };

const POLL_MS = 2500;
const CHROME_EXTENSIONS_URL = "chrome://extensions";

function errText(err: unknown): string {
  return String((err as Error)?.message ?? err)
    .replace(/^Error:\s*/, "")
    .slice(0, 300);
}

function unknownMethod(err: unknown): boolean {
  return /unknown method|method not found|not found: browser\.connect/i.test(errText(err));
}

function demoState(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("browserDemo");
  } catch {
    return null;
  }
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

@customElement("ib-browser-connect-setup")
export class BrowserConnectSetup extends LitElement {
  @property({ attribute: false }) client: Requester | null = null;
  @property({ reflect: true }) context: "onboarding" | "settings" | "cloud" = "onboarding";
  /** Show the in-component Skip link (hosts with their own Skip button turn it off). */
  @property({ type: Boolean }) skippable = true;

  @state() private st: BrowserConnectState | null = null;
  @state() private folder: ExtensionFolder | null = null;
  @state() private pairing: Pairing | null = null;
  @state() private test: TestResult | null = null;
  @state() private busy: "pair" | "test" | "reveal" | "reconnect" | null = null;
  @state() private error: string | null = null;
  @state() private copied: string | null = null;
  @state() private legacy = false;

  private readonly demo = demoState();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private announced = false;

  connectedCallback(): void {
    super.connectedCallback();
    if (this.demo) {
      this.applyDemo(this.demo);
      return;
    }
    if (this.client) void this.load();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopPoll();
  }

  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("client") && this.client && !this.st && !this.demo) void this.load();
    if (this.st?.connected && !this.announced) {
      this.announced = true;
      this.dispatchEvent(new CustomEvent("browser-connected", { bubbles: true, composed: true }));
    }
  }

  /** new · code · waiting · connected · tested · cloud */
  private applyDemo(d: string): void {
    const cloud = d === "cloud" || this.context === "cloud";
    this.st = {
      cloud,
      connected: d === "connected" || d === "tested",
      paired: d === "waiting" || d === "connected" || d === "tested",
      relayReachable: true,
      profileName: "My Chrome",
    };
    this.folder = cloud
      ? null
      : { found: true, path: "/home/you/InfiniBot/browser-extension", version: "0.3.2" };
    if (d === "code") this.pairing = { code: "K7QM-4XRT", expiresAt: Date.now() + 9 * 60_000 };
    if (d === "tested") this.test = { ok: true, title: "Example Domain", url: "https://example.com/", ms: 1240 };
  }

  private async rpc<T>(method: string, params?: unknown): Promise<T> {
    if (!this.client) throw new Error("Not connected to InfiniBot yet.");
    return (await this.client.request(method, params ?? {})) as T;
  }

  private async load(): Promise<void> {
    await this.refresh();
    if (!this.st?.cloud) void this.loadFolder();
    this.startPoll();
  }

  private startPoll(): void {
    this.stopPoll();
    this.pollTimer = setInterval(() => {
      if (document.hidden || this.busy === "reconnect") return;
      void this.refresh();
    }, POLL_MS);
  }

  private stopPoll(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private refreshing: Promise<void> | null = null;

  private refresh(waitMs?: number): Promise<void> {
    // One status call at a time: polls never stack up behind a slow gateway.
    if (this.refreshing && !waitMs) return this.refreshing;
    const p = this.refreshNow(waitMs).finally(() => {
      if (this.refreshing === p) this.refreshing = null;
    });
    this.refreshing = p;
    return p;
  }

  private async refreshNow(waitMs?: number): Promise<void> {
    try {
      if (!this.legacy) {
        try {
          const s = await this.rpc<{
            cloud: boolean;
            connected: boolean;
            paired: boolean;
            relayReachable: boolean;
            killSwitch?: boolean;
            webStoreUrl?: string;
            connectedProfiles?: Array<{ name: string }>;
            pairedProfiles?: Array<{ name: string }>;
          }>("browser.connect.status", waitMs ? { waitMs } : {});
          this.st = {
            cloud: s.cloud || this.context === "cloud",
            connected: s.connected,
            // A connected Chrome is paired by definition (the relay authenticated it).
            paired: s.paired || s.connected,
            relayReachable: s.relayReachable,
            killSwitch: s.killSwitch,
            webStoreUrl: s.webStoreUrl,
            profileName: s.connectedProfiles?.[0]?.name ?? s.pairedProfiles?.[0]?.name,
          };
          this.error = null;
          return;
        } catch (err) {
          if (!unknownMethod(err)) throw err;
          this.legacy = true;
        }
      }
      // Older gateway: governance status carries the same answer.
      const g = await this.rpc<{
        killSwitch?: boolean;
        profiles?: Array<{ name: string; connected: boolean }>;
      }>("browser.extension.status");
      const profiles = g.profiles ?? [];
      const live = profiles.find((p) => p.connected);
      this.st = {
        cloud: this.context === "cloud",
        connected: Boolean(live),
        paired: profiles.length > 0,
        relayReachable: true,
        killSwitch: g.killSwitch,
        profileName: live?.name ?? profiles[0]?.name,
      };
      this.error = null;
    } catch (err) {
      const msg = errText(err);
      if (this.context === "cloud" || /saas|cloud|tenant/i.test(msg)) {
        this.st = { cloud: true, connected: false, paired: false, relayReachable: false };
        this.stopPoll();
        return;
      }
      this.error = msg;
    }
  }

  private async loadFolder(): Promise<void> {
    try {
      const s = await this.rpc<{ extension?: ExtensionFolder }>("browser.setup.status");
      this.folder = s.extension ?? { found: false };
    } catch {
      this.folder = { found: false };
    }
  }

  private async revealFolder(): Promise<void> {
    this.busy = "reveal";
    this.error = null;
    try {
      await this.rpc("browser.setup.reveal_extension");
    } catch (err) {
      // Older gateways can't open a file manager: copy the path instead.
      if (this.folder?.path && (await copy(this.folder.path))) this.flash("path");
      else this.error = `Couldn't open the folder: ${errText(err)}`;
    } finally {
      this.busy = null;
    }
  }

  private async createCode(): Promise<void> {
    this.busy = "pair";
    this.error = null;
    try {
      const r = await this.rpc<{ code: string; expiresAt: number }>("browser.extension.pairing.create", {
        name: "My Chrome",
      });
      this.pairing = { code: r.code, expiresAt: r.expiresAt };
    } catch (err) {
      this.error = errText(err);
    } finally {
      this.busy = null;
    }
  }

  private async runTest(): Promise<void> {
    this.busy = "test";
    this.error = null;
    this.test = null;
    try {
      this.test = await this.rpc<TestResult>("browser.extension.test");
    } catch (err) {
      this.test = {
        ok: false,
        ms: 0,
        error: unknownMethod(err)
          ? "This InfiniBot needs a restart to run the test (it was just updated)."
          : errText(err),
      };
    } finally {
      this.busy = null;
    }
  }

  private async reconnect(): Promise<void> {
    this.busy = "reconnect";
    this.error = null;
    try {
      await this.refresh(10_000);
    } finally {
      this.busy = null;
    }
  }

  private flash(what: string): void {
    this.copied = what;
    setTimeout(() => {
      if (this.copied === what) this.copied = null;
    }, 1800);
  }

  private skip(): void {
    this.dispatchEvent(new CustomEvent("browser-skip", { bubbles: true, composed: true }));
  }

  // ── render ────────────────────────────────────────────────────────────────

  private statusPill(): TemplateResult {
    const s = this.st;
    if (!s) return html`<span class="pill is-wait" data-testid="bc-status"><span class="spin"></span>Checking…</span>`;
    if (s.cloud) return html`<span class="pill is-info" data-testid="bc-status">${icon("server")}InfiniBot Cloud</span>`;
    if (s.killSwitch)
      return html`<span class="pill is-warn" data-testid="bc-status">${icon("pause")}Paused by the kill switch</span>`;
    if (s.connected)
      return html`<span class="pill is-ok" data-testid="bc-status"
        >Connected ✓${s.profileName ? html`<span class="pill__sub">${s.profileName}</span>` : nothing}</span
      >`;
    if (s.paired)
      return html`<span class="pill is-warn" data-testid="bc-status"><span class="spin"></span>Paired — waiting for Chrome</span>`;
    return html`<span class="pill is-idle" data-testid="bc-status">${icon("globe")}Not connected yet</span>`;
  }

  private renderCloud(): TemplateResult {
    return html`
      <div class="card" data-testid="bc-cloud">
        <p class="lead">
          Your cloud assistant already has its own secure browser in InfiniBot Cloud, so web tasks work with nothing to
          install.
        </p>
        <p class="lead">To let it use <b>your</b> Chrome (your logins and open tabs), connect it through a computer you own:</p>
        <ol class="steps">
          <li>
            <span class="n">1</span>
            <div>
              <b>Install InfiniBot on the computer where you use Chrome</b>
              <span class="sub">Desktop app for Windows or Linux, or <code>npm install -g infinibot</code>.</span>
            </div>
          </li>
          <li>
            <span class="n">2</span>
            <div>
              <b>Open Setup › Connect your browser there</b>
              <span class="sub">It adds the extension and pairs Chrome with a one-time code, about a minute.</span>
            </div>
          </li>
          <li>
            <span class="n">3</span>
            <div>
              <b>Ask that InfiniBot for browser tasks</b>
              <span class="sub">Chrome only lets the extension talk to programs on the same computer, so your passwords
                never leave it.</span>
            </div>
          </li>
        </ol>
        <div class="row">
          <a class="btn btn--primary" href="https://infinibotos.com/#download" target="_blank" rel="noopener"
            >${icon("download")}Get InfiniBot for your computer</a
          >
        </div>
      </div>
    `;
  }

  private renderInstall(): TemplateResult {
    const s = this.st;
    const f = this.folder;
    const store = s?.webStoreUrl;
    const path = f?.path;
    return html`
      <section class="card" data-testid="bc-install">
        <h4><span class="num">1</span>Add the extension to Chrome</h4>
        ${store
          ? html`<div class="row">
              <a class="btn btn--primary" href=${store} target="_blank" rel="noopener" data-testid="bc-store"
                >${icon("download")}Add from Chrome Web Store</a
              >
              <span class="hint">Or load it from your computer below.</span>
            </div>`
          : nothing}
        <div class="folder" data-testid="bc-folder">
          ${f === null
            ? html`<span class="hint"><span class="spin"></span>Finding the extension folder…</span>`
            : path
              ? html`<code class="path" title=${path}>${path}</code>
                  ${f.version ? html`<span class="ver">v${f.version}</span>` : nothing}`
              : html`<span class="hint warn">This install has no extension folder. Reinstall InfiniBot, then reopen this step.</span>`}
        </div>
        ${path
          ? html`<div class="row">
              <button type="button" class="btn ${store ? "" : "btn--primary"}" data-testid="bc-open-folder" ?disabled=${this.busy === "reveal"} @click=${() => void this.revealFolder()}>
                ${icon("folder")}Open extension folder
              </button>
              <button type="button" class="btn" data-testid="bc-copy-path" @click=${async () => (await copy(path)) && this.flash("path")}>
                ${icon(this.copied === "path" ? "check" : "copy")}${this.copied === "path" ? "Copied" : "Copy path"}
              </button>
            </div>`
          : nothing}
        <ol class="illus" aria-label="Load the extension in Chrome">
          <li>
            <div class="art" aria-hidden="true">
              <div class="urlbar"><span class="lock"></span><span class="url">chrome://extensions</span></div>
            </div>
            <b>Open chrome://extensions</b>
            <span class="sub">Paste it into Chrome's address bar.</span>
            <button type="button" class="btn btn--sm" data-testid="bc-copy-url" @click=${async () => (await copy(CHROME_EXTENSIONS_URL)) && this.flash("url")}>
              ${icon(this.copied === "url" ? "check" : "copy")}${this.copied === "url" ? "Copied" : "Copy address"}
            </button>
          </li>
          <li>
            <div class="art" aria-hidden="true">
              <div class="devmode"><span>Developer mode</span><span class="toggle"><span></span></span></div>
            </div>
            <b>Turn on Developer mode</b>
            <span class="sub">The switch is in the top-right corner.</span>
          </li>
          <li>
            <div class="art" aria-hidden="true">
              <div class="unpacked"><span class="btn-fake">Load unpacked</span><span class="cursor"></span></div>
            </div>
            <b>Click Load unpacked</b>
            <span class="sub">Pick the folder above (Open extension folder shows it). It's a normal folder, not a hidden one.</span>
          </li>
        </ol>
      </section>
    `;
  }

  private renderPair(): TemplateResult {
    const s = this.st;
    if (s?.paired) {
      return html`<section class="card is-done" data-testid="bc-pair">
        <h4><span class="num ok">${icon("check")}</span>Paired${s.profileName ? html` as <span class="em">${s.profileName}</span>` : nothing}</h4>
        ${s.connected
          ? html`<p class="hint">Chrome is connected. InfiniBot's main agent uses it for browser tasks, in chat and over MCP.</p>`
          : html`<p class="hint">
                Waiting for Chrome. Open Chrome; the extension reconnects by itself within about 30 seconds.
              </p>
              <div class="row">
                <button type="button" class="btn" data-testid="bc-reconnect" ?disabled=${this.busy === "reconnect"} @click=${() => void this.reconnect()}>
                  ${this.busy === "reconnect" ? html`<span class="spin"></span>Reconnecting…` : html`${icon("refresh")}Reconnect`}
                </button>
              </div>`}
      </section>`;
    }
    const p = this.pairing;
    return html`<section class="card" data-testid="bc-pair">
      <h4><span class="num">2</span>Pair it with InfiniBot</h4>
      ${p
        ? html`<div class="code-row">
              <code class="code" data-testid="bc-code">${p.code}</code>
              <button type="button" class="btn" data-testid="bc-copy-code" @click=${async () => (await copy(p.code)) && this.flash("code")}>
                ${icon(this.copied === "code" ? "check" : "copy")}${this.copied === "code" ? "Copied" : "Copy code"}
              </button>
            </div>
            <p class="hint">
              The extension opened its settings page when you loaded it (or click the InfiniBot icon in Chrome's toolbar →
              Settings). Paste the code, click <b>Pair</b>, and this page turns green by itself. The code works once and expires
              in 10 minutes.
            </p>`
        : html`<p class="hint">Get a one-time code, then paste it into the extension.</p>
            <div class="row">
              <button type="button" class="btn btn--primary" data-testid="bc-get-code" ?disabled=${this.busy === "pair"} @click=${() => void this.createCode()}>
                ${this.busy === "pair" ? html`<span class="spin"></span>Creating…` : html`${icon("key")}Get pairing code`}
              </button>
            </div>`}
    </section>`;
  }

  private renderTest(): TemplateResult {
    const s = this.st;
    const t = this.test;
    const can = Boolean(s?.connected);
    return html`<section class="card ${t?.ok ? "is-done" : ""}" data-testid="bc-test">
      <h4><span class="num ${t?.ok ? "ok" : ""}">${t?.ok ? icon("check") : s?.paired ? "2" : "3"}</span>Try it</h4>
      <p class="hint">InfiniBot opens example.com in a new tab in your Chrome, reads the page title, and closes the tab.</p>
      <div class="row">
        <button type="button" class="btn ${can ? "btn--primary" : ""}" data-testid="bc-test-run" ?disabled=${!can || this.busy === "test"} @click=${() => void this.runTest()}>
          ${this.busy === "test" ? html`<span class="spin"></span>Opening example.com…` : html`${icon("play")}Open example.com and read the title`}
        </button>
        ${can ? nothing : html`<span class="hint">Connect Chrome first.</span>`}
      </div>
      ${t
        ? t.ok
          ? html`<div class="result ok" data-testid="bc-test-result">${icon("checkCircle")}It works. Read “${t.title}” in
              ${(t.ms / 1000).toFixed(1)} s.</div>`
          : html`<div class="result bad" data-testid="bc-test-result">${icon("alertCircle")}${t.error ?? "The test didn't finish."}</div>`
        : nothing}
    </section>`;
  }

  render() {
    const s = this.st;
    return html`
      <div class="wrap" data-testid="browser-connect-setup">
        <div class="top">
          ${this.statusPill()}
          ${this.skippable && !s?.connected
            ? html`<button type="button" class="link" data-testid="bc-skip" @click=${() => this.skip()}>Skip for now</button>`
            : nothing}
        </div>
        ${this.error ? html`<div class="result bad" role="alert">${icon("alertCircle")}${this.error}</div>` : nothing}
        ${s?.cloud
          ? this.renderCloud()
          : html`${s?.paired ? nothing : this.renderInstall()} ${this.renderPair()} ${this.renderTest()}
              ${s?.paired
                ? html`<details class="more">
                    <summary>Install it in another Chrome profile</summary>
                    ${this.renderInstall()}
                  </details>`
                : nothing}`}
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
      color: var(--c-text, #eaeaea);
      font: inherit;
    }
    .wrap {
      display: grid;
      gap: 14px;
    }
    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 14px;
      border-radius: 999px;
      font-size: 13px;
      font-weight: 600;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.04);
    }
    .pill svg {
      width: 16px;
      height: 16px;
    }
    .pill__sub {
      font-weight: 400;
      opacity: 0.75;
      margin-left: 2px;
    }
    .pill.is-ok {
      color: #6ee7a8;
      border-color: rgba(110, 231, 168, 0.45);
      background: rgba(110, 231, 168, 0.1);
    }
    .pill.is-warn {
      color: #f6c56b;
      border-color: rgba(246, 197, 107, 0.4);
      background: rgba(246, 197, 107, 0.08);
    }
    .pill.is-info {
      color: var(--g-primary, #d4af37);
      border-color: color-mix(in srgb, var(--g-primary, #d4af37) 45%, transparent);
    }
    .link {
      background: none;
      border: 0;
      color: var(--c-text-2, #a8a8a8);
      text-decoration: underline;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
      padding: 6px 4px;
      min-height: 44px;
    }
    .card {
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 14px;
      padding: 16px 18px;
      background: rgba(255, 255, 255, 0.025);
      display: grid;
      gap: 12px;
      min-width: 0;
    }
    .card.is-done {
      border-color: rgba(110, 231, 168, 0.3);
    }
    h4 {
      margin: 0;
      font-size: 15px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .num {
      display: inline-grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      font-size: 12px;
      background: color-mix(in srgb, var(--g-primary, #d4af37) 18%, transparent);
      color: var(--g-primary, #d4af37);
      flex: none;
    }
    .num.ok {
      background: rgba(110, 231, 168, 0.18);
      color: #6ee7a8;
    }
    .num svg {
      width: 14px;
      height: 14px;
    }
    .em {
      color: var(--g-primary, #d4af37);
      margin-left: 4px;
    }
    .lead {
      margin: 0;
      line-height: 1.5;
    }
    .hint {
      margin: 0;
      color: var(--c-text-2, #a8a8a8);
      font-size: 13px;
      line-height: 1.5;
    }
    .hint.warn {
      color: #f6c56b;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 44px;
      padding: 0 16px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(255, 255, 255, 0.05);
      color: inherit;
      font: inherit;
      font-size: 14px;
      cursor: pointer;
      text-decoration: none;
    }
    .btn svg {
      width: 16px;
      height: 16px;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .btn--primary {
      background: linear-gradient(180deg, #e6c45a, var(--g-primary, #d4af37));
      color: #17130a;
      border-color: transparent;
      font-weight: 600;
    }
    .btn--sm {
      min-height: 36px;
      padding: 0 12px;
      font-size: 13px;
      justify-self: start;
    }
    .folder {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }
    .path {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 10px 12px;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid rgba(255, 255, 255, 0.08);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
    }
    .ver {
      font-size: 12px;
      color: var(--c-text-2, #a8a8a8);
    }
    .illus {
      list-style: none;
      margin: 4px 0 0;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      counter-reset: s;
    }
    .illus li {
      display: grid;
      gap: 6px;
      align-content: start;
      padding: 12px;
      border-radius: 12px;
      background: rgba(0, 0, 0, 0.22);
      border: 1px solid rgba(255, 255, 255, 0.06);
      counter-increment: s;
      min-width: 0;
    }
    .illus li > b::before {
      content: counter(s) ". ";
      color: var(--g-primary, #d4af37);
    }
    .sub {
      color: var(--c-text-2, #a8a8a8);
      font-size: 12.5px;
      line-height: 1.45;
      display: block;
    }
    .art {
      height: 64px;
      border-radius: 8px;
      background: #1d1f24;
      border: 1px solid rgba(255, 255, 255, 0.08);
      display: grid;
      place-items: center;
      overflow: hidden;
    }
    .urlbar {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 86%;
      padding: 6px 10px;
      border-radius: 999px;
      background: #2b2e35;
      font-family: ui-monospace, monospace;
      font-size: 11px;
      color: #dfe3ea;
      white-space: nowrap;
      overflow: hidden;
    }
    .lock {
      width: 8px;
      height: 8px;
      border-radius: 2px;
      background: #8ab4f8;
      flex: none;
    }
    .devmode {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 11px;
      color: #dfe3ea;
    }
    .toggle {
      width: 30px;
      height: 16px;
      border-radius: 999px;
      background: #8ab4f8;
      position: relative;
    }
    .toggle span {
      position: absolute;
      right: 2px;
      top: 2px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #fff;
    }
    .unpacked {
      position: relative;
    }
    .btn-fake {
      display: inline-block;
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid #8ab4f8;
      color: #8ab4f8;
      font-size: 11px;
    }
    .cursor {
      position: absolute;
      right: -8px;
      bottom: -10px;
      width: 0;
      height: 0;
      border-left: 7px solid transparent;
      border-right: 7px solid transparent;
      border-bottom: 14px solid #fff;
      transform: rotate(-35deg);
    }
    .code-row {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .code {
      font-family: ui-monospace, monospace;
      font-size: 26px;
      letter-spacing: 0.12em;
      padding: 8px 16px;
      border-radius: 10px;
      background: rgba(0, 0, 0, 0.35);
      border: 1px dashed color-mix(in srgb, var(--g-primary, #d4af37) 55%, transparent);
      color: var(--g-primary, #d4af37);
    }
    .result {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      padding: 10px 12px;
      border-radius: 10px;
      font-size: 13.5px;
      line-height: 1.45;
    }
    .result svg {
      width: 16px;
      height: 16px;
      flex: none;
      margin-top: 2px;
    }
    .result.ok {
      background: rgba(110, 231, 168, 0.1);
      color: #6ee7a8;
    }
    .result.bad {
      background: rgba(248, 113, 113, 0.1);
      color: #fca5a5;
    }
    .steps {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 12px;
    }
    .steps li {
      display: flex;
      gap: 12px;
      align-items: flex-start;
    }
    .steps .n {
      display: inline-grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: color-mix(in srgb, var(--g-primary, #d4af37) 18%, transparent);
      color: var(--g-primary, #d4af37);
      font-size: 12px;
      flex: none;
    }
    code {
      font-family: ui-monospace, monospace;
    }
    .more summary {
      cursor: pointer;
      color: var(--c-text-2, #a8a8a8);
      font-size: 13px;
      padding: 6px 0;
    }
    .more[open] summary {
      margin-bottom: 10px;
    }
    .spin {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      border: 2px solid currentColor;
      border-right-color: transparent;
      display: inline-block;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (max-width: 720px) {
      .illus {
        grid-template-columns: 1fr;
      }
      .card {
        padding: 14px;
      }
      .code {
        font-size: 22px;
      }
      .btn {
        flex: 1 1 auto;
        justify-content: center;
      }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-browser-connect-setup": BrowserConnectSetup;
  }
}

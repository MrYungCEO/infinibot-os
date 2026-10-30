/**
 * <ib-kv-connect> — "Connect KinglyVault" in one place, used on the Plugins
 * page, onboarding step 7 (Your plan) and Setup › Your setup › Plugins.
 *
 * One button. It asks the gateway for a short code (plugins.kv.connect.start),
 * opens KinglyVault's approval page in the normal browser (window.open; in
 * InfiniBot Desktop the window-open handler hands it to shell.openExternal,
 * never an embedded window) and shows the same code. The gateway polls
 * KinglyVault itself; this panel only watches plugins.kv.connect.status.
 * Once linked: "Connected as <email> · Disconnect" and Sync now.
 *
 * Off until KinglyVault ships the endpoints: plugins.kv.status reports
 * capabilities.available=false and the button is disabled with the reason.
 * "Have a license key?" keeps the paste fallback (plugins.entitlements.import).
 *
 * Events: `kv-changed` (bubbles, composed) after link / sync / disconnect, so
 * the host page can reload its plugin list.
 */
import { css, html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "./provider-logo.js";
import type { GatewayBrowserClient } from "../gateway.js";
import { isUnknownMethod, kvView, tokenFromPaste, type KvConnect, type KvStatus } from "./kv-connect-model.js";

const POLL_MS = 2000;

@customElement("ib-kv-connect")
export class KvConnectPanel extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  /** card: Plugins page / Purchases; compact: onboarding + Setup rows. */
  @property({ reflect: true }) variant: "card" | "compact" = "card";

  @state() private status: KvStatus | null | "unsupported" = null;
  @state() private connect: KvConnect | null = null;
  @state() private busy: "" | "start" | "sync" | "unlink" | "key" = "";
  @state() private note: { kind: "ok" | "err"; text: string } | null = null;
  @state() private keyOpen = false;
  @state() private keyText = "";

  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopPolling();
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has("client") && this.client && this.status === null) void this.load();
  }

  private async rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.client) throw new Error("Not connected to InfiniBot yet.");
    return this.client.request<T>(method, params);
  }

  /** Reload (also called by hosts after a purchase). */
  async load(force = false): Promise<void> {
    if (!this.client) return;
    try {
      const s = await this.rpc<KvStatus>("plugins.kv.status", force ? { force: true } : {});
      this.status = s;
      if (s.connect?.status === "pending") {
        this.connect = s.connect;
        this.schedulePoll();
      }
    } catch (err) {
      if (isUnknownMethod(err)) this.status = "unsupported";
      else this.note = { kind: "err", text: `Couldn't check KinglyVault: ${msg(err)}` };
    }
  }

  private changed(): void {
    this.dispatchEvent(new CustomEvent("kv-changed", { bubbles: true, composed: true }));
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private schedulePoll(): void {
    this.stopPolling();
    this.pollTimer = setTimeout(() => void this.poll(), POLL_MS);
  }

  private async poll(): Promise<void> {
    const c = this.connect;
    if (!c || c.status !== "pending") return;
    try {
      const res = await this.rpc<{ connect: KvConnect }>("plugins.kv.connect.status", { id: c.id });
      this.connect = res.connect;
      if (res.connect.status === "pending") return this.schedulePoll();
      if (res.connect.status === "approved") {
        this.note = {
          kind: "ok",
          text: `Connected as ${res.connect.email ?? "your KinglyVault account"}. Plugins you own are unlocked.${
            res.connect.restart ? " InfiniBot is restarting for a few seconds to load them." : ""
          }`,
        };
        await this.load();
        this.changed();
      }
    } catch {
      // gateway restarting (it does after a link that unlocks a running plugin): keep trying
      this.schedulePoll();
    }
  }

  private async start(): Promise<void> {
    this.busy = "start";
    this.note = null;
    try {
      const res = await this.rpc<{ connect: KvConnect }>("plugins.kv.connect.start");
      this.connect = res.connect;
      this.openApproval(res.connect.verificationUriComplete);
      this.schedulePoll();
    } catch (err) {
      this.note = { kind: "err", text: msg(err) };
    } finally {
      this.busy = "";
    }
  }

  /** The member's normal browser (Desktop: shell.openExternal via the window-open handler). */
  private openApproval(url: string): void {
    window.open(url, "_blank", "noopener,noreferrer");
  }

  private async cancel(): Promise<void> {
    const id = this.connect?.id;
    this.stopPolling();
    this.connect = null;
    if (id) await this.rpc("plugins.kv.connect.cancel", { id }).catch(() => undefined);
    await this.load();
  }

  /** Already connected through KinglyVault Connect: link the plugin licence from it. */
  private async unlockFromConnection(): Promise<void> {
    this.busy = "start";
    this.note = null;
    try {
      const res = await this.rpc<{ ok?: boolean; error?: string; restart?: unknown }>("plugins.entitlements.syncFromRelay");
      this.note = res.ok
        ? { kind: "ok", text: `Your plugins are unlocked.${res.restart ? " InfiniBot is restarting for a few seconds to load them." : ""}` }
        : { kind: "err", text: res.error ?? "KinglyVault can't be reached right now. Try again in a minute." };
      await this.load();
      if (res.ok) this.changed();
    } catch (err) {
      this.note = { kind: "err", text: msg(err) };
    } finally {
      this.busy = "";
    }
  }

  private async sync(): Promise<void> {
    this.busy = "sync";
    this.note = null;
    try {
      const res = await this.rpc<{ ok: boolean; error?: string; restart?: unknown }>("plugins.entitlements.refresh");
      this.note = res.ok
        ? { kind: "ok", text: `Synced with KinglyVault.${res.restart ? " InfiniBot is restarting to apply changes." : ""}` }
        : { kind: "err", text: res.error ?? "Couldn't reach KinglyVault." };
      await this.load();
      this.changed();
    } catch (err) {
      this.note = { kind: "err", text: msg(err) };
    } finally {
      this.busy = "";
    }
  }

  private async unlink(): Promise<void> {
    if (!confirm("Disconnect KinglyVault from this InfiniBot? Paid plugins you bought lock again until you reconnect.")) return;
    this.busy = "unlink";
    this.note = null;
    try {
      const res = await this.rpc<{ restart?: unknown }>("plugins.entitlements.unlink");
      this.note = { kind: "ok", text: `KinglyVault disconnected.${res.restart ? " InfiniBot is restarting." : ""}` };
      this.connect = null;
      await this.load();
      this.changed();
    } catch (err) {
      this.note = { kind: "err", text: msg(err) };
    } finally {
      this.busy = "";
    }
  }

  private async importKey(): Promise<void> {
    const token = tokenFromPaste(this.keyText);
    if (!token) {
      this.note = { kind: "err", text: "That doesn't look like a KinglyVault key. Copy the whole key and paste it again." };
      return;
    }
    this.busy = "key";
    this.note = null;
    try {
      const res = await this.rpc<{ changed: string[]; restart?: unknown }>("plugins.entitlements.import", { token });
      this.keyText = "";
      this.keyOpen = false;
      this.note = {
        kind: "ok",
        text: `Key accepted.${res.changed.length ? " Your plugins are unlocked." : ""}${res.restart ? " InfiniBot is restarting to load them." : ""}`,
      };
      await this.load();
      this.changed();
    } catch (err) {
      this.note = { kind: "err", text: msg(err) };
    } finally {
      this.busy = "";
    }
  }

  private relayPaired(): boolean {
    return Boolean(this.status && this.status !== "unsupported" && this.status.relayPaired);
  }

  // ── render ─────────────────────────────────────────────────────────

  render() {
    const v = kvView(this.status, this.connect);
    if (v.kind === "hidden") return nothing;
    const owner =
      this.status && this.status !== "unsupported" && this.status.account.ownerGrant?.active
        ? html`<p class="kv-sub" data-kv-owner>Owner licence on this machine: every paid plugin is unlocked.</p>`
        : nothing;
    return html`<section class="kv" data-kv-state=${v.kind} aria-live="polite">
      <div class="kv-row">
        <ib-provider-logo provider="kinglyvault" size="34"></ib-provider-logo>
        <div class="kv-main">
          ${v.kind === "loading"
            ? html`<p class="kv-title">KinglyVault</p><p class="kv-sub">Checking…</p>`
            : v.kind === "linked"
              ? html`<p class="kv-title">Connected as <strong data-kv-email>${v.email}</strong>
                    <button class="kv-link" data-kv-disconnect ?disabled=${Boolean(this.busy)} @click=${() => void this.unlink()}>Disconnect</button></p>
                  <p class="kv-sub">${v.detail}</p>
                  ${v.warn ? html`<p class="kv-warn" data-kv-warn>${v.warn}</p>` : nothing}`
              : v.kind === "waiting"
                ? html`<p class="kv-title">Approve in your browser</p>
                    <p class="kv-sub">KinglyVault opened in your browser. Check it shows this code, then press Approve:</p>
                    <p class="kv-code" data-kv-code>${v.code}</p>
                    <p class="kv-sub">
                      <a class="kv-link" href=${v.url} target="_blank" rel="noopener noreferrer" data-kv-open>Open the page again</a>
                      · <button class="kv-link" data-kv-cancel @click=${() => void this.cancel()}>Cancel</button>
                      · <span class="kv-wait"><span class="kv-dot"></span>Waiting for approval</span>
                    </p>`
                : v.kind === "unavailable"
                  ? // Account sign-in for licences isn't live on KinglyVault yet: the
                    // KinglyVault card above (<kv-connect-card>) is the account link,
                    // this panel only keeps the license-key paste.
                    html`<p class="kv-title">Plugin licences</p>
                      <p class="kv-sub">Bought a paid plugin? Paste its license key below to unlock it.</p>
                      <p class="kv-sub kv-muted" data-kv-unavailable hidden>${v.reason}</p>`
                  : this.relayPaired()
                    ? html`<p class="kv-title">KinglyVault connected</p>
                        <p class="kv-sub">Your InfiniBot is linked to KinglyVault. Unlock the plugins you own or your plan includes in one click.</p>
                        ${v.kind === "ready" && v.note ? html`<p class="kv-warn">${v.note}</p>` : nothing}`
                  : html`<p class="kv-title">KinglyVault account</p>
                    <p class="kv-sub">${this.variant === "compact"
                      ? "Unlock the plugins you own. No key to copy."
                      : "Sign in to KinglyVault once and every plugin you own or your plan includes unlocks here. No key to copy."}</p>
                    ${v.kind === "ready" && v.note ? html`<p class="kv-warn">${v.note}</p>` : nothing}`}
          ${owner}
        </div>
        <div class="kv-actions">
          ${v.kind === "linked"
            ? html`<button class="kv-btn" data-kv-sync ?disabled=${Boolean(this.busy)} @click=${() => void this.sync()}>${this.busy === "sync" ? "Syncing…" : "Sync now"}</button>`
            : v.kind === "ready" && this.relayPaired()
              ? html`<button class="kv-btn primary" data-kv-unlock-relay ?disabled=${Boolean(this.busy)}
                    title="Uses your KinglyVault connection; no second sign-in"
                    @click=${() => void this.unlockFromConnection()}>${this.busy === "start" ? "Unlocking…" : "Unlock my plugins"}</button>`
            : v.kind === "ready"
              ? html`<button class="kv-btn primary" data-kv-connect ?disabled=${Boolean(this.busy)}
                    title=${v.kind === "unavailable" ? v.reason : "Opens KinglyVault in your browser"}
                    @click=${() => void this.start()}>${this.busy === "start" ? "Opening…" : "Connect KinglyVault"}</button>`
              : nothing}
        </div>
      </div>
      ${this.note ? html`<p class="kv-note ${this.note.kind}" role=${this.note.kind === "err" ? "alert" : "status"} data-kv-note>${this.note.text}</p>` : nothing}
      ${v.kind === "linked" || v.kind === "loading"
        ? nothing
        : html`<details class="kv-key" ?open=${this.keyOpen} @toggle=${(e: Event) => (this.keyOpen = (e.target as HTMLDetailsElement).open)}>
            <summary data-kv-key-toggle>Have a license key?</summary>
            <form @submit=${(e: Event) => { e.preventDefault(); void this.importKey(); }}>
              <label for="kv-key-input">Paste the key from your KinglyVault purchase page</label>
              <textarea id="kv-key-input" data-kv-key-input rows="2" spellcheck="false" .value=${this.keyText}
                @input=${(e: Event) => (this.keyText = (e.target as HTMLTextAreaElement).value)}></textarea>
              <button class="kv-btn" type="submit" data-kv-key-submit ?disabled=${!this.keyText.trim() || Boolean(this.busy)}>${this.busy === "key" ? "Checking…" : "Use key"}</button>
            </form>
          </details>`}
    </section>`;
  }

  static styles = css`
    :host {
      display: block;
      --kv-accent: var(--pp-accent, var(--accent, #f5c542));
      --kv-fg: var(--pp-fg, var(--text, #f4f1e8));
      --kv-muted: var(--pp-muted, var(--muted, #a8a29e));
      --kv-line: var(--pp-line-strong, rgba(245, 197, 66, 0.22));
      --kv-card: var(--pp-card, rgba(14, 13, 10, 0.72));
      font: inherit;
      color: var(--kv-fg);
    }
    .kv {
      border: 1px solid color-mix(in srgb, var(--kv-accent) 35%, transparent);
      border-radius: 16px;
      padding: 14px 16px;
      background:
        radial-gradient(90% 160% at 100% 0%, color-mix(in srgb, var(--kv-accent) 10%, transparent), transparent 55%),
        var(--kv-card);
    }
    :host([variant="compact"]) .kv { padding: 10px 12px; border-radius: 12px; }
    .kv-row { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
    .kv-main { flex: 1 1 260px; min-width: 0; }
    .kv-title { margin: 0; font-size: 14px; font-weight: 600; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
    .kv-title strong { color: var(--kv-accent); font-weight: 600; word-break: break-all; }
    .kv-sub { margin: 3px 0 0; font-size: 12.5px; color: var(--kv-muted); line-height: 1.5; }
    .kv-muted { color: var(--kv-fg); opacity: 0.8; }
    .kv-warn { margin: 4px 0 0; font-size: 12.5px; color: #fbbf24; }
    .kv-code {
      margin: 8px 0 4px; font: 600 24px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.18em;
      color: var(--kv-accent);
    }
    .kv-actions { display: flex; gap: 8px; align-items: center; }
    .kv-btn {
      font: inherit; font-size: 13px; font-weight: 600; padding: 8px 14px; min-height: 36px; border-radius: 10px; cursor: pointer;
      color: var(--kv-fg); background: transparent; border: 1px solid var(--kv-line);
    }
    .kv-btn.primary { color: #111; border-color: transparent; background: linear-gradient(135deg, #fef3c7, #fbbf24 55%, #d97706); }
    .kv-btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .kv-btn.primary:disabled {
      opacity: 1; color: var(--kv-muted); background: rgba(255, 255, 255, 0.06);
      border: 1px dashed color-mix(in srgb, var(--kv-muted) 55%, transparent);
    }
    .kv-link {
      font: inherit; font-size: 12.5px; color: var(--kv-accent); background: none; border: 0; padding: 0; cursor: pointer;
      text-decoration: underline; text-underline-offset: 2px;
    }
    .kv-link:disabled { opacity: 0.5; }
    .kv-wait { display: inline-flex; align-items: center; gap: 6px; }
    .kv-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--kv-accent); animation: kv-pulse 1.2s ease-in-out infinite; }
    @keyframes kv-pulse { 50% { opacity: 0.25; } }
    @media (prefers-reduced-motion: reduce) { .kv-dot { animation: none; } }
    .kv-note { margin: 10px 0 0; font-size: 12.5px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--kv-line); }
    .kv-note.ok { border-color: color-mix(in srgb, var(--kv-accent) 45%, transparent); }
    .kv-note.err { border-color: rgba(248, 113, 113, 0.55); color: #fca5a5; }
    .kv-key { margin-top: 10px; font-size: 12.5px; color: var(--kv-muted); }
    .kv-key summary { cursor: pointer; width: max-content; }
    .kv-key form { display: grid; gap: 6px; margin-top: 8px; }
    .kv-key textarea {
      font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--kv-fg); background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--kv-line); border-radius: 10px; padding: 8px; resize: vertical;
    }
    .kv-key .kv-btn { justify-self: start; }
  `;
}


function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-kv-connect": KvConnectPanel;
  }
}

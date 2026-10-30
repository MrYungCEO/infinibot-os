/**
 * <ib-setup-summary> — Setup › Your setup, once onboarding is finished.
 *
 * One card per area (goals, AI brain, channels, voice, phone, browser, AI apps, privacy, plan)
 * with its current value read live from the gateway and an Edit button. Edit
 * fires `setup-edit` ({ step }); the Setup page opens just that step in
 * <ib-onboarding-flow editStep> and comes back here after Save.
 */
import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import "../components/kv-connect.js";
import type { GatewayBrowserClient } from "../gateway";
import { icon, type IconName } from "../icons";
import { loadLocalProfile, syncProfile } from "../onboarding/profile";
import { SETUP_AREAS, summarizeSetup, type AreaSummary, type EditableStep, type SetupSnapshot } from "../onboarding/setup-areas";

@customElement("ib-setup-summary")
export class SetupSummary extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  /** Result of the last edit (shown once at the top). */
  @property({ attribute: false }) flash: { ok: boolean; text: string } | null = null;
  @state() private rows: AreaSummary[] | null = null;
  @state() private loading = false;

  protected createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    void this.refresh();
  }

  private async req<T>(method: string, params: Record<string, unknown> = {}): Promise<T | null> {
    if (!this.client) return null;
    try {
      return (await this.client.request(method, params)) as T;
    } catch {
      return null;
    }
  }

  /** Read every area live (each one independently: one failing RPC never blanks the rest). */
  async refresh(): Promise<void> {
    this.loading = true;
    const kvOn = !this.client || typeof this.client.supports !== "function" || this.client.supports("kvconnect.status");
    const [profile, brain, cli, channels, voiceRt, voiceProv, phone, secure, plugins, browser, aiapps, kv] = await Promise.all([
      syncProfile(this.client).catch(() => loadLocalProfile()),
      this.req<{ primary?: string | null }>("voice.setup.brainGet"),
      this.req<{ enabled?: boolean; active?: string | null; backends?: Array<{ id: string; account?: string }> }>("cliRouting.status"),
      this.req<{ channels?: SetupSnapshot["channels"]; channelLabels?: Record<string, string> }>("channels.status"),
      this.req<{ stt?: { reachable?: boolean }; tts?: { reachable?: boolean } }>("voice.runtime.status"),
      this.req<{ backend?: string }>("voice.providers.list"),
      this.req<{ installed?: boolean; loggedIn?: boolean; savedUrl?: string | null; gatewayMapping?: { url?: string } | null }>("network.tailscale.remote.status"),
      this.req<{ enabled?: boolean }>("secure.status"),
      this.req<{ plugins?: Array<{ id: string; name?: string; enabled?: boolean; channels?: unknown[] }> }>("plugins.list"),
      this.req<{ profiles?: Array<{ name: string; connected: boolean }> }>("browser.extension.status"),
      this.req<{ clients?: Array<{ name: string; current: boolean }> }>("mcp.clients.detect"),
      kvOn ? this.req<{ connected?: boolean; link?: { account?: string } | null }>("kvconnect.status") : Promise.resolve(null),
    ]);
    const account = cli?.enabled ? (cli.backends?.find((b) => b.id === cli.active)?.account ?? null) : null;
    // Channel plugins (Telegram, Discord…) show under Channels, not Plan.
    const pluginRows = (plugins?.plugins ?? []).filter((p) => !(Array.isArray(p.channels) && p.channels.length));
    const snapshot: SetupSnapshot = {
      useCases: profile ? profile.useCases : null,
      brain: brain || cli ? { primary: brain?.primary ?? null, account } : null,
      channels: channels?.channels ?? null,
      channelLabels: channels?.channelLabels ?? null,
      voice:
        voiceRt || voiceProv
          ? { backend: voiceProv?.backend ?? null, ttsReachable: voiceRt?.tts?.reachable, sttReachable: voiceRt?.stt?.reachable, choice: profile?.voice ?? null }
          : null,
      phone: phone ? { url: phone.gatewayMapping?.url ?? phone.savedUrl ?? null, tailscale: phone.installed, loggedIn: phone.loggedIn } : null,
      secure: secure ? { enabled: Boolean(secure.enabled), available: true } : null,
      browser: browser
        ? {
            paired: (browser.profiles ?? []).length > 0,
            connected: (browser.profiles ?? []).some((p) => p.connected),
            name: (browser.profiles ?? []).find((p) => p.connected)?.name ?? null,
          }
        : null,
      aiapps: aiapps ? { added: (aiapps.clients ?? []).filter((c) => c.current).map((c) => c.name) } : null,
      kinglyvault: !kvOn ? { connected: false, off: true } : kv ? { connected: Boolean(kv.connected), account: kv.link?.account ?? null } : null,
      plugins: plugins
        ? { enabled: pluginRows.filter((p) => p.enabled).map((p) => p.id), names: Object.fromEntries(pluginRows.map((p) => [p.id, p.name ?? p.id])) }
        : null,
    };
    this.rows = summarizeSetup(snapshot);
    this.loading = false;
  }

  private edit(step: EditableStep) {
    this.dispatchEvent(new CustomEvent("setup-edit", { detail: { step }, bubbles: true, composed: true }));
  }

  render() {
    const rows = this.rows;
    return html`
      <style>
        .ssum { display: grid; gap: 16px; max-width: 980px; }
        .ssum__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
        .ssum__card {
          display: flex; flex-direction: column; gap: 10px; padding: 16px 18px; border-radius: 14px;
          border: 1px solid color-mix(in srgb, var(--g-primary, #d4a73a) 18%, transparent);
          background: linear-gradient(160deg, color-mix(in srgb, var(--g-primary, #d4a73a) 6%, transparent), transparent 70%);
        }
        .ssum__card[data-testid="setup-area-recommend"] { grid-column: 1 / -1; }
        .ssum__kv { display: block; }
        .ssum__head { display: flex; align-items: center; gap: 10px; }
        .ssum__icon { display: inline-flex; width: 30px; height: 30px; border-radius: 9px; align-items: center; justify-content: center;
          background: color-mix(in srgb, var(--g-primary, #d4a73a) 12%, transparent); color: var(--g-primary, #d4a73a); }
        .ssum__icon svg { width: 16px; height: 16px; }
        .ssum__label { font-weight: 600; font-size: 14px; flex: 1; }
        .ssum__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c-text-3, #777); }
        .ssum__dot.is-ok { background: #3ecf8e; box-shadow: 0 0 8px #3ecf8e88; }
        .ssum__dot.is-unknown { background: #d9a43a; }
        .ssum__value { color: var(--c-text-2, #bbb); font-size: 13px; line-height: 1.45; word-break: break-word; min-height: 2.9em; }
        .ssum__foot { display: flex; align-items: center; gap: 8px; margin-top: auto; }
        .ssum__applies { color: var(--c-text-3, #888); font-size: 11.5px; flex: 1; }
        .ssum__flash { display: flex; gap: 8px; align-items: center; padding: 10px 14px; border-radius: 10px; font-size: 13px;
          border: 1px solid #3ecf8e55; background: #3ecf8e14; }
        .ssum__flash.is-bad { border-color: #f0606055; background: #f0606014; }
        .ssum__flash svg { width: 16px; height: 16px; flex: none; }
        .ssum__skeleton { height: 128px; border-radius: 14px; background: color-mix(in srgb, var(--g-primary, #d4a73a) 5%, transparent); }
      </style>
      <div class="ssum" data-testid="setup-summary">
        ${this.flash
          ? html`<div class="ssum__flash ${this.flash.ok ? "" : "is-bad"}" role="status" data-testid="setup-summary-flash">
              ${icon(this.flash.ok ? "checkCircle" : "alertCircle")}<span>${this.flash.text}</span>
            </div>`
          : nothing}
        <div class="ssum__grid">
          ${rows
            ? SETUP_AREAS.map((a) => {
                const r = rows.find((x) => x.id === a.id);
                return html`<article class="ssum__card" data-testid=${`setup-area-${a.id}`} aria-labelledby=${`ssum-${a.id}`}>
                  <div class="ssum__head">
                    <span class="ssum__icon">${icon(a.icon as IconName)}</span>
                    <span class="ssum__label" id=${`ssum-${a.id}`}>${a.label}</span>
                    <span class="ssum__dot ${r?.state === "ok" ? "is-ok" : r?.state === "unknown" ? "is-unknown" : ""}" aria-hidden="true"></span>
                  </div>
                  <div class="ssum__value" data-testid=${`setup-area-value-${a.id}`}>${r?.value ?? "…"}</div>
                  ${a.id === "recommend"
                    ? html`<ib-kv-connect class="ssum__kv" data-testid="setup-kv-connect" .client=${this.client} variant="compact"
                        @kv-changed=${() => void this.refresh()}></ib-kv-connect>`
                    : nothing}
                  <div class="ssum__foot">
                    <span class="ssum__applies">${a.applies}</span>
                    <button
                      class="btn btn-secondary"
                      data-testid=${`setup-edit-${a.id}`}
                      aria-label=${`Edit ${a.label}`}
                      @click=${() => this.edit(a.id)}
                    >${icon("edit")} Edit</button>
                  </div>
                </article>`;
              })
            : SETUP_AREAS.map(() => html`<div class="ssum__skeleton" aria-hidden="true"></div>`)}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-setup-summary": SetupSummary;
  }
}

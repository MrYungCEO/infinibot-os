import { LitElement, html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../../ui/src/ui/gateway";

type StudioStatus = {
  ok: boolean;
  url: string;
  service?: string;
  tools?: number;
  declaredTools?: number;
  uptimeSec?: number;
  error?: string;
};

const STYLE = html`<style>
  monsoon-studio-view { display: block; height: 100%; }
  .ms-page { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: calc(100dvh - 140px); padding: 4px 0 0; box-sizing: border-box; }
  .ms-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 16px; border-radius: 14px;
    background: linear-gradient(120deg, color-mix(in srgb, var(--accent, #d7b35d) 10%, transparent), transparent 60%), var(--card, rgba(18, 18, 20, .72));
    border: 1px solid color-mix(in srgb, var(--accent, #d7b35d) 28%, transparent); backdrop-filter: blur(14px); }
  .ms-title { display: flex; flex-direction: column; min-width: 0; margin-right: auto; }
  .ms-title b { font-size: 15px; letter-spacing: .02em; }
  .ms-title small { color: var(--muted, #a1a1aa); font-size: 12px; }
  .ms-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12px; border: 1px solid var(--border, #ffffff1f); white-space: nowrap; }
  .ms-pill i { width: 7px; height: 7px; border-radius: 50%; background: var(--muted, #71717a); }
  .ms-pill.ok i { background: #4ade80; box-shadow: 0 0 8px #4ade80aa; }
  .ms-pill.down i { background: #f87171; }
  .ms-btn { appearance: none; cursor: pointer; padding: 7px 12px; min-height: 36px; border-radius: 10px; font: inherit; font-size: 13px; color: inherit; background: var(--secondary, #ffffff0d); border: 1px solid var(--border, #ffffff1f); text-decoration: none; display: inline-flex; align-items: center; }
  .ms-btn:hover { border-color: color-mix(in srgb, var(--accent, #d7b35d) 60%, transparent); }
  .ms-frame { flex: 1; width: 100%; min-height: 520px; border: 1px solid var(--border, #ffffff1f); border-radius: 14px; background: #0b0b0c; }
  .ms-empty { flex: 1; display: grid; place-items: center; border: 1px dashed var(--border, #ffffff2a); border-radius: 14px; padding: 32px 20px; text-align: center; }
  .ms-empty div { max-width: 560px; display: grid; gap: 10px; }
  .ms-empty code { display: block; padding: 10px 12px; border-radius: 10px; background: #00000059; font-size: 12.5px; overflow-x: auto; white-space: nowrap; }
  .ms-note { color: var(--muted, #a1a1aa); font-size: 12px; }
  @media (max-width: 640px) { .ms-bar { padding: 10px 12px; } .ms-frame { min-height: 70dvh; border-radius: 10px; } }
</style>`;

class MonsoonStudioView extends LitElement {
  static properties = { client: { attribute: false }, status: { state: true }, frameKey: { state: true } };
  // `declare` + constructor init: this file compiles under the plugin tsconfig (ES2022
  // class-field semantics), where initialised fields would shadow Lit's reactive accessors.
  declare client: GatewayBrowserClient | null;
  declare status: StudioStatus | null;
  declare frameKey: number;
  private requested = false;

  constructor() {
    super();
    this.client = this.client ?? null;
    this.status = null;
    this.frameKey = 0;
  }

  protected createRenderRoot(): HTMLElement | DocumentFragment { return this; }

  protected updated(): void {
    if (!this.requested && this.client) {
      this.requested = true;
      void this.refresh();
    }
  }

  private async refresh(): Promise<void> {
    if (!this.client) return;
    try {
      this.status = await this.client.request<StudioStatus>("monsoon-studio.status", {});
    } catch (error) {
      this.status = { ok: false, url: "http://127.0.0.1:4311", error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The studio binds to loopback, so a remote browser can only reach it through the gateway host. */
  private get remoteViewer(): boolean {
    const url = this.status?.url ?? "";
    const loopback = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(url);
    return loopback && !["127.0.0.1", "localhost", "[::1]", "::1"].includes(location.hostname);
  }

  protected render() {
    const s = this.status;
    const pill = !s
      ? html`<span class="ms-pill"><i></i>Checking…</span>`
      : s.ok
        ? html`<span class="ms-pill ok" data-testid="studio-status"><i></i>Connected · ${s.tools ?? s.declaredTools} tools</span>`
        : html`<span class="ms-pill down" data-testid="studio-status"><i></i>Studio offline</span>`;
    return html`${STYLE}<div class="ms-page">
      <div class="ms-bar">
        <div class="ms-title"><b>Product Studio</b><small>Ebooks, guides, reports and microsites. Agents edit the same projects with the studio_* tools.</small></div>
        ${pill}
        <button class="ms-btn" @click=${() => { this.frameKey++; void this.refresh(); }}>Reload</button>
        ${s?.ok ? html`<a class="ms-btn" href=${s.url} target="_blank" rel="noopener">Open in new tab ↗</a>` : nothing}
      </div>
      ${s?.ok
        ? html`${this.remoteViewer ? html`<div class="ms-note">The studio listens on ${s.url} of the gateway machine. Open InfiniBot on that machine (or tunnel the port) to use the editor.</div>` : nothing}
            <iframe class="ms-frame" data-key=${this.frameKey} title="Monsoon Product Studio" src=${`${s.url}/?embed=infinibot&k=${this.frameKey}`} allow="clipboard-read; clipboard-write; fullscreen"></iframe>`
        : s
          ? html`<div class="ms-empty"><div>
              <b>The studio server isn't running</b>
              <span class="ms-note">Expected at ${s.url}${s.error ? ` (${s.error})` : ""}. Start it on the gateway machine:</span>
              <code>systemctl --user start monsoon-studio</code>
              <button class="ms-btn" style="justify-self:center" @click=${() => void this.refresh()}>Check again</button>
            </div></div>`
          : nothing}
    </div>`;
  }
}

if (!customElements.get("monsoon-studio-view")) customElements.define("monsoon-studio-view", MonsoonStudioView);

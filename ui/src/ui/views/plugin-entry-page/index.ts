/**
 * Host wrapper for a plugin page whose UI is an ES module the plugin serves
 * (manifest `pages[].entry`, e.g. FlyPic's /plugins/flypic/ui-panel.js).
 *
 * The page is routed like any first-party plugin page (`pages[].builtin`
 * names this wrapper's tab in FIRST_PARTY_PAGES) and rendered inside the
 * plugin's [data-plugin-scope] container by app-render, but the UI code
 * itself stays behind the plugin boundary: it is fetched from the gateway
 * and mounted with `default(container, { client, pluginId })`, the same
 * contract the Plugins page uses for v1 panels.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import type { GatewayBrowserClient } from "../../gateway.js";
import { g8GlassStyles } from "../glass-g8.js";

function httpBaseFromWsUrl(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    return u.origin;
  } catch {
    return "";
  }
}

type MountFn = (
  container: HTMLElement,
  ctx: { client: GatewayBrowserClient; pluginId: string },
) => void | (() => void);

@customElement("plugin-entry-page")
export class PluginEntryPage extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ attribute: "plugin-id" }) pluginId = "";
  @property() entry = "";
  /** Full-bleed: no padding or scroll of its own; the mounted module fills the page. */
  @property({ type: Boolean, reflect: true }) bleed = false;
  @state() private error = "";

  private cleanup?: () => void;
  private mountedKey = "";

  // Light DOM: the plugin module styles its own markup, and the plugin scope
  // variables (--g-primary, …) cascade in from the wrapper container.
  protected createRenderRoot() {
    return this;
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unmount();
    this.mountedKey = "";
  }

  private unmount(): void {
    try {
      this.cleanup?.();
    } catch {
      /* plugin cleanup errors must not break navigation */
    }
    this.cleanup = undefined;
  }

  protected updated(): void {
    void this.mount();
  }

  private async mount(): Promise<void> {
    const client = this.client;
    const key = `${this.pluginId}|${this.entry}`;
    if (!client || !this.entry || this.mountedKey === key) return;
    this.mountedKey = key;
    this.unmount();
    const container = this.querySelector<HTMLElement>("[data-plugin-entry]");
    if (!container) return;
    const base = httpBaseFromWsUrl(client.url);
    try {
      const mod = (await import(/* @vite-ignore */ `${base}${this.entry}`)) as { default?: MountFn };
      if (typeof mod?.default !== "function") throw new Error("plugin UI module has no default export");
      if (this.mountedKey !== key) return;
      const cleanup = mod.default(container, { client, pluginId: this.pluginId });
      this.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      this.error = "";
    } catch (err) {
      this.error = `Failed to load the ${this.pluginId} page: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  render() {
    return html`${g8GlassStyles}<style>
        plugin-entry-page { display: block; height: 100%; min-height: 0; overflow: auto; padding: clamp(10px, 2vw, 22px); box-sizing: border-box; }
        plugin-entry-page[bleed] { flex: 1; display: flex; flex-direction: column; padding: 0; overflow: hidden; }
        plugin-entry-page .pep-shell { min-height: 100%; }
        plugin-entry-page[bleed] > .pep-shell,
        plugin-entry-page[bleed] > .pep-shell > [data-plugin-entry] { flex: 1; min-height: 0; display: flex; flex-direction: column; }
        plugin-entry-page .pep-error { padding: 16px; border: 1px solid var(--g-line, rgba(255, 255, 255, 0.12)); border-radius: 12px; color: var(--muted, #a1a1aa); font-size: 13px; }
      </style>
      <div class="g8-page pep-shell">
        ${this.error ? html`<div class="pep-error" role="alert">${this.error}</div>` : nothing}
        <div data-plugin-entry></div>
      </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "plugin-entry-page": PluginEntryPage;
  }
}

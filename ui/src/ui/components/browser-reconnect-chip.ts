/**
 * <ib-browser-reconnect-chip> — shown under a chat tool result that says the
 * paired Chrome isn't connected (BROWSER_NOT_CONNECTED). Reconnect waits up
 * to 10 s for the extension to come back; "Set up" opens the browser step.
 */
import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getGatewayClient } from "../gateway-client";
import { icon } from "../icons.js";

export const BROWSER_NOT_CONNECTED_CODE = "BROWSER_NOT_CONNECTED";

export function isBrowserNotConnected(text: string | undefined | null): boolean {
  return Boolean(text && text.includes(BROWSER_NOT_CONNECTED_CODE));
}

@customElement("ib-browser-reconnect-chip")
export class BrowserReconnectChip extends LitElement {
  @state() private phase: "idle" | "busy" | "ok" | "still" = "idle";

  private async reconnect(e: Event): Promise<void> {
    e.stopPropagation();
    const client = getGatewayClient();
    if (!client) return;
    this.phase = "busy";
    try {
      const r = (await client
        .request("browser.connect.status", { waitMs: 10_000 })
        .catch(() => client.request("browser.extension.status", {}))) as {
        connected?: boolean;
        profiles?: Array<{ connected?: boolean }>;
      };
      const ok = r.connected === true || Boolean(r.profiles?.some((p) => p.connected));
      this.phase = ok ? "ok" : "still";
    } catch {
      this.phase = "still";
    }
  }

  private openSetup(e: Event): void {
    e.stopPropagation();
    const url = new URL("setup?step=browser", document.baseURI);
    window.history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  render() {
    const p = this.phase;
    return html`<div class="chip" role="status" data-testid="browser-reconnect-chip" @click=${(e: Event) => e.stopPropagation()}>
      <span class="msg">
        ${icon(p === "ok" ? "checkCircle" : "alertCircle")}
        ${p === "ok"
          ? "Chrome is connected again. Ask InfiniBot to try that once more."
          : p === "still"
            ? "Still not connected. Is Chrome open? You can also re-pair it."
            : "Browser not connected."}
      </span>
      ${p === "ok"
        ? nothing
        : html`<button type="button" class="btn btn--primary" data-testid="browser-reconnect" ?disabled=${p === "busy"} @click=${(e: Event) => void this.reconnect(e)}>
              ${p === "busy" ? "Reconnecting…" : html`${icon("refresh")}Reconnect`}
            </button>
            <button type="button" class="btn" @click=${(e: Event) => this.openSetup(e)}>Set up browser</button>`}
    </div>`;
  }

  static styles = css`
    :host {
      display: block;
      margin-top: 8px;
    }
    .chip {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 10px;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid rgba(246, 197, 107, 0.35);
      background: rgba(246, 197, 107, 0.07);
      font-size: 13px;
    }
    .msg {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      flex: 1 1 200px;
      color: #f6c56b;
    }
    .msg svg,
    .btn svg {
      width: 14px;
      height: 14px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 36px;
      padding: 0 12px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.16);
      background: rgba(255, 255, 255, 0.05);
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    .btn--primary {
      background: var(--g-primary, #d4af37);
      color: #17130a;
      border-color: transparent;
      font-weight: 600;
    }
    .btn:disabled {
      opacity: 0.6;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ib-browser-reconnect-chip": BrowserReconnectChip;
  }
}

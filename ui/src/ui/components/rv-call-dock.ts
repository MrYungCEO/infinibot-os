/**
 * <rv-call-dock> — a Robovoice call running while you're on another page
 * (typically one started from a chat): which chat it is bound to, one tap
 * back to the Voice page, and the collapsible live terminal stream of the
 * selected terminal / CLI coder run.
 *
 * Bottom-right on desktop; full-width along the bottom at phone widths.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { sessionLabel } from "../views/voice-robovoice/call-target.js";
import "./voice-terminal-stream.js";

type DockClient = {
  request: <T>(method: string, params?: unknown) => Promise<T>;
  subscribe?: (h: (evt: { event: string; payload?: unknown }) => void) => () => void;
};

const RV_CALL_EVENT = "infinibot:robovoice-call";

@customElement("rv-call-dock")
export class RvCallDock extends LitElement {
  @property({ attribute: false }) client: DockClient | null = null;
  @state() private sessionKey: string | null = null;
  @state() private agentId: string | null = null;

  static styles = css`
    :host {
      position: fixed; right: 18px; bottom: 18px; z-index: 60; width: min(560px, calc(100vw - 36px));
      display: flex; flex-direction: column; align-items: flex-end; gap: 8px; pointer-events: none;
    }
    :host > * { pointer-events: auto; }
    voice-terminal-stream { width: 100%; }
    .return {
      display: inline-flex; gap: 8px; align-items: center; min-height: 44px; padding: 10px 16px; border-radius: 999px; max-width: 100%;
      border: 1px solid var(--accent, #d4af37); background: var(--card, #0f0f0f); color: var(--text-strong, #fff);
      font: inherit; font-weight: 650; cursor: pointer; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
    }
    .return:focus-visible { outline: 2px solid var(--accent, #d4af37); outline-offset: 2px; }
    .dot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--ok, #22c55e); box-shadow: 0 0 8px var(--ok, #22c55e); }
    .chat { font-weight: 500; opacity: 0.8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    @media (max-width: 640px) {
      :host { right: 8px; left: 8px; bottom: calc(8px + env(safe-area-inset-bottom, 0px)); width: auto; }
      .return { align-self: stretch; justify-content: center; }
    }
  `;

  private onCall = (e: Event) => {
    const d = (e as CustomEvent<{ agentId?: string | null; sessionKey?: string | null }>).detail ?? {};
    this.sessionKey = d.sessionKey ?? null;
    this.agentId = d.agentId ?? null;
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(RV_CALL_EVENT, this.onCall);
    void import("../views/voice-robovoice/call-store.js").then(({ robovoiceCall }) => {
      this.sessionKey = robovoiceCall.state.sessionKey;
      this.agentId = robovoiceCall.state.agentId;
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(RV_CALL_EVENT, this.onCall);
  }

  render() {
    const chat = this.sessionKey ? sessionLabel(this.sessionKey) : null;
    return html`
      <voice-terminal-stream .client=${this.client} surface="call-dock"></voice-terminal-stream>
      <button class="return" data-testid="rv-call-return" title="Open the Voice page" @click=${() => this.dispatchEvent(new CustomEvent("call-return", { bubbles: true, composed: true }))}>
        <span class="dot" aria-hidden="true"></span>
        <span>Robovoice call</span>
        ${chat ? html`<span class="chat" data-testid="rv-call-chat" title=${this.sessionKey ?? ""}>· ${chat}</span>` : this.agentId ? html`<span class="chat">· ${this.agentId}</span>` : nothing}
        <span>· return</span>
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "rv-call-dock": RvCallDock;
  }
}

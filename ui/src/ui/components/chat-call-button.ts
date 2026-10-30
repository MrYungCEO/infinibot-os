/**
 * <chat-call-button> — "Call" from any chat surface (webchat composer, the
 * chat sidebar, plugin chats). Starts a Robovoice call bound to THAT chat
 * session: robovoice.call.start {agentId, sessionKey} — the plugin runs every
 * turn on the session, so the replies and transcript land in this chat.
 *
 * Unlinked installs land on the Voice page's Connect state (app-render's
 * `infinibot:voice-call` route). While this chat's call is live the button
 * reads "On call" and ends it; a call running for another chat disables it.
 */

import { isSecureSessionKey } from "../secure-mode/session-key";
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { agentIdFromSessionKey, chatCallButtonState, chatCallFailure, sessionLabel, type CallBinding } from "../views/voice-robovoice/call-target.js";
import { RV_LINK_EVENT, robovoiceCall, robovoiceLinked } from "../views/voice-robovoice/call-store.js";
import { startRobovoiceVoiceCall } from "../views/voice-robovoice/console-state.js";
import { VOICE_PROVIDER_EVENT } from "../controllers/voice-provider.js";

const RV_CALL_EVENT = "infinibot:robovoice-call";

@customElement("chat-call-button")
export class ChatCallButton extends LitElement {
  /** The chat session the call is bound to (e.g. agent:main:webchat:xyz). */
  @property() sessionKey = "";
  /** Agent to call; derived from the session key when omitted. */
  @property() agentId = "";
  @property({ type: Boolean }) disabled = false;
  /** Shown as text next to the icon (hidden on narrow composers). */
  @property({ type: Boolean, attribute: "show-label" }) showLabel = false;
  @property() source = "chat";

  @state() private call: CallBinding | null = null;
  /** This install's Robovoice link: false = show "Connect Robovoice" (calls are refused server-side). */
  @state() private linked: boolean | null = null;

  static styles = css`
    :host { display: inline-flex; }
    button {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-width: 32px; min-height: 32px; padding: 0 8px;
      border-radius: 999px; font: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
      background: transparent; color: var(--c-text-muted, #a1a1aa);
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 30%, transparent);
    }
    button:hover:not(:disabled) { color: var(--g-primary, #fbbf24); }
    button:focus-visible { outline: 2px solid var(--g-primary, #fbbf24); outline-offset: 2px; }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    :host { position: relative; }
    button.failed { color: var(--danger, #f87171); border-color: color-mix(in srgb, var(--danger, #f87171) 55%, transparent); }
    .err {
      position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 30; width: max-content; max-width: min(280px, 80vw);
      padding: 7px 10px; border-radius: 8px; font-size: 12px; line-height: 1.35; white-space: normal;
      color: var(--c-text, #f4f4f5); background: var(--c-surface, #18181b); border: 1px solid color-mix(in srgb, var(--danger, #f87171) 55%, transparent);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
    }
    button.connect { color: var(--g-primary, #fbbf24); border-style: dashed; }
    button.live { color: #04130a; background: var(--ok, #22c55e); border-color: var(--ok, #22c55e); font-weight: 650; }
    svg { width: 14px; height: 14px; flex: none; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
    @media (pointer: coarse) { button { min-width: 44px; min-height: 44px; } }
  `;

  private onCall = (e: Event) => {
    this.call = (e as CustomEvent<CallBinding>).detail ?? null;
  };

  private onProvider = () => this.requestUpdate();

  private onLink = (e: Event) => {
    const linked = (e as CustomEvent<{ linked?: boolean }>).detail?.linked;
    if (typeof linked === "boolean") this.linked = linked;
  };

  private refreshLink(maxAgeMs?: number): void {
    void robovoiceLinked(maxAgeMs).then((v) => {
      if (v !== null) this.linked = v;
    });
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(RV_CALL_EVENT, this.onCall);
    window.addEventListener(RV_LINK_EVENT, this.onLink);
    window.addEventListener(VOICE_PROVIDER_EVENT, this.onProvider);
    this.refreshLink();
    const s = robovoiceCall.state;
    this.call = { phase: s.phase, agentId: s.agentId, sessionKey: s.sessionKey, error: s.error };
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(RV_CALL_EVENT, this.onCall);
    window.removeEventListener(RV_LINK_EVENT, this.onLink);
    window.removeEventListener(VOICE_PROVIDER_EVENT, this.onProvider);
  }

  private onTap(): void {
    const st = chatCallButtonState(this.sessionKey, this.call);
    if (st === "other-call") return;
    if (st === "this-call") {
      void robovoiceCall.end();
      return;
    }
    // Unlinked: the same route opens the Voice page's Connect Robovoice state
    // (the gateway refuses the call anyway). Re-check the link on every tap.
    this.refreshLink(0);
    // Synchronously inside the tap: lets the browser play the agent's voice when it arrives.
    robovoiceCall.primeAudio();
    const agentId = this.agentId || agentIdFromSessionKey(this.sessionKey) || undefined;
    startRobovoiceVoiceCall({ agentId, sessionKey: this.sessionKey || undefined, source: this.source, stay: true });
  }

  render() {
    // Secure Mode: voice runs through hosted speech/LiveKit, so a secure
    // session never offers a call.
    if (isSecureSessionKey(this.sessionKey)) return nothing;
    const st = chatCallButtonState(this.sessionKey, this.call);
    const label = sessionLabel(this.sessionKey);
    const failure = st === "idle" ? chatCallFailure(this.sessionKey, this.call) : null;
    // Local voice (the default) needs no account; only cloud voice asks to connect Robovoice.
    const cloud = robovoiceCall.engine === "robovoice";
    const connect = cloud && st === "idle" && !failure && this.linked === false;
    const kind = cloud ? "Robovoice call" : "voice call";
    const title = connect
      ? "Connect Robovoice to use cloud voice (free) — or switch back to local voice on the Voice page"
      : st === "this-call"
        ? `On a ${kind} in this chat (${label}) — end call`
        : st === "other-call"
          ? `A ${kind} is already running in another chat`
          : failure
            ? `${failure} Tap to try again.`
            : `Voice call in this chat (${label})`;
    return html`<button
      class=${st === "this-call" ? "live" : failure ? "failed" : connect ? "connect" : ""}
      data-testid="chat-call-button"
      data-call=${failure ? "failed" : connect ? "connect" : st}
      data-call-error=${failure ?? ""}
      data-session-key=${this.sessionKey}
      ?disabled=${this.disabled || st === "other-call"}
      title=${title}
      aria-label=${title}
      aria-pressed=${st === "this-call" ? "true" : "false"}
      @click=${() => this.onTap()}
    >
      ${st === "this-call"
        ? html`<span class="dot" aria-hidden="true"></span>`
        : html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="m22 16.92-3.06-.85a2 2 0 0 0-1.9.5L15 18.6a16 16 0 0 1-9.6-9.6l2.43-2.04a2 2 0 0 0 .5-1.9L7.5 2A2 2 0 0 0 5.4.84a2 2 0 0 0-1.4.59L2.6 2.83A4 4 0 0 0 2 5.34c.6 7.5 6.16 13.06 13.66 13.66a4 4 0 0 0 2.5-.59l1.4-1.4a2 2 0 0 0 .43-2.09Z" />
          </svg>`}
      ${st === "this-call" ? html`<span>On call</span>` : this.showLabel ? html`<span>${connect ? "Connect Robovoice" : "Call"}</span>` : ""}
    </button>${failure ? html`<span class="err" role="status" data-testid="chat-call-error">${failure}</span>` : ""}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-call-button": ChatCallButton;
  }
}

/**
 * <chat-follow-pill> — phone counterpart of "chat follows navigation".
 *
 * On phones the chat dock would cover the page the agent just opened, so a
 * floating "Back to chat" pill is shown instead (see ../chat/chat-follow-nav.ts).
 * Tapping it returns to the same conversation (group chats included); a live
 * dot pulses while that session's reply is still streaming.
 */

import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";
import {
  CHAT_FOLLOW_PILL_EVENT,
  chatKeyForSession,
  type ChatFollowPillDetail,
} from "../chat/chat-follow-nav";
import { webchatPathForKey } from "../chat/chat-sessions";
import { inferBasePathFromPathname, pathForTab } from "../navigation";
import { isSecureSessionKey } from "../secure-mode/session-key";
import { isGroupChatKey } from "../../../../src/shared/group-chat/keys.js";

@customElement("chat-follow-pill")
export class ChatFollowPill extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;

  @state() private target: ChatFollowPillDetail = null;
  @state() private streaming = false;
  private unsub: (() => void) | null = null;
  private subscribedTo: GatewayBrowserClient | null = null;

  private onPill = (e: Event): void => {
    this.target = (e as CustomEvent<ChatFollowPillDetail>).detail ?? null;
    this.streaming = false;
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(CHAT_FOLLOW_PILL_EVENT, this.onPill);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(CHAT_FOLLOW_PILL_EVENT, this.onPill);
    this.unsub?.();
    this.unsub = null;
    this.subscribedTo = null;
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has("client") && this.client !== this.subscribedTo) {
      this.unsub?.();
      this.subscribedTo = this.client;
      this.unsub = this.client?.subscribe((evt) => {
        if (!this.target || evt.event !== "chat") return;
        const p = evt.payload as { sessionKey?: string; state?: string } | undefined;
        if (!p?.sessionKey || chatKeyForSession(p.sessionKey) !== this.target.key) return;
        this.streaming = p.state === "delta";
      }) ?? null;
    }
  }

  private back = (): void => {
    const t = this.target;
    if (!t) return;
    const base = inferBasePathFromPathname(window.location.pathname);
    const path = t.returnTab === "voice" ? pathForTab("voice" as never, base) : webchatPathForKey(t.key, base);
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
    this.target = null;
  };

  private dismiss = (): void => {
    this.target = null;
  };

  render() {
    const t = this.target;
    if (!t) return nothing;
    const secure = isSecureSessionKey(t.key);
    const group = isGroupChatKey(t.key);
    const label = group ? "Back to group chat" : "Back to chat";
    return html`
      <div class="wrap" role="region" aria-label="Chat in progress">
        <button class="pill ${secure ? "pill--secure" : ""}" data-chat-follow="pill" @click=${this.back} aria-label=${label}>
          <span class="ico" aria-hidden="true">
            ${group
              ? html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 5 18.5V20"/><circle cx="11" cy="8" r="3.5"/><path d="M19 20v-1.2a3 3 0 0 0-2.2-2.9M15.5 4.7a3.5 3.5 0 0 1 0 6.6"/></svg>`
              : html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12.5a7.5 7.5 0 0 1-11.1 6.6L4 20l1-4.4A7.5 7.5 0 1 1 20 12.5Z"/><path d="M9 11h6M9 14h3.5"/></svg>`}
          </span>
          <span class="label">${label}</span>
          ${secure
            ? html`<span class="sec" title="Secure Mode session" aria-label="Secure Mode"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span>`
            : nothing}
          ${this.streaming ? html`<span class="live" aria-label="Reply in progress"></span>` : nothing}
          <span class="arrow" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l-6 6 6 6"/></svg></span>
        </button>
        <button class="x" @click=${this.dismiss} aria-label="Dismiss" title="Dismiss">
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M2 2l8 8M10 2L2 10"/></svg>
        </button>
      </div>
    `;
  }

  static styles = css`
    :host {
      position: fixed;
      left: 50%;
      bottom: calc(84px + env(safe-area-inset-bottom, 0px));
      transform: translateX(-50%);
      z-index: 100005;
      pointer-events: none;
      font-family: var(--glass-font, var(--font-body, system-ui, sans-serif));
      max-width: calc(100vw - 24px);
    }
    .wrap {
      pointer-events: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      animation: rise 0.28s cubic-bezier(0.2, 0.8, 0.2, 1);
      max-width: 100%;
    }
    @keyframes rise {
      from { opacity: 0; transform: translateY(10px) scale(0.98); }
      to { opacity: 1; transform: none; }
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      min-height: 46px;
      min-width: 0;
      padding: 0 16px 0 8px;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #fbbf24) 45%, transparent);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.07), rgba(255, 255, 255, 0) 60%),
        color-mix(in srgb, #0b0b0d 88%, transparent);
      color: #f5f1e6;
      font: inherit;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.01em;
      cursor: pointer;
      box-shadow:
        0 14px 34px rgba(0, 0, 0, 0.55),
        0 0 0 1px rgba(0, 0, 0, 0.4),
        inset 0 1px 0 rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(16px) saturate(140%);
      -webkit-backdrop-filter: blur(16px) saturate(140%);
      -webkit-tap-highlight-color: transparent;
    }
    .pill:active { transform: scale(0.98); }
    .pill:focus-visible, .x:focus-visible {
      outline: 2px solid var(--g-primary, #fbbf24);
      outline-offset: 2px;
    }
    .pill--secure {
      border-color: var(--ib-secure-ring, rgba(52, 211, 153, 0.55));
    }
    .ico {
      flex: none;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      color: #0b0b0d;
      background: linear-gradient(135deg, #fde68a, var(--g-primary, #fbbf24) 55%, #d97706);
      box-shadow: 0 0 14px color-mix(in srgb, var(--g-primary, #fbbf24) 45%, transparent);
    }
    .ico svg { width: 17px; height: 17px; }
    .label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sec {
      flex: none;
      display: inline-grid;
      place-items: center;
      color: var(--ib-secure-fg, #34d399);
    }
    .sec svg { width: 14px; height: 14px; }
    .live {
      flex: none;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--g-primary, #fbbf24);
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--g-primary, #fbbf24) 60%, transparent);
      animation: pulse 1.4s ease-out infinite;
    }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--g-primary, #fbbf24) 60%, transparent); }
      100% { box-shadow: 0 0 0 9px transparent; }
    }
    .arrow {
      flex: none;
      display: inline-grid;
      place-items: center;
      color: var(--g-primary, #fbbf24);
      transform: rotate(180deg);
    }
    .arrow svg { width: 15px; height: 15px; }
    .x {
      flex: none;
      width: 34px;
      height: 34px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: color-mix(in srgb, #0b0b0d 82%, transparent);
      color: rgba(245, 241, 230, 0.75);
      cursor: pointer;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    .x svg { width: 11px; height: 11px; }
    @media (prefers-reduced-motion: reduce) {
      .wrap, .live { animation: none; }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-follow-pill": ChatFollowPill;
  }
}

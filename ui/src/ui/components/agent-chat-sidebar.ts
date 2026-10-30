/**
 * Agent Chat Sidebar
 *
 * Sticky right-side panel that hosts the agent chat + autopilot toggle.
 * Sticky agent chat sidebar for Lit views.
 *
 * The sidebar is overlay-positioned and floats on top of any page that opts
 * in (business / agents / discipline / grid). When autopilot is on, user
 * messages are routed through `runAutopilot`; otherwise they're sent through
 * the regular gateway chat (`chat.send`) so the user gets normal answers.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";
import type { Tab } from "../navigation";
import {
  type AutopilotState,
  appendMessage,
  appendLineToMessage,
  clearMessages,
  runAutopilot,
} from "../controllers/autopilot";
import { subscribeNarration } from "../lib/autonomy-bus";
import "../secure-mode/secure-toggle";
import { isSecureSessionKey } from "../secure-mode/session-key";
import { SecureSurfaceLane, renderSecureSurfaceBadge, secureSurfaceStyles } from "../secure-mode/chat-surface";

@customElement("agent-chat-sidebar")
export class AgentChatSidebar extends LitElement {
  /**
   * Live autopilot state (passed in from the parent app). Mutated in-place by
   * the navbar toggle and the run controller, so we always treat it as changed
   * — Lit's default reference-equality check would skip re-renders on nested
   * mutations and the sidebar would stay hidden after clicking the star pill.
   */
  @property({ attribute: false, hasChanged: () => true }) autopilot: AutopilotState | null = null;
  /** Gateway client. */
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  /** The current page tab. */
  @property({ attribute: false }) tab: Tab = "chat";
  /** Default session key for plain chat sends. */
  @property({ attribute: false }) sessionKey = "agent:main";

  @state() private narrationTick = 0;
  /** Secure lane key for plain chat sends ("" = follow `sessionKey`). */
  @state() private laneKey = "";
  private readonly secureLane = new SecureSurfaceLane(this);

  /** Key plain chat sends go to: the secure lane when on, else the page's chat. */
  private get chatKey(): string {
    return this.laneKey || this.sessionKey;
  }

  private get agentId(): string {
    return /^agent:([^:]+)/.exec(this.chatKey)?.[1] ?? "main";
  }

  /**
   * Secure Mode toggle. On: secure session for the agent (autopilot drives the
   * page with hosted models, so it is switched off in the secure lane). Off:
   * back to the page's chat.
   */
  private async onSecureToggle(on: boolean): Promise<void> {
    const from = this.chatKey;
    const next = await this.secureLane.switch({
      on,
      surface: "autopilot",
      agentId: this.agentId,
      currentKey: from,
      fallbackNormalKey: this.sessionKey,
    });
    if (next === undefined || from !== this.chatKey) return;
    this.laneKey = next && isSecureSessionKey(next) && next !== this.sessionKey ? next : "";
    if (this.autopilot && isSecureSessionKey(this.chatKey) && this.autopilot.autopilotOn) {
      this.autopilot.autopilotOn = false;
      this.dispatchEvent(new CustomEvent("autopilot-change", { bubbles: true, composed: true }));
    }
  }
  private narrationUnsub: (() => void) | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    // Re-render whenever a narration event fires so live runs update inline.
    this.narrationUnsub = subscribeNarration(() => {
      this.narrationTick++;
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.narrationUnsub?.();
    this.narrationUnsub = null;
  }

  static override styles = [css`
    :host {
      position: fixed;
      top: 64px;
      right: 12px;
      bottom: 12px;
      width: 360px;
      max-width: calc(100vw - 24px);
      z-index: 9000;
      pointer-events: none;
      font-family: var(--font-family, system-ui, sans-serif);
    }
    .panel {
      pointer-events: auto;
      height: 100%;
      display: flex;
      flex-direction: column;
      background: color-mix(in srgb, var(--g-bg, #0a0a0a) 92%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary, #f5a623) 30%, transparent);
      border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(8px);
      overflow: hidden;
    }
    .toggle {
      pointer-events: auto;
      position: absolute;
      top: 0;
      right: 0;
      transform: translateX(0);
      background: var(--g-primary, #f5a623);
      color: #000;
      border: none;
      padding: 8px 14px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 6px 14px rgba(0, 0, 0, 0.35);
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary, #f5a623) 20%, transparent);
      background: color-mix(in srgb, var(--g-primary, #f5a623) 8%, transparent);
    }
    .title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
      color: var(--g-primary, #f5a623);
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--g-primary, #f5a623) 25%, transparent);
      color: var(--g-primary, #f5a623);
    }
    .actions {
      display: flex;
      gap: 6px;
    }
    button.icon {
      background: transparent;
      border: 1px solid color-mix(in srgb, var(--g-primary, #f5a623) 30%, transparent);
      color: var(--g-primary, #f5a623);
      padding: 4px 8px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 11px;
    }
    button.icon[aria-pressed="true"] {
      background: var(--g-primary, #f5a623);
      color: #000;
    }
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 13px;
      color: var(--g-fg, #eee);
    }
    .msg {
      padding: 8px 10px;
      border-radius: 8px;
      white-space: pre-wrap;
      word-wrap: break-word;
      line-height: 1.4;
    }
    .msg.user {
      align-self: flex-end;
      background: color-mix(in srgb, var(--g-primary, #f5a623) 18%, transparent);
      max-width: 85%;
    }
    .msg.assistant {
      align-self: flex-start;
      background: color-mix(in srgb, #ffffff 6%, transparent);
      border: 1px solid color-mix(in srgb, var(--g-primary, #f5a623) 15%, transparent);
      max-width: 90%;
    }
    .msg.system {
      align-self: center;
      font-size: 11px;
      opacity: 0.6;
    }
    .empty {
      align-self: center;
      margin-top: 24px;
      text-align: center;
      opacity: 0.5;
      font-size: 12px;
      max-width: 280px;
    }
    .form {
      padding: 10px;
      border-top: 1px solid color-mix(in srgb, var(--g-primary, #f5a623) 20%, transparent);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      color: var(--g-muted, #aaa);
    }
    .switch {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      user-select: none;
    }
    .switch input {
      accent-color: var(--g-primary, #f5a623);
    }
    .input-row {
      display: flex;
      gap: 6px;
    }
    textarea {
      flex: 1;
      resize: none;
      min-height: 40px;
      max-height: 140px;
      padding: 8px 10px;
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid color-mix(in srgb, var(--g-primary, #f5a623) 25%, transparent);
      border-radius: 8px;
      color: var(--g-fg, #eee);
      font-family: inherit;
      font-size: 13px;
    }
    textarea:focus {
      outline: none;
      border-color: var(--g-primary, #f5a623);
    }
    .send {
      align-self: flex-end;
      background: var(--g-primary, #f5a623);
      color: #000;
      border: none;
      border-radius: 8px;
      padding: 0 14px;
      font-weight: 600;
      cursor: pointer;
      min-width: 64px;
    }
    .send:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .running {
      font-size: 11px;
      color: var(--g-primary, #f5a623);
      padding: 4px 12px;
      background: color-mix(in srgb, var(--g-primary, #f5a623) 10%, transparent);
      border-top: 1px solid color-mix(in srgb, var(--g-primary, #f5a623) 20%, transparent);
    }
    .acs-sec-row { gap: 6px; }
    .switch--off { opacity: 0.5; cursor: not-allowed; }
    .form.form--secure textarea { border-color: var(--ib-secure-ring, rgba(52, 211, 153, 0.5)); box-shadow: var(--ib-secure-glow, none); }
  `, secureSurfaceStyles];

  override render() {
    if (!this.autopilot) return nothing;
    const a = this.autopilot;

    // The navbar pill is the canonical open/close trigger; the component
    // renders nothing when collapsed so we don't show a duplicate floating
    // toggle in the corner.
    if (!a.sidebarOpen) return nothing;

    const activeCount = a.activeRuns.size;
    const secure = isSecureSessionKey(this.chatKey);

    return html`
      <div class="panel">
        <div class="header">
          <div class="title">
            <span>✦ Agent</span>
            ${a.autopilotOn ? html`<span class="badge">AUTOPILOT</span>` : nothing}
            <span class="badge">${this.tab}</span>
          </div>
          <div class="actions">
            <button class="icon" title="Clear chat" @click=${this.handleClear}>↺</button>
            <button class="icon" title="Close" @click=${this.handleClose}>✕</button>
          </div>
        </div>

        <div class="messages">
          ${a.messages.length === 0
            ? html`<div class="empty">
                Ask anything. Toggle <strong>Autopilot</strong> to let the agent
                drive this page.
              </div>`
            : a.messages.map(
                (m) => html`<div class="msg ${m.role}">${m.text || "…"}</div>`,
              )}
        </div>

        ${activeCount > 0
          ? html`<div class="running">
              ⏵ ${activeCount} run${activeCount === 1 ? "" : "s"} in flight…
            </div>`
          : nothing}

        <form class="form ${secure ? "form--secure" : ""}" @submit=${this.handleSubmit}>
          <div class="toggle-row">
            <label class="switch ${secure ? "switch--off" : ""}" title=${secure ? "Autopilot is off in a Secure Mode session" : ""}>
              <input
                type="checkbox"
                .checked=${a.autopilotOn && !secure}
                ?disabled=${secure}
                @change=${this.handleToggleAutopilot}
              />
              Autopilot drives the page
            </label>
            ${a.error ? html`<span style="color:#f55;">${a.error}</span>` : nothing}
          </div>
          ${this.secureLane.supported
            ? html`<div class="ibss-row acs-sec-row" data-secure-row="autopilot">
                ${renderSecureSurfaceBadge(this.chatKey, { surface: "autopilot", short: true })}
                <span class="ibss-row__spacer"></span>
                <ib-secure-toggle
                  compact
                  mode="custom"
                  data-secure-surface="autopilot"
                  .on=${secure}
                  .busy=${this.secureLane.busy}
                  .error=${this.secureLane.error}
                  ?disabled=${!this.client || a.sending}
                  @secure-toggle=${(e: CustomEvent<{ on: boolean }>) => void this.onSecureToggle(e.detail.on)}
                ></ib-secure-toggle>
              </div>`
            : nothing}
          <div class="input-row">
            <textarea
              .value=${a.draft}
              placeholder=${a.autopilotOn && !secure
                ? "What should the agent do on this page?"
                : secure
                  ? "Ask privately (local models only)…"
                  : "Ask anything…"}
              @input=${this.handleInput}
              @keydown=${this.handleKeydown}
              ?disabled=${a.sending}
            ></textarea>
            <button
              type="submit"
              class="send"
              ?disabled=${a.sending || !a.draft.trim()}
            >
              ${a.autopilotOn && !secure ? "Run" : "Send"}
            </button>
          </div>
        </form>
      </div>
    `;
  }

  private handleOpen = () => {
    if (!this.autopilot) return;
    this.autopilot.sidebarOpen = true;
    this.dispatchEvent(new CustomEvent("autopilot-change", { bubbles: true, composed: true }));
  };

  private handleClose = () => {
    if (!this.autopilot) return;
    this.autopilot.sidebarOpen = false;
    this.dispatchEvent(new CustomEvent("autopilot-change", { bubbles: true, composed: true }));
  };

  private handleClear = () => {
    if (!this.autopilot) return;
    clearMessages(this.autopilot);
    this.dispatchEvent(new CustomEvent("autopilot-change", { bubbles: true, composed: true }));
  };

  private handleToggleAutopilot = (e: Event) => {
    if (!this.autopilot) return;
    this.autopilot.autopilotOn = (e.target as HTMLInputElement).checked;
    this.dispatchEvent(new CustomEvent("autopilot-change", { bubbles: true, composed: true }));
  };

  private handleInput = (e: Event) => {
    if (!this.autopilot) return;
    this.autopilot.draft = (e.target as HTMLTextAreaElement).value;
    this.dispatchEvent(new CustomEvent("autopilot-change", { bubbles: true, composed: true }));
  };

  private handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void this.send();
    }
  };

  private handleSubmit = (e: Event) => {
    e.preventDefault();
    void this.send();
  };

  private async send(): Promise<void> {
    if (!this.autopilot || !this.client) return;
    const a = this.autopilot;
    const text = a.draft.trim();
    if (!text || a.sending) return;
    a.draft = "";
    a.error = null;

    if (a.autopilotOn && !isSecureSessionKey(this.chatKey)) {
      // Fire-and-forget so the input is free immediately.
      void runAutopilot({
        state: a,
        client: this.client,
        tab: this.tab,
        prompt: text,
        requestUpdate: () => {
          this.dispatchEvent(new CustomEvent("autopilot-change", { bubbles: true, composed: true }));
        },
      });
      this.dispatchEvent(new CustomEvent("autopilot-change", { bubbles: true, composed: true }));
      return;
    }

    // Plain chat: append user message, send via gateway, append the response.
    appendMessage(a, "user", text);
    const assistantMsg = appendMessage(a, "assistant", "…");
    a.sending = true;
    this.dispatchEvent(new CustomEvent("autopilot-change", { bubbles: true, composed: true }));
    try {
      const res = (await this.client.request("chat.send", {
        sessionKey: this.chatKey,
        message: text,
      })) as { reply?: string; output?: string; text?: string };
      const reply = res?.reply ?? res?.output ?? res?.text ?? "(no reply)";
      appendLineToMessage(a, assistantMsg.id, reply);
      // Replace placeholder with the final reply (clean swap)
      a.messages = a.messages.map((m) =>
        m.id === assistantMsg.id
          ? { ...m, text: reply }
          : m,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "send failed";
      a.error = msg;
      a.messages = a.messages.map((m) =>
        m.id === assistantMsg.id ? { ...m, text: `⚠ ${msg}` } : m,
      );
    } finally {
      a.sending = false;
      this.dispatchEvent(new CustomEvent("autopilot-change", { bubbles: true, composed: true }));
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "agent-chat-sidebar": AgentChatSidebar;
  }
}

/**
 * Header button for the global navbar. Toggles the sidebar open/closed and
 * shows a count badge while autopilot runs are in flight. Use from
 * `app-render.ts` next to the other header pills.
 */
export function renderAgentSidebarButton(args: {
  autopilot: AutopilotState;
  onToggle: () => void;
}) {
  const { autopilot, onToggle } = args;
  const active = autopilot.activeRuns.size;
  const isOn = autopilot.sidebarOpen;
  return html`
    <button
      class="pill"
      style="
        cursor:pointer; border:none; position:relative;
        ${isOn ? "background: var(--c-accent, var(--g-primary, #f5a623)); color:#000;" : ""}
        ${autopilot.autopilotOn ? "outline:1px solid var(--g-primary, #f5a623);" : ""}
      "
      @click=${onToggle}
      title=${autopilot.autopilotOn
        ? "Agent · Autopilot on"
        : "Agent chat sidebar"}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2l2.39 4.84L20 8l-4 3.9L17 18l-5-2.6L7 18l1-6.1L4 8l5.61-1.16L12 2z"/>
      </svg>
      ${active > 0
        ? html`<span style="
            position:absolute; top:2px; right:2px;
            min-width:14px; height:14px; padding:0 3px;
            background:#f5a623; color:#000;
            font-size:8px; font-weight:700;
            display:flex; align-items:center; justify-content:center;
            border-radius:7px;
          ">${active}</span>`
        : nothing}
    </button>
  `;
}

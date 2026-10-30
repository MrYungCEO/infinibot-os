/**
 * <agent-comm-panel> — glass communication side panel for the constellation
 * org chart. Opens when the operator clicks a star: shows the agent's role,
 * status, model and last session, and carries a live message thread routed
 * straight to that agent.
 *
 * Messaging reuses the exact plumbing proven by <cmo-chat>: `chat.send` with
 * a per-agent session key (`agent:<id>:constellation-chat`), streaming the
 * reply token-by-token from the gateway `chat` events and surfacing tool
 * activity from `agent` events. No new backend surface.
 *
 * Events (bubbling, composed):
 *   panel-close    — operator dismissed the panel
 *   open-sessions  — quick action: jump to the agent's sessions
 *   open-edit      — quick action: open the agent config overlay
 */

import { LitElement, css, html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { customElement, property, state } from "lit/decorators.js";
import { toSanitizedMarkdownHtml } from "../markdown/render";

import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway";

/** Pull display text out of a gateway chat message payload (delta or final). */
function extractText(message: unknown): string | null {
  const msg = message as { content?: unknown; text?: unknown } | undefined;
  const c = msg?.content as Array<{ text?: string }> | string | undefined;
  if (Array.isArray(c)) {
    const joined = c
      .map((b) => (typeof b?.text === "string" ? b.text : ""))
      .join("");
    return joined || null;
  }
  if (typeof c === "string") return c || null;
  if (typeof msg?.text === "string") return msg.text || null;
  return null;
}

type ThreadItem =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "tool"; name: string }
  | { role: "error"; text: string };

@customElement("agent-comm-panel")
export class AgentCommPanel extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property() agentId = "";
  @property() agentName = "";
  @property() agentRole = "";
  @property() agentStatus = "idle";
  @property() model = "";
  @property({ type: Number }) sessionCount = 0;
  @property() lastSessionLabel = "";
  @property() lastSessionAgo = "";
  @property() avatarUrl = "";

  @state() private items: ThreadItem[] = [];
  @state() private draft = "";
  @state() private sending = false;
  @state() private streamText: string | null = null;
  @state() private error: string | null = null;

  private unsub: (() => void) | null = null;
  private threadAgentId = "";

  // ── Free-floating drag + resize state ──────────────────────────────
  private _fpPos = { x: -1, y: -1 };
  private _fpSize = { w: 390, h: 560 };
  private _fpDrag: { sx: number; sy: number; ox: number; oy: number } | null = null;
  private _fpResize: { sx: number; sy: number; ow: number; oh: number } | null = null;
  private _fpInited = false;

  private _fpLoad(): void {
    try {
      const d = JSON.parse(localStorage.getItem("infinibot.acp.float.v1") ?? "{}");
      if (typeof d.x === "number") this._fpPos = { x: d.x, y: d.y };
      if (typeof d.w === "number") this._fpSize = { w: d.w, h: d.h };
    } catch { /* ignore */ }
    if (this._fpPos.x < 0) this._fpPos = { x: Math.max(0, window.innerWidth - 420), y: 20 };
  }

  private _fpSave(): void {
    try { localStorage.setItem("infinibot.acp.float.v1", JSON.stringify({ ...this._fpPos, ...this._fpSize })); } catch { /* ignore */ }
  }

  private _fpApply(): void {
    const W = window.innerWidth, H = window.innerHeight;
    const { w, h } = this._fpSize;
    const x = Math.max(0, Math.min(this._fpPos.x, W - w));
    const y = Math.max(0, Math.min(this._fpPos.y, H - 60));
    this.style.left = `${x}px`; this.style.top = `${y}px`;
    this.style.width = `${w}px`; this.style.height = `${h}px`;
    this.style.right = "auto"; this.style.bottom = "auto";
  }

  private _onDragDown = (e: PointerEvent): void => {
    if ((e.target as Element)?.closest(".comm-close, .comm-action, button, input, textarea, select, .fp-resize-grip, .thread")) return;
    const r = this.getBoundingClientRect();
    this._fpDrag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  private _onDragMove = (e: PointerEvent): void => {
    if (!this._fpDrag) return;
    this._fpPos = { x: this._fpDrag.ox + e.clientX - this._fpDrag.sx, y: this._fpDrag.oy + e.clientY - this._fpDrag.sy };
    this._fpApply();
  };
  private _onDragUp = (): void => { if (!this._fpDrag) return; this._fpDrag = null; this._fpSave(); };

  private _onResizeDown = (e: PointerEvent): void => {
    this._fpResize = { sx: e.clientX, sy: e.clientY, ow: this._fpSize.w, oh: this._fpSize.h };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.stopPropagation(); e.preventDefault();
  };
  private _onResizeMove = (e: PointerEvent): void => {
    if (!this._fpResize) return;
    this._fpSize = { w: Math.max(280, this._fpResize.ow + e.clientX - this._fpResize.sx), h: Math.max(320, this._fpResize.oh + e.clientY - this._fpResize.sy) };
    this._fpApply();
  };
  private _onResizeUp = (): void => { if (!this._fpResize) return; this._fpResize = null; this._fpSave(); };

  private _onWinResize = (): void => { this._fpApply(); };

  private get sessionKey(): string {
    return `agent:${this.agentId}:constellation-chat`;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.subscribe();
    this._fpLoad();
    window.addEventListener("resize", this._onWinResize);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsub?.();
    this.unsub = null;
    window.removeEventListener("resize", this._onWinResize);
  }

  protected updated(): void {
    // Wire entire panel as drag surface (idempotent via __fpb flag)
    const panel = this.renderRoot?.querySelector(".panel") as HTMLElement | null;
    if (panel && !(panel as any).__fpb) {
      panel.addEventListener("pointerdown", this._onDragDown);
      panel.addEventListener("pointermove", this._onDragMove);
      panel.addEventListener("pointerup", this._onDragUp);
      (panel as any).__fpb = true;
    }
    const grip = this.renderRoot?.querySelector(".fp-resize-grip") as HTMLElement | null;
    if (grip && !(grip as any).__fpb) {
      grip.addEventListener("pointerdown", this._onResizeDown);
      grip.addEventListener("pointermove", this._onResizeMove);
      grip.addEventListener("pointerup", this._onResizeUp);
      (grip as any).__fpb = true;
    }
    this._fpApply();
  }

  protected willUpdate(): void {
    // Switching stars resets the thread — each agent gets its own comms line.
    if (this.agentId !== this.threadAgentId) {
      this.threadAgentId = this.agentId;
      this.items = [];
      this.streamText = null;
      this.sending = false;
      this.error = null;
    }
    if (!this.unsub && this.client) this.subscribe();
  }

  private subscribe(): void {
    if (!this.client || this.unsub) return;
    this.unsub = this.client.subscribe((evt) => this.onEvent(evt));
  }

  private onEvent(evt: GatewayEventFrame): void {
    if (evt.event === "chat") {
      const p = evt.payload as
        | { sessionKey?: string; state?: string; message?: unknown; errorMessage?: string }
        | undefined;
      if (!p || p.sessionKey !== this.sessionKey) return;
      if (p.state === "delta") {
        const chunk = extractText(p.message);
        if (chunk && chunk.length > (this.streamText?.length ?? 0)) {
          this.streamText = chunk;
          this.scrollToBottom();
        }
      } else if (p.state === "final" || p.state === "aborted") {
        // Some runs deliver no deltas and an empty final frame — the reply
        // only lands in session history. Same recovery as the main chat view.
        const finalText = this.streamText || extractText(p.message);
        this.sending = false;
        this.streamText = null;
        if (finalText) this.items = [...this.items, { role: "assistant", text: finalText }];
        else if (p.state === "final") void this.fetchFinalFromHistory();
        this.scrollToBottom();
      } else if (p.state === "error") {
        this.sending = false;
        this.streamText = null;
        this.error = p.errorMessage ?? "Request failed";
      }
      return;
    }
    if (evt.event === "agent") {
      const p = evt.payload as
        | { sessionKey?: string; stream?: string; data?: Record<string, unknown> }
        | undefined;
      if (!p || p.stream !== "tool" || p.sessionKey !== this.sessionKey) return;
      const data = p.data ?? {};
      if (((data.phase as string) ?? "start") === "start") {
        this.items = [...this.items, { role: "tool", name: (data.name as string) ?? "tool" }];
        this.scrollToBottom();
      }
    }
  }

  /** Pull the last assistant reply out of chat.history when the final frame was empty. */
  private async fetchFinalFromHistory(): Promise<void> {
    if (!this.client) return;
    const forAgent = this.agentId;
    try {
      const res = (await this.client.request("chat.history", {
        sessionKey: this.sessionKey,
        limit: 50,
      })) as { messages?: Array<{ role?: string; content?: unknown }> };
      if (this.agentId !== forAgent) return;
      const msgs = res?.messages ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.role === "assistant") {
          const text = extractText(msgs[i]);
          if (text) {
            this.items = [...this.items, { role: "assistant", text }];
            this.scrollToBottom();
          }
          return;
        }
      }
    } catch {
      /* leave the thread as-is — history is a best-effort recovery */
    }
  }

  private scrollToBottom(): void {
    void this.updateComplete.then(() => {
      const log = this.renderRoot.querySelector<HTMLElement>(".thread");
      if (log) log.scrollTop = log.scrollHeight;
    });
  }

  private async send(): Promise<void> {
    const msg = this.draft.trim();
    if (!msg || this.sending || !this.client || !this.agentId) return;
    this.error = null;
    this.draft = "";
    this.items = [...this.items, { role: "user", text: msg }];
    this.sending = true;
    this.streamText = "";
    this.scrollToBottom();
    try {
      const idempotencyKey = `orgchart-${this.agentId}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      await this.client.request("chat.send", {
        sessionKey: this.sessionKey,
        message: msg,
        deliver: false,
        idempotencyKey,
      });
    } catch (e) {
      this.sending = false;
      this.streamText = null;
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  private onComposerKey(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void this.send();
    }
  }

  private emit(name: string): void {
    this.dispatchEvent(
      new CustomEvent(name, { detail: { agentId: this.agentId }, bubbles: true, composed: true })
    );
  }

  focusComposer(): void {
    this.renderRoot.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }

  static styles = css`
    :host {
      position: fixed;
      z-index: 9100;
      width: 390px;
      height: 560px;
      min-width: 260px;
      min-height: 320px;
      display: flex;
      font-family: "JetBrains Mono", "SF Mono", monospace;
      /* left/top controlled by JS drag engine */
    }
    /* ── Drag bar ── */
    .fp-drag-bar {
      height: 20px;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 0 10px;
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    .fp-drag-bar:active { cursor: grabbing; }
    .panel:active { cursor: grabbing; }
    .fp-grip {
      font-size: 10px;
      letter-spacing: -1.5px;
      color: color-mix(in srgb, var(--g-primary, #d4a017) 45%, transparent);
      text-shadow: 0 0 6px color-mix(in srgb, var(--g-primary, #d4a017) 30%, transparent);
    }
    .fp-drag-label {
      flex: 1;
      font-size: 8.5px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: color-mix(in srgb, var(--g-primary, #d4a017) 55%, transparent);
      pointer-events: none;
    }
    /* ── Resize grip ── */
    .fp-resize-grip {
      position: absolute;
      bottom: 0;
      right: 0;
      width: 20px;
      height: 20px;
      cursor: se-resize;
      z-index: 5;
      touch-action: none;
    }
    .fp-resize-grip::after {
      content: "";
      position: absolute;
      bottom: 5px;
      right: 5px;
      width: 8px;
      height: 8px;
      border-right: 2px solid color-mix(in srgb, var(--g-primary, #d4a017) 40%, transparent);
      border-bottom: 2px solid color-mix(in srgb, var(--g-primary, #d4a017) 40%, transparent);
      border-radius: 0 0 2px 0;
      transition: border-color 150ms ease;
    }
    .fp-resize-grip:hover::after {
      border-color: color-mix(in srgb, var(--g-primary, #d4a017) 75%, transparent);
    }
    .panel {
      flex: 1;
      display: flex;
      flex-direction: column;
      min-height: 0;
      border-radius: 20px;
      overflow: hidden;
      /* Borderless glass: lighter body, heavier blur; the edge is pure light
         (hairline glow ring + breathing outer bloom), not a border stroke. */
      background: linear-gradient(168deg, rgba(22, 18, 10, 0.7) 0%, rgba(8, 7, 4, 0.82) 100%);
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4a017) 35%, transparent);
      cursor: grab;
      box-shadow:
        0 34px 90px rgba(0, 0, 0, 0.68),
        0 0 0 1px color-mix(in srgb, var(--g-primary, #d4a017) 24%, transparent),
        0 0 46px color-mix(in srgb, var(--g-primary, #d4a017) 16%, transparent),
        inset 0 1px 0 rgba(255, 255, 255, 0.07);
      backdrop-filter: blur(28px) saturate(185%);
      -webkit-backdrop-filter: blur(28px) saturate(185%);
      animation:
        comm-in 0.32s cubic-bezier(0.2, 0.9, 0.25, 1.08) both,
        comm-breathe 6s ease-in-out 0.4s infinite;
    }
    @keyframes comm-breathe {
      0%, 100% {
        box-shadow:
          0 34px 90px rgba(0, 0, 0, 0.68),
          0 0 0 1px color-mix(in srgb, var(--g-primary, #d4a017) 24%, transparent),
          0 0 46px color-mix(in srgb, var(--g-primary, #d4a017) 16%, transparent),
          inset 0 1px 0 rgba(255, 255, 255, 0.07);
      }
      50% {
        box-shadow:
          0 34px 90px rgba(0, 0, 0, 0.68),
          0 0 0 1px color-mix(in srgb, var(--g-primary, #d4a017) 40%, transparent),
          0 0 66px color-mix(in srgb, var(--g-primary, #d4a017) 30%, transparent),
          inset 0 1px 0 rgba(255, 255, 255, 0.07);
      }
    }
    @keyframes comm-in {
      from {
        opacity: 0;
        transform: translateX(26px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateX(0) scale(1);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .panel {
        animation: none;
      }
    }
    .panel::before {
      content: "";
      position: absolute;
      top: 0;
      left: 8%;
      right: 8%;
      height: 1px;
      background: linear-gradient(
        90deg,
        transparent,
        color-mix(in srgb, var(--g-primary, #d4a017) 85%, white),
        transparent
      );
      z-index: 2;
    }
    .head {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 16px 13px;
      border-bottom: 1px solid color-mix(in srgb, var(--g-primary, #d4a017) 16%, transparent);
      background: linear-gradient(
        180deg,
        color-mix(in srgb, var(--g-primary, #d4a017) 7%, transparent),
        transparent
      );
    }
    .avatar {
      width: 46px;
      height: 46px;
      flex-shrink: 0;
      border-radius: 12px;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      font-size: 18px;
      color: #0a0805;
      background: linear-gradient(
        135deg,
        color-mix(in srgb, var(--g-primary, #d4a017) 90%, #fff),
        var(--g-primary, #d4a017)
      );
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4a017) 55%, transparent);
      box-shadow: 0 0 22px color-mix(in srgb, var(--g-primary, #d4a017) 30%, transparent);
    }
    .avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .who {
      flex: 1;
      min-width: 0;
    }
    .who .name {
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #f6f1e4;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .who .role {
      margin-top: 2px;
      font-size: 8.5px;
      font-weight: 700;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: color-mix(in srgb, var(--g-primary, #d4a017) 80%, #e8d9ad);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .close {
      flex-shrink: 0;
      width: 30px;
      height: 30px;
      border-radius: 9px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: rgba(235, 228, 210, 0.6);
      cursor: pointer;
      font-size: 15px;
      line-height: 1;
      transition: all 0.16s ease;
    }
    .close:hover {
      color: #fff;
      border-color: var(--g-primary, #d4a017);
      background: color-mix(in srgb, var(--g-primary, #d4a017) 16%, transparent);
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 10px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 8.5px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: rgba(235, 228, 210, 0.72);
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chip .dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .chip.status-active {
      color: #4feaa9;
      border-color: rgba(79, 234, 169, 0.32);
      background: rgba(79, 234, 169, 0.07);
      animation: comm-chip-glow 2.4s ease-in-out infinite;
    }
    .chip.status-active .dot {
      background: #4feaa9;
      animation: comm-ring 2s ease-out infinite;
    }
    @keyframes comm-ring {
      0% {
        box-shadow:
          0 0 7px rgba(79, 234, 169, 0.9),
          0 0 0 0 rgba(79, 234, 169, 0.55);
      }
      100% {
        box-shadow:
          0 0 7px rgba(79, 234, 169, 0.9),
          0 0 0 10px rgba(79, 234, 169, 0);
      }
    }
    @keyframes comm-chip-glow {
      0%, 100% { box-shadow: 0 0 10px -4px rgba(79, 234, 169, 0.45); }
      50% { box-shadow: 0 0 16px -3px rgba(79, 234, 169, 0.75); }
    }
    .chip.status-idle .dot,
    .chip.status-default .dot {
      background: var(--g-primary, #d4a017);
      box-shadow: 0 0 6px color-mix(in srgb, var(--g-primary, #d4a017) 70%, transparent);
      animation: comm-pulse 4.5s ease-in-out infinite;
    }
    .chip.status-disabled {
      color: #e08a8a;
      border-color: rgba(224, 138, 138, 0.3);
    }
    .chip.status-disabled .dot {
      background: #e08a8a;
    }
    @keyframes comm-pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.35;
      }
    }
    .actions {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 6px;
      padding: 10px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .actions button {
      padding: 7px 4px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: rgba(235, 228, 210, 0.75);
      font-family: inherit;
      font-size: 8.5px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .actions button:hover {
      color: var(--g-primary, #d4a017);
      border-color: color-mix(in srgb, var(--g-primary, #d4a017) 45%, transparent);
      background: color-mix(in srgb, var(--g-primary, #d4a017) 8%, transparent);
      transform: translateY(-1px);
    }
    .thread {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 9px;
      scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--g-primary, #d4a017) 30%, transparent) transparent;
    }
    .empty {
      margin: auto;
      text-align: center;
      color: rgba(235, 228, 210, 0.34);
      font-size: 9.5px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      line-height: 2;
    }
    .empty .g {
      font-size: 20px;
      color: color-mix(in srgb, var(--g-primary, #d4a017) 60%, transparent);
    }
    .msg {
      max-width: 88%;
      padding: 9px 12px;
      border-radius: 12px;
      font-size: 11.5px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .msg.user {
      align-self: flex-end;
      background: linear-gradient(
        135deg,
        color-mix(in srgb, var(--g-primary, #d4a017) 26%, transparent),
        color-mix(in srgb, var(--g-primary, #d4a017) 12%, transparent)
      );
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4a017) 35%, transparent);
      color: #f4eeda;
      border-bottom-right-radius: 4px;
    }
    .msg.assistant {
      align-self: flex-start;
      background: rgba(255, 255, 255, 0.035);
      border: 1px solid rgba(255, 255, 255, 0.07);
      color: rgba(240, 236, 224, 0.92);
      border-bottom-left-radius: 4px;
    }
    /* Stylized markdown inside assistant bubbles (mirrors cmo-chat's md-body). */
    .msg.md-body { white-space: normal; }
    .msg.md-body p { margin: 0 0 8px; }
    .msg.md-body p:last-child { margin-bottom: 0; }
    .msg.md-body strong { color: var(--g-primary, #fbbf24); font-weight: 700; }
    .msg.md-body em { font-style: italic; opacity: 0.85; }
    .msg.md-body a { color: var(--g-primary, #fbbf24); text-decoration: underline; }
    .msg.md-body ul, .msg.md-body ol { margin: 4px 0 8px; padding-left: 18px; }
    .msg.md-body li { margin: 2px 0; }
    .msg.md-body h1, .msg.md-body h2, .msg.md-body h3, .msg.md-body h4 {
      margin: 10px 0 6px;
      font-size: 12.5px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--g-primary, #fbbf24);
    }
    .msg.md-body code {
      font-family: inherit;
      font-size: 10.5px;
      padding: 1px 5px;
      border-radius: 5px;
      background: rgba(0, 0, 0, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #e8cf9a;
    }
    .msg.md-body pre {
      margin: 6px 0 8px;
      padding: 9px 11px;
      border-radius: 9px;
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4a017) 22%, transparent);
      overflow-x: auto;
    }
    .msg.md-body pre code { background: none; border: none; padding: 0; }
    .msg.md-body blockquote {
      margin: 6px 0 8px;
      padding: 4px 10px;
      border-left: 2px solid var(--g-primary, #d4a017);
      opacity: 0.85;
    }
    .msg.md-body table { border-collapse: collapse; margin: 6px 0 8px; font-size: 10.5px; }
    .msg.md-body th, .msg.md-body td {
      border: 1px solid rgba(255, 255, 255, 0.12);
      padding: 3px 8px;
    }
    .msg.md-body th { color: var(--g-primary, #fbbf24); }
    .msg.error {
      align-self: stretch;
      background: rgba(180, 60, 60, 0.12);
      border: 1px solid rgba(224, 110, 110, 0.35);
      color: #eba5a5;
      font-size: 10px;
    }
    .tool-line {
      align-self: flex-start;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 8.5px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: rgba(235, 228, 210, 0.4);
    }
    .tool-line::before {
      content: "▸";
      color: color-mix(in srgb, var(--g-primary, #d4a017) 70%, transparent);
    }
    .typing {
      align-self: flex-start;
      color: color-mix(in srgb, var(--g-primary, #d4a017) 80%, #fff);
      font-size: 9px;
      letter-spacing: 0.22em;
      text-transform: uppercase;
      animation: comm-pulse 1.4s ease-in-out infinite;
    }
    .composer {
      display: flex;
      gap: 8px;
      padding: 12px 14px 14px;
      border-top: 1px solid color-mix(in srgb, var(--g-primary, #d4a017) 14%, transparent);
      background: linear-gradient(
        0deg,
        color-mix(in srgb, var(--g-primary, #d4a017) 4%, transparent),
        transparent
      );
    }
    textarea {
      flex: 1;
      min-height: 40px;
      max-height: 110px;
      resize: none;
      padding: 10px 12px;
      border-radius: 11px;
      background: rgba(4, 4, 2, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.09);
      color: #f2eddc;
      font-family: inherit;
      font-size: 11.5px;
      line-height: 1.5;
      outline: none;
      transition: border-color 0.16s ease, box-shadow 0.16s ease;
    }
    textarea:focus {
      border-color: color-mix(in srgb, var(--g-primary, #d4a017) 55%, transparent);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--g-primary, #d4a017) 25%, transparent);
    }
    textarea::placeholder {
      color: rgba(235, 228, 210, 0.28);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      font-size: 9.5px;
    }
    .send {
      align-self: flex-end;
      height: 40px;
      padding: 0 15px;
      border-radius: 11px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #d4a017) 70%, transparent);
      background: linear-gradient(
        135deg,
        color-mix(in srgb, var(--g-primary, #d4a017) 88%, #fff),
        var(--g-primary, #d4a017)
      );
      color: #0a0805;
      font-family: inherit;
      font-size: 9.5px;
      font-weight: 800;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      cursor: pointer;
      transition: all 0.16s ease;
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
    }
    .send:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow:
        0 10px 24px rgba(0, 0, 0, 0.5),
        0 0 26px color-mix(in srgb, var(--g-primary, #d4a017) 35%, transparent);
    }
    .send:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
  `;

  render() {
    if (!this.agentId) return nothing;
    const statusClass = `status-${this.agentStatus}`;
    return html`
      <div class="panel" role="dialog" aria-label="${this.agentName} communications">
        <div class="fp-drag-bar">
          <span class="fp-grip" aria-hidden="true">⠿</span>
          <span class="fp-drag-label">◈ ${this.agentName || "Agent"} Comms</span>
        </div>
        <div class="fp-resize-grip" aria-hidden="true"></div>
        <div class="head">
          <div class="avatar">
            ${this.avatarUrl
              ? html`<img
                  src=${this.avatarUrl}
                  alt=""
                  @error=${(e: Event) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />`
              : (this.agentName || "?").charAt(0).toUpperCase()}
          </div>
          <div class="who">
            <div class="name">${this.agentName}</div>
            <div class="role">${this.agentRole || "Agent"}</div>
          </div>
          <button class="close" title="Close" aria-label="Close panel" @click=${() => this.emit("panel-close")}>
            ✕
          </button>
        </div>

        <div class="meta">
          <span class="chip ${statusClass}"><span class="dot"></span>${this.agentStatus}</span>
          ${this.model ? html`<span class="chip">${this.model}</span>` : nothing}
          <span class="chip">${this.sessionCount} session${this.sessionCount === 1 ? "" : "s"}</span>
          ${this.lastSessionLabel
            ? html`<span class="chip" title=${this.lastSessionLabel}>
                LAST · ${this.lastSessionLabel}${this.lastSessionAgo ? ` · ${this.lastSessionAgo}` : ""}
              </span>`
            : nothing}
        </div>

        <div class="actions">
          <button @click=${() => this.focusComposer()}>Chat</button>
          <button @click=${() => this.emit("open-sessions")}>Sessions</button>
          <button @click=${() => this.emit("open-edit")}>Edit</button>
        </div>

        <div class="thread">
          ${this.items.length === 0 && this.streamText === null
            ? html`<div class="empty">
                <div class="g">✦</div>
                Direct line to ${this.agentName || "agent"}<br />
                Transmit below
              </div>`
            : nothing}
          ${this.items.map((it) =>
            it.role === "assistant"
              ? html`<div class="msg assistant md-body">${unsafeHTML(toSanitizedMarkdownHtml(it.text))}</div>`
              : it.role === "user"
                ? html`<div class="msg user">${it.text}</div>`
                : it.role === "tool"
                  ? html`<div class="tool-line">${it.name}</div>`
                  : html`<div class="msg error">${it.text}</div>`
          )}
          ${this.streamText
            ? html`<div class="msg assistant md-body">${unsafeHTML(toSanitizedMarkdownHtml(this.streamText))}</div>`
            : this.sending
              ? html`<div class="typing">▸ transmitting…</div>`
              : nothing}
          ${this.error ? html`<div class="msg error">${this.error}</div>` : nothing}
        </div>

        <div class="composer">
          <textarea
            placeholder="Message ${this.agentName || "agent"}…"
            .value=${this.draft}
            @input=${(e: Event) => (this.draft = (e.target as HTMLTextAreaElement).value)}
            @keydown=${this.onComposerKey}
            aria-label="Message ${this.agentName}"
          ></textarea>
          <button class="send" ?disabled=${this.sending || !this.draft.trim()} @click=${() => void this.send()}>
            ${this.sending ? "…" : "Send"}
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "agent-comm-panel": AgentCommPanel;
  }
}

/**
 * <chat-panel-host> — always-mounted root host for agent-invokable chat panel
 * MODALS (ported from the OmniTrade <omnitrade-panel-host>). Mounted once in
 * app-render.ts with `.client`. Owns the modal STACK so a panel can drill into
 * another (project → task, agents → agent).
 *
 * Opens a <chat-panel-modal> when:
 *   • gateway broadcast `chat.panel.show` with display:"modal" — the agent
 *     asked to pop the panel full-size (from any surface, incl. voice);
 *   • window event `chat-panel-open` — an inline card's Expand / a drill-down.
 * Every broadcast is also re-dispatched as window `chat-panel-shown` so
 * surfaces that don't render tool results (voice transcript) can add a card.
 */
import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway";
import "./chat-panel-modal";
import { extractPanelRef, type ChatPanelRef, type PanelResult } from "./panel-ref";
import { PANEL_OPEN_EVENT, PANEL_SHOWN_EVENT } from "./panel-nav";

interface OpenPanel {
  ref: ChatPanelRef;
  initial: PanelResult | null;
}

const MAX_STACK = 4;
/** Module-level so a host re-mounted by a layout change keeps its open modals. */
let openStack: OpenPanel[] = [];

@customElement("chat-panel-host")
export class ChatPanelHost extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @state() private stack: OpenPanel[] = openStack;
  private unsub: (() => void) | null = null;
  private subscribedTo: GatewayBrowserClient | null = null;

  // Light DOM: the modal is itself shadow-encapsulated.
  createRenderRoot(): HTMLElement {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(PANEL_OPEN_EVENT, this.onOpenEvent as EventListener);
    this.trySubscribe();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(PANEL_OPEN_EVENT, this.onOpenEvent as EventListener);
    this.unsub?.();
    this.unsub = null;
    this.subscribedTo = null;
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has("client")) this.trySubscribe();
  }

  private trySubscribe(): void {
    if (this.subscribedTo === this.client) return;
    this.unsub?.();
    this.unsub = null;
    this.subscribedTo = this.client;
    if (!this.client || typeof this.client.subscribe !== "function") return;
    this.unsub = this.client.subscribe((evt: GatewayEventFrame) => this.onGatewayEvent(evt));
  }

  private onGatewayEvent(evt: GatewayEventFrame): void {
    if (evt.event !== "chat.panel.show") return;
    const payload = evt.payload as Record<string, unknown> | undefined;
    const ref = extractPanelRef(payload);
    if (!ref) return;
    window.dispatchEvent(
      new CustomEvent(PANEL_SHOWN_EVENT, {
        detail: { ref, sourceSession: typeof payload?.sourceSession === "string" ? payload.sourceSession : undefined },
      }),
    );
    if (ref.display !== "modal") return;
    const initial: PanelResult | null =
      payload && "initial" in payload
        ? {
            kind: ref.kind,
            title: ref.title,
            data: payload.initial,
            summary: ref.summary,
            count: ref.count,
            empty: ref.empty,
            error: ref.error,
            text: "",
            link: ref.link,
            refreshMs: ref.refreshMs,
            fetchedAt: ref.ts || Date.now(),
          }
        : null;
    this.push({ ref, initial });
  }

  private onOpenEvent = (e: Event): void => {
    const d = (e as CustomEvent).detail as { ref?: ChatPanelRef; initial?: PanelResult | null } | undefined;
    if (!d?.ref?.kind) return;
    this.push({ ref: d.ref, initial: d.initial ?? null });
  };

  private push(p: OpenPanel): void {
    if (this.stack.some((x) => x.ref.panelId === p.ref.panelId)) return;
    this.stack = openStack = [...this.stack, p].slice(-MAX_STACK);
  }

  private close(panelId: string): void {
    this.stack = openStack = this.stack.filter((p) => p.ref.panelId !== panelId);
  }

  render() {
    if (!this.stack.length) return nothing;
    return html`${this.stack.map(
      (p) => html`<chat-panel-modal
        .ref=${p.ref}
        .initial=${p.initial}
        @panel-close=${(e: CustomEvent) => this.close(e.detail?.panelId ?? p.ref.panelId)}
      ></chat-panel-modal>`,
    )}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chat-panel-host": ChatPanelHost;
  }
}

/**
 * <kg-ai-drawer> — direct chat with the knowledge graph's selection.
 *
 * "Chat with this", "Summarize", "Find related" and the AI half of
 * "Consolidate" all land here: the drawer opens a real agent session scoped
 * to the selection (`doc_agent.spawn`, docType "generic", the selection's
 * context as the document), sends the opening prompt with `chat.send`, and
 * streams the reply from the gateway's `chat` events. Nothing is simulated —
 * with no gateway the drawer shows the error instead of an answer.
 *
 * "Open in Chat" hands the same session over to the full chat page.
 */

import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { GatewayBrowserClient } from "../gateway";
import { extractText } from "../chat/message-extract";
import { icons } from "../icons";
import { toSanitizedMarkdownHtml } from "../markdown";
import { inferBasePathFromPathname, pathForTab } from "../navigation";
import { aiPrompt, type AiIntent } from "./knowledge-graph-ops";

export interface AiRequest {
  intent: AiIntent;
  /** Short human label for the selection ("3 items", a node title…). */
  title: string;
  context: string;
  count: number;
  nodeIds: string[];
}

interface Msg {
  role: "user" | "assistant";
  text: string;
  /** Display label for long generated prompts. */
  label?: string;
}

const INTENT_LABEL: Record<AiIntent, string> = {
  chat: "Chat",
  summarize: "Summarize",
  related: "Find related",
  consolidate: "Consolidation plan",
  cluster: "Auto-group",
};

function hashIds(ids: string[]): string {
  let h = 0x811c9dc5;
  for (const id of [...ids].sort()) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return (h >>> 0).toString(36);
}

function newKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `kg-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

@customElement("kg-ai-drawer")
export class KgAiDrawer extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;

  @state() private req: AiRequest | null = null;
  @state() private sessionKey: string | null = null;
  @state() private messages: Msg[] = [];
  @state() private streaming: string | null = null;
  @state() private busy = false;
  @state() private error: string | null = null;
  @state() private draft = "";
  private systemPrompt = "";
  private unsubscribe: (() => void) | null = null;

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  get isOpen(): boolean {
    return this.req != null;
  }

  /** Open (or re-target) the drawer and run `req.intent` against the selection. */
  async start(req: AiRequest): Promise<void> {
    const sameSelection = this.req && hashIds(this.req.nodeIds) === hashIds(req.nodeIds) && this.sessionKey;
    this.req = req;
    this.error = null;
    if (!sameSelection) {
      this.sessionKey = null;
      this.messages = [];
      this.streaming = null;
    }
    if (!this.client) {
      this.error = "Not connected to the gateway.";
      return;
    }
    this.subscribe();
    try {
      if (!this.sessionKey) {
        const res = (await this.client.request("doc_agent.spawn", {
          docType: "generic",
          documentId: `knowledge-graph-${hashIds(req.nodeIds)}`,
          title: `Knowledge graph · ${req.title}`,
          content: req.context,
          extra: "Scope: items selected in the InfiniBot knowledge graph. Use your tools to read or update them when asked.",
        })) as { sessionKey?: string; systemPrompt?: string };
        if (!res?.sessionKey) throw new Error("The gateway didn't return a session.");
        this.sessionKey = res.sessionKey;
        this.systemPrompt = res.systemPrompt ?? "";
      }
      if (req.intent !== "chat" || this.messages.length === 0) {
        await this.send(aiPrompt(req.intent, req.context, req.count), `${INTENT_LABEL[req.intent]} · ${req.title}`);
      }
    } catch (err) {
      this.busy = false;
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  close(): void {
    this.req = null;
    this.dispatchEvent(new CustomEvent("kg-ai-close", { bubbles: true }));
  }

  private subscribe(): void {
    if (this.unsubscribe || !this.client || typeof this.client.subscribe !== "function") return;
    this.unsubscribe = this.client.subscribe((evt: { event: string; payload?: unknown }) => {
      if (evt.event !== "chat") return;
      const p = evt.payload as Record<string, unknown> | undefined;
      if (!p || p.sessionKey !== this.sessionKey) return;
      const st = p.state as string | undefined;
      if (st === "delta") {
        const t = extractText(p.message) ?? "";
        if (t && (!this.streaming || t.length >= this.streaming.length)) this.streaming = t;
        this.scrollDown();
      } else if (st === "final") {
        const t = extractText(p.message) ?? this.streaming ?? "";
        this.streaming = null;
        this.busy = false;
        if (t) this.messages = [...this.messages, { role: "assistant", text: t }];
        else void this.reloadHistory();
        this.scrollDown();
      } else if (st === "aborted") {
        this.streaming = null;
        this.busy = false;
      } else if (st === "error") {
        this.streaming = null;
        this.busy = false;
        this.error = String(p.errorMessage ?? "The agent hit an error.");
      }
    });
  }

  private async reloadHistory(): Promise<void> {
    if (!this.client || !this.sessionKey) return;
    try {
      const hist = (await this.client.request("chat.history", { sessionKey: this.sessionKey, limit: 50 })) as {
        messages?: Array<Record<string, unknown>>;
      };
      const last = [...(hist?.messages ?? [])].reverse().find((m) => m.role === "assistant");
      const t = last ? (extractText(last) ?? "") : "";
      if (t) this.messages = [...this.messages, { role: "assistant", text: t }];
    } catch {
      /* history unavailable — the user can still open the session in Chat */
    }
  }

  private async send(text: string, label?: string): Promise<void> {
    if (!this.client || !this.sessionKey || !text.trim()) return;
    const first = !this.messages.some((m) => m.role === "user");
    const message =
      first && this.systemPrompt
        ? `[INSTRUCTIONS — read once, then respond to my message]\n\n${this.systemPrompt}\n\n---\n\nMy message: ${text}`
        : text;
    this.messages = [...this.messages, { role: "user", text, label }];
    this.busy = true;
    this.error = null;
    this.streaming = null;
    this.scrollDown();
    try {
      await this.client.request("chat.send", { sessionKey: this.sessionKey, message, idempotencyKey: newKey() });
    } catch (err) {
      this.busy = false;
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  private async abort(): Promise<void> {
    if (!this.client || !this.sessionKey) return;
    try {
      await this.client.request("chat.abort", { sessionKey: this.sessionKey });
    } catch {
      /* best effort */
    }
    this.busy = false;
    this.streaming = null;
  }

  private openInChat(): void {
    if (!this.sessionKey) return;
    const base = inferBasePathFromPathname(window.location.pathname);
    window.history.pushState({}, "", `${pathForTab("chat", base)}?session=${encodeURIComponent(this.sessionKey)}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }

  private scrollDown(): void {
    queueMicrotask(() => {
      const el = this.querySelector(".kgai-msgs");
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  private quick(intent: AiIntent): void {
    if (!this.req) return;
    void this.send(aiPrompt(intent, this.req.context, this.req.count), `${INTENT_LABEL[intent]} · ${this.req.title}`);
  }

  override render() {
    if (!this.req) return nothing;
    const r = this.req;
    return html`
      <aside class="kgai" role="dialog" aria-label="Chat with the selection">
        <header class="kgai-head">
          <span class="kgai-badge">${icons.sparkles}</span>
          <div class="kgai-title">
            <b>Graph assistant</b>
            <span>${r.title}</span>
          </div>
          <button class="kgai-icon" title="Open this conversation in Chat" ?disabled=${!this.sessionKey} @click=${() => this.openInChat()}>
            ${icons.externalLink}
          </button>
          <button class="kgai-icon" title="Close" @click=${() => this.close()}>${icons.x}</button>
        </header>
        <div class="kgai-chips">
          <button class="kgai-chip" ?disabled=${this.busy || !this.sessionKey} @click=${() => this.quick("summarize")}>${icons.fileText} Summarize</button>
          <button class="kgai-chip" ?disabled=${this.busy || !this.sessionKey} @click=${() => this.quick("related")}>${icons.network} Find related</button>
          <button class="kgai-chip" ?disabled=${this.busy || !this.sessionKey || r.count < 2} @click=${() => this.quick("consolidate")}>${icons.layers} Merge plan</button>
        </div>
        <div class="kgai-msgs" aria-live="polite">
          ${!this.sessionKey && !this.error ? html`<div class="kgai-muted">Opening a session…</div>` : nothing}
          ${this.messages.map(
            (m) => html`
              <div class="kgai-msg kgai-msg--${m.role}">
                ${m.role === "user"
                  ? html`<span>${m.label ?? m.text}</span>`
                  : html`<div class="kgai-md">${unsafeHTML(toSanitizedMarkdownHtml(m.text))}</div>`}
              </div>
            `,
          )}
          ${this.streaming
            ? html`<div class="kgai-msg kgai-msg--assistant"><div class="kgai-md">${unsafeHTML(toSanitizedMarkdownHtml(this.streaming))}</div></div>`
            : this.busy
              ? html`<div class="kgai-msg kgai-msg--assistant kgai-typing"><i></i><i></i><i></i></div>`
              : nothing}
          ${this.error ? html`<div class="kgai-err">${icons.alertCircle} ${this.error}</div>` : nothing}
        </div>
        <form
          class="kgai-compose"
          @submit=${(e: Event) => {
            e.preventDefault();
            const t = this.draft;
            this.draft = "";
            void this.send(t);
          }}
        >
          <textarea
            rows="2"
            placeholder="Ask about these items…"
            .value=${this.draft}
            ?disabled=${!this.sessionKey}
            @input=${(e: Event) => (this.draft = (e.target as HTMLTextAreaElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              e.stopPropagation();
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const t = this.draft;
                this.draft = "";
                void this.send(t);
              }
            }}
          ></textarea>
          ${this.busy
            ? html`<button type="button" class="kgai-send" title="Stop" @click=${() => void this.abort()}>${icons.stop}</button>`
            : html`<button type="submit" class="kgai-send" title="Send" ?disabled=${!this.draft.trim() || !this.sessionKey}>${icons.send}</button>`}
        </form>
      </aside>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "kg-ai-drawer": KgAiDrawer;
  }
}

/**
 * <content-studio-shell> — the Content Studio page.
 *
 *   Pipeline  drag-and-drop production board (primary view); a card opens
 *             its markdown page (<cs-page-view>)
 *   Ideas     free-form markdown idea pages
 *   Channels  the existing content-pages hub (per-channel pages, insights,
 *             Instagram/ManyChat) — unchanged
 *
 * Light DOM, so the shared rich-doc-editor's document-level styles apply.
 * The board refreshes on focus and every 15 s while visible, which keeps it
 * in step with agents moving cards through the content_pipeline tool.
 */

import { LitElement, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";

import "../content-pages.js";
import { StudioApi, type Board, type GatewayCallable } from "./api.js";
import "./board.js";
import "./ideas.js";
import "./page-view.js";
import { ensureStudioStyles } from "./styles.js";

type Mode = "pipeline" | "ideas" | "channels";
const MODE_KEY = "infinibot.contentStudio.mode";
const POLL_MS = 15_000;

@customElement("content-studio-shell")
export class ContentStudioShell extends LitElement {
  @property({ attribute: false }) client: GatewayCallable | null = null;

  @state() private mode: Mode = readMode();
  @state() private board: Board | null = null;
  @state() private openItemId: string | null = null;
  @state() private flypic = false;
  @state() private loadError: string | null = null;
  @state() private ideasKey = 0;

  private api: StudioApi | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private loading = false;

  protected createRenderRoot() {
    ensureStudioStyles();
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("focus", this.onFocus);
    document.addEventListener("visibilitychange", this.onFocus);
    this.timer = setInterval(() => {
      if (document.visibilityState === "visible" && this.mode === "pipeline" && !this.openItemId) {
        void this.loadBoard();
      }
    }, POLL_MS);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("focus", this.onFocus);
    document.removeEventListener("visibilitychange", this.onFocus);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Lazy-chunk upgrade restores `.client` only at the first update, so the
  // initial load keys off the property change, not connectedCallback.
  protected willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("client") && this.client) {
      this.api = new StudioApi(this.client);
      void this.loadBoard();
      this.api.capabilities().then(
        (c) => (this.flypic = c.flypic),
        () => (this.flypic = false),
      );
    }
  }

  private onFocus = () => {
    if (document.visibilityState === "visible") void this.loadBoard();
  };

  private async loadBoard(): Promise<void> {
    if (!this.api || this.loading) return;
    this.loading = true;
    try {
      this.board = await this.api.board();
      this.loadError = null;
    } catch (err) {
      this.loadError = String(err instanceof Error ? err.message : err);
    } finally {
      this.loading = false;
    }
  }

  private setMode(mode: Mode) {
    this.mode = mode;
    this.openItemId = null;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // storage unavailable
    }
    if (mode === "pipeline") void this.loadBoard();
    if (mode === "ideas") this.ideasKey++;
  }

  private async deleteOpenItem() {
    const id = this.openItemId;
    const item = this.board?.items.find((i) => i.id === id);
    if (!this.api || !id || !window.confirm(`Delete “${item?.title ?? "this item"}” and its page?`)) return;
    await this.api.deleteItem(id);
    this.openItemId = null;
    await this.loadBoard();
  }

  render() {
    const tabs: Array<[Mode, string, string]> = [
      ["pipeline", "Pipeline", `${this.board?.items.length ?? ""}`],
      ["ideas", "Ideas", ""],
      ["channels", "Channels", ""],
    ];
    return html`
      <div class="cs-shell">
        <header class="cs-shell-head">
          <div class="cs-brand">
            <span class="cs-brand-mark" aria-hidden="true">CS</span>
            <div>
              <h1>Content Studio</h1>
              <p>Plan, write and ship content — idea to published.</p>
            </div>
          </div>
          <nav class="cs-tabs" role="tablist" aria-label="Content Studio sections">
            ${tabs.map(
              ([m, label, badge]) => html`<button
                role="tab"
                aria-selected=${this.mode === m ? "true" : "false"}
                class="cs-tab ${this.mode === m ? "is-on" : ""}"
                @click=${() => this.setMode(m)}
              >
                ${label}${badge ? html`<span class="cs-tab-badge">${badge}</span>` : nothing}
              </button>`,
            )}
          </nav>
        </header>
        ${this.loadError && this.mode !== "channels"
          ? html`<div class="cs-error" role="alert">
              Couldn't load the pipeline: ${this.loadError}
              <button class="cs-link" @click=${() => void this.loadBoard()}>Retry</button>
            </div>`
          : nothing}
        <main class="cs-shell-body">${this.renderBody()}</main>
      </div>
    `;
  }

  private renderBody() {
    if (this.mode === "channels") {
      return html`<content-pages-hub .client=${this.client}></content-pages-hub>`;
    }
    if (this.mode === "ideas") {
      return html`<cs-ideas-area
        .api=${this.api}
        .stages=${this.board?.stages ?? []}
        ?flypic=${this.flypic}
        .refreshKey=${this.ideasKey}
        @cs-changed=${() => void this.loadBoard()}
        @cs-open-item=${(e: CustomEvent<{ itemId: string }>) => {
          this.mode = "pipeline";
          this.openItemId = e.detail.itemId;
          void this.loadBoard();
        }}
      ></cs-ideas-area>`;
    }
    if (this.openItemId) {
      return html`
        <cs-page-view
          .api=${this.api}
          ownerKind="item"
          .ownerId=${this.openItemId}
          .stages=${this.board?.stages ?? []}
          ?flypic=${this.flypic}
          @cs-close=${() => {
            this.openItemId = null;
            void this.loadBoard();
          }}
          @cs-changed=${() => void this.loadBoard()}
        ></cs-page-view>
        <div class="cs-page-danger">
          <button class="cs-btn cs-btn-ghost cs-danger" @click=${() => void this.deleteOpenItem()}>
            Delete item
          </button>
        </div>
      `;
    }
    return html`<cs-pipeline-board
      .api=${this.api}
      .board=${this.board}
      @cs-changed=${() => void this.loadBoard()}
      @cs-open-item=${(e: CustomEvent<{ itemId: string }>) => (this.openItemId = e.detail.itemId)}
    ></cs-pipeline-board>`;
  }
}

function readMode(): Mode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "pipeline" || v === "ideas" || v === "channels") return v;
  } catch {
    // storage unavailable
  }
  return "pipeline";
}

declare global {
  interface HTMLElementTagNameMap {
    "content-studio-shell": ContentStudioShell;
  }
}

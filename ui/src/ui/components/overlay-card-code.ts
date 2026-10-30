/**
 * overlay-card-code.ts — code snippet overlay.
 *
 * payload: { code?: string, language?: string, filename?: string }
 *
 * Monospace block + copy + "send to claude" actions. (Shiki is not a project
 * dependency; we render an escaped, tinted <pre> rather than pull a highlighter
 * into the bundle. Swap in shiki here if it's added later.)
 */

import { html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { OverlayCardBase } from "./overlay-card-base";
import { escapeHtml } from "../markdown";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

@customElement("overlay-card-code")
export class OverlayCardCode extends OverlayCardBase {
  @state() private copied = false;

  static styles = [
    OverlayCardBase.baseStyles,
    css`
      .ovc-body {
        padding: 0;
        display: flex;
        flex-direction: column;
      }
      .toolbar {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--g-border, rgba(251, 191, 36, 0.14));
        flex: 0 0 auto;
      }
      .lang {
        font-size: 10px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--g-primary, #fbbf24);
        flex: 1 1 auto;
      }
      .toolbar button {
        font-size: 10px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 4px 9px;
        border-radius: 6px;
        border: 1px solid var(--g-border, rgba(251, 191, 36, 0.14));
        background: transparent;
        color: var(--g-fg-dim, rgba(245, 245, 244, 0.7));
        cursor: pointer;
      }
      .toolbar button:hover {
        border-color: var(--g-border-strong, rgba(251, 191, 36, 0.3));
        color: var(--g-primary, #fbbf24);
      }
      pre {
        margin: 0;
        flex: 1 1 auto;
        overflow: auto;
        padding: 12px;
        font-family: var(--g-mono, ui-monospace, "JetBrains Mono", monospace);
        font-size: 12.5px;
        line-height: 1.55;
        color: #e4e4e7;
        tab-size: 2;
        background: rgba(0, 0, 0, 0.22);
      }
      pre::-webkit-scrollbar {
        width: 8px;
        height: 8px;
      }
      pre::-webkit-scrollbar-thumb {
        background: var(--g-primary-muted, rgba(251, 191, 36, 0.18));
        border-radius: 8px;
      }
    `,
  ];

  protected get cardIcon() {
    return "{ }";
  }
  protected get cardTitle() {
    return (this.payload.filename as string) || "Snippet";
  }

  private get code(): string {
    return String(this.payload.code ?? "");
  }

  private async copy() {
    try {
      await navigator.clipboard.writeText(this.code);
      this.copied = true;
      window.setTimeout(() => (this.copied = false), 1400);
    } catch {
      /* clipboard blocked */
    }
  }

  private sendToClaude() {
    this.dispatchEvent(
      new CustomEvent("overlay-send-to-claude", {
        detail: { code: this.code, language: this.payload.language },
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected renderBody() {
    const lang = (this.payload.language as string) || "text";
    return html`
      <div class="toolbar">
        <span class="lang">${lang}</span>
        <button @click=${() => this.copy()}>${this.copied ? "Copied ✓" : "Copy"}</button>
        <button @click=${() => this.sendToClaude()}>Send to Claude</button>
      </div>
      ${this.code
        ? html`<pre><code>${unsafeHTML(escapeHtml(this.code))}</code></pre>`
        : html`<pre><code></code></pre>`}
    `;
  }
}

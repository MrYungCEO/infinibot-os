/**
 * overlay-card-markdown.ts — freeform markdown overlay.
 *
 * payload: { content?: string; markdown?: string; title?: string; editable?: boolean }
 *
 * Renders through the same sanitised markdown pipeline notes use. When
 * `editable` is set it swaps in <moltbot-markdown-editor>; otherwise read-only.
 */

import { html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { OverlayCardBase } from "./overlay-card-base";
import { toSanitizedMarkdownHtml } from "../markdown";
import "./markdown-editor";

@customElement("overlay-card-markdown")
export class OverlayCardMarkdown extends OverlayCardBase {
  @state() private content = "";

  static styles = [
    OverlayCardBase.baseStyles,
    css`
      .md {
        color: var(--g-fg, #f5f5f4);
        font-size: 13px;
        line-height: 1.6;
      }
      .md :first-child {
        margin-top: 0;
      }
      .md h1,
      .md h2,
      .md h3 {
        color: var(--g-primary, #fbbf24);
        letter-spacing: 0.01em;
      }
      .md a {
        color: var(--g-primary, #fbbf24);
      }
      .md code {
        font-family: var(--g-mono, ui-monospace, monospace);
        background: var(--g-surface-strong, rgba(255, 255, 255, 0.06));
        padding: 1px 5px;
        border-radius: 5px;
        font-size: 12px;
      }
      .md pre {
        background: var(--g-surface, rgba(255, 255, 255, 0.04));
        border: 1px solid var(--g-border, rgba(251, 191, 36, 0.14));
        border-radius: 8px;
        padding: 10px;
        overflow: auto;
      }
      .md blockquote {
        border-left: 2px solid var(--g-primary-muted, rgba(251, 191, 36, 0.18));
        margin: 8px 0;
        padding-left: 10px;
        color: var(--g-fg-dim, rgba(245, 245, 244, 0.7));
      }
      .ovc-body:has(moltbot-markdown-editor) {
        padding: 0;
      }
    `,
  ];

  protected get cardIcon() {
    return "▤";
  }
  protected get cardTitle() {
    return (this.payload.title as string) || "Markdown";
  }

  firstUpdated() {
    super.firstUpdated();
    const p = this.payload;
    this.content = String(p.content ?? p.markdown ?? "");
  }

  private onChange(e: CustomEvent<{ value: string }>) {
    this.content = e.detail?.value ?? "";
  }

  protected renderBody() {
    if (this.payload.editable) {
      return html`
        <moltbot-markdown-editor
          .value=${this.content}
          @change=${(e: CustomEvent<{ value: string }>) => this.onChange(e)}
        ></moltbot-markdown-editor>
      `;
    }
    const safe = toSanitizedMarkdownHtml(this.content || "_No content._");
    return html`<div class="md">${unsafeHTML(safe)}</div>`;
  }
}

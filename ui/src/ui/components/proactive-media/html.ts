/** html media card: a sanitized HTML fragment rendered in the card surface. */
import { html } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../../markdown/render.js";
import type { HtmlMedia } from "../proactive-popup-shared.js";
import { stagger, nothing } from "./shared.js";

export function renderHtml(p: HtmlMedia) {
  // Sanitized through the same markdown sanitizer that strips scripts/handlers,
  // so a caller-supplied fragment can't inject script into the host page.
  const safe = p.html ? toSanitizedMarkdownHtml(p.html) : "";
  return html`
    <div class="pmedia pmedia-htmlcard">
      ${p.title
        ? html`<div class="pmedia-name pmedia-stagger" style=${stagger(0)}>${p.title}</div>`
        : nothing}
      <div class="pmedia-htmlframe pmedia-md pmedia-stagger" style=${stagger(1)}>
        ${unsafeHTML(safe)}
      </div>
    </div>
  `;
}

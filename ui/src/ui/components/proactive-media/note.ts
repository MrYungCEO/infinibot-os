/** note media card: title + markdown body preview. */
import { html } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../../markdown/render.js";
import type { NoteMedia } from "../proactive-popup-shared.js";
import { type MediaRenderCtx, stagger } from "./shared.js";

export function renderNote(p: NoteMedia, _ctx: MediaRenderCtx) {
  const bodyHtml = p.bodyMarkdown ? toSanitizedMarkdownHtml(p.bodyMarkdown) : "";
  return html`
    <div class="pmedia pmedia-note">
      <div class="pmedia-row pmedia-stagger" style=${stagger(0)}>
        <span class="pmedia-badge pmedia-badge-note">✎ note</span>
        <span class="pmedia-name">${p.title}</span>
      </div>
      <div class="pmedia-md pmedia-note-body pmedia-stagger" style=${stagger(1)}>
        ${unsafeHTML(bodyHtml)}
      </div>
    </div>
  `;
}

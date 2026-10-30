/** custom media card: arbitrary markdown/html body + optional image/video. */
import { html } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { toSanitizedMarkdownHtml } from "../../markdown/render.js";
import type { CustomMedia } from "../proactive-popup-shared.js";
import { type MediaRenderCtx, stagger, nothing } from "./shared.js";

export function renderCustom(p: CustomMedia, ctx: MediaRenderCtx) {
  const md = p.bodyMarkdown ? toSanitizedMarkdownHtml(p.bodyMarkdown) : "";
  // Raw html is sanitized through the same markdown sanitizer (it strips
  // scripts/handlers) so a caller-supplied fragment can't inject script.
  const raw = p.html ? toSanitizedMarkdownHtml(p.html) : "";
  return html`
    <div class="pmedia pmedia-custom">
      ${md
        ? html`<div class="pmedia-md pmedia-stagger" style=${stagger(0)}>${unsafeHTML(md)}</div>`
        : nothing}
      ${raw
        ? html`<div class="pmedia-md pmedia-stagger" style=${stagger(1)}>${unsafeHTML(raw)}</div>`
        : nothing}
      ${p.imageUrl
        ? html`<button
            class="pmedia-thumb pmedia-thumb-wide pmedia-stagger"
            style=${stagger(2)}
            @click=${() => ctx.onThumb(p.imageUrl!, "image")}
          >
            <img class="pmedia-thumb-media" alt="custom media" data-lazy-src=${p.imageUrl} />
          </button>`
        : nothing}
      ${p.videoUrl
        ? html`<button
            class="pmedia-thumb pmedia-thumb-wide pmedia-stagger"
            style=${stagger(3)}
            @click=${() => ctx.onThumb(p.videoUrl!, "video")}
          >
            <video
              class="pmedia-thumb-media"
              muted
              playsinline
              preload="none"
              data-lazy-src=${p.videoUrl}
            ></video>
            <span class="pmedia-play">▶</span>
          </button>`
        : nothing}
    </div>
  `;
}

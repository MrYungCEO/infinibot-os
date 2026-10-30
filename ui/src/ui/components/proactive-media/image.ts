/** image media card: a framed, click-to-expand generated image. */
import { html } from "lit";
import type { ImageMedia } from "../proactive-popup-shared.js";
import { type MediaRenderCtx, stagger, nothing } from "./shared.js";

export function renderImage(p: ImageMedia, ctx: MediaRenderCtx) {
  const ratio = p.width && p.height ? `${p.width} / ${p.height}` : undefined;
  return html`
    <div class="pmedia pmedia-imgcard">
      <button
        class="pmedia-thumb pmedia-thumb-wide pmedia-stagger"
        style=${stagger(0)}
        title=${p.alt ?? "image"}
        @click=${() => ctx.onThumb(p.url, "image")}
      >
        <img
          class="pmedia-thumb-media"
          style=${ratio ? `aspect-ratio:${ratio};height:auto` : ""}
          alt=${p.alt ?? "generated image"}
          data-lazy-src=${p.url}
        />
      </button>
      ${p.caption
        ? html`<div class="pmedia-caption pmedia-stagger" style=${stagger(1)}>${p.caption}</div>`
        : nothing}
    </div>
  `;
}

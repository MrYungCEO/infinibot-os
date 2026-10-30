/** video media card: a framed, click-to-expand generated video. */
import { html } from "lit";
import type { VideoMedia } from "../proactive-popup-shared.js";
import { type MediaRenderCtx, stagger, nothing } from "./shared.js";

function fmtDur(ms?: number): string {
  if (!ms || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function renderVideo(p: VideoMedia, ctx: MediaRenderCtx) {
  const dur = fmtDur(p.durationMs);
  return html`
    <div class="pmedia pmedia-videocard">
      <button
        class="pmedia-thumb pmedia-thumb-wide pmedia-stagger"
        style=${stagger(0)}
        title=${p.caption ?? "video"}
        @click=${() => ctx.onThumb(p.url, "video")}
      >
        <video
          class="pmedia-thumb-media"
          muted
          playsinline
          preload="metadata"
          poster=${p.poster ?? ""}
          data-lazy-src=${p.url}
        ></video>
        <span class="pmedia-play">▶</span>
        ${dur ? html`<span class="pmedia-dur">${dur}</span>` : nothing}
      </button>
      ${p.caption
        ? html`<div class="pmedia-caption pmedia-stagger" style=${stagger(1)}>${p.caption}</div>`
        : nothing}
    </div>
  `;
}

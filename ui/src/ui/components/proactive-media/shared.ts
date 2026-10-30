/**
 * Shared helpers + context for the per-kind proactive media renderers.
 *
 * Each kind module (agent-summary, note, workflow, activity, custom) exports a
 * pure `render<Kind>(payload, ctx)` returning a Lit TemplateResult. The
 * <proactive-media> dispatcher owns the host element, styles, Intersection
 * Observer lazy-loading, and the staggered entrance animation; the kind modules
 * only describe content.
 */

import { html, type TemplateResult } from "lit";
import type { PopupMediaThumb } from "../proactive-popup-shared.js";

export interface MediaRenderCtx {
  /** Compact = toast surface; non-compact = modal surface (more room). */
  compact: boolean;
  /** Open a thumbnail in the shared lightbox. */
  onThumb: (url: string, type: "image" | "video") => void;
  /**
   * Register a thumbnail <img>/<video> for lazy-loading. The dispatcher wires
   * the actual IntersectionObserver; kind modules just call data-src + this.
   */
  lazySrc: (url: string) => string;
}

/** Stagger helper: child entrance delay (ms) by index. */
export function stagger(i: number): string {
  return `animation-delay:${Math.min(i, 8) * 70}ms`;
}

/** Render a row of lazy-loaded media thumbnails (images + videos). */
export function renderThumbs(
  thumbs: PopupMediaThumb[] | undefined,
  ctx: MediaRenderCtx,
  startIndex = 2,
): TemplateResult | typeof nothingResult {
  if (!thumbs || thumbs.length === 0) return nothingResult;
  return html`
    <div class="pmedia-thumbs pmedia-stagger" style=${stagger(startIndex)}>
      ${thumbs.slice(0, 6).map((t) =>
        t.type === "video"
          ? html`<button
              class="pmedia-thumb"
              title=${t.alt ?? "video"}
              @click=${() => ctx.onThumb(t.url, "video")}
            >
              <video
                class="pmedia-thumb-media"
                muted
                playsinline
                preload="none"
                poster=${t.poster ?? ""}
                data-lazy-src=${t.url}
              ></video>
              <span class="pmedia-play">▶</span>
            </button>`
          : html`<button
              class="pmedia-thumb"
              title=${t.alt ?? "image"}
              @click=${() => ctx.onThumb(t.url, "image")}
            >
              <img
                class="pmedia-thumb-media"
                alt=${t.alt ?? "generated media"}
                loading="lazy"
                data-lazy-src=${t.url}
              />
            </button>`,
      )}
    </div>
  `;
}

// Re-export lit's `nothing` under a stable local name so kind modules can use a
// single import surface.
import { nothing as nothingResult } from "lit";
export { nothingResult as nothing };

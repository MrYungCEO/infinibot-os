/**
 * Mandatory media visualization — server-side auto-emit helpers.
 *
 * THE RULE: whenever a media producer (image / video gen, PDF reports,
 * hyperframes, markdown notes, screenshots) finishes, the artifact MUST appear
 * on the user's screen as a premium black-gold overlay card. No silent media.
 *
 * Every producer chokepoint funnels through {@link emitMediaArtifact} so the
 * tier policy, dedup, and attribution stay identical regardless of caller. The
 * emit is best-effort and never throws into the producer's happy path.
 *
 * Tier policy: artifact cards default to FYI. FYI is panel-only, so during
 * quiet hours / focus mode the card pins to the side feed rather than blasting a
 * modal — but it still SHOWS. Callers that genuinely warrant an interrupt may
 * pass `tier: "NOTABLE"`.
 */

import { createHash } from "node:crypto";
import { emitProactiveServerSide } from "./emit.js";
import { resolveStateDir } from "../config/paths.js";
import type { PopupMedia, PopupTier } from "./popup-types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("proactive-media-artifact");

export interface EmitMediaArtifactInput {
  /** Producer identity for attribution (e.g. "reports", "media-plugin", "notes"). */
  agentId: string;
  agentName?: string;
  title: string;
  body?: string;
  media: PopupMedia;
  /**
   * Stable idempotency key — re-emits with the same key inside the tier cooldown
   * are absorbed (downgraded) by the router, so producers can fire freely.
   */
  dedupKey: string;
  /** Default FYI (panel-friendly). Pass NOTABLE only for interrupt-worthy media. */
  tier?: PopupTier;
  /** Optional spoken readout. */
  voice?: string;
}

/**
 * Fire a media-visualization overlay for a freshly-produced artifact. Returns
 * the built popup (or null if emit failed / was dropped). Never throws.
 */
export function emitMediaArtifact(input: EmitMediaArtifactInput): void {
  try {
    emitProactiveServerSide(
      {
        tier: input.tier ?? "FYI",
        title: input.title.slice(0, 140) || "New media",
        body: input.body ?? "",
        attribution: { agentId: input.agentId, agentName: input.agentName },
        dedupKey: input.dedupKey,
        voice: input.voice,
        media: input.media,
      },
      resolveStateDir(),
    );
  } catch (e) {
    log.warn("media artifact emit failed", {
      kind: input.media?.kind,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Short stable hash for building dedup keys from a path / url. */
export function artifactHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

/** Heuristic: does this string look like a renderable image url/path? */
export function looksLikeImage(s: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|svg|bmp)(\?|#|$)/i.test(s);
}

/** Heuristic: does this string look like a renderable video url/path? */
export function looksLikeVideo(s: string): boolean {
  return /\.(mp4|webm|mov|m4v|gif)(\?|#|$)/i.test(s);
}

/**
 * Pull the first image and video URL out of a markdown body. Used by the notes
 * producer to surface embedded media alongside the stylized-markdown timeline.
 */
export function extractMediaUrls(markdown: string): { images: string[]; videos: string[] } {
  const images: string[] = [];
  const videos: string[] = [];
  // ![alt](url) and bare <url> / (url) forms.
  const mdImg = /!\[[^\]]*\]\(([^)\s]+)/g;
  const urlRe =
    /(https?:\/\/[^\s)]+|\/media\/[^\s)]+|\/[^\s)]+\.(?:png|jpe?g|gif|webp|mp4|webm|mov))/gi;
  let m: RegExpExecArray | null;
  while ((m = mdImg.exec(markdown))) {
    if (looksLikeVideo(m[1])) videos.push(m[1]);
    else images.push(m[1]);
  }
  while ((m = urlRe.exec(markdown))) {
    const u = m[1];
    if (looksLikeVideo(u) && !videos.includes(u)) videos.push(u);
    else if (looksLikeImage(u) && !images.includes(u)) images.push(u);
  }
  return { images, videos };
}

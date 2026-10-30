/**
 * Guard for agent identity emoji ("Emoji:" in IDENTITY.md, `identity.emoji` in
 * config). Only a short glyph is a valid emoji — template placeholders like
 * "(your signature — pick one that feels right)" or any other prose must never
 * render as an agent's avatar. Shared by the gateway (parse time) and the
 * control UI (display time) so a bad value is rejected at both ends.
 */

const MAX_GRAPHEMES = 4;

function graphemeCount(value: string): number {
  const Seg = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (typeof Seg === "function") {
    let n = 0;
    for (const _ of new Seg(undefined, { granularity: "grapheme" }).segment(value)) n += 1;
    return n;
  }
  return Array.from(value.replace(/[\uFE0E\uFE0F\u200D]|\p{M}/gu, "")).length;
}

/** `:robot:`-style shortcode (Slack/Discord reaction names). */
const SHORTCODE_RE = /^:[a-z0-9_+-]{1,40}:$/i;

/**
 * Returns the trimmed emoji when it looks like a short glyph, else undefined.
 * `allowShortcode` keeps `:name:` codes for channel paths (ack reactions) that
 * accept them; display paths leave it off since a shortcode renders as text.
 */
export function sanitizeIdentityEmoji(
  value: unknown,
  opts: { allowShortcode?: boolean } = {},
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (SHORTCODE_RE.test(trimmed)) return opts.allowShortcode ? trimmed : undefined;
  // Letters (any script), digits-with-prose, brackets and whitespace mean text,
  // not a glyph. Keycap sequences (e.g. "1\uFE0F\u20E3") are the only digits allowed.
  if (/\p{L}/u.test(trimmed)) return undefined;
  if (/[()[\]{}<>]/.test(trimmed)) return undefined;
  if (/\s/.test(trimmed)) return undefined;
  if (/\d/.test(trimmed) && !/\d\uFE0F?\u20E3/u.test(trimmed)) return undefined;
  if (graphemeCount(trimmed) > MAX_GRAPHEMES) return undefined;
  return trimmed;
}

/** A fully parenthesised value is an IDENTITY.md template hint, not content. */
export function isIdentityTemplateHint(value: unknown): boolean {
  return typeof value === "string" && /^\(.*\)$/s.test(value.replace(/\*+/g, "").trim());
}

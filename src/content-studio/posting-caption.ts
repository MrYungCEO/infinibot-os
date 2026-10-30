/**
 * Content Studio posting captions — per-page template rendering.
 *
 * Templates use `{variable}` placeholders:
 *   {title} {hook} {hashtags} {cta} {series} {episode} {date} {page} {handle}
 * Unknown variables are left as-is (so a typo is visible in the preview, not
 * silently dropped). `{{` / `}}` escape literal braces. Lines that end up
 * empty because every variable on them was blank are removed, and runs of
 * blank lines collapse to one.
 *
 * Platform limits: Instagram captions cap at 2200 chars / 30 hashtags,
 * TikTok descriptions at 2200 chars. renderCaption() reports overruns as
 * warnings; clampCaption() trims for the device (it never edits the stored
 * template).
 */

import { zonedParts } from "./posting-schedule.js";

export const CAPTION_VARIABLES = [
  "title",
  "hook",
  "hashtags",
  "cta",
  "series",
  "episode",
  "date",
  "page",
  "handle",
] as const;

export type CaptionVariable = (typeof CAPTION_VARIABLES)[number];

export const DEFAULT_CAPTION_TEMPLATE = "{hook}\n\n{title}\n\n{cta}\n\n{hashtags}";

export const PLATFORM_CAPTION_LIMITS: Record<string, { chars: number; hashtags: number }> = {
  instagram: { chars: 2200, hashtags: 30 },
  tiktok: { chars: 2200, hashtags: 30 },
};

export type CaptionContext = {
  title?: string | null;
  hook?: string | null;
  /** Page default hashtags + the video's own, merged & de-duplicated. */
  hashtags?: string[] | string | null;
  cta?: string | null;
  series?: string | null;
  /** Episode number or label. */
  episode?: number | string | null;
  /** Posting instant (ms); rendered as a local date in `timezone`. */
  date?: number | null;
  timezone?: string;
  page?: string | null;
  handle?: string | null;
};

/** "#a, b  #c" / ["a", "#b"] → ["#a", "#b", "#c"] (deduped, case-insensitive). */
export function normalizeHashtags(input: unknown): string[] {
  const raw: string[] = Array.isArray(input)
    ? input.map((v) => String(v ?? ""))
    : typeof input === "string"
      ? input.split(/[\s,]+/)
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const tag = r
      .trim()
      .replace(/^#+/, "")
      .replace(/[^\p{L}\p{N}_]/gu, "");
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`#${tag.slice(0, 60)}`);
  }
  return out.slice(0, 60);
}

export function mergeHashtags(...lists: unknown[]): string[] {
  return normalizeHashtags(lists.flatMap((l) => normalizeHashtags(l)));
}

function formatDate(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[p.mo - 1]} ${p.d}, ${p.y}`;
}

function valueFor(name: CaptionVariable, ctx: CaptionContext): string {
  switch (name) {
    case "hashtags":
      return normalizeHashtags(ctx.hashtags ?? []).join(" ");
    case "episode":
      return ctx.episode === null || ctx.episode === undefined ? "" : String(ctx.episode).trim();
    case "date":
      return ctx.date ? formatDate(ctx.date, ctx.timezone || "UTC") : "";
    case "handle": {
      const h = (ctx.handle ?? "").trim().replace(/^@/, "");
      return h ? `@${h}` : "";
    }
    default: {
      const v = ctx[name];
      return typeof v === "string" ? v.trim() : "";
    }
  }
}

export type RenderedCaption = {
  text: string;
  length: number;
  hashtagCount: number;
  unknownVariables: string[];
  warnings: string[];
};

export function renderCaption(
  template: string,
  ctx: CaptionContext,
  platform: string = "instagram",
): RenderedCaption {
  const unknown = new Set<string>();
  const OPEN = "\u0000";
  const CLOSE = "\u0001";
  const src = (template ?? "").replace(/\{\{/g, OPEN).replace(/\}\}/g, CLOSE);
  const lines = src.split("\n").map((line) => {
    let vars = 0;
    let empty = 0;
    const rendered = line.replace(/\{([a-zA-Z_]+)\}/g, (whole, name: string) => {
      const key = name.toLowerCase();
      if (!(CAPTION_VARIABLES as readonly string[]).includes(key)) {
        unknown.add(name);
        return whole;
      }
      vars++;
      const v = valueFor(key as CaptionVariable, ctx);
      if (!v) empty++;
      return v;
    });
    // Drop a line whose every variable was empty and nothing else remains.
    if (vars > 0 && vars === empty && !rendered.replace(/[\s·•|\-–—:]+/g, "")) return null;
    return rendered.replace(/[ \t]+$/g, "");
  });
  const text = lines
    .filter((l): l is string => l !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(new RegExp(OPEN, "g"), "{")
    .replace(new RegExp(CLOSE, "g"), "}");
  const hashtagCount = (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
  const limits = PLATFORM_CAPTION_LIMITS[platform] ?? PLATFORM_CAPTION_LIMITS.instagram!;
  const warnings: string[] = [];
  if (text.length > limits.chars)
    warnings.push(`caption is ${text.length} chars (limit ${limits.chars})`);
  if (hashtagCount > limits.hashtags)
    warnings.push(`${hashtagCount} hashtags (limit ${limits.hashtags})`);
  if (unknown.size)
    warnings.push(`unknown variables: ${[...unknown].map((u) => `{${u}}`).join(" ")}`);
  if (!text) warnings.push("caption is empty");
  return { text, length: text.length, hashtagCount, unknownVariables: [...unknown], warnings };
}

/** Trims a caption to the platform limits (drops extra hashtags first). */
export function clampCaption(text: string, platform: string = "instagram"): string {
  const limits = PLATFORM_CAPTION_LIMITS[platform] ?? PLATFORM_CAPTION_LIMITS.instagram!;
  let count = 0;
  let out = text.replace(/(^|\s)(#[\p{L}\p{N}_]+)/gu, (whole, pre: string) => {
    count++;
    return count > limits.hashtags ? pre : whole;
  });
  out = out.replace(/[ \t]+\n/g, "\n").trim();
  return out.length > limits.chars ? out.slice(0, limits.chars).trimEnd() : out;
}

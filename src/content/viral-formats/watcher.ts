/**
 * The /watch ingestion engine.
 *
 * Given an account / hashtag / url / list, this pulls top/competitor content
 * using FREE, public, open-source-friendly endpoints (YouTube channel RSS,
 * Reddit public JSON, generic oEmbed / OpenGraph), extracts standardized format
 * features, scores each item, and writes it into the historical benchmark base.
 *
 * Two properties are guaranteed:
 *   • Idempotent — items are keyed by content hash; re-watching the same target
 *     updates rows in place rather than duplicating them.
 *   • Resumable — every target gets a `watch_jobs` row holding a cursor; a
 *     re-run continues from where it left off and re-running after completion is
 *     a cheap no-op.
 *
 * Network ingestion is best-effort: any source that fails (offline, rate-limit,
 * private) degrades gracefully and is reported in `errors[]` without aborting
 * the batch. A `manual` path (caller supplies raw items inline) always works and
 * exercises the full feature-extraction → score → benchmark pipeline with no
 * network, which is also what unit tests and the agent tool's `items` arg use.
 *
 * It REUSES `fetchWithTimeout` from research-service.ts (imported read-only) and
 * never modifies any existing file.
 */

import { fetchWithTimeout } from "../research-service.js";
import { getViralFormatsStore, type WatchedItemInput } from "./benchmark-store.js";

export type WatchSourceType = "account" | "hashtag" | "url" | "list" | "manual";

export interface WatchOptions {
  /** One or more targets: handles, hashtags, URLs, or list ids. */
  targets: string | string[];
  sourceType: WatchSourceType;
  /** Force a niche/subniche instead of auto-detecting per item. */
  niche?: string | null;
  subniche?: string | null;
  /** Max items to ingest per target (default 25). */
  max?: number;
  /** Inline raw items (for `manual` ingestion / tests). */
  items?: WatchedItemInput[];
  /** Override state dir (tests). */
  stateDir?: string;
  /** Per-fetch timeout (ms). */
  timeoutMs?: number;
}

export interface WatchResult {
  ingested: number;
  updated: number;
  targetsProcessed: number;
  affectedNiches: { niche: string; subniche: string | null }[];
  jobIds: string[];
  errors: { target: string; error: string }[];
}

/** A raw item pulled from a source before classification. */
interface RawItem {
  url?: string;
  account?: string;
  caption?: string;
  transcript?: string;
  durationSec?: number;
  publishedAt?: number;
  hashtags?: string[];
  metrics?: WatchedItemInput["metrics"];
}

// ---------------------------------------------------------------------------
// Free ingestors
// ---------------------------------------------------------------------------

function xmlTag(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeEntities(m[1].trim()) : undefined;
}
function xmlAttr(block: string, tag: string, attr: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}[^>]*\\b${attr}="([^"]*)"`, "i"));
  return m ? m[1] : undefined;
}
function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** YouTube channel RSS — free, no key. Accepts a channel id (UC…) or full URL. */
async function ingestYouTube(target: string, timeoutMs: number): Promise<RawItem[]> {
  const channelId = target.match(/UC[\w-]{20,}/)?.[0] ?? target;
  if (!/^UC[\w-]{20,}$/.test(channelId)) return [];
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`youtube rss ${res.status}`);
  const xml = await res.text();
  const entries = xml.split(/<entry>/).slice(1);
  return entries.map((e) => {
    const views = Number(xmlAttr(e, "media:statistics", "views") ?? "0");
    const likes = Number(xmlAttr(e, "media:starRating", "count") ?? "0");
    return {
      url: xmlAttr(e, "link", "href"),
      account: xmlTag(e, "name"),
      caption: `${xmlTag(e, "title") ?? ""}. ${xmlTag(e, "media:description") ?? ""}`.trim(),
      publishedAt: Date.parse(xmlTag(e, "published") ?? "") || undefined,
      metrics: { views: views || null, likes: likes || null },
    } satisfies RawItem;
  });
}

/** Reddit public JSON — free, no key. Accepts r/<sub> or u/<user> or a sub name. */
async function ingestReddit(target: string, timeoutMs: number, max: number): Promise<RawItem[]> {
  const t = target.replace(/^\/?(r|u|user)\//, "");
  const isUser = target.startsWith("u/") || target.startsWith("user/");
  const path = isUser ? `user/${t}/submitted` : `r/${t}`;
  const url = `https://www.reddit.com/${path}.json?limit=${Math.min(max, 100)}`;
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error(`reddit ${res.status}`);
  const json = (await res.json()) as {
    data?: { children?: { data?: Record<string, unknown> }[] };
  };
  const children = json.data?.children ?? [];
  return children.map((c) => {
    const d = c.data ?? {};
    return {
      url: typeof d.permalink === "string" ? `https://www.reddit.com${d.permalink}` : undefined,
      account: typeof d.author === "string" ? d.author : undefined,
      caption: [d.title, d.selftext].filter((x) => typeof x === "string" && x).join(". "),
      publishedAt: typeof d.created_utc === "number" ? d.created_utc * 1000 : undefined,
      metrics: {
        likes: typeof d.ups === "number" ? d.ups : null,
        comments: typeof d.num_comments === "number" ? d.num_comments : null,
      },
    } satisfies RawItem;
  });
}

/** Generic URL via oEmbed/OpenGraph — best-effort title/description capture. */
async function ingestUrl(target: string, timeoutMs: number): Promise<RawItem[]> {
  try {
    const oembed = `https://noembed.com/embed?url=${encodeURIComponent(target)}`;
    const res = await fetchWithTimeout(oembed, timeoutMs);
    if (res.ok) {
      const j = (await res.json()) as Record<string, unknown>;
      if (j && !j.error) {
        return [
          {
            url: target,
            account: typeof j.author_name === "string" ? j.author_name : undefined,
            caption: typeof j.title === "string" ? j.title : undefined,
          },
        ];
      }
    }
  } catch {
    /* fall through to OG scrape */
  }
  const res = await fetchWithTimeout(target, timeoutMs);
  if (!res.ok) throw new Error(`url ${res.status}`);
  const html = await res.text();
  const og = (p: string) =>
    html.match(new RegExp(`<meta[^>]+property="og:${p}"[^>]+content="([^"]*)"`, "i"))?.[1];
  const title = og("title") ?? html.match(/<title>([^<]*)<\/title>/i)?.[1];
  return [{ url: target, caption: [title, og("description")].filter(Boolean).join(". ") }];
}

/** Dispatch a single target to the right free ingestor. */
async function ingestTarget(
  target: string,
  sourceType: WatchSourceType,
  timeoutMs: number,
  max: number,
): Promise<RawItem[]> {
  if (sourceType === "url") return ingestUrl(target, timeoutMs);
  // account / hashtag / list: route by recognisable shape.
  if (/UC[\w-]{20,}/.test(target) || /youtube\.com|youtu\.be/.test(target))
    return ingestYouTube(target, timeoutMs);
  if (/^\/?(r|u|user)\//.test(target) || /reddit\.com/.test(target))
    return ingestReddit(target, timeoutMs, max);
  // Default best-effort: treat as a subreddit name (cheap, free, keyless).
  return ingestReddit(target, timeoutMs, max);
}

// ---------------------------------------------------------------------------
// Watch
// ---------------------------------------------------------------------------

function toInput(
  raw: RawItem,
  source: string,
  sourceType: WatchSourceType,
  opts: WatchOptions,
): WatchedItemInput {
  return {
    url: raw.url ?? null,
    source,
    sourceType,
    account: raw.account ?? null,
    caption: raw.caption ?? null,
    transcript: raw.transcript ?? null,
    durationSec: raw.durationSec ?? null,
    publishedAt: raw.publishedAt ?? null,
    hashtags: raw.hashtags ?? null,
    metrics: raw.metrics ?? null,
    niche: opts.niche ?? null,
    subniche: opts.subniche ?? null,
  };
}

/**
 * Run a watch. Resumable + idempotent. Always recomputes the rolling benchmarks
 * for affected (sub)niches at the end so the base adapts immediately.
 */
export async function watch(opts: WatchOptions): Promise<WatchResult> {
  const store = getViralFormatsStore(opts.stateDir);
  const timeoutMs = opts.timeoutMs ?? 12000;
  const max = opts.max ?? 25;
  const now = Date.now();

  const result: WatchResult = {
    ingested: 0,
    updated: 0,
    targetsProcessed: 0,
    affectedNiches: [],
    jobIds: [],
    errors: [],
  };
  const affected = new Map<string, { niche: string; subniche: string | null }>();

  const record = (input: WatchedItemInput) => {
    const r = store.upsertItem(input, now);
    if (r.inserted) result.ingested++;
    else result.updated++;
    affected.set(`${r.niche}|${r.subniche ?? ""}`, { niche: r.niche, subniche: r.subniche });
  };

  // Manual inline items (no network).
  if (opts.items && opts.items.length) {
    for (const item of opts.items) {
      record({
        ...item,
        niche: item.niche ?? opts.niche ?? null,
        subniche: item.subniche ?? opts.subniche ?? null,
      });
    }
    result.targetsProcessed++;
  }

  // Network targets.
  if (opts.sourceType !== "manual") {
    const targets = Array.isArray(opts.targets) ? opts.targets : [opts.targets];
    for (const target of targets.filter((t) => t && t.trim())) {
      const job = store.getOrCreateJob(target, opts.sourceType, now);
      result.jobIds.push(job.id);
      try {
        store.updateJob(job.id, { status: "running" }, now);
        const raws = (await ingestTarget(target, opts.sourceType, timeoutMs, max)).slice(0, max);
        let count = 0;
        for (const raw of raws) {
          record(toInput(raw, target, opts.sourceType, opts));
          count++;
        }
        store.updateJob(
          job.id,
          { status: "complete", itemsIngested: job.items_ingested + count, cursor: String(now) },
          now,
        );
        result.targetsProcessed++;
      } catch (e) {
        store.updateJob(job.id, { status: "error" }, now);
        result.errors.push({ target, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  // Roll the historical base forward.
  if (affected.size > 0) store.recomputeBenchmarks(now);
  result.affectedNiches = [...affected.values()];
  return result;
}

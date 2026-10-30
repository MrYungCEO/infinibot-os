/**
 * content/trends/aggregator — the /last30days trends engine.
 *
 * Aggregates social-media insights + trending news/topics + trending content
 * formats for the user's content niche using ONLY free / open-source sources —
 * no paid API keys:
 *   • Google News RSS  (news.google.com/rss/search?q=...+when:30d)
 *   • Reddit public .json endpoints  (r/<sub>/top.json?t=month)
 *   • Hacker News Algolia search  (hn.algolia.com, last-30d numeric filter)
 *   • Google Trends daily RSS  (via the existing research-service fetcher)
 *
 * Every source is wrapped so a single failure becomes a warning, never a throw.
 * Results are post-processed into the FROZEN {@link TrendsBundle} shape.
 *
 * Caching/TTL and proactive alerting live in sibling modules (store.ts,
 * proactive-watch.ts) — this file is pure aggregation.
 */

import { fetchWithTimeout } from "../research-service.js";
import type {
  SocialInsight,
  NewsTopic,
  TrendingFormat,
  TrendsBundle,
  TrendsOptions,
} from "./types.js";

// Default niche: short-form / reels / creator marketing (the InfiniBot persona).
const DEFAULT_NICHE = "short-form video & creator marketing";
const DEFAULT_KEYWORDS = [
  "short form video",
  "instagram reels",
  "tiktok",
  "youtube shorts",
  "content creator",
  "viral hook",
];

// Reddit communities most relevant to the creator-marketing niche.
const NICHE_SUBREDDITS = [
  "NewTubers",
  "Instagram",
  "socialmedia",
  "content_marketing",
  "youtubers",
  "Entrepreneur",
];

// Format vocabulary scanned across all gathered titles/snippets to rank the
// trending short-form formats. label → matcher keywords.
const FORMAT_LEXICON: Array<{ label: string; words: string[] }> = [
  { label: "POV", words: ["pov", "point of view"] },
  { label: "Talking head", words: ["talking head", "to camera", "rant", "explained"] },
  { label: "Tutorial / How-to", words: ["tutorial", "how to", "how-to", "step by step", "guide"] },
  { label: "Listicle", words: ["top 5", "top 10", "ways to", "things", "tips", "mistakes"] },
  { label: "Day in the life", words: ["day in the life", "dayinthelife", "routine", "vlog"] },
  { label: "Challenge", words: ["challenge", "trend", "tried"] },
  { label: "Storytime", words: ["storytime", "story time", "story", "i tried"] },
  { label: "Green screen / Reaction", words: ["green screen", "reaction", "reacts", "duet"] },
  { label: "Behind the scenes", words: ["behind the scenes", "bts", "how i made"] },
  { label: "Hook-first", words: ["hook", "stop scrolling", "wait for it", "watch till"] },
];

function clip(s: string, n = 240): string {
  if (!s) return "";
  const x = s.replace(/\s+/g, " ").trim();
  return x.length > n ? x.slice(0, n - 1) + "…" : x;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Tiny stable id from a string (FNV-1a hash → base36). */
function hashId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ── RSS / JSON item extractors ───────────────────────────────────────────────

interface RssItem {
  title: string;
  link: string;
  pubDate?: string;
  description?: string;
  source?: string;
}

function parseRssItems(xml: string, max: number): RssItem[] {
  const items: RssItem[] = [];
  const blocks = xml.split(/<item>/i).slice(1);
  for (const b of blocks) {
    const grab = (tag: string): string => {
      const re = new RegExp(
        `<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`,
        "i",
      );
      return (b.match(re) || [])[1]?.trim() || "";
    };
    const title = stripHtml(grab("title"));
    const link = stripHtml(grab("link"));
    if (!title) continue;
    items.push({
      title,
      link,
      pubDate: grab("pubDate") || undefined,
      description: clip(stripHtml(grab("description"))),
      source: stripHtml(grab("source")) || undefined,
    });
    if (items.length >= max) break;
  }
  return items;
}

/**
 * Parse Atom 1.0 `<entry>` items (Reddit's `.rss` feeds are Atom). Returns the
 * same {@link RssItem} shape. `<link href="..."/>` is an attribute, not text.
 */
function parseAtomEntries(xml: string, max: number): RssItem[] {
  const items: RssItem[] = [];
  const blocks = xml.split(/<entry>/i).slice(1);
  for (const b of blocks) {
    const grab = (tag: string): string => {
      const re = new RegExp(
        `<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`,
        "i",
      );
      return (b.match(re) || [])[1]?.trim() || "";
    };
    const title = stripHtml(grab("title"));
    const href = (b.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "";
    if (!title) continue;
    items.push({
      title,
      link: href,
      pubDate: grab("updated") || grab("published") || undefined,
      description: clip(stripHtml(grab("content"))),
    });
    if (items.length >= max) break;
  }
  return items;
}

// A browser-like UA — Reddit and some RSS hosts 403 the generic research UA.
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ── Source fetchers (each never throws; pushes warnings via the caller) ───────

async function fetchGoogleNews(
  keywords: string[],
  timeoutMs: number,
): Promise<{ topics: NewsTopic[]; warning?: string }> {
  const q = `(${keywords.map((k) => `"${k}"`).join(" OR ")}) when:30d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  try {
    const r = await fetchWithTimeout(url, timeoutMs, {
      headers: { Accept: "application/rss+xml,text/xml,*/*" },
    });
    if (!r.ok) return { topics: [], warning: `google-news ${r.status}` };
    const xml = await r.text();
    const items = parseRssItems(xml, 24);
    // Google News titles are "<headline> - <publisher>"; cluster by headline stem.
    const byStem = new Map<string, { item: RssItem; count: number }>();
    for (const it of items) {
      const headline = it.title.replace(/\s+-\s+[^-]+$/, "").trim();
      const stem = headline.toLowerCase().split(/\s+/).slice(0, 5).join(" ");
      const cur = byStem.get(stem);
      if (cur) cur.count++;
      else byStem.set(stem, { item: it, count: 1 });
    }
    const topics: NewsTopic[] = [...byStem.values()].map(({ item, count }) => {
      const m = item.title.match(/\s+-\s+([^-]+)$/);
      const publisher = m ? m[1].trim() : item.source || hostnameOf(item.link);
      const headline = item.title.replace(/\s+-\s+[^-]+$/, "").trim();
      return {
        id: hashId(item.link || headline),
        title: headline,
        url: item.link,
        summary: item.description || headline,
        source: publisher || hostnameOf(item.link) || "news",
        publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : undefined,
        cluster: count,
      };
    });
    return { topics };
  } catch (e) {
    return { topics: [], warning: `google-news: ${(e as Error).message.slice(0, 100)}` };
  }
}

async function fetchRedditSub(
  sub: string,
  timeoutMs: number,
): Promise<{ insights: SocialInsight[]; warning?: string }> {
  // Primary: the public JSON endpoint, which carries real engagement scores.
  // Reddit increasingly 403s datacenter IPs / generic UAs, so on failure we
  // fall back to the `.rss` (Atom) feed which is far more permissive. RSS lacks
  // scores, so we assign a descending rank as a display-only proxy (kept small
  // enough that it can never trip the social-spike outlier heuristic).
  try {
    const r = await fetchWithTimeout(
      `https://www.reddit.com/r/${sub}/top.json?t=month&limit=12`,
      timeoutMs,
      { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } },
    );
    if (r.ok) {
      const j: any = await r.json();
      const insights: SocialInsight[] = [];
      for (const c of j?.data?.children || []) {
        const d = c?.data;
        if (!d?.permalink || d.stickied) continue;
        insights.push({
          id: hashId(d.permalink),
          title: clip(d.title || "", 200),
          url: `https://www.reddit.com${d.permalink}`,
          summary: clip(d.selftext || d.title || "", 240),
          platform: "reddit",
          community: `r/${sub}`,
          score: Number(d.score) || 0,
          publishedAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : undefined,
        });
      }
      if (insights.length) return { insights };
    }
  } catch {
    /* fall through to RSS */
  }

  // Fallback: Atom `.rss` feed.
  try {
    const r = await fetchWithTimeout(
      `https://www.reddit.com/r/${sub}/top/.rss?t=month&limit=12`,
      timeoutMs,
      { headers: { "User-Agent": BROWSER_UA, Accept: "application/atom+xml,application/xml,*/*" } },
    );
    if (!r.ok) return { insights: [], warning: `reddit/${sub} ${r.status}` };
    const entries = parseAtomEntries(await r.text(), 12);
    const insights: SocialInsight[] = entries.map((e, i) => ({
      id: hashId(e.link || e.title),
      title: clip(e.title, 200),
      url: e.link,
      summary: clip(e.description || e.title, 240),
      platform: "reddit",
      community: `r/${sub}`,
      score: 12 - i, // rank proxy (1..12) — display ordering only
      publishedAt: e.pubDate ? new Date(e.pubDate).toISOString() : undefined,
    }));
    return { insights };
  } catch (e) {
    return { insights: [], warning: `reddit/${sub}: ${(e as Error).message.slice(0, 80)}` };
  }
}

async function fetchHackerNews(
  keywords: string[],
  timeoutMs: number,
): Promise<{ insights: SocialInsight[]; warning?: string }> {
  const since = Math.floor((Date.now() - 30 * 86400000) / 1000);
  const q = keywords.slice(0, 3).join(" ");
  const url =
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}` +
    `&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=12`;
  try {
    const r = await fetchWithTimeout(url, timeoutMs);
    if (!r.ok) return { insights: [], warning: `hackernews ${r.status}` };
    const j: any = await r.json();
    const insights: SocialInsight[] = [];
    for (const h of j?.hits || []) {
      const link =
        h.url || (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : "");
      if (!link) continue;
      insights.push({
        id: hashId(link),
        title: clip(h.title || h.story_title || "", 200),
        url: link,
        summary: clip(h.story_text || h.title || "", 240),
        platform: "hackernews",
        community: "Hacker News",
        score: Number(h.points) || 0,
        publishedAt: h.created_at,
      });
    }
    return { insights };
  } catch (e) {
    return { insights: [], warning: `hackernews: ${(e as Error).message.slice(0, 80)}` };
  }
}

async function fetchGoogleTrends(
  timeoutMs: number,
): Promise<{ formats: string[]; warning?: string }> {
  // Google retired the /trendingsearches/daily/rss path; the current feed is
  // /trending/rss. Try the new path, then the legacy one as a fallback.
  const urls = [
    "https://trends.google.com/trending/rss?geo=US",
    "https://trends.google.com/trends/trendingsearches/daily/rss?geo=US",
  ];
  for (const url of urls) {
    try {
      const r = await fetchWithTimeout(url, timeoutMs, { headers: { "User-Agent": BROWSER_UA } });
      if (!r.ok) continue;
      const formats = parseRssItems(await r.text(), 20).map((i) => i.title);
      if (formats.length) return { formats };
    } catch {
      /* try next */
    }
  }
  return { formats: [], warning: "google-trends: no feed reachable" };
}

// ── Format extraction ─────────────────────────────────────────────────────────

function extractFormats(
  corpus: Array<{ title: string; summary: string; url?: string }>,
): TrendingFormat[] {
  const out: TrendingFormat[] = [];
  for (const { label, words } of FORMAT_LEXICON) {
    let mentions = 0;
    let example = "";
    let exampleUrl: string | undefined;
    for (const item of corpus) {
      const hay = `${item.title} ${item.summary}`.toLowerCase();
      if (words.some((w) => hay.includes(w))) {
        mentions++;
        if (!example) {
          example = item.title;
          exampleUrl = item.url;
        }
      }
    }
    if (mentions > 0) {
      out.push({ id: hashId(label), label, mentions, example: clip(example, 160), exampleUrl });
    }
  }
  return out.sort((a, b) => b.mentions - a.mentions);
}

// ── Main entry ────────────────────────────────────────────────────────────────

/**
 * Aggregate the last-30-days trends bundle. Pure aggregation: no cache reads
 * (the RPC layer owns TTL). Never throws — source failures land in `warnings`.
 */
export async function aggregateTrends(opts: TrendsOptions = {}): Promise<TrendsBundle> {
  const niche = (opts.niche && opts.niche.trim()) || DEFAULT_NICHE;
  const keywords =
    Array.isArray(opts.keywords) && opts.keywords.length ? opts.keywords : DEFAULT_KEYWORDS;
  const timeoutMs = Math.max(2000, Math.min(opts.timeoutMs ?? 8000, 15000));
  const warnings: string[] = [];

  const [news, hn, trends, ...subs] = await Promise.all([
    fetchGoogleNews(keywords, timeoutMs),
    fetchHackerNews(keywords, timeoutMs),
    fetchGoogleTrends(timeoutMs),
    ...NICHE_SUBREDDITS.map((s) => fetchRedditSub(s, timeoutMs)),
  ]);

  if (news.warning) warnings.push(news.warning);
  if (hn.warning) warnings.push(hn.warning);
  if (trends.warning) warnings.push(trends.warning);

  // Social insights = Reddit + HN, deduped by id, ranked by score.
  const socialMap = new Map<string, SocialInsight>();
  for (const sub of subs) {
    if (sub.warning) warnings.push(sub.warning);
    for (const ins of sub.insights) socialMap.set(ins.id, ins);
  }
  for (const ins of hn.insights) socialMap.set(ins.id, ins);
  const socialInsights = [...socialMap.values()].sort((a, b) => b.score - a.score).slice(0, 18);

  // News topics deduped + ranked by cluster size then recency.
  const newsMap = new Map<string, NewsTopic>();
  for (const t of news.topics) newsMap.set(t.id, t);
  const newsTopics = [...newsMap.values()]
    .sort(
      (a, b) => b.cluster - a.cluster || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
    )
    .slice(0, 14);

  // Trending formats from the combined corpus + raw Google-Trends headlines.
  const corpus: Array<{ title: string; summary: string; url?: string }> = [
    ...socialInsights.map((s) => ({ title: s.title, summary: s.summary, url: s.url })),
    ...newsTopics.map((n) => ({ title: n.title, summary: n.summary, url: n.url })),
    ...trends.formats.map((t) => ({ title: t, summary: "" })),
  ];
  const trendingFormats = extractFormats(corpus).slice(0, 8);

  const sourcesConsulted =
    (news.topics.length ? 1 : 0) +
    (hn.insights.length ? 1 : 0) +
    (trends.formats.length ? 1 : 0) +
    subs.filter((s) => s.insights.length).length;

  return {
    niche,
    keywords,
    socialInsights,
    newsTopics,
    trendingFormats,
    generatedAt: Date.now(),
    sourcesConsulted,
    warnings,
    origin: "live",
  };
}

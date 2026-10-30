/**
 * research-service — gather research from free public APIs + optional browser
 * relay fallback. Contract: see research-service.contract.md.
 *
 * No new npm deps; pure node 18+ fetch + AbortController. Never throws — any
 * source failure becomes a warning in the returned ResearchBundle.
 *
 * Browser-relay note: no in-process helper exists in src/agents/tools/ at the
 * time of writing (only mcp__infinibot__browser MCP tool). We therefore use a
 * direct `fetch()` with the InfiniBot-Research UA and a minimal HTML→text
 * strip as the fallback. Swap in a real relay helper here when one lands.
 */

const USER_AGENT = "InfiniBot-Research/1.0 (+https://infinibot.app)";

// =============================================================================
// CONTRACT TYPES (mirrored — these are the FROZEN signatures)
// =============================================================================

export interface ResearchSource {
  kind:
    | "wikipedia"
    | "duckduckgo"
    | "reddit"
    | "hackernews"
    | "oembed"
    | "openlibrary"
    | "arxiv"
    | "github"
    | "trends"
    | "news"
    | "browser-relay"
    | "other";
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  score?: number;
}

export interface ResearchStat {
  value: string;
  context: string;
  source: ResearchSource;
}

export interface ResearchQuote {
  text: string;
  speaker?: string;
  source: ResearchSource;
}

export interface ResearchBundle {
  query: string;
  generatedAt: number;
  durationMs: number;
  facts: string[];
  stats: ResearchStat[];
  quotes: ResearchQuote[];
  trends: string[];
  sources: ResearchSource[];
  warnings: string[];
}

export interface ResearchOptions {
  query: string;
  sources?: Array<ResearchSource["kind"]> | "auto";
  timeoutMs?: number;
  perSource?: number;
  useBrowserRelay?: boolean;
  language?: string;
  freshnessDays?: number;
}

// =============================================================================
// HTTP HELPER
// =============================================================================

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = new Headers(init?.headers || {});
    if (!headers.has("User-Agent")) headers.set("User-Agent", USER_AGENT);
    if (!headers.has("Accept")) headers.set("Accept", "application/json,text/*;q=0.9,*/*;q=0.5");
    return await fetch(url, { ...init, headers, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function clip(s: string, n = 500): string {
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
    .replace(/&#39;/g, "'")
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

function pathKey(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

// =============================================================================
// SOURCE FETCHERS — each returns ResearchSource[]; never throws
// =============================================================================

async function fetchWikipedia(
  query: string,
  perSource: number,
  timeoutMs: number,
  lang: string,
): Promise<ResearchSource[]> {
  const out: ResearchSource[] = [];
  // 1) search to find best title(s)
  const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${perSource}&srsearch=${encodeURIComponent(query)}`;
  const r = await fetchWithTimeout(searchUrl, timeoutMs);
  if (!r.ok) throw new Error(`wikipedia search ${r.status}`);
  const j: any = await r.json();
  const hits: any[] = j?.query?.search || [];
  if (!hits.length) return out;
  // 2) summary for top hit (parallel up to 2)
  const top = hits.slice(0, Math.min(2, hits.length));
  await Promise.all(
    top.map(async (h) => {
      try {
        const sr = await fetchWithTimeout(
          `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(h.title)}`,
          timeoutMs,
        );
        if (!sr.ok) return;
        const sj: any = await sr.json();
        out.push({
          kind: "wikipedia",
          title: sj.title || h.title,
          url:
            sj.content_urls?.desktop?.page ||
            `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(h.title)}`,
          snippet: clip(sj.extract || stripHtml(h.snippet || "")),
          score: 100,
        });
      } catch {
        /* ignore single-summary failures */
      }
    }),
  );
  // remaining search hits as lighter sources
  for (const h of hits.slice(top.length)) {
    out.push({
      kind: "wikipedia",
      title: h.title,
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(h.title)}`,
      snippet: clip(stripHtml(h.snippet || "")),
      score: 50,
    });
  }
  return out;
}

export async function fetchDuckDuckGo(query: string, timeoutMs: number): Promise<ResearchSource[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const r = await fetchWithTimeout(url, timeoutMs);
  if (!r.ok) throw new Error(`ddg ${r.status}`);
  const j: any = await r.json();
  const out: ResearchSource[] = [];
  if (j.AbstractText && j.AbstractURL) {
    out.push({
      kind: "duckduckgo",
      title: j.Heading || query,
      url: j.AbstractURL,
      snippet: clip(j.AbstractText),
      score: 90,
    });
  }
  for (const rt of j.RelatedTopics || []) {
    if (rt?.FirstURL && rt?.Text) {
      out.push({
        kind: "duckduckgo",
        title: clip(rt.Text, 100),
        url: rt.FirstURL,
        snippet: clip(rt.Text),
        score: 40,
      });
    }
    if (Array.isArray(rt?.Topics)) {
      for (const sub of rt.Topics) {
        if (sub?.FirstURL && sub?.Text) {
          out.push({
            kind: "duckduckgo",
            title: clip(sub.Text, 100),
            url: sub.FirstURL,
            snippet: clip(sub.Text),
            score: 30,
          });
        }
      }
    }
  }
  return out;
}

async function fetchReddit(
  query: string,
  perSource: number,
  timeoutMs: number,
): Promise<ResearchSource[]> {
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&t=year&limit=${perSource}`;
  const r = await fetchWithTimeout(url, timeoutMs, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`reddit ${r.status}`);
  const j: any = await r.json();
  const out: ResearchSource[] = [];
  for (const c of j?.data?.children || []) {
    const d = c?.data;
    if (!d?.permalink) continue;
    out.push({
      kind: "reddit",
      title: d.title || "",
      url: `https://www.reddit.com${d.permalink}`,
      snippet: clip(d.selftext || d.title || ""),
      publishedAt: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : undefined,
      score: Number(d.score) || 0,
    });
  }
  return out;
}

async function fetchHackerNews(
  query: string,
  perSource: number,
  timeoutMs: number,
): Promise<ResearchSource[]> {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${perSource}`;
  const r = await fetchWithTimeout(url, timeoutMs);
  if (!r.ok) throw new Error(`hn ${r.status}`);
  const j: any = await r.json();
  const out: ResearchSource[] = [];
  for (const h of j?.hits || []) {
    const link =
      h.url || (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : null);
    if (!link) continue;
    out.push({
      kind: "hackernews",
      title: h.title || h.story_title || "",
      url: link,
      snippet: clip(h.story_text || h.comment_text || h.title || ""),
      publishedAt: h.created_at,
      score: Number(h.points) || 0,
    });
  }
  return out;
}

async function fetchArxiv(
  query: string,
  perSource: number,
  timeoutMs: number,
): Promise<ResearchSource[]> {
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${perSource}`;
  const r = await fetchWithTimeout(url, timeoutMs);
  if (!r.ok) throw new Error(`arxiv ${r.status}`);
  const text = await r.text();
  const out: ResearchSource[] = [];
  const entries = text.split(/<entry>/).slice(1);
  for (const e of entries) {
    const title = (e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
    const summary = (e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || "";
    const link = (e.match(/<id>([\s\S]*?)<\/id>/) || [])[1] || "";
    const published = (e.match(/<published>([\s\S]*?)<\/published>/) || [])[1];
    if (!link) continue;
    out.push({
      kind: "arxiv",
      title: clip(title.trim(), 200),
      url: link.trim(),
      snippet: clip(summary.trim()),
      publishedAt: published?.trim(),
      score: 60,
    });
  }
  return out;
}

async function fetchOpenLibrary(
  query: string,
  perSource: number,
  timeoutMs: number,
): Promise<ResearchSource[]> {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${perSource}`;
  const r = await fetchWithTimeout(url, timeoutMs);
  if (!r.ok) throw new Error(`openlibrary ${r.status}`);
  const j: any = await r.json();
  const out: ResearchSource[] = [];
  for (const d of j?.docs || []) {
    if (!d.key) continue;
    out.push({
      kind: "openlibrary",
      title: d.title || "",
      url: `https://openlibrary.org${d.key}`,
      snippet: clip(
        [
          d.title,
          d.author_name?.join(", "),
          d.first_publish_year ? `(${d.first_publish_year})` : "",
        ]
          .filter(Boolean)
          .join(" — "),
      ),
      publishedAt: d.first_publish_year ? `${d.first_publish_year}-01-01` : undefined,
      score: Number(d.edition_count) || 10,
    });
  }
  return out;
}

async function fetchGithub(
  query: string,
  perSource: number,
  timeoutMs: number,
): Promise<ResearchSource[]> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=${perSource}`;
  const r = await fetchWithTimeout(url, timeoutMs, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
  });
  if (!r.ok) throw new Error(`github ${r.status}`);
  const j: any = await r.json();
  const out: ResearchSource[] = [];
  for (const it of j?.items || []) {
    out.push({
      kind: "github",
      title: it.full_name || it.name || "",
      url: it.html_url,
      snippet: clip(it.description || it.full_name || ""),
      publishedAt: it.updated_at,
      score: Number(it.stargazers_count) || 0,
    });
  }
  return out;
}

async function fetchTrends(timeoutMs: number, geo = "US"): Promise<ResearchSource[]> {
  const url = `https://trends.google.com/trends/trendingsearches/daily/rss?geo=${geo}`;
  const r = await fetchWithTimeout(url, timeoutMs);
  if (!r.ok) throw new Error(`trends ${r.status}`);
  const text = await r.text();
  const out: ResearchSource[] = [];
  const items = text.split(/<item>/).slice(1);
  for (const it of items) {
    const title = (it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || "";
    const link = (it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
    const pubDate = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
    if (!title) continue;
    out.push({
      kind: "trends",
      title: clip(title.trim(), 200),
      url: link.trim() || "https://trends.google.com/trends/trendingsearches/daily",
      snippet: clip(title.trim()),
      publishedAt: pubDate ? new Date(pubDate).toISOString() : undefined,
      score: 20,
    });
  }
  return out;
}

async function fetchOembed(
  query: string,
  _perSource: number,
  _timeoutMs: number,
): Promise<ResearchSource[]> {
  // oEmbed needs a URL — query is not a URL here, so return empty by default.
  // Caller can pass URLs via opts.sources future-extension; we no-op for now.
  void query;
  return [];
}

// Optional keyed news sources (no-throw on missing keys)
async function fetchNewsCatcher(
  query: string,
  perSource: number,
  timeoutMs: number,
): Promise<ResearchSource[]> {
  const key = process.env.NEWSCATCHER_API_KEY;
  if (!key) return [];
  const url = `https://api.newscatcherapi.com/v2/search?q=${encodeURIComponent(query)}&page_size=${perSource}`;
  const r = await fetchWithTimeout(url, timeoutMs, { headers: { "x-api-key": key } });
  if (!r.ok) throw new Error(`newscatcher ${r.status}`);
  const j: any = await r.json();
  return (j?.articles || [])
    .map((a: any) => ({
      kind: "news" as const,
      title: a.title || "",
      url: a.link,
      snippet: clip(a.excerpt || a.summary || a.title || ""),
      publishedAt: a.published_date,
      score: 50,
    }))
    .filter((s: ResearchSource) => s.url);
}

async function fetchMediastack(
  query: string,
  perSource: number,
  timeoutMs: number,
): Promise<ResearchSource[]> {
  const key = process.env.MEDIASTACK_API_KEY;
  if (!key) return [];
  const url = `http://api.mediastack.com/v1/news?access_key=${key}&keywords=${encodeURIComponent(query)}&limit=${perSource}`;
  const r = await fetchWithTimeout(url, timeoutMs);
  if (!r.ok) throw new Error(`mediastack ${r.status}`);
  const j: any = await r.json();
  return (j?.data || [])
    .map((a: any) => ({
      kind: "news" as const,
      title: a.title || "",
      url: a.url,
      snippet: clip(a.description || a.title || ""),
      publishedAt: a.published_at,
      score: 50,
    }))
    .filter((s: ResearchSource) => s.url);
}

async function fetchCurrents(
  query: string,
  perSource: number,
  timeoutMs: number,
): Promise<ResearchSource[]> {
  const key = process.env.CURRENTS_API_KEY;
  if (!key) return [];
  const url = `https://api.currentsapi.services/v1/search?keywords=${encodeURIComponent(query)}&page_size=${perSource}&apiKey=${key}`;
  const r = await fetchWithTimeout(url, timeoutMs);
  if (!r.ok) throw new Error(`currents ${r.status}`);
  const j: any = await r.json();
  return (j?.news || [])
    .map((a: any) => ({
      kind: "news" as const,
      title: a.title || "",
      url: a.url,
      snippet: clip(a.description || a.title || ""),
      publishedAt: a.published,
      score: 50,
    }))
    .filter((s: ResearchSource) => s.url);
}

// Browser-relay fallback. No in-process helper found in src/agents/tools/, so
// we fetch the DuckDuckGo HTML lite page directly with our UA and strip HTML.
async function fetchBrowserRelay(
  query: string,
  perSource: number,
  timeoutMs: number,
): Promise<ResearchSource[]> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const r = await fetchWithTimeout(url, timeoutMs, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*;q=0.5" },
  });
  if (!r.ok) throw new Error(`relay ${r.status}`);
  const html = await r.text();
  const out: ResearchSource[] = [];
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = linkRe.exec(html)) && i < perSource) {
    const href = m[1];
    const title = stripHtml(m[2]);
    if (!href || !title) continue;
    let real = href;
    try {
      const u = new URL(href, "https://duckduckgo.com");
      const uddg = u.searchParams.get("uddg");
      if (uddg) real = decodeURIComponent(uddg);
    } catch {
      /* keep href */
    }
    out.push({
      kind: "browser-relay",
      title: clip(title, 200),
      url: real,
      snippet: clip(title),
      score: 25,
    });
    i++;
  }
  return out;
}

// =============================================================================
// EXTRACTION HELPERS
// =============================================================================

const DEFAULT_SOURCES: ResearchSource["kind"][] = [
  "wikipedia",
  "duckduckgo",
  "reddit",
  "hackernews",
  "arxiv",
  "openlibrary",
  "github",
  "trends",
  "news",
];

function firstSentence(s: string): string {
  if (!s) return "";
  const m = s.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : s).trim();
}

const STAT_RE =
  /(\d+(?:\.\d+)?\s*(?:%|x\b|times\b|in\s+\d+|billion|million|thousand|\bB\b|\bM\b|\bK\b))/gi;
const QUOTE_RE = /["“]([^"”]{20,200})["”]/g;

function extractStats(sources: ResearchSource[]): ResearchStat[] {
  const out: ResearchStat[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    const text = `${s.title} ${s.snippet}`;
    let m: RegExpExecArray | null;
    STAT_RE.lastIndex = 0;
    while ((m = STAT_RE.exec(text))) {
      const value = m[1].trim();
      const k = `${value}|${pathKey(s.url)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const start = Math.max(0, m.index - 60);
      const end = Math.min(text.length, m.index + m[1].length + 60);
      out.push({ value, context: clip(text.slice(start, end), 200), source: s });
      if (out.length >= 20) return out;
    }
  }
  return out;
}

function extractQuotes(sources: ResearchSource[]): ResearchQuote[] {
  const out: ResearchQuote[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    if (s.kind !== "reddit" && s.kind !== "news" && s.kind !== "browser-relay") continue;
    const text = `${s.title} ${s.snippet}`;
    let m: RegExpExecArray | null;
    QUOTE_RE.lastIndex = 0;
    while ((m = QUOTE_RE.exec(text))) {
      const q = m[1].trim();
      if (seen.has(q)) continue;
      seen.add(q);
      out.push({ text: q, source: s });
      if (out.length >= 10) return out;
    }
  }
  return out;
}

function buildFacts(byKind: Map<string, ResearchSource[]>): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();
  const push = (f: string) => {
    const t = f.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    facts.push(t);
  };
  const wiki = byKind.get("wikipedia") || [];
  if (wiki[0]?.snippet) push(firstSentence(wiki[0].snippet));
  const ddg = byKind.get("duckduckgo") || [];
  if (ddg[0]?.snippet) push(firstSentence(ddg[0].snippet));
  for (const h of (byKind.get("hackernews") || []).slice(0, 3)) {
    if (h.title) push(h.title);
  }
  for (const r of (byKind.get("reddit") || []).slice(0, 3)) {
    if (r.title) push(r.title);
  }
  for (const a of (byKind.get("arxiv") || []).slice(0, 2)) {
    if (a.snippet) push(firstSentence(a.snippet));
  }
  return facts.slice(0, 15);
}

function buildTrends(byKind: Map<string, ResearchSource[]>, freshnessDays?: number): string[] {
  const out: string[] = [];
  const cutoff = freshnessDays ? Date.now() - freshnessDays * 86400000 : 0;
  for (const t of (byKind.get("trends") || []).slice(0, 10)) {
    out.push(t.title);
  }
  for (const n of (byKind.get("news") || []).slice(0, 20)) {
    if (cutoff && n.publishedAt && new Date(n.publishedAt).getTime() < cutoff) continue;
    out.push(n.title);
  }
  return Array.from(new Set(out)).slice(0, 15);
}

function dedupeSources(sources: ResearchSource[]): ResearchSource[] {
  const map = new Map<string, ResearchSource>();
  for (const s of sources) {
    if (!s.url) continue;
    const k = pathKey(s.url);
    const cur = map.get(k);
    if (!cur || (s.score ?? 0) > (cur.score ?? 0)) map.set(k, s);
  }
  return Array.from(map.values()).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

// =============================================================================
// MAIN ENTRY
// =============================================================================

export async function gatherResearch(opts: ResearchOptions): Promise<ResearchBundle> {
  const start = Date.now();
  const query = (opts.query || "").trim();
  const totalTimeout = Math.max(1000, opts.timeoutMs ?? 15000);
  const perSource = Math.max(1, Math.min(25, opts.perSource ?? 5));
  const language = opts.language || "en";
  const freshnessDays = opts.freshnessDays;
  const useRelay = opts.useBrowserRelay !== false;

  const requested: ResearchSource["kind"][] =
    !opts.sources || opts.sources === "auto"
      ? DEFAULT_SOURCES.slice()
      : (opts.sources as ResearchSource["kind"][]);

  // de-dupe + filter to known kinds
  const known = new Set(DEFAULT_SOURCES.concat(["oembed", "browser-relay", "other"]));
  const kinds = Array.from(new Set(requested)).filter((k) => known.has(k));

  const perSourceTimeout = Math.min(Math.floor(totalTimeout / Math.max(1, kinds.length)), 5000);
  const warnings: string[] = [];

  type Job = { kind: ResearchSource["kind"]; fn: () => Promise<ResearchSource[]> };
  const jobs: Job[] = [];
  for (const k of kinds) {
    switch (k) {
      case "wikipedia":
        jobs.push({
          kind: k,
          fn: () => fetchWikipedia(query, perSource, perSourceTimeout, language),
        });
        break;
      case "duckduckgo":
        jobs.push({ kind: k, fn: () => fetchDuckDuckGo(query, perSourceTimeout) });
        break;
      case "reddit":
        jobs.push({ kind: k, fn: () => fetchReddit(query, perSource, perSourceTimeout) });
        break;
      case "hackernews":
        jobs.push({ kind: k, fn: () => fetchHackerNews(query, perSource, perSourceTimeout) });
        break;
      case "arxiv":
        jobs.push({ kind: k, fn: () => fetchArxiv(query, perSource, perSourceTimeout) });
        break;
      case "openlibrary":
        jobs.push({ kind: k, fn: () => fetchOpenLibrary(query, perSource, perSourceTimeout) });
        break;
      case "github":
        jobs.push({ kind: k, fn: () => fetchGithub(query, perSource, perSourceTimeout) });
        break;
      case "trends":
        jobs.push({ kind: k, fn: () => fetchTrends(perSourceTimeout) });
        break;
      case "news":
        jobs.push({
          kind: k,
          fn: async () => {
            const arrs = await Promise.all([
              fetchNewsCatcher(query, perSource, perSourceTimeout).catch(() => []),
              fetchMediastack(query, perSource, perSourceTimeout).catch(() => []),
              fetchCurrents(query, perSource, perSourceTimeout).catch(() => []),
            ]);
            return arrs.flat();
          },
        });
        break;
      case "oembed":
        jobs.push({ kind: k, fn: () => fetchOembed(query, perSource, perSourceTimeout) });
        break;
      default:
        break;
    }
  }

  if (!query) {
    return {
      query,
      generatedAt: Date.now(),
      durationMs: Date.now() - start,
      facts: [],
      stats: [],
      quotes: [],
      trends: [],
      sources: [],
      warnings: ["empty query — nothing to research"],
    };
  }

  // Global timeout race for the whole job set.
  const allJobs = Promise.allSettled(jobs.map((j) => j.fn()));
  const timer = new Promise<PromiseSettledResult<ResearchSource[]>[]>((resolve) => {
    setTimeout(() => {
      warnings.push(`total timeout ${totalTimeout}ms reached — returning partial`);
      resolve(
        jobs.map(() => ({ status: "rejected" as const, reason: new Error("total-timeout") })),
      );
    }, totalTimeout);
  });
  const settled = await Promise.race([allJobs, timer]);

  const all: ResearchSource[] = [];
  const byKind = new Map<string, ResearchSource[]>();
  settled.forEach((res, i) => {
    const kind = jobs[i].kind;
    if (res.status === "fulfilled") {
      const arr = (res.value || []).filter((s) => s && s.url);
      if (arr.length === 0) warnings.push(`${kind}: no results`);
      else {
        all.push(...arr);
        byKind.set(kind, arr);
      }
    } else {
      const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
      warnings.push(`${kind}: ${msg.slice(0, 120)}`);
    }
  });

  // Browser-relay fallback when facts are too thin.
  const factCountSoFar = buildFacts(byKind).length;
  if (useRelay && factCountSoFar < 3) {
    try {
      const relay = await fetchBrowserRelay(query, perSource, Math.min(perSourceTimeout, 5000));
      if (relay.length > 0) {
        all.push(...relay);
        byKind.set("browser-relay", relay);
      } else {
        warnings.push("browser-relay: no results");
      }
    } catch (e) {
      warnings.push(`browser-relay: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  const sources = dedupeSources(all);
  const facts = buildFacts(byKind);
  const stats = extractStats(sources);
  const quotes = extractQuotes(sources);
  const trends = buildTrends(byKind, freshnessDays);

  return {
    query,
    generatedAt: Date.now(),
    durationMs: Date.now() - start,
    facts,
    stats,
    quotes,
    trends,
    sources,
    warnings,
  };
}

// =============================================================================
// PROMPT BLOCK RENDERER
// =============================================================================

export function bundleToPromptBlock(bundle: ResearchBundle): string {
  const lines: string[] = [];
  lines.push("## RESEARCH BUNDLE");
  lines.push(`**Query:** ${bundle.query}`);
  const freshness =
    bundle.trends.length > 0
      ? `, freshness: ${bundle.sources.filter((s) => s.publishedAt).length}d`
      : "";
  lines.push(`**Sources consulted:** ${bundle.sources.length}${freshness}`);
  lines.push("");
  lines.push("### Key facts");
  if (bundle.facts.length === 0) lines.push("- (none)");
  for (const f of bundle.facts) lines.push(`- ${f}`);
  lines.push("");
  lines.push("### Stats worth citing");
  if (bundle.stats.length === 0) lines.push("- (none)");
  for (const s of bundle.stats) {
    lines.push(`- "${s.value}" — ${s.context} (source: ${hostnameOf(s.source.url)})`);
  }
  lines.push("");
  lines.push("### Quotes");
  if (bundle.quotes.length === 0) lines.push("> (none)");
  for (const q of bundle.quotes) {
    const who = q.speaker ? ` — ${q.speaker}` : "";
    lines.push(`> "${q.text}"${who} (${hostnameOf(q.source.url)})`);
  }
  lines.push("");
  lines.push("### Recent angles");
  if (bundle.trends.length === 0) lines.push("- (none)");
  for (const t of bundle.trends) lines.push(`- ${t}`);
  lines.push("");
  lines.push("### Sources");
  bundle.sources.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.title} — ${s.url}`);
  });
  if (bundle.warnings.length > 0) {
    lines.push("");
    lines.push("### Warnings");
    for (const w of bundle.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

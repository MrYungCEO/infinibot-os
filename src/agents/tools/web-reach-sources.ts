/**
 * Keyless web sources for the web-reach tools (web_read, web_search fallback,
 * web_image_search, youtube_transcript, github_read, rss_read).
 *
 * Inspired by agent-reach (github.com/Panniantong/agent-reach): every source
 * here works with no API key and no per-user setup. Each search source returns
 * an empty list (or throws) when it is blocked, and the chains fall through to
 * the next one, so a blocked engine degrades instead of failing the tool.
 *
 *   read    Jina Reader (r.jina.ai) → direct fetch + Readability (web-fetch.ts)
 *   search  Exa hosted MCP (mcp.exa.ai, keyless) → DuckDuckGo HTML → Bing HTML
 *           → DuckDuckGo instant answers
 *   images  Bing Images → DuckDuckGo Images → Openverse → Wikimedia Commons
 *   video   yt-dlp subtitles (system binary, optional)
 *   github  `gh api` when installed, else the unauthenticated REST API
 *   rss     plain fetch + tolerant RSS/Atom parsing (no feed-parser dep)
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fetchDuckDuckGo } from "../../content/research-service.js";
import { readResponseText, withTimeout } from "./web-shared.js";

export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const BOT_USER_AGENT = "InfiniBot/1.0 (+https://infinibotos.com; web-reach)";

export const JINA_READER_BASE = "https://r.jina.ai/";
export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

// ─── shared helpers ──────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
  "&apos;": "'",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
};

export function decodeHtml(value: string): string {
  return value
    .replace(/&(amp|quot|#39|#x27|apos|lt|gt|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}

export function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function siteName(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

export type SourceAttempt = { source: string; count?: number; error?: string };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─── web_read: Jina Reader ───────────────────────────────────────────────────

export type JinaReadResult = { title?: string; url?: string; published?: string; text: string };

/** Parse r.jina.ai's plain-text envelope (Title / URL Source / Markdown Content). */
export function parseJinaReader(body: string): JinaReadResult {
  const header = body.split(/\nMarkdown Content:\n/, 2);
  const meta = header.length === 2 ? header[0]! : "";
  const text = (header.length === 2 ? header[1]! : body).trim();
  const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(meta)?.[1]?.trim();
  return {
    title: field("Title"),
    url: field("URL Source"),
    published: field("Published Time"),
    text,
  };
}

export async function readViaJina(url: string, timeoutMs: number): Promise<JinaReadResult> {
  const res = await fetch(`${JINA_READER_BASE}${url}`, {
    headers: { Accept: "text/plain", "User-Agent": BOT_USER_AGENT },
    signal: withTimeout(undefined, timeoutMs),
  });
  if (!res.ok) {
    const detail = (await readResponseText(res)).slice(0, 300);
    throw new Error(`Jina Reader ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  const parsed = parseJinaReader(await res.text());
  if (!parsed.text) throw new Error("Jina Reader returned no content");
  return parsed;
}

// ─── web_search: keyless chain ───────────────────────────────────────────────

export type KeylessSearchResult = {
  title: string;
  url: string;
  description: string;
  published?: string;
  siteName?: string;
};

/** Read a JSON-RPC reply that may arrive as plain JSON or one SSE `data:` frame. */
function parseMcpReply(body: string): Record<string, unknown> | null {
  const trimmed = body.trim();
  const candidates = trimmed.startsWith("{")
    ? [trimmed]
    : trimmed
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed)) {
        return parsed;
      }
    } catch {
      // not JSON; keep looking
    }
  }
  return null;
}

/** Exa's MCP text payload: blocks of `Title: / URL: / Published: / Highlights:` split by `---`. */
export function parseExaText(text: string): KeylessSearchResult[] {
  const out: KeylessSearchResult[] = [];
  for (const block of text.split(/\n-{3,}\n/)) {
    const url = /^URL:\s*(\S+)/m.exec(block)?.[1];
    if (!isHttpUrl(url)) continue;
    const title = /^Title:\s*(.+)$/m.exec(block)?.[1]?.trim() ?? url;
    const publishedRaw = /^Published(?: Date)?:\s*(.+)$/m.exec(block)?.[1]?.trim();
    const published = publishedRaw && publishedRaw !== "N/A" ? publishedRaw : undefined;
    const body = block.split(/^(?:Highlights|Text|Summary):\s*$/m)[1] ?? "";
    const description = body.replace(/\s+/g, " ").trim().slice(0, 500);
    out.push({ title, url, description, published, siteName: siteName(url) });
  }
  return out;
}

let exaRequestId = 0;

/**
 * Exa's hosted MCP server answers stateless `tools/call` requests with no key
 * (the same endpoint agent-reach reaches through mcporter).
 */
export async function searchExaMcp(
  query: string,
  count: number,
  timeoutMs: number,
): Promise<KeylessSearchResult[]> {
  const endpoint = process.env.INFINIBOT_EXA_MCP_URL?.trim() || EXA_MCP_URL;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": BOT_USER_AGENT,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++exaRequestId,
      method: "tools/call",
      params: {
        name: "web_search_exa",
        arguments: {
          query,
          numResults: count,
          objective: `Find the most relevant, authoritative pages for: ${query}`,
        },
      },
    }),
    signal: withTimeout(undefined, timeoutMs),
  });
  if (!res.ok) throw new Error(`Exa MCP ${res.status}`);
  const reply = parseMcpReply(await res.text());
  if (!reply) throw new Error("Exa MCP: unreadable reply");
  if (reply.error) throw new Error(`Exa MCP: ${JSON.stringify(reply.error).slice(0, 200)}`);
  const result = reply.result as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  if (result?.isError)
    throw new Error(`Exa MCP: ${result.content?.[0]?.text?.slice(0, 200) ?? "error"}`);
  const text = (result?.content ?? [])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n---\n");
  return parseExaText(text).slice(0, count);
}

/** DuckDuckGo HTML endpoint: links come wrapped as `//duckduckgo.com/l/?uddg=<url>`. */
export function parseDuckDuckGoHtml(html: string): KeylessSearchResult[] {
  const out: KeylessSearchResult[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1);
  for (const block of blocks) {
    const link = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(
      block,
    );
    if (!link) continue;
    let href = decodeHtml(link[1]!);
    const uddg = /[?&]uddg=([^&]+)/.exec(href)?.[1];
    if (uddg) href = decodeURIComponent(uddg);
    else if (href.startsWith("//")) href = `https:${href}`;
    if (!isHttpUrl(href) || /duckduckgo\.com\/y\.js/.test(href)) continue; // skip ads
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(block);
    out.push({
      title: stripHtml(link[2]!),
      url: href,
      description: snippet ? stripHtml(snippet[1]!) : "",
      siteName: siteName(href),
    });
  }
  return out;
}

export async function searchDuckDuckGoHtml(
  query: string,
  count: number,
  timeoutMs: number,
): Promise<KeylessSearchResult[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": BROWSER_USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
    },
    body: new URLSearchParams({ q: query, b: "" }).toString(),
    signal: withTimeout(undefined, timeoutMs),
  });
  // DDG answers bot-suspect clients with 202 + a challenge page.
  if (res.status !== 200) throw new Error(`DuckDuckGo HTML ${res.status} (likely rate-limited)`);
  return parseDuckDuckGoHtml(await res.text()).slice(0, count);
}

/** Bing wraps result links as /ck/a?…&u=a1<base64url(target)>. */
function unwrapBingLink(href: string): string {
  const u = /[?&]u=a1([^&]+)/.exec(href)?.[1];
  if (!u) return href;
  try {
    const decoded = Buffer.from(u.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return isHttpUrl(decoded) ? decoded : href;
  } catch {
    return href;
  }
}

export function parseBingHtml(html: string): KeylessSearchResult[] {
  const out: KeylessSearchResult[] = [];
  for (const match of html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)) {
    const block = match[0];
    const link = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const url = unwrapBingLink(decodeHtml(link[1]!));
    if (!isHttpUrl(url)) continue;
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    out.push({
      title: stripHtml(link[2]!),
      url,
      description: snippet ? stripHtml(snippet[1]!) : "",
      siteName: siteName(url),
    });
  }
  return out;
}

/**
 * Bing serves unrelated filler to clients it suspects are bots; keep only
 * results that mention at least one meaningful query term.
 */
export function filterRelevant(
  query: string,
  results: KeylessSearchResult[],
): KeylessSearchResult[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3);
  const unique = [...new Set(terms)];
  if (unique.length === 0) return results;
  // One shared word ("agent") is not enough: filler pages match common terms.
  const needed = unique.length <= 2 ? unique.length : Math.ceil(unique.length / 2);
  return results.filter((r) => {
    const hay = `${r.title} ${r.description} ${r.url}`.toLowerCase();
    return unique.filter((t) => hay.includes(t)).length >= needed;
  });
}

export async function searchBingHtml(
  query: string,
  count: number,
  timeoutMs: number,
): Promise<KeylessSearchResult[]> {
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("setlang", "en");
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
    signal: withTimeout(undefined, timeoutMs),
  });
  if (!res.ok) throw new Error(`Bing ${res.status}`);
  return filterRelevant(query, parseBingHtml(await res.text())).slice(0, count);
}

async function searchDuckDuckGoInstant(
  query: string,
  count: number,
  timeoutMs: number,
): Promise<KeylessSearchResult[]> {
  const sources = await fetchDuckDuckGo(query, timeoutMs);
  return sources.slice(0, count).map((entry) => ({
    title: entry.title,
    url: entry.url,
    description: entry.snippet,
    published: entry.publishedAt,
    siteName: siteName(entry.url),
  }));
}

/** Exa occasionally drops a request; one retry beats falling to a weaker engine. */
async function searchExaMcpWithRetry(
  query: string,
  count: number,
  timeoutMs: number,
): Promise<KeylessSearchResult[]> {
  try {
    const first = await searchExaMcp(query, count, timeoutMs);
    if (first.length > 0) return first;
  } catch {
    // retry once below
  }
  return searchExaMcp(query, count, timeoutMs);
}

type SearchSource = {
  id: string;
  run: (query: string, count: number, timeoutMs: number) => Promise<KeylessSearchResult[]>;
};

export const KEYLESS_SEARCH_SOURCES: readonly SearchSource[] = [
  { id: "exa", run: searchExaMcpWithRetry },
  { id: "duckduckgo-html", run: searchDuckDuckGoHtml },
  { id: "bing", run: searchBingHtml },
  { id: "duckduckgo", run: searchDuckDuckGoInstant },
];

export type KeylessSearchOutcome = {
  provider: string;
  results: KeylessSearchResult[];
  attempts: SourceAttempt[];
};

/** First keyless source that returns results wins; failures fall through. */
export async function keylessWebSearch(params: {
  query: string;
  count: number;
  timeoutMs: number;
  sources?: readonly SearchSource[];
}): Promise<KeylessSearchOutcome> {
  const attempts: SourceAttempt[] = [];
  for (const source of params.sources ?? KEYLESS_SEARCH_SOURCES) {
    try {
      const results = await source.run(params.query, params.count, params.timeoutMs);
      attempts.push({ source: source.id, count: results.length });
      if (results.length > 0) return { provider: source.id, results, attempts };
    } catch (err) {
      attempts.push({ source: source.id, error: errText(err) });
    }
  }
  return { provider: "none", results: [], attempts };
}

// ─── web_image_search ────────────────────────────────────────────────────────

export type ImageResult = {
  url: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  title?: string;
  sourcePage?: string;
  source: string;
  license?: string;
  creator?: string;
};

export type ImageSearchOptions = { query: string; count: number; timeoutMs: number; safe: boolean };

/** Bing Images: each result's `m` attribute is HTML-escaped JSON with murl/turl/purl/t. */
export function parseBingImages(html: string): ImageResult[] {
  const out: ImageResult[] = [];
  for (const match of html.matchAll(/\bm="(\{[^"]*\})"/g)) {
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(decodeHtml(match[1]!)) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!isHttpUrl(meta.murl)) continue;
    out.push({
      url: meta.murl,
      source: "bing",
      ...(isHttpUrl(meta.turl) ? { thumbnailUrl: meta.turl } : {}),
      ...(isHttpUrl(meta.purl) ? { sourcePage: meta.purl } : {}),
      ...(typeof meta.t === "string" ? { title: stripHtml(meta.t) } : {}),
    });
  }
  return out;
}

async function imagesBing(opts: ImageSearchOptions): Promise<ImageResult[]> {
  const url = new URL("https://www.bing.com/images/async");
  url.searchParams.set("q", opts.query);
  url.searchParams.set("first", "0");
  url.searchParams.set("count", String(Math.min(50, Math.max(opts.count * 2, 20))));
  url.searchParams.set("mmasync", "1");
  url.searchParams.set("adlt", opts.safe ? "strict" : "off");
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
    signal: withTimeout(undefined, opts.timeoutMs),
  });
  if (!res.ok) throw new Error(`Bing Images ${res.status}`);
  return parseBingImages(await res.text());
}

async function imagesDuckDuckGo(opts: ImageSearchOptions): Promise<ImageResult[]> {
  const headers = { "User-Agent": BROWSER_USER_AGENT, "Accept-Language": "en-US,en;q=0.9" };
  const page = await fetch(
    `https://duckduckgo.com/?q=${encodeURIComponent(opts.query)}&iax=images&ia=images`,
    { headers, signal: withTimeout(undefined, opts.timeoutMs) },
  );
  const vqd = /vqd=["']?([\d-]+)/.exec(await page.text())?.[1];
  if (!vqd) throw new Error("DuckDuckGo Images: no vqd token");
  const url = new URL("https://duckduckgo.com/i.js");
  url.searchParams.set("o", "json");
  url.searchParams.set("q", opts.query);
  url.searchParams.set("l", "us-en");
  url.searchParams.set("vqd", vqd);
  url.searchParams.set("p", opts.safe ? "1" : "-1");
  const res = await fetch(url, {
    headers: { ...headers, Referer: "https://duckduckgo.com/", Accept: "application/json" },
    signal: withTimeout(undefined, opts.timeoutMs),
  });
  if (!res.ok) throw new Error(`DuckDuckGo Images ${res.status}`);
  const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
  return (data.results ?? []).flatMap((r) =>
    isHttpUrl(r.image)
      ? [
          {
            url: r.image,
            source: "duckduckgo",
            ...(isHttpUrl(r.thumbnail) ? { thumbnailUrl: r.thumbnail } : {}),
            ...(isHttpUrl(r.url) ? { sourcePage: r.url } : {}),
            ...(typeof r.title === "string" ? { title: r.title } : {}),
            ...(typeof r.width === "number" ? { width: r.width } : {}),
            ...(typeof r.height === "number" ? { height: r.height } : {}),
          },
        ]
      : [],
  );
}

async function imagesOpenverse(opts: ImageSearchOptions): Promise<ImageResult[]> {
  const url = new URL("https://api.openverse.org/v1/images/");
  url.searchParams.set("q", opts.query);
  url.searchParams.set("page_size", String(Math.min(20, opts.count)));
  if (opts.safe) url.searchParams.set("mature", "false");
  const res = await fetch(url, {
    headers: { "User-Agent": BOT_USER_AGENT, Accept: "application/json" },
    signal: withTimeout(undefined, opts.timeoutMs),
  });
  if (!res.ok) throw new Error(`Openverse ${res.status}`);
  const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
  return (data.results ?? []).flatMap((r) =>
    isHttpUrl(r.url)
      ? [
          {
            url: r.url,
            source: "openverse",
            ...(isHttpUrl(r.thumbnail) ? { thumbnailUrl: r.thumbnail } : {}),
            ...(isHttpUrl(r.foreign_landing_url) ? { sourcePage: r.foreign_landing_url } : {}),
            ...(typeof r.title === "string" ? { title: r.title } : {}),
            ...(typeof r.width === "number" ? { width: r.width } : {}),
            ...(typeof r.height === "number" ? { height: r.height } : {}),
            ...(typeof r.license === "string"
              ? {
                  license: `cc-${r.license}${typeof r.license_version === "string" ? ` ${r.license_version}` : ""}`,
                }
              : {}),
            ...(typeof r.creator === "string" ? { creator: r.creator } : {}),
          },
        ]
      : [],
  );
}

async function imagesWikimedia(opts: ImageSearchOptions): Promise<ImageResult[]> {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.search = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `${opts.query} filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: String(Math.min(20, opts.count)),
    prop: "imageinfo",
    iiprop: "url|size|mime",
    iiurlwidth: "800",
  }).toString();
  const res = await fetch(url, {
    headers: { "User-Agent": BOT_USER_AGENT, Accept: "application/json" },
    signal: withTimeout(undefined, opts.timeoutMs),
  });
  if (!res.ok) throw new Error(`Wikimedia Commons ${res.status}`);
  const data = (await res.json()) as {
    query?: {
      pages?: Record<
        string,
        { title?: string; index?: number; imageinfo?: Array<Record<string, unknown>> }
      >;
    };
  };
  return Object.values(data.query?.pages ?? {})
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .flatMap((page) => {
      const info = page.imageinfo?.[0];
      if (!info || !isHttpUrl(info.url)) return [];
      return [
        {
          url: info.url,
          source: "wikimedia",
          ...(isHttpUrl(info.thumburl) ? { thumbnailUrl: info.thumburl } : {}),
          ...(isHttpUrl(info.descriptionurl) ? { sourcePage: info.descriptionurl } : {}),
          ...(page.title ? { title: page.title.replace(/^File:/, "") } : {}),
          ...(typeof info.width === "number" ? { width: info.width } : {}),
          ...(typeof info.height === "number" ? { height: info.height } : {}),
          license: "see sourcePage (Wikimedia Commons)",
        },
      ];
    });
}

type ImageSource = { id: string; run: (opts: ImageSearchOptions) => Promise<ImageResult[]> };

export const KEYLESS_IMAGE_SOURCES: readonly ImageSource[] = [
  { id: "bing", run: imagesBing },
  { id: "duckduckgo", run: imagesDuckDuckGo },
  { id: "openverse", run: imagesOpenverse },
  { id: "wikimedia", run: imagesWikimedia },
];

/** Hosts whose image URLs are login-walled, expiring, or not the image itself. */
const UNUSABLE_IMAGE_HOSTS =
  /(^|\.)(lookaside\.fbsbx\.com|lookaside\.instagram\.com|x\.com|twitter\.com|tiktok\.com)$/i;

/** Fills `count` from the sources in order, de-duplicating by URL. */
export async function keylessImageSearch(
  opts: ImageSearchOptions & { sources?: readonly ImageSource[] },
): Promise<{ providers: string[]; results: ImageResult[]; attempts: SourceAttempt[] }> {
  const attempts: SourceAttempt[] = [];
  const seen = new Set<string>();
  const results: ImageResult[] = [];
  const providers: string[] = [];
  for (const source of opts.sources ?? KEYLESS_IMAGE_SOURCES) {
    if (results.length >= opts.count) break;
    try {
      const found = await source.run(opts);
      let added = 0;
      for (const item of found) {
        if (results.length >= opts.count) break;
        const host = siteName(item.url) ?? "";
        if (seen.has(item.url) || UNUSABLE_IMAGE_HOSTS.test(host)) continue;
        seen.add(item.url);
        results.push(item);
        added += 1;
      }
      attempts.push({ source: source.id, count: added });
      if (added > 0) providers.push(source.id);
    } catch (err) {
      attempts.push({ source: source.id, error: errText(err) });
    }
  }
  return { providers, results, attempts };
}

/** HEAD-check that a URL really serves an image (falls back to a 1-byte GET). */
export async function verifyImageUrl(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; contentType?: string }> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          ...(method === "GET" ? { Range: "bytes=0-0" } : {}),
        },
        redirect: "follow",
        signal: withTimeout(undefined, timeoutMs),
      });
      void res.body?.cancel();
      const contentType = res.headers.get("content-type") ?? undefined;
      if (res.ok && contentType?.startsWith("image/")) return { ok: true, contentType };
      if (method === "GET") return { ok: false, contentType };
    } catch {
      if (method === "GET") return { ok: false };
    }
  }
  return { ok: false };
}

// ─── system binaries ─────────────────────────────────────────────────────────

export type ExecResult = { stdout: string; stderr: string };

export function runBinary(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; cwd?: string },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: opts.timeoutMs, cwd: opts.cwd, maxBuffer: 32 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || "")
            .trim()
            .split("\n")
            .slice(-3)
            .join(" ");
          reject(Object.assign(error, { detail }));
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

const binaryCache = new Map<string, boolean>();

export async function hasBinary(bin: string): Promise<boolean> {
  const cached = binaryCache.get(bin);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    await runBinary(bin, ["--version"], { timeoutMs: 5_000 });
    ok = true;
  } catch {
    // ENOENT (not installed), or broken enough that `--version` fails
  }
  binaryCache.set(bin, ok);
  return ok;
}

export function __resetBinaryCacheForTests() {
  binaryCache.clear();
}

// ─── youtube_transcript ──────────────────────────────────────────────────────

/** WebVTT → plain text: drop cue timings/tags and the rolling duplicate lines auto-subs repeat. */
export function vttToText(vtt: string): string {
  const lines: string[] = [];
  for (const raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "WEBVTT" || /^(Kind|Language|NOTE|STYLE)\b/.test(line)) continue;
    if (/-->/.test(line) || /^\d+$/.test(line)) continue;
    const text = stripHtml(line.replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, ""));
    if (text && lines[lines.length - 1] !== text) lines.push(text);
  }
  return lines.join("\n");
}

export async function youtubeTranscript(params: {
  url: string;
  lang: string;
  timeoutMs: number;
}): Promise<{ title?: string; language?: string; text: string }> {
  if (!(await hasBinary("yt-dlp"))) {
    throw new Error(
      "yt-dlp is not installed on this host. Install it (e.g. `pipx install yt-dlp`) to enable transcripts; web_read on the video URL still returns the page description.",
    );
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ib-yt-"));
  try {
    let title: string | undefined;
    let failure: unknown;
    try {
      const { stdout } = await runBinary(
        "yt-dlp",
        [
          "--skip-download",
          "--write-subs",
          "--write-auto-subs",
          // Exact language (+ YouTube's "-orig" track). A wildcard like "en.*"
          // also pulls machine-translated tracks, which YouTube rate-limits.
          "--sub-langs",
          `${params.lang},${params.lang}-orig`,
          "--sub-format",
          "vtt",
          "--no-playlist",
          "--ignore-errors",
          "--no-update",
          "--print",
          "title",
          "--no-simulate",
          "-o",
          "%(id)s.%(ext)s",
          params.url,
        ],
        { timeoutMs: params.timeoutMs, cwd: dir },
      );
      title = stdout.trim().split("\n")[0] || undefined;
    } catch (err) {
      // One subtitle track failing still leaves the others on disk.
      failure = err;
    }
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".vtt")).sort();
    const file =
      files.find((f) => f.endsWith(`.${params.lang}.vtt`)) ??
      files.find((f) => f.endsWith(`.${params.lang}-orig.vtt`)) ??
      files[0];
    if (!file) {
      if (failure) throw failure;
      throw new Error(`No ${params.lang} subtitles or auto-captions for this video.`);
    }
    const text = vttToText(await fs.readFile(path.join(dir, file), "utf8"));
    const language = /\.([\w-]+)\.vtt$/.exec(file)?.[1];
    return { title, language, text };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── github_read ─────────────────────────────────────────────────────────────

export type GithubTarget =
  | { kind: "repo"; owner: string; repo: string }
  | { kind: "file"; owner: string; repo: string; path: string; ref?: string }
  | { kind: "issue"; owner: string; repo: string; number: number };

/** Accepts github.com URLs, `owner/repo`, `owner/repo/path`, `owner/repo#123`. */
export function parseGithubTarget(input: string): GithubTarget | null {
  let value = input.trim();
  const hash = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(value);
  if (hash) return { kind: "issue", owner: hash[1]!, repo: hash[2]!, number: Number(hash[3]) };
  let ref: string | undefined;
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    if (url.hostname === "raw.githubusercontent.com") {
      const [owner, repo, rawRef, ...rest] = url.pathname.split("/").filter(Boolean);
      if (!owner || !repo || !rawRef || rest.length === 0) return null;
      return { kind: "file", owner, repo, ref: rawRef, path: rest.join("/") };
    }
    if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const [owner, repo, kind, ...rest] = parts;
    if (!owner || !repo) return null;
    const cleanRepo = repo.replace(/\.git$/, "");
    if ((kind === "issues" || kind === "pull") && /^\d+$/.test(rest[0] ?? "")) {
      return { kind: "issue", owner, repo: cleanRepo, number: Number(rest[0]) };
    }
    if ((kind === "blob" || kind === "tree") && rest.length >= 1) {
      ref = rest[0];
      const filePath = rest.slice(1).join("/");
      if (kind === "blob" && filePath)
        return { kind: "file", owner, repo: cleanRepo, path: filePath, ref };
      return { kind: "repo", owner, repo: cleanRepo };
    }
    value = `${owner}/${cleanRepo}`;
  }
  const parts = value.split("/").filter(Boolean);
  if (parts.length < 2 || !/^[\w.-]+$/.test(parts[0]!) || !/^[\w.-]+$/.test(parts[1]!)) return null;
  if (parts.length === 2) return { kind: "repo", owner: parts[0]!, repo: parts[1]! };
  return { kind: "file", owner: parts[0]!, repo: parts[1]!, path: parts.slice(2).join("/"), ref };
}

/** GET a GitHub REST path through `gh api` (uses the user's login) or anonymously. */
export async function githubApi(
  apiPath: string,
  opts: { raw?: boolean; timeoutMs: number; useGh: boolean },
): Promise<{ body: string; via: "gh" | "rest" }> {
  const accept = opts.raw ? "application/vnd.github.raw" : "application/vnd.github+json";
  if (opts.useGh) {
    try {
      const { stdout } = await runBinary("gh", ["api", "-H", `Accept: ${accept}`, apiPath], {
        timeoutMs: opts.timeoutMs,
      });
      return { body: stdout, via: "gh" };
    } catch {
      // gh missing auth or rate-limited; fall through to anonymous REST
    }
  }
  const res = await fetch(`https://api.github.com/${apiPath.replace(/^\//, "")}`, {
    headers: { Accept: accept, "User-Agent": BOT_USER_AGENT, "X-GitHub-Api-Version": "2022-11-28" },
    signal: withTimeout(undefined, opts.timeoutMs),
  });
  if (!res.ok) {
    const detail = (await readResponseText(res)).slice(0, 200);
    throw new Error(`GitHub API ${res.status} for ${apiPath}${detail ? `: ${detail}` : ""}`);
  }
  return { body: await res.text(), via: "rest" };
}

// ─── rss_read ────────────────────────────────────────────────────────────────

export type FeedItem = { title: string; link?: string; published?: string; summary?: string };

function tagText(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (!m) return undefined;
  const inner = m[1]!.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
  const text = stripHtml(inner);
  return text || undefined;
}

/** Tolerant RSS 2.0 / RSS 1.0 / Atom parser — enough for headlines and links. */
export function parseFeed(xml: string): { title?: string; items: FeedItem[] } {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const itemTag = isAtom ? "entry" : "item";
  const items: FeedItem[] = [];
  for (const match of xml.matchAll(new RegExp(`<${itemTag}[\\s>][\\s\\S]*?</${itemTag}>`, "gi"))) {
    const block = match[0];
    let link: string | undefined;
    if (isAtom) {
      const alt =
        /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(block) ??
        /<link[^>]*href=["']([^"']+)["']/i.exec(block);
      link = alt ? decodeHtml(alt[1]!) : undefined;
    } else {
      link = tagText(block, "link") ?? tagText(block, "guid");
    }
    items.push({
      title: tagText(block, "title") ?? "(untitled)",
      ...(link && isHttpUrl(link) ? { link } : {}),
      published:
        tagText(block, "pubDate") ??
        tagText(block, "published") ??
        tagText(block, "updated") ??
        tagText(block, "dc:date"),
      summary:
        (
          tagText(block, "description") ??
          tagText(block, "summary") ??
          tagText(block, "content") ??
          ""
        ).slice(0, 400) || undefined,
    });
  }
  const head = xml.split(new RegExp(`<${itemTag}[\\s>]`, "i"))[0] ?? "";
  return { title: tagText(head, "title"), items };
}

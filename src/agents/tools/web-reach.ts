/**
 * Keyless web-reach tools: web_read, web_image_search, youtube_transcript,
 * github_read, rss_read. They need no API key, no config and no login, so every
 * agent can use them out of the box. Sources and fallback chains live in
 * web-reach-sources.ts. Keyless web_search is the existing tool in
 * web-search.ts, which uses the same chain when no keyed provider is set.
 *
 * Optional logins (X/Twitter, Reddit, LinkedIn cookies, as in agent-reach) are
 * future work and never required.
 */

import { Type } from "@sinclair/typebox";

import type { InfinibotConfig } from "../../config/config.js";
import {
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostname,
} from "../../infra/net/ssrf.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import { fetchReadableDirect } from "./web-fetch.js";
import { truncateText } from "./web-fetch-utils.js";
import {
  githubApi,
  hasBinary,
  keylessImageSearch,
  parseFeed,
  parseGithubTarget,
  readViaJina,
  verifyImageUrl,
  youtubeTranscript,
  type SourceAttempt,
} from "./web-reach-sources.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  withTimeout,
  writeCache,
} from "./web-shared.js";

export const WEB_REACH_TOOL_NAMES = [
  "web_read",
  "web_image_search",
  "youtube_transcript",
  "github_read",
  "rss_read",
] as const;

const DEFAULT_READ_MAX_CHARS = 40_000;
const READ_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const IMAGE_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const CACHE_TTL_MS = resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES);

function boolParam(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = params[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

/** http(s) only, and never a private/internal host (also keeps intranet URLs away from Jina). */
async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Invalid URL: must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Invalid URL: must be http or https");
  }
  await resolvePinnedHostname(url.hostname);
  return url;
}

/** GET with manual redirects; every hop is SSRF-checked and DNS-pinned. */
async function fetchPublicText(
  rawUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ status: number; body: string; finalUrl: string }> {
  const signal = withTimeout(undefined, timeoutMs);
  let current = rawUrl;
  for (let hop = 0; hop <= 3; hop += 1) {
    const url = new URL(current);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Invalid URL: must be http or https");
    }
    const dispatcher = createPinnedDispatcher(await resolvePinnedHostname(url.hostname));
    try {
      const res = await fetch(url, {
        headers,
        signal,
        redirect: "manual",
        dispatcher,
      } as RequestInit);
      const location = res.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(res.status) && location) {
        void res.body?.cancel();
        current = new URL(location, url).toString();
        continue;
      }
      return { status: res.status, body: await readResponseText(res), finalUrl: current };
    } finally {
      await closeDispatcher(dispatcher);
    }
  }
  throw new Error("Too many redirects (limit: 3)");
}

// ─── web_read ────────────────────────────────────────────────────────────────

const READ_VIA = ["auto", "jina", "direct"] as const;

const WebReadSchema = Type.Object({
  url: Type.String({ description: "Public http(s) URL to read." }),
  maxChars: Type.Optional(
    Type.Number({ description: "Maximum characters to return (default 40000).", minimum: 200 }),
  ),
  via: Type.Optional(
    stringEnum(READ_VIA, {
      description:
        'Reader: "auto" (Jina Reader, then direct fetch), "jina" or "direct". Default auto.',
    }),
  ),
});

export function createWebReadTool(): AnyAgentTool {
  return {
    label: "Web Read",
    name: "web_read",
    description:
      "Read any public web page as clean markdown, with no API key. Uses Jina Reader (renders JS-heavy pages, strips nav/ads) and falls back to a direct fetch with Readability. Use it to open a search result, article, docs page or listing.",
    parameters: WebReadSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const rawUrl = readStringParam(params, "url", { required: true });
      const maxChars = Math.max(
        200,
        readNumberParam(params, "maxChars", { integer: true }) ?? DEFAULT_READ_MAX_CHARS,
      );
      const via = (readStringParam(params, "via") ?? "auto") as (typeof READ_VIA)[number];
      const url = (await assertPublicHttpUrl(rawUrl)).toString();

      const cacheKey = normalizeCacheKey(`read:${via}:${url}:${maxChars}`);
      const cached = readCache(READ_CACHE, cacheKey);
      if (cached) return jsonResult({ ...cached.value, cached: true });

      const start = Date.now();
      const attempts: SourceAttempt[] = [];
      if (via !== "direct") {
        try {
          const page = await readViaJina(url, DEFAULT_TIMEOUT_SECONDS * 1000);
          const truncated = truncateText(page.text, maxChars);
          const payload = {
            url,
            finalUrl: page.url ?? url,
            title: page.title,
            published: page.published,
            extractor: "jina-reader",
            truncated: truncated.truncated,
            length: truncated.text.length,
            tookMs: Date.now() - start,
            text: truncated.text,
          };
          writeCache(READ_CACHE, cacheKey, payload, CACHE_TTL_MS);
          return jsonResult(payload);
        } catch (err) {
          attempts.push({
            source: "jina-reader",
            error: err instanceof Error ? err.message : String(err),
          });
          if (via === "jina") throw err;
        }
      }
      const direct = await fetchReadableDirect({ url, maxChars });
      const payload = {
        ...direct,
        extractor: `direct-${typeof direct.extractor === "string" ? direct.extractor : "raw"}`,
        ...(attempts.length ? { attempts } : {}),
      };
      writeCache(READ_CACHE, cacheKey, payload, CACHE_TTL_MS);
      return jsonResult(payload);
    },
  };
}

// ─── web_image_search ────────────────────────────────────────────────────────

const ORIENTATIONS = ["any", "portrait", "landscape", "square"] as const;

const WebImageSearchSchema = Type.Object({
  query: Type.String({ description: "What the image should show." }),
  count: Type.Optional(
    Type.Number({ description: "Number of images (1-30, default 10).", minimum: 1, maximum: 30 }),
  ),
  orientation: Type.Optional(
    stringEnum(ORIENTATIONS, {
      description: "Prefer portrait/landscape/square results when sizes are known. Default any.",
    }),
  ),
  safe: Type.Optional(Type.Boolean({ description: "Safe search (default true)." })),
  verify: Type.Optional(
    Type.Boolean({
      description:
        "Check each URL really serves an image (slower, one HEAD request each). Default false.",
    }),
  ),
});

function orientationOf(w?: number, h?: number): (typeof ORIENTATIONS)[number] | undefined {
  if (!w || !h) return undefined;
  const ratio = w / h;
  if (ratio > 1.15) return "landscape";
  if (ratio < 0.87) return "portrait";
  return "square";
}

export function createWebImageSearchTool(): AnyAgentTool {
  return {
    label: "Web Image Search",
    name: "web_image_search",
    description:
      "Find images on the web with no API key. Returns direct full-size image URLs (plus thumbnail, source page, size and license when known) from Bing Images, DuckDuckGo Images, Openverse and Wikimedia Commons. Use it for reference images, product shots, logos or visual research.",
    parameters: WebImageSearchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count = Math.max(
        1,
        Math.min(30, readNumberParam(params, "count", { integer: true }) ?? 10),
      );
      const orientation = (readStringParam(params, "orientation") ??
        "any") as (typeof ORIENTATIONS)[number];
      const safe = boolParam(params, "safe", true);
      const verify = boolParam(params, "verify", false);

      const cacheKey = normalizeCacheKey(`img:${query}:${count}:${orientation}:${safe}:${verify}`);
      const cached = readCache(IMAGE_CACHE, cacheKey);
      if (cached) return jsonResult({ ...cached.value, cached: true });

      const start = Date.now();
      // Over-fetch so orientation filtering / failed verification still fill `count`.
      const wanted = orientation === "any" && !verify ? count : Math.min(60, count * 3);
      const found = await keylessImageSearch({
        query,
        count: wanted,
        safe,
        timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
      });
      let results = found.results;
      if (orientation !== "any") {
        // Keep unknown-size images, but rank matching ones first.
        const matching = results.filter((r) => orientationOf(r.width, r.height) === orientation);
        const unknown = results.filter((r) => !orientationOf(r.width, r.height));
        results = [...matching, ...unknown];
      }
      if (verify) {
        const checked = await Promise.all(
          results.slice(0, count * 2).map(async (r) => {
            const isPublic = await assertPublicHttpUrl(r.url).then(
              () => true,
              () => false,
            );
            if (!isPublic) return null;
            const v = await verifyImageUrl(r.url, 8_000);
            return v.ok ? { ...r, contentType: v.contentType } : null;
          }),
        );
        results = checked.filter((r): r is NonNullable<typeof r> => r !== null);
      }
      results = results.slice(0, count);
      const payload = {
        query,
        providers: found.providers,
        count: results.length,
        tookMs: Date.now() - start,
        results,
        ...(results.length === 0
          ? {
              attempts: found.attempts,
              note: "No keyless image source returned results. Try a simpler query, or use the browser tool on an image search page.",
            }
          : {}),
      };
      writeCache(IMAGE_CACHE, cacheKey, payload, CACHE_TTL_MS);
      return jsonResult(payload);
    },
  };
}

// ─── youtube_transcript ──────────────────────────────────────────────────────

const YoutubeTranscriptSchema = Type.Object({
  url: Type.String({ description: "Video URL (YouTube, or any site yt-dlp supports)." }),
  lang: Type.Optional(Type.String({ description: "Subtitle language code (default en)." })),
  maxChars: Type.Optional(
    Type.Number({ description: "Maximum characters to return (default 60000).", minimum: 200 }),
  ),
});

export function createYoutubeTranscriptTool(): AnyAgentTool {
  return {
    label: "YouTube Transcript",
    name: "youtube_transcript",
    description:
      "Get the transcript (subtitles or auto-captions) of a YouTube video, with no API key. Uses the host's yt-dlp; returns a clear error when yt-dlp is not installed.",
    parameters: YoutubeTranscriptSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const url = (
        await assertPublicHttpUrl(readStringParam(params, "url", { required: true }))
      ).toString();
      const lang = (readStringParam(params, "lang") ?? "en").replace(/[^\w-]/g, "") || "en";
      const maxChars = readNumberParam(params, "maxChars", { integer: true }) ?? 60_000;
      try {
        const result = await youtubeTranscript({ url, lang, timeoutMs: 120_000 });
        const truncated = truncateText(result.text, Math.max(200, maxChars));
        return jsonResult({
          url,
          title: result.title,
          language: result.language,
          extractor: "yt-dlp",
          truncated: truncated.truncated,
          length: truncated.text.length,
          text: truncated.text,
        });
      } catch (err) {
        const detail = (err as { detail?: string }).detail;
        return jsonResult({
          url,
          error: "transcript_unavailable",
          message: `${err instanceof Error ? err.message : String(err)}${detail ? ` (${detail})` : ""}`,
        });
      }
    },
  };
}

// ─── github_read ─────────────────────────────────────────────────────────────

const GithubReadSchema = Type.Object({
  target: Type.String({
    description:
      "GitHub URL or shorthand: owner/repo (metadata + README), owner/repo/path/to/file, owner/repo#123 (issue or PR with comments), or any github.com blob/issues/pull URL.",
  }),
  ref: Type.Optional(Type.String({ description: "Branch, tag or commit for file reads." })),
  maxChars: Type.Optional(
    Type.Number({ description: "Maximum characters to return (default 40000).", minimum: 200 }),
  ),
});

export function createGithubReadTool(): AnyAgentTool {
  return {
    label: "GitHub Read",
    name: "github_read",
    description:
      "Read public GitHub content (repo overview + README, a file, or an issue/PR with comments), with no setup. Uses the gh CLI when it is installed and logged in, otherwise the anonymous GitHub API (60 requests/hour).",
    parameters: GithubReadSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const raw = readStringParam(params, "target", { required: true });
      const target = parseGithubTarget(raw);
      if (!target) {
        return jsonResult({
          error: "invalid_target",
          message: `Not a GitHub repo, file or issue: ${raw}`,
        });
      }
      const maxChars = Math.max(
        200,
        readNumberParam(params, "maxChars", { integer: true }) ?? 40_000,
      );
      const opts = { timeoutMs: 30_000, useGh: await hasBinary("gh") };
      const repoPath = `repos/${target.owner}/${target.repo}`;

      if (target.kind === "repo") {
        const meta = JSON.parse((await githubApi(repoPath, opts)).body) as Record<string, unknown>;
        let readme = "";
        let via = "rest";
        try {
          const r = await githubApi(`${repoPath}/readme`, { ...opts, raw: true });
          readme = r.body;
          via = r.via;
        } catch {
          // repo without a README
        }
        const truncated = truncateText(readme, maxChars);
        return jsonResult({
          kind: "repo",
          repo: meta.full_name,
          description: meta.description,
          url: meta.html_url,
          stars: meta.stargazers_count,
          forks: meta.forks_count,
          language: meta.language,
          topics: meta.topics,
          defaultBranch: meta.default_branch,
          license: (meta.license as { spdx_id?: string } | null)?.spdx_id,
          pushedAt: meta.pushed_at,
          via,
          readme: truncated.text,
          truncated: truncated.truncated,
        });
      }

      if (target.kind === "file") {
        const ref = readStringParam(params, "ref") ?? target.ref;
        const filePath = target.path.split("/").map(encodeURIComponent).join("/");
        const apiPath = `${repoPath}/contents/${filePath}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
        const r = await githubApi(apiPath, { ...opts, raw: true });
        // A directory comes back as a JSON listing even with the raw Accept header.
        type DirEntry = { name?: string; type?: string; path?: string };
        let listing: DirEntry[] | null = null;
        try {
          const parsed = JSON.parse(r.body) as unknown;
          if (Array.isArray(parsed)) listing = parsed as DirEntry[];
        } catch {
          // file content, not JSON
        }
        if (listing) {
          return jsonResult({
            kind: "directory",
            repo: `${target.owner}/${target.repo}`,
            path: target.path,
            via: r.via,
            entries: listing.map((e) => ({ name: e.name, type: e.type, path: e.path })),
          });
        }
        const truncated = truncateText(r.body, maxChars);
        return jsonResult({
          kind: "file",
          repo: `${target.owner}/${target.repo}`,
          path: target.path,
          ref,
          via: r.via,
          truncated: truncated.truncated,
          length: truncated.text.length,
          text: truncated.text,
        });
      }

      const issue = JSON.parse(
        (await githubApi(`${repoPath}/issues/${target.number}`, opts)).body,
      ) as Record<string, unknown>;
      let comments: Array<Record<string, unknown>> = [];
      try {
        comments = JSON.parse(
          (await githubApi(`${repoPath}/issues/${target.number}/comments?per_page=50`, opts)).body,
        ) as Array<Record<string, unknown>>;
      } catch {
        // comments are best-effort
      }
      const login = (u: unknown) => (u as { login?: string } | null)?.login;
      const body = truncateText(typeof issue.body === "string" ? issue.body : "", maxChars);
      return jsonResult({
        kind: issue.pull_request ? "pull_request" : "issue",
        repo: `${target.owner}/${target.repo}`,
        number: target.number,
        title: issue.title,
        state: issue.state,
        author: login(issue.user),
        url: issue.html_url,
        createdAt: issue.created_at,
        labels: (issue.labels as Array<{ name?: string }> | undefined)?.map((l) => l.name),
        body: body.text,
        comments: comments.map((c) => ({
          author: login(c.user),
          createdAt: c.created_at,
          body: truncateText(typeof c.body === "string" ? c.body : "", 4_000).text,
        })),
      });
    },
  };
}

// ─── rss_read ────────────────────────────────────────────────────────────────

const RssReadSchema = Type.Object({
  url: Type.String({ description: "RSS or Atom feed URL." }),
  limit: Type.Optional(
    Type.Number({ description: "Max items (1-100, default 20).", minimum: 1, maximum: 100 }),
  ),
});

export function createRssReadTool(): AnyAgentTool {
  return {
    label: "RSS Read",
    name: "rss_read",
    description:
      "Read an RSS or Atom feed (news, blogs, podcasts, YouTube channel feeds, subreddit .rss) and return its latest items with title, link, date and summary. No key needed.",
    parameters: RssReadSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const url = (
        await assertPublicHttpUrl(readStringParam(params, "url", { required: true }))
      ).toString();
      const limit = Math.max(
        1,
        Math.min(100, readNumberParam(params, "limit", { integer: true }) ?? 20),
      );
      const res = await fetchPublicText(
        url,
        {
          Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
          "User-Agent": "InfiniBot/1.0 (+https://infinibotos.com; web-reach)",
        },
        DEFAULT_TIMEOUT_SECONDS * 1000,
      );
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Feed fetch failed (${res.status}): ${res.body.slice(0, 200)}`);
      }
      const feed = parseFeed(res.body);
      if (feed.items.length === 0) {
        return jsonResult({
          url,
          error: "not_a_feed",
          message: "No RSS/Atom items found at this URL. Use web_read for regular pages.",
        });
      }
      return jsonResult({
        url,
        title: feed.title,
        count: Math.min(limit, feed.items.length),
        items: feed.items.slice(0, limit),
      });
    },
  };
}

/** All keyless web-reach tools. `tools.deny` removes any of them as usual. */
export function createWebReachTools(_options?: { config?: InfinibotConfig }): AnyAgentTool[] {
  return [
    createWebReadTool(),
    createWebImageSearchTool(),
    createYoutubeTranscriptTool(),
    createGithubReadTool(),
    createRssReadTool(),
  ];
}

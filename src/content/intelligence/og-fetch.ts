/**
 * Open-Graph / link-preview metadata fetcher — content-intelligence local copy.
 *
 * This is a trimmed, dependency-free vendoring of the proven fetcher used by the
 * proactive `website` media kind (`src/proactive/og-fetch.ts` on branch
 * `feat/proactive-website-preview`). That canonical module is not yet on the
 * `feat/content-intelligence` branch, so rather than write a new scraper from
 * scratch we reuse the exact same `fetchOgMetadata` implementation here. If the
 * two branches later merge, dedupe to the shared module.
 *
 * Given a URL it fetches the page HTML (timeout + size cap + redirect follow)
 * and parses og:/twitter:/<title>/favicon tags into a flat shape. Best-effort:
 * a fetch failure resolves to `{ url, finalUrl, domain }` rather than throwing.
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("content-intel-og");

/** Parsed link-preview metadata. */
export interface OgMeta {
  url: string;
  /** URL after redirects (used to resolve relative image/favicon paths). */
  finalUrl: string;
  domain: string;
  title?: string;
  description?: string;
  /** Absolute og:image / twitter:image URL. */
  image?: string;
  /** Absolute favicon URL. */
  favicon?: string;
  siteName?: string;
}

const CACHE_TTL_MS = 30 * 60_000; // 30 min — link previews are slow-moving.
const FETCH_TIMEOUT_MS = 10_000; // a touch higher than website preview; IG is slow.
const MAX_BYTES = 1.5 * 1024 * 1024; // cap HTML we read (preview tags live in <head>).
// IMPORTANT: Instagram (and many Meta properties) STRIP og:/twitter: meta tags
// for ordinary browser User-Agents — a logged-out browser-UA request returns a
// 200 with full HTML but no og:image. They only emit link-preview tags for known
// crawler UAs. We therefore identify as facebookexternalhit, which is the UA the
// Meta link-unfurl crawler uses and which IG happily serves OG tags to.
const UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

const cache = new Map<string, { at: number; meta: OgMeta }>();

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Decode the small set of HTML entities that show up in title/description. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

/** Pull the `content` of the first <meta> whose property/name matches any key. */
function metaContent(html: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
      "i",
    );
    const tag = re.exec(html)?.[0];
    if (!tag) continue;
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (content && content.trim()) return decodeEntities(content.trim());
  }
  return undefined;
}

/** First <link rel="...icon..."> href, if any. */
function linkIconHref(html: string): string | undefined {
  const re = /<link[^>]+rel\s*=\s*["'][^"']*icon[^"']*["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
    if (href) return href;
  }
  return undefined;
}

function absolutize(maybeRelative: string | undefined, base: string): string | undefined {
  if (!maybeRelative) return undefined;
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return undefined;
  }
}

/**
 * Fetch + parse link-preview metadata for `url`. Cached for {@link CACHE_TTL_MS}.
 * Never throws — failures resolve to `{ url, finalUrl, domain }`.
 */
export async function fetchOgMetadata(url: string): Promise<OgMeta> {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.meta;

  const fallback: OgMeta = { url, finalUrl: url, domain: hostOf(url) };
  let meta: OgMeta = fallback;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: "follow",
        signal: ctrl.signal,
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
    } finally {
      clearTimeout(timer);
    }
    const finalUrl = res.url || url;
    const ct = res.headers.get("content-type") ?? "";
    if (res.ok && /text\/html|xml/i.test(ct)) {
      const buf = await res.arrayBuffer();
      const html = Buffer.from(buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf).toString(
        "utf8",
      );

      const titleTag = decodeEntities(
        /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "",
      );
      const title = metaContent(html, ["og:title", "twitter:title"]) ?? (titleTag || undefined);
      const description = metaContent(html, [
        "og:description",
        "twitter:description",
        "description",
      ]);
      const image = absolutize(
        metaContent(html, [
          "og:image:secure_url",
          "og:image",
          "twitter:image",
          "twitter:image:src",
        ]),
        finalUrl,
      );
      const siteName = metaContent(html, ["og:site_name", "application-name"]);
      const favicon =
        absolutize(linkIconHref(html), finalUrl) ?? absolutize("/favicon.ico", finalUrl);

      meta = {
        url,
        finalUrl,
        domain: hostOf(finalUrl),
        title,
        description,
        image,
        favicon,
        siteName,
      };
    } else {
      meta = {
        url,
        finalUrl,
        domain: hostOf(finalUrl),
        favicon: absolutize("/favicon.ico", finalUrl),
      };
    }
  } catch (e) {
    log.debug("og fetch failed", { url, err: e instanceof Error ? e.message : String(e) });
    meta = { ...fallback, favicon: absolutize("/favicon.ico", url) };
  }

  cache.set(url, { at: Date.now(), meta });
  return meta;
}

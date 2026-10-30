/**
 * content/trends — shared types for the Trends / Research / News intelligence
 * band. These shapes are the FROZEN contract returned by the
 * `content.trends.last30days` RPC and mirrored by the baked snapshot at
 * `ui/public/content-trends-snapshot.json` so the UI has a single render path
 * whether data comes from the live RPC or the static fallback.
 */

/** A single social-media insight (Reddit / forum / community signal). */
export interface SocialInsight {
  /** Stable id (hash of url) for dedupe + UI keying. */
  id: string;
  title: string;
  url: string;
  /** Short human summary / excerpt. */
  summary: string;
  /** Origin platform label, e.g. "reddit", "hackernews". */
  platform: string;
  /** Subreddit / community / channel the signal came from, if any. */
  community?: string;
  /** Engagement score (upvotes / points) used for ranking. */
  score: number;
  /** ISO date the item was published, if known. */
  publishedAt?: string;
}

/** A trending news topic relevant to the niche. */
export interface NewsTopic {
  id: string;
  title: string;
  url: string;
  summary: string;
  /** Publisher / source hostname, e.g. "techcrunch.com". */
  source: string;
  publishedAt?: string;
  /** Number of related articles clustered under this topic. */
  cluster: number;
}

/** A short-form content format that is trending across the gathered signal. */
export interface TrendingFormat {
  id: string;
  /** Format label, e.g. "POV", "Talking head", "Tutorial". */
  label: string;
  /** How many gathered items referenced this format. */
  mentions: number;
  /** A representative example title for the format. */
  example: string;
  /** Link to the representative example. */
  exampleUrl?: string;
}

/** The full payload returned for the /last30days window. */
export interface TrendsBundle {
  /** The niche keyword set this bundle was computed for. */
  niche: string;
  /** Free-text keywords derived/used for the queries. */
  keywords: string[];
  socialInsights: SocialInsight[];
  newsTopics: NewsTopic[];
  trendingFormats: TrendingFormat[];
  /** epoch ms when this bundle was generated. */
  generatedAt: number;
  /** How many upstream sources were consulted. */
  sourcesConsulted: number;
  /** Non-fatal warnings (a source timed out, etc.). */
  warnings: string[];
  /** "live" when freshly aggregated, "cache" when served from SQLite TTL. */
  origin?: "live" | "cache" | "snapshot";
}

export interface TrendsOptions {
  /** Override niche label (e.g. "fitness creators"). */
  niche?: string;
  /** Explicit keyword list; when omitted a default creator-marketing set is used. */
  keywords?: string[];
  /** Force a re-fetch ignoring the SQLite TTL cache. */
  force?: boolean;
  /** Per-source HTTP timeout budget (ms). */
  timeoutMs?: number;
}

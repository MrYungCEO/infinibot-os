/**
 * Viral-format framework — a standardized model of "a viral format" plus the
 * heuristic feature extractor and the top-format discovery routine.
 *
 * A "format" is the *reusable shape* of a winning piece of content, independent
 * of its specific topic: how it hooks, how it's structured, how fast it moves,
 * how long it runs, how it uses on-screen text, what it asks the viewer to do,
 * and the angle it takes on its topic. Two reels about completely different AI
 * tools can share one format ("bold-claim → 3-step demo → comment-keyword CTA").
 *
 * Everything here is pure and dependency-free so it can run inside the watcher,
 * the RPC layer, the agent tool, and unit tests identically.
 */

// ---------------------------------------------------------------------------
// Standardized enumerations
// ---------------------------------------------------------------------------

export const HOOK_ARCHETYPES = [
  "question", // "Did you know…", "What if…"
  "bold-claim", // "This AI replaces your whole team"
  "problem-callout", // "You're wasting 3 hours a day on…"
  "listicle", // "5 AI tools you need"
  "story-open", // "So last week I…"
  "contrarian", // "Everyone's wrong about…"
  "demo-reveal", // "Watch this build an app in 60s"
  "stat-shock", // "98% of people don't know…"
  "curiosity-gap", // "The one setting nobody uses"
  "warning", // "Stop using ChatGPT like this"
  "tutorial-promise", // "How to … in 60 seconds"
  "unknown",
] as const;
export type HookArchetype = (typeof HOOK_ARCHETYPES)[number];

export const PACING = ["slow", "medium", "fast", "rapid"] as const;
export type Pacing = (typeof PACING)[number];

export const LENGTH_BUCKETS = ["ultra-short", "short", "medium", "long"] as const;
export type LengthBucket = (typeof LENGTH_BUCKETS)[number];

export const TEXT_STYLES = [
  "none",
  "captions", // running subtitles
  "big-bold-keywords", // punched-in keyword overlays
  "kinetic", // animated word-by-word
  "minimal", // a single title card
  "unknown",
] as const;
export type OnScreenTextStyle = (typeof TEXT_STYLES)[number];

export const CTA_PATTERNS = [
  "follow",
  "comment-keyword", // "comment 'AI' and I'll send it"
  "save",
  "share",
  "link-in-bio",
  "subscribe",
  "none",
] as const;
export type CtaPattern = (typeof CTA_PATTERNS)[number];

export const TOPIC_ANGLES = [
  "tutorial",
  "review",
  "news",
  "opinion",
  "case-study",
  "entertainment",
  "inspiration",
  "comparison",
  "unknown",
] as const;
export type TopicAngle = (typeof TOPIC_ANGLES)[number];

/** The standardized feature vector extracted from a single piece of content. */
export interface ViralFormatFeatures {
  hookArchetype: HookArchetype;
  /** First-line hook text (clipped) for reference. */
  hookText: string;
  /** Beat-by-beat structure labels inferred from the body. */
  structureBeats: string[];
  pacing: Pacing;
  /** Words per second over the transcript (0 if unknown). */
  wordsPerSecond: number;
  lengthSec: number | null;
  lengthBucket: LengthBucket;
  onScreenTextStyle: OnScreenTextStyle;
  ctaPattern: CtaPattern;
  topicAngle: TopicAngle;
  /** Number of distinct sentences/beats — a rough structure-density signal. */
  beatCount: number;
}

/** Raw input the extractor understands (a superset of stores' row shapes). */
export interface FormatExtractionInput {
  transcript?: string | null;
  caption?: string | null;
  durationSec?: number | null;
  /** Optional hint that on-screen text is present (e.g. burned-in captions). */
  hasOnScreenText?: boolean | null;
}

// ---------------------------------------------------------------------------
// Heuristic extraction
// ---------------------------------------------------------------------------

function firstWords(s: string, n: number): string {
  return s.split(/\s+/).slice(0, n).join(" ");
}

function classifyHook(hook: string): HookArchetype {
  const h = hook.toLowerCase();
  if (/^\s*(how to|how i|here's how|the way to)/.test(h)) return "tutorial-promise";
  if (/\b(stop|don'?t|never|avoid|warning|mistake)\b/.test(h.slice(0, 60))) return "warning";
  if (
    /^\s*(\d+|one|two|three|five|ten)\b.*\b(tools?|ways?|tips?|things?|reasons?|prompts?)/.test(h)
  )
    return "listicle";
  if (/\?/.test(h.slice(0, 80)) || /^\s*(what|why|how|did you know|ever|imagine)/.test(h))
    return "question";
  if (/\b(\d{1,3}%|most people|nobody|98%|99%|90%)\b/.test(h.slice(0, 80))) return "stat-shock";
  if (/\b(everyone|everybody|they're wrong|actually|truth is|unpopular)\b/.test(h.slice(0, 80)))
    return "contrarian";
  if (/\b(watch|look at|check this|in \d+ seconds|i built|built this|in real time)\b/.test(h))
    return "demo-reveal";
  if (/^\s*(so |the other day|last week|yesterday|i was|when i)/.test(h)) return "story-open";
  if (/\b(the one|the secret|nobody tells you|hidden|you didn'?t know)\b/.test(h))
    return "curiosity-gap";
  if (/\b(replace|will change|game changer|insane|crazy|this ai|never been)\b/.test(h))
    return "bold-claim";
  if (/\b(you'?re|are you|wasting|struggling|tired of|hate)\b/.test(h.slice(0, 80)))
    return "problem-callout";
  return "unknown";
}

function classifyCta(text: string): CtaPattern {
  const t = text.toLowerCase();
  if (
    /\bcomment\b.{0,40}\b(below|word|".+?"|'.+?'|and i)/.test(t) ||
    /comment ["'][^"']+["']/.test(t)
  )
    return "comment-keyword";
  if (/\b(link in bio|link's in my bio|in my bio|bio link)\b/.test(t)) return "link-in-bio";
  if (/\b(save this|save it|bookmark)\b/.test(t)) return "save";
  if (/\b(share this|send this to|tag someone)\b/.test(t)) return "share";
  if (/\b(subscribe)\b/.test(t)) return "subscribe";
  if (/\b(follow( me)?|follow for more|hit follow)\b/.test(t)) return "follow";
  return "none";
}

function classifyAngle(text: string): TopicAngle {
  const t = text.toLowerCase();
  if (/\b(how to|step|tutorial|guide|first|then|finally)\b/.test(t)) return "tutorial";
  if (/\b(vs|versus|compared|better than|or )\b/.test(t)) return "comparison";
  if (/\b(review|i tried|tested|honest|worth it)\b/.test(t)) return "review";
  if (/\b(announced|released|launched|breaking|new|update|just dropped)\b/.test(t)) return "news";
  if (/\b(i think|in my opinion|hot take|unpopular|honestly)\b/.test(t)) return "opinion";
  if (/\b(case study|client|results|grew|made \$|revenue)\b/.test(t)) return "case-study";
  if (/\b(you can do this|don'?t give up|motivation|dream)\b/.test(t)) return "inspiration";
  return "unknown";
}

export function bucketLength(durationSec: number | null | undefined): LengthBucket {
  if (durationSec == null || !Number.isFinite(durationSec)) return "short";
  if (durationSec <= 12) return "ultra-short";
  if (durationSec <= 30) return "short";
  if (durationSec <= 60) return "medium";
  return "long";
}

function classifyPacing(wps: number): Pacing {
  if (wps <= 0) return "medium";
  if (wps < 2.0) return "slow";
  if (wps < 2.8) return "medium";
  if (wps < 3.6) return "fast";
  return "rapid";
}

/** Split a transcript into rough beats (sentences / clause groups). */
function splitBeats(transcript: string): string[] {
  return transcript
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function labelBeat(beat: string, index: number, total: number): string {
  const b = beat.toLowerCase();
  if (index === 0) return "hook";
  if (index === total - 1 && /\b(follow|comment|save|link|subscribe|share)\b/.test(b)) return "cta";
  if (/\b(first|step 1|number one|start by)\b/.test(b)) return "step";
  if (/\b(then|next|after|step \d|second|third)\b/.test(b)) return "step";
  if (/\b(but|however|the problem|here's the thing)\b/.test(b)) return "turn";
  if (/\b(so|that's why|meaning|which means)\b/.test(b)) return "payoff";
  return "point";
}

/**
 * Extract the standardized format feature vector from a piece of content. Pure
 * and resilient to missing fields — always returns a complete vector.
 */
export function extractFormatFeatures(input: FormatExtractionInput): ViralFormatFeatures {
  const transcript = (input.transcript ?? "").replace(/\s+/g, " ").trim();
  const caption = (input.caption ?? "").replace(/\s+/g, " ").trim();
  const combined = `${transcript} ${caption}`.trim();
  const hookSource = transcript || caption;
  const hookText = firstWords(hookSource, 18);

  const beats = splitBeats(transcript);
  const beatCount = beats.length;
  const structureBeats = beats.slice(0, 8).map((b, i) => labelBeat(b, i, beats.length));

  const wordCount = transcript ? transcript.split(/\s+/).length : 0;
  const dur = input.durationSec ?? null;
  const wps = dur && dur > 0 ? wordCount / dur : 0;

  // Infer on-screen text style: explicit hint wins; else infer from density.
  let textStyle: OnScreenTextStyle = "unknown";
  if (input.hasOnScreenText === true) textStyle = "captions";
  else if (input.hasOnScreenText === false) textStyle = "none";
  else if (wps >= 3.2) textStyle = "big-bold-keywords";
  else if (wordCount > 0) textStyle = "captions";

  return {
    hookArchetype: classifyHook(hookText),
    hookText,
    structureBeats,
    pacing: classifyPacing(wps),
    wordsPerSecond: Math.round(wps * 100) / 100,
    lengthSec: dur,
    lengthBucket: bucketLength(dur),
    onScreenTextStyle: textStyle,
    ctaPattern: classifyCta(combined),
    topicAngle: classifyAngle(combined),
    beatCount,
  };
}

// ---------------------------------------------------------------------------
// Format model + discovery
// ---------------------------------------------------------------------------

/**
 * A canonical recurring format mined from the corpus. Its `signature` is the
 * coarse key that groups many items into one format; the stats describe how
 * often that shape appears and how it performs *within its niche*.
 */
export interface ViralFormat {
  /** Coarse grouping key: hook|lengthBucket|pacing|cta. */
  signature: string;
  hookArchetype: HookArchetype;
  lengthBucket: LengthBucket;
  pacing: Pacing;
  ctaPattern: CtaPattern;
  /** Most common topic angle inside this format group. */
  dominantAngle: TopicAngle;
  /** Most common on-screen text style inside this format group. */
  dominantTextStyle: OnScreenTextStyle;
  /** How many corpus items match this format. */
  frequency: number;
  /** Share of the (sub)niche corpus this format represents (0..1). */
  share: number;
  /** Average normalized engagement score of items in this format. */
  avgScore: number;
  /** Average within-niche percentile of items in this format (0..100). */
  avgPercentile: number;
  /** Median length (sec) of items in this format. */
  medianLengthSec: number | null;
  /** A few representative beat templates seen in this format. */
  exemplarBeats: string[][];
}

/** One scored corpus item the discovery routine consumes. */
export interface ScoredCorpusItem {
  features: ViralFormatFeatures;
  /** Normalized engagement score (see benchmark-store.engagementScore). */
  score: number;
  /** Within-niche percentile (0..100), if already computed. */
  percentile?: number;
}

export interface FormatDiscoveryResult {
  niche: string;
  subniche: string | null;
  sampleSize: number;
  formats: ViralFormat[];
}

function formatSignature(f: ViralFormatFeatures): string {
  return `${f.hookArchetype}|${f.lengthBucket}|${f.pacing}|${f.ctaPattern}`;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mode<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  let best: T | undefined;
  let bestN = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}

/**
 * Mine the corpus to surface the top-N formats for a (sub)niche, ranked by a
 * blend of how *frequently* the shape wins and how *well* it performs. Pure.
 */
export function discoverTopFormats(
  items: ScoredCorpusItem[],
  opts: { niche: string; subniche?: string | null; limit?: number } = { niche: "unknown" },
): FormatDiscoveryResult {
  const limit = opts.limit ?? 8;
  const groups = new Map<string, ScoredCorpusItem[]>();
  for (const it of items) {
    const sig = formatSignature(it.features);
    const arr = groups.get(sig) ?? [];
    arr.push(it);
    groups.set(sig, arr);
  }

  const total = items.length || 1;
  const formats: ViralFormat[] = [];
  for (const [sig, group] of groups) {
    const f0 = group[0].features;
    const scores = group.map((g) => g.score);
    const percentiles = group.map((g) => g.percentile ?? 0);
    const lengths = group
      .map((g) => g.features.lengthSec)
      .filter((n): n is number => typeof n === "number");
    formats.push({
      signature: sig,
      hookArchetype: f0.hookArchetype,
      lengthBucket: f0.lengthBucket,
      pacing: f0.pacing,
      ctaPattern: f0.ctaPattern,
      dominantAngle: mode(group.map((g) => g.features.topicAngle)) ?? "unknown",
      dominantTextStyle: mode(group.map((g) => g.features.onScreenTextStyle)) ?? "unknown",
      frequency: group.length,
      share: group.length / total,
      avgScore: scores.reduce((a, b) => a + b, 0) / group.length,
      avgPercentile: percentiles.reduce((a, b) => a + b, 0) / group.length,
      medianLengthSec: lengths.length ? median(lengths) : null,
      exemplarBeats: group.slice(0, 3).map((g) => g.features.structureBeats),
    });
  }

  // Rank: performance-weighted frequency. A format that's both common AND
  // high-performing in the niche is what "wins" — pure frequency would surface
  // generic shapes; pure performance would surface lucky one-offs.
  formats.sort((a, b) => {
    const sa = a.avgScore * Math.log2(a.frequency + 1);
    const sb = b.avgScore * Math.log2(b.frequency + 1);
    return sb - sa;
  });

  return {
    niche: opts.niche,
    subniche: opts.subniche ?? null,
    sampleSize: items.length,
    formats: formats.slice(0, limit),
  };
}

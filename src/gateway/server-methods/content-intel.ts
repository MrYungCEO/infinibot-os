/**
 * Content Intelligence — gateway RPC handlers.
 *
 * Thin wrapper over `src/content/intelligence/store.ts` (the SQLite store at
 * `<stateDir>/content-intel.db`). These are the operator surface that the
 * control-UI Content Intelligence view reads to show reels joined with their
 * latest metrics, transcript, and AI score.
 *
 * The payload shape intentionally mirrors the baked fallback snapshot at
 * `ui/public/content-intel-snapshot.json` (snake_case reel rows, `totals` +
 * `tier_distribution`) so the UI has a single render path whether the data
 * comes from this RPC or the static snapshot fallback.
 *
 * RPCs:
 *   content.intel.list   — all reels + totals + tier distribution
 *   content.intel.get    — one reel by shortcode (with transcript text)
 *   content.intel.totals — just totals + tier distribution (cheap header poll)
 */

import { GatewayRequestHandlers } from "./types.js";
import { getContentIntelStore } from "../../content/intelligence/store.js";
import type { YoutubeChannelRow, YoutubeVideoRow } from "../../content/intelligence/store.js";
import {
  scoreReel as pipelineScoreReel,
  transcribeReel,
  getPipelineConfig,
  checkPipelineReadiness,
} from "../../content/intelligence/pipeline-wrapper.js";
import { importMetaCsv } from "../../content/intelligence/importer.js";
import { resolveContentSttRoute } from "../../content/intelligence/transcription-service.js";
import type { ReelRow, ReelMetricsRow } from "../../content/intelligence/types.js";
import { randomUUID } from "node:crypto";
import { getThumbnail } from "../../content/intelligence/thumbnail-store.js";
import { relativeScoreForReel } from "../../content/intelligence/scoring-service.js";

/**
 * Resolve a cover-thumbnail URL for a reel from the `reel_thumbnails` backfill.
 * Prefers the locally-mirrored static asset (`/content-intel-thumbs/<shortcode>.jpg`,
 * published into `ui/public` by the backfill) so the UI never hotlinks the IG CDN
 * (those og:image URLs expire). Falls back to the remote og:image URL, else null.
 */
function resolveThumbnailUrl(shortcode: string): string | null {
  const t = getThumbnail(shortcode);
  if (!t || t.ok !== 1) return null;
  if (t.local_path) return `/content-intel-thumbs/${shortcode}.jpg`;
  return t.thumbnail_url ?? null;
}

/** Flat reel shape mirroring `content-intel-snapshot.json`. */
interface ReelIntel {
  shortcode: string;
  url: string;
  account: string;
  description: string;
  publish_time: string;
  duration_sec: number | null;
  /** Cover thumbnail (local static path or remote og:image), or null if none. */
  thumbnail_url: string | null;
  /**
   * Inline-playable video URL. Streamed on demand from the locally-downloaded
   * mp4 by the gateway (`/plugins/content-studio/video?shortcode=<sc>`, Range-capable).
   * Always set; the endpoint 404s gracefully if no local file exists, so the UI
   * lightbox can surface a "no video" state without a per-reel existence probe.
   */
  video_url: string;
  // latest metrics (flattened)
  views: number | null;
  reach: number | null;
  likes: number | null;
  shares: number | null;
  comments: number | null;
  saves: number | null;
  follows: number | null;
  // pipeline state
  has_video: boolean;
  has_transcript: boolean;
  has_score: boolean;
  // transcript
  transcript: string | null;
  transcript_engine: string | null;
  // score
  hook: number | null;
  value: number | null;
  viral: number | null;
  overall: number | null;
  tier: string | null;
  reason: string | null;
  idea_vs_execution: string | null;
  scored_by: string | null;
  model: string | null;
}

function toIntel(
  reel: ReelRow & Partial<ReelMetricsRow>,
  store: ReturnType<typeof getContentIntelStore>,
  includeTranscript: boolean,
): ReelIntel {
  const score = reel.has_score ? store.getScore(reel.shortcode) : undefined;
  const transcript =
    includeTranscript && reel.has_transcript ? store.getTranscript(reel.shortcode) : undefined;
  return {
    shortcode: reel.shortcode,
    url: reel.url,
    account: reel.account,
    description: reel.description ?? "",
    publish_time: reel.publish_time ?? "",
    duration_sec: reel.duration_sec ?? null,
    thumbnail_url: resolveThumbnailUrl(reel.shortcode),
    video_url: `/plugins/content-studio/video?shortcode=${encodeURIComponent(reel.shortcode)}`,
    views: reel.views ?? null,
    reach: reel.reach ?? null,
    likes: reel.likes ?? null,
    shares: reel.shares ?? null,
    comments: reel.comments ?? null,
    saves: reel.saves ?? null,
    follows: reel.follows ?? null,
    has_video: reel.has_video > 0,
    has_transcript: reel.has_transcript > 0,
    has_score: reel.has_score > 0,
    transcript: transcript?.text ?? null,
    transcript_engine: transcript?.engine ?? null,
    hook: score?.hook ?? null,
    value: score?.value ?? null,
    viral: score?.viral ?? null,
    overall: score?.overall ?? null,
    tier: score?.tier ?? null,
    reason: score?.reason ?? null,
    idea_vs_execution: score?.idea_vs_execution ?? null,
    scored_by: score?.scored_by ?? null,
    model: score?.model ?? null,
  };
}

function buildTotals(reels: ReelIntel[]) {
  let transcribed = 0;
  let scored = 0;
  let total_views = 0;
  let total_saves = 0;
  const tier_distribution: Record<string, number> = {};
  for (const r of reels) {
    if (r.has_transcript) transcribed++;
    if (r.has_score) scored++;
    total_views += r.views ?? 0;
    total_saves += r.saves ?? 0;
    const tier = r.tier && r.tier.trim() ? r.tier : "—";
    tier_distribution[tier] = (tier_distribution[tier] ?? 0) + 1;
  }
  return {
    totals: { reels: reels.length, transcribed, scored, total_views, total_saves },
    tier_distribution,
  };
}

// ═══════════════════════════════════════════════════════════════════
// AI INSIGHTS — synthesized from the scored reel corpus (deterministic)
// ═══════════════════════════════════════════════════════════════════
//
// `content.intel.insights` turns the raw scores + metrics into the three
// dashboard explainer sections:
//   • winners      — per-top-reel breakdown of WHAT drove the win
//   • videoIdeas   — next-video concepts derived from winning patterns
//   • improvements — recurring weaknesses / opportunities to fix
//
// Everything is derived from the store (no request-time LLM call) so the
// panel always renders fast and never fails on an API hiccup.

const STOPWORDS = new Set(
  (
    "the a an and or but if then so to of in on for with at by from up out as is are was were be been being this that these those i you he she it we they my your our " +
    "me him her them us your yours how what why when where who which not no yes do does did done get got make made just like really very more most much many " +
    "will would can could should im dont cant youre were here there about into over under than too also only even still back down off all any some new now one"
  ).split(/\s+/),
);

function keywords(text: string, limit = 6): string[] {
  const freq = new Map<string, number>();
  for (const raw of (text ?? "").toLowerCase().split(/[^a-z0-9']+/)) {
    const w = raw.replace(/'/g, "");
    if (w.length < 4 || STOPWORDS.has(w)) continue;
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

interface InsightWinner {
  shortcode: string;
  url: string;
  thumbnail_url: string | null;
  video_url: string;
  overall: number | null;
  tier: string | null;
  views: number | null;
  hook: number | null;
  value: number | null;
  viral: number | null;
  reason: string | null;
  drivers: Array<{ label: string; detail: string }>;
}

interface InsightIdea {
  title: string;
  rationale: string;
  basedOn: string[];
}

interface InsightImprovement {
  title: string;
  detail: string;
  examples: string[];
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function buildInsights(reels: ReelIntel[]): {
  scoredCount: number;
  winners: InsightWinner[];
  videoIdeas: InsightIdea[];
  improvements: InsightImprovement[];
} {
  const scored = reels.filter((r) => r.has_score && r.overall != null);
  const medViews = median(reels.map((r) => r.views ?? 0).filter((v) => v > 0));

  // ── Winners: top by overall, tie-broken by views ──────────────────
  const ranked = [...scored].sort(
    (a, b) => (b.overall ?? 0) - (a.overall ?? 0) || (b.views ?? 0) - (a.views ?? 0),
  );
  const winners: InsightWinner[] = ranked.slice(0, 6).map((r) => {
    const drivers: Array<{ label: string; detail: string }> = [];
    if ((r.hook ?? 0) >= 7)
      drivers.push({ label: "Hook", detail: `Strong opening (hook ${r.hook?.toFixed(1)})` });
    if ((r.value ?? 0) >= 7)
      drivers.push({ label: "Value", detail: `High payoff (value ${r.value?.toFixed(1)})` });
    if ((r.viral ?? 0) >= 6)
      drivers.push({
        label: "Shareability",
        detail: `Viral structure (viral ${r.viral?.toFixed(1)})`,
      });
    if (r.thumbnail_url) drivers.push({ label: "Thumbnail", detail: "Scroll-stopping cover" });
    if (medViews > 0 && (r.views ?? 0) >= medViews * 1.5)
      drivers.push({
        label: "Reach",
        detail: `Outperformed median views (${(r.views ?? 0).toLocaleString()})`,
      });
    const topics = keywords(`${r.description} ${r.transcript ?? ""}`, 4);
    if (topics.length) drivers.push({ label: "Topic", detail: topics.join(", ") });
    return {
      shortcode: r.shortcode,
      url: r.url,
      thumbnail_url: r.thumbnail_url,
      video_url: r.video_url,
      overall: r.overall,
      tier: r.tier,
      views: r.views,
      hook: r.hook,
      value: r.value,
      viral: r.viral,
      reason: r.reason,
      drivers,
    };
  });

  // ── Video ideas: cluster winning topics + amplify winning levers ──
  const winnerTopics = new Map<string, string[]>(); // topic -> shortcodes
  for (const w of ranked.slice(0, 10)) {
    for (const t of keywords(`${w.description} ${w.transcript ?? ""}`, 5)) {
      const arr = winnerTopics.get(t) ?? [];
      arr.push(w.shortcode);
      winnerTopics.set(t, arr);
    }
  }
  const videoIdeas: InsightIdea[] = [...winnerTopics.entries()]
    .filter(([, codes]) => codes.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4)
    .map(([topic, codes]) => ({
      title: `Go deeper on “${topic}”`,
      rationale: `${codes.length} of your top reels cluster around “${topic}.” Make a follow-up or a series that mines this winning theme.`,
      basedOn: codes.slice(0, 3),
    }));
  // Always add a lever-based idea from the single best reel.
  const best = ranked[0];
  if (best) {
    videoIdeas.unshift({
      title: `Reuse the hook that made ${best.shortcode} win`,
      rationale: `Your #1 reel scored hook ${best.hook?.toFixed(1)}/10. Open your next videos with the same pattern — front-load the payoff in the first 2 seconds.`,
      basedOn: [best.shortcode],
    });
  }

  // ── Concepts to improve: recurring weaknesses ─────────────────────
  const improvements: InsightImprovement[] = [];
  const weakHook = scored.filter((r) => (r.hook ?? 10) < 5);
  if (weakHook.length)
    improvements.push({
      title: "Strengthen weak hooks",
      detail: `${weakHook.length} scored reels opened with a hook below 5/10. Lead with a bolder claim, question, or pattern interrupt in the first second.`,
      examples: weakHook.slice(0, 4).map((r) => r.shortcode),
    });
  const lowViral = scored.filter((r) => (r.viral ?? 10) < 4);
  if (lowViral.length)
    improvements.push({
      title: "Add shareability triggers",
      detail: `${lowViral.length} reels scored low on viral potential. Bake in a save-worthy takeaway or an explicit “send this to…” moment.`,
      examples: lowViral.slice(0, 4).map((r) => r.shortcode),
    });
  const ctaMentions = scored.filter((r) => /call to action|cta|no clear/i.test(r.reason ?? ""));
  if (ctaMentions.length)
    improvements.push({
      title: "Close with a clear CTA",
      detail: `The scorer flagged ${ctaMentions.length} reels for a missing or weak call to action. End with one specific next step.`,
      examples: ctaMentions.slice(0, 4).map((r) => r.shortcode),
    });
  const noThumb = scored.filter((r) => !r.thumbnail_url);
  if (noThumb.length)
    improvements.push({
      title: "Design intentional covers",
      detail: `${noThumb.length} reels have no distinct cover. A custom thumbnail with a bold caption lifts cold-scroll stop-rate.`,
      examples: noThumb.slice(0, 4).map((r) => r.shortcode),
    });

  return { scoredCount: scored.length, winners, videoIdeas, improvements };
}

// ═══════════════════════════════════════════════════════════════════
// LIVE SCORING — single + batch, with WS progress broadcasts
// ═══════════════════════════════════════════════════════════════════
//
// The control-UI Content Intelligence view animates per-reel scoring from
// REAL pipeline progress (no fake timers). Each phase is pushed over the
// gateway WS broadcast bus on the `content.intel.progress` channel — the same
// in-process→WS mechanism `proactive.event` / kanban / notes use. The UI
// subscribes and drives its queued → scoring → scored state machine from
// these frames.
//
// Phase payloads (channel `content.intel.progress`):
//   { phase: "batch-start", total, shortcodes }
//   { phase: "queued",      shortcode }
//   { phase: "scoring",     shortcode, index?, total? }
//   { phase: "scored",      shortcode, reel, totals, tier_distribution }
//   { phase: "failed",      shortcode, error }
//   { phase: "batch-done",  scored, failed, total, totals, tier_distribution }

const PROGRESS_CHANNEL = "content.intel.progress";
const TRANSCRIBE_PROGRESS_CHANNEL = "content.intel.transcribe.progress";

/** A batch is at most one at a time, process-wide. */
let batchRunning = false;
let batchAbort = false;

/** Transcribe batch state — mirrors the scoring batch pattern. */
let transcribeRunning = false;
let transcribeAbort = false;

/** STT mode — module-level store (a full config store can come later). */
let sttMode: "auto" | "local" | "cloud" = "auto";

type BroadcastFn = (event: string, payload: unknown) => void;

/** Cheap totals + tier distribution snapshot (mirrors content.intel.totals). */
function totalsSnapshot(store: ReturnType<typeof getContentIntelStore>) {
  const rows = store.listReelsWithMetrics(2000);
  const reels = rows.map((r) => toIntel(r, store, false));
  return { account: reels[0]?.account ?? "", ...buildTotals(reels) };
}

/** Build the flat intel row for one shortcode (post-score), or null. */
function buildIntelFor(
  store: ReturnType<typeof getContentIntelStore>,
  shortcode: string,
): ReelIntel | null {
  const reel = store.getReel(shortcode);
  if (!reel) return null;
  const metrics = store.getLatestMetrics(shortcode);
  const merged = { ...reel, ...metrics } as ReelRow & Partial<ReelMetricsRow>;
  return toIntel(merged, store, false);
}

/**
 * Score one reel, persisting via the pipeline wrapper, and broadcast the
 * scoring → scored/failed phases. Returns true on success.
 */
async function scoreOneWithBroadcast(
  broadcast: BroadcastFn,
  shortcode: string,
  extra?: { index?: number; total?: number },
): Promise<boolean> {
  broadcast(PROGRESS_CHANNEL, { phase: "scoring", shortcode, ...extra });
  try {
    const result = await pipelineScoreReel(shortcode, getPipelineConfig());
    const store = getContentIntelStore();
    if (result.success) {
      const reel = buildIntelFor(store, shortcode);
      const { totals, tier_distribution } = totalsSnapshot(store);
      broadcast(PROGRESS_CHANNEL, {
        phase: "scored",
        shortcode,
        reel,
        totals,
        tier_distribution,
      });
      return true;
    }
    broadcast(PROGRESS_CHANNEL, {
      phase: "failed",
      shortcode,
      error: result.error ?? "scoring failed",
    });
    return false;
  } catch (e) {
    broadcast(PROGRESS_CHANNEL, { phase: "failed", shortcode, error: String(e) });
    return false;
  }
}

export const contentIntelHandlers: GatewayRequestHandlers = {
  "content.intel.list": ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { limit?: number; offset?: number; account?: string };
      const limit = typeof p.limit === "number" && p.limit > 0 ? Math.min(p.limit, 2000) : 1000;
      const offset = typeof p.offset === "number" && p.offset >= 0 ? p.offset : 0;
      const store = getContentIntelStore();
      // Transcript text is omitted from the list to keep the payload light;
      // the UI fetches full transcripts lazily via content.intel.get.
      let rows = store.listReelsWithMetrics(limit + offset).slice(offset, offset + limit);
      if (p.account && p.account.trim()) {
        const acc = p.account.trim().toLowerCase();
        rows = rows.filter((r) => (r.account ?? "").toLowerCase() === acc);
      }
      const reels = rows.map((r) => toIntel(r, store, false));
      const { totals, tier_distribution } = buildTotals(reels);
      const account = reels[0]?.account ?? "";
      respond(true, { account, totals, tier_distribution, reels });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "content.intel.get": ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { shortcode?: string };
      if (!p.shortcode) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "shortcode is required" });
        return;
      }
      const store = getContentIntelStore();
      const reel = store.getReel(p.shortcode);
      if (!reel) {
        respond(false, undefined, { code: "NOT_FOUND", message: `no reel ${p.shortcode}` });
        return;
      }
      const metrics = store.getLatestMetrics(p.shortcode);
      const merged = { ...reel, ...metrics } as ReelRow & Partial<ReelMetricsRow>;
      // Niche-relative benchmark verdict (undefined when the benchmark is thin/unavailable).
      const transcript = reel.has_transcript ? store.getTranscript(p.shortcode)?.text : undefined;
      const relative = relativeScoreForReel(p.shortcode, transcript);
      respond(true, { reel: toIntel(merged, store, true), relative });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  "content.intel.totals": ({ respond }) => {
    try {
      const store = getContentIntelStore();
      const rows = store.listReelsWithMetrics(2000);
      const reels = rows.map((r) => toIntel(r, store, false));
      const { totals, tier_distribution } = buildTotals(reels);
      respond(true, { account: reels[0]?.account ?? "", totals, tier_distribution });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // Synthesized AI insights for the dashboard explainer sections:
  // winners (why they win), videoIdeas (next concepts), improvements
  // (weaknesses). Derived deterministically from the scored corpus — includes
  // transcript text so topic clustering is grounded in what was actually said.
  "content.intel.insights": ({ respond }) => {
    try {
      const store = getContentIntelStore();
      const rows = store.listReelsWithMetrics(2000);
      const reels = rows.map((r) => toIntel(r, store, true));
      const insights = buildInsights(reels);
      respond(true, { account: reels[0]?.account ?? "", ...insights });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // The mere presence of this method tells the UI that the live scoring RPCs
  // are registered (i.e. the gateway has been restarted). The UI gates its
  // "Score now" / "Score all" buttons on a successful call here — if it throws
  // (unknown method on an un-restarted gateway) the buttons stay disabled with
  // a "restart to enable" hint.
  "content.intel.capabilities": ({ respond }) => {
    try {
      const store = getContentIntelStore();
      const state = store.countByState();
      const unscored = store.listReelsMissingScore(5000).length;
      const remainingToTranscribe = store.listReelsMissingTranscript(5000).length;
      // ALL reels without a score regardless of transcript status
      const unscoredTotal = state.total - state.hasScore;
      // Full readiness probe: interpreter + vendored script + Python deps +
      // API key. This is the diagnostic surface the dashboard reads to explain
      // exactly why scoring would fail, instead of a generic warning.
      const readiness = checkPipelineReadiness();
      respond(true, {
        scoring: true,
        hasApiKey: readiness.hasApiKey,
        // Diagnostic detail for the operator surface.
        ready: readiness.ready,
        pythonOk: readiness.pythonOk,
        scriptsOk: readiness.scriptsOk,
        depsOk: readiness.depsOk,
        pythonBin: readiness.pythonBin,
        detail: readiness.detail,
        batchRunning,
        transcribeRunning,
        // unscored = transcribed-but-unscored (the actual scoring work size)
        unscored,
        // unscoredTotal = ALL reels without a score (true backlog size)
        unscoredTotal,
        // remainingToTranscribe = reels with video but no transcript
        remainingToTranscribe,
        transcribed: state.hasTranscript,
        scored: state.hasScore,
        total: state.total,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // Score a single reel by shortcode. Broadcasts queued → scoring →
  // scored/failed on `content.intel.progress`. Resolves once scoring finishes.
  "content.intel.score": async ({ params, respond, context }) => {
    try {
      const p = (params ?? {}) as { shortcode?: string };
      if (!p.shortcode) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "shortcode is required" });
        return;
      }
      const shortcode = p.shortcode;
      context.broadcast(PROGRESS_CHANNEL, { phase: "queued", shortcode });
      const ok = await scoreOneWithBroadcast((e, pl) => context.broadcast(e, pl), shortcode);
      const store = getContentIntelStore();
      const reel = buildIntelFor(store, shortcode);
      const { totals, tier_distribution } = totalsSnapshot(store);
      respond(ok, { ok, shortcode, reel, totals, tier_distribution });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // Batch-score every transcribed-but-unscored reel. Responds immediately
  // with the work size; the actual scoring runs asynchronously and streams
  // per-reel progress over `content.intel.progress` so the UI animates live
  // while staying on the page. Resumable (skips already-scored) and abortable.
  "content.intel.scoreBatch": ({ params, respond, context }) => {
    try {
      if (batchRunning) {
        respond(false, undefined, { code: "BUSY", message: "a scoring batch is already running" });
        return;
      }
      const p = (params ?? {}) as { limit?: number };
      const limit = typeof p.limit === "number" && p.limit > 0 ? Math.min(p.limit, 5000) : 5000;
      const store = getContentIntelStore();
      const targets = store.listReelsMissingScore(limit);
      const shortcodes = targets.map((r) => r.shortcode);
      const total = shortcodes.length;

      // Respond up-front: the UI drives its animation from the broadcasts.
      respond(true, { started: true, total, shortcodes });
      if (total === 0) {
        const snap = totalsSnapshot(store);
        context.broadcast(PROGRESS_CHANNEL, {
          phase: "batch-done",
          scored: 0,
          failed: 0,
          total: 0,
          totals: snap.totals,
          tier_distribution: snap.tier_distribution,
        });
        return;
      }

      batchRunning = true;
      batchAbort = false;
      const broadcast: BroadcastFn = (e, pl) => context.broadcast(e, pl);

      void (async () => {
        let scored = 0;
        let failed = 0;
        try {
          broadcast(PROGRESS_CHANNEL, { phase: "batch-start", total, shortcodes });
          for (let i = 0; i < shortcodes.length; i++) {
            if (batchAbort) break;
            const sc = shortcodes[i];
            broadcast(PROGRESS_CHANNEL, { phase: "queued", shortcode: sc });
            const ok = await scoreOneWithBroadcast(broadcast, sc, { index: i + 1, total });
            if (ok) scored++;
            else failed++;
            // Courtesy gap between real API calls (also lets animations breathe).
            if (i < shortcodes.length - 1 && !batchAbort) {
              await new Promise((r) => setTimeout(r, 600));
            }
          }
        } finally {
          batchRunning = false;
          const snap = totalsSnapshot(getContentIntelStore());
          broadcast(PROGRESS_CHANNEL, {
            phase: "batch-done",
            scored,
            failed,
            total,
            aborted: batchAbort,
            totals: snap.totals,
            tier_distribution: snap.tier_distribution,
          });
        }
      })();
    } catch (e) {
      batchRunning = false;
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // Request cancellation of an in-flight batch. The loop stops after the
  // current reel and emits a final `batch-done` with `aborted: true`.
  "content.intel.scoreBatchCancel": ({ respond }) => {
    if (!batchRunning) {
      respond(true, { running: false });
      return;
    }
    batchAbort = true;
    respond(true, { running: true, cancelRequested: true });
  },

  // ── Transcription batch ──────────────────────────────────────────────────
  //
  // Mirror of scoreBatch but for transcription. Responds immediately with
  // { started, total } and then async-loops over reels missing transcripts,
  // calling transcribeReel (pipeline-wrapper). Streams per-reel progress on
  // `content.intel.transcribe.progress`. Abortable via transcribeBatchCancel.
  //
  // Phase payloads (channel `content.intel.transcribe.progress`):
  //   { phase: "transcribe-start",  total, shortcodes }
  //   { phase: "transcribing",      shortcode, index?, total? }
  //   { phase: "transcribed",       shortcode, reel }
  //   { phase: "transcribe-failed", shortcode, error }
  //   { phase: "transcribe-done",   transcribed, failed, total, aborted? }
  "content.intel.transcribeBatch": ({ params, respond, context }) => {
    try {
      if (transcribeRunning) {
        respond(false, undefined, {
          code: "BUSY",
          message: "a transcription batch is already running",
        });
        return;
      }
      const p = (params ?? {}) as { limit?: number };
      const limit = typeof p.limit === "number" && p.limit > 0 ? Math.min(p.limit, 5000) : 5000;
      const store = getContentIntelStore();
      const targets = store.listReelsMissingTranscript(limit);
      const shortcodes = targets.map((r) => r.shortcode);
      const total = shortcodes.length;

      respond(true, { started: true, total, shortcodes });
      if (total === 0) {
        context.broadcast(TRANSCRIBE_PROGRESS_CHANNEL, {
          phase: "transcribe-done",
          transcribed: 0,
          failed: 0,
          total: 0,
        });
        return;
      }

      transcribeRunning = true;
      transcribeAbort = false;
      const broadcast: BroadcastFn = (e, pl) => context.broadcast(e, pl);

      void (async () => {
        let transcribed = 0;
        let failed = 0;
        try {
          broadcast(TRANSCRIBE_PROGRESS_CHANNEL, {
            phase: "transcribe-start",
            total,
            shortcodes,
          });
          for (let i = 0; i < shortcodes.length; i++) {
            if (transcribeAbort) break;
            const sc = shortcodes[i];
            broadcast(TRANSCRIBE_PROGRESS_CHANNEL, {
              phase: "transcribing",
              shortcode: sc,
              index: i + 1,
              total,
            });
            try {
              const result = await transcribeReel(sc, undefined, getPipelineConfig());
              const currentStore = getContentIntelStore();
              if (result.success) {
                // Store already updated by transcribeReel (it calls upsertTranscript + setHasTranscript)
                const reel = buildIntelFor(currentStore, sc);
                broadcast(TRANSCRIBE_PROGRESS_CHANNEL, {
                  phase: "transcribed",
                  shortcode: sc,
                  reel,
                });
                transcribed++;
              } else {
                broadcast(TRANSCRIBE_PROGRESS_CHANNEL, {
                  phase: "transcribe-failed",
                  shortcode: sc,
                  error: result.error ?? "transcription failed",
                });
                failed++;
              }
            } catch (e) {
              broadcast(TRANSCRIBE_PROGRESS_CHANNEL, {
                phase: "transcribe-failed",
                shortcode: sc,
                error: String(e),
              });
              failed++;
            }
            // Courtesy gap between processing
            if (i < shortcodes.length - 1 && !transcribeAbort) {
              await new Promise((r) => setTimeout(r, 300));
            }
          }
        } finally {
          transcribeRunning = false;
          broadcast(TRANSCRIBE_PROGRESS_CHANNEL, {
            phase: "transcribe-done",
            transcribed,
            failed,
            total,
            aborted: transcribeAbort,
          });
        }
      })();
    } catch (e) {
      transcribeRunning = false;
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // Request cancellation of an in-flight transcription batch.
  "content.intel.transcribeBatchCancel": ({ respond }) => {
    if (!transcribeRunning) {
      respond(true, { running: false });
      return;
    }
    transcribeAbort = true;
    respond(true, { running: true, cancelRequested: true });
  },

  // ── STT settings ─────────────────────────────────────────────────────────
  //
  // Returns the current STT config + available routes. The transcription
  // service's resolveContentSttRoute already knows the available local route.
  "content.intel.stt.config": ({ respond }) => {
    try {
      const route = resolveContentSttRoute(sttMode);
      respond(true, {
        mode: sttMode,
        available: ["local"],
        cloudConfigured: false,
        localAvailable: true,
        label: route.label,
        route,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // Persist the STT mode selection (module-level for now; a full config store
  // can replace this later).
  "content.intel.stt.setConfig": ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { mode?: string };
      const mode = p.mode as "auto" | "local" | "cloud" | undefined;
      if (!mode || !["auto", "local", "cloud"].includes(mode)) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: 'mode must be "auto", "local", or "cloud"',
        });
        return;
      }
      sttMode = mode;
      respond(true, { mode: sttMode });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── CSV import ────────────────────────────────────────────────────────────
  //
  // Trigger a Meta CSV import from the frontend by passing the local file path.
  // Accepts { filePath: string, account?: string }.
  "content.intel.import": ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { filePath?: string; account?: string };
      if (!p.filePath) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "filePath is required" });
        return;
      }
      const result = importMetaCsv(p.filePath, p.account ?? undefined);
      respond(true, result);
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── Accounts: list all tracked IG accounts with reel/score counts ──
  "content.intel.accounts": ({ respond }) => {
    try {
      const store = getContentIntelStore();
      const accounts = store.countByAccount();
      respond(true, { accounts });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── YouTube: list channels ──
  "content.intel.youtube.channels": ({ respond }) => {
    try {
      const store = getContentIntelStore();
      const channels = store.listYoutubeChannels();
      respond(true, { channels });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── YouTube: list videos for a channel (or all) ──
  "content.intel.youtube.list": ({ params, respond }) => {
    try {
      const p = (params ?? {}) as { channelId?: string; limit?: number };
      const limit = typeof p.limit === "number" && p.limit > 0 ? Math.min(p.limit, 2000) : 500;
      const store = getContentIntelStore();
      const videos = store.listYoutubeVideos(p.channelId, limit);
      respond(true, { videos });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── YouTube: import channel metadata + video list ──
  // Accepts { channelId, name?, handle?, videos?: [{video_id, title, ...}] }
  "content.intel.youtube.import": ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        channelId?: string;
        name?: string;
        handle?: string;
        subscriberCount?: number;
        videoCount?: number;
        thumbnailUrl?: string;
        videos?: Array<Partial<YoutubeVideoRow>>;
      };
      if (!p.channelId) {
        respond(false, undefined, { code: "INVALID_PARAMS", message: "channelId is required" });
        return;
      }
      const store = getContentIntelStore();
      const now = Date.now();
      const channelRow: YoutubeChannelRow = {
        channel_id: p.channelId,
        name: p.name ?? "",
        handle: p.handle ?? null,
        subscriber_count: p.subscriberCount ?? null,
        video_count: p.videoCount ?? null,
        thumbnail_url: p.thumbnailUrl ?? null,
        captured_at: now,
        updated_at: now,
      };
      store.upsertYoutubeChannel(channelRow);
      let imported = 0;
      if (Array.isArray(p.videos)) {
        for (const v of p.videos) {
          if (!v.video_id) continue;
          const row: YoutubeVideoRow = {
            video_id: v.video_id,
            channel_id: p.channelId,
            title: v.title ?? null,
            description: v.description ?? null,
            published_at: v.published_at ?? null,
            duration_sec: v.duration_sec ?? null,
            thumbnail_url: v.thumbnail_url ?? null,
            views: v.views ?? null,
            likes: v.likes ?? null,
            comments: v.comments ?? null,
            has_transcript: v.has_transcript ?? 0,
            has_score: v.has_score ?? 0,
            captured_at: now,
            updated_at: now,
          };
          store.upsertYoutubeVideo(row);
          imported++;
        }
      }
      // Audit run
      store.insertRun({
        id: randomUUID(),
        kind: "youtube-import",
        started_at: now,
        finished_at: Date.now(),
        status: "done",
        details: JSON.stringify({ channelId: p.channelId, videos: imported }),
        reel_count: imported,
      });
      respond(true, { channelId: p.channelId, imported });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  // ── YouTube: fetch channel + videos from the YouTube Data API ──
  // Accepts { handle | channelId | url, apiKey } and pulls real data
  "content.intel.youtube.fetch": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        handle?: string;
        channelId?: string;
        url?: string;
        apiKey?: string;
        maxVideos?: number;
      };
      const input = (p.handle ?? p.channelId ?? p.url ?? "").trim();
      if (!input) {
        respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "handle, channelId, or url is required",
        });
        return;
      }
      const apiKey = (
        p.apiKey ??
        process.env.YOUTUBE_API_KEY ??
        process.env.GOOGLE_API_KEY ??
        ""
      ).trim();
      if (!apiKey) {
        respond(false, undefined, {
          code: "NO_API_KEY",
          message: "YOUTUBE_API_KEY env var or apiKey param is required",
        });
        return;
      }
      const maxVideos = Math.min(p.maxVideos ?? 50, 200);

      let channelId = input;
      if (input.startsWith("UC") && input.length === 24) {
        channelId = input;
      } else {
        const handle = input
          .replace(/^https?:\/\/(www\.)?youtube\.com\//, "")
          .replace(/^@/, "")
          .replace(/^channel\//, "")
          .replace(/^user\//, "")
          .replace(/^c\//, "")
          .replace(/\/.*$/, "")
          .trim();
        const chRes = await fetch(
          `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`,
        );
        if (!chRes.ok) {
          const body = await chRes.text();
          respond(false, undefined, {
            code: "YOUTUBE_API_ERROR",
            message: `YouTube API error: ${chRes.status} ${body.slice(0, 200)}`,
          });
          return;
        }
        const chData = (await chRes.json()) as { items?: Array<{ id: string }> };
        if (!chData.items?.length) {
          const searchRes = await fetch(
            `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(handle)}&maxResults=1&key=${apiKey}`,
          );
          if (!searchRes.ok) {
            respond(false, undefined, {
              code: "YOUTUBE_API_ERROR",
              message: `YouTube search failed: ${searchRes.status}`,
            });
            return;
          }
          const searchData = (await searchRes.json()) as {
            items?: Array<{ id?: { channelId?: string }; snippet?: { channelId?: string } }>;
          };
          const found = searchData.items?.[0];
          channelId = found?.id?.channelId ?? found?.snippet?.channelId ?? "";
          if (!channelId) {
            respond(false, undefined, {
              code: "NOT_FOUND",
              message: `Could not find YouTube channel: ${handle}`,
            });
            return;
          }
        } else {
          channelId = chData.items[0].id;
        }
      }

      const chDetailRes = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${channelId}&key=${apiKey}`,
      );
      if (!chDetailRes.ok) {
        respond(false, undefined, {
          code: "YOUTUBE_API_ERROR",
          message: `Failed to fetch channel details: ${chDetailRes.status}`,
        });
        return;
      }
      const chDetail = (await chDetailRes.json()) as {
        items?: Array<{
          id: string;
          snippet?: {
            title?: string;
            customUrl?: string;
            thumbnails?: { default?: { url?: string }; medium?: { url?: string } };
          };
          statistics?: { subscriberCount?: string; videoCount?: string };
        }>;
      };
      const ch = chDetail.items?.[0];
      if (!ch) {
        respond(false, undefined, { code: "NOT_FOUND", message: "Channel not found" });
        return;
      }

      const channelRow: YoutubeChannelRow = {
        channel_id: ch.id,
        name: ch.snippet?.title ?? "",
        handle: ch.snippet?.customUrl ?? null,
        subscriber_count: ch.statistics?.subscriberCount
          ? parseInt(ch.statistics.subscriberCount, 10)
          : null,
        video_count: ch.statistics?.videoCount ? parseInt(ch.statistics.videoCount, 10) : null,
        thumbnail_url:
          ch.snippet?.thumbnails?.medium?.url ?? ch.snippet?.thumbnails?.default?.url ?? null,
        captured_at: Date.now(),
        updated_at: Date.now(),
      };
      const store = getContentIntelStore();
      store.upsertYoutubeChannel(channelRow);

      const uploadsPlaylistRes = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${channelId}&key=${apiKey}`,
      );
      const uploadsData = (await uploadsPlaylistRes.json()) as {
        items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
      };
      const uploadsPlaylistId = uploadsData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      let imported = 0;
      if (uploadsPlaylistId) {
        let pageToken: string | undefined = undefined;
        let fetched = 0;
        do {
          const pageParam = pageToken ? `&pageToken=${pageToken}` : "";
          const vidsRes = await fetch(
            `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${uploadsPlaylistId}&maxResults=50${pageParam}&key=${apiKey}`,
          );
          if (!vidsRes.ok) break;
          const vidsData = (await vidsRes.json()) as {
            nextPageToken?: string;
            items?: Array<{
              contentDetails?: { videoId?: string; videoPublishedAt?: string };
              snippet?: {
                title?: string;
                description?: string;
                thumbnails?: { medium?: { url?: string }; high?: { url?: string } };
              };
            }>;
          };
          const videoIds: string[] = [];
          for (const item of vidsData.items ?? []) {
            const vid = item.contentDetails?.videoId;
            if (vid) videoIds.push(vid);
          }
          if (videoIds.length > 0) {
            const detailsRes = await fetch(
              `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoIds.join(",")}&key=${apiKey}`,
            );
            if (detailsRes.ok) {
              const detailsData = (await detailsRes.json()) as {
                items?: Array<{
                  id: string;
                  snippet?: {
                    title?: string;
                    description?: string;
                    publishedAt?: string;
                    thumbnails?: { medium?: { url?: string } };
                  };
                  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
                  contentDetails?: { duration?: string };
                }>;
              };
              const now = Date.now();
              for (const v of detailsData.items ?? []) {
                const durationSec = v.contentDetails?.duration
                  ? parseISODuration(v.contentDetails.duration)
                  : null;
                const row: YoutubeVideoRow = {
                  video_id: v.id,
                  channel_id: channelId,
                  title: v.snippet?.title ?? null,
                  description: v.snippet?.description ?? null,
                  published_at: v.snippet?.publishedAt ?? null,
                  duration_sec: durationSec,
                  thumbnail_url: v.snippet?.thumbnails?.medium?.url ?? null,
                  views: v.statistics?.viewCount ? parseInt(v.statistics.viewCount, 10) : null,
                  likes: v.statistics?.likeCount ? parseInt(v.statistics.likeCount, 10) : null,
                  comments: v.statistics?.commentCount
                    ? parseInt(v.statistics.commentCount, 10)
                    : null,
                  has_transcript: 0,
                  has_score: 0,
                  captured_at: now,
                  updated_at: now,
                };
                store.upsertYoutubeVideo(row);
                imported++;
              }
            }
          }
          pageToken = vidsData.nextPageToken;
          fetched += 50;
        } while (pageToken && fetched < maxVideos);
      }

      store.insertRun({
        id: randomUUID(),
        kind: "youtube-fetch",
        started_at: Date.now(),
        finished_at: Date.now(),
        status: "done",
        details: JSON.stringify({ channelId, channelName: channelRow.name, videos: imported }),
        reel_count: imported,
      });
      respond(true, { channel: channelRow, imported });
    } catch (e) {
      respond(false, undefined, {
        code: "INTERNAL_ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
};

function parseISODuration(iso: string): number | null {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return null;
  const h = parseInt(match[1] ?? "0", 10);
  const m = parseInt(match[2] ?? "0", 10);
  const s = parseInt(match[3] ?? "0", 10);
  return h * 3600 + m * 60 + s || null;
}

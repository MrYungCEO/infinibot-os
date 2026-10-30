/**
 * Content Intelligence view — reel transcription & scoring dashboard.
 *
 * Premium black/gold data-viz dashboard over the reel corpus (181+ reels) from
 * the content-intel SQLite store, surfaced via the `content.intel.*` gateway
 * RPCs. Renders a responsive thumbnail-card grid (each card = the reel cover
 * with a glowing gradient frame, tier badge, score pill and hook/value/viral
 * mini-bar), a top data-viz band (tier donut, top-savers bars, score-vs-views
 * scatter, hook/value/viral aggregate), and the live animated scoring controls.
 *
 * Data source: `content.intel.list` RPC. When the gateway hasn't been
 * restarted with those RPCs registered yet, it falls back to the baked static
 * snapshot at `/content-intel-snapshot.json` so the page works immediately.
 * Both sources share the same flat snake_case reel shape (incl. `thumbnail_url`,
 * a `/content-intel-thumbs/<shortcode>.jpg` static asset), so there is a single
 * render path.
 *
 * Mounted as the `content-intel` tab (route `/content-intel`). Theme tokens
 * (`--g-primary` gold, `--text`) follow the InfiniBot OS black/gold design
 * language; tier colours are a gold-intensity ramp, never rainbow.
 */

import { LitElement, html, svg, css, nothing, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { gatewayCall, getGatewayClient } from "../gateway-client.js";
import type { GatewayEventFrame } from "../gateway.js";
import "../components/cmo-chat.js";
import { communicationGlassShadowStyles, commIcon } from "./communication-glass.js";

/** Per-reel live scoring phase, driven by `content.intel.progress` frames. */
type ScorePhase = "queued" | "scoring" | "scored" | "failed";

/** Channel the backend streams scoring progress on. */
const PROGRESS_EVENT = "content.intel.progress";
const TRANSCRIBE_PROGRESS_EVENT = "content.intel.transcribe.progress";

/** STT mode for transcription. */
type SttMode = "auto" | "local" | "cloud";

/** YouTube channel summary. */

/** Subset of src/content/trends/types.ts TrendsBundle the Trends tab shows. */
interface TrendsBundleLite {
  newsTopics?: Array<{ title: string; source: string; cluster: number }>;
  trendingFormats?: Array<{ label: string; mentions: number; example?: string }>;
  socialInsights?: Array<{ title: string; platform: string; community?: string; score: number }>;
}
interface YtChannel {
  channel_id: string;
  name: string;
  handle: string | null;
  subscriber_count: number | null;
  video_count: number | null;
  thumbnail_url: string | null;
}

/** YouTube video row. */
interface YtVideo {
  video_id: string;
  channel_id: string;
  title: string | null;
  description: string | null;
  published_at: string | null;
  duration_sec: number | null;
  thumbnail_url: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  has_transcript: number;
  has_score: number;
}

/** Account summary from content.intel.accounts. */
interface AccountSummary {
  account: string;
  count: number;
  scored: number;
  transcribed: number;
}

interface ReelIntel {
  shortcode: string;
  url: string;
  account?: string;
  description: string;
  publish_time?: string;
  duration_sec?: number | null;
  thumbnail_url?: string | null;
  /** Range-capable gateway stream of the local mp4 (404s gracefully if none). */
  video_url?: string | null;
  views: number | null;
  reach: number | null;
  likes: number | null;
  shares: number | null;
  comments: number | null;
  saves: number | null;
  follows: number | null;
  has_video?: boolean;
  has_transcript: boolean;
  has_score: boolean;
  transcript?: string | null;
  transcript_engine?: string | null;
  hook: number | null;
  value: number | null;
  viral: number | null;
  overall: number | null;
  tier: string | null;
  reason: string | null;
  idea_vs_execution?: string | null;
}

interface IntelTotals {
  reels: number;
  transcribed: number;
  scored: number;
  total_views: number;
  total_saves: number;
}

interface IntelPayload {
  account?: string;
  totals: IntelTotals;
  tier_distribution: Record<string, number>;
  reels: ReelIntel[];
}

type FilterMode = "all" | "scored" | "unscored" | "transcribed" | "untranscribed";

/** Synthesized insights from the `content.intel.insights` RPC. */
interface AiInsightWinner {
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
interface AiInsightIdea {
  title: string;
  rationale: string;
  basedOn: string[];
}
interface AiInsightImprovement {
  title: string;
  detail: string;
  examples: string[];
}
interface AiInsightsPayload {
  scoredCount: number;
  winners: AiInsightWinner[];
  videoIdeas: AiInsightIdea[];
  improvements: AiInsightImprovement[];
}

@customElement("content-intel-view")
export class ContentIntelView extends LitElement {
  @state() private loading = true;
  @state() private error = "";
  @state() private source: "live" | "snapshot" | "" = "";
  @state() private payload: IntelPayload | null = null;
  @state() private search = "";
  @state() private filter: FilterMode = "all";
  @state() private tierFilter: string | null = null;
  @state() private sort: "views" | "saves" | "score" | "tier" | "recent" = "views";
  /** Shortcode of the reel whose detail modal is open (null = closed). */
  @state() private detail: string | null = null;
  @state() private transcripts = new Map<string, string>();

  // ── Live scoring state ───────────────────────────────────────────────────
  /** Whether the live scoring RPCs are registered (gateway restarted). */
  @state() private scoringAvailable = false;
  /** Whether the gateway has an OpenRouter key configured for scoring. */
  @state() private hasApiKey = false;
  /** Whether the full scoring pipeline is ready (interpreter+deps+script+key). */
  @state() private scoringReady = false;
  /** Human-readable diagnostic from the capabilities probe (why scoring fails). */
  @state() private scoringDetail = "";
  /** Shortcode of the reel currently playing inline (grid card or modal). */
  @state() private playing: string | null = null;
  /** Synthesized AI insights (winners / ideas / improvements), or null offline. */
  @state() private ai: AiInsightsPayload | null = null;
  /** Per-reel animated phase: shortcode → queued | scoring | scored | failed. */
  @state() private scorePhase = new Map<string, ScorePhase>();
  /** Shortcodes whose tier badge should play the "animate in" effect. */
  @state() private justScored = new Set<string>();
  /** True while a batch run is in flight. */
  @state() private batchRunning = false;
  /** Live batch progress (done / total) for the header progress bar. */
  @state() private batchProgress: { done: number; total: number } | null = null;
  /** Brief flash on the Scored KPI when the count ticks up. */
  @state() private scoredFlash = false;

  // ── Transcription state ──────────────────────────────────────────────────
  @state() private transcribeRunning = false;
  @state() private transcribeProgress: { done: number; total: number } | null = null;
  @state() private remainingToTranscribe = 0;
  @state() private unscoredTotal = 0;

  // ── STT settings ─────────────────────────────────────────────────────────
  @state() private sttMode: SttMode = "auto";
  @state() private sttLabel = "";
  @state() private sttAvailable: string[] = [];

  // ── Account selector ──────────────────────────────────────────────────────
  @state() private accounts: AccountSummary[] = [];
  @state() private selectedAccount = "";

  // ── Import modal ──────────────────────────────────────────────────────────
  @state() private showImportModal = false;
  @state() private importFilePath = "";
  @state() private importAccount = "";
  @state() private importResult: string | null = null;
  @state() private importing = false;

  // ── YouTube ──────────────────────────────────────────────────────────────
  @state() private ytChannels: YtChannel[] = [];
  @state() private ytVideos: YtVideo[] = [];
  @state() private showYouTube = false;
  @state() private ytAddChannelId = "";
  @state() private ytFetching = false;
  @state() private ytError: string | null = null;

  // ── Sub-page tabs ────────────────────────────────────────────────────────
  @state() private subPage: "overview" | "scripts" | "insights" | "trends" = "overview";

  // ── Account add modal ──────────────────────────────────────────────────────
  @state() private showAccountModal = false;
  @state() private newAccountHandle = "";
  @state() private accountAdding = false;
  @state() private accountError: string | null = null;

  private unsub: (() => void) | null = null;
  private justScoredTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private onOpenReelEvent = (e: Event): void => {
    const shortcode = (e as CustomEvent).detail?.shortcode as string | undefined;
    if (shortcode) void this.openByShortcode(shortcode);
  };

  connectedCallback(): void {
    super.connectedCallback();
    void this.load();
    void this.probeScoring();
    void this.loadSttConfig();
    void this.loadAccounts();
    this.subscribeProgress();
    window.addEventListener("infinibot:content-intel-open-reel", this.onOpenReelEvent);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.unsub) {
      this.unsub();
      this.unsub = null;
    }
    for (const t of this.justScoredTimers.values()) clearTimeout(t);
    this.justScoredTimers.clear();
    if (this.flashTimer) clearTimeout(this.flashTimer);
    window.removeEventListener("infinibot:content-intel-open-reel", this.onOpenReelEvent);
  }

  /** Probe whether the live scoring RPCs exist. Throws → buttons stay gated. */
  private async probeScoring(): Promise<void> {
    try {
      const cap = await gatewayCall<{
        scoring?: boolean;
        hasApiKey?: boolean;
        batchRunning?: boolean;
        ready?: boolean;
        detail?: string;
        unscoredTotal?: number;
        remainingToTranscribe?: number;
      }>("content.intel.capabilities", {});
      this.scoringAvailable = cap?.scoring === true;
      this.hasApiKey = cap?.hasApiKey === true;
      this.scoringReady = cap?.ready === true;
      this.scoringDetail = cap?.detail ?? "";
      if (cap?.batchRunning) this.batchRunning = true;
      this.unscoredTotal = cap?.unscoredTotal ?? 0;
      this.remainingToTranscribe = cap?.remainingToTranscribe ?? 0;
    } catch {
      this.scoringAvailable = false;
    }
  }

  private async loadSttConfig(): Promise<void> {
    try {
      const res = await gatewayCall<{
        mode?: SttMode;
        available?: string[];
        label?: string;
      }>("content.intel.stt.config", {});
      this.sttMode = res?.mode ?? "auto";
      this.sttLabel = res?.label ?? "";
      this.sttAvailable = res?.available ?? [];
    } catch {
      // STT config RPC not available — defaults stay
    }
  }

  private async setSttMode(mode: SttMode): Promise<void> {
    try {
      await gatewayCall("content.intel.stt.setConfig", { mode });
      this.sttMode = mode;
      await this.loadSttConfig();
    } catch {
      // best-effort
    }
  }

  private async loadAccounts(): Promise<void> {
    try {
      const res = await gatewayCall<{ accounts?: AccountSummary[] }>("content.intel.accounts", {});
      this.accounts = res?.accounts ?? [];
    } catch {
      // RPC not available yet
    }
  }

  /** Subscribe to the live progress channel and drive the per-reel animation. */
  private async subscribeProgress(): Promise<void> {
    let client = getGatewayClient();
    // The WS may connect a beat after mount; poll briefly for the client.
    for (let i = 0; i < 100 && !client; i++) {
      await new Promise((r) => setTimeout(r, 50));
      client = getGatewayClient();
    }
    if (!client || this.unsub) return;
    this.unsub = client.subscribe((frame: GatewayEventFrame) => this.onProgress(frame));
  }

  private onProgress(frame: GatewayEventFrame): void {
    if (frame.event === TRANSCRIBE_PROGRESS_EVENT) {
      this.onTranscribeProgress(frame);
      return;
    }
    if (frame.event !== PROGRESS_EVENT) return;
    const p = (frame.payload ?? {}) as {
      phase?: ScorePhase | "batch-start" | "batch-done";
      shortcode?: string;
      reel?: ReelIntel;
      totals?: IntelTotals;
      tier_distribution?: Record<string, number>;
      total?: number;
    };
    switch (p.phase) {
      case "batch-start":
        this.batchRunning = true;
        this.batchProgress = { done: 0, total: p.total ?? 0 };
        break;
      case "queued":
        if (p.shortcode) this.setPhase(p.shortcode, "queued");
        break;
      case "scoring":
        if (p.shortcode) this.setPhase(p.shortcode, "scoring");
        break;
      case "scored":
        if (p.shortcode) {
          this.setPhase(p.shortcode, "scored");
          if (p.reel) this.spliceReel(p.reel);
          this.applyTotals(p.totals, p.tier_distribution);
          this.flagJustScored(p.shortcode);
          if (this.batchProgress) {
            this.batchProgress = { ...this.batchProgress, done: this.batchProgress.done + 1 };
          }
        }
        break;
      case "failed":
        if (p.shortcode) {
          this.setPhase(p.shortcode, "failed");
          if (this.batchProgress) {
            this.batchProgress = { ...this.batchProgress, done: this.batchProgress.done + 1 };
          }
        }
        break;
      case "batch-done":
        this.batchRunning = false;
        this.applyTotals(p.totals, p.tier_distribution);
        // Let the final bar state linger a moment, then clear.
        setTimeout(() => {
          if (!this.batchRunning) this.batchProgress = null;
        }, 1600);
        break;
    }
  }

  private setPhase(shortcode: string, phase: ScorePhase): void {
    const m = new Map(this.scorePhase);
    m.set(shortcode, phase);
    this.scorePhase = m;
  }

  /** Replace a reel row in the payload (in place by shortcode) and re-render. */
  private spliceReel(reel: ReelIntel): void {
    if (!this.payload) return;
    const reels = this.payload.reels.map((r) =>
      r.shortcode === reel.shortcode ? { ...r, ...reel } : r,
    );
    this.payload = { ...this.payload, reels };
  }

  /** Update header totals + tier distribution live, with a brief flash. */
  private applyTotals(totals?: IntelTotals, dist?: Record<string, number>): void {
    if (!this.payload) return;
    const next: IntelPayload = { ...this.payload };
    if (totals) next.totals = totals;
    if (dist) next.tier_distribution = dist;
    this.payload = next;
    this.scoredFlash = true;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => (this.scoredFlash = false), 700);
  }

  private flagJustScored(shortcode: string): void {
    const s = new Set(this.justScored);
    s.add(shortcode);
    this.justScored = s;
    const prev = this.justScoredTimers.get(shortcode);
    if (prev) clearTimeout(prev);
    this.justScoredTimers.set(
      shortcode,
      setTimeout(() => {
        const s2 = new Set(this.justScored);
        s2.delete(shortcode);
        this.justScored = s2;
        this.justScoredTimers.delete(shortcode);
      }, 1400),
    );
  }

  /** Number of transcribed-but-unscored reels — the batch work size. */
  private get remainingToScore(): number {
    return (this.payload?.reels ?? []).filter((r) => r.has_transcript && !r.has_score).length;
  }

  /** Score a single reel. Animation is driven by the WS progress frames; the
   *  RPC response is a fallback in case events are missed. */
  private async scoreOne(reel: ReelIntel): Promise<void> {
    if (!this.scoringAvailable || this.batchRunning) return;
    const phase = this.scorePhase.get(reel.shortcode);
    if (phase === "queued" || phase === "scoring") return;
    this.setPhase(reel.shortcode, "scoring");
    try {
      const res = await gatewayCall<{
        ok?: boolean;
        reel?: ReelIntel;
        totals?: IntelTotals;
        tier_distribution?: Record<string, number>;
      }>("content.intel.score", { shortcode: reel.shortcode });
      if (res?.ok && res.reel) {
        this.spliceReel(res.reel);
        this.applyTotals(res.totals, res.tier_distribution);
        this.setPhase(reel.shortcode, "scored");
        this.flagJustScored(reel.shortcode);
      } else if (!res?.ok) {
        this.setPhase(reel.shortcode, "failed");
      }
    } catch {
      this.setPhase(reel.shortcode, "failed");
      this.scoringAvailable = false; // method vanished → gate the rest
    }
  }

  /** Kick off a live batch over every transcribed-but-unscored reel. */
  private async scoreAll(): Promise<void> {
    if (!this.scoringAvailable || this.batchRunning || this.remainingToScore === 0) return;
    this.batchRunning = true;
    this.batchProgress = { done: 0, total: this.remainingToScore };
    try {
      await gatewayCall<{ started?: boolean; total?: number }>("content.intel.scoreBatch", {});
      // Progress + completion arrive over the WS channel.
    } catch {
      this.batchRunning = false;
      this.batchProgress = null;
      this.scoringAvailable = false;
    }
  }

  private async cancelBatch(): Promise<void> {
    try {
      await gatewayCall("content.intel.scoreBatchCancel", {});
    } catch {
      /* best-effort */
    }
  }

  private onTranscribeProgress(frame: GatewayEventFrame): void {
    const p = (frame.payload ?? {}) as {
      phase?: string;
      shortcode?: string;
      total?: number;
      index?: number;
    };
    switch (p.phase) {
      case "transcribe-start":
        this.transcribeRunning = true;
        this.transcribeProgress = { done: 0, total: p.total ?? 0 };
        break;
      case "transcribed":
      case "transcribe-failed":
        if (this.transcribeProgress) {
          this.transcribeProgress = {
            ...this.transcribeProgress,
            done: this.transcribeProgress.done + 1,
          };
        }
        break;
      case "transcribe-done":
        this.transcribeRunning = false;
        setTimeout(() => {
          if (!this.transcribeRunning) this.transcribeProgress = null;
        }, 1600);
        void this.load();
        void this.probeScoring();
        break;
    }
  }

  private async transcribeAll(): Promise<void> {
    if (!this.scoringAvailable || this.transcribeRunning || this.remainingToTranscribe === 0) return;
    this.transcribeRunning = true;
    this.transcribeProgress = { done: 0, total: this.remainingToTranscribe };
    try {
      await gatewayCall<{ started?: boolean; total?: number }>("content.intel.transcribeBatch", {});
    } catch {
      this.transcribeRunning = false;
      this.transcribeProgress = null;
    }
  }

  private async cancelTranscribe(): Promise<void> {
    try {
      await gatewayCall("content.intel.transcribeBatchCancel", {});
    } catch {
      /* best-effort */
    }
  }

  private async importCsv(): Promise<void> {
    if (!this.importFilePath.trim() || this.importing) return;
    this.importing = true;
    this.importResult = null;
    try {
      const res = await gatewayCall<{
        file?: string;
        inserted?: number;
        updated?: number;
        errors?: string[];
      }>("content.intel.import", {
        filePath: this.importFilePath.trim(),
        account: this.importAccount.trim() || undefined,
      });
      this.importResult = `Imported: ${res?.inserted ?? 0} new, ${res?.updated ?? 0} updated${res?.errors?.length ? `, ${res.errors.length} errors` : ""}`;
      void this.load();
      void this.loadAccounts();
      void this.probeScoring();
    } catch (e) {
      this.importResult = `Import failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.importing = false;
  }

  private async loadYouTube(): Promise<void> {
    try {
      const [chRes, vidRes] = await Promise.all([
        gatewayCall<{ channels?: YtChannel[] }>("content.intel.youtube.channels", {}),
        gatewayCall<{ videos?: YtVideo[] }>("content.intel.youtube.list", { limit: 200 }),
      ]);
      this.ytChannels = chRes?.channels ?? [];
      this.ytVideos = vidRes?.videos ?? [];
    } catch {
      // YouTube RPCs not available
    }
  }

  private async addYouTubeChannel(): Promise<void> {
    const input = this.ytAddChannelId.trim();
    if (!input || this.ytFetching) return;
    this.ytFetching = true;
    this.ytError = null;
    try {
      const res = await gatewayCall<{ channel?: YtChannel; imported?: number }>(
        "content.intel.youtube.fetch",
        { handle: input, url: input, channelId: input },
      );
      this.ytAddChannelId = "";
      await this.loadYouTube();
    } catch (e) {
      this.ytError = e instanceof Error ? e.message : String(e);
    } finally {
      this.ytFetching = false;
    }
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.error = "";
    try {
      const accountParam = this.selectedAccount || undefined;
      const res = await gatewayCall<IntelPayload>("content.intel.list", {
        limit: 1000,
        ...(accountParam ? { account: accountParam } : {}),
      });
      if (res && Array.isArray(res.reels)) {
        this.payload = res;
        this.source = "live";
        this.loading = false;
        if (res.reels.length > 0) void this.loadInsights();
        return;
      }
      // Empty result — show onboarding empty state (no more snapshot fallback)
      this.payload = res ?? null;
      this.source = "live";
    } catch (e) {
      this.error = `Could not load content intelligence: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.loading = false;
  }

  /** Fetch synthesized AI insights (best-effort; only available live). */
  private async loadInsights(): Promise<void> {
    try {
      const res = await gatewayCall<AiInsightsPayload>("content.intel.insights", {});
      if (res && Array.isArray(res.winners)) this.ai = res;
    } catch {
      // RPC not registered yet (gateway not restarted) — section stays hidden.
    }
  }

  /** Open the detail modal by shortcode (used by AI-insight references). */
  private async openByShortcode(shortcode: string): Promise<void> {
    const reel = (this.payload?.reels ?? []).find((r) => r.shortcode === shortcode);
    if (reel) await this.openDetail(reel);
  }

  /** Open the detail modal for a reel, lazily fetching transcript text. */
  private async openDetail(reel: ReelIntel): Promise<void> {
    this.detail = reel.shortcode;
    if (reel.has_transcript && !reel.transcript && !this.transcripts.has(reel.shortcode)) {
      try {
        const res = await gatewayCall<{ reel: ReelIntel }>("content.intel.get", {
          shortcode: reel.shortcode,
        });
        if (res?.reel?.transcript) {
          const m = new Map(this.transcripts);
          m.set(reel.shortcode, res.reel.transcript);
          this.transcripts = m;
        }
      } catch {
        // RPC not live (snapshot mode) — transcript text unavailable offline.
      }
    }
  }

  private closeDetail(): void {
    this.detail = null;
    this.playing = null;
  }

  private switchSubPage(tab: "overview" | "scripts" | "insights" | "trends"): void {
    this.subPage = tab;
    if (tab === "insights" && !this.ai && this.payload) void this.loadInsights();
    if (tab === "trends") void this.loadTrends();
  }

  // ── Trends state ─────────────────────────────────────────────────────────
  @state() private trendsLoading = false;
  @state() private trendsData: { topics: Array<{ topic: string; volume: string; change: string }>; formats: Array<{ format: string; description: string }>; signals: Array<{ signal: string; detail: string }> } | null = null;

  private async loadTrends(): Promise<void> {
    if (this.trendsData || this.trendsLoading) return;
    this.trendsLoading = true;
    try {
      // Trends come from the content-studio trends aggregator (6h cache);
      // there is no separate content.intel.trends method.
      const res = await gatewayCall<{ bundle?: TrendsBundleLite }>("content.trends.last30days", {});
      const b = res?.bundle;
      if (b) {
        this.trendsData = {
          topics: (b.newsTopics ?? []).map((t) => ({
            topic: t.title,
            volume: `${t.cluster} article${t.cluster === 1 ? "" : "s"}`,
            change: t.source,
          })),
          formats: (b.trendingFormats ?? []).map((f) => ({
            format: f.label,
            description: `${f.mentions} mention${f.mentions === 1 ? "" : "s"}${f.example ? ` · e.g. ${f.example}` : ""}`,
          })),
          signals: (b.socialInsights ?? []).map((i) => ({
            signal: i.title,
            detail: [i.platform, i.community, i.score ? `${i.score} pts` : ""].filter(Boolean).join(" · "),
          })),
        };
      }
    } catch {
      // RPC not available — show a message
    }
    this.trendsLoading = false;
  }

  // ── Sub-page renderers ────────────────────────────────────────────────────
  private renderScriptsPage(): TemplateResult {
    const scoredReels = (this.payload?.reels ?? []).filter((r) => r.has_score);
    const topScripts = scoredReels
      .sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0))
      .slice(0, 20);
    return html`<div class="sub-page">
      <div class="sub-page-head">
        <h2>Scripts</h2>
        <p>Top-scoring reel scripts with full transcripts and scoring breakdowns.</p>
      </div>
      ${topScripts.length === 0
        ? html`<div class="empty">No scored scripts yet. Score some reels first.</div>`
        : html`<div class="scripts-list">
            ${topScripts.map((r) => html`<div class="script-item" @click=${() => this.openDetail(r)}>
              <div class="script-item-tier tier-${tierClass(r.tier ?? "")}">${r.tier ?? "—"}</div>
              <div class="script-item-body">
                <div class="script-item-caption">${truncate(r.description, 80)}</div>
                <div class="script-item-meta">
                  <span>Overall: ${r.overall?.toFixed(1) ?? "—"}</span>
                  <span>Hook: ${r.hook?.toFixed(1) ?? "—"}</span>
                  <span>Value: ${r.value?.toFixed(1) ?? "—"}</span>
                  <span>Viral: ${r.viral?.toFixed(1) ?? "—"}</span>
                  <span>${r.has_transcript ? "✓ Transcript" : "No transcript"}</span>
                </div>
              </div>
              <div class="script-item-arrow">→</div>
            </div>`)}
          </div>`}
    </div>`;
  }

  private renderInsightsPage(): TemplateResult {
    if (!this.ai) {
      return html`<div class="sub-page">
        <div class="sub-page-head">
          <h2>AI Insights</h2>
          <p>Synthesized analysis of your top performers, video ideas, and improvement targets.</p>
        </div>
        <div class="empty">${this.payload ? "Loading insights…" : "No data loaded yet."}</div>
      </div>`;
    }
    return html`<div class="sub-page">
      <div class="sub-page-head">
        <h2>AI Insights</h2>
        <p>Synthesized analysis of your top performers, video ideas, and improvement targets.</p>
      </div>
      ${this.renderAiInsights()}
    </div>`;
  }

  private renderTrendsPage(): TemplateResult {
    return html`<div class="sub-page">
      <div class="sub-page-head">
        <h2>Trends</h2>
        <p>Social signals, trending formats, and emerging content patterns.</p>
      </div>
      ${this.trendsLoading
        ? html`<div class="empty"><span class="spinner"></span> Loading trends…</div>`
        : this.trendsData
          ? html`
            ${this.trendsData.topics.length > 0 ? html`<div class="trends-section">
              <h3>Trending Topics</h3>
              ${this.trendsData.topics.map((t) => html`<div class="trend-item">
                <div class="trend-topic">${t.topic}</div>
                <div class="trend-meta"><span>${t.volume}</span> · <span class=${t.change.startsWith("+") ? "trend-up" : "trend-down"}>${t.change}</span></div>
              </div>`)}
            </div>` : nothing}
            ${this.trendsData.formats.length > 0 ? html`<div class="trends-section">
              <h3>Viral Formats</h3>
              ${this.trendsData.formats.map((f) => html`<div class="trend-item">
                <div class="trend-topic">${f.format}</div>
                <div class="trend-meta">${f.description}</div>
              </div>`)}
            </div>` : nothing}
            ${this.trendsData.signals.length > 0 ? html`<div class="trends-section">
              <h3>Signals</h3>
              ${this.trendsData.signals.map((s) => html`<div class="trend-item">
                <div class="trend-topic">${s.signal}</div>
                <div class="trend-meta">${s.detail}</div>
              </div>`)}
            </div>` : nothing}
          `
          : html`<div class="empty">Trends RPC not available. Set YOUTUBE_API_KEY and restart the gateway.</div>`}
    </div>`;
  }

  private renderAccountModal(): TemplateResult {
    return html`<div class="modal-scrim" @click=${(e: Event) => { if (e.target === e.currentTarget) this.showAccountModal = false; }}>
      <div class="modal-box">
        <div class="modal-head">
          <h2>Manage Accounts</h2>
          <button class="modal-close" aria-label="Close accounts" @click=${() => (this.showAccountModal = false)}>${commIcon("close", 16)}</button>
        </div>
        <div class="modal-body">
          <p class="modal-desc">Instagram accounts are populated automatically when you import CSV data. Use the handle to filter future imports.</p>
          ${this.accounts.length > 0
            ? html`<div class="account-list">
                ${this.accounts.map((a) => html`<div class="account-row">
                  <span class="account-name">@${a.account}</span>
                  <span class="account-stats">${a.count} reels · ${a.scored} scored · ${a.transcribed} transcribed</span>
                </div>`)}
              </div>`
            : html`<div class="empty">No accounts yet. Import a CSV to populate.</div>`}
          <div class="account-add">
            <input
              type="text"
              class="modal-input"
              placeholder="Instagram handle (e.g. yourbrand)"
              .value=${this.newAccountHandle}
              @input=${(e: Event) => (this.newAccountHandle = (e.target as HTMLInputElement).value)}
            />
            <button
              class="action-btn"
              ?disabled=${this.accountAdding || !this.newAccountHandle.trim()}
              @click=${() => this.addAccount()}
            >${this.accountAdding ? "Adding…" : "Add Account"}</button>
          </div>
          ${this.accountError ? html`<div class="import-result import-result--error">${this.accountError}</div>` : nothing}
        </div>
        <div class="modal-foot">
          <button class="action-btn" @click=${() => (this.showAccountModal = false)}>Done</button>
        </div>
      </div>
    </div>`;
  }

  private async addAccount(): Promise<void> {
    const handle = this.newAccountHandle.trim().replace(/^@/, "");
    if (!handle || this.accountAdding) return;
    this.accountAdding = true;
    this.accountError = null;
    try {
      await this.loadAccounts();
      this.newAccountHandle = "";
    } catch (e) {
      this.accountError = e instanceof Error ? e.message : String(e);
    } finally {
      this.accountAdding = false;
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────
  private get filtered(): ReelIntel[] {
    const reels = this.payload?.reels ?? [];
    const q = this.search.trim().toLowerCase();
    let out = reels.filter((r) => {
      if (this.filter === "transcribed" && !r.has_transcript) return false;
      if (this.filter === "untranscribed" && r.has_transcript) return false;
      if (this.filter === "scored" && !r.has_score) return false;
      if (this.filter === "unscored" && r.has_score) return false;
      if (this.tierFilter && tierClass(r.tier ?? "") !== this.tierFilter) return false;
      if (q) {
        const hay = `${r.description ?? ""} ${r.shortcode} ${r.account ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    out = [...out].sort((a, b) => {
      switch (this.sort) {
        case "saves":
          return (b.saves ?? 0) - (a.saves ?? 0);
        case "score":
          return (b.overall ?? -1) - (a.overall ?? -1);
        case "tier":
          return tierRank(a.tier) - tierRank(b.tier) || (b.overall ?? -1) - (a.overall ?? -1);
        case "recent":
          return (b.publish_time ?? "").localeCompare(a.publish_time ?? "");
        case "views":
        default:
          return (b.views ?? 0) - (a.views ?? 0);
      }
    });
    return out;
  }

  // ── Render ─────────────────────────────────────────────────────────────
  render(): TemplateResult {
    if (this.loading) {
      return html`<div class="wrap"><div class="loading"><span class="spinner"></span> Loading content intelligence…</div></div>`;
    }
    if (this.error) {
      return html`<div class="wrap"><div class="empty">${this.error}</div></div>`;
    }

    // Onboarding empty state — no reels yet
    const reelCount = this.payload?.totals?.reels ?? 0;
    if (reelCount === 0 && !this.error) {
      return this.renderOnboarding();
    }

    const totals = this.payload?.totals;
    const reels = this.filtered;
    const detailReel = this.detail
      ? (this.payload?.reels ?? []).find((r) => r.shortcode === this.detail) ?? null
      : null;
    return html`
      <div class="wrap">
        <header class="head">
          <div class="title-row">
            ${/* Page title + "Intelligence" sub-tab come from the Content Pages host. */ ""}
            ${this.source
              ? html`<span class="src src--${this.source}" title="Live data from content.intel.* RPC">● LIVE</span>`
              : nothing}
            ${this.accounts.length > 0
              ? html`<select
                  class="account-select"
                  .value=${this.selectedAccount}
                  @change=${(e: Event) => {
                    this.selectedAccount = (e.target as HTMLSelectElement).value;
                    void this.load();
                  }}
                >
                  <option value="">All accounts</option>
                  ${this.accounts.map(
                    (a) => html`<option value=${a.account}>@${a.account} (${a.count})</option>`,
                  )}
                </select>`
              : nothing}
            <button class="action-btn" @click=${() => (this.showAccountModal = true)}>${commIcon("user", 15)} Accounts</button>
            <button class="action-btn" @click=${() => (this.showImportModal = true)}>${commIcon("inbox", 15)} Import CSV</button>
            <button
              class="action-btn ${this.showYouTube ? "is-on" : ""}"
              @click=${() => {
                this.showYouTube = !this.showYouTube;
                if (this.showYouTube) void this.loadYouTube();
              }}
            >${commIcon("play", 15)} YouTube</button>
          </div>
          <nav class="sub-tabs" data-learn-id="content-intel-subtabs">
            ${(["overview", "scripts", "insights", "trends"] as const).map(
              (tab) => html`<button
                class="sub-tab ${this.subPage === tab ? "is-active" : ""}"
                @click=${() => this.switchSubPage(tab)}
              >${tab === "overview" ? "Overview" : tab === "scripts" ? "Scripts" : tab === "insights" ? "AI Insights" : "Trends"}</button>`,
            )}
          </nav>
          ${totals ? this.renderKpis(totals) : nothing}
          ${this.renderScoreBar()}
          ${this.renderTranscribeBar()}
          ${this.renderSttToggle()}
        </header>

        <div class="cmo-inline" data-learn-id="content-intel-cmo">
          <cmo-chat .client=${getGatewayClient()} integrated></cmo-chat>
        </div>

        ${this.subPage === "overview" ? html`
          ${this.payload ? this.renderVizBand() : nothing}
          ${this.payload ? this.renderInsights() : nothing}
          ${this.ai ? this.renderAiInsights() : nothing}
          ${this.showYouTube ? this.renderYouTubeSection() : nothing}

          <div class="controls">
            <input
              class="search"
              type="text"
              placeholder="Search caption, account, shortcode…"
              .value=${this.search}
              @input=${(e: Event) => (this.search = (e.target as HTMLInputElement).value)}
            />
            <div class="seg">
              ${(["all", "scored", "unscored", "transcribed", "untranscribed"] as FilterMode[]).map(
                (f) => html`<button
                  class="seg-btn ${this.filter === f ? "is-on" : ""}"
                  @click=${() => (this.filter = f)}
                >${f === "untranscribed" ? "no script" : f}</button>`,
              )}
            </div>
            <select class="sort" @change=${(e: Event) => (this.sort = (e.target as HTMLSelectElement).value as typeof this.sort)}>
              <option value="views">Most views</option>
              <option value="saves">Most saves</option>
              <option value="score">Top score</option>
              <option value="tier">By tier</option>
              <option value="recent">Most recent</option>
            </select>
            ${this.renderTierFilter()}
            <span class="count">${reels.length} reels</span>
          </div>

          <div class="grid">
            ${reels.length === 0
              ? html`<div class="empty">No reels match.</div>`
              : reels.map((r) => this.renderCard(r))}
          </div>
        ` : nothing}

        ${this.subPage === "scripts" ? this.renderScriptsPage() : nothing}
        ${this.subPage === "insights" ? this.renderInsightsPage() : nothing}
        ${this.subPage === "trends" ? this.renderTrendsPage() : nothing}
      </div>
      ${detailReel ? this.renderDetailModal(detailReel) : nothing}
      ${this.showImportModal ? this.renderImportModal() : nothing}
      ${this.showAccountModal ? this.renderAccountModal() : nothing}
    `;
  }

  private renderKpis(t: IntelTotals): TemplateResult {
    const kpi = (label: string, val: string, sub?: string) => html`<div class="kpi">
      <div class="kpi-val">${val}</div>
      <div class="kpi-lbl">${label}</div>
      ${sub ? html`<div class="kpi-sub">${sub}</div>` : nothing}
    </div>`;
    const pct = t.reels ? Math.round((t.scored / t.reels) * 100) : 0;
    const scoredKpi = html`<div class="kpi kpi--accent ${this.scoredFlash ? "kpi--flash" : ""}">
      <div class="kpi-val">${t.scored}<span class="kpi-of"> / ${t.reels}</span></div>
      <div class="kpi-lbl">Scored</div>
      <div class="kpi-meter"><span style="width:${pct}%"></span></div>
    </div>`;
    return html`
      <div class="kpis">
        ${kpi("Reels", String(t.reels))}
        ${kpi("Total views", fmt(t.total_views))}
        ${kpi("Total saves", fmt(t.total_saves))}
        ${kpi("Transcribed", `${t.transcribed} / ${t.reels}`)}
        ${scoredKpi}
      </div>
    `;
  }

  private renderTierFilter(): TemplateResult {
    const dist = this.payload?.tier_distribution ?? {};
    const order = ["S", "A", "B", "C", "D", "—"];
    const keys = Object.keys(dist)
      .filter((k) => (dist[k] ?? 0) > 0)
      .sort((a, b) => {
        const ia = order.indexOf(a), ib = order.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
    if (keys.length === 0) return html``;
    return html`<div class="tier-filter">${keys.map((k) => {
      const cls = tierClass(k);
      const on = this.tierFilter === cls;
      return html`<button
        class="tier-chip tier--${cls} ${on ? "is-on" : ""}"
        title="Filter by tier ${k}"
        @click=${() => (this.tierFilter = on ? null : cls)}
      >${k} <b>${dist[k]}</b></button>`;
    })}</div>`;
  }

  private renderScoreBar(): TemplateResult {
    const remaining = this.remainingToScore;
    const prog = this.batchProgress;
    const pct = prog && prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0;

    // Gateway not restarted with the scoring RPCs yet → gated hint.
    if (!this.scoringAvailable) {
      return html`<div class="scorebar">
        <span class="scorebar-hint">
          ◌ Live scoring offline — restart the gateway to enable AI scoring
        </span>
      </div>`;
    }

    if (this.batchRunning) {
      return html`<div class="scorebar scorebar--running">
        <div class="batch-status">
          <span class="pulse-dot"></span>
          <span>Scoring ${prog ? `${prog.done} / ${prog.total}` : "…"}</span>
        </div>
        <div class="batch-track"><div class="batch-fill" style="width:${pct}%"></div></div>
        <button class="score-all-btn cancel" @click=${() => this.cancelBatch()}>Cancel</button>
      </div>`;
    }

    return html`<div class="scorebar">
      <button
        class="score-all-btn"
        ?disabled=${remaining === 0}
        title=${this.hasApiKey ? "" : "No OpenRouter API key configured — scoring may fail"}
        @click=${() => this.scoreAll()}
      >
        <span class="score-all-lightning">${commIcon("bolt", 16)}</span> Score all <b>(${remaining} remaining)</b>
      </button>
      ${this.scoringReady
        ? nothing
        : html`<span class="scorebar-hint scorebar-hint--warn" title=${this.scoringDetail}
            >${commIcon("alert", 14)} ${this.scoringDetail || "scoring not ready — scores may fail"}</span
          >`}
    </div>`;
  }

  // ── Transcribe bar (mirrors score bar) ──────────────────────────────
  private renderTranscribeBar(): TemplateResult {
    if (!this.scoringAvailable) return html``;
    if (this.transcribeRunning) {
      const prog = this.transcribeProgress;
      const pct = prog && prog.total > 0 ? Math.round((prog.done / prog.total) * 100) : 0;
      return html`<div class="scorebar scorebar--running">
        <div class="batch-status">
          <span class="pulse-dot"></span>
          <span>Transcribing ${prog ? `${prog.done} / ${prog.total}` : "…"}</span>
        </div>
        <div class="batch-track"><div class="batch-fill" style="width:${pct}%"></div></div>
        <button class="score-all-btn cancel" @click=${() => this.cancelTranscribe()}>Cancel</button>
      </div>`;
    }
    if (this.remainingToTranscribe === 0) return html``;
    return html`<div class="scorebar">
      <button
        class="score-all-btn transcribe-btn"
        ?disabled=${this.remainingToTranscribe === 0}
        @click=${() => this.transcribeAll()}
      >
        ${commIcon("mic", 16)} Transcribe all <b>(${this.remainingToTranscribe} remaining)</b>
      </button>
    </div>`;
  }

  // ── STT toggle ──────────────────────────────────────────────────────
  private renderSttToggle(): TemplateResult {
    if (!this.scoringAvailable) return html``;
    const modes: SttMode[] = ["auto", "local", "cloud"];
    return html`<div class="stt-toggle">
      <span class="stt-label">STT:</span>
      ${modes.map(
        (m) => html`<button
          class="stt-pill ${this.sttMode === m ? "is-on" : ""}"
          @click=${() => this.setSttMode(m)}
          title=${this.sttLabel || m}
        >${m}</button>`,
      )}
      ${this.sttLabel ? html`<span class="stt-info">${this.sttLabel}</span>` : nothing}
    </div>`;
  }

  // ── Onboarding empty state ──────────────────────────────────────────
  private renderOnboarding(): TemplateResult {
    return html`<div class="wrap">
      <div class="onboarding" data-learn-id="content-intel-onboarding">
        <div class="onboarding-icon">${commIcon("chart", 28)}</div>
        <h1>Welcome to Content Intelligence</h1>
        <p>Import your Instagram CSV export from Meta Business Suite to start analyzing your reels.</p>
        <p class="onboarding-sub">Once imported, you can transcribe, score, and get AI-powered insights.</p>
        <button class="action-btn onboarding-btn" data-learn-id="content-intel-import" @click=${() => (this.showImportModal = true)}>
          ${commIcon("inbox", 16)} Import your first CSV
        </button>
      </div>
    </div>`;
  }

  // ── Import modal ────────────────────────────────────────────────────
  private renderImportModal(): TemplateResult {
    return html`<div class="modal-scrim" @click=${() => (this.showImportModal = false)}>
      <div class="modal-box" @click=${(e: Event) => e.stopPropagation()}>
        <div class="modal-head">
          <h2>Import CSV</h2>
          <button class="modal-close" aria-label="Close import" @click=${() => (this.showImportModal = false)}>${commIcon("close", 16)}</button>
        </div>
        <div class="modal-body">
          <label class="modal-label">
            CSV File Path
            <input
              type="text"
              class="modal-input"
              placeholder="/home/user/Downloads/Jan-01-2026.csv"
              .value=${this.importFilePath}
              @input=${(e: Event) => (this.importFilePath = (e.target as HTMLInputElement).value)}
            />
          </label>
          <label class="modal-label">
            Account (optional — leave empty for all)
            <input
              type="text"
              class="modal-input"
              placeholder="e.g. your_username"
              .value=${this.importAccount}
              @input=${(e: Event) => (this.importAccount = (e.target as HTMLInputElement).value)}
            />
          </label>
          ${this.importResult ? html`<div class="import-result">${this.importResult}</div>` : nothing}
        </div>
        <div class="modal-foot">
          <button class="action-btn" ?disabled=${this.importing || !this.importFilePath.trim()} @click=${() => this.importCsv()}>
            ${this.importing ? "Importing…" : "Import"}
          </button>
        </div>
      </div>
    </div>`;
  }

  // ── YouTube section ─────────────────────────────────────────────────
  private renderYouTubeSection(): TemplateResult {
    return html`<section class="yt-section">
      <div class="yt-head">
        <h2>YouTube Channels</h2>
        <div class="yt-add">
          <input
            type="text"
            class="yt-input"
            placeholder="@handle, channel ID, or URL"
            .value=${this.ytAddChannelId}
            @input=${(e: Event) => (this.ytAddChannelId = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void this.addYouTubeChannel(); }}
          />
          <button class="action-btn" ?disabled=${this.ytFetching} @click=${() => this.addYouTubeChannel()}>
            ${this.ytFetching ? "Fetching…" : "Add Channel"}
          </button>
        </div>
      </div>
      ${this.ytError ? html`<div class="yt-error">${this.ytError}</div>` : nothing}
      ${this.ytChannels.length === 0
        ? html`<div class="empty">No YouTube channels added yet. Enter a handle or URL above to fetch channel data and videos.</div>`
        : html`<div class="yt-channels">
            ${this.ytChannels.map(
              (ch) => html`<div class="yt-channel">
                ${ch.thumbnail_url
                  ? html`<img src=${ch.thumbnail_url} alt="" class="yt-thumb" />`
                  : html`<div class="yt-thumb-placeholder">${commIcon("play", 16)}</div>`}
                <div class="yt-channel-info">
                  <strong>${ch.name || ch.handle || ch.channel_id}</strong>
                  <span>${ch.video_count ?? 0} videos · ${ch.subscriber_count ?? 0} subs</span>
                </div>
              </div>`,
            )}
          </div>`}
      ${this.ytVideos.length > 0
        ? html`<div class="yt-videos">
            <h3>Videos (${this.ytVideos.length})</h3>
            ${this.ytVideos.slice(0, 20).map(
              (v) => html`<div class="yt-video">
                ${v.thumbnail_url
                  ? html`<img src=${v.thumbnail_url} alt="" class="yt-video-thumb" />`
                  : nothing}
                <div class="yt-video-info">
                  <strong>${v.title || v.video_id}</strong>
                  <span>${v.views ?? 0} views · ${v.likes ?? 0} likes</span>
                </div>
              </div>`,
            )}
          </div>`
        : nothing}
    </section>`;
  }

  // ── Data-viz band ────────────────────────────────────────────────────────
  private renderVizBand(): TemplateResult {
    return html`<div class="viz-band">
      ${this.renderDonut()}
      ${this.renderTopSavers()}
      ${this.renderScatter()}
      ${this.renderAggBars()}
    </div>`;
  }

  /** (a) Tier-distribution donut — gold-intensity arcs, scored count in centre. */
  private renderDonut(): TemplateResult {
    const dist = this.payload?.tier_distribution ?? {};
    const order = ["S", "A", "B", "C", "D", "—"];
    const entries = order
      .filter((k) => (dist[k] ?? 0) > 0)
      .map((k) => ({ key: k, val: dist[k] }));
    const total = entries.reduce((s, e) => s + e.val, 0) || 1;
    const scored = this.payload?.totals.scored ?? 0;
    const R = 52, C = 60, SW = 14;
    const circ = 2 * Math.PI * R;
    let offset = 0;
    const segs = entries.map((e) => {
      const frac = e.val / total;
      const len = frac * circ;
      const dash = `${len} ${circ - len}`;
      const glowId = `donut-glow-${tierClass(e.key)}`;
      // Glow layer (slightly thicker, blurred stroke behind)
      const glowSeg = svg`<circle
        cx=${C} cy=${C} r=${R} fill="none"
        stroke=${tierStroke(e.key)} stroke-width=${SW + 6}
        stroke-dasharray=${dash} stroke-dashoffset=${-offset}
        stroke-linecap="butt"
        transform=${`rotate(-90 ${C} ${C})`}
        filter=${`url(#${glowId})`}
        opacity="0.55"
        class="donut-arc-glow"
      ></circle>`;
      const seg = svg`<circle
        cx=${C} cy=${C} r=${R} fill="none"
        stroke=${tierStroke(e.key)} stroke-width=${SW}
        stroke-dasharray=${`${len} ${circ}`}
        stroke-dashoffset=${circ}
        stroke-linecap="butt"
        transform=${`rotate(-90 ${C} ${C})`}
        class="donut-arc"
        style=${`--arc-len:${len};--arc-full:${circ};--arc-offset:${-offset};`}
      ><title>${e.key}: ${e.val}</title></circle>`;
      offset += len;
      return svg`${glowSeg}${seg}`;
    });
    return html`<div class="viz-card viz-card--donut">
      <div class="viz-title">Tier distribution</div>
      <div class="donut-wrap">
        <svg viewBox="0 0 120 120" class="donut">
          <defs>
            <filter id="donut-glow-S" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3.5" result="blur"/>
              <feMerge><feMergeNode in="blur"/><feMergeNode in="blur"/></feMerge>
            </filter>
            <filter id="donut-glow-A" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3.5" result="blur"/>
              <feMerge><feMergeNode in="blur"/><feMergeNode in="blur"/></feMerge>
            </filter>
            <filter id="donut-glow-B" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2.8" result="blur"/>
              <feMerge><feMergeNode in="blur"/><feMergeNode in="blur"/></feMerge>
            </filter>
            <filter id="donut-glow-C" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2.2" result="blur"/>
              <feMerge><feMergeNode in="blur"/></feMerge>
            </filter>
            <filter id="donut-glow-D" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.8" result="blur"/>
              <feMerge><feMergeNode in="blur"/></feMerge>
            </filter>
            <filter id="donut-glow-none" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="1.5" result="blur"/>
              <feMerge><feMergeNode in="blur"/></feMerge>
            </filter>
            <filter id="donut-center-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="3" result="blur"/>
              <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
            <!-- Rotating conic shimmer -->
            <radialGradient id="donut-shimmer" cx="50%" cy="50%" r="50%">
              <stop offset="30%" stop-color="rgba(240,208,137,0)"/>
              <stop offset="75%" stop-color="rgba(240,208,137,0.08)"/>
              <stop offset="100%" stop-color="rgba(240,208,137,0)"/>
            </radialGradient>
          </defs>
          <!-- Track ring -->
          <circle cx=${C} cy=${C} r=${R} fill="none" stroke="rgba(255,255,255,0.05)" stroke-width=${SW}></circle>
          <!-- Rotating shimmer -->
          <circle cx=${C} cy=${C} r=${R} fill="none" stroke="url(#donut-shimmer)" stroke-width=${SW + 8} opacity="0.6" class="donut-shimmer-ring"></circle>
          ${segs}
          <!-- Center number with gold glow -->
          <text x=${C} y=${C - 4} class="donut-num" text-anchor="middle" filter="url(#donut-center-glow)">${scored}</text>
          <text x=${C} y=${C + 12} class="donut-lbl" text-anchor="middle">scored</text>
        </svg>
        <div class="donut-legend">
          ${entries.map(
            (e) => html`<span class="leg"><i class="dot tier--${tierClass(e.key)}"></i>${e.key} <b>${e.val}</b></span>`,
          )}
        </div>
      </div>
    </div>`;
  }

  /** (b) Top performers by saves — horizontal gold bars. */
  private renderTopSavers(): TemplateResult {
    const top = [...(this.payload?.reels ?? [])]
      .filter((r) => (r.saves ?? 0) > 0)
      .sort((a, b) => (b.saves ?? 0) - (a.saves ?? 0))
      .slice(0, 6);
    const max = top[0]?.saves ?? 1;
    return html`<div class="viz-card viz-card--bars">
      <div class="viz-title">Top performers · saves</div>
      <div class="bars">
        ${top.length === 0
          ? html`<div class="viz-empty">No save data.</div>`
          : top.map((r) => {
              const w = Math.max(4, Math.round(((r.saves ?? 0) / max) * 100));
              return html`<button class="bar-row" title=${r.description || r.shortcode} @click=${() => void this.openDetail(r)}>
                <span class="bar-label">${truncate(r.description || r.shortcode, 26)}</span>
                <span class="bar-track">
                  <span class="bar-fill" style="--bar-w:${w}%">
                    <span class="bar-shimmer"></span>
                  </span>
                </span>
                <span class="bar-val">${fmt(r.saves)}</span>
              </button>`;
            })}
      </div>
    </div>`;
  }

  /** (c) Score vs views scatter — log-x views, y overall, gold dots. */
  private renderScatter(): TemplateResult {
    const scored = (this.payload?.reels ?? []).filter((r) => r.has_score && r.overall != null);
    const W = 220, H = 132, PAD_L = 26, PAD_B = 20, PAD_T = 8, PAD_R = 8;
    const views = scored.map((r) => Math.max(1, r.views ?? 1));
    const minLog = Math.log10(Math.min(...(views.length ? views : [1])));
    const maxLog = Math.log10(Math.max(...(views.length ? views : [10])));
    const spanLog = maxLog - minLog || 1;
    const x = (v: number) => PAD_L + ((Math.log10(Math.max(1, v)) - minLog) / spanLog) * (W - PAD_L - PAD_R);
    const y = (o: number) => PAD_T + (1 - o / 10) * (H - PAD_T - PAD_B);
    const gridY = [0, 2.5, 5, 7.5, 10];
    return html`<div class="viz-card viz-card--scatter">
      <div class="viz-title">Score vs views</div>
      <svg viewBox=${`0 0 ${W} ${H}`} class="scatter">
        <defs>
          <filter id="scatter-glow-S" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="3" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="scatter-glow-A" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="2.8" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="scatter-glow-B" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="2.2" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="scatter-glow-C" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="1.8" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="scatter-glow-D" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="1.4" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="scatter-glow-none" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="1.2" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        ${gridY.map(
          (g) => svg`<g>
            <line x1=${PAD_L} y1=${y(g)} x2=${W - PAD_R} y2=${y(g)} class="grid-line grid-line--anim"></line>
            <text x=${PAD_L - 5} y=${y(g) + 3} class="axis-txt" text-anchor="end">${g}</text>
          </g>`,
        )}
        ${scored.length === 0
          ? svg`<text x=${W / 2} y=${H / 2} class="axis-txt" text-anchor="middle">no scored reels yet</text>`
          : scored.map(
              (r) => {
                const tc = tierClass(r.tier ?? "");
                const cx = x(r.views ?? 1);
                const cy = y(r.overall ?? 0);
                return svg`<g class="scatter-dot-group" transform=${`translate(${cx},${cy})`}>
                  <!-- Outer halo -->
                  <circle cx="0" cy="0" r="7" class=${`dot-halo dot-halo-${tc}`} opacity="0.22"></circle>
                  <!-- Mid halo -->
                  <circle cx="0" cy="0" r="5" class=${`dot-halo dot-halo-${tc}`} opacity="0.35"></circle>
                  <!-- Core dot -->
                  <circle cx="0" cy="0" r="3.5" class=${`dot-${tc}`} filter=${`url(#scatter-glow-${tc})`}>
                    <title>${r.shortcode}: ${(r.overall ?? 0).toFixed(1)} · ${fmt(r.views)} views</title>
                  </circle>
                  <!-- Pulse ring (CSS animation) -->
                  <circle cx="0" cy="0" r="3.5" class=${`dot-pulse dot-pulse-${tc}`} opacity="0"></circle>
                </g>`;
              }
            )}
        <text x=${(W + PAD_L) / 2} y=${H - 4} class="axis-txt" text-anchor="middle">views (log) →</text>
      </svg>
    </div>`;
  }

  /** (d) Hook / Value / Viral aggregate — average across scored reels. */
  private renderAggBars(): TemplateResult {
    const scored = (this.payload?.reels ?? []).filter((r) => r.has_score);
    const avg = (sel: (r: ReelIntel) => number | null) => {
      const vals = scored.map(sel).filter((v): v is number => v != null);
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
    };
    const metrics = [
      { label: "Hook", v: avg((r) => r.hook) },
      { label: "Value", v: avg((r) => r.value) },
      { label: "Viral", v: avg((r) => r.viral) },
      { label: "Overall", v: avg((r) => r.overall) },
    ];
    return html`<div class="viz-card viz-card--agg">
      <div class="viz-title">Avg score breakdown</div>
      <div class="agg">
        ${metrics.map(
          (m) => {
            const hpct = Math.round((m.v / 10) * 100);
            return html`<div class="agg-col">
              <div class="agg-bar-wrap">
                <div class="agg-bar" style="--agg-h:${hpct}%;height:${hpct}%">
                  <div class="agg-bar-shimmer"></div>
                  <!-- Floor reflection -->
                  <div class="agg-reflection" style="--agg-h:${hpct}%"></div>
                </div>
              </div>
              <div class="agg-v">${scored.length ? m.v.toFixed(1) : "—"}</div>
              <div class="agg-l">${m.label}</div>
            </div>`;
          },
        )}
      </div>
    </div>`;
  }

  // ── Insight sections ──────────────────────────────────────────────────────
  //
  // Three intelligence panels derived from the ValidatedScore fields
  // (hook/value/viral/overall/tier/reason/idea_vs_execution) joined with live
  // metrics. All numbers are computed from the loaded reel set — no fakes.
  private renderInsights(): TemplateResult {
    const all = this.payload?.reels ?? [];
    const scored = all.filter((r) => r.has_score && r.overall != null);
    return html`<div class="insights">
      ${this.renderTopPerformers(scored)}
      ${this.renderScoreStats(scored, all)}
      ${this.renderActionable(scored, all)}
    </div>`;
  }

  /** (1) Top performers — highest AI-scored reels with their key metrics. */
  private renderTopPerformers(scored: ReelIntel[]): TemplateResult {
    const top = [...scored].sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0)).slice(0, 5);
    return html`<section class="insight-card">
      <div class="insight-title">${commIcon("trophy", 17)} Top performers</div>
      ${top.length === 0
        ? html`<div class="viz-empty">No scored reels yet — run scoring to populate.</div>`
        : html`<ol class="perf-list">
            ${top.map((r, i) => {
              const cls = tierClass(r.tier ?? "");
              return html`<li class="perf-row" @click=${() => void this.openDetail(r)}>
                <span class="perf-rank">${i + 1}</span>
                <span class="perf-badge tier--${cls}">${r.tier ?? "—"}</span>
                <span class="perf-main">
                  <span class="perf-desc">${truncate(r.description || r.shortcode, 40)}</span>
                  <span class="perf-sub">${fmt(r.views)} views · ${fmt(r.saves)} saves</span>
                </span>
                <span class="perf-score">${(r.overall ?? 0).toFixed(1)}</span>
              </li>`;
            })}
          </ol>`}
    </section>`;
  }

  /** (2) Scoring breakdown — coverage, central tendency, sub-score averages. */
  private renderScoreStats(scored: ReelIntel[], all: ReelIntel[]): TemplateResult {
    const n = scored.length;
    const overalls = scored.map((r) => r.overall ?? 0).sort((a, b) => a - b);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
    const median = overalls.length
      ? overalls.length % 2
        ? overalls[(overalls.length - 1) / 2]
        : (overalls[overalls.length / 2 - 1] + overalls[overalls.length / 2]) / 2
      : 0;
    const avgOf = (sel: (r: ReelIntel) => number | null) =>
      mean(scored.map(sel).filter((v): v is number => v != null));
    const coverage = all.length ? Math.round((n / all.length) * 100) : 0;
    const cell = (label: string, val: string) =>
      html`<div class="stat-cell"><div class="sv">${val}</div><div class="sl">${label}</div></div>`;
    return html`<section class="insight-card">
      <div class="insight-title">${commIcon("chart", 17)} Scoring breakdown</div>
      ${n === 0
        ? html`<div class="viz-empty">No scores to summarise yet.</div>`
        : html`<div class="stat-grid">
            ${cell("Coverage", `${coverage}%`)}
            ${cell("Avg overall", mean(overalls).toFixed(1))}
            ${cell("Median", median.toFixed(1))}
            ${cell("Range", `${overalls[0].toFixed(1)}–${overalls[overalls.length - 1].toFixed(1)}`)}
            ${cell("Avg hook", avgOf((r) => r.hook).toFixed(1))}
            ${cell("Avg value", avgOf((r) => r.value).toFixed(1))}
            ${cell("Avg viral", avgOf((r) => r.viral).toFixed(1))}
            ${cell("Scored", `${n} / ${all.length}`)}
          </div>`}
    </section>`;
  }

  /** (3) Actionable insights — patterns + recommendations derived from scores. */
  private renderActionable(scored: ReelIntel[], all: ReelIntel[]): TemplateResult {
    const insights: { icon: string; text: TemplateResult | string }[] = [];

    // Backlog: transcribed-but-unscored work waiting.
    const backlog = all.filter((r) => r.has_transcript && !r.has_score).length;
    if (backlog > 0) {
      insights.push({
        icon: "bolt",
        text: html`<b>${backlog}</b> transcribed ${backlog === 1 ? "reel is" : "reels are"}
          unscored — run <em>Score all</em> to complete the picture.`,
      });
    }

    if (scored.length > 0) {
      // Weakest dimension on average → where to focus production effort.
      const avg = (sel: (r: ReelIntel) => number | null) => {
        const xs = scored.map(sel).filter((v): v is number => v != null);
        return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
      };
      const dims = [
        { k: "hooks", v: avg((r) => r.hook), tip: "rework the first 3 seconds" },
        { k: "value density", v: avg((r) => r.value), tip: "pack more payoff per second" },
        { k: "shareability", v: avg((r) => r.viral), tip: "add a share-worthy moment or CTA" },
      ].sort((a, b) => a.v - b.v);
      const weakest = dims[0];
      insights.push({
        icon: "tag",
        text: html`Weakest dimension is <b>${weakest.k}</b> (avg
          ${weakest.v.toFixed(1)}/10) — ${weakest.tip}.`,
      });

      // Idea > execution: strong score but reach lagged the median → re-promote.
      const views = scored.map((r) => r.views ?? 0).sort((a, b) => a - b);
      const medViews = views.length ? views[Math.floor(views.length / 2)] : 0;
      const underdelivered = scored.filter(
        (r) => (r.overall ?? 0) >= 7 && (r.views ?? 0) < medViews,
      );
      if (underdelivered.length > 0) {
        insights.push({
          icon: "chart",
          text: html`<b>${underdelivered.length}</b> high-scoring
            ${underdelivered.length === 1 ? "reel" : "reels"} (≥7) under-delivered on reach —
            strong ideas worth reposting or boosting.`,
        });
      }

      // Weak hooks dragging otherwise-fine content.
      const weakHooks = scored.filter((r) => (r.hook ?? 10) < 5).length;
      if (weakHooks > 0) {
        insights.push({
          icon: "link",
          text: html`<b>${weakHooks}</b> ${weakHooks === 1 ? "reel has" : "reels have"} a weak
            hook (&lt;5) — the most common reason good content gets scrolled past.`,
        });
      }

      // Winning formula: dominant tier among the top scorers.
      const topTier = scored.filter((r) => (r.overall ?? 0) >= 7).length;
      if (topTier > 0) {
        const pct = Math.round((topTier / scored.length) * 100);
        insights.push({
          icon: "star",
          text: html`<b>${pct}%</b> of scored reels are A/S-tier (≥7) — study these for the
            patterns that work, and make more like them.`,
        });
      }
    }

    if (insights.length === 0) {
      insights.push({ icon: "search", text: "Score some reels to unlock actionable insights." });
    }

    return html`<section class="insight-card">
      <div class="insight-title">${commIcon("bolt", 17)} Actionable insights</div>
      <ul class="action-list">
        ${insights.map(
          (it) => html`<li class="action-row"><span class="action-ico">${commIcon(it.icon, 16)}</span><span>${it.text}</span></li>`,
        )}
      </ul>
    </section>`;
  }

  // ── Thumbnail cards ──────────────────────────────────────────────────────
  /**
   * AI insight sections: why winners win, video ideas, concepts to improve.
   * Sourced from the `content.intel.insights` RPC. Clicking a winner's cover
   * plays it inline (reuses the grid `playing` state).
   */
  private renderAiInsights(): TemplateResult {
    const ai = this.ai!;
    if (ai.scoredCount === 0) return html`<div></div>`;
    const winnerCard = (w: AiInsightWinner) => html`
      <div class="ai-winner">
        <div class="ai-winner-thumb ${this.playing === w.shortcode ? "is-playing" : ""}">
          ${this.playing === w.shortcode && w.video_url
            ? html`<video class="card-video" src=${w.video_url} controls autoplay playsinline
                @error=${() => (this.playing = null)}></video>
              <button class="card-video-close" aria-label="Close video" @click=${() => (this.playing = null)}>${commIcon("close", 14)}</button>`
            : html`
                ${w.thumbnail_url
                  ? html`<img src=${w.thumbnail_url} alt="" loading="lazy" @error=${(e: Event) => ((e.target as HTMLElement).style.display = "none")} />`
                  : html`<div class="thumb-fallback">▰</div>`}
                <button class="card-play" title="Play reel" @click=${() => (this.playing = w.shortcode)}><span class="play-tri">${commIcon("play", 18)}</span></button>
                ${w.tier ? html`<div class="tier-badge tier--${tierClass(w.tier)}"><span class="tier-letter">${w.tier}</span></div>` : nothing}
                ${w.overall != null ? html`<div class="score-pill">${w.overall.toFixed(1)}</div>` : nothing}
              `}
        </div>
        <div class="ai-winner-body">
          <div class="ai-drivers">
            ${w.drivers.map(
              (d) => html`<span class="ai-driver"><b>${d.label}</b> ${d.detail}</span>`,
            )}
          </div>
          ${w.reason ? html`<div class="ai-reason">${w.reason}</div>` : nothing}
          <div class="ai-winner-foot">
            <span>${fmt(w.views)} views</span>
            <a href=${w.url} target="_blank" rel="noopener">${commIcon("share", 12)} Open</a>
          </div>
        </div>
      </div>
    `;
    return html`
      <div class="ai-band">
        ${ai.winners.length
          ? html`<section class="ai-sec ai-sec--winners">
              <div class="ai-sec-title">${commIcon("trophy", 16)} Why winners win</div>
              <div class="ai-winners">${ai.winners.map(winnerCard)}</div>
            </section>`
          : nothing}
        <div class="ai-two">
          ${ai.videoIdeas.length
            ? html`<section class="ai-sec">
                <div class="ai-sec-title">${commIcon("play", 16)} Video ideas</div>
                <div class="ai-list">
                  ${ai.videoIdeas.map(
                    (i) => html`<div class="ai-item ai-item--idea">
                      <div class="ai-item-title">${i.title}</div>
                      <div class="ai-item-detail">${i.rationale}</div>
                      ${i.basedOn.length
                        ? html`<div class="ai-refs">from ${i.basedOn.map((s) => html`<button class="ai-ref" @click=${() => void this.openByShortcode(s)} title="Open ${s}">${s}</button>`)}</div>`
                        : nothing}
                    </div>`,
                  )}
                </div>
              </section>`
            : nothing}
          ${ai.improvements.length
            ? html`<section class="ai-sec">
                <div class="ai-sec-title">${commIcon("edit", 16)} Concepts to improve</div>
                <div class="ai-list">
                  ${ai.improvements.map(
                    (i) => html`<div class="ai-item ai-item--fix">
                      <div class="ai-item-title">${i.title}</div>
                      <div class="ai-item-detail">${i.detail}</div>
                      ${i.examples.length
                        ? html`<div class="ai-refs">e.g. ${i.examples.map((s) => html`<button class="ai-ref" @click=${() => void this.openByShortcode(s)} title="Open ${s}">${s}</button>`)}</div>`
                        : nothing}
                    </div>`,
                  )}
                </div>
              </section>`
            : nothing}
        </div>
      </div>
    `;
  }

  private renderCard(r: ReelIntel): TemplateResult {
    const phase = this.scorePhase.get(r.shortcode);
    const isWorking = phase === "queued" || phase === "scoring";
    const justIn = this.justScored.has(r.shortcode);
    const cls = tierClass(r.tier ?? "");
    const er = engagementRate(r);
    return html`
      <div
        class="card tier-frame--${r.has_score ? cls : "none"} ${isWorking ? "is-scoring" : ""}"
        @click=${() => void this.openDetail(r)}
      >
        <div class="card-thumb ${this.playing === r.shortcode ? "is-playing" : ""}">
          ${this.playing === r.shortcode && r.video_url
            ? html`<video
                class="card-video"
                src=${r.video_url}
                controls
                autoplay
                playsinline
                @click=${(e: Event) => e.stopPropagation()}
                @error=${() => (this.playing = null)}
              ></video>
              <button
                class="card-video-close"
                title="Close player"
                aria-label="Close video"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  this.playing = null;
                }}
              >${commIcon("close", 14)}</button>`
            : html`
                ${r.thumbnail_url
                  ? html`<img src=${r.thumbnail_url} alt="" loading="lazy" @error=${(e: Event) => ((e.target as HTMLElement).style.display = "none")} />`
                  : html`<div class="thumb-fallback">▰</div>`}
                <div class="thumb-shade"></div>
                ${r.video_url
                  ? html`<button
                      class="card-play"
                      title="Play reel"
                      @click=${(e: Event) => {
                        e.stopPropagation();
                        this.playing = r.shortcode;
                      }}
                    ><span class="play-tri">${commIcon("play", 18)}</span></button>`
                  : nothing}

          ${r.has_score && r.tier
            ? html`<div class="tier-badge tier--${cls} ${justIn ? "just-in" : ""}">
                <span class="tier-letter">${r.tier}</span>
              </div>`
            : isWorking
              ? html`<div class="tier-badge tier--working"><span class="tier-shimmer"></span><span class="working-lbl">${phase === "queued" ? "queued" : "scoring"}</span></div>`
              : phase === "failed"
                ? html`<div class="tier-badge tier--failed" title="Scoring failed — retry">!</div>`
                : nothing}

          ${r.has_score && r.overall != null
            ? html`<div class="score-pill">${r.overall.toFixed(1)}</div>`
            : nothing}

          ${r.duration_sec ? html`<div class="dur-badge">${fmtDur(r.duration_sec)}</div>` : nothing}

          ${r.has_score
            ? html`<div class="mini-bars">
                ${miniBar("H", r.hook)}${miniBar("V", r.value)}${miniBar("Vi", r.viral)}
              </div>`
            : nothing}

          <div class="hover-stats">
            <span><b>${fmt(r.views)}</b> views</span>
            <span><b>${fmt(r.saves)}</b> saves</span>
            ${er != null ? html`<span><b>${er.toFixed(1)}%</b> eng</span>` : nothing}
          </div>

          ${r.has_transcript && !r.has_score && this.scoringAvailable && !isWorking
            ? html`<button
                class="score-now"
                ?disabled=${this.batchRunning}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  void this.scoreOne(r);
                }}
              >${phase === "failed" ? "Retry" : html`${commIcon("bolt", 14)} Score now`}</button>`
            : nothing}
              `}
        </div>

        <div class="card-body">
          <div class="card-desc">${renderCaption(r.description)}</div>
          <div class="card-foot">
            <span class="stat"><b>${fmt(r.views)}</b> views</span>
            <span class="stat"><b>${fmt(r.saves)}</b> saves</span>
            <span class="ico ${r.has_transcript ? "ico--on" : "ico--off"}" title=${r.has_transcript ? "transcript available" : "no transcript"}>${r.has_transcript ? "◎ script" : "○ no script"}</span>
          </div>
        </div>
      </div>
    `;
  }

  // ── Detail modal ─────────────────────────────────────────────────────────
  private renderDetailModal(r: ReelIntel): TemplateResult {
    const transcript = r.transcript ?? this.transcripts.get(r.shortcode) ?? null;
    const cls = tierClass(r.tier ?? "");
    return html`
      <div class="modal-scrim" @click=${() => this.closeDetail()}>
        <div class="modal tier-frame--${r.has_score ? cls : "none"}" @click=${(e: Event) => e.stopPropagation()}>
          <button class="modal-close" aria-label="Close reel details" @click=${() => this.closeDetail()}>${commIcon("close", 16)}</button>
          <div class="modal-head">
            <div class="modal-thumb ${this.playing === r.shortcode ? "is-playing" : ""}">
              ${this.playing === r.shortcode && r.video_url
                ? html`<video
                    class="modal-video"
                    src=${r.video_url}
                    controls
                    autoplay
                    playsinline
                    @error=${() => (this.playing = null)}
                  ></video>`
                : html`
                    ${r.thumbnail_url
                      ? html`<img src=${r.thumbnail_url} alt="" @error=${(e: Event) => ((e.target as HTMLElement).style.display = "none")} />`
                      : html`<div class="thumb-fallback">▰</div>`}
                    ${r.video_url
                      ? html`<button
                          class="play-overlay"
                          title="Play reel"
                          @click=${(e: Event) => {
                            e.stopPropagation();
                            this.playing = r.shortcode;
                          }}
                        >
                          <span class="play-tri">${commIcon("play", 18)}</span>
                        </button>`
                      : nothing}
                    ${r.has_score && r.tier ? html`<div class="tier-badge tier--${cls}"><span class="tier-letter">${r.tier}</span></div>` : nothing}
                  `}
            </div>
            <div class="modal-meta">
              <div class="modal-desc">${renderCaption(r.description || "(no caption)")}</div>
              <div class="modal-substats">
                ${r.account ? html`<span>@${r.account}</span>` : nothing}
                ${r.publish_time ? html`<span>${r.publish_time}</span>` : nothing}
                ${r.duration_sec ? html`<span>${fmtDur(r.duration_sec)}</span>` : nothing}
              </div>
              <div class="modal-stats">
                ${stat("views", fmt(r.views))}
                ${stat("reach", fmt(r.reach))}
                ${stat("likes", fmt(r.likes))}
                ${stat("comments", fmt(r.comments))}
                ${stat("shares", fmt(r.shares))}
                ${stat("saves", fmt(r.saves))}
              </div>
            </div>
          </div>

          ${r.has_score
            ? html`<div class="score-grid">
                ${scoreCell("Hook", r.hook)}
                ${scoreCell("Value", r.value)}
                ${scoreCell("Viral", r.viral)}
                ${scoreCell("Overall", r.overall)}
              </div>
              ${r.reason ? html`<p class="reason"><b>Why:</b> ${r.reason}</p>` : nothing}
              ${r.idea_vs_execution ? html`<p class="reason"><b>Idea vs execution:</b> ${r.idea_vs_execution}</p>` : nothing}`
            : r.has_transcript && this.scoringAvailable
              ? html`<button class="score-now score-now--lg" ?disabled=${this.batchRunning} @click=${() => void this.scoreOne(r)}>${commIcon("bolt", 15)} Score this reel</button>`
              : nothing}

          <div class="transcript-block">
            <div class="transcript-label">Transcript ${r.transcript_engine ? html`<span class="eng">(${r.transcript_engine})</span>` : nothing}</div>
            ${transcript
              ? html`<div class="transcript">${transcript}</div>`
              : r.has_transcript
                ? html`<div class="transcript transcript--muted">${this.source === "snapshot" ? "Transcript text is only available with the live RPC (restart the gateway)." : "Loading transcript…"}</div>`
                : html`<div class="transcript transcript--muted">No transcript for this reel yet.</div>`}
          </div>
          <a class="open-link" href=${r.url} target="_blank" rel="noreferrer">${commIcon("share", 13)} Open reel</a>
        </div>
      </div>
    `;
  }

  static styles = css`
    :host { display: block; height: 100%; width: 100%; color: var(--text, #f7f7f7); font-family: var(--font-body, system-ui, sans-serif); }
    .wrap { padding: 20px 24px 60px; max-width: 1360px; margin: 0 auto; }
    .loading, .empty { padding: 60px 20px; text-align: center; color: rgba(247,247,247,0.55); }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(202,164,90,0.3); border-top-color: var(--g-primary, #caa45a); border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .head { margin-bottom: 18px; }
    .title-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    h1 { font-size: 24px; margin: 0; letter-spacing: 0.01em;
      background: linear-gradient(90deg, #f0d089, var(--g-primary, #caa45a) 60%, #8c6f37);
      -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }
    .src { font-size: 11px; padding: 3px 8px; border-radius: 999px; letter-spacing: 0.08em; }
    .src--live { color: #7fd6a0; background: rgba(127,214,160,0.12); border: 1px solid rgba(127,214,160,0.3); }
    .src--snapshot { color: var(--g-primary, #caa45a); background: rgba(202,164,90,0.1); border: 1px solid rgba(202,164,90,0.3); }
    .account { font-size: 13px; color: rgba(247,247,247,0.6); }

    /* ── KPI hero ─────────────────────────────────────────────────────── */
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 16px; }
    .kpi { position: relative; padding: 16px 18px; border-radius: 16px; overflow: hidden;
      background: radial-gradient(120% 120% at 0% 0%, color-mix(in srgb, var(--g-primary, #caa45a) 12%, transparent) 0%, transparent 60%), rgba(255,255,255,0.022);
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 20%, transparent);
      transition: border-color 0.3s, box-shadow 0.3s; }
    .kpi--accent { border-color: color-mix(in srgb, var(--g-primary, #caa45a) 38%, transparent);
      box-shadow: inset 0 0 30px color-mix(in srgb, var(--g-primary, #caa45a) 8%, transparent); }
    .kpi-val { font-size: 26px; font-weight: 800; color: var(--text, #f7f7f7); line-height: 1; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
    .kpi-of { font-size: 16px; font-weight: 600; color: rgba(247,247,247,0.45); }
    .kpi-lbl { font-size: 11px; color: var(--g-primary, #caa45a); margin-top: 7px; text-transform: uppercase; letter-spacing: 0.07em; }
    .kpi-meter { margin-top: 9px; height: 5px; border-radius: 999px; background: rgba(255,255,255,0.07); overflow: hidden; }
    .kpi-meter span { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, color-mix(in srgb, var(--g-primary, #caa45a) 60%, #000), #f0d089); transition: width 0.5s ease; }

    /* ── Viz band ─────────────────────────────────────────────────────── */
    .viz-band { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 14px; margin: 18px 0; }
    .viz-card { padding: 16px; border-radius: 16px;
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));
      border: 1px solid rgba(255,255,255,0.08); min-height: 168px; }
    .viz-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--g-primary, #caa45a); margin-bottom: 12px; }
    .viz-empty { font-size: 12px; color: rgba(247,247,247,0.4); padding: 24px 0; text-align: center; }

    .donut-wrap { display: flex; align-items: center; gap: 14px; }
    .donut { width: 116px; height: 116px; flex-shrink: 0; }
    .donut-num { font-size: 26px; font-weight: 800; fill: var(--text, #f7f7f7); }
    .donut-lbl { font-size: 9px; fill: rgba(247,247,247,0.5); text-transform: uppercase; letter-spacing: 0.08em; }
    .donut-legend { display: flex; flex-direction: column; gap: 5px; }
    .leg { display: flex; align-items: center; gap: 6px; font-size: 12px; color: rgba(247,247,247,0.7); }
    .leg b { color: var(--text); }
    .dot { width: 9px; height: 9px; border-radius: 3px; display: inline-block; }

    .bars { display: flex; flex-direction: column; gap: 9px; }
    .bar-row { display: grid; grid-template-columns: 1fr 84px auto; align-items: center; gap: 9px; background: none; border: none; padding: 0; cursor: pointer; font-family: inherit; text-align: left; }
    .bar-label { font-size: 11px; color: rgba(247,247,247,0.75); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar-track { height: 8px; border-radius: 999px; background: rgba(255,255,255,0.06); overflow: hidden; }
    .bar-fill { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, color-mix(in srgb, var(--g-primary, #caa45a) 55%, #000), #f0d089); box-shadow: 0 0 8px color-mix(in srgb, var(--g-primary, #caa45a) 30%, transparent); }
    .bar-val { font-size: 11px; font-weight: 700; color: var(--g-primary, #caa45a); font-variant-numeric: tabular-nums; }
    .bar-row:hover .bar-label { color: var(--text); }

    .scatter { width: 100%; height: auto; }
    .grid-line { stroke: rgba(255,255,255,0.06); stroke-width: 1; }
    .axis-txt { fill: rgba(247,247,247,0.4); font-size: 8px; }
    .dot-S, .dot-A { fill: #f0d089; filter: drop-shadow(0 0 3px rgba(240,208,137,0.7)); }
    .dot-B { fill: #d8bd84; }
    .dot-C { fill: #b39a64; }
    .dot-D, .dot-none { fill: rgba(247,247,247,0.5); }

    .agg { display: flex; gap: 10px; align-items: flex-end; height: 124px; }
    .agg-col { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; }
    .agg-bar-wrap { flex: 1; width: 100%; display: flex; align-items: flex-end; justify-content: center; }
    .agg-bar { width: 60%; min-height: 4px; border-radius: 6px 6px 0 0;
      background: linear-gradient(180deg, #f0d089, color-mix(in srgb, var(--g-primary, #caa45a) 70%, #000));
      box-shadow: 0 0 12px color-mix(in srgb, var(--g-primary, #caa45a) 28%, transparent); transition: height 0.5s ease; }
    .agg-v { font-size: 14px; font-weight: 800; color: var(--text); margin-top: 6px; font-variant-numeric: tabular-nums; }
    .agg-l { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: rgba(247,247,247,0.5); margin-top: 2px; }

    /* ── Insight sections ─────────────────────────────────────────────── */
    .insights { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 14px; margin: 0 0 18px; }
    .insight-card { padding: 16px 18px; border-radius: 16px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary, #caa45a) 6%, transparent), rgba(255,255,255,0.012));
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 16%, transparent); }
    .insight-title { font-size: 12px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--g-primary, #caa45a); margin-bottom: 12px; font-weight: 600; }

    /* ── AI insight band (winners / ideas / improvements) ─────────────── */
    .ai-band { display: flex; flex-direction: column; gap: 16px; margin: 0 0 22px; }
    .ai-sec { padding: 18px 20px; border-radius: 18px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary, #caa45a) 6%, transparent), rgba(255,255,255,0.012));
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 16%, transparent); }
    .ai-sec-title { font-size: 13px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--g-primary, #caa45a); margin-bottom: 14px; font-weight: 600; }
    .ai-two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .ai-winners { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
    .ai-winner { display: flex; gap: 12px; padding: 10px; border-radius: 14px;
      background: rgba(255,255,255,0.018); border: 1px solid rgba(202,164,90,0.12); }
    .ai-winner-thumb { position: relative; width: 96px; flex: 0 0 96px; aspect-ratio: 4 / 5; border-radius: 10px; overflow: hidden; background: #0c0b08; }
    .ai-winner-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .ai-winner-thumb.is-playing { width: 200px; flex-basis: 200px; aspect-ratio: auto; }
    .ai-winner-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
    .ai-drivers { display: flex; flex-wrap: wrap; gap: 5px; }
    .ai-driver { font-size: 10.5px; padding: 2px 7px; border-radius: 999px; color: var(--text);
      background: color-mix(in srgb, var(--g-primary, #caa45a) 9%, transparent); border: 1px solid rgba(202,164,90,0.2); }
    .ai-driver b { color: var(--g-primary, #caa45a); font-weight: 600; }
    .ai-reason { font-size: 12px; line-height: 1.45; color: color-mix(in srgb, var(--text) 78%, transparent); }
    .ai-winner-foot { display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: color-mix(in srgb, var(--text) 60%, transparent); margin-top: auto; }
    .ai-winner-foot a { color: var(--g-primary, #caa45a); text-decoration: none; }
    .ai-list { display: flex; flex-direction: column; gap: 10px; }
    .ai-item { padding: 12px 14px; border-radius: 12px; background: rgba(255,255,255,0.018);
      border: 1px solid rgba(202,164,90,0.12); border-left: 3px solid var(--g-primary, #caa45a); }
    .ai-item--fix { border-left-color: color-mix(in srgb, var(--g-primary, #caa45a) 55%, #8a6f33); }
    .ai-item-title { font-size: 13.5px; font-weight: 600; color: var(--text); margin-bottom: 4px; }
    .ai-item-detail { font-size: 12px; line-height: 1.5; color: color-mix(in srgb, var(--text) 76%, transparent); }
    .ai-refs { margin-top: 7px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 10.5px; color: color-mix(in srgb, var(--text) 50%, transparent); }
    .ai-ref { font-family: inherit; font-size: 10.5px; padding: 1px 7px; border-radius: 999px; cursor: pointer;
      color: var(--g-primary, #caa45a); background: color-mix(in srgb, var(--g-primary, #caa45a) 8%, transparent); border: 1px solid rgba(202,164,90,0.25); }
    .ai-ref:hover { background: color-mix(in srgb, var(--g-primary, #caa45a) 16%, transparent); }
    @media (max-width: 820px) { .ai-two { grid-template-columns: 1fr; } }

    .perf-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
    .perf-row { display: grid; grid-template-columns: auto auto 1fr auto; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 10px; cursor: pointer; transition: background 0.14s; }
    .perf-row:hover { background: rgba(255,255,255,0.04); }
    .perf-rank { font-size: 12px; font-weight: 800; color: rgba(247,247,247,0.4); width: 14px; text-align: center; font-variant-numeric: tabular-nums; }
    .perf-badge { font-size: 11px; font-weight: 800; width: 22px; height: 22px; border-radius: 7px; display: flex; align-items: center; justify-content: center; }
    .perf-main { min-width: 0; display: flex; flex-direction: column; }
    .perf-desc { font-size: 12.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .perf-sub { font-size: 10.5px; color: rgba(247,247,247,0.5); margin-top: 1px; }
    .perf-score { font-size: 16px; font-weight: 800; color: var(--g-primary, #caa45a); font-variant-numeric: tabular-nums; }

    .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .stat-cell { padding: 9px 6px; border-radius: 10px; text-align: center; background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.06); }
    .stat-cell .sv { font-size: 16px; font-weight: 800; color: var(--text); font-variant-numeric: tabular-nums; }
    .stat-cell .sl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em; color: rgba(247,247,247,0.45); margin-top: 3px; }

    .action-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .action-row { display: flex; gap: 9px; align-items: flex-start; font-size: 12.5px; line-height: 1.45; color: rgba(247,247,247,0.82); }
    .action-row b { color: var(--g-primary, #caa45a); font-weight: 800; }
    .action-row em { color: var(--text); font-style: normal; font-weight: 600; }
    .action-ico { flex-shrink: 0; font-size: 14px; line-height: 1.3; }

    @media (max-width: 520px) { .stat-grid { grid-template-columns: repeat(2, 1fr); } }

    /* ── Controls ─────────────────────────────────────────────────────── */
    .controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
    .search { flex: 1 1 220px; padding: 9px 12px; border-radius: 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); color: var(--text); font-family: inherit; }
    .search:focus { outline: 1px solid var(--g-primary, #caa45a); }
    .seg { display: flex; border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; overflow: hidden; }
    .seg-btn { background: transparent; border: none; color: rgba(247,247,247,0.6); padding: 8px 11px; cursor: pointer; font-size: 12px; text-transform: capitalize; font-family: inherit; white-space: nowrap; }
    .seg-btn.is-on { background: color-mix(in srgb, var(--g-primary, #caa45a) 22%, transparent); color: var(--text); }
    .sort { padding: 8px 10px; border-radius: 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); color: var(--text); font-family: inherit; }
    .tier-filter { display: flex; gap: 6px; flex-wrap: wrap; }
    .tier-chip { font-size: 12px; padding: 5px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.03); cursor: pointer; font-family: inherit; color: rgba(247,247,247,0.8); transition: transform 0.1s, box-shadow 0.15s; }
    .tier-chip b { color: var(--text); }
    .tier-chip:hover { transform: translateY(-1px); }
    .tier-chip.is-on { box-shadow: 0 0 0 1px color-mix(in srgb, var(--g-primary, #caa45a) 60%, transparent), 0 0 12px color-mix(in srgb, var(--g-primary, #caa45a) 25%, transparent); }
    .count { font-size: 12px; color: rgba(247,247,247,0.5); margin-left: auto; }

    /* ── Card grid ────────────────────────────────────────────────────── */
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(208px, 1fr)); gap: 16px; }
    .card { position: relative; border-radius: 16px; overflow: hidden; cursor: pointer;
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.012));
      border: 1px solid rgba(255,255,255,0.08); transition: transform 0.18s ease, box-shadow 0.22s ease, border-color 0.2s; }
    .card::before { content: ""; position: absolute; inset: 0; border-radius: 16px; padding: 1px; pointer-events: none; z-index: 3;
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; opacity: 0.6; }
    .card:hover { transform: translateY(-5px); box-shadow: 0 14px 34px rgba(0,0,0,0.45); }
    .tier-frame--S, .tier-frame--A { border-color: color-mix(in srgb, #f0d089 55%, transparent); }
    .tier-frame--S::before, .tier-frame--A::before { background: linear-gradient(135deg, #f0d089, transparent 60%, #f0d089); opacity: 0.8; }
    .tier-frame--S:hover, .tier-frame--A:hover { box-shadow: 0 14px 38px rgba(0,0,0,0.5), 0 0 22px color-mix(in srgb, #f0d089 32%, transparent); }
    .tier-frame--B { border-color: color-mix(in srgb, #d8bd84 45%, transparent); }
    .tier-frame--B::before { background: linear-gradient(135deg, #d8bd84, transparent 60%); }
    .tier-frame--C { border-color: color-mix(in srgb, #b39a64 38%, transparent); }
    .tier-frame--none { border-color: rgba(255,255,255,0.08); }

    .card-thumb { position: relative; aspect-ratio: 4 / 5; width: 100%; overflow: hidden; background: #0c0b08; }
    .card-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.3s ease; }
    .card:hover .card-thumb img { transform: scale(1.05); }
    .thumb-fallback { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 36px; color: rgba(202,164,90,0.25); }
    .thumb-shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0.35) 0%, transparent 28%, transparent 55%, rgba(0,0,0,0.78) 100%); pointer-events: none; }

    .tier-badge { position: absolute; top: 9px; left: 9px; z-index: 2; display: flex; flex-direction: column; align-items: center; justify-content: center;
      width: 38px; height: 38px; border-radius: 11px; border: 1px solid; backdrop-filter: blur(4px); }
    .tier-letter { font-size: 18px; font-weight: 800; line-height: 1; }
    .tier--S, .tier--A { color: #2a2008; border-color: rgba(240,208,137,0.7); background: linear-gradient(160deg, #f7dd99, #d8b25c); box-shadow: 0 2px 12px rgba(240,208,137,0.4); }
    .tier--B { color: #1c1808; border-color: rgba(216,189,132,0.6); background: linear-gradient(160deg, #dcc488, #b39a64); }
    .tier--C { color: #f0e6cf; border-color: rgba(179,154,100,0.55); background: rgba(120,100,60,0.55); }
    .tier--D, .tier--none { color: rgba(247,247,247,0.55); border-color: rgba(255,255,255,0.18); background: rgba(20,20,20,0.6); }

    .score-pill { position: absolute; top: 9px; right: 9px; z-index: 2; font-size: 13px; font-weight: 800; color: #2a2008;
      padding: 3px 9px; border-radius: 999px; background: linear-gradient(180deg, #f7dd99, var(--g-primary, #caa45a)); box-shadow: 0 2px 8px rgba(0,0,0,0.4); font-variant-numeric: tabular-nums; }
    .dur-badge { position: absolute; bottom: 9px; right: 9px; z-index: 2; font-size: 10px; font-weight: 600; color: var(--text); padding: 2px 7px; border-radius: 6px; background: rgba(0,0,0,0.6); backdrop-filter: blur(3px); font-variant-numeric: tabular-nums; }

    .mini-bars { position: absolute; left: 9px; bottom: 9px; z-index: 2; display: flex; gap: 4px; }
    .mb { display: flex; flex-direction: column-reverse; align-items: center; gap: 2px; }
    .mb-track { width: 5px; height: 26px; border-radius: 3px; background: rgba(0,0,0,0.5); overflow: hidden; display: flex; flex-direction: column-reverse; }
    .mb-fill { width: 100%; border-radius: 3px; background: linear-gradient(0deg, color-mix(in srgb, var(--g-primary, #caa45a) 60%, #000), #f0d089); }
    .mb-lbl { font-size: 7px; color: rgba(255,255,255,0.7); }

    .hover-stats { position: absolute; left: 0; right: 0; bottom: 0; z-index: 1; display: flex; gap: 12px; justify-content: center; padding: 10px;
      font-size: 12px; color: var(--text); opacity: 0; transform: translateY(8px); transition: opacity 0.2s, transform 0.2s; pointer-events: none; }
    .hover-stats b { color: #f0d089; }
    .card:hover .hover-stats { opacity: 1; transform: translateY(0); }
    .card:hover .mini-bars, .card:hover .dur-badge { opacity: 0; transition: opacity 0.18s; }

    .score-now { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); z-index: 4; cursor: pointer; font-family: inherit;
      font-size: 12px; font-weight: 700; color: #1a1505; padding: 7px 14px; border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 60%, transparent);
      background: linear-gradient(180deg, #f0d089, var(--g-primary, #caa45a));
      box-shadow: 0 3px 14px rgba(0,0,0,0.5); white-space: nowrap; transition: transform 0.1s, box-shadow 0.15s; }
    .score-now:hover:not([disabled]) { transform: translateX(-50%) translateY(-2px); box-shadow: 0 6px 20px color-mix(in srgb, var(--g-primary, #caa45a) 45%, transparent); }
    .score-now[disabled] { opacity: 0.5; cursor: not-allowed; }
    .score-now--lg { position: static; transform: none; display: inline-flex; margin: 6px 0 4px; }
    .score-now--lg:hover:not([disabled]) { transform: translateY(-2px); }

    .card-body { padding: 11px 13px 13px; }
    .card-desc { font-size: 12.5px; line-height: 1.42; color: rgba(247,247,247,0.85); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 35px; }
    .card-desc .tag { color: var(--g-primary, #caa45a); }
    .card-foot { display: flex; align-items: center; gap: 12px; margin-top: 9px; font-size: 11px; color: rgba(247,247,247,0.55); flex-wrap: wrap; }
    .card-foot .stat b { color: var(--text); font-weight: 700; }
    .ico { margin-left: auto; font-size: 10px; }
    .ico--on { color: #cdb07a; }
    .ico--off { color: rgba(247,247,247,0.32); }

    /* working / failed badge states */
    .card.is-scoring { border-color: color-mix(in srgb, var(--g-primary, #caa45a) 55%, transparent); animation: rowPulse 1.5s ease-in-out infinite; }
    @keyframes rowPulse { 0%,100% { box-shadow: 0 0 0 0 transparent; } 50% { box-shadow: 0 0 20px color-mix(in srgb, var(--g-primary, #caa45a) 26%, transparent); } }
    .tier-badge.tier--working { position: absolute; overflow: hidden; color: var(--g-primary, #caa45a); width: auto; min-width: 38px; padding: 0 8px; height: 30px; border-radius: 9px;
      border-color: color-mix(in srgb, var(--g-primary, #caa45a) 50%, transparent); background: rgba(15,12,5,0.8); }
    .tier--working .working-lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; z-index: 1; position: relative; }
    .tier-shimmer { position: absolute; inset: 0; background: linear-gradient(110deg, transparent 20%, color-mix(in srgb, var(--g-primary, #caa45a) 35%, transparent) 50%, transparent 80%); background-size: 220% 100%; animation: shimmerSlide 1.1s linear infinite; }
    .tier-badge.tier--failed { color: #e0a04a; border-color: rgba(224,160,74,0.5); background: rgba(40,24,8,0.8); font-size: 18px; font-weight: 800; }
    .tier-badge.just-in { animation: badgeIn 0.6s cubic-bezier(0.22,1.2,0.36,1); }
    @keyframes badgeIn { 0% { transform: scale(0.4) rotate(-8deg); opacity: 0; } 60% { transform: scale(1.12) rotate(2deg); opacity: 1; } 100% { transform: scale(1) rotate(0); } }
    @keyframes shimmerSlide { to { background-position: -200% 0; } }

    /* ── Live scoring bar ─────────────────────────────────────────────── */
    .scorebar { display: flex; align-items: center; gap: 14px; margin-top: 16px; flex-wrap: wrap;
      padding: 12px 14px; border-radius: 14px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary, #caa45a) 8%, transparent), rgba(255,255,255,0.012));
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 22%, transparent); }
    .scorebar--running { border-color: color-mix(in srgb, var(--g-primary, #caa45a) 45%, transparent); }
    .score-all-btn { display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
      font-family: inherit; font-size: 13px; font-weight: 600; color: #1a1505;
      padding: 9px 16px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 60%, transparent);
      background: linear-gradient(180deg, var(--g-primary, #caa45a), color-mix(in srgb, var(--g-primary, #caa45a) 80%, #000));
      box-shadow: 0 2px 10px color-mix(in srgb, var(--g-primary, #caa45a) 25%, transparent); transition: transform 0.1s, box-shadow 0.15s; }
    .score-all-btn b { font-weight: 800; }
    .score-all-btn:hover:not([disabled]) { transform: translateY(-1px); box-shadow: 0 4px 16px color-mix(in srgb, var(--g-primary, #caa45a) 40%, transparent); }
    .score-all-btn[disabled] { opacity: 0.45; cursor: not-allowed; filter: grayscale(0.4); }
    .score-all-btn.cancel { background: rgba(255,255,255,0.06); color: rgba(247,247,247,0.8); border-color: rgba(255,255,255,0.18); box-shadow: none; }
    .scorebar-hint { font-size: 12px; color: rgba(247,247,247,0.5); letter-spacing: 0.02em; }
    .scorebar-hint--warn { color: var(--g-primary, #caa45a); }
    .batch-status { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text); font-variant-numeric: tabular-nums; }
    .batch-track { flex: 1 1 160px; height: 8px; border-radius: 999px; background: rgba(255,255,255,0.07); overflow: hidden; min-width: 120px; }
    .batch-fill { height: 100%; border-radius: 999px; transition: width 0.4s ease;
      background: linear-gradient(90deg, color-mix(in srgb, var(--g-primary, #caa45a) 70%, #000), var(--g-primary, #caa45a)); background-size: 200% 100%; animation: shimmerSlide 1.4s linear infinite; }
    .pulse-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--g-primary, #caa45a); box-shadow: 0 0 0 0 color-mix(in srgb, var(--g-primary, #caa45a) 60%, transparent); animation: pulseDot 1.2s ease-out infinite; }
    @keyframes pulseDot { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--g-primary, #caa45a) 55%, transparent); } 70% { box-shadow: 0 0 0 8px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }

    .kpi--flash { border-color: color-mix(in srgb, var(--g-primary, #caa45a) 60%, transparent); box-shadow: 0 0 18px color-mix(in srgb, var(--g-primary, #caa45a) 30%, transparent); animation: kpiFlash 0.7s ease-out; }
    @keyframes kpiFlash { 0% { transform: scale(1.04); } 100% { transform: scale(1); } }

    /* ── Detail modal ─────────────────────────────────────────────────── */
    .modal-scrim { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 24px;
      background: rgba(4,3,1,0.74); backdrop-filter: blur(6px); animation: fadeIn 0.18s ease; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .modal { position: relative; width: min(720px, 100%); max-height: 86vh; overflow-y: auto; padding: 22px; border-radius: 20px;
      background: linear-gradient(180deg, #14110a, #0c0a06); border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 30%, transparent);
      box-shadow: 0 30px 80px rgba(0,0,0,0.6); animation: modalIn 0.22s cubic-bezier(0.22,1,0.36,1); }
    @keyframes modalIn { from { transform: translateY(14px) scale(0.98); opacity: 0; } to { transform: translateY(0) scale(1); opacity: 1; } }
    .modal-close { position: absolute; top: 14px; right: 14px; z-index: 2; width: 32px; height: 32px; border-radius: 9px; cursor: pointer;
      background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14); color: rgba(247,247,247,0.8); font-size: 14px; }
    .modal-close:hover { background: rgba(255,255,255,0.12); }
    .modal-head { display: flex; gap: 18px; }
    .modal-thumb { position: relative; flex-shrink: 0; width: 150px; aspect-ratio: 4 / 5; border-radius: 14px; overflow: hidden; background: #0c0b08; border: 1px solid rgba(255,255,255,0.1); }
    .modal-thumb img { width: 100%; height: 100%; object-fit: cover; }
    .modal-thumb.is-playing { width: 220px; }
    .modal-video { width: 100%; height: 100%; object-fit: contain; background: #000; display: block; }
    .play-overlay { position: absolute; inset: 0; z-index: 3; display: flex; align-items: center; justify-content: center; cursor: pointer;
      background: radial-gradient(circle at 50% 50%, rgba(0,0,0,0.25), rgba(0,0,0,0.55)); border: none; transition: background 0.18s; }
    .play-overlay:hover { background: radial-gradient(circle at 50% 50%, rgba(0,0,0,0.1), rgba(0,0,0,0.4)); }
    .play-tri { width: 46px; height: 46px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 18px; padding-left: 3px;
      color: #1a1505; background: linear-gradient(180deg, #f7dd99, var(--g-primary, #caa45a)); box-shadow: 0 4px 18px rgba(0,0,0,0.5); transition: transform 0.14s; }
    .play-overlay:hover .play-tri { transform: scale(1.08); }
    /* Inline grid-card player: click a cover to play the reel in place. */
    .card-play { position: absolute; inset: 0; z-index: 4; display: flex; align-items: center; justify-content: center; cursor: pointer;
      background: transparent; border: none; opacity: 0; transition: opacity 0.18s; }
    .card:hover .card-play { opacity: 1; }
    .card-play .play-tri { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 16px; padding-left: 3px;
      color: #1a1505; background: linear-gradient(180deg, #f7dd99, var(--g-primary, #caa45a)); box-shadow: 0 4px 18px rgba(0,0,0,0.55); transition: transform 0.14s; }
    .card-play:hover .play-tri { transform: scale(1.1); }
    .card-thumb.is-playing { background: #000; }
    .card-video { width: 100%; height: 100%; object-fit: contain; background: #000; display: block; }
    .card-video-close { position: absolute; top: 8px; right: 8px; z-index: 5; width: 26px; height: 26px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; font-size: 13px; cursor: pointer;
      color: var(--g-primary, #caa45a); background: rgba(12,11,8,0.82); border: 1px solid rgba(202,164,90,0.4); }
    .card-video-close:hover { background: rgba(0,0,0,0.95); }
    .modal-meta { flex: 1; min-width: 0; }
    .modal-desc { font-size: 14px; line-height: 1.5; color: var(--text); }
    .modal-desc .tag { color: var(--g-primary, #caa45a); }
    .modal-substats { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11px; color: rgba(247,247,247,0.5); margin-top: 8px; }
    .modal-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 14px; }
    .mstat { padding: 8px 10px; border-radius: 10px; background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.07); }
    .mstat .mv { font-size: 15px; font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
    .mstat .ml { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: rgba(247,247,247,0.45); margin-top: 2px; }

    .score-grid { display: flex; gap: 10px; flex-wrap: wrap; margin: 16px 0; }
    .score-cell { flex: 1 1 80px; text-align: center; padding: 12px; border-radius: 12px;
      background: radial-gradient(120% 120% at 50% 0%, color-mix(in srgb, var(--g-primary, #caa45a) 10%, transparent), transparent 70%), rgba(255,255,255,0.025);
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 18%, transparent); }
    .score-cell .v { font-size: 20px; font-weight: 800; color: var(--g-primary, #caa45a); font-variant-numeric: tabular-nums; }
    .score-cell .l { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: rgba(247,247,247,0.5); margin-top: 4px; }
    .reason { font-size: 13px; color: rgba(247,247,247,0.78); line-height: 1.55; margin: 8px 0; }
    .reason b { color: var(--g-primary, #caa45a); }
    .transcript-block { margin-top: 14px; }
    .transcript-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--g-primary, #caa45a); margin-bottom: 6px; }
    .transcript-label .eng { color: rgba(247,247,247,0.4); text-transform: none; }
    .transcript { font-size: 13px; line-height: 1.6; color: rgba(247,247,247,0.82); white-space: pre-wrap; max-height: 280px; overflow-y: auto; padding: 12px; border-radius: 10px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.06); }
    .transcript--muted { color: rgba(247,247,247,0.4); font-style: italic; }
    .open-link { display: inline-block; margin-top: 14px; font-size: 12px; color: var(--g-primary, #caa45a); text-decoration: none; }
    .open-link:hover { text-decoration: underline; }

    @media (max-width: 560px) {
      .modal-head { flex-direction: column; }
      .modal-thumb { width: 120px; }
    }

    /* ═══════════════════════════════════════════════════════════════════
       NEON GLOW ENHANCEMENTS — Premium viz-band & score button effects
       All animations respect prefers-reduced-motion.
    ═══════════════════════════════════════════════════════════════════ */

    /* ── CSS custom props for tier glow colors ── */
    :host {
      --glow-S: #f0d089;
      --glow-A: #f0d089;
      --glow-B: #d8bd84;
      --glow-C: #b39a64;
      --glow-D: #8c7747;
      --glow-none: rgba(180,180,180,0.5);
      --gold: var(--g-primary, #fbbf24);
      --gold-bright: #f7dd99;
      --gold-dim: color-mix(in srgb, var(--gold) 60%, #000);
    }

    /* ── Viz card: elevated premium surface for viz panels ── */
    .viz-card--donut,
    .viz-card--bars,
    .viz-card--scatter,
    .viz-card--agg {
      border: 1px solid color-mix(in srgb, var(--gold) 22%, transparent);
      background: linear-gradient(180deg,
        color-mix(in srgb, var(--gold) 5%, transparent),
        rgba(255,255,255,0.012));
      box-shadow:
        0 0 0 1px color-mix(in srgb, var(--gold) 6%, transparent),
        inset 0 1px 0 color-mix(in srgb, var(--gold) 12%, transparent);
      transition: box-shadow 0.3s, border-color 0.3s;
    }
    .viz-card--donut:hover,
    .viz-card--bars:hover,
    .viz-card--scatter:hover,
    .viz-card--agg:hover {
      border-color: color-mix(in srgb, var(--gold) 38%, transparent);
      box-shadow:
        0 0 22px color-mix(in srgb, var(--gold) 14%, transparent),
        inset 0 1px 0 color-mix(in srgb, var(--gold) 18%, transparent);
    }

    /* ── Donut: arc entrance draw-in via dashoffset animation ── */
    .donut-arc {
      stroke-dasharray: var(--arc-len, 0) 999;
      stroke-dashoffset: var(--arc-full, 999);
      animation: arcDrawIn 0.9s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
      /* Each arc gets a slight staggered delay via nth-of-type */
    }
    .donut-arc:nth-of-type(1) { animation-delay: 0.05s; }
    .donut-arc:nth-of-type(2) { animation-delay: 0.15s; }
    .donut-arc:nth-of-type(3) { animation-delay: 0.25s; }
    .donut-arc:nth-of-type(4) { animation-delay: 0.35s; }
    .donut-arc:nth-of-type(5) { animation-delay: 0.45s; }
    @keyframes arcDrawIn {
      from { stroke-dashoffset: var(--arc-full, 999); }
      to   { stroke-dashoffset: var(--arc-offset, 0); }
    }

    /* Rotating conic shimmer behind donut */
    .donut-shimmer-ring {
      animation: donutShimmerRotate 4s linear infinite;
      transform-origin: 60px 60px;
    }
    @keyframes donutShimmerRotate {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }

    /* Center score number glows gold */
    .donut-num {
      fill: var(--gold-bright, #f7dd99);
      filter: drop-shadow(0 0 6px rgba(240,208,137,0.7)) drop-shadow(0 0 14px rgba(240,208,137,0.35));
      font-weight: 800;
    }

    /* ── Top-savers bars: neon gold fill + shimmer sweep + hover lift ── */
    .bar-track {
      position: relative;
      height: 10px;
      border-radius: 999px;
      background: rgba(255,255,255,0.05);
      overflow: hidden;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
    }
    .bar-fill {
      position: relative;
      display: block;
      height: 100%;
      width: var(--bar-w, 0%);
      border-radius: 999px;
      background: linear-gradient(90deg,
        color-mix(in srgb, var(--gold) 55%, #000),
        var(--gold-bright, #f7dd99));
      box-shadow:
        0 0 6px color-mix(in srgb, var(--gold) 40%, transparent),
        0 0 14px color-mix(in srgb, var(--gold) 22%, transparent);
      transition: width 0.7s cubic-bezier(0.34, 1.56, 0.64, 1);
      overflow: hidden;
      animation: barGrowIn 0.7s cubic-bezier(0.34, 1.56, 0.64, 1) both;
    }
    @keyframes barGrowIn {
      from { width: 0; opacity: 0.4; }
      to   { width: var(--bar-w, 0%); opacity: 1; }
    }
    .bar-shimmer {
      position: absolute;
      inset: 0;
      background: linear-gradient(110deg,
        transparent 20%,
        rgba(255,255,255,0.38) 50%,
        transparent 80%);
      background-size: 220% 100%;
      animation: barShimmerSweep 2.6s ease-in-out infinite;
    }
    @keyframes barShimmerSweep {
      0%   { background-position: 200% 0; }
      60%  { background-position: -60% 0; }
      100% { background-position: -60% 0; }
    }
    .bar-row:hover .bar-fill {
      box-shadow:
        0 0 10px color-mix(in srgb, var(--gold) 60%, transparent),
        0 0 22px color-mix(in srgb, var(--gold) 35%, transparent);
    }
    .bar-row:hover {
      transform: translateY(-1px);
    }

    /* ── Scatter: animated grid lines + dot halos + hover scale ── */
    .grid-line--anim {
      stroke: rgba(255,255,255,0.06);
      stroke-dasharray: 3 4;
      animation: gridLineFade 3s ease-in-out infinite alternate;
    }
    .grid-line--anim:nth-of-type(2) { animation-delay: 0.4s; }
    .grid-line--anim:nth-of-type(3) { animation-delay: 0.8s; }
    .grid-line--anim:nth-of-type(4) { animation-delay: 1.2s; }
    .grid-line--anim:nth-of-type(5) { animation-delay: 1.6s; }
    @keyframes gridLineFade {
      from { stroke-opacity: 0.4; }
      to   { stroke-opacity: 0.12; }
    }

    /* Dot halos — tier-colored */
    .dot-halo-S, .dot-halo-A { fill: var(--glow-S, #f0d089); }
    .dot-halo-B { fill: var(--glow-B, #d8bd84); }
    .dot-halo-C { fill: var(--glow-C, #b39a64); }
    .dot-halo-D { fill: var(--glow-D, #8c7747); }
    .dot-halo-none { fill: var(--glow-none, rgba(180,180,180,0.5)); }

    /* Pulse rings */
    .dot-pulse { fill: none; stroke-width: 1.5; }
    .dot-pulse-S, .dot-pulse-A { stroke: var(--glow-S, #f0d089); animation: dotPulse 2.4s ease-out infinite; }
    .dot-pulse-B { stroke: var(--glow-B, #d8bd84); animation: dotPulse 2.7s ease-out infinite 0.4s; }
    .dot-pulse-C { stroke: var(--glow-C, #b39a64); animation: dotPulse 3s ease-out infinite 0.8s; }
    .dot-pulse-D { stroke: var(--glow-D, #8c7747); animation: dotPulse 3.2s ease-out infinite 1.2s; }
    .dot-pulse-none { stroke: rgba(180,180,180,0.5); animation: dotPulse 3.5s ease-out infinite 1.6s; }
    @keyframes dotPulse {
      0%   { r: 3.5; opacity: 0.7; }
      70%  { r: 9;   opacity: 0; }
      100% { r: 9;   opacity: 0; }
    }

    .scatter-dot-group {
      transition: transform 0.15s ease;
      cursor: crosshair;
    }
    .scatter-dot-group:hover {
      transform: scale(1.6);
    }

    /* ── Agg bars: neon glow gradient + height animation + floor reflection ── */
    .agg-bar {
      position: relative;
      width: 60%;
      min-height: 4px;
      border-radius: 6px 6px 0 0;
      background: linear-gradient(180deg,
        var(--gold-bright, #f7dd99),
        color-mix(in srgb, var(--gold) 70%, #000));
      box-shadow:
        0 0 10px color-mix(in srgb, var(--gold) 40%, transparent),
        0 0 24px color-mix(in srgb, var(--gold) 22%, transparent),
        0 -2px 8px color-mix(in srgb, var(--gold) 18%, transparent);
      overflow: visible;
      animation: aggBarRise 0.8s cubic-bezier(0.34, 1.56, 0.64, 1) both;
      transition: box-shadow 0.3s;
    }
    .agg-bar:nth-child(1) { animation-delay: 0.05s; }
    .agg-bar:nth-child(2) { animation-delay: 0.12s; }
    .agg-bar:nth-child(3) { animation-delay: 0.19s; }
    .agg-bar:nth-child(4) { animation-delay: 0.26s; }
    @keyframes aggBarRise {
      from { height: 0 !important; opacity: 0.3; }
      to   { height: var(--agg-h, 0%); opacity: 1; }
    }
    .agg-col:hover .agg-bar {
      box-shadow:
        0 0 16px color-mix(in srgb, var(--gold) 60%, transparent),
        0 0 36px color-mix(in srgb, var(--gold) 32%, transparent);
    }
    .agg-bar-shimmer {
      position: absolute;
      inset: 0;
      border-radius: 6px 6px 0 0;
      background: linear-gradient(180deg,
        rgba(255,255,255,0.22) 0%,
        rgba(255,255,255,0.05) 50%,
        transparent 100%);
      pointer-events: none;
      animation: aggShimmer 2.8s ease-in-out infinite;
    }
    @keyframes aggShimmer {
      0%, 100% { opacity: 0.6; }
      50%       { opacity: 1; }
    }
    .agg-reflection {
      position: absolute;
      left: 0; right: 0;
      top: 100%;
      height: calc(var(--agg-h, 0%) * 0.3);
      background: linear-gradient(180deg,
        color-mix(in srgb, var(--gold) 18%, transparent),
        transparent 100%);
      border-radius: 0 0 4px 4px;
      opacity: 0.4;
      transform: scaleY(-1);
      pointer-events: none;
    }
    /* Floor line below bars */
    .agg { position: relative; }
    .agg::after {
      content: "";
      position: absolute;
      left: 0; right: 0;
      bottom: 30px; /* above labels */
      height: 1px;
      background: linear-gradient(90deg,
        transparent,
        color-mix(in srgb, var(--gold) 22%, transparent) 30%,
        color-mix(in srgb, var(--gold) 22%, transparent) 70%,
        transparent);
    }

    /* ── Score-all button: intense neon glow + ⚡ pulse + shimmer ── */
    .score-all-btn {
      position: relative;
      overflow: hidden;
      box-shadow:
        0 0 8px  color-mix(in srgb, var(--gold) 55%, transparent),
        0 0 18px color-mix(in srgb, var(--gold) 35%, transparent),
        0 0 36px color-mix(in srgb, var(--gold) 18%, transparent),
        inset 0 1px 0 rgba(255,255,255,0.25);
    }
    .score-all-btn::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(110deg,
        transparent 25%,
        rgba(255,255,255,0.28) 50%,
        transparent 75%);
      background-size: 240% 100%;
      animation: btnShimmer 2.2s ease-in-out infinite;
    }
    @keyframes btnShimmer {
      0%   { background-position: 200% 0; }
      55%  { background-position: -80% 0; }
      100% { background-position: -80% 0; }
    }
    .score-all-btn:hover:not([disabled]) {
      box-shadow:
        0 0 12px  color-mix(in srgb, var(--gold) 75%, transparent),
        0 0 28px  color-mix(in srgb, var(--gold) 50%, transparent),
        0 0 52px  color-mix(in srgb, var(--gold) 28%, transparent),
        inset 0 1px 0 rgba(255,255,255,0.35);
    }
    .score-all-btn[disabled] {
      box-shadow:
        0 0 4px color-mix(in srgb, var(--gold) 18%, transparent);
    }
    /* ⚡ Lightning icon pulse */
    .score-all-lightning {
      display: inline-block;
      animation: lightningPulse 1.4s ease-in-out infinite;
    }
    @keyframes lightningPulse {
      0%, 100% { transform: scale(1)   rotate(0deg);   opacity: 1; }
      35%       { transform: scale(1.3) rotate(-5deg);  opacity: 1; }
      50%       { transform: scale(0.9) rotate(3deg);   opacity: 0.75; }
      65%       { transform: scale(1.15) rotate(-2deg); opacity: 1; }
    }

    /* ── Transcribe button ── */
    .transcribe-btn {
      background: linear-gradient(135deg, color-mix(in srgb, var(--gold) 18%, #1a1a1e), #1a1a1e) !important;
      border-color: color-mix(in srgb, var(--gold) 30%, transparent) !important;
    }

    /* ── STT toggle ── */
    .stt-toggle {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      margin-top: 6px;
    }
    .stt-label { font-size: 11px; opacity: 0.6; margin-right: 4px; }
    .stt-info { font-size: 10px; opacity: 0.5; margin-left: 8px; }
    .stt-pill {
      padding: 3px 10px;
      font-size: 11px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(255,255,255,0.04);
      cursor: pointer;
      color: rgba(255,255,255,0.6);
      transition: all 0.15s;
    }
    .stt-pill.is-on {
      background: color-mix(in srgb, var(--gold) 15%, transparent);
      border-color: var(--gold);
      color: var(--gold);
    }

    /* ── Action buttons ── */
    .action-btn {
      padding: 7px 14px;
      font-size: 12px;
      font-weight: 600;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.04);
      color: rgba(255,255,255,0.85);
      cursor: pointer;
      transition: all 0.15s;
    }
    .action-btn:hover {
      border-color: color-mix(in srgb, var(--gold) 40%, transparent);
      color: var(--gold);
      background: color-mix(in srgb, var(--gold) 8%, transparent);
    }
    .action-btn.is-on {
      border-color: var(--gold);
      color: var(--gold);
      background: color-mix(in srgb, var(--gold) 12%, transparent);
    }
    .action-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    /* ── Account selector ── */
    .account-select {
      padding: 5px 10px;
      font-size: 12px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(0,0,0,0.3);
      color: rgba(255,255,255,0.85);
      cursor: pointer;
    }

    /* ── Onboarding ── */
    .onboarding {
      text-align: center;
      padding: 80px 20px;
      max-width: 500px;
      margin: 0 auto;
    }
    .onboarding-icon { font-size: 48px; margin-bottom: 16px; }
    .onboarding h1 { font-size: 24px; margin-bottom: 8px; }
    .onboarding p { opacity: 0.7; line-height: 1.6; margin-bottom: 4px; }
    .onboarding-sub { font-size: 13px !important; opacity: 0.5 !important; }
    .onboarding-btn {
      margin-top: 24px;
      padding: 12px 24px;
      font-size: 14px;
    }

    /* ── CMO inline panel ── */
    .cmo-inline {
      margin-top: 20px;
      margin-bottom: 28px;
      min-height: 420px;
    }

    /* ── Modal ── */
    .modal-scrim {
      position: fixed;
      inset: 0;
      z-index: 100;
      background: rgba(0,0,0,0.6);
      backdrop-filter: blur(4px);
      display: grid;
      place-items: center;
    }
    .modal-box {
      width: min(480px, calc(100vw - 32px));
      background: linear-gradient(160deg, rgba(20,18,22,0.96), rgba(10,9,12,0.98));
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 14px;
      overflow: hidden;
    }
    .modal-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 18px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .modal-head h2 { font-size: 15px; }
    .modal-close {
      width: 28px; height: 28px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.1);
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
    .modal-close:hover { background: rgba(255,255,255,0.08); }
    .modal-body { padding: 18px; display: flex; flex-direction: column; gap: 14px; }
    .modal-label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      opacity: 0.7;
    }
    .modal-input {
      padding: 10px 12px;
      font-size: 13px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(0,0,0,0.3);
      color: inherit;
      outline: none;
    }
    .modal-input:focus { border-color: var(--gold); }
    .import-result {
      padding: 8px 12px;
      font-size: 12px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--gold) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--gold) 25%, transparent);
    }
    .modal-foot {
      padding: 12px 18px;
      border-top: 1px solid rgba(255,255,255,0.06);
      display: flex;
      justify-content: flex-end;
    }

    /* ── YouTube section ── */
    .yt-section {
      margin-top: 24px;
      padding: 18px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      background: rgba(255,255,255,0.02);
    }
    .yt-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
    .yt-head h2 { font-size: 16px; }
    .yt-add { display: flex; gap: 8px; }
    .yt-input {
      padding: 6px 10px;
      font-size: 12px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(0,0,0,0.3);
      color: inherit;
    }
    .yt-channels { display: flex; flex-wrap: wrap; gap: 12px; }
    .yt-channel {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      background: rgba(0,0,0,0.2);
    }
    .yt-thumb, .yt-thumb-placeholder {
      width: 40px; height: 40px;
      border-radius: 50%;
      object-fit: cover;
      display: grid;
      place-items: center;
      background: rgba(255,255,255,0.06);
    }
    .yt-channel-info strong { display: block; font-size: 13px; }
    .yt-channel-info span { font-size: 11px; opacity: 0.6; }
    .yt-videos { margin-top: 16px; }
    .yt-videos h3 { font-size: 13px; margin-bottom: 8px; opacity: 0.8; }
    .yt-video {
      display: flex;
      gap: 10px;
      padding: 8px;
      margin-bottom: 6px;
      border: 1px solid rgba(255,255,255,0.04);
      border-radius: 6px;
    }
    .yt-video-thumb { width: 80px; height: 45px; border-radius: 4px; object-fit: cover; }
    .yt-video-info strong { display: block; font-size: 12px; }
    .yt-video-info span { font-size: 11px; opacity: 0.6; }
    .yt-error {
      padding: 10px 14px;
      margin-bottom: 12px;
      font-size: 12px;
      color: #fca5a5;
      background: rgba(239, 68, 68, 0.08);
      border: 1px solid rgba(239, 68, 68, 0.2);
      border-radius: 8px;
    }

    /* ── Sub-page tabs ── */
    .sub-tabs {
      display: flex;
      gap: 4px;
      margin-top: 14px;
      padding-bottom: 2px;
    }
    .sub-tab {
      padding: 8px 16px;
      font-size: 12.5px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: color-mix(in srgb, var(--g-fg, #f5f5f4) 55%, transparent);
      background: transparent;
      border: none;
      border-radius: 999px;
      cursor: pointer;
      transition: all 0.18s ease;
    }
    .sub-tab:hover {
      color: var(--g-fg, #f5f5f4);
      background: color-mix(in srgb, var(--g-fg, #f5f5f4) 5%, transparent);
    }
    .sub-tab.is-active {
      color: #0a0a0e;
      background: linear-gradient(135deg, var(--gold), #f59e0b);
      box-shadow: 0 0 14px -4px var(--gold), 0 0 28px -8px color-mix(in srgb, var(--gold) 50%, transparent);
    }

    /* ── Sub-pages ── */
    .sub-page { margin-top: 24px; }
    .sub-page-head { margin-bottom: 20px; }
    .sub-page-head h2 { font-size: 18px; margin-bottom: 4px; }
    .sub-page-head p { font-size: 13px; opacity: 0.6; }

    /* ── Scripts list ── */
    .scripts-list { display: flex; flex-direction: column; gap: 10px; }
    .script-item {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 16px;
      border-radius: 12px;
      background: linear-gradient(160deg, rgba(20,18,22,0.6), rgba(10,9,12,0.7));
      border: 1px solid color-mix(in srgb, var(--gold) 12%, transparent);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .script-item:hover {
      border-color: color-mix(in srgb, var(--gold) 30%, transparent);
      box-shadow: 0 0 16px -6px color-mix(in srgb, var(--gold) 25%, transparent);
      transform: translateY(-1px);
    }
    .script-item-tier {
      width: 36px; height: 36px;
      display: grid; place-items: center;
      border-radius: 10px;
      font-size: 14px; font-weight: 800;
      flex-shrink: 0;
    }
    .script-item-body { flex: 1; min-width: 0; }
    .script-item-caption { font-size: 13px; margin-bottom: 6px; }
    .script-item-meta { display: flex; gap: 12px; font-size: 11px; opacity: 0.6; flex-wrap: wrap; }
    .script-item-arrow { font-size: 16px; opacity: 0.4; }

    /* ── Trends ── */
    .trends-section { margin-bottom: 28px; }
    .trends-section h3 { font-size: 15px; margin-bottom: 12px; color: var(--gold); }
    .trend-item {
      padding: 14px 16px;
      margin-bottom: 8px;
      border-radius: 10px;
      background: linear-gradient(160deg, rgba(20,18,22,0.5), rgba(10,9,12,0.6));
      border: 1px solid color-mix(in srgb, var(--gold) 8%, transparent);
    }
    .trend-topic { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
    .trend-meta { font-size: 12px; opacity: 0.65; }
    .trend-up { color: #4ade80; }
    .trend-down { color: #f87171; }

    /* ── Account modal ── */
    .modal-desc { font-size: 12px; opacity: 0.6; line-height: 1.5; }
    .account-list { display: flex; flex-direction: column; gap: 8px; max-height: 240px; overflow-y: auto; }
    .account-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 14px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--gold) 5%, rgba(0,0,0,0.2));
      border: 1px solid color-mix(in srgb, var(--gold) 10%, transparent);
    }
    .account-name { font-size: 13px; font-weight: 600; color: var(--gold); }
    .account-stats { font-size: 11px; opacity: 0.6; }
    .account-add { display: flex; gap: 8px; margin-top: 12px; }
    .account-add .modal-input { flex: 1; }

    /* ── prefers-reduced-motion: disable all decorative animations ── */
    @media (prefers-reduced-motion: reduce) {
      .donut-arc,
      .donut-shimmer-ring,
      .bar-fill,
      .bar-shimmer,
      .grid-line--anim,
      .dot-pulse-S, .dot-pulse-A, .dot-pulse-B, .dot-pulse-C, .dot-pulse-D, .dot-pulse-none,
      .agg-bar,
      .agg-bar-shimmer,
      .score-all-btn::after,
      .score-all-lightning {
        animation: none !important;
        transition: none !important;
      }
      .donut-arc {
        stroke-dashoffset: var(--arc-offset, 0) !important;
      }
    }
    ${communicationGlassShadowStyles}

    /* Premium glass integration: keep the legacy feature-rich layout, but
       route its visible surfaces and text through the shared theme tokens. */
    :host {
      --gold: var(--glass-gold, var(--g-primary, #d9b45f));
      color: var(--comms-fg);
      font-family: var(--glass-font, var(--font-ui, Inter, "SF Pro Display", -apple-system, sans-serif));
    }
    .wrap { padding-bottom: 48px; }
    .head, .controls, .scorebar, .transcribebar, .stt-toggle {
      border-color: var(--comms-line) !important;
      color: var(--comms-fg);
    }
    .controls, .scorebar, .transcribebar {
      background: var(--glass-sheen), var(--comms-panel) !important;
      border: 1px solid var(--comms-line);
      border-radius: var(--glass-radius, 14px);
      box-shadow: var(--glass-elev-1);
      padding: 10px;
    }
    .kpi, .viz-card, .insight-card, .ai-band, .yt-section, .sub-page,
    .script-item, .trend-item, .ai-item, .ai-winner, .yt-channel, .yt-video,
    .account-row, .perf-row, .stat-cell {
      background: var(--glass-sheen), var(--comms-card) !important;
      border-color: var(--comms-line) !important;
      color: var(--comms-fg);
      box-shadow: var(--glass-elev-1);
    }
    .kpi, .viz-card, .insight-card, .ai-band, .yt-section, .sub-page {
      border-radius: var(--glass-radius, 14px);
    }
    .script-item, .trend-item, .ai-item, .ai-winner, .yt-channel, .yt-video,
    .account-row, .perf-row { border-radius: var(--glass-radius-sm, 10px); }
    .script-item:hover, .trend-item:hover, .ai-item:hover, .ai-winner:hover,
    .yt-channel:hover, .yt-video:hover, .perf-row:hover {
      border-color: var(--comms-line-strong) !important;
      box-shadow: var(--glass-elev-2), var(--glass-glow-soft);
    }
    .search, .sort, .account-select, .yt-input, .modal-input {
      background: color-mix(in srgb, var(--glass-base, #090806) 62%, transparent) !important;
      border-color: var(--comms-line) !important;
      color: var(--comms-fg) !important;
      border-radius: var(--glass-radius-sm, 10px) !important;
    }
    .seg-btn, .tier-filter-btn, .stt-pill, .modal-close, .card-video-close,
    .card-play, .play-overlay, .ai-ref {
      background: var(--glass-sheen), var(--glass-hover) !important;
      border: 1px solid var(--comms-line) !important;
      color: var(--comms-fg-2) !important;
      border-radius: var(--glass-radius-sm, 10px) !important;
    }
    .seg-btn.is-on, .tier-filter-btn.is-on, .stt-pill.is-on, .action-btn.is-on {
      background: var(--glass-gold-tint) !important;
      border-color: var(--comms-line-strong) !important;
      color: var(--comms-gold-hi) !important;
    }
    .sub-page-head, .yt-head, .modal-head, .modal-foot {
      border-color: var(--comms-line) !important;
    }
    .kpi-val, .card-desc, .trend-topic, .script-item-caption, .ai-item-title,
    .modal-desc, .transcript, .yt-channel-info strong, .yt-video-info strong {
      color: var(--comms-fg) !important;
    }
    .loading, .empty, .account, .kpi-of, .kpi-sub, .viz-empty, .donut-lbl,
    .leg, .bar-label, .axis-txt, .agg-l, .perf-meta, .ai-item-detail,
    .ai-winner-foot, .script-item-meta, .trend-meta, .modal-desc,
    .modal-substats, .transcript--muted, .yt-channel-info span, .yt-video-info span,
    .modal-label, .modal-desc, .account-stats, .sub-page-head p {
      color: var(--comms-fg-2) !important;
    }
    .ai-sec-title, .insight-title, .viz-title, .kpi-lbl, .transcript-label,
    .account-name, .trends-section h3 { color: var(--comms-gold) !important; }
    .ai-sec-title, .scorebar-hint, .action-btn, .score-now, .score-all-btn,
    .transcribe-btn, .modal-close, .card-video-close, .card-play, .play-overlay,
    .ai-winner-foot a, .open-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .import-result--error { color: var(--glass-danger, #ef4444); }
    .modal-scrim { background: color-mix(in srgb, var(--glass-base, #090806) 68%, transparent); }
    .modal-box, .modal {
      background: var(--glass-sheen), var(--comms-float) !important;
      color: var(--comms-fg);
    }

    @media (max-width: 520px) {
      .wrap { padding: 8px !important; padding-bottom: 28px !important; }
      .title-row, .controls, .yt-head, .yt-add, .account-add {
        align-items: stretch;
        flex-direction: column;
      }
      .action-btn, .search, .sort, .account-select, .yt-input { width: 100%; min-width: 0; }
      .sub-tabs { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
      .sub-tab { flex: 0 0 auto; min-height: 42px; }
      .seg { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; }
      .seg-btn { min-height: 42px; }
      .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
      .ai-two, .ai-winner { grid-template-columns: minmax(0, 1fr) !important; }
      .ai-winner { flex-direction: column; }
      .ai-winner-thumb { width: 100%; flex-basis: auto; }
      .modal { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); }
      .modal-head { align-items: stretch; flex-direction: column; }
      .modal-thumb { width: 100%; }
      .account-row { align-items: flex-start; flex-direction: column; gap: 4px; }
    }
    @media (prefers-reduced-transparency: reduce) {
      .controls, .scorebar, .transcribebar, .kpi, .viz-card, .insight-card,
      .ai-band, .yt-section, .sub-page, .script-item, .trend-item, .ai-item,
      .ai-winner, .yt-channel, .yt-video, .account-row, .perf-row {
        background: var(--glass-solid) !important;
      }
    }
  `;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function fmt(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDur(sec: number | null | undefined): string {
  if (sec == null || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Engagement rate = (likes+comments+shares+saves) / reach, as a percent. */
function engagementRate(r: ReelIntel): number | null {
  const reach = r.reach ?? r.views;
  if (!reach || reach <= 0) return null;
  const eng = (r.likes ?? 0) + (r.comments ?? 0) + (r.shares ?? 0) + (r.saves ?? 0);
  return (eng / reach) * 100;
}

function tierClass(tier: string): string {
  const t = (tier ?? "").trim().toUpperCase();
  if (t === "S") return "S";
  if (t === "A") return "A";
  if (t === "B") return "B";
  if (t === "C") return "C";
  if (t === "D") return "D";
  return "none";
}

/** Sort rank: S best (0) … none last. */
function tierRank(tier: string | null | undefined): number {
  const order: Record<string, number> = { S: 0, A: 1, B: 2, C: 3, D: 4 };
  return order[(tier ?? "").trim().toUpperCase()] ?? 9;
}

/** Donut/scatter stroke colour — gold-intensity ramp, never rainbow. */
function tierStroke(tier: string): string {
  switch (tierClass(tier)) {
    case "S":
    case "A":
      return "#f0d089";
    case "B":
      return "#d8bd84";
    case "C":
      return "#b39a64";
    case "D":
      return "#8c7747";
    default:
      return "rgba(180,180,180,0.4)";
  }
}

function scoreCell(label: string, v: number | null | undefined): TemplateResult {
  return html`<div class="score-cell"><div class="v">${v != null ? v.toFixed(1) : "—"}</div><div class="l">${label}</div></div>`;
}

function stat(label: string, val: string): TemplateResult {
  return html`<div class="mstat"><div class="mv">${val}</div><div class="ml">${label}</div></div>`;
}

/** A tiny vertical mini-bar (0–10) for the card hook/value/viral overlay. */
function miniBar(label: string, v: number | null | undefined): TemplateResult {
  const pct = v != null ? Math.round((Math.max(0, Math.min(10, v)) / 10) * 100) : 0;
  return html`<span class="mb" title=${`${label}: ${v != null ? v.toFixed(1) : "—"}`}>
    <span class="mb-track"><span class="mb-fill" style="height:${pct}%"></span></span>
    <span class="mb-lbl">${label}</span>
  </span>`;
}

/** Render a caption with hashtags styled in gold. */
function renderCaption(desc: string): TemplateResult {
  const text = desc || "(no caption)";
  const parts = text.split(/(#[\p{L}\p{N}_]+)/u);
  return html`${parts.map((p) =>
    p.startsWith("#") ? html`<span class="tag">${p}</span>` : p,
  )}`;
}

declare global {
  interface HTMLElementTagNameMap {
    "content-intel-view": ContentIntelView;
  }
}

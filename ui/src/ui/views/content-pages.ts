/**
 * Content Pages Hub — host element.
 *
 * Owns three nested levels of UI:
 *   1. List grid (depth-gradient glass cards, one per page)
 *   2. Detail view with 7 tabs (Overview / Scripts / Videos / Content / Ideas
 *      / Analytics / Insights / Connections)
 *   3. Inline 4-step wizard for new-page creation
 *
 * Pulls everything through the gateway (`content.pages.*` methods). Theme
 * tokens consumed from `var(--g-primary)` / `var(--accent)` so palette
 * changes from /appearance re-color the hub without reload.
 */

import { LitElement, html, css, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, state, property } from "lit/decorators.js";
import { PLATFORM_FEATURES, type PlatformFeature, type FeatureConfigField } from './platform-features.js';
import "../components/doc-agent-panel.js";
import "./content-studio/posting.js";
import { communicationGlassShadowStyles, commIcon } from "./communication-glass.js";

// ─── Types (mirror src/content/types.ts) ────────────────────────────────────

type Surface =
  | "instagram"
  | "youtube"
  | "tiktok"
  | "blog"
  | "linkedin"
  | "twitter"
  | "facebook"
  | "newsletter"
  | "podcast"
  | "other";

type PageStatus = "draft" | "active" | "paused" | "archived";
type ChildKind = "scripts" | "videos" | "content" | "ideas" | "series";

interface PageLinks {
  campaignIds: string[];
  productIds: string[];
  funnelIds: string[];
  leadDbId?: string;
  /** Associated sibling pages (kept symmetric by the gateway). */
  pageIds?: string[];
  intelAccount?: string;
  youtubeChannelId?: string;
}

type Stage =
  | "idea"
  | "outlined"
  | "scripted"
  | "filming"
  | "editing"
  | "scheduled"
  | "posted"
  | "shelved";

interface SeriesEpisode {
  id: string;
  title: string;
  seriesName: string;
  season: number | null;
  episode: number | null;
  painPoint: string;
  hook: string;
  whatToShow: string;
  payoff: string;
  stage: Stage;
  targetPublishDate: string | null;
  platformUrl: string | null;
  scriptRowId: string | null;
  contentRowId: string | null;
  repurposeNote: string;
}
interface SeriesGroup {
  name: string;
  seasons: Array<{ season: number | null; episodes: SeriesEpisode[] }>;
  episodeCount: number;
  stageCounts: Partial<Record<Stage, number>>;
}
interface BoardItem {
  kind: "series" | "ideas";
  id: string;
  title: string;
  stage: Stage;
  label: string | null;
  seriesName: string | null;
  scriptRowId: string | null;
  contentRowId: string | null;
}
interface BoardPayload {
  stages: Array<{ id: Stage; name: string; color: string }>;
  columns: Array<{ stage: Stage; name: string; items: BoardItem[] }>;
}
interface PageIntel {
  source: "instagram" | "youtube" | "none";
  linked: boolean;
  account?: string;
  handle?: string | null;
  totals?: { reels: number; scored: number; transcribed: number; views: number; saves: number };
  tiers?: Record<string, number>;
  avgScores?: { hook: number | null; value: number | null; viral: number | null; overall: number | null };
  topReels?: Array<{
    shortcode: string;
    url: string | null;
    description: string | null;
    views: number | null;
    saves: number | null;
    tier: string | null;
    viral: number | null;
  }>;
  channel?: {
    channelId: string;
    name: string | null;
    handle: string | null;
    subscriberCount: number | null;
    videoCount: number | null;
  } | null;
  topVideos?: Array<{ videoId: string; title: string | null; views: number | null }>;
}

const STAGE_ORDER: Stage[] = [
  "idea",
  "outlined",
  "scripted",
  "filming",
  "editing",
  "scheduled",
  "posted",
];
const STAGE_LABEL: Record<Stage, string> = {
  idea: "Idea",
  outlined: "Outlined",
  scripted: "Scripted",
  filming: "Filming",
  editing: "Editing",
  scheduled: "Scheduled",
  posted: "Posted",
  shelved: "Shelved",
};

function nextStageOf(stage: Stage): Stage | null {
  if (stage === "shelved") return "idea";
  const i = STAGE_ORDER.indexOf(stage);
  return i >= 0 && i < STAGE_ORDER.length - 1 ? STAGE_ORDER[i + 1]! : null;
}
interface PageStats {
  followers?: number;
  totalPosts: number;
  monthlyPosts: number;
  engagementRate: number;
  reach30d: number;
  impressions30d: number;
  clicks30d: number;
  conversions30d: number;
  leadsAttributed: number;
  reachSparkline: number[];
  lastPublishedAt?: number | null;
}
interface ContentPage {
  id: string;
  name: string;
  surface: Surface;
  handle?: string;
  url?: string;
  businessId: string;
  ownerAgentId?: string;
  status: PageStatus;
  theme?: { voice?: string; tone?: string; palette?: string };
  goals?: {
    followersTarget?: number;
    monthlyPostsTarget?: number;
    engagementRateTarget?: number;
  };
  links: PageLinks;
  databaseIds: { scripts: string; videos: string; content: string; ideas: string; series?: string };
  stats: PageStats;
  integrations: {
    instagramGraph?: {
      connected: boolean;
      igPageId?: string;
      accessTokenRef?: string;
      accountName?: string;
      profilePictureUrl?: string;
      lastSyncAt?: number;
    };
    manychat?: {
      connected: boolean;
      apiKeyRef?: string;
      defaultFlowId?: string;
      subscriberCount?: number;
    };
  };
  features: Record<string, Record<string, unknown>>;
  createdAt: number;
  updatedAt: number;
}

interface PageInsight {
  id: string;
  category: "performance" | "production" | "ideation" | "attribution" | "cadence";
  severity: "info" | "win" | "warning" | "critical";
  title: string;
  detail: string;
  impact: number;
  action?: { label: string; intent?: string };
  metric?: { label: string; value: string };
}

interface IgStats {
  followers: number;
  reach30d: number;
  impressions30d: number | null;
  reachSparkline: number[];
  topMedia: Array<{
    id: string;
    permalink: string;
    thumbnail?: string;
    reach: number;
    likes: number;
    comments: number;
    saves: number;
  }>;
  fetchedAt: number;
  fromCache: boolean;
  staleFromDisk?: boolean;
  ageMs?: number;
  error?: { code: string; message: string };
}

interface PageStatsMeta {
  igLive: boolean;
  fetchedAt?: number;
  fromCache?: boolean;
  staleFromDisk?: boolean;
  ageMs?: number;
  error?: { code: string; message: string };
}

interface ConnectionNode {
  id: string;
  kind: "page" | "campaign" | "product" | "funnel" | "lead" | "business";
  label: string;
  sub?: string;
  weight?: number;
}
interface ConnectionEdge {
  from: string;
  to: string;
  strength: number;
  label?: string;
}
interface ConnectionsGraph {
  nodes: ConnectionNode[];
  edges: ConnectionEdge[];
}

interface DBProperty {
  id: string;
  name: string;
  type: string;
  config?: { options?: Array<{ id: string; name: string; color?: string }> } | null;
}
interface DBRow {
  id: string;
  databaseId: string;
  title: string;
  values: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}
interface ChildrenPayload {
  databaseId: string;
  properties: DBProperty[];
  rows: DBRow[];
}

interface Business {
  id: string;
  name: string;
}

type DetailTab =
  | "overview"
  | "series"
  | "board"
  | "posting"
  | "scripts"
  | "videos"
  | "content"
  | "ideas"
  | "analytics"
  | "insights"
  | "integrations"
  | "connections";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtNumber(n: number | undefined): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtPct(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtRelative(ms: number | null | undefined): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 0) return "scheduled";
  const days = Math.floor(diff / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function surfaceLabel(s: Surface): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function surfaceIcon(s: Surface): TemplateResult {
  // Recognisable but synthetic SVG marks — no platform brand assets.
  const stroke = "currentColor";
  switch (s) {
    case "instagram":
      return html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke=${stroke} stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="5"/>
        <circle cx="12" cy="12" r="4"/>
        <circle cx="17.5" cy="6.5" r="1" fill="currentColor"/>
      </svg>`;
    case "youtube":
      return html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke=${stroke} stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="5" width="20" height="14" rx="3"/>
        <polygon points="10 9 15 12 10 15" fill="currentColor" stroke="none"/>
      </svg>`;
    case "tiktok":
      return html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke=${stroke} stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 4v9.5a3.5 3.5 0 1 1-3.5-3.5"/>
        <path d="M14 4a4 4 0 0 0 4 4"/>
      </svg>`;
    case "blog":
      return html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke=${stroke} stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 4h12l4 4v12a2 2 0 0 1-2 2H4z"/>
        <path d="M8 10h8M8 14h8M8 18h5"/>
      </svg>`;
    case "linkedin":
      return html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke=${stroke} stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="3"/>
        <path d="M8 10v7M8 7v.01M12 17v-4a2 2 0 0 1 4 0v4M12 17v-7"/>
      </svg>`;
    case "twitter":
      return html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke=${stroke} stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 4l7 9M20 4l-8 10-8 6h4l5-4 5 4h3l-7-8 7-8z"/>
      </svg>`;
    case "facebook":
      return html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke=${stroke} stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="3"/>
        <path d="M14 8h2V5h-2a3 3 0 0 0-3 3v2H9v3h2v6h3v-6h2l1-3h-3V8z"/>
      </svg>`;
    case "newsletter":
      return html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke=${stroke} stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 6h16v12H4z"/><polyline points="4 6 12 13 20 6"/>
      </svg>`;
    case "podcast":
      return html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke=${stroke} stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="3" width="6" height="12" rx="3"/>
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>
      </svg>`;
    default:
      return html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke=${stroke} stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>
      </svg>`;
  }
}

function sparklinePath(points: number[], w: number, h: number): string {
  if (points.length === 0) return "";
  const max = Math.max(...points, 1);
  const step = w / Math.max(1, points.length - 1);
  return points
    .map((v, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(1)} ${(h - (v / max) * h).toFixed(1)}`)
    .join(" ");
}

// ─── Gateway helper — client is supplied as a property on the element ───────

interface GatewayCallable {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  subscribe?: (handler: (evt: { type: string; payload?: unknown }) => void) => () => void;
}

// ─── Element ─────────────────────────────────────────────────────────────────

@customElement("content-pages-hub")
export class ContentPagesHub extends LitElement {
  @property({ attribute: false }) client: GatewayCallable | null = null;

  @state() private pages: ContentPage[] = [];
  @state() private businesses: Business[] = [];
  @state() private selectedPageId: string | null = null;
  @state() private detailTab: DetailTab = "overview";
  @state() private wizardOpen = false;
  @state() private wizardStep = 0;
  @state() private wizardForm: {
    name: string;
    surface: Surface;
    handle: string;
    url: string;
    businessId: string;
    ownerAgentId: string;
    followersTarget: string;
    monthlyPostsTarget: string;
    engagementRateTarget: string;
    campaignIds: string;
    productIds: string;
    funnelIds: string;
    voice: string;
    tone: string;
    palette: string;
  } = this.emptyForm();
  @state() private loading = false;
  @state() private error: string | null = null;
  @state() private childCache: Record<string, ChildrenPayload | undefined> = {};
  @state() private insights: PageInsight[] = [];
  @state() private igStats: IgStats | null = null;
  @state() private graph: ConnectionsGraph | null = null;
  @state() private filterBusinessId: string | null = null;
  @state() private filterSurface: Surface | "all" = "all";
  @state() private search = "";
  @state() private featureModal: { feature: PlatformFeature; pageId: string } | null = null;
  @state() private featureModalValues: Record<string, Record<string, unknown>> = {};
  @state() private featureModalSaving = false;
  @state() private featureModalError: string | null = null;
  @state() private mcConnecting = false;
  @state() private wizardMcApiKey = '';
  @state() private wizardMcStatus: 'idle' | 'connecting' | 'connected' | 'error' = 'idle';
  @state() private wizardMcAccountName = '';
  // ── Instagram setup modal state ──
  @state() private igSetupModal = false;
  @state() private igSetupPage: ContentPage | null = null;
  @state() private igSetupStep = 0; // 0=enter-token, 1=validating/confirm, 2=connected
  @state() private igSetupToken = '';
  @state() private igSetupValidating = false;
  @state() private igSetupError: string | null = null;
  @state() private igSetupProfile: {
    username: string;
    followersCount: number;
    mediaCount: number;
    profilePictureUrl: string;
    biography: string;
  } | null = null;
  @state() private igStatus: {
    connected: boolean;
    accountName?: string;
    igBusinessAccountId?: string;
    tokenExpiresAt?: number;
    daysUntilExpiry?: number | null;
    expiringSoon?: boolean;
    lastSyncAt?: number;
  } | null = null;
  @state() private igStatusLoading = false;
  /** Server truth for ManyChat: a verified, stored API key (manychat.status). */
  @state() private mcStatus: { connected: boolean; accountName?: string | null; subscriberCount?: number | null } | null = null;
  @state() private igDisconnecting = false;
  @state() private igRefreshing = false;
  /** Per-pageId freshness metadata from `content.pages.stats` / live subscribe. */
  @state() private pageStatsMeta: Record<string, PageStatsMeta> = {};
  /** Per-pageId refresh-button spinner state. */
  @state() private pageStatsRefreshing: Record<string, boolean> = {};
  /** Series episodes grouped by series → season, per page id. */
  @state() private seriesCache: Record<string, SeriesGroup[] | undefined> = {};
  /** Stage board (episodes + ideas by stage), per page id. */
  @state() private boardCache: Record<string, BoardPayload | undefined> = {};
  /** Content Intelligence summary for the page's handle, per page id. */
  @state() private intelCache: Record<string, PageIntel | null | undefined> = {};
  /** Row ids with a stage advance in flight. */
  @state() private advancing: Record<string, boolean> = {};
  @state() private stageNotice: string | null = null;
  /** Active SSE-style subscription id (gateway-issued) so we can ignore stale events. */
  private statsSubscriptionId: string | null = null;
  /** Unsubscribe function for the gateway event stream. */
  private statsEventUnsub: (() => void) | null = null;

  /** Client the initial load ran with (reset on disconnect). */
  private loadedFor: GatewayCallable | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    this.loadAll();
  }

  // When the lazy chunk upgrades an element whose `.client` was already set,
  // Lit restores that property only at the first update — after
  // connectedCallback — so the initial load also runs once the client lands.
  protected willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    if (changed.has("client")) this.loadAll();
  }

  private loadAll(): void {
    if (!this.client || this.loadedFor === this.client) return;
    this.loadedFor = this.client;
    void this.loadPages();
    void this.loadBusinesses();
    void this.loadIgStatus();
    void this.loadMcStatus();
    void this.subscribeToStatsStream();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.loadedFor = null;
    if (this.statsEventUnsub) {
      try {
        this.statsEventUnsub();
      } catch {
        // best-effort
      }
      this.statsEventUnsub = null;
    }
    this.statsSubscriptionId = null;
  }

  /** Subscribe to live stats stream for the currently-selected page. */
  private async subscribeToStatsStream(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const pageId = this.selectedPageId;
    if (!pageId) return;
    try {
      const res = await client.request<{ subscriptionId: string; eventName: string }>(
        "content.pages.stats.subscribe",
        { id: pageId },
      );
      this.statsSubscriptionId = res.subscriptionId;
      if (this.statsEventUnsub) this.statsEventUnsub();
      if (typeof client.subscribe === "function") {
        this.statsEventUnsub = client.subscribe((evt: { type: string; payload?: unknown }) => {
          if (evt.type !== res.eventName) return;
          const p = evt.payload as
            | { subscriptionId?: string; pageId?: string; stats?: unknown; meta?: PageStatsMeta }
            | undefined;
          if (!p || p.subscriptionId !== this.statsSubscriptionId) return;
          if (!p.pageId) return;
          if (p.meta) {
            this.pageStatsMeta = { ...this.pageStatsMeta, [p.pageId]: p.meta };
          }
          if (p.stats) {
            this.pages = this.pages.map((pg) =>
              pg.id === p.pageId ? { ...pg, stats: { ...pg.stats, ...(p.stats as object) } } : pg,
            );
          }
        });
      }
    } catch {
      // best-effort — non-fatal if subscribe RPC is unavailable
    }
  }

  /** Manual force-refresh button handler — calls the dedicated gateway method. */
  private async refreshPageStats(pageId: string, ev?: Event): Promise<void> {
    if (ev) {
      ev.stopPropagation();
      ev.preventDefault();
    }
    const client = this.client;
    if (!client) return;
    this.pageStatsRefreshing = { ...this.pageStatsRefreshing, [pageId]: true };
    try {
      const res = await client.request<{ page: ContentPage; meta: PageStatsMeta }>(
        "content.pages.stats.refresh",
        { id: pageId },
      );
      this.pages = this.pages.map((p) => (p.id === pageId ? res.page : p));
      if (res.meta) {
        this.pageStatsMeta = { ...this.pageStatsMeta, [pageId]: res.meta };
      }
    } catch {
      // surfaced via the freshness pill error state on next load
    } finally {
      const next = { ...this.pageStatsRefreshing };
      delete next[pageId];
      this.pageStatsRefreshing = next;
    }
  }

  /** Render the small freshness pill + refresh button for an IG-connected page card. */
  private renderFreshnessPill(page: ContentPage): TemplateResult {
    if (page.integrations?.instagramGraph?.connected !== true) return html`${nothing}`;
    const meta = this.pageStatsMeta[page.id];
    const refreshing = !!this.pageStatsRefreshing[page.id];
    let label = "No data";
    let kind: "live" | "cached" | "stale" = "cached";
    if (meta) {
      const age = meta.ageMs ?? (meta.fetchedAt ? Date.now() - meta.fetchedAt : undefined);
      const ago = age !== undefined ? fmtRelative(Date.now() - age) : "";
      if (meta.error || meta.staleFromDisk) {
        kind = "stale";
        label = `Stale · failed · ${ago}`;
      } else if (meta.fromCache) {
        kind = "cached";
        label = `Cached · ${ago}`;
      } else {
        kind = "live";
        label = `Live · ${ago}`;
      }
    }
    return html`<div class="freshness-row">
      <span class="freshness-pill freshness-pill--${kind}" title=${meta?.error?.message ?? ""}>
        ${label}
      </span>
      <button
        class="freshness-refresh"
        ?disabled=${refreshing}
        @click=${(e: Event) => this.refreshPageStats(page.id, e)}
        title="Force live refresh"
      >
        ${refreshing ? "…" : "↻"}
      </button>
    </div>`;
  }

  // ─── Loaders ───────────────────────────────────────────────────────────

  private async loadPages(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.loading = true;
    this.error = null;
    try {
      const res = await client.request<{ pages: ContentPage[] }>("content.pages.list", {
        includeArchived: false,
      });
      this.pages = res.pages ?? [];
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.loading = false;
    }
  }

  private async loadBusinesses(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const res = await client.request<{ businesses?: Array<{ id: string; name: string }> }>(
        "business.list",
        {},
      );
      this.businesses = res.businesses ?? [];
    } catch {
      this.businesses = [];
    }
  }

  private async openPage(id: string): Promise<void> {
    this.selectedPageId = id;
    this.detailTab = "overview";
    const client = this.client;
    if (!client) return;
    try {
      const refreshed = await client.request<{ page: ContentPage; meta?: PageStatsMeta }>(
        "content.pages.stats",
        { id },
      );
      this.pages = this.pages.map((p) => (p.id === id ? refreshed.page : p));
      if (refreshed.meta) {
        this.pageStatsMeta = { ...this.pageStatsMeta, [id]: refreshed.meta };
      }
    } catch {
      // stats refresh is best-effort
    }
    // Subscribe (or re-subscribe) for live updates on this page.
    void this.subscribeToStatsStream();
    await Promise.all([
      this.loadChildren(id, "scripts"),
      this.loadChildren(id, "videos"),
      this.loadChildren(id, "content"),
      this.loadChildren(id, "ideas"),
      this.loadSeries(id),
      this.loadBoard(id),
      this.loadIntel(id),
      this.loadInsights(id),
      this.loadGraph(id),
    ]);
  }

  private async loadChildren(pageId: string, kind: ChildKind): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const res = await client.request<ChildrenPayload>("content.pages.children.list", {
        pageId,
        kind,
      });
      this.childCache = { ...this.childCache, [`${pageId}:${kind}`]: res };
    } catch {
      // empty child cache for this slot
    }
  }

  private async loadSeries(pageId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const res = await client.request<{ series: SeriesGroup[] }>("content.pages.series.list", {
        pageId,
      });
      this.seriesCache = { ...this.seriesCache, [pageId]: res.series ?? [] };
    } catch {
      this.seriesCache = { ...this.seriesCache, [pageId]: [] };
    }
  }

  private async loadBoard(pageId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const res = await client.request<BoardPayload>("content.pages.board", { pageId });
      this.boardCache = { ...this.boardCache, [pageId]: res };
    } catch {
      // board stays on its previous value
    }
  }

  private async loadIntel(pageId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const res = await client.request<{ intel: PageIntel }>("content.pages.intel", { id: pageId });
      this.intelCache = { ...this.intelCache, [pageId]: res.intel };
    } catch {
      this.intelCache = { ...this.intelCache, [pageId]: null };
    }
  }

  /** Move an episode / idea to its next stage (or `stage`) and refresh. */
  private async advanceStage(
    kind: "series" | "ideas",
    rowId: string,
    stage?: Stage,
  ): Promise<void> {
    const pageId = this.selectedPageId;
    const client = this.client;
    if (!pageId || !client || this.advancing[rowId]) return;
    this.advancing = { ...this.advancing, [rowId]: true };
    try {
      const res = await client.request<{
        result: {
          to: Stage;
          createdScriptRowId: string | null;
          createdContentRowId: string | null;
          repurposeIdeas: Array<{ pageId: string }>;
        };
      }>("content.pages.stage.advance", { pageId, kind, rowId, ...(stage ? { stage } : {}) });
      const r = res.result;
      const extras = [
        r.createdScriptRowId ? "script created" : "",
        r.createdContentRowId ? "logged in Content" : "",
        r.repurposeIdeas.length ? "Reel idea added to linked IG page" : "",
      ].filter(Boolean);
      this.stageNotice = `Moved to ${STAGE_LABEL[r.to]}${extras.length ? ` · ${extras.join(" · ")}` : ""}`;
      await Promise.all([
        this.loadSeries(pageId),
        this.loadBoard(pageId),
        this.loadChildren(pageId, "scripts"),
        this.loadChildren(pageId, "content"),
        this.loadChildren(pageId, "ideas"),
      ]);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      const { [rowId]: _done, ...rest } = this.advancing;
      this.advancing = rest;
    }
  }

  private async linkPage(otherPageId: string, unlink = false): Promise<void> {
    const pageId = this.selectedPageId;
    const client = this.client;
    if (!pageId || !client || !otherPageId) return;
    try {
      const res = await client.request<{ page: ContentPage; other: ContentPage }>(
        "content.pages.link",
        { pageId, otherPageId, unlink },
      );
      this.pages = this.pages.map((p) =>
        p.id === res.page.id ? res.page : p.id === res.other.id ? res.other : p,
      );
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  private async loadInsights(pageId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const res = await client.request<{ insights: PageInsight[]; igStats?: IgStats }>(
        "content.pages.insights",
        { id: pageId },
      );
      this.insights = res.insights ?? [];
      this.igStats = res.igStats ?? null;
    } catch {
      this.insights = [];
      this.igStats = null;
    }
  }

  private async loadGraph(pageId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const res = await client.request<{ graph: ConnectionsGraph }>("content.pages.connections", {
        id: pageId,
      });
      this.graph = res.graph ?? { nodes: [], edges: [] };
    } catch {
      this.graph = { nodes: [], edges: [] };
    }
  }

  private async createChildRow(kind: ChildKind, title: string): Promise<void> {
    const pageId = this.selectedPageId;
    if (!pageId) return;
    const client = this.client;
    if (!client) return;
    try {
      await client.request("content.pages.children.create", { pageId, kind, title });
      await this.loadChildren(pageId, kind);
      await this.loadInsights(pageId);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  private async deleteChildRow(kind: ChildKind, rowId: string): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      await client.request("content.pages.children.delete", { rowId });
      if (this.selectedPageId) await this.loadChildren(this.selectedPageId, kind);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  // ─── Wizard ────────────────────────────────────────────────────────────

  private emptyForm(): ContentPagesHub["wizardForm"] {
    return {
      name: "",
      surface: "instagram",
      handle: "",
      url: "",
      businessId: "",
      ownerAgentId: "",
      followersTarget: "",
      monthlyPostsTarget: "",
      engagementRateTarget: "",
      campaignIds: "",
      productIds: "",
      funnelIds: "",
      voice: "",
      tone: "",
      palette: "",
    };
  }

  private openWizard(): void {
    this.wizardForm = this.emptyForm();
    if (this.businesses[0]) this.wizardForm.businessId = this.businesses[0].id;
    this.wizardStep = 0;
    this.wizardOpen = true;
  }

  private closeWizard(): void {
    this.wizardOpen = false;
  }

  private async submitWizard(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const f = this.wizardForm;
    if (!f.name || !f.businessId) {
      this.error = "Name and business are required";
      return;
    }
    try {
      const goals = {
        followersTarget: f.followersTarget ? Number(f.followersTarget) : undefined,
        monthlyPostsTarget: f.monthlyPostsTarget ? Number(f.monthlyPostsTarget) : undefined,
        engagementRateTarget: f.engagementRateTarget ? Number(f.engagementRateTarget) : undefined,
      };
      const links = {
        campaignIds: f.campaignIds.split(",").map((s) => s.trim()).filter(Boolean),
        productIds: f.productIds.split(",").map((s) => s.trim()).filter(Boolean),
        funnelIds: f.funnelIds.split(",").map((s) => s.trim()).filter(Boolean),
      };
      const theme = { voice: f.voice || undefined, tone: f.tone || undefined, palette: f.palette || undefined };
      const res = await client.request<{ page: ContentPage }>("content.pages.create", {
        name: f.name,
        surface: f.surface,
        handle: f.handle || undefined,
        url: f.url || undefined,
        businessId: f.businessId,
        ownerAgentId: f.ownerAgentId || undefined,
        goals,
        links,
        theme,
        status: "active",
      });
      this.pages = [res.page, ...this.pages];
      this.wizardOpen = false;
      this.selectedPageId = res.page.id;
      this.detailTab = "overview";
      await this.openPage(res.page.id);
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    }
  }

  // ─── Filters ───────────────────────────────────────────────────────────

  private filteredPages(): ContentPage[] {
    const q = this.search.trim().toLowerCase();
    return this.pages.filter((p) => {
      if (this.filterBusinessId && p.businessId !== this.filterBusinessId) return false;
      if (this.filterSurface !== "all" && p.surface !== this.filterSurface) return false;
      if (q && !`${p.name} ${p.handle ?? ""}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  // ─── Render ────────────────────────────────────────────────────────────

  render(): TemplateResult {
    const selected = this.selectedPageId
      ? this.pages.find((p) => p.id === this.selectedPageId) ?? null
      : null;
    return html`
      <div class="hub">
        ${this.renderHeader(selected)}
        ${this.error ? html`<div class="error-bar">${this.error}</div>` : nothing}
        ${selected ? this.renderDetail(selected) : this.renderGrid()}
        ${this.wizardOpen ? this.renderWizard() : nothing}
        ${this.featureModal ? this.renderFeatureModal() : nothing}
        ${this.igSetupModal ? this.renderIgSetupModal() : nothing}
      </div>
      ${selected
        ? html`<doc-agent-panel
            .client=${this.client as any}
            docType="content_page"
            .documentId=${selected.id}
            .title=${selected.name}
            .extra=${`surface=${selected.surface ?? "unknown"} status=${selected.status ?? "unknown"}`}
          ></doc-agent-panel>`
        : nothing}
    `;
  }

  // -- Header -------------------------------------------------------------

  private renderHeader(selected: ContentPage | null): TemplateResult {
    return html`
      <header class="hub-header" data-learn-id="content-pages-header">
        <div class="hub-crumbs">
          <button
            class="crumb-link ${selected ? "crumb-link--clickable" : ""}"
            @click=${() => (this.selectedPageId = null)}
          >
            Content Pages
          </button>
          ${selected
            ? html`<span class="crumb-sep">/</span><span class="crumb-current">${selected.name}</span>`
            : nothing}
        </div>
        <div class="hub-controls">
          ${selected
            ? nothing
            : html`
                <input
                  class="hub-search"
                  data-learn-id="content-pages-search"
                  placeholder="Search pages…"
                  .value=${this.search}
                  @input=${(e: InputEvent) => {
                    this.search = (e.target as HTMLInputElement).value;
                  }}
                />
                <select
                  class="hub-select"
                  data-learn-id="content-pages-business"
                  .value=${this.filterBusinessId ?? ""}
                  @change=${(e: Event) => {
                    const v = (e.target as HTMLSelectElement).value;
                    this.filterBusinessId = v || null;
                  }}
                >
                  <option value="">All businesses</option>
                  ${this.businesses.map((b) => html`<option value=${b.id}>${b.name}</option>`)}
                </select>
                <select
                  class="hub-select"
                  data-learn-id="content-pages-surface"
                  .value=${this.filterSurface}
                  @change=${(e: Event) => {
                    this.filterSurface = (e.target as HTMLSelectElement).value as Surface | "all";
                  }}
                >
                  <option value="all">All surfaces</option>
                  ${(
                    [
                      "instagram",
                      "youtube",
                      "tiktok",
                      "blog",
                      "linkedin",
                      "twitter",
                      "facebook",
                      "newsletter",
                      "podcast",
                      "other",
                    ] as Surface[]
                  ).map((s) => html`<option value=${s}>${surfaceLabel(s)}</option>`)}
                </select>
              `}
          <button class="btn-primary" data-learn-id="content-pages-new" @click=${() => this.openWizard()}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
            New page
          </button>
        </div>
      </header>
    `;
  }

  // -- Grid ---------------------------------------------------------------

  private renderGrid(): TemplateResult {
    const pages = this.filteredPages();
    if (this.loading) {
      return html`<div class="state-empty"><div class="spinner"></div><div>Loading pages…</div></div>`;
    }
    if (pages.length === 0) {
      return html`
        <div class="state-empty" data-learn-id="content-pages-empty">
          <div class="empty-mark">
            <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 6h16v12H4z"/><path d="M4 10h16M9 6v12"/>
            </svg>
          </div>
          <div class="empty-title">No content pages yet</div>
          <div class="empty-sub">A page is one surface — an IG account, a YouTube channel, a blog. Create one to provision its Scripts / Videos / Content / Ideas databases.</div>
          <button class="btn-primary" @click=${() => this.openWizard()}>Create your first page</button>
        </div>
      `;
    }
    return html`<div class="grid">${pages.map((p) => this.renderCard(p))}</div>`;
  }

  private renderCard(page: ContentPage): TemplateResult {
    const sparkline = page.stats.reachSparkline ?? [];
    const path = sparklinePath(sparkline, 140, 32);
    const business = this.businesses.find((b) => b.id === page.businessId);
    return html`
      <button class="card" @click=${() => this.openPage(page.id)}>
        <div class="card-bloom"></div>
        <div class="card-row card-row--top">
          <div class="surface-chip">
            <span class="surface-icon">${surfaceIcon(page.surface)}</span>
            <span class="surface-name">${surfaceLabel(page.surface)}</span>
          </div>
          <span class="status status--${page.status}">${page.status}</span>
        </div>
        <div class="card-name">${page.name}</div>
        <div class="card-sub">
          ${page.handle ? html`<span>${page.handle}</span>` : nothing}
          ${business ? html`<span class="dot">·</span><span>${business.name}</span>` : nothing}
        </div>
        <div class="card-stats">
          ${this.renderStatTile("Followers", fmtNumber(page.stats.followers))}
          ${this.renderStatTile("Posts / mo", fmtNumber(page.stats.monthlyPosts))}
          ${this.renderStatTile("Engagement", fmtPct(page.stats.engagementRate))}
          ${this.renderStatTile("Leads", fmtNumber(page.stats.leadsAttributed))}
        </div>
        <div class="card-spark">
          <svg viewBox="0 0 140 32" preserveAspectRatio="none" width="100%" height="32">
            <defs>
              <linearGradient id="spark-fill-${page.id}" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stop-color="currentColor" stop-opacity="0.32"/>
                <stop offset="100%" stop-color="currentColor" stop-opacity="0"/>
              </linearGradient>
            </defs>
            ${path
              ? html`
                  <path d=${`${path} L 140 32 L 0 32 Z`} fill=${`url(#spark-fill-${page.id})`} stroke="none"/>
                  <path d=${path} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                `
              : nothing}
          </svg>
        </div>
        ${this.renderFreshnessPill(page)}
        <div class="card-foot">
          <span>Last published ${fmtRelative(page.stats.lastPublishedAt ?? null)}</span>
        </div>
      </button>
    `;
  }

  private renderStatTile(label: string, value: string): TemplateResult {
    return html`<div class="stat-tile"><div class="stat-val">${value}</div><div class="stat-lbl">${label}</div></div>`;
  }

  // -- Detail -------------------------------------------------------------

  private renderDetail(page: ContentPage): TemplateResult {
    const tabs: DetailTab[] = [
      "overview",
      "series",
      "board",
      "posting",
      "scripts",
      "videos",
      "content",
      "ideas",
      "analytics",
      "insights",
      "integrations",
      "connections",
    ];
    return html`
      <div class="detail">
        ${this.renderLinkedPages(page)}
        <nav class="detail-tabs">
          ${tabs.map(
            (t) => html`
              <button
                class="detail-tab ${this.detailTab === t ? "is-active" : ""}"
                @click=${() => (this.detailTab = t)}
              >
                ${t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            `,
          )}
        </nav>
        <div class="detail-body">${this.renderDetailBody(page)}</div>
      </div>
    `;
  }

  private renderDetailBody(page: ContentPage): TemplateResult {
    switch (this.detailTab) {
      case "overview":
        return this.renderOverview(page);
      case "series":
        return this.renderSeries(page);
      case "board":
        return this.renderStageBoard(page);
      case "posting":
        return html`<content-posting-panel
          .client=${this.client}
          .pageId=${page.id}
          .pageName=${page.name}
        ></content-posting-panel>`;
      case "scripts":
        return this.renderChildTable(page, "scripts");
      case "videos":
        return this.renderVideosGrid(page);
      case "content":
        return this.renderChildTable(page, "content");
      case "ideas":
        return this.renderIdeasBoard(page);
      case "analytics":
        return this.renderAnalytics(page);
      case "insights":
        return this.renderInsights();
      case "integrations":
        return this.renderIntegrations(page);
      case "connections":
        return this.renderConnections();
    }
  }

  // -- Linked pages ---------------------------------------------------------

  private renderLinkedPages(page: ContentPage): TemplateResult {
    const linkedIds = page.links.pageIds ?? [];
    const linked = linkedIds
      .map((id) => this.pages.find((p) => p.id === id))
      .filter((p): p is ContentPage => Boolean(p));
    const candidates = this.pages.filter((p) => p.id !== page.id && !linkedIds.includes(p.id));
    return html`
      <div class="linked-strip" data-learn-id="content-pages-linked">
        <span class="linked-label">Linked</span>
        ${linked.length === 0
          ? html`<span class="muted linked-none">No linked pages</span>`
          : linked.map(
              (p) => html`
                <span class="linked-chip">
                  <button
                    class="linked-open"
                    title=${`Open ${p.name}`}
                    @click=${() => this.openPage(p.id)}
                  >
                    <span class="linked-icon">${surfaceIcon(p.surface)}</span>
                    <span class="linked-handle">${p.handle || p.name}</span>
                    <span class="linked-surface">${surfaceLabel(p.surface)}</span>
                  </button>
                  <button
                    class="linked-x"
                    title="Unlink"
                    aria-label=${`Unlink ${p.name}`}
                    @click=${() => this.linkPage(p.id, true)}
                  >×</button>
                </span>
              `,
            )}
        ${candidates.length
          ? html`<select
              class="hub-select linked-add"
              aria-label="Link another page"
              @change=${(e: Event) => {
                const sel = e.target as HTMLSelectElement;
                const v = sel.value;
                sel.value = "";
                if (v) void this.linkPage(v);
              }}
            >
              <option value="">+ Link page</option>
              ${candidates.map(
                (p) =>
                  html`<option value=${p.id}>${p.name}${p.handle ? ` (${p.handle})` : ""} · ${surfaceLabel(p.surface)}</option>`,
              )}
            </select>`
          : nothing}
      </div>
    `;
  }

  // -- Content Intelligence panel -----------------------------------------

  private renderIntelPanel(page: ContentPage): TemplateResult | typeof nothing {
    const intel = this.intelCache[page.id];
    if (page.surface !== "instagram" && page.surface !== "youtube") return nothing;
    if (intel === undefined) {
      return html`<div class="panel intel-panel"><div class="panel-head">Content Intelligence</div><div class="muted">Loading…</div></div>`;
    }
    if (!intel) {
      return html`<div class="panel intel-panel"><div class="panel-head">Content Intelligence</div><div class="muted">Content Intelligence is unavailable.</div></div>`;
    }
    if (intel.source === "youtube") {
      return html`
        <div class="panel intel-panel" data-learn-id="content-pages-intel">
          <div class="panel-head">Content Intelligence · YouTube</div>
          ${intel.channel
            ? html`
                <div class="intel-stats">
                  ${this.renderStatTile("Channel", intel.channel.name ?? intel.channel.channelId)}
                  ${this.renderStatTile("Subscribers", fmtNumber(intel.channel.subscriberCount ?? undefined))}
                  ${this.renderStatTile("Videos", fmtNumber(intel.channel.videoCount ?? undefined))}
                </div>
                <ul class="intel-list">
                  ${(intel.topVideos ?? []).map(
                    (v) => html`<li>
                      <a href=${`https://www.youtube.com/watch?v=${v.videoId}`} target="_blank" rel="noopener noreferrer">${v.title ?? v.videoId}</a>
                      <span class="muted">${fmtNumber(v.views ?? undefined)} views</span>
                    </li>`,
                  )}
                </ul>
              `
            : html`<div class="muted">
                No YouTube channel imported for ${intel.handle ? `@${intel.handle}` : "this page"} yet.
                Import it under Content › Intelligence › YouTube and it links here by handle.
              </div>`}
        </div>
      `;
    }
    const t = intel.totals;
    const tiers = Object.entries(intel.tiers ?? {});
    return html`
      <div class="panel intel-panel" data-learn-id="content-pages-intel">
        <div class="panel-head">
          Content Intelligence · @${intel.account}
          <button class="btn-ghost btn-ghost--sm intel-open" @click=${() => {
            window.history.pushState({}, "", "/content-intel");
            window.dispatchEvent(new PopStateEvent("popstate"));
          }}>Open library</button>
        </div>
        ${!intel.linked || !t
          ? html`<div class="muted">No reels for @${intel.account} in Content Intelligence yet.</div>`
          : html`
              <div class="intel-stats">
                ${this.renderStatTile("Reels", fmtNumber(t.reels))}
                ${this.renderStatTile("Scored", fmtNumber(t.scored))}
                ${this.renderStatTile("Views", fmtNumber(t.views))}
                ${this.renderStatTile("Saves", fmtNumber(t.saves))}
                ${this.renderStatTile("Avg viral", intel.avgScores?.viral != null ? String(intel.avgScores.viral) : "—")}
              </div>
              ${tiers.length
                ? html`<div class="intel-tiers">
                    ${tiers.map(([tier, n]) => html`<span class="intel-tier">Tier ${tier} <b>${n}</b></span>`)}
                  </div>`
                : nothing}
              <ul class="intel-list">
                ${(intel.topReels ?? []).map(
                  (r) => html`<li>
                    <a href=${r.url ?? `https://www.instagram.com/reel/${r.shortcode}/`} target="_blank" rel="noopener noreferrer"
                      >${(r.description ?? r.shortcode).slice(0, 90) || r.shortcode}</a
                    >
                    <span class="muted">${fmtNumber(r.views ?? undefined)} views${r.tier ? ` · ${r.tier}` : ""}</span>
                  </li>`,
                )}
              </ul>
            `}
      </div>
    `;
  }

  // -- Series tab ------------------------------------------------------------

  private renderStageChip(stage: Stage): TemplateResult {
    return html`<span class="stage-chip stage-chip--${stage}">${STAGE_LABEL[stage]}</span>`;
  }

  private renderAdvanceButton(kind: "series" | "ideas", id: string, stage: Stage): TemplateResult {
    const next = nextStageOf(stage);
    if (!next) return html`<span class="stage-done">Done</span>`;
    return html`<button
      class="btn-advance"
      ?disabled=${Boolean(this.advancing[id])}
      title=${`Advance to ${STAGE_LABEL[next]}`}
      @click=${(e: Event) => {
        e.stopPropagation();
        void this.advanceStage(kind, id);
      }}
    >${this.advancing[id] ? "…" : `→ ${STAGE_LABEL[next]}`}</button>`;
  }

  private renderSeries(page: ContentPage): TemplateResult {
    const groups = this.seriesCache[page.id];
    return html`
      <div class="child-panel series-panel" data-learn-id="content-pages-series">
        <div class="child-head">
          <h3>Series</h3>
          <button
            class="btn-ghost btn-ghost--sm"
            @click=${async () => {
              const seriesName = prompt("Series name?", groups?.[0]?.name ?? "");
              if (!seriesName) return;
              const title = prompt("Episode title?");
              if (!title) return;
              const epRaw = prompt("Episode number?", "");
              const client = this.client;
              if (!client) return;
              try {
                await client.request("content.pages.series.upsert", {
                  pageId: page.id,
                  episode: {
                    seriesName,
                    title,
                    season: 1,
                    episode: epRaw && Number.isFinite(Number(epRaw)) ? Number(epRaw) : null,
                  },
                });
                await Promise.all([this.loadSeries(page.id), this.loadBoard(page.id)]);
              } catch (e) {
                this.error = e instanceof Error ? e.message : String(e);
              }
            }}
          >New episode</button>
        </div>
        ${this.stageNotice ? html`<div class="stage-notice">${this.stageNotice}</div>` : nothing}
        ${groups === undefined
          ? html`<div class="muted">Loading…</div>`
          : groups.length === 0
            ? html`<div class="muted child-empty">No series yet. Add an episode, or ask the CMO agent to plan a series.</div>`
            : groups.map(
                (g) => html`
                  <section class="series-group">
                    <header class="series-head">
                      <div class="series-name">${g.name}</div>
                      <div class="series-meta">
                        ${g.episodeCount} episodes
                        ${STAGE_ORDER.filter((s) => g.stageCounts[s]).map(
                          (s) => html`<span class="series-count">${STAGE_LABEL[s]} ${g.stageCounts[s]}</span>`,
                        )}
                      </div>
                    </header>
                    ${g.seasons.map(
                      (season) => html`
                        <div class="season">
                          <div class="season-head">${season.season !== null ? `Season ${season.season}` : "No season"}</div>
                          <ol class="episode-list">
                            ${season.episodes.map((ep) => this.renderEpisode(ep))}
                          </ol>
                        </div>
                      `,
                    )}
                  </section>
                `,
              )}
      </div>
    `;
  }

  private renderEpisode(ep: SeriesEpisode): TemplateResult {
    return html`
      <li class="episode">
        <div class="ep-num">${ep.episode !== null ? `Ep ${ep.episode}` : "—"}</div>
        <div class="ep-body">
          <div class="ep-title-row">
            <span class="ep-title">${ep.title}</span>
            ${this.renderStageChip(ep.stage)}
            ${ep.scriptRowId ? html`<span class="ep-flag" title="Script linked">Script</span>` : nothing}
            ${ep.contentRowId ? html`<span class="ep-flag" title="Logged in Content">Posted</span>` : nothing}
          </div>
          ${ep.painPoint ? html`<div class="ep-line"><b>Pain</b> ${ep.painPoint}</div>` : nothing}
          ${ep.hook ? html`<div class="ep-line"><b>Hook</b> ${ep.hook}</div>` : nothing}
          ${ep.whatToShow ? html`<div class="ep-line"><b>Show</b> ${ep.whatToShow}</div>` : nothing}
          ${ep.payoff ? html`<div class="ep-line"><b>Payoff</b> ${ep.payoff}</div>` : nothing}
          ${ep.repurposeNote ? html`<div class="ep-line ep-line--muted"><b>Shorts / IG</b> ${ep.repurposeNote}</div>` : nothing}
          <div class="ep-foot">
            ${ep.targetPublishDate ? html`<span class="muted">Target ${ep.targetPublishDate.slice(0, 10)}</span>` : nothing}
            ${ep.platformUrl
              ? html`<a class="video-link" href=${ep.platformUrl} target="_blank" rel="noopener noreferrer">Watch</a>`
              : nothing}
          </div>
        </div>
        <div class="ep-actions">${this.renderAdvanceButton("series", ep.id, ep.stage)}</div>
      </li>
    `;
  }

  // -- Stage board -----------------------------------------------------------

  private renderStageBoard(page: ContentPage): TemplateResult {
    const board = this.boardCache[page.id];
    if (!board) return html`<div class="muted">Loading…</div>`;
    return html`
      <div class="child-panel" data-learn-id="content-pages-board">
        <div class="child-head">
          <h3>Pipeline</h3>
          <button
            class="btn-ghost btn-ghost--sm"
            @click=${async () => {
              const title = prompt("New idea?");
              if (!title) return;
              await this.createChildRow("ideas", title);
              await this.loadBoard(page.id);
            }}
          >Capture idea</button>
        </div>
        ${this.stageNotice ? html`<div class="stage-notice">${this.stageNotice}</div>` : nothing}
        <div class="stage-board">
          ${board.columns.map(
            (col) => html`
              <div class="stage-col stage-col--${col.stage}">
                <div class="kanban-col-head">
                  <span>${col.name}</span>
                  <span class="kanban-count">${col.items.length}</span>
                </div>
                <div class="kanban-cards">
                  ${col.items.length === 0
                    ? html`<div class="kanban-empty">—</div>`
                    : col.items.map(
                        (it) => html`
                          <div class="stage-card">
                            <div class="stage-card-tags">
                              <span class="stage-kind stage-kind--${it.kind}">${it.kind === "series" ? (it.label ?? "Episode") : "Idea"}</span>
                              ${it.scriptRowId ? html`<span class="ep-flag">Script</span>` : nothing}
                            </div>
                            <div class="stage-card-title">${it.title || "Untitled"}</div>
                            ${it.seriesName ? html`<div class="stage-card-sub">${it.seriesName}</div>` : nothing}
                            <div class="stage-card-foot">${this.renderAdvanceButton(it.kind, it.id, it.stage)}</div>
                          </div>
                        `,
                      )}
                </div>
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  // -- IG live-sync chip --------------------------------------------------

  private renderIgLiveChip(page: ContentPage): TemplateResult {
    if (page.surface !== "instagram" || !this.igStats) return html`${nothing}`;
    const ig = this.igStats;
    if (ig.error && ig.followers === 0 && ig.reach30d === 0) {
      return html`<span class="ig-live-chip ig-live-chip--warn">
        <span class="ig-live-dot ig-live-dot--warn"></span>
        Sync failed: ${ig.error.message}
      </span>`;
    }
    const ago = fmtRelative(ig.fetchedAt);
    const cached = ig.fromCache ? " · cached" : "";
    return html`<span class="ig-live-chip ig-live-chip--ok">
      <span class="ig-live-dot ig-live-dot--ok"></span>
      Live · ${ago}${cached}
    </span>`;
  }

  // -- Overview tab -------------------------------------------------------

  private renderOverview(page: ContentPage): TemplateResult {
    const goals = page.goals ?? {};
    const ring = (current: number, target: number | undefined, label: string) =>
      this.renderGoalRing(current, target, label);
    return html`
      <div class="overview">
        <div class="kpi-row">
          ${this.renderKpiCard("Followers", fmtNumber(page.stats.followers), page.goals?.followersTarget
            ? `goal ${fmtNumber(page.goals.followersTarget)}`
            : "")}
          ${this.renderKpiCard("Monthly posts", fmtNumber(page.stats.monthlyPosts), page.goals?.monthlyPostsTarget
            ? `goal ${page.goals.monthlyPostsTarget}`
            : "")}
          ${this.renderKpiCard("Engagement", fmtPct(page.stats.engagementRate), page.goals?.engagementRateTarget
            ? `goal ${fmtPct(page.goals.engagementRateTarget)}`
            : "")}
          ${this.renderKpiCard("Leads attributed", fmtNumber(page.stats.leadsAttributed), "30d")}
        </div>
        ${this.renderIntelPanel(page)}
        <div class="overview-row">
          <div class="panel">
            <div class="panel-head">Reach trend · 30 days ${this.renderIgLiveChip(page)}</div>
            <div class="trend">
              <svg viewBox="0 0 280 80" width="100%" height="80" preserveAspectRatio="none">
                ${(() => {
                  const path = sparklinePath(page.stats.reachSparkline ?? [], 280, 80);
                  if (!path) return svgEmpty();
                  return html`
                    <path d=${`${path} L 280 80 L 0 80 Z`} fill="rgba(202,164,90,0.18)" stroke="none"/>
                    <path d=${path} fill="none" stroke="currentColor" stroke-width="1.6"/>
                  `;
                })()}
              </svg>
            </div>
          </div>
          <div class="panel">
            <div class="panel-head">Goals</div>
            <div class="goals">
              ${ring(page.stats.followers ?? 0, goals.followersTarget, "Followers")}
              ${ring(page.stats.monthlyPosts, goals.monthlyPostsTarget, "Posts/mo")}
              ${ring(page.stats.engagementRate, goals.engagementRateTarget, "Engagement")}
            </div>
          </div>
        </div>
        <div class="overview-row">
          <div class="panel">
            <div class="panel-head">Connected systems</div>
            <div class="conn-mini">
              ${this.renderConnTag("Campaigns", page.links.campaignIds.length)}
              ${this.renderConnTag("Products", page.links.productIds.length)}
              ${this.renderConnTag("Funnels", page.links.funnelIds.length)}
              ${this.renderConnTag("Lead DB", page.links.leadDbId ? 1 : 0)}
            </div>
            <button class="btn-ghost btn-ghost--sm" @click=${() => (this.detailTab = "connections")}>Open connections graph</button>
          </div>
          <div class="panel">
            <div class="panel-head">Top insights</div>
            ${this.insights.length === 0
              ? html`<div class="muted">Loading…</div>`
              : html`<ul class="insights-mini">${this.insights.slice(0, 3).map(
                  (i) => html`<li>
                    <span class="sev sev--${i.severity}">${i.severity}</span>
                    <span>${i.title}</span>
                  </li>`,
                )}</ul>`}
            <button class="btn-ghost btn-ghost--sm" @click=${() => (this.detailTab = "insights")}>See all</button>
          </div>
        </div>
      </div>
    `;
  }

  private renderKpiCard(label: string, value: string, sub: string): TemplateResult {
    return html`
      <div class="kpi">
        <div class="kpi-val">${value}</div>
        <div class="kpi-lbl">${label}</div>
        ${sub ? html`<div class="kpi-sub">${sub}</div>` : nothing}
      </div>
    `;
  }

  private renderConnTag(label: string, count: number): TemplateResult {
    return html`<div class="conn-tag"><span class="conn-count">${count}</span><span>${label}</span></div>`;
  }

  private renderGoalRing(current: number, target: number | undefined, label: string): TemplateResult {
    const pct = target && target > 0 ? Math.min(1, current / target) : 0;
    const r = 26;
    const c = 2 * Math.PI * r;
    return html`
      <div class="ring">
        <svg viewBox="0 0 64 64" width="64" height="64">
          <circle cx="32" cy="32" r="${r}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="6"/>
          <circle
            cx="32"
            cy="32"
            r="${r}"
            fill="none"
            stroke="currentColor"
            stroke-width="6"
            stroke-linecap="round"
            stroke-dasharray="${c.toFixed(2)}"
            stroke-dashoffset="${(c * (1 - pct)).toFixed(2)}"
            transform="rotate(-90 32 32)"
          />
        </svg>
        <div class="ring-meta">
          <div class="ring-val">${target ? `${Math.round(pct * 100)}%` : "—"}</div>
          <div class="ring-lbl">${label}</div>
        </div>
      </div>
    `;
  }

  // -- Child tables (scripts / content) ----------------------------------

  private renderChildTable(page: ContentPage, kind: ChildKind): TemplateResult {
    const data = this.childCache[`${page.id}:${kind}`];
    return html`
      <div class="child-panel">
        <div class="child-head">
          <h3>${kind.charAt(0).toUpperCase() + kind.slice(1)}</h3>
          <button
            class="btn-ghost btn-ghost--sm"
            @click=${async () => {
              const title = prompt(`New ${kind.slice(0, -1)} title?`);
              if (title) await this.createChildRow(kind, title);
            }}
          >New row</button>
        </div>
        ${!data || data.rows.length === 0
          ? html`<div class="muted child-empty">No rows yet — create one above.</div>`
          : html`<table class="child-table">
              <thead>
                <tr>
                  <th>Title</th>
                  ${data.properties.filter((p) => p.type !== "title").slice(0, 5).map((p) => html`<th>${p.name}</th>`)}
                  <th class="row-actions"></th>
                </tr>
              </thead>
              <tbody>
                ${data.rows.map((r) => html`
                  <tr>
                    <td>${r.title || "Untitled"}</td>
                    ${data.properties.filter((p) => p.type !== "title").slice(0, 5).map((p) => html`<td>${renderCell(r.values[p.id])}</td>`)}
                    <td class="row-actions"><button class="row-del" @click=${() => this.deleteChildRow(kind, r.id)}>×</button></td>
                  </tr>
                `)}
              </tbody>
            </table>`}
      </div>
    `;
  }

  // -- Videos thumbnail grid ---------------------------------------------

  private renderVideosGrid(page: ContentPage): TemplateResult {
    const data = this.childCache[`${page.id}:videos`];
    return html`
      <div class="child-panel">
        <div class="child-head">
          <h3>Videos</h3>
          <button
            class="btn-ghost btn-ghost--sm"
            @click=${async () => {
              const title = prompt("New video title?");
              if (title) await this.createChildRow("videos", title);
            }}
          >New video</button>
        </div>
        ${!data || data.rows.length === 0
          ? html`<div class="muted child-empty">No videos yet.</div>`
          : html`<div class="video-grid">${data.rows.map((r) => this.renderVideoCard(r, data.properties))}</div>`}
      </div>
    `;
  }

  private renderVideoCard(row: DBRow, props: DBProperty[]): TemplateResult {
    const thumb = pickProp(row, props, "Thumbnail URL");
    const platform = pickProp(row, props, "Platform URL");
    const views = pickProp(row, props, "Views");
    const status = pickProp(row, props, "Status");
    return html`
      <div class="video-card">
        <div class="video-thumb">
          ${typeof thumb === "string" && thumb
            ? html`<img src=${thumb} alt=${row.title} />`
            : html`<div class="video-thumb-placeholder">
                <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.4"><polygon points="9 7 17 12 9 17 9 7"/></svg>
              </div>`}
        </div>
        <div class="video-meta">
          <div class="video-title">${row.title || "Untitled"}</div>
          <div class="video-row">
            <span>${views !== null ? `${fmtNumber(Number(views))} views` : "—"}</span>
            ${status ? html`<span class="status-chip">${String(status)}</span>` : nothing}
          </div>
          ${typeof platform === "string" && platform
            ? html`<a class="video-link" href=${platform} target="_blank" rel="noopener noreferrer">Open</a>`
            : nothing}
        </div>
      </div>
    `;
  }

  // -- Ideas kanban -------------------------------------------------------

  private renderIdeasBoard(page: ContentPage): TemplateResult {
    const data = this.childCache[`${page.id}:ideas`];
    if (!data) return html`<div class="muted">Loading…</div>`;
    const statusProp = data.properties.find((p) => p.name.toLowerCase() === "status");
    const options = statusProp?.config?.options ?? [
      { id: "captured", name: "Captured" },
      { id: "prioritized", name: "Prioritized" },
      { id: "promoted", name: "Promoted" },
      { id: "shelved", name: "Shelved" },
    ];
    const cols = options.map((opt) => ({
      ...opt,
      rows: data.rows.filter((r) => {
        const v = statusProp ? (r.values[statusProp.id] as { optionId?: string } | undefined) : undefined;
        return v?.optionId === opt.id;
      }),
    }));
    return html`
      <div class="child-panel">
        <div class="child-head">
          <h3>Ideas</h3>
          <button
            class="btn-ghost btn-ghost--sm"
            @click=${async () => {
              const title = prompt("New idea?");
              if (title) await this.createChildRow("ideas", title);
            }}
          >Capture</button>
        </div>
        <div class="kanban">
          ${cols.map(
            (col) => html`
              <div class="kanban-col">
                <div class="kanban-col-head">
                  <span>${col.name}</span>
                  <span class="kanban-count">${col.rows.length}</span>
                </div>
                <div class="kanban-cards">
                  ${col.rows.length === 0
                    ? html`<div class="kanban-empty">—</div>`
                    : col.rows.map((r) => html`<div class="kanban-card">${r.title || "Untitled"}</div>`)}
                </div>
              </div>
            `,
          )}
        </div>
      </div>
    `;
  }

  // -- Analytics tab ------------------------------------------------------

  private renderAnalytics(page: ContentPage): TemplateResult {
    // For Instagram pages, show a connect prompt at the top when not connected.
    const igBanner = page.surface === 'instagram' ? html`
      ${this.igStatus === null || this.igStatusLoading
        ? nothing
        : !this.igStatus.connected
          ? html`
            <div class="ig-analytics-empty">
              <div class="ig-analytics-empty-icon">${surfaceIcon('instagram')}</div>
              <div class="ig-analytics-empty-text">
                <strong>Connect Instagram to see live analytics</strong><br/>
                Follower counts, post reach, impressions, and engagement — all from the official Graph API.
              </div>
              <button class="btn-primary btn-primary--sm" @click=${() => this.openIgSetup(page)}>
                Connect Instagram
              </button>
            </div>
          `
          : html`
            <div class="ig-analytics-connected">
              <span class="intg-badge intg-badge--connected">
                <span class="intg-dot"></span>
                @${this.igStatus.accountName ?? 'Instagram'} · analytics synced ${fmtRelative(this.igStatus.lastSyncAt)}
              </span>
              ${this.igStatus.expiringSoon ? html`
                <span class="intg-conn-warn">Token expires in ${this.igStatus.daysUntilExpiry}d —
                  <button class="btn-link" @click=${() => this.igRefreshToken()}>refresh now</button>
                </span>
              ` : nothing}
            </div>
          `}
    ` : nothing;

    const content = this.childCache[`${page.id}:content`];
    const rows = content?.rows ?? [];
    const props = content?.properties ?? [];
    const engagementProp = props.find((p) => p.name === "Engagement");
    const reachProp = props.find((p) => p.name === "Reach");
    const impressionsProp = props.find((p) => p.name === "Impressions");
    const publishedProp = props.find((p) => p.name === "Published At");

    const series = rows
      .map((r) => {
        const dateVal = publishedProp
          ? (r.values[publishedProp.id] as { iso?: string } | undefined)
          : undefined;
        const eng = engagementProp ? Number(getValueNumber(r.values[engagementProp.id])) : 0;
        const reach = reachProp ? Number(getValueNumber(r.values[reachProp.id])) : 0;
        const ts = dateVal?.iso ? Date.parse(dateVal.iso) : null;
        return { ts, eng, reach, title: r.title };
      })
      .filter((s) => s.ts !== null)
      .sort((a, b) => (a.ts! - b.ts!));

    const totalReach = series.reduce((s, p) => s + p.reach, 0);
    const totalEng = series.reduce((s, p) => s + p.eng, 0);
    const conv = page.stats.conversions30d ?? 0;
    const clicks = page.stats.clicks30d ?? 0;
    const impressions = impressionsProp ? rows.reduce((s, r) => s + Number(getValueNumber(r.values[impressionsProp.id])), 0) : 0;

    const igTopMedia = this.igStats?.topMedia?.slice(0, 3) ?? [];

    return html`
      <div class="overview">
        ${igBanner}
        <div class="kpi-row-head">${this.renderIgLiveChip(page)}</div>
        <div class="kpi-row">
          ${this.renderKpiCard("Impressions", fmtNumber(impressions), "all-time")}
          ${this.renderKpiCard("Reach", fmtNumber(totalReach), "from content")}
          ${this.renderKpiCard("Engagement", fmtNumber(totalEng), "")}
          ${this.renderKpiCard("Conversions", fmtNumber(conv), "30d")}
        </div>
        ${igTopMedia.length > 0 ? html`
          <div class="panel">
            <div class="panel-head">Top 3 posts · Instagram</div>
            <div class="ig-top-media">
              ${igTopMedia.map((m) => html`
                <a class="ig-media-card" href=${m.permalink} target="_blank" rel="noopener noreferrer">
                  ${m.thumbnail
                    ? html`<img class="ig-media-thumb" src=${m.thumbnail} alt="" loading="lazy"/>`
                    : html`<div class="ig-media-thumb ig-media-thumb--placeholder"></div>`}
                  <div class="ig-media-stats">
                    <span>${fmtNumber(m.reach)} reach</span>
                    <span>${fmtNumber(m.likes)} likes</span>
                    <span>${fmtNumber(m.saves)} saves</span>
                  </div>
                </a>
              `)}
            </div>
          </div>
        ` : nothing}
        <div class="panel">
          <div class="panel-head">Cadence — published content over time</div>
          ${this.renderCadenceBars(series.map((s) => ({ ts: s.ts!, value: 1 })))}
        </div>
        <div class="panel">
          <div class="panel-head">Attribution funnel</div>
          ${this.renderAttributionFunnel({
            impressions,
            engagement: totalEng,
            clicks,
            leads: page.stats.leadsAttributed,
            conversions: conv,
          })}
        </div>
        <div class="panel">
          <div class="panel-head">Top performing content</div>
          ${rows.length === 0
            ? html`<div class="muted child-empty">No content yet.</div>`
            : html`<table class="child-table">
                <thead><tr><th>Title</th><th>Reach</th><th>Engagement</th><th>Published</th></tr></thead>
                <tbody>
                  ${[...series]
                    .sort((a, b) => b.eng - a.eng)
                    .slice(0, 8)
                    .map(
                      (s) => html`<tr>
                        <td>${s.title}</td>
                        <td>${fmtNumber(s.reach)}</td>
                        <td>${fmtNumber(s.eng)}</td>
                        <td>${new Date(s.ts!).toLocaleDateString()}</td>
                      </tr>`,
                    )}
                </tbody>
              </table>`}
        </div>
      </div>
    `;
  }

  private renderCadenceBars(series: Array<{ ts: number; value: number }>): TemplateResult {
    if (series.length === 0) return html`<div class="muted child-empty">No published content yet.</div>`;
    // Bucket by week (last 12 weeks).
    const now = Date.now();
    const weeks: number[] = new Array(12).fill(0);
    for (const s of series) {
      const ageWeeks = Math.floor((now - s.ts) / (7 * 86_400_000));
      if (ageWeeks >= 0 && ageWeeks < 12) weeks[11 - ageWeeks] += s.value;
    }
    const max = Math.max(...weeks, 1);
    return html`
      <div class="cadence">
        ${weeks.map(
          (w) => html`<div class="cadence-bar-wrap"><div class="cadence-bar" style=${`height:${(w / max) * 100}%`}></div></div>`,
        )}
      </div>
    `;
  }

  private renderAttributionFunnel(stages: {
    impressions: number;
    engagement: number;
    clicks: number;
    leads: number;
    conversions: number;
  }): TemplateResult {
    const max = Math.max(stages.impressions, 1);
    const rows = [
      { label: "Impressions", value: stages.impressions },
      { label: "Engagement", value: stages.engagement },
      { label: "Clicks", value: stages.clicks },
      { label: "Leads", value: stages.leads },
      { label: "Conversions", value: stages.conversions },
    ];
    return html`
      <div class="funnel">
        ${rows.map(
          (r) => html`
            <div class="funnel-row">
              <div class="funnel-label">${r.label}</div>
              <div class="funnel-bar-bg">
                <div class="funnel-bar" style=${`width:${Math.max(2, (r.value / max) * 100)}%`}></div>
              </div>
              <div class="funnel-val">${fmtNumber(r.value)}</div>
            </div>
          `,
        )}
      </div>
    `;
  }

  // -- Insights tab -------------------------------------------------------

  private renderInsights(): TemplateResult {
    if (this.insights.length === 0) {
      return html`<div class="muted child-empty">No insights — page is still warming up.</div>`;
    }
    return html`
      <div class="insights">
        ${this.insights.map(
          (i) => html`
            <div class="insight insight--${i.severity}">
              <div class="insight-head">
                <span class="sev sev--${i.severity}">${i.severity}</span>
                <span class="insight-cat">${i.category}</span>
                <span class="insight-impact">impact ${i.impact}</span>
              </div>
              <div class="insight-title">${i.title}</div>
              <div class="insight-detail">${i.detail}</div>
              <div class="insight-foot">
                ${i.metric ? html`<span class="insight-metric"><b>${i.metric.value}</b> ${i.metric.label}</span>` : nothing}
                ${i.action
                  ? html`<button
                      class="btn-ghost btn-ghost--sm"
                      @click=${() => this.applyInsightAction(i)}
                    >${i.action.label}</button>`
                  : nothing}
              </div>
            </div>
          `,
        )}
      </div>
    `;
  }

  private applyInsightAction(insight: PageInsight): void {
    if (!insight.action?.intent) return;
    const intent = insight.action.intent;
    if (intent.startsWith("view:")) {
      const tab = intent.slice(5) as DetailTab;
      this.detailTab = tab;
    }
  }

  // -- Connections graph --------------------------------------------------

  private renderConnections(): TemplateResult {
    const g = this.graph;
    if (!g || g.nodes.length === 0) {
      return html`<div class="muted child-empty">No connections yet — link campaigns / products / funnels via the page settings.</div>`;
    }
    // Lay nodes out: page node at center, others arranged on a ring.
    const W = 640, H = 360;
    const cx = W / 2, cy = H / 2;
    const center = g.nodes.find((n) => n.kind === "page") ?? g.nodes[0]!;
    const others = g.nodes.filter((n) => n.id !== center.id);
    const angleStep = (2 * Math.PI) / Math.max(1, others.length);
    const positions = new Map<string, { x: number; y: number }>();
    positions.set(center.id, { x: cx, y: cy });
    others.forEach((n, i) => {
      const angle = i * angleStep - Math.PI / 2;
      const r = 140;
      positions.set(n.id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    });
    return html`
      <div class="panel">
        <div class="panel-head">Connections graph</div>
        <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">
          ${g.edges.map((e) => {
            const a = positions.get(e.from);
            const b = positions.get(e.to);
            if (!a || !b) return nothing;
            return html`<line x1=${a.x} y1=${a.y} x2=${b.x} y2=${b.y}
              stroke="currentColor"
              stroke-opacity=${0.2 + e.strength * 0.5}
              stroke-width="${1 + e.strength * 1.4}"/>`;
          })}
          ${g.nodes.map((n) => {
            const p = positions.get(n.id);
            if (!p) return nothing;
            const r = 18 + Math.min(14, (n.weight ?? 1) * 3);
            const fill = nodeKindFill(n.kind);
            return html`<g class="graph-node" transform=${`translate(${p.x},${p.y})`}>
              <circle r=${r} fill=${fill} fill-opacity="0.16" stroke="currentColor" stroke-opacity="0.5"/>
              <text y="4" text-anchor="middle" fill="currentColor" font-size="11">${n.label}</text>
              ${n.sub ? html`<text y="${r + 14}" text-anchor="middle" fill="currentColor" fill-opacity="0.6" font-size="10">${n.sub}</text>` : nothing}
            </g>`;
          })}
        </svg>
      </div>
    `;
  }

  // -- Wizard -------------------------------------------------------------

  private renderWizard(): TemplateResult {
    const surface = this.wizardForm.surface;
    const steps = surface === 'instagram'
      ? ['Basics', 'Instagram', 'ManyChat', 'Goals', 'Connections', 'Brand voice']
      : ['Basics', 'Goals', 'Connections', 'Brand voice'];
    return html`
      <div class="wizard-overlay" @click=${(e: MouseEvent) => {
        if (e.target === e.currentTarget) this.closeWizard();
      }}>
        <div class="wizard" data-learn-id="content-pages-wizard">
          <div class="wizard-head">
            <h2>Create a content page</h2>
            <button class="wizard-close" data-learn-id="content-pages-wizard-close" @click=${() => this.closeWizard()}>×</button>
          </div>
          <div class="wizard-steps" data-learn-id="content-pages-wizard-steps">
            ${steps.map(
              (s, i) => html`
                <div class="wizard-step ${i === this.wizardStep ? "is-active" : ""} ${i < this.wizardStep ? "is-done" : ""}">
                  <span class="wizard-step-n">${i + 1}</span>${s}
                </div>
              `,
            )}
          </div>
          <div class="wizard-body">${this.renderWizardStep()}</div>
          <div class="wizard-foot" data-learn-id="content-pages-wizard-foot">
            <button class="btn-ghost" ?disabled=${this.wizardStep === 0} @click=${() => (this.wizardStep -= 1)}>Back</button>
            ${this.wizardStep < steps.length - 1
              ? html`<button class="btn-primary" @click=${() => (this.wizardStep += 1)}>Next</button>`
              : html`<button class="btn-primary" @click=${() => this.submitWizard()}>Create page</button>`}
          </div>
        </div>
      </div>
    `;
  }

  private renderWizardStep(): TemplateResult {
    const f = this.wizardForm;
    const upd = (patch: Partial<typeof f>) => (this.wizardForm = { ...this.wizardForm, ...patch });
    const isInstagram = f.surface === 'instagram';
    // Step index mapping:
    // Instagram: 0=Basics, 1=Instagram, 2=ManyChat, 3=Goals, 4=Connections, 5=Brand voice
    // Others:    0=Basics, 1=Goals,     2=Connections, 3=Brand voice
    const step = this.wizardStep;
    const goalsStep = isInstagram ? 3 : 1;
    const connectionsStep = isInstagram ? 4 : 2;
    const brandStep = isInstagram ? 5 : 3;

    if (step === 0) {
      return html`
        <div class="wizard-grid">
          <label class="wizard-field"><span>Page name</span>
            <input data-learn-id="content-pages-wizard-name" .value=${f.name} @input=${(e: InputEvent) => upd({ name: (e.target as HTMLInputElement).value })}/>
          </label>
          <label class="wizard-field"><span>Surface</span>
            <select data-learn-id="content-pages-wizard-surface" .value=${f.surface} @change=${(e: Event) => { upd({ surface: (e.target as HTMLSelectElement).value as Surface }); this.wizardStep = 0; }}>
              ${(["instagram","youtube","tiktok","blog","linkedin","twitter","facebook","newsletter","podcast","other"] as Surface[])
                .map((s) => html`<option value=${s}>${surfaceLabel(s)}</option>`)}
            </select>
          </label>
          <label class="wizard-field"><span>Handle</span>
            <input .value=${f.handle} placeholder="@brand" @input=${(e: InputEvent) => upd({ handle: (e.target as HTMLInputElement).value })}/>
          </label>
          <label class="wizard-field"><span>URL</span>
            <input .value=${f.url} placeholder="https://" @input=${(e: InputEvent) => upd({ url: (e.target as HTMLInputElement).value })}/>
          </label>
          <label class="wizard-field wizard-field--wide"><span>Business</span>
            <select .value=${f.businessId} @change=${(e: Event) => upd({ businessId: (e.target as HTMLSelectElement).value })}>
              <option value="">— pick a business —</option>
              ${this.businesses.map((b) => html`<option value=${b.id}>${b.name}</option>`)}
            </select>
          </label>
          <label class="wizard-field"><span>Owner agent (optional)</span>
            <input .value=${f.ownerAgentId} @input=${(e: InputEvent) => upd({ ownerAgentId: (e.target as HTMLInputElement).value })}/>
          </label>
        </div>
      `;
    }

    if (isInstagram && step === 1) {
      return html`
        <div class="wizard-grid">
          <div class="wizard-field wizard-field--wide">
            <span>Connect your Instagram account</span>
            <div class="intg-oauth-block">
              <p class="wizard-hint">After creating the page, connect Instagram from the <strong>Integrations</strong> tab using the step-by-step setup modal.</p>
              <p class="wizard-hint">You can skip this for now — connect any time after the page is created.</p>
            </div>
          </div>
        </div>
      `;
    }

    if (isInstagram && step === 2) {
      return html`
        <div class="wizard-grid">
          <div class="wizard-field wizard-field--wide">
            <span>Connect ManyChat (optional)</span>
            <p class="wizard-hint">Enter your ManyChat API key to enable DM automation and comment triggers.</p>
          </div>
          <label class="wizard-field wizard-field--wide">
            <span>ManyChat API Key</span>
            <input type="password" .value=${this.wizardMcApiKey}
              placeholder="Paste your ManyChat API key"
              @input=${(e: InputEvent) => { this.wizardMcApiKey = (e.target as HTMLInputElement).value; this.wizardMcStatus = 'idle'; }}/>
          </label>
          ${this.wizardMcStatus === 'connected' ? html`<div class="wizard-field wizard-field--wide"><span class="intg-badge intg-badge--connected">Connected · ${this.wizardMcAccountName}</span></div>` : nothing}
          ${this.wizardMcStatus === 'error' ? html`<div class="wizard-field wizard-field--wide"><span class="intg-badge intg-badge--disconnected">Connection failed</span></div>` : nothing}
          <div class="wizard-field">
            <button class="btn-ghost btn-ghost--sm" ?disabled=${!this.wizardMcApiKey || this.wizardMcStatus === 'connecting'}
              @click=${() => this.wizardTestManyChat()}>
              ${this.wizardMcStatus === 'connecting' ? 'Testing…' : 'Test connection'}
            </button>
          </div>
          <p class="wizard-hint wizard-field--wide">Skip this step if you don't have a ManyChat account — you can connect later from Integrations.</p>
        </div>
      `;
    }

    if (step === goalsStep) {
      return html`
        <div class="wizard-grid">
          <label class="wizard-field"><span>Followers target</span>
            <input type="number" .value=${f.followersTarget} @input=${(e: InputEvent) => upd({ followersTarget: (e.target as HTMLInputElement).value })}/>
          </label>
          <label class="wizard-field"><span>Posts / month target</span>
            <input type="number" .value=${f.monthlyPostsTarget} @input=${(e: InputEvent) => upd({ monthlyPostsTarget: (e.target as HTMLInputElement).value })}/>
          </label>
          <label class="wizard-field"><span>Engagement rate target (0–1)</span>
            <input type="number" step="0.01" .value=${f.engagementRateTarget} @input=${(e: InputEvent) => upd({ engagementRateTarget: (e.target as HTMLInputElement).value })}/>
          </label>
        </div>
      `;
    }

    if (step === connectionsStep) {
      return html`
        <div class="wizard-grid">
          <label class="wizard-field wizard-field--wide"><span>Campaign IDs (comma-separated)</span>
            <input .value=${f.campaignIds} @input=${(e: InputEvent) => upd({ campaignIds: (e.target as HTMLInputElement).value })}/>
          </label>
          <label class="wizard-field wizard-field--wide"><span>Product IDs</span>
            <input .value=${f.productIds} @input=${(e: InputEvent) => upd({ productIds: (e.target as HTMLInputElement).value })}/>
          </label>
          <label class="wizard-field wizard-field--wide"><span>Funnel IDs</span>
            <input .value=${f.funnelIds} @input=${(e: InputEvent) => upd({ funnelIds: (e.target as HTMLInputElement).value })}/>
          </label>
          <p class="wizard-hint">Connection IDs are stored as-is; the in-flight Campaigns agent will expose them via <code>campaigns.list</code> once it lands.</p>
        </div>
      `;
    }

    if (step === brandStep) {
      return html`
        <div class="wizard-grid">
          <label class="wizard-field"><span>Voice</span>
            <input .value=${f.voice} placeholder="punchy, terminal" @input=${(e: InputEvent) => upd({ voice: (e.target as HTMLInputElement).value })}/>
          </label>
          <label class="wizard-field"><span>Tone</span>
            <input .value=${f.tone} placeholder="confident, direct" @input=${(e: InputEvent) => upd({ tone: (e.target as HTMLInputElement).value })}/>
          </label>
          <label class="wizard-field"><span>Palette</span>
            <input .value=${f.palette} placeholder="warm-onyx" @input=${(e: InputEvent) => upd({ palette: (e.target as HTMLInputElement).value })}/>
          </label>
        </div>
      `;
    }

    return html``;
  }

  // ─── Integrations tab ─────────────────────────────────────────────────

  private renderIntegrations(page: ContentPage): TemplateResult {
    const features = PLATFORM_FEATURES[page.surface] ?? [];
    // Connected only when the gateway holds a key ManyChat accepted — a page
    // flag alone (e.g. from the old mock connect) is not a connection.
    const mcConnected = Boolean(this.mcStatus?.connected);
    const mcStale = !mcConnected && Boolean(page.integrations?.manychat?.connected);
    const mcSubs = this.mcStatus?.subscriberCount ?? null;
    const igStatus = this.igStatus;

    return html`
      <div class="integrations">
        ${page.surface === 'instagram' ? html`
          <div class="panel">
            <div class="panel-head">Platform Connections</div>
            <div class="intg-connections">
              <!-- Instagram Graph API row -->
              <div class="intg-conn-row">
                <div class="intg-conn-icon">${surfaceIcon('instagram')}</div>
                <div class="intg-conn-info">
                  <div class="intg-conn-name">Instagram Graph API</div>
                  <div class="intg-conn-desc">Live follower counts, reach, and impressions from the official Graph API</div>
                  ${igStatus?.connected && igStatus.lastSyncAt ? html`
                    <div class="intg-conn-meta">Last synced ${fmtRelative(igStatus.lastSyncAt)}</div>
                  ` : nothing}
                  ${igStatus?.expiringSoon ? html`
                    <div class="intg-conn-warn">${commIcon("alert", 13)} Token expires in ${igStatus.daysUntilExpiry} day${igStatus.daysUntilExpiry === 1 ? '' : 's'} — refresh now</div>
                  ` : nothing}
                </div>
                <div class="intg-conn-status">
                  ${igStatus?.connected
                    ? html`<span class="intg-badge intg-badge--connected">
                        <span class="intg-dot"></span>
                        ${igStatus.accountName ? `@${igStatus.accountName}` : 'Connected'}
                      </span>`
                    : html`<span class="intg-badge intg-badge--disconnected">Not connected</span>`}
                </div>
                <div class="intg-conn-actions">
                  ${igStatus?.connected ? html`
                    <button class="btn-ghost btn-ghost--sm" @click=${() => this.openIgSetup(page)} title="Update credentials">
                      Update
                    </button>
                    ${igStatus.expiringSoon ? html`
                      <button class="btn-ghost btn-ghost--sm" ?disabled=${this.igRefreshing}
                        @click=${() => this.igRefreshToken()}>
                        ${this.igRefreshing ? 'Refreshing…' : 'Refresh token'}
                      </button>
                    ` : nothing}
                    <button class="btn-ghost btn-ghost--sm btn-ghost--danger" ?disabled=${this.igDisconnecting}
                      @click=${() => this.igDisconnect(page)}>
                      ${this.igDisconnecting ? 'Disconnecting…' : 'Disconnect'}
                    </button>
                  ` : html`
                    <button class="btn-primary btn-primary--sm" @click=${() => this.openIgSetup(page)}>
                      Connect Instagram
                    </button>
                  `}
                </div>
              </div>

              <!-- ManyChat row -->
              <div class="intg-conn-row">
                <div class="intg-conn-icon">
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                </div>
                <div class="intg-conn-info">
                  <div class="intg-conn-name">ManyChat</div>
                  <div class="intg-conn-desc">DM automation and comment triggers via ManyChat flows</div>
                </div>
                <div class="intg-conn-status">
                  ${mcConnected
                    ? html`<span class="intg-badge intg-badge--connected">
                        <span class="intg-dot"></span>
                        ${this.mcStatus?.accountName ?? 'Connected'}${mcSubs ? ` · ${fmtNumber(mcSubs)} subs` : ''}
                      </span>`
                    : html`<span class="intg-badge intg-badge--disconnected">${mcStale ? 'Not connected — reconnect' : 'Not connected'}</span>`}
                </div>
                <div class="intg-conn-actions">
                  <button class="btn-ghost btn-ghost--sm" ?disabled=${this.mcConnecting}
                    @click=${() => this.openManyChatConnect(page)}>
                    ${this.mcConnecting ? 'Connecting…' : mcConnected ? 'Update key' : 'Connect'}
                  </button>
                  ${mcConnected ? html`
                    <button class="btn-ghost btn-ghost--sm btn-ghost--danger" ?disabled=${this.mcConnecting}
                      @click=${() => this.mcDisconnect(page)}>Disconnect</button>
                  ` : nothing}
                </div>
              </div>
            </div>
          </div>
        ` : nothing}

        ${features.length > 0 ? html`
          <div class="panel">
            <div class="panel-head">Automations & Features</div>
            <div class="feature-tiles">
              ${features.map(f => {
                const isConnected = this.isFeatureConnected(page, f);
                const hasConfig = Object.keys(page.features?.[f.id] ?? {}).length > 0;
                return html`
                  <div class="feature-tile ${isConnected ? 'feature-tile--active' : ''}">
                    <div class="feature-tile-head">
                      <div class="feature-tile-meta">
                        <div class="feature-tile-name">${f.name}</div>
                        <div class="feature-tile-desc">${f.description}</div>
                      </div>
                      <div class="feature-tile-right">
                        ${f.requiredIntegration ? html`
                          <span class="intg-req-badge">${f.requiredIntegration}</span>
                        ` : nothing}
                        <span class="intg-badge ${isConnected ? 'intg-badge--connected' : hasConfig ? 'intg-badge--partial' : 'intg-badge--disconnected'}">
                          ${isConnected ? 'Active' : hasConfig ? 'Partial' : 'Needs setup'}
                        </span>
                      </div>
                    </div>
                    <button class="btn-ghost btn-ghost--sm"
                      @click=${() => this.openFeatureModal(page, f)}>
                      Configure
                    </button>
                  </div>
                `;
              })}
            </div>
          </div>
        ` : html`
          <div class="muted child-empty">No platform features configured for ${surfaceLabel(page.surface)} pages.</div>
        `}
      </div>
    `;
  }

  private isFeatureConnected(page: ContentPage, feature: PlatformFeature): boolean {
    if (!feature.requiredIntegration) {
      return Object.keys(page.features?.[feature.id] ?? {}).length > 0;
    }
    if (feature.requiredIntegration === 'instagram-graph') {
      return !!page.integrations?.instagramGraph?.connected;
    }
    if (feature.requiredIntegration === 'manychat') {
      return Boolean(this.mcStatus?.connected) && !!page.integrations?.manychat?.connected;
    }
    return false;
  }

  private openFeatureModal(page: ContentPage, feature: PlatformFeature): void {
    this.featureModalValues = { ...(page.features ?? {}) };
    this.featureModal = { feature, pageId: page.id };
    this.featureModalError = null;
  }

  private closeFeatureModal(): void {
    this.featureModal = null;
    this.featureModalError = null;
  }

  private async saveFeatureModal(): Promise<void> {
    const modal = this.featureModal;
    if (!modal) return;
    const client = this.client;
    if (!client) return;
    this.featureModalSaving = true;
    this.featureModalError = null;
    try {
      const values = this.featureModalValues[modal.feature.id] ?? {};
      const res = await client.request<{ page: ContentPage }>("content.pages.features.set", {
        pageId: modal.pageId,
        featureId: modal.feature.id,
        values,
      });
      this.pages = this.pages.map(p => p.id === modal.pageId ? res.page : p);
      this.closeFeatureModal();
    } catch (e) {
      this.featureModalError = e instanceof Error ? e.message : String(e);
    } finally {
      this.featureModalSaving = false;
    }
  }

  private openIgSetup(page: ContentPage): void {
    this.igSetupPage = page;
    this.igSetupStep = 0;
    this.igSetupToken = '';
    this.igSetupError = null;
    this.igSetupProfile = null;
    this.igSetupValidating = false;
    this.igSetupModal = true;
  }

  private closeIgSetup(): void {
    this.igSetupModal = false;
    this.igSetupPage = null;
    this.igSetupError = null;
    this.igSetupProfile = null;
  }

  private async igSetupValidateToken(): Promise<void> {
    const token = this.igSetupToken.trim();
    if (!token) { this.igSetupError = 'Paste your access token first.'; return; }
    const client = this.client;
    if (!client) return;
    this.igSetupValidating = true;
    this.igSetupError = null;
    this.igSetupProfile = null;
    try {
      const res = await client.request<{
        valid: boolean;
        username?: string;
        followersCount?: number;
        mediaCount?: number;
        profilePictureUrl?: string;
        biography?: string;
      }>("instagram.setup.test", { accessToken: token });
      if (!res.valid) {
        this.igSetupError = 'Token validation failed. Check the token and try again.';
        return;
      }
      this.igSetupProfile = {
        username: res.username ?? '',
        followersCount: res.followersCount ?? 0,
        mediaCount: res.mediaCount ?? 0,
        profilePictureUrl: res.profilePictureUrl ?? '',
        biography: res.biography ?? '',
      };
      this.igSetupStep = 1;
    } catch (e) {
      this.igSetupError = e instanceof Error ? e.message : String(e);
    } finally {
      this.igSetupValidating = false;
    }
  }

  private async igSetupConfirm(): Promise<void> {
    const token = this.igSetupToken.trim();
    const page = this.igSetupPage;
    const client = this.client;
    if (!token || !page || !client) return;
    this.igSetupValidating = true;
    this.igSetupError = null;
    try {
      const res = await client.request<{
        connected: boolean;
        accountName?: string;
        igBusinessAccountId?: string;
        tokenExpiresAt?: number;
      }>("instagram.setup.connect", { accessToken: token });
      if (!res.connected) {
        this.igSetupError = 'Connection failed. Try again.';
        return;
      }
      // Update the page's integrations record.
      const updated = await client.request<{ page: ContentPage }>("content.pages.integrations.update", {
        pageId: page.id,
        integrations: {
          instagramGraph: {
            connected: true,
            igPageId: res.igBusinessAccountId,
            accountName: res.accountName,
            lastSyncAt: Date.now(),
          },
        },
      });
      this.pages = this.pages.map(p => p.id === page.id ? updated.page : p);
      // Refresh global IG status.
      await this.loadIgStatus();
      this.igSetupStep = 2;
    } catch (e) {
      this.igSetupError = e instanceof Error ? e.message : String(e);
    } finally {
      this.igSetupValidating = false;
    }
  }

  private async loadMcStatus(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      this.mcStatus = await client.request<{ connected: boolean; accountName?: string | null; subscriberCount?: number | null }>("manychat.status", {});
    } catch {
      this.mcStatus = { connected: false };
    }
  }

  private async loadIgStatus(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.igStatusLoading = true;
    try {
      const res = await client.request<{
        connected: boolean;
        accountName?: string;
        igBusinessAccountId?: string;
        tokenExpiresAt?: number;
        daysUntilExpiry?: number | null;
        expiringSoon?: boolean;
        lastSyncAt?: number;
      }>("instagram.setup.status", {});
      this.igStatus = res;
    } catch {
      this.igStatus = { connected: false };
    } finally {
      this.igStatusLoading = false;
    }
  }

  private async igDisconnect(page: ContentPage): Promise<void> {
    if (!confirm('Disconnect Instagram? This will remove your stored credentials.')) return;
    const client = this.client;
    if (!client) return;
    this.igDisconnecting = true;
    try {
      await client.request("instagram.setup.disconnect", {});
      const updated = await client.request<{ page: ContentPage }>("content.pages.integrations.update", {
        pageId: page.id,
        integrations: { instagramGraph: { connected: false } },
      });
      this.pages = this.pages.map(p => p.id === page.id ? updated.page : p);
      this.igStatus = { connected: false };
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.igDisconnecting = false;
    }
  }

  private async igRefreshToken(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.igRefreshing = true;
    try {
      const res = await client.request<{ refreshed: boolean; daysUntilExpiry?: number }>("instagram.setup.refresh", {});
      if (res.refreshed) await this.loadIgStatus();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.igRefreshing = false;
    }
  }

  private async openManyChatConnect(page: ContentPage): Promise<void> {
    const apiKey = prompt('Enter your ManyChat API key (from ManyChat → Settings → API):');
    if (!apiKey) return;
    const client = this.client;
    if (!client) return;
    this.mcConnecting = true;
    try {
      // Verified server-side; the key is stored only when ManyChat accepts it.
      const res = await client.request<{ connected: boolean; accountName?: string | null; subscriberCount?: number | null }>("manychat.connect", {
        apiKey,
      });
      if (res.connected) {
        this.mcStatus = res;
        const updated = await client.request<{ page: ContentPage }>("content.pages.integrations.update", {
          pageId: page.id,
          integrations: {
            manychat: {
              connected: true,
              apiKeyRef: 'secrets/manychat.json',
              subscriberCount: res.subscriberCount ?? undefined,
            },
          },
        });
        this.pages = this.pages.map(p => p.id === page.id ? updated.page : p);
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.mcConnecting = false;
    }
  }

  private async mcDisconnect(page: ContentPage): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.mcConnecting = true;
    try {
      await client.request("manychat.disconnect", {});
      const updated = await client.request<{ page: ContentPage }>("content.pages.integrations.update", {
        pageId: page.id,
        integrations: { manychat: { connected: false } },
      });
      this.pages = this.pages.map(p => p.id === page.id ? updated.page : p);
      await this.loadMcStatus();
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
    } finally {
      this.mcConnecting = false;
    }
  }

  // ─── Instagram Setup Modal ────────────────────────────────────────────────

  private renderIgSetupModal(): TemplateResult {
    const step = this.igSetupStep;
    const profile = this.igSetupProfile;

    const header = (title: string, sub: string) => html`
      <div class="fm-header">
        <div>
          <div class="fm-title">${title}</div>
          <div class="fm-subtitle">${sub}</div>
        </div>
        <button class="wizard-close" @click=${() => this.closeIgSetup()}>×</button>
      </div>
    `;

    const stepIndicator = html`
      <div class="ig-steps">
        ${['Get token', 'Confirm', 'Done'].map((label, i) => html`
          <div class="ig-step ${i === step ? 'ig-step--active' : i < step ? 'ig-step--done' : ''}">
            <div class="ig-step-dot">${i < step ? '✓' : i + 1}</div>
            <div class="ig-step-label">${label}</div>
          </div>
          ${i < 2 ? html`<div class="ig-step-line ${i < step ? 'ig-step-line--done' : ''}"></div>` : nothing}
        `)}
      </div>
    `;

    // ── Step 0: Enter token ──────────────────────────────────────────
    const step0 = html`
      ${header('Connect Instagram', 'Paste a long-lived Page Access Token to connect your Instagram Business account.')}
      <div class="fm-body">
        ${stepIndicator}
        <div class="ig-callout">
          <strong>How to get your token</strong>
          <ol class="ig-steps-list">
            <li>Go to <a href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noopener" class="ig-link">Graph API Explorer</a></li>
            <li>Select your Facebook App (or create one at <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener" class="ig-link">developers.facebook.com/apps</a>)</li>
            <li>Add permissions: <code>instagram_basic</code>, <code>instagram_manage_insights</code>, <code>pages_read_engagement</code>, <code>pages_show_list</code></li>
            <li>Click <strong>Generate Access Token</strong> and copy it here</li>
          </ol>
          <details class="ig-help">
            <summary>Why do I need this?</summary>
            <p>The Graph API token lets InfiniBot read your follower count, post reach, impressions, and engagement data directly from Instagram — no screen-scraping, just the official API.</p>
          </details>
        </div>
        <div class="fm-field">
          <label class="fm-mono">Access Token</label>
          <input
            type="password"
            class="fm-input"
            placeholder="EAABwz..."
            .value=${this.igSetupToken}
            @input=${(e: InputEvent) => { this.igSetupToken = (e.target as HTMLInputElement).value; this.igSetupError = null; }}
            @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') void this.igSetupValidateToken(); }}
          />
          <span class="fm-hint">Long-lived tokens last 60 days. We'll remind you when it's time to refresh.</span>
        </div>
        ${this.igSetupError ? html`<div class="ig-error">${this.igSetupError}</div>` : nothing}
      </div>
      <div class="fm-footer">
        <button class="btn-ghost" @click=${() => this.closeIgSetup()}>Cancel</button>
        <button class="btn-primary" ?disabled=${!this.igSetupToken.trim() || this.igSetupValidating}
          @click=${() => void this.igSetupValidateToken()}>
          ${this.igSetupValidating ? 'Validating…' : 'Validate token →'}
        </button>
      </div>
    `;

    // ── Step 1: Confirm account ──────────────────────────────────────
    const step1 = html`
      ${header('Confirm account', 'Token validated — review your account details before connecting.')}
      <div class="fm-body">
        ${stepIndicator}
        ${profile ? html`
          <div class="ig-account-preview">
            ${profile.profilePictureUrl ? html`<img class="ig-avatar" src="${profile.profilePictureUrl}" alt="Profile"/>` : nothing}
            <div class="ig-account-info">
              <div class="ig-account-handle">@${profile.username}</div>
              <div class="ig-account-stats">
                <span><strong>${fmtNumber(profile.followersCount)}</strong> followers</span>
                <span><strong>${fmtNumber(profile.mediaCount)}</strong> posts</span>
              </div>
              ${profile.biography ? html`<div class="ig-account-bio">${profile.biography}</div>` : nothing}
            </div>
          </div>
        ` : nothing}
        <div class="ig-callout ig-callout--success">
          Token is valid. Click <strong>Connect</strong> to store credentials securely and start pulling analytics.
        </div>
        ${this.igSetupError ? html`<div class="ig-error">${this.igSetupError}</div>` : nothing}
      </div>
      <div class="fm-footer">
        <button class="btn-ghost" @click=${() => { this.igSetupStep = 0; this.igSetupError = null; }}>← Back</button>
        <button class="btn-primary" ?disabled=${this.igSetupValidating}
          @click=${() => void this.igSetupConfirm()}>
          ${this.igSetupValidating ? 'Connecting…' : 'Connect →'}
        </button>
      </div>
    `;

    // ── Step 2: Success ──────────────────────────────────────────────
    const step2 = html`
      ${header('Instagram connected!', 'Your account is now linked.')}
      <div class="fm-body">
        ${stepIndicator}
        <div class="ig-success-state">
          <div class="ig-success-icon">✓</div>
          <div class="ig-success-text">
            ${this.igStatus?.accountName ? html`<strong>@${this.igStatus.accountName}</strong> is connected.` : 'Instagram is connected.'}
            ${this.igStatus?.tokenExpiresAt ? html`
              <div class="ig-success-expiry">
                Token valid for ${this.igStatus.daysUntilExpiry ?? 60} more days.
                We'll remind you when it's time to refresh.
              </div>
            ` : nothing}
          </div>
          <div class="ig-success-hint">
            Go to the <strong>Analytics</strong> tab to see real follower counts and post insights.<br/>
            Use <strong>Integrations → Update</strong> to change credentials at any time.
          </div>
        </div>
      </div>
      <div class="fm-footer">
        <button class="btn-primary" @click=${() => this.closeIgSetup()}>Done</button>
      </div>
    `;

    return html`
      <div class="fm-overlay" @click=${(e: MouseEvent) => { if (e.target === e.currentTarget) this.closeIgSetup(); }}>
        <div class="fm-modal fm-modal--ig">
          ${step === 0 ? step0 : step === 1 ? step1 : step2}
        </div>
      </div>
    `;
  }

  private renderFeatureModal(): TemplateResult {
    const modal = this.featureModal;
    if (!modal) return html``;
    const { feature } = modal;

    const getVal = (fieldId: string): unknown => {
      return (this.featureModalValues[feature.id] ?? {})[fieldId] ?? '';
    };
    const setVal = (fieldId: string, val: unknown): void => {
      this.featureModalValues = {
        ...this.featureModalValues,
        [feature.id]: {
          ...(this.featureModalValues[feature.id] ?? {}),
          [fieldId]: val,
        },
      };
    };

    const renderField = (field: FeatureConfigField): TemplateResult => {
      const val = getVal(field.id);
      if (field.type === 'checkbox') {
        return html`
          <div class="fm-field fm-field--checkbox">
            <label class="fm-checkbox-label">
              <input type="checkbox" class="fm-checkbox-input" .checked=${!!val}
                @change=${(e: Event) => setVal(field.id, (e.target as HTMLInputElement).checked)}/>
              <span class="fm-checkbox-box"></span>
              <span class="fm-mono">${field.label}</span>
              ${field.required ? html`<span class="fm-required">*</span>` : nothing}
            </label>
            ${field.hint ? html`<span class="fm-hint">${field.hint}</span>` : nothing}
          </div>
        `;
      }
      if (field.type === 'select') {
        return html`
          <div class="fm-field">
            <label class="fm-mono">${field.label}${field.required ? html`<span class="fm-required">*</span>` : nothing}</label>
            <select class="fm-select" .value=${String(val)}
              @change=${(e: Event) => setVal(field.id, (e.target as HTMLSelectElement).value)}>
              <option value="">Select…</option>
              ${field.options?.map(opt => html`<option value="${opt.value}" ?selected=${val === opt.value}>${opt.label}</option>`)}
            </select>
            ${field.hint ? html`<span class="fm-hint">${field.hint}</span>` : nothing}
          </div>
        `;
      }
      if (field.type === 'textarea') {
        return html`
          <div class="fm-field">
            <label class="fm-mono">${field.label}${field.required ? html`<span class="fm-required">*</span>` : nothing}</label>
            <textarea class="fm-textarea" placeholder="${field.placeholder ?? ''}" .value=${String(val)}
              @input=${(e: Event) => setVal(field.id, (e.target as HTMLTextAreaElement).value)}></textarea>
            ${field.hint ? html`<span class="fm-hint">${field.hint}</span>` : nothing}
          </div>
        `;
      }
      return html`
        <div class="fm-field">
          <label class="fm-mono">${field.label}${field.required ? html`<span class="fm-required">*</span>` : nothing}</label>
          <input type="${field.type}" class="fm-input"
            placeholder="${field.placeholder ?? ''}"
            .value=${String(val)}
            @input=${(e: Event) => setVal(field.id, (e.target as HTMLInputElement).value)}/>
          ${field.hint ? html`<span class="fm-hint">${field.hint}</span>` : nothing}
        </div>
      `;
    };

    return html`
      <div class="fm-overlay" @click=${(e: MouseEvent) => { if (e.target === e.currentTarget) this.closeFeatureModal(); }}>
        <div class="fm-modal">
          <div class="fm-header">
            <div>
              <div class="fm-title">${feature.name}</div>
              <div class="fm-subtitle">${feature.description}</div>
            </div>
            <button class="wizard-close" @click=${() => this.closeFeatureModal()}>×</button>
          </div>
          ${feature.requiredIntegration ? html`
            <div class="fm-integration-notice">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              Requires ${feature.requiredIntegration.toUpperCase()} — configure the connection on the Integrations tab first.
            </div>
          ` : nothing}
          <div class="fm-body">
            ${feature.sections ? feature.sections.map(section => html`
              <div class="fm-section">
                <div class="fm-section-title">${section.title}</div>
                <div class="fm-section-fields">
                  ${section.fields.map(field => renderField(field))}
                </div>
              </div>
            `) : feature.configFields?.map(field => renderField(field))}
          </div>
          ${this.featureModalError ? html`<div class="fm-error">${this.featureModalError}</div>` : nothing}
          <div class="fm-footer">
            <button class="btn-ghost" @click=${() => this.closeFeatureModal()}>Cancel</button>
            <button class="btn-primary" ?disabled=${this.featureModalSaving} @click=${() => this.saveFeatureModal()}>
              ${this.featureModalSaving ? 'Saving…' : 'Save configuration'}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private wizardConnectInstagram(): void {
    // Open the IG setup modal. When connected, it updates the page automatically.
    // In the new-page wizard we don't have a page yet, so skip — user can
    // connect from the Integrations tab after creating the page.
    alert('Create the page first, then connect Instagram from the Integrations tab.');
  }

  private async wizardTestManyChat(): Promise<void> {
    if (!this.wizardMcApiKey) return;
    const client = this.client;
    if (!client) return;
    this.wizardMcStatus = 'connecting';
    try {
      const res = await client.request<{ connected: boolean; accountName?: string }>("manychat.connect", {
        apiKey: this.wizardMcApiKey,
      });
      if (res.connected) {
        this.wizardMcStatus = 'connected';
        this.wizardMcAccountName = res.accountName ?? '';
        void this.loadMcStatus();
      } else {
        this.wizardMcStatus = 'error';
      }
    } catch {
      this.wizardMcStatus = 'error';
    }
  }

  // ─── Styles ────────────────────────────────────────────────────────────

  static styles = css`
    :host {
      display: block;
      height: 100%;
      width: 100%;
      color: var(--text, #f7f7f7);
      font-family: var(--font-body, system-ui, sans-serif);
    }
    .hub {
      display: flex;
      flex-direction: column;
      gap: 20px;
      padding: 20px 24px 60px;
      max-width: 1480px;
      margin: 0 auto;
      min-height: 100%;
      color: var(--g-primary, #caa45a);
    }
    /* ─── Header */
    .hub-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }
    .hub-crumbs { display: flex; gap: 8px; align-items: baseline; font-size: 13px; color: rgba(247,247,247,0.6); }
    .crumb-link {
      background: none;
      border: none;
      color: inherit;
      cursor: default;
      font-size: 18px;
      letter-spacing: 0.02em;
      padding: 0;
      font-weight: 600;
    }
    .crumb-link--clickable { cursor: pointer; color: var(--g-primary, #caa45a); }
    .crumb-link--clickable:hover { text-decoration: underline; }
    .crumb-current { font-size: 18px; color: var(--text, #f7f7f7); font-weight: 600; }
    .crumb-sep { color: rgba(247,247,247,0.3); font-size: 18px; }
    .hub-controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .hub-search, .hub-select {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      color: var(--text, #f7f7f7);
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 13px;
      min-width: 160px;
    }
    .hub-search:focus, .hub-select:focus { outline: 1px solid var(--g-primary, #caa45a); }
    .btn-primary {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary, #caa45a) 80%, transparent), var(--g-primary, #caa45a));
      color: #0a0a0a;
      border: none;
      padding: 9px 16px;
      border-radius: 9px;
      cursor: pointer;
      font-weight: 600;
      font-size: 13px;
      box-shadow: 0 6px 16px -8px color-mix(in srgb, var(--g-primary, #caa45a) 60%, transparent);
    }
    .btn-primary:hover { filter: brightness(1.05); }
    .btn-ghost {
      background: rgba(255,255,255,0.03);
      color: var(--text, #f7f7f7);
      border: 1px solid rgba(255,255,255,0.08);
      padding: 8px 14px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
    }
    .btn-ghost:hover { background: rgba(255,255,255,0.06); }
    .btn-ghost--sm { padding: 5px 10px; font-size: 12px; }
    .error-bar {
      background: rgba(244,63,94,0.12);
      border: 1px solid rgba(244,63,94,0.4);
      color: #fca5a5;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 13px;
    }
    .state-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 80px 20px;
      text-align: center;
      color: rgba(247,247,247,0.6);
    }
    .empty-mark { color: var(--g-primary, #caa45a); opacity: 0.7; }
    .empty-title { font-size: 20px; color: var(--text, #f7f7f7); font-weight: 600; }
    .empty-sub { max-width: 480px; line-height: 1.5; }
    .spinner {
      width: 28px; height: 28px;
      border: 2px solid rgba(255,255,255,0.1);
      border-top-color: var(--g-primary, #caa45a);
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ─── Grid */
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 18px;
    }

    /* ── Depth-gradient glass card ── */
    .card {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 12px;
      text-align: left;
      padding: 18px;
      border-radius: 18px;
      border: 1px solid rgba(255,255,255,0.07);
      background:
        radial-gradient(circle at top left, color-mix(in srgb, var(--g-primary, #caa45a) 14%, transparent) 0%, transparent 60%),
        linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0) 50%, rgba(0,0,0,0.22) 100%);
      backdrop-filter: blur(24px) saturate(160%);
      -webkit-backdrop-filter: blur(24px) saturate(160%);
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.07),
        0 30px 60px -20px rgba(0,0,0,0.55),
        0 12px 24px -8px rgba(0,0,0,0.35);
      color: var(--g-primary, #caa45a);
      cursor: pointer;
      transition: transform 220ms ease, box-shadow 220ms ease;
      overflow: hidden;
    }
    .card:hover {
      transform: translateY(-3px) rotate(0.6deg);
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.1),
        0 36px 72px -22px rgba(0,0,0,0.6),
        0 16px 28px -10px rgba(0,0,0,0.4);
    }
    .card-bloom {
      position: absolute;
      top: -40%;
      left: -10%;
      width: 80%;
      height: 100%;
      background: radial-gradient(ellipse at center, color-mix(in srgb, var(--g-primary, #caa45a) 20%, transparent) 0%, transparent 70%);
      pointer-events: none;
      mix-blend-mode: screen;
      opacity: 0.5;
    }
    .card-row { display: flex; justify-content: space-between; align-items: center; }
    .card-row--top { color: rgba(247,247,247,0.85); }
    .surface-chip { display: inline-flex; align-items: center; gap: 8px; color: var(--g-primary, #caa45a); }
    .surface-icon { display: inline-flex; }
    .surface-name { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(247,247,247,0.6); }
    .status {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      padding: 3px 8px;
      border-radius: 999px;
      background: rgba(255,255,255,0.06);
      color: rgba(247,247,247,0.8);
      border: 1px solid rgba(255,255,255,0.08);
    }
    .status--active { color: #4ade80; border-color: rgba(74,222,128,0.4); background: rgba(74,222,128,0.08); }
    .status--draft { color: #facc15; border-color: rgba(250,204,21,0.35); background: rgba(250,204,21,0.07); }
    .status--paused { color: #fb923c; border-color: rgba(251,146,60,0.35); background: rgba(251,146,60,0.07); }
    .status--archived { color: #94a3b8; }
    .card-name { font-size: 18px; font-weight: 600; color: var(--text, #f7f7f7); }
    .card-sub { display: flex; gap: 6px; font-size: 12px; color: rgba(247,247,247,0.55); }
    .dot { opacity: 0.5; }
    .card { container-type: inline-size; }
    .card-stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 8px;
    }
    /* Narrow cards (desktop grid columns, phones): 2x2 so labels fit. */
    @container (max-width: 420px) {
      .card-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    .stat-tile {
      min-width: 0;
      padding: 10px 8px;
      background: rgba(255,255,255,0.025);
      border: 1px solid rgba(255,255,255,0.05);
      border-radius: 10px;
      text-align: center;
    }
    .stat-val { font-size: 15px; font-weight: 600; color: var(--text, #f7f7f7); }
    .stat-lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(247,247,247,0.45); margin-top: 2px; }
    .card-spark { color: var(--g-primary, #caa45a); }
    .card-foot { font-size: 11px; color: rgba(247,247,247,0.5); }

    /* ─── Detail */
    .detail {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .detail-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
    .detail-tab {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      color: rgba(247,247,247,0.65);
      padding: 8px 14px;
      border-radius: 10px;
      font-size: 13px;
      cursor: pointer;
      transition: all 160ms ease;
    }
    .detail-tab:hover { color: var(--text, #f7f7f7); }
    .detail-tab.is-active {
      color: var(--text, #f7f7f7);
      background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary, #caa45a) 22%, transparent), color-mix(in srgb, var(--g-primary, #caa45a) 8%, transparent));
      border-color: color-mix(in srgb, var(--g-primary, #caa45a) 40%, transparent);
    }
    .detail-body {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .overview, .insights, .kanban, .video-grid { display: flex; flex-direction: column; gap: 18px; }
    .kpi-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
    }
    .kpi {
      padding: 18px;
      border-radius: 16px;
      border: 1px solid rgba(255,255,255,0.07);
      background:
        radial-gradient(circle at top left, color-mix(in srgb, var(--g-primary, #caa45a) 12%, transparent) 0%, transparent 60%),
        linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0) 50%, rgba(0,0,0,0.18) 100%);
      backdrop-filter: blur(20px) saturate(150%);
      -webkit-backdrop-filter: blur(20px) saturate(150%);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
    }
    .kpi-val { font-size: 26px; font-weight: 700; color: var(--text, #f7f7f7); }
    .kpi-lbl { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(247,247,247,0.55); margin-top: 4px; }
    .kpi-sub { font-size: 11px; color: var(--g-primary, #caa45a); margin-top: 6px; }
    .overview-row { display: grid; grid-template-columns: 1.4fr 1fr; gap: 14px; }
    @media (max-width: 900px) { .overview-row { grid-template-columns: 1fr; } }
    .panel {
      padding: 16px;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.07);
      background: linear-gradient(135deg, rgba(255,255,255,0.035) 0%, rgba(255,255,255,0) 60%, rgba(0,0,0,0.15) 100%);
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.05);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .panel-head { font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; color: rgba(247,247,247,0.6); }
    .trend { color: var(--g-primary, #caa45a); }
    .goals { display: flex; gap: 16px; flex-wrap: wrap; color: var(--g-primary, #caa45a); }
    .ring { position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px; }
    .ring-meta { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; pointer-events: none; }
    .ring-val { font-size: 13px; font-weight: 600; color: var(--text, #f7f7f7); }
    .ring-lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(247,247,247,0.55); }
    .conn-mini { display: flex; gap: 10px; flex-wrap: wrap; }
    .conn-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      font-size: 12px;
      color: rgba(247,247,247,0.85);
    }
    .conn-count {
      background: var(--g-primary, #caa45a);
      color: #0a0a0a;
      font-weight: 700;
      padding: 1px 7px;
      border-radius: 999px;
      font-size: 11px;
    }
    .insights-mini { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
    .insights-mini li { display: flex; gap: 8px; align-items: center; color: rgba(247,247,247,0.85); }
    .muted { color: rgba(247,247,247,0.5); font-size: 13px; }
    .child-empty { padding: 28px 4px; }

    /* ── Child tables */
    .child-panel { display: flex; flex-direction: column; gap: 12px; }
    .child-head { display: flex; justify-content: space-between; align-items: center; }
    .child-head h3 { margin: 0; font-size: 15px; color: var(--text, #f7f7f7); font-weight: 600; }
    .child-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .child-table th, .child-table td { padding: 9px 10px; border-bottom: 1px solid rgba(255,255,255,0.05); text-align: left; color: rgba(247,247,247,0.85); }
    .child-table th { color: rgba(247,247,247,0.5); font-weight: 500; text-transform: uppercase; font-size: 11px; letter-spacing: 0.06em; }
    .row-actions { width: 32px; text-align: right; }
    .row-del { background: none; border: none; color: rgba(247,247,247,0.45); cursor: pointer; font-size: 18px; }
    .row-del:hover { color: #f43f5e; }

    /* ── Videos */
    .video-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
    .video-card {
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      overflow: hidden;
      background: rgba(255,255,255,0.03);
    }
    .video-thumb { aspect-ratio: 16/9; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; }
    .video-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .video-thumb-placeholder { color: rgba(255,255,255,0.3); }
    .video-meta { padding: 12px; display: flex; flex-direction: column; gap: 6px; }
    .video-title { font-size: 13px; color: var(--text, #f7f7f7); font-weight: 500; }
    .video-row { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: rgba(247,247,247,0.55); }
    .status-chip {
      padding: 2px 8px;
      background: rgba(255,255,255,0.06);
      border-radius: 999px;
      font-size: 11px;
      color: rgba(247,247,247,0.7);
    }
    .video-link { font-size: 12px; color: var(--g-primary, #caa45a); }

    /* ── Linked pages */
    .linked-strip { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .linked-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: rgba(247,247,247,0.5); }
    .linked-none { font-size: 12px; }
    .linked-chip {
      display: inline-flex; align-items: center;
      border-radius: 999px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 35%, transparent);
      background: color-mix(in srgb, var(--g-primary, #caa45a) 9%, transparent);
    }
    .linked-open {
      display: inline-flex; align-items: center; gap: 6px;
      background: none; border: none; cursor: pointer;
      padding: 4px 4px 4px 10px; color: var(--text, #f7f7f7); font-size: 12px;
    }
    .linked-icon { display: inline-flex; color: var(--g-primary, #caa45a); }
    .linked-icon svg { width: 15px; height: 15px; }
    .linked-handle { font-weight: 600; }
    .linked-surface { color: rgba(247,247,247,0.55); }
    .linked-x { background: none; border: none; color: rgba(247,247,247,0.45); cursor: pointer; font-size: 15px; padding: 0 10px 0 4px; }
    .linked-x:hover { color: #f43f5e; }
    .linked-add { padding: 4px 8px; font-size: 12px; }

    /* ── Content Intelligence */
    .intel-panel .panel-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .intel-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; }
    .intel-tiers { display: flex; gap: 6px; flex-wrap: wrap; }
    .intel-tier { font-size: 11px; padding: 2px 9px; border-radius: 999px; background: rgba(255,255,255,0.05); color: rgba(247,247,247,0.75); }
    .intel-tier b { color: var(--g-primary, #caa45a); margin-left: 3px; }
    .intel-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; }
    .intel-list li { display: flex; justify-content: space-between; gap: 10px; min-width: 0; }
    .intel-list a { color: var(--text, #f7f7f7); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .intel-list a:hover { color: var(--g-primary, #caa45a); }
    .intel-list .muted { flex-shrink: 0; font-size: 11px; }

    /* ── Series */
    .stage-notice { font-size: 12px; color: var(--g-primary, #caa45a); }
    .series-group {
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 14px;
      padding: 14px;
      background: linear-gradient(135deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0) 60%);
      display: flex; flex-direction: column; gap: 12px;
    }
    .series-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; }
    .series-name { font-size: 16px; font-weight: 700; color: var(--text, #f7f7f7); }
    .series-meta { display: flex; gap: 6px; flex-wrap: wrap; font-size: 11px; color: rgba(247,247,247,0.55); align-items: center; }
    .series-count { padding: 1px 8px; border-radius: 999px; background: rgba(255,255,255,0.05); }
    .season-head { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: rgba(247,247,247,0.5); margin-bottom: 6px; }
    .episode-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .episode {
      display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; gap: 12px; align-items: start;
      padding: 10px 12px; border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.05); background: rgba(255,255,255,0.02);
    }
    .ep-num { font-size: 12px; font-weight: 700; color: var(--g-primary, #caa45a); padding-top: 2px; }
    .ep-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .ep-title-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .ep-title { font-size: 13px; font-weight: 600; color: var(--text, #f7f7f7); }
    .ep-line { font-size: 12px; color: rgba(247,247,247,0.75); line-height: 1.45; }
    .ep-line b { color: rgba(247,247,247,0.5); font-weight: 600; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; margin-right: 4px; }
    .ep-line--muted { color: rgba(247,247,247,0.55); }
    .ep-foot { display: flex; gap: 10px; font-size: 11px; }
    .ep-flag { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: rgba(16,185,129,0.12); color: #6ee7b7; }
    @media (max-width: 640px) {
      .episode { grid-template-columns: minmax(0, 1fr); }
    }
    .stage-chip { font-size: 10px; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; letter-spacing: 0.06em; background: rgba(255,255,255,0.07); color: rgba(247,247,247,0.8); }
    .stage-chip--outlined { background: rgba(100,116,139,0.22); color: #cbd5e1; }
    .stage-chip--scripted { background: rgba(59,130,246,0.18); color: #93c5fd; }
    .stage-chip--filming { background: rgba(168,85,247,0.18); color: #d8b4fe; }
    .stage-chip--editing { background: rgba(236,72,153,0.18); color: #f9a8d4; }
    .stage-chip--scheduled { background: rgba(245,158,11,0.18); color: #fcd34d; }
    .stage-chip--posted { background: rgba(16,185,129,0.18); color: #6ee7b7; }
    .stage-chip--shelved { background: rgba(148,163,184,0.14); color: #94a3b8; }
    .btn-advance {
      font-size: 11px; white-space: nowrap; cursor: pointer;
      padding: 4px 10px; border-radius: 8px;
      border: 1px solid color-mix(in srgb, var(--g-primary, #caa45a) 40%, transparent);
      background: color-mix(in srgb, var(--g-primary, #caa45a) 12%, transparent);
      color: var(--text, #f7f7f7);
    }
    .btn-advance:hover:not([disabled]) { background: color-mix(in srgb, var(--g-primary, #caa45a) 24%, transparent); }
    .btn-advance[disabled] { opacity: 0.5; cursor: progress; }
    .stage-done { font-size: 11px; color: #6ee7b7; }

    /* ── Stage board */
    .stage-board {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(190px, 1fr);
      gap: 10px;
      overflow-x: auto;
      padding-bottom: 6px;
    }
    .stage-col {
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 12px;
      background: rgba(255,255,255,0.02);
      display: flex; flex-direction: column; min-height: 220px; min-width: 0;
    }
    .stage-col--posted { border-color: rgba(16,185,129,0.22); }
    .stage-card {
      padding: 9px 10px; border-radius: 9px;
      border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.035);
      display: flex; flex-direction: column; gap: 5px;
    }
    .stage-card-tags { display: flex; gap: 5px; flex-wrap: wrap; }
    .stage-kind { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: rgba(255,255,255,0.06); color: rgba(247,247,247,0.7); }
    .stage-kind--series { background: color-mix(in srgb, var(--g-primary, #caa45a) 18%, transparent); color: var(--g-primary, #caa45a); }
    .stage-card-title { font-size: 12px; color: var(--text, #f7f7f7); line-height: 1.35; }
    .stage-card-sub { font-size: 10px; color: rgba(247,247,247,0.5); }
    .stage-card-foot { display: flex; justify-content: flex-end; }

    /* ── Kanban */
    .kanban { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
    .kanban-col {
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 12px;
      background: rgba(255,255,255,0.02);
      display: flex;
      flex-direction: column;
      min-height: 200px;
    }
    .kanban-col-head { display: flex; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.04); font-size: 12px; color: rgba(247,247,247,0.65); text-transform: uppercase; letter-spacing: 0.08em; }
    .kanban-count { background: rgba(255,255,255,0.05); padding: 1px 7px; border-radius: 999px; font-size: 10px; color: rgba(247,247,247,0.8); }
    .kanban-cards { display: flex; flex-direction: column; gap: 8px; padding: 10px; }
    .kanban-card {
      padding: 8px 10px;
      border-radius: 8px;
      background: linear-gradient(135deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01));
      border: 1px solid rgba(255,255,255,0.05);
      font-size: 12px;
      color: var(--text, #f7f7f7);
    }
    .kanban-empty { font-size: 12px; color: rgba(247,247,247,0.3); padding: 10px 0; text-align: center; }

    /* ── Analytics charts */
    .cadence { display: flex; align-items: flex-end; height: 120px; gap: 6px; padding: 4px 0; }
    .cadence-bar-wrap { flex: 1; display: flex; align-items: flex-end; height: 100%; }
    .cadence-bar {
      width: 100%;
      min-height: 4px;
      border-radius: 4px 4px 2px 2px;
      background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary, #caa45a) 90%, transparent), color-mix(in srgb, var(--g-primary, #caa45a) 30%, transparent));
    }
    .funnel { display: flex; flex-direction: column; gap: 8px; }
    .funnel-row { display: grid; grid-template-columns: 110px 1fr 70px; align-items: center; gap: 10px; }
    .funnel-label { font-size: 12px; color: rgba(247,247,247,0.65); text-transform: uppercase; letter-spacing: 0.06em; }
    .funnel-bar-bg { background: rgba(255,255,255,0.04); height: 18px; border-radius: 4px; overflow: hidden; }
    .funnel-bar {
      height: 100%;
      background: linear-gradient(90deg, color-mix(in srgb, var(--g-primary, #caa45a) 30%, transparent), var(--g-primary, #caa45a));
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06);
    }
    .funnel-val { text-align: right; font-size: 12px; color: var(--text, #f7f7f7); }

    /* ── Insights */
    .insight {
      padding: 14px;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.07);
      background: linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0) 70%, rgba(0,0,0,0.12) 100%);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .insight--critical { border-color: rgba(244,63,94,0.4); }
    .insight--warning { border-color: rgba(251,146,60,0.35); }
    .insight--win { border-color: rgba(74,222,128,0.35); }
    .insight-head { display: flex; gap: 10px; align-items: center; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: rgba(247,247,247,0.5); }
    .sev {
      padding: 2px 7px;
      border-radius: 6px;
      background: rgba(255,255,255,0.06);
      color: rgba(247,247,247,0.75);
      font-weight: 600;
    }
    .sev--win { background: rgba(74,222,128,0.15); color: #4ade80; }
    .sev--warning { background: rgba(251,146,60,0.15); color: #fb923c; }
    .sev--critical { background: rgba(244,63,94,0.15); color: #fb7185; }
    .insight-impact { margin-left: auto; }
    .insight-title { font-size: 15px; color: var(--text, #f7f7f7); font-weight: 600; }
    .insight-detail { font-size: 13px; color: rgba(247,247,247,0.7); line-height: 1.5; }
    .insight-foot { display: flex; gap: 12px; align-items: center; }
    .insight-metric { font-size: 12px; color: rgba(247,247,247,0.65); }
    .insight-metric b { color: var(--g-primary, #caa45a); }

    /* ── Graph */
    .graph-node { transition: opacity 200ms ease; cursor: pointer; }
    .graph-node:hover { opacity: 0.85; }

    /* ── Wizard */
    .wizard-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.65);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .wizard {
      width: min(720px, 100%);
      max-height: 90vh;
      overflow: auto;
      border-radius: 20px;
      border: 1px solid rgba(255,255,255,0.08);
      background:
        radial-gradient(circle at top left, color-mix(in srgb, var(--g-primary, #caa45a) 15%, transparent) 0%, transparent 60%),
        linear-gradient(135deg, rgba(20,20,20,0.95), rgba(8,8,8,0.95));
      backdrop-filter: blur(28px) saturate(160%);
      -webkit-backdrop-filter: blur(28px) saturate(160%);
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.08),
        0 40px 80px -30px rgba(0,0,0,0.7);
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .wizard-head { display: flex; justify-content: space-between; align-items: center; }
    .wizard-head h2 { margin: 0; font-size: 18px; color: var(--text, #f7f7f7); }
    .wizard-close { background: none; border: none; color: rgba(255,255,255,0.5); font-size: 24px; cursor: pointer; line-height: 1; }
    .wizard-close:hover { color: var(--text, #f7f7f7); }
    .wizard-steps { display: flex; gap: 8px; flex-wrap: wrap; }
    .wizard-step {
      display: flex; gap: 8px; align-items: center;
      font-size: 12px; color: rgba(247,247,247,0.5);
      padding: 5px 10px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.05);
    }
    .wizard-step.is-active {
      color: var(--text, #f7f7f7);
      border-color: color-mix(in srgb, var(--g-primary, #caa45a) 40%, transparent);
      background: color-mix(in srgb, var(--g-primary, #caa45a) 8%, transparent);
    }
    .wizard-step.is-done { color: rgba(247,247,247,0.85); }
    .wizard-step-n {
      width: 20px; height: 20px;
      border-radius: 50%;
      background: rgba(255,255,255,0.06);
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 600;
    }
    .wizard-step.is-active .wizard-step-n { background: var(--g-primary, #caa45a); color: #0a0a0a; }
    .wizard-body { padding: 4px 0; }
    .wizard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .wizard-field { display: flex; flex-direction: column; gap: 6px; }
    .wizard-field--wide { grid-column: 1 / -1; }
    .wizard-field span { font-size: 11px; color: rgba(247,247,247,0.55); text-transform: uppercase; letter-spacing: 0.08em; }
    .wizard-field input, .wizard-field select {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      color: var(--text, #f7f7f7);
      padding: 9px 12px;
      border-radius: 8px;
      font-size: 13px;
    }
    .wizard-field input:focus, .wizard-field select:focus { outline: 1px solid var(--g-primary, #caa45a); }
    .wizard-hint { grid-column: 1 / -1; font-size: 12px; color: rgba(247,247,247,0.5); margin: 0; }
    .wizard-foot { display: flex; justify-content: space-between; }

    /* ─── Feature Modal */
    .fm-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.65);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      z-index: 1100;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .fm-modal {
      width: min(680px, 100%);
      max-height: 90vh;
      overflow: auto;
      border-radius: 20px;
      border: 1px solid rgba(255,255,255,0.08);
      background:
        radial-gradient(circle at top left, color-mix(in srgb, var(--g-primary, #caa45a) 15%, transparent) 0%, transparent 55%),
        linear-gradient(135deg, rgba(20,20,20,0.96), rgba(8,8,8,0.96));
      backdrop-filter: blur(28px) saturate(160%);
      -webkit-backdrop-filter: blur(28px) saturate(160%);
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.08), 0 40px 80px -30px rgba(0,0,0,0.7);
      display: flex;
      flex-direction: column;
      gap: 0;
    }
    .fm-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding: 20px 24px 0;
    }
    .fm-title { font-size: 16px; font-weight: 700; color: var(--text, #f7f7f7); letter-spacing: 0.04em; }
    .fm-subtitle { font-size: 12px; color: rgba(247,247,247,0.55); margin-top: 4px; }
    .fm-integration-notice {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 12px 24px 0;
      padding: 8px 12px;
      background: rgba(202,164,90,0.08);
      border: 1px solid rgba(202,164,90,0.25);
      border-radius: 8px;
      font-size: 12px;
      color: rgba(202,164,90,0.9);
    }
    .fm-body { padding: 16px 24px; display: flex; flex-direction: column; gap: 16px; }
    .fm-section {
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 12px;
      overflow: hidden;
    }
    .fm-section-title {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: rgba(247,247,247,0.55);
      padding: 10px 14px;
      background: rgba(255,255,255,0.02);
      border-bottom: 1px solid rgba(255,255,255,0.05);
      font-family: var(--font-mono, monospace);
    }
    .fm-section-fields { display: flex; flex-direction: column; gap: 12px; padding: 14px; }
    .fm-field { display: flex; flex-direction: column; gap: 5px; }
    .fm-field--checkbox { flex-direction: column; gap: 4px; }
    .fm-mono { font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; color: rgba(247,247,247,0.65); font-family: var(--font-mono, monospace); }
    .fm-required { color: #fb7185; margin-left: 2px; }
    .fm-hint { font-size: 11px; color: rgba(247,247,247,0.4); }
    .fm-input, .fm-select, .fm-textarea {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      color: var(--text, #f7f7f7);
      padding: 8px 11px;
      border-radius: 7px;
      font-size: 13px;
      font-family: inherit;
    }
    .fm-input:focus, .fm-select:focus, .fm-textarea:focus { outline: 1px solid var(--g-primary, #caa45a); }
    .fm-textarea { min-height: 80px; resize: vertical; }
    .fm-checkbox-label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
    .fm-checkbox-input { display: none; }
    .fm-checkbox-box {
      width: 16px; height: 16px;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 4px;
      background: rgba(255,255,255,0.04);
      position: relative;
      flex-shrink: 0;
    }
    .fm-checkbox-input:checked ~ .fm-checkbox-box {
      background: var(--g-primary, #caa45a);
      border-color: var(--g-primary, #caa45a);
    }
    .fm-checkbox-input:checked ~ .fm-checkbox-box::after {
      content: '';
      position: absolute;
      left: 4px; top: 2px;
      width: 5px; height: 8px;
      border: 2px solid #0a0a0a;
      border-top: none; border-left: none;
      transform: rotate(45deg);
    }
    .fm-footer {
      display: flex;
      justify-content: space-between;
      padding: 16px 24px 20px;
      border-top: 1px solid rgba(255,255,255,0.06);
    }
    .fm-error {
      margin: 0 24px;
      padding: 8px 12px;
      background: rgba(244,63,94,0.12);
      border: 1px solid rgba(244,63,94,0.4);
      border-radius: 8px;
      font-size: 12px;
      color: #fca5a5;
    }

    /* ─── Integrations tab */
    .integrations { display: flex; flex-direction: column; gap: 16px; }
    .intg-connections { display: flex; flex-direction: column; gap: 12px; }
    .intg-conn-row {
      display: grid;
      grid-template-columns: 32px 1fr auto auto;
      gap: 12px;
      align-items: start;
      padding: 12px;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 10px;
      background: rgba(255,255,255,0.02);
    }
    .intg-conn-icon { color: var(--g-primary, #caa45a); display: flex; align-items: center; padding-top: 2px; }
    .intg-conn-info { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .intg-conn-name { font-size: 13px; font-weight: 600; color: var(--text, #f7f7f7); }
    .intg-conn-desc { font-size: 11px; color: rgba(247,247,247,0.5); }
    .intg-conn-meta { font-size: 10px; color: rgba(247,247,247,0.35); }
    .intg-conn-warn { font-size: 10px; color: #fb923c; margin-top: 2px; }
    .intg-conn-status { display: flex; align-items: center; }
    .intg-conn-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .intg-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: inline-block; margin-right: 6px; }
    .intg-badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      color: rgba(247,247,247,0.65);
      white-space: nowrap;
    }
    .intg-badge--connected { background: rgba(74,222,128,0.12); border-color: rgba(74,222,128,0.35); color: #4ade80; }
    .intg-badge--disconnected { background: rgba(244,63,94,0.08); border-color: rgba(244,63,94,0.25); color: rgba(247,247,247,0.55); }
    .intg-badge--partial { background: rgba(251,146,60,0.1); border-color: rgba(251,146,60,0.3); color: #fb923c; }
    .btn-ghost--danger { color: rgba(244,63,94,0.8); border-color: rgba(244,63,94,0.2); }
    .btn-ghost--danger:hover { border-color: rgba(244,63,94,0.5); background: rgba(244,63,94,0.07); }
    /* ─── IG live chip */
    .ig-live-chip {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 11px; padding: 1px 7px; border-radius: 20px;
      border: 1px solid; max-height: 20px; vertical-align: middle; margin-left: 6px;
    }
    .ig-live-chip--ok { background: color-mix(in srgb, var(--g-primary, #4ade80) 10%, transparent); border-color: color-mix(in srgb, var(--g-primary, #4ade80) 35%, transparent); color: var(--g-primary, #4ade80); }
    .ig-live-chip--warn { background: rgba(251,146,60,0.1); border-color: rgba(251,146,60,0.3); color: #fb923c; }
    .ig-live-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
    .kpi-row-head { min-height: 0; display: flex; align-items: center; margin-bottom: -4px; }
    /* ─── IG top media */
    .ig-top-media { display: flex; gap: 10px; flex-wrap: wrap; }
    .ig-media-card { display: flex; flex-direction: column; gap: 6px; text-decoration: none; color: inherit; border: 1px solid rgba(247,247,247,0.08); border-radius: 8px; overflow: hidden; width: 120px; flex-shrink: 0; }
    .ig-media-card:hover { border-color: rgba(247,247,247,0.2); }
    .ig-media-thumb { width: 120px; height: 120px; object-fit: cover; display: block; }
    .ig-media-thumb--placeholder { background: rgba(247,247,247,0.06); }
    .ig-media-stats { display: flex; flex-direction: column; gap: 2px; font-size: 11px; padding: 4px 6px 6px; color: rgba(247,247,247,0.6); }
    .btn-primary--sm { font-size: 11px; padding: 4px 12px; }
    .btn-link { background: none; border: none; color: #fb923c; cursor: pointer; text-decoration: underline; font-size: 10px; padding: 0; }
    /* IG analytics banner */
    .ig-analytics-empty {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 16px;
      border: 1px dashed rgba(255,255,255,0.1);
      border-radius: 12px;
      background: rgba(255,255,255,0.02);
      margin-bottom: 4px;
      flex-wrap: wrap;
    }
    .ig-analytics-empty-icon { opacity: 0.4; flex-shrink: 0; }
    .ig-analytics-empty-text { flex: 1; font-size: 12px; color: rgba(247,247,247,0.6); line-height: 1.6; }
    .ig-analytics-connected {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    /* IG Setup Modal */
    .fm-modal--ig { max-width: 560px; }
    .ig-steps {
      display: flex;
      align-items: center;
      gap: 0;
      margin-bottom: 20px;
    }
    .ig-step {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }
    .ig-step-dot {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 2px solid rgba(255,255,255,0.15);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      color: rgba(247,247,247,0.4);
      background: rgba(255,255,255,0.04);
      transition: all 200ms ease;
    }
    .ig-step--active .ig-step-dot { border-color: var(--g-primary, #caa45a); color: var(--g-primary, #caa45a); background: rgba(202,164,90,0.1); }
    .ig-step--done .ig-step-dot { border-color: #4ade80; color: #4ade80; background: rgba(74,222,128,0.08); }
    .ig-step-label { font-size: 10px; color: rgba(247,247,247,0.4); white-space: nowrap; }
    .ig-step--active .ig-step-label { color: var(--g-primary, #caa45a); }
    .ig-step--done .ig-step-label { color: #4ade80; }
    .ig-step-line { flex: 1; height: 2px; background: rgba(255,255,255,0.08); min-width: 32px; }
    .ig-step-line--done { background: #4ade80; }
    .ig-callout {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 10px;
      padding: 14px;
      margin-bottom: 16px;
      font-size: 12px;
      color: rgba(247,247,247,0.7);
      line-height: 1.7;
    }
    .ig-callout--success { border-color: rgba(74,222,128,0.2); background: rgba(74,222,128,0.04); color: rgba(74,222,128,0.9); }
    .ig-callout strong { color: var(--text, #f7f7f7); }
    .ig-steps-list { margin: 8px 0 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 5px; }
    .ig-link { color: var(--g-primary, #caa45a); text-decoration: underline; }
    .ig-link:hover { opacity: 0.8; }
    .ig-help { margin-top: 10px; cursor: pointer; }
    .ig-help summary { font-size: 11px; color: rgba(247,247,247,0.45); cursor: pointer; }
    .ig-help p { margin: 8px 0 0; font-size: 11px; color: rgba(247,247,247,0.55); }
    .ig-error { margin-top: 10px; padding: 10px 14px; border-radius: 8px; background: rgba(244,63,94,0.08); border: 1px solid rgba(244,63,94,0.25); color: #f87171; font-size: 12px; line-height: 1.5; }
    .ig-account-preview {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      padding: 16px;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      background: rgba(255,255,255,0.03);
      margin-bottom: 16px;
    }
    .ig-avatar { width: 52px; height: 52px; border-radius: 50%; object-fit: cover; border: 2px solid rgba(255,255,255,0.1); flex-shrink: 0; }
    .ig-account-info { display: flex; flex-direction: column; gap: 5px; }
    .ig-account-handle { font-size: 15px; font-weight: 700; color: var(--text, #f7f7f7); }
    .ig-account-stats { display: flex; gap: 16px; font-size: 12px; color: rgba(247,247,247,0.6); }
    .ig-account-stats strong { color: var(--text, #f7f7f7); }
    .ig-account-bio { font-size: 11px; color: rgba(247,247,247,0.45); line-height: 1.5; max-width: 340px; }
    .ig-success-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 16px;
      padding: 28px 20px;
      text-align: center;
    }
    .ig-success-icon { width: 52px; height: 52px; border-radius: 50%; background: rgba(74,222,128,0.12); border: 2px solid rgba(74,222,128,0.3); display: flex; align-items: center; justify-content: center; font-size: 22px; color: #4ade80; }
    .ig-success-text { font-size: 14px; color: var(--text, #f7f7f7); line-height: 1.6; }
    .ig-success-expiry { font-size: 11px; color: rgba(247,247,247,0.5); margin-top: 4px; }
    .ig-success-hint { font-size: 12px; color: rgba(247,247,247,0.5); line-height: 1.7; }
    .intg-req-badge {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      background: rgba(202,164,90,0.08);
      color: rgba(202,164,90,0.7);
      border: 1px solid rgba(202,164,90,0.2);
      margin-right: 6px;
    }
    .feature-tiles { display: flex; flex-direction: column; gap: 10px; }
    .feature-tile {
      padding: 14px;
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 12px;
      background: rgba(255,255,255,0.02);
      display: flex;
      align-items: center;
      gap: 12px;
      transition: border-color 160ms ease;
    }
    .feature-tile--active { border-color: rgba(74,222,128,0.3); background: rgba(74,222,128,0.03); }
    .feature-tile-head { flex: 1; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
    .feature-tile-meta { display: flex; flex-direction: column; gap: 3px; }
    .feature-tile-name { font-size: 13px; font-weight: 600; color: var(--text, #f7f7f7); text-transform: uppercase; letter-spacing: 0.04em; font-family: var(--font-mono, monospace); }
    .feature-tile-desc { font-size: 12px; color: rgba(247,247,247,0.5); }
    .feature-tile-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }

    /* ─── Wizard OAuth block */
    .intg-oauth-block { display: flex; flex-direction: column; gap: 8px; padding: 14px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.06); border-radius: 10px; }
    .intg-oauth-row { display: flex; align-items: center; gap: 10px; }

    /* ─── Per-card freshness pill (IG-connected pages) */
    .freshness-row { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
    .freshness-pill { font-size: 10px; line-height: 1; padding: 4px 8px; border-radius: 999px; font-family: var(--font-mono, monospace); letter-spacing: 0.04em; text-transform: uppercase; border: 1px solid transparent; }
    .freshness-pill--live { color: #74e8a3; background: rgba(116,232,163,0.08); border-color: rgba(116,232,163,0.25); }
    .freshness-pill--cached { color: #f3c969; background: rgba(243,201,105,0.08); border-color: rgba(243,201,105,0.25); }
    .freshness-pill--stale { color: #ff8a8a; background: rgba(255,138,138,0.08); border-color: rgba(255,138,138,0.3); }
    .freshness-refresh { background: transparent; border: 1px solid rgba(255,255,255,0.18); color: rgba(247,247,247,0.7); width: 22px; height: 22px; border-radius: 50%; font-size: 13px; cursor: pointer; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
    .freshness-refresh:hover:not([disabled]) { color: var(--text, #f7f7f7); border-color: rgba(255,255,255,0.35); }
    .freshness-refresh[disabled] { opacity: 0.5; cursor: progress; }
    ${communicationGlassShadowStyles}

    /* Shared premium-glass finishing layer. The component keeps its existing
       selectors and handlers; these late overrides make every sub-view follow
       the shell's dark/light, reduced-transparency and spacing contracts. */
    :host {
      color: var(--comms-fg);
      font-family: var(--glass-font, var(--font-ui, Inter, "SF Pro Display", -apple-system, sans-serif));
    }
    .hub { color: var(--comms-fg); }
    .hub-header, .linked-strip, .detail-tabs {
      border-color: var(--comms-line) !important;
    }
    .card, .kpi, .panel, .child-panel, .video-card, .series-card,
    .episode-card, .stage-col, .stage-card, .kanban-col, .kanban-card,
    .insight, .intg-conn-row, .feature-tile, .ig-media-card,
    .ig-analytics-empty, .ig-account-preview, .ig-callout, .fm-section {
      background: var(--glass-sheen), var(--comms-card) !important;
      border-color: var(--comms-line) !important;
      color: var(--comms-fg);
      box-shadow: var(--glass-elev-1);
    }
    .card, .kpi, .panel, .child-panel, .video-card, .series-card,
    .stage-col, .kanban-col, .insight {
      border-radius: var(--glass-radius, 14px) !important;
    }
    .episode-card, .stage-card, .kanban-card, .intg-conn-row, .feature-tile,
    .ig-media-card, .ig-account-preview, .ig-callout, .fm-section {
      border-radius: var(--glass-radius-sm, 10px) !important;
    }
    .card, .series-card, .stage-card, .kanban-card, .feature-tile, .ig-media-card {
      transition: transform var(--glass-dur, 180ms) var(--glass-spring, cubic-bezier(.2,.8,.2,1)),
        border-color var(--glass-dur-fast, 120ms), box-shadow var(--glass-dur, 180ms);
    }
    .card:hover, .series-card:hover, .stage-card:hover, .kanban-card:hover,
    .feature-tile:hover, .ig-media-card:hover {
      transform: var(--glass-lift, translateY(-2px));
      border-color: var(--comms-line-strong) !important;
      box-shadow: var(--glass-elev-3), var(--glass-glow-soft) !important;
    }
    .hub-search, .hub-select, .fm-input, .fm-select, .fm-textarea,
    .wizard-field input, .wizard-field select {
      background: color-mix(in srgb, var(--glass-base, #090806) 62%, transparent) !important;
      border-color: var(--comms-line) !important;
      border-radius: var(--glass-radius-sm, 10px) !important;
      color: var(--comms-fg) !important;
    }
    .btn-primary, .btn-ghost, .btn-advance, .freshness-refresh, .wizard-close,
    .row-del, .linked-open, .linked-x, .detail-tab, .btn-link {
      align-items: center;
      border-radius: var(--glass-radius-sm, 10px) !important;
      display: inline-flex;
      gap: 6px;
      justify-content: center;
    }
    .btn-ghost, .btn-advance, .freshness-refresh, .wizard-close, .row-del,
    .linked-open, .linked-x, .detail-tab {
      background: var(--glass-sheen), var(--glass-hover) !important;
      border: 1px solid var(--comms-line) !important;
      color: var(--comms-fg) !important;
    }
    .btn-primary {
      background: var(--glass-gold-fill) !important;
      border: 1px solid transparent !important;
      color: var(--glass-ink, #160f03) !important;
      box-shadow: var(--glass-elev-1), var(--glass-glow-soft) !important;
    }
    .detail-tab.is-active {
      background: var(--glass-gold-tint) !important;
      border-color: var(--comms-line-strong) !important;
      color: var(--comms-gold-hi) !important;
    }
    .hub-crumbs, .crumb-current, .card-name, .card-row--top, .stat-val,
    .panel-head, .child-head h3, .video-title, .series-name, .ep-title,
    .stage-card-title, .insight-title, .intg-conn-name, .feature-tile-name,
    .fm-title, .ig-account-handle, .ig-success-text {
      color: var(--comms-fg) !important;
    }
    .crumb-sep, .card-sub, .surface-name, .stat-lbl, .card-foot, .kpi-lbl,
    .panel-head, .ring-lbl, .muted, .child-table th, .child-table td,
    .video-row, .linked-label, .linked-surface, .series-meta, .season-head,
    .ep-line, .ep-line b, .stage-card-sub, .kanban-col-head, .funnel-label,
    .insight-head, .insight-detail, .insight-metric, .fm-subtitle, .fm-hint,
    .fm-mono, .intg-conn-desc, .intg-conn-meta, .ig-media-stats,
    .ig-analytics-empty-text, .ig-step-label, .ig-callout, .ig-account-stats,
    .ig-account-bio, .ig-success-expiry, .ig-success-hint, .feature-tile-desc {
      color: var(--comms-fg-2) !important;
    }
    .stat-val, .kpi-val, .conn-count, .funnel-val, .kanban-count {
      font-variant-numeric: tabular-nums;
      letter-spacing: -.025em;
    }
    .intg-conn-warn { display: inline-flex; align-items: center; gap: 5px; }
    .wizard, .fm-modal {
      background: var(--glass-sheen), var(--comms-float) !important;
      border-color: var(--comms-line-strong) !important;
      color: var(--comms-fg);
    }
    .wizard-overlay, .fm-overlay {
      background: color-mix(in srgb, var(--glass-base, #090806) 68%, transparent);
    }

    @media (max-width: 520px) {
      .hub { gap: 12px; padding: 8px 8px 36px !important; }
      .hub-header { align-items: stretch !important; }
      .hub-controls { align-items: stretch; display: grid; grid-template-columns: minmax(0, 1fr); width: 100%; }
      .hub-search, .hub-select, .hub-controls .btn-primary { min-width: 0; width: 100%; min-height: 42px; }
      .grid { grid-template-columns: minmax(0, 1fr) !important; gap: 12px; }
      .card { padding: 14px; }
      .detail-tabs { flex-wrap: nowrap; overflow-x: auto; padding: 4px; scrollbar-width: none; }
      .detail-tab { flex: 0 0 auto; min-height: 42px; }
      .linked-strip { align-items: stretch; flex-direction: column; }
      .linked-chip, .linked-add { max-width: 100%; width: 100%; }
      .linked-open { flex: 1; justify-content: flex-start; min-width: 0; }
      .overview-row, .kpi-row { grid-template-columns: minmax(0, 1fr) !important; }
      .child-panel { overflow-x: auto; }
      .child-table { min-width: 620px; }
      .wizard-grid { grid-template-columns: minmax(0, 1fr); }
      .wizard-field--wide { grid-column: auto; }
      .wizard, .fm-modal { max-height: calc(100dvh - 16px); padding: 16px; width: calc(100vw - 16px); }
      .fm-modal { padding: 0; }
      .fm-header { padding: 16px 16px 0; }
      .fm-body { padding-inline: 16px; }
      .fm-footer { padding-inline: 16px; }
      .intg-conn-row { grid-template-columns: 28px minmax(0, 1fr); }
      .intg-conn-status, .intg-conn-actions { grid-column: 1 / -1; justify-content: flex-start; }
      .feature-tile, .feature-tile-head { align-items: flex-start; flex-direction: column; }
      .feature-tile-right { width: 100%; }
      .ig-account-preview { flex-direction: column; }
    }
    @media (prefers-reduced-transparency: reduce) {
      .card, .kpi, .panel, .child-panel, .video-card, .series-card,
      .episode-card, .stage-col, .stage-card, .kanban-col, .kanban-card,
      .insight, .intg-conn-row, .feature-tile, .ig-media-card,
      .ig-analytics-empty, .ig-account-preview, .ig-callout, .fm-section {
        background: var(--glass-solid) !important;
      }
    }
  `;
}

// ─── Helpers used in render but not bound to the element ────────────────────

function pickProp(row: DBRow, props: DBProperty[], name: string): unknown {
  const prop = props.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!prop) return null;
  const v = row.values[prop.id];
  if (!v || typeof v !== "object") return null;
  const obj = v as Record<string, unknown>;
  if (obj.type === "url") return obj.url;
  if (obj.type === "number") return obj.value;
  if (obj.type === "title") return obj.text;
  if (obj.type === "richText") return obj.markdown;
  if (obj.type === "select" || obj.type === "status") {
    const optId = obj.optionId as string | undefined;
    return optId ? prop.config?.options?.find((o) => o.id === optId)?.name ?? optId : null;
  }
  return null;
}

function getValueNumber(v: unknown): number {
  if (!v || typeof v !== "object") return 0;
  const obj = v as Record<string, unknown>;
  if (obj.type === "number" && typeof obj.value === "number") return obj.value;
  return 0;
}

function renderCell(v: unknown): TemplateResult | string {
  if (v === undefined || v === null) return "—";
  if (typeof v !== "object") return String(v);
  const obj = v as Record<string, unknown>;
  switch (obj.type) {
    case "title":
      return String(obj.text ?? "—");
    case "richText": {
      const md = String(obj.markdown ?? "");
      return md.length > 80 ? `${md.slice(0, 80)}…` : md || "—";
    }
    case "number":
      return obj.value !== null && obj.value !== undefined ? String(obj.value) : "—";
    case "url":
      return obj.url ? html`<a href=${String(obj.url)} target="_blank" rel="noopener noreferrer">${String(obj.url)}</a>` : "—";
    case "date":
      return obj.iso ? new Date(String(obj.iso)).toLocaleDateString() : "—";
    case "checkbox":
      return obj.checked ? "✓" : "—";
    case "select":
    case "status":
      return obj.optionId ? String(obj.optionId) : "—";
    case "relation": {
      const ids = obj.rowIds as string[] | undefined;
      return ids?.length ? `${ids.length} link${ids.length === 1 ? "" : "s"}` : "—";
    }
    default:
      return "—";
  }
}

function svgEmpty(): TemplateResult {
  return html`<text x="50%" y="50%" text-anchor="middle" fill="var(--glass-fg-3, rgba(247,247,247,0.3))" font-size="11">No data yet</text>`;
}

function nodeKindFill(kind: ConnectionNode["kind"]): string {
  switch (kind) {
    case "page":
      return "var(--g-primary, #caa45a)";
    case "campaign":
      return "#60a5fa";
    case "product":
      return "#a78bfa";
    case "funnel":
      return "#34d399";
    case "lead":
      return "#fb923c";
    case "business":
      return "#f472b6";
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "content-pages-hub": ContentPagesHub;
  }
}

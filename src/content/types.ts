/**
 * Content Pages Hub — types.
 *
 * A ContentPage is a single content surface (an IG account, a YouTube
 * channel, a blog) owned by a business and produced by an agent. Each
 * page owns five child databases (Scripts, Videos, Content, Ideas, Series)
 * that are created via the generic databases store and referenced by id.
 * Pages can be associated with sibling pages (an IG account and the YouTube
 * channel of the same brand) through `links.pageIds`, kept symmetric.
 */

export type ContentSurface =
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

export type ContentPageStatus = "draft" | "active" | "paused" | "archived";

export type ContentChildKind = "scripts" | "videos" | "content" | "ideas" | "series";

export const CONTENT_CHILD_KINDS: ContentChildKind[] = [
  "scripts",
  "videos",
  "content",
  "ideas",
  "series",
];

/**
 * Idea → post pipeline shared by series episodes and ideas. `shelved` sits
 * outside the forward order: advancing never lands on it, only an explicit
 * stage does.
 */
export type ContentStage =
  | "idea"
  | "outlined"
  | "scripted"
  | "filming"
  | "editing"
  | "scheduled"
  | "posted"
  | "shelved";

export const CONTENT_STAGE_ORDER: ContentStage[] = [
  "idea",
  "outlined",
  "scripted",
  "filming",
  "editing",
  "scheduled",
  "posted",
];

export const CONTENT_STAGES: Array<{ id: ContentStage; name: string; color: string }> = [
  { id: "idea", name: "Idea", color: "#6b7280" },
  { id: "outlined", name: "Outlined", color: "#64748b" },
  { id: "scripted", name: "Scripted", color: "#3b82f6" },
  { id: "filming", name: "Filming", color: "#a855f7" },
  { id: "editing", name: "Editing", color: "#ec4899" },
  { id: "scheduled", name: "Scheduled", color: "#f59e0b" },
  { id: "posted", name: "Posted", color: "#10b981" },
  { id: "shelved", name: "Shelved", color: "#94a3b8" },
];

export function isContentStage(v: unknown): v is ContentStage {
  return typeof v === "string" && CONTENT_STAGES.some((s) => s.id === v);
}

export interface ContentPageTheme {
  voice?: string;
  tone?: string;
  palette?: string;
}

export interface ContentPageGoals {
  followersTarget?: number;
  monthlyPostsTarget?: number;
  engagementRateTarget?: number;
}

export interface ContentPageLinks {
  campaignIds: string[];
  productIds: string[];
  funnelIds: string[];
  leadDbId?: string;
  /** Associated sibling content pages (symmetric: each side lists the other). */
  pageIds: string[];
  /**
   * Content Intelligence account (reels.account) for an Instagram page.
   * Unset = derived from the handle ("@iam.yungceo" → "iam.yungceo").
   */
  intelAccount?: string;
  /**
   * Content Intelligence YouTube channel (youtube_channels.channel_id) for a
   * YouTube page. Unset = matched by handle once the channel is imported.
   */
  youtubeChannelId?: string;
}

export interface ContentPageDatabaseIds {
  scripts: string;
  videos: string;
  content: string;
  ideas: string;
  /** Series episodes. Empty on pages created before series existed until first use. */
  series: string;
}

export interface ContentPageStats {
  followers?: number;
  totalPosts: number;
  monthlyPosts: number;
  engagementRate: number;
  reach30d: number;
  impressions30d: number;
  clicks30d: number;
  conversions30d: number;
  leadsAttributed: number;
  /** Last 30 daily reach samples (oldest → newest) for sparkline display. */
  reachSparkline: number[];
  lastPublishedAt?: number | null;
}

export interface ContentPageIntegrations {
  instagramGraph?: {
    connected: boolean;
    igPageId?: string; // Instagram Business Account ID
    accessTokenRef?: string; // vault reference, not raw token
    accountName?: string;
    profilePictureUrl?: string;
    lastSyncAt?: number;
  };
  manychat?: {
    connected: boolean;
    apiKeyRef?: string; // vault reference
    defaultFlowId?: string;
    subscriberCount?: number;
    lastSyncAt?: number;
  };
}

export interface ContentPage {
  id: string;
  name: string;
  surface: ContentSurface;
  handle?: string;
  url?: string;
  businessId: string;
  ownerAgentId?: string;
  status: ContentPageStatus;
  theme?: ContentPageTheme;
  goals?: ContentPageGoals;
  links: ContentPageLinks;
  databaseIds: ContentPageDatabaseIds;
  stats: ContentPageStats;
  integrations: ContentPageIntegrations;
  features: Record<string, Record<string, unknown>>;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number | null;
}

export interface ContentPageInput {
  id?: string;
  name: string;
  surface: ContentSurface;
  handle?: string;
  url?: string;
  businessId: string;
  ownerAgentId?: string;
  status?: ContentPageStatus;
  theme?: ContentPageTheme;
  goals?: ContentPageGoals;
  links?: Partial<ContentPageLinks>;
}

export interface ContentPagePatch {
  name?: string;
  surface?: ContentSurface;
  handle?: string;
  url?: string;
  ownerAgentId?: string;
  status?: ContentPageStatus;
  theme?: ContentPageTheme;
  goals?: ContentPageGoals;
  links?: Partial<ContentPageLinks>;
  integrations?: ContentPageIntegrations;
  features?: Record<string, Record<string, unknown>>;
}

export interface ContentPageListFilter {
  businessId?: string;
  surface?: ContentSurface;
  status?: ContentPageStatus;
  includeArchived?: boolean;
}

// ─── Insights / connections graph types ───────────────────────────

export type PageInsightCategory =
  | "performance"
  | "production"
  | "ideation"
  | "attribution"
  | "cadence";

export type PageInsightSeverity = "info" | "win" | "warning" | "critical";

export interface PageInsightAction {
  label: string;
  /** Optional UI hint — `view:<tab>` or `rpc:<method>` etc. The UI interprets it. */
  intent?: string;
}

export interface PageInsight {
  id: string;
  category: PageInsightCategory;
  severity: PageInsightSeverity;
  title: string;
  detail: string;
  /** 0–100 — higher is more important. Used to rank the list. */
  impact: number;
  action?: PageInsightAction;
  metric?: { label: string; value: string };
}

export type ConnectionNodeKind = "page" | "campaign" | "product" | "funnel" | "lead" | "business";

export interface ConnectionNode {
  id: string;
  kind: ConnectionNodeKind;
  label: string;
  /** Optional sub-label (handle, count, etc.). */
  sub?: string;
  /** Soft "size" hint (e.g. row count) — used to scale the node visually. */
  weight?: number;
}

export interface ConnectionEdge {
  from: string;
  to: string;
  /** Strength 0–1; the UI maps this to opacity / stroke width. */
  strength: number;
  /** Optional label (e.g. "12 leads", "primary"). */
  label?: string;
}

export interface ConnectionsGraph {
  nodes: ConnectionNode[];
  edges: ConnectionEdge[];
}

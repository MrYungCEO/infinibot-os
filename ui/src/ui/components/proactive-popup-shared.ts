/**
 * Proactive Pop-Up System — shared UI types + helpers.
 *
 * Mirrors the backend src/proactive/popup-types.ts shape. Kept UI-local (the
 * control-ui builds independently of the gateway src tree) but intentionally
 * structurally identical so the gateway payloads deserialize 1:1.
 */

import type { AgentRunReview } from "./agent-run-review.js";

export type PopupTier = "CRITICAL" | "NOTABLE" | "FYI" | "AMBIENT";
export type PopupState = "pending" | "acted" | "snoozed" | "dismissed";

export interface PopupAttribution {
  agentId: string;
  agentName?: string;
  cardId?: string;
  goalId?: string;
  verifierEvidenceRef?: string;
}

export type PopupActionKind =
  | "complete"
  | "spawn"
  | "snooze"
  | "dismiss"
  | "open"
  | "reply"
  | "readmore"
  | "build"
  | "commitpush";

export interface PopupAction {
  id: string;
  kind: PopupActionKind;
  label: string;
  primary?: boolean;
  payload?: Record<string, unknown>;
}

// ── Rich media payloads (Overlay System) — mirrors src/proactive/popup-types ──
export type PopupMediaKind =
  | "agent-summary"
  // Full in-depth agent-run review (rendered by the shared agent-run-review
  // component — the same one the Reviews page + activity modal use).
  | "agent-review"
  | "note"
  | "workflow"
  | "activity"
  | "custom"
  | "stylized-markdown"
  | "pdf"
  | "html"
  | "image"
  | "video"
  | "card-deck"
  | "walkthrough"
  | "infinite-canvas-walkthrough"
  // ── Canvas-converted report / stylized-walkthrough payloads ─────────────
  | "report-walkthrough"
  | "stylized-walkthrough"
  // ── Actionable overlay: interactive project kanban (drift alerts) ────────
  | "project-kanban";

export interface PopupMediaThumb {
  url: string;
  type: "image" | "video";
  alt?: string;
  poster?: string;
}
export interface PopupDiffStat {
  filesChanged: number;
  additions: number;
  deletions: number;
}
export interface ChangeStatusContext {
  workdir?: string;
  paths?: string[];
  branch?: string;
}
export interface AgentSummaryMedia {
  agentName: string;
  project?: string;
  cardId?: string;
  summaryMarkdown: string;
  diff?: PopupDiffStat;
  thumbnails?: PopupMediaThumb[];
  href?: string;
  /** Whether the change has been compiled/built into the UI dist yet. */
  buildStatus?: "built" | "unbuilt";
  /** Whether the change is committed in git. */
  commitStatus?: "committed" | "uncommitted";
  /** Whether the (committed) change is pushed to its upstream. */
  pushed?: boolean;
  /** Target context so the Build / Commit & Push buttons act on the right tree. */
  statusContext?: ChangeStatusContext;
}
export interface NoteMedia {
  noteId?: string;
  title: string;
  bodyMarkdown: string;
}
export interface WorkflowStep {
  label: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
}
export interface WorkflowMedia {
  name: string;
  status: "queued" | "running" | "done" | "failed";
  steps: WorkflowStep[];
  runId?: string;
}
export interface ActivityMedia {
  icon?: string;
  line: string;
  detail?: string;
}
export interface CustomMedia {
  bodyMarkdown?: string;
  html?: string;
  imageUrl?: string;
  videoUrl?: string;
}
export interface ImageMedia {
  url: string;
  alt?: string;
  caption?: string;
  width?: number;
  height?: number;
}
export interface VideoMedia {
  url: string;
  poster?: string;
  caption?: string;
  durationMs?: number;
}
export interface PdfMedia {
  title?: string;
  url?: string;
  reportId?: string;
  filePath?: string;
  bytes?: number;
  pageCount?: number;
}
export interface HtmlMedia {
  html: string;
  title?: string;
}
export interface StylizedMarkdownMedia {
  markdown: string;
  title?: string;
  sequential?: boolean;
  autoAdvanceMs?: number;
  wordsPerSecond?: number;
}
export interface DeckCard {
  title?: string;
  bodyMarkdown?: string;
  imageUrl?: string;
  videoUrl?: string;
  accent?: string;
}
export interface CardDeckMedia {
  cards: DeckCard[];
  loop?: boolean;
}
export type WalkthroughSceneKind = "markdown" | "diagram" | "image" | "code" | "choice";
export interface WalkthroughChoice {
  value: string;
  label: string;
  detail?: string;
}
export interface WalkthroughCodeContent {
  language?: string;
  code: string;
  caption?: string;
}
export interface WalkthroughImageContent {
  url: string;
  alt?: string;
  caption?: string;
}
export interface WalkthroughChoiceContent {
  prompt?: string;
  choices: WalkthroughChoice[];
}
export interface WalkthroughScene {
  kind: WalkthroughSceneKind;
  content:
    | string
    | WalkthroughCodeContent
    | WalkthroughImageContent
    | WalkthroughChoiceContent;
  narration: string;
  revealMs?: number;
  holdMs?: number;
}
export interface WalkthroughMedia {
  scenes: WalkthroughScene[];
  title?: string;
  voice?: { engine?: "kokoro" | "cloud"; voiceId?: string };
  autoAdvance?: boolean;
}
// ── Infinite-canvas walkthrough (mirrors src/proactive/popup-types.ts) ───────
export type CanvasNodeKind =
  | "callout"
  | "text"
  | "title"
  | "stats"
  | "diagram"
  | "image"
  | "code"
  | "quote"
  | "chart"
  | "reveal-list"
  | "timeline"
  | "comparison"
  | "pricing"
  | "cta"
  | "live-doc";

// chart sub-kinds
export type ChartKind = "bar" | "line" | "donut" | "sparkline" | "metric-bars";
export interface ChartSeries {
  label: string;
  value: number;
  color?: string;
}

// comparison item
export interface ComparisonItem {
  text: string;
  positive?: boolean;
}

// reveal-list item
export interface RevealListItem {
  md: string;
  atMs?: number;
}
export interface CanvasStat {
  n: string;
  l: string;
}
export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  x: number;
  y: number;
  w: number;
  cl?: string;
  kicker?: string;
  part?: string;
  icon?: string;
  brand?: string;
  h1?: string;
  h2?: string;
  sub?: string;
  title?: string;
  body?: string;
  stats?: CanvasStat[];
  imageUrl?: string;
  alt?: string;
  code?: string;
  language?: string;

  // chart node fields
  chartKind?: ChartKind;
  series?: ChartSeries[];
  unit?: string;

  // reveal-list node fields
  items?: RevealListItem[];
  pacing?: "auto" | "manual";

  // timeline node fields
  events?: Array<{ at: string; label: string; kicker?: string }>;

  // comparison node fields
  left?: { title: string; items: ComparisonItem[] };
  right?: { title: string; items: ComparisonItem[] };

  // pricing / cta node fields
  price?: string;
  pricePer?: string;
  priceFeatures?: string[];
  ctaLabel?: string;
  ctaHref?: string;
  badge?: string;

  // live-doc node fields
  liveDocKind?: "note" | "project" | "workflow";
  liveDocId?: string;
  /** When true (default when scene focuses this node), voice commands route to this doc */
  liveDocActive?: boolean;
}
export type CanvasLink = [string, string] | { from: string; to: string };
export interface CanvasBeat {
  atMs: number;
  op: "highlight" | "reveal" | "pan" | "zoom" | "animate";
  target?: string;
  params?: Record<string, unknown>;
}
export interface CanvasNarration {
  audioUrl?: string;
  ttsText?: string;
  voice?: string;
  captionMd?: string;
}
export interface CanvasScene {
  id: string;
  focusNodeId?: string;
  cameraTarget?: { x: number; y: number; zoom?: number };
  durationMs?: number;
  narration?: CanvasNarration;
  beats?: CanvasBeat[];
}
export type CanvasBgLayer = "radial" | "grid" | "stars" | "vignette";
export interface InfiniteCanvasWalkthroughMedia {
  title?: string;
  world?: { w: number; h: number };
  nodes: CanvasNode[];
  links?: CanvasLink[];
  scenes: CanvasScene[];
  theme?: { gold?: string; gold2?: string; void0?: string };
  bgLayers?: CanvasBgLayer[];
  autoAdvance?: boolean;
  voiceSuppress?: boolean;
  /** Optional voice override for all scene narrations. When set, overrides per-scene
   *  narration.voice AND the active-voice resolver. For advanced callers. */
  voice?: string;
}

/** Interactive project-kanban card payload (mirrors src/proactive/popup-types). */
export interface ProjectKanbanMedia {
  projectId: string;
  projectName?: string;
  title?: string;
  subtitle?: string;
}

export type PopupMedia =
  | { kind: "agent-summary"; payload: AgentSummaryMedia }
  | { kind: "agent-review"; payload: AgentRunReview }
  | { kind: "note"; payload: NoteMedia }
  | { kind: "workflow"; payload: WorkflowMedia }
  | { kind: "activity"; payload: ActivityMedia }
  | { kind: "custom"; payload: CustomMedia }
  | { kind: "stylized-markdown"; payload: StylizedMarkdownMedia }
  | { kind: "pdf"; payload: PdfMedia }
  | { kind: "html"; payload: HtmlMedia }
  | { kind: "image"; payload: ImageMedia }
  | { kind: "video"; payload: VideoMedia }
  | { kind: "card-deck"; payload: CardDeckMedia }
  | { kind: "walkthrough"; payload: WalkthroughMedia }
  | { kind: "infinite-canvas-walkthrough"; payload: InfiniteCanvasWalkthroughMedia }
  | { kind: "report-walkthrough"; payload: InfiniteCanvasWalkthroughMedia }
  | { kind: "stylized-walkthrough"; payload: InfiniteCanvasWalkthroughMedia }
  | { kind: "project-kanban"; payload: ProjectKanbanMedia };

// ── Interact channel (live overlay control) — mirrors src/proactive/popup-types ─
export type PopupInteractOp =
  | "highlight"
  | "scrollTo"
  | "replaceElement"
  | "appendElement"
  | "next"
  | "prev"
  | "revealAll"
  | "dismiss"
  | "scene.goto"
  | "scene.next"
  | "scene.prev"
  | "element.cue"
  | "element.hold"
  | "timeline.pause"
  | "timeline.play"
  | "timeline.seek";
export interface PopupInteract {
  eventId: string;
  op: PopupInteractOp;
  elementId?: string;
  markdown?: string;
  /** Target scene index for `scene.goto`. */
  index?: number;
  /** Reveal-animation seek position (ms) for `timeline.seek`. */
  seekMs?: number;
  payload?: Record<string, unknown>;
}

export interface PopupEvent {
  id: string;
  tier: PopupTier;
  requestedTier: PopupTier;
  appliedTier: PopupTier;
  title: string;
  body: string;
  attribution: PopupAttribution;
  actions: PopupAction[];
  dedupKey: string;
  state: PopupState;
  createdAt: number;
  actedAt: number | null;
  ackAction: string | null;
  dismissReason: string | null;
  snoozeUntil: number | null;
  voice: string | null;
  media?: PopupMedia | null;
  pinned?: boolean;
}

/** Auto-dismiss timer (ms) by tier. Media-rich pops get the longer window. */
export function autoDismissMs(ev: PopupEvent): number {
  // Interactive timelines / decks reveal sequentially (often 30s+) and can be
  // driven live by the agent — give them a long window so they aren't cut off.
  // Walkthrough = center-stage narrated timeline; user dismisses or runs to end.
  if (
    ev.media?.kind === "walkthrough" ||
    ev.media?.kind === "infinite-canvas-walkthrough" ||
    ev.media?.kind === "report-walkthrough" ||
    ev.media?.kind === "stylized-walkthrough"
  )
    return 5 * 60_000;
  if (ev.media?.kind === "stylized-markdown" || ev.media?.kind === "card-deck") return 60_000;
  if (ev.media?.kind === "pdf" || ev.media?.kind === "video") return 30_000;
  if (ev.media) return 15_000;
  if (ev.appliedTier === "NOTABLE") return 8_000;
  return 8_000;
}

/** Stable per-agent color for attribution chips (mirrors activity-panel map). */
const AGENT_COLORS: Record<string, string> = {
  main: "#d4af37",
  webdev: "#60a5fa",
  qa: "#34d399",
  coder: "#a78bfa",
  opus: "#f472b6",
  "claude-code": "#d4af37",
  orchestrator: "#fbbf24",
  verifier: "#34d399",
};

/** Deterministic fallback color derived from the agentId hash. */
export function agentColor(agentId: string): string {
  if (AGENT_COLORS[agentId]) return AGENT_COLORS[agentId];
  let h = 0;
  for (let i = 0; i < agentId.length; i++) h = (h * 31 + agentId.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 62% 62%)`;
}

export const TIER_META: Record<PopupTier, { label: string; color: string; glyph: string }> = {
  CRITICAL: { label: "Critical", color: "#ef4444", glyph: "🔴" },
  NOTABLE: { label: "Notable", color: "#fb923c", glyph: "🟠" },
  FYI: { label: "FYI", color: "#fbbf24", glyph: "🟡" },
  AMBIENT: { label: "Ambient", color: "#94a3b8", glyph: "⚪" },
};

// Live-doc focus bus events (fired by the canvas when a live-doc scene is focused)
export const LIVEDOC_FOCUS_START = "infinibot:focus.live-doc:start";
export const LIVEDOC_FOCUS_END = "infinibot:focus.live-doc:end";
export interface LiveDocFocusDetail {
  id: string;
  kind: "note" | "project" | "workflow";
}

/** Open the reasoning log for an event ("Why am I seeing this?"). */
export function whyChipTitle(ev: PopupEvent): string {
  const a = ev.attribution;
  const bits: string[] = [`raised by ${a.agentName || a.agentId}`];
  if (ev.requestedTier !== ev.appliedTier)
    bits.push(`requested ${ev.requestedTier} → applied ${ev.appliedTier}`);
  if (a.cardId) bits.push(`card ${a.cardId}`);
  if (a.goalId) bits.push(`goal ${a.goalId}`);
  if (a.verifierEvidenceRef) bits.push(`evidence ${a.verifierEvidenceRef}`);
  return bits.join(" · ");
}

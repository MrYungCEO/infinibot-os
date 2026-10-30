/**
 * Proactive Pop-Up System — shared types (Stage 1 + 2).
 *
 * Distinct from the Proactive Overhaul v2 commitment/drift model in
 * `./types.ts`. This module models *interruptions*: the rare, attributed,
 * actionable pop-ups an agent earns the right to surface (see the plan note
 * "InfiniBot — Proactive Pop-Up System (Plan v1)").
 *
 *   Backend RPCs: proactive.emit / list / ack / snooze / dismiss / subscribe
 *   Routing:      coder-runtime/proactive-router.ts (cooldown + tier downgrade)
 *   Persistence:  popup-store.ts (SQLite proactive_events table)
 */

/** Severity tier — the only thing that decides pop vs. panel. */
export type PopupTier = "CRITICAL" | "NOTABLE" | "FYI" | "AMBIENT";

/** Tier ordering, highest-severity first. Index = downgrade distance. */
export const TIER_ORDER: PopupTier[] = ["CRITICAL", "NOTABLE", "FYI", "AMBIENT"];

/** Lifecycle state of a pop-up event. */
export type PopupState = "pending" | "acted" | "snoozed" | "dismissed";

/**
 * Mandatory attribution. Every pop declares who raised it (agentId) and,
 * optionally, what it links to. No attribution → emit rejected at the gateway.
 */
export interface PopupAttribution {
  agentId: string;
  /** Human-facing agent name (falls back to agentId in the UI). */
  agentName?: string;
  /** Linked kanban card. */
  cardId?: string;
  /** Linked autonomy goal. */
  goalId?: string;
  /** Linked verifier evidence (for "verifier finding" pops). */
  verifierEvidenceRef?: string;
}

/**
 * An action primitive rendered on the pop-up. `kind` selects the UI handler;
 * `payload` carries the data that handler needs (e.g. cardId, spawn task).
 */
export type PopupActionKind =
  | "complete" // flip linked kanban card to done (verifier-gated)
  | "spawn" // approve & spawn a prebaked coder task
  | "snooze" // proactive.snooze
  | "dismiss" // proactive.dismiss (reason captured)
  | "open" // explicit navigation
  | "reply" // inline textarea (inbox-style)
  | "readmore" // expand markdown body in place
  | "build" // run the UI build (proactive.buildInto) — non-terminating
  | "commitpush"; // stage + commit + push the change (proactive.commitPush) — non-terminating

export interface PopupAction {
  /** Stable id within the event (used for ack(action)). */
  id: string;
  kind: PopupActionKind;
  label: string;
  /** Marks the Enter-key default action. At most one should be primary. */
  primary?: boolean;
  /** Arbitrary handler payload (cardId, spawn task spec, nav target, …). */
  payload?: Record<string, unknown>;
}

// ── Rich media payloads (Overlay System) ─────────────────────────────────────
// Any pop-up may carry an optional `media` block that the overlay host renders
// below the title/body with the existing black-gold glass aesthetic. Each kind
// has a typed payload; `validatePopupMedia` guards the shape at the gateway.

export type PopupMediaKind =
  | "agent-summary"
  | "note"
  | "workflow"
  | "activity"
  | "custom"
  // ── Rich media overlay kinds (Media Overlay System) ─────────────────────────
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

/** A thumbnail of generated media (image or video) embedded in a pop-up. */
export interface PopupMediaThumb {
  url: string;
  type: "image" | "video";
  alt?: string;
  /** Optional poster frame for videos. */
  poster?: string;
}

/** Diff statistics for an agent-summary card. */
export interface PopupDiffStat {
  filesChanged: number;
  additions: number;
  deletions: number;
}

/**
 * Context the completion overlay's forward-action buttons need to re-run a
 * build / commit against the right target. Populated server-side at emit time.
 */
export interface ChangeStatusContext {
  /** The run's working directory (repo or worktree) the status was derived in. */
  workdir?: string;
  /** Repo-relative changed paths to scope the commit / build against. */
  paths?: string[];
  /** Branch the change lives on (for the Commit & Push button). */
  branch?: string;
}

/** Sub-agent completion summary card. */
export interface AgentSummaryMedia {
  agentName: string;
  /** Kanban project / card the run was attached to. */
  project?: string;
  cardId?: string;
  /** Short markdown summary of what the agent did. */
  summaryMarkdown: string;
  diff?: PopupDiffStat;
  thumbnails?: PopupMediaThumb[];
  /** Optional deep-link target (hash route) for "Open". */
  href?: string;
  // ── Completion status indicators (derived server-side at emit time) ─────────
  /** Whether the change has been compiled/built into the UI dist yet. */
  buildStatus?: "built" | "unbuilt";
  /** Whether the change is committed in git. */
  commitStatus?: "committed" | "uncommitted";
  /** Whether the (committed) change is pushed to its upstream. */
  pushed?: boolean;
  /** Target context so the Build / Commit & Push buttons act on the right tree. */
  statusContext?: ChangeStatusContext;
}

/** Note preview card (pulled from notes.* RPC by the caller). */
export interface NoteMedia {
  noteId?: string;
  title: string;
  bodyMarkdown: string;
}

/** Workflow run card: step list + status badge. */
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

/** Compact single-line activity entry. */
export interface ActivityMedia {
  icon?: string;
  line: string;
  /** Optional secondary muted line. */
  detail?: string;
}

/** Arbitrary custom card: markdown/html body + optional media. */
export interface CustomMedia {
  bodyMarkdown?: string;
  /** Sanitized at render time; callers should keep it simple. */
  html?: string;
  imageUrl?: string;
  videoUrl?: string;
}

// ── Media Overlay System payloads ───────────────────────────────────────────
// These kinds render as premium black-gold cards in the overlay host. The two
// that matter most: `stylized-markdown` (timeline of element cards revealed in
// step with TTS, see ui/.../proactive-media/stylized-markdown.ts) and the framed
// `image` / `video` / `pdf` artifact cards fired automatically by media
// producers (reports / media plugins / hyperframes / notes / screenshots).

/** A framed image card. */
export interface ImageMedia {
  url: string;
  alt?: string;
  caption?: string;
  /** Natural dimensions, used to reserve aspect-ratio space (avoids layout jump). */
  width?: number;
  height?: number;
}

/** A framed, click-to-expand video card. */
export interface VideoMedia {
  url: string;
  poster?: string;
  caption?: string;
  durationMs?: number;
}

/**
 * An embedded PDF preview card. Prefer `url` (served over HTTP) for an inline
 * <iframe> preview; when only a `reportId` is known the overlay host lazily
 * fetches a preview blob via `reports.preview` and offers download / open.
 */
export interface PdfMedia {
  title?: string;
  url?: string;
  reportId?: string;
  filePath?: string;
  bytes?: number;
  pageCount?: number;
}

/** A sanitized HTML fragment card (rendered in an isolated shadow surface). */
export interface HtmlMedia {
  html: string;
  title?: string;
}

/**
 * A markdown document rendered as a *timeline* of element cards. Each parsed
 * element (heading / paragraph / bullet / code / callout / image) gets its own
 * entrance animation and a highlight glow while it is being spoken. When
 * `sequential` is true elements reveal one at a time, advancing on TTS progress
 * (approximated by word-rate, or driven precisely via the interact channel).
 */
export interface StylizedMarkdownMedia {
  markdown: string;
  title?: string;
  /** Reveal elements one-by-one (default true). When false, all render at once. */
  sequential?: boolean;
  /** Override the per-element auto-advance estimate (ms). 0 = wait for interact. */
  autoAdvanceMs?: number;
  /** Words-per-second used to estimate each element's spoken duration (default 2.7). */
  wordsPerSecond?: number;
}

/** A single card in a swipeable deck. */
export interface DeckCard {
  title?: string;
  bodyMarkdown?: string;
  imageUrl?: string;
  videoUrl?: string;
  /** Optional accent color override (hex). */
  accent?: string;
}

/** A sequential / swipeable deck of cards. */
export interface CardDeckMedia {
  cards: DeckCard[];
  /** Loop back to the first card past the last (default false). */
  loop?: boolean;
}

// ── Walkthrough (center-stage presenter) ────────────────────────────────────
// A `walkthrough` overlay is the DEFAULT response surface for voice-mode
// agents whenever a reply is more than two sentences, asks a multi-choice
// question, or explains a concept worth visualizing. Each scene carries its
// own narration chunk; the overlay speaks the chunk via the runtime voice
// route (Kokoro / cloud TTS) while the scene's reveal animation plays, and
// auto-advances on audio-end + holdMs. Choice scenes emit `proactive.interact`
// frames with the chosen value so the agent can branch.

export type WalkthroughSceneKind = "markdown" | "diagram" | "image" | "code" | "choice";

/** A single option rendered as a large tappable button in a choice scene. */
export interface WalkthroughChoice {
  /** Stable value sent back via proactive.interact (payload.choice). */
  value: string;
  /** Human-facing label. */
  label: string;
  /** Optional one-line subtitle under the label. */
  detail?: string;
}

/** Content shape per scene kind. */
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

/**
 * A single scene in the walkthrough timeline. `content` is the rendered body
 * for the scene's `kind`:
 *   - markdown : string (markdown body)
 *   - diagram  : string (mermaid source — falls back to <pre> if mermaid
 *                isn't vendored at runtime)
 *   - image    : WalkthroughImageContent
 *   - code     : WalkthroughCodeContent
 *   - choice   : WalkthroughChoiceContent
 *
 * `narration` is the text spoken by Kokoro while the scene's reveal animation
 * plays. The scene advances when the audio ends + `holdMs` elapses (or when
 * the user clicks next / hits → ). `revealMs` is the per-scene fade+rise
 * duration (default 600 ms).
 */
export interface WalkthroughScene {
  kind: WalkthroughSceneKind;
  content: string | WalkthroughCodeContent | WalkthroughImageContent | WalkthroughChoiceContent;
  /** Text spoken aloud (Kokoro / cloud TTS). Empty string → silent scene. */
  narration: string;
  /** Fade+rise animation duration in ms (default 600). */
  revealMs?: number;
  /** Extra hold (ms) after audio ends before auto-advance (default 400). */
  holdMs?: number;
}

export interface WalkthroughMedia {
  scenes: WalkthroughScene[];
  title?: string;
  /** Voice runtime hint. `engine` falls through to the configured default. */
  voice?: { engine?: "kokoro" | "cloud"; voiceId?: string };
  /** Auto-advance on audio-end (default true). false = wait for manual next. */
  autoAdvance?: boolean;
}

// ── Infinite-canvas walkthrough (pan/zoom holo-canvas presenter) ─────────────
// A premium spatial walkthrough: a large pan/zoom "world" of glass nodes wired
// by glowing connectors, driven by a timeline of `scenes`. Each scene flies the
// camera to a focused node and plays its OWN baked narration audio while a
// beat-locked animation track reveals/highlights nodes in sync with the audio's
// currentTime. This recreates the InfiniBot Holo-Canvas (see
// skills/infinite-canvas-walkthrough) inside the proactive overlay system.
//
// The moat: narration is SCENE-OWNED. At emit-time the gateway pre-bakes each
// scene's `narration.ttsText` into an mp3 via the runtime voice route (Kokoro /
// cloud) and rewrites `narration.audioUrl` to a `/api/proactive/audio/:hash`
// link (cache keyed by hash(text+voice)). The voice orchestrator stays SILENT
// for the walkthrough (set `voiceSuppress: true`) — the overlay speaks, not the
// reply path.

/** Visual archetype of a canvas node — selects the glass-card layout. */
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

/** A single big-number statistic rendered inside a `stats` node. */
export interface CanvasStat {
  /** The headline number / value (e.g. "~150 WPM"). */
  n: string;
  /** The label beneath it. */
  l: string;
}

/**
 * One node placed on the infinite world at absolute (x, y) with fixed width `w`.
 * Height is intrinsic to the content. `cl` is an accent token ("gold" | "red" |
 * "cyan" | "green" | any CSS color) mapped to the node's `--cl` border / glow.
 */
export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  x: number;
  y: number;
  w: number;
  /** Accent color token or CSS color (default gold). */
  cl?: string;
  /** Small uppercase eyebrow above the heading. */
  kicker?: string;
  /** Floating corner tag (e.g. "The Problem"). */
  part?: string;
  /** Leading glyph / emoji for callouts. */
  icon?: string;
  /** Brand line (title nodes). */
  brand?: string;
  h1?: string;
  h2?: string;
  sub?: string;
  /** Generic short title (callout / quote / image caption). */
  title?: string;
  /** Markdown-ish body (bold/italic/inline-code/lists supported). */
  body?: string;
  /** Big-number grid (stats nodes). */
  stats?: CanvasStat[];
  /** Image url (image nodes). */
  imageUrl?: string;
  alt?: string;
  /** Code body + language (code nodes). */
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

/** A connector between two node ids. Tuple or object form both accepted. */
export type CanvasLink = [string, string] | { from: string; to: string };

/** A single animation beat fired at `atMs` into the scene's narration audio. */
export interface CanvasBeat {
  /** Offset (ms) from scene start / audio start when this beat fires. */
  atMs: number;
  op: "highlight" | "reveal" | "pan" | "zoom" | "animate";
  /** Node id the beat acts on (highlight / reveal / pan / animate). */
  target?: string;
  /** Free-form params (e.g. { zoom: 0.9 } for op:"zoom"). */
  params?: Record<string, unknown>;
}

/**
 * Scene-owned narration. Prefer `audioUrl` (pre-baked at emit-time). When only
 * `ttsText` is present the overlay synthesizes live via /api/voice/tts as a
 * graceful fallback. `captionMd` renders as an on-screen subtitle.
 */
export interface CanvasNarration {
  /** Pre-baked / served audio (set by bakeScenesNarration → /api/proactive/audio/:hash). */
  audioUrl?: string;
  /** Source text to synthesize (baked at emit-time, or live-synth fallback). */
  ttsText?: string;
  /** Voice id override for synthesis (default config voice / "coral"). */
  voice?: string;
  /** On-screen caption (markdown) shown while the scene plays. */
  captionMd?: string;
}

/** One step in the walkthrough timeline. */
export interface CanvasScene {
  id: string;
  /** Node the camera flies to and spotlights for this scene. */
  focusNodeId?: string;
  /** Explicit camera target (world coords + zoom) — overrides focusNodeId. */
  cameraTarget?: { x: number; y: number; zoom?: number };
  /** Scene length hint (ms). Auto-advance falls back to this when audio absent. */
  durationMs?: number;
  /** Scene-owned narration (baked audio preferred). */
  narration?: CanvasNarration;
  /** Beat-locked animation track, played against the audio's currentTime. */
  beats?: CanvasBeat[];
}

/** Which of the 4 void background layers to render (default: all). */
export type CanvasBgLayer = "radial" | "grid" | "stars" | "vignette";

export interface InfiniteCanvasWalkthroughMedia {
  title?: string;
  /** World dimensions in px (default 9600 × 6400). */
  world?: { w: number; h: number };
  nodes: CanvasNode[];
  links?: CanvasLink[];
  scenes: CanvasScene[];
  /** Theme overrides for the gold/void tokens. */
  theme?: { gold?: string; gold2?: string; void0?: string };
  /** Background layers to render (default all four). */
  bgLayers?: CanvasBgLayer[];
  /** Auto-advance scenes on audio-end (default true). */
  autoAdvance?: boolean;
  /**
   * When true the voice orchestrator must NOT speak this reply's content — the
   * scene-owned baked narration is the single audio source. Defaults to true
   * for this kind (set false only for a silent / caption-only walkthrough where
   * you still want the orchestrator to talk).
   */
  voiceSuppress?: boolean;
  /** Optional voice override for all scene narrations. When set, overrides per-scene
   *  narration.voice AND the active-voice resolver. For advanced callers. */
  voice?: string;
}

/**
 * Interactive project-kanban card — the actionable affordance behind drift
 * alerts. Carries only the project identity; the overlay lazily loads that
 * project's live tasks (kanban.tasks.list) and mutates them in place
 * (kanban.tasks.update / .create) so changes persist to the real board. The
 * operator can move cards between columns, add a card, and mark progress
 * WITHOUT leaving the overlay. Any alert type may attach this to become
 * actionable, not just informational.
 */
export interface ProjectKanbanMedia {
  /** Project whose board to embed (Notion relation id or local store id). */
  projectId: string;
  /** Human-facing project name for the overlay header (falls back to id). */
  projectName?: string;
  /** Optional headline shown above the board (e.g. "Drifting 6 days"). */
  title?: string;
  /** Optional sub-line under the headline (e.g. the top blocker). */
  subtitle?: string;
}

export type PopupMedia =
  | { kind: "agent-summary"; payload: AgentSummaryMedia }
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

export const POPUP_MEDIA_KINDS: PopupMediaKind[] = [
  "agent-summary",
  "note",
  "workflow",
  "activity",
  "custom",
  "stylized-markdown",
  "pdf",
  "html",
  "image",
  "video",
  "card-deck",
  "walkthrough",
  "infinite-canvas-walkthrough",
  "report-walkthrough",
  "stylized-walkthrough",
  "project-kanban",
];

/**
 * Validate a `{ kind, payload }` media block. Returns a normalized PopupMedia
 * or an error string. Used by proactive.emit (lenient) and proactive.emitMedia
 * (strict convenience wrapper).
 */
export function validatePopupMedia(input: unknown): { media?: PopupMedia; error?: string } {
  if (!input || typeof input !== "object") return { error: "media must be an object" };
  const { kind, payload } = input as { kind?: unknown; payload?: unknown };
  if (typeof kind !== "string" || !POPUP_MEDIA_KINDS.includes(kind as PopupMediaKind)) {
    return { error: `media.kind must be one of ${POPUP_MEDIA_KINDS.join(", ")}` };
  }
  if (!payload || typeof payload !== "object") return { error: "media.payload must be an object" };
  const p = payload as Record<string, unknown>;
  switch (kind as PopupMediaKind) {
    case "agent-summary":
      if (typeof p.agentName !== "string" || typeof p.summaryMarkdown !== "string")
        return { error: "agent-summary requires agentName + summaryMarkdown" };
      break;
    case "note":
      if (typeof p.title !== "string" || typeof p.bodyMarkdown !== "string")
        return { error: "note requires title + bodyMarkdown" };
      break;
    case "workflow":
      if (typeof p.name !== "string" || !Array.isArray(p.steps))
        return { error: "workflow requires name + steps[]" };
      break;
    case "activity":
      if (typeof p.line !== "string") return { error: "activity requires line" };
      break;
    case "custom":
      // All fields optional; at least one content field should be present.
      if (!p.bodyMarkdown && !p.html && !p.imageUrl && !p.videoUrl)
        return { error: "custom requires one of bodyMarkdown / html / imageUrl / videoUrl" };
      break;
    case "stylized-markdown":
      if (typeof p.markdown !== "string" || !p.markdown.trim())
        return { error: "stylized-markdown requires a non-empty markdown string" };
      break;
    case "pdf":
      if (
        typeof p.url !== "string" &&
        typeof p.reportId !== "string" &&
        typeof p.filePath !== "string"
      )
        return { error: "pdf requires one of url / reportId / filePath" };
      break;
    case "html":
      if (typeof p.html !== "string" || !p.html.trim())
        return { error: "html requires a non-empty html string" };
      break;
    case "image":
      if (typeof p.url !== "string" || !p.url.trim()) return { error: "image requires a url" };
      break;
    case "video":
      if (typeof p.url !== "string" || !p.url.trim()) return { error: "video requires a url" };
      break;
    case "card-deck":
      if (!Array.isArray(p.cards) || p.cards.length === 0)
        return { error: "card-deck requires a non-empty cards[] array" };
      break;
    case "project-kanban":
      if (typeof p.projectId !== "string" || !p.projectId.trim())
        return { error: "project-kanban requires a non-empty projectId" };
      break;
    case "walkthrough": {
      if (!Array.isArray(p.scenes) || p.scenes.length === 0)
        return { error: "walkthrough requires a non-empty scenes[] array" };
      const SCENE_KINDS = ["markdown", "diagram", "image", "code", "choice"];
      for (let i = 0; i < (p.scenes as unknown[]).length; i++) {
        const s = (p.scenes as Array<Record<string, unknown>>)[i];
        if (!s || typeof s !== "object")
          return { error: `walkthrough.scenes[${i}] must be an object` };
        if (typeof s.kind !== "string" || !SCENE_KINDS.includes(s.kind))
          return {
            error: `walkthrough.scenes[${i}].kind must be one of ${SCENE_KINDS.join(", ")}`,
          };
        if (typeof s.narration !== "string")
          return { error: `walkthrough.scenes[${i}].narration must be a string` };
        if (s.content == null) return { error: `walkthrough.scenes[${i}].content is required` };
        if (s.kind === "markdown" || s.kind === "diagram") {
          if (typeof s.content !== "string" || !s.content.trim())
            return {
              error: `walkthrough.scenes[${i}] (${s.kind}) content must be a non-empty string`,
            };
        } else if (s.kind === "image") {
          const c = s.content as Record<string, unknown>;
          if (!c || typeof c !== "object" || typeof c.url !== "string" || !c.url.trim())
            return { error: `walkthrough.scenes[${i}] (image) requires content.url` };
        } else if (s.kind === "code") {
          const c = s.content as Record<string, unknown>;
          if (!c || typeof c !== "object" || typeof c.code !== "string")
            return { error: `walkthrough.scenes[${i}] (code) requires content.code` };
        } else if (s.kind === "choice") {
          const c = s.content as Record<string, unknown>;
          if (!c || typeof c !== "object" || !Array.isArray(c.choices) || c.choices.length === 0)
            return {
              error: `walkthrough.scenes[${i}] (choice) requires content.choices[] (non-empty)`,
            };
          for (let j = 0; j < (c.choices as unknown[]).length; j++) {
            const ch = (c.choices as Array<Record<string, unknown>>)[j];
            if (
              !ch ||
              typeof ch !== "object" ||
              typeof ch.value !== "string" ||
              typeof ch.label !== "string"
            )
              return {
                error: `walkthrough.scenes[${i}].choices[${j}] requires {value, label} strings`,
              };
          }
        }
      }
      break;
    }
    case "infinite-canvas-walkthrough": {
      if (!Array.isArray(p.nodes) || p.nodes.length === 0)
        return { error: "infinite-canvas-walkthrough requires a non-empty nodes[] array" };
      const NODE_KINDS = [
        "callout",
        "text",
        "title",
        "stats",
        "diagram",
        "image",
        "code",
        "quote",
        "chart",
        "reveal-list",
        "timeline",
        "comparison",
        "pricing",
        "cta",
        "live-doc",
      ];
      for (let i = 0; i < (p.nodes as unknown[]).length; i++) {
        const n = (p.nodes as Array<Record<string, unknown>>)[i];
        if (!n || typeof n !== "object")
          return { error: `infinite-canvas-walkthrough.nodes[${i}] must be an object` };
        if (typeof n.id !== "string" || !n.id.trim())
          return { error: `infinite-canvas-walkthrough.nodes[${i}].id is required` };
        if (typeof n.kind !== "string" || !NODE_KINDS.includes(n.kind))
          return {
            error: `infinite-canvas-walkthrough.nodes[${i}].kind must be one of ${NODE_KINDS.join(", ")}`,
          };
        if (typeof n.x !== "number" || typeof n.y !== "number" || typeof n.w !== "number")
          return { error: `infinite-canvas-walkthrough.nodes[${i}] requires numeric x, y, w` };
      }
      if (!Array.isArray(p.scenes) || p.scenes.length === 0)
        return { error: "infinite-canvas-walkthrough requires a non-empty scenes[] array" };
      const nodeIds = new Set((p.nodes as Array<{ id: string }>).map((n) => n.id));
      for (let i = 0; i < (p.scenes as unknown[]).length; i++) {
        const s = (p.scenes as Array<Record<string, unknown>>)[i];
        if (!s || typeof s !== "object")
          return { error: `infinite-canvas-walkthrough.scenes[${i}] must be an object` };
        if (typeof s.id !== "string" || !s.id.trim())
          return { error: `infinite-canvas-walkthrough.scenes[${i}].id is required` };
        if (s.focusNodeId != null && !nodeIds.has(s.focusNodeId as string))
          return {
            error: `infinite-canvas-walkthrough.scenes[${i}].focusNodeId "${String(
              s.focusNodeId,
            )}" is not a known node id`,
          };
        if (s.narration != null) {
          const nar = s.narration as Record<string, unknown>;
          if (typeof nar !== "object")
            return {
              error: `infinite-canvas-walkthrough.scenes[${i}].narration must be an object`,
            };
          if (
            nar.audioUrl == null &&
            (typeof nar.ttsText !== "string" || !String(nar.ttsText).trim())
          )
            return {
              error: `infinite-canvas-walkthrough.scenes[${i}].narration requires audioUrl or ttsText`,
            };
        }
      }
      if (p.links != null && !Array.isArray(p.links))
        return { error: "infinite-canvas-walkthrough.links must be an array when present" };
      break;
    }
    // ── Canvas-backed report / stylized-walkthrough — same shape as
    //    infinite-canvas-walkthrough, reuse identical structural guards.
    case "report-walkthrough":
    case "stylized-walkthrough": {
      if (!Array.isArray(p.nodes) || p.nodes.length === 0)
        return { error: `${kind} requires a non-empty nodes[] array` };
      const RW_NODE_KINDS = [
        "callout",
        "text",
        "title",
        "stats",
        "diagram",
        "image",
        "code",
        "quote",
        "chart",
        "reveal-list",
        "timeline",
        "comparison",
        "pricing",
        "cta",
      ];
      for (let i = 0; i < (p.nodes as unknown[]).length; i++) {
        const n = (p.nodes as Array<Record<string, unknown>>)[i];
        if (!n || typeof n !== "object") return { error: `${kind}.nodes[${i}] must be an object` };
        if (typeof n.id !== "string" || !n.id.trim())
          return { error: `${kind}.nodes[${i}].id is required` };
        if (typeof n.kind !== "string" || !RW_NODE_KINDS.includes(n.kind))
          return {
            error: `${kind}.nodes[${i}].kind must be one of ${RW_NODE_KINDS.join(", ")}`,
          };
        if (typeof n.x !== "number" || typeof n.y !== "number" || typeof n.w !== "number")
          return { error: `${kind}.nodes[${i}] requires numeric x, y, w` };
      }
      if (!Array.isArray(p.scenes) || p.scenes.length === 0)
        return { error: `${kind} requires a non-empty scenes[] array` };
      const rwNodeIds = new Set((p.nodes as Array<{ id: string }>).map((n) => n.id));
      for (let i = 0; i < (p.scenes as unknown[]).length; i++) {
        const s = (p.scenes as Array<Record<string, unknown>>)[i];
        if (!s || typeof s !== "object") return { error: `${kind}.scenes[${i}] must be an object` };
        if (typeof s.id !== "string" || !s.id.trim())
          return { error: `${kind}.scenes[${i}].id is required` };
        if (s.focusNodeId != null && !rwNodeIds.has(s.focusNodeId as string))
          return {
            error: `${kind}.scenes[${i}].focusNodeId "${String(s.focusNodeId)}" is not a known node id`,
          };
        if (s.narration != null) {
          const nar = s.narration as Record<string, unknown>;
          if (typeof nar !== "object")
            return { error: `${kind}.scenes[${i}].narration must be an object` };
          if (
            nar.audioUrl == null &&
            (typeof nar.ttsText !== "string" || !String(nar.ttsText).trim())
          )
            return { error: `${kind}.scenes[${i}].narration requires audioUrl or ttsText` };
        }
      }
      if (p.links != null && !Array.isArray(p.links))
        return { error: `${kind}.links must be an array when present` };
      break;
    }
  }
  return { media: { kind, payload } as PopupMedia };
}

/** Params accepted by proactive.emit. */
export interface PopupEmitInput {
  tier: PopupTier;
  title: string;
  body: string;
  attribution: PopupAttribution;
  actions?: PopupAction[];
  dedupKey: string;
  /** Optional voice readout text (Stage 3 — stored but not spoken this pass). */
  voice?: string;
  /** Optional rich-media payload rendered by the overlay host. */
  media?: PopupMedia;
  /**
   * Where a tap should land (docs/mobile/DEEP-LINKS.md): any accepted deep-link
   * form (`infinibot://…`, relative web path). Derived from an `open` action's
   * payload.href/target when omitted.
   */
  deepLink?: string;
  /** Pre-built link (wins over deepLink). */
  link?: PopupLink;
}

/** Deep link + optional https web opener for a pop-up. */
export interface PopupLink {
  deepLink: string;
  webUrl?: string;
}

/** A fully-resolved pop-up event as persisted + surfaced to the UI. */
export interface PopupEvent {
  id: string;
  /** Effective tier after routing (== appliedTier). */
  tier: PopupTier;
  /** Tier the agent asked for. */
  requestedTier: PopupTier;
  /** Tier actually applied after cooldown / quiet-hours / focus rules. */
  appliedTier: PopupTier;
  title: string;
  body: string;
  attribution: PopupAttribution;
  actions: PopupAction[];
  dedupKey: string;
  state: PopupState;
  createdAt: number;
  actedAt: number | null;
  /** The action id chosen when acted. */
  ackAction: string | null;
  dismissReason: string | null;
  /** Unix ms the snooze expires (null unless snoozed). */
  snoozeUntil: number | null;
  /** Optional voice readout text. */
  voice: string | null;
  /** Optional rich-media payload rendered by the overlay host. */
  media: PopupMedia | null;
  /** Pinned by the user — held on screen until manually dismissed. */
  pinned: boolean;
  /** Where a tap lands (deep link + web opener); absent when the pop has no target. */
  link?: PopupLink;
}

/** Whether a tier surfaces as an interrupt (pop) vs. panel-only. */
export function isInterrupt(tier: PopupTier): boolean {
  return tier === "CRITICAL" || tier === "NOTABLE";
}

// ── Interact channel (server → live overlay) ─────────────────────────────────
// While an agent is speaking it can drive an already-shown overlay (typically a
// stylized-markdown timeline): jump the highlight to an element, scroll it into
// view, swap or append an element, advance a deck, or dismiss the card. The
// gateway broadcasts these as `proactive.interact` frames; the overlay host
// routes them to the matching live card by eventId. See proactive.interact RPC.

export type PopupInteractOp =
  | "highlight" // glow + settle a specific element (elementId)
  | "scrollTo" // scroll an element into view (elementId)
  | "replaceElement" // swap an element's markdown (elementId + markdown)
  | "appendElement" // append a new element to the timeline (markdown)
  | "next" // advance the timeline / deck cursor
  | "prev" // step the timeline / deck cursor back
  | "revealAll" // reveal every remaining element at once
  | "dismiss" // close the overlay
  // ── Scene-timeline orchestration (walkthrough / presenter) ──────────────────
  | "scene.goto" // jump to scene `index` (walkthrough)
  | "scene.next" // advance to the next scene
  | "scene.prev" // step back one scene
  | "element.cue" // re-pulse / spotlight a specific element (elementId)
  | "element.hold" // pin auto-advance on an element until released (elementId)
  | "timeline.pause" // pause auto-advance + any in-flight reveal animation
  | "timeline.play" // resume auto-advance + reveal animation
  | "timeline.seek"; // seek the active reveal animation to `seekMs`

export const POPUP_INTERACT_OPS: PopupInteractOp[] = [
  "highlight",
  "scrollTo",
  "replaceElement",
  "appendElement",
  "next",
  "prev",
  "revealAll",
  "dismiss",
  "scene.goto",
  "scene.next",
  "scene.prev",
  "element.cue",
  "element.hold",
  "timeline.pause",
  "timeline.play",
  "timeline.seek",
];

/** A live-overlay control message, scoped to one event. */
export interface PopupInteract {
  eventId: string;
  op: PopupInteractOp;
  /** Stable element id within a stylized-markdown timeline (e.g. "el-3"). */
  elementId?: string;
  /** Markdown for replaceElement / appendElement. */
  markdown?: string;
  /** Target scene index for `scene.goto` (0-based). */
  index?: number;
  /** Reveal-animation seek position in ms for `timeline.seek`. */
  seekMs?: number;
  /** Free-form extra payload for forward-compat. */
  payload?: Record<string, unknown>;
}

/** Validate a `{ eventId, op, ... }` interact message. */
export function validatePopupInteract(input: unknown): {
  interact?: PopupInteract;
  error?: string;
} {
  if (!input || typeof input !== "object") return { error: "interact must be an object" };
  const o = input as Record<string, unknown>;
  if (typeof o.eventId !== "string" || !o.eventId.trim())
    return { error: "interact requires eventId" };
  if (typeof o.op !== "string" || !POPUP_INTERACT_OPS.includes(o.op as PopupInteractOp))
    return { error: `interact.op must be one of ${POPUP_INTERACT_OPS.join(", ")}` };
  const op = o.op as PopupInteractOp;
  if (
    (op === "highlight" ||
      op === "scrollTo" ||
      op === "replaceElement" ||
      op === "element.cue" ||
      op === "element.hold") &&
    !o.elementId
  )
    return { error: `interact.${op} requires elementId` };
  if (op === "replaceElement" && typeof o.markdown !== "string")
    return { error: "replaceElement requires markdown" };
  if (op === "appendElement" && typeof o.markdown !== "string")
    return { error: "appendElement requires markdown" };
  if (
    op === "scene.goto" &&
    (typeof o.index !== "number" || !Number.isFinite(o.index) || o.index < 0)
  )
    return { error: "scene.goto requires a non-negative numeric index" };
  if (
    op === "timeline.seek" &&
    (typeof o.seekMs !== "number" || !Number.isFinite(o.seekMs) || o.seekMs < 0)
  )
    return { error: "timeline.seek requires a non-negative numeric seekMs" };
  const interact: PopupInteract = { eventId: o.eventId.trim(), op };
  if (typeof o.elementId === "string") interact.elementId = o.elementId;
  if (typeof o.markdown === "string") interact.markdown = o.markdown;
  if (typeof o.index === "number") interact.index = o.index;
  if (typeof o.seekMs === "number") interact.seekMs = o.seekMs;
  if (o.payload && typeof o.payload === "object")
    interact.payload = o.payload as Record<string, unknown>;
  return { interact };
}

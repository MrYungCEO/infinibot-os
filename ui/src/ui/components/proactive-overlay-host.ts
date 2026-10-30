/**
 * <proactive-overlay-host> — single app-wide Proactive Overlay orchestrator.
 *
 * Mounted ONCE at the app shell (after the main view) so pop-ups float above
 * EVERY route/tab — not just the dashboard/discipline panels. Owns:
 *   • the single live subscription to the gateway pop-up feed
 *   • signal producers for live WS frames the gateway can't restart to add
 *     (kanban task-done; sub-agent completions are now produced server-side)
 *   • routing: NOTABLE + CRITICAL (plain-text AND media-rich) → the center-stage
 *     <proactive-presenter> presence-rotation deck; FYI → small corner
 *     <proactive-toast> (capped at 4, the rest queue); walkthrough keeps its own
 *     narrated overlay. The hard <proactive-modal> blocker is retired.
 *   • the quiet-hours "later" muted-tile stack (AC8): downgraded media-rich pops
 *     still render — as a reviewable muted tile — instead of being suppressed
 *   • action handling (optimistic + revert), incl. pin/unpin RPCs
 *   • the `window.proactiveOverlay` API, incl. voice-synced highlight sequences
 *
 * The inline Signals feed/history stays in <proactive-popups> (used by
 * <proactive-panel>); this host renders only the floating surfaces.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../gateway";
import "./proactive-toast.js";
import "./proactive-modal.js";
import "./walkthrough-overlay.js";
import "./walkthroughs/infinite-canvas-walkthrough.js";
import "./proactive-presenter.js";
import "./embedded-kanban-overlay.js";
import type { ProactiveToast } from "./proactive-toast.js";
import {
  TIER_META,
  agentColor,
  type PopupAction,
  type PopupEvent,
  type PopupInteract,
  type PopupState,
  type PopupTier,
} from "./proactive-popup-shared.js";
import { dispatchInteract } from "./proactive-media/interactive-registry.js";

const MAX_VISIBLE_TOASTS = 4;

/** Media kinds that render on the full-viewport infinite-canvas surface. */
const CANVAS_WALKTHROUGH_KINDS = new Set([
  "infinite-canvas-walkthrough",
  "report-walkthrough",
  "stylized-walkthrough",
]);
function isCanvasWalkthroughKind(kind: string | undefined): boolean {
  return kind !== undefined && CANVAS_WALKTHROUGH_KINDS.has(kind);
}

// Floating surfaces (modal + toasts) only interrupt for LIVE events — ones the
// gateway pushes over the socket while the app is open, OR ones created within
// this freshness window of the page opening. Historical `pending` events
// returned by the boot snapshot (`proactive.subscribe`) stay in the feed/history
// (rendered by <proactive-popups> in the panel) but must NEVER auto-pop on load
// — otherwise stale backlog reads as "random notifications with no trigger".
const FRESH_POP_MS = 45_000;

// Signal-producer dedup guard (shared key space with the inline feed producer —
// harmless overlap; both honour the same TTL window).
const EMITTED_KEY = "infinibot-signals-emitted";
const EMITTED_TTL_MS = 6 * 60 * 60 * 1000;

function loadEmitted(): Record<string, number> {
  try {
    const raw = localStorage.getItem(EMITTED_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function saveEmitted(m: Record<string, number>): void {
  try {
    localStorage.setItem(EMITTED_KEY, JSON.stringify(m));
  } catch {
    /* storage disabled */
  }
}

interface VoiceSequenceInput {
  eventId: string;
  segments: Array<{ startMs: number; endMs: number; highlightSelector: string }>;
}

/** Global API surface exposed on window for voice/agent callers. */
export interface ProactiveOverlayApi {
  beginVoiceSequence: (input: VoiceSequenceInput) => void;
  /** Pin / dismiss helpers so callers can drive the overlay imperatively. */
  pin: (id: string) => void;
  dismiss: (id: string) => void;
  /** Drive a live interactive overlay (stylized-markdown timeline / card-deck). */
  interact: (interact: PopupInteract) => boolean;
}

declare global {
  interface Window {
    proactiveOverlay?: ProactiveOverlayApi;
  }
}

@customElement("proactive-overlay-host")
export class ProactiveOverlayHost extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;

  @state() private events: PopupEvent[] = [];
  @state() private error: string | null = null;
  @state() private laterCollapsed = true;
  /** True while a live voice-chat loop is connected. Floating surfaces
   *  (toasts + the quiet-hours "later" stack) are held so proactive pop-ups
   *  don't interrupt the user mid-conversation; they surface when voice ends.
   *  CRITICAL still pops — those are rare and genuinely urgent. */
  @state() private voiceActive = false;
  /** Events the user expired/cleared from the later stack this session. */
  private laterCleared = new Set<string>();
  /**
   * Local dismissal tombstones. Closing an overlay must remain authoritative
   * even when the gateway is offline or reconnect returns stale pending data.
   */
  private locallyDismissed = new Set<string>();
  /** IDs whose auto-dismiss timer fired and slid back to the feed. They must
   *  not re-float as toasts in this session (prevents ghost-resurface on reconnect). */
  private timerExpired = new Set<string>();

  private unsub: (() => void) | null = null;
  /** BroadcastChannel for instant cross-window dismiss/snooze sync on the same machine. */
  private _bc: BroadcastChannel | null = null;

  /** IDs of events pushed LIVE over the socket after mount — the only ones (plus
   *  freshly-created ones) allowed to float as modals/toasts. */
  private liveIds = new Set<string>();
  /** Wall-clock at mount; used together with FRESH_POP_MS for the freshness gate. */
  private mountAt = 0;
  /** Timestamp of the newest event we have seen — used to reconcile gaps on reconnect. */
  private newestEventTs = 0;

  connectedCallback(): void {
    super.connectedCallback();
    this.mountAt = Date.now();
    this.installGlobalApi();
    void this.loadFeed();
    if (this.client) this.unsub = this.client.subscribe((e) => this.onEvent(e));
    // Composed events from nested media cards bubble through the host element.
    this.addEventListener("pmedia-pdf-open", this.onPdfOpen as EventListener);
    this.addEventListener("pmedia-dismiss", this.onMediaDismiss as EventListener);
    this.addEventListener("pmedia-surface", this.onMediaSurface as EventListener);
    this.addEventListener("walkthrough-choice", this.onWalkthroughChoice as EventListener);
    // BroadcastChannel: instant same-machine cross-window dismiss/snooze sync.
    try {
      this._bc = new BroadcastChannel("infinibot:toast-dismiss");
      this._bc.onmessage = (e: MessageEvent) => this._onBcMessage(e);
    } catch {
      /* BroadcastChannel not available in this environment */
    }
  }

  /** A compact media stub asked to re-surface its event (e.g. project-kanban). */
  private onMediaSurface = (e: Event): void => {
    const id = (e as CustomEvent).detail?.eventId as string | undefined;
    const ev = id ? this.events.find((x) => x.id === id) : null;
    if (ev) void this.pinEvent(ev);
  };

  /** Forward a walkthrough choice to the agent via proactive.interact. */
  private onWalkthroughChoice = (e: Event): void => {
    const detail = (e as CustomEvent).detail as { eventId?: string; choice?: string };
    if (!detail?.eventId) return;
    const client = this.client;
    if (!client) return;
    // The `appendElement` op carries the user's selection as a markdown chunk;
    // agents listening to proactive.interact echoes (or polling for the event's
    // updated state) can branch on it. Best-effort — fire and forget.
    void client
      .request("proactive.interact", {
        eventId: detail.eventId,
        op: "appendElement",
        markdown: `> choice: ${detail.choice ?? ""}`,
        payload: { kind: "walkthrough-choice", choice: detail.choice ?? "" },
      })
      .catch(() => {
        /* server may not be wired for interact in this env — overlay still advances */
      });
  };
  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsub?.();
    this.unsub = null;
    this.removeEventListener("pmedia-pdf-open", this.onPdfOpen as EventListener);
    this.removeEventListener("pmedia-dismiss", this.onMediaDismiss as EventListener);
    this.removeEventListener("pmedia-surface", this.onMediaSurface as EventListener);
    this.removeEventListener("walkthrough-choice", this.onWalkthroughChoice as EventListener);
    if (window.proactiveOverlay === this.api) delete window.proactiveOverlay;
    this._bc?.close();
    this._bc = null;
  }

  /** Track the live voice loop so floating surfaces can be held mid-call. */
  private onVoiceConnected = (e: CustomEvent): void => {
    this.voiceActive = !!(e.detail as { connected?: boolean })?.connected;
  };

  /** Resolve a PDF card's Open click → blob preview via reports.preview. */
  private onPdfOpen = async (e: CustomEvent): Promise<void> => {
    const d = (e.detail ?? {}) as { reportId?: string; filePath?: string; url?: string };
    if (d.url) {
      window.open(d.url, "_blank", "noopener");
      return;
    }
    if (!d.reportId || !this.client) return;
    try {
      const res = (await this.client.request("reports.preview", {
        id: d.reportId,
        base64: true,
      })) as { base64?: string };
      if (!res?.base64) return;
      const bin = atob(res.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      window.open(blobUrl, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (err) {
      this.error = `Open PDF failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  /** A media card asked to dismiss itself (interact op:'dismiss'). */
  private onMediaDismiss = (e: CustomEvent): void => {
    const id = (e.detail as { eventId?: string })?.eventId;
    const ev = id ? this.events.find((x) => x.id === id) : null;
    if (ev)
      void this.handleAction(ev, {
        id: "dismiss",
        kind: "dismiss",
        label: "Dismiss",
        payload: { reason: "dismissed via interact" },
      });
  };
  protected updated(changed: Map<string, unknown>): void {
    if (changed.has("client") && this.client) {
      this.unsub?.();
      this.unsub = this.client.subscribe((e) => this.onEvent(e));
      // Reconcile gap: fetch only events we may have missed while disconnected.
      void this.loadFeed(this.newestEventTs || undefined);
    }
  }

  // ── global API (AC4 + agent control) ────────────────────────────────────────
  private api: ProactiveOverlayApi = {
    beginVoiceSequence: (input) => this.beginVoiceSequence(input),
    pin: (id) => {
      const ev = this.events.find((e) => e.id === id);
      if (ev) void this.pinEvent(ev);
    },
    dismiss: (id) => {
      const ev = this.events.find((e) => e.id === id);
      if (ev)
        void this.handleAction(ev, {
          id: "dismiss",
          kind: "dismiss",
          label: "Dismiss",
          payload: { reason: "dismissed via API" },
        });
    },
    interact: (interact) => dispatchInteract(interact),
  };
  private installGlobalApi(): void {
    window.proactiveOverlay = this.api;
  }

  private beginVoiceSequence(input: VoiceSequenceInput): void {
    const toast = this.renderRoot.querySelector("proactive-toast") as ProactiveToast | null;
    if (toast) toast.beginVoiceSequence(input.eventId, input.segments);
  }

  // ── feed ─────────────────────────────────────────────────────────────────────

  /**
   * Load (or reload) the event feed.
   * - No `since`: full snapshot; replaces this.events.
   * - With `since`: gap-fill after reconnect; merges only newer events so
   *   existing local state survives the WS blip.
   */
  private async loadFeed(since?: number): Promise<void> {
    if (!this.client) return;
    try {
      const res = (await this.client.request("proactive.subscribe", {
        limit: since !== undefined ? 200 : 100,
        since,
      })) as { events?: PopupEvent[] };
      if (!Array.isArray(res?.events)) return;
      if (since !== undefined) {
        // Reconcile mode: merge each new event without wiping existing feed.
        for (const ev of res.events) {
          this.mergeEvent(ev);
        }
      } else {
        this.events = res.events.filter((ev) => !this.locallyDismissed.has(ev.id));
        for (const ev of res.events) {
          if (ev.createdAt > this.newestEventTs) this.newestEventTs = ev.createdAt;
        }
      }
    } catch (e) {
      console.error("[proactive-overlay] feed load failed:", e);
    }
  }

  private onEvent(frame: GatewayEventFrame): void {
    void this.produceFromFrame(frame);
    // Live overlay control: route to the matching interactive card by eventId.
    if (frame.event === "proactive.interact") {
      const interact = (frame.payload as { interact?: PopupInteract })?.interact;
      if (interact?.eventId) dispatchInteract(interact);
      return;
    }
    if (frame.event !== "proactive.event" && frame.event !== "proactive.updated") return;
    const ev = (frame.payload as { event?: PopupEvent })?.event;
    if (!ev?.id) return;
    if (this.locallyDismissed.has(ev.id)) return;
    if (ev.state === "dismissed") {
      // Dismissed by another window/client — remove from all live surfaces.
      this.liveIds.delete(ev.id);
      this.laterCleared.add(ev.id);
      this.timerExpired.add(ev.id);
    } else if (ev.state === "snoozed") {
      // Snoozed by another window/client — remove from floating surfaces.
      this.liveIds.delete(ev.id);
    } else {
      // Pushed live → this event earned the right to float (subject to tier).
      this.liveIds.add(ev.id);
    }
    this.mergeEvent(ev);
  }

  /** True only for events that may float as a modal/toast: pushed live over the
   *  socket after mount, or created within the freshness window of page open.
   *  Stale `pending` events from the boot snapshot return false (feed-only). */
  private isLive(e: PopupEvent): boolean {
    // A pinned ("surfaced") event always counts as live — the user explicitly
    // asked to bring it back, so the freshness gate must not re-bury it.
    return !!e.pinned || this.liveIds.has(e.id) || Date.now() - e.createdAt < FRESH_POP_MS;
  }

  /** Tier the surface filters should treat the event as. A pinned event is
   *  restored to the tier its agent originally requested, so a quiet-hours /
   *  cooldown downgrade can't keep a surfaced pop stuck in the panel: a pinned
   *  CRITICAL re-pops as a modal, a pinned NOTABLE re-pops as a toast. */
  private effectiveTier(e: PopupEvent): PopupTier {
    return e.pinned ? e.requestedTier : e.appliedTier;
  }

  private mergeEvent(ev: PopupEvent): void {
    if (this.locallyDismissed.has(ev.id)) return;
    if (ev.createdAt > this.newestEventTs) this.newestEventTs = ev.createdAt;
    const idx = this.events.findIndex((e) => e.id === ev.id);
    if (idx >= 0) {
      const next = this.events.slice();
      next[idx] = ev;
      this.events = next;
    } else {
      this.events = [ev, ...this.events];
    }
  }

  // ── signal producers ─────────────────────────────────────────────────────────
  // Sub-agent completions are produced SERVER-SIDE now (rich agent-summary), so
  // here we only cover frames with no server producer: kanban task-done.
  private async produceFromFrame(frame: GatewayEventFrame): Promise<void> {
    if (!this.client) return;
    if (frame.event !== "kanban:task:completed") return;
    const p = (frame.payload ?? {}) as { taskId?: string; title?: string; projectName?: string };
    if (!p.taskId) return;
    const dedupKey = `kanban:done:${p.taskId}`;

    const now = Date.now();
    const emitted = loadEmitted();
    for (const k of Object.keys(emitted)) if (now - emitted[k] > EMITTED_TTL_MS) delete emitted[k];
    if (emitted[dedupKey] && now - emitted[dedupKey] < EMITTED_TTL_MS) {
      saveEmitted(emitted);
      return;
    }
    emitted[dedupKey] = now;
    saveEmitted(emitted);

    try {
      await this.client.request("proactive.emit", {
        tier: "FYI",
        title: `Task done: ${p.title || "Untitled"}`,
        body: `${p.projectName || "Unknown project"} · task marked complete.`,
        attribution: { agentId: "kanban", agentName: "Kanban" },
        dedupKey,
        media: { kind: "activity", payload: { icon: "✓", line: p.title || "Task complete", detail: p.projectName } },
      });
    } catch (e) {
      const m = loadEmitted();
      delete m[dedupKey];
      saveEmitted(m);
      console.warn("[proactive-overlay] kanban signal emit failed:", e);
    }
  }

  // ── live surfaces ──────────────────────────────────────────────────────────
  // Routing: media-rich emits now default to the center-stage <proactive-presenter>
  // focus surface (walkthrough keeps its own narrated overlay). Plain-text pops
  // fall back to the corner toast (NOTABLE) or the hard modal (CRITICAL).
  // The hard blocker modal is retired: ALL CRITICAL pops (plain-text and
  // media-rich) now route to the center-stage presence-rotation presenter, which
  // already dims + blurs the whole viewport. Kept as `null` so the always-mounted
  // <proactive-modal> never fires.
  private get pendingCritical(): PopupEvent | null {
    return null;
  }

  /** Newest pending walkthrough — its own center-stage narrated presenter. */
  private get pendingWalkthrough(): PopupEvent | null {
    const wts = this.events
      .filter(
        (e) => e.state === "pending" && e.media?.kind === "walkthrough" && this.isLive(e),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    return wts[0] ?? null;
  }

  /** Newest pending infinite-canvas walkthrough — its own pan/zoom Holo-Canvas
   *  surface (like walkthrough, owns the full viewport, NOT the presenter card).
   *  Report / stylized-walkthrough conversions carry the same payload shape
   *  (canvas.convert) and render on the same surface. */
  private get pendingCanvasWalkthrough(): PopupEvent | null {
    const cws = this.events
      .filter(
        (e) => e.state === "pending" && isCanvasWalkthroughKind(e.media?.kind) && this.isLive(e),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    return cws[0] ?? null;
  }

  /** Newest pending project-kanban (drift) alert — its OWN center-stage
   *  interactive board surface (like walkthrough, owns the viewport; NOT the
   *  rotating presenter, so the operator's interaction is never auto-advanced
   *  or cut off). Any tier routes here when media.kind === "project-kanban". */
  private get pendingDriftKanban(): PopupEvent | null {
    const ks = this.events
      .filter(
        (e) => e.state === "pending" && e.media?.kind === "project-kanban" && this.isLive(e),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    return ks[0] ?? null;
  }

  /** The PRESENCE ROTATION queue — every pending NOTABLE/CRITICAL pop (plain-text
   *  AND media-rich, excluding the self-owning surfaces walkthrough +
   *  infinite-canvas-walkthrough), newest first. The presenter auto-rotates
   *  through these with cross-dissolves; new emits slot in without flicker and
   *  acted/dismissed ones drop out. Quiet-hours-downgraded pops fall to the
   *  muted later stack instead. */
  private get presenterQueue(): PopupEvent[] {
    return this.events
      .filter(
        (e) =>
          e.state === "pending" &&
          e.media?.kind !== "walkthrough" &&
          !isCanvasWalkthroughKind(e.media?.kind) &&
          e.media?.kind !== "project-kanban" &&
          (this.effectiveTier(e) === "NOTABLE" || this.effectiveTier(e) === "CRITICAL") &&
          !this.isDowngradedToLater(e) &&
          this.isLive(e),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Corner toasts are now reserved for the FYI tier only — the small glance
   *  surface for low-priority pops. NOTABLE/CRITICAL escalate to the center-stage
   *  presence-rotation presenter. Pinned-first, then newest. */
  private get toastEligible(): PopupEvent[] {
    return this.events
      .filter(
        (e) =>
          e.state === "pending" &&
          this.effectiveTier(e) === "FYI" &&
          e.media?.kind !== "project-kanban" &&
          !this.isDowngradedToLater(e) &&
          !this.timerExpired.has(e.id) &&
          this.isLive(e),
      )
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.createdAt - a.createdAt);
  }

  /** Visible toasts (capped). Held while voice is live or while the center-stage
   *  presenter is active (its full-screen backdrop at z-index 9992 would block
   *  X clicks on toasts at z-index 9990). They re-surface once the deck clears. */
  private get visibleToasts(): PopupEvent[] {
    if (this.voiceActive) return [];
    if (this.presenterQueue.length > 0) return [];
    return this.toastEligible.slice(0, MAX_VISIBLE_TOASTS);
  }

  /** Count shown in the "+N queued" pill. While voice is active every eligible
   *  toast is held, so report the full count, not just the over-cap overflow. */
  private get queuedCount(): number {
    const all = this.events.filter(
      (e) =>
        e.state === "pending" &&
        this.effectiveTier(e) === "FYI" &&
        e.media?.kind !== "project-kanban" &&
        !this.isDowngradedToLater(e) &&
        this.isLive(e),
    );
    return Math.max(0, all.length - MAX_VISIBLE_TOASTS);
  }

  /** Quiet-hours casualty: a NOTABLE/CRITICAL (or media-rich) pop downgraded to
   *  FYI/AMBIENT. We don't hard-block it — it lands in the muted "later" stack. */
  private isDowngradedToLater(e: PopupEvent): boolean {
    // Surfaced (pinned) events are never held in the later stack — the user
    // pulled them back out of it. This also survives the server's
    // `proactive.updated` echo, which keeps `pinned` but restores appliedTier.
    if (e.pinned) return false;
    const downgraded = e.requestedTier !== e.appliedTier;
    if (!downgraded) return false;
    const wasInterrupt = e.requestedTier === "NOTABLE" || e.requestedTier === "CRITICAL";
    const nowQuiet = e.appliedTier === "FYI" || e.appliedTier === "AMBIENT";
    return (wasInterrupt || !!e.media) && nowQuiet;
  }

  private get laterStack(): PopupEvent[] {
    // Hold the muted later-stack too while voice is live — it re-appears on hangup.
    if (this.voiceActive) return [];
    return this.events
      .filter(
        (e) =>
          e.state === "pending" &&
          e.media?.kind !== "project-kanban" &&
          this.isDowngradedToLater(e) &&
          !this.laterCleared.has(e.id) &&
          this.isLive(e),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  // ── actions (optimistic + revert) ────────────────────────────────────────────
  private async handleAction(ev: PopupEvent, action: PopupAction): Promise<void> {
    // Synthetic "pin" from the toast questionnaire.
    if (action.payload?.__pin) {
      await this.pinEvent(ev);
      return;
    }
    const prev = this.events.find((e) => e.id === ev.id);
    const isDismiss = action.kind === "dismiss";
    const isSnooze = action.kind === "snooze";
    if (isDismiss) {
      this.liveIds.delete(ev.id);
      this.laterCleared.add(ev.id);
    }
    const optimisticState: PopupState =
      isSnooze ? "snoozed" : isDismiss ? "dismissed" : "acted";
    // open/readmore/reply + the completion build/commit actions don't terminate
    // the event — the user may still want the other forward action afterward.
    const nonTerminating =
      action.kind === "open" ||
      action.kind === "readmore" ||
      action.kind === "reply" ||
      action.kind === "build" ||
      action.kind === "commitpush";
    if (!nonTerminating) {
      this.mergeEvent({ ...ev, state: optimisticState, ackAction: action.id });
    }
    // Mark as locally dismissed AFTER the optimistic merge so mergeEvent isn't
    // blocked by its own guard. This still prevents the WS echo from re-surfacing.
    if (isDismiss) {
      this.locallyDismissed.add(ev.id);
      // Broadcast to other windows on the same machine (faster than WS roundtrip).
      try { this._bc?.postMessage({ type: "dismiss", id: ev.id }); } catch { /* ignore */ }
    }
    if (isSnooze) {
      this.liveIds.delete(ev.id);
      try { this._bc?.postMessage({ type: "snooze", id: ev.id }); } catch { /* ignore */ }
    }
    this.error = null;
    try {
      await this.runAction(ev, action);
    } catch (e) {
      // Closing is a local UX guarantee. Never resurrect an overlay merely
      // because its best-effort server acknowledgement failed.
      if (!isDismiss && prev) this.mergeEvent(prev);
      if (isDismiss) {
        console.warn("[proactive-overlay] dismiss sync failed; kept closed locally", e);
      } else {
        this.error = `${action.label} failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  }

  /** Handle dismiss/snooze messages from other windows on the same machine. */
  private _onBcMessage(e: MessageEvent): void {
    const d = e.data as { type?: string; id?: string } | null;
    if (!d?.id) return;
    const id = d.id;
    if (d.type === "dismiss") {
      this.liveIds.delete(id);
      this.laterCleared.add(id);
      this.timerExpired.add(id);
      // Directly update events — can't use mergeEvent since locallyDismissed guard
      // would block it if this window also had the event. Use index splice instead.
      const idx = this.events.findIndex((x) => x.id === id);
      if (idx >= 0) {
        const next = this.events.slice();
        next[idx] = { ...next[idx], state: "dismissed" };
        this.events = next;
      }
    } else if (d.type === "snooze") {
      this.liveIds.delete(id);
      const idx = this.events.findIndex((x) => x.id === id);
      if (idx >= 0) {
        const next = this.events.slice();
        next[idx] = { ...next[idx], state: "snoozed" };
        this.events = next;
      }
    }
  }

  /** "Surface" / pin: bring an event back to the floating layer — not just flip a
   *  flag. A later-stack (quiet-hours-downgraded) or otherwise non-live event has
   *  to be (a) marked live (liveIds + pinned), (b) revived to `pending` if the
   *  user had dismissed/snoozed it, and (c) cleared from the later-stack
   *  bookkeeping. `pinned` then drives effectiveTier() so the surface filters
   *  route it back to a toast (NOTABLE) or modal (CRITICAL). Previously this only
   *  set `pinned: true`, which the surface filters still excluded — so the
   *  Surface button looked dead. */
  private async pinEvent(ev: PopupEvent): Promise<void> {
    this.locallyDismissed.delete(ev.id);
    this.liveIds.add(ev.id);
    this.laterCleared.delete(ev.id);
    this.mergeEvent({ ...ev, pinned: true, state: "pending" });
    try {
      await this.client?.request("proactive.pin", { id: ev.id });
    } catch (e) {
      this.liveIds.delete(ev.id);
      this.mergeEvent({ ...ev, pinned: false });
      this.error = `Pin failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private async runAction(ev: PopupEvent, action: PopupAction): Promise<void> {
    const client = this.client;
    if (!client) throw new Error("not connected");
    const p = action.payload ?? {};
    switch (action.kind) {
      case "snooze": {
        await client.request("proactive.snooze", { id: ev.id, duration: (p.duration as string) || "1h" });
        return;
      }
      case "dismiss": {
        const reason = (p.reason as string) || "dismissed";
        await client.request("proactive.dismiss", { id: ev.id, reason });
        return;
      }
      case "complete": {
        const cardId = (p.cardId as string) || ev.attribution.cardId;
        if (cardId)
          await client.request("kanban.tasks.update", {
            id: cardId,
            patch: { status: "done", done: true },
          });
        await client.request("proactive.ack", { id: ev.id, action: action.id });
        return;
      }
      case "spawn": {
        const task = (p.task as string) || ev.body || ev.title;
        await client.request("sessions.spawn", {
          task,
          agentId: (p.agentId as string) || "coder",
          label: ev.title.slice(0, 60),
        });
        await client.request("proactive.ack", { id: ev.id, action: action.id });
        return;
      }
      case "open": {
        const target = (p.target as string) || (p.href as string);
        if (target) window.location.hash = target.startsWith("#") ? target : `#/${target}`;
        await client.request("proactive.ack", { id: ev.id, action: action.id });
        return;
      }
      case "build": {
        // Runs `pnpm -C ui build` server-side, then refreshes the BUILT chip.
        const res = (await client.request("proactive.buildInto", {
          id: ev.id,
          workdir: p.workdir,
          paths: p.paths,
        })) as { buildStatus?: "built" | "unbuilt" };
        this.patchCompletionStatus(ev, { buildStatus: res?.buildStatus ?? "built" }, action.id);
        // Non-terminating: do NOT ack — keep the card so Commit & Push stays reachable.
        return;
      }
      case "commitpush": {
        const res = (await client.request("proactive.commitPush", {
          id: ev.id,
          workdir: p.workdir,
          paths: p.paths,
          message: p.message as string | undefined,
          push: p.push !== false,
        })) as { commitStatus?: "committed" | "uncommitted"; pushed?: boolean; pushError?: string };
        this.patchCompletionStatus(
          ev,
          { commitStatus: res?.commitStatus ?? "committed", pushed: !!res?.pushed },
          action.id,
        );
        if (res?.pushError) this.error = `Committed, but push failed: ${res.pushError}`;
        return;
      }
      default: {
        await client.request("proactive.ack", { id: ev.id, action: action.id });
      }
    }
  }

  /**
   * Patch the completion overlay's status chips in place after a Build /
   * Commit & Push action succeeds, and drop the just-run action button so it
   * can't fire twice. Only touches agent-summary media events.
   */
  private patchCompletionStatus(
    ev: PopupEvent,
    patch: { buildStatus?: "built" | "unbuilt"; commitStatus?: "committed" | "uncommitted"; pushed?: boolean },
    ranActionId?: string,
  ): void {
    const cur = this.events.find((e) => e.id === ev.id) ?? ev;
    if (cur.media?.kind !== "agent-summary") return;
    const media = {
      ...cur.media,
      payload: { ...cur.media.payload, ...patch },
    } as PopupEvent["media"];
    const actions = ranActionId ? cur.actions.filter((a) => a.id !== ranActionId) : cur.actions;
    this.mergeEvent({ ...cur, media, actions });
  }

  private showWhy(ev: PopupEvent): void {
    const a = ev.attribution;
    const bits = [`raised by ${a.agentName || a.agentId}`];
    if (ev.requestedTier !== ev.appliedTier)
      bits.push(`requested ${ev.requestedTier} → applied ${ev.appliedTier} (quiet hours / cooldown)`);
    if (a.cardId) bits.push(`card ${a.cardId}`);
    window.alert(bits.join(" · "));
  }

  // ── render ───────────────────────────────────────────────────────────────────
  render() {
    const queued = this.queuedCount;
    return html`
      ${this.error ? html`<div class="oh-err">${this.error}</div>` : nothing}
      <proactive-toast
        .events=${this.visibleToasts}
        @popup-action=${(e: CustomEvent) => this.handleAction(e.detail.event, e.detail.action)}
        @popup-why=${(e: CustomEvent) => this.showWhy(e.detail.event)}
        @popup-expire=${(e: CustomEvent<{ id: string }>) => {
          // Timer-expired: card slid back to feed. Record it so it doesn't
          // re-float as a toast this session (guard against WS reconnect replay).
          this.timerExpired.add(e.detail.id);
          this.requestUpdate();
        }}
      ></proactive-toast>
      ${queued > 0
        ? html`<div class="oh-queued">
            ${this.voiceActive ? `${queued} held · voice` : `+${queued} queued`}
          </div>`
        : nothing}
      ${this.renderLaterStack()}
      <proactive-modal
        .event=${this.pendingCritical}
        @popup-action=${(e: CustomEvent) => this.handleAction(e.detail.event, e.detail.action)}
        @popup-why=${(e: CustomEvent) => this.showWhy(e.detail.event)}
      ></proactive-modal>
      ${this.pendingWalkthrough && this.pendingWalkthrough.media?.kind === "walkthrough"
        ? html`<walkthrough-overlay
            .payload=${this.pendingWalkthrough.media.payload}
            .eventId=${this.pendingWalkthrough.id}
          ></walkthrough-overlay>`
        : nothing}
      ${this.pendingCanvasWalkthrough?.media &&
      "payload" in this.pendingCanvasWalkthrough.media &&
      isCanvasWalkthroughKind(this.pendingCanvasWalkthrough.media.kind)
        ? html`<infinite-canvas-walkthrough-overlay
            .payload=${this.pendingCanvasWalkthrough.media.payload}
            .eventId=${this.pendingCanvasWalkthrough.id}
          ></infinite-canvas-walkthrough-overlay>`
        : nothing}
      ${this.pendingDriftKanban && this.pendingDriftKanban.media?.kind === "project-kanban"
        ? html`<embedded-kanban-overlay
            .payload=${this.pendingDriftKanban.media.payload}
            .eventId=${this.pendingDriftKanban.id}
            @popup-action=${(e: CustomEvent) => {
              const ev = this.events.find((x) => x.id === e.detail.eventId);
              if (ev) void this.handleAction(ev, e.detail.action);
            }}
          ></embedded-kanban-overlay>`
        : nothing}
      ${this.presenterQueue.length
        ? html`<proactive-presenter
            .events=${this.presenterQueue}
            @popup-action=${(e: CustomEvent) => this.handleAction(e.detail.event, e.detail.action)}
          ></proactive-presenter>`
        : nothing}
    `;
  }

  /** Quiet-hours "later" stack — muted glass tiles the user can review (AC8). */
  private renderLaterStack() {
    const later = this.laterStack;
    if (later.length === 0) return nothing;
    return html`
      <div class="oh-later">
        <button class="oh-later-head" @click=${() => (this.laterCollapsed = !this.laterCollapsed)}>
          <span class="oh-later-dot"></span>
          ${later.length} held during quiet hours
          <span class="oh-later-caret">${this.laterCollapsed ? "▸" : "▾"}</span>
        </button>
        ${this.laterCollapsed
          ? nothing
          : html`<div class="oh-later-list">
              ${later.slice(0, 6).map((ev) => this.renderLaterTile(ev))}
            </div>`}
      </div>
    `;
  }

  private renderLaterTile(ev: PopupEvent) {
    const meta = TIER_META[ev.requestedTier];
    const color = agentColor(ev.attribution.agentId);
    return html`
      <div class="oh-tile" style="--tier:${meta.color}">
        <div class="oh-tile-top">
          <span class="oh-tile-chip" style="--ac:${color}">
            ${ev.attribution.agentName || ev.attribution.agentId}
          </span>
          <span class="oh-tile-dg" title="downgraded by quiet hours"
            >${ev.requestedTier}→${ev.appliedTier}</span
          >
          <button
            class="oh-tile-x"
            aria-label="Clear"
            @click=${() => {
              this.laterCleared.add(ev.id);
              this.requestUpdate();
            }}
          >
            ✕
          </button>
        </div>
        <div class="oh-tile-title">${ev.title}</div>
        ${ev.media
          ? html`<proactive-media .media=${ev.media} .eventId=${ev.id} compact></proactive-media>`
          : nothing}
        <div class="oh-tile-actions">
          <button class="oh-tile-btn" @click=${() => void this.pinEvent(ev)}>Surface</button>
          <button
            class="oh-tile-btn ghost"
            @click=${() =>
              void this.handleAction(ev, {
                id: "dismiss",
                kind: "dismiss",
                label: "Dismiss",
                payload: { reason: "cleared from later stack" },
              })}
          >
            Dismiss
          </button>
        </div>
      </div>
    `;
  }

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 9989;
      pointer-events: none;
    }
    /* <proactive-modal> is ALWAYS mounted (renders nothing until a CRITICAL
       event arrives) and is itself full-viewport (position:fixed; inset:0).
       It manages its own pointer-events internally (none on :host, auto on
       .pm-backdrop/.pm-modal only when shown), so we must exclude it from this
       blanket rule — otherwise the idle modal swallows every click app-wide. */
    :host > *:not(proactive-modal) {
      pointer-events: auto;
    }
    .oh-err {
      position: fixed;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(239, 68, 68, 0.16);
      color: #fca5a5;
      border: 1px solid rgba(239, 68, 68, 0.4);
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 0.76rem;
      z-index: 9995;
    }
    .oh-queued {
      position: fixed;
      top: 14px;
      right: 16px;
      transform: translateY(-26px);
      font-size: 0.64rem;
      font-weight: 700;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.6));
      background: rgba(18, 20, 30, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      padding: 2px 9px;
    }
    .oh-later {
      position: fixed;
      bottom: 16px;
      right: 16px;
      max-width: 360px;
    }
    .oh-later-head {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      background: var(--g-surface, rgba(18, 20, 30, 0.9));
      border: 1px solid var(--g-border, rgba(255, 255, 255, 0.12));
      border-radius: 10px;
      color: var(--g-fg-faint, rgba(245, 234, 205, 0.72));
      font-size: 0.72rem;
      font-weight: 700;
      padding: 7px 12px;
      cursor: pointer;
      backdrop-filter: blur(8px);
    }
    .oh-later-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #64748b;
    }
    .oh-later-caret {
      margin-left: auto;
    }
    .oh-later-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: 8px;
    }
    .oh-tile {
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-left: 3px solid var(--tier, #64748b);
      border-radius: 10px;
      background: rgba(14, 16, 24, 0.7);
      padding: 9px 11px;
      opacity: 0.82;
    }
    .oh-tile:hover {
      opacity: 1;
    }
    .oh-tile-top {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-bottom: 4px;
    }
    .oh-tile-chip {
      font-size: 0.62rem;
      font-weight: 700;
      color: var(--ac, #d4af37);
    }
    .oh-tile-dg {
      font-size: 0.58rem;
      color: rgba(245, 234, 205, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 4px;
      padding: 0 4px;
    }
    .oh-tile-x {
      margin-left: auto;
      background: none;
      border: none;
      color: rgba(245, 234, 205, 0.45);
      cursor: pointer;
      font-size: 0.7rem;
    }
    .oh-tile-title {
      font-size: 0.8rem;
      font-weight: 700;
      color: var(--g-fg, #f5eacd);
    }
    .oh-tile-actions {
      display: flex;
      gap: 6px;
      margin-top: 7px;
    }
    .oh-tile-btn {
      background: rgba(255, 255, 255, 0.07);
      border: 1px solid rgba(255, 255, 255, 0.13);
      color: var(--g-fg, #f5eacd);
      border-radius: 6px;
      padding: 3px 9px;
      font-size: 0.7rem;
      font-weight: 700;
      cursor: pointer;
    }
    .oh-tile-btn.ghost {
      background: none;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "proactive-overlay-host": ProactiveOverlayHost;
  }
}

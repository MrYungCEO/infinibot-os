/**
 * <proactive-panel> — Proactive Overhaul v2 surface (web).
 *
 * Renders the v2 commitment + drift system on top of the live discipline
 * ("Focus") page. Self-contained: fetches `proactive.state` and drives every
 * mutation through the `proactive.*` gateway RPCs. No external state.
 *
 *   1. "Where was I?" re-entry anchor (idle + while-away + resume)
 *   2. Active commitment Now-bar (timer + drift ribbon + break/complete)
 *      — or the commit flow (top-3 candidates + reject→custom)
 *   3. In-progress projects (draggable card; per-task Done/Dispatch/Open)
 *
 * Visual language matches the dashboard glass cards: deep panel bg, gold
 * accent, soft borders. Theme tokens (var(--g-*)) so palette swaps reskin it.
 */

import { LitElement, html, css, nothing, unsafeCSS, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";
import { icons } from "../icons";
import {
  makeDraggableOverlay,
  draggableOverlayStyles,
  type DraggableOverlayHandle,
} from "../lib/draggable-overlay";
import { pathForTab } from "../navigation";
import "./proactive-popups.js";

interface ProjectFocusRow {
  projectId: string;
  name: string;
  state: "active" | "watch" | "drifting" | "cold";
  driftScore: number;
  daysSinceActivity: number;
  progress: number;
  agentsOnIt: number;
  topBlocker: string | null;
  inRotation: boolean;
}
interface CommitCandidate {
  taskId: string;
  projectId: string | null;
  title: string;
  projectName: string | null;
  reason: string;
  score: number;
  priorityTag: string | null;
  dueLabel: string;
}
// Lightweight shape of a kanban task as returned by `kanban.tasks.list`.
// (priority can be low|normal|medium|high|critical depending on the source row.)
interface KanbanTaskLite {
  id: string;
  projectId: string;
  title: string;
  status: "backlog" | "todo" | "in_progress" | "review" | "done";
  priority?: "low" | "normal" | "medium" | "high" | "critical";
  tags?: string[];
  updatedAt?: number;
}
interface ActiveCommitment {
  taskId: string | null;
  projectId: string | null;
  title: string;
  startedAt: number;
  durationMin: number;
  endsAt: number;
  elapsedMin: number;
  remainingMin: number;
  driftLevel: "ontrack" | "soft-drift" | "hard-drift";
}
interface WhereWasIAnchor {
  lastCommittedTitle: string | null;
  idleMin: number;
  whileAway: string;
  mostImportantChange: string | null;
  canResume: boolean;
}
interface ProactiveState {
  generatedAt: number;
  maxFocus: number;
  driftDays: number;
  focused: ProjectFocusRow[];
  extras: ProjectFocusRow[];
  driftRadar: ProjectFocusRow[];
  candidates: CommitCandidate[];
  active: ActiveCommitment | null;
  whereWasI: WhereWasIAnchor;
  summary: {
    focusedCount: number;
    extrasCount: number;
    driftingCount: number;
    coldCount: number;
    openTasks: number;
    p0Tasks: number;
    overdue: number;
  };
}

// ── Auto-focus (DRIFT RADAR auto-add) ────────────────────────────────────────
// Projects that are *in progress* are auto-added to the focus rotation. Because
// the gateway can't be restarted to ship a server-side reconciler, the loop runs
// client-side and drives the SAME manual RPCs (`proactive.project.promote` to
// add, `proactive.focus.set` to evict). The "this entry was auto-added" bit is
// the one thing the server doesn't model, so we persist it locally per project.
const AUTOFOCUS_KEY = "infinibot-proactive-autofocus";
const DAY_MS = 86_400_000;
// Kanban project statuses that mean "actively being worked".
const ACTIVE_PROJECT_STATUSES = new Set(["In progress", "Updating", "Reviewing"]);

interface AutoFocusEntry {
  /** When the auto-add happened. */
  addedAt: number;
  /** Last time this project was observed in_progress (drives the 24h stale clock). */
  lastInProgressAt: number;
}
type AutoFocusMap = Record<string, AutoFocusEntry>;

function loadAutoFocus(): AutoFocusMap {
  try {
    const raw = localStorage.getItem(AUTOFOCUS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as AutoFocusMap) : {};
  } catch {
    return {};
  }
}
function saveAutoFocus(m: AutoFocusMap): void {
  try {
    localStorage.setItem(AUTOFOCUS_KEY, JSON.stringify(m));
  } catch {
    /* storage disabled — auto entries simply won't survive a reload */
  }
}

// Projects the user explicitly parked from this panel. The server marks them
// cold, but the proactive.state payload doesn't enumerate cold ids — so we keep
// a local set to make sure the auto-adder never re-adds a project the user just
// parked, even while it's still technically in_progress.
const PARKED_KEY = "infinibot-proactive-userparked";
function loadParked(): Set<string> {
  try {
    const raw = localStorage.getItem(PARKED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function saveParked(s: Set<string>): void {
  try {
    localStorage.setItem(PARKED_KEY, JSON.stringify([...s]));
  } catch {
    /* storage disabled */
  }
}

// Tasks the user explicitly rejected from the Commit panel (taskId → reason).
// The kanban has no per-task "cancelled" status — `backlog` round-trips to the
// Notion "Not started" bucket which reads back as `todo` (still actionable) — so
// like PARKED_KEY/PHANTOM_KEY we persist the dismissal locally to keep a rejected
// task hidden across reloads. The kanban row is also moved to backlog as a soft,
// fully reversible signal (never a destructive delete/reset).
const REJECTED_TASKS_KEY = "infinibot-proactive-rejected-tasks";
function loadRejectedTasks(): Record<string, string> {
  try {
    const raw = localStorage.getItem(REJECTED_TASKS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function saveRejectedTasks(m: Record<string, string>): void {
  try {
    localStorage.setItem(REJECTED_TASKS_KEY, JSON.stringify(m));
  } catch {
    /* storage disabled */
  }
}

// "Phantom" projects: ids that exist in the kanban project list (Notion-backed)
// but NOT in the local store the focus *engine* reads — so adding them to the
// rotation wastes a slot the UI can never render. We learn these by observing
// that an auto-added id didn't come back as a rendered rotation row, then
// blocklist it so it's never auto-added again.
const PHANTOM_KEY = "infinibot-proactive-phantoms";
function loadPhantoms(): Set<string> {
  try {
    const raw = localStorage.getItem(PHANTOM_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}
function savePhantoms(s: Set<string>): void {
  try {
    localStorage.setItem(PHANTOM_KEY, JSON.stringify([...s]));
  } catch {
    /* storage disabled */
  }
}

@customElement("proactive-panel")
export class ProactivePanel extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;

  @state() private data: ProactiveState | null = null;
  @state() private loading = false;
  @state() private busy = false;
  @state() private pickDuration: Record<string, number> = {};
  @state() private customTitle = "";
  @state() private breakReason = "";
  @state() private showBreak = false;
  @state() private showCustom = false;
  // Transient error toast (e.g. a failed kanban mutation). Cleared on next action.
  @state() private errorMsg = "";
  // ── Quiet-hours settings (proactive.settings.get/set) ───────────────────────
  // Mirrors the gateway ProactivePopupSettings.quietHours shape. Defaults OFF to
  // match the backend default; the real value is pulled on connect.
  @state() private quietHours: { enabled: boolean; start: string; end: string } = {
    enabled: false,
    start: "22:00",
    end: "08:00",
  };
  @state() private settingsBusy = false;
  // Projects this panel auto-added to focus (projectId → entry). Source='auto'.
  @state() private autoFocus: AutoFocusMap = loadAutoFocus();
  // ── Project→task hierarchy state (COMMIT TO ONE THING) ──────────────────────
  // Which project rows are expanded into their task sub-view.
  @state() private expanded: Record<string, boolean> = {};
  // Per-project actionable tasks, fetched lazily on expand (kanban.tasks.list).
  @state() private tasksByProject: Record<string, KanbanTaskLite[]> = {};
  // Per-project task-fetch in-flight flag.
  @state() private tasksLoading: Record<string, boolean> = {};
  // Tasks optimistically marked done via Finish (hidden until the next list pull).
  @state() private completedTasks: Record<string, boolean> = {};
  // Tasks rejected/dismissed. Persisted in localStorage (the kanban can't model a
  // per-task cancel), so a rejected task stays hidden across reloads. Value = reason.
  @state() private rejectedTasks: Record<string, string> = loadRejectedTasks();
  // The task whose inline "reason" reject input is open (taskId), + its draft.
  @state() private rejectingTask: string | null = null;
  @state() private rejectReason = "";
  // Tasks whose duration-pill "Schedule…" picker is expanded (taskId → open).
  @state() private scheduleOpen: Record<string, boolean> = {};
  // One-time auto-expand of the first focus project so the panel isn't all collapsed.
  private autoExpandedOnce = false;
  // Re-entrancy guard so a reconcile-driven refresh can't recurse into reconcile.
  private reconciling = false;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  // Throttle: the projects list is server-cached ~30s, so don't re-scan faster.
  private lastReconcileAt = 0;

  // ── In-progress card direct-action state ────────────────────────────────────
  // Tasks optimistically flipped to done (hidden until the next radar pull).
  @state() private doneTasks: Record<string, boolean> = {};
  // taskId whose inline agent picker is open (only one at a time).
  @state() private dispatchOpenFor: string | null = null;
  // Per-task in-flight flag for done/dispatch actions.
  @state() private dispatchBusy: Record<string, boolean> = {};
  // taskId → spawned session key / status, for the "dispatched" pill.
  @state() private dispatchedTasks: Record<string, string> = {};
  // Drag/resize handle + observer + the live `kanban:*` subscription unsub.
  private cardDrag: DraggableOverlayHandle | null = null;
  private cardResizeObs: ResizeObserver | null = null;
  private kanbanUnsub: (() => void) | null = null;
  private cardWired = false;

  private timer: ReturnType<typeof setInterval> | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    // The draggable in-progress project card was removed from the dashboard.
    // Clear its persisted fixed-position geometry so legacy state cannot pin a
    // stale overlay over the page after an upgrade.
    try {
      localStorage.removeItem(CARD_LAYOUT_KEY);
    } catch {
      /* storage disabled */
    }
    // (a) on app start: pull state, then auto-add any in-progress projects.
    void this.refresh();
    void this.loadProactiveSettings();
    // Re-tick the timer/remaining display every 30s; the server anchors drift.
    this.timer = setInterval(() => {
      if (this.data?.active) this.requestUpdate();
    }, 30_000);
    // (c) on a 60s interval: keep the focus list reconciled with in_progress work.
    this.reconcileTimer = setInterval(() => void this.reconcileAutoFocus(), 60_000);
    // (d) live kanban updates → refresh the in-progress card immediately.
    this.subscribeKanban();
  }
  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    this.cardDrag?.destroy();
    this.cardDrag = null;
    this.cardResizeObs?.disconnect();
    this.cardResizeObs = null;
    this.kanbanUnsub?.();
    this.kanbanUnsub = null;
    this.cardWired = false;
  }
  protected updated(changed: PropertyValues): void {
    if (changed.has("client") && this.client) {
      void this.refresh();
      void this.loadProactiveSettings();
      this.subscribeKanban();
    }
    // Wire drag/resize once the card element exists in the shadow DOM.
    this.wireCardLayout();
  }

  // Subscribe to `kanban:*` gateway events; any kanban change forces a fresh
  // radar pull so the in-progress card stays live. Idempotent per client.
  private subscribeKanban(): void {
    if (!this.client || this.kanbanUnsub) return;
    this.kanbanUnsub = this.client.subscribe((evt) => {
      const name = (evt.event ?? (evt as { type?: string }).type) || "";
      if (typeof name === "string" && name.startsWith("kanban:")) {
        // A done/dispatch may have changed status elsewhere — bust the throttle.
        this.radarLoadedAt = 0;
        void this.loadRadar();
      }
    });
  }

  // ── In-progress card drag + resize + layout persistence ─────────────────────
  // Uses the shared makeDraggableOverlay() for the pointer drag (handle = header
  // strip), and a ResizeObserver for CSS `resize`. Both funnel into the single
  // `drift-radar.replacement.layout` localStorage key.
  private wireCardLayout(): void {
    if (this.cardWired) {
      this.cardDrag?.refresh();
      return;
    }
    const card = this.renderRoot?.querySelector?.(".pp-inprogress") as HTMLElement | null;
    const handle = this.renderRoot?.querySelector?.(".pp-ip-header") as HTMLElement | null;
    if (!card || !handle) return; // card not rendered yet (no data) — retry next update
    this.cardWired = true;
    this.applyCardLayout(card);
    this.cardDrag = makeDraggableOverlay(card, "drift-radar-replacement", {
      handle,
      persistSize: true,
      onChange: () => this.persistCardLayout(card),
    });
    this.cardResizeObs = new ResizeObserver(() => this.persistCardLayout(card));
    this.cardResizeObs.observe(card);
  }

  // Apply a saved layout (fixed position + box size) on mount, clamped into view.
  private applyCardLayout(card: HTMLElement): void {
    const l = loadCardLayout();
    if (!l.width && !l.height && !l.left && !l.top) return; // never moved → CSS default
    if (l.width) card.style.width = `${l.width}px`;
    if (l.height) card.style.height = `${l.height}px`;
    if (l.left || l.top) {
      const w = l.width || card.offsetWidth || 320;
      const h = l.height || card.offsetHeight || 220;
      const m = 8;
      const x = Math.min(Math.max(m, l.left), Math.max(m, window.innerWidth - w - m));
      const y = Math.min(Math.max(m, l.top), Math.max(m, window.innerHeight - h - m));
      card.style.position = "fixed";
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
      card.style.right = "auto";
      card.style.bottom = "auto";
      card.style.transform = "none";
    }
  }

  // Persist the card's current geometry into the spec'd key (drag end / resize).
  private persistCardLayout(card: HTMLElement): void {
    const fixed = getComputedStyle(card).position === "fixed";
    const r = card.getBoundingClientRect();
    saveCardLayout({
      left: fixed ? Math.round(r.left) : 0,
      top: fixed ? Math.round(r.top) : 0,
      width: Math.round(r.width),
      height: Math.round(r.height),
    });
  }

  // Reset → clear persisted layout and snap the card back to its CSS default.
  private resetCardLayout(): void {
    this.cardDrag?.reset();
    try {
      localStorage.removeItem(CARD_LAYOUT_KEY);
    } catch {
      /* storage disabled */
    }
    const card = this.renderRoot?.querySelector?.(".pp-inprogress") as HTMLElement | null;
    if (card) {
      for (const p of ["position", "left", "top", "right", "bottom", "transform", "width", "height"]) {
        card.style.removeProperty(p);
      }
    }
  }

  // ── Quiet-hours settings ────────────────────────────────────────────────────
  private async loadProactiveSettings(): Promise<void> {
    if (!this.client) return;
    try {
      const res = (await this.client.request("proactive.settings.get", {})) as {
        settings?: { quietHours?: { enabled?: boolean; start?: string; end?: string } };
      };
      const qh = res?.settings?.quietHours;
      if (qh) {
        this.quietHours = {
          enabled: !!qh.enabled,
          start: qh.start || "22:00",
          end: qh.end || "08:00",
        };
      }
    } catch (e) {
      console.error("[proactive] settings.get failed:", e);
    }
  }

  // Persist a quiet-hours patch via proactive.settings.set. Optimistic; reverts
  // the local copy if the gateway rejects the write.
  private async saveQuietHours(
    patch: Partial<{ enabled: boolean; start: string; end: string }>,
  ): Promise<void> {
    if (!this.client) return;
    const prev = this.quietHours;
    const next = { ...prev, ...patch };
    this.quietHours = next;
    this.settingsBusy = true;
    this.errorMsg = "";
    try {
      await this.client.request("proactive.settings.set", { quietHours: next });
    } catch (e) {
      console.error("[proactive] settings.set failed:", e);
      this.quietHours = prev;
      this.errorMsg = "Couldn't save quiet-hours setting.";
    } finally {
      this.settingsBusy = false;
    }
  }

  private async call(method: string, params: Record<string, unknown> = {}): Promise<void> {
    if (!this.client) return;
    // Track explicit park / promote so the auto-adder respects manual intent:
    // park → remember as user-parked (don't auto-re-add); promote → forget it.
    const pid = typeof params.projectId === "string" ? params.projectId : null;
    if (pid) {
      const parked = loadParked();
      if (method === "proactive.project.park") parked.add(pid);
      else if (method === "proactive.project.promote") parked.delete(pid);
      saveParked(parked);
    }
    this.busy = true;
    try {
      const res = (await this.client.request(method, params)) as any;
      // commit/break/complete/resume/park/promote all return fresh ProactiveState.
      if (res && typeof res === "object" && "whereWasI" in res) {
        this.data = res as ProactiveState;
      } else {
        await this.refresh();
      }
    } catch (e) {
      console.error(`[proactive] ${method} failed:`, e);
    } finally {
      this.busy = false;
      this.showBreak = false;
      this.showCustom = false;
      this.breakReason = "";
      this.customTitle = "";
    }
  }

  private async refresh(reconcile = true): Promise<void> {
    if (!this.client) return;
    this.loading = this.data == null;
    try {
      const res = (await this.client.request("proactive.state", { touch: true })) as any;
      if (res && typeof res === "object" && "whereWasI" in res) {
        this.data = res as ProactiveState;
        // One-time: expand the first focus project so the commit panel opens with
        // a task sub-view in view rather than all rows collapsed.
        if (!this.autoExpandedOnce && !this.data.active) {
          const first = this.focusProjects(this.data)[0];
          if (first) {
            this.autoExpandedOnce = true;
            this.expanded = { ...this.expanded, [first.projectId]: true };
            void this.loadProjectTasks(first.projectId);
          }
        }
      }
    } catch (e) {
      console.error("[proactive] state failed:", e);
    } finally {
      this.loading = false;
    }
    // (b) whenever fresh state arrives, reconcile the focus list. The flag avoids
    // recursing when the reconcile itself re-pulls state after a mutation.
    if (reconcile && this.data) void this.reconcileAutoFocus();
  }

  // ── DRIFT RADAR auto-add ────────────────────────────────────────────────────
  // Auto-add every in-progress project to the focus list, idempotently, up to the
  // declared MAX (maxFocus). Manual focus is preferred (never auto-evicted); auto
  // entries are evicted only once they go stale (no in_progress activity >24h).
  // Drives the existing manual RPCs so there's no new gateway surface to restart.
  private async reconcileAutoFocus(): Promise<void> {
    const d = this.data;
    if (!this.client || this.reconciling || !d) return;
    const now = Date.now();
    if (now - this.lastReconcileAt < 25_000) return; // throttle heavy project scans
    this.reconciling = true;
    this.lastReconcileAt = now;
    try {

      // Authoritative kanban status + project-level activity timestamp. Degrades
      // gracefully to the proactive.state signals if the list call fails.
      let projects: Array<{ id: string; status?: string; updatedAt?: number }> = [];
      try {
        const res = (await this.client.request("kanban.projects.list", {})) as any;
        const arr = Array.isArray(res) ? res : Array.isArray(res?.projects) ? res.projects : [];
        projects = arr;
      } catch (e) {
        console.warn("[drift-radar][auto] kanban.projects.list unavailable, using state signals only");
      }
      const projById = new Map(projects.map((p) => [p.id, p]));

      // Every project the engine surfaced (rotation + extras + radar), for the
      // running-agent / recent-activity signals it already computes.
      const rowById = new Map<string, ProjectFocusRow>();
      for (const r of [...d.focused, ...d.extras, ...d.driftRadar]) rowById.set(r.projectId, r);

      // The full declared rotation = focused (≤cap) + rotation overflow in extras.
      const rotationRows = [...d.focused, ...d.extras.filter((r) => r.inRotation)];
      const rotationIds = rotationRows.map((r) => r.projectId);
      const rotationSet = new Set(rotationIds);

      // in_progress = explicit kanban status OR a running sub-agent/session on it
      // OR commits/task activity in the last 24h.
      const inProgress = (projectId: string): boolean => {
        const p = projById.get(projectId);
        const row = rowById.get(projectId);
        if (p?.status && ACTIVE_PROJECT_STATUSES.has(p.status)) return true;
        if (typeof p?.updatedAt === "number" && now - p.updatedAt < DAY_MS) return true;
        if (row && row.agentsOnIt > 0) return true;
        if (row && row.daysSinceActivity === 0) return true;
        return false;
      };

      const auto: AutoFocusMap = { ...this.autoFocus };
      // Manual focus = rotation entries we never tagged auto. Always kept.
      const manualIds = rotationIds.filter((id) => !auto[id]);
      const desired: string[] = [...manualIds];

      // Keep / evict existing auto entries that are still in rotation.
      for (const id of rotationIds) {
        if (!auto[id]) continue; // manual, already in `desired`
        if (inProgress(id)) {
          auto[id].lastInProgressAt = now;
          desired.push(id);
        } else if (now - auto[id].lastInProgressAt <= DAY_MS) {
          // Off in_progress but within the 24h grace — stays focused (no churn).
          console.debug(`[drift-radar][auto] keep ${id} — off in_progress, within 24h grace`);
          desired.push(id);
        } else {
          console.debug(`[drift-radar][auto] evict ${id} — stale (no in_progress activity >24h)`);
          delete auto[id];
        }
      }
      // Drop stray auto tags for projects that left rotation by other means.
      for (const id of Object.keys(auto)) {
        if (!rotationSet.has(id)) delete auto[id];
      }

      // Add qualifying in_progress projects. Candidate pool is the full kanban
      // project list (in_progress projects have *low* drift, so the engine's
      // drift-ranked `extras` would never surface them). We exclude projects the
      // user explicitly parked so a manual park is respected. Falls back to the
      // engine `extras` rows when the project list call failed. Freshest first.
      const parked = loadParked();
      const phantoms = loadPhantoms();
      type Cand = { id: string; name: string; updatedAt: number };
      const pool: Cand[] = projects.length
        ? projects.map((p) => ({
            id: p.id,
            name: (p as any).name ?? p.id,
            updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : 0,
          }))
        : d.extras.map((r) => ({
            id: r.projectId,
            name: r.name,
            updatedAt: now - r.daysSinceActivity * DAY_MS,
          }));
      const candidates = pool
        .filter(
          (c) =>
            c.id &&
            !rotationSet.has(c.id) &&
            !auto[c.id] &&
            !parked.has(c.id) &&
            !phantoms.has(c.id) &&
            inProgress(c.id),
        )
        .sort((a, b) => b.updatedAt - a.updatedAt);
      console.debug(
        `[drift-radar][auto] scan: pool=${pool.length} candidates=${candidates.length} rotation=${rotationIds.length} maxFocus=${d.maxFocus}`,
      );
      for (const c of candidates) {
        if (desired.length >= d.maxFocus) {
          console.debug(
            `[drift-radar][auto] skip ${c.name} (${c.id}) — capacity ${desired.length}/${d.maxFocus} reached`,
          );
          continue;
        }
        console.debug(`[drift-radar][auto] add ${c.name} (${c.id}) — in_progress → focus`);
        auto[c.id] = { addedAt: now, lastInProgressAt: now };
        desired.push(c.id);
      }

      // Persist the source map regardless (lastInProgressAt clock advances).
      this.autoFocus = auto;
      saveAutoFocus(auto);

      // Only hit the gateway when the rotation actually changed (idempotent).
      const sameRotation =
        desired.length === rotationIds.length && desired.every((id) => rotationSet.has(id));
      if (!sameRotation) {
        await this.client.request("proactive.focus.set", { projectIds: desired });
        // (update the counter immediately) — re-pull without re-reconciling.
        await this.refresh(false);
        // Self-correct: drop any auto-added id the engine couldn't render (it's
        // in the kanban list but not the focus engine's local store), so the
        // slot isn't wasted and the next pass fills it with a real project.
        await this.prunePhantoms(desired);
      } else {
        this.requestUpdate();
      }
    } catch (e) {
      console.error("[drift-radar][auto] reconcile failed:", e);
    } finally {
      this.reconciling = false;
    }
  }

  // After a focus.set, an auto id that didn't return as a rendered rotation row
  // exists only in the kanban list, not the focus engine's project store. Blocklist
  // it (never re-add) and rewrite the rotation without it to free the slot.
  private async prunePhantoms(desired: string[]): Promise<void> {
    const d = this.data;
    if (!this.client || !d) return;
    const rendered = new Set(
      [...d.focused, ...d.extras.filter((r) => r.inRotation), ...d.driftRadar].map((r) => r.projectId),
    );
    const phantoms = loadPhantoms();
    const auto = { ...this.autoFocus };
    const keep: string[] = [];
    let changed = false;
    for (const id of desired) {
      if (auto[id] && !rendered.has(id)) {
        console.debug(`[drift-radar][auto] prune phantom ${id} — absent from focus engine's project store`);
        phantoms.add(id);
        delete auto[id];
        changed = true;
      } else {
        keep.push(id);
      }
    }
    if (!changed) return;
    savePhantoms(phantoms);
    this.autoFocus = auto;
    saveAutoFocus(auto);
    await this.client.request("proactive.focus.set", { projectIds: keep });
    await this.refresh(false);
  }

  // Convert an auto-added entry into manual focus: it stays in the rotation but is
  // no longer tracked as auto, so it won't be evicted when it goes stale.
  private pinAuto(projectId: string): void {
    if (!this.autoFocus[projectId]) return;
    const m = { ...this.autoFocus };
    delete m[projectId];
    this.autoFocus = m;
    saveAutoFocus(m);
    this.requestUpdate();
  }

  private duration(id: string): number {
    return this.pickDuration[id] ?? 45;
  }
  private setDuration(id: string, min: number): void {
    this.pickDuration = { ...this.pickDuration, [id]: min };
  }

  // ── Project→task hierarchy (COMMIT TO ONE THING) ────────────────────────────
  // The top-level rows are the SAME focus-list projects the drift radar shows
  // (canonical kanban projects store via proactive.state), deduped. No parallel
  // random picker — this honors the X/maxFocus focus rotation.
  private focusProjects(d: ProactiveState): ProjectFocusRow[] {
    const seen = new Set<string>();
    const out: ProjectFocusRow[] = [];
    for (const r of [...d.driftRadar, ...d.focused]) {
      if (seen.has(r.projectId)) continue;
      seen.add(r.projectId);
      out.push(r);
    }
    return out;
  }

  // Lazily fetch a project's tasks. kanban.tasks.list is live (no restart) and
  // returns { tasks: [...] }. Cached per project until force-refreshed.
  private async loadProjectTasks(projectId: string, force = false): Promise<void> {
    if (!this.client) return;
    if (!force && this.tasksByProject[projectId]) return;
    this.tasksLoading = { ...this.tasksLoading, [projectId]: true };
    try {
      const res = (await this.client.request("kanban.tasks.list", { projectId })) as any;
      const arr: KanbanTaskLite[] = Array.isArray(res)
        ? res
        : Array.isArray(res?.tasks)
          ? res.tasks
          : [];
      this.tasksByProject = { ...this.tasksByProject, [projectId]: arr };
    } catch (e) {
      console.error("[proactive] kanban.tasks.list failed:", e);
      this.errorMsg = "Couldn't load this project's tasks.";
    } finally {
      this.tasksLoading = { ...this.tasksLoading, [projectId]: false };
    }
  }

  private toggleExpand(projectId: string): void {
    const open = !this.expanded[projectId];
    this.expanded = { ...this.expanded, [projectId]: open };
    if (open) void this.loadProjectTasks(projectId);
  }

  // Actionable = the work the user could commit to right now. Sorted by priority
  // (critical→low) then by drift (oldest updatedAt first). Optimistic done/reject
  // rows are filtered out so the sub-view updates without a refresh.
  private static readonly PRIO_RANK: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    normal: 2,
    low: 3,
  };
  private actionableTasks(projectId: string): KanbanTaskLite[] {
    const all = this.tasksByProject[projectId] ?? [];
    const ACTIONABLE = new Set(["in_progress", "review", "todo"]);
    return all
      .filter(
        (t) =>
          ACTIONABLE.has(t.status) && !this.completedTasks[t.id] && !this.rejectedTasks[t.id],
      )
      .sort((a, b) => {
        const ra = ProactivePanel.PRIO_RANK[a.priority ?? "normal"] ?? 2;
        const rb = ProactivePanel.PRIO_RANK[b.priority ?? "normal"] ?? 2;
        if (ra !== rb) return ra - rb;
        return (a.updatedAt ?? 0) - (b.updatedAt ?? 0); // older = more drift first
      });
  }

  private priorityTag(p?: string): string | null {
    switch (p) {
      case "critical":
        return "P0";
      case "high":
        return "P1";
      case "medium":
      case "normal":
        return "P2";
      case "low":
        return "P3";
      default:
        return null;
    }
  }

  // After an action empties a project's actionable list, auto-cycle: park it so
  // the focus rotation frees the slot and reconcileAutoFocus pulls the next
  // in-progress project into view. Mirrors the "X/maxFocus" cap behaviour.
  private async maybeCycleProject(projectId: string): Promise<void> {
    if (this.actionableTasks(projectId).length > 0) return;
    this.expanded = { ...this.expanded, [projectId]: false };
    await this.call("proactive.project.park", { projectId });
  }

  // Finish a task: flip it to done on the board (same kanban.tasks.update
  // mutation the per-row Finish uses — no duplicate handler), optimistically
  // drop it, then cycle the project if that was its last actionable task.
  private async finishTask(t: KanbanTaskLite): Promise<void> {
    if (!this.client || this.busy) return;
    this.busy = true;
    this.errorMsg = "";
    try {
      await this.client.request("kanban.tasks.update", { id: t.id, patch: { status: "done" } });
      this.completedTasks = { ...this.completedTasks, [t.id]: true };
      await this.maybeCycleProject(t.projectId);
    } catch (e) {
      console.error("[proactive] finishTask failed:", e);
      this.errorMsg = "Couldn't mark that task done. It's still in your list.";
    } finally {
      this.busy = false;
    }
  }

  // Reject a task: dismiss it without data loss. We move it to `backlog` (out of
  // the actionable set) and stamp a `rejected:<reason>` tag — reversible, never a
  // destructive delete/reset. Optimistically hidden; cycles the project if empty.
  private async confirmRejectTask(t: KanbanTaskLite): Promise<void> {
    if (!this.client || this.busy) return;
    const reason = this.rejectReason.trim() || "dismissed from Commit panel";
    this.busy = true;
    this.errorMsg = "";
    try {
      // Persist the dismissal locally first so it survives reloads regardless of
      // how the kanban normalizes the status.
      const rj = { ...this.rejectedTasks, [t.id]: reason };
      this.rejectedTasks = rj;
      saveRejectedTasks(rj);
      // Soft, reversible kanban signal: move out of the active lane + tag reason.
      const tags = [...(t.tags ?? []).filter((x) => !x.startsWith("rejected")), `rejected:${reason}`];
      await this.client.request("kanban.tasks.update", {
        id: t.id,
        patch: { status: "backlog", tags },
      });
      this.rejectingTask = null;
      this.rejectReason = "";
      await this.maybeCycleProject(t.projectId);
    } catch (e) {
      console.error("[proactive] rejectTask failed:", e);
      this.errorMsg = "Couldn't reject that task. It's still in your list.";
    } finally {
      this.busy = false;
    }
  }

  // Commit a single task: kick off the existing commit flow scoped to THAT task.
  private commitTask(t: KanbanTaskLite, durationMin: number): void {
    void this.call("proactive.commit", {
      taskId: t.id,
      projectId: t.projectId,
      title: t.title,
      durationMin,
    });
  }

  // Project-header quick action: Commit the project (commit flow, project-scoped,
  // no single task) at the default duration.
  private commitProject(p: ProjectFocusRow): void {
    void this.call("proactive.commit", {
      projectId: p.projectId,
      title: p.name,
      durationMin: this.duration(`proj:${p.projectId}`),
    });
  }

  // Project-header quick action: Reject the project = reject all its child
  // actionable tasks (backlog + reason), then park the project so it leaves the
  // rotation and the next in-progress project cycles in.
  private async rejectProject(p: ProjectFocusRow): Promise<void> {
    if (!this.client || this.busy) return;
    this.busy = true;
    this.errorMsg = "";
    try {
      await this.loadProjectTasks(p.projectId, true);
      const tasks = this.actionableTasks(p.projectId);
      const rj = { ...this.rejectedTasks };
      for (const t of tasks) {
        rj[t.id] = "project rejected";
        const tags = [
          ...(t.tags ?? []).filter((x) => !x.startsWith("rejected")),
          "rejected:project rejected",
        ];
        try {
          await this.client.request("kanban.tasks.update", {
            id: t.id,
            patch: { status: "backlog", tags },
          });
        } catch (e) {
          console.error("[proactive] rejectProject task failed:", e);
        }
      }
      this.rejectedTasks = rj;
      saveRejectedTasks(rj);
      this.expanded = { ...this.expanded, [p.projectId]: false };
    } finally {
      this.busy = false;
    }
    // park (leaves rotation → reconcile cycles in the next in-progress project).
    await this.call("proactive.project.park", { projectId: p.projectId });
  }

  // ── render ────────────────────────────────────────────────────────────────

  render() {
    const d = this.data;
    if (!d && this.loading) {
      return html`<div class="pp-root pp-loading">Loading focus…</div>`;
    }
    if (!d) return nothing;
    return html`
      <div class="pp-root">
        ${this.renderWhereWasI(d)}
        ${d.active ? this.renderActive(d.active) : this.renderCommitFlow(d)}
        ${this.renderQuietHoursSettings()}
        <!-- Pop-Up System feed + live toast/modal hosts (Stage 2). -->
        <proactive-popups .client=${this.client}></proactive-popups>
      </div>
    `;
  }

  private renderWhereWasI(d: ProactiveState) {
    const w = d.whereWasI;
    // Only worth showing when re-entry actually applies (idle gap or resumable).
    if (!w.canResume && w.idleMin < 10 && !w.mostImportantChange) return nothing;
    return html`
      <div class="pp-anchor">
        <div class="pp-anchor-icon">${icons.arrowLeft}</div>
        <div class="pp-anchor-body">
          <div class="pp-anchor-head">
            Where was I?
            ${w.lastCommittedTitle
              ? html`<span class="pp-anchor-last">Last: “${w.lastCommittedTitle}” · idle ${this.fmtMin(w.idleMin)}</span>`
              : nothing}
          </div>
          <div class="pp-anchor-while">While away: ${w.whileAway}</div>
          ${w.mostImportantChange
            ? html`<div class="pp-anchor-key">${icons.tag} ${w.mostImportantChange}</div>`
            : nothing}
        </div>
        ${w.canResume
          ? html`<button class="pp-btn pp-btn-primary" ?disabled=${this.busy}
              @click=${() => this.call("proactive.resume")}>Resume ${icons.play}</button>`
          : nothing}
      </div>
    `;
  }

  private renderActive(a: ActiveCommitment) {
    const drift = a.driftLevel;
    const ribbon =
      drift === "hard-drift"
        ? html`<div class="pp-ribbon pp-ribbon-hard">Drifted &gt;15m — re-commit or break the block.</div>`
        : drift === "soft-drift"
          ? html`<div class="pp-ribbon pp-ribbon-soft">Still on “${a.title}”? You've drifted a few minutes.</div>`
          : nothing;
    return html`
      <div class="pp-nowbar pp-drift-${drift}">
        ${ribbon}
        <div class="pp-now-row">
          <div class="pp-now-id">
            <span class="pp-now-eyebrow">Committed · locked</span>
            <span class="pp-now-title">${a.title}</span>
          </div>
          <div class="pp-now-timer">
            <span class="pp-now-remaining">${a.remainingMin}m</span>
            <span class="pp-now-of">left of ${a.durationMin}m</span>
          </div>
        </div>
        <div class="pp-now-progress">
          <div class="pp-now-progress-fill"
            style="width:${Math.min(100, Math.round((a.elapsedMin / Math.max(1, a.durationMin)) * 100))}%"></div>
        </div>
        ${this.showBreak
          ? html`
              <div class="pp-break">
                <input class="pp-input" placeholder="Why are you switching? (1 sentence)"
                  .value=${this.breakReason}
                  @input=${(e: Event) => (this.breakReason = (e.target as HTMLInputElement).value)} />
                <button class="pp-btn" ?disabled=${this.busy || !this.breakReason.trim()}
                  @click=${() => this.call("proactive.break", { reason: this.breakReason })}>Break it</button>
                <button class="pp-btn pp-btn-ghost" @click=${() => (this.showBreak = false)}>Cancel</button>
              </div>`
          : html`
              <div class="pp-now-actions">
                <button class="pp-btn pp-btn-primary" ?disabled=${this.busy}
                  @click=${() => this.call("proactive.complete", { outcome: "shipped" })}>Shipped ${icons.checkCircle}</button>
                <button class="pp-btn" ?disabled=${this.busy}
                  @click=${() => this.call("proactive.complete", { outcome: "blocked" })}>Blocked</button>
                <button class="pp-btn pp-btn-ghost" @click=${() => (this.showBreak = true)}>Switch (give reason)</button>
              </div>`}
      </div>
    `;
  }

  private renderCommitFlow(d: ProactiveState) {
    const projects = this.focusProjects(d);
    return html`
      <div class="pp-commit">
        <div class="pp-section-head">
          Commit to one thing
          <span class="pp-sub">${d.summary.focusedCount}/${d.maxFocus} focused · expand a project, then commit, finish, or reject a task. No silent default.</span>
        </div>
        ${this.errorMsg ? html`<div class="pp-toast">${this.errorMsg}</div>` : nothing}
        ${projects.length === 0
          ? html`<div class="pp-empty">No in-progress projects to commit to. Promote one from Extras below, or start work to surface it.</div>`
          : html`<div class="pp-projs">${projects.map((p) => this.renderCommitProject(p))}</div>`}
        ${this.showCustom
          ? html`
              <div class="pp-custom">
                <input class="pp-input" placeholder="Name your own commitment…"
                  .value=${this.customTitle}
                  @input=${(e: Event) => (this.customTitle = (e.target as HTMLInputElement).value)} />
                <button class="pp-btn pp-btn-primary" ?disabled=${this.busy || !this.customTitle.trim()}
                  @click=${() => this.call("proactive.commit", { title: this.customTitle, durationMin: this.duration("custom") })}>
                  Commit ${this.duration("custom")}m</button>
                ${this.renderDurationPicker("custom")}
                <button class="pp-btn pp-btn-ghost" @click=${() => (this.showCustom = false)}>Cancel</button>
              </div>`
          : html`<button class="pp-reject" @click=${() => (this.showCustom = true)}>None of these → type your own</button>`}
      </div>
    `;
  }

  // Top-level PROJECT row: state chip + name + project-level quick actions, with
  // an expandable task sub-view underneath.
  private renderCommitProject(p: ProjectFocusRow) {
    const open = !!this.expanded[p.projectId];
    const loading = !!this.tasksLoading[p.projectId];
    const tasks = this.actionableTasks(p.projectId);
    return html`
      <div class="pp-proj pp-state-${p.state}">
        <div class="pp-proj-head" @click=${() => this.toggleExpand(p.projectId)}>
          <span class="pp-caret">${open ? icons.chevronDown : icons.chevronRight}</span>
          <span class="pp-chip pp-chip-${p.state}">${p.state}</span>
          <div class="pp-proj-name" title=${p.name}>${p.name}</div>
          ${open && !loading ? html`<span class="pp-proj-count">${tasks.length} ready</span>` : nothing}
          <div class="pp-proj-actions" @click=${(e: Event) => e.stopPropagation()}>
            <button class="pp-btn pp-btn-primary pp-btn-sm" ?disabled=${this.busy}
              @click=${() => this.commitProject(p)}>Commit project</button>
            <button class="pp-btn pp-btn-ghost pp-btn-sm pp-cand-reject" ?disabled=${this.busy}
              @click=${() => this.rejectProject(p)}>Reject project</button>
          </div>
        </div>
        ${open
          ? html`<div class="pp-proj-tasks">
              ${loading
                ? html`<div class="pp-task-skeletons" aria-label="Loading tasks">
                    <div class="pp-task-skel"></div>
                    <div class="pp-task-skel"></div>
                    <div class="pp-task-skel"></div>
                  </div>`
                : tasks.length === 0
                  ? html`<div class="pp-empty pp-empty-row">No tasks ready to commit</div>`
                  : tasks.map((t) => this.renderTaskRow(t))}
            </div>`
          : nothing}
      </div>
    `;
  }

  // Inner TASK sub-element with per-task forward actions: Finish / Commit
  // (+Schedule…) / Reject.
  private renderTaskRow(t: KanbanTaskLite) {
    const tag = this.priorityTag(t.priority);
    const sched = !!this.scheduleOpen[t.id];
    const rejecting = this.rejectingTask === t.id;
    const idleDays =
      typeof t.updatedAt === "number" && t.updatedAt > 0
        ? Math.max(0, Math.floor((Date.now() - t.updatedAt) / DAY_MS))
        : null;
    return html`
      <div class="pp-task">
        <div class="pp-task-main">
          <div class="pp-task-title">
            ${tag ? html`<span class="pp-tag pp-tag-${tag}">${tag}</span>` : nothing}
            ${t.title}
          </div>
          <div class="pp-task-meta">
            ${t.status.replace("_", " ")}${idleDays !== null ? html` · ${idleDays}d idle` : nothing}
          </div>
        </div>
        ${rejecting
          ? html`<div class="pp-task-reject">
              <input class="pp-input" placeholder="Why reject this? (1 sentence)"
                .value=${this.rejectReason}
                @input=${(e: Event) => (this.rejectReason = (e.target as HTMLInputElement).value)} />
              <button class="pp-btn pp-btn-sm" ?disabled=${this.busy}
                @click=${() => this.confirmRejectTask(t)}>Reject</button>
              <button class="pp-btn pp-btn-ghost pp-btn-sm"
                @click=${() => {
                  this.rejectingTask = null;
                  this.rejectReason = "";
                }}>Cancel</button>
            </div>`
          : html`<div class="pp-task-actions">
              <button class="pp-btn pp-btn-primary pp-btn-sm" ?disabled=${this.busy}
                @click=${() => this.finishTask(t)}>Finish ${icons.checkCircle}</button>
              ${sched
                ? html`${this.renderDurationPicker(t.id)}
                    <button class="pp-btn pp-btn-sm" ?disabled=${this.busy}
                      @click=${() => this.commitTask(t, this.duration(t.id))}>Commit ${this.duration(t.id)}m</button>
                    <button class="pp-link" @click=${() =>
                      (this.scheduleOpen = { ...this.scheduleOpen, [t.id]: false })}>×</button>`
                : html`<button class="pp-btn pp-btn-sm" ?disabled=${this.busy}
                      @click=${() => this.commitTask(t, this.duration(t.id))}>Commit ${this.duration(t.id)}m</button>
                    <button class="pp-link" title="Pick a different duration"
                      @click=${() => (this.scheduleOpen = { ...this.scheduleOpen, [t.id]: true })}>Schedule…</button>`}
              <button class="pp-btn pp-btn-ghost pp-btn-sm pp-cand-reject" ?disabled=${this.busy}
                @click=${() => {
                  this.rejectingTask = t.id;
                  this.rejectReason = "";
                }}>Reject</button>
            </div>`}
      </div>
    `;
  }

  private renderDurationPicker(id: string) {
    const cur = this.duration(id);
    return html`<div class="pp-durs">
      ${[25, 45, 90].map(
        (m) => html`<button
          class="pp-dur ${cur === m ? "active" : ""}"
          @click=${() => this.setDuration(id, m)}>${m}</button>`,
      )}
    </div>`;
  }

  // ── Drift-radar data (BUG-1 fix) ───────────────────────────────────────────
  // Rendered rows come straight from the canonical kanban store (in_progress
  // PROJECTS) + their open tasks, NOT from the proactive engine's focus rows —
  // those depend on a server-side rotation the gateway can't be restarted to
  // populate, which is why the radar previously surfaced stale/empty entries.
  @state() private radarRows: RadarRow[] = [];
  @state() private radarExpanded: Record<string, boolean> = {};
  private radarLoadedAt = 0;
  private radarLoading = false;
  // projectIds we've already raised a "drifting" Signal for (drift-crossing producer).
  private radarDriftSeen = new Set<string>();

  /**
   * Pull in_progress projects + their in_progress/review tasks from kanban and
   * project them into RadarRows. Throttled to ~20s; safe to call from render().
   */
  private async loadRadar(): Promise<void> {
    if (!this.client || this.radarLoading) return;
    const now = Date.now();
    if (this.radarRows.length && now - this.radarLoadedAt < 20_000) return;
    this.radarLoading = true;
    this.radarLoadedAt = now;
    try {
      const [pRes, tRes] = await Promise.all([
        this.client.request("kanban.projects.list", {}),
        this.client.request("kanban.tasks.list", {}),
      ]);
      const projects: any[] = Array.isArray(pRes)
        ? pRes
        : Array.isArray((pRes as any)?.projects)
          ? (pRes as any).projects
          : [];
      const tasks: any[] = Array.isArray(tRes)
        ? tRes
        : Array.isArray((tRes as any)?.tasks)
          ? (tRes as any).tasks
          : [];

      // Group open (in_progress/review) tasks by owning project, tracking the
      // freshest task activity so the drift clock reflects real movement.
      const tasksByProject = new Map<string, RadarTask[]>();
      const lastTaskAt = new Map<string, number>();
      for (const t of tasks) {
        const pid = t?.projectId;
        // "Open" tasks = anything still actionable (todo / in_progress / review).
        if (!pid || (t.status !== "in_progress" && t.status !== "review" && t.status !== "todo"))
          continue;
        const arr = tasksByProject.get(pid) ?? [];
        arr.push({
          id: t.id,
          projectId: pid,
          title: t.title ?? "Untitled",
          description: typeof t.description === "string" ? t.description : "",
          status: t.status,
        });
        tasksByProject.set(pid, arr);
        if (typeof t.updatedAt === "number") {
          lastTaskAt.set(pid, Math.max(lastTaskAt.get(pid) ?? 0, t.updatedAt));
        }
      }

      const driftDays = this.data?.driftDays ?? 3;
      const rows: RadarRow[] = projects
        .filter((p) => p?.status && ACTIVE_PROJECT_STATUSES.has(p.status))
        .map((p) => {
          const lastAt = Math.max(
            typeof p.updatedAt === "number" ? p.updatedAt : 0,
            lastTaskAt.get(p.id) ?? 0,
          );
          const daysSince = lastAt > 0 ? Math.max(0, Math.floor((now - lastAt) / DAY_MS)) : -1;
          const driftScore = daysSince < 0 ? 0 : Math.min(100, daysSince * 14);
          let state: RadarRow["state"] = "active";
          if (daysSince >= 0 && daysSince >= driftDays * 3) state = "cold";
          else if (daysSince >= 0 && daysSince >= driftDays) state = "drifting";
          return {
            projectId: p.id,
            name: p.name ?? "Untitled",
            status: p.status,
            daysSince,
            driftScore,
            state,
            tasks: tasksByProject.get(p.id) ?? [],
          };
        })
        .sort((a, b) => b.driftScore - a.driftScore || a.name.localeCompare(b.name));

      this.radarRows = rows;
      this.emitDriftSignals(rows);
    } catch (e) {
      console.warn("[drift-radar] kanban load failed:", e);
    } finally {
      this.radarLoading = false;
    }
  }

  /**
   * Signals producer #4 — drift threshold crossing. When an in_progress project
   * first enters the "drifting" state, raise a NOTABLE Signal (once per project
   * until it recovers). Restart-free: drives the live `proactive.emit` RPC.
   */
  private emitDriftSignals(rows: RadarRow[]): void {
    if (!this.client) return;
    const now = Date.now();
    // Persistent guard so a drifting project raises at most one Signal per
    // DRIFT_SIGNAL_TTL_MS — across reloads / multiple tabs — instead of
    // re-emitting (and duplicating the row server-side) on every page load.
    let guard: Record<string, number> = {};
    try {
      guard = JSON.parse(localStorage.getItem(DRIFT_SIGNAL_KEY) || "{}") || {};
    } catch {
      guard = {};
    }
    for (const k of Object.keys(guard)) {
      if (now - guard[k] > DRIFT_SIGNAL_TTL_MS) delete guard[k];
    }
    let changed = false;
    for (const r of rows) {
      if (r.state === "drifting") {
        if (this.radarDriftSeen.has(r.projectId)) continue;
        this.radarDriftSeen.add(r.projectId);
        if (guard[r.projectId] && now - guard[r.projectId] < DRIFT_SIGNAL_TTL_MS) continue;
        guard[r.projectId] = now;
        changed = true;
        void this.client
          .request("proactive.emit", {
            tier: "NOTABLE",
            title: `Project drifting: ${r.name}`,
            body: `No progress on "${r.name}" for ${r.daysSince}d — ${r.tasks.length} task(s) still open.`,
            attribution: { agentId: "drift-radar", agentName: "Drift radar" },
            dedupKey: `drift:${r.projectId}`,
            // Actionable, not just informational: the alert carries an
            // interactive board for this project so the operator can push
            // progress (move / add / mark done) directly from the overlay.
            // Mutations persist to the real kanban store.
            media: {
              kind: "project-kanban",
              payload: {
                projectId: r.projectId,
                projectName: r.name,
                title: `${r.name} — drifting ${r.daysSince}d`,
                subtitle:
                  r.tasks.length > 0
                    ? `${r.tasks.length} task(s) open — move a card or add the next step.`
                    : "No open tasks — add the next step to get unstuck.",
              },
            },
            actions: [],
          })
          .catch((e) => {
            // Roll back so a transient failure can retry on a later scan.
            this.radarDriftSeen.delete(r.projectId);
            try {
              const m = JSON.parse(localStorage.getItem(DRIFT_SIGNAL_KEY) || "{}") || {};
              delete m[r.projectId];
              localStorage.setItem(DRIFT_SIGNAL_KEY, JSON.stringify(m));
            } catch {
              /* storage disabled */
            }
            console.warn("[drift-radar] drift signal emit failed:", e);
          });
      } else if (r.state === "active") {
        // Recovered — allow a future crossing to re-signal.
        this.radarDriftSeen.delete(r.projectId);
        if (guard[r.projectId] !== undefined) {
          delete guard[r.projectId];
          changed = true;
        }
      }
    }
    if (changed) {
      try {
        localStorage.setItem(DRIFT_SIGNAL_KEY, JSON.stringify(guard));
      } catch {
        /* storage disabled — guard degrades to in-session only */
      }
    }
  }

  private toggleRadar(id: string): void {
    this.radarExpanded = { ...this.radarExpanded, [id]: !this.radarExpanded[id] };
  }

  // ── In-progress projects card (DRAGGABLE; replaces the old Drift radar) ──────
  // Source = in_progress projects (kanban.projects.list) + their open tasks
  // (kanban.tasks.list), surfaced by loadRadar() and kept live via the
  // `kanban:*` subscription. Each task row is a direct-action element:
  // Done / Dispatch (agent picker → sessions.spawn) / Open (→ /projects).
  private renderInProgressCard(d: ProactiveState) {
    // Kick a throttled (re)load; setting radarRows triggers a re-render.
    void this.loadRadar();
    const rows = this.radarRows;
    const projectCount = rows.length;
    const openTasks = rows.reduce(
      (n, r) => n + r.tasks.filter((t) => !this.doneTasks[t.id]).length,
      0,
    );
    const driftingCount = rows.filter((r) => r.state === "drifting").length;
    return html`
      <div class="pp-inprogress" part="inprogress-card">
        <div class="pp-ip-header" title="Drag to move this card">
          <span class="pp-ip-grip" aria-hidden="true">⠿</span>
          <div class="pp-ip-heading">
            In-progress projects
            <span class="pp-sub"
              >${projectCount} project${projectCount === 1 ? "" : "s"} · ${openTasks} open
              task${openTasks === 1 ? "" : "s"}${driftingCount
                ? html` · <span class="pp-ip-drift">${driftingCount} drifting</span>`
                : nothing}</span
            >
          </div>
          <button
            class="pp-mini pp-ip-reset"
            title="Reset card position & size"
            @click=${() => this.resetCardLayout()}
          >
            reset
          </button>
        </div>
        ${this.errorMsg ? html`<div class="pp-toast">${this.errorMsg}</div>` : nothing}
        <div class="pp-ip-body">
          ${rows.length === 0
            ? html`<div class="pp-empty">No in-progress projects. Move a project to "In
                progress" to track it here.</div>`
            : rows.map((r) => this.renderInProgressRow(r))}
        </div>
      </div>
    `;
  }

  private renderInProgressRow(r: RadarRow) {
    const open = !!this.radarExpanded[r.projectId];
    const tasks = r.tasks.filter((t) => !this.doneTasks[t.id]);
    const n = tasks.length;
    return html`
      <div class="pp-row pp-state-${r.state}">
        <button
          class="pp-expand ${open ? "open" : ""}"
          title=${open ? "Hide tasks" : "Show tasks"}
          aria-expanded=${open ? "true" : "false"}
          @click=${() => this.toggleRadar(r.projectId)}
        >${icons.chevronRight}</button>
        <span class="pp-chip pp-chip-${r.state}">${r.state}</span>
        <div class="pp-row-main" @click=${() => this.toggleRadar(r.projectId)}>
          <div class="pp-row-name">
            ${r.name}
            <span class="pp-taskcount">${n} open task${n === 1 ? "" : "s"}</span>
          </div>
          <div class="pp-row-meta">
            ${r.daysSince >= 0 ? `${r.daysSince}d idle` : "no activity"}
          </div>
        </div>
        <div class="pp-drift-bar"><div class="pp-drift-fill" style="width:${r.driftScore}%"></div></div>
        <button
          class="pp-mini"
          title="Open this project board"
          @click=${() => this.openProjects()}
        >open</button>
      </div>
      ${open ? this.renderInProgressTasks(r, tasks) : nothing}
    `;
  }

  private renderInProgressTasks(r: RadarRow, tasks: RadarTask[]) {
    if (tasks.length === 0) {
      return html`<div class="pp-subtasks pp-subtasks-empty">No open tasks.</div>`;
    }
    return html`
      <div class="pp-subtasks">${tasks.map((t) => this.renderTaskActionRow(t))}</div>
    `;
  }

  // Direct-action task row: Done / Dispatch (agent picker) / Open.
  private renderTaskActionRow(t: RadarTask) {
    const statusLabel =
      t.status === "in_progress" ? "in progress" : t.status === "review" ? "review" : "todo";
    const dispatched = this.dispatchedTasks[t.id];
    const picking = this.dispatchOpenFor === t.id;
    const busy = !!this.dispatchBusy[t.id];
    return html`
      <div class="pp-subtask">
        <span class="pp-tchip pp-tchip-${t.status}">${statusLabel}</span>
        <span class="pp-tname" title="${t.title}">${t.title}</span>
        ${dispatched
          ? html`<span class="pp-dispatched" title="Agent dispatched">${icons.play} dispatched</span>`
          : nothing}
        <div class="pp-task-actions">
          ${picking
            ? html`<div class="pp-dispatch-pick" @click=${(e: Event) => e.stopPropagation()}>
                ${DISPATCH_AGENTS.map(
                  (a) => html`<button
                    class="pp-mini pp-dispatch-agent"
                    ?disabled=${busy}
                    @click=${() => this.dispatchTask(t, a.id)}
                  >${a.name}</button>`,
                )}
                <button class="pp-link" @click=${() => (this.dispatchOpenFor = null)}>${icons.x}</button>
              </div>`
            : html`
                <button
                  class="pp-mini pp-mini-go"
                  title="Mark done"
                  ?disabled=${busy}
                  @click=${() => this.markTaskDone(t)}
                >${icons.checkCircle} done</button>
                <button
                  class="pp-mini"
                  title="Dispatch a coding agent on this task"
                  ?disabled=${busy}
                  @click=${() => (this.dispatchOpenFor = t.id)}
                >${busy ? "…" : "dispatch"}</button>
                <button class="pp-mini" title="Open project board" @click=${() => this.openProjects()}>
                  open
                </button>
              `}
        </div>
      </div>
    `;
  }

  // Done → kanban.tasks.update status=done. Optimistically hide the row.
  private async markTaskDone(t: RadarTask): Promise<void> {
    if (!this.client || this.dispatchBusy[t.id]) return;
    this.dispatchBusy = { ...this.dispatchBusy, [t.id]: true };
    this.errorMsg = "";
    try {
      await this.client.request("kanban.tasks.update", { id: t.id, patch: { status: "done" } });
      this.doneTasks = { ...this.doneTasks, [t.id]: true };
      // Force a fresh pull so project counts/state recompute.
      this.radarLoadedAt = 0;
      void this.loadRadar();
    } catch (e) {
      console.error("[inprogress] markTaskDone failed:", e);
      this.errorMsg = "Couldn't mark that task done. It's still in your list.";
    } finally {
      this.dispatchBusy = { ...this.dispatchBusy, [t.id]: false };
    }
  }

  // Dispatch → spawn a coding agent against the task (title + description). The
  // agent picker chooses the backend (claude_coder by default). Mirrors the
  // kanban Run-dialog spawn shape (sessions.spawn).
  private async dispatchTask(t: RadarTask, agentId: string): Promise<void> {
    if (!this.client || this.dispatchBusy[t.id]) return;
    this.dispatchOpenFor = null;
    this.dispatchBusy = { ...this.dispatchBusy, [t.id]: true };
    this.errorMsg = "";
    const task = t.description?.trim() ? `${t.title}\n\n${t.description.trim()}` : t.title;
    try {
      const res = (await this.client.request("sessions.spawn", {
        task,
        agentId,
        label: t.title.slice(0, 80),
      })) as { childSessionKey?: string; status?: string } | null;
      this.dispatchedTasks = {
        ...this.dispatchedTasks,
        [t.id]: res?.childSessionKey || res?.status || "accepted",
      };
    } catch (e) {
      console.error("[inprogress] dispatchTask failed:", e);
      this.errorMsg = "Couldn't dispatch an agent for that task.";
    } finally {
      this.dispatchBusy = { ...this.dispatchBusy, [t.id]: false };
    }
  }

  // Open → navigate to the /projects board (kanban gallery).
  private openProjects(): void {
    try {
      window.history.pushState({}, "", pathForTab("projects" as never));
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch (e) {
      console.error("[inprogress] openProjects nav failed:", e);
    }
  }

  // ── Quiet-hours settings card ───────────────────────────────────────────────
  private renderQuietHoursSettings() {
    const qh = this.quietHours;
    return html`
      <div class="pp-settings">
        <div class="pp-section-head">
          Notifications
          <span class="pp-sub">Quiet hours hold non-critical pop-ups in the panel during the window. Off by default — CRITICAL always pops.</span>
        </div>
        <label class="pp-qh-toggle">
          <input
            type="checkbox"
            .checked=${qh.enabled}
            ?disabled=${this.settingsBusy}
            @change=${(e: Event) =>
              this.saveQuietHours({ enabled: (e.target as HTMLInputElement).checked })}
          />
          <span class="pp-qh-name">Enable quiet hours</span>
          <span class="pp-qh-state ${qh.enabled ? "on" : ""}">${qh.enabled ? "On" : "Off"}</span>
        </label>
        <div class="pp-qh-times ${qh.enabled ? "" : "pp-qh-off"}">
          <label class="pp-qh-field">
            <span>From</span>
            <input
              class="pp-time"
              type="time"
              .value=${qh.start}
              ?disabled=${!qh.enabled || this.settingsBusy}
              @change=${(e: Event) =>
                this.saveQuietHours({ start: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="pp-qh-field">
            <span>To</span>
            <input
              class="pp-time"
              type="time"
              .value=${qh.end}
              ?disabled=${!qh.enabled || this.settingsBusy}
              @change=${(e: Event) =>
                this.saveQuietHours({ end: (e.target as HTMLInputElement).value })}
            />
          </label>
        </div>
      </div>
    `;
  }

  private fmtMin(m: number): string {
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  }

  static styles = css`
    ${unsafeCSS(draggableOverlayStyles)}
    :host { display: block; }
    .pp-root { display: flex; flex-direction: column; gap: 14px; margin: 4px 0 18px; }
    .pp-loading { color: var(--g-fg-faint, rgba(245,234,205,0.5)); padding: 12px; font-size: 0.85rem; }

    .pp-section-head {
      display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
      font-size: 0.8rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em;
      color: var(--g-accent, #d4af37); margin-bottom: 10px;
    }
    .pp-sub { font-weight: 600; text-transform: none; letter-spacing: 0; font-size: 0.72rem;
      color: var(--g-fg-faint, rgba(245,234,205,0.55)); }
    .pp-empty { color: var(--g-fg-faint, rgba(245,234,205,0.5)); font-size: 0.8rem; padding: 8px 2px; }
    .pp-empty-row { border: 1px dashed var(--g-border, rgba(255,255,255,0.1)); border-radius: 10px;
      padding: 10px 12px; text-align: center; }
    .pp-toast { background: rgba(239,68,68,0.14); color: #f87171; border: 1px solid rgba(239,68,68,0.4);
      border-radius: 8px; padding: 7px 10px; font-size: 0.76rem; font-weight: 600; margin-bottom: 8px; }

    /* shared card */
    .pp-anchor, .pp-nowbar, .pp-commit, .pp-radar, .pp-settings, .pp-inprogress {
      border: 1px solid var(--g-border, rgba(212,175,55,0.18));
      border-radius: 14px;
      background: var(--g-surface, rgba(18,20,30,0.55));
      backdrop-filter: blur(8px);
      padding: 14px 16px;
    }

    /* where-was-i */
    .pp-anchor { display: flex; align-items: center; gap: 14px;
      border-color: rgba(96,165,250,0.4); background: rgba(30,58,95,0.28); }
    .pp-anchor-icon { font-size: 1.4rem; color: #60a5fa; }
    .pp-anchor-body { flex: 1; min-width: 0; }
    .pp-anchor-head { font-weight: 800; color: var(--g-fg, #f5eacd); display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; }
    .pp-anchor-last { font-weight: 600; font-size: 0.76rem; color: var(--g-fg-faint, rgba(245,234,205,0.6)); }
    .pp-anchor-while { font-size: 0.78rem; color: var(--g-fg-faint, rgba(245,234,205,0.7)); margin-top: 3px; }
    .pp-anchor-key { font-size: 0.8rem; color: #fbbf24; margin-top: 5px; font-weight: 600; }

    /* now-bar */
    .pp-nowbar { border-color: rgba(52,211,153,0.4); }
    .pp-nowbar.pp-drift-soft-drift { border-color: rgba(251,191,36,0.55); }
    .pp-nowbar.pp-drift-hard-drift { border-color: rgba(239,68,68,0.6); }
    .pp-ribbon { font-size: 0.78rem; font-weight: 700; border-radius: 8px; padding: 7px 10px; margin-bottom: 10px; }
    .pp-ribbon-soft { background: rgba(251,191,36,0.14); color: #fbbf24; }
    .pp-ribbon-hard { background: rgba(239,68,68,0.16); color: #f87171; }
    .pp-now-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
    .pp-now-eyebrow { display: block; font-size: 0.64rem; text-transform: uppercase; letter-spacing: 0.12em;
      color: #34d399; font-weight: 800; }
    .pp-now-title { font-size: 1.25rem; font-weight: 800; color: var(--g-fg, #fff); line-height: 1.1; }
    .pp-now-timer { text-align: right; flex: 0 0 auto; }
    .pp-now-remaining { font-size: 1.5rem; font-weight: 800; color: #34d399; }
    .pp-now-of { display: block; font-size: 0.68rem; color: var(--g-fg-faint, rgba(245,234,205,0.5)); }
    .pp-now-progress { height: 5px; border-radius: 4px; background: rgba(255,255,255,0.08); margin: 12px 0; overflow: hidden; }
    .pp-now-progress-fill { height: 100%; background: linear-gradient(90deg,#34d399,#10b981); border-radius: 4px; }
    .pp-now-actions, .pp-break { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

    /* commit flow */
    .pp-cands { display: flex; flex-direction: column; gap: 8px; }
    .pp-cand { display: flex; align-items: center; justify-content: space-between; gap: 12px;
      border: 1px solid var(--g-border, rgba(255,255,255,0.08)); border-radius: 10px; padding: 10px 12px;
      background: rgba(255,255,255,0.02); }
    .pp-cand-main { min-width: 0; flex: 1; }
    .pp-cand-title { font-weight: 700; color: var(--g-fg, #f5eacd); display: flex; align-items: center; gap: 7px; }
    .pp-cand-reason { font-size: 0.74rem; color: var(--g-fg-faint, rgba(245,234,205,0.6)); margin-top: 2px; }
    .pp-cand-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
    .pp-reject { margin-top: 10px; background: none; border: 1px dashed var(--g-border, rgba(255,255,255,0.18));
      color: var(--g-fg-faint, rgba(245,234,205,0.6)); border-radius: 8px; padding: 8px 12px; cursor: pointer;
      font-size: 0.78rem; width: 100%; }
    .pp-reject:hover { color: var(--g-fg, #f5eacd); }
    .pp-custom { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 10px; }

    /* commit flow — project→task hierarchy */
    .pp-projs { display: flex; flex-direction: column; gap: 8px; }
    .pp-proj { border: 1px solid var(--g-border, rgba(255,255,255,0.09)); border-radius: 11px;
      background: rgba(255,255,255,0.02); overflow: hidden; }
    .pp-proj-head { display: flex; align-items: center; gap: 9px; padding: 10px 12px; cursor: pointer; }
    .pp-proj-head:hover { background: rgba(255,255,255,0.03); }
    .pp-caret { flex: 0 0 auto; color: var(--g-fg-faint, rgba(245,234,205,0.6)); font-size: 0.8rem; width: 12px; }
    .pp-proj-name { font-weight: 800; color: var(--g-fg, #f5eacd); flex: 1; min-width: 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pp-proj-count { flex: 0 0 auto; font-size: 0.66rem; font-weight: 700; color: var(--g-fg-faint, rgba(245,234,205,0.5));
      text-transform: uppercase; letter-spacing: 0.06em; }
    .pp-proj-actions { flex: 0 0 auto; display: flex; gap: 6px; align-items: center; }
    .pp-proj-tasks { border-top: 1px solid rgba(255,255,255,0.06); padding: 4px 12px 8px 28px;
      display: flex; flex-direction: column; }
    .pp-task { display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 9px 2px; border-bottom: 1px solid rgba(255,255,255,0.05); }
    .pp-task:last-child { border-bottom: none; }
    .pp-task-main { min-width: 0; flex: 1; }
    .pp-task-title { font-weight: 600; color: var(--g-fg, #f5eacd); display: flex; align-items: center; gap: 7px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pp-task-meta { font-size: 0.7rem; color: var(--g-fg-faint, rgba(245,234,205,0.5)); margin-top: 2px;
      text-transform: capitalize; }
    .pp-task-actions, .pp-task-reject { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; flex-wrap: wrap; }
    .pp-task-reject { flex: 1; }
    .pp-btn-sm { padding: 5px 9px; font-size: 0.72rem; }
    .pp-link { background: none; border: none; color: var(--g-accent, #d4af37); font-size: 0.72rem;
      cursor: pointer; padding: 4px 2px; text-decoration: underline; }
    .pp-link:hover { opacity: 0.8; }

    .pp-tag { font-size: 0.6rem; font-weight: 800; padding: 1px 5px; border-radius: 4px; }
    .pp-tag-P0 { background: rgba(239,68,68,0.2); color: #f87171; }
    .pp-tag-P1 { background: rgba(251,146,60,0.2); color: #fb923c; }
    .pp-tag-P2 { background: rgba(96,165,250,0.2); color: #60a5fa; }
    .pp-tag-P3 { background: rgba(148,163,184,0.2); color: #94a3b8; }

    /* duration picker */
    .pp-durs { display: inline-flex; gap: 3px; }
    .pp-dur { background: rgba(255,255,255,0.05); border: 1px solid var(--g-border, rgba(255,255,255,0.1));
      color: var(--g-fg-faint, rgba(245,234,205,0.6)); border-radius: 6px; padding: 4px 8px; font-size: 0.72rem;
      cursor: pointer; }
    .pp-dur.active { background: var(--g-accent, #d4af37); color: #000; border-color: var(--g-accent, #d4af37); font-weight: 700; }

    /* in-progress projects card (draggable) */
    .pp-inprogress { display: flex; flex-direction: column; max-height: 70vh; min-width: 280px;
      resize: both; overflow: hidden; }
    .pp-ip-header { display: flex; align-items: center; gap: 10px; margin: -2px -2px 10px;
      padding: 4px 4px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); }
    .pp-ip-grip { flex: 0 0 auto; color: var(--g-fg-faint, rgba(245,234,205,0.4)); font-size: 0.95rem;
      line-height: 1; letter-spacing: -1px; }
    .pp-ip-heading { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
      font-size: 0.8rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em;
      color: var(--g-accent, #d4af37); }
    .pp-ip-drift { color: #fbbf24; }
    .pp-ip-reset { flex: 0 0 auto; }
    .pp-ip-body { flex: 1; min-height: 0; overflow-y: auto; }
    .pp-task-actions { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px; margin-left: auto; }
    .pp-mini-go { color: #34d399; border-color: rgba(52,211,153,0.4); }
    .pp-mini-go:hover:not(:disabled) { color: #6ee7b7; border-color: rgba(52,211,153,0.6); }
    .pp-dispatched { flex: 0 0 auto; font-size: 0.6rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em;
      color: #60a5fa; }
    .pp-dispatch-pick { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
    .pp-dispatch-agent { color: var(--g-accent, #d4af37); border-color: rgba(212,175,55,0.4); }
    .pp-dispatch-agent:hover:not(:disabled) { background: rgba(212,175,55,0.14); }

    /* drift radar */
    .pp-row { display: flex; align-items: center; gap: 10px; padding: 9px 4px;
      border-bottom: 1px solid rgba(255,255,255,0.05); }
    .pp-row:last-child { border-bottom: none; }
    .pp-chip { font-size: 0.6rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em;
      padding: 2px 7px; border-radius: 5px; flex: 0 0 auto; width: 56px; text-align: center; }
    .pp-chip-active { background: rgba(52,211,153,0.18); color: #34d399; }
    .pp-chip-watch { background: rgba(96,165,250,0.18); color: #60a5fa; }
    .pp-chip-drifting { background: rgba(251,191,36,0.18); color: #fbbf24; }
    .pp-chip-cold { background: rgba(148,163,184,0.16); color: #94a3b8; }
    .pp-row-main { flex: 1; min-width: 0; }
    .pp-row-name { font-weight: 700; color: var(--g-fg, #f5eacd); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      display: flex; align-items: center; gap: 6px; }
    .pp-auto { flex: 0 0 auto; font-size: 0.56rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em;
      padding: 1px 5px; border-radius: 4px; background: rgba(52,211,153,0.18); color: #34d399;
      border: 1px solid rgba(52,211,153,0.35); }
    .pp-row-meta { font-size: 0.72rem; color: var(--g-fg-faint, rgba(245,234,205,0.55)); }
    .pp-blocker { color: rgba(245,234,205,0.75); }
    .pp-drift-bar { width: 80px; height: 6px; border-radius: 4px; background: rgba(255,255,255,0.08); overflow: hidden; flex: 0 0 auto; }
    .pp-drift-fill { height: 100%; background: linear-gradient(90deg,#34d399,#fbbf24,#ef4444); border-radius: 4px; }
    /* expandable project → tasks sub-view */
    .pp-expand { flex: 0 0 auto; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center;
      background: none; border: none; color: var(--g-fg-faint, rgba(245,234,205,0.55)); cursor: pointer; font-size: 0.7rem;
      transition: transform 0.15s ease; }
    .pp-expand.open { transform: rotate(90deg); color: var(--g-accent, #d4af37); }
    .pp-taskcount { flex: 0 0 auto; font-size: 0.62rem; font-weight: 700; color: var(--g-fg-faint, rgba(245,234,205,0.5));
      background: rgba(255,255,255,0.05); border-radius: 5px; padding: 1px 6px; }
    .pp-subtasks { display: flex; flex-direction: column; gap: 5px; margin: 0 0 8px 46px; padding: 6px 0 2px; }
    .pp-subtasks-empty { font-size: 0.72rem; color: var(--g-fg-faint, rgba(245,234,205,0.45)); }
    .pp-subtask { display: flex; align-items: center; gap: 8px; font-size: 0.76rem; flex-wrap: wrap; }
    .pp-tname { color: var(--g-fg, rgba(245,234,205,0.85)); white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; flex: 1 1 120px; min-width: 0; }
    .pp-tchip { flex: 0 0 auto; font-size: 0.56rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em;
      padding: 1px 6px; border-radius: 4px; width: 74px; text-align: center; }
    .pp-tchip-in_progress { background: rgba(52,211,153,0.18); color: #34d399; }
    .pp-tchip-review { background: rgba(96,165,250,0.18); color: #60a5fa; }
    .pp-extras { margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.06);
      display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
    .pp-extras-head { font-size: 0.7rem; color: var(--g-fg-faint, rgba(245,234,205,0.5)); width: 100%; }
    .pp-extra { font-size: 0.72rem; color: var(--g-fg-faint, rgba(245,234,205,0.7)); background: rgba(255,255,255,0.04);
      border-radius: 6px; padding: 3px 6px 3px 8px; display: inline-flex; align-items: center; gap: 5px; }

    /* quiet-hours settings */
    .pp-qh-toggle { display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; }
    .pp-qh-toggle input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--g-accent, #d4af37); cursor: pointer; }
    .pp-qh-name { font-weight: 700; color: var(--g-fg, #f5eacd); font-size: 0.84rem; }
    .pp-qh-state { margin-left: auto; font-size: 0.64rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em;
      padding: 2px 8px; border-radius: 999px; background: rgba(148,163,184,0.16); color: #94a3b8; }
    .pp-qh-state.on { background: rgba(52,211,153,0.18); color: #34d399; }
    .pp-qh-times { display: flex; gap: 16px; margin-top: 12px; transition: opacity 0.15s ease; }
    .pp-qh-times.pp-qh-off { opacity: 0.4; }
    .pp-qh-field { display: flex; flex-direction: column; gap: 4px; font-size: 0.68rem;
      color: var(--g-fg-faint, rgba(245,234,205,0.55)); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; }
    .pp-time { background: rgba(0,0,0,0.3); border: 1px solid var(--g-border, rgba(255,255,255,0.14));
      color: var(--g-fg, #f5eacd); border-radius: 8px; padding: 6px 9px; font-size: 0.82rem; color-scheme: dark; }
    .pp-time:disabled { opacity: 0.6; cursor: not-allowed; }

    /* buttons */
    .pp-btn { background: rgba(255,255,255,0.07); border: 1px solid var(--g-border, rgba(255,255,255,0.14));
      color: var(--g-fg, #f5eacd); border-radius: 8px; padding: 7px 13px; font-size: 0.78rem; font-weight: 700;
      cursor: pointer; }
    .pp-btn:hover:not(:disabled) { background: rgba(255,255,255,0.12); }
    .pp-btn:disabled { opacity: 0.5; cursor: default; }
    .pp-btn-primary { background: var(--g-accent, #d4af37); color: #000; border-color: var(--g-accent, #d4af37); }
    .pp-btn-ghost { background: none; }
    .pp-cand-reject { color: var(--g-fg-faint, rgba(245,234,205,0.6)); border-color: var(--g-border, rgba(255,255,255,0.14)); }
    .pp-cand-reject:hover:not(:disabled) { color: #fbbf24; border-color: rgba(251,191,36,0.4); }
    .pp-mini { background: none; border: 1px solid var(--g-border, rgba(255,255,255,0.14));
      color: var(--g-fg-faint, rgba(245,234,205,0.6)); border-radius: 6px; padding: 2px 7px; font-size: 0.68rem; cursor: pointer; }
    .pp-mini:hover:not(:disabled) { color: var(--g-fg, #f5eacd); }
    .pp-input { flex: 1; min-width: 180px; background: rgba(0,0,0,0.3); border: 1px solid var(--g-border, rgba(255,255,255,0.14));
      color: var(--g-fg, #f5eacd); border-radius: 8px; padding: 7px 10px; font-size: 0.8rem; }
  `;
}

// Persistent dedup for the drift-crossing Signal producer (BUG-2). A drifting
// project re-signals at most once per window, surviving reloads / extra tabs.
const DRIFT_SIGNAL_KEY = "infinibot-drift-signal-emitted";
const DRIFT_SIGNAL_TTL_MS = 12 * 60 * 60 * 1000;

// ── In-progress card layout (draggable + resizable) ──────────────────────────
// Single source of truth for the card's geometry, persisted under the key the
// spec mandates. `left/top` are viewport px (the card is position:fixed once
// the user has dragged it); width/height are the resized box. All-zero = "never
// moved" → the card keeps its in-flow CSS default until the user drags/resizes.
const CARD_LAYOUT_KEY = "drift-radar.replacement.layout";
interface CardLayout {
  left: number;
  top: number;
  width: number;
  height: number;
}
function loadCardLayout(): CardLayout {
  try {
    const raw = localStorage.getItem(CARD_LAYOUT_KEY);
    if (!raw) return { left: 0, top: 0, width: 0, height: 0 };
    const p = JSON.parse(raw) ?? {};
    return {
      left: Number.isFinite(p.left) ? p.left : 0,
      top: Number.isFinite(p.top) ? p.top : 0,
      width: Number.isFinite(p.width) ? p.width : 0,
      height: Number.isFinite(p.height) ? p.height : 0,
    };
  } catch {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
}
function saveCardLayout(l: CardLayout): void {
  try {
    localStorage.setItem(CARD_LAYOUT_KEY, JSON.stringify(l));
  } catch {
    /* storage disabled — layout simply won't persist */
  }
}

// Quick agent picker for per-task Dispatch. Backends mirror the kanban Run
// dialog's agentOptions; Claude Code (claude_coder) is the default first pick.
const DISPATCH_AGENTS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "coder-claude", name: "Claude" },
  { id: "coder-codex", name: "Codex" },
  { id: "coder", name: "Atlas" },
  { id: "webdev", name: "Architect" },
];

// ── In-progress projects render model ────────────────────────────────────────
interface RadarTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: "in_progress" | "review" | "todo";
}
interface RadarRow {
  projectId: string;
  name: string;
  status: string;
  /** Whole days since the project/its tasks last changed; -1 = never. */
  daysSince: number;
  driftScore: number;
  state: "active" | "drifting" | "cold";
  tasks: RadarTask[];
}

declare global {
  interface HTMLElementTagNameMap {
    "proactive-panel": ProactivePanel;
  }
}

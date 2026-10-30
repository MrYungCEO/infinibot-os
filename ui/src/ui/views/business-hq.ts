/**
 * Business HQ — the /dashboard leadership view.
 *
 * Answers "what is happening in the business, and what do I do next?" — and
 * lets the owner do it from here. Every number, card and row opens a focus
 * modal (full context + forward actions wired to real RPCs), every list can be
 * bulk-actioned, and the top of the page is a ranked "Today's focus" with a
 * one-click primary action per item plus "delegate the rest to agents".
 *
 * Data: the kanban board (kanban.projects.list + kanban.tasks.list via the
 * shared SWR-cached loadKanban — cached rows render immediately, freshness is
 * shown, actions work while it revalidates) and the business object stores
 * (opportunity / decision / risk / commitment / person / clients). Progress
 * (done today, streak, week, before→after deltas) comes from the persisted
 * hq-progress log, which only the gateway's update handlers write — so every
 * progress number reflects a real state change.
 *
 * Real-time: kanban writes broadcast `kanban:changed`, which reloads the board
 * while this tab is open; object writes re-list the stores.
 */
import { html, nothing, type TemplateResult } from "lit";
import type { AppViewState } from "../app-view-state";
import type { GatewayBrowserClient } from "../gateway";
import { isTabAvailable } from "../plugin-host.js";
import type { KanbanProject, KanbanTask } from "../types";
import { kanbanCacheTimestamp, loadKanban } from "../controllers/kanban";
import {
  hqObjectsState,
  ensureHqObjects,
  loadHqObjects,
  ceoDecisions,
  isCriticalRisk,
  isOverdueCommitment,
  hqPriorityRank,
  type HqOpportunity,
  type HqProduct,
  type HqRisk,
  type HqDecision,
  type HqCommitment,
  type HqPerson,
} from "../controllers/business-hq-objects";
import {
  clientItem,
  commitmentItem,
  computeProgress,
  dayKey,
  decisionItem,
  delegationCandidates,
  detectParentProject,
  metricDeltas,
  opportunityItem,
  planAction,
  projectItem,
  rankNextActions,
  resolveObjectProject,
  riskItem,
  taskItem,
  type HqItem,
  type HqMetricKey,
  type NextAction,
} from "../controllers/hq-model";
import { hqUi, loadHqProgress, performAction, snapshotMetrics, type RpcClient } from "../controllers/hq-actions";
import {
  metricLabel,
  openDelegate,
  openFocus,
  openList,
  openRecap,
  openSettings,
  mountHqOverlays,
  type HqCtx,
} from "./hq-overlays";
import {
  KIS_STYLE,
  emptyState as kisEmptyState,
  loadingBanner,
  ghostButton,
  icon,
  statCard,
} from "./kis-shared";
import { baAurora, openHubSection } from "./ba-glass";
import "./ba-glass/hq.css";
import { renderKanbanSection } from "./kanban-section";

// ── One-time initial load tracking (per app instance / wall window) ──────────
const loadKicked = new WeakSet<object>();

// ── Task/date helpers ────────────────────────────────────────────────────────
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function parseDue(t: KanbanTask): number | null {
  if (!t.dueDate) return null;
  const ms = Date.parse(t.dueDate);
  return Number.isNaN(ms) ? null : ms;
}
function isDone(t: KanbanTask): boolean {
  return t.status === "done" || t.done === true;
}
function isOverdue(t: KanbanTask): boolean {
  const due = parseDue(t);
  return due !== null && due < startOfToday() && !isDone(t);
}
function isBlocked(t: KanbanTask): boolean {
  return t.autonomousStatus === "blocked";
}
function isActive(t: KanbanTask): boolean {
  return t.status === "in_progress" || t.autonomousStatus === "in_progress";
}
function isNext(t: KanbanTask): boolean {
  return (t.status === "todo" || t.status === "backlog") && !isDone(t);
}
function prioRank(t: KanbanTask): number {
  const p = (t.priority || "").toLowerCase();
  if (p === "critical" || p === "immediate" || p === "urgent") return 3; // local store id for critical
  if (p === "high") return 2;
  if (p === "normal" || p === "medium") return 1;
  const pl = (t.priorityLevel || "").toLowerCase();
  if (pl === "immediate") return 3;
  if (pl === "high") return 2;
  if (pl === "medium") return 1;
  return 0;
}
function isImportant(t: KanbanTask): boolean {
  return prioRank(t) >= 2 && !isDone(t);
}
function dueWithinDays(t: KanbanTask, days: number): boolean {
  const due = parseDue(t);
  if (due === null) return false;
  return due >= startOfToday() && due <= startOfToday() + days * 86400000;
}
// A "CEO focus" item is one that is both consequential AND time-sensitive — the
// number should stay small enough to act on today, not surface the whole backlog.
function needsCeo(t: KanbanTask, ceoProjectIds: Set<string>): boolean {
  if (isDone(t)) return false;
  if (ceoProjectIds.has(t.projectId)) return true; // explicitly on a CEO board
  if (t.autonomousStatus === "pending_approval") return true; // waiting on a sign-off
  if (isBlocked(t)) return true; // blocked work usually needs a leadership unblock
  if (/\bceo\b|sign[- ]?off|\bapprov/i.test(t.title || "")) return true;
  // Consequential + time-sensitive: critical/high that is overdue or due this week.
  if (prioRank(t) >= 2 && (isOverdue(t) || dueWithinDays(t, 7))) return true;
  return false;
}

function fmtDue(t: KanbanTask): string {
  const due = parseDue(t);
  if (due === null) return "no date";
  const days = Math.round((due - startOfToday()) / 86400000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 14) return `in ${days}d`;
  return new Date(due).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const ACTIVE_PROJECT_STATUSES = new Set(["In progress", "Updating", "Reviewing", "Awaiting Client"]);
function projectIsActive(p: KanbanProject): boolean {
  const s = p.status || "";
  if (["Completed", "Cancelled", "Paused"].includes(s)) return false;
  return ACTIVE_PROJECT_STATUSES.has(s);
}

// ── Small render primitives ──────────────────────────────────────────────────
function chip(label: string, tone: "gold" | "danger" | "warn" | "ok" | "muted" = "muted") {
  return html`<span class="kis-chip kis-chip--${tone}">${label}</span>`;
}

/**
 * Labelled empty state. Every section passes a "what to do next" hint and,
 * where a surface exists to act on, a primary action that routes there — so no
 * card on the HQ is ever a dead end.
 */
function emptyState(
  msg: string,
  opts: { hint?: string; actionLabel?: string; goTo?: string; onAction?: () => void; iconName?: string } = {},
) {
  return kisEmptyState({
    title: msg,
    hint: opts.hint,
    compact: true,
    iconName: opts.iconName ?? "inbox",
    actionLabel: opts.actionLabel,
    onAction:
      opts.onAction ??
      (opts.goTo
        ? () => {
            window.history.pushState({}, "", opts.goTo!);
            window.dispatchEvent(new PopStateEvent("popstate"));
          }
        : undefined),
  });
}

/**
 * Empty state for the three kanban-backed sections.
 *
 * `kanban.tasks.list` can hang indefinitely — measured >20s against a live
 * gateway while every other RPC on the page answered in under a second. While
 * that request is still outstanding we do not know whether the board is empty
 * or unreachable, so rendering "No open work on the board — every task is done"
 * states good news we have not verified. Name the unresponsive source instead,
 * and only fall through to the real empty state once the board has answered.
 */
function boardEmptyState(
  stalled: boolean,
  msg: string,
  opts: { hint?: string; actionLabel?: string; goTo?: string; onAction?: () => void; iconName?: string } = {},
) {
  if (!stalled) return emptyState(msg, opts);
  return kisEmptyState({
    title: "Task board not responding",
    hint: "This section is fed by the kanban source, which has not answered yet. Everything else on this page is live from the object stores.",
    compact: true,
    iconName: "clock",
  });
}

/**
 * A clickable row. Rows are buttons (keyboard reachable, Enter/Space open the
 * focus modal); flags sit inside so the whole row is one target.
 */
function rowButton(
  onOpen: () => void,
  dot: string,
  title: string,
  sub: unknown,
  flags: unknown[],
  opts: { busy?: boolean; done?: boolean } = {},
): TemplateResult {
  return html`
    <button type="button" class="bhq-row bhq-row--btn ${opts.busy ? "is-busy" : ""} ${opts.done ? "is-done" : ""}" @click=${onOpen}>
      <span class="bhq-row-dot bhq-row-dot--${dot}"></span>
      <span class="bhq-row-main">
        <span class="bhq-row-title" title=${title}>${title || "Untitled"}</span>
        ${sub ? html`<span class="bhq-row-sub">${sub}</span>` : nothing}
      </span>
      <span class="bhq-row-flags">${flags.filter((f) => f !== nothing)}</span>
      <span class="bhq-row-go" aria-hidden="true">›</span>
    </button>
  `;
}

function taskRow(
  ctx: HqCtx,
  t: KanbanTask,
  opts: { showProject?: boolean; showDue?: boolean } = {},
): TemplateResult {
  const flags: unknown[] = [];
  if (isDone(t)) flags.push(chip("done", "ok"));
  else if (isBlocked(t)) flags.push(chip("blocked", "danger"));
  else if (isOverdue(t)) flags.push(chip(fmtDue(t), "danger"));
  else if (opts.showDue !== false && t.dueDate) flags.push(chip(fmtDue(t), t.status === "in_progress" ? "gold" : "muted"));
  if (prioRank(t) >= 3) flags.push(chip("critical", "danger"));
  else if (prioRank(t) >= 2) flags.push(chip("high", "warn"));
  const sub =
    opts.showProject !== false
      ? html`${ctx.projectName(t.projectId)}${t.assignee ? html` · ${t.assignee}` : nothing}`
      : t.assignee || "";
  return rowButton(() => openFocus(ctx, taskItem(t)), isDone(t) ? "done" : t.status, t.title, sub, flags, {
    busy: hqUi.busy.has(t.id),
    done: isDone(t),
  });
}

interface SectionMeta {
  title: string;
  subtitle: string;
  count?: number;
  countTone?: "gold" | "danger" | "warn" | "ok" | "muted";
  accent?: boolean;
  iconName?: string;
  /** Opens the full list behind this card (bulk-actionable). */
  onViewAll?: () => void;
  /** Label for the view-all control (defaults to "View all"). */
  viewAllLabel?: string;
}
function section(meta: SectionMeta, body: unknown): TemplateResult {
  return html`
    <section class="bhq-card ${meta.accent ? "bhq-card--accent" : ""}">
      <header class="bhq-card-head">
        <div class="bhq-card-headmain">
          ${meta.iconName ? html`<span class="bhq-card-icon">${icon(meta.iconName, 13)}</span>` : nothing}
          <div>
            <h3 class="bhq-card-title">${meta.title}</h3>
            <p class="bhq-card-sub">${meta.subtitle}</p>
          </div>
        </div>
        <div class="bhq-card-headside">
          ${meta.onViewAll && meta.count
            ? html`<button type="button" class="bhq-viewall" @click=${meta.onViewAll} aria-label=${meta.viewAllLabel ? `${meta.viewAllLabel}: ${meta.title}` : `View all ${meta.title}`}>${meta.viewAllLabel ?? "View all"}</button>`
            : nothing}
          ${meta.count !== undefined
            ? html`<span class="bhq-count bhq-count--${meta.countTone || "muted"}">${meta.count}</span>`
            : nothing}
        </div>
      </header>
      <div class="bhq-card-body">${body}</div>
    </section>
  `;
}

function subGroup(
  ctx: HqCtx,
  label: string,
  tasks: KanbanTask[],
  limit = 5,
  tone: "gold" | "danger" | "warn" | "ok" | "muted" = "muted",
) {
  if (!tasks.length) return nothing;
  return html`
    <div class="bhq-group">
      <div class="bhq-group-label">
        ${chip(label, tone)} <span class="bhq-group-n">${tasks.length}</span>
        <button type="button" class="bhq-viewall bhq-viewall--sm" @click=${() => openList(ctx, `Business — ${label}`, tasks.map(taskItem), "Select to bulk mark done, reschedule or assign.")}>Select…</button>
      </div>
      ${tasks.slice(0, limit).map((t) => taskRow(ctx, t))}
      ${tasks.length > limit
        ? html`<button type="button" class="bhq-more" @click=${() => openList(ctx, `Business — ${label}`, tasks.map(taskItem))}>+${tasks.length - limit} more</button>`
        : nothing}
    </div>
  `;
}

// ── Live-object row primitives ───────────────────────────────────────────────
function prioChip(priority?: string): TemplateResult | typeof nothing {
  const p = (priority || "").toUpperCase();
  if (p === "P0") return chip("P0", "danger");
  if (p === "P1") return chip("P1", "warn");
  if (!p || p === "P2" || p === "P3") return nothing;
  return chip(p, "muted");
}
function objRow(ctx: HqCtx, item: HqItem, sub: string, flags: unknown[], dot = "todo"): TemplateResult {
  return rowButton(() => openFocus(ctx, item), dot, item.title, sub, flags, { busy: hqUi.busy.has(item.id) });
}
function money(n?: number): string {
  const v = Number(n) || 0;
  if (v >= 1000000) return `$${(v / 1000000).toFixed(1)}M`;
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v}`;
}

// ── Today's focus + progress ─────────────────────────────────────────────────

const KIND_WORD: Record<HqItem["kind"], string> = {
  task: "Task",
  decision: "Decision",
  risk: "Risk",
  commitment: "Commitment",
  opportunity: "Deal",
  client: "Client",
  project: "Project",
};

/** One-click primary: executes when it needs no input, otherwise opens the right pane. */
function runPrimary(ctx: HqCtx, a: NextAction) {
  const item = a.item;
  switch (a.primary.action) {
    case "task.done":
    case "task.approve":
    case "commitment.resolve": {
      const plan = planAction(a.primary.action, item);
      const undo =
        a.primary.action === "task.done" && item.kind === "task"
          ? () => {
              const reopen = planAction("task.reopen", item, { status: item.raw.status });
              void performAction(ctx.state, ctx.client as unknown as RpcClient, item.id, reopen);
            }
          : undefined;
      void performAction(ctx.state, ctx.client as unknown as RpcClient, item.id, plan, { undo });
      return;
    }
    case "task.unblock":
      return openFocus(ctx, item, "unblock");
    case "decision.decide":
      return openFocus(ctx, item, "decide");
    case "risk.mitigate":
      return openFocus(ctx, item, "mitigate");
    case "opportunity.next":
      return openFocus(ctx, item, "next");
  }
}

function renderTodaysFocus(ctx: HqCtx, loading: boolean): TemplateResult {
  const list = ctx.nextActions;
  const delegable = ctx.delegation;
  return html`
    <section class="bhq-card bhq-card--accent bhq-today" aria-labelledby="bhq-today-title">
      <header class="bhq-card-head">
        <div class="bhq-card-headmain">
          <span class="bhq-card-icon">${icon("star", 13)}</span>
          <div>
            <h2 id="bhq-today-title" class="bhq-card-title">Today's focus</h2>
            <p class="bhq-card-sub">The highest-leverage moves right now, ranked. Do the first one.</p>
          </div>
        </div>
        <span class="bhq-count bhq-count--${list.length ? "warn" : "ok"}">${list.length}</span>
      </header>
      <div class="bhq-card-body">
        ${list.length
          ? html`<ol class="bhq-nba">
              ${list.map(
                (a, i) => html`
                  <li class="bhq-nba-item ${hqUi.busy.has(a.item.id) ? "is-busy" : ""}">
                    <span class="bhq-nba-rank" aria-hidden="true">${i + 1}</span>
                    <button type="button" class="bhq-nba-main" @click=${() => openFocus(ctx, a.item)} aria-label=${`${KIND_WORD[a.item.kind]}: ${a.item.title} — ${a.reason}. Open details`}>
                      <span class="bhq-nba-title">${a.item.title}</span>
                      <span class="bhq-nba-why"><span class="bhq-nba-kind">${KIND_WORD[a.item.kind]}</span> ${a.reason}</span>
                    </button>
                    <button
                      type="button"
                      class="bhq-nba-go"
                      ?disabled=${hqUi.busy.has(a.item.id)}
                      @click=${() => runPrimary(ctx, a)}
                      aria-label=${`${a.primary.label}: ${a.item.title}`}
                    >
                      ${a.primary.action === "task.done" || a.primary.action === "commitment.resolve" || a.primary.action === "task.approve" ? icon("check", 12) : nothing}
                      ${a.primary.label}
                    </button>
                  </li>
                `,
              )}
            </ol>`
          : loading
            ? html`<p class="bhq-muted">Ranking your day as the board loads…</p>`
            : html`<div class="bhq-clear">
                <span class="bhq-clear-mark" aria-hidden="true">${icon("check", 16)}</span>
                <div><strong>You're clear.</strong> Nothing is overdue, blocked or waiting on a decision. Pull something forward from "coming next" below.</div>
              </div>`}
        <div class="bhq-today-foot">
          ${delegable.length
            ? html`<button type="button" class="bhq-delegate" @click=${() => openDelegate(ctx, delegable)}>
                Delegate the rest to agents <span class="bhq-delegate-n">${delegable.length}</span>
              </button>
              <span class="bhq-muted">Proposes verified goal runs for work that doesn't need your judgement — you confirm first.</span>`
            : html`<span class="bhq-muted">Nothing delegable right now — decisions, approvals and payments stay with you.</span>`}
        </div>
      </div>
    </section>
  `;
}

function progressRing(pct: number, celebrating: boolean): TemplateResult {
  const r = 20;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(100, Math.max(0, pct)) / 100);
  return html`<svg class="bhq-ring ${celebrating ? "is-celebrating" : ""}" viewBox="0 0 48 48" width="52" height="52" aria-hidden="true">
    <circle cx="24" cy="24" r=${r} class="bhq-ring-track"></circle>
    <circle cx="24" cy="24" r=${r} class="bhq-ring-fill" stroke-dasharray=${c.toFixed(2)} stroke-dashoffset=${off.toFixed(2)}></circle>
  </svg>`;
}

function renderProgress(ctx: HqCtx): TemplateResult {
  if (hqUi.progressUnavailable) {
    return html`<div class="bhq-progress bhq-progress--off" role="note">
      ${icon("clock", 13)}
      <span>Progress tracking (done today, streaks, deltas) switches on once the gateway is restarted to serve <code>hq.progress.*</code>. Every action below already works.</span>
    </div>`;
  }
  const p = ctx.progress;
  const celebrating = !!hqUi.celebrate && Date.now() - hqUi.celebrate.at < 1800;
  const kinds = Object.entries(p.byKindToday)
    .map(([k, n]) => `${n} ${k === "task.done" ? "task" : k === "decision.decided" ? "decision" : k === "risk.resolved" ? "risk" : "commitment"}${n === 1 ? "" : "s"}`)
    .join(" · ");
  return html`
    <div class="bhq-progress" aria-label="Progress" data-learn-id="bhq-progress">
      <button type="button" class="bhq-prog-today" @click=${() => openRecap(ctx)} aria-label=${`${p.today} of ${p.target} done today. Open recap`}>
        <span class="bhq-ring-wrap">
          ${progressRing(p.pct, celebrating)}
          <span class="bhq-ring-num">${p.today}<small>/${p.target}</small></span>
          ${celebrating ? html`<span class="bhq-burst" aria-hidden="true"></span>` : nothing}
        </span>
        <span class="bhq-prog-text">
          <strong>${p.hitToday ? "Daily target hit" : `${Math.max(0, p.target - p.today)} to go today`}</strong>
          <span class="bhq-muted">${kinds || "Completions count as you close things out"}</span>
        </span>
      </button>
      <div class="bhq-prog-stat" title="Consecutive days at or over your daily target">
        <span class="bhq-prog-val ${p.streak ? "is-gold" : ""}">${p.streak}</span>
        <span class="bhq-prog-lbl">day streak${p.streakAtRisk ? html` · <em>hit ${p.target} today to keep it</em>` : ""}</span>
      </div>
      <div class="bhq-prog-stat">
        <span class="bhq-prog-val">${p.week}</span>
        <span class="bhq-prog-lbl">cleared this week</span>
      </div>
      <div class="bhq-prog-deltas" aria-label="Change since this morning">
        ${ctx.deltas.length
          ? ctx.deltas.map(
              (d) => html`<span class="bhq-delta bhq-delta--${d.change < 0 ? "good" : "bad"}">
                ${metricLabel(d.key)} <span class="bhq-delta-from">${d.from}</span> → <strong>${d.to}</strong>
                ${icon(d.change < 0 ? "arrowDown" : "arrowUp", 10)}
              </span>`,
            )
          : html`<span class="bhq-muted">No change since this morning's baseline yet.</span>`}
      </div>
      <div class="bhq-prog-actions">
        <button type="button" class="bhq-viewall" @click=${() => openRecap(ctx)}>Recap</button>
        <button type="button" class="bhq-viewall" @click=${() => openSettings(ctx)} aria-label="Dashboard settings: daily target and parent project">Target ${p.target}/day</button>
      </div>
    </div>
  `;
}

// ── Main render ──────────────────────────────────────────────────────────────
let lastTasksRef: unknown = null;
let progressReloadTimer: ReturnType<typeof setTimeout> | null = null;

export function renderBusinessHQ(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const rpc = client as unknown as RpcClient;
  // Kick the initial load once per app instance; reuses the shared kanban cache.
  if (!loadKicked.has(state)) {
    loadKicked.add(state);
    void loadKanban(state);
    void loadHqProgress(state, rpc);
  }
  // Live object stores (opportunity/product/decision/risk/commitment/person).
  ensureHqObjects(state, client);

  const projects = (state.kanbanProjects || []) as KanbanProject[];
  const tasks = (state.kanbanTasks || []) as KanbanTask[];
  const loading = state.kanbanLoading && tasks.length === 0;
  const err = state.kanbanError;

  // Board changed underneath us (kanban:changed reload, another surface) →
  // refresh the progress log shortly after so completions made elsewhere count.
  if (tasks !== lastTasksRef) {
    const first = lastTasksRef === null;
    lastTasksRef = tasks;
    if (!first) {
      if (progressReloadTimer) clearTimeout(progressReloadTimer);
      progressReloadTimer = setTimeout(() => void loadHqProgress(state, rpc), 1200);
    }
  }

  // ── Object boards: configured parent, else auto-detected (no owner ids) ──
  const settings = hqUi.progress?.settings;
  const detectedParentId = detectParentProject(projects);
  const parentId = settings?.parentProjectId ?? detectedParentId;
  const oid = (k: string) => resolveObjectProject(projects, parentId, k);
  const clientsPid = oid("clients");
  const oppsPid = oid("opportunities");
  const productsPid = oid("products");
  const risksPid = oid("risks");
  const decisionsPid = oid("decisions");
  const commitmentsPid = oid("commitments");
  const ceoQueuePid = oid("ceoQueue");
  const ceoProjectIds = new Set([ceoQueuePid, oid("ceoDashboard")].filter(Boolean) as string[]);
  const objectBoardIds = new Set([clientsPid, oppsPid, productsPid, risksPid, decisionsPid, commitmentsPid, ...ceoProjectIds].filter(Boolean) as string[]);
  const tasksIn = (pid: string | null) => (pid ? tasks.filter((t) => t.projectId === pid) : []);
  const openIn = (pid: string | null) => tasksIn(pid).filter((t) => !isDone(t));

  // ── Business derivations (whole board) ──
  const openTasks = tasks.filter((t) => !isDone(t));
  const overdue = openTasks.filter(isOverdue);
  const blocked = openTasks.filter(isBlocked);
  const active = openTasks.filter((t) => isActive(t) && !isBlocked(t));
  const important = openTasks
    .filter((t) => isImportant(t) && !isBlocked(t))
    .sort((a, b) => prioRank(b) - prioRank(a) || (parseDue(a) ?? Infinity) - (parseDue(b) ?? Infinity));
  const comingNext = openTasks
    .filter((t) => isNext(t) && !isOverdue(t))
    .sort((a, b) => (parseDue(a) ?? Infinity) - (parseDue(b) ?? Infinity));

  // ── CEO focus ──
  const ceoItems = openTasks
    .filter((t) => needsCeo(t, ceoProjectIds))
    .sort((a, b) => {
      const ao = isOverdue(a) ? 1 : 0;
      const bo = isOverdue(b) ? 1 : 0;
      return bo - ao || prioRank(b) - prioRank(a) || (parseDue(a) ?? Infinity) - (parseDue(b) ?? Infinity);
    });

  // ── Projects ──
  const activeProjects = projects
    .filter(projectIsActive)
    .map((p) => {
      const pt = tasks.filter((t) => t.projectId === p.id);
      return {
        p,
        open: pt.filter((t) => !isDone(t)).length,
        blockers: pt.filter((t) => !isDone(t) && (isBlocked(t) || isOverdue(t))).length,
      };
    })
    .sort((a, b) => b.blockers - a.blockers || b.open - a.open || (b.p.updatedAt || 0) - (a.p.updatedAt || 0));

  // ── Clients / Opportunities / Products / governance (object boards) ──
  const clientItems = openIn(clientsPid);
  const oppItems = openIn(oppsPid);
  const productAll = tasksIn(productsPid);
  const riskItems = openIn(risksPid);
  const decisionItems = tasksIn(decisionsPid);
  const commitmentItems = openIn(commitmentsPid);

  // ── Live object stores (prefer these; fall back to kanban) ──
  const O = hqObjectsState;
  const oppObjs = O.opportunities;
  const productObjs = O.products;
  const riskObjs = O.risks;
  const decisionObjs = O.decisions;
  const commitmentObjs = O.commitments;
  const peopleObjs = O.people;
  const clientObjs = O.clients;
  const useOppObjs = oppObjs.length > 0;
  const useProductObjs = productObjs.length > 0;
  const useRiskObjs = riskObjs.length > 0;
  const useDecisionObjs = decisionObjs.length > 0;
  const useCommitmentObjs = commitmentObjs.length > 0;

  const ceoDecs = ceoDecisions().filter((d) => !/decided|deferred|cancelled/i.test(d.status || ""));
  const openRisks = riskObjs.filter((r) => !/closed|mitigated|resolved|accepted/i.test(r.status || ""));
  const criticalRisks = openRisks.filter(isCriticalRisk).sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
  const overdueCommits = commitmentObjs.filter(isOverdueCommitment);
  const objectFocusCount = ceoDecs.length + criticalRisks.length + overdueCommits.length;
  const needsCeoCount = ceoItems.length + objectFocusCount;

  // ── Action context ──
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name || "Unassigned";
  const taskProjectOptions = [
    ...(ceoQueuePid ? [{ id: ceoQueuePid, name: projectName(ceoQueuePid) }] : []),
    ...projects
      .filter((p) => p.id !== ceoQueuePid && (projectIsActive(p) || objectBoardIds.has(p.id)))
      .map((p) => ({ id: p.id, name: p.name })),
  ];
  if (!taskProjectOptions.length) projects.slice(0, 30).forEach((p) => taskProjectOptions.push({ id: p.id, name: p.name }));

  const now = Date.now();
  const nextActions = rankNextActions({
    tasks,
    decisions: ceoDecs,
    risks: openRisks,
    commitments: commitmentObjs,
    opportunities: oppObjs,
    snoozes: settings?.snoozes,
    isCriticalRisk,
    isOverdueCommitment,
    now,
  });
  const focusIds = new Set(nextActions.map((a) => a.item.id));
  const delegation = delegationCandidates(tasks.filter((t) => !focusIds.has(t.id) || isOverdue(t) || isBlocked(t)), now);

  const metrics: Record<HqMetricKey, number> = {
    overdue: overdue.length,
    blocked: blocked.length,
    needsCeo: needsCeoCount,
    criticalRisks: criticalRisks.length,
    overdueCommitments: overdueCommits.length,
    openTasks: openTasks.length,
  };
  const boardReady = !state.kanbanLoading && tasks.length > 0 && O.loaded;
  if (boardReady && hqUi.progress) void snapshotMetrics(rpc, metrics, now);
  const baseline = hqUi.progress?.snapshots?.[dayKey(now)]?.first.metrics;
  const deltas = boardReady ? metricDeltas(baseline, metrics) : [];
  const progress = computeProgress(hqUi.progress?.events ?? [], settings?.dailyTarget ?? 5, now);

  const ctx: HqCtx = {
    state,
    client,
    projects,
    tasks,
    people: peopleObjs as HqPerson[],
    projectName,
    defaultTaskProjectId: taskProjectOptions[0]?.id ?? null,
    taskProjectOptions,
    progress,
    deltas,
    nextActions,
    delegation,
    detectedParentId,
    parentProjectId: settings?.parentProjectId ?? null,
  };

  // ── Freshness (cached rows render immediately; say how old they are) ──
  const fetchedAt = kanbanCacheTimestamp();
  const refreshing = !!state.kanbanRefreshing || O.loading;
  const freshness = loading
    ? "loading the board…"
    : refreshing
      ? `refreshing · showing data from ${fetchedAt ? fmtAgo(fetchedAt) : "cache"}`
      : fetchedAt
        ? `updated ${fmtAgo(fetchedAt)}`
        : `${projects.length} projects · ${tasks.length} tasks`;

  // Clients: the agency client list (clients.list → agency.db) is the same
  // store the Business hub's Clients section reads, so "see all clients"
  // goes there. Client-delivery tasks on a kanban "Clients" board are board
  // work, not the client register, so they keep the bulk-actionable list.
  const clientsInHub = !clientItems.length && isTabAvailable("hub");
  const openClients = () =>
    clientItems.length
      ? openList(ctx, "Clients", clientItems.map(taskItem))
      : clientsInHub
        ? openHubSection(state, "clients")
        : openList(ctx, "Clients", clientObjs.map(clientItem));

  const listCeo = () =>
    openList(ctx, "Needs you", [
      ...ceoDecs.map(decisionItem),
      ...criticalRisks.map(riskItem),
      ...overdueCommits.map(commitmentItem),
      ...ceoItems.map(taskItem),
    ]);

  // Overlays live in a body-level portal (see hq-overlays.ts#mountHqOverlays).
  queueMicrotask(() => mountHqOverlays(ctx));

  return html`
    <div class="kis bhq ba-glass">
      ${baAurora()}
      ${BHQ_STYLE}
      <header class="bhq-header" data-learn-id="bhq-header">
        <div class="bhq-header-main">
          <div class="bhq-eyebrow">Business HQ</div>
          <h1 class="bhq-h1">What moves the business <span class="bag-gold-text">today</span></h1>
          <p class="bhq-lede">Everything here opens — click any number, card or row to see the full picture and act on it.</p>
        </div>
        <div class="bhq-header-side">
          <span class="bhq-updated ${refreshing ? "is-refreshing" : ""}" role="status" aria-live="polite">
            ${refreshing ? html`<span class="bhq-live-dot" aria-hidden="true"></span>` : nothing}${freshness}
          </span>
          ${ghostButton(refreshing ? "Syncing" : "Refresh", () => {
            void loadKanban(state);
            void loadHqObjects(state, client);
            void loadHqProgress(state, rpc);
          }, { iconName: "refresh", state: refreshing ? "busy" : "idle", title: "Refresh from the live board" })}
        </div>
      </header>

      ${err ? html`<div class="bhq-banner bhq-banner--err">Failed to load live data: ${err}</div>` : nothing}
      ${loadingBanner(state, loading, {
        onRetry: () => {
          void loadKanban(state);
          void loadHqObjects(state, client);
        },
        rerender: () => state.requestUpdate?.(),
      })}

      ${renderProgress(ctx)}
      ${renderTodaysFocus(ctx, loading)}

      <!-- KPI strip — every number opens the list behind it -->
      <div class="bhq-kpis" data-learn-id="bhq-kpis">
        ${statCard({ label: "Active work", value: loading ? "—" : active.length, tone: loading ? "muted" : "gold", sub: loading ? "board not responding" : `${openTasks.length} open on the board`, iconName: "inbox", onClick: () => openList(ctx, "Active work", active.map(taskItem)) })}
        ${statCard({ label: "Overdue", value: loading ? "—" : overdue.length, tone: loading ? "muted" : overdue.length ? "danger" : "ok", sub: loading ? "board not responding" : overdue.length ? "past their due date" : "nothing late", iconName: "clock", onClick: () => openList(ctx, "Overdue", overdue.map(taskItem), "Select to bulk mark done, reschedule or assign.") })}
        ${statCard({ label: "Blocked", value: loading ? "—" : blocked.length, tone: loading ? "muted" : blocked.length ? "danger" : "ok", sub: loading ? "board not responding" : blocked.length ? "waiting on something" : "nothing blocked", iconName: "alert", onClick: () => openList(ctx, "Blocked", blocked.map(taskItem)) })}
        ${statCard({ label: "Needs you", value: needsCeoCount, tone: needsCeoCount ? "warn" : "ok", sub: `${ceoDecs.length} decisions · ${criticalRisks.length} risks`, iconName: "star", onClick: listCeo })}
        ${statCard({ label: "Pipeline", value: oppObjs.length, tone: oppObjs.length ? "gold" : "muted", sub: money(oppObjs.reduce((s2, o) => s2 + (Number(o.estimatedValue) || 0), 0)), iconName: "coins", onClick: () => openList(ctx, "Pipeline", oppObjs.map(opportunityItem)) })}
        ${statCard({ label: "Active clients", value: clientItems.length || clientObjs.length, tone: clientItems.length || clientObjs.length ? "gold" : "muted", sub: clientItems.length ? "with live delivery" : "on the client list", iconName: "user", onClick: openClients })}
        ${statCard({ label: "Active projects", value: loading ? "—" : activeProjects.length, tone: loading || !activeProjects.length ? "muted" : "gold", sub: loading ? "board not responding" : `${projects.length} total`, iconName: "box", onClick: () => openList(ctx, "Active projects", activeProjects.map(({ p }) => projectItem(p))) })}
        ${statCard({ label: "Open risks", value: openRisks.length, tone: criticalRisks.length ? "danger" : openRisks.length ? "warn" : "ok", sub: `${criticalRisks.length} critical`, iconName: "shield", onClick: () => openList(ctx, "Open risks", openRisks.map(riskItem)) })}
      </div>

      <!-- Everything waiting on the owner -->
      ${section(
        {
          title: "Needs you",
          iconName: "star",
          subtitle: "Decisions, critical risks, overdue money and escalated work — open any to act.",
          count: needsCeoCount,
          countTone: needsCeoCount ? "warn" : "ok",
          onViewAll: listCeo,
        },
        needsCeoCount
          ? html`<div class="bhq-focus-list">
              ${ceoDecs.slice(0, 6).map(
                (d) => focusCard(ctx, decisionItem(d), [
                  chip("Decision", "warn"),
                  prioChip(d.priority),
                  d.decisionDeadline ? chip(`by ${d.decisionDeadline}`, "gold") : nothing,
                ], d.recommendation ? `rec: ${d.recommendation}` : d.owner || ""),
              )}
              ${criticalRisks.slice(0, 4).map((r) =>
                focusCard(ctx, riskItem(r), [chip("Critical risk", "danger"), prioChip(r.priority), r.riskScore ? chip(`score ${r.riskScore}`, "danger") : nothing], r.category || r.owner || ""),
              )}
              ${overdueCommits.slice(0, 4).map((c) =>
                focusCard(ctx, commitmentItem(c), [chip("Overdue commitment", "danger"), chip(money(c.remainingBalance || c.amount), "warn"), c.dueDate ? chip(`due ${c.dueDate}`, "danger") : nothing], c.owner || ""),
              )}
              ${ceoItems.slice(0, 8).map((t) => {
                const why = isBlocked(t)
                  ? "Blocked — needs unblocking"
                  : t.autonomousStatus === "pending_approval"
                    ? "Awaiting approval"
                    : isOverdue(t)
                      ? "Overdue"
                      : prioRank(t) >= 3
                        ? "Critical priority"
                        : "Escalated for review";
                return focusCard(ctx, taskItem(t), [chip(why, isBlocked(t) || isOverdue(t) ? "danger" : "warn"), chip(fmtDue(t), parseDue(t) !== null && isOverdue(t) ? "danger" : "gold")], projectName(t.projectId));
              })}
              ${ceoItems.length > 8 ? html`<button type="button" class="bhq-more" @click=${listCeo}>+${ceoItems.length - 8} more waiting on you</button>` : nothing}
            </div>`
          : emptyState("Nothing is waiting on you", {
              hint: "No decision, critical risk or overdue commitment has escalated.",
              actionLabel: "Open the command center",
              goTo: "/ceo",
              iconName: "star",
            }),
      )}

      <!-- Business Kanban — the live board, scoped to business work -->
      ${bandRow("Business Board", "Drag work between columns; switch to All tasks for the full board.")}
      ${renderKanbanSection(state, { variant: "business" })}

      <!-- Primary grid -->
      ${bandRow("Operating Picture", "Work, clients, pipeline and delivery.")}
      <div class="bhq-grid">
        ${section(
          {
            title: "Business",
            iconName: "inbox",
            subtitle: "Active work, what's most important, overdue, blocked, and coming next.",
            count: openTasks.length,
            countTone: "gold",
            onViewAll: () => openList(ctx, "All open work", openTasks.map(taskItem)),
          },
          openTasks.length
            ? html`
                ${subGroup(ctx, "blocked", blocked, 4, "danger")}
                ${subGroup(ctx, "overdue", overdue, 4, "danger")}
                ${subGroup(ctx, "most important", important, 5, "warn")}
                ${subGroup(ctx, "active now", active, 5, "gold")}
                ${subGroup(ctx, "coming next", comingNext, 5, "muted")}
              `
            : boardEmptyState(loading, "No open work on the board", {
                hint: "Every task is done, or the board has not been populated yet.",
                actionLabel: "Open the board",
                goTo: "/projects",
              }),
        )}

        ${section(
          {
            title: "Clients",
            iconName: "user",
            subtitle: "Active clients, what's promised, what's delivering, what needs attention.",
            count: clientItems.length || clientObjs.length,
            countTone: "muted",
            onViewAll: openClients,
            viewAllLabel: clientsInHub ? "Open in Business hub" : undefined,
          },
          clientsPid && clientItems.length
            ? html`${clientItems.slice(0, 8).map((t) => taskRow(ctx, t, { showProject: false }))}`
            : clientObjs.length
              ? html`${clientObjs.slice(0, 8).map((c) => objRow(ctx, clientItem(c), `${c.status || "client"}${c.pipelineStatus ? ` · ${c.pipelineStatus}` : ""}`, [], "in_progress"))}`
              : boardEmptyState(loading, "No active clients yet", {
                  hint: "Add clients in the Business hub to track what is promised, what is delivering, and what needs attention.",
                  actionLabel: "Open Business hub › Clients",
                  onAction: isTabAvailable("hub") ? () => openHubSection(state, "clients") : undefined,
                  goTo: "/clients",
                  iconName: "user",
                }),
        )}

        ${section(
          {
            title: "Opportunities",
            iconName: "coins",
            subtitle: "Pipeline stage, next action, and which need you.",
            count: useOppObjs ? oppObjs.length : oppItems.length,
            countTone: "muted",
            onViewAll: () => openList(ctx, "Pipeline", useOppObjs ? oppObjs.map(opportunityItem) : oppItems.map(taskItem)),
          },
          useOppObjs
            ? html`${[...oppObjs]
                .sort((a, b) => hqPriorityRank(a.priority) - hqPriorityRank(b.priority) || (b.estimatedValue || 0) - (a.estimatedValue || 0))
                .slice(0, 8)
                .map((o: HqOpportunity) =>
                  objRow(
                    ctx,
                    opportunityItem(o),
                    `${o.stage || o.status || "New"}${o.nextAction ? ` · next: ${o.nextAction}` : o.owner ? ` · ${o.owner}` : ""}`,
                    [
                      o.estimatedValue ? chip(money(o.estimatedValue), "gold") : nothing,
                      prioChip(o.priority),
                      o.needsAction ? chip("no next step", "warn") : nothing,
                      o.stale ? chip("going cold", "danger") : nothing,
                    ],
                    o.stage === "Won" ? "done" : "in_progress",
                  ),
                )}`
            : oppsPid && oppItems.length
              ? html`${oppItems.slice(0, 8).map((t) => taskRow(ctx, t, { showProject: false }))}`
              : emptyState("No opportunities on the register", {
                  hint: "Log the opportunities in play with a stage, a value and a next action. Day-to-day sales deals live in Business hub › Pipeline.",
                  iconName: "coins",
                  actionLabel: "Open Opportunities",
                  goTo: "/opportunities",
                }),
        )}

        ${section(
          {
            title: "Projects",
            iconName: "box",
            subtitle: "Active projects, owner, deadline, and what's blocking completion.",
            count: activeProjects.length,
            countTone: "muted",
            onViewAll: () => openList(ctx, "Active projects", activeProjects.map(({ p }) => projectItem(p))),
          },
          activeProjects.length
            ? html`${activeProjects.slice(0, 8).map(({ p, open, blockers }) =>
                rowButton(
                  () => openFocus(ctx, projectItem(p)),
                  "in_progress",
                  p.name,
                  html`${(p.assignedInstances && p.assignedInstances[0]) || "unassigned"} · ${open} open${p.dueDate ? html` · due ${new Date(p.dueDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : nothing}`,
                  [
                    typeof p.progress === "number" ? chip(`${p.progress}%`, "muted") : nothing,
                    blockers ? chip(`${blockers} blocker${blockers > 1 ? "s" : ""}`, "danger") : nothing,
                  ],
                ),
              )}`
            : boardEmptyState(loading, "No active projects", {
                hint: "Nothing is set to In progress, Reviewing or Updating right now.",
                iconName: "box",
                actionLabel: "Open the board",
                goTo: "/projects",
              }),
        )}

        ${/* Optional integration with the Products plugin: shown only while it is on. */
        !isTabAvailable("product-portfolio") ? nothing : section(
          {
            title: "Products",
            iconName: "box",
            subtitle: "Products & platforms that exist, what's in development, dependencies.",
            count: useProductObjs ? productObjs.length : productAll.length,
            countTone: "muted",
          },
          useProductObjs
            ? html`${productObjs.slice(0, 8).map((p: HqProduct) => {
                const live = /live|launched|shipped|active|ga/i.test(p.status || "");
                return rowButton(
                  () => emptyNav("/product-portfolio"),
                  live ? "done" : "in_progress",
                  p.name,
                  `${p.productType || "product"}${p.validationStage ? ` · ${p.validationStage}` : ""}`,
                  [live ? chip("live", "ok") : chip(p.status || "building", "gold"), prioChip(p.priority)],
                );
              })}`
            : productsPid && productAll.length
              ? html`${productAll.slice(0, 8).map((t) => taskRow(ctx, t, { showProject: false }))}`
              : emptyState("No products tracked yet", {
                  hint: "Record what you sell, and track commercial validation separately from whether it is built.",
                  actionLabel: "Open the Product Portfolio",
                  goTo: "/product-portfolio",
                  iconName: "box",
                }),
        )}
      </div>

      ${bandRow("Governance & Capacity", "Risk, decisions, money and who is available.")}
      <div class="bhq-grid bhq-grid--pair">
        ${section(
          {
            title: "Governance",
            iconName: "scale",
            subtitle: "Risk register, decision log, and commitment tracker.",
          },
          html`
            <div class="bhq-gov">
              <div class="bhq-gov-col">
                <div class="bhq-gov-h">${chip("Risk Register", (useRiskObjs ? openRisks.length : riskItems.length) ? "danger" : "muted")} <span class="bhq-group-n">${useRiskObjs ? openRisks.length : riskItems.length}</span></div>
                ${useRiskObjs
                  ? [...openRisks].sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0)).slice(0, 4).map((r: HqRisk) =>
                      objRow(ctx, riskItem(r), `${r.category || "risk"}${r.owner ? ` · ${r.owner}` : ""}`, [
                        r.riskScore ? chip(`score ${r.riskScore}`, isCriticalRisk(r) ? "danger" : "warn") : nothing,
                        prioChip(r.priority),
                      ]))
                  : riskItems.length
                  ? riskItems.slice(0, 4).map((t) => taskRow(ctx, t, { showProject: false }))
                  : emptyState("No open risks", { hint: "Nothing is currently on the register.", actionLabel: "Open the register", goTo: "/risks", iconName: "shield" })}
              </div>
              <div class="bhq-gov-col">
                <div class="bhq-gov-h">${chip("Decision Log", "gold")} <span class="bhq-group-n">${useDecisionObjs ? decisionObjs.length : decisionItems.length}</span></div>
                ${useDecisionObjs
                  ? decisionObjs.slice(0, 4).map((d: HqDecision) =>
                      objRow(ctx, decisionItem(d), `${d.status || "open"}${d.owner ? ` · ${d.owner}` : ""}`, [
                        d.ceoRequired && !/decided/i.test(d.status || "") ? chip("needs you", "warn") : nothing,
                        /decided/i.test(d.status || "") ? chip("decided", "ok") : nothing,
                        prioChip(d.priority),
                      ], /decided/i.test(d.status || "") ? "done" : "todo"))
                  : decisionItems.length
                  ? decisionItems.slice(0, 4).map((t) => taskRow(ctx, t, { showProject: false }))
                  : emptyState("No decisions logged", { hint: "Queue the choices the business has to make.", actionLabel: "Open Decisions", goTo: "/decisions", iconName: "scale" })}
              </div>
              <div class="bhq-gov-col">
                <div class="bhq-gov-h">${chip("Commitments", (useCommitmentObjs ? commitmentObjs.length : commitmentItems.length) ? "warn" : "muted")} <span class="bhq-group-n">${useCommitmentObjs ? commitmentObjs.length : commitmentItems.length}</span></div>
                ${useCommitmentObjs
                  ? commitmentObjs.slice(0, 4).map((c: HqCommitment) =>
                      objRow(ctx, commitmentItem(c), `${c.direction || ""}${c.owner ? ` · ${c.owner}` : ""}`, [
                        chip(money(c.remainingBalance || c.amount), /paid/i.test(c.status || "") ? "ok" : "warn"),
                        isOverdueCommitment(c) ? chip("overdue", "danger") : nothing,
                      ], /paid/i.test(c.status || "") ? "done" : "todo"))
                  : commitmentItems.length
                  ? commitmentItems.slice(0, 4).map((t) => taskRow(ctx, t, { showProject: false }))
                  : emptyState("No open commitments", { hint: "Nothing owed in or out is being tracked.", actionLabel: "Open the ledger", goTo: "/commitments", iconName: "coins" })}
              </div>
            </div>
          `,
        )}

        ${section(
          {
            title: "People & Resources",
            iconName: "user",
            subtitle: "Team, contractors, and partners — who is available and who owns what.",
            count: peopleObjs.length,
            countTone: "muted",
          },
          peopleObjs.length
            ? html`${peopleObjs.slice(0, 8).map((p: HqPerson) => {
                const owned = openTasks.filter((t) => (t.assignee || "").toLowerCase() === (p.name || "").toLowerCase());
                return rowButton(
                  () => openList(ctx, `${p.name} — open work`, owned.map(taskItem), owned.length ? "Select to reassign, reschedule or mark done." : "Nothing assigned right now."),
                  "todo",
                  p.name,
                  `${p.role || p.relationshipType || "person"}${p.availability ? ` · ${p.availability}` : ""}`,
                  [chip(`${owned.length} open`, owned.length > 5 ? "warn" : "muted"), p.status ? chip(p.status, /active|available/i.test(p.status) ? "ok" : "muted") : nothing],
                );
              })}`
            : emptyState(O.anyServed ? "No people on the roster" : "People store not served yet", {
                hint: O.anyServed
                  ? "Add the founders, employees, contractors and partners who do the work — capacity is derived automatically."
                  : "Restart the gateway so it serves person.* and this section fills in.",
                actionLabel: "Open the roster",
                goTo: "/people",
                iconName: "user",
              }),
        )}
      </div>

      <footer class="bhq-footer">
        Live from your task board and business records · every item opens · progress counts real completions only.
      </footer>
    </div>
  `;
}

function emptyNav(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function focusCard(ctx: HqCtx, item: HqItem, flags: unknown[], proj: string): TemplateResult {
  return html`
    <button type="button" class="bhq-focus ${hqUi.busy.has(item.id) ? "is-busy" : ""}" @click=${() => openFocus(ctx, item)}>
      <span class="bhq-focus-title">${item.title}</span>
      <span class="bhq-focus-meta">
        ${flags.filter((f) => f !== nothing)}
        <span class="bhq-focus-proj">${proj}</span>
      </span>
    </button>
  `;
}

/** A titled rule that groups the section grid into scannable bands. */
function bandRow(name: string, note: string): TemplateResult {
  return html`
    <div class="bhq-band">
      <h2 class="bhq-band-name">${name}</h2>
      <span class="bhq-band-note">${note}</span>
      <span class="bhq-band-rule"></span>
    </div>
  `;
}

// ── Styles ───────────────────────────────────────────────────────────────────
// `.bhq` layers HQ specifics on top of the shared `.kis` token system (see
// `kis-shared.ts`), so the dashboard, the two command centers and the object
// pages resolve to one spacing scale, one chip vocabulary and one row height.
// The root renders as `class="kis bhq"`.
const BHQ_STYLE = html`
  ${KIS_STYLE}
  <style>
    .bhq { gap: var(--s4); }

    .bhq-header {
      display: flex; justify-content: space-between; align-items: flex-start;
      gap: var(--s4); flex-wrap: wrap;
      padding-bottom: var(--s3); border-bottom: 1px solid var(--rule);
    }
    .bhq-eyebrow {
      font-size: 9.5px; letter-spacing: 0.18em; text-transform: uppercase;
      color: var(--gold); opacity: 0.9; margin-bottom: var(--s1); font-weight: 700;
    }
    .bhq-h1 {
      font-size: clamp(22px, 2.6vw, 30px); font-weight: 800; margin: 0;
      letter-spacing: -0.022em; line-height: 1.1;
      background: linear-gradient(104deg, #fff 8%, var(--gold) 84%);
      -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
    }
    .bhq-lede { margin: var(--s1) 0 0; color: var(--fg-dim); font-size: 11px; max-width: 74ch; }
    .bhq-header-side { display: flex; align-items: center; gap: var(--s2); flex: 0 0 auto; }
    .bhq-updated { font-size: 9.5px; color: var(--fg-muted); font-variant-numeric: tabular-nums; }

    .bhq-banner {
      background: var(--surface); border: 1px solid var(--rule); border-radius: var(--radius);
      padding: 7px var(--s3); font-size: 10.5px; color: var(--fg-muted);
    }
    .bhq-banner--err {
      border-color: color-mix(in srgb, var(--danger) 42%, transparent);
      background: color-mix(in srgb, var(--danger) 8%, transparent); color: #fecaca;
    }

    /* KPI strip — the shared stat card, in a denser grid */
    .bhq-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(146px, 1fr)); gap: var(--s2); }

    /* Section band label */
    .bhq-band { display: flex; align-items: center; gap: var(--s2); margin: var(--s2) 0 calc(var(--s1) * -1); }
    .bhq-band-name { margin: 0; font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--gold); font-weight: 800; white-space: nowrap; }
    .bhq-band-note { font-size: 10px; color: var(--fg-muted); white-space: nowrap; }
    .bhq-band-rule { flex: 1 1 auto; height: 1px; background: linear-gradient(90deg, var(--rule-strong), transparent); }

    /* Masonry-style column packing rather than a grid.
       A grid equalises row heights, so a short card (an empty state) next to a
       tall one (six opportunities) left a band of dead space, and an odd card
       count left a literal empty cell — at 1600px the 5-card Operating Picture
       had a ~220px hole in the bottom-right. Multicol packs each card directly
       under the previous one in its column and balances the columns, so the
       section closes up regardless of how many cards there are or how uneven
       they get. */
    .bhq-grid { columns: 1; column-gap: var(--s3); }
    .bhq-grid > * { break-inside: avoid; margin-bottom: var(--s3); }
    .bhq-grid > *:last-child { margin-bottom: 0; }
    @media (min-width: 900px) { .bhq-grid { columns: 2; } }
    @media (min-width: 1350px) { .bhq-grid { columns: 3; } }
    @media (min-width: 1900px) { .bhq-grid { columns: 4; } }
    /* Two-card band: balancing two cards across three or four columns leaves
       the trailing columns empty, so cap it at two full-width halves. */
    @media (min-width: 1350px) { .bhq-grid--pair { columns: 2; } }

    /* Section cards */
    .bhq-card {
      background: var(--surface); border: 1px solid var(--rule);
      border-radius: var(--radius); overflow: hidden;
      animation: kis-rise 300ms cubic-bezier(0.22, 0.8, 0.3, 1) both;
    }
    .bhq-card--accent {
      border-color: color-mix(in srgb, var(--gold) 42%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, var(--gold) 16%, transparent);
    }
    .bhq-card-head {
      display: flex; justify-content: space-between; align-items: center; gap: var(--s2);
      padding: var(--s2) var(--s3);
      border-bottom: 1px solid var(--rule);
      background: color-mix(in srgb, var(--gold) 5%, transparent);
    }
    .bhq-card-headmain { display: flex; align-items: center; gap: var(--s2); min-width: 0; }
    .bhq-card-icon { color: var(--gold); opacity: 0.8; display: flex; flex: 0 0 auto; }
    .bhq-card-title { margin: 0; font-size: 11.5px; font-weight: 800; letter-spacing: 0.09em; text-transform: uppercase; color: var(--fg); }
    .bhq-card--accent .bhq-card-title { color: var(--gold); }
    .bhq-card-sub { margin: 1px 0 0; font-size: 9.5px; color: var(--fg-muted); }
    .bhq-card-body { padding: var(--s2) var(--s3) var(--s3); display: flex; flex-direction: column; gap: var(--s3); }
    .bhq-count {
      flex: 0 0 auto; min-width: 22px; text-align: center; font-weight: 800; font-size: 11px;
      padding: 1px 7px; border-radius: 999px; background: var(--surface-3); color: var(--fg-dim);
      font-variant-numeric: tabular-nums;
    }
    .bhq-count--gold { color: var(--gold); }
    .bhq-count--danger { color: var(--danger); background: color-mix(in srgb, var(--danger) 16%, transparent); }
    .bhq-count--warn { color: var(--warn); }
    .bhq-count--ok { color: var(--ok); }

    /* Sub-groups inside a section */
    .bhq-group { display: flex; flex-direction: column; gap: var(--s1); }
    .bhq-group-label { display: flex; align-items: center; gap: 5px; }
    .bhq-group-n { font-size: 10px; color: var(--fg-muted); font-weight: 800; font-variant-numeric: tabular-nums; }
    .bhq-more { font-size: 9.5px; color: var(--fg-muted); padding: 2px var(--s2); }

    /* Rows */
    .bhq-row {
      display: flex; align-items: center; gap: var(--s2);
      padding: 5px var(--s2); border-radius: var(--radius-sm);
      transition: background 120ms ease;
      animation: kis-fade 240ms ease both;
    }
    .bhq-row:hover { background: color-mix(in srgb, var(--gold) 7%, transparent); }
    .bhq-row-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: var(--fg-muted); }
    .bhq-row-dot--in_progress { background: var(--gold); box-shadow: 0 0 6px color-mix(in srgb, var(--gold) 60%, transparent); }
    .bhq-row-dot--todo { background: var(--info); }
    .bhq-row-dot--review { background: #c084fc; }
    .bhq-row-dot--done { background: var(--ok); }
    .bhq-row-dot--backlog { background: var(--fg-muted); }
    .bhq-row-main { flex: 1 1 auto; min-width: 0; }
    .bhq-row-title { font-size: 11px; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bhq-row-sub { font-size: 9.5px; color: var(--fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bhq-row-flags { flex: 0 0 auto; display: flex; gap: var(--s1); align-items: center; }

    /* CEO focus spotlight */
    .bhq-focus-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s2); }
    @media (min-width: 800px) { .bhq-focus-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (min-width: 1250px) { .bhq-focus-list { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (min-width: 1800px) { .bhq-focus-list { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
    .bhq-focus {
      background: var(--surface-2);
      border: 1px solid color-mix(in srgb, var(--gold) 24%, transparent);
      border-radius: var(--radius); padding: var(--s2) var(--s3);
      display: flex; flex-direction: column; gap: 5px;
      animation: kis-rise 280ms cubic-bezier(0.22, 0.8, 0.3, 1) both;
      transition: border-color 140ms ease, background 140ms ease;
    }
    .bhq-focus:hover { border-color: color-mix(in srgb, var(--gold) 45%, transparent); background: var(--surface-3); }
    .bhq-focus-title { font-size: 11.5px; font-weight: 700; color: var(--fg); line-height: 1.35; }
    .bhq-focus-meta { display: flex; align-items: center; gap: var(--s1); flex-wrap: wrap; }
    .bhq-focus-proj { font-size: 9.5px; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; }

    /* Governance three-up */
    /* Stacked, not side-by-side. Three sub-columns inside one card of a
       3-up section is ~140px per column, which truncated every row to
       "Season-op…" / "One contr…" and made the register unreadable. Full-width
       groups cost vertical space the masonry column absorbs for free. */
    .bhq-gov { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s4); }
    .bhq-gov-col { display: flex; flex-direction: column; gap: var(--s1); }
    .bhq-gov-h { display: flex; align-items: center; gap: 5px; }

    .bhq-footer { font-size: 9.5px; color: var(--fg-muted); text-align: center; padding-top: var(--s2); opacity: 0.75; }

    /* ── Actionable layer ─────────────────────────────────────────────── */
    .bhq-row--btn { width: 100%; text-align: left; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; min-height: 34px; }
    .bhq-row--btn .bhq-row-main { display: flex; flex-direction: column; }
    .bhq-row--btn .bhq-row-title, .bhq-row--btn .bhq-row-sub { display: block; }
    .bhq-row--btn:focus-visible, .bhq-focus:focus-visible, .bhq-nba-main:focus-visible, .bhq-nba-go:focus-visible,
    .bhq-viewall:focus-visible, .bhq-more:focus-visible, .bhq-delegate:focus-visible, .bhq-prog-today:focus-visible {
      outline: 2px solid var(--gold); outline-offset: 2px;
    }
    .bhq-row-go { flex: 0 0 auto; color: var(--fg-muted); opacity: 0; transition: opacity 120ms ease, transform 120ms ease; font-size: 14px; line-height: 1; }
    .bhq-row--btn:hover .bhq-row-go, .bhq-row--btn:focus-visible .bhq-row-go { opacity: 1; transform: translateX(2px); color: var(--gold); }
    .bhq-row.is-busy, .bhq-focus.is-busy, .bhq-nba-item.is-busy { opacity: 0.55; pointer-events: none; }
    .bhq-row.is-done .bhq-row-title { text-decoration: line-through; color: var(--fg-muted); }
    button.bhq-more { background: none; border: 0; font: inherit; cursor: pointer; text-align: left; color: var(--gold); min-height: 28px; }
    button.bhq-focus { font: inherit; color: inherit; text-align: left; cursor: pointer; width: 100%; }
    .bhq-focus-title, .bhq-focus-meta { display: flex; }
    .bhq-card-headside { display: flex; align-items: center; gap: var(--s2); flex: 0 0 auto; }
    .bhq-viewall {
      font: inherit; font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
      padding: 4px 9px; min-height: 28px; border-radius: 999px; cursor: pointer;
      background: transparent; color: var(--gold); border: 1px solid var(--rule-strong);
    }
    .bhq-viewall:hover { background: color-mix(in srgb, var(--gold) 10%, transparent); }
    .bhq-viewall--sm { margin-left: auto; min-height: 24px; padding: 2px 8px; border-color: transparent; }
    .bhq-muted { color: var(--fg-muted); font-size: 10.5px; }

    /* Today's focus */
    .bhq-nba { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; counter-reset: nba; }
    .bhq-nba-item {
      display: flex; align-items: center; gap: var(--s2);
      padding: 6px 6px 6px var(--s2); border-radius: var(--radius);
      background: var(--surface-2); border: 1px solid var(--rule);
      transition: border-color 140ms ease, background 140ms ease;
      animation: kis-rise 260ms cubic-bezier(0.22, 0.8, 0.3, 1) both;
    }
    .bhq-nba-item:first-child { border-color: color-mix(in srgb, var(--gold) 45%, transparent); background: color-mix(in srgb, var(--gold) 7%, var(--surface-2)); }
    .bhq-nba-item:hover { border-color: var(--rule-strong); }
    .bhq-nba-rank {
      flex: 0 0 auto; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center;
      font-size: 10.5px; font-weight: 800; color: var(--gold); border: 1px solid var(--rule-strong);
      font-variant-numeric: tabular-nums;
    }
    .bhq-nba-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; background: none; border: 0; padding: 4px 2px; font: inherit; color: var(--fg); text-align: left; cursor: pointer; border-radius: 6px; }
    .bhq-nba-title { font-size: 12px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
    .bhq-nba-why { font-size: 10px; color: var(--fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
    .bhq-nba-kind { color: var(--gold); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; font-size: 9px; margin-right: 4px; }
    .bhq-nba-go {
      flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px; min-height: 34px; padding: 6px 12px;
      border-radius: 8px; border: 1px solid var(--gold); background: var(--gold); color: #17130a;
      font: inherit; font-size: 11px; font-weight: 800; cursor: pointer; white-space: nowrap;
      transition: transform 80ms ease, background 120ms ease;
    }
    .bhq-nba-go:hover:not([disabled]) { background: color-mix(in srgb, var(--gold) 86%, #fff); }
    .bhq-nba-go:active:not([disabled]) { transform: translateY(1px); }
    .bhq-nba-go[disabled] { opacity: 0.5; cursor: progress; }
    .bhq-today-foot { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; padding-top: var(--s1); border-top: 1px dashed var(--rule); }
    .bhq-delegate {
      display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 5px 12px; border-radius: 8px; cursor: pointer;
      font: inherit; font-size: 11px; font-weight: 700; color: var(--fg); background: var(--surface-3); border: 1px solid var(--rule-strong);
    }
    .bhq-delegate:hover { border-color: var(--gold); }
    .bhq-delegate-n { font-variant-numeric: tabular-nums; color: var(--gold); font-weight: 800; }
    .bhq-clear { display: flex; align-items: center; gap: var(--s3); font-size: 11.5px; color: var(--fg-dim); padding: var(--s2) 0; }
    .bhq-clear-mark { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; color: var(--ok); border: 1px solid color-mix(in srgb, var(--ok) 45%, transparent); flex: 0 0 auto; }
    .bhq-clear strong { color: var(--fg); }

    /* Progress strip */
    .bhq-progress {
      display: grid; grid-template-columns: minmax(220px, auto) auto auto minmax(0, 1fr) auto; align-items: center; gap: var(--s4);
      padding: var(--s2) var(--s3); border: 1px solid var(--rule); border-radius: var(--radius); background: var(--surface);
    }
    .bhq-progress--off { display: flex; gap: var(--s2); color: var(--fg-dim); font-size: 11px; }
    .bhq-progress--off code { font-size: 10.5px; color: var(--gold); }
    .bhq-prog-today { display: flex; align-items: center; gap: var(--s3); background: none; border: 0; padding: 2px; font: inherit; color: var(--fg); text-align: left; cursor: pointer; border-radius: 8px; }
    .bhq-prog-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .bhq-prog-text strong { font-size: 12.5px; }
    .bhq-ring-wrap { position: relative; width: 52px; height: 52px; flex: 0 0 auto; }
    .bhq-ring { transform: rotate(-90deg); display: block; }
    .bhq-ring-track { fill: none; stroke: var(--surface-3); stroke-width: 5; }
    .bhq-ring-fill { fill: none; stroke: var(--gold); stroke-width: 5; stroke-linecap: round; transition: stroke-dashoffset 600ms cubic-bezier(0.22, 0.8, 0.3, 1); }
    .bhq-ring.is-celebrating .bhq-ring-fill { stroke: var(--ok); }
    .bhq-ring.is-celebrating { animation: bhq-pop 700ms cubic-bezier(0.3, 1.6, 0.4, 1) both; }
    .bhq-ring-num { position: absolute; inset: 0; display: flex; align-items: baseline; justify-content: center; padding-top: 16px; font-size: 13px; font-weight: 800; font-variant-numeric: tabular-nums; }
    .bhq-ring-num small { font-size: 9px; color: var(--fg-muted); font-weight: 700; }
    .bhq-burst { position: absolute; inset: -8px; border-radius: 50%; border: 2px solid var(--ok); animation: bhq-burst 900ms ease-out both; pointer-events: none; }
    @keyframes bhq-pop { 0% { transform: rotate(-90deg) scale(1); } 40% { transform: rotate(-90deg) scale(1.14); } 100% { transform: rotate(-90deg) scale(1); } }
    @keyframes bhq-burst { from { opacity: 0.9; transform: scale(0.8); } to { opacity: 0; transform: scale(1.5); } }
    .bhq-prog-stat { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .bhq-prog-val { font-size: 18px; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1.1; }
    .bhq-prog-val.is-gold { color: var(--gold); }
    .bhq-prog-lbl { font-size: 10.5px; color: var(--fg-dim); }
    .bhq-prog-lbl em { color: var(--warn); font-style: normal; }
    .bhq-prog-deltas { display: flex; flex-wrap: wrap; gap: var(--s1); min-width: 0; }
    .bhq-delta { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 600; padding: 4px 9px; border-radius: 999px; border: 1px solid var(--rule); font-variant-numeric: tabular-nums; }
    .bhq-delta--good { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 55%, transparent); background: color-mix(in srgb, var(--ok) 15%, transparent); }
    .bhq-delta--bad { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, transparent); background: color-mix(in srgb, var(--danger) 8%, transparent); }
    .bhq-delta-from { opacity: 0.85; }
    .bhq-prog-actions { display: flex; gap: var(--s1); }
    @media (max-width: 1100px) {
      .bhq-progress { grid-template-columns: auto auto auto; }
      .bhq-prog-today { grid-column: 1 / -1; }
      .bhq-prog-deltas { grid-column: 1 / -1; }
      .bhq-prog-actions { justify-content: flex-end; }
    }
    .bhq-updated { display: inline-flex; align-items: center; gap: 6px; }
    .bhq-updated.is-refreshing { color: var(--gold); }
    .bhq-live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--gold); animation: kis-fade 900ms ease-in-out infinite alternate; }

    /* Phones */
    @media (max-width: 560px) {
      .kis.bhq { padding: var(--s4) var(--s3) 72px; }
      .bhq-header-side { width: 100%; justify-content: space-between; }
      .bhq-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .bhq-progress { grid-template-columns: 1fr 1fr; gap: var(--s3); }
      .bhq-prog-actions { grid-column: 1 / -1; justify-content: stretch; }
      .bhq-prog-actions .bhq-viewall { flex: 1 1 0; min-height: 36px; }
      .bhq-nba-item { flex-wrap: wrap; }
      .bhq-nba-main { flex-basis: calc(100% - 34px); }
      .bhq-nba-go { margin-left: 30px; min-height: 40px; flex: 1 1 auto; justify-content: center; }
      .bhq-row--btn { min-height: 44px; }
      .bhq-viewall { min-height: 32px; }
    }

    @media (prefers-reduced-motion: reduce) {
      .bhq-ring.is-celebrating, .bhq-burst, .bhq-nba-item, .bhq-live-dot { animation: none; }
      .bhq-ring-fill { transition: none; }
    }

    /* Light theme: the glass skin (ba-glass/hq.css) re-points the KIS tokens
       to the --bag-* layer, which already follows the theme. */
  </style>
`;

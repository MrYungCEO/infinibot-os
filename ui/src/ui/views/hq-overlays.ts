/**
 * Business HQ overlays — the places every dashboard number leads to.
 *
 *   • Focus modal: full context for one item (task, decision, risk,
 *     commitment, deal, client, project) plus its forward actions, each wired
 *     to a real RPC through `hq-actions.ts#performAction` (optimistic, rolled
 *     back on failure).
 *   • List modal: every item behind a KPI or section, with multi-select bulk
 *     done / reschedule / assign.
 *   • Delegate modal: proposes verified goal runs for delegable work. Nothing
 *     is spawned until the owner confirms.
 *   • Recap + settings modals.
 *
 * Keyboard: each modal traps focus, Esc closes the top-most one, and the focus
 * modal has single-key shortcuts (shown on the buttons) that fire only when
 * focus is not in a text field.
 */
import { html, nothing, render, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import type { AppViewState } from "../app-view-state";
import type { GatewayBrowserClient } from "../gateway";
import type { KanbanProject, KanbanTask } from "../types";
import { hqObjectsState, type HqPerson } from "../controllers/business-hq-objects";
import {
  askAgent,
  ensureAgents,
  hqUi,
  invalidateGoals,
  listGoals,
  performAction,
  saveHqSettings,
  showToast,
  type GoalSummary,
  type RpcClient,
} from "../controllers/hq-actions";
import {
  DAY_MS,
  GOAL_TAG,
  PIPELINE_ORDER,
  addDaysKey,
  appendNote,
  buildCoderSpawn,
  buildGoalPayload,
  dayKey,
  decisionAdvicePrompt,
  followupDraftPrompt,
  isTaskBlocked,
  isTaskDone,
  isTaskOverdue,
  parseSubtasks,
  planAction,
  planBulk,
  subtaskPrompt,
  taskItem,
  taskPrio,
  type ActionArgs,
  type ActionId,
  type HqItem,
  type HqMetricKey,
  type MetricDelta,
  type NextAction,
  type ProgressSummary,
} from "../controllers/hq-model";
import { icon } from "./kis-shared";
import { isTabAvailable } from "../plugin-host.js";
import { openHubSection } from "./ba-glass";
import "./ba-glass/hq.css";

// ── Context passed in by the dashboard each render ──────────────────────────

export interface HqCtx {
  state: AppViewState;
  client: GatewayBrowserClient;
  projects: KanbanProject[];
  tasks: KanbanTask[];
  people: HqPerson[];
  projectName: (id: string) => string;
  /** Where follow-up / mitigation tasks are created by default. */
  defaultTaskProjectId: string | null;
  taskProjectOptions: Array<{ id: string; name: string }>;
  progress: ProgressSummary;
  deltas: MetricDelta[];
  nextActions: NextAction[];
  delegation: KanbanTask[];
  detectedParentId: string | null;
  parentProjectId: string | null;
}

type Pane =
  | null
  | "reschedule"
  | "priority"
  | "assign"
  | "note"
  | "unblock"
  | "escalate"
  | "handoff"
  | "breakdown"
  | "decide"
  | "delegate"
  | "defer"
  | "ai"
  | "next"
  | "touch"
  | "followup"
  | "mitigate"
  | "renegotiate"
  | "draft";

interface FocusState {
  item: HqItem;
  pane: Pane;
  draft: Record<string, string>;
  ai: { loading: boolean; text?: string; error?: string };
  subtasks: string[] | null;
  runs: GoalSummary[] | null;
}

interface ListState {
  title: string;
  hint?: string;
  items: HqItem[];
  selected: Set<string>;
  pane: null | "reschedule" | "assign";
  draft: Record<string, string>;
}

interface DelegateState {
  tasks: KanbanTask[];
  selected: Set<string>;
  mode: "goal" | "coder";
  agentId: string;
  context: string;
  running: boolean;
  results: Array<{ id: string; ok: boolean; msg: string }> | null;
}

export const hqOverlay = {
  focus: null as FocusState | null,
  list: null as ListState | null,
  delegate: null as DelegateState | null,
  recap: false,
  settings: null as { target: string; parent: string } | null,
  returnFocus: [] as Array<HTMLElement | null>,
};

function deepActive(): HTMLElement | null {
  let a: Element | null = document.activeElement;
  while (a && (a as HTMLElement).shadowRoot?.activeElement) a = (a as HTMLElement).shadowRoot!.activeElement;
  return (a as HTMLElement) ?? null;
}

function rerender(ctx: HqCtx) {
  ctx.state.requestUpdate?.();
}

// ── Open / close ────────────────────────────────────────────────────────────

export function openFocus(ctx: HqCtx, item: HqItem, pane: Pane = null): void {
  hqOverlay.returnFocus.push(deepActive());
  hqOverlay.focus = { item, pane, draft: {}, ai: { loading: false }, subtasks: null, runs: null };
  if (item.kind === "task") {
    void listGoals(ctx.client as unknown as RpcClient).then((goals) => {
      if (hqOverlay.focus?.item.id !== item.id) return;
      hqOverlay.focus.runs = goals.filter((g) => (g.title || "").includes(GOAL_TAG(item.id)));
      rerender(ctx);
    });
  }
  void ensureAgents(ctx.state, ctx.client as unknown as RpcClient);
  rerender(ctx);
}

export function openList(ctx: HqCtx, title: string, items: HqItem[], hint?: string): void {
  hqOverlay.returnFocus.push(deepActive());
  hqOverlay.list = { title, hint, items, selected: new Set(), pane: null, draft: {} };
  rerender(ctx);
}

export function openDelegate(ctx: HqCtx, tasks: KanbanTask[]): void {
  hqOverlay.returnFocus.push(deepActive());
  hqOverlay.delegate = {
    tasks,
    selected: new Set(tasks.map((t) => t.id)),
    mode: "goal",
    agentId: "main",
    context: "",
    running: false,
    results: null,
  };
  void ensureAgents(ctx.state, ctx.client as unknown as RpcClient);
  rerender(ctx);
}

export function openRecap(ctx: HqCtx): void {
  hqOverlay.returnFocus.push(deepActive());
  hqOverlay.recap = true;
  rerender(ctx);
}

export function openSettings(ctx: HqCtx): void {
  hqOverlay.returnFocus.push(deepActive());
  hqOverlay.settings = { target: String(ctx.progress.target), parent: ctx.parentProjectId ?? "" };
  rerender(ctx);
}

function restoreFocus() {
  const el = hqOverlay.returnFocus.pop();
  if (el && el.isConnected) requestAnimationFrame(() => el.focus?.());
}

/** Close the top-most overlay. Returns false when nothing was open. */
export function closeTop(ctx: HqCtx): boolean {
  if (hqOverlay.focus) hqOverlay.focus = null;
  else if (hqOverlay.delegate) hqOverlay.delegate = null;
  else if (hqOverlay.list) hqOverlay.list = null;
  else if (hqOverlay.settings) hqOverlay.settings = null;
  else if (hqOverlay.recap) hqOverlay.recap = false;
  else return false;
  restoreFocus();
  rerender(ctx);
  return true;
}

// ── Focus management ────────────────────────────────────────────────────────

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const autoFocused = new WeakSet<Element>();
function focusFirst(el?: Element) {
  if (!el || autoFocused.has(el)) return;
  autoFocused.add(el);
  requestAnimationFrame(() => {
    const target =
      (el.querySelector("[data-autofocus]") as HTMLElement | null) ??
      (el.querySelector(FOCUSABLE) as HTMLElement | null);
    target?.focus();
  });
}

function isTyping(e: KeyboardEvent): boolean {
  const path = e.composedPath() as HTMLElement[];
  const t = path[0];
  const tag = (t?.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || !!t?.isContentEditable;
}

function trapTab(e: KeyboardEvent) {
  const dialog = e.currentTarget as HTMLElement;
  const nodes = Array.from(dialog.querySelectorAll(FOCUSABLE)) as HTMLElement[];
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const active = deepActive();
  if (e.shiftKey && (active === first || !dialog.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

function dialogKeydown(ctx: HqCtx, e: KeyboardEvent, shortcuts?: Record<string, () => void>) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    // Esc inside an open pane closes the pane first.
    if (hqOverlay.focus && hqOverlay.focus.pane && (e.currentTarget as HTMLElement).dataset.dialog === "focus") {
      hqOverlay.focus.pane = null;
      rerender(ctx);
      return;
    }
    closeTop(ctx);
    return;
  }
  if (e.key === "Tab") {
    trapTab(e);
    return;
  }
  if (!shortcuts || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  const fn = shortcuts[e.key.toLowerCase()];
  if (fn) {
    e.preventDefault();
    e.stopPropagation();
    fn();
  }
}

// ── Small render helpers ────────────────────────────────────────────────────

type Tone = "gold" | "danger" | "warn" | "ok" | "muted" | "info";
const chip = (label: string, tone: Tone = "muted") => html`<span class="kis-chip kis-chip--${tone}">${label}</span>`;

function kbd(k?: string) {
  return k ? html`<kbd class="hqm-kbd" aria-hidden="true">${k.toUpperCase()}</kbd>` : nothing;
}

function actBtn(
  label: string,
  onClick: () => void,
  opts: { key?: string; primary?: boolean; active?: boolean; disabled?: boolean; iconName?: string; danger?: boolean } = {},
): TemplateResult {
  return html`<button
    type="button"
    class="hqm-btn ${opts.primary ? "hqm-btn--primary" : ""} ${opts.active ? "is-active" : ""} ${opts.danger ? "hqm-btn--danger" : ""}"
    ?disabled=${opts.disabled}
    aria-pressed=${opts.active === undefined ? nothing : String(!!opts.active)}
    aria-keyshortcuts=${opts.key ? opts.key.toUpperCase() : nothing}
    @click=${onClick}
  >
    ${opts.iconName ? icon(opts.iconName, 12) : nothing}<span>${label}</span>${kbd(opts.key)}
  </button>`;
}

function field(label: string, value: unknown): TemplateResult | typeof nothing {
  if (value === undefined || value === null || value === "") return nothing;
  return html`<div class="hqm-field"><dt>${label}</dt><dd>${String(value)}</dd></div>`;
}

function money(n?: number): string {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1000) return `$${(v / 1000).toFixed(1)}k`;
  return `$${v}`;
}

function fmtDate(s?: string): string {
  if (!s) return "";
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return s;
  return new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

const draftVal = (key: string, fallback = "") => hqOverlay.focus?.draft[key] ?? fallback;
function setDraft(ctx: HqCtx, key: string, v: string, rerenderNow = false) {
  if (hqOverlay.focus) hqOverlay.focus.draft[key] = v;
  if (rerenderNow) rerender(ctx);
}

function input(ctx: HqCtx, key: string, opts: { label: string; type?: string; placeholder?: string; value?: string; list?: string; autofocus?: boolean }) {
  const id = `hqm-in-${key}`;
  return html`<label class="hqm-label" for=${id}>${opts.label}</label>
    <input
      id=${id}
      class="hqm-input"
      type=${opts.type ?? "text"}
      list=${opts.list ?? nothing}
      placeholder=${opts.placeholder ?? ""}
      .value=${draftVal(key, opts.value ?? "")}
      ?data-autofocus=${opts.autofocus}
      @input=${(e: Event) => setDraft(ctx, key, (e.target as HTMLInputElement).value)}
    />`;
}

function textarea(ctx: HqCtx, key: string, opts: { label: string; placeholder?: string; value?: string; rows?: number; autofocus?: boolean }) {
  const id = `hqm-ta-${key}`;
  return html`<label class="hqm-label" for=${id}>${opts.label}</label>
    <textarea
      id=${id}
      class="hqm-input hqm-textarea"
      rows=${opts.rows ?? 3}
      placeholder=${opts.placeholder ?? ""}
      .value=${draftVal(key, opts.value ?? "")}
      ?data-autofocus=${opts.autofocus}
      @input=${(e: Event) => setDraft(ctx, key, (e.target as HTMLTextAreaElement).value)}
    ></textarea>`;
}

function projectSelect(ctx: HqCtx, key = "projectId") {
  const cur = draftVal(key, ctx.defaultTaskProjectId ?? "");
  return html`<label class="hqm-label" for="hqm-sel-${key}">Task goes to</label>
    <select id="hqm-sel-${key}" class="hqm-input" @change=${(e: Event) => setDraft(ctx, key, (e.target as HTMLSelectElement).value)}>
      ${ctx.taskProjectOptions.length
        ? ctx.taskProjectOptions.map((p) => html`<option value=${p.id} ?selected=${p.id === cur}>${p.name}</option>`)
        : html`<option value="">No projects yet</option>`}
    </select>`;
}

// ── Actions ─────────────────────────────────────────────────────────────────

function act(ctx: HqCtx, item: HqItem, action: ActionId, args: ActionArgs = {}, opts: { closePane?: boolean; closeModal?: boolean } = {}) {
  let plan;
  try {
    plan = planAction(action, item, args);
  } catch (err) {
    showToast(ctx.state, err instanceof Error ? err.message : String(err), "err");
    return;
  }
  const undo =
    action === "task.done" && item.kind === "task"
      ? () => void act(ctx, taskItem({ ...item.raw, status: "done", done: true }), "task.reopen", { status: item.raw.status })
      : undefined;
  void performAction(ctx.state, ctx.client as unknown as RpcClient, item.id, plan, {
    undo,
    onDone: (r) => {
      if (!r.ok) return;
      if (hqOverlay.focus?.item.id === item.id) {
        if (opts.closeModal) {
          hqOverlay.focus = null;
          restoreFocus();
        } else if (opts.closePane !== false) {
          hqOverlay.focus.pane = null;
          hqOverlay.focus.draft = {};
        }
      }
    },
  });
}

async function handOff(ctx: HqCtx, tasks: KanbanTask[], mode: "goal" | "coder", agentId: string, context: string) {
  const client = ctx.client as unknown as RpcClient;
  const results: Array<{ id: string; ok: boolean; msg: string }> = [];
  for (const t of tasks) {
    hqUi.busy.add(t.id);
    rerender(ctx);
    try {
      let ref = "";
      if (mode === "goal") {
        const res = (await client.request("goals.create", buildGoalPayload(t, { mode, agentId, context }, ctx.projectName(t.projectId)))) as { id?: string };
        ref = `goal run ${res?.id ?? ""}`.trim();
      } else {
        const res = (await client.request("sessions.spawn", buildCoderSpawn(t, { mode, agentId, context }, ctx.projectName(t.projectId)))) as { runId?: string };
        ref = `coder run ${res?.runId ?? ""}`.trim();
      }
      const plan = {
        steps: [
          {
            method: "kanban.tasks.update",
            params: {
              id: t.id,
              patch: {
                assignedAgent: agentId,
                autonomousStatus: "in_progress",
                description: appendNote(t.description, `Handed to ${agentId} from Business HQ — ${ref}`),
              },
            },
          },
        ],
        optimistic: { kind: "task" as const, id: t.id, patch: { assignedAgent: agentId, autonomousStatus: "in_progress" } },
        success: "",
      };
      const { runPlan } = await import("../controllers/hq-actions");
      const run = await runPlan(ctx.state, client, plan);
      // The agent started, but the board write failed (and was rolled back).
      if (!run.ok) throw new Error(`Agent started (${ref}) but the task wasn't updated: ${run.error ?? "unknown error"}`);
      results.push({ id: t.id, ok: true, msg: ref });
    } catch (err) {
      results.push({ id: t.id, ok: false, msg: err instanceof Error ? err.message : String(err) });
    } finally {
      hqUi.busy.delete(t.id);
    }
  }
  invalidateGoals();
  const ok = results.filter((r) => r.ok).length;
  showToast(ctx.state, ok === results.length ? `Handed ${ok} task${ok === 1 ? "" : "s"} to agents` : `${ok}/${results.length} hand-offs started — see details`, ok === results.length ? "ok" : "err");
  return results;
}

async function runAi(ctx: HqCtx, prompt: string, onText?: (text: string) => void) {
  const f = hqOverlay.focus;
  if (!f) return;
  f.ai = { loading: true };
  rerender(ctx);
  try {
    const text = await askAgent(ctx.client as unknown as RpcClient, prompt);
    if (hqOverlay.focus === f) {
      f.ai = { loading: false, text };
      onText?.(text);
    }
  } catch (err) {
    if (hqOverlay.focus === f) f.ai = { loading: false, error: err instanceof Error ? err.message : String(err) };
  }
  rerender(ctx);
}

function aiBlock(ctx: HqCtx, retry: () => void): TemplateResult {
  const ai = hqOverlay.focus?.ai;
  if (!ai) return html``;
  if (ai.loading) return html`<div class="hqm-ai hqm-ai--loading" role="status" aria-live="polite"><span class="hqm-spinner" aria-hidden="true"></span>Asking an agent… this runs on your configured model.</div>`;
  if (ai.error)
    return html`<div class="hqm-ai hqm-ai--err" role="alert">${ai.error} ${actBtn("Try again", retry)}</div>`;
  return nothing as unknown as TemplateResult;
}

// ── Live item lookup (optimistic patches show immediately) ─────────────────

function liveItem(ctx: HqCtx, item: HqItem): HqItem {
  const O = hqObjectsState;
  switch (item.kind) {
    case "task": {
      const t = ctx.tasks.find((x) => x.id === item.id);
      return t ? { ...item, raw: t, title: t.title || item.title } : item;
    }
    case "decision": {
      const d = O.decisions.find((x) => x.id === item.id) ?? O.ceoDecisions.find((x) => x.id === item.id);
      return d ? { ...item, raw: d } : item;
    }
    case "risk": {
      const r = O.risks.find((x) => x.id === item.id);
      return r ? { ...item, raw: r } : item;
    }
    case "commitment": {
      const c = O.commitments.find((x) => x.id === item.id);
      return c ? { ...item, raw: c } : item;
    }
    case "opportunity": {
      const o = O.opportunities.find((x) => x.id === item.id);
      return o ? { ...item, raw: o } : item;
    }
    case "client": {
      const c = O.clients.find((x) => x.id === item.id);
      return c ? { ...item, raw: c } : item;
    }
    case "project": {
      const p = ctx.projects.find((x) => x.id === item.id);
      return p ? { ...item, raw: p } : item;
    }
  }
}

// ── Focus modal ─────────────────────────────────────────────────────────────

const KIND_LABEL: Record<HqItem["kind"], string> = {
  task: "Task",
  decision: "Decision",
  risk: "Risk",
  commitment: "Commitment",
  opportunity: "Deal",
  client: "Client",
  project: "Project",
};

function parseOptions(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/\n|;|\s\|\s/)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)]|[A-Z][.)])\s*/, "").trim())
    .filter((s) => s.length > 0 && s.length < 140)
    .slice(0, 6);
}

function renderFocus(ctx: HqCtx): TemplateResult | typeof nothing {
  const f = hqOverlay.focus;
  if (!f) return nothing;
  const item = liveItem(ctx, f.item);
  f.item = item;
  const busy = hqUi.busy.has(item.id);
  const setPane = (p: Pane) => {
    f.pane = f.pane === p ? null : p;
    f.draft = {};
    rerender(ctx);
  };

  let header: unknown[] = [];
  let details: TemplateResult = html``;
  let actions: TemplateResult[] = [];
  let pane: TemplateResult | typeof nothing = nothing;
  const shortcuts: Record<string, () => void> = {};
  const bind = (key: string, fn: () => void) => (shortcuts[key] = () => !busy && fn());

  if (item.kind === "task") {
    const t = item.raw;
    const done = isTaskDone(t);
    header = [
      done ? chip("done", "ok") : isTaskBlocked(t) ? chip("blocked", "danger") : isTaskOverdue(t) ? chip("overdue", "danger") : chip(t.status || "todo", "muted"),
      taskPrio(t) >= 3 ? chip("critical", "danger") : taskPrio(t) >= 2 ? chip("high", "warn") : nothing,
      t.autonomousStatus === "pending_approval" ? chip("awaiting approval", "warn") : nothing,
    ];
    const related = ctx.tasks.filter((x) => x.projectId === t.projectId && x.id !== t.id && !isTaskDone(x)).slice(0, 4);
    details = html`
      <dl class="hqm-fields">
        ${field("Project", ctx.projectName(t.projectId))}
        ${field("Due", t.dueDate ? fmtDate(t.dueDate) : "No date")}
        ${field("Priority", normPrio(t.priority || t.priorityLevel))}
        ${field("Owner", t.assignee || "Unassigned")}
        ${field("Agent", t.assignedAgent || undefined)}
        ${field("Agent status", t.autonomousStatus || undefined)}
        ${field("Updated", t.updatedAt ? new Date(t.updatedAt).toLocaleString() : undefined)}
      </dl>
      <section class="hqm-sec" aria-label="Notes and history">
        <h3 class="hqm-h">Notes &amp; history</h3>
        ${t.description?.trim()
          ? html`<pre class="hqm-notes">${t.description.trim().slice(-1600)}</pre>`
          : html`<p class="hqm-muted">No notes yet — add one to leave a trail.</p>`}
      </section>
      <section class="hqm-sec" aria-label="Linked agent runs">
        <h3 class="hqm-h">Linked agent runs</h3>
        ${f.runs === null
          ? html`<p class="hqm-muted">Loading…</p>`
          : f.runs.length
            ? f.runs.map(
                (g) => html`<div class="hqm-run">
                  ${chip(g.status, g.status === "completed" ? "ok" : /failed|exhausted|canceled/.test(g.status) ? "danger" : "gold")}
                  <span class="hqm-run-title">${g.title.replace(GOAL_TAG(t.id), "").trim()}</span>
                  <span class="hqm-muted">${g.checksPassing ?? 0}/${g.checksTotal ?? 0} checks · ${new Date(g.createdAt).toLocaleDateString()}</span>
                  <a class="hqm-link" href="/goals" @click=${(e: Event) => nav(e, ctx, "/goals")}>Open</a>
                </div>`,
              )
            : html`<p class="hqm-muted">No agent has worked on this yet.</p>`}
      </section>
      ${related.length
        ? html`<section class="hqm-sec" aria-label="Related work">
            <h3 class="hqm-h">Also open in ${ctx.projectName(t.projectId)}</h3>
            ${related.map((r) => relatedRow(ctx, taskItem(r), isTaskOverdue(r) ? "overdue" : r.status))}
          </section>`
        : nothing}
    `;
    const item_ = item;
    bind("d", () => act(ctx, item_, done ? "task.reopen" : "task.done", {}, { closeModal: !done }));
    bind("r", () => setPane("reschedule"));
    bind("p", () => setPane("priority"));
    bind("a", () => setPane("assign"));
    bind("h", () => setPane("handoff"));
    bind("b", () => setPane("breakdown"));
    bind("n", () => setPane("note"));
    bind("s", () => act(ctx, item_, "task.snooze", {}, { closeModal: true }));
    if (isTaskBlocked(t)) {
      bind("u", () => setPane("unblock"));
      bind("e", () => setPane("escalate"));
    } else bind("e", () => setPane("escalate"));
    if (t.autonomousStatus === "pending_approval") bind("y", () => act(ctx, item_, "task.approve"));
    actions = [
      ...(t.autonomousStatus === "pending_approval" ? [actBtn("Approve", shortcuts.y, { key: "y", primary: true, disabled: busy, iconName: "check" })] : []),
      ...(isTaskBlocked(t) ? [actBtn("Unblock", shortcuts.u, { key: "u", primary: true, active: f.pane === "unblock", disabled: busy })] : []),
      actBtn(done ? "Reopen" : "Mark done", shortcuts.d, { key: "d", primary: !isTaskBlocked(t) && t.autonomousStatus !== "pending_approval", disabled: busy, iconName: "check" }),
      actBtn("Reschedule", shortcuts.r, { key: "r", active: f.pane === "reschedule", disabled: busy, iconName: "clock" }),
      actBtn("Priority", shortcuts.p, { key: "p", active: f.pane === "priority", disabled: busy }),
      actBtn("Assign", shortcuts.a, { key: "a", active: f.pane === "assign", disabled: busy, iconName: "user" }),
      actBtn("Hand to an agent", shortcuts.h, { key: "h", active: f.pane === "handoff", disabled: busy || done }),
      actBtn("Break down", shortcuts.b, { key: "b", active: f.pane === "breakdown", disabled: busy || done }),
      actBtn("Add note", shortcuts.n, { key: "n", active: f.pane === "note", disabled: busy }),
      actBtn("Escalate", shortcuts.e, { key: "e", active: f.pane === "escalate", disabled: busy, iconName: "alert" }),
      actBtn("Snooze", shortcuts.s, { key: "s", disabled: busy }),
    ];
    pane = renderTaskPane(ctx, item_, f.pane, busy);
  } else if (item.kind === "decision") {
    const d = item.raw;
    const decided = /decided/i.test(d.status || "");
    header = [chip(d.status || "open", decided ? "ok" : "warn"), d.priority ? chip(d.priority, /P0/i.test(d.priority) ? "danger" : "warn") : nothing];
    details = html`
      ${d.decisionRequired ? html`<p class="hqm-question">${d.decisionRequired}</p>` : nothing}
      <dl class="hqm-fields">
        ${field("Needed by", d.decisionDeadline ? fmtDate(d.decisionDeadline) : undefined)}
        ${field("Owner", d.owner || undefined)}
        ${field("Requested by", d.requestedBy || undefined)}
        ${field("Type", d.decisionType || undefined)}
        ${field("Financial impact", d.financialImpact ? money(d.financialImpact) : undefined)}
      </dl>
      ${d.options ? html`<section class="hqm-sec"><h3 class="hqm-h">Options</h3><pre class="hqm-notes">${d.options}</pre></section>` : nothing}
      ${d.whyNow ? html`<section class="hqm-sec"><h3 class="hqm-h">Why now</h3><p>${d.whyNow}</p></section>` : nothing}
      ${d.impactIfDelayed ? html`<section class="hqm-sec"><h3 class="hqm-h">If delayed</h3><p>${d.impactIfDelayed}</p></section>` : nothing}
      ${d.recommendation ? html`<section class="hqm-sec"><h3 class="hqm-h">Recommendation</h3><p>${d.recommendation}</p></section>` : nothing}
    `;
    bind("d", () => setPane("decide"));
    bind("g", () => setPane("delegate"));
    bind("i", () => {
      setPane("ai");
      if (f.pane === "ai") void runAi(ctx, decisionAdvicePrompt(d));
    });
    bind("f", () => setPane("defer"));
    bind("s", () => act(ctx, item, "snooze", {}, { closeModal: true }));
    actions = [
      actBtn("Decide", shortcuts.d, { key: "d", primary: true, active: f.pane === "decide", disabled: busy || decided }),
      actBtn("Ask AI for a recommendation", shortcuts.i, { key: "i", active: f.pane === "ai", disabled: busy }),
      actBtn("Delegate", shortcuts.g, { key: "g", active: f.pane === "delegate", disabled: busy || decided, iconName: "user" }),
      actBtn("Defer", shortcuts.f, { key: "f", active: f.pane === "defer", disabled: busy || decided, iconName: "clock" }),
      actBtn("Snooze", shortcuts.s, { key: "s", disabled: busy }),
    ];
    pane = renderDecisionPane(ctx, item, f.pane, busy);
  } else if (item.kind === "risk") {
    const r = item.raw;
    header = [chip(r.status || "Open", /mitigated|closed/i.test(r.status || "") ? "ok" : "danger"), r.riskScore ? chip(`score ${r.riskScore}`, "danger") : nothing];
    details = html`<dl class="hqm-fields">
      ${field("Category", r.category)} ${field("Owner", r.owner || "Unassigned")} ${field("Priority", r.priority)}
      ${field("Level", r.riskLevel)} ${field("Exposure", r.financialValue ? money(r.financialValue) : undefined)}
      ${field("Next action", r.nextAction)} ${field("Next review", r.nextActionDate ? fmtDate(r.nextActionDate) : r.nextReviewDate)}
    </dl>`;
    bind("d", () => act(ctx, item, "risk.resolve", {}, { closeModal: true }));
    bind("m", () => setPane("mitigate"));
    bind("r", () => setPane("renegotiate"));
    bind("e", () => act(ctx, item, "risk.escalate"));
    bind("s", () => act(ctx, item, "snooze", {}, { closeModal: true }));
    actions = [
      actBtn("Mitigate (create task)", shortcuts.m, { key: "m", primary: true, active: f.pane === "mitigate", disabled: busy }),
      actBtn("Resolve", shortcuts.d, { key: "d", disabled: busy, iconName: "check" }),
      actBtn("Move review date", shortcuts.r, { key: "r", active: f.pane === "renegotiate", disabled: busy, iconName: "clock" }),
      actBtn("Escalate", shortcuts.e, { key: "e", disabled: busy, iconName: "alert" }),
      actBtn("Snooze", shortcuts.s, { key: "s", disabled: busy }),
    ];
    pane = renderObjectPane(ctx, item, f.pane, busy);
  } else if (item.kind === "commitment") {
    const c = item.raw;
    header = [chip(c.status || "Expected", /paid/i.test(c.status || "") ? "ok" : c.overdue ? "danger" : "warn"), chip(money(c.remainingBalance || c.amount), "gold")];
    details = html`<dl class="hqm-fields">
      ${field("Direction", c.direction)} ${field("Amount", money(c.amount))} ${field("Paid", money(c.amountPaid))}
      ${field("Remaining", money(c.remainingBalance))} ${field("Due", c.dueDate ? fmtDate(c.dueDate) : undefined)} ${field("Owner", c.owner || "Unassigned")}
    </dl>`;
    bind("d", () => act(ctx, item, "commitment.resolve", {}, { closeModal: true }));
    bind("r", () => setPane("renegotiate"));
    bind("m", () => setPane("mitigate"));
    bind("s", () => act(ctx, item, "snooze", {}, { closeModal: true }));
    actions = [
      actBtn("Resolve (settled)", shortcuts.d, { key: "d", primary: true, disabled: busy, iconName: "check" }),
      actBtn("Renegotiate date", shortcuts.r, { key: "r", active: f.pane === "renegotiate", disabled: busy, iconName: "clock" }),
      actBtn("Chase (create task)", shortcuts.m, { key: "m", active: f.pane === "mitigate", disabled: busy }),
      actBtn("Snooze", shortcuts.s, { key: "s", disabled: busy }),
    ];
    pane = renderObjectPane(ctx, item, f.pane, busy);
  } else if (item.kind === "opportunity") {
    const o = item.raw as typeof item.raw & { notes?: string; expectedCloseDate?: string };
    header = [chip(o.stage || "New", "gold"), o.estimatedValue ? chip(money(o.estimatedValue), "gold") : nothing, o.stale ? chip("going cold", "danger") : nothing];
    const idx = PIPELINE_ORDER.findIndex((s) => s.toLowerCase() === (o.stage || "New").toLowerCase());
    details = html`
      <ol class="hqm-ladder" aria-label="Pipeline stage">
        ${PIPELINE_ORDER.map((s, i) => html`<li class=${i <= idx ? "is-on" : ""} aria-current=${i === idx ? "step" : nothing}>${s}</li>`)}
      </ol>
      <dl class="hqm-fields">
        ${field("Owner", o.owner || "Unassigned")} ${field("Next step", o.nextAction || "None set")}
        ${field("Next step date", o.nextActionDate ? fmtDate(o.nextActionDate) : undefined)} ${field("Expected close", o.expectedCloseDate ? fmtDate(o.expectedCloseDate) : undefined)}
      </dl>
      ${o.notes ? html`<section class="hqm-sec"><h3 class="hqm-h">Notes &amp; touches</h3><pre class="hqm-notes">${o.notes.slice(-1200)}</pre></section>` : nothing}
    `;
    bind("x", () => setPane("next"));
    bind("v", () => act(ctx, item, "opportunity.advance"));
    bind("l", () => setPane("touch"));
    bind("f", () => setPane("followup"));
    bind("w", () => {
      setPane("draft");
      if (f.pane === "draft") void runAi(ctx, followupDraftPrompt(o.name, `${o.stage || ""} deal worth ${money(o.estimatedValue)}. ${o.nextAction ? `Next step: ${o.nextAction}.` : ""}`));
    });
    bind("s", () => act(ctx, item, "snooze", {}, { closeModal: true }));
    actions = [
      actBtn("Set next step", shortcuts.x, { key: "x", primary: true, active: f.pane === "next", disabled: busy }),
      actBtn(`Advance to ${PIPELINE_ORDER[Math.min(PIPELINE_ORDER.length - 1, idx + 1)]}`, shortcuts.v, { key: "v", disabled: busy || /won|lost/i.test(o.stage || "") }),
      actBtn("Log touch", shortcuts.l, { key: "l", active: f.pane === "touch", disabled: busy }),
      actBtn("Follow-up task", shortcuts.f, { key: "f", active: f.pane === "followup", disabled: busy }),
      actBtn("Draft message", shortcuts.w, { key: "w", active: f.pane === "draft", disabled: busy }),
      actBtn("Snooze", shortcuts.s, { key: "s", disabled: busy }),
    ];
    pane = renderObjectPane(ctx, item, f.pane, busy);
  } else if (item.kind === "client") {
    const c = item.raw;
    header = [chip(c.status || "active", "gold")];
    details = html`<dl class="hqm-fields">${field("Status", c.status)} ${field("Pipeline", c.pipelineStatus)} ${field("Owner", c.owner)}</dl>`;
    bind("l", () => setPane("touch"));
    bind("f", () => setPane("followup"));
    bind("w", () => {
      setPane("draft");
      if (f.pane === "draft") void runAi(ctx, followupDraftPrompt(c.name, c.pipelineStatus ? `Client status: ${c.pipelineStatus}` : ""));
    });
    actions = [
      actBtn("Log touch", shortcuts.l, { key: "l", primary: true, active: f.pane === "touch", disabled: busy }),
      actBtn("Follow-up task", shortcuts.f, { key: "f", active: f.pane === "followup", disabled: busy }),
      actBtn("Draft message", shortcuts.w, { key: "w", active: f.pane === "draft", disabled: busy }),
      // The client list lives in agency.db — the same store as Business hub › Clients.
      actBtn(isTabAvailable("hub") ? "Open in Business hub" : "Open client", () =>
        isTabAvailable("hub") ? openHub(ctx, "clients") : nav(null, ctx, "/clients"),
      ),
    ];
    pane = renderObjectPane(ctx, item, f.pane, busy);
  } else if (item.kind === "project") {
    const p = item.raw;
    const open = ctx.tasks.filter((t) => t.projectId === p.id && !isTaskDone(t));
    const stuck = open.filter((t) => isTaskBlocked(t) || isTaskOverdue(t));
    header = [chip(p.status || "—", "gold"), typeof p.progress === "number" ? chip(`${p.progress}%`, "muted") : nothing, stuck.length ? chip(`${stuck.length} blocking`, "danger") : nothing];
    details = html`
      <dl class="hqm-fields">${field("Due", p.dueDate ? fmtDate(p.dueDate) : undefined)} ${field("Owner", p.assignedInstances?.[0])} ${field("Open tasks", open.length)}</dl>
      <section class="hqm-sec"><h3 class="hqm-h">What's blocking completion</h3>
        ${stuck.length ? stuck.slice(0, 6).map((t) => relatedRow(ctx, taskItem(t), isTaskBlocked(t) ? "blocked" : "overdue")) : html`<p class="hqm-muted">Nothing blocked or overdue.</p>`}
      </section>`;
    bind("b", () => openList(ctx, `${p.name} — open tasks`, open.map(taskItem)));
    bind("o", () => nav(null, ctx, "/projects"));
    actions = [
      actBtn("Select tasks…", shortcuts.b, { key: "b", primary: true, disabled: !open.length }),
      actBtn("Open in Projects", shortcuts.o, { key: "o" }),
    ];
  }

  const celebrating = hqUi.celebrate && hqUi.celebrate.id === item.id && Date.now() - hqUi.celebrate.at < 1800;
  return html`
    <div class="hqm-backdrop" @click=${(e: Event) => e.target === e.currentTarget && closeTop(ctx)}>
      <div
        class="ba-glass hqm-dialog ${celebrating ? "is-celebrating" : ""}"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hqm-focus-title"
        data-dialog="focus"
        ${ref(focusFirst)}
        @keydown=${(e: KeyboardEvent) => dialogKeydown(ctx, e, shortcuts)}
      >
        <header class="hqm-head">
          <div class="hqm-head-main">
            <span class="hqm-kind">${KIND_LABEL[item.kind]}</span>
            <h2 id="hqm-focus-title" class="hqm-title">${item.title}</h2>
            <div class="hqm-chips">${header}</div>
          </div>
          <button type="button" class="hqm-x" aria-label="Close (Esc)" @click=${() => closeTop(ctx)}>${icon("x", 14)}</button>
        </header>
        <div class="hqm-body">
          ${details}
        </div>
        <footer class="hqm-actions-wrap">
          <div class="hqm-actions" role="toolbar" aria-label="Actions">${actions}</div>
          ${pane}
          <p class="hqm-hint">Shortcuts work when you're not typing · Esc closes</p>
        </footer>
      </div>
    </div>
  `;
}

function relatedRow(ctx: HqCtx, item: HqItem, status?: string) {
  return html`<button type="button" class="hqm-related" @click=${() => openFocus(ctx, item)}>
    <span class="hqm-related-title">${item.title}</span>${status ? chip(status, status === "overdue" || status === "blocked" ? "danger" : "muted") : nothing}
  </button>`;
}

function nav(e: Event | null, ctx: HqCtx, path: string) {
  e?.preventDefault();
  hqOverlay.focus = null;
  hqOverlay.list = null;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  rerender(ctx);
}

/** Close the HQ overlays and open a Business hub section. */
function openHub(ctx: HqCtx, section: "clients") {
  hqOverlay.focus = null;
  hqOverlay.list = null;
  hqOverlay.returnFocus = [];
  openHubSection(ctx.state, section);
  rerender(ctx);
}

function paneWrap(title: string, body: TemplateResult): TemplateResult {
  return html`<div class="hqm-pane" role="group" aria-label=${title}><div class="hqm-pane-h">${title}</div>${body}</div>`;
}

function quickDates(ctx: HqCtx, onPick: (args: ActionArgs) => void, busy: boolean, opts: { labels?: [string, number][] } = {}) {
  const labels = opts.labels ?? [["Tomorrow", 1], ["+3 days", 3], ["Next week", 7]];
  return html`<div class="hqm-row">
      ${labels.map(([l, d]) => actBtn(l, () => onPick({ days: d }), { disabled: busy }))}
    </div>
    <div class="hqm-row hqm-row--form">
      <div class="hqm-grow">${input(ctx, "date", { label: "Or pick a date", type: "date", value: addDaysKey(Date.now(), 1) })}</div>
      ${actBtn("Apply", () => onPick({ date: draftVal("date", addDaysKey(Date.now(), 1)) }), { primary: true, disabled: busy })}
    </div>`;
}

function renderTaskPane(ctx: HqCtx, item: HqItem & { kind: "task" }, pane: Pane, busy: boolean) {
  const t = item.raw;
  switch (pane) {
    case "reschedule":
      return paneWrap("Reschedule", quickDates(ctx, (a) => act(ctx, item, "task.reschedule", a), busy));
    case "priority":
      return paneWrap(
        "Set priority",
        html`<div class="hqm-row">${(["low", "medium", "high", "critical"] as const).map((p) =>
          actBtn(p, () => act(ctx, item, "task.priority", { priority: p }), { active: normPrio(t.priority) === p, disabled: busy }),
        )}</div>`,
      );
    case "assign":
      return paneWrap(
        "Assign",
        html`<datalist id="hqm-people">${ctx.people.map((p) => html`<option value=${p.name}></option>`)}</datalist>
          <div class="hqm-row hqm-row--form">
            <div class="hqm-grow">${input(ctx, "person", { label: "Person", list: "hqm-people", placeholder: "Name", value: t.assignee || "", autofocus: true })}</div>
            ${actBtn("Assign person", () => act(ctx, item, "task.assign", { person: draftVal("person", t.assignee || "").trim() }), { primary: true, disabled: busy })}
          </div>
          <div class="hqm-row hqm-row--form">
            <div class="hqm-grow">
              <label class="hqm-label" for="hqm-agent">Or an agent</label>
              <select id="hqm-agent" class="hqm-input" @change=${(e: Event) => setDraft(ctx, "agent", (e.target as HTMLSelectElement).value)}>
                ${agentOptions(draftVal("agent", t.assignedAgent || "main"))}
              </select>
            </div>
            ${actBtn("Assign agent", () => act(ctx, item, "task.assignAgent", { agentId: draftVal("agent", t.assignedAgent || "main") }), { disabled: busy })}
          </div>
          <p class="hqm-muted">Assigning an agent records ownership only — use "Hand to an agent" to start work.</p>`,
      );
    case "note":
      return paneWrap(
        "Add note",
        html`${textarea(ctx, "note", { label: "Note", placeholder: "What happened / what's next", autofocus: true })}
          <div class="hqm-row">${actBtn("Save note", () => act(ctx, item, "task.note", { text: draftVal("note") }), { primary: true, disabled: busy })}</div>`,
      );
    case "unblock":
      return paneWrap(
        "Unblock",
        html`${textarea(ctx, "unblock", { label: "What's needed / what changed", placeholder: "e.g. API key added to vault; client approved scope", autofocus: true })}
          <div class="hqm-row">${actBtn("Unblock", () => act(ctx, item, "task.unblock", { text: draftVal("unblock") }), { primary: true, disabled: busy })}</div>`,
      );
    case "escalate":
      return paneWrap(
        "Escalate",
        html`${textarea(ctx, "esc", { label: "Why (optional)", placeholder: "Who needs to act and by when", autofocus: true })}
          <div class="hqm-row">${actBtn("Escalate to critical", () => act(ctx, item, "task.escalate", { text: draftVal("esc") }), { primary: true, danger: true, disabled: busy })}</div>`,
      );
    case "handoff":
      return paneWrap(
        "Hand to an agent",
        html`<div class="hqm-row" role="radiogroup" aria-label="How">
            ${actBtn("Verified goal run", () => setDraft(ctx, "mode", "goal", true), { active: draftVal("mode", "goal") === "goal" })}
            ${actBtn("Coder session", () => setDraft(ctx, "mode", "coder", true), { active: draftVal("mode", "goal") === "coder" })}
          </div>
          <label class="hqm-label" for="hqm-h-agent">Agent</label>
          <select id="hqm-h-agent" class="hqm-input" @change=${(e: Event) => setDraft(ctx, "agent", (e.target as HTMLSelectElement).value)}>
            ${agentOptions(draftVal("agent", draftVal("mode", "goal") === "coder" ? "coder" : "main"))}
          </select>
          ${textarea(ctx, "ctx", { label: "Anything the agent should know (optional)", rows: 2 })}
          <p class="hqm-muted">${draftVal("mode", "goal") === "goal"
            ? "A goal run keeps working until an LLM judge sees evidence the task is actually done (max 3 attempts, 1h). You'll be notified of the verdict."
            : "Spawns a coder session with this task as its brief. Progress shows in Agents."}</p>
          <div class="hqm-row">${actBtn(
            "Confirm & start",
            () => {
              const mode = draftVal("mode", "goal") as "goal" | "coder";
              const agentId = draftVal("agent", mode === "coder" ? "coder" : "main");
              void handOff(ctx, [t], mode, agentId, draftVal("ctx")).then(() => {
                if (hqOverlay.focus) {
                  hqOverlay.focus.pane = null;
                  hqOverlay.focus.runs = null;
                  void listGoals(ctx.client as unknown as RpcClient, true).then((g) => {
                    if (hqOverlay.focus?.item.id === t.id) hqOverlay.focus.runs = g.filter((x) => x.title.includes(GOAL_TAG(t.id)));
                    rerender(ctx);
                  });
                }
              });
            },
            { primary: true, disabled: busy },
          )}</div>`,
      );
    case "breakdown": {
      const f = hqOverlay.focus!;
      const ask = () =>
        void runAi(ctx, subtaskPrompt(t), (text) => {
          f.subtasks = parseSubtasks(text);
          f.draft.subtasks = f.subtasks.join("\n");
        });
      return paneWrap(
        "Break down into subtasks",
        html`${f.subtasks === null && !f.ai.loading && !f.ai.error
            ? html`<div class="hqm-row">${actBtn("Ask AI for subtasks", ask, { primary: true })} ${actBtn("Write my own", () => { f.subtasks = []; rerender(ctx); })}</div>`
            : nothing}
          ${aiBlock(ctx, ask)}
          ${f.subtasks !== null
            ? html`${textarea(ctx, "subtasks", { label: "One subtask per line — edit before creating", rows: 5, value: f.subtasks.join("\n"), autofocus: true })}
                <div class="hqm-row">${actBtn(
                  `Create ${draftVal("subtasks", f.subtasks.join("\n")).split("\n").filter((s) => s.trim()).length} subtasks in ${ctx.projectName(t.projectId)}`,
                  () => act(ctx, item, "task.subtasks", { subtasks: draftVal("subtasks", f.subtasks!.join("\n")).split("\n") }),
                  { primary: true, disabled: busy },
                )}</div>`
            : nothing}`,
      );
    }
  }
  return nothing;
}

/** The two task backends name priorities differently (critical vs immediate, normal vs medium). */
function normPrio(p?: string): string {
  const v = (p || "medium").toLowerCase();
  if (v === "immediate" || v === "urgent") return "critical";
  if (v === "normal") return "medium";
  return v;
}

function agentOptions(current: string) {
  const list = hqUi.agents.length ? hqUi.agents : [{ id: "main", name: "Main" }, { id: "coder", name: "Coder" }];
  return list.map((a) => html`<option value=${a.id} ?selected=${a.id === current}>${a.name || a.id}${a.name && a.name !== a.id ? ` (${a.id})` : ""}</option>`);
}

function renderDecisionPane(ctx: HqCtx, item: HqItem & { kind: "decision" }, pane: Pane, busy: boolean) {
  const d = item.raw;
  const f = hqOverlay.focus!;
  switch (pane) {
    case "decide": {
      const options = parseOptions(d.options);
      const recOpt = (d.recommendation || "").replace(/^recommend:\s*/i, "").split("\n")[0].trim();
      return paneWrap(
        "Record the decision",
        html`${options.length
            ? html`<div class="hqm-row" role="radiogroup" aria-label="Options">${options.map((o) =>
                actBtn(o, () => setDraft(ctx, "option", o, true), { active: draftVal("option") === o }),
              )}</div>`
            : nothing}
          ${input(ctx, "option", { label: "Decision", placeholder: recOpt || "What did you decide?", value: "", autofocus: !options.length })}
          ${textarea(ctx, "rationale", { label: "Rationale (kept in the decision log)", rows: 2 })}
          <div class="hqm-row">${actBtn("Record decision", () => act(ctx, item, "decision.decide", { option: draftVal("option").trim(), rationale: draftVal("rationale") }, { closeModal: true }), { primary: true, disabled: busy })}</div>`,
      );
    }
    case "delegate":
      return paneWrap(
        "Delegate",
        html`<datalist id="hqm-people">${ctx.people.map((p) => html`<option value=${p.name}></option>`)}</datalist>
          ${input(ctx, "person", { label: "Who prepares / decides", list: "hqm-people", autofocus: true })}
          <p class="hqm-muted">Moves it off your queue back to Preparing with the new owner.</p>
          <div class="hqm-row">${actBtn("Delegate", () => act(ctx, item, "decision.delegate", { person: draftVal("person").trim() }, { closeModal: true }), { primary: true, disabled: busy })}</div>`,
      );
    case "defer":
      return paneWrap("Defer until", quickDates(ctx, (a) => act(ctx, item, "decision.defer", a, { closeModal: true }), busy, { labels: [["+1 week", 7], ["+2 weeks", 14], ["+1 month", 30]] }));
    case "ai": {
      const retry = () => void runAi(ctx, decisionAdvicePrompt(d));
      return paneWrap(
        "AI recommendation",
        html`${aiBlock(ctx, retry)}
          ${f.ai.text
            ? html`<pre class="hqm-notes hqm-ai-answer" aria-live="polite">${f.ai.text}</pre>
                <div class="hqm-row">
                  ${actBtn("Decide with this", () => {
                    const m = f.ai.text!.match(/recommend:\s*(.+)/i);
                    f.pane = "decide";
                    f.draft = { option: (m?.[1] ?? "").trim(), rationale: f.ai.text!.split("\n").slice(1).join("\n").trim() };
                    rerender(ctx);
                  }, { primary: true })}
                  ${actBtn("Save as recommendation", () => act(ctx, item, "decision.saveRecommendation", { text: f.ai.text! }), { disabled: busy })}
                </div>`
            : nothing}`,
      );
    }
  }
  return nothing;
}

function renderObjectPane(ctx: HqCtx, item: HqItem, pane: Pane, busy: boolean) {
  const f = hqOverlay.focus!;
  const pid = () => draftVal("projectId", ctx.defaultTaskProjectId ?? "");
  switch (pane) {
    case "renegotiate": {
      const action: ActionId = item.kind === "risk" ? "risk.renegotiate" : "commitment.renegotiate";
      return paneWrap(item.kind === "risk" ? "Move the review date" : "Renegotiate the due date", quickDates(ctx, (a) => act(ctx, item, action, a), busy, { labels: [["+1 week", 7], ["+2 weeks", 14], ["+1 month", 30]] }));
    }
    case "mitigate": {
      const action: ActionId = item.kind === "risk" ? "risk.mitigate" : "commitment.mitigate";
      return paneWrap(
        item.kind === "risk" ? "Create a mitigation task" : "Create a chase task",
        html`${input(ctx, "title", { label: "Task", value: item.kind === "risk" ? `Mitigate risk: ${item.title}` : `Chase / renegotiate: ${item.title}`, autofocus: true })}
          ${projectSelect(ctx)}
          <div class="hqm-row">${actBtn("Create task", () => act(ctx, item, action, { text: draftVal("title"), projectId: pid() }), { primary: true, disabled: busy || !pid() })}</div>`,
      );
    }
    case "next":
      return paneWrap(
        "Next step",
        html`${input(ctx, "text", { label: "Next step", placeholder: "e.g. Send revised proposal", autofocus: true })}
          ${input(ctx, "date", { label: "By", type: "date", value: addDaysKey(Date.now(), 2) })}
          <div class="hqm-row">${actBtn("Save next step", () => act(ctx, item, "opportunity.next", { text: draftVal("text"), date: draftVal("date", addDaysKey(Date.now(), 2)) }), { primary: true, disabled: busy })}</div>`,
      );
    case "touch": {
      const action: ActionId = item.kind === "client" ? "client.touch" : "opportunity.touch";
      return paneWrap(
        "Log a touch",
        html`${textarea(ctx, "text", { label: "What happened", placeholder: "Call, email, meeting — and the outcome", autofocus: true })}
          <div class="hqm-row">${actBtn("Log touch", () => act(ctx, item, action, { text: draftVal("text") }), { primary: true, disabled: busy })}</div>`,
      );
    }
    case "followup": {
      const action: ActionId = item.kind === "client" ? "client.followup" : "opportunity.followup";
      return paneWrap(
        "Follow-up task",
        html`${input(ctx, "text", { label: "Task", value: `Follow up: ${item.title}`, autofocus: true })}
          ${input(ctx, "date", { label: "Due", type: "date", value: addDaysKey(Date.now(), 2) })}
          ${projectSelect(ctx)}
          <div class="hqm-row">${actBtn("Create task", () => act(ctx, item, action, { text: draftVal("text", `Follow up: ${item.title}`), date: draftVal("date", addDaysKey(Date.now(), 2)), projectId: pid() }), { primary: true, disabled: busy || !pid() })}</div>`,
      );
    }
    case "draft": {
      const name = item.title;
      const retry = () => void runAi(ctx, followupDraftPrompt(name, ""));
      return paneWrap(
        "Message draft",
        html`${aiBlock(ctx, retry)}
          ${f.ai.text
            ? html`${textarea(ctx, "draft", { label: "Draft — edit freely", rows: 5, value: f.ai.text })}
                <div class="hqm-row">
                  ${actBtn("Copy", () => {
                    void navigator.clipboard?.writeText(draftVal("draft", f.ai.text!)).then(
                      () => showToast(ctx.state, "Draft copied"),
                      () => showToast(ctx.state, "Couldn't copy — select the text instead", "err"),
                    );
                  }, { primary: true })}
                  ${actBtn("Save as follow-up task", () => {
                    const action: ActionId = item.kind === "client" ? "client.followup" : "opportunity.followup";
                    const plan = planAction(action, item, { text: `Send follow-up: ${name}`, projectId: pid() });
                    // Carry the draft in the task description.
                    const first = plan.steps[0];
                    first.params = { ...(first.params as Record<string, unknown>), description: draftVal("draft", f.ai.text!) };
                    void performAction(ctx.state, ctx.client as unknown as RpcClient, item.id, plan);
                  }, { disabled: busy || !pid() })}
                </div>`
            : nothing}`,
      );
    }
  }
  return nothing;
}

// ── List modal (bulk) ───────────────────────────────────────────────────────

function renderList(ctx: HqCtx): TemplateResult | typeof nothing {
  const l = hqOverlay.list;
  if (!l) return nothing;
  // Refresh items from live state so optimistic changes show.
  l.items = l.items.map((i) => liveItem(ctx, i));
  const taskItems = l.items.filter((i) => i.kind === "task") as Array<HqItem & { kind: "task" }>;
  const selectable = taskItems.filter((i) => !isTaskDone(i.raw));
  const sel = selectable.filter((i) => l.selected.has(i.id));
  const allOn = selectable.length > 0 && sel.length === selectable.length;
  const toggle = (id: string) => {
    if (l.selected.has(id)) l.selected.delete(id);
    else l.selected.add(id);
    rerender(ctx);
  };
  const bulk = async (action: "task.done" | "task.reschedule" | "task.assign", args: ActionArgs = {}) => {
    const tasks = sel.map((i) => i.raw);
    if (!tasks.length) return;
    let plans;
    try {
      plans = planBulk(action, tasks, args);
    } catch (err) {
      showToast(ctx.state, err instanceof Error ? err.message : String(err), "err");
      return;
    }
    const { runPlan } = await import("../controllers/hq-actions");
    let ok = 0;
    for (let i = 0; i < plans.length; i++) {
      hqUi.busy.add(tasks[i].id);
      const r = await runPlan(ctx.state, ctx.client as unknown as RpcClient, plans[i]);
      hqUi.busy.delete(tasks[i].id);
      if (r.ok) ok++;
    }
    if (action === "task.done" && ok) hqUi.celebrate = { id: "bulk", at: Date.now() };
    l.selected.clear();
    l.pane = null;
    showToast(ctx.state, ok === plans.length ? `${ok} task${ok === 1 ? "" : "s"} updated` : `${ok}/${plans.length} updated — the rest were rolled back`, ok === plans.length ? "ok" : "err");
    const { loadHqProgress } = await import("../controllers/hq-actions");
    void loadHqProgress(ctx.state, ctx.client as unknown as RpcClient);
    rerender(ctx);
  };
  const lDraft = (k: string, fb = "") => l.draft[k] ?? fb;

  return html`
    <div class="hqm-backdrop" @click=${(e: Event) => e.target === e.currentTarget && closeTop(ctx)}>
      <div class="ba-glass hqm-dialog hqm-dialog--list" role="dialog" aria-modal="true" aria-labelledby="hqm-list-title" data-dialog="list" ${ref(focusFirst)} @keydown=${(e: KeyboardEvent) => dialogKeydown(ctx, e)}>
        <header class="hqm-head">
          <div class="hqm-head-main">
            <span class="hqm-kind">${l.items.length} item${l.items.length === 1 ? "" : "s"}</span>
            <h2 id="hqm-list-title" class="hqm-title">${l.title}</h2>
            ${l.hint ? html`<p class="hqm-muted">${l.hint}</p>` : nothing}
          </div>
          <button type="button" class="hqm-x" aria-label="Close (Esc)" @click=${() => closeTop(ctx)}>${icon("x", 14)}</button>
        </header>
        ${selectable.length
          ? html`<div class="hqm-bulkbar" role="toolbar" aria-label="Bulk actions">
              <label class="hqm-check"><input type="checkbox" .checked=${allOn} @change=${() => {
                if (allOn) l.selected.clear();
                else selectable.forEach((i) => l.selected.add(i.id));
                rerender(ctx);
              }} /> <span>${sel.length ? `${sel.length} selected` : "Select all"}</span></label>
              ${actBtn("Mark done", () => void bulk("task.done"), { primary: true, disabled: !sel.length, iconName: "check" })}
              ${actBtn("Reschedule", () => { l.pane = l.pane === "reschedule" ? null : "reschedule"; rerender(ctx); }, { disabled: !sel.length, active: l.pane === "reschedule", iconName: "clock" })}
              ${actBtn("Assign", () => { l.pane = l.pane === "assign" ? null : "assign"; rerender(ctx); }, { disabled: !sel.length, active: l.pane === "assign", iconName: "user" })}
            </div>
            ${l.pane === "reschedule" && sel.length
              ? html`<div class="hqm-pane"><div class="hqm-row">
                  ${actBtn("Tomorrow", () => void bulk("task.reschedule", { days: 1 }))}
                  ${actBtn("Next week", () => void bulk("task.reschedule", { days: 7 }))}
                  <input class="hqm-input hqm-input--inline" type="date" aria-label="Pick a date" .value=${lDraft("date", addDaysKey(Date.now(), 1))} @input=${(e: Event) => (l.draft.date = (e.target as HTMLInputElement).value)} />
                  ${actBtn("Apply", () => void bulk("task.reschedule", { date: lDraft("date", addDaysKey(Date.now(), 1)) }), { primary: true })}
                </div></div>`
              : nothing}
            ${l.pane === "assign" && sel.length
              ? html`<div class="hqm-pane"><div class="hqm-row">
                  <datalist id="hqm-people-l">${ctx.people.map((p) => html`<option value=${p.name}></option>`)}</datalist>
                  <input class="hqm-input hqm-input--inline" list="hqm-people-l" placeholder="Person" aria-label="Assign to" .value=${lDraft("person")} @input=${(e: Event) => (l.draft.person = (e.target as HTMLInputElement).value)} />
                  ${actBtn(`Assign ${sel.length}`, () => void bulk("task.assign", { person: lDraft("person").trim() }), { primary: true })}
                </div></div>`
              : nothing}`
          : nothing}
        <div class="hqm-list" role="list">
          ${l.items.length
            ? l.items.map((i) => {
                const isTask = i.kind === "task";
                const t = isTask ? (i.raw as KanbanTask) : null;
                const done = t ? isTaskDone(t) : false;
                return html`<div class="hqm-li ${done ? "is-done" : ""} ${hqUi.busy.has(i.id) ? "is-busy" : ""}" role="listitem">
                  ${isTask && !done
                    ? html`<input type="checkbox" class="hqm-li-check" aria-label=${`Select ${i.title}`} .checked=${l.selected.has(i.id)} @change=${() => toggle(i.id)} />`
                    : html`<span class="hqm-li-check" aria-hidden="true">${done ? icon("check", 12) : nothing}</span>`}
                  <button type="button" class="hqm-li-open" @click=${() => openFocus(ctx, i)}>
                    <span class="hqm-li-title">${i.title}</span>
                    <span class="hqm-li-sub">${t ? `${ctx.projectName(t.projectId)}${t.dueDate ? ` · ${fmtDate(t.dueDate)}` : ""}${t.assignee ? ` · ${t.assignee}` : ""}` : KIND_LABEL[i.kind]}</span>
                  </button>
                  ${t && !done ? html`${isTaskBlocked(t) ? chip("blocked", "danger") : isTaskOverdue(t) ? chip("overdue", "danger") : nothing}
                    <button type="button" class="hqm-btn hqm-btn--icon" aria-label=${`Mark ${i.title} done`} ?disabled=${hqUi.busy.has(i.id)} @click=${() => act(ctx, i, "task.done")}>${icon("check", 12)}</button>` : nothing}
                </div>`;
              })
            : html`<p class="hqm-muted hqm-empty">Nothing here — cleared.</p>`}
        </div>
      </div>
    </div>
  `;
}

// ── Delegate modal ──────────────────────────────────────────────────────────

function renderDelegate(ctx: HqCtx): TemplateResult | typeof nothing {
  const d = hqOverlay.delegate;
  if (!d) return nothing;
  const n = d.tasks.filter((t) => d.selected.has(t.id)).length;
  return html`
    <div class="hqm-backdrop" @click=${(e: Event) => e.target === e.currentTarget && !d.running && closeTop(ctx)}>
      <div class="ba-glass hqm-dialog hqm-dialog--list" role="dialog" aria-modal="true" aria-labelledby="hqm-del-title" data-dialog="delegate" ${ref(focusFirst)} @keydown=${(e: KeyboardEvent) => dialogKeydown(ctx, e)}>
        <header class="hqm-head">
          <div class="hqm-head-main">
            <span class="hqm-kind">Delegate to agents</span>
            <h2 id="hqm-del-title" class="hqm-title">Hand the rest to agents?</h2>
            <p class="hqm-muted">These tasks don't need your judgement. Each becomes a verified goal run: the agent keeps going until a judge sees evidence it's done. Decisions, approvals, contracts and payments are never proposed. Nothing starts until you confirm.</p>
          </div>
          <button type="button" class="hqm-x" aria-label="Close (Esc)" @click=${() => closeTop(ctx)}>${icon("x", 14)}</button>
        </header>
        ${d.results
          ? html`<div class="hqm-list" role="list">
              ${d.results.map((r) => {
                const t = d.tasks.find((x) => x.id === r.id);
                return html`<div class="hqm-li" role="listitem">${chip(r.ok ? "started" : "failed", r.ok ? "ok" : "danger")}<span class="hqm-li-title">${t?.title}</span><span class="hqm-li-sub">${r.msg}</span></div>`;
              })}
            </div>
            <div class="hqm-row hqm-row--end">
              ${actBtn("View goal runs", () => nav(null, ctx, "/goals"))}
              ${actBtn("Done", () => closeTop(ctx), { primary: true })}
            </div>`
          : html`
            <div class="hqm-list" role="list">
              ${d.tasks.map(
                (t) => html`<label class="hqm-li" role="listitem">
                  <input type="checkbox" class="hqm-li-check" .checked=${d.selected.has(t.id)} ?disabled=${d.running} @change=${() => {
                    if (d.selected.has(t.id)) d.selected.delete(t.id);
                    else d.selected.add(t.id);
                    rerender(ctx);
                  }} />
                  <span class="hqm-li-open"><span class="hqm-li-title">${t.title}</span><span class="hqm-li-sub">${ctx.projectName(t.projectId)}${isTaskOverdue(t) ? " · overdue" : isTaskBlocked(t) ? " · blocked" : ""}</span></span>
                  ${hqUi.busy.has(t.id) ? html`<span class="hqm-spinner" aria-label="starting"></span>` : nothing}
                </label>`,
              )}
            </div>
            <div class="hqm-row hqm-row--form">
              <div class="hqm-grow">
                <label class="hqm-label" for="hqm-del-agent">Agent</label>
                <select id="hqm-del-agent" class="hqm-input" ?disabled=${d.running} @change=${(e: Event) => { d.agentId = (e.target as HTMLSelectElement).value; }}>${agentOptions(d.agentId)}</select>
              </div>
            </div>
            <div class="hqm-row hqm-row--end">
              ${actBtn("Cancel", () => closeTop(ctx), { disabled: d.running })}
              ${actBtn(d.running ? "Starting…" : `Start ${n} goal run${n === 1 ? "" : "s"}`, () => {
                d.running = true;
                rerender(ctx);
                void handOff(ctx, d.tasks.filter((t) => d.selected.has(t.id)), "goal", d.agentId, d.context).then((results) => {
                  d.running = false;
                  d.results = results;
                  rerender(ctx);
                });
              }, { primary: true, disabled: d.running || n === 0 })}
            </div>`}
      </div>
    </div>
  `;
}

// ── Recap modal ─────────────────────────────────────────────────────────────

const METRIC_LABEL: Record<HqMetricKey, string> = {
  overdue: "Overdue",
  blocked: "Blocked",
  needsCeo: "Needs you",
  criticalRisks: "Critical risks",
  overdueCommitments: "Overdue commitments",
  openTasks: "Open tasks",
};
export const metricLabel = (k: HqMetricKey) => METRIC_LABEL[k];

const EVENT_LABEL: Record<string, string> = {
  "task.done": "Task done",
  "decision.decided": "Decision made",
  "risk.resolved": "Risk resolved",
  "commitment.settled": "Commitment settled",
};

export function recapText(ctx: HqCtx): string {
  const p = ctx.progress;
  const lines = [
    `Business HQ recap — ${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}`,
    `Completed today: ${p.today}/${p.target}${p.hitToday ? " (target hit)" : ""} · streak ${p.streak} day${p.streak === 1 ? "" : "s"} · ${p.week} this week`,
    ...ctx.deltas.map((d) => `${METRIC_LABEL[d.key]}: ${d.from} → ${d.to}`),
    "",
    "Done:",
    ...(p.todayEvents.length ? p.todayEvents.map((e) => `- ${EVENT_LABEL[e.kind] ?? e.kind}: ${e.title}`) : ["- nothing yet"]),
    "",
    "Still open (top):",
    ...(ctx.nextActions.length ? ctx.nextActions.slice(0, 3).map((a) => `- ${a.item.title} — ${a.reason}`) : ["- nothing urgent"]),
  ];
  return lines.join("\n");
}

function renderRecap(ctx: HqCtx): TemplateResult | typeof nothing {
  if (!hqOverlay.recap) return nothing;
  const p = ctx.progress;
  const text = recapText(ctx);
  return html`
    <div class="hqm-backdrop" @click=${(e: Event) => e.target === e.currentTarget && closeTop(ctx)}>
      <div class="ba-glass hqm-dialog" role="dialog" aria-modal="true" aria-labelledby="hqm-recap-title" data-dialog="recap" ${ref(focusFirst)} @keydown=${(e: KeyboardEvent) => dialogKeydown(ctx, e)}>
        <header class="hqm-head">
          <div class="hqm-head-main">
            <span class="hqm-kind">End of day</span>
            <h2 id="hqm-recap-title" class="hqm-title">${p.hitToday ? "Target hit — nice work" : `${p.today} of ${p.target} done today`}</h2>
            <div class="hqm-chips">
              ${chip(`${p.today}/${p.target} today`, p.hitToday ? "ok" : "gold")}
              ${chip(`${p.streak}-day streak`, p.streak ? "gold" : "muted")}
              ${chip(`${p.week} this week`, "muted")}
            </div>
          </div>
          <button type="button" class="hqm-x" aria-label="Close (Esc)" @click=${() => closeTop(ctx)}>${icon("x", 14)}</button>
        </header>
        <div class="hqm-body">
          ${ctx.deltas.length
            ? html`<section class="hqm-sec"><h3 class="hqm-h">Since this morning</h3><div class="hqm-row">${ctx.deltas.map((d) => chip(`${METRIC_LABEL[d.key]} ${d.from} → ${d.to}`, d.change < 0 ? "ok" : "danger"))}</div></section>`
            : nothing}
          <section class="hqm-sec"><h3 class="hqm-h">Done today</h3>
            ${p.todayEvents.length
              ? p.todayEvents.map((e) => html`<div class="hqm-run">${chip(EVENT_LABEL[e.kind] ?? e.kind, "ok")}<span class="hqm-run-title">${e.title}</span><span class="hqm-muted">${new Date(e.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span></div>`)
              : html`<p class="hqm-muted">Nothing completed yet today.</p>`}
          </section>
          <section class="hqm-sec"><h3 class="hqm-h">Carry into tomorrow</h3>
            ${ctx.nextActions.length ? ctx.nextActions.slice(0, 3).map((a) => relatedRow(ctx, a.item, a.reason)) : html`<p class="hqm-muted">Nothing urgent is waiting.</p>`}
          </section>
        </div>
        <footer class="hqm-actions-wrap">
          <div class="hqm-actions">
            ${actBtn("Save to Notes", async () => {
              try {
                await (ctx.client as unknown as RpcClient).request("notes.create", {
                  name: `HQ recap ${dayKey(Date.now())}`,
                  body: text,
                  tags: ["hq-recap", "daily-report"],
                  category: "report",
                });
                showToast(ctx.state, "Recap saved to Notes (tagged daily-report)");
              } catch (err) {
                showToast(ctx.state, `Couldn't save — ${err instanceof Error ? err.message : String(err)}`, "err");
              }
            }, { primary: true })}
            ${actBtn("Copy", () => void navigator.clipboard?.writeText(text).then(() => showToast(ctx.state, "Recap copied")))}
          </div>
        </footer>
      </div>
    </div>
  `;
}

// ── Settings modal ──────────────────────────────────────────────────────────

function renderSettings(ctx: HqCtx): TemplateResult | typeof nothing {
  const s = hqOverlay.settings;
  if (!s) return nothing;
  const roots = ctx.projects.filter((p) => !p.parentProjectId);
  const detectedName = ctx.detectedParentId ? ctx.projectName(ctx.detectedParentId) : null;
  return html`
    <div class="hqm-backdrop" @click=${(e: Event) => e.target === e.currentTarget && closeTop(ctx)}>
      <div class="ba-glass hqm-dialog hqm-dialog--small" role="dialog" aria-modal="true" aria-labelledby="hqm-set-title" data-dialog="settings" ${ref(focusFirst)} @keydown=${(e: KeyboardEvent) => dialogKeydown(ctx, e)}>
        <header class="hqm-head">
          <div class="hqm-head-main">
            <span class="hqm-kind">Dashboard settings</span>
            <h2 id="hqm-set-title" class="hqm-title">Targets &amp; sources</h2>
          </div>
          <button type="button" class="hqm-x" aria-label="Close (Esc)" @click=${() => closeTop(ctx)}>${icon("x", 14)}</button>
        </header>
        <div class="hqm-body">
          <label class="hqm-label" for="hqm-set-target">Daily completion target</label>
          <input id="hqm-set-target" class="hqm-input" type="number" min="1" max="100" .value=${s.target} data-autofocus @input=${(e: Event) => (s.target = (e.target as HTMLInputElement).value)} />
          <p class="hqm-muted">Tasks done, decisions made, risks resolved and commitments settled all count. Streaks are days at or over this number.</p>
          <label class="hqm-label" for="hqm-set-parent">Business parent project</label>
          <select id="hqm-set-parent" class="hqm-input" @change=${(e: Event) => (s.parent = (e.target as HTMLSelectElement).value)}>
            <option value="" ?selected=${!s.parent}>Auto-detect${detectedName ? ` (${detectedName})` : " (none found)"}</option>
            ${roots.map((p) => html`<option value=${p.id} ?selected=${s.parent === p.id}>${p.name}</option>`)}
          </select>
          <p class="hqm-muted">The project whose child boards are named Clients, Opportunities, Risks, Decisions, Commitments, CEO Queue.</p>
        </div>
        <footer class="hqm-actions-wrap">
          <div class="hqm-actions">
            ${actBtn("Save", async () => {
              const ok = await saveHqSettings(ctx.state, ctx.client as unknown as RpcClient, {
                dailyTarget: Number(s.target),
                parentProjectId: s.parent || null,
              });
              if (ok) closeTop(ctx);
            }, { primary: true })}
            ${actBtn("Cancel", () => closeTop(ctx))}
          </div>
        </footer>
      </div>
    </div>
  `;
}

// ── Toast ───────────────────────────────────────────────────────────────────

function renderToast(ctx: HqCtx): TemplateResult | typeof nothing {
  const t = hqUi.toast;
  return html`<div class="hqm-toast-region" role="status" aria-live="polite" aria-atomic="true">
    ${t
      ? html`<div class="ba-glass hqm-toast hqm-toast--${t.tone}">
          ${t.tone === "ok" ? icon("check", 12) : t.tone === "err" ? icon("alert", 12) : nothing}
          <span>${t.msg}</span>
          ${t.undo ? html`<button type="button" class="hqm-toast-undo" @click=${() => { const u = t.undo!; hqUi.toast = null; u(); rerender(ctx); }}>Undo</button>` : nothing}
        </div>`
      : nothing}
  </div>`;
}

export function renderHqOverlays(ctx: HqCtx): TemplateResult {
  return html`<div class="hqm-root">${renderList(ctx)}${renderDelegate(ctx)}${renderRecap(ctx)}${renderSettings(ctx)}${renderFocus(ctx)}${renderToast(ctx)}${HQM_STYLE}</div>`;
}

export const DAY = DAY_MS;

// ── Portal ──────────────────────────────────────────────────────────────────
// The dashboard renders inside the app shell's content column, which is its
// own stacking context (and on phones sits under the floating top bar), so no
// z-index lets a modal cover the shell from there. The overlays therefore
// render into a body-level host. It is cleared when the dashboard goes away.

let portal: HTMLElement | null = null;
let portalWatch = false;

function portalHost(): HTMLElement {
  if (portal && portal.isConnected) return portal;
  portal = document.createElement("div");
  portal.id = "hq-overlay-portal";
  document.body.appendChild(portal);
  return portal;
}

function dashboardMounted(): boolean {
  const find = (root: Document | ShadowRoot): boolean => {
    if (root.querySelector(".kis.bhq")) return true;
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot && find(el.shadowRoot)) return true;
    return false;
  };
  return find(document);
}

/** Tear the overlays down once the dashboard is no longer on screen. */
function watchUnmount() {
  if (portalWatch) return;
  portalWatch = true;
  window.addEventListener("popstate", () => {
    setTimeout(() => {
      if (!portal || dashboardMounted()) return;
      hqOverlay.focus = null;
      hqOverlay.list = null;
      hqOverlay.delegate = null;
      hqOverlay.recap = false;
      hqOverlay.settings = null;
      hqOverlay.returnFocus = [];
      render(nothing, portal);
    }, 50);
  });
}

/** Render the overlays into the body-level portal (call on every dashboard render). */
export function mountHqOverlays(ctx: HqCtx): void {
  if (typeof document === "undefined") return;
  watchUnmount();
  render(renderHqOverlays(ctx), portalHost());
}

// ── Styles ──────────────────────────────────────────────────────────────────
// The overlays render in a sibling of the dashboard root (".hqm-root"), not
// inside it: ".kis" sets "contain: layout", which would make it the containing
// block for position:fixed and trap the modals inside the scroll pane. So the
// root re-declares the KIS tokens it needs.
const HQM_STYLE = html`<style>
  .hqm-root {
    --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s6: 24px;
    --gold: var(--g-primary, #fbbf24); --danger: #f87171; --warn: #fb923c; --ok: #4ade80; --info: #7dd3fc;
    --fg: #f4f4f5; --fg-dim: #b1b1ba; --fg-muted: #8e8e99;
    --surface: rgba(255, 255, 255, 0.022); --surface-2: rgba(255, 255, 255, 0.045); --surface-3: rgba(255, 255, 255, 0.07);
    --rule: color-mix(in srgb, var(--gold) 12%, transparent); --rule-strong: color-mix(in srgb, var(--gold) 26%, transparent);
    --mono: "JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, monospace;
    font-size: 13px; line-height: 1.5; color: var(--fg);
  }
  .hqm-root *, .hqm-root *::before, .hqm-root *::after { box-sizing: border-box; }
  /* Glass sheets: the KIS tokens re-point to the --bag-* layer (ba-glass.css),
     which follows the light / dark theme on its own. */
  .hqm-root .ba-glass {
    --gold: var(--bag-gold); --danger: var(--bag-bad); --warn: var(--bag-warn); --ok: var(--bag-ok); --info: var(--bag-info);
    --fg: var(--bag-text); --fg-dim: var(--bag-text-2); --fg-muted: var(--bag-text-3);
    --surface: color-mix(in srgb, var(--bag-text) 3%, transparent);
    --surface-2: color-mix(in srgb, var(--bag-text) 5%, transparent);
    --surface-3: color-mix(in srgb, var(--bag-text) 8%, transparent);
    --rule: var(--bag-line); --rule-strong: var(--bag-line-strong);
    --hqm-bg: var(--bag-float);
  }
  .hqm-root .hqm-backdrop {
    position: fixed; inset: 0; z-index: 10000;
    background: color-mix(in srgb, #050403 55%, transparent);
    display: flex; align-items: flex-start; justify-content: center;
    padding: 7vh var(--s4) var(--s4);
    overflow-y: auto;
    animation: hqm-fade 160ms ease both;
  }
  :root[data-theme="light"] .hqm-root .hqm-backdrop { background: color-mix(in srgb, #2a1f0a 22%, transparent); }
  /* One blur per stack: the sheet frosts what is behind it; the scrim only dims. */
  .hqm-root .hqm-dialog {
    width: min(720px, 100%); max-height: none;
    background: var(--glass-sheen, none), var(--bag-float);
    backdrop-filter: var(--bag-blur); -webkit-backdrop-filter: var(--bag-blur);
    border: 0; border-radius: 22px;
    box-shadow: var(--glass-elev-3, 0 30px 80px rgba(0, 0, 0, 0.55)), 0 0 0 1px var(--bag-line);
    display: flex; flex-direction: column;
    animation: hqm-in 260ms var(--bag-ease) both;
    color: var(--fg);
  }
  .hqm-root .hqm-dialog::before {
    content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1px; pointer-events: none;
    background: var(--bag-hairline);
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor; mask-composite: exclude;
  }
  .hqm-root .hqm-dialog--list { width: min(780px, 100%); }
  .hqm-root .hqm-dialog--small { width: min(480px, 100%); }
  @keyframes hqm-fade { from { opacity: 0; } }
  @keyframes hqm-in { from { opacity: 0; transform: translateY(12px) scale(.985); } to { opacity: 1; transform: none; } }
  .hqm-root .hqm-head { display: flex; gap: var(--s3); align-items: flex-start; padding: 22px 22px 16px; border-bottom: 1px solid var(--rule); }
  .hqm-root .hqm-head-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
  .hqm-root .hqm-kind { font-size: 11px; letter-spacing: .18em; text-transform: uppercase; color: var(--gold); font-weight: 600; }
  .hqm-root .hqm-title { margin: 0; font-size: 21px; line-height: 1.22; font-weight: 650; letter-spacing: -0.02em; color: var(--fg); overflow-wrap: anywhere; }
  .hqm-root .hqm-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .hqm-root .hqm-x {
    flex: 0 0 auto; width: 36px; height: 36px; border-radius: 11px; border: 1px solid var(--rule);
    background: color-mix(in srgb, var(--bag-card) 80%, transparent); color: var(--fg-dim);
    display: grid; place-items: center; cursor: pointer; transition: border-color .2s, color .2s, transform .15s var(--bag-ease);
  }
  .hqm-root .hqm-x:hover { color: var(--fg); border-color: var(--gold); }
  .hqm-root .hqm-x:active { transform: scale(.96); }
  .hqm-root .hqm-body { padding: 18px 22px; display: flex; flex-direction: column; gap: 16px; }
  .hqm-root .hqm-fields {
    margin: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px 16px;
    padding: 14px 16px; border-radius: 14px; background: var(--bag-well); box-shadow: inset 0 0 0 1px var(--rule);
  }
  .hqm-root .hqm-field { min-width: 0; }
  .hqm-root .hqm-field dt { font-size: 11.5px; color: var(--fg-muted); font-weight: 520; }
  .hqm-root .hqm-field dd { margin: 3px 0 0; font-size: 13.5px; font-weight: 560; color: var(--fg); overflow-wrap: anywhere; }
  .hqm-root .hqm-sec { display: flex; flex-direction: column; gap: 8px; }
  .hqm-root .hqm-sec p { margin: 0; font-size: 13px; color: var(--fg-dim); line-height: 1.55; }
  .hqm-root .hqm-h { margin: 0; font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--fg-muted); font-weight: 600; }
  .hqm-root .hqm-question { margin: 0; font-size: 15px; line-height: 1.45; color: var(--fg); font-weight: 600; letter-spacing: -0.01em; }
  .hqm-root .hqm-notes {
    margin: 0; white-space: pre-wrap; font-size: 12px; color: var(--fg-dim); line-height: 1.55;
    background: var(--bag-well); border: 1px solid var(--rule); border-radius: 12px; padding: 10px 12px; max-height: 220px; overflow: auto;
  }
  .hqm-root .hqm-muted { color: var(--fg-muted); font-size: 12.5px; margin: 0; line-height: 1.5; }
  .hqm-root .hqm-empty { padding: 28px var(--s4); text-align: center; }
  .hqm-root .hqm-run { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; font-size: 13px; padding: 6px 0; }
  .hqm-root .hqm-run + .hqm-run { border-top: 1px solid color-mix(in srgb, var(--rule) 70%, transparent); }
  .hqm-root .hqm-run-title { flex: 1 1 200px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hqm-root .hqm-link { color: var(--gold); font-size: 12.5px; font-weight: 560; text-decoration: none; }
  .hqm-root .hqm-link:hover { text-decoration: underline; }
  .hqm-root .hqm-related {
    display: flex; align-items: center; gap: var(--s2); width: 100%; min-height: 40px; text-align: left;
    background: transparent; border: 1px solid transparent; border-radius: 11px; padding: 8px 10px;
    color: var(--fg); font: inherit; font-size: 13px; cursor: pointer; transition: background .15s, border-color .15s;
  }
  .hqm-root .hqm-related:hover, .hqm-root .hqm-related:focus-visible { border-color: var(--rule); background: var(--bag-hover); }
  .hqm-root .hqm-related-title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hqm-root .hqm-ladder { list-style: none; margin: 0; padding: 4px; display: flex; flex-wrap: wrap; gap: 2px; border-radius: 14px; background: var(--bag-well); box-shadow: inset 0 0 0 1px var(--rule); }
  .hqm-root .hqm-ladder li { font-size: 12px; font-weight: 560; padding: 5px 11px; border-radius: 10px; color: var(--fg-muted); }
  .hqm-root .hqm-ladder li.is-on { color: var(--gold); background: color-mix(in srgb, var(--gold) 10%, transparent); }
  .hqm-root .hqm-ladder li[aria-current="step"] { color: var(--bag-ink); background: var(--bag-gold-fill); }
  .hqm-root .hqm-actions-wrap {
    border-top: 1px solid var(--rule); padding: 16px 22px 20px; display: flex; flex-direction: column; gap: 14px;
    background: color-mix(in srgb, var(--gold) 3%, transparent); border-radius: 0 0 22px 22px;
  }
  .hqm-root .hqm-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .hqm-root .hqm-hint { margin: 0; font-size: 11.5px; color: var(--fg-muted); }
  .hqm-root .hqm-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px;
    padding: 0 14px; border-radius: 11px; cursor: pointer;
    border: 1px solid var(--rule-strong); background: color-mix(in srgb, var(--bag-card) 80%, transparent); color: var(--fg);
    font: inherit; font-size: 13px; font-weight: 560;
    transition: background .2s, border-color .2s, transform .15s var(--bag-ease), filter .2s;
  }
  .hqm-root .hqm-btn:hover:not([disabled]) { background: var(--bag-hover); border-color: var(--gold); }
  .hqm-root .hqm-btn:active:not([disabled]) { transform: translateY(1px) scale(.99); }
  .hqm-root .hqm-btn:focus-visible, .hqm-root .hqm-x:focus-visible, .hqm-root .hqm-li-open:focus-visible { outline: none; box-shadow: var(--bag-focus); }
  .hqm-root .hqm-btn[disabled] { opacity: .45; cursor: not-allowed; }
  .hqm-root .hqm-btn.is-active { border-color: var(--gold); background: color-mix(in srgb, var(--gold) 13%, transparent); color: var(--fg); }
  .hqm-root .hqm-btn--primary {
    border-color: transparent; color: var(--bag-ink); background: var(--bag-gold-fill);
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.45) inset, 0 10px 24px -12px color-mix(in srgb, var(--gold) 80%, transparent);
  }
  .hqm-root .hqm-btn--primary:hover:not([disabled]) { background: var(--bag-gold-fill); border-color: transparent; filter: brightness(1.06); }
  .hqm-root .hqm-btn--danger { background: color-mix(in srgb, var(--danger) 85%, #000); border-color: transparent; color: #fff; }
  .hqm-root .hqm-btn--danger:hover:not([disabled]) { background: var(--danger); }
  .hqm-root .hqm-btn--icon { min-height: 32px; width: 32px; padding: 0; border-radius: 10px; }
  .hqm-root .hqm-kbd { font-family: var(--bag-mono, var(--mono)); font-size: 10px; padding: 0 5px; border-radius: 5px; border: 1px solid currentColor; opacity: .5; line-height: 16px; }
  .hqm-root .hqm-pane {
    border: 0; border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 10px;
    background: var(--bag-card); box-shadow: inset 0 0 0 1px var(--rule-strong);
  }
  .hqm-root .hqm-pane-h { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--gold); font-weight: 600; }
  .hqm-root .hqm-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; }
  .hqm-root .hqm-row--form { align-items: flex-end; }
  .hqm-root .hqm-row--end { justify-content: flex-end; padding: 14px 22px 20px; }
  .hqm-root .hqm-grow { flex: 1 1 200px; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .hqm-root .hqm-label { font-size: 12px; color: var(--fg-dim); font-weight: 550; }
  .hqm-root .hqm-input {
    width: 100%; min-height: 38px; border-radius: 11px; border: 1px solid var(--rule);
    background: var(--bag-well); color: var(--fg); font: inherit; font-size: 13px; padding: 8px 12px;
    transition: border-color .2s, box-shadow .2s;
  }
  .hqm-root .hqm-input::placeholder { color: var(--fg-muted); }
  .hqm-root .hqm-input:focus { outline: none; border-color: var(--gold); box-shadow: 0 0 0 3px color-mix(in srgb, var(--gold) 18%, transparent); }
  .hqm-root .hqm-input--inline { width: auto; flex: 1 1 140px; }
  .hqm-root .hqm-textarea { resize: vertical; min-height: 72px; line-height: 1.5; }
  .hqm-root .hqm-ai { display: flex; align-items: center; gap: var(--s2); font-size: 13px; color: var(--fg-dim); flex-wrap: wrap; }
  .hqm-root .hqm-ai--err { color: var(--danger); }
  .hqm-root .hqm-spinner { width: 15px; height: 15px; border-radius: 50%; border: 2px solid var(--rule-strong); border-top-color: var(--gold); animation: hqm-spin .8s linear infinite; display: inline-block; flex: 0 0 auto; }
  @keyframes hqm-spin { to { transform: rotate(360deg); } }
  .hqm-root .hqm-bulkbar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 22px; border-bottom: 1px solid var(--rule);
    position: sticky; top: 0; background: var(--bag-float); z-index: 1;
  }
  .hqm-root .hqm-dialog--list > .hqm-pane { margin: 12px 22px 0; }
  .hqm-root .hqm-check { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--fg-dim); margin-right: auto; min-height: 36px; cursor: pointer; }
  .hqm-root .hqm-check input { accent-color: var(--gold); width: 16px; height: 16px; }
  .hqm-root .hqm-list { display: flex; flex-direction: column; padding: 8px 14px 16px; gap: 0; }
  .hqm-root .hqm-li { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 12px; transition: background .15s; }
  .hqm-root .hqm-li + .hqm-li { box-shadow: 0 -1px 0 color-mix(in srgb, var(--rule) 60%, transparent); }
  .hqm-root .hqm-li:hover { background: var(--bag-hover); }
  .hqm-root .hqm-li.is-done .hqm-li-title { text-decoration: line-through; color: var(--fg-muted); }
  .hqm-root .hqm-li.is-busy { opacity: .6; }
  .hqm-root .hqm-li-check { width: 18px; height: 18px; flex: 0 0 auto; accent-color: var(--gold); color: var(--ok); display: grid; place-items: center; }
  .hqm-root .hqm-li-open { flex: 1 1 auto; min-width: 0; min-height: 40px; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; gap: 1px; background: none; border: 0; padding: 4px 2px; color: var(--fg); font: inherit; text-align: left; cursor: pointer; border-radius: 8px; }
  .hqm-root .hqm-li-title { font-size: 13.5px; font-weight: 560; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hqm-root .hqm-li-sub { font-size: 12px; color: var(--fg-muted); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hqm-root .hqm-toast-region { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 10001; pointer-events: none; width: max-content; max-width: calc(100vw - 24px); }
  .hqm-root .hqm-toast {
    pointer-events: auto; display: flex; align-items: center; gap: var(--s2); padding: 10px 14px; border-radius: 14px; font-size: 13px;
    background: var(--glass-sheen, none), var(--bag-float); backdrop-filter: var(--bag-blur); -webkit-backdrop-filter: var(--bag-blur);
    border: 1px solid var(--rule-strong); box-shadow: var(--glass-elev-3, 0 12px 30px rgba(0,0,0,.45)); color: var(--fg); animation: hqm-in 200ms var(--bag-ease) both;
  }
  .hqm-root .hqm-toast--ok { border-color: color-mix(in srgb, var(--ok) 55%, transparent); }
  .hqm-root .hqm-toast--ok .kis-icon { color: var(--ok); }
  .hqm-root .hqm-toast--err { border-color: color-mix(in srgb, var(--danger) 60%, transparent); }
  .hqm-root .hqm-toast--err .kis-icon { color: var(--danger); }
  .hqm-root .hqm-toast-undo { background: none; border: 0; color: var(--gold); font: inherit; font-weight: 650; cursor: pointer; padding: 4px 8px; min-height: 30px; border-radius: 8px; }
  .hqm-root .hqm-dialog.is-celebrating { animation: hqm-glow 900ms ease both; }
  @keyframes hqm-glow { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 60%, transparent); } 100% { box-shadow: 0 0 0 18px transparent; } }
  @media (max-width: 520px) {
    .hqm-root .hqm-backdrop { padding: 0; align-items: stretch; }
    /* Full-screen on phones: an opaque sheet, so the page behind doesn't
       read through the copy. */
    .hqm-root .hqm-dialog { border-radius: 0; min-height: 100%; background: var(--glass-sheen, none), var(--glass-solid, var(--bag-float)); }
    .hqm-root .hqm-dialog::before { display: none; }
    .hqm-root .hqm-head { padding: 18px 16px 14px; }
    .hqm-root .hqm-body { padding: 16px; }
    .hqm-root .hqm-actions-wrap { border-radius: 0; position: sticky; bottom: 0; padding: 14px 16px 18px; background: var(--bag-float); }
    .hqm-root .hqm-btn { min-height: 40px; }
    .hqm-root .hqm-x { width: 40px; height: 40px; }
    .hqm-root .hqm-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .hqm-root .hqm-bulkbar { padding: 10px 16px; }
    .hqm-root .hqm-row--end { padding: 14px 16px 18px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .hqm-root .hqm-backdrop, .hqm-root .hqm-dialog, .hqm-root .hqm-toast, .hqm-root .hqm-dialog.is-celebrating { animation: none; }
    .hqm-root .hqm-spinner { animation-duration: 2.4s; }
  }
  @media (prefers-reduced-transparency: reduce) {
    .hqm-root .hqm-dialog, .hqm-root .hqm-toast { backdrop-filter: none; -webkit-backdrop-filter: none; background: var(--bag-float); }
  }
  :root.low-power .hqm-root .hqm-dialog, :root.low-power .hqm-root .hqm-toast,
  :root.perf-mode .hqm-root .hqm-dialog, :root.perf-mode .hqm-root .hqm-toast { backdrop-filter: none; -webkit-backdrop-filter: none; }
  :root.low-power .hqm-root .hqm-dialog, :root.low-power .hqm-root .hqm-backdrop { animation: none; }
</style>`;

/**
 * Per-kind renderers for chat panels — shared by the compact inline card
 * (`mode: "card"`) and the full modal (`mode: "modal"`). One renderer per kind
 * in src/chat-panels/kinds.ts; the `kind` string is the contract. Everything
 * rendered comes from the resolver's data — nothing is invented here.
 */
import { html, nothing, type TemplateResult } from "lit";

import { getGatewayClient } from "../gateway-client";
import { icons } from "../icons";
import { money, timeAgo } from "./panel-nav";
import { renderPluginPanel, type PluginPanelCtx } from "./plugin-panel";

type Rec = Record<string, unknown>;

export interface PanelRenderCtx {
  mode: "card" | "modal";
  /** Mesh: whether the live <agency-world-viz> should be mounted now. */
  vizLive: boolean;
  onEnableViz?: () => void;
  /** Task status change (confirm-first). */
  pendingStatus: string | null;
  busy: boolean;
  actionError: string | null;
  onPickStatus?: (status: string) => void;
  onConfirmStatus?: () => void;
  onCancelStatus?: () => void;
  /** Drill into another panel (e.g. a task row → task panel). */
  drill?: (kind: string, query: Rec, title: string) => void;
  /** Live state for plugin panels (filters, detail view, actions). */
  plugin?: PluginPanelCtx;
}

let vizLoad: Promise<unknown> | null = null;
/** Lazy: the Pixi mesh is heavy — only load it when a mesh panel goes live. */
export function ensureWorldViz(): Promise<unknown> {
  vizLoad ??= import("../components/agency-world-viz");
  return vizLoad;
}

const s = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Rec[]) : []);
const card = (ctx: PanelRenderCtx) => ctx.mode === "card";

const STATUS_LABEL: Record<string, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
};

export function statusTone(status: unknown): string {
  const v = s(status).toLowerCase();
  if (/inactive|idle|paused|stopped/.test(v)) return "";
  if (/error|fail|block|lost|churn|cancel/.test(v)) return "danger";
  if (/done|complete|won|active|paid|success/.test(v)) return "ok";
  if (/wait|review|pending|hold|overdue|proposal/.test(v)) return "warn";
  if (/run|progress|working|start/.test(v)) return "gold";
  return "";
}

function pill(label: unknown, tone = statusTone(label)) {
  const l = s(label);
  if (!l) return nothing;
  return html`<span class="pill ${tone}"><span class="dot ${tone === "gold" ? "live" : ""}"></span>${STATUS_LABEL[l] ?? l}</span>`;
}

function bar(pct: number) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return html`<div class="row"><div class="bar"><i style="width:${p}%"></i></div><span class="pct">${p}%</span></div>`;
}

function sec(title: string, count: number | null, body: unknown) {
  return html`<div class="sec">
    <div class="sec-h">${title}${count != null ? html`<span class="n">${count}</span>` : nothing}</div>
    ${body}
  </div>`;
}

function empty(msg: string) {
  return html`<div class="state">${msg}</div>`;
}

function runName(r: Rec): string {
  return s(r.label) || s(r.task).slice(0, 60) || s(r.runId).slice(0, 8);
}

// ── mesh ────────────────────────────────────────────────────────────────────
function renderMesh(d: Rec, ctx: PanelRenderCtx) {
  const running = arr(d.running);
  const recent = arr(d.recent);
  const counts = (d.counts ?? {}) as Rec;
  const h = card(ctx) ? 210 : 0;
  if (ctx.vizLive) void ensureWorldViz();
  const viz = html`<div class="viz" style=${card(ctx) ? `height:${h}px` : "height:100%;min-height:360px"}>
    ${ctx.vizLive
      ? html`<agency-world-viz ?no-overlays=${card(ctx)} .client=${getGatewayClient()}></agency-world-viz>`
      : html`<div class="viz-ph">
          ${icons.globe}
          <span>Live mesh paused</span>
          <button class="btn" @click=${() => ctx.onEnableViz?.()}>Show live map</button>
        </div>`}
  </div>`;
  const list = (rows: Rec[], n: number) =>
    rows.length
      ? html`<div class="list">
          ${rows.slice(0, n).map(
            (r) => html`<div
              class="li"
              style="cursor:pointer"
              title="Open this agent"
              @click=${() => ctx.drill?.("agent", { runId: r.runId }, runName(r))}
            >
              <span class="t">${runName(r)}</span>
              ${r.progress != null ? html`<span class="s">${s(r.progress)}%</span>` : nothing}
              ${pill(r.status)}
            </div>`,
          )}
        </div>`
      : empty("No sub-agents running right now.");
  const stats = html`<div class="row wrap" style="margin-top:10px">
    <span class="pill gold"><span class="dot live"></span>${s(counts.running)} running</span>
    <span class="pill">${s(counts.agents)} roster agents</span>
    ${recent.length ? html`<span class="pill">${recent.length} recently finished</span>` : nothing}
  </div>`;
  if (card(ctx)) return html`${viz}${stats}${running.length ? html`<div class="sec">${list(running, 3)}</div>` : nothing}`;
  return html`<div style="display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:14px;height:100%;min-height:0">
    ${viz}
    <div style="overflow:auto;min-height:0">
      ${stats}
      ${sec("Running", running.length, list(running, 30))}
      ${recent.length ? sec("Recently finished", recent.length, list(recent, 10)) : nothing}
    </div>
  </div>`;
}

// ── project ─────────────────────────────────────────────────────────────────
function taskRow(t: Rec, ctx: PanelRenderCtx) {
  return html`<div
    class="li"
    style="cursor:pointer"
    title="Open task"
    @click=${() => ctx.drill?.("task", { id: t.id }, s(t.title))}
  >
    <span class="t">${s(t.title) || "Untitled"}</span>
    ${t.assignee ? html`<span class="s">${s(t.assignee)}</span>` : nothing}
    ${t.autonomousStatus === "blocked" ? pill("blocked", "danger") : pill(t.status)}
  </div>`;
}

function renderProject(d: Rec, ctx: PanelRenderCtx) {
  const p = (d.project ?? {}) as Rec;
  const tasks = arr(d.tasks);
  const counts = (d.counts ?? {}) as Record<string, number>;
  const open = tasks.filter((t) => t.status !== "done");
  const head = html`<div class="row wrap">
      ${pill(p.status || "No status")}
      ${p.priority ? html`<span class="pill">${s(p.priority)}</span>` : nothing}
      ${p.dueDate ? html`<span class="pill">due ${s(p.dueDate).slice(0, 10)}</span>` : nothing}
      ${Number(d.blocked) ? html`<span class="pill danger">${s(d.blocked)} blocked</span>` : nothing}
      ${Number(d.overdue) ? html`<span class="pill warn">${s(d.overdue)} overdue</span>` : nothing}
    </div>
    <div class="sec">${bar(Number(d.progressPct) || 0)}
      <div class="muted" style="font-size:11px;margin-top:4px">${s(d.done)} of ${s(d.total)} tasks done</div>
    </div>`;
  const statusChips = html`<div class="row wrap">
    ${Object.keys(STATUS_LABEL)
      .filter((k) => counts[k])
      .map((k) => html`<span class="pill ${statusTone(k)}">${STATUS_LABEL[k]} · ${counts[k]}</span>`)}
  </div>`;
  if (card(ctx)) {
    return html`${head}
      ${sec("Open tasks", open.length, open.length ? html`<div class="list">${open.slice(0, 4).map((t) => taskRow(t, ctx))}</div>` : empty("No open tasks."))}`;
  }
  const byStatus = ["in_progress", "review", "todo", "backlog", "done"].map((st) => ({
    st,
    rows: tasks.filter((t) => (s(t.status) || "todo") === st),
  }));
  return html`${p.description ? html`<div class="prose muted clamp" style="margin-bottom:10px">${s(p.description)}</div>` : nothing}
    ${head}
    <div class="sec">${statusChips}</div>
    <div class="cols sec">
      <div>
        ${byStatus
          .filter((g) => g.rows.length)
          .map((g) => sec(STATUS_LABEL[g.st], g.rows.length, html`<div class="list">${g.rows.slice(0, 25).map((t) => taskRow(t, ctx))}</div>`))}
        ${tasks.length ? nothing : empty("This project has no tasks yet.")}
      </div>
      <div>
        ${sec(
          "Recent activity",
          null,
          arr(d.recent).length
            ? html`<div class="list">${arr(d.recent).map(
                (t) => html`<div class="li"><span class="t">${s(t.title)}</span><span class="s">${timeAgo(t.updatedAt)}</span>${pill(t.status)}</div>`,
              )}</div>`
            : empty("No activity yet."),
        )}
      </div>
    </div>`;
}

// ── task ────────────────────────────────────────────────────────────────────
function renderTask(d: Rec, ctx: PanelRenderCtx) {
  const t = (d.task ?? {}) as Rec;
  const checklist = arr(d.checklist);
  const doneItems = checklist.filter((c) => c.done).length;
  const statuses = Array.isArray(d.statuses) ? (d.statuses as string[]) : Object.keys(STATUS_LABEL);
  const current = s(t.status);
  const meta = html`<div class="row wrap">
    ${d.projectName ? html`<span class="pill gold">${icons.kanban}${s(d.projectName)}</span>` : nothing}
    ${t.assignee ? html`<span class="pill">${icons.person}${s(t.assignee)}</span>` : html`<span class="pill muted">unassigned</span>`}
    ${t.priority ? html`<span class="pill">${s(t.priority)}</span>` : nothing}
    ${t.dueDate ? html`<span class="pill ${/overdue/.test(s(t.dueDate)) ? "warn" : ""}">due ${s(t.dueDate).slice(0, 10)}</span>` : nothing}
    ${t.autonomousStatus === "blocked" ? pill("blocked", "danger") : nothing}
  </div>`;
  const statusCtl = html`<div class="sec">
    <div class="sec-h">Status</div>
    <div class="chips" role="group" aria-label="Task status">
      ${statuses.map(
        (st) => html`<button
          class="chip ${st === current ? "on" : ""}"
          ?disabled=${ctx.busy}
          aria-pressed=${st === current ? "true" : "false"}
          @click=${() => st !== current && ctx.onPickStatus?.(st)}
        >${STATUS_LABEL[st] ?? st}</button>`,
      )}
    </div>
    ${ctx.pendingStatus
      ? html`<div class="confirm" role="alertdialog" aria-label="Confirm status change">
          <span class="grow">Move <b>${s(t.title)}</b> to <b>${STATUS_LABEL[ctx.pendingStatus] ?? ctx.pendingStatus}</b>?</span>
          <button class="btn primary" ?disabled=${ctx.busy} @click=${() => ctx.onConfirmStatus?.()}>
            ${ctx.busy ? html`<span class="spin"></span>` : icons.check} Confirm
          </button>
          <button class="btn" ?disabled=${ctx.busy} @click=${() => ctx.onCancelStatus?.()}>Cancel</button>
        </div>`
      : nothing}
    ${ctx.actionError ? html`<div class="state err" style="padding:8px 0">${ctx.actionError}</div>` : nothing}
  </div>`;
  const checks = checklist.length
    ? sec(
        "Checklist",
        null,
        html`<div style="margin-bottom:6px">${bar((doneItems / checklist.length) * 100)}</div>
          ${checklist.slice(0, card(ctx) ? 5 : 100).map(
            (c) => html`<div class="check ${c.done ? "done" : ""}">
              <span class="box ${c.done ? "on" : ""}">${c.done ? "✓" : ""}</span><span class="txt">${s(c.text)}</span>
            </div>`,
          )}
          ${card(ctx) && checklist.length > 5 ? html`<div class="muted" style="font-size:11px">+${checklist.length - 5} more</div>` : nothing}`,
      )
    : nothing;
  const preview = d.preview
    ? sec("Content", null, html`<div class="prose ${card(ctx) ? "clamp" : ""}">${s(d.preview)}</div>`)
    : nothing;
  return html`${meta}${statusCtl}${checks}${preview}`;
}

// ── agent ───────────────────────────────────────────────────────────────────
function renderAgent(d: Rec, ctx: PanelRenderCtx) {
  const r = (d.run ?? {}) as Rec;
  const updates = arr(d.updates);
  const files = arr(d.files);
  const act = (r.lastActivity ?? null) as Rec | null;
  const checkpoints = Array.isArray(r.checkpoints) ? (r.checkpoints as string[]) : [];
  const head = html`<div class="row wrap">
      ${pill(r.status)}
      ${r.coderBackend ? html`<span class="pill">${s(r.coderBackend)}</span>` : nothing}
      ${r.startedAt ? html`<span class="pill">started ${timeAgo(r.startedAt)}</span>` : nothing}
      ${r.nodeName ? html`<span class="pill">${s(r.nodeName)}</span>` : nothing}
    </div>
    <div class="sec">${bar(Number(r.progress) || 0)}</div>
    ${act?.label || r.currentCheckpoint
      ? html`<div class="li sec"><span class="dot live" style="color:var(--gold)"></span><span class="t">Now: ${s(act?.label) || s(r.currentCheckpoint)}</span>${act?.at ? html`<span class="s">${timeAgo(act.at)}</span>` : nothing}</div>`
      : nothing}`;
  const task = r.task ? sec("Task", null, html`<div class="prose ${card(ctx) ? "clamp" : ""}">${s(r.task)}</div>`) : nothing;
  const ups = sec(
    "Recent activity",
    updates.length,
    updates.length
      ? html`<div class="list">${updates.slice(0, card(ctx) ? 3 : 10).map(
          (u) => html`<div class="li"><span class="t">${s(u.message)}</span><span class="s">${timeAgo(u.timestamp)}</span></div>`,
        )}</div>`
      : empty("No progress updates reported yet."),
  );
  const fl = files.length
    ? sec(
        "Files",
        Number(d.filesCount) || files.length,
        html`<div class="list">${files.slice(0, card(ctx) ? 4 : 25).map(
          (f) => html`<div class="li mono" title=${s(f.path)}>
            <span class="t">${s(f.path).split("/").slice(-2).join("/")}</span><span class="s">${s(f.action)}</span>
          </div>`,
        )}</div>`,
      )
    : nothing;
  if (card(ctx)) return html`${head}${task}${ups}${fl}`;
  return html`${head}${task}
    ${checkpoints.length
      ? sec("Checkpoints", checkpoints.length, html`<div class="row wrap">${checkpoints.map((c) => html`<span class="pill ${c === r.currentCheckpoint ? "gold" : ""}">${c}</span>`)}</div>`)
      : nothing}
    <div class="cols sec"><div>${ups}</div><div>${fl || sec("Files", 0, empty("No files touched yet."))}</div></div>`;
}

// ── tables ──────────────────────────────────────────────────────────────────
interface Col {
  h: string;
  v: (r: Rec) => unknown;
  num?: boolean;
}

function table(rows: Rec[], cols: Col[], ctx: PanelRenderCtx, onRow?: (r: Rec) => void, emptyMsg = "Nothing to show.") {
  if (!rows.length) return empty(emptyMsg);
  const shown = card(ctx) ? rows.slice(0, 6) : rows;
  return html`<div style="overflow:auto;${card(ctx) ? "" : "max-height:100%"}">
      <table>
        <thead><tr>${cols.map((c) => html`<th>${c.h}</th>`)}</tr></thead>
        <tbody>
          ${shown.map(
            (r) => html`<tr style=${onRow ? "cursor:pointer" : ""} @click=${() => onRow?.(r)}>
              ${cols.map((c) => {
                const v = c.v(r);
                return html`<td class=${c.num ? "num" : ""} title=${typeof v === "string" ? v : ""}>${v ?? ""}</td>`;
              })}
            </tr>`,
          )}
        </tbody>
      </table>
    </div>
    ${card(ctx) && rows.length > shown.length ? html`<div class="muted" style="font-size:11px;margin-top:6px">+${rows.length - shown.length} more — expand to see all</div>` : nothing}`;
}

function renderAgents(d: Rec, ctx: PanelRenderCtx) {
  return table(
    arr(d.rows),
    [
      { h: "Agent", v: (r) => runName(r) },
      { h: "Status", v: (r) => pill(r.status) },
      { h: "Progress", v: (r) => (r.progress != null ? `${s(r.progress)}%` : ""), num: true },
      ...(card(ctx) ? [] : [{ h: "Now", v: (r: Rec) => s((r.lastActivity as Rec | undefined)?.label) || s(r.currentCheckpoint) }]),
      { h: "Started", v: (r) => timeAgo(r.startedAt) },
    ],
    ctx,
    (r) => ctx.drill?.("agent", { runId: r.runId }, runName(r)),
    "No agent runs match.",
  );
}

function renderClients(d: Rec, ctx: PanelRenderCtx) {
  return table(
    arr(d.rows),
    [
      { h: "Client", v: (r) => s(r.name) },
      { h: "Status", v: (r) => pill(r.status) },
      { h: "Pipeline", v: (r) => s(r.pipeline) },
      ...(card(ctx) ? [] : [{ h: "Email", v: (r: Rec) => s(r.email) }, { h: "Updated", v: (r: Rec) => timeAgo(r.updatedAt) }]),
    ],
    ctx,
    undefined,
    "No clients match.",
  );
}

function renderOpportunities(d: Rec, ctx: PanelRenderCtx) {
  return html`${card(ctx) ? nothing : html`<div class="row" style="margin-bottom:10px"><span class="pill gold">${money(Number(d.value))} total value</span></div>`}
  ${table(
    arr(d.rows),
    [
      { h: "Opportunity", v: (r) => s(r.name) },
      { h: "Stage", v: (r) => pill(r.stage) },
      { h: "Value", v: (r) => money(Number(r.value)), num: true },
      ...(card(ctx)
        ? []
        : [
            { h: "Owner", v: (r: Rec) => s(r.owner) },
            { h: "Next action", v: (r: Rec) => s(r.nextAction) },
            { h: "Close", v: (r: Rec) => s(r.expectedCloseDate) },
          ]),
    ],
    ctx,
    undefined,
    "No opportunities match.",
  )}`;
}

function renderTable(d: Rec, ctx: PanelRenderCtx) {
  const columns = Array.isArray(d.columns) ? (d.columns as unknown[]).map(s) : [];
  const rows = Array.isArray(d.rows) ? (d.rows as unknown[][]) : [];
  return table(
    rows.map((r) => ({ r }) as Rec),
    columns.map((c, i) => ({ h: c, v: (x: Rec) => s((x.r as unknown[])[i]) })),
    ctx,
    undefined,
    "No rows.",
  );
}

// ── business ────────────────────────────────────────────────────────────────
function tile(v: unknown, k: string, tone = "") {
  return html`<div class="tile"><div class="v ${tone}">${v}</div><div class="k">${k}</div></div>`;
}

function renderBusiness(d: Rec, ctx: PanelRenderCtx) {
  const m = (d.metrics ?? {}) as Record<string, number>;
  const attention = arr(d.attention);
  const warnings = Array.isArray(d.warnings) ? (d.warnings as string[]) : [];
  const tiles = [
    tile(m.activeClients ?? 0, "Active clients", "gold"),
    tile(m.activeOpportunities ?? 0, "Open opportunities", "gold"),
    tile(money(m.pipelineValue), "Pipeline value", "ok"),
    tile(money(m.outstandingValue), `Outstanding invoices (${m.outstandingInvoices ?? 0})`, m.outstandingValue ? "warn" : "ok"),
    tile(m.activeProjects ?? 0, "Active projects"),
    tile(m.criticalRisks ?? 0, "Critical risks", m.criticalRisks ? "danger" : "ok"),
    tile(m.ceoDecisions ?? 0, "CEO decisions", m.ceoDecisions ? "warn" : "ok"),
    tile(m.blockedTasks ?? 0, "Blocked tasks", m.blockedTasks ? "danger" : "ok"),
  ];
  const att = sec(
    "Needs attention",
    Number(d.attentionTotal) || attention.length,
    attention.length
      ? html`<div class="list">${attention.slice(0, card(ctx) ? 4 : 30).map(
          (a) => html`<div class="li">
            <span class="pill ${s(a.tone)}">${s(a.type)}</span><span class="t">${s(a.title)}</span>
            ${a.detail ? html`<span class="s">${s(a.detail)}</span>` : nothing}
          </div>`,
        )}</div>`
      : empty("Nothing needs attention right now."),
  );
  const warn = warnings.length
    ? html`<div class="muted" style="font-size:11px;margin-top:8px">Unavailable: ${warnings.join(" · ")}</div>`
    : nothing;
  if (card(ctx)) return html`<div class="tiles">${tiles.slice(0, 4)}</div>${att}${warn}`;
  return html`<div class="tiles">${tiles}</div>
    <div class="cols sec">
      <div>${att}</div>
      <div>
        ${sec(
          "Top opportunities",
          arr(d.topOpportunities).length,
          arr(d.topOpportunities).length
            ? html`<div class="list">${arr(d.topOpportunities).map(
                (o) => html`<div class="li"><span class="t">${s(o.name)}</span><span class="s">${s(o.stage)}</span><span class="pill gold">${money(Number(o.value))}</span></div>`,
              )}</div>`
            : empty("No open opportunities."),
        )}
        ${sec(
          "Outstanding invoices",
          arr(d.outstanding).length,
          arr(d.outstanding).length
            ? html`<div class="list">${arr(d.outstanding).map(
                (c) => html`<div class="li"><span class="t">${s(c.name)}</span>${c.dueDate ? html`<span class="s">due ${s(c.dueDate).slice(0, 10)}</span>` : nothing}<span class="pill warn">${money(Number(c.amount))}</span></div>`,
              )}</div>`
            : empty("No outstanding invoices."),
        )}
        ${sec(
          "Clients",
          arr(d.clients).length,
          arr(d.clients).length
            ? html`<div class="list">${arr(d.clients).map(
                (c) => html`<div class="li"><span class="t">${s(c.name)}</span><span class="s">${s(c.pipeline)}</span>${pill(c.status)}</div>`,
              )}</div>`
            : empty("No clients yet."),
        )}
      </div>
    </div>${warn}`;
}

const RENDERERS: Record<string, (d: Rec, ctx: PanelRenderCtx) => TemplateResult> = {
  mesh: renderMesh,
  project: renderProject,
  task: renderTask,
  agent: renderAgent,
  agents: renderAgents,
  business: renderBusiness,
  clients: renderClients,
  opportunities: renderOpportunities,
  table: renderTable,
};

export const KIND_ICONS: Record<string, TemplateResult> = {
  mesh: icons.globe,
  project: icons.kanban,
  task: icons.check,
  agent: icons.bot,
  agents: icons.users,
  business: icons.briefcase,
  clients: icons.users,
  opportunities: icons.dollarSign,
  table: icons.rows,
};

// ── plugin panels (host contract v0 + v1) ────────────────────────────────────
// Kinds contributed by manifest-v2 plugins are namespaced "<pluginId>.<kind>"
// and render from one generic shape (see ./plugin-panel.ts), so a plugin needs
// no UI code here.
/** Header icon: the core kind's, else a plugin panel's `data.icon` (an icon name). */
export function kindIcon(kind: string, data?: unknown): TemplateResult {
  const named = data && typeof data === "object" ? (data as Rec).icon : undefined;
  return (
    KIND_ICONS[kind] ??
    (typeof named === "string" ? (icons as Record<string, TemplateResult>)[named] : undefined) ??
    icons.layout
  );
}

const isPluginKind = (kind: string) => /^[a-z0-9-]+\.[a-z0-9-]+$/i.test(kind);

export function hasRenderer(kind: string): boolean {
  return kind in RENDERERS || isPluginKind(kind);
}

export function renderPanelBody(kind: string, data: unknown, ctx: PanelRenderCtx): TemplateResult {
  const d = (data && typeof data === "object" ? data : {}) as Rec;
  const r = RENDERERS[kind];
  if (r) return r(d, ctx);
  if (isPluginKind(kind)) return renderPluginPanel(d, ctx.mode, ctx.plugin);
  return html`<div class="state err">This app version can't render "${kind}" panels yet.</div>`;
}

export function renderSkeleton(): TemplateResult {
  return html`<div class="skel" aria-label="Loading"><i style="width:70%"></i><i style="width:92%"></i><i style="width:55%"></i><i style="width:80%"></i></div>`;
}

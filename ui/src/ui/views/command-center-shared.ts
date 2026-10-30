/**
 * Command Center — shared primitives & styling.
 *
 * The Executive Command Center (§15/§16/§17) and the Operations Command Center
 * (§18) share the same gold-on-obsidian glass design language as the Business HQ
 * (`business-hq.ts`). This module factors the common date/priority helpers, the
 * money formatter, the small render primitives (chip / band / metric / row), and
 * the namespaced `.cc` style block so the two views stay visually consistent
 * without duplicating logic. Nothing here fetches data — the views own that.
 */
import { html, nothing, type TemplateResult } from "lit";
import type { KanbanProject, KanbanTask } from "../types";
import {
  KIS_STYLE,
  emptyState as kisEmptyState,
  ghostButton,
  icon,
  stagger,
  statCard,
} from "./kis-shared";

import type { Tone } from "./kis-shared";
export type { Tone };

// ── Date / task helpers ──────────────────────────────────────────────────────
export function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
export function endOfToday(): number {
  return startOfToday() + 86400000 - 1;
}
export function parseDue(t: KanbanTask): number | null {
  if (!t.dueDate) return null;
  const ms = Date.parse(t.dueDate);
  return Number.isNaN(ms) ? null : ms;
}
export function isDone(t: KanbanTask): boolean {
  return t.status === "done" || t.done === true;
}
export function isOverdue(t: KanbanTask): boolean {
  const due = parseDue(t);
  return due !== null && due < startOfToday() && !isDone(t);
}
export function isBlocked(t: KanbanTask): boolean {
  return t.autonomousStatus === "blocked";
}
export function isActive(t: KanbanTask): boolean {
  return t.status === "in_progress" || t.autonomousStatus === "in_progress";
}
export function dueToday(t: KanbanTask): boolean {
  const due = parseDue(t);
  return due !== null && due >= startOfToday() && due <= endOfToday() && !isDone(t);
}
export function dueWithinDays(t: KanbanTask, days: number): boolean {
  const due = parseDue(t);
  if (due === null) return false;
  return due >= startOfToday() && due <= startOfToday() + days * 86400000;
}
export function prioRank(t: KanbanTask): number {
  const p = (t.priority || "").toLowerCase();
  if (p === "critical") return 3;
  if (p === "high") return 2;
  if (p === "normal" || p === "medium") return 1;
  const pl = (t.priorityLevel || "").toLowerCase();
  if (pl === "immediate") return 3;
  if (pl === "high") return 2;
  if (pl === "medium") return 1;
  return 0;
}
export function fmtDue(t: KanbanTask): string {
  const due = parseDue(t);
  if (due === null) return "no date";
  const days = Math.round((due - startOfToday()) / 86400000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 14) return `in ${days}d`;
  return new Date(due).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
export function fmtIsoDue(iso?: string): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const days = Math.round((ms - startOfToday()) / 86400000);
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days <= 14) return `in ${days}d`;
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
export function isoWithinDays(iso: string | undefined, days: number): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return false;
  return ms >= startOfToday() && ms <= startOfToday() + days * 86400000;
}
export function isoIsPast(iso: string | undefined): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  return !Number.isNaN(ms) && ms < startOfToday();
}

const ACTIVE_PROJECT_STATUSES = new Set(["In progress", "Updating", "Reviewing", "Awaiting Client"]);
export function projectIsActive(p: KanbanProject): boolean {
  const s = p.status || "";
  if (["Completed", "Cancelled", "Paused"].includes(s)) return false;
  return ACTIVE_PROJECT_STATUSES.has(s);
}

export function money(n?: number): string {
  const v = Number(n) || 0;
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1000000) return `${sign}$${(a / 1000000).toFixed(1)}M`;
  if (a >= 1000) return `${sign}$${(a / 1000).toFixed(1)}k`;
  return `${sign}$${a}`;
}

export function projectName(projects: KanbanProject[], id: string): string {
  return projects.find((p) => p.id === id)?.name || "Unassigned";
}

// ── Render primitives ────────────────────────────────────────────────────────
// These wrap the shared KIS design system so the two command centers, the
// Business HQ and the object pages all resolve to one set of tokens, one row
// height and one chip vocabulary. Signatures are unchanged so the views that
// consume them didn't have to move.

export { chip, prioChip, loadingBanner } from "./kis-shared";
import { chip as kchip, prioChip as kprioChip } from "./kis-shared";

/** Small labelled empty state — never a bare panel. */
export function emptyState(msg: string, opts: { actionLabel?: string; onAction?: () => void } = {}): TemplateResult {
  return kisEmptyState({ title: msg, compact: true, actionLabel: opts.actionLabel, onAction: opts.onAction });
}

/** A compact line item: dot + title + sub + trailing flags. */
export function row(
  title: string,
  sub: string,
  flags: (TemplateResult | typeof nothing)[] = [],
  dot: Tone = "muted",
): TemplateResult {
  const real = flags.filter((f) => f !== nothing);
  return html`
    <div class="cc-row">
      <span class="cc-row-dot cc-row-dot--${dot}"></span>
      <div class="cc-row-main">
        <div class="cc-row-title" title=${title}>${title || "Untitled"}</div>
        ${sub ? html`<div class="cc-row-sub" title=${sub}>${sub}</div>` : nothing}
      </div>
      ${real.length ? html`<div class="cc-row-flags">${real}</div>` : nothing}
    </div>
  `;
}

/** A metric tile (BUSINESS HEALTH / counts) — the shared KPI card. */
export function metric(label: string, value: string | number, tone: Tone = "gold", sub = ""): TemplateResult {
  return statCard({ label, value, tone, sub });
}

/**
 * A titled sub-list block inside a panel: label + count + rows + overflow.
 * Zero-count blocks collapse to a single quiet line instead of a full-height
 * dashed box, which is what made the Ops panels read as mostly-empty.
 */
export function listBlock(
  label: string,
  count: number,
  rows: (TemplateResult | typeof nothing)[],
  tone: Tone = "muted",
  emptyMsg = "Clear",
): TemplateResult {
  const real = rows.filter((r) => r !== nothing);
  if (!count && !real.length) {
    return html`
      <div class="cc-block cc-block--clear">
        <div class="cc-block-head">
          <span class="cc-block-label">${label}</span>
          <span class="cc-block-clearmsg">${icon("check", 10)}${emptyMsg}</span>
        </div>
      </div>
    `;
  }
  return html`
    <div class="cc-block">
      <div class="cc-block-head">
        ${kchip(label, tone)}
        <span class="cc-block-n cc-block-n--${count ? tone : "muted"}">${count}</span>
      </div>
      ${real.length
        ? html`<div class="cc-block-rows">${real.map((r, i) => html`<div class="cc-row-wrap" style="animation-delay:${stagger(i, 16, 260)}">${r}</div>`)}</div>`
        : kisEmptyState({ title: emptyMsg, compact: true })}
      ${count > real.length ? html`<div class="cc-more">+${count - real.length} more</div>` : nothing}
    </div>
  `;
}

/** A band/panel card with a header and body. */
export function panel(
  title: string,
  subtitle: string,
  body: unknown,
  opts: { count?: number; countTone?: Tone; accent?: boolean; iconName?: string } = {},
): TemplateResult {
  return html`
    <section class="cc-panel ${opts.accent ? "cc-panel--accent" : ""}">
      <header class="cc-panel-head">
        <div class="cc-panel-headmain">
          ${opts.iconName ? html`<span class="cc-panel-icon">${icon(opts.iconName, 13)}</span>` : nothing}
          <div>
            <h3 class="cc-panel-title">${title}</h3>
            <p class="cc-panel-sub">${subtitle}</p>
          </div>
        </div>
        ${opts.count !== undefined
          ? html`<span class="cc-panel-count cc-panel-count--${opts.countTone || "muted"}">${opts.count}</span>`
          : nothing}
      </header>
      <div class="cc-panel-body">${body}</div>
    </section>
  `;
}

/** A band label (TODAY / THIS WEEK / BUSINESS HEALTH) that reads as a rule. */
export function bandLabel(name: string, note: string, tone: Tone = "gold"): TemplateResult {
  return html`
    <div class="cc-band-label cc-band-label--${tone}">
      <h2 class="cc-band-name">${name}</h2>
      <span class="cc-band-note">${note}</span>
      <span class="cc-band-rule"></span>
    </div>
  `;
}

/** Header refresh control with a real busy state (no dead click). */
export function refreshButton(busy: boolean, onClick: () => void): TemplateResult {
  return ghostButton(busy ? "Syncing" : "Refresh", onClick, { iconName: "refresh", state: busy ? "busy" : "idle" });
}

// ── Shared styles ────────────────────────────────────────────────────────────
// `.cc` layers command-center specifics on top of the `.kis` token system, so
// the two surfaces can never drift apart again. Command-center roots render as
// `class="kis cc"`.
export const CC_STYLE = html`
  ${KIS_STYLE}
  <style>
    .cc { gap: var(--s4); }

    .cc-header {
      display: flex; justify-content: space-between; align-items: flex-start;
      gap: var(--s4); flex-wrap: wrap;
      padding-bottom: var(--s3); border-bottom: 1px solid var(--rule);
    }
    .cc-eyebrow {
      font-size: 9.5px; letter-spacing: 0.18em; text-transform: uppercase;
      color: var(--gold); opacity: 0.9; margin-bottom: var(--s1); font-weight: 700;
    }
    .cc-h1 {
      font-size: clamp(22px, 2.6vw, 30px); font-weight: 800; margin: 0;
      letter-spacing: -0.022em; line-height: 1.1;
      background: linear-gradient(104deg, #fff 8%, var(--gold) 84%);
      -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
    }
    .cc-lede { margin: var(--s1) 0 0; color: var(--fg-dim); font-size: 11px; max-width: 74ch; }
    .cc-header-side { display: flex; align-items: center; gap: var(--s2); flex: 0 0 auto; }
    .cc-updated { font-size: 9.5px; color: var(--fg-muted); font-variant-numeric: tabular-nums; }

    .cc-banner {
      background: var(--surface); border: 1px solid var(--rule); border-radius: var(--radius);
      padding: 7px var(--s3); font-size: 10.5px; color: var(--fg-muted);
      display: flex; align-items: center; gap: 6px;
    }
    .cc-banner--err { border-color: color-mix(in srgb, var(--danger) 42%, transparent); color: #fecaca; background: color-mix(in srgb, var(--danger) 8%, transparent); }

    /* Band label (TODAY / THIS WEEK / …) — a titled rule across the grid */
    .cc-band-label { display: flex; align-items: center; gap: var(--s2); margin: var(--s2) 0 calc(var(--s1) * -1); }
    .cc-band-name {
      font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase;
      color: var(--gold); font-weight: 800; margin: 0; white-space: nowrap;
    }
    .cc-band-label--danger .cc-band-name { color: var(--danger); }
    .cc-band-label--info .cc-band-name { color: var(--info); }
    .cc-band-note { font-size: 10px; color: var(--fg-muted); white-space: nowrap; }
    .cc-band-rule { flex: 1 1 auto; height: 1px; background: linear-gradient(90deg, var(--rule-strong), transparent); }

    /* .cc-grid (the CEO two-up bands) packs as columns rather than a grid, so a
       band whose left panel is three cleared checks and whose right panel is
       five critical risks does not leave a dead band under the short one.
       .cc-grid-2 (the Ops four-panel view) deliberately stays a real grid: its
       panels are one very tall block plus three shorter ones, and column
       balancing strands the tall one alone in column 1 with ~570px of empty
       space beside it. A 2x2 grid is both the intended layout and the better
       one here. */
    .cc-grid { columns: 1; column-gap: var(--s3); }
    .cc-grid > * { break-inside: avoid; margin-bottom: var(--s3); }
    .cc-grid > *:last-child { margin-bottom: 0; }
    @media (min-width: 1000px) { .cc-grid { columns: 2; } }

    .cc-grid-2 { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s3); align-items: start; }
    @media (min-width: 1050px) { .cc-grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (min-width: 1900px) { .cc-grid-2 { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (min-width: 2500px) { .cc-grid-2 { grid-template-columns: repeat(4, minmax(0, 1fr)); } }

    .cc-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--s2); }

    /* Panels */
    .cc-panel {
      background: var(--surface); border: 1px solid var(--rule);
      border-radius: var(--radius); overflow: hidden;
      animation: kis-rise 300ms cubic-bezier(0.22, 0.8, 0.3, 1) both;
    }
    .cc-panel--accent {
      border-color: color-mix(in srgb, var(--gold) 42%, transparent);
      box-shadow: inset 0 1px 0 color-mix(in srgb, var(--gold) 16%, transparent);
    }
    .cc-panel-head {
      display: flex; justify-content: space-between; align-items: center; gap: var(--s2);
      padding: var(--s2) var(--s3);
      border-bottom: 1px solid var(--rule);
      background: color-mix(in srgb, var(--gold) 5%, transparent);
    }
    .cc-panel-headmain { display: flex; align-items: center; gap: var(--s2); min-width: 0; }
    .cc-panel-icon { color: var(--gold); opacity: 0.8; display: flex; flex: 0 0 auto; }
    .cc-panel-title { margin: 0; font-size: 11.5px; font-weight: 800; letter-spacing: 0.09em; text-transform: uppercase; color: var(--fg); }
    .cc-panel--accent .cc-panel-title { color: var(--gold); }
    .cc-panel-sub { margin: 1px 0 0; font-size: 9.5px; color: var(--fg-muted); }
    .cc-panel-body { padding: var(--s2) var(--s3) var(--s3); display: flex; flex-direction: column; gap: var(--s3); }
    .cc-panel-count {
      flex: 0 0 auto; min-width: 22px; text-align: center; font-weight: 800; font-size: 11px;
      padding: 1px 7px; border-radius: 999px; background: var(--surface-3); color: var(--fg-dim);
      font-variant-numeric: tabular-nums;
    }
    .cc-panel-count--gold { color: var(--gold); }
    .cc-panel-count--danger { color: var(--danger); background: color-mix(in srgb, var(--danger) 16%, transparent); }
    .cc-panel-count--warn { color: var(--warn); }
    .cc-panel-count--ok { color: var(--ok); }

    /* Blocks inside a panel */
    .cc-block { display: flex; flex-direction: column; gap: var(--s1); }
    .cc-block-head { display: flex; align-items: center; gap: 5px; }
    .cc-block-label { font-size: 9.5px; letter-spacing: 0.09em; text-transform: uppercase; color: var(--fg-muted); font-weight: 700; }
    .cc-block-n { font-size: 10px; color: var(--fg-muted); font-weight: 800; font-variant-numeric: tabular-nums; }
    .cc-block-n--danger { color: var(--danger); }
    .cc-block-n--warn { color: var(--warn); }
    .cc-block-n--gold { color: var(--gold); }
    .cc-block-n--ok { color: var(--ok); }
    .cc-block-rows { display: flex; flex-direction: column; }
    .cc-row-wrap { animation: kis-fade 240ms ease both; }
    .cc-more { font-size: 9.5px; color: var(--fg-muted); padding: 2px var(--s2); }

    /* A cleared block is one quiet line, not a full dashed panel */
    .cc-block--clear { opacity: 0.72; }
    .cc-block--clear .cc-block-head { justify-content: space-between; gap: var(--s2); }
    .cc-block-clearmsg {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 9.5px; color: var(--ok); opacity: 0.85; white-space: nowrap;
    }

    /* Rows */
    .cc-row {
      display: flex; align-items: center; gap: var(--s2);
      padding: 5px var(--s2); border-radius: var(--radius-sm);
      transition: background 120ms ease;
    }
    .cc-row:hover { background: color-mix(in srgb, var(--gold) 7%, transparent); }
    .cc-row-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: var(--fg-muted); }
    .cc-row-dot--gold { background: var(--gold); box-shadow: 0 0 6px color-mix(in srgb, var(--gold) 60%, transparent); }
    .cc-row-dot--danger { background: var(--danger); }
    .cc-row-dot--warn { background: var(--warn); }
    .cc-row-dot--ok { background: var(--ok); }
    .cc-row-dot--info { background: var(--info); }
    .cc-row-main { flex: 1 1 auto; min-width: 0; }
    .cc-row-title { font-size: 11px; color: var(--fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cc-row-sub { font-size: 9.5px; color: var(--fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cc-row-flags { flex: 0 0 auto; display: flex; gap: var(--s1); align-items: center; }

    .cc-footer { font-size: 9.5px; color: var(--fg-muted); text-align: center; padding-top: var(--s2); opacity: 0.75; }

    /* §17 CEO request cards */
    .cc-req-list { columns: 1; column-gap: var(--s3); }
    .cc-req-list > * { break-inside: avoid; margin-bottom: var(--s3); }
    .cc-req-list > *:last-child { margin-bottom: 0; }
    @media (min-width: 1100px) { .cc-req-list { columns: 2; } }
    @media (min-width: 1750px) { .cc-req-list { columns: 3; } }
    .cc-req {
      background: var(--surface-2);
      border: 1px solid color-mix(in srgb, var(--gold) 26%, transparent);
      border-radius: var(--radius); padding: var(--s3);
      display: flex; flex-direction: column; gap: var(--s2);
      animation: kis-rise 300ms cubic-bezier(0.22, 0.8, 0.3, 1) both;
    }
    .cc-req-triggers { display: flex; flex-wrap: wrap; gap: var(--s1); }
    .cc-req-title { font-size: 12.5px; font-weight: 700; color: var(--fg); line-height: 1.3; }
    .cc-req-grid { display: grid; grid-template-columns: 1fr; gap: var(--s2) var(--s4); }
    @media (min-width: 700px) { .cc-req-grid { grid-template-columns: 1fr 1fr; } }
    .cc-req-field { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
    .cc-req-k { font-size: 8.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--gold); opacity: 0.85; font-weight: 700; }
    .cc-req-v { font-size: 10.5px; color: var(--fg-dim); line-height: 1.4; white-space: pre-wrap; }
    .cc-req-v--muted { color: var(--fg-muted); font-style: italic; }
    .cc-req-full { grid-column: 1 / -1; }
    .cc-req-foot {
      display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap;
      padding-top: var(--s2); border-top: 1px solid color-mix(in srgb, var(--rule) 70%, transparent);
    }
  </style>
`;

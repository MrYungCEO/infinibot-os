/**
 * KIS shared design system — "Data-Dense Dashboard" (density 8), gold-on-obsidian.
 *
 * The Kingly Intelligence Systems object pages (decisions, risks, commitments,
 * people, product portfolio) and the Business HQ / Command Centers each grew
 * their own inline `S` token object, their own table shell, their own chip and
 * their own empty state. That produced five slightly-different greys, five row
 * heights and no shared interaction affordances (multi-select, sortable
 * headers, action feedback).
 *
 * This module is the single source for that layer:
 *
 *   • `KIS_STYLE` — one namespaced `.kis` style block. Compact 4/8/12/16/24
 *     spacing scale, tabular numerals for money/IDs/scores, gold used only for
 *     borders, rules and accents (never as a large fill), text contrast held at
 *     ≥4.5:1 against the obsidian surfaces.
 *   • Layout primitives — `kisPage`, `pageHead`, `statStrip`/`statCard`,
 *     `toolbar`, `tableShell`, `sortHeader`, `bulkBar`, `emptyState`.
 *   • Data primitives — `chip`, `prioChip`, `statusChip`, `scoreChip`, `money`,
 *     `moneyCell`, `bar`, `ladder`, `avatar`, `icon`.
 *   • Behaviour primitives — `createSelection` (multi-select + bulk actions),
 *     `createSort` (sortable headers), `createFeedback` (loading → success /
 *     error with an atomic aria-live status that never moves focus).
 *
 * Nothing here fetches data or knows about a controller; views own that.
 */
import { html, nothing, svg, type TemplateResult } from "lit";

export type Tone = "gold" | "danger" | "warn" | "ok" | "info" | "muted";

// ── Inline SVG icon set (no emoji anywhere in the KIS surfaces) ──────────────
const ICON_PATHS: Record<string, TemplateResult> = {
  star: svg`<path d="M8 1.6l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.4l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />`,
  alert: svg`<path d="M8 1.8l6.5 11.4H1.5zM8 6v3.4M8 11.1v.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />`,
  link: svg`<path d="M6.6 9.4a2.6 2.6 0 003.8 0l2-2a2.7 2.7 0 00-3.8-3.8l-.9.9M9.4 6.6a2.6 2.6 0 00-3.8 0l-2 2a2.7 2.7 0 003.8 3.8l.9-.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />`,
  plus: svg`<path d="M8 3.4v9.2M3.4 8h9.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />`,
  search: svg`<circle cx="7.1" cy="7.1" r="4.3" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M10.3 10.3l3 3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />`,
  refresh: svg`<path d="M13.2 8a5.2 5.2 0 10-1.6 3.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /><path d="M13.4 4.4v3.2h-3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />`,
  check: svg`<path d="M3.2 8.4l3 3 6.6-6.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />`,
  x: svg`<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />`,
  clock: svg`<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M8 4.8V8l2.2 1.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />`,
  arrowUp: svg`<path d="M8 12.6V3.6M4.4 7.2L8 3.5l3.6 3.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />`,
  arrowDown: svg`<path d="M8 3.4v9M4.4 8.8L8 12.5l3.6-3.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />`,
  sort: svg`<path d="M5 6.6L7.4 4l2.4 2.6M5 9.4l2.4 2.6 2.4-2.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />`,
  trash: svg`<path d="M3.6 4.6h8.8M6.4 4.6V3.3h3.2v1.3M4.8 4.6l.5 8h5.4l.5-8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />`,
  user: svg`<circle cx="8" cy="5.7" r="2.7" fill="none" stroke="currentColor" stroke-width="1.4" /><path d="M2.9 13.4a5.1 5.1 0 0110.2 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />`,
  scale: svg`<path d="M2.4 12.4h11.2M8 12.4V4.2M5 4.2h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" /><circle cx="8" cy="3" r="1.4" fill="none" stroke="currentColor" stroke-width="1.4" />`,
  shield: svg`<path d="M8 2l4.6 1.8v3.6c0 2.9-1.9 5.4-4.6 6.6-2.7-1.2-4.6-3.7-4.6-6.6V3.8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />`,
  box: svg`<path d="M8 2.2l5.2 2.7v6.2L8 13.8 2.8 11.1V4.9z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /><path d="M2.8 4.9L8 7.6l5.2-2.7M8 7.6v6.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />`,
  coins: svg`<ellipse cx="8" cy="4.4" rx="4.8" ry="2.1" fill="none" stroke="currentColor" stroke-width="1.3" /><path d="M3.2 4.4v3.4c0 1.2 2.1 2.1 4.8 2.1s4.8-.9 4.8-2.1V4.4M3.2 7.8v3.4c0 1.2 2.1 2.1 4.8 2.1s4.8-.9 4.8-2.1V7.8" fill="none" stroke="currentColor" stroke-width="1.3" />`,
  inbox: svg`<path d="M2.4 8.6h3l1 2h3.2l1-2h3M2.4 8.6l1.9-5.2h7.4l1.9 5.2v4.2H2.4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />`,
};

/** Inline SVG icon. `size` is px; colour is inherited via `currentColor`. */
export function icon(name: keyof typeof ICON_PATHS | string, size = 13): TemplateResult {
  const p = ICON_PATHS[name] ?? ICON_PATHS.check;
  return html`<svg
    class="kis-icon"
    width=${size}
    height=${size}
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >${p}</svg>`;
}

// ── Formatting ──────────────────────────────────────────────────────────────
export function money(n?: number, opts: { exact?: boolean } = {}): string {
  const v = Number(n) || 0;
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (opts.exact) return `${sign}$${a.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (a >= 1_000_000) return `${sign}$${(a / 1_000_000).toFixed(1)}M`;
  if (a >= 1_000) return `${sign}$${(a / 1_000).toFixed(1)}k`;
  return `${sign}$${a.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** Money with a colour-coded direction: in = positive/green, out = gold. */
export function moneyCell(
  amount: number | undefined,
  direction: "in" | "out" | "neutral" = "neutral",
  opts: { exact?: boolean; dim?: boolean } = {},
): TemplateResult {
  const cls = direction === "in" ? "kis-money--in" : direction === "out" ? "kis-money--out" : "";
  return html`<span class="kis-money ${cls} ${opts.dim ? "kis-money--dim" : ""}">${money(amount, opts)}</span>`;
}

export function relativeDay(iso?: string): { text: string; tone: Tone } {
  if (!iso || !iso.trim()) return { text: "—", tone: "muted" };
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { text: iso, tone: "muted" };
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((t - today.getTime()) / 86_400_000);
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, tone: "danger" };
  if (days === 0) return { text: "today", tone: "warn" };
  if (days === 1) return { text: "tomorrow", tone: "warn" };
  if (days <= 7) return { text: `in ${days}d`, tone: "gold" };
  return { text: iso, tone: "muted" };
}

export function initials(name?: string): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "—";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ── Chips ───────────────────────────────────────────────────────────────────
export function chip(label: unknown, tone: Tone = "muted", opts: { title?: string } = {}): TemplateResult {
  return html`<span class="kis-chip kis-chip--${tone}" title=${opts.title ?? nothing}>${label}</span>`;
}

const PRIO_TONE: Record<string, Tone> = { P0: "danger", P1: "warn", P2: "gold", P3: "muted" };
const PRIO_LABEL: Record<string, string> = { P0: "Critical", P1: "High", P2: "Normal", P3: "Low" };

/** P0–P3 chip. `withLabel` appends the human word (P0 · Critical). */
export function prioChip(priority?: string, opts: { withLabel?: boolean; hideLow?: boolean } = {}): TemplateResult | typeof nothing {
  const p = (priority || "").toUpperCase();
  if (!p) return nothing;
  if (opts.hideLow && (p === "P2" || p === "P3")) return nothing;
  const tone = PRIO_TONE[p] ?? "muted";
  const label = opts.withLabel && PRIO_LABEL[p] ? `${p} · ${PRIO_LABEL[p]}` : p;
  return html`<span class="kis-chip kis-chip--${tone} kis-chip--prio" title=${`Priority ${p}${PRIO_LABEL[p] ? ` — ${PRIO_LABEL[p]}` : ""}`}>${label}</span>`;
}

/** Status chip driven by a caller-supplied tone map, so each object keeps its lifecycle colours. */
export function statusChip(status: string | undefined, tones: Record<string, Tone>, fallback: Tone = "muted"): TemplateResult {
  const s = status || "—";
  return html`<span class="kis-chip kis-chip--${tones[s] ?? fallback} kis-chip--status">${s}</span>`;
}

/** Risk P×I score chip — heat scales with the 1–25 score. */
export function scoreChip(score: number, max = 25): TemplateResult {
  const band = score >= 15 ? "crit" : score >= 12 ? "high" : score >= 6 ? "med" : "low";
  return html`<span class="kis-score kis-score--${band}" title=${`Risk score ${score} of ${max} (probability × impact)`}>${score}</span>`;
}

// ── Meters ──────────────────────────────────────────────────────────────────
/** Horizontal proportion bar (workload, capacity, progress). */
export function bar(value: number, max: number, opts: { tone?: Tone; label?: string; width?: number } = {}): TemplateResult {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const tone = opts.tone ?? (pct >= 90 ? "danger" : pct >= 65 ? "warn" : "ok");
  return html`
    <div
      class="kis-bar"
      style=${opts.width ? `width:${opts.width}px;` : nothing}
      role="img"
      aria-label=${opts.label ?? `${value} of ${max}`}
      title=${opts.label ?? `${value} of ${max}`}
    >
      <span class="kis-bar-fill kis-bar-fill--${tone}" style="width:${pct.toFixed(1)}%"></span>
    </div>
  `;
}

/** Ordered stage ladder (product validation, pipeline). Highlights up to `current`. */
export function ladder(stages: string[], current: string | undefined, opts: { doneFrom?: Set<string> } = {}): TemplateResult {
  const idx = stages.indexOf(current || "");
  return html`
    <div class="kis-ladder" role="img" aria-label=${`Stage: ${current || "not set"} (${idx + 1} of ${stages.length})`} title=${`${current || "Not set"} — step ${Math.max(idx + 1, 0)} of ${stages.length}`}>
      ${stages.map((s, i) => {
        const state = idx < 0 ? "off" : i < idx ? "done" : i === idx ? (opts.doneFrom?.has(s) ? "goal" : "now") : "off";
        return html`<span class="kis-ladder-step kis-ladder-step--${state}"></span>`;
      })}
    </div>
  `;
}

export function avatar(name: string | undefined, opts: { size?: number } = {}): TemplateResult {
  const s = opts.size ?? 26;
  return html`<span class="kis-avatar" style="width:${s}px;height:${s}px;" aria-hidden="true">${initials(name)}</span>`;
}

// ── Layout primitives ───────────────────────────────────────────────────────
/**
 * Page head: eyebrow (h-level context), h1, lede and a right-hand action slot.
 * `sub` items render as inline metric callouts under the lede.
 */
export function pageHead(opts: {
  eyebrow: string;
  title: string;
  lede?: string;
  callouts?: (TemplateResult | typeof nothing)[];
  actions?: unknown;
}): TemplateResult {
  const callouts = (opts.callouts ?? []).filter((c) => c !== nothing);
  return html`
    <header class="kis-head">
      <div class="kis-head-main">
        <p class="kis-eyebrow">${opts.eyebrow}</p>
        <h1 class="kis-h1">${opts.title}</h1>
        ${opts.lede ? html`<p class="kis-lede">${opts.lede}</p>` : nothing}
        ${callouts.length ? html`<div class="kis-callouts">${callouts}</div>` : nothing}
      </div>
      ${opts.actions ? html`<div class="kis-head-actions">${opts.actions}</div>` : nothing}
    </header>
  `;
}

/** Primary gold action button. `state` drives the loading → done affordance. */
export function primaryButton(
  label: string,
  onClick: () => void,
  opts: { iconName?: string; state?: "idle" | "busy" | "done"; disabled?: boolean; title?: string } = {},
): TemplateResult {
  const st = opts.state ?? "idle";
  return html`
    <button
      class="kis-btn kis-btn--primary"
      ?disabled=${opts.disabled || st === "busy"}
      data-state=${st}
      title=${opts.title ?? label}
      @click=${onClick}
    >
      ${st === "busy" ? html`<span class="kis-spinner" aria-hidden="true"></span>` : opts.iconName ? icon(opts.iconName, 13) : nothing}
      <span>${st === "busy" ? "Working…" : label}</span>
    </button>
  `;
}

export function ghostButton(
  label: string,
  onClick: () => void,
  opts: { iconName?: string; tone?: Tone; state?: "idle" | "busy" | "done"; disabled?: boolean; title?: string } = {},
): TemplateResult {
  const st = opts.state ?? "idle";
  return html`
    <button
      class="kis-btn kis-btn--ghost kis-btn--${opts.tone ?? "muted"}"
      ?disabled=${opts.disabled || st === "busy"}
      title=${opts.title ?? label}
      @click=${onClick}
    >
      ${st === "busy" ? html`<span class="kis-spinner" aria-hidden="true"></span>` : opts.iconName ? icon(opts.iconName, 13) : nothing}
      <span>${st === "busy" ? "Working…" : label}</span>
    </button>
  `;
}

/** Big-value KPI card: value, label, and a subtle trend / context line. */
export function statCard(opts: {
  label: string;
  value: string | number;
  tone?: Tone;
  sub?: string;
  iconName?: string;
  onClick?: () => void;
  active?: boolean;
}): TemplateResult {
  const tone = opts.tone ?? "gold";
  const inner = html`
    <span class="kis-stat-top">
      ${opts.iconName ? html`<span class="kis-stat-icon">${icon(opts.iconName, 12)}</span>` : nothing}
      <span class="kis-stat-label">${opts.label}</span>
    </span>
    <span class="kis-stat-value">${opts.value}</span>
    ${opts.sub ? html`<span class="kis-stat-sub">${opts.sub}</span>` : nothing}
  `;
  return opts.onClick
    ? html`<button class="kis-stat kis-stat--${tone} kis-stat--btn" aria-pressed=${String(!!opts.active)} @click=${opts.onClick}>${inner}</button>`
    : html`<div class="kis-stat kis-stat--${tone}">${inner}</div>`;
}

export function statStrip(cards: (TemplateResult | typeof nothing)[]): TemplateResult {
  return html`<div class="kis-stats">${cards.filter((c) => c !== nothing)}</div>`;
}

/** Search + filter chip bar. */
export function toolbar(parts: {
  search?: { value: string; placeholder: string; onInput: (v: string) => void; onCommit: () => void };
  filters?: unknown;
  trailing?: unknown;
}): TemplateResult {
  return html`
    <div class="kis-toolbar" role="search">
      ${parts.search
        ? html`
            <label class="kis-searchbox">
              <span class="kis-searchbox-icon">${icon("search", 13)}</span>
              <span class="kis-sr-only">${parts.search.placeholder}</span>
              <input
                type="search"
                placeholder=${parts.search.placeholder}
                .value=${parts.search.value}
                @input=${(e: Event) => parts.search!.onInput((e.target as HTMLInputElement).value)}
                @search=${() => parts.search!.onCommit()}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") parts.search!.onCommit();
                }}
              />
            </label>
          `
        : nothing}
      ${parts.filters ? html`<div class="kis-filters">${parts.filters}</div>` : nothing}
      ${parts.trailing ? html`<div class="kis-toolbar-trail">${parts.trailing}</div>` : nothing}
    </div>
  `;
}

/** A labelled group of filter chips. */
export function filterGroup(label: string, chips: unknown): TemplateResult {
  return html`<div class="kis-filtergroup"><span class="kis-filtergroup-label">${label}</span>${chips}</div>`;
}

export function filterChip(label: string, active: boolean, onClick: () => void, opts: { tone?: Tone } = {}): TemplateResult {
  return html`
    <button
      class="kis-fchip ${active ? "is-active" : ""} kis-fchip--${opts.tone ?? "gold"}"
      aria-pressed=${String(active)}
      @click=${onClick}
    >${label}</button>
  `;
}

/**
 * Empty state — always labelled, never a blank panel. Title + why + a primary
 * action so the surface is never a dead end.
 */
export function emptyState(opts: {
  title: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
  iconName?: string;
  compact?: boolean;
}): TemplateResult {
  return html`
    <div class="kis-empty ${opts.compact ? "kis-empty--compact" : ""}">
      ${opts.iconName ? html`<span class="kis-empty-icon">${icon(opts.iconName, opts.compact ? 14 : 20)}</span>` : nothing}
      <p class="kis-empty-title">${opts.title}</p>
      ${opts.hint ? html`<p class="kis-empty-hint">${opts.hint}</p>` : nothing}
      ${opts.actionLabel && opts.onAction
        ? html`<button class="kis-btn kis-btn--ghost kis-btn--gold kis-empty-action" @click=${opts.onAction}>
            ${icon("plus", 12)}<span>${opts.actionLabel}</span>
          </button>`
        : nothing}
    </div>
  `;
}

/** Loading skeleton rows — keeps table height stable while data lands. */
export function skeletonRows(count = 5, cols = "1fr"): TemplateResult {
  return html`
    <div class="kis-skeleton" aria-hidden="true">
      ${Array.from({ length: count }, (_, i) => html`<div class="kis-skel-row" style="grid-template-columns:${cols}; animation-delay:${i * 60}ms"></div>`)}
    </div>
  `;
}

/** Table shell: sticky header row + body, with an accessible caption. */
export function tableShell(opts: { cols: string; head: unknown; body: unknown; caption?: string }): TemplateResult {
  return html`
    <div class="kis-table" role="table" aria-label=${opts.caption ?? nothing} style="--kis-cols:${opts.cols}">
      <div class="kis-thead" role="row">${opts.head}</div>
      <div class="kis-tbody">${opts.body}</div>
    </div>
  `;
}

// ── Sorting ─────────────────────────────────────────────────────────────────
export interface SortState {
  key: string;
  dir: "asc" | "desc";
  /** Toggle: same key flips direction, new key starts at the column's natural direction. */
  toggle(key: string, natural?: "asc" | "desc"): void;
}

export function createSort(key: string, dir: "asc" | "desc" = "asc"): SortState {
  const s: SortState = {
    key,
    dir,
    toggle(k: string, natural: "asc" | "desc" = "asc") {
      if (s.key === k) s.dir = s.dir === "asc" ? "desc" : "asc";
      else {
        s.key = k;
        s.dir = natural;
      }
    },
  };
  return s;
}

/** Sortable column header. Non-sortable columns just pass `key: undefined`. */
export function sortHeader(
  label: string,
  key: string | undefined,
  sort: SortState,
  onSort: () => void,
  opts: { natural?: "asc" | "desc"; align?: "start" | "end" | "center" } = {},
): TemplateResult {
  const align = opts.align ?? "start";
  if (!key) return html`<div class="kis-th kis-th--${align}" role="columnheader">${label}</div>`;
  const active = sort.key === key;
  return html`
    <div class="kis-th kis-th--${align} kis-th--sortable ${active ? "is-active" : ""}" role="columnheader" aria-sort=${active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        class="kis-th-btn"
        @click=${() => {
          sort.toggle(key, opts.natural);
          onSort();
        }}
        title=${`Sort by ${label}`}
      >
        <span>${label}</span>
        <span class="kis-th-arrow">${active ? icon(sort.dir === "asc" ? "arrowUp" : "arrowDown", 11) : icon("sort", 11)}</span>
      </button>
    </div>
  `;
}

/** Generic comparator factory driven by a per-key accessor map. */
export function sortBy<T>(rows: T[], sort: SortState, accessors: Record<string, (row: T) => string | number>): T[] {
  const get = accessors[sort.key];
  if (!get) return rows;
  const mul = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = get(a);
    const bv = get(b);
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * mul;
    return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" }) * mul;
  });
}

// ── Multi-select + bulk actions ─────────────────────────────────────────────
export interface Selection {
  ids: Set<string>;
  has(id: string): boolean;
  toggle(id: string): void;
  clear(): void;
  setAll(ids: string[], on: boolean): void;
  get size(): number;
}

export function createSelection(): Selection {
  const ids = new Set<string>();
  return {
    ids,
    has: (id) => ids.has(id),
    toggle(id) {
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
    },
    clear() {
      ids.clear();
    },
    setAll(list, on) {
      if (on) list.forEach((i) => ids.add(i));
      else list.forEach((i) => ids.delete(i));
    },
    get size() {
      return ids.size;
    },
  };
}

/** Row / header checkbox. Stops propagation so it never opens the row's editor. */
export function selectBox(checked: boolean, onToggle: () => void, opts: { label: string; indeterminate?: boolean } = { label: "Select row" }): TemplateResult {
  return html`
    <label class="kis-check" @click=${(e: Event) => e.stopPropagation()}>
      <input
        type="checkbox"
        .checked=${checked}
        .indeterminate=${!!opts.indeterminate}
        aria-label=${opts.label}
        @change=${(e: Event) => {
          e.stopPropagation();
          onToggle();
        }}
      />
      <span class="kis-check-box">${checked ? icon("check", 10) : opts.indeterminate ? html`<span class="kis-check-dash"></span>` : nothing}</span>
    </label>
  `;
}

/**
 * Bulk-action bar. Renders only when something is selected, and slides in over
 * the table without reflowing the rows underneath.
 */
export function bulkBar(opts: {
  count: number;
  noun: string;
  actions: unknown;
  onClear: () => void;
}): TemplateResult | typeof nothing {
  if (opts.count <= 0) return nothing;
  return html`
    <div class="kis-bulk" role="toolbar" aria-label=${`Bulk actions for ${opts.count} selected ${opts.noun}`}>
      <span class="kis-bulk-count"><strong>${opts.count}</strong> ${opts.noun}${opts.count === 1 ? "" : "s"} selected</span>
      <div class="kis-bulk-actions">${opts.actions}</div>
      <button class="kis-bulk-clear" @click=${opts.onClear} title="Clear selection">${icon("x", 12)}<span>Clear</span></button>
    </div>
  `;
}

// ── Action feedback (loading → success / error), atomic aria-live ────────────
export interface Feedback {
  state: "idle" | "busy" | "ok" | "err";
  message: string;
  /** Wrap an async action so the button/bar can show busy → ok/err with no dead click. */
  run(label: string, fn: () => Promise<unknown>, rerender: () => void): Promise<void>;
  set(state: Feedback["state"], message: string, rerender?: () => void): void;
}

export function createFeedback(): Feedback {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fb: Feedback = {
    state: "idle",
    message: "",
    set(state, message, rerender) {
      fb.state = state;
      fb.message = message;
      rerender?.();
      if (timer) clearTimeout(timer);
      if (state === "ok" || state === "err") {
        timer = setTimeout(() => {
          fb.state = "idle";
          fb.message = "";
          rerender?.();
        }, state === "ok" ? 2600 : 6000);
      }
    },
    async run(label, fn, rerender) {
      fb.set("busy", `${label}…`, rerender);
      try {
        await fn();
        fb.set("ok", `${label} — done`, rerender);
      } catch (e) {
        fb.set("err", `${label} failed: ${e instanceof Error ? e.message : String(e)}`, rerender);
      }
    },
  };
  return fb;
}

/**
 * Status line for a Feedback. `aria-live=polite` + `aria-atomic` so async count
 * and result updates are announced as one unit and focus never moves.
 */
export function statusLine(fb: Feedback, extra?: string): TemplateResult {
  const show = fb.state !== "idle" || !!extra;
  return html`
    <div class="kis-status kis-status--${fb.state} ${show ? "is-shown" : ""}" role="status" aria-live="polite" aria-atomic="true">
      ${fb.state === "busy" ? html`<span class="kis-spinner" aria-hidden="true"></span>` : nothing}
      ${fb.state === "ok" ? icon("check", 12) : nothing}
      ${fb.state === "err" ? icon("alert", 12) : nothing}
      <span>${fb.message || extra || ""}</span>
    </div>
  `;
}

/**
 * Loading banner that degrades instead of lying.
 *
 * The kanban RPCs can hang (the gateway proxies Notion, which has no client-side
 * timeout), which used to leave "Loading live business data…" pinned to the top
 * of the HQ and both command centers forever. `kanban.tasks.list` in particular
 * is observed hanging >20s on a live gateway while every other RPC answers in
 * <1s. After `slowMs` (6s — long enough not to flash on a slow-but-fine load,
 * short enough that a hang never reads as "broken") the banner switches
 * to a labelled "still waiting" state with a retry, so the surface always tells
 * the truth about what it is doing.
 */
const loadStartedAt = new WeakMap<object, number>();
const slowTimerFired = new WeakSet<object>();

export function loadingBanner(
  key: object,
  loading: boolean,
  opts: { label?: string; onRetry?: () => void; rerender?: () => void; slowMs?: number } = {},
): TemplateResult | typeof nothing {
  const slowMs = opts.slowMs ?? 6_000;
  if (!loading) {
    loadStartedAt.delete(key);
    slowTimerFired.delete(key);
    return nothing;
  }
  const now = Date.now();
  let started = loadStartedAt.get(key);
  if (started === undefined) {
    started = now;
    loadStartedAt.set(key, started);
  }
  const elapsed = now - started;
  if (elapsed < slowMs) {
    // Re-render once when the threshold passes so the banner can degrade
    // without waiting for an unrelated update to come through.
    if (opts.rerender && !slowTimerFired.has(key)) {
      slowTimerFired.add(key);
      setTimeout(() => opts.rerender?.(), slowMs - elapsed + 50);
    }
    return html`
      <div class="kis-loadbanner" role="status" aria-live="polite" aria-atomic="true">
        <span class="kis-spinner" aria-hidden="true"></span>
        <span>${opts.label ?? "Loading live business data…"}</span>
      </div>
    `;
  }
  return html`
    <div class="kis-loadbanner kis-loadbanner--slow" role="status" aria-live="polite" aria-atomic="true">
      ${icon("clock", 13)}
      <span>Still waiting on the board after ${Math.round(elapsed / 1000)}s — the kanban source has not responded. Everything below is live from the object stores.</span>
      ${opts.onRetry
        ? html`<button class="kis-btn kis-btn--ghost kis-btn--gold" @click=${opts.onRetry}>${icon("refresh", 12)}<span>Retry</span></button>`
        : nothing}
    </div>
  `;
}

/** Inline error banner (load failures). */
export function errorBanner(message: string, onRetry?: () => void): TemplateResult {
  return html`
    <div class="kis-errbanner" role="alert">
      ${icon("alert", 14)}
      <span>${message}</span>
      ${onRetry ? html`<button class="kis-btn kis-btn--ghost kis-btn--danger" @click=${onRetry}>${icon("refresh", 12)}<span>Retry</span></button>` : nothing}
    </div>
  `;
}

/** Stagger delay for list-load motion — capped so long lists don't crawl. */
export function stagger(index: number, step = 18, cap = 420): string {
  return `${Math.min(index * step, cap)}ms`;
}

// ── The style block ─────────────────────────────────────────────────────────
export const KIS_STYLE = html`
  <style>
    .kis {
      /* Density-8 spacing scale — 4 / 8 / 12 / 16 / 24 */
      --s1: 4px;
      --s2: 8px;
      --s3: 12px;
      --s4: 16px;
      --s6: 24px;

      --gold: var(--g-primary, #fbbf24);
      --danger: #f87171;
      --warn: #fb923c;
      --ok: #4ade80;
      --info: #7dd3fc;

      /* Text: all ≥4.5:1 on the obsidian surfaces below */
      --fg: #f4f4f5;
      --fg-dim: #b1b1ba;
      --fg-muted: #8e8e99;

      --surface: rgba(255, 255, 255, 0.022);
      --surface-2: rgba(255, 255, 255, 0.045);
      --surface-3: rgba(255, 255, 255, 0.07);
      --rule: color-mix(in srgb, var(--gold) 12%, transparent);
      --rule-strong: color-mix(in srgb, var(--gold) 26%, transparent);
      --radius: 10px;
      --radius-sm: 7px;
      --mono: "JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, monospace;

      display: flex;
      flex-direction: column;
      gap: var(--s4);
      width: 100%;
      box-sizing: border-box;
      height: 100%;
      overflow-y: auto;
      overflow-x: hidden;
      padding: var(--s6) var(--s6) 64px;
      color: var(--fg);
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1.45;
      contain: layout style;
    }
    .kis *,
    .kis *::before,
    .kis *::after { box-sizing: border-box; }

    /* The page is a scrolling column with a definite height, so its children
       must not flex-shrink. Any child with overflow:hidden (every panel and
       section card) has an automatic minimum size of 0, and would otherwise be
       squeezed to a few pixels once the page overflows. */
    .kis > * { flex: 0 0 auto; }

    /* Numerals line up in every column that carries money / scores / counts */
    .kis-num,
    .kis-money,
    .kis-score,
    .kis-stat-value,
    .kis-td--num { font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }

    .kis-sr-only {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
    .kis-icon { flex: 0 0 auto; display: block; }

    /* ── Head ───────────────────────────────────────────────────────────── */
    .kis-head {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: var(--s4); flex-wrap: wrap;
      padding-bottom: var(--s3);
      border-bottom: 1px solid var(--rule);
    }
    .kis-head-main { min-width: 0; }
    .kis-eyebrow {
      margin: 0 0 var(--s1); font-size: 9.5px; font-weight: 700;
      letter-spacing: 0.18em; text-transform: uppercase; color: var(--gold); opacity: 0.9;
    }
    .kis-h1 {
      margin: 0; font-size: 21px; font-weight: 800; letter-spacing: -0.015em; line-height: 1.15;
      background: linear-gradient(102deg, #ffffff 8%, var(--gold) 82%);
      -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
    }
    .kis-lede { margin: var(--s1) 0 0; font-size: 11px; color: var(--fg-dim); max-width: 78ch; }
    .kis-callouts { display: flex; flex-wrap: wrap; gap: var(--s2); margin-top: var(--s2); }
    .kis-head-actions { display: flex; align-items: center; gap: var(--s2); flex: 0 0 auto; }

    /* Defaults only — :where() keeps specificity at 0 so any component class
       (.bhq-card-title, .cc-panel-title, .prod-name…) still wins. */
    .kis :where(h2) { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: -0.005em; }
    .kis :where(h3) { margin: 0; font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg-dim); }

    /* ── Buttons ────────────────────────────────────────────────────────── */
    .kis-btn {
      display: inline-flex; align-items: center; gap: 6px;
      border-radius: var(--radius-sm); padding: 7px 13px;
      font-family: var(--mono); font-size: 11px; font-weight: 600;
      cursor: pointer; border: 1px solid transparent; white-space: nowrap;
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease, transform 90ms ease;
    }
    .kis-btn:disabled { opacity: 0.55; cursor: default; }
    .kis-btn:active:not(:disabled) { transform: translateY(1px); }
    .kis-btn:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
    .kis-btn--primary {
      background: linear-gradient(135deg, color-mix(in srgb, var(--gold) 96%, #fff 4%) 0%, var(--gold) 46%, color-mix(in srgb, var(--gold) 72%, #f59e0b 28%) 100%);
      color: #1a1206; font-weight: 800; border-color: transparent;
    }
    .kis-btn--primary:hover:not(:disabled) { filter: brightness(1.08); }
    .kis-btn--ghost { background: var(--surface-2); color: var(--fg-dim); border-color: var(--rule); }
    .kis-btn--ghost:hover:not(:disabled) { background: var(--surface-3); border-color: var(--rule-strong); color: var(--fg); }
    .kis-btn--gold { color: var(--gold); border-color: var(--rule-strong); }
    .kis-btn--danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 36%, transparent); }
    .kis-btn--ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 34%, transparent); }

    .kis-spinner {
      width: 11px; height: 11px; flex: 0 0 auto; border-radius: 50%;
      border: 1.6px solid currentColor; border-right-color: transparent;
      animation: kis-spin 620ms linear infinite;
    }
    @keyframes kis-spin { to { transform: rotate(360deg); } }

    /* ── Stat cards ─────────────────────────────────────────────────────── */
    .kis-stats {
      display: grid; gap: var(--s2);
      grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
    }
    .kis-stat {
      position: relative; display: flex; flex-direction: column; gap: 2px;
      padding: var(--s3) var(--s3) var(--s3) var(--s4);
      background: var(--surface); border: 1px solid var(--rule);
      border-radius: var(--radius); overflow: hidden; min-width: 0;
      text-align: left; font-family: var(--mono);
      animation: kis-rise 320ms cubic-bezier(0.22, 0.8, 0.3, 1) both;
    }
    .kis-stat::before {
      content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px;
      background: var(--gold);
    }
    .kis-stat--danger::before { background: var(--danger); }
    .kis-stat--warn::before { background: var(--warn); }
    .kis-stat--ok::before { background: var(--ok); }
    .kis-stat--info::before { background: var(--info); }
    .kis-stat--muted::before { background: color-mix(in srgb, var(--fg-muted) 70%, transparent); }
    .kis-stat--btn { cursor: pointer; transition: border-color 140ms ease, background 140ms ease; }
    .kis-stat--btn:hover { border-color: var(--rule-strong); background: var(--surface-2); }
    .kis-stat--btn[aria-pressed="true"] { border-color: var(--gold); background: var(--surface-2); }
    .kis-stat--btn:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
    .kis-stat-top { display: flex; align-items: center; gap: 5px; min-width: 0; }
    .kis-stat-icon { color: var(--gold); opacity: 0.75; display: flex; }
    .kis-stat-label {
      font-size: 9.5px; letter-spacing: 0.11em; text-transform: uppercase;
      color: var(--fg-muted); font-weight: 700;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .kis-stat-value { font-size: 22px; font-weight: 800; line-height: 1.05; letter-spacing: -0.02em; }
    .kis-stat--danger .kis-stat-value { color: var(--danger); }
    .kis-stat--warn .kis-stat-value { color: var(--warn); }
    .kis-stat--ok .kis-stat-value { color: var(--ok); }
    .kis-stat--gold .kis-stat-value { color: var(--gold); }
    .kis-stat-sub { font-size: 9.5px; color: var(--fg-muted); line-height: 1.3; }

    /* ── Toolbar / filters ──────────────────────────────────────────────── */
    .kis-toolbar { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
    .kis-searchbox {
      display: flex; align-items: center; gap: 6px; flex: 1 1 240px; min-width: 200px;
      background: var(--surface-2); border: 1px solid var(--rule);
      border-radius: var(--radius-sm); padding: 0 10px;
      transition: border-color 140ms ease;
    }
    .kis-searchbox:focus-within { border-color: var(--rule-strong); }
    .kis-searchbox-icon { color: var(--fg-muted); display: flex; }
    .kis-searchbox input {
      flex: 1 1 auto; min-width: 0; background: none; border: none; outline: none;
      color: var(--fg); font-family: var(--mono); font-size: 11px; padding: 7px 0;
    }
    .kis-searchbox input::placeholder { color: var(--fg-muted); }
    .kis-filters { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
    .kis-filtergroup { display: flex; align-items: center; gap: var(--s1); flex-wrap: wrap; }
    .kis-filtergroup-label {
      font-size: 9px; letter-spacing: 0.12em; text-transform: uppercase;
      color: var(--fg-muted); font-weight: 700; margin-right: 2px;
    }
    .kis-fchip {
      background: var(--surface-2); color: var(--fg-dim);
      border: 1px solid var(--rule); border-radius: 999px;
      padding: 4px 11px; font-size: 10px; font-family: var(--mono); cursor: pointer;
      transition: background 130ms ease, color 130ms ease, border-color 130ms ease;
    }
    .kis-fchip:hover { border-color: var(--rule-strong); color: var(--fg); }
    .kis-fchip:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; }
    .kis-fchip.is-active {
      background: color-mix(in srgb, var(--gold) 16%, transparent);
      border-color: var(--gold); color: var(--gold); font-weight: 700;
    }
    .kis-toolbar-trail { display: flex; align-items: center; gap: var(--s2); margin-left: auto; }

    /* ── Chips ──────────────────────────────────────────────────────────── */
    .kis-chip {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 9.5px; font-weight: 600; line-height: 1.5;
      padding: 2px 7px; border-radius: 999px; white-space: nowrap;
      border: 1px solid transparent;
    }
    .kis-chip--prio { font-weight: 800; letter-spacing: 0.04em; }
    .kis-chip--gold { color: var(--gold); background: color-mix(in srgb, var(--gold) 12%, transparent); border-color: color-mix(in srgb, var(--gold) 32%, transparent); }
    .kis-chip--danger { color: var(--danger); background: color-mix(in srgb, var(--danger) 13%, transparent); border-color: color-mix(in srgb, var(--danger) 36%, transparent); }
    .kis-chip--warn { color: var(--warn); background: color-mix(in srgb, var(--warn) 13%, transparent); border-color: color-mix(in srgb, var(--warn) 34%, transparent); }
    .kis-chip--ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 13%, transparent); border-color: color-mix(in srgb, var(--ok) 32%, transparent); }
    .kis-chip--info { color: var(--info); background: color-mix(in srgb, var(--info) 13%, transparent); border-color: color-mix(in srgb, var(--info) 32%, transparent); }
    .kis-chip--muted { color: var(--fg-dim); background: var(--surface-3); border-color: var(--rule); }

    .kis-score {
      display: inline-flex; align-items: center; justify-content: center;
      min-width: 28px; padding: 2px 6px; border-radius: var(--radius-sm);
      font-size: 11px; font-weight: 800; border: 1px solid;
    }
    .kis-score--crit { color: #fca5a5; background: rgba(248, 113, 113, 0.2); border-color: rgba(248, 113, 113, 0.55); }
    .kis-score--high { color: #fdba74; background: rgba(251, 146, 60, 0.16); border-color: rgba(251, 146, 60, 0.48); }
    .kis-score--med { color: #fcd34d; background: rgba(251, 191, 36, 0.14); border-color: rgba(251, 191, 36, 0.42); }
    .kis-score--low { color: #86efac; background: rgba(74, 222, 128, 0.12); border-color: rgba(74, 222, 128, 0.34); }

    .kis-money { font-weight: 700; color: var(--fg); }
    .kis-money--in { color: var(--ok); }
    .kis-money--out { color: var(--gold); }
    .kis-money--dim { color: var(--fg-muted); font-weight: 500; }

    /* ── Meters ─────────────────────────────────────────────────────────── */
    .kis-bar {
      position: relative; width: 100%; max-width: 120px; height: 5px;
      background: var(--surface-3); border-radius: 999px; overflow: hidden;
    }
    .kis-bar-fill { position: absolute; inset: 0 auto 0 0; border-radius: 999px; transition: width 320ms cubic-bezier(0.22, 0.8, 0.3, 1); }
    .kis-bar-fill--ok { background: var(--ok); }
    .kis-bar-fill--warn { background: var(--warn); }
    .kis-bar-fill--danger { background: var(--danger); }
    .kis-bar-fill--gold { background: var(--gold); }
    .kis-bar-fill--info { background: var(--info); }
    .kis-bar-fill--muted { background: var(--fg-muted); }

    .kis-ladder { display: inline-flex; gap: 3px; align-items: center; }
    .kis-ladder-step { width: 13px; height: 4px; border-radius: 2px; background: var(--surface-3); }
    .kis-ladder-step--done { background: color-mix(in srgb, var(--gold) 55%, transparent); }
    .kis-ladder-step--now { background: var(--gold); box-shadow: 0 0 6px color-mix(in srgb, var(--gold) 55%, transparent); }
    .kis-ladder-step--goal { background: var(--ok); box-shadow: 0 0 6px color-mix(in srgb, var(--ok) 55%, transparent); }

    .kis-avatar {
      display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
      border-radius: 50%; font-size: 9px; font-weight: 800; color: #1a1206;
      background: linear-gradient(135deg, color-mix(in srgb, var(--gold) 94%, #fff 6%), color-mix(in srgb, var(--gold) 74%, #f59e0b 26%));
    }

    /* ── Tables ─────────────────────────────────────────────────────────── */
    .kis-tablewrap { position: relative; }
    .kis-table {
      border: 1px solid var(--rule); border-radius: var(--radius);
      background: var(--surface); overflow: hidden;
    }
    .kis-thead {
      display: grid; grid-template-columns: var(--kis-cols); align-items: center;
      gap: var(--s2); padding: 7px var(--s3);
      background: color-mix(in srgb, var(--gold) 6%, transparent);
      border-bottom: 1px solid var(--rule);
      position: sticky; top: 0; z-index: 2;
      backdrop-filter: blur(8px);
    }
    .kis-th {
      font-size: 9px; font-weight: 700; letter-spacing: 0.11em; text-transform: uppercase;
      color: var(--fg-muted); min-width: 0;
    }
    .kis-th--end { text-align: right; }
    .kis-th--center { text-align: center; }
    .kis-th--sortable { color: var(--fg-dim); }
    .kis-th.is-active { color: var(--gold); }
    .kis-th-btn {
      display: inline-flex; align-items: center; gap: 4px; width: 100%;
      background: none; border: none; padding: 0; cursor: pointer; color: inherit;
      font: inherit; letter-spacing: inherit; text-transform: inherit;
    }
    .kis-th--end .kis-th-btn { justify-content: flex-end; }
    .kis-th--center .kis-th-btn { justify-content: center; }
    .kis-th-btn:hover { color: var(--gold); }
    .kis-th-btn:focus-visible { outline: 2px solid var(--gold); outline-offset: 2px; border-radius: 3px; }
    .kis-th-arrow { opacity: 0.65; display: flex; }
    .kis-th.is-active .kis-th-arrow { opacity: 1; }

    .kis-tbody { display: flex; flex-direction: column; }
    .kis-tr {
      display: grid; grid-template-columns: var(--kis-cols); align-items: center;
      gap: var(--s2); padding: 8px var(--s3);
      border-top: 1px solid color-mix(in srgb, var(--rule) 65%, transparent);
      cursor: pointer; min-height: 38px;
      transition: background 120ms ease, box-shadow 120ms ease;
      animation: kis-fade 260ms ease both;
    }
    .kis-tbody > .kis-tr:first-child { border-top: none; }
    .kis-tr:hover { background: color-mix(in srgb, var(--gold) 6%, transparent); }
    .kis-tr:focus-visible { outline: 2px solid var(--gold); outline-offset: -2px; }
    .kis-tr.is-selected { background: color-mix(in srgb, var(--gold) 10%, transparent); box-shadow: inset 2px 0 0 var(--gold); }
    .kis-tr.is-alert { background: color-mix(in srgb, var(--danger) 7%, transparent); }
    .kis-tr.is-alert:hover { background: color-mix(in srgb, var(--danger) 12%, transparent); }
    .kis-td { min-width: 0; font-size: 11px; color: var(--fg-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kis-td--strong { color: var(--fg); font-weight: 650; }
    .kis-td--num { text-align: right; }
    .kis-td--center { text-align: center; display: flex; justify-content: center; }
    .kis-td--flex { display: flex; align-items: center; gap: 6px; }
    .kis-td-sub { font-size: 9.5px; color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kis-td-stack { display: flex; flex-direction: column; gap: 1px; min-width: 0; }

    /* Checkbox */
    .kis-check { display: inline-flex; align-items: center; justify-content: center; cursor: pointer; position: relative; }
    .kis-check input { position: absolute; opacity: 0; width: 14px; height: 14px; margin: 0; cursor: pointer; }
    .kis-check-box {
      width: 14px; height: 14px; border-radius: 4px; flex: 0 0 auto;
      border: 1px solid var(--rule-strong); background: var(--surface-2);
      display: flex; align-items: center; justify-content: center; color: #1a1206;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .kis-check input:checked + .kis-check-box { background: var(--gold); border-color: var(--gold); }
    .kis-check input:indeterminate + .kis-check-box { background: color-mix(in srgb, var(--gold) 40%, transparent); border-color: var(--gold); }
    .kis-check input:focus-visible + .kis-check-box { outline: 2px solid var(--gold); outline-offset: 2px; }
    .kis-check-dash { width: 7px; height: 2px; border-radius: 1px; background: var(--gold); }

    /* ── Bulk-action bar ────────────────────────────────────────────────── */
    .kis-bulk {
      position: sticky; bottom: var(--s3); z-index: 6;
      display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap;
      margin: var(--s2) auto 0; width: fit-content; max-width: 100%;
      padding: 8px var(--s3);
      background: rgba(14, 12, 8, 0.92); backdrop-filter: blur(14px) saturate(160%);
      border: 1px solid var(--gold); border-radius: 999px;
      box-shadow: 0 10px 32px rgba(0, 0, 0, 0.55), 0 0 0 1px color-mix(in srgb, var(--gold) 18%, transparent);
      animation: kis-bulk-in 200ms cubic-bezier(0.22, 0.8, 0.3, 1) both;
    }
    .kis-bulk-count { font-size: 11px; color: var(--fg-dim); white-space: nowrap; }
    .kis-bulk-count strong { color: var(--gold); font-size: 12px; font-variant-numeric: tabular-nums; }
    .kis-bulk-actions { display: flex; align-items: center; gap: var(--s1); flex-wrap: wrap; }
    .kis-bulk-clear {
      display: inline-flex; align-items: center; gap: 4px;
      background: none; border: none; color: var(--fg-muted);
      font-family: var(--mono); font-size: 10px; cursor: pointer; padding: 4px 6px; border-radius: 6px;
    }
    .kis-bulk-clear:hover { color: var(--fg); background: var(--surface-3); }

    /* ── Empty / skeleton / status ──────────────────────────────────────── */
    .kis-empty {
      display: flex; flex-direction: column; align-items: center; gap: 6px;
      padding: 32px var(--s4); text-align: center;
      border: 1px dashed var(--rule-strong); border-radius: var(--radius);
      background: color-mix(in srgb, var(--gold) 2.5%, transparent);
    }
    .kis-empty--compact { padding: var(--s3) var(--s3); gap: 3px; border-radius: var(--radius-sm); }
    .kis-empty-icon { color: var(--gold); opacity: 0.5; display: flex; }
    .kis-empty-title { margin: 0; font-size: 11.5px; font-weight: 700; color: var(--fg-dim); }
    .kis-empty--compact .kis-empty-title { font-size: 10.5px; font-weight: 600; }
    .kis-empty-hint { margin: 0; font-size: 10px; color: var(--fg-muted); max-width: 52ch; }
    .kis-empty-action { margin-top: var(--s1); }

    .kis-skeleton { display: flex; flex-direction: column; }
    .kis-skel-row {
      height: 38px; border-top: 1px solid color-mix(in srgb, var(--rule) 60%, transparent);
      background: linear-gradient(90deg, transparent 0%, var(--surface-2) 42%, transparent 84%);
      background-size: 220% 100%;
      animation: kis-shimmer 1.25s ease-in-out infinite;
    }

    .kis-status {
      display: flex; align-items: center; gap: 6px;
      font-size: 10.5px; min-height: 18px; color: var(--fg-muted);
      opacity: 0; transition: opacity 160ms ease;
    }
    .kis-status.is-shown { opacity: 1; }
    .kis-status--ok { color: var(--ok); }
    .kis-status--err { color: var(--danger); }
    .kis-status--busy { color: var(--gold); }

    .kis-loadbanner {
      display: flex; align-items: center; gap: var(--s2);
      padding: 7px var(--s3); font-size: 10.5px; color: var(--fg-muted);
      border: 1px solid var(--rule); border-radius: var(--radius-sm);
      background: var(--surface);
    }
    .kis-loadbanner > span:not(.kis-spinner) { flex: 1 1 auto; min-width: 0; }
    .kis-loadbanner--slow {
      color: var(--warn);
      border-color: color-mix(in srgb, var(--warn) 34%, transparent);
      background: color-mix(in srgb, var(--warn) 7%, transparent);
    }

    .kis-errbanner {
      display: flex; align-items: center; gap: var(--s2);
      padding: 8px var(--s3); font-size: 11px; color: #fecaca;
      border: 1px solid color-mix(in srgb, var(--danger) 42%, transparent);
      background: color-mix(in srgb, var(--danger) 9%, transparent);
      border-radius: var(--radius-sm);
    }
    .kis-errbanner > span { flex: 1 1 auto; min-width: 0; }

    .kis-footnote { font-size: 9.5px; color: var(--fg-muted); text-align: center; padding-top: var(--s1); }

    /* ── Panels (for grouped / sectioned layouts) ───────────────────────── */
    .kis-grid { display: grid; gap: var(--s3); grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); align-items: start; }
    .kis-panel {
      background: var(--surface); border: 1px solid var(--rule);
      border-radius: var(--radius); overflow: hidden;
      animation: kis-rise 300ms cubic-bezier(0.22, 0.8, 0.3, 1) both;
    }
    .kis-panel--accent { border-color: var(--rule-strong); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--gold) 14%, transparent); }
    .kis-panel-head {
      display: flex; align-items: center; justify-content: space-between; gap: var(--s2);
      padding: 8px var(--s3); border-bottom: 1px solid var(--rule);
      background: color-mix(in srgb, var(--gold) 5%, transparent);
    }
    .kis-panel-headmain { display: flex; align-items: center; gap: var(--s2); min-width: 0; }
    .kis-panel-count {
      font-size: 10px; font-weight: 800; color: var(--fg-muted);
      font-variant-numeric: tabular-nums; padding: 1px 7px; border-radius: 999px;
      background: var(--surface-3);
    }
    .kis-panel-count--gold { color: var(--gold); }
    .kis-panel-count--danger { color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
    .kis-panel-count--warn { color: var(--warn); }
    .kis-panel-count--ok { color: var(--ok); }
    .kis-panel-body { padding: var(--s2) 0; }
    .kis-panel-body--pad { padding: var(--s3); }

    /* ── Motion: subtle, exits faster than enters, honours the OS setting ── */
    @keyframes kis-fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes kis-rise { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
    @keyframes kis-bulk-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    @keyframes kis-shimmer { 0% { background-position: 120% 0; } 100% { background-position: -60% 0; } }

    @media (prefers-reduced-motion: reduce) {
      .kis *,
      .kis *::before,
      .kis *::after {
        animation-duration: 1ms !important;
        animation-delay: 0ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 1ms !important;
      }
    }

    @media (max-width: 1100px) {
      .kis { padding: var(--s4) var(--s4) 56px; }
      .kis-stats { grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); }
    }
  </style>
`;

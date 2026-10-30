/**
 * Sessions Page — luxury glass list
 *
 * Session history and management:
 * - Hero header with live counts and a 24h activity sparkline
 *   (bucketed from each session's real `updatedAt`)
 * - Server filters (active window, limit, global/unknown) + instant
 *   client-side kind filter and search
 * - Glass rows with agent avatars, recency status lights, context meters
 *   and inline label / thinking / verbose / reasoning controls
 */

import { html, nothing } from "lit";

import { formatAgo } from "../format";
import { formatSessionTokens } from "../presenter";
import { pathForTab } from "../navigation";
import type { GatewaySessionRow, SessionsListResult } from "../types";
import {
  isBinaryThinkingProvider,
  resolveThinkLevelDisplay,
  resolveThinkLevelOptions,
  resolveThinkLevelPatchValue,
} from "../thinking-levels";
import { GLASS_TOOLS_CSS, glassAurora, glassSparkline } from "./glass-tools-shared";

// ══════════════════════════════════════════════════════════════════════════════
// Types
// ══════════════════════════════════════════════════════════════════════════════

export type SessionsProps = {
  loading: boolean;
  result: SessionsListResult | null;
  error: string | null;
  activeMinutes: string;
  limit: string;
  includeGlobal: boolean;
  includeUnknown: boolean;
  basePath: string;
  onFiltersChange: (next: {
    activeMinutes: string;
    limit: string;
    includeGlobal: boolean;
    includeUnknown: boolean;
  }) => void;
  onRefresh: () => void;
  onPatch: (
    key: string,
    patch: {
      label?: string | null;
      thinkingLevel?: string | null;
      verboseLevel?: string | null;
      reasoningLevel?: string | null;
    },
  ) => void;
  onDelete: (key: string) => void;
};

// ══════════════════════════════════════════════════════════════════════════════
// Styles
// ══════════════════════════════════════════════════════════════════════════════

const sessionsStyles = /* css */ `
  .ss-root {
    min-height: 100%;
    padding: 28px clamp(16px, 3vw, 36px) 48px;
    max-width: 1480px;
    margin: 0 auto;
  }
  .ss-hero-side { display: flex; align-items: stretch; gap: 10px; flex-wrap: wrap; }
  .ss-activity {
    display: grid;
    gap: 6px;
    padding: 10px 14px;
    border-radius: 14px;
    min-width: 180px;
  }
  .ss-activity .gt-spark { width: 100%; height: 30px; display: block; overflow: visible; }
  .ss-refresh { height: auto; min-height: 44px; align-self: stretch; }
  .ss-refresh svg { width: 15px; height: 15px; }
  .ss-refresh[data-busy] svg { animation: ss-spin 1s linear infinite; }
  @keyframes ss-spin { to { transform: rotate(360deg); } }

  .ss-error {
    display: flex; align-items: center; gap: 10px;
    margin-bottom: 16px;
    padding: 12px 16px;
    border-radius: 14px;
    border: 1px solid color-mix(in srgb, var(--danger) 35%, transparent);
    background: var(--danger-subtle);
    color: var(--danger);
    font-size: 13px;
  }

  /* toolbar */
  .ss-toolbar {
    display: grid;
    gap: 14px;
    padding: 16px;
    margin-bottom: 18px;
  }
  .ss-toolbar-row {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  }
  .ss-search { position: relative; flex: 1 1 240px; min-width: 0; }
  .ss-search svg {
    position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
    width: 15px; height: 15px; color: var(--gt-faint); pointer-events: none;
  }
  .ss-search .gt-input { width: 100%; padding-left: 36px; box-sizing: border-box; }
  .ss-seg { overflow-x: auto; max-width: 100%; scrollbar-width: none; }
  .ss-seg::-webkit-scrollbar { display: none; }
  .ss-seg button { white-space: nowrap; }
  .ss-seg-count { margin-left: 5px; opacity: 0.55; font-variant-numeric: tabular-nums; }
  .ss-filters {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding-top: 12px;
    border-top: 1px solid var(--gt-line);
  }
  .ss-field {
    display: inline-flex; align-items: center; gap: 8px;
    height: 36px;
    padding: 0 4px 0 12px;
    border-radius: 12px;
    border: 1px solid var(--gt-line);
    background: color-mix(in srgb, var(--gt-fg) 3%, transparent);
  }
  .ss-field-label {
    font: 600 9.5px/1 var(--mono);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--gt-faint);
    white-space: nowrap;
  }
  .ss-field input {
    width: 56px; height: 28px;
    border: 0; border-radius: 8px;
    padding: 0 8px;
    background: color-mix(in srgb, var(--gt-fg) 6%, transparent);
    color: var(--gt-fg);
    font: 500 12.5px var(--mono);
    text-align: center;
  }
  .ss-field input:focus { outline: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--gt-gold) 45%, transparent); }
  .ss-toggle {
    display: inline-flex; align-items: center; gap: 8px;
    height: 36px; padding: 0 12px;
    border-radius: 12px;
    border: 1px solid var(--gt-line);
    background: color-mix(in srgb, var(--gt-fg) 3%, transparent);
    cursor: pointer;
    font-size: 12px;
    color: var(--gt-dim);
    transition: border-color 200ms ease, color 200ms ease;
    user-select: none;
  }
  .ss-toggle:hover { color: var(--gt-fg); border-color: color-mix(in srgb, var(--gt-gold) 28%, transparent); }
  .ss-toggle input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .ss-switch {
    position: relative; width: 28px; height: 16px; border-radius: 999px;
    background: color-mix(in srgb, var(--gt-fg) 14%, transparent);
    transition: background 240ms ease;
    flex: none;
  }
  .ss-switch::after {
    content: ""; position: absolute; top: 2px; left: 2px;
    width: 12px; height: 12px; border-radius: 50%;
    background: var(--gt-fg);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
    transition: transform 280ms var(--gt-ease);
  }
  .ss-toggle input:checked + .ss-switch { background: var(--gt-gold); }
  .ss-toggle input:checked + .ss-switch::after { transform: translateX(12px); background: #fff; }
  .ss-toggle input:focus-visible + .ss-switch { box-shadow: 0 0 0 3px color-mix(in srgb, var(--gt-gold) 40%, transparent); }
  .ss-path {
    margin-left: auto;
    max-width: 100%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font: 500 11px var(--mono);
    color: var(--gt-faint);
  }

  /* list */
  .ss-list { padding: 6px; }
  .ss-head, .ss-row {
    display: grid;
    grid-template-columns: minmax(220px, 2.2fr) 92px 118px minmax(120px, 1fr) minmax(120px, 1fr) 264px 44px;
    align-items: center;
    gap: 14px;
    padding: 0 14px;
  }
  .ss-head {
    height: 38px;
    font: 600 9.5px/1 var(--mono);
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--gt-faint);
  }
  .ss-row {
    position: relative;
    min-height: 66px;
    padding-top: 10px; padding-bottom: 10px;
    border-radius: 14px;
    border: 1px solid transparent;
    transition: background 240ms ease, border-color 240ms ease, transform 360ms var(--gt-ease), box-shadow 360ms var(--gt-ease);
  }
  .ss-row + .ss-row::before {
    content: ""; position: absolute; left: 14px; right: 14px; top: -1px; height: 1px;
    background: linear-gradient(90deg, transparent, var(--gt-line) 15%, var(--gt-line) 85%, transparent);
  }
  .ss-row:hover, .ss-row:focus-within {
    background: linear-gradient(90deg, color-mix(in srgb, var(--gt-gold) 7%, transparent), color-mix(in srgb, var(--gt-fg) 3%, transparent));
    border-color: color-mix(in srgb, var(--gt-gold) 20%, transparent);
    box-shadow: 0 10px 30px -18px rgba(0, 0, 0, 0.7);
  }
  .ss-row:hover::before, .ss-row:hover + .ss-row::before { opacity: 0; }

  .ss-who { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .ss-avatar {
    --ss-h: 40;
    position: relative;
    flex: none;
    width: 38px; height: 38px;
    display: grid; place-items: center;
    border-radius: 12px;
    font: 650 13px/1 var(--g-font-family, inherit);
    letter-spacing: -0.02em;
    color: color-mix(in srgb, var(--gt-gold) 80%, #fff 20%);
    background:
      radial-gradient(circle at 30% 22%, rgba(255, 255, 255, 0.22), transparent 55%),
      linear-gradient(145deg,
        color-mix(in srgb, var(--gt-gold) calc(var(--ss-h) * 1%), #1c1917),
        color-mix(in srgb, var(--gt-gold) calc(var(--ss-h) * 0.35%), #0c0a09));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gt-gold) 35%, transparent), 0 6px 16px -6px rgba(0, 0, 0, 0.7);
    text-transform: uppercase;
  }
  :root[data-theme="light"] .ss-avatar { color: #fffbeb; }
  .ss-avatar .gt-light { position: absolute; right: -2px; bottom: -2px; width: 9px; height: 9px; outline: 2px solid var(--bg, #050505); }
  .ss-names { display: grid; gap: 3px; min-width: 0; }
  .ss-name {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 13.5px; font-weight: 600; color: var(--gt-fg);
    text-decoration: none;
  }
  a.ss-name:hover { color: var(--gt-gold-ink); }
  a.ss-name:focus-visible { outline: 2px solid var(--gt-gold); outline-offset: 2px; border-radius: 4px; }
  .ss-key {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font: 500 10.5px/1.2 var(--mono);
    color: var(--gt-faint);
  }
  .ss-kind[data-kind="direct"] { color: var(--gt-gold-ink); }
  .ss-time { display: grid; gap: 3px; }
  .ss-time-main { font-size: 12.5px; color: var(--gt-fg); font-variant-numeric: tabular-nums; }
  .ss-time-sub { font: 500 10px var(--mono); color: var(--gt-faint); text-transform: uppercase; letter-spacing: 0.1em; }
  .ss-meter { display: grid; gap: 6px; min-width: 0; }
  .ss-meter-text { font: 500 11px var(--mono); color: var(--gt-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ss-bar { height: 4px; border-radius: 999px; background: color-mix(in srgb, var(--gt-fg) 8%, transparent); overflow: hidden; }
  .ss-bar > i {
    display: block; height: 100%; border-radius: inherit;
    background: linear-gradient(90deg, color-mix(in srgb, var(--gt-gold) 55%, transparent), var(--gt-gold));
    box-shadow: 0 0 10px color-mix(in srgb, var(--gt-gold) 55%, transparent);
  }
  .ss-bar[data-hot] > i { background: linear-gradient(90deg, var(--warn), var(--danger)); box-shadow: 0 0 10px color-mix(in srgb, var(--danger) 50%, transparent); }
  .ss-label {
    width: 100%; box-sizing: border-box;
    height: 32px; padding: 0 10px;
    border-radius: 10px;
    border: 1px solid transparent;
    background: color-mix(in srgb, var(--gt-fg) 4%, transparent);
    color: var(--gt-fg);
    font: 12.5px var(--g-font-family, inherit);
    transition: border-color 200ms ease, background 200ms ease, box-shadow 240ms ease;
  }
  .ss-label::placeholder { color: var(--gt-faint); }
  .ss-label:hover { border-color: var(--gt-line); }
  .ss-label:focus { outline: none; border-color: color-mix(in srgb, var(--gt-gold) 50%, transparent); box-shadow: 0 0 0 3px var(--gt-gold-faint); background: color-mix(in srgb, var(--bg, #050505) 40%, transparent); }
  .ss-levels { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
  .ss-level { display: grid; gap: 4px; min-width: 0; }
  .ss-level-k { font: 600 8.5px/1 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--gt-faint); padding-left: 2px; }
  .ss-select {
    appearance: none; -webkit-appearance: none;
    width: 100%; height: 28px;
    padding: 0 22px 0 9px;
    border-radius: 9px;
    border: 1px solid var(--gt-line);
    background:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E") no-repeat right 7px center,
      color-mix(in srgb, var(--gt-fg) 4%, transparent);
    color: var(--gt-fg);
    font: 500 11.5px var(--mono);
    cursor: pointer;
    transition: border-color 200ms ease;
  }
  .ss-select:hover { border-color: color-mix(in srgb, var(--gt-gold) 30%, transparent); }
  .ss-select:focus { outline: none; border-color: color-mix(in srgb, var(--gt-gold) 55%, transparent); box-shadow: 0 0 0 3px var(--gt-gold-faint); }
  .ss-select option { background: var(--bg-elevated, #111); color: var(--text); }
  .ss-del {
    width: 36px; height: 36px; padding: 0;
    border-radius: 11px;
    color: var(--gt-faint);
    background: transparent;
    border-color: transparent;
  }
  .ss-del svg { width: 16px; height: 16px; }
  .ss-row:hover .ss-del { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 30%, transparent); background: var(--danger-subtle); }
  .ss-del:focus-visible { color: var(--danger); }
  input:disabled, select:disabled { opacity: 0.55; cursor: not-allowed; }

  .ss-skel-row { display: grid; grid-template-columns: 38px 1fr 120px 160px; gap: 14px; align-items: center; padding: 14px; }
  .ss-skel-row .gt-skel:first-child { height: 38px; border-radius: 12px; }
  .ss-skel-row .gt-skel { height: 12px; }
  .ss-no-match { display: none; }

  /* client-side filters are applied by toggling data attributes on .ss-root */
  .ss-root[data-kind="direct"] .ss-row:not([data-kind="direct"]),
  .ss-root[data-kind="group"] .ss-row:not([data-kind="group"]),
  .ss-root[data-kind="global"] .ss-row:not([data-kind="global"]),
  .ss-root[data-kind="unknown"] .ss-row:not([data-kind="unknown"]) { display: none; }

  @media (max-width: 1180px) {
    .ss-head { display: none; }
    .ss-row {
      grid-template-columns: minmax(0, 1fr) auto auto;
      grid-template-areas:
        "who time del"
        "kind meter meter"
        "label label label"
        "levels levels levels";
      gap: 10px 12px;
      padding: 14px;
      margin-bottom: 6px;
      background: color-mix(in srgb, var(--gt-fg) 2.5%, transparent);
      border-color: var(--gt-line);
    }
    .ss-row + .ss-row::before { display: none; }
    .ss-c-who { grid-area: who; min-width: 0; }
    .ss-c-kind { grid-area: kind; }
    .ss-c-time { grid-area: time; text-align: right; }
    .ss-c-meter { grid-area: meter; }
    .ss-c-label { grid-area: label; }
    .ss-c-levels { grid-area: levels; }
    .ss-c-del { grid-area: del; }
  }
  @media (max-width: 640px) {
    .ss-root { padding: 18px 12px 40px; }
    .ss-hero-side { width: 100%; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .ss-hero-side .ss-activity { grid-column: 1 / -1; min-width: 0; }
    .ss-hero-side .gt-stat { min-width: 0; }
    .ss-refresh { grid-column: 1 / -1; }
    .ss-toolbar { padding: 12px; }
    .ss-search { flex-basis: 100%; }
    .ss-filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .ss-filters > * { min-width: 0; }
    .ss-field { padding-left: 10px; }
    .ss-field-label { overflow: hidden; text-overflow: ellipsis; letter-spacing: 0.08em; }
    .ss-field input { width: 52px; flex: none; }
    .ss-field { justify-content: space-between; }
    .ss-toggle { justify-content: flex-start; white-space: nowrap; font-size: 11.5px; padding: 0 10px; overflow: hidden; }
    .ss-path { grid-column: 1 / -1; margin-left: 0; }
    .ss-list { padding: 4px; }
    .ss-row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "who del" "kind time" "meter meter" "label label" "levels levels"; }
    .ss-c-time { text-align: right; }
    .ss-select, .ss-label { height: 40px; }
    .ss-del { width: 40px; height: 40px; }
    .ss-skel-row { grid-template-columns: 38px 1fr; }
    .ss-skel-row .gt-skel:nth-child(n+3) { display: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .ss-row, .ss-switch, .ss-switch::after { transition: none; }
    .ss-refresh[data-busy] svg { animation: none; }
  }
`;

// ══════════════════════════════════════════════════════════════════════════════
// Constants
// ══════════════════════════════════════════════════════════════════════════════

const VERBOSE_LEVELS = [
  { value: "", label: "inherit" },
  { value: "off", label: "off" },
  { value: "on", label: "on" },
] as const;
const REASONING_LEVELS = ["", "off", "on", "stream"] as const;

const KIND_FILTERS = [
  { id: "all", label: "All" },
  { id: "direct", label: "Direct" },
  { id: "group", label: "Group" },
  { id: "global", label: "Global" },
  { id: "unknown", label: "Unknown" },
] as const;

const searchIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`;
const refreshIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/></svg>`;
const trashIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>`;
const sessionsIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="16" r="3"/></svg>`;

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

function kindOf(row: GatewaySessionRow): string {
  const kind = String(row.kind ?? "unknown");
  return KIND_FILTERS.some((k) => k.id === kind) ? kind : "unknown";
}

/** Agent id from keys like `agent:<id>:…`; falls back to the channel/kind. */
function agentOf(row: GatewaySessionRow): string {
  const m = /^agent:([^:]+)/.exec(row.key);
  if (m) return m[1];
  return row.channel || row.lastChannel || row.kind || "session";
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return 22 + (Math.abs(h) % 46); // 22..67 → gold mix strength
}

function initials(s: string): string {
  const parts = s.replace(/[^a-z0-9]+/gi, " ").trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).slice(0, 2);
  return (parts[0] || "?").slice(0, 2);
}

function recencyState(updatedAt: number | null): { state: string; label: string; pulse: boolean } {
  if (!updatedAt) return { state: "idle", label: "No activity", pulse: false };
  const age = Date.now() - updatedAt;
  if (age < 5 * 60_000) return { state: "ok", label: "Live", pulse: true };
  if (age < 60 * 60_000) return { state: "gold", label: "Recent", pulse: false };
  if (age < 24 * 60 * 60_000) return { state: "warn", label: "Today", pulse: false };
  return { state: "idle", label: "Idle", pulse: false };
}

/** 24 hourly buckets of sessions last updated in that hour (oldest → newest). */
function activitySeries(rows: GatewaySessionRow[]): number[] {
  const buckets = new Array(24).fill(0);
  const now = Date.now();
  for (const r of rows) {
    if (!r.updatedAt) continue;
    const h = Math.floor((now - r.updatedAt) / 3_600_000);
    if (h >= 0 && h < 24) buckets[23 - h] += 1;
  }
  return buckets;
}

function searchText(row: GatewaySessionRow): string {
  return [row.key, row.displayName, row.label, row.derivedTitle, row.channel, row.model, row.kind, agentOf(row)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function applyKindFilter(e: Event, kind: string) {
  const btn = e.currentTarget as HTMLElement;
  const root = btn.closest(".ss-root") as HTMLElement | null;
  if (!root) return;
  root.dataset.kind = kind;
  root.querySelectorAll<HTMLElement>(".ss-seg button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.kind === kind)),
  );
}

function applySearch(e: Event) {
  const input = e.currentTarget as HTMLInputElement;
  const root = input.closest(".ss-root") as HTMLElement | null;
  const style = root?.querySelector<HTMLStyleElement>("style.ss-search-rule");
  if (!root || !style) return;
  const q = input.value.trim().toLowerCase().replace(/["\\]/g, "");
  // An attribute-substring rule keeps working across Lit re-renders of the rows.
  style.textContent = q ? `.ss-root .ss-row:not([data-q*="${q}"]) { display: none; }` : "";
}

// ══════════════════════════════════════════════════════════════════════════════
// Render
// ══════════════════════════════════════════════════════════════════════════════

export function renderSessions(props: SessionsProps) {
  const rows = props.result?.sessions ?? [];
  const sessionCount = rows.length;
  const liveCount = rows.filter((r) => r.updatedAt && Date.now() - r.updatedAt < 5 * 60_000).length;
  const totalTokens = rows.reduce((n, r) => n + (r.totalTokens ?? 0), 0);
  const kindCounts = new Map<string, number>();
  for (const r of rows) kindCounts.set(kindOf(r), (kindCounts.get(kindOf(r)) ?? 0) + 1);
  const series = activitySeries(rows);
  const fmtCompact = (n: number) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const filters = {
    activeMinutes: props.activeMinutes,
    limit: props.limit,
    includeGlobal: props.includeGlobal,
    includeUnknown: props.includeUnknown,
  };

  return html`
    <style>${GLASS_TOOLS_CSS}${sessionsStyles}</style>
    <div class="ss-root gt-scope" data-kind="all">
      <style class="ss-search-rule"></style>
      ${glassAurora()}

      <header class="gt-hero">
        <div>
          <span class="gt-eyebrow">Conversations</span>
          <h1 class="gt-title">Sessions</h1>
          <p class="gt-sub">Every conversation your agents hold — tune thinking, verbosity and reasoning per session, or clear what you no longer need.</p>
        </div>
        <div class="ss-hero-side">
          <div class="gt-stat gt-glass">
            <span class="gt-stat-value">${sessionCount}</span>
            <span class="gt-stat-label">Sessions</span>
          </div>
          <div class="gt-stat gt-glass">
            <span class="gt-stat-value">${liveCount}</span>
            <span class="gt-stat-label">Live · 5m</span>
          </div>
          <div class="gt-stat gt-glass">
            <span class="gt-stat-value">${fmtCompact(totalTokens)}</span>
            <span class="gt-stat-label">Tokens</span>
          </div>
          <div class="ss-activity gt-glass" title="Sessions last active in each of the past 24 hours">
            <span class="gt-stat-label" style="margin:0">Activity · 24h</span>
            ${glassSparkline(series, { width: 180, height: 30, label: "Sessions active per hour, last 24 hours" })}
          </div>
          <button
            class="gt-btn gt-primary ss-refresh"
            ?disabled=${props.loading}
            ?data-busy=${props.loading}
            @click=${props.onRefresh}
          >
            ${refreshIcon} ${props.loading ? "Syncing…" : "Refresh"}
          </button>
        </div>
      </header>

      ${props.error
        ? html`<div class="ss-error" role="alert"><span class="gt-light" data-state="danger"></span>${props.error}</div>`
        : nothing}

      <!-- Filters -->
      <section class="ss-toolbar gt-glass" aria-label="Session filters">
        <div class="ss-toolbar-row">
          <label class="ss-search">
            ${searchIcon}
            <input
              class="gt-input"
              type="search"
              placeholder="Search sessions, agents, labels, models…"
              aria-label="Search sessions"
              @input=${applySearch}
            />
          </label>
          <div class="gt-seg ss-seg" role="group" aria-label="Filter by kind">
            ${KIND_FILTERS.map(
              (k) => html`<button
                type="button"
                data-kind=${k.id}
                aria-pressed=${k.id === "all" ? "true" : "false"}
                @click=${(e: Event) => applyKindFilter(e, k.id)}
              >
                ${k.label}<span class="ss-seg-count">${k.id === "all" ? sessionCount : (kindCounts.get(k.id) ?? 0)}</span>
              </button>`,
            )}
          </div>
        </div>
        <div class="ss-filters">
          <label class="ss-field" title="Only sessions active within this many minutes">
            <span class="ss-field-label">Active (min)</span>
            <input
              type="text"
              inputmode="numeric"
              placeholder="Any"
              .value=${props.activeMinutes}
              @input=${(e: Event) =>
                props.onFiltersChange({ ...filters, activeMinutes: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="ss-field">
            <span class="ss-field-label">Limit</span>
            <input
              type="text"
              inputmode="numeric"
              .value=${props.limit}
              @input=${(e: Event) =>
                props.onFiltersChange({ ...filters, limit: (e.target as HTMLInputElement).value })}
            />
          </label>
          <label class="ss-toggle">
            <input
              type="checkbox"
              .checked=${props.includeGlobal}
              @change=${(e: Event) =>
                props.onFiltersChange({ ...filters, includeGlobal: (e.target as HTMLInputElement).checked })}
            />
            <span class="ss-switch" aria-hidden="true"></span>
            <span>Include global</span>
          </label>
          <label class="ss-toggle">
            <input
              type="checkbox"
              .checked=${props.includeUnknown}
              @change=${(e: Event) =>
                props.onFiltersChange({ ...filters, includeUnknown: (e.target as HTMLInputElement).checked })}
            />
            <span class="ss-switch" aria-hidden="true"></span>
            <span>Include unknown</span>
          </label>
          ${props.result?.path
            ? html`<span class="ss-path" title=${props.result.path}>${props.result.path}</span>`
            : nothing}
        </div>
      </section>

      <!-- Sessions list -->
      <section class="ss-list gt-glass" aria-label="Sessions">
        ${rows.length === 0 && !props.loading
          ? html`<div class="gt-empty">
              <div class="gt-empty-orb">${sessionsIcon}</div>
              <div class="gt-empty-title">No sessions found</div>
              <div class="gt-empty-sub">
                Nothing matches the current window. Widen “Active (min)”, raise the limit, or include
                global and unknown sessions.
              </div>
            </div>`
          : nothing}

        ${props.loading && rows.length === 0
          ? [0, 1, 2, 3].map(
              () => html`<div class="ss-skel-row" aria-hidden="true">
                <div class="gt-skel"></div>
                <div class="gt-skel" style="width:62%"></div>
                <div class="gt-skel"></div>
                <div class="gt-skel"></div>
              </div>`,
            )
          : nothing}

        ${rows.length > 0
          ? html`
              <div class="ss-head">
                <span>Session</span>
                <span>Kind</span>
                <span>Updated</span>
                <span>Tokens</span>
                <span>Label</span>
                <span>Thinking · Verbose · Reasoning</span>
                <span></span>
              </div>
              ${rows.map((row, i) =>
                renderRow(row, i, props.basePath, props.onPatch, props.onDelete, props.loading),
              )}
            `
          : nothing}
      </section>
    </div>
  `;
}

function renderRow(
  row: GatewaySessionRow,
  index: number,
  basePath: string,
  onPatch: SessionsProps["onPatch"],
  onDelete: SessionsProps["onDelete"],
  disabled: boolean,
) {
  const updated = row.updatedAt ? formatAgo(row.updatedAt) : "n/a";
  const rawThinking = row.thinkingLevel ?? "";
  const isBinaryThinking = isBinaryThinkingProvider(row.modelProvider);
  const thinking = resolveThinkLevelDisplay(rawThinking, isBinaryThinking);
  const thinkLevels = resolveThinkLevelOptions(row.modelProvider);
  const verbose = row.verboseLevel ?? "";
  const reasoning = row.reasoningLevel ?? "";
  const displayName = row.displayName ?? row.key;
  const canLink = row.kind !== "global";
  const chatUrl = canLink
    ? `${pathForTab("chat", basePath)}?session=${encodeURIComponent(row.key)}`
    : null;
  const agent = agentOf(row);
  const kind = kindOf(row);
  const recency = recencyState(row.updatedAt);
  const ctx = row.contextTokens ?? 0;
  const pct = ctx && row.totalTokens != null ? Math.min(100, (row.totalTokens / ctx) * 100) : 0;

  return html`
    <div
      class="ss-row gt-rise"
     
      style="--gt-i:${Math.min(index, 12)}"
      data-kind=${kind}
      data-q=${searchText(row)}
    >
      <div class="ss-c-who ss-who">
        <span class="ss-avatar" style="--ss-h:${hashHue(agent)}" title=${`Agent: ${agent}`} aria-hidden="true">
          ${initials(agent)}
          <span class="gt-light" data-state=${recency.state} ?data-pulse=${recency.pulse}></span>
        </span>
        <div class="ss-names">
          ${canLink
            ? html`<a href=${chatUrl} class="ss-name session-link" title=${displayName}>${displayName}</a>`
            : html`<span class="ss-name" title=${displayName}>${displayName}</span>`}
          <span class="ss-key" title=${row.key}>${agent}${row.model ? html` · ${row.model}` : nothing}</span>
        </div>
      </div>
      <div class="ss-c-kind">
        <span class="gt-chip ss-kind" data-kind=${kind} data-tone=${kind === "direct" ? "gold" : ""}>${row.kind}</span>
      </div>
      <div class="ss-c-time ss-time">
        <span class="ss-time-main">${updated}</span>
        <span class="ss-time-sub">${recency.label}</span>
      </div>
      <div class="ss-c-meter ss-meter" title=${ctx ? `${Math.round(pct)}% of context window` : "Total tokens"}>
        <span class="ss-meter-text">${formatSessionTokens(row)}</span>
        ${ctx ? html`<span class="ss-bar" ?data-hot=${pct > 80}><i style="width:${pct.toFixed(1)}%"></i></span>` : nothing}
      </div>
      <div class="ss-c-label">
        <input
          class="ss-label label-input"
          .value=${row.label ?? ""}
          ?disabled=${disabled}
          placeholder="Add a label…"
          aria-label=${`Label for ${displayName}`}
          @change=${(e: Event) => {
            const value = (e.target as HTMLInputElement).value.trim();
            onPatch(row.key, { label: value || null });
          }}
        />
      </div>
      <div class="ss-c-levels ss-levels">
        <label class="ss-level">
          <span class="ss-level-k">Think</span>
          <select
            class="ss-select select-mini"
            .value=${thinking}
            ?disabled=${disabled}
            @change=${(e: Event) => {
              const value = (e.target as HTMLSelectElement).value;
              onPatch(row.key, {
                thinkingLevel: resolveThinkLevelPatchValue(value, isBinaryThinking),
              });
            }}
          >
            ${thinkLevels.map((level) => html`<option value=${level}>${level || "—"}</option>`)}
          </select>
        </label>
        <label class="ss-level">
          <span class="ss-level-k">Verbose</span>
          <select
            class="ss-select select-mini"
            .value=${verbose}
            ?disabled=${disabled}
            @change=${(e: Event) => {
              const value = (e.target as HTMLSelectElement).value;
              onPatch(row.key, { verboseLevel: value || null });
            }}
          >
            ${VERBOSE_LEVELS.map((level) => html`<option value=${level.value}>${level.label}</option>`)}
          </select>
        </label>
        <label class="ss-level">
          <span class="ss-level-k">Reason</span>
          <select
            class="ss-select select-mini"
            .value=${reasoning}
            ?disabled=${disabled}
            @change=${(e: Event) => {
              const value = (e.target as HTMLSelectElement).value;
              onPatch(row.key, { reasoningLevel: value || null });
            }}
          >
            ${REASONING_LEVELS.map((level) => html`<option value=${level}>${level || "—"}</option>`)}
          </select>
        </label>
      </div>
      <div class="ss-c-del">
        <button
          class="gt-btn ss-del delete-btn"
          ?disabled=${disabled}
          title="Delete session"
          aria-label=${`Delete session ${displayName}`}
          @click=${() => onDelete(row.key)}
        >
          ${trashIcon}
        </button>
      </div>
    </div>
  `;
}

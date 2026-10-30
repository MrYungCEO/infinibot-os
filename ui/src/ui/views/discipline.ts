import { html, nothing, svg, type TemplateResult } from "lit";
import { icons } from "../icons";
import type { GatewayBrowserClient } from "../gateway";
import type { AppViewState } from "../app-view-state";
import {
  type AnalyticsWindow,
  type BlockCompletionItem,
  type BlockDraft,
  type BlockStats,
  type DayScore,
  type DisciplineBlock,
  type DisciplineCategory,
  type DisciplineEventCountSummary,
  type DisciplineFilterState,
  type DisciplineInsight,
  type DisciplineLog,
  type DisciplinePriority,
  type DisciplineState,
  type DisciplineSubView,
  type DisciplineTemplate,
  type KanbanProjectLite,
  type KanbanTaskLite,
  type TelegramEventToggles,
  type TemplateModalState,
  type WorkEvent,
  type WorkloadSummary,
  type WorkloadWeekDay,
  loadWorkEvents,
  DISCIPLINE_CATEGORIES,
  DISCIPLINE_PRESETS,
  CATEGORY_COLORS,
  applyPreset,
  beginCreate,
  beginEdit,
  blockLinkContext,
  blockPriority,
  blockProgress,
  getDisciplineFocusProjects,
  isProjectFocused,
  toggleProjectActiveFromDiscipline,
  cancelBlockEditor,
  createBlock,
  currentBlock,
  deleteBlock,
  effectiveStart,
  isBlockDoneToday,
  isQuietHoursNow,
  isTemplateDirty,
  activeTemplateName,
  applyTemplate,
  clearActiveTemplate,
  deleteTemplate,
  loadAnalyticsRange,
  loadAutoLogCounts,
  loadDiscipline,
  loadKanbanLinks,
  loadTemplates,
  overwriteTemplate,
  renameTemplate,
  saveAsTemplate,
  markBlockDone,
  minutesUntilNext,
  newRoutineItemId,
  nextBlock,
  quickLog,
  resetBlockOverrides,
  shiftBlocksFromNow,
  sortByPriority,
  startDisciplineTicker,
  startLog,
  stopLog,
  streakDays,
  toggleRoutineItem,
  unmarkBlockDone,
  updateBlock,
  updateSettings,
  toggleKanbanTaskDone,
  setKanbanTaskStatus,
  setTaskModalProjectFilter,
  setTaskModalViewMode,
} from "../controllers/discipline";
import {
  requestAiAdvice,
  sendTelegram,
} from "../controllers/discipline-notify";
import {
  addReflectionEvent,
  renderReflectionCards,
  setReflectionRequestUpdate,
} from "../components/discipline-reflection-card";
// Proactive Overhaul v2 — commitment-enforced focus + drift radar. Self-contained
// custom element; registers on import and drives its own proactive.* RPCs.
import "../components/proactive-panel";
import { wgAurora, wgEmpty, wgHero } from "./work-glass";
import "./work-glass/discipline.css";

const _prevAutoLogTotals = new Map<string, number>();
let _blocksDisplayMode: "board" | "list" = "board";

/**
 * Quick-log bar UI draft, kept in module scope so the input/category survive
 * across re-renders without us having to wire it into DisciplineState (which
 * is shared with controllers and would force a server-shaped migration). The
 * bar's purpose is to make "logged that I did X" a one-action interaction:
 * type → Enter. Category defaults to the currently-active block's category,
 * falling back to deep-work, so the common case is zero clicks before Enter.
 */
const _quickLog = {
  label: "" as string,
  category: null as DisciplineCategory | null,
  saving: false as boolean,
  flash: 0 as number,
};
const QUICK_LOG_INPUT_ID = "disc-quick-log-input";

function quickLogCategoryFor(ds: DisciplineState): DisciplineCategory {
  if (_quickLog.category) return _quickLog.category;
  const active = currentBlock(ds);
  return active?.category ?? "deep-work";
}

async function submitQuickLog(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const label = _quickLog.label.trim();
  if (!label || _quickLog.saving) return;
  _quickLog.saving = true;
  host.requestUpdate?.();
  try {
    await quickLog(ds, client, {
      label,
      category: quickLogCategoryFor(ds),
      blockId: currentBlock(ds)?.id,
    });
    _quickLog.label = "";
    _quickLog.flash = Date.now();
  } finally {
    _quickLog.saving = false;
    host.requestUpdate?.();
  }
}

function focusQuickLogBar(): void {
  const el = document.getElementById(QUICK_LOG_INPUT_ID) as HTMLInputElement | null;
  if (el) {
    el.focus();
    el.select?.();
  }
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const CATEGORY_LABELS: Record<DisciplineCategory, string> = {
  "deep-work": "Deep Work",
  meetings: "Meetings",
  ops: "Ops",
  body: "Body",
  admin: "Admin",
  break: "Break",
  personal: "Personal",
};
const DURATION_PRESETS: Array<{ mins: number; label: string }> = [
  { mins: 25, label: "25m" },
  { mins: 50, label: "50m" },
  { mins: 90, label: "90m" },
  { mins: 120, label: "2h" },
];

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function minsToHHMM(m: number): string {
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}
function hhmmToMins(s: string): number {
  const [h, m] = s.split(":").map((x) => parseInt(x, 10));
  return (h || 0) * 60 + (m || 0);
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function nowMinutes(): number {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}
function scoreHue(score: number): string {
  if (score >= 85) return "#10B981";
  if (score >= 60) return "var(--g-primary)";
  if (score >= 30) return "#F59E0B";
  return "#EF4444";
}
function humanDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// Re-render the Discipline view whenever the Focus list changes elsewhere
// (e.g. the user pins/unpins a project on the Focus board) so the active
// project set stays in sync without a full reload. Installed once; the handler
// only fires a re-render while the user is actually on the Discipline tab.
let focusChangedHostRef: AppViewState | null = null;
let focusChangedHandlerAttached = false;
function ensureFocusChangedHandler(host: AppViewState): void {
  focusChangedHostRef = host;
  if (focusChangedHandlerAttached) return;
  focusChangedHandlerAttached = true;
  window.addEventListener("infinibot:focus-changed", () => {
    if ((focusChangedHostRef as any)?.tab !== "discipline") return;
    focusChangedHostRef?.requestUpdate?.();
  });
}

let keyHandlerAttached = false;
function ensureKeyHandler(state: DisciplineState, host: AppViewState, client: GatewayBrowserClient): void {
  if (keyHandlerAttached) return;
  keyHandlerAttached = true;
  window.addEventListener("keydown", (e) => {
    if ((host as any).tab !== "discipline") return;
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (state.modal) {
      if (e.key === "Escape") {
        state.modal = null;
        host.requestUpdate?.();
      }
      return;
    }
    if (state.templateModal) {
      if (e.key === "Escape") {
        state.templateModal = null;
        host.requestUpdate?.();
      }
      return;
    }
    if (state.creatingBlock || state.editingBlockId) {
      if (e.key === "Escape") {
        cancelBlockEditor(state);
        host.requestUpdate?.();
      }
      return;
    }
    if (e.key === "1") { state.subView = "timeline"; host.requestUpdate?.(); }
    else if (e.key === "2") { state.subView = "blocks"; host.requestUpdate?.(); }
    else if (e.key === "3") { state.subView = "score"; host.requestUpdate?.(); }
    else if (e.key === "4") { state.subView = "settings"; host.requestUpdate?.(); }
    else if (e.key === "n" || e.key === "N") {
      beginCreate(state);
      state.subView = "blocks";
      host.requestUpdate?.();
    }
    else if (e.key === "l" || e.key === "L") {
      // Quick-log shortcut: focus the always-visible bar in the hero so the
      // user can type a log entry without reaching for the mouse. Pairs with
      // the click-to-focus on the bar itself so both interaction modes land
      // in the same place.
      e.preventDefault();
      focusQuickLogBar();
    }
  });
}

function disciplineStyles(): TemplateResult {
  return html`
    <style>
      /* The discipline view inherits the global theme background (Aurora,
         Faulty Terminal, Gradient, …) — every surface uses semi-transparent
         backgrounds + backdrop-filter so the underlying canvas shows through.
         Local color tokens map onto theme vars so palette swaps reskin the
         page without touching this stylesheet. */
      .disc-root {
        font-family: var(--glass-font, var(--g-font-family, "Inter", "SF Pro Display", -apple-system, sans-serif));
        background: transparent;
        color: var(--glass-fg, var(--g-fg, #f5eacd));
        min-height: calc(100vh - 56px);
        padding: 20px 24px 40px;
        box-sizing: border-box;
        position: relative;
        /* Glass G1: every rule below reads --g-primary for its accent, so
           point it at the glass gold here (deeper antique gold in light
           mode, palette-aware in dark). --glass-gold is resolved on :root,
           so this does not loop. The --disc-* tokens map onto the glass
           text/surface tiers so light theme and reduced transparency follow. */
        --g-primary: var(--glass-gold, #d9b45f);
        --disc-accent: var(--glass-gold, #d9b45f);
        --disc-fg: var(--glass-fg, #f5eacd);
        --disc-fg-dim: var(--glass-fg-2, #c9b880);
        --disc-fg-faint: var(--glass-fg-3, #9b8b4d);
        --disc-fg-mute: var(--glass-fg-4, #6a5f3a);
        --disc-surface: var(--glass-2, rgba(10, 10, 14, 0.55));
        --disc-surface-strong: var(--glass-4, rgba(10, 10, 14, 0.75));
        --disc-surface-soft: var(--glass-1, rgba(10, 10, 14, 0.35));
        --disc-border: var(--glass-stroke-gold, color-mix(in srgb, var(--g-primary) 22%, transparent));
        --disc-border-soft: var(--glass-stroke, color-mix(in srgb, var(--g-primary) 12%, transparent));
        --disc-shadow: var(--glass-elev-2, 0 12px 36px rgba(5, 5, 7, 0.8));
      }
      .disc-root * { box-sizing: border-box; }

      /* ── HERO ── */
      .disc-hero {
        position: relative;
        display: grid;
        grid-template-columns: 1fr;
        grid-auto-flow: column;
        grid-auto-columns: auto;
        gap: 22px;
        align-items: center;
        padding: 20px 24px;
        border-radius: 16px;
        background:
          linear-gradient(135deg,
            color-mix(in srgb, var(--g-primary) 10%, transparent) 0%,
            color-mix(in srgb, var(--g-primary) 2%, transparent) 40%,
            transparent 100%),
          var(--disc-surface);
        border: 1px solid var(--disc-border);
        backdrop-filter: blur(18px) saturate(140%);
        -webkit-backdrop-filter: blur(18px) saturate(140%);
        box-shadow:
          0 1px 0 color-mix(in srgb, var(--g-primary) 14%, transparent) inset,
          var(--disc-shadow),
          0 0 0 0 var(--disc-glow, transparent);
        margin-bottom: 20px;
        overflow: hidden;
        transition: box-shadow 0.4s ease;
      }
      .disc-hero::before {
        content: "";
        position: absolute;
        inset: 0;
        background: radial-gradient(ellipse 40% 100% at 100% 50%, var(--disc-glow, transparent), transparent);
        opacity: 0.4;
        pointer-events: none;
      }
      .disc-hero__left { min-width: 0; position: relative; z-index: 1; }
      .disc-hero__kicker {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--disc-fg-faint);
        margin-bottom: 4px;
      }
      .disc-hero__dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: var(--g-primary);
        box-shadow: 0 0 12px color-mix(in srgb, var(--g-primary) 90%, transparent);
        animation: discPulse 1.8s ease-in-out infinite;
      }
      @keyframes discPulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(0.85); }
      }
      .disc-hero__title {
        font-size: 24px;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: var(--g-primary);
        margin: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .disc-hero__sub {
        margin-top: 4px;
        font-size: 13px;
        color: var(--disc-fg-dim);
      }
      .disc-hero__progress {
        margin-top: 12px;
        height: 6px;
        border-radius: 99px;
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        overflow: hidden;
        position: relative;
      }
      .disc-hero__progress-fill {
        position: absolute; inset: 0 auto 0 0;
        background: linear-gradient(90deg, var(--g-primary), var(--g-primary));
        box-shadow: 0 0 14px color-mix(in srgb, var(--g-primary) 50%, transparent);
        transition: width 0.6s ease;
      }
      .disc-hero__stat {
        position: relative;
        z-index: 1;
        padding: 10px 18px 10px 18px;
        border-left: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
      }
      .disc-hero__stat-val {
        font-size: 28px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--val-color, var(--g-primary));
        line-height: 1;
      }
      .disc-hero__stat-lbl {
        margin-top: 6px;
        font-size: 10px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--disc-fg-faint);
      }
      .disc-hero__actions {
        display: flex; gap: 8px; position: relative; z-index: 1;
      }

      /* ── BUTTONS ── */
      .disc-btn {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 9px 16px;
        font-family: inherit;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.04em;
        background: color-mix(in srgb, var(--g-primary) 6%, transparent);
        color: var(--g-primary);
        border: 1px solid color-mix(in srgb, var(--g-primary) 25%, transparent);
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .disc-btn:hover {
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      }
      .disc-btn--primary {
        background: linear-gradient(135deg, var(--g-primary) 0%, var(--g-primary) 100%);
        color: #0a0700;
        border-color: var(--g-primary);
        box-shadow: 0 2px 12px color-mix(in srgb, var(--g-primary) 30%, transparent);
      }
      .disc-btn--primary:hover {
        box-shadow: 0 4px 20px color-mix(in srgb, var(--g-primary) 50%, transparent);
        transform: translateY(-1px);
      }
      .disc-btn--danger {
        color: #ff8a8a;
        border-color: rgba(255, 107, 107, 0.3);
        background: rgba(255, 107, 107, 0.06);
      }
      .disc-btn--danger:hover {
        background: rgba(255, 107, 107, 0.15);
        border-color: rgba(255, 107, 107, 0.5);
      }
      .disc-btn--ghost {
        background: transparent;
      }

      /* ── SUBNAV ── */
      .disc-subnav {
        display: inline-flex;
        gap: 4px;
        padding: 4px;
        margin-bottom: 20px;
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-radius: 10px;
      }
      .disc-subnav__tab {
        padding: 8px 18px;
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.04em;
        background: transparent;
        color: var(--disc-fg-faint);
        border: none;
        border-radius: 7px;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .disc-subnav__tab:hover { color: var(--disc-fg); }
      .disc-subnav__tab.active {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        color: var(--g-primary);
        box-shadow: 0 1px 0 color-mix(in srgb, var(--g-primary) 10%, transparent) inset;
      }
      .disc-subnav__hint {
        margin-left: auto;
        padding: 8px 12px;
        font-size: 11px;
        color: var(--disc-fg-mute);
      }
      .disc-subnav__hint kbd {
        padding: 2px 6px;
        font-family: inherit;
        font-size: 10px;
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 4px;
        color: var(--g-primary);
      }

      /* ── PANELS ── */
      .disc-panel {
        background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 3%, transparent), transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-radius: 12px;
        padding: 18px 20px;
      }
      .disc-panel h3 {
        margin: 0 0 14px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--disc-fg-faint);
      }

      .disc-input, .disc-select, .disc-textarea {
        width: 100%;
        background: var(--disc-surface);
        color: var(--g-primary);
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        padding: 10px 12px;
        font-family: inherit;
        font-size: 13px;
        border-radius: 8px;
        transition: border-color 0.15s, box-shadow 0.15s;
      }
      .disc-input:focus, .disc-select:focus, .disc-textarea:focus {
        outline: none;
        border-color: color-mix(in srgb, var(--g-primary) 60%, transparent);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary) 10%, transparent);
      }
      .disc-input::placeholder { color: var(--disc-fg-mute); }
      .disc-label {
        display: block;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--disc-fg-faint);
        margin-bottom: 6px;
      }

      /* ── TIMELINE ── */
      .disc-timeline {
        display: grid;
        /* Split layout: hours rail · timeline blocks · full kanban panel.
           The kanban gets equal width to the timeline so 4 status columns
           fit comfortably and tasks are visible enough to drag onto blocks. */
        grid-template-columns: 60px 1fr 1fr;
        gap: 16px;
      }
      @media (max-width: 1100px) {
        .disc-timeline { grid-template-columns: 60px 1fr; }
        .disc-timeline > .disc-tl-kanban { grid-column: 1 / -1; min-height: 480px; }
      }
      .disc-tl-kanban {
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-height: 0;
        background:
          linear-gradient(180deg,
            color-mix(in srgb, var(--g-primary) 4%, transparent) 0%,
            transparent 60%),
          var(--disc-surface-soft);
        border: 1px solid var(--disc-border-soft);
        border-radius: 14px;
        backdrop-filter: blur(14px) saturate(140%);
        -webkit-backdrop-filter: blur(14px) saturate(140%);
        box-shadow:
          inset 0 1px 0 color-mix(in srgb, var(--g-primary) 8%, transparent),
          var(--disc-shadow);
        padding: 14px;
      }
      .disc-tl-kanban__head {
        display: flex; align-items: center; gap: 8px;
        flex-shrink: 0;
      }
      .disc-tl-kanban__title {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 11px; font-weight: 700; letter-spacing: 0.18em;
        color: var(--g-primary); text-transform: uppercase;
      }
      .disc-tl-kanban__body {
        flex: 1; min-height: 0;
        overflow-y: auto;
        margin: 0 -4px; padding: 0 4px;
      }
      /* The utility stack moves below the rail+kanban split. */
      .disc-tl-utilities {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 14px;
        margin-top: 16px;
      }
      .disc-rail {
        position: relative;
        background:
          linear-gradient(180deg,
            color-mix(in srgb, var(--g-primary) 4%, transparent) 0%,
            transparent 60%),
          var(--disc-surface-soft);
        border: 1px solid var(--disc-border-soft);
        border-radius: 14px;
        backdrop-filter: blur(14px) saturate(140%);
        -webkit-backdrop-filter: blur(14px) saturate(140%);
        box-shadow:
          inset 0 1px 0 color-mix(in srgb, var(--g-primary) 8%, transparent),
          var(--disc-shadow);
        overflow: hidden;
      }
      .disc-rail__hours {
        padding: 4px 0;
      }
      .disc-rail__hour {
        height: 48px;
        padding: 0 10px;
        font-size: 10px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        color: var(--disc-fg-mute);
        display: flex;
        align-items: flex-start;
        justify-content: flex-end;
        padding-top: 4px;
        letter-spacing: 0.04em;
      }
      .disc-rail__slots {
        position: relative;
        padding: 4px 0;
      }
      .disc-rail__slot {
        height: 48px;
        border-bottom: 1px dashed color-mix(in srgb, var(--g-primary) 8%, transparent);
        cursor: pointer;
        transition: background 0.18s ease;
        position: relative;
      }
      .disc-rail__slot:hover {
        background: linear-gradient(90deg,
          transparent,
          color-mix(in srgb, var(--g-primary) 6%, transparent) 50%,
          transparent);
      }
      .disc-rail__slot:hover::after {
        content: "+ click to add";
        position: absolute;
        right: 14px;
        top: 50%;
        transform: translateY(-50%);
        font-size: 10px;
        font-weight: 700;
        color: var(--g-primary);
        letter-spacing: 0.14em;
        text-transform: uppercase;
        opacity: 0.7;
        text-shadow: 0 0 8px color-mix(in srgb, var(--g-primary) 40%, transparent);
      }
      /* Hour anchor — a faint horizontal rule at every full hour so the eye
         can locate a time at a glance without counting slots. */
      .disc-rail__slot:first-child::before,
      .disc-rail__slot::before {
        content: "";
        position: absolute;
        left: 0; right: 0; top: 0;
        height: 1px;
        background: linear-gradient(90deg,
          color-mix(in srgb, var(--g-primary) 14%, transparent),
          transparent 30%);
        opacity: 0.5;
        pointer-events: none;
      }
      .disc-rail__block {
        position: absolute;
        left: 6px;
        right: 6px;
        border-radius: 10px;
        padding: 8px 10px;
        overflow: hidden;
        cursor: pointer;
        transition:
          transform 0.18s cubic-bezier(0.2, 0.7, 0.2, 1),
          box-shadow 0.18s cubic-bezier(0.2, 0.7, 0.2, 1),
          opacity 0.2s ease;
        backdrop-filter: blur(8px) saturate(140%);
        -webkit-backdrop-filter: blur(8px) saturate(140%);
        box-shadow:
          0 1px 0 var(--glass-hover) inset,
          0 4px 14px color-mix(in srgb, var(--g-bg-deep, #050) 50%, transparent);
        will-change: transform;
      }
      .disc-rail__block:hover {
        transform: translateY(-1px) scale(1.005);
        box-shadow:
          0 1px 0 var(--glass-stroke-strong) inset,
          0 8px 24px color-mix(in srgb, var(--bl-color, var(--g-primary)) 22%, transparent),
          0 0 0 1px color-mix(in srgb, var(--bl-color, var(--g-primary)) 60%, transparent);
        z-index: 4;
      }
      .disc-rail__block--current {
        z-index: 3;
        box-shadow:
          0 0 0 1px var(--bl-color, var(--g-primary)),
          0 0 0 4px color-mix(in srgb, var(--bl-color, var(--g-primary)) 12%, transparent),
          0 0 36px color-mix(in srgb, var(--bl-color, var(--g-primary)) 32%, transparent),
          0 1px 0 var(--glass-stroke-strong) inset;
        animation: discBlockBreathe 3.2s ease-in-out infinite;
      }
      /* Subtle shimmer streak on the active block — sweeps once every 6s so
         it's noticeable but not distracting in a long-running window. */
      .disc-rail__block--current::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(115deg,
          transparent 0%,
          color-mix(in srgb, var(--bl-color, var(--g-primary)) 18%, transparent) 50%,
          transparent 100%);
        background-size: 200% 100%;
        animation: discBlockShimmer 6s ease-in-out infinite;
        pointer-events: none;
        mix-blend-mode: screen;
      }
      @keyframes discBlockBreathe {
        0%, 100% {
          box-shadow:
            0 0 0 1px var(--bl-color, var(--g-primary)),
            0 0 0 4px color-mix(in srgb, var(--bl-color, var(--g-primary)) 12%, transparent),
            0 0 28px color-mix(in srgb, var(--bl-color, var(--g-primary)) 28%, transparent),
            0 1px 0 var(--glass-stroke-strong) inset;
        }
        50% {
          box-shadow:
            0 0 0 1px var(--bl-color, var(--g-primary)),
            0 0 0 5px color-mix(in srgb, var(--bl-color, var(--g-primary)) 18%, transparent),
            0 0 40px color-mix(in srgb, var(--bl-color, var(--g-primary)) 40%, transparent),
            0 1px 0 rgba(255, 255, 255, 0.12) inset;
        }
      }
      @keyframes discBlockShimmer {
        0% { background-position: 200% 50%; opacity: 0; }
        20% { opacity: 1; }
        80% { opacity: 1; }
        100% { background-position: -50% 50%; opacity: 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .disc-rail__block--current { animation: none; }
        .disc-rail__block--current::after { animation: none; opacity: 0; }
      }
      .disc-rail__block-label {
        font-size: 13px;
        font-weight: 600;
        line-height: 1.3;
        letter-spacing: 0.005em;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
      }
      .disc-rail__block-time {
        font-size: 10px;
        opacity: 0.8;
        font-variant-numeric: tabular-nums;
        margin-top: 2px;
        letter-spacing: 0.04em;
      }
      .disc-rail__block-progress {
        position: absolute;
        left: 0; bottom: 0;
        height: 3px;
        background: linear-gradient(90deg,
          var(--bl-color, var(--g-primary)),
          color-mix(in srgb, var(--bl-color, var(--g-primary)) 80%, white));
        box-shadow: 0 0 12px var(--bl-color, var(--g-primary));
        transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1);
        border-radius: 0 2px 2px 0;
      }
      /* Soft fade behind progress fill so the running bar reads as a single
         continuous element rather than a flat rectangle. */
      .disc-rail__block-progress::after {
        content: "";
        position: absolute;
        right: 0; top: 0; bottom: 0;
        width: 18px;
        background: linear-gradient(90deg,
          transparent,
          color-mix(in srgb, var(--bl-color, var(--g-primary)) 60%, transparent));
        filter: blur(4px);
      }
      .disc-rail__log {
        position: absolute;
        right: 10px;
        width: 4px;
        border-radius: 2px;
        background: color-mix(in srgb, var(--g-primary) 50%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 80%, transparent);
        pointer-events: none;
        box-shadow: 0 0 6px color-mix(in srgb, var(--g-primary) 40%, transparent);
      }
      .disc-rail__now {
        position: absolute;
        left: 0; right: 0;
        height: 1px;
        background: linear-gradient(90deg,
          transparent,
          rgba(239, 68, 68, 0.85) 12%,
          rgba(239, 68, 68, 1) 50%,
          rgba(239, 68, 68, 0.85) 88%,
          transparent);
        box-shadow: 0 0 12px rgba(239, 68, 68, 0.7);
        z-index: 6;
        pointer-events: none;
      }
      .disc-rail__now::before {
        content: "";
        position: absolute;
        left: -4px; top: -4px;
        width: 9px; height: 9px;
        border-radius: 50%;
        background: #ef4444;
        box-shadow:
          0 0 0 2px color-mix(in srgb, var(--disc-surface-strong) 80%, transparent),
          0 0 14px rgba(239, 68, 68, 0.9);
        animation: discNowPulse 1.6s ease-in-out infinite;
      }
      @keyframes discNowPulse {
        0%, 100% { transform: scale(1); box-shadow: 0 0 0 2px color-mix(in srgb, var(--disc-surface-strong) 80%, transparent), 0 0 12px rgba(239, 68, 68, 0.7); }
        50% { transform: scale(1.2); box-shadow: 0 0 0 2px color-mix(in srgb, var(--disc-surface-strong) 80%, transparent), 0 0 22px rgba(239, 68, 68, 1); }
      }
      .disc-rail__now::after {
        content: attr(data-time);
        position: absolute;
        right: 8px; top: -10px;
        font-size: 9px;
        font-weight: 800;
        font-variant-numeric: tabular-nums;
        color: #fff5f5;
        background: linear-gradient(135deg, #ef4444, #b91c1c);
        padding: 2px 7px;
        border-radius: 4px;
        letter-spacing: 0.08em;
        box-shadow: 0 4px 10px rgba(239, 68, 68, 0.4);
      }
      @media (prefers-reduced-motion: reduce) {
        .disc-rail__now::before { animation: none; }
      }

      /* ── PROBE ── */
      .disc-probe__suggest {
        display: flex; flex-wrap: wrap; gap: 6px;
        margin-top: 10px;
      }
      .disc-probe__chip {
        padding: 5px 10px;
        font-size: 11px;
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 99px;
        color: var(--g-primary);
        cursor: pointer;
        transition: all 0.12s;
      }
      .disc-probe__chip:hover {
        background: color-mix(in srgb, var(--g-primary) 15%, transparent);
        color: var(--g-primary);
      }
      .disc-probe__active {
        margin-top: 12px;
        padding: 10px 12px;
        border-radius: 8px;
        background: rgba(16, 185, 129, 0.08);
        border: 1px solid rgba(16, 185, 129, 0.25);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        font-size: 12px;
      }
      .disc-probe__active-label { color: #10B981; font-weight: 600; }

      /* ── BLOCK CARDS ── */
      .disc-block-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 16px;
      }
      .disc-block-card {
        position: relative;
        padding: 18px 20px;
        background:
          linear-gradient(180deg, color-mix(in srgb, var(--card-color, var(--g-primary)) 5%, transparent) 0%, transparent 60%),
          var(--disc-surface);
        border: 1px solid color-mix(in srgb, var(--card-color, var(--g-primary)) 18%, transparent);
        border-radius: 14px;
        backdrop-filter: blur(14px) saturate(140%);
        -webkit-backdrop-filter: blur(14px) saturate(140%);
        box-shadow:
          0 1px 0 var(--glass-hover) inset,
          0 6px 22px color-mix(in srgb, var(--g-bg-deep, #050) 50%, transparent);
        transition:
          transform 0.2s cubic-bezier(0.2, 0.7, 0.2, 1),
          border-color 0.2s ease,
          box-shadow 0.2s ease;
        overflow: hidden;
      }
      /* Color rail along the left edge — replaces the old border-left so the
         card retains its rounded corners on the rail side. */
      .disc-block-card::before {
        content: "";
        position: absolute;
        left: 0; top: 12px; bottom: 12px;
        width: 3px;
        border-radius: 0 3px 3px 0;
        background: linear-gradient(180deg,
          var(--card-color, var(--g-primary)),
          color-mix(in srgb, var(--card-color, var(--g-primary)) 50%, transparent));
        box-shadow: 0 0 12px color-mix(in srgb, var(--card-color, var(--g-primary)) 40%, transparent);
      }
      /* Soft glow stripe across the top — visible on hover only. */
      .disc-block-card::after {
        content: "";
        position: absolute;
        left: 0; right: 0; top: 0;
        height: 1px;
        background: linear-gradient(90deg,
          transparent,
          color-mix(in srgb, var(--card-color, var(--g-primary)) 60%, transparent) 50%,
          transparent);
        opacity: 0;
        transition: opacity 0.25s ease;
      }
      .disc-block-card:hover {
        transform: translateY(-3px);
        border-color: color-mix(in srgb, var(--card-color, var(--g-primary)) 45%, transparent);
        box-shadow:
          0 1px 0 var(--glass-stroke-strong) inset,
          0 14px 36px color-mix(in srgb, var(--g-bg-deep, #050) 60%, transparent),
          0 0 24px color-mix(in srgb, var(--card-color, var(--g-primary)) 16%, transparent);
      }
      .disc-block-card:hover::after { opacity: 1; }
      .disc-block-card--disabled {
        opacity: 0.45;
        filter: saturate(0.6);
      }
      .disc-block-card--disabled::before { opacity: 0.5; }
      .disc-block-card__badge {
        position: absolute; top: 12px; right: 14px;
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0.18em;
        padding: 3px 8px;
        border-radius: 99px;
        background: linear-gradient(135deg, rgba(239, 68, 68, 0.25), rgba(239, 68, 68, 0.1));
        color: #ff8a8a;
        border: 1px solid rgba(239, 68, 68, 0.4);
        box-shadow: 0 0 12px rgba(239, 68, 68, 0.2);
      }
      /* Auto-log event count badge (⚡ N) */
      .disc-autolog-badge {
        color: var(--g-primary, #7fff7f);
        font-size: 11px;
        opacity: 0.75;
      }
      /* Auto-log event timeline strip */
      .disc-autolog-strip {
        display: flex;
        align-items: center;
        gap: 3px;
        margin-top: 4px;
        height: 8px;
      }
      .disc-autolog-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--g-primary, #7fff7f);
        opacity: 0.55;
        flex-shrink: 0;
        cursor: default;
      }
      .disc-autolog-dot:hover { opacity: 1; }

      .disc-block-card__label {
        font-size: 16px;
        font-weight: 700;
        color: var(--card-color, var(--g-primary));
        margin: 0 0 6px;
        letter-spacing: -0.005em;
        line-height: 1.25;
        text-shadow: 0 0 12px color-mix(in srgb, var(--card-color, var(--g-primary)) 18%, transparent);
      }
      .disc-block-card__meta {
        font-size: 11px;
        color: var(--disc-fg-faint);
        font-variant-numeric: tabular-nums;
        letter-spacing: 0.04em;
        margin-bottom: 10px;
        display: flex;
        flex-wrap: wrap;
        gap: 4px 10px;
        align-items: center;
      }
      .disc-block-card__meta-dot {
        color: var(--disc-fg-mute);
      }
      .disc-block-card__intent {
        font-size: 12px;
        color: var(--disc-fg-dim);
        font-style: italic;
        line-height: 1.5;
        margin: 0 0 12px;
        padding: 8px 10px 8px 12px;
        border-left: 2px solid color-mix(in srgb, var(--card-color, var(--g-primary)) 30%, transparent);
        background: color-mix(in srgb, var(--card-color, var(--g-primary)) 4%, transparent);
        border-radius: 0 6px 6px 0;
      }
      .disc-block-card__intent::before {
        content: "“";
        opacity: 0.4;
        margin-right: 2px;
        font-size: 14px;
        color: var(--card-color, var(--g-primary));
      }
      .disc-insight {
        margin: 8px 0 10px;
        padding: 7px 10px 8px 11px;
        border-left: 2px solid var(--disc-fg-dim);
        background: color-mix(in srgb, var(--g-bg, #0a0a0e) 35%, transparent);
        border-radius: 0 6px 6px 0;
      }
      .disc-insight__elapsed {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.02em;
        color: #10B981;
        margin-bottom: 3px;
        font-variant-numeric: tabular-nums;
      }
      .disc-insight__headline {
        font-size: 12px;
        font-weight: 600;
        line-height: 1.4;
        margin-bottom: 6px;
      }
      .disc-insight__row {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
        align-items: center;
      }
      .disc-insight__chip {
        font-size: 10px;
        font-weight: 700;
        padding: 2px 8px;
        border-radius: 10px;
        border: 1px solid currentColor;
        background: color-mix(in srgb, currentColor 10%, transparent);
        cursor: default;
        white-space: nowrap;
      }
      .disc-insight__ref {
        font-size: 10px;
        padding: 2px 7px;
        border-radius: 10px;
        color: var(--disc-fg-faint);
        background: color-mix(in srgb, var(--g-fg-faint, #6a5f3a) 12%, transparent);
        white-space: nowrap;
      }
      .disc-block-card__actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: 14px;
        padding-top: 12px;
        border-top: 1px dashed color-mix(in srgb, var(--g-primary) 10%, transparent);
      }

      /* ── CATEGORY CHIPS ── */
      .disc-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .disc-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        font-size: 11px;
        font-weight: 600;
        background: var(--disc-surface-soft);
        border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-radius: 99px;
        color: var(--disc-fg-faint);
        cursor: pointer;
        transition: all 0.15s;
      }
      .disc-chip:hover { color: var(--disc-fg); border-color: color-mix(in srgb, var(--g-primary) 40%, transparent); }
      .disc-chip--active {
        background: color-mix(in srgb, var(--chip-color, var(--g-primary)) 18%, transparent);
        color: var(--chip-color, var(--g-primary));
        border-color: var(--chip-color, var(--g-primary));
      }
      .disc-chip__dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: var(--chip-color, var(--g-primary));
        box-shadow: 0 0 6px color-mix(in srgb, var(--chip-color, var(--g-primary)) 60%, transparent);
      }

      /* ── DAY TOGGLES ── */
      .disc-days {
        display: flex;
        gap: 4px;
      }
      .disc-day {
        flex: 1;
        padding: 8px 0;
        text-align: center;
        font-size: 11px;
        font-weight: 600;
        background: var(--disc-surface-soft);
        border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-radius: 8px;
        color: var(--disc-fg-mute);
        cursor: pointer;
        transition: all 0.15s;
      }
      .disc-day:hover { color: var(--g-primary); border-color: color-mix(in srgb, var(--g-primary) 35%, transparent); }
      .disc-day--active {
        background: linear-gradient(135deg, var(--g-primary), var(--g-primary));
        color: #0a0700;
        border-color: var(--g-primary);
        box-shadow: 0 2px 10px color-mix(in srgb, var(--g-primary) 25%, transparent);
      }

      /* ── DURATION PILLS ── */
      .disc-duration-row {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .disc-duration {
        padding: 5px 12px;
        font-size: 11px;
        font-weight: 600;
        background: color-mix(in srgb, var(--g-primary) 6%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-radius: 6px;
        color: var(--disc-fg-faint);
        cursor: pointer;
        transition: all 0.12s;
      }
      .disc-duration:hover { color: var(--g-primary); border-color: color-mix(in srgb, var(--g-primary) 40%, transparent); }

      /* ── EMPTY STATE ── */
      .disc-empty {
        padding: 40px 28px;
        background:
          radial-gradient(ellipse 60% 80% at 50% 0%, color-mix(in srgb, var(--g-primary) 8%, transparent), transparent 70%),
          linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 2%, transparent), transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 14px;
        text-align: center;
      }
      .disc-empty__title {
        font-size: 22px;
        font-weight: 700;
        color: var(--g-primary);
        margin: 0 0 8px;
      }
      .disc-empty__sub {
        font-size: 14px;
        color: var(--disc-fg-faint);
        max-width: 520px;
        margin: 0 auto 28px;
      }
      .disc-presets {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 12px;
        max-width: 960px;
        margin: 0 auto;
      }
      .disc-preset {
        padding: 18px 20px;
        background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 5%, transparent), color-mix(in srgb, var(--g-primary) 1%, transparent));
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 12px;
        cursor: pointer;
        text-align: left;
        transition: all 0.18s ease;
      }
      .disc-preset:hover {
        transform: translateY(-3px);
        border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4), 0 0 0 1px color-mix(in srgb, var(--g-primary) 15%, transparent) inset;
      }
      .disc-preset__name {
        font-size: 15px;
        font-weight: 700;
        color: var(--g-primary);
        margin: 0 0 4px;
      }
      .disc-preset__tag {
        font-size: 11px;
        color: var(--disc-fg-faint);
        letter-spacing: 0.02em;
      }
      .disc-preset__count {
        margin-top: 10px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--g-primary);
      }

      /* ── SCORE ── */
      .disc-score-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 14px;
        margin-bottom: 20px;
      }
      .disc-score-card {
        padding: 18px 20px;
        background: linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 4%, transparent), var(--disc-surface-soft));
        border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-radius: 12px;
      }
      .disc-score-card__val {
        font-size: 34px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--val-color, var(--g-primary));
        line-height: 1;
        letter-spacing: -0.02em;
      }
      .disc-score-card__lbl {
        margin-top: 8px;
        font-size: 10px;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--disc-fg-faint);
        font-weight: 600;
      }

      .disc-heat {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 6px;
      }
      .disc-heat__cell {
        height: 52px;
        border-radius: 8px;
        border: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        transition: transform 0.12s;
      }
      .disc-heat__cell:hover { transform: scale(1.04); }

      .disc-cat-bar {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .disc-cat-row {
        display: grid;
        grid-template-columns: 110px 1fr 70px;
        align-items: center;
        gap: 12px;
      }
      .disc-cat-row__label {
        font-size: 12px;
        font-weight: 600;
        color: var(--disc-fg-dim);
      }
      .disc-cat-row__bar {
        height: 10px;
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        border-radius: 99px;
        overflow: hidden;
      }
      .disc-cat-row__fill {
        height: 100%;
        border-radius: 99px;
        transition: width 0.6s ease;
        box-shadow: 0 0 10px color-mix(in srgb, var(--fill-color, var(--g-primary)) 50%, transparent);
      }
      .disc-cat-row__val {
        font-size: 12px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        color: var(--disc-fg-faint);
        text-align: right;
      }

      /* ── QUICK LOG BAR ── */
      .disc-quick-log {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        margin: 12px 0 16px;
        background: var(--disc-surface);
        border: 1px solid var(--disc-border-soft);
        border-radius: 12px;
        backdrop-filter: blur(14px) saturate(140%);
        transition: border-color 0.2s ease, box-shadow 0.2s ease;
      }
      .disc-quick-log:focus-within {
        border-color: var(--disc-border);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--g-primary) 16%, transparent);
      }
      .disc-quick-log--saved {
        border-color: color-mix(in srgb, #10B981 50%, transparent);
        box-shadow: 0 0 0 3px color-mix(in srgb, #10B981 18%, transparent);
      }
      .disc-quick-log__icon {
        flex: none;
        width: 10px; height: 10px;
        border-radius: 50%;
        box-shadow: 0 0 10px currentColor;
      }
      .disc-quick-log__input {
        flex: 1;
        min-width: 0;
        background: transparent;
        border: none;
        outline: none;
        color: var(--disc-fg);
        font-size: 14px;
        font-family: inherit;
        padding: 4px 0;
      }
      .disc-quick-log__input::placeholder {
        color: var(--disc-fg-faint);
      }
      .disc-quick-log__cat {
        flex: none;
        background: var(--disc-surface-soft);
        border: 1px solid var(--disc-border-soft);
        color: var(--disc-fg-dim);
        border-radius: 8px;
        padding: 6px 8px;
        font-size: 11px;
        font-family: inherit;
        cursor: pointer;
      }
      .disc-quick-log__btn {
        flex: none;
      }

      /* ── ERROR + MODAL ── */
      .disc-error {
        padding: 12px 16px;
        background: rgba(239, 68, 68, 0.08);
        border: 1px solid rgba(239, 68, 68, 0.3);
        color: #ff8a8a;
        border-radius: 10px;
        margin-bottom: 16px;
        font-size: 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .disc-modal__backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(6px);
        z-index: 1000;
        display: grid;
        place-items: center;
        animation: discFade 0.2s ease;
      }
      @keyframes discFade {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      .disc-modal {
        width: min(480px, 92vw);
        padding: 24px 26px;
        background: var(--disc-surface-strong);
        border: 1px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
        border-radius: 14px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.7);
      }
      .disc-modal__title {
        font-size: 17px;
        font-weight: 700;
        color: var(--g-primary);
        margin: 0 0 8px;
      }
      .disc-modal__body {
        font-size: 13px;
        color: var(--disc-fg-dim);
        margin: 0 0 20px;
        line-height: 1.5;
      }
      .disc-modal__actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }

      /* ── ROUTINE + NN + LINKS ── */
      .disc-nn-badge {
        display: inline-flex; align-items: center; gap: 4px;
        padding: 2px 8px;
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0.18em;
        border-radius: 99px;
        background: linear-gradient(135deg, rgba(239, 68, 68, 0.32), rgba(239, 68, 68, 0.08));
        color: #ffd0d0;
        border: 1px solid rgba(239, 68, 68, 0.5);
        text-transform: uppercase;
        box-shadow: 0 0 10px rgba(239, 68, 68, 0.18);
      }
      .disc-nn-badge::before {
        content: "◆";
        font-size: 9px;
        color: #ff5050;
        text-shadow: 0 0 6px rgba(239, 68, 68, 0.7);
      }
      .disc-link-pill {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 4px 10px;
        font-size: 10px;
        font-weight: 600;
        border-radius: 99px;
        background: color-mix(in srgb, var(--link-color, var(--g-primary)) 8%, transparent);
        border: 1px solid color-mix(in srgb, var(--link-color, var(--g-primary)) 25%, transparent);
        color: var(--disc-fg-dim);
        transition: background 0.18s ease, border-color 0.18s ease, transform 0.16s ease;
      }
      .disc-link-pill:hover {
        background: color-mix(in srgb, var(--link-color, var(--g-primary)) 16%, transparent);
        border-color: color-mix(in srgb, var(--link-color, var(--g-primary)) 50%, transparent);
        transform: translateY(-1px);
      }
      .disc-link-pill__dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: var(--link-color, var(--g-primary));
        box-shadow: 0 0 6px var(--link-color, var(--g-primary));
        flex-shrink: 0;
      }
      .disc-routine {
        display: flex; flex-direction: column; gap: 4px;
        margin-top: 6px;
      }
      .disc-routine__item {
        display: flex; align-items: center; gap: 8px;
        padding: 4px 8px;
        font-size: 11px;
        border-radius: 6px;
        cursor: pointer;
        color: var(--disc-fg-dim);
        transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
      }
      .disc-routine__item:hover {
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        color: var(--disc-fg);
      }
      .disc-routine__item:active { transform: scale(0.98); }
      .disc-routine__check {
        width: 14px; height: 14px;
        border: 1.5px solid currentColor;
        border-radius: 4px;
        flex-shrink: 0;
        position: relative;
        transition: background 0.18s ease, transform 0.16s cubic-bezier(0.2, 0.7, 0.2, 1.6);
      }
      .disc-routine__item--done .disc-routine__check {
        background: currentColor;
        transform: scale(1.05);
      }
      .disc-routine__item--done .disc-routine__check::after {
        content: "";
        position: absolute;
        left: 3px; top: 0;
        width: 4px; height: 8px;
        border-right: 2px solid color-mix(in srgb, var(--g-bg-deep, #050) 90%, transparent);
        border-bottom: 2px solid color-mix(in srgb, var(--g-bg-deep, #050) 90%, transparent);
        transform: rotate(45deg);
        animation: discRoutineCheck 0.32s cubic-bezier(0.2, 0.7, 0.2, 1.6);
      }
      @keyframes discRoutineCheck {
        from { opacity: 0; transform: rotate(45deg) scale(0); }
        to { opacity: 1; transform: rotate(45deg) scale(1); }
      }
      .disc-routine__item--done .disc-routine__label {
        text-decoration: line-through;
        text-decoration-color: color-mix(in srgb, currentColor 50%, transparent);
        opacity: 0.5;
      }
      .disc-routine__label { flex: 1; min-width: 0; }
      .disc-routine__progress {
        font-size: 10px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        margin-left: 6px;
        opacity: 0.85;
        padding: 1px 6px;
        border-radius: 99px;
        background: color-mix(in srgb, currentColor 10%, transparent);
      }

      /* Routine editor rows */
      .disc-routine-edit {
        display: flex; align-items: center; gap: 6px;
        margin-bottom: 6px;
      }
      .disc-routine-edit__handle {
        cursor: grab;
        color: var(--disc-fg-mute);
        font-weight: 700;
        font-size: 14px;
        padding: 0 4px;
      }
      .disc-routine-edit__input {
        flex: 1;
      }
      .disc-routine-edit__remove {
        padding: 6px 9px;
        font-size: 14px;
        line-height: 1;
        background: transparent;
        border: 1px solid rgba(239, 68, 68, 0.25);
        color: #ff8a8a;
        border-radius: 6px;
        cursor: pointer;
      }
      .disc-routine-edit__remove:hover {
        background: rgba(239, 68, 68, 0.1);
      }

      /* Active routine panel (timeline side) */
      .disc-active-routine {
        margin-top: 18px;
      }
      .disc-active-routine h3 { margin-bottom: 8px; }
      .disc-active-routine__block {
        padding: 10px 12px;
        border-radius: 10px;
        background: var(--disc-surface-soft);
        border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-left: 3px solid var(--ar-color, var(--g-primary));
        margin-bottom: 8px;
      }
      .disc-active-routine__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
      }
      .disc-active-routine__name {
        font-size: 12px;
        font-weight: 600;
        color: var(--g-primary);
      }

      /* ── DRAG + COMPLETE ── */
      .disc-rail__block {
        user-select: none;
        touch-action: none;
      }
      .disc-rail__block.is-dragging {
        opacity: 0.92;
        z-index: 10;
        transform: scale(1.025) rotate(0.3deg);
        box-shadow:
          0 0 0 1px var(--bl-color, var(--g-primary)),
          0 16px 40px rgba(0, 0, 0, 0.55),
          0 0 28px color-mix(in srgb, var(--bl-color, var(--g-primary)) 35%, transparent);
        animation: none;
      }
      .disc-rail__block.is-drop-target {
        outline: none;
        box-shadow:
          0 0 0 2px var(--g-primary),
          0 0 0 6px color-mix(in srgb, var(--g-primary) 22%, transparent),
          0 0 30px color-mix(in srgb, var(--g-primary) 50%, transparent);
        animation: discDropPulse 0.7s ease-in-out infinite alternate;
      }
      @keyframes discDropPulse {
        from { box-shadow: 0 0 0 2px var(--g-primary), 0 0 0 6px color-mix(in srgb, var(--g-primary) 22%, transparent), 0 0 24px color-mix(in srgb, var(--g-primary) 40%, transparent); }
        to { box-shadow: 0 0 0 2px var(--g-primary), 0 0 0 8px color-mix(in srgb, var(--g-primary) 30%, transparent), 0 0 36px color-mix(in srgb, var(--g-primary) 60%, transparent); }
      }
      .disc-rail__block--done {
        opacity: 0.5;
        filter: grayscale(0.35) saturate(0.7);
      }
      .disc-rail__block--done .disc-rail__block-label {
        text-decoration: line-through;
        text-decoration-color: color-mix(in srgb, currentColor 60%, transparent);
        text-decoration-thickness: 1.5px;
      }
      .disc-rail__block--done::before {
        content: "✓";
        position: absolute;
        right: 8px; bottom: 4px;
        font-size: 14px;
        font-weight: 800;
        color: #10B981;
        text-shadow: 0 0 8px rgba(16, 185, 129, 0.5);
        opacity: 0.85;
        pointer-events: none;
      }
      .disc-block-actions {
        position: absolute;
        top: 4px;
        right: 4px;
        display: flex;
        gap: 3px;
        z-index: 2;
      }
      .disc-icon-btn {
        width: 22px;
        height: 22px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 12px;
        font-weight: 700;
        line-height: 1;
        border-radius: 6px;
        border: 1px solid currentColor;
        background: color-mix(in srgb, var(--g-bg-deep, #050) 60%, transparent);
        backdrop-filter: blur(6px);
        color: inherit;
        cursor: pointer;
        transition:
          background 0.16s ease,
          transform 0.14s cubic-bezier(0.2, 0.7, 0.2, 1.6),
          box-shadow 0.16s ease;
      }
      .disc-icon-btn:hover {
        background: color-mix(in srgb, var(--g-primary) 22%, transparent);
        transform: scale(1.12);
        box-shadow: 0 0 12px color-mix(in srgb, currentColor 40%, transparent);
      }
      .disc-icon-btn:active { transform: scale(0.95); }
      .disc-icon-btn--done {
        background: linear-gradient(135deg, #10B981, #059669);
        border-color: #10B981;
        color: #0a0700;
        box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.25), 0 0 14px rgba(16, 185, 129, 0.4);
      }
      .disc-drag-handle {
        cursor: grab;
      }
      .disc-drag-handle:active {
        cursor: grabbing;
      }

      /* ── SAVED TIME STAT ── */
      .disc-saved-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 9px;
        margin-left: 8px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        border-radius: 99px;
        background: rgba(16, 185, 129, 0.15);
        color: #10B981;
        border: 1px solid rgba(16, 185, 129, 0.4);
      }
      .disc-saved-pill::before {
        content: "⚡";
        font-size: 11px;
      }

      /* ── KANBAN DRAG CHIPS ── */
      .disc-kanban-panel {
        margin-top: 18px;
      }
      .disc-kanban-panel h3 {
        margin-bottom: 8px;
      }
      .disc-kanban-list {
        display: flex;
        flex-direction: column;
        gap: 5px;
        max-height: 240px;
        overflow-y: auto;
        padding-right: 4px;
      }
      .disc-kanban-list::-webkit-scrollbar { width: 6px; }
      .disc-kanban-list::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 3px;
      }
      .disc-focus-projects {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        padding: 10px 14px;
        margin: 4px 0 2px;
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-radius: 10px;
      }
      .disc-focus-projects__label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        font-weight: 600;
        color: var(--disc-fg-dim);
        white-space: nowrap;
      }
      .disc-focus-projects__count {
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        border-radius: 9px;
        background: var(--g-primary);
        color: #0b0b0b;
        font-size: 11px;
        font-weight: 700;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .disc-focus-projects__chips {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .disc-focus-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        font-size: 11px;
        background: transparent;
        border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
        border-radius: 999px;
        color: var(--disc-fg-dim);
        cursor: pointer;
        transition: background 0.12s, border-color 0.12s, color 0.12s;
      }
      .disc-focus-chip:hover {
        border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
        color: var(--disc-fg);
      }
      .disc-focus-chip--active {
        background: color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-color: var(--g-primary);
        color: var(--disc-fg);
      }
      .disc-focus-chip__dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: var(--g-primary);
        flex-shrink: 0;
      }
      .disc-focus-chip__mark { font-weight: 700; opacity: 0.8; }
      .disc-kanban-chip {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 9px;
        font-size: 11px;
        background: color-mix(in srgb, var(--g-primary) 6%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 6px;
        color: var(--disc-fg-dim);
        cursor: grab;
        transition: background 0.12s, border-color 0.12s;
      }
      .disc-kanban-chip:hover {
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 50%, transparent);
      }
      .disc-kanban-chip:active { cursor: grabbing; }
      .disc-kanban-chip__project {
        width: 6px; height: 6px; border-radius: 50%;
        background: var(--kb-color, var(--g-primary));
        flex-shrink: 0;
      }
      .disc-kanban-chip__title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .disc-kanban-chip__meta {
        font-size: 9px;
        color: var(--disc-fg-mute);
        letter-spacing: 0.05em;
      }
      .disc-kanban-empty {
        font-size: 11px;
        color: var(--disc-fg-mute);
        font-style: italic;
        padding: 8px 4px;
      }

      @media (max-width: 1080px) {
        .disc-timeline { grid-template-columns: 60px 1fr; }
        .disc-timeline > .disc-panel { grid-column: 1 / -1; }
      }

      /* ── PRIORITY BADGES + LINK ENHANCEMENTS ── */
      .disc-pri-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 7px;
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        border-radius: 99px;
        line-height: 1.4;
        white-space: nowrap;
      }
      .disc-pri-badge--critical {
        color: #fff5f5;
        background: linear-gradient(135deg, #ff4d4d, #b91c1c);
        box-shadow: 0 0 14px rgba(239, 68, 68, 0.45), inset 0 1px 0 rgba(255,255,255,0.18);
        animation: discPriPulse 2.4s ease-in-out infinite;
      }
      .disc-pri-badge--high {
        color: #1a1100;
        background: linear-gradient(135deg, #fb923c, #ea580c);
        box-shadow: 0 0 10px rgba(234, 88, 12, 0.35);
      }
      .disc-pri-badge--normal {
        color: var(--disc-fg-dim);
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 22%, transparent);
      }
      .disc-pri-badge--low {
        color: var(--disc-fg-faint);
        background: var(--glass-hover);
        border: 1px solid var(--glass-stroke-strong);
      }
      @keyframes discPriPulse {
        0%, 100% { box-shadow: 0 0 14px rgba(239, 68, 68, 0.45), inset 0 1px 0 rgba(255,255,255,0.18); }
        50% { box-shadow: 0 0 22px rgba(239, 68, 68, 0.7), inset 0 1px 0 rgba(255,255,255,0.18); }
      }
      .disc-rail__block.has-pri-critical {
        box-shadow:
          0 0 0 1px rgba(239, 68, 68, 0.55),
          0 0 22px rgba(239, 68, 68, 0.35),
          inset 0 1px 0 rgba(255, 255, 255, 0.05);
      }
      .disc-rail__block.has-pri-high {
        box-shadow:
          0 0 0 1px rgba(234, 88, 12, 0.45),
          0 0 16px rgba(234, 88, 12, 0.25),
          inset 0 1px 0 rgba(255, 255, 255, 0.05);
      }

      /* ── SETTINGS SUBVIEW ── */
      .disc-settings-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
        gap: 16px;
        margin-top: 4px;
      }
      .disc-settings-card {
        position: relative;
        padding: 18px 20px 20px;
        background:
          linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 4%, transparent), transparent),
          var(--disc-surface-strong);
        border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-radius: 14px;
        backdrop-filter: blur(8px);
      }
      .disc-settings-card__title {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.04em;
        color: var(--g-primary);
        margin-bottom: 4px;
      }
      .disc-settings-card__title-icon {
        font-size: 16px;
        line-height: 1;
        filter: drop-shadow(0 0 6px color-mix(in srgb, var(--g-primary) 50%, transparent));
      }
      .disc-settings-card__hint {
        margin: 0 0 14px;
        font-size: 11px;
        color: var(--disc-fg-mute);
        line-height: 1.45;
      }
      .disc-settings-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 0;
        border-top: 1px dashed color-mix(in srgb, var(--g-primary) 8%, transparent);
      }
      .disc-settings-row:first-of-type { border-top: none; padding-top: 0; }
      .disc-settings-row__label {
        font-size: 12px;
        color: var(--disc-fg-dim);
        flex: 1;
        min-width: 0;
      }
      .disc-settings-row__hint {
        display: block;
        margin-top: 2px;
        font-size: 10px;
        color: var(--disc-fg-mute);
        font-weight: 400;
      }
      .disc-settings-row__field {
        flex-shrink: 0;
      }
      .disc-toggle {
        position: relative;
        width: 36px;
        height: 20px;
        border-radius: 99px;
        background: var(--glass-stroke-strong);
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        cursor: pointer;
        flex-shrink: 0;
        transition: background 0.18s, border-color 0.18s;
      }
      .disc-toggle::after {
        content: "";
        position: absolute;
        top: 2px;
        left: 2px;
        width: 14px; height: 14px;
        border-radius: 50%;
        background: var(--disc-fg-mute);
        transition: left 0.2s ease, background 0.2s ease;
      }
      .disc-toggle.is-on {
        background: color-mix(in srgb, var(--g-primary) 30%, transparent);
        border-color: var(--g-primary);
      }
      .disc-toggle.is-on::after {
        left: 18px;
        background: var(--g-primary);
        box-shadow: 0 0 10px color-mix(in srgb, var(--g-primary) 60%, transparent);
      }
      .disc-spin {
        width: 64px;
        padding: 6px 8px;
        background: var(--disc-surface);
        color: var(--g-primary);
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 6px;
        font-family: inherit;
        font-size: 12px;
        font-variant-numeric: tabular-nums;
        text-align: center;
      }
      .disc-status-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        border-radius: 99px;
        margin-left: 8px;
      }
      .disc-status-pill--ok {
        color: #34d399;
        background: rgba(16, 185, 129, 0.12);
        border: 1px solid rgba(16, 185, 129, 0.4);
      }
      .disc-status-pill--err {
        color: #ff8a8a;
        background: rgba(239, 68, 68, 0.12);
        border: 1px solid rgba(239, 68, 68, 0.4);
      }
      .disc-status-pill--idle {
        color: var(--disc-fg-mute);
        background: var(--glass-hover);
        border: 1px solid var(--glass-stroke-strong);
      }
      .disc-events-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px 12px;
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px dashed color-mix(in srgb, var(--g-primary) 8%, transparent);
      }
      .disc-event-row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 11px;
        color: var(--disc-fg-dim);
        padding: 4px 0;
      }
      .disc-quiet-range {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .disc-quiet-range input[type="time"] {
        background: var(--disc-surface);
        color: var(--g-primary);
        border: 1px solid color-mix(in srgb, var(--g-primary) 20%, transparent);
        padding: 6px 8px;
        font-family: inherit;
        font-size: 12px;
        border-radius: 6px;
      }
      /* ── AI PANEL ── */
      .disc-ai-panel {
        background:
          radial-gradient(120% 120% at 0% 0%, color-mix(in srgb, var(--g-primary) 8%, transparent), transparent 60%),
          var(--disc-surface);
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        border-radius: 14px;
        padding: 16px 18px;
        margin-top: 16px;
      }
      .disc-ai-panel__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      .disc-ai-panel__title {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--g-primary);
        font-weight: 700;
      }
      .disc-ai-panel__title::before {
        content: "✦";
        font-size: 14px;
        color: var(--g-primary);
        filter: drop-shadow(0 0 8px color-mix(in srgb, var(--g-primary) 60%, transparent));
      }
      .disc-ai-panel__actions { display: flex; gap: 6px; flex-wrap: wrap; }
      .disc-ai-panel__body {
        font-size: 13px;
        line-height: 1.6;
        color: #e8d8a4;
        white-space: pre-wrap;
        background: rgba(0,0,0,0.25);
        border-radius: 8px;
        padding: 12px 14px;
        max-height: 320px;
        overflow-y: auto;
        border: 1px solid rgba(255,255,255,0.05);
      }
      .disc-ai-panel__empty {
        font-size: 12px;
        color: var(--disc-fg-mute);
        font-style: italic;
      }
      .disc-ai-panel__busy {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--g-primary);
        font-size: 11px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }
      .disc-ai-panel__busy::before {
        content: "";
        width: 10px; height: 10px;
        border-radius: 50%;
        border: 2px solid color-mix(in srgb, var(--g-primary) 30%, transparent);
        border-top-color: var(--g-primary);
        animation: discAiSpin 0.8s linear infinite;
      }
      @keyframes discAiSpin { to { transform: rotate(360deg); } }

      /* ── TEMPLATE STRIP ── */
      .disc-tpl-strip {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        margin-bottom: 14px;
        border-radius: 12px;
        background:
          linear-gradient(135deg,
            color-mix(in srgb, var(--g-primary) 6%, transparent) 0%,
            transparent 60%),
          var(--disc-surface-soft);
        border: 1px solid var(--disc-border-soft);
        backdrop-filter: blur(12px) saturate(140%);
        -webkit-backdrop-filter: blur(12px) saturate(140%);
        flex-wrap: wrap;
      }
      .disc-tpl-strip__icon {
        width: 30px; height: 30px;
        flex-shrink: 0;
        display: inline-flex; align-items: center; justify-content: center;
        border-radius: 8px;
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        color: var(--g-primary);
        font-size: 15px;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--g-primary) 22%, transparent);
      }
      .disc-tpl-strip__name-row {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
        flex: 1;
      }
      .disc-tpl-strip__kicker {
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.18em;
        text-transform: uppercase;
        color: var(--disc-fg-faint);
      }
      .disc-tpl-strip__name {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 15px;
        font-weight: 700;
        color: var(--g-primary);
        letter-spacing: -0.005em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      }
      .disc-tpl-strip__name--custom {
        color: var(--disc-fg-dim);
        font-style: italic;
        font-weight: 600;
      }
      .disc-tpl-strip__dirty {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        border-radius: 99px;
        background: rgba(245, 158, 11, 0.15);
        color: #fbbf24;
        border: 1px solid rgba(245, 158, 11, 0.4);
        white-space: nowrap;
      }
      .disc-tpl-strip__dirty::before {
        content: "";
        width: 6px; height: 6px;
        border-radius: 50%;
        background: #fbbf24;
        box-shadow: 0 0 6px rgba(245, 158, 11, 0.7);
        animation: discPulse 1.6s ease-in-out infinite;
      }
      .disc-tpl-strip__actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }

      /* ── TEMPLATE MODAL ── */
      .disc-tpl-modal {
        max-width: 600px;
        width: 90vw;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
      }
      .disc-tpl-list {
        flex: 1;
        overflow-y: auto;
        margin: 12px 0;
        padding-right: 4px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .disc-tpl-list::-webkit-scrollbar { width: 6px; }
      .disc-tpl-list::-webkit-scrollbar-thumb {
        background: color-mix(in srgb, var(--g-primary) 20%, transparent);
        border-radius: 3px;
      }
      .disc-tpl-card {
        position: relative;
        padding: 12px 14px;
        border-radius: 10px;
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        border: 1px solid var(--disc-border-soft);
        cursor: pointer;
        transition: background 0.15s ease, border-color 0.15s ease, transform 0.12s ease;
      }
      .disc-tpl-card:hover {
        background: color-mix(in srgb, var(--g-primary) 9%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 35%, transparent);
        transform: translateY(-1px);
      }
      .disc-tpl-card--active {
        border-color: var(--g-primary);
        box-shadow: 0 0 0 1px var(--g-primary), 0 0 18px color-mix(in srgb, var(--g-primary) 22%, transparent);
      }
      .disc-tpl-card__head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 8px;
        margin-bottom: 4px;
      }
      .disc-tpl-card__name {
        font-size: 14px;
        font-weight: 700;
        color: var(--g-primary);
      }
      .disc-tpl-card__source {
        font-size: 9px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        padding: 2px 8px;
        border-radius: 99px;
        flex-shrink: 0;
      }
      .disc-tpl-card__source--user {
        background: color-mix(in srgb, var(--g-primary) 14%, transparent);
        color: var(--g-primary);
      }
      .disc-tpl-card__source--preset {
        background: rgba(99, 102, 241, 0.15);
        color: #a5b4fc;
        border: 1px solid rgba(99, 102, 241, 0.35);
      }
      .disc-tpl-card__desc {
        font-size: 11px;
        color: var(--disc-fg-faint);
        line-height: 1.4;
        margin-bottom: 6px;
      }
      .disc-tpl-card__stats {
        font-size: 10px;
        color: var(--disc-fg-mute);
        letter-spacing: 0.04em;
        font-variant-numeric: tabular-nums;
      }
      .disc-tpl-card__actions {
        display: flex;
        gap: 4px;
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px dashed color-mix(in srgb, var(--g-primary) 8%, transparent);
        flex-wrap: wrap;
      }
      .disc-tpl-empty {
        text-align: center;
        padding: 32px 16px;
        color: var(--disc-fg-faint);
        font-size: 12px;
      }

      /* ── ANALYTICS ── */
      .disc-analytics-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 16px;
      }
      .disc-analytics-range {
        display: inline-flex;
        gap: 4px;
        padding: 4px;
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-radius: 8px;
      }
      .disc-analytics-range__btn {
        padding: 6px 14px;
        font-family: inherit;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.06em;
        background: transparent;
        color: var(--disc-fg-faint);
        border: none;
        border-radius: 6px;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .disc-analytics-range__btn:hover { color: var(--disc-fg); }
      .disc-analytics-range__btn.active {
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        color: var(--g-primary);
      }
      .disc-analytics-source {
        font-size: 10px;
        color: var(--disc-fg-mute);
        letter-spacing: 0.06em;
      }
      .disc-analytics-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
        gap: 14px;
      }
      .disc-chart-card {
        background:
          linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 3%, transparent), transparent),
          var(--disc-surface);
        border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-radius: 12px;
        padding: 14px 16px;
      }
      .disc-chart-card h3 {
        margin: 0 0 12px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--disc-fg-faint);
      }
      .disc-chart-card__sub {
        font-size: 11px;
        color: var(--disc-fg-mute);
        margin-top: -8px;
        margin-bottom: 12px;
      }
      .disc-chart-card svg { display: block; max-width: 100%; height: auto; }
      .disc-chart-card svg .axis { stroke: rgba(155, 139, 77, 0.18); }
      .disc-chart-card svg .axis-text {
        fill: var(--disc-fg-mute);
        font-size: 10px;
        font-family: inherit;
      }
      .disc-chart-card svg .grid-line { stroke: rgba(155, 139, 77, 0.08); stroke-dasharray: 2 4; }
      .disc-chart-card svg .line {
        stroke: var(--g-primary);
        stroke-width: 2;
        fill: none;
        stroke-linecap: round;
        stroke-linejoin: round;
        filter: drop-shadow(0 0 6px color-mix(in srgb, var(--g-primary) 40%, transparent));
      }
      .disc-chart-card svg .line-fill { fill: url(#disc-line-grad); opacity: 0.4; }
      .disc-chart-card svg .point {
        fill: var(--g-primary);
        stroke: rgba(0,0,0,0.4);
        stroke-width: 1;
      }
      .disc-chart-card svg .point-label {
        fill: var(--g-primary);
        font-size: 9px;
        font-family: inherit;
      }
      .disc-bar { transition: opacity 0.15s; }
      .disc-bar:hover { opacity: 0.8; }
      .disc-block-leader {
        display: grid;
        grid-template-columns: 1fr auto auto;
        gap: 8px;
        align-items: center;
        padding: 8px 0;
        font-size: 12px;
        border-bottom: 1px dashed color-mix(in srgb, var(--g-primary) 8%, transparent);
      }
      .disc-block-leader:last-child { border-bottom: none; }
      .disc-block-leader__label {
        color: var(--disc-fg-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .disc-block-leader__rate {
        color: var(--g-primary);
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .disc-block-leader__rate--low { color: #ff8a8a; }
      .disc-block-leader__count {
        color: var(--disc-fg-mute);
        font-size: 10px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .disc-dow-grid {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 4px;
      }
      .disc-dow-cell {
        aspect-ratio: 1 / 1;
        border-radius: 6px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 700;
        color: var(--disc-fg-dim);
      }
      .disc-dow-cell__lbl {
        font-size: 9px;
        color: var(--disc-fg-mute);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        margin-bottom: 2px;
      }
      .disc-abort-row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 12px;
        padding: 8px 0;
        border-bottom: 1px dashed color-mix(in srgb, var(--g-primary) 8%, transparent);
        font-size: 12px;
      }
      .disc-abort-row:last-child { border-bottom: none; }
      .disc-abort-row__reason { color: var(--disc-fg-dim); }
      .disc-abort-row__count {
        color: #ff8a8a;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      .disc-stat-pair {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .disc-stat-pair__cell {
        padding: 10px 12px;
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        border-radius: 8px;
        text-align: center;
      }
      .disc-stat-pair__val {
        font-size: 22px;
        font-weight: 800;
        color: var(--g-primary);
        font-variant-numeric: tabular-nums;
      }
      .disc-stat-pair__lbl {
        font-size: 9px;
        color: var(--disc-fg-faint);
        letter-spacing: 0.14em;
        text-transform: uppercase;
        margin-top: 2px;
      }

      /* ── BLOCKS VIEW MODE TOGGLE ── */
      .disc-view-toggle {
        display: inline-flex;
        border: 1px solid var(--disc-border-soft);
        border-radius: 8px;
        overflow: hidden;
        flex-shrink: 0;
      }
      .disc-view-toggle__btn {
        padding: 5px 12px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.10em;
        text-transform: uppercase;
        background: transparent;
        border: none;
        color: var(--disc-fg-faint);
        cursor: pointer;
        font-family: inherit;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        transition: all 0.12s ease;
      }
      .disc-view-toggle__btn + .disc-view-toggle__btn {
        border-left: 1px solid var(--disc-border-soft);
      }
      .disc-view-toggle__btn--active {
        background: color-mix(in srgb, var(--g-primary) 16%, transparent);
        color: var(--g-primary);
      }
      .disc-view-toggle__btn:hover:not(.disc-view-toggle__btn--active) {
        color: var(--disc-fg);
        background: var(--glass-hover);
      }

      /* ── BLOCK LIST MODE ── */
      .disc-block-list {
        display: flex;
        flex-direction: column;
        gap: 0;
        border: 1px solid var(--disc-border-soft);
        border-radius: 12px;
        overflow: hidden;
      }
      .disc-block-list-row {
        display: grid;
        grid-template-columns: 4px 1fr auto;
        align-items: center;
        gap: 0;
        background: transparent;
        border-bottom: 1px solid var(--disc-border-soft);
        transition: background 0.1s ease;
        cursor: default;
      }
      .disc-block-list-row:last-child { border-bottom: none; }
      .disc-block-list-row:hover { background: var(--glass-hover); }
      .disc-block-list-row__accent {
        width: 4px;
        align-self: stretch;
        flex-shrink: 0;
        border-radius: 0;
      }
      .disc-block-list-row__body {
        padding: 10px 14px;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .disc-block-list-row__title {
        font-size: 13px;
        font-weight: 600;
        color: var(--disc-fg);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .disc-block-list-row__meta {
        font-size: 11px;
        color: var(--disc-fg-faint);
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
      }
      .disc-block-list-row__actions {
        padding: 0 12px;
        display: flex;
        gap: 6px;
        align-items: center;
        flex-shrink: 0;
      }
      .disc-block-list-row--disabled { opacity: 0.45; }

      /* ── BLOCK COMPLETION ITEMS ── */
      .disc-completions {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .disc-completion-item {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--disc-fg-dim);
        line-height: 1.3;
      }
      .disc-completion-item__icon { flex-shrink: 0; font-size: 10px; }
      .disc-completion-item__title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .disc-completion-item__time {
        flex-shrink: 0;
        font-size: 10px;
        color: var(--disc-fg-faint);
        font-variant-numeric: tabular-nums;
      }

      /* ── FILTER BAR ── */
      .disc-filter-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        padding: 10px 14px;
        margin-bottom: 14px;
        border-radius: 10px;
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        border: 1px solid var(--disc-border-soft);
      }
      .disc-filter-label {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--disc-fg-faint);
        margin-right: 4px;
        white-space: nowrap;
      }
      .disc-filter-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 10px;
        font-size: 11px;
        font-weight: 600;
        border-radius: 20px;
        border: 1px solid var(--disc-border);
        background: transparent;
        color: var(--disc-fg-dim);
        cursor: pointer;
        transition: all 0.15s ease;
        white-space: nowrap;
        font-family: inherit;
      }
      .disc-filter-pill:hover {
        border-color: var(--g-primary);
        color: var(--g-primary);
      }
      .disc-filter-pill--active {
        background: color-mix(in srgb, var(--filter-color, var(--g-primary)) 16%, transparent);
        border-color: color-mix(in srgb, var(--filter-color, var(--g-primary)) 60%, transparent);
        color: var(--filter-color, var(--g-primary));
      }
      .disc-filter-sep {
        width: 1px;
        height: 18px;
        background: var(--disc-border-soft);
        flex-shrink: 0;
      }
      .disc-filter-clear {
        margin-left: auto;
        font-size: 10px;
        color: var(--disc-fg-faint);
        background: none;
        border: none;
        cursor: pointer;
        font-family: inherit;
        padding: 4px 8px;
        border-radius: 6px;
        transition: color 0.15s ease;
      }
      .disc-filter-clear:hover { color: var(--g-primary); }

      /* ── INSIGHTS STRIP ── */
      .disc-insights-strip {
        margin-bottom: 12px;
        padding: 12px 16px;
        border-radius: 12px;
        background:
          linear-gradient(135deg,
            color-mix(in srgb, var(--g-primary) 8%, transparent) 0%,
            color-mix(in srgb, var(--g-primary) 2%, transparent) 60%,
            transparent 100%),
          color-mix(in srgb, var(--g-bg, #0a0a0e) 50%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 18%, transparent);
        backdrop-filter: blur(12px) saturate(140%);
        -webkit-backdrop-filter: blur(12px) saturate(140%);
        box-shadow: 0 1px 0 color-mix(in srgb, var(--g-primary) 10%, transparent) inset;
      }
      .disc-insights-strip--collapsed {
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: pointer;
        padding: 8px 14px;
      }
      .disc-insights-strip--collapsed:hover {
        border-color: color-mix(in srgb, var(--g-primary) 35%, transparent);
      }
      .disc-insights-strip__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 10px;
      }
      .disc-insights-strip__title {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--g-primary);
      }
      .disc-insights-strip__toggle {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 10px;
        font-family: inherit;
        font-weight: 600;
        letter-spacing: 0.08em;
        color: var(--disc-fg-faint);
        padding: 3px 8px;
        border-radius: 6px;
        transition: color 0.15s ease;
      }
      .disc-insights-strip__toggle:hover { color: var(--g-primary); }
      .disc-insights-strip__metrics {
        display: flex;
        gap: 0;
        flex-wrap: wrap;
      }
      .disc-insights-metric {
        padding: 4px 20px 4px 0;
        border-right: 1px solid color-mix(in srgb, var(--g-primary) 12%, transparent);
        margin-right: 20px;
      }
      .disc-insights-metric:last-child {
        border-right: none;
        margin-right: 0;
      }
      .disc-insights-metric__val {
        font-size: 20px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--g-primary);
        line-height: 1;
      }
      .disc-insights-metric__lbl {
        margin-top: 3px;
        font-size: 10px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--disc-fg-faint);
      }
      .disc-insights-metric--warn .disc-insights-metric__val { color: #F59E0B; }

      /* ── AI START ACTIONS ── */
      .disc-block-ai-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: 10px;
        padding: 8px 10px;
        border-radius: 8px;
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 10%, transparent);
      }
      .disc-btn-ai {
        padding: 6px 12px;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        border-radius: 6px;
        border: 1px solid transparent;
        cursor: pointer;
        font-family: inherit;
        transition: all 0.15s ease;
        background: transparent;
      }
      .disc-btn-ai--start {
        color: #10B981;
        border-color: rgba(16, 185, 129, 0.35);
        background: rgba(16, 185, 129, 0.08);
      }
      .disc-btn-ai--start:hover {
        background: rgba(16, 185, 129, 0.18);
        border-color: rgba(16, 185, 129, 0.6);
        transform: translateY(-1px);
        box-shadow: 0 3px 10px rgba(16, 185, 129, 0.2);
      }
      .disc-btn-ai--today {
        color: var(--g-primary);
        border-color: color-mix(in srgb, var(--g-primary) 30%, transparent);
        background: color-mix(in srgb, var(--g-primary) 7%, transparent);
      }
      .disc-btn-ai--today:hover {
        background: color-mix(in srgb, var(--g-primary) 15%, transparent);
        border-color: color-mix(in srgb, var(--g-primary) 55%, transparent);
        transform: translateY(-1px);
        box-shadow: 0 3px 10px color-mix(in srgb, var(--g-primary) 20%, transparent);
      }
      .disc-btn-ai--blocks {
        color: #F59E0B;
        border-color: rgba(245, 158, 11, 0.30);
        background: rgba(245, 158, 11, 0.06);
      }
      .disc-btn-ai--blocks:hover {
        background: rgba(245, 158, 11, 0.15);
        border-color: rgba(245, 158, 11, 0.55);
        transform: translateY(-1px);
        box-shadow: 0 3px 10px rgba(245, 158, 11, 0.18);
      }
      @media (prefers-reduced-motion: reduce) {
        .disc-btn-ai:hover { transform: none; }
      }

      /* ── BLOCK STATE VISUALS ── */
      .disc-rail__block--incomplete {
        animation: discBlockPulse 3s ease-in-out infinite;
      }
      @keyframes discBlockPulse {
        0%, 100% { box-shadow: 0 0 0 1px color-mix(in srgb, var(--bl-color, var(--g-primary)) 25%, transparent); }
        50% { box-shadow: 0 0 10px 2px color-mix(in srgb, var(--bl-color, var(--g-primary)) 19%, transparent); }
      }
      .disc-rail__block--overdue {
        box-shadow: 0 0 0 2px #ef444480, 0 0 16px #ef444430 !important;
      }
      .disc-rail__block--completed-vis {
        filter: saturate(0.45) brightness(0.8);
        position: relative;
      }
      .disc-block-ribbon {
        position: absolute;
        top: 6px;
        right: -1px;
        font-size: 8px;
        font-weight: 800;
        letter-spacing: 0.12em;
        padding: 2px 6px 2px 8px;
        border-radius: 3px 0 0 3px;
        pointer-events: none;
        z-index: 4;
      }
      .disc-block-ribbon--done {
        background: #10B98120;
        color: #10B981;
        border: 1px solid #10B98140;
        border-right: none;
      }
      .disc-block-ribbon--aborted {
        background: #6B728020;
        color: #9CA3AF;
        border: 1px solid #6B728040;
        border-right: none;
        border-style: dashed;
      }
      .disc-block-countdown {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        font-size: 9px;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        padding: 2px 6px;
        border-radius: 6px;
        background: color-mix(in srgb, var(--bl-color, var(--g-primary)) 14%, transparent);
        color: var(--bl-color, var(--g-primary));
        letter-spacing: 0.04em;
      }

      /* ── REFLECTION CARDS ── */
      .disc-reflection-stack {
        position: absolute;
        bottom: 4px;
        left: 4px;
        right: 4px;
        display: flex;
        flex-direction: column-reverse;
        gap: 3px;
        pointer-events: none;
        z-index: 10;
        max-height: 80px;
        overflow: hidden;
      }
      .disc-reflection-card {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-radius: 6px;
        background: color-mix(in srgb, var(--bl-color, var(--g-primary)) 20%, rgba(10,10,14,0.85));
        border: 1px solid color-mix(in srgb, var(--bl-color, var(--g-primary)) 40%, transparent);
        font-size: 10px;
        color: var(--disc-fg, #f5eacd);
        backdrop-filter: blur(8px);
        animation: discCardIn 0.28s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        box-shadow: 0 0 14px color-mix(in srgb, var(--bl-color, var(--g-primary)) 30%, transparent);
      }
      .disc-reflection-card--exit {
        animation: discCardOut 0.3s ease-in forwards;
      }
      @keyframes discCardIn {
        from { opacity: 0; transform: scale(0.88) translateY(4px); }
        to   { opacity: 1; transform: scale(1) translateY(0); }
      }
      @keyframes discCardOut {
        to { opacity: 0; transform: scale(0.9) translateY(-4px); }
      }
      .disc-reflection-icon { font-size: 12px; flex-shrink: 0; }
      .disc-reflection-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      /* ── WORKLOAD TRACKING ── */
      .disc-workload-summary {
        margin: 16px 0 0;
        padding: 16px 20px;
        background: var(--disc-surface);
        border: 1px solid var(--disc-border-soft);
        border-radius: 12px;
        backdrop-filter: blur(12px);
      }
      .disc-workload-summary__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 12px;
      }
      .disc-workload-summary__title {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--disc-fg-faint);
      }
      .disc-workload-summary__total {
        font-size: 14px;
        font-weight: 800;
        color: var(--g-primary);
      }
      .disc-workload-stats {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 8px;
        margin-bottom: 12px;
      }
      @media (max-width: 600px) {
        .disc-workload-stats { grid-template-columns: 1fr 1fr; }
      }
      .disc-workload-stat {
        padding: 8px 10px;
        background: color-mix(in srgb, var(--g-primary) 5%, transparent);
        border-radius: 8px;
        text-align: center;
      }
      .disc-workload-stat__val {
        font-size: 18px;
        font-weight: 800;
        color: var(--g-primary);
        font-variant-numeric: tabular-nums;
      }
      .disc-workload-stat__lbl {
        font-size: 9px;
        color: var(--disc-fg-faint);
        letter-spacing: 0.1em;
        text-transform: uppercase;
        margin-top: 2px;
      }
      .disc-workload-sparkline {
        display: flex;
        align-items: flex-end;
        gap: 3px;
        height: 36px;
        margin-bottom: 12px;
      }
      .disc-workload-sparkline__bar {
        flex: 1;
        border-radius: 3px 3px 0 0;
        min-height: 2px;
        background: color-mix(in srgb, var(--g-primary) 55%, transparent);
        transition: background 0.15s;
        cursor: default;
        position: relative;
      }
      .disc-workload-sparkline__bar--today {
        background: var(--g-primary);
      }
      .disc-workload-sparkline__lbl {
        font-size: 8px;
        color: var(--disc-fg-mute);
        text-align: center;
        margin-top: 2px;
      }
      .disc-workload-sparkline-wrap {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 2px;
        margin-bottom: 4px;
      }
      .disc-workload-projects {
        margin-top: 8px;
      }
      .disc-workload-proj-bar {
        display: grid;
        grid-template-columns: 80px 1fr 50px;
        gap: 6px;
        align-items: center;
        margin-bottom: 5px;
        font-size: 11px;
      }
      .disc-workload-proj-bar__label {
        color: var(--disc-fg-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .disc-workload-proj-bar__track {
        height: 6px;
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        border-radius: 4px;
        overflow: hidden;
      }
      .disc-workload-proj-bar__fill {
        height: 100%;
        background: var(--g-primary);
        border-radius: 4px;
        opacity: 0.7;
        transition: width 0.3s ease;
      }
      .disc-workload-proj-bar__dur {
        color: var(--disc-fg-faint);
        text-align: right;
        font-variant-numeric: tabular-nums;
      }

      /* ── AUTO-LOGGED LANE ── */
      .disc-autolog {
        margin-top: 16px;
        border-top: 1px solid var(--disc-border-soft);
        padding-top: 12px;
      }
      .disc-autolog__header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
      }
      .disc-autolog__title {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--disc-fg-faint);
      }
      .disc-autolog__count {
        font-size: 10px;
        color: var(--disc-fg-mute);
        background: color-mix(in srgb, var(--g-primary) 10%, transparent);
        padding: 1px 6px;
        border-radius: 8px;
      }
      .disc-autolog__list {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .disc-autolog__entry {
        display: grid;
        grid-template-columns: 52px 1fr auto;
        gap: 8px;
        align-items: center;
        padding: 6px 10px;
        background: color-mix(in srgb, var(--g-primary) 4%, transparent);
        border: 1px solid var(--disc-border-soft);
        border-radius: 8px;
        font-size: 11px;
        cursor: default;
        transition: background 0.12s;
      }
      .disc-autolog__entry:hover {
        background: color-mix(in srgb, var(--g-primary) 8%, transparent);
      }
      .disc-autolog__time {
        color: var(--disc-fg-faint);
        font-variant-numeric: tabular-nums;
        font-size: 10px;
      }
      .disc-autolog__label {
        color: var(--disc-fg-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .disc-autolog__meta {
        display: flex;
        gap: 6px;
        align-items: center;
        flex-shrink: 0;
      }
      .disc-autolog__source {
        font-size: 9px;
        padding: 1px 5px;
        border-radius: 4px;
        background: color-mix(in srgb, var(--g-primary) 15%, transparent);
        color: var(--disc-fg-faint);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .disc-autolog__dur {
        font-size: 10px;
        color: var(--g-primary);
        font-variant-numeric: tabular-nums;
      }
      .disc-autolog__empty {
        font-size: 11px;
        color: var(--disc-fg-mute);
        padding: 8px 0;
        text-align: center;
      }
    </style>
  `;
}

function routineProgressFor(ds: DisciplineState, block: DisciplineBlock): { done: number; total: number } {
  let done = 0;
  const total = block.routineItems?.length ?? 0;
  for (const item of block.routineItems ?? []) {
    if (ds.routineDone[`${block.id}:${item.id}`]) done += 1;
  }
  return { done, total };
}

function renderRoutineChecklist(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
  block: DisciplineBlock,
  color: string,
): TemplateResult {
  if (!block.routineItems || block.routineItems.length === 0) return html``;
  return html`
    <div class="disc-routine">
      ${block.routineItems.map((item) => {
        const key = `${block.id}:${item.id}`;
        const done = !!ds.routineDone[key];
        return html`
          <div
            class="disc-routine__item ${done ? "disc-routine__item--done" : ""}"
            style="color:${color}"
            @click=${(e: Event) => {
              e.stopPropagation();
              void toggleRoutineItem(ds, client, block.id, item.id);
              host.requestUpdate?.();
            }}
          >
            <div class="disc-routine__check"></div>
            <div class="disc-routine__label">${item.label}</div>
          </div>
        `;
      })}
    </div>
  `;
}

function renderLinkPills(ds: DisciplineState, block: DisciplineBlock): TemplateResult {
  const project = block.projectId ? ds.kanbanProjects.find((p) => p.id === block.projectId) : null;
  const task = block.taskId ? ds.kanbanTasks.find((t) => t.id === block.taskId) : null;
  if (!project && !task) return html``;
  return html`
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">
      ${project
        ? html`<span class="disc-link-pill" style="--link-color:${project.color ?? "var(--g-primary)"}">
            <span class="disc-link-pill__dot"></span>${project.name}
          </span>`
        : nothing}
      ${task ? html`<span class="disc-link-pill">${icons.arrowRight} ${task.title}</span>` : nothing}
    </div>
  `;
}

/** Show a row of event-activity dots inside a timeline block or block card. */
function renderBlockEventDots(
  ds: DisciplineState,
  block: DisciplineBlock,
  color: string,
): TemplateResult | typeof nothing {
  const counts = ds.autoLogCounts.find((c) => c.blockId === block.id);
  if (!counts || counts.total === 0) return nothing;
  // Show up to 20 dots representing grouped events, color = block color
  const dotCount = Math.min(20, counts.total);
  const title = `${counts.total} auto-logged events today`;
  return html`
    <div class="disc-autolog-strip" title="${title}">
      ${Array.from({ length: dotCount }, (_, i) =>
        html`<div class="disc-autolog-dot" style="background:${color};opacity:${0.3 + (i / dotCount) * 0.5};"></div>`,
      )}
      ${counts.total > 20
        ? html`<span style="font-size:9px;color:${color};opacity:0.6;margin-left:2px;">+${counts.total - 20}</span>`
        : nothing}
    </div>
  `;
}

function renderHero(ds: DisciplineState, host: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const progress = blockProgress(ds);
  const next = nextBlock(ds);
  const untilNext = minutesUntilNext(ds);
  const todayScore = ds.today?.compliance ?? 0;
  const streak = streakDays(ds.week);
  const focusMins = ds.today?.categoryMinutes["deep-work"] ?? 0;
  const hueColor = scoreHue(todayScore);

  const kickerLabel = progress.block
    ? "Active block"
    : next
      ? "Next up"
      : ds.blocks.length === 0
        ? "Nothing planned"
        : "Off the clock";

  const title = progress.block
    ? progress.block.label
    : next
      ? next.label
      : "Ready when you are";

  const sub = progress.block
    ? html`
        <strong style="color:var(--g-primary);">${humanDuration(progress.remainingMin)}</strong>
        left · ${minsToHHMM(progress.block.startMinute)}–${minsToHHMM(progress.block.endMinute)}
        ${progress.block.intent ? html` · <em>${progress.block.intent}</em>` : nothing}
      `
    : next
      ? html`
          starts in <strong style="color:var(--g-primary);">${humanDuration(untilNext ?? 0)}</strong>
          at ${minsToHHMM(next.startMinute)}
        `
      : ds.blocks.length === 0
        ? html`Pick a preset below or create your first block`
        : html`No more scheduled blocks today`;

  return html`
    <div
      class="disc-hero"
      data-learn-id="discipline-hero"
      style="--disc-glow: ${progress.block ? `color-mix(in srgb, ${hueColor} 20%, transparent)` : "transparent"}"
    >
      <div class="disc-hero__left">
        <div class="disc-hero__kicker">
          ${progress.block ? html`<span class="disc-hero__dot"></span>` : nothing}
          ${kickerLabel}
        </div>
        <h1 class="disc-hero__title">${title}</h1>
        <div class="disc-hero__sub">${sub}</div>
        ${progress.block
          ? html`
              <div class="disc-hero__progress">
                <div class="disc-hero__progress-fill" style="width:${progress.percent}%"></div>
              </div>
            `
          : nothing}
      </div>
      <div class="disc-hero__stat" data-learn-id="discipline-compliance" style="--val-color:${hueColor}">
        <div class="disc-hero__stat-val">${todayScore}%</div>
        <div class="disc-hero__stat-lbl">Compliance</div>
      </div>
      <div class="disc-hero__stat">
        <div class="disc-hero__stat-val">${humanDuration(focusMins)}</div>
        <div class="disc-hero__stat-lbl">Focus today</div>
      </div>
      <div class="disc-hero__stat">
        <div class="disc-hero__stat-val">${streak}</div>
        <div class="disc-hero__stat-lbl">Day streak</div>
      </div>
      ${ds.timeSavedMin > 0
        ? html`
            <div class="disc-hero__stat" style="--val-color:#10B981">
              <div class="disc-hero__stat-val">${humanDuration(ds.timeSavedMin)}</div>
              <div class="disc-hero__stat-lbl">Banked ${icons.zap}</div>
            </div>
          `
        : nothing}
      <div class="disc-hero__actions" data-learn-id="discipline-hero-actions">
        ${progress.block
          ? html`
              <button
                class="disc-btn disc-btn--primary"
                @click=${() => {
                  void quickLog(ds, client, {
                    label: progress.block!.label,
                    category: progress.block!.category,
                    blockId: progress.block!.id,
                  });
                  host.requestUpdate?.();
                }}
              >
                Check in
              </button>
              <button
                class="disc-btn disc-btn--danger"
                @click=${() => {
                  openAbortModal(ds, host, client, progress.block!);
                }}
              >
                Abort
              </button>
            `
          : html`
              <button
                class="disc-btn disc-btn--primary"
                @click=${() => {
                  beginCreate(ds);
                  ds.subView = "blocks";
                  host.requestUpdate?.();
                }}
              >
                + New block
              </button>
            `}
        <button
          class="disc-btn"
          style="color:var(--g-primary);border-color:color-mix(in srgb, var(--g-primary) 35%, transparent);background:color-mix(in srgb, var(--g-primary) 7%, transparent);"
          data-learn-id="discipline-start-now"
          title="Shift all remaining blocks to start from right now, preserving durations"
          @click=${async () => {
            try {
              const result = await shiftBlocksFromNow(ds, client);
              if (result.shiftedCount > 0) {
                const now = new Date();
                const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
                ds.error = null;
                // Reload to pick up the shifted blocks
                void loadAutoLogCounts(ds, client).then(() => host.requestUpdate?.());
                host.requestUpdate?.();
                // Show transient toast via modal
                ds.modal = {
                  kind: "confirm",
                  title: "Day started",
                  body: `Day started at ${hhmm} — ${result.shiftedCount} block${result.shiftedCount !== 1 ? "s" : ""} scheduled from now.`,
                  confirmLabel: "OK",
                  onConfirm: () => { ds.modal = null; host.requestUpdate?.(); },
                };
                host.requestUpdate?.();
              }
            } catch (e) {
              ds.error = `Start from now failed: ${String(e)}`;
              host.requestUpdate?.();
            }
          }}
        >${icons.clock} Start from now</button>
        <button
          class="disc-btn disc-btn--ghost"
          @click=${() => {
            ds.settings = { ...ds.settings, militant: !ds.settings.militant };
            void updateSettings(ds, client, { militant: ds.settings.militant });
            host.requestUpdate?.();
          }}
          data-learn-id="discipline-militant"
          title="Hard-lock notifications during blocks"
        >
          ${ds.settings.militant ? html`${icons.lock} Militant ON` : "Militant off"}
        </button>
      </div>
    </div>
  `;
}

/**
 * Always-visible quick-log bar. The point is friction reduction:
 *   - one input, one Enter to log "what just happened"
 *   - category defaults to the active block, so it's usually zero clicks
 *   - L keyboard shortcut from anywhere on the page focuses it
 *   - logs render instantly via quickLog's optimistic state insert
 * Lives between the hero and daily summary so it's reachable without scroll.
 */
function renderQuickLogBar(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const cat = quickLogCategoryFor(ds);
  const justSaved = _quickLog.flash > 0 && Date.now() - _quickLog.flash < 1600;
  const active = currentBlock(ds);
  const ph = active
    ? `What did you do for "${active.label}"? (press L from anywhere)`
    : "Log what just happened…  (press L from anywhere)";
  return html`
    <div class="disc-quick-log ${justSaved ? "disc-quick-log--saved" : ""}" data-learn-id="discipline-quick-log">
      <span class="disc-quick-log__icon" style="background:${CATEGORY_COLORS[cat]}"></span>
      <input
        id=${QUICK_LOG_INPUT_ID}
        class="disc-quick-log__input"
        data-learn-id="discipline-quick-log-input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder=${ph}
        .value=${_quickLog.label}
        @input=${(e: Event) => {
          _quickLog.label = (e.target as HTMLInputElement).value;
        }}
        @keydown=${(e: KeyboardEvent) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submitQuickLog(ds, host, client);
          } else if (e.key === "Escape") {
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <select
        class="disc-quick-log__cat"
        data-learn-id="discipline-quick-log-category"
        .value=${cat}
        @change=${(e: Event) => {
          _quickLog.category = (e.target as HTMLSelectElement).value as DisciplineCategory;
          host.requestUpdate?.();
        }}
        title="Category"
      >
        ${DISCIPLINE_CATEGORIES.map(
          (c) => html`<option value=${c} ?selected=${c === cat}>${CATEGORY_LABELS[c]}</option>`,
        )}
      </select>
      <button
        class="disc-btn disc-btn--primary disc-quick-log__btn"
        ?disabled=${!_quickLog.label.trim() || _quickLog.saving}
        @click=${() => void submitQuickLog(ds, host, client)}
        title="Log entry (Enter)"
      >
        ${_quickLog.saving ? "Logging…" : justSaved ? html`${icons.check} Logged` : "Log"}
      </button>
    </div>
  `;
}

function renderSubnav(ds: DisciplineState, host: AppViewState): TemplateResult {
  const tabs: Array<{ id: DisciplineSubView; label: string; hint: string }> = [
    { id: "timeline", label: "Timeline", hint: "1" },
    { id: "blocks", label: "Blocks", hint: "2" },
    { id: "score", label: "Score", hint: "3" },
    { id: "settings", label: "Settings", hint: "4" },
  ];
  // Surface live status in the nav so the user can see at a glance whether
  // their discipline assistant is wired up (telegram + AI) without going
  // into the settings panel.
  const tgOn = ds.settings.telegramEnabled;
  const aiOn = ds.settings.ai.enabled;
  const quiet = isQuietHoursNow(ds.settings);
  return html`
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
      <div class="disc-subnav" data-learn-id="discipline-subnav">
        ${tabs.map(
          (t) => html`
            <button
              class="disc-subnav__tab ${ds.subView === t.id ? "active" : ""}"
              data-learn-id=${`discipline-tab-${t.id}`}
              @click=${() => { ds.subView = t.id; host.requestUpdate?.(); }}
              title="${t.label} (${t.hint})"
            >
              ${t.label}
            </button>
          `,
        )}
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        ${tgOn
          ? (() => {
              // Show richer indicator based on last-send result stored on ds
              const lastResult = ds.telegramTestResult;
              const recentOk = lastResult?.ok && (Date.now() - lastResult.ts) < 3_600_000;
              const recentFail = lastResult && !lastResult.ok;
              const cls = recentFail
                ? "disc-status-pill--err"
                : recentOk
                ? "disc-status-pill--ok"
                : "disc-status-pill--ok";
              const dot = recentFail ? html`<span style="color:#ef4444">${icons.circle}</span>` : html`<span style="color:#22c55e">${icons.circle}</span>`;
              const title = recentFail
                ? `Telegram error: ${lastResult?.message}`
                : "Telegram notifications on · click to go to Settings";
              return html`<span
                class="disc-status-pill ${cls}"
                title="${title}"
                style="cursor:pointer;"
                @click=${() => { ds.subView = "settings"; host.requestUpdate?.(); }}
              >${dot} TG</span>`;
            })()
          : html`<span class="disc-status-pill disc-status-pill--idle" title="Telegram off — open Settings to enable" style="cursor:pointer;" @click=${() => { ds.subView = "settings"; host.requestUpdate?.(); }}><span style="color:#6b7280">${icons.circle}</span> TG</span>`}
        ${aiOn
          ? html`<span class="disc-status-pill disc-status-pill--ok" title="AI assistant on">${icons.sparkles} AI</span>`
          : html`<span class="disc-status-pill disc-status-pill--idle" title="AI off — open Settings to enable">${icons.sparkles} AI</span>`}
        ${quiet
          ? html`<span class="disc-status-pill disc-status-pill--idle" title="Quiet hours active — telegram + audio nudges are muted">${icons.circle} QUIET</span>`
          : nothing}
      </div>
      <div class="disc-subnav__hint" style="margin-left:auto;">
        <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>4</kbd> switch · <kbd>N</kbd> new block · <kbd>Esc</kbd> cancel
      </div>
    </div>
  `;
}

/** Strict day-of-week match for today — used by the day-mode banner only. */
function blocksScheduledToday(ds: DisciplineState): DisciplineBlock[] {
  const iso = todayIso();
  const dow = new Date().getDay();
  return ds.blocks.filter((b) => {
    if (!b.enabled) return false;
    if (b.oneOffDate) return b.oneOffDate === iso;
    return (b.days ?? []).includes(dow);
  });
}

function allEnabledBlocks(ds: DisciplineState): DisciplineBlock[] {
  return ds.blocks.filter((b) => b.enabled);
}

/** What the timeline actually renders. The day-of-week filter is intentionally
 *  removed: the Blocks view shows every block, and silently hiding them on
 *  the Timeline view (because today happens to be a weekend, or the block has
 *  no `days` array, or the user just loaded a Mon–Fri template on a Sunday)
 *  was a constant source of "my schedule disappeared" confusion.
 *
 *  Operators can still:
 *    - disable a block (Pause) to hide it everywhere, or
 *    - flip `timelinePreviewAllDays` off via the day-mode banner to opt back
 *      into the strict day-of-week filter for the current session. */
function todayBlocks(ds: DisciplineState): DisciplineBlock[] {
  // Explicit "today only" mode — only ever true after the user clicks the
  // "Today only" toggle on the timeline header strip. Default is "show all".
  if (ds.timelinePreviewAllDays === false) {
    return blocksScheduledToday(ds);
  }
  return allEnabledBlocks(ds);
}

function enabledBlockCount(ds: DisciplineState): number {
  return allEnabledBlocks(ds).length;
}
function todayLogs(ds: DisciplineState): DisciplineLog[] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime();
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return ds.logs.filter((l) => l.startMs >= startMs && l.startMs < endMs);
}

function openAbortModal(ds: DisciplineState, host: AppViewState, client: GatewayBrowserClient, block: DisciplineBlock): void {
  ds.modal = {
    kind: "prompt",
    title: `Abort "${block.label}"?`,
    body: "Log the reason — this helps you spot drift patterns in the weekly review.",
    placeholder: "why are you stopping?",
    value: "",
    onSubmit: async (reason: string) => {
      ds.modal = null;
      host.requestUpdate?.();
      if (!reason.trim()) return;
      const now = Date.now();
      await client.request("discipline.logs.create", {
        blockId: block.id,
        label: `ABORT: ${block.label}`,
        category: block.category,
        source: "abort",
        startMs: now,
        endMs: now,
        reason,
      });
      await loadDiscipline(ds, client);
      host.requestUpdate?.();
    },
  };
  host.requestUpdate?.();
}

let isBlockDragging = false;
export function isBlockDragActive(): boolean {
  return isBlockDragging;
}

function handleBlockPointerDown(
  e: PointerEvent,
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
  block: DisciplineBlock,
  pixelsPerMinute: number,
  snapMin: number,
  dayStartHour: number,
): void {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest(".disc-icon-btn, button, .disc-routine__item, input, textarea, select"))
    return;
  const el = e.currentTarget as HTMLElement | null;
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();

  const startY = e.clientY;
  const origStart = block.startMinute;
  const duration = block.endMinute - block.startMinute;
  const dayStartMin = dayStartHour * 60;
  const dayEndMin = ds.settings.dayEndHour * 60 + 60;
  let moved = false;
  let newStart = origStart;
  isBlockDragging = true;

  const onMove = (ev: PointerEvent) => {
    const dy = ev.clientY - startY;
    if (!moved && Math.abs(dy) < 4) return;
    if (!moved) {
      moved = true;
      el.classList.add("is-dragging");
    }
    const deltaMin = dy / pixelsPerMinute;
    const snapped = Math.round((origStart + deltaMin) / snapMin) * snapMin;
    newStart = Math.max(dayStartMin, Math.min(dayEndMin - duration, snapped));
    const top = (newStart - dayStartMin) * pixelsPerMinute;
    el.style.top = `${Math.max(0, top)}px`;
  };

  const onUp = async () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onUp, true);
    el.classList.remove("is-dragging");
    isBlockDragging = false;
    if (!moved) {
      beginEdit(ds, block.id);
      ds.subView = "blocks";
      host.requestUpdate?.();
      return;
    }
    if (newStart === origStart) {
      host.requestUpdate?.();
      return;
    }
    await updateBlock(ds, client, block.id, {
      startMinute: newStart,
      endMinute: newStart + duration,
    });
    host.requestUpdate?.();
  };

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onUp, true);
}

// MIME we use for kanban-task drag payloads. Note: some browsers (Safari) lowercase
// the type. We probe both casings + a text/plain fallback so the drop works
// across Chromium / Firefox / Safari / WebKit-on-iOS.
const TASK_MIME = "application/x-kanban-task";

function readTaskPayload(dt: DataTransfer): { taskId: string; projectId?: string } | null {
  // Try the structured MIME first, then the text/plain fallback we set on
  // every dragstart so external drops (Notion blocks, plain JSON, etc.) can
  // still land if the user copy-pasted task JSON.
  const tryParse = (raw: string | null) => {
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj.taskId === "string") return obj;
      return null;
    } catch {
      return null;
    }
  };
  return tryParse(dt.getData(TASK_MIME)) ?? tryParse(dt.getData("text/plain"));
}

function handleBlockDragEnter(e: DragEvent): void {
  // Some browsers only fire `dragenter` for the initial element of a drag
  // session — if we don't preventDefault here, subsequent dragovers may not
  // fire either. Be permissive: as long as anything is being dragged, allow it.
  if (!e.dataTransfer) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "link";
  (e.currentTarget as HTMLElement)?.classList.add("is-drop-target");
}

function handleBlockDragOver(e: DragEvent): void {
  if (!e.dataTransfer) return;
  // Accept on anything that has data — checking the exact MIME fails on
  // browsers that lowercase the type or strip it during drag-over. The
  // actual payload is validated on drop.
  e.preventDefault();
  e.dataTransfer.dropEffect = "link";
  (e.currentTarget as HTMLElement)?.classList.add("is-drop-target");
}

function handleBlockDragLeave(e: DragEvent): void {
  (e.currentTarget as HTMLElement)?.classList.remove("is-drop-target");
}

function handleBlockDrop(
  e: DragEvent,
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
  block: DisciplineBlock,
): void {
  (e.currentTarget as HTMLElement)?.classList.remove("is-drop-target");
  if (!e.dataTransfer) return;
  e.preventDefault();
  e.stopPropagation();
  const data = readTaskPayload(e.dataTransfer);
  if (!data?.taskId) return;
  void (async () => {
    await updateBlock(ds, client, block.id, {
      taskId: data.taskId,
      projectId: data.projectId ?? block.projectId,
    });
    addReflectionEvent(block.id, `→ Task linked: ${data.taskId.slice(-6)}`, "🔗", CATEGORY_COLORS[block.category] ?? "var(--g-primary)");
    host.requestUpdate?.();
  })();
}

/** Set the standard kanban-task drag payload on a `dragstart` event. Used
 *  by both the side-panel chip and the modal task cards so any of them can
 *  be dropped onto a block in the timeline or Blocks view. */
function setTaskDragPayload(
  e: DragEvent,
  payload: { taskId: string; projectId?: string; title?: string },
): void {
  if (!e.dataTransfer) return;
  const json = JSON.stringify(payload);
  e.dataTransfer.effectAllowed = "link";
  // Set both the structured MIME and a text/plain fallback so we can always
  // round-trip the data regardless of how the browser exposes types.
  e.dataTransfer.setData(TASK_MIME, json);
  e.dataTransfer.setData("text/plain", json);
}

// renderKanbanDragPanel and renderTaskModal removed: the inline kanban panel
// rendered by renderInlineTaskKanban inside renderTimeline is now the single
// surface for tasks. Keeping a modal mounted at the root caused two problems:
// (1) clicking the in-modal toggle re-rendered both modal + inline panel, so
// view-mode changes appeared to "stack", and (2) the modal's full-viewport
// overlay blocked drag-and-drop onto timeline blocks.

function renderFilterBar(ds: DisciplineState, host: AppViewState): TemplateResult {
  const f = ds.blockFilters;
  const hasFilters = f.categories.length > 0 || f.status.length > 0 || f.source.length > 0;

  const toggleCat = (cat: DisciplineCategory) => {
    // Single-select (radio): clicking an active category deselects it;
    // clicking a different category replaces the selection instead of appending.
    const next = f.categories.includes(cat) ? [] : [cat];
    ds.blockFilters = { ...f, categories: next };
    host.requestUpdate?.();
  };
  const toggleStatus = (s: string) => {
    const arr = f.status as string[];
    const next = arr.includes(s) ? arr.filter((x) => x !== s) : [...arr, s];
    ds.blockFilters = { ...f, status: next as DisciplineFilterState["status"] };
    host.requestUpdate?.();
  };
  const toggleSource = (src: string) => {
    const arr = f.source as string[];
    const next = arr.includes(src) ? arr.filter((x) => x !== src) : [...arr, src];
    ds.blockFilters = { ...f, source: next as DisciplineFilterState["source"] };
    host.requestUpdate?.();
  };
  const clearAll = () => {
    ds.blockFilters = { categories: [], status: [], source: [] };
    host.requestUpdate?.();
  };

  const CATEGORY_COLORS_LOCAL: Record<string, string> = {
    "deep-work": "var(--g-primary)",
    meetings: "#8B5CF6",
    ops: "#3B82F6",
    body: "#10B981",
    admin: "#6B7280",
    break: "#F59E0B",
    personal: "#EC4899",
  };
  const STATUS_META: Array<{ key: string; label: string; color: string }> = [
    { key: "incomplete", label: "Incomplete", color: "var(--g-primary)" },
    { key: "in-progress", label: "In progress", color: "#10B981" },
    { key: "completed", label: "Completed", color: "#6B7280" },
    { key: "overdue", label: "Overdue", color: "#EF4444" },
  ];
  const SOURCE_META: Array<{ key: string; label: string; color: string }> = [
    { key: "manual", label: "Manual", color: "var(--g-primary)" },
    { key: "auto", label: "Auto-log", color: "#F59E0B" },
    { key: "agent", label: "Agent", color: "#8B5CF6" },
  ];

  return html`
    <div class="disc-filter-bar">
      <span class="disc-filter-label">Type</span>

      ${DISCIPLINE_CATEGORIES.map((cat) => {
        const active = f.categories.includes(cat);
        const color = CATEGORY_COLORS_LOCAL[cat] ?? "var(--g-primary)";
        return html`
          <button
            class="disc-filter-pill ${active ? "disc-filter-pill--active" : ""}"
            style="--filter-color:${color}"
            @click=${() => toggleCat(cat)}
            title="Show only ${CATEGORY_LABELS[cat]} blocks"
          >${CATEGORY_LABELS[cat]}</button>
        `;
      })}

      <div class="disc-filter-sep"></div>
      <span class="disc-filter-label">Status</span>

      ${STATUS_META.map(({ key, label, color }) => {
        const active = (f.status as string[]).includes(key);
        return html`
          <button
            class="disc-filter-pill ${active ? "disc-filter-pill--active" : ""}"
            style="--filter-color:${color}"
            @click=${() => toggleStatus(key)}
          >${label}</button>
        `;
      })}

      <div class="disc-filter-sep"></div>
      <span class="disc-filter-label">Source</span>

      ${SOURCE_META.map(({ key, label, color }) => {
        const active = (f.source as string[]).includes(key);
        return html`
          <button
            class="disc-filter-pill ${active ? "disc-filter-pill--active" : ""}"
            style="--filter-color:${color}"
            @click=${() => toggleSource(key)}
          >${label}</button>
        `;
      })}

      ${hasFilters ? html`<button class="disc-filter-clear" @click=${clearAll}>${icons.x} Clear all</button>` : nothing}
    </div>
  `;
}

function applyBlockFilters(ds: DisciplineState, blocks: DisciplineBlock[]): DisciplineBlock[] {
  const f = ds.blockFilters;
  if (!f) return blocks;
  let result = blocks;

  if (f.categories.length > 0) {
    result = result.filter((b) => f.categories.includes(b.category));
  }

  if (f.status.length > 0) {
    const nowM = nowMinutes();
    const today = todayIso();
    result = result.filter((b) => {
      const done = isBlockDoneToday(ds, b.id);
      const isAborted = ds.logs.some(
        (l) => l.blockId === b.id && l.source === "abort" &&
          new Date(l.startMs).toISOString().slice(0, 10) === today,
      );
      const isCurrent = !done && nowM >= b.startMinute && nowM < b.endMinute;
      const isOverdue = !done && !isCurrent && nowM > b.endMinute;
      const isIncomplete = !done && !isCurrent && !isOverdue;
      const statusArr = f.status as string[];
      if (statusArr.includes("completed") && done) return true;
      if (statusArr.includes("in-progress") && isCurrent) return true;
      if (statusArr.includes("overdue") && isOverdue) return true;
      if (statusArr.includes("incomplete") && isIncomplete) return true;
      return false;
    });
  }

  if (f.source.length > 0) {
    const today = todayIso();
    const sourceArr = f.source as string[];
    result = result.filter((b) => {
      const hasAuto = (ds.autoLogCounts.find((c) => c.blockId === b.id)?.total ?? 0) > 0;
      const hasManual = ds.logs.some(
        (l) => l.blockId === b.id &&
          (l.source === "manual" || l.source === "planned") &&
          new Date(l.startMs).toISOString().slice(0, 10) === today,
      );
      const hasAgent = ds.logs.some(
        (l) => l.blockId === b.id && l.source === "probe" &&
          new Date(l.startMs).toISOString().slice(0, 10) === today,
      );
      if (sourceArr.includes("manual") && hasManual) return true;
      if (sourceArr.includes("auto") && hasAuto) return true;
      if (sourceArr.includes("agent") && hasAgent) return true;
      return false;
    });
  }

  return result;
}

// Module-level collapse toggle for insights strip (avoids touching state types).
let _insightsCollapsed = false;

function renderInsightsStrip(ds: DisciplineState, host: AppViewState): TemplateResult {
  const todayMs = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
  const tomorrowMs = todayMs + 86_400_000;
  const dayLogs = ds.logs.filter((l) => l.startMs >= todayMs && l.startMs < tomorrowMs);
  const actualMins = ds.today?.actualMinutes ?? 0;
  const taskCount = new Set(dayLogs.map((l) => l.blockId).filter(Boolean)).size;
  const totalEvents = ds.autoLogCounts.reduce((s, c) => s + c.total, 0);

  // Longest completed log entry today (endMs present)
  const longestMs = dayLogs
    .filter((l) => l.endMs != null && l.endMs > l.startMs)
    .reduce((max, l) => Math.max(max, l.endMs! - l.startMs), 0);
  const longestMins = Math.round(longestMs / 60_000);

  // Most context-switched block (most log entries for a single block)
  const switchMap = new Map<string, number>();
  for (const l of dayLogs) {
    if (l.blockId) switchMap.set(l.blockId, (switchMap.get(l.blockId) ?? 0) + 1);
  }
  let mostSwitchedLabel = "";
  let maxSwitches = 0;
  for (const [bid, cnt] of switchMap) {
    if (cnt > maxSwitches) {
      maxSwitches = cnt;
      mostSwitchedLabel = ds.blocks.find((b) => b.id === bid)?.label ?? "";
    }
  }

  const toggleCollapse = () => {
    _insightsCollapsed = !_insightsCollapsed;
    host.requestUpdate?.();
  };

  if (_insightsCollapsed) {
    return html`
      <div class="disc-insights-strip disc-insights-strip--collapsed" @click=${toggleCollapse}>
        <span style="font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:var(--disc-fg-faint);font-weight:700;">
          ${icons.zap} ${humanDuration(actualMins)} captured · ${taskCount} task${taskCount !== 1 ? "s" : ""} · ${totalEvents} events
        </span>
        <span class="disc-insights-strip__toggle">${icons.chevronDown} Expand</span>
      </div>
    `;
  }

  return html`
    <div class="disc-insights-strip">
      <div class="disc-insights-strip__head">
        <span class="disc-insights-strip__title">${icons.zap} Work Captured Today</span>
        <button class="disc-insights-strip__toggle" @click=${toggleCollapse}>${icons.chevronDown} Collapse</button>
      </div>
      <div class="disc-insights-strip__metrics">
        <div class="disc-insights-metric">
          <div class="disc-insights-metric__val">${humanDuration(actualMins)}</div>
          <div class="disc-insights-metric__lbl">Total captured</div>
        </div>
        <div class="disc-insights-metric">
          <div class="disc-insights-metric__val">${taskCount}</div>
          <div class="disc-insights-metric__lbl">Tasks logged</div>
        </div>
        ${longestMins > 0 ? html`
          <div class="disc-insights-metric">
            <div class="disc-insights-metric__val">${humanDuration(longestMins)}</div>
            <div class="disc-insights-metric__lbl">Longest block</div>
          </div>
        ` : nothing}
        ${totalEvents > 0 ? html`
          <div class="disc-insights-metric">
            <div class="disc-insights-metric__val">${totalEvents}</div>
            <div class="disc-insights-metric__lbl">Auto-events</div>
          </div>
        ` : nothing}
        ${maxSwitches > 1 ? html`
          <div class="disc-insights-metric disc-insights-metric--warn">
            <div class="disc-insights-metric__val">${maxSwitches}×</div>
            <div class="disc-insights-metric__lbl" title="${mostSwitchedLabel}">
              Context switches${mostSwitchedLabel ? html` · <em style="font-style:normal;opacity:0.75;">${mostSwitchedLabel.slice(0, 16)}${mostSwitchedLabel.length > 16 ? "…" : ""}</em>` : nothing}
            </div>
          </div>
        ` : nothing}
      </div>
    </div>
  `;
}

function renderTimeline(ds: DisciplineState, host: AppViewState, client: GatewayBrowserClient): TemplateResult {
  // Zoom mode: standard = whole-day overview at 48px/h, "2hr" = focused window
  // at 240px/h centered on the current 2-hour slot. Both modes ALWAYS render
  // the full 0-23h range so blocks at any time of day are visible — the
  // settings dayStartHour/dayEndHour only control where the window starts in
  // 2hr mode, never clip out hours from the overview.
  const zoom: "standard" | "2hr" = ds.timelineZoom === "2hr" ? "2hr" : "standard";
  const nowM = nowMinutes();
  let startH: number;
  let endH: number;
  let HOUR: number;
  if (zoom === "2hr") {
    // Two-hour window starting at the current hour. Clamps so we always show
    // exactly 2 full hours (e.g. at 23:xx we pin to 22:00–23:59).
    const cur = Math.floor(nowM / 60);
    startH = Math.min(22, Math.max(0, cur));
    endH = startH + 1;
    HOUR = 240;
  } else {
    // Standard: full 24h day. Ignores dayStartHour/dayEndHour so the user can
    // never accidentally hide blocks by tightening their planned-day range.
    startH = 0;
    endH = 23;
    HOUR = 48;
  }
  const hours: number[] = [];
  for (let h = startH; h <= endH; h++) hours.push(h);
  const blocks = applyBlockFilters(ds, todayBlocks(ds));
  const logs = todayLogs(ds);
  const nowOffset = (nowM - startH * 60) * (HOUR / 60);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0); // log timestamps are absolute, anchor to midnight
  const suggestions: DisciplineCategory[] = ["deep-work", "meetings", "break", "admin", "body"];
  const pixelsPerMinute = HOUR / 60;
  const snapMin = 15;
  const setZoom = (next: "standard" | "2hr") => {
    if (ds.timelineZoom === next) return;
    ds.timelineZoom = next;
    host.requestUpdate?.();
  };

  // Day-mode context. The timeline now defaults to showing every enabled
  // block (matches the Blocks view); the user can opt into a strict
  // day-of-week filter for the current session via the toggle below.
  const matched = blocksScheduledToday(ds);
  const totalEnabled = enabledBlockCount(ds);
  const todayOnly = ds.timelinePreviewAllDays === false;
  const dowName = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date().getDay()];
  const togglePreview = () => {
    // tri-state stored on disciplineState: undefined or true → show all,
    // false → filter to today only. Toggle just flips between the two.
    ds.timelinePreviewAllDays = todayOnly ? true : false;
    host.requestUpdate?.();
  };
  let bannerLabel: TemplateResult;
  if (todayOnly) {
    bannerLabel = html`<strong class="disc-daybar__mode">${dowName} only</strong> ${matched.length} of ${totalEnabled} block${totalEnabled === 1 ? "" : "s"} scheduled today`;
  } else {
    bannerLabel = html`<strong class="disc-daybar__mode">All blocks</strong> every enabled block (${totalEnabled} total) — switch to ${dowName} only to filter`;
  }

  return html`
    ${renderInsightsStrip(ds, host)}
    ${renderFilterBar(ds, host)}
    <div class="disc-daybar ${todayOnly ? "disc-daybar--today" : ""}">
      <span class="disc-daybar__label">${bannerLabel}</span>
      ${totalEnabled === 0
        ? html`<span class="disc-daybar__hint">Define a block in the Blocks view ${icons.arrowRight}</span>`
        : html`
            <!-- Zoom mode segmented control -->
            <div class="disc-seg" role="group" aria-label="Timeline zoom">
              <button
                class="disc-seg__btn ${zoom === "standard" ? "is-active" : ""}"
                aria-pressed=${zoom === "standard" ? "true" : "false"}
                @click=${() => setZoom("standard")}
                title="Show the entire 24-hour day"
              >24H</button>
              <button
                class="disc-seg__btn ${zoom === "2hr" ? "is-active" : ""}"
                aria-pressed=${zoom === "2hr" ? "true" : "false"}
                @click=${() => setZoom("2hr")}
                title="Zoom into the current 2-hour window"
              >2H</button>
            </div>
            <button
              class="disc-btn disc-btn--sm ${todayOnly ? "disc-btn--primary" : "disc-btn--ghost"}"
              @click=${togglePreview}
              title=${todayOnly ? "Show every block regardless of day" : "Filter to blocks scheduled today"}
            >${todayOnly ? "All days" : `${dowName} only`}</button>
          `}
    </div>

    <div class="disc-timeline">
      <div class="disc-rail disc-rail__hours">
        ${hours.map((h) => html`<div class="disc-rail__hour" style="height:${HOUR}px">${pad(h)}:00</div>`)}
      </div>
      <div class="disc-rail">
        <div class="disc-rail__slots" style="height:${hours.length * HOUR}px">
          ${hours.map(
            (h) => html`
              <div
                class="disc-rail__slot"
                style="height:${HOUR}px"
                @click=${() => {
                  beginCreate(ds, { startMinute: h * 60, endMinute: h * 60 + 60 });
                  ds.subView = "blocks";
                  host.requestUpdate?.();
                }}
              ></div>
            `,
          )}
          ${blocks.length === 0 ? html`
            <div class="disc-rail__empty">
              <div class="disc-rail__empty-title">No blocks to render</div>
              <div class="disc-rail__empty-body">
                ${ds.blocks.length === 0
                  ? "You haven't defined any blocks yet."
                  : `${ds.blocks.length} blocks defined but the day-of-week filter excluded all of them.`}
              </div>
              <button
                class="disc-btn disc-btn--primary"
                style="font-size:11px; padding:6px 14px;"
                @click=${() => {
                  if (ds.blocks.length === 0) {
                    beginCreate(ds);
                    ds.subView = "blocks";
                  } else {
                    // We're in "Today only" mode and got nothing — flip to all.
                    ds.timelinePreviewAllDays = true;
                  }
                  host.requestUpdate?.();
                }}
              >${ds.blocks.length === 0 ? "Create your first block" : "Show all blocks"}</button>
            </div>
          ` : nothing}
          ${blocks.map((b) => {
            const effStart = effectiveStart(ds, b);
            const top = (effStart - startH * 60) * pixelsPerMinute;
            const height = (b.endMinute - effStart) * pixelsPerMinute;
            if (top + height < 0 || top > hours.length * HOUR) return nothing;
            const done = isBlockDoneToday(ds, b.id);
            const color = b.color ?? (b.nonNegotiable ? "#ff8a8a" : CATEGORY_COLORS[b.category]);
            const isCurrent = !done && nowM >= effStart && nowM < b.endMinute;
            const progPct = isCurrent
              ? Math.round(((nowM - effStart) / Math.max(1, b.endMinute - effStart)) * 100)
              : 0;
            const routine = routineProgressFor(ds, b);
            const spacious = height >= 60;
            const priority = blockPriority(ds, b);
            const priorityClass = ds.settings.priorityHighlight && (priority === "critical" || priority === "high")
              ? `has-pri-${priority}`
              : "";
            const linkCtx = blockLinkContext(ds, b);
            const today_local = todayIso();
            const nowM_local = nowMinutes();
            const isAborted = ds.logs.some(
              (l) => l.blockId === b.id && l.source === "abort" &&
                new Date(l.startMs).toISOString().slice(0, 10) === today_local,
            );
            const isOverdue = !done && !isCurrent && nowM_local > b.endMinute;
            const minsToStart = b.startMinute - nowM_local;
            const showCountdown = !done && !isCurrent && !isOverdue && minsToStart > 0 && minsToStart <= 120;
            const countdownStr = minsToStart >= 60
              ? `${Math.floor(minsToStart / 60)}h ${minsToStart % 60}m`
              : `${minsToStart}m`;
            const counts = ds.autoLogCounts.find((c) => c.blockId === b.id);
            if (counts && counts.total > 0) {
              const prev = _prevAutoLogTotals.get(b.id) ?? 0;
              if (counts.total > prev) {
                const delta = counts.total - prev;
                addReflectionEvent(
                  b.id,
                  `⚡ +${delta} auto-log event${delta > 1 ? "s" : ""}`,
                  "⚡",
                  color,
                );
                _prevAutoLogTotals.set(b.id, counts.total);
              }
            }
            return html`
              <div
                class="disc-rail__block disc-drag-handle
                  ${isCurrent ? "disc-rail__block--current" : ""}
                  ${done ? "disc-rail__block--done disc-rail__block--completed-vis" : ""}
                  ${isOverdue && !done ? "disc-rail__block--overdue" : ""}
                  ${!done && !isCurrent && !isOverdue ? "disc-rail__block--incomplete" : ""}
                  ${priorityClass}"
                data-block-id=${b.id}
                style="
                  top:${Math.max(0, top)}px;
                  height:${Math.max(22, height)}px;
                  background: linear-gradient(135deg, color-mix(in srgb, ${color} 18%, transparent), color-mix(in srgb, ${color} 6%, transparent));
                  border: 1px solid color-mix(in srgb, ${color} 50%, transparent);
                  color: ${color};
                  --bl-color: ${color};
                "
                @pointerdown=${(e: PointerEvent) =>
                  handleBlockPointerDown(e, ds, host, client, b, pixelsPerMinute, snapMin, startH)}
                @dragenter=${(e: DragEvent) => handleBlockDragEnter(e)}
                @dragover=${(e: DragEvent) => handleBlockDragOver(e)}
                @dragleave=${(e: DragEvent) => handleBlockDragLeave(e)}
                @drop=${(e: DragEvent) => handleBlockDrop(e, ds, host, client, b)}
              >
                <div class="disc-block-actions">
                  <button
                    class="disc-icon-btn ${done ? "disc-icon-btn--done" : ""}"
                    title=${done ? "Mark incomplete" : "Mark complete"}
                    @pointerdown=${(e: Event) => e.stopPropagation()}
                    @click=${async (e: Event) => {
                      e.stopPropagation();
                      if (done) await unmarkBlockDone(ds, client, b.id);
                      else await markBlockDone(ds, client, b.id);
                      host.requestUpdate?.();
                    }}
                  >${done ? icons.check : icons.circle}</button>
                </div>
                ${done
                  ? html`<div class="disc-block-ribbon disc-block-ribbon--done">DONE ${icons.check}</div>`
                  : isAborted
                    ? html`<div class="disc-block-ribbon disc-block-ribbon--aborted">ABORTED</div>`
                    : nothing}
                <div style="display:flex;align-items:center;gap:6px;padding-right:26px;flex-wrap:wrap;">
                  <div class="disc-rail__block-label" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;">${b.label}</div>
                  ${b.nonNegotiable ? html`<span class="disc-nn-badge" style="font-size:8px;padding:1px 5px;">NN</span>` : nothing}
                  ${priority !== "normal" ? renderPriorityBadge(priority) : nothing}
                  ${routine.total > 0
                    ? html`<span class="disc-routine__progress">${routine.done}/${routine.total}</span>`
                    : nothing}
                </div>
                <div class="disc-rail__block-time">
                  ${minsToHHMM(effStart)}–${minsToHHMM(b.endMinute)} · ${humanDuration(b.endMinute - effStart)}
                  ${done && ds.blockDone[b.id]?.savedMin
                    ? html` · <span style="color:#10B981;font-weight:700;">+${ds.blockDone[b.id].savedMin}m saved</span>`
                    : nothing}
                </div>
                ${showCountdown
                  ? html`<div style="margin-top:3px;"><span class="disc-block-countdown">${icons.clock} in ${countdownStr}</span></div>`
                  : nothing}
                ${spacious && (linkCtx.taskTitle || linkCtx.projectName)
                  ? html`<div style="margin-top:4px;font-size:10px;color:${color};opacity:0.8;display:flex;gap:4px;align-items:center;">
                      ${linkCtx.projectName
                        ? html`<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${linkCtx.projectColor ?? color};"></span>${linkCtx.projectName}`
                        : nothing}
                      ${linkCtx.taskTitle ? html`<span style="opacity:0.7;">${icons.arrowRight} ${linkCtx.taskTitle}</span>` : nothing}
                    </div>`
                  : nothing}
                ${spacious && isCurrent ? renderRoutineChecklist(ds, host, client, b, color) : nothing}
                ${isCurrent ? html`<div class="disc-rail__block-progress" style="width:${progPct}%"></div>` : nothing}
                ${renderBlockEventDots(ds, b, color)}
                ${renderReflectionCards(b.id, color)}
              </div>
            `;
          })}
          ${logs.map((l) => {
            const startMin = (l.startMs - dayStart.getTime()) / 60000;
            const endMin = ((l.endMs ?? l.startMs + 5 * 60 * 1000) - dayStart.getTime()) / 60000;
            const top = startMin * (HOUR / 60);
            const h = Math.max(4, (endMin - startMin) * (HOUR / 60));
            if (top + h < 0 || top > hours.length * HOUR) return nothing;
            return html`<div class="disc-rail__log" style="top:${top}px; height:${h}px;" title="${l.label} · ${l.source}"></div>`;
          })}
          ${nowOffset >= 0 && nowOffset <= hours.length * HOUR
            ? html`<div class="disc-rail__now" style="top:${nowOffset}px" data-time="${minsToHHMM(nowM)}"></div>`
            : nothing}
        </div>
      </div>

      <!-- Inline kanban panel — full board with draggable cards so tasks
           can be dropped directly onto a block in the timeline rail next
           to it. View-mode toggle mirrors the modal's modes. -->
      ${renderInlineTaskKanban(ds, host, client)}
    </div>

    <!-- Utility row below the split. Each card stays self-contained so the
         layout survives narrow viewports without crushing the kanban. -->
    <div class="disc-tl-utilities">
      <div class="disc-panel" style="margin:0;">
        <h3>Today</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
          <div>
            <div style="font-size:22px;font-weight:700;color:var(--g-primary);">${blocks.length}</div>
            <div style="font-size:10px;color: var(--disc-fg-faint);letter-spacing:.14em;text-transform:uppercase;">Blocks</div>
          </div>
          <div>
            <div style="font-size:22px;font-weight:700;color:var(--g-primary);">${logs.length}</div>
            <div style="font-size:10px;color: var(--disc-fg-faint);letter-spacing:.14em;text-transform:uppercase;">Logs</div>
          </div>
        </div>
        ${ds.timeSavedMin > 0 || Object.keys(ds.blockStartOverride).length > 0
          ? html`
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:0;padding:8px 10px;border-radius:8px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.25);">
                <div>
                  <div style="font-size:11px;color:#10B981;font-weight:700;letter-spacing:.08em;text-transform:uppercase;">
                    ${icons.zap} ${humanDuration(ds.timeSavedMin)} banked today
                  </div>
                  <div style="font-size:10px;color:#6a8d7a;margin-top:2px;">
                    Finishing early auto-moves the next block up
                  </div>
                </div>
                <button
                  class="disc-btn disc-btn--ghost"
                  style="font-size:10px;padding:5px 9px;"
                  title="Reset today's early-finish shifts"
                  @click=${async () => { await resetBlockOverrides(ds, client); host.requestUpdate?.(); }}
                >
                  Reset
                </button>
              </div>
            `
          : nothing}
      </div>

      <!-- Quick probe card -->
      <div class="disc-panel" style="margin:0;">
        <h3>Quick probe</h3>
        <input
          class="disc-input"
          placeholder="what are you on right now?"
          .value=${ds.activeProbe.draftLabel}
          @input=${(e: Event) => { ds.activeProbe.draftLabel = (e.target as HTMLInputElement).value; }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" && ds.activeProbe.draftLabel.trim()) {
              void quickLog(ds, client, {
                label: ds.activeProbe.draftLabel.trim(),
                category: ds.activeProbe.draftCategory,
              });
              ds.activeProbe.draftLabel = "";
              host.requestUpdate?.();
            }
          }}
        />
        <div class="disc-chips" style="margin-top:10px;">
          ${suggestions.map((c) => html`
            <div
              class="disc-chip ${ds.activeProbe.draftCategory === c ? "disc-chip--active" : ""}"
              style="--chip-color:${CATEGORY_COLORS[c]}"
              @click=${() => { ds.activeProbe.draftCategory = c; host.requestUpdate?.(); }}
            >
              <span class="disc-chip__dot"></span>${CATEGORY_LABELS[c]}
            </div>
          `)}
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <button
            class="disc-btn disc-btn--primary"
            style="flex:1;"
            @click=${() => {
              const label = ds.activeProbe.draftLabel.trim();
              if (!label) return;
              void quickLog(ds, client, { label, category: ds.activeProbe.draftCategory });
              ds.activeProbe.draftLabel = "";
              host.requestUpdate?.();
            }}
          >
            Log probe
          </button>
          <button
            class="disc-btn"
            @click=${async () => {
              const label = ds.activeProbe.draftLabel.trim();
              if (!label) return;
              await startLog(ds, client, { label, category: ds.activeProbe.draftCategory, source: "manual" });
              ds.activeProbe.draftLabel = "";
              host.requestUpdate?.();
            }}
          >
            Start timer
          </button>
        </div>

        ${ds.activeProbe.id
          ? html`
              <div class="disc-probe__active">
                <div>
                  <div class="disc-probe__active-label">${icons.circle} Running</div>
                  <div style="font-size:10px;color: var(--disc-fg-faint);margin-top:2px;letter-spacing:.04em;">
                    ${Math.max(0, Math.round(((Date.now() - (ds.activeProbe.startedAt ?? Date.now())) / 60000)))}m elapsed
                  </div>
                </div>
                <button class="disc-btn disc-btn--danger" @click=${() => { void stopLog(ds, client, ds.activeProbe.id!); host.requestUpdate?.(); }}>
                  Stop
                </button>
              </div>
            `
          : nothing}
      </div>

      <!-- Auto-log event summary card -->
      ${renderAutoLogSummaryCard(ds, host, client)}

      <!-- Active routines + AI panels — each rendered standalone so the
           utilities row flows naturally on narrow screens. The legacy
           "Drag tasks onto blocks" chip strip is gone — its job is now
           done by the inline kanban above. -->
      ${renderActiveRoutinesPanel(ds, host, client, blocks)}
      ${renderAiPanel(ds, host, client)}
    </div>
  `;
}

function renderAutoLogSummaryCard(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const totalEvents = ds.autoLogCounts.reduce((s, c) => s + c.total, 0);
  const blockCount = ds.autoLogCounts.filter((c) => c.total > 0 && c.blockId).length;
  return html`
    <div class="disc-probe" style="margin-top:10px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <h3 style="margin:0;">Auto-log today</h3>
        <button
          class="disc-btn"
          style="font-size:10px;padding:2px 8px;"
          @click=${async () => {
            await loadAutoLogCounts(ds, client);
            host.requestUpdate?.();
          }}
        >
          ${icons.refresh} Refresh
        </button>
      </div>
      ${totalEvents === 0
        ? html`<div style="font-size:11px;color:var(--disc-fg-faint);text-align:center;padding:6px 0;">No events logged yet today</div>`
        : html`
            <div style="display:flex;gap:12px;align-items:center;">
              <div style="font-size:22px;font-weight:700;color:var(--disc-accent);display:flex;align-items:center;gap:2px;">${icons.zap}${totalEvents}</div>
              <div style="font-size:11px;color:var(--disc-fg-dim);">
                events across ${blockCount} block${blockCount !== 1 ? "s" : ""}
              </div>
            </div>
            <div style="margin-top:8px;display:flex;flex-direction:column;gap:3px;">
              ${ds.autoLogCounts
                .filter((c) => c.total > 0)
                .sort((a, b) => b.total - a.total)
                .slice(0, 5)
                .map((c) => {
                  const block = ds.blocks.find((b) => b.id === c.blockId);
                  const label = block?.label ?? (c.blockId ? "Unknown block" : "Unattributed");
                  const pct = Math.round((c.total / totalEvents) * 100);
                  return html`
                    <div style="display:flex;align-items:center;gap:6px;">
                      <div style="font-size:10px;color:var(--disc-fg-dim);width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${label}</div>
                      <div style="flex:1;height:4px;border-radius:2px;background:var(--glass-stroke-strong);overflow:hidden;">
                        <div style="height:100%;width:${pct}%;background:var(--disc-accent);border-radius:2px;"></div>
                      </div>
                      <div style="font-size:10px;color:var(--disc-fg-faint);width:24px;text-align:right;">${c.total}</div>
                    </div>
                  `;
                })}
            </div>
          `}
    </div>
  `;
}

function renderActiveRoutinesPanel(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
  blocks: DisciplineBlock[],
): TemplateResult {
  const nowM = nowMinutes();
  const now = blocks.find((b) => nowM >= b.startMinute && nowM < b.endMinute) ?? null;
  const upcoming = blocks.filter((b) => b.startMinute > nowM).sort((a, b) => a.startMinute - b.startMinute);
  const nextFew = [now, ...upcoming].filter((b): b is DisciplineBlock => !!b && (b.routineItems?.length ?? 0) > 0 || !!b?.nonNegotiable);
  const withItems = nextFew.slice(0, 3);

  const nonNeg = blocks.filter((b) => b.nonNegotiable);
  if (withItems.length === 0 && nonNeg.length === 0) return html``;

  return html`
    <div class="disc-active-routine">
      <h3>Today's routine</h3>
      ${nonNeg.length > 0
        ? html`
            <div style="margin-bottom:10px;padding:8px 10px;border-radius:8px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);">
              <div style="font-size:10px;letter-spacing:0.14em;color:#ff8a8a;text-transform:uppercase;font-weight:700;margin-bottom:4px;">
                Non-negotiable · ${nonNeg.length}
              </div>
              <div style="font-size:11px;color: var(--disc-fg-dim);">
                ${nonNeg.map((b) => b.label).join(" · ")}
              </div>
            </div>
          `
        : nothing}
      ${withItems.map((b) => {
        const color = b.color ?? CATEGORY_COLORS[b.category];
        const isNow = nowM >= b.startMinute && nowM < b.endMinute;
        const routine = routineProgressFor(ds, b);
        return html`
          <div class="disc-active-routine__block" style="--ar-color:${color};">
            <div class="disc-active-routine__head">
              <div>
                <div class="disc-active-routine__name">${b.label}</div>
                <div style="font-size:10px;color: var(--disc-fg-faint);letter-spacing:.04em;">
                  ${isNow ? "Now" : `at ${minsToHHMM(b.startMinute)}`}${b.nonNegotiable ? " · non-negotiable" : ""}
                </div>
              </div>
              ${routine.total > 0
                ? html`<div style="font-size:11px;color:${color};font-weight:700;font-variant-numeric:tabular-nums;">
                    ${routine.done}/${routine.total}
                  </div>`
                : nothing}
            </div>
            ${renderRoutineChecklist(ds, host, client, b, color)}
          </div>
        `;
      })}
    </div>
  `;
}

function renderCategoryChips(
  ds: DisciplineState,
  host: AppViewState,
  current: DisciplineCategory,
  onPick: (c: DisciplineCategory) => void,
): TemplateResult {
  return html`
    <div class="disc-chips">
      ${DISCIPLINE_CATEGORIES.map((c) => html`
        <div
          class="disc-chip ${current === c ? "disc-chip--active" : ""}"
          style="--chip-color:${CATEGORY_COLORS[c]}"
          @click=${() => { onPick(c); host.requestUpdate?.(); }}
        >
          <span class="disc-chip__dot"></span>${CATEGORY_LABELS[c]}
        </div>
      `)}
    </div>
  `;
}

function renderBlockEditor(ds: DisciplineState, host: AppViewState, client: GatewayBrowserClient): TemplateResult {
  if (!ds.blockDraft) return html``;
  const draft = ds.blockDraft;
  const isEdit = !!draft.id;
  const duration = draft.endMinute - draft.startMinute;

  const save = async () => {
    const label = draft.label.trim();
    if (!label) {
      ds.modal = {
        kind: "confirm",
        title: "Label required",
        body: "Give this block a short label so you recognize it in the timeline.",
        confirmLabel: "OK",
        onConfirm: () => { ds.modal = null; host.requestUpdate?.(); },
      };
      host.requestUpdate?.();
      return;
    }
    if (draft.endMinute <= draft.startMinute) {
      draft.endMinute = draft.startMinute + 30;
    }
    // Send the full draft so toggles like nonNegotiable, color overrides,
    // routine items, and project/task links actually persist. Previously
    // only a subset of fields was sent, which is why the Non-negotiable
    // checkbox visibly toggled in the editor but never saved on the block.
    const payload = {
      label,
      category: draft.category,
      intent: draft.intent,
      startMinute: draft.startMinute,
      endMinute: draft.endMinute,
      days: draft.days,
      hard: draft.hard,
      enabled: draft.enabled,
      nonNegotiable: !!draft.nonNegotiable,
      projectId: draft.projectId,
      taskId: draft.taskId,
      routineItems: draft.routineItems ?? [],
    };
    if (isEdit && draft.id) {
      await updateBlock(ds, client, draft.id, payload);
    } else {
      await createBlock(ds, client, payload);
    }
    cancelBlockEditor(ds);
    host.requestUpdate?.();
  };

  return html`
    <div class="disc-panel" data-learn-id="discipline-block-editor" style="max-width:680px;">
      <h3>${isEdit ? "Edit block" : "New block"}</h3>

      <div style="margin-bottom:14px;">
        <label class="disc-label">Label</label>
        <input
          class="disc-input"
          data-learn-id="discipline-block-label"
          placeholder="e.g. Morning deep work"
          .value=${draft.label}
          autofocus
          @input=${(e: Event) => { draft.label = (e.target as HTMLInputElement).value; host.requestUpdate?.(); }}
          @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void save(); }}
        />
      </div>

      <div style="margin-bottom:14px;">
        <label class="disc-label">Category</label>
        ${renderCategoryChips(ds, host, draft.category, (c) => { draft.category = c; })}
      </div>

      <div style="margin-bottom:14px;">
        <label class="disc-label">Intent · why does this block matter?</label>
        <input
          class="disc-input"
          placeholder="ship the hardest thing first"
          .value=${draft.intent}
          @input=${(e: Event) => { draft.intent = (e.target as HTMLInputElement).value; host.requestUpdate?.(); }}
        />
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px;">
        <div>
          <label class="disc-label">Start</label>
          <input
            type="time" class="disc-input"
            .value=${minsToHHMM(draft.startMinute)}
            @change=${(e: Event) => {
              const newStart = hhmmToMins((e.target as HTMLInputElement).value);
              const prevDur = draft.endMinute - draft.startMinute;
              draft.startMinute = newStart;
              draft.endMinute = newStart + prevDur;
              host.requestUpdate?.();
            }}
          />
        </div>
        <div>
          <label class="disc-label">End</label>
          <input
            type="time" class="disc-input"
            .value=${minsToHHMM(draft.endMinute)}
            @change=${(e: Event) => { draft.endMinute = hhmmToMins((e.target as HTMLInputElement).value); host.requestUpdate?.(); }}
          />
        </div>
        <div>
          <label class="disc-label">Duration (${humanDuration(duration)})</label>
          <div class="disc-duration-row">
            ${DURATION_PRESETS.map((p) => html`
              <div
                class="disc-duration ${duration === p.mins ? "disc-chip--active" : ""}"
                style="--chip-color:${CATEGORY_COLORS[draft.category]}"
                @click=${() => { draft.endMinute = draft.startMinute + p.mins; host.requestUpdate?.(); }}
              >
                ${p.label}
              </div>
            `)}
          </div>
        </div>
      </div>

      <div style="margin-bottom:16px;">
        <label class="disc-label">Repeat on</label>
        <div class="disc-days" data-learn-id="discipline-block-days">
          ${DAY_LETTERS.map((d, i) => html`
            <div
              class="disc-day ${draft.days.includes(i) ? "disc-day--active" : ""}"
              @click=${() => {
                draft.days = draft.days.includes(i)
                  ? draft.days.filter((x) => x !== i)
                  : [...draft.days, i].sort();
                host.requestUpdate?.();
              }}
              title="${DAYS[i]}"
            >
              ${d}
            </div>
          `)}
        </div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <button class="disc-btn disc-btn--ghost" style="font-size:10px;padding:6px 10px;" @click=${() => { draft.days = [1,2,3,4,5]; host.requestUpdate?.(); }}>Weekdays</button>
          <button class="disc-btn disc-btn--ghost" style="font-size:10px;padding:6px 10px;" @click=${() => { draft.days = [0,6]; host.requestUpdate?.(); }}>Weekends</button>
          <button class="disc-btn disc-btn--ghost" style="font-size:10px;padding:6px 10px;" @click=${() => { draft.days = [0,1,2,3,4,5,6]; host.requestUpdate?.(); }}>Every day</button>
        </div>
      </div>

      <div data-learn-id="discipline-block-flags" style="display:flex;gap:18px;margin-bottom:18px;flex-wrap:wrap;">
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color: var(--disc-fg-dim);cursor:pointer;">
          <input type="checkbox" .checked=${draft.hard}
            @change=${(e: Event) => { draft.hard = (e.target as HTMLInputElement).checked; host.requestUpdate?.(); }}
          />
          <span><strong style="color:var(--g-primary);">Hard lock</strong> — notifications blocked</span>
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color: var(--disc-fg-dim);cursor:pointer;">
          <input type="checkbox" .checked=${draft.nonNegotiable}
            @change=${(e: Event) => { draft.nonNegotiable = (e.target as HTMLInputElement).checked; host.requestUpdate?.(); }}
          />
          <span><strong style="color:#ff8a8a;">Non-negotiable</strong> — missing this breaks streak</span>
        </label>
        <label style="display:flex;align-items:center;gap:8px;font-size:12px;color: var(--disc-fg-dim);cursor:pointer;">
          <input type="checkbox" .checked=${draft.enabled}
            @change=${(e: Event) => { draft.enabled = (e.target as HTMLInputElement).checked; host.requestUpdate?.(); }}
          />
          Enabled
        </label>
      </div>

      ${renderRoutineEditor(draft, host)}
      ${renderProjectTaskPicker(ds, draft, host, client)}

      <div style="display:flex;gap:8px;">
        <button class="disc-btn disc-btn--primary" data-learn-id="discipline-block-save" @click=${save}>${isEdit ? "Save changes" : "Create block"}</button>
        <button class="disc-btn" data-learn-id="discipline-block-cancel" @click=${() => { cancelBlockEditor(ds); host.requestUpdate?.(); }}>Cancel</button>
        ${isEdit && draft.id
          ? html`
              <button
                class="disc-btn disc-btn--danger"
                style="margin-left:auto"
                @click=${() => {
                  const id = draft.id!;
                  const label = draft.label;
                  ds.modal = {
                    kind: "confirm",
                    title: `Delete "${label}"?`,
                    body: "This removes the block permanently. Existing logs are kept.",
                    confirmLabel: "Delete",
                    dangerous: true,
                    onConfirm: async () => {
                      ds.modal = null;
                      await deleteBlock(ds, client, id);
                      cancelBlockEditor(ds);
                      host.requestUpdate?.();
                    },
                  };
                  host.requestUpdate?.();
                }}
              >
                Delete
              </button>
            `
          : nothing}
      </div>
    </div>
  `;
}

function renderRoutineEditor(draft: BlockDraft, host: AppViewState): TemplateResult {
  const addItem = () => {
    draft.routineItems = [
      ...draft.routineItems,
      { id: newRoutineItemId(), label: "", order: draft.routineItems.length },
    ];
    host.requestUpdate?.();
  };
  return html`
    <div data-learn-id="discipline-routine-editor" style="margin-bottom:18px;">
      <label class="disc-label">Daily routine · shows up inside this block each day it runs</label>
      ${draft.routineItems.length === 0
        ? html`<div style="font-size:12px;color: var(--disc-fg-mute);margin-bottom:8px;font-style:italic;">
            No items yet — great for checklists like "phone in drawer", "warm-up", "journal 5 min".
          </div>`
        : nothing}
      ${draft.routineItems.map((item, idx) => html`
        <div class="disc-routine-edit">
          <span class="disc-routine-edit__handle" title="Drag to reorder (coming soon)">≡</span>
          <input
            class="disc-input disc-routine-edit__input"
            data-learn-id="discipline-routine-input"
            placeholder="e.g. ship one thing to prod"
            .value=${item.label}
            @input=${(e: Event) => {
              item.label = (e.target as HTMLInputElement).value;
              host.requestUpdate?.();
            }}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") { e.preventDefault(); addItem(); }
            }}
          />
          <button
            class="disc-routine-edit__remove"
            title="Remove"
            @click=${() => {
              draft.routineItems = draft.routineItems
                .filter((x) => x.id !== item.id)
                .map((x, i) => ({ ...x, order: i }));
              host.requestUpdate?.();
            }}
          >×</button>
        </div>
      `)}
      <button class="disc-btn disc-btn--ghost" data-learn-id="discipline-routine-add" style="font-size:11px;padding:7px 12px;" @click=${addItem}>
        + Add routine item
      </button>
    </div>
  `;
}

function renderProjectTaskPicker(
  ds: DisciplineState,
  draft: BlockDraft,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  if (!ds.kanbanLoaded) {
    void loadKanbanLinks(ds, client).then(() => host.requestUpdate?.());
  }
  const projects = ds.kanbanProjects;
  const tasks = draft.projectId
    ? ds.kanbanTasks.filter((t) => t.projectId === draft.projectId)
    : ds.kanbanTasks.slice(0, 30);
  return html`
    <div style="margin-bottom:18px;">
      <label class="disc-label">Link to project / task · optional</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div>
          <select
            class="disc-select"
            .value=${draft.projectId ?? ""}
            @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              draft.projectId = v || undefined;
              if (!v) draft.taskId = undefined;
              else if (draft.taskId && !ds.kanbanTasks.some((t) => t.id === draft.taskId && t.projectId === v)) {
                draft.taskId = undefined;
              }
              host.requestUpdate?.();
            }}
          >
            <option value="">— no project —</option>
            ${projects.map((p) => html`<option value=${p.id}>${p.name}</option>`)}
          </select>
        </div>
        <div>
          <select
            class="disc-select"
            .value=${draft.taskId ?? ""}
            ?disabled=${!draft.projectId && tasks.length === 0}
            @change=${(e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              draft.taskId = v || undefined;
              if (v && !draft.projectId) {
                const t = ds.kanbanTasks.find((x) => x.id === v);
                if (t?.projectId) draft.projectId = t.projectId;
              }
              host.requestUpdate?.();
            }}
          >
            <option value="">— no task —</option>
            ${tasks.map((t) => html`<option value=${t.id}>${t.title}</option>`)}
          </select>
        </div>
      </div>
      ${projects.length === 0 && !ds.kanbanLoaded
        ? html`<div style="font-size:11px;color: var(--disc-fg-mute);margin-top:6px;">Loading projects…</div>`
        : projects.length === 0
          ? html`<div style="font-size:11px;color: var(--disc-fg-mute);margin-top:6px;">No projects yet — create one in the Projects tab.</div>`
          : nothing}
    </div>
  `;
}

function renderEmptyState(ds: DisciplineState, host: AppViewState, client: GatewayBrowserClient): TemplateResult {
  return html`
    <div class="disc-empty" data-learn-id="discipline-empty">
      <h2 class="disc-empty__title">Build the day you deserve.</h2>
      <p class="disc-empty__sub">
        Pick a starter template to fill the day with sensible blocks — you can tweak anything after.
        Or create your own from scratch.
      </p>
      <div class="disc-presets" data-learn-id="discipline-presets">
        ${DISCIPLINE_PRESETS.map((p) => html`
          <div
            class="disc-preset"
            @click=${() => {
              ds.modal = {
                kind: "confirm",
                title: `Apply "${p.name}"?`,
                body: `${p.blocks.length} blocks will be added to your schedule. You can edit or remove any of them after.`,
                confirmLabel: "Apply preset",
                onConfirm: async () => {
                  ds.modal = null;
                  host.requestUpdate?.();
                  await applyPreset(ds, client, p.id);
                  host.requestUpdate?.();
                },
              };
              host.requestUpdate?.();
            }}
          >
            <div class="disc-preset__name">${p.name}</div>
            <div class="disc-preset__tag">${p.tagline}</div>
            <div class="disc-preset__count">${p.blocks.length} blocks ${icons.arrowRight}</div>
          </div>
        `)}
      </div>
      <div style="margin-top:24px;">
        <button
          class="disc-btn disc-btn--primary"
          data-learn-id="discipline-create-block"
          @click=${() => { beginCreate(ds); host.requestUpdate?.(); }}
        >
          + Create from scratch
        </button>
      </div>
    </div>
  `;
}

function completionTimeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function renderBlockCompletionItems(ds: DisciplineState, blockId: string): TemplateResult {
  const items = (ds.blockCompletionItems ?? []).filter((c) => c.blockId === blockId);
  if (items.length === 0) return html`${nothing}`;
  return html`
    <div class="disc-completions">
      ${items.slice(0, 6).map((c) => {
        const icon = c.kind === "kanban:task_done" ? "✓" : "⚡";
        const sourceLabel = c.kind === "kanban:task_done" ? "Kanban" : "Agent";
        return html`
          <div class="disc-completion-item">
            <span class="disc-completion-item__icon" style="color:${c.kind === "kanban:task_done" ? "#10B981" : "#8B5CF6"}">${icon}</span>
            <span class="disc-completion-item__title" title="${c.title}">${sourceLabel}: ${c.title}</span>
            <span class="disc-completion-item__time">${completionTimeAgo(c.completedAt)}</span>
          </div>
        `;
      })}
    </div>
  `;
}

const INSIGHT_TONE_COLOR: Record<string, string> = {
  info: "var(--disc-fg-dim)",
  warn: "#F59E0B",
  urgent: "#ef4444",
  success: "#10B981",
};

/** Live elapsed minutes for the block IF it's the currently-active one, else null. */
function blockElapsedMin(ds: DisciplineState, b: DisciplineBlock): number | null {
  const active = currentBlock(ds);
  if (!active || active.id !== b.id) return null;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const start = effectiveStart(ds, b);
  return Math.max(0, nowMin - start);
}

/**
 * Proactive insight strip for a block card: contextual headline computed from
 * live business data, a one-tap suggested-action chip, and (for the active
 * block) a live elapsed-time pill. Renders nothing if no insight is loaded.
 */
function renderBlockInsight(ds: DisciplineState, b: DisciplineBlock): TemplateResult {
  const insight: DisciplineInsight | undefined = ds.insights?.[b.id];
  const elapsed = blockElapsedMin(ds, b);
  if (!insight && elapsed == null) return html`${nothing}`;
  const toneColor = insight ? INSIGHT_TONE_COLOR[insight.tone] ?? INSIGHT_TONE_COLOR.info : INSIGHT_TONE_COLOR.info;
  return html`
    <div class="disc-insight" style="border-left-color:${toneColor};">
      ${elapsed != null
        ? html`<div class="disc-insight__elapsed">${icons.play} ${elapsed >= 60 ? `${Math.floor(elapsed / 60)}h ${elapsed % 60}m` : `${elapsed}m`} elapsed</div>`
        : nothing}
      ${insight
        ? html`
            <div class="disc-insight__headline" style="color:${toneColor};">${insight.headline}</div>
            <div class="disc-insight__row">
              <span class="disc-insight__chip" style="border-color:${toneColor};color:${toneColor};">${icons.arrowRight} ${insight.suggestedAction}</span>
              ${(insight.references ?? []).slice(0, 3).map(
                (r) => html`<span class="disc-insight__ref" title="${r.kind}">${r.label}</span>`,
              )}
            </div>
          `
        : nothing}
    </div>
  `;
}

function renderBlocksBoardMode(ds: DisciplineState, host: AppViewState, client: GatewayBrowserClient, filteredBlocks: DisciplineBlock[]): TemplateResult {
  return html`
    <div class="disc-block-grid">
      ${filteredBlocks.map((b) => {
        const color = b.color ?? CATEGORY_COLORS[b.category];
        const days = b.oneOffDate
          ? b.oneOffDate
          : b.days.length === 7
            ? "Every day"
            : b.days.length === 5 && [1,2,3,4,5].every((d) => b.days.includes(d))
              ? "Weekdays"
              : b.days.length === 2 && b.days.includes(0) && b.days.includes(6)
                ? "Weekends"
                : b.days.map((i) => DAY_LETTERS[i]).join(" ");
        const routine = routineProgressFor(ds, b);
        const priority = blockPriority(ds, b);
        return html`
          <div
            class="disc-block-card ${b.enabled ? "" : "disc-block-card--disabled"}"
            style="--card-color:${color}"
            @dragenter=${(e: DragEvent) => handleBlockDragEnter(e)}
            @dragover=${(e: DragEvent) => handleBlockDragOver(e)}
            @dragleave=${(e: DragEvent) => handleBlockDragLeave(e)}
            @drop=${(e: DragEvent) => handleBlockDrop(e, ds, host, client, b)}
          >
            <div style="position:absolute;top:12px;right:14px;display:flex;gap:4px;align-items:center;">
              ${priority !== "normal" ? renderPriorityBadge(priority) : nothing}
              ${b.nonNegotiable ? html`<span class="disc-nn-badge">NN</span>` : nothing}
              ${b.hard ? html`<div class="disc-block-card__badge" style="position:static;">HARD</div>` : nothing}
            </div>
            <div class="disc-block-card__label" style="padding-right:${b.hard || b.nonNegotiable ? "70px" : "0"};">${b.label}</div>
            <div class="disc-block-card__meta">
              <span>${minsToHHMM(b.startMinute)}–${minsToHHMM(b.endMinute)}</span>
              <span class="disc-block-card__meta-dot">·</span>
              <span>${humanDuration(b.endMinute - b.startMinute)}</span>
              <span class="disc-block-card__meta-dot">·</span>
              <span style="color:${color}">${CATEGORY_LABELS[b.category]}</span>
              <span class="disc-block-card__meta-dot">·</span>
              <span>${days}</span>
              ${routine.total > 0
                ? html`
                    <span class="disc-block-card__meta-dot">·</span>
                    <span title="Routine items today">${icons.check} ${routine.done}/${routine.total}</span>
                  `
                : nothing}
              ${(() => {
                const c = ds.autoLogCounts.find((x) => x.blockId === b.id);
                return c && c.total > 0
                  ? html`<span class="disc-block-card__meta-dot">·</span>
                          <span class="disc-autolog-badge" title="${c.total} auto-logged events today">${icons.zap} ${c.total}</span>`
                  : nothing;
              })()}
            </div>
            ${renderBlockInsight(ds, b)}
            ${b.intent ? html`<p class="disc-block-card__intent">${b.intent}</p>` : nothing}
            ${renderLinkPills(ds, b)}
            ${b.routineItems.length > 0
              ? html`
                  <div style="margin-top:10px;padding-top:10px;border-top:1px solid color-mix(in srgb, var(--g-primary) 8%, transparent);">
                    ${renderRoutineChecklist(ds, host, client, b, color)}
                  </div>
                `
              : nothing}
            ${renderBlockCompletionItems(ds, b.id)}
            <!-- AI start options -->
            ${b.enabled ? html`
              <div class="disc-block-ai-actions">
                <button
                  class="disc-btn disc-btn-ai disc-btn-ai--start"
                  title="Start logging this block now"
                  @click=${async (e: Event) => {
                    e.stopPropagation();
                    await startLog(ds, client, { label: b.label, category: b.category, blockId: b.id });
                    host.requestUpdate?.();
                  }}
                >${icons.play} Start</button>
                <button
                  class="disc-btn disc-btn-ai disc-btn-ai--today"
                  title="Reschedule to start right now (keeps duration)"
                  @click=${async (e: Event) => {
                    e.stopPropagation();
                    const nowM = nowMinutes();
                    const dur = Math.max(5, b.endMinute - b.startMinute);
                    await updateBlock(ds, client, b.id, { startMinute: nowM, endMinute: nowM + dur });
                    host.requestUpdate?.();
                  }}
                >${icons.clock} Start today</button>
                <button
                  class="disc-btn disc-btn-ai disc-btn-ai--blocks"
                  title="Split into pomodoro blocks starting now"
                  @click=${(e: Event) => {
                    e.stopPropagation();
                    ds.modal = {
                      kind: "prompt",
                      title: "Blocks from now",
                      body: `Create focused blocks for "${b.label}" starting now.\n\nEnter: blocks,duration (e.g. "4,25" = four 25-min blocks). Leave blank for 4×25m.`,
                      placeholder: "4,25",
                      value: "4,25",
                      onSubmit: async (val) => {
                        const [rawCount, rawDur] = val.split(",").map((s) => parseInt(s.trim(), 10));
                        const count = Math.max(1, Math.min(12, isNaN(rawCount) ? 4 : rawCount));
                        const dur = Math.max(5, Math.min(120, isNaN(rawDur) ? 25 : rawDur));
                        const nowM = nowMinutes();
                        const dow = new Date().getDay();
                        for (let i = 0; i < count; i++) {
                          const startM = nowM + i * dur;
                          await createBlock(ds, client, {
                            label: `${b.label} · Block ${i + 1}/${count}`,
                            category: b.category,
                            startMinute: startM,
                            endMinute: startM + dur,
                            days: [dow],
                            oneOffDate: todayIso(),
                            hard: false,
                            enabled: true,
                            nonNegotiable: false,
                            color: b.color,
                            projectId: b.projectId,
                            taskId: b.taskId,
                            routineItems: [],
                          });
                        }
                        ds.modal = null;
                        host.requestUpdate?.();
                      },
                    };
                    host.requestUpdate?.();
                  }}
                >${icons.clock} Blocks</button>
              </div>
            ` : nothing}
            <div class="disc-block-card__actions" style="margin-top:8px;">
              <button class="disc-btn" @click=${() => { beginEdit(ds, b.id); host.requestUpdate?.(); }}>Edit</button>
              <button
                class="disc-btn disc-btn--ghost"
                @click=${() => { void updateBlock(ds, client, b.id, { enabled: !b.enabled }); host.requestUpdate?.(); }}
              >
                ${b.enabled ? "Pause" : "Enable"}
              </button>
              ${isBlockDoneToday(ds, b.id)
                ? html`
                    <button
                      class="disc-btn disc-btn--ghost"
                      style="color:#10B981;border-color:rgba(16,185,129,0.4);"
                      title="Undo completion for today"
                      @click=${async () => { await unmarkBlockDone(ds, client, b.id); host.requestUpdate?.(); }}
                    >
                      ${icons.check} Done
                    </button>
                  `
                : html`
                    <button
                      class="disc-btn"
                      @click=${async () => { await markBlockDone(ds, client, b.id); host.requestUpdate?.(); }}
                    >
                      Mark complete
                    </button>
                  `}
            </div>
          </div>
        `;
      })}
    </div>
  `;
}

function renderBlocksListMode(ds: DisciplineState, host: AppViewState, client: GatewayBrowserClient, filteredBlocks: DisciplineBlock[]): TemplateResult {
  return html`
    <div class="disc-block-list">
      ${filteredBlocks.map((b) => {
        const color = b.color ?? CATEGORY_COLORS[b.category];
        const done = isBlockDoneToday(ds, b.id);
        const nowM = nowMinutes();
        const isCurrent = !done && nowM >= b.startMinute && nowM < b.endMinute;
        const isOverdue = !done && !isCurrent && nowM > b.endMinute;
        const priority = blockPriority(ds, b);
        const routine = routineProgressFor(ds, b);
        const completions = (ds.blockCompletionItems ?? []).filter((c) => c.blockId === b.id);
        return html`
          <div class="disc-block-list-row ${b.enabled ? "" : "disc-block-list-row--disabled"}">
            <div class="disc-block-list-row__accent" style="background:${color}"></div>
            <div class="disc-block-list-row__body">
              <div style="display:flex;align-items:center;gap:6px;">
                <span class="disc-block-list-row__title">${b.label}</span>
                ${done ? html`<span style="color:#10B981;font-size:10px;font-weight:700;">${icons.check} DONE</span>` : nothing}
                ${isCurrent ? html`<span style="color:#10B981;font-size:10px;font-weight:700;animation:discBlockPulse 2s infinite;">${icons.circle} ACTIVE</span>` : nothing}
                ${isOverdue && !done ? html`<span style="color:#ef4444;font-size:10px;font-weight:700;">OVERDUE</span>` : nothing}
                ${priority !== "normal" ? renderPriorityBadge(priority) : nothing}
              </div>
              <div class="disc-block-list-row__meta">
                <span style="color:${color}">${CATEGORY_LABELS[b.category]}</span>
                <span>·</span>
                <span>${minsToHHMM(b.startMinute)}–${minsToHHMM(b.endMinute)}</span>
                <span>·</span>
                <span>${humanDuration(b.endMinute - b.startMinute)}</span>
                ${b.hard ? html`<span>· <strong style="color:#F59E0B;">HARD</strong></span>` : nothing}
                ${b.nonNegotiable ? html`<span>· <strong style="color:#ef4444;">NN</strong></span>` : nothing}
                ${routine.total > 0 ? html`<span>· ${icons.check} ${routine.done}/${routine.total}</span>` : nothing}
                ${(() => {
                  const c = ds.autoLogCounts.find((x) => x.blockId === b.id);
                  return c && c.total > 0 ? html`<span class="disc-autolog-badge">${icons.zap} ${c.total}</span>` : nothing;
                })()}
              </div>
              ${completions.length > 0 ? html`
                <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">
                  ${completions.slice(0, 4).map((c) => html`
                    <span style="
                      display:inline-flex;align-items:center;gap:3px;
                      font-size:10px;padding:2px 7px;border-radius:10px;
                      background:${c.kind === "kanban:task_done" ? "rgba(16,185,129,0.12)" : "rgba(139,92,246,0.12)"};
                      color:${c.kind === "kanban:task_done" ? "#10B981" : "#8B5CF6"};
                      border:1px solid ${c.kind === "kanban:task_done" ? "rgba(16,185,129,0.3)" : "rgba(139,92,246,0.3)"};
                    " title="${c.title} · ${completionTimeAgo(c.completedAt)}">
                      ${c.kind === "kanban:task_done" ? "✓" : "⚡"} ${c.title.length > 20 ? c.title.slice(0, 20) + "…" : c.title}
                    </span>
                  `)}
                </div>
              ` : nothing}
              ${renderBlockInsight(ds, b)}
            </div>
            <div class="disc-block-list-row__actions">
              <button class="disc-btn" @click=${() => { beginEdit(ds, b.id); host.requestUpdate?.(); }}>Edit</button>
              ${done
                ? html`<button class="disc-btn disc-btn--ghost" style="color:#10B981;" @click=${async () => { await unmarkBlockDone(ds, client, b.id); host.requestUpdate?.(); }}>${icons.check}</button>`
                : html`<button class="disc-btn" @click=${async () => { await markBlockDone(ds, client, b.id); host.requestUpdate?.(); }}>Done</button>`}
            </div>
          </div>
        `;
      })}
    </div>
  `;
}

function renderBlocks(ds: DisciplineState, host: AppViewState, client: GatewayBrowserClient): TemplateResult {
  if (ds.creatingBlock || ds.editingBlockId) {
    return renderBlockEditor(ds, host, client);
  }
  if (ds.blocks.length === 0) {
    return renderEmptyState(ds, host, client);
  }

  const enabled = ds.blocks.filter((b) => b.enabled).length;
  const hard = ds.blocks.filter((b) => b.hard && b.enabled).length;
  const sortByPri = ds.settings.prioritySortEnabled;
  const ordered = sortByPri ? sortByPriority(ds, ds.blocks) : ds.blocks;
  const criticalCount = ds.blocks.filter((b) => blockPriority(ds, b) === "critical").length;
  const filteredBlocks = applyBlockFilters(ds, ordered);
  const hasActiveFilters = ds.blockFilters && (
    ds.blockFilters.categories.length > 0 ||
    ds.blockFilters.status.length > 0 ||
    ds.blockFilters.source.length > 0
  );

  return html`
    ${renderInsightsStrip(ds, host)}
    ${renderFilterBar(ds, host)}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:12px;flex-wrap:wrap;">
      <div style="font-size:13px;color: var(--disc-fg-faint);">
        ${hasActiveFilters
          ? html`<strong style="color:var(--g-primary);font-variant-numeric:tabular-nums;">${filteredBlocks.length}</strong> of ${ds.blocks.length} blocks ·`
          : nothing}
        <strong style="color:var(--g-primary);font-variant-numeric:tabular-nums;">${enabled}</strong> active ·
        <strong style="color:var(--g-primary);font-variant-numeric:tabular-nums;">${hard}</strong> hard-locked ·
        <strong style="color:var(--g-primary);font-variant-numeric:tabular-nums;">${ds.blocks.length - enabled}</strong> paused
        ${criticalCount > 0
          ? html` · <strong style="color:#ef4444;font-variant-numeric:tabular-nums;">${criticalCount}</strong> critical`
          : nothing}
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <div class="disc-view-toggle" data-learn-id="discipline-blocks-view">
          <button
            class="disc-view-toggle__btn ${_blocksDisplayMode === "board" ? "disc-view-toggle__btn--active" : ""}"
            title="Board view — cards grid"
            @click=${() => { _blocksDisplayMode = "board"; host.requestUpdate?.(); }}
          >⊞ Board</button>
          <button
            class="disc-view-toggle__btn ${_blocksDisplayMode === "list" ? "disc-view-toggle__btn--active" : ""}"
            title="List view — compact rows"
            @click=${() => { _blocksDisplayMode = "list"; host.requestUpdate?.(); }}
          >≡ List</button>
        </div>
        <button
          class="disc-btn ${sortByPri ? "disc-btn--primary" : ""}"
          title="Toggle priority-first ordering"
          @click=${() => {
            const next = !sortByPri;
            ds.settings = { ...ds.settings, prioritySortEnabled: next };
            void updateSettings(ds, client, { prioritySortEnabled: next });
            host.requestUpdate?.();
          }}
        >${sortByPri ? html`${icons.flame} By priority` : html`${icons.sliders} Sort: time`}</button>
        <button
          class="disc-btn disc-btn--primary"
          data-learn-id="discipline-create-block"
          @click=${() => { beginCreate(ds); host.requestUpdate?.(); }}
        >
          + New block
        </button>
      </div>
    </div>
    ${_blocksDisplayMode === "list"
      ? renderBlocksListMode(ds, host, client, filteredBlocks)
      : renderBlocksBoardMode(ds, host, client, filteredBlocks)}
  `;
}

function renderScore(ds: DisciplineState, host: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const today = ds.today;
  const week = ds.week;
  const streak = streakDays(week);
  const totalToday = today?.actualMinutes ?? 0;
  const todayCompliance = today?.compliance ?? 0;

  const catTotals: Record<string, number> = {};
  for (const c of DISCIPLINE_CATEGORIES) catTotals[c] = today?.categoryMinutes[c] ?? 0;
  const maxCat = Math.max(60, ...Object.values(catTotals));

  // Lazy-load analytics on first paint of the Score view so the user doesn't
  // pay the round-trip until they care. Subsequent loads happen via the range
  // selector buttons. Loaded flag prevents re-fetching on every re-render.
  if (!ds.analytics.loaded && !ds.analytics.loading) {
    void loadAnalyticsRange(ds, client, ds.analytics.days).then(() => host.requestUpdate?.());
  }

  const heatColor = (v: number): string => {
    if (v === 0) return "color-mix(in srgb, var(--g-primary) 4%, transparent)";
    if (v >= 85) return "linear-gradient(135deg, var(--g-primary), var(--g-primary))";
    if (v >= 60) return "linear-gradient(135deg, var(--g-primary), #9b7800)";
    if (v >= 30) return "color-mix(in srgb, var(--g-primary) 25%, transparent)";
    return "color-mix(in srgb, var(--g-primary) 12%, transparent)";
  };
  const heatText = (v: number): string => (v >= 60 ? "#0a0700" : "#c9b880");

  return html`
    <div class="disc-score-grid" data-learn-id="discipline-score-view">
      <div class="disc-score-card" style="--val-color:${scoreHue(todayCompliance)}">
        <div class="disc-score-card__val">${todayCompliance}%</div>
        <div class="disc-score-card__lbl">Compliance today</div>
      </div>
      <div class="disc-score-card">
        <div class="disc-score-card__val">${humanDuration(totalToday)}</div>
        <div class="disc-score-card__lbl">Time logged</div>
      </div>
      <div class="disc-score-card" style="--val-color:${today?.slippageCount ? "#ff8a8a" : "#10B981"}">
        <div class="disc-score-card__val">${today?.slippageCount ?? 0}</div>
        <div class="disc-score-card__lbl">Slips today</div>
      </div>
      <div class="disc-score-card" style="--val-color:${streak >= 3 ? "var(--g-primary)" : "var(--g-primary)"}">
        <div class="disc-score-card__val">${streak}${streak >= 3 ? html` ${icons.flame}` : nothing}</div>
        <div class="disc-score-card__lbl">Day streak</div>
      </div>
      ${(today?.nonNegotiableTotal ?? 0) > 0
        ? html`
            <div class="disc-score-card" style="--val-color:${(today!.nonNegotiableMissed ?? 0) === 0 ? "#10B981" : "#ff8a8a"}">
              <div class="disc-score-card__val">
                ${(today!.nonNegotiableTotal - today!.nonNegotiableMissed)}/${today!.nonNegotiableTotal}
              </div>
              <div class="disc-score-card__lbl">Non-negotiables</div>
            </div>
          `
        : nothing}
      ${(today?.routineTotal ?? 0) > 0
        ? html`
            <div class="disc-score-card">
              <div class="disc-score-card__val">${today!.routineCompleted}/${today!.routineTotal}</div>
              <div class="disc-score-card__lbl">Routine checked</div>
            </div>
          `
        : nothing}
      ${(() => {
        const totalAutoEvents = ds.autoLogCounts.reduce((s, c) => s + c.total, 0);
        return totalAutoEvents > 0 ? html`
          <div class="disc-score-card" style="--val-color:#F59E0B">
            <div class="disc-score-card__val">${totalAutoEvents}</div>
            <div class="disc-score-card__lbl">Auto-logged events</div>
          </div>
        ` : nothing;
      })()}
    </div>

    <div class="disc-panel" style="margin-bottom:16px;">
      <h3>Week heatmap</h3>
      <div class="disc-heat">
        ${week.map((d) => html`
          <div
            class="disc-heat__cell"
            style="background:${heatColor(d.compliance)};color:${heatText(d.compliance)};"
            title="${d.date}: ${d.compliance}% compliance · ${humanDuration(d.actualMinutes)} logged"
          >
            ${d.compliance}%
          </div>
        `)}
      </div>
      <div class="disc-heat" style="margin-top:6px;">
        ${week.map((d) => {
          const date = new Date(`${d.date}T00:00:00`);
          return html`<div style="text-align:center;font-size:10px;color: var(--disc-fg-mute);letter-spacing:.08em;">
            ${DAY_LETTERS[date.getDay()]} ${date.getDate()}
          </div>`;
        })}
      </div>
    </div>

    <div class="disc-panel">
      <h3>Where your time went (today)</h3>
      <div class="disc-cat-bar">
        ${DISCIPLINE_CATEGORIES.map((c) => {
          const v = catTotals[c] ?? 0;
          const pct = Math.round((v / maxCat) * 100);
          return html`
            <div class="disc-cat-row">
              <div class="disc-cat-row__label">${CATEGORY_LABELS[c]}</div>
              <div class="disc-cat-row__bar">
                <div
                  class="disc-cat-row__fill"
                  style="width:${pct}%;background:${CATEGORY_COLORS[c]};--fill-color:${CATEGORY_COLORS[c]};"
                ></div>
              </div>
              <div class="disc-cat-row__val">${humanDuration(v)}</div>
            </div>
          `;
        })}
      </div>
    </div>

    ${renderAnalytics(ds, host, client)}
  `;
}

// ── Analytics charts ───────────────────────────────────────────────────────

const ANALYTICS_WINDOWS: Array<{ days: AnalyticsWindow; label: string }> = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
];

/**
 * Compliance trend — sparkline-style line + filled area, with a 0/50/100
 * grid + a goal line at 80%. Sized to the card so it scales fluidly.
 */
function renderComplianceTrend(scores: DayScore[]): TemplateResult {
  if (scores.length < 2) return html`<div class="disc-chart-card__sub">Need at least 2 days of data.</div>`;
  const W = 600;
  const H = 140;
  const pad = { l: 28, r: 8, t: 8, b: 18 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const x = (i: number) => pad.l + (i / (scores.length - 1)) * innerW;
  const y = (v: number) => pad.t + innerH - (v / 100) * innerH;
  const linePath = scores
    .map((s, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(s.compliance).toFixed(1)}`)
    .join(" ");
  const fillPath = `${linePath} L${x(scores.length - 1).toFixed(1)},${(pad.t + innerH).toFixed(1)} L${x(0).toFixed(1)},${(pad.t + innerH).toFixed(1)} Z`;
  const goalY = y(80);
  return html`
    <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" role="img" aria-label="Compliance trend">
      ${svg`
        <defs>
          <linearGradient id="disc-line-grad" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="var(--g-primary)" stop-opacity="0.45" />
            <stop offset="100%" stop-color="var(--g-primary)" stop-opacity="0" />
          </linearGradient>
        </defs>
        ${[0, 50, 100].map(
          (v) => svg`<line class="grid-line" x1=${pad.l} x2=${W - pad.r} y1=${y(v)} y2=${y(v)} />`,
        )}
        ${[0, 50, 100].map(
          (v) => svg`<text class="axis-text" x="2" y=${y(v) + 3}>${v}</text>`,
        )}
        <line
          class="grid-line"
          x1=${pad.l}
          x2=${W - pad.r}
          y1=${goalY}
          y2=${goalY}
          stroke-dasharray="4 4"
          stroke="rgba(16,185,129,0.4)"
        />
        <text class="axis-text" x=${W - pad.r - 18} y=${goalY - 3} fill="rgba(16,185,129,0.7)">80</text>
        <path class="line-fill" d=${fillPath}></path>
        <path class="line" d=${linePath}></path>
        <text class="axis-text" x=${pad.l} y=${H - 4}>${scores[0]!.date.slice(5)}</text>
        <text class="axis-text" x=${W - pad.r} y=${H - 4} text-anchor="end">
          ${scores[scores.length - 1]!.date.slice(5)}
        </text>
      `}
    </svg>
  `;
}

/** Time logged per day — bar chart, color-graded by compliance. */
function renderTimeLoggedBars(scores: DayScore[]): TemplateResult {
  if (scores.length === 0) return html``;
  const W = 600;
  const H = 130;
  const pad = { l: 28, r: 8, t: 8, b: 18 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const max = Math.max(60, ...scores.map((s) => s.actualMinutes));
  const barW = (innerW / scores.length) * 0.8;
  const gap = (innerW / scores.length) * 0.2;
  return html`
    <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" role="img" aria-label="Time logged per day">
      ${svg`
        <line class="axis" x1=${pad.l} x2=${W - pad.r} y1=${H - pad.b} y2=${H - pad.b} />
        <text class="axis-text" x="2" y=${pad.t + 8}>${humanDuration(max)}</text>
        ${scores.map((s, i) => {
          const xc = pad.l + i * (barW + gap) + gap / 2;
          const h = (s.actualMinutes / max) * innerH;
          const y0 = pad.t + innerH - h;
          const color = s.compliance >= 80 ? "var(--g-primary)" : s.compliance >= 50 ? "#fbbf24" : "#ef4444";
          return svg`
            <rect
              class="disc-bar"
              x=${xc}
              y=${y0}
              width=${barW}
              height=${Math.max(1, h)}
              fill=${color}
              rx="2"
              opacity="0.85"
            >
              <title>${s.date}: ${humanDuration(s.actualMinutes)} · ${s.compliance}%</title>
            </rect>
          `;
        })}
      `}
    </svg>
  `;
}

/** Stacked categories per day — shows time mix. */
function renderCategoryStack(matrix: Partial<Record<DisciplineCategory, number[]>>, days: number): TemplateResult {
  if (days === 0) return html``;
  const W = 600;
  const H = 150;
  const pad = { l: 6, r: 6, t: 8, b: 18 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  // Find global max stack for normalization.
  let maxStack = 60;
  for (let i = 0; i < days; i++) {
    let total = 0;
    for (const c of DISCIPLINE_CATEGORIES) total += matrix[c]?.[i] ?? 0;
    if (total > maxStack) maxStack = total;
  }
  const colW = (innerW / days) * 0.85;
  const gap = (innerW / days) * 0.15;
  // Pre-compute the per-day stacks so the template stays declarative.
  const columns = Array.from({ length: days }, (_, i) => {
    const xc = pad.l + i * (colW + gap) + gap / 2;
    let stackedH = 0;
    const segments: Array<{ y: number; h: number; color: string; label: string; v: number }> = [];
    for (const c of DISCIPLINE_CATEGORIES) {
      const v = matrix[c]?.[i] ?? 0;
      if (v <= 0) continue;
      const h = (v / maxStack) * innerH;
      const y0 = pad.t + innerH - stackedH - h;
      stackedH += h;
      segments.push({ y: y0, h, color: CATEGORY_COLORS[c], label: CATEGORY_LABELS[c], v });
    }
    return { xc, segments };
  });
  return html`
    <svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" role="img" aria-label="Time-by-category over range">
      ${svg`
        ${columns.map(
          (col) => svg`
            ${col.segments.map(
              (seg) => svg`
                <rect
                  class="disc-bar"
                  x=${col.xc}
                  y=${seg.y}
                  width=${colW}
                  height=${Math.max(1, seg.h)}
                  fill=${seg.color}
                  opacity="0.85"
                >
                  <title>${seg.label}: ${humanDuration(seg.v)}</title>
                </rect>
              `,
            )}
          `,
        )}
      `}
    </svg>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;">
      ${DISCIPLINE_CATEGORIES.map((c) => html`
        <span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;color: var(--disc-fg-faint);">
          <span style="width:8px;height:8px;border-radius:2px;background:${CATEGORY_COLORS[c]};"></span>
          ${CATEGORY_LABELS[c]}
        </span>
      `)}
    </div>
  `;
}

function renderSlipsByDow(slips: number[]): TemplateResult {
  const max = Math.max(1, ...slips);
  return html`
    <div class="disc-dow-grid">
      ${slips.map((v, i) => {
        const ratio = v / max;
        const bg = v === 0
          ? "color-mix(in srgb, var(--g-primary) 4%, transparent)"
          : `color-mix(in srgb, #ef4444 ${Math.round(15 + ratio * 60)}%, transparent)`;
        return html`
          <div class="disc-dow-cell" style="background:${bg};color:${ratio > 0.5 ? "#fff5f5" : "#c9b880"};" title="${DAYS[i]}: ${v} slips">
            <div class="disc-dow-cell__lbl">${DAY_LETTERS[i]}</div>
            <div>${v}</div>
          </div>
        `;
      })}
    </div>
  `;
}

function renderBlockLeaderboard(stats: BlockStats[]): TemplateResult {
  const sortable = stats.filter((s) => s.scheduledCount > 0 || s.completedCount > 0);
  if (sortable.length === 0) {
    return html`<div class="disc-chart-card__sub">No block-linked logs yet.</div>`;
  }
  const top = [...sortable].sort((a, b) => b.completionRate - a.completionRate).slice(0, 5);
  const bottom = [...sortable]
    .filter((s) => s.scheduledCount >= 2)
    .sort((a, b) => a.completionRate - b.completionRate)
    .slice(0, 5);
  return html`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;">
      <div>
        <div style="font-size:10px;color:#10B981;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin-bottom:6px;">Most consistent</div>
        ${top.map((s) => html`
          <div class="disc-block-leader">
            <span class="disc-block-leader__label" title=${s.label}>${s.label}</span>
            <span class="disc-block-leader__rate">${Math.round(s.completionRate * 100)}%</span>
            <span class="disc-block-leader__count">${s.completedCount}/${s.scheduledCount}</span>
          </div>
        `)}
      </div>
      <div>
        <div style="font-size:10px;color:#ff8a8a;letter-spacing:0.14em;text-transform:uppercase;font-weight:700;margin-bottom:6px;">Most slipped</div>
        ${bottom.map((s) => html`
          <div class="disc-block-leader">
            <span class="disc-block-leader__label" title=${s.label}>${s.label}</span>
            <span class="disc-block-leader__rate disc-block-leader__rate--low">${Math.round(s.completionRate * 100)}%</span>
            <span class="disc-block-leader__count">${s.completedCount}/${s.scheduledCount}</span>
          </div>
        `)}
      </div>
    </div>
  `;
}

function exportAnalyticsCsv(ds: DisciplineState): void {
  const rows: string[] = [
    "date,plannedMinutes,actualMinutes,compliance,slippageCount,nonNegotiableMissed,nonNegotiableTotal,routineCompleted,routineTotal," +
      DISCIPLINE_CATEGORIES.join(","),
  ];
  for (const s of ds.analytics.scores) {
    const cats = DISCIPLINE_CATEGORIES.map((c) => s.categoryMinutes[c] ?? 0).join(",");
    rows.push(
      `${s.date},${s.plannedMinutes},${s.actualMinutes},${s.compliance},${s.slippageCount},${s.nonNegotiableMissed},${s.nonNegotiableTotal},${s.routineCompleted},${s.routineTotal},${cats}`,
    );
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `discipline-${ds.analytics.days}d-${todayIso()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function renderAnalytics(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const a = ds.analytics;
  return html`
    <div class="disc-analytics-toolbar" style="margin-top:20px;">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <h3 style="margin:0;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;color:var(--g-primary);font-weight:700;">
          Historic analytics
        </h3>
        ${a.source
          ? html`<span class="disc-analytics-source">
              source: ${a.source === "gateway" ? "gateway" : "logs (offline)"}
              ${a.loaded ? html` · ${a.scores.length} days` : nothing}
            </span>`
          : nothing}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <div class="disc-analytics-range">
          ${ANALYTICS_WINDOWS.map((w) => html`
            <button
              class="disc-analytics-range__btn ${a.days === w.days ? "active" : ""}"
              ?disabled=${a.loading}
              @click=${async () => {
                await loadAnalyticsRange(ds, client, w.days);
                host.requestUpdate?.();
              }}
            >${w.label}</button>
          `)}
        </div>
        <button
          class="disc-btn disc-btn--ghost"
          ?disabled=${!a.loaded || a.scores.length === 0}
          @click=${() => exportAnalyticsCsv(ds)}
        >Export CSV</button>
      </div>
    </div>

    ${a.loading
      ? html`<div class="disc-panel" style="text-align:center;color: var(--disc-fg-faint);">Loading analytics…</div>`
      : !a.loaded
      ? html`<div class="disc-panel" style="text-align:center;color: var(--disc-fg-faint);">Click a range above to load.</div>`
      : html`
          <div class="disc-stat-pair" style="margin-bottom:14px;">
            <div class="disc-stat-pair__cell">
              <div class="disc-stat-pair__val" style="color:${scoreHue(a.avgCompliance)}">${a.avgCompliance}%</div>
              <div class="disc-stat-pair__lbl">Avg compliance</div>
            </div>
            <div class="disc-stat-pair__cell">
              <div class="disc-stat-pair__val">${humanDuration(a.totalLoggedMin)}</div>
              <div class="disc-stat-pair__lbl">Total logged</div>
            </div>
            <div class="disc-stat-pair__cell">
              <div class="disc-stat-pair__val" style="color:${a.totalSlips > 0 ? "#ff8a8a" : "#10B981"}">${a.totalSlips}</div>
              <div class="disc-stat-pair__lbl">Slips</div>
            </div>
            <div class="disc-stat-pair__cell">
              <div class="disc-stat-pair__val">${a.bestStreak}${a.bestStreak >= 7 ? html` ${icons.flame}` : nothing}</div>
              <div class="disc-stat-pair__lbl">Best streak</div>
            </div>
          </div>

          <div class="disc-analytics-grid">
            <div class="disc-chart-card">
              <h3>Compliance trend</h3>
              <div class="disc-chart-card__sub">% per day · 80% goal line</div>
              ${renderComplianceTrend(a.scores)}
            </div>
            <div class="disc-chart-card">
              <h3>Time logged per day</h3>
              <div class="disc-chart-card__sub">bars colored by compliance</div>
              ${renderTimeLoggedBars(a.scores)}
            </div>
            <div class="disc-chart-card">
              <h3>Time mix by category</h3>
              <div class="disc-chart-card__sub">stacked minutes per day</div>
              ${renderCategoryStack(a.categoryMatrix, a.scores.length)}
            </div>
            <div class="disc-chart-card">
              <h3>Slips by day-of-week</h3>
              <div class="disc-chart-card__sub">when do you most often drift?</div>
              ${renderSlipsByDow(a.slipsByDow)}
            </div>
            <div class="disc-chart-card" style="grid-column: span 2; min-width: 0;">
              <h3>Block leaderboard</h3>
              <div class="disc-chart-card__sub">completion rate over the range</div>
              ${renderBlockLeaderboard(a.blockStats)}
            </div>
            <div class="disc-chart-card" style="grid-column: span 2; min-width: 0; margin-top: 16px;">
              <div class="disc-chart-card__title">Event source breakdown — manual vs auto-log</div>
              ${ds.autoLogCounts.length === 0
                ? html`<div class="disc-chart-card__sub">No auto-log events recorded yet.</div>`
                : html`
                    <div style="display:flex;flex-direction:column;gap:6px;margin-top:10px;">
                      ${ds.autoLogCounts
                        .filter((c) => c.total > 0)
                        .sort((a_c, b_c) => b_c.total - a_c.total)
                        .slice(0, 10)
                        .map((c) => {
                          const block = ds.blocks.find((b) => b.id === c.blockId);
                          const label = block?.label ?? c.blockId ?? "Unattributed";
                          const color = block ? (block.color ?? CATEGORY_COLORS[block.category]) : "var(--g-primary)";
                          const manualCount = ds.logs.filter(
                            (l) => l.blockId === c.blockId && (l.source === "manual" || l.source === "planned"),
                          ).length;
                          const autoCount = c.total;
                          const total = manualCount + autoCount;
                          const autoPct = total > 0 ? Math.round((autoCount / total) * 100) : 0;
                          const manualPct = 100 - autoPct;
                          return html`
                            <div style="display:flex;flex-direction:column;gap:3px;">
                              <div style="display:flex;justify-content:space-between;align-items:center;">
                                <span style="font-size:11px;color:${color};font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%;">${label}</span>
                                <span style="font-size:10px;color:var(--disc-fg-faint);">
                                  <span title="Manual logs" style="color:var(--g-primary);">${icons.circle} ${manualCount}</span>
                                  <span style="margin:0 4px;">·</span>
                                  <span title="Auto-log events" style="color:#F59E0B;">${icons.zap} ${autoCount}</span>
                                </span>
                              </div>
                              <div style="height:6px;border-radius:3px;background:var(--glass-stroke-strong);overflow:hidden;display:flex;">
                                <div style="width:${manualPct}%;background:var(--g-primary);opacity:0.7;"></div>
                                <div style="width:${autoPct}%;background:#F59E0B;opacity:0.7;"></div>
                              </div>
                            </div>
                          `;
                        })}
                    </div>
                  `}
            </div>
            ${a.abortReasons.length > 0
              ? html`
                  <div class="disc-chart-card">
                    <h3>Abort reasons</h3>
                    <div class="disc-chart-card__sub">grouped, most recent at top within count tier</div>
                    ${a.abortReasons.slice(0, 8).map((r) => html`
                      <div class="disc-abort-row">
                        <span class="disc-abort-row__reason" title=${r.reason}>${r.reason}</span>
                        <span class="disc-abort-row__count">${r.count}×</span>
                      </div>
                    `)}
                  </div>
                `
              : nothing}
          </div>
        `}
  `;
}


// ── Settings + AI panel ────────────────────────────────────────────────────

function priorityLabel(p: DisciplinePriority): string {
  switch (p) {
    case "critical": return "Critical";
    case "high": return "High";
    case "low": return "Low";
    default: return "Normal";
  }
}

function renderPriorityBadge(p: DisciplinePriority): TemplateResult {
  if (p === "normal") return html``;
  return html`<span class="disc-pri-badge disc-pri-badge--${p}">${priorityLabel(p)}</span>`;
}

function tgEventRow(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
  key: keyof TelegramEventToggles,
  label: string,
): TemplateResult {
  const on = ds.settings.telegramEvents[key];
  return html`
    <label class="disc-event-row">
      <span
        class="disc-toggle ${on ? "is-on" : ""}"
        @click=${() => {
          const next: TelegramEventToggles = { ...ds.settings.telegramEvents, [key]: !on };
          ds.settings = { ...ds.settings, telegramEvents: next };
          void updateSettings(ds, client, { telegramEvents: next });
          host.requestUpdate?.();
        }}
      ></span>
      ${label}
    </label>
  `;
}

function renderSettingsTelegram(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const s = ds.settings;
  const test = ds.telegramTestResult;
  return html`
    <div class="disc-settings-card" data-learn-id="discipline-settings-telegram">
      <div class="disc-settings-card__title">
        <span class="disc-settings-card__title-icon">${icons.send}</span>
        Telegram notifications
        ${s.telegramEnabled
          ? html`<span class="disc-status-pill disc-status-pill--ok">ON</span>`
          : html`<span class="disc-status-pill disc-status-pill--idle">OFF</span>`}
      </div>
      <p class="disc-settings-card__hint">
        Push block transitions, slips, and daily reviews to Telegram. Uses your gateway's
        configured Telegram bot — set the chat ID below to override the default destination.
      </p>

      <div class="disc-settings-row">
        <div class="disc-settings-row__label">
          Enable telegram fan-out
          <span class="disc-settings-row__hint">Master switch for all events below</span>
        </div>
        <span
          class="disc-toggle ${s.telegramEnabled ? "is-on" : ""}"
          @click=${() => {
            const next = !s.telegramEnabled;
            ds.settings = { ...s, telegramEnabled: next };
            void updateSettings(ds, client, { telegramEnabled: next });
            host.requestUpdate?.();
          }}
        ></span>
      </div>

      <div class="disc-settings-row" style="flex-direction:column;align-items:stretch;">
        <label class="disc-label" style="margin:0 0 6px 0;">Override chat id (optional)</label>
        <input
          class="disc-input"
          type="text"
          placeholder="e.g. -100123456789 — leave blank for gateway default"
          .value=${s.telegramChatId ?? ""}
          @change=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value.trim();
            ds.settings = { ...s, telegramChatId: v };
            void updateSettings(ds, client, { telegramChatId: v });
            host.requestUpdate?.();
          }}
        />
      </div>

      ${s.telegramEnabled
        ? html`
            <div class="disc-events-grid">
              ${tgEventRow(ds, host, client, "blockStart", "Block start")}
              ${tgEventRow(ds, host, client, "blockEnd", "Block end")}
              ${tgEventRow(ds, host, client, "blockComplete", "Block completed")}
              ${tgEventRow(ds, host, client, "abort", "Block aborted")}
              ${tgEventRow(ds, host, client, "slip", "Slips")}
              ${tgEventRow(ds, host, client, "dailyReview", "Daily review")}
            </div>

            <div style="display:flex;align-items:center;gap:8px;margin-top:14px;flex-wrap:wrap;">
              <button
                class="disc-btn"
                ?disabled=${!s.telegramEnabled}
                @click=${async () => {
                  ds.telegramTestResult = null;
                  host.requestUpdate?.();
                  const res = await sendTelegram(
                    client,
                    ds,
                    "Test from Discipline · " +
                      new Date().toLocaleTimeString() +
                      "\nIf you got this, telegram fan-out is wired up.",
                  );
                  ds.telegramTestResult = {
                    ok: res.ok,
                    message: res.ok ? "Test sent — check Telegram." : (res.error ?? "Failed"),
                    ts: Date.now(),
                  };
                  host.requestUpdate?.();
                }}
              >
                Send test message
              </button>
              ${test
                ? html`<span class="disc-status-pill ${test.ok ? "disc-status-pill--ok" : "disc-status-pill--err"}">
                    ${test.ok ? html`${icons.check} Sent` : "Failed"}
                  </span>
                  <span style="font-size:11px;color: var(--disc-fg-faint);">${test.message}</span>`
                : nothing}
            </div>
          `
        : nothing}
    </div>
  `;
}

function renderSettingsAi(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const s = ds.settings;
  return html`
    <div class="disc-settings-card" data-learn-id="discipline-settings-ai">
      <div class="disc-settings-card__title">
        <span class="disc-settings-card__title-icon">${icons.sparkles}</span>
        AI assistant
        ${s.ai.enabled
          ? html`<span class="disc-status-pill disc-status-pill--ok">ON</span>`
          : html`<span class="disc-status-pill disc-status-pill--idle">OFF</span>`}
      </div>
      <p class="disc-settings-card__hint">
        Run plan, review, and nudge prompts against your Claude session with full discipline +
        kanban context. Uses <code style="color: var(--disc-fg-dim);">${s.ai.sessionKey || "agent:main:discipline"}</code> by default.
      </p>

      <div class="disc-settings-row">
        <div class="disc-settings-row__label">
          Enable AI assistant
          <span class="disc-settings-row__hint">Required for the AI plan / review buttons</span>
        </div>
        <span
          class="disc-toggle ${s.ai.enabled ? "is-on" : ""}"
          @click=${() => {
            const next = !s.ai.enabled;
            ds.settings = { ...s, ai: { ...s.ai, enabled: next } };
            void updateSettings(ds, client, { ai: { ...s.ai, enabled: next } });
            host.requestUpdate?.();
          }}
        ></span>
      </div>

      <div class="disc-settings-row" style="flex-direction:column;align-items:stretch;">
        <label class="disc-label" style="margin:0 0 6px 0;">Session key override</label>
        <input
          class="disc-input"
          type="text"
          placeholder="agent:main:discipline (default)"
          .value=${s.ai.sessionKey ?? ""}
          @change=${(e: Event) => {
            const v = (e.target as HTMLInputElement).value.trim();
            const next = { ...s.ai, sessionKey: v || undefined };
            ds.settings = { ...s, ai: next };
            void updateSettings(ds, client, { ai: next });
            host.requestUpdate?.();
          }}
        />
      </div>

      <div class="disc-settings-row">
        <div class="disc-settings-row__label">
          Auto-plan tomorrow at end of day
          <span class="disc-settings-row__hint">Generates a draft block lineup based on your kanban priorities</span>
        </div>
        <span
          class="disc-toggle ${s.ai.autoPlanNextDay ? "is-on" : ""}"
          @click=${() => {
            const next = { ...s.ai, autoPlanNextDay: !s.ai.autoPlanNextDay };
            ds.settings = { ...s, ai: next };
            void updateSettings(ds, client, { ai: next });
            host.requestUpdate?.();
          }}
        ></span>
      </div>

      <div class="disc-settings-row">
        <div class="disc-settings-row__label">
          Auto daily review
          <span class="disc-settings-row__hint">Honest summary of compliance + one tweak for tomorrow</span>
        </div>
        <span
          class="disc-toggle ${s.ai.autoDailyReview ? "is-on" : ""}"
          @click=${() => {
            const next = { ...s.ai, autoDailyReview: !s.ai.autoDailyReview };
            ds.settings = { ...s, ai: next };
            void updateSettings(ds, client, { ai: next });
            host.requestUpdate?.();
          }}
        ></span>
      </div>
    </div>
  `;
}

function renderSettingsCadence(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const s = ds.settings;
  return html`
    <div class="disc-settings-card" data-learn-id="discipline-settings-cadence">
      <div class="disc-settings-card__title">
        <span class="disc-settings-card__title-icon">${icons.clock}</span>
        Day window + cadence
      </div>
      <p class="disc-settings-card__hint">
        Bound when the timeline renders, how often probes nudge you, and when to mute audio +
        telegram during sleep / focus hours.
      </p>

      <div class="disc-settings-row">
        <div class="disc-settings-row__label">Day starts at</div>
        <input
          class="disc-spin"
          type="number"
          min="0"
          max="23"
          .value=${String(s.dayStartHour)}
          @change=${(e: Event) => {
            const v = clamp(parseInt((e.target as HTMLInputElement).value, 10), 0, 23);
            ds.settings = { ...s, dayStartHour: v };
            void updateSettings(ds, client, { dayStartHour: v });
            host.requestUpdate?.();
          }}
        />
      </div>
      <div class="disc-settings-row">
        <div class="disc-settings-row__label">Day ends at</div>
        <input
          class="disc-spin"
          type="number"
          min="1"
          max="24"
          .value=${String(s.dayEndHour)}
          @change=${(e: Event) => {
            const v = clamp(parseInt((e.target as HTMLInputElement).value, 10), 1, 24);
            ds.settings = { ...s, dayEndHour: v };
            void updateSettings(ds, client, { dayEndHour: v });
            host.requestUpdate?.();
          }}
        />
      </div>
      <div class="disc-settings-row">
        <div class="disc-settings-row__label">Probe interval (min)</div>
        <input
          class="disc-spin"
          type="number"
          min="5"
          max="240"
          .value=${String(s.probeIntervalMin)}
          @change=${(e: Event) => {
            const v = clamp(parseInt((e.target as HTMLInputElement).value, 10), 5, 240);
            ds.settings = { ...s, probeIntervalMin: v };
            void updateSettings(ds, client, { probeIntervalMin: v });
            host.requestUpdate?.();
          }}
        />
      </div>
      <div class="disc-settings-row">
        <div class="disc-settings-row__label">
          Quiet hours
          <span class="disc-settings-row__hint">Telegram + audio muted in this window. End < start wraps midnight.</span>
        </div>
        <div class="disc-quiet-range">
          <input
            type="time"
            .value=${minsToHHMM(s.quietHoursStart * 60)}
            @change=${(e: Event) => {
              const v = Math.floor(hhmmToMins((e.target as HTMLInputElement).value) / 60);
              ds.settings = { ...s, quietHoursStart: v };
              void updateSettings(ds, client, { quietHoursStart: v });
              host.requestUpdate?.();
            }}
          />
          <span style="color: var(--disc-fg-mute);font-size:11px;">${icons.arrowRight}</span>
          <input
            type="time"
            .value=${minsToHHMM(s.quietHoursEnd * 60)}
            @change=${(e: Event) => {
              const v = Math.floor(hhmmToMins((e.target as HTMLInputElement).value) / 60);
              ds.settings = { ...s, quietHoursEnd: v };
              void updateSettings(ds, client, { quietHoursEnd: v });
              host.requestUpdate?.();
            }}
          />
        </div>
      </div>
      <div class="disc-settings-row">
        <div class="disc-settings-row__label">
          Militant mode
          <span class="disc-settings-row__hint">Hard-locks browser notifications during blocks</span>
        </div>
        <span
          class="disc-toggle ${s.militant ? "is-on" : ""}"
          @click=${() => {
            const next = !s.militant;
            ds.settings = { ...s, militant: next };
            void updateSettings(ds, client, { militant: next });
            host.requestUpdate?.();
          }}
        ></span>
      </div>
    </div>
  `;
}

function renderSettingsPriority(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const s = ds.settings;
  const linkedTaskCount = ds.blocks.filter((b) => b.taskId).length;
  const linkedProjectCount = ds.blocks.filter((b) => b.projectId && !b.taskId).length;
  const criticalCount = ds.blocks.filter((b) => blockPriority(ds, b) === "critical").length;
  return html`
    <div class="disc-settings-card">
      <div class="disc-settings-card__title">
        <span class="disc-settings-card__title-icon">${icons.flame}</span>
        Priority context
      </div>
      <p class="disc-settings-card__hint">
        Pulls priority from linked Notion / kanban tasks. Drag a kanban task onto any block in
        the Timeline view to link it; priority then decorates both the timeline and Blocks card.
      </p>
      <div class="disc-settings-row">
        <div class="disc-settings-row__label">Sort Blocks by priority</div>
        <span
          class="disc-toggle ${s.prioritySortEnabled ? "is-on" : ""}"
          @click=${() => {
            const next = !s.prioritySortEnabled;
            ds.settings = { ...s, prioritySortEnabled: next };
            void updateSettings(ds, client, { prioritySortEnabled: next });
            host.requestUpdate?.();
          }}
        ></span>
      </div>
      <div class="disc-settings-row">
        <div class="disc-settings-row__label">
          Highlight critical blocks in timeline
          <span class="disc-settings-row__hint">Adds a red glow ring to blocks linked to critical-priority tasks</span>
        </div>
        <span
          class="disc-toggle ${s.priorityHighlight ? "is-on" : ""}"
          @click=${() => {
            const next = !s.priorityHighlight;
            ds.settings = { ...s, priorityHighlight: next };
            void updateSettings(ds, client, { priorityHighlight: next });
            host.requestUpdate?.();
          }}
        ></span>
      </div>
      <div style="margin-top:10px;padding-top:10px;border-top:1px dashed color-mix(in srgb, var(--g-primary) 8%, transparent);">
        <div class="disc-event-row">
          <span style="color: var(--disc-fg-faint);flex:1;">Linked tasks</span>
          <span style="color:var(--g-primary);font-weight:700;">${linkedTaskCount}</span>
        </div>
        <div class="disc-event-row">
          <span style="color: var(--disc-fg-faint);flex:1;">Linked projects</span>
          <span style="color:var(--g-primary);font-weight:700;">${linkedProjectCount}</span>
        </div>
        <div class="disc-event-row">
          <span style="color: var(--disc-fg-faint);flex:1;">Critical right now</span>
          <span style="color:${criticalCount > 0 ? "#ef4444" : "#9b8b4d"};font-weight:700;">${criticalCount}</span>
        </div>
      </div>
      <div style="margin-top:12px;">
        <button
          class="disc-btn"
          @click=${() => { void loadKanbanLinks(ds, client); host.requestUpdate?.(); }}
        >Refresh kanban links</button>
      </div>
    </div>
  `;
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function renderAiPanel(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const s = ds.settings;
  const last = ds.aiLastResponse;
  if (!s.ai.enabled) {
    return html`
      <div class="disc-ai-panel">
        <div class="disc-ai-panel__head">
          <div class="disc-ai-panel__title">AI assistant</div>
          <button
            class="disc-btn disc-btn--ghost"
            @click=${() => { ds.subView = "settings"; host.requestUpdate?.(); }}
          >Enable in Settings</button>
        </div>
        <div class="disc-ai-panel__empty">
          Connect Claude to plan tomorrow, review today, or nudge you in the moment with full
          context of your blocks + kanban priorities.
        </div>
      </div>
    `;
  }
  const run = async (kind: "plan" | "review" | "advice") => {
    if (ds.aiBusy) return;
    ds.aiBusy = true;
    ds.aiLastResponse = null;
    host.requestUpdate?.();
    const res = await requestAiAdvice(client, ds, kind);
    ds.aiBusy = false;
    if (res.ok && res.text) {
      ds.aiLastResponse = { kind, text: res.text, ts: Date.now() };
    } else {
      ds.aiLastResponse = { kind: "error", text: res.error ?? "Unknown error", ts: Date.now() };
    }
    host.requestUpdate?.();
  };
  return html`
    <div class="disc-ai-panel">
      <div class="disc-ai-panel__head">
        <div class="disc-ai-panel__title">AI assistant</div>
        <div class="disc-ai-panel__actions">
          <button class="disc-btn" ?disabled=${ds.aiBusy} @click=${() => void run("advice")}>Nudge me</button>
          <button class="disc-btn" ?disabled=${ds.aiBusy} @click=${() => void run("review")}>Daily review</button>
          <button class="disc-btn disc-btn--primary" ?disabled=${ds.aiBusy} @click=${() => void run("plan")}>Plan tomorrow</button>
        </div>
      </div>
      ${ds.aiBusy
        ? html`<div class="disc-ai-panel__busy">Thinking…</div>`
        : last
        ? html`
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
              <span class="disc-status-pill ${last.kind === "error" ? "disc-status-pill--err" : "disc-status-pill--ok"}">
                ${last.kind === "error" ? "Error" : last.kind === "plan" ? "Plan" : last.kind === "review" ? "Review" : "Nudge"}
              </span>
              <span style="font-size:10px;color: var(--disc-fg-mute);">${new Date(last.ts).toLocaleTimeString()}</span>
              ${last.kind !== "error" && ds.settings.telegramEnabled
                ? html`<button
                    class="disc-btn disc-btn--ghost"
                    style="margin-left:auto;"
                    @click=${async () => {
                      const r = await sendTelegram(client, ds, `AI ${last.kind}:\n\n${last.text}`);
                      ds.telegramTestResult = {
                        ok: r.ok,
                        message: r.ok ? "Sent to Telegram" : (r.error ?? "Failed"),
                        ts: Date.now(),
                      };
                      host.requestUpdate?.();
                    }}
                  >Send to Telegram</button>`
                : nothing}
            </div>
            <div class="disc-ai-panel__body">${last.text}</div>
          `
        : html`<div class="disc-ai-panel__empty">No advice yet. Hit one of the buttons above.</div>`}
    </div>
  `;
}

function renderSettingsNotion(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const ns = ds.notionSync;
  const isConnected = ns.status === "connected";
  const isSyncing = ns.status === "syncing";
  const isError = ns.status === "error";
  const lastSync = ns.lastSyncAt
    ? new Date(ns.lastSyncAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  return html`
    <div class="disc-settings-card" data-learn-id="discipline-settings-notion">
      <div class="disc-settings-card__title">
        <span class="disc-settings-card__title-icon">${icons.book}</span>
        Notion Sync
        ${isConnected
          ? html`<span class="disc-status-pill disc-status-pill--ok">CONNECTED</span>`
          : isError
            ? html`<span class="disc-status-pill disc-status-pill--err">ERROR</span>`
            : html`<span class="disc-status-pill disc-status-pill--idle">NOT SET UP</span>`}
      </div>
      <p class="disc-settings-card__hint">
        Sync your Discipline Blocks + Logs to a Notion database. Requires a Notion integration
        configured in the gateway (notion.db.list RPC). Changes sync every 5 minutes; use
        "Sync now" to push immediately.
      </p>

      ${isConnected || isError
        ? html`
            <div class="disc-settings-row">
              <div class="disc-settings-row__label">
                Last sync
                <span class="disc-settings-row__hint">${lastSync ?? "never"}</span>
              </div>
              <button
                class="disc-btn ${isSyncing ? "disc-btn--ghost" : ""}"
                ?disabled=${isSyncing}
                @click=${async () => {
                  ds.notionSync = { ...ns, status: "syncing" };
                  host.requestUpdate?.();
                  try {
                    await client.request("discipline.notion.syncNow", {});
                    ds.notionSync = { ...ds.notionSync, status: "connected", lastSyncAt: Date.now(), error: null };
                  } catch (err) {
                    ds.notionSync = { ...ds.notionSync, status: "error", error: String(err) };
                  }
                  host.requestUpdate?.();
                }}
              >${isSyncing ? "Syncing…" : "Sync now"}</button>
            </div>
            ${isError
              ? html`<div style="padding:8px 10px;border-radius:6px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);font-size:11px;color:#ff8a8a;margin-top:8px;">${ns.error}</div>`
              : nothing}
            <div class="disc-settings-row" style="margin-top:12px;">
              <div class="disc-settings-row__label">Disconnect</div>
              <button
                class="disc-btn disc-btn--danger"
                @click=${async () => {
                  try {
                    await client.request("discipline.notion.disconnect", {});
                    ds.notionSync = { status: "disconnected", lastSyncAt: null, error: null };
                  } catch { /* ignore */ }
                  host.requestUpdate?.();
                }}
              >Disconnect</button>
            </div>
          `
        : html`
            <div style="
              margin-top:12px;
              padding:18px;
              border-radius:10px;
              border:1px dashed var(--disc-border);
              text-align:center;
            ">
              <div style="font-size:22px;margin-bottom:8px;">${icons.book}</div>
              <div style="font-size:13px;font-weight:600;color:var(--disc-fg);margin-bottom:6px;">Connect Notion</div>
              <div style="font-size:11px;color:var(--disc-fg-faint);margin-bottom:14px;">
                First add your Notion integration in Gateway Settings ${icons.arrowRight} Integrations, then click Connect below.
                Discipline Blocks and Logs databases will be created automatically on first sync.
              </div>
              <button
                class="disc-btn disc-btn--primary"
                @click=${async () => {
                  ds.notionSync = { ...ns, status: "syncing" };
                  host.requestUpdate?.();
                  try {
                    await client.request("discipline.notion.connect", {});
                    const status = await client.request("discipline.notion.status", {}) as any;
                    ds.notionSync = {
                      status: status?.connected ? "connected" : "disconnected",
                      lastSyncAt: status?.lastSyncAt ?? null,
                      error: null,
                    };
                  } catch (err) {
                    ds.notionSync = { status: "error", lastSyncAt: null, error: String(err) };
                  }
                  host.requestUpdate?.();
                }}
              >Connect Notion</button>
            </div>
          `}
    </div>
  `;
}

function renderSettings(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  return html`
    <div class="disc-settings-grid" data-learn-id="discipline-settings">
      ${renderSettingsTelegram(ds, host, client)}
      ${renderSettingsAi(ds, host, client)}
      ${renderSettingsCadence(ds, host, client)}
      ${renderSettingsPriority(ds, host, client)}
      ${renderSettingsNotion(ds, host, client)}
    </div>
    ${renderAiPanel(ds, host, client)}
  `;
}

// ── Template strip + modal ─────────────────────────────────────────────────

function renderTemplateStrip(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const name = activeTemplateName(ds);
  const dirty = isTemplateDirty(ds);
  const active = ds.activeTemplateId
    ? ds.templates.find((t) => t.id === ds.activeTemplateId)
    : null;
  const canOverwrite = active && active.source === "user";
  return html`
    <div class="disc-tpl-strip" data-learn-id="discipline-templates">
      <span class="disc-tpl-strip__icon" title=${name ? `Active template: ${name}` : "No template loaded"}>${icons.layoutList}</span>
      <div class="disc-tpl-strip__name-row">
        <span class="disc-tpl-strip__kicker">Active template</span>
        ${name
          ? html`
              <span class="disc-tpl-strip__name" title=${name}>
                ${name}
                ${dirty ? html`<span class="disc-tpl-strip__dirty">Modified</span>` : nothing}
              </span>
            `
          : html`<span class="disc-tpl-strip__name disc-tpl-strip__name--custom">Custom layout (unsaved)</span>`}
      </div>
      <div class="disc-tpl-strip__actions">
        ${canOverwrite && dirty
          ? html`
              <button
                class="disc-btn disc-btn--primary"
                title="Save changes to ${name}"
                @click=${async () => {
                  await overwriteTemplate(ds, client, ds.activeTemplateId!);
                  host.requestUpdate?.();
                }}
              >Save changes</button>
            `
          : nothing}
        <button
          class="disc-btn"
          data-learn-id="discipline-template-save"
          title="Save current layout as a new template"
          @click=${() => {
            ds.templateModal = {
              kind: "saveAs",
              name: name && dirty ? `${name} (copy)` : "",
              description: "",
            };
            host.requestUpdate?.();
          }}
        >${name ? "Save as new" : "Save as template"}</button>
        <button
          class="disc-btn"
          data-learn-id="discipline-template-load"
          title="Browse and load a template"
          @click=${() => {
            if (!ds.templatesLoaded) void loadTemplates(ds, client).then(() => host.requestUpdate?.());
            ds.templateModal = { kind: "load", query: "" };
            host.requestUpdate?.();
          }}
        >Load…</button>
        <button
          class="disc-btn disc-btn--ghost"
          data-learn-id="discipline-template-manage"
          title="Manage saved templates"
          @click=${() => {
            ds.templateModal = { kind: "manage" };
            host.requestUpdate?.();
          }}
        >Manage</button>
        ${name
          ? html`
              <button
                class="disc-btn disc-btn--ghost"
                title="Detach the active template (keeps the blocks)"
                @click=${() => { clearActiveTemplate(ds); host.requestUpdate?.(); }}
              >×</button>
            `
          : nothing}
      </div>
    </div>
  `;
}

function templateBlockSummary(t: DisciplineTemplate): string {
  const total = t.blocks.length;
  const hard = t.blocks.filter((b) => b.hard).length;
  const nn = t.blocks.filter((b) => b.nonNegotiable).length;
  const pieces = [`${total} block${total === 1 ? "" : "s"}`];
  if (hard) pieces.push(`${hard} hard`);
  if (nn) pieces.push(`${nn} non-neg`);
  return pieces.join(" · ");
}

function renderTemplateCardActions(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
  t: DisciplineTemplate,
  context: "load" | "manage",
): TemplateResult {
  const isActive = ds.activeTemplateId === t.id;
  const isPreset = t.source === "preset";
  return html`
    <div class="disc-tpl-card__actions" @click=${(e: Event) => e.stopPropagation()}>
      <button
        class="disc-btn disc-btn--primary"
        title="Replace current layout with this template"
        @click=${async () => {
          ds.modal = {
            kind: "confirm",
            title: `Load "${t.name}"?`,
            body: `This will replace your current ${ds.blocks.length} block${ds.blocks.length === 1 ? "" : "s"} with the ${t.blocks.length} from this template.`,
            confirmLabel: "Replace",
            dangerous: true,
            onConfirm: async () => {
              ds.modal = null;
              ds.templateModal = null;
              host.requestUpdate?.();
              await applyTemplate(ds, client, t.id, "replace");
              host.requestUpdate?.();
            },
          };
          host.requestUpdate?.();
        }}
      >${isActive ? "Reload" : "Replace"}</button>
      <button
        class="disc-btn"
        title="Add this template's blocks alongside your current ones"
        @click=${async () => {
          ds.templateModal = null;
          host.requestUpdate?.();
          await applyTemplate(ds, client, t.id, "append");
          host.requestUpdate?.();
        }}
      >Append</button>
      ${context === "manage" && !isPreset
        ? html`
            <button
              class="disc-btn disc-btn--ghost"
              @click=${() => {
                ds.templateModal = { kind: "rename", templateId: t.id, name: t.name };
                host.requestUpdate?.();
              }}
            >Rename</button>
            <button
              class="disc-btn disc-btn--danger"
              @click=${() => {
                ds.modal = {
                  kind: "confirm",
                  title: `Delete "${t.name}"?`,
                  body: "This template will be removed permanently.",
                  confirmLabel: "Delete",
                  dangerous: true,
                  onConfirm: async () => {
                    ds.modal = null;
                    host.requestUpdate?.();
                    await deleteTemplate(ds, client, t.id);
                    host.requestUpdate?.();
                  },
                };
                host.requestUpdate?.();
              }}
            >Delete</button>
          `
        : nothing}
    </div>
  `;
}

function renderTemplateCard(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
  t: DisciplineTemplate,
  context: "load" | "manage",
): TemplateResult {
  const isActive = ds.activeTemplateId === t.id;
  return html`
    <div class="disc-tpl-card ${isActive ? "disc-tpl-card--active" : ""}">
      <div class="disc-tpl-card__head">
        <span class="disc-tpl-card__name">${t.name}</span>
        <span class="disc-tpl-card__source disc-tpl-card__source--${t.source ?? "user"}">${t.source === "preset" ? "Built-in" : "Saved"}</span>
      </div>
      ${t.description ? html`<div class="disc-tpl-card__desc">${t.description}</div>` : nothing}
      <div class="disc-tpl-card__stats">${templateBlockSummary(t)}${isActive ? " · currently active" : ""}</div>
      ${renderTemplateCardActions(ds, host, client, t, context)}
    </div>
  `;
}

function renderTemplateModal(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const m: TemplateModalState = ds.templateModal;
  if (!m) return html``;

  const close = () => {
    ds.templateModal = null;
    host.requestUpdate?.();
  };

  if (m.kind === "saveAs") {
    return html`
      <div
        class="disc-modal__backdrop"
        @click=${(e: Event) => { if (e.target === e.currentTarget) close(); }}
      >
        <div class="disc-modal" @click=${(e: Event) => e.stopPropagation()}>
          <div class="disc-modal__title">Save as template</div>
          <div class="disc-modal__body">Snapshots all ${ds.blocks.length} current blocks. You can reload or share this layout later.</div>
          <input
            class="disc-input"
            style="margin-bottom:10px;"
            placeholder="Template name (e.g. 'Build sprint Mondays')"
            .value=${m.name}
            autofocus
            @input=${(e: Event) => { m.name = (e.target as HTMLInputElement).value; host.requestUpdate?.(); }}
            @keydown=${async (e: KeyboardEvent) => {
              if (e.key === "Enter" && m.name.trim()) {
                close();
                await saveAsTemplate(ds, client, m.name, m.description);
                host.requestUpdate?.();
              }
            }}
          />
          <input
            class="disc-input"
            style="margin-bottom:16px;"
            placeholder="Optional description"
            .value=${m.description}
            @input=${(e: Event) => { m.description = (e.target as HTMLInputElement).value; host.requestUpdate?.(); }}
          />
          <div class="disc-modal__actions">
            <button class="disc-btn" @click=${close}>Cancel</button>
            <button
              class="disc-btn disc-btn--primary"
              ?disabled=${!m.name.trim() || ds.blocks.length === 0}
              @click=${async () => {
                close();
                await saveAsTemplate(ds, client, m.name, m.description);
                host.requestUpdate?.();
              }}
            >Save template</button>
          </div>
        </div>
      </div>
    `;
  }

  if (m.kind === "rename") {
    return html`
      <div
        class="disc-modal__backdrop"
        @click=${(e: Event) => { if (e.target === e.currentTarget) close(); }}
      >
        <div class="disc-modal" @click=${(e: Event) => e.stopPropagation()}>
          <div class="disc-modal__title">Rename template</div>
          <input
            class="disc-input"
            style="margin-bottom:16px;"
            .value=${m.name}
            autofocus
            @input=${(e: Event) => { m.name = (e.target as HTMLInputElement).value; host.requestUpdate?.(); }}
            @keydown=${async (e: KeyboardEvent) => {
              if (e.key === "Enter" && m.name.trim()) {
                const id = m.templateId;
                const name = m.name;
                ds.templateModal = { kind: "manage" };
                host.requestUpdate?.();
                await renameTemplate(ds, client, id, name);
                host.requestUpdate?.();
              }
            }}
          />
          <div class="disc-modal__actions">
            <button class="disc-btn" @click=${() => { ds.templateModal = { kind: "manage" }; host.requestUpdate?.(); }}>Back</button>
            <button
              class="disc-btn disc-btn--primary"
              ?disabled=${!m.name.trim()}
              @click=${async () => {
                const id = m.templateId;
                const name = m.name;
                ds.templateModal = { kind: "manage" };
                host.requestUpdate?.();
                await renameTemplate(ds, client, id, name);
                host.requestUpdate?.();
              }}
            >Rename</button>
          </div>
        </div>
      </div>
    `;
  }

  // load + manage share the list rendering, just differ on the actions row.
  const context: "load" | "manage" = m.kind === "load" ? "load" : "manage";
  const query = m.kind === "load" ? m.query.toLowerCase() : "";
  const filtered = m.kind === "load"
    ? ds.templates.filter(
        (t) => !query || t.name.toLowerCase().includes(query) || (t.description ?? "").toLowerCase().includes(query),
      )
    : ds.templates;
  const userTpls = filtered.filter((t) => t.source !== "preset");
  const presetTpls = filtered.filter((t) => t.source === "preset");
  return html`
    <div
      class="disc-modal__backdrop"
      @click=${(e: Event) => { if (e.target === e.currentTarget) close(); }}
    >
      <div class="disc-modal disc-tpl-modal" data-learn-id="discipline-template-modal" @click=${(e: Event) => e.stopPropagation()}>
        <div class="disc-modal__title">${context === "load" ? "Load template" : "Manage templates"}</div>
        ${context === "load"
          ? html`
              <input
                class="disc-input"
                placeholder="Search templates…"
                .value=${(m as any).query}
                @input=${(e: Event) => {
                  if (ds.templateModal && ds.templateModal.kind === "load") {
                    ds.templateModal.query = (e.target as HTMLInputElement).value;
                    host.requestUpdate?.();
                  }
                }}
              />
            `
          : nothing}
        <div class="disc-tpl-list">
          ${!ds.templatesLoaded
            ? html`<div class="disc-tpl-empty">Loading templates…</div>`
            : filtered.length === 0
            ? html`
                <div class="disc-tpl-empty">
                  ${context === "load" && query
                    ? "No templates match your search."
                    : "No templates saved yet. Build a layout and hit Save as template above."}
                </div>
              `
            : html`
                ${userTpls.length > 0
                  ? html`
                      <div style="font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:var(--disc-fg-faint);margin-top:4px;">
                        Your templates
                      </div>
                      ${userTpls.map((t) => renderTemplateCard(ds, host, client, t, context))}
                    `
                  : nothing}
                ${presetTpls.length > 0
                  ? html`
                      <div style="font-size:9px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:var(--disc-fg-faint);margin-top:8px;">
                        Built-in presets
                      </div>
                      ${presetTpls.map((t) => renderTemplateCard(ds, host, client, t, context))}
                    `
                  : nothing}
              `}
        </div>
        <div class="disc-modal__actions">
          <button class="disc-btn" data-learn-id="discipline-template-modal-close" @click=${close}>Close</button>
        </div>
      </div>
    </div>
  `;
}

// ── Task kanban modal ──────────────────────────────────────────────────
//
// Full-screen kanban grouped by status. Checkboxes flip status to
// "done"/"todo" via the gateway (`kanban.tasks.update`) with optimistic UI.
// Project filter pills narrow the view; click a column header to bulk-move
// (not implemented yet — kept minimal).

const TASK_COLUMNS: Array<{ id: string; label: string; color: string }> = [
  { id: "todo", label: "To do", color: "#94a3b8" },
  { id: "in_progress", label: "In progress", color: "#60a5fa" },
  { id: "review", label: "Review", color: "#fbbf24" },
  { id: "done", label: "Done", color: "#10b981" },
];

function normalizeTaskStatus(raw?: string): string {
  const v = (raw ?? "").toLowerCase().replace(/\s+/g, "_");
  if (v === "doing" || v === "in-progress") return "in_progress";
  if (v === "complete" || v === "completed") return "done";
  if (v === "" || v === "backlog" || v === "open") return "todo";
  return v;
}

// renderTaskModal removed — replaced by the inline kanban panel rendered by
// renderInlineTaskKanban inside renderTimeline. The split layout means
// drag-and-drop has direct line-of-sight from a task card to a block in the
// rail, with no overlay to fade or click through.

function renderTaskFilterPill(
  ds: DisciplineState,
  host: AppViewState,
  id: string,
  label: string,
  color: string,
  count: number,
  current: string | "all",
): TemplateResult {
  const active = current === id;
  return html`
    <button
      class="disc-task-pill ${active ? "disc-task-pill--active" : ""}"
      style="--pill-color:${color}"
      aria-pressed=${active ? "true" : "false"}
      @click=${() => {
        setTaskModalProjectFilter(ds, id);
        host.requestUpdate?.();
      }}
    >
      <span class="disc-task-pill__dot"></span>
      ${label}
      <span class="disc-task-pill__count">${count}</span>
    </button>
  `;
}

// ── View-mode toggle + per-mode renderers ─────────────────────────────────

function renderTaskViewToggle(ds: DisciplineState, host: AppViewState): TemplateResult {
  const cur = ds.taskModal?.viewMode ?? "board";
  const modes: Array<{ id: "board" | "list" | "gallery"; label: string; glyph: string }> = [
    { id: "board",   label: "Board",   glyph: "⫏" },
    { id: "list",    label: "List",    glyph: "≡" },
    { id: "gallery", label: "Gallery", glyph: "⊞" },
  ];
  return html`
    <div class="disc-seg" role="group" aria-label="Task view">
      ${modes.map((mode) => {
        const active = cur === mode.id;
        return html`
          <button
            class="disc-seg__btn ${active ? "is-active" : ""}"
            aria-pressed=${active ? "true" : "false"}
            @click=${() => { setTaskModalViewMode(ds, mode.id); host.requestUpdate?.(); }}
            title="${mode.label} view"
          >
            <span class="disc-seg__glyph" aria-hidden="true">${mode.glyph}</span>
            <span>${mode.label}</span>
          </button>
        `;
      })}
    </div>
  `;
}

// ── Inline kanban (alongside the timeline rail) ───────────────────────────
//
// Same data + same view modes as the modal, but rendered inline as the right
// half of the timeline grid so the user can drag tasks directly onto blocks
// without opening a modal. Reuses every renderer the modal uses.
function renderInlineTaskKanban(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  // Lazy-init taskModal so view-mode + filter persist across re-renders.
  if (!ds.taskModal) {
    ds.taskModal = { open: false, projectFilter: "all", viewMode: "board", updating: {} };
  }
  const filter = ds.taskModal.projectFilter;
  const projects = ds.kanbanProjects;
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const filtered = filter === "all"
    ? ds.kanbanTasks
    : ds.kanbanTasks.filter((t) => t.projectId === filter);

  // Bucket by status column for the board view.
  const buckets = new Map<string, KanbanTaskLite[]>();
  for (const col of TASK_COLUMNS) buckets.set(col.id, []);
  for (const t of filtered) {
    const norm = normalizeTaskStatus(t.status);
    const arr = buckets.get(norm);
    if (arr) arr.push(t);
  }

  return html`
    <div class="disc-tl-kanban">
      <div class="disc-tl-kanban__head">
        <span class="disc-tl-kanban__title">Tasks</span>
        <span class="disc-tl-kanban__count">${filtered.length}</span>
        <div style="flex:1;"></div>
        ${renderTaskViewToggle(ds, host)}
      </div>

      ${ds.kanbanProjects.length > 1
        ? html`
            <div class="disc-tl-kanban__filters">
              ${renderTaskFilterPill(ds, host, "all", "All", "var(--g-primary)", ds.kanbanTasks.length, filter)}
              ${projects.map((p) => {
                const count = ds.kanbanTasks.filter((t) => t.projectId === p.id).length;
                return renderTaskFilterPill(ds, host, p.id, p.name, p.color ?? "var(--g-primary)", count, filter);
              })}
            </div>
          `
        : nothing}

      <div class="disc-tl-kanban__body">
        ${ds.kanbanTasks.length === 0
          ? wgEmpty({
              icon: icons.kanban,
              title: "No tasks yet",
              body: "Create one in the Kanban view, then drag it onto a block to link it.",
            })
          : ds.taskModal.viewMode === "list"
            ? renderTaskListView(ds, host, client, filtered, projectById)
            : ds.taskModal.viewMode === "gallery"
              ? renderTaskGalleryView(ds, host, client, filtered, projectById)
              : renderTaskBoardView(ds, host, client, buckets, projectById)}
      </div>
    </div>
  `;
}

function renderTaskBoardView(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
  buckets: Map<string, KanbanTaskLite[]>,
  projectById: Map<string, KanbanProjectLite>,
): TemplateResult {
  return html`
    <div class="disc-tboard">
      ${TASK_COLUMNS.map((col) => {
        const tasks = buckets.get(col.id) ?? [];
        return html`
          <div class="disc-tboard__col" style="--col-color:${col.color}">
            <div class="disc-tboard__head">
              <span class="disc-tboard__dot"></span>
              <span class="disc-tboard__label">${col.label}</span>
              <span class="disc-tboard__count">${tasks.length}</span>
            </div>
            ${tasks.length === 0
              ? html`<div class="disc-tboard__empty">Nothing here</div>`
              : tasks.map((t) => renderTaskCard(ds, host, client, t, projectById, col.id))}
          </div>
        `;
      })}
    </div>
  `;
}

function renderTaskListView(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
  tasks: KanbanTaskLite[],
  projectById: Map<string, KanbanProjectLite>,
): TemplateResult {
  if (tasks.length === 0) {
    return html`<div style="padding:32px; text-align:center; color:var(--disc-fg-faint); font-size:13px;">
      No tasks match the current filter.
    </div>`;
  }
  // Sort: incomplete first (status order), then by title.
  const order: Record<string, number> = { todo: 0, in_progress: 1, review: 2, done: 3 };
  const sorted = [...tasks].sort((a, b) => {
    const sa = order[normalizeTaskStatus(a.status)] ?? 99;
    const sb = order[normalizeTaskStatus(b.status)] ?? 99;
    if (sa !== sb) return sa - sb;
    return a.title.localeCompare(b.title);
  });

  return html`
    <div style="
      border:1px solid var(--disc-border-soft);
      border-radius:12px; overflow:hidden;
      background:var(--glass-hover);
    ">
      <!-- Header row -->
      <div style="
        display:grid; grid-template-columns: 28px 1fr 1.4fr 110px 130px;
        gap:12px; padding:10px 14px;
        font-family:'JetBrains Mono', ui-monospace, monospace;
        font-size:10px; font-weight:700; letter-spacing:0.16em;
        color:var(--disc-fg-faint); text-transform:uppercase;
        border-bottom:1px solid var(--disc-border-soft);
        background:var(--glass-hover);
      ">
        <div></div>
        <div>Task</div>
        <div>Project</div>
        <div>Status</div>
        <div>Move</div>
      </div>
      ${sorted.map((t) => {
        const norm = normalizeTaskStatus(t.status);
        const col = TASK_COLUMNS.find((c) => c.id === norm) ?? TASK_COLUMNS[0]!;
        const proj = projectById.get(t.projectId);
        const projColor = proj?.color ?? "var(--g-primary)";
        const done = norm === "done";
        const inflight = !!ds.taskModal?.updating[t.id];
        return html`
          <div
            draggable="true"
            @dragstart=${(e: DragEvent) => setTaskDragPayload(e, { taskId: t.id, projectId: t.projectId, title: t.title })}
            title="Drag onto a block to link"
            style="
              display:grid; grid-template-columns: 28px 1fr 1.4fr 110px 130px;
              gap:12px; padding:10px 14px; align-items:center;
              border-bottom:1px solid color-mix(in srgb, var(--disc-border-soft) 50%, transparent);
              opacity:${inflight ? 0.55 : 1};
              transition:background 0.12s ease;
              cursor: grab;
            "
            @mouseenter=${(e: Event) => (e.currentTarget as HTMLElement).style.background = "var(--glass-hover)"}
            @mouseleave=${(e: Event) => (e.currentTarget as HTMLElement).style.background = "transparent"}
          >
            <button
              @click=${async () => { await toggleKanbanTaskDone(ds, client, t.id); host.requestUpdate?.(); }}
              ?disabled=${inflight}
              title=${done ? "Mark as todo" : "Mark as done"}
              style="
                width:18px; height:18px; padding:0;
                border-radius:4px; cursor:pointer;
                background:${done ? projColor : "transparent"};
                border:1.5px solid ${done ? projColor : "var(--disc-border-soft)"};
                color:#000; font-size:11px; font-weight:700;
                display:inline-flex; align-items:center; justify-content:center;
              "
            >${done ? icons.check : nothing}</button>

            <div style="
              font-size:13px; color:var(--disc-fg);
              ${done ? "text-decoration:line-through; opacity:0.55;" : ""}
              white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
            ">${t.title}</div>

            <div style="display:flex; align-items:center; gap:8px; min-width:0;">
              <span style="
                width:8px; height:8px; border-radius:50%; flex-shrink:0;
                background:${projColor};
              "></span>
              <span style="
                font-size:12px; color:var(--disc-fg-dim);
                white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
              ">${proj?.name ?? "—"}</span>
            </div>

            <div style="
              display:inline-flex; align-items:center; gap:6px;
              padding:3px 8px; border-radius:999px;
              background:color-mix(in srgb, ${col.color} 14%, transparent);
              border:1px solid color-mix(in srgb, ${col.color} 35%, transparent);
              font-size:10px; font-weight:700; letter-spacing:0.08em;
              text-transform:uppercase; color:${col.color};
              max-width:fit-content;
            ">
              <span style="width:6px; height:6px; border-radius:50%; background:${col.color};"></span>
              ${col.label}
            </div>

            <select
              @change=${async (e: Event) => {
                const next = (e.target as HTMLSelectElement).value;
                await setKanbanTaskStatus(ds, client, t.id, next);
                host.requestUpdate?.();
              }}
              ?disabled=${inflight}
              style="
                font-size:10px; padding:4px 6px;
                background:transparent; color:var(--disc-fg-dim);
                border:1px solid var(--disc-border-soft); border-radius:6px;
                cursor:pointer; max-width:130px;
              "
            >
              ${TASK_COLUMNS.map(
                (c) => html`<option value=${c.id} ?selected=${c.id === norm}>${c.label}</option>`,
              )}
            </select>
          </div>
        `;
      })}
    </div>
  `;
}

function renderTaskGalleryView(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
  tasks: KanbanTaskLite[],
  projectById: Map<string, KanbanProjectLite>,
): TemplateResult {
  if (tasks.length === 0) {
    return html`<div style="padding:32px; text-align:center; color:var(--disc-fg-faint); font-size:13px;">
      No tasks match the current filter.
    </div>`;
  }
  const order: Record<string, number> = { todo: 0, in_progress: 1, review: 2, done: 3 };
  const sorted = [...tasks].sort((a, b) => {
    const sa = order[normalizeTaskStatus(a.status)] ?? 99;
    const sb = order[normalizeTaskStatus(b.status)] ?? 99;
    if (sa !== sb) return sa - sb;
    return a.title.localeCompare(b.title);
  });
  return html`
    <div style="
      display:grid;
      grid-template-columns:repeat(auto-fill, minmax(240px, 1fr));
      gap:12px;
    ">
      ${sorted.map((t) => {
        const norm = normalizeTaskStatus(t.status);
        const col = TASK_COLUMNS.find((c) => c.id === norm) ?? TASK_COLUMNS[0]!;
        const proj = projectById.get(t.projectId);
        const projColor = proj?.color ?? "var(--g-primary)";
        const done = norm === "done";
        const inflight = !!ds.taskModal?.updating[t.id];
        return html`
          <div
            draggable="true"
            @dragstart=${(e: DragEvent) => setTaskDragPayload(e, { taskId: t.id, projectId: t.projectId, title: t.title })}
            title="Drag onto a block to link"
            style="
              position:relative;
              display:flex; flex-direction:column; gap:10px;
              background:var(--glass-hover);
              border:1px solid var(--disc-border-soft);
              border-radius:12px;
              padding:14px; padding-top:18px;
              transition:transform 0.12s ease, border-color 0.12s ease;
              opacity:${inflight ? 0.55 : 1};
              overflow:hidden;
              cursor: grab;
            "
          @mouseenter=${(e: Event) => {
            const el = e.currentTarget as HTMLElement;
            el.style.borderColor = "color-mix(in srgb, var(--g-primary) 45%, transparent)";
            el.style.transform = "translateY(-2px)";
          }}
          @mouseleave=${(e: Event) => {
            const el = e.currentTarget as HTMLElement;
            el.style.borderColor = "var(--disc-border-soft)";
            el.style.transform = "translateY(0)";
          }}>
            <!-- Top color stripe -->
            <span style="
              position:absolute; top:0; left:0; right:0; height:4px;
              background:${projColor};
            "></span>

            <div style="display:flex; align-items:flex-start; gap:10px;">
              <button
                @click=${async () => { await toggleKanbanTaskDone(ds, client, t.id); host.requestUpdate?.(); }}
                ?disabled=${inflight}
                title=${done ? "Mark as todo" : "Mark as done"}
                style="
                  flex-shrink:0; width:20px; height:20px; padding:0;
                  border-radius:5px; cursor:pointer; margin-top:2px;
                  background:${done ? projColor : "transparent"};
                  border:1.5px solid ${done ? projColor : "var(--disc-border-soft)"};
                  color:#000; font-size:13px; font-weight:700;
                  display:inline-flex; align-items:center; justify-content:center;
                "
              >${done ? icons.check : nothing}</button>
              <div style="flex:1; min-width:0;">
                <div style="
                  font-size:13px; line-height:1.4; color:var(--disc-fg);
                  font-weight:600;
                  ${done ? "text-decoration:line-through; opacity:0.55;" : ""}
                ">${t.title}</div>
                ${proj
                  ? html`<div style="
                      font-size:11px; color:var(--disc-fg-faint); margin-top:4px;
                      display:inline-flex; align-items:center; gap:5px;
                    ">
                      <span style="width:6px; height:6px; border-radius:50%; background:${projColor};"></span>
                      ${proj.name}
                    </div>`
                  : nothing}
              </div>
            </div>

            <div style="
              display:flex; align-items:center; gap:8px; margin-top:auto;
              padding-top:8px; border-top:1px dashed var(--disc-border-soft);
            ">
              <span style="
                display:inline-flex; align-items:center; gap:5px;
                padding:3px 8px; border-radius:999px;
                background:color-mix(in srgb, ${col.color} 14%, transparent);
                border:1px solid color-mix(in srgb, ${col.color} 35%, transparent);
                font-size:9px; font-weight:700; letter-spacing:0.1em;
                text-transform:uppercase; color:${col.color};
              ">
                <span style="width:6px; height:6px; border-radius:50%; background:${col.color};"></span>
                ${col.label}
              </span>
              <select
                @change=${async (e: Event) => {
                  const next = (e.target as HTMLSelectElement).value;
                  await setKanbanTaskStatus(ds, client, t.id, next);
                  host.requestUpdate?.();
                }}
                ?disabled=${inflight}
                style="
                  margin-left:auto; font-size:9px; padding:3px 5px;
                  background:transparent; color:var(--disc-fg-dim);
                  border:1px solid var(--disc-border-soft); border-radius:5px;
                  cursor:pointer;
                "
              >
                ${TASK_COLUMNS.map(
                  (c) => html`<option value=${c.id} ?selected=${c.id === norm}>${c.label}</option>`,
                )}
              </select>
            </div>
          </div>
        `;
      })}
    </div>
  `;
}

function renderTaskCard(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
  task: KanbanTaskLite,
  projectById: Map<string, KanbanProjectLite>,
  columnId: string,
): TemplateResult {
  const proj = projectById.get(task.projectId);
  const color = proj?.color ?? "var(--g-primary)";
  const done = columnId === "done";
  const inflight = !!ds.taskModal?.updating[task.id];
  return html`
    <div
      draggable="true"
      @dragstart=${(e: DragEvent) => setTaskDragPayload(e, { taskId: task.id, projectId: task.projectId, title: task.title })}
      title="${task.title} — drag onto a block to link"
      class="disc-tcard ${done ? "is-done" : ""}"
      style="--task-color:${color}; opacity:${inflight ? 0.6 : 1};">
      <!-- Checkbox synced to DB -->
      <button
        class="disc-tcheck ${done ? "is-done" : ""}"
        @click=${async () => {
          await toggleKanbanTaskDone(ds, client, task.id);
          host.requestUpdate?.();
        }}
        ?disabled=${inflight}
        title=${done ? "Mark as todo" : "Mark as done"}
        aria-label=${done ? "Mark as todo" : "Mark as done"}
      >${done ? icons.check : nothing}</button>

      <div class="disc-tcard__body">
        <div class="disc-tcard__title">${task.title}</div>
        ${proj ? html`<div class="disc-tcard__proj">${proj.name}</div>` : nothing}
      </div>

      <!-- Move-to-column dropdown -->
      <select
        class="disc-tselect"
        @change=${async (e: Event) => {
          const next = (e.target as HTMLSelectElement).value;
          await setKanbanTaskStatus(ds, client, task.id, next);
          host.requestUpdate?.();
        }}
        ?disabled=${inflight}
        title="Move to column"
        aria-label="Move to column"
      >
        ${TASK_COLUMNS.map(
          (c) => html`<option value=${c.id} ?selected=${c.id === columnId}>${c.label}</option>`,
        )}
      </select>
    </div>
  `;
}

function renderModal(ds: DisciplineState, host: AppViewState): TemplateResult {
  if (!ds.modal) return html``;
  const m = ds.modal;
  return html`
    <div
      class="disc-modal__backdrop"
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) {
          ds.modal = null;
          host.requestUpdate?.();
        }
      }}
    >
      <div class="disc-modal" @click=${(e: Event) => e.stopPropagation()}>
        <div class="disc-modal__title">${m.title}</div>
        <div class="disc-modal__body">${m.body}</div>
        ${m.kind === "prompt"
          ? html`<input
              class="disc-input"
              style="margin-bottom:16px;"
              placeholder=${m.placeholder ?? ""}
              .value=${m.value}
              autofocus
              @input=${(e: Event) => { m.value = (e.target as HTMLInputElement).value; host.requestUpdate?.(); }}
              @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter") void m.onSubmit(m.value); }}
            />`
          : nothing}
        <div class="disc-modal__actions">
          <button class="disc-btn" @click=${() => { ds.modal = null; host.requestUpdate?.(); }}>Cancel</button>
          <button
            class="disc-btn ${m.kind === "confirm" && m.dangerous ? "disc-btn--danger" : "disc-btn--primary"}"
            @click=${() => {
              if (m.kind === "confirm") void m.onConfirm();
              else void m.onSubmit(m.value);
            }}
          >
            ${m.kind === "confirm" ? (m.confirmLabel ?? "Confirm") : "Submit"}
          </button>
        </div>
      </div>
    </div>
  `;
}

function fmtMs(ms: number): string {
  if (!ms || ms < 1000) return "0m";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function fmtTs(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const min = d.getMinutes();
  return `${h < 10 ? "0" : ""}${h}:${min < 10 ? "0" : ""}${min}`;
}

const SOURCE_ICON: Record<string, string> = {
  subagent_registry: "⚙",
  kanban: "☑",
  workflow: "⟳",
  voice: "🎙",
  editor: "✏",
  manual: "✦",
  gateway: "⬡",
};

function renderDailySummary(
  ds: DisciplineState,
  host: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  const summary = ds.workloadSummary;
  const weekly = ds.workloadWeekly ?? [];

  if (!summary && !ds.workloadLoading) return html``;

  const totalMs = summary?.totalMs ?? 0;
  const eventCount = summary?.eventCount ?? 0;

  const maxWeekMs = weekly.reduce((m, d) => Math.max(m, d.totalMs), 1);
  const todayIsoStr = new Date().toISOString().slice(0, 10);

  const byKind = summary?.byKind ?? {};
  const agentMs =
    (byKind.subagent_completed ?? 0) +
    (byKind.subagent_started ?? 0) +
    (byKind.subagent_failed ?? 0);
  const workflowMs = byKind.workflow_run_completed ?? 0;
  const voiceMs = byKind.voice_session_ended ?? 0;
  const kanbanMs = byKind.kanban_task_completed ?? 0;
  const manualMs = byKind.manual ?? 0;

  return html`
    <div class="disc-workload-summary">
      <div class="disc-workload-summary__header">
        <span class="disc-workload-summary__title">Auto-logged · Today</span>
        <span class="disc-workload-summary__total">${fmtMs(totalMs)} tracked · ${eventCount} events</span>
      </div>

      ${totalMs > 0
        ? html`
            <div class="disc-workload-stats">
              ${agentMs > 0
                ? html`<div class="disc-workload-stat">
                    <div class="disc-workload-stat__val">${fmtMs(agentMs)}</div>
                    <div class="disc-workload-stat__lbl">⚙ Agents</div>
                  </div>`
                : nothing}
              ${voiceMs > 0
                ? html`<div class="disc-workload-stat">
                    <div class="disc-workload-stat__val">${fmtMs(voiceMs)}</div>
                    <div class="disc-workload-stat__lbl">🎙 Voice</div>
                  </div>`
                : nothing}
              ${workflowMs > 0
                ? html`<div class="disc-workload-stat">
                    <div class="disc-workload-stat__val">${fmtMs(workflowMs)}</div>
                    <div class="disc-workload-stat__lbl">⟳ Workflows</div>
                  </div>`
                : nothing}
              ${kanbanMs > 0
                ? html`<div class="disc-workload-stat">
                    <div class="disc-workload-stat__val">${fmtMs(kanbanMs)}</div>
                    <div class="disc-workload-stat__lbl">☑ Kanban</div>
                  </div>`
                : nothing}
              ${manualMs > 0
                ? html`<div class="disc-workload-stat">
                    <div class="disc-workload-stat__val">${fmtMs(manualMs)}</div>
                    <div class="disc-workload-stat__lbl">✦ Manual</div>
                  </div>`
                : nothing}
            </div>
          `
        : nothing}

      ${weekly.length > 0
        ? html`
            <div>
              <div class="disc-workload-sparkline-wrap">
                ${weekly.map((d) => {
                  const pct = maxWeekMs > 0 ? Math.max(4, (d.totalMs / maxWeekMs) * 100) : 4;
                  const isToday = d.date === todayIsoStr;
                  const dayName = new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
                  return html`
                    <div style="display:flex;flex-direction:column;align-items:center;">
                      <div style="display:flex;align-items:flex-end;height:36px;width:100%;">
                        <div
                          class="disc-workload-sparkline__bar ${isToday ? "disc-workload-sparkline__bar--today" : ""}"
                          style="width:100%;height:${pct}%;"
                          title="${d.date}: ${fmtMs(d.totalMs)} (${d.eventCount} events)"
                        ></div>
                      </div>
                      <div class="disc-workload-sparkline__lbl">${dayName}</div>
                    </div>
                  `;
                })}
              </div>
            </div>
          `
        : nothing}

      ${(summary?.byProject ?? []).length > 0
        ? html`
            <div class="disc-workload-projects">
              ${summary!.byProject.map((p) => {
                const pct = totalMs > 0 ? (p.totalMs / totalMs) * 100 : 0;
                return html`
                  <div class="disc-workload-proj-bar">
                    <div class="disc-workload-proj-bar__label" title="${p.label}">${p.label}</div>
                    <div class="disc-workload-proj-bar__track">
                      <div class="disc-workload-proj-bar__fill" style="width:${pct}%"></div>
                    </div>
                    <div class="disc-workload-proj-bar__dur">${fmtMs(p.totalMs)}</div>
                  </div>
                `;
              })}
            </div>
          `
        : nothing}

      ${ds.workloadLoading
        ? html`<div style="font-size:10px;color:var(--disc-fg-mute);text-align:center;">Loading…</div>`
        : nothing}
    </div>
  `;
}

function renderAutoLoggedLane(ds: DisciplineState): TemplateResult {
  const events = ds.workEvents ?? [];
  const sorted = [...events].sort((a, b) => a.ts - b.ts);

  return html`
    <div class="disc-autolog" data-learn-id="discipline-autolog">
      <div class="disc-autolog__header">
        <span class="disc-autolog__title">Auto-logged</span>
        ${events.length > 0
          ? html`<span class="disc-autolog__count">${events.length}</span>`
          : nothing}
      </div>
      <div class="disc-autolog__list">
        ${sorted.length === 0
          ? html`<div class="disc-autolog__empty">No activity logged yet today — events appear here as agents run.</div>`
          : sorted.map((evt) => {
              const icon = SOURCE_ICON[evt.source] ?? "·";
              const kindLabel = evt.kind.replace(/_/g, " ");
              return html`
                <div class="disc-autolog__entry" title="${kindLabel}">
                  <span class="disc-autolog__time">${fmtTs(evt.ts)}</span>
                  <span class="disc-autolog__label">
                    ${icon} ${evt.label}
                  </span>
                  <span class="disc-autolog__meta">
                    <span class="disc-autolog__source">${evt.source.replace(/_/g, " ")}</span>
                    ${evt.durationMs != null && evt.durationMs > 0
                      ? html`<span class="disc-autolog__dur">${fmtMs(evt.durationMs)}</span>`
                      : nothing}
                  </span>
                </div>
              `;
            })}
      </div>
    </div>
  `;
}

// ── Active projects strip (synced with Focus) ────────────────────────────────
// Lists the user's kanban projects as toggle chips. A lit chip is part of the
// Focus / "active project" set; clicking routes through Focus so the change is
// reflected on the Focus board and broadcast to any other open view.
function renderFocusProjects(ds: DisciplineState, state: AppViewState): TemplateResult {
  // Only surface projects that are actually being worked on. Kanban projects
  // carry a Notion-style status string ("In progress", "Completed", …); the
  // in-progress state is the canonical "active" one (see kanban.ts isActive).
  const projects = (ds.kanbanProjects ?? []).filter(
    (p) => (p.status ?? "").toLowerCase() === "in progress",
  );
  if ((ds.kanbanProjects ?? []).length === 0) return html``;
  const activeIds = new Set(getDisciplineFocusProjects(state as any));
  const activeCount = activeIds.size;
  return html`
    <div class="disc-focus-projects">
      <span class="disc-focus-projects__label">
        ${icons.star} Active projects
        ${activeCount > 0 ? html`<span class="disc-focus-projects__count">${activeCount}</span>` : nothing}
      </span>
      <div class="disc-focus-projects__chips">
        ${projects.length === 0
          ? html`<span style="font-size:12px;color:var(--disc-fg-faint);">No projects in progress</span>`
          : nothing}
        ${projects.map((p) => {
          const active = activeIds.has(p.id) || isProjectFocused(p.id, state as any);
          return html`
            <button
              class="disc-focus-chip ${active ? "disc-focus-chip--active" : ""}"
              title=${active ? "In Focus — click to remove" : "Add to Focus / active set"}
              @click=${() => {
                toggleProjectActiveFromDiscipline(ds, p.id);
                state.requestUpdate?.();
              }}
            >
              <span class="disc-focus-chip__dot" style=${p.color ? `background:${p.color}` : ""}></span>
              <span class="disc-focus-chip__name">${p.name || "Untitled"}</span>
              <span class="disc-focus-chip__mark">${active ? icons.check : icons.plus}</span>
            </button>
          `;
        })}
      </div>
    </div>
  `;
}

/** Page heading in the shared work-glass style: date eyebrow, title, and a
 *  one-line summary of the day's plan. Purely presentational. */
function renderPageHead(ds: DisciplineState): TemplateResult {
  const scheduled = blocksScheduledToday(ds);
  const doneCount = scheduled.filter((b) => isBlockDoneToday(ds, b.id)).length;
  const dateLabel = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const sub = ds.blocks.length === 0
    ? "Plan the day in blocks, check in as you go, and let the score keep you honest."
    : `${scheduled.length} block${scheduled.length === 1 ? "" : "s"} on today's plan · ${doneCount} done · ${humanDuration(ds.today?.actualMinutes ?? 0)} logged`;
  return wgHero({
    eyebrow: dateLabel,
    title: html`Own the <span class="wg-gold">day</span>`,
    sub,
  });
}

export function renderDiscipline(state: AppViewState, client: GatewayBrowserClient): TemplateResult {
  const ds = (state as any).disciplineState as DisciplineState | undefined;
  if (!ds) {
    return html`${disciplineStyles()}
      <div class="disc-root wg-page">
        ${wgAurora()}
        <div class="disc-skel" aria-busy="true" aria-label="Loading discipline">
          <div class="wg-skel" style="height:28px;width:220px;"></div>
          <div class="wg-skel" style="height:118px;"></div>
          <div class="wg-skel" style="height:52px;"></div>
          <div class="wg-skel" style="height:320px;"></div>
        </div>
      </div>`;
  }
  startDisciplineTicker(
    ds,
    () => {
      if (isBlockDragActive()) return;
      state.requestUpdate?.();
    },
    client,
  );
  setReflectionRequestUpdate(() => { if (!isBlockDragActive()) state.requestUpdate?.(); });
  ensureKeyHandler(ds, state, client);
  ensureFocusChangedHandler(state);
  if (!ds.kanbanLoaded) void loadKanbanLinks(ds, client).then(() => state.requestUpdate?.());

  // Lazy-load workload data once on first render, then every ~60s via ticker.
  const now = Date.now();
  if (!ds.workloadLoading && (ds.workEvents.length === 0 || now - (ds as any)._workloadLastLoad > 60_000)) {
    (ds as any)._workloadLastLoad = now;
    void loadWorkEvents(ds, client).then(() => state.requestUpdate?.());
  }

  return html`
    ${disciplineStyles()}
    <div class="disc-root wg-page">
      ${wgAurora()}
      ${renderPageHead(ds)}
      ${ds.error
        ? html`<div class="disc-error">
            <span>${ds.error}</span>
            <button class="disc-btn" @click=${() => { ds.error = null; state.requestUpdate?.(); }}>Dismiss</button>
          </div>`
        : nothing}
      ${renderHero(ds, state, client)}
      <proactive-panel .client=${client}></proactive-panel>
      ${renderQuickLogBar(ds, state, client)}
      ${renderDailySummary(ds, state, client)}
      ${renderFocusProjects(ds, state)}
      ${renderSubnav(ds, state)}
      ${ds.subView === "timeline" || ds.subView === "blocks"
        ? renderTemplateStrip(ds, state, client)
        : nothing}
      ${ds.subView === "timeline" ? renderTimeline(ds, state, client) : nothing}
      ${ds.subView === "timeline" ? renderAutoLoggedLane(ds) : nothing}
      ${ds.subView === "blocks" ? renderBlocks(ds, state, client) : nothing}
      ${ds.subView === "score" ? renderScore(ds, state, client) : nothing}
      ${ds.subView === "settings" ? renderSettings(ds, state, client) : nothing}
      ${renderModal(ds, state)}
      ${renderTemplateModal(ds, state, client)}
    </div>
  `;
}

/**
 * Persisted UI state for the Oversight page.
 *
 * The Oversight view keeps its filter / expand / acknowledgement state in
 * module-scope `let`s (see ./index.ts). That survives client-side tab
 * navigation (the module is a singleton) but is wiped on every full page
 * reload, which is why the page "kept resetting". This module is the durable
 * mirror: it reads the saved snapshot on import and writes back on every
 * mutation so the user's view survives both navigation AND reloads.
 *
 * Pattern intentionally mirrors ../../lib/biz-filter.ts: a single versioned
 * localStorage key, try/catch around every storage call, and a silent
 * fall-back to in-memory only when storage is unavailable (private mode, SSR).
 */

const STORAGE_KEY = "oversight:v1";
const VERSION = 1;

export type StatusFilter = "all" | string;
export type TimeRange = "all" | "1h" | "24h" | "7d";
export type DecisionFilter = "all" | "pending" | "approved" | "sent_back" | "drift";

/** The full durable snapshot. Plain JSON — no Sets/Maps on the wire. */
export interface OversightPersistedState {
  v: number;
  filterStatus: StatusFilter;
  filterTime: TimeRange;
  filterProject: string;
  filterSearch: string;
  filterHasBlockers: boolean;
  filterDecision: DecisionFilter;
  /** runIds of rows the user has expanded. */
  expandedIds: string[];
  /** runId → acknowledged next-step indices. */
  acked: Array<[string, number[]]>;
  /** Last time the user looked at the page (epoch ms). */
  lastViewedAt: number;
}

const _TIME_RANGES: ReadonlySet<string> = new Set(["all", "1h", "24h", "7d"]);
const _DECISIONS: ReadonlySet<string> = new Set([
  "all",
  "pending",
  "approved",
  "sent_back",
  "drift",
]);

function _defaults(): OversightPersistedState {
  return {
    v: VERSION,
    filterStatus: "all",
    filterTime: "all",
    filterProject: "",
    filterSearch: "",
    filterHasBlockers: false,
    filterDecision: "all",
    expandedIds: [],
    acked: [],
    lastViewedAt: 0,
  };
}

/**
 * Read + validate the saved snapshot. Always returns a complete object so
 * callers never have to null-check. Unknown / older versions fall back to
 * defaults (forward-safe migration hook lives here).
 */
export function loadOversightState(): OversightPersistedState {
  const base = _defaults();
  try {
    if (typeof window === "undefined") return base;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<OversightPersistedState> | null;
    if (!parsed || typeof parsed !== "object") return base;
    // Version gate: anything other than the current shape is treated as
    // "start fresh" rather than risking a half-populated state.
    if (parsed.v !== VERSION) return base;

    return {
      v: VERSION,
      filterStatus: typeof parsed.filterStatus === "string" ? parsed.filterStatus : base.filterStatus,
      filterTime:
        typeof parsed.filterTime === "string" && _TIME_RANGES.has(parsed.filterTime)
          ? (parsed.filterTime as TimeRange)
          : base.filterTime,
      filterProject: typeof parsed.filterProject === "string" ? parsed.filterProject : base.filterProject,
      filterSearch: typeof parsed.filterSearch === "string" ? parsed.filterSearch : base.filterSearch,
      filterHasBlockers:
        typeof parsed.filterHasBlockers === "boolean" ? parsed.filterHasBlockers : base.filterHasBlockers,
      filterDecision:
        typeof parsed.filterDecision === "string" && _DECISIONS.has(parsed.filterDecision)
          ? (parsed.filterDecision as DecisionFilter)
          : base.filterDecision,
      expandedIds: Array.isArray(parsed.expandedIds)
        ? parsed.expandedIds.filter((x): x is string => typeof x === "string")
        : base.expandedIds,
      acked: Array.isArray(parsed.acked)
        ? parsed.acked.filter(
            (pair): pair is [string, number[]] =>
              Array.isArray(pair) &&
              typeof pair[0] === "string" &&
              Array.isArray(pair[1]) &&
              pair[1].every((n) => typeof n === "number"),
          )
        : base.acked,
      lastViewedAt: typeof parsed.lastViewedAt === "number" ? parsed.lastViewedAt : base.lastViewedAt,
    };
  } catch {
    return base;
  }
}

let _writeTimer: ReturnType<typeof setTimeout> | null = null;
let _pending: OversightPersistedState | null = null;

function _flush(): void {
  _writeTimer = null;
  const snap = _pending;
  _pending = null;
  if (!snap) return;
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
  } catch {
    // Storage unavailable — keep the in-memory module state authoritative.
  }
}

/**
 * Persist a snapshot. Debounced (120ms) so rapid mutations — typing in the
 * search box, toggling several chips — collapse into a single write.
 */
export function saveOversightState(snap: OversightPersistedState): void {
  _pending = { ...snap, v: VERSION };
  if (_writeTimer) return;
  try {
    _writeTimer = setTimeout(_flush, 120);
  } catch {
    // setTimeout missing (exotic SSR) — write through synchronously.
    _flush();
  }
}

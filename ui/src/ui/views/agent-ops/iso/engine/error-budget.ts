/**
 * Graceful error budget for world subsystems.
 * ────────────────────────────────────────────
 * A single throwing subsystem (a sprite atlas, a flocking pass, a label
 * renderer) must NEVER blank the canvas. Each subsystem wraps its tick/render
 * in {@link ErrorBudget.runProtected}: a throw is caught, counted, and
 * swallowed so the rest of the frame still runs.
 *
 * If a subsystem throws more than `maxErrors` times within a sliding
 * `windowMs`, it is marked *degraded* and its protected calls are skipped
 * entirely — we stop paying the cost (and log spam) of a subsystem that's
 * clearly broken, while the world keeps rendering everything else. Degradation
 * is surfaced in the telemetry HUD so the failure is visible, not silent.
 */

export interface SubsystemHealth {
  name: string;
  /** Errors currently inside the sliding window. */
  errorCount: number;
  /** Total errors ever (for telemetry). */
  totalErrors: number;
  /** Total protected calls ever. */
  totalCalls: number;
  /** Skipped because degraded. */
  skippedCalls: number;
  degraded: boolean;
  lastError: string | null;
  lastErrorAt: number | null;
}

export interface ErrorBudgetOptions {
  /** Errors-per-window before a subsystem is degraded. Default 5. */
  maxErrors?: number;
  /** Sliding window length in ms. Default 5000. */
  windowMs?: number;
  /** Monotonic ms clock. Default `performance.now`/`Date.now`. */
  now?: () => number;
  /** Sink for error logs. Default `console.error` (throttled per subsystem). */
  logger?: (subsystem: string, err: unknown) => void;
  /** Called once when a subsystem transitions into the degraded state. */
  onDegrade?: (name: string, health: SubsystemHealth) => void;
}

const defaultNow = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

interface Entry {
  name: string;
  timestamps: number[]; // error times inside (or recently inside) the window
  totalErrors: number;
  totalCalls: number;
  skippedCalls: number;
  degraded: boolean;
  lastError: string | null;
  lastErrorAt: number | null;
  loggedDegrade: boolean;
}

export class ErrorBudget {
  private readonly maxErrors: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly logger: (subsystem: string, err: unknown) => void;
  private readonly onDegrade?: (name: string, health: SubsystemHealth) => void;

  private entries = new Map<string, Entry>();

  constructor(opts: ErrorBudgetOptions = {}) {
    this.maxErrors = Math.max(1, opts.maxErrors ?? 5);
    this.windowMs = Math.max(1, opts.windowMs ?? 5000);
    this.now = opts.now ?? defaultNow;
    this.logger =
      opts.logger ??
      ((subsystem, err) =>
        console.error(`[error-budget] ${subsystem}:`, err));
    this.onDegrade = opts.onDegrade;
  }

  /**
   * Run `fn` under the budget for subsystem `name`. Returns `fn`'s result, or
   * `undefined` if it threw or the subsystem is degraded (and was skipped).
   * Never throws.
   */
  runProtected<T>(name: string, fn: () => T): T | undefined {
    const e = this.entryFor(name);
    e.totalCalls++;

    if (e.degraded) {
      e.skippedCalls++;
      return undefined;
    }

    try {
      return fn();
    } catch (err) {
      this.recordError(e, err);
      return undefined;
    }
  }

  isDegraded(name: string): boolean {
    return this.entries.get(name)?.degraded ?? false;
  }

  /** Clear a subsystem's error window and un-degrade it (e.g. after a reload). */
  reset(name: string): void {
    const e = this.entries.get(name);
    if (!e) return;
    e.timestamps = [];
    e.degraded = false;
    e.loggedDegrade = false;
  }

  resetAll(): void {
    for (const name of this.entries.keys()) this.reset(name);
  }

  /** Snapshot of every known subsystem's health (for the telemetry overlay). */
  snapshot(): SubsystemHealth[] {
    const t = this.now();
    const out: SubsystemHealth[] = [];
    for (const e of this.entries.values()) {
      this.evictOld(e, t);
      out.push({
        name: e.name,
        errorCount: e.timestamps.length,
        totalErrors: e.totalErrors,
        totalCalls: e.totalCalls,
        skippedCalls: e.skippedCalls,
        degraded: e.degraded,
        lastError: e.lastError,
        lastErrorAt: e.lastErrorAt,
      });
    }
    return out;
  }

  /** The most recent error across all subsystems, if any. */
  lastError(): { subsystem: string; message: string; at: number } | null {
    let best: { subsystem: string; message: string; at: number } | null = null;
    for (const e of this.entries.values()) {
      if (e.lastError != null && e.lastErrorAt != null) {
        if (!best || e.lastErrorAt > best.at) {
          best = { subsystem: e.name, message: e.lastError, at: e.lastErrorAt };
        }
      }
    }
    return best;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private entryFor(name: string): Entry {
    let e = this.entries.get(name);
    if (!e) {
      e = {
        name,
        timestamps: [],
        totalErrors: 0,
        totalCalls: 0,
        skippedCalls: 0,
        degraded: false,
        lastError: null,
        lastErrorAt: null,
        loggedDegrade: false,
      };
      this.entries.set(name, e);
    }
    return e;
  }

  private recordError(e: Entry, err: unknown): void {
    const t = this.now();
    e.totalErrors++;
    e.lastError = errMessage(err);
    e.lastErrorAt = t;
    e.timestamps.push(t);
    this.evictOld(e, t);
    this.logger(e.name, err);

    if (!e.degraded && e.timestamps.length > this.maxErrors) {
      e.degraded = true;
      if (!e.loggedDegrade) {
        e.loggedDegrade = true;
        this.logger(
          e.name,
          `subsystem degraded after ${e.timestamps.length} errors in ${this.windowMs}ms — skipping future calls`,
        );
      }
      this.onDegrade?.(e.name, this.healthOf(e));
    }
  }

  private evictOld(e: Entry, t: number): void {
    const cutoff = t - this.windowMs;
    let i = 0;
    while (i < e.timestamps.length && e.timestamps[i] < cutoff) i++;
    if (i > 0) e.timestamps.splice(0, i);
  }

  private healthOf(e: Entry): SubsystemHealth {
    return {
      name: e.name,
      errorCount: e.timestamps.length,
      totalErrors: e.totalErrors,
      totalCalls: e.totalCalls,
      skippedCalls: e.skippedCalls,
      degraded: e.degraded,
      lastError: e.lastError,
      lastErrorAt: e.lastErrorAt,
    };
  }
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

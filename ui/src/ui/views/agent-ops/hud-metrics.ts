/**
 * HUD live metrics for the agent world map (ONLINE AGENTS · TOOLS / MIN ·
 * TOKENS / HR). Pure + DOM/Pixi-free so it's unit-testable and so the numbers
 * come from the same live agent mirror the Active Agents list renders — not
 * from engine sprite bookkeeping (which also holds resting finished runs and
 * only refreshed on rendered frames).
 */

/** Statuses that mean the run is over (resting on a bed / walking off). */
const TERMINAL_STATUSES = new Set([
  "completed",
  "complete",
  "done",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "killed",
  "aborted",
  "timeout",
  "timed_out",
]);

export function isOnlineStatus(status: string | undefined | null): boolean {
  return !TERMINAL_STATUSES.has(String(status ?? "").toLowerCase());
}

export interface HudAgentLike {
  sessionKey: string;
  status?: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface HudStats {
  online: number;
  toolsPerMin: number;
  /** null = no usage data reported by any agent (render "—", not a fake 0). */
  tokensPerHr: number | null;
}

const TOOL_WINDOW_MS = 60_000;
const TOKEN_WINDOW_MS = 60 * 60_000;
/** Minimum observation span before a tokens/hr extrapolation is shown. */
const TOKEN_MIN_SPAN_MS = 20_000;

function tokensOf(a: HudAgentLike): number | null {
  const t = a.totalTokens ?? ((a.inputTokens ?? 0) + (a.outputTokens ?? 0));
  return Number.isFinite(t) && t > 0 ? t : null;
}

export class HudStatsTracker {
  private toolTimes: number[] = [];
  /** Per-agent last seen token total (baseline for deltas). */
  private lastTokens = new Map<string, number>();
  /** Positive token deltas observed live: [t, delta]. */
  private tokenDeltas: Array<[number, number]> = [];
  private firstTokenSampleAt: number | null = null;
  private sawUsage = false;

  noteTool(now: number): void {
    this.toolTimes.push(now);
    if (this.toolTimes.length > 1024) this.toolTimes.splice(0, this.toolTimes.length - 1024);
  }

  /**
   * Sample per-agent token totals. The first sighting of an agent only sets
   * its baseline (history before we started watching isn't "this hour"); later
   * growth is recorded as a delta. Agents leaving the set don't read as a drop.
   */
  noteTokens(agents: Iterable<HudAgentLike>, now: number): void {
    for (const a of agents) {
      const t = tokensOf(a);
      if (t === null) continue;
      this.sawUsage = true;
      if (this.firstTokenSampleAt === null) this.firstTokenSampleAt = now;
      const prev = this.lastTokens.get(a.sessionKey);
      if (prev !== undefined && t > prev) this.tokenDeltas.push([now, t - prev]);
      this.lastTokens.set(a.sessionKey, t);
    }
  }

  compute(agents: Iterable<HudAgentLike>, now: number): HudStats {
    let online = 0;
    for (const a of agents) if (isOnlineStatus(a.status)) online += 1;

    const toolCutoff = now - TOOL_WINDOW_MS;
    while (this.toolTimes.length && this.toolTimes[0] < toolCutoff) this.toolTimes.shift();

    const tokCutoff = now - TOKEN_WINDOW_MS;
    while (this.tokenDeltas.length && this.tokenDeltas[0][0] < tokCutoff) this.tokenDeltas.shift();
    let tokensPerHr: number | null = null;
    if (this.sawUsage && this.firstTokenSampleAt !== null) {
      const span = Math.min(now - this.firstTokenSampleAt, TOKEN_WINDOW_MS);
      if (span >= TOKEN_MIN_SPAN_MS) {
        const sum = this.tokenDeltas.reduce((s, [, d]) => s + d, 0);
        tokensPerHr = (sum / span) * TOKEN_WINDOW_MS;
      }
    }
    return { online, toolsPerMin: this.toolTimes.length, tokensPerHr };
  }
}

export function formatHudNumber(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + "k";
  return String(Math.round(n));
}

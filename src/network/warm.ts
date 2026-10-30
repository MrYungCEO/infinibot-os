/**
 * Warm score — how "warm" a relationship is right now, 0-100.
 *
 * One pure function so the graph, the side panel, the AI context and the ring
 * layout all agree. Signals come from what the network already tracks:
 *
 *   recency        last touch (contact or any of its connections), half-life 45 days
 *   strength       strongest live connection (Strained counts half, Ended not at all)
 *   frequency      tracked interactions in the last 90 days (touches, status moves, links…)
 *   opportunities  open deals riding on the person
 *   reciprocity    mutual beats one-way
 *   links          workspace objects linked to the person (projects, notes, tasks…)
 *
 * The owner can override the computed score per contact (`warmOverride`); the
 * computed value and its breakdown are still returned so the override is never
 * a black box.
 */

export const WARM_WEIGHTS = {
  recency: 35,
  strength: 20,
  frequency: 15,
  opportunities: 15,
  reciprocity: 5,
  links: 10,
} as const;
export type WarmFactor = keyof typeof WARM_WEIGHTS;

/** Days for the recency contribution to halve. */
export const RECENCY_HALF_LIFE_DAYS = 45;
/** Interactions in the window that max out the frequency factor. */
export const FREQUENCY_CAP = 8;
export const OPPORTUNITY_CAP = 3;
export const LINKS_CAP = 5;
/** Window for counting interactions. */
export const FREQUENCY_WINDOW_DAYS = 90;

export interface WarmConnectionSignal {
  strength: number;
  status: string;
  direction: string;
}

export interface WarmSignals {
  /** Days since the latest touch; null = never touched. */
  staleDays: number | null;
  /** The person's connections (to the owner and to others). */
  connections: WarmConnectionSignal[];
  /** Tracked interactions in the last {@link FREQUENCY_WINDOW_DAYS} days. */
  interactions: number;
  openOpportunities: number;
  linkedObjects: number;
}

export type WarmBreakdown = Record<WarmFactor, number>;

export interface WarmResult {
  /** The score to show and lay out by (override when set). */
  score: number;
  /** The formula's score, even when overridden. */
  computed: number;
  overridden: boolean;
  breakdown: WarmBreakdown;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Clean an owner override: a number 0-100, else null (no override). */
export function normalizeWarmOverride(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(100, Math.max(0, n)));
}

export function computeWarmScore(s: WarmSignals, override?: number | null): WarmResult {
  // Never touched → 0; today (or a future-dated touch) → full marks.
  const recency =
    s.staleDays === null
      ? 0
      : s.staleDays <= 0
        ? 1
        : Math.pow(0.5, s.staleDays / RECENCY_HALF_LIFE_DAYS);
  let bestStrength = 0;
  let reciprocity = 0;
  for (const c of s.connections) {
    const status = String(c.status).toLowerCase();
    if (status === "ended") continue;
    const k = status === "strained" ? 0.5 : status === "dormant" ? 0.75 : 1;
    bestStrength = Math.max(bestStrength, clamp01((Number(c.strength) - 1) / 4) * k);
    reciprocity = Math.max(reciprocity, String(c.direction).toLowerCase() === "mutual" ? 1 : 0.5);
  }
  const parts: Record<WarmFactor, number> = {
    recency: clamp01(recency),
    strength: bestStrength,
    frequency: clamp01(s.interactions / FREQUENCY_CAP),
    opportunities: clamp01(s.openOpportunities / OPPORTUNITY_CAP),
    reciprocity,
    links: clamp01(s.linkedObjects / LINKS_CAP),
  };
  const breakdown = {} as WarmBreakdown;
  let total = 0;
  for (const f of Object.keys(WARM_WEIGHTS) as WarmFactor[]) {
    breakdown[f] = round1(parts[f] * WARM_WEIGHTS[f]);
    total += parts[f] * WARM_WEIGHTS[f];
  }
  const computed = Math.round(Math.min(100, Math.max(0, total)));
  const ov = normalizeWarmOverride(override);
  return { score: ov ?? computed, computed, overridden: ov !== null, breakdown };
}

// ═══════════════════════════════════════════════════════════════════
// RING BANDS
// ═══════════════════════════════════════════════════════════════════

export const WARM_BANDS = [
  // Tuned so a strong mutual tie touched in the last few weeks reads "Active"
  // and only people with momentum (deals, frequent touches, links) are inner.
  { id: "inner", label: "Inner circle", min: 70 },
  { id: "active", label: "Active", min: 45 },
  { id: "warmable", label: "Warm-able", min: 20 },
  { id: "dormant", label: "Dormant", min: 0 },
] as const;
export type WarmBandId = (typeof WARM_BANDS)[number]["id"];

export function warmBand(score: number): WarmBandId {
  const s = Number.isFinite(score) ? score : 0;
  for (const b of WARM_BANDS) if (s >= b.min) return b.id;
  return "dormant";
}

export type WarmTrend = "warming" | "cooling" | "steady" | "new";

/** Trend vs an earlier score: ±5 points or more is a move. */
export function warmTrend(current: number, previous: number | null | undefined): WarmTrend {
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return "new";
  const d = current - previous;
  if (d >= 5) return "warming";
  if (d <= -5) return "cooling";
  return "steady";
}

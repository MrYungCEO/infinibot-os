/**
 * Daily usage limit in the hosted app (Free: 30 active minutes a day): what the
 * meter says, which upsell to show, and when the gate goes up. Pure: no DOM, no
 * fetch (daily-limit.ts renders it). The server decides every number; this only
 * presents them. docs/saas/FREE_PLAN.md.
 */

/** GET /api/usage, POST /api/usage/heartbeat, /fleet/resolve (src/saas/cloud/daily-usage.ts). */
export type DailyUsageView = {
  limited: boolean;
  plan: string;
  limitMinutes: number | null;
  baseLimitMinutes?: number | null;
  grantedMinutes?: number;
  usedMinutes: number;
  remainingMinutes: number | null;
  reached: boolean;
  day: string;
  timezone?: string;
  resetsAt: string;
  heartbeatSeconds?: number;
  activeWindowSeconds?: number;
};

/** A paid plan the gate offers (GET /api/usage `upgrade`, from the plans table). */
export type UpgradePlan = {
  id: string;
  name: string;
  priceUsdMonth: number;
  alwaysOn: boolean;
  idleMinutes: number | null;
  memoryMb: number | null;
  parallelAgents: number | null;
  parallelCoders: number | null;
  voice: boolean;
};

/** The three in-app upsells, each shown at most once per usage day. */
export type UpsellId = "used10" | "left10" | "left3";

/**
 * Upsell thresholds (minutes). With the Free default of 30 min/day they fire at
 * 10 used (min 10), 10 left (min 20) and 3 left (min 27). The limit itself comes
 * from the server, so for any other limit (an owner grant, a plan an admin edits):
 *   - "left" thresholds are driven by remaining minutes; "used" by used minutes;
 *   - "10 used" only shows while more than 10 are left (it never follows
 *     "10 left"), so it is skipped when limit <= USED + LEFT (<= 20 min);
 *   - "10 left" / "3 left" are skipped when the limit itself is at or under that
 *     threshold (you'd be "10 min left" from the first minute: nothing crossed).
 * The most urgent applicable one always wins; passed ones are marked done.
 */
export const UPSELL_USED_AT = 10;
export const UPSELL_LEFT_AT = 10;
export const UPSELL_LAST_AT = 3;

/** Order the upsells pass in during a day. */
export const UPSELL_ORDER: readonly UpsellId[] = ["used10", "left10", "left3"];

export type Upsell = {
  id: UpsellId;
  /** toast = a corner card; modal = a centred, dismissible dialog (never blocking). */
  style: "toast" | "modal";
  eyebrow: string;
  title: string;
  body: string;
  bullets: string[];
  cta: string;
};

const BENEFITS = {
  unlimited: "Unlimited time, every day",
  alwaysOn: "Hosted gateway that stays on 24/7",
  agents: "Up to 8 agents in parallel",
  voice: "Voice with your agents",
};

/** Today's allowance in minutes (limit, else used + remaining); null when unknown. */
export function allowanceMinutes(v: Pick<DailyUsageView, "limitMinutes" | "usedMinutes" | "remainingMinutes">): number | null {
  if (typeof v.limitMinutes === "number" && v.limitMinutes > 0) return v.limitMinutes;
  if (typeof v.remainingMinutes === "number") return Math.max(0, v.usedMinutes) + Math.max(0, v.remainingMinutes);
  return null;
}

/** Which upsell the current standing earns, most urgent first; null = none. */
export function upsellFor(v: DailyUsageView | null | undefined): UpsellId | null {
  if (!v?.limited || v.reached || v.remainingMinutes == null) return null;
  const left = v.remainingMinutes;
  const limit = allowanceMinutes(v) ?? 0;
  if (left <= UPSELL_LAST_AT && limit > UPSELL_LAST_AT) return "left3";
  if (left <= UPSELL_LEFT_AT && limit > UPSELL_LEFT_AT) return "left10";
  if (left > UPSELL_LEFT_AT && v.usedMinutes >= UPSELL_USED_AT) return "used10";
  return null;
}

/** The upsell to show now, skipping ones already shown today. Less urgent ones are superseded. */
export function nextUpsell(v: DailyUsageView | null | undefined, shown: ReadonlySet<UpsellId>): UpsellId | null {
  const id = upsellFor(v);
  return id && !shown.has(id) ? id : null;
}

/** Ids a standing has passed (a later one implies the earlier ones are done for today). */
export function passedUpsells(id: UpsellId): UpsellId[] {
  return UPSELL_ORDER.slice(0, UPSELL_ORDER.indexOf(id) + 1);
}

/** "today's free 30 minutes" (or "today's free time" when the limit is unknown). */
export function freeAllowancePhrase(v: Pick<DailyUsageView, "limitMinutes" | "usedMinutes" | "remainingMinutes">): string {
  const limit = allowanceMinutes(v);
  return limit ? `today's free ${limit} minute${limit === 1 ? "" : "s"}` : "today's free time";
}

export function upsellCopy(id: UpsellId, v: DailyUsageView): Upsell {
  const left = Math.max(0, v.remainingMinutes ?? 0);
  const limit = allowanceMinutes(v);
  switch (id) {
    case "used10":
      return {
        id,
        style: "toast",
        eyebrow: `${v.usedMinutes} minutes in`,
        title: limit ? `${v.usedMinutes} of your ${limit} free minutes used` : `${v.usedMinutes} free minutes used`,
        body: "You're building momentum. Pro keeps it going: no clock, and agents that keep working after you close the tab.",
        bullets: [BENEFITS.unlimited, BENEFITS.alwaysOn],
        cta: "Upgrade to Pro",
      };
    case "left10":
      return {
        id,
        style: "toast",
        eyebrow: `${UPSELL_LEFT_AT} minutes left today`,
        title: `${left} min left of ${freeAllowancePhrase(v)}`,
        body: "Upgrade now and nothing stops: your workspace, agents and voice stay right where you left them.",
        bullets: [BENEFITS.unlimited, BENEFITS.agents, BENEFITS.voice],
        cta: "Upgrade to Pro",
      };
    case "left3":
      return {
        id,
        style: "modal",
        eyebrow: "Almost out of time",
        title: `${left} minute${left === 1 ? "" : "s"} left today`,
        body: "When today's free minutes run out, your workspace pauses until the reset. Upgrade to Pro to keep going without interruption.",
        bullets: [BENEFITS.unlimited, BENEFITS.alwaysOn, BENEFITS.agents, BENEFITS.voice],
        cta: "Upgrade to Pro",
      };
  }
}

/** Gate headline: "You've used today's free 30 minutes". */
export function gateTitle(v: DailyUsageView): string {
  return `You've used ${freeAllowancePhrase(v)}`;
}

/** "38 min left today" / "1 h left today" / "Daily limit reached". */
export function meterLabel(v: DailyUsageView): string {
  if (v.reached) return "Daily limit reached";
  const left = Math.max(0, v.remainingMinutes ?? 0);
  if (left >= 60 && left % 60 === 0) return `${left / 60} h left today`;
  if (left > 60) return `${Math.floor(left / 60)} h ${left % 60} min left today`;
  return `${left} min left today`;
}

export type MeterTone = "ok" | "warn" | "low" | "out";

export function meterTone(v: DailyUsageView): MeterTone {
  if (v.reached) return "out";
  const left = v.remainingMinutes ?? 0;
  if (left <= UPSELL_LAST_AT) return "low";
  if (left <= UPSELL_LEFT_AT) return "warn";
  return "ok";
}

/** Fraction of today's allowance used, 0–1. */
export function usedFraction(v: DailyUsageView): number {
  const limit = v.limitMinutes ?? 0;
  return limit > 0 ? Math.max(0, Math.min(1, v.usedMinutes / limit)) : 0;
}

/** "07:42:13" until the reset (never negative). */
export function countdown(resetsAt: string, now = Date.now()): string {
  const ms = Math.max(0, Date.parse(resetsAt) - now);
  if (!Number.isFinite(ms)) return "--:--:--";
  const s = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** "at 12:00 AM" in the member's own clock (the server sends their local midnight). */
export function resetClock(resetsAt: string): string {
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return "at midnight";
  return `at ${new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/** True for the typed limit error any gated endpoint returns (HTTP 402). */
export function isDailyLimitError(body: unknown): body is { code: "daily_limit_reached"; resetsAt: string; usage?: DailyUsageView } {
  const b = body as { code?: unknown; status?: unknown; resetsAt?: unknown } | null;
  return (
    !!b &&
    (b.code === "daily_limit_reached" || b.status === "daily_limit_reached") &&
    typeof b.resetsAt === "string"
  );
}

/** A view from a 402 body (falls back to a minimal "reached" view when `usage` is absent). */
export function viewFromLimitError(body: { resetsAt: string; usage?: DailyUsageView; plan?: string }): DailyUsageView {
  return (
    body.usage ?? {
      limited: true,
      plan: body.plan ?? "free",
      limitMinutes: null,
      usedMinutes: 0,
      remainingMinutes: 0,
      reached: true,
      day: "",
      resetsAt: body.resetsAt,
    }
  );
}

/** Plan cards for the gate: the real paid plans, cheapest first, Pro highlighted. */
export function gatePlans(plans: UpgradePlan[]): Array<UpgradePlan & { hot: boolean; perks: string[] }> {
  return plans
    .filter((p) => p.priceUsdMonth > 0)
    .slice(0, 3)
    .map((p) => {
      const perks = ["Unlimited daily time"];
      perks.push(p.alwaysOn ? "Always-on hosted gateway" : `Wakes on use, sleeps after ${p.idleMinutes ?? 15} min idle`);
      if (p.parallelAgents) perks.push(`${p.parallelAgents} agents in parallel${p.parallelCoders ? ` (${p.parallelCoders} coding)` : ""}`);
      if (p.memoryMb) perks.push(`${p.memoryMb >= 1024 ? `${p.memoryMb / 1024} GB` : `${p.memoryMb} MB`} private machine`);
      if (p.voice) perks.push("Voice with your agents");
      return { ...p, hot: p.id === "pro", perks };
    });
}

/** Plans the checkout sells (netlify/functions/whop-checkout.mts). */
export const CHECKOUT_PLAN_IDS = ["starter", "pro", "business", "scale"] as const;

/** The once-per-day memory key for upsells. */
export function upsellStoreKey(userId: string | undefined, day: string): string {
  return `infinibot.cloud.dailyUpsell.${userId ?? "anon"}.${day}`;
}

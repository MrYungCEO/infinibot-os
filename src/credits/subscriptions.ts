/**
 * Flat-rate subscriptions store.
 *
 * Tracks committed $/month plans the user pays for (e.g. Ollama Cloud at
 * $20/mo). Lives at `~/.infinibot/subscriptions.json`. On first read the file
 * is auto-seeded with the Ollama Cloud default so the dashboard has something
 * meaningful to show out of the box.
 *
 * This is distinct from `src/budget/subscriptions.ts`, which describes how a
 * provider is routed (plan tier, CLI mapping). Those entries don't carry a
 * monthly $ commitment. This module is purely about the cash side of the
 * ledger — what's already spent regardless of token usage.
 */
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("credits").child("subscriptions");

export interface FlatRateSubscription {
  id: string;
  provider: string;
  plan: string;
  monthlyAmountUsd: number;
  /** ISO date string. The billing period for "now" is computed from this. */
  billingAnchor: string;
  isActive: boolean;
  notes?: string;
}

export interface SubscriptionPeriod {
  start: number;
  end: number;
  /** Pro-rated $ for the current period. Equal to monthlyAmountUsd unless the anchor lands mid-period. */
  periodCostUsd: number;
}

export interface SubscriptionWithPeriod extends FlatRateSubscription {
  period: SubscriptionPeriod;
}

const DEFAULTS: FlatRateSubscription[] = [
  {
    id: "ollama-cloud-default",
    provider: "ollama-cloud",
    plan: "Ollama Cloud",
    monthlyAmountUsd: 20,
    billingAnchor: new Date().toISOString(),
    isActive: true,
    notes: "Default seed. Edit ~/.infinibot/subscriptions.json to customize.",
  },
];

function subscriptionsPath(): string {
  return path.join(resolveStateDir(), "subscriptions.json");
}

function ensureSeed(): FlatRateSubscription[] {
  const p = subscriptionsPath();
  if (!fs.existsSync(p)) {
    try {
      fs.mkdirSync(resolveStateDir(), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ subscriptions: DEFAULTS }, null, 2), "utf8");
      log.info("seeded ~/.infinibot/subscriptions.json with Ollama Cloud $20/mo default");
    } catch (e) {
      log.warn("could not write seed subscriptions.json", { err: String(e) });
    }
    return DEFAULTS;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as { subscriptions?: unknown };
    if (Array.isArray(raw.subscriptions)) {
      return raw.subscriptions
        .filter((s) => s && typeof s === "object")
        .map((s) => normalize(s as Partial<FlatRateSubscription>));
    }
  } catch (e) {
    log.warn("failed to read subscriptions.json — falling back to defaults", { err: String(e) });
  }
  return DEFAULTS;
}

function normalize(raw: Partial<FlatRateSubscription>): FlatRateSubscription {
  return {
    id:
      typeof raw.id === "string" && raw.id
        ? raw.id
        : `sub_${Math.random().toString(36).slice(2, 10)}`,
    provider: typeof raw.provider === "string" ? raw.provider : "unknown",
    plan: typeof raw.plan === "string" ? raw.plan : "subscription",
    monthlyAmountUsd:
      typeof raw.monthlyAmountUsd === "number" && Number.isFinite(raw.monthlyAmountUsd)
        ? Math.max(0, raw.monthlyAmountUsd)
        : 0,
    billingAnchor:
      typeof raw.billingAnchor === "string" ? raw.billingAnchor : new Date().toISOString(),
    isActive: raw.isActive !== false,
    notes: typeof raw.notes === "string" ? raw.notes : undefined,
  };
}

export function listSubscriptions(): FlatRateSubscription[] {
  return ensureSeed();
}

export function listActiveSubscriptions(): FlatRateSubscription[] {
  return listSubscriptions().filter((s) => s.isActive);
}

/**
 * Period the subscription covers around `now`. We use a simple monthly
 * window anchored to the 1st of the current UTC month — flat-rate plans
 * typically prorate to calendar months, and pulling the anchor day from
 * billingAnchor would conflict with the calendar-month grouping the rest
 * of the credits view uses.
 */
export function currentPeriod(now: number = Date.now()): { start: number; end: number } {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { start, end };
}

export function withPeriod(
  sub: FlatRateSubscription,
  now: number = Date.now(),
): SubscriptionWithPeriod {
  const { start, end } = currentPeriod(now);
  return {
    ...sub,
    period: {
      start,
      end,
      periodCostUsd: sub.isActive ? sub.monthlyAmountUsd : 0,
    },
  };
}

/** Total $ committed to active subscriptions in the current calendar month. */
export function totalActiveCommitmentUsd(now: number = Date.now()): number {
  return listActiveSubscriptions().reduce((sum, s) => sum + s.monthlyAmountUsd, 0);
}

/** Replace the entire subscriptions list (used by future settings UI). */
export function writeSubscriptions(subs: FlatRateSubscription[]): void {
  const p = subscriptionsPath();
  fs.mkdirSync(resolveStateDir(), { recursive: true });
  const normalized = subs.map((s) => normalize(s));
  fs.writeFileSync(p, JSON.stringify({ subscriptions: normalized }, null, 2), "utf8");
}

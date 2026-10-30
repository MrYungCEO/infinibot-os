/**
 * Tier facts for <plan-limit-modal>, kept free of Lit so they can be tested in node.
 *
 * Caps come straight from src/agents/plan-limits.ts (what the runtime gate enforces);
 * price/RAM mirror site/content/plans.mjs (drift-checked against the plan seed and the
 * orchestrator). `extra` states what each tier's hosted Machine runs
 * (docs/saas/HOSTED_FEATURES.md).
 */
import { PLAN_LIMITS, type PlanTier } from "../../../../src/agents/plan-limits.js";

export type TierInfo = {
  name: string;
  price: number;
  agents: number;
  coders: number;
  ram: string;
  builds: number;
  browsers: number;
  extra: string;
};

const tier = (id: PlanTier, name: string, price: number, ram: string, extra: string): TierInfo => ({
  name,
  price,
  ram,
  extra,
  ...PLAN_LIMITS[id],
});

const sessions = (id: PlanTier) =>
  `${PLAN_LIMITS[id].browsers} browser session${PLAN_LIMITS[id].browsers === 1 ? "" : "s"}`;

export const PLAN_LIMIT_TIERS: Readonly<Record<PlanTier, TierInfo>> = {
  starter: tier("starter", "Starter", 19, "2 GB", "Sleeps when idle; Telegram and schedules wake it"),
  pro: tier("pro", "Pro", 49, "2 GB", "Always-on: 24/7 channels incl. WhatsApp + scheduled jobs"),
  business: tier("business", "Business", 99, "4 GB", `${sessions("business")}, 24/7 channels + jobs`),
  scale: tier("scale", "Scale", 199, "8 GB", `${sessions("scale")}, priority capacity`),
};

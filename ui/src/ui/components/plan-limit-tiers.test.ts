import { describe, expect, it } from "vitest";
import { PLAN_LIMITS, PLAN_ORDER } from "../../../../src/agents/plan-limits.js";
import { PLAN_LIMIT_TIERS } from "./plan-limit-tiers.js";

// site/content/plans.mjs is plain ESM without types; load it by path.
const sitePlans = new URL("../../../../site/content/plans.mjs", import.meta.url).href;

describe("plan-limit modal tiers", () => {
  it("caps come from PLAN_LIMITS (agents, coders, builds)", () => {
    for (const id of PLAN_ORDER) {
      const t = PLAN_LIMIT_TIERS[id];
      expect([t.agents, t.coders, t.builds]).toEqual([PLAN_LIMITS[id].agents, PLAN_LIMITS[id].coders, PLAN_LIMITS[id].builds]);
    }
  });

  it("price and RAM match the drift-checked site plans", async () => {
    const { PAID } = (await import(/* @vite-ignore */ sitePlans)) as {
      PAID: Array<{ id: string; name: string; price: number; machine: { ramGb: number } }>;
    };
    for (const p of PAID) {
      const t = PLAN_LIMIT_TIERS[p.id as keyof typeof PLAN_LIMIT_TIERS];
      expect([t.name, t.price, t.ram]).toEqual([p.name, p.price, `${p.machine.ramGb} GB`]);
    }
  });

  it("does not sell hosted voice, which isn't live yet", () => {
    for (const t of Object.values(PLAN_LIMIT_TIERS)) {
      expect(t.extra).not.toMatch(/voice/i);
    }
  });

  it("browser session counts come from PLAN_LIMITS", () => {
    expect(PLAN_LIMIT_TIERS.business.extra).toContain(`${PLAN_LIMITS.business.browsers} browser sessions`);
    expect(PLAN_LIMIT_TIERS.scale.extra).toContain(`${PLAN_LIMITS.scale.browsers} browser sessions`);
  });
});

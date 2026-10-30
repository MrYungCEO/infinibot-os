import { describe, expect, it } from "vitest";
import {
  PLAN_LIMITS,
  PLAN_RUN_MODE,
  PLAN_ORDER,
  nextPlan,
  normalizePlan,
  resolvePlanLimits,
  runModeAllowsWhatsApp,
} from "./plan-limits.js";

describe("plan limits", () => {
  it("maps each tier to its agent, coder, build and browser caps", () => {
    expect(PLAN_LIMITS).toEqual({
      free: { agents: 2, coders: 1, builds: 1, browsers: 1 },
      starter: { agents: 4, coders: 1, builds: 1, browsers: 1 },
      pro: { agents: 8, coders: 2, builds: 1, browsers: 1 },
      business: { agents: 16, coders: 4, builds: 2, browsers: 4 },
      scale: { agents: 24, coders: 12, builds: 3, browsers: 8 },
    });
  });

  it("only the wake tier sleeps, and it gets no WhatsApp", () => {
    expect(PLAN_RUN_MODE).toEqual({
      free: "wake",
      starter: "wake",
      pro: "always-on",
      business: "always-on",
      scale: "always-on",
    });
    expect(runModeAllowsWhatsApp("wake")).toBe(false);
    expect(runModeAllowsWhatsApp("always-on")).toBe(true);
  });

  it("every tier up the ladder gets strictly more agents and coders, never fewer builds", () => {
    for (let i = 1; i < PLAN_ORDER.length; i++) {
      const lo = PLAN_LIMITS[PLAN_ORDER[i - 1]];
      const hi = PLAN_LIMITS[PLAN_ORDER[i]];
      expect(hi.agents).toBeGreaterThan(lo.agents);
      expect(hi.coders).toBeGreaterThan(lo.coders);
      expect(hi.builds).toBeGreaterThanOrEqual(lo.builds);
    }
  });

  it("coders are a subset of agents on every tier", () => {
    for (const t of PLAN_ORDER) {
      expect(PLAN_LIMITS[t].coders).toBeLessThanOrEqual(PLAN_LIMITS[t].agents);
      expect(PLAN_LIMITS[t].coders).toBeGreaterThanOrEqual(1);
    }
  });

  it("hosted Free has its own caps, below Starter (docs/saas/FREE_PLAN.md)", () => {
    expect(resolvePlanLimits("free")).toEqual({
      plan: "free",
      agents: 2,
      coders: 1,
      builds: 1,
      browsers: 1,
    });
    expect(PLAN_LIMITS.free.agents).toBeLessThan(PLAN_LIMITS.starter.agents);
    expect(nextPlan("free")).toBe("starter");
  });

  it("unknown / empty plans fall back to the starter caps", () => {
    for (const raw of [undefined, null, "", "mystery"]) {
      expect(resolvePlanLimits(raw)).toEqual({
        plan: "starter",
        agents: 4,
        coders: 1,
        builds: 1,
        browsers: 1,
      });
    }
  });

  it("normalizes case; legacy team (2 GB always-on Machine) gets Pro's caps", () => {
    expect(normalizePlan(" PRO ")).toBe("pro");
    expect(normalizePlan("team")).toBe("pro");
    expect(resolvePlanLimits("team")).toEqual({ plan: "pro", ...PLAN_LIMITS.pro });
  });

  it("owner plans are unlimited", () => {
    expect(resolvePlanLimits("ceo")).toEqual({
      plan: "unlimited",
      agents: null,
      coders: null,
      builds: null,
      browsers: null,
    });
    expect(nextPlan("ceo")).toBeNull();
  });

  it("offers the next tier up", () => {
    expect(nextPlan("starter")).toBe("pro");
    expect(nextPlan("pro")).toBe("business");
    expect(nextPlan("business")).toBe("scale");
    expect(nextPlan("scale")).toBeNull();
  });
});

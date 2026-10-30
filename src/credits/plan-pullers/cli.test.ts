/**
 * Verifies that CLI plan detection never silently overrides a manually-pinned
 * plan, and always surfaces the detected plan as a suggestion.
 */
import { describe, expect, it } from "vitest";
import { cliBackedUsage, type CliPlanProbe } from "./cli.js";
import type { ProviderPlanConfig } from "../plan-config.js";

function cfg(over: Partial<ProviderPlanConfig> = {}): ProviderPlanConfig {
  return { provider: "anthropic", plan: "pro", updatedAt: 0, ...over };
}

const okProbe = (plan?: string): CliPlanProbe => ({
  cli: "claude",
  installed: true,
  authState: "ok",
  plan,
  message: "ok",
  durationMs: 1,
});

describe("cliBackedUsage manual-vs-auto plan resolution", () => {
  it("auto mode (default): CLI-detected plan drives the effective plan", () => {
    const u = cliBackedUsage(cfg({ plan: "pro", auto: true }), okProbe("max"));
    expect(u.plan).toBe("max");
    expect(u.detectedPlan).toBe("max");
  });

  it("auto undefined behaves as auto-on", () => {
    const u = cliBackedUsage(cfg({ plan: "pro", auto: undefined }), okProbe("max"));
    expect(u.plan).toBe("max");
  });

  it("manual mode (auto:false): keeps the pinned plan, still reports detected", () => {
    const u = cliBackedUsage(cfg({ plan: "pro", auto: false }), okProbe("max"));
    expect(u.plan).toBe("pro"); // NOT overridden by the CLI
    expect(u.detectedPlan).toBe("max"); // surfaced for "use detected?" prompt
  });

  it("manual mode with matching detected plan: no conflict", () => {
    const u = cliBackedUsage(cfg({ plan: "max", auto: false }), okProbe("max"));
    expect(u.plan).toBe("max");
    expect(u.detectedPlan).toBe("max");
  });

  it("auto mode with no detectable plan falls back to stored plan", () => {
    const u = cliBackedUsage(cfg({ plan: "pro", auto: true }), okProbe(undefined));
    expect(u.plan).toBe("pro");
    expect(u.detectedPlan).toBeUndefined();
  });
});

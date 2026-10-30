import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Low-power mode (ui/src/ui/perf.ts: 4 cores or fewer, 4 GB or less, or
 * prefers-reduced-motion) sets <html class="low-power">, and low-power.css
 * then strips EVERY animation (`animation: none !important`). So nothing on
 * the hosted setup surfaces may depend on an animation to become visible: the
 * resting style of each element has to be its final, readable state.
 *
 * The quickstart's "blast doors" once rested closed and only the animation
 * opened them: on such a device they covered the whole console and a new
 * member saw "Welcome to InfiniBot" over an empty panel.
 */
const here = path.dirname(new URL(import.meta.url).pathname);
const read = (rel: string) => fs.readFileSync(path.resolve(here, rel), "utf8");

const SURFACES = [
  "./saas-onboarding.ts",
  "../onboarding/console-styles.ts",
  "../onboarding/console-chrome.ts",
  "./local-setup.ts",
  "./saas-onboarding-setup.ts",
  "../saas-terminal-ambient.ts",
  "../saas-auth-views.ts",
  "../cloud/workspace-loader.ts",
  "../cloud/cloud-setup.ts",
  "../cloud/fleet-connect.ts",
];

/** Declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
}

describe("hosted setup: visible without animations (low-power mode)", () => {
  const onboarding = read("../onboarding/console-styles.ts");

  it("the console doors rest open; only the keyframes close them", () => {
    expect(rule(onboarding, ".sob-door--top")).toContain("transform: translateY(-101%)");
    expect(rule(onboarding, ".sob-door--bottom")).toContain("transform: translateY(101%)");
    expect(onboarding).toContain("@keyframes sob-door-top { from { transform: none; }");
    expect(onboarding).toContain("@keyframes sob-door-bottom { from { transform: none; }");
  });

  it("the doors never take pointer events", () => {
    expect(rule(onboarding, ".sob-console__doors")).toContain("pointer-events: none");
  });

  it("one-shot overlays (seam, sheen, shockwave, exit flash) rest invisible", () => {
    expect(rule(onboarding, ".sob-console__doors::after")).toContain("opacity: 0");
    expect(rule(onboarding, ".sob-unlock::after")).toContain("transform: translateX(100%)");
    expect(rule(onboarding, ".sob-done__wave")).toContain("opacity: 0");
    expect(rule(onboarding, ".sob-flash")).toContain("opacity: 0");
  });

  it("no setup surface hides content at rest and reveals it only by animation", () => {
    const offenders: string[] = [];
    for (const file of SURFACES) {
      // A rule that sets opacity: 0 and then relies on a forwards-filled animation.
      for (const m of read(file).matchAll(/\{[^{}]*opacity:\s*0;[^{}]*animation:[^;{}]*\bforwards\b[^{}]*\}/g)) {
        // The exit flash is the one allowed case: a one-shot overlay that rests invisible on purpose.
        if (/animation:\s*sob-flash\b/.test(m[0])) continue;
        offenders.push(`${file}: ${m[0].replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

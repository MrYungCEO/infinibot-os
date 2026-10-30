/**
 * Guided walkthrough engine in a real browser: step lifecycle (locate → act →
 * check → branch), skip / back, missing targets never trap the user, Esc exits,
 * resume after reload, shadow-DOM targets, and the auto (audit) mode.
 *
 *   pnpm -C ui vitest run --config vitest.browser.config.ts src/learn/guided/engine.browser.test.ts
 *   (PLAYWRIGHT_CHROMIUM_PATH=/opt/google/chrome/chrome to use an installed Chrome), or,
 *   without the vitest browser provider:
 *   node scripts/learn/run-browser-test.mjs ui/src/learn/guided/engine.browser.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LearnWalkthrough, PublicLearnTrack } from "../../../../src/learn/guided/types.js";
import { __resetGuidedStoreForTests, __seedGuidedForTests, guidedState } from "./catalog-store";
import {
  auditWalkthrough,
  doItForMe,
  exitTour,
  nextStep,
  prevStep,
  resumeIfPending,
  startWalkthrough,
  tourState,
} from "./engine";
import { deepQueryAll, resolveTarget } from "./resolve-target";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 4000): Promise<void> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error("condition not reached");
}

function wt(id: string, steps: LearnWalkthrough["steps"]): LearnWalkthrough {
  return { id, title: id, summary: "s", estMinutes: 1, steps };
}

function seed(walkthroughs: LearnWalkthrough[]): void {
  const track: PublicLearnTrack = {
    id: "t",
    title: "Test track",
    summary: "s",
    overview: "o",
    category: "Test",
    level: "beginner",
    walkthroughs,
    quiz: [],
    badge: { id: "b", label: "Badge" },
  };
  __seedGuidedForTests({ tracks: [track], source: "local", missions: [] });
}

function box(html: string): HTMLElement {
  const host = document.createElement("div");
  host.id = "fixture";
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

beforeEach(() => {
  __resetGuidedStoreForTests();
  localStorage.clear();
});
afterEach(() => {
  exitTour();
  document.getElementById("fixture")?.remove();
});

describe("target resolution", () => {
  it("expands learn: ids, tries fallbacks in order, pierces shadow roots, skips hidden", () => {
    const host = box(`<div data-learn-id="a" style="width:10px;height:10px"></div><div class="hidden" style="display:none"></div><x-host></x-host>`);
    const shadowHost = host.querySelector("x-host")!;
    const sr = shadowHost.attachShadow({ mode: "open" });
    sr.innerHTML = `<button class="inner" style="width:20px;height:20px">in shadow</button>`;
    expect(resolveTarget("learn:a")?.getAttribute("data-learn-id")).toBe("a");
    expect(resolveTarget([".hidden", ".inner"])?.textContent).toBe("in shadow");
    expect(resolveTarget(".nope")).toBeNull();
    expect(deepQueryAll(".inner")).toHaveLength(1);
  });
});

describe("step lifecycle", () => {
  it("waits for the target, then Next/Back move through steps and finishing marks it complete", async () => {
    box(`<div data-learn-id="one" style="width:40px;height:20px">one</div>`);
    seed([wt("w", [
      { id: "s1", title: "S1", body: "b", target: "learn:one" },
      { id: "s2", title: "S2", body: "b" },
    ])]);
    await startWalkthrough("t", "w");
    await until(() => tourState().phase === "ready");
    expect(tourState().step?.id).toBe("s1");
    expect(tourState().target?.getAttribute("data-learn-id")).toBe("one");
    nextStep();
    await until(() => tourState().step?.id === "s2" && tourState().phase === "ready");
    prevStep();
    await until(() => tourState().step?.id === "s1" && tourState().phase === "ready");
    nextStep();
    await until(() => tourState().step?.id === "s2" && tourState().phase === "ready");
    nextStep();
    await until(() => tourState().phase === "done");
    await until(() => guidedState().progress.walkthroughs["t/w"]?.status === "completed");
  });

  it("Next is inert until a click action happens on the target", async () => {
    const host = box(`<button data-learn-id="btn" style="width:40px;height:20px">go</button>`);
    seed([wt("w", [
      { id: "click", title: "Click", body: "b", target: "learn:btn", action: { kind: "click" } },
      { id: "after", title: "After", body: "b" },
    ])]);
    await startWalkthrough("t", "w");
    await until(() => tourState().phase === "waiting-action");
    nextStep(); // not ready → ignored
    await sleep(100);
    expect(tourState().step?.id).toBe("click");
    host.querySelector("button")!.click();
    await until(() => tourState().step?.id === "after");
  });

  it("input actions require the typed value to match", async () => {
    const host = box(`<input data-learn-id="field" style="width:80px;height:20px" />`);
    seed([wt("w", [
      { id: "type", title: "Type", body: "b", target: "learn:field", action: { kind: "input", match: "goal" } },
      { id: "after", title: "After", body: "b" },
    ])]);
    await startWalkthrough("t", "w");
    await until(() => tourState().phase === "waiting-action");
    const input = host.querySelector("input")!;
    input.value = "nothing";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await sleep(400);
    expect(tourState().step?.id).toBe("type");
    input.value = "My Goal";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    await until(() => tourState().step?.id === "after");
  });

  it("input actions work on <select> (choose an option)", async () => {
    const host = box(`<select data-learn-id="pick" style="width:80px;height:20px"><option value="">—</option><option value="kanban">Kanban</option></select>`);
    seed([wt("w", [
      { id: "pick", title: "Pick", body: "b", target: "learn:pick", action: { kind: "input", match: "kanban" } },
      { id: "after", title: "After", body: "b" },
    ])]);
    await startWalkthrough("t", "w");
    await until(() => tourState().phase === "waiting-action");
    doItForMe();
    await until(() => tourState().step?.id === "after");
    expect((host.querySelector("select") as HTMLSelectElement).value).toBe("kanban");
  });

  it("'Do it for me' performs a toggle action", async () => {
    let toggled = false;
    const host = box(`<button role="switch" data-learn-id="sw" style="width:40px;height:20px"></button>`);
    host.querySelector("button")!.addEventListener("click", () => (toggled = true));
    seed([wt("w", [
      { id: "toggle", title: "Toggle", body: "b", target: "learn:sw", action: { kind: "toggle" } },
      { id: "after", title: "After", body: "b" },
    ])]);
    await startWalkthrough("t", "w");
    await until(() => tourState().phase === "waiting-action");
    doItForMe();
    await until(() => tourState().step?.id === "after");
    expect(toggled).toBe(true);
  });

  it("skipIf skips; branches jump; checks gate Next until they hold", async () => {
    const host = box(`<div data-learn-id="present" style="width:10px;height:10px"></div>`);
    seed([wt("w", [
      { id: "skipped", title: "Skipped", body: "b", skipIf: { kind: "element", target: "learn:present" } },
      { id: "branch", title: "Branch", body: "b", branches: [{ when: { kind: "element", target: "learn:present" }, goto: "gated" }] },
      { id: "never", title: "Never", body: "b" },
      { id: "gated", title: "Gated", body: "b", check: { kind: "element", target: "learn:late" } },
      { id: "end", title: "End", body: "b" },
    ])]);
    await startWalkthrough("t", "w");
    await until(() => tourState().step?.id === "branch" && tourState().phase === "ready");
    expect(tourState().results[0]).toMatchObject({ stepId: "skipped", skipped: true });
    nextStep();
    await until(() => tourState().step?.id === "gated" && tourState().phase === "checking");
    nextStep(); // check not satisfied yet
    await sleep(150);
    expect(tourState().step?.id).toBe("gated");
    const late = document.createElement("div");
    late.dataset.learnId = "late";
    late.style.cssText = "width:10px;height:10px";
    host.appendChild(late);
    await until(() => tourState().phase === "ready", 3000);
    nextStep();
    await until(() => tourState().step?.id === "end");
  });

  it("a missing target never traps the user: it offers skip", async () => {
    seed([wt("w", [
      { id: "ghost", title: "Ghost", body: "b", target: "learn:does-not-exist", waitMs: 300 },
      { id: "after", title: "After", body: "b" },
    ])]);
    await startWalkthrough("t", "w");
    await until(() => tourState().phase === "missing");
    nextStep(true);
    await until(() => tourState().step?.id === "after");
    expect(tourState().results[0]).toMatchObject({ stepId: "ghost", skipped: true });
  });

  it("explain-only practice steps never wait for an action", async () => {
    box(`<button data-learn-id="buy" style="width:40px;height:20px">Buy</button>`);
    seed([wt("w", [
      { id: "order", title: "Order ticket", body: "b", target: "learn:buy", practice: { mode: "explain", note: "Orders are gated." } },
      { id: "after", title: "After", body: "b" },
    ])]);
    await startWalkthrough("t", "w");
    await until(() => tourState().phase === "ready");
    expect(tourState().step?.practice?.mode).toBe("explain");
  });
});

describe("overlay + persistence", () => {
  it("Esc exits the tour from anywhere", async () => {
    box(`<div data-learn-id="one" style="width:40px;height:20px"></div>`);
    seed([wt("w", [{ id: "s1", title: "S1", body: "b", target: "learn:one" }, { id: "s2", title: "S2", body: "b" }])]);
    await startWalkthrough("t", "w");
    await until(() => Boolean(document.querySelector("guided-tour-overlay")) && tourState().phase === "ready");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await until(() => tourState().phase === "idle");
    expect(localStorage.getItem("infinibot.learn.tour.v1")).toBeNull();
  });

  it("resumes an interrupted tour at the same step after a reload", async () => {
    seed([wt("w", [{ id: "s1", title: "S1", body: "b" }, { id: "s2", title: "S2", body: "b" }, { id: "s3", title: "S3", body: "b" }])]);
    await startWalkthrough("t", "w");
    await until(() => tourState().phase === "ready");
    nextStep();
    await until(() => tourState().step?.id === "s2");
    const saved = localStorage.getItem("infinibot.learn.tour.v1");
    expect(JSON.parse(saved!)).toMatchObject({ trackId: "t", walkthroughId: "w", stepId: "s2" });
    // Simulate a reload: engine forgets its in-memory state, storage survives.
    exitTour();
    localStorage.setItem("infinibot.learn.tour.v1", saved!);
    expect(await resumeIfPending()).toBe(true);
    await until(() => tourState().step?.id === "s2");
    expect(tourState().resumed).toBe(true);
  });
});

describe("auto (audit) mode", () => {
  it("performs actions itself and reports every step", async () => {
    const host = box(`<button data-learn-id="a" style="width:40px;height:20px">a</button><input data-learn-id="b" style="width:80px;height:20px" />`);
    let clicked = 0;
    host.querySelector("button")!.addEventListener("click", () => clicked++);
    seed([wt("w", [
      { id: "intro", title: "Intro", body: "b" },
      { id: "click", title: "Click", body: "b", target: "learn:a", action: { kind: "click" } },
      { id: "type", title: "Type", body: "b", target: "learn:b", action: { kind: "input", match: "hello", sample: "hello world" } },
      { id: "missing", title: "Missing", body: "b", target: "learn:nope", waitMs: 200 },
    ])]);
    const rep = await auditWalkthrough("t", "w", 20000);
    expect(clicked).toBe(1);
    expect((host.querySelector("input") as HTMLInputElement).value).toBe("hello world");
    expect(rep.finished).toBe(true);
    expect(rep.results.map((r) => [r.stepId, r.ok])).toEqual([
      ["intro", true],
      ["click", true],
      ["type", true],
      ["missing", false],
    ]);
    // Audits never write progress.
    expect(guidedState().progress.walkthroughs["t/w"]).toBeUndefined();
  });
});

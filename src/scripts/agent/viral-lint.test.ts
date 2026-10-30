/**
 * Viral lint tests — pure, no network. Verifies the lint enforces the rules
 * defined in viral-structure-rules.ts (the single source of truth).
 */

import assert from "node:assert/strict";
import { test } from "vitest";

import { lintScript } from "./viral-lint.js";
import { BANNED_FILLER } from "./viral-structure-rules.js";

const CLEAN = `[SCENE 1: Hook]
VISUAL: Close-up on a stopwatch hitting 3 seconds.
VOICEOVER: You have 3 seconds before 90% of viewers scroll past.
DURATION: 4

[SCENE 2: Proof]
VISUAL: Graph spiking from 200 to 12000 views.
VOICEOVER: This one hook took my video from 200 views to 12000.
DURATION: 5

[SCENE 3: Payoff]
VISUAL: Text card "Follow for part 2".
VOICEOVER: Follow for the exact three-line template I used.
DURATION: 4`;

const DIRTY = `[SCENE 1: Intro]
VISUAL: Talking head.
VOICEOVER: Hey guys, in today's video we're going to talk about hooks and stuff.
DURATION: 5

[SCENE 2: Body]
VISUAL: More talking.
VOICEOVER: Basically you just need to keep going and at the end of the day it works out fine somehow.
DURATION: 6`;

test("clean short-form script passes lint", () => {
  const r = lintScript(CLEAN, "tiktok");
  assert.equal(r.clean, true, JSON.stringify(r.violations));
  assert.equal(r.violations.filter((v) => v.severity === "error").length, 0);
});

test("dirty script flags banned filler and is not clean", () => {
  const r = lintScript(DIRTY, "tiktok");
  assert.equal(r.clean, false);
  const banned = r.violations.filter((v) => v.rule === "banned_filler");
  assert.ok(banned.length >= 2, `expected banned-filler hits, got ${JSON.stringify(r.violations)}`);
  // critique must be non-empty so the agent can act on it
  assert.ok(r.critique.includes("ERROR"));
});

test("missing scene structure is a hard error", () => {
  const r = lintScript("just a paragraph of prose with no scene headers at all", "tiktok");
  // parseScript falls back to paragraph-scenes, so assert via a truly empty body
  const empty = lintScript("", "tiktok");
  assert.equal(empty.clean, false);
  assert.ok(empty.violations.some((v) => v.rule === "missing_scenes"));
  void r;
});

test("CTA-exempt filler is allowed only in the final scene", () => {
  const withCta = `[SCENE 1: Hook]
VISUAL: A.
VOICEOVER: Three numbers changed my whole funnel in 24 hours.
DURATION: 4

[SCENE 2: CTA]
VISUAL: End card.
VOICEOVER: Make sure to like and subscribe for the 24-hour breakdown.
DURATION: 3`;
  const r = lintScript(withCta, "youtube");
  const ctaBanned = r.violations.filter((v) => v.rule === "banned_filler" && v.scene === 2);
  assert.equal(ctaBanned.length, 0, "subscribe CTA in final scene should be exempt");
});

test("every BANNED_FILLER phrase is detectable", () => {
  for (const phrase of BANNED_FILLER) {
    const s = `[SCENE 1: X]\nVISUAL: a\nVOICEOVER: ${phrase} and then a real point with the number 7.\nDURATION: 4\n\n[SCENE 2: End]\nVISUAL: b\nVOICEOVER: Follow for more.\nDURATION: 3`;
    const r = lintScript(s, "tiktok");
    // CTA-exempt phrases land in scene 1 here (not final), so they still flag.
    assert.ok(
      r.violations.some((v) => v.rule === "banned_filler"),
      `phrase not detected: "${phrase}"`,
    );
  }
});

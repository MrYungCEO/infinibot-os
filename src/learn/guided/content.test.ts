/**
 * Content gate for guided Learn: every core track and every first-party
 * plugin learn.json must validate, meet the curriculum bar (overview, 3–6
 * walkthroughs, a quiz, a badge) and keep risky steps explain-only.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CORE_MISSIONS, CORE_TRACKS } from "./core/index.js";
import type { LearnStep, LearnTrack } from "./types.js";
import { parseLearnContribution, parseTrack } from "./validate.js";

const ROOT = path.resolve(__dirname, "../../..");
const EXT = path.join(ROOT, "extensions");

type PluginLearn = { dir: string; id: string; manifestLearn: unknown; raw: unknown };

function pluginLearnFiles(): PluginLearn[] {
  const out: PluginLearn[] = [];
  for (const dir of fs.readdirSync(EXT)) {
    const file = path.join(EXT, dir, "learn.json");
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(
      fs.readFileSync(path.join(EXT, dir, "infinibot.plugin.json"), "utf8"),
    );
    out.push({
      dir,
      id: manifest.id,
      manifestLearn: manifest.contributes?.learn,
      raw: JSON.parse(fs.readFileSync(file, "utf8")),
    });
  }
  return out;
}

/** Words that mean a control has real-world side effects. */
const RISKY =
  /\b(place (an |the )?order|buy|sell|swap|sign(ing)? (a |the )?transaction|send (a |the )?(message|email|sms)|transfer|withdraw|deposit|execute (a )?trade|go live|launch (a |the )?token)\b/i;

function riskyActionSteps(track: LearnTrack): string[] {
  const bad: string[] = [];
  for (const w of track.walkthroughs) {
    for (const s of w.steps as LearnStep[]) {
      if (!s.action || s.action.kind === "navigate") continue;
      if (RISKY.test(`${s.title} ${s.body}`) && !s.practice)
        bad.push(`${track.id}/${w.id}/${s.id}`);
    }
  }
  return bad;
}

function assertCurriculum(t: LearnTrack) {
  expect(t.overview.length, `${t.id} overview`).toBeGreaterThan(80);
  expect(t.walkthroughs.length, `${t.id} walkthrough count`).toBeGreaterThanOrEqual(3);
  expect(t.walkthroughs.length, `${t.id} walkthrough count`).toBeLessThanOrEqual(6);
  expect(t.quiz.length, `${t.id} quiz`).toBeGreaterThanOrEqual(3);
  expect(t.badge.label.length).toBeGreaterThan(0);
  for (const w of t.walkthroughs) {
    expect(w.steps.length, `${t.id}/${w.id} steps`).toBeGreaterThanOrEqual(3);
    expect(
      w.steps.some((s) => s.target),
      `${t.id}/${w.id} spotlights something`,
    ).toBe(true);
  }
}

describe("core guided tracks", () => {
  it("has all 16 core tracks", () => {
    expect(CORE_TRACKS.map((t) => t.id).sort()).toEqual(
      [
        "agents",
        "channels",
        "chat-models",
        "documents",
        "getting-started",
        "goals",
        "mcp-skills",
        "mobile-app",
        "phases-queue",
        "plugins-marketplace",
        "projects",
        "scheduled-approvals",
        "security",
        "sidebar",
        "voice",
        "workspace",
      ].sort(),
    );
  });

  for (const t of CORE_TRACKS) {
    it(`${t.id} validates and meets the curriculum bar`, () => {
      const parsed = parseTrack(t);
      expect(parsed.ok ? null : parsed.error).toBeNull();
      assertCurriculum(t);
      expect(riskyActionSteps(t)).toEqual([]);
      expect(t.pluginId).toBeUndefined();
    });
  }

  it("missions point at real walkthroughs", () => {
    for (const m of CORE_MISSIONS) {
      const [tid, wid] = m.walkthrough.split("/");
      const t = CORE_TRACKS.find((x) => x.id === tid);
      expect(
        t?.walkthroughs.some((w) => w.id === wid),
        m.walkthrough,
      ).toBe(true);
    }
  });

  it("track ids are unique across core + plugins", () => {
    const ids = CORE_TRACKS.map((t) => t.id);
    for (const p of pluginLearnFiles()) {
      const parsed = parseLearnContribution(p.id, p.raw);
      if (parsed.ok) ids.push(...parsed.learn.tracks.map((t) => t.id));
    }
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("first-party plugin learn.json", () => {
  const EXPECTED = [
    "business-agency",
    "infinitrade",
    "solatrix",
    "infinicode",
    "robovoice",
    "omniclinic",
    "flypic",
    "discipline",
    "content-studio",
    "products",
    "whiteboard",
    "canvas-library",
  ];

  it("every first-party plugin ships a track", () => {
    const ids = pluginLearnFiles().map((p) => p.id);
    for (const id of EXPECTED) expect(ids, id).toContain(id);
  });

  for (const p of pluginLearnFiles()) {
    it(`${p.id}: declared in the manifest, validates, meets the bar`, () => {
      expect(p.manifestLearn).toBe("learn.json");
      const parsed = parseLearnContribution(p.id, p.raw);
      expect(parsed.ok ? null : parsed.error).toBeNull();
      if (!parsed.ok) return;
      for (const t of parsed.learn.tracks) {
        assertCurriculum(t);
        expect(riskyActionSteps(t)).toEqual([]);
        expect(t.pluginId).toBe(p.id);
        expect(t.routes?.length, `${t.id} routes (Learn this)`).toBeGreaterThan(0);
      }
    });
  }

  it("trading and on-chain tracks never wait for an order / swap / signature", () => {
    for (const p of pluginLearnFiles().filter((x) => ["infinitrade", "solatrix"].includes(x.id))) {
      const parsed = parseLearnContribution(p.id, p.raw);
      if (!parsed.ok) continue;
      const practiced = parsed.learn.tracks.flatMap((t) =>
        t.walkthroughs.flatMap((w) => w.steps.filter((s) => s.practice)),
      );
      expect(practiced.length, `${p.id} has explained (not performed) risky steps`).toBeGreaterThan(
        0,
      );
      for (const t of parsed.learn.tracks)
        for (const w of t.walkthroughs)
          for (const s of w.steps)
            if (
              /\b(orders?|swaps?|sign|trades?|buy|sell|execute)\b/i.test(`${s.title}`) &&
              s.action &&
              s.action.kind !== "navigate"
            )
              expect(s.practice?.mode, `${t.id}/${w.id}/${s.id}`).toBe("sandbox");
    }
  });

  it("OmniClinic track carries a medical disclaimer", () => {
    const oc = pluginLearnFiles().find((p) => p.id === "omniclinic");
    const parsed = oc && parseLearnContribution(oc.id, oc.raw);
    expect(parsed && parsed.ok && parsed.learn.tracks[0]?.disclaimer).toMatch(/medical/i);
  });
});

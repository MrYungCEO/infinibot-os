/**
 * Guided Learn backend: manifest `contributes.learn` validation, catalog
 * plugin-enabled gating, per-user progress persistence, badges + cert ladder.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildContributionCatalog } from "../../plugins/contributions.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import { parseManifestV2 } from "../../plugins/manifest-v2.js";
import { buildGuidedCatalog, type CatalogPluginInput } from "./catalog.js";
import { GuidedProgressStore } from "./progress-store.js";
import { computeBadges, computeCertLadder, recommendTracks } from "./status.js";
import {
  isReadOnlyMethod,
  stripQuizAnswers,
  trackStatus,
  type GuidedProgress,
  type LearnTrack,
} from "./types.js";
import { parseLearnContribution, parseTrack } from "./validate.js";

const tmp: string[] = [];
function tempDir(): string {
  const d = path.join(os.tmpdir(), `learn-guided-${randomUUID()}`);
  fs.mkdirSync(d, { recursive: true });
  tmp.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function track(id: string, over: Partial<LearnTrack> = {}): Record<string, unknown> {
  return {
    id,
    title: `${id} title`,
    summary: "A summary.",
    overview: "An overview long enough to explain things.",
    category: "Test",
    level: "beginner",
    walkthroughs: [
      {
        id: "one",
        title: "One",
        summary: "First walkthrough.",
        estMinutes: 2,
        steps: [
          { id: "a", title: "A", body: "Body.", target: "learn:a" },
          {
            id: "b",
            title: "B",
            body: "Body.",
            route: "/x",
            target: ".b",
            action: { kind: "click" },
          },
        ],
      },
      {
        id: "two",
        title: "Two",
        summary: "Second walkthrough.",
        estMinutes: 3,
        steps: [{ id: "c", title: "C", body: "Body." }],
      },
    ],
    quiz: [
      { id: "q1", prompt: "Q1?", options: ["a", "b"], answer: 1 },
      { id: "q2", prompt: "Q2?", options: ["a", "b", "c"], answer: 0 },
    ],
    badge: { id: `${id}-b`, label: `${id} badge` },
    ...over,
  };
}

function manifest(id: string, learn: unknown) {
  return {
    manifestVersion: 2,
    id,
    configSchema: { type: "object", additionalProperties: false, properties: {} },
    engines: { "infinibot-plugin-api": "^2.0.0" },
    contributes: {
      pages: [{ tab: id, route: `/${id}`, builtin: id }],
      learn,
    },
  };
}

describe("contributes.learn — manifest validation", () => {
  it("accepts an inline learn block and namespaces tracks to the plugin", () => {
    const res = parseManifestV2("demo", manifest("demo", { tracks: [track("demo")] }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const learn = res.fields.contributes.learn!;
    expect(learn.tracks[0]!.pluginId).toBe("demo");
    expect(learn.tracks[0]!.estMinutes).toBe(5);
    // The contribution catalog lists the track so the owner can toggle it live.
    expect(res.fields.catalog.items.find((i) => i.key === "learn:demo")).toMatchObject({
      kind: "learn",
      live: true,
      toggleable: true,
    });
  });

  it("resolves a learn.json file inside the plugin", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "learn.json"),
      JSON.stringify({
        tracks: [track("demo")],
        missions: [{ walkthrough: "demo/one", starter: true }],
      }),
    );
    fs.writeFileSync(
      path.join(dir, "infinibot.plugin.json"),
      JSON.stringify(manifest("demo", "learn.json")),
    );
    const res = loadPluginManifest(dir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.v2?.contributes.learn?.tracks.map((t) => t.id)).toEqual(["demo"]);
    expect(res.manifest.v2?.contributes.learn?.missions).toEqual([
      { walkthrough: "demo/one", starter: true },
    ]);
  });

  it("fails closed: missing file, escaping path, bad content", () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, "infinibot.plugin.json"),
      JSON.stringify(manifest("demo", "nope.json")),
    );
    expect(loadPluginManifest(dir)).toMatchObject({
      ok: false,
      error: expect.stringContaining("could not be read"),
    });
    fs.writeFileSync(
      path.join(dir, "infinibot.plugin.json"),
      JSON.stringify(manifest("demo", "../outside.json")),
    );
    expect(loadPluginManifest(dir)).toMatchObject({
      ok: false,
      error: expect.stringContaining("inside the plugin"),
    });
    fs.writeFileSync(path.join(dir, "learn.json"), JSON.stringify({ tracks: [track("other")] }));
    fs.writeFileSync(
      path.join(dir, "infinibot.plugin.json"),
      JSON.stringify(manifest("demo", { file: "learn.json" })),
    );
    expect(loadPluginManifest(dir)).toMatchObject({
      ok: false,
      error: expect.stringContaining('must be named "demo"'),
    });
  });

  it("rejects malformed steps, conditions and quizzes with a precise error", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [track("demo", { walkthroughs: [] }), /needs walkthroughs/],
      [
        track("demo", {
          quiz: [{ id: "q", prompt: "?", options: ["a", "b"], answer: 5 }] as never,
        }),
        /answer must index/,
      ],
      [
        track("demo", {
          walkthroughs: [
            {
              id: "w",
              title: "W",
              summary: "S",
              estMinutes: 1,
              steps: [{ id: "s", title: "S", body: "B", action: { kind: "click" } }],
            },
          ] as never,
        }),
        /needs a target/,
      ],
      [
        track("demo", {
          walkthroughs: [
            {
              id: "w",
              title: "W",
              summary: "S",
              estMinutes: 1,
              steps: [
                {
                  id: "s",
                  title: "S",
                  body: "B",
                  check: { kind: "rpc", method: "infinitrade.order.place" },
                },
              ],
            },
          ] as never,
        }),
        /not a read-only method/,
      ],
      [
        track("demo", {
          walkthroughs: [
            {
              id: "w",
              title: "W",
              summary: "S",
              estMinutes: 1,
              steps: [
                {
                  id: "s",
                  title: "Place order",
                  body: "B",
                  target: ".buy",
                  action: { kind: "click" },
                  practice: { mode: "explain", note: "Explained only." },
                },
              ],
            },
          ] as never,
        }),
        /must not require an action/,
      ],
      [
        track("demo", {
          walkthroughs: [
            {
              id: "w",
              title: "W",
              summary: "S",
              estMinutes: 1,
              steps: [
                {
                  id: "s",
                  title: "S",
                  body: "B",
                  branches: [{ when: { kind: "route", path: "/x" }, goto: "zz" }],
                },
              ],
            },
          ] as never,
        }),
        /branch goto "zz"/,
      ],
      [track("demo", { requires: { kind: "bogus" } as never }), /unknown condition kind/],
    ];
    for (const [raw, re] of cases) {
      const res = parseLearnContribution("demo", { tracks: [raw] });
      expect(res.ok, String(re)).toBe(false);
      if (!res.ok) expect(res.error).toMatch(re);
    }
    expect(
      parseLearnContribution("demo", { tracks: [track("demo")], missions: ["demo/missing"] }),
    ).toMatchObject({ ok: false });
  });

  it("classifies read-only RPCs", () => {
    for (const m of [
      "plugins.list",
      "goals.list",
      "infinitrade.settings.get",
      "learn.guided.catalog",
      "verification.status",
      "solatrix.wallets.list",
    ])
      expect(isReadOnlyMethod(m), m).toBe(true);
    for (const m of [
      "plugins.setEnabled",
      "infinitrade.order.place",
      "solatrix.swap.execute",
      "sessions.send",
      "goals.create",
      "kanban.tasks.delete",
      "notstring",
    ])
      expect(isReadOnlyMethod(m), m).toBe(false);
  });

  it("buildContributionCatalog tolerates a bare learn list", () => {
    const cat = buildContributionCatalog({ contributes: { learn: [{ id: "x", title: "X" }] } });
    expect(cat.items.map((i) => i.key)).toEqual(["learn:x"]);
  });
});

describe("catalog gating", () => {
  const parsed = parseLearnContribution("demo", {
    tracks: [track("demo"), track("demo-advanced")],
    missions: [{ walkthrough: "demo/one", starter: true }],
  });
  if (!parsed.ok) throw new Error(parsed.error);
  const core = parseTrack(track("core-a"));
  if (!core.ok) throw new Error(core.error);
  const coreSet = { tracks: [core.value], missions: [] };
  const base: CatalogPluginInput = {
    id: "demo",
    name: "Demo",
    enabled: true,
    status: "loaded",
    learn: parsed.learn,
    monogram: "DM",
  };

  it("lists plugin tracks only while the plugin is enabled and loaded", () => {
    expect(buildGuidedCatalog([base], coreSet).tracks.map((t) => t.id)).toEqual([
      "core-a",
      "demo",
      "demo-advanced",
    ]);
    for (const off of [{ enabled: false }, { status: "disabled" }, { status: "error" }]) {
      const cat = buildGuidedCatalog([{ ...base, ...off }], coreSet);
      expect(cat.tracks.map((t) => t.id)).toEqual(["core-a"]);
      expect(cat.plugins).toEqual([]);
      expect(cat.missions).toEqual([]);
    }
  });

  it("drops a track the owner switched off (learn:<id>) and its missions", () => {
    const cat = buildGuidedCatalog([{ ...base, disabledContributions: ["learn:demo"] }], coreSet);
    expect(cat.tracks.map((t) => t.id)).toEqual(["core-a", "demo-advanced"]);
    expect(cat.missions).toEqual([]);
    expect(cat.plugins[0]).toMatchObject({
      id: "demo",
      monogram: "DM",
      trackIds: ["demo-advanced"],
    });
  });

  it("never lets a plugin shadow a core track id", () => {
    const clash = parseLearnContribution("core-a", { tracks: [track("core-a")] });
    if (!clash.ok) throw new Error(clash.error);
    const cat = buildGuidedCatalog([{ ...base, id: "core-a", learn: clash.learn }], coreSet);
    expect(cat.tracks.filter((t) => t.id === "core-a")).toHaveLength(1);
    expect(cat.tracks[0]!.pluginId).toBeUndefined();
  });

  it("strips quiz answers for clients", () => {
    const pub = stripQuizAnswers(core.value);
    expect(pub.quiz.every((q) => !("answer" in q))).toBe(true);
  });
});

describe("progress persistence", () => {
  it("persists per user across store instances (gateway restart / other device)", () => {
    const dir = tempDir();
    const a = new GuidedProgressStore(dir);
    a.step("u1", "demo/one", "a", true);
    a.step("u1", "demo/one", "b", false);
    a.recordQuiz("u1", "demo", 1, 2, false);
    a.setPref("u1", "missionsDismissed", true);
    a.setPref("u1", "session", { trackId: "demo", walkthroughId: "one", stepId: "b", at: 1 });
    a.close();

    const b = new GuidedProgressStore(dir);
    const p = b.get("u1");
    expect(p.walkthroughs["demo/one"]).toMatchObject({
      status: "in_progress",
      stepId: "b",
      completedSteps: ["a"],
    });
    expect(p.quizzes.demo).toMatchObject({ score: 1, total: 2, passed: false });
    expect(p.prefs.missionsDismissed).toBe(true);
    expect(p.session).toMatchObject({ trackId: "demo", stepId: "b" });
    expect(b.get("someone-else").walkthroughs).toEqual({});

    const done = b.complete("u1", "demo/one", ["a", "b"]);
    expect(done).toMatchObject({ status: "completed", stepId: null });
    expect(done.completedAt).toBeTypeOf("number");
    // Stepping through a completed walkthrough again never un-completes it.
    expect(b.step("u1", "demo/one", "a", true).status).toBe("completed");
    b.reset("u1", "demo/one");
    expect(b.get("u1").walkthroughs["demo/one"]).toBeUndefined();
    b.close();
  });

  it("keeps the best quiz result — a pass is never lost to a worse retake", () => {
    const s = new GuidedProgressStore(tempDir());
    s.recordQuiz("u", "t", 3, 3, true);
    expect(s.recordQuiz("u", "t", 1, 3, false)).toMatchObject({ score: 3, passed: true });
    s.setPref("u", "missionsDismissed", null);
    expect(s.get("u").prefs.missionsDismissed).toBeUndefined();
    s.close();
  });
});

describe("badges, certification ladder, recommendations", () => {
  const mk = (id: string, level: LearnTrack["level"], over: Partial<LearnTrack> = {}) => {
    const r = parseTrack(
      track(id, { level, certRequired: true, ...over }),
      over.pluginId ? { pluginId: over.pluginId } : {},
    );
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const tracks = [
    mk("b1", "beginner"),
    mk("i1", "intermediate"),
    mk("a1", "advanced"),
    { ...mk("plug", "beginner"), certRequired: undefined, pluginId: "plug" },
  ];
  const done = (ids: string[]): GuidedProgress => ({
    userId: "u",
    walkthroughs: Object.fromEntries(
      ids.flatMap((id) =>
        ["one", "two"].map((w) => [
          `${id}/${w}`,
          {
            status: "completed" as const,
            stepId: null,
            completedSteps: [],
            updatedAt: 1,
            completedAt: 1,
          },
        ]),
      ),
    ),
    quizzes: Object.fromEntries(ids.map((id) => [id, { score: 2, total: 2, passed: true, at: 1 }])),
    prefs: {},
    session: null,
  });

  it("a track completes only with every walkthrough AND the quiz passed", () => {
    const p = done(["b1"]);
    expect(trackStatus(tracks[0]!, p)).toMatchObject({ completed: true, percent: 100 });
    p.quizzes.b1!.passed = false;
    expect(trackStatus(tracks[0]!, p)).toMatchObject({ completed: false, percent: 67 });
  });

  it("walks Apprentice → Practitioner → Master (Master needs a plugin mastery badge)", () => {
    const tier = (ids: string[]) =>
      computeCertLadder(tracks, done(ids))
        .filter((r) => r.eligible)
        .map((r) => r.tier);
    expect(tier([])).toEqual([]);
    expect(tier(["b1"])).toEqual(["apprentice"]);
    expect(tier(["b1", "i1"])).toEqual(["apprentice", "practitioner"]);
    expect(tier(["b1", "i1", "a1"])).toEqual(["apprentice", "practitioner"]);
    expect(tier(["b1", "i1", "a1", "plug"])).toEqual(["apprentice", "practitioner", "master"]);
    const badges = computeBadges(tracks, done(["b1", "plug"]));
    expect(badges.map((b) => [b.trackId, b.mastery])).toEqual([
      ["b1", false],
      ["plug", true],
    ]);
  });

  it("recommends in-progress first, then untouched foundational areas", () => {
    const withSignals = tracks.map((t) => ({ ...t, signals: [t.id] }));
    const p = done([]);
    p.walkthroughs["a1/one"] = {
      status: "in_progress",
      stepId: "a",
      completedSteps: [],
      updatedAt: 1,
      completedAt: null,
    };
    const reco = recommendTracks(withSignals, p, ["b1"], 3);
    expect(reco[0]).toBe("a1");
    expect(reco).not.toContain(undefined);
    expect(reco.indexOf("plug")).toBeLessThan(reco.indexOf("b1") === -1 ? 99 : reco.indexOf("b1"));
  });
});

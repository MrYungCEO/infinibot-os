import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SOP_SEEDS, SOP_SEED_VERSION, seedAgencySops, suggestedScheduleFor } from "./sop-seeds.js";
import { WorkforceSopStore } from "./sop-store.js";

const AGENCY = "agency-1";
const ROLES = new Map([
  ["ceo", "agency-1:ai:ceo"],
  ["marketing-studio", "agency-1:ai:marketing-studio"],
  ["development-head", "agency-1:ai:development-head"],
  ["web-builder", "agency-1:ai:web-builder"],
  ["coder", "agency-1:ai:coder"],
  ["pm", "agency-1:ai:pm"],
]);

let tempDir: string;
let store: WorkforceSopStore;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "sop-seeds-"));
  store = new WorkforceSopStore(join(tempDir, "agency.db"));
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("SOP_SEEDS content", () => {
  it("covers all six production roles", () => {
    const roles = new Set(SOP_SEEDS.map((seed) => seed.roleId));
    expect([...roles].sort()).toEqual(
      ["ceo", "coder", "development-head", "marketing-studio", "pm", "web-builder"].sort(),
    );
  });

  it("has unique slugs", () => {
    const slugs = SOP_SEEDS.map((seed) => seed.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("is a real procedure, not a placeholder, in every seed", () => {
    for (const seed of SOP_SEEDS) {
      expect(seed.steps!.length, `${seed.slug} steps`).toBeGreaterThanOrEqual(5);
      expect(seed.acceptanceCriteria!.length, `${seed.slug} criteria`).toBeGreaterThanOrEqual(4);
      expect(seed.inputs!.length, `${seed.slug} inputs`).toBeGreaterThanOrEqual(2);
      expect(seed.outputs!.length, `${seed.slug} outputs`).toBeGreaterThanOrEqual(2);
      expect(seed.summary!.length, `${seed.slug} summary`).toBeGreaterThan(80);
      for (const step of seed.steps!) {
        // Substantive: not a one-liner title masquerading as an instruction.
        expect(step.instruction.length, `${seed.slug}/${step.title}`).toBeGreaterThan(60);
      }
      // Every required step declares what it must leave behind.
      for (const step of seed.steps!.filter((entry) => entry.required !== false)) {
        expect(step.expectedOutput, `${seed.slug}/${step.title} expectedOutput`).toBeTruthy();
      }
    }
  });

  it("suggests a cadence for every seeded slug", () => {
    for (const seed of SOP_SEEDS) {
      const suggested = suggestedScheduleFor(seed.slug);
      expect(suggested, seed.slug).not.toBeNull();
      expect(suggested!.runAt).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
      expect(suggested!.interval).toBeGreaterThanOrEqual(1);
    }
    expect(suggestedScheduleFor("not-a-seed")).toBeNull();
  });
});

describe("seedAgencySops", () => {
  it("creates every SOP on a fresh agency", () => {
    const result = seedAgencySops(store, AGENCY, ROLES);
    expect(result.created).toBe(SOP_SEEDS.length);
    expect(result.existing).toBe(0);
    expect(result.adopted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(store.listSops(AGENCY)).toHaveLength(SOP_SEEDS.length);
  });

  it("assigns each SOP to the worker that owns its role", () => {
    seedAgencySops(store, AGENCY, ROLES);
    const pmSop = store.getSopBySlug(AGENCY, "pm-daily-standup-and-blocker-sweep")!;
    expect(pmSop.ownerWorkerId).toBe("agency-1:ai:pm");
    expect(pmSop.ownerRoleId).toBe("pm");
    expect(pmSop.source).toBe("seed");
    expect(pmSop.seedVersion).toBe(SOP_SEED_VERSION);
  });

  it("is a true no-op on a re-seed: nothing is written at all", () => {
    seedAgencySops(store, AGENCY, ROLES);
    const before = store.listSops(AGENCY);

    const second = seedAgencySops(store, AGENCY, ROLES);
    expect(second).toEqual({
      created: 0,
      existing: SOP_SEEDS.length,
      adopted: 0,
      skipped: 0,
    });

    const after = store.listSops(AGENCY);
    expect(after).toEqual(before);
    for (const sop of after) {
      const original = before.find((entry) => entry.id === sop.id)!;
      expect(sop.updatedAt).toBe(original.updatedAt);
      expect(sop.version).toBe(original.version);
    }
  });

  it("never clobbers an operator's edits to a seeded SOP", () => {
    seedAgencySops(store, AGENCY, ROLES);
    const sop = store.getSopBySlug(AGENCY, "ceo-weekly-operating-review")!;
    const edited = store.updateSop(AGENCY, sop.id, {
      name: "Our own operating review",
      steps: [{ title: "Only step", instruction: "Do the review our way." }],
    })!;
    expect(edited.version).toBe(2);

    seedAgencySops(store, AGENCY, ROLES);
    const after = store.getSopBySlug(AGENCY, "ceo-weekly-operating-review")!;
    expect(after.name).toBe("Our own operating review");
    expect(after.steps).toHaveLength(1);
    expect(after.updatedAt).toBe(edited.updatedAt);
  });

  it("leaves a slug an operator has taken over completely alone", () => {
    const operatorSop = store.createSop(AGENCY, {
      slug: "pm-daily-standup-and-blocker-sweep",
      name: "My own standup",
      steps: [{ title: "Step", instruction: "Do it my way." }],
      source: "operator",
    });

    const result = seedAgencySops(store, AGENCY, ROLES);
    expect(result.skipped).toBe(1);
    const after = store.getSopBySlug(AGENCY, "pm-daily-standup-and-blocker-sweep")!;
    expect(after.id).toBe(operatorSop.id);
    expect(after.name).toBe("My own standup");
    expect(after.updatedAt).toBe(operatorSop.updatedAt);
  });

  it("adopts a stale seed row onto the current definition exactly once", () => {
    seedAgencySops(store, AGENCY, ROLES);
    const sop = store.getSopBySlug(AGENCY, "backend-automation-health-check")!;
    // Simulate a row seeded by an older generation.
    store.updateSop(AGENCY, sop.id, {
      seedVersion: SOP_SEED_VERSION - 1,
      steps: [{ title: "Old", instruction: "The previous generation's procedure." }],
    });

    const first = seedAgencySops(store, AGENCY, ROLES);
    expect(first.adopted).toBe(1);
    const adopted = store.getSopBySlug(AGENCY, "backend-automation-health-check")!;
    expect(adopted.seedVersion).toBe(SOP_SEED_VERSION);
    expect(adopted.steps.length).toBeGreaterThan(1);

    const second = seedAgencySops(store, AGENCY, ROLES);
    expect(second.adopted).toBe(0);
    expect(second.existing).toBe(SOP_SEEDS.length);
    expect(store.getSopBySlug(AGENCY, "backend-automation-health-check")!.updatedAt).toBe(
      adopted.updatedAt,
    );
  });

  it("skips roles that have no worker on this agency rather than seeding ownerless", () => {
    const result = seedAgencySops(store, AGENCY, new Map([["pm", "agency-1:ai:pm"]]));
    const pmSeeds = SOP_SEEDS.filter((seed) => seed.roleId === "pm").length;
    expect(result.created).toBe(pmSeeds);
    expect(result.skipped).toBe(SOP_SEEDS.length - pmSeeds);
    for (const sop of store.listSops(AGENCY)) expect(sop.ownerWorkerId).toBeTruthy();
  });

  it("scopes seeding per agency", () => {
    seedAgencySops(store, AGENCY, ROLES);
    expect(store.listSops("agency-2")).toHaveLength(0);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkforceSopStore, normalizeSopSlug, renderSopMarkdown } from "./sop-store.js";
import type { SopInput } from "./sop-types.js";

const AGENCY = "agency-1";
const OTHER = "agency-2";

let tempDir: string;
let store: WorkforceSopStore;

function sopInput(overrides: Partial<SopInput> = {}): SopInput {
  return {
    slug: "pm-daily-sweep",
    name: "Daily sweep",
    summary: "Find blockers.",
    category: "delivery",
    steps: [
      { title: "Pull state", instruction: "List open work.", expectedOutput: "An inventory." },
      { title: "Escalate", instruction: "Escalate stalled items." },
    ],
    inputs: [{ name: "Open work items", description: "From the inbox." }],
    outputs: [{ name: "Standup note", description: "Four sections." }],
    acceptanceCriteria: ["Every blocker names an owner"],
    tags: ["delivery"],
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "sop-store-"));
  store = new WorkforceSopStore(join(tempDir, "agency.db"));
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("normalizeSopSlug", () => {
  it("lowercases, dashes and trims to a canonical slug", () => {
    expect(normalizeSopSlug("  CMO Weekly / Content Review!  ")).toBe("cmo-weekly-content-review");
    expect(normalizeSopSlug("Back_End  Automation")).toBe("back-end-automation");
  });

  it("rejects a slug that cannot be normalised into the allowed shape", () => {
    expect(() => normalizeSopSlug("   ")).toThrow(/slug must be/);
    expect(() => normalizeSopSlug("!!!")).toThrow(/slug must be/);
    expect(() => normalizeSopSlug("a")).toThrow(/slug must be/);
  });
});

describe("WorkforceSopStore — CRUD", () => {
  it("creates an SOP with dense step ordering and version 1", () => {
    const sop = store.createSop(AGENCY, sopInput());
    expect(sop.version).toBe(1);
    expect(sop.slug).toBe("pm-daily-sweep");
    expect(sop.steps.map((step) => step.order)).toEqual([1, 2]);
    expect(sop.steps[0].expectedOutput).toBe("An inventory.");
    expect(sop.steps[1].expectedOutput).toBeNull();
    expect(sop.source).toBe("operator");
    expect(sop.seedVersion).toBe(0);
  });

  it("normalises a free-text slug on create", () => {
    const sop = store.createSop(AGENCY, sopInput({ slug: "PM Daily  Sweep" }));
    expect(sop.slug).toBe("pm-daily-sweep");
  });

  it("rejects a duplicate slug inside one agency", () => {
    store.createSop(AGENCY, sopInput());
    expect(() => store.createSop(AGENCY, sopInput({ name: "Another" }))).toThrow(
      /slug already exists/,
    );
  });

  it("scopes slug uniqueness per agency", () => {
    const first = store.createSop(AGENCY, sopInput());
    const second = store.createSop(OTHER, sopInput());
    expect(second.id).not.toBe(first.id);
    expect(store.getSopBySlug(AGENCY, "pm-daily-sweep")?.id).toBe(first.id);
    expect(store.getSopBySlug(OTHER, "pm-daily-sweep")?.id).toBe(second.id);
    expect(store.listSops(AGENCY)).toHaveLength(1);
  });

  it("requires a name", () => {
    expect(() => store.createSop(AGENCY, sopInput({ name: "  " }))).toThrow(/name required/);
  });

  it("rejects a step with no instruction", () => {
    expect(() =>
      store.createSop(AGENCY, {
        ...sopInput(),
        steps: [{ title: "Do it", instruction: "  " }],
      }),
    ).toThrow(/step 1: instruction required/);
  });

  it("bumps version only when the procedure body changes", () => {
    const sop = store.createSop(AGENCY, sopInput());

    const renamed = store.updateSop(AGENCY, sop.id, { name: "Renamed sweep" })!;
    expect(renamed.name).toBe("Renamed sweep");
    expect(renamed.version).toBe(1);

    const rewritten = store.updateSop(AGENCY, sop.id, {
      steps: [{ title: "Pull state", instruction: "List open work and diff it." }],
    })!;
    expect(rewritten.version).toBe(2);
    expect(rewritten.steps).toHaveLength(1);
  });

  it("is a true no-op when an update changes nothing", () => {
    const sop = store.createSop(AGENCY, sopInput());
    const again = store.updateSop(AGENCY, sop.id, {
      name: sop.name,
      steps: sop.steps,
      tags: sop.tags,
    })!;
    expect(again.updatedAt).toBe(sop.updatedAt);
    expect(again.version).toBe(sop.version);
  });

  it("rejects renaming a slug onto another SOP's slug", () => {
    store.createSop(AGENCY, sopInput());
    const other = store.createSop(AGENCY, sopInput({ slug: "cmo-review", name: "CMO review" }));
    expect(() => store.updateSop(AGENCY, other.id, { slug: "pm-daily-sweep" })).toThrow(
      /slug already exists/,
    );
  });

  it("deletes an SOP and cascades its schedules but keeps run history", () => {
    const sop = store.createSop(AGENCY, sopInput());
    store.upsertSchedule(AGENCY, {
      sopId: sop.id,
      workerId: "w1",
      cronJobName: "agency-sop:pm-daily-sweep:w1",
    });
    store.recordRun(AGENCY, {
      sopId: sop.id,
      workerId: "w1",
      trigger: "manual",
      sopVersion: sop.version,
    });

    expect(store.deleteSop(AGENCY, sop.id)).toBe(true);
    expect(store.getSop(AGENCY, sop.id)).toBeNull();
    expect(store.listSchedules(AGENCY, { sopId: sop.id })).toHaveLength(0);
    expect(store.listRuns(AGENCY, { sopId: sop.id })).toHaveLength(1);
  });

  it("filters listSops by owner, status and category", () => {
    store.createSop(AGENCY, sopInput({ ownerWorkerId: "w1", category: "delivery" }));
    store.createSop(
      AGENCY,
      sopInput({ slug: "cmo-review", name: "CMO", ownerWorkerId: "w2", category: "growth" }),
    );
    store.createSop(
      AGENCY,
      sopInput({ slug: "retired", name: "Old", ownerWorkerId: "w1", status: "retired" }),
    );

    expect(store.listSops(AGENCY, { ownerWorkerId: "w1" })).toHaveLength(2);
    expect(store.listSops(AGENCY, { category: "growth" })).toHaveLength(1);
    expect(store.listSops(AGENCY, { status: "retired" })).toHaveLength(1);
  });
});

describe("WorkforceSopStore — schedules", () => {
  it("upserts idempotently and reports no change on a repeat", () => {
    const sop = store.createSop(AGENCY, sopInput());
    const input = {
      sopId: sop.id,
      workerId: "w1",
      cadence: "weekly" as const,
      weekday: 1,
      runAt: "08:00",
      cronJobName: "agency-sop:pm-daily-sweep:w1",
    };
    const first = store.upsertSchedule(AGENCY, input);
    expect(first.changed).toBe(true);

    const second = store.upsertSchedule(AGENCY, input);
    expect(second.changed).toBe(false);
    expect(second.schedule.id).toBe(first.schedule.id);
    expect(store.listSchedules(AGENCY, { sopId: sop.id })).toHaveLength(1);
  });

  it("never anchors an omitted nextRunAt at the epoch", () => {
    const sop = store.createSop(AGENCY, sopInput());
    const now = Date.UTC(2026, 6, 26, 12, 0, 0);
    const { schedule } = store.upsertSchedule(
      AGENCY,
      { sopId: sop.id, workerId: "w1", cadence: "daily", runAt: "09:00", cronJobName: "j" },
      now,
    );
    expect(schedule.nextRunAt).toBeGreaterThan(now);
  });

  it("finds a schedule by its responsibility link", () => {
    const sop = store.createSop(AGENCY, sopInput());
    const { schedule } = store.upsertSchedule(AGENCY, {
      sopId: sop.id,
      workerId: "w1",
      cronJobName: "j",
    });
    store.setScheduleLinks(AGENCY, schedule.id, { responsibilityId: "resp-1" });
    expect(store.findScheduleByResponsibility(AGENCY, "resp-1")?.id).toBe(schedule.id);
    expect(store.findScheduleByResponsibility(AGENCY, "nope")).toBeNull();
  });

  it("does not rewrite links when nothing changed", () => {
    const sop = store.createSop(AGENCY, sopInput());
    const { schedule } = store.upsertSchedule(AGENCY, {
      sopId: sop.id,
      workerId: "w1",
      cronJobName: "j",
    });
    const linked = store.setScheduleLinks(AGENCY, schedule.id, {
      cronJobId: "cron-1",
      responsibilityId: "resp-1",
    })!;
    const again = store.setScheduleLinks(AGENCY, schedule.id, {
      cronJobId: "cron-1",
      responsibilityId: "resp-1",
    })!;
    expect(again.updatedAt).toBe(linked.updatedAt);
  });
});

describe("renderSopMarkdown", () => {
  it("renders a deterministic, prompt-ready procedure", () => {
    const sop = store.createSop(AGENCY, sopInput());
    const markdown = renderSopMarkdown(sop);
    expect(markdown).toContain("### Daily sweep (v1)");
    expect(markdown).toContain("**Procedure**");
    expect(markdown).toContain("1. Pull state — List open work.");
    expect(markdown).toContain("Expected output: An inventory.");
    expect(markdown).toContain("**Acceptance criteria**");
    expect(markdown).toContain("Every blocker names an owner");
    expect(renderSopMarkdown(sop)).toBe(markdown);
  });
});

import { describe, expect, it } from "vitest";
import {
  LEGACY_UNASSIGNED_BUSINESS_ID,
  businessProjectIds,
  effectiveSectionScope,
  isRealBusinessId,
  openTaskCount,
  selectSectionBoard,
} from "./kanban-section-scope";

const projects = [
  { id: "p-biz", businessId: "biz-1" },
  { id: "p-biz-child", parentProjectId: "p-biz" },
  { id: "p-biz-grandchild", parentProjectId: "p-biz-child" },
  { id: "p-biz2", businessId: "biz-2" },
  { id: "p-legacy", businessId: LEGACY_UNASSIGNED_BUSINESS_ID },
  { id: "p-personal" },
  { id: "hq-parent" },
  { id: "hq-clients", parentProjectId: "hq-parent" },
];
const tasks = [
  { id: "t1", projectId: "p-biz", status: "todo" },
  { id: "t2", projectId: "p-biz-grandchild", status: "done" },
  { id: "t3", projectId: "p-biz2", status: "in_progress" },
  { id: "t4", projectId: "p-legacy", status: "todo" },
  { id: "t5", projectId: "p-personal", status: "todo" },
  { id: "t6", projectId: "hq-clients", status: "review" },
  { id: "t7", projectId: "", status: "todo" },
];

describe("isRealBusinessId", () => {
  it("rejects empty, missing and the legacy sentinel", () => {
    expect(isRealBusinessId("biz-1")).toBe(true);
    expect(isRealBusinessId("")).toBe(false);
    expect(isRealBusinessId("  ")).toBe(false);
    expect(isRealBusinessId(null)).toBe(false);
    expect(isRealBusinessId(undefined)).toBe(false);
    expect(isRealBusinessId(LEGACY_UNASSIGNED_BUSINESS_ID)).toBe(false);
  });
});

describe("effectiveSectionScope", () => {
  it("keeps business scope only while the plugin is on", () => {
    expect(effectiveSectionScope("business", true)).toBe("business");
    expect(effectiveSectionScope("business", false)).toBe("all");
    expect(effectiveSectionScope("all", true)).toBe("all");
    expect(effectiveSectionScope("all", false)).toBe("all");
  });
});

describe("businessProjectIds", () => {
  it("includes business-linked projects, their sub-projects and the HQ boards", () => {
    const ids = businessProjectIds(projects, { hqParentProjectId: "hq-parent" });
    expect([...ids].sort()).toEqual(
      ["hq-clients", "hq-parent", "p-biz", "p-biz-child", "p-biz-grandchild", "p-biz2"].sort(),
    );
  });

  it("narrows to the active business and drops unlinked HQ boards", () => {
    const ids = businessProjectIds(projects, { activeBusinessId: "biz-2", hqParentProjectId: "hq-parent" });
    expect([...ids]).toEqual(["p-biz2"]);
  });

  it("ignores a legacy-sentinel active filter and a missing HQ parent", () => {
    const ids = businessProjectIds(projects, {
      activeBusinessId: LEGACY_UNASSIGNED_BUSINESS_ID,
      hqParentProjectId: "nope",
    });
    expect(ids.has("p-biz")).toBe(true);
    expect(ids.has("nope")).toBe(false);
    expect(ids.has("p-legacy")).toBe(false);
  });
});

describe("selectSectionBoard", () => {
  it("all scope returns everything", () => {
    const b = selectSectionBoard(projects, tasks, "all");
    expect(b.projects).toHaveLength(projects.length);
    expect(b.tasks).toHaveLength(tasks.length);
  });

  it("business scope keeps only tasks of business projects", () => {
    const b = selectSectionBoard(projects, tasks, "business", { hqParentProjectId: "hq-parent" });
    expect(b.tasks.map((t) => t.id).sort()).toEqual(["t1", "t2", "t3", "t6"]);
    expect(b.projects.map((p) => p.id)).not.toContain("p-personal");
  });

  it("business scope with no business data is empty (caller shows empty state)", () => {
    const b = selectSectionBoard([{ id: "a" }], [{ projectId: "a", status: "todo" }], "business");
    expect(b.projects).toEqual([]);
    expect(b.tasks).toEqual([]);
  });
});

describe("openTaskCount", () => {
  it("counts everything that is not done", () => {
    expect(openTaskCount(tasks)).toBe(6);
    expect(openTaskCount([])).toBe(0);
  });
});

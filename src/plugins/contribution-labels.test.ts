import { describe, expect, it } from "vitest";
import { CONTRIBUTION_KIND_LABELS, CONTRIBUTION_KIND_PLURALS } from "./contributions.js";

describe("contribution kind group headings", () => {
  it("has a plural heading for every kind", () => {
    expect(Object.keys(CONTRIBUTION_KIND_PLURALS).sort()).toEqual(
      Object.keys(CONTRIBUTION_KIND_LABELS).sort(),
    );
  });

  it("pluralizes -y kinds properly (no 'entrys')", () => {
    expect(CONTRIBUTION_KIND_PLURALS.nav).toBe("Nav entries");
    expect(CONTRIBUTION_KIND_PLURALS.launchpad).toBe("Launchpad entries");
    for (const plural of Object.values(CONTRIBUTION_KIND_PLURALS)) {
      expect(plural).not.toMatch(/[^aeiou]ys$/i);
    }
  });
});

describe("importer input kinds", () => {
  it("defaults to a file picker and accepts input: none", async () => {
    const { buildContributionCatalog } = await import("./contributions.js");
    const { importers } = buildContributionCatalog({
      contributes: {
        rpc: [
          { method: "x.a", scope: "admin" },
          { method: "x.b", scope: "admin" },
        ],
        importers: [
          { id: "a", method: "x.a" },
          { id: "b", method: "x.b", input: "none" },
          { id: "c", method: "x.undeclared" },
        ],
      },
    });
    expect(importers.map((i) => [i.id, i.input])).toEqual([
      ["a", "file"],
      ["b", "none"],
    ]);
  });
});

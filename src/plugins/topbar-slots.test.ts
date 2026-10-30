import { describe, expect, it } from "vitest";

import { buildContributionCatalog } from "./contributions.js";
import { parseManifestV2 } from "./manifest-v2.js";

const SCHEMA = { type: "object", additionalProperties: false, properties: {} };

function manifest(topbarSlots: unknown) {
  return {
    manifestVersion: 2,
    id: "demo",
    configSchema: SCHEMA,
    engines: { "infinibot-plugin-api": "^2.0.0" },
    contributes: {
      nav: [{ tab: "demo-page", label: "Demo" }],
      pages: [{ tab: "demo-page", route: "/demo", builtin: "demo" }],
      rpc: [],
      topbarSlots,
    },
  };
}

describe("contributes.topbarSlots", () => {
  it("is optional", () => {
    const res = parseManifestV2("demo", manifest(undefined));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.fields.contributes.topbarSlots).toBeUndefined();
  });

  it("parses slots with a default order", () => {
    const res = parseManifestV2(
      "demo",
      manifest([
        { id: "picker", label: "Picker", builtin: "agency-selector" },
        { id: "clock-2", label: "Clock", builtin: "x", order: 5, description: "d" },
      ]),
    );
    if (!res.ok) throw new Error(res.error);
    expect(res.fields.contributes.topbarSlots).toEqual([
      { id: "picker", label: "Picker", builtin: "agency-selector", order: 100 },
      { id: "clock-2", label: "Clock", builtin: "x", order: 5, description: "d" },
    ]);
  });

  it.each([
    ["not an array", { id: "x" }, /must be an array/],
    ["missing label", [{ id: "x", builtin: "b" }], /need id \+ label/],
    ["bad id", [{ id: "Bad Id", label: "L", builtin: "b" }], /id must match/],
    ["no builtin", [{ id: "x", label: "L" }], /needs builtin/],
    [
      "duplicate",
      [
        { id: "x", label: "L", builtin: "b" },
        { id: "x", label: "M", builtin: "b" },
      ],
      /declared twice/,
    ],
    ["bad order", [{ id: "x", label: "L", builtin: "b", order: "1" }], /order must be a number/],
  ])("rejects %s", (_name, slots, error) => {
    const res = parseManifestV2("demo", manifest(slots));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(error);
  });

  it("is listed (and live-toggleable) in the Setup › Plugins contribution catalog", () => {
    const { items } = buildContributionCatalog(
      manifest([{ id: "picker", label: "Agency selector", builtin: "agency-selector" }]),
    );
    const slot = items.find((e) => e.key === "topbarSlot:picker");
    expect(slot).toMatchObject({ kind: "topbarSlot", label: "Agency selector", live: true });
  });
});

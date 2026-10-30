/**
 * `contributes.clockSections` — the topbar clock's plugin slot (manifest v2).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildContributionCatalog } from "./contributions.js";
import { parseManifestV2 } from "./manifest-v2.js";

const base = (contributes: Record<string, unknown>) => ({
  manifestVersion: 2,
  id: "demo",
  engines: { "infinibot-plugin-api": "^2.0.0" },
  contributes,
});

describe("contributes.clockSections", () => {
  it("parses entries with defaults", () => {
    const res = parseManifestV2(
      "demo",
      base({
        clockSections: [
          { id: "sessions", label: "Trading sessions", builtin: "demo-sessions" },
          {
            id: "tides",
            label: "Tides",
            builtin: "demo-tides",
            description: "Local tides",
            defaultEnabled: false,
          },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fields.contributes.clockSections).toEqual([
      { id: "sessions", label: "Trading sessions", builtin: "demo-sessions", defaultEnabled: true },
      {
        id: "tides",
        label: "Tides",
        builtin: "demo-tides",
        description: "Local tides",
        defaultEnabled: false,
      },
    ]);
  });

  it("is absent when not declared", () => {
    const res = parseManifestV2("demo", base({}));
    expect(res.ok && res.fields.contributes.clockSections).toBeUndefined();
  });

  it.each([
    [{ clockSections: {} }, "must be an array"],
    [{ clockSections: ["x"] }, "must be objects"],
    [{ clockSections: [{ id: "a" }] }, "need id + label"],
    [{ clockSections: [{ id: "Bad Id", label: "x", builtin: "b" }] }, "id must match"],
    [{ clockSections: [{ id: "a", label: "x" }] }, "needs builtin"],
    [
      {
        clockSections: [
          { id: "a", label: "x", builtin: "b" },
          { id: "a", label: "y", builtin: "b" },
        ],
      },
      "declared twice",
    ],
    [
      { clockSections: [{ id: "a", label: "x", builtin: "b", defaultEnabled: "yes" }] },
      "defaultEnabled",
    ],
  ])("fails closed on %j", (contributes, error) => {
    const res = parseManifestV2("demo", base(contributes));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(error);
  });

  it("is a live-toggleable contribution in the catalog", () => {
    const { items } = buildContributionCatalog(
      base({
        clockSections: [{ id: "sessions", label: "Trading sessions", builtin: "demo-sessions" }],
      }),
    );
    expect(items.find((i) => i.key === "clockSection:sessions")).toMatchObject({
      kind: "clockSection",
      label: "Trading sessions",
      toggleable: true,
      live: true,
    });
  });

  it("Infinitrade declares its trading-sessions section", () => {
    const file = path.join(
      import.meta.dirname,
      "../../extensions/infinitrade/infinibot.plugin.json",
    );
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    const res = parseManifestV2("infinitrade", raw);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fields.contributes.clockSections).toEqual([
      expect.objectContaining({
        id: "trading-sessions",
        label: "Trading sessions",
        builtin: "infinitrade-sessions",
      }),
    ]);
  });
});

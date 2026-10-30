import { describe, expect, it } from "vitest";

import { buildContributionCatalog } from "./contributions.js";
import { MAP_ROOM_THEMES, parseManifestV2, parseMapRoom } from "./manifest-v2.js";

const SCHEMA = { type: "object", additionalProperties: false, properties: {} };

function manifest(extra: Record<string, unknown> = {}, contributes: Record<string, unknown> = {}) {
  return {
    manifestVersion: 2,
    id: "demo",
    name: "Demo Plugin",
    configSchema: SCHEMA,
    engines: { "infinibot-plugin-api": "^2.0.0" },
    contributes: {
      nav: [{ tab: "demo-page", label: "Demo", group: "Agents" }],
      pages: [{ tab: "demo-page", route: "/demo", builtin: "demo" }],
      rpc: [{ method: "demo.list", scope: "read" }],
      ...contributes,
    },
    ...extra,
  };
}

describe("contributes.mapRoom", () => {
  it("defaults to a generic M room for a plugin with pages", () => {
    const res = parseManifestV2("demo", manifest());
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) return;
    expect(res.fields.contributes.mapRoom).toEqual({
      title: "Demo Plugin",
      theme: "generic",
      size: "M",
      placement: "auto",
    });
  });

  it("has no room for a page-less plugin unless declared", () => {
    const none = parseMapRoom(undefined, { name: "X", hasPages: false });
    expect(none).toBeUndefined();
    const declared = parseMapRoom({ theme: "fleet" }, { name: "X", hasPages: false });
    expect(declared).toMatchObject({ title: "X", theme: "fleet", size: "M", placement: "auto" });
  });

  it("opts out with false", () => {
    const res = parseManifestV2("demo", manifest({}, { mapRoom: false }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fields.contributes.mapRoom).toBeUndefined();
    const { items } = buildContributionCatalog(manifest({}, { mapRoom: false }));
    expect(items.some((i) => i.kind === "mapRoom")).toBe(false);
  });

  it("accepts a full declaration and normalises the accent", () => {
    const res = parseManifestV2(
      "demo",
      manifest(
        {},
        {
          mapRoom: {
            title: "Trading Floor",
            theme: "trading-floor",
            size: "L",
            placement: "south",
            accent: "Token:Primary",
            props: ["tickerBoard", "consoleWide", "desk"],
          },
        },
      ),
    );
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) return;
    expect(res.fields.contributes.mapRoom).toEqual({
      title: "Trading Floor",
      theme: "trading-floor",
      size: "L",
      placement: "south",
      accent: "token:primary",
      props: ["tickerBoard", "consoleWide", "desk"],
    });
    const hex = parseMapRoom({ accent: "#FFAA00" }, { name: "X", hasPages: true });
    expect(hex).toMatchObject({ accent: "#ffaa00" });
  });

  it("fails closed on bad values", () => {
    const bad = (mapRoom: unknown) => {
      const res = parseManifestV2("demo", manifest({}, { mapRoom }));
      expect(res.ok).toBe(false);
      return res.ok ? "" : res.error;
    };
    expect(bad("yes")).toMatch(/object or false/);
    expect(bad({ theme: "castle" })).toMatch(/theme "castle"/);
    expect(bad({ size: "XL" })).toMatch(/size "XL"/);
    expect(bad({ placement: "up" })).toMatch(/placement "up"/);
    expect(bad({ accent: "red" })).toMatch(/accent "red"/);
    expect(bad({ accent: "token:nope" })).toMatch(/unknown design token/);
    expect(bad({ props: ["throne"] })).toMatch(/prop "throne"/);
    expect(bad({ props: new Array(13).fill("desk") })).toMatch(/at most 12/);
    expect(bad({ title: "x".repeat(25) })).toMatch(/longer than 24/);
  });

  it("every theme the parser accepts is a known theme constant", () => {
    for (const theme of MAP_ROOM_THEMES) {
      const r = parseMapRoom({ theme }, { name: "T", hasPages: true });
      expect(typeof r).toBe("object");
    }
  });

  it("lands in the contribution catalog as a live, toggleable item keyed by plugin id", () => {
    const { items } = buildContributionCatalog(
      manifest({}, { mapRoom: { title: "Room", theme: "dojo" } }),
    );
    const item = items.find((i) => i.kind === "mapRoom");
    expect(item).toMatchObject({
      key: "mapRoom:demo",
      id: "demo",
      label: "Room",
      live: true,
      toggleable: true,
      detail: "dojo",
    });
    const dflt = buildContributionCatalog(manifest()).items.find((i) => i.kind === "mapRoom");
    expect(dflt).toMatchObject({ key: "mapRoom:demo", label: "Demo Plugin", detail: "generic" });
  });
});

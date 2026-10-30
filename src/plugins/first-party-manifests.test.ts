import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { secretConfigKeys } from "../gateway/server-methods/plugins.js";
import { buildContributionCatalog } from "./contributions.js";
import { listingAssetPaths, parseListing } from "./listing.js";
import { parseManifestV2 } from "./manifest-v2.js";

const root = path.resolve(import.meta.dirname, "../../extensions");
const read = (id: string) =>
  JSON.parse(fs.readFileSync(path.join(root, id, "infinibot.plugin.json"), "utf-8")) as Record<
    string,
    unknown
  >;

describe("first-party v2 manifests in this release", () => {
  for (const id of [
    "infinicode",
    "robovoice",
    "omniclinic",
    "flypic",
    "infinitrade",
    "solatrix",
    "content-studio",
    "business-agency",
    "droid-swarm",
    "monsoon-studio",
  ]) {
    it(`${id} parses with appearance + license`, () => {
      const res = parseManifestV2(id, read(id));
      expect(res.ok, res.ok ? "" : res.error).toBe(true);
      if (!res.ok) return;
      expect(res.fields.license).toBe("FSL-1.1-ALv2");
      expect(res.fields.appearance?.monogram).toBeTruthy();
    });
  }

  it("every first-party plugin with pages declares a themed mesh-map room", () => {
    const expected: Record<string, string> = {
      infinicode: "fleet",
      robovoice: "voice-studio",
      omniclinic: "clinic",
      flypic: "media-studio",
      infinitrade: "trading-floor",
      solatrix: "terminal-vault",
      discipline: "dojo",
      "content-studio": "content-lab",
      products: "showroom",
      "canvas-library": "holo-gallery",
      "business-agency": "boardroom",
      "mcp-excalidraw": "drawing-studio",
      "droid-swarm": "fleet",
      "monsoon-studio": "content-lab",
      "part-scan": "generic",
    };
    for (const [dir, theme] of Object.entries(expected)) {
      const raw = read(dir);
      const res = parseManifestV2(String(raw.id), raw);
      expect(res.ok, `${dir}: ${res.ok ? "" : res.error}`).toBe(true);
      if (!res.ok) continue;
      const room = res.fields.contributes.mapRoom;
      expect(room?.theme, dir).toBe(theme);
      expect(room?.title, dir).toBeTruthy();
      expect(res.fields.contributes.pages.length, dir).toBeGreaterThan(0);
      const item = buildContributionCatalog(raw).items.find((i) => i.kind === "mapRoom");
      expect(item?.key, dir).toBe(`mapRoom:${String(raw.id)}`);
    }
  });

  it("part-scan package declares the partscan RPC namespace and parses as v2", () => {
    const raw = read("part-scan");
    expect(raw.id).toBe("part-scan");
    expect(raw.rpcNamespace).toBe("partscan");
    const res = parseManifestV2("part-scan", raw);
    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) return;
    expect(res.fields.contributes.rpc.every((item) => item.method.startsWith("partscan."))).toBe(
      true,
    );
    expect(res.fields.rpcNamespace).toBe("partscan");
    expect(res.fields.permissions.fs).toContain("<stateDir>/plugin-data/part-scan");
  });

  it("omniclinic keeps landing, agents, PHI and declares its Data-tab importers", () => {
    const raw = read("omniclinic");
    const res = parseManifestV2("omniclinic", raw);
    if (!res.ok) throw new Error(res.error);
    expect(res.fields.contributes.landing).toBe("omniclinic");
    expect(res.fields.contributes.agents).toEqual(["agents/roster.json"]);
    expect(res.fields.permissions.phi).toBe(true);
    const { importers, items } = buildContributionCatalog(raw);
    expect(importers.map((i) => [i.id, i.method, i.input])).toEqual([
      ["csv", "omniclinic.csv.import", "file"],
      ["legacy", "omniclinic.import.run", "none"],
    ]);
    expect(items.find((i) => i.key === "rpc:omniclinic.research.run")?.requires).toContain(
      "network",
    );
  });

  it("robovoice keeps its voice provider and exposes secrets write-only in Settings", () => {
    const raw = read("robovoice");
    const res = parseManifestV2("robovoice", raw);
    if (!res.ok) throw new Error(res.error);
    expect(res.fields.contributes.voiceProviders).toEqual(["robovoice"]);
    expect(res.fields.contributes.http).toContain("/plugins/robovoice/connection-details");
    const schema = raw.configSchema as Record<string, unknown>;
    expect(
      secretConfigKeys({
        configJsonSchema: schema,
        configUiHints: raw.uiHints as Record<string, { sensitive?: boolean }>,
      }).sort(),
    ).toEqual(["deviceKey", "edgeToken"]);
  });
});

describe("bundled store listings", () => {
  const ids = fs
    .readdirSync(root)
    .filter((id) => fs.existsSync(path.join(root, id, "infinibot.plugin.json")));

  it.each(ids)("%s: listing (when present) parses cleanly with small, existing images", (id) => {
    const raw = read(id);
    if (raw.listing === undefined) return;
    const { listing, warnings } = parseListing(raw.listing);
    expect(warnings).toEqual([]);
    expect(listing?.tagline).toBeTruthy();
    expect(listing?.category).toBeTruthy();
    for (const rel of listingAssetPaths(listing)) {
      const file = path.join(root, id, rel);
      expect(fs.existsSync(file), `${id}/${rel}`).toBe(true);
      expect(fs.statSync(file).size, `${id}/${rel} must stay under 200 KB`).toBeLessThan(
        200 * 1024,
      );
    }
  });

  it("first-party apps ship a cover, an icon and 2–3 screenshots", () => {
    for (const id of [
      "infinicode",
      "robovoice",
      "omniclinic",
      "flypic",
      "infinitrade",
      "solatrix",
      "content-studio",
      "business-agency",
      "droid-swarm",
    ]) {
      const { listing } = parseListing(read(id).listing);
      expect(listing?.category).toBe("apps");
      expect(listing?.cover).toBeTruthy();
      expect(listing?.icon).toBeTruthy();
      expect(listing?.screenshots.length).toBeGreaterThanOrEqual(2);
      expect(listing?.screenshots.length).toBeLessThanOrEqual(3);
    }
  });
});

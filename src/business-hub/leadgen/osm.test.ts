import { beforeEach, describe, expect, it } from "vitest";
import { openHubDb } from "../db.js";
import { loadLeadgenConfig, providerCtx, saveLeadgenConfig } from "./config.js";
import {
  areaFromPhoton,
  buildOverpassQuery,
  categoryTags,
  osmSearch,
  overpassQuotaUsed,
  parseOverpass,
  resetOsmState,
} from "./osm.js";
import { getProvider } from "./providers.js";
import { baseDeps, fixture, json, mockFetch } from "./test-utils.js";

beforeEach(() => resetOsmState());

describe("osm categories + query", () => {
  it("maps category words to OSM tags", () => {
    expect(categoryTags("Dentists")).toEqual([
      ["amenity", "dentist"],
      ["healthcare", "dentist"],
    ]);
    expect(categoryTags("emergency plumbers")).toEqual([["craft", "plumber"]]);
    expect(categoryTags("hair salons")[0]).toEqual(["shop", "hairdresser"]);
    expect(categoryTags("real estate agents")).toContainEqual(["office", "estate_agent"]);
    expect(categoryTags("widgets")).toEqual([]);
  });

  it("builds Overpass QL for an area id with a name-regex fallback", () => {
    const area = areaFromPhoton(JSON.parse(fixture("photon-boise.json")));
    expect(area).toEqual({ kind: "area", id: 3_600_122_595 });
    const ql = buildOverpassQuery("dentists", area!, 20);
    expect(ql).toContain("area(id:3600122595)->.a;");
    expect(ql).toContain('nwr["amenity"="dentist"]["name"](area.a);');
    expect(ql).toContain('["name"~"dentist",i](area.a)');
    expect(ql).toContain("out center 80;");
    const byName = buildOverpassQuery("cafe", { kind: "name", name: 'Bo"ise' }, 5);
    expect(byName).toContain('area["name"="Bo\\"ise"]');
  });

  it("parses Overpass JSON into leads", () => {
    const leads = parseOverpass(JSON.parse(fixture("overpass-dentists.json")), "dentist");
    expect(leads.map((l) => l.name)).toEqual([
      "Boise Smiles Dental",
      "Treasure Valley Family Dentistry",
      "Dentist Supply Co",
    ]);
    const [a, b, c] = leads;
    expect(a).toMatchObject({
      website: "https://www.boisesmiles.com",
      domain: "boisesmiles.com",
      phoneE164: "+12085550101",
      street: "123 Main Street",
      city: "Boise",
      region: "ID",
      postcode: "83702",
      lat: 43.615,
      openingHours: "Mo-Fr 08:00-17:00",
      category: "dentist",
      categoryMatched: true,
      refs: { osm: "node/1001" },
      social: { facebook: "https://www.facebook.com/boisesmiles" },
    });
    expect(a.attribution[0]).toMatch(/OpenStreetMap contributors, ODbL/);
    expect(b).toMatchObject({
      website: "https://tvfamilydental.com",
      lat: 43.6,
      phoneE164: "+12085550199",
    });
    expect(b.emails).toEqual([
      { email: "hello@tvfamilydental.com", source: "osm", role: true, onDomain: true },
    ]);
    expect(c.categoryMatched).toBe(false);
  });
});

describe("osmSearch politeness", () => {
  function ctxFor(db: ReturnType<typeof openHubDb>, fetchImpl: typeof fetch, sleeps: number[]) {
    const cfg = loadLeadgenConfig(db);
    return providerCtx(
      db,
      cfg,
      getProvider("osm")!,
      baseDeps({ fetchImpl, sleep: async (ms) => void sleeps.push(ms) }),
    );
  }

  it("geocodes via Photon, backs off 30s on 429, counts quota and caches", async () => {
    const db = openHubDb(":memory:");
    let overpassHits = 0;
    const net = mockFetch([
      ({ url }) =>
        url.hostname === "photon.komoot.io" ? json(JSON.parse(fixture("photon-boise.json"))) : null,
      ({ url, method, body }) => {
        if (url.hostname !== "overpass-api.de" || method !== "POST") return null;
        expect(decodeURIComponent(body)).toContain("area(id:3600122595)");
        overpassHits++;
        return overpassHits === 1
          ? json({ remark: "busy" }, 429)
          : json(JSON.parse(fixture("overpass-dentists.json")));
      },
    ]);
    const sleeps: number[] = [];
    const ctx = ctxFor(db, net.fetch, sleeps);
    const res = await osmSearch({ query: "dentist", location: "Boise, Idaho", limit: 2 }, ctx);
    expect(res.leads).toHaveLength(2);
    expect(res.leads[0].categoryMatched).toBe(true);
    expect(res.attribution).toMatch(/ODbL/);
    expect(sleeps).toEqual([30_000]);
    expect(overpassQuotaUsed(db)).toBe(2);
    expect(net.calls.find((c) => c.url.includes("photon"))?.url).toContain("q=Boise%2C+Idaho");
    // Second identical search is served from cache.
    await osmSearch({ query: "dentist", location: "Boise, Idaho", limit: 2 }, ctx);
    expect(overpassHits).toBe(2);
  });

  it("refuses to exceed the daily quota and needs a location", async () => {
    const db = openHubDb(":memory:");
    saveLeadgenConfig(
      db,
      { dailyOverpassQuota: 1, providers: { osm: { geocoderUrl: "none" } } },
      baseDeps(),
    );
    const net = mockFetch([() => json({ elements: [] })]);
    const ctx = ctxFor(db, net.fetch, []);
    await osmSearch({ query: "cafe", location: "Boise", limit: 5 }, ctx);
    expect(net.calls[0].url).toContain("overpass-api.de"); // geocoder "none" → area by name
    await expect(osmSearch({ query: "bar", location: "Boise", limit: 5 }, ctx)).rejects.toThrow(
      /quota/,
    );
    await expect(osmSearch({ query: "bar", location: null, limit: 5 }, ctx)).rejects.toThrow(
      /location/,
    );
  });
});

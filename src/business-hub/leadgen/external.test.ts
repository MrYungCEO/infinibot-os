import { describe, expect, it } from "vitest";
import { openHubDb } from "../db.js";
import { loadLeadgenConfig, providerCtx, saveLeadgenConfig } from "./config.js";
import { gosomSearch, parseCsv, parseGosomCsv } from "./external.js";
import { getProvider } from "./providers.js";
import { baseDeps, fixture, json, mockFetch, text } from "./test-utils.js";
import { emptyLead } from "./types.js";
import { applyWikidata, buildWikidataQuery } from "./wikidata.js";

describe("CSV + gosom", () => {
  it("parses quoted CSV", () => {
    expect(parseCsv('a,b,c\n"x, y","say ""hi""",\r\n"multi\nline",2,3\n')).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', ""],
      ["multi\nline", "2", "3"],
    ]);
  });

  it("maps the gosom results CSV", () => {
    const leads = parseGosomCsv(fixture("gosom-results.csv"));
    expect(leads).toHaveLength(2); // the untitled row is dropped
    expect(leads[0]).toMatchObject({
      name: "Boise Smiles Dental",
      website: "https://www.boisesmiles.com",
      domain: "boisesmiles.com",
      phoneE164: "+12085550101",
      rating: 4.8,
      reviewCount: 112,
      lat: 43.615,
      lon: -116.2023,
      category: "Dentist",
      city: "Boise",
      postcode: "83702",
      refs: { gosom: "https://www.google.com/maps/place/a" },
    });
    expect(leads[0].emails.map((e) => e.email)).toEqual([
      "info@boisesmiles.com",
      "jane.doe@boisesmiles.com",
    ]);
    expect(leads[1]).toMatchObject({ name: "Downtown Dental, PLLC", reviewCount: 8 });
    expect(leads[1].website).toBeUndefined();
  });

  it("drives the gosom REST job lifecycle", async () => {
    const db = openHubDb(":memory:");
    const deps = baseDeps();
    saveLeadgenConfig(
      db,
      { providers: { gosom: { serviceUrl: "http://gmaps.local:8080/" } } },
      deps,
    );
    let polls = 0;
    let created: unknown = null;
    const net = mockFetch([
      ({ url, method, body }) => {
        if (url.pathname === "/api/v1/jobs" && method === "POST") {
          created = JSON.parse(body);
          return json({ id: "job-1" }, 201);
        }
        return null;
      },
      ({ url }) =>
        url.pathname === "/api/v1/jobs/job-1"
          ? json({ ID: "job-1", Status: ++polls < 2 ? "working" : "ok" })
          : null,
      ({ url }) =>
        url.pathname === "/api/v1/jobs/job-1/download" ? text(fixture("gosom-results.csv")) : null,
    ]);
    const cfg = loadLeadgenConfig(db);
    const ctx = providerCtx(db, cfg, getProvider("gosom")!, { ...deps, fetchImpl: net.fetch });
    const res = await gosomSearch({ query: "dentist", location: "Boise, ID", limit: 10 }, ctx);
    expect(created).toMatchObject({
      keywords: ["dentist in Boise, ID"],
      email: true,
      lang: "en",
      depth: 1,
    });
    expect(polls).toBe(2);
    expect(res.leads).toHaveLength(2);
    expect(net.calls[0].url).toBe("http://gmaps.local:8080/api/v1/jobs");
  });
});

describe("wikidata", () => {
  it("builds a website-variant query and applies bindings", () => {
    const q = buildWikidataQuery({ domain: "acme.com" })!;
    expect(q).toContain("<https://www.acme.com/>");
    expect(q).toContain("wdt:P856");
    expect(buildWikidataQuery({ name: 'Acme "Co"' })).toContain('"Acme \\"Co\\""@en');
    expect(buildWikidataQuery({})).toBeNull();
    const lead = emptyLead("Acme", "osm");
    const ok = applyWikidata(lead, {
      results: {
        bindings: [
          {
            item: { value: "http://www.wikidata.org/entity/Q123" },
            industryLabel: { value: "software industry" },
            employees: { value: "250" },
            inception: { value: "+1999-01-01T00:00:00Z" },
            countryLabel: { value: "United States" },
          },
        ],
      },
    });
    expect(ok).toBe(true);
    expect(lead).toMatchObject({
      industry: "software industry",
      employees: 250,
      founded: "1999-01-01",
      country: "United States",
      refs: { wikidata: "Q123" },
    });
  });
});

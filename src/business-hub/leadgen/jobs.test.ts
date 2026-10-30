import { beforeEach, describe, expect, it } from "vitest";
import { openHubDb } from "../db.js";
import { getContact, listContacts, timeline, upsertCompany, upsertContact } from "../contacts.js";
import { LEADGEN_METHOD_SCOPES, leadgenHubHandlers } from "../rpc/leadgen.js";
import { CONFIG_KEY, listProviderStatus, saveLeadgenConfig } from "./config.js";
import { resetHttpState } from "./http.js";
import { enrichHubRecord, importLeadResults } from "./import.js";
import { getLeadJob, listLeadJobs, listLeadResults, startLeadSearch } from "./jobs.js";
import { verifyEmail } from "./verify.js";
import { resetOsmState } from "./osm.js";
import {
  baseDeps,
  boiseSmilesSite,
  fixture,
  html,
  json,
  mockFetch,
  mockMx,
  text,
} from "./test-utils.js";
import type { JobProgress } from "./types.js";

beforeEach(() => {
  resetHttpState();
  resetOsmState();
});

/** Overpass + Photon + two business websites. */
function network() {
  return mockFetch([
    ({ url }) =>
      url.hostname === "photon.komoot.io" ? json(JSON.parse(fixture("photon-boise.json"))) : null,
    ({ url }) =>
      url.hostname === "overpass-api.de"
        ? json(JSON.parse(fixture("overpass-dentists.json")))
        : null,
    boiseSmilesSite,
    ({ url }) => {
      if (url.hostname !== "tvfamilydental.com") return null;
      if (url.pathname === "/robots.txt") return text("User-agent: *\nDisallow: /", 200);
      return html("<a href='mailto:secret@tvfamilydental.com'>x</a>");
    },
  ]);
}

describe("lead search job", () => {
  it("searches, enriches, verifies, scores and flags existing CRM records", async () => {
    const db = openHubDb(":memory:");
    // Already in the CRM: the Treasure Valley practice (by domain).
    const existing = upsertCompany(db, {
      name: "TV Family Dental",
      website: "https://tvfamilydental.com",
    })!;
    const net = network();
    const progress: JobProgress[] = [];
    const deps = baseDeps({
      fetchImpl: net.fetch,
      resolveMx: mockMx(["boisesmiles.com", "tvfamilydental.com"]),
      onProgress: (_id, p) => progress.push(p),
    });
    const { jobId, done } = startLeadSearch(
      db,
      { query: "dentist", location: "Boise, Idaho", limit: 10 },
      deps,
    );
    expect(getLeadJob(db, jobId)?.status).toBe("queued");
    await done;

    const job = getLeadJob(db, jobId)!;
    expect(job.status).toBe("done");
    expect(job.error).toBeNull();
    expect(job.resultCount).toBe(3);
    expect(job.providers).toEqual(["osm", "website", "email-patterns"]);
    expect(job.progress).toMatchObject({ stage: "done", found: 3, enriched: 3, verified: 3 });
    expect(job.progress.attribution?.[0]).toMatch(/ODbL/);
    expect(progress.map((p) => p.stage)).toEqual(
      expect.arrayContaining(["search", "enrich", "verify", "done"]),
    );

    const { results, total } = listLeadResults(db, jobId);
    expect(total).toBe(3);
    const top = results[0];
    expect(top.data.name).toBe("Boise Smiles Dental");
    expect(top.dedupeKey).toBe("d:boisesmiles.com");
    expect(top.data.email).toBe("jane.doe@boisesmiles.com");
    expect(top.data.emailStatus).toBe("valid");
    expect(top.data.people.map((p) => p.name)).toContain("Dr. Jane Doe");
    expect(top.data.scoreReasons).toContain("+25 verified email");
    expect(top.score).toBeGreaterThanOrEqual(90);
    expect(top.data.existing).toBeNull();

    const tv = results.find((r) => r.data.name.startsWith("Treasure"))!;
    expect(tv.data.existing).toEqual({ companyId: existing.company.id, contactId: null });
    // robots.txt disallowed the whole site, so only the OSM email is known.
    expect(tv.data.emails.map((e) => e.email)).toEqual(["hello@tvfamilydental.com"]);
    expect(tv.data.notes?.join(" ")).toMatch(/robots/);
    expect(
      net.calls.some((c) => c.url.includes("tvfamilydental.com/") && !c.url.endsWith("robots.txt")),
    ).toBe(false);

    expect(listLeadResults(db, jobId, { minScore: 60 }).total).toBe(2);
    expect(listLeadResults(db, jobId, { hasEmail: true }).total).toBe(2);
    expect(listLeadJobs(db).map((j) => j.id)).toEqual([jobId]);
  });

  it("imports results into contacts/companies with source, tags and activity", async () => {
    const db = openHubDb(":memory:");
    upsertContact(db, { name: "Front desk", email: "hello@tvfamilydental.com" });
    const deps = baseDeps({
      fetchImpl: network().fetch,
      resolveMx: mockMx(["boisesmiles.com", "tvfamilydental.com"]),
    });
    const { jobId, done } = startLeadSearch(
      db,
      { query: "dentist", location: "Boise, Idaho", limit: 10 },
      deps,
    );
    await done;
    const hooked: Array<[string | null, string | null]> = [];
    const res = importLeadResults(db, jobId, "all", {
      tags: ["boise-q4"],
      createDeals: true,
      onImported: (c, co) => hooked.push([c, co]),
    });
    expect(res).toMatchObject({ created: 2, updated: 1, skipped: 0 });
    expect(hooked).toHaveLength(3);

    const { contacts } = listContacts(db, { limit: 50 });
    const jane = contacts.find((c) => c.email === "jane.doe@boisesmiles.com")!;
    expect(jane).toMatchObject({
      name: "Dr. Jane Doe",
      title: "Owner & Lead Dentist",
      lifecycle: "lead",
      emailStatus: "valid",
    });
    expect(jane.score).toBeGreaterThanOrEqual(90);
    const janeFull = getContact(db, jane.id)!;
    expect(janeFull.tags).toEqual(expect.arrayContaining(["dentist · Boise, Idaho", "boise-q4"]));
    const src = db
      .prepare("SELECT kind, name FROM sources WHERE id = ?")
      .get(janeFull.firstSourceId) as { kind: string; name: string };
    expect(src).toEqual({ kind: "leadgen", name: "OpenStreetMap" });
    const company = db
      .prepare("SELECT * FROM companies WHERE id = ?")
      .get(janeFull.companyId) as Record<string, unknown>;
    expect(company).toMatchObject({
      name: "Boise Smiles Dental",
      domain: "boisesmiles.com",
      city: "Boise",
    });
    expect(JSON.parse(company.social as string)).toHaveProperty("facebook");
    const acts = timeline(db, "contact", jane.id).filter((a) => a.type === "leadgen.imported");
    expect(acts).toHaveLength(1);
    expect(acts[0].summary).toContain("OpenStreetMap");
    expect(acts[0].data.attribution).toEqual(
      expect.arrayContaining([expect.stringMatching(/ODbL/)]),
    );

    // The existing hello@ contact was matched + updated, not duplicated.
    expect(contacts.filter((c) => c.email === "hello@tvfamilydental.com")).toHaveLength(1);
    // A phone-only business still becomes a contact (phone) + company.
    const supply = contacts.find((c) => c.name === "Dentist Supply Co");
    expect(supply?.phoneE164).toBe("+12085550123");

    const after = listLeadResults(db, jobId);
    expect(after.results.every((r) => r.status === "imported" && r.companyId)).toBe(true);
    expect(getLeadJob(db, jobId)?.importedCount).toBe(3);
    // Re-import is a no-op.
    expect(importLeadResults(db, jobId, "all")).toMatchObject({
      created: 0,
      updated: 0,
      skipped: 3,
    });
  });

  it("records provider errors and fails when nothing was found", async () => {
    const db = openHubDb(":memory:");
    const net = mockFetch([() => json({ error: "down" }, 503)]);
    const { jobId, done } = startLeadSearch(
      db,
      { query: "dentist", location: "Boise" },
      baseDeps({ fetchImpl: net.fetch }),
    );
    await done;
    const job = getLeadJob(db, jobId)!;
    expect(job.status).toBe("error");
    expect(job.error).toMatch(/Overpass HTTP 503/);
    expect(() => startLeadSearch(db, { query: "x", providers: ["serpapi"] }, baseDeps())).toThrow(
      /API key/,
    );
    expect(() => startLeadSearch(db, { query: " " }, baseDeps())).toThrow(/query/);
  });
});

describe("enrich + verify + config", () => {
  it("enriches an existing company and contact from the website", async () => {
    const db = openHubDb(":memory:");
    const co = upsertCompany(db, {
      name: "Boise Smiles Dental",
      website: "https://www.boisesmiles.com",
    })!;
    const ct = upsertContact(db, {
      name: "Dr. Jane Doe",
      companyId: co.company.id,
      phone: "208-555-0999",
    })!;
    const deps = baseDeps({
      fetchImpl: mockFetch([boiseSmilesSite]).fetch,
      resolveMx: mockMx(["boisesmiles.com"]),
    });
    const res = await enrichHubRecord(db, { type: "contact", id: ct.contact.id }, deps);
    expect(res.filled).toEqual(
      expect.arrayContaining([
        "company.phone",
        "company.city",
        "company.social.facebook",
        "contact.email",
      ]),
    );
    const updated = getContact(db, ct.contact.id)!;
    expect(updated.email).toBe("jane.doe@boisesmiles.com");
    expect(updated.emailStatus).toBe("valid");
    expect(timeline(db, "contact", ct.contact.id).some((a) => a.type === "leadgen.enriched")).toBe(
      true,
    );
  });

  it("verifies a single address and stores config with masked, encrypted keys", async () => {
    const db = openHubDb(":memory:");
    const deps = baseDeps({ resolveMx: mockMx(["acme.com"]) });
    expect(await verifyEmail(db, "jane@acme.com", deps)).toMatchObject({
      status: "risky",
      mx: true,
    });
    expect((await verifyEmail(db, "jane@nomx.org", deps)).status).toBe("invalid");

    saveLeadgenConfig(
      db,
      { providers: { hunter: { apiKey: "hk_1234567890abcdef" } }, dailyOverpassQuota: 50 },
      deps,
    );
    const raw = db.prepare("SELECT value FROM hub_meta WHERE key = ?").get(CONFIG_KEY) as {
      value: string;
    };
    expect(raw.value).not.toContain("hk_1234567890abcdef");
    const status = listProviderStatus(db, deps);
    const hunter = status.providers.find((p) => p.id === "hunter")!;
    expect(hunter).toMatchObject({ enabled: true, availability: { ok: true } });
    expect(hunter.config.apiKey).toBe("hk_••••cdef");
    expect(hunter.config.apiKeySource).toBe("config");
    expect(status.dailyOverpassQuota).toBe(50);
    const serp = status.providers.find((p) => p.id === "serpapi")!;
    expect(serp).toMatchObject({ enabled: false, availability: { ok: false } });
    // Env keys (legacy SERP_API_KEY) make a BYOK provider available but not enabled.
    const envSerp = listProviderStatus(db, {
      ...deps,
      env: { SERP_API_KEY: "serp_abcdefgh1234" },
    }).providers.find((p) => p.id === "serpapi")!;
    expect(envSerp).toMatchObject({
      enabled: false,
      availability: { ok: true },
      config: { apiKeySource: "env" },
    });
    expect(() => saveLeadgenConfig(db, { providers: { nope: { enabled: true } } }, deps)).toThrow(
      /unknown provider/,
    );
    expect(() =>
      saveLeadgenConfig(db, { providers: { gosom: { serviceUrl: "file:///x" } } }, deps),
    ).toThrow(/http/);
  });

  it("exposes one scope per RPC method", () => {
    expect(Object.keys(LEADGEN_METHOD_SCOPES).sort()).toEqual(
      Object.keys(leadgenHubHandlers).sort(),
    );
    expect(LEADGEN_METHOD_SCOPES["hub.leadgen.config.set"]).toBe("admin");
    expect(LEADGEN_METHOD_SCOPES["hub.leadgen.search"]).toBe("write");
    expect(LEADGEN_METHOD_SCOPES["hub.leadgen.providers"]).toBe("read");
  });
});

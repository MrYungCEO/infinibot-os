import { describe, expect, it } from "vitest";
import { dedupeKey, dedupeLeads, scoreLead } from "./scoring.js";
import { emptyLead, type LeadData } from "./types.js";

function lead(name: string, provider: string, patch: Partial<LeadData> = {}): LeadData {
  return { ...emptyLead(name, provider), ...patch };
}

describe("dedupe", () => {
  it("merges by domain, then phone, then name+city", () => {
    const leads = [
      lead("Boise Smiles Dental", "osm", {
        website: "https://www.boisesmiles.com",
        domain: "boisesmiles.com",
        city: "Boise",
      }),
      lead("Boise Smiles", "gosom", {
        website: "https://boisesmiles.com/home",
        phone: "(208) 555-0101",
        rating: 4.8,
        emails: [{ email: "info@boisesmiles.com", source: "gosom" }],
      }),
      lead("Smiles Boise LLC", "serpapi", { phoneE164: "+12085550101" }), // joins via phone
      lead("Downtown Dental, LLC", "osm", { city: "Boise" }),
      lead("Downtown Dental", "gosom", { city: "boise", reviewCount: 8 }), // name+city
      lead("Downtown Dental", "osm", { city: "Meridian" }), // other branch
    ];
    const out = dedupeLeads(leads);
    expect(out).toHaveLength(3);
    expect(out[0].key).toBe("d:boisesmiles.com");
    expect(out[0].lead.providers).toEqual(["osm", "gosom", "serpapi"]);
    expect(out[0].lead.rating).toBe(4.8);
    expect(out[0].lead.emails).toHaveLength(1);
    expect(out[1].key).toBe("n:downtown dental|boise");
    expect(out[1].lead.reviewCount).toBe(8);
    expect(out[2].lead.city).toBe("Meridian");
    expect(dedupeKey(lead("X", "osm", { phone: "208-555-0000" }))).toBe("p:+12085550000");
    // Free-mail domains never become a company key.
    expect(dedupeKey(lead("Y", "osm", { website: "https://gmail.com" }))).toBe("n:y|");
  });
});

describe("scoreLead", () => {
  it("rewards complete, verified, well-reviewed leads", () => {
    const full = lead("Boise Smiles Dental", "osm", {
      website: "https://www.boisesmiles.com",
      phone: "+12085550101",
      email: "jane.doe@boisesmiles.com",
      emails: [
        {
          email: "jane.doe@boisesmiles.com",
          source: "website",
          status: "valid",
          personName: "Jane Doe",
        },
      ],
      people: [{ name: "Jane Doe", title: "Owner" }],
      rating: 4.8,
      reviewCount: 112,
      social: { facebook: "f", instagram: "i", linkedin: "l", x: "x" },
      categoryMatched: true,
      category: "dentist",
    });
    const s = scoreLead(full);
    expect(s.score).toBe(100);
    expect(s.reasons).toContain("+25 verified email");
    expect(s.reasons).toContain("+10 category match (dentist)");

    const bare = scoreLead(lead("Nameless", "osm"));
    expect(bare.score).toBe(0);
    const mid = scoreLead(
      lead("Mid", "osm", {
        phone: "1",
        emails: [{ email: "info@mid.com", source: "website", status: "risky" }],
        social: { facebook: "f" },
      }),
    );
    expect(mid.score).toBe(15 + 10 + 3);
  });
});

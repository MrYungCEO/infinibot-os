import { describe, expect, it } from "vitest";

import { applyModelFlags, findSensitive, sanitizeBatch, sanitizeQuery } from "./sanitizer.js";

const kinds = (q: string, terms: string[] = []) =>
  sanitizeQuery(q, { sensitiveTerms: terms }).removed.map((r) => r.kind);

describe("secure research sanitizer — keeps generic collectible terms", () => {
  it.each([
    "1924 German External Loan bond value",
    "1935 1000 Reichsmark bond market value",
    "1924 7% Dawes loan $1,000 gold bond auction price",
    "Reichsbank 1000 Mark 1910 banknote price",
    "1000 Mark Note 1920s value",
    "Young Plan 1930 bond catalog value",
    "Weimar Republic 10000 mark banknote uncirculated price",
  ])("keeps %s verbatim", (q) => {
    const s = sanitizeQuery(q);
    expect(s.ok).toBe(true);
    expect(s.query).toBe(q);
    expect(s.removed).toEqual([]);
  });
});

describe("secure research sanitizer — strips personal data", () => {
  it("strips owner names (including non-ASCII), serials and certificate numbers", () => {
    const s = sanitizeQuery(
      "1924 German External Loan $1,000 gold bond serial A1070 owned by Hans Müller",
    );
    expect(s.query).toBe("1924 German External Loan $1,000 gold bond");
    expect(s.query).not.toMatch(/A1070|Hans|Müller/);
    expect(s.removed.map((r) => r.kind).sort()).toEqual(["name", "serial"]);
  });

  it("strips emails, phone numbers, file names and No.-style references", () => {
    const s = sanitizeQuery(
      "value of bond No. 004512 from scan_0012.pdf call +49 30 1234567 or hans@example.de",
    );
    expect(s.query).toBe("value of bond");
    expect(
      kinds(
        "value of bond No. 004512 from scan_0012.pdf call +49 30 1234567 or hans@example.de",
      ).sort(),
    ).toEqual(["email", "file", "phone", "serial"].sort());
  });

  it("strips street addresses, postcode + city, relatives' names", () => {
    const s = sanitizeQuery(
      "Reichsbank 1000 Mark 1910 banknote price, my grandfather Karl Weber, Hauptstraße 12, 10115 Berlin",
    );
    expect(s.query).toBe("Reichsbank 1000 Mark 1910 banknote price");
    const s2 = sanitizeQuery("1935 Reichsmark bond 221B Baker Street value");
    expect(s2.query).not.toMatch(/Baker|221B/);
  });

  it("strips exact personal amounts and full dates but keeps round denominations and years", () => {
    const s = sanitizeQuery("John Smith paid $12,437.50 for a 7% Dawes loan bond on 12/03/2019");
    expect(s.query).toBe("paid for a 7% Dawes loan bond");
    expect(s.query).not.toMatch(/12,437|2019|John|Smith/);
    expect(sanitizeQuery("€3.475 1935 bond value").query).toBe("1935 bond value");
    expect(sanitizeQuery("$500 1924 gold bond value").query).toBe("$500 1924 gold bond value");
  });

  it("strips IBANs, card and long account numbers", () => {
    expect(
      sanitizeQuery("IBAN DE89 3704 0044 0532 0130 00 Young Plan bond value").query,
    ).not.toMatch(/\d{4} \d{4}/);
    expect(sanitizeQuery("4111 1111 1111 1111 bond value").query).toBe("bond value");
    expect(sanitizeQuery("account 99887766 bond 1924 value").query).toBe("bond 1924 value");
  });

  it("strips URLs and paths", () => {
    expect(sanitizeQuery("https://example.com/my-scan?id=7 1924 bond value").query).toBe(
      "1924 bond value",
    );
    expect(sanitizeQuery("/home/hans/Secure/bond-1924.png bond value").query).toBe("bond value");
  });

  it("strips vault / owner sensitive terms (case-insensitive, whole words)", () => {
    const s = sanitizeQuery("Weber Family Trust 1924 German External Loan bond value", {
      sensitiveTerms: ["weber family trust"],
    });
    expect(s.query).toBe("1924 German External Loan bond value");
    expect(s.removed).toEqual([{ kind: "sensitive", text: "Weber Family Trust" }]);
  });

  it("ignores vault terms that are pure vocabulary (a node called 'Bond' must not blank every query)", () => {
    const s = sanitizeQuery("1924 bond value", { sensitiveTerms: ["Bond", "1924"] });
    expect(s.query).toBe("1924 bond value");
  });

  it("rejects queries with nothing generic left", () => {
    const s = sanitizeQuery("Hans Müller A1070 hans@example.de");
    expect(s.ok).toBe(false);
    expect(s.query).toBe("");
    expect(s.reason).toMatch(/Nothing generic/);
  });

  it("output is a fixed point: nothing sensitive remains in any accepted query", () => {
    const inputs = [
      "Dr. Erika Schmidt's 1935 1000 Reichsmark bond cert. 55-221 value",
      "bond #B-99231 from 1924, Lindenallee 4, 50668 Köln, phone 0221 555 0101",
      "1924 German External Loan bond value",
    ];
    const { accepted } = sanitizeBatch(inputs);
    for (const a of accepted) expect(findSensitive(a.query)).toEqual([]);
    expect(accepted.map((a) => a.query).join(" ")).not.toMatch(
      /Erika|Schmidt|55-221|B-99231|Lindenallee|Köln|0221/,
    );
  });

  it("dedupes and caps the batch", () => {
    const { accepted } = sanitizeBatch(
      ["1924 bond value", "1924 BOND value", "a b", "1935 bond price"],
      {},
      1,
    );
    expect(accepted.map((a) => a.query)).toEqual(["1924 bond value"]);
  });

  it("local-model flags can only remove words", () => {
    const base = sanitizeQuery("Lindenhof estate 1924 German External Loan bond value");
    const flagged = applyModelFlags(base, [
      "Lindenhof estate",
      "something not in the query",
      "price",
    ]);
    expect(flagged.query).toBe("1924 German External Loan bond value");
    expect(flagged.removed.some((r) => r.kind === "model")).toBe(true);
    // the model cannot inject words
    expect(flagged.query.split(" ").every((w) => base.query.includes(w))).toBe(true);
  });
});

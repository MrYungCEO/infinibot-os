import { describe, expect, it } from "vitest";
import { getTheme } from "../themes/index.js";
import { blackGold } from "../themes/black-gold.js";
import { goldLetterhead } from "../themes/gold-letterhead.js";
import {
  displayWebsite,
  embeddableLogo,
  monogramFor,
  resolveDocumentBrand,
  splitAddress,
} from "./brand.js";

const theme = goldLetterhead;

describe("resolveDocumentBrand", () => {
  it("inherits the theme's palette when the profile sets no colours", () => {
    const brand = resolveDocumentBrand({ name: "Northwind Studio" }, theme);
    expect(brand.colors.accent).toBe(theme.tokens.accent);
    expect(brand.colors.bg).toBe(theme.tokens.bg);
    expect(brand.colors.text).toBe(theme.tokens.text);
  });

  it("follows whichever theme it is layered over", () => {
    const dark = resolveDocumentBrand({ name: "Northwind Studio" }, blackGold);
    expect(dark.colors.bg).toBe(blackGold.tokens.bg);
    expect(dark.colors.accent).toBe(blackGold.tokens.accent);
  });

  it("lets branding_json override individual colours", () => {
    const brand = resolveDocumentBrand(
      { name: "Acme", branding: { primaryColor: "#0f62fe", textColor: "rgb(2, 6, 23)" } },
      theme,
    );
    expect(brand.colors.accent).toBe("#0f62fe");
    expect(brand.colors.text).toBe("rgb(2, 6, 23)");
    // Untouched tokens still come from the theme.
    expect(brand.colors.border).toBe(theme.tokens.border);
  });

  it("pulls the strong accent along with a lone primary override", () => {
    // Otherwise a blue brand would print a blue heading rule against the
    // theme's gold totals.
    const brand = resolveDocumentBrand({ name: "Acme", branding: { primary: "#0f62fe" } }, theme);
    expect(brand.colors.accentStrong).toBe("#0f62fe");
  });

  it("discards a colour that would break out of the CSS declaration", () => {
    const brand = resolveDocumentBrand(
      { name: "Acme", branding: { accent: "red; } html { display: none } .x {" } },
      theme,
    );
    expect(brand.colors.accent).toBe(theme.tokens.accent);
  });

  it("falls back to a usable brand when the whole profile is missing", () => {
    const brand = resolveDocumentBrand(null, theme);
    expect(brand.name).toBe("Your Agency");
    expect(brand.monogram).toBe("YA");
    expect(brand.logoDataUri).toBeNull();
    expect(brand.tagline).toBeNull();
    expect(brand.addressLines).toEqual([]);
    expect(brand.email).toBeNull();
    expect(brand.colors.accent).toBe(theme.tokens.accent);
  });

  it("keeps contact fields and splits the address", () => {
    const brand = resolveDocumentBrand(
      {
        name: "Northwind Studio",
        tagline: "Brand systems",
        email: "hi@northwind.studio",
        phone: "+1 415 555 0142",
        website: "https://northwind.studio/",
        address: "1200 Harrison Street\nSuite 410\nSan Francisco, CA 94103",
      },
      theme,
    );
    expect(brand.website).toBe("northwind.studio");
    expect(brand.addressLines).toEqual([
      "1200 Harrison Street",
      "Suite 410",
      "San Francisco, CA 94103",
    ]);
    expect(brand.email).toBe("hi@northwind.studio");
  });

  it("resolves through the theme registry by name", () => {
    const brand = resolveDocumentBrand({ name: "Acme" }, getTheme("gold-letterhead"));
    expect(brand.colors.bg).toBe("#ffffff");
  });
});

describe("splitAddress", () => {
  it("prefers newlines, falls back to commas, and caps the line count", () => {
    expect(splitAddress("A\nB")).toEqual(["A", "B"]);
    expect(splitAddress("A, B, C")).toEqual(["A", "B", "C"]);
    expect(splitAddress("a,b,c,d,e,f,g")).toHaveLength(5);
    expect(splitAddress(null)).toEqual([]);
    expect(splitAddress("   ")).toEqual([]);
  });
});

describe("monogramFor", () => {
  it("takes initials, or two letters from a single word", () => {
    expect(monogramFor("Northwind Studio")).toBe("NS");
    expect(monogramFor("Acme")).toBe("AC");
    expect(monogramFor("北風 工房")).toBe("北工");
    expect(monogramFor("!!!")).toBe("AG");
  });
});

describe("embeddableLogo", () => {
  it("accepts data-image URIs only", () => {
    expect(embeddableLogo("data:image/png;base64,iVBORw0KGgo=")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    // A remote logo would need a network fetch mid-render; documents must
    // render offline, so it is dropped in favour of the monogram.
    expect(embeddableLogo("https://cdn.example/logo.png")).toBeNull();
    expect(embeddableLogo("/var/data/logo.png")).toBeNull();
    expect(embeddableLogo(null)).toBeNull();
  });

  it("refuses a logo large enough to bloat every PDF", () => {
    expect(embeddableLogo(`data:image/png;base64,${"A".repeat(600_000)}`)).toBeNull();
  });
});

describe("displayWebsite", () => {
  it("strips the scheme and trailing slash", () => {
    expect(displayWebsite("https://northwind.studio/")).toBe("northwind.studio");
    expect(displayWebsite("http://a.example/b")).toBe("a.example/b");
    expect(displayWebsite(null)).toBeNull();
  });
});

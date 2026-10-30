import { beforeEach, describe, expect, it } from "vitest";
import {
  assertPublicUrl,
  isPrivateAddress,
  parseRobots,
  resetHttpState,
  robotsAllows,
} from "./http.js";
import { baseDeps, boiseSmilesSite, fixture, mockFetch } from "./test-utils.js";
import { emptyLead } from "./types.js";
import {
  decodeCfEmail,
  emailsFromText,
  extractFromHtml,
  phonesFromText,
  socialNetwork,
} from "./extract.js";
import { applyCrawl, crawlSite, pickLikelyPages } from "./website.js";

beforeEach(() => resetHttpState());

describe("extractFromHtml", () => {
  it("extracts emails, phones, socials and JSON-LD from the homepage", () => {
    const x = extractFromHtml(fixture("site-home.html"), "https://www.boisesmiles.com/");
    expect(x.emails).toContain("info@boisesmiles.com");
    expect(x.emails).toContain("jane.doe@boisesmiles.com"); // "[at] … [dot]" obfuscation
    expect(x.emails).toContain("hello@webagency.io");
    // Asset names and script contents are not emails.
    expect(x.emails.some((e) => /@2x|@3x|cdn|scripts\.com/.test(e))).toBe(false);
    expect(x.phones).toEqual(["+12085550101"]);
    expect(x.social).toEqual({
      facebook: "https://www.facebook.com/boisesmiles",
      instagram: "https://www.instagram.com/boisesmiles/",
      linkedin: "https://www.linkedin.com/company/boise-smiles",
    });
    expect(x.orgs).toHaveLength(1);
    expect(x.orgs[0]).toMatchObject({
      type: "dentist",
      name: "Boise Smiles Dental",
      city: "Boise",
      postcode: "83702",
      rating: 4.8,
      reviewCount: 112,
    });
    expect(x.siteName).toBe("Boise Smiles Dental");
    expect(x.description).toContain("family dentistry");
  });

  it("decodes Cloudflare-protected emails and skips placeholders on the contact page", () => {
    const x = extractFromHtml(
      fixture("site-contact.html"),
      "https://www.boisesmiles.com/contact-us/",
    );
    expect(x.emails).toEqual(["billing@boisesmiles.com"]);
    expect(x.phones).toEqual(["+12085550102"]);
    expect(x.social).toMatchObject({
      x: "https://x.com/boisesmiles",
      youtube: "https://www.youtube.com/@boisesmiles",
    });
  });

  it("finds team members with titles, ignoring headings that are not names", () => {
    const x = extractFromHtml(fixture("site-team.html"), "https://www.boisesmiles.com/about/team");
    expect(x.people).toEqual([
      { name: "Dr. Jane Doe", title: "Owner & Lead Dentist" },
      { name: "Mark Smith", title: "Office Manager" },
      { name: "Emily Stone", title: "Hygienist" },
    ]);
  });

  it("has focused text helpers", () => {
    expect(emailsFromText("mail: bob (at) acme (dot) co (dot) uk")).toEqual(["bob@acme.co.uk"]);
    expect(emailsFromText("image@2x.png sprite@3x.webp")).toEqual([]);
    expect(phonesFromText("Call 208-555-0101, zip 83702, year 2009")).toEqual(["+12085550101"]);
    expect(phonesFromText("+44 20 7946 0958", "GB")).toEqual(["+442079460958"]);
    expect(decodeCfEmail("5a3833363633343d1a383533293f293733363f2974393537")).toBe(
      "billing@boisesmiles.com",
    );
    expect(socialNetwork("https://www.facebook.com/sharer/sharer.php?u=1")).toBeNull();
    expect(socialNetwork("https://twitter.com/intent/tweet")).toBeNull();
    expect(socialNetwork("https://www.tiktok.com/@shop")).toBe("tiktok");
  });

  it("picks likely same-site pages, best first", () => {
    const pages = pickLikelyPages("https://www.boisesmiles.com/", [
      "https://www.boisesmiles.com/about/team",
      "https://www.boisesmiles.com/contact-us/",
      "https://otherdomain.com/contact",
      "https://www.boisesmiles.com/blog",
    ]);
    expect(pages).toEqual([
      "https://www.boisesmiles.com/contact-us/",
      "https://www.boisesmiles.com/about/team",
    ]);
  });
});

describe("robots.txt", () => {
  it("parses groups and applies longest-match", () => {
    const rules = parseRobots(fixture("robots.txt"));
    expect(robotsAllows(rules, "/staff-directory")).toBe(false);
    expect(robotsAllows(rules, "/wp-admin/x")).toBe(false);
    expect(robotsAllows(rules, "/wp-admin/admin-ajax.php")).toBe(true);
    expect(robotsAllows(rules, "/contact-us/")).toBe(true);
    // A group naming us wins over "*".
    const ours = parseRobots(
      "User-agent: *\nDisallow:\n\nUser-agent: InfiniBot-BusinessHub\nDisallow: /",
    );
    expect(robotsAllows(ours, "/")).toBe(false);
  });
});

describe("crawlSite", () => {
  it("crawls homepage + likely pages, honours robots and prefers own-domain emails", async () => {
    const net = mockFetch([boiseSmilesSite]);
    const crawl = await crawlSite(
      "https://www.boisesmiles.com",
      baseDeps({ fetchImpl: net.fetch }),
    );
    expect(crawl.pages.map((p) => new URL(p.url).pathname)).toEqual([
      "/",
      "/contact-us/",
      "/about/team",
    ]);
    expect(crawl.skipped).toEqual(["/staff-directory (robots.txt)"]);
    expect(net.calls.some((c) => c.url.includes("staff-directory"))).toBe(false);
    expect(net.calls.filter((c) => c.url.endsWith("/robots.txt"))).toHaveLength(1);

    const lead = emptyLead("Boise Smiles Dental", "osm");
    lead.website = "https://www.boisesmiles.com";
    lead.domain = "boisesmiles.com";
    applyCrawl(lead, crawl);
    const emails = lead.emails.map((e) => e.email);
    expect(emails.at(-1)).toBe("hello@webagency.io");
    expect(emails[0]).toBe("jane.doe@boisesmiles.com"); // own-domain personal first
    expect(lead.emails.find((e) => e.email === "jane.doe@boisesmiles.com")?.personName).toBe(
      "Dr. Jane Doe",
    );
    expect(lead.people.map((p) => p.name)).toContain("Mark Smith");
    expect(Object.keys(lead.social).sort()).toEqual([
      "facebook",
      "instagram",
      "linkedin",
      "x",
      "youtube",
    ]);
    expect(lead.rating).toBe(4.8);
    expect(lead.phone).toBe("+12085550101");
    expect(lead.providers).toContain("website");
  });

  it("blocks private / loopback targets (SSRF guard)", async () => {
    const deps = baseDeps({ lookupHost: async () => [{ address: "10.0.0.5", family: 4 }] });
    await expect(assertPublicUrl(new URL("http://127.0.0.1/"), deps)).rejects.toThrow(/private/);
    await expect(assertPublicUrl(new URL("http://[::1]/"), deps)).rejects.toThrow(/private/);
    await expect(assertPublicUrl(new URL("file:///etc/passwd"), deps)).rejects.toThrow(/scheme/);
    await expect(assertPublicUrl(new URL("http://localhost:18789/"), deps)).rejects.toThrow(
      /blocked host/,
    );
    await expect(assertPublicUrl(new URL("https://intranet.example.com/"), deps)).rejects.toThrow(
      /private/,
    );
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("100.64.1.1")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
    // Redirects into private space are refused too.
    const net = mockFetch([
      ({ url }) => (url.pathname === "/robots.txt" ? new Response("", { status: 404 }) : null),
      ({ url }) =>
        url.hostname === "www.good.com"
          ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } })
          : null,
    ]);
    const crawl = await crawlSite("https://www.good.com", baseDeps({ fetchImpl: net.fetch }));
    expect(crawl.pages).toHaveLength(0);
    expect(crawl.errors[0]).toMatch(/private/);
  });
});

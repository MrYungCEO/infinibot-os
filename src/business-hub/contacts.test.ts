import { describe, expect, it } from "vitest";
import { openHubDb } from "./db.js";
import {
  findDuplicateContacts,
  listContacts,
  logActivity,
  mergeCompanies,
  mergeContacts,
  timeline,
  upsertCompany,
  upsertContact,
} from "./contacts.js";
import { normalizeEmail, normalizePhone, registrableDomain, toCents } from "./util.js";

describe("normalisers", () => {
  it("normalises emails, phones and domains", () => {
    expect(normalizeEmail(" Jane.Doe@Acme.COM ")).toBe("jane.doe@acme.com");
    expect(normalizeEmail("mailto:x@y.io")).toBe("x@y.io");
    expect(normalizeEmail("not-an-email")).toBeNull();
    expect(normalizeEmail("image@2x.png")).toBeNull();
    expect(normalizePhone("(404) 998-4354")).toBe("+14049984354");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("020 7946 0958", "GB")).toBe("+442079460958");
    expect(normalizePhone("123")).toBeNull();
    expect(registrableDomain("https://shop.acme.co.uk/path")).toBe("acme.co.uk");
    expect(registrableDomain("jane@mail.acme.com")).toBe("acme.com");
    expect(registrableDomain("www.acme.com")).toBe("acme.com");
    expect(toCents("$1,200.50")).toBe(120050);
    expect(toCents("1.200,50 €")).toBe(120050);
  });
});

describe("contacts + companies", () => {
  it("dedupes contacts by email, then phone, and fills empty fields", () => {
    const db = openHubDb(":memory:");
    const a = upsertContact(db, {
      name: "Jane Doe",
      email: "JANE@acme.com",
      company: { name: "Acme Inc" },
    })!;
    expect(a.created).toBe(true);
    const b = upsertContact(db, { email: "jane@acme.com", phone: "404-998-4354", title: "CEO" })!;
    expect(b.created).toBe(false);
    expect(b.matchedBy).toBe("email");
    expect(b.contact.title).toBe("CEO");
    expect(b.contact.phoneE164).toBe("+14049984354");
    const c = upsertContact(db, { name: "J. Doe", phone: "+1 404 998 4354" })!;
    expect(c.created).toBe(false);
    expect(c.matchedBy).toBe("phone");
    expect(listContacts(db).total).toBe(1);
    // company derived from the email domain, deduped by domain
    const co = upsertCompany(db, { name: "ACME", website: "https://www.acme.com" })!;
    expect(co.created).toBe(false);
    expect(co.company.id).toBe(a.contact.companyId);
  });

  it("keeps differently named companies apart even when their people share an email domain", () => {
    const db = openHubDb(":memory:");
    const a = upsertContact(db, {
      name: "Morgan",
      email: "morgan@agency.example",
      company: { name: "Reyes Roofing" },
    })!.contact;
    const b = upsertContact(db, {
      name: "Ava",
      email: "ava@agency.example",
      company: { name: "Harbor Dental" },
    })!.contact;
    expect(a.companyId).not.toBe(b.companyId);
    // A company with no name → the email domain is the company.
    const c = upsertContact(db, { name: "Sam", email: "sam@agency.example", company: {} })!.contact;
    expect(c.companyId).toBe(a.companyId);
    expect(listContacts(db, { search: "harbor" }).total).toBe(1);
  });

  it("does not merge same-name companies in different cities", () => {
    const db = openHubDb(":memory:");
    const x = upsertCompany(db, { name: "Joe's Pizza", city: "Austin" })!;
    const y = upsertCompany(db, { name: "Joe's Pizza", city: "Dallas" })!;
    expect(x.company.id).not.toBe(y.company.id);
    const z = upsertCompany(db, { name: "joes pizza", city: "austin" })!;
    expect(z.company.id).toBe(x.company.id);
  });

  it("merges contacts and companies, moving every reference and the timeline", () => {
    const db = openHubDb(":memory:");
    const w = upsertContact(db, { name: "Sam", email: "sam@a.com", tags: ["vip"] })!.contact;
    const l = upsertContact(db, {
      name: "Sam Smith",
      phone: "+15551234567",
      tags: ["webinar"],
    })!.contact;
    logActivity(db, { subjectType: "contact", subjectId: l.id, type: "note", summary: "called" });
    const merged = mergeContacts(db, w.id, l.id);
    expect(merged.phoneE164).toBe("+15551234567");
    expect(merged.tags?.sort()).toEqual(["vip", "webinar"]);
    expect(timeline(db, "contact", w.id).map((a) => a.type)).toEqual(
      expect.arrayContaining(["note", "merge"]),
    );
    expect(listContacts(db).total).toBe(1);

    const c1 = upsertCompany(db, { name: "Beta", domain: "beta.io" })!.company;
    const c2 = upsertCompany(db, { name: "Beta Labs", city: "Reno" })!.company;
    upsertContact(db, { name: "Al", email: "al@x.com", companyId: c2.id });
    const mc = mergeCompanies(db, c1.id, c2.id);
    expect(mc.city).toBe("Reno");
    expect(listContacts(db, { companyId: c1.id }).total).toBe(1);
  });

  it("reports likely duplicates without an email to tie them", () => {
    const db = openHubDb(":memory:");
    upsertContact(db, { name: "Kim Lee", phone: "+15550001111" });
    db.prepare(
      "INSERT INTO contacts(id,name,phone_e164,created_at,updated_at) VALUES('ct_dup','Kim L','+15550001111',1,1)",
    ).run();
    expect(findDuplicateContacts(db)[0]?.reason).toBe("same phone");
  });
});

import { describe, expect, it } from "vitest";
import { upsertContact } from "../contacts.js";
import { openHubDb } from "../db.js";
import { saveEmailSettings } from "./config.js";
import {
  htmlToText,
  lintTemplate,
  previewTemplate,
  renderEmail,
  renderString,
  saveTemplate,
  withFooter,
} from "./templates.js";

describe("template rendering", () => {
  it("renders variables with defaults, custom fields and HTML escaping", () => {
    const vars = { first_name: "<Jane>", company: null, email: "j@example.com" };
    const custom = { plan: "Pro & Max" };
    const html = renderString(
      "Hi {{first_name|there}} from {{ company | your team }}, plan {{custom.plan}} {{nope}}",
      vars,
      custom,
      { html: true },
    );
    expect(html.out).toBe("Hi &lt;Jane&gt; from your team, plan Pro &amp; Max ");
    expect(html.unknown).toEqual(["nope"]);
    const text = renderString("Hi {{first_name|there}}", { first_name: "" }, {}, { html: false });
    expect(text.out).toBe("Hi there");
  });

  it("renders a contact email, appends a compliant footer and derives text", () => {
    const db = openHubDb(":memory:");
    saveEmailSettings(db, { physicalAddress: "1 Main St, Austin TX", companyName: "Acme" });
    const c = upsertContact(db, {
      email: "jane@example.com",
      name: "Jane Doe",
      company: { name: "Doe & Co" },
      custom: { city_nick: "ATX" },
    })!.contact;
    const r = renderEmail(
      db,
      {
        subject: "Hello {{first_name}}\r\nBcc: evil@example.com",
        html: '<p>Hi {{first_name|there}} at {{company}} <a href="https://example.com/x">site</a></p>',
        text: "",
      },
      c,
      { unsubscribeUrl: "https://hub.example.test/u/tok", senderName: "Sam" },
    );
    expect(r.subject).toBe("Hello Jane Bcc: evil@example.com"); // header injection neutralised
    expect(r.html).toContain("Doe &amp; Co");
    expect(r.footerAppended).toBe(true);
    expect(r.html).toContain('href="https://hub.example.test/u/tok"');
    expect(r.html).toContain("1 Main St, Austin TX");
    expect(r.text).toContain("site (https://example.com/x)");
    expect(r.text).toContain("Unsubscribe");
  });

  it("does not add a second footer when the template links {{unsubscribe_url}}", () => {
    const t = { html: '<a href="{{unsubscribe_url}}">stop</a>', text: "" };
    expect(withFooter(t).appended).toBe(false);
  });

  it("lints unknown variables, missing unsubscribe link and missing address", () => {
    const db = openHubDb(":memory:");
    const lint = lintTemplate(db, { subject: "Hi {{frist_name}}", html: "<p>x</p>", text: "" });
    expect(lint.hasUnsubscribe).toBe(false);
    expect(lint.warnings.join("\n")).toMatch(/frist_name/);
    expect(lint.warnings.join("\n")).toMatch(/footer/);
    expect(lint.warnings.join("\n")).toMatch(/postal address/);
  });

  it("saves templates and previews with a sample contact", () => {
    const db = openHubDb(":memory:");
    const { template } = saveTemplate(db, {
      name: "Intro",
      subject: "Hey {{first_name}}",
      html: "<p>Hi {{first_name}}</p>",
    });
    const p = previewTemplate(db, { templateId: template.id });
    expect(p.subject).toBe("Hey Jane");
    expect(() => saveTemplate(db, { name: "x", subject: "", html: "a" })).toThrow(/subject/);
    expect(htmlToText("<p>a&amp;b</p><br>c")).toBe("a&b\n\nc");
  });
});

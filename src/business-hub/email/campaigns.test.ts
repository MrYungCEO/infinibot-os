import { simpleParser } from "mailparser";
import { afterEach, describe, expect, it } from "vitest";
import { timeline, upsertContact, updateContact } from "../contacts.js";
import { openHubDb, type HubDb } from "../db.js";
import {
  campaignMetrics,
  enrollContact,
  getEmailCampaign,
  saveEmailCampaign,
  startEmailCampaign,
} from "./campaigns.js";
import { configureEmailRuntime, resetEmailRuntime, saveEmailSettings } from "./config.js";
import { processInboundMessage } from "./feedback.js";
import { previewSegment, segmentContactIds } from "./segments.js";
import { listSenders, saveSender } from "./senders.js";
import { runDueSends, sendOne, testSend } from "./sender-loop.js";
import { suppress } from "./suppression.js";
import { saveTemplate } from "./templates.js";
import { startSmtpSink, type SmtpSink } from "./test-helpers.js";
import { verifyToken } from "./tokens.js";

const BASE = "https://hub.example.test";
let sink: SmtpSink | null = null;

afterEach(async () => {
  await sink?.close();
  sink = null;
  resetEmailRuntime();
});

async function setup() {
  const db = openHubDb(":memory:");
  saveEmailSettings(db, { publicBaseUrl: BASE, physicalAddress: "1 Main St, Austin TX" });
  sink = await startSmtpSink();
  const sender = saveSender(db, {
    kind: "smtp-custom",
    label: "Local sink",
    host: "127.0.0.1",
    port: sink.port,
    secure: false,
    fromEmail: "sales@example.test",
    fromName: "Sales Team",
  });
  const t1 = saveTemplate(db, {
    name: "Step 1",
    subject: "Hi {{first_name|there}}",
    html: '<html><body><p>Hello {{first_name}}</p><a href="https://landing.example.com/pricing?x=1">Pricing</a> <a href="mailto:a@example.com">mail</a></body></html>',
  }).template;
  const t2 = saveTemplate(db, {
    name: "Step 2",
    subject: "Following up, {{first_name}}",
    text: "Still interested? https://landing.example.com/book",
  }).template;
  return { db, sender, t1, t2 };
}

function contact(db: HubDb, email: string | null, extra: Record<string, unknown> = {}) {
  return upsertContact(db, { email, name: (email ?? "Phone Only").split("@")[0], ...extra })!
    .contact;
}

describe("segments", () => {
  it("filters by lifecycle, tags, score and excludes tags", () => {
    const db = openHubDb(":memory:");
    const a = contact(db, "a@example.com", { tags: ["vip"], score: 80, lifecycle: "qualified" });
    contact(db, "b@example.com", {
      tags: ["vip", "churn-risk"],
      score: 90,
      lifecycle: "qualified",
    });
    contact(db, "c@example.com", { score: 10 });
    contact(db, null, { phone: "+15125550100", tags: ["vip"] });
    const ids = segmentContactIds(db, {
      tag: "vip",
      excludeTags: ["churn-risk"],
      hasEmail: true,
      minScore: 50,
      lifecycle: ["qualified"],
    });
    expect(ids).toEqual([a.id]);
    const p = previewSegment(db, { tagsAny: ["vip"] });
    expect(p.count).toBe(3);
    expect(p.withEmail).toBe(2);
  });
});

describe("campaign start", () => {
  it("enrolls eligible contacts and records skip reasons", async () => {
    const { db, sender, t1 } = await setup();
    contact(db, "ok@example.com", { emailOptIn: true, tags: ["list"] });
    contact(db, null, { phone: "+15125550101", tags: ["list"] });
    contact(db, "supp@example.com", { emailOptIn: true, tags: ["list"] });
    suppress(db, "supp@example.com", "unsubscribe");
    const bounced = contact(db, "bounce@example.com", { emailOptIn: true, tags: ["list"] });
    updateContact(db, bounced.id, { emailStatus: "bounced" });
    contact(db, "noconsent@example.com", { tags: ["list"] });
    const c = saveEmailCampaign(db, {
      name: "Launch",
      segmentFilter: { tag: "list" },
      steps: [{ templateId: t1.id, delayMinutes: 0 }],
      sender: { senderId: sender.id },
      requireOptIn: true,
    });
    expect(c.utmCampaign).toBe("launch");
    const r = startEmailCampaign(db, c.id);
    expect(r.enrolled).toBe(1);
    expect(r.skipped).toMatchObject({ no_email: 1, suppressed: 1, bounced: 1, not_opted_in: 1 });
    expect(campaignMetrics(db, c.id).skipReasons).toMatchObject({ not_opted_in: 1, suppressed: 1 });
    // A second campaign with the same name gets a unique utm slug.
    expect(saveEmailCampaign(db, { name: "Launch" }).utmCampaign).toBe("launch-2");
  });

  it("refuses to start without a public base URL", async () => {
    const { db, sender, t1 } = await setup();
    saveEmailSettings(db, { publicBaseUrl: null });
    const c = saveEmailCampaign(db, {
      name: "x",
      segmentFilter: {},
      steps: [{ templateId: t1.id }],
      sender: { senderId: sender.id },
    });
    expect(() => startEmailCampaign(db, c.id)).toThrow(/public base URL/);
  });
});

describe("sender loop (in-process SMTP sink)", () => {
  it("sends with tracking, List-Unsubscribe, throttle, step delays and stop-on-reply", async () => {
    const { db, sender, t1, t2 } = await setup();
    const people = ["p1@example.com", "p2@example.com", "p3@example.com"].map((e) =>
      contact(db, e, { tags: ["seq"], firstName: e.slice(0, 2).toUpperCase() }),
    );
    const c = saveEmailCampaign(db, {
      name: "Seq",
      segmentFilter: { tag: "seq" },
      steps: [
        { templateId: t1.id, delayMinutes: 0 },
        { templateId: t2.id, delayMinutes: 60 },
      ],
      sender: { senderId: sender.id },
      perMinute: 2,
    });
    const t0 = 1_800_000_000_000;
    startEmailCampaign(db, c.id, t0);

    // perMinute = 2 → only two of three go out in the first minute.
    const r1 = await runDueSends(db, {}, t0);
    expect(r1.sent).toBe(2);
    expect(r1.throttled).toBe(true);
    expect(sink!.messages).toHaveLength(2);

    const parsed = await simpleParser(sink!.messages[0].raw);
    // Whoever went first is the one who replies below.
    const firstTo = sink!.messages[0].to[0];
    const first = people.find((p) => p.email === firstTo)!;
    expect(first).toBeTruthy();
    expect(parsed.from?.text).toContain("sales@example.test");
    expect(parsed.subject).toBe(`Hi ${firstTo.slice(0, 2).toUpperCase()}`);
    const rawHead = sink!.messages[0].raw.split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ");
    expect(rawHead).toMatch(
      /^List-Unsubscribe:\s*<https:\/\/hub\.example\.test\/plugins\/business-agency\/u\?t=[^>]+>$/m,
    );
    expect(rawHead).toMatch(/^List-Unsubscribe-Post:\s*List-Unsubscribe=One-Click$/m);
    const html = String(parsed.html);
    expect(html).not.toContain('href="https://landing.example.com/pricing');
    expect(html).toContain("mailto:a@example.com"); // non-http links untouched
    const click =
      /href="(https:\/\/hub\.example\.test\/plugins\/business-agency\/t\/k\?t=([^"]+))"/.exec(html);
    expect(click).toBeTruthy();
    const tok = verifyToken(db, click![2], "k");
    expect(tok?.u).toContain("https://landing.example.com/pricing?x=1");
    expect(tok?.u).toContain("utm_campaign=seq");
    expect(html).toMatch(/\/plugins\/business-agency\/t\/o\?t=[^"]+"/);
    expect(html).toContain("1 Main St, Austin TX"); // auto footer
    expect(timeline(db, "contact", first.id).map((a) => a.type)).toContain("email.sent");

    // Next minute: the third contact.
    const r2 = await runDueSends(db, {}, t0 + 61_000);
    expect(r2.sent).toBe(1);
    // Step 2 is not due yet.
    expect((await runDueSends(db, {}, t0 + 120_000)).sent).toBe(0);

    // p1 replies (In-Reply-To = the Message-ID we sent).
    const replied = processInboundMessage(db, {
      id: "in1",
      messageId: "<reply1@example.com>",
      fromAddr: firstTo,
      subject: `Re: ${parsed.subject}`,
      text: "Sounds good",
      html: null,
      headers: { "in-reply-to": parsed.messageId ?? "" },
      receivedAt: t0 + 30 * 60_000,
    });
    expect(replied).toBe("reply");

    const r3 = await runDueSends(db, {}, t0 + 61 * 60_000);
    expect(r3.stopped).toBe(0); // the replier was already stopped by reply detection
    expect(r3.sent).toBe(1); // p2 step 2
    const r4 = await runDueSends(db, {}, t0 + 62 * 60_000);
    expect(r4.sent).toBe(1); // p3 step 2
    expect(r4.campaignsCompleted).toEqual([c.id]);
    expect(getEmailCampaign(db, c.id)?.status).toBe("completed");

    const step2 = await simpleParser(sink!.messages.find((m, i) => i >= 3)!.raw);
    expect(String(step2.text)).toContain("/plugins/business-agency/t/k?t="); // text links tracked
    const m = campaignMetrics(db, c.id);
    expect(m.totals.sent).toBe(5);
    expect(m.totals.replies).toBe(1);
    expect(m.steps.map((s) => s.sent)).toEqual([3, 2]);
    const enr = db
      .prepare("SELECT stopped_reason FROM email_enrollments WHERE contact_id = ?")
      .get(first.id) as { stopped_reason: string };
    expect(enr.stopped_reason).toBe("replied");
  });

  it("records failures and retries later", async () => {
    const { db, sender, t1 } = await setup();
    contact(db, "f@example.com", { tags: ["f"] });
    const c = saveEmailCampaign(db, {
      name: "Fail",
      segmentFilter: { tag: "f" },
      steps: [{ templateId: t1.id }],
      sender: { senderId: sender.id },
    });
    startEmailCampaign(db, c.id, 1000);
    sink!.failNext(1);
    const r = await runDueSends(db, {}, 1000);
    expect(r.failed).toBe(1);
    const s = db.prepare("SELECT status, error FROM email_sends").get() as {
      status: string;
      error: string;
    };
    expect(s.status).toBe("failed");
    expect(s.error).toMatch(/550/);
    expect((await runDueSends(db, {}, 2000)).sent).toBe(0); // backoff
    expect((await runDueSends(db, {}, 1000 + 16 * 60_000)).sent).toBe(1);
  });

  it("testSend goes only to the explicit address and does not count as a campaign send", async () => {
    const { db, sender, t1 } = await setup();
    const c = saveEmailCampaign(db, {
      name: "T",
      segmentFilter: {},
      steps: [{ templateId: t1.id }],
      sender: { senderId: sender.id },
    });
    const r = await testSend(db, c.id, "owner@example.test");
    expect(r.ok).toBe(true);
    expect(sink!.messages).toHaveLength(1);
    expect(sink!.messages[0].to).toEqual(["owner@example.test"]);
    expect((await simpleParser(sink!.messages[0].raw)).subject).toMatch(/^\[Test\]/);
    expect(campaignMetrics(db, c.id).totals.sent).toBe(0);
    await expect(testSend(db, c.id, "not-an-email")).rejects.toThrow(/valid/);
  });

  it("sendOne emails one contact, logs the timeline and refuses suppressed contacts", async () => {
    const { db, sender } = await setup();
    const ct = contact(db, "one@example.com");
    const r = await sendOne(db, {
      contactId: ct.id,
      sender: { senderId: sender.id },
      subject: "Quick question",
      text: "Hi {{first_name|there}}",
      dealId: "dl_x",
    });
    expect(r.ok).toBe(true);
    const types = timeline(db, "contact", ct.id).map((a) => a.type);
    expect(types).toContain("email.sent");
    suppress(db, "one@example.com", "manual");
    await expect(
      sendOne(db, { contactId: ct.id, sender: { senderId: sender.id }, subject: "x", text: "y" }),
    ).rejects.toThrow(/suppression/);
  });

  it("enrollContact respects eligibility; senders list never exposes secrets", async () => {
    const { db, sender, t1 } = await setup();
    const c = saveEmailCampaign(db, {
      name: "E",
      segmentFilter: {},
      steps: [{ templateId: t1.id }],
      sender: { senderId: sender.id },
      requireOptIn: true,
    });
    const ct = contact(db, "e@example.com");
    expect(enrollContact(db, c.id, ct.id)).toEqual({ enrolled: false, reason: "not_opted_in" });
    updateContact(db, ct.id, { emailOptIn: true });
    expect(enrollContact(db, c.id, ct.id).enrolled).toBe(true);
    saveSender(db, {
      kind: "resend",
      label: "R",
      apiKey: "re_secret_key_1234",
      fromEmail: "a@example.test",
    });
    const listed = JSON.stringify(listSenders(db));
    expect(listed).not.toContain("re_secret_key_1234");
    expect(listed).toContain("••••1234");
  });

  it("Resend transport posts the expected payload (fake fetch, no network)", async () => {
    const { db, t1 } = await setup();
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    configureEmailRuntime({
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({
          url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
          body: JSON.parse(init?.body as string),
        });
        return new Response(JSON.stringify({ id: "re_msg_1" }), { status: 200 });
      }) as typeof fetch,
    });
    const s = saveSender(db, {
      kind: "resend",
      label: "R",
      apiKey: "re_k",
      fromEmail: "news@example.test",
    });
    contact(db, "r@example.com", { tags: ["r"] });
    const c = saveEmailCampaign(db, {
      name: "R",
      segmentFilter: { tag: "r" },
      steps: [{ templateId: t1.id }],
      sender: { senderId: s.id },
    });
    startEmailCampaign(db, c.id, 5000);
    expect((await runDueSends(db, {}, 5000)).sent).toBe(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].body.to).toEqual(["r@example.com"]);
    expect((calls[0].body.headers as Record<string, string>)["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click",
    );
    const row = db.prepare("SELECT provider_message_id FROM email_sends").get() as {
      provider_message_id: string;
    };
    expect(row.provider_message_id).toBe("re_msg_1");
  });
});

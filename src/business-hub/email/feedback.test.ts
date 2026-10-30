import { createHmac, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { getContact, timeline, upsertContact } from "../contacts.js";
import { openHubDb, type HubDb } from "../db.js";
import { createBusinessHubDispatcher } from "../http.js";
import { saveEmailCampaign, startEmailCampaign } from "./campaigns.js";
import {
  configureEmailRuntime,
  getWebhookSecret,
  resetEmailRuntime,
  saveEmailSettings,
} from "./config.js";
import { parseDsn, pollInboundForReplies, type InboundMessage } from "./feedback.js";
import { saveSender } from "./senders.js";
import { runDueSends } from "./sender-loop.js";
import { isSuppressed } from "./suppression.js";
import { saveTemplate } from "./templates.js";
import { startHttp } from "./test-helpers.js";
import { verifyToken } from "./tokens.js";
import type { OutgoingEmail } from "./transport.js";

const BASE = "https://hub.example.test";
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  resetEmailRuntime();
});

/** One campaign, one send to jane@example.com, captured by a recording transport. */
async function sentOne(opts: { providerId?: string } = {}) {
  const db = openHubDb(":memory:");
  saveEmailSettings(db, { publicBaseUrl: BASE, physicalAddress: "1 Main St" });
  const outbox: OutgoingEmail[] = [];
  configureEmailRuntime({
    transportFactory: (s) => ({
      kind: s.kind,
      supportsHtml: true,
      send: async (m) => {
        outbox.push(m);
        return { messageId: opts.providerId ?? m.messageId ?? "" };
      },
      verify: async () => ({ ok: true }),
    }),
  });
  const sender = saveSender(db, {
    kind: "smtp-custom",
    label: "x",
    host: "127.0.0.1",
    fromEmail: "s@example.test",
  });
  const tpl = saveTemplate(db, {
    name: "t",
    subject: "Hello",
    html: '<p>Hi</p><a href="https://landing.example.com/offer">Offer</a>',
  }).template;
  const contact = upsertContact(db, {
    email: "jane@example.com",
    name: "Jane",
    emailOptIn: true,
    tags: ["a"],
  })!.contact;
  const c = saveEmailCampaign(db, {
    name: "C",
    segmentFilter: { tag: "a" },
    steps: [{ templateId: tpl.id }, { templateId: tpl.id, delayMinutes: 60 }],
    sender: { senderId: sender.id },
  });
  startEmailCampaign(db, c.id, 1000);
  await runDueSends(db, {}, 1000);
  const send = db.prepare("SELECT * FROM email_sends").get() as Record<string, unknown>;
  return { db, outbox, contact, campaign: c, send, msg: outbox[0] };
}

async function serve(db: HubDb) {
  const srv = await startHttp(createBusinessHubDispatcher({ getDb: () => db }));
  closers.push(srv.close);
  return (url: string) => url.replace(BASE, srv.url);
}

const enrollment = (db: HubDb) =>
  db.prepare("SELECT status, stopped_reason FROM email_enrollments").get() as {
    status: string;
    stopped_reason: string | null;
  };

describe("unsubscribe", () => {
  it("GET shows a confirm page; RFC 8058 one-click POST suppresses and stops the sequence", async () => {
    const { db, msg, contact } = await sentOne();
    const local = await serve(db);
    const unsubUrl = /<([^>]+)>/.exec(msg.headers!["List-Unsubscribe"])![1];
    expect(String(msg.html)).toContain(`href="${unsubUrl}"`); // footer link uses the same token

    const page = await fetch(local(unsubUrl));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Unsubscribe?");
    expect(isSuppressed(db, "jane@example.com")).toBe(false); // GET alone never unsubscribes

    const post = await fetch(local(unsubUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(post.status).toBe(200);
    expect(isSuppressed(db, "jane@example.com")).toBe(true);
    expect(getContact(db, contact.id)!.emailOptIn).toBe(false);
    expect(enrollment(db)).toEqual({ status: "stopped", stopped_reason: "unsubscribed" });
    const s = db.prepare("SELECT unsubscribed_at FROM email_sends").get() as {
      unsubscribed_at: number;
    };
    expect(s.unsubscribed_at).toBeGreaterThan(0);
    expect(timeline(db, "contact", contact.id).map((a) => a.type)).toContain("email.unsubscribed");
    const r = db.prepare("SELECT reason FROM suppressions").get() as { reason: string };
    expect(r.reason).toBe("unsubscribe");

    const forged = await fetch(local(unsubUrl.replace(/.$/, (c) => (c === "A" ? "B" : "A"))), {
      method: "POST",
    });
    expect(forged.status).toBe(400);
  });
});

describe("open + click tracking", () => {
  it("records opens via the pixel and clicks via the signed redirect (no open redirect)", async () => {
    const { db, msg, contact } = await sentOne();
    const local = await serve(db);
    const html = String(msg.html);
    const pixel = /src="([^"]+\/t\/o\?t=[^"]+)"/.exec(html)![1];
    const link = /href="([^"]+\/t\/k\?t=[^"]+)"/.exec(html)![1];

    for (let i = 0; i < 2; i++) {
      const r = await fetch(local(pixel));
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/gif");
    }
    let s = db.prepare("SELECT open_count, opened_at FROM email_sends").get() as Record<
      string,
      number
    >;
    expect(s.open_count).toBe(2);
    const opens = timeline(db, "contact", contact.id).filter((a) => a.type === "email.opened");
    expect(opens).toHaveLength(1); // first open only

    const clicked: string[] = [];
    configureEmailRuntime({ hooks: { onClicked: (cid) => clicked.push(cid) } });
    // An attacker-supplied ?url= is ignored: the destination comes from the signed token only.
    const res = await fetch(`${local(link)}&url=https://evil.example.net`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe("https://landing.example.com");
    expect(loc.pathname).toBe("/offer");
    expect(loc.searchParams.get("utm_campaign")).toBe("c");
    expect(verifyToken(db, loc.searchParams.get("ib_c")!, "c")?.c).toBe(contact.id);
    s = db.prepare("SELECT click_count FROM email_sends").get() as Record<string, number>;
    expect(s.click_count).toBe(1);
    expect(clicked).toEqual([contact.id]);

    // Tampered token → 404, nothing recorded.
    const token = link.split("/t/k?t=")[1];
    const [body, sig] = token.split(".");
    const evil = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, "base64url").toString()),
        u: "https://evil.example.net",
      }),
    ).toString("base64url");
    const bad = await fetch(local(link.replace(token, `${evil}.${sig}`)), { redirect: "manual" });
    expect(bad.status).toBe(404);
    // Path-style tokens are not routed (exact-path mounting only).
    const p = await fetch(`${local(BASE)}/plugins/business-agency/t/k/${token}`, {
      redirect: "manual",
    });
    expect(p.status).toBe(404);
  });
});

describe("bounces", () => {
  const dsn = (to: string, status: string, ref: string): InboundMessage => ({
    id: `in_${randomBytes(3).toString("hex")}`,
    messageId: "<dsn@mx.example.org>",
    fromAddr: "mailer-daemon@googlemail.com",
    subject: "Delivery Status Notification (Failure)",
    text: `Address not found\n\nReporting-MTA: dns; mx.example.org\nFinal-Recipient: rfc822; ${to}\nAction: failed\nStatus: ${status}\nDiagnostic-Code: smtp; 550 ${status} The email account does not exist.\n\nMessage-ID: ${ref}\n`,
    html: null,
    headers: { "x-failed-recipients": to },
    receivedAt: 5000,
  });

  it("parses a DSN and suppresses on hard bounce; ignores addresses never emailed", async () => {
    const { db, msg, contact } = await sentOne();
    const parsed = parseDsn(dsn("jane@example.com", "5.1.1", msg.messageId!));
    expect(parsed?.recipients).toEqual([
      expect.objectContaining({ email: "jane@example.com", type: "hard", status: "5.1.1" }),
    ]);
    expect(parseDsn(dsn("x@example.com", "4.2.2", "<a@b>"))?.recipients[0].type).toBe("soft");
    expect(
      parseDsn({
        ...dsn("x@example.com", "5.1.1", "<a@b>"),
        fromAddr: "friend@example.com",
        subject: "hi",
        headers: {},
        text: "hello",
      }),
    ).toBeNull();

    const inbox = [
      dsn("jane@example.com", "5.1.1", msg.messageId!),
      dsn("stranger@example.com", "5.1.1", "<z@z>"),
    ];
    const r = pollInboundForReplies(db, {
      now: 4000,
      readInbound: (cursor) =>
        inbox.filter(
          (m) =>
            m.receivedAt > cursor.receivedAt ||
            (m.receivedAt === cursor.receivedAt && m.id > cursor.id),
        ),
    });
    expect(r).toMatchObject({ scanned: 2, bounces: 1 });
    expect(isSuppressed(db, "jane@example.com")).toBe(true);
    expect(isSuppressed(db, "stranger@example.com")).toBe(false);
    expect(getContact(db, contact.id)!.emailStatus).toBe("bounced");
    expect(enrollment(db)).toEqual({ status: "stopped", stopped_reason: "bounced" });
    // Cursor persisted: a second poll sees nothing new.
    expect(pollInboundForReplies(db, { readInbound: () => [] }).scanned).toBe(0);
  });
});

describe("provider webhooks", () => {
  it("verifies Resend (svix) signatures and applies bounces", async () => {
    const { db } = await sentOne({ providerId: "re_123" });
    const key = randomBytes(24);
    saveSender(db, {
      kind: "resend",
      label: "Resend",
      apiKey: "re_key",
      fromEmail: "s@example.test",
      webhookSigningSecret: `whsec_${key.toString("base64")}`,
    });
    const local = await serve(db);
    const url = `${local(BASE)}/plugins/business-agency/webhooks/email?provider=resend&s=${getWebhookSecret(db)}`;
    const body = JSON.stringify({
      type: "email.bounced",
      data: {
        email_id: "re_123",
        to: ["jane@example.com"],
        bounce: { type: "Permanent", message: "no mailbox" },
      },
    });
    const id = "msg_1";
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");

    const bad = await fetch(url, {
      method: "POST",
      body,
      headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": "v1,AAAA" },
    });
    expect(bad.status).toBe(401);
    expect(isSuppressed(db, "jane@example.com")).toBe(false);

    const wrongSecret = await fetch(url.replace(/s=.*$/, "s=nope"), { method: "POST", body });
    expect(wrongSecret.status).toBe(404);

    const ok = await fetch(url, {
      method: "POST",
      body,
      headers: { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ handled: 1, verified: true });
    expect(isSuppressed(db, "jane@example.com")).toBe(true);
    const s = db.prepare("SELECT bounce_type FROM email_sends").get() as { bounce_type: string };
    expect(s.bounce_type).toBe("hard");
  });

  it("handles Postmark spam complaints and SES bounces", async () => {
    const { db, contact } = await sentOne({ providerId: "pm-uuid-1" });
    const local = await serve(db);
    const base = `${local(BASE)}/plugins/business-agency/webhooks/email`;
    const secret = getWebhookSecret(db);
    const pm = await fetch(`${base}?provider=postmark&s=${secret}`, {
      method: "POST",
      body: JSON.stringify({
        RecordType: "SpamComplaint",
        Email: "jane@example.com",
        MessageID: "pm-uuid-1",
      }),
    });
    expect(pm.status).toBe(200);
    const sup = db
      .prepare("SELECT reason FROM suppressions WHERE email = ?")
      .get("jane@example.com") as {
      reason: string;
    };
    expect(sup.reason).toBe("complaint");
    expect(getContact(db, contact.id)!.emailOptIn).toBe(false);
    const s = db.prepare("SELECT complained_at FROM email_sends").get() as {
      complained_at: number;
    };
    expect(s.complained_at).toBeGreaterThan(0);

    const ses = await fetch(`${base}?provider=ses&s=${secret}`, {
      method: "POST",
      body: JSON.stringify({
        Type: "Notification",
        Message: JSON.stringify({
          notificationType: "Bounce",
          bounce: {
            bounceType: "Permanent",
            bouncedRecipients: [{ emailAddress: "jane@example.com" }],
          },
          mail: { messageId: "ses-1", headers: [{ name: "Message-ID", value: "pm-uuid-1" }] },
        }),
      }),
    });
    expect(ses.status).toBe(200);
    expect(await ses.json()).toMatchObject({ type: "Bounce", handled: 1 });
  });
});

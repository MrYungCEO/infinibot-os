import { afterEach, describe, expect, it, vi } from "vitest";
import { openHubDb, setMeta } from "./db.js";
import { getContact } from "./contacts.js";
import { getDeal } from "./pipeline.js";
import { configureEmailRuntime, resetEmailRuntime } from "./email/config.js";
import {
  autopilotApprovalOnly,
  autopilotHasDueWork,
  autopilotKpis,
  autopilotNextWakeMs,
  getAutopilotSettings,
  offerCtaUrl,
  bookingAvailability,
  bookAppointment,
  classifyReply,
  getOffer,
  listAutopilotInbox,
  listAutopilotMessages,
  pitchContext,
  recordAutopilotReply,
  runAutopilotCampaign,
  saveAutopilotCampaign,
  saveOffer,
  setAutopilotStatus,
  writePitch,
} from "./autopilot.js";
import { baseDeps, boiseSmilesSite, fixture, json, mockFetch } from "./leadgen/test-utils.js";

function offer(db: ReturnType<typeof openHubDb>) {
  return saveOffer(db, {
    name: "Booked Pipeline System",
    productSource: "manual",
    priceCents: 250_000,
    currency: "USD",
    icp: {
      industries: ["dentists"],
      geos: ["Boise, Idaho"],
      companySizes: ["2-20"],
      signals: ["online appointment traffic"],
    },
    valueProp: "Turn website demand into qualified appointments without manual follow-up.",
    proof: ["A dental team recovered 11 qualified conversations in its first month."],
    objections: [
      { objection: "budget", answer: "We start with a narrow pilot tied to booked-call value." },
    ],
    cta: { type: "book", label: "Book a 30-minute fit call" },
    playbook: {
      angle: "Lead with missed appointment demand.",
      openers: ["Noticed {{company}} is already attracting local demand."],
      tone: "concise and consultative",
      do: ["mention only verified facts", "make one clear ask"],
      dont: ["invent metrics", "sound automated"],
    },
    booking: {
      enabled: true,
      slug: "booked-pipeline",
      timezone: "America/Boise",
      durationMinutes: 30,
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 10,
      minNoticeMinutes: 0,
      horizonDays: 14,
      rules: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:45" }],
    },
  });
}

describe("Lead Autopilot", () => {
  it("persists an offer and injects its playbook into every pitch", () => {
    const db = openHubDb(":memory:");
    const saved = offer(db);
    const contactId = "ct_pitch";
    const now = Date.now();
    db.prepare(
      "INSERT INTO contacts(id,name,email,lifecycle,email_status,social,custom,created_at,updated_at) VALUES(?,?,?,'lead','valid','{}','{}',?,?)",
    ).run(contactId, "Dana Lee", "dana@example.com", now, now);
    const pitch = writePitch(db, saved.id, contactId);
    expect(getOffer(db, "booked-pipeline")?.id).toBe(saved.id);
    expect(pitch.context).toContain("Lead with missed appointment demand");
    expect(pitch.body).toContain("Turn website demand into qualified appointments");
    expect(pitch.body).toContain("Book a 30-minute fit call");
    expect(pitchContext(saved)).toContain("DON'T: invent metrics");
  });

  it("runs OSM scrape → dedupe → pipeline → personalised approval draft", async () => {
    const db = openHubDb(":memory:");
    const savedOffer = offer(db);
    const campaign = saveAutopilotCampaign(db, {
      offerId: savedOffer.id,
      name: "Boise Dental Autopilot",
      sourceQuery: "dentists",
      location: "Boise, Idaho",
      providers: ["osm"],
      audience: { minScore: 0, requireVerifiedEmail: false, allowExisting: false },
      schedule: {
        cadence: "manual",
        leadsPerRun: 3,
        timezone: "America/Boise",
        sendWindow: { start: "09:00", end: "17:00" },
      },
      sendMode: "approval",
      dailyCap: 25,
      warmupDays: 1,
    });
    setAutopilotStatus(db, campaign.id, "active");
    const net = mockFetch([
      ({ url }) =>
        url.hostname === "photon.komoot.io" ? json(JSON.parse(fixture("photon-boise.json"))) : null,
      ({ url }) =>
        url.hostname === "overpass-api.de"
          ? json(JSON.parse(fixture("overpass-dentists.json")))
          : null,
      boiseSmilesSite,
      ({ url }) =>
        url.hostname.endsWith("tvfamilydental.com")
          ? new Response("<html><body>hello@tvfamilydental.com</body></html>", {
              headers: { "content-type": "text/html" },
            })
          : null,
    ]);
    const run = await runAutopilotCampaign(db, campaign.id, {
      leadgen: baseDeps({
        fetchImpl: net.fetch,
        resolveMx: async () => [{ exchange: "mx.example.test", priority: 10 }],
      }),
    });
    expect(run.job.status).toBe("done");
    expect(run.contacts.length).toBeGreaterThan(0);
    expect(run.deals).toHaveLength(run.contacts.length);
    expect(run.messages).toHaveLength(run.contacts.length);
    const contact = getContact(db, run.contacts[0])!;
    expect(contact.custom).toMatchObject({
      offerId: savedOffer.id,
      autopilotCampaignId: campaign.id,
    });
    const message = listAutopilotMessages(db, { campaignId: campaign.id })[0] as Record<
      string,
      unknown
    >;
    expect(message.status).toBe("draft");
    expect(String(message.body)).toContain(savedOffer.valueProp);
    expect(String(message.metadata)).toContain("Lead with missed appointment demand");
    expect(autopilotKpis(db, { campaignId: campaign.id }).verified).toBe(run.contacts.length);
  });

  it("routes replies, stops the remaining sequence, books a time and attributes revenue", async () => {
    const db = openHubDb(":memory:");
    const savedOffer = offer(db);
    const campaign = saveAutopilotCampaign(db, {
      offerId: savedOffer.id,
      name: "Reply and Booking",
      sourceQuery: "dentists",
      providers: ["osm"],
    });
    const now = Date.now();
    db.prepare(
      "INSERT INTO contacts(id,name,email,lifecycle,email_status,social,custom,created_at,updated_at) VALUES(?,?,?,'lead','valid','{}',?,?,?)",
    ).run(
      "ct_reply",
      "Alex Rivera",
      "alex@example.com",
      JSON.stringify({ offerId: savedOffer.id }),
      now,
      now,
    );
    const pipeline = db.prepare("SELECT id FROM pipelines WHERE is_default=1").get() as
      | { id: string }
      | undefined;
    if (!pipeline) {
      // saveAutopilotCampaign does not need a pipeline; create one through the standard path.
      const { ensureDefaultPipeline } = await import("./pipeline.js");
      ensureDefaultPipeline(db);
    }
    const stage = db
      .prepare("SELECT id,pipeline_id FROM stages WHERE lower(name)='new' LIMIT 1")
      .get() as { id: string; pipeline_id: string };
    db.prepare(
      `INSERT INTO deals(id,title,pipeline_id,stage_id,status,value_cents,currency,contact_id,stage_entered_at,custom,created_at,updated_at)
       VALUES('dl_reply','Alex — Booked Pipeline',?,?,'open',250000,'USD','ct_reply',?,?,?,?)`,
    ).run(
      stage.pipeline_id,
      stage.id,
      now,
      JSON.stringify({ offerId: savedOffer.id, autopilotCampaignId: campaign.id }),
      now,
      now,
    );
    db.prepare(
      `INSERT INTO autopilot_messages(id,campaign_id,offer_id,contact_id,deal_id,step_index,direction,status,subject,body,metadata,due_at,sent_at,created_at,updated_at)
       VALUES('apm_reply',?,?, 'ct_reply','dl_reply',0,'outbound','sent','An idea','Hello','{}',?,?,?,?)`,
    ).run(campaign.id, savedOffer.id, now, now, now, now);
    db.prepare(
      `INSERT INTO autopilot_messages(id,campaign_id,offer_id,contact_id,deal_id,step_index,direction,status,subject,body,metadata,due_at,created_at,updated_at)
       VALUES('apm_follow',?,?, 'ct_reply','dl_reply',1,'outbound','draft','Following up','Hello again','{}',?,?,?)`,
    ).run(campaign.id, savedOffer.id, now + 86_400_000, now, now);

    expect(classifyReply("Yes, interested — can we book?").classification).toBe("interested");
    const reply = recordAutopilotReply(db, {
      contactId: "ct_reply",
      body: "Yes, interested — can we book?",
      inboundId: "in_reply_1",
      receivedAt: now,
    });
    expect(reply?.classification).toBe("interested");
    expect(listAutopilotInbox(db)[0].status).toBe("needs_approval");
    expect(
      (
        db.prepare("SELECT status FROM autopilot_messages WHERE id='apm_follow'").get() as {
          status: string;
        }
      ).status,
    ).toBe("stopped");
    expect(
      db
        .prepare(
          "SELECT name FROM stages WHERE id=(SELECT stage_id FROM deals WHERE id='dl_reply')",
        )
        .pluck()
        .get(),
    ).toBe("Qualified");

    const slot = bookingAvailability(db, savedOffer.id, { now, from: now, days: 7 })[0];
    expect(slot).toBeTruthy();
    const booking = await bookAppointment(db, {
      offerId: savedOffer.id,
      campaignId: campaign.id,
      name: "Alex Rivera",
      email: "alex@example.com",
      startsAt: slot.startsAt,
      timezone: savedOffer.booking.timezone,
    });
    expect(booking.dealId).toBe("dl_reply");
    expect(
      db
        .prepare(
          "SELECT name FROM stages WHERE id=(SELECT stage_id FROM deals WHERE id='dl_reply')",
        )
        .pluck()
        .get(),
    ).toBe("Booked");

    db.prepare(
      `INSERT INTO revenue_txns(id,account_id,provider,external_id,type,status,gross_cents,net_cents,currency,occurred_at,customer_email,contact_id,deal_id,raw,created_at,updated_at)
       VALUES('txn_reply','acct','stripe','pi_reply','charge','succeeded',250000,240000,'USD',?,'alex@example.com','ct_reply','dl_reply','{}',?,?)`,
    ).run(now, now, now);
    const kpis = autopilotKpis(db, { campaignId: campaign.id });
    expect(kpis.positive).toBe(1);
    expect(kpis.booked).toBe(1);
    expect(kpis.revenueCents).toBe(240000);
    expect(getDeal(db, "dl_reply")?.custom.offerId).toBe(savedOffer.id);
  });
});

describe("Lead Autopilot on InfiniBot Cloud", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEmailRuntime();
  });

  it("links a built-in booking CTA to the tenant Machine's own public origin", () => {
    configureEmailRuntime({ baseUrl: () => "https://infinibot-t-abc123.fly.dev" });
    const db = openHubDb(":memory:");
    const saved = offer(db);
    const read = getOffer(db, saved.id)!;
    expect(read.bookingUrl).toBe(
      "https://infinibot-t-abc123.fly.dev/plugins/business-agency/book?offer=booked-pipeline",
    );
    expect(offerCtaUrl(read)).toBe(read.bookingUrl);
    const contactId = "ct_link";
    const now = Date.now();
    db.prepare(
      "INSERT INTO contacts(id,name,email,lifecycle,email_status,social,custom,created_at,updated_at) VALUES(?,?,?,'lead','valid','{}','{}',?,?)",
    ).run(contactId, "Dana Lee", "dana@example.com", now, now);
    expect(writePitch(db, saved.id, contactId).body).toContain(
      "Book a 30-minute fit call: https://infinibot-t-abc123.fly.dev/plugins/business-agency/book?offer=booked-pipeline",
    );
    // The derived URL is never persisted with the offer.
    const raw = db.prepare("SELECT cta FROM offers WHERE id=?").pluck().get(saved.id) as string;
    expect(raw).not.toContain("fly.dev");
  });

  it("has no booking link when no public origin is known (no localhost guess)", () => {
    configureEmailRuntime({ baseUrl: () => null });
    const db = openHubDb(":memory:");
    const read = getOffer(db, offer(db).id)!;
    expect(read.bookingUrl).toBeNull();
    expect(offerCtaUrl(read)).toBeNull();
  });

  it("keeps outbound approval-first on a hosted tenant (no auto-send, no auto-replies)", () => {
    vi.stubEnv("FLEET_TENANT_ID", "tenant_cloud_1");
    expect(autopilotApprovalOnly()).toBe(true);
    const db = openHubDb(":memory:");
    expect(getAutopilotSettings(db).approvalOnly).toBe(true);
    const campaign = saveAutopilotCampaign(db, {
      offerId: offer(db).id,
      name: "Cloud autopilot",
      sourceQuery: "dentists",
      sendMode: "auto",
      liveSendEnabled: true,
    });
    expect(campaign.sendMode).toBe("approval");
  });

  it("is not approval-only on a local install", () => {
    vi.stubEnv("FLEET_TENANT_ID", "");
    vi.stubEnv("SAAS_MODE", "");
    expect(autopilotApprovalOnly()).toBe(false);
  });

  it("reports the next campaign run / approved send for wake-on-schedule", () => {
    const db = openHubDb(":memory:");
    const now = 1_800_000_000_000;
    expect(autopilotNextWakeMs(db, now)).toBeNull();
    const campaign = saveAutopilotCampaign(db, {
      offerId: offer(db).id,
      name: "Wake test",
      sourceQuery: "dentists",
      nextRunAt: now + 3_600_000,
    });
    // Draft campaigns never wake the Machine.
    expect(autopilotNextWakeMs(db, now)).toBeNull();
    setAutopilotStatus(db, campaign.id, "active", { now });
    expect(autopilotNextWakeMs(db, now)).toBe(now + 3_600_000);
    expect(autopilotHasDueWork(db, now)).toBe(false);
    expect(autopilotHasDueWork(db, now + 3_600_000)).toBe(true);
    setMeta(db, "autopilot.killSwitch", "1");
    expect(autopilotNextWakeMs(db, now)).toBeNull();
    expect(autopilotHasDueWork(db, now + 3_600_000)).toBe(false);
  });
});

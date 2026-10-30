/**
 * Business hub RPC — `hub.email.*`: templates, segments, campaigns (start /
 * pause / resume / stop / enroll / test send / metrics), senders (secrets
 * masked; test = verify the connection, sends only to an explicit address),
 * suppressions, settings and `hub.email.sendOne` (pipeline "Send email").
 */

import {
  deleteEmailCampaign,
  enrollContact,
  getEmailCampaign,
  listEmailCampaigns,
  listEnrollments,
  campaignMetrics,
  pauseEmailCampaign,
  resumeEmailCampaign,
  saveEmailCampaign,
  startEmailCampaign,
  stopEmailCampaign,
  enrollmentCounts,
  type SaveCampaignInput,
} from "../email/campaigns.js";
import {
  getEmailSettings,
  getWebhookSecret,
  saveEmailSettings,
  type EmailSettings,
} from "../email/config.js";
import { emailSchedulerTick, sendOne, testSend } from "../email/sender-loop.js";
import {
  deleteSegment,
  listSegments,
  previewSegment,
  sanitizeFilter,
  saveSegment,
} from "../email/segments.js";
import {
  listSenders,
  removeSender,
  resolveSender,
  saveSender,
  senderFromAddress,
  transportFor,
  type SenderRef,
} from "../email/senders.js";
import {
  importSuppressions,
  listSuppressions,
  suppress,
  unsuppress,
  type SuppressionReason,
} from "../email/suppression.js";
import {
  deleteTemplate,
  getTemplate,
  listTemplates,
  previewTemplate,
  saveTemplate,
} from "../email/templates.js";
import { normalizeEmail } from "../util.js";
import { defineHubHandlers, HubError, optBool, optNum, optStr, reqStr, strArr } from "./helpers.js";
import { coerceString } from "../../shared/text/coerce.js";

type P = Record<string, unknown>;

function obj(p: P, key: string): Record<string, unknown> | undefined {
  const v = p[key];
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function senderRef(p: P): SenderRef {
  const s = obj(p, "sender");
  return {
    senderId: optStr(p, "senderId") ?? (typeof s?.senderId === "string" ? s.senderId : undefined),
    kind: typeof s?.kind === "string" ? s.kind : undefined,
    accountId: typeof s?.accountId === "string" ? s.accountId : undefined,
  };
}

function campaignInput(p: P): SaveCampaignInput {
  const stepsRaw = Array.isArray(p.steps) ? p.steps : undefined;
  const steps = stepsRaw?.map((s) => {
    const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
    return { templateId: coerceString(o.templateId), delayMinutes: Number(o.delayMinutes ?? 0) };
  });
  const ref = senderRef(p);
  return {
    id: optStr(p, "id"),
    name: optStr(p, "name"),
    segmentId: p.segmentId === null ? null : optStr(p, "segmentId"),
    segmentFilter: obj(p, "segmentFilter") ? sanitizeFilter(p.segmentFilter) : undefined,
    steps,
    fromName: p.fromName === null ? null : optStr(p, "fromName"),
    fromEmail: p.fromEmail === null ? null : optStr(p, "fromEmail"),
    replyTo: p.replyTo === null ? null : optStr(p, "replyTo"),
    sender: ref.senderId || ref.kind ? ref : undefined,
    perMinute: optNum(p, "perMinute") ?? optNum(obj(p, "throttle") ?? {}, "perMinute"),
    perDay: optNum(p, "perDay") ?? optNum(obj(p, "throttle") ?? {}, "perDay"),
    stopOnReply: optBool(p, "stopOnReply"),
    trackOpens: optBool(p, "trackOpens"),
    trackClicks: optBool(p, "trackClicks"),
    requireOptIn: optBool(p, "requireOptIn"),
  };
}

const changed = (ctx: { broadcast: (e: string, p: unknown) => void }, kind: string, id?: string) =>
  ctx.broadcast("hub.email.changed", { kind, id: id ?? null });

export const emailHubHandlers = defineHubHandlers({
  // Templates
  "hub.email.templates.list": (_p, { db }) => ({ templates: listTemplates(db) }),
  "hub.email.templates.get": (p, { db }) => {
    const t = getTemplate(db, reqStr(p, "id"));
    if (!t) throw new HubError("template not found", "NOT_FOUND");
    return { template: t };
  },
  "hub.email.templates.save": (p, ctx) => {
    const r = saveTemplate(ctx.db, {
      id: optStr(p, "id"),
      name: optStr(p, "name"),
      subject: typeof p.subject === "string" ? p.subject : undefined,
      html: typeof p.html === "string" ? p.html : undefined,
      text: typeof p.text === "string" ? p.text : undefined,
    });
    changed(ctx, "template", r.template.id);
    return r;
  },
  "hub.email.templates.delete": (p, ctx) => {
    deleteTemplate(ctx.db, reqStr(p, "id"));
    changed(ctx, "template");
    return { ok: true };
  },
  "hub.email.templates.preview": (p, { db }) =>
    previewTemplate(db, {
      templateId: optStr(p, "templateId") ?? optStr(p, "id"),
      subject: typeof p.subject === "string" ? p.subject : undefined,
      html: typeof p.html === "string" ? p.html : undefined,
      text: typeof p.text === "string" ? p.text : undefined,
      contactId: optStr(p, "contactId"),
    }),

  // Segments
  "hub.email.segments.list": (_p, { db }) => ({ segments: listSegments(db) }),
  "hub.email.segments.save": (p, ctx) => {
    const s = saveSegment(ctx.db, {
      id: optStr(p, "id"),
      name: optStr(p, "name"),
      filter: p.filter,
    });
    changed(ctx, "segment", s.id);
    return { segment: s, preview: previewSegment(ctx.db, s.filter, 5) };
  },
  "hub.email.segments.delete": (p, ctx) => {
    deleteSegment(ctx.db, reqStr(p, "id"));
    changed(ctx, "segment");
    return { ok: true };
  },
  "hub.email.segments.preview": (p, { db }) => {
    const id = optStr(p, "id");
    const seg = id ? listSegments(db).find((s) => s.id === id) : null;
    if (id && !seg) throw new HubError("segment not found", "NOT_FOUND");
    return previewSegment(
      db,
      seg ? seg.filter : sanitizeFilter(p.filter),
      optNum(p, "sample") ?? 10,
    );
  },

  // Campaigns
  "hub.email.campaigns.list": (_p, { db }) => ({ campaigns: listEmailCampaigns(db) }),
  "hub.email.campaigns.get": (p, { db }) => {
    const id = reqStr(p, "id");
    const c = getEmailCampaign(db, id);
    if (!c) throw new HubError("email campaign not found", "NOT_FOUND");
    return {
      campaign: c,
      counts: enrollmentCounts(db, id),
      enrollments: listEnrollments(db, id, {
        status: optStr(p, "enrollmentStatus"),
        limit: optNum(p, "limit") ?? 100,
        offset: optNum(p, "offset") ?? 0,
      }),
    };
  },
  "hub.email.campaigns.save": (p, ctx) => {
    const c = saveEmailCampaign(ctx.db, campaignInput(p));
    changed(ctx, "campaign", c.id);
    return { campaign: c };
  },
  "hub.email.campaigns.delete": (p, ctx) => {
    deleteEmailCampaign(ctx.db, reqStr(p, "id"));
    changed(ctx, "campaign");
    return { ok: true };
  },
  "hub.email.campaigns.start": (p, ctx) => {
    const r = startEmailCampaign(ctx.db, reqStr(p, "id"));
    changed(ctx, "campaign", r.campaign.id);
    return r;
  },
  "hub.email.campaigns.pause": (p, ctx) => {
    const c = pauseEmailCampaign(ctx.db, reqStr(p, "id"));
    changed(ctx, "campaign", c.id);
    return { campaign: c };
  },
  "hub.email.campaigns.resume": (p, ctx) => {
    const c = resumeEmailCampaign(ctx.db, reqStr(p, "id"));
    changed(ctx, "campaign", c.id);
    return { campaign: c };
  },
  "hub.email.campaigns.stop": (p, ctx) => {
    const c = stopEmailCampaign(ctx.db, reqStr(p, "id"));
    changed(ctx, "campaign", c.id);
    return { campaign: c };
  },
  "hub.email.campaigns.enroll": (p, ctx) => {
    const id = reqStr(p, "id");
    const ids = strArr(p, "contactIds") ?? [reqStr(p, "contactId")];
    const results = ids.slice(0, 1000).map((contactId) => ({
      contactId,
      ...enrollContact(ctx.db, id, contactId, { restart: optBool(p, "restart") }),
    }));
    changed(ctx, "campaign", id);
    return { results, enrolled: results.filter((r) => r.enrolled).length };
  },
  "hub.email.campaigns.testSend": async (p, { db }) => {
    const to = normalizeEmail(reqStr(p, "toEmail"));
    if (!to) throw new HubError("toEmail must be a valid address");
    return testSend(db, reqStr(p, "id"), to, {
      stepIndex: optNum(p, "stepIndex"),
      contactId: optStr(p, "contactId"),
    });
  },
  "hub.email.campaigns.metrics": (p, { db }) => campaignMetrics(db, reqStr(p, "id")),
  "hub.email.campaigns.runNow": async () => (await emailSchedulerTick({})) ?? { busy: true },

  // Senders
  "hub.email.senders.list": (_p, { db }) => ({ senders: listSenders(db) }),
  "hub.email.senders.save": (p, ctx) => {
    const s = saveSender(ctx.db, p);
    changed(ctx, "sender", s.id);
    return { sender: s };
  },
  "hub.email.senders.remove": (p, ctx) => {
    removeSender(ctx.db, reqStr(p, "id"));
    changed(ctx, "sender");
    return { ok: true };
  },
  "hub.email.senders.test": async (p, { db }) => {
    const ref = senderRef({ ...p, senderId: optStr(p, "id") ?? p.senderId });
    const sender = resolveSender(db, ref);
    const transport = transportFor(sender);
    const verify = await transport.verify();
    const toRaw = optStr(p, "to");
    if (!toRaw || !verify.ok) return { verify };
    // Only ever sends to the explicit address the owner typed.
    const to = normalizeEmail(toRaw);
    if (!to) throw new HubError("to must be a valid address");
    const from = normalizeEmail(optStr(p, "fromEmail")) ?? senderFromAddress(sender);
    if (!from) throw new HubError("no From address for this sender — set fromEmail");
    try {
      const r = await transport.send({
        from: { name: sender.fromName ?? "InfiniBot", address: from },
        to,
        subject: "InfiniBot sender test",
        text: `This is a test from your "${sender.label}" sender in the InfiniBot Business hub.`,
        html: `<p>This is a test from your <b>${sender.label.replace(/[<>&"]/g, "")}</b> sender in the InfiniBot Business hub.</p>`,
      });
      return { verify, sent: { ok: true, messageId: r.messageId } };
    } catch (err) {
      return {
        verify,
        sent: { ok: false, error: err instanceof Error ? err.message : String(err) },
      };
    }
  },

  // Suppressions
  "hub.email.suppressions.list": (p, { db }) =>
    listSuppressions(db, {
      search: optStr(p, "search"),
      reason: optStr(p, "reason"),
      limit: optNum(p, "limit"),
      offset: optNum(p, "offset"),
    }),
  "hub.email.suppressions.add": (p, ctx) => {
    const emails = strArr(p, "emails") ?? [reqStr(p, "email")];
    const reason = (optStr(p, "reason") ?? "manual") as SuppressionReason;
    if (!["unsubscribe", "bounce", "complaint", "manual", "import"].includes(reason))
      throw new HubError("invalid reason");
    let added = 0;
    for (const e of emails.slice(0, 5000)) if (suppress(ctx.db, e, reason, "manual")) added++;
    changed(ctx, "suppression");
    return { added };
  },
  "hub.email.suppressions.remove": (p, ctx) => {
    const removed = unsuppress(ctx.db, reqStr(p, "email"));
    changed(ctx, "suppression");
    return { removed };
  },
  "hub.email.suppressions.import": (p, ctx) => {
    const csv = reqStr(p, "csv");
    if (csv.length > 20_000_000) throw new HubError("file too large");
    const r = importSuppressions(ctx.db, csv, "import", optStr(p, "fileName") ?? "csv");
    changed(ctx, "suppression");
    return r;
  },

  // Settings
  "hub.email.settings.get": (_p, { db }) => ({
    settings: getEmailSettings(db),
    webhookSecretSet: !!getWebhookSecret(db),
  }),
  "hub.email.settings.save": (p, ctx) => {
    const patch: Partial<EmailSettings> = {};
    if (p.publicBaseUrl !== undefined)
      patch.publicBaseUrl = (p.publicBaseUrl as string | null) ?? null;
    if (p.physicalAddress !== undefined)
      patch.physicalAddress = (p.physicalAddress as string | null) ?? null;
    if (p.companyName !== undefined) patch.companyName = (p.companyName as string | null) ?? null;
    if (p.globalPerMinute !== undefined) patch.globalPerMinute = Number(p.globalPerMinute);
    if (p.globalPerDay !== undefined) patch.globalPerDay = Number(p.globalPerDay);
    if (p.defaultSenderId !== undefined)
      patch.defaultSenderId = (p.defaultSenderId as string | null) ?? null;
    const settings = saveEmailSettings(ctx.db, patch);
    changed(ctx, "settings");
    return { settings };
  },

  // One-off send (pipeline "Send email")
  "hub.email.sendOne": async (p, ctx) => {
    const ref = senderRef(p);
    const fallback = getEmailSettings(ctx.db).defaultSenderId;
    const r = await sendOne(ctx.db, {
      contactId: reqStr(p, "contactId"),
      sender: ref.senderId || ref.kind ? ref : { senderId: fallback },
      templateId: optStr(p, "templateId"),
      subject: typeof p.subject === "string" ? p.subject : undefined,
      html: typeof p.html === "string" ? p.html : undefined,
      text: typeof p.text === "string" ? p.text : undefined,
      fromName: optStr(p, "fromName"),
      fromEmail: optStr(p, "fromEmail"),
      replyTo: optStr(p, "replyTo"),
      dealId: optStr(p, "dealId"),
      trackOpens: optBool(p, "trackOpens"),
      trackClicks: optBool(p, "trackClicks"),
      footer: optBool(p, "footer"),
      vars: obj(p, "vars"),
      actor: optStr(p, "actor") ?? "user",
    });
    changed(ctx, "send", r.sendId);
    return r;
  },
});

/** Gateway scopes for `hub.email.*` (plugin manifest `contributes.rpc[].scope`). */
export const EMAIL_METHOD_SCOPES: Record<string, "read" | "write" | "admin"> = {
  "hub.email.templates.list": "read",
  "hub.email.templates.get": "read",
  "hub.email.templates.save": "write",
  "hub.email.templates.delete": "write",
  "hub.email.templates.preview": "read",
  "hub.email.segments.list": "read",
  "hub.email.segments.save": "write",
  "hub.email.segments.delete": "write",
  "hub.email.segments.preview": "read",
  "hub.email.campaigns.list": "read",
  "hub.email.campaigns.get": "read",
  "hub.email.campaigns.save": "write",
  "hub.email.campaigns.delete": "write",
  "hub.email.campaigns.start": "write",
  "hub.email.campaigns.pause": "write",
  "hub.email.campaigns.resume": "write",
  "hub.email.campaigns.stop": "write",
  "hub.email.campaigns.enroll": "write",
  "hub.email.campaigns.testSend": "write",
  "hub.email.campaigns.metrics": "read",
  "hub.email.campaigns.runNow": "write",
  "hub.email.senders.list": "read",
  "hub.email.senders.save": "admin",
  "hub.email.senders.remove": "admin",
  "hub.email.senders.test": "write",
  "hub.email.suppressions.list": "read",
  "hub.email.suppressions.add": "write",
  "hub.email.suppressions.remove": "write",
  "hub.email.suppressions.import": "write",
  "hub.email.settings.get": "read",
  "hub.email.settings.save": "admin",
  "hub.email.sendOne": "write",
};

/** Business Hub RPCs for offers, Lead Autopilot, inbox and bookings. */

import {
  approveAutopilotMessage,
  autopilotApprovalOnly,
  autopilotKpis,
  autopilotTimeline,
  bookAppointment,
  bookingAvailability,
  getAutopilotCampaign,
  getAutopilotSettings,
  getOffer,
  handleObjection,
  listAutopilotCampaigns,
  listAutopilotInbox,
  listAutopilotMessages,
  listBookings,
  listOffers,
  productOptions,
  recordAutopilotReply,
  runAutopilotCampaign,
  saveAutopilotCampaign,
  saveOffer,
  setAutopilotKillSwitch,
  setAutopilotStatus,
  updateAutopilotReply,
  writePitch,
  type AutopilotCampaignInput,
  type AutopilotRunDeps,
  type OfferInput,
} from "../autopilot.js";
import { defineHubHandlers, HubError, optBool, optNum, optStr, reqStr } from "./helpers.js";

export const AUTOPILOT_METHOD_SCOPES: Record<string, "read" | "write" | "admin"> = {
  "hub.offers.list": "read",
  "hub.offers.get": "read",
  "hub.offers.save": "write",
  "hub.offers.catalog": "read",
  "hub.offers.testPitch": "read",
  "hub.offers.handleObjection": "read",
  "hub.autopilot.campaigns.list": "read",
  "hub.autopilot.campaigns.get": "read",
  "hub.autopilot.campaigns.save": "write",
  "hub.autopilot.campaigns.launch": "write",
  "hub.autopilot.campaigns.pause": "write",
  "hub.autopilot.campaigns.resume": "write",
  "hub.autopilot.campaigns.stop": "write",
  "hub.autopilot.campaigns.runNow": "write",
  "hub.autopilot.messages.list": "read",
  "hub.autopilot.messages.approve": "write",
  "hub.autopilot.inbox.list": "read",
  "hub.autopilot.inbox.update": "write",
  "hub.autopilot.inbox.simulate": "write",
  "hub.autopilot.kpis": "read",
  "hub.autopilot.timeline": "read",
  "hub.autopilot.settings.get": "read",
  "hub.autopilot.settings.killSwitch": "admin",
  "hub.bookings.list": "read",
  "hub.bookings.availability": "read",
  "hub.bookings.book": "write",
};

let rpcDeps: AutopilotRunDeps = {};
export function setAutopilotRpcDeps(deps: AutopilotRunDeps): void {
  rpcDeps = deps;
}

function record(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export const autopilotHubHandlers = defineHubHandlers({
  "hub.offers.list": (p, { db }) => ({
    offers: listOffers(db, optBool(p, "includeArchived") === true),
  }),
  "hub.offers.get": (p, { db }) => {
    const offer = getOffer(db, reqStr(p, "id"));
    if (!offer) throw new HubError("offer not found", "NOT_FOUND");
    return { offer };
  },
  "hub.offers.save": (p, { db, broadcast }) => {
    const offer = saveOffer(db, record(p.offer ?? p) as OfferInput);
    broadcast("hub.changed", { kind: "offer", id: offer.id });
    return { offer };
  },
  "hub.offers.catalog": (_p, { db }) => ({ products: productOptions(db) }),
  "hub.offers.testPitch": (p, { db }) =>
    writePitch(db, reqStr(p, "offerId"), reqStr(p, "contactId"), {
      step: optNum(p, "step"),
      instruction: optStr(p, "instruction"),
    }),
  "hub.offers.handleObjection": (p, { db }) =>
    handleObjection(db, reqStr(p, "offerId"), reqStr(p, "objection")),

  "hub.autopilot.campaigns.list": (_p, { db }) => ({ campaigns: listAutopilotCampaigns(db) }),
  "hub.autopilot.campaigns.get": (p, { db }) => {
    const campaign = getAutopilotCampaign(db, reqStr(p, "id"));
    if (!campaign) throw new HubError("autopilot campaign not found", "NOT_FOUND");
    return { campaign, kpis: autopilotKpis(db, { campaignId: campaign.id }) };
  },
  "hub.autopilot.campaigns.save": (p, { db, broadcast }) => {
    const input = record(p.campaign ?? p) as AutopilotCampaignInput;
    if (input.sendMode === "auto" && autopilotApprovalOnly())
      throw new HubError(
        'Auto-send is not available on InfiniBot Cloud: every outbound message waits for your approval. Save with sendMode "approval".',
      );
    const campaign = saveAutopilotCampaign(db, input);
    broadcast("hub.changed", { kind: "autopilot.campaign", id: campaign.id });
    return { campaign };
  },
  "hub.autopilot.campaigns.launch": (p, { db, broadcast }) => {
    const liveSend = optBool(p, "liveSend") === true;
    if (liveSend && optBool(p, "confirm") !== true)
      throw new HubError("live sending requires explicit confirm: true");
    const campaign = setAutopilotStatus(db, reqStr(p, "id"), "active", { liveSend });
    broadcast("hub.changed", { kind: "autopilot.launch", id: campaign.id });
    // On Cloud "live" only delivers messages the owner approved (no auto-send).
    const mode = !liveSend
      ? "draft_approval"
      : autopilotApprovalOnly() || campaign.sendMode !== "auto"
        ? "live_approved_only"
        : "live";
    return { campaign, mode };
  },
  "hub.autopilot.campaigns.pause": (p, { db }) => ({
    campaign: setAutopilotStatus(db, reqStr(p, "id"), "paused"),
  }),
  "hub.autopilot.campaigns.resume": (p, { db }) => ({
    campaign: setAutopilotStatus(db, reqStr(p, "id"), "active"),
  }),
  "hub.autopilot.campaigns.stop": (p, { db }) => ({
    campaign: setAutopilotStatus(db, reqStr(p, "id"), "stopped"),
  }),
  "hub.autopilot.campaigns.runNow": async (p, { db, broadcast }) => {
    const result = await runAutopilotCampaign(db, reqStr(p, "id"), rpcDeps);
    broadcast("hub.changed", { kind: "autopilot.run", id: p.id });
    return result;
  },
  "hub.autopilot.messages.list": (p, { db }) => ({
    messages: listAutopilotMessages(db, {
      status: optStr(p, "status"),
      campaignId: optStr(p, "campaignId"),
      limit: optNum(p, "limit"),
    }),
  }),
  "hub.autopilot.messages.approve": (p, { db, broadcast }) => {
    if (optBool(p, "sendNow") && optBool(p, "confirm") !== true)
      throw new HubError("sending now requires explicit confirm: true");
    const message = approveAutopilotMessage(db, reqStr(p, "id"), {
      subject: optStr(p, "subject"),
      body: optStr(p, "body"),
      sendNow: optBool(p, "sendNow"),
    });
    broadcast("hub.changed", { kind: "autopilot.message", id: p.id });
    return { message };
  },
  "hub.autopilot.inbox.list": (p, { db }) => ({
    replies: listAutopilotInbox(db, { status: optStr(p, "status"), limit: optNum(p, "limit") }),
  }),
  "hub.autopilot.inbox.update": (p, { db, broadcast }) => {
    const status = optStr(p, "status");
    if (status && !["needs_approval", "approved", "handled", "dismissed"].includes(status))
      throw new HubError("invalid reply status");
    const reply = updateAutopilotReply(db, reqStr(p, "id"), {
      status: status as "needs_approval" | "approved" | "handled" | "dismissed" | undefined,
      draftResponse: typeof p.draftResponse === "string" ? p.draftResponse : undefined,
    });
    broadcast("hub.changed", { kind: "autopilot.reply", id: p.id });
    return { reply };
  },
  "hub.autopilot.inbox.simulate": (p, { db, broadcast }) => {
    const reply = recordAutopilotReply(db, {
      contactId: reqStr(p, "contactId"),
      body: reqStr(p, "body"),
      subject: optStr(p, "subject"),
      inboundId: optStr(p, "inboundId") ?? `sim_${Date.now()}`,
      autoReply: optBool(p, "autoReply"),
    });
    broadcast("hub.changed", { kind: "autopilot.reply" });
    return { reply };
  },
  "hub.autopilot.kpis": (p, { db }) =>
    autopilotKpis(db, {
      offerId: optStr(p, "offerId"),
      campaignId: optStr(p, "campaignId"),
      from: optNum(p, "from"),
      to: optNum(p, "to"),
    }),
  "hub.autopilot.timeline": (p, { db }) => ({
    events: autopilotTimeline(db, reqStr(p, "campaignId"), optNum(p, "limit")),
  }),
  "hub.autopilot.settings.get": (_p, { db }) => getAutopilotSettings(db),
  "hub.autopilot.settings.killSwitch": (p, { db, broadcast }) => {
    const settings = setAutopilotKillSwitch(db, optBool(p, "on") !== false);
    broadcast("hub.changed", { kind: "autopilot.settings" });
    return settings;
  },

  "hub.bookings.list": (p, { db }) => ({
    bookings: listBookings(db, {
      offerId: optStr(p, "offerId"),
      from: optNum(p, "from"),
      to: optNum(p, "to"),
      limit: optNum(p, "limit"),
    }),
  }),
  "hub.bookings.availability": (p, { db }) => ({
    slots: bookingAvailability(db, reqStr(p, "offerId"), {
      from: optNum(p, "from"),
      days: optNum(p, "days"),
      timezone: optStr(p, "timezone"),
    }),
  }),
  "hub.bookings.book": async (p, { db, broadcast }) => {
    const booking = await bookAppointment(db, {
      offerId: reqStr(p, "offerId"),
      campaignId: optStr(p, "campaignId") ?? null,
      name: reqStr(p, "name"),
      email: reqStr(p, "email"),
      startsAt: optNum(p, "startsAt") ?? 0,
      timezone: optStr(p, "timezone"),
      notes: optStr(p, "notes") ?? null,
    });
    broadcast("hub.changed", { kind: "booking", id: booking.id });
    return { booking };
  },
});

/**
 * `business_hub` agent tool — the agent face of the Business hub. It calls
 * the exact `hub.*` handlers the UI uses (rpc/index.ts invokeHub), so agents
 * and the owner see and change the same data with the same rules.
 *
 * Anything that emails real people needs `confirm: true`, and the agent is
 * told to get the owner's go-ahead first.
 */

import { Type } from "@sinclair/typebox";
import { type AnyAgentTool, jsonResult } from "../agents/tools/common.js";

/** action → hub method. Grouped so the description stays readable. */
export const BUSINESS_HUB_ACTIONS: Record<string, string> = {
  overview: "hub.overview",
  // contacts / companies / clients
  "contacts.search": "hub.contacts.list",
  "contacts.get": "hub.contacts.get",
  "contacts.save": "hub.contacts.save",
  "contacts.note": "hub.contacts.note",
  "contacts.tag": "hub.contacts.tag",
  "contacts.merge": "hub.contacts.merge",
  "contacts.duplicates": "hub.contacts.duplicates",
  "companies.search": "hub.companies.list",
  "companies.get": "hub.companies.get",
  "clients.list": "hub.clients.list",
  "clients.get": "hub.clients.get",
  timeline: "hub.timeline",
  // pipeline
  "pipeline.get": "hub.pipeline.get",
  "pipeline.metrics": "hub.pipeline.metrics",
  "deals.list": "hub.deals.list",
  "deals.get": "hub.deals.get",
  "deals.save": "hub.deals.save",
  "deals.move": "hub.deals.move",
  "intake.lead": "hub.intake.lead",
  // first-class offers + Lead Autopilot
  "offers.list": "hub.offers.list",
  "offers.get": "hub.offers.get",
  "offers.save": "hub.offers.save",
  "offers.catalog": "hub.offers.catalog",
  "offers.write_pitch": "hub.offers.testPitch",
  "offers.handle_objection": "hub.offers.handleObjection",
  "autopilot.campaigns": "hub.autopilot.campaigns.list",
  "autopilot.campaign_get": "hub.autopilot.campaigns.get",
  "autopilot.campaign_save": "hub.autopilot.campaigns.save",
  "autopilot.launch": "hub.autopilot.campaigns.launch",
  "autopilot.pause": "hub.autopilot.campaigns.pause",
  "autopilot.resume": "hub.autopilot.campaigns.resume",
  "autopilot.stop": "hub.autopilot.campaigns.stop",
  "autopilot.run_now": "hub.autopilot.campaigns.runNow",
  "autopilot.messages": "hub.autopilot.messages.list",
  "autopilot.approve_message": "hub.autopilot.messages.approve",
  "autopilot.inbox": "hub.autopilot.inbox.list",
  "autopilot.reply_update": "hub.autopilot.inbox.update",
  "autopilot.kpis": "hub.autopilot.kpis",
  "autopilot.timeline": "hub.autopilot.timeline",
  "autopilot.settings": "hub.autopilot.settings.get",
  "bookings.list": "hub.bookings.list",
  "bookings.availability": "hub.bookings.availability",
  "bookings.book": "hub.bookings.book",
  // lead generation
  "leads.providers": "hub.leadgen.providers",
  "leads.find": "hub.leadgen.search",
  "leads.job": "hub.leadgen.job",
  "leads.import": "hub.leadgen.import",
  "leads.enrich": "hub.leadgen.enrich",
  "leads.verify_email": "hub.leadgen.verifyEmail",
  // imports
  "imports.preview": "hub.imports.preview",
  "imports.commit": "hub.imports.commit",
  "imports.undo": "hub.imports.undo",
  "imports.list": "hub.imports.list",
  // email
  "email.templates": "hub.email.templates.list",
  "email.template_save": "hub.email.templates.save",
  "email.segments": "hub.email.segments.list",
  "email.segment_save": "hub.email.segments.save",
  "email.segment_preview": "hub.email.segments.preview",
  "email.campaigns": "hub.email.campaigns.list",
  "email.campaign_get": "hub.email.campaigns.get",
  "email.campaign_save": "hub.email.campaigns.save",
  "email.campaign_start": "hub.email.campaigns.start",
  "email.campaign_pause": "hub.email.campaigns.pause",
  "email.campaign_metrics": "hub.email.campaigns.metrics",
  "email.send_one": "hub.email.sendOne",
  "email.senders": "hub.email.senders.list",
  "email.suppressions": "hub.email.suppressions.list",
  // tracking
  "tracking.sites": "hub.tracking.sites.list",
  "tracking.site_save": "hub.tracking.sites.save",
  "tracking.snippet": "hub.tracking.snippet",
  "tracking.stats": "hub.tracking.stats",
  // revenue
  "revenue.summary": "hub.revenue.summary",
  "revenue.accounts": "hub.revenue.accounts.list",
  "revenue.sync": "hub.revenue.sync",
  "revenue.ledger": "hub.revenue.ledger",
  "revenue.reconcile": "hub.revenue.reconcile",
  "revenue.subscriptions": "hub.revenue.subscriptions",
  "revenue.ar_aging": "hub.revenue.arAging",
  "revenue.project_mappings": "hub.revenue.projectMappings.list",
};

/** Actions that send email to real people. */
const NEEDS_CONFIRM = new Set(["email.campaign_start", "email.send_one"]);

const Schema = Type.Object({
  action: Type.String({ description: "One of the actions listed in the description." }),
  params: Type.Optional(
    Type.Object(
      {},
      { additionalProperties: true, description: "Parameters for the action (see description)." },
    ),
  ),
  confirm: Type.Optional(
    Type.Boolean({
      description: "Required (true) for actions that email real people, after the owner agreed.",
    }),
  ),
});

export function createBusinessHubToolImpl(): AnyAgentTool {
  return {
    name: "business_hub",
    label: "Business hub",
    description: [
      "The owner's connected business system: contacts, companies, clients, the sales pipeline (deals + stages), lead generation, list imports, email campaigns, landing-page tracking and revenue (Whop + Stripe ledger). Everything is linked by ID and shows up in the Business hub UI.",
      "Call with { action, params }. Main actions:",
      "- overview {from?,to?} — KPIs, what needs attention, setup checklist.",
      "- contacts.search {search?,lifecycle?,tag?,minScore?,hasEmail?,limit?} · contacts.get {id} (full timeline, deals, emails, payments) · contacts.save {id?, contact:{name,email,phone,title,companyName,lifecycle,tags,...}} · contacts.note {id,text} · contacts.tag {ids,add,remove} · contacts.merge {winnerId,loserId} · contacts.duplicates.",
      "- clients.list {search?} / clients.get {id} — agency clients with LTV, deals, invoices, payments, timeline.",
      "- pipeline.get · pipeline.metrics · deals.list {stageId?,status?,search?,rotting?} · deals.save {id?,title,contactId,companyId,valueCents,expectedCloseAt,nextAction,nextActionAt,stageId} · deals.move {id,stageId,patch?} (returns `needs` when the stage requires fields — ask the owner for them).",
      "- offers.list / offers.get {id} / offers.save {offer} — offer links product/plan, price, ICP, proof, objections, CTA and Pitch Playbook. offers.write_pitch {offerId,contactId,step?} and offers.handle_objection {offerId,objection} always return the active offer context with the copy.",
      "- autopilot.campaigns / autopilot.campaign_save {campaign} / autopilot.launch {id,liveSend?,confirm?} / pause / resume / stop / run_now. New campaigns default to approval mode and draft messages. liveSend:true requires confirm:true. autopilot.messages, autopilot.approve_message, autopilot.inbox, autopilot.kpis and autopilot.timeline expose the full run and attribution trail.",
      "- bookings.list / bookings.availability {offerId,from?,days?,timezone?} / bookings.book {offerId,campaignId?,name,email,startsAt,timezone}. A booking stops the sequence and moves the linked deal to Booked.",
      "- leads.find {query,location,limit?} → jobId; leads.job {jobId} (preview with scores, 'existing' flags); leads.import {jobId, resultIds|'all', tags?}. leads.enrich {contactId|companyId}, leads.verify_email {email}. Free providers: OpenStreetMap + website contact extraction + email pattern/MX checks; optional self-hosted or BYOK providers in leads.providers.",
      "- imports.preview {fileName, text | contentBase64} → mapping + validation report; imports.commit {id, mapping?, options?:{strategy:'fill'|'overwrite'|'skip', tags, createDeals}}; imports.undo {id}.",
      "- email.templates / email.template_save {name,subject,html|text with {{first_name|there}} vars} · email.segments / email.segment_save {name,filter} / email.segment_preview · email.campaigns / email.campaign_save {name,segmentId,steps:[{delayMinutes,templateId}],sender,...} · email.campaign_metrics {id} · email.campaign_start {id} and email.send_one {contactId,subject,body|templateId} REQUIRE confirm:true and the owner's explicit OK.",
      "- tracking.sites · tracking.site_save {name,origins} · tracking.snippet {siteId} (HTML to paste) · tracking.stats {siteId?,from?,to?}.",
      "- revenue.summary {from?,to?} — gross/net/fees/refunds/disputes, comparison-ready time series, source/project/product/plan/client breakdowns, recurring vs one-time, MRR/ARR/churn/LTV/cohorts, and invoice AR aging. Use an exact month range for questions like 'how much did FlyPic make this month?'. · revenue.ar_aging · revenue.project_mappings · revenue.accounts · revenue.sync {accountId?,mode:'incremental'|'backfill'} · revenue.ledger {q?,type?,from?,to?} · revenue.reconcile {accountId} · revenue.subscriptions. Revenue sync is read-only to Whop/Stripe.",
      "Money is in minor units (cents). Times are epoch ms.",
    ].join("\n"),
    parameters: Schema,
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const action = typeof args.action === "string" ? args.action.trim() : "";
      const method = BUSINESS_HUB_ACTIONS[action];
      if (!method)
        return jsonResult({
          error: `Unknown action "${action}".`,
          actions: Object.keys(BUSINESS_HUB_ACTIONS),
        });
      if (NEEDS_CONFIRM.has(action) && args.confirm !== true)
        return jsonResult({
          error:
            "This emails real people. Ask the owner first, then call again with confirm: true.",
          action,
        });
      const params =
        args.params && typeof args.params === "object"
          ? (args.params as Record<string, unknown>)
          : {};
      const needsAutopilotConfirm =
        (action === "autopilot.launch" && params.liveSend === true) ||
        (action === "autopilot.approve_message" && params.sendNow === true);
      if (needsAutopilotConfirm && args.confirm !== true)
        return jsonResult({
          error:
            "This can email real people. Ask the owner first, then call again with confirm: true.",
          action,
        });
      if (args.confirm === true) params.confirm = true;
      try {
        const { invokeHub } = await import("./rpc/index.js");
        return jsonResult({ ok: true, action, result: await invokeHub(method, params) });
      } catch (err) {
        return jsonResult({
          ok: false,
          action,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

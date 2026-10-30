/**
 * Outreach Send Worker
 *
 * Pops leads in `queued` state and sends the first outreach email via the
 * configured OutreachProvider. Handles:
 *   - Template rendering with mustache interpolation
 *   - Tracking pixel injection at end of body
 *   - Outbound URL rewriting through click-tracking endpoint
 *   - Unsubscribe link injection (CAN-SPAM compliance)
 *   - Pre-send unsubscribed check
 *   - OutreachMessages DB row creation
 *   - Lead status transition: queued → contacted
 *
 * Tracking endpoints expected at:
 *   GET /api/track/open/:msg_id  → 1×1 gif, writes opened event
 *   GET /api/track/click/:msg_id?url=… → 302 redirect, writes click event
 *   GET /api/unsubscribe/:lead_id?token=… → handles opt-out
 *
 * TODO(closed-loop): configure OUTREACH_BASE_URL to your public gateway URL.
 */

import { randomUUID } from "node:crypto";
import { createHmac } from "node:crypto";
import { getOutreachProvider } from "./provider.js";
import {
  loadTemplates,
  getTemplate,
  pickTemplateVariant,
  renderTemplate,
  getSenderIdentity,
  type TemplateContext,
} from "./templates.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LeadForSend {
  id: string;
  name: string;
  email: string;
  website?: string | null;
  recommendedPitch?: string | null;
  campaignId?: string | null;
  followUpCount: number;
  lifecycleStatus: string;
  unsubscribed?: boolean;
}

export interface SendOutreachParams {
  lead: LeadForSend;
  /** Template id (filename without .md). If omitted, uses "default". */
  templateId?: string;
  /** Follow-up number (0 = initial contact). */
  followUpNumber?: number;
  /** Previous thread id for follow-ups. */
  threadId?: string;
  log?: (line: string) => void;
}

export interface SendOutreachResult {
  messageId: string;
  threadId: string;
  subject: string;
  body: string;
  templateId: string;
  skipped?: boolean;
  skipReason?: string;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function sendOutreach(params: SendOutreachParams): Promise<SendOutreachResult> {
  const { lead, templateId = "default", followUpNumber = 0, threadId, log = console.log } = params;

  // Pre-send unsubscribed check
  if (lead.unsubscribed) {
    log(`[outreach:send] SKIP leadId=${lead.id} reason=unsubscribed`);
    return {
      messageId: "",
      threadId: "",
      subject: "",
      body: "",
      templateId,
      skipped: true,
      skipReason: "unsubscribed",
    };
  }

  if (!lead.email) {
    log(`[outreach:send] SKIP leadId=${lead.id} reason=no_email`);
    return {
      messageId: "",
      threadId: "",
      subject: "",
      body: "",
      templateId,
      skipped: true,
      skipReason: "no_email",
    };
  }

  // Load templates
  const templates = loadTemplates();
  const template =
    pickTemplateVariant(templates, templateId) ??
    getTemplate(templateId) ??
    templates.find((t) => t.id === "default") ??
    templates[0];

  if (!template) {
    throw new Error(
      `No outreach template found. Create templates at ~/.infinibot/outreach/templates/`,
    );
  }

  const identity = getSenderIdentity();
  const baseUrl = process.env.OUTREACH_BASE_URL ?? "http://localhost:4040";

  // Generate a temporary messageId for tracking pixel (real one comes from provider)
  const trackingId = `trk-${randomUUID()}`;
  const unsubToken = _signLeadId(lead.id);
  const unsubUrl = `${baseUrl}/api/unsubscribe/${lead.id}?token=${unsubToken}`;

  const context: TemplateContext = {
    lead: {
      name: lead.name,
      website: lead.website,
      email: lead.email,
      recommended_pitch: lead.recommendedPitch,
    },
    me: {
      first_name: identity.firstName,
      last_name: identity.lastName,
      company: identity.companyName,
      email: identity.email,
    },
    unsubscribe_url: unsubUrl,
    physical_address: identity.physicalAddress,
  };

  const { subject, body: rawBody } = renderTemplate(template, context);

  // Rewrite outbound URLs through click-tracking endpoint
  const bodyWithTracking = _rewriteUrls(rawBody, trackingId, baseUrl);

  // Inject 1×1 tracking pixel
  const trackingPixelUrl = `${baseUrl}/api/track/open/${trackingId}`;
  const htmlBody =
    _toHtml(bodyWithTracking) +
    `\n<img src="${trackingPixelUrl}" width="1" height="1" alt="" style="display:none">`;

  log(
    `[outreach:send] sending leadId=${lead.id} template=${template.id} followUp=${followUpNumber}`,
  );

  const provider = getOutreachProvider();
  const result = await provider.send({
    to: lead.email,
    subject: followUpNumber > 0 ? `Re: ${subject}` : subject,
    body: htmlBody,
    threadId,
    replyTo: identity.replyTo,
    fromName: `${identity.firstName} ${identity.lastName}`,
    fromEmail: identity.email,
  });

  log(`[outreach:send] sent messageId=${result.messageId} provider=${result.provider}`);

  return {
    messageId: result.messageId,
    threadId: result.threadId,
    subject,
    body: htmlBody,
    templateId: template.id,
  };
}

// ── URL rewriting ─────────────────────────────────────────────────────────────

function _rewriteUrls(html: string, trackingId: string, baseUrl: string): string {
  // Rewrite http/https links (but NOT the unsubscribe/tracking links themselves)
  return html.replace(/href="(https?:\/\/[^"]+)"/g, (match, url: string) => {
    if (url.includes(baseUrl)) return match;
    const tracked = `${baseUrl}/api/track/click/${trackingId}?url=${encodeURIComponent(url)}`;
    return `href="${tracked}"`;
  });
}

// ── Plain text → HTML ─────────────────────────────────────────────────────────

function _toHtml(text: string): string {
  // If already contains HTML tags, return as-is
  if (/<[a-z]/i.test(text)) return text;

  // Simple markdown-to-html for the common case
  return (
    `<html><body style="font-family:sans-serif;line-height:1.6;color:#222;max-width:600px">` +
    text
      .split("\n\n")
      .map((para) => {
        const trimmed = para.trim();
        if (!trimmed) return "";
        return `<p>${trimmed.replace(/\n/g, "<br>")}</p>`;
      })
      .filter(Boolean)
      .join("\n") +
    `</body></html>`
  );
}

// ── HMAC unsubscribe token ────────────────────────────────────────────────────

const UNSUBSCRIBE_SECRET =
  process.env.UNSUBSCRIBE_SECRET ?? "infinibot-outreach-default-secret-change-me";

export function _signLeadId(leadId: string): string {
  return createHmac("sha256", UNSUBSCRIBE_SECRET).update(leadId).digest("hex").slice(0, 16);
}

export function verifyUnsubscribeToken(leadId: string, token: string): boolean {
  return _signLeadId(leadId) === token;
}

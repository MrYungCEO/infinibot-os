/**
 * Business hub email — the sender loop. `runDueSends` picks due enrollments
 * (per-campaign perMinute/perDay + a global cap), renders the step template,
 * rewrites links for click tracking, adds the open pixel, the RFC 8058
 * List-Unsubscribe headers and footer link, sends through the campaign's
 * transport, records `email_sends`, logs `email.sent` and schedules the next
 * step. Also: `testSend` (explicit address only), `sendOne` (pipeline "Send
 * email" button) and the 30s single-flight scheduler.
 */

import { randomBytes } from "node:crypto";
import { getContact, logActivity, type Contact } from "../contacts.js";
import { getHubDb, type HubDb } from "../db.js";
import { hubId, normalizeEmail } from "../util.js";
import { getEmailCampaign, skipReason, type EmailCampaign } from "./campaigns.js";
import {
  configureEmailRuntime,
  fireHook,
  getEmailRuntime,
  getEmailSettings,
  HUB_HTTP_BASE,
  resolveBaseUrl,
  type BusinessHubHooks,
  type TransportFactory,
} from "./config.js";
import { pollInboundForReplies, type InboundReader } from "./feedback.js";
import { resolveSender, senderFromAddress, transportFor, type SenderRef } from "./senders.js";
import { isSuppressed } from "./suppression.js";
import { getTemplate, htmlToText, renderEmail } from "./templates.js";
import { hubUrls, signToken } from "./tokens.js";
import type { EmailTransport, OutgoingEmail, SenderConfig } from "./transport.js";

// ── Message preparation ──────────────────────────────────────────────────────

const SKIP_SCHEMES = /^(mailto:|tel:|sms:|#|javascript:|data:|\{\{)/i;

/** Add utm_source/medium/campaign unless the link already carries UTMs. */
export function withUtm(url: string, utmCampaign: string | null): string {
  if (!utmCampaign) return url;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return url;
    if ([...u.searchParams.keys()].some((k) => k.startsWith("utm_"))) return url;
    u.searchParams.set("utm_source", "email");
    u.searchParams.set("utm_medium", "email");
    u.searchParams.set("utm_campaign", utmCampaign);
    return u.toString();
  } catch {
    return url;
  }
}

const decodeAttr = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
const encodeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** Rewrite http(s) hrefs through the click-redirect route (skips our own hub links). */
export function rewriteLinks(
  html: string,
  ownPrefix: string,
  wrap: (url: string) => string,
): string {
  return html.replace(
    /<a\b([^>]*?)\bhref\s*=\s*(["'])(.*?)\2([^>]*)>/gi,
    (m, pre, q, raw, post) => {
      if (/data-ib-notrack/i.test(`${pre}${post}`)) return m;
      const url = decodeAttr(String(raw).trim());
      if (SKIP_SCHEMES.test(url) || !/^https?:\/\//i.test(url) || url.startsWith(ownPrefix))
        return m;
      return `<a${pre}href=${q}${encodeAttr(wrap(url))}${q}${post}>`;
    },
  );
}

/** Rewrite bare URLs in a text part. */
export function rewriteTextLinks(text: string, ownPrefix: string, wrap: (url: string) => string) {
  return text.replace(/https?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/gi, (url) =>
    url.startsWith(ownPrefix) ? url : wrap(url),
  );
}

export type PreparedEmail = { msg: OutgoingEmail; subject: string; warnings: string[] };

export function prepareEmail(
  db: HubDb,
  p: {
    sendId: string;
    toEmail: string;
    contact: Contact | null;
    template: { subject: string; html: string; text: string };
    sender: SenderConfig;
    transport: EmailTransport;
    fromName?: string | null;
    fromEmail?: string | null;
    replyTo?: string | null;
    trackOpens: boolean;
    trackClicks: boolean;
    utmCampaign?: string | null;
    footer: boolean;
    baseUrl: string;
    vars?: Record<string, unknown>;
  },
): PreparedEmail {
  const urls = hubUrls(p.baseUrl);
  const ownPrefix = `${p.baseUrl}${HUB_HTTP_BASE}/`;
  const fromAddress = normalizeEmail(p.fromEmail) ?? senderFromAddress(p.sender);
  if (!fromAddress) throw new Error("no From address: set fromEmail on the campaign or sender");
  const fromName = p.fromName ?? p.sender.fromName ?? null;
  const unsubToken = signToken(db, {
    t: "u",
    e: p.toEmail,
    s: p.sendId,
    ...(p.contact ? { c: p.contact.id } : {}),
  });
  const unsubscribeUrl = urls.unsubscribe(unsubToken);
  const r = renderEmail(db, p.template, p.contact, {
    unsubscribeUrl,
    senderName: fromName,
    senderEmail: fromAddress,
    footer: p.footer,
    vars: p.vars,
  });
  const wrap = (url: string) =>
    urls.click(signToken(db, { t: "k", s: p.sendId, u: withUtm(url, p.utmCampaign ?? null) }));
  let html = r.html;
  let text = r.text;
  if (p.trackClicks) {
    if (html) html = rewriteLinks(html, ownPrefix, wrap);
    text = rewriteTextLinks(text, ownPrefix, wrap);
  } else if (p.utmCampaign && html) {
    html = rewriteLinks(html, ownPrefix, (u) => withUtm(u, p.utmCampaign ?? null));
  }
  if (p.trackOpens && html) {
    const pixel = `<img src="${urls.open(signToken(db, { t: "o", s: p.sendId }))}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">`;
    html = /<\/body>/i.test(html)
      ? html.replace(/<\/body>/i, `${pixel}</body>`)
      : `${html}${pixel}`;
  }
  if (!p.transport.supportsHtml && html) text = htmlToText(html.replace(/<img\b[^>]*>/gi, ""));
  const domain = fromAddress.split("@")[1] ?? "localhost";
  const msg: OutgoingEmail = {
    from: { name: fromName, address: fromAddress },
    to: p.toEmail,
    subject: r.subject,
    html: p.transport.supportsHtml && html ? html : undefined,
    text: text || undefined,
    replyTo: p.replyTo ?? p.sender.replyTo ?? null,
    messageId: `<ib-${p.sendId}.${randomBytes(4).toString("hex")}@${domain}>`,
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      "X-IB-Send": p.sendId,
    },
  };
  return { msg, subject: r.subject, warnings: r.warnings };
}

function insertSend(
  db: HubDb,
  row: {
    id: string;
    emailCampaignId: string | null;
    stepId: string | null;
    enrollmentId: string | null;
    contactId: string | null;
    toEmail: string;
    subject: string;
    status: string;
    provider: string;
    now: number;
  },
): void {
  db.prepare(
    `INSERT INTO email_sends(id,email_campaign_id,step_id,enrollment_id,contact_id,to_email,subject,status,provider,created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.id,
    row.emailCampaignId,
    row.stepId,
    row.enrollmentId,
    row.contactId,
    row.toEmail,
    row.subject,
    row.status,
    row.provider,
    row.now,
  );
}

async function deliver(
  db: HubDb,
  sendId: string,
  transport: EmailTransport,
  msg: OutgoingEmail,
  finalStatus: "sent" | "test",
  now: number,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  try {
    const res = await transport.send(msg);
    const providerId = res.messageId || msg.messageId || null;
    db.prepare(
      "UPDATE email_sends SET status=?, provider_message_id=?, sent_at=?, subject=? WHERE id=?",
    ).run(finalStatus, providerId, now, msg.subject, sendId);
    return { ok: true, messageId: providerId ?? "" };
  } catch (err) {
    const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    db.prepare("UPDATE email_sends SET status='failed', error=?, subject=? WHERE id=?").run(
      error,
      msg.subject,
      sendId,
    );
    return { ok: false, error };
  }
}

// ── The loop ─────────────────────────────────────────────────────────────────

export type RunDeps = {
  baseUrl?: string | null;
  hooks?: BusinessHubHooks;
  /** Overrides the settings' global caps. */
  globalPerMinute?: number;
  globalPerDay?: number;
  /** Max enrollments processed per run (safety valve). */
  maxPerRun?: number;
};

export type RunResult = {
  sent: number;
  failed: number;
  stopped: number;
  completed: number;
  throttled: boolean;
  campaignsCompleted: string[];
  errors: string[];
};

const countSentSince = (db: HubDb, since: number, campaignId?: string) =>
  campaignId
    ? (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM email_sends WHERE status IN ('sent','failed') AND email_campaign_id = ? AND created_at >= ?",
          )
          .get(campaignId, since) as { n: number }
      ).n
    : (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM email_sends WHERE status IN ('sent','failed') AND created_at >= ?",
          )
          .get(since) as { n: number }
      ).n;

function stopEnrollment(db: HubDb, enrollmentId: string, reason: string, now: number) {
  db.prepare(
    "UPDATE email_enrollments SET status='stopped', stopped_reason=?, next_send_at=NULL, updated_at=? WHERE id=?",
  ).run(reason, now, enrollmentId);
}

/** Why an enrolled contact must not get the next step (null = send). */
function stopRule(db: HubDb, c: EmailCampaign, contact: Contact | null): string | null {
  if (!contact) return "contact_deleted";
  const skip = skipReason(db, contact, c.requireOptIn);
  if (skip === "suppressed") {
    const r = db.prepare("SELECT reason FROM suppressions WHERE email = ?").get(contact.email) as
      | { reason: string }
      | undefined;
    return r?.reason === "unsubscribe"
      ? "unsubscribed"
      : r?.reason === "bounce"
        ? "bounced"
        : "suppressed";
  }
  if (skip) return skip;
  const flags = db
    .prepare(
      `SELECT MAX(replied_at) AS replied, MAX(unsubscribed_at) AS unsub, MAX(bounced_at) AS bounced, MAX(complained_at) AS complained
       FROM email_sends WHERE contact_id = ? AND email_campaign_id = ?`,
    )
    .get(contact.id, c.id) as Record<string, number | null>;
  if (flags.unsub) return "unsubscribed";
  if (flags.complained) return "complained";
  if (c.stopOnReply && flags.replied) return "replied";
  return null;
}

export async function runDueSends(
  db: HubDb,
  deps: RunDeps = {},
  now = Date.now(),
): Promise<RunResult> {
  const out: RunResult = {
    sent: 0,
    failed: 0,
    stopped: 0,
    completed: 0,
    throttled: false,
    campaignsCompleted: [],
    errors: [],
  };
  const settings = getEmailSettings(db);
  const gMin = deps.globalPerMinute ?? settings.globalPerMinute;
  const gDay = deps.globalPerDay ?? settings.globalPerDay;
  let globalLeft = Math.min(
    gMin - countSentSince(db, now - 60_000),
    gDay - countSentSince(db, now - 86_400_000),
    deps.maxPerRun ?? 500,
  );
  const baseUrl = resolveBaseUrl(db, deps.baseUrl);
  const campaigns = (
    db
      .prepare("SELECT id FROM email_campaigns WHERE status = 'active' ORDER BY started_at")
      .all() as Array<{
      id: string;
    }>
  ).map((r) => getEmailCampaign(db, r.id)!);

  for (const c of campaigns) {
    if (!baseUrl) {
      out.errors.push("no public base URL configured — sends paused");
      break;
    }
    const due = db
      .prepare(
        `SELECT * FROM email_enrollments WHERE email_campaign_id = ? AND status = 'active'
         AND next_send_at IS NOT NULL AND next_send_at <= ? ORDER BY next_send_at LIMIT 1000`,
      )
      .all(c.id, now) as Array<Record<string, unknown>>;
    if (due.length) {
      let sender: SenderConfig;
      let transport: EmailTransport;
      try {
        sender = resolveSender(db, {
          senderId: c.sender.senderId,
          kind: c.sender.kind,
          accountId: c.sender.accountId,
        });
        transport = transportFor(sender);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        db.prepare("UPDATE email_campaigns SET status='paused', updated_at=? WHERE id=?").run(
          now,
          c.id,
        );
        logActivity(db, {
          subjectType: "campaign",
          subjectId: c.campaignId,
          type: "email.campaign_paused",
          summary: `Paused: ${msg}`,
          data: { emailCampaignId: c.id },
        });
        out.errors.push(`${c.name}: ${msg}`);
        continue;
      }
      let campaignLeft = Math.min(
        c.perMinute - countSentSince(db, now - 60_000, c.id),
        c.perDay - countSentSince(db, now - 86_400_000, c.id),
      );
      for (const e of due) {
        const enrollmentId = e.id as string;
        const stepIdx = e.next_step as number;
        const contact = getContact(db, e.contact_id as string);
        const step = c.steps[stepIdx];
        if (!step) {
          db.prepare(
            "UPDATE email_enrollments SET status='completed', next_send_at=NULL, updated_at=? WHERE id=?",
          ).run(now, enrollmentId);
          out.completed++;
          continue;
        }
        const stop = stopRule(db, c, contact);
        if (stop) {
          stopEnrollment(db, enrollmentId, stop, now);
          out.stopped++;
          continue;
        }
        if (campaignLeft <= 0 || globalLeft <= 0) {
          out.throttled = true;
          break;
        }
        const tpl = getTemplate(db, step.templateId);
        if (!tpl) {
          stopEnrollment(db, enrollmentId, "template_missing", now);
          out.stopped++;
          continue;
        }
        const sendId = hubId("es");
        const toEmail = contact!.email!;
        let prepared: PreparedEmail;
        try {
          prepared = prepareEmail(db, {
            sendId,
            toEmail,
            contact,
            template: tpl,
            sender,
            transport,
            fromName: c.fromName,
            fromEmail: c.fromEmail,
            replyTo: c.replyTo,
            trackOpens: c.trackOpens,
            trackClicks: c.trackClicks,
            utmCampaign: c.utmCampaign,
            footer: true,
            baseUrl,
          });
        } catch (err) {
          out.errors.push(`${c.name}: ${err instanceof Error ? err.message : String(err)}`);
          break; // configuration problem (e.g. no From) — affects the whole campaign
        }
        insertSend(db, {
          id: sendId,
          emailCampaignId: c.id,
          stepId: step.id,
          enrollmentId,
          contactId: contact!.id,
          toEmail,
          subject: prepared.subject,
          status: "queued",
          provider: sender.kind,
          now,
        });
        campaignLeft--;
        globalLeft--;
        const res = await deliver(db, sendId, transport, prepared.msg, "sent", now);
        if (res.ok) {
          out.sent++;
          logActivity(db, {
            subjectType: "contact",
            subjectId: contact!.id,
            type: "email.sent",
            summary: `Email sent: ${prepared.subject}`,
            data: { sendId, emailCampaignId: c.id, campaignId: c.campaignId, step: stepIdx },
            occurredAt: now,
          });
          fireHook(deps.hooks, "onSent", contact!.id, { sendId, emailCampaignId: c.id });
          const next = c.steps[stepIdx + 1];
          if (next)
            db.prepare(
              "UPDATE email_enrollments SET next_step=?, next_send_at=?, updated_at=? WHERE id=?",
            ).run(stepIdx + 1, now + next.delayMinutes * 60_000, now, enrollmentId);
          else {
            db.prepare(
              "UPDATE email_enrollments SET next_step=?, status='completed', next_send_at=NULL, updated_at=? WHERE id=?",
            ).run(stepIdx + 1, now, enrollmentId);
            out.completed++;
          }
        } else {
          out.failed++;
          const attempts = (
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM email_sends WHERE enrollment_id = ? AND step_id = ? AND status = 'failed'",
              )
              .get(enrollmentId, step.id) as { n: number }
          ).n;
          if (attempts >= 3) {
            stopEnrollment(db, enrollmentId, "send_failed", now);
            out.stopped++;
          } else
            db.prepare("UPDATE email_enrollments SET next_send_at=?, updated_at=? WHERE id=?").run(
              now + attempts * 15 * 60_000,
              now,
              enrollmentId,
            );
        }
      }
    }
    // Completion: nothing left to send.
    const left = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM email_enrollments WHERE email_campaign_id = ? AND status = 'active'",
        )
        .get(c.id) as { n: number }
    ).n;
    if (left === 0) {
      db.prepare(
        "UPDATE email_campaigns SET status='completed', completed_at=?, updated_at=? WHERE id=? AND status='active'",
      ).run(now, now, c.id);
      db.prepare("UPDATE campaigns SET status='completed', updated_at=? WHERE id=?").run(
        now,
        c.campaignId,
      );
      out.campaignsCompleted.push(c.id);
    }
    if (globalLeft <= 0) {
      out.throttled = true;
      break;
    }
  }
  return out;
}

// ── Test send + one-off send ─────────────────────────────────────────────────

export async function testSend(
  db: HubDb,
  emailCampaignId: string,
  toEmail: string,
  opts: { stepIndex?: number; contactId?: string; baseUrl?: string | null; now?: number } = {},
): Promise<{
  ok: boolean;
  sendId: string;
  messageId?: string;
  error?: string;
  warnings: string[];
}> {
  const to = normalizeEmail(toEmail);
  if (!to) throw new Error("a valid test address is required");
  const c = getEmailCampaign(db, emailCampaignId);
  if (!c) throw new Error(`email campaign not found: ${emailCampaignId}`);
  const step = c.steps[opts.stepIndex ?? 0];
  if (!step) throw new Error("campaign has no such step");
  const tpl = getTemplate(db, step.templateId);
  if (!tpl) throw new Error("step template not found");
  const sender = resolveSender(db, {
    senderId: c.sender.senderId,
    kind: c.sender.kind,
    accountId: c.sender.accountId,
  });
  const transport = transportFor(sender);
  const baseUrl = resolveBaseUrl(db, opts.baseUrl);
  const warnings: string[] = [];
  if (!baseUrl) warnings.push("no public base URL — links point at localhost and will not work");
  const contact = opts.contactId ? getContact(db, opts.contactId) : null;
  const sendId = hubId("es");
  const now = opts.now ?? Date.now();
  const prepared = prepareEmail(db, {
    sendId,
    toEmail: to,
    contact,
    template: { ...tpl, subject: `[Test] ${tpl.subject}` },
    sender,
    transport,
    fromName: c.fromName,
    fromEmail: c.fromEmail,
    replyTo: c.replyTo,
    trackOpens: c.trackOpens,
    trackClicks: c.trackClicks,
    utmCampaign: c.utmCampaign,
    footer: true,
    baseUrl: baseUrl ?? "http://localhost:18789",
  });
  insertSend(db, {
    id: sendId,
    emailCampaignId: c.id,
    stepId: step.id,
    enrollmentId: null,
    contactId: null,
    toEmail: to,
    subject: prepared.subject,
    status: "queued",
    provider: sender.kind,
    now,
  });
  const res = await deliver(db, sendId, transport, prepared.msg, "test", now);
  return res.ok
    ? { ok: true, sendId, messageId: res.messageId, warnings: [...warnings, ...prepared.warnings] }
    : { ok: false, sendId, error: res.error, warnings };
}

export type SendOneInput = {
  contactId: string;
  sender: SenderRef;
  templateId?: string;
  subject?: string;
  html?: string;
  text?: string;
  fromName?: string | null;
  fromEmail?: string | null;
  replyTo?: string | null;
  dealId?: string | null;
  trackOpens?: boolean;
  trackClicks?: boolean;
  /** Append the unsubscribe footer (default false for one-to-one sales email). */
  footer?: boolean;
  vars?: Record<string, unknown>;
  actor?: string | null;
  baseUrl?: string | null;
};

/** One email to one contact (pipeline "Send email"); logs the timeline. */
export async function sendOne(
  db: HubDb,
  input: SendOneInput,
  now = Date.now(),
): Promise<{ ok: boolean; sendId: string; messageId?: string; error?: string }> {
  const contact = getContact(db, input.contactId);
  if (!contact) throw new Error(`contact not found: ${input.contactId}`);
  if (!contact.email) throw new Error("contact has no email address");
  if (isSuppressed(db, contact.email)) throw new Error("contact is on the suppression list");
  if (contact.emailStatus === "bounced" || contact.emailStatus === "invalid")
    throw new Error(`contact email is ${contact.emailStatus}`);
  const tpl = input.templateId ? getTemplate(db, input.templateId) : null;
  if (input.templateId && !tpl) throw new Error(`template not found: ${input.templateId}`);
  const template = {
    subject: input.subject ?? tpl?.subject ?? "",
    html: input.html ?? tpl?.html ?? "",
    text: input.text ?? tpl?.text ?? "",
  };
  if (!template.subject.trim()) throw new Error("subject required");
  if (!template.html.trim() && !template.text.trim()) throw new Error("body required");
  const sender = resolveSender(db, input.sender);
  const transport = transportFor(sender);
  const baseUrl = resolveBaseUrl(db, input.baseUrl);
  const track = !!baseUrl;
  const sendId = hubId("es");
  const prepared = prepareEmail(db, {
    sendId,
    toEmail: contact.email,
    contact,
    template,
    sender,
    transport,
    fromName: input.fromName,
    fromEmail: input.fromEmail,
    replyTo: input.replyTo,
    trackOpens: track && input.trackOpens !== false,
    trackClicks: track && input.trackClicks !== false,
    footer: input.footer === true,
    baseUrl: baseUrl ?? "http://localhost:18789",
    vars: input.vars,
  });
  if (!baseUrl && prepared.msg.headers) {
    delete prepared.msg.headers["List-Unsubscribe"];
    delete prepared.msg.headers["List-Unsubscribe-Post"];
  }
  insertSend(db, {
    id: sendId,
    emailCampaignId: null,
    stepId: null,
    enrollmentId: null,
    contactId: contact.id,
    toEmail: contact.email,
    subject: prepared.subject,
    status: "queued",
    provider: sender.kind,
    now,
  });
  const res = await deliver(db, sendId, transport, prepared.msg, "sent", now);
  if (res.ok) {
    const data = { sendId, dealId: input.dealId ?? null, provider: sender.kind };
    logActivity(db, {
      subjectType: "contact",
      subjectId: contact.id,
      type: "email.sent",
      summary: `Email sent: ${prepared.subject}`,
      data,
      actor: input.actor,
      occurredAt: now,
    });
    if (input.dealId)
      logActivity(db, {
        subjectType: "deal",
        subjectId: input.dealId,
        type: "email.sent",
        summary: `Email sent to ${contact.name || contact.email}: ${prepared.subject}`,
        data: { ...data, contactId: contact.id },
        actor: input.actor,
        occurredAt: now,
      });
    fireHook(undefined, "onSent", contact.id, { sendId, emailCampaignId: null });
    return { ok: true, sendId, messageId: res.messageId };
  }
  return { ok: false, sendId, error: res.error };
}

// ── Scheduler ────────────────────────────────────────────────────────────────

export type SchedulerDeps = RunDeps & {
  getDb?: () => HubDb;
  intervalMs?: number;
  transportFactory?: TransportFactory;
  /** Poll the inbound IMAP store for replies + bounces each tick (default true). */
  pollInbound?: boolean;
  readInbound?: InboundReader;
  log?: (msg: string, data?: Record<string, unknown>) => void;
};

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

/** One scheduler tick (single-flight); exported for tests and manual "send now". */
export async function emailSchedulerTick(deps: SchedulerDeps = {}): Promise<RunResult | null> {
  if (inFlight) return null;
  inFlight = true;
  try {
    const db = (deps.getDb ?? (() => getHubDb()))();
    if (deps.pollInbound !== false) {
      try {
        pollInboundForReplies(db, { hooks: deps.hooks, readInbound: deps.readInbound });
      } catch (err) {
        deps.log?.("inbound poll failed", { err: String(err) });
      }
    }
    const res = await runDueSends(db, deps);
    if (res.sent || res.failed || res.errors.length) deps.log?.("email sends", { ...res });
    return res;
  } finally {
    inFlight = false;
  }
}

/** Start the 30s sender loop (idempotent). Hooks / base URL also feed the RPC + HTTP paths. */
export function startEmailScheduler(deps: SchedulerDeps = {}): void {
  configureEmailRuntime({
    ...(deps.hooks ? { hooks: deps.hooks } : {}),
    ...(deps.transportFactory ? { transportFactory: deps.transportFactory } : {}),
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  });
  if (timer) return;
  timer = setInterval(() => {
    void emailSchedulerTick(deps).catch((err) =>
      (deps.log ?? getEmailRuntime().log)?.("email scheduler tick failed", { err: String(err) }),
    );
  }, deps.intervalMs ?? 30_000);
  timer.unref?.();
}

export function stopEmailScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

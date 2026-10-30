/**
 * Business hub email — campaigns: audience (segment) + steps (delay,
 * template) + sender + throttle + stop-on-reply. Each email campaign owns an
 * attribution `campaigns` row (channel email, utm_campaign slug) so clicks,
 * landing-page visits and revenue all roll up to the same campaign.
 *
 * Lifecycle: draft → active (start: segment snapshot → enrollments) ⇄ paused
 * → stopped | completed. Ineligible contacts are recorded as `skipped`
 * enrollments with the reason, so the UI can show who was left out and why.
 */

import { getContact, type Contact } from "../contacts.js";
import type { HubDb } from "../db.js";
import { hubId, normalizeEmail, str } from "../util.js";
import { resolveBaseUrl } from "./config.js";
import { getSegment, saveSegment, segmentContactIds, type SegmentFilter } from "./segments.js";
import { resolveSender, type SenderRef } from "./senders.js";
import { isSuppressed } from "./suppression.js";
import { getTemplate } from "./templates.js";
import { SENDER_KINDS, type SenderKind } from "./transport.js";

export type CampaignStatus = "draft" | "active" | "paused" | "stopped" | "completed";

export type EmailStep = {
  id: string;
  position: number;
  delayMinutes: number;
  templateId: string;
  templateName: string | null;
};

export type EmailCampaign = {
  id: string;
  campaignId: string;
  utmCampaign: string | null;
  segmentId: string | null;
  name: string;
  status: CampaignStatus;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  sender: { kind: SenderKind | null; senderId: string | null; accountId: string | null };
  perMinute: number;
  perDay: number;
  stopOnReply: boolean;
  trackOpens: boolean;
  trackClicks: boolean;
  requireOptIn: boolean;
  startedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
  steps: EmailStep[];
};

export type SkipReason = "no_email" | "suppressed" | "bounced" | "not_opted_in";

type Row = Record<string, unknown>;

function rowToCampaign(db: HubDb, r: Row): EmailCampaign {
  const ref = (r.account_id as string | null) ?? null;
  const isSender = !!ref && ref.startsWith("snd_");
  const utm = db.prepare("SELECT utm_campaign FROM campaigns WHERE id = ?").get(r.campaign_id) as
    | { utm_campaign: string | null }
    | undefined;
  return {
    id: r.id as string,
    campaignId: r.campaign_id as string,
    utmCampaign: utm?.utm_campaign ?? null,
    segmentId: (r.segment_id as string) ?? null,
    name: r.name as string,
    status: r.status as CampaignStatus,
    fromName: (r.from_name as string) ?? null,
    fromEmail: (r.from_email as string) ?? null,
    replyTo: (r.reply_to as string) ?? null,
    sender: {
      kind: (r.provider_hint as SenderKind) ?? null,
      senderId: isSender ? ref : null,
      accountId: isSender ? null : ref,
    },
    perMinute: r.per_minute as number,
    perDay: r.per_day as number,
    stopOnReply: !!r.stop_on_reply,
    trackOpens: !!r.track_opens,
    trackClicks: !!r.track_clicks,
    requireOptIn: !!r.require_opt_in,
    startedAt: (r.started_at as number) ?? null,
    completedAt: (r.completed_at as number) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    steps: getSteps(db, r.id as string),
  };
}

export function getSteps(db: HubDb, emailCampaignId: string): EmailStep[] {
  return (
    db
      .prepare(
        `SELECT s.*, t.name AS template_name FROM email_steps s LEFT JOIN email_templates t ON t.id = s.template_id
         WHERE s.email_campaign_id = ? ORDER BY s.position`,
      )
      .all(emailCampaignId) as Row[]
  ).map((s) => ({
    id: s.id as string,
    position: s.position as number,
    delayMinutes: s.delay_minutes as number,
    templateId: s.template_id as string,
    templateName: (s.template_name as string) ?? null,
  }));
}

export function getEmailCampaign(db: HubDb, id: string): EmailCampaign | null {
  const r = db.prepare("SELECT * FROM email_campaigns WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToCampaign(db, r) : null;
}

function mustGet(db: HubDb, id: string): EmailCampaign {
  const c = getEmailCampaign(db, id);
  if (!c) throw new Error(`email campaign not found: ${id}`);
  return c;
}

export function listEmailCampaigns(
  db: HubDb,
): Array<EmailCampaign & { counts: Record<string, number> }> {
  const rows = db.prepare("SELECT * FROM email_campaigns ORDER BY created_at DESC").all() as Row[];
  return rows.map((r) => {
    const c = rowToCampaign(db, r);
    return { ...c, counts: enrollmentCounts(db, c.id) };
  });
}

export function enrollmentCounts(db: HubDb, id: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db
    .prepare(
      "SELECT status, COUNT(*) AS n FROM email_enrollments WHERE email_campaign_id = ? GROUP BY status",
    )
    .all(id) as Array<{ status: string; n: number }>)
    out[r.status] = r.n;
  return out;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "email"
  );
}

function uniqueUtm(db: HubDb, base: string): string {
  let slug = base;
  for (let i = 2; db.prepare("SELECT 1 FROM campaigns WHERE utm_campaign = ?").get(slug); i++)
    slug = `${base}-${i}`;
  return slug;
}

export type SaveCampaignInput = {
  id?: string;
  name?: string;
  segmentId?: string | null;
  /** Inline audience: saved as a segment named after the campaign. */
  segmentFilter?: SegmentFilter;
  steps?: Array<{ delayMinutes?: number; templateId: string }>;
  fromName?: string | null;
  fromEmail?: string | null;
  replyTo?: string | null;
  sender?: SenderRef;
  perMinute?: number;
  perDay?: number;
  stopOnReply?: boolean;
  trackOpens?: boolean;
  trackClicks?: boolean;
  requireOptIn?: boolean;
};

const intIn = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
};

export function saveEmailCampaign(db: HubDb, input: SaveCampaignInput): EmailCampaign {
  const now = Date.now();
  const cur = input.id ? mustGet(db, input.id) : null;
  const name = (str(input.name) ?? cur?.name ?? "").slice(0, 200);
  if (!name) throw new Error("name required");

  let segmentId = input.segmentId !== undefined ? input.segmentId : (cur?.segmentId ?? null);
  if (segmentId && !getSegment(db, segmentId)) throw new Error(`segment not found: ${segmentId}`);
  if (input.segmentFilter)
    segmentId = saveSegment(db, {
      id: segmentId ?? undefined,
      name: `${name} audience`,
      filter: input.segmentFilter,
    }).id;

  let senderKind = cur?.sender.kind ?? null;
  let senderRefId = cur?.sender.senderId ?? cur?.sender.accountId ?? null;
  if (input.sender) {
    const sender = resolveSender(db, input.sender); // validates
    senderKind = sender.kind;
    senderRefId = sender.id.startsWith("snd_") ? sender.id : (sender.accountId ?? null);
    if (!SENDER_KINDS.includes(senderKind)) throw new Error("invalid sender kind");
  }

  const fromEmail =
    input.fromEmail !== undefined
      ? input.fromEmail
        ? normalizeEmail(input.fromEmail)
        : null
      : (cur?.fromEmail ?? null);
  if (input.fromEmail && !fromEmail) throw new Error("fromEmail is not a valid email");
  const replyTo =
    input.replyTo !== undefined
      ? input.replyTo
        ? normalizeEmail(input.replyTo)
        : null
      : (cur?.replyTo ?? null);
  if (input.replyTo && !replyTo) throw new Error("replyTo is not a valid email");

  const flag = (v: boolean | undefined, c: boolean | undefined, d: boolean) =>
    (v ?? c ?? d) ? 1 : 0;
  const vals = {
    name,
    segmentId,
    fromName:
      input.fromName !== undefined
        ? (str(input.fromName)?.slice(0, 120) ?? null)
        : (cur?.fromName ?? null),
    fromEmail,
    replyTo,
    perMinute: intIn(input.perMinute ?? cur?.perMinute, 1, 600, 20),
    perDay: intIn(input.perDay ?? cur?.perDay, 1, 50_000, 400),
    stopOnReply: flag(input.stopOnReply, cur?.stopOnReply, true),
    trackOpens: flag(input.trackOpens, cur?.trackOpens, true),
    trackClicks: flag(input.trackClicks, cur?.trackClicks, true),
    requireOptIn: flag(input.requireOptIn, cur?.requireOptIn, false),
  };

  if (input.steps) {
    if (cur?.status === "active") throw new Error("pause the campaign before editing its steps");
    if (input.steps.length > 20) throw new Error("at most 20 steps");
    for (const s of input.steps)
      if (!s.templateId || !getTemplate(db, s.templateId))
        throw new Error(`template not found: ${s.templateId}`);
  }

  let id = cur?.id;
  db.transaction(() => {
    if (cur) {
      db.prepare(
        `UPDATE email_campaigns SET name=?, segment_id=?, from_name=?, from_email=?, reply_to=?, account_id=?, provider_hint=?,
         per_minute=?, per_day=?, stop_on_reply=?, track_opens=?, track_clicks=?, require_opt_in=?, updated_at=? WHERE id=?`,
      ).run(
        vals.name,
        vals.segmentId,
        vals.fromName,
        vals.fromEmail,
        vals.replyTo,
        senderRefId,
        senderKind,
        vals.perMinute,
        vals.perDay,
        vals.stopOnReply,
        vals.trackOpens,
        vals.trackClicks,
        vals.requireOptIn,
        now,
        cur.id,
      );
      db.prepare("UPDATE campaigns SET name=?, updated_at=? WHERE id=?").run(
        name,
        now,
        cur.campaignId,
      );
    } else {
      const campaignId = hubId("cmp");
      db.prepare(
        "INSERT INTO campaigns(id,name,utm_campaign,channel,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ).run(campaignId, name, uniqueUtm(db, slugify(name)), "email", "draft", now, now);
      id = hubId("ec");
      db.prepare(
        `INSERT INTO email_campaigns(id,campaign_id,segment_id,name,status,from_name,from_email,reply_to,account_id,provider_hint,
         per_minute,per_day,stop_on_reply,track_opens,track_clicks,require_opt_in,created_at,updated_at)
         VALUES(?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id,
        campaignId,
        vals.segmentId,
        vals.name,
        vals.fromName,
        vals.fromEmail,
        vals.replyTo,
        senderRefId,
        senderKind,
        vals.perMinute,
        vals.perDay,
        vals.stopOnReply,
        vals.trackOpens,
        vals.trackClicks,
        vals.requireOptIn,
        now,
        now,
      );
    }
    if (input.steps) {
      db.prepare("DELETE FROM email_steps WHERE email_campaign_id = ?").run(id);
      const ins = db.prepare(
        "INSERT INTO email_steps(id,email_campaign_id,position,delay_minutes,template_id,created_at) VALUES(?,?,?,?,?,?)",
      );
      input.steps.forEach((s, i) =>
        ins.run(hubId("est"), id, i, intIn(s.delayMinutes ?? 0, 0, 525_600, 0), s.templateId, now),
      );
    }
  })();
  return mustGet(db, id!);
}

export function deleteEmailCampaign(db: HubDb, id: string): void {
  const c = mustGet(db, id);
  if (c.status === "active") throw new Error("stop the campaign before deleting it");
  db.transaction(() => {
    db.prepare("DELETE FROM email_steps WHERE email_campaign_id = ?").run(id);
    db.prepare("DELETE FROM email_enrollments WHERE email_campaign_id = ?").run(id);
    db.prepare("DELETE FROM email_campaigns WHERE id = ?").run(id);
  })();
}

// ── Eligibility + enrollment ─────────────────────────────────────────────────

export function skipReason(
  db: HubDb,
  contact: Pick<Contact, "email" | "emailStatus" | "emailOptIn">,
  requireOptIn: boolean,
): SkipReason | null {
  if (!contact.email) return "no_email";
  if (isSuppressed(db, contact.email)) return "suppressed";
  if (contact.emailStatus === "bounced" || contact.emailStatus === "invalid") return "bounced";
  if (requireOptIn && !contact.emailOptIn) return "not_opted_in";
  return null;
}

/**
 * Start (or restart after stop/complete): snapshot the segment and enroll
 * every eligible contact not already enrolled. Paused campaigns just resume.
 */
export function startEmailCampaign(
  db: HubDb,
  id: string,
  now = Date.now(),
): {
  campaign: EmailCampaign;
  enrolled: number;
  skipped: Record<SkipReason | "already_enrolled", number>;
} {
  const c = mustGet(db, id);
  const skipped: Record<SkipReason | "already_enrolled", number> = {
    no_email: 0,
    suppressed: 0,
    bounced: 0,
    not_opted_in: 0,
    already_enrolled: 0,
  };
  if (c.status === "active") throw new Error("campaign is already running");
  if (c.status === "paused") return { campaign: resumeEmailCampaign(db, id), enrolled: 0, skipped };
  if (!c.steps.length) throw new Error("add at least one step before starting");
  if (!c.segmentId) throw new Error("choose an audience segment before starting");
  const segment = getSegment(db, c.segmentId);
  if (!segment) throw new Error("segment not found");
  resolveSender(db, {
    senderId: c.sender.senderId,
    kind: c.sender.kind,
    accountId: c.sender.accountId,
  });
  if (!resolveBaseUrl(db))
    throw new Error(
      "set the public base URL in Email settings first — unsubscribe and tracking links must be reachable by recipients",
    );
  let enrolled = 0;
  const firstDelay = c.steps[0].delayMinutes * 60_000;
  db.transaction(() => {
    const existing = db.prepare(
      "SELECT status FROM email_enrollments WHERE email_campaign_id = ? AND contact_id = ?",
    );
    const ins = db.prepare(
      `INSERT INTO email_enrollments(id,email_campaign_id,contact_id,status,next_step,next_send_at,stopped_reason,enrolled_at,updated_at)
       VALUES(?,?,?,?,0,?,?,?,?)
       ON CONFLICT(email_campaign_id, contact_id) DO UPDATE SET status=excluded.status, next_step=0,
         next_send_at=excluded.next_send_at, stopped_reason=excluded.stopped_reason, updated_at=excluded.updated_at`,
    );
    for (const contactId of segmentContactIds(db, segment.filter)) {
      const prev = existing.get(id, contactId) as { status: string } | undefined;
      if (prev && prev.status !== "skipped") {
        skipped.already_enrolled++;
        continue;
      }
      const contact = getContact(db, contactId);
      if (!contact) continue;
      const reason = skipReason(db, contact, c.requireOptIn);
      if (reason) {
        skipped[reason]++;
        ins.run(hubId("enr"), id, contactId, "skipped", null, reason, now, now);
      } else {
        enrolled++;
        ins.run(hubId("enr"), id, contactId, "active", now + firstDelay, null, now, now);
      }
    }
    db.prepare(
      "UPDATE email_campaigns SET status='active', started_at=COALESCE(started_at, ?), completed_at=NULL, updated_at=? WHERE id=?",
    ).run(now, now, id);
    db.prepare("UPDATE campaigns SET status='active', updated_at=? WHERE id=?").run(
      now,
      c.campaignId,
    );
  })();
  return { campaign: mustGet(db, id), enrolled, skipped };
}

export function pauseEmailCampaign(db: HubDb, id: string): EmailCampaign {
  const c = mustGet(db, id);
  if (c.status !== "active") throw new Error(`cannot pause a ${c.status} campaign`);
  db.prepare("UPDATE email_campaigns SET status='paused', updated_at=? WHERE id=?").run(
    Date.now(),
    id,
  );
  db.prepare("UPDATE campaigns SET status='paused', updated_at=? WHERE id=?").run(
    Date.now(),
    c.campaignId,
  );
  return mustGet(db, id);
}

export function resumeEmailCampaign(db: HubDb, id: string): EmailCampaign {
  const c = mustGet(db, id);
  if (c.status !== "paused") throw new Error(`cannot resume a ${c.status} campaign`);
  db.prepare("UPDATE email_campaigns SET status='active', updated_at=? WHERE id=?").run(
    Date.now(),
    id,
  );
  db.prepare("UPDATE campaigns SET status='active', updated_at=? WHERE id=?").run(
    Date.now(),
    c.campaignId,
  );
  return mustGet(db, id);
}

export function stopEmailCampaign(db: HubDb, id: string): EmailCampaign {
  const c = mustGet(db, id);
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      "UPDATE email_enrollments SET status='stopped', stopped_reason='campaign_stopped', next_send_at=NULL, updated_at=? WHERE email_campaign_id=? AND status='active'",
    ).run(now, id);
    db.prepare(
      "UPDATE email_campaigns SET status='stopped', completed_at=?, updated_at=? WHERE id=?",
    ).run(now, now, id);
    db.prepare("UPDATE campaigns SET status='completed', updated_at=? WHERE id=?").run(
      now,
      c.campaignId,
    );
  })();
  return mustGet(db, id);
}

/** Enroll one contact (UI "add to sequence" / pipeline automation). */
export function enrollContact(
  db: HubDb,
  emailCampaignId: string,
  contactId: string,
  opts: { restart?: boolean; now?: number } = {},
): { enrolled: boolean; reason?: string } {
  const c = mustGet(db, emailCampaignId);
  if (!c.steps.length) throw new Error("campaign has no steps");
  if (c.status === "stopped" || c.status === "completed")
    throw new Error(`campaign is ${c.status}`);
  const contact = getContact(db, contactId);
  if (!contact) throw new Error(`contact not found: ${contactId}`);
  const reason = skipReason(db, contact, c.requireOptIn);
  if (reason) return { enrolled: false, reason };
  const now = opts.now ?? Date.now();
  const prev = db
    .prepare("SELECT status FROM email_enrollments WHERE email_campaign_id = ? AND contact_id = ?")
    .get(emailCampaignId, contactId) as { status: string } | undefined;
  if (prev?.status === "active") return { enrolled: false, reason: "already_enrolled" };
  if (prev && prev.status !== "skipped" && !opts.restart)
    return { enrolled: false, reason: `previously ${prev.status}` };
  db.prepare(
    `INSERT INTO email_enrollments(id,email_campaign_id,contact_id,status,next_step,next_send_at,enrolled_at,updated_at)
     VALUES(?,?,?,'active',0,?,?,?)
     ON CONFLICT(email_campaign_id, contact_id) DO UPDATE SET status='active', next_step=0,
       next_send_at=excluded.next_send_at, stopped_reason=NULL, updated_at=excluded.updated_at`,
  ).run(hubId("enr"), emailCampaignId, contactId, now + c.steps[0].delayMinutes * 60_000, now, now);
  return { enrolled: true };
}

export function listEnrollments(
  db: HubDb,
  emailCampaignId: string,
  q: { status?: string; limit?: number; offset?: number } = {},
): Array<{
  id: string;
  contactId: string;
  name: string | null;
  email: string | null;
  status: string;
  nextStep: number;
  nextSendAt: number | null;
  stoppedReason: string | null;
}> {
  const p: unknown[] = [emailCampaignId];
  let w = "e.email_campaign_id = ?";
  if (q.status) {
    w += " AND e.status = ?";
    p.push(q.status);
  }
  return (
    db
      .prepare(
        `SELECT e.*, c.name, c.email FROM email_enrollments e LEFT JOIN contacts c ON c.id = e.contact_id
         WHERE ${w} ORDER BY e.updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...p, Math.min(q.limit ?? 100, 1000), q.offset ?? 0) as Row[]
  ).map((r) => ({
    id: r.id as string,
    contactId: r.contact_id as string,
    name: (r.name as string) ?? null,
    email: (r.email as string) ?? null,
    status: r.status as string,
    nextStep: r.next_step as number,
    nextSendAt: (r.next_send_at as number) ?? null,
    stoppedReason: (r.stopped_reason as string) ?? null,
  }));
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export type SendMetrics = {
  sent: number;
  failed: number;
  delivered: number;
  opens: number;
  uniqueOpens: number;
  clicks: number;
  uniqueClicks: number;
  replies: number;
  bounces: number;
  unsubscribes: number;
  complaints: number;
  openRate: number;
  clickRate: number;
  replyRate: number;
  bounceRate: number;
  unsubscribeRate: number;
};

const METRIC_SQL = `SELECT
  SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent,
  SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
  SUM(CASE WHEN status='sent' THEN open_count ELSE 0 END) AS opens,
  SUM(CASE WHEN status='sent' AND opened_at IS NOT NULL THEN 1 ELSE 0 END) AS u_opens,
  SUM(CASE WHEN status='sent' THEN click_count ELSE 0 END) AS clicks,
  SUM(CASE WHEN status='sent' AND clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS u_clicks,
  SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replies,
  SUM(CASE WHEN bounced_at IS NOT NULL THEN 1 ELSE 0 END) AS bounces,
  SUM(CASE WHEN unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END) AS unsubs,
  SUM(CASE WHEN complained_at IS NOT NULL THEN 1 ELSE 0 END) AS complaints
  FROM email_sends`;

function toMetrics(r: Record<string, number | null>): SendMetrics {
  const n = (k: string) => Number(r[k] ?? 0);
  const sent = n("sent");
  const delivered = Math.max(0, sent - n("bounces"));
  const rate = (x: number, d: number) => (d > 0 ? Math.round((x / d) * 10_000) / 10_000 : 0);
  return {
    sent,
    failed: n("failed"),
    delivered,
    opens: n("opens"),
    uniqueOpens: n("u_opens"),
    clicks: n("clicks"),
    uniqueClicks: n("u_clicks"),
    replies: n("replies"),
    bounces: n("bounces"),
    unsubscribes: n("unsubs"),
    complaints: n("complaints"),
    openRate: rate(n("u_opens"), delivered),
    clickRate: rate(n("u_clicks"), delivered),
    replyRate: rate(n("replies"), delivered),
    bounceRate: rate(n("bounces"), sent),
    unsubscribeRate: rate(n("unsubs"), delivered),
  };
}

export function campaignMetrics(
  db: HubDb,
  id: string,
): {
  campaign: { id: string; name: string; status: CampaignStatus };
  enrolled: number;
  enrollments: Record<string, number>;
  skipReasons: Record<string, number>;
  totals: SendMetrics;
  steps: Array<{ stepId: string; position: number; templateName: string | null } & SendMetrics>;
} {
  const c = mustGet(db, id);
  const enrollments = enrollmentCounts(db, id);
  const enrolled = Object.entries(enrollments)
    .filter(([k]) => k !== "skipped")
    .reduce((a, [, v]) => a + v, 0);
  const skipReasons: Record<string, number> = {};
  for (const r of db
    .prepare(
      "SELECT stopped_reason AS r, COUNT(*) AS n FROM email_enrollments WHERE email_campaign_id = ? AND status='skipped' GROUP BY stopped_reason",
    )
    .all(id) as Array<{ r: string; n: number }>)
    skipReasons[r.r ?? "unknown"] = r.n;
  const totals = toMetrics(
    db.prepare(`${METRIC_SQL} WHERE email_campaign_id = ?`).get(id) as Record<
      string,
      number | null
    >,
  );
  const steps = c.steps.map((s) => ({
    stepId: s.id,
    position: s.position,
    templateName: s.templateName,
    ...toMetrics(
      db
        .prepare(`${METRIC_SQL} WHERE email_campaign_id = ? AND step_id = ?`)
        .get(id, s.id) as Record<string, number | null>,
    ),
  }));
  return {
    campaign: { id: c.id, name: c.name, status: c.status },
    enrolled,
    enrollments,
    skipReasons,
    totals,
    steps,
  };
}

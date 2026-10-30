/**
 * Business hub email — the suppression list (unsubscribes, bounces,
 * complaints, manual + CSV imports) and the state changes that follow a
 * suppression: contact opt-out / email status, enrollments stopped, timeline.
 */

import { getContactByEmail, logActivity } from "../contacts.js";
import type { HubDb } from "../db.js";
import { normalizeEmail } from "../util.js";

export type SuppressionReason = "unsubscribe" | "bounce" | "complaint" | "manual" | "import";

export type Suppression = {
  email: string;
  reason: SuppressionReason;
  source: string | null;
  createdAt: number;
};

const REASONS: SuppressionReason[] = ["unsubscribe", "bounce", "complaint", "manual", "import"];

export function isSuppressed(db: HubDb, email: string | null | undefined): boolean {
  const e = normalizeEmail(email);
  if (!e) return false;
  return !!db.prepare("SELECT 1 FROM suppressions WHERE email = ?").get(e);
}

/** Add an address; a complaint overrides any earlier reason. Returns false when invalid. */
export function suppress(
  db: HubDb,
  email: string,
  reason: SuppressionReason,
  source?: string | null,
): boolean {
  const e = normalizeEmail(email);
  if (!e) return false;
  db.prepare(
    `INSERT INTO suppressions(email,reason,source,created_at) VALUES(?,?,?,?)
     ON CONFLICT(email) DO UPDATE SET reason = CASE WHEN excluded.reason = 'complaint' THEN 'complaint' ELSE suppressions.reason END`,
  ).run(e, reason, source ?? null, Date.now());
  return true;
}

export function unsuppress(db: HubDb, email: string): boolean {
  const e = normalizeEmail(email);
  if (!e) return false;
  return db.prepare("DELETE FROM suppressions WHERE email = ?").run(e).changes > 0;
}

export function listSuppressions(
  db: HubDb,
  q: { search?: string; reason?: string; limit?: number; offset?: number } = {},
): { items: Suppression[]; total: number } {
  const where: string[] = [];
  const p: unknown[] = [];
  if (q.search) {
    where.push("email LIKE ?");
    p.push(`%${q.search.toLowerCase()}%`);
  }
  if (q.reason && REASONS.includes(q.reason as SuppressionReason)) {
    where.push("reason = ?");
    p.push(q.reason);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM suppressions ${w}`).get(...p) as { n: number }
  ).n;
  const items = (
    db
      .prepare(`SELECT * FROM suppressions ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...p, Math.min(q.limit ?? 100, 1000), q.offset ?? 0) as Array<Record<string, unknown>>
  ).map((r) => ({
    email: r.email as string,
    reason: r.reason as SuppressionReason,
    source: (r.source as string) ?? null,
    createdAt: r.created_at as number,
  }));
  return { items, total };
}

/**
 * Import addresses from CSV / newline text. Takes the "email" column when a
 * header row names one, else every address-looking cell.
 */
export function importSuppressions(
  db: HubDb,
  csv: string,
  reason: SuppressionReason = "import",
  source = "csv",
): { added: number; existing: number; invalid: number } {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const split = (l: string) => l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
  let col = -1;
  if (lines.length) {
    const head = split(lines[0]).map((h) => h.toLowerCase());
    col = head.findIndex((h) => h === "email" || h === "email address" || h === "e-mail");
    if (col >= 0) lines.shift();
  }
  let added = 0;
  let existing = 0;
  let invalid = 0;
  db.transaction(() => {
    for (const line of lines.slice(0, 200_000)) {
      const cells = split(line);
      const candidates = col >= 0 ? [cells[col] ?? ""] : cells;
      const email = candidates.map((c) => normalizeEmail(c)).find((e): e is string => !!e);
      if (!email) {
        invalid++;
        continue;
      }
      if (isSuppressed(db, email)) existing++;
      else {
        suppress(db, email, reason, source);
        added++;
      }
    }
  })();
  return { added, existing, invalid };
}

/** Stop every active enrollment of a contact (optionally only one campaign). */
export function stopEnrollments(
  db: HubDb,
  contactId: string,
  reason: string,
  emailCampaignId?: string | null,
): number {
  const sql = emailCampaignId
    ? "UPDATE email_enrollments SET status='stopped', stopped_reason=?, next_send_at=NULL, updated_at=? WHERE contact_id=? AND status='active' AND email_campaign_id=?"
    : "UPDATE email_enrollments SET status='stopped', stopped_reason=?, next_send_at=NULL, updated_at=? WHERE contact_id=? AND status='active'";
  const args: unknown[] = [reason, Date.now(), contactId];
  if (emailCampaignId) args.push(emailCampaignId);
  return db.prepare(sql).run(...args).changes;
}

/**
 * Unsubscribe: suppression (reason unsubscribe), contact opt-out, every
 * enrollment stopped, send stamped, timeline entry. Idempotent.
 */
export function applyUnsubscribe(
  db: HubDb,
  input: { email: string; sendId?: string | null; contactId?: string | null; source?: string },
): { email: string; contactId: string | null; already: boolean } {
  const email = normalizeEmail(input.email);
  if (!email) throw new Error("invalid email");
  const already = isSuppressed(db, email);
  const now = Date.now();
  let contactId = input.contactId ?? null;
  db.transaction(() => {
    suppress(db, email, "unsubscribe", input.source ?? "link");
    const contact = getContactByEmail(db, email);
    if (contact) contactId = contact.id;
    if (contactId) {
      db.prepare(
        "UPDATE contacts SET email_opt_in = 0, consent_at = NULL, consent_source = NULL, updated_at = ? WHERE id = ?",
      ).run(now, contactId);
      stopEnrollments(db, contactId, "unsubscribed");
    }
    if (input.sendId)
      db.prepare(
        "UPDATE email_sends SET unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE id = ?",
      ).run(now, input.sendId);
    if (contactId && !already)
      logActivity(db, {
        subjectType: "contact",
        subjectId: contactId,
        type: "email.unsubscribed",
        summary: `Unsubscribed (${input.source ?? "link"})`,
        data: { email, sendId: input.sendId ?? null },
      });
  })();
  return { email, contactId, already };
}

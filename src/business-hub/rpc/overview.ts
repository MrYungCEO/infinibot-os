/**
 * Business hub — the Overview payload: revenue, pipeline, campaign and
 * landing-page KPIs for a period (with the previous period for deltas), the
 * daily series behind the charts, what needs attention, and a setup checklist
 * so an empty hub always points at the next useful action.
 */

import type { HubDb } from "../db.js";
import { getMeta } from "../db.js";
import { pipelineMetrics } from "../pipeline.js";
import { revenueSummary } from "../revenue/metrics.js";
import { defineHubHandlers, optNum } from "./helpers.js";

const DAY = 86_400_000;

function count(db: HubDb, sql: string, ...p: unknown[]): number {
  return Number((db.prepare(sql).get(...p) as { n: number | null } | undefined)?.n ?? 0);
}

function dailySeries(
  db: HubDb,
  sql: string,
  from: number,
  to: number,
  ...p: unknown[]
): Array<{ day: string; value: number }> {
  const rows = db.prepare(sql).all(from, to, ...p) as Array<{ day: string; value: number }>;
  const map = new Map(rows.map((r) => [r.day, Number(r.value)]));
  const out: Array<{ day: string; value: number }> = [];
  for (let t = from; t < to; t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push({ day, value: map.get(day) ?? 0 });
  }
  return out;
}

const DAY_EXPR = "strftime('%Y-%m-%d', occurred_at / 1000, 'unixepoch')";

export function overview(db: HubDb, range: { from?: number; to?: number } = {}) {
  const to = range.to ?? Date.now();
  const from = range.from ?? to - 30 * DAY;
  const span = to - from;
  const prevFrom = from - span;

  const contacts = {
    total: count(db, "SELECT COUNT(*) AS n FROM contacts"),
    leads: count(db, "SELECT COUNT(*) AS n FROM contacts WHERE lifecycle IN ('lead','qualified')"),
    customers: count(db, "SELECT COUNT(*) AS n FROM contacts WHERE lifecycle = 'customer'"),
    newInPeriod: count(
      db,
      "SELECT COUNT(*) AS n FROM contacts WHERE created_at >= ? AND created_at < ?",
      from,
      to,
    ),
    newPrev: count(
      db,
      "SELECT COUNT(*) AS n FROM contacts WHERE created_at >= ? AND created_at < ?",
      prevFrom,
      from,
    ),
    companies: count(db, "SELECT COUNT(*) AS n FROM companies"),
  };

  const pipeline = pipelineMetrics(db);
  const wonInPeriod = db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(value_cents),0) AS v FROM deals WHERE status='won' AND won_at >= ? AND won_at < ?",
    )
    .get(from, to) as { n: number; v: number };
  const wonPrev = db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(value_cents),0) AS v FROM deals WHERE status='won' AND won_at >= ? AND won_at < ?",
    )
    .get(prevFrom, from) as { n: number; v: number };

  const email = {
    sent: count(
      db,
      "SELECT COUNT(*) AS n FROM email_sends WHERE sent_at >= ? AND sent_at < ?",
      from,
      to,
    ),
    opened: count(
      db,
      "SELECT COUNT(*) AS n FROM email_sends WHERE sent_at >= ? AND sent_at < ? AND opened_at IS NOT NULL",
      from,
      to,
    ),
    clicked: count(
      db,
      "SELECT COUNT(*) AS n FROM email_sends WHERE sent_at >= ? AND sent_at < ? AND clicked_at IS NOT NULL",
      from,
      to,
    ),
    replied: count(
      db,
      "SELECT COUNT(*) AS n FROM email_sends WHERE sent_at >= ? AND sent_at < ? AND replied_at IS NOT NULL",
      from,
      to,
    ),
    bounced: count(
      db,
      "SELECT COUNT(*) AS n FROM email_sends WHERE sent_at >= ? AND sent_at < ? AND bounced_at IS NOT NULL",
      from,
      to,
    ),
    unsubscribed: count(
      db,
      "SELECT COUNT(*) AS n FROM email_sends WHERE unsubscribed_at >= ? AND unsubscribed_at < ?",
      from,
      to,
    ),
    activeCampaigns: count(
      db,
      "SELECT COUNT(*) AS n FROM email_campaigns WHERE status IN ('active','running')",
    ),
    sentPrev: count(
      db,
      "SELECT COUNT(*) AS n FROM email_sends WHERE sent_at >= ? AND sent_at < ?",
      prevFrom,
      from,
    ),
  };

  const tracking = {
    pageViews: count(
      db,
      "SELECT COUNT(*) AS n FROM track_events WHERE type='page_view' AND occurred_at >= ? AND occurred_at < ?",
      from,
      to,
    ),
    visitors: count(
      db,
      "SELECT COUNT(DISTINCT visitor_id) AS n FROM track_events WHERE occurred_at >= ? AND occurred_at < ?",
      from,
      to,
    ),
    submits: count(
      db,
      "SELECT COUNT(*) AS n FROM track_events WHERE type='form_submit' AND occurred_at >= ? AND occurred_at < ?",
      from,
      to,
    ),
    pageViewsPrev: count(
      db,
      "SELECT COUNT(*) AS n FROM track_events WHERE type='page_view' AND occurred_at >= ? AND occurred_at < ?",
      prevFrom,
      from,
    ),
    sites: count(db, "SELECT COUNT(*) AS n FROM sites"),
  };

  let revenue: ReturnType<typeof revenueSummary> | null = null;
  let revenuePrev: ReturnType<typeof revenueSummary> | null = null;
  try {
    revenue = revenueSummary(db, { from, to });
    revenuePrev = revenueSummary(db, { from: prevFrom, to: from });
  } catch {
    revenue = null;
  }

  const series = {
    leads: dailySeries(
      db,
      "SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS value FROM contacts WHERE created_at >= ? AND created_at < ? GROUP BY day",
      from,
      to,
    ),
    revenue: dailySeries(
      db,
      `SELECT ${DAY_EXPR} AS day, SUM(COALESCE(amount_usd_cents, net_cents)) AS value FROM revenue_txns WHERE occurred_at >= ? AND occurred_at < ? AND type='charge' AND status IN ('succeeded','partially_refunded') GROUP BY day`,
      from,
      to,
    ),
    pageViews: dailySeries(
      db,
      `SELECT ${DAY_EXPR} AS day, COUNT(*) AS value FROM track_events WHERE occurred_at >= ? AND occurred_at < ? AND type='page_view' GROUP BY day`,
      from,
      to,
    ),
    emails: dailySeries(
      db,
      "SELECT strftime('%Y-%m-%d', sent_at / 1000, 'unixepoch') AS day, COUNT(*) AS value FROM email_sends WHERE sent_at >= ? AND sent_at < ? GROUP BY day",
      from,
      to,
    ),
  };

  const attention = {
    dueActions: db
      .prepare(
        `SELECT d.id, d.title, d.next_action AS nextAction, d.next_action_at AS nextActionAt, d.value_cents AS valueCents, st.name AS stage
         FROM deals d JOIN stages st ON st.id = d.stage_id WHERE d.status='open' AND d.next_action_at IS NOT NULL AND d.next_action_at <= ?
         ORDER BY d.next_action_at LIMIT 8`,
      )
      .all(to + DAY),
    rotting: pipeline.stages.reduce((a, s) => a + s.rotting, 0),
    hotLeads: db
      .prepare(
        "SELECT id, name, email, score, lifecycle FROM contacts WHERE lifecycle IN ('lead','qualified') ORDER BY score DESC, last_activity_at DESC LIMIT 6",
      )
      .all(),
  };

  const bookings = {
    upcoming: count(
      db,
      "SELECT COUNT(*) AS n FROM bookings WHERE status='booked' AND starts_at >= ?",
      Date.now(),
    ),
    next: db
      .prepare(
        `SELECT b.id,b.starts_at AS startsAt,b.name,b.email,b.deal_id AS dealId,o.name AS offerName
         FROM bookings b JOIN offers o ON o.id=b.offer_id
         WHERE b.status='booked' AND b.starts_at >= ? ORDER BY b.starts_at LIMIT 5`,
      )
      .all(Date.now()),
  };

  const recent = db
    .prepare(
      `SELECT a.id, a.subject_type AS subjectType, a.subject_id AS subjectId, a.type, a.summary, a.occurred_at AS occurredAt,
              COALESCE(c.name, d.title, co.name) AS subjectName
       FROM activities a LEFT JOIN contacts c ON a.subject_type='contact' AND c.id = a.subject_id
       LEFT JOIN deals d ON a.subject_type='deal' AND d.id = a.subject_id
       LEFT JOIN companies co ON a.subject_type='company' AND co.id = a.subject_id
       WHERE a.type NOT IN ('updated') ORDER BY a.occurred_at DESC LIMIT 14`,
    )
    .all();

  const setup = [
    {
      id: "revenue",
      label: "Connect Whop or Stripe",
      done: count(db, "SELECT COUNT(*) AS n FROM revenue_accounts WHERE provider <> 'legacy'") > 0,
      section: "revenue",
    },
    {
      id: "contacts",
      label: "Import your customer list",
      done: contacts.total > 0,
      section: "imports",
    },
    {
      id: "leads",
      label: "Find your first leads",
      done: count(db, "SELECT COUNT(*) AS n FROM leadgen_jobs") > 0,
      section: "leads",
    },
    {
      id: "tracking",
      label: "Track a landing page",
      done: tracking.sites > 0,
      section: "tracking",
    },
    {
      id: "email",
      label: "Connect a sender + start a campaign",
      done: count(db, "SELECT COUNT(*) AS n FROM email_campaigns") > 0,
      section: "campaigns",
    },
  ];

  return {
    range: { from, to, prevFrom },
    contacts,
    pipeline: {
      open: pipeline.open,
      won: pipeline.won,
      lost: pipeline.lost,
      winRate: pipeline.winRate,
      avgCycleDays: pipeline.avgCycleDays,
      stages: pipeline.stages,
      wonInPeriod,
      wonPrev,
      bySource: pipeline.bySource.slice(0, 6),
    },
    email,
    tracking,
    revenue,
    revenuePrev,
    series,
    attention,
    bookings,
    recent,
    setup,
    migration: getMeta(db, "migration.v1") ? JSON.parse(getMeta(db, "migration.v1")!) : null,
  };
}

export const overviewHubHandlers = defineHubHandlers({
  "hub.overview": (p, { db }) => overview(db, { from: optNum(p, "from"), to: optNum(p, "to") }),
});

export const OVERVIEW_METHOD_SCOPES: Record<string, "read" | "write" | "admin"> = {
  "hub.overview": "read",
};

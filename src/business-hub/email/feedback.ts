/**
 * Business hub email — everything that flows back after a send: opens and
 * clicks (signed tokens, identity-stitching `ib_c` on the destination URL,
 * no open redirect), bounces and complaints (inbound DSNs from the IMAP
 * store, Resend / Postmark / SES webhooks) and reply detection
 * (In-Reply-To / References → provider message id, else the sender address
 * of an enrolled contact inside the campaign window).
 */

import Database from "better-sqlite3";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigDir } from "../../utils.js";
import { getContactByEmail, logActivity } from "../contacts.js";
import { getMeta, setMeta, type HubDb } from "../db.js";
import { normalizeEmail, parseJson } from "../util.js";
import { fireHook, getEmailRuntime, getWebhookSecret, type BusinessHubHooks } from "./config.js";
import { sendersOfKind } from "./senders.js";
import { stopEnrollments, suppress } from "./suppression.js";
import { contactToken, verifyToken } from "./tokens.js";

type SendRow = {
  id: string;
  email_campaign_id: string | null;
  contact_id: string | null;
  to_email: string;
  status: string;
  opened_at: number | null;
  clicked_at: number | null;
  replied_at: number | null;
  bounced_at: number | null;
  bounce_type: string | null;
  complained_at: number | null;
  sent_at: number | null;
};

function getSend(db: HubDb, id: string): SendRow | null {
  return (
    (db.prepare("SELECT * FROM email_sends WHERE id = ?").get(id) as SendRow | undefined) ?? null
  );
}

// ── Opens + clicks ───────────────────────────────────────────────────────────

export function recordOpen(db: HubDb, sendId: string, now = Date.now()): boolean {
  const s = getSend(db, sendId);
  if (!s || (s.status !== "sent" && s.status !== "test")) return false;
  db.prepare(
    "UPDATE email_sends SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ?) WHERE id = ?",
  ).run(now, sendId);
  if (!s.opened_at && s.contact_id)
    logActivity(db, {
      subjectType: "contact",
      subjectId: s.contact_id,
      type: "email.opened",
      summary: "Opened an email",
      data: { sendId, emailCampaignId: s.email_campaign_id },
      occurredAt: now,
    });
  return true;
}

export function recordClick(
  db: HubDb,
  sendId: string,
  url: string,
  now = Date.now(),
  hooks?: BusinessHubHooks,
): boolean {
  const s = getSend(db, sendId);
  if (!s || (s.status !== "sent" && s.status !== "test")) return false;
  db.prepare(
    `UPDATE email_sends SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, ?),
     open_count = CASE WHEN open_count = 0 THEN 1 ELSE open_count END, opened_at = COALESCE(opened_at, ?) WHERE id = ?`,
  ).run(now, now, sendId);
  if (s.contact_id) {
    logActivity(db, {
      subjectType: "contact",
      subjectId: s.contact_id,
      type: "email.clicked",
      summary: `Clicked ${shortUrl(url)}`,
      data: { sendId, emailCampaignId: s.email_campaign_id, url },
      occurredAt: now,
    });
    fireHook(hooks, "onClicked", s.contact_id, {
      sendId,
      emailCampaignId: s.email_campaign_id,
      url,
    });
  }
  return true;
}

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.hostname}${x.pathname === "/" ? "" : x.pathname}`.slice(0, 120);
  } catch {
    return u.slice(0, 120);
  }
}

/** Open pixel token → record (invalid tokens are ignored; the GIF is served either way). */
export function handleOpenToken(db: HubDb, token: string, now = Date.now()): boolean {
  const t = verifyToken(db, token, "o", now);
  return t ? recordOpen(db, t.s, now) : false;
}

/**
 * Click token → the destination embedded in the signed token (never a query
 * parameter, so there is no open redirect), plus `ib_c=<contact token>` for
 * landing-page identity stitching. Null when the token is invalid.
 */
export function handleClickToken(
  db: HubDb,
  token: string,
  now = Date.now(),
  hooks?: BusinessHubHooks,
): { location: string } | null {
  const t = verifyToken(db, token, "k", now);
  if (!t) return null;
  let dest: URL;
  try {
    dest = new URL(t.u);
  } catch {
    return null;
  }
  if (dest.protocol !== "https:" && dest.protocol !== "http:") return null;
  recordClick(db, t.s, t.u, now, hooks);
  const s = getSend(db, t.s);
  if (s?.contact_id) dest.searchParams.set("ib_c", contactToken(db, s.contact_id, now));
  return { location: dest.toString() };
}

// ── Bounces + complaints ─────────────────────────────────────────────────────

export type BounceInput = {
  email: string;
  type: "hard" | "soft";
  sendId?: string | null;
  providerMessageId?: string | null;
  reason?: string | null;
  source: string;
};

/** Find the send a bounce / complaint / reply refers to. */
export function findSend(
  db: HubDb,
  q: { sendId?: string | null; providerMessageId?: string | null; email?: string | null },
): SendRow | null {
  if (q.sendId) {
    const s = getSend(db, q.sendId);
    if (s) return s;
  }
  if (q.providerMessageId) {
    const ids = messageIdVariants(q.providerMessageId);
    const s = db
      .prepare(
        `SELECT * FROM email_sends WHERE provider_message_id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 1`,
      )
      .get(...ids) as SendRow | undefined;
    if (s) return s;
    const embedded = /ib-(es_[A-Za-z0-9_-]+)\./.exec(q.providerMessageId)?.[1];
    if (embedded) {
      const e = getSend(db, embedded);
      if (e) return e;
    }
  }
  const email = normalizeEmail(q.email);
  if (email)
    return (
      (db
        .prepare(
          "SELECT * FROM email_sends WHERE to_email = ? AND status IN ('sent','test') ORDER BY sent_at DESC LIMIT 1",
        )
        .get(email) as SendRow | undefined) ?? null
    );
  return null;
}

function messageIdVariants(raw: string): string[] {
  const bare = raw.trim().replace(/^<|>$/g, "");
  const local = bare.split("@")[0];
  return [...new Set([raw.trim(), bare, `<${bare}>`, local].filter(Boolean))];
}

export function applyBounce(
  db: HubDb,
  input: BounceInput,
  now = Date.now(),
): { applied: boolean; suppressed: boolean; sendId: string | null } {
  const email = normalizeEmail(input.email);
  if (!email) return { applied: false, suppressed: false, sendId: null };
  const send = findSend(db, {
    sendId: input.sendId,
    providerMessageId: input.providerMessageId,
    email,
  });
  // Only act on addresses we actually emailed — a DSN must not suppress strangers.
  if (!send || send.to_email !== email) return { applied: false, suppressed: false, sendId: null };
  if (send.bounced_at && (send.bounce_type === input.type || send.bounce_type === "hard"))
    return { applied: false, suppressed: false, sendId: send.id };
  let suppressed = false;
  db.transaction(() => {
    db.prepare(
      "UPDATE email_sends SET bounced_at = COALESCE(bounced_at, ?), bounce_type = ? WHERE id = ?",
    ).run(now, input.type, send.id);
    const soft = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM email_sends WHERE to_email = ? AND bounce_type = 'soft'",
        )
        .get(email) as { n: number }
    ).n;
    if (input.type === "hard" || soft >= 3) {
      suppress(db, email, "bounce", input.source);
      suppressed = true;
      db.prepare(
        "UPDATE contacts SET email_status = 'bounced', updated_at = ? WHERE email = ?",
      ).run(now, email);
    }
    const contactId = send.contact_id ?? getContactByEmail(db, email)?.id ?? null;
    if (contactId) {
      if (suppressed) stopEnrollments(db, contactId, "bounced");
      logActivity(db, {
        subjectType: "contact",
        subjectId: contactId,
        type: "email.bounced",
        summary: `${input.type === "hard" ? "Hard" : "Soft"} bounce${input.reason ? `: ${input.reason.slice(0, 160)}` : ""}`,
        data: { sendId: send.id, type: input.type, source: input.source, suppressed },
        occurredAt: now,
      });
    }
  })();
  return { applied: true, suppressed, sendId: send.id };
}

export function applyComplaint(
  db: HubDb,
  input: {
    email: string;
    sendId?: string | null;
    providerMessageId?: string | null;
    source: string;
  },
  now = Date.now(),
): { applied: boolean } {
  const email = normalizeEmail(input.email);
  if (!email) return { applied: false };
  const send = findSend(db, {
    sendId: input.sendId,
    providerMessageId: input.providerMessageId,
    email,
  });
  db.transaction(() => {
    suppress(db, email, "complaint", input.source);
    if (send && send.to_email === email)
      db.prepare(
        "UPDATE email_sends SET complained_at = COALESCE(complained_at, ?) WHERE id = ?",
      ).run(now, send.id);
    const contact = getContactByEmail(db, email);
    if (contact) {
      db.prepare("UPDATE contacts SET email_opt_in = 0, updated_at = ? WHERE id = ?").run(
        now,
        contact.id,
      );
      stopEnrollments(db, contact.id, "complained");
      logActivity(db, {
        subjectType: "contact",
        subjectId: contact.id,
        type: "email.complained",
        summary: "Marked an email as spam",
        data: { sendId: send?.id ?? null, source: input.source },
        occurredAt: now,
      });
    }
  })();
  return { applied: true };
}

// ── Inbound (IMAP store) — DSN parsing + reply detection ────────────────────

export type InboundMessage = {
  id: string;
  messageId: string | null;
  fromAddr: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  headers: Record<string, string>;
  receivedAt: number;
};

export type InboundCursor = { receivedAt: number; id: string };
export type InboundReader = (cursor: InboundCursor, limit: number) => InboundMessage[];

export type DsnResult = {
  recipients: Array<{
    email: string;
    type: "hard" | "soft";
    status: string | null;
    reason: string | null;
  }>;
  refs: string[];
};

const DSN_SUBJECT =
  /(undeliver|delivery status notification|returned mail|mail delivery (failed|failure|subsystem)|delivery failure|failure notice|message not delivered|could not be delivered|delivery has failed)/i;
const HARD_HINTS =
  /(user unknown|no such user|does not exist|address not found|unknown recipient|recipient address rejected|mailbox unavailable|invalid recipient|account (has been )?disabled|no mailbox|not found)/i;
const SOFT_HINTS =
  /(mailbox (is )?full|quota|over ?quota|temporar|try again|greylist|rate limit|deferred|timed out)/i;

function body(m: InboundMessage): string {
  return `${m.text ?? ""}\n${(m.html ?? "").replace(/<[^>]+>/g, " ")}`.slice(0, 200_000);
}

function headerRefs(h: Record<string, string>): string[] {
  const raw = `${h["in-reply-to"] ?? ""} ${h["references"] ?? ""}`;
  const ids = raw.match(/<[^<>\s]+>/g) ?? raw.split(/[\s,]+/).filter((x) => x.includes("@"));
  return [...new Set(ids)];
}

/** Parse a delivery-status notification; null when the message is not a DSN. */
export function parseDsn(m: InboundMessage): DsnResult | null {
  const from = (m.fromAddr ?? "").toLowerCase();
  const h = m.headers ?? {};
  const text = body(m);
  const isDsn =
    /mailer-daemon|postmaster|mail-delivery|bounce/.test(from) ||
    !!h["x-failed-recipients"] ||
    /report-type=["']?delivery-status/i.test(h["content-type"] ?? "") ||
    DSN_SUBJECT.test(m.subject ?? "");
  if (!isDsn) return null;
  if (
    /\bdelay(ed)?\b|will (retry|continue trying)|still trying/i.test(
      `${m.subject} ${text.slice(0, 2000)}`,
    ) &&
    !/\b5\.\d{1,3}\.\d{1,3}\b/.test(text)
  )
    return null; // delay notice, not a bounce
  const found = new Map<string, { status: string | null; reason: string | null }>();
  const add = (e: string | undefined) => {
    const email = normalizeEmail(e);
    if (email && !found.has(email)) found.set(email, { status: null, reason: null });
  };
  for (const e of (h["x-failed-recipients"] ?? "").split(/[,\s]+/)) add(e);
  for (const mm of text.matchAll(/(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s>;]+)/gi))
    add(mm[1]);
  if (!found.size)
    for (const mm of text.matchAll(
      /(?:wasn't delivered to|could not be delivered to|delivery to the following recipients? failed[^:]*:|undeliverable to|recipient:)\s*<?([^\s<>"']+@[^\s<>"']+)/gi,
    ))
      add(mm[1]);
  const status =
    /Status:\s*([245]\.\d{1,3}\.\d{1,3})/i.exec(text)?.[1] ??
    /\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(text)?.[1] ??
    null;
  const reason =
    /Diagnostic-Code:\s*[^;\n]*;\s*([^\n]+)/i.exec(text)?.[1]?.trim() ??
    /\b([45]\d\d[ -][^\n]{0,160})/.exec(text)?.[1]?.trim() ??
    null;
  const type: "hard" | "soft" = status
    ? status.startsWith("5")
      ? "hard"
      : "soft"
    : SOFT_HINTS.test(text) && !HARD_HINTS.test(text)
      ? "soft"
      : "hard";
  const refs = new Set(headerRefs(h));
  for (const mm of text.matchAll(/Message-ID:\s*(<[^<>\s]+>)/gi)) refs.add(mm[1]);
  for (const mm of text.matchAll(/X-IB-Send:\s*(es_[A-Za-z0-9_-]+)/gi)) refs.add(mm[1]);
  return {
    recipients: [...found.keys()].map((email) => ({ email, type, status, reason })),
    refs: [...refs],
  };
}

function isAutoReply(m: InboundMessage): boolean {
  const h = m.headers ?? {};
  const auto = (h["auto-submitted"] ?? "").toLowerCase();
  if (auto && auto !== "no") return true;
  if (
    h["x-autoreply"] ||
    h["x-autorespond"] ||
    /auto_reply|oof/i.test(h["x-auto-response-suppress"] ?? "")
  )
    return true;
  if ((h["precedence"] ?? "").toLowerCase().match(/bulk|junk|auto_reply/)) return true;
  return /^(auto(matic)? ?reply|out of (the )?office|autoreply|away from)/i.test(m.subject ?? "");
}

const REPLY_WINDOW_MS = 30 * 86_400_000;

/** Apply one inbound message: DSN → bounce, else reply detection. */
export function processInboundMessage(
  db: HubDb,
  m: InboundMessage,
  hooks?: BusinessHubHooks,
): "bounce" | "reply" | null {
  const dsn = parseDsn(m);
  if (dsn) {
    let hit = false;
    const refSend = dsn.refs
      .map((r) =>
        r.startsWith("es_") ? findSend(db, { sendId: r }) : findSend(db, { providerMessageId: r }),
      )
      .find((s): s is SendRow => !!s);
    const recipients = dsn.recipients.length
      ? dsn.recipients
      : refSend
        ? [{ email: refSend.to_email, type: "hard" as const, status: null, reason: null }]
        : [];
    for (const r of recipients) {
      const res = applyBounce(
        db,
        {
          email: r.email,
          type: r.type,
          sendId: refSend && refSend.to_email === r.email ? refSend.id : null,
          reason: r.reason ?? r.status,
          source: "dsn",
        },
        m.receivedAt,
      );
      hit = hit || res.applied;
    }
    return hit ? "bounce" : null;
  }
  const autoReply = isAutoReply(m);
  const from = normalizeEmail(m.fromAddr);
  if (!from) return null;
  let send: SendRow | null = null;
  for (const ref of headerRefs(m.headers ?? {})) {
    const s = findSend(db, { providerMessageId: ref });
    if (s && s.to_email === from) {
      send = s;
      break;
    }
  }
  if (!send)
    send =
      (db
        .prepare(
          `SELECT * FROM email_sends WHERE to_email = ? AND status = 'sent' AND contact_id IS NOT NULL
           AND sent_at <= ? AND sent_at >= ? ORDER BY sent_at DESC LIMIT 1`,
        )
        .get(from, m.receivedAt, m.receivedAt - REPLY_WINDOW_MS) as SendRow | undefined) ?? null;
  if (!send || send.replied_at || !send.contact_id) return null;
  const contactId = send.contact_id;
  if (autoReply) {
    fireHook(hooks, "onReplied", contactId, {
      sendId: send.id,
      emailCampaignId: send.email_campaign_id,
      inboundId: m.id,
      subject: m.subject,
      body: m.text ?? (m.html ?? "").replace(/<[^>]+>/g, " "),
      autoReply: true,
      receivedAt: m.receivedAt,
    });
    return null;
  }
  db.transaction(() => {
    db.prepare("UPDATE email_sends SET replied_at = ? WHERE id = ?").run(m.receivedAt, send.id);
    if (send.email_campaign_id) {
      const c = db
        .prepare("SELECT stop_on_reply FROM email_campaigns WHERE id = ?")
        .get(send.email_campaign_id) as { stop_on_reply: number } | undefined;
      if (c?.stop_on_reply) stopEnrollments(db, contactId, "replied", send.email_campaign_id);
    }
    logActivity(db, {
      subjectType: "contact",
      subjectId: contactId,
      type: "email.replied",
      summary: `Replied: ${(m.subject ?? "").slice(0, 160)}`,
      data: { sendId: send.id, emailCampaignId: send.email_campaign_id, inboundId: m.id },
      occurredAt: m.receivedAt,
    });
  })();
  fireHook(hooks, "onReplied", contactId, {
    sendId: send.id,
    emailCampaignId: send.email_campaign_id,
    inboundId: m.id,
    subject: m.subject,
    body: m.text ?? (m.html ?? "").replace(/<[^>]+>/g, " "),
    autoReply: false,
    receivedAt: m.receivedAt,
  });
  return "reply";
}

let inboundDb: Database.Database | null = null;
let inboundDbPath: string | null = null;

/** Default reader over the IMAP inbound store (`<stateDir>/email-messages.db`, read-only). */
export const defaultInboundReader: InboundReader = (cursor, limit) => {
  const dir = process.env.INFINIBOT_STATE_DIR?.trim() || resolveConfigDir();
  const path = join(dir, "email-messages.db");
  if (inboundDbPath !== path) {
    inboundDb?.close();
    inboundDb = null;
    inboundDbPath = path;
  }
  if (!inboundDb) {
    if (!existsSync(path)) return [];
    inboundDb = new Database(path, { readonly: true, fileMustExist: true });
  }
  const rows = inboundDb
    .prepare(
      `SELECT id, messageId, fromAddr, subject, text, html, headers, receivedAt FROM email_messages
       WHERE receivedAt > ? OR (receivedAt = ? AND id > ?) ORDER BY receivedAt, id LIMIT ?`,
    )
    .all(cursor.receivedAt, cursor.receivedAt, cursor.id, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    messageId: (r.messageId as string) ?? null,
    fromAddr: (r.fromAddr as string) ?? null,
    subject: (r.subject as string) ?? null,
    text: (r.text as string) ?? null,
    html: (r.html as string) ?? null,
    headers: parseJson<Record<string, string>>(r.headers, {}),
    receivedAt: r.receivedAt as number,
  }));
};

/**
 * Scan inbound messages received since the last run (cursor in hub_meta
 * `email.inboundCursor`; first run starts 7 days back) for bounces + replies.
 */
export function pollInboundForReplies(
  db: HubDb,
  deps: { hooks?: BusinessHubHooks; readInbound?: InboundReader; now?: number } = {},
): { scanned: number; replies: number; bounces: number } {
  const read = deps.readInbound ?? defaultInboundReader;
  const now = deps.now ?? Date.now();
  let cursor = parseJson<InboundCursor | null>(getMeta(db, "email.inboundCursor"), null) ?? {
    receivedAt: now - 7 * 86_400_000,
    id: "",
  };
  const out = { scanned: 0, replies: 0, bounces: 0 };
  for (let page = 0; page < 20; page++) {
    const batch = read(cursor, 200);
    if (!batch.length) break;
    for (const m of batch) {
      out.scanned++;
      try {
        const r = processInboundMessage(db, m, deps.hooks);
        if (r === "reply") out.replies++;
        else if (r === "bounce") out.bounces++;
      } catch (err) {
        getEmailRuntime().log?.("inbound message failed", { id: m.id, err: String(err) });
      }
      cursor = { receivedAt: m.receivedAt, id: m.id };
    }
    setMeta(db, "email.inboundCursor", JSON.stringify(cursor));
    if (batch.length < 200) break;
  }
  return out;
}

// ── Provider webhooks ────────────────────────────────────────────────────────

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Verify a Svix-style signature (Resend): v1,<base64 HMAC-SHA256(id.timestamp.body)>. */
export function verifySvixSignature(
  secret: string,
  h: { id?: string; timestamp?: string; signature?: string },
  rawBody: string,
  now = Date.now(),
  toleranceSec = 300,
): boolean {
  if (!h.id || !h.timestamp || !h.signature) return false;
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceSec) return false;
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const expected = createHmac("sha256", key)
    .update(`${h.id}.${h.timestamp}.${rawBody}`)
    .digest("base64");
  return h.signature.split(" ").some((part) => {
    const [v, sig] = part.split(",");
    return v === "v1" && !!sig && safeEqual(sig, expected);
  });
}

export type WebhookResult = { status: number; body: Record<string, unknown> };

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function handleResendWebhook(
  db: HubDb,
  headers: Record<string, string | undefined>,
  rawBody: string,
  now = Date.now(),
): WebhookResult {
  const secrets = sendersOfKind(db, "resend")
    .map((s) => s.webhookSigningSecret)
    .filter((s): s is string => !!s);
  if (secrets.length) {
    const h = {
      id: headers["svix-id"] ?? headers["webhook-id"],
      timestamp: headers["svix-timestamp"] ?? headers["webhook-timestamp"],
      signature: headers["svix-signature"] ?? headers["webhook-signature"],
    };
    if (!secrets.some((s) => verifySvixSignature(s, h, rawBody, now)))
      return { status: 401, body: { error: "invalid signature" } };
  }
  const evt = asObj(parseJson(rawBody, {}));
  const type = asStr(evt.type) ?? "";
  const data = asObj(evt.data);
  const providerMessageId = asStr(data.email_id);
  const to = asArr(data.to)
    .map((x) => asStr(x))
    .filter((x): x is string => !!x);
  let handled = 0;
  if (type === "email.bounced") {
    const bounce = asObj(data.bounce);
    const kind = (asStr(bounce.type) ?? "").toLowerCase();
    const soft = kind === "transient" || kind === "undetermined";
    for (const email of to)
      handled += applyBounce(
        db,
        {
          email,
          type: soft ? "soft" : "hard",
          providerMessageId,
          reason: asStr(bounce.message),
          source: "resend",
        },
        now,
      ).applied
        ? 1
        : 0;
  } else if (type === "email.complained") {
    for (const email of to) {
      applyComplaint(db, { email, providerMessageId, source: "resend" }, now);
      handled++;
    }
  }
  return { status: 200, body: { ok: true, type, handled, verified: secrets.length > 0 } };
}

const POSTMARK_HARD = new Set([
  "HardBounce",
  "BadEmailAddress",
  "ManuallyDeactivated",
  "Blocked",
  "DMARCPolicy",
]);
const POSTMARK_SOFT = new Set(["SoftBounce", "Transient", "DnsError", "ChallengeVerification"]);

export function handlePostmarkWebhook(db: HubDb, rawBody: string, now = Date.now()): WebhookResult {
  const evt = asObj(parseJson(rawBody, {}));
  const record = asStr(evt.RecordType) ?? "";
  const email = asStr(evt.Email) ?? asStr(evt.Recipient) ?? "";
  const providerMessageId = asStr(evt.MessageID);
  if (record === "SpamComplaint" || asStr(evt.Type) === "SpamComplaint") {
    applyComplaint(db, { email, providerMessageId, source: "postmark" }, now);
    return { status: 200, body: { ok: true, type: "complaint" } };
  }
  if (record === "Bounce") {
    const t = asStr(evt.Type) ?? "";
    if (t === "SpamNotification")
      applyComplaint(db, { email, providerMessageId, source: "postmark" }, now);
    else if (POSTMARK_HARD.has(t) || POSTMARK_SOFT.has(t))
      applyBounce(
        db,
        {
          email,
          type: POSTMARK_HARD.has(t) ? "hard" : "soft",
          providerMessageId,
          reason: asStr(evt.Description) ?? t,
          source: "postmark",
        },
        now,
      );
    return { status: 200, body: { ok: true, type: t } };
  }
  return { status: 200, body: { ok: true, ignored: record } };
}

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/**
 * SES via SNS. SNS message signatures (X.509 per message) are not verified;
 * the endpoint is authenticated by the secret path segment instead, and the
 * subscription confirmation only follows https://sns.<region>.amazonaws.com.
 */
export async function handleSesWebhook(
  db: HubDb,
  rawBody: string,
  now = Date.now(),
  fetchFn: typeof fetch = getEmailRuntime().fetch ?? fetch,
): Promise<WebhookResult> {
  const env = asObj(parseJson(rawBody, {}));
  const type = asStr(env.Type);
  if (type === "SubscriptionConfirmation") {
    const url = asStr(env.SubscribeURL);
    let u: URL | null = null;
    try {
      u = url ? new URL(url) : null;
    } catch {
      u = null;
    }
    if (!u || u.protocol !== "https:" || !SNS_HOST.test(u.hostname))
      return { status: 400, body: { error: "bad SubscribeURL" } };
    const res = await fetchFn(u.toString(), { signal: AbortSignal.timeout(10_000) });
    return { status: res.ok ? 200 : 502, body: { ok: res.ok, confirmed: res.ok } };
  }
  const msg = asObj(type === "Notification" ? parseJson(asStr(env.Message) ?? "", {}) : env);
  const kind = asStr(msg.notificationType) ?? asStr(msg.eventType) ?? "";
  const mail = asObj(msg.mail);
  let providerMessageId: string | null = null;
  let sendId: string | null = null;
  for (const h of asArr(mail.headers)) {
    const o = asObj(h);
    const name = (asStr(o.name) ?? "").toLowerCase();
    if (name === "message-id") providerMessageId = asStr(o.value);
    if (name === "x-ib-send") sendId = asStr(o.value);
  }
  providerMessageId ??= asStr(mail.messageId);
  let handled = 0;
  if (kind === "Bounce") {
    const b = asObj(msg.bounce);
    const soft = asStr(b.bounceType) !== "Permanent";
    for (const r of asArr(b.bouncedRecipients)) {
      const o = asObj(r);
      if (
        applyBounce(
          db,
          {
            email: asStr(o.emailAddress) ?? "",
            type: soft ? "soft" : "hard",
            sendId,
            providerMessageId,
            reason: asStr(o.diagnosticCode) ?? asStr(b.bounceSubType),
            source: "ses",
          },
          now,
        ).applied
      )
        handled++;
    }
  } else if (kind === "Complaint") {
    for (const r of asArr(asObj(msg.complaint).complainedRecipients)) {
      applyComplaint(
        db,
        { email: asStr(asObj(r).emailAddress) ?? "", sendId, providerMessageId, source: "ses" },
        now,
      );
      handled++;
    }
  }
  return { status: 200, body: { ok: true, type: kind, handled } };
}

/** Route a webhook after checking the secret path segment (timing-safe). */
export async function handleEmailWebhook(
  db: HubDb,
  provider: string,
  secret: string,
  headers: Record<string, string | undefined>,
  rawBody: string,
  now = Date.now(),
): Promise<WebhookResult> {
  if (!secret || !safeEqual(secret, getWebhookSecret(db)))
    return { status: 404, body: { error: "not found" } };
  switch (provider) {
    case "resend":
      return handleResendWebhook(db, headers, rawBody, now);
    case "postmark":
      return handlePostmarkWebhook(db, rawBody, now);
    case "ses":
      return handleSesWebhook(db, rawBody, now);
    default:
      return { status: 404, body: { error: "unknown provider" } };
  }
}

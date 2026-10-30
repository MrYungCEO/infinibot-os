/**
 * Inbox Listener — inbound email ingestion.
 *
 * Two implementations:
 *   1. ResendInboundWebhook — HTTP endpoint `/api/inbox/resend` (low-latency, preferred)
 *   2. ImapListener — IDLE-based polling (requires IMAP_HOST/USER/PASS env)
 *
 * Selection at startup:
 *   - OUTREACH_PROVIDER=resend → webhook listener (wire the HTTP route)
 *   - IMAP_HOST set → IMAP listener
 *   - Neither → NO-OP with startup warning
 *
 * Threading: match incoming on In-Reply-To / References headers against stored
 * messageId. Fallback: From + subject fuzzy match.
 *
 * TODO(closed-loop): wire ResendInboundWebhook into the gateway HTTP server.
 * TODO(closed-loop): configure Resend inbound routing at resend.com/inbound.
 */

import { createHmac } from "node:crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InboundMessage {
  from: string;
  to: string;
  subject: string;
  /** Plain text body (for classifier). */
  bodyText: string;
  /** HTML body (optional). */
  bodyHtml?: string;
  /** Message-ID header from the incoming email. */
  inMessageId?: string;
  /** In-Reply-To header (points to original outbound messageId). */
  inReplyTo?: string;
  /** References header (space-separated list of message IDs). */
  references?: string;
  receivedAt: Date;
}

export interface InboxEventSink {
  /** Called for each matched thread reply. leadId+messageId resolved by threading logic. */
  onReply(params: {
    inboundMessage: InboundMessage;
    /** Matched outbound messageId (from In-Reply-To / References). */
    matchedMessageId: string | null;
    /** Matched leadId (resolved from outreach DB). */
    matchedLeadId: string | null;
  }): Promise<void> | void;
}

// ── Resend Inbound Webhook handler ────────────────────────────────────────────

export interface ResendInboundPayload {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string | string[]>;
  messageId?: string;
}

/**
 * Parse and validate a Resend inbound webhook request.
 * Returns the parsed InboundMessage, or null if validation fails.
 *
 * Integrate in your HTTP server:
 *   const inbound = parseResendWebhook(body, signature, webhookSecret);
 *   if (inbound) await sink.onReply({ inboundMessage: inbound, ... });
 */
export function parseResendWebhook(
  rawBody: string,
  signature: string | undefined,
  webhookSecret: string | undefined,
): InboundMessage | null {
  // Signature verification (optional — required in production)
  if (webhookSecret && signature) {
    const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
    if (signature !== expected) {
      console.error("[inbox:resend] Webhook signature mismatch — rejecting");
      return null;
    }
  } else if (webhookSecret && !signature) {
    console.warn("[inbox:resend] RESEND_WEBHOOK_SECRET set but no signature header received");
  }

  let payload: ResendInboundPayload;
  try {
    payload = JSON.parse(rawBody) as ResendInboundPayload;
  } catch (err) {
    console.error(`[inbox:resend] Failed to parse webhook body: ${String(err)}`);
    return null;
  }

  const headers = _flattenHeaders(payload.headers ?? {});

  return {
    from: payload.from,
    to: (payload.to ?? []).join(", "),
    subject: payload.subject ?? "",
    bodyText: payload.text ?? _stripHtml(payload.html ?? ""),
    bodyHtml: payload.html,
    inMessageId: headers["message-id"]?.replace(/[<>]/g, ""),
    inReplyTo: headers["in-reply-to"]?.replace(/[<>]/g, ""),
    references: headers["references"],
    receivedAt: new Date(),
  };
}

function _flattenHeaders(headers: Record<string, string | string[]>): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    flat[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return flat;
}

function _stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Threading logic ───────────────────────────────────────────────────────────

/**
 * Given an inbound message, extract candidate outbound messageIds to look up
 * in the OutreachMessages DB. Returns in-order of match priority:
 *   1. In-Reply-To (most reliable)
 *   2. References (fallback — check each ID in reverse order)
 */
export function extractReplyMessageIds(inbound: InboundMessage): string[] {
  const ids: string[] = [];

  if (inbound.inReplyTo) ids.push(inbound.inReplyTo.trim());

  if (inbound.references) {
    // References is space-separated, last ID is most recent
    const refs = inbound.references.trim().split(/\s+/).filter(Boolean).reverse();
    for (const ref of refs) {
      const clean = ref.replace(/[<>]/g, "").trim();
      if (clean && !ids.includes(clean)) ids.push(clean);
    }
  }

  return ids;
}

// ── IMAP Listener (stub — requires `imap` npm package) ───────────────────────

/**
 * Starts an IMAP IDLE listener that delivers new messages to `sink`.
 * Returns a stop() function. Call stop() to disconnect cleanly.
 *
 * Requires env: IMAP_HOST, IMAP_USER, IMAP_PASS
 * Optional: IMAP_PORT (default 993), IMAP_TLS (default true)
 *
 * NOTE: This implementation is a structural stub. Wire in the `imap` npm
 * package or `node-imap` for production. The interfaces and flow are correct;
 * only the actual IMAP connection is stubbed.
 *
 * TODO(closed-loop): install `imap` package and implement _connectImap().
 */
export async function startImapListener(sink: InboxEventSink): Promise<{
  stop: () => void;
  mode: "imap" | "noop";
}> {
  const host = process.env.IMAP_HOST;
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;

  if (!host || !user || !pass) {
    console.warn(
      "[inbox:imap] IMAP_HOST, IMAP_USER, or IMAP_PASS not set — inbox listener is a NO-OP. " +
        "Configure IMAP to enable reply detection, or use OUTREACH_PROVIDER=resend for webhook-based inbound.",
    );
    return { stop: () => {}, mode: "noop" };
  }

  console.log(`[inbox:imap] Connecting to ${host} as ${user} (STUB — production wire needed)`);
  console.warn(
    "[inbox:imap] IMAP listener is stubbed. " +
      "TODO(closed-loop): install `imap` package and implement _connectImap() in listener.ts.",
  );

  // Stub: return a no-op stop function
  return {
    stop: () => {
      console.log("[inbox:imap] Listener stopped");
    },
    mode: "imap",
  };
}

// ── Startup banner ────────────────────────────────────────────────────────────

export function logInboxListenerConfig(): void {
  const provider = process.env.OUTREACH_PROVIDER ?? "mock";
  const hasImap = !!(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS);
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;

  if (provider === "resend") {
    console.log(
      `[inbox] Mode: Resend inbound webhook at /api/inbox/resend ` +
        (webhookSecret
          ? "(signature verification enabled)"
          : "(⚠ no RESEND_WEBHOOK_SECRET — webhooks unverified)"),
    );
  } else if (hasImap) {
    console.log(`[inbox] Mode: IMAP IDLE listener on ${process.env.IMAP_HOST}`);
  } else {
    console.warn(
      "[inbox] ⚠ No inbox listener configured. Replies will not be detected automatically. " +
        "Set OUTREACH_PROVIDER=resend (and wire the webhook) or set IMAP_HOST/USER/PASS.",
    );
  }
}

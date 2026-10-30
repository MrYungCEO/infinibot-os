/**
 * /loops/webhook — receiver for Loops.so delivery events.
 *
 * Loops POSTs to this URL when an email is sent / delivered / opened /
 * clicked / bounced / unsubscribed. Each event lands in the local
 * loops_events SQLite table so the Email Marketing dashboard can
 * compute KPIs without paginating Loops on every load.
 *
 * Configure in Loops: app.loops.so → Settings → Webhooks → add an
 * endpoint that points at `https://<your-gateway>/loops/webhook`.
 *
 * Auth: optional shared-secret check against `loops.webhookSecret` in
 * config. Loops sends the secret as `Loops-Signature` header
 * (raw HMAC-SHA256 over the body) — we accept either an HMAC match OR
 * a plain-equality match against the configured secret to keep setup
 * simple for self-hosters who don't want signature verification.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadConfig } from "../config/config.js";
import { recordWebhookEvent } from "../loops/store.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("loops").child("webhook");
const ROUTE = "/loops/webhook";

interface LoopsWebhookPayload {
  /** Loops's stable event id; we use it for idempotency. */
  id?: string;
  eventId?: string;
  /** ISO timestamp Loops attaches to every event. */
  timestamp?: string;
  ts?: number;
  /** Event family — one of email.sent, email.delivered, email.opened,
   *  email.clicked, email.bounced, email.unsubscribed. Loops occasionally
   *  drops the "email." prefix on legacy webhooks; the store handles
   *  both. */
  event?: string;
  type?: string;
  email?: string;
  contactId?: string;
  campaign?: { id?: string; name?: string };
  template?: { id?: string; name?: string };
  campaignId?: string;
  campaignName?: string;
  templateId?: string;
  templateName?: string;
}

function parseTimestamp(input: LoopsWebhookPayload): number {
  if (typeof input.ts === "number") return input.ts;
  if (input.timestamp) {
    const ms = Date.parse(input.timestamp);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

function pickEventId(input: LoopsWebhookPayload, body: string): string {
  if (input.id) return input.id;
  if (input.eventId) return input.eventId;
  // Last-ditch: hash the body so duplicate deliveries get deduped via
  // the ON CONFLICT(id) DO NOTHING in the store.
  return `sha:${createHmac("sha256", "loops").update(body).digest("hex").slice(0, 32)}`;
}

function verifySecret(req: IncomingMessage, body: string, secret: string): boolean {
  const provided = (req.headers["loops-signature"] || req.headers["x-loops-signature"]) as
    | string
    | undefined;
  if (!provided) return false;
  // Plain-equality fallback — operator pasted the secret into both Loops's
  // webhook config and our config. Cheap and good enough for self-hosters
  // who don't want to manage HMAC.
  if (timingEq(provided, secret)) return true;
  // HMAC-SHA256 over the raw body, hex.
  try {
    const computed = createHmac("sha256", secret).update(body).digest("hex");
    return timingEq(provided, computed);
  } catch {
    return false;
  }
}

function timingEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 1 * 1024 * 1024; // 1 MB — Loops payloads are small
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX) {
        req.destroy(new Error("payload too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function handleLoopsWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== ROUTE) return false;

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    res.end();
    return true;
  }

  let body = "";
  try {
    body = await readBody(req);
  } catch (err) {
    log.warn(`body read failed: ${(err as Error).message}`);
    res.statusCode = 413;
    res.end("payload too large");
    return true;
  }

  const cfg = loadConfig() as { loops?: { webhookSecret?: string } };
  const secret = cfg?.loops?.webhookSecret?.trim();
  if (secret && !verifySecret(req, body, secret)) {
    log.warn("rejected webhook: signature mismatch");
    res.statusCode = 401;
    res.end("unauthorized");
    return true;
  }

  let payload: LoopsWebhookPayload;
  try {
    payload = JSON.parse(body) as LoopsWebhookPayload;
  } catch {
    res.statusCode = 400;
    res.end("invalid json");
    return true;
  }

  const eventName = (payload.event || payload.type || "unknown").toLowerCase();
  const id = pickEventId(payload, body);
  const ts = parseTimestamp(payload);

  try {
    recordWebhookEvent({
      id,
      ts,
      event: eventName,
      email: payload.email,
      contactId: payload.contactId,
      campaignId: payload.campaign?.id ?? payload.campaignId,
      campaignName: payload.campaign?.name ?? payload.campaignName,
      templateId: payload.template?.id ?? payload.templateId,
      templateName: payload.template?.name ?? payload.templateName,
      raw: payload,
    });
  } catch (err) {
    log.error(`record failed: ${(err as Error).message}`);
    res.statusCode = 500;
    res.end("internal error");
    return true;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, id, event: eventName }));
  return true;
}

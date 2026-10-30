/**
 * Business hub revenue — inbound webhooks (Whop, Stripe). Signatures are
 * verified (Standard Webhooks for Whop, `t=…,v1=…` for Stripe, 5-minute
 * tolerance), each event is recorded once in `revenue_webhook_events`, and
 * an incremental sync of the account is triggered. Payload amounts are
 * never trusted — the sync refetches from the provider. The gateway plugin
 * mounts the HTTP route and passes the raw body.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { HubDb } from "../db.js";
import { getAccount, resolveWebhookSecret, type SecretCodec } from "./accounts.js";
import { syncAccount, type SyncDeps, type SyncResult } from "./sync.js";
import { errMessage, rec, s } from "./types.js";

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type VerifyResult = { ok: true } | { ok: false; reason: string };
export type HeaderBag = Headers | Record<string, string | string[] | undefined>;

export function headerValue(h: HeaderBag, name: string): string | null {
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() !== lower || v === undefined) continue;
    return Array.isArray(v) ? (v[0] ?? null) : v;
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Whop secrets come as `whsec_<base64>`, `ws_…`, hex or plain; try each decoding. */
export function whopSecretKeys(secret: string): Buffer[] {
  const stripped = secret.replace(/^whsec_/, "").replace(/^ws_/, "");
  const out: Buffer[] = [];
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)) out.push(Buffer.from(stripped, "base64"));
  if (/^[0-9a-f]+$/i.test(stripped) && stripped.length % 2 === 0)
    out.push(Buffer.from(stripped, "hex"));
  out.push(Buffer.from(stripped, "utf8"));
  if (stripped !== secret) out.push(Buffer.from(secret, "utf8"));
  return out;
}

/** Standard Webhooks signature (as Whop sends it). */
export function signStandardWebhook(key: Buffer, id: string, ts: number, body: string): string {
  return createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
}

export function verifyWhopWebhook(
  rawBody: string,
  headers: HeaderBag,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  const id = headerValue(headers, "webhook-id") ?? headerValue(headers, "svix-id");
  const ts = headerValue(headers, "webhook-timestamp") ?? headerValue(headers, "svix-timestamp");
  const sig = headerValue(headers, "webhook-signature") ?? headerValue(headers, "svix-signature");
  if (!id || !ts || !sig) return { ok: false, reason: "missing signature headers" };
  const t = Number(ts);
  if (!Number.isFinite(t)) return { ok: false, reason: "invalid timestamp" };
  if (Math.abs(nowSeconds - t) > WEBHOOK_TOLERANCE_SECONDS)
    return { ok: false, reason: "stale timestamp" };
  const given = sig
    .split(" ")
    .map((p) => {
      const i = p.indexOf(",");
      return i > 0
        ? { ver: p.slice(0, i).trim(), val: p.slice(i + 1).trim() }
        : { ver: "", val: "" };
    })
    .filter((p) => p.val && (p.ver === "v1" || p.ver === "v1a"));
  if (!given.length) return { ok: false, reason: "no v1 signature" };
  for (const key of whopSecretKeys(secret)) {
    const expected = signStandardWebhook(key, id, t, rawBody);
    if (given.some((g) => safeEqual(g.val, expected))) return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}

export function signStripeWebhook(secret: string, ts: number, body: string): string {
  return createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

/** Stripe `Stripe-Signature: t=…,v1=…[,v1=…]` (HMAC-SHA256 of `t.body`, secret as-is). */
export function verifyStripeWebhook(
  rawBody: string,
  sigHeader: string | null | undefined,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (!sigHeader) return { ok: false, reason: "missing Stripe-Signature" };
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of sigHeader.split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = Number(v);
    else if (k === "v1") v1.push(v);
  }
  if (t === null || !Number.isFinite(t)) return { ok: false, reason: "invalid timestamp" };
  if (!v1.length) return { ok: false, reason: "no v1 signature" };
  if (Math.abs(nowSeconds - t) > WEBHOOK_TOLERANCE_SECONDS)
    return { ok: false, reason: "stale timestamp" };
  const expected = signStripeWebhook(secret, t, rawBody);
  return v1.some((v) => safeEqual(v, expected))
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}

export type WebhookResponse = {
  status: number;
  body: { ok: boolean; duplicate?: boolean; eventId?: string; error?: string };
  /** The triggered sync (await it in tests; the route should not). */
  sync?: Promise<SyncResult | null>;
};

export type WebhookDeps = SyncDeps & {
  codec?: SecretCodec;
  nowSeconds?: number;
  /** Override what happens after an event is recorded (default: incremental sync). */
  triggerSync?: (db: HubDb, accountId: string) => Promise<SyncResult | null>;
};

const MAX_BODY = 1024 * 1024;

export async function handleRevenueWebhook(
  db: HubDb,
  provider: "whop" | "stripe",
  accountId: string,
  rawBody: string,
  headers: HeaderBag,
  deps: WebhookDeps = {},
): Promise<WebhookResponse> {
  if (rawBody.length > MAX_BODY)
    return { status: 413, body: { ok: false, error: "payload too large" } };
  const acct = getAccount(db, accountId);
  if (!acct || acct.provider !== provider)
    return { status: 404, body: { ok: false, error: "unknown account" } };
  let secret: string | null;
  try {
    secret = await resolveWebhookSecret(acct, deps.codec);
  } catch {
    secret = null;
  }
  if (!secret) return { status: 503, body: { ok: false, error: "webhook secret not configured" } };
  const verdict =
    provider === "whop"
      ? verifyWhopWebhook(rawBody, headers, secret, deps.nowSeconds)
      : verifyStripeWebhook(
          rawBody,
          headerValue(headers, "stripe-signature"),
          secret,
          deps.nowSeconds,
        );
  if (!verdict.ok) return { status: 401, body: { ok: false, error: verdict.reason } };

  let payload: Record<string, unknown> = {};
  try {
    payload = rec(JSON.parse(rawBody));
  } catch {
    return { status: 400, body: { ok: false, error: "invalid JSON" } };
  }
  const eventId =
    provider === "whop"
      ? (headerValue(headers, "webhook-id") ?? s(payload.id))
      : (s(payload.id) ?? null);
  if (!eventId) return { status: 400, body: { ok: false, error: "missing event id" } };
  const eventType = s(payload.type) ?? s(payload.action) ?? "unknown";
  const rowId = `${accountId}:${eventId}`;
  const inserted = db
    .prepare(
      "INSERT OR IGNORE INTO revenue_webhook_events(id,account_id,provider,event_type,received_at) VALUES(?,?,?,?,?)",
    )
    .run(rowId, accountId, provider, eventType, Date.now()).changes;
  if (!inserted) return { status: 200, body: { ok: true, duplicate: true, eventId } };

  const trigger =
    deps.triggerSync ??
    ((d: HubDb, id: string) => syncAccount(d, id, { mode: "incremental", deps }));
  const sync = trigger(db, accountId)
    .then((r) => {
      db.prepare("UPDATE revenue_webhook_events SET processed = 1, error = ? WHERE id = ?").run(
        r && !r.ok ? r.error : null,
        rowId,
      );
      return r;
    })
    .catch((err: unknown) => {
      db.prepare("UPDATE revenue_webhook_events SET error = ? WHERE id = ?").run(
        errMessage(err),
        rowId,
      );
      return null;
    });
  return { status: 200, body: { ok: true, eventId }, sync };
}

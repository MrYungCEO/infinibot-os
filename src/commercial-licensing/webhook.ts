import type { Sql } from "../saas/neon.js";
import { parseWhopEvent, verifyWhopSignature } from "../saas/cloud/whop.js";
import { sendCommercialLicenseEmail } from "./email.js";
import {
  findLicenseForWhop,
  issueCommercialLicense,
  renewCommercialLicense,
  revokeCommercialLicense,
  tierForWhopPlan,
  type CommercialLicenseRow,
} from "./store.js";
import { commercialPrivateKey } from "./token.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
export type CommercialWebhookResult = {
  ok: true;
  result: "issued" | "renewed" | "revoked" | "duplicate" | "ignored";
  licenseId?: string;
  reason?: string;
};
export type CommercialWebhookDeps = {
  sql: () => Promise<Sql>;
  env: Record<string, string | undefined>;
  now?: () => Date;
  sendEmail?: typeof sendCommercialLicenseEmail;
};

export function commercialWhopFields(body: unknown) {
  const root = obj(body);
  const data = obj(root.data);
  const membership = obj(data.membership);
  const metadata = {
    ...obj(membership.metadata),
    ...obj(data.checkout_metadata),
    ...obj(data.metadata),
  };
  return {
    type: (str(root.type) ?? str(root.action) ?? "unknown").toLowerCase(),
    checkoutRef: str(metadata.infinibot_license_checkout_ref),
    licensee:
      str(metadata.infinibot_licensee) ??
      str(obj(data.user).name) ??
      str(obj(membership.user).name),
    email:
      str(obj(data.user).email) ??
      str(obj(membership.user).email) ??
      str(data.email) ??
      str(metadata.infinibot_email),
    planId: str(data.plan_id) ?? str(obj(data.plan).id) ?? str(obj(membership.plan).id),
    membershipId:
      str(data.membership_id) ??
      str(membership.id) ??
      (!String(str(root.type) ?? "").startsWith("payment") ? str(data.id) : null),
    paymentId: String(str(root.type) ?? "").startsWith("payment")
      ? (str(data.payment_id) ?? str(data.id) ?? str(obj(data.payment).id))
      : str(data.payment_id),
  };
}

export async function handleCommercialLicenseWebhook(
  req: Request,
  deps: CommercialWebhookDeps,
): Promise<Response> {
  if (req.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const secret =
    deps.env.COMMERCIAL_LICENSE_WHOP_WEBHOOK_SECRET?.trim() || deps.env.WHOP_WEBHOOK_SECRET?.trim();
  if (!secret) return Response.json({ error: "webhook_secret_not_configured" }, { status: 500 });
  const raw = await req.text();
  if (raw.length > 1024 * 1024)
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  const sig = verifyWhopSignature(
    req.headers,
    raw,
    secret,
    Math.floor((deps.now?.() ?? new Date()).getTime() / 1000),
  );
  if (!sig.ok)
    return Response.json({ error: "invalid_signature", reason: sig.reason }, { status: 401 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = parseWhopEvent(
    body,
    req.headers.get("webhook-id") ?? req.headers.get("svix-id"),
    deps.env,
  );
  const f = commercialWhopFields(body);
  const eventId = parsed.eventId;
  const sql = await deps.sql();
  try {
    const result = await sql.begin(async (tx) => {
      const inserted = await tx<
        { id: number }[]
      >`insert into commercial_license_webhook_events(event_id,event_type,action,status,whop_membership_id,whop_payment_id,detail) values (${eventId},${f.type},'received','processing',${f.membershipId},${f.paymentId},${tx.json({ planId: f.planId, checkoutRef: f.checkoutRef })}) on conflict(event_id) do nothing returning id`;
      if (!inserted.length) return { ok: true, result: "duplicate" } as CommercialWebhookResult;
      const txSql = tx as unknown as Sql;
      let license: CommercialLicenseRow | null = await findLicenseForWhop(
        txSql,
        f.membershipId,
        f.paymentId,
        f.checkoutRef,
      );
      let result: CommercialWebhookResult;
      if (
        /refund|chargeback|dispute|membership\.(cancelled|canceled|deactivated|expired|went_invalid)/.test(
          f.type,
        )
      ) {
        if (!license) result = { ok: true, result: "ignored", reason: "license_not_found" };
        else {
          license = await revokeCommercialLicense(txSql, license.id, f.type);
          result = { ok: true, result: "revoked", licenseId: license!.id };
        }
      } else if (
        /payment(_attempt)?\.succeeded|membership\.(activated|created|went_valid)/.test(f.type)
      ) {
        const tier = await tierForWhopPlan(txSql, f.planId);
        if (!tier) result = { ok: true, result: "ignored", reason: "unmapped_plan" };
        else if (license && license.status !== "pending") {
          license = await renewCommercialLicense(
            txSql,
            license,
            tier,
            commercialPrivateKey(deps.env),
            deps.now?.() ?? new Date(),
          );
          result = { ok: true, result: "renewed", licenseId: license.id };
        } else {
          if (!f.email) result = { ok: true, result: "ignored", reason: "buyer_email_missing" };
          else {
            license = await issueCommercialLicense(txSql, {
              tier,
              email: f.email,
              licensee: f.licensee ?? f.email,
              source: "whop",
              privateKeyPem: commercialPrivateKey(deps.env),
              checkoutRef: f.checkoutRef,
              membershipId: f.membershipId,
              paymentId: f.paymentId,
              planId: f.planId,
              now: deps.now?.() ?? new Date(),
            });
            result = { ok: true, result: "issued", licenseId: license.id };
          }
        }
      } else result = { ok: true, result: "ignored", reason: "event_not_relevant" };
      await tx`update commercial_license_webhook_events set action=${result.result},status='processed',license_id=${result.licenseId ?? null},processed_at=now(),detail=detail||${tx.json({ reason: result.reason ?? null })}::jsonb where event_id=${eventId}`;
      return result;
    });
    if (result.licenseId && (result.result === "issued" || result.result === "renewed")) {
      const issued = await findLicenseForWhop(sql, f.membershipId, f.paymentId, f.checkoutRef);
      if (issued)
        await (deps.sendEmail ?? sendCommercialLicenseEmail)(issued, deps.env).catch(() => ({
          sent: false,
        }));
    }
    return Response.json(result, { status: 200 });
  } catch (err) {
    console.error("[commercial-license-webhook]", { eventId, type: f.type, error: String(err) });
    try {
      await sql`update commercial_license_webhook_events set status='failed',error=${String(err).slice(0, 1000)},processed_at=now() where event_id=${eventId}`;
    } catch {
      /* preserve original */
    }
    return Response.json({ error: "could_not_apply" }, { status: 500 });
  }
}

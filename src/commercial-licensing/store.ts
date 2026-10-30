import { randomBytes, randomUUID } from "node:crypto";
import type { Sql } from "../saas/neon.js";
import {
  COMMERCIAL_LICENSE_GRACE_DAYS,
  commercialTier,
  licenseExpirySeconds,
  type CommercialTierId,
  commercialUsesForTier,
} from "./catalog.js";
import { licenseTokenHash, signCommercialLicense } from "./token.js";

type Row = Record<string, unknown>;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const s = (v: unknown) => (typeof v === "string" ? v : "");
const n = (v: unknown) => Number(v);

export type LicenseTierRow = {
  id: CommercialTierId;
  name: string;
  priceCents: number;
  billingInterval: string;
  billingDays: number;
  seats: number;
  organizations: number;
  revenueCapUsd: number | null;
  whiteLabel: boolean;
  summary: string;
  features: string[];
  whopProductId: string | null;
  whopPlanId: string | null;
  active: boolean;
};

export type CommercialLicenseRow = {
  id: string;
  checkoutRef: string | null;
  jti: string;
  tierId: CommercialTierId;
  licensee: string;
  email: string;
  status: string;
  seats: number;
  organizations: number;
  source: string;
  whopMembershipId: string | null;
  whopPaymentId: string | null;
  whopPlanId: string | null;
  token: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  graceUntil: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
};

function tierRow(r: Row): LicenseTierRow {
  return {
    id: s(r.id) as CommercialTierId,
    name: s(r.name),
    priceCents: n(r.price_cents),
    billingInterval: s(r.billing_interval),
    billingDays: n(r.billing_days) || 365,
    seats: n(r.seats),
    organizations: n(r.organizations),
    revenueCapUsd: r.revenue_cap_usd == null ? null : n(r.revenue_cap_usd),
    whiteLabel: Boolean(r.white_label),
    summary: s(r.summary),
    features: Array.isArray(r.features) ? r.features.map(String) : [],
    whopProductId: (r.whop_product_id as string | null) ?? null,
    whopPlanId: (r.whop_plan_id as string | null) ?? null,
    active: Boolean(r.active),
  };
}
function licenseRow(r: Row): CommercialLicenseRow {
  const dt = (v: unknown) =>
    v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null;
  return {
    id: s(r.id),
    checkoutRef: (r.checkout_ref as string | null) ?? null,
    jti: s(r.jti),
    tierId: s(r.tier_id) as CommercialTierId,
    licensee: s(r.licensee),
    email: s(r.email),
    status: s(r.status),
    seats: n(r.seats),
    organizations: n(r.organizations),
    source: s(r.source),
    whopMembershipId: (r.whop_membership_id as string | null) ?? null,
    whopPaymentId: (r.whop_payment_id as string | null) ?? null,
    whopPlanId: (r.whop_plan_id as string | null) ?? null,
    token: (r.token as string | null) ?? null,
    issuedAt: dt(r.issued_at),
    expiresAt: dt(r.expires_at),
    graceUntil: dt(r.grace_until),
    revokedAt: dt(r.revoked_at),
    revokeReason: (r.revoke_reason as string | null) ?? null,
  };
}

export async function listCommercialTiers(sql: Sql): Promise<LicenseTierRow[]> {
  const rows = await sql<Row[]>`select * from commercial_license_tiers order by price_cents`;
  return rows.map(tierRow);
}

export async function getCommercialTier(sql: Sql, id: string): Promise<LicenseTierRow | null> {
  const rows = await sql<Row[]>`select * from commercial_license_tiers where id=${id} limit 1`;
  return rows[0] ? tierRow(rows[0]) : null;
}

export async function tierForWhopPlan(
  sql: Sql,
  planId: string | null,
): Promise<LicenseTierRow | null> {
  if (!planId) return null;
  const rows = await sql<
    Row[]
  >`select * from commercial_license_tiers where whop_plan_id=${planId} and active=true limit 1`;
  return rows[0] ? tierRow(rows[0]) : null;
}

export async function updateCommercialTier(
  sql: Sql,
  id: string,
  patch: Partial<
    Pick<
      LicenseTierRow,
      "name" | "priceCents" | "seats" | "organizations" | "summary" | "features" | "active"
    >
  >,
): Promise<LicenseTierRow | null> {
  const current = await getCommercialTier(sql, id);
  if (!current) return null;
  const rows = await sql<Row[]>`update commercial_license_tiers set
    name=${patch.name ?? current.name}, price_cents=${patch.priceCents ?? current.priceCents}, seats=${patch.seats ?? current.seats},
    organizations=${patch.organizations ?? current.organizations}, summary=${patch.summary ?? current.summary},
    features=${sql.json(patch.features ?? current.features)}, active=${patch.active ?? current.active}, updated_at=now()
    where id=${id} returning *`;
  return rows[0] ? tierRow(rows[0]) : null;
}

export async function saveTierWhopIds(
  sql: Sql,
  id: string,
  productId: string,
  planId: string,
): Promise<void> {
  await sql`update commercial_license_tiers set whop_product_id=${productId},whop_plan_id=${planId},updated_at=now() where id=${id}`;
}

export async function createPendingLicense(
  sql: Sql,
  tier: LicenseTierRow,
): Promise<{ id: string; checkoutRef: string }> {
  const id = randomUUID();
  const jti = randomUUID();
  const checkoutRef = randomBytes(24).toString("base64url");
  await sql`insert into commercial_licenses (id,checkout_ref,jti,tier_id,licensee,email,status,seats,organizations,source)
    values (${id},${checkoutRef},${jti},${tier.id},'Pending checkout','pending@invalid','pending',${tier.seats},${tier.organizations},'whop')`;
  return { id, checkoutRef };
}

export type IssueInput = {
  tier: LicenseTierRow;
  email: string;
  licensee: string;
  source: "whop" | "manual" | "complimentary";
  privateKeyPem: string;
  checkoutRef?: string | null;
  membershipId?: string | null;
  paymentId?: string | null;
  planId?: string | null;
  now?: Date;
  years?: number;
};

export async function issueCommercialLicense(
  sql: Sql,
  input: IssueInput,
): Promise<CommercialLicenseRow> {
  const now = input.now ?? new Date();
  const iat = Math.floor(now.getTime() / 1000);
  const exp =
    input.years == null
      ? iat + input.tier.billingDays * 86400
      : licenseExpirySeconds(iat, input.years);
  const existing = input.checkoutRef
    ? await sql<
        Row[]
      >`select * from commercial_licenses where checkout_ref=${input.checkoutRef} limit 1`
    : [];
  const id = existing[0] ? s(existing[0].id) : randomUUID();
  const jti = randomUUID();
  const { token } = signCommercialLicense(
    {
      sub: id,
      jti,
      iat,
      nbf: iat,
      exp,
      tier: input.tier.id,
      licensee: input.licensee,
      email: input.email.toLowerCase(),
      seats: input.tier.seats,
      organizations: input.tier.organizations,
      whiteLabel: input.tier.whiteLabel,
      revenueCapUsd: input.tier.revenueCapUsd,
      term: {
        interval: input.tier.billingInterval,
        termDays: input.tier.billingDays,
        autoRenew: input.source === "whop",
      },
      commercialUses: commercialUsesForTier(input.tier.id, input.tier.whiteLabel),
      source: input.source,
    },
    input.privateKeyPem,
  );
  const grace = iso(exp + COMMERCIAL_LICENSE_GRACE_DAYS * 86400);
  const rows = await sql<Row[]>`insert into commercial_licenses
    (id,checkout_ref,jti,tier_id,licensee,email,status,seats,organizations,source,whop_membership_id,whop_payment_id,whop_plan_id,token,token_hash,issued_at,starts_at,expires_at,grace_until,updated_at)
    values (${id},${input.checkoutRef ?? null},${jti},${input.tier.id},${input.licensee},${input.email.toLowerCase()},'active',${input.tier.seats},${input.tier.organizations},${input.source},${input.membershipId ?? null},${input.paymentId ?? null},${input.planId ?? null},${token},${licenseTokenHash(token)},${now.toISOString()},${now.toISOString()},${iso(exp)},${grace},now())
    on conflict (id) do update set jti=excluded.jti,tier_id=excluded.tier_id,licensee=excluded.licensee,email=excluded.email,status='active',seats=excluded.seats,organizations=excluded.organizations,source=excluded.source,whop_membership_id=coalesce(excluded.whop_membership_id,commercial_licenses.whop_membership_id),whop_payment_id=coalesce(excluded.whop_payment_id,commercial_licenses.whop_payment_id),whop_plan_id=coalesce(excluded.whop_plan_id,commercial_licenses.whop_plan_id),token=excluded.token,token_hash=excluded.token_hash,issued_at=excluded.issued_at,starts_at=excluded.starts_at,expires_at=excluded.expires_at,grace_until=excluded.grace_until,revoked_at=null,revoke_reason=null,updated_at=now() returning *`;
  return licenseRow(rows[0]!);
}

export async function renewCommercialLicense(
  sql: Sql,
  license: CommercialLicenseRow,
  tier: LicenseTierRow,
  privateKeyPem: string,
  now = new Date(),
): Promise<CommercialLicenseRow> {
  const base = Math.max(
    Math.floor(now.getTime() / 1000),
    license.expiresAt ? Math.floor(Date.parse(license.expiresAt) / 1000) : 0,
  );
  const exp = base + tier.billingDays * 86400;
  const iat = Math.floor(now.getTime() / 1000);
  const jti = randomUUID();
  const { token } = signCommercialLicense(
    {
      sub: license.id,
      jti,
      iat,
      nbf: iat,
      exp,
      tier: tier.id,
      licensee: license.licensee,
      email: license.email,
      seats: tier.seats,
      organizations: tier.organizations,
      whiteLabel: tier.whiteLabel,
      revenueCapUsd: tier.revenueCapUsd,
      term: {
        interval: tier.billingInterval,
        termDays: tier.billingDays,
        autoRenew: license.source === "whop",
      },
      commercialUses: commercialUsesForTier(tier.id, tier.whiteLabel),
      source: "whop",
    },
    privateKeyPem,
  );
  const rows = await sql<
    Row[]
  >`update commercial_licenses set jti=${jti},status='active',token=${token},token_hash=${licenseTokenHash(token)},issued_at=${now.toISOString()},expires_at=${iso(exp)},grace_until=${iso(exp + COMMERCIAL_LICENSE_GRACE_DAYS * 86400)},revoked_at=null,revoke_reason=null,updated_at=now() where id=${license.id} returning *`;
  return licenseRow(rows[0]!);
}

export async function findLicenseForWhop(
  sql: Sql,
  membershipId: string | null,
  paymentId: string | null,
  checkoutRef?: string | null,
): Promise<CommercialLicenseRow | null> {
  const rows = membershipId
    ? await sql<
        Row[]
      >`select * from commercial_licenses where whop_membership_id=${membershipId} limit 1`
    : paymentId
      ? await sql<
          Row[]
        >`select * from commercial_licenses where whop_payment_id=${paymentId} limit 1`
      : checkoutRef
        ? await sql<
            Row[]
          >`select * from commercial_licenses where checkout_ref=${checkoutRef} limit 1`
        : [];
  return rows[0] ? licenseRow(rows[0]) : null;
}
export async function getLicenseByReceipt(
  sql: Sql,
  ref: string,
): Promise<CommercialLicenseRow | null> {
  const rows = await sql<
    Row[]
  >`select * from commercial_licenses where checkout_ref=${ref} limit 1`;
  return rows[0] ? licenseRow(rows[0]) : null;
}
export async function getLicense(sql: Sql, id: string): Promise<CommercialLicenseRow | null> {
  const rows = await sql<Row[]>`select * from commercial_licenses where id=${id} limit 1`;
  return rows[0] ? licenseRow(rows[0]) : null;
}
export async function listCommercialLicenses(sql: Sql, q = ""): Promise<CommercialLicenseRow[]> {
  const like = `%${q.trim().toLowerCase()}%`;
  const rows = q.trim()
    ? await sql<
        Row[]
      >`select * from commercial_licenses where lower(email) like ${like} or lower(licensee) like ${like} or id::text like ${like} order by created_at desc limit 250`
    : await sql<Row[]>`select * from commercial_licenses order by created_at desc limit 250`;
  return rows.map(licenseRow);
}
export async function revokeCommercialLicense(
  sql: Sql,
  id: string,
  reason: string,
): Promise<CommercialLicenseRow | null> {
  const rows = await sql<
    Row[]
  >`update commercial_licenses set status='revoked',revoked_at=now(),revoke_reason=${reason},updated_at=now() where id=${id} returning *`;
  return rows[0] ? licenseRow(rows[0]) : null;
}
export async function extendCommercialLicense(
  sql: Sql,
  license: CommercialLicenseRow,
  tier: LicenseTierRow,
  days: number,
  privateKeyPem: string,
): Promise<CommercialLicenseRow> {
  const now = new Date();
  const base = Math.max(
    Math.floor(now.getTime() / 1000),
    license.expiresAt ? Math.floor(Date.parse(license.expiresAt) / 1000) : 0,
  );
  const exp = base + days * 86400;
  const iat = Math.floor(now.getTime() / 1000);
  const jti = randomUUID();
  const { token } = signCommercialLicense(
    {
      sub: license.id,
      jti,
      iat,
      nbf: iat,
      exp,
      tier: tier.id,
      licensee: license.licensee,
      email: license.email,
      seats: tier.seats,
      organizations: tier.organizations,
      whiteLabel: tier.whiteLabel,
      revenueCapUsd: tier.revenueCapUsd,
      term: {
        interval: tier.billingInterval,
        termDays: tier.billingDays,
        autoRenew: license.source === "whop",
      },
      commercialUses: commercialUsesForTier(tier.id, tier.whiteLabel),
      source: license.source as "whop" | "manual" | "complimentary",
    },
    privateKeyPem,
  );
  const rows = await sql<
    Row[]
  >`update commercial_licenses set jti=${jti},status='active',token=${token},token_hash=${licenseTokenHash(token)},issued_at=${now.toISOString()},expires_at=${iso(exp)},grace_until=${iso(exp + COMMERCIAL_LICENSE_GRACE_DAYS * 86400)},revoked_at=null,revoke_reason=null,updated_at=now() where id=${license.id} returning *`;
  return licenseRow(rows[0]!);
}
export async function auditLicense(
  sql: Sql,
  actor: string,
  action: string,
  licenseId: string | null,
  detail: unknown = {},
): Promise<void> {
  await sql`insert into commercial_license_audit(actor_email,action,license_id,detail) values (${actor},${action},${licenseId},${sql.json(detail as never)})`;
}
export async function listWebhookEvents(sql: Sql): Promise<Row[]> {
  return sql<
    Row[]
  >`select id,event_id as "eventId",event_type as "eventType",action,status,license_id as "licenseId",whop_membership_id as "membershipId",whop_payment_id as "paymentId",error,received_at as "receivedAt",processed_at as "processedAt" from commercial_license_webhook_events order by received_at desc limit 250`;
}

export const fallbackTier = (id: CommercialTierId): LicenseTierRow => {
  const t = commercialTier(id)!;
  return { ...t, billingInterval: t.interval, whopProductId: null, whopPlanId: null, active: true };
};

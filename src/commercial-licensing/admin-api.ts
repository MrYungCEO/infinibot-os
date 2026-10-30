import { requireOwner, type OwnerCheck } from "../fleet/admin/auth.js";
import { neon, type Sql } from "../saas/neon.js";
import { sendCommercialLicenseEmail } from "./email.js";
import { runCommercialLicenseMigrations } from "./schema.js";
import {
  auditLicense,
  extendCommercialLicense,
  getCommercialTier,
  getLicense,
  issueCommercialLicense,
  listCommercialLicenses,
  listCommercialTiers,
  listWebhookEvents,
  revokeCommercialLicense,
  updateCommercialTier,
} from "./store.js";
import { syncCommercialWhopCatalog } from "./whop.js";
import { commercialPrivateKey } from "./token.js";

type Env = Record<string, string | undefined>;
type Deps = {
  sql: () => Promise<Sql>;
  env: Env;
  authenticate: (token: string | undefined) => Promise<OwnerCheck>;
  fetchImpl?: typeof fetch;
};
const defaults = (): Deps => ({
  env: process.env,
  authenticate: requireOwner,
  sql: async () => {
    const sql = neon();
    await runCommercialLicenseMigrations(sql);
    return sql;
  },
});
const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
const bearer = (r: Request) =>
  /^Bearer\s+(.+)$/i.exec(r.headers.get("authorization") ?? "")?.[1]?.trim();
const safeId = (v: string) => /^[0-9a-f-]{36}$/i.test(v);
const positive = (v: unknown, min = 1, max = 100000) =>
  Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : null;

export async function handleCommercialLicenseAdmin(
  req: Request,
  partial: Partial<Deps> = {},
): Promise<Response> {
  const deps = { ...defaults(), ...partial };
  const who = await deps.authenticate(bearer(req));
  if (!who.ok)
    return json(who.status, {
      error:
        who.status === 401
          ? "unauthorized"
          : who.status === 403
            ? "forbidden"
            : "owner_not_configured",
    });
  const actor = who.email!;
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/licenses\/admin\/?/, "");
  try {
    const sql = await deps.sql();
    if (req.method === "GET" && path === "licenses")
      return json(200, {
        licenses: await listCommercialLicenses(sql, url.searchParams.get("q") ?? ""),
      });
    if (req.method === "GET" && path === "tiers")
      return json(200, { tiers: await listCommercialTiers(sql) });
    if (req.method === "GET" && path === "events")
      return json(200, { events: await listWebhookEvents(sql) });
    if (req.method === "POST" && path === "licenses") {
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const tier = await getCommercialTier(sql, String(b.tierId ?? ""));
      const email = String(b.email ?? "")
        .trim()
        .toLowerCase();
      const licensee = String(b.licensee ?? "").trim();
      if (!tier || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !licensee)
        return json(400, { error: "invalid_input" });
      const years = positive(b.years, 1, 20) ?? 1;
      const source = b.complimentary === true ? "complimentary" : "manual";
      const license = await issueCommercialLicense(sql, {
        tier,
        email,
        licensee,
        source,
        privateKeyPem: commercialPrivateKey(deps.env),
        years,
      });
      await auditLicense(sql, actor, "license.issue", license.id, { tier: tier.id, source });
      const delivery = await sendCommercialLicenseEmail(license, deps.env, deps.fetchImpl ?? fetch);
      return json(201, { license, delivery });
    }
    const m = /^licenses\/([0-9a-f-]{36})\/(revoke|extend|resend)$/.exec(path);
    if (m && safeId(m[1]!)) {
      const license = await getLicense(sql, m[1]!);
      if (!license) return json(404, { error: "license_not_found" });
      if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
      if (m[2] === "revoke") {
        const b = (await req.json().catch(() => ({}))) as { reason?: unknown };
        const reason = String(b.reason ?? "Manual revocation").trim();
        const updated = await revokeCommercialLicense(sql, license.id, reason);
        await auditLicense(sql, actor, "license.revoke", license.id, { reason });
        return json(200, { license: updated });
      }
      if (m[2] === "extend") {
        const b = (await req.json().catch(() => ({}))) as { days?: unknown };
        const days = positive(b.days, 1, 3650);
        if (!days) return json(400, { error: "invalid_days" });
        const tier = await getCommercialTier(sql, license.tierId);
        if (!tier) return json(409, { error: "tier_missing" });
        const updated = await extendCommercialLicense(
          sql,
          license,
          tier,
          days,
          commercialPrivateKey(deps.env),
        );
        await auditLicense(sql, actor, "license.extend", license.id, { days });
        return json(200, { license: updated });
      }
      const delivery = await sendCommercialLicenseEmail(license, deps.env, deps.fetchImpl ?? fetch);
      await auditLicense(sql, actor, "license.resend", license.id, delivery);
      return json(200, { delivery });
    }
    const tierMatch = /^tiers\/([a-z-]+)$/.exec(path);
    if (tierMatch && req.method === "PATCH") {
      const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const patch: Record<string, unknown> = {};
      if (typeof b.name === "string") patch.name = b.name.trim();
      if (positive(b.priceCents, 0, 100000000) !== null) patch.priceCents = Number(b.priceCents);
      if (positive(b.seats) !== null) patch.seats = Number(b.seats);
      if (positive(b.organizations) !== null) patch.organizations = Number(b.organizations);
      if (typeof b.summary === "string") patch.summary = b.summary.trim();
      if (Array.isArray(b.features)) patch.features = b.features.map(String).filter(Boolean);
      if (typeof b.active === "boolean") patch.active = b.active;
      const tier = await updateCommercialTier(sql, tierMatch[1]!, patch);
      if (!tier) return json(404, { error: "tier_not_found" });
      await auditLicense(sql, actor, "tier.update", null, {
        tier: tier.id,
        fields: Object.keys(patch),
      });
      return json(200, { tier });
    }
    const sync = /^tiers\/([a-z-]+)\/sync-whop$/.exec(path);
    if (sync && req.method === "POST") {
      const result = await syncCommercialWhopCatalog({
        sql,
        env: deps.env,
        apply: true,
        onlyTier: sync[1],
        fetchImpl: deps.fetchImpl,
      });
      await auditLicense(sql, actor, "tier.sync_whop", null, { tier: sync[1] });
      return json(200, result);
    }
    return json(404, { error: "not_found" });
  } catch (err) {
    console.error("[commercial-license-admin]", String(err));
    return json(500, { error: "internal_error", message: String(err) });
  }
}

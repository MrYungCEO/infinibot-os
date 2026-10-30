import { neon, type Sql } from "../saas/neon.js";
import { runCommercialLicenseMigrations } from "./schema.js";
import {
  createPendingLicense,
  getLicenseByReceipt,
  getCommercialTier,
  listCommercialTiers,
} from "./store.js";
import { createCommercialCheckout, CommercialWhopError } from "./whop.js";

type Deps = {
  sql: () => Promise<Sql>;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
};
const json = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
const baseDeps = (): Deps => ({
  env: process.env,
  sql: async () => {
    const sql = neon();
    await runCommercialLicenseMigrations(sql);
    return sql;
  },
});

export async function handleCommercialLicensePublicApi(
  req: Request,
  partial: Partial<Deps> = {},
): Promise<Response> {
  const deps = { ...baseDeps(), ...partial };
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/licenses\/?/, "");
  try {
    const sql = await deps.sql();
    if (req.method === "GET" && path === "tiers")
      return json(200, { tiers: (await listCommercialTiers(sql)).filter((t) => t.active) });
    if (req.method === "POST" && path === "checkout") {
      const body = (await req.json().catch(() => ({}))) as { tier?: unknown };
      const tier = await getCommercialTier(sql, typeof body.tier === "string" ? body.tier : "");
      if (!tier || !tier.active) return json(400, { error: "unknown_tier" });
      const pending = await createPendingLicense(sql, tier);
      const origin = deps.env.COMMERCIAL_LICENSE_SITE_ORIGIN?.trim() || url.origin;
      const redirectUrl = `${origin.replace(/\/$/, "")}/licenses/receipt?ref=${encodeURIComponent(pending.checkoutRef)}`;
      const checkoutUrl = await createCommercialCheckout({
        env: deps.env,
        tier,
        checkoutRef: pending.checkoutRef,
        redirectUrl,
        fetchImpl: deps.fetchImpl,
      });
      return json(200, { checkoutUrl, checkoutRef: pending.checkoutRef });
    }
    if (req.method === "GET" && path === "receipt") {
      const ref = url.searchParams.get("ref")?.trim() ?? "";
      if (!/^[A-Za-z0-9_-]{20,80}$/.test(ref)) return json(400, { error: "invalid_receipt" });
      const license = await getLicenseByReceipt(sql, ref);
      if (!license) return json(404, { error: "receipt_not_found" });
      return json(200, {
        license: {
          id: license.id,
          tierId: license.tierId,
          licensee: license.licensee,
          email: license.email,
          status: license.status,
          seats: license.seats,
          organizations: license.organizations,
          expiresAt: license.expiresAt,
          token: license.status === "active" ? license.token : null,
        },
      });
    }
    return json(404, { error: "not_found" });
  } catch (err) {
    if (err instanceof CommercialWhopError)
      return json(err.status, { error: "whop_error", message: err.message });
    console.error("[commercial-license-api]", String(err));
    return json(500, { error: "internal_error" });
  }
}

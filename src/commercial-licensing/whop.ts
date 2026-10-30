import type { Sql } from "../saas/neon.js";
import { COMMERCIAL_LICENSE_AGREEMENT_URL, COMMERCIAL_LICENSE_VERSION } from "./catalog.js";
import { listCommercialTiers, saveTierWhopIds, type LicenseTierRow } from "./store.js";

type Env = Record<string, string | undefined>;
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export const COMMERCIAL_WHOP_PRODUCT_TITLE = "InfiniBot Commercial Licensing";

export class CommercialWhopError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function commercialWhopMissingEnv(env: Env): string[] {
  return ["WHOP_API_KEY", "WHOP_COMPANY_ID"].filter((key) => !env[key]?.trim());
}

function whopBase(env: Env) {
  return (env.WHOP_API_BASE?.trim() || "https://api.whop.com").replace(/\/$/, "");
}

async function whopApi(
  env: Env,
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Obj> {
  const key = env.WHOP_API_KEY?.trim();
  if (!key) throw new CommercialWhopError(503, "WHOP_API_KEY is not configured.");
  const res = await fetchImpl(`${whopBase(env)}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let data: Obj = {};
  try {
    data = obj(text ? JSON.parse(text) : {});
  } catch {
    /* retain empty */
  }
  if (!res.ok) {
    const message = str(obj(data.error).message) ?? str(data.message) ?? text.slice(0, 200);
    throw new CommercialWhopError(
      502,
      `Whop ${method} ${path.split("?")[0]} returned ${res.status}: ${message}`,
    );
  }
  return data;
}

async function listAll(env: Env, path: string, fetchImpl: typeof fetch): Promise<Obj[]> {
  const company = env.WHOP_COMPANY_ID!.trim();
  const out: Obj[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ company_id: company, limit: "50" });
    if (after) qs.set("after", after);
    const data = await whopApi(env, "GET", `${path}?${qs}`, undefined, fetchImpl);
    const items = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.items)
        ? data.items
        : [];
    out.push(...items.map(obj));
    const info = obj(data.page_info ?? data.pageInfo);
    if (!info.has_next_page && !info.hasNextPage) break;
    after = str(info.end_cursor) ?? str(info.endCursor);
    if (!after) break;
  }
  return out;
}

function productId(v: Obj): string | null {
  return str(v.id);
}
function planProductId(v: Obj): string | null {
  return str(v.product_id) ?? str(obj(v.product).id) ?? str(v.product);
}

export type CommercialWhopSyncResult = {
  productId: string;
  tiers: Array<{
    id: string;
    planId: string;
    created: boolean;
    repriced: boolean;
    priceCents: number;
  }>;
};

/** Whop product copy: names the licensor and links the agreement buyers accept. */
export const COMMERCIAL_WHOP_PRODUCT_DESCRIPTION = `Commercial-use licenses for InfiniBot: competing products, hosted services, resale, white-label and OEM, by tier. FSL-permitted use remains free. Licensed by Kingly Intelligence Systems LLC. By purchasing you agree to the InfiniBot Commercial License Agreement v${COMMERCIAL_LICENSE_VERSION}: ${COMMERCIAL_LICENSE_AGREEMENT_URL}`;

export function commercialWhopPlanDescription(
  tier: Pick<LicenseTierRow, "priceCents" | "billingDays">,
): string {
  return `$${(tier.priceCents / 100).toLocaleString("en-US")} every ${tier.billingDays} days. Renews automatically until you cancel; each payment extends your signed license key. By purchasing you agree to the Commercial License Agreement: ${COMMERCIAL_LICENSE_AGREEMENT_URL}`;
}

export async function syncCommercialWhopCatalog(opts: {
  sql: Sql;
  env: Env;
  apply: boolean;
  onlyTier?: string;
  fetchImpl?: typeof fetch;
}): Promise<CommercialWhopSyncResult> {
  const missing = commercialWhopMissingEnv(opts.env);
  if (missing.length) throw new CommercialWhopError(503, `Missing ${missing.join(" and ")}.`);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const company = opts.env.WHOP_COMPANY_ID!.trim();
  const products = await listAll(opts.env, "/products", fetchImpl);
  let product = products.find(
    (p) => str(p.title) === COMMERCIAL_WHOP_PRODUCT_TITLE && str(p.visibility) !== "archived",
  );
  if (!product) {
    if (!opts.apply) product = { id: "(would-create)", title: COMMERCIAL_WHOP_PRODUCT_TITLE };
    else
      product = await whopApi(
        opts.env,
        "POST",
        "/products",
        {
          company_id: company,
          title: COMMERCIAL_WHOP_PRODUCT_TITLE,
          headline: "Commercial rights for the InfiniBot agent operating system",
          description: COMMERCIAL_WHOP_PRODUCT_DESCRIPTION,
          visibility: "visible",
        },
        fetchImpl,
      );
  }
  const pid = productId(product);
  if (!pid) throw new CommercialWhopError(502, "Whop returned no product id.");
  const plans = await listAll(opts.env, "/plans", fetchImpl);
  const tiers = (await listCommercialTiers(opts.sql)).filter(
    (t) => t.active && (!opts.onlyTier || t.id === opts.onlyTier),
  );
  const results: CommercialWhopSyncResult["tiers"] = [];
  for (const tier of tiers) {
    let plan = plans.find(
      (p) =>
        (str(p.title) === tier.name || str(p.id) === tier.whopPlanId) &&
        planProductId(p) === pid &&
        str(p.visibility) !== "archived",
    );
    let created = false,
      repriced = false;
    if (!plan) {
      created = true;
      if (!opts.apply)
        plan = {
          id: `(would-create-${tier.id})`,
          title: tier.name,
          renewal_price: tier.priceCents / 100,
          product_id: pid,
        };
      else
        plan = await whopApi(
          opts.env,
          "POST",
          "/plans",
          {
            company_id: company,
            product_id: pid,
            plan_type: "renewal",
            currency: "usd",
            billing_period: tier.billingDays,
            renewal_price: tier.priceCents / 100,
            initial_price: 0,
            title: tier.name,
            description: commercialWhopPlanDescription(tier),
            visibility: "visible",
            release_method: "buy_now",
            unlimited_stock: true,
          },
          fetchImpl,
        );
    }
    const planId = str(plan.id);
    if (!planId) throw new CommercialWhopError(502, `Whop returned no plan id for ${tier.id}.`);
    const current = Math.round(Number(plan.renewal_price ?? plan.initial_price ?? 0) * 100);
    if (!created && current !== tier.priceCents) {
      repriced = true;
      if (opts.apply)
        await whopApi(
          opts.env,
          "PATCH",
          `/plans/${encodeURIComponent(planId)}`,
          { renewal_price: tier.priceCents / 100 },
          fetchImpl,
        );
    }
    if (opts.apply) await saveTierWhopIds(opts.sql, tier.id, pid, planId);
    results.push({ id: tier.id, planId, created, repriced, priceCents: tier.priceCents });
  }
  return { productId: pid, tiers: results };
}

export async function createCommercialCheckout(opts: {
  env: Env;
  tier: LicenseTierRow;
  checkoutRef: string;
  redirectUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  if (!opts.tier.whopPlanId)
    throw new CommercialWhopError(503, "This tier has not been synced to Whop.");
  const data = await whopApi(
    opts.env,
    "POST",
    "/checkout_configurations",
    {
      plan_id: opts.tier.whopPlanId,
      redirect_url: opts.redirectUrl,
      metadata: {
        infinibot_commercial_tier: opts.tier.id,
        infinibot_license_checkout_ref: opts.checkoutRef,
        // Click-through acceptance record: the agreement version shown beside the Buy button.
        infinibot_license_agreement_version: COMMERCIAL_LICENSE_VERSION,
      },
    },
    opts.fetchImpl ?? fetch,
  );
  const url = str(data.purchase_url) ?? str(data.checkout_url) ?? str(data.url);
  if (!url || !/^https:\/\/([a-z0-9-]+\.)*whop\.com\//i.test(url))
    throw new CommercialWhopError(502, "Whop returned no safe checkout URL.");
  return url;
}

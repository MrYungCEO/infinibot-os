/**
 * Whop as a *payment rail* for agency invoices.
 *
 * Two capabilities, both on Whop's v1 REST API (`https://api.whop.com/api/v1`,
 * `Authorization: Bearer <company API key>`):
 *
 *  1. `POST /checkout_configurations` — creates a reusable hosted checkout and
 *     returns a `purchase_url`. This is the real "create a payment link"
 *     endpoint; it accepts an *inline* plan, so we can charge an arbitrary
 *     invoice amount without the operator pre-creating a product or plan in
 *     the Whop dashboard. Critically it accepts `metadata`, and Whop copies
 *     that metadata onto every payment made through the checkout — which is
 *     what makes reconciliation evidence-based rather than guesswork.
 *  2. `GET /payments` — the same listing `business.income.syncWhop` already
 *     uses, but normalised here for reconciliation instead of the legacy
 *     income store. Payments carry `checkout_configuration_id`, `plan`, and
 *     the inherited `metadata`.
 *
 * The transport is injectable so every path is testable without the network,
 * exactly as `notion-bridge.ts` does for Notion. Nothing in this module logs,
 * returns, or persists the API key.
 */

export const WHOP_PROVIDER = "whop";
const WHOP_API_URL = "https://api.whop.com/api/v1";

/** Metadata keys we stamp onto a checkout so payments can be traced back. */
export const WHOP_INVOICE_ID_KEY = "infinibot_invoice_id";
export const WHOP_LINK_REFERENCE_KEY = "infinibot_link_ref";

export interface WhopTransport {
  request(
    path: string,
    init?: {
      method?: string;
      body?: unknown;
      query?: Record<string, string | number | undefined>;
    },
  ): Promise<any>;
}

export interface WhopCredentials {
  apiKey: string;
  /** Whop account/company id, `biz_…`. Required by both endpoints. */
  companyId: string;
}

/**
 * Real transport. Built per call rather than cached so a rotated key takes
 * effect immediately, and so a revoked key can never linger in a module
 * singleton.
 */
export function createWhopTransport(apiKey: string): WhopTransport {
  const key = apiKey?.trim();
  if (!key) throw new Error("Whop API key not configured");
  return {
    async request(path, init) {
      const url = new URL(`${WHOP_API_URL}${path}`);
      for (const [name, value] of Object.entries(init?.query ?? {})) {
        if (value !== undefined) url.searchParams.set(name, String(value));
      }
      const res = await fetch(url.toString(), {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      let body: any = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { raw: text };
      }
      if (!res.ok) {
        // Whop returns 401/403 for a key without the right scope. Say so:
        // link creation needs a broader scope than reading payments, and an
        // operator with a read-only key needs to be told that, not shown a
        // bare status code.
        const detail =
          typeof body?.error === "string"
            ? body.error
            : typeof body?.message === "string"
              ? body.message
              : text.slice(0, 200).replace(/\s+/g, " ");
        // A 403 here has two quite different causes and the operator cannot
        // tell them apart from Whop's permission list alone: either the key is
        // read-only, or the key is fine but belongs to a DIFFERENT company than
        // the configured company id. Whop issues keys per company, so changing
        // the company id without changing the key produces exactly this error
        // even though the same key worked a minute earlier. Name both.
        const scopeHint =
          res.status === 401 || res.status === 403
            ? " — the Whop API key was rejected for this operation. Either the key lacks checkout/plan write scope (broader than the read scope used for payment sync), or it belongs to a different Whop company than the configured company id: keys are issued per company, so the key and the company id must come from the same one."
            : "";
        throw new Error(
          `Whop API ${res.status} ${res.statusText}: ${detail || "(no body)"}${scopeHint}`,
        );
      }
      return body;
    },
  };
}

// ── Money ──────────────────────────────────────────────────────────────────

/**
 * Whop quotes money in **major units as a decimal number** (`6.9` means
 * $6.90). This store quotes money in **integer hundredths** of the invoice
 * currency. Both conversions live here and nowhere else.
 *
 * The store's convention is uniformly "hundredths", including for currencies
 * ISO calls zero-decimal (JPY, KRW…). We do NOT special-case those: an invoice
 * for ¥1,000 is stored as 100_000 in this database, so scaling by 100 in both
 * directions keeps the invoice and the link in agreement. Cross-currency is
 * never converted — see `normalizeWhopPayment` and the matcher, which refuse
 * on a currency mismatch rather than applying a rate.
 */
export function centsToWhopAmount(cents: number): number {
  if (!Number.isInteger(cents)) throw new Error("amount must be a whole number of cents");
  if (cents <= 0) throw new Error("amount must be greater than zero");
  return Math.round(cents) / 100;
}

/**
 * Major units → integer cents, via the decimal *string* rather than
 * `value * 100`.
 *
 * `6.9 * 100` is `689.9999999999999` in IEEE-754 and `1.005 * 100` is
 * `100.49999999999999` — the latter rounds to 100 instead of the correct 101.
 * Parsing the digits avoids inventing or losing a cent on amounts the
 * float path gets wrong.
 */
export function whopAmountToCents(value: unknown): number {
  const text =
    typeof value === "number"
      ? Number.isFinite(value)
        ? // `toFixed` on a float is itself decimal-correct for the 2-3 dp
          // magnitudes money uses; go through the full-precision string so
          // 1.005 reads as "1.005" and not "1.00".
          String(value)
        : ""
      : typeof value === "string"
        ? value.trim()
        : "";
  if (!text || !/^-?\d*(\.\d+)?([eE][-+]?\d+)?$/.test(text)) {
    throw new Error(`unparseable Whop amount: ${String(value)}`);
  }
  // Normalise exponent notation into plain decimal digits first.
  const plain = text.includes("e") || text.includes("E") ? Number(text).toFixed(10) : text;
  const negative = plain.startsWith("-");
  const [whole, fraction = ""] = plain.replace(/^-/, "").split(".");
  const padded = (fraction + "000").slice(0, 3);
  const thousandths = Number(whole || "0") * 1000 + Number(padded || "0");
  // Round half-up at the cent, on integers, so no float is involved.
  const cents = Math.round(thousandths / 10);
  return negative ? -cents : cents;
}

// ── Checkout link creation ─────────────────────────────────────────────────

export interface WhopCheckoutLink {
  /** Whop checkout configuration id, `ch_…`. */
  id: string;
  /** The URL to send the client to. */
  purchaseUrl: string;
  planId: string | null;
  currency: string;
  /** Amount the link charges, converted back into integer cents. */
  amountCents: number;
}

export interface CreateWhopCheckoutLinkInput {
  companyId: string;
  amountCents: number;
  currency: string;
  /** Customer-visible plan title, e.g. "Invoice INV-0042". */
  title: string;
  description?: string | null;
  /** Correlation token echoed back on every payment through this checkout. */
  reference: string;
  invoiceId: string;
  redirectUrl?: string | null;
  /** Extra metadata merged under ours; our two keys always win. */
  metadata?: Record<string, string>;
}

/**
 * Create a one-time hosted checkout for an invoice amount.
 *
 * Uses an *inline* plan (`plan.plan_type: "one_time"`) with
 * `force_create_new_plan`, so each invoice gets its own plan and a plan id is
 * therefore a per-invoice identifier rather than a shared one. That matters
 * for matching: a reused plan would be ambiguous evidence.
 */
export async function createWhopCheckoutLink(
  transport: WhopTransport,
  input: CreateWhopCheckoutLinkInput,
): Promise<WhopCheckoutLink> {
  const currency = input.currency.trim().toLowerCase() || "usd";
  // `company_id` — NOT `account_id`. Whop reports the failure using its own
  // internal name ("Missing required parameter: account_id"), which made the
  // wrong field name look like the right one. For `mode: "payment"` with an
  // inline plan the id belongs INSIDE `plan`; a top-level `company_id` is
  // accepted only in `mode: "setup"`, so it is not sent here.
  // https://docs.whop.com/api-reference/checkout-configurations/create-checkout-configuration
  const body = {
    mode: "payment",
    metadata: {
      ...input.metadata,
      [WHOP_INVOICE_ID_KEY]: input.invoiceId,
      [WHOP_LINK_REFERENCE_KEY]: input.reference,
    },
    redirect_url: input.redirectUrl ?? undefined,
    plan: {
      company_id: input.companyId,
      plan_type: "one_time",
      initial_price: centsToWhopAmount(input.amountCents),
      currency,
      title: input.title,
      description: input.description ?? undefined,
      visibility: "hidden",
      release_method: "buy_now",
      force_create_new_plan: true,
      // No `metadata` here: Whop's inline-plan schema has no such field and
      // rejects the whole request with "Invalid value for parameter
      // 'plan.metadata'". The correlation token therefore rides ONLY on the
      // checkout's top-level metadata above, which Whop echoes onto the
      // payment (reconciliation Rule A). Rule B — matching the stored
      // checkout-configuration id — remains the independent fallback, so a
      // payment that arrives without metadata is still traceable.
      internal_notes: `InfiniBot invoice ${input.invoiceId} · ref ${input.reference}`,
    },
  };
  const response = await transport.request("/checkout_configurations", { method: "POST", body });
  const id = typeof response?.id === "string" ? response.id : "";
  const purchaseUrl = typeof response?.purchase_url === "string" ? response.purchase_url : "";
  if (!id || !purchaseUrl) {
    throw new Error(
      "Whop accepted the checkout request but returned no purchase_url — the link was not created",
    );
  }
  const planId = typeof response?.plan?.id === "string" ? response.plan.id : null;
  // Trust Whop's echo of the price over our input: if it silently clamped or
  // re-denominated the amount, the invoice must record what will actually be
  // charged, not what we asked for.
  const echoedPrice = response?.plan?.initial_price;
  const amountCents =
    echoedPrice === undefined || echoedPrice === null
      ? input.amountCents
      : whopAmountToCents(echoedPrice);
  return {
    id,
    purchaseUrl,
    planId,
    currency: (typeof response?.plan?.currency === "string"
      ? response.plan.currency
      : currency
    ).toLowerCase(),
    amountCents,
  };
}

/**
 * Best-effort remote teardown. Whop exposes a delete for checkout
 * configurations, but an install whose key lacks the scope — or a
 * configuration Whop has already retired — must not block the local detach.
 */
export async function deleteWhopCheckoutLink(
  transport: WhopTransport,
  checkoutConfigurationId: string,
): Promise<{ deleted: boolean; error?: string }> {
  try {
    await transport.request(
      `/checkout_configurations/${encodeURIComponent(checkoutConfigurationId)}`,
      {
        method: "DELETE",
      },
    );
    return { deleted: true };
  } catch (error) {
    return { deleted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ── Payment listing ────────────────────────────────────────────────────────

/** A Whop payment reduced to the fields reconciliation is allowed to see. */
export interface NormalizedWhopPayment {
  externalId: string;
  amountCents: number;
  currency: string;
  paidAt: number;
  checkoutConfigurationId: string | null;
  planId: string | null;
  /** Merged payment metadata, with plan metadata as the fallback layer. */
  metadata: Record<string, string>;
  customerName: string | null;
  customerEmail: string | null;
  productTitle: string | null;
}

/** Whop status strings that mean "the money actually arrived". */
const SETTLED_STATUSES = new Set([
  "paid",
  "succeeded",
  "success",
  "successful",
  "completed",
  "captured",
]);

function coerceTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Whop has returned both seconds and milliseconds over its API's life.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") out[key] = raw;
    else if (typeof raw === "number" || typeof raw === "boolean") out[key] = String(raw);
  }
  return out;
}

/**
 * Reduce one raw Whop payment. Returns null for anything that is not a
 * settled, positively-valued payment we can date — an unsettled or refunded
 * row must never become revenue.
 */
export function normalizeWhopPayment(raw: unknown): NormalizedWhopPayment | null {
  if (!raw || typeof raw !== "object") return null;
  const payment = raw as Record<string, any>;
  // Whop has spelled "this settled" as `status`, `substatus` and (on older v1
  // responses) `final_status`. Accept a settled label in any of them; a row
  // where none of them says settled is not money we have.
  const settled = [payment.status, payment.substatus, payment.final_status].some(
    (value) => typeof value === "string" && SETTLED_STATUSES.has(value.toLowerCase()),
  );
  if (!settled) return null;
  const externalId = typeof payment.id === "string" ? payment.id : "";
  if (!externalId) return null;
  const paidAt = coerceTimestamp(payment.paid_at ?? payment.created_at ?? payment.updated_at);
  if (paidAt === null) return null;
  // `total` is the gross charged in the payment's own currency. `final_amount`
  // and `amount` are the older v1 spellings; keep accepting them.
  const amountRaw = payment.total ?? payment.final_amount ?? payment.amount ?? payment.subtotal;
  let amountCents: number;
  try {
    amountCents = whopAmountToCents(amountRaw);
  } catch {
    return null;
  }
  if (amountCents <= 0) return null;
  const currency = String(payment.currency ?? "")
    .trim()
    .toLowerCase();
  if (!currency) return null;
  return {
    externalId,
    amountCents,
    currency,
    paidAt,
    checkoutConfigurationId:
      typeof payment.checkout_configuration_id === "string"
        ? payment.checkout_configuration_id
        : null,
    planId: typeof payment.plan?.id === "string" ? payment.plan.id : null,
    // Payment metadata is inherited from the checkout configuration; plan
    // metadata is the weaker fallback and must not overwrite it.
    metadata: { ...stringMap(payment.plan?.metadata), ...stringMap(payment.metadata) },
    customerName:
      typeof payment.user?.name === "string"
        ? payment.user.name
        : typeof payment.user?.username === "string"
          ? payment.user.username
          : null,
    customerEmail: typeof payment.user?.email === "string" ? payment.user.email : null,
    productTitle: typeof payment.product?.title === "string" ? payment.product.title : null,
  };
}

/**
 * Drain `GET /payments` for a company. `since` is an ISO timestamp passed as
 * `created_after`; omitting it pulls the full history.
 *
 * Whop v1 uses CURSOR pagination via a top-level `page_info` object
 * (`{ data: [...], page_info: { end_cursor, has_next_page } }`); you advance
 * with `?after=<end_cursor>`. The `page` query param does NOT advance — it
 * re-returns the same records — so we drive the loop off `page_info`. Hard-
 * capped so an upstream pagination bug cannot spin forever — the same defence
 * `business.income.syncWhop` uses.
 */
export async function listWhopPayments(
  transport: WhopTransport,
  input: { companyId: string; since?: string; perPage?: number; maxPages?: number },
): Promise<NormalizedWhopPayment[]> {
  const perPage = input.perPage ?? 100;
  const maxPages = input.maxPages ?? 2000;
  const out: NormalizedWhopPayment[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await transport.request("/payments", {
      query: {
        company_id: input.companyId,
        created_after: input.since,
        per_page: perPage,
        after,
      },
    });
    const list: unknown[] = Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response)
        ? response
        : [];
    for (const raw of list) {
      const normalized = normalizeWhopPayment(raw);
      // A payment repeated across pages (Whop's pagination has drifted before)
      // is collapsed here, so reconciliation counts it once.
      if (normalized && !seen.has(normalized.externalId)) {
        seen.add(normalized.externalId);
        out.push(normalized);
      }
    }
    // Advance via the cursor; stop when Whop says there is no next page, hands
    // back no cursor, or returns an empty page.
    const pageInfo = response?.page_info as
      | { end_cursor?: string | null; has_next_page?: boolean }
      | undefined;
    const endCursor = pageInfo?.end_cursor;
    const hasMore = pageInfo?.has_next_page === true && !!endCursor && list.length > 0;
    if (!hasMore) {
      if (page >= maxPages && pageInfo?.has_next_page === true) {
        console.warn(
          `[whop-payments] hit maxPages (${maxPages}) with more pages remaining — some payments may be missing`,
        );
      }
      break;
    }
    after = endCursor as string;
  }
  return out;
}

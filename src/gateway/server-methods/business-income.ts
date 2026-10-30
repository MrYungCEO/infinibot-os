/**
 * Business Income Gateway Methods
 * Handles income tracking, Notion sync, Whop & Stripe integration
 */

import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveStateDir } from "../../config/paths.js";
import { getNotionConfig } from "../../databases/notion-config.js";
import {
  readBusinessAgencyProviderKey,
  readBusinessAgencySetting,
} from "../../business-agency/runtime.js";

// Types
interface IncomeEntry {
  id: string;
  amount: number;
  source: string;
  description: string;
  streamId?: string;
  date: string;
  createdAt: string;
  notionId?: string;
  metadata?: Record<string, unknown>;
  /** Business this entry belongs to. Legacy entries lack one. */
  businessId?: string;
}

interface IncomeStream {
  id: string;
  name: string;
  type: string;
  source: string;
  expectedMonthly?: number;
  isActive: boolean;
  notionId?: string;
  webhookUrl?: string;
  apiKeyRef?: string;
  createdAt: string;
  businessId?: string;
}

interface ProviderKeys {
  whop?: string;
  /** Whop company id (e.g. `biz_xxxxxxxxxxx`). Required for the v1 payments listing. */
  whopCompanyId?: string;
  stripe?: string;
  square?: string;
  /** Square's "production" or "sandbox" API host. */
  squareEnv?: "production" | "sandbox";
}

interface BusinessIncomeBucket {
  apiKeys?: ProviderKeys;
  lastWhopSync?: string;
  lastStripeSync?: string;
  lastSquareSync?: string;
}

interface IncomeStore {
  entries: IncomeEntry[];
  streams: IncomeStream[];
  /**
   * Per-business buckets. Each business has its own provider keys and
   * sync cursors so revenue from different businesses doesn't bleed
   * together when keys are swapped.
   */
  businesses?: Record<string, BusinessIncomeBucket>;
  // ── Legacy top-level fields (pre per-business migration) ──
  lastWhopSync?: string;
  lastStripeSync?: string;
  lastSquareSync?: string;
  apiKeys?: ProviderKeys;
}

// Get state directory
/**
 * The canonical per-user state dir.
 *
 * This used to be `process.env.INFINIBOT_STATE_DIR || "state"`, which resolved
 * to a repo-local `<cwd>/state/` whenever the env var was unset — i.e. almost
 * always. Provider credentials saved from the UI landed in a directory nothing
 * else reads, so `resolveWhopCredentials()` kept reporting "Whop API key not
 * configured" no matter how many times the key was entered. Same class of bug
 * the databases store already carries a warning about.
 */
function getStateDir(): string {
  return resolveStateDir();
}

/**
 * Where the pre-fix build wrote the income store. Read once, on demand, so an
 * install that already has keys there keeps them: the first save after this
 * change rewrites the store at the canonical path.
 */
function legacyStorePath(): string {
  return resolve(process.env.INFINIBOT_STATE_DIR || "state", "business", "income.json");
}

// Get store path
function getStorePath(): string {
  const dir = resolve(getStateDir(), "business");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return resolve(dir, "income.json");
}

// Load store
function loadStore(): IncomeStore {
  const path = getStorePath();
  let raw: IncomeStore = { entries: [], streams: [] };
  // Canonical location first, then the pre-fix repo-local one, so upgrading
  // never looks like the operator's saved keys and income history vanished.
  const source = existsSync(path) ? path : existsSync(legacyStorePath()) ? legacyStorePath() : null;
  if (source) {
    try {
      raw = JSON.parse(readFileSync(source, "utf-8"));
    } catch {
      raw = { entries: [], streams: [] };
    }
  }
  return migrate(raw);
}

// Save store
function saveStore(store: IncomeStore): void {
  const path = getStorePath();
  writeFileSync(path, JSON.stringify(store, null, 2));
}

/**
 * Read the active business id from the canonical business state file.
 * Income lives in its own file but follows the user's active selection
 * so a get/set without an explicit `businessId` targets the right bucket.
 */
function loadActiveBusinessId(): string | null {
  try {
    const p = resolve(getStateDir(), "business.json");
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    const active = raw?.activeBusinessId;
    if (typeof active === "string" && active) return active;
    const first = Array.isArray(raw?.businesses) ? raw.businesses[0]?.id : null;
    return typeof first === "string" ? first : null;
  } catch {
    return null;
  }
}

/** Resolve the businessId for a request: explicit param > active > "default". */
function resolveBusinessId(params: unknown): string {
  const fromParam = (params as { businessId?: unknown } | null | undefined)?.businessId;
  if (typeof fromParam === "string" && fromParam.trim()) return fromParam.trim();
  return loadActiveBusinessId() ?? "default";
}

/** Get the per-business bucket, creating it if missing. */
function getBucket(store: IncomeStore, businessId: string): BusinessIncomeBucket {
  if (!store.businesses) store.businesses = {};
  if (!store.businesses[businessId]) store.businesses[businessId] = {};
  return store.businesses[businessId];
}

/**
 * Migrate legacy top-level apiKeys + sync cursors into a per-business
 * bucket so the new code path can rely on `store.businesses` always
 * being populated. Legacy entries are folded into whichever business
 * is currently active (or "default" if none exists yet).
 */
function migrate(store: IncomeStore): IncomeStore {
  if (!store.entries) store.entries = [];
  if (!store.streams) store.streams = [];
  if (!store.businesses) store.businesses = {};

  const hasLegacy =
    store.apiKeys || store.lastWhopSync || store.lastStripeSync || store.lastSquareSync;
  if (hasLegacy) {
    const targetId = loadActiveBusinessId() ?? "default";
    const bucket = getBucket(store, targetId);
    if (store.apiKeys && !bucket.apiKeys) bucket.apiKeys = store.apiKeys;
    if (store.lastWhopSync && !bucket.lastWhopSync) bucket.lastWhopSync = store.lastWhopSync;
    if (store.lastStripeSync && !bucket.lastStripeSync)
      bucket.lastStripeSync = store.lastStripeSync;
    if (store.lastSquareSync && !bucket.lastSquareSync)
      bucket.lastSquareSync = store.lastSquareSync;
    delete store.apiKeys;
    delete store.lastWhopSync;
    delete store.lastStripeSync;
    delete store.lastSquareSync;
  }
  return store;
}

// Generate ID
function generateId(): string {
  return `inc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Calculate stats
function calculateStats(entries: IncomeEntry[]) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const yearStart = new Date(now.getFullYear(), 0, 1).getTime();

  let today = 0,
    week = 0,
    month = 0,
    year = 0,
    allTime = 0;

  for (const entry of entries) {
    const entryTime = new Date(entry.date).getTime();
    const amount = entry.amount;

    allTime += amount;
    if (entryTime >= yearStart) year += amount;
    if (entryTime >= monthStart) month += amount;
    if (entryTime >= weekStart) week += amount;
    if (entryTime >= todayStart) today += amount;
  }

  return { today, week, month, year, allTime };
}

// Get daily data for chart
function getDailyData(entries: IncomeEntry[], days = 30) {
  const now = new Date();
  const data: { date: string; amount: number; label: string }[] = [];

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0];
    const label = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    const dayTotal = entries
      .filter((e) => e.date.startsWith(dateStr))
      .reduce((sum, e) => sum + e.amount, 0);

    data.push({ date: dateStr, amount: dayTotal, label });
  }

  return data;
}

// Get monthly data for chart
function getMonthlyData(entries: IncomeEntry[], months = 6) {
  const now = new Date();
  const data: { month: string; amount: number; label: string }[] = [];

  for (let i = months - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthStr = date.toISOString().slice(0, 7);
    const label = date.toLocaleDateString("en-US", { month: "short" });

    const monthTotal = entries
      .filter((e) => e.date.startsWith(monthStr))
      .reduce((sum, e) => sum + e.amount, 0);

    data.push({ month: monthStr, amount: monthTotal, label });
  }

  return data;
}

// Notion sync helper
async function syncEntryToNotion(
  entry: IncomeEntry,
  notionApiKey: string,
  databaseId: string,
): Promise<string | null> {
  try {
    const response = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionApiKey}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties: {
          Name: {
            title: [{ text: { content: entry.description || `Income - ${entry.source}` } }],
          },
          Amount: { number: entry.amount },
          Source: { select: { name: entry.source } },
          Date: { date: { start: entry.date.split("T")[0] } },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (response.ok) {
      const data = await response.json();
      return data.id;
    }
    console.error("Notion sync failed:", await response.text());
    return null;
  } catch (err) {
    console.error("Notion sync error:", err);
    return null;
  }
}

// Whop API sync
//
// Whop's current public REST API is at https://api.whop.com/api/v1/payments
// and requires a `company_id` query parameter. The previously-used v2 path
// returns 404 silently, which is why syncs produced "+0 new (of 0)" forever.
async function syncFromWhop(
  apiKey: string,
  lastSync?: string,
  companyId?: string,
): Promise<{ transactions: IncomeEntry[]; newLastSync: string; error?: string; ok: boolean }> {
  const transactions: IncomeEntry[] = [];
  const startedAt = new Date().toISOString();

  try {
    // Paginate through every page of the v1 payments endpoint so an "all-time"
    // sync actually adds up. Whop v1 uses CURSOR pagination via a top-level
    // `page_info` object: `{ data: [...], page_info: { end_cursor, has_next_page } }`.
    // You advance with `?after=<end_cursor>`; the `page` query param does NOT
    // advance (every page returns the same 100 records), so we drive the loop
    // purely off `page_info`. A hard cap defends against an upstream bug.
    const PER_PAGE = 100;
    const MAX_PAGES = 2000; // 200k transactions hard ceiling
    let page = 0;
    let after: string | undefined;
    const aggregatedList: Record<string, unknown>[] = [];

    while (page < MAX_PAGES) {
      page += 1;
      const url = new URL("https://api.whop.com/api/v1/payments");
      if (companyId) url.searchParams.set("company_id", companyId);
      if (lastSync) url.searchParams.set("created_after", lastSync);
      url.searchParams.set("per_page", String(PER_PAGE));
      if (after) url.searchParams.set("after", after);

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        const snippet = bodyText.slice(0, 240).replace(/\s+/g, " ");
        return {
          transactions,
          // Don't advance the cursor on failure — keep `lastSync` so a fix can backfill.
          newLastSync: lastSync || "",
          error: `Whop API ${response.status} ${response.statusText} (page ${page}): ${snippet || "(no body)"}`,
          ok: false,
        };
      }

      const data = (await response.json()) as Record<string, unknown>;
      // Whop v1 returns { data: [...] } or sometimes a bare array; accept either.
      const list = Array.isArray((data as Record<string, unknown>).data)
        ? (data as { data: Record<string, unknown>[] }).data
        : Array.isArray(data as unknown as Record<string, unknown>[])
          ? (data as unknown as Record<string, unknown>[])
          : [];

      aggregatedList.push(...list);

      // Advance via the cursor. Stop when Whop says there is no next page, when
      // it fails to hand back a cursor, or when the page came back empty.
      const pageInfo = (data as Record<string, unknown>).page_info as
        | { end_cursor?: string | null; has_next_page?: boolean }
        | undefined;
      const endCursor = pageInfo?.end_cursor;
      const hasMore = pageInfo?.has_next_page === true && !!endCursor && list.length > 0;

      if (!hasMore) break;
      after = endCursor as string;

      if (page >= MAX_PAGES) {
        console.warn(
          `[whop-sync] hit MAX_PAGES (${MAX_PAGES}) with more pages remaining — some payments may be missing`,
        );
      }
    }

    for (const payment of aggregatedList) {
      // Status field is `status` on most responses but some sources expose `final_status`.
      const status = String(
        (payment as Record<string, unknown>).status ??
          (payment as Record<string, unknown>).final_status ??
          "",
      ).toLowerCase();
      // Accept the broad set of "money received" labels Whop has used over time.
      const isPaid =
        status === "paid" ||
        status === "succeeded" ||
        status === "success" ||
        status === "successful" ||
        status === "completed" ||
        status === "captured";
      if (!isPaid) continue;

      const idRaw = String(
        (payment as Record<string, unknown>).id ??
          (payment as Record<string, unknown>).receipt_id ??
          "",
      );
      if (!idRaw) continue;

      // Whop reports amounts in major currency units (dollars) on v1 — cast and
      // trust. `total` is the gross charged; `amount`/`final_amount` are the
      // older v1 spellings and are null on current responses, so prefer `total`.
      const amountRaw =
        (payment as Record<string, unknown>).total ??
        (payment as Record<string, unknown>).final_amount ??
        (payment as Record<string, unknown>).amount ??
        0;
      const amount = typeof amountRaw === "number" ? amountRaw : parseFloat(String(amountRaw)) || 0;

      const createdAtRaw =
        (payment as Record<string, unknown>).created_at ??
        (payment as Record<string, unknown>).paid_at ??
        (payment as Record<string, unknown>).updated_at;
      // Whop sometimes returns unix seconds — coerce.
      let dateIso: string;
      if (typeof createdAtRaw === "number")
        dateIso = new Date(createdAtRaw * (createdAtRaw < 1e12 ? 1000 : 1)).toISOString();
      else if (typeof createdAtRaw === "string" && createdAtRaw)
        dateIso = new Date(createdAtRaw).toISOString();
      else dateIso = startedAt;

      transactions.push({
        id: `whop_${idRaw}`,
        amount,
        source: "whop",
        description: String(
          (payment as Record<string, unknown>).product_name ??
            (payment as Record<string, unknown>).plan_name ??
            (payment as Record<string, unknown>).description ??
            "Whop Payment",
        ),
        date: dateIso,
        createdAt: startedAt,
        metadata: {
          whopId: idRaw,
          customerId:
            (payment as Record<string, unknown>).user_id ??
            (payment as Record<string, unknown>).user ??
            null,
          productId:
            (payment as Record<string, unknown>).product_id ??
            (payment as Record<string, unknown>).plan_id ??
            null,
          companyId: (payment as Record<string, unknown>).company_id ?? companyId ?? null,
          currency: (payment as Record<string, unknown>).currency ?? null,
          rawStatus: status,
        },
      });
    }

    return { transactions, newLastSync: startedAt, ok: true };
  } catch (err) {
    return {
      transactions,
      newLastSync: lastSync || "",
      error: `Whop sync exception: ${err instanceof Error ? err.message : String(err)}`,
      ok: false,
    };
  }
}

// Stripe API sync
async function syncFromStripe(
  apiKey: string,
  lastSync?: string,
): Promise<{ transactions: IncomeEntry[]; newLastSync: string }> {
  const transactions: IncomeEntry[] = [];
  const newLastSync = new Date().toISOString();

  try {
    // Stripe API endpoint for charges
    const url = new URL("https://api.stripe.com/v1/charges");
    url.searchParams.set("limit", "100");
    if (lastSync) {
      url.searchParams.set("created[gt]", String(Math.floor(new Date(lastSync).getTime() / 1000)));
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (response.ok) {
      const data = await response.json();
      for (const charge of data.data || []) {
        if (charge.paid && charge.status === "succeeded") {
          transactions.push({
            id: `stripe_${charge.id}`,
            amount: (charge.amount || 0) / 100, // Convert cents to dollars
            source: "stripe",
            description: charge.description || "Stripe Payment",
            date: new Date(charge.created * 1000).toISOString(),
            createdAt: new Date().toISOString(),
            metadata: {
              stripeId: charge.id,
              customerId: charge.customer,
              receiptUrl: charge.receipt_url,
            },
          });
        }
      }
    }
  } catch (err) {
    console.error("Stripe sync error:", err);
  }

  return { transactions, newLastSync };
}

// Square API sync — Payments API v2.
// Square's API key model is per-merchant and supports both production and
// sandbox hosts. The user can pin which one via `apiKeys.squareEnv`.
async function syncFromSquare(
  apiKey: string,
  env: "production" | "sandbox" = "production",
  lastSync?: string,
): Promise<{ transactions: IncomeEntry[]; newLastSync: string }> {
  const transactions: IncomeEntry[] = [];
  const newLastSync = new Date().toISOString();

  try {
    const host =
      env === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
    const url = new URL(`${host}/v2/payments`);
    if (lastSync) url.searchParams.set("begin_time", lastSync);
    url.searchParams.set("limit", "100");
    url.searchParams.set("sort_order", "DESC");

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Square-Version": "2024-12-18",
      },
    });

    if (response.ok) {
      const data = (await response.json()) as { payments?: Array<Record<string, unknown>> };
      for (const payment of data.payments ?? []) {
        const status = (payment.status as string | undefined) ?? "";
        if (status !== "COMPLETED" && status !== "APPROVED") continue;
        const amountMoney = payment.amount_money as
          | { amount?: number; currency?: string }
          | undefined;
        const amount = (amountMoney?.amount ?? 0) / 100; // cents → dollars
        if (amount <= 0) continue;
        const created = (payment.created_at as string | undefined) ?? new Date().toISOString();
        const note =
          (payment.note as string | undefined) ??
          (payment.statement_description_identifier as string | undefined) ??
          "Square payment";
        transactions.push({
          id: `square_${payment.id ?? Math.random().toString(36).slice(2)}`,
          amount,
          source: "square",
          description: note,
          date: created,
          createdAt: new Date().toISOString(),
          metadata: {
            squareId: payment.id,
            customerId: payment.customer_id,
            currency: amountMoney?.currency,
            receiptUrl: payment.receipt_url,
          },
        });
      }
    } else {
      console.error("Square sync failed:", response.status, await response.text().catch(() => ""));
    }
  } catch (err) {
    console.error("Square sync error:", err);
  }

  return { transactions, newLastSync };
}

/** Resolve an API key from the per-business bucket first, falling back to env. */
function resolveProviderKey(
  bucket: BusinessIncomeBucket,
  provider: "whop" | "stripe" | "square",
): string | null {
  const stored = bucket.apiKeys?.[provider];
  if (stored && stored.trim()) return stored.trim();
  // Business & Agency plugin setting (write-only, Setup › Plugins).
  const setting = readBusinessAgencyProviderKey(provider);
  if (setting) return setting;
  const envName =
    provider === "whop"
      ? "WHOP_API_KEY"
      : provider === "stripe"
        ? "STRIPE_API_KEY"
        : "SQUARE_API_KEY";
  const env = process.env[envName];
  return env && env.trim() ? env.trim() : null;
}

/**
 * The single place Whop credentials are resolved, shared with the agency
 * invoicing/reconciliation handlers so there is exactly one answer to "which
 * Whop account is this install talking to".
 *
 * Precedence matches `business.income.syncWhop`: explicit param, then the
 * per-business bucket, then the environment. Returns a discriminated result
 * rather than throwing, so callers can render the actionable NOT_CONFIGURED
 * message instead of a stack trace. **The returned key is never logged,
 * echoed in an RPC response, or written to agency.db.**
 */
export function resolveWhopCredentials(overrides?: {
  businessId?: unknown;
  companyId?: unknown;
}): { ok: true; apiKey: string; companyId: string } | { ok: false; message: string } {
  const store = loadStore();
  const bucket = getBucket(store, resolveBusinessId(overrides));
  const apiKey = resolveProviderKey(bucket, "whop");
  if (!apiKey) {
    return {
      ok: false,
      message:
        "Whop API key not configured — save your Whop API key in the income provider settings or set WHOP_API_KEY in the env.",
    };
  }
  const explicit =
    typeof overrides?.companyId === "string" && overrides.companyId.trim()
      ? overrides.companyId.trim()
      : null;
  const companyId =
    explicit ??
    (bucket.apiKeys?.whopCompanyId?.trim() || null) ??
    readBusinessAgencySetting("whopCompanyId") ??
    (process.env.WHOP_COMPANY_ID?.trim() || null);
  if (!companyId) {
    return {
      ok: false,
      message:
        "Whop company id missing — save your Whop company id (e.g. biz_xxxxxxxx) in the income provider settings, set WHOP_COMPANY_ID in the env, or pass `companyId` in the call.",
    };
  }
  return { ok: true, apiKey, companyId };
}

/* ------------------------------------------------------------------ *
 * Local payment-provider credentials
 * ------------------------------------------------------------------ */

/**
 * Masked status of the payment credentials THIS node will use.
 *
 * `business.*` is proxied to master on a satellite, so the Business page's
 * income settings read and write master's store. Invoice payment links are
 * created by `agency.ops.*`, which is NOT proxied and therefore resolves
 * credentials from the LOCAL store — the two never met, and a key saved in the
 * UI could not make `paymentLink.create` work. These helpers back the
 * `agency.ops.payments.provider.*` RPCs so the credential can be set on the
 * node that actually spends it.
 *
 * Never returns raw key material — only a `••••1234` tail, same as
 * `business.income.config.get`.
 */
export function readLocalPaymentProviderStatus(businessId?: string): {
  businessId: string;
  whop: { configured: boolean; hint: string | null; fromEnv: boolean };
  whopCompanyId: string | null;
  storePath: string;
} {
  const store = loadStore();
  const id = resolveBusinessId({ businessId });
  const bucket = getBucket(store, id);
  const stored = bucket.apiKeys?.whop?.trim() || readBusinessAgencyProviderKey("whop") || "";
  const env = process.env.WHOP_API_KEY?.trim() || "";
  const effective = stored || env;
  return {
    businessId: id,
    whop: {
      configured: effective.length > 0,
      hint: effective.length >= 4 ? `••••${effective.slice(-4)}` : null,
      fromEnv: !stored && env.length > 0,
    },
    whopCompanyId:
      bucket.apiKeys?.whopCompanyId?.trim() ||
      readBusinessAgencySetting("whopCompanyId") ||
      process.env.WHOP_COMPANY_ID?.trim() ||
      null,
    storePath: getStorePath(),
  };
}

/**
 * Persist payment credentials to the local store.
 *
 * `undefined` leaves a field untouched so the company id can be added without
 * re-typing the key; an empty string clears it.
 */
export function writeLocalPaymentProviderCredentials(input: {
  businessId?: string;
  whop?: string;
  whopCompanyId?: string;
}): { businessId: string } {
  const store = loadStore();
  const id = resolveBusinessId({ businessId: input.businessId });
  const bucket = getBucket(store, id);
  const next: ProviderKeys = { ...bucket.apiKeys };
  if (input.whop !== undefined) {
    const v = input.whop.trim();
    if (v) next.whop = v;
    else delete next.whop;
  }
  if (input.whopCompanyId !== undefined) {
    const v = input.whopCompanyId.trim();
    if (v) next.whopCompanyId = v;
    else delete next.whopCompanyId;
  }
  bucket.apiKeys = next;
  saveStore(store);
  return { businessId: id };
}

/** Filter entries by business when an id is given; legacy untagged entries fall through. */
function entriesForBusiness(entries: IncomeEntry[], businessId: string | null): IncomeEntry[] {
  if (!businessId) return entries;
  return entries.filter((e) => !e.businessId || e.businessId === businessId);
}

// ── Handlers ─────────────────────────────────────────────────

export const businessIncomeHandlers: GatewayRequestHandlers = {
  /** Get income stats — scoped to active or requested business. */
  "business.income.stats": async ({ params, respond }) => {
    try {
      const store = loadStore();
      const businessId = resolveBusinessId(params);
      const scoped = entriesForBusiness(store.entries, businessId);
      const stats = calculateStats(scoped);
      const dailyData = getDailyData(scoped, 30);
      const monthlyData = getMonthlyData(scoped, 6);

      const recentTransactions = [...scoped]
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, 20);

      const scopedStreams = store.streams.filter(
        (s) => !s.businessId || s.businessId === businessId,
      );

      respond(true, {
        ...stats,
        businessId,
        recentTransactions,
        incomeStreams: scopedStreams,
        dailyData,
        monthlyData,
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Log income entry */
  "business.income.log": async ({ params, respond }) => {
    try {
      const amount = params?.amount as number | undefined;
      const source = params?.source as string | undefined;
      const description = params?.description as string | undefined;
      const streamId = params?.streamId as string | undefined;
      const date = params?.date as string | undefined;
      const metadata = params?.metadata as Record<string, unknown> | undefined;
      const syncToNotion = params?.syncToNotion as boolean | undefined;

      if (!amount || amount <= 0) {
        return respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "Amount must be positive",
        });
      }

      const store = loadStore();
      const businessId = resolveBusinessId(params);

      const entry: IncomeEntry = {
        id: generateId(),
        amount,
        source: source || "other",
        description: description || "",
        streamId,
        date: date || new Date().toISOString(),
        createdAt: new Date().toISOString(),
        metadata,
        businessId,
      };

      // Save locally first — the local store is the source of truth.
      store.entries.push(entry);
      saveStore(store);

      // Optional Notion mirror, in the background: a missing income DB or a
      // slow/erroring Notion must never fail or delay logging income.
      if (syncToNotion) {
        const notionKey = process.env.NOTION_API_KEY;
        const incomeStreamsDbId = getNotionConfig().incomeStreamsDbId;
        if (notionKey && incomeStreamsDbId) {
          void syncEntryToNotion(entry, notionKey, incomeStreamsDbId).then((notionId) => {
            if (!notionId) return;
            try {
              const fresh = loadStore();
              const saved = fresh.entries.find((e) => e.id === entry.id);
              if (saved) {
                saved.notionId = notionId;
                saveStore(fresh);
              }
            } catch {
              /* the mirror id is a nice-to-have */
            }
          });
        } else if (notionKey && !incomeStreamsDbId) {
          console.warn("[income] Notion sync requested but notion.incomeStreamsDbId is not set");
        }
      }

      respond(true, { entry });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Sync from Whop — uses the active business's keys + cursor. */
  "business.income.syncWhop": async ({ params, respond }) => {
    try {
      const store = loadStore();
      const businessId = resolveBusinessId(params);
      const bucket = getBucket(store, businessId);
      const whopKey = resolveProviderKey(bucket, "whop");

      if (!whopKey) {
        return respond(false, undefined, {
          code: "NOT_CONFIGURED",
          message: "Whop API key not configured",
        });
      }

      // Whop v1 listing requires a company id. Allow override via params, then bucket, then env.
      const companyId =
        typeof params?.companyId === "string" && params.companyId.trim()
          ? (params.companyId as string).trim()
          : bucket.apiKeys?.whopCompanyId && bucket.apiKeys.whopCompanyId.trim()
            ? bucket.apiKeys.whopCompanyId.trim()
            : process.env.WHOP_COMPANY_ID && process.env.WHOP_COMPANY_ID.trim()
              ? process.env.WHOP_COMPANY_ID.trim()
              : undefined;

      if (!companyId) {
        return respond(false, undefined, {
          code: "NOT_CONFIGURED",
          message:
            "Whop company id missing — save your Whop company id (e.g. biz_xxxxxxxx) in the income provider settings, set WHOP_COMPANY_ID in the env, or pass `companyId` in the call.",
        });
      }

      const result = await syncFromWhop(whopKey, bucket.lastWhopSync, companyId);

      if (!result.ok) {
        // Surface the error so the UI shows what's actually wrong (401, 404, network, etc.)
        return respond(false, undefined, {
          code: "WHOP_API_ERROR",
          message: result.error || "Whop sync failed without a status code",
        });
      }

      const existingIds = new Set(store.entries.map((e) => e.id));
      let added = 0;
      for (const tx of result.transactions) {
        if (!existingIds.has(tx.id)) {
          store.entries.push({ ...tx, businessId });
          added++;
        }
      }

      // Only advance the cursor when the sync actually succeeded.
      bucket.lastWhopSync = result.newLastSync || bucket.lastWhopSync;
      saveStore(store);

      respond(true, { added, total: result.transactions.length, businessId });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Reset the Whop sync cursor so a future sync re-pulls the full history. */
  "business.income.resetWhopCursor": async ({ params, respond }) => {
    try {
      const store = loadStore();
      const businessId = resolveBusinessId(params);
      const bucket = getBucket(store, businessId);
      delete bucket.lastWhopSync;
      saveStore(store);
      respond(true, { businessId });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Sync from Stripe — uses the active business's keys + cursor. */
  "business.income.syncStripe": async ({ params, respond }) => {
    try {
      const store = loadStore();
      const businessId = resolveBusinessId(params);
      const bucket = getBucket(store, businessId);
      const stripeKey = resolveProviderKey(bucket, "stripe");

      if (!stripeKey) {
        return respond(false, undefined, {
          code: "NOT_CONFIGURED",
          message: "Stripe API key not configured",
        });
      }

      const { transactions, newLastSync } = await syncFromStripe(stripeKey, bucket.lastStripeSync);

      const existingIds = new Set(store.entries.map((e) => e.id));
      let added = 0;
      for (const tx of transactions) {
        if (!existingIds.has(tx.id)) {
          store.entries.push({ ...tx, businessId });
          added++;
        }
      }

      bucket.lastStripeSync = newLastSync;
      saveStore(store);

      respond(true, { added, total: transactions.length, businessId });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Sync from Square — uses the active business's keys + cursor. */
  "business.income.syncSquare": async ({ params, respond }) => {
    try {
      const store = loadStore();
      const businessId = resolveBusinessId(params);
      const bucket = getBucket(store, businessId);
      const squareKey = resolveProviderKey(bucket, "square");

      if (!squareKey) {
        return respond(false, undefined, {
          code: "NOT_CONFIGURED",
          message: "Square API key not configured",
        });
      }

      const env = bucket.apiKeys?.squareEnv ?? "production";
      const { transactions, newLastSync } = await syncFromSquare(
        squareKey,
        env,
        bucket.lastSquareSync,
      );

      const existingIds = new Set(store.entries.map((e) => e.id));
      let added = 0;
      for (const tx of transactions) {
        if (!existingIds.has(tx.id)) {
          store.entries.push({ ...tx, businessId });
          added++;
        }
      }

      bucket.lastSquareSync = newLastSync;
      saveStore(store);

      respond(true, { added, total: transactions.length, businessId });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Read provider-key + env config so the UI can show whether each
   * integration is configured. Never returns the key value itself —
   * just a boolean `configured` flag plus a non-secret hint (last 4
   * chars of the key). Scoped to the active or requested business.
   */
  "business.income.config.get": async ({ params, respond }) => {
    try {
      const store = loadStore();
      const businessId = resolveBusinessId(params);
      const bucket = getBucket(store, businessId);
      const summarize = (v?: string) => ({
        configured: !!v && v.trim().length > 0,
        hint: v && v.trim().length >= 4 ? `••••${v.trim().slice(-4)}` : null,
      });
      respond(true, {
        businessId,
        whop: summarize(bucket.apiKeys?.whop ?? process.env.WHOP_API_KEY),
        whopCompanyId: bucket.apiKeys?.whopCompanyId ?? process.env.WHOP_COMPANY_ID ?? null,
        stripe: summarize(bucket.apiKeys?.stripe ?? process.env.STRIPE_API_KEY),
        square: summarize(bucket.apiKeys?.square ?? process.env.SQUARE_API_KEY),
        squareEnv: bucket.apiKeys?.squareEnv ?? "production",
        lastSync: {
          whop: bucket.lastWhopSync ?? null,
          stripe: bucket.lastStripeSync ?? null,
          square: bucket.lastSquareSync ?? null,
        },
      });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /**
   * Persist provider keys + Square env for the active or requested
   * business. Pass an empty string to clear; `undefined` keeps the
   * existing value so the UI can update one field at a time.
   */
  "business.income.config.set": async ({ params, respond }) => {
    try {
      const p = (params ?? {}) as {
        businessId?: string;
        whop?: string;
        whopCompanyId?: string;
        stripe?: string;
        square?: string;
        squareEnv?: "production" | "sandbox";
      };
      const store = loadStore();
      const businessId = resolveBusinessId(p);
      const bucket = getBucket(store, businessId);
      const next: ProviderKeys = { ...bucket.apiKeys };
      const trim = (v: string | undefined) => (typeof v === "string" ? v.trim() : undefined);
      if (p.whop !== undefined) {
        const v = trim(p.whop);
        if (v) next.whop = v;
        else delete next.whop;
      }
      if (p.whopCompanyId !== undefined) {
        const v = trim(p.whopCompanyId);
        if (v) next.whopCompanyId = v;
        else delete next.whopCompanyId;
      }
      if (p.stripe !== undefined) {
        const v = trim(p.stripe);
        if (v) next.stripe = v;
        else delete next.stripe;
      }
      if (p.square !== undefined) {
        const v = trim(p.square);
        if (v) next.square = v;
        else delete next.square;
      }
      if (p.squareEnv === "production" || p.squareEnv === "sandbox") {
        next.squareEnv = p.squareEnv;
      }
      bucket.apiKeys = next;
      saveStore(store);
      respond(true, { ok: true, businessId });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Upsert income stream */
  "business.income.upsertStream": async ({ params, respond }) => {
    try {
      const id = params?.id as string | undefined;
      const name = params?.name as string | undefined;
      const type = params?.type as string | undefined;
      const source = params?.source as string | undefined;
      const expectedMonthly = params?.expectedMonthly as number | undefined;
      const isActive = params?.isActive as boolean | undefined;
      const webhookUrl = params?.webhookUrl as string | undefined;
      const apiKey = params?.apiKey as string | undefined;

      if (!name) {
        return respond(false, undefined, {
          code: "INVALID_PARAMS",
          message: "Stream name required",
        });
      }

      const store = loadStore();
      const businessId = resolveBusinessId(params);

      let stream: IncomeStream;
      const existingIdx = id ? store.streams.findIndex((s) => s.id === id) : -1;

      if (existingIdx >= 0) {
        // Update existing
        stream = {
          ...store.streams[existingIdx],
          name,
          type: type || store.streams[existingIdx].type,
          source: source || store.streams[existingIdx].source,
          expectedMonthly: expectedMonthly ?? store.streams[existingIdx].expectedMonthly,
          isActive: isActive ?? store.streams[existingIdx].isActive,
          webhookUrl: webhookUrl ?? store.streams[existingIdx].webhookUrl,
          apiKeyRef: apiKey ? `encrypted:${name}` : store.streams[existingIdx].apiKeyRef,
          businessId: store.streams[existingIdx].businessId ?? businessId,
        };
        store.streams[existingIdx] = stream;
      } else {
        // Create new
        stream = {
          id: generateId(),
          name,
          type: type || "subscription",
          source: source || "other",
          expectedMonthly,
          isActive: isActive ?? true,
          webhookUrl,
          apiKeyRef: apiKey ? `encrypted:${name}` : undefined,
          createdAt: new Date().toISOString(),
          businessId,
        };
        store.streams.push(stream);
      }

      saveStore(store);

      respond(true, { stream });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Get daily breakdown */
  "business.income.daily": async ({ params, respond }) => {
    try {
      const { startDate, endDate } = params || {};
      const store = loadStore();
      const businessId = resolveBusinessId(params);

      let filtered = entriesForBusiness(store.entries, businessId);

      if (startDate) {
        filtered = filtered.filter((e) => e.date >= startDate);
      }
      if (endDate) {
        filtered = filtered.filter((e) => e.date <= endDate);
      }

      // Group by date
      const byDate = new Map<string, number>();
      for (const entry of filtered) {
        const dateKey = entry.date.split("T")[0];
        byDate.set(dateKey, (byDate.get(dateKey) || 0) + entry.amount);
      }

      const data = Array.from(byDate.entries())
        .map(([date, amount]) => ({ date, amount }))
        .sort((a, b) => a.date.localeCompare(b.date));

      respond(true, { data });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },

  /** Delete income entry */
  "business.income.delete": async ({ params, respond }) => {
    try {
      const { id } = params || {};

      if (!id) {
        return respond(false, undefined, { code: "INVALID_PARAMS", message: "Entry ID required" });
      }

      const store = loadStore();
      const idx = store.entries.findIndex((e) => e.id === id);

      if (idx < 0) {
        return respond(false, undefined, { code: "NOT_FOUND", message: "Entry not found" });
      }

      store.entries.splice(idx, 1);
      saveStore(store);

      respond(true, { deleted: id });
    } catch (e) {
      respond(false, undefined, { code: "INTERNAL_ERROR", message: String(e) });
    }
  },
};

export default businessIncomeHandlers;

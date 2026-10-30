/**
 * Plugins page — marketplace pricing + ownership for installed plugins (hosted cloud).
 *
 * On InfiniBot Cloud the tenant gateway ships the first-party plugins bundled, so
 * plugins.list says nothing about price. The cloud marketplace API (same origin)
 * does: `GET /api/marketplace/index.json` carries each plugin's pricing, and
 * `GET /api/marketplace/purchases/access?plugin=<id>` (Clerk bearer) says whether
 * this member bought it or their plan includes it (200) or not (402).
 *
 * A paid plugin the member does not own gets the marketplace's own primary action
 * (`marketAction`: "Buy · $X", or the seller's page for an external one) instead of
 * Enable. Self-hosted gateways never load this, so their cards are unchanged; on the
 * cloud, if the marketplace can't be reached, the cards fall back to Enable as well.
 *
 * Vault: the CEO plan (every paid first-party plugin) is sold and gated on
 * KinglyVault, not here. A paid first-party plugin says "Included in CEO plan" and
 * offers "Unlock with Vault" (the KinglyVault CEO plan page) as its main action, the
 * per-plugin "Buy · $X" as the second, and a "CEO member? Download on KinglyVault"
 * link. This side never checks for the CEO plan: it only shows labels and links.
 * Free and third-party plugins never get the Vault offer.
 */

import type { PluginSummary } from "./api.js";
import { isExternalEntry, marketAction, type MarketEntry } from "./packages.js";
import {
  kinglyVaultUrls,
  VAULT_DOWNLOADS_ACTION,
  VAULT_INCLUDED_LABEL,
  VAULT_UNLOCK_ACTION,
  type KinglyVaultUrls,
} from "../../marketplace/kinglyvault.js";

/** A registry index entry (src/saas/cloud/marketplace/store.ts entryFromRow). */
type RegistryEntry = Omit<MarketEntry, "priceLabel" | "installed" | "compatible" | "blocked">;

export type Ownership = "owned" | "not-owned" | "unknown";

export type CloudPricing = {
  entries: Map<string, MarketEntry>;
  /** Paid, hosted first-party plugins only. */
  ownership: Map<string, Ownership>;
  /** Install entitlement from the access check (in memory only). */
  tokens: Map<string, string>;
};

export type PaidGate = {
  kind: "buy" | "external";
  label: string;
  url: string | null;
  entry: MarketEntry;
  /** The KinglyVault CEO plan offer ("Unlock with Vault"), null for third-party plugins. */
  vault: VaultOffer | null;
};

export { VAULT_DOWNLOADS_ACTION, VAULT_INCLUDED_LABEL, VAULT_UNLOCK_ACTION };

/** Badge + links for a paid first-party plugin: "Included in CEO plan", Unlock with Vault, downloads. */
export type VaultOffer = { badge: string; ceoUrl: string; downloadsUrl: string };

/** Only paid, hosted, first-party plugins are part of the CEO plan. */
export function inCeoBundle(e: Pick<MarketEntry, "firstParty" | "distribution" | "pricing">): boolean {
  return e.pricing.model === "paid" && e.firstParty && !isExternalEntry(e);
}

export function vaultOffer(
  e: Pick<MarketEntry, "firstParty" | "distribution" | "pricing">,
  urls: KinglyVaultUrls = kinglyVaultUrls(),
): VaultOffer | null {
  return inCeoBundle(e) ? { badge: VAULT_INCLUDED_LABEL, ...urls } : null;
}

/** The Vault offer for an installed plugin on the cloud (null: no pricing / not in the bundle). */
export function vaultForPlugin(id: string, pricing: CloudPricing | null, urls?: KinglyVaultUrls): VaultOffer | null {
  const entry = pricing?.entries.get(id);
  return entry ? vaultOffer(entry, urls) : null;
}

export type CloudPricingDeps = {
  fetch: typeof fetch;
  /** Clerk session JWT; null when signed out. */
  token: () => Promise<string | null>;
  /** e.g. "/api/marketplace". */
  apiBase: string;
};

/** Same wording as the gateway (src/plugins/packages/registry-client.ts formatPrice). */
export function formatPrice(pricing: Pick<MarketEntry["pricing"], "model" | "priceCents" | "currency">): string {
  if (pricing.model === "free" || pricing.priceCents <= 0) return "Free";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: pricing.currency }).format(pricing.priceCents / 100);
  } catch {
    return `${(pricing.priceCents / 100).toFixed(2)} ${pricing.currency}`;
  }
}

/**
 * Registry entry → marketplace card entry. `installed` is left null on purpose:
 * a bundled copy on the tenant gateway is not a purchase.
 */
export function toMarketEntry(e: RegistryEntry): MarketEntry {
  return { ...e, priceLabel: formatPrice(e.pricing), installed: null, compatible: true, blocked: null };
}

const needsAccessCheck = (e: MarketEntry) => inCeoBundle(e);

export async function loadCloudPricing(deps: CloudPricingDeps): Promise<CloudPricing | null> {
  let index: { plugins?: RegistryEntry[] };
  try {
    const res = await deps.fetch(`${deps.apiBase}/index.json`, { credentials: "omit" });
    if (!res.ok) return null;
    index = (await res.json()) as { plugins?: RegistryEntry[] };
  } catch {
    return null;
  }
  if (!Array.isArray(index.plugins)) return null;
  const entries = new Map<string, MarketEntry>();
  for (const raw of index.plugins) {
    if (raw && typeof raw.id === "string" && raw.pricing) entries.set(raw.id, toMarketEntry(raw));
  }
  const ownership = new Map<string, Ownership>();
  const tokens = new Map<string, string>();
  const paid = [...entries.values()].filter(needsAccessCheck);
  if (paid.length) {
    let bearer: string | null = null;
    try {
      bearer = await deps.token();
    } catch {
      bearer = null;
    }
    await Promise.all(
      paid.map(async (e) => {
        ownership.set(e.id, await checkAccess(deps, bearer, e.id, tokens));
      }),
    );
  }
  return { entries, ownership, tokens };
}

/**
 * 200 → owned (bought, or included in the plan); 402 → not owned; signed out → not
 * owned. Anything else (pending checkout, 5xx, network) is unknown: the card keeps
 * Enable rather than selling something the member may already have.
 */
async function checkAccess(deps: CloudPricingDeps, bearer: string | null, id: string, tokens: Map<string, string>): Promise<Ownership> {
  if (!bearer) return "not-owned";
  try {
    const res = await deps.fetch(`${deps.apiBase}/purchases/access?plugin=${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${bearer}` },
      credentials: "omit",
      cache: "no-store",
    });
    if (res.status === 200) {
      const body = (await res.json().catch(() => null)) as { links?: { installToken?: string } } | null;
      if (body?.links?.installToken) tokens.set(id, body.links.installToken);
      return "owned";
    }
    if (res.status === 402 || res.status === 401) return "not-owned";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Buy instead of Enable: a paid plugin that is off and not owned. A plugin that is
 * already on is left alone (never re-sold, never switched off from here). An
 * external (seller-delivered) plugin counts as owned once it was imported, i.e.
 * it is not just the bundled copy.
 */
export function paidGate(p: Pick<PluginSummary, "id" | "enabled" | "origin">, pricing: CloudPricing | null): PaidGate | null {
  if (!pricing || p.enabled) return null;
  const entry = pricing.entries.get(p.id);
  if (!entry || entry.pricing.model !== "paid") return null;
  if (needsAccessCheck(entry)) {
    if (pricing.ownership.get(p.id) !== "not-owned") return null;
  } else if (p.origin !== "bundled") {
    return null;
  }
  const act = marketAction(entry, { tokenInHand: false });
  if (act.kind !== "buy" && act.kind !== "external") return null;
  const url = entry.pricing.purchaseUrl ?? (isExternalEntry(entry) ? entry.homepageUrl : null);
  return { kind: act.kind, label: act.label, url, entry, vault: act.kind === "buy" ? vaultOffer(entry) : null };
}

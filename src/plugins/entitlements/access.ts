/**
 * Who may run a plugin: the access policy (paid) and the decision for this
 * install.
 *
 * One requirement kind, `purchase`: the plugin is sold on KinglyVault. It
 * loads only with a verified KinglyVault entitlement for it (a per-plugin
 * purchase, or a plan such as CEO that includes every paid plugin; see
 * ./store.ts), or the signed owner grant for this machine (./owner-grant.ts).
 * There is no "desktop-only" plugin: every plugin runs wherever InfiniBot
 * runs, and the packaged Desktop app, npm and source installs all take this
 * same path (no env var or build flag lifts it).
 *
 * The first-party table below is AUTHORITATIVE: editing a bundled manifest
 * cannot make a paid first-party plugin free. A third-party manifest may only
 * ADD requirements to itself (its own `access` block); it can never lift ours.
 *
 * Hosted fleet tenants are governed by the cloud plan (src/saas/fleet-plugins)
 * instead, so this gate stands aside there — but never inside the Electron
 * runtime of InfiniBot Desktop, which is never a fleet tenant.
 */
import { firstPartyPriceSeed } from "../../saas/cloud/marketplace/first-party-pricing.js";
import { isFleetTenantMachine } from "../../saas/fleet-plugins.js";
import { entitlementFor, type EntitlementLookup } from "./store.js";

export type PluginAccessPolicy = {
  purchase?: { priceCents: number; currency: "USD"; interval: "once" };
};

export function firstPartyAccessPolicy(id: string): PluginAccessPolicy {
  const seed = firstPartyPriceSeed(id);
  const policy: PluginAccessPolicy = {};
  if (seed.model === "paid" && seed.priceCents > 0) {
    policy.purchase = { priceCents: seed.priceCents, currency: "USD", interval: "once" };
  }
  return policy;
}

/**
 * Parse a manifest's optional `access` block (restrict-only):
 * `{ "purchase": { "priceCents": 900 } }`. Unknown keys are ignored.
 */
export function parseManifestAccess(raw: unknown): PluginAccessPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: PluginAccessPolicy = {};
  const p = r.purchase;
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const cents = (p as Record<string, unknown>).priceCents;
    out.purchase = {
      priceCents:
        typeof cents === "number" && Number.isFinite(cents) && cents > 0 ? Math.round(cents) : 0,
      currency: "USD",
      interval: "once",
    };
  }
  return out;
}

/** Ours wins on price; a purchase requirement from either side applies. */
export function effectiveAccessPolicy(id: string, manifestAccess?: unknown): PluginAccessPolicy {
  const ours = firstPartyAccessPolicy(id);
  const theirs = parseManifestAccess(manifestAccess);
  const out: PluginAccessPolicy = {};
  const purchase = ours.purchase ?? theirs.purchase;
  if (purchase) out.purchase = purchase;
  return out;
}

/**
 * True inside the Electron runtime (InfiniBot Desktop spawns its gateway with
 * Electron-as-Node). Read from the binary, not from env, so it can't be faked
 * off — and a desktop install is never a hosted fleet tenant.
 */
export function isElectronRuntime(versions: NodeJS.ProcessVersions = process.versions): boolean {
  return typeof versions.electron === "string";
}

/** The cloud plan decides (fleet tenant), not KinglyVault. Never in Desktop. */
export function cloudPlanGoverns(
  env: NodeJS.ProcessEnv = process.env,
  versions: NodeJS.ProcessVersions = process.versions,
): boolean {
  return !isElectronRuntime(versions) && isFleetTenantMachine(env);
}

export type PluginAccessStatus = "free" | "unlocked" | "grace" | "locked-purchase" | "expired";

export type PluginAccessDecision = {
  status: PluginAccessStatus;
  loadable: boolean;
  /** Human copy for a refusal / lock badge. */
  reason?: string;
  requires: { purchase: boolean };
  price: { priceCents: number; currency: "USD"; label: string } | null;
  /** Where the unlock came from ("purchase", "plan:ceo", "admin:owner", …). */
  source?: string;
  /** Entitlement end (ISO) when it is time-limited. */
  until?: string | null;
  /** Offline grace: the cached token expired and could not be refreshed. */
  graceEndsAt?: string | null;
};

export function priceLabel(cents: number): string {
  const dollars = cents / 100;
  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
}

/**
 * The access decision for one plugin, or null when nothing gates it here
 * (free plugin, or a hosted fleet tenant where the cloud plan decides).
 */
export function pluginAccessDecision(
  id: string,
  opts: {
    manifestAccess?: unknown;
    env?: NodeJS.ProcessEnv;
    lookup?: EntitlementLookup;
    now?: number;
  } = {},
): PluginAccessDecision {
  const env = opts.env ?? process.env;
  const policy = effectiveAccessPolicy(id, opts.manifestAccess);
  const requires = { purchase: Boolean(policy.purchase) };
  const price = policy.purchase
    ? {
        priceCents: policy.purchase.priceCents,
        currency: "USD" as const,
        label: priceLabel(policy.purchase.priceCents),
      }
    : null;
  if (!requires.purchase || cloudPlanGoverns(env)) {
    return { status: "free", loadable: true, requires, price };
  }
  // A plan-wide "*" entitlement covers our paid plugins only, never third-party ones.
  const wildcard = Boolean(firstPartyAccessPolicy(id).purchase);
  const ent = (opts.lookup ?? entitlementFor)(id, opts.now, { wildcard });
  if (ent.state === "valid") {
    return {
      status: "unlocked",
      loadable: true,
      requires,
      price,
      source: ent.source,
      until: ent.until,
    };
  }
  if (ent.state === "grace") {
    return {
      status: "grace",
      loadable: true,
      requires,
      price,
      source: ent.source,
      until: ent.until,
      graceEndsAt: ent.graceEndsAt,
      reason: "Offline: using your saved KinglyVault purchase until InfiniBot can re-check it.",
    };
  }
  if (ent.state === "expired") {
    return {
      status: "expired",
      loadable: false,
      requires,
      price,
      reason:
        ent.why ??
        "Your KinglyVault entitlement could not be re-checked for too long. Reconnect KinglyVault to keep using it.",
    };
  }
  return {
    status: "locked-purchase",
    loadable: false,
    requires,
    price,
    reason: `Paid plugin${price ? ` (${price.label})` : ""}. Buy it on KinglyVault or restore a purchase to turn it on.`,
  };
}

/** Refusal copy for turning `id` on, or null when allowed. */
export function pluginAccessRefusal(id: string, manifestAccess?: unknown): string | null {
  const d = pluginAccessDecision(id, { manifestAccess });
  return d.loadable ? null : (d.reason ?? "This plugin is locked.");
}

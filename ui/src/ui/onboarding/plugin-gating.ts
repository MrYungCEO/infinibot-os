/**
 * Decide what onboarding may do with a recommended plugin.
 *
 * Onboarding NEVER buys anything and never installs packages: it only turns
 * on plugins that are already on this machine and free to use. Everything
 * else gets a badge and a link to the Plugins page, which owns installs,
 * purchases and the paid-plugin gating (built by the plugins team).
 *
 * Reads the gating fields defensively so it keeps working as that system
 * grows: `pricing` / `priceLabel` (marketplace), `cloud` (hosted plan
 * decision), and any of `paid` / `entitled` / `gate` that a newer gateway may
 * add. There are no desktop-only plugins: every plugin runs wherever
 * InfiniBot runs; only a hosted workspace's cloud decision can rule one out.
 */

export type PluginBadge = "free" | "paid" | "pro";

export type PluginAction =
  /** Already on: nothing to do. */
  | "on"
  /** Installed, free, off: onboarding may switch it on. */
  | "enable"
  /** Needs a purchase or a plan: link to the Plugins page, never auto-enabled. */
  | "buy"
  /** Not installed here: link to the Plugins page / marketplace. */
  | "install"
  /** Can't run on this workspace (e.g. not available in InfiniBot Cloud yet). */
  | "unavailable";

export interface PluginDecision {
  id: string;
  name: string;
  description: string;
  action: PluginAction;
  badges: PluginBadge[];
  /** Short plain reason shown under the card ("Included in Pro", "$19 on the Plugins page"). */
  note: string | null;
  priceLabel: string | null;
}

/** Hosted cloud statuses that mean "can't run here at all" (not "buy a plan"). */
const CLOUD_UNAVAILABLE = new Set(["self-host-only", "coming-soon", "unsupported"]);

type Loose = Record<string, unknown>;

const asObj = (v: unknown): Loose | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function pricingOf(installed: Loose | null, market: Loose | null): { paid: boolean; label: string | null; plans: string[] } {
  const pricing = asObj(market?.pricing) ?? asObj(installed?.pricing) ?? asObj(asObj(installed?.listing)?.pricing);
  const gate = asObj(installed?.gate) ?? asObj(market?.gate);
  const paid =
    pricing?.model === "paid" ||
    installed?.paid === true ||
    market?.paid === true ||
    gate?.kind === "buy" ||
    gate?.kind === "external";
  const plans = Array.isArray(pricing?.includedPlans) ? (pricing!.includedPlans as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const label = str(market?.priceLabel) ?? str(installed?.priceLabel) ?? str(gate?.label);
  return { paid, label, plans };
}

export interface GatingEnv {
  /** Hosted workspace (cloud tenant): the cloud decision rules. */
  hosted?: boolean;
  /** Entitlement / plan keys the owner already has (e.g. "pro", "ceo"). */
  entitlements?: ReadonlySet<string>;
}

/**
 * @param installed a row from `plugins.list` (undefined when not on this machine)
 * @param market    a row from `plugins.marketplace.list` (optional)
 */
export function decidePlugin(
  id: string,
  installed: unknown,
  market: unknown,
  env: GatingEnv = {},
): PluginDecision {
  const inst = asObj(installed);
  const mk = asObj(market);
  const listing = asObj(inst?.listing) ?? asObj(mk?.listing);
  const name = str(inst?.name) ?? str(mk?.name) ?? id;
  const description = str(listing?.tagline) ?? str(mk?.tagline) ?? str(inst?.description) ?? str(mk?.description) ?? "";
  const { paid, label, plans } = pricingOf(inst, mk);
  const cloud = asObj(inst?.cloud) ?? asObj(mk?.cloud);
  const entitled = plans.some((p) => env.entitlements?.has(p)) || inst?.entitled === true || mk?.entitled === true;
  const badges: PluginBadge[] = [];
  if (paid) badges.push(cloud?.status === "locked" || plans.length ? "pro" : "paid");
  if (!paid) badges.push("free");

  const base = { id, name, description, badges, priceLabel: label };
  if (cloud && CLOUD_UNAVAILABLE.has(String(cloud.status)) && cloud.loadable !== true) {
    return { ...base, action: "unavailable", note: str(cloud.reason) ?? "Not available in InfiniBot Cloud yet." };
  }
  if (cloud?.status === "locked" && !entitled) {
    return { ...base, action: "buy", note: str(cloud.reason) ?? "Included in a higher plan." };
  }
  if (inst?.enabled === true) return { ...base, action: "on", note: null };
  if (paid && !entitled) {
    return {
      ...base,
      action: "buy",
      note: plans.length ? `Included in ${plans.map((p) => p.toUpperCase()).join(" / ")}` : label ? `${label} on the Plugins page` : "Paid plugin",
    };
  }
  if (!inst) return { ...base, action: "install", note: "Install it from the Plugins page." };
  return { ...base, action: "enable", note: null };
}

/** Ids onboarding should switch on by default: installed, free (or owned), and off. */
export function defaultEnableSet(decisions: readonly PluginDecision[]): Set<string> {
  return new Set(decisions.filter((d) => d.action === "enable").map((d) => d.id));
}

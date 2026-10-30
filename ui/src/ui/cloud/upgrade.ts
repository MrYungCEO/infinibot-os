/**
 * Open the upgrade checkout (the existing Whop flow: POST /api/whop-checkout →
 * hosted checkout URL). Shared by the daily-limit upsells/gate and the plan
 * locks (Telegram / Slack on Free). Call it straight from a click handler: the
 * new tab is opened synchronously so popup blockers let it through, then
 * pointed at Whop once the URL is minted.
 *
 * Outside the hosted cloud (or signed out) it falls back to the pricing page.
 */
import { getClerkToken } from "../saas-clerk";
import { safeCheckoutUrl } from "./checkout-resume";
import { cloudApiBase, isCloudBuild } from "./cloud-env";
import { CHECKOUT_PLAN_IDS } from "./daily-limit-model";

export type UpgradeResult = { ok: true } | { ok: false; error: string };

export const CHECKOUT_FAILED = "Checkout didn't open. Try again, or use the pricing page.";

function pricingUrl(): string {
  return new URL("/pricing", window.location.origin).toString();
}

export async function openUpgrade(plan = "pro", opts: { source?: string } = {}): Promise<UpgradeResult> {
  window.dispatchEvent(new CustomEvent("infinibot:upgrade-open", { detail: { plan, source: opts.source ?? null } }));
  if (!isCloudBuild() || !(CHECKOUT_PLAN_IDS as readonly string[]).includes(plan)) {
    window.open(pricingUrl(), "_blank", "noopener,noreferrer");
    return { ok: true };
  }
  // Opened inside the click (before any await) so it isn't blocked.
  const tab = window.open("", "_blank");
  try {
    const token = await getClerkToken({ fresh: true });
    if (!token) throw new Error("signed out");
    const res = await fetch(`${cloudApiBase()}/whop-checkout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });
    const url = safeCheckoutUrl(((await res.json().catch(() => ({}))) as { checkoutUrl?: unknown }).checkoutUrl);
    if (!res.ok || !url) throw new Error(`checkout ${res.status}`);
    if (tab) tab.location.href = url;
    else window.location.assign(url);
    return { ok: true };
  } catch {
    tab?.close();
    return { ok: false, error: CHECKOUT_FAILED };
  }
}

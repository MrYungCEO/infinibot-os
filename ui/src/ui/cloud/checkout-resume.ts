/**
 * Resume a pricing-page checkout after sign-in.
 *
 * The static /pricing page (site/, no Clerk on it) first POSTs
 * /api/whop-checkout itself; when that answers 401 it sends the visitor to
 * /app?checkout=<plan>. Once the Clerk gate has a session, this finishes the
 * hand-off with a Bearer token and redirects to Whop's hosted checkout. The
 * checkout URL is minted server-side (netlify/functions/whop-checkout.mts), so
 * nothing about billing is baked into the bundle.
 */
import { getClerkToken } from "../saas-clerk";
import { cloudApiBase } from "./cloud-env";

export const CHECKOUT_PLANS = ["starter", "pro", "business", "scale"] as const;
export type CheckoutPlan = (typeof CHECKOUT_PLANS)[number];

export function pendingCheckoutPlan(search = window.location.search): CheckoutPlan | null {
  const plan = new URLSearchParams(search).get("checkout")?.trim().toLowerCase();
  return (CHECKOUT_PLANS as readonly string[]).includes(plan ?? "") ? (plan as CheckoutPlan) : null;
}

/** Only ever leave the app for an https Whop page. */
export function safeCheckoutUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && /(^|\.)whop\.com$/i.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

function dropCheckoutParam(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete("checkout");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
}

/** Returns true when the page is navigating away to checkout (stop booting). */
export async function maybeResumeCheckout(): Promise<boolean> {
  const plan = pendingCheckoutPlan();
  if (!plan) return false;
  dropCheckoutParam(); // one attempt; a failure falls through to the workspace
  try {
    const token = await getClerkToken({ fresh: true });
    if (!token) return false;
    const res = await fetch(`${cloudApiBase()}/whop-checkout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    });
    if (!res.ok) throw new Error(`whop-checkout ${res.status}`);
    const url = safeCheckoutUrl(((await res.json()) as { checkoutUrl?: unknown }).checkoutUrl);
    if (!url) throw new Error("whop-checkout returned no checkout URL");
    window.location.assign(url);
    return true;
  } catch (err) {
    console.error("[cloud] checkout resume failed:", err);
    return false;
  }
}

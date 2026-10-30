/**
 * "Already bought it? Sign in to download" on a paid marketplace plugin.
 *
 * The static /marketplace pages have no Clerk; they link to
 * /app?marketplace=<pluginId>. Once the Clerk gate has a session, this asks the
 * purchase API whether the member owns the plugin (bought with this account or
 * its email, or included in their plan) and goes to the purchase page with a
 * signed receipt link. Not owned → back to the plugin page to buy it.
 * Server: src/saas/cloud/marketplace/purchase-api.ts.
 */
import { getClerkToken } from "../saas-clerk";
import { marketplaceApiBase } from "../marketplace/marketplace-api";

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function pendingMarketplacePlugin(search = window.location.search): string | null {
  const id = new URLSearchParams(search).get("marketplace")?.trim().toLowerCase() ?? "";
  return ID_RE.test(id) ? id : null;
}

/** Same-origin receipt page only. */
export function safeReceiptUrl(raw: unknown, origin = window.location.origin): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw, origin);
    return u.origin === origin && /^\/marketplace\/[a-z0-9-]+\/purchased$/.test(u.pathname) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Returns true when the page is navigating away (stop booting the app). */
export async function maybeResumeMarketplace(): Promise<boolean> {
  const id = pendingMarketplacePlugin();
  if (!id) return false;
  const url = new URL(window.location.href);
  url.searchParams.delete("marketplace");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  try {
    const token = await getClerkToken({ fresh: true });
    if (!token) return false;
    const res = await fetch(`${marketplaceApiBase()}/purchases/access?plugin=${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      cache: "no-store",
    });
    if (res.ok) {
      const body = (await res.json()) as { links?: { receiptUrl?: unknown } };
      const receipt = safeReceiptUrl(body.links?.receiptUrl);
      if (receipt) {
        window.location.assign(receipt);
        return true;
      }
    }
    if (res.status === 402) {
      window.location.assign(`/marketplace/${encodeURIComponent(id)}?buy=1`);
      return true;
    }
    return false;
  } catch (err) {
    console.error("[cloud] marketplace resume failed:", err);
    return false;
  }
}

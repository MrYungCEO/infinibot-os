/**
 * "Payment failed — update billing" banner for the hosted cloud app.
 *
 * GET /api/me carries `billing: { status, graceUntil, manageUrl }`
 * (src/saas/cloud/whop.ts). While a tenant is past due it keeps its plan, and
 * this shows a small, dismissible, non-blocking notice with a link to Whop's
 * manage-membership page. It never covers the app and never gates anything.
 */
import { CloudApiClient } from "./cloud-api";

export type CloudBilling = {
  status?: string | null;
  graceUntil?: string | null;
  manageUrl?: string | null;
};

export type BillingBannerModel = { message: string; detail: string; manageUrl: string | null };

/** Only ever link out to an https whop.com page. */
export function safeManageUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && /(^|\.)whop\.com$/i.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** What the banner says, or null when there is nothing to show. */
export function billingBannerModel(
  billing: CloudBilling | null | undefined,
  now: number = Date.now(),
): BillingBannerModel | null {
  if (billing?.status !== "past_due") return null;
  const until = billing.graceUntil ? Date.parse(billing.graceUntil) : NaN;
  let detail = "Update your billing details to keep your plan.";
  if (Number.isFinite(until)) {
    const days = Math.ceil((until - now) / 86_400_000);
    detail =
      days <= 0
        ? "Update your billing details today to keep your plan."
        : `Update your billing details within ${days} day${days === 1 ? "" : "s"} to keep your plan.`;
  }
  return { message: "Payment failed", detail, manageUrl: safeManageUrl(billing.manageUrl) };
}

const ROOT_ID = "cloud-billing-banner";
const DISMISS_KEY = "infinibot.cloud.billingBanner.dismissedUntil";

const STYLE = `
#${ROOT_ID} {
  position: fixed; left: 50%; bottom: max(16px, env(safe-area-inset-bottom)); transform: translateX(-50%);
  z-index: 8000; display: flex; align-items: center; gap: 14px;
  width: max-content; max-width: min(640px, calc(100vw - 24px)); box-sizing: border-box;
  padding: 12px 14px 12px 16px; border-radius: 14px;
  font: 400 13.5px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #f4efe2; background: rgba(18, 15, 9, 0.94);
  border: 1px solid rgba(232, 184, 75, 0.45);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(232, 184, 75, 0.08) inset;
  backdrop-filter: blur(12px);
}
#${ROOT_ID} .cbb-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: #e8b84b; box-shadow: 0 0 10px rgba(232, 184, 75, 0.7); }
#${ROOT_ID} .cbb-text { min-width: 0; }
#${ROOT_ID} .cbb-title { font-weight: 600; color: #f6d27a; }
#${ROOT_ID} .cbb-detail { color: rgba(244, 239, 226, 0.78); }
#${ROOT_ID} .cbb-cta {
  flex: none; padding: 8px 14px; border-radius: 10px; text-decoration: none; white-space: nowrap;
  font-weight: 600; font-size: 13px; color: #1a1408;
  background: linear-gradient(180deg, #f1cd6f, #d9a436); border: 1px solid rgba(232, 184, 75, 0.6);
}
#${ROOT_ID} .cbb-cta:focus-visible, #${ROOT_ID} .cbb-close:focus-visible { outline: 2px solid #f1cd6f; outline-offset: 2px; }
#${ROOT_ID} .cbb-close {
  flex: none; appearance: none; cursor: pointer; width: 28px; height: 28px; border-radius: 8px;
  border: 0; background: transparent; color: rgba(244, 239, 226, 0.6); font-size: 18px; line-height: 1;
}
#${ROOT_ID} .cbb-close:hover { color: #f4efe2; background: rgba(255, 255, 255, 0.06); }
@media (max-width: 520px) {
  #${ROOT_ID} { flex-wrap: wrap; width: calc(100vw - 24px); gap: 10px; }
  #${ROOT_ID} .cbb-text { flex: 1 1 calc(100% - 60px); }
  #${ROOT_ID} .cbb-cta { flex: 1 1 auto; text-align: center; order: 3; }
}
`;

/** Render (or remove) the banner. Exposed for tests and the visual harness. */
export function renderBillingBanner(model: BillingBannerModel | null, doc: Document = document): void {
  doc.getElementById(ROOT_ID)?.remove();
  if (!model) return;
  const root = doc.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  root.dataset.testid = "cloud-billing-banner";

  const style = doc.createElement("style");
  style.textContent = STYLE;
  const dot = doc.createElement("span");
  dot.className = "cbb-dot";
  dot.setAttribute("aria-hidden", "true");
  const text = doc.createElement("div");
  text.className = "cbb-text";
  const title = doc.createElement("span");
  title.className = "cbb-title";
  title.textContent = `${model.message} — `;
  const detail = doc.createElement("span");
  detail.className = "cbb-detail";
  detail.textContent = model.detail;
  text.append(title, detail);
  root.append(style, dot, text);

  if (model.manageUrl) {
    const cta = doc.createElement("a");
    cta.className = "cbb-cta";
    cta.href = model.manageUrl;
    cta.target = "_blank";
    cta.rel = "noopener noreferrer";
    cta.textContent = "Update billing";
    cta.dataset.testid = "cloud-billing-banner-cta";
    root.append(cta);
  }
  const close = doc.createElement("button");
  close.className = "cbb-close";
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => {
    root.remove();
    try {
      // Comes back tomorrow: it is a reminder, not a one-off.
      sessionStorage.setItem(DISMISS_KEY, String(Date.now() + 86_400_000));
    } catch {
      /* storage unavailable: dismissed for this page only */
    }
  });
  root.append(close);
  doc.body.append(root);
}

function dismissed(): boolean {
  try {
    return Number(sessionStorage.getItem(DISMISS_KEY) ?? 0) > Date.now();
  } catch {
    return false;
  }
}

/** Ask /api/me for the billing standing and show the banner when past due. Never throws. */
export async function mountBillingBanner(): Promise<void> {
  try {
    if (dismissed()) return;
    const me = await new CloudApiClient().request<{ billing?: CloudBilling }>("saas.me");
    renderBillingBanner(billingBannerModel(me?.billing));
  } catch {
    /* signed out or the API is down: no banner */
  }
}

/**
 * Fair-use notice for wake-mode (Starter) plans in the hosted cloud app.
 *
 * `fairUse` arrives with POST /fleet/resolve (and GET /api/me):
 *   { capHours, usedHours, pct, state: ok | warn | over, policy, idleMinutes, resetsAt }
 * (src/fleet/fair-use.ts). At 80% a small notice; at 100% an "Upgrade to Pro for
 * always-on" banner. Both are dismissible and never block or gate anything:
 * the workspace keeps working over the cap, it just sleeps sooner when idle.
 */

export type CloudFairUse = {
  month?: string | null;
  capHours?: number | null;
  usedHours?: number | null;
  pct?: number | null;
  state?: string | null;
  policy?: string | null;
  idleMinutes?: number | null;
  resetsAt?: string | null;
};

export type FairUseBannerModel = {
  level: "warn" | "over";
  title: string;
  detail: string;
  /** 0–100, for the meter. */
  meterPct: number;
  cta: { label: string; href: string } | null;
};

const fmtHours = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function resetLabel(resetsAt: string | null | undefined): string {
  const t = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(t)) return "next month";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** What the banner says, or null when there is nothing to show. */
export function fairUseBannerModel(
  fairUse: CloudFairUse | null | undefined,
  upgradeHref = "/pricing#pro",
): FairUseBannerModel | null {
  if (!fairUse || (fairUse.state !== "warn" && fairUse.state !== "over")) return null;
  const used = Number(fairUse.usedHours);
  const cap = Number(fairUse.capHours);
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return null;
  const usage = `${fmtHours(used)} of ${fmtHours(cap)} active hours used this month`;
  const meterPct = Math.max(0, Math.min(100, (used / cap) * 100));
  const cta = { label: "Upgrade to Pro", href: upgradeHref };
  if (fairUse.state === "warn") {
    return {
      level: "warn",
      title: "Starter fair use",
      detail: `${usage}. Resets ${resetLabel(fairUse.resetsAt)}.`,
      meterPct,
      cta,
    };
  }
  // Over the cap. Under the "off" policy nothing changes, so there is nothing to announce.
  if (fairUse.policy === "off") return null;
  const sooner =
    typeof fairUse.idleMinutes === "number" && fairUse.idleMinutes > 0
      ? ` Your workspace keeps working and now sleeps after ${fairUse.idleMinutes} min idle.`
      : " Your workspace keeps working.";
  return {
    level: "over",
    title: "Upgrade to Pro for always-on",
    detail: `${usage}.${sooner} Resets ${resetLabel(fairUse.resetsAt)}.`,
    meterPct,
    cta,
  };
}

const ROOT_ID = "cloud-fair-use-banner";
const DISMISS_KEY = "infinibot.cloud.fairUseBanner.dismissed";

const STYLE = `
#${ROOT_ID} {
  position: fixed; left: 50%; bottom: max(16px, env(safe-area-inset-bottom)); transform: translateX(-50%);
  z-index: 7990; display: flex; align-items: center; gap: 14px;
  width: max-content; max-width: min(760px, calc(100vw - 24px)); box-sizing: border-box;
  padding: 12px 14px 12px 16px; border-radius: 14px;
  font: 400 13.5px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #f4efe2; background: rgba(18, 15, 9, 0.94);
  border: 1px solid rgba(232, 184, 75, 0.45);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(232, 184, 75, 0.08) inset;
  backdrop-filter: blur(12px);
}
/* Sits above the payment banner when both are up. */
body:has(#cloud-billing-banner) #${ROOT_ID} { bottom: calc(max(16px, env(safe-area-inset-bottom)) + 76px); }
#${ROOT_ID} .cfu-text { min-width: 0; text-wrap: pretty; }
#${ROOT_ID} .cfu-title { font-weight: 600; color: #f6d27a; }
#${ROOT_ID} .cfu-detail { color: rgba(244, 239, 226, 0.78); }
#${ROOT_ID} .cfu-meter {
  margin-top: 7px; height: 4px; border-radius: 4px; overflow: hidden;
  background: rgba(244, 239, 226, 0.14);
}
#${ROOT_ID} .cfu-meter > span { display: block; height: 100%; border-radius: 4px; background: #e8b84b; }
#${ROOT_ID}[data-level="over"] .cfu-meter > span { background: linear-gradient(90deg, #e8b84b, #f1cd6f); }
#${ROOT_ID} .cfu-cta {
  flex: none; padding: 8px 14px; border-radius: 10px; text-decoration: none; white-space: nowrap;
  font-weight: 600; font-size: 13px; color: #1a1408;
  background: linear-gradient(180deg, #f1cd6f, #d9a436); border: 1px solid rgba(232, 184, 75, 0.6);
}
#${ROOT_ID}[data-level="warn"] .cfu-cta {
  color: #f6d27a; background: transparent; border-color: rgba(232, 184, 75, 0.45);
}
#${ROOT_ID} .cfu-cta:focus-visible, #${ROOT_ID} .cfu-close:focus-visible { outline: 2px solid #f1cd6f; outline-offset: 2px; }
#${ROOT_ID} .cfu-close {
  flex: none; appearance: none; cursor: pointer; width: 28px; height: 28px; border-radius: 8px;
  border: 0; background: transparent; color: rgba(244, 239, 226, 0.6); font-size: 18px; line-height: 1;
}
#${ROOT_ID} .cfu-close:hover { color: #f4efe2; background: rgba(255, 255, 255, 0.06); }
@media (max-width: 520px) {
  #${ROOT_ID} { flex-wrap: wrap; width: calc(100vw - 24px); gap: 10px; }
  #${ROOT_ID} .cfu-text { flex: 1 1 calc(100% - 44px); }
  #${ROOT_ID} .cfu-cta { flex: 1 1 auto; text-align: center; order: 3; }
}
`;

function dismissKey(level: string, month: string | null | undefined): string {
  return `${level}:${month ?? ""}`;
}

/** Render (or remove) the banner. Exposed for tests and the visual harness. */
export function renderFairUseBanner(
  model: FairUseBannerModel | null,
  opts: { month?: string | null; doc?: Document } = {},
): void {
  const doc = opts.doc ?? document;
  doc.getElementById(ROOT_ID)?.remove();
  if (!model) return;
  const root = doc.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  root.dataset.testid = "cloud-fair-use-banner";
  root.dataset.level = model.level;

  const style = doc.createElement("style");
  style.textContent = STYLE;
  const text = doc.createElement("div");
  text.className = "cfu-text";
  const title = doc.createElement("span");
  title.className = "cfu-title";
  title.textContent = `${model.title} — `;
  const detail = doc.createElement("span");
  detail.className = "cfu-detail";
  detail.textContent = model.detail;
  const meter = doc.createElement("div");
  meter.className = "cfu-meter";
  meter.setAttribute("role", "meter");
  meter.setAttribute("aria-valuemin", "0");
  meter.setAttribute("aria-valuemax", "100");
  meter.setAttribute("aria-valuenow", String(Math.round(model.meterPct)));
  meter.setAttribute("aria-label", "Active hours used this month");
  const fill = doc.createElement("span");
  fill.style.width = `${model.meterPct}%`;
  meter.append(fill);
  text.append(title, detail, meter);
  root.append(style, text);

  if (model.cta) {
    const cta = doc.createElement("a");
    cta.className = "cfu-cta";
    cta.href = model.cta.href;
    cta.target = "_blank";
    cta.rel = "noopener noreferrer";
    cta.textContent = model.cta.label;
    cta.dataset.testid = "cloud-fair-use-cta";
    root.append(cta);
  }
  const close = doc.createElement("button");
  close.className = "cfu-close";
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";
  close.addEventListener("click", () => {
    root.remove();
    try {
      // Once per level per month: the 100% banner still shows after the 80% one was closed.
      localStorage.setItem(DISMISS_KEY, dismissKey(model.level, opts.month));
    } catch {
      /* storage unavailable: dismissed for this page only */
    }
  });
  root.append(close);
  doc.body.append(root);
}

function dismissed(level: string, month: string | null | undefined): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === dismissKey(level, month);
  } catch {
    return false;
  }
}

/** Show the notice for this fair-use standing (from resolve or /api/me). Never throws. */
export function showFairUseBanner(fairUse: CloudFairUse | null | undefined, upgradeHref?: string): void {
  try {
    const model = fairUseBannerModel(fairUse, upgradeHref);
    if (model && dismissed(model.level, fairUse?.month)) return;
    renderFairUseBanner(model, { month: fairUse?.month });
  } catch {
    /* never let a notice break the app */
  }
}

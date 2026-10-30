/**
 * "Sleeping — click or type to wake" notice for the hosted cloud app.
 *
 * Shown while a wake-mode (Starter) workspace is asleep under an open tab
 * (cloud/gateway-sleep.ts). A small card over a light veil: the last screen
 * stays readable, and any click or key press anywhere wakes the workspace. Plain DOM
 * (no framework), like billing-banner.ts, so it can sit above the full app.
 */
import type { SleepPhase } from "./gateway-sleep";

export type SleepNoticeModel = { phase: "sleeping" | "waking"; title: string; detail: string };

export function sleepNoticeModel(
  phase: SleepPhase,
  idleMinutes?: number | null,
): SleepNoticeModel | null {
  if (phase === "awake") return null;
  if (phase === "waking") {
    return { phase, title: "Waking your workspace", detail: "This takes a few seconds." };
  }
  const after =
    typeof idleMinutes === "number" && idleMinutes > 0
      ? `It sleeps after ${idleMinutes} min idle. Nothing was lost.`
      : "Nothing was lost.";
  return { phase, title: "Sleeping — click or type to wake", detail: after };
}

const ROOT_ID = "cloud-sleep-notice";

const STYLE = `
#${ROOT_ID} {
  /* Centred, clear of the app's top bar and of the notices pinned to the bottom. */
  position: fixed; left: 50%; top: 42%; transform: translate(-50%, -50%);
  z-index: 8500; display: flex; align-items: center; gap: 14px;
  width: max-content; max-width: min(560px, calc(100vw - 24px)); box-sizing: border-box;
  padding: 14px 14px 14px 18px; border-radius: 16px;
  font: 400 13.5px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #f4efe2; background: rgba(18, 15, 9, 0.95);
  border: 1px solid rgba(232, 184, 75, 0.45);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(232, 184, 75, 0.08) inset;
  backdrop-filter: blur(12px);
}
#${ROOT_ID} .csn-icon { flex: none; width: 18px; height: 18px; color: #e8b84b; }
#${ROOT_ID} .csn-text { min-width: 0; }
#${ROOT_ID} .csn-title { font-weight: 600; font-size: 14.5px; color: #f6d27a; display: block; }
#${ROOT_ID} .csn-detail { color: rgba(244, 239, 226, 0.78); display: block; font-size: 12.5px; }
#${ROOT_ID} .csn-cta {
  flex: none; appearance: none; cursor: pointer; padding: 8px 14px; border-radius: 10px;
  font: 600 13px/1 inherit; font-family: inherit; white-space: nowrap; color: #1a1408;
  background: linear-gradient(180deg, #f1cd6f, #d9a436); border: 1px solid rgba(232, 184, 75, 0.6);
}
#${ROOT_ID} .csn-cta:focus-visible { outline: 2px solid #f1cd6f; outline-offset: 2px; }
#${ROOT_ID} .csn-spin {
  flex: none; width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid rgba(232, 184, 75, 0.3); border-top-color: #e8b84b;
  animation: csn-spin 0.9s linear infinite;
}
#cloud-sleep-veil {
  position: fixed; inset: 0; z-index: 8400; pointer-events: none;
  background: rgba(8, 7, 4, 0.34); backdrop-filter: saturate(0.6);
}
@keyframes csn-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { #${ROOT_ID} .csn-spin { animation: none; } }
@media (max-width: 520px) {
  #${ROOT_ID} { width: calc(100vw - 24px); }
  #${ROOT_ID} .csn-text { flex: 1 1 auto; }
}
`;

const MOON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z"/></svg>';

/** Render (or remove) the notice. `onWake` runs when the button is pressed. */
export function renderSleepNotice(
  model: SleepNoticeModel | null,
  onWake: () => void = () => {},
  doc: Document = document,
): void {
  doc.getElementById(ROOT_ID)?.remove();
  doc.getElementById("cloud-sleep-veil")?.remove();
  if (!model) return;

  // A dim, click-through veil: the screen behind is the last one seen, not live.
  const veil = doc.createElement("div");
  veil.id = "cloud-sleep-veil";
  veil.setAttribute("aria-hidden", "true");

  const root = doc.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");
  root.dataset.testid = "cloud-sleep-notice";
  root.dataset.phase = model.phase;

  const style = doc.createElement("style");
  style.textContent = STYLE;
  root.append(style);

  if (model.phase === "waking") {
    const spin = doc.createElement("span");
    spin.className = "csn-spin";
    spin.setAttribute("aria-hidden", "true");
    root.append(spin);
  } else {
    const icon = doc.createElement("span");
    icon.className = "csn-icon";
    icon.innerHTML = MOON;
    root.append(icon);
  }

  const text = doc.createElement("div");
  text.className = "csn-text";
  const title = doc.createElement("span");
  title.className = "csn-title";
  title.textContent = model.title;
  const detail = doc.createElement("span");
  detail.className = "csn-detail";
  detail.textContent = model.detail;
  text.append(title, detail);
  root.append(text);

  if (model.phase === "sleeping") {
    const cta = doc.createElement("button");
    cta.className = "csn-cta";
    cta.type = "button";
    cta.textContent = "Wake";
    cta.dataset.testid = "cloud-sleep-wake";
    cta.addEventListener("click", () => onWake());
    root.append(cta);
  }
  doc.body.append(veil, root);
}

/**
 * Daily usage limit UI for the hosted app (Free: 30 active minutes a day).
 * docs/saas/FREE_PLAN.md.
 *
 *   - meter     a small pill: "38 min left today" with a gold progress ring
 *   - upsells   at 10 min used, 10 min left and 3 min left, each once per usage
 *               day: corner toasts, then a dismissible dialog. Never blocking.
 *               (Thresholds and the odd-limit rules: daily-limit-model.ts.)
 *   - gate      at the limit: full screen, a countdown to the reset, the real
 *               paid plans with an Upgrade CTA into the existing Whop checkout,
 *               and account / billing / sign-out still reachable.
 *
 * The server decides (src/saas/cloud/daily-usage.ts): this tab only reports
 * that it is visible and in use (POST /api/usage/heartbeat), and paints what
 * the server answers. Several tabs heartbeat the same minute; the server counts
 * it once. While the gate is up the tab polls /api/usage, so an upgrade (or an
 * owner grant, or the reset) lifts it without a reload.
 */
import { html, nothing, render, type TemplateResult } from "lit";
import { getClerkToken, getSaasIdentity } from "../saas-clerk";
import { cloudApiBase } from "./cloud-env";
import { openUpgrade } from "./upgrade";
import {
  CHECKOUT_PLAN_IDS,
  countdown,
  gatePlans,
  gateTitle,
  isDailyLimitError,
  meterLabel,
  meterTone,
  nextUpsell,
  passedUpsells,
  resetClock,
  upsellCopy,
  upsellStoreKey,
  usedFraction,
  viewFromLimitError,
  type DailyUsageView,
  type UpgradePlan,
  type UpsellId,
} from "./daily-limit-model";

export { isDailyLimitError } from "./daily-limit-model";

const ROOT_ID = "cloud-daily-limit";
const GATE_POLL_MS = 5_000;
const IDLE_REFRESH_MS = 120_000;

type State = {
  view: DailyUsageView | null;
  plans: UpgradePlan[];
  shown: Set<UpsellId>;
  upsell: UpsellId | null;
  gate: boolean;
  checkoutBusy: string | null;
  checkoutError: string | null;
  billingUrl: string | null;
};

const S: State = {
  view: null,
  plans: [],
  shown: new Set(),
  upsell: null,
  gate: false,
  checkoutBusy: null,
  checkoutError: null,
  billingUrl: null,
};

let started = false;
let root: HTMLElement | null = null;
let lastInputAt = Date.now();
let beatTimer: number | null = null;
let gateTimer: number | null = null;
let tickTimer: number | null = null;
let lastBeatAt = 0;
let lifted: Array<() => void> = [];
let returnFocus: HTMLElement | null = null;

// ── server ──────────────────────────────────────────────────────────────────

async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T | null> {
  const token = await getClerkToken().catch(() => null);
  if (!token) return null;
  try {
    const res = await fetch(`${cloudApiBase()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const json = (await res.json().catch(() => null)) as T | null;
    if (res.status === 402 && isDailyLimitError(json)) {
      applyView(viewFromLimitError(json));
      return null;
    }
    return res.ok ? json : null;
  } catch {
    return null; // offline: keep the last known standing
  }
}

function timezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

async function refresh(): Promise<void> {
  const r = await api<{ usage?: DailyUsageView; upgrade?: UpgradePlan[] }>("GET", "/usage");
  if (r?.upgrade?.length) S.plans = r.upgrade;
  if (r?.usage) applyView(r.usage);
}

async function heartbeat(): Promise<void> {
  const v = S.view;
  if (!v?.limited || S.gate) return;
  const windowMs = (v.activeWindowSeconds ?? 300) * 1000;
  const active = document.visibilityState === "visible" && Date.now() - lastInputAt <= windowMs;
  // An idle-but-visible tab only refreshes now and then; a hidden one never.
  if (!active && (document.visibilityState !== "visible" || Date.now() - lastBeatAt < IDLE_REFRESH_MS)) return;
  lastBeatAt = Date.now();
  const r = await api<{ usage?: DailyUsageView }>("POST", "/usage/heartbeat", { active, timezone: timezone() });
  if (r?.usage) applyView(r.usage);
}

function scheduleBeats(): void {
  if (beatTimer !== null) window.clearInterval(beatTimer);
  const every = Math.max(1, S.view?.heartbeatSeconds ?? 30) * 1000;
  beatTimer = window.setInterval(() => void heartbeat(), every);
}

// ── state ───────────────────────────────────────────────────────────────────

function loadShown(day: string): Set<UpsellId> {
  try {
    const raw = localStorage.getItem(upsellStoreKey(getSaasIdentity()?.userId, day));
    return new Set((raw ? JSON.parse(raw) : []) as UpsellId[]);
  } catch {
    return new Set();
  }
}

function saveShown(day: string): void {
  try {
    localStorage.setItem(upsellStoreKey(getSaasIdentity()?.userId, day), JSON.stringify([...S.shown]));
  } catch {
    /* storage unavailable: once per page instead of once per day */
  }
}

/** Apply a standing from the server (heartbeat, /api/usage, resolve, a 402). */
export function applyView(v: DailyUsageView | null | undefined): void {
  if (!v) return;
  const prevDay = S.view?.day;
  const beatChanged = S.view?.heartbeatSeconds !== v.heartbeatSeconds;
  S.view = v;
  if (v.day !== prevDay) S.shown = loadShown(v.day);
  if (!v.limited) {
    S.upsell = null;
    if (S.gate) liftGate();
    paint();
    return;
  }
  if (v.reached) {
    S.upsell = null;
    openGate();
    return;
  }
  if (S.gate) liftGate();
  const next = nextUpsell(v, S.shown);
  if (next) {
    for (const id of passedUpsells(next)) S.shown.add(id);
    saveShown(v.day);
    S.upsell = next;
  }
  if (beatChanged && started) scheduleBeats();
  paint();
}

function openGate(): void {
  if (!S.gate) {
    S.gate = true;
    returnFocus = document.activeElement as HTMLElement | null;
    window.dispatchEvent(new CustomEvent("infinibot:daily-limit", { detail: { reached: true, usage: S.view } }));
    if (!S.plans.length) void refresh();
  }
  if (gateTimer === null) {
    gateTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, GATE_POLL_MS);
  }
  if (tickTimer === null) tickTimer = window.setInterval(paint, 1000);
  paint();
  // preventScroll: on a phone the headline + countdown must be what shows first.
  queueMicrotask(() => root?.querySelector<HTMLElement>(".dl-gate [data-autofocus]")?.focus({ preventScroll: true }));
}

function liftGate(): void {
  S.gate = false;
  S.checkoutBusy = null;
  S.checkoutError = null;
  if (gateTimer !== null) window.clearInterval(gateTimer);
  if (tickTimer !== null) window.clearInterval(tickTimer);
  gateTimer = tickTimer = null;
  window.dispatchEvent(new CustomEvent("infinibot:daily-limit", { detail: { reached: false, usage: S.view } }));
  const waiters = lifted;
  lifted = [];
  for (const w of waiters) w();
  returnFocus?.focus?.();
  returnFocus = null;
}

// ── actions ─────────────────────────────────────────────────────────────────

/** The existing Whop checkout (POST /api/whop-checkout → hosted checkout URL), via upgrade.ts. */
async function upgrade(plan: string): Promise<void> {
  if (!(CHECKOUT_PLAN_IDS as readonly string[]).includes(plan)) return;
  S.checkoutBusy = plan;
  S.checkoutError = null;
  paint();
  const r = await openUpgrade(plan, { source: "daily-limit" });
  S.checkoutBusy = null;
  if (!r.ok) S.checkoutError = r.error;
  paint();
  // Back from checkout in this tab or another: look again right away.
  void refresh();
}

function dismissUpsell(): void {
  S.upsell = null;
  paint();
}

function openAccount(): void {
  const clerk = (window as unknown as { Clerk?: { openUserProfile?: () => void } }).Clerk;
  clerk?.openUserProfile?.();
}

async function signOut(): Promise<void> {
  const clerk = (window as unknown as { Clerk?: { signOut?: () => Promise<void> } }).Clerk;
  await clerk?.signOut?.().catch(() => {});
  window.location.assign("/");
}

// ── render ──────────────────────────────────────────────────────────────────

const ICON_CHECK = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.4l2.9 2.9 6.1-6.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON_CLOSE = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const ICON_CLOCK = html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.6V8l2.3 1.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const ICON_BOLT = html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.2 1.5L3.5 9h4l-1 5.5L12.5 7h-4z" fill="currentColor"/></svg>`;

function meter(v: DailyUsageView, docked = false): TemplateResult {
  const f = usedFraction(v);
  const r = 8;
  const c = 2 * Math.PI * r;
  return html`<button class="dl-meter ${docked ? "dl-meter--docked" : ""}" data-tone=${meterTone(v)} data-testid="daily-usage-meter"
    title="Free plan: ${v.usedMinutes} of ${v.limitMinutes} active minutes used today. Resets ${resetClock(v.resetsAt)}."
    aria-label="${meterLabel(v)}. Upgrade for unlimited time."
    @click=${() => {
      S.upsell = null;
      void upgrade("pro");
    }}>
    <svg class="dl-ring" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r=${r} class="dl-ring__track"/>
      <circle cx="10" cy="10" r=${r} class="dl-ring__fill" stroke-dasharray=${c} stroke-dashoffset=${c * f} transform="rotate(-90 10 10)"/>
    </svg>
    <span class="dl-meter__text">${meterLabel(v)}</span>
    <span class="dl-meter__cta">Upgrade</span>
  </button>`;
}

function upsellCard(id: UpsellId, v: DailyUsageView): TemplateResult {
  const u = upsellCopy(id, v);
  const body = html`
    <button class="dl-x" aria-label="Dismiss" @click=${dismissUpsell}>${ICON_CLOSE}</button>
    <div class="dl-eyebrow">${ICON_CLOCK}<span>${u.eyebrow}</span></div>
    <h2 class="dl-title" id="dl-upsell-title">${u.title}</h2>
    <p class="dl-body">${u.body}</p>
    <ul class="dl-bullets">${u.bullets.map((b) => html`<li>${ICON_CHECK}<span>${b}</span></li>`)}</ul>
    <div class="dl-actions">
      <button class="dl-btn dl-btn--gold" data-testid="upsell-upgrade" ?disabled=${S.checkoutBusy !== null}
        @click=${() => void upgrade("pro")}>${ICON_BOLT}${S.checkoutBusy === "pro" ? "Opening checkout" : u.cta}</button>
      <button class="dl-btn dl-btn--ghost" data-testid="upsell-dismiss" @click=${dismissUpsell}>Not now</button>
    </div>
    ${S.checkoutError ? html`<p class="dl-err" role="alert">${S.checkoutError}</p>` : nothing}`;
  if (u.style === "modal") {
    return html`<div class="dl-scrim" @click=${dismissUpsell}></div>
      <section class="dl-card dl-modal" role="dialog" aria-modal="false" aria-labelledby="dl-upsell-title"
        data-upsell=${id} data-testid="daily-upsell" @keydown=${(e: KeyboardEvent) => e.key === "Escape" && dismissUpsell()}>${body}</section>`;
  }
  return html`<section class="dl-card dl-toast" role="status" aria-live="polite" aria-labelledby="dl-upsell-title"
    data-upsell=${id} data-testid="daily-upsell">${body}</section>`;
}

function gate(v: DailyUsageView): TemplateResult {
  const plans = gatePlans(S.plans);
  return html`<div class="dl-gate" role="dialog" aria-modal="true" aria-labelledby="dl-gate-title" data-testid="daily-limit-gate"
    @keydown=${trapFocus}>
    <div class="dl-gate__glow" aria-hidden="true"></div>
    <div class="dl-gate__inner">
      <div class="dl-eyebrow dl-eyebrow--center">${ICON_CLOCK}<span>Free plan · daily limit</span></div>
      <h1 class="dl-gate__title" id="dl-gate-title">${gateTitle(v)}</h1>
      <p class="dl-gate__sub">Your workspace is paused until the reset. Everything you built is saved and waiting. Upgrade to keep going right now.</p>
      <div class="dl-countdown" aria-live="off">
        <span class="dl-countdown__label">Resets in</span>
        <span class="dl-countdown__digits" data-testid="gate-countdown">${countdown(v.resetsAt)}</span>
        <span class="dl-countdown__at">${resetClock(v.resetsAt)} your time</span>
      </div>
      <div class="dl-plans">
        ${plans.length
          ? plans.map(
              (p, i) => html`<article class="dl-plan ${p.hot ? "is-hot" : ""}" data-plan=${p.id}>
                ${p.hot ? html`<span class="dl-plan__badge">Most popular</span>` : nothing}
                <h3 class="dl-plan__name">${p.name}</h3>
                <div class="dl-plan__price"><b>$${p.priceUsdMonth}</b><span>/month</span></div>
                <ul class="dl-bullets">${p.perks.map((b) => html`<li>${ICON_CHECK}<span>${b}</span></li>`)}</ul>
                <button class="dl-btn ${p.hot ? "dl-btn--gold" : "dl-btn--line"}" data-testid="gate-upgrade-${p.id}"
                  ?data-autofocus=${p.hot || (i === 0 && !plans.some((x) => x.hot))}
                  ?disabled=${S.checkoutBusy !== null} @click=${() => void upgrade(p.id)}>
                  ${S.checkoutBusy === p.id ? "Opening checkout" : `Upgrade to ${p.name}`}</button>
              </article>`,
            )
          : html`<div class="dl-plans__loading">Loading plans</div>`}
      </div>
      ${S.checkoutError ? html`<p class="dl-err" role="alert">${S.checkoutError}</p>` : nothing}
      <p class="dl-gate__fine">Paid this already? This screen lifts by itself the moment your upgrade goes through.</p>
      <nav class="dl-gate__links" aria-label="Account">
        <button @click=${openAccount}>Account</button>
        ${S.billingUrl ? html`<a href=${S.billingUrl} target="_blank" rel="noopener noreferrer">Billing</a>` : nothing}
        <a href="/pricing" target="_blank" rel="noopener noreferrer">Compare plans</a>
        <button @click=${() => void signOut()}>Sign out</button>
      </nav>
    </div>
  </div>`;
}

function trapFocus(e: KeyboardEvent): void {
  if (e.key !== "Tab") return;
  const items = [...(root?.querySelectorAll<HTMLElement>(".dl-gate button:not([disabled]), .dl-gate a[href]") ?? [])];
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

let dock: HTMLElement | null = null;

/**
 * The meter lives in the app's topbar, right after the plan badge, when the
 * topbar is on screen; otherwise (no app mounted yet, a phone layout that hides
 * it) it falls back to a corner pill. The host is re-docked if the app
 * re-renders it away.
 */
function meterDock(): HTMLElement | null {
  const anchor = document.querySelector<HTMLElement>("header.topbar .topbar-coder-cluster");
  if (!anchor || anchor.offsetParent === null) {
    dock?.remove();
    dock = null;
    return null;
  }
  if (!dock || !dock.isConnected || dock.previousElementSibling !== anchor) {
    dock?.remove();
    dock = document.createElement("span");
    dock.className = "dl-dock";
    dock.dataset.cbItem = "daily-usage";
    anchor.insertAdjacentElement("afterend", dock);
  }
  return dock;
}

let redock: number | null = null;

function paint(): void {
  const v = S.view;
  if (!v?.limited) {
    if (root) render(nothing, root);
    if (dock) render(nothing, dock);
    document.documentElement.classList.remove("dl-gated");
    return;
  }
  if (!root) {
    root = document.createElement("div");
    root.id = ROOT_ID;
    document.body.appendChild(root);
  }
  document.documentElement.classList.toggle("dl-gated", S.gate);
  const docked = S.gate ? null : meterDock();
  if (docked) render(meter(v, true), docked);
  else if (dock) render(nothing, dock);
  // The app mounts (and re-renders its topbar) after the meter starts: look again.
  redock ??= window.setInterval(() => {
    if (S.view?.limited && !S.gate && (!dock?.isConnected || !dock.firstElementChild)) paint();
  }, 2000);
  render(
    html`<style>${STYLE}</style>
      ${S.gate || docked ? nothing : meter(v)}
      ${!S.gate && S.upsell ? upsellCard(S.upsell, v) : nothing}
      ${S.gate ? gate(v) : nothing}`,
    root,
  );
}

// ── public ──────────────────────────────────────────────────────────────────

/** Show the gate from a typed 402 (resolve, a gated API). Never throws. */
export function showDailyLimitGate(body: unknown): void {
  if (isDailyLimitError(body)) applyView(viewFromLimitError(body));
}

/** Resolves once the gate is down (upgrade, owner grant, reset, or the next day). */
export function waitForDailyLimitLift(): Promise<void> {
  if (!S.gate) return Promise.resolve();
  return new Promise((r) => lifted.push(r));
}

/** Start metering this tab and painting the meter / upsells / gate. Idempotent. */
export async function startDailyUsage(initial?: DailyUsageView | null): Promise<void> {
  if (initial) applyView(initial);
  if (started) return;
  started = true;
  const note = () => {
    lastInputAt = Date.now();
  };
  for (const ev of ["pointerdown", "keydown", "wheel", "touchstart"] as const) {
    window.addEventListener(ev, note, { passive: true, capture: true });
  }
  let lastMove = 0;
  window.addEventListener(
    "pointermove",
    () => {
      const now = Date.now();
      if (now - lastMove > 5_000) {
        lastMove = now;
        note();
      }
    },
    { passive: true, capture: true },
  );
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (S.gate) void refresh();
    else void heartbeat();
  });
  window.addEventListener("focus", () => S.gate && void refresh());
  await refresh();
  if (!S.view?.limited) return; // paid plan: nothing is metered from this tab
  void api<{ billing?: { manageUrl?: string | null } }>("GET", "/me").then((me) => {
    const url = me?.billing?.manageUrl;
    S.billingUrl = typeof url === "string" && /^https:\/\//.test(url) ? url : null;
  });
  scheduleBeats();
  void heartbeat();
}

/** Tests / harness: the current state. */
export function dailyLimitState(): Readonly<State> {
  return S;
}

// ── styles (black / gold, matching the console tokens) ──────────────────────

const STYLE = `
#${ROOT_ID}, .dl-dock { --dl-gold: #e8b84b; --dl-gold-2: #f1cd6f; --dl-gold-3: #f6d27a; --dl-ink: #0b0905; --dl-fg: #f4efe2;
  --dl-fg-2: rgba(244, 239, 226, 0.74); --dl-fg-3: rgba(244, 239, 226, 0.5); --dl-line: rgba(232, 184, 75, 0.28);
  --dl-sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --dl-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
  font-family: var(--dl-sans); color: var(--dl-fg); }
#${ROOT_ID} *, .dl-dock * { box-sizing: border-box; }
.dl-dock { display: inline-flex; align-items: center; margin-left: 6px; font-family: var(--dl-sans); }
#${ROOT_ID} svg, .dl-dock svg { width: 14px; height: 14px; flex: none; }

.dl-meter { position: fixed; z-index: 7995; right: max(14px, env(safe-area-inset-right)); bottom: max(14px, env(safe-area-inset-bottom));
  display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 6px 0 9px; border-radius: 999px; cursor: pointer;
  font: 500 12.5px/1 var(--dl-sans); color: var(--dl-fg); background: rgba(14, 11, 6, 0.9);
  border: 1px solid var(--dl-line); box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(232, 184, 75, 0.06);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); transition: border-color .2s, transform .2s; }
.dl-meter--docked { position: static; height: 28px; padding: 0 4px 0 7px; gap: 6px; font-size: 11.5px;
  box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; }
.dl-meter--docked .dl-meter__cta { padding: 4px 8px; font-size: 10.5px; }
.dl-meter:hover { border-color: rgba(232, 184, 75, 0.6); transform: translateY(-1px); }
.dl-meter:focus-visible { outline: 2px solid var(--dl-gold-2); outline-offset: 2px; }
.dl-ring { width: 20px !important; height: 20px !important; }
.dl-ring__track { fill: none; stroke: rgba(244, 239, 226, 0.14); stroke-width: 2.4; }
.dl-ring__fill { fill: none; stroke: var(--dl-gold); stroke-width: 2.4; stroke-linecap: round; transition: stroke-dashoffset .6s ease; }
.dl-meter[data-tone="warn"] .dl-ring__fill { stroke: var(--dl-gold-2); }
.dl-meter[data-tone="low"] { border-color: rgba(241, 120, 80, 0.55); }
.dl-meter[data-tone="low"] .dl-ring__fill { stroke: #f1874f; }
.dl-meter__text { white-space: nowrap; font-variant-numeric: tabular-nums; }
.dl-meter__cta { padding: 6px 10px; border-radius: 999px; font-weight: 600; font-size: 11.5px; color: var(--dl-ink);
  background: linear-gradient(180deg, var(--dl-gold-2), #d9a436); }

.dl-card { position: fixed; z-index: 7996; width: min(380px, calc(100vw - 24px)); padding: 18px 18px 16px;
  border-radius: 16px; background: linear-gradient(180deg, rgba(26, 21, 12, 0.97), rgba(13, 11, 7, 0.97));
  border: 1px solid rgba(232, 184, 75, 0.42);
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(232, 184, 75, 0.06) inset, 0 0 60px rgba(232, 184, 75, 0.06);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); animation: dl-in .32s cubic-bezier(.2, .8, .2, 1) both; }
.dl-toast { right: max(14px, env(safe-area-inset-right)); bottom: calc(max(14px, env(safe-area-inset-bottom)) + 46px); }
.dl-modal { left: 50%; top: 50%; width: min(440px, calc(100vw - 28px)); transform: translate(-50%, -50%); padding: 26px 24px 22px;
  animation-name: dl-pop; z-index: 7998; }
.dl-scrim { position: fixed; inset: 0; z-index: 7997; background: rgba(4, 3, 2, 0.55); backdrop-filter: blur(2px); animation: dl-fade .25s both; }
@keyframes dl-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes dl-pop { from { opacity: 0; transform: translate(-50%, -46%) scale(.98); } to { opacity: 1; transform: translate(-50%, -50%); } }
@keyframes dl-fade { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .dl-card, .dl-scrim, .dl-gate { animation: none !important; } }

.dl-x { position: absolute; top: 10px; right: 10px; width: 28px; height: 28px; display: grid; place-items: center; cursor: pointer;
  border: 0; border-radius: 8px; background: transparent; color: var(--dl-fg-3); }
.dl-x:hover { color: var(--dl-fg); background: rgba(255, 255, 255, 0.06); }
.dl-eyebrow { display: inline-flex; align-items: center; gap: 7px; font: 500 10.5px/1 var(--dl-mono); letter-spacing: .16em;
  text-transform: uppercase; color: var(--dl-gold-3); }
.dl-eyebrow--center { justify-content: center; }
.dl-title { margin: 10px 28px 6px 0; font: 600 18px/1.3 var(--dl-sans); letter-spacing: -0.01em; color: var(--dl-fg); }
.dl-modal .dl-title { font-size: 22px; }
.dl-body { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--dl-fg-2); text-wrap: pretty; }
.dl-bullets { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 7px; font-size: 13px; color: var(--dl-fg); }
.dl-bullets li { display: flex; align-items: flex-start; gap: 8px; }
.dl-bullets svg { color: var(--dl-gold); margin-top: 2px; }
.dl-actions { display: flex; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
.dl-btn { appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 38px; padding: 0 16px;
  border-radius: 10px; cursor: pointer; font: 600 13.5px/1 var(--dl-sans); text-decoration: none; transition: filter .15s, background .15s; }
.dl-btn:focus-visible, .dl-gate__links button:focus-visible, .dl-gate__links a:focus-visible { outline: 2px solid var(--dl-gold-2); outline-offset: 2px; }
.dl-btn[disabled] { opacity: .65; cursor: progress; }
.dl-btn--gold { color: #1a1408; border: 1px solid rgba(232, 184, 75, 0.7); background: linear-gradient(180deg, var(--dl-gold-2), #d9a436);
  box-shadow: 0 6px 18px rgba(232, 184, 75, 0.22); }
.dl-btn--gold:hover { filter: brightness(1.06); }
.dl-btn--ghost { color: var(--dl-fg-2); border: 1px solid transparent; background: transparent; }
.dl-btn--ghost:hover { color: var(--dl-fg); background: rgba(255, 255, 255, 0.05); }
.dl-btn--line { color: var(--dl-gold-3); border: 1px solid rgba(232, 184, 75, 0.45); background: rgba(232, 184, 75, 0.04); }
.dl-btn--line:hover { background: rgba(232, 184, 75, 0.1); }
.dl-err { margin: 10px 0 0; font-size: 12.5px; color: #f1a07a; }

.dl-gate { position: fixed; inset: 0; z-index: 9500; overflow-y: auto; overscroll-behavior: contain;
  background: radial-gradient(1200px 600px at 50% -10%, rgba(232, 184, 75, 0.16), transparent 60%), rgba(6, 5, 3, 0.9);
  backdrop-filter: blur(12px) saturate(.8); -webkit-backdrop-filter: blur(12px) saturate(.8); animation: dl-fade .35s both; }
.dl-gate__glow { position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(600px 300px at 50% 32%, rgba(232, 184, 75, 0.08), transparent 70%); }
.dl-gate__inner { position: relative; max-width: 1040px; margin: 0 auto; padding: clamp(36px, 7vh, 80px) 24px 40px; text-align: center; }
.dl-gate__title { margin: 14px 0 10px; font: 650 clamp(28px, 4.4vw, 44px)/1.1 var(--dl-sans); letter-spacing: -0.02em;
  background: linear-gradient(180deg, #fff6dc, var(--dl-gold-2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.dl-gate__sub { max-width: 560px; margin: 0 auto; font-size: 15px; line-height: 1.6; color: var(--dl-fg-2); text-wrap: pretty; }
.dl-countdown { display: inline-flex; flex-direction: column; align-items: center; gap: 4px; margin: 26px auto 8px; padding: 14px 26px;
  border-radius: 16px; border: 1px solid var(--dl-line); background: rgba(232, 184, 75, 0.04); }
.dl-countdown__label, .dl-countdown__at { font: 500 10.5px/1 var(--dl-mono); letter-spacing: .16em; text-transform: uppercase; color: var(--dl-fg-3); }
.dl-countdown__digits { font: 600 clamp(30px, 5vw, 40px)/1.15 var(--dl-mono); color: var(--dl-gold-3); font-variant-numeric: tabular-nums; letter-spacing: .04em; }
.dl-plans { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; margin: 28px auto 0; text-align: left; }
.dl-plans__loading { grid-column: 1 / -1; padding: 30px; color: var(--dl-fg-3); text-align: center; }
.dl-plan { position: relative; display: flex; flex-direction: column; gap: 4px; padding: 22px 20px 20px; border-radius: 18px;
  background: linear-gradient(180deg, rgba(24, 20, 12, 0.92), rgba(12, 10, 6, 0.92)); border: 1px solid rgba(244, 239, 226, 0.1); }
.dl-plan.is-hot { border-color: rgba(232, 184, 75, 0.6); box-shadow: 0 0 0 1px rgba(232, 184, 75, 0.15) inset, 0 20px 60px rgba(232, 184, 75, 0.12); }
.dl-plan__badge { position: absolute; top: -11px; left: 20px; padding: 5px 10px; border-radius: 999px; font: 600 10px/1 var(--dl-mono);
  letter-spacing: .12em; text-transform: uppercase; color: #1a1408; background: linear-gradient(180deg, var(--dl-gold-2), #d9a436); }
.dl-plan__name { margin: 0; font: 600 16px/1.3 var(--dl-sans); color: var(--dl-fg); }
.dl-plan__price { display: flex; align-items: baseline; gap: 4px; margin-bottom: 4px; }
.dl-plan__price b { font: 650 32px/1.1 var(--dl-sans); letter-spacing: -0.02em; color: var(--dl-fg); }
.dl-plan__price span { color: var(--dl-fg-3); font-size: 13px; }
.dl-plan .dl-bullets { flex: 1; margin-bottom: 18px; }
.dl-plan .dl-btn { width: 100%; }
.dl-gate__fine { margin: 22px 0 0; font-size: 12.5px; color: var(--dl-fg-3); }
.dl-gate__links { display: flex; justify-content: center; flex-wrap: wrap; gap: 6px 18px; margin-top: 14px; }
.dl-gate__links button, .dl-gate__links a { appearance: none; border: 0; background: none; cursor: pointer; padding: 6px 2px;
  font: 500 13px/1 var(--dl-sans); color: var(--dl-fg-2); text-decoration: none; border-bottom: 1px solid transparent; }
.dl-gate__links button:hover, .dl-gate__links a:hover { color: var(--dl-gold-3); border-bottom-color: rgba(232, 184, 75, 0.4); }
html.dl-gated, html.dl-gated body { overflow: hidden; }

@media (max-width: 860px) {
  .dl-plans { grid-template-columns: minmax(0, 1fr); max-width: 440px; }
}
@media (max-width: 520px) {
  .dl-meter__cta { display: none; }
  .dl-toast { left: 12px; right: 12px; width: auto; }
  .dl-gate__inner { padding: 34px 16px 32px; }
  .dl-countdown { padding: 12px 18px; }
}
`;

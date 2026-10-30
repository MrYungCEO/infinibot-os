/**
 * Hosted cloud connect flow (VITE_INFINIBOT_CLOUD=1).
 *
 * The cloud build serves the FULL control UI (app.ts), the same shell as a
 * local install. What differs is where its gateway lives: every tenant has
 * its own InfiniBot gateway on a Fly Machine that suspends when idle. After
 * the Clerk gate, this module asks the fleet orchestrator where that gateway
 * is (docs/saas/FLEET_BUILD_PLAN.md, contract section 1):
 *
 *   POST {VITE_ORCHESTRATOR_URL}/fleet/resolve   Authorization: Bearer <Clerk JWT>
 *     200 { gatewayWsUrl, machineId, region, status: "ready", tenantId }
 *     200 { mode: "serverless", plan, entitlements }  the plan has no private gateway
 *                                      (src/fleet/admin/plans.ts): no Machine to wake
 *     402 { code: "daily_limit_reached", resetsAt, usage }  the plan's daily usage limit
 *                                      (hosted Free) is used up: the upgrade gate goes up
 *                                      (daily-limit.ts) and resolve runs again once it lifts
 *     409 { status: "provisioning" }   cold provision in flight: poll with backoff
 *     401                              bad/absent JWT: sign in again
 *     503                              wake failed: offer a retry
 *
 * While it waits, the workspace loader (workspace-loader.ts) says which step is
 * running; this module only reports what resolve answered. Once resolved, the real <infinibot-app> is created with the
 * resolved URL and GatewayBrowserClient authenticates with the member's Clerk
 * token (gateway.ts does that itself in SaaS mode).
 *
 * The gateway URL is never baked into the bundle and never read from storage:
 * it only ever comes from resolve() at runtime.
 */
import { html, nothing, render, type TemplateResult } from "lit";
import {
  configureWorkspaceLoader,
  hideWorkspaceLoader,
  showWorkspaceLoader,
  workspaceSignal,
} from "./workspace-loader";
import { BRAND_DEFAULT_LOGO } from "../views/branding-modal";
import { getClerkToken, onSaasSessionEnd, saasReauthenticate } from "../saas-clerk";
import { renderTerminalGround, terminalAmbientStyles } from "../saas-terminal-ambient";
import { installGatewayRouting, setResolvedGatewayUrl } from "../gateway-endpoint";
import { type CloudFairUse, showFairUseBanner } from "./fair-use-banner";
import {
  configureGatewaySleep,
  gatewaySleepConfig,
  installInputTracking,
  onSleepChange,
  requestWake,
  setWakeHandler,
  sleepPhase,
} from "./gateway-sleep";
import { renderSleepNotice, sleepNoticeModel } from "./sleep-notice";
import type { DailyUsageView } from "./daily-limit-model";

export type FleetResolved = {
  gatewayWsUrl: string;
  machineId?: string;
  region?: string;
  status?: string;
  tenantId?: string;
  /** "wake" = the Machine sleeps when idle (Starter); the app then shows "Sleeping". */
  runMode?: "wake" | "always-on";
  /** Wake mode: minutes without real activity before it sleeps. */
  idleMinutes?: number;
  /** Wake-mode plans with a fair-use cap: this month's active hours. */
  fairUse?: CloudFairUse;
  /** Plans with a daily usage limit (hosted Free): today's standing. */
  dailyUsage?: DailyUsageView;
  /** The Clerk token that resolved this gateway — handed to the app so its first
   *  WS connect always has one even if getClerkToken races to null after boot. */
  clerkToken?: string;
};

/** What the tenant's plan grants (orchestrator plan-model.ts `Entitlements`). */
export type FleetEntitlements = {
  plan: string;
  planName?: string;
  mode: "gateway" | "serverless";
  features: Record<string, boolean>;
  locked: string[];
};

export type FleetResolveResult =
  | { kind: "ready"; resolved: FleetResolved }
  | { kind: "serverless"; plan: string; entitlements: FleetEntitlements | null }
  | { kind: "provisioning"; retryAfterMs: number | null }
  | { kind: "unauthorized" }
  | { kind: "daily-limit"; body: Record<string, unknown> }
  | { kind: "unavailable"; message: string; status?: number; plan?: string };

/** Orchestrator base URL; empty = same origin (Netlify can proxy /fleet/*). */
export function orchestratorBase(): string {
  const raw = (import.meta.env.VITE_ORCHESTRATOR_URL as string | undefined)?.trim() ?? "";
  return raw.replace(/\/+$/, "");
}

/**
 * Accept only an absolute ws(s) URL. Plain ws is allowed only when the page
 * itself is plain http on a loopback host (local testing of the cloud build):
 * a TLS page must never hand the member's Clerk token to an unencrypted socket.
 */
export function validateGatewayWsUrl(raw: unknown, page: Location = window.location): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol === "wss:") return url.toString();
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(page.hostname);
  if (url.protocol === "ws:" && page.protocol === "http:" && loopback) return url.toString();
  return null;
}

function retryAfterMs(res: Response, body: unknown): number | null {
  const b = body as { retryAfterMs?: unknown } | null;
  if (typeof b?.retryAfterMs === "number" && b.retryAfterMs > 0) return b.retryAfterMs;
  const header = Number(res.headers.get("retry-after"));
  return Number.isFinite(header) && header > 0 ? header * 1000 : null;
}

/** One resolve call. Network failures and unexpected statuses are "unavailable". */
export async function resolveFleetGateway(token: string, signal?: AbortSignal): Promise<FleetResolveResult> {
  let res: Response;
  try {
    res = await fetch(`${orchestratorBase()}/fleet/resolve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
      credentials: "omit",
      cache: "no-store",
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    return { kind: "unavailable", status: 0, message: "Couldn't reach the workspace service. Check your connection." };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.status === 200 && body?.mode === "serverless") {
    const ent = body.entitlements as FleetEntitlements | undefined;
    return {
      kind: "serverless",
      plan: typeof body.plan === "string" ? body.plan : "free",
      entitlements: ent && typeof ent === "object" ? ent : null,
    };
  }
  if (res.status === 200) {
    const url = validateGatewayWsUrl(body?.gatewayWsUrl);
    if (!url) return { kind: "unavailable", message: "The workspace service returned an invalid address." };
    return { kind: "ready", resolved: { ...(body as FleetResolved), gatewayWsUrl: url } };
  }
  if (res.status === 409) return { kind: "provisioning", retryAfterMs: retryAfterMs(res, body) };
  if (res.status === 402 && body && (body.code === "daily_limit_reached" || body.status === "daily_limit_reached")) {
    return { kind: "daily-limit", body };
  }
  if (res.status === 401 || res.status === 403) return { kind: "unauthorized" };
  const detail = typeof body?.error === "string" ? body.error : null;
  return {
    kind: "unavailable",
    status: res.status,
    ...(typeof body?.plan === "string" ? { plan: body.plan } : {}),
    message:
      res.status === 503
        ? "Your workspace didn't wake up. This is usually brief."
        : `The workspace service answered ${res.status}${detail ? ` (${detail})` : ""}.`,
  };
}

// ── Waking screen ───────────────────────────────────────────────────────────

type Screen =
  | { kind: "waking"; attempt: number; provisioning: boolean; startedAt: number }
  | { kind: "slow"; startedAt: number }
  | { kind: "unavailable"; message: string; status?: number; plan?: string }
  | { kind: "serverless"; plan: string; entitlements: FleetEntitlements | null }
  | { kind: "signin" };

let root: HTMLElement | null = null;
let screen: Screen | null = null;

function fleetRoot(): HTMLElement {
  if (!root) {
    root = document.createElement("div");
    root.id = "fleet-connect-root";
    document.body.appendChild(root);
  }
  return root;
}

function renderMark(): TemplateResult {
  return html`<div class="sob-boot__mark">
    <span class="sob-boot__ring"></span>
    <span class="sob-boot__ring sob-boot__ring--sweep"></span>
    <img src=${BRAND_DEFAULT_LOGO} alt="" />
  </div>`;
}

const CAPABILITY_NAMES: Record<string, string> = {
  data: "Projects, notes & CRM",
  channels: "Channels",
  agents: "Agents",
  voice: "Voice",
  terminals: "Terminals",
  mcp: "MCP tools",
  always_on: "Always-on workspace",
  cron: "Scheduled jobs",
  whatsapp: "WhatsApp",
  wake_on_schedule: "Wakes for scheduled jobs",
};

function serverlessView(s: Extract<Screen, { kind: "serverless" }>): TemplateResult {
  const e = s.entitlements;
  // Boolean capabilities only: counts (parallel_agents, browser_sessions) and
  // run_mode are plan facts, not list items.
  const included = e ? Object.keys(e.features).filter((k) => e.features[k] === true) : [];
  return html`<div class="sob-screen sob-boot fc-screen" role="status" data-fleet-state="serverless">
    ${renderTerminalGround()}
    <div class="sob-boot__core fc-core">
      ${renderMark()}
      <div class="sob-boot__title">InfiniBot Cloud</div>
      <h1 class="fc-headline">${e?.planName ?? s.plan} plan</h1>
      <p class="fc-sub">
        Your plan runs on the serverless data plane, so there is no private gateway to start.
        Agents, voice and terminals need a plan with a private gateway.
      </p>
      <ol class="fc-steps">
        ${included.map((k) => html`<li class="fc-step fc-step--done"><span class="fc-step__dot"></span>${CAPABILITY_NAMES[k] ?? k}</li>`)}
        ${(e?.locked ?? []).map((k) => html`<li class="fc-step fc-step--idle"><span class="fc-step__dot"></span>${CAPABILITY_NAMES[k] ?? k} · upgrade</li>`)}
      </ol>
    </div>
  </div>`;
}

let retryHandler: () => void = () => {};
configureWorkspaceLoader({ onRetry: () => retryHandler(), onSignIn: () => void saasReauthenticate() });

/**
 * Only the serverless plan screen is painted here. Every other state is
 * reported to the workspace loader, which owns the waking / error screens.
 */
function show(next: Screen) {
  if (next.kind === "waking") return workspaceSignal({ type: "resolve-pending", provisioning: next.provisioning });
  if (next.kind === "slow") return workspaceSignal({ type: "resolve-pending", provisioning: true });
  if (next.kind === "signin") return workspaceSignal({ type: "signin-required" });
  if (next.kind === "unavailable") {
    return workspaceSignal({ type: "resolve-failed", message: next.message, status: next.status, plan: next.plan });
  }
  hideWorkspaceLoader();
  screen = next;
  render(html`${terminalAmbientStyles()}${fleetStyles()}${serverlessView(next)}`, fleetRoot());
}

function clearScreen() {
  screen = null;
  if (root) {
    render(nothing, root);
    root.remove();
    root = null;
  }
}

// ── Resolve loop ────────────────────────────────────────────────────────────

/** Backoff for 409 polling: 1s, 1.5s, 2.25s … capped at 8s. */
export function backoffMs(attempt: number): number {
  return Math.min(8000, Math.round(1000 * 1.5 ** Math.max(0, attempt - 1)));
}
/** After this long provisioning, show the "slow" state (polling continues). */
const SLOW_AFTER_MS = 90_000;
/** Give up polling after this long and ask the member to retry. */
const GIVE_UP_AFTER_MS = 5 * 60_000;
/** Don't flash the waking screen for a warm Machine that answers fast. */
const SHOW_AFTER_MS = 300;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

/**
 * Resolve the tenant gateway, showing the waking screen while it starts.
 * Resolves with the gateway URL; stays pending (with an actionable screen) on
 * 401/503 until the member retries or signs in again.
 */
export function resolveTenantGateway(): Promise<FleetResolved> {
  const abort = new AbortController();
  onSaasSessionEnd(() => {
    abort.abort();
    clearScreen();
    hideWorkspaceLoader();
  });
  return new Promise<FleetResolved>((done) => {
    const run = async () => {
      const startedAt = Date.now();
      let attempt = 0;
      let freshToken = false;
      workspaceSignal({ type: "resolve-start" });
      const reveal = window.setTimeout(
        () => show({ kind: "waking", attempt: 1, provisioning: false, startedAt }),
        SHOW_AFTER_MS,
      );
      try {
        for (;;) {
          attempt += 1;
          const token = await getClerkToken({ fresh: freshToken });
          if (!token) {
            // No Clerk session (the sign-in gate is already on screen).
            window.clearTimeout(reveal);
            show({ kind: "signin" });
            return;
          }
          const result = await resolveFleetGateway(token, abort.signal);
          if (result.kind === "ready") {
            window.clearTimeout(reveal);
            workspaceSignal({ type: "resolve-ready" });
            // Hand the working token to the app so its first WS connect always
            // has one, even if getClerkToken races to null right after boot.
            done({ ...result.resolved, clerkToken: token });
            return;
          }
          if (result.kind === "serverless") {
            // No Machine for this plan: publish the entitlements for gating and
            // stay on the plan screen (never connect a gateway).
            window.clearTimeout(reveal);
            (window as unknown as { __INFINIBOT_ENTITLEMENTS__?: unknown }).__INFINIBOT_ENTITLEMENTS__ =
              result.entitlements;
            window.dispatchEvent(new CustomEvent("infinibot:entitlements", { detail: result.entitlements }));
            show({ kind: "serverless", plan: result.plan, entitlements: result.entitlements });
            return;
          }
          if (result.kind === "unauthorized") {
            // One retry with a re-minted token (clock skew / just-expired JWT).
            if (!freshToken) {
              freshToken = true;
              continue;
            }
            window.clearTimeout(reveal);
            show({ kind: "signin" });
            return;
          }
          freshToken = false;
          if (result.kind === "daily-limit") {
            // Hosted Free used today's free minutes: the upgrade gate owns the screen.
            // Resolve again once it lifts (upgrade, owner grant, the reset),
            // so the workspace comes back without a reload.
            window.clearTimeout(reveal);
            clearScreen();
            hideWorkspaceLoader();
            const limit = await import("./daily-limit");
            limit.showDailyLimitGate(result.body);
            void limit.startDailyUsage();
            await limit.waitForDailyLimitLift();
            attempt = 0;
            continue;
          }
          if (result.kind === "unavailable") {
            window.clearTimeout(reveal);
            show({ kind: "unavailable", message: result.message, status: result.status, plan: result.plan });
            return;
          }
          // 409 provisioning: keep polling behind the waking screen.
          const waited = Date.now() - startedAt;
          if (waited > GIVE_UP_AFTER_MS) {
            window.clearTimeout(reveal);
            show({ kind: "unavailable", message: "Your workspace is taking too long to start." });
            return;
          }
          window.clearTimeout(reveal);
          show(
            waited > SLOW_AFTER_MS
              ? { kind: "slow", startedAt }
              : { kind: "waking", attempt, provisioning: true, startedAt },
          );
          await sleep(result.retryAfterMs ?? backoffMs(attempt), abort.signal);
        }
      } catch {
        window.clearTimeout(reveal);
        // Aborted: the session ended and saas-clerk owns the screen now.
      }
    };
    retryHandler = () => void run();
    void run();
  });
}

// ── Full app boot ───────────────────────────────────────────────────────────

type AppElement = HTMLElement & { settings: { gatewayUrl: string } & Record<string, unknown> };

/**
 * Mount the FULL control UI against the resolved tenant gateway.
 *
 * index.html ships an un-upgraded <infinibot-app>; if app.ts were imported
 * with it in place, the element would upgrade and connect straight away with
 * the cloud default (no URL). So it is detached first, app.ts is imported
 * (defining the element), and a fresh element is created, given the resolved
 * URL, and only then attached — connectedCallback opens the socket to it.
 */
export async function bootFullApp(resolved: FleetResolved): Promise<void> {
  const placeholder = document.querySelector("infinibot-app");
  const parent = placeholder?.parentNode ?? document.body;
  const next = placeholder?.nextSibling ?? null;
  placeholder?.remove();

  // Every gateway REST/WS endpoint (not just the RPC socket) now targets the
  // tenant Machine instead of this static page's origin.
  setResolvedGatewayUrl(resolved.gatewayWsUrl);
  installGatewayRouting();

  await import("../app").catch(async () => {
    await new Promise((r) => setTimeout(r, 800)); // one retry on a network blip
    return import("../app");
  });

  const el = document.createElement("infinibot-app") as AppElement;
  el.settings = {
    ...el.settings,
    gatewayUrl: resolved.gatewayWsUrl,
    ...(resolved.clerkToken ? { token: resolved.clerkToken } : {}),
  };
  el.dataset.fleetMachine = resolved.machineId ?? "";
  parent.insertBefore(el, next);
  clearScreen();
}

/** Apply what resolve said about sleep + fair use (boot, and again on every wake). */
export function applySleepAndFairUse(resolved: FleetResolved): void {
  configureGatewaySleep(
    resolved.runMode === "wake"
      ? { runMode: "wake", idleMinutes: resolved.idleMinutes }
      : { runMode: "always-on" },
  );
  showFairUseBanner(resolved.fairUse ?? null, pricingHref());
  // Channels the plan leaves out (Free: Telegram, Slack) from /api/me; [] on paid plans.
  void import("./plan-channels").then((m) => m.loadPlanChannels()).catch(() => {});
  // Hosted Free: the usage meter, upsells and gate (only plans with a daily limit).
  if (resolved.dailyUsage?.limited) {
    void import("./daily-limit").then((m) => m.startDailyUsage(resolved.dailyUsage)).catch(() => {});
  }
}

/** The marketing site's pricing page (it owns the origin's root; the app lives under a base path). */
function pricingHref(): string {
  return new URL("/pricing", window.location.origin).toString();
}

/**
 * "Sleeping — click or type to wake" for wake-mode workspaces (gateway-sleep.ts).
 * The wake goes through resolve, which is what starts the Machine; only then
 * do the parked sockets reconnect.
 */
export function mountSleepUi(): void {
  installInputTracking();
  setWakeHandler(async () => {
    showWorkspaceLoader({ phase: "waking", reason: "sleep" });
    const again = await resolveTenantGateway();
    clearScreen(); // the "waking your workspace" screen, when the wake took long enough to show it
    setResolvedGatewayUrl(again.gatewayWsUrl);
    applySleepAndFairUse(again);
    return true;
  });
  const paint = () =>
    renderSleepNotice(sleepNoticeModel(sleepPhase(), gatewaySleepConfig()?.idleMinutes), () => {
      void requestWake();
    });
  onSleepChange(paint);
  paint();
}

/** Cloud boot: resolve the tenant gateway, then mount the full app on it. */
export async function runFleetBoot(): Promise<void> {
  if (document.body) delete document.body.dataset.authRoute;
  // Non-blocking "payment failed" notice while the tenant is in its grace period.
  void import("./billing-banner").then((m) => m.mountBillingBanner()).catch(() => {});
  const resolved = await resolveTenantGateway();
  applySleepAndFairUse(resolved);
  mountSleepUi();
  await bootFullApp(resolved);
}

function fleetStyles(): TemplateResult {
  return html`<style>
    #fleet-connect-root .fc-screen { z-index: 9000; }
    .fc-core { max-width: min(460px, calc(100vw - 48px)); text-align: center; }
    .fc-headline {
      margin: 4px 0 0; font-family: var(--sob-sans); font-weight: 600;
      font-size: clamp(22px, 3.2vw, 28px); letter-spacing: -0.01em; color: var(--sob-fg);
    }
    .fc-sub { margin: 0; color: var(--sob-fg-2); font-size: 14px; line-height: 1.6; }
    .fc-steps {
      list-style: none; margin: 6px 0 0; padding: 14px 18px; display: grid; gap: 8px;
      text-align: left; width: 100%; box-sizing: border-box;
      font-family: var(--sob-mono); font-size: 12px; color: var(--sob-fg-3);
      border: 1px solid var(--sob-line); border-radius: 12px;
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));
      backdrop-filter: blur(10px);
    }
    .fc-step { display: flex; align-items: center; gap: 10px; }
    .fc-step__dot {
      width: 7px; height: 7px; border-radius: 50%; flex: none;
      border: 1px solid var(--sob-fg-4); background: transparent;
    }
    .fc-step--done { color: var(--sob-fg-2); }
    .fc-step--done .fc-step__dot { background: var(--sob-ok); border-color: var(--sob-ok); }
    .fc-step--active { color: var(--sob-gold); text-shadow: var(--sob-text-glow); }
    .fc-step--active .fc-step__dot {
      background: var(--sob-gold); border-color: var(--sob-gold); box-shadow: var(--sob-glow-soft);
      animation: fc-pulse 1.4s var(--sob-ease) infinite;
    }
    .fc-bar { width: 100%; }
    .fc-meta {
      display: flex; gap: 14px; justify-content: center;
      font-family: var(--sob-mono); font-size: 11px; letter-spacing: 0.08em;
      text-transform: uppercase; color: var(--sob-fg-4);
    }
    .fc-actions { display: flex; gap: 10px; justify-content: center; margin-top: 6px; }
    .fc-btn {
      appearance: none; cursor: pointer; padding: 10px 22px; border-radius: 10px;
      font: 600 13px/1 var(--sob-sans); letter-spacing: 0.02em; color: var(--sob-ink);
      background: linear-gradient(180deg, var(--sob-gold), var(--sob-amber));
      border: 1px solid color-mix(in srgb, var(--sob-gold) 60%, transparent);
      box-shadow: var(--sob-glow-soft);
      transition: transform 0.2s var(--sob-ease), box-shadow 0.2s var(--sob-ease);
    }
    .fc-btn:hover { transform: translateY(-1px); box-shadow: var(--sob-glow); }
    .fc-btn:focus-visible { outline: 2px solid var(--sob-gold); outline-offset: 3px; }
    @keyframes fc-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    @media (prefers-reduced-motion: reduce) { .fc-step--active .fc-step__dot { animation: none; } }
  </style>`;
}

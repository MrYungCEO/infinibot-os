/**
 * Hosted cloud setup gate (VITE_INFINIBOT_CLOUD=1), run after the Clerk gate
 * and BEFORE the fleet connect flow (fleet-connect.ts).
 *
 * The quickstart used to exist only inside the full app, which mounts once a
 * member's private gateway resolves. A member whose plan has no private
 * gateway (free: the orchestrator answers /fleet/resolve with 402
 * upgrade_required) therefore never saw a single setup step: just a dead
 * "Workspace unavailable" screen. This gate gives those members the same
 * quickstart against the serverless account surface (Netlify Functions +
 * Neon, CloudApiClient), where every step that needs a gateway is shown as
 * "available on hosted plans" and can be skipped.
 *
 *   plan with a private gateway → resolves "workspace" (the gateway's own
 *                                 quickstart runs inside the app, as before)
 *   serverless plan, not set up → the quickstart steps
 *   serverless plan, set up     → what is saved + how to get a hosted workspace
 *
 * The page is never empty: a boot screen while the account loads, an error
 * with Retry when it can't be read (render-state logic: saas-setup-state.ts).
 * The fleet flow's resolve/polling is not touched; this only decides whether
 * it runs.
 */
import { html, nothing, render, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "../gateway";
import { renderSaasAccountMenu } from "../saas-auth-views";
import { getSaasIdentity, onSaasSessionEnd } from "../saas-clerk";
import {
  cloudSetupView,
  describeSetupError,
  ACCOUNT_TIMEOUT_MS,
  channelsExcludedOf,
  isServerlessPlan,
  withTimeout,
  type CloudMe,
  type CloudSetupState,
} from "../saas-setup-state";
import {
  renderSaasBootScreen,
  renderSaasSetupNotice,
  renderTerminalGround,
  terminalAmbientStyles,
} from "../saas-terminal-ambient";
import { BRAND_DEFAULT_LOGO } from "../views/branding-modal";
import type { OnboardingStatus } from "../views/saas-onboarding";
import { CloudApiClient } from "./cloud-api";
import { setChannelsExcluded } from "./plan-channels";
import { hideWorkspaceLoader } from "./workspace-loader";

type OnboardingModule = typeof import("../views/saas-onboarding");
type Me = CloudMe & { profile?: { assistant?: { name?: string | null }; model?: string | null } };

const BOOT_LINES = ["Session verified", "Loading your account", "Preparing your setup"];
/** Don't flash the boot screen when the account answers fast. */
const SHOW_AFTER_MS = 250;
/** The free desktop app / self-host download (the source repo is private, so never link GitHub). */
const SELF_HOST_URL = "https://infinibotos.com/download";
const PRICING_PATH = "/pricing/";

// Last known "this member has a private gateway", so a returning paid member
// goes straight to the fleet flow without waiting on /api/me first.
const HINT_KEY = "infinibot.cloud.gatewayPlan.v1";

function hintedGatewayPlan(userId: string | undefined): boolean {
  if (!userId) return false;
  try {
    return localStorage.getItem(HINT_KEY) === userId;
  } catch {
    return false;
  }
}

function rememberPlan(userId: string | undefined, gateway: boolean): void {
  if (!userId) return;
  try {
    if (gateway) localStorage.setItem(HINT_KEY, userId);
    else if (localStorage.getItem(HINT_KEY) === userId) localStorage.removeItem(HINT_KEY);
  } catch {
    /* storage unavailable: the plan is just read again next load */
  }
}

const client = new CloudApiClient();
const gatewayShaped = client as unknown as GatewayBrowserClient;

type State = CloudSetupState & {
  me: Me | null;
  status: OnboardingStatus | null;
  mod: OnboardingModule | null;
  /** The boot screen is held back briefly so a fast answer never flashes it. */
  revealed: boolean;
};

const S: State = { loading: true, error: null, me: null, status: null, viewReady: false, mod: null, revealed: false };
let root: HTMLElement | null = null;
let scheduled = false;
let finish: ((outcome: "workspace" | "stay") => void) | null = null;

function setupRoot(): HTMLElement {
  if (!root) {
    root = document.createElement("div");
    root.id = "cloud-setup-root";
    document.body.appendChild(root);
  }
  return root;
}

function requestUpdate(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    paint();
  });
}

function teardown(): void {
  if (root) {
    render(nothing, root);
    root.remove();
    root = null;
  }
}

/** Lazy chunk: retry a failed fetch (network blip) before giving up. */
async function importQuickstart(tries = 3): Promise<OnboardingModule> {
  for (let i = 1; ; i++) {
    try {
      return await import("../views/saas-onboarding");
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 600 * i));
    }
  }
}

async function load(): Promise<void> {
  S.loading = true;
  S.error = null;
  requestUpdate();
  try {
    const me = await withTimeout(client.request<Me>("saas.me"), ACCOUNT_TIMEOUT_MS, "Your account");
    S.me = me;
    setChannelsExcluded(channelsExcludedOf(me));
    const serverless = isServerlessPlan(me);
    rememberPlan(getSaasIdentity()?.userId, !serverless);
    if (serverless) {
      S.status = await withTimeout(
        client.request<OnboardingStatus>("saas.onboarding.status"),
        ACCOUNT_TIMEOUT_MS,
        "Your setup",
      );
      if (S.status.required) {
        S.mod = await importQuickstart();
        S.viewReady = true;
      }
    }
  } catch (err) {
    console.warn("[cloud] setup could not be loaded:", err);
    S.error = err;
  }
  S.loading = false;
  settle();
}

/** Hand over to the fleet flow, or keep this surface on screen. */
function settle(): void {
  if (cloudSetupView(S) === "workspace") {
    proceed("workspace");
    return;
  }
  // This surface keeps the page (steps, saved setup or an error): no gateway is
  // being resolved, so the workspace loader that main.ts started at sign-in
  // would sit on top of it at "Waking your workspace" for good.
  hideWorkspaceLoader();
  S.revealed = true;
  requestUpdate();
}

function proceed(outcome: "workspace" | "stay"): void {
  if (outcome === "workspace") teardown();
  finish?.(outcome);
  finish = null;
}

function accountMenu(): TemplateResult {
  return renderSaasAccountMenu({ client: gatewayShaped, requestUpdate, variant: "floating" });
}

function hostedPlansView(): TemplateResult {
  const assistant = S.status?.assistant?.name ?? S.me?.profile?.assistant?.name ?? null;
  const model = S.status?.model ?? S.me?.profile?.model ?? null;
  const business = (S.status?.business as { name?: string } | null | undefined)?.name ?? null;
  const rows: Array<[string, string | null]> = [
    ["Assistant", assistant],
    ["Model", model],
    ["Business", business],
  ];
  return html`${terminalAmbientStyles()}${hostedStyles()}
    <div class="sob-screen sob-boot" data-testid="cloud-setup-hosted">
      ${renderTerminalGround()}
      <div class="sob-boot__core chp-core">
        <div class="sob-boot__mark">
          <span class="sob-boot__ring"></span>
          <img src=${BRAND_DEFAULT_LOGO} alt="" />
        </div>
        <div class="sob-boot__title">InfiniBot Cloud</div>
        <h1 class="chp-title">Your setup is saved</h1>
        <p class="chp-sub">
          This is saved to your account. To open a hosted workspace you need a hosted plan, which runs
          InfiniBot on your own private cloud machine. You can also self-host it for free.
        </p>
        <dl class="chp-list">
          ${rows.map(
            ([label, value]) => html`<div class="chp-row ${value ? "is-set" : ""}">
              <dt><span class="chp-dot"></span>${label}</dt>
              <dd>${value ?? "Not set"}</dd>
            </div>`,
          )}
        </dl>
        <div class="chp-actions">
          <a class="chp-btn is-primary" data-testid="cloud-setup-plans" href=${PRICING_PATH}>See hosted plans</a>
          <a class="chp-btn" data-testid="cloud-setup-selfhost" href=${SELF_HOST_URL} target="_blank" rel="noopener"
            >Self-host for free</a
          >
        </div>
        <button type="button" class="chp-link" data-testid="cloud-setup-recheck" @click=${() => void load()}>
          Already upgraded? Check again
        </button>
      </div>
    </div>
    ${accountMenu()}`;
}

function view(): TemplateResult {
  const which = cloudSetupView(S);
  if (which === "error") {
    return html`${renderSaasSetupNotice({
      testid: "cloud-setup-error",
      title: "Couldn't load your setup",
      detail: describeSetupError(S.error),
      actions: [
        { label: "Try again", primary: true, testid: "cloud-setup-retry", onClick: () => void load() },
        // The fleet flow has its own waking / error screens: a member with a
        // private gateway is never held here by a failing account read.
        { label: "Continue to workspace", testid: "cloud-setup-continue", onClick: () => proceed("workspace") },
      ],
    })}${accountMenu()}`;
  }
  if (which === "steps" && S.mod && S.status) {
    const mod = S.mod;
    return html`${mod.renderSaasOnboarding({
      client: gatewayShaped,
      status: S.status,
      email: S.me?.email ?? getSaasIdentity()?.email ?? null,
      requestUpdate,
      onDone: (status) => {
        mod.resetSaasOnboarding();
        S.status = { ...status, required: false };
        S.mod = null;
        S.viewReady = false;
        requestUpdate();
      },
    })}${accountMenu()}`;
  }
  if (which === "hosted-plans") return hostedPlansView();
  return renderSaasBootScreen(BOOT_LINES);
}

function paint(): void {
  if (!S.revealed && !root) return;
  if (document.body) document.body.dataset.authRoute = "1";
  render(view(), setupRoot());
}

/**
 * Resolves "workspace" when the fleet connect flow should run (the member has,
 * or may have, a private gateway). Stays pending while this surface owns the
 * page (serverless setup, the hosted-plans screen, or an error with Retry).
 */
export function runCloudSetupGate(): Promise<"workspace" | "stay"> {
  onSaasSessionEnd(teardown);
  if (hintedGatewayPlan(getSaasIdentity()?.userId)) {
    // Returning paid member: no wait. The plan is re-read in the background so
    // a downgrade is picked up on the next load.
    void client
      .request<Me>("saas.me")
      .then((me) => rememberPlan(getSaasIdentity()?.userId, !isServerlessPlan(me)))
      .catch(() => undefined);
    return Promise.resolve("workspace");
  }
  return new Promise((resolve) => {
    finish = resolve;
    window.setTimeout(() => {
      if (!finish) return;
      S.revealed = true;
      requestUpdate();
    }, SHOW_AFTER_MS);
    void load();
  });
}

function hostedStyles(): TemplateResult {
  return html`<style>
    .chp-core { max-width: min(500px, calc(100vw - 40px)); text-align: center; }
    .chp-title {
      margin: 4px 0 0; font: 600 clamp(22px, 3.2vw, 28px)/1.15 var(--sob-sans);
      letter-spacing: -0.01em; color: var(--sob-fg);
    }
    .chp-sub { margin: 0; color: var(--sob-fg-2); font-size: 14px; line-height: 1.6; }
    .chp-list {
      margin: 6px 0 0; padding: 6px 18px; width: 100%; box-sizing: border-box; text-align: left;
      border: 1px solid var(--sob-line); border-radius: 12px;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0.01));
    }
    .chp-row {
      display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 0;
      border-bottom: 1px solid var(--sob-line); font-size: 13.5px;
    }
    .chp-row:last-child { border-bottom: 0; }
    .chp-row dt {
      display: flex; align-items: center; gap: 10px; color: var(--sob-fg-3);
      font-family: var(--sob-mono); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
    }
    .chp-row dd { margin: 0; color: var(--sob-fg-3); text-align: right; overflow-wrap: anywhere; min-width: 0; }
    .chp-row.is-set dd { color: var(--sob-fg); }
    .chp-dot { width: 7px; height: 7px; border-radius: 50%; border: 1px solid var(--sob-fg-4); flex: none; }
    .chp-row.is-set .chp-dot { background: var(--sob-ok); border-color: var(--sob-ok); }
    .chp-actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin-top: 8px; }
    .chp-actions a.chp-btn { text-decoration: none; }
    .chp-btn {
      display: inline-flex; align-items: center; justify-content: center; min-height: 44px; box-sizing: border-box;
      padding: 10px 22px; border-radius: 10px; text-decoration: none;
      font: 600 13px/1 var(--sob-sans); letter-spacing: 0.02em; color: var(--sob-fg-2);
      background: rgba(255, 255, 255, 0.03); border: 1px solid var(--sob-line-2);
      transition: transform 0.2s var(--sob-ease), box-shadow 0.2s var(--sob-ease), color 0.2s;
    }
    .chp-btn:hover { color: var(--sob-fg); transform: translateY(-1px); }
    .chp-btn.is-primary {
      color: var(--sob-ink); background: linear-gradient(180deg, var(--sob-gold), var(--sob-amber));
      border-color: color-mix(in srgb, var(--sob-gold) 60%, transparent); box-shadow: var(--sob-glow-soft);
    }
    .chp-btn.is-primary:hover { box-shadow: var(--sob-glow); }
    .chp-btn:focus-visible, .chp-link:focus-visible { outline: 2px solid var(--sob-gold); outline-offset: 3px; }
    .chp-link {
      appearance: none; background: none; border: 0; cursor: pointer; padding: 10px 6px; min-height: 44px;
      color: var(--sob-fg-3); font: 500 12.5px var(--sob-sans); text-decoration: underline; text-underline-offset: 3px;
    }
    .chp-link:hover { color: var(--sob-gold); }
    @media (max-width: 480px) {
      .chp-actions { flex-direction: column; width: 100%; }
      .chp-btn { width: 100%; }
    }
  </style>`;
}

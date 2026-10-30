/**
 * Workspace loader (hosted cloud): the screen a member sees while their
 * private workspace is found, built, woken, started and loaded.
 *
 * Two variants, same state:
 *   full     a full-screen console (.sob-* ground) with the phase headline, a
 *            plain-English line, the step list, elapsed time and "usually
 *            takes ~X". Used on page load, and for any outage over 10 s.
 *   compact  a small bar at the top of the app. Used for a same-tab reconnect
 *            or wake once the app has been usable, for the first 10 s.
 *
 * The phase is derived from real signals only (workspace-loader-model.ts has
 * the full list and the copy). Progress is indeterminate: there is never a
 * percentage.
 *
 * ── API ────────────────────────────────────────────────────────────────────
 *
 *   showWorkspaceLoader({ phase: "waking", reason: "sleep" })
 *       Start a "waking from sleep" run. This is the one call the sleep flow
 *       makes when the member clicks or types to wake a sleeping workspace,
 *       BEFORE it calls resolve. Nothing else is needed: the loader then
 *       follows the resolve signals fleet-connect already emits, the socket
 *       coming back and the first data, and dismisses itself. It shows the
 *       compact bar for the first 10 s and the full screen after that; pass
 *       variant: "full" or "compact" to pin one.
 *
 *   hideWorkspaceLoader()
 *       Dismiss at once (e.g. the wake was cancelled or failed and the sleep
 *       notice is back). The loader never needs this on the success path.
 *
 *   workspaceSignal(signal)
 *       Feed one observed signal. fleet-connect.ts and main.ts call this
 *       directly; code outside the cloud chunk dispatches the same payload as
 *       window event "infinibot:workspace-signal" so it never imports this.
 *
 *   configureWorkspaceLoader({ onRetry, onSignIn })
 *       Wire the error-state buttons. fleet-connect.ts owns both.
 *
 * A dropped socket only brings the loader up when the client is actually
 * reconnecting (<infinibot-app>.reconnecting). A workspace that is asleep is
 * not reconnecting, so the loader stays out of the sleep notice's way.
 */
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { BRAND_DEFAULT_LOGO } from "../views/branding-modal";
import { renderTerminalGround, terminalAmbientStyles } from "../saas-terminal-ambient";
import {
  deriveLoaderView,
  initialLoaderState,
  reduceLoader,
  type LoaderAction,
  type LoaderPhase,
  type LoaderReason,
  type LoaderState,
  type LoaderView,
  type WorkspaceSignal,
} from "./workspace-loader-model";

export type { LoaderPhase, LoaderReason, WorkspaceSignal } from "./workspace-loader-model";

export const WORKSPACE_SIGNAL_EVENT = "infinibot:workspace-signal";

type Handlers = { onRetry?: () => void; onSignIn?: () => void };

const KNOWN_KEY = "infinibot.cloud.workspace-known";
const TICK_ACTIVE_MS = 250;
const TICK_IDLE_MS = 1000;

let state: LoaderState = initialLoaderState(Date.now());
let handlers: Handlers = {};
let element: WorkspaceLoaderElement | null = null;
let timer: number | null = null;
let installed = false;
let lastSocket = "";
let lastGate = false;
let lastVariant: LoaderView["variant"] = "hidden";
let lastTone: LoaderView["tone"] = "ok";
let restoreFocus: HTMLElement | null = null;

function knownKey(): string {
  const id = (window as unknown as { Clerk?: { user?: { id?: string } | null } }).Clerk?.user?.id;
  return id ? `${KNOWN_KEY}:${id}` : KNOWN_KEY;
}

function readKnown(): boolean {
  try {
    return localStorage.getItem(knownKey()) === "1";
  } catch {
    return false;
  }
}

function writeKnown(): void {
  try {
    localStorage.setItem(knownKey(), "1");
  } catch {
    // storage unavailable: the next 409 just reads as a first run
  }
}

/** The Clerk gate (sign-in form, session-ended notice) owns the screen while it has content. */
function authGateOnScreen(): boolean {
  return (document.getElementById("saas-auth-root")?.childElementCount ?? 0) > 0;
}

type AppProbe = HTMLElement & { connected?: boolean; reconnecting?: boolean };

/** Read what the mounted app already knows; no hooks into the gateway client. */
function probeApp(): void {
  const app = document.querySelector<AppProbe>("infinibot-app");
  if (!app || typeof app.connected !== "boolean") return;
  // A refused session is the app's own screen (sign in again / retry): get out of its way.
  if (state.active && !state.problem && app.querySelector('[data-testid="saas-reauth"]')) {
    apply({ type: "hide" });
    return;
  }
  const socket = `${app.connected}:${app.reconnecting === true}`;
  if (socket !== lastSocket) {
    lastSocket = socket;
    apply({ type: "socket", connected: app.connected, reconnecting: app.reconnecting === true });
  }
  // The SaaS onboarding gate paints its boot screen until it knows the workspace status.
  const gate = app.connected && app.querySelector(".sob-boot") !== null;
  if (gate !== lastGate) {
    lastGate = gate;
    apply({ type: "gate", loading: gate });
  }
}

function schedule(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(
    () => {
      timer = null;
      probeApp();
      apply({ type: "tick" });
      schedule();
    },
    state.active ? TICK_ACTIVE_MS : TICK_IDLE_MS,
  );
}

function install(): void {
  if (installed) return;
  installed = true;
  window.addEventListener(WORKSPACE_SIGNAL_EVENT, (e) => {
    const detail = (e as CustomEvent<WorkspaceSignal>).detail;
    if (detail && typeof detail.type === "string") workspaceSignal(detail);
  });
  window.addEventListener("online", () => apply({ type: "online", online: true }));
  window.addEventListener("offline", () => apply({ type: "online", online: false }));
  // Tells the Clerk gate (saas-clerk.ts) not to paint its own "loading" screen.
  document.documentElement.dataset.workspaceLoader = "on";
  if (navigator.onLine === false) state = reduceLoader(state, { type: "online", online: false }, Date.now());
  schedule();
}

function apply(signal: WorkspaceSignal): void {
  const wasReady = state.everReady;
  const wasActive = state.active;
  if (signal.type === "resolve-start" && !state.knownWorkspace && readKnown()) {
    state = { ...state, knownWorkspace: true };
  }
  state = reduceLoader(state, signal, Date.now());
  if (state.everReady && !wasReady) writeKnown();
  if (state.active !== wasActive) schedule();
  paint();
}

function paint(): void {
  let view = deriveLoaderView(state, Date.now());
  if (view.variant !== "hidden" && authGateOnScreen()) view = { ...view, variant: "hidden" };
  if (view.variant === "hidden") {
    if (element) {
      element.remove();
      element = null;
    }
    onVariant(view);
    return;
  }
  if (!element) {
    element = document.createElement("ib-workspace-loader") as WorkspaceLoaderElement;
    element.id = "workspace-loader-root";
    element.onAction = onAction;
    document.body.appendChild(element);
  }
  element.view = view;
  onVariant(view);
}

/** Focus and inert handling when the variant or the problem changes. */
function onVariant(view: LoaderView): void {
  const full = view.variant === "full";
  const wasFull = lastVariant === "full";
  const app = document.querySelector<HTMLElement>("infinibot-app");
  // The app behind a full-screen loader is not reachable by keyboard or screen reader.
  if (app) app.toggleAttribute("inert", full && !view.exiting);
  if (full && !wasFull) {
    const active = document.activeElement;
    restoreFocus = active instanceof HTMLElement && active !== document.body ? active : null;
    void element?.updateComplete.then(() => element?.focusPanel());
  }
  if (full && view.tone !== lastTone && view.tone !== "ok" && view.tone !== "slow") {
    void element?.updateComplete.then(() => element?.focusPrimary());
  }
  if (!full && wasFull && restoreFocus?.isConnected) {
    restoreFocus.focus({ preventScroll: true });
    restoreFocus = null;
  }
  lastVariant = view.variant;
  lastTone = view.tone;
}

function onAction(action: LoaderAction): void {
  if (action.id === "reload") window.location.reload();
  else if (action.id === "signin") handlers.onSignIn?.();
  else if (action.id === "retry") {
    if (handlers.onRetry) handlers.onRetry();
    else window.location.reload();
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function workspaceSignal(signal: WorkspaceSignal): void {
  install();
  apply(signal);
}

export function showWorkspaceLoader(
  opts: { phase?: LoaderPhase; reason?: LoaderReason; variant?: "auto" | "full" | "compact" } = {},
): void {
  workspaceSignal({ type: "show", ...opts });
}

export function hideWorkspaceLoader(): void {
  workspaceSignal({ type: "hide" });
}

export function configureWorkspaceLoader(next: Handlers): void {
  handlers = { ...handlers, ...next };
}

/** Current state, for diagnostics and the verify harness. */
export function workspaceLoaderState(): LoaderState {
  return state;
}

// The same API for code that cannot import this chunk, and for the verify harness.
if (typeof window !== "undefined") {
  (window as unknown as { __INFINIBOT_WORKSPACE_LOADER__?: unknown }).__INFINIBOT_WORKSPACE_LOADER__ = {
    show: showWorkspaceLoader,
    hide: hideWorkspaceLoader,
    signal: workspaceSignal,
    state: workspaceLoaderState,
  };
}

// ── Component ───────────────────────────────────────────────────────────────

/** The marketing site owns the origin's root; the app lives under a base path. */
function plansHref(): string {
  return new URL("/pricing", window.location.origin).toString();
}

export class WorkspaceLoaderElement extends LitElement {
  static properties = { view: { attribute: false } };

  declare view: LoaderView | null;
  onAction: (action: LoaderAction) => void = () => {};

  constructor() {
    super();
    this.view = null;
  }

  // Light DOM: the .sob-* ground and tokens are plain document styles.
  createRenderRoot() {
    return this;
  }

  focusPanel(): void {
    this.querySelector<HTMLElement>(".wl-panel")?.focus({ preventScroll: true });
  }

  focusPrimary(): void {
    this.querySelector<HTMLElement>(".wl-btn--primary")?.focus({ preventScroll: true });
  }

  private renderActions(view: LoaderView): TemplateResult | typeof nothing {
    if (!view.actions.length) return nothing;
    return html`<div class="wl-actions">
      ${view.actions.map((a) =>
        a.id === "plans"
          ? html`<a class="wl-btn ${a.primary ? "wl-btn--primary" : ""}" href=${plansHref()}>${a.label}</a>`
          : html`<button
              type="button"
              class="wl-btn ${a.primary ? "wl-btn--primary" : ""}"
              data-action=${a.id}
              @click=${() => this.onAction(a)}
            >
              ${a.label}
            </button>`,
      )}
    </div>`;
  }

  private renderOrbit(view: LoaderView): TemplateResult {
    return html`<div class="wl-orbit" aria-hidden="true">
      <span class="wl-orbit__halo"></span>
      <span class="wl-orbit__ring wl-orbit__ring--a"><i></i></span>
      <span class="wl-orbit__ring wl-orbit__ring--b"><i></i></span>
      <span class="wl-orbit__sweep"></span>
      <span class="wl-orbit__core">
        ${view.phase === "ready" && view.tone === "ok"
          ? html`<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>`
          : html`<img src=${BRAND_DEFAULT_LOGO} alt="" />`}
      </span>
    </div>`;
  }

  private renderFull(view: LoaderView): TemplateResult {
    const problem = view.tone === "error" || view.tone === "upgrade" || view.tone === "signin";
    return html`<div
      class="sob-screen sob-boot wl wl--full ${view.exiting ? "wl--exit" : ""}"
      data-workspace-loader="full"
      data-phase=${view.phase}
      data-tone=${view.tone}
    >
      ${renderTerminalGround()}
      ${view.offline
        ? html`<div class="wl-offline" role="status">
            <span class="wl-offline__dot"></span>You're offline. This continues when your connection is back.
          </div>`
        : nothing}
      <div
        class="sob-boot__core wl-panel"
        role=${problem ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby="wl-headline"
        aria-describedby="wl-explanation"
        tabindex="-1"
      >
        ${this.renderOrbit(view)}
        <div class="sob-boot__title wl-eyebrow">${view.eyebrow}</div>
        <h1 class="wl-headline" id="wl-headline">${view.headline}</h1>
        <p class="wl-sub" id="wl-explanation">${view.explanation}</p>
        ${view.steps.length
          ? html`<ol class="wl-steps" aria-label="Progress">
              ${view.steps.map(
                (s) =>
                  html`<li class="wl-step wl-step--${s.state}" aria-current=${s.state === "current" ? "step" : nothing}>
                    <span class="wl-step__mark"></span>
                    <span class="wl-step__label">${s.label}</span>
                    <span class="wl-step__state">${s.state === "done" ? "done" : s.state === "current" ? "now" : ""}</span>
                  </li>`,
              )}
            </ol>`
          : nothing}
        ${problem
          ? nothing
          : html`<div class="wl-trace" aria-hidden="true"><span></span></div>
              <div class="wl-meta">
                <span aria-hidden="true">elapsed ${view.elapsed}</span>
                ${view.expectation ? html`<span>${view.expectation}</span>` : nothing}
              </div>`}
        ${view.slow
          ? html`<div class="wl-slow">
              <div class="wl-slow__title">Taking longer than usual — still working</div>
              <details class="wl-detail">
                <summary>What's happening</summary>
                <p>${view.detail}</p>
              </details>
              ${this.renderActions(view)}
            </div>`
          : nothing}
        ${problem
          ? html`${this.renderActions(view)}
              ${view.detail
                ? html`<details class="wl-detail">
                    <summary>What's happening</summary>
                    <p>${view.detail}</p>
                  </details>`
                : nothing}`
          : nothing}
      </div>
    </div>`;
  }

  private renderCompact(view: LoaderView): TemplateResult {
    return html`<div
      class="wl wl-compact ${view.exiting ? "wl--exit" : ""}"
      data-workspace-loader="compact"
      data-phase=${view.phase}
      data-tone=${view.tone}
    >
      <span class="wl-compact__spin" aria-hidden="true"></span>
      <span class="wl-compact__text">${view.offline ? "You're offline" : view.headline}</span>
      ${view.exiting ? nothing : html`<span class="wl-compact__time" aria-hidden="true">${view.elapsed}</span>`}
    </div>`;
  }

  render() {
    const view = this.view;
    if (!view || view.variant === "hidden") return nothing;
    const alert = view.tone === "error" || view.tone === "upgrade" || view.tone === "signin";
    return html`${terminalAmbientStyles()}${loaderStyles()}
      <div class="wl-sr" role=${alert ? "alert" : "status"} aria-live=${alert ? "assertive" : "polite"}>
        ${view.announce}
      </div>
      ${view.variant === "full" ? this.renderFull(view) : this.renderCompact(view)}`;
  }
}

if (typeof customElements !== "undefined" && !customElements.get("ib-workspace-loader")) {
  customElements.define("ib-workspace-loader", WorkspaceLoaderElement);
}

function loaderStyles(): TemplateResult {
  return html`<style>
    ib-workspace-loader { display: contents; }
    .wl-sr {
      position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
      clip: rect(0 0 0 0); white-space: nowrap; border: 0;
    }
    /* "Ready" holds for a beat, then fades into the app (READY_EXIT_MS). */
    .wl--full { z-index: 9100; transition: opacity 0.6s ease-in 0.45s; }
    .wl--full.wl--exit { opacity: 0; pointer-events: none; }
    .wl-panel {
      width: min(480px, calc(100vw - 40px)); box-sizing: border-box; text-align: center;
      padding: 24px 0; gap: 16px;
    }
    /* Focus lands here for screen readers; the panel itself is not a control. */
    .wl .wl-panel:focus, .wl .wl-panel:focus-visible { outline: none !important; box-shadow: none !important; }

    /* ── Orbit ────────────────────────────────────────────── */
    .wl-orbit { position: relative; width: 132px; height: 132px; display: grid; place-items: center; margin-bottom: 4px; }
    .wl-orbit__halo {
      position: absolute; inset: 18px; border-radius: 50%;
      background: radial-gradient(circle, color-mix(in srgb, var(--sob-gold) 22%, transparent), transparent 70%);
      animation: wl-breathe 3.2s ease-in-out infinite;
    }
    .wl-orbit__ring {
      position: absolute; border-radius: 50%; border: 1px solid var(--sob-line-2);
      animation: wl-spin 9s linear infinite;
    }
    .wl-orbit__ring--a { inset: 0; }
    .wl-orbit__ring--b { inset: 14px; border-style: dashed; border-color: var(--sob-line); animation-duration: 14s; animation-direction: reverse; }
    .wl-orbit__ring i {
      position: absolute; top: -3px; left: 50%; width: 6px; height: 6px; margin-left: -3px; border-radius: 50%;
      background: var(--sob-gold); box-shadow: 0 0 10px var(--sob-gold);
    }
    .wl-orbit__ring--b i { width: 4px; height: 4px; top: -2px; margin-left: -2px; opacity: 0.7; }
    .wl-orbit__sweep {
      position: absolute; inset: 26px; border-radius: 50%;
      background: conic-gradient(from 0deg, transparent 0 68%, color-mix(in srgb, var(--sob-gold) 90%, transparent) 97%, transparent);
      -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px));
      mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 1.5px));
      animation: wl-spin 1.7s linear infinite;
    }
    .wl-orbit__core {
      position: relative; width: 72px; height: 72px; border-radius: 50%; display: grid; place-items: center;
      color: var(--sob-gold);
      background: radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--sob-gold) 16%, transparent), rgba(255,255,255,0.02) 70%);
      box-shadow: var(--sob-glow-soft), inset 0 1px 0 rgba(255,255,255,0.08);
    }
    .wl-orbit__core img { width: 38px; height: 38px; object-fit: contain; filter: drop-shadow(0 0 10px color-mix(in srgb, var(--sob-gold) 40%, transparent)); }
    .wl[data-tone="error"] .wl-orbit__ring, .wl[data-tone="error"] .wl-orbit__halo,
    .wl[data-tone="upgrade"] .wl-orbit__ring, .wl[data-tone="signin"] .wl-orbit__ring,
    .wl[data-phase="ready"] .wl-orbit__ring { animation-play-state: paused; }
    .wl[data-tone="error"] .wl-orbit__sweep, .wl[data-tone="upgrade"] .wl-orbit__sweep,
    .wl[data-tone="signin"] .wl-orbit__sweep, .wl[data-phase="ready"] .wl-orbit__sweep { display: none; }
    .wl[data-tone="error"] .wl-orbit__ring { border-color: color-mix(in srgb, var(--sob-danger) 40%, transparent); }
    .wl[data-tone="error"] .wl-orbit__ring i { background: var(--sob-danger); box-shadow: 0 0 10px var(--sob-danger); }
    .wl[data-phase="ready"] .wl-orbit__core { box-shadow: var(--sob-glow); }
    @keyframes wl-spin { to { transform: rotate(360deg); } }
    @keyframes wl-breathe { 0%, 100% { opacity: 0.55; transform: scale(0.94); } 50% { opacity: 1; transform: scale(1.06); } }

    /* ── Copy ─────────────────────────────────────────────── */
    .wl-headline {
      margin: 2px 0 0; font-family: var(--sob-sans); font-weight: 600;
      font-size: clamp(22px, 5.4vw, 30px); line-height: 1.2; letter-spacing: -0.01em; color: var(--sob-fg);
      text-wrap: balance;
    }
    .wl-sub { margin: 0; color: var(--sob-fg-2); font-size: 14.5px; line-height: 1.6; text-wrap: pretty; max-width: 42ch; }

    /* ── Steps ────────────────────────────────────────────── */
    .wl-steps {
      list-style: none; margin: 6px 0 0; padding: 14px 18px; display: grid; gap: 9px;
      text-align: left; width: 100%; box-sizing: border-box;
      font-family: var(--sob-mono); font-size: 12px; color: var(--sob-fg-3);
      border: 1px solid var(--sob-line); border-radius: 12px;
      /* Opaque enough that the floor grid never runs through the labels. */
      background: linear-gradient(180deg, rgba(16, 14, 10, 0.9), rgba(8, 7, 5, 0.9));
    }
    .wl-step { display: grid; grid-template-columns: 14px 1fr auto; align-items: center; gap: 10px; }
    .wl-step__mark {
      width: 8px; height: 8px; border-radius: 50%; justify-self: center;
      border: 1px solid var(--sob-fg-4);
    }
    .wl-step__state { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; }
    .wl-step--done { color: var(--sob-fg-2); }
    .wl-step--done .wl-step__mark {
      width: 9px; height: 5px; border-radius: 0; border: solid var(--sob-ok); border-width: 0 0 1.5px 1.5px;
      transform: rotate(-45deg) translate(1px, -1px);
    }
    .wl-step--done .wl-step__state { color: var(--sob-fg-4); }
    .wl-step--current { color: var(--sob-gold); text-shadow: var(--sob-text-glow); }
    .wl-step--current .wl-step__mark {
      background: var(--sob-gold); border-color: var(--sob-gold); box-shadow: var(--sob-glow-soft);
      animation: wl-pulse 1.4s ease-in-out infinite;
    }
    @keyframes wl-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.8); } }

    /* ── Trace + meta ─────────────────────────────────────── */
    .wl-trace { width: 100%; height: 1px; position: relative; overflow: hidden; background: var(--sob-line); }
    .wl-trace span {
      position: absolute; top: 0; bottom: 0; width: 38%;
      background: linear-gradient(90deg, transparent, var(--sob-gold), transparent);
      animation: wl-trace 1.5s var(--sob-ease) infinite;
    }
    .wl[data-phase="ready"] .wl-trace span { animation: none; width: 100%; }
    @keyframes wl-trace { from { transform: translateX(-100%); } to { transform: translateX(270%); } }
    .wl-meta {
      display: flex; flex-wrap: wrap; gap: 6px 16px; justify-content: center;
      font-family: var(--sob-mono); font-size: 11px; letter-spacing: 0.08em;
      text-transform: uppercase; color: var(--sob-fg-3);
    }
    .wl-meta span:first-child { font-variant-numeric: tabular-nums; }

    /* ── Slow, detail, actions ────────────────────────────── */
    .wl-slow {
      width: 100%; box-sizing: border-box; padding: 14px 16px; display: grid; gap: 10px; justify-items: center;
      border: 1px solid var(--sob-line-2); border-radius: 12px;
      background: color-mix(in srgb, var(--sob-gold) 5%, transparent);
    }
    .wl-slow__title { font-size: 14px; font-weight: 600; color: var(--sob-fg); }
    .wl-detail { width: 100%; text-align: left; font-size: 13px; color: var(--sob-fg-2); }
    .wl-detail summary {
      cursor: pointer; width: max-content; margin: 0 auto; padding: 4px 6px; border-radius: 6px;
      font-family: var(--sob-mono); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--sob-fg-3);
    }
    .wl-detail summary:hover { color: var(--sob-gold); }
    .wl-detail summary:focus-visible { outline: 2px solid var(--sob-gold); outline-offset: 2px; }
    .wl-detail p { margin: 8px 0 0; line-height: 1.6; }
    .wl-actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin-top: 2px; }
    .wl-btn {
      appearance: none; cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
      min-height: 44px; padding: 0 22px; border-radius: 10px; text-decoration: none;
      font: 600 13px/1 var(--sob-sans); letter-spacing: 0.02em; color: var(--sob-fg);
      background: rgba(255,255,255,0.04); border: 1px solid var(--sob-line-2);
      transition: transform 0.2s var(--sob-ease), box-shadow 0.2s var(--sob-ease), border-color 0.2s;
    }
    .wl-btn:hover { border-color: var(--sob-gold); }
    .wl-btn--primary {
      color: var(--sob-ink); background: linear-gradient(180deg, var(--sob-gold), var(--sob-amber));
      border-color: color-mix(in srgb, var(--sob-gold) 60%, transparent); box-shadow: var(--sob-glow-soft);
    }
    .wl-btn--primary:hover { transform: translateY(-1px); box-shadow: var(--sob-glow); }
    .wl-btn:focus-visible { outline: 2px solid var(--sob-gold); outline-offset: 3px; }

    /* ── Offline banner ───────────────────────────────────── */
    .wl-offline {
      position: fixed; top: 0; left: 0; right: 0; z-index: 1; padding: 10px 16px;
      display: flex; align-items: center; justify-content: center; gap: 10px; text-align: center;
      font-family: var(--sob-mono); font-size: 12px; color: var(--sob-fg);
      background: color-mix(in srgb, var(--sob-danger) 16%, #0a0706);
      border-bottom: 1px solid color-mix(in srgb, var(--sob-danger) 45%, transparent);
    }
    .wl-offline__dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--sob-danger); }

    /* ── Compact bar ──────────────────────────────────────── */
    .wl-compact {
      --wl-gold: var(--g-primary, #fbbf24);
      /* Below the app's top bar, so it never covers a control. */
      position: fixed; top: calc(env(safe-area-inset-top, 0px) + 64px); left: 50%; transform: translateX(-50%); z-index: 9100;
      display: inline-flex; align-items: center; gap: 10px; max-width: calc(100vw - 24px); box-sizing: border-box;
      padding: 9px 16px 9px 12px; border-radius: 999px; color-scheme: dark;
      font: 500 12px/1.2 "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: #f5f2ea; background: rgba(6, 5, 3, 0.92);
      border: 1px solid color-mix(in srgb, var(--wl-gold) 40%, transparent);
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5), 0 0 14px color-mix(in srgb, var(--wl-gold) 18%, transparent);
      animation: wl-drop 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
      transition: opacity 0.5s ease;
    }
    .wl-compact.wl--exit { opacity: 0; }
    .wl-compact__text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wl-compact__time { color: rgba(245, 242, 234, 0.5); font-variant-numeric: tabular-nums; }
    .wl-compact__spin {
      width: 12px; height: 12px; border-radius: 50%; flex: none;
      border: 1.5px solid color-mix(in srgb, var(--wl-gold) 25%, transparent); border-top-color: var(--wl-gold);
      animation: wl-spin 0.9s linear infinite;
    }
    .wl-compact[data-phase="ready"] .wl-compact__spin { animation: none; border-color: var(--wl-gold); background: var(--wl-gold); }
    @keyframes wl-drop { from { opacity: 0; transform: translate(-50%, -10px); } to { opacity: 1; transform: translate(-50%, 0); } }
    /* Same 1:1 rendering as .sob-screen inside the laptop band's body zoom. */
    @media (min-width: 1101px) and (max-width: 1680px) {
      .wl-compact { zoom: calc(1 / var(--ui-viewport-zoom, 0.7)); }
    }
    :root[data-viewport-scale="off"] .wl-compact { zoom: 1; }

    @media (max-width: 480px) {
      .wl-orbit { width: 112px; height: 112px; }
      .wl-orbit__sweep { inset: 20px; }
      .wl-panel { gap: 14px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .wl *, .wl *::before, .wl *::after, .wl-compact {
        animation-duration: 0.001ms !important; animation-iteration-count: 1 !important;
      }
      .wl-orbit__sweep { display: none; }
      .wl-trace span { width: 100%; opacity: 0.5; animation: none !important; transform: none; }
      .wl--full, .wl-compact { transition: none; }
    }
  </style>`;
}

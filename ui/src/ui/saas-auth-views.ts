/**
 * SaaS auth surfaces, all on the same "terminal unlock" ground as onboarding:
 *
 *   - renderAuthScreen: the pre-app screens rendered by saas-clerk.ts into
 *     #saas-auth-root (sign-in gate with Clerk mounted in-app, contacting the
 *     auth service, access granted, signing out, and loud auth errors);
 *   - renderSaasConnectScreen: replaces the bare "Connecting…" while the app
 *     authenticates its gateway socket, and turns a rejected session into a
 *     clear message with a way to sign in again;
 *   - renderSaasAccountMenu: the signed-in chip + menu (email, plan, sign out).
 *
 * Styles are scoped `.sau-*`; the shared ground/palette comes from
 * saas-terminal-ambient (`.sob-screen`). SaaS mode only. No emoji — marks are
 * monograms and inline SVG.
 */
import { html, nothing, render, svg, type TemplateResult } from "lit";
import type { GatewayBrowserClient } from "./gateway";
import { appAssetUrl } from "./app-base";
import { isCloudBuild } from "./cloud/cloud-env";
import { getSaasIdentity, saasEverConnected, saasSignOut, type GateNotice } from "./saas-clerk";
import { renderTerminalGround, terminalAmbientStyles } from "./saas-terminal-ambient";
import { BRAND_DEFAULT_LOGO } from "./views/branding-modal";

// ── Icons ───────────────────────────────────────────────────────────────────

// Bodies use the `svg` tag: shapes built with `html` land in the HTML
// namespace and never paint.
const icon = (body: TemplateResult) =>
  html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const iconPower = () => icon(svg`<path d="M12 3v8"/><path d="M6.4 6.6a8 8 0 1 0 11.2 0"/>`);
const iconRetry = () => icon(svg`<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>`);
const iconKey = () => icon(svg`<circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2"/><path d="m17 6 3 3"/><path d="m14 9 2 2"/>`);
const iconChevron = () => icon(svg`<path d="m6 9 6 6 6-6"/>`);
const iconAlert = () => icon(svg`<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>`);

// ── Shared pieces ───────────────────────────────────────────────────────────

type Tone = "idle" | "busy" | "ok" | "error";

function hero(title: string, sub: string, tone: Tone): TemplateResult {
  return html`<header class="sau-hero">
    <div class="sau-mark sau-mark--${tone}">
      <span class="sau-mark__ring"></span>
      ${tone === "busy" ? html`<span class="sau-mark__sweep"></span>` : nothing}
      <img src=${appAssetUrl(BRAND_DEFAULT_LOGO)} alt="" />
    </div>
    <div class="sau-brand">InfiniBot</div>
    <h1 class="sau-title">${title}</h1>
    <p class="sau-sub">${sub}</p>
  </header>`;
}

function consoleBar(path: string, state: string, tone: Tone): TemplateResult {
  return html`<div class="sau-bar">
    <span class="sau-bar__path">${path}</span>
    <span class="sau-bar__state sau-bar__state--${tone}"><span class="sau-led"></span>${state}</span>
  </div>`;
}

function log(lines: string[]): TemplateResult {
  return html`<div class="sau-log">
    <ol>
      ${lines.map((l, i) => html`<li style="--i:${i}"><span class="sau-log__tick"></span>${l}</li>`)}
    </ol>
    <div class="sau-log__bar"><span></span></div>
  </div>`;
}

function corners(): TemplateResult {
  return html`<span class="sau-corner sau-corner--tl"></span><span class="sau-corner sau-corner--tr"></span><span class="sau-corner sau-corner--bl"></span><span class="sau-corner sau-corner--br"></span>`;
}

function screen(kind: string, body: TemplateResult): TemplateResult {
  return html`${terminalAmbientStyles()}${authStyles()}
    <div class="sob-screen sau" data-testid="saas-auth-${kind}">
      ${renderTerminalGround()}
      <main class="sau-stage">${body}</main>
    </div>`;
}

// Clerk's card already carries its "Secured by Clerk" mark.
// Public page: licence + trademark notice (see NOTICE / TRADEMARKS.md). The
// sign-in provider marks inside Clerk's widget identify those providers only.
const foot = () =>
  html`<footer class="sau-foot">
    <span>Private per-member workspace</span><i class="sau-foot__dot" aria-hidden="true"></i>
    <span title="InfiniBot is licensed under the Functional Source License 1.1, ALv2 Future License. Third-party names and logos are trademarks of their respective owners and do not imply endorsement.">© 2026 Kingly Intelligence Systems, LLC</span><i class="sau-foot__dot" aria-hidden="true"></i>
    <span>Source-available under FSL-1.1-ALv2</span><i class="sau-foot__dot" aria-hidden="true"></i>
    <span>Third-party marks belong to their owners</span>
  </footer>`;

// ── Pre-app auth screens ────────────────────────────────────────────────────

export type AuthScreenOpts =
  | { kind: "loading" }
  | {
      kind: "sign-in";
      notice: GateNotice | null;
      /** The plan picked before sign-in (/app/?checkout=<plan>), resumed right after. */
      checkout?: { name: string; price: number } | null;
      fallback: boolean;
      onHostedSignIn: () => void;
    }
  | { kind: "verified" }
  | { kind: "signing-out" }
  | { kind: "error"; title: string; detail: string; onRetry: () => void };

export function renderAuthScreen(root: HTMLElement, opts: AuthScreenOpts) {
  document.body.dataset.authRoute = "1";
  render(authScreenTemplate(opts), root);
}

function authScreenTemplate(opts: AuthScreenOpts): TemplateResult {
  switch (opts.kind) {
    case "loading":
      return screen(
        "loading",
        html`${hero("Unlock your terminal", "Verify your identity to open your private workspace.", "busy")}
          <section class="sau-console">${consoleBar("secure://identity", "Connecting", "busy")}${log(["Contacting the sign-in service"])}</section>`,
      );
    case "sign-in":
      // The Clerk mount node is always rendered (only hidden in fallback) so
      // re-renders never detach the component Clerk mounted into it.
      return screen(
        "sign-in",
        html`${opts.checkout
            ? hero(
                `Continue to ${opts.checkout.name}`,
                `Sign in, or create your InfiniBot Cloud account, and you go straight to secure checkout for ${opts.checkout.name} ($${opts.checkout.price}/month).`,
                "idle",
              )
            : hero("Unlock your terminal", "Sign in, or create your InfiniBot Cloud account, to open your private workspace.", "idle")}
          <section class="sau-console sau-console--signin" aria-label="Sign in">
            ${corners()} ${consoleBar("secure://identity", "Awaiting identity", "idle")}
            ${opts.checkout
              ? html`<div class="sau-notice" role="status" data-testid="saas-auth-checkout">
                  <span class="sau-led"></span><span>Plan selected: <b>${opts.checkout.name}</b>, $${opts.checkout.price}/month. Checkout opens after you sign in. New here? Choose <b>Sign up</b> below.</span>
                </div>`
              : nothing}
            ${opts.notice
              ? html`<div class="sau-notice sau-notice--${opts.notice.tone}" role="status" data-testid="saas-auth-notice">
                  <span class="sau-led"></span>${opts.notice.text}
                </div>`
              : nothing}
            <div class="sau-clerk" ?hidden=${opts.fallback}><div data-clerk-signin></div></div>
            ${opts.fallback
              ? html`<div class="sau-fallback" data-testid="saas-auth-fallback">
                  <p>Continue on the secure sign-in page. You'll come straight back here once you're verified.</p>
                  <button class="sau-btn sau-btn--primary" data-testid="saas-hosted-sign-in" @click=${opts.onHostedSignIn}>
                    ${iconKey()}Continue to secure sign-in
                  </button>
                </div>`
              : nothing}
          </section>
          ${foot()}`,
      );
    case "verified":
      return screen(
        "verified",
        html`${hero("Access granted", "Identity verified. Opening your workspace.", "ok")}
          <section class="sau-console">${consoleBar("secure://identity", "Verified", "ok")}${log(["Identity verified", "Opening your workspace"])}</section>`,
      );
    case "signing-out":
      return screen(
        "signing-out",
        html`${hero("Locking terminal", "Closing your workspace on this device.", "busy")}
          <section class="sau-console">${consoleBar("secure://session", "Locking", "busy")}${log(["Gateway link closed", "Ending your session"])}</section>`,
      );
    case "error":
      return screen(
        "error",
        html`${hero(opts.title, "Nothing is unlocked until this is resolved.", "error")}
          <section class="sau-console" role="alert">
            ${consoleBar("secure://identity", "Unavailable", "error")}
            <div class="sau-error">
              <div class="sau-error__head">${iconAlert()}<span>Details</span></div>
              <p class="sau-error__detail" data-testid="saas-auth-error-detail">${opts.detail}</p>
              <div class="sau-actions">
                <button class="sau-btn sau-btn--primary" data-testid="saas-auth-retry" @click=${opts.onRetry}>${iconRetry()}Try again</button>
              </div>
              <p class="sau-hint">If this keeps happening, contact your workspace operator.</p>
            </div>
          </section>`,
      );
  }
}

// ── In-app: gateway connect status ──────────────────────────────────────────

export type SaasConnectScreenOpts = {
  phase: "connecting" | "reconnecting" | "rejected" | "no-session";
  attempt: number;
  detail: string | null;
  onRetry: () => void;
  onReauth: () => void;
};

function humanizeRejection(message: string | null): string {
  if (!message) return "The gateway refused this session.";
  if (/could not be verified|expired|invalid|unauthorized|token/i.test(message)) {
    return "The gateway couldn't verify your sign-in. Your session may have expired or been revoked on another device.";
  }
  return message;
}

export function renderSaasConnectScreen(opts: SaasConnectScreenOpts): TemplateResult {
  const identity = getSaasIdentity();
  const who = identity?.email ?? identity?.name ?? "your account";
  if (opts.phase === "rejected" || opts.phase === "no-session") {
    const title = opts.phase === "rejected" ? "Session rejected" : "No active session";
    const detail =
      opts.phase === "rejected"
        ? humanizeRejection(opts.detail)
        : "There is no active sign-in session on this device to open the workspace with.";
    return screen(
      "connect-rejected",
      html`${hero(title, `Signed in as ${who}.`, "error")}
        <section class="sau-console" role="alert">
          ${consoleBar("gateway://link", "Refused", "error")}
          <div class="sau-error">
            <div class="sau-error__head">${iconAlert()}<span>What happened</span></div>
            <p class="sau-error__text">${detail}</p>
            ${opts.detail && opts.phase === "rejected"
              ? html`<p class="sau-error__detail" data-testid="saas-connect-reason">${opts.detail}</p>`
              : nothing}
            <div class="sau-actions">
              <button class="sau-btn sau-btn--primary" data-testid="saas-reauth" @click=${opts.onReauth}>${iconKey()}Sign in again</button>
              <button class="sau-btn sau-btn--ghost" data-testid="saas-connect-retry" @click=${opts.onRetry}>${iconRetry()}Retry</button>
            </div>
          </div>
        </section>`,
    );
  }
  const reconnecting = opts.phase === "reconnecting";
  const stuck = reconnecting && opts.attempt >= 3;
  // Never connected yet on a hosted build: the gateway may still be starting a
  // new workspace, which is not a dropped link. (The serverless cloud build
  // never renders this: it has no gateway.)
  const starting = reconnecting && isCloudBuild() && !saasEverConnected();
  const link = "gateway://link";
  return screen(
    reconnecting ? "connect-retrying" : "connecting",
    html`${hero(
        starting ? "Starting your workspace" : reconnecting ? "Reconnecting" : "Opening your workspace",
        starting
          ? "The first start of a new workspace can take up to a minute."
          : reconnecting
            ? "The link to your workspace dropped. Retrying automatically."
            : `Signed in as ${who}.`,
        "busy",
      )}
      <section class="sau-console">
        ${consoleBar(link, reconnecting ? `Attempt ${opts.attempt}` : "Authenticating", "busy")}
        ${log(
          starting
            ? ["Session verified", "Gateway preparing your workspace", "Retrying"]
            : reconnecting
              ? ["Gateway link lost", "Refreshing session token", "Retrying"]
              : ["Session verified", "Authenticating gateway link"],
        )}
        ${stuck
          ? html`<div class="sau-stuck" data-testid="saas-connect-stuck">
              ${opts.detail ? html`<p class="sau-error__detail">${opts.detail}</p>` : nothing}
              <div class="sau-actions">
                <button class="sau-btn sau-btn--ghost" data-testid="saas-connect-retry" @click=${opts.onRetry}>${iconRetry()}Retry now</button>
                <button class="sau-btn sau-btn--ghost" data-testid="saas-connect-signout" @click=${() => void saasSignOut()}>${iconPower()}Sign out</button>
              </div>
            </div>`
          : nothing}
      </section>`,
  );
}

// ── In-app: account chip + menu ─────────────────────────────────────────────

type MenuItem = { id: string; label: string; icon?: TemplateResult; onSelect: () => void };

/**
 * Entries every account menu shows above Sign out, registered once by the host
 * shell. The hosted cloud build uses it to put its serverless-backed settings
 * (identity, model keys, business) into the workspace's own account menu.
 */
let extraItems: (() => MenuItem[]) | null = null;
export function setSaasAccountMenuExtras(items: (() => MenuItem[]) | null): void {
  extraItems = items;
}

type Me = { email?: string | null; plan?: string | null; namespace?: string | null };

let menuOpen = false;
let signingOut = false;
let meFor: GatewayBrowserClient | null = null;
let me: Me | null = null;
let rerender: (() => void) | null = null;
let docListenersOn = false;

function closeMenu() {
  if (!menuOpen) return;
  menuOpen = false;
  syncDocListeners();
  rerender?.();
}

function onDocPointer(ev: Event) {
  const inside = ev.composedPath().some((n) => n instanceof Element && n.classList.contains("sau-account"));
  if (!inside) closeMenu();
}
function onDocKey(ev: KeyboardEvent) {
  if (ev.key === "Escape") closeMenu();
}
function syncDocListeners() {
  if (menuOpen && !docListenersOn) {
    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("keydown", onDocKey, true);
    docListenersOn = true;
  } else if (!menuOpen && docListenersOn) {
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("keydown", onDocKey, true);
    docListenersOn = false;
  }
}

function monogram(name: string | null, email: string | null): string {
  const src = (name || email || "").trim();
  const ch = src.match(/[\p{L}\p{N}]/u)?.[0];
  return ch ? ch.toUpperCase() : "M";
}

function planLabel(plan: string | null | undefined): string {
  const p = (plan || "free").trim();
  return p.charAt(0).toUpperCase() + p.slice(1);
}

export function renderSaasAccountMenu(opts: {
  client: GatewayBrowserClient | null;
  requestUpdate: () => void;
  variant?: "topbar" | "floating";
  /** Extra entries above Sign out (the cloud shell's workspace/settings links). */
  items?: MenuItem[];
}): TemplateResult {
  rerender = opts.requestUpdate;
  const client = opts.client;
  if (client && meFor !== client) {
    meFor = client;
    me = null;
    void client
      .request<Me>("saas.me", {})
      .then((res) => {
        if (meFor !== client) return;
        me = res ?? {};
        opts.requestUpdate();
      })
      .catch(() => {
        /* plan stays unknown; email still comes from Clerk */
      });
  }
  const identity = getSaasIdentity();
  const email = identity?.email ?? me?.email ?? null;
  const name = identity?.name ?? null;
  const mark = monogram(name, email);
  const variant = opts.variant ?? "topbar";

  const toggle = () => {
    menuOpen = !menuOpen;
    syncDocListeners();
    opts.requestUpdate();
  };
  const signOut = async () => {
    if (signingOut) return;
    signingOut = true;
    opts.requestUpdate();
    try {
      await saasSignOut();
    } finally {
      signingOut = false;
      menuOpen = false;
      syncDocListeners();
    }
  };

  return html`${accountStyles()}
    <div class="sau-account sau-account--${variant}">
      <button
        class="sau-chip ${menuOpen ? "is-open" : ""}"
        data-testid="saas-account-chip"
        aria-haspopup="menu"
        aria-expanded=${menuOpen ? "true" : "false"}
        title=${email ? `Signed in as ${email}` : "Account"}
        @click=${toggle}
      >
        <span class="sau-mono" aria-hidden="true">${mark}</span>
        <span class="sau-chip__label">${email ?? "Account"}</span>
        <span class="sau-chip__chev">${iconChevron()}</span>
      </button>
      ${menuOpen
        ? html`<div class="sau-menu" role="menu" aria-label="Account" data-testid="saas-account-menu">
            <div class="sau-menu__head">
              <span class="sau-mono sau-mono--lg" aria-hidden="true">${mark}</span>
              <div class="sau-menu__who">
                ${name ? html`<div class="sau-menu__name">${name}</div>` : nothing}
                <div class="sau-menu__email" data-testid="saas-account-email">${email ?? "Signed in"}</div>
              </div>
            </div>
            <dl class="sau-menu__rows">
              <div><dt>Plan</dt><dd><span class="sau-plan" data-testid="saas-account-plan">${me ? planLabel(me.plan) : "Loading"}</span></dd></div>
              <div><dt>Session</dt><dd><span class="sau-live"><span class="sau-led"></span>Active</span></dd></div>
            </dl>
            ${(opts.items ?? extraItems?.() ?? []).map(
              (item) => html`<button
                class="sau-menu__item"
                role="menuitem"
                data-testid=${`saas-menu-${item.id}`}
                @click=${() => {
                  menuOpen = false;
                  syncDocListeners();
                  item.onSelect();
                  opts.requestUpdate();
                }}
              >
                ${item.icon ?? nothing}<span>${item.label}</span>
              </button>`,
            )}
            <button
              class="sau-menu__signout"
              role="menuitem"
              data-testid="saas-sign-out"
              ?disabled=${signingOut}
              aria-busy=${signingOut ? "true" : "false"}
              @click=${signOut}
            >
              ${iconPower()}<span>${signingOut ? "Signing out" : "Sign out"}</span>
            </button>
          </div>`
        : nothing}
    </div>`;
}

// ── Styles ──────────────────────────────────────────────────────────────────

function authStyles(): TemplateResult {
  return html`<style>
    .sau { z-index: 2147483000; }
    .sau-stage {
      position: relative; min-height: 100%; box-sizing: border-box;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 26px; padding: 48px 20px;
    }
    .sau-hero { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; animation: sob-fade-in 0.6s var(--sob-ease) both; }
    .sau-mark {
      position: relative; width: 76px; height: 76px; display: grid; place-items: center; border-radius: 50%;
      background: radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--sob-gold) 14%, transparent), rgba(255,255,255,0.02) 70%);
      box-shadow: var(--sob-glow-soft), inset 0 1px 0 rgba(255,255,255,0.08);
      margin-bottom: 6px;
    }
    .sau-mark img { width: 38px; height: 38px; object-fit: contain; filter: drop-shadow(0 0 10px color-mix(in srgb, var(--sob-gold) 40%, transparent)); }
    .sau-mark__ring { position: absolute; inset: -1px; border-radius: 50%; border: 1px solid var(--sob-line-2); }
    .sau-mark--idle .sau-mark__ring { animation: sau-breathe 3.2s ease-in-out infinite; }
    .sau-mark--ok .sau-mark__ring { border-color: var(--sob-ok); box-shadow: 0 0 18px color-mix(in srgb, var(--sob-ok) 45%, transparent); }
    .sau-mark--error .sau-mark__ring { border-color: color-mix(in srgb, var(--sob-danger) 70%, transparent); box-shadow: 0 0 18px color-mix(in srgb, var(--sob-danger) 35%, transparent); }
    .sau-mark--error img { filter: grayscale(0.6) drop-shadow(0 0 8px color-mix(in srgb, var(--sob-danger) 35%, transparent)); }
    .sau-mark__sweep {
      position: absolute; inset: -7px; border-radius: 50%;
      background: conic-gradient(from 0deg, transparent 0 70%, color-mix(in srgb, var(--sob-gold) 85%, transparent) 96%, transparent);
      -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1px));
      mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1px));
      animation: sob-spin 1.6s linear infinite;
    }
    @keyframes sau-breathe { 50% { box-shadow: 0 0 22px color-mix(in srgb, var(--sob-gold) 40%, transparent); border-color: color-mix(in srgb, var(--sob-gold) 60%, transparent); } }
    .sau-brand {
      font-family: var(--sob-mono); font-size: 11.5px; font-weight: 500; letter-spacing: 0.42em;
      text-transform: uppercase; padding-left: 0.42em; color: var(--sob-gold); text-shadow: var(--sob-text-glow);
    }
    .sau-title { margin: 6px 0 0; font: 600 32px/1.12 var(--sob-sans); letter-spacing: -0.025em; color: var(--sob-fg); text-wrap: balance; }
    .sau-sub { margin: 0; color: var(--sob-fg-2); font-size: 15.5px; max-width: 440px; text-wrap: balance; }

    .sau-console {
      position: relative; width: 100%; max-width: 440px; box-sizing: border-box; border-radius: 18px;
      background:
        radial-gradient(90% 60% at 50% 0%, color-mix(in srgb, var(--sob-gold) 7%, transparent), transparent 70%),
        linear-gradient(180deg, rgba(20, 17, 11, 0.8), rgba(8, 7, 5, 0.88));
      -webkit-backdrop-filter: blur(20px) saturate(140%);
      backdrop-filter: blur(20px) saturate(140%);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.07),
        0 40px 100px -24px rgba(0, 0, 0, 0.85),
        0 0 60px -12px color-mix(in srgb, var(--sob-gold) 16%, transparent);
      animation: sau-rise 0.7s 0.1s var(--sob-ease) both;
    }
    .sau-console::before {
      content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1px; pointer-events: none;
      background: linear-gradient(180deg,
        color-mix(in srgb, var(--sob-gold) 66%, transparent) 0%,
        color-mix(in srgb, var(--sob-gold) 18%, transparent) 30%,
        color-mix(in srgb, var(--sob-gold) 8%, transparent) 72%,
        color-mix(in srgb, var(--sob-gold) 24%, transparent) 100%);
      -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
      -webkit-mask-composite: xor;
      mask: linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0);
    }
    @keyframes sau-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
    .sau-corner {
      position: absolute; width: 14px; height: 14px; pointer-events: none;
      border: 0 solid color-mix(in srgb, var(--sob-gold) 75%, transparent);
      filter: drop-shadow(0 0 4px color-mix(in srgb, var(--sob-gold) 60%, transparent));
    }
    .sau-corner--tl { top: -7px; left: -7px; border-top-width: 1.5px; border-left-width: 1.5px; border-top-left-radius: 6px; }
    .sau-corner--tr { top: -7px; right: -7px; border-top-width: 1.5px; border-right-width: 1.5px; border-top-right-radius: 6px; }
    .sau-corner--bl { bottom: -7px; left: -7px; border-bottom-width: 1.5px; border-left-width: 1.5px; border-bottom-left-radius: 6px; }
    .sau-corner--br { bottom: -7px; right: -7px; border-bottom-width: 1.5px; border-right-width: 1.5px; border-bottom-right-radius: 6px; }

    .sau-bar {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 13px 20px; border-bottom: 1px solid var(--sob-line);
      font-family: var(--sob-mono); font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sob-fg-3);
    }
    .sau-bar__path { color: var(--sob-fg-4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sau-bar__state { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; color: var(--sob-fg-2); }
    .sau-led { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; display: inline-block; background: var(--sob-gold); box-shadow: 0 0 8px var(--sob-gold); }
    .sau-bar__state--idle .sau-led, .sau-bar__state--busy .sau-led { animation: sob-caret 1.4s steps(1) infinite; }
    .sau-bar__state--ok { color: var(--sob-ok); }
    .sau-bar__state--ok .sau-led { background: var(--sob-ok); box-shadow: 0 0 8px var(--sob-ok); }
    .sau-bar__state--error { color: var(--sob-danger); }
    .sau-bar__state--error .sau-led { background: var(--sob-danger); box-shadow: 0 0 8px var(--sob-danger); }

    .sau-notice {
      display: flex; align-items: flex-start; gap: 10px; margin: 16px 20px 0; padding: 11px 14px; border-radius: 10px;
      font-size: 13.5px; line-height: 1.45; color: var(--sob-fg-2);
      background: color-mix(in srgb, var(--sob-gold) 7%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sob-gold) 22%, transparent);
    }
    .sau-notice .sau-led { margin-top: 6px; }
    .sau-notice--warn { background: color-mix(in srgb, var(--sob-amber) 10%, transparent); color: var(--sob-fg); }
    .sau-clerk { padding: 8px 18px 14px; min-height: 120px; }
    .sau-clerk[hidden] { display: none; }
    .sau-fallback { padding: 22px 22px 24px; display: flex; flex-direction: column; gap: 16px; }
    .sau-fallback p { margin: 0; color: var(--sob-fg-2); font-size: 14px; }

    .sau-log { padding: 20px 22px 22px; display: flex; flex-direction: column; gap: 16px; }
    .sau-log ol { list-style: none; margin: 0; padding: 0; font-family: var(--sob-mono); font-size: 12px; line-height: 1.9; color: var(--sob-fg-3); }
    .sau-log li { display: flex; align-items: center; gap: 10px; animation: sob-line-in 0.45s var(--sob-ease) both; animation-delay: calc(0.2s + var(--i) * 0.32s); }
    .sau-log li:last-child::after { content: ""; width: 7px; height: 13px; margin-left: 2px; background: var(--sob-gold); animation: sob-caret 1s steps(1) infinite; }
    .sau-log__tick { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; background: var(--sob-gold); box-shadow: 0 0 8px var(--sob-gold); }
    .sau-log__bar { height: 1px; overflow: hidden; position: relative; background: var(--sob-line); }
    .sau-log__bar span { position: absolute; top: 0; bottom: 0; width: 38%; background: linear-gradient(90deg, transparent, var(--sob-gold), transparent); animation: sob-bar 1.3s var(--sob-ease) infinite; }

    .sau-error, .sau-stuck { padding: 18px 22px 22px; display: flex; flex-direction: column; gap: 12px; }
    .sau-stuck { padding-top: 0; }
    .sau-error__head { display: flex; align-items: center; gap: 8px; font-family: var(--sob-mono); font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sob-danger); }
    .sau-error__head svg { width: 15px; height: 15px; }
    .sau-error__text { margin: 0; color: var(--sob-fg); font-size: 14.5px; line-height: 1.55; }
    .sau-error__detail {
      margin: 0; padding: 10px 12px; border-radius: 8px; overflow-wrap: anywhere;
      font-family: var(--sob-mono); font-size: 12px; line-height: 1.6; color: var(--sob-fg-2);
      background: rgba(0, 0, 0, 0.45); box-shadow: inset 0 0 0 1px var(--sob-line);
    }
    .sau-hint { margin: 0; color: var(--sob-fg-4); font-size: 12.5px; }
    .sau-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 4px; }

    .sau-btn {
      position: relative; overflow: hidden; display: inline-flex; align-items: center; justify-content: center; gap: 9px;
      height: 44px; padding: 0 18px; border-radius: 11px; border: 1px solid transparent; cursor: pointer; white-space: nowrap;
      font: 600 14px var(--sob-sans); letter-spacing: 0.01em;
      transition: transform 0.2s var(--sob-ease), box-shadow 0.25s, border-color 0.25s, background 0.25s, color 0.25s;
    }
    .sau-btn svg { width: 16px; height: 16px; flex-shrink: 0; }
    .sau-btn:focus-visible { outline: 2px solid var(--sob-gold); outline-offset: 3px; }
    .sau-btn--primary {
      color: #150f02;
      background: linear-gradient(180deg, color-mix(in srgb, var(--sob-gold) 80%, #fff) 0%, var(--sob-gold) 48%, color-mix(in srgb, var(--sob-gold) 84%, #b45309) 100%);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5), 0 10px 28px -10px color-mix(in srgb, var(--sob-gold) 70%, transparent), var(--sob-glow-soft);
    }
    .sau-btn--primary:hover { transform: translateY(-1px); box-shadow: inset 0 1px 0 rgba(255,255,255,0.5), 0 14px 32px -10px color-mix(in srgb, var(--sob-gold) 80%, transparent), var(--sob-glow); }
    .sau-btn--ghost { color: var(--sob-fg-2); background: rgba(255, 255, 255, 0.02); border-color: var(--sob-line); }
    .sau-btn--ghost:hover { color: var(--sob-fg); border-color: var(--sob-line-2); background: rgba(255,255,255,0.04); }

    .sau-foot {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap; justify-content: center;
      font-family: var(--sob-mono); font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--sob-fg-4);
      animation: sob-fade-in 0.8s 0.4s var(--sob-ease) both;
    }
    .sau-foot__dot { width: 3px; height: 3px; border-radius: 50%; background: var(--sob-fg-4); }

    @media (max-width: 560px) {
      .sau-stage { justify-content: flex-start; gap: 20px; padding: 36px 14px 28px; }
      .sau-mark { width: 64px; height: 64px; }
      .sau-mark img { width: 32px; height: 32px; }
      .sau-title { font-size: 27px; }
      .sau-sub { font-size: 14.5px; }
      .sau-clerk { padding: 6px 8px 10px; }
      .sau-actions .sau-btn { flex: 1 1 100%; }
    }
    /* Stack the footer lines below the width where they fit on one row: a wrapped row would
       leave a separator dot dangling at a line edge. */
    @media (max-width: 1380px) {
      .sau-foot { flex-direction: column; gap: 6px; text-align: center; letter-spacing: 0.1em; }
      .sau-foot__dot { display: none; }
    }
  </style>`;
}

function accountStyles(): TemplateResult {
  return html`<style>
    .sau-account {
      --sau-gold: var(--g-primary, #fbbf24);
      position: relative; display: inline-flex; flex-shrink: 0;
      font-family: "Space Grotesk", "Inter", ui-sans-serif, system-ui, sans-serif;
    }
    .sau-account--floating { position: fixed; top: 14px; right: 16px; z-index: 60; }
    @media (min-width: 1101px) and (max-width: 1680px) {
      .sau-account--floating { zoom: calc(1 / var(--ui-viewport-zoom, 0.7)); }
    }
    :root[data-viewport-scale="off"] .sau-account--floating { zoom: 1; }
    .sau-chip {
      display: inline-flex; align-items: center; gap: 8px; height: 34px; padding: 0 10px 0 3px; max-width: 230px;
      border-radius: 999px; cursor: pointer; color: var(--text, #f5f2ea);
      background: var(--glass-bg, rgba(255, 255, 255, 0.04));
      border: 1px solid color-mix(in srgb, var(--sau-gold) 26%, rgba(255, 255, 255, 0.08));
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
      font: 500 12.5px/1 inherit; font-family: inherit;
      transition: border-color 0.2s, box-shadow 0.25s, background 0.2s;
    }
    .sau-account--floating .sau-chip { background: rgba(10, 9, 7, 0.72); color: #f5f2ea; -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
    .sau-chip:hover, .sau-chip.is-open {
      border-color: color-mix(in srgb, var(--sau-gold) 60%, transparent);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 16px -4px color-mix(in srgb, var(--sau-gold) 55%, transparent);
    }
    .sau-chip:focus-visible { outline: 2px solid var(--sau-gold); outline-offset: 2px; }
    .sau-chip__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sau-chip__chev { display: inline-flex; opacity: 0.6; transition: transform 0.25s; }
    .sau-chip__chev svg { width: 14px; height: 14px; }
    .sau-chip.is-open .sau-chip__chev { transform: rotate(180deg); }
    .sau-mono {
      width: 26px; height: 26px; flex-shrink: 0; display: grid; place-items: center; border-radius: 50%;
      font: 600 12px/1 "JetBrains Mono", ui-monospace, monospace; color: var(--sau-gold);
      background: radial-gradient(circle at 50% 30%, color-mix(in srgb, var(--sau-gold) 22%, #0b0a07), #060504 75%);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sau-gold) 55%, transparent), 0 0 10px -2px color-mix(in srgb, var(--sau-gold) 50%, transparent);
      text-shadow: 0 0 8px color-mix(in srgb, var(--sau-gold) 60%, transparent);
    }
    .sau-mono--lg { width: 42px; height: 42px; font-size: 17px; }

    .sau-menu {
      position: absolute; top: calc(100% + 10px); right: 0; z-index: 1000;
      width: min(300px, calc(100vw - 24px)); box-sizing: border-box; padding: 6px;
      border-radius: 14px; color: #f5f2ea; color-scheme: dark; text-align: left;
      background: linear-gradient(180deg, rgba(22, 19, 13, 0.97), rgba(8, 7, 5, 0.98));
      box-shadow:
        inset 0 0 0 1px color-mix(in srgb, var(--sau-gold) 24%, rgba(255, 255, 255, 0.06)),
        inset 0 1px 0 rgba(255, 255, 255, 0.07),
        0 24px 60px -12px rgba(0, 0, 0, 0.85),
        0 0 40px -14px color-mix(in srgb, var(--sau-gold) 40%, transparent);
      animation: sau-menu-in 0.22s cubic-bezier(0.16, 1, 0.3, 1) both;
      transform-origin: top right;
    }
    @keyframes sau-menu-in { from { opacity: 0; transform: translateY(-4px) scale(0.98); } to { opacity: 1; transform: none; } }
    .sau-menu__head { display: flex; align-items: center; gap: 12px; padding: 12px 10px 14px; border-bottom: 1px solid rgba(255, 255, 255, 0.07); }
    .sau-menu__who { min-width: 0; }
    .sau-menu__name { font-size: 14.5px; font-weight: 600; color: #f5f2ea; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sau-menu__email { font: 12px/1.4 "JetBrains Mono", ui-monospace, monospace; color: rgba(245, 242, 234, 0.72); overflow-wrap: anywhere; }
    .sau-menu__rows { margin: 0; padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.07); }
    .sau-menu__rows > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .sau-menu__rows dt { font: 10.5px/1 "JetBrains Mono", ui-monospace, monospace; letter-spacing: 0.16em; text-transform: uppercase; color: rgba(245, 242, 234, 0.46); }
    .sau-menu__rows dd { margin: 0; font-size: 12.5px; color: #f5f2ea; }
    .sau-plan {
      display: inline-flex; align-items: center; height: 22px; padding: 0 10px; border-radius: 999px;
      font: 600 11px/1 "JetBrains Mono", ui-monospace, monospace; letter-spacing: 0.08em; text-transform: uppercase; color: var(--sau-gold);
      background: color-mix(in srgb, var(--sau-gold) 10%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sau-gold) 35%, transparent);
    }
    .sau-live { display: inline-flex; align-items: center; gap: 7px; }
    .sau-live .sau-led { width: 6px; height: 6px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 8px #4ade80; }
    .sau-menu__signout {
      display: flex; align-items: center; gap: 10px; width: 100%; margin-top: 6px; padding: 10px; border-radius: 9px;
      border: none; background: transparent; cursor: pointer; text-align: left;
      font: 500 13.5px/1 inherit; font-family: inherit; color: rgba(245, 242, 234, 0.86);
      transition: background 0.18s, color 0.18s;
    }
    .sau-menu__item {
      display: flex; align-items: center; gap: 10px; width: 100%; margin-top: 2px; padding: 10px; border-radius: 9px;
      border: none; background: transparent; cursor: pointer; text-align: left;
      font: 500 13.5px/1 inherit; font-family: inherit; color: rgba(245, 242, 234, 0.86);
      transition: background 0.18s, color 0.18s;
    }
    .sau-menu__item svg { width: 16px; height: 16px; flex-shrink: 0; }
    .sau-menu__item:hover, .sau-menu__item:focus-visible { background: rgba(212, 175, 55, 0.1); color: #f3e6c6; outline: none; }
    .sau-menu__signout svg { width: 16px; height: 16px; flex-shrink: 0; }
    .sau-menu__signout:hover:not(:disabled), .sau-menu__signout:focus-visible { background: rgba(248, 113, 113, 0.1); color: #fca5a5; outline: none; }
    .sau-menu__signout:disabled { cursor: progress; opacity: 0.7; }
    /* On phones .topbar-left (z 3) overflows across the status group (z 2) and
       swallows taps on its right edge; the account control must stay reachable. */
    @media (max-width: 768px) {
      .topbar-status:has(> .sau-account--topbar) { z-index: 6; }
    }
    @media (max-width: 900px) {
      .sau-chip { padding: 0 3px; gap: 0; }
      .sau-chip__label, .sau-chip__chev { display: none; }
    }
  </style>`;
}

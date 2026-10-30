/**
 * Multi-user workspaces — the pre-connect signup screen for `?signup=` invite
 * links, and the slim "signed in as" bar shown to workspace users (and the
 * read-only preview banner an admin sees in a "preview as user" tab).
 */

import { html, nothing, type TemplateResult } from "lit";
import { appAssetUrl } from "../app-base";
import { getBrandingForPreConnect } from "../controllers/app-branding";
import { ensureSystemGlass, sgIcon } from "../views/system-glass";
import {
  accessSignup,
  clearSignupFromUrl,
  fetchInvite,
  type AccessMe,
  type InviteInfo,
} from "./access-session";

type SignupHost = {
  gatewayUrl: string;
  requestUpdate: () => void;
  /** Persist the session token and connect. */
  onSignedUp: (token: string) => void;
  /** User chose "I already have an account". */
  onCancel: () => void;
};

const F = {
  token: "",
  info: null as InviteInfo | null,
  loading: false,
  username: "",
  displayName: "",
  email: "",
  password: "",
  confirm: "",
  busy: false,
  error: null as string | null,
};

const ROLE_COPY: Record<string, string> = {
  admin: "an admin — you'll manage people and visibility",
  member: "a member — you can view and edit what's shared with you",
  viewer: "a viewer — read-only access to what's shared with you",
};

export function renderAccessSignup(token: string, host: SignupHost): TemplateResult {
  ensureSystemGlass();
  ensureSignupCss();
  if (F.token !== token) {
    Object.assign(F, { token, info: null, loading: true, error: null });
    void fetchInvite(host.gatewayUrl, token).then((info) => {
      F.info = info;
      F.loading = false;
      if (info.email && !F.email) F.email = info.email;
      host.requestUpdate();
    });
  }
  const brand = getBrandingForPreConnect().branding;
  const appName = brand.appName || "InfiniBot";
  const logo = appAssetUrl(brand.logoDataUrl || brand.logoUrl || "./infinibot-logo.png");
  const info = F.info;
  const valid = info?.valid === true;
  const mismatch = F.confirm.length > 0 && F.confirm !== F.password;
  const canSubmit = valid && !F.busy && F.username.trim().length >= 2 && F.password.length >= 8 && F.password === F.confirm;

  const submit = async () => {
    if (!canSubmit) return;
    F.busy = true;
    F.error = null;
    host.requestUpdate();
    const r = await accessSignup(host.gatewayUrl, {
      invite: token,
      username: F.username.trim(),
      password: F.password,
      displayName: F.displayName.trim() || undefined,
      email: F.email.trim() || undefined,
    });
    F.busy = false;
    if (r.ok) {
      F.password = F.confirm = "";
      clearSignupFromUrl();
      host.onSignedUp(r.token);
    } else {
      F.error = r.error;
    }
    host.requestUpdate();
  };

  return html`<div class="acs-wrap sg-page">
    <div class="sg-aurora" aria-hidden="true"></div>
    <div class="acs-card sg-card">
      <div class="acs-brand">
        <img src=${logo} alt="" class="acs-logo" />
        <div>
          <p class="sg-eyebrow">${appName}</p>
          <h1 class="acs-title">You're <span class="sg-gold-text">invited</span></h1>
        </div>
      </div>
      ${F.loading || !info
        ? html`<p class="sg-faint">Checking your invite…</p>`
        : !valid
          ? html`<div class="acs-bad">${sgIcon("alert", 16)}
              <span>${info.status === "used"
                ? "This invite link has already been used."
                : info.status === "expired"
                  ? "This invite link has expired. Ask whoever sent it for a new one."
                  : info.status === "revoked"
                    ? "This invite link was revoked."
                    : info.status === "disabled"
                      ? "Workspace accounts aren't turned on for this gateway yet."
                      : info.status === "rate_limited"
                        ? "Too many attempts from this network — wait a few minutes and reload this page."
                        : info.status === "unreachable"
                          ? "Can't reach the gateway right now — check your connection and reload."
                      : "This invite link isn't valid."}</span></div>
            <button class="sg-btn acs-full" @click=${host.onCancel}>${sgIcon("arrowRight", 15)} Go to sign in</button>`
          : html`
              <p class="acs-lead">
                You'll join as ${ROLE_COPY[info.role ?? "viewer"] ?? info.role}${info.workspaces?.length
                  ? html` in <strong>${info.workspaces.join(", ")}</strong>`
                  : nothing}.
              </p>
              <form class="acs-form" @submit=${(e: Event) => (e.preventDefault(), void submit())}>
                <label>Username
                  <span class="acs-input">${sgIcon("user", 15)}<input class="sg-input" autocomplete="username" required minlength="2"
                    .value=${F.username} @input=${(e: Event) => ((F.username = (e.target as HTMLInputElement).value), host.requestUpdate())} placeholder="letters, numbers, . _ -" /></span>
                </label>
                <label>Your name
                  <span class="acs-input">${sgIcon("users", 15)}<input class="sg-input" autocomplete="name"
                    .value=${F.displayName} @input=${(e: Event) => (F.displayName = (e.target as HTMLInputElement).value)} placeholder="How others see you" /></span>
                </label>
                <label><span>Email <span class="sg-faint">(optional)</span></span>
                  <span class="acs-input">${sgIcon("globe", 15)}<input class="sg-input" type="email" autocomplete="email"
                    .value=${F.email} @input=${(e: Event) => (F.email = (e.target as HTMLInputElement).value)} /></span>
                </label>
                <label>Password
                  <span class="acs-input">${sgIcon("lock", 15)}<input class="sg-input" type="password" autocomplete="new-password" minlength="8" required
                    .value=${F.password} @input=${(e: Event) => ((F.password = (e.target as HTMLInputElement).value), host.requestUpdate())} placeholder="at least 8 characters" /></span>
                </label>
                <label>Confirm password
                  <span class="acs-input ${mismatch ? "is-bad" : ""}">${sgIcon("lock", 15)}<input class="sg-input" type="password" autocomplete="new-password" required
                    .value=${F.confirm} @input=${(e: Event) => ((F.confirm = (e.target as HTMLInputElement).value), host.requestUpdate())} /></span>
                </label>
                ${mismatch ? html`<p class="acs-hint-bad">Passwords don't match.</p>` : nothing}
                ${F.error ? html`<div class="acs-bad">${sgIcon("alert", 15)}<span>${F.error}</span></div>` : nothing}
                <button type="submit" class="sg-btn sg-btn--primary acs-full" ?disabled=${!canSubmit}>
                  ${F.busy ? "Creating your account…" : html`${sgIcon("check", 15)} Create account &amp; sign in`}
                </button>
              </form>
              ${info.expiresAt ? html`<p class="sg-faint acs-foot">Invite expires ${new Date(info.expiresAt).toLocaleString()}.</p>` : nothing}
              <button class="sg-btn sg-btn--ghost acs-full" @click=${host.onCancel}>I already have an account</button>
            `}
    </div>
  </div>`;
}

/** Top-of-content bar for workspace users: who, where, sign out. */
export function renderAccessUserBar(
  me: AccessMe | null,
  opts: { onSignOut: () => void; onEndPreview: () => void; onSelectWorkspace: (id: string) => void },
): TemplateResult | typeof nothing {
  if (!me || me.owner) return nothing;
  ensureSignupCss();
  const active = me.workspaces.find((w) => w.id === me.activeWorkspaceId);
  return html`<div class="acs-bar ${me.preview ? "acs-bar--preview" : ""}" role="status">
    ${me.preview
      ? html`${sgIcon("eye", 14)} <span>Previewing as <strong>${me.user.displayName}</strong> — read-only, exactly what they see.</span>`
      : html`${sgIcon("user", 14)} <span>Signed in as <strong>${me.user.displayName}</strong> · ${me.role}</span>`}
    ${me.workspaces.length > 1
      ? html`<select class="sg-input acs-bar__ws" aria-label="Workspace" .value=${me.activeWorkspaceId ?? ""}
          @change=${(e: Event) => opts.onSelectWorkspace((e.target as HTMLSelectElement).value)}>
          ${me.workspaces.map((w) => html`<option value=${w.id} ?selected=${w.id === me.activeWorkspaceId}>${w.name}</option>`)}
        </select>`
      : active
        ? html`<span class="acs-bar__chip">${sgIcon("layers", 12)} ${active.name}</span>`
        : html`<span class="acs-bar__chip">No workspace yet</span>`}
    <span class="acs-bar__spacer"></span>
    ${me.preview
      ? html`<button class="sg-btn sg-btn--sm" @click=${opts.onEndPreview}>${sgIcon("close", 13)} End preview</button>`
      : html`<button class="sg-btn sg-btn--sm sg-btn--ghost" @click=${opts.onSignOut}>${sgIcon("arrowRight", 13)} Sign out</button>`}
  </div>`;
}

const CSS_ID = "access-signup-css";
function ensureSignupCss() {
  if (typeof document === "undefined" || document.getElementById(CSS_ID)) return;
  const el = document.createElement("style");
  el.id = CSS_ID;
  el.textContent = `
.acs-wrap { position: fixed; inset: 0; display: grid; place-items: center; overflow: auto; padding: 24px; box-sizing: border-box;
  background: radial-gradient(1200px 600px at 50% -10%, rgba(217,180,95,.14), transparent 60%), #07070a; }
.acs-card { position: relative; width: min(460px, 100%); display: flex; flex-direction: column; gap: 16px; padding: 28px !important; }
.acs-brand { display: flex; align-items: center; gap: 14px; }
.acs-logo { width: 46px; height: 46px; border-radius: 12px; object-fit: contain; }
.acs-title { margin: 2px 0 0; font-size: 26px; letter-spacing: -.01em; color: var(--sg-fg); }
.acs-lead { margin: 0; color: var(--sg-fg-2); line-height: 1.5; }
.acs-lead strong { color: var(--sg-gold-hi); }
.acs-form { display: flex; flex-direction: column; gap: 12px; }
.acs-form label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--sg-fg-3); }
.acs-input { position: relative; display: flex; align-items: center; }
.acs-input > svg { position: absolute; left: 12px; color: var(--sg-gold); pointer-events: none; }
.acs-input input { width: 100%; box-sizing: border-box; padding-left: 36px !important; min-height: 42px; }
.acs-input.is-bad input { border-color: var(--sg-bad) !important; }
.acs-hint-bad { margin: -4px 0 0; color: var(--sg-bad); font-size: 12px; }
.acs-bad { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border-radius: 10px; color: #f3b5b5;
  border: 1px solid rgba(227,107,107,.45); background: rgba(227,107,107,.08); font-size: 13px; }
.acs-full { width: 100%; justify-content: center; min-height: 44px; }
.acs-foot { margin: 0; font-size: 12px; text-align: center; }
.acs-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 12px; padding: 8px 12px; border-radius: 12px; font-size: 13px;
  color: var(--text-strong, #f4f1ea); border: 1px solid rgba(217,180,95,.28); background: linear-gradient(90deg, rgba(217,180,95,.10), rgba(217,180,95,.03)); }
.acs-bar svg { color: #d9b45f; }
.acs-bar--preview { border-color: rgba(127,180,255,.45); background: linear-gradient(90deg, rgba(127,180,255,.12), rgba(127,180,255,.03)); }
.acs-bar__chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 999px; border: 1px solid rgba(217,180,95,.35); color: #f1d38a; font-size: 12px; }
.acs-bar__ws { min-width: 140px; padding: 4px 8px !important; }
.acs-bar__spacer { flex: 1; }
`;
  document.head.appendChild(el);
}

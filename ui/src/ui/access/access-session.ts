/**
 * Multi-user workspaces — browser side.
 *
 *  - pre-auth: GET /api/access/status, POST /api/access/login (+ 2FA code),
 *    GET /api/access/invite + POST /api/access/signup for `?signup=` links;
 *  - post-connect: `access.me` → who am I, which workspaces, what may I do —
 *    drives nav filtering for workspace users (the server enforces it anyway);
 *  - "preview as user" tabs: `?accessPreview=<token>` is moved into
 *    sessionStorage and used for this tab only, never persisted.
 */

import type { GatewayBrowserClient } from "../gateway";
import type { Tab } from "../navigation";

export type ResourceType =
  | "projects"
  | "kanban"
  | "documents"
  | "files"
  | "sessions"
  | "agents"
  | "knowledge"
  | "reports"
  | "dashboards";
export type Feature = "chat" | "coders" | "finance" | "secure";
export type Perms = {
  resources: Record<ResourceType, { view: boolean; edit: boolean }>;
  features: Record<Feature, boolean>;
};

export type AccessMe =
  | { enabled: boolean; owner: true; isAdmin: true; role: "owner" }
  | {
      enabled: true;
      owner: false;
      isAdmin: boolean;
      preview: boolean;
      role: "admin" | "member" | "viewer";
      user: { id: string; username: string; displayName: string; email: string | null; totpEnabled: boolean };
      features: Record<Feature, boolean>;
      workspaces: { id: string; name: string; color: string | null; role: string; perms: Perms }[];
      activeWorkspaceId: string | null;
      sessionPrefix: string;
    };

const PREVIEW_KEY = "ib.access.previewToken";

function httpBase(gatewayUrl: string | undefined): string {
  const u = (gatewayUrl || "").trim();
  if (!u) return "";
  try {
    const parsed = new URL(u.replace(/^ws/, "http"));
    // Same origin as the page → relative URLs (works behind any base path).
    if (typeof location !== "undefined" && parsed.host === location.host) return "";
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
}

// ── Pre-auth ──────────────────────────────────────────────────────────

let _status: boolean | null = null;
let _statusFor: string | null = null;

export function accessEnabled(): boolean | null {
  return _status;
}

/** Probe once per gateway; `onChange` fires when the answer arrives. */
export function probeAccessStatus(gatewayUrl: string, onChange: () => void): void {
  const key = gatewayUrl || "";
  if (_statusFor === key) return;
  _statusFor = key;
  void fetch(`${httpBase(gatewayUrl)}/api/access/status`, { method: "GET" })
    .then(async (r) => {
      if (!r.ok) return;
      const body = (await r.json()) as { enabled?: unknown };
      _status = body?.enabled === true;
      onChange();
    })
    .catch(() => {
      /* older gateway: leave null */
    });
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; error: string; needsCode?: boolean };

const LOGIN_ERRORS: Record<string, string> = {
  invalid_credentials: "Invalid username or password",
  account_disabled: "This account has been disabled — ask your admin",
  totp_required: "Enter the 6-digit code from your authenticator app",
  totp_invalid: "That code didn't match — try the next one",
  multi_user_disabled: "Workspace accounts are turned off on this gateway",
};

export async function accessLogin(
  gatewayUrl: string,
  login: string,
  password: string,
  code?: string,
): Promise<LoginResult> {
  try {
    const r = await fetch(`${httpBase(gatewayUrl)}/api/access/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login, password, code: code || undefined }),
    });
    const body = (await r.json().catch(() => ({}))) as { token?: string; expiresAt?: number; error?: string };
    if (r.ok && body.token) return { ok: true, token: body.token, expiresAt: body.expiresAt ?? 0 };
    if (r.status === 429) return { ok: false, error: "Too many attempts — try again in a few minutes" };
    const err = body.error ?? `login_failed_${r.status}`;
    return {
      ok: false,
      error: LOGIN_ERRORS[err] ?? `Sign-in failed (${r.status})`,
      needsCode: err === "totp_required" || err === "totp_invalid",
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function signupTokenFromUrl(): string | null {
  if (typeof location === "undefined") return null;
  const t = new URLSearchParams(location.search).get("signup");
  return t && t.startsWith("ibinv_") ? t : null;
}

export function clearSignupFromUrl(): void {
  try {
    const url = new URL(location.href);
    url.searchParams.delete("signup");
    history.replaceState(history.state, "", url.toString());
  } catch {
    /* ignore */
  }
}

export type InviteInfo = {
  valid: boolean;
  status: string;
  role?: string;
  email?: string | null;
  expiresAt?: number | null;
  workspaces?: string[];
};

export async function fetchInvite(gatewayUrl: string, token: string): Promise<InviteInfo> {
  try {
    const r = await fetch(`${httpBase(gatewayUrl)}/api/access/invite?token=${encodeURIComponent(token)}`);
    if (r.status === 429) return { valid: false, status: "rate_limited" };
    const body = (await r.json().catch(() => ({}))) as InviteInfo & { error?: string };
    if (body.error === "multi_user_disabled") return { valid: false, status: "disabled" };
    return { ...body, valid: body.valid === true };
  } catch {
    return { valid: false, status: "unreachable" };
  }
}

const SIGNUP_ERRORS: Record<string, string> = {
  invite_used: "This invite link has already been used",
  invite_expired: "This invite link has expired — ask for a new one",
  invite_revoked: "This invite link was revoked",
  invite_invalid: "This invite link isn't valid",
};

export async function accessSignup(
  gatewayUrl: string,
  input: { invite: string; username: string; password: string; displayName?: string; email?: string },
): Promise<LoginResult> {
  try {
    const r = await fetch(`${httpBase(gatewayUrl)}/api/access/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = (await r.json().catch(() => ({}))) as {
      token?: string;
      expiresAt?: number;
      error?: string;
      message?: string;
    };
    if (r.ok && body.token) return { ok: true, token: body.token, expiresAt: body.expiresAt ?? 0 };
    if (r.status === 429) return { ok: false, error: "Too many attempts — try again in a few minutes" };
    return { ok: false, error: SIGNUP_ERRORS[body.error ?? ""] ?? body.message ?? `Sign-up failed (${r.status})` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function accessLogoutHttp(gatewayUrl: string, token: string): Promise<void> {
  try {
    await fetch(`${httpBase(gatewayUrl)}/api/access/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    /* best effort */
  }
}

// ── Preview-as-user tabs ──────────────────────────────────────────────

/** Moves ?accessPreview=<token> into sessionStorage once, then returns it. */
export function accessPreviewToken(): string | null {
  try {
    const url = new URL(location.href);
    const fromUrl = url.searchParams.get("accessPreview");
    if (fromUrl && fromUrl.startsWith("ibus_")) {
      sessionStorage.setItem(PREVIEW_KEY, fromUrl);
      url.searchParams.delete("accessPreview");
      history.replaceState(history.state, "", url.toString());
    }
    return sessionStorage.getItem(PREVIEW_KEY);
  } catch {
    return null;
  }
}

export function endAccessPreview(): void {
  try {
    sessionStorage.removeItem(PREVIEW_KEY);
  } catch {
    /* ignore */
  }
}

// ── Post-connect: who am I ────────────────────────────────────────────

let _me: AccessMe | null = null;
let _meFor: GatewayBrowserClient | null = null;
let _meLoading = false;

export function getAccessMe(): AccessMe | null {
  return _me;
}

export function isWorkspaceUser(): boolean {
  return !!_me && _me.owner === false;
}

/** Load `access.me` once per client (and again after access.changed). */
export function ensureAccessMe(client: GatewayBrowserClient | null, onChange: () => void, force = false): void {
  if (!client || _meLoading) return;
  if (!force && _meFor === client) return;
  _meFor = client;
  _meLoading = true;
  void client
    .request("access.me", {})
    .then((me) => {
      _me = me as AccessMe;
      onChange();
    })
    .catch(() => {
      // Older gateway without access.* → treat as owner (no filtering).
      _me = null;
    })
    .finally(() => {
      _meLoading = false;
    });
}

export function resetAccessMe(): void {
  _me = null;
  _meFor = null;
}

/** Tabs a workspace user can open, from their permissions. */
const TAB_RULES: { tab: Tab; needs: (me: Extract<AccessMe, { owner: false }>) => boolean }[] = [
  { tab: "projects", needs: (m) => canView(m, "projects") },
  { tab: "notes", needs: (m) => canView(m, "documents") },
  { tab: "reports", needs: (m) => canView(m, "reports") },
  { tab: "knowledge-graph", needs: (m) => canView(m, "knowledge") },
  { tab: "chat", needs: (m) => m.features.chat && canView(m, "agents") },
  { tab: "webchat", needs: (m) => m.features.chat && canView(m, "agents") },
  { tab: "access", needs: () => true },
];

function canView(me: Extract<AccessMe, { owner: false }>, type: ResourceType): boolean {
  return me.workspaces.some((w) => w.perms.resources[type]?.view);
}

export function allowedTabsForMe(): Set<string> | null {
  const me = _me;
  if (!me || me.owner) return null;
  return new Set(TAB_RULES.filter((r) => r.needs(me)).map((r) => r.tab));
}

/** The nav `isPageAllowed` hook for workspace users (undefined = no filter). */
export function accessPageFilter(): ((tab: string) => boolean) | undefined {
  const allow = allowedTabsForMe();
  if (!allow) return undefined;
  return (tab: string) => allow.has(tab);
}

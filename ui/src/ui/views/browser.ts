/**
 * /browser tab — user-friendly setup + profile management for the
 * InfiniBot browser stack.
 *
 * Loads `browser.setup.status` once on mount, then offers one-click
 * actions for the things the user would otherwise do at the shell:
 *   - Confirm Chrome is installed (any Chromium-family browser counts)
 *   - Confirm Playwright is bundled
 *   - Locate the InfiniBot Browser Relay extension folder + open
 *     chrome://extensions
 *   - Create / inspect the canonical "infini" persistent profile
 *   - Snapshot a profile before a risky run; restore from a snapshot
 *
 * Markdown-style sections, generous icon sizing, copy-to-clipboard hints
 * for shell commands — matching the polish of the business command
 * center.
 */

import { html, nothing, type TemplateResult } from "lit";

import type { AppViewState } from "../app-view-state.js";
import type { GatewayBrowserClient } from "../gateway.js";
import { icons } from "../icons.js";
import "../components/live-browser-panel.js";
import { ensureHomeGlassStyles } from "./home-glass";

// ─── State shape ────────────────────────────────────────────────

interface BrowserSetupStatus {
  chrome: {
    found: boolean;
    path?: string;
    version?: string;
    brand?: string;
  };
  playwright: { found: boolean; version?: string };
  extension: {
    found: boolean;
    path?: string;
    version?: string;
    bundledPath?: string;
    installedPath?: string;
    legacyPath?: string;
    webStoreUrl?: string;
    installed?: boolean;
    zipPath?: string;
  };
  infini: {
    name: string;
    userDataDir: string;
    exists: boolean;
    sizeBytes?: number;
    lastUsedAt?: number;
  };
  profiles: Array<{
    name: string;
    userDataDir: string;
    exists: boolean;
    sizeBytes?: number;
    lastUsedAt?: number;
  }>;
  snapshots: Array<{
    profile: string;
    path: string;
    id: string;
    size: number;
    createdAt: number;
    label?: string;
  }>;
  paths: { profilesRoot: string };
  installHints?: Record<string, string>;
}

interface BrowserExtensionStatus {
  killSwitch: boolean;
  defaultDecision: "allow" | "ask" | "block";
  rules: Array<{ pattern: string; decision: "allow" | "ask" | "block" }>;
  profiles: Array<{
    id: string;
    name: string;
    extensionId: string;
    connected: boolean;
    lastSeenAt: number;
  }>;
  locks: Array<{ targetId: string; runId: string; at: number }>;
  audit: Array<{
    id: string;
    at: number;
    runId: string;
    url?: string;
    action: string;
    outcome: string;
  }>;
}

export interface BrowserSetupState {
  loading: boolean;
  error: string | null;
  status: BrowserSetupStatus | null;
  busy: string | null;
  toast: { kind: "info" | "ok" | "warn"; text: string } | null;
  newProfileName: string;
  snapshotLabel: string;
  expandedSnapshots: boolean;
  loadedAt: number | null;
  /** browser.profiles.list — the profiles agents actually browse with. */
  agentProfiles: AgentProfileRow[] | null;
  agentProfilesError: string | null;
  openProfile: string | null;
  sites: Record<string, { running: boolean; sites: ProfileSite[] } | undefined>;
  extensionControl: BrowserExtensionStatus | null;
  pairing: { code: string; expiresAt: number; profileName: string } | null;
  sitePattern: string;
  siteDecision: "allow" | "ask" | "block";
}

export interface AgentProfileRow {
  name: string;
  dir: string;
  exists: boolean;
  sizeBytes: number;
  running: boolean;
  lockedByOther: boolean;
  lockPid: number | null;
  siteCount: number;
}

export interface ProfileSite {
  site: string;
  cookies: number;
  sessionCookies: number;
  expiresAt: number | null;
}

/** Lazy-created holder on AppViewState. Keeps the type clean for callers
 *  that don't import the view file. */
export function getBrowserSetupState(state: AppViewState): BrowserSetupState {
  const holder = state as AppViewState & { browserSetupState?: BrowserSetupState };
  if (!holder.browserSetupState) {
    holder.browserSetupState = {
      loading: false,
      error: null,
      status: null,
      busy: null,
      toast: null,
      newProfileName: "",
      snapshotLabel: "",
      expandedSnapshots: false,
      loadedAt: null,
      agentProfiles: null,
      agentProfilesError: null,
      openProfile: null,
      sites: {},
      extensionControl: null,
      pairing: null,
      sitePattern: "",
      siteDecision: "ask",
    };
  }
  return holder.browserSetupState;
}

// ─── Data fetching ────────────────────────────────────────────

export async function loadBrowserSetupStatus(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = getBrowserSetupState(state);
  s.loading = true;
  s.error = null;
  state.requestUpdate?.();
  const profiles = loadAgentProfiles(state, client);
  const extension = loadBrowserExtensionStatus(state, client);
  try {
    const res = await client.request<BrowserSetupStatus>("browser.setup.status", {});
    s.status = res;
    s.loadedAt = Date.now();
  } catch (err) {
    s.error = (err as Error).message ?? String(err);
  } finally {
    await Promise.all([profiles, extension]);
    s.loading = false;
    state.requestUpdate?.();
  }
}

async function loadBrowserExtensionStatus(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = getBrowserSetupState(state);
  try {
    s.extensionControl = await client.request<BrowserExtensionStatus>(
      "browser.extension.status",
      {},
    );
  } catch (err) {
    s.toast = {
      kind: "warn",
      text: `Could not load extension controls — ${(err as Error).message}`,
    };
  }
  state.requestUpdate?.();
}

export async function loadAgentProfiles(
  state: AppViewState,
  client: GatewayBrowserClient,
): Promise<void> {
  const s = getBrowserSetupState(state);
  try {
    const res = await client.request<{ profiles: AgentProfileRow[] }>("browser.profiles.list", {});
    s.agentProfiles = res.profiles;
    s.agentProfilesError = null;
    if (s.openProfile) await loadProfileSites(state, client, s.openProfile);
  } catch (err) {
    s.agentProfilesError = (err as Error).message ?? String(err);
  }
  state.requestUpdate?.();
}

async function loadProfileSites(
  state: AppViewState,
  client: GatewayBrowserClient,
  profile: string,
): Promise<void> {
  const s = getBrowserSetupState(state);
  try {
    s.sites[profile] = await client.request<{ running: boolean; sites: ProfileSite[] }>(
      "browser.profiles.sites",
      { profile },
    );
  } catch (err) {
    s.toast = { kind: "warn", text: `Could not read saved logins — ${(err as Error).message}` };
  }
  state.requestUpdate?.();
}

async function runAction(
  state: AppViewState,
  client: GatewayBrowserClient,
  label: string,
  fn: () => Promise<unknown>,
  refresh = true,
): Promise<void> {
  const s = getBrowserSetupState(state);
  s.busy = label;
  s.toast = null;
  state.requestUpdate?.();
  try {
    await fn();
    s.toast = { kind: "ok", text: `${label} saved.` };
    if (refresh) await loadBrowserSetupStatus(state, client);
  } catch (err) {
    s.toast = { kind: "warn", text: `${label} — ${(err as Error).message}` };
  } finally {
    s.busy = null;
    state.requestUpdate?.();
  }
}

// ─── Format helpers ────────────────────────────────────────────

function fmtBytes(b?: number): string {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtRelative(ms?: number): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}

// ─── Render ────────────────────────────────────────────────────

export function renderBrowserSetup(
  state: AppViewState,
  client: GatewayBrowserClient,
): TemplateResult {
  ensureHomeGlassStyles();
  const s = getBrowserSetupState(state);
  if (!s.status && !s.loading && !s.error) {
    // Kick off the first load. Don't await — let lit re-render when it lands.
    void loadBrowserSetupStatus(state, client);
  }

  return html`
    <style>
      .bz-page {
        display: flex; flex-direction: column; gap: 16px; padding: 18px 22px 32px;
        width: 100%; max-width: 100%; min-width: 0; box-sizing: border-box; overflow-x: hidden;
      }
      .bz-page > *, .bz-card, .bz-ext-panel { min-width: 0; box-sizing: border-box; }
      .bz-page live-browser-panel { display: block; width: 100%; min-width: 0; overflow: hidden; }
      .bz-header {
        display: flex; align-items: center; justify-content: space-between;
        gap: 16px; flex-wrap: wrap;
        padding: 14px 18px;
        border-radius: 14px;
        background:
          linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 5%, transparent), transparent 80%),
          color-mix(in srgb, var(--g-bg, #0a0a0a) 38%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        backdrop-filter: blur(20px) saturate(150%);
      }
      .bz-eyebrow { font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: rgba(255,255,255,0.55); display: inline-flex; align-items: center; gap: 8px; }
      .bz-title { font-size: 22px; font-weight: 700; color: var(--c-fg, #f5f5f4); letter-spacing: -0.01em; }
      .bz-meta { font-size: 11px; color: rgba(255,255,255,0.55); }
      .bz-meta strong { color: var(--c-fg, #f5f5f4); font-weight: 600; }
      .bz-btn {
        appearance: none; font: inherit; cursor: pointer;
        font-size: 11px; font-weight: 600;
        letter-spacing: 0.06em; text-transform: uppercase;
        padding: 9px 14px; border-radius: 9px;
        border: 1px solid color-mix(in srgb, var(--g-primary) 24%, transparent);
        background: color-mix(in srgb, var(--g-bg, #0a0a0a) 30%, transparent);
        color: color-mix(in srgb, var(--g-primary) 85%, #cbd5e1);
        display: inline-flex; align-items: center; gap: 8px;
        transition: background 160ms ease, border-color 160ms ease, color 160ms ease;
      }
      .bz-btn:hover { background: color-mix(in srgb, var(--g-primary) 10%, transparent); color: var(--g-primary); border-color: color-mix(in srgb, var(--g-primary) 40%, transparent); }
      .bz-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .bz-btn--primary {
        background: linear-gradient(135deg, var(--g-primary), color-mix(in srgb, var(--g-primary) 70%, #6366f1));
        color: #0a0a0a; border-color: transparent;
      }
      .bz-btn--danger { color: #f87171; border-color: color-mix(in srgb, #ef4444 30%, transparent); }
      .bz-btn--danger:hover { background: color-mix(in srgb, #ef4444 10%, transparent); border-color: color-mix(in srgb, #ef4444 50%, transparent); color: #fca5a5; }

      .bz-card {
        background:
          linear-gradient(180deg, color-mix(in srgb, var(--g-primary) 4%, transparent), transparent 70%),
          color-mix(in srgb, var(--g-bg, #0a0a0a) 50%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 14%, transparent);
        border-radius: 14px;
        padding: 16px 18px;
        backdrop-filter: blur(18px) saturate(150%);
      }
      .bz-card-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
      .bz-card-icon {
        display: inline-flex;
        width: 36px; height: 36px;
        align-items: center; justify-content: center;
        border-radius: 10px;
        background: color-mix(in srgb, var(--g-primary) 16%, transparent);
        color: var(--g-primary);
        border: 1px solid color-mix(in srgb, var(--g-primary) 28%, transparent);
        flex-shrink: 0;
        font-size: 18px;
      }
      .bz-card-title-row { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
      .bz-card-title { font-size: 14px; font-weight: 700; color: var(--c-fg, #f5f5f4); letter-spacing: 0.02em; }
      .bz-card-sub { font-size: 11px; color: rgba(255,255,255,0.55); }

      .bz-checklist { display: flex; flex-direction: column; gap: 10px; }
      .bz-check {
        display: flex; align-items: center; gap: 12px;
        padding: 12px 14px;
        border-radius: 10px;
        background: color-mix(in srgb, #ffffff 2.5%, transparent);
        border: 1px solid color-mix(in srgb, #ffffff 4%, transparent);
      }
      .bz-check-icon {
        flex-shrink: 0;
        width: 30px; height: 30px;
        border-radius: 8px;
        display: inline-flex; align-items: center; justify-content: center;
        font-size: 16px; font-weight: 700;
      }
      .bz-check--ok .bz-check-icon { background: color-mix(in srgb, #22c55e 16%, transparent); color: #4ade80; border: 1px solid color-mix(in srgb, #22c55e 30%, transparent); }
      .bz-check--warn .bz-check-icon { background: color-mix(in srgb, #f59e0b 16%, transparent); color: #fbbf24; border: 1px solid color-mix(in srgb, #f59e0b 30%, transparent); }
      .bz-check--off .bz-check-icon { background: color-mix(in srgb, #64748b 14%, transparent); color: #94a3b8; border: 1px solid color-mix(in srgb, #64748b 24%, transparent); }
      .bz-check-body { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
      .bz-check-title { font-size: 12.5px; font-weight: 600; color: var(--c-fg, #f5f5f4); }
      .bz-check-detail { font-size: 11.5px; color: rgba(255,255,255,0.6); overflow: hidden; text-overflow: ellipsis; }
      .bz-check-actions { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }

      .bz-cmd {
        display: inline-flex; align-items: center; gap: 6px;
        font-family: ui-monospace, "JetBrains Mono", monospace;
        font-size: 11px;
        background: rgba(255,255,255,0.06);
        padding: 4px 8px; border-radius: 6px;
        color: rgba(255,255,255,0.85);
        user-select: all;
        cursor: copy;
      }
      .bz-cmd:hover { background: rgba(255,255,255,0.1); }

      .bz-grid-2 {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 14px;
      }

      .bz-profile-row, .bz-snap-row {
        display: flex; align-items: center; gap: 12px;
        padding: 10px 12px; border-radius: 10px;
        background: color-mix(in srgb, #ffffff 2%, transparent);
        border: 1px solid color-mix(in srgb, #ffffff 4%, transparent);
        margin-bottom: 6px;
      }
      .bz-profile-name { font-weight: 600; font-size: 12.5px; color: var(--c-fg, #f5f5f4); }
      .bz-profile-name--infini { color: var(--g-primary); }
      .bz-profile-path, .bz-snap-meta { font-size: 10.5px; color: rgba(255,255,255,0.55); font-family: ui-monospace, monospace; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bz-profile-meta { font-size: 10.5px; color: rgba(255,255,255,0.55); font-variant-numeric: tabular-nums; }
      .bz-profile-actions, .bz-snap-actions { display: flex; gap: 6px; flex-shrink: 0; }

      .bz-input {
        font: inherit; font-size: 12px;
        padding: 8px 10px; border-radius: 8px;
        background: rgba(255,255,255,0.04);
        border: 1px solid color-mix(in srgb, var(--g-primary) 16%, transparent);
        color: var(--c-fg, #f5f5f4);
        min-width: 140px;
      }
      .bz-input:focus { outline: 1px solid var(--g-primary); }

      .bz-empty {
        font-size: 11px; color: rgba(255,255,255,0.45);
        text-align: center; padding: 14px;
      }

      .bz-ext-grid { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(280px,.9fr); gap:14px; }
      .bz-ext-panel { border:1px solid color-mix(in srgb,var(--g-primary) 12%,transparent); border-radius:11px; padding:13px; background:rgba(0,0,0,.12); }
      .bz-ext-title { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:700; color:var(--c-fg,#f5f5f4); margin-bottom:8px; }
      .bz-ext-row { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 0; border-top:1px solid rgba(255,255,255,.06); font-size:11px; }
      .bz-ext-row:first-of-type { border-top:0; }
      .bz-ext-code { font:700 24px/1.2 ui-monospace,monospace; letter-spacing:.12em; color:var(--g-primary); padding:10px 0; }
      .bz-ext-install {
        display:grid; grid-template-columns:auto minmax(0,1fr); gap:8px 10px; align-items:start;
        margin-top:12px; padding:11px; border-radius:9px;
        background:color-mix(in srgb,var(--g-primary) 6%,transparent);
        border:1px solid color-mix(in srgb,var(--g-primary) 14%,transparent);
      }
      .bz-ext-install strong { font-size:11px; color:var(--c-fg,#f5f5f4); }
      .bz-ext-path { display:flex; align-items:center; gap:8px; margin-top:8px; padding:8px 10px; border-radius:8px;
        background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.08); color:var(--g-primary,#d4a64a); }
      .bz-ext-path code { color:var(--c-fg,#f5f5f4); font-size:11.5px; overflow-wrap:anywhere; white-space:normal; }
      .bz-ext-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
      .bz-ext-actions .bz-btn { display:inline-flex; align-items:center; gap:6px; }
      .bz-ext-steps { list-style:none; margin:12px 0 0; padding:0; display:grid; gap:10px; }
      .bz-ext-step { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,360px); gap:12px; align-items:center;
        padding:10px; border-radius:10px; background:rgba(255,255,255,.03); border:1px solid rgba(255,255,255,.07); }
      .bz-ext-step-text { display:flex; gap:10px; font-size:11.5px; line-height:1.5; color:rgba(255,255,255,.72); }
      .bz-ext-step-title { display:block; color:var(--c-fg,#f5f5f4); font-weight:700; font-size:12px; margin-bottom:2px; }
      .bz-ext-step-text strong { color:var(--c-fg,#f5f5f4); }
      .bz-ext-step-num { flex:0 0 22px; height:22px; border-radius:50%; display:grid; place-items:center; font-weight:800; font-size:11px;
        color:#1a1408; background:var(--g-primary,#d4a64a); }
      .bz-ext-step img { width:100%; max-width:360px; height:auto; justify-self:end; border-radius:8px; border:1px solid rgba(255,255,255,.1); display:block; }
      .bz-ext-zip { margin-top:8px; font-size:11px; color:rgba(255,255,255,.55); }
      .bz-ext-zip code { overflow-wrap:anywhere; }
      .bz-ext-illus { display:block; width:100%; max-width:380px; margin-top:10px; color:rgba(255,255,255,.7); }
      .bz-ext kbd, .bz-ext-zip kbd, .bz-ext-step kbd { padding:1px 5px; border:1px solid rgba(255,255,255,.25); border-radius:4px; font-size:10px; background:rgba(255,255,255,.06); }
      @media (max-width: 720px) { .bz-ext-step { grid-template-columns:1fr; } }
      .bz-ext-install code { overflow-wrap:anywhere; }
      .bz-kill-switch {
        min-height:40px; padding:10px 16px; font-weight:850; letter-spacing:.09em;
        color:#fff7f7 !important;
        background:linear-gradient(135deg,#b91c1c,#ef4444) !important;
        border-color:#fb7185 !important;
        box-shadow:0 0 0 1px rgba(239,68,68,.24),0 10px 24px rgba(127,29,29,.35);
      }
      .bz-kill-switch:hover { color:#fff !important; background:linear-gradient(135deg,#991b1b,#dc2626) !important; }
      .bz-policy-form { display:grid; grid-template-columns:minmax(0,1fr) 108px 82px; gap:10px; margin:8px 0; }
      .bz-policy-form .bz-btn { justify-content:center; }
      .bz-policy-form .bz-input { min-width:0; width:100%; box-sizing:border-box; }
      .bz-policy-form select.bz-input { padding-right:28px; }
      .bz-audit { max-height:220px; overflow:auto; }
      @media (max-width:760px) {
        .bz-page { padding:12px 16px 28px; gap:12px; }
        .bz-header, .bz-card { width:100%; max-width:100%; }
        .bz-card-head { align-items:flex-start; flex-wrap:wrap; }
        .bz-card-head > .bz-btn { width:100%; justify-content:center; }
        .bz-ext-grid { grid-template-columns:minmax(0,1fr); }
        .bz-policy-form { grid-template-columns:minmax(0,1fr) 92px; }
        .bz-policy-form .bz-btn { grid-column:1/-1; justify-content:center; }
        .bz-ext-row { align-items:flex-start; flex-wrap:wrap; }
        .bz-input { min-width:0; width:100%; box-sizing:border-box; }
        .bz-grid-2 { grid-template-columns:minmax(0,1fr); }
        .bz-profile-row, .bz-snap-row { flex-wrap:wrap; }
      }

      .bz-toast {
        padding: 10px 14px; border-radius: 8px; font-size: 12px;
        background: color-mix(in srgb, var(--g-primary) 12%, transparent);
        border: 1px solid color-mix(in srgb, var(--g-primary) 28%, transparent);
        color: var(--g-primary);
      }
      .bz-toast--warn { background: color-mix(in srgb, #f59e0b 10%, transparent); border-color: color-mix(in srgb, #f59e0b 28%, transparent); color: #fbbf24; }
      .bz-toast--ok { background: color-mix(in srgb, #22c55e 10%, transparent); border-color: color-mix(in srgb, #22c55e 28%, transparent); color: #4ade80; }
    </style>

    <div class="bz-page">
      ${renderHeader(state, client, s)}
      ${renderExtensionControl(state, client, s)}
      <live-browser-panel .client=${client}></live-browser-panel>
      ${renderAgentProfilesCard(state, client, s)}
      ${s.toast ? html`<div class="bz-toast bz-toast--${s.toast.kind}">${s.toast.text}</div>` : nothing}
      ${
        s.error
          ? html`<div class="bz-toast bz-toast--warn">Could not load setup status: ${s.error}</div>`
          : nothing
      }
      ${s.status ? renderChecklist(state, client, s.status, s) : renderLoading()}
      ${s.status ? renderInfiniProfile(state, client, s.status, s) : nothing}
      ${s.status ? renderProfilesCard(state, client, s.status, s) : nothing}
      ${s.status ? renderSnapshotsCard(state, client, s.status, s) : nothing}
      ${s.status ? renderQuickReferenceCard(s.status) : nothing}
    </div>
  `;
}

// ─── Sub-sections ────────────────────────────────────────────

function renderHeader(state: AppViewState, client: GatewayBrowserClient, s: BrowserSetupState) {
  return html`
    <header class="bz-header">
      <div>
        <span class="bz-eyebrow">${icons.globe} Browser</span>
        <div class="bz-title">Browser & Profile Setup</div>
        <div class="bz-meta">
          ${
            s.loadedAt
              ? html`<span>Last checked ${fmtRelative(s.loadedAt)}</span>`
              : html`
                  <span
                    >Configure the Chromium binary, the Browser Relay extension, and the persistent
                    <strong>infini</strong> profile.</span
                  >
                `
          }
        </div>
      </div>
      <div style="display:flex; gap:8px;">
        <button
          class="bz-btn"
          ?disabled=${s.loading}
          @click=${() => loadBrowserSetupStatus(state, client)}
        >${s.loading ? "Checking…" : "Re-check"}</button>
        <button
          class="bz-btn bz-btn--primary"
          ?disabled=${!!s.busy}
          @click=${() =>
            runAction(state, client, "Create infini profile", () =>
              client.request("browser.setup.create_infini", {}),
            )}
        >Create infini profile</button>
      </div>
    </header>
  `;
}

function renderLoading() {
  return html`
    <div class="bz-card"><div class="bz-empty">Checking your setup…</div></div>
  `;
}

function renderExtensionControl(
  state: AppViewState,
  client: GatewayBrowserClient,
  s: BrowserSetupState,
) {
  const control = s.extensionControl;
  if (!control)
    return html`
      <div class="bz-card"><div class="bz-empty">Loading secure extension controls…</div></div>
    `;

  const createPairing = async () => {
    s.pairing = await client.request<{ code: string; expiresAt: number; profileName: string }>(
      "browser.extension.pairing.create",
      { name: "My Chrome" },
    );
    state.requestUpdate?.();
  };
  const setKill = async (enabled: boolean) => {
    await client.request("browser.extension.kill.set", { enabled });
    await loadBrowserExtensionStatus(state, client);
  };
  const saveRules = async (rules: BrowserExtensionStatus["rules"]) => {
    await client.request("browser.extension.permissions.set", {
      rules,
      defaultDecision: control.defaultDecision,
    });
    s.sitePattern = "";
    await loadBrowserExtensionStatus(state, client);
  };

  return html`
    <section class="bz-card" data-testid="browser-extension-control">
      <div class="bz-card-head">
        <span class="bz-card-icon">${icons.shieldCheck}</span>
        <div class="bz-card-title-row">
          <div class="bz-card-title">Your real Chrome · secure relay</div>
          <div class="bz-card-sub">Paired profiles, agent tab groups, site access, audit trail, and the global kill switch.</div>
        </div>
        <button class="bz-btn bz-kill-switch ${control.killSwitch ? "bz-btn--primary" : "bz-btn--danger"}" @click=${() => setKill(!control.killSwitch)}>
          ${control.killSwitch ? icons.zap : icons.shield} ${control.killSwitch ? "Resume control" : "Pause all control"}
        </button>
      </div>

      <div class="bz-ext-grid">
        <div class="bz-ext-panel">
          <div class="bz-ext-title">${icons.key} Pair a Chrome profile</div>
          ${
            s.pairing
              ? html`
                <div class="bz-ext-code" data-testid="browser-pairing-code">${s.pairing.code}</div>
                <div class="bz-card-sub">Enter this in the extension options before ${new Date(s.pairing.expiresAt).toLocaleTimeString()}. It works once.</div>
              `
              : html`
                  <div class="bz-card-sub">
                    Generate a one-time code, then open the extension’s Pairing & settings screen.
                  </div>
                `
          }
          <button class="bz-btn bz-btn--primary" style="margin-top:10px" @click=${createPairing}>${icons.plus} ${s.pairing ? "New code" : "Create pairing code"}</button>
          <div class="bz-ext-install">
            <span>${icons.download}</span>
            <div>
              <strong>Install the extension</strong>
              <div class="bz-card-sub">
                Follow the <strong>InfiniBot Browser Relay extension</strong> steps in the setup checklist:
                open <code>chrome://extensions</code>, turn on <strong>Developer mode</strong>, click
                <strong>Load unpacked</strong> and pick the folder shown there. Then enter the one-time code above.
              </div>
            </div>
          </div>

          <div class="bz-ext-title" style="margin-top:16px">${icons.monitor} Connected profiles</div>
          ${
            control.profiles.length
              ? control.profiles.map(
                  (profile) => html`
                  <div class="bz-ext-row">
                    <div><strong>${profile.name}</strong><div class="bz-card-sub">${profile.connected ? "Connected now" : `Last seen ${fmtRelative(profile.lastSeenAt)}`}</div></div>
                    <button class="bz-btn bz-btn--danger" @click=${async () => {
                      await client.request("browser.extension.profile.revoke", { id: profile.id });
                      await loadBrowserExtensionStatus(state, client);
                    }}>${icons.trash} Revoke</button>
                  </div>`,
                )
              : html`
                  <div class="bz-empty">No Chrome profiles paired yet.</div>
                `
          }

          <div class="bz-ext-title" style="margin-top:16px">${icons.layers} Active agent tab groups</div>
          ${
            control.locks.length
              ? control.locks.map(
                  (lock) =>
                    html`<div class="bz-ext-row"><span>${lock.runId}</span><code>${lock.targetId.slice(0, 16)}</code></div>`,
                )
              : html`
                  <div class="bz-empty">No agent currently holds a tab lock.</div>
                `
          }
        </div>

        <div class="bz-ext-panel">
          <div class="bz-ext-title">${icons.globe} Site permissions</div>
          <div class="bz-card-sub">First matching rule wins. Unlisted sites default to <strong>${control.defaultDecision}</strong>.</div>
          <div class="bz-policy-form">
            <input class="bz-input" placeholder="example.com or *.domain" .value=${s.sitePattern} @input=${(
              event: Event,
            ) => {
              s.sitePattern = (event.currentTarget as HTMLInputElement).value;
            }} />
            <select class="bz-input" .value=${s.siteDecision} @change=${(event: Event) => {
              s.siteDecision = (event.currentTarget as HTMLSelectElement)
                .value as BrowserSetupState["siteDecision"];
            }}>
              <option value="allow">Allow</option><option value="ask">Ask</option><option value="block">Block</option>
            </select>
            <button class="bz-btn" @click=${() => s.sitePattern.trim() && saveRules([...control.rules, { pattern: s.sitePattern.trim(), decision: s.siteDecision }])}>${icons.plus} Add</button>
          </div>
          ${control.rules.map(
            (rule, index) => html`
            <div class="bz-ext-row"><code>${rule.pattern}</code><span>${rule.decision}</span><button class="bz-btn" aria-label=${`Remove ${rule.pattern}`} @click=${() => saveRules(control.rules.filter((_item, i) => i !== index))}>${icons.x}</button></div>
          `,
          )}

          <div class="bz-ext-title" style="margin-top:16px">${icons.scrollText} Recent audit</div>
          <div class="bz-audit">
            ${
              control.audit.length
                ? control.audit
                    .slice(0, 20)
                    .map(
                      (entry) =>
                        html`<div class="bz-ext-row"><div><strong>${entry.action}</strong><div class="bz-card-sub">${entry.url ?? entry.runId}</div></div><span>${entry.outcome}</span></div>`,
                    )
                : html`
                    <div class="bz-empty">Browser actions will appear here.</div>
                  `
            }
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderChecklist(
  state: AppViewState,
  client: GatewayBrowserClient,
  status: BrowserSetupStatus,
  s: BrowserSetupState,
) {
  return html`
    <div class="bz-card">
      <div class="bz-card-head">
        <span class="bz-card-icon">${icons.check}</span>
        <div class="bz-card-title-row">
          <div class="bz-card-title">Setup checklist</div>
          <div class="bz-card-sub">What InfiniBot needs to drive a browser on your behalf.</div>
        </div>
      </div>
      <div class="bz-checklist">
        ${renderCheckChrome(status)}
        ${renderCheckPlaywright(status)}
        ${renderCheckExtension(state, client, status, s)}
        ${renderCheckInfini(state, client, status, s)}
      </div>
    </div>
  `;
}

function renderCheckChrome(status: BrowserSetupStatus) {
  const ok = status.chrome.found;
  return html`
    <div class="bz-check ${ok ? "bz-check--ok" : "bz-check--off"}">
      <span class="bz-check-icon">${ok ? icons.check : icons.circle}</span>
      <div class="bz-check-body">
        <span class="bz-check-title">${ok ? "Chrome/Chromium installed" : "No Chromium-based browser detected"}</span>
        <span class="bz-check-detail">
          ${
            ok
              ? html`<strong>${status.chrome.brand}</strong> · <code>${status.chrome.path}</code> · ${status.chrome.version ?? ""}`
              : html`
                  Any Chromium-based browser works — Chrome, Chromium, Brave, Edge, Vivaldi, Thorium.
                `
          }
        </span>
        ${
          !ok && status.installHints
            ? html`<div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:6px;">
              ${Object.entries(status.installHints)
                .filter(([k]) => k !== "note")
                .map(
                  ([_k, cmd]) => html`<code class="bz-cmd"
                    @click=${(e: Event) =>
                      copyToClipboard((e.currentTarget as HTMLElement).textContent ?? "")}
                  >${cmd}</code>`,
                )}
            </div>`
            : nothing
        }
      </div>
    </div>
  `;
}

function renderCheckPlaywright(status: BrowserSetupStatus) {
  const ok = status.playwright.found;
  return html`
    <div class="bz-check ${ok ? "bz-check--ok" : "bz-check--warn"}">
      <span class="bz-check-icon">${ok ? icons.check : icons.alertCircle}</span>
      <div class="bz-check-body">
        <span class="bz-check-title">${ok ? "Playwright ready" : "Playwright not found"}</span>
        <span class="bz-check-detail">
          ${
            ok
              ? html`<code>playwright-core ${status.playwright.version}</code> — the engine InfiniBot uses to drive Chrome.`
              : html`
                  Run <code class="bz-cmd">pnpm install</code> in the InfiniBot repo. Playwright ships with the
                  project.
                `
          }
        </span>
      </div>
    </div>
  `;
}

const EXTENSION_STEPS: Array<{ img: string; title: string; body: TemplateResult }> = [
  {
    img: "/browser-extension/step-1-developer-mode.png",
    title: "Turn on Developer mode",
    body: html`Click <em>Copy chrome://extensions</em>, paste it into Chrome's address bar, then switch on
      <strong>Developer mode</strong> in the top-right corner.`,
  },
  {
    img: "/browser-extension/step-2-load-unpacked.png",
    title: "Click Load unpacked",
    body: html`In the folder picker press <kbd>Ctrl</kbd>+<kbd>L</kbd> (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>
      on macOS), paste the path you copied above, and press Enter.`,
  },
  {
    img: "/browser-extension/step-3-loaded.png",
    title: "Check it loaded",
    body: html`<strong>InfiniBot Browser Relay</strong> appears with the gold InfiniBot icon. Pin it from the
      puzzle-piece menu so you can click it on any tab.`,
  },
];

function renderCheckExtension(
  state: AppViewState,
  client: GatewayBrowserClient,
  status: BrowserSetupStatus,
  s: BrowserSetupState,
) {
  const ext = status.extension;
  const ok = ext.found;
  const folder = ext.path ?? "";
  return html`
    <div class="bz-check ${ok ? "bz-check--ok" : "bz-check--warn"}" data-testid="browser-extension-check">
      <span class="bz-check-icon">${ok ? icons.check : icons.alertCircle}</span>
      <div class="bz-check-body">
        <span class="bz-check-title">InfiniBot Browser Relay extension</span>
        <span class="bz-check-detail">
          ${
            ok
              ? html`Ready to load in Chrome${ext.version ? html` (v${ext.version})` : nothing}.
                  ${ext.installed ? "Copied to a visible folder that stays put across InfiniBot updates." : nothing}`
              : html`This install doesn't include the browser extension. Reinstall InfiniBot from
                  <a href="https://infinibotos.com/download" target="_blank" rel="noopener">infinibotos.com/download</a>.`
          }
        </span>
        ${
          ok
            ? html`
              <div class="bz-ext-path">
                <span class="bz-ext-path-icon">${icons.folder}</span>
                <code data-testid="browser-extension-path">${folder}</code>
              </div>
              <div class="bz-ext-actions">
                <button
                  class="bz-btn bz-btn--primary"
                  @click=${() => {
                    copyToClipboard(folder);
                    s.toast = { kind: "ok", text: "Extension folder path copied." };
                    state.requestUpdate?.();
                  }}
                >${icons.copy} Copy folder path</button>
                <button
                  class="bz-btn"
                  title="Browsers don't let pages open chrome:// links, so paste this into Chrome's address bar."
                  @click=${() => {
                    copyToClipboard("chrome://extensions");
                    s.toast = { kind: "ok", text: "Copied chrome://extensions. Paste it into Chrome's address bar." };
                    state.requestUpdate?.();
                  }}
                >${icons.copy} Copy chrome://extensions</button>
                <button
                  class="bz-btn"
                  title="Show the folder in your file manager."
                  @click=${async () => {
                    try {
                      await client.request("browser.setup.reveal_extension", {});
                      s.toast = { kind: "ok", text: "Opened the extension folder." };
                    } catch (err) {
                      s.toast = { kind: "err", text: (err as Error).message ?? "Could not open the folder." };
                    }
                    state.requestUpdate?.();
                  }}
                >${icons.folder} Open folder</button>
                <button
                  class="bz-btn"
                  ?disabled=${!!s.busy}
                  title="Copy a fresh version of the extension into the folder above."
                  @click=${() =>
                    runAction(state, client, "Extension folder refresh", () =>
                      client.request("browser.setup.install_extension", {}),
                    )}
                >${icons.refresh} Refresh copy</button>
              </div>
              ${
                ext.webStoreUrl
                  ? html`<div class="bz-ext-zip">
                      <a class="bz-btn bz-btn--primary" href=${ext.webStoreUrl} target="_blank" rel="noopener"
                        >Install from Chrome Web Store</a
                      >
                      — the easy way. The manual steps below are the fallback.
                    </div>`
                  : nothing
              }
              <svg class="bz-ext-illus" viewBox="0 0 360 74" role="img"
                aria-label="Folder picker with the extension path pasted into the location bar" data-testid="browser-extension-illustration">
                <rect x="1" y="1" width="358" height="72" rx="8" fill="rgba(255,255,255,0.04)" stroke="rgba(212,175,55,0.45)" />
                <rect x="12" y="12" width="336" height="22" rx="5" fill="rgba(0,0,0,0.35)" stroke="rgba(212,175,55,0.7)" />
                <text x="20" y="27" font-size="11" fill="#d4af37" font-family="monospace">Ctrl+L → ${folder.length > 38 ? "…" + folder.slice(-37) : folder}</text>
                <rect x="12" y="42" width="120" height="20" rx="4" fill="rgba(255,255,255,0.08)" />
                <text x="20" y="56" font-size="10" fill="currentColor">browser-extension</text>
                <rect x="276" y="42" width="72" height="20" rx="4" fill="#d4af37" />
                <text x="288" y="56" font-size="10" fill="#111">Select</text>
              </svg>
              <div class="bz-ext-zip" data-testid="browser-extension-tip">
                Can't see the folder? Press <kbd>Ctrl</kbd>+<kbd>H</kbd> to show hidden folders, or paste
                the path with <kbd>Ctrl</kbd>+<kbd>L</kbd>.
              </div>
              <ol class="bz-ext-steps">
                ${EXTENSION_STEPS.map(
                  (step, i) => html`
                    <li class="bz-ext-step">
                      <div class="bz-ext-step-text">
                        <span class="bz-ext-step-num">${i + 1}</span>
                        <div><span class="bz-ext-step-title">${step.title}</span><div>${step.body}</div></div>
                      </div>
                      <img src=${step.img} alt=${step.title} loading="lazy" />
                    </li>
                  `,
                )}
              </ol>
              ${
                ext.zipPath
                  ? html`<div class="bz-ext-zip">A zipped copy for other computers is at <code>${ext.zipPath}</code>.</div>`
                  : nothing
              }
            `
            : nothing
        }
      </div>
    </div>
  `;
}

function renderCheckInfini(
  state: AppViewState,
  client: GatewayBrowserClient,
  status: BrowserSetupStatus,
  s: BrowserSetupState,
) {
  const ok = status.infini.exists;
  return html`
    <div class="bz-check ${ok ? "bz-check--ok" : "bz-check--off"}">
      <span class="bz-check-icon">${ok ? icons.check : icons.circle}</span>
      <div class="bz-check-body">
        <span class="bz-check-title">${ok ? "Infini profile ready" : "Infini profile not created yet"}</span>
        <span class="bz-check-detail">
          ${
            ok
              ? html`<code>${status.infini.userDataDir}</code> · ${fmtBytes(status.infini.sizeBytes)} · last used ${fmtRelative(status.infini.lastUsedAt)}`
              : html`Click <em>Create infini profile</em> to create the persistent profile at <code>${status.infini.userDataDir}</code>. Cookies, logins, and extensions will survive across sessions.`
          }
        </span>
      </div>
      <div class="bz-check-actions">
        ${
          !ok
            ? html`<button
              class="bz-btn bz-btn--primary"
              ?disabled=${!!s.busy}
              @click=${() =>
                runAction(state, client, "Create infini profile", () =>
                  client.request("browser.setup.create_infini", {}),
                )}
            >Create</button>`
            : html`<button
              class="bz-btn"
              ?disabled=${!!s.busy}
              title="tar.gz the userDataDir so you can roll back from a known-good state."
              @click=${() =>
                runAction(state, client, "Snapshot infini", () =>
                  client.request("browser.setup.snapshot", {
                    profileName: "infini",
                    label: s.snapshotLabel?.trim() || undefined,
                  }),
                )}
            >Snapshot</button>`
        }
      </div>
    </div>
  `;
}

function fmtExpiry(ms: number | null): string {
  if (!ms) return "until the browser closes";
  const days = Math.round((ms - Date.now()) / 86_400_000);
  if (days <= 0) return "expires today";
  if (days < 60) return `expires in ${days} d`;
  return `expires ${new Date(ms).toLocaleDateString()}`;
}

function renderAgentProfilesCard(
  state: AppViewState,
  client: GatewayBrowserClient,
  s: BrowserSetupState,
) {
  const rows = s.agentProfiles;
  const toggle = async (name: string) => {
    s.openProfile = s.openProfile === name ? null : name;
    state.requestUpdate?.();
    if (s.openProfile) await loadProfileSites(state, client, name);
  };
  const clear = (profile: string, site?: string) => {
    const what = site ? `cookies for ${site}` : "ALL cookies";
    if (!window.confirm(`Clear ${what} in the "${profile}" profile? Agents will be signed out.`))
      return;
    void runAction(
      state,
      client,
      site ? `Cleared ${site}` : `Cleared all cookies in ${profile}`,
      async () => {
        await client.request(
          "browser.profiles.clear",
          site ? { profile, site } : { profile, all: true },
        );
        await loadAgentProfiles(state, client);
      },
      false,
    );
  };
  const remove = (profile: string) => {
    const warn =
      profile === "default"
        ? 'Delete the shared "default" profile? Every agent is signed out of every site and its history is erased.'
        : `Delete the "${profile}" profile and everything saved in it?`;
    if (!window.confirm(warn)) return;
    void runAction(
      state,
      client,
      `Deleted ${profile}`,
      async () => {
        await client.request("browser.profiles.delete", { profile, confirm: true });
        if (s.openProfile === profile) s.openProfile = null;
        await loadAgentProfiles(state, client);
      },
      false,
    );
  };
  return html`
    <div class="bz-card" data-testid="agent-browser-profiles">
      <div class="bz-card-head">
        <span class="bz-card-icon">${icons.lock}</span>
        <div class="bz-card-title-row">
          <div class="bz-card-title">Agent browser profiles</div>
          <div class="bz-card-sub">
            Cookies and logins agents use. They survive restarts. <strong>default</strong> is the browser shown above;
            agents pick another with <code>profile: "name"</code>. Secure Mode uses its own in-memory profile that is
            wiped when it closes.
          </div>
        </div>
        <button class="bz-btn" @click=${() => loadAgentProfiles(state, client)}>Refresh</button>
      </div>
      ${
        s.agentProfilesError
          ? html`<div class="bz-empty">Could not load profiles: ${s.agentProfilesError}</div>`
          : !rows
            ? html`
                <div class="bz-empty">Loading profiles…</div>
              `
            : rows.map(
                (p) => html`
                <div class="bz-profile-row" data-profile=${p.name}>
                  <span class="bz-profile-name ${p.name === "default" ? "bz-profile-name--infini" : ""}">${p.name}</span>
                  <span class="bz-profile-meta">
                    ${p.running ? html`<span style="color:#4ade80;display:inline-flex;align-items:center;gap:4px">${icons.circle} open</span> · ` : nothing}
                    ${p.lockedByOther ? html`<span style="color:#fbbf24">in use by pid ${p.lockPid}</span> · ` : nothing}
                    ${p.siteCount} site${p.siteCount === 1 ? "" : "s"} · ${fmtBytes(p.sizeBytes)}
                  </span>
                  <span class="bz-profile-path" title=${p.dir}>${p.dir}</span>
                  <span class="bz-profile-actions">
                    <button class="bz-btn" @click=${() => toggle(p.name)}>
                      ${s.openProfile === p.name ? "Hide sites" : "Saved logins"}
                    </button>
                    <button class="bz-btn" ?disabled=${!!s.busy || !p.siteCount} @click=${() => clear(p.name)}>Clear cookies</button>
                    <button class="bz-btn" ?disabled=${!!s.busy || !p.exists} @click=${() => remove(p.name)}>Delete</button>
                  </span>
                </div>
                ${s.openProfile === p.name ? renderProfileSites(p.name, s, clear) : nothing}
              `,
              )
      }
    </div>
  `;
}

function renderProfileSites(
  profile: string,
  s: BrowserSetupState,
  clear: (profile: string, site?: string) => void,
) {
  const data = s.sites[profile];
  if (!data)
    return html`
      <div class="bz-empty">Reading saved logins…</div>
    `;
  if (!data.sites.length)
    return html`
      <div class="bz-empty">No sites have stored cookies in this profile.</div>
    `;
  return html`
    <div class="bz-sites" data-testid="profile-sites" style="margin:0 0 10px 18px;">
      ${data.sites.map(
        (site) => html`
          <div class="bz-profile-row" style="padding:6px 10px;">
            <span class="bz-profile-name" style="font-weight:500">${site.site}</span>
            <span class="bz-profile-meta">
              ${site.cookies} cookie${site.cookies === 1 ? "" : "s"}${
                site.sessionCookies ? html` · ${site.sessionCookies} session` : nothing
              }
              · ${fmtExpiry(site.expiresAt)}
            </span>
            <span style="flex:1"></span>
            <span class="bz-profile-actions">
              <button class="bz-btn" ?disabled=${!!s.busy} @click=${() => clear(profile, site.site)}>Clear</button>
            </span>
          </div>
        `,
      )}
    </div>
  `;
}

function renderInfiniProfile(
  state: AppViewState,
  client: GatewayBrowserClient,
  status: BrowserSetupStatus,
  s: BrowserSetupState,
) {
  const infini = status.infini;
  return html`
    <div class="bz-card">
      <div class="bz-card-head">
        <span class="bz-card-icon" style="background: color-mix(in srgb, ${infini.exists ? "var(--g-primary)" : "#64748b"} 16%, transparent); color: ${infini.exists ? "var(--g-primary)" : "#94a3b8"};">
          ${icons.monitor}
        </span>
        <div class="bz-card-title-row">
          <div class="bz-card-title">infini — the canonical persistent profile</div>
          <div class="bz-card-sub">
            Logged-in cookies, extensions, and history live here. Renamed from the legacy
            <code>~/.infinibot/browser/</code> location to <code>~/.infinibot/chrome-profile/infini/</code>.
          </div>
        </div>
      </div>
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px;">
        <div>
          <div style="font-size:10px; letter-spacing:0.18em; text-transform:uppercase; color:rgba(255,255,255,0.5);">Status</div>
          <div style="font-size:14px; font-weight:600; color:${infini.exists ? "#4ade80" : "#94a3b8"}; margin-top:4px;">
            ${infini.exists ? "Ready" : "Not created"}
          </div>
        </div>
        <div>
          <div style="font-size:10px; letter-spacing:0.18em; text-transform:uppercase; color:rgba(255,255,255,0.5);">Path</div>
          <div style="font-size:12px; font-family:ui-monospace,monospace; color:var(--c-fg, #f5f5f4); margin-top:4px; overflow:hidden; text-overflow:ellipsis;">${infini.userDataDir}</div>
        </div>
        <div>
          <div style="font-size:10px; letter-spacing:0.18em; text-transform:uppercase; color:rgba(255,255,255,0.5);">Size</div>
          <div style="font-size:14px; font-weight:600; color:var(--c-fg, #f5f5f4); margin-top:4px;">${fmtBytes(infini.sizeBytes)}</div>
        </div>
        <div>
          <div style="font-size:10px; letter-spacing:0.18em; text-transform:uppercase; color:rgba(255,255,255,0.5);">Last used</div>
          <div style="font-size:14px; font-weight:600; color:var(--c-fg, #f5f5f4); margin-top:4px;">${fmtRelative(infini.lastUsedAt)}</div>
        </div>
      </div>
      <div style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap; align-items:center;">
        <input
          class="bz-input"
          placeholder="Snapshot label (optional)"
          .value=${s.snapshotLabel}
          @input=${(e: Event) => {
            s.snapshotLabel = (e.target as HTMLInputElement).value;
            state.requestUpdate?.();
          }}
        />
        <button
          class="bz-btn"
          ?disabled=${!infini.exists || !!s.busy}
          @click=${() =>
            runAction(state, client, "Snapshot infini", () =>
              client.request("browser.setup.snapshot", {
                profileName: "infini",
                label: s.snapshotLabel?.trim() || undefined,
              }),
            )}
        >Snapshot now</button>
      </div>
    </div>
  `;
}

function renderProfilesCard(
  state: AppViewState,
  client: GatewayBrowserClient,
  status: BrowserSetupStatus,
  s: BrowserSetupState,
) {
  return html`
    <div class="bz-card">
      <div class="bz-card-head">
        <span class="bz-card-icon">${icons.folder}</span>
        <div class="bz-card-title-row">
          <div class="bz-card-title">All profiles (${status.profiles.length})</div>
          <div class="bz-card-sub">Custom profiles live under <code>${status.paths.profilesRoot}</code>.</div>
        </div>
      </div>
      <div style="display:flex; gap:8px; margin-bottom:10px;">
        <input
          class="bz-input"
          placeholder="New profile name (letters, digits, ._-)"
          .value=${s.newProfileName}
          @input=${(e: Event) => {
            s.newProfileName = (e.target as HTMLInputElement).value;
            state.requestUpdate?.();
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter" && s.newProfileName.trim()) {
              const name = s.newProfileName.trim();
              s.newProfileName = "";
              void runAction(state, client, `Create "${name}"`, () =>
                client.request("browser.setup.create_infini", { profileName: name }),
              );
            }
          }}
        />
        <button
          class="bz-btn bz-btn--primary"
          ?disabled=${!s.newProfileName.trim() || !!s.busy}
          @click=${() => {
            const name = s.newProfileName.trim();
            if (!name) return;
            s.newProfileName = "";
            // Reuse create_infini path with explicit name — handler accepts profileName too.
            void runAction(state, client, `Create "${name}"`, () =>
              client.request("browser.setup.create_infini", { profileName: name }),
            );
          }}
        >Create</button>
      </div>
      ${
        status.profiles.length === 0
          ? html`
              <div class="bz-empty">No profiles yet. Click <em>Create infini profile</em> above to start.</div>
            `
          : status.profiles.map(
              (p) => html`
              <div class="bz-profile-row">
                <span class="bz-profile-name ${p.name === "infini" ? "bz-profile-name--infini" : ""}">${p.name}</span>
                <span class="bz-profile-path">${p.userDataDir}</span>
                <span class="bz-profile-meta">${fmtBytes(p.sizeBytes)} · ${fmtRelative(p.lastUsedAt)}</span>
                <div class="bz-profile-actions">
                  <button
                    class="bz-btn"
                    ?disabled=${!!s.busy}
                    title="tar.gz this profile so it can be restored later."
                    @click=${() =>
                      runAction(state, client, `Snapshot "${p.name}"`, () =>
                        client.request("browser.setup.snapshot", { profileName: p.name }),
                      )}
                  >Snapshot</button>
                  <button
                    class="bz-btn bz-btn--danger"
                    ?disabled=${!!s.busy}
                    title=${
                      p.name === "infini"
                        ? "Deleting infini wipes the persistent profile. Hold Shift+click to bypass typo protection."
                        : `Delete the "${p.name}" profile (irreversible)`
                    }
                    @click=${(e: MouseEvent) =>
                      void deleteProfileFlow(state, client, p.name, e.shiftKey)}
                  >Delete</button>
                </div>
              </div>
            `,
            )
      }
    </div>
  `;
}

function renderSnapshotsCard(
  state: AppViewState,
  client: GatewayBrowserClient,
  status: BrowserSetupStatus,
  s: BrowserSetupState,
) {
  const list = s.expandedSnapshots ? status.snapshots : status.snapshots.slice(0, 6);
  return html`
    <div class="bz-card">
      <div class="bz-card-head">
        <span class="bz-card-icon">${icons.folder}</span>
        <div class="bz-card-title-row">
          <div class="bz-card-title">Snapshots (${status.snapshots.length})</div>
          <div class="bz-card-sub">
            Full tar.gz archives of a profile's userDataDir. Restore to roll back logins/extensions/history.
          </div>
        </div>
      </div>
      ${
        status.snapshots.length === 0
          ? html`
              <div class="bz-empty">No snapshots yet. Use <em>Snapshot now</em> on a profile to take one.</div>
            `
          : list.map(
              (sn) => html`
              <div class="bz-snap-row">
                <span class="bz-profile-name ${sn.profile === "infini" ? "bz-profile-name--infini" : ""}">${sn.profile}</span>
                <span class="bz-snap-meta">${sn.label ? html`<strong>${sn.label}</strong> · ` : nothing}${fmtRelative(sn.createdAt)} · ${fmtBytes(sn.size)}</span>
                <div class="bz-snap-actions">
                  <button
                    class="bz-btn"
                    ?disabled=${!!s.busy}
                    title="Restore this profile to the state captured in this snapshot."
                    @click=${() =>
                      runAction(state, client, `Restore "${sn.profile}"`, () =>
                        client.request("browser.setup.restore", {
                          archivePath: sn.path,
                          profileName: sn.profile,
                        }),
                      )}
                  >Restore</button>
                  <button
                    class="bz-btn bz-btn--danger"
                    ?disabled=${!!s.busy}
                    title="Delete this snapshot file (cannot be undone)."
                    @click=${() =>
                      runAction(state, client, "Delete snapshot", () =>
                        client.request("browser.setup.delete_snapshot", { archivePath: sn.path }),
                      )}
                  >Delete</button>
                </div>
              </div>
            `,
            )
      }
      ${
        status.snapshots.length > 6
          ? html`<button
            class="bz-btn"
            style="margin-top:8px;"
            @click=${() => {
              s.expandedSnapshots = !s.expandedSnapshots;
              state.requestUpdate?.();
            }}
          >${s.expandedSnapshots ? "Show fewer" : `Show all ${status.snapshots.length}`}</button>`
          : nothing
      }
    </div>
  `;
}

function renderQuickReferenceCard(status: BrowserSetupStatus) {
  void status;
  return html`
    <div class="bz-card">
      <div class="bz-card-head">
        <span class="bz-card-icon">${icons.book}</span>
        <div class="bz-card-title-row">
          <div class="bz-card-title">Quick reference</div>
          <div class="bz-card-sub">How to use the browser tools from chat or scripts.</div>
        </div>
      </div>
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:12px; font-size:12px; color:rgba(255,255,255,0.75); line-height:1.6;">
        <div>
          <div style="font-weight:600; color:var(--c-fg,#f5f5f4); margin-bottom:4px;">From an agent (browser tool)</div>
          <code class="bz-cmd" @click=${(e: Event) => copyToClipboard((e.currentTarget as HTMLElement).textContent ?? "")}>browser action=profile.use_infini</code>
          <div style="font-size:11px; margin-top:6px;">Ensures the infini profile exists; tells you its path. Chrome can then be launched against it from any agent action that drives a browser.</div>
        </div>
        <div>
          <div style="font-weight:600; color:var(--c-fg,#f5f5f4); margin-bottom:4px;">Snapshot before risky run</div>
          <code class="bz-cmd" @click=${(e: Event) => copyToClipboard((e.currentTarget as HTMLElement).textContent ?? "")}>browser action=profile.snapshot profileName=infini label=before-bank</code>
          <div style="font-size:11px; margin-top:6px;">Saves a tar.gz of the userDataDir. Restore from <em>Snapshots</em> above if anything goes sideways.</div>
        </div>
        <div>
          <div style="font-weight:600; color:var(--c-fg,#f5f5f4); margin-bottom:4px;">Navigation policy</div>
          <code class="bz-cmd" @click=${(e: Event) => copyToClipboard((e.currentTarget as HTMLElement).textContent ?? "")}>browser action=nav_policy.get profileName=infini</code>
          <div style="font-size:11px; margin-top:6px;">By default only <code>http</code>/<code>https</code> are allowed and private IPs (including AWS metadata) are blocked. Add to <code>allowPrivateHosts</code> for explicit localhost work.</div>
        </div>
        <div>
          <div style="font-weight:600; color:var(--c-fg,#f5f5f4); margin-bottom:4px;">Sandbox a session</div>
          <code class="bz-cmd" @click=${(e: Event) => copyToClipboard((e.currentTarget as HTMLElement).textContent ?? "")}>browser action=profile.create profileName=work</code>
          <div style="font-size:11px; margin-top:6px;">Spin up an empty profile for ephemeral runs so unattended agents never touch your <strong>infini</strong> logins.</div>
        </div>
      </div>
    </div>
  `;
}

// ─── helpers ──────────────────────────────────────────────────

async function deleteProfileFlow(
  state: AppViewState,
  client: GatewayBrowserClient,
  profileName: string,
  bypassInfiniProtection: boolean,
) {
  if (
    profileName !== "infini" &&
    !window.confirm(`Delete the "${profileName}" profile? This is irreversible.`)
  ) {
    return;
  }
  if (profileName === "infini") {
    if (!bypassInfiniProtection) {
      window.alert(
        'The "infini" profile holds your real logins. Shift+click Delete to bypass typo protection.',
      );
      return;
    }
    if (
      !window.confirm(
        "Really delete the infini profile? This wipes cookies, logins, and extensions.",
      )
    ) {
      return;
    }
  }
  await runAction(state, client, `Delete "${profileName}"`, () =>
    client.request("browser.setup.delete_profile", {
      profileName,
      confirmInfini: profileName === "infini",
    }),
  );
}

function copyToClipboard(text: string): void {
  if (!text) return;
  try {
    navigator.clipboard?.writeText(text);
  } catch {
    /* ignore */
  }
}

/**
 * Profile Gate — the password-free profile chooser shown at app start
 * (and reachable later via "switch profile").
 *
 * Renders a grid of profile tiles + Add / Rename / Delete. Picking a tile
 * calls `profiles.switch` (re-points the gateway data layer), applies that
 * profile's appearance, marks the gate passed, and reloads so a fresh
 * connection re-resolves every store under the new profile. Shared
 * services (gateway, plugins, model backends) stay up across the switch.
 *
 * This is a sync render function (mirrors renderAuthScreen). Async profile
 * data is held in module state and refreshed via `state.requestUpdate()`.
 */

import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../gateway.js";
import {
  applyProfileAppearance,
  markGatePassed,
  setGateEnabled,
  setLastPicked,
  getLastPicked,
  isGateExplicitlyRequested,
  type ProfileRecord,
} from "../profiles.js";

export interface ProfileGateState {
  client: GatewayBrowserClient | null;
  requestUpdate?: () => void;
}

interface GateData {
  loaded: boolean;
  loading: boolean;
  profiles: ProfileRecord[];
  currentUserId: string;
  error: string | null;
  busy: boolean;
}

const data: GateData = {
  loaded: false,
  loading: false,
  profiles: [],
  currentUserId: "default",
  error: null,
  busy: false,
};

let _requestUpdate: (() => void) | undefined;

async function loadProfiles(client: GatewayBrowserClient): Promise<void> {
  if (data.loading) return;
  data.loading = true;
  data.error = null;
  _requestUpdate?.();
  try {
    const res = await client.call<{ profiles: ProfileRecord[]; currentUserId: string }>(
      "profiles.list",
    );
    data.profiles = res.profiles ?? [];
    data.currentUserId = res.currentUserId ?? "default";
    data.error = null;
    data.loaded = true;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const isTransient = msg.includes("stopped") || msg.includes("closed") || msg.includes("timeout");
    data.error = isTransient ? null : msg;
    data.loaded = !isTransient;
    // Transient disconnect — retry after the reconnect window
    if (isTransient) setTimeout(() => loadProfiles(client), 1500);
  } finally {
    data.loading = false;
    _requestUpdate?.();
  }
}

async function pickProfile(client: GatewayBrowserClient, profile: ProfileRecord): Promise<void> {
  if (data.busy) return;
  data.busy = true;
  data.error = null;
  _requestUpdate?.();
  try {
    await client.call("profiles.switch", { id: profile.id });
    applyProfileAppearance(profile);
    setLastPicked(profile.id);
    markGatePassed();
    // Full reload so every store re-resolves under the new profile.
    location.reload();
  } catch (e) {
    data.error = String((e as Error)?.message ?? e);
    data.busy = false;
    _requestUpdate?.();
  }
}

async function addProfile(client: GatewayBrowserClient): Promise<void> {
  const name = window.prompt("New profile name");
  if (!name?.trim()) return;
  const avatar = window.prompt("Avatar emoji (optional)", "👤") || "👤";
  data.busy = true;
  _requestUpdate?.();
  try {
    await client.call("profiles.create", { name: name.trim(), avatar });
    setGateEnabled(true); // more than one profile now exists
    data.loaded = false;
    await loadProfiles(client);
  } catch (e) {
    data.error = String((e as Error)?.message ?? e);
  } finally {
    data.busy = false;
    _requestUpdate?.();
  }
}

async function renameProfile(client: GatewayBrowserClient, profile: ProfileRecord): Promise<void> {
  const name = window.prompt("Rename profile", profile.name);
  if (!name?.trim() || name.trim() === profile.name) return;
  data.busy = true;
  _requestUpdate?.();
  try {
    await client.call("profiles.update", { id: profile.id, name: name.trim() });
    data.loaded = false;
    await loadProfiles(client);
  } catch (e) {
    data.error = String((e as Error)?.message ?? e);
  } finally {
    data.busy = false;
    _requestUpdate?.();
  }
}

async function removeProfile(client: GatewayBrowserClient, profile: ProfileRecord): Promise<void> {
  if (profile.id === "default") return;
  const ok = window.confirm(
    `Delete profile "${profile.name}"? Its data folder is left on disk unless you remove it manually.`,
  );
  if (!ok) return;
  data.busy = true;
  _requestUpdate?.();
  try {
    await client.call("profiles.delete", { id: profile.id });
    data.loaded = false;
    await loadProfiles(client);
  } catch (e) {
    data.error = String((e as Error)?.message ?? e);
  } finally {
    data.busy = false;
    _requestUpdate?.();
  }
}

/**
 * Dismiss the gate for this session WITHOUT switching (used by the
 * auto-skip path when only the default profile exists).
 */
export function dismissGate(): void {
  markGatePassed();
}

export function renderProfileGate(state: ProfileGateState) {
  _requestUpdate = state.requestUpdate;
  const client = state.client;
  if (!client) return nothing;

  if (!data.loaded && !data.loading) {
    void loadProfiles(client);
  }

  // Single-profile install (the default): there is nobody to pick between,
  // so pass the gate silently instead of showing a one-tile chooser.
  if (data.loaded && !data.error && data.profiles.length <= 1 && !isGateExplicitlyRequested()) {
    markGatePassed();
    queueMicrotask(() => state.requestUpdate?.());
    return nothing;
  }
  // Don't flash the chooser chrome while we find out.
  if (!data.loaded && !data.error) return nothing;

  const lastPicked = getLastPicked();

  return html`
    <style>
      ${gateStyles}
    </style>
    <div class="gate-container">
      <div class="gate-bg"><div class="gate-bg-grid"></div><div class="gate-bg-glow"></div></div>
      <div class="gate-content">
        <div class="gate-head">
          <h1 class="gate-title">WHO'S USING INFINIBOT?</h1>
          <p class="gate-headline">Pick a profile to continue</p>
          <p class="gate-subtitle">Separate data &amp; memory, shared services.</p>
        </div>

        ${data.error ? html`
          <div class="gate-error">
            ${data.error}
            <button class="gate-retry" @click=${() => { data.loaded = false; loadProfiles(client); }}>Retry</button>
          </div>` : nothing}

        ${!data.loaded
          ? html`<div class="gate-loading">Loading profiles…</div>`
          : html`
              <div class="gate-grid">
                ${data.profiles.map(
                  (p) => html`
                    <div
                      class="gate-tile ${p.id === lastPicked ? "gate-tile--last" : ""} ${data.busy
                        ? "gate-tile--busy"
                        : ""}"
                    >
                      <button
                        class="gate-tile-main"
                        ?disabled=${data.busy}
                        @click=${() => pickProfile(client, p)}
                        title="Use ${p.name}"
                      >
                        <span class="gate-avatar">${p.avatar || "👤"}</span>
                        <span class="gate-name">${p.name}</span>
                        ${p.id === data.currentUserId
                          ? html`<span class="gate-current">active</span>`
                          : nothing}
                      </button>
                      <div class="gate-tile-actions">
                        <button
                          class="gate-mini"
                          ?disabled=${data.busy}
                          @click=${() => renameProfile(client, p)}
                          title="Rename"
                        >
                          ✎
                        </button>
                        ${p.id !== "default"
                          ? html`<button
                              class="gate-mini gate-mini--danger"
                              ?disabled=${data.busy}
                              @click=${() => removeProfile(client, p)}
                              title="Delete"
                            >
                              🗑
                            </button>`
                          : nothing}
                      </div>
                    </div>
                  `,
                )}

                <button class="gate-tile gate-tile--add" ?disabled=${data.busy} @click=${() => addProfile(client)}>
                  <span class="gate-avatar">＋</span>
                  <span class="gate-name">Add profile</span>
                </button>
              </div>
            `}

        <button class="gate-skip" ?disabled=${data.busy} @click=${() => {
          dismissGate();
          state.requestUpdate?.();
        }}>
          Continue as ${data.profiles.find((p) => p.id === data.currentUserId)?.name ?? "current"} →
        </button>
      </div>
    </div>
  `;
}

const gateStyles = `
  .gate-container { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    background: var(--bg, #07090f); color: var(--fg, #e8edf6); z-index: 9000; overflow: auto; }
  .gate-bg { position: absolute; inset: 0; overflow: hidden; }
  .gate-bg-grid { position: absolute; inset: 0; background-image:
    linear-gradient(rgba(120,160,255,.06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(120,160,255,.06) 1px, transparent 1px);
    background-size: 42px 42px; mask-image: radial-gradient(circle at 50% 40%, #000 0%, transparent 75%); }
  .gate-bg-glow { position: absolute; top: -20%; left: 50%; width: 70vmax; height: 70vmax; transform: translateX(-50%);
    background: radial-gradient(circle, rgba(80,120,255,.18), transparent 60%); filter: blur(40px); }
  .gate-content { position: relative; width: min(900px, 92vw); padding: 32px; text-align: center; }
  .gate-head { margin-bottom: 36px; }
  .gate-title { font-size: clamp(18px, 2.4vw, 24px); letter-spacing: .18em; font-weight: 700; margin: 0 0 12px; opacity: .55; }
  .gate-headline { font-size: clamp(26px, 4vw, 40px); font-weight: 800; letter-spacing: -.01em; margin: 0 0 8px;
    background: linear-gradient(120deg, #fff, #9fc0ff); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .gate-subtitle { opacity: .6; margin: 0; font-size: 14px; }
  .gate-error { background: rgba(255,80,80,.12); border: 1px solid rgba(255,80,80,.4); color: #ffb4b4;
    padding: 10px 14px; border-radius: 10px; margin-bottom: 18px; font-size: 13px;
    display: flex; align-items: center; gap: 12px; }
  .gate-retry { margin-left: auto; padding: 5px 14px; background: rgba(255,80,80,.2);
    border: 1px solid rgba(255,80,80,.4); border-radius: 6px; color: #ffb4b4;
    font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  .gate-retry:hover { background: rgba(255,80,80,.35); }
  .gate-loading { opacity: .6; padding: 40px; }
  .gate-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 22px; }
  .gate-tile { position: relative; display: flex; flex-direction: column; align-items: center;
    background: rgba(255,255,255,.04); border: 1px solid rgba(140,170,255,.18); border-radius: 20px;
    padding: 0; overflow: hidden; transition: transform .14s ease, border-color .14s ease, background .14s ease, box-shadow .14s ease; }
  .gate-tile:hover { transform: translateY(-4px); border-color: rgba(140,170,255,.6); background: rgba(255,255,255,.08);
    box-shadow: 0 16px 40px rgba(60,100,255,.18); }
  .gate-tile--last { border-color: rgba(120,255,190,.55); box-shadow: 0 0 0 1px rgba(120,255,190,.35), 0 0 28px rgba(120,255,190,.18);
    animation: gate-pulse 2.2s ease-in-out infinite; }
  @keyframes gate-pulse {
    0%, 100% { box-shadow: 0 0 0 1px rgba(120,255,190,.35), 0 0 22px rgba(120,255,190,.14); }
    50% { box-shadow: 0 0 0 1px rgba(120,255,190,.7), 0 0 40px rgba(120,255,190,.34); }
  }
  .gate-tile--busy { opacity: .5; pointer-events: none; animation: none; }
  .gate-tile-main { all: unset; cursor: pointer; display: flex; flex-direction: column; align-items: center;
    gap: 12px; padding: 32px 18px 20px; width: 100%; box-sizing: border-box; }
  .gate-avatar { font-size: 60px; line-height: 1; }
  .gate-name { font-size: 17px; font-weight: 700; }
  .gate-current { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; opacity: .6; }
  .gate-tile-actions { display: flex; gap: 6px; padding: 0 0 10px; }
  .gate-mini { all: unset; cursor: pointer; font-size: 13px; opacity: .6; padding: 4px 8px; border-radius: 8px; }
  .gate-mini:hover { opacity: 1; background: rgba(255,255,255,.08); }
  .gate-mini--danger:hover { background: rgba(255,80,80,.18); }
  .gate-tile--add { cursor: pointer; border-style: dashed; justify-content: center; min-height: 190px; }
  .gate-tile--add .gate-tile-main, .gate-tile--add { color: rgba(180,200,255,.8); }
  .gate-skip { margin-top: 26px; background: none; border: none; color: inherit; opacity: .5;
    cursor: pointer; font-size: 13px; padding: 8px; }
  .gate-skip:hover { opacity: 1; }
`;

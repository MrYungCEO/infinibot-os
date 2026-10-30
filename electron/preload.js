/**
 * InfiniBot Satellite - Preload Script
 * 
 * Exposes safe APIs to the renderer process via contextBridge.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Mark renderer documents as desktop-owned before the control UI mounts. The
// browser build never receives this class, so its layout remains byte-for-byte
// unchanged. Window Controls Overlay geometry is expressed in renderer CSS
// pixels and therefore stays correct when Electron zoom is 0.7/0.8 or the OS
// display scale is 150%.
let desktopShellState = {
  platform: process.platform,
  overlayHeight: 38,
  fullscreen: false,
  maximized: false,
};

function applyDesktopShellInsets(next = {}) {
  desktopShellState = { ...desktopShellState, ...next };
  const root = document.documentElement;
  if (!root) return;

  const overlay = navigator.windowControlsOverlay;
  let rect = null;
  try { rect = overlay?.getTitlebarAreaRect?.() || null; } catch {/* unavailable */}

  const overlayVisible = !desktopShellState.fullscreen && overlay?.visible !== false;
  const zoom = Math.max(0.25, window.outerWidth > 0 && window.innerWidth > 0
    ? window.outerWidth / window.innerWidth
    : 1);
  const fallbackHeight = desktopShellState.overlayHeight / zoom;
  const safeTop = overlayVisible ? Math.max(Number(rect?.height) || 0, fallbackHeight) : 0;

  root.classList.add('desktop-shell');
  root.dataset.desktopPlatform = desktopShellState.platform;
  root.dataset.desktopFullscreen = desktopShellState.fullscreen ? 'true' : 'false';
  root.dataset.desktopMaximized = desktopShellState.maximized ? 'true' : 'false';
  root.style.setProperty('--desktop-titlebar-safe-top', `${safeTop}px`);
  root.style.setProperty('--desktop-titlebar-area-x', `${Number(rect?.x) || 0}px`);
  root.style.setProperty('--desktop-titlebar-area-width', `${Number(rect?.width) || 0}px`);
}

function installDesktopShellBridge() {
  applyDesktopShellInsets();
  void ipcRenderer.invoke('desktop-shell:get-state')
    .then((state) => applyDesktopShellInsets(state || {}))
    .catch(() => applyDesktopShellInsets());

  try {
    navigator.windowControlsOverlay?.addEventListener('geometrychange', () => {
      applyDesktopShellInsets();
    });
  } catch {/* Window Controls Overlay unsupported */}
}

if (document.documentElement) installDesktopShellBridge();
else window.addEventListener('DOMContentLoaded', installDesktopShellBridge, { once: true });

ipcRenderer.on('desktop-shell:state', (_event, state) => applyDesktopShellInsets(state || {}));

// Expose API to renderer
contextBridge.exposeInMainWorld('api', {
  // Configuration
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  
  // Gateway control
  getStatus: () => ipcRenderer.invoke('get-status'),
  startGateway: () => ipcRenderer.invoke('start-gateway'),
  stopGateway: () => ipcRenderer.invoke('stop-gateway'),
  restartGateway: () => ipcRenderer.invoke('restart-gateway'),
  
  // Utilities
  openLogs: () => ipcRenderer.invoke('open-logs'),
  // Open an http(s)/mailto link in the default browser → { ok }.
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', String(url)),
  
  // Event listeners
  onLog: (callback) => {
    const handler = (_, data) => callback(data);
    ipcRenderer.on('gateway-log', handler);
    return () => ipcRenderer.removeListener('gateway-log', handler);
  },
  
  onConnectionState: (callback) => {
    const handler = (_, state) => callback(state);
    ipcRenderer.on('connection-state', handler);
    return () => ipcRenderer.removeListener('connection-state', handler);
  },
  
  onShowConfigNeeded: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('show-config-needed', handler);
    return () => ipcRenderer.removeListener('show-config-needed', handler);
  },

  // ── Live Action Mode: multi-display + window control ──
  // Returns Promise<Array<{id, label, ordinal, isPrimary, bounds, workArea, ...}>>
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  // Move the main window onto the chosen display (id is the opaque value
  // from listDisplays()).
  moveWindowToDisplay: (displayId) => ipcRenderer.invoke('window:move-to-display', displayId),
  // Pin / unpin always-on-top while Live Action mode is engaged.
  setAlwaysOnTop: (value) => ipcRenderer.invoke('window:set-always-on-top', value),
  // Get the display id the window is currently on (for picker init).
  getCurrentDisplay: () => ipcRenderer.invoke('window:current-display'),

  // ── Native folder picker ──
  // Returns Promise<{ canceled: boolean, path: string | null }>.
  // Used by the Design page's "Load existing folder" flow.
  pickFolder: (options) => ipcRenderer.invoke('dialog:pickFolder', options),

  // ── Optional components (download-on-demand packs) ──
  // Backs the Settings → Components tab. install() streams progress over the
  // 'components:progress' channel; subscribe via onComponentProgress().
  components: {
    list: () => ipcRenderer.invoke('components:list'),
    status: (name) => ipcRenderer.invoke('components:status', name),
    install: (name) => ipcRenderer.invoke('components:install', name),
    remove: (name) => ipcRenderer.invoke('components:remove', name),
    onProgress: (callback) => {
      const handler = (_e, payload) => callback(payload);
      ipcRenderer.on('components:progress', handler);
      return () => ipcRenderer.removeListener('components:progress', handler);
    },
  },
});

// First-run wizard bridge. Kept on its own namespace so the satellite
// renderer (index.html / renderer.js) and the wizard renderer can
// evolve independently.
contextBridge.exposeInMainWorld('wizard', {
  getDefaults: () => ipcRenderer.invoke('wizard:get-defaults'),
  // First launch: choose where this install keeps its data (state dir).
  pickStateDir: () => ipcRenderer.invoke('wizard:pick-state-dir'),
  // First launch: write a default config (no keys) so the gateway can boot and
  // the control UI's Setup › Get started onboarding takes over.
  firstRunSetup: () => ipcRenderer.invoke('wizard:first-run-setup'),
  pickBackup: () => ipcRenderer.invoke('wizard:pick-backup'),
  inspectBackup: (zipPath) => ipcRenderer.invoke('wizard:inspect-backup', zipPath),
  restoreBackup: (zipPath) => ipcRenderer.invoke('wizard:restore-backup', zipPath),
  setupLocal: (opts) => ipcRenderer.invoke('wizard:setup-local', opts),
  setupSatellite: (opts) => ipcRenderer.invoke('wizard:setup-satellite', opts),
  joinFederation: (opts) => ipcRenderer.invoke('wizard:join-federation', opts),
  startLocalGateway: () => ipcRenderer.invoke('wizard:start-local-gateway'),
  openGatewayUi: (url) => ipcRenderer.invoke('wizard:open-gateway-ui', url),
  openSatelliteUi: () => ipcRenderer.invoke('wizard:open-satellite-ui'),

  // ── Full-onboard stepper additions ──
  // CLI coder backends (the four CoderBackendIds) with install state + login
  // command, sourced from the gateway's `listAllBackends()` (one source of
  // truth) → { ok, backends: BackendInstallStatus[], active } | { ok:false }.
  coderBackends: () => ipcRenderer.invoke('wizard:coder-backends'),
  // Gateway-chat provider/model catalog, grouped Provider → [models], sourced
  // from the gateway's model catalog (same data as the `models.list` RPC) →
  // { ok, providers: [{ id, label, needsKey, keyFlag, models:[{id,name}] }] }.
  listProviders: () => ipcRenderer.invoke('wizard:list-providers'),
  // Live model discovery for a provider ({ provider, apiKey, endpoint }).
  fetchModels: (params) => ipcRenderer.invoke('wizard:fetch-models', params),
  // Notion onboarding: verify a token ({ token }) and list accessible pages.
  notionVerify: (params) => ipcRenderer.invoke('wizard:notion-verify', params),
  openCloud: (opts) => ipcRenderer.invoke('wizard:open-cloud', opts),
  notionPages: (params) => ipcRenderer.invoke('wizard:notion-pages', params),
  // Pure (no-network) format validation of provided keys →
  // { ok:true, results: { <field>: boolean } }.
  probeKeys: (keys) => ipcRenderer.invoke('wizard:probe-keys', keys),
  // Developer-only: delete the (sandbox) config so setup can be re-run.
  resetState: () => ipcRenderer.invoke('wizard:reset-state'),
});

// License (plan + features) bridge. The main process is the single source of
// truth (electron/license.js); this only relays. getPlan/getFeatures/hasFeature
// are synchronous (sendSync) so renderer gates never need to await. Sandbox-safe:
// only `electron` is required here — no os/fs/etc.
contextBridge.exposeInMainWorld('license', {
  // Synchronous reads from the main-process in-memory state.
  getPlan: () => ipcRenderer.sendSync('license:get-plan'),
  getFeatures: () => ipcRenderer.sendSync('license:get-features'),
  hasFeature: (id) => ipcRenderer.sendSync('license:has-feature', id),
  getState: () => ipcRenderer.sendSync('license:get-state'),
  // Async actions.
  refresh: () => ipcRenderer.invoke('license:refresh'),
  signIn: () => ipcRenderer.invoke('license:sign-in'),
  // Phase F: optional base64url `intent` is threaded through to the checkout
  // return URL (infinibot://license-refreshed?intent=…) so the queued action
  // can be rehydrated on return.
  openUpgrade: (plan, intent) => ipcRenderer.invoke('wizard:openUpgrade', plan, intent),
  logout: () => ipcRenderer.invoke('license:logout'),
  // Append one upgrade-funnel telemetry record to the JSONL sink.
  telemetryAppend: (record) => ipcRenderer.invoke('license:telemetry:append', record),
  // Dev-only (main process guards on INFINIBOT_ALLOW_RESET=1).
  setDebug: (token) => ipcRenderer.invoke('wizard:set-license-debug', token),
  // Fires whenever the main process updates license state (callback, refresh…).
  onChanged: (callback) => {
    const handler = (_e, state) => callback(state);
    ipcRenderer.on('license:changed', handler);
    return () => ipcRenderer.removeListener('license:changed', handler);
  },
  // infinibot://walkthrough/<id> deep links surface here (no-op if unwired).
  onWalkthrough: (callback) => {
    const handler = (_e, payload) => callback(payload);
    ipcRenderer.on('walkthrough:open', handler);
    return () => ipcRenderer.removeListener('walkthrough:open', handler);
  },
  // Phase F: fired after a checkout return (infinibot://license-refreshed?intent=…)
  // once the license has been refreshed — the renderer drains the matching
  // queued action. `intent` is the decoded { feature, label } object.
  onReplayIntent: (callback) => {
    const handler = (_e, intent) => callback(intent);
    ipcRenderer.on('license:replay-intent', handler);
    return () => ipcRenderer.removeListener('license:replay-intent', handler);
  },
  // Fired when a checkout window is closed without completing — the renderer
  // silently drops the matching queued intent ("Maybe later").
  onReplayCancel: (callback) => {
    const handler = (_e, intent) => callback(intent);
    ipcRenderer.on('license:replay-cancel', handler);
    return () => ipcRenderer.removeListener('license:replay-cancel', handler);
  },
});

// InfiniBot Vault auth bridge. The Vault device-flow token (separate from the
// license/plan token) is what the gateway/CLI require — this lets the wizard
// establish it through the UI instead of telling the user to run a terminal
// `infinibot login`.
contextBridge.exposeInMainWorld('auth', {
  // { ok, signedIn, tenantId }
  status: () => ipcRenderer.invoke('auth:status'),
  // Opens the Vault approval window, polls, persists the token bundle.
  // Resolves { ok, tenantId } | { ok:false, cancelled?, error }.
  deviceLogin: () => ipcRenderer.invoke('auth:device-login'),
  // Fires once with { userCode, verificationUri } while a device login is
  // waiting for approval, so the UI can show the code.
  onDevicePending: (callback) => {
    const handler = (_e, payload) => callback(payload);
    ipcRenderer.on('auth:device-pending', handler);
    return () => ipcRenderer.removeListener('auth:device-pending', handler);
  },
});

// Platform info. Sandboxed preload can't `require('os')`, so hostname is
// fetched lazily via IPC. `os` and `arch` come from the exposed `process`.
contextBridge.exposeInMainWorld('platform', {
  os: process.platform,
  arch: process.arch,
  getInfo: () => ipcRenderer.invoke('platform:info'),
});

// Desktop app updates (electron-updater in the main process). The control
// UI's sidebar update widget uses this instead of the npm registry when it
// runs inside the desktop app. State: { status, currentVersion, version,
// percent, error, packageType, canSelfUpdate, downloadUrl, checkedAt }.
contextBridge.exposeInMainWorld('desktopUpdater', {
  getState: () => ipcRenderer.invoke('desktop-update:get-state'),
  check: () => ipcRenderer.invoke('desktop-update:check'),
  // Self-updating builds download in place; others open the download page.
  download: () => ipcRenderer.invoke('desktop-update:download'),
  install: () => ipcRenderer.invoke('desktop-update:install'),
  openDownload: () => ipcRenderer.invoke('desktop-update:open-download'),
  onState: (callback) => {
    const handler = (_e, state) => callback(state);
    ipcRenderer.on('desktop-update:state', handler);
    return () => ipcRenderer.removeListener('desktop-update:state', handler);
  },
});

// ── Satellite mode ───────────────────────────────────────────────────────────
// When this computer is a satellite, the window shows the MASTER's UI. A small
// always-visible badge in the title-bar strip says which device you are on and
// whether it is connected; clicking it opens the Satellite status window.
contextBridge.exposeInMainWorld('satellite', {
  getStatus: () => ipcRenderer.invoke('satellite:get-status'),
  waitConnected: (opts) => ipcRenderer.invoke('satellite:wait-connected', opts || {}),
  openStatus: () => ipcRenderer.invoke('satellite:open-status'),
  openMasterUi: () => ipcRenderer.invoke('satellite:open-master-ui'),
  reconnect: () => ipcRenderer.invoke('satellite:reconnect'),
  disconnect: () => ipcRenderer.invoke('satellite:disconnect'),
  connect: () => ipcRenderer.invoke('satellite:connect'),
  leave: () => ipcRenderer.invoke('satellite:leave'),
  onStatus: (callback) => {
    const handler = (_e, payload) => callback(payload);
    ipcRenderer.on('satellite:status', handler);
    return () => ipcRenderer.removeListener('satellite:status', handler);
  },
});

function renderSatelliteBadge(payload) {
  if (!/^https?:$/.test(location.protocol)) return; // wizard/status pages are file://
  if (!payload || !payload.satellite) return;
  const root = document.body || document.documentElement;
  if (!root) return;
  let el = document.getElementById('ib-satellite-badge');
  if (!el) {
    el = document.createElement('button');
    el.id = 'ib-satellite-badge';
    el.type = 'button';
    el.title = 'Satellite status';
    el.setAttribute('aria-label', 'Satellite status');
    el.addEventListener('click', () => { void ipcRenderer.invoke('satellite:open-status'); });
    const dot = document.createElement('span');
    dot.className = 'ib-sat-dot';
    const label = document.createElement('span');
    label.className = 'ib-sat-label';
    el.append(dot, label);
    const style = document.createElement('style');
    style.id = 'ib-satellite-badge-style';
    style.textContent = `
      #ib-satellite-badge{position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:2147483646;
        display:inline-flex;align-items:center;gap:8px;height:26px;padding:0 12px;border-radius:999px;
        border:1px solid rgba(246,200,115,.35);background:rgba(10,10,12,.82);color:#f6c873;
        font:500 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;letter-spacing:.01em;
        -webkit-app-region:no-drag;cursor:pointer;backdrop-filter:blur(10px);box-shadow:0 4px 18px rgba(0,0,0,.35);
        max-width:min(70vw,640px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #ib-satellite-badge:hover{border-color:rgba(246,200,115,.7)}
      #ib-satellite-badge .ib-sat-dot{width:8px;height:8px;border-radius:50%;flex:none;background:#71717a}
      #ib-satellite-badge[data-state=connected] .ib-sat-dot{background:#22c55e;box-shadow:0 0 8px rgba(34,197,94,.7)}
      #ib-satellite-badge[data-state=reconnecting] .ib-sat-dot,#ib-satellite-badge[data-state=connecting] .ib-sat-dot,
      #ib-satellite-badge[data-state=registering] .ib-sat-dot{background:#f59e0b}
      #ib-satellite-badge[data-state=disconnected] .ib-sat-dot,#ib-satellite-badge[data-state=stopped] .ib-sat-dot{background:#ef4444}
      #ib-satellite-badge .ib-sat-label{overflow:hidden;text-overflow:ellipsis}`;
    (document.head || root).appendChild(style);
    root.appendChild(el);
  }
  el.dataset.state = payload.status?.state || (payload.running ? 'connecting' : 'stopped');
  el.querySelector('.ib-sat-label').textContent = payload.text || 'This device · satellite';
}

ipcRenderer.on('satellite:status', (_e, payload) => {
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => renderSatelliteBadge(payload), { once: true });
  } else {
    renderSatelliteBadge(payload);
  }
});
window.addEventListener('DOMContentLoaded', () => {
  if (!/^https?:$/.test(location.protocol)) return;
  void ipcRenderer.invoke('satellite:get-status').then(renderSatelliteBadge).catch(() => {});
}, { once: true });

/**
 * InfiniBot Satellite - Electron Main Process
 * 
 * Desktop app wrapper for running InfiniBot as a federation satellite.
 * Features:
 * - System tray integration
 * - Auto-start gateway on launch
 * - Configuration UI
 * - Log viewer
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, Notification, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const crypto = require('node:crypto');
const os = require('os');

// Pin the process title so the NSIS installer's `taskkill /F /T /IM
// InfiniBot.exe` (see electron/build/installer.nsh) matches reliably on
// Windows. Without this, Electron renames the main process after fork and
// the uninstaller's polite-close attempt deadlocks on the tray icon.
try { process.title = 'InfiniBot'; } catch {/* ignore */}
const { autoUpdater } = require('electron-updater');
const { ComponentInstaller } = require('./components/installer');
const license = require('./license');
const desktopUpdate = require('./desktop-update');
const externalLinks = require('./external-links');
const { createKvBrowserFlow } = require('./kv-browser-flow');
const kvDeepLink = require('./kv-deep-link');
const satelliteMode = require('./satellite');
const configIo = require('./config-io');

// Every external link (sign-in pages, chat/docs links, downloads) opens in the
// default browser; app pages stay in-app. Covers windows created later too.
const logExternalLink = (line) => { try { console.log(line); } catch {/* closed stdout */} };
externalLinks.installExternalLinkPolicy(app, { shell, log: logExternalLink });
// KinglyVault licence sign-in and checkout run in the default browser too; the
// infinibot:// return comes back through the protocol handler.
const kvBrowserFlow = createKvBrowserFlow({ shell, log: logExternalLink });

// KinglyVault base URL (override during dev via KINGLYVAULT_BASE_URL).
const KV_BASE = license.KV_BASE;

// Use dynamic import for electron-store (ES module)
let Store;
let store;

async function initStore() {
  const { default: ElectronStore } = await import('electron-store');
  Store = ElectronStore;
  store = new Store({
    defaults: {
      config: {
        masterUrl: '',
        name: os.hostname(),
        autoStart: true,
      },
      window: {
        width: 800,
        height: 600,
      }
    }
  });
  return store;
}

let mainWindow;
let tray;
let gatewayProcess;
let localGatewayProcess;
let localGatewayPort = null;
let localGatewayEverHealthy = false;
// The license JWT a running gateway child was last spawned with. Lets
// broadcastLicenseChanged() detect a plan change that happened while a gateway
// is alive and restart it so the new INFINIBOT_LICENSE_JWT takes effect.
// `undefined` = no gateway has been spawned yet this session.
let gatewayLicenseToken;
let isQuitting = false;
let connectionState = 'disconnected';
// Deep link captured before a window exists (mac cold-start open-url / argv).
let pendingProtocolUrl = null;
// Satellite mode (this computer joined another InfiniBot as a federation node).
let satelliteJoinStartedAt = 0;
let satelliteUserStopped = false;
let satelliteStatusWindow = null;
let satelliteStatusTimer = null;
let satelliteBackgroundNoticeShown = false;
let lastSatelliteStatus = null;
// http origins of configured masters that Chromium treats as secure (set
// before app ready, see the bottom of this file).
const satelliteSecureOrigins = new Set();
const launchedHidden = process.argv.includes('--hidden');

// Native window controls are rendered over the web contents on Windows/Linux.
// Keep this value in one place so the BrowserWindow option and the renderer's
// desktop-shell fallback cannot drift apart. The renderer normally uses the
// live Window Controls Overlay geometry, which also accounts for webContents
// zoom and OS display scaling.
const DESKTOP_TITLEBAR_OVERLAY_HEIGHT = 38;

function getDesktopShellState() {
  return {
    platform: process.platform,
    overlayHeight: DESKTOP_TITLEBAR_OVERLAY_HEIGHT,
    fullscreen: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()),
    maximized: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()),
  };
}

function sendDesktopShellState() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  try { mainWindow.webContents.send('desktop-shell:state', getDesktopShellState()); } catch {/* window gone */}
}

// Launched with an explicit state dir / config path (tests, power users): the
// first-launch screen then shows it but doesn't offer to change it.
const STATE_DIR_FROM_ENV = Boolean(process.env.INFINIBOT_STATE_DIR || process.env.INFINIBOT_CONFIG_PATH);

// Same resolution as the gateway (src/config/paths.ts), Windows included.
function resolveStateDir() {
  return configIo.resolveStateDir();
}

// Phase F: append one license-telemetry record (one JSON line) to the shared
// JSONL sink, rotating to <file>.1 once the live file crosses 5 MB. Best-effort
// and never throws (telemetry must not break an upgrade flow).
const LICENSE_TELEMETRY_ROTATE_BYTES = 5 * 1024 * 1024;
function appendLicenseTelemetry(record) {
  const file = path.join(resolveStateDir(), 'license-telemetry.jsonl');
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch {/* exists */}
  try {
    const st = fs.statSync(file);
    if (st.size >= LICENSE_TELEMETRY_ROTATE_BYTES) {
      const rotated = `${file}.1`;
      try { fs.rmSync(rotated, { force: true }); } catch {/* ignore */}
      fs.renameSync(file, rotated);
    }
  } catch {/* file absent — nothing to rotate */}
  try {
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf-8');
  } catch {/* disk full / permission — drop silently */}
}
function resolveConfigPath() {
  return configIo.resolveConfigPath();
}
function resolveDefaultWorkspace() {
  // A separate desktop profile (or a sandbox state dir) keeps its workspace
  // next to its state so it never bootstraps into an npm install's ~/infinibot.
  if (process.env.INFINIBOT_STATE_DIR) return path.join(resolveStateDir(), 'workspace');
  return path.join(os.homedir(), 'infinibot');
}
function isFirstRun() {
  try {
    return !fs.existsSync(resolveConfigPath());
  } catch {
    return true;
  }
}

// Reads the gateway config to figure out which boot path the desktop
// app should take on startup. Returns one of:
//   "wizard"     — no config yet, show first-run wizard
//   "satellite"  — federation.mode=satellite, boot local satellite
//                  gateway (a node of the master) and load its own UI
//   "local"      — boot local gateway and load its UI
function resolveStartupMode() {
  if (isFirstRun()) return { mode: 'wizard' };
  try {
    const cfg = JSON.parse(fs.readFileSync(resolveConfigPath(), 'utf-8'));
    const fed = cfg?.federation;
    if (fed?.enabled && fed?.mode === 'satellite' && fed?.masterUrl) {
      return { mode: 'satellite', masterUrl: fed.masterUrl };
    }
    return { mode: 'local' };
  } catch {
    return { mode: 'local' };
  }
}

// Log file path
function getLogPath() {
  return path.join(resolveStateDir(), 'satellite.log');
}

function createWindow() {
  const windowConfig = store?.get('window', { width: 800, height: 600 }) || { width: 800, height: 600 };
  
  mainWindow = new BrowserWindow({
    width: windowConfig.width,
    height: windowConfig.height,
    minWidth: 600,
    minHeight: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: 'InfiniBot',
    // Premium glass-gold chrome: hide the native title bar but keep window
    // controls (close/min/max) as a native overlay tinted to match the noir
    // theme. The page can still drag/double-click the empty top strip thanks
    // to the `-webkit-app-region: drag` styling injected in wizard.html.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : {
      color: '#0a0a0c',      // matches --infinibot-noir-deep
      symbolColor: '#f6c873', // matches --infinibot-gold-soft
      height: DESKTOP_TITLEBAR_OVERLAY_HEIGHT,
    },
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 14 } : undefined,
    backgroundColor: '#0a0a0c',
    show: false,
  });

  // Auto-scale the UI on smaller laptop displays — behaves like browser zoom
  // (Ctrl±), so the UI isn't oversized/cramped on laptops. Re-applied on every
  // load because the zoom factor resets on navigation (splash → control UI →
  // master UI).
  const applyDisplayZoom = () => {
    try {
      const d = screen.getDisplayMatching(mainWindow.getBounds());
      const { width, height } = d.workAreaSize;
      let z = 1.0;
      if (width <= 1440 || height <= 800) z = 0.7;        // smaller laptops
      else if (width <= 1920 || height <= 1080) z = 0.8;  // laptops
      mainWindow.webContents.setZoomFactor(z);
    } catch { /* ignore */ }
  };
  mainWindow.webContents.on('did-finish-load', applyDisplayZoom);
  mainWindow.webContents.on('did-finish-load', sendDesktopShellState);

  // Full-screen removes the native overlay; restored and maximized windows
  // retain it. Keep the renderer contract synchronized across every state
  // transition so it never leaves a dead strip in full-screen or puts the
  // control bar back under native buttons after restore.
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) {
    mainWindow.on(event, sendDesktopShellState);
  }

  // Startup routing: a new install gets the one-screen first launch (data
  // folder → Get started), which boots the gateway and hands over to the
  // control UI's Setup › Get started onboarding. Configured installs boot the
  // local gateway and either point at its own UI (local mode) or at the
  // master's HTTP UI (satellite mode → 1:1 sync); they never see onboarding
  // from here.
  const startup = resolveStartupMode();
  if (startup.mode === 'wizard') {
    mainWindow.loadFile('wizard.html', { query: { mode: 'firstrun' } });
  } else {
    // Boot a configured install. The control UI loads via the helper below
    // once a healthy gateway is available.
    const port = readGatewayPort();
    const loadControlUi = (gatewayUrl) => {
      // Satellite: the local gateway IS the satellite node and the window is
      // its UI; the status window opens if the master doesn't accept it.
      if (startup.mode === 'satellite') return void loadSatelliteUiAfterBoot(gatewayUrl);
      loadWindowUrl(resolveControlUiTarget(startup, gatewayUrl));
    };

    // Fast path: if the gateway is ALREADY healthy (a relaunch, an OS service,
    // or a still-running instance from a previous window), jump straight to the
    // control UI — no splash, no re-boot, no "Booting your control center"
    // wait. The window stays hidden until the control UI is ready-to-show, so
    // there's no blank flash either.
    isGatewayHealthy(port).then((alreadyUp) => {
      // Never adopt a gateway that serves another profile's state dir.
      if (alreadyUp && portBelongsToOurStateDir(port) !== false) {
        localGatewayPort = port; // adopt the running gateway
        loadControlUi(`http://127.0.0.1:${port}`);
        return;
      }
      // Cold start: show the splash while the gateway boots, then swap in the
      // control UI. did-finish-load is one-shot, so this runs exactly once.
      mainWindow.loadFile('wizard.html', { query: { mode: 'splash' } });
      mainWindow.webContents.once('did-finish-load', async () => {
        const r = await startLocalGateway((line) =>
          safeSend('wizard:gateway-log', line),
        );
        if (!r.ok) {
          // Gateway didn't boot — leave the splash up so the user can
          // diagnose. They can still pick a different mode.
          return;
        }
        loadControlUi(r.url);
      });
    });
  }

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    // Autostart at login (satellite) launches with --hidden: stay in the tray.
    if (launchedHidden) return;
    // Start maximized (full screen) by default.
    try { mainWindow.maximize(); } catch { /* ignore */ }
    mainWindow.show();
  });

  // Save window size on resize
  mainWindow.on('resize', () => {
    const [width, height] = mainWindow.getSize();
    store?.set('window', { width, height });
  });

  // Hide instead of close (stay in tray)
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (isSatelliteConfigured() && !satelliteBackgroundNoticeShown) {
        satelliteBackgroundNoticeShown = true;
        showNotification('InfiniBot keeps running', 'This computer stays connected to your master as a satellite. Quit from the tray icon to disconnect.');
      }
    }
  });
}

function createTray() {
  // The InfiniBot mark (same art as the app icon); 32px so it stays sharp on
  // 150-200% scaled Windows trays and Linux panels.
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  let trayIcon;
  
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) {
      // Create a simple colored square as fallback
      trayIcon = nativeImage.createEmpty();
    }
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  
  updateTrayMenu();
  
  tray.setToolTip('InfiniBot');

  // Show window on tray click
  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.focus();
    } else {
      mainWindow.show();
    }
  });
}

function updateTrayMenu() {
  const statusLabel = connectionState === 'connected' 
    ? '● Connected' 
    : connectionState === 'connecting'
    ? '◐ Connecting...'
    : '○ Disconnected';

  const sat = isSatelliteConfigured();
  const satLabel = sat ? satelliteMode.indicatorText(lastSatelliteStatus, store?.get('satellite.name')) : null;
  if (sat) tray?.setToolTip(satLabel);
  const satelliteItems = sat
    ? [
        { label: satLabel, enabled: false },
        { label: 'Satellite status…', click: () => openSatelliteStatusWindow() },
        { type: 'separator' },
      ]
    : [];
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open', click: () => mainWindow.show() },
    ...satelliteItems,
    ...(sat ? [] : [{ label: statusLabel, enabled: false }]),
    { type: 'separator' },
    { 
      label: 'Start Gateway', 
      click: startGateway,
      enabled: connectionState === 'disconnected'
    },
    { 
      label: 'Stop Gateway', 
      click: stopGateway,
      enabled: connectionState !== 'disconnected'
    },
    { label: 'Restart Gateway', click: restartGateway },
    { type: 'separator' },
    { label: 'View Logs', click: () => shell.openPath(getLogPath()) },
    { label: 'Check for Updates…', click: () => void checkForDesktopUpdatesInteractive() },
    { label: 'About InfiniBot', click: () => void showAboutDialog() },
    { type: 'separator' },
    { 
      label: 'Quit', 
      click: () => { 
        isQuitting = true; 
        app.quit(); 
      } 
    }
  ]);

  tray?.setContextMenu(contextMenu);
}

// Sending to the renderer can throw "Render frame was disposed before
// WebFrameMain could be accessed" when the window is mid-navigation (e.g. the
// splash → control-UI handoff): isDestroyed() still reports false in that gap,
// so only a try/catch is fully robust. Long-lived emitters like the gateway
// log stream keep firing after the splash frame is gone — that's what floods
// the terminal with these errors. Route every send through here.
function safeSend(channel, payload) {
  const wc = mainWindow?.webContents;
  if (!wc || wc.isDestroyed()) return;
  try {
    wc.send(channel, payload);
  } catch {
    /* renderer frame disposed mid-navigation — drop the message */
  }
}

function updateConnectionState(state) {
  connectionState = state;
  safeSend('connection-state', state);
  updateTrayMenu();
}

function sendLog(message, type = 'info') {
  const timestamp = new Date().toISOString().slice(11, 19);
  const logEntry = { timestamp, message, type };
  safeSend('gateway-log', logEntry);
}

function startGateway() {
  const config = store?.get('config', {});
  
  if (!config.masterUrl) {
    sendLog('No master URL configured', 'error');
    safeSend('show-config-needed');
    return;
  }

  if (gatewayProcess) {
    sendLog('Gateway already running', 'warn');
    return;
  }

  updateConnectionState('connecting');
  sendLog(`Connecting to: ${config.masterUrl}`, 'info');

  const { command, args: prefix, electronAsNode } = resolveInfinibotInvocation();
  const args = [...prefix, 'gateway', '--satellite', '--master', config.masterUrl];

  sendLog(`Starting: ${command} ${args.join(' ')}`, 'debug');

  try {
    gatewayProcess = spawn(command, args, {
      cwd: gatewayChildCwd(),
      env: {
        ...gatewayChildEnv(electronAsNode),
        INFINIBOT_MASTER_URL: config.masterUrl,
        INFINIBOT_SATELLITE_NAME: config.name || os.hostname(),
      },
      shell: false,
      windowsHide: true,
    });
    gatewayLicenseToken = (() => { try { return license.getToken?.() || null; } catch { return null; } })();

    gatewayProcess.stdout?.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        sendLog(text, 'stdout');
        
        // Detect connection success
        if (text.includes('connected') || text.includes('Connected')) {
          updateConnectionState('connected');
          showNotification('Connected', `Connected to federation master`);
        }
      }
    });

    gatewayProcess.stderr?.on('data', (data) => {
      const text = data.toString().trim();
      if (text) {
        sendLog(text, 'stderr');
      }
    });

    gatewayProcess.on('error', (err) => {
      sendLog(`Process error: ${err.message}`, 'error');
      updateConnectionState('disconnected');
      gatewayProcess = null;
    });

    gatewayProcess.on('close', (code) => {
      sendLog(`Gateway exited with code ${code}`, code === 0 ? 'info' : 'warn');
      updateConnectionState('disconnected');
      gatewayProcess = null;

      // Auto-restart if not intentional quit
      const autoRestart = store?.get('config.autoRestart', true);
      if (code !== 0 && autoRestart && !isQuitting) {
        sendLog('Auto-restarting in 5 seconds...', 'info');
        setTimeout(startGateway, 5000);
      }
    });

  } catch (err) {
    sendLog(`Failed to start: ${err.message}`, 'error');
    updateConnectionState('disconnected');
  }
}

function stopGateway() {
  if (!gatewayProcess) {
    sendLog('Gateway not running', 'warn');
    return;
  }

  sendLog('Stopping gateway...', 'info');
  
  // Try graceful shutdown first
  gatewayProcess.kill('SIGTERM');
  
  // Force kill after timeout
  setTimeout(() => {
    if (gatewayProcess) {
      gatewayProcess.kill('SIGKILL');
    }
  }, 5000);
}

function restartGateway() {
  sendLog('Restarting gateway...', 'info');
  stopGateway();
  setTimeout(startGateway, 1000);
}

function showNotification(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

// ── Local-mode gateway lifecycle ───────────────────────────────
// Used by the first-run wizard's "Local Gateway" and "Restore" paths.
// Spawns `infinibot daemon start --foreground` (or equivalent) and
// polls for /health before resolving.

// Returns { command, args, electronAsNode } describing how to spawn the
// gateway. Three modes, in priority order:
//
//   1. INFINIBOT_PATH override     → external CLI on PATH (escape hatch)
//   2. Bundled launcher.js         → Electron exe + ELECTRON_RUN_AS_NODE=1
//                                    (the universal-installer path; uses
//                                    Electron's bundled Node, no separate
//                                    runtime to ship)
//   3. `infinibot` on PATH         → development fallback if neither
//                                    launcher nor a built dist/ exists
function resolveInfinibotInvocation() {
  const direct = process.env.INFINIBOT_PATH;
  if (direct) {
    const trimmed = direct.trim();
    if (trimmed.endsWith('.js')) return { command: process.execPath, args: [trimmed], electronAsNode: false };
    return { command: trimmed, args: [], electronAsNode: false };
  }

  const launcher = path.join(__dirname, 'launcher.js');
  const devEntry = path.join(__dirname, '..', 'dist', 'entry.js');
  const packagedEntry = process.resourcesPath
    ? path.join(process.resourcesPath, 'app', 'dist', 'entry.js')
    : null;
  const haveEntry =
    (packagedEntry && fs.existsSync(packagedEntry)) || fs.existsSync(devEntry);

  // DEV mode (running against repo dist): prefer system `node` if we can find
  // it. The shared node_modules/.pnpm/better-sqlite3 native binding is built
  // against system Node's ABI (the gateway:dev command rebuilds it that way),
  // and Electron's bundled Node has a different NODE_MODULE_VERSION, so
  // ELECTRON_RUN_AS_NODE crashes with "compiled against a different Node.js
  // version". When packaged we ship our own asar-unpacked binding that DOES
  // match Electron's ABI, so packaged installs still use the launcher path.
  const isPackaged = Boolean(packagedEntry && fs.existsSync(packagedEntry));
  if (!isPackaged && fs.existsSync(devEntry)) {
    const sysNode = findSystemNode();
    if (sysNode) {
      return { command: sysNode, args: [devEntry], electronAsNode: false };
    }
  }

  if (fs.existsSync(launcher) && haveEntry) {
    return {
      command: process.execPath,
      args: [launcher, '--'],
      electronAsNode: true,
    };
  }

  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(which, ['infinibot'], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout.trim()) {
      return { command: r.stdout.split(/\r?\n/)[0].trim(), args: [], electronAsNode: false };
    }
  } catch {/* ignore */}
  return { command: 'infinibot', args: [], electronAsNode: false };
}

function findSystemNode() {
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(which, ['node'], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout.trim()) {
      const first = r.stdout.split(/\r?\n/)[0].trim();
      if (first && first !== process.execPath) return first;
    }
  } catch {/* ignore */}
  return null;
}

// Working dir for gateway/CLI children: the profile's state dir. Several
// gateway stores write to <cwd>/state/... (terminal sessions, checkpoints,
// KPI/funnel/campaign DBs). The app's own cwd is wherever it was launched
// from ($HOME, or "/" from a menu) and the AppImage/Program Files bundle is
// read-only, so both broke or littered. Read-only lookups (control UI, docs,
// vendor modules) resolve next to the bundled modules first.
function gatewayChildCwd() {
  const dir = resolveStateDir();
  try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch { return undefined; }
}

function gatewayChildEnv(electronAsNode) {
  const env = { ...process.env, FORCE_COLOR: '0' };
  if (electronAsNode) env.ELECTRON_RUN_AS_NODE = '1';
  // The desktop window IS the UI. Never let the gateway (or onboard, or a
  // respawned gateway child that lost --no-open) launch the system browser at
  // http://127.0.0.1:<port>/#password=… — that opened a second, external tab
  // with the gateway password in its URL on first run.
  env.INFINIBOT_NO_OPEN = '1';
  // Hand the current license JWT to the gateway child so its own license cache
  // (src/license/state.ts) reflects the same plan the desktop UI shows. Without
  // this the gateway always reports Free and in-app plan gates are wrong.
  try {
    const tok = license.getToken?.();
    if (tok) env.INFINIBOT_LICENSE_JWT = tok;
  } catch {/* license module not ready — child falls back to free */}
  // Point the mobile/Expo runner at the bundled project (resources/app/mobile
  // when packaged, ../mobile in dev) so it never falls through to a hardcoded
  // legacy path like C:\Users\Admin\infinibot. Env override is the runner's
  // highest-priority source (resolveDefaultProjectDir).
  try {
    if (!env.INFINIBOT_MOBILE_DIR) {
      const packagedMobile = process.resourcesPath
        ? path.join(process.resourcesPath, 'app', 'mobile')
        : null;
      const devMobile = path.join(__dirname, '..', 'mobile');
      const mobileDir = packagedMobile && fs.existsSync(packagedMobile) ? packagedMobile : devMobile;
      if (fs.existsSync(mobileDir)) env.INFINIBOT_MOBILE_DIR = mobileDir;
    }
  } catch {/* best-effort — runner falls back to its own resolution */}
  return env;
}

// Extract a human title from a Notion page object (search result). Notion keeps
// the title under whichever property has type "title"; fall back to a top-level
// title array, then to "(untitled)".
function notionPageTitle(page) {
  try {
    const props = page?.properties || {};
    for (const k of Object.keys(props)) {
      const p = props[k];
      if (p && p.type === 'title' && Array.isArray(p.title)) {
        const text = p.title.map((t) => t.plain_text || '').join('').trim();
        if (text) return text;
      }
    }
    if (Array.isArray(page?.title)) {
      const text = page.title.map((t) => t.plain_text || '').join('').trim();
      if (text) return text;
    }
  } catch {/* fall through */}
  return '(untitled)';
}

// Merge a partial config patch directly into infinibot.json (post-onboard
// scalar writes and the satellite join). Creates the state dir and file when
// missing (fresh install) and writes atomically; the gateway re-validates the
// merged config when it boots. Returns { ok, error? } with a plain-language error.
function applyConfigPatch(patch) {
  return configIo.applyConfigPatch(patch, { file: resolveConfigPath() });
}

function runInfinibotCli(args, { timeoutMs = 120_000, successSentinel = null, idleAfterSuccessMs = 3_000 } = {}) {
  return new Promise((resolve) => {
    const { command, args: prefix, electronAsNode } = resolveInfinibotInvocation();
    const child = spawn(command, [...prefix, ...args], {
      env: gatewayChildEnv(electronAsNode),
      cwd: gatewayChildCwd(),
      shell: false,
      windowsHide: true,
      // Close stdin so a CLI that *thinks* it has a TTY can't block on a prompt
      // despite --non-interactive. Capturing stdout+stderr is still required.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = [];
    let seenSuccess = false;
    let settled = false;
    let idleTimer = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idleTimer);
      resolve(result);
    };
    const onChunk = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (!line) continue;
        lines.push(line);
        if (successSentinel && !seenSuccess && successSentinel.test(line)) {
          seenSuccess = true;
        }
      }
      // After we've seen the success sentinel, treat an idle stretch as
      // completion — the action returned but the process can't drain its
      // event loop (background imports keep it alive). Killing the child
      // and reporting ok=true is the pragmatic answer; we already have the
      // output that matters.
      if (seenSuccess) {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          try { child.kill('SIGTERM'); } catch {/* ignore */}
          settle({ ok: true, code: 0, lines, error: null, terminatedAfterSuccess: true });
        }, idleAfterSuccessMs);
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {/* ignore */}
      settle({ ok: false, code: null, lines, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on('error', (err) => {
      settle({ ok: false, code: null, lines, error: err.message });
    });
    child.on('close', (code) => {
      settle({ ok: code === 0, code, lines, error: code === 0 ? null : `exited ${code}` });
    });
  });
}

// ── Wizard: onboard CLI arg construction ───────────────────────
// The wizard never forks onboarding logic — it only translates UI choices
// into the exact `infinibot onboard --non-interactive` flag surface
// (src/cli/program/register.onboard.ts). Channels are NOT part of the
// non-interactive onboard flow, so they are applied via their own CLI
// (`infinibot channels add`) after onboard succeeds. Voice has no local setup
// at all — it runs on Robovoice and is linked from the Voice page.

// Skips applied to every wizard onboard run: the Electron app boots the
// gateway itself and drives channels separately.
const ONBOARD_COMMON_SKIPS = [
  '--skip-daemon',
  '--skip-channels',
  '--skip-skills',
  '--skip-federation',
  '--skip-health',
  '--skip-ui',
];

// ── Gateway-chat provider → onboard --auth-choice flag translation ─────────
//
// IMPORTANT (one source of truth): this map is NOT a UI provider list. The
// renderer never sees it — it only enumerates providers from the gateway model
// catalog (wizard:list-providers). This table exists solely to translate the
// ONE provider the user picks for in-app chat into the matching
// `infinibot onboard --auth-choice <x> --<x>-api-key <key>` flags, which build
// a *valid* `models.providers.<id>` block (baseUrl + models + apiKey) — the
// same path the interactive onboard uses. Only providers with a non-interactive
// API-key onboard flag are listed; anything absent is treated as keyless
// (OAuth / CLI / local), selected with `--auth-choice skip`, and the user adds
// its key later. Mirrors the flag surface in src/cli/program/register.onboard.ts.
const PROVIDER_ONBOARD = {
  anthropic: { authChoice: 'apiKey', keyFlag: '--anthropic-api-key', probe: 'anthropicApiKey' },
  openai: { authChoice: 'openai-api-key', keyFlag: '--openai-api-key', probe: 'codexApiKey' },
  'openai-codex': { authChoice: 'openai-api-key', keyFlag: '--openai-api-key', probe: 'codexApiKey' },
  google: { authChoice: 'gemini-api-key', keyFlag: '--gemini-api-key', probe: 'geminiApiKey' },
  openrouter: { authChoice: 'openrouter-api-key', keyFlag: '--openrouter-api-key' },
  'vercel-ai-gateway': { authChoice: 'ai-gateway-api-key', keyFlag: '--ai-gateway-api-key' },
  zai: { authChoice: 'zai-api-key', keyFlag: '--zai-api-key' },
  minimax: { authChoice: 'minimax-api', keyFlag: '--minimax-api-key' },
};

// Does this catalog provider take a simple API key we can apply non-interactively?
function providerNeedsKey(providerId) {
  return Boolean(PROVIDER_ONBOARD[providerId]);
}

// ── Gateway ACCESS auth → onboard --gateway-* flag translation ──────────────
// Mirrors src/cli/program/register.onboard.ts. The CLI only enforces
// token|password (src/gateway/auth.ts has no "none" mode), so:
//   password → --gateway-auth password --gateway-password <pwd>
//   token    → --gateway-auth token   --gateway-token <tok>  (generated client-side)
//   none     → omit --gateway-auth; onboard falls back to its default (an
//              auto-generated token) and we keep the bind on loopback so the
//              gateway is reachable only from this machine. The Electron app
//              holds the token, so the user never sees a prompt — matching the
//              "local-only, no prompt" intent without leaving the gateway open.
// Bind: "127.0.0.1" → loopback (default); "0.0.0.0" → lan.
function buildGatewayAccessArgs(gw = {}) {
  const args = [];
  const auth = typeof gw.auth === "string" ? gw.auth.trim() : "password";
  if (auth === "password") {
    const pwd = typeof gw.password === "string" ? gw.password.trim() : "";
    if (!pwd) return { error: "Gateway password auth selected but no password was provided." };
    if (pwd.length < 6) return { error: "Gateway password must be at least 6 characters." };
    args.push("--gateway-auth", "password", "--gateway-password", pwd);
  } else if (auth === "token") {
    const tok = typeof gw.token === "string" ? gw.token.trim() : "";
    if (!tok) return { error: "Gateway token auth selected but no token was provided." };
    args.push("--gateway-auth", "token", "--gateway-token", tok);
  }
  // auth === "none": no --gateway-auth flag (onboard default = auto token).

  // Bind. Default loopback; allow lan when the expert toggle chose 0.0.0.0.
  const bind = typeof gw.bind === "string" ? gw.bind.trim() : "";
  if (bind === "0.0.0.0") args.push("--gateway-bind", "lan");
  else args.push("--gateway-bind", "loopback");

  return { args };
}

// Build onboard auth flags for the chosen GATEWAY-CHAT provider + key.
// Returns { args } (possibly `--auth-choice skip` for keyless providers), or
// { error } when a key-taking provider was chosen without a key.
function buildGatewayProviderArgs(provider, apiKey) {
  const id = typeof provider === 'string' ? provider.trim() : '';
  const map = PROVIDER_ONBOARD[id];
  if (!map) {
    // Keyless / OAuth / local provider (e.g. ollama). Bootstrap onboard without
    // any key; the provider is auto-discovered or configured by its own tool.
    return { args: ['--auth-choice', 'skip'] };
  }
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!key) return { error: `An API key is required for the "${id}" gateway-chat provider.` };
  return { args: ['--auth-choice', map.authChoice, map.keyFlag, key] };
}

// ── First-run data source (no gateway yet) ─────────────────────────────────
// The wizard renders BEFORE any gateway exists, so the renderer can't reach
// gateway RPCs. Instead main.js loads the SAME modules the gateway serves
// (`coder.backends.list` → listAllBackends, `models.list` → model catalog)
// directly from the built `dist/`. This keeps a single source of truth for the
// four CoderBackendIds and the provider catalog — no provider/backend names are
// ever hardcoded in the renderer. Dist lives next to the gateway entry, so we
// reuse the same dev/packaged resolution as resolveInfinibotInvocation().
function resolveDistDir() {
  const devDist = path.join(__dirname, '..', 'dist');
  const packagedDist = process.resourcesPath
    ? path.join(process.resourcesPath, 'app', 'dist')
    : null;
  if (packagedDist && fs.existsSync(packagedDist)) return packagedDist;
  return devDist;
}

async function loadDistModule(relPath) {
  const abs = path.join(resolveDistDir(), relPath);
  // dist is ESM; dynamic import works from this CJS main process. Use a file://
  // URL so Windows absolute paths import cleanly.
  const url = require('url').pathToFileURL(abs).href;
  return import(url);
}

// ── Voice (Robovoice) ─────────────────────────────────────────────────────
// Voice runs on Robovoice (the robovoice plugin); nothing is installed or
// configured locally and the wizard collects no voice keys. The wizard's only
// voice choice is `voice.connectRobovoice`: when true, the first gateway UI
// load after setup lands on the Voice page (the Robovoice console) so the user
// can link it. Set in wizard:setup-local, consumed by wizard:open-gateway-ui.
const VOICE_PAGE_ROUTE = '/voice';
let openVoicePageAfterSetup = false;
// Obsidian vault import chosen in the wizard; started after the gateway boots.
let pendingNotesImport = null;

function sanitizeNotesImport(o) {
  if (!o || typeof o !== 'object') return null;
  const createTasks = o.createTasks === true;
  if (o.source === 'git' && typeof o.url === 'string' && /^https:\/\//i.test(o.url.trim())) {
    return { source: 'git', url: o.url.trim(), createTasks };
  }
  if (o.source === 'folder' && typeof o.path === 'string' && o.path.trim()) {
    return { source: 'folder', path: o.path.trim(), createTasks };
  }
  return null;
}

// Start the queued Obsidian import through the gateway RPC
// (documents.obsidian.import). Best-effort: the job runs in the background
// and shows up in the Notes/Documents page; a failure only logs.
async function startPendingNotesImport(port) {
  const job = pendingNotesImport;
  if (!job || !port) return;
  pendingNotesImport = null;
  const params = JSON.stringify(job);
  const r = await runInfinibotCli(['gateway', 'call', 'documents.obsidian.import', '--params', params, '--port', String(port), '--json'], { timeoutMs: 60_000 });
  sendLog(r.ok ? `notes import started (${job.source})` : `notes import failed to start: ${r.error}`, r.ok ? 'info' : 'warn');
}

function voiceSetupLines(voice = {}) {
  if (voice.connectRobovoice === true) {
    return ['[voice] Voice runs on Robovoice — opening the Voice page to link it after launch'];
  }
  return ['[voice] Voice runs on Robovoice — link it on the Voice page or run `infinibot robovoice login`'];
}

// Point a gateway UI URL at the Voice page, keeping its query (credentials).
function withVoicePageRoute(url) {
  const u = new URL(url);
  u.pathname = VOICE_PAGE_ROUTE;
  return u.toString();
}

// ── Multi-channel configuration (mirrors src/cli/channels-cli.ts flags) ──────
// Each enabled channel: (1) `plugins enable <id>` (bundled-but-disabled by
// default), (2) `channels add --channel <id> --account default <flags>`, and
// (3) any extras that have no `channels add` flag, persisted via the generic
// library-validated `config set`. Field→flag tables are hardcoded here so the
// renderer/main never import gateway code; they mirror the `channels add`
// option surface in channels-cli.ts. Order follows CHAT_CHANNEL_ORDER.
const CHANNEL_SPECS = {
  telegram: {
    required: ['botToken'],
    flags: { botToken: '--token' },
  },
  whatsapp: {
    required: [],
    flags: { authDir: '--auth-dir' },
  },
  discord: {
    required: ['botToken'],
    flags: { botToken: '--token' },
    // guildId has no `channels add` flag — persisted via config set below.
    configSet: { guildId: 'channels.discord.guildId' },
  },
  googlechat: {
    required: ['webhookUrl'],
    flags: { webhookUrl: '--webhook-url', audienceType: '--audience-type', audience: '--audience' },
  },
  slack: {
    required: ['botToken', 'appToken'],
    flags: { botToken: '--bot-token', appToken: '--app-token' },
  },
  signal: {
    required: ['signalNumber'],
    flags: { signalNumber: '--signal-number', cliPath: '--cli-path' },
  },
  imessage: {
    required: [],
    flags: { dbPath: '--db-path', service: '--service', region: '--region' },
  },
};
const CHANNEL_ORDER = ['telegram', 'whatsapp', 'discord', 'googlechat', 'slack', 'signal', 'imessage'];

const CHANNEL_LABELS = {
  telegram: 'Telegram', whatsapp: 'WhatsApp', discord: 'Discord', googlechat: 'Google Chat',
  slack: 'Slack', signal: 'Signal', imessage: 'iMessage',
};

// Configure channels AFTER onboard. `channels` is { <id>: { enabled, ...fields } }.
async function configureWizardChannels(channels = {}) {
  const enabledIds = CHANNEL_ORDER.filter((id) => channels?.[id]?.enabled);
  if (!enabledIds.length) return { ok: true, lines: ['[channels] none — skipped'] };

  const lines = [];
  for (const id of enabledIds) {
    const spec = CHANNEL_SPECS[id];
    if (!spec) {
      return { ok: false, error: `Unknown channel "${id}".`, lines };
    }
    const cfg = channels[id] || {};
    const field = (k) => (typeof cfg[k] === 'string' ? cfg[k].trim() : '');

    // Required-field guard (fail-closed before we touch config).
    const missing = spec.required.filter((k) => !field(k));
    if (missing.length) {
      return {
        ok: false,
        error: `Channel ${CHANNEL_LABELS[id] || id} needs ${missing.join(', ')}.`,
        lines,
      };
    }

    // 1. Enable the (bundled-but-disabled) plugin.
    const enable = await runInfinibotCli(['plugins', 'enable', id], {
      timeoutMs: 30_000,
      successSentinel: /enabled|already enabled|"ok":\s*true/i,
      idleAfterSuccessMs: 1_500,
    });
    lines.push(...enable.lines);
    if (!enable.ok) return { ok: false, error: `could not enable ${id} plugin: ${enable.error}`, lines };

    // 2. channels add --channel <id> --account default <flags>.
    const addArgs = ['channels', 'add', '--channel', id, '--account', 'default'];
    for (const [key, flag] of Object.entries(spec.flags || {})) {
      const v = field(key);
      if (v) addArgs.push(flag, v);
    }
    const add = await runInfinibotCli(addArgs, {
      timeoutMs: 60_000,
      successSentinel: /added|saved|"ok":\s*true|account/i,
      idleAfterSuccessMs: 2_000,
    });
    lines.push(...add.lines);
    if (!add.ok) return { ok: false, error: `${CHANNEL_LABELS[id] || id}: ${add.error}`, lines };

    // 3a. Telegram default chat id (no add flag) → config set (string-typed).
    if (id === 'telegram') {
      const chatId = field('chatId');
      if (chatId) {
        const set = await runInfinibotCli(
          ['config', 'set', 'channels.telegram.defaultChatId', JSON.stringify(chatId), '--json'],
          { timeoutMs: 30_000, successSentinel: /Updated|"ok":\s*true|"path":/i, idleAfterSuccessMs: 1_500 },
        );
        lines.push(...set.lines);
        if (!set.ok) lines.push(`[channels] warning: could not set telegram defaultChatId: ${set.error}`);
      }
    }

    // 3b. Generic extras that have no `channels add` flag (best-effort, non-fatal).
    for (const [key, cfgPath] of Object.entries(spec.configSet || {})) {
      const v = field(key);
      if (!v) continue;
      const set = await runInfinibotCli(
        ['config', 'set', cfgPath, JSON.stringify(v), '--json'],
        { timeoutMs: 30_000, successSentinel: /Updated|"ok":\s*true|"path":/i, idleAfterSuccessMs: 1_500 },
      );
      lines.push(...set.lines);
      if (!set.ok) lines.push(`[channels] warning: could not set ${cfgPath}: ${set.error}`);
    }
  }
  return { ok: true, lines };
}

function readGatewayPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(resolveConfigPath(), 'utf-8'));
    const p = cfg?.gateway?.port;
    if (typeof p === 'number' && p > 0) return p;
  } catch {/* fall through */}
  return isSandboxStateDir() ? 28789 : 18789;
}

// TCP port probe on both loopback and the wildcard address (a gateway bound
// to LAN listens on 0.0.0.0). Resolves true when nothing is listening.
function isPortFree(port) {
  const net = require('net');
  const tryListen = (host) => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
  return tryListen('127.0.0.1').then((ok) => (ok ? tryListen('0.0.0.0') : false));
}

// First free port at or above `preferred` (scans 200 ports). Used so a fresh
// desktop install never lands on a port another gateway (e.g. an npm install
// on :18789) already owns.
async function pickFreePort(preferred) {
  for (let p = preferred; p < preferred + 200; p++) {
    if (await isPortFree(p)) return p;
  }
  return 0;
}

// Linux only: the state dir a listening gateway process serves, read from
// /proc/<pid>/environ (INFINIBOT_STATE_DIR, else $HOME/.infinibot). Returns
// null when it can't tell (other OS, other user's process, no lsof).
function gatewayOwnersOnPort(port) {
  if (process.platform !== 'linux') return null;
  try {
    const out = spawnSync('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8', timeout: 4000 }).stdout || '';
    const pids = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (pids.length === 0) return null;
    return pids.map((pid) => {
      let env = {};
      try {
        for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'utf-8').split('\0')) {
          const i = kv.indexOf('=');
          if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
        }
      } catch { return { pid, stateDir: null }; }
      const dir = env.INFINIBOT_STATE_DIR || (env.HOME ? path.join(env.HOME, '.infinibot') : null);
      return { pid, stateDir: dir ? path.resolve(dir) : null };
    });
  } catch { return null; }
}

// true = the process on `port` serves OUR state dir; false = it serves a
// different one (never adopt or kill it); null = unknown (non-Linux).
function portBelongsToOurStateDir(port) {
  const owners = gatewayOwnersOnPort(port);
  if (!owners) return null;
  const ours = path.resolve(resolveStateDir());
  return owners.every((o) => o.stateDir === ours);
}

// True when we're booting against a throwaway state dir (the wizard's
// sandbox mode). Detected via INFINIBOT_STATE_DIR sitting inside the OS
// temp dir or /tmp. When sandboxed, we steer the gateway off the canonical
// 18789 so the dev box can run a real gateway alongside the wizard test.
function isSandboxStateDir() {
  const dir = path.resolve(resolveStateDir());
  const tmpRoot = path.resolve(os.tmpdir());
  return dir.startsWith(tmpRoot + path.sep) || dir.startsWith('/tmp' + path.sep);
}

function waitForGatewayHealth(port, timeoutMs = 30_000, isAlive = null) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve(true);
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      // Stop waiting only if the gateway PROCESS has exited (a real crash —
      // caller passes `isAlive`) or the absolute backstop elapsed. We do NOT
      // give up on a short fixed cap: a cold boot can take minutes, and cutting
      // it off mid-boot is exactly what was timing users out. While the process
      // is alive we keep polling so the splash stays patient.
      if (isAlive && !isAlive()) return resolve(false);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 500);
    };
    tick();
  });
}

// One-shot health probe (single request, no retry loop). Used to decide
// whether a configured install can skip the splash and load the control UI
// instantly, and to let startLocalGateway adopt an already-running gateway
// instead of spawning a duplicate that collides on the port.
function isGatewayHealthy(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode < 500));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// Reclaim the gateway port when a NON-healthy process is squatting on it — a
// zombie gateway orphaned by a previous crash or force-quit. Without this, the
// freshly spawned gateway can't bind (EADDRINUSE), never becomes healthy, and
// the splash hangs forever on "Booting your control center". Only ever called
// after isGatewayHealthy() returned false, so we never kill a live gateway.
function reclaimStaleGatewayPort(port, send) {
  const killed = new Set();
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf-8', windowsHide: true }).stdout || '';
      for (const line of out.split(/\r?\n/)) {
        // Match the LISTENING row for our exact port and grab the trailing PID.
        if (!/LISTENING/.test(line)) continue;
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
        if (m && Number(m[1]) === port) killed.add(m[2]);
      }
      for (const pid of killed) {
        spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      }
    } else {
      const out = spawnSync('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN'], { encoding: 'utf-8' }).stdout || '';
      for (const l of out.split(/\r?\n/)) {
        const pid = l.trim();
        if (pid) { killed.add(pid); try { process.kill(Number(pid), 'SIGKILL'); } catch {/* gone */} }
      }
    }
  } catch {/* best-effort — fall through to the spawn attempt */}
  if (killed.size > 0) {
    send?.(`reclaimed port ${port} from stale gateway pid ${[...killed].join(', ')}`);
  }
  return killed.size > 0;
}

async function startLocalGateway(send) {
  if (localGatewayProcess) {
    return { ok: true, url: `http://127.0.0.1:${localGatewayPort}`, lines: ['gateway already running'] };
  }
  let port = readGatewayPort();
  // Adopt an already-healthy gateway on the port (started by an OS service, a
  // prior window, or another launcher) instead of spawning a duplicate that
  // would collide on the port (EADDRINUSE), fail to bind, and churn the splash.
  // Only when it serves OUR state dir: a gateway for a different profile
  // (another install on the same port) is never adopted or killed — we move
  // to a free port for this session instead (config is not rewritten).
  const owned = portBelongsToOurStateDir(port);
  if (owned !== false && await isGatewayHealthy(port)) {
    localGatewayPort = port;
    send?.('gateway already healthy — adopting existing instance');
    return { ok: true, url: `http://127.0.0.1:${port}`, lines: ['adopted existing healthy gateway'] };
  }
  if (owned === false || (owned === null && process.platform === 'linux' && !(await isPortFree(port)))) {
    const free = await pickFreePort(port + 1);
    if (!free) return { ok: false, error: `port ${port} is in use by another program and no free port was found`, lines: [] };
    send?.(`port ${port} belongs to another InfiniBot/program — using free port ${free} for this session`);
    port = free;
  } else {
    // Not healthy and ours (or unknown on Windows/macOS). If a zombie gateway
    // from a previous crash/force-quit squats on the port, kill it so our
    // spawn can bind — otherwise the splash hangs forever.
    reclaimStaleGatewayPort(port, send);
  }
  const { command, args: prefix, electronAsNode } = resolveInfinibotInvocation();
  // Boot the gateway in the foreground. `gateway run` is the foreground
  // entry point (the old `daemon start` only manages the OS service —
  // systemd/launchd/schtasks — and has no --foreground flag). `--no-open`
  // keeps the gateway from spawning an external browser; the Electron
  // window loads the UI itself once /health is green.
  const args = [...prefix, 'gateway', 'run', '--port', String(port), '--no-open'];
  const lines = [`spawn: ${command} ${args.join(' ')}`];
  send?.(lines[lines.length - 1]);

  localGatewayProcess = spawn(command, args, {
    env: gatewayChildEnv(electronAsNode),
    cwd: gatewayChildCwd(),
    shell: false,
    windowsHide: true,
  });
  gatewayLicenseToken = (() => { try { return license.getToken?.() || null; } catch { return null; } })();
  const recordChunk = (kind) => (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (!line) continue;
      lines.push(`[${kind}] ${line}`);
      send?.(`[${kind}] ${line}`);
    }
  };
  localGatewayProcess.stdout?.on('data', recordChunk('out'));
  localGatewayProcess.stderr?.on('data', recordChunk('err'));
  // 'exit', not 'close': 'close' waits until every stdio pipe is shut, and a
  // grandchild the gateway started (e.g. the reports worker) can hold them
  // open after a crash — the app then believed a dead gateway was running and
  // never restarted it.
  localGatewayProcess.on('exit', (code) => {
    lines.push(`gateway exited (${code})`);
    localGatewayProcess = null;
    localGatewayPort = null;
    // A satellite must stay reachable: bring it back after a crash unless the
    // user pressed Disconnect / quit.
    if (!isQuitting && !satelliteUserStopped && isSatelliteConfigured() && localGatewayEverHealthy) {
      setTimeout(() => {
        if (!localGatewayProcess && !isQuitting && !satelliteUserStopped) {
          startLocalGateway((line) => safeSend('wizard:gateway-log', line)).catch(() => {});
        }
      }, 5000);
    }
  });

  // Cold boots can be slow: the gateway lights up many subsystems (channels,
  // discipline, telegram, terminals, plugins, …) before it
  // binds the port, and on Windows/Electron that routinely runs past 45s. The
  // old 45s cap let the splash give up while the gateway was still coming up,
  // leaving the window stuck on "booting command center" even though it became
  // healthy moments later. 180s comfortably covers a cold start.
  // Don't time the user out on a slow cold boot. Keep polling while the gateway
  // PROCESS is alive (a real crash fails fast via the exit check) up to a
  // generous 15-minute backstop, instead of the old 180s hard cap that gave up
  // while the gateway was still coming up.
  const ready = await waitForGatewayHealth(port, 900_000, () => localGatewayProcess !== null);
  if (!ready) {
    const crashed = localGatewayProcess === null;
    return {
      ok: false,
      lines,
      error: crashed
        ? `gateway process exited before becoming healthy on :${port} — see log above`
        : `gateway did not become healthy on :${port} within 15m`,
    };
  }
  localGatewayPort = port;
  localGatewayEverHealthy = true;
  return { ok: true, url: `http://127.0.0.1:${port}`, lines };
}

function loadWindowFile(file) {
  if (!mainWindow) return;
  mainWindow.loadFile(file);
}
function loadWindowUrl(url) {
  if (!mainWindow) return;
  externalLinks.addAppOrigin(url);
  mainWindow.loadURL(url);
}

// Resolve the control-UI URL to load for a configured install. Satellite mode
// points at the master's HTTP UI; local mode points at this gateway's own UI.
// In both cases we append the gateway credential, otherwise the WS handshake
// is rejected (password_missing) and the control UI hangs forever on
// "booting command center".
function resolveControlUiTarget(startup, gatewayUrl) {
  // ALWAYS load THIS machine's local gateway UI over loopback (127.0.0.1) — a
  // browser secure context, which the control UI requires for its WebSocket +
  // crypto APIs. Loading a master's bare-IP http URL directly (e.g.
  // http://192.168.1.120:18789) is NOT a secure context and the UI rejects it
  // with 1008 ("requires HTTPS or localhost"). For a satellite, the local
  // gateway runs in satellite mode and federates/proxies to the master, so the
  // operator still sees + drives the master through this local UI — and it
  // auto-authenticates with our own local credential (no master password to
  // type). `startup` is retained for signature compatibility.
  void startup;
  const base = new URL(gatewayUrl);
  try {
    const cfg = JSON.parse(fs.readFileSync(resolveConfigPath(), 'utf-8'));
    const auth = cfg?.gateway?.auth;
    if (auth?.mode === 'password' && auth.password) base.searchParams.set('password', auth.password);
    else if (auth?.mode === 'token' && auth.token) base.searchParams.set('token', auth.token);
  } catch {/* fall back to the bare URL */}
  return base.toString();
}

// ── Satellite mode ─────────────────────────────────────────────────
// This computer joined another InfiniBot as a federation node. The local
// gateway (startLocalGateway) runs in satellite mode: it registers with the
// master, heartbeats, reconnects, and executes what the master sends
// (terminal, commands, screenshots, files, coder/gateway spawns). The window
// shows the master's UI with a "This device" badge; the status window and
// tray show the connection.

function readLocalConfig() {
  try { return JSON.parse(fs.readFileSync(resolveConfigPath(), 'utf-8')); } catch { return null; }
}

function isSatelliteConfigured() {
  const fed = readLocalConfig()?.federation;
  return Boolean(fed?.enabled && fed?.mode === 'satellite' && fed?.masterUrl);
}

function satelliteStatusPayload(st) {
  const running = Boolean(localGatewayProcess || localGatewayPort);
  const status = st && running ? st : st ? { ...st, state: 'stopped' } : null;
  const name = status?.nodeName || readLocalConfig()?.federation?.nodeName || os.hostname();
  return {
    satellite: isSatelliteConfigured(),
    running,
    userStopped: satelliteUserStopped,
    status,
    text: running ? satelliteMode.indicatorText(status, name) : `This device: ${name} · satellite · disconnected`,
    problem:
      !running
        ? (satelliteUserStopped ? 'Disconnected. Press Connect to rejoin the master.' : 'The satellite service is not running.')
        : status?.state === 'connected' ? null : satelliteMode.explainSatelliteProblem(status),
    masterUrl: readLocalConfig()?.federation?.masterUrl || null,
  };
}

function pushSatelliteStatus() {
  const st = satelliteMode.readSatelliteStatus(resolveStateDir());
  const payload = satelliteStatusPayload(st);
  const prev = lastSatelliteStatus?.state;
  lastSatelliteStatus = payload.status;
  safeSend('satellite:status', payload);
  try { satelliteStatusWindow?.webContents.send('satellite:status', payload); } catch {/* closed */}
  if (prev !== payload.status?.state) updateTrayMenu();
  return payload;
}

function startSatelliteServices() {
  if (!isSatelliteConfigured()) return;
  if (!satelliteStatusTimer) {
    satelliteStatusTimer = setInterval(pushSatelliteStatus, 2000);
    satelliteStatusTimer.unref?.();
  }
  // Survive reboots: start hidden at login while this computer is a satellite.
  if (!process.env.INFINIBOT_DESKTOP_NO_AUTOSTART) {
    try { satelliteMode.setAutostart(app, true); } catch {/* best effort */}
  }
  pushSatelliteStatus();
}

function stopSatelliteServices() {
  if (satelliteStatusTimer) clearInterval(satelliteStatusTimer);
  satelliteStatusTimer = null;
  try { satelliteMode.setAutostart(app, false); } catch {/* best effort */}
}

function stopLocalGatewayChild() {
  return new Promise((resolve) => {
    const proc = localGatewayProcess;
    if (!proc || proc.exitCode !== null) { localGatewayProcess = null; localGatewayPort = null; resolve(); return; }
    proc.once('exit', () => resolve());
    try { proc.kill('SIGTERM'); } catch { resolve(); }
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {/* gone */} resolve(); }, 6000);
  });
}

// The master's http(s) UI origin + this satellite's synced credential (the
// master pushes its gateway password to satellites at registration).
function satelliteMasterUiUrl() {
  const cfg = readLocalConfig();
  const masterUrl = lastSatelliteStatus?.masterUrl || cfg?.federation?.masterUrl;
  if (!masterUrl) return null;
  const origin = satelliteMode.httpOriginOf(masterUrl);
  const u = new URL(origin + '/');
  const auth = cfg?.gateway?.auth;
  if (auth?.mode === 'password' && auth.password) u.searchParams.set('password', auth.password);
  else if (auth?.mode === 'token' && auth.token) u.searchParams.set('token', auth.token);
  return { url: u.toString(), origin };
}

// Chromium only lets the control UI connect from a secure context: https,
// loopback, or an http origin we registered as secure before app start.
function originUsableInWindow(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol === 'https:') return true;
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return true;
    // Tailscale MagicDNS: the gateway accepts shared-secret auth from *.ts.net
    // without a secure context (hostIsTailscaleServe), so it loads as-is.
    if (/\.ts\.net$/i.test(u.hostname)) return true;
    return satelliteSecureOrigins.has(u.origin);
  } catch { return false; }
}

// "Open master" (Satellite status window): the master's UI in its OWN window.
// The main window never leaves this device's gateway — it is a UI client of
// the satellite node, so the master reaches it as node + tab (ui_control).
let masterUiWindow = null;
function openSatelliteMasterUi() {
  const target = satelliteMasterUiUrl();
  if (!target) return { ok: false, error: 'No master address is configured.' };
  if (!originUsableInWindow(target.origin)) {
    // A plain-http LAN master joined in THIS session: Chromium only treats it
    // as secure from the next start (switch registered before app ready).
    return { ok: false, error: "The master's screen can be opened here after the app restarts." };
  }
  if (masterUiWindow && !masterUiWindow.isDestroyed()) {
    masterUiWindow.show();
    masterUiWindow.focus();
    return { ok: true, url: target.origin };
  }
  masterUiWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'InfiniBot — master',
    backgroundColor: '#0a0a0c',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  masterUiWindow.setMenuBarVisibility?.(false);
  externalLinks.addAppOrigin(target.url);
  masterUiWindow.loadURL(target.url);
  masterUiWindow.on('closed', () => { masterUiWindow = null; });
  return { ok: true, url: target.origin };
}

async function loadSatelliteUiAfterBoot(gatewayUrl) {
  startSatelliteServices();
  // The window is this device's own UI (a client of the satellite node), never
  // the master's page — the master reaches it as node + tab via ui_control.
  loadWindowUrl(resolveControlUiTarget({ mode: 'local' }, gatewayUrl));
  const r = await satelliteMode.waitForSatelliteConnected(resolveStateDir(), {
    timeoutMs: 30_000,
    onStatus: (st) => safeSend('satellite:status', satelliteStatusPayload(st)),
  });
  pushSatelliteStatus();
  // Not connected (master off, network down, invite revoked …): the status
  // window gives the plain reason. The satellite keeps retrying meanwhile.
  if (!r.ok) openSatelliteStatusWindow();
}

function openSatelliteStatusWindow() {
  if (satelliteStatusWindow && !satelliteStatusWindow.isDestroyed()) {
    satelliteStatusWindow.show();
    satelliteStatusWindow.focus();
    return;
  }
  satelliteStatusWindow = new BrowserWindow({
    width: 560,
    height: 720,
    title: 'Satellite status',
    backgroundColor: '#0a0a0c',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  satelliteStatusWindow.setMenuBarVisibility?.(false);
  satelliteStatusWindow.loadFile('satellite-status.html');
  satelliteStatusWindow.webContents.once('did-finish-load', () => pushSatelliteStatus());
  satelliteStatusWindow.on('closed', () => { satelliteStatusWindow = null; });
}

async function leaveFederation() {
  const cfg = readLocalConfig();
  const r = await dialog.showMessageBox(satelliteStatusWindow || mainWindow, {
    type: 'warning',
    title: 'Leave federation',
    message: 'Disconnect this computer from the master and forget the pairing?',
    detail:
      'The master stops seeing this device, and its terminal, screen and files are no longer reachable from it. ' +
      'Your current settings are kept as a backup next to the config file. To join again you need a new invite.',
    buttons: ['Leave', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (r.response !== 0) return { ok: false, cancelled: true };
  let masterNotified = false;
  if (localGatewayProcess || localGatewayPort) {
    const call = await runInfinibotCli(['gateway', 'call', 'federation.satellite.leave', '--json'], { timeoutMs: 30_000 });
    masterNotified = call.ok && call.lines.some((l) => /"masterNotified":\s*true/.test(l));
  }
  satelliteUserStopped = true;
  await stopLocalGatewayChild();
  stopSatelliteServices();
  // Back to a fresh first run: this config holds credentials synced from the
  // master, so it is set aside rather than reused as a standalone install.
  const file = resolveConfigPath();
  try { if (cfg && fs.existsSync(file)) fs.renameSync(file, `${file}.left-${Date.now()}.bak`); } catch {/* keep going */}
  for (const f of ['satellite-credential.json', 'satellite-status.json']) {
    try { fs.rmSync(path.join(resolveStateDir(), 'federation', f), { force: true }); } catch {/* gone */}
  }
  try { store?.delete?.('satellite'); } catch {/* ignore */}
  satelliteUserStopped = false;
  lastSatelliteStatus = null;
  updateTrayMenu();
  try { satelliteStatusWindow?.close(); } catch {/* closed */}
  mainWindow?.loadFile('wizard.html', { query: { mode: 'firstrun' } });
  mainWindow?.show();
  return { ok: true, masterNotified };
}

// ── License / KinglyVault protocol wiring ────────────────────────
// Push the current license snapshot to every renderer so the wizard plan
// badge + summary update wherever the user is.
function broadcastLicenseChanged() {
  const snap = license.getState();
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('license:changed', snap); } catch {/* window gone */}
  }
  // If the plan changed while a gateway is already running (e.g. the user just
  // upgraded and clicked "I've upgraded — Refresh"), the gateway child still
  // holds the OLD INFINIBOT_LICENSE_JWT. Restart it so its license cache picks
  // up the new plan. `gatewayLicenseToken === undefined` means no gateway has
  // spawned yet this session — nothing to restart.
  try {
    const tok = license.getToken?.() || null;
    if (gatewayLicenseToken !== undefined && tok !== gatewayLicenseToken) {
      if (gatewayProcess) {
        sendLog('license changed — restarting gateway to apply new plan', 'info');
        restartGateway();
      } else if (localGatewayProcess) {
        sendLog('license changed — restarting local gateway to apply new plan', 'info');
        try { localGatewayProcess.kill(); } catch {/* already gone */}
        localGatewayProcess = null;
        localGatewayPort = null;
        setTimeout(() => { startLocalGateway().catch(() => {}); }, 800);
      }
      gatewayLicenseToken = tok;
    }
  } catch {/* best-effort live refresh — UI badge already updated above */}
  return snap;
}

// Decode a base64url-encoded JSON `intent` param ({ feature, label }) carried
// on the checkout return URL. Returns null on any malformed input.
function decodeIntentParam(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    let b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const json = Buffer.from(b64 + pad, 'base64').toString('utf-8');
    const obj = JSON.parse(json);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

// Parse + dispatch an incoming infinibot:// deep link. Handles:
//   infinibot://callback?token=<jwt>   → saveLicense + refresh UI
//   infinibot://license-refreshed      → refreshLicense() immediately
//   infinibot://walkthrough/<id>       → emit a renderer event (no-op if unwired)
function handleProtocolUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'infinibot:') return false;
  // Wake a licence sign-in / checkout waiting in the browser. It resumes after
  // this handler has saved the token or started the refresh below.
  kvBrowserFlow.deliver(rawUrl);
  // For infinibot://callback the "host" is `callback`; for nested paths like
  // walkthrough/<id> the host is `walkthrough` and the id is the first path seg.
  const host = u.hostname || u.pathname.replace(/^\/+/, '').split('/')[0] || '';
  if (host === 'callback') {
    const token = u.searchParams.get('token');
    if (token) {
      license.saveLicense(token);
      sendLog('license: received sign-in callback', 'info');
      broadcastLicenseChanged();
    }
    return true;
  }
  if (host === 'license-refreshed') {
    // Phase F: a queued action may be waiting on this upgrade. Decode the
    // `intent` param now, refresh the license, then forward the intent to the
    // renderer so it can drain the matching replay queue entry.
    const intent = decodeIntentParam(u.searchParams.get('intent'));
    license.refreshLicense().then(() => {
      sendLog('license: refreshed after checkout return', 'info');
      broadcastLicenseChanged();
      if (intent) {
        for (const w of BrowserWindow.getAllWindows()) {
          try { w.webContents.send('license:replay-intent', intent); } catch {/* window gone */}
        }
      }
    }).catch(() => {/* grace handled inside refreshLicense */});
    return true;
  }
  if (host === 'kv-connect') {
    // KinglyVault "Connect this computer" (one account, zero pairing).
    const kv = kvDeepLink.parseKvConnectUrl(rawUrl);
    if (!kv) return false;
    sendLog('kv-connect: KinglyVault asked this computer to sign in', 'info');
    void kvDeepLink
      .beginKvConnect({
        ...kv,
        port: readGatewayPort(),
        openExternal: (url) => externalLinks.openExternalSafe(shell, url, logExternalLink),
        log: (m) => sendLog(m, 'info'),
      })
      .then((r) => { if (!r.ok) sendLog(`kv-connect: could not start (${r.reason})`, 'warn'); })
      .catch(() => {});
    return true;
  }
  if (host === 'walkthrough') {
    const id = (u.hostname ? u.pathname.replace(/^\/+/, '') : u.pathname.replace(/^\/+/, '').split('/').slice(1).join('/')) || '';
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send('walkthrough:open', { id }); } catch {/* ignore */}
    }
    return true;
  }
  return false;
}

// Scan a process argv array for an infinibot:// URL. On Windows/Linux the OS
// hands the deep link to a new process instance as a plain argv entry; we also
// honor an explicit --url=infinibot://… for headless/test invocation.
function findProtocolUrlInArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (const a of argv) {
    if (typeof a !== 'string') continue;
    if (a.startsWith('infinibot://')) return a;
    if (a.startsWith('--url=')) {
      const v = a.slice('--url='.length);
      if (v.startsWith('infinibot://')) return v;
    }
  }
  return null;
}

// Optional-component installer (download-on-demand packs).
// userData on Windows is %APPDATA%\InfiniBot, matching the NSIS components.json path.
let componentInstaller;
function getComponentInstaller() {
  if (!componentInstaller) {
    componentInstaller = new ComponentInstaller({ baseDir: app.getPath('userData') });
  }
  return componentInstaller;
}

// IPC Handlers
// `infinibot onboard --non-interactive` + post-onboard writes; set up in
// setupIpcHandlers and shared by the first-launch screen and wizard:setup-local.
let setupLocalInstall = null;

function setupIpcHandlers() {
  ipcMain.handle('get-config', () => store?.get('config', {}));
  ipcMain.handle('desktop-shell:get-state', () => getDesktopShellState());
  ipcMain.handle('platform:info', () => ({
    os: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
  }));

  // --- Optional components (Settings -> Components) ---
  ipcMain.handle('components:list', () => getComponentInstaller().list());
  ipcMain.handle('components:status', (_, name) => getComponentInstaller().status(name));
  ipcMain.handle('components:install', async (_, name) => {
    const inst = getComponentInstaller();
    return inst.install(name, (p) => {
      try { mainWindow?.webContents?.send('components:progress', p); } catch { /* window gone */ }
    });
  });
  ipcMain.handle('components:remove', (_, name) => getComponentInstaller().remove(name));
  
  ipcMain.handle('save-config', async (_, config) => {
    store?.set('config', config);
    sendLog('Configuration saved', 'info');
    
    // Restart if running
    if (gatewayProcess) {
      restartGateway();
    }
    
    return { success: true };
  });

  ipcMain.handle('get-status', () => ({
    state: connectionState,
    pid: gatewayProcess?.pid ?? null,
    masterUrl: store?.get('config.masterUrl', '') ?? '',
  }));

  ipcMain.handle('start-gateway', () => {
    startGateway();
    return { success: true };
  });

  ipcMain.handle('stop-gateway', () => {
    stopGateway();
    return { success: true };
  });

  ipcMain.handle('restart-gateway', () => {
    restartGateway();
    return { success: true };
  });

  // Renderer → default browser (sign-in links, "Open in browser" buttons).
  // http(s)/mailto only; anything else is refused.
  ipcMain.handle('shell:open-external', async (_, url) => ({
    ok: await externalLinks.openExternalSafe(shell, url, logExternalLink),
  }));

  ipcMain.handle('open-logs', () => {
    shell.openPath(getLogPath());
    return { success: true };
  });

  // ── Live Action Mode: multi-display awareness ──────────────────
  // Lists every connected display in a UI-friendly shape and lets the
  // renderer move/pin the main window onto a chosen display. Default
  // identification by `screen.getAllDisplays()` order (display 1 first).
  //
  // The renderer treats these as opaque numeric ids — the actual values
  // are Electron's internal display ids, which are stable across calls
  // within a session.
  // Native folder picker. Used by the Design page's "Load existing folder"
  // flow (and any future feature that needs a server-side path). Returns
  // `{ canceled, path }`; the renderer passes `path` to the gateway RPC.
  ipcMain.handle('dialog:pickFolder', async (_, options) => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: options?.title ?? 'Pick a folder',
        defaultPath: options?.defaultPath ?? undefined,
      });
      return {
        canceled: result.canceled,
        path: result.canceled ? null : result.filePaths[0],
      };
    } catch (err) {
      return { canceled: true, path: null, error: String(err?.message ?? err) };
    }
  });

  ipcMain.handle('displays:list', () => {
    try {
      const primary = screen.getPrimaryDisplay();
      const all = screen.getAllDisplays();
      return all.map((d, idx) => ({
        id: d.id,
        // 1-indexed label so "Display 2" in the UI matches the user's
        // mental model of "my second monitor."
        label: `Display ${idx + 1}`,
        ordinal: idx + 1,
        isPrimary: d.id === primary.id,
        bounds: d.bounds,                  // { x, y, width, height }
        workArea: d.workArea,              // bounds minus taskbars
        scaleFactor: d.scaleFactor,
        rotation: d.rotation,
      }));
    } catch (err) {
      sendLog(`displays:list failed: ${err?.message ?? err}`, 'error');
      return [];
    }
  });

  // Move the main window so it lives entirely inside the target display's
  // workArea. We size to ~80% of workArea by default (keeping the current
  // window size if it already fits) and re-center on the target.
  ipcMain.handle('window:move-to-display', (_, displayId) => {
    try {
      if (!mainWindow) return { success: false, error: 'no-window' };
      const target = screen.getAllDisplays().find((d) => d.id === displayId);
      if (!target) return { success: false, error: 'display-not-found' };
      const { x, y, width: dw, height: dh } = target.workArea;
      const [cw, ch] = mainWindow.getSize();
      const w = Math.min(cw || Math.floor(dw * 0.8), dw);
      const h = Math.min(ch || Math.floor(dh * 0.8), dh);
      const nx = Math.floor(x + (dw - w) / 2);
      const ny = Math.floor(y + (dh - h) / 2);
      mainWindow.setBounds({ x: nx, y: ny, width: w, height: h });
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return { success: true, bounds: { x: nx, y: ny, width: w, height: h } };
    } catch (err) {
      sendLog(`window:move-to-display failed: ${err?.message ?? err}`, 'error');
      return { success: false, error: err?.message ?? String(err) };
    }
  });

  // Always-on-top: holds the InfiniBot window above other apps while
  // Live Action mode is engaged, so the user can keep watching the
  // sidebar voice panel while interacting with anything else.
  ipcMain.handle('window:set-always-on-top', (_, value) => {
    try {
      if (!mainWindow) return { success: false, error: 'no-window' };
      mainWindow.setAlwaysOnTop(!!value, 'normal');
      return { success: true };
    } catch (err) {
      sendLog(`window:set-always-on-top failed: ${err?.message ?? err}`, 'error');
      return { success: false, error: err?.message ?? String(err) };
    }
  });

  // Which display is the current window on? Useful so the renderer can
  // initialize the picker to "the user's actual current screen" instead
  // of guessing.
  // ── First-run wizard handlers ───────────────────────────────
  ipcMain.handle('wizard:get-defaults', () => ({
    workspace: resolveDefaultWorkspace(),
    hostname: os.hostname(),
    configPath: resolveConfigPath(),
    stateDir: resolveStateDir(),
    configured: !isFirstRun(),
    appVersion: app.getVersion(),
    // Show the developer "Reset for re-test" button only for unpacked dev
    // builds or when explicitly enabled. The reset handler enforces its own
    // (stricter) safety guard before deleting anything.
    canReset: !app.isPackaged || process.env.INFINIBOT_ALLOW_RESET === '1',
  }));

  ipcMain.handle('wizard:pick-backup', async () => {
    const r = await dialog.showOpenDialog({
      title: 'Select an InfiniBot backup (.zip)',
      properties: ['openFile'],
      filters: [{ name: 'InfiniBot Backup', extensions: ['zip'] }],
    });
    return { canceled: r.canceled, path: r.canceled ? null : r.filePaths[0] };
  });

  ipcMain.handle('wizard:inspect-backup', async (_, zipPath) => {
    if (!zipPath) return { ok: false, error: 'missing path' };
    const r = await runInfinibotCli(['restore', zipPath, '--inspect', '--json'], { timeoutMs: 20_000 });
    if (!r.ok) return { ok: false, error: r.error, lines: r.lines };
    // The CLI emits JSON across multiple log lines mixed with progress.
    // The first '{' through last '}' is our payload.
    const blob = r.lines.join('\n');
    const start = blob.indexOf('{');
    const end = blob.lastIndexOf('}');
    if (start < 0 || end < 0) return { ok: false, error: 'no manifest in output', lines: r.lines };
    try {
      const manifest = JSON.parse(blob.slice(start, end + 1));
      return { ok: true, manifest };
    } catch (err) {
      return { ok: false, error: `parse failed: ${err.message}`, lines: r.lines };
    }
  });

  ipcMain.handle('wizard:restore-backup', async (_, zipPath) => {
    if (!zipPath) return { ok: false, error: 'missing path' };
    const r = await runInfinibotCli(['restore', zipPath, '--force'], { timeoutMs: 5 * 60_000 });
    return { ok: r.ok, error: r.error, lines: r.lines };
  });

  // First launch: pick the data folder (state dir) before anything is
  // written. Only while nothing is configured yet and no gateway runs, and
  // never when INFINIBOT_STATE_DIR / INFINIBOT_CONFIG_PATH came from the
  // environment. A folder that already holds an install opens as it is.
  ipcMain.handle('wizard:pick-state-dir', async () => {
    if (STATE_DIR_FROM_ENV) {
      return { canceled: true, error: 'The data folder is set by INFINIBOT_STATE_DIR for this launch.' };
    }
    if (!isFirstRun() || localGatewayPort) {
      return { canceled: true, error: 'InfiniBot is already set up in this folder.' };
    }
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose where InfiniBot keeps its data',
      defaultPath: resolveStateDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths?.[0]) return { canceled: true };
    const dir = path.resolve(r.filePaths[0]);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {
      return { canceled: true, error: `Could not use ${dir}: ${err?.message ?? err}` };
    }
    if (dir === path.join(os.homedir(), '.infinibot')) {
      delete process.env.INFINIBOT_STATE_DIR;
      store?.set('stateProfile', 'shared');
      store?.delete?.('stateDir');
    } else {
      process.env.INFINIBOT_STATE_DIR = dir;
      store?.set('stateProfile', 'custom');
      store?.set('stateDir', dir);
    }
    try { license.init(); } catch {/* best-effort: license.enc moves with the folder */}
    return { canceled: false, stateDir: resolveStateDir(), configured: !isFirstRun() };
  });

  // First launch "Get started": default config, no keys, token auth on
  // loopback. Models, channels, voice and plugins are set in the control UI's
  // onboarding. An already-configured folder is left untouched.
  ipcMain.handle('wizard:first-run-setup', async () => {
    if (!isFirstRun()) return { ok: true, alreadyConfigured: true, lines: [] };
    return setupLocalInstall({ gateway: { auth: 'none' }, chat: {} });
  });

  ipcMain.handle('wizard:setup-local', (_, opts = {}) => setupLocalInstall(opts));
  setupLocalInstall = async (opts = {}) => {
    // Refuse to clobber an existing install unless the wizard explicitly
    // passes { force: true }. The wizard window can be opened on a
    // configured machine (splash mode while the gateway boots), and the
    // setup tile must not stamp a fresh workspace/auth over the live
    // ~/.infinibot/infinibot.json.
    if (!opts.force && !isFirstRun()) {
      return {
        ok: false,
        alreadyConfigured: true,
        configPath: resolveConfigPath(),
        error: 'InfiniBot is already configured on this machine. Pass force:true to re-run setup.',
        lines: [],
      };
    }
    // The wizard no longer collects coder-agent credentials — CLI coder agents
    // (claude-code / opencode / codex / gemini / grok) own their own auth, done in the
    // user's terminal. The only secret here is the GATEWAY-CHAT provider key
    // (Step 4), which actually hits a provider API for in-app chat sessions.
    // opts.chat = in-app chat provider/model/key (Step 5).
    // opts.gateway = gateway ACCESS auth (Step 2): { auth, password?, token?, bind? }.
    const chat = opts.chat || {};
    const coderBackend = typeof opts.coderBackend === 'string' ? opts.coderBackend.trim() : '';

    const lines = [];

    // 1. Workspace + chat provider key + gateway access auth via a single
    //    `infinibot onboard --non-interactive` (the library owns workspace
    //    bootstrap + a valid models.providers.<id> block + gateway.auth).
    //    Keyless providers (ollama/local/OAuth) bootstrap with `--auth-choice skip`.
    const built = buildGatewayProviderArgs(chat.provider, chat.apiKey);
    if (built.error) return { ok: false, error: built.error, lines };
    const gwAccess = buildGatewayAccessArgs(opts.gateway || {});
    if (gwAccess.error) return { ok: false, error: gwAccess.error, lines };
    const onboardArgs = [
      'onboard',
      '--non-interactive',
      '--accept-risk',
      ...built.args,
      ...gwAccess.args,
    ];
    if (opts.workspace) onboardArgs.push('--workspace', opts.workspace);
    // Sandbox guard: when state dir is under a temp path, pin the gateway off
    // the canonical 18789 so a real gateway can run alongside the wizard test.
    // Port: 18789 (28789 for a sandbox state dir) unless something already
    // listens there — then the next free port, so a fresh desktop install
    // never collides with (or adopts) another gateway such as an npm install.
    {
      const preferred = isSandboxStateDir() ? 28789 : 18789;
      const port = await pickFreePort(preferred);
      if (!port) return { ok: false, error: `no free port near ${preferred}`, lines };
      if (port !== preferred || isSandboxStateDir()) onboardArgs.push('--gateway-port', String(port));
      if (port !== preferred) lines.push(`port ${preferred} is in use — this install uses ${port}`);
    }
    onboardArgs.push(...ONBOARD_COMMON_SKIPS);
    // onboard prints "Tip: …" right after the workspace + config write
    // succeed, then hands control back. The Node process often can't drain
    // its event loop afterwards (background module handles), so wait for
    // that sentinel and treat a brief idle period as "done".
    const onboardRun = await runInfinibotCli(onboardArgs, {
      timeoutMs: 180_000,
      successSentinel: /^Tip:|Workspace OK:/,
      idleAfterSuccessMs: 4_000,
    });
    lines.push(...onboardRun.lines);
    if (!onboardRun.ok) return { ok: false, error: onboardRun.error, lines };

    // 2. Default CLI coder backend (Step 3) → `coder.backend` in infinibot.json.
    //    onboard has no --coder-backend flag (see register.onboard.ts), so the
    //    closest existing path is the generic, library-validated `config set`.
    if (coderBackend) {
      const cr = applyConfigPatch({ coder: { backend: coderBackend } });
      lines.push(cr.ok ? `set coder.backend = ${coderBackend}` : `coder.backend write failed: ${cr.error}`);
      if (!cr.ok) return { ok: false, error: `could not set coder.backend: ${cr.error}`, lines };
    }

    // 3. Default GATEWAY-CHAT model (Step 4) → `agents.defaults.model.primary`.
    //    NOTE: the brief named this `models.defaultModel = "<provider>:<model>"`,
    //    but that key does not exist in this codebase. The real default-chat-model
    //    source of truth is `agents.defaults.model.primary` (read by
    //    resolveConfiguredModelRef → resolveDefaultModelForAgent), and it expects
    //    a `<provider>/<model>` ref (slash, not colon). We write that instead.
    if (chat.provider && chat.model) {
      const ref = `${String(chat.provider).trim()}/${String(chat.model).trim()}`;
      const mr = applyConfigPatch({ agents: { defaults: { model: { primary: ref } } } });
      lines.push(mr.ok ? `set default model = ${ref}` : `default model write failed: ${mr.error}`);
      if (!mr.ok) return { ok: false, error: `could not set default model: ${mr.error}`, lines };
    }

    // 4. Notion sync (Step 8, optional). Mirrors the quickstart Notion step:
    //    persist the verified token + chosen sync mode (+ integration name /
    //    parent page) into the `notion` block. Local SQLite stays the source of
    //    truth; the Projects/Tasks databases are created later (first gateway
    //    boot / the in-app Notion view). Non-fatal — a write hiccup here must
    //    never block the gateway from booting.
    if (opts.notion && typeof opts.notion.token === 'string' && opts.notion.token.trim()) {
      const n = opts.notion;
      const mode = ['off', 'mirror', 'import-once'].includes(n.syncMode) ? n.syncMode : 'mirror';
      const notionPatch = { apiKey: n.token.trim(), syncMode: mode };
      if (n.integrationName) notionPatch.integrationName = String(n.integrationName);
      if (n.parentPageId) notionPatch.parentPageId = String(n.parentPageId);
      const nr = applyConfigPatch({ notion: notionPatch });
      lines.push(nr.ok ? `set notion sync = ${mode}` : `notion setup warning: ${nr.error}`);
    }

    // 4. Voice (Step 6, optional). Voice runs on Robovoice — nothing to
    //    install or write here. Only remember whether to open the Voice page
    //    (the Robovoice console) once the gateway UI loads.
    openVoicePageAfterSetup = opts.voice?.connectRobovoice === true;
    // Import your notes (optional). The import is a gateway job, so it is
    // queued here and started once the local gateway is healthy.
    pendingNotesImport = sanitizeNotesImport(opts.importNotes);
    if (pendingNotesImport) lines.push(`notes import queued: Obsidian ${pendingNotesImport.source} ${pendingNotesImport.path || pendingNotesImport.url}`);
    lines.push(...voiceSetupLines(opts.voice || {}));

    // 5. Channels (Telegram). Fatal if the user asked for it and it failed,
    //    since a half-configured channel is worse than none.
    if (opts.channels) {
      const cr = await configureWizardChannels(opts.channels);
      lines.push(...cr.lines);
      if (!cr.ok) return { ok: false, error: cr.error, lines };
    }

    return { ok: true, lines };
  };

  // CLI coder backends (the four CoderBackendIds) with install state + login
  // command. Loaded straight from the gateway's single-source-of-truth
  // listAllBackends() in dist/ so the renderer never hardcodes backend names.
  ipcMain.handle('wizard:coder-backends', async () => {
    try {
      const mod = await loadDistModule(path.join('gateway', 'server-coder-backend.js'));
      const backends = await mod.listAllBackends();
      return { ok: true, backends };
    } catch (err) {
      return { ok: false, error: `could not load coder backends: ${err.message}`, backends: [] };
    }
  });

  // Gateway-chat provider/model catalog, grouped Provider → [models].
  //
  // SOURCE OF TRUTH: the FULL provider catalogue (`KNOWN_PROVIDERS`, filtered to
  // category==="model") so BYOK-only providers (ollama-cloud, openrouter,
  // deepseek, mistral, groq, xai, cerebras, …) appear in the Step 4 picker even
  // at first-run when NO keys exist yet. The old behaviour enumerated only the
  // pi-sdk model catalog, which lists providers that already have discovered
  // credentials — so first-run showed almost nothing.
  //
  // PRIMARY: the gateway `providers.catalog.list` RPC (when a gateway is alive).
  // FALLBACK: read the same server-safe module from dist directly — this is the
  // EXACT module the RPC reads, so it stays a single source of truth and works
  // before any gateway exists (the wizard's normal first-run state). We then
  // union in whatever models the live model catalog already knows; providers
  // with no discovered models yet get a "(default)" placeholder so the UI
  // always has something selectable.
  ipcMain.handle('wizard:list-providers', async () => {
    // Build a provider.id → [{id,name}] map from the live model catalog, if any.
    const modelsByProvider = new Map();
    try {
      const catMod = await loadDistModule(path.join('gateway', 'server-model-catalog.js'));
      const catalog = await catMod.loadGatewayModelCatalog();
      for (const m of catalog) {
        if (!modelsByProvider.has(m.provider)) modelsByProvider.set(m.provider, []);
        modelsByProvider.get(m.provider).push({ id: m.id, name: m.name || m.id });
      }
    } catch {/* no catalog yet (no keys / offline) — placeholders only */}

    try {
      // PRIMARY/FALLBACK both resolve the canonical list from the same dist
      // module the gateway RPC serves. (We don't open a WS to the gateway here
      // because at first-run there is no gateway, and the dist module is the
      // identical source of truth — see providers.catalog.list.)
      const provMod = await loadDistModule(path.join('agents', 'known-providers.js'));
      const modelProviders = provMod.listModelProviders();
      const providers = modelProviders.map((p) => {
        const models = modelsByProvider.get(p.id);
        return {
          id: p.id,
          label: p.label, // human label, e.g. "Ollama Cloud (Turbo)"
          icon: p.icon,
          // envKey === "" ⇒ keyless (local/OAuth) provider → no key field.
          needsKey: p.envKey !== '',
          // Optional probe-keys field name so the renderer can format-validate
          // the key inline without knowing provider names itself.
          probeField: PROVIDER_ONBOARD[p.id]?.probe || null,
          models: models && models.length > 0
            ? models
            : [{ id: '(default)', name: 'Will be detected after key is saved' }],
        };
      });
      return { ok: true, providers };
    } catch (err) {
      return { ok: false, error: `could not load providers: ${err.message}`, providers: [] };
    }
  });

  // Live model discovery for the Step 5 provider. Probes the provider's model
  // listing with the entered key (or local endpoint) so BYOK providers like
  // Ollama Cloud show real model names instead of the "(default)" placeholder.
  // Works at first-run with no gateway — provider-models.js does the HTTP itself.
  ipcMain.handle('wizard:fetch-models', async (_, { provider, apiKey, endpoint } = {}) => {
    try {
      const { fetchModelsFor } = require('./provider-models.js');
      const models = await fetchModelsFor(String(provider || ''), {
        apiKey: typeof apiKey === 'string' ? apiKey.trim() : '',
        endpoint: typeof endpoint === 'string' ? endpoint.trim() : '',
      });
      return { ok: true, models: Array.isArray(models) ? models : [], count: models?.length || 0 };
    } catch (err) {
      return { ok: false, models: [], error: err?.message || String(err) };
    }
  });

  // ── Notion onboarding (mirrors the quickstart Notion step) ───────
  // Verify an integration token against Notion's /users/me. Works at first-run
  // (no gateway) by calling the Notion API directly.
  ipcMain.handle('wizard:notion-verify', async (_, { token } = {}) => {
    const key = typeof token === 'string' ? token.trim() : '';
    if (!key) return { ok: false, error: 'Enter a Notion integration token.' };
    try {
      const res = await fetch('https://api.notion.com/v1/users/me', {
        headers: { Authorization: `Bearer ${key}`, 'Notion-Version': '2022-06-28' },
        signal: AbortSignal.timeout(12_000),
      });
      if (res.status === 401) {
        return { ok: false, error: 'Notion rejected this token. Copy the full Internal Integration Secret from notion.so/my-integrations.' };
      }
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        return { ok: false, error: `Notion ${res.status}: ${t || res.statusText}` };
      }
      const body = await res.json();
      return {
        ok: true,
        integrationName: body?.name || 'Integration',
        workspace: body?.bot?.workspace_name || null,
        botId: body?.id || null,
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // List pages the integration can see, for the "parent page" picker. Mirrors
  // notion-wizard.ts listAccessibleDatabases (pages only).
  ipcMain.handle('wizard:notion-pages', async (_, { token } = {}) => {
    const key = typeof token === 'string' ? token.trim() : '';
    if (!key) return { ok: false, error: 'Enter a Notion token first.', pages: [] };
    try {
      const res = await fetch('https://api.notion.com/v1/search', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filter: { value: 'page', property: 'object' }, page_size: 50 }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        return { ok: false, error: `Notion ${res.status}: ${t || res.statusText}`, pages: [] };
      }
      const body = await res.json();
      const pages = (body.results || [])
        .filter((r) => r && r.object === 'page')
        .map((r) => ({ id: r.id, title: notionPageTitle(r) }));
      return { ok: true, pages };
    } catch (err) {
      return { ok: false, error: err?.message || String(err), pages: [] };
    }
  });

  // Pure, no-network format validation of provided keys. Returns a boolean per
  // field so the renderer can show inline ✓ / ✗ without leaking key material.
  ipcMain.handle('wizard:probe-keys', (_, keys = {}) => {
    const trim = (v) => (typeof v === 'string' ? v.trim() : '');
    const checks = {
      // Anthropic API key (not a setup-token): sk-ant-… but not sk-ant-oat….
      anthropicApiKey: (v) => /^sk-ant-/.test(v) && !/^sk-ant-oat/.test(v),
      // Anthropic setup-token: sk-ant-oat….
      anthropicSetupToken: (v) => /^sk-ant-oat/.test(v),
      // OpenAI key (Codex BYOK): sk-… (incl. sk-proj-…) but not an Anthropic key.
      codexApiKey: (v) => /^sk-/.test(v) && !/^sk-ant-/.test(v),
      // Google AI Studio / Gemini key: AIzaSy….
      geminiApiKey: (v) => /^AIzaSy[\w-]{10,}/.test(v),
    };
    const results = {};
    for (const [field, fn] of Object.entries(checks)) {
      if (field in keys) results[field] = fn(trim(keys[field]));
    }
    return { ok: true, results };
  });

  // Developer-only reset for re-testing the wizard. Refuses to delete unless
  // the config path is under a temp dir OR INFINIBOT_ALLOW_RESET=1, so it can
  // never nuke a real ~/.infinibot/infinibot.json.
  ipcMain.handle('wizard:reset-state', () => {
    const configPath = path.resolve(resolveConfigPath());
    const tmpRoot = path.resolve(os.tmpdir());
    const underTmp =
      configPath.startsWith(tmpRoot + path.sep) || configPath.startsWith('/tmp' + path.sep);
    const allowed = process.env.INFINIBOT_ALLOW_RESET === '1' || underTmp;
    if (!allowed) {
      return {
        ok: false,
        error: `reset refused: ${configPath} is not under a temp dir and INFINIBOT_ALLOW_RESET!=1`,
      };
    }
    const removed = [];
    for (const f of [configPath]) {
      try {
        if (fs.existsSync(f)) {
          fs.rmSync(f, { force: true });
          removed.push(f);
        }
      } catch (err) {
        return { ok: false, error: `failed to remove ${f}: ${err.message}`, removed };
      }
    }
    return { ok: true, removed };
  });

  ipcMain.handle('wizard:setup-satellite', async (_, opts = {}) => {
    if (!opts.masterUrl) return { ok: false, error: 'masterUrl required', lines: [] };
    if (!opts.force && !isFirstRun()) {
      return {
        ok: false,
        alreadyConfigured: true,
        configPath: resolveConfigPath(),
        error: 'InfiniBot is already configured on this machine. Pass force:true to switch to satellite mode.',
        lines: [],
      };
    }
    const name = opts.name || os.hostname();
    // Write satellite config into ~/.infinibot/infinibot.json so the
    // gateway picks up `federation.mode === "satellite"` on next start.
    // We also mirror into electron-store for the tray panel.
    const args = [
      'onboard',
      '--non-interactive',
      '--accept-risk',
      '--federation-mode', 'satellite',
      '--federation-master-url', opts.masterUrl,
      '--federation-node-name', name,
      '--skip-daemon',
      '--skip-channels',
      '--skip-skills',
      '--skip-health',
      '--skip-ui',
    ];
    const run = await runInfinibotCli(args, { timeoutMs: 180_000 });
    if (!run.ok) return { ok: false, error: run.error, lines: run.lines };
    try {
      store?.set('config', {
        ...(store?.get('config', {}) || {}),
        masterUrl: opts.masterUrl,
        name,
        autoStart: true,
      });
    } catch {/* tray fallback only */}
    return { ok: true, lines: [...run.lines, `satellite config written for master=${opts.masterUrl}`] };
  });

  // Redeem a federation invite (the reliable satellite-join path). Unlike
  // setup-satellite (master URL only), the invite carries the satellite auth
  // token, so pairing with the master is automatic. We reuse the exact CLI
  // (`federation join`) so config merge + token handling stay single-sourced
  // with src/cli/gateway-cli/federation-join.ts. --config-only writes config
  // without restarting; the wizard boots the gateway itself next.
  ipcMain.handle('wizard:join-federation', async (_, opts = {}) => {
    const invite = typeof opts.invite === 'string' ? opts.invite.trim() : '';
    if (!invite) return { ok: false, error: 'Paste the invite code from the master first.', lines: [] };
    if (!opts.force && !isFirstRun()) {
      return {
        ok: false,
        alreadyConfigured: true,
        configPath: resolveConfigPath(),
        error: 'InfiniBot is already configured on this machine. Pass force:true to switch to satellite mode.',
        lines: [],
      };
    }
    const decoded = satelliteMode.decodeFederationInvite(invite);
    if (decoded.error) return { ok: false, error: decoded.error, lines: [] };
    if (decoded.expiresAt && Date.now() > decoded.expiresAt) {
      return {
        ok: false,
        error: 'This invite has expired (invites last 15 minutes). Generate a new one on the master: Fleet › Share Invite.',
        lines: [],
      };
    }
    // The invite lists every address the master answers on (Tailscale DNS,
    // Tailscale IP, LAN …). Probe them and lead with one that answers.
    const lines = [];
    const probe = await satelliteMode.probeMasterUrls(decoded.masterUrls);
    for (const r of probe.results) lines.push(`${r.ok ? '✓' : '✗'} ${r.url}${r.ok ? ` (${r.ms} ms)` : ` — ${r.error || 'no answer'}`}`);
    if (probe.reachable.length === 0) {
      return {
        ok: false,
        unreachable: true,
        error:
          "Can't reach the master from this computer. Check the master is running, then put both computers on the same network or sign both in to Tailscale, and try again.",
        lines,
      };
    }
    const [masterUrl, ...alternates] = probe.ordered;
    const name = (typeof opts.name === 'string' && opts.name.trim()) || decoded.name || os.hostname();
    // The invite only carries federation info, but a satellite still needs a
    // bootable GATEWAY config — onboard normally sets gateway.mode + gateway.auth,
    // so the invite path must too, or the gateway refuses to start
    // ("set gateway.mode=local" / "no token configured"). Fill ONLY what's
    // missing so an existing valid auth is never clobbered.
    const existingGw = configIo.readConfig(resolveConfigPath())?.gateway || {}; // null on a fresh install
    const gatewayPatch = {};
    if (!existingGw.mode) gatewayPatch.mode = 'local';
    if (!existingGw.bind) gatewayPatch.bind = 'loopback';
    // Pin a free port now. Without one the boot path probes 18789 and ADOPTS
    // any healthy gateway already there (an npm install, or another profile
    // when ownership can't be checked, e.g. on Windows) instead of running
    // this computer's own satellite.
    if (!(typeof existingGw.port === 'number' && existingGw.port > 0)) {
      const preferred = isSandboxStateDir() ? 28789 : 18789;
      const port = await pickFreePort(preferred);
      if (!port) return { ok: false, error: `No free network port near ${preferred} for the satellite service.`, lines };
      gatewayPatch.port = port;
    }
    const a = existingGw.auth || {};
    const authComplete = (a.mode === 'token' && a.token) || (a.mode === 'password' && a.password);
    if (!authComplete) {
      gatewayPatch.auth = { mode: 'token', token: crypto.randomBytes(24).toString('hex') };
    }
    // federation.authToken carries the invite token; the gateway swaps it for
    // a durable device credential on first contact (federation/satellite-credential.json).
    const patch = applyConfigPatch({
      ...(Object.keys(gatewayPatch).length ? { gateway: gatewayPatch } : {}),
      federation: {
        enabled: true,
        mode: 'satellite',
        masterUrl,
        masters: alternates,
        nodeId: decoded.nodeId,
        nodeName: name,
        authToken: decoded.token,
        label: decoded.hubName,
      },
    });
    if (!patch.ok) {
      lines.push(`config write failed: ${patch.code || 'error'} at ${resolveConfigPath()}`);
      return { ok: false, error: `Couldn't save the satellite settings. ${patch.error}`, lines };
    }
    satelliteJoinStartedAt = Date.now();
    try {
      store?.set('satellite', { masterUrl, name, joinedAt: satelliteJoinStartedAt });
      store?.delete?.('config.masterUrl'); // legacy "external satellite process" path
    } catch {/* tray fallback only */}
    lines.push(`Invite accepted — master ${masterUrl}`, `This device will appear on the master as "${name}".`);
    return { ok: true, masterUrl, name, hubName: decoded.hubName, lines };
  });

  // Satellite: wait for the local satellite gateway to register with the
  // master (status file written by the gateway). Never open the master UI
  // before this succeeds — that was the "webpage only" failure.
  ipcMain.handle('satellite:wait-connected', async (_, opts = {}) => {
    const r = await satelliteMode.waitForSatelliteConnected(resolveStateDir(), {
      timeoutMs: Math.min(Number(opts.timeoutMs) || 60_000, 180_000),
      since: satelliteJoinStartedAt || 0,
      onStatus: (st) => safeSend('satellite:status', satelliteStatusPayload(st)),
    });
    if (r.ok) startSatelliteServices();
    return { ok: r.ok, error: r.error, fatal: Boolean(r.fatal), status: r.status ? satelliteStatusPayload(r.status) : null };
  });

  ipcMain.handle('satellite:get-status', async () => satelliteStatusPayload(satelliteMode.readSatelliteStatus(resolveStateDir())));
  ipcMain.handle('satellite:open-status', async () => { openSatelliteStatusWindow(); return { ok: true }; });
  ipcMain.handle('satellite:open-master-ui', async () => openSatelliteMasterUi());
  ipcMain.handle('satellite:reconnect', async () => {
    if (!localGatewayProcess && !localGatewayPort) {
      const r = await startLocalGateway((line) => safeSend('wizard:gateway-log', line));
      return { ok: r.ok, error: r.error };
    }
    const r = await runInfinibotCli(['gateway', 'call', 'federation.satellite.reconnect', '--params', '{"reason":"desktop"}', '--json'], { timeoutMs: 30_000 });
    return { ok: r.ok, error: r.ok ? null : 'Could not reach the satellite service. Try Disconnect, then Connect.' };
  });
  ipcMain.handle('satellite:disconnect', async () => {
    // Stop the satellite gateway; the pairing is kept so Connect works without a new invite.
    satelliteUserStopped = true;
    await stopLocalGatewayChild();
    pushSatelliteStatus();
    return { ok: true };
  });
  ipcMain.handle('satellite:connect', async () => {
    satelliteUserStopped = false;
    const r = await startLocalGateway((line) => safeSend('wizard:gateway-log', line));
    return { ok: r.ok, error: r.error };
  });
  ipcMain.handle('satellite:leave', async () => leaveFederation());

  // InfiniBot Cloud: the hosted gateway, nothing local. In-app it opens in its
  // own window with no preload/Node bridge (remote content never sees the
  // wizard IPC); otherwise in the system browser.
  ipcMain.handle('wizard:open-cloud', async (_, { inApp = true } = {}) => {
    const url = process.env.INFINIBOT_CLOUD_URL || 'https://cloud.infinibotos.com';
    try {
      if (!inApp) { await shell.openExternal(url); return { ok: true }; }
      const win = new BrowserWindow({
        width: 1280, height: 860, title: 'InfiniBot Cloud', backgroundColor: '#0a0a0a',
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      // Deliberate in-app browser (InfiniBot Cloud in its own window): keeps
      // its own link rules below.
      externalLinks.markInAppBrowser(win.webContents);
      win.webContents.setWindowOpenHandler(({ url: u }) => {
        // OAuth popups (Clerk/Google) stay in-app; other links go to the browser.
        try {
          const h = new URL(u).hostname;
          if (/(^|\.)infinibotos\.com$|(^|\.)clerk\.|accounts\.google\.com$|github\.com$/.test(h)) return { action: 'allow' };
        } catch {/* bad url */}
        void shell.openExternal(u);
        return { action: 'deny' };
      });
      await win.loadURL(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  });

  ipcMain.handle('wizard:start-local-gateway', async () => {
    return startLocalGateway((line) => safeSend('wizard:gateway-log', line));
  });

  ipcMain.handle('wizard:open-gateway-ui', async (_, url) => {
    if (!url) return { ok: false, error: 'missing url' };
    // Attach the gateway credential (as the relaunch path does): a bare URL
    // left the freshly set-up UI on the password screen, reconnecting forever.
    let target = url;
    try {
      const h = new URL(url).hostname;
      if (h === '127.0.0.1' || h === 'localhost') target = resolveControlUiTarget({ mode: 'local' }, url);
    } catch {/* keep the bare url */}
    if (openVoicePageAfterSetup) {
      // One-shot: the user opted in to linking Robovoice on the wizard's
      // voice step, so land on the Voice page instead of the default route.
      openVoicePageAfterSetup = false;
      try {
        target = withVoicePageRoute(url);
      } catch (err) {
        sendLog(`could not route to the Voice page: ${err?.message ?? err}`, 'warn');
      }
    }
    loadWindowUrl(target);
    if (pendingNotesImport) void startPendingNotesImport(localGatewayPort);
    return { ok: true, url: target };
  });

  ipcMain.handle('wizard:open-satellite-ui', async () => {
    loadWindowFile('index.html');
    return { ok: true };
  });

  // ── License (plan + features) ──────────────────────────────────
  // Synchronous reads (renderer uses ipcRenderer.sendSync via the
  // window.license bridge) so plan/feature checks never need to await.
  ipcMain.on('license:get-plan', (e) => { e.returnValue = license.getPlan(); });
  ipcMain.on('license:get-features', (e) => { e.returnValue = license.getFeatures(); });
  ipcMain.on('license:has-feature', (e, id) => { e.returnValue = license.hasFeature(id); });
  ipcMain.on('license:get-state', (e) => { e.returnValue = license.getState(); });

  // Async: refresh against KV (with offline grace), then notify all renderers.
  ipcMain.handle('license:refresh', async () => {
    await license.refreshLicense();
    return broadcastLicenseChanged();
  });

  // Phase F telemetry: append one upgrade-funnel record to a JSONL sink
  // (~/.infinibot/license-telemetry.jsonl), rotating at 5 MB. Best-effort.
  ipcMain.handle('license:telemetry:append', (_, record) => {
    try {
      if (!record || typeof record !== 'object') return { ok: false };
      appendLicenseTelemetry(record);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  // Open the KV login page in the default browser and wait for the
  // infinibot://callback deep link (handleProtocolUrl saves the token).
  ipcMain.handle('license:sign-in', async () => {
    const target = `${KV_BASE}/login?return=${encodeURIComponent('infinibot://callback')}`;
    const { url, reachable } = await kvBrowserFlow.open(target, { match: (host) => host === 'callback' });
    if (!reachable) {
      return { ok: false, reachable: false, state: license.getState() };
    }
    return { ok: Boolean(url), reachable: true, state: broadcastLicenseChanged() };
  });

  // ── InfiniBot Vault sign-in (device authorization, RFC 8628) ─────
  // This is the auth the gateway/CLI actually require (auth-guard.ts →
  // ensureValidToken). Previously the only way to establish it was the
  // terminal `infinibot login`; we now drive the same device flow entirely in
  // the UI: open the Vault approval page in a child window, poll until the user
  // approves, and persist the token bundle to ~/.infinibot/auth.json. After
  // this succeeds the launch step never falls through to the terminal hint.
  ipcMain.handle('auth:status', async () => {
    try {
      const tokenStore = await loadDistModule(path.join('auth', 'token-store.js'));
      const stored = await tokenStore.loadAuth();
      return { ok: true, signedIn: Boolean(stored), tenantId: stored?.tenant_id || null };
    } catch (err) {
      return { ok: false, signedIn: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('auth:device-login', async () => {
    let authWin = null;
    try {
      const deviceFlow = await loadDistModule(path.join('auth', 'device-flow.js'));
      const tokenStore = await loadDistModule(path.join('auth', 'token-store.js'));
      const vaultClient = await loadDistModule(path.join('auth', 'vault-client.js'));
      const baseUrl = vaultClient.resolveVaultBaseUrl();

      // silent:true → no stderr banner / no OS-browser spawn; we own the UI.
      const start = await deviceFlow.startDeviceFlow({
        deviceLabel: os.hostname(),
        baseUrl,
        silent: true,
      });

      // Surface the user-code to the renderer so it's visible while we wait.
      for (const w of BrowserWindow.getAllWindows()) {
        try {
          w.webContents.send('auth:device-pending', {
            userCode: start.userCode,
            verificationUri: start.verificationUri,
          });
        } catch {/* window gone */}
      }

      // Open the Vault approval page in-app. The user is typically already
      // signed in to KinglyVault from the license step, so this is one click.
      authWin = new BrowserWindow({
        width: 480,
        height: 720,
        parent: mainWindow || undefined,
        modal: Boolean(mainWindow),
        show: true,
        title: 'Sign in to InfiniBot',
        backgroundColor: '#0f0f0f',
        autoHideMenuBar: true,
        // Dedicated 'kvauth' session for the kinglyvault.com device approval.
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'kvauth' },
      });
      // Deliberate in-app browser for the device approval.
      externalLinks.markInAppBrowser(authWin.webContents);
      authWin.loadURL(start.verificationUriComplete || start.verificationUri).catch(() => {});

      // Race approval against the user closing the window (treated as cancel).
      const cancelled = new Promise((resolve) => {
        authWin.on('closed', () => resolve({ __cancelled: true }));
      });
      const approved = deviceFlow.pollUntilApproved(start, { baseUrl });
      const tokens = await Promise.race([approved, cancelled]);
      if (tokens && tokens.__cancelled) {
        return { ok: false, cancelled: true, error: 'Sign-in window was closed before approval.' };
      }

      const stored = deviceFlow.tokenBundleToStoredAuth(tokens, baseUrl);
      await tokenStore.saveAuth(stored);
      sendLog('auth: InfiniBot device login complete', 'info');
      return { ok: true, tenantId: stored.tenant_id || null };
    } catch (err) {
      const msg = err?.message || String(err);
      sendLog(`auth: device login failed: ${msg}`, 'warn');
      return { ok: false, error: msg };
    } finally {
      try { if (authWin && !authWin.isDestroyed()) authWin.close(); } catch {/* already gone */}
    }
  });

  // Self-hosted (default): the wizard skips sign-in entirely and license.js
  // unlocks every feature. With INFINIBOT_REQUIRE_VAULT=1 sign-in is required
  // for every tier (Free users get a signed JWT issued by KV on signup).

  ipcMain.handle('license:logout', () => {
    license.logout();
    return broadcastLicenseChanged();
  });

  // Upgrade: open the InfiniBot OS landing page for <plan>. The landing
  // page surfaces all available tiers (Free / Starter / CEO) and hands the
  // user off to KV checkout from there. We deliberately do NOT jump
  // straight into KV checkout anymore — the landing page is the canonical
  // marketing surface and must own the price/positioning narrative.
  // Phase F: an optional base64url `intent` is threaded through so the
  // queued action can be rehydrated when the user returns.
  ipcMain.handle('wizard:openUpgrade', async (_, plan, intent) => {
    // Self-hosted installs are fully unlocked — there is nothing to upgrade.
    if (license.isSelfHosted()) return { ok: false, selfHosted: true, state: license.getState() };
    const safePlan = typeof plan === 'string' && plan ? plan : 'starter';
    const intentStr = typeof intent === 'string' && intent ? intent : null;
    let ret = 'infinibot://license-refreshed';
    if (intentStr) ret += `?intent=${encodeURIComponent(intentStr)}`;
    const upgradeBase = (process.env.INFINIBOT_UPGRADE_URL || 'https://infinibotos.com').replace(/\/+$/, '');
    const target = `${upgradeBase}/upgrade?plan=${encodeURIComponent(safePlan)}&return=${encodeURIComponent(ret)}`;
    // Default browser; the infinibot://license-refreshed return goes through
    // handleProtocolUrl (refreshLicense + broadcast + replay-intent).
    const { url, reachable } = await kvBrowserFlow.open(target, { match: (host) => host === 'license-refreshed' });
    if (!url && intentStr) {
      // No return (timed out or superseded) → drop the queued action quietly.
      const decoded = decodeIntentParam(intentStr);
      for (const w of BrowserWindow.getAllWindows()) {
        try { w.webContents.send('license:replay-cancel', decoded); } catch {/* window gone */}
      }
    }
    return { ok: reachable, reachable, state: license.getState() };
  });

  // Dev-only: paste a fake JWT to exercise the plan badge before Phase A ships
  // the real key. Guarded by INFINIBOT_ALLOW_RESET=1 (same gate as reset-state).
  ipcMain.handle('wizard:set-license-debug', (_, token) => {
    if (process.env.INFINIBOT_ALLOW_RESET !== '1') {
      return { ok: false, error: 'set-license-debug refused: INFINIBOT_ALLOW_RESET!=1' };
    }
    const r = license.setDebugLicense(String(token || ''));
    if (!r.ok) return r;
    broadcastLicenseChanged();
    return r;
  });

  ipcMain.handle('window:current-display', () => {
    try {
      if (!mainWindow) return null;
      const [x, y] = mainWindow.getPosition();
      const d = screen.getDisplayNearestPoint({ x, y });
      return d ? { id: d.id } : null;
    } catch {
      return null;
    }
  });
}

// ── Auto-updater ──────────────────────────────────────────────
// Checks the PUBLIC desktop releases repo (latest.yml / latest-linux.yml),
// downloads in the background and offers restart-to-install. The renderer's
// sidebar update widget mirrors this state over `desktop-update:*` IPC, so
// the desktop app never reports "up to date" from the npm registry (whose
// `latest` can be older than the desktop build). Verifies SHA512 from the
// feed; when code-signing is live, also the installer's Authenticode
// publisher (`publisherName`, currently off: installers are unsigned).
const desktopUpdatePackageType = desktopUpdate.desktopPackageType({ isPackaged: app.isPackaged });
let desktopUpdateState = {
  status: 'idle', // idle | checking | available | downloading | ready | up-to-date | error
  currentVersion: app.getVersion(),
  version: null,
  percent: 0,
  error: null,
  packageType: desktopUpdatePackageType,
  canSelfUpdate: desktopUpdate.canSelfUpdate(desktopUpdatePackageType),
  downloadUrl: desktopUpdate.desktopDownloadUrl(desktopUpdatePackageType),
  checkedAt: null,
};

function setDesktopUpdateState(patch) {
  desktopUpdateState = { ...desktopUpdateState, ...patch };
  safeSend('desktop-update:state', desktopUpdateState);
}

function newerThanCurrent(version) {
  return !!version && desktopUpdate.compareVersions(version, desktopUpdateState.currentVersion) > 0;
}

// Read the feed directly: the .deb path (no in-place updater) and the
// fallback when electron-updater errors, so the user still learns the version.
async function checkDesktopFeed() {
  try {
    const latest = await desktopUpdate.fetchLatestDesktopVersion();
    return { latest, error: null };
  } catch (err) {
    return { latest: null, error: err?.message ?? String(err) };
  }
}

// electron-updater both emits 'error' and rejects the check promise for the
// same failure; handle each failure once.
let desktopUpdateErrorPending = null;
function handleDesktopUpdaterError(err) {
  if (!desktopUpdateErrorPending) {
    desktopUpdateErrorPending = applyDesktopUpdaterError(err).finally(() => { desktopUpdateErrorPending = null; });
  }
  return desktopUpdateErrorPending;
}

async function applyDesktopUpdaterError(err) {
  const message = err?.message ?? String(err);
  sendLog(`updater error: ${message}`, 'error');
  let version = desktopUpdateState.version;
  if (!version) {
    const { latest } = await checkDesktopFeed();
    if (newerThanCurrent(latest)) version = latest;
  }
  // Never fall back to "up to date": a failed check/install is an error,
  // with a manual download link when a newer version is known.
  setDesktopUpdateState({ status: 'error', error: message, version, checkedAt: Date.now() });
}

let desktopUpdateCheck = null;
function checkForDesktopUpdates() {
  if (process.env.INFINIBOT_DESKTOP_DISABLE_UPDATES === '1') {
    return Promise.resolve({ ...desktopUpdateState, status: 'up-to-date', error: null });
  }
  if (desktopUpdateState.status === 'downloading' || desktopUpdateState.status === 'ready') {
    return Promise.resolve(desktopUpdateState);
  }
  if (desktopUpdateCheck) return desktopUpdateCheck;
  desktopUpdateCheck = (async () => {
    setDesktopUpdateState({ status: 'checking', error: null });
    if (desktopUpdateState.canSelfUpdate) {
      try {
        await autoUpdater.checkForUpdates();
      } catch (err) {
        await handleDesktopUpdaterError(err);
      }
    } else {
      const { latest, error } = await checkDesktopFeed();
      if (error) {
        setDesktopUpdateState({ status: 'error', error, checkedAt: Date.now() });
      } else if (newerThanCurrent(latest)) {
        setDesktopUpdateState({ status: 'available', version: latest, checkedAt: Date.now() });
      } else {
        setDesktopUpdateState({ status: 'up-to-date', version: latest, checkedAt: Date.now() });
      }
    }
    return desktopUpdateState;
  })().finally(() => { desktopUpdateCheck = null; });
  return desktopUpdateCheck;
}

function openDesktopDownloadPage() {
  return shell.openExternal(desktopUpdateState.downloadUrl);
}

async function downloadDesktopUpdate() {
  const { status, canSelfUpdate } = desktopUpdateState;
  if (canSelfUpdate && status === 'available') {
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      await handleDesktopUpdaterError(err);
    }
  } else {
    await openDesktopDownloadPage();
  }
  return desktopUpdateState;
}

function installDesktopUpdate() {
  if (desktopUpdateState.status !== 'ready') return false;
  isQuitting = true;
  autoUpdater.quitAndInstall(false, true);
  return true;
}

// Menu / tray "Check for Updates…": the sidebar may not be on screen, so
// answer with a dialog.
async function checkForDesktopUpdatesInteractive() {
  const s = await checkForDesktopUpdates();
  const opts = { type: 'info', title: 'InfiniBot updates', buttons: ['OK'] };
  if (s.status === 'up-to-date') {
    opts.message = `You're on the latest version (v${s.currentVersion}).`;
  } else if (s.status === 'ready') {
    opts.message = `InfiniBot ${s.version} is ready to install.`;
    opts.buttons = ['Restart now', 'Later'];
  } else if ((s.status === 'available' || s.status === 'downloading') && s.canSelfUpdate) {
    opts.message = `InfiniBot ${s.version} is available.`;
    opts.detail = 'It is downloading in the background; you will be asked to restart when it is ready.';
  } else if (s.version && newerThanCurrent(s.version)) {
    opts.message = `InfiniBot ${s.version} is available (you have v${s.currentVersion}).`;
    opts.detail = s.canSelfUpdate
      ? `The automatic update failed${s.error ? `: ${s.error}` : ''}. Download the installer and run it to update.`
      : 'Download the new installer and run it to update.';
    opts.buttons = ['Download', 'Later'];
  } else {
    opts.type = 'warning';
    opts.message = "Couldn't check for updates.";
    opts.detail = s.error || undefined;
    opts.buttons = ['Open downloads', 'OK'];
  }
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
  if (response !== 0) return;
  if (s.status === 'ready') installDesktopUpdate();
  else if (opts.buttons[0] === 'Download' || opts.buttons[0] === 'Open downloads') void openDesktopDownloadPage();
}

function setupAutoUpdater() {
  ipcMain.handle('desktop-update:get-state', () => desktopUpdateState);
  ipcMain.handle('desktop-update:check', () => checkForDesktopUpdates());
  ipcMain.handle('desktop-update:download', () => downloadDesktopUpdate());
  ipcMain.handle('desktop-update:install', () => installDesktopUpdate());
  ipcMain.handle('desktop-update:open-download', async () => { await openDesktopDownloadPage(); return true; });

  if (!app.isPackaged) return; // dev mode: no background checks
  // Test rigs / managed installs: never download or install updates.
  if (process.env.INFINIBOT_DESKTOP_DISABLE_UPDATES === '1') return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('error', (err) => { void handleDesktopUpdaterError(err); });
  autoUpdater.on('checking-for-update', () => {
    sendLog('updater: checking for updates', 'info');
    setDesktopUpdateState({ status: 'checking', error: null });
  });
  autoUpdater.on('update-available', (info) => {
    sendLog(`updater: update available ${info?.version} (current ${app.getVersion()})`, 'info');
    setDesktopUpdateState({ status: 'available', version: info?.version ?? null, percent: 0, checkedAt: Date.now() });
    showNotification('Update available', `InfiniBot ${info?.version} is downloading in the background.`);
  });
  autoUpdater.on('update-not-available', (info) => {
    sendLog('updater: up to date', 'info');
    setDesktopUpdateState({ status: 'up-to-date', version: info?.version ?? null, checkedAt: Date.now() });
  });
  autoUpdater.on('download-progress', (p) => {
    sendLog(`updater: downloading ${Math.round(p?.percent ?? 0)}% (${Math.round((p?.bytesPerSecond ?? 0) / 1024)} KB/s)`, 'debug');
    setDesktopUpdateState({ status: 'downloading', percent: Math.round(p?.percent ?? 0) });
  });
  autoUpdater.on('update-downloaded', async (info) => {
    sendLog(`updater: downloaded ${info?.version}`, 'info');
    setDesktopUpdateState({ status: 'ready', version: info?.version ?? desktopUpdateState.version, percent: 100 });
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'InfiniBot update ready',
      message: `InfiniBot ${info?.version} is ready to install.`,
      detail: 'Restart now to apply the update, or it will install the next time you quit InfiniBot.',
    });
    if (result.response === 0) {
      installDesktopUpdate();
    } else {
      // Defer until next quit (set autoInstallOnAppQuit only after user
      // opted in, so they don't get a surprise install on a force-kill).
      autoUpdater.autoInstallOnAppQuit = true;
    }
  });

  // First check 30s after launch so we don't fight gateway boot for I/O,
  // then every 4 hours while the app stays open.
  setTimeout(() => void checkForDesktopUpdates(), 30_000);
  setInterval(() => void checkForDesktopUpdates(), 4 * 60 * 60 * 1000);
}

// About InfiniBot. macOS uses the native About panel (role: 'about'); Windows
// and Linux get the same facts in a branded dialog so nothing says "Electron".
const ABOUT_COPYRIGHT = `Copyright © ${new Date().getFullYear()} InfiniBot`;
function aboutDetail() {
  return [
    `Version ${app.getVersion()}`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
    ABOUT_COPYRIGHT,
    'https://infinibotos.com',
  ].join('\n');
}
function configureAboutPanel() {
  try {
    app.setAboutPanelOptions({
      applicationName: 'InfiniBot',
      applicationVersion: app.getVersion(),
      copyright: ABOUT_COPYRIGHT,
      website: 'https://infinibotos.com',
      iconPath: path.join(__dirname, 'assets', 'icon.png'),
    });
  } catch {/* older Electron on some platforms */}
}
async function showAboutDialog() {
  const opts = {
    type: 'none',
    title: 'About InfiniBot',
    message: 'InfiniBot',
    detail: aboutDetail(),
    icon: nativeImage.createFromPath(path.join(__dirname, 'assets', 'infinibot-icon-dark-128.png')),
    buttons: ['OK', 'Website', 'Release notes'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  if (response === 1) void shell.openExternal('https://infinibotos.com');
  if (response === 2) void shell.openExternal(desktopUpdate.RELEASES_URL);
}

// Application menu. Standard role menus keep copy/paste, zoom, reload and
// devtools shortcuts; "Check for Updates…" sits in the app menu on macOS and
// under Help elsewhere.
function setupApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const checkItem = { label: 'Check for Updates…', click: () => void checkForDesktopUpdatesInteractive() };
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' }, checkItem, { type: 'separator' },
            { role: 'services' }, { type: 'separator' },
            { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        ...(isMac ? [] : [checkItem, { type: 'separator' }]),
        { label: 'InfiniBot website', click: () => void shell.openExternal('https://infinibotos.com') },
        ...(isMac ? [] : [{ type: 'separator' }, { label: 'About InfiniBot', click: () => void showAboutDialog() }]),
        { label: 'Desktop releases', click: () => void shell.openExternal(desktopUpdate.RELEASES_URL) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Desktop profile: 'shared' = use ~/.infinibot (an existing install, with
// consent), 'separate' = a private state dir for the desktop app. Only asked
// when ~/.infinibot already has a config and no explicit INFINIBOT_STATE_DIR
// is set. Returns false when the user chose to quit.
async function resolveExistingInstallChoice() {
  if (STATE_DIR_FROM_ENV) return true;
  const separateDir = path.join(os.homedir(), '.infinibot-desktop');
  let choice = store?.get('stateProfile');
  // A data folder picked on the first-launch screen.
  const customDir = store?.get('stateDir');
  if (choice === 'custom' && typeof customDir === 'string' && customDir) {
    fs.mkdirSync(customDir, { recursive: true });
    process.env.INFINIBOT_STATE_DIR = customDir;
    return true;
  }
  const existing = path.join(os.homedir(), '.infinibot', 'infinibot.json');
  if (!choice) {
    if (!fs.existsSync(existing)) {
      // Fresh machine: ~/.infinibot will be created by this app, so it is ours
      // from now on (no prompt on the next launch).
      store?.set('stateProfile', 'shared');
      return true;
    }
    const r = await dialog.showMessageBox({
      type: 'question',
      title: 'InfiniBot',
      message: 'An existing InfiniBot install was found',
      detail:
        `InfiniBot is already set up on this computer (${existing}), for example from npm.\n\n` +
        'Use it: the desktop app runs that same gateway, config and data.\n' +
        `Separate: the desktop app gets its own profile in ${separateDir} and leaves the existing install untouched.`,
      buttons: ['Use existing install', 'Separate desktop profile', 'Quit'],
      defaultId: 1,
      cancelId: 2,
      noLink: true,
    });
    if (r.response === 2) return false;
    choice = r.response === 0 ? 'shared' : 'separate';
    store?.set('stateProfile', choice);
  }
  if (choice === 'separate') {
    fs.mkdirSync(separateDir, { recursive: true });
    process.env.INFINIBOT_STATE_DIR = separateDir;
  }
  return true;
}

// App lifecycle
app.whenReady().then(async () => {
  await initStore();

  // Never take over an existing InfiniBot install (an npm/CLI ~/.infinibot)
  // without asking. Must run before license.init()/the gateway, which read
  // INFINIBOT_STATE_DIR.
  if (!(await resolveExistingInstallChoice())) { app.exit(0); return; }

  // Load license (plan + features) into the main process before any window
  // queries it. Best-effort: a missing/placeholder key just yields Free.
  try { license.init(); } catch (err) { sendLog(`license init failed: ${err?.message ?? err}`, 'warn'); }

  // Register as the default handler for infinibot:// deep links.
  registerProtocolClient();

  // Same id the NSIS shortcuts carry (build.appId), so Windows groups the
  // taskbar button and shows notifications as "InfiniBot", not electron.app.*.
  if (process.platform === 'win32') app.setAppUserModelId('com.infinibot.desktop');
  configureAboutPanel();
  setupApplicationMenu();
  createWindow();
  createTray();
  setupIpcHandlers();
  setupAutoUpdater();

  // A deep link may have launched us (cold start) — replay it once the window
  // is up so the renderer is around to receive license:changed.
  const launchUrl = pendingProtocolUrl || findProtocolUrlInArgv(process.argv);
  if (launchUrl) {
    pendingProtocolUrl = null;
    const replay = () => handleProtocolUrl(launchUrl);
    if (mainWindow) mainWindow.webContents.once('did-finish-load', replay);
    else replay();
  }

  // The old "external satellite process" (startGateway: `gateway --satellite`)
  // is no longer auto-started: in satellite mode the local gateway started by
  // createWindow() IS the satellite. Auto-starting both ran two satellites
  // with the same node id that kept superseding each other on the master.
  if (isSatelliteConfigured()) startSatelliteServices();
});

// Registers infinibot:// as this app's protocol. Cross-platform via
// app.setAsDefaultProtocolClient. On Linux that call alone is often NOT enough
// for the desktop environment to route the scheme — the OS dispatches schemes
// through a .desktop file's `MimeType=x-scheme-handler/infinibot;` entry — so
// we also write a best-effort user-level .desktop fragment. (In dev/unpacked
// this still won't fully register because there's no installed launcher; the
// flow is exercised via the in-app BrowserWindow capture + --url= argv path.)
function registerProtocolClient() {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      // Dev: electron must know its own entry to relaunch with the URL.
      app.setAsDefaultProtocolClient('infinibot', process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient('infinibot');
    }
  } catch (err) {
    sendLog(`protocol register failed: ${err?.message ?? err}`, 'warn');
  }
  if (process.platform === 'linux') {
    try {
      const appsDir = path.join(os.homedir(), '.local', 'share', 'applications');
      fs.mkdirSync(appsDir, { recursive: true });
      // AppImage: execPath lives in a temporary FUSE mount; $APPIMAGE is the
      // stable path of the file the user launched.
      const exe = process.env.APPIMAGE || process.execPath;
      const execLine = app.isPackaged ? `"${exe}" %u` : `${process.execPath} ${path.resolve(process.argv[1] || '.')} %u`;
      const desktop = [
        '[Desktop Entry]',
        'Name=InfiniBot',
        'Type=Application',
        `Exec=${execLine}`,
        'NoDisplay=true',
        'Terminal=false',
        'MimeType=x-scheme-handler/infinibot;',
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(appsDir, 'infinibot-protocol.desktop'), desktop, 'utf-8');
      // Best-effort: refresh the scheme→.desktop association cache.
      try { spawnSync('update-desktop-database', [appsDir], { timeout: 4000, windowsHide: true }); } catch {/* optional */}
    } catch (err) {
      sendLog(`linux protocol .desktop write failed: ${err?.message ?? err}`, 'warn');
    }
  }
}

app.on('window-all-closed', () => {
  // Don't quit on window close - stay in tray
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  } else {
    mainWindow?.show();
  }
});

// Quit cleanly: stop the gateway children, then EXIT. The old async
// before-quit handler never prevented the default, so Electron could exit
// before the children got SIGTERM (orphaned gateways holding the port), and
// SIGTERM to the app itself skipped cleanup. Same path for every signal;
// bounded so a wedged child can never keep the process alive.
let shuttingDown = null;
function shutdownApp(reason) {
  if (shuttingDown) return shuttingDown;
  isQuitting = true;
  try { sendLog(`shutting down (${reason})`, 'info'); } catch {/* window gone */}
  const stop = (proc) => new Promise((resolve) => {
    if (!proc || proc.exitCode !== null) return resolve();
    proc.once('close', resolve);
    try { proc.kill('SIGTERM'); } catch { resolve(); }
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {/* gone */} resolve(); }, 4000);
  });
  shuttingDown = Promise.all([stop(gatewayProcess), stop(localGatewayProcess)])
    .catch(() => {})
    .finally(() => app.exit(0));
  return shuttingDown;
}

app.on('before-quit', (e) => {
  if (shuttingDown) return;
  e.preventDefault();
  void shutdownApp('quit');
});

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    void shutdownApp(sig);
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

// macOS delivers deep links via 'open-url' (not argv). Buffer until ready.
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (app.isReady()) handleProtocolUrl(url);
  else pendingProtocolUrl = url;
});

// Linux keyring: Chromium picks the secret store from XDG_CURRENT_DESKTOP and
// falls back to plain-text ("basic") on desktops it doesn't know (Hyprland,
// Sway, i3, unset). safeStorage then can't encrypt license.enc. Ask for
// libsecret explicitly there; GNOME/KDE/etc. keep their own detection.
if (process.platform === 'linux' && !process.argv.some((a) => a.startsWith('--password-store'))) {
  const de = String(process.env.XDG_CURRENT_DESKTOP || '').toLowerCase();
  const known = ['gnome', 'unity', 'kde', 'xfce', 'cinnamon', 'mate', 'budgie', 'pantheon', 'deepin', 'lxqt'];
  if (!known.some((k) => de.includes(k))) app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}

// Satellite: Chromium refuses the control UI's WebSocket/crypto APIs on a
// plain-http origin (e.g. a master at http://192.168.1.20:18789). Flag the
// configured master's origin(s) as secure — they come from this user's own
// invite, never from page content. Must run before app 'ready'.
(function registerSatelliteSecureOrigins() {
  const candidates = new Set([
    configIo.resolveConfigPath(),
    path.join(os.homedir(), '.infinibot', 'infinibot.json'),
    path.join(os.homedir(), '.infinibot-desktop', 'infinibot.json'),
  ].filter(Boolean));
  for (const file of candidates) {
    try {
      const fed = JSON.parse(fs.readFileSync(file, 'utf-8'))?.federation;
      if (!(fed?.enabled && fed?.mode === 'satellite' && fed?.masterUrl)) continue;
      for (const u of [fed.masterUrl, ...(Array.isArray(fed.masters) ? fed.masters : [])]) {
        const origin = satelliteMode.httpOriginOf(u);
        if (origin.startsWith('http:')) satelliteSecureOrigins.add(new URL(origin).origin);
      }
    } catch {/* no config there */}
  }
  if (satelliteSecureOrigins.size) {
    app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', [...satelliteSecureOrigins].join(','));
  }
})();

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // A second launch may carry an infinibot:// deep link (Windows/Linux
    // deliver it as an argv entry on the new instance).
    const url = findProtocolUrlInArgv(argv);
    if (url) handleProtocolUrl(url);
    // Focus the main window if a second instance is launched
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  shell,
  nativeImage,
  Notification,
  powerSaveBlocker,
  dialog,
} from "electron";
import { autoUpdater } from "electron-updater";
import path from "path";
import fs from "fs";
import http from "http";
import { spawn, ChildProcess } from "child_process";
import os from "os";
import { applyWindowsHardenedBoot } from "./windows-hardened-boot.js";

// Apply Windows-hardened-mode flag before the gateway process is spawned so
// the child inherits INFINIBOT_WINDOWS_HARDENED_MODE from the environment.
applyWindowsHardenedBoot();

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Desktop gateway port.  The desktop app overrides the CLI default (18789)
 * so it has its own dedicated port.  Matches the NSIS firewall rule.
 *
 * Override via INFINIBOT_DESKTOP_GATEWAY_PORT or INFINIBOT_GATEWAY_PORT.
 */
const GATEWAY_PORT = parseInt(
  process.env.INFINIBOT_DESKTOP_GATEWAY_PORT ??
    process.env.INFINIBOT_GATEWAY_PORT ??
    "47913",
  10,
);

const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;
// Voice runs on Robovoice; this control-UI route is its console.
const VOICE_PAGE_ROUTE = "/voice";
const DEEP_LINK_SCHEME = "infinibot";
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_BASE_DELAY_MS = 1_000;

// Gateway "ready" detection: poll HTTP until it responds
const READY_POLL_INTERVAL_MS = 500;
const READY_POLL_TIMEOUT_MS = 60_000;

// ─── Mutable state ───────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let gatewayProcess: ChildProcess | null = null;
let isQuitting = false;
let gatewayReady = false;
let powerSaveId: number | null = null;
let restartAttempts = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let readyPollTimer: ReturnType<typeof setInterval> | null = null;

// ─── Single-instance lock ────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.on("second-instance", (_event, argv) => {
  // Bring window to front
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  // Handle deep link from second instance on Windows
  const link = argv.find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`));
  if (link) handleDeepLink(link);
});

// ─── Deep link scheme ─────────────────────────────────────────────────────────
// Register "infinibot://" — on Mac this is done globally; on Windows
// we set the default protocol client for this executable.

if (process.defaultApp) {
  // Running via `electron .` (dev)
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
}

// macOS fires open-url; Windows fires second-instance
app.on("open-url", (_event, url) => handleDeepLink(url));

function handleDeepLink(url: string): void {
  if (!url) return;
  // Route to the gateway's CLI command parser via the renderer IPC bridge
  mainWindow?.webContents.send("deep-link", url);
  mainWindow?.show();
}

// ─── Path helpers ────────────────────────────────────────────────────────────

function resolveStateDir(): string {
  return process.env.INFINIBOT_STATE_DIR ?? path.join(os.homedir(), ".infinibot");
}

function resolveConfigPath(): string {
  return (
    process.env.INFINIBOT_CONFIG_PATH ??
    path.join(resolveStateDir(), "infinibot.json")
  );
}

function isFirstRun(): boolean {
  try {
    return !fs.existsSync(resolveConfigPath());
  } catch {
    return true;
  }
}

function getLogPath(): string {
  return path.join(resolveStateDir(), "desktop.log");
}

function locateLauncher(): string {
  // Packaged: launcher.js is in the asar-unpacked root
  const packed = path.join(
    path.dirname(app.getAppPath()),
    "app.asar.unpacked",
    "launcher.js",
  );
  if (fs.existsSync(packed)) return packed;

  // Dev: apps/desktop/launcher.js
  const dev = path.join(__dirname, "..", "launcher.js");
  if (fs.existsSync(dev)) return dev;

  throw new Error(`launcher.js not found (tried ${packed}, ${dev})`);
}

// ─── Power-save blocker ──────────────────────────────────────────────────────

function startPowerSave(): void {
  if (powerSaveId === null) {
    powerSaveId = powerSaveBlocker.start("prevent-app-suspension");
  }
}

function stopPowerSave(): void {
  if (powerSaveId !== null) {
    powerSaveBlocker.stop(powerSaveId);
    powerSaveId = null;
  }
}

// ─── Gateway HTTP polling ────────────────────────────────────────────────────

function pollUntilReady(): void {
  const deadline = Date.now() + READY_POLL_TIMEOUT_MS;
  readyPollTimer = setInterval(() => {
    if (Date.now() > deadline) {
      clearInterval(readyPollTimer!);
      readyPollTimer = null;
      return;
    }
    httpGet(`${GATEWAY_URL}/health`)
      .then(() => {
        clearInterval(readyPollTimer!);
        readyPollTimer = null;
        if (!gatewayReady) {
          gatewayReady = true;
          restartAttempts = 0;
          updateTray();
          loadDashboard();
        }
      })
      .catch(() => {
        /* not ready yet */
      });
  }, READY_POLL_INTERVAL_MS);
}

function httpGet(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 400 }, (res) => {
      res.resume();
      res.statusCode && res.statusCode < 500 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ─── Gateway lifecycle ───────────────────────────────────────────────────────

function spawnGateway(): void {
  if (gatewayProcess) return;

  let launcher: string;
  try {
    launcher = locateLauncher();
  } catch (err) {
    showToast("InfiniBot", `Cannot locate gateway: ${err}`);
    return;
  }

  const gwEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    // Force the desktop port so the gateway doesn't use its CLI default (18789)
    INFINIBOT_GATEWAY_PORT: String(GATEWAY_PORT),
    INFINIBOT_DESKTOP_GATEWAY_PORT: String(GATEWAY_PORT),
    INFINIBOT_LAUNCHED_BY: "electron-desktop",
  };

  // Spawn: electron-as-node launcher.js -- daemon start --foreground
  gatewayProcess = spawn(
    process.execPath,
    [launcher, "--", "daemon", "start", "--foreground"],
    {
      env: gwEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );

  startPowerSave();
  gatewayReady = false;
  updateTray();

  // Pipe stdout → renderer logs + look for port line as an early-ready hint
  gatewayProcess.stdout?.on("data", (chunk: Buffer) => {
    const line = chunk.toString();
    mainWindow?.webContents.send("gateway-log", { type: "info", message: line });
    // If the gateway prints a "listening" line, we can skip polling sooner
    if (!gatewayReady && /listen|ready|:47913|:\d{4,5}/i.test(line)) {
      pollUntilReady();
    }
  });

  gatewayProcess.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString();
    mainWindow?.webContents.send("gateway-log", { type: "error", message: line });
  });

  // Start polling regardless (stdout may be buffered or suppressed)
  setTimeout(() => pollUntilReady(), 2_000);

  gatewayProcess.on("exit", (code, signal) => {
    gatewayProcess = null;
    gatewayReady = false;

    if (readyPollTimer) {
      clearInterval(readyPollTimer);
      readyPollTimer = null;
    }

    stopPowerSave();
    updateTray();

    if (isQuitting) return;

    if (restartAttempts < MAX_RESTART_ATTEMPTS) {
      const delay = RESTART_BASE_DELAY_MS * Math.pow(2, restartAttempts);
      restartAttempts++;
      const msg = `Gateway exited (code ${code ?? signal}). Restarting in ${delay / 1000}s… (${restartAttempts}/${MAX_RESTART_ATTEMPTS})`;
      showToast("InfiniBot", msg);
      mainWindow?.webContents.send("gateway-log", { type: "warn", message: msg });
      restartTimer = setTimeout(spawnGateway, delay);
    } else {
      const msg = "Gateway failed to start after 5 attempts. Check logs for details.";
      showToast("InfiniBot — Critical", msg);
      mainWindow?.webContents.send("gateway-fatal", { code, signal });
    }
  });
}

function killGateway(): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (readyPollTimer) {
    clearInterval(readyPollTimer);
    readyPollTimer = null;
  }
  restartAttempts = 0;

  if (gatewayProcess) {
    gatewayProcess.kill("SIGTERM");
    // Hard-kill fallback after 5 s
    const pid = gatewayProcess.pid;
    if (pid) {
      setTimeout(() => {
        try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
      }, 5_000);
    }
    gatewayProcess = null;
  }

  gatewayReady = false;
  stopPowerSave();
  updateTray();
}

// ─── Tray ────────────────────────────────────────────────────────────────────

function createTray(): void {
  const iconPath = path.join(__dirname, "..", "build", "icons", "tray.png");
  const icon = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  tray = new Tray(icon);
  tray.setToolTip("InfiniBot");
  tray.on("click", () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
  });

  updateTray();
}

function updateTray(): void {
  if (!tray) return;

  const gwLabel = gatewayReady
    ? "● Gateway Running"
    : gatewayProcess
      ? "◐ Gateway Starting…"
      : "○ Gateway Stopped";

  const menu = Menu.buildFromTemplate([
    { label: "InfiniBot", enabled: false },
    { label: gwLabel, enabled: false },
    { type: "separator" },
    {
      label: "Open Dashboard",
      click: () => {
        mainWindow?.show();
        loadDashboard();
      },
    },
    {
      // Voice runs on Robovoice; the Voice page is its console (link + calls).
      label: "Open Voice",
      enabled: gatewayReady,
      click: () => {
        mainWindow?.show();
        loadDashboard(VOICE_PAGE_ROUTE);
      },
    },
    { type: "separator" },
    {
      label: "Start Gateway",
      enabled: !gatewayProcess,
      click: () => {
        restartAttempts = 0;
        spawnGateway();
      },
    },
    {
      label: "Stop Gateway",
      enabled: !!gatewayProcess,
      click: () => killGateway(),
    },
    { type: "separator" },
    { label: "View Logs", click: () => shell.openPath(getLogPath()) },
    { type: "separator" },
    {
      label: "Quit InfiniBot",
      click: () => {
        isQuitting = true;
        killGateway();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

// ─── BrowserWindow ───────────────────────────────────────────────────────────

function loadDashboard(route = ""): void {
  if (!mainWindow) return;

  if (gatewayReady) {
    mainWindow.loadURL(`${GATEWAY_URL}${route}`).catch(() => {
      mainWindow?.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));
    });
  } else {
    // Show local splash while gateway boots
    const splash = path.join(__dirname, "..", "src", "renderer", "index.html");
    if (fs.existsSync(splash)) {
      mainWindow.loadFile(splash);
    }
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#0a0a0a",
    title: "InfiniBot",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Allow loading the local gateway UI (http://127.0.0.1:47913)
      webSecurity: true,
    },
  });

  if (isFirstRun()) {
    mainWindow.loadFile(
      path.join(__dirname, "..", "src", "first-run.html"),
    );
  } else {
    loadDashboard();
  }

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  // Tray-only mode: hide instead of close
  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ─── Toast helper ─────────────────────────────────────────────────────────────

function showToast(title: string, body: string): void {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

// ─── Auto-updater ─────────────────────────────────────────────────────────────
//
// Env vars needed for CI publish:
//   GH_TOKEN          — GitHub personal access token (private repos or rate limit)
//   CSC_LINK          — code-sign cert path / base64
//   CSC_KEY_PASSWORD  — cert password
//   EP_PRE_RELEASE    — "true" to publish as pre-release

function setupAutoUpdater(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    mainWindow?.webContents.send("update-available", info);
    showToast(
      "InfiniBot Update Available",
      `Version ${info.version} is ready to download.`,
    );
  });

  autoUpdater.on("update-downloaded", () => {
    mainWindow?.webContents.send("update-ready");
    showToast(
      "InfiniBot Update Ready",
      "Restart InfiniBot to apply the update.",
    );
  });

  autoUpdater.on("error", (err) => {
    console.error("[updater]", err.message);
  });

  // Check on startup (silently; no error toast for network failures)
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10_000);
  // Re-check every 4 hours
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60_000);
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

function registerIpc(): void {
  ipcMain.handle("gateway:start", () => {
    restartAttempts = 0;
    spawnGateway();
  });

  ipcMain.handle("gateway:stop", () => killGateway());

  ipcMain.handle("gateway:status", () => ({
    ready: gatewayReady,
    running: !!gatewayProcess,
    port: GATEWAY_PORT,
    url: GATEWAY_URL,
    restartAttempts,
  }));

  ipcMain.handle("gateway:url", () => GATEWAY_URL);

  ipcMain.handle("firstrun:complete", () => {
    // First-run wizard finished — boot gateway and load dashboard
    if (!gatewayProcess) {
      restartAttempts = 0;
      spawnGateway();
    }
    if (mainWindow) {
      // Dashboard will load once gatewayReady fires
      loadDashboard();
    }
  });

  ipcMain.handle("shell:openLogs", () => shell.openPath(getLogPath()));

  ipcMain.handle("update:install", () =>
    autoUpdater.quitAndInstall(false, true),
  );

  ipcMain.handle("update:check", () =>
    autoUpdater.checkForUpdates().catch(() => null),
  );

  ipcMain.handle("dialog:showError", (_e, title: string, content: string) =>
    dialog.showErrorBox(title, content),
  );

  ipcMain.handle("window:show", () => mainWindow?.show());
  ipcMain.handle("window:hide", () => mainWindow?.hide());
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  registerIpc();
  createTray();
  createWindow();
  setupAutoUpdater();

  // Boot gateway immediately unless this is first run
  if (!isFirstRun()) {
    spawnGateway();
  }
});

// Keep the app alive even if all windows are closed (tray-only mode)
app.on("window-all-closed", () => {
  // intentionally empty — stay resident in tray
});

app.on("activate", () => {
  // macOS: re-create window if Dock icon is clicked and no windows are open
  if (!mainWindow) {
    createWindow();
  } else {
    mainWindow.show();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  killGateway();
});

// ─── Unhandled rejection safety net ──────────────────────────────────────────

process.on("unhandledRejection", (reason) => {
  console.error("[main] unhandledRejection:", reason);
});

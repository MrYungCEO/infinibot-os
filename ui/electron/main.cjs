/**
 * InfiniBot Electron Main Process
 * Wraps the existing web UI in a native desktop window
 */

const { app, BrowserWindow, shell, ipcMain, Menu, Tray, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// Disable GPU acceleration if issues occur
// app.disableHardwareAcceleration();

// Keep a global reference of the window objects
let mainWindow = null;
let allWindows = [];
let tray = null;
let isQuitting = false;

// Config
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
// Canonical gateway port is 18789. 47913 is the federation hub port — using
// it here caused "voice won't connect" / silent STT when the Electron host
// pointed at the wrong port. See src/config/paths.ts DEFAULT_GATEWAY_PORT.
const GATEWAY_PORT = process.env.INFINIBOT_GATEWAY_PORT || 18789;
const GATEWAY_HOST = process.env.INFINIBOT_GATEWAY_HOST || '127.0.0.1';
const GATEWAY_PASSWORD = process.env.INFINIBOT_PASSWORD || '';

// Window state persistence
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load window state:', e);
  }
  return {
    width: 1400,
    height: 900,
    x: undefined,
    y: undefined,
    isMaximized: false,
  };
}

function saveWindowState() {
  if (!mainWindow) return;
  try {
    const bounds = mainWindow.getBounds();
    const state = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized: mainWindow.isMaximized(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('Failed to save window state:', e);
  }
}

function createWindow(isMainWindow = true) {
  const state = isMainWindow ? loadWindowState() : {
    width: 1400,
    height: 900,
    x: undefined,
    y: undefined,
    isMaximized: false,
  };

  // Offset new windows slightly so they don't overlap
  if (!isMainWindow && allWindows.length > 0) {
    const offset = (allWindows.length % 5) * 30;
    if (state.x !== undefined) state.x += offset;
    if (state.y !== undefined) state.y += offset;
  }

  const newWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 800,
    minHeight: 600,
    title: 'InfiniBot',
    icon: path.join(__dirname, '../public/favicon.ico'),
    backgroundColor: '#0a0a0a',
    
    // Frame settings
    frame: true,
    titleBarStyle: 'default',
    
    // Web preferences
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // Disabled for SpeechRecognition network access
      preload: path.join(__dirname, 'preload.cjs'),
      // Allow connecting to local gateway
      webSecurity: true,
      // Enable speech recognition
      spellcheck: true,
    },
    
    // Show when ready
    show: false,
  });

  // Restore maximized state
  if (state.isMaximized && isMainWindow) {
    newWindow.maximize();
  }

  // Load the app
  // Built files are at infinibot/dist/control-ui/ (two levels up from electron folder)
  const indexPath = path.join(__dirname, '../../dist/control-ui/index.html');
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  
  if (devServerUrl) {
    // Dev server URL explicitly set - use it
    console.log('[Electron] Loading from dev server:', devServerUrl);
    newWindow.loadURL(devServerUrl);
    if (isMainWindow) newWindow.webContents.openDevTools();
  } else if (fs.existsSync(indexPath)) {
    // Built files exist - use them
    console.log('[Electron] Loading from built files:', indexPath);
    newWindow.loadFile(indexPath);
  } else {
    // Fall back to dev server
    console.log('[Electron] No built files found, trying dev server...');
    newWindow.loadURL('http://localhost:5173');
    if (isMainWindow) newWindow.webContents.openDevTools();
  }

  // Show when ready to prevent flash
  newWindow.once('ready-to-show', () => {
    newWindow.show();
    newWindow.focus();
  });

  // Handle external links
  newWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Open external URLs in default browser
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Save state on close (only for main window)
  newWindow.on('close', (event) => {
    if (isMainWindow) saveWindowState();
  });

  newWindow.on('closed', () => {
    // Remove from allWindows array
    const index = allWindows.indexOf(newWindow);
    if (index > -1) {
      allWindows.splice(index, 1);
    }
    if (isMainWindow) {
      mainWindow = null;
    }
  });

  // Handle navigation
  newWindow.webContents.on('will-navigate', (event, url) => {
    // Allow navigation within the app
    const appUrl = isDev ? 'http://localhost:5173' : 'file://';
    if (!url.startsWith(appUrl) && !url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // Track window
  allWindows.push(newWindow);
  if (isMainWindow) {
    mainWindow = newWindow;
  }

  return newWindow;
}

function createTray() {
  // Create tray icon (optional - uncomment to enable)
  /*
  const iconPath = path.join(__dirname, '../public/favicon.ico');
  tray = new Tray(iconPath);
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show InfiniBot', click: () => mainWindow?.show() },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);
  
  tray.setToolTip('InfiniBot');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
    }
  });
  */
}

function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ============================================================
// App Lifecycle
// ============================================================

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, focus our window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  const { session } = require('electron');
  
  // Grant permissions for microphone (needed for wake word / speech recognition)
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowedPermissions = ['media', 'microphone', 'audioCapture'];
    if (allowedPermissions.includes(permission)) {
      console.log('[Electron] Granting permission:', permission);
      callback(true);
    } else {
      console.log('[Electron] Denying permission:', permission);
      callback(false);
    }
  });

  // Also handle permission checks (for already-granted permissions)
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    const allowedPermissions = ['media', 'microphone', 'audioCapture'];
    return allowedPermissions.includes(permission);
  });

  createMenu();
  createWindow();
  createTray();

  app.on('activate', () => {
    // macOS: re-create window when dock icon clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow?.show();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  saveWindowState();
});

// ============================================================
// IPC Handlers (for future native features)
// ============================================================

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// STT Server configuration
const STT_URL = process.env.INFINIBOT_STT_URL || 'http://localhost:8765/api/stt';

ipcMain.handle('get-gateway-info', () => {
  return {
    host: GATEWAY_HOST,
    port: GATEWAY_PORT,
    url: `ws://${GATEWAY_HOST}:${GATEWAY_PORT}`,
    httpUrl: `http://${GATEWAY_HOST}:${GATEWAY_PORT}`,
    password: GATEWAY_PASSWORD,
    sttUrl: STT_URL,
  };
});

ipcMain.handle('show-notification', (event, { title, body }) => {
  const { Notification } = require('electron');
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
});

ipcMain.handle('create-new-window', () => {
  const newWindow = createWindow(false);
  return { success: true, windowCount: allWindows.length };
});

ipcMain.handle('get-window-count', () => {
  return allWindows.length;
});

// Handle certificate errors for self-signed certs (local gateway)
app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  console.log('[Electron] Certificate error for URL:', url);
  // Allow self-signed certs for local gateway
  if (url.includes('127.0.0.1') || url.includes('localhost') || url.includes(GATEWAY_HOST)) {
    console.log('[Electron] Allowing self-signed cert');
    event.preventDefault();
    callback(true);
  } else {
    console.log('[Electron] Rejecting cert for:', url);
    callback(false);
  }
});

// Ignore certificate errors globally for WebSocket connections
app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-insecure-localhost');

// Enable features for speech recognition
app.commandLine.appendSwitch('enable-speech-input');
app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
app.commandLine.appendSwitch('auto-accept-camera-and-microphone-capture');

console.log('[Electron] InfiniBot starting...');
console.log('[Electron] Dev mode:', isDev);
console.log('[Electron] User data:', app.getPath('userData'));
console.log('[Electron] Gateway:', `https://${GATEWAY_HOST}:${GATEWAY_PORT}`);

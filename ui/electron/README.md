# InfiniBot Electron Desktop App

This is the Electron wrapper for the InfiniBot Control UI.

## Quick Start

### Run the Desktop App (uses built UI)
```bash
cd ui
InfiniBot.bat
```
Or:
```bash
npm run electron:start
```

### Development Mode (with hot reload)
```bash
npm run electron:dev
```
This runs Vite dev server + Electron with hot reload.

### Build Installer
```bash
# Build for Windows
npm run electron:build:win

# Output: ui/dist-electron/InfiniBot-1.0.0-x64.exe (installer)
# Output: ui/dist-electron/InfiniBot-1.0.0-x64-portable.exe
```

## Files

```
ui/
├── electron/
│   ├── main.cjs      # Main process (window management, IPC)
│   ├── preload.cjs   # Preload script (secure bridge)
│   └── README.md     # This file
├── InfiniBot.bat       # Quick launcher
├── dist/control-ui/  # Built web UI (loaded by Electron)
└── dist-electron/    # Built Electron installers
```

## Features

- ✅ Loads existing built web UI (no server needed)
- ✅ Single instance lock (only one window)
- ✅ Window state persistence (size, position)
- ✅ Self-signed cert support (local gateway)
- ✅ Native menus (File, Edit, View, Window)
- ✅ External links open in browser
- ✅ DevTools available (Ctrl+Shift+I or View menu)

## Requirements

- Node.js 18+
- Electron (globally installed): `npm install -g electron`
- Built UI: `npm run build` in ui folder

## Troubleshooting

### "electron not found"
Install globally: `npm install -g electron`

### Black screen
1. Make sure UI is built: `npm run build`
2. Check DevTools console (Ctrl+Shift+I)

### Can't connect to gateway
1. Make sure gateway is running: `infinibot gateway status`
2. Gateway runs on https://127.0.0.1:47913 by default

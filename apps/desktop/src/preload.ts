import { contextBridge, ipcRenderer } from "electron";

// ─── Gateway control bridge ───────────────────────────────────────────────────

contextBridge.exposeInMainWorld("gatewayBridge", {
  // Status / control
  start: () => ipcRenderer.invoke("gateway:start"),
  stop: () => ipcRenderer.invoke("gateway:stop"),
  status: () => ipcRenderer.invoke("gateway:status"),
  url: (): Promise<string> => ipcRenderer.invoke("gateway:url"),

  // Events
  onLog: (
    cb: (entry: { type: string; message: string }) => void,
  ) => {
    const handler = (_: Electron.IpcRendererEvent, data: { type: string; message: string }) =>
      cb(data);
    ipcRenderer.on("gateway-log", handler);
    return () => ipcRenderer.removeListener("gateway-log", handler);
  },

  onFatal: (cb: (info: { code: number | null; signal: string | null }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, info: { code: number | null; signal: string | null }) => cb(info);
    ipcRenderer.on("gateway-fatal", handler);
    return () => ipcRenderer.removeListener("gateway-fatal", handler);
  },

  onDeepLink: (cb: (url: string) => void) => {
    const handler = (_: Electron.IpcRendererEvent, url: string) => cb(url);
    ipcRenderer.on("deep-link", handler);
    return () => ipcRenderer.removeListener("deep-link", handler);
  },
});

// ─── First-run wizard bridge ──────────────────────────────────────────────────

contextBridge.exposeInMainWorld("firstRunBridge", {
  complete: () => ipcRenderer.invoke("firstrun:complete"),
});

// ─── Update bridge ────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld("updateBridge", {
  check: () => ipcRenderer.invoke("update:check"),
  install: () => ipcRenderer.invoke("update:install"),

  onAvailable: (cb: (info: unknown) => void) => {
    const handler = (_: Electron.IpcRendererEvent, info: unknown) => cb(info);
    ipcRenderer.on("update-available", handler);
    return () => ipcRenderer.removeListener("update-available", handler);
  },

  onReady: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on("update-ready", handler);
    return () => ipcRenderer.removeListener("update-ready", handler);
  },
});

// ─── Shell / utility bridge ───────────────────────────────────────────────────

contextBridge.exposeInMainWorld("shellBridge", {
  openLogs: () => ipcRenderer.invoke("shell:openLogs"),
  showError: (title: string, content: string) =>
    ipcRenderer.invoke("dialog:showError", title, content),
  showWindow: () => ipcRenderer.invoke("window:show"),
  hideWindow: () => ipcRenderer.invoke("window:hide"),
});

// ─── Platform info (read-only) ────────────────────────────────────────────────

contextBridge.exposeInMainWorld("platform", {
  os: process.platform,
  arch: process.arch,
  version: process.versions.electron,
});

/**
 * Hyprland world state.
 *
 * Single long-lived subscriber to `.socket2.sock` that maintains an
 * in-memory snapshot of monitors, workspaces, windows, focus, and history.
 * Tools read from this cache without round-tripping hyprctl on every call.
 *
 * On startup we hyprctl-seed the snapshot, then keep it current via the event
 * stream. If the stream drops we re-seed and reconnect with backoff so the
 * cache never silently goes stale.
 */

import { EventEmitter } from "node:events";

import {
  HyprEventStream,
  type HyprMonitor,
  type HyprWindow,
  type HyprWorkspace,
  listClients,
  listMonitors,
  listWorkspaces,
  subscribe,
} from "./ipc.js";

export interface WorldState {
  monitors: HyprMonitor[];
  workspaces: HyprWorkspace[];
  windows: HyprWindow[];
  activeWindowAddress: string | null;
  activeWorkspaceId: number | null;
  focusedMonitorName: string | null;
  /** Most-recently focused window addresses, newest first, max 50 entries. */
  recentWindows: string[];
  lastUpdatedMs: number;
}

const RECENT_LIMIT = 50;

export class HyprlandWorld extends EventEmitter {
  private state: WorldState = emptyState();
  private stream: HyprEventStream | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelayMs = 500;
  private started = false;
  private stopped = false;

  snapshot(): WorldState {
    return {
      ...this.state,
      monitors: [...this.state.monitors],
      workspaces: [...this.state.workspaces],
      windows: [...this.state.windows],
      recentWindows: [...this.state.recentWindows],
    };
  }

  findWindow(selector: WindowSelector): HyprWindow | undefined {
    const ws = this.state.windows;
    if (selector.address) {
      const addr = normalizeAddress(selector.address);
      return ws.find((w) => normalizeAddress(w.address) === addr);
    }
    if (typeof selector.pid === "number") {
      return ws.find((w) => w.pid === selector.pid);
    }
    if (selector.classExact) {
      return ws.find((w) => w.class === selector.classExact);
    }
    if (selector.classRegex) {
      const re = toRegex(selector.classRegex);
      return ws.find((w) => re.test(w.class));
    }
    if (selector.titleRegex) {
      const re = toRegex(selector.titleRegex);
      return ws.find((w) => re.test(w.title));
    }
    if (selector.titleContains) {
      const needle = selector.titleContains.toLowerCase();
      return ws.find((w) => w.title.toLowerCase().includes(needle));
    }
    if (selector.activeWindow) {
      const addr = this.state.activeWindowAddress;
      if (!addr) return undefined;
      return ws.find((w) => normalizeAddress(w.address) === addr);
    }
    return undefined;
  }

  findWindows(selector: WindowSelector): HyprWindow[] {
    const ws = this.state.windows;
    return ws.filter((w) => matchWindow(w, selector, this.state.activeWindowAddress));
  }

  findMonitor(selector: { id?: number; name?: string; index?: number }): HyprMonitor | undefined {
    if (typeof selector.id === "number") {
      return this.state.monitors.find((m) => m.id === selector.id);
    }
    if (typeof selector.name === "string") {
      return this.state.monitors.find((m) => m.name === selector.name);
    }
    if (typeof selector.index === "number") {
      return this.state.monitors[selector.index];
    }
    return undefined;
  }

  /**
   * Resolve a display index to a Hyprland monitor. Index matches Hyprland's
   * native monitor id (0-based), which is also what hyprctl and waybar
   * surface to the user. So display=0 → first monitor, display=1 → second, etc.
   */
  monitorByDisplayIndex(displayIdx: number): HyprMonitor | undefined {
    if (!Number.isFinite(displayIdx) || displayIdx < 0) return undefined;
    return this.state.monitors.find((m) => m.id === displayIdx);
  }

  primaryMonitor(): HyprMonitor | undefined {
    return (
      this.state.monitors.find((m) => m.focused) ??
      this.state.monitors.find((m) => m.id === 0) ??
      this.state.monitors[0]
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    await this.refreshAll();
    await this.connectStream();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.stream) {
      this.stream.close();
      this.stream = undefined;
    }
  }

  async refreshAll(): Promise<void> {
    try {
      const [monitors, workspaces, windows] = await Promise.all([
        listMonitors(),
        listWorkspaces(),
        listClients(),
      ]);
      const focused = monitors.find((m) => m.focused);
      const activeWorkspaceId = focused?.activeWorkspace?.id ?? null;
      const focusedAddr =
        windows.find(
          (w) => focused && w.workspace.id === activeWorkspaceId && w.focusHistoryID === 0,
        )?.address ?? null;
      this.state = {
        monitors,
        workspaces,
        windows,
        activeWindowAddress: focusedAddr ? normalizeAddress(focusedAddr) : null,
        activeWorkspaceId,
        focusedMonitorName: focused?.name ?? null,
        recentWindows: this.state.recentWindows,
        lastUpdatedMs: Date.now(),
      };
      this.emit("refresh", this.state);
    } catch (err) {
      this.emit("error", err);
    }
  }

  private async connectStream(): Promise<void> {
    if (this.stopped) return;
    try {
      const stream = await subscribe();
      this.stream = stream;
      this.reconnectDelayMs = 500;
      stream.on("error", (err) => {
        this.emit("stream-error", err);
      });
      stream.on("close", () => {
        this.stream = undefined;
        if (!this.stopped) this.scheduleReconnect();
      });
      stream.on("event", () => {
        this.state.lastUpdatedMs = Date.now();
      });
      stream.on("openwindow", (args) => this.handleOpenWindow(args));
      stream.on("closewindow", (args) => this.handleCloseWindow(args));
      stream.on("movewindow", (args) => this.handleMoveWindow(args));
      stream.on("movewindowv2", (args) => this.handleMoveWindow(args));
      stream.on("activewindow", () => {
        /* args is "class,title"; we re-fetch to get address */
        this.refreshActiveWindow().catch(() => {});
      });
      stream.on("activewindowv2", (args) => {
        if (args[0]) {
          const addr = normalizeAddress(args[0]);
          this.state.activeWindowAddress = addr;
          this.recordRecent(addr);
          this.emit("active-window-change", addr);
        }
      });
      stream.on("workspace", () => this.refreshAll().catch(() => {}));
      stream.on("workspacev2", () => this.refreshAll().catch(() => {}));
      stream.on("focusedmon", () => this.refreshAll().catch(() => {}));
      stream.on("focusedmonv2", () => this.refreshAll().catch(() => {}));
      stream.on("monitoradded", () => this.refreshAll().catch(() => {}));
      stream.on("monitorremoved", () => this.refreshAll().catch(() => {}));
      stream.on("windowtitle", () => this.refreshClients().catch(() => {}));
      stream.on("windowtitlev2", (args) => {
        if (args[0] && args[1]) {
          const addr = normalizeAddress(args[0]);
          const w = this.state.windows.find((win) => normalizeAddress(win.address) === addr);
          if (w) w.title = args[1];
        }
      });
      stream.on("fullscreen", () => this.refreshClients().catch(() => {}));
    } catch (err) {
      this.emit("stream-error", err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(this.reconnectDelayMs, 30_000);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectStream().catch(() => {});
    }, delay);
  }

  private async refreshClients(): Promise<void> {
    try {
      const windows = await listClients();
      this.state.windows = windows;
      this.state.lastUpdatedMs = Date.now();
    } catch (err) {
      this.emit("error", err);
    }
  }

  private async refreshActiveWindow(): Promise<void> {
    try {
      const windows = await listClients();
      this.state.windows = windows;
      const focused = windows.find((w) => w.focusHistoryID === 0);
      if (focused) {
        const addr = normalizeAddress(focused.address);
        this.state.activeWindowAddress = addr;
        this.recordRecent(addr);
        this.emit("active-window-change", addr);
      }
    } catch (err) {
      this.emit("error", err);
    }
  }

  private handleOpenWindow(args: string[]) {
    // openwindow>>ADDR,WORKSPACE,CLASS,TITLE
    if (!args[0]) return;
    const addr = normalizeAddress(args[0]);
    // We don't have full geometry yet — refresh to capture it.
    this.refreshClients()
      .then(() => {
        this.emit("window-opened", addr);
      })
      .catch(() => {});
  }

  private handleCloseWindow(args: string[]) {
    if (!args[0]) return;
    const addr = normalizeAddress(args[0]);
    this.state.windows = this.state.windows.filter((w) => normalizeAddress(w.address) !== addr);
    this.state.recentWindows = this.state.recentWindows.filter((a) => a !== addr);
    if (this.state.activeWindowAddress === addr) {
      this.state.activeWindowAddress = null;
    }
    this.emit("window-closed", addr);
  }

  private handleMoveWindow(args: string[]) {
    if (!args[0]) return;
    const addr = normalizeAddress(args[0]);
    this.refreshClients()
      .then(() => {
        this.emit("window-moved", addr);
      })
      .catch(() => {});
  }

  private recordRecent(address: string) {
    const addr = normalizeAddress(address);
    const list = this.state.recentWindows.filter((a) => a !== addr);
    list.unshift(addr);
    if (list.length > RECENT_LIMIT) list.length = RECENT_LIMIT;
    this.state.recentWindows = list;
  }
}

export interface WindowSelector {
  address?: string;
  pid?: number;
  classExact?: string;
  classRegex?: string;
  titleContains?: string;
  titleRegex?: string;
  activeWindow?: boolean;
}

function matchWindow(w: HyprWindow, selector: WindowSelector, activeAddr: string | null): boolean {
  if (selector.address) {
    return normalizeAddress(w.address) === normalizeAddress(selector.address);
  }
  if (typeof selector.pid === "number") return w.pid === selector.pid;
  if (selector.classExact) return w.class === selector.classExact;
  if (selector.classRegex) return toRegex(selector.classRegex).test(w.class);
  if (selector.titleRegex) return toRegex(selector.titleRegex).test(w.title);
  if (selector.titleContains) {
    return w.title.toLowerCase().includes(selector.titleContains.toLowerCase());
  }
  if (selector.activeWindow && activeAddr) {
    return normalizeAddress(w.address) === activeAddr;
  }
  return false;
}

function emptyState(): WorldState {
  return {
    monitors: [],
    workspaces: [],
    windows: [],
    activeWindowAddress: null,
    activeWorkspaceId: null,
    focusedMonitorName: null,
    recentWindows: [],
    lastUpdatedMs: 0,
  };
}

export function normalizeAddress(addr: string): string {
  if (!addr) return addr;
  const trimmed = addr.trim();
  if (trimmed.startsWith("0x")) return trimmed.toLowerCase();
  return `0x${trimmed.toLowerCase()}`;
}

function toRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
}

let sharedWorld: HyprlandWorld | undefined;

export async function getSharedWorld(): Promise<HyprlandWorld> {
  if (!sharedWorld) {
    sharedWorld = new HyprlandWorld();
    await sharedWorld.start();
  }
  return sharedWorld;
}

export async function disposeSharedWorld(): Promise<void> {
  if (sharedWorld) {
    await sharedWorld.stop();
    sharedWorld = undefined;
  }
}

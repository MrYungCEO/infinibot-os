/**
 * Live browser viewer: streams one tab of the workspace's Chrome to the control
 * UI over the gateway WebSocket and forwards the user's mouse and keyboard.
 *
 * It attaches to the SAME Chrome process and profile the agents' browser tool
 * drives (one more CDP client on the loopback debugging port), so:
 *   - what the user signs into here, the agent is signed into;
 *   - while an agent works, the user watches it live and can take over just by
 *     clicking or typing.
 * Transport is CDP screencast (JPEG frames on repaint) + Input.dispatch*: no X
 * server, no VNC, no extra port — frames ride the already-authenticated
 * gateway socket and are delivered only to the connections that subscribed
 * (the RPC layer checks owner/admin before subscribing a connection).
 *
 * Tabs are the plan's "browser sessions" (src/browser/hosted.ts). The viewer
 * is a window onto them, not a session of its own: watching costs nothing
 * against the cap, a tab opened from the panel counts exactly like one an
 * agent opened, and a popup a page opens itself (an OAuth window) is admitted
 * — refusing it would break sign-in — and counts while it is open.
 */
import type { CdpConnection, CdpEvent } from "./cdp-connection.js";
import { viewerInputToCdp, type ViewerViewport } from "./input.js";
import { toText } from "../../utils/to-text.js";

export type ViewerTab = { targetId: string; title: string; url: string; openerId?: string };

export type ViewerState = {
  connected: boolean;
  activeTargetId: string | null;
  tabs: ViewerTab[];
  viewport: ViewerViewport;
  layout: ViewerLayout;
  dialog: { type: string; message: string } | null;
  /** Browser profile on screen ("default", "work"…). */
  profile: string;
  /** Last thing an agent did in this browser (the panel shows "Agent is driving"). */
  agent: ViewerAgentActivity | null;
};

export type ViewerAgentActivity = { profile: string; url: string; action: string; at: number };

export type ViewerLayout = "desktop" | "phone";

export type ViewerEmit = (connIds: ReadonlySet<string>, event: string, payload: unknown) => void;

export type BrowserViewerDeps = {
  /** Make sure Chrome is running and return its browser-level CDP WebSocket URL. */
  resolveBrowserWsUrl: () => Promise<string>;
  connect: (wsUrl: string) => Promise<CdpConnection>;
  emit: ViewerEmit;
  now?: () => number;
};

export const VIEWER_FRAME_EVENT = "browser.viewer.frame";
export const VIEWER_STATE_EVENT = "browser.viewer.state";

/** Frames a subscriber may have un-acked before it stops being sent more. */
const MAX_INFLIGHT = 2;
/** ~12 fps ceiling: an animating page must not flood the gateway socket. */
const MIN_FRAME_INTERVAL_MS = 80;
/** A subscriber that hasn't acked or sent anything for this long is gone. */
const SUBSCRIBER_TTL_MS = 35_000;
const PHONE_METRICS = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

type Subscriber = { inflight: number; lastSeen: number };

export class BrowserViewer {
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly targets = new Map<string, ViewerTab>();
  private conn: CdpConnection | null = null;
  private connecting: Promise<CdpConnection> | null = null;
  private activeTargetId: string | null = null;
  private activeSessionId: string | null = null;
  private attaching: Promise<void> = Promise.resolve();
  private discovered = false;
  private viewport: ViewerViewport = { width: 1280, height: 800 };
  private layout: ViewerLayout = "desktop";
  private dialog: ViewerState["dialog"] = null;
  private agent: ViewerAgentActivity | null = null;
  private profileName = "default";
  private frameSeq = 0;
  private lastFrameAt = 0;
  private pendingAck: { sessionId: string; ackId: number; timer: NodeJS.Timeout } | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: BrowserViewerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  isSubscribed(connId: string): boolean {
    return this.subscribers.has(connId);
  }

  state(): ViewerState {
    return {
      connected: Boolean(this.conn && !this.conn.isClosed),
      activeTargetId: this.activeTargetId,
      tabs: [...this.targets.values()],
      viewport: this.viewport,
      layout: this.layout,
      dialog: this.dialog,
      profile: this.profileName,
      agent: this.agent,
    };
  }

  // ── subscription ──────────────────────────────────────────────────────────

  async subscribe(connId: string, opts: { targetId?: string } = {}): Promise<ViewerState> {
    this.subscribers.set(connId, { inflight: 0, lastSeen: this.now() });
    this.ensurePruneTimer();
    try {
      await this.ensureConnected();
      const wanted =
        opts.targetId && this.targets.has(opts.targetId)
          ? opts.targetId
          : (this.activeTargetId ?? this.pickTarget());
      if (wanted) {
        if (wanted !== this.activeTargetId || !this.activeSessionId) await this.attach(wanted);
        // A page that isn't repainting sends no frames: restart so the new
        // subscriber gets one now.
        else await this.restartScreencast();
      }
    } catch (err) {
      this.unsubscribe(connId);
      throw err;
    }
    return this.state();
  }

  unsubscribe(connId: string): void {
    if (!this.subscribers.delete(connId)) return;
    if (this.subscribers.size === 0) void this.teardown();
  }

  /** The client received a frame (or is just saying it is still there). */
  ack(connId: string): void {
    const sub = this.subscribers.get(connId);
    if (!sub) return;
    sub.inflight = 0;
    sub.lastSeen = this.now();
    this.flushPendingAck();
  }

  private touch(connId: string): void {
    const sub = this.subscribers.get(connId);
    if (sub) sub.lastSeen = this.now();
  }

  private ensurePruneTimer(): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setInterval(() => {
      const cutoff = this.now() - SUBSCRIBER_TTL_MS;
      for (const [id, sub] of this.subscribers) {
        if (sub.lastSeen < cutoff) this.unsubscribe(id);
      }
    }, 10_000);
    this.pruneTimer.unref?.();
  }

  private async teardown(): Promise<void> {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = null;
    if (this.pendingAck) clearTimeout(this.pendingAck.timer);
    this.pendingAck = null;
    const conn = this.conn;
    const sessionId = this.activeSessionId;
    this.conn = null;
    this.connecting = null;
    this.activeSessionId = null;
    this.activeTargetId = null;
    this.discovered = false;
    this.targets.clear();
    this.dialog = null;
    this.layout = "desktop";
    if (!conn || conn.isClosed) return;
    // Leave the page as the agent expects it: no screencast, no emulation.
    if (sessionId) {
      await conn.send("Page.stopScreencast", {}, sessionId).catch(() => {});
      await conn.send("Emulation.clearDeviceMetricsOverride", {}, sessionId).catch(() => {});
    }
    conn.close();
  }

  // ── CDP connection + targets ──────────────────────────────────────────────

  private ensureConnected(): Promise<CdpConnection> {
    if (this.conn && !this.conn.isClosed) return Promise.resolve(this.conn);
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const wsUrl = await this.deps.resolveBrowserWsUrl();
      const conn = await this.deps.connect(wsUrl);
      this.conn = conn;
      this.targets.clear();
      this.discovered = false;
      conn.onEvent((evt) => this.onCdpEvent(conn, evt));
      conn.onceClosed(() => {
        if (this.conn !== conn) return;
        this.conn = null;
        this.connecting = null;
        this.activeSessionId = null;
        this.activeTargetId = null;
        this.targets.clear();
        this.emitStateSoon();
      });
      // Existing targets arrive as targetCreated events before this resolves.
      await conn.send("Target.setDiscoverTargets", { discover: true });
      this.discovered = true;
      return conn;
    })();
    this.connecting.catch(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private pickTarget(): string | null {
    const tabs = [...this.targets.values()];
    return (tabs.find((t) => t.url !== "about:blank") ?? tabs[0])?.targetId ?? null;
  }

  private onCdpEvent(conn: CdpConnection, evt: CdpEvent): void {
    if (conn !== this.conn) return;
    switch (evt.method) {
      case "Target.targetCreated":
      case "Target.targetInfoChanged": {
        const info = evt.params.targetInfo as
          | { targetId?: string; type?: string; title?: string; url?: string; openerId?: string }
          | undefined;
        if (!info?.targetId || info.type !== "page") return;
        // DevTools front-ends and extension pages are not user tabs.
        if (/^(devtools|chrome-extension):/.test(info.url ?? "")) return;
        const isNew = !this.targets.has(info.targetId);
        this.targets.set(info.targetId, {
          targetId: info.targetId,
          title: info.title ?? "",
          url: info.url ?? "",
          ...(info.openerId ? { openerId: info.openerId } : {}),
        });
        // Follow new tabs: a popup the page opened (OAuth) or a tab the agent
        // just opened is what the user wants to be looking at.
        if (isNew && this.discovered && evt.method === "Target.targetCreated") {
          void this.attach(info.targetId).catch(() => {});
        }
        this.emitStateSoon();
        return;
      }
      case "Target.targetDestroyed": {
        const targetId = evt.params.targetId as string | undefined;
        if (!targetId) return;
        const gone = this.targets.get(targetId);
        if (!this.targets.delete(targetId)) return;
        if (targetId === this.activeTargetId) {
          this.activeTargetId = null;
          this.activeSessionId = null;
          const next =
            gone?.openerId && this.targets.has(gone.openerId) ? gone.openerId : this.pickTarget();
          if (next) void this.attach(next).catch(() => {});
        }
        this.emitStateSoon();
        return;
      }
      case "Page.screencastFrame":
        if (evt.sessionId && evt.sessionId === this.activeSessionId) this.onFrame(evt);
        return;
      case "Page.javascriptDialogOpening":
        if (evt.sessionId !== this.activeSessionId) return;
        this.dialog = {
          type: toText(evt.params.type ?? "alert"),
          message: toText(evt.params.message ?? "").slice(0, 2000),
        };
        this.emitStateSoon();
        return;
      case "Page.javascriptDialogClosed":
        if (evt.sessionId !== this.activeSessionId) return;
        this.dialog = null;
        this.emitStateSoon();
        return;
      default:
        return;
    }
  }

  /** Switch the stream to `targetId` (serialized: attaches never interleave). */
  private attach(targetId: string): Promise<void> {
    const run = async () => {
      const conn = await this.ensureConnected();
      if (targetId === this.activeTargetId && this.activeSessionId) return;
      if (!this.targets.has(targetId)) throw new Error("That tab is no longer open.");
      const previous = this.activeSessionId;
      if (previous) {
        await conn.send("Page.stopScreencast", {}, previous).catch(() => {});
        await conn.send("Emulation.clearDeviceMetricsOverride", {}, previous).catch(() => {});
        await conn.send("Target.detachFromTarget", { sessionId: previous }).catch(() => {});
      }
      if (this.pendingAck) clearTimeout(this.pendingAck.timer);
      this.pendingAck = null;
      this.dialog = null;
      const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      this.activeTargetId = targetId;
      this.activeSessionId = sessionId;
      await conn.send("Page.enable", {}, sessionId);
      // Headless tabs have no OS focus; without this, typing goes nowhere.
      await conn
        .send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId)
        .catch(() => {});
      await conn.send("Page.bringToFront", {}, sessionId).catch(() => {});
      if (this.layout === "phone") {
        await conn
          .send("Emulation.setDeviceMetricsOverride", PHONE_METRICS, sessionId)
          .catch(() => {});
      }
      await this.startScreencast(conn, sessionId);
      this.emitStateSoon();
    };
    const next = this.attaching.then(run, run);
    this.attaching = next.catch(() => {});
    return next;
  }

  private async startScreencast(conn: CdpConnection, sessionId: string): Promise<void> {
    for (const sub of this.subscribers.values()) sub.inflight = 0;
    await conn.send(
      "Page.startScreencast",
      { format: "jpeg", quality: 60, maxWidth: 1600, maxHeight: 1600, everyNthFrame: 1 },
      sessionId,
    );
  }

  private async restartScreencast(): Promise<void> {
    const conn = this.conn;
    const sessionId = this.activeSessionId;
    if (!conn || !sessionId) return;
    await conn.send("Page.stopScreencast", {}, sessionId).catch(() => {});
    await this.startScreencast(conn, sessionId);
  }

  // ── frames ────────────────────────────────────────────────────────────────

  private onFrame(evt: CdpEvent): void {
    const data = evt.params.data;
    const ackId = evt.params.sessionId;
    const sessionId = evt.sessionId;
    if (typeof data !== "string" || typeof ackId !== "number" || !sessionId) return;
    const meta = (evt.params.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number };
    if (meta.deviceWidth && meta.deviceHeight) {
      const next = { width: Math.round(meta.deviceWidth), height: Math.round(meta.deviceHeight) };
      if (next.width !== this.viewport.width || next.height !== this.viewport.height) {
        this.viewport = next;
        this.emitStateSoon();
      }
    }
    const ready = new Set<string>();
    for (const [id, sub] of this.subscribers) {
      if (sub.inflight < MAX_INFLIGHT) {
        sub.inflight += 1;
        ready.add(id);
      }
    }
    if (ready.size > 0) {
      this.deps.emit(ready, VIEWER_FRAME_EVENT, {
        seq: ++this.frameSeq,
        targetId: this.activeTargetId,
        data,
        width: this.viewport.width,
        height: this.viewport.height,
      });
    }
    // Chrome sends the next frame only after this one is acked: that is the
    // throttle. Ack on a ≥80 ms cadence while someone can take frames;
    // otherwise hold it until a subscriber acks (2 s fallback so a stalled
    // tab of the control UI can't freeze the stream for the others).
    const now = this.now();
    const wait = Math.max(0, MIN_FRAME_INTERVAL_MS - (now - this.lastFrameAt));
    this.lastFrameAt = now;
    const backlogged = [...this.subscribers.values()].every((s) => s.inflight >= MAX_INFLIGHT);
    if (this.pendingAck) clearTimeout(this.pendingAck.timer);
    const timer = setTimeout(() => this.flushPendingAck(true), backlogged ? 2000 : wait);
    timer.unref?.();
    this.pendingAck = { sessionId, ackId, timer };
  }

  private flushPendingAck(fromTimer = false): void {
    const pending = this.pendingAck;
    if (!pending) return;
    if (!fromTimer) {
      // A subscriber just caught up: respect the frame-rate ceiling.
      const wait = MIN_FRAME_INTERVAL_MS - (this.now() - this.lastFrameAt);
      if (wait > 0) {
        clearTimeout(pending.timer);
        pending.timer = setTimeout(() => this.flushPendingAck(true), wait);
        pending.timer.unref?.();
        return;
      }
    }
    clearTimeout(pending.timer);
    this.pendingAck = null;
    void this.conn
      ?.send("Page.screencastFrameAck", { sessionId: pending.ackId }, pending.sessionId)
      .catch(() => {});
  }

  private emitStateSoon(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      if (this.subscribers.size === 0) return;
      this.deps.emit(new Set(this.subscribers.keys()), VIEWER_STATE_EVENT, this.state());
    }, 50);
    this.stateTimer.unref?.();
  }

  // ── user actions ──────────────────────────────────────────────────────────

  private session(connId: string): { conn: CdpConnection; sessionId: string } {
    if (!this.subscribers.has(connId)) throw new Error("Open the live browser first.");
    this.touch(connId);
    if (!this.conn || this.conn.isClosed || !this.activeSessionId) {
      throw new Error("The browser is not running. Reopen the live browser.");
    }
    return { conn: this.conn, sessionId: this.activeSessionId };
  }

  async input(connId: string, event: unknown): Promise<void> {
    const { conn, sessionId } = this.session(connId);
    const mapped = viewerInputToCdp(event, this.viewport);
    if (!mapped.ok) throw new Error(mapped.error);
    for (const cmd of mapped.commands) await conn.send(cmd.method, cmd.params, sessionId);
  }

  async navigate(
    connId: string,
    action: "goto" | "back" | "forward" | "reload" | "stop",
    url?: string,
  ): Promise<void> {
    const { conn, sessionId } = this.session(connId);
    if (action === "goto") {
      if (!url) throw new Error("url required");
      const res = await conn.send<{ errorText?: string }>("Page.navigate", { url }, sessionId);
      if (res.errorText && res.errorText !== "net::ERR_ABORTED") throw new Error(res.errorText);
      return;
    }
    if (action === "reload") {
      await conn.send("Page.reload", {}, sessionId);
      return;
    }
    if (action === "stop") {
      await conn.send("Page.stopLoading", {}, sessionId);
      return;
    }
    const history = await conn.send<{ currentIndex: number; entries: Array<{ id: number }> }>(
      "Page.getNavigationHistory",
      {},
      sessionId,
    );
    const entry = history.entries[history.currentIndex + (action === "back" ? -1 : 1)];
    if (entry) await conn.send("Page.navigateToHistoryEntry", { entryId: entry.id }, sessionId);
  }

  async selectTab(connId: string, targetId: string): Promise<void> {
    if (!this.subscribers.has(connId)) throw new Error("Open the live browser first.");
    this.touch(connId);
    await this.attach(targetId);
  }

  async closeTab(connId: string, targetId: string): Promise<void> {
    if (!this.subscribers.has(connId)) throw new Error("Open the live browser first.");
    this.touch(connId);
    const conn = await this.ensureConnected();
    await conn.send("Target.closeTarget", { targetId });
  }

  async setLayout(connId: string, layout: ViewerLayout): Promise<void> {
    const { conn, sessionId } = this.session(connId);
    this.layout = layout;
    if (layout === "phone") {
      await conn.send("Emulation.setDeviceMetricsOverride", PHONE_METRICS, sessionId);
    } else {
      await conn.send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
    }
    await this.restartScreencast();
    this.emitStateSoon();
  }

  async resolveDialog(connId: string, accept: boolean, promptText?: string): Promise<void> {
    const { conn, sessionId } = this.session(connId);
    await conn.send(
      "Page.handleJavaScriptDialog",
      { accept, ...(promptText !== undefined ? { promptText } : {}) },
      sessionId,
    );
    this.dialog = null;
    this.emitStateSoon();
  }

  /** The page's current selection, for copy out of the remote browser. */
  async copySelection(connId: string): Promise<string> {
    const { conn, sessionId } = this.session(connId);
    const res = await conn.send<{ result?: { value?: unknown } }>(
      "Runtime.evaluate",
      {
        expression: `(() => { const a = document.activeElement; if (a && typeof a.selectionStart === "number" && a.type !== "password" && a.selectionEnd > a.selectionStart) return a.value.slice(a.selectionStart, a.selectionEnd); return String(window.getSelection() || ""); })()`,
        returnByValue: true,
      },
      sessionId,
    );
    const value = res.result?.value;
    return typeof value === "string" ? value.slice(0, 1_000_000) : "";
  }

  // ── following the agent ──────────────────────────────────────────────────

  /**
   * An agent acted in `targetId`: if anyone is watching, show that tab. A tab
   * the agent just created may not be discovered yet; targetCreated attaches
   * to new tabs on its own, so a miss here is fine.
   */
  async followAgent(info: {
    targetId: string | null;
    url: string;
    action: string;
    profile: string;
    at: number;
  }): Promise<void> {
    this.agent = { profile: info.profile, url: info.url, action: info.action, at: info.at };
    if (this.subscribers.size > 0 && this.conn && info.targetId) {
      if (info.targetId !== this.activeTargetId && this.targets.has(info.targetId)) {
        await this.attach(info.targetId).catch(() => {});
      }
    }
    this.emitStateSoon();
  }

  get currentProfile(): string {
    return this.profileName;
  }

  /**
   * Point the viewer at another profile's browser (the caller swaps what
   * resolveBrowserWsUrl returns first). Subscribers stay subscribed.
   */
  async switchProfile(profile: string, targetId?: string | null): Promise<void> {
    if (profile === this.profileName && this.conn && !this.conn.isClosed) return;
    const subs = new Map(this.subscribers);
    await this.teardown();
    this.profileName = profile;
    for (const [id, sub] of subs) this.subscribers.set(id, sub);
    if (this.subscribers.size === 0) return;
    this.ensurePruneTimer();
    await this.ensureConnected();
    const wanted = targetId && this.targets.has(targetId) ? targetId : this.pickTarget();
    if (wanted) await this.attach(wanted);
    this.emitStateSoon();
  }

  /** Stop streaming and drop every subscriber (gateway shutdown). */
  async shutdown(): Promise<void> {
    this.subscribers.clear();
    await this.teardown();
  }
}

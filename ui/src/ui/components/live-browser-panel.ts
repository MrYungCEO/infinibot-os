/**
 * <live-browser-panel> — the workspace's Chrome, live.
 *
 * Streams one tab of the gateway's browser (the same Chrome and profile the
 * agents' browser tool drives) and forwards mouse, keyboard, touch and paste,
 * so the owner can sign in to sites and watch — or take over from — an agent.
 * Gateway side: browser.viewer.* (src/gateway/server-methods/browser-viewer.ts).
 *
 * Frames arrive as gateway events and are painted straight onto the <img>
 * (no Lit re-render per frame). A transparent <textarea> over the frame is
 * the input surface: it takes focus, raises the on-screen keyboard on phones,
 * and receives paste / IME text natively.
 */
import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";

interface MinimalClient {
  request: <T = unknown>(method: string, params?: unknown) => Promise<T>;
}

type ViewerTab = { targetId: string; title: string; url: string };

type ViewerState = {
  connected: boolean;
  activeTargetId: string | null;
  tabs: ViewerTab[];
  viewport: { width: number; height: number };
  layout: "desktop" | "phone";
  dialog: { type: string; message: string } | null;
  /** Browser profile on screen ("default" = the agents' shared browser). */
  profile?: string;
  /** Last agent action in this browser; the panel follows the agent's tab. */
  agent?: { profile: string; url: string; action: string; at: number } | null;
  cap?: number | null;
  sessions?: number;
};

type ViewerStatus = { available: boolean; reason?: string; hosted?: boolean };

/** Window event the gateway event pump re-dispatches viewer events on. */
export const LIVE_BROWSER_EVENT = "infinibot:browser-viewer";

type InputEvent_ = Record<string, unknown>;

function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

@customElement("live-browser-panel")
export class LiveBrowserPanel extends LitElement {
  @property({ attribute: false }) client: MinimalClient | null = null;

  @state() private status: ViewerStatus | null = null;
  @state() private view: ViewerState | null = null;
  @state() private phase: "idle" | "opening" | "live" | "error" = "idle";
  @state() private error: string | null = null;
  @state() private notice: string | null = null;
  @state() private address = "";
  @state() private hasFrame = false;
  @state() private focused = false;

  private addressDirty = false;
  private queue: InputEvent_[] = [];
  private sending = false;
  private ackInFlight = false;
  private ackWanted = false;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private moveRaf = 0;
  private pendingMove: InputEvent_ | null = null;
  private touch: { id: number; x: number; y: number; moved: boolean } | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  static styles = css`
    :host {
      display: block;
      --lb-line: color-mix(in srgb, var(--g-primary, #d4af37) 16%, transparent);
      --lb-fg: var(--c-fg, #f5f5f4);
      --lb-dim: color-mix(in srgb, var(--lb-fg) 58%, transparent);
    }
    .shell {
      border: 1px solid var(--lb-line);
      border-radius: 14px;
      overflow: hidden;
      background: color-mix(in srgb, var(--g-bg, #0a0a0a) 62%, transparent);
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      padding: 12px 14px 4px;
    }
    .title {
      font-size: 15px;
      font-weight: 650;
      color: var(--lb-fg);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #6b7280;
    }
    .dot.live {
      background: #34d399;
      box-shadow: 0 0 0 3px color-mix(in srgb, #34d399 22%, transparent);
    }
    .meta {
      font-size: 12px;
      color: var(--lb-dim);
    }
    .sub {
      padding: 0 14px 10px;
      font-size: 12.5px;
      line-height: 1.5;
      color: var(--lb-dim);
      max-width: 78ch;
    }
    .tabs {
      display: flex;
      gap: 4px;
      padding: 0 10px;
      overflow-x: auto;
      scrollbar-width: thin;
    }
    .tab {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      max-width: 220px;
      padding: 7px 6px 7px 10px;
      border: 1px solid var(--lb-line);
      border-bottom: none;
      border-radius: 9px 9px 0 0;
      background: transparent;
      color: var(--lb-dim);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .tab.active {
      color: var(--lb-fg);
      background: color-mix(in srgb, var(--g-primary, #d4af37) 9%, transparent);
    }
    .tab span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      padding: 8px 10px;
      border-top: 1px solid var(--lb-line);
      border-bottom: 1px solid var(--lb-line);
    }
    .nav {
      display: flex;
      gap: 4px;
    }
    button.ic,
    button.txt {
      appearance: none;
      font: inherit;
      cursor: pointer;
      color: var(--lb-fg);
      background: transparent;
      border: 1px solid var(--lb-line);
      border-radius: 8px;
      min-width: 34px;
      height: 34px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0 8px;
      font-size: 12px;
    }
    button.ic:hover,
    button.txt:hover {
      background: color-mix(in srgb, var(--g-primary, #d4af37) 10%, transparent);
    }
    button.ic:focus-visible,
    button.txt:focus-visible,
    .tab:focus-visible,
    input:focus-visible {
      outline: 2px solid var(--g-primary, #d4af37);
      outline-offset: 1px;
    }
    button.on {
      border-color: var(--g-primary, #d4af37);
      color: var(--g-primary, #d4af37);
    }
    button.x {
      appearance: none;
      border: none;
      background: transparent;
      color: inherit;
      cursor: pointer;
      width: 22px;
      height: 22px;
      border-radius: 6px;
      font-size: 14px;
      line-height: 1;
      flex: none;
    }
    button.x:hover {
      background: color-mix(in srgb, var(--lb-fg) 14%, transparent);
    }
    svg {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    form {
      flex: 1 1 220px;
      min-width: 0;
      display: flex;
    }
    input {
      flex: 1;
      min-width: 0;
      height: 34px;
      box-sizing: border-box;
      padding: 0 12px;
      border-radius: 8px;
      border: 1px solid var(--lb-line);
      background: color-mix(in srgb, var(--g-bg, #0a0a0a) 70%, transparent);
      color: var(--lb-fg);
      font: inherit;
      font-size: 13px;
    }
    .stage {
      position: relative;
      background: #111;
      display: flex;
      justify-content: center;
    }
    .frame {
      position: relative;
    }
    img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
      user-select: none;
      -webkit-user-drag: none;
    }
    textarea.surface {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      border: none;
      resize: none;
      background: transparent;
      color: transparent;
      caret-color: transparent;
      outline: none;
      cursor: default;
      touch-action: none;
      /* 16px: iOS zooms the page when a smaller field takes focus. */
      font-size: 16px;
      opacity: 0.01;
    }
    .frame.focused {
      box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--g-primary, #d4af37) 70%, transparent);
    }
    .placeholder {
      padding: 56px 20px;
      text-align: center;
      color: var(--lb-dim);
      font-size: 13px;
      line-height: 1.6;
    }
    .placeholder strong {
      display: block;
      color: var(--lb-fg);
      font-size: 14px;
      margin-bottom: 4px;
    }
    .foot {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      padding: 8px 14px;
      font-size: 12px;
      color: var(--lb-dim);
    }
    .notice {
      color: var(--lb-fg);
    }
    .agent-strip {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 14px 8px;
      padding: 6px 10px;
      border-radius: 8px;
      font-size: 12px;
      color: var(--lb-fg);
      background: color-mix(in srgb, #d4a73a 14%, transparent);
      border: 1px solid color-mix(in srgb, #d4a73a 35%, transparent);
    }
    .agent-strip .pulse {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #f2c14e;
      box-shadow: 0 0 0 0 rgba(242, 193, 78, 0.6);
      animation: lb-pulse 1.4s ease-out infinite;
    }
    .agent-strip .url {
      color: var(--lb-dim);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      flex: 1;
    }
    .agent-strip.idle .pulse {
      animation: none;
      background: var(--lb-dim);
    }
    @keyframes lb-pulse {
      to {
        box-shadow: 0 0 0 8px rgba(242, 193, 78, 0);
      }
    }
    .dialog {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      background: rgba(0, 0, 0, 0.55);
      padding: 16px;
    }
    .dialog > div {
      max-width: 420px;
      width: 100%;
      background: #18181b;
      border: 1px solid var(--lb-line);
      border-radius: 12px;
      padding: 16px;
      color: var(--lb-fg);
      font-size: 13px;
      line-height: 1.5;
    }
    .dialog .row {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 14px;
    }
    @media (max-width: 520px) {
      .sub {
        font-size: 12px;
      }
      .tab {
        max-width: 150px;
      }
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener(LIVE_BROWSER_EVENT, this.onGatewayEvent as EventListener);
    void this.start();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener(LIVE_BROWSER_EVENT, this.onGatewayEvent as EventListener);
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    cancelAnimationFrame(this.moveRaf);
    if (this.phase === "live" || this.phase === "opening") {
      void this.client?.request("browser.viewer.close", {}).catch(() => {});
    }
  }

  private async start(): Promise<void> {
    if (!this.client) return;
    try {
      this.status = await this.client.request<ViewerStatus>("browser.viewer.status", {});
    } catch (err) {
      this.status = { available: false, reason: (err as Error).message };
      return;
    }
    if (this.status.available) await this.open();
  }

  private async open(): Promise<void> {
    if (!this.client) return;
    this.phase = "opening";
    this.error = null;
    try {
      const view = await this.client.request<ViewerState>("browser.viewer.open", {});
      this.applyState(view);
      this.phase = "live";
      // On a phone a 1280 px page is unreadable: ask for the phone layout.
      if (view.layout !== "phone" && this.getBoundingClientRect().width < 520) {
        void this.call("browser.viewer.layout", { layout: "phone" });
      }
      if (!this.keepalive) {
        // Tells the gateway this panel is still open when the page is static.
        this.keepalive = setInterval(() => this.ack(), 10_000);
      }
    } catch (err) {
      this.phase = "error";
      this.error = (err as Error).message ?? String(err);
    }
  }

  private applyState(next: ViewerState): void {
    const prevActive = this.view?.activeTargetId;
    this.view = { ...this.view, ...next };
    const active = next.tabs.find((t) => t.targetId === next.activeTargetId);
    if (active && (!this.addressDirty || prevActive !== next.activeTargetId)) {
      this.address = active.url === "about:blank" ? "" : active.url;
      this.addressDirty = false;
    }
    if (prevActive !== next.activeTargetId) this.hasFrame = false;
  }

  private onGatewayEvent = (e: CustomEvent<{ event: string; payload: unknown }>): void => {
    const { event, payload } = e.detail;
    if (event === "browser.viewer.frame") {
      const frame = payload as { data: string; targetId: string | null };
      const img = this.renderRoot.querySelector("img");
      if (img) img.src = `data:image/jpeg;base64,${frame.data}`;
      if (!this.hasFrame) this.hasFrame = true;
      this.ack();
      return;
    }
    if (event === "browser.viewer.state") {
      const next = payload as ViewerState;
      if (!next.connected && this.phase === "live") {
        this.phase = "error";
        this.error = "The browser stopped. Reconnect to start it again.";
        return;
      }
      this.applyState(next);
    }
  };

  /** One ack in flight at a time; a frame that lands meanwhile triggers another. */
  private ack(): void {
    if (!this.client || this.phase !== "live") return;
    if (this.ackInFlight) {
      this.ackWanted = true;
      return;
    }
    this.ackInFlight = true;
    void this.client
      .request("browser.viewer.ack", {})
      .catch(() => {})
      .finally(() => {
        this.ackInFlight = false;
        if (this.ackWanted) {
          this.ackWanted = false;
          this.ack();
        }
      });
  }

  private say(text: string): void {
    this.notice = text;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => (this.notice = null), 4000);
  }

  private async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.client) return undefined;
    try {
      return await this.client.request(method, params);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      // The gateway reconnected (new connection): subscribe again, once.
      if (/Open the live browser first/i.test(message)) {
        await this.open();
        return undefined;
      }
      this.say(message);
      return undefined;
    }
  }

  // ── input ────────────────────────────────────────────────────────────────

  /** Events are sent in order, batched while a request is in flight. */
  private send(ev: InputEvent_): void {
    if (this.phase !== "live") return;
    this.queue.push(ev);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length > 0) {
        const events = this.queue.splice(0, 32);
        await this.call("browser.viewer.input", { events });
      }
    } finally {
      this.sending = false;
    }
  }

  private pos(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const img = this.renderRoot.querySelector("img");
    const rect = (img ?? this).getBoundingClientRect();
    // object-fit: contain letterboxes the frame inside the element.
    const vp = this.view?.viewport ?? { width: 1280, height: 800 };
    const scale = Math.min(rect.width / vp.width, rect.height / vp.height) || 1;
    const w = vp.width * scale;
    const h = vp.height * scale;
    const left = rect.left + (rect.width - w) / 2;
    const top = rect.top + (rect.height - h) / 2;
    return { x: (e.clientX - left) / w, y: (e.clientY - top) / h };
  }

  private onPointerDown = (e: PointerEvent): void => {
    const surface = e.currentTarget as HTMLTextAreaElement;
    surface.focus({ preventScroll: true });
    if (e.pointerType === "touch") {
      this.touch = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      return;
    }
    surface.setPointerCapture(e.pointerId);
    e.preventDefault();
    this.flushMove();
    this.send({
      kind: "mouse",
      type: "down",
      ...this.pos(e),
      button: e.button,
      clickCount: Math.max(1, e.detail || 1),
      modifiers: modifiersOf(e),
    });
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === "touch") {
      const t = this.touch;
      if (!t || t.id !== e.pointerId) return;
      const dx = t.x - e.clientX;
      const dy = t.y - e.clientY;
      if (!t.moved && Math.hypot(dx, dy) < 8) return;
      // A finger drag scrolls the remote page.
      t.moved = true;
      t.x = e.clientX;
      t.y = e.clientY;
      const scale = (this.view?.viewport.width ?? 1280) / Math.max(1, this.getBoundingClientRect().width);
      this.send({ kind: "wheel", ...this.pos(e), deltaX: dx * scale, deltaY: dy * scale });
      return;
    }
    // One move per animation frame is plenty.
    this.pendingMove = {
      kind: "mouse",
      type: "move",
      ...this.pos(e),
      button: 0,
      pressed: (e.buttons & 1) === 1,
      modifiers: modifiersOf(e),
    };
    if (!this.moveRaf) this.moveRaf = requestAnimationFrame(() => this.flushMove());
  };

  private flushMove(): void {
    cancelAnimationFrame(this.moveRaf);
    this.moveRaf = 0;
    const move = this.pendingMove;
    this.pendingMove = null;
    if (move) this.send(move);
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === "touch") {
      const t = this.touch;
      this.touch = null;
      if (!t || t.id !== e.pointerId || t.moved) return;
      const p = this.pos(e);
      this.send({ kind: "mouse", type: "move", ...p });
      this.send({ kind: "mouse", type: "down", ...p, button: 0, clickCount: 1 });
      this.send({ kind: "mouse", type: "up", ...p, button: 0, clickCount: 1 });
      return;
    }
    this.flushMove();
    this.send({
      kind: "mouse",
      type: "up",
      ...this.pos(e),
      button: e.button,
      clickCount: Math.max(1, e.detail || 1),
      modifiers: modifiersOf(e),
    });
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    this.send({
      kind: "wheel",
      ...this.pos(e),
      deltaX: e.deltaX * unit,
      deltaY: e.deltaY * unit,
      modifiers: modifiersOf(e),
    });
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    // Phone keyboards and IMEs report no usable key: their text arrives via `input`.
    if (e.isComposing || e.key === "Unidentified" || e.key === "Process") return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    // Clipboard shortcuts stay local so the browser fires copy/paste events here.
    if (mod && (k === "v" || k === "c" || k === "x")) return;
    e.preventDefault();
    this.send({
      kind: "key",
      type: "down",
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      // Cmd on a Mac means Ctrl to the Linux browser on the other side.
      modifiers: modifiersOf({ ...this.modKeys(e), ctrlKey: mod }),
    });
  };

  private modKeys(e: KeyboardEvent) {
    return { altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: false, shiftKey: e.shiftKey };
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.isComposing || e.key === "Unidentified" || e.key === "Process") return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && (k === "v" || k === "c" || k === "x")) return;
    e.preventDefault();
    this.send({
      kind: "key",
      type: "up",
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      modifiers: modifiersOf({ ...this.modKeys(e), ctrlKey: mod }),
    });
  };

  /** Text the surface received natively: phone keyboard, IME, dictation. */
  private onSurfaceInput = (e: InputEvent): void => {
    const el = e.currentTarget as HTMLTextAreaElement;
    const text = el.value;
    el.value = "";
    if (e.inputType === "deleteContentBackward") {
      this.send({ kind: "key", type: "down", key: "Backspace", code: "Backspace", keyCode: 8 });
      this.send({ kind: "key", type: "up", key: "Backspace", code: "Backspace", keyCode: 8 });
      return;
    }
    if (e.inputType === "insertLineBreak" || text === "\n") {
      this.send({ kind: "key", type: "down", key: "Enter", code: "Enter", keyCode: 13 });
      this.send({ kind: "key", type: "up", key: "Enter", code: "Enter", keyCode: 13 });
      return;
    }
    if (text) this.send({ kind: "text", text });
  };

  private onPaste = (e: ClipboardEvent): void => {
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text) this.send({ kind: "text", text });
  };

  private onCopy = (e: ClipboardEvent): void => {
    e.preventDefault();
    void this.copyOut();
  };

  private async copyOut(): Promise<void> {
    const res = (await this.call("browser.viewer.copy", {})) as { text?: string } | undefined;
    const text = res?.text ?? "";
    if (!text) {
      this.say("Nothing is selected in the page.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      this.say("Copied the page selection to your clipboard.");
    } catch {
      this.say("Your browser blocked clipboard access. Select and copy again.");
    }
  }

  private async pasteIn(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.send({ kind: "text", text });
      else this.say("Your clipboard is empty.");
    } catch {
      this.say("Click the page, then press Ctrl+V (or ⌘V) to paste.");
    }
    this.focusSurface();
  }

  private focusSurface(): void {
    this.renderRoot.querySelector<HTMLTextAreaElement>("textarea.surface")?.focus({ preventScroll: true });
  }

  // ── toolbar ──────────────────────────────────────────────────────────────

  private nav(action: string): void {
    void this.call("browser.viewer.navigate", { action });
  }

  private onAddressSubmit = (e: Event): void => {
    e.preventDefault();
    const url = this.address.trim();
    if (!url) return;
    this.addressDirty = false;
    void this.call("browser.viewer.navigate", { action: "goto", url }).then(() => this.focusSurface());
  };

  private toggleLayout(): void {
    const layout = this.view?.layout === "phone" ? "desktop" : "phone";
    void this.call("browser.viewer.layout", { layout });
  }

  private tab(action: string, targetId?: string): void {
    void this.call("browser.viewer.tab", { action, targetId }).then((res) => {
      const info = res as { cap?: number | null; sessions?: number } | undefined;
      if (info && this.view) this.view = { ...this.view, cap: info.cap, sessions: info.sessions };
    });
  }

  private dialog(accept: boolean): void {
    void this.call("browser.viewer.dialog", { accept });
  }

  // ── render ───────────────────────────────────────────────────────────────

  private icon(name: "back" | "fwd" | "reload" | "plus" | "phone" | "copy" | "paste") {
    const d = {
      back: "M15 6l-6 6 6 6",
      fwd: "M9 6l6 6-6 6",
      reload: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
      plus: "M12 5v14M5 12h14",
      phone: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2",
      copy: "M9 9h10v11H9zM5 15V4h10",
      paste: "M9 4h6v3H9zM7 5H5v16h14V5h-2",
    }[name];
    return html`<svg viewBox="0 0 24 24" aria-hidden="true"><path d=${d}></path></svg>`;
  }

  private renderAgentStrip(view: ViewerState | null) {
    const a = view?.agent;
    if (!a) return nothing;
    const ageMs = Date.now() - a.at;
    if (ageMs > 10 * 60_000) return nothing;
    const active = ageMs < 20_000;
    return html`<div class="agent-strip ${active ? "" : "idle"}" data-testid="agent-driving">
      <span class="pulse"></span>
      <strong>${active ? "Agent is driving" : "Agent was here"}</strong>
      <span>· ${a.action}</span>
      <span class="url" title=${a.url}>${a.url}</span>
    </div>`;
  }

  render() {
    const status = this.status;
    if (!status) return nothing;
    if (!status.available) {
      return html`<div class="shell">
        <div class="head"><div class="title"><span class="dot"></span>Live browser</div></div>
        <div class="placeholder"><strong>Not available here</strong>${status.reason ?? ""}</div>
      </div>`;
    }
    const view = this.view;
    const live = this.phase === "live";
    const tabs = view?.tabs ?? [];
    const vp = view?.viewport ?? { width: 1280, height: 800 };
    const cap = view?.cap;
    // Same rule as the gateway's cap: real pages count, a blank tab does not.
    const sessions = tabs.filter((t) => t.url !== "about:blank").length;
    return html`
      <div class="shell">
        <div class="head">
          <div class="title">
            <span class="dot ${live ? "live" : ""}"></span>Live browser
          </div>
          <div class="meta">
            ${view?.profile
              ? html`<span class="profile" title="Browser profile on screen">profile: ${view.profile}</span>
                  ${cap != null ? " · " : nothing}`
              : nothing}
            ${cap != null
              ? html`${sessions} of ${cap} browser session${cap === 1 ? "" : "s"} in use`
              : nothing}
          </div>
        </div>
        <div class="sub">
          This is your workspace's own Chrome. Sign in to a site here and your agents can use that
          signed-in session; when an agent is browsing you see it here and can take over by
          clicking or typing.
        </div>
        ${this.renderAgentStrip(view)}
        ${tabs.length > 0
          ? html`<div class="tabs" role="tablist" aria-label="Browser tabs">
              ${tabs.map(
                (t) =>
                  html`<div
                    class="tab ${t.targetId === view?.activeTargetId ? "active" : ""}"
                    role="tab"
                    tabindex="0"
                    aria-selected=${t.targetId === view?.activeTargetId}
                    title=${t.url}
                    @click=${() => this.tab("select", t.targetId)}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") this.tab("select", t.targetId);
                    }}
                  >
                    <span>${t.title || (t.url === "about:blank" ? "New tab" : t.url)}</span>
                    <button
                      class="x"
                      aria-label="Close tab"
                      @click=${(e: Event) => {
                        e.stopPropagation();
                        this.tab("close", t.targetId);
                      }}
                    >
                      ×
                    </button>
                  </div>`,
              )}
            </div>`
          : nothing}
        <div class="bar">
          <div class="nav">
            <button class="ic" aria-label="Back" ?disabled=${!live} @click=${() => this.nav("back")}>
              ${this.icon("back")}
            </button>
            <button class="ic" aria-label="Forward" ?disabled=${!live} @click=${() => this.nav("forward")}>
              ${this.icon("fwd")}
            </button>
            <button class="ic" aria-label="Reload" ?disabled=${!live} @click=${() => this.nav("reload")}>
              ${this.icon("reload")}
            </button>
          </div>
          <form @submit=${this.onAddressSubmit}>
            <input
              type="text"
              inputmode="url"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              aria-label="Address"
              placeholder="Search or enter an address"
              .value=${this.address}
              ?disabled=${!live}
              @input=${(e: Event) => {
                this.address = (e.target as HTMLInputElement).value;
                this.addressDirty = true;
              }}
              @focus=${(e: Event) => (e.target as HTMLInputElement).select()}
            />
          </form>
          <div class="nav">
            <button class="ic" aria-label="New tab" title="New tab" ?disabled=${!live} @click=${() => this.tab("new")}>
              ${this.icon("plus")}
            </button>
            <button
              class="ic ${view?.layout === "phone" ? "on" : ""}"
              aria-label="Phone layout"
              title="Phone layout"
              aria-pressed=${view?.layout === "phone"}
              ?disabled=${!live}
              @click=${() => this.toggleLayout()}
            >
              ${this.icon("phone")}
            </button>
            <button class="ic" aria-label="Copy selection" title="Copy the page selection" ?disabled=${!live} @click=${() => void this.copyOut()}>
              ${this.icon("copy")}
            </button>
            <button class="ic" aria-label="Paste" title="Paste your clipboard into the page" ?disabled=${!live} @click=${() => void this.pasteIn()}>
              ${this.icon("paste")}
            </button>
          </div>
        </div>
        <div class="stage">
          ${this.phase === "error"
            ? html`<div class="placeholder">
                <strong>The browser didn't start</strong>${this.error}
                <div style="margin-top:12px">
                  <button class="txt" @click=${() => void this.open()}>Reconnect</button>
                </div>
              </div>`
            : html`<div
                class="frame ${view?.layout === "phone" ? "phone" : ""} ${this.focused ? "focused" : ""}"
                style="aspect-ratio:${vp.width}/${vp.height};width:min(100%,${
                  view?.layout === "phone" ? "390px," : ""
                }calc(78vh * ${vp.width} / ${vp.height}))"
              >
                <img alt="" draggable="false" style=${this.hasFrame ? "" : "visibility:hidden"} />
                ${this.hasFrame
                  ? nothing
                  : html`<div class="placeholder" style="position:absolute;inset:0">
                      <strong>Starting your browser…</strong>This takes a few seconds the first time.
                    </div>`}
                <textarea
                  class="surface"
                  aria-label="Browser page. Click to control it with your mouse and keyboard."
                  autocomplete="off"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck="false"
                  @pointerdown=${this.onPointerDown}
                  @pointermove=${this.onPointerMove}
                  @pointerup=${this.onPointerUp}
                  @pointercancel=${() => (this.touch = null)}
                  @wheel=${this.onWheel}
                  @contextmenu=${(e: Event) => e.preventDefault()}
                  @keydown=${this.onKeyDown}
                  @keyup=${this.onKeyUp}
                  @input=${this.onSurfaceInput}
                  @paste=${this.onPaste}
                  @copy=${this.onCopy}
                  @cut=${this.onCopy}
                  @focus=${() => (this.focused = true)}
                  @blur=${() => (this.focused = false)}
                ></textarea>
                ${view?.dialog
                  ? html`<div class="dialog">
                      <div>
                        ${view.dialog.message || "The page is asking for confirmation."}
                        <div class="row">
                          ${view.dialog.type === "alert"
                            ? nothing
                            : html`<button class="txt" @click=${() => this.dialog(false)}>Cancel</button>`}
                          <button class="txt on" @click=${() => this.dialog(true)}>OK</button>
                        </div>
                      </div>
                    </div>`
                  : nothing}
              </div>`}
        </div>
        <div class="foot">
          <span class="notice" role="status">${this.notice ?? ""}</span>
          <span>
            ${this.focused
              ? "Your keyboard is controlling the page. Click outside to release it."
              : "Click the page to type into it. Logins are saved for next time."}
          </span>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "live-browser-panel": LiveBrowserPanel;
  }
}

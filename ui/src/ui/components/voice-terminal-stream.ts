/**
 * <voice-terminal-stream> — collapsible live output of the terminal / CLI
 * coder run the voice call is working with.
 *
 *   collapsed  one line: live dot · terminal name · its last output line
 *   expanded   ANSI-free monospace output (last ~2k lines) that follows the
 *              tail; scrolling up pauses following, "Resume" (or scrolling
 *              back down) re-arms it
 *
 * Which source it follows comes from ./terminal-stream-source.ts (the CLI
 * mode toggle's selection, else the most recently active run). Open/closed is
 * persisted in localStorage per `surface`. Rest state is fully visible with
 * animations off (prefers-reduced-motion / html.low-power): the live dot is a
 * solid colour, the pulse is decoration only.
 */

import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import {
  fetchStreamSnapshot,
  listStreamSources,
  onVoiceCliSelectionChange,
  pickStreamSource,
  rankSources,
  readVoiceCliSelection,
  subscribeTerminalOutput,
  type StreamSource,
  type VoiceCliSelection,
} from "./terminal-stream-source.js";
import { TerminalLineBuffer, isLive, nextFollow, shouldAutoScroll } from "./voice-terminal-stream-model.js";

type StreamClient = {
  request: <T>(method: string, params?: unknown) => Promise<T>;
  subscribe?: (h: (evt: { event: string; payload?: unknown }) => void) => () => void;
};

const OPEN_KEY = (surface: string) => `infinibot.voice.termStream.open.${surface}`;
const PIN_KEY = (surface: string) => `infinibot.voice.termStream.pin.${surface}`;
const LIST_EVERY_MS = 15_000;
/** tmux-only coder panes have no push stream: re-read their tail this often (slower when collapsed / hidden). */
const POLL_OPEN_MS = 2_000;
const POLL_IDLE_MS = 6_000;
/** Delay before re-reading a tmux pane after new output arrived. */
const KICK_MS = 400;

function readLs(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLs(key: string, v: string | null): void {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, v);
  } catch {
    /* private mode */
  }
}

const BACKEND_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", gemini: "Gemini", grok: "Grok Build", shell: "Shell" };

@customElement("voice-terminal-stream")
export class VoiceTerminalStream extends LitElement {
  @property({ attribute: false }) client: StreamClient | null = null;
  /** Storage scope for open/closed + pinned source (e.g. "voice", "call-dock"). */
  @property() surface = "voice";
  /** Start expanded when nothing is persisted yet. */
  @property({ type: Boolean, attribute: "default-open" }) defaultOpen = false;

  @state() private open = false;
  @state() private sources: StreamSource[] = [];
  @state() private source: StreamSource | null = null;
  @state() private follow = true;
  @state() private version = 0;
  @state() private error: string | null = null;
  @state() private loading = true;
  @state() private now = Date.now();
  private selection: VoiceCliSelection = { isCliMode: false };
  private pinned: string | null = null;
  private readonly buf = new TerminalLineBuffer();
  private lastOutputAt: number | null = null;
  private scrollState = { follow: true, lastTop: 0 };
  private unsubOutput: (() => void) | null = null;
  private unsubSelection: (() => void) | null = null;
  private listTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollDueAt: number | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private flushQueued = false;
  /** "tmux": the source is re-read as a clean pane capture; PTY events only trigger a re-read. */
  private mode: "pty" | "tmux" = "pty";
  private alive = true;

  @query(".out") private outEl?: HTMLElement;

  static styles = css`
    :host {
      display: block; width: 100%; min-width: 0; box-sizing: border-box;
      --vts-accent: var(--g-primary, #d4af37);
      --vts-ok: var(--ok, #22c55e);
      --vts-line: rgba(214, 166, 42, 0.22);
      font: 500 12px/1.4 var(--font-sans, ui-sans-serif, system-ui, sans-serif);
      color: rgba(226, 222, 212, 0.86);
    }
    * { box-sizing: border-box; }
    .panel {
      border: 1px solid var(--vts-line); border-radius: 12px; overflow: hidden;
      background: linear-gradient(180deg, rgba(255, 243, 207, 0.035), rgba(4, 5, 7, 0.82));
      box-shadow: inset 0 1px 0 rgba(255, 243, 207, 0.05);
    }
    .bar {
      display: flex; align-items: center; gap: 10px; width: 100%; min-height: 44px; padding: 6px 12px;
      background: transparent; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer;
    }
    .bar:focus-visible { outline: 1px solid #ffe49a; outline-offset: -2px; }
    .dot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: rgba(226, 222, 212, 0.28); }
    .dot.live { background: var(--vts-ok); box-shadow: 0 0 8px var(--vts-ok); animation: vts-pulse 1.6s ease-in-out infinite; }
    .dot.err { background: #ef4444; }
    @keyframes vts-pulse { 50% { opacity: 0.45; } }
    .name {
      flex: none; max-width: 38%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font: 600 11px/1 "Rajdhani", "Barlow Condensed", ui-sans-serif, system-ui, sans-serif; letter-spacing: 0.14em; text-transform: uppercase; color: #ffe49a;
    }
    .backend { flex: none; font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: rgba(226, 222, 212, 0.45); }
    .last {
      flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font: 12px/1.3 var(--mono, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace); color: rgba(226, 222, 212, 0.7);
    }
    .chev { flex: none; width: 16px; height: 16px; transition: transform 160ms ease; color: rgba(226, 222, 212, 0.6); }
    .open .chev { transform: rotate(180deg); }
    .body { border-top: 1px solid var(--vts-line); position: relative; }
    .tools { display: flex; align-items: center; gap: 8px; padding: 6px 10px; flex-wrap: wrap; }
    .tools label { font-size: 11px; color: rgba(226, 222, 212, 0.5); }
    select {
      flex: 1 1 200px; min-width: 0; min-height: 36px; max-width: 100%; padding: 4px 8px; border-radius: 8px;
      background: rgba(255, 255, 255, 0.04); color: inherit; border: 1px solid rgba(255, 255, 255, 0.12); font: inherit;
    }
    .meta { font-size: 11px; color: rgba(226, 222, 212, 0.45); margin-left: auto; white-space: nowrap; }
    .out {
      margin: 0; padding: 8px 12px 12px; height: min(42vh, 380px); overflow: auto; overscroll-behavior: contain;
      font: 12px/1.45 var(--mono, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace);
      white-space: pre-wrap; word-break: break-word; color: rgba(236, 232, 222, 0.88);
      background: rgba(0, 0, 0, 0.35); -webkit-overflow-scrolling: touch;
    }
    .empty { padding: 14px 12px; color: rgba(226, 222, 212, 0.5); font-size: 12px; }
    .dropped { color: rgba(226, 222, 212, 0.38); }
    .resume {
      position: absolute; right: 14px; bottom: 14px; min-height: 44px; padding: 0 16px; border-radius: 999px; cursor: pointer;
      font: 600 12px/1 inherit; color: #1a1406; background: var(--vts-accent); border: 0; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
    }
    .resume:focus-visible { outline: 2px solid #fff3cf; outline-offset: 2px; }
    @media (max-width: 640px) {
      .name { max-width: 34%; }
      .backend { display: none; }
      .out { height: min(46vh, 340px); font-size: 11.5px; }
    }
    @media (prefers-reduced-motion: reduce) {
      .dot.live { animation: none; }
      .chev { transition: none; }
    }
    :host-context(.low-power) .dot.live { animation: none; box-shadow: none; }
    :host-context(.low-power) .chev { transition: none; }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.alive = true;
    const persisted = readLs(OPEN_KEY(this.surface));
    this.open = persisted === null ? this.defaultOpen : persisted === "1";
    this.pinned = readLs(PIN_KEY(this.surface));
    this.selection = readVoiceCliSelection();
    this.unsubSelection = onVoiceCliSelectionChange((sel) => {
      this.selection = sel;
      this.choose();
    });
    this.listTimer = setInterval(() => void this.refreshSources(), LIST_EVERY_MS);
    this.clockTimer = setInterval(() => (this.now = Date.now()), 2_000);
    if (this.client) void this.refreshSources();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.alive = false;
    this.unsubSelection?.();
    this.unsubSelection = null;
    this.detach();
    if (this.listTimer) clearInterval(this.listTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.listTimer = this.clockTimer = null;
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("client") && this.client && this.isConnected) void this.refreshSources();
  }

  protected updated(): void {
    if (shouldAutoScroll(this.follow, this.open) && this.outEl) {
      this.outEl.scrollTop = this.outEl.scrollHeight;
      this.scrollState = { follow: true, lastTop: this.outEl.scrollTop };
    }
  }

  private async refreshSources(): Promise<void> {
    const client = this.client;
    if (!client) return;
    try {
      const rpc = <T>(m: string, p?: Record<string, unknown>) => client.request<T>(m, p);
      this.sources = rankSources(await listStreamSources(rpc));
      this.error = null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
    }
    this.choose();
  }

  /** Re-pick the followed source; (re)attach only when it changed. */
  private choose(): void {
    const next = pickStreamSource(this.sources, this.selection, this.pinned);
    if (next?.id === this.source?.id) {
      if (next) this.source = next; // fresher metadata
      return;
    }
    this.detach();
    this.source = next;
    this.buf.reset();
    this.lastOutputAt = null;
    this.follow = true;
    this.version = this.buf.version;
    if (next) void this.attach(next);
  }

  private async attach(src: StreamSource): Promise<void> {
    const client = this.client;
    if (!client) return;
    const rpc = <T>(m: string, p?: Record<string, unknown>) => client.request<T>(m, p);
    this.mode = "pty";
    // Live chunks first, so nothing between snapshot and subscribe is lost (a few may repeat).
    if (src.pty) this.unsubOutput = subscribeTerminalOutput(client, src.id, (d) => (this.mode === "tmux" ? this.kick(src) : this.onChunk(d)));
    try {
      const snap = await fetchStreamSnapshot(rpc, src.id);
      if (this.source?.id !== src.id || !this.alive) return;
      this.buf.reset(snap.text);
      this.version = this.buf.version;
      if (snap.source === "tmux") {
        this.mode = "tmux";
        this.schedulePoll(src);
      }
    } catch (err) {
      if (this.source?.id === src.id) this.error = err instanceof Error ? err.message : String(err);
    }
  }

  /** New PTY output on a tmux-backed source: re-read the capture soon (bursts coalesce). */
  private kick(src: StreamSource): void {
    this.lastOutputAt = Date.now();
    if (this.pollDueAt !== null && this.pollDueAt - Date.now() <= KICK_MS) return;
    this.schedulePoll(src, KICK_MS);
  }

  /** tmux panes (coder runs, tmux-backed terminals): re-read the clean capture. */
  private schedulePoll(src: StreamSource, delay?: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    const ms = delay ?? (this.open && !hidden ? POLL_OPEN_MS : POLL_IDLE_MS);
    this.pollDueAt = Date.now() + ms;
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      this.pollDueAt = null;
      const client = this.client;
      if (!client || this.source?.id !== src.id || !this.alive) return;
      try {
        const snap = await fetchStreamSnapshot(<T>(m: string, p?: Record<string, unknown>) => client.request<T>(m, p), src.id);
        if (this.source?.id !== src.id) return;
        const before = this.buf.text();
        this.buf.reset(snap.text);
        if (this.buf.text() !== before) this.lastOutputAt = Date.now();
        this.version = this.buf.version;
        if (!snap.alive) return;
      } catch {
        /* transient; keep polling */
      }
      this.schedulePoll(src);
    }, ms);
  }

  private onChunk(data: string): void {
    this.buf.push(data);
    this.lastOutputAt = Date.now();
    // Coalesce bursts (TUI redraws send many small chunks) into one render per frame.
    if (this.flushQueued) return;
    this.flushQueued = true;
    const flush = () => {
      this.flushQueued = false;
      this.version = this.buf.version;
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  private detach(): void {
    this.unsubOutput?.();
    this.unsubOutput = null;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.pollDueAt = null;
  }

  private toggle(): void {
    this.open = !this.open;
    writeLs(OPEN_KEY(this.surface), this.open ? "1" : "0");
    if (this.open) {
      this.follow = true;
      if (this.source && this.mode === "tmux") this.schedulePoll(this.source, 0);
    }
    this.dispatchEvent(new CustomEvent("terminal-stream-toggle", { detail: { open: this.open }, bubbles: true, composed: true }));
  }

  private onScroll = (): void => {
    const el = this.outEl;
    if (!el) return;
    this.scrollState = nextFollow(this.scrollState, { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
    if (this.scrollState.follow !== this.follow) this.follow = this.scrollState.follow;
  };

  private resume(): void {
    this.follow = true;
    const el = this.outEl;
    if (el) el.scrollTop = el.scrollHeight;
  }

  private pick(id: string): void {
    this.pinned = id || null;
    writeLs(PIN_KEY(this.surface), this.pinned);
    this.choose();
  }

  render() {
    void this.version;
    const src = this.source;
    const live = isLive(this.lastOutputAt, this.now) || Boolean(src?.active);
    const name = src ? src.title : this.loading ? "Terminal" : "No terminal";
    const backend = src?.backend ? (BACKEND_LABEL[src.backend] ?? src.backend) : "";
    const last = src ? this.buf.lastLine() || (this.loading ? "Loading…" : "Waiting for output…") : this.error ? `Unavailable: ${this.error}` : this.loading ? "Looking for terminals…" : "Start a terminal or CLI coder to stream it here.";
    const lines = this.buf.lines;
    return html`<section class="panel ${this.open ? "open" : ""}" data-testid="voice-terminal-stream" data-open=${this.open ? "1" : "0"} data-source=${src?.id ?? ""}>
      <button class="bar" aria-expanded=${this.open ? "true" : "false"} aria-controls="vts-body"
        title=${this.open ? "Collapse terminal stream" : "Show live terminal output"} @click=${() => this.toggle()}>
        <span class="dot ${this.error && !src ? "err" : live ? "live" : ""}" role="img" aria-label=${live ? "Live" : "Idle"}></span>
        <span class="name">${name}</span>
        ${backend ? html`<span class="backend">${backend}</span>` : nothing}
        <span class="last" data-testid="voice-terminal-stream-last">${last}</span>
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      ${this.open
        ? html`<div class="body" id="vts-body">
            ${this.sources.length > 1
              ? html`<div class="tools">
                  <label for="vts-src">Following</label>
                  <select id="vts-src" aria-label="Terminal to follow" @change=${(e: Event) => this.pick((e.target as HTMLSelectElement).value)}>
                    <option value="" ?selected=${!this.pinned}>Auto${this.selection.isCliMode && this.selection.backend ? ` (${BACKEND_LABEL[this.selection.backend] ?? this.selection.backend})` : " (most recent)"}</option>
                    ${this.sources.map((s) => html`<option value=${s.id} ?selected=${this.pinned === s.id}>${s.title}${s.backend ? ` · ${BACKEND_LABEL[s.backend] ?? s.backend}` : ""}${s.active ? " · working" : ""}</option>`)}
                  </select>
                  <span class="meta">${lines.length} line${lines.length === 1 ? "" : "s"}</span>
                </div>`
              : nothing}
            ${src
              ? html`<pre class="out" role="log" aria-live="off" aria-label="Output of ${name}" tabindex="0" data-testid="voice-terminal-stream-output" @scroll=${this.onScroll}>${this.buf.dropped ? html`<span class="dropped">… ${this.buf.dropped} earlier lines\n</span>` : nothing}${lines.join("\n")}</pre>
                ${this.follow ? nothing : html`<button class="resume" data-testid="voice-terminal-stream-resume" @click=${() => this.resume()}>Resume ↓</button>`}`
              : html`<div class="empty">${last}</div>`}
          </div>`
        : nothing}
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "voice-terminal-stream": VoiceTerminalStream;
  }
}

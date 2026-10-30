/**
 * <voice-cli-route-control> — the Voice page's routing switch: what answers
 * the owner's voice calls.
 *
 *   API LLM      voice → InfiniBot voice agent → LLM (default)
 *   CLI session  voice turns are typed into the selected CLI session (an open
 *                terminal or a running coder run) and its output is spoken
 *
 * The selector lists every open session (voice.cliRoute.sessions: terminals,
 * tmux survivors, running claude/codex/opencode/gemini coder runs, with cwd
 * and status) and every installed CLI, each with "Start new session" in a
 * chosen folder. The choice is stored gateway-side (voice.cliRoute.set), so a
 * Robovoice call follows it with no Robovoice change; the page mirrors it in
 * localStorage for instant paint and points <voice-terminal-stream> at the
 * routed pane so its live output shows under the call.
 *
 * The same picker chooses the MODEL for API turns (<voice-brain-models>):
 * subscription CLIs (claude-cli…), every configured API provider with its live
 * model list, and local models. The pick is stored gateway-side
 * (voice.cliRoute.set { mode: "api", model }), so every voice turn runs on it.
 *
 * Two variants: "bar" (segmented switch + session chip, the sub-tab bar) and
 * "pill" (one chip in the call view's control toolbar). The selector opens in
 * the top layer (popover API), so no HUD overflow / transform can clip it; it
 * is placed in screen pixels (the page may be zoomed, viewport-scale.css),
 * flips above the chip when there is more room there, and becomes a bottom
 * sheet on phones.
 * Styled with the shared glass tokens (docs/ui/GLASS.md).
 */

import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../gateway.js";
import { setVoiceCliSelection } from "../../components/terminal-stream-source.js";
import "./brain-models.js";
import type { VoiceBrainModels } from "./brain-models.js";
import { brainSummary, loadCachedCatalog, type BrainCatalog } from "./voice-brain-state.js";
import {
  cliName,
  isSelected,
  loadCachedRoute,
  routeSummary,
  saveCachedRoute,
  shortCwd,
  sortOpenSessions,
  streamSelectionFor,
  targetOf,
  type CliCatalogue,
  type CliRoutePayload,
  type OpenSession,
} from "./cli-route-state.js";

export const VOICE_CLI_ROUTE_CHANGE = "voice-cli-route-change";

type TestResult = { text: string; spoken: Array<{ ms: number; text: string }>; firstTokenMs: number | null; totalMs: number };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** All controls on the page share one payload so the bar and the call pill never disagree. */
const shared = { payload: null as CliRoutePayload | null, listeners: new Set<(p: CliRoutePayload) => void>() };
/** Follow the gateway-owned route from outside the two route-control instances. */
export function onVoiceCliRoutePayload(listener: (p: CliRoutePayload) => void): () => void {
  shared.listeners.add(listener);
  if (shared.payload) listener(shared.payload);
  return () => shared.listeners.delete(listener);
}
function publish(p: CliRoutePayload) {
  shared.payload = p;
  saveCachedRoute(p.route);
  setVoiceCliSelection(streamSelectionFor(p.route));
  for (const l of shared.listeners) l(p);
}

const ICON_TERMINAL = html`<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"></rect><path d="M7 9l3 3-3 3M12.5 15H17"></path></svg>`;
const ICON_AGENT = html`<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="7" width="14" height="12" rx="3"></rect><path d="M12 3v4M9 12h.01M15 12h.01M9.5 16h5"></path></svg>`;
const ICON_CPU = html`<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"></path></svg>`;
const ICON_PLUS = html`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;
const ICON_CLOSE = html`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;
const ICON_CHEVRON = html`<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>`;

@customElement("voice-cli-route-control")
export class VoiceCliRouteControl extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ reflect: true }) variant: "bar" | "pill" = "bar";

  @state() private payload: CliRoutePayload = shared.payload ?? { route: loadCachedRoute(), alive: null };
  @state() private catalogue: CliCatalogue | null = null;
  @state() private catalogueError: string | null = null;
  @state() private open = false;
  @state() private busy: string | null = null;
  @state() private error: string | null = null;
  @state() private cwd = "";
  @state() private testText = "";
  @state() private test: TestResult | null = null;
  @state() private brainCatalog: BrainCatalog | null = loadCachedCatalog();
  @state() private picking: string | null = null;

  @query("#picker") private picker?: HTMLElement;
  @query(".anchor") private anchor?: HTMLElement;
  @query("voice-brain-models") private models?: VoiceBrainModels;

  private unsubEvents: (() => void) | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private readonly onShared = (p: CliRoutePayload) => (this.payload = p);
  private readonly onWinResize = () => this.place();

  static styles = css`
    :host { display: inline-flex; align-items: center; min-width: 0; font-family: var(--glass-font, var(--font-ui, inherit)); color: var(--glass-fg, var(--text, #f4efe2)); }
    .route { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
    .seg {
      display: inline-flex; padding: 3px; gap: 2px; border-radius: var(--glass-radius-pill, 999px);
      background: var(--glass-sheen, none), var(--glass-2, rgba(18, 16, 12, 0.72));
      border: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.1)); box-shadow: var(--glass-specular, none);
    }
    .seg button {
      all: unset; cursor: pointer; padding: 5px 11px; border-radius: var(--glass-radius-pill, 999px); white-space: nowrap;
      font-size: var(--glass-text-xs, 12px); font-weight: 600; letter-spacing: 0.01em; color: var(--glass-fg-3, rgba(244, 239, 226, 0.6));
      transition: background var(--glass-dur-fast, 0.15s) var(--glass-ease, ease), color var(--glass-dur-fast, 0.15s) var(--glass-ease, ease);
    }
    .seg button:hover { color: var(--glass-fg, inherit); background: var(--glass-hover, rgba(255, 255, 255, 0.05)); }
    .seg button[aria-checked="true"] { background: var(--glass-gold-fill, linear-gradient(180deg, #f3d27a, #b8892b)); color: var(--glass-ink, #1a1408); }
    .seg button:focus-visible, .chip:focus-visible, .row:focus-visible, .btn:focus-visible, input:focus-visible { outline: none; box-shadow: var(--glass-focus-ring, 0 0 0 2px #e6c15a); }
    .chip {
      all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; min-width: 0; max-width: 260px;
      padding: 5px 10px 5px 9px; border-radius: var(--glass-radius-pill, 999px); font-size: var(--glass-text-xs, 12px);
      background: var(--glass-3, rgba(28, 24, 18, 0.6)); border: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.1)); color: var(--glass-fg-2, rgba(244, 239, 226, 0.82));
    }
    .chip:hover { border-color: var(--glass-stroke-gold, rgba(230, 193, 90, 0.45)); color: var(--glass-fg, inherit); }
    .chip .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .chip .k { color: var(--glass-fg-4, rgba(244, 239, 226, 0.45)); text-transform: uppercase; letter-spacing: var(--glass-tracking-caps, 0.08em); font-size: 10px; }
    .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--glass-fg-4, #777); }
    .tone-live .dot { background: #3ddc84; box-shadow: 0 0 8px rgba(61, 220, 132, 0.7); }
    .tone-warn .dot { background: #f5b942; box-shadow: 0 0 8px rgba(245, 185, 66, 0.7); }
    .tone-dead .dot { background: #ef5b5b; }
    .tone-api .dot { background: var(--glass-gold, #e6c15a); }
    :host([variant="pill"]) .chip { padding: 0 2px; background: none; border: 0; max-width: 340px; gap: 6px; font-size: 11px; letter-spacing: 0.04em; }
    .chip svg { flex: none; }

    /* ── picker (top layer) ─────────────────────────────────────────────── */
    #picker {
      /* Size + position are set in place() (screen pixels ÷ page zoom). */
      margin: 0; inset: auto; position: fixed; width: 520px; max-height: 640px; box-sizing: border-box;
      overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; padding: 0; border-radius: var(--glass-radius-lg, 20px); color: var(--glass-fg, #f4efe2);
      /* Opaque: the voice HUD behind it is busy (sphere, panels), see-through glass hurt legibility. */
      background: var(--glass-sheen, none), rgb(13, 11, 8);
      border: 1px solid var(--glass-stroke-gold, rgba(230, 193, 90, 0.35));
      box-shadow: var(--glass-elev-4, 0 24px 60px rgba(0, 0, 0, 0.55)), var(--glass-specular, none);
      backdrop-filter: blur(var(--glass-blur-lg, 28px)) saturate(1.3); -webkit-backdrop-filter: blur(var(--glass-blur-lg, 28px)) saturate(1.3);
      font-family: var(--glass-font, var(--font-ui, system-ui));
      /* The popover inherits from wherever the control sits (the call toolbar is
         uppercase, tracked and nowrap): reset text so labels wrap and read. */
      font-size: 14px; line-height: 1.4; font-weight: 400; letter-spacing: normal; text-transform: none;
      white-space: normal; text-align: left; word-spacing: normal; font-style: normal;
    }
    #picker::backdrop { background: transparent; }
    .p-head { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 10px; padding: 14px 16px 12px; background: rgb(13, 11, 8); border-bottom: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.08)); }
    .p-head h2 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: var(--glass-tracking-tight, -0.01em); }
    .p-head p { margin: 2px 0 0; font-size: 12.5px; line-height: 1.4; color: var(--glass-fg-3, rgba(244, 239, 226, 0.62)); }
    .p-head .p-t { min-width: 0; }
    .p-head .x { margin-left: auto; }
    .p-body { padding: 6px 12px 14px; display: grid; gap: 14px; }
    /* "More below" cue while the picker scrolls (sits over the bottom padding at the end). */
    .p-fade { position: sticky; bottom: 0; height: 28px; margin-top: -28px; pointer-events: none; background: linear-gradient(to bottom, transparent, rgb(13, 11, 8)); }
    .sec-head { display: flex; align-items: center; gap: 8px; margin: 8px 4px 6px; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: var(--glass-tracking-caps, 0.1em); color: var(--glass-gold, #e6c15a); }
    .sec-head::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, var(--glass-gold-a24, rgba(230, 193, 90, 0.24)), transparent); }
    .sec-head .n { color: var(--glass-fg-3, rgba(244, 239, 226, 0.6)); font-variant-numeric: tabular-nums; letter-spacing: 0; }
    .list { display: grid; gap: 6px; }
    .row {
      all: unset; box-sizing: border-box; cursor: pointer; display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; gap: 10px;
      padding: 9px 10px; border-radius: var(--glass-radius-sm, 10px); background: var(--glass-3, rgba(28, 24, 18, 0.55));
      border: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.07)); transition: border-color var(--glass-dur-fast, 0.15s), transform var(--glass-dur-fast, 0.15s) var(--glass-spring, ease);
    }
    .row:hover { border-color: var(--glass-stroke-gold, rgba(230, 193, 90, 0.45)); transform: var(--glass-lift, translateY(-1px)); }
    .row.sel { border-color: var(--glass-gold, #e6c15a); background: var(--glass-gold-tint, rgba(230, 193, 90, 0.1)); }
    .row[aria-disabled="true"] { opacity: 0.55; cursor: progress; }
    .ic { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center; color: var(--glass-gold, #e6c15a); background: var(--glass-gold-a10, rgba(230, 193, 90, 0.1)); border: 1px solid var(--glass-gold-a16, rgba(230, 193, 90, 0.16)); }
    .t { min-width: 0; display: grid; gap: 2px; }
    .t b { font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; line-height: 1.3; }
    .t span { font-size: 12px; color: var(--glass-fg-3, rgba(244, 239, 226, 0.62)); overflow-wrap: anywhere; line-height: 1.35; font-family: var(--glass-font-mono, ui-monospace, monospace); }
    .sess { display: grid; gap: 6px; margin-top: 6px; }
    .sess-head { margin: 6px 4px 0; font-size: 12px; font-weight: 600; color: var(--glass-fg-2, rgba(244, 239, 226, 0.82)); }
    .status .fb { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .tag { font-size: 10.5px; padding: 2px 8px; border-radius: 999px; white-space: nowrap; border: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.12)); color: var(--glass-fg-3, rgba(244, 239, 226, 0.65)); display: inline-flex; align-items: center; gap: 5px; }
    .tag.ok { border-color: rgba(61, 220, 132, 0.45); color: #6fe3a1; }
    .tag.gold { border-color: var(--glass-gold-a40, rgba(230, 193, 90, 0.4)); color: var(--glass-gold, #e6c15a); }
    .tag.warn { border-color: rgba(245, 185, 66, 0.5); color: #f5b942; }
    .empty { padding: 12px; border-radius: var(--glass-radius-sm, 10px); border: 1px dashed var(--glass-stroke, rgba(255, 255, 255, 0.12)); color: var(--glass-fg-3, rgba(244, 239, 226, 0.6)); font-size: 12.5px; text-align: center; }
    .cwd { display: grid; gap: 5px; margin: 0 2px 8px; }
    .cwd label { font-size: 11.5px; color: var(--glass-fg-3, rgba(244, 239, 226, 0.6)); }
    input {
      box-sizing: border-box; width: 100%; padding: 8px 11px; border-radius: var(--glass-radius-sm, 10px); font: inherit; font-size: 12.5px;
      color: var(--glass-fg, inherit); background: var(--glass-1, rgba(0, 0, 0, 0.35)); border: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.1)); box-shadow: var(--glass-inner-shade, none);
    }
    input::placeholder { color: var(--glass-fg-4, rgba(244, 239, 226, 0.4)); }
    .cli-row { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--glass-radius-sm, 10px); background: var(--glass-3, rgba(28, 24, 18, 0.55)); border: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.07)); }
    .btn {
      all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border-radius: var(--glass-radius-pill, 999px); white-space: nowrap;
      font-size: 12px; font-weight: 600; background: var(--glass-hover, rgba(255, 255, 255, 0.06)); border: 1px solid var(--glass-stroke-strong, rgba(255, 255, 255, 0.16)); color: var(--glass-fg, inherit);
    }
    .btn:hover { border-color: var(--glass-stroke-gold, rgba(230, 193, 90, 0.5)); }
    .btn.primary { background: var(--glass-gold-fill, linear-gradient(180deg, #f3d27a, #b8892b)); color: var(--glass-ink, #1a1408); border-color: transparent; }
    .btn.danger { border-color: rgba(239, 91, 91, 0.45); color: #ff8a8a; }
    .btn[disabled] { opacity: 0.5; pointer-events: none; }
    .btn.icon { padding: 6px; }
    .note { font-size: 12px; padding: 9px 11px; border-radius: var(--glass-radius-sm, 10px); background: rgba(245, 185, 66, 0.08); border: 1px solid rgba(245, 185, 66, 0.3); color: #f5c76a; }
    .note.err { background: rgba(239, 91, 91, 0.08); border-color: rgba(239, 91, 91, 0.35); color: #ff9c9c; }
    .missing { font-size: 11.5px; color: var(--glass-fg-4, rgba(244, 239, 226, 0.45)); margin: 6px 4px 0; }
    .status { display: grid; gap: 8px; padding: 12px; border-radius: var(--glass-radius, 14px); background: var(--glass-tint, rgba(230, 193, 90, 0.05)); border: 1px solid var(--glass-gold-a16, rgba(230, 193, 90, 0.16)); }
    .status .line { display: flex; align-items: center; gap: 8px; font-size: 12.5px; flex-wrap: wrap; }
    .say { display: flex; gap: 6px; }
    .spoken { font-size: 12px; color: var(--glass-fg-2, rgba(244, 239, 226, 0.8)); line-height: 1.5; }
    .spoken .ms { font-family: var(--glass-font-mono, monospace); color: var(--glass-gold, #e6c15a); font-size: 11px; }
    @media (max-width: 640px) {
      .seg button { padding: 5px 9px; }
      .chip { max-width: 190px; }
      .p-head { padding: 14px 14px 12px; }
      .p-body { padding: 6px 10px calc(14px + env(safe-area-inset-bottom, 0px)); }
    }
    @media (prefers-reduced-motion: reduce) { .row, .seg button { transition: none; } .row:hover { transform: none; } }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    shared.listeners.add(this.onShared);
    window.addEventListener("resize", this.onWinResize);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    shared.listeners.delete(this.onShared);
    window.removeEventListener("resize", this.onWinResize);
    this.unsubEvents?.();
    this.unsubEvents = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  protected updated(changed: PropertyValues<this>): void {
    if (changed.has("client") && this.client) {
      this.unsubEvents?.();
      this.unsubEvents = this.client.subscribe((evt) => {
        if (evt.event !== "voice.cli.turn") return;
        const phase = (evt.payload as { phase?: string } | undefined)?.phase;
        if (phase === "approval" || phase === "fallback" || phase === "done" || phase === "reply" || phase === "interrupted") void this.refresh();
      });
      void this.refresh();
      if (this.poll) clearInterval(this.poll);
      // Liveness of the routed session (a closed terminal flips the chip red).
      this.poll = setInterval(() => void this.refresh(), 15_000);
    }
  }

  private async rpc<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (!this.client) throw new Error("not connected to the gateway");
    return this.client.request<T>(method, params ?? {}, timeoutMs ? { timeoutMs } : {});
  }

  private async refresh(): Promise<void> {
    try {
      publish(await this.rpc<CliRoutePayload>("voice.cliRoute.get"));
    } catch {
      /* gateway without the route RPCs / offline: keep the cached state */
    }
  }

  private async loadCatalogue(): Promise<void> {
    this.catalogueError = null;
    try {
      this.catalogue = await this.rpc<CliCatalogue>("voice.cliRoute.sessions");
    } catch (e) {
      this.catalogueError = errText(e);
    }
  }

  private emitChange(p: CliRoutePayload) {
    this.dispatchEvent(new CustomEvent(VOICE_CLI_ROUTE_CHANGE, { detail: p, bubbles: true, composed: true }));
  }

  private async run(key: string, fn: () => Promise<CliRoutePayload | void>) {
    this.busy = key;
    this.error = null;
    try {
      const p = await fn();
      if (p) {
        publish(p);
        this.emitChange(p);
      }
    } catch (e) {
      this.error = errText(e);
    } finally {
      this.busy = null;
    }
  }

  /** Brain picker: run API turns on `model` (null = the agent's model). Switches to API mode. */
  private pickModel(model: string | null) {
    const r = this.payload.route;
    if (r.mode === "api" && (r.model ?? null) === model) return;
    this.picking = model ?? "agent";
    void this.run(`model:${model ?? "agent"}`, () => this.rpc<CliRoutePayload>("voice.cliRoute.set", { mode: "api", model })).finally(() => {
      this.picking = null;
    });
  }

  private setApi() {
    if (this.payload.route.mode === "api") return;
    void this.run("api", () => this.rpc<CliRoutePayload>("voice.cliRoute.set", { mode: "api" }));
  }

  private chooseCli() {
    const r = this.payload.route;
    // A remembered session: switch straight back to it; otherwise pick one.
    if (r.mode === "api" && r.target && !r.fallback) {
      void this.run("cli", () => this.rpc<CliRoutePayload>("voice.cliRoute.set", { mode: "cli", target: r.target }));
      return;
    }
    this.openPicker();
  }

  private select(s: OpenSession) {
    void this.run(`sel:${s.id}`, async () => {
      const p = await this.rpc<CliRoutePayload>("voice.cliRoute.set", { mode: "cli", target: targetOf(s) });
      await this.loadCatalogue();
      return p;
    });
  }

  private start(cli: string) {
    void this.run(`start:${cli}`, async () => {
      const p = await this.rpc<CliRoutePayload>("voice.cliRoute.start", { cli, ...(this.cwd.trim() ? { cwd: this.cwd.trim() } : {}) });
      await this.loadCatalogue();
      return p;
    });
  }

  private interrupt() {
    void this.run("interrupt", async () => {
      await this.rpc("voice.cliRoute.interrupt");
      return this.rpc<CliRoutePayload>("voice.cliRoute.get");
    });
  }

  private sendTest() {
    const text = this.testText.trim();
    if (!text) return;
    void this.run("test", async () => {
      const r = await this.rpc<TestResult & CliRoutePayload>("voice.cliRoute.test", { text }, 60_000);
      this.test = r;
      this.testText = "";
      return { route: r.route, alive: r.alive, approval: r.approval, lastTurn: r.lastTurn };
    });
  }

  private openPicker() {
    this.open = true;
    void this.loadCatalogue();
    void this.updateComplete.then(() => void this.models?.load(false));
    void this.updateComplete.then(() => {
      const el = this.picker as (HTMLElement & { showPopover?: () => void }) | undefined;
      try {
        el?.showPopover?.();
      } catch {
        /* already open */
      }
      this.place();
      el?.querySelector<HTMLElement>(".row, .btn")?.focus?.();
    });
  }

  private closePicker() {
    const el = this.picker as (HTMLElement & { hidePopover?: () => void }) | undefined;
    try {
      el?.hidePopover?.();
    } catch {
      /* closed */
    }
    this.open = false;
  }

  /**
   * Anchor the top-layer picker to the control, fully inside the viewport.
   * Everything is computed in SCREEN pixels and divided by the page zoom
   * (viewport-scale.css zooms <body> to 0.7 on laptops; the popover inherits
   * it, so CSS px ≠ screen px). The picker itself is scaled up to a readable
   * 0.9 effective size when the page is zoomed out. Opens below the chip, or
   * above when there is more room there; its height is capped to the room it
   * has and the body scrolls. Phones get a full-width bottom sheet.
   */
  private place() {
    const el = this.picker;
    const a = this.anchor;
    if (!el || !a || !this.open) return;
    el.style.zoom = "";
    const r = a.getBoundingClientRect();
    const pageZoom = a.offsetWidth > 0 ? r.width / a.offsetWidth : 1;
    const own = pageZoom < 0.95 ? Math.min(1.4, 0.9 / pageZoom) : 1;
    if (own !== 1) el.style.zoom = String(own);
    const z = pageZoom * own; // CSS px → screen px inside the picker
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const css = (px: number) => `${Math.floor(px / z)}px`;
    if (vw <= 640) {
      const margin = 8;
      el.style.width = css(vw - margin * 2);
      el.style.maxHeight = css(Math.min(vh * 0.86, vh - margin * 2 - 48));
      el.style.left = css(margin);
      el.style.top = "auto";
      el.style.bottom = css(margin);
      return;
    }
    const margin = 12;
    const w = Math.min(560, vw - margin * 2);
    el.style.width = css(w);
    const below = vh - r.bottom - margin - 8;
    const above = r.top - margin - 8;
    const natural = Math.min(el.scrollHeight * z, 760);
    const openUp = natural > below && above > below;
    const room = Math.max(220, openUp ? above : below);
    el.style.maxHeight = css(Math.min(760, room));
    const h = Math.min(natural || room, room);
    const left = Math.max(margin, Math.min(r.right - w, vw - w - margin));
    el.style.left = css(left);
    el.style.bottom = "auto";
    el.style.top = css(openUp ? Math.max(margin, r.top - 8 - h) : Math.min(r.bottom + 8, vh - margin - h));
  }

  // ── render ────────────────────────────────────────────────────────────────

  render() {
    const sum = routeSummary(this.payload);
    const brain = brainSummary(this.payload.route.model, this.brainCatalog);
    const chip = html`<button class="chip anchor tone-${sum.tone}" data-testid="voice-cli-route-chip" aria-haspopup="dialog" aria-expanded=${this.open ? "true" : "false"}
        title=${sum.mode === "cli" ? sum.detail : `Voice brain: ${brain.detail}`} @click=${() => (this.open ? this.closePicker() : this.openPicker())}>
        <span class="dot"></span>
        ${this.variant === "pill" ? html`<span class="k">Brain</span>` : nothing}
        <span class="name">${sum.mode === "cli" ? sum.label : brain.title}</span>
        ${ICON_CHEVRON}
      </button>`;
    return html`${this.variant === "pill"
        ? chip
        : html`<div class="route" data-testid="voice-cli-route" data-mode=${sum.mode}>
            <div class="seg" role="radiogroup" aria-label="What answers your voice calls">
              <button role="radio" aria-checked=${sum.mode === "api" ? "true" : "false"} data-testid="voice-route-api" title="Voice → InfiniBot voice agent → LLM"
                ?disabled=${!!this.busy} @click=${() => this.setApi()}>API LLM</button>
              <button role="radio" aria-checked=${sum.mode === "cli" ? "true" : "false"} data-testid="voice-route-cli" title="Voice turns go to a CLI session you pick"
                ?disabled=${!!this.busy} @click=${() => this.chooseCli()}>CLI session</button>
            </div>
            ${chip}
          </div>`}
      <div id="picker" popover="manual" role="dialog" aria-label="Voice routing" data-testid="voice-cli-picker"
        @keydown=${(e: KeyboardEvent) => e.key === "Escape" && this.closePicker()}>
        ${this.open ? this.renderPicker() : nothing}
      </div>`;
  }

  private renderPicker() {
    const p = this.payload;
    const sum = routeSummary(p);
    const cat = this.catalogue;
    const open = cat ? sortOpenSessions(cat.open, p.route) : [];
    const brain = brainSummary(p.route.model, this.brainCatalog);
    const cloudUnavailable = cat?.runtime === "tenant-container" && cat.unavailableReason;
    return html`<div class="p-head">
        <div class="p-t">
          <h2>Voice brain</h2>
          <p>${sum.mode === "cli" ? "Your voice turns go to the CLI session below." : html`Answering with <b>${brain.detail}</b>. Pick any model, subscription or live CLI session.`}</p>
        </div>
        <button class="btn icon x" aria-label="Close" @click=${() => this.closePicker()}>${ICON_CLOSE}</button>
      </div>
      <div class="p-body">
        ${this.renderStatus()}
        ${this.error ? html`<div class="note err" role="alert">${this.error}</div>` : nothing}
        <voice-brain-models
          .client=${this.client}
          .current=${p.route.model ?? null}
          .pending=${this.picking}
          ?sessionRouted=${sum.mode === "cli"}
          @voice-brain-catalog=${(e: CustomEvent<BrainCatalog>) => {
            this.brainCatalog = e.detail;
            void this.updateComplete.then(() => this.place());
          }}
          @voice-brain-pick=${(e: CustomEvent<{ model: string | null }>) => this.pickModel(e.detail.model)}
        >
          <div slot="sessions" class="sess">
            <div class="sess-head">Live CLI sessions <span class="n">${cat ? open.length : "…"}</span></div>
            ${this.catalogueError
              ? html`<div class="note err">${this.catalogueError}</div>`
              : !cat
                ? html`<div class="empty">Looking for open terminals and coder runs…</div>`
                : cloudUnavailable
                  ? html`<div class="empty" data-testid="voice-cli-cloud-unavailable">${cloudUnavailable}</div>`
                  : open.length === 0
                  ? html`<div class="empty">No open terminals or running coders. Start one below.</div>`
                  : html`<div class="list" data-testid="voice-cli-open-list">${open.map((s) => this.renderOpen(s))}</div>`}
            <div class="sess-head">Start a new CLI session</div>
            <div class="cwd">
              <label for="cwd">Project folder (empty = agent workspace)</label>
              <input id="cwd" placeholder="~/Desktop/Development/app" .value=${this.cwd}
                @input=${(e: Event) => (this.cwd = (e.target as HTMLInputElement).value)} />
            </div>
            ${cat
              ? cat.installed.length
                ? html`<div class="list" data-testid="voice-cli-installed-list">${cat.installed.map(
                    (c) => html`<div class="cli-row" data-cli=${c.id}>
                      <span class="ic">${ICON_CPU}</span>
                      <span class="t"><b>${c.name}${c.coderBackend ? html` <span class="tag gold">coder backend</span>` : nothing}</b><span title=${c.path}>${c.path}</span></span>
                      <button class="btn ${this.busy === `start:${c.id}` ? "" : "primary"}" ?disabled=${!!this.busy} data-testid="voice-cli-start"
                        @click=${() => this.start(c.id)}>${ICON_PLUS} ${this.busy === `start:${c.id}` ? "Starting…" : "Start new"}</button>
                    </div>`,
                  )}</div>`
                : html`<div class="empty">No agent CLI found on this machine's PATH.</div>`
              : nothing}
            ${cat?.missing.length ? html`<div class="missing">Not installed: ${cat.missing.map((m) => cliName(m)).join(", ")}</div>` : nothing}
          </div>
        </voice-brain-models>
      </div>
      <div class="p-fade" aria-hidden="true"></div>`;
  }

  private renderStatus() {
    const p = this.payload;
    const r = p.route;
    const sum = routeSummary(p);
    if (r.mode !== "cli" || !r.target) {
      return html`<div class="status" data-testid="voice-cli-status">
        <div class="line"><span class="tag gold"><span class="dot" style="background:var(--glass-gold,#e6c15a)"></span>API</span> ${brainSummary(r.model, this.brainCatalog).detail}</div>
        ${r.fallback && Date.now() - Date.parse(r.fallback.at) < 30 * 60_000
          ? html`<div class="note fb" title=${r.fallback.reason}>Switched back from ${r.fallback.target?.label ?? "the CLI session"}: it stopped running.</div>`
          : nothing}
      </div>`;
    }
    return html`<div class="status" data-testid="voice-cli-status">
      <div class="line">
        <span class="tag ${sum.tone === "live" ? "ok" : "warn"}">${sum.tone === "live" ? "Routing" : sum.tone === "dead" ? "Not running" : "Waiting for you"}</span>
        <b>${cliName(r.target.cliType)}</b><span>· ${r.target.label}</span>
      </div>
      ${p.approval ? html`<div class="note" data-testid="voice-cli-approval">${p.approval.question} Answer “yes” or “no” on the call.</div>` : nothing}
      ${p.lastTurn
        ? html`<div class="spoken">Last turn: “${p.lastTurn.utterance}” → first words in <span class="ms">${p.lastTurn.firstSpokenMs ?? "—"} ms</span>, done in <span class="ms">${(p.lastTurn.totalMs / 1000).toFixed(1)} s</span></div>`
        : nothing}
      <div class="say">
        <input placeholder="Try it: type what you'd say" .value=${this.testText} data-testid="voice-cli-test-input"
          @input=${(e: Event) => (this.testText = (e.target as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => e.key === "Enter" && this.sendTest()} />
        <button class="btn" ?disabled=${!!this.busy || !this.testText.trim()} @click=${() => this.sendTest()}>${this.busy === "test" ? "…" : "Say"}</button>
        <button class="btn danger" ?disabled=${!!this.busy} title="Stop the session's current work" @click=${() => this.interrupt()}>Stop</button>
      </div>
      ${this.test
        ? html`<div class="spoken" data-testid="voice-cli-test-result">Spoken (first words <span class="ms">${this.test.firstTokenMs ?? "—"} ms</span>): ${this.test.spoken.map((s) => s.text).join("")}</div>`
        : nothing}
    </div>`;
  }

  private renderOpen(s: OpenSession) {
    const sel = isSelected(this.payload.route, s);
    const busy = this.busy === `sel:${s.id}`;
    return html`<button class="row ${sel ? "sel" : ""}" data-testid="voice-cli-session" data-kind=${s.kind} aria-pressed=${sel ? "true" : "false"}
      aria-disabled=${busy ? "true" : "false"} title=${s.task ?? s.cwd} @click=${() => !sel && !this.busy && this.select(s)}>
      <span class="ic">${s.kind === "coder" ? ICON_AGENT : ICON_TERMINAL}</span>
      <span class="t"><b>${s.label}</b><span>${cliName(s.cliType)}${s.cwd ? ` · ${shortCwd(s.cwd)}` : ""}</span></span>
      ${sel
        ? html`<span class="tag ok">Routing</span>`
        : busy
          ? html`<span class="tag">Connecting…</span>`
          : html`<span class="tag ${s.status === "detached" ? "warn" : ""}">${s.kind === "coder" ? "coder · running" : s.status === "detached" ? "reattach" : "live"}</span>`}
    </button>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "voice-cli-route-control": VoiceCliRouteControl;
  }
}

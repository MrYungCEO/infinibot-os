/**
 * <voice-hud-panels> — the Voice Terminal HUD layout + live panels.
 *
 * Owns the whole HUD grid. The central voice orb is projected in through
 * `<slot name="orb">` (the orb's WebGL host stays in <voice-floating-hud>), so
 * the orb cell and every panel live in ONE CSS grid and can never overlap:
 *
 *   wide  (≥ 980px usable):  [left column] [orb + quick actions] [right column]
 *   narrow:                  orb → tab bar → one panel at a time
 *
 * Insets are measured from the real app chrome (topbar, nav rail) and the
 * bottom voice dock, so panels never sit under them either.
 *
 * Panels (all live, existing gateway RPCs only — see hud-data.ts / hud-store.ts):
 *   Call · Conversation · System  |  Quick actions  |  Agents · Today · Needs attention
 *
 * Every panel element carries `data-hud-region` so
 * scripts/voice-hud-overlap-check.mjs can assert the no-overlap contract.
 */

import { LitElement, css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import type { GatewayBrowserClient } from "../../gateway";
import { icons } from "../../icons";
import { inferBasePathFromPathname, pathForTab, type Tab } from "../../navigation";
import {
  AGENT_STATUS_TEXT,
  agentTone,
  askAboutProjectPrompt,
  callStatus,
  clockTime,
  compactSpan,
  relTime,
  shapeAgents,
  shapeAttention,
  shapeCompletions,
  shapeSystem,
  shapeToday,
  type AttentionProject,
  type HudCallInput,
  type Tone,
} from "./hud-data.js";
import { hudStore, type HudRaw } from "./hud-store.js";
import { livePipelineModel, type LivePipelineInput } from "./live-state.js";

export type HudTranscriptLine = { id: string; who: "you" | "agent"; text: string; at: number };

/** Everything the panels need from the voice session (no RPC). */
export type HudCallSnapshot = HudCallInput & {
  connected: boolean;
  agents: Array<{ id: string; name: string }>;
  agentId: string | null;
  transcript: HudTranscriptLine[];
  pipeline: LivePipelineInput;
};

type PanelId = "call" | "transcript" | "system" | "actions" | "agents" | "today" | "projects";

const PANELS: Array<{ id: PanelId; title: string; tab: string; icon: TemplateResult }> = [
  { id: "call", title: "Call", tab: "Call", icon: icons.radio },
  { id: "transcript", title: "Conversation", tab: "Talk", icon: icons.messageSquare },
  { id: "agents", title: "Agents", tab: "Agents", icon: icons.bot },
  { id: "today", title: "Today", tab: "Today", icon: icons.calendar },
  { id: "projects", title: "Needs attention", tab: "Projects", icon: icons.alertCircle },
  { id: "system", title: "System", tab: "System", icon: icons.server },
  { id: "actions", title: "Quick actions", tab: "Actions", icon: icons.zap },
];

/** Example requests shown while the conversation is empty (hints, not data). */
const HINTS = [
  "What's on my plate today?",
  "How are my running agents doing?",
  "What's blocking my drifting projects?",
  "Capture an idea: …",
  "Spawn a coder to …",
];

const TAB_KEY = "voice-hud:tab";
const WIDE_MIN_W = 980;
const WIDE_MIN_H = 500;

function navigate(tab: string): void {
  try {
    const base = inferBasePathFromPathname(window.location.pathname);
    window.history.pushState({}, "", pathForTab(tab as Tab, base));
    window.dispatchEvent(new PopStateEvent("popstate"));
  } catch {
    /* best-effort route hop */
  }
}

function openAgentFocus(target: { runId: string; sessionKey: string; label: string; status?: string }): void {
  const w = window as unknown as { openAgentFocus?: (t: unknown) => void };
  if (typeof w.openAgentFocus === "function") w.openAgentFocus(target);
  else window.dispatchEvent(new CustomEvent("infinibot:open-agent-focus", { detail: target }));
}

/** Deep, shadow-piercing lookup for the app chrome around the HUD. */
function deepFind(sel: string): Element | null {
  const visit = (root: Document | ShadowRoot): Element | null => {
    const hit = root.querySelector(sel);
    if (hit) return hit;
    for (const el of Array.from(root.querySelectorAll("*"))) {
      const sr = (el as HTMLElement).shadowRoot;
      if (sr) {
        const r = visit(sr);
        if (r) return r;
      }
    }
    return null;
  };
  return visit(document);
}

/**
 * True when `el` is actually painted on top at its centre (not covered by the
 * HUD overlay). Walks elementFromPoint through shadow roots, then climbs the
 * composed tree back up looking for `el`.
 */
function isOnTop(el: Element, r: DOMRect): boolean {
  const x = r.left + Math.min(r.width / 2, 40);
  const y = r.top + r.height / 2;
  let hit: Element | null = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  for (let n: Node | null = hit; n; n = n.parentNode ?? (n as ShadowRoot).host ?? null) {
    if (n === el) return true;
  }
  return false;
}

function rectOf(el: Element | null): DOMRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

type SpeechCtor = new () => {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
};

function speechCtor(): SpeechCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

@customElement("voice-hud-panels")
export class VoiceHudPanels extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ attribute: false }) call: HudCallSnapshot | null = null;

  @state() private raw: HudRaw = hudStore.raw;
  @state() private mode: "wide" | "narrow" = "wide";
  @state() private tab: PanelId = "call";
  @state() private now = Date.now();
  @state() private captureText = "";
  @state() private captureBusy = false;
  @state() private captureMsg: { tone: Tone; text: string } | null = null;
  @state() private dictating = false;
  @state() private askBusy = new Set<string>();
  @state() private askMsg: string | null = null;

  private unsub: (() => void) | null = null;
  private clock: number | null = null;
  private ro: ResizeObserver | null = null;
  private chromeRo: ResizeObserver | null = null;
  private watched = new WeakSet<Element>();
  private recognizer: InstanceType<SpeechCtor> | null = null;
  private readonly onResize = () => this.measure();

  connectedCallback(): void {
    super.connectedCallback();
    try {
      const t = localStorage.getItem(TAB_KEY) as PanelId | null;
      if (t && PANELS.some((p) => p.id === t)) this.tab = t;
    } catch {
      /* storage blocked */
    }
    this.unsub = hudStore.subscribe(this.client, (raw) => (this.raw = raw));
    this.clock = window.setInterval(() => {
      if (!document.hidden) this.now = Date.now();
    }, 1000);
    window.addEventListener("resize", this.onResize);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsub?.();
    this.unsub = null;
    if (this.clock != null) window.clearInterval(this.clock);
    this.clock = null;
    window.removeEventListener("resize", this.onResize);
    this.ro?.disconnect();
    this.chromeRo?.disconnect();
    this.ro = this.chromeRo = null;
    this.watched = new WeakSet();
    try {
      this.recognizer?.stop();
    } catch {
      /* already stopped */
    }
  }

  protected willUpdate(changed: PropertyValues): void {
    // Re-subscribe when the gateway client is swapped after mount (the first
    // assignment is already covered by connectedCallback).
    if (changed.has("client") && changed.get("client") !== undefined && this.client && this.unsub) {
      this.unsub();
      this.unsub = hudStore.subscribe(this.client, (raw) => (this.raw = raw));
    }
  }

  protected firstUpdated(): void {
    this.ro = new ResizeObserver(() => this.measure());
    this.ro.observe(this);
    this.measure();
    // The topbar / nav / dock render asynchronously around us.
    window.setTimeout(() => this.measure(), 400);
    window.setTimeout(() => this.measure(), 1500);
  }

  /** Fit the grid between the real app chrome and the bottom voice dock. */
  private measure(): void {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const topEl = deepFind(".topbar");
    const top = rectOf(topEl);
    const navEl = deepFind(".nav");
    const navRect = rectOf(navEl);
    // Only make room for the nav rail when it is really visible above the HUD.
    const nav = navEl && navRect && isOnTop(navEl, navRect) ? navRect : null;
    const dockEl = deepFind("voice-controls-dock");
    const dock = rectOf(dockEl);
    // The chrome around us changes size after first paint (topbar pills load,
    // the dock expands): re-fit whenever any of it resizes.
    for (const el of [topEl, navEl, dockEl]) {
      if (!el || this.watched.has(el)) continue;
      this.chromeRo ??= new ResizeObserver(() => this.measure());
      this.chromeRo.observe(el);
      this.watched.add(el);
    }
    const gap = vw < 600 ? 8 : 14;
    // Target box in VIEWPORT coordinates: below the topbar, right of a visible
    // nav rail, inside the screen edges.
    const topV = Math.round((top && top.top < 40 ? top.bottom : 0) + gap);
    // A docked nav rail (tall, flush left) pushes the grid right; a drawer overlay does not.
    const leftV = Math.round(nav && nav.left < 40 && nav.height > vh * 0.5 && nav.width < vw * 0.4 ? nav.right + gap : gap);
    const rightV = vw - gap;
    const bottomV = vh - gap;
    const dockTopV = dock ? dock.top : vh - 84;
    const usableW = rightV - leftV;
    const usableH = bottomV - topV;
    const mode = usableW >= WIDE_MIN_W && usableH >= WIDE_MIN_H ? "wide" : "narrow";
    if (mode !== this.mode) this.mode = mode;
    // Our box is not guaranteed to start at the viewport origin (a transformed
    // ancestor re-parents position:fixed), so convert to host-relative insets.
    // The app may also scale the UI (CSS zoom / transform on an ancestor):
    // rects are in viewport px, our CSS lengths are in local px.
    const host = this.getBoundingClientRect();
    const k = this.offsetWidth > 0 && host.width > 0 ? host.width / this.offsetWidth : 1;
    const px = (v: number) => `${Math.round(v / k)}px`;
    const s = this.style;
    s.setProperty("--hud-top", px(topV - host.top));
    s.setProperty("--hud-left", px(leftV - host.left));
    s.setProperty("--hud-right", px(host.right - rightV));
    s.setProperty("--hud-bottom", px(host.bottom - bottomV));
    // Narrow layout ends above the dock; wide layout only reserves the dock's
    // height in the centre column (the side columns run to the bottom).
    s.setProperty("--hud-bottom-narrow", px(host.bottom - dockTopV + gap));
    s.setProperty("--hud-dock", px(Math.max(0, bottomV - dockTopV + gap)));
    s.setProperty("--hud-gap", px(gap));
  }

  private setTab(id: PanelId): void {
    this.tab = id;
    try {
      localStorage.setItem(TAB_KEY, id);
    } catch {
      /* storage blocked */
    }
  }

  private emit(name: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  // ── actions ───────────────────────────────────────────────────────────────

  private async capture(kind: "note" | "idea" | "task"): Promise<void> {
    const text = this.captureText.trim();
    if (!text || !this.client || this.captureBusy) return;
    this.captureBusy = true;
    this.captureMsg = null;
    const firstLine = text.split(/\n/)[0].slice(0, 160);
    try {
      await this.client.request(
        "capture.save",
        {
          draft: { kind, title: firstLine, body: text.length > firstLine.length ? text : "", transcript: text, structuredBy: "heuristic", tags: ["voice-hud"] },
          clientRequestId: `vhud-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        },
        { timeoutMs: 30_000 },
      );
      this.captureText = "";
      this.captureMsg = { tone: "ok", text: `Saved as ${kind}` };
      if (kind === "task") hudStore.refresh("proactive");
    } catch (err) {
      this.captureMsg = { tone: "bad", text: `Not saved: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      this.captureBusy = false;
    }
  }

  private toggleDictation(): void {
    const Ctor = speechCtor();
    if (!Ctor) return;
    if (this.dictating) {
      try {
        this.recognizer?.stop();
      } catch {
        /* noop */
      }
      return;
    }
    const rec = new Ctor();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = false;
    rec.continuous = false;
    const before = this.captureText;
    rec.onresult = (e) => {
      const said = Array.from(e.results)
        .map((r) => r[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (said) this.captureText = before ? `${before} ${said}` : said;
    };
    rec.onend = () => {
      this.dictating = false;
      this.recognizer = null;
    };
    rec.onerror = () => {
      this.captureMsg = { tone: "warn", text: "Dictation unavailable — type instead" };
    };
    try {
      rec.start();
      this.recognizer = rec;
      this.dictating = true;
    } catch {
      this.captureMsg = { tone: "warn", text: "Dictation unavailable — type instead" };
    }
  }

  /** "Ask" → send the question to the main agent's quick chat and open it. */
  private async askAbout(p: AttentionProject): Promise<void> {
    if (!this.client || this.askBusy.has(p.projectId)) return;
    this.askBusy = new Set(this.askBusy).add(p.projectId);
    this.askMsg = null;
    try {
      await this.client.request(
        "chat.send",
        { sessionKey: "agent:main:quick-chat", message: askAboutProjectPrompt(p), deliver: false, idempotencyKey: `vhud-ask-${p.projectId}-${Date.now()}` },
        { timeoutMs: 20_000 },
      );
      window.dispatchEvent(new CustomEvent("infinibot:agent-chat", { detail: { action: "open", agentId: "main" } }));
    } catch (err) {
      this.askMsg = `Couldn't ask: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      const next = new Set(this.askBusy);
      next.delete(p.projectId);
      this.askBusy = next;
    }
  }

  // ── render helpers ───────────────────────────────────────────────────────

  private panel(id: PanelId, body: TemplateResult, opts: { meta?: TemplateResult | string; link?: { label: string; onClick: () => void } } = {}) {
    const def = PANELS.find((p) => p.id === id)!;
    const active = this.mode === "wide" || this.tab === id;
    return html`<section class="panel p-${id} ${active ? "active" : ""}" data-hud-region=${id} aria-label=${def.title} role="region">
      <header class="ph">
        <span class="ph-ic" aria-hidden="true">${def.icon}</span>
        <h3 class="ph-title">${def.title}</h3>
        ${opts.meta ? html`<span class="ph-meta">${opts.meta}</span>` : nothing}
        ${opts.link
          ? html`<button class="ph-link" type="button" title=${opts.link.label} aria-label=${opts.link.label} @click=${opts.link.onClick}>
              ${icons.externalLink}
            </button>`
          : nothing}
      </header>
      <div class="pb">${body}</div>
    </section>`;
  }

  private stateLine(s: { loading: boolean; error: string | null; data: unknown }, emptyText: string, isEmpty: boolean): TemplateResult | null {
    if (s.loading && s.data == null) return html`<div class="st st-loading"><span class="spin" aria-hidden="true"></span>Loading…</div>`;
    if (s.error && s.data == null) return html`<div class="st st-error" title=${s.error}>${icons.alertCircle}<span class="trunc">Unavailable: ${s.error}</span></div>`;
    if (isEmpty) return html`<div class="st st-empty">${emptyText}</div>`;
    return null;
  }

  private chip(text: string, tone: Tone) {
    return html`<span class="chip t-${tone}">${text}</span>`;
  }

  // ── panels ───────────────────────────────────────────────────────────────

  private renderCall() {
    const c = this.call;
    if (!c) return this.panel("call", html`<div class="st st-loading"><span class="spin"></span>Starting voice…</div>`);
    const s = callStatus(c);
    const m = livePipelineModel(c.pipeline);
    const inCall = c.phase === "active" || c.phase === "starting" || c.phase === "connecting";
    const body = html`
      <div class="kv">
        <span class="k">Engine</span><span class="v trunc" title=${s.engine}>${s.engine}</span>
        <span class="k">Route</span><span class="v trunc" title=${s.route}>${s.route}</span>
        <span class="k">Agent</span>
        <span class="v">
          ${c.agents.length > 1
            ? html`<select class="sel" aria-label="Voice agent to call" ?disabled=${inCall} title=${inCall ? "Hang up to switch agent" : "Switch the agent you call"}
                @change=${(e: Event) => this.emit("session-agent", { id: (e.target as HTMLSelectElement).value })}>
                ${c.agents.map((a) => html`<option value=${a.id} ?selected=${a.id === c.agentId}>${a.name}</option>`)}
              </select>`
            : html`<span class="trunc" title=${c.agentName}>${c.agentName}</span>`}
        </span>
        <span class="k">Mic</span>
        <span class="v"><span class="mic-meter ${c.muted ? "muted" : ""}" title=${c.muted ? "Microphone muted" : "Live microphone level"}><span class="mic-fill"></span></span></span>
      </div>
      <div class="stages" aria-label="Pipeline latency">
        ${m.stages.map(
          (st, i) => html`<div class="stage ${st.active ? "on" : ""}">
            <span class="stage-l">${st.label}</span>
            <span class="stage-p trunc" title=${`${st.provider}${st.model ? ` · ${st.model}` : ""}`}>${st.provider}${st.model ? html`<span class="dim"> · ${st.model}</span>` : nothing}</span>
            <span class="stage-ms" title=${i === 1 ? "Speech end → first LLM token" : i === 2 ? "First LLM token → first audio" : "Speech to text"}>${i > 0 && m.connectors[i - 1].ms != null ? `${m.connectors[i - 1].ms}ms` : ""}</span>
          </div>`,
        )}
      </div>
      <div class="foot">
        <span class="trunc">${c.error && c.phase === "failed" ? c.error : c.blockedReason && !inCall ? c.blockedReason : m.footer}</span>
        <span class="lat">${m.totalMs != null
          ? html`last <b style=${`color:${m.tier.color}`}>${m.totalMs}ms</b>${m.avgMs != null ? html` · avg ${m.avgMs}ms` : nothing}`
          : html`no turns yet`}</span>
      </div>`;
    return this.panel("call", body, {
      meta: html`<span class="dot t-${s.tone}"></span>${s.label}`,
      link: { label: "Voice pipeline settings", onClick: () => this.emit("session-settings") },
    });
  }

  private renderTranscript() {
    const lines = this.call?.transcript ?? [];
    const recent = lines.slice(-40);
    const body = recent.length
      ? html`<ol class="tx">
          ${repeat(
            recent,
            (l) => l.id,
            (l) => html`<li class="tx-line ${l.who}">
              <span class="tx-who">${l.who === "you" ? "You" : this.call?.agentName ?? "Agent"}<span class="tx-at">${clockTime(l.at)}</span></span>
              <span class="tx-text">${l.text}</span>
            </li>`,
          )}
        </ol>`
      : html`<div class="st st-empty">No conversation yet. Press <b>Connect</b> in the dock (or the <kbd>E</kbd> key) and start talking — every turn shows up here.</div>
          <div class="sub-h">Try asking</div>
          <ul class="hints">
            ${HINTS.map((h) => html`<li class="hint trunc" title=${h}>${h}</li>`)}
          </ul>`;
    return this.panel("transcript", body, { meta: recent.length ? `${lines.length} turns` : undefined });
  }

  protected updated(): void {
    // Keep the conversation pinned to the newest line.
    const tx = this.renderRoot.querySelector(".p-transcript .pb");
    if (tx && tx.scrollHeight - tx.scrollTop - tx.clientHeight < 120) tx.scrollTop = tx.scrollHeight;
  }

  private renderAgents() {
    const sec = this.raw.agents;
    const agents = shapeAgents(sec.data);
    const comp = shapeCompletions(this.raw.completions.data, this.now, 4);
    const blocked = agents.filter((a) => a.status === "blocked" || a.status === "needs_input").length;
    const st = this.stateLine(sec, "No agents running.", agents.length === 0);
    const body = html`
      ${comp.restartPending.length
        ? html`<button class="banner t-warn" type="button" title=${comp.restartPending.map((r) => r.label).join("\n")}
            @click=${() => navigate("activity")}>
            ${icons.refresh}<span class="trunc"><b>Restart pending</b> · ${comp.restartPending.length === 1 ? comp.restartPending[0].label : `${comp.restartPending.length} finished runs`}</span>
          </button>`
        : nothing}
      ${st ??
      html`<ul class="list">
        ${repeat(
          agents.slice(0, 8),
          (a) => a.runId,
          (a) => html`<li>
            <button class="row" type="button" title=${`${a.label}\n${a.activity}`} @click=${() => openAgentFocus({ runId: a.runId, sessionKey: a.sessionKey, label: a.label, status: a.status })}>
              <span class="row-main">
                <span class="row-title trunc">${a.label}</span>
                <span class="row-sub trunc">${a.activity || a.backend}</span>
              </span>
              <span class="row-side">
                ${this.chip(AGENT_STATUS_TEXT[a.status], agentTone(a.status))}
                <span class="age">${compactSpan(this.now - a.startedAt)}</span>
              </span>
            </button>
          </li>`,
        )}
        ${agents.length > 8 ? html`<li class="more">+${agents.length - 8} more</li>` : nothing}
      </ul>`}
      <div class="sub-h">Latest results</div>
      ${this.stateLine(this.raw.completions, "No finished runs in the last 24h.", comp.recent.length === 0) ??
      html`<ul class="list">
        ${comp.recent.map(
          (r) => html`<li>
            <button class="row" type="button" title=${`${r.label}${r.summary ? `\n${r.summary}` : ""}`} @click=${() => openAgentFocus({ runId: r.runId, sessionKey: r.sessionKey, label: r.label })}>
              <span class="row-main">
                <span class="row-title trunc">${r.label}</span>
                <span class="row-sub trunc">${r.summary || relTime(r.finishedAt, this.now)}</span>
              </span>
              <span class="row-side">
                ${this.chip(r.verdictText, r.tone)}
                ${r.deployText ? html`<span class="age">${r.deployText}</span>` : html`<span class="age">${compactSpan(this.now - r.finishedAt)}</span>`}
              </span>
            </button>
          </li>`,
        )}
      </ul>`}`;
    return this.panel("agents", body, {
      meta: sec.data != null ? html`${agents.length} running${blocked ? html` · <span class="t-warn-text">${blocked} blocked</span>` : nothing}` : undefined,
      link: { label: "Open Activity", onClick: () => navigate("activity") },
    });
  }

  private renderToday() {
    const model = shapeToday({ calendar: this.raw.calendar.data, scheduled: this.raw.scheduled.data, proactive: this.raw.proactive.data, now: this.now });
    const anyData = this.raw.calendar.data != null || this.raw.scheduled.data != null || this.raw.proactive.data != null;
    const loading = !anyData && (this.raw.calendar.loading || this.raw.proactive.loading);
    const err = !anyData && !loading ? this.raw.proactive.error ?? this.raw.calendar.error : null;
    const st = this.stateLine({ loading, error: err, data: anyData ? {} : null }, "Nothing left on today's calendar or schedule.", model.items.length === 0);
    const counts = html`<div class="counts">
      <span class="count ${model.overdue ? "t-bad-text" : ""}" title="Overdue tasks"><b>${model.overdue}</b> overdue</span>
      <span class="count ${model.p0 ? "t-warn-text" : ""}" title="P0 tasks"><b>${model.p0}</b> P0</span>
      <button class="count link ${model.awaitingDecision ? "t-warn-text" : ""}" type="button" title="Scheduled-task suggestions waiting for your decision" @click=${() => navigate("schedule")}>
        <b>${model.awaitingDecision}</b> to decide
      </button>
    </div>`;
    const body = html`${anyData ? counts : nothing}
      ${st ??
      html`<ul class="list">
        ${model.items.slice(0, 8).map(
          (it) => html`<li>
            <button class="row today" type="button" title=${`${it.title}\n${it.detail}`}
              @click=${() => {
                if (it.link.tab) navigate(it.link.tab);
                else window.dispatchEvent(new CustomEvent("infinibot:kanban-open-task", { detail: { taskId: it.link.taskId, projectId: it.link.projectId } }));
              }}>
              <span class="when t-${it.tone}-text">${it.when}</span>
              <span class="row-main">
                <span class="row-title trunc">${it.title}</span>
                <span class="row-sub trunc">${it.detail}</span>
              </span>
            </button>
          </li>`,
        )}
      </ul>`}`;
    return this.panel("today", body, {
      meta: model.openTasks != null ? `${model.openTasks} open tasks` : undefined,
      link: { label: "Open Schedule", onClick: () => navigate("schedule") },
    });
  }

  private renderProjects() {
    const sec = this.raw.proactive;
    const list = shapeAttention(sec.data, 8);
    const st = this.stateLine(sec, "Every active project is moving. Nothing needs you.", list.length === 0);
    const body = html`${this.askMsg ? html`<div class="st st-error trunc" title=${this.askMsg}>${this.askMsg}</div>` : nothing}
      ${st ??
      html`<ul class="list">
        ${list.map(
          (p) => html`<li class="proj">
            <button class="row" type="button" title=${`${p.name}\n${p.reason}`}
              @click=${() => window.dispatchEvent(new CustomEvent("infinibot:kanban-open-task", { detail: { projectId: p.projectId } }))}>
              <span class="row-main">
                <span class="row-title trunc">${p.name}</span>
                <span class="row-sub trunc">${p.reason}</span>
              </span>
              ${this.chip(p.state, p.tone)}
            </button>
            <button class="ask" type="button" ?disabled=${this.askBusy.has(p.projectId)} title=${`Ask the agent about ${p.name}`} @click=${() => void this.askAbout(p)}>
              ${this.askBusy.has(p.projectId) ? html`<span class="spin"></span>` : icons.messageSquare}<span>Ask</span>
            </button>
          </li>`,
        )}
      </ul>`}`;
    return this.panel("projects", body, {
      meta: list.length ? `${list.length}` : undefined,
      link: { label: "Open Projects", onClick: () => navigate("projects") },
    });
  }

  private renderSystem() {
    const sys = shapeSystem({
      connected: Boolean(this.client?.connected),
      version: this.raw.version.data,
      hardware: this.raw.hardware.data,
      notion: this.raw.notion.data,
    });
    const hwState = this.stateLine(this.raw.hardware, "No telemetry from this host.", sys.meters.length === 0);
    const body = html`
      <div class="kv">
        <span class="k">Gateway</span>
        <span class="v"><span class="dot t-${sys.gateway.ok ? "ok" : "bad"}"></span>${sys.gateway.text}${sys.version ? html`<span class="dim"> · v${sys.version}</span>` : nothing}</span>
        <span class="k">Uptime</span><span class="v">${sys.uptime}</span>
        <span class="k">Notion</span>
        <span class="v">${sys.notion
          ? html`<span class="dot t-${sys.notion.tone}"></span>${sys.notion.text}`
          : this.raw.notion.error
            ? html`<span class="dim trunc" title=${this.raw.notion.error}>not connected</span>`
            : html`<span class="dim">—</span>`}</span>
        ${sys.nodes.total > 1 ? html`<span class="k">Nodes</span><span class="v">${sys.nodes.online}/${sys.nodes.total} online</span>` : nothing}
      </div>
      ${hwState ??
      html`<div class="meters" title=${sys.host ?? ""}>
        ${sys.meters.map(
          (m) => html`<div class="meter t-${m.tone}">
            <span class="m-l">${m.label}</span>
            <span class="m-track"><span class="m-fill" style=${`width:${Math.max(2, m.pct)}%`}></span></span>
            <span class="m-v">${m.pct}%</span>
          </div>`,
        )}
      </div>`}`;
    return this.panel("system", body, {
      meta: sys.host ? html`<span class="trunc" title=${sys.host}>${sys.host}</span>` : undefined,
      link: { label: "Open Hardware", onClick: () => navigate("hardware") },
    });
  }

  private renderActions() {
    const canDictate = speechCtor() != null;
    const body = html`
      <div class="cap">
        <div class="cap-row">
          <input class="cap-in" type="text" .value=${this.captureText} maxlength="2000" placeholder="Capture a note, idea or task…" aria-label="Capture text"
            @input=${(e: Event) => (this.captureText = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              e.stopPropagation(); // keep the voice page's "E" shortcut out of typing
              if (e.key === "Enter") void this.capture("note");
            }} />
          ${canDictate
            ? html`<button class="ibtn ${this.dictating ? "on" : ""}" type="button" title=${this.dictating ? "Stop dictation" : "Dictate"} aria-label="Dictate" @click=${() => this.toggleDictation()}>${icons.mic}</button>`
            : nothing}
        </div>
        <div class="cap-btns">
          ${(["note", "idea", "task"] as const).map(
            (k) => html`<button class="btn" type="button" ?disabled=${!this.captureText.trim() || this.captureBusy} @click=${() => void this.capture(k)}>
              ${k === "note" ? icons.fileText : k === "idea" ? icons.lightbulb : icons.checkCircle}<span>${k[0].toUpperCase()}${k.slice(1)}</span>
            </button>`,
          )}
        </div>
        ${this.captureMsg ? html`<div class="cap-msg t-${this.captureMsg.tone}-text trunc" title=${this.captureMsg.text}>${this.captureMsg.text}</div>` : nothing}
      </div>
      <div class="go">
        <button class="btn ghost" type="button" title="Open a chat with your main agent" @click=${() => window.dispatchEvent(new CustomEvent("infinibot:agent-chat", { detail: { action: "open", agentId: "main" } }))}>
          ${icons.bot}<span>Agent chat</span>
        </button>
        <button class="btn ghost" type="button" title="Open the CLI terminals" @click=${() => navigate("terminals")}>${icons.terminal}<span>Terminals</span></button>
        <button class="btn ghost" type="button" title="Leave the HUD" @click=${() => this.emit("exit-hud")}>${icons.minimize}<span>Exit HUD</span></button>
      </div>`;
    return this.panel("actions", body);
  }

  render() {
    const narrow = this.mode === "narrow";
    return html`<div class="grid ${this.mode}" data-mode=${this.mode}>
      <div class="col left">${this.renderCall()}${this.renderTranscript()}${this.renderSystem()}</div>
      <div class="center">
        <div class="orb-cell" data-hud-region="orb"><slot name="orb"></slot></div>
        ${this.renderActions()}
      </div>
      <div class="col right">${this.renderAgents()}${this.renderToday()}${this.renderProjects()}</div>
      ${narrow
        ? html`<nav class="tabs" data-hud-region="tabs" role="tablist" aria-label="HUD panels">
            ${PANELS.map(
              (p) => html`<button class="tab ${this.tab === p.id ? "on" : ""}" role="tab" aria-selected=${this.tab === p.id} type="button" @click=${() => this.setTab(p.id)}>
                ${p.icon}<span>${p.tab}</span>
              </button>`,
            )}
          </nav>`
        : nothing}
    </div>`;
  }

  static styles = css`
    :host {
      --g: #f5c84b;
      --g-soft: rgba(245, 200, 75, 0.22);
      --g-faint: rgba(245, 200, 75, 0.1);
      --champ: #ffe49a;
      --cyan: #7cf5ff;
      --fg: #eee7d6;
      --dim: rgba(238, 231, 214, 0.62);
      --faint: rgba(238, 231, 214, 0.4);
      --ok: #4ade80;
      --warn: #fbbf24;
      --bad: #f87171;
      --info: #7cf5ff;
      --glass: rgba(6, 8, 13, 0.78);
      position: absolute;
      inset: 0;
      z-index: 6;
      display: block;
      pointer-events: none;
      color: var(--fg);
      font-family: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
      font-size: 12.5px;
    }
    .grid {
      position: absolute;
      top: var(--hud-top, 64px);
      left: var(--hud-left, 14px);
      right: var(--hud-right, 14px);
      bottom: var(--hud-bottom, 14px);
      display: grid;
      gap: var(--hud-gap, 14px);
      min-width: 0;
      min-height: 0;
    }
    .grid.wide {
      grid-template-columns: clamp(270px, 24vw, 380px) minmax(0, 1fr) clamp(270px, 24vw, 380px);
      grid-template-rows: minmax(0, 1fr);
      grid-template-areas: "left center right";
    }
    .col {
      display: flex;
      flex-direction: column;
      gap: var(--hud-gap, 14px);
      min-height: 0;
      min-width: 0;
    }
    .col.left { grid-area: left; }
    .col.right { grid-area: right; }
    .center {
      grid-area: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--hud-gap, 14px);
      min-height: 0;
      min-width: 0;
      padding-bottom: var(--hud-dock, 84px);
    }
    .orb-cell {
      flex: 1 1 auto;
      width: 100%;
      min-height: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    .orb-cell ::slotted(*) { width: 100%; height: 100%; }
    .wide .p-call { flex: 0 1 auto; }
    .wide .p-transcript { flex: 1 1 0; min-height: 140px; }
    .wide .p-system { flex: 0 1 auto; }
    .wide .p-agents { flex: 1.4 1 0; min-height: 150px; }
    .wide .p-today { flex: 1 1 0; min-height: 120px; }
    .wide .p-projects { flex: 1 1 0; min-height: 120px; }
    .wide .p-actions { flex: 0 0 auto; width: min(100%, 560px); }

    /* ── narrow: orb → tabs → one panel ── */
    .grid.narrow {
      bottom: var(--hud-bottom-narrow, 84px);
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: clamp(120px, 24vh, 240px) auto minmax(0, 1fr);
      grid-template-areas: "orb" "tabs" "deck";
    }
    .narrow .col,
    .narrow .center { display: contents; }
    .narrow .orb-cell { grid-area: orb; }
    .narrow .panel { grid-area: deck; display: none; }
    .narrow .panel.active { display: flex; }
    .tabs {
      grid-area: tabs;
      display: flex;
      gap: 6px;
      overflow-x: auto;
      scrollbar-width: none;
      pointer-events: auto;
      min-width: 0;
    }
    .tabs::-webkit-scrollbar { display: none; }
    .tab {
      flex: 1 0 44px;
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      min-height: 44px;
      padding: 4px 2px;
      border-radius: 10px;
      border: 1px solid var(--g-soft);
      background: var(--glass);
      color: var(--dim);
      font: 600 8.5px/1 "JetBrains Mono", ui-monospace, monospace;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      cursor: pointer;
      white-space: nowrap;
    }
    .tab svg { width: 15px; height: 15px; }
    .tab.on { color: var(--champ); border-color: var(--g); box-shadow: 0 0 14px -4px var(--g); }

    /* ── panel chrome: smoked glass, thin gold edge, corner light ── */
    .panel {
      position: relative;
      display: flex;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
      overflow: hidden;
      pointer-events: auto;
      background: linear-gradient(180deg, rgba(14, 16, 22, 0.86), var(--glass));
      border: 1px solid var(--g-soft);
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 228, 154, 0.06);
      backdrop-filter: blur(10px) saturate(120%);
      -webkit-backdrop-filter: blur(10px) saturate(120%);
    }
    .panel::before {
      content: "";
      position: absolute;
      top: -1px;
      left: 14px;
      width: 46px;
      height: 2px;
      border-radius: 2px;
      background: linear-gradient(90deg, var(--g), transparent);
      opacity: 0.8;
    }
    .ph {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 10px 7px 12px;
      border-bottom: 1px solid var(--g-faint);
      flex: 0 0 auto;
      min-width: 0;
    }
    .ph-ic { color: var(--g); display: inline-flex; }
    .ph-ic svg { width: 14px; height: 14px; }
    .ph-title {
      margin: 0;
      font: 700 10.5px/1.2 "JetBrains Mono", ui-monospace, monospace;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--champ);
      white-space: nowrap;
    }
    .ph-meta {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      overflow: hidden;
      font: 500 10.5px/1.2 "JetBrains Mono", ui-monospace, monospace;
      color: var(--dim);
      white-space: nowrap;
    }
    .ph-meta + .ph-link, .ph-title + .ph-link { margin-left: 4px; }
    .ph-title + .ph-link { margin-left: auto; }
    .ph-link {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      border-radius: 7px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--faint);
      cursor: pointer;
    }
    .ph-link svg { width: 13px; height: 13px; }
    .ph-link:hover, .ph-link:focus-visible { color: var(--champ); border-color: var(--g-soft); outline: none; }
    .pb {
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 8px 12px 10px;
      scrollbar-width: thin;
      scrollbar-color: rgba(245, 200, 75, 0.25) transparent;
    }

    /* ── shared bits ── */
    .trunc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .dim { color: var(--faint); }
    .dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; display: inline-block; margin-right: 6px; background: var(--faint); }
    .dot.t-ok { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
    .dot.t-warn { background: var(--warn); box-shadow: 0 0 8px var(--warn); }
    .dot.t-bad { background: var(--bad); box-shadow: 0 0 8px var(--bad); }
    .dot.t-info { background: var(--info); box-shadow: 0 0 8px var(--info); }
    .t-ok-text { color: var(--ok); }
    .t-warn-text { color: var(--warn); }
    .t-bad-text { color: var(--bad); }
    .t-info-text { color: var(--info); }
    .t-muted-text { color: var(--faint); }
    .chip {
      flex: 0 0 auto;
      font: 600 9.5px/1 "JetBrains Mono", ui-monospace, monospace;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 3px 6px;
      border-radius: 5px;
      border: 1px solid currentColor;
      white-space: nowrap;
    }
    .chip.t-ok { color: var(--ok); background: rgba(74, 222, 128, 0.08); }
    .chip.t-warn { color: var(--warn); background: rgba(251, 191, 36, 0.08); }
    .chip.t-bad { color: var(--bad); background: rgba(248, 113, 113, 0.08); }
    .chip.t-info { color: var(--info); background: rgba(124, 245, 255, 0.08); }
    .chip.t-muted { color: var(--faint); }
    .st { display: flex; align-items: center; gap: 8px; padding: 10px 2px; color: var(--dim); line-height: 1.45; min-width: 0; }
    .st svg { width: 14px; height: 14px; flex: 0 0 auto; }
    .st-error { color: var(--bad); }
    .st-empty { display: block; color: var(--faint); }
    .st-empty b { color: var(--champ); font-weight: 600; }
    kbd { font: 600 10px "JetBrains Mono", monospace; border: 1px solid var(--g-soft); border-radius: 4px; padding: 0 4px; color: var(--champ); }
    .spin {
      width: 11px;
      height: 11px;
      border-radius: 50%;
      border: 2px solid var(--g-soft);
      border-top-color: var(--g);
      animation: spin 0.9s linear infinite;
      flex: 0 0 auto;
      display: inline-block;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .kv {
      display: grid;
      grid-template-columns: 58px minmax(0, 1fr);
      gap: 5px 10px;
      align-items: center;
      min-width: 0;
    }
    .k { font: 600 9.5px/1.3 "JetBrains Mono", ui-monospace, monospace; letter-spacing: 0.12em; text-transform: uppercase; color: var(--faint); }
    .v { display: flex; align-items: center; min-width: 0; color: var(--fg); }
    .sel {
      width: 100%;
      min-width: 0;
      height: 26px;
      padding: 0 8px;
      border-radius: 7px;
      border: 1px solid var(--g-soft);
      background: rgba(0, 0, 0, 0.35);
      color: var(--fg);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .sel:disabled { opacity: 0.6; cursor: not-allowed; }
    .sel option { background: #0b0b0d; color: #eee; }
    .mic-meter {
      position: relative;
      flex: 1;
      height: 6px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.06);
      overflow: hidden;
    }
    .mic-fill {
      position: absolute;
      inset: 0 auto 0 0;
      width: calc(var(--hud-mic, 0) * 100%);
      background: linear-gradient(90deg, var(--g), var(--champ));
      box-shadow: 0 0 8px var(--g);
      transition: width 80ms linear;
    }
    .mic-meter.muted .mic-fill { background: var(--bad); box-shadow: none; }
    .stages { margin-top: 9px; display: grid; gap: 4px; }
    .stage {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      padding: 4px 8px;
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.025);
      border: 1px solid transparent;
    }
    .stage.on { border-color: var(--g-soft); background: rgba(245, 200, 75, 0.07); }
    .stage-l { font: 700 10px "JetBrains Mono", monospace; letter-spacing: 0.1em; color: var(--g); }
    .stage-p { color: var(--fg); }
    .stage-ms { font: 500 10.5px "JetBrains Mono", monospace; color: var(--dim); font-variant-numeric: tabular-nums; }
    .foot {
      margin-top: 8px;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      font: 500 10.5px/1.3 "JetBrains Mono", monospace;
      color: var(--faint);
      min-width: 0;
    }
    .lat { flex: 0 0 auto; white-space: nowrap; }
    .lat b { font-weight: 700; }

    /* conversation */
    .tx { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; }
    .tx-line { display: grid; gap: 2px; padding: 6px 9px; border-radius: 9px; min-width: 0; }
    .tx-line.you { background: rgba(255, 255, 255, 0.035); border: 1px solid rgba(255, 255, 255, 0.06); }
    .tx-line.agent { background: rgba(245, 200, 75, 0.07); border: 1px solid var(--g-soft); }
    .tx-who { font: 700 9.5px/1.2 "JetBrains Mono", monospace; letter-spacing: 0.12em; text-transform: uppercase; color: var(--dim); display: flex; gap: 8px; }
    .agent .tx-who { color: var(--g); }
    .tx-at { color: var(--faint); font-weight: 500; letter-spacing: 0.04em; }
    .tx-text { line-height: 1.45; overflow-wrap: anywhere; color: var(--fg); }

    /* lists */
    .list { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; min-width: 0; }
    .row {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      padding: 6px 8px;
      border-radius: 8px;
      border: 1px solid transparent;
      background: rgba(255, 255, 255, 0.025);
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .row:hover, .row:focus-visible { border-color: var(--g-soft); background: rgba(245, 200, 75, 0.06); outline: none; }
    .row-main { display: grid; gap: 2px; flex: 1 1 auto; min-width: 0; }
    .row-title { color: var(--fg); font-weight: 500; }
    .row-sub { color: var(--faint); font-size: 11px; }
    .row-side { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex: 0 0 auto; }
    .age { font: 500 10px "JetBrains Mono", monospace; color: var(--faint); white-space: nowrap; }
    .more { color: var(--faint); font-size: 11px; padding: 2px 8px; }
    .sub-h {
      margin: 10px 0 5px;
      font: 700 9.5px/1 "JetBrains Mono", monospace;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--faint);
    }
    .banner {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      padding: 7px 9px;
      border-radius: 8px;
      font: inherit;
      text-align: left;
      cursor: pointer;
      min-width: 0;
    }
    .banner svg { width: 14px; height: 14px; flex: 0 0 auto; }
    .banner.t-warn { color: var(--warn); background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251, 191, 36, 0.35); }
    .row.today { align-items: flex-start; }
    .when {
      flex: 0 0 52px;
      font: 700 10.5px/1.5 "JetBrains Mono", monospace;
      letter-spacing: 0.04em;
      font-variant-numeric: tabular-nums;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .counts { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
    .count {
      font: 500 10.5px/1 "JetBrains Mono", monospace;
      color: var(--dim);
      padding: 5px 8px;
      border-radius: 6px;
      border: 1px solid var(--g-faint);
      background: rgba(255, 255, 255, 0.02);
      white-space: nowrap;
    }
    .count b { color: inherit; font-weight: 700; }
    .count.link { cursor: pointer; }
    .count.link:hover { border-color: var(--g-soft); }
    .proj { display: flex; gap: 6px; align-items: stretch; min-width: 0; }
    .proj .row { flex: 1 1 auto; }
    .ask {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 0 9px;
      border-radius: 8px;
      border: 1px solid var(--g-soft);
      background: rgba(245, 200, 75, 0.06);
      color: var(--champ);
      font: 600 11px "JetBrains Mono", monospace;
      cursor: pointer;
    }
    .ask svg { width: 13px; height: 13px; }
    .ask:hover:not(:disabled) { border-color: var(--g); }
    .ask:disabled { opacity: 0.6; cursor: wait; }
    .hints { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
    .hint {
      padding: 6px 9px;
      border-radius: 8px;
      border: 1px dashed var(--g-faint);
      color: var(--dim);
      font-size: 12px;
    }
    .hint::before { content: "“"; color: var(--g); margin-right: 2px; }
    .hint::after { content: "”"; color: var(--g); margin-left: 1px; }
    .meters { margin-top: 9px; display: grid; gap: 6px; }
    .meter { display: grid; grid-template-columns: 34px minmax(0, 1fr) 38px; gap: 8px; align-items: center; }
    .m-l { font: 700 10px "JetBrains Mono", monospace; letter-spacing: 0.1em; color: var(--faint); }
    .m-track { height: 6px; border-radius: 3px; background: rgba(255, 255, 255, 0.06); overflow: hidden; }
    .m-fill { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, var(--g), var(--champ)); }
    .meter.t-warn .m-fill { background: var(--warn); }
    .meter.t-bad .m-fill { background: var(--bad); }
    .m-v { font: 600 10.5px "JetBrains Mono", monospace; color: var(--dim); text-align: right; font-variant-numeric: tabular-nums; }

    /* quick actions */
    .cap { display: grid; gap: 8px; }
    .cap-row { display: flex; gap: 6px; min-width: 0; }
    .cap-in {
      flex: 1 1 auto;
      min-width: 0;
      height: 34px;
      padding: 0 11px;
      border-radius: 9px;
      border: 1px solid var(--g-soft);
      background: rgba(0, 0, 0, 0.4);
      color: var(--fg);
      font: inherit;
      font-size: 13px;
    }
    .cap-in::placeholder { color: var(--faint); }
    .cap-in:focus { outline: none; border-color: var(--g); box-shadow: 0 0 0 3px rgba(245, 200, 75, 0.12); }
    .ibtn {
      flex: 0 0 auto;
      width: 34px;
      height: 34px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 9px;
      border: 1px solid var(--g-soft);
      background: rgba(0, 0, 0, 0.4);
      color: var(--champ);
      cursor: pointer;
    }
    .ibtn.on { border-color: var(--bad); color: var(--bad); box-shadow: 0 0 12px -2px var(--bad); }
    .cap-btns, .go { display: flex; gap: 6px; flex-wrap: wrap; }
    .go { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--g-faint); }
    .btn {
      flex: 1 1 0;
      min-width: 84px;
      height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 0 10px;
      border-radius: 9px;
      border: 1px solid var(--g-soft);
      background: linear-gradient(180deg, rgba(245, 200, 75, 0.14), rgba(245, 200, 75, 0.05));
      color: var(--champ);
      font: 600 11px "JetBrains Mono", monospace;
      letter-spacing: 0.04em;
      cursor: pointer;
      white-space: nowrap;
    }
    .btn svg, .ibtn svg { width: 14px; height: 14px; }
    .btn:hover:not(:disabled) { border-color: var(--g); box-shadow: 0 0 14px -6px var(--g); }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn.ghost { background: rgba(255, 255, 255, 0.03); color: var(--fg); }
    .cap-msg { font-size: 11.5px; }

    button:focus-visible, select:focus-visible { outline: 2px solid var(--g); outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) {
      .spin { animation: none; }
      .mic-fill { transition: none; }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "voice-hud-panels": VoiceHudPanels;
  }
}

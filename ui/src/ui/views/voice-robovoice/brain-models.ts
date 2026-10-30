/**
 * <voice-brain-models> — the model half of the Voice page's brain picker
 * (rendered inside <voice-cli-route-control>'s popover).
 *
 *   Subscriptions (CLI)  claude-cli, codex-cli, gemini-cli, grok-cli,
 *                        opencode-cli with installed / signed-in state; the
 *                        host renders the live CLI sessions under it.
 *   API providers        every configured provider from the shared catalogue
 *                        with its live curated model list (Free badges,
 *                        retired models hidden). Unconfigured providers get an
 *                        inline "Add key" (same checks as the onboarding brain
 *                        step: list models with the key, one real test turn).
 *   Local                Ollama / vLLM models served on this machine.
 *
 * Picking emits `voice-brain-pick` { model: "provider/model" | null } (null =
 * the agent's own model); the host stores it gateway-side.
 */

import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../../gateway.js";
import { icon } from "../../icons.js";
import { getBrainProvider, saveBrainKey, toModelOptions, type BrainModelOption } from "../../lib/brain-providers.js";
import {
  cliModelRef,
  cliState,
  filterModels,
  isFeaturedProvider,
  loadCachedCatalog,
  saveCachedCatalog,
  splitApiProviders,
  type BrainApiProvider,
  type BrainCatalog,
  type BrainModel,
} from "./voice-brain-state.js";

export const VOICE_BRAIN_PICK = "voice-brain-pick";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type AddKeyState = {
  provider: string;
  key: string;
  models: BrainModelOption[];
  model: string;
  busy: "check" | "test" | null;
  msg: { ok: boolean; text: string } | null;
};

@customElement("voice-brain-models")
export class VoiceBrainModels extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  /** The active voice brain model (null = agent's model). */
  @property({ attribute: false }) current: string | null = null;
  /** True while voice turns go to a live CLI session (no model is "active"). */
  @property({ type: Boolean }) sessionRouted = false;
  /** Busy key from the host while a pick is being saved. */
  @property({ attribute: false }) pending: string | null = null;

  @state() private catalog: BrainCatalog | null = loadCachedCatalog();
  @state() private loading = false;
  @state() private loadError: string | null = null;
  @state() private expanded = new Set<string>();
  @state() private query: Record<string, string> = {};
  @state() private freeOnly: Record<string, boolean> = {};
  @state() private showMore = false;
  @state() private addKey: AddKeyState | null = null;
  @state() private showSessions: boolean | null = null;

  static styles = css`
    :host { display: grid; gap: 14px; color: var(--glass-fg, #f4efe2); font-family: var(--glass-font, var(--font-ui, system-ui)); }
    /* Jump targets clear the picker's sticky header. */
    section { display: grid; gap: 6px; min-width: 0; scroll-margin-top: 104px; }
    .sec-head { display: flex; align-items: center; gap: 8px; margin: 8px 4px 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: var(--glass-tracking-caps, 0.1em); color: var(--glass-gold, #e6c15a); }
    .sec-head svg { width: 14px; height: 14px; }
    .sec-head::after { content: ""; flex: 1; height: 1px; background: linear-gradient(90deg, var(--glass-gold-a24, rgba(230, 193, 90, 0.24)), transparent); }
    .sec-head .n { color: var(--glass-fg-3, rgba(244, 239, 226, 0.6)); font-variant-numeric: tabular-nums; letter-spacing: 0; }
    .sub { margin: 2px 4px 2px; font-size: 12px; color: var(--glass-fg-3, rgba(244, 239, 226, 0.62)); line-height: 1.4; }
    .row {
      all: unset; box-sizing: border-box; cursor: pointer; display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 10px;
      padding: 9px 10px; border-radius: var(--glass-radius-sm, 10px); background: var(--glass-3, rgba(28, 24, 18, 0.55));
      border: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.07)); transition: border-color 0.15s, background 0.15s; min-width: 0;
    }
    .row:hover { border-color: var(--glass-stroke-gold, rgba(230, 193, 90, 0.45)); }
    .row:focus-visible, .m:focus-visible, .btn:focus-visible, input:focus-visible { outline: none; box-shadow: var(--glass-focus-ring, 0 0 0 2px #e6c15a); }
    .row.sel { border-color: var(--glass-gold, #e6c15a); background: var(--glass-gold-tint, rgba(230, 193, 90, 0.1)); }
    .row.static { cursor: default; }
    .row.static:hover { border-color: var(--glass-stroke, rgba(255, 255, 255, 0.07)); }
    .row.off .t, .row.off .ic { opacity: 0.6; }
    .ic { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; color: var(--glass-gold, #e6c15a); background: var(--glass-gold-a10, rgba(230, 193, 90, 0.1)); border: 1px solid var(--glass-gold-a16, rgba(230, 193, 90, 0.16)); }
    .t { min-width: 0; display: grid; gap: 2px; }
    .t b { font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; line-height: 1.3; }
    .t span { font-size: 12px; color: var(--glass-fg-3, rgba(244, 239, 226, 0.62)); overflow-wrap: anywhere; line-height: 1.35; }
    .t code { font-family: var(--glass-font-mono, ui-monospace, monospace); font-size: 11.5px; }
    .end { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .tag { font-size: 11px; padding: 2px 8px; border-radius: 999px; white-space: nowrap; border: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.12)); color: var(--glass-fg-3, rgba(244, 239, 226, 0.7)); display: inline-flex; align-items: center; gap: 4px; }
    .tag svg { width: 11px; height: 11px; }
    .tag.ok { border-color: rgba(61, 220, 132, 0.45); color: #6fe3a1; }
    .tag.gold { border-color: var(--glass-gold-a40, rgba(230, 193, 90, 0.4)); color: var(--glass-gold, #e6c15a); }
    .tag.warn { border-color: rgba(245, 185, 66, 0.5); color: #f5b942; }
    .tag.free { border-color: rgba(61, 220, 132, 0.45); color: #6fe3a1; }
    .chev { transition: transform 0.15s; display: inline-flex; color: var(--glass-fg-3, rgba(244, 239, 226, 0.6)); }
    .chev.open { transform: rotate(90deg); }
    .provider { display: grid; gap: 6px; }
    .models-wrap { display: grid; gap: 8px; margin: 0 0 4px 12px; padding-left: 12px; border-left: 1px solid var(--glass-gold-a16, rgba(230, 193, 90, 0.16)); }
    .tools { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    input {
      box-sizing: border-box; flex: 1 1 160px; min-width: 0; padding: 8px 11px; border-radius: var(--glass-radius-sm, 10px); font: inherit; font-size: 13px;
      color: var(--glass-fg, inherit); background: var(--glass-1, rgba(0, 0, 0, 0.35)); border: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.12));
    }
    input::placeholder { color: var(--glass-fg-4, rgba(244, 239, 226, 0.42)); }
    .models { display: grid; gap: 4px; max-height: min(300px, 42vh); overflow-y: auto; overscroll-behavior: contain; padding-right: 2px; }
    .m {
      all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px; min-width: 0;
      border: 1px solid transparent; font-size: 12.5px; font-family: var(--glass-font-mono, ui-monospace, monospace);
    }
    .m:hover { background: var(--glass-hover, rgba(255, 255, 255, 0.05)); border-color: var(--glass-stroke, rgba(255, 255, 255, 0.1)); }
    .m.sel { background: var(--glass-gold-tint, rgba(230, 193, 90, 0.12)); border-color: var(--glass-gold, #e6c15a); }
    .m .nm { flex: 1; min-width: 0; overflow-wrap: anywhere; line-height: 1.35; }
    .m .ck { color: var(--glass-gold, #e6c15a); display: inline-flex; }
    .btn {
      all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border-radius: var(--glass-radius-pill, 999px); white-space: nowrap;
      font-size: 12px; font-weight: 600; background: var(--glass-hover, rgba(255, 255, 255, 0.06)); border: 1px solid var(--glass-stroke-strong, rgba(255, 255, 255, 0.16)); color: var(--glass-fg, inherit);
    }
    .btn svg { width: 13px; height: 13px; }
    .btn:hover { border-color: var(--glass-stroke-gold, rgba(230, 193, 90, 0.5)); }
    .btn.primary { background: var(--glass-gold-fill, linear-gradient(180deg, #f3d27a, #b8892b)); color: var(--glass-ink, #1a1408); border-color: transparent; }
    .btn.on { border-color: rgba(61, 220, 132, 0.5); color: #6fe3a1; }
    .btn[disabled] { opacity: 0.5; pointer-events: none; }
    .btn.ghost { background: none; }
    .note { font-size: 12px; padding: 8px 11px; border-radius: var(--glass-radius-sm, 10px); background: rgba(245, 185, 66, 0.08); border: 1px solid rgba(245, 185, 66, 0.3); color: #f5c76a; line-height: 1.4; }
    .note.err { background: rgba(239, 91, 91, 0.08); border-color: rgba(239, 91, 91, 0.35); color: #ff9c9c; }
    .note.ok { background: rgba(61, 220, 132, 0.08); border-color: rgba(61, 220, 132, 0.35); color: #8cebb6; }
    .empty { padding: 11px; border-radius: var(--glass-radius-sm, 10px); border: 1px dashed var(--glass-stroke, rgba(255, 255, 255, 0.14)); color: var(--glass-fg-3, rgba(244, 239, 226, 0.62)); font-size: 12.5px; text-align: center; line-height: 1.4; }
    .addkey { display: grid; gap: 8px; padding: 10px; border-radius: var(--glass-radius-sm, 10px); border: 1px solid var(--glass-gold-a24, rgba(230, 193, 90, 0.24)); background: var(--glass-tint, rgba(230, 193, 90, 0.04)); }
    .addkey label { font-size: 12px; color: var(--glass-fg-2, rgba(244, 239, 226, 0.82)); }
    .addkey a { color: var(--glass-gold, #e6c15a); }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
    .jump { display: flex; gap: 6px; flex-wrap: wrap; padding: 4px 0 8px; background: rgb(13, 11, 8); }
    .jump button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border-radius: 999px; font-size: 12px; font-weight: 600;
      border: 1px solid var(--glass-stroke, rgba(255, 255, 255, 0.12)); color: var(--glass-fg-2, rgba(244, 239, 226, 0.82)); background: var(--glass-3, rgba(28, 24, 18, 0.6)); }
    .jump button:hover { border-color: var(--glass-stroke-gold, rgba(230, 193, 90, 0.5)); color: var(--glass-fg, #f4efe2); }
    .jump button:focus-visible { outline: none; box-shadow: var(--glass-focus-ring, 0 0 0 2px #e6c15a); }
    .jump svg { width: 13px; height: 13px; color: var(--glass-gold, #e6c15a); }
    .disclose { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 9px 10px; border-radius: var(--glass-radius-sm, 10px);
      border: 1px dashed var(--glass-stroke-strong, rgba(255, 255, 255, 0.18)); font-size: 12.5px; font-weight: 600; color: var(--glass-fg-2, rgba(244, 239, 226, 0.85)); }
    .disclose:hover { border-color: var(--glass-stroke-gold, rgba(230, 193, 90, 0.5)); }
    .disclose:focus-visible { outline: none; box-shadow: var(--glass-focus-ring, 0 0 0 2px #e6c15a); }
    .disclose svg { width: 14px; height: 14px; color: var(--glass-gold, #e6c15a); }
    .disclose .chev { margin-left: auto; }
    .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: s 0.8s linear infinite; }
    @keyframes s { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } .chev { transition: none; } }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    if (this.current) this.expandFor(this.current);
  }

  protected updated(changed: PropertyValues<this>): void {
    if (changed.has("client") && this.client) void this.load(false);
    if (changed.has("current") && this.current) this.expandFor(this.current);
  }

  /** Re-fetch (the host calls this every time the picker opens). */
  public async load(fresh: boolean): Promise<void> {
    if (!this.client) return;
    this.loading = true;
    this.loadError = null;
    try {
      const c = await this.client.request<BrainCatalog>("voice.brain.catalog", fresh ? { fresh: true } : {}, { timeoutMs: 30_000 });
      if (c && Array.isArray(c.api)) {
        this.catalog = c;
        saveCachedCatalog(c);
        this.dispatchEvent(new CustomEvent("voice-brain-catalog", { detail: c, bubbles: true, composed: true }));
      }
    } catch (e) {
      this.loadError = errText(e);
    } finally {
      this.loading = false;
    }
  }

  private expandFor(ref: string) {
    const provider = ref.slice(0, ref.indexOf("/"));
    if (provider && !this.expanded.has(provider)) this.expanded = new Set([...this.expanded, provider]);
  }

  private pick(model: string | null) {
    this.dispatchEvent(new CustomEvent(VOICE_BRAIN_PICK, { detail: { model }, bubbles: true, composed: true }));
  }

  private toggle(id: string) {
    const next = new Set(this.expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.expanded = next;
  }

  // ── add key (same checks as the onboarding brain step) ──────────────────

  private openAddKey(id: string) {
    this.addKey = { provider: id, key: "", models: [], model: "", busy: null, msg: null };
  }

  private async checkKey() {
    const a = this.addKey;
    const p = a && getBrainProvider(a.provider);
    if (!a || !p || !a.key.trim() || !this.client) return;
    this.addKey = { ...a, busy: "check", msg: null };
    try {
      const res = await this.client.request<{ models?: Array<{ id: string; label?: string; free?: boolean }>; defaultModel?: string; error?: string }>(
        "quickstart.providers.fetchModels",
        { provider: p.id, apiKey: a.key.trim(), preferred: p.model || undefined },
        { timeoutMs: 30_000 },
      );
      if (res?.error) throw new Error(res.error);
      const models = toModelOptions(res?.models);
      const ids = models.map((m) => m.id);
      const model = res?.defaultModel && ids.includes(res.defaultModel) ? res.defaultModel : (ids[0] ?? p.model);
      const free = models.filter((m) => m.free).length;
      this.addKey = {
        ...a,
        busy: null,
        models,
        model,
        msg: { ok: true, text: ids.length ? `Key works. ${ids.length} models${free ? `, ${free} free` : ""}. Pick one, then Test & use.` : "Key accepted." },
      };
    } catch (e) {
      this.addKey = { ...a, busy: null, msg: { ok: false, text: `That key didn't work: ${errText(e)}` } };
    }
  }

  private async testAndUse() {
    const a = this.addKey;
    const p = a && getBrainProvider(a.provider);
    if (!a || !p || !this.client || !a.model.trim()) return;
    this.addKey = { ...a, busy: "test", msg: null };
    try {
      const test = await this.client.request<{ ok?: boolean; error?: string; latencyMs?: number }>(
        "quickstart.providers.testModel",
        { provider: p.id, apiKey: a.key.trim(), model: a.model.trim() },
        { timeoutMs: 60_000 },
      );
      if (!test?.ok) throw new Error(`${a.model} didn't answer: ${test?.error ?? "unknown error"}`);
      const rpc = <T,>(method: string, params: Record<string, unknown>) => this.client!.request<T>(method, params);
      const ref = await saveBrainKey(rpc, p, a.key, a.model);
      this.addKey = null;
      this.expanded = new Set([...this.expanded, p.id]);
      this.pick(ref);
      await this.load(true);
    } catch (e) {
      this.addKey = { ...a, busy: null, msg: { ok: false, text: errText(e) } };
    }
  }

  // ── render ──────────────────────────────────────────────────────────────

  render() {
    const c = this.catalog;
    const jump = (id: string) => this.renderRoot.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    return html`
      <nav class="jump" aria-label="Brain groups">
        <button data-testid="voice-brain-jump-cli" @click=${() => jump("voice-brain-cli")}>${icon("monitor")}Subscriptions</button>
        <button data-testid="voice-brain-jump-api" @click=${() => jump("voice-brain-api")}>${icon("globe")}API providers</button>
        <button data-testid="voice-brain-jump-local" @click=${() => jump("voice-brain-local")}>${icon("server")}Local</button>
      </nav>
      ${this.loadError && !c ? html`<div class="note err" role="alert">Could not load models: ${this.loadError}</div>` : nothing}
      ${this.renderSubscriptions(c)}
      ${this.renderApi(c)}
      ${this.renderLocal(c)}
    `;
  }

  private renderSubscriptions(c: BrainCatalog | null) {
    const list = c?.cli ?? [];
    return html`<section data-testid="voice-brain-cli">
      <div class="sec-head">${icon("monitor")} Subscriptions (CLI) <span class="n">${c ? list.length : "…"}</span></div>
      <div class="sub">Answer on your Claude, ChatGPT, Google or Grok plan through its CLI, or route into a live CLI session below.</div>
      ${list.map((b) => {
        const st = cliState(b);
        const ref = cliModelRef(b);
        const sel = !this.sessionRouted && this.current === ref;
        const busy = this.pending === ref;
        const body = html`<span class="ic">${icon("monitor")}</span>
          <span class="t"><b>${b.account || b.label}</b><span>${b.label}${b.model ? html` · <code>${b.model}</code>` : nothing}</span></span>
          <span class="end">
            ${sel ? html`<span class="tag ok">${icon("check")}Active</span>` : busy ? html`<span class="tag"><span class="spin"></span>Saving</span>` : nothing}
            <span class="tag ${st.tone === "ok" ? "ok" : st.tone === "warn" ? "warn" : ""}">${st.text}</span>
            ${!b.installed && b.installUrl ? html`<a class="btn ghost" href=${b.installUrl} target="_blank" rel="noopener">Install</a>` : nothing}
          </span>`;
        if (!st.usable)
          return html`<div class="row static off" data-testid="voice-brain-cli-option" data-ref=${ref}
            title=${b.installed ? `Sign in to ${b.label} from Setup › Coders` : `Install ${b.label} first`}>${body}</div>`;
        return html`<button class="row ${sel ? "sel" : ""}" data-testid="voice-brain-cli-option" data-ref=${ref}
          aria-pressed=${sel ? "true" : "false"} title=${`Use ${b.label} for voice`} @click=${() => !busy && this.pick(ref)}>${body}        </button>`;
      })}
      ${c && !list.length ? html`<div class="empty">Subscription CLIs aren't available on this gateway.</div>` : nothing}
      ${this.renderSessionsDisclosure()}
    </section>`;
  }

  private renderSessionsDisclosure() {
    const open = this.showSessions ?? this.sessionRouted;
    return html`<button class="disclose" data-testid="voice-brain-sessions-toggle" aria-expanded=${open ? "true" : "false"}
        @click=${() => (this.showSessions = !open)}>
        ${icon("monitor")} Route voice into a live CLI session
        <span class="chev ${open ? "open" : ""}">${icon("chevronRight")}</span>
      </button>
      ${open ? html`<slot name="sessions"></slot>` : nothing}`;
  }

  private renderApi(c: BrainCatalog | null) {
    const { configured, unconfigured } = splitApiProviders(c?.api ?? []);
    const agentSel = !this.sessionRouted && !this.current;
    const featuredUnconf = unconfigured.filter((p) => isFeaturedProvider(p.id));
    const moreUnconf = unconfigured.filter((p) => !isFeaturedProvider(p.id));
    return html`<section data-testid="voice-brain-api">
      <div class="sec-head">${icon("globe")} API providers <span class="n">${c ? configured.length : "…"}</span>
        <button class="btn ghost" style="margin-left:auto" title="Reload the live model lists" aria-label="Reload model lists" ?disabled=${this.loading}
          @click=${() => void this.load(true)}>${this.loading ? html`<span class="spin"></span>` : icon("refresh")}</button>
      </div>
      <button class="row ${agentSel ? "sel" : ""}" data-testid="voice-brain-agent-default" aria-pressed=${agentSel ? "true" : "false"} @click=${() => this.pick(null)}>
        <span class="ic">${icon("bot")}</span>
        <span class="t"><b>Agent default</b><span>${c?.agentModel ? html`<code>${c.agentModel}</code>` : "The agent's own model"}</span></span>
        <span class="end">${agentSel ? html`<span class="tag ok">${icon("check")}Active</span>` : nothing}</span>
      </button>
      ${!c && this.loading ? html`<div class="empty">Loading your providers and their models…</div>` : nothing}
      ${configured.map((p) => this.renderProvider(p))}
      ${c && !configured.length ? html`<div class="empty">No API provider has a key yet. Add one below.</div>` : nothing}
      ${unconfigured.length
        ? html`<div class="sub" style="margin-top:6px">Add a provider</div>
            ${featuredUnconf.map((p) => this.renderUnconfigured(p))}
            ${this.showMore ? moreUnconf.map((p) => this.renderUnconfigured(p)) : nothing}
            ${moreUnconf.length
              ? html`<button class="btn ghost" data-testid="voice-brain-more" aria-expanded=${this.showMore ? "true" : "false"} @click=${() => (this.showMore = !this.showMore)}>
                  ${icon(this.showMore ? "minus" : "plus")} ${this.showMore ? "Fewer providers" : `More providers (${moreUnconf.length})`}
                </button>`
              : nothing}`
        : nothing}
    </section>`;
  }

  private renderProvider(p: BrainApiProvider) {
    const open = this.expanded.has(p.id);
    const active = !this.sessionRouted && !!this.current?.startsWith(`${p.id}/`);
    const free = p.models.filter((m) => m.free).length;
    return html`<div class="provider" data-provider=${p.id}>
      <button class="row ${active ? "sel" : ""}" data-testid="voice-brain-provider" aria-expanded=${open ? "true" : "false"} @click=${() => this.toggle(p.id)}>
        <span class="ic">${icon("key")}</span>
        <span class="t"><b>${p.label}</b><span>${p.error ? "Couldn't list models" : `${p.models.length} models${free ? ` · ${free} free` : ""}`}</span></span>
        <span class="end">
          ${active ? html`<span class="tag ok">${icon("check")}Active</span>` : nothing}
          <span class="chev ${open ? "open" : ""}">${icon("chevronRight")}</span>
        </span>
      </button>
      ${open ? html`<div class="models-wrap">${this.renderModelList(p)}</div>` : nothing}
    </div>`;
  }

  private renderModelList(p: BrainApiProvider) {
    if (p.error) return html`<div class="note err">${p.label}: ${p.error}</div>`;
    if (!p.models.length) return html`<div class="empty">${p.label} returned no chat models for this key.</div>`;
    const q = this.query[p.id] ?? "";
    const fo = this.freeOnly[p.id] === true;
    const anyFree = p.models.some((m) => m.free);
    const shown = filterModels(p.models, q, fo);
    // The active model leads, so it is visible without scrolling.
    const ordered = [...shown].sort((a, b) => Number(this.isActive(p, b)) - Number(this.isActive(p, a)));
    return html`
      ${p.models.length > 8 || anyFree
        ? html`<div class="tools">
            ${p.models.length > 8
              ? html`<input type="search" placeholder="Search ${p.models.length} models" aria-label="Search ${p.label} models" .value=${q}
                  data-testid="voice-brain-search" @input=${(e: Event) => (this.query = { ...this.query, [p.id]: (e.target as HTMLInputElement).value })} />`
              : nothing}
            ${anyFree
              ? html`<button class="btn ${fo ? "on" : ""}" aria-pressed=${fo ? "true" : "false"} data-testid="voice-brain-free-only"
                  @click=${() => (this.freeOnly = { ...this.freeOnly, [p.id]: !fo })}>${icon("dollarSign")}Free only</button>`
              : nothing}
          </div>`
        : nothing}
      <div class="models" role="listbox" aria-label="${p.label} models">
        ${ordered.length ? ordered.map((m) => this.renderModel(p, m)) : html`<div class="empty">No models match.</div>`}
      </div>`;
  }

  private isActive(p: BrainApiProvider, m: BrainModel) {
    return !this.sessionRouted && this.current === `${p.id}/${m.id}`;
  }

  private renderModel(p: BrainApiProvider, m: BrainModel) {
    const ref = `${p.id}/${m.id}`;
    const sel = this.isActive(p, m);
    const busy = this.pending === ref;
    return html`<button class="m ${sel ? "sel" : ""}" role="option" aria-selected=${sel ? "true" : "false"} data-testid="voice-brain-model" data-ref=${ref}
      title=${m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id} @click=${() => !busy && this.pick(ref)}>
      <span class="nm">${m.id}</span>
      ${m.free ? html`<span class="tag free">Free</span>` : nothing}
      ${busy ? html`<span class="spin"></span>` : sel ? html`<span class="ck">${icon("check")}</span>` : nothing}
    </button>`;
  }

  private renderUnconfigured(p: BrainApiProvider) {
    const a = this.addKey?.provider === p.id ? this.addKey : null;
    const spec = getBrainProvider(p.id);
    return html`<div class="provider" data-provider=${p.id}>
      <div class="row static" data-testid="voice-brain-unconfigured">
        <span class="ic">${icon("plus")}</span>
        <span class="t"><b>${p.label}</b><span>${spec?.sub || "Bring your own key"}</span></span>
        <span class="end">
          <button class="btn ${a ? "" : "primary"}" data-testid="voice-brain-add-key" @click=${() => (a ? (this.addKey = null) : this.openAddKey(p.id))}>
            ${a ? "Cancel" : html`${icon("key")}Add key`}
          </button>
        </span>
      </div>
      ${a ? this.renderAddKey(p, a) : nothing}
    </div>`;
  }

  private renderAddKey(p: BrainApiProvider, a: AddKeyState) {
    const spec = getBrainProvider(p.id);
    let host = "";
    try {
      host = spec?.keyUrl ? new URL(spec.keyUrl).host : "";
    } catch {
      host = "";
    }
    return html`<div class="addkey" data-testid="voice-brain-addkey-form">
      <label for="k-${p.id}">${p.label} API key</label>
      <input id="k-${p.id}" type="password" autocomplete="off" placeholder=${spec?.placeholder ?? "API key"} .value=${a.key} data-testid="voice-brain-key-input"
        @input=${(e: Event) => (this.addKey = { ...a, key: (e.target as HTMLInputElement).value, models: [], model: "", msg: null })} />
      <div class="sub">${host ? html`Get a key at <a href=${spec!.keyUrl} target="_blank" rel="noopener">${host}</a>. ` : nothing}Stored only on this computer.</div>
      ${a.models.length
        ? html`<div class="models" role="listbox" aria-label="Models for the new key">
            ${a.models.map(
              (m) => html`<button class="m ${m.id === a.model ? "sel" : ""}" role="option" aria-selected=${m.id === a.model ? "true" : "false"}
                @click=${() => (this.addKey = { ...a, model: m.id })}>
                <span class="nm">${m.id}</span>${m.free ? html`<span class="tag free">Free</span>` : nothing}
                ${m.id === a.model ? html`<span class="ck">${icon("check")}</span>` : nothing}
              </button>`,
            )}
          </div>`
        : nothing}
      ${a.msg ? html`<div class="note ${a.msg.ok ? "ok" : "err"}" role=${a.msg.ok ? "status" : "alert"}>${a.msg.text}</div>` : nothing}
      <div class="actions">
        <button class="btn" ?disabled=${!a.key.trim() || !!a.busy} @click=${() => void this.checkKey()}>
          ${a.busy === "check" ? html`<span class="spin"></span>Checking…` : "Check key"}
        </button>
        <button class="btn primary" ?disabled=${!a.key.trim() || !a.model || !!a.busy} data-testid="voice-brain-test-use" @click=${() => void this.testAndUse()}>
          ${a.busy === "test" ? html`<span class="spin"></span>Testing ${a.model}…` : "Test & use"}
        </button>
      </div>
    </div>`;
  }

  private renderLocal(c: BrainCatalog | null) {
    const list = c?.local ?? [];
    return html`<section data-testid="voice-brain-local">
      <div class="sec-head">${icon("server")} Local <span class="n">${c ? list.length : "…"}</span></div>
      ${list.map((l) => {
        const sel = !this.sessionRouted && this.current === l.ref;
        const busy = this.pending === l.ref;
        return html`<button class="row ${sel ? "sel" : ""}" data-testid="voice-brain-local-option" data-ref=${l.ref} aria-pressed=${sel ? "true" : "false"}
          @click=${() => !busy && this.pick(l.ref)}>
          <span class="ic">${icon("server")}</span>
          <span class="t"><b>${l.model}</b><span>${l.provider}${l.note ? ` · ${l.note}` : " · on this machine"}</span></span>
          <span class="end">
            ${sel ? html`<span class="tag ok">${icon("check")}Active</span>` : busy ? html`<span class="tag"><span class="spin"></span>Saving</span>` : nothing}
            ${l.onDemand ? html`<span class="tag gold">On demand</span>` : html`<span class="tag ok">Running</span>`}
          </span>
        </button>`;
      })}
      ${c && !list.length ? html`<div class="empty">No local model is running. Start Ollama or vLLM to use one.</div>` : nothing}
    </section>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "voice-brain-models": VoiceBrainModels;
  }
}

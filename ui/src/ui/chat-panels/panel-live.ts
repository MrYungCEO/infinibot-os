/**
 * PanelLiveElement — shared live-data behaviour for <chat-panel-card> and
 * <chat-panel-modal>: fetch via `chat.panel.refresh`, poll at the kind's
 * refreshMs only while visible (IntersectionObserver + document visibility),
 * and the confirm-first task status action.
 */
import { LitElement, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";

import { getGatewayClient } from "../gateway-client";
import { gatewayOrigin } from "../gateway-endpoint";
import { extractPanelRef, type ChatPanelRef, type PanelResult } from "./panel-ref";
import { openPanelLink, openPanelModal, refreshPanel, updateTaskStatus } from "./panel-nav";
import type { PanelRenderCtx } from "./panel-renderers";
import {
  actionMethodAllowed,
  safeHref,
  type PluginPanelAction,
  type PluginPanelCtx,
} from "./plugin-panel";

/** "$origin" / "$path" placeholders in plugin action params. */
function fillParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    out[k] = v === "$origin" ? gatewayOrigin() : v === "$path" ? window.location.pathname : v;
  }
  return out;
}

export abstract class PanelLiveElement extends LitElement {
  @property({ attribute: false }) ref: ChatPanelRef | null = null;
  /** Pre-fetched data (e.g. from the chat.panel.show broadcast) — skips the first fetch. */
  @property({ attribute: false }) initial: PanelResult | null = null;

  @state() protected result: PanelResult | null = null;
  @state() protected loading = false;
  @state() protected fetchError: string | null = null;
  @state() protected pendingStatus: string | null = null;
  @state() protected busy = false;
  @state() protected actionError: string | null = null;
  @state() protected visible = false;
  @state() protected vizLive = false;
  /** Plugin panels: filter/search overrides on top of ref.query. */
  @state() protected queryPatch: Record<string, unknown> = {};
  @state() protected selected: string | null = null;
  @state() protected inputFor: string | null = null;
  @state() protected inputValue = "";
  @state() protected pluginBusy: string | null = null;
  @state() protected pluginError: string | null = null;
  @state() protected pluginNote: string | null = null;
  @state() protected spawned: ChatPanelRef[] = [];
  @state() protected now = Date.now();
  private ticker: number | null = null;

  private timer: number | null = null;
  private io: IntersectionObserver | null = null;
  private inflight = false;
  private readonly onVis = () => this.schedule();

  protected abstract readonly mode: "card" | "modal";

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("visibilitychange", this.onVis);
    if (typeof IntersectionObserver === "function") {
      this.io = new IntersectionObserver((entries) => {
        const v = entries.some((e) => e.isIntersecting);
        if (v === this.visible) return;
        this.visible = v;
        this.onVisibilityChange(v);
      });
      this.io.observe(this);
    } else {
      this.visible = true;
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("visibilitychange", this.onVis);
    this.io?.disconnect();
    this.io = null;
    this.clearTimer();
    this.stopTicker();
  }

  /** 1 s re-render while a plugin panel shows a progress block (elapsed time). */
  private syncTicker(): void {
    const data = this.result?.data as { progress?: unknown } | null | undefined;
    const want = Boolean(data && typeof data === "object" && data.progress) && this.visible && !document.hidden;
    if (want && this.ticker == null) {
      this.ticker = window.setInterval(() => {
        this.now = Date.now();
      }, 1000);
    } else if (!want) this.stopTicker();
  }

  private stopTicker(): void {
    if (this.ticker != null) window.clearInterval(this.ticker);
    this.ticker = null;
  }

  /** ref.query with the card's filter overrides (undefined = cleared). */
  protected get effectiveQuery(): Record<string, unknown> {
    const q: Record<string, unknown> = { ...(this.ref?.query ?? {}), ...this.queryPatch };
    for (const k of Object.keys(q)) if (q[k] === undefined) delete q[k];
    return q;
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("initial") && this.initial && !this.result) this.result = this.initial;
    if (changed.has("ref") && this.ref && changed.get("ref")?.panelId !== this.ref.panelId) {
      if (!this.initial) this.result = null;
      this.queryPatch = {};
      this.selected = null;
      this.spawned = [];
      // Cards wait until scrolled into view (long histories = many cards).
      if (this.mode === "modal" || this.visible) void this.load(Boolean(this.result));
    }
  }

  /** Subclasses decide whether the mesh viz follows visibility. */
  protected onVisibilityChange(visible: boolean): void {
    if (visible && !this.result && !this.loading) void this.load();
    this.schedule();
  }

  private clearTimer(): void {
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.clearTimer();
    this.syncTicker();
    const every = this.result?.refreshMs ?? this.ref?.refreshMs ?? 0;
    if (!every || !this.isConnected || !this.visible || document.hidden) return;
    this.timer = window.setTimeout(() => void this.load(true), Math.max(3000, every));
  }

  async load(silent = false): Promise<void> {
    const ref = this.ref;
    if (!ref || this.inflight) return;
    this.inflight = true;
    if (!silent) this.loading = true;
    try {
      const r = await refreshPanel({ ...ref, query: this.effectiveQuery });
      if (this.ref?.panelId !== ref.panelId) return;
      // A note from a button ("finish signing in…") is stale once the panel's state moved on.
      if (this.pluginNote && this.result && r.summary !== this.result.summary) this.pluginNote = null;
      this.result = r;
      this.fetchError = null;
    } catch (err) {
      this.fetchError = err instanceof Error ? err.message : String(err);
    } finally {
      this.inflight = false;
      this.loading = false;
      this.schedule();
    }
  }

  protected expand(): void {
    if (this.ref) openPanelModal({ ...this.ref, query: this.effectiveQuery, display: "modal" }, this.result);
  }

  /** A plugin panel button: link / download / own-plugin RPC (see plugin-panel.ts). */
  private async runPluginAction(a: PluginPanelAction, key: string): Promise<void> {
    const ref = this.ref;
    if (!ref || a.disabled || this.pluginBusy) return;
    this.pluginError = null;
    this.pluginNote = null;
    if (a.href && !a.rpc) {
      const href = safeHref(a.href);
      if (!href) return void (this.pluginError = "This link isn't allowed.");
      if (a.download) {
        const el = document.createElement("a");
        el.href = href;
        el.download = a.download;
        el.target = "_blank";
        el.rel = "noopener";
        document.body.appendChild(el);
        el.click();
        el.remove();
      } else if (href.startsWith("/")) openPanelLink({ tab: "", path: href, label: "" });
      else window.open(href, "_blank", "noopener");
      return;
    }
    if (!a.rpc) return;
    if (!actionMethodAllowed(ref.kind, a.rpc.method)) {
      this.pluginError = `This panel may not call ${a.rpc.method}.`;
      return;
    }
    if (a.input && this.inputFor !== key) {
      this.inputFor = key;
      this.inputValue = a.input.value ?? "";
      return;
    }
    if (a.confirm && !window.confirm(a.confirm)) return;
    const params = fillParams(a.rpc.params);
    if (a.input) params[a.input.param] = this.inputValue.trim();
    // Open the popup inside the click so popup blockers allow it.
    const popup = a.open ? window.open("about:blank", "infinibot-plugin-popup", "width=520,height=780") : null;
    const client = getGatewayClient();
    this.pluginBusy = key;
    try {
      if (!client) throw new Error("Not connected to the gateway");
      const res = (await client.request(a.rpc.method, params)) as Record<string, unknown> | null;
      if (a.open) {
        const url = safeHref(res?.[a.open]);
        if (!url || url.startsWith("data:")) throw new Error("The plugin returned no sign-in URL");
        if (popup && !popup.closed) popup.location.href = url;
        else window.location.href = url;
      }
      const spawned = extractPanelRef(res);
      if (spawned && !this.spawned.some((r) => r.panelId === spawned.panelId)) {
        this.spawned = [...this.spawned, spawned];
        void this.revealSpawned();
      }
      this.inputFor = null;
      this.inputValue = "";
      this.pluginNote = a.done ?? null;
      await this.load(true);
    } catch (err) {
      popup?.close();
      this.pluginError = err instanceof Error ? err.message : String(err);
    } finally {
      this.pluginBusy = null;
    }
  }

  /**
   * Bring a just-started nested card into view inside this panel's scrolling
   * body (it only loads once visible). Not scrollIntoView: that also scrolls
   * the control UI's overflow-hidden shell.
   */
  private async revealSpawned(): Promise<void> {
    await this.updateComplete;
    const body = this.renderRoot.querySelector(".body") as HTMLElement | null;
    const cards = this.renderRoot.querySelectorAll(".p-spawned chat-panel-card");
    const last = cards[cards.length - 1] as HTMLElement | undefined;
    if (!body || !last) return;
    const delta = last.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
    body.scrollTo({ top: body.scrollTop + delta, behavior: "smooth" });
  }

  protected pluginCtx(): PluginPanelCtx {
    return {
      kind: this.ref?.kind ?? "",
      query: this.effectiveQuery,
      setQuery: (patch) => {
        this.queryPatch = { ...this.queryPatch, ...patch };
        this.selected = null;
        void this.load();
      },
      selected: this.selected,
      select: (id) => {
        this.selected = id;
        this.inputFor = null;
        this.pluginError = null;
        this.pluginNote = null;
      },
      inputFor: this.inputFor,
      inputValue: this.inputValue,
      openInput: (key, initial) => {
        this.inputFor = key;
        this.inputValue = initial;
      },
      setInputValue: (v) => {
        this.inputValue = v;
      },
      cancelInput: () => {
        this.inputFor = null;
        this.inputValue = "";
      },
      run: (a, key) => void this.runPluginAction(a, key),
      busyKey: this.pluginBusy,
      actionError: this.pluginError,
      actionNote: this.pluginNote,
      spawned: this.spawned,
      now: this.now,
    };
  }

  protected drill(kind: string, query: Record<string, unknown>, title: string): void {
    openPanelModal({
      v: 1,
      panelId: `panel_${kind}_${String(query.id ?? query.runId ?? "")}_${Date.now()}`,
      kind,
      query,
      title,
      display: "modal",
      summary: "",
      count: 0,
      empty: false,
      error: null,
      link: { tab: "", label: "" },
      refreshMs: 0,
      ts: Date.now(),
    });
  }

  private async confirmStatus(): Promise<void> {
    const task = ((this.result?.data ?? {}) as { task?: { id?: string } }).task;
    const status = this.pendingStatus;
    if (!task?.id || !status) return;
    this.busy = true;
    this.actionError = null;
    try {
      await updateTaskStatus(task.id, status);
      this.pendingStatus = null;
      await this.load(true);
    } catch (err) {
      this.actionError = `Couldn't update status: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.busy = false;
    }
  }

  protected ctx(): PanelRenderCtx {
    return {
      mode: this.mode,
      vizLive: this.vizLive,
      onEnableViz: () => {
        this.vizLive = true;
      },
      pendingStatus: this.pendingStatus,
      busy: this.busy,
      actionError: this.actionError,
      onPickStatus: (st) => {
        this.actionError = null;
        this.pendingStatus = st;
      },
      onConfirmStatus: () => void this.confirmStatus(),
      onCancelStatus: () => {
        this.pendingStatus = null;
      },
      drill: (k, q, t) => this.drill(k, q, t),
      plugin: this.pluginCtx(),
    };
  }

  /** Current error: a fetch failure, else the resolver's honest error. */
  protected get errorText(): string | null {
    return this.result?.error ?? (this.result ? null : this.fetchError ?? this.ref?.error ?? null);
  }
}

/**
 * <webchat-model-picker> — Open WebUI-style provider · model dropdown for the
 * /webchat top bar and (with `compact`) the chat side panel header.
 *
 *   - catalog:   models.list (normalized via model-filter's normalizeModelsList)
 *   - list:      EVERY model from a connected provider — "Your models" (the
 *                agents.defaults.models allowlist) on top, the rest grouped by
 *                provider. Search and filters run over the whole catalog.
 *   - allowlist: the gateway rejects models outside the allowlist, so picking
 *                one adds it first (models.allowlist.add), then selects it.
 *                Rows can be added/removed from "Your models" directly, and
 *                "Only my models" (remembered) hides everything else.
 *   - not-connected providers → inline API-key setup via auth.profiles.upsert,
 *                then a `models:refresh` catalog reload
 *   - thinking:  the session thinking-level options from thinking-levels.ts
 *
 * The picker emits `model-select` ({ model: ref | null }, null = back to the
 * agent default) and `thinking-select` ({ level: string | null }); the host
 * persists them with sessions.patch.
 */
import "../local-runtimes/gpu-runtimes";
import "./provider-logo.js";
import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { GatewayBrowserClient } from "../gateway";
import {
  createModelFilterState,
  FREE_KIND_LABELS,
  freeBadgeTitle,
  isFreeModel,
  modelHasCapability,
  normalizeModelsList,
  normalizeProviderInfo,
  type ModelCapability,
  type ModelOption,
  type ProviderInfo,
} from "../model-filter";
import {
  applyAllowlistChange,
  buildPickerSections,
  flattenSections,
  hasPaidProviderConnected,
  limitForIndex,
  loadOnlyMine,
  offlineExpanded,
  needsAllowlistAdd,
  PICKER_PAGE_SIZE,
  saveOnlyMine,
  windowRows,
  type PickerRow,
  type PickerSections,
} from "../model-picker-logic";
import {
  isBinaryThinkingProvider,
  resolveThinkLevelDisplay,
  resolveThinkLevelOptions,
  resolveThinkLevelPatchValue,
} from "../thinking-levels";

const DEFAULT_ID = "__agent_default__";
const SEARCH_DEBOUNCE_MS = 120;
const TOAST_MS = 2800;

const CAPS: Array<{ cap: ModelCapability; label: string }> = [
  { cap: "reasoning", label: "Reasoning" },
  { cap: "vision", label: "Vision" },
  { cap: "tool-use", label: "Tools" },
];

const TIERS: Array<{ tier: "s" | "m" | "l"; label: string }> = [
  { tier: "s", label: "Under 32k" },
  { tier: "m", label: "32k – 200k" },
  { tier: "l", label: "200k+" },
];

/** Split a "provider/model" ref. Model ids may themselves contain slashes. */
export function splitModelRef(ref: string | null | undefined): { provider: string; model: string } {
  const raw = (ref ?? "").trim();
  const i = raw.indexOf("/");
  if (i <= 0) return { provider: "", model: raw };
  return { provider: raw.slice(0, i), model: raw.slice(i + 1) };
}

function providerMonogram(provider: string): string {
  const parts = provider.split(/[^a-z0-9]+/i).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return provider.slice(0, 2).toUpperCase() || "?";
}

function formatCtx(tokens?: number): string | null {
  if (!tokens) return null;
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
  return `${Math.round(tokens / 1000)}k`;
}

const chevron = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`;
const checkIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
const searchIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`;
const cpuIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9z"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/></svg>`;
const lockIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
const plusIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`;
const removeIcon = html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;

@customElement("webchat-model-picker")
export class WebchatModelPicker extends LitElement {
  @property({ attribute: false }) client: GatewayBrowserClient | null = null;
  @property({ type: Boolean }) connected = false;
  /** Effective model ref for the current session/draft ("provider/model"). */
  @property({ attribute: false }) value: string | null = null;
  /** The agent's default model ref (what "Agent default" resolves to). */
  @property({ attribute: false }) defaultModel: string | null = null;
  /**
   * Text for the "Agent default" row / unset trigger when there is no single
   * default model (agent group chats: every member keeps its own default).
   */
  @property({ attribute: false }) defaultLabel: string | null = null;
  /** True when the session pins a model instead of following the agent default. */
  @property({ type: Boolean }) overridden = false;
  /** Current session thinking level ("" / null = inherit). */
  @property({ attribute: false }) thinkingLevel: string | null = null;
  /** Render the menu as a bottom sheet (phones). */
  @property({ type: Boolean }) mobile = false;
  /**
   * Small trigger for tight headers (chat side panel). The menu then spans the
   * host's nearest positioned ancestor instead of hanging off the trigger.
   */
  @property({ type: Boolean, reflect: true }) compact = false;
  /**
   * `end`: anchor the dropdown to the trigger's right edge (a trigger at the
   * right of a header, e.g. the group chat), instead of the host's container.
   */
  @property({ reflect: true }) align: "start" | "end" = "start";

  @state() private models: ModelOption[] = [];
  @state() private loading = false;
  @state() private loadError: string | null = null;
  @state() private open = false;
  @state() private filterTick = 0;
  @state() private activeIndex = 0;
  @state() private showFilters = false;
  @state() private setup: { provider: string; key: string; saving: boolean; error: string } | null = null;
  /** "Show only my models" — remembered across sessions. */
  @state() private onlyMine = loadOnlyMine(globalThis.localStorage);
  /** How many model rows are in the DOM; grows as the list scrolls. */
  @state() private renderLimit = PICKER_PAGE_SIZE;
  /** Model whose allowlist change is in flight. */
  @state() private pendingId: string | null = null;
  @state() private toast: { text: string; error: boolean } | null = null;
  /** Not-connected providers the user opened/closed by hand. */
  @state() private offlineToggled = new Map<string, boolean>();
  /** models.list `providers`: free-tier facts for group headers / connect rows. */
  @state() private providerInfo: ReadonlyMap<string, ProviderInfo> = new Map();
  /** "Model unavailable — choose another" notice for a model the provider rejected. */
  @state() private unavailableNotice: { name: string; suggestion?: string } | null = null;

  @query(".mp-search input") private searchInput?: HTMLInputElement;
  @query(".mp-list") private listEl?: HTMLElement;

  private filter = createModelFilterState();
  private loadedFor: GatewayBrowserClient | null = null;
  /** What's typed in the search box; applied to `filter.search` after a debounce. */
  private searchDraft = "";
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** Model counts per provider for the filter chips — connected providers first. */
  private providerCounts: Array<{ provider: string; count: number; offline: boolean }> = [];
  private usableTotal = 0;
  /** Usable models that are free / free tier / local (the Free chip's count). */
  private freeTotal = 0;
  /** No paid provider is connected → free options lead the list. */
  private freeFirst = false;

  private onDocClick = (e: MouseEvent) => {
    if (!this.open) return;
    if (!e.composedPath().includes(this)) this.close();
  };
  private onModelsRefresh = () => void this.loadModels();

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this.onDocClick, true);
    window.addEventListener("models:refresh", this.onModelsRefresh);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener("click", this.onDocClick, true);
    window.removeEventListener("models:refresh", this.onModelsRefresh);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }

  protected willUpdate(changed: PropertyValues): void {
    if ((changed.has("client") || changed.has("connected")) && this.client && this.connected) {
      if (this.loadedFor !== this.client || changed.has("connected")) {
        this.loadedFor = this.client;
        void this.loadModels();
      }
    }
    if (changed.has("models" as keyof this)) {
      const counts = new Map<string, { count: number; offline: boolean }>();
      let total = 0;
      let free = 0;
      for (const m of this.models) {
        if (m.unconfigured || !m.provider) continue;
        const offline = m.available === false;
        const c = counts.get(m.provider) ?? { count: 0, offline };
        c.count++;
        counts.set(m.provider, c);
        if (!offline) total++;
        if (!offline && isFreeModel(m)) free++;
      }
      this.usableTotal = total;
      this.freeTotal = free;
      this.freeFirst = !hasPaidProviderConnected(this.models);
      this.providerCounts = Array.from(counts.entries())
        .sort(([a, x], [b, y]) => Number(x.offline) - Number(y.offline) || a.localeCompare(b))
        .map(([provider, c]) => ({ provider, ...c }));
    }
  }

  private async loadModels() {
    if (!this.client || !this.connected) return;
    this.loading = true;
    this.loadError = null;
    try {
      const res = await this.client.request<{ models?: unknown; providers?: unknown }>("models.list", {});
      this.providerInfo = normalizeProviderInfo(res);
      this.models = normalizeModelsList(res);
    } catch (err) {
      this.loadError = String((err as Error)?.message ?? err);
    } finally {
      this.loading = false;
    }
  }

  private toggle() {
    if (this.open) {
      this.close();
      return;
    }
    this.filter = createModelFilterState();
    this.searchDraft = "";
    this.setup = null;
    this.unavailableNotice = null;
    this.open = true;
    // Start on the session's current model, and make sure it is rendered.
    const at = this.overridden && this.value ? this.currentIds().indexOf(this.value) : -1;
    this.activeIndex = Math.max(0, at);
    this.renderLimit = limitForIndex(this.activeIndex, PICKER_PAGE_SIZE);
    if (this.models.length === 0 && !this.loading) void this.loadModels();
    void this.updateComplete.then(() => {
      // Don't pop the soft keyboard over the sheet on phones.
      if (!this.mobile) this.searchInput?.focus();
      this.scrollActiveIntoView(true);
    });
  }

  private close() {
    this.open = false;
    this.setup = null;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
  }

  private emit(name: string, detail: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private async select(id: string) {
    if (id === DEFAULT_ID) {
      this.close();
      if (this.overridden) this.emit("model-select", { model: null });
      return;
    }
    if (this.pendingId) return;
    // The provider turned this model down as not found: don't let the session
    // land on it — say so and offer the nearest valid one.
    const picked = this.models.find((m) => m.id === id);
    if (picked?.unavailable) {
      const suggestion = this.models.find(
        (m) => m.id === picked.suggestion && !m.unavailable && m.available !== false,
      );
      this.unavailableNotice = { name: picked.name || id, suggestion: suggestion?.id };
      if (this.listEl) this.listEl.scrollTop = 0;
      return;
    }
    // The gateway rejects models outside the allowlist — add it before the
    // host patches the session, so a pick can never end in an error.
    if (needsAllowlistAdd(this.models.find((m) => m.id === id))) {
      if (!(await this.changeAllowlist(id, "add"))) return;
    }
    this.close();
    if (id === this.value && this.overridden) return;
    this.emit("model-select", { model: id });
  }

  // ── "Your models" (agents.defaults.models) ────────────────────────────

  private async changeAllowlist(id: string, action: "add" | "remove"): Promise<boolean> {
    if (!this.client || this.pendingId) return false;
    const name = this.labelFor(id).name || id;
    this.pendingId = id;
    try {
      await this.client.request(`models.allowlist.${action}`, { model: id });
      this.models = applyAllowlistChange(this.models, id, action);
      this.showToast(action === "add" ? `Added ${name} to your models` : `Removed ${name} from your models`);
      // Other pickers (and the gateway's view of the default) catch up.
      window.dispatchEvent(new CustomEvent("models:refresh"));
      return true;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err).replace(/^Error:\s*/, "");
      this.showToast(`Couldn't ${action === "add" ? "add" : "remove"} ${name}: ${msg}`, true);
      return false;
    } finally {
      this.pendingId = null;
    }
  }

  private async removeMine(id: string) {
    const inUse = this.overridden && id === this.value;
    if (!(await this.changeAllowlist(id, "remove"))) return;
    // A session can't stay on a model that is no longer allowed.
    if (inUse) this.emit("model-select", { model: null });
  }

  private showToast(text: string, error = false) {
    this.toast = { text, error };
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast = null), error ? TOAST_MS * 2 : TOAST_MS);
  }

  private setOnlyMine(on: boolean) {
    this.onlyMine = on;
    saveOnlyMine(globalThis.localStorage, on);
    this.onFilterChanged();
  }

  private pickThinking(level: string, binary: boolean) {
    this.emit("thinking-select", { level: resolveThinkLevelPatchValue(level, binary) });
  }

  private labelFor(ref: string | null): { provider: string; name: string } {
    const { provider, model } = splitModelRef(ref);
    const hit = this.models.find((m) => m.id === ref);
    return { provider: hit?.provider ?? provider, name: hit?.name ?? model ?? "" };
  }

  private sections(): PickerSections {
    return buildPickerSections(this.models, this.filter, {
      onlyMine: this.onlyMine,
      freeFirst: this.freeFirst,
      providerInfo: this.providerInfo,
    });
  }

  /** Selectable ids in render order: agent default first, then each model row. */
  private idsFor(rows: PickerRow[]): string[] {
    const ids = this.showDefaultRow() ? [DEFAULT_ID] : [];
    for (const r of rows) if (r.kind === "model") ids.push(r.model.id);
    return ids;
  }

  private currentIds(): string[] {
    return this.idsFor(flattenSections(this.sections()));
  }

  private showDefaultRow(): boolean {
    return Boolean(this.defaultModel || this.defaultLabel) && !this.filter.search.trim();
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      this.renderRoot.querySelector<HTMLButtonElement>(".mp-trigger")?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Enter") return;
    // Enter on a chip / toggle / row action is that control's own click.
    const origin = e.composedPath()[0] as HTMLElement | undefined;
    if (e.key === "Enter" && origin?.closest?.("button, label, .mp-setup")) return;
    this.commitSearch();
    const ids = this.currentIds();
    if (!ids.length) return;
    e.preventDefault();
    if (e.key === "Enter") {
      const id = ids[Math.min(this.activeIndex, ids.length - 1)];
      if (id) void this.select(id);
      return;
    }
    const delta = e.key === "ArrowDown" ? 1 : -1;
    this.activeIndex = (Math.min(this.activeIndex, ids.length - 1) + delta + ids.length) % ids.length;
    this.renderLimit = limitForIndex(this.activeIndex, this.renderLimit);
    void this.updateComplete.then(() => this.scrollActiveIntoView());
  }

  private scrollActiveIntoView(center = false) {
    const el =
      this.renderRoot.querySelector<HTMLElement>(center ? ".mp-opt--on" : ".mp-opt--active") ??
      this.renderRoot.querySelector<HTMLElement>(".mp-opt--active");
    const list = this.listEl;
    if (!el || !list) return;
    // Scroll the list only — scrollIntoView would also nudge the page shell.
    const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const zoom = list.offsetHeight ? list.getBoundingClientRect().height / list.offsetHeight : 1;
    const y = top / (zoom || 1) + list.scrollTop;
    // Keep clear of the sticky group header.
    const head = 30;
    if (center) list.scrollTop = Math.max(0, y - (list.clientHeight - el.offsetHeight) / 2);
    else if (y < list.scrollTop + head) list.scrollTop = Math.max(0, y - head);
    else if (y + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = y + el.offsetHeight - list.clientHeight;
  }

  private toggleFree() {
    const caps = this.filter.capabilities;
    if (caps.has("free")) caps.delete("free");
    else caps.add("free");
    this.onFilterChanged();
  }

  private freeTag(m: ModelOption) {
    if (!m.free) return nothing;
    return html`<span class="mp-tag mp-tag--free mp-free--${m.free}" title=${freeBadgeTitle(m)}>${FREE_KIND_LABELS[m.free]}</span>`;
  }

  private onFilterChanged() {
    this.unavailableNotice = null;
    this.activeIndex = 0;
    this.renderLimit = PICKER_PAGE_SIZE;
    this.filterTick++;
    if (this.listEl) this.listEl.scrollTop = 0;
  }

  private onSearchInput(value: string) {
    this.searchDraft = value;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.commitSearch(), SEARCH_DEBOUNCE_MS);
  }

  private commitSearch() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    if (this.filter.search === this.searchDraft) return;
    this.filter.search = this.searchDraft;
    this.onFilterChanged();
  }

  /** Render the next page once the list is scrolled near its end. */
  private onListScroll(e: Event) {
    const el = e.currentTarget as HTMLElement;
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 320) return;
    if (this.renderLimit < this.usableTotal) this.renderLimit += PICKER_PAGE_SIZE;
  }

  // ── provider setup (same flow as the grid panel's "Set up →") ─────────

  private async saveSetup() {
    const s = this.setup;
    if (!s || !this.client) return;
    const key = s.key.trim();
    if (!key) {
      this.setup = { ...s, error: "Enter an API key." };
      return;
    }
    this.setup = { ...s, saving: true, error: "" };
    try {
      await this.client.request("auth.profiles.upsert", {
        profileId: `${s.provider}:default`,
        provider: s.provider,
        type: "api_key",
        key,
      });
      // App-wide catalog reload (grid panels) — our listener reloads ours too.
      window.dispatchEvent(new CustomEvent("models:refresh"));
      this.setup = null;
    } catch (err) {
      this.setup = { ...s, saving: false, error: String((err as Error)?.message ?? err) };
    }
  }

  // ── render ────────────────────────────────────────────────────────────

  render() {
    const cur = this.labelFor(this.value);
    return html`
      <div class="mp">
        <button
          class="mp-trigger ${this.open ? "mp-trigger--open" : ""}"
          data-learn-id="model-picker-trigger"
          aria-haspopup="listbox"
          aria-expanded=${this.open ? "true" : "false"}
          title=${this.value ? `Model: ${this.value}` : "Select model"}
          @click=${() => this.toggle()}
        >
          ${cur.provider
            ? html`<span class="mp-badge" aria-hidden="true">${providerMonogram(cur.provider)}</span>
                <span class="mp-trig-provider">${cur.provider}</span><span class="mp-dot">·</span>`
            : html`<span class="mp-trig-icon">${cpuIcon}</span>`}
          <span class="mp-trig-model">${cur.name || this.defaultLabel || "Select model"}</span>
          ${!this.overridden && this.value ? html`<span class="mp-pill">default</span>` : nothing}
          <span class="mp-chev">${chevron}</span>
        </button>
        ${this.open ? this.renderMenu() : nothing}
        ${this.toast
          ? html`<div class="mp-toast ${this.toast.error ? "mp-toast--err" : ""}" role="status">
              ${this.toast.error ? nothing : html`<span class="mp-toast-icon">${checkIcon}</span>`}
              <span>${this.toast.text}</span>
            </div>`
          : nothing}
      </div>
    `;
  }

  private renderMenu() {
    void this.filterTick;
    const sections = this.sections();
    const allRows = flattenSections(sections);
    const ids = this.idsFor(allRows);
    const activeId = ids[Math.min(this.activeIndex, Math.max(0, ids.length - 1))];
    const { rows, hidden } = windowRows(allRows, this.renderLimit);
    const offline = sections.offline;
    const f = this.filter;
    const activeFilters = (f.provider ? 1 : 0) + f.capabilities.size + (f.tier ? 1 : 0);
    const filtered = Boolean(activeFilters || f.search.trim() || this.onlyMine);
    const hasMine = this.models.some((m) => m.pinned === true || m.allowed === true);

    const menu = html`
      <div
        class="mp-menu ${this.mobile ? "mp-menu--sheet" : ""}"
        role="dialog"
        aria-label="Choose model"
        @keydown=${(e: KeyboardEvent) => this.onKey(e)}
      >
        ${this.mobile ? html`<div class="mp-grab" aria-hidden="true"></div><div class="mp-sheet-title">Model</div>` : nothing}
        <div class="mp-search">
          <span class="mp-search-icon">${searchIcon}</span>
          <input
            type="text"
            data-learn-id="model-picker-search"
            placeholder="Search ${this.usableTotal || ""} models"
            aria-label="Search models"
            .value=${this.searchDraft}
            @input=${(e: Event) => this.onSearchInput((e.target as HTMLInputElement).value)}
          />
          <button
            class="mp-filter-btn ${this.showFilters || activeFilters ? "mp-filter-btn--on" : ""}"
            title="Filters"
            aria-expanded=${this.showFilters ? "true" : "false"}
            @click=${() => (this.showFilters = !this.showFilters)}
          >
            Filters${activeFilters ? html` <span class="mp-count">${activeFilters}</span>` : nothing}
          </button>
        </div>
        ${this.showFilters
          ? html`<div class="mp-filters">
              ${this.providerCounts.length > 1
                ? html`<div class="mp-filter-row">
                    <span class="mp-filter-label">Provider</span>
                    <div class="mp-chips">
                      <button
                        class="mp-chip ${f.provider === null ? "mp-chip--on" : ""}"
                        @click=${() => {
                          f.provider = null;
                          this.onFilterChanged();
                        }}
                      >All</button>
                      ${this.providerCounts.map(
                        ({ provider: p, count, offline }) => html`<button
                          class="mp-chip ${f.provider === p ? "mp-chip--on" : ""} ${offline ? "mp-chip--off" : ""}"
                          title=${offline ? `${p} — not connected` : p}
                          @click=${() => {
                            f.provider = f.provider === p ? null : p;
                            this.onFilterChanged();
                          }}
                        >${p} <span class="mp-chip-n">${count}</span></button>`,
                      )}
                    </div>
                  </div>`
                : nothing}
              <div class="mp-filter-row">
                <span class="mp-filter-label">Capability</span>
                <div class="mp-chips">
                  ${CAPS.map(
                    ({ cap, label }) => html`<button
                      class="mp-chip ${f.capabilities.has(cap) ? "mp-chip--on" : ""}"
                      @click=${() => {
                        if (f.capabilities.has(cap)) f.capabilities.delete(cap);
                        else f.capabilities.add(cap);
                        this.onFilterChanged();
                      }}
                    >${label}</button>`,
                  )}
                </div>
              </div>
              <div class="mp-filter-row">
                <span class="mp-filter-label">Context</span>
                <div class="mp-chips">
                  ${TIERS.map(
                    ({ tier, label }) => html`<button
                      class="mp-chip ${f.tier === tier ? "mp-chip--on" : ""}"
                      title="Context window size"
                      @click=${() => {
                        f.tier = f.tier === tier ? null : tier;
                        this.onFilterChanged();
                      }}
                    >${label}</button>`,
                  )}
                </div>
              </div>
            </div>`
          : nothing}
        <div class="mp-bar">
          <span class="mp-result" data-testid="mp-result">
            ${filtered ? `${sections.total} of ${this.usableTotal} models` : `${this.usableTotal} models`}
          </span>
          <button
            class="mp-chip mp-chip--free ${f.capabilities.has("free") ? "mp-chip--on" : ""}"
            data-testid="mp-free-chip"
            aria-pressed=${f.capabilities.has("free") ? "true" : "false"}
            title="Only models you can use at no cost: free, free tier (rate-limited) and local"
            @click=${() => this.toggleFree()}
          >Free${this.freeTotal ? html` <span class="mp-chip-n">${this.freeTotal}</span>` : nothing}</button>
          <span class="mp-bar-gap"></span>
          ${hasMine || this.onlyMine
            ? html`<label class="mp-switch" title="Hide everything that isn't in your models">
                <input
                  type="checkbox"
                  .checked=${this.onlyMine}
                  @change=${(e: Event) => this.setOnlyMine((e.target as HTMLInputElement).checked)}
                />
                <span class="mp-switch-track" aria-hidden="true"></span>
                Only my models
              </label>`
            : nothing}
        </div>
        <div class="mp-list" role="listbox" @scroll=${(e: Event) => this.onListScroll(e)}>
          ${this.unavailableNotice
            ? html`<div class="mp-notice" role="alert" data-testid="mp-unavailable">
                <span class="mp-notice-text">
                  <strong>Model unavailable.</strong>
                  ${this.unavailableNotice.name} was rejected by its provider as not found. Choose another model${this.unavailableNotice.suggestion ? " — closest match:" : "."}
                </span>
                ${this.unavailableNotice.suggestion
                  ? html`<button
                      class="mp-btn mp-btn--primary"
                      @click=${() => {
                        const next = this.unavailableNotice?.suggestion;
                        this.unavailableNotice = null;
                        if (next) void this.select(next);
                      }}
                    >Use ${this.labelFor(this.unavailableNotice.suggestion).name}</button>`
                  : nothing}
              </div>`
            : nothing}
          ${!filtered && this.freeFirst && this.freeTotal
            ? html`<div class="mp-hint" data-testid="mp-free-first">Free options are listed first — no paid provider is connected.</div>`
            : nothing}
          ${this.showDefaultRow() ? this.renderDefaultRow(activeId) : nothing}
          ${this.loading && this.models.length === 0
            ? html`<div class="mp-empty"><span class="mp-spin"></span>Loading models…</div>`
            : this.loadError && this.models.length === 0
              ? html`<div class="mp-empty">Couldn't load models. <button class="mp-link" @click=${() => this.loadModels()}>Retry</button></div>`
              : sections.total === 0 && offline.length === 0
                ? html`<div class="mp-empty">
                    ${this.onlyMine ? "None of your models match." : "No models match."}
                    ${this.onlyMine
                      ? html`<button class="mp-link" @click=${() => this.setOnlyMine(false)}>Show all models</button>`
                      : nothing}
                  </div>`
                : nothing}
          ${rows.map((row) =>
            row.kind === "head"
              ? html`<div class="mp-group-head ${row.mine ? "mp-group-head--mine" : ""}">
                  ${row.mine ? nothing : html`<ib-provider-logo provider=${row.label} letters=${providerMonogram(row.label)} size="20"></ib-provider-logo>`}
                  <span class="mp-group-name">${row.label}</span>
                  ${row.mine ? nothing : this.providerFreeTag(row.label)}
                  <span class="mp-group-count">${row.count}</span>
                </div>`
              : this.renderOption(row.model, row.mine, activeId, ids),
          )}
          ${hidden ? html`<div class="mp-more">${hidden} more — keep scrolling</div>` : nothing}
          ${offline.length
            ? html`<div class="mp-offline-head">
                  <span>Not connected</span>
                  <span class="mp-group-count">${offline.reduce((n, o) => n + o.count, 0)} models</span>
                </div>
                ${offline.map((o) =>
                  this.renderOffline(
                    o.provider,
                    o.count,
                    offlineExpanded(o, { filtered, toggled: this.offlineToggled }) ? o.models : null,
                  ),
                )}`
            : nothing}
        </div>
        <ib-gpu-runtimes compact></ib-gpu-runtimes>
        ${this.renderThinking()}
      </div>
    `;
    return this.mobile
      ? html`<div class="mp-backdrop" @click=${() => this.close()}></div>${menu}`
      : menu;
  }

  /** "Free tier" / "Free models" / "Local" chip for a provider header. */
  private providerFreeTag(provider: string) {
    const free = this.providerInfo.get(provider)?.free;
    if (!free) return nothing;
    const title = `${free.note} Source: ${free.source}${free.verified ? ` (verified ${free.verified})` : ""}`;
    return html`<span class="mp-tag mp-tag--free mp-free--${free.kind}" title=${title}>${free.label}</span>`;
  }

  private renderDefaultRow(activeId: string | undefined) {
    const d = this.labelFor(this.defaultModel);
    const on = !this.overridden;
    return html`
      <div
        class="mp-opt mp-opt--default ${on ? "mp-opt--on" : ""} ${activeId === DEFAULT_ID ? "mp-opt--active" : ""}"
        role="option"
        aria-selected=${on ? "true" : "false"}
        @click=${() => void this.select(DEFAULT_ID)}
        @mouseenter=${() => (this.activeIndex = 0)}
      >
        <span class="mp-opt-main">
          <span class="mp-opt-name">Agent default</span>
          <span class="mp-opt-id">${this.defaultModel ? html`${d.provider ? `${d.provider} · ` : ""}${d.name}` : this.defaultLabel}</span>
        </span>
        ${on ? html`<span class="mp-check">${checkIcon}</span>` : nothing}
      </div>
    `;
  }

  private renderOption(m: ModelOption, mine: boolean, activeId: string | undefined, ids: string[]) {
    const on = this.overridden && m.id === this.value;
    const ctx = formatCtx(m.contextWindow);
    const pending = this.pendingId === m.id;
    const { model } = splitModelRef(m.id);
    // "Your models" spans providers, so its rows say which one they belong to.
    const sub = mine ? `${m.provider ?? ""}${m.name !== model ? ` · ${model}` : ""}` : m.name !== model ? model : "";
    return html`
      <div
        class="mp-opt ${on ? "mp-opt--on" : ""} ${activeId === m.id ? "mp-opt--active" : ""} ${m.unavailable ? "mp-opt--gone" : ""}"
        role="option"
        aria-selected=${on ? "true" : "false"}
        data-model-id=${m.id}
        title=${m.unavailable ? `${m.id} — the provider reported this model as not found` : m.id}
        @click=${() => void this.select(m.id)}
        @mouseenter=${() => (this.activeIndex = Math.max(0, ids.indexOf(m.id)))}
      >
        <span class="mp-opt-main">
          <span class="mp-opt-name">${m.name}</span>
          ${sub ? html`<span class="mp-opt-id">${sub}</span>` : nothing}
        </span>
        <span class="mp-tags">
          ${m.unavailable ? html`<span class="mp-tag mp-tag--gone">Unavailable</span>` : nothing}
          ${this.freeTag(m)}
          ${m.reasoning ? html`<span class="mp-tag">Reasoning</span>` : nothing}
          ${modelHasCapability(m, "vision") ? html`<span class="mp-tag">Vision</span>` : nothing}
          ${ctx ? html`<span class="mp-tag mp-tag--dim">${ctx}</span>` : nothing}
        </span>
        ${pending
          ? html`<span class="mp-spin" aria-label="Saving"></span>`
          : on
            ? html`<span class="mp-check">${checkIcon}</span>`
            : nothing}
        ${mine
          ? m.pinned
            ? html`<button
                class="mp-pin mp-pin--remove"
                title="Remove from your models"
                aria-label="Remove ${m.name} from your models"
                ?disabled=${Boolean(this.pendingId)}
                @click=${(e: Event) => {
                  e.stopPropagation();
                  void this.removeMine(m.id);
                }}
              >${removeIcon}</button>`
            : html`<span class="mp-pin mp-pin--ghost" aria-hidden="true"></span>`
          : html`<button
              class="mp-pin"
              title="Add to your models"
              aria-label="Add ${m.name} to your models"
              ?disabled=${Boolean(this.pendingId)}
              @click=${(e: Event) => {
                e.stopPropagation();
                void this.changeAllowlist(m.id, "add");
              }}
            >${plusIcon}</button>`}
      </div>
    `;
  }

  private toggleOffline(provider: string, open: boolean) {
    const next = new Map(this.offlineToggled);
    next.set(provider, open);
    this.offlineToggled = next;
  }

  /** `models` = the provider's matching models when its group is open, else null. */
  private renderOffline(provider: string, count: number, models: ModelOption[] | null) {
    const s = this.setup?.provider === provider ? this.setup : null;
    const free = this.providerInfo.get(provider)?.free;
    const freeHint = !free
      ? ""
      : free.kind === "local"
        ? "Runs locally, no API cost — set up"
        : free.kind === "free-tier"
          ? "Free tier available — connect"
          : "Free models available — connect";
    const freeTitle = free
      ? `${free.note} Source: ${free.source}${free.verified ? ` (verified ${free.verified})` : ""}`
      : "";
    return html`
      <div class="mp-offline ${free ? "mp-offline--free" : ""}" data-provider=${provider}>
        <div
          class="mp-opt mp-opt--disabled ${count ? "mp-opt--expandable" : ""}"
          title="${provider} has no API key or login configured"
          role=${count ? "button" : "presentation"}
          aria-expanded=${count ? (models ? "true" : "false") : nothing}
          @click=${() => count && this.toggleOffline(provider, !models)}
        >
          <span class="mp-badge mp-badge--off">${providerMonogram(provider)}</span>
          <span class="mp-opt-main">
            <span class="mp-opt-name">
              ${provider}
              ${free ? html`<span class="mp-tag mp-tag--free mp-free--${free.kind}" title=${freeTitle}>${free.label}</span>` : nothing}
            </span>
            ${free
              ? html`<span class="mp-opt-hint mp-opt-hint--free" title=${freeTitle}>
                  ${freeHint}${count ? ` · ${count} model${count === 1 ? "" : "s"}` : ""}
                </span>`
              : html`<span class="mp-opt-hint">
                  <span class="mp-lock">${lockIcon}</span>
                  ${count ? `${count} model${count === 1 ? "" : "s"} · ` : ""}needs an API key
                </span>`}
          </span>
          ${count ? html`<span class="mp-chev ${models ? "mp-chev--open" : ""}">${chevron}</span>` : nothing}
          ${s
            ? nothing
            : html`<button
                class="mp-link"
                @click=${(e: Event) => {
                  e.stopPropagation();
                  this.setup = { provider, key: "", saving: false, error: "" };
                  void this.updateComplete.then(() =>
                    this.renderRoot.querySelector<HTMLInputElement>(".mp-setup input")?.focus(),
                  );
                }}
              >Connect</button>`}
        </div>
        ${s
          ? html`<div class="mp-setup" @keydown=${(e: KeyboardEvent) => e.stopPropagation()}>
              <input
                type="password"
                autocomplete="off"
                placeholder="Paste your ${provider} API key"
                .value=${s.key}
                @input=${(e: Event) => (this.setup = { ...s, key: (e.target as HTMLInputElement).value })}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === "Enter") void this.saveSetup();
                  if (e.key === "Escape") this.setup = null;
                }}
              />
              <button class="mp-btn" ?disabled=${s.saving} @click=${() => (this.setup = null)}>Cancel</button>
              <button class="mp-btn mp-btn--primary" ?disabled=${s.saving} @click=${() => this.saveSetup()}>
                ${s.saving ? "Saving…" : "Save"}
              </button>
              ${free?.keyUrl
                ? html`<a class="mp-setup-link" href=${free.keyUrl} target="_blank" rel="noopener noreferrer">Get a free ${provider} key</a>`
                : nothing}
              ${s.error ? html`<div class="mp-setup-err">${s.error}</div>` : nothing}
            </div>`
          : nothing}
        ${models
          ? models.map((m) => {
              const ctx = formatCtx(m.contextWindow);
              return html`<div class="mp-opt mp-opt--locked" aria-disabled="true" title="${m.id} — connect ${provider} to use it">
                <span class="mp-opt-main"><span class="mp-opt-name">${m.name}</span></span>
                <span class="mp-tags">
                  ${this.freeTag(m)}
                  ${m.reasoning ? html`<span class="mp-tag">Reasoning</span>` : nothing}
                  ${modelHasCapability(m, "vision") ? html`<span class="mp-tag">Vision</span>` : nothing}
                  ${ctx ? html`<span class="mp-tag mp-tag--dim">${ctx}</span>` : nothing}
                </span>
              </div>`;
            })
          : nothing}
      </div>
    `;
  }

  private renderThinking() {
    const provider = splitModelRef(this.value).provider;
    const binary = isBinaryThinkingProvider(provider);
    const current = resolveThinkLevelDisplay(this.thinkingLevel ?? "", binary);
    const levels = resolveThinkLevelOptions(provider);
    return html`
      <div class="mp-think">
        <span class="mp-think-label">Thinking</span>
        <div class="mp-seg" role="radiogroup" aria-label="Thinking level">
          ${levels.map(
            (lvl) => html`<button
              class="mp-seg-btn ${current === lvl ? "mp-seg-btn--on" : ""}"
              role="radio"
              aria-checked=${current === lvl ? "true" : "false"}
              title=${lvl ? `Thinking: ${lvl}` : "Inherit the agent's thinking level"}
              @click=${() => this.pickThinking(lvl, binary)}
            >${lvl || "auto"}</button>`,
          )}
        </div>
      </div>
    `;
  }

  static styles = css`
    :host {
      display: inline-block;
      min-width: 0;
      --mp-surface: var(--g-surface-strong, var(--bg-elevated));
      --mp-hover: var(--g-surface-hover, var(--bg-hover));
      --mp-border: var(--g-border, var(--border));
      --mp-border-strong: var(--g-border-strong, var(--border-strong));
      --mp-accent: var(--g-primary, var(--accent));
      --mp-accent-soft: var(--g-primary-muted, var(--accent-subtle));
      --mp-radius: var(--g-radius, 14px);
      --mp-radius-sm: var(--g-radius-sm, 10px);
    }
    *, *::before, *::after { box-sizing: border-box; }
    button { font: inherit; color: inherit; }
    svg { width: 14px; height: 14px; flex: none; }
    .mp { position: relative; min-width: 0; }

    .mp-trigger {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      min-width: 0;
      padding: 6px 10px;
      border: 1px solid transparent;
      border-radius: var(--mp-radius-sm);
      background: transparent;
      color: var(--muted);
      font-size: 13px;
      cursor: pointer;
    }
    .mp-trigger:hover, .mp-trigger--open { background: var(--mp-hover); color: var(--text); }
    .mp-trigger:focus-visible { outline: 2px solid var(--mp-accent); outline-offset: 1px; }
    .mp-trig-icon { display: inline-flex; }
    .mp-trig-provider { white-space: nowrap; }
    .mp-dot { color: var(--muted); }
    .mp-trig-model {
      min-width: 0;
      max-width: 240px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      color: var(--text-strong, var(--text));
      font-weight: 500;
    }
    .mp-pill {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid var(--mp-border);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .mp-chev { display: inline-flex; color: var(--muted); }

    .mp-badge {
      display: inline-grid;
      place-items: center;
      width: 20px;
      height: 20px;
      flex: none;
      border-radius: 6px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.02em;
      color: var(--mp-accent);
      background: var(--mp-accent-soft);
      border: 1px solid color-mix(in srgb, var(--mp-accent) 35%, transparent);
    }
    .mp-badge--off { color: var(--muted); background: transparent; border-color: var(--mp-border); }

    .mp-menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 45;
      display: flex;
      flex-direction: column;
      width: min(420px, calc(100vw - 24px));
      max-height: min(calc(76vh / var(--wc-zoom, 1)), 720px);
      border-radius: var(--mp-radius);
      border: 1px solid var(--mp-border-strong);
      background: var(--popover, var(--mp-surface));
      box-shadow: var(--g-shadow, var(--shadow-xl));
      overflow: hidden;
    }
    .mp-menu--sheet {
      position: fixed;
      top: auto;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 61;
      width: 100%;
      /* Wide screens (sheet mode inside dialogs): keep rows scannable. */
      max-width: 720px;
      margin: 0 auto;
      max-height: 82vh;
      border-radius: var(--mp-radius) var(--mp-radius) 0 0;
      border-bottom: 0;
      padding-bottom: env(safe-area-inset-bottom, 0px);
    }
    .mp-backdrop {
      position: fixed;
      inset: 0;
      z-index: 60;
      background: color-mix(in srgb, var(--bg, #000) 55%, transparent);
    }
    .mp-grab {
      width: 40px;
      height: 4px;
      margin: 8px auto 2px;
      border-radius: 999px;
      background: var(--mp-border-strong);
    }
    .mp-sheet-title { padding: 4px 16px 0; font-weight: 600; color: var(--text-strong, var(--text)); }

    .mp-search {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 8px;
      padding: 0 6px 0 10px;
      border-radius: var(--mp-radius-sm);
      border: 1px solid var(--mp-border);
      background: var(--input, transparent);
    }
    .mp-search:focus-within { border-color: var(--mp-accent); }
    .mp-search-icon { display: inline-flex; color: var(--muted); }
    .mp-search input {
      flex: 1;
      min-width: 0;
      padding: 9px 0;
      border: 0;
      background: transparent;
      color: var(--text);
      font: inherit;
      font-size: 14px;
      outline: none;
    }
    .mp-filter-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border: 1px solid transparent;
      border-radius: 8px;
      background: transparent;
      color: var(--muted);
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }
    .mp-filter-btn:hover { background: var(--mp-hover); color: var(--text); }
    .mp-filter-btn--on { color: var(--mp-accent); border-color: color-mix(in srgb, var(--mp-accent) 35%, transparent); }
    .mp-count {
      display: inline-grid;
      place-items: center;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      border-radius: 999px;
      background: var(--mp-accent);
      color: var(--accent-foreground, var(--bg));
      font-size: 10px;
      font-weight: 700;
    }

    .mp-filters { display: flex; flex-direction: column; gap: 6px; padding: 0 8px 8px; }
    .mp-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .mp-chip {
      padding: 3px 9px;
      border-radius: 999px;
      border: 1px solid var(--mp-border);
      background: transparent;
      color: var(--muted);
      font-size: 11px;
      cursor: pointer;
      white-space: nowrap;
    }
    .mp-chip:hover { background: var(--mp-hover); color: var(--text); }
    .mp-chip--on { background: var(--mp-accent-soft); border-color: var(--mp-accent); color: var(--mp-accent); }

    .mp-list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overscroll-behavior: contain;
      padding: 0 6px 6px;
      border-top: 1px solid color-mix(in srgb, var(--mp-border) 60%, transparent);
    }
    .mp-group-head {
      position: sticky;
      top: 0;
      z-index: 1;
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      background: var(--popover, var(--mp-surface));
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .mp-group-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mp-group-count { font-weight: 500; letter-spacing: 0; text-transform: none; }
    .mp-group-head--mine { color: var(--mp-accent); }
    .mp-more { padding: 10px; text-align: center; font-size: 11px; color: var(--muted); }

    .mp-filter-row { display: flex; align-items: flex-start; gap: 8px; }
    .mp-filter-label {
      flex: none;
      width: 76px;
      padding-top: 4px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .mp-filter-row .mp-chips { flex: 1; min-width: 0; max-height: 84px; overflow-y: auto; }
    .mp-chip--off:not(.mp-chip--on) { border-style: dashed; opacity: 0.7; }
    .mp-chip-n { opacity: 0.65; font-family: var(--mono); font-size: 10px; }

    .mp-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 12px 8px;
      font-size: 11px;
      color: var(--muted);
    }
    .mp-result { white-space: nowrap; }
    .mp-switch {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    .mp-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
    .mp-switch-track {
      position: relative;
      width: 26px;
      height: 15px;
      border-radius: 999px;
      border: 1px solid var(--mp-border-strong);
      background: transparent;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .mp-switch-track::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--muted);
      transition: transform 120ms ease, background 120ms ease;
    }
    .mp-switch input:checked + .mp-switch-track { background: var(--mp-accent-soft); border-color: var(--mp-accent); }
    .mp-switch input:checked + .mp-switch-track::after { transform: translateX(11px); background: var(--mp-accent); }
    .mp-switch input:focus-visible + .mp-switch-track { outline: 2px solid var(--mp-accent); outline-offset: 2px; }
    .mp-switch:hover { color: var(--text); }

    .mp-pin {
      display: inline-grid;
      place-items: center;
      width: 24px;
      height: 24px;
      flex: none;
      padding: 0;
      border: 1px solid transparent;
      border-radius: 7px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      opacity: 0.55;
    }
    .mp-pin svg { width: 13px; height: 13px; }
    .mp-opt:hover .mp-pin, .mp-opt--active .mp-pin, .mp-pin:focus-visible { opacity: 1; }
    .mp-pin:hover { border-color: var(--mp-border-strong); color: var(--mp-accent); background: var(--mp-hover); }
    .mp-pin--remove:hover { color: var(--danger, #e5484d); }
    .mp-pin[disabled] { cursor: default; opacity: 0.3; }
    .mp-pin--ghost { visibility: hidden; }
    .mp-tag--free {
      color: var(--mp-accent);
      border-color: color-mix(in srgb, var(--mp-accent) 40%, transparent);
      font-weight: 600;
      letter-spacing: 0;
      text-transform: none;
    }
    /* Free = filled gold; Free tier = outlined gold; Local = dashed outline. */
    .mp-free--free { background: var(--mp-accent-soft); }
    .mp-free--free-tier { background: transparent; }
    .mp-free--local { background: transparent; border-style: dashed; }
    .mp-tag--gone { color: var(--danger, #e5484d); border-color: color-mix(in srgb, var(--danger, #e5484d) 45%, transparent); }
    .mp-opt--gone .mp-opt-name { text-decoration: line-through; opacity: 0.6; }
    .mp-chip--free { flex: none; border-color: color-mix(in srgb, var(--mp-accent) 45%, transparent); color: var(--mp-accent); font-weight: 600; }
    .mp-bar-gap { flex: 1; }
    .mp-hint { padding: 6px 10px 2px; font-size: 11px; color: var(--muted); }
    .mp-notice {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin: 8px 2px 4px;
      padding: 8px 10px;
      border: 1px solid color-mix(in srgb, var(--danger, #e5484d) 45%, transparent);
      border-radius: var(--mp-radius-sm);
      background: color-mix(in srgb, var(--danger, #e5484d) 10%, transparent);
      font-size: 12px;
      color: var(--text);
    }
    .mp-notice-text { flex: 1; min-width: 180px; }
    .mp-opt-hint--free { color: var(--mp-accent); }
    .mp-opt-name .mp-tag { margin-left: 6px; vertical-align: 1px; }
    .mp-setup-link { flex-basis: 100%; font-size: 11px; color: var(--mp-accent); }

    .mp-toast {
      position: fixed;
      left: 50%;
      bottom: 28px;
      z-index: 80;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: min(420px, calc(100vw - 32px));
      padding: 8px 14px;
      transform: translateX(-50%);
      border-radius: 999px;
      border: 1px solid var(--mp-border-strong);
      background: var(--popover, var(--mp-surface));
      box-shadow: var(--g-shadow, var(--shadow-xl));
      color: var(--text);
      font-size: 12px;
      pointer-events: none;
      animation: mp-toast-in 160ms ease-out;
    }
    .mp-toast-icon { display: inline-flex; color: var(--mp-accent); }
    .mp-toast--err { border-color: var(--danger, #e5484d); border-radius: var(--mp-radius-sm); }
    @keyframes mp-toast-in { from { opacity: 0; transform: translate(-50%, 6px); } }

    /* Compact: small trigger; the menu fills the host's positioned ancestor. */
    :host([compact]) .mp { position: static; }
    :host([compact]) .mp-trigger {
      padding: 4px 6px 4px 5px;
      gap: 5px;
      font-size: 12px;
      border-color: var(--mp-border);
    }
    :host([compact]) .mp-trig-provider,
    :host([compact]) .mp-dot,
    :host([compact]) .mp-pill { display: none; }
    :host([compact]) .mp-trig-model { max-width: 112px; }
    :host([compact]) .mp-menu:not(.mp-menu--sheet) {
      left: 8px;
      right: 8px;
      width: auto;
      top: calc(100% + 4px);
    }
    :host([align="end"]) .mp { position: relative; }
    :host([align="end"]) .mp-menu:not(.mp-menu--sheet) {
      left: auto;
      right: 0;
      width: min(420px, calc(100vw - 24px));
      top: calc(100% + 6px);
    }

    .mp-opt {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      color: var(--text);
      min-height: 40px;
      padding: 7px 10px;
      border: 0;
      border-radius: var(--mp-radius-sm);
      background: transparent;
      text-align: left;
      font-size: 13px;
      cursor: pointer;
    }
    .mp-opt--active { background: var(--mp-hover); }
    .mp-opt--on { background: var(--mp-accent-soft); }
    .mp-opt--on .mp-opt-name { color: var(--mp-accent); }
    .mp-opt--default { margin-top: 6px; }
    .mp-opt--disabled { cursor: default; color: var(--muted); }
    .mp-opt-main { display: flex; flex-direction: column; flex: 1; min-width: 0; }
    .mp-opt-name {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      color: var(--text-strong, var(--text));
    }
    .mp-opt--disabled .mp-opt-name { color: var(--muted); }
    .mp-opt-id {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-size: 11px;
      color: var(--muted);
      font-family: var(--mono);
    }
    .mp-tags { display: inline-flex; gap: 4px; flex: none; }
    .mp-tag {
      padding: 1px 6px;
      border-radius: 6px;
      border: 1px solid var(--mp-border);
      font-size: 10px;
      color: var(--muted);
      white-space: nowrap;
    }
    .mp-tag--dim { font-family: var(--mono); }
    .mp-check { display: inline-flex; color: var(--mp-accent); }
    .mp-lock { display: inline-flex; color: var(--muted); }
    .mp-lock svg { width: 11px; height: 11px; }
    .mp-opt-hint { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--muted); }
    .mp-opt--expandable { cursor: pointer; }
    .mp-opt--expandable:hover { background: var(--mp-hover); }
    .mp-chev--open svg { transform: rotate(180deg); }
    .mp-opt--locked { cursor: default; min-height: 32px; padding: 4px 10px 4px 38px; opacity: 0.6; }
    .mp-offline-head {
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--popover, var(--mp-surface));
      display: flex;
      justify-content: space-between;
      margin-top: 10px;
      padding: 8px 8px 4px;
      border-top: 1px solid color-mix(in srgb, var(--mp-border) 60%, transparent);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .mp-link {
      border: 0;
      background: transparent;
      color: var(--mp-accent);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      padding: 4px 6px;
      border-radius: 6px;
    }
    .mp-link:hover { background: var(--mp-accent-soft); }

    .mp-setup {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 4px 10px 10px 40px;
    }
    .mp-setup input {
      flex: 1 1 180px;
      min-width: 0;
      padding: 7px 10px;
      border-radius: 8px;
      border: 1px solid var(--mp-border);
      background: var(--input, transparent);
      color: var(--text);
      font: inherit;
      font-size: 13px;
      outline: none;
    }
    .mp-setup input:focus { border-color: var(--mp-accent); }
    .mp-setup-err { flex-basis: 100%; font-size: 12px; color: var(--danger); }
    .mp-btn {
      padding: 6px 12px;
      border-radius: 8px;
      border: 1px solid var(--mp-border);
      background: transparent;
      font-size: 12px;
      cursor: pointer;
    }
    .mp-btn:hover { background: var(--mp-hover); }
    .mp-btn--primary { border-color: var(--mp-accent); background: var(--mp-accent-soft); color: var(--mp-accent); font-weight: 600; }
    .mp-btn[disabled] { opacity: 0.6; cursor: default; }

    .mp-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 22px 12px;
      font-size: 13px;
      color: var(--muted);
    }
    .mp-spin {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 2px solid var(--mp-border);
      border-top-color: var(--mp-accent);
      animation: mp-spin 0.8s linear infinite;
    }
    @keyframes mp-spin { to { transform: rotate(360deg); } }

    .mp-think {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-top: 1px solid color-mix(in srgb, var(--mp-border) 60%, transparent);
    }
    .mp-think-label { font-size: 12px; color: var(--muted); flex: none; }
    .mp-seg {
      display: flex;
      flex: 1;
      min-width: 0;
      overflow-x: auto;
      padding: 2px;
      gap: 2px;
      border-radius: 9px;
      border: 1px solid var(--mp-border);
      scrollbar-width: none;
    }
    .mp-seg-btn {
      flex: 1 0 auto;
      padding: 4px 8px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: var(--muted);
      font-size: 11px;
      cursor: pointer;
      text-transform: capitalize;
    }
    .mp-seg-btn:hover { color: var(--text); }
    .mp-seg-btn--on { background: var(--mp-accent-soft); color: var(--mp-accent); font-weight: 600; }

    @media (max-width: 520px) {
      .mp-trig-provider, .mp-dot, .mp-pill { display: none; }
      .mp-trig-model { max-width: 34vw; }
      .mp-tags .mp-tag:not(.mp-tag--dim):not(.mp-tag--free):not(.mp-tag--gone) { display: none; }
      .mp-opt { min-height: 44px; }
      .mp-pin { width: 32px; height: 32px; opacity: 0.8; }
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "webchat-model-picker": WebchatModelPicker;
  }
}
